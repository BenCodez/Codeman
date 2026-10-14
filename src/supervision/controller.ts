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
import { commandHash, type CommandSuccessEvidence, type TaskProgressMarker } from './evidence.js';
import { CONTINUATION_PROMPT, hasFreshProcessReady, type RecoveryObservation } from '../recovery/types.js';
export interface TaskObservation {
  observation: RecoveryObservation;
  commands: Map<string, CommandSuccessEvidence>;
  marker?: TaskProgressMarker;
}
export interface TaskDependencies {
  acceptReservation?(key: string): Promise<boolean>;
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
  private lastOwnerPauseRevision = 0;
  private userInputSaveQueued = false;
  private stopped = false;
  constructor(
    private readonly deps: TaskDependencies,
    restored?: TaskState
  ) {
    this.state = structuredClone(restored ?? initialTaskState());
    if (!this.state.agentProgressVeto && acceptanceCriteriaComplete(this.state)) this.state.outcome = 'completed';
    if (this.state.config.enabled && this.state.inFlight) {
      this.state.phase = 'paused';
      this.state.reason = 'restart-in-flight';
    } else if (this.state.agentProgressVeto) {
      this.state.phase = 'paused';
      this.state.reason = 'task-evidence-unknown';
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
      const agentProgressVeto = this.state.agentProgressVeto;
      this.state = structuredClone(this.lastPersisted);
      if (agentProgressVeto) this.state.agentProgressVeto = true;
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
    if (this.state.startedAt === undefined) return false;
    const elapsed = this.now() - this.state.startedAt;
    return (
      this.state.startedAt < 0 || !Number.isFinite(elapsed) || elapsed < 0 || elapsed >= this.state.config.maxRuntimeMs
    );
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
    const hadAgentProgressVeto = !!this.state.agentProgressVeto;
    delete this.state.agentProgressVeto;
    this.revision++;
    this.lastUserInputRevision = this.revision;
    const phase = this.state.config.enabled ? 'paused' : 'disabled';
    this.state.phase = phase;
    this.arm();
    if ((!this.state.config.enabled && !this.state.inFlight && !hadAgentProgressVeto) || this.userInputSaveQueued)
      return;
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
      if (
        !this.stopped &&
        this.revision !== revision &&
        this.lastUserInputRevision <= revision &&
        this.lastOwnerPauseRevision <= revision
      )
        this.retainFinalEvidenceRefusal();
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
  /** Mark exact acceptance before releasing the common or domain reservation. */
  private reconcileAcceptedFlight(state: TaskState, observation: RecoveryObservation): boolean {
    const flight = state.inFlight;
    if (flight?.accepted) return true;
    if (!flight || !state.conversationId || observation.conversationId !== state.conversationId) return false;
    const accepted =
      flight.action === 'restart'
        ? hasFreshProcessReady(observation, flight.startedAt, this.now())
        : !!flight.promptHash &&
          observation.submissionHash === flight.promptHash &&
          !!observation.submissionKey &&
          observation.submissionKey !== flight.previousSubmissionKey;
    if (!accepted) return false;
    if (observation.submissionKey) state.submissionKey = observation.submissionKey;
    flight.action ??= 'continue';
    flight.accepted = true;
    flight.acceptedAt = this.now();
    return true;
  }
  private async settleAcceptedFlight(): Promise<boolean> {
    const flight = this.state.inFlight;
    if (!flight?.accepted) return false;
    // The accepted flag must already be durable before the common reservation clears.
    if (this.lastPersisted.inFlight?.key !== flight.key || !this.lastPersisted.inFlight.accepted)
      await this.save('continuation-accepted');
    if (this.deps.acceptReservation && !(await this.deps.acceptReservation(flight.key))) return false;
    delete this.state.inFlight;
    // A failed deletion write restores the durable accepted flight for cleanup on retry/reload.
    await this.save('continuation-accepted');
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
      if (changed) {
        candidate.config = { ...this.state.config };
        if (objective === this.state.objective && this.state.agentProgressVeto) candidate.agentProgressVeto = true;
      }
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
      if (!candidate.agentProgressVeto && acceptanceCriteriaComplete(candidate)) candidate.outcome = 'completed';
      // Configuration saves do not reacquire authority cancelled by owner input or restart.
      const enabledChanged = candidate.config.enabled !== this.state.config.enabled;
      candidate.phase = candidate.agentProgressVeto
        ? candidate.config.enabled
          ? 'paused'
          : 'disabled'
        : candidate.outcome === 'completed'
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
    if (!owner) throw new TaskValidationError('Task progress requires owner authority');
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
      if (patch.outcome === 'unfinished' || patch.outcome === 'completed') delete candidate.agentProgressVeto;
      const acceptedFlight = candidate.inFlight?.accepted;
      if (!acceptedFlight) candidate.submissionKey = observation.submissionKey;
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
      await this.save('progress-recorded');
      if (this.state.inFlight?.accepted) {
        const settled = await this.settleAcceptedFlight();
        if (
          settled &&
          !this.stopped &&
          revision === this.revision &&
          this.state.submissionKey !== observation.submissionKey
        ) {
          this.state.submissionKey = observation.submissionKey;
          await this.save('progress-recorded');
        }
      }
      this.arm();
      return this.getStatus();
    });
  }
  pause(): Promise<TaskState> {
    this.lastOwnerPauseRevision = ++this.revision;
    return this.enqueue(async () => {
      this.state.phase = 'paused';
      this.arm();
      return this.save('owner-paused');
    });
  }
  resume(externallyCurrent: () => boolean = () => true, runtimeStartedAt?: number): Promise<TaskState> {
    if (
      runtimeStartedAt !== undefined &&
      (!Number.isFinite(runtimeStartedAt) || runtimeStartedAt < 0 || runtimeStartedAt > this.now())
    )
      throw new TaskValidationError('Task runtime origin is invalid');
    const revision = ++this.revision;
    return this.enqueue(async () => {
      this.requireCurrent(revision);
      if (this.state.inFlight) throw new TaskValidationError('Unresolved delivery requires reset');
      if (!this.state.objective || !this.state.criteria.length || this.state.outcome === 'completed')
        throw new TaskValidationError('No unfinished task to supervise');
      const beforeObserveCancelled = this.preserveCancelledDelivery(revision, 'not-sent', false, externallyCurrent);
      if (beforeObserveCancelled) return beforeObserveCancelled;
      delete this.state.agentProgressVeto;
      this.state.config.enabled = true;
      if (this.runtimeBudgetExpired()) {
        this.state.phase = 'blocked';
        return this.save('budget-exhausted');
      }
      this.state.startedAt = Math.min(this.state.startedAt ?? this.now(), runtimeStartedAt ?? this.now());
      if (this.runtimeBudgetExpired()) {
        this.state.phase = 'blocked';
        return this.save('budget-exhausted');
      }
      if (this.state.kickoffAt !== undefined) {
        this.state.phase = 'watching';
        const result = await this.save('owner-resumed');
        const cancelled = this.preserveCancelledDelivery(revision, 'not-sent', false, externallyCurrent);
        if (cancelled) return cancelled;
        this.arm();
        return result;
      }
      const { observation: o, marker } = await this.deps.observe();
      this.requireCurrent(revision);
      const observationCancelled = this.preserveCancelledDelivery(revision, 'not-sent', false, externallyCurrent);
      if (observationCancelled) return observationCancelled;
      if (!o.conversationId || !o.processReady || !['idle', 'completed'].includes(o.activity)) {
        this.state.phase = 'paused';
        return this.save('kickoff-not-ready');
      }
      if (this.state.conversationId && this.state.conversationId !== o.conversationId) {
        this.state.phase = 'blocked';
        return this.save('identity-changed');
      }
      if (this.runtimeBudgetExpired()) {
        this.state.phase = 'blocked';
        return this.save('budget-exhausted');
      }
      this.state.conversationId = o.conversationId;
      const key = `${o.conversationId}:task-start:${this.now()}`;
      this.state.inFlight = {
        key,
        startedAt: this.now(),
        action: 'continue',
        promptHash: createHash('sha256').update(this.prompt().trim()).digest('hex'),
        previousSubmissionKey: o.submissionKey,
      };
      this.state.handledEvidence = [...this.state.handledEvidence, key].slice(-32);
      this.state.kickoffAt = this.now();
      this.reserveProgressBoundary(o, marker, true);
      await this.save('kickoff-reserved');
      const beforeDeliveryCancelled = this.preserveCancelledDelivery(revision, 'not-sent', true, externallyCurrent);
      if (beforeDeliveryCancelled) return beforeDeliveryCancelled;
      const delivered = await this.deps.act(
        key,
        o.conversationId,
        this.prompt(),
        () => this.actionIsCurrent(revision) && externallyCurrent()
      );
      const cancelled = this.preserveCancelledDelivery(revision, delivered, true, externallyCurrent);
      if (cancelled) return cancelled;
      if (delivered === 'not-sent') {
        this.retainFinalEvidenceRefusal();
        delete this.state.inFlight;
        delete this.state.kickoffAt;
      }
      this.state.outcome = 'unknown';
      this.state.phase = delivered === 'sent' ? 'watching' : 'paused';
      const result = await this.save(
        delivered === 'sent' ? 'kickoff-sent' : delivered === 'unknown' ? 'delivery-unknown' : 'delivery-cancelled'
      );
      const afterSaveCancelled = this.preserveCancelledDelivery(revision, delivered, true, externallyCurrent);
      if (afterSaveCancelled) return afterSaveCancelled;
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
  private retainFinalEvidenceRefusal(): void {
    this.state.agentProgressVeto = true;
    this.state.outcome = 'unknown';
    this.state.checkpoint = '';
    this.state.nextAction = '';
  }

  private recordAgentAttention(
    marker: NonNullable<TaskObservation['marker']>,
    reason: string,
    outcome: 'unknown' | 'blocked' = 'unknown'
  ): Promise<TaskState> {
    this.retainFinalEvidenceRefusal();
    this.state.outcome = outcome;
    this.state.phase = outcome === 'blocked' ? 'blocked' : 'paused';
    this.state.lastProgressAt = Math.max(
      this.state.lastProgressAt ?? 0,
      Number.isFinite(marker.latestAt) ? marker.latestAt! : Number.isFinite(marker.at) ? marker.at : 0
    );
    this.state.handledEvidence = [...this.state.handledEvidence, marker.key].slice(-32);
    this.arm();
    return this.save(reason);
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
      if (this.state.inFlight) {
        const flight = this.state.inFlight;
        if (this.reconcileAcceptedFlight(this.state, o)) {
          await this.save('continuation-accepted');
          if (!(await this.settleAcceptedFlight()) || this.stopped || revision !== this.revision)
            return this.getStatus();
        } else if (['paused', 'blocked', 'unknown'].includes(o.activity) || this.now() - flight.startedAt >= 60000) {
          this.state.phase = o.activity === 'blocked' ? 'blocked' : 'paused';
          return this.save('acceptance-unverified');
        } else return this.getStatus();
      }
      const markerIsCurrent =
        marker &&
        !!marker.submissionKey &&
        marker.submissionKey === this.state.submissionKey &&
        marker.submissionKey === o.submissionKey &&
        !this.state.handledEvidence.includes(marker.key);
      const progressBoundary = this.state.lastProgressAt ?? 0;
      const configurationBoundary = this.state.configuredAt ?? this.state.startedAt ?? this.now();
      if (markerIsCurrent && marker.latestAt !== undefined) {
        const intervalValid =
          Number.isFinite(marker.at) &&
          Number.isFinite(marker.latestAt) &&
          marker.latestAt >= marker.at &&
          marker.latestAt - marker.at <= 1000;
        const possiblyFresh = marker.latestAt >= configurationBoundary && marker.latestAt > progressBoundary;
        const definitelyFresh = marker.at >= configurationBoundary && marker.at > progressBoundary;
        // A remote marker overlapping newer owner intent cannot be dismissed as
        // stale and thereby release the previous action. Uncertainty is attention.
        if (!intervalValid || (possiblyFresh && (!definitelyFresh || marker.latestAt > this.now())))
          return this.recordAgentAttention(marker, 'task-evidence-unknown');
      }
      if (markerIsCurrent && marker.at >= configurationBoundary && marker.at > progressBoundary) {
        const parsed = TaskProgressSchema.safeParse(marker.progress);
        if (parsed.success) {
          const p = parsed.data;
          // Each agent report must establish its own actionable step; owner edits may remain incremental.
          if (
            p.outcome === 'unknown' ||
            (p.outcome === 'unfinished' && (!p.checkpoint?.trim() || !p.nextAction?.trim()))
          )
            return this.recordAgentAttention(marker, 'task-evidence-unknown');
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
          if (!valid) return this.recordAgentAttention(marker, 'criterion-evidence-unverified');
          if (valid) {
            if (p.outcome === 'blocked') return this.recordAgentAttention(marker, 'task-blocked', 'blocked');
            for (const id of p.verifiedCriteria ?? []) {
              const c = this.state.criteria.find((c) => c.id === id)!;
              const hash = commandHash(c.command!);
              c.verified = true;
              c.evidence = { source: 'command', at: commands.get(hash)!.completedAt, commandHash: hash };
            }
            if (p.outcome === 'completed' && !acceptanceCriteriaComplete(this.state))
              return this.recordAgentAttention(marker, 'task-evidence-unknown');
            this.state.outcome = acceptanceCriteriaComplete(this.state) ? 'completed' : p.outcome;
            this.state.lastProgressAt = marker.at;
            this.state.checkpoint =
              p.outcome === 'unfinished' ? p.checkpoint! : (p.checkpoint ?? this.state.checkpoint);
            this.state.nextAction =
              p.outcome === 'unfinished' ? p.nextAction! : (p.nextAction ?? this.state.nextAction);
            this.state.handledEvidence = [...this.state.handledEvidence, marker.key].slice(-32);
            await this.save('progress-recorded');
            if (this.stopped || revision !== this.revision) return this.getStatus();
          }
        } else return this.recordAgentAttention(marker, 'task-evidence-unknown');
      }
      if (this.state.outcome === 'completed' || acceptanceCriteriaComplete(this.state)) {
        this.state.outcome = 'completed';
        this.state.phase = 'completed';
        return this.save('completed');
      }
      if (
        this.deps.recover &&
        !this.state.agentProgressVeto &&
        ['crashed', 'interrupted'].includes(o.activity) &&
        o.safeToAct &&
        o.at >= (this.state.startedAt ?? 0) &&
        (o.activity !== 'crashed' ||
          (typeof o.liveProofAt === 'number' &&
            Number.isFinite(o.liveProofAt) &&
            o.liveProofAt >= (this.state.startedAt ?? 0) &&
            o.liveProofAt <= o.at &&
            o.liveProofAt <= this.now() &&
            o.at - o.liveProofAt <= 30_000 &&
            this.now() - o.liveProofAt <= 30_000)) &&
        o.evidenceKey &&
        (this.state.outcome === 'unfinished' || (this.state.outcome === 'unknown' && o.activity === 'crashed'))
      ) {
        if (this.state.continuations >= this.state.config.maxContinuations || this.runtimeBudgetExpired()) {
          this.state.phase = 'blocked';
          return this.save('budget-exhausted');
        }
        if (!this.state.handledEvidence.includes(o.evidenceKey)) {
          const reservationAt = this.now();
          this.state.inFlight = {
            key: o.evidenceKey,
            startedAt: reservationAt,
            action: o.activity === 'crashed' ? 'restart' : 'continue',
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
          if (result === 'not-sent') this.retainFinalEvidenceRefusal();
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
      if (this.runtimeBudgetExpired() || this.state.continuations >= this.state.config.maxContinuations) {
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
        action: 'continue',
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
        this.retainFinalEvidenceRefusal();
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
