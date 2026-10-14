/** @fileoverview Bounded opt-in supervision; idle alone never authorizes continuation. */
import { createHash } from 'node:crypto';
import {
  initialTaskState,
  TaskUpdateSchema,
  TaskProgressSchema,
  type TaskState,
  type TaskUpdate,
  type TaskProgress,
} from './schema.js';
import { commandHash, type CommandSuccessEvidence } from './evidence.js';
import { CONTINUATION_PROMPT, type RecoveryObservation } from '../recovery/types.js';
export interface TaskObservation {
  observation: RecoveryObservation;
  commands: Map<string, CommandSuccessEvidence>;
  marker?: { key: string; progress: unknown; at: number; submissionKey?: string };
}
export interface TaskDependencies {
  resetReservation?(): Promise<void>;
  observe(): Promise<TaskObservation>;
  recover?(observation: RecoveryObservation, isCurrent: () => boolean): Promise<'sent' | 'not-sent' | 'unknown'>;
  act(
    key: string,
    conversationId: string,
    prompt: string,
    isCurrent: () => boolean
  ): Promise<'sent' | 'not-sent' | 'unknown'>;
  persist(state: TaskState): Promise<void>;
  changed(state: TaskState): void;
  now?: () => number;
}
export class TaskValidationError extends Error {}
function acceptanceCriteriaComplete(state: TaskState): boolean {
  return state.criteria.length > 0 && state.criteria.every((criterion) => criterion.verified);
}
export class TaskController {
  private state: TaskState;
  private lastPersisted: TaskState;
  private queue: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private revision = 0;
  private lastUserInputRevision = 0;
  private userInputSaveQueued = false;
  private stopped = false;
  constructor(
    private readonly deps: TaskDependencies,
    restored?: TaskState
  ) {
    this.state = structuredClone(restored ?? initialTaskState());
    if (acceptanceCriteriaComplete(this.state)) this.state.outcome = 'completed';
    if (this.state.config.enabled && this.state.inFlight) {
      this.state.phase = 'paused';
      this.state.reason = 'restart-in-flight';
    } else if (this.state.outcome === 'completed') {
      this.state.phase = 'completed';
      this.state.reason = 'completed';
    } else if (this.state.config.enabled) {
      this.state.phase = 'paused';
      this.state.reason = 'restart-requires-resume';
    }
    this.lastPersisted = structuredClone(this.state);
  }
  getStatus(): TaskState {
    return structuredClone(this.state);
  }
  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    this.queue = result.catch(() => {});
    return result;
  }
  private async save(reason: string): Promise<TaskState> {
    this.state.reason = reason;
    this.state.history.push({ at: this.now(), reason });
    this.state.history = this.state.history.slice(-100);
    try {
      const snapshot = this.getStatus();
      await this.deps.persist(snapshot);
      this.lastPersisted = snapshot;
    } catch {
      this.state = structuredClone(this.lastPersisted);
      this.state.config.enabled = false;
      this.state.phase = 'blocked';
      this.state.reason = 'persistence-failed';
      this.revision++;
      this.deps.changed(this.getStatus());
      throw new Error('Task state could not be saved');
    }
    this.deps.changed(this.getStatus());
    return this.getStatus();
  }
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.stopped && this.state.config.enabled && this.state.phase === 'watching') {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.refresh()
          .catch(() => {})
          .finally(() => this.arm());
      }, 5000);
      this.timer.unref?.();
    }
  }
  private runtimeBudgetExpired(): boolean {
    return this.state.startedAt !== undefined && this.now() - this.state.startedAt >= this.state.config.maxRuntimeMs;
  }
  private commandEvidenceIsCurrent(evidence: CommandSuccessEvidence | undefined): evidence is CommandSuccessEvidence {
    return (
      !!evidence &&
      Number.isFinite(evidence.startedAt) &&
      Number.isFinite(evidence.completedAt) &&
      evidence.startedAt >= (this.state.configuredAt ?? this.state.startedAt ?? this.now()) &&
      evidence.completedAt >= evidence.startedAt &&
      evidence.completedAt <= this.now() + 2000
    );
  }
  private actionIsCurrent(revision: number): boolean {
    return !this.stopped && this.revision === revision && !this.runtimeBudgetExpired();
  }
  noteUserInput(): void {
    this.revision++;
    this.lastUserInputRevision = this.revision;
    const phase = this.state.config.enabled ? 'paused' : 'disabled';
    this.state.phase = phase;
    this.arm();
    if ((!this.state.config.enabled && !this.state.inFlight) || this.userInputSaveQueued) return;
    const flight = this.state.inFlight;
    const persistedFlight = this.lastPersisted.inFlight;
    if (
      this.lastPersisted.phase === phase &&
      this.lastPersisted.reason === 'user-input' &&
      flight?.key === persistedFlight?.key &&
      flight?.startedAt === persistedFlight?.startedAt
    )
      return;
    this.userInputSaveQueued = true;
    void this.enqueue(() => {
      this.state.phase = this.state.config.enabled ? 'paused' : 'disabled';
      this.arm();
      const currentFlight = this.state.inFlight;
      const savedFlight = this.lastPersisted.inFlight;
      if (
        this.lastPersisted.phase === this.state.phase &&
        this.lastPersisted.reason === 'user-input' &&
        currentFlight?.key === savedFlight?.key &&
        currentFlight?.startedAt === savedFlight?.startedAt
      )
        return Promise.resolve(this.getStatus());
      return this.save('user-input');
    })
      .catch(() => {})
      .finally(() => {
        this.userInputSaveQueued = false;
      });
  }
  stop(): void {
    this.stopped = true;
    this.revision++;
    if (this.timer) clearTimeout(this.timer);
  }
  async drain(): Promise<void> {
    await this.queue;
  }
  /** Delivery may finish after the Session input guard releases, user input, or the runtime deadline.
   * Keep any possibly delivered reservation unresolved and never re-arm stale authority.
   */
  private preserveCancelledDelivery(
    revision: number,
    result: 'sent' | 'not-sent' | 'unknown',
    kickoff = false,
    externallyCurrent: () => boolean = () => true
  ): Promise<TaskState> | undefined {
    const deadlineExpired = !this.stopped && this.revision === revision && this.runtimeBudgetExpired();
    if (!this.stopped && this.revision === revision && !deadlineExpired && externallyCurrent()) return undefined;
    if (result === 'not-sent') {
      delete this.state.inFlight;
      if (kickoff) delete this.state.kickoffAt;
    }
    this.state.outcome = 'unknown';
    this.state.phase = deadlineExpired ? 'blocked' : 'paused';
    return this.save(
      this.lastUserInputRevision > revision ? 'user-input' : deadlineExpired ? 'budget-exhausted' : 'delivery-cancelled'
    );
  }
  /** Persist freshness and submission attribution together with every delivery reservation. */
  private reserveProgressBoundary(
    observation: RecoveryObservation,
    marker: TaskObservation['marker'],
    newPrompt: boolean
  ): void {
    this.state.lastProgressAt = Math.max(this.state.lastProgressAt ?? 0, this.now());
    // A process restart resumes the existing submission without typing a new prompt.
    // Dead-pane observations have no structured submission key to replace it.
    this.state.submissionKey = newPrompt ? undefined : (observation.submissionKey ?? this.state.submissionKey);
    if (marker) this.state.handledEvidence = [...this.state.handledEvidence, marker.key].slice(-32);
  }
  /** Clear only a delivery whose exact prompt is visible under a new submission identity. */
  private reconcileAcceptedFlight(state: TaskState, observation: RecoveryObservation): boolean {
    const flight = state.inFlight;
    if (
      !flight?.promptHash ||
      observation.submissionHash !== flight.promptHash ||
      !observation.submissionKey ||
      observation.submissionKey === flight.previousSubmissionKey
    )
      return false;
    state.submissionKey = observation.submissionKey;
    delete state.inFlight;
    return true;
  }
  private requireCurrent(revision: number): void {
    if (this.stopped || this.revision !== revision)
      throw new TaskValidationError('Task action was superseded by session input');
  }
  update(patch: TaskUpdate): Promise<TaskState> {
    TaskUpdateSchema.parse(patch);
    const revision = ++this.revision;
    return this.enqueue(async () => {
      this.requireCurrent(revision);
      const objective = patch.objective ?? this.state.objective;
      const criteria =
        patch.criteria ??
        this.state.criteria.map((c) =>
          c.kind === 'command'
            ? { id: c.id, description: c.description, kind: c.kind, command: c.command }
            : { id: c.id, description: c.description, kind: c.kind }
        );
      const changed =
        objective !== this.state.objective ||
        JSON.stringify(criteria) !==
          JSON.stringify(
            this.state.criteria.map((c) =>
              c.kind === 'command'
                ? { id: c.id, description: c.description, kind: c.kind, command: c.command }
                : { id: c.id, description: c.description, kind: c.kind }
            )
          );
      if (changed && this.state.inFlight) throw new TaskValidationError('Unresolved delivery requires reset');
      const candidate = changed ? initialTaskState() : this.getStatus();
      if (changed) candidate.config = { ...this.state.config };
      candidate.objective = objective;
      if (changed) {
        candidate.criteria = criteria.map((c) => ({ ...c, verified: false }));
        candidate.configuredAt = this.now();
        candidate.lastProgressAt = this.now();
      }
      if (patch.config) candidate.config = { ...candidate.config, ...patch.config };
      if (candidate.config.enabled && (!candidate.objective || !candidate.criteria.length))
        throw new TaskValidationError('Task objective and criteria are required');
      if (candidate.inFlight && candidate.config.enabled)
        throw new TaskValidationError('Unresolved delivery requires reset');
      if (acceptanceCriteriaComplete(candidate)) candidate.outcome = 'completed';
      // Configuration saves do not reacquire authority cancelled by owner input or restart.
      const enabledChanged = candidate.config.enabled !== this.state.config.enabled;
      candidate.phase =
        candidate.outcome === 'completed'
          ? 'completed'
          : !candidate.config.enabled
            ? 'disabled'
            : enabledChanged
              ? 'watching'
              : this.state.phase === 'completed'
                ? 'paused'
                : this.state.phase;
      const reason =
        !enabledChanged && candidate.config.enabled && ['paused', 'blocked'].includes(this.state.phase)
          ? this.state.reason
          : !changed && !enabledChanged && candidate.phase !== 'watching'
            ? candidate.reason
            : 'configured';
      if (candidate.config.enabled) candidate.startedAt ??= this.now();
      this.state = candidate;
      const result = await this.save(reason);
      this.arm();
      return result;
    });
  }
  progress(patch: TaskProgress, owner = true): Promise<TaskState> {
    TaskProgressSchema.parse(patch);
    const revision = ++this.revision;
    return this.enqueue(async () => {
      this.requireCurrent(revision);
      const { commands, observation } = await this.deps.observe();
      this.requireCurrent(revision);
      if (this.state.conversationId && observation.conversationId !== this.state.conversationId)
        throw new TaskValidationError('Task conversation changed');
      const candidate = this.getStatus();
      this.reconcileAcceptedFlight(candidate, observation);
      for (const id of patch.verifiedCriteria ?? []) {
        const c = candidate.criteria.find((c) => c.id === id);
        if (!c) throw new TaskValidationError('Unknown criterion');
        if (c.kind === 'manual' && !owner) throw new TaskValidationError('Manual criteria require owner verification');
        const hash = c.command ? commandHash(c.command) : undefined;
        const evidence = hash ? commands.get(hash) : undefined;
        if (c.kind === 'command' && !this.commandEvidenceIsCurrent(evidence))
          throw new TaskValidationError('Command success evidence is not verified');
        const at = c.kind === 'command' ? evidence!.completedAt : this.now();
        c.verified = true;
        c.evidence = {
          source: c.kind === 'command' ? 'command' : 'owner',
          at: at!,
          ...(hash ? { commandHash: hash } : {}),
        };
      }
      if (patch.outcome === 'completed' && (!candidate.criteria.length || !candidate.criteria.every((c) => c.verified)))
        throw new TaskValidationError('Acceptance criteria remain unverified');
      candidate.submissionKey = observation.submissionKey;
      this.state = candidate;
      this.state.lastProgressAt = this.now();
      this.state.outcome = acceptanceCriteriaComplete(this.state) ? 'completed' : patch.outcome;
      this.state.checkpoint = patch.checkpoint ?? this.state.checkpoint;
      this.state.nextAction = patch.nextAction ?? this.state.nextAction;
      this.state.phase =
        this.state.outcome === 'completed'
          ? 'completed'
          : patch.outcome === 'unfinished' && this.state.config.enabled
            ? 'watching'
            : patch.outcome === 'blocked'
              ? 'blocked'
              : 'paused';
      const result = await this.save('progress-recorded');
      this.arm();
      return result;
    });
  }
  pause(): Promise<TaskState> {
    this.revision++;
    return this.enqueue(async () => {
      this.state.phase = 'paused';
      this.arm();
      return this.save('owner-paused');
    });
  }
  resume(externallyCurrent: () => boolean = () => true): Promise<TaskState> {
    const revision = ++this.revision;
    return this.enqueue(async () => {
      this.requireCurrent(revision);
      if (!externallyCurrent()) {
        this.state.phase = 'paused';
        return this.save('delivery-cancelled');
      }
      if (this.state.inFlight) throw new TaskValidationError('Unresolved delivery requires reset');
      if (!this.state.objective || !this.state.criteria.length || this.state.outcome === 'completed')
        throw new TaskValidationError('No unfinished task to supervise');
      this.state.config.enabled = true;
      this.state.startedAt ??= this.now();
      if (this.state.kickoffAt !== undefined) {
        this.state.phase = 'watching';
        const result = await this.save('owner-resumed');
        if (!externallyCurrent()) {
          this.state.phase = 'paused';
          return this.save('delivery-cancelled');
        }
        this.arm();
        return result;
      }
      const { observation: o, marker } = await this.deps.observe();
      this.requireCurrent(revision);
      if (!externallyCurrent()) {
        this.state.phase = 'paused';
        return this.save('delivery-cancelled');
      }
      if (!o.conversationId || !o.processReady || !['idle', 'completed'].includes(o.activity)) {
        this.state.phase = 'paused';
        return this.save('kickoff-not-ready');
      }
      if (this.state.conversationId && this.state.conversationId !== o.conversationId) {
        this.state.phase = 'blocked';
        return this.save('identity-changed');
      }
      if (this.now() - this.state.startedAt >= this.state.config.maxRuntimeMs) {
        this.state.phase = 'blocked';
        return this.save('budget-exhausted');
      }
      this.state.conversationId = o.conversationId;
      const key = `${o.conversationId}:task-start:${this.now()}`;
      this.state.inFlight = {
        key,
        startedAt: this.now(),
        promptHash: createHash('sha256').update(this.prompt().trim()).digest('hex'),
        previousSubmissionKey: o.submissionKey,
      };
      this.state.handledEvidence = [...this.state.handledEvidence, key].slice(-32);
      this.state.kickoffAt = this.now();
      this.reserveProgressBoundary(o, marker, true);
      await this.save('kickoff-reserved');
      const beforeDeliveryCancelled = this.preserveCancelledDelivery(revision, 'not-sent', true, externallyCurrent);
      if (beforeDeliveryCancelled) return beforeDeliveryCancelled;
      const isCurrent = () => this.actionIsCurrent(revision) && externallyCurrent();
      const delivered = await this.deps.act(key, o.conversationId, this.prompt(), isCurrent);
      const cancelled = this.preserveCancelledDelivery(revision, delivered, true, externallyCurrent);
      if (cancelled) return cancelled;
      if (delivered === 'not-sent') {
        delete this.state.inFlight;
        delete this.state.kickoffAt;
      }
      this.state.outcome = 'unknown';
      this.state.phase = delivered === 'sent' ? 'watching' : 'paused';
      const result = await this.save(
        delivered === 'sent' ? 'kickoff-sent' : delivered === 'unknown' ? 'delivery-unknown' : 'delivery-cancelled'
      );
      this.arm();
      return result;
    });
  }
  reset(): Promise<TaskState> {
    this.revision++;
    return this.enqueue(async () => {
      const old = this.state;
      this.state = initialTaskState();
      this.state.lastProgressAt = this.now();
      this.state.configuredAt = this.now();
      this.state.objective = old.objective;
      this.state.criteria = old.criteria.map((c) =>
        c.kind === 'command'
          ? { id: c.id, description: c.description, kind: c.kind, command: c.command, verified: false }
          : { id: c.id, description: c.description, kind: c.kind, verified: false }
      );
      this.arm();
      const result = await this.save('owner-reset');
      // Clear the shared reservation only after this controller's uncertainty is durably gone.
      await this.deps.resetReservation?.();
      return result;
    });
  }
  private prompt(): string {
    return `Work on the authorized objective: ${this.state.objective}\nLast verified checkpoint: ${this.state.checkpoint}\nNext action: ${this.state.nextAction}\nAcceptance criteria: ${JSON.stringify(this.state.criteria.map((c) => ({ id: c.id, description: c.description, kind: c.kind, command: c.command, verified: c.verified })))}\nInspect recent actions before proceeding. Do not repeat completed external actions or destructive operations. Stop for approval, authentication, usage limits, completion or unknown evidence. Report progress as one structured agent message: CODEMAN_TASK_PROGRESS followed by a JSON object with outcome (unfinished, blocked, unknown, completed), checkpoint, nextAction, and optional verifiedCriteria array. Command criteria require exact command exit0 evidence; manual criteria require owner verification. Do not claim successful checks without verified evidence.`
      .replace(/[\r\n]+/g, ' ')
      .trim();
  }
  refresh(): Promise<TaskState> {
    return this.enqueue(async () => {
      if (this.stopped || !this.state.config.enabled || this.state.phase !== 'watching') return this.getStatus();
      const revision = this.revision;
      const { observation: o, commands, marker } = await this.deps.observe();
      if (this.stopped || revision !== this.revision) return this.getStatus();
      if (this.state.conversationId && o.conversationId !== this.state.conversationId) {
        this.state.phase = 'blocked';
        return this.save('identity-changed');
      }
      if (o.conversationId) this.state.conversationId = o.conversationId;
      if (this.state.inFlight?.promptHash) {
        const flight = this.state.inFlight;
        if (this.reconcileAcceptedFlight(this.state, o)) {
          await this.save('continuation-accepted');
        } else if (['paused', 'blocked', 'unknown'].includes(o.activity) || this.now() - flight.startedAt >= 60000) {
          this.state.phase = o.activity === 'blocked' ? 'blocked' : 'paused';
          return this.save('acceptance-unverified');
        } else return this.getStatus();
      }
      if (
        marker &&
        !!marker.submissionKey &&
        marker.submissionKey === this.state.submissionKey &&
        marker.submissionKey === o.submissionKey &&
        marker.at >= (this.state.configuredAt ?? this.state.startedAt ?? this.now()) &&
        marker.at > (this.state.lastProgressAt ?? 0) &&
        !this.state.handledEvidence.includes(marker.key)
      ) {
        const parsed = TaskProgressSchema.safeParse(marker.progress);
        if (parsed.success) {
          const p = parsed.data;
          let valid = true;
          for (const id of p.verifiedCriteria ?? []) {
            const c = this.state.criteria.find((c) => c.id === id);
            const hash = c?.command ? commandHash(c.command) : undefined;
            const evidence = hash ? commands.get(hash) : undefined;
            if (!c || c.kind !== 'command' || !hash || !this.commandEvidenceIsCurrent(evidence)) {
              valid = false;
              break;
            }
          }
          if (!valid) {
            this.state.outcome = 'unknown';
            this.state.phase = 'paused';
            return this.save('criterion-evidence-unverified');
          }
          if (valid) {
            for (const id of p.verifiedCriteria ?? []) {
              const c = this.state.criteria.find((c) => c.id === id)!;
              const hash = commandHash(c.command!);
              c.verified = true;
              c.evidence = { source: 'command', at: commands.get(hash)!.completedAt, commandHash: hash };
            }
            this.state.outcome = acceptanceCriteriaComplete(this.state)
              ? 'completed'
              : p.outcome === 'completed'
                ? 'unknown'
                : p.outcome;
            this.state.lastProgressAt = marker.at;
            this.state.checkpoint = p.checkpoint ?? this.state.checkpoint;
            this.state.nextAction = p.nextAction ?? this.state.nextAction;
            this.state.handledEvidence = [...this.state.handledEvidence, marker.key].slice(-32);
            await this.save('progress-recorded');
          }
        } else {
          this.state.outcome = 'unknown';
          this.state.phase = 'paused';
          return this.save('task-evidence-unknown');
        }
      }
      if (this.state.outcome === 'completed' || acceptanceCriteriaComplete(this.state)) {
        this.state.outcome = 'completed';
        this.state.phase = 'completed';
        return this.save('completed');
      }
      if (
        this.deps.recover &&
        ['crashed', 'interrupted'].includes(o.activity) &&
        o.safeToAct &&
        o.at >= (this.state.startedAt ?? 0) &&
        (o.activity !== 'crashed' ||
          o.liveProofAt === undefined ||
          (Number.isFinite(o.liveProofAt) && o.liveProofAt >= (this.state.startedAt ?? 0) && o.liveProofAt <= o.at)) &&
        o.evidenceKey &&
        (this.state.outcome === 'unfinished' || (this.state.outcome === 'unknown' && o.activity === 'crashed'))
      ) {
        if (
          this.state.continuations >= this.state.config.maxContinuations ||
          this.now() - (this.state.startedAt ?? this.now()) >= this.state.config.maxRuntimeMs
        ) {
          this.state.phase = 'blocked';
          return this.save('budget-exhausted');
        }
        if (!this.state.handledEvidence.includes(o.evidenceKey)) {
          const reservationAt = this.now();
          this.state.inFlight = {
            key: o.evidenceKey,
            startedAt: reservationAt,
            ...(o.activity === 'interrupted'
              ? {
                  promptHash: createHash('sha256').update(CONTINUATION_PROMPT.trim()).digest('hex'),
                  previousSubmissionKey: o.submissionKey,
                }
              : {}),
          };
          this.state.handledEvidence = [...this.state.handledEvidence, o.evidenceKey].slice(-32);
          this.state.continuations++;
          this.reserveProgressBoundary(o, marker, o.activity === 'interrupted');
          await this.save('recovery-reserved');
          const beforeDeliveryCancelled = this.preserveCancelledDelivery(revision, 'not-sent');
          if (beforeDeliveryCancelled) return beforeDeliveryCancelled;
          const result = await this.deps.recover(o, () => this.actionIsCurrent(revision));
          const cancelled = this.preserveCancelledDelivery(revision, result);
          if (cancelled) return cancelled;
          if (result === 'not-sent' || (result === 'sent' && o.activity === 'crashed')) delete this.state.inFlight;
          if (result === 'sent') {
            // Successful recovery invalidates the pre-recovery declaration of unfinished work.
            // A new marker or owner progress update must establish the next actionable checkpoint.
            this.state.outcome = 'unknown';
            this.state.checkpoint = '';
            this.state.nextAction = '';
            this.state.lastProgressAt = Math.max(this.state.lastProgressAt ?? 0, reservationAt);
          } else this.state.phase = 'paused';
          return this.save(
            result === 'sent' ? 'recovery-sent' : result === 'unknown' ? 'delivery-unknown' : 'delivery-cancelled'
          );
        }
      }
      if (['paused', 'blocked', 'unknown', 'crashed', 'interrupted', 'exited'].includes(o.activity)) {
        this.state.phase = o.activity === 'blocked' ? 'blocked' : 'paused';
        return this.save(o.reason);
      }
      if (this.state.outcome === 'blocked') {
        this.state.phase = 'blocked';
        return this.save('task-blocked');
      }
      // Limits prevent another dispatch; keep observing work already in progress
      // so its completion and verification evidence can still settle the task.
      if (o.activity === 'working' || o.activity === 'watching') return this.getStatus();
      if (
        this.now() - (this.state.startedAt ?? this.now()) >= this.state.config.maxRuntimeMs ||
        this.state.continuations >= this.state.config.maxContinuations
      ) {
        this.state.phase = 'blocked';
        return this.save('budget-exhausted');
      }
      if (this.state.outcome !== 'unfinished' || !this.state.checkpoint || !this.state.nextAction) {
        this.state.phase = 'paused';
        return this.save('task-evidence-unknown');
      }
      if (o.activity !== 'completed' || !o.turnId || !o.conversationId || !o.processReady) return this.getStatus();
      const key = `${o.conversationId}:task:${o.turnId}`;
      if (
        o.at < (this.state.configuredAt ?? this.state.startedAt ?? this.now()) ||
        this.state.handledEvidence.includes(key)
      )
        return this.getStatus();
      const prompt = this.prompt();
      this.state.inFlight = {
        key,
        startedAt: this.now(),
        promptHash: createHash('sha256').update(this.prompt().trim()).digest('hex'),
        previousSubmissionKey: o.submissionKey,
      };
      this.state.handledEvidence = [...this.state.handledEvidence, key].slice(-32);
      this.state.continuations++;
      this.reserveProgressBoundary(o, marker, true);
      await this.save('continuation-reserved');
      const beforeDeliveryCancelled = this.preserveCancelledDelivery(revision, 'not-sent');
      if (beforeDeliveryCancelled) return beforeDeliveryCancelled;
      const result = await this.deps.act(key, o.conversationId, prompt, () => this.actionIsCurrent(revision));
      const cancelled = this.preserveCancelledDelivery(revision, result);
      if (cancelled) return cancelled;
      if (result === 'unknown') {
        this.state.phase = 'paused';
        return this.save('delivery-unknown');
      }
      if (result === 'not-sent') delete this.state.inFlight;
      if (result === 'not-sent') {
        this.state.phase = 'paused';
        return this.save('delivery-cancelled');
      }
      this.state.outcome = 'unknown';
      this.state.phase = 'watching';
      await this.save('continuation-sent');
      return this.getStatus();
    });
  }
}
