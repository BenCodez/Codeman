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
import {
  commandEvidenceIdentity,
  commandHash,
  type CommandSuccessEvidence,
  type TaskProgressMarker,
} from './evidence.js';
import { formatTaskPrompt, taskPromptFits } from './prompt.js';
import { earliestActionDeadline } from '../recovery/action-deadline.js';
import type { TaskSaveAuthority } from './store.js';
import {
  CONTINUATION_PROMPT,
  hasFreshProcessReady,
  type RecoveryObservation,
  type RecoveryActionAuthority,
} from '../recovery/types.js';
export interface TaskObservation {
  observation: RecoveryObservation;
  commands: Map<string, CommandSuccessEvidence>;
  marker?: TaskProgressMarker;
}
export interface TaskDependencies {
  /** Current read-only complete wire-envelope admission; production always supplies it. */
  admitPrompt?(prompt: string, authority: RecoveryActionAuthority, expected?: TaskObservation): Promise<boolean>;
  acceptReservation?(key: string): Promise<boolean>;
  resetReservation?(): Promise<void>;
  observe(): Promise<TaskObservation>;
  recover?(
    observation: RecoveryObservation,
    isCurrent: RecoveryActionAuthority
  ): Promise<'sent' | 'not-sent' | 'unknown'>;
  act(
    key: string,
    conversationId: string,
    prompt: string,
    isCurrent: RecoveryActionAuthority
  ): Promise<'sent' | 'not-sent' | 'unknown'>;
  /** Durable implementations must forward authority to their journal commit. */
  persist(state: TaskState, authority?: TaskSaveAuthority): Promise<void>;
  changed(state: TaskState): void;
  now?: () => number;
}
export class TaskValidationError extends Error {}
/** No task configuration reached its durable commit before authority was revoked. */
export class TaskConfigurationCancelledError extends TaskValidationError {}
/** A completion candidate never committed because its exact command proof changed. */
export class TaskCompletionEvidenceCancelledError extends TaskConfigurationCancelledError {}
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
  private configurationCommitUncertain = false;
  private evidenceFreshnessFloor: number;
  constructor(
    private readonly deps: TaskDependencies,
    restored?: TaskState
  ) {
    // Reloaded unverified evidence must be observed anew after owner resume.
    // Keep this conservative floor private so durable/live task bytes agree.
    this.evidenceFreshnessFloor = Math.max(this.now(), restored?.resumedAt ?? 0);
    this.state = structuredClone(restored ?? initialTaskState());
    // Command checks may have passed during a turn that is still running. Only
    // owner-certified manual-only work can infer completion without a terminal observation.
    if (
      !this.state.agentProgressVeto &&
      this.state.resumedAt === undefined &&
      acceptanceCriteriaComplete(this.state) &&
      this.state.criteria.every((criterion) => criterion.kind === 'manual' && criterion.evidence?.source === 'owner')
    )
      this.state.outcome = 'completed';
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
    this.arm();
  }
  getStatus(): TaskState {
    return structuredClone(this.state);
  }
  /** Bind delegated action authority to this owner revision; later Task intent requires a new grant. */
  captureActionAuthority(): () => boolean {
    const revision = this.revision;
    return () =>
      this.actionIsCurrent(revision) &&
      this.state.config.enabled &&
      this.state.phase === 'watching' &&
      !this.state.agentProgressVeto &&
      !['blocked', 'completed'].includes(this.state.outcome) &&
      this.state.continuations < this.state.config.maxContinuations;
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
  /** Guarded task changes stay private until the journal's authorized commit. */
  private async saveGuardedUpdate(
    candidate: TaskState,
    reason: string,
    isCurrent: () => boolean,
    renewEvidence: boolean,
    prepareCommit?: (commit: () => void) => Promise<void>,
    cancelled = () => new TaskConfigurationCancelledError('Task configuration authority was cancelled')
  ): Promise<TaskState> {
    candidate.reason = reason;
    candidate.history = [...candidate.history, { at: this.now(), reason }].slice(-100);
    const snapshot = structuredClone(candidate);
    let committed = false;
    const commit = () => {
      if (!isCurrent()) throw cancelled();
      if (committed) throw new Error('Task state was already committed');
      this.state = candidate;
      if (renewEvidence) this.evidenceFreshnessFloor = this.now();
      committed = true;
    };
    try {
      if (!isCurrent()) throw cancelled();
      await this.deps.persist(snapshot, {
        isCurrent,
        cancelled,
        prepareCommit,
        commit,
      });
      // In-memory persistence implementations commit when their promise settles.
      // The real store invokes commit at its atomic pathname replacement instead.
      if (!committed) {
        if (prepareCommit) await prepareCommit(commit);
        else {
          if (!isCurrent()) throw cancelled();
          commit();
        }
      }
      this.lastPersisted = snapshot;
    } catch (error) {
      if (error instanceof TaskConfigurationCancelledError) throw error;
      // Once committed, retain that task and any newer synchronous owner input.
      // A durability failure never restores an older objective over that state.
      this.state = structuredClone(this.state);
      this.state.config.enabled = false;
      this.state.phase = 'blocked';
      this.state.reason = 'persistence-failed';
      this.configurationCommitUncertain = true;
      this.revision++;
      this.arm();
      this.deps.changed(this.getStatus());
      throw error;
    }
    this.deps.changed(this.getStatus());
    return this.getStatus();
  }
  /** Command completion is proved again after journal preparation, at its final commit. */
  private saveCompletion(
    candidate: TaskState,
    reason: string,
    revision: number,
    expected: TaskObservation,
    requireCompletedTurn = false
  ): Promise<TaskState> {
    const proofs = candidate.criteria
      .filter((criterion) => criterion.kind === 'command' && criterion.verified)
      .map((criterion) => {
        const hash = commandHash(criterion.command!);
        const evidence = expected.commands.get(hash);
        return {
          hash,
          startedAt: evidence?.startedAt,
          completedAt: evidence?.completedAt,
          identity: evidence && commandEvidenceIdentity(evidence),
        };
      });
    const conversationId = candidate.conversationId;
    const submissionKey = expected.observation.submissionKey;
    const markerKey = expected.marker?.key;
    let evidenceCurrent = true;
    const isCurrent = () => !this.stopped && this.revision === revision && evidenceCurrent;
    const prepareCommit =
      proofs.length || requireCompletedTurn
        ? async (commit: () => void) => {
            const fresh = await this.deps.observe();
            evidenceCurrent =
              fresh.observation.conversationId === conversationId &&
              fresh.observation.submissionKey === submissionKey &&
              fresh.marker?.key === markerKey &&
              !['identity-unverified', 'identity-changed'].includes(fresh.observation.reason) &&
              !['unknown', 'paused', 'blocked'].includes(fresh.observation.activity) &&
              (!requireCompletedTurn ||
                (this.completedTurnIsCurrent(fresh.observation) &&
                  fresh.observation.turnId === expected.observation.turnId)) &&
              proofs.every((proof) => {
                const evidence = fresh.commands.get(proof.hash);
                return (
                  this.commandEvidenceIsCurrent(evidence) &&
                  (proof.identity !== undefined
                    ? commandEvidenceIdentity(evidence) === proof.identity
                    : commandEvidenceIdentity(evidence) === undefined &&
                      evidence.startedAt === proof.startedAt &&
                      evidence.completedAt === proof.completedAt)
                );
              });
            // TaskStore's callback performs its final guard and atomic replacement
            // synchronously here, before this evidence preparation promise settles.
            commit();
          }
        : undefined;
    return this.saveGuardedUpdate(candidate, reason, isCurrent, false, prepareCommit, () =>
      evidenceCurrent
        ? new TaskConfigurationCancelledError('Task progress authority was cancelled')
        : new TaskCompletionEvidenceCancelledError('Command success evidence changed before completion committed')
    );
  }
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.stopped && (this.state.inFlight || (this.state.config.enabled && this.state.phase === 'watching'))) {
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
      evidence.startedAt >= this.evidenceBoundary() &&
      evidence.completedAt >= evidence.startedAt &&
      evidence.completedAt <= this.now() + 2000
    );
  }
  private invalidateCommandCriteria(state: TaskState, commands: Map<string, CommandSuccessEvidence>): boolean {
    let invalidated = false;
    for (const criterion of state.criteria) {
      if (criterion.kind !== 'command' || !criterion.verified) continue;
      const evidence = criterion.command ? commands.get(commandHash(criterion.command)) : undefined;
      if (this.commandEvidenceIsCurrent(evidence)) continue;
      criterion.verified = false;
      delete criterion.evidence;
      invalidated = true;
    }
    return invalidated;
  }
  private completedTurnIsCurrent(observation: RecoveryObservation): boolean {
    return (
      observation.activity === 'completed' &&
      Number.isFinite(observation.at) &&
      observation.at > this.evidenceBoundary() &&
      observation.at <= this.now() + 2000
    );
  }
  private evidenceBoundary(): number {
    return Math.max(
      this.evidenceFreshnessFloor,
      this.state.resumedAt ?? 0,
      this.state.configuredAt ?? this.state.startedAt ?? this.now()
    );
  }
  private actionIsCurrent(revision: number): boolean {
    return !this.stopped && this.revision === revision && !this.runtimeBudgetExpired();
  }
  private actionAuthority(revision: number, inherited: RecoveryActionAuthority = () => true): RecoveryActionAuthority {
    const authority: RecoveryActionAuthority = () => this.actionIsCurrent(revision) && inherited();
    authority.getActionDeadline = () =>
      earliestActionDeadline((this.state.startedAt ?? NaN) + this.state.config.maxRuntimeMs, inherited);
    if (inherited.prepareEvidence)
      authority.prepareEvidence = async (source) =>
        authority() && (await inherited.prepareEvidence!(source)) === true && authority();
    if (inherited.getInputIssuer)
      authority.getInputIssuer = () => (authority() ? inherited.getInputIssuer!() : undefined);
    return authority;
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
  /** Refund only a delivery certified to have had no effect; uncertain flights keep their budget and replay fence. */
  private releaseUnsentFlight(kickoff = false): void {
    const flight = this.state.inFlight;
    if (!flight || flight.accepted) return;
    this.state.handledEvidence = this.state.handledEvidence.filter((key) => key !== flight.key);
    if (kickoff) delete this.state.kickoffAt;
    else this.state.continuations = Math.max(0, this.state.continuations - 1);
    delete this.state.inFlight;
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
      this.releaseUnsentFlight(kickoff);
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
    if (this.configurationCommitUncertain) throw new TaskValidationError('Task journal durability is uncertain');
    if (this.stopped || this.revision !== revision)
      throw new TaskValidationError('Task action was superseded by session input');
  }
  update(patch: TaskUpdate, externallyCurrent?: () => boolean): Promise<TaskState> {
    TaskUpdateSchema.parse(patch);
    if (externallyCurrent && !externallyCurrent())
      return Promise.reject(new TaskConfigurationCancelledError('Task configuration authority was cancelled'));
    const revision = ++this.revision;
    return this.enqueue(async () => {
      const isCurrent = () => !this.stopped && this.revision === revision && externallyCurrent?.() === true;
      if (externallyCurrent && !this.configurationCommitUncertain && !isCurrent())
        throw new TaskConfigurationCancelledError('Task configuration authority was cancelled');
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
      if (candidate.config.enabled && (!candidate.objective.trim() || !candidate.criteria.length))
        throw new TaskValidationError('Task objective and criteria are required');
      if (candidate.inFlight && candidate.config.enabled)
        throw new TaskValidationError('Unresolved delivery requires reset');
      // Even an unreadable-for-delivery legacy task can be explicitly disabled.
      if (changed || patch.config?.enabled !== false) this.requirePromptSize(candidate);
      if (!candidate.agentProgressVeto && acceptanceCriteriaComplete(candidate)) candidate.outcome = 'completed';
      // Configuration saves do not reacquire authority cancelled by owner input or restart.
      const enabledChanged = candidate.config.enabled !== this.state.config.enabled;
      candidate.phase = candidate.agentProgressVeto
        ? candidate.config.enabled
          ? candidate.outcome === 'blocked'
            ? 'blocked'
            : 'paused'
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
      if (candidate.config.enabled && candidate.phase === 'watching') {
        await this.requirePromptAdmission(
          candidate,
          () => !this.stopped && this.revision === revision && (!externallyCurrent || externallyCurrent() === true)
        );
        this.requireCurrent(revision);
      }
      if (candidate.config.enabled) candidate.startedAt ??= this.now();
      let result: TaskState;
      if (externallyCurrent) result = await this.saveGuardedUpdate(candidate, reason, isCurrent, changed);
      else {
        this.state = candidate;
        result = await this.save(reason);
        if (changed) this.evidenceFreshnessFloor = this.now();
      }
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
      const { commands, observation, marker } = await this.deps.observe();
      this.requireCurrent(revision);
      if (
        typeof observation.conversationId !== 'string' ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(observation.conversationId) ||
        observation.reason === 'identity-unverified' ||
        observation.reason === 'identity-changed'
      )
        throw new TaskValidationError('Task conversation is not verified');
      if (this.state.conversationId && observation.conversationId !== this.state.conversationId)
        throw new TaskValidationError('Task conversation changed');
      const candidate = this.getStatus();
      // Progress and command evidence belong to the first observed conversation, even before kickoff.
      candidate.conversationId ??= observation.conversationId;
      this.reconcileAcceptedFlight(candidate, observation);
      this.invalidateCommandCriteria(candidate, commands);
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
      // Owner uncertainty has the same cross-controller veto as agent attention.
      // Pausing this task must not transfer authority to generic recovery.
      if (patch.outcome === 'unknown' || patch.outcome === 'blocked') candidate.agentProgressVeto = true;
      else delete candidate.agentProgressVeto;
      const acceptedFlight = candidate.inFlight?.accepted;
      if (!acceptedFlight) candidate.submissionKey = observation.submissionKey;
      if (
        observation.conversationId &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(observation.conversationId) &&
        candidate.conversationId === observation.conversationId &&
        marker &&
        typeof marker.key === 'string' &&
        /^progress:[a-f0-9]{64}$/.test(marker.key) &&
        marker.submissionKey &&
        marker.submissionKey === observation.submissionKey &&
        !candidate.handledEvidence.includes(marker.key)
      ) {
        // This exact report was already visible before the owner accepted their
        // update. A later distinct report may share its timestamp, but this one
        // must not overwrite the owner's checkpoint or authorize an older step.
        const flightKey = candidate.inFlight?.key;
        candidate.handledEvidence = [
          ...candidate.handledEvidence.filter((key) => key !== flightKey),
          ...(flightKey ? [flightKey] : []),
          marker.key,
        ].slice(-32);
      }
      candidate.lastProgressAt = this.now();
      candidate.outcome =
        !candidate.agentProgressVeto && acceptanceCriteriaComplete(candidate) ? 'completed' : patch.outcome;
      candidate.checkpoint = patch.checkpoint ?? candidate.checkpoint;
      candidate.nextAction = patch.nextAction ?? candidate.nextAction;
      // Owner certification ends the task without sending another prompt.
      if (candidate.outcome !== 'completed') this.requirePromptSize(candidate);
      candidate.phase =
        candidate.outcome === 'completed'
          ? 'completed'
          : patch.outcome === 'unfinished' && candidate.config.enabled
            ? 'watching'
            : patch.outcome === 'blocked'
              ? 'blocked'
              : 'paused';
      if (candidate.phase === 'watching') {
        if (!this.runtimeBudgetExpired())
          await this.requirePromptAdmission(candidate, this.actionAuthority(revision), {
            observation,
            commands,
            marker,
          });
        this.requireCurrent(revision);
      }
      if (candidate.outcome === 'completed')
        await this.saveCompletion(candidate, 'progress-recorded', revision, { observation, commands, marker });
      else {
        this.state = candidate;
        await this.save('progress-recorded');
      }
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
      // Completion is terminal. Pause cannot reopen the finished objective.
      if (this.state.outcome === 'completed') return this.getStatus();
      this.state.phase = 'paused';
      this.arm();
      return this.save('owner-paused');
    });
  }
  resume(externallyCurrent: RecoveryActionAuthority = () => true, runtimeStartedAt?: number): Promise<TaskState> {
    if (
      runtimeStartedAt !== undefined &&
      (!Number.isFinite(runtimeStartedAt) || runtimeStartedAt < 0 || runtimeStartedAt > this.now())
    )
      throw new TaskValidationError('Task runtime origin is invalid');
    const revision = ++this.revision;
    const resumedAt = this.now();
    return this.enqueue(async () => {
      this.requireCurrent(revision);
      if (this.state.inFlight) throw new TaskValidationError('Unresolved delivery requires reset');
      if (!this.state.objective.trim() || !this.state.criteria.length || this.state.outcome === 'completed')
        throw new TaskValidationError('No unfinished task to supervise');
      this.requirePromptSize(this.state);
      const beforeObserveCancelled = this.preserveCancelledDelivery(revision, 'not-sent', false, externallyCurrent);
      if (beforeObserveCancelled) return beforeObserveCancelled;
      const runtimeOrigin = Math.min(this.state.startedAt ?? this.now(), runtimeStartedAt ?? this.now());
      // Re-watching an accepted kickoff sends no prompt. Its later input action
      // has a fresh admission check; a dead worker may first need task recovery.
      if (
        this.state.kickoffAt === undefined &&
        !this.runtimeBudgetExpired() &&
        this.now() - runtimeOrigin < this.state.config.maxRuntimeMs
      ) {
        await this.requirePromptAdmission(this.state, this.actionAuthority(revision, externallyCurrent));
        this.requireCurrent(revision);
      }
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
      this.state.resumedAt = Math.max(this.state.resumedAt ?? 0, resumedAt);
      this.evidenceFreshnessFloor = Math.max(this.evidenceFreshnessFloor, this.state.resumedAt);
      // Explicit Resume withdraws the old blocker, but does not certify a
      // continuation from its old checkpoint. New evidence must establish it.
      if (this.state.outcome === 'blocked') this.state.outcome = 'unknown';
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
      const canDispatch = this.actionAuthority(revision, externallyCurrent);
      const delivered = await this.deps.act(key, o.conversationId, this.prompt(), canDispatch);
      const cancelled = this.preserveCancelledDelivery(revision, delivered, true, externallyCurrent);
      if (cancelled) return cancelled;
      if (delivered === 'not-sent') {
        this.retainFinalEvidenceRefusal();
        this.releaseUnsentFlight(true);
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
      this.evidenceFreshnessFloor = this.now();
      // Clear the shared reservation only after this controller's uncertainty is durably gone.
      await this.deps.resetReservation?.();
      return result;
    });
  }
  private requirePromptSize(state: TaskState): void {
    if (!taskPromptFits(state)) throw new TaskValidationError('Task prompt must be valid UTF8 and fit 65536 bytes');
  }
  private async requirePromptAdmission(
    state: TaskState | string,
    authority: RecoveryActionAuthority,
    expected?: TaskObservation
  ): Promise<void> {
    if (!this.deps.admitPrompt) return;
    let admitted = false;
    try {
      admitted =
        (await this.deps.admitPrompt(
          typeof state === 'string' ? state : formatTaskPrompt(state),
          authority,
          expected
        )) === true && authority() === true;
    } catch {
      /* Unknown evidence is not permission to reserve input. */
    }
    if (!admitted) throw new TaskValidationError('Task prompt cannot fit the current verified input envelope');
  }
  private prompt(): string {
    return formatTaskPrompt(this.state);
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
      if (this.stopped) return this.getStatus();
      // A durable receipt authorizes only exact reservation cleanup, even after
      // reload or owner pause. Do not observe progress or dispatch from this path.
      if (this.state.inFlight?.accepted) {
        await this.settleAcceptedFlight();
        return this.getStatus();
      }
      const receiptOnly = !this.state.config.enabled || this.state.phase !== 'watching';
      if (receiptOnly && (!this.state.inFlight || !this.state.conversationId)) return this.getStatus();
      const revision = this.revision;
      const { observation: o, commands, marker } = await this.deps.observe();
      if (this.stopped || revision !== this.revision) return this.getStatus();
      if (this.state.conversationId && o.conversationId !== this.state.conversationId) {
        if (receiptOnly) return this.getStatus();
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
        } else if (receiptOnly) return this.getStatus();
        else if (['paused', 'blocked', 'unknown'].includes(o.activity) || this.now() - flight.startedAt >= 60000) {
          this.state.phase = o.activity === 'blocked' ? 'blocked' : 'paused';
          return this.save('acceptance-unverified');
        } else return this.getStatus();
      }
      // A pending receipt keeps observation alive after owner completion, pause,
      // disable or reload. It grants only exact cleanup, never another action or
      // progress update, and must preserve the owner's terminal phase and vetoes.
      if (receiptOnly) return this.getStatus();
      let commandCriteriaInvalidated = this.invalidateCommandCriteria(this.state, commands);
      const finishObservation = () =>
        commandCriteriaInvalidated ? this.save('command-evidence-invalidated') : this.getStatus();
      const markerIsCurrent =
        marker &&
        !!marker.submissionKey &&
        marker.submissionKey === this.state.submissionKey &&
        marker.submissionKey === o.submissionKey &&
        !this.state.handledEvidence.includes(marker.key);
      const progressBoundary = this.state.lastProgressAt ?? 0;
      const configurationBoundary = this.evidenceBoundary();
      if (markerIsCurrent && marker.latestAt !== undefined) {
        const intervalValid =
          Number.isFinite(marker.at) &&
          Number.isFinite(marker.latestAt) &&
          marker.latestAt >= marker.at &&
          marker.latestAt - marker.at <= 1000;
        const possiblyFresh = marker.latestAt >= configurationBoundary && marker.latestAt >= progressBoundary;
        const definitelyFresh = marker.at >= configurationBoundary && marker.at >= progressBoundary;
        // A remote marker overlapping newer owner intent cannot be dismissed as
        // stale and thereby release the previous action. Uncertainty is attention.
        if (!intervalValid || (possiblyFresh && (!definitelyFresh || marker.latestAt > this.now())))
          return this.recordAgentAttention(marker, 'task-evidence-unknown');
      }
      if (markerIsCurrent && marker.at >= configurationBoundary && marker.at >= progressBoundary) {
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
            const candidate = this.getStatus();
            for (const id of p.verifiedCriteria ?? []) {
              const c = candidate.criteria.find((c) => c.id === id)!;
              const hash = commandHash(c.command!);
              c.verified = true;
              c.evidence = { source: 'command', at: commands.get(hash)!.completedAt, commandHash: hash };
            }
            if (p.outcome === 'completed' && !acceptanceCriteriaComplete(candidate))
              return this.recordAgentAttention(marker, 'task-evidence-unknown');
            // An agent report can precede more work in the same turn. Leave a
            // completion report unconsumed until the terminal observation arrives.
            if (p.outcome === 'completed' && !this.completedTurnIsCurrent(o)) return finishObservation();
            candidate.outcome =
              acceptanceCriteriaComplete(candidate) && this.completedTurnIsCurrent(o) ? 'completed' : p.outcome;
            candidate.lastProgressAt = marker.at;
            candidate.checkpoint = p.outcome === 'unfinished' ? p.checkpoint! : (p.checkpoint ?? candidate.checkpoint);
            candidate.nextAction = p.outcome === 'unfinished' ? p.nextAction! : (p.nextAction ?? candidate.nextAction);
            if (!taskPromptFits(candidate)) return this.recordAgentAttention(marker, 'task-evidence-unknown');
            if (candidate.outcome !== 'completed') {
              try {
                await this.requirePromptAdmission(candidate, this.actionAuthority(revision), {
                  observation: o,
                  commands,
                  marker,
                });
              } catch {
                if (this.stopped || revision !== this.revision) return this.getStatus();
                return this.recordAgentAttention(marker, 'task-evidence-unknown');
              }
              if (this.stopped || revision !== this.revision) return this.getStatus();
            }
            candidate.handledEvidence = [...candidate.handledEvidence, marker.key].slice(-32);
            if (candidate.outcome === 'completed') {
              candidate.phase = 'completed';
              try {
                await this.saveCompletion(
                  candidate,
                  'progress-recorded',
                  revision,
                  {
                    observation: o,
                    commands,
                    marker,
                  },
                  true
                );
              } catch (error) {
                if (error instanceof TaskConfigurationCancelledError) return this.getStatus();
                throw error;
              }
            } else {
              this.state = candidate;
              await this.save('progress-recorded');
              commandCriteriaInvalidated = false;
            }
            if (this.stopped || revision !== this.revision) return this.getStatus();
          }
        } else return this.recordAgentAttention(marker, 'task-evidence-unknown');
      }
      if (
        this.completedTurnIsCurrent(o) &&
        (this.state.outcome === 'completed' || acceptanceCriteriaComplete(this.state))
      ) {
        if (this.state.phase === 'completed' && this.state.outcome === 'completed') return this.getStatus();
        const candidate = this.getStatus();
        candidate.outcome = 'completed';
        candidate.phase = 'completed';
        try {
          return await this.saveCompletion(
            candidate,
            'completed',
            revision,
            { observation: o, commands, marker },
            true
          );
        } catch (error) {
          if (error instanceof TaskConfigurationCancelledError) return this.getStatus();
          throw error;
        }
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
        (this.state.outcome === 'unfinished' || this.state.outcome === 'unknown')
      ) {
        if (this.state.continuations >= this.state.config.maxContinuations || this.runtimeBudgetExpired()) {
          this.state.phase = 'blocked';
          return this.save('budget-exhausted');
        }
        if (!this.state.handledEvidence.includes(o.evidenceKey)) {
          if (o.activity === 'interrupted') {
            try {
              await this.requirePromptAdmission(CONTINUATION_PROMPT, this.actionAuthority(revision), {
                observation: o,
                commands,
                marker,
              });
            } catch {
              if (this.stopped || revision !== this.revision) return this.getStatus();
              this.retainFinalEvidenceRefusal();
              this.state.phase = 'paused';
              return this.save('task-evidence-unknown');
            }
            if (this.stopped || revision !== this.revision) return this.getStatus();
          }
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
          const result = await this.deps.recover(o, this.actionAuthority(revision));
          const cancelled = this.preserveCancelledDelivery(revision, result);
          if (cancelled) return cancelled;
          if (result === 'not-sent') {
            this.retainFinalEvidenceRefusal();
            this.releaseUnsentFlight();
          }
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
      if (o.activity === 'working' || o.activity === 'watching') return finishObservation();
      if (this.runtimeBudgetExpired() || this.state.continuations >= this.state.config.maxContinuations) {
        this.state.phase = 'blocked';
        return this.save('budget-exhausted');
      }
      if (this.state.outcome !== 'unfinished' || !this.state.checkpoint || !this.state.nextAction) {
        this.state.phase = 'paused';
        return this.save('task-evidence-unknown');
      }
      if (o.activity !== 'completed' || !o.turnId || !o.conversationId || !o.processReady) return finishObservation();
      const key = `${o.conversationId}:task:${o.turnId}`;
      if (o.at < this.evidenceBoundary() || this.state.handledEvidence.includes(key)) return finishObservation();
      if (!taskPromptFits(this.state)) {
        this.retainFinalEvidenceRefusal();
        this.state.phase = 'paused';
        return this.save('task-evidence-unknown');
      }
      const prompt = this.prompt();
      try {
        await this.requirePromptAdmission(this.state, this.actionAuthority(revision), {
          observation: o,
          commands,
          marker,
        });
      } catch {
        if (this.stopped || revision !== this.revision) return this.getStatus();
        this.retainFinalEvidenceRefusal();
        this.state.phase = 'paused';
        return this.save('task-evidence-unknown');
      }
      if (this.stopped || revision !== this.revision) return this.getStatus();
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
      const result = await this.deps.act(key, o.conversationId, prompt, this.actionAuthority(revision));
      const cancelled = this.preserveCancelledDelivery(revision, result);
      if (cancelled) return cancelled;
      if (result === 'unknown') {
        this.state.phase = 'paused';
        return this.save('delivery-unknown');
      }
      if (result === 'not-sent') {
        this.retainFinalEvidenceRefusal();
        this.releaseUnsentFlight();
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
