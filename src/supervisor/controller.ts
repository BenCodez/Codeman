/** @fileoverview Codex manager authority, expressed only through guarded worker controllers. */
import type { RecoveryActionAuthority, RecoveryEvidenceSource, RecoveryState } from '../recovery/types.js';
import type { TaskState, TaskUpdate } from '../supervision/schema.js';
import { TaskConfigurationCancelledError } from '../supervision/controller.js';
import type { SupervisorWorkerInspection } from '../types/supervisor.js';
import { SUPERVISOR_MANAGER_MAX_RUNTIME_MS } from './manager-task.js';
import { formatTaskPrompt } from '../supervision/prompt.js';
import {
  SupervisorConfigSchema,
  SupervisorRequestSchema,
  initialSupervisorState,
  type SupervisorConfig,
  type SupervisorState,
} from './schema.js';

export class SupervisorValidationError extends Error {}
class SupervisorOperationRefused extends SupervisorValidationError {}

export type GuardedDispatchOutcome = 'accepted' | 'refused' | 'uncertain';

/** Classify the durable result of TaskController.resume without treating every flight as success. */
export function classifyTaskKickoff(state: TaskState): GuardedDispatchOutcome {
  if (state.phase === 'watching' && ['kickoff-sent', 'owner-resumed'].includes(state.reason)) return 'accepted';
  return state.inFlight ? 'uncertain' : 'refused';
}

/** Classify only an explicitly sent RecoveryController action as an accepted retry. */
export function classifyRecoveryRetry(state: RecoveryState): GuardedDispatchOutcome {
  if (
    state.phase === 'recovering' &&
    state.inFlight &&
    ['continuation-sent', 'process-resumed'].includes(state.lastReason)
  )
    return 'accepted';
  return state.inFlight ? 'uncertain' : 'refused';
}

export interface SupervisorWorkerHandle {
  /** Exact selected Session/controller incarnation throughout one operation. */
  isCurrent?(): boolean;
  /** Read-only current worker/issuer envelope check before an assignment reservation. */
  admitPrompt?(prompt: string, authority: RecoveryActionAuthority): Promise<boolean>;
  task: {
    getStatus(): TaskState;
    update(patch: TaskUpdate, isCurrent?: () => boolean): Promise<TaskState>;
    resume(isCurrent?: RecoveryActionAuthority, runtimeStartedAt?: number): Promise<TaskState>;
  };
  recovery: {
    getStatus(): RecoveryState;
    inspect(): Promise<RecoveryState>;
    inspectEvidence(): Promise<{ state: RecoveryState; observedAt: number; stale: boolean; isCurrent(): boolean }>;
    retry(isCurrent?: RecoveryActionAuthority): Promise<RecoveryState>;
  };
}
export interface SupervisorDependencies {
  /** Eligibility refusals are validation errors; operational failures must retain their type. */
  validateWorkers(ids: readonly string[]): void;
  worker(id: string): SupervisorWorkerHandle | undefined;
  persist(state: SupervisorState): Promise<void>;
  withLeases<T>(fn: () => Promise<T>): Promise<T>;
  leaseHolder(workerId: string, excludingSupervisor: string): string | undefined;
  /** Preserve a worker's durable attention veto while its live state changes. */
  agentProgressVeto?(workerId: string): boolean;
  /** Current manager Task grant, including durable attention vetoes and exact controller binding. */
  hasManagerAuthority(): boolean;
  /** Fresh bounded private proof immediately before each worker native effect. */
  prepareManagerAuthority(workerId: string, source?: RecoveryEvidenceSource): Promise<boolean>;
  /** Private launch-owned manager input scope, available only after fresh verification. */
  getInputIssuer?(): ReturnType<NonNullable<RecoveryActionAuthority['getInputIssuer']>>;
  /** Read-only native manager revalidation; never refresh/dispatch its Task controller here. */
  validateManagerAuthority(): Promise<boolean>;
  startManager(
    objective: string,
    workers: readonly SupervisorState['workers'][number][],
    isCurrent: () => boolean,
    runtimeStartedAt: number
  ): Promise<boolean>;
  pauseManager(): Promise<void>;
  resetManager(): Promise<void>;
  changed(state: SupervisorState): void;
  now?: () => number;
  inspectionTimeoutMs?: number;
  inspectionConcurrency?: number;
}

export class SupervisorController {
  private state: SupervisorState;
  private lastPersisted: SupervisorState;
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private revision = 0;
  private inspection?: Promise<SupervisorWorkerInspection[]>;
  private readonly workerInspections = new Map<
    string,
    {
      controller: SupervisorWorkerHandle['recovery'];
      promise: ReturnType<SupervisorWorkerHandle['recovery']['inspectEvidence']>;
    }
  >();

  constructor(
    private readonly deps: SupervisorDependencies,
    supervisorSessionId: string,
    restored?: SupervisorState
  ) {
    this.state = structuredClone(restored ?? initialSupervisorState(supervisorSessionId));
    if (this.state.enabled) {
      this.state.phase = 'paused';
      this.state.reason = this.state.inFlight ? 'restart-in-flight' : 'restart-requires-resume';
    }
    this.lastPersisted = structuredClone(this.state);
    if (this.state.enabled) void this.suspendManager();
  }

  getStatus(): SupervisorState {
    return structuredClone(this.state);
  }

  stop(): void {
    this.stopped = true;
    this.revision++;
    void this.suspendManager();
  }

  async drain(): Promise<void> {
    await this.queue;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
  private hasRuntimeBudget(startedAt: number | undefined, maxRuntimeMs: number): boolean {
    if (startedAt === undefined || !Number.isFinite(startedAt) || startedAt < 0) return false;
    const elapsed = this.now() - startedAt;
    return Number.isFinite(elapsed) && elapsed >= 0 && elapsed < maxRuntimeMs;
  }
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const guarded = async () => {
      if (this.stopped) throw new SupervisorValidationError('Supervisor is stopped');
      return fn();
    };
    const result = this.queue.then(guarded, guarded);
    this.queue = result.catch(() => {});
    return result;
  }
  /** Task.pause invalidates delivery authority synchronously, before its queued durable save. */
  private suspendManager(): Promise<unknown[]> {
    try {
      return this.deps.pauseManager().then(
        () => [],
        (error: unknown) => [error]
      );
    } catch (error) {
      return Promise.resolve([error]);
    }
  }
  private async save(reason: string, workerId?: string): Promise<SupervisorState> {
    // Start the Task veto before either journal await. A failed pause must not
    // prevent saving the supervisor's uncertainty or restore manager authority.
    let managerPause = this.state.phase !== 'active' ? this.suspendManager() : undefined;
    this.state.reason = reason;
    this.state.history = [...this.state.history, { at: this.now(), reason, ...(workerId ? { workerId } : {}) }].slice(
      -100
    );
    try {
      const snapshot = this.getStatus();
      await this.deps.persist(snapshot);
      this.lastPersisted = snapshot;
    } catch {
      this.state = structuredClone(this.lastPersisted);
      this.state.enabled = false;
      this.state.phase = 'blocked';
      this.state.reason = 'persistence-failed';
      managerPause ??= this.suspendManager();
      this.deps.changed(this.getStatus());
      await managerPause;
      throw new Error('Supervisor state could not be saved');
    }
    this.deps.changed(this.getStatus());
    const pauseErrors = await managerPause;
    if (pauseErrors?.length) throw pauseErrors[0];
    return this.getStatus();
  }

  configure(config: SupervisorConfig): Promise<SupervisorState> {
    SupervisorConfigSchema.parse(config);
    const revision = ++this.revision;
    // Owner reconfiguration revokes manager Task input before the supervisor
    // queue or lease journal can delay applying the replacement configuration.
    void this.suspendManager();
    return this.enqueue(async () => {
      try {
        return await this.deps.withLeases(async () => {
          if (this.revision !== revision) throw new SupervisorValidationError('Supervisor action was superseded');
          if (this.state.inFlight)
            throw new SupervisorValidationError('Unresolved supervisor operation requires owner reset');
          if (config.enabled) {
            this.deps.validateWorkers(config.workers.map((w) => w.sessionId));
            if (this.deps.leaseHolder(this.state.supervisorSessionId, this.state.supervisorSessionId))
              throw new SupervisorValidationError('A worker cannot become a supervisor');
            for (const worker of config.workers) {
              const holder = this.deps.leaseHolder(worker.sessionId, this.state.supervisorSessionId);
              if (holder) throw new SupervisorValidationError('Worker already has an active supervisor');
            }
          }
          this.state.objective = config.objective;
          this.state.enabled = config.enabled;
          this.state.workers = config.workers.map((worker) => ({ ...worker, assignments: 0 }));
          this.state.startedAt = undefined;
          this.state.phase = config.enabled ? 'ready' : 'disabled';
          return this.save('configured');
        });
      } catch (error) {
        // This request already revoked manager input. A rejected replacement
        // must expose that pause without overwriting a newer owner operation.
        if (this.revision === revision && this.state.phase === 'active') {
          this.state.phase = 'paused';
          await this.save('configuration-refused');
        }
        throw error;
      }
    });
  }

  start(): Promise<SupervisorState> {
    const revision = ++this.revision;
    return this.enqueue(() =>
      this.deps.withLeases(async () => {
        if (this.revision !== revision) throw new SupervisorValidationError('Supervisor action was superseded');
        if (!this.state.enabled || !this.state.objective.trim() || !this.state.workers.length)
          throw new SupervisorValidationError('Supervisor is not configured');
        if (this.state.phase === 'active') throw new SupervisorValidationError('Supervisor is already active');
        if (this.state.inFlight)
          throw new SupervisorValidationError('Unresolved supervisor operation requires owner reset');
        this.deps.validateWorkers(this.state.workers.map((w) => w.sessionId));
        if (this.deps.leaseHolder(this.state.supervisorSessionId, this.state.supervisorSessionId))
          throw new SupervisorValidationError('A worker cannot become a supervisor');
        for (const worker of this.state.workers) {
          const holder = this.deps.leaseHolder(worker.sessionId, this.state.supervisorSessionId);
          if (holder) throw new SupervisorValidationError('Worker already has an active supervisor');
        }
        this.state.phase = 'active';
        const runtimeStartedAt = (this.state.startedAt ??= this.now());
        await this.save('manager-start-reserved');
        try {
          const isCurrent = () =>
            !this.stopped &&
            this.revision === revision &&
            this.hasRuntimeBudget(runtimeStartedAt, SUPERVISOR_MANAGER_MAX_RUNTIME_MS);
          if (!isCurrent()) throw new SupervisorOperationRefused('Manager start was cancelled');
          this.deps.validateWorkers(this.state.workers.map((worker) => worker.sessionId));
          if (!(await this.deps.startManager(this.state.objective, this.state.workers, isCurrent, runtimeStartedAt)))
            throw new SupervisorOperationRefused('Manager conversation is not ready for task kickoff');
        } catch (error) {
          this.state.phase = 'paused';
          await this.save(
            error instanceof SupervisorValidationError ? 'manager-start-refused' : 'manager-start-uncertain'
          ).catch(() => {});
          throw error;
        }
        return this.save('owner-started');
      })
    );
  }

  pause(): Promise<SupervisorState> {
    this.revision++;
    void this.suspendManager();
    return this.enqueue(async () => {
      this.state.phase = 'paused';
      return this.save('owner-paused');
    });
  }

  reset(): Promise<SupervisorState> {
    this.revision++;
    void this.suspendManager();
    return this.enqueue(async () => {
      const id = this.state.supervisorSessionId;
      this.state = initialSupervisorState(id);
      const saved = await this.save('owner-reset');
      await this.deps.resetManager();
      return saved;
    });
  }

  async inspectWorkers(): Promise<SupervisorWorkerInspection[]> {
    if (this.state.phase !== 'active') throw new SupervisorValidationError('Supervisor is not active');
    if (!this.inspection) {
      this.inspection = this.runInspection().finally(() => {
        this.inspection = undefined;
      });
    }
    return structuredClone(await this.inspection);
  }

  private async runInspection(): Promise<SupervisorWorkerInspection[]> {
    const revision = this.revision;
    const configured = [...this.state.workers];
    const result = new Array<SupervisorWorkerInspection>(configured.length);
    // A wall-clock adjustment must not extend or prematurely exhaust the shared plan budget.
    const deadline = performance.now() + (this.deps.inspectionTimeoutMs ?? 10_000);
    const concurrency = Math.max(1, Math.min(4, this.deps.inspectionConcurrency ?? 4));
    let cursor = 0;
    const inspectOne = async (index: number): Promise<void> => {
      const workerId = configured[index].sessionId;
      const worker = this.deps.worker(workerId);
      const observedAt = this.now();
      if (!worker) {
        result[index] = {
          sessionId: workerId,
          health: 'unknown',
          observedAt,
          stale: true,
          taskStale: true,
          recoveryStale: true,
        };
        return;
      }
      const task = worker.task.getStatus();
      const fallback = worker.recovery.getStatus();
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        result[index] = {
          sessionId: workerId,
          task,
          recovery: fallback,
          health: 'unknown',
          observedAt,
          stale: true,
          taskStale: true,
          recoveryStale: true,
        };
        return;
      }
      let inspection = this.workerInspections.get(workerId);
      if (inspection && inspection.controller !== worker.recovery) {
        result[index] = {
          sessionId: workerId,
          task,
          recovery: fallback,
          health: 'unknown',
          observedAt,
          stale: true,
          taskStale: true,
          recoveryStale: true,
        };
        return;
      }
      if (!inspection) {
        inspection = {
          controller: worker.recovery,
          promise: worker.recovery
            .inspectEvidence()
            .catch(() => ({ state: fallback, observedAt, stale: true, isCurrent: () => false })),
        };
        this.workerInspections.set(workerId, inspection);
        void inspection.promise.finally(() => {
          if (this.workerInspections.get(workerId) === inspection) this.workerInspections.delete(workerId);
        });
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const evidence = await Promise.race([
        inspection.promise,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), remaining);
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      // Recovery inspection is read-only. Task refresh can dispatch work, so its
      // current durable snapshot carries its own explicit uncertainty instead.
      const currentWorker = this.deps.worker(workerId);
      if (
        this.stopped ||
        this.state.phase !== 'active' ||
        this.revision !== revision ||
        currentWorker?.task !== worker.task ||
        currentWorker?.recovery !== worker.recovery
      ) {
        result[index] = {
          sessionId: workerId,
          health: 'unknown',
          observedAt,
          stale: true,
          taskStale: true,
          recoveryStale: true,
        };
        return;
      }
      const currentTask = currentWorker.task.getStatus();
      const recovery = evidence && !evidence.stale && evidence.isCurrent() ? evidence.state : undefined;
      result[index] = recovery
        ? {
            sessionId: workerId,
            task: currentTask,
            recovery,
            health: this.health(recovery),
            observedAt: evidence!.observedAt,
            stale: true,
            taskStale: true,
            recoveryStale: false,
          }
        : {
            sessionId: workerId,
            task: currentTask,
            recovery: fallback,
            health: 'unknown',
            observedAt,
            stale: true,
            taskStale: true,
            recoveryStale: true,
          };
    };
    const runners = Array.from({ length: Math.min(concurrency, configured.length) }, async () => {
      while (cursor < configured.length) {
        const index = cursor++;
        await inspectOne(index);
      }
    });
    await Promise.all(runners);
    return result;
  }

  private health(recovery: RecoveryState): string {
    return recovery.lastReason === 'authentication-required'
      ? 'authentication-required'
      : recovery.lastReason === 'usage-limit'
        ? 'usage-limit'
        : recovery.lastReason === 'approval-required'
          ? 'waiting-user'
          : ['transport-unreachable', 'remote-session-missing'].includes(String(recovery.lastReason))
            ? 'unreachable-remote'
            : recovery.activity === 'exited' && recovery.lastReason === 'clean-exit'
              ? 'clean-exit'
              : recovery.activity === 'crashed'
                ? 'dead-pane'
                : recovery.activity === 'unknown'
                  ? 'unknown'
                  : recovery.activity;
  }

  assign(workerId: string, requestId: string, callerIsCurrent?: () => boolean): Promise<SupervisorState> {
    SupervisorRequestSchema.parse({ requestId });
    return this.operation(
      workerId,
      requestId,
      'assign',
      async (worker, configured, authority) => {
        const task = worker.task.getStatus();
        if (task.inFlight) throw new SupervisorValidationError('Worker has an unresolved task delivery');
        const sameCompletedTask =
          task.objective === configured.task &&
          task.outcome === 'completed' &&
          task.criteria.length === configured.criteria.length &&
          task.criteria.every((criterion, index) => {
            const expected = configured.criteria[index];
            return (
              criterion.verified &&
              criterion.id === expected.id &&
              criterion.description === expected.description &&
              criterion.kind === expected.kind &&
              criterion.command === expected.command
            );
          });
        if (sameCompletedTask)
          throw new SupervisorValidationError(
            'Worker already completed the configured task; owner reconfiguration is required'
          );
        if (worker.admitPrompt) {
          const snapshot = JSON.stringify(task);
          const sameTask = this.sameWorkerTask(task, configured);
          const prompt = formatTaskPrompt({
            objective: configured.task,
            criteria: sameTask
              ? task.criteria
              : configured.criteria.map((criterion) => ({ ...criterion, verified: false })),
            checkpoint: sameTask ? task.checkpoint : '',
            nextAction: sameTask ? task.nextAction : '',
          });
          if ((await worker.admitPrompt(prompt, authority)) !== true)
            throw new SupervisorValidationError('Worker prompt does not fit its current verified input envelope');
          // The manager's final revalidation also awaits. Keep this exact prompt
          // pinned until the operation is ready to perform its own Task update.
          return () => JSON.stringify(worker.task.getStatus()) === snapshot;
        }
        return undefined;
      },
      async (worker, configured, isCurrent, runtimeStartedAt) => {
        const existing = worker.task.getStatus();
        // A matching unfinished task retains the owner's tighter limits and its
        // existing runtime origin; a manager grant can only narrow those limits.
        const preservesTask = existing.outcome !== 'completed' && this.sameWorkerTask(existing, configured);
        await worker.task
          .update(
            {
              objective: configured.task,
              criteria: configured.criteria,
              config: {
                // Configuration is inert until the guarded resume below accepts the
                // supervisor's live cancellation token.
                enabled: false,
                maxContinuations: Math.min(
                  10,
                  configured.maxAssignments,
                  preservesTask ? existing.config.maxContinuations : 10
                ),
                maxRuntimeMs: Math.min(
                  configured.maxRuntimeMs,
                  preservesTask ? existing.config.maxRuntimeMs : configured.maxRuntimeMs
                ),
              },
            },
            isCurrent
          )
          .catch((error: unknown) => {
            if (error instanceof TaskConfigurationCancelledError)
              throw new SupervisorOperationRefused('Worker assignment was cancelled');
            throw error;
          });
        if (!isCurrent()) throw new SupervisorOperationRefused('Worker assignment was cancelled');
        const started = await worker.task.resume(isCurrent, runtimeStartedAt);
        if (!isCurrent()) {
          if (started.inFlight) throw new Error('Worker task delivery may have started before cancellation');
          throw new SupervisorOperationRefused('Worker assignment was cancelled');
        }
        const outcome = classifyTaskKickoff(started);
        if (outcome === 'uncertain') throw new Error('Worker task delivery acceptance is uncertain');
        if (outcome === 'refused') throw new SupervisorOperationRefused('Worker was not ready for task kickoff');
      },
      callerIsCurrent
    );
  }

  private sameWorkerTask(task: TaskState, configured: SupervisorState['workers'][number]): boolean {
    return (
      task.objective === configured.task &&
      task.criteria.length === configured.criteria.length &&
      task.criteria.every((criterion, index) => {
        const expected = configured.criteria[index];
        return (
          criterion.id === expected.id &&
          criterion.description === expected.description &&
          criterion.kind === expected.kind &&
          criterion.command === expected.command
        );
      })
    );
  }

  retry(workerId: string, requestId: string, callerIsCurrent?: () => boolean): Promise<SupervisorState> {
    SupervisorRequestSchema.parse({ requestId });
    let inspected: RecoveryState | undefined;
    return this.operation(
      workerId,
      requestId,
      'retry',
      async (worker) => {
        inspected = await worker.recovery.inspect();
        if (inspected.activity !== 'crashed' || inspected.circuitOpen || inspected.inFlight)
          throw new SupervisorValidationError('Worker has no validated retryable crash');
      },
      async (worker, _configured, isCurrent) => {
        if (!isCurrent()) throw new SupervisorOperationRefused('Worker retry was cancelled');
        // Recovery performs another fresh observation. An interruption there
        // must not turn the manager's crash retry into a manual continuation.
        const crashCurrent = Object.assign(
          () => isCurrent() && worker.recovery.getStatus().activity === 'crashed',
          isCurrent
        );
        const retried = await worker.recovery.retry(crashCurrent);
        if (!isCurrent()) {
          if (retried.inFlight) throw new Error('Worker recovery may have started before cancellation');
          throw new SupervisorOperationRefused('Worker retry was cancelled');
        }
        const outcome = classifyRecoveryRetry(retried);
        if (outcome === 'uncertain') throw new Error('Worker recovery delivery acceptance is uncertain');
        if (!inspected || outcome === 'refused')
          throw new SupervisorOperationRefused('Recovery controller refused the retry');
      },
      callerIsCurrent
    );
  }

  /** A manager's plan never clears a later worker pause, block, or competing task. */
  private workerAllowsAction(
    worker: SupervisorWorkerHandle,
    configured: SupervisorState['workers'][number],
    action: 'assign' | 'retry',
    includeFlights: boolean
  ): boolean {
    const task = worker.task.getStatus();
    const recovery = worker.recovery.getStatus();
    // The current dispatch may itself finish uncertain. Retain that result's
    // original classification; it is still an admission veto for every later action.
    const dispatchReserved =
      !includeFlights &&
      this.state.inFlight?.workerId === configured.sessionId &&
      this.state.inFlight.action === action;
    const ownTaskUncertainty =
      dispatchReserved && action === 'assign' && task.inFlight && task.reason === 'delivery-unknown';
    const ownRecoveryUncertainty =
      dispatchReserved && action === 'retry' && recovery.inFlight && recovery.lastReason === 'acceptance-unverified';
    const ownRecoveryRefusal =
      dispatchReserved && action === 'retry' && !recovery.inFlight && recovery.lastReason === 'delivery-failed';
    if (
      (action === 'assign' &&
        task.config.enabled &&
        task.phase === 'watching' &&
        task.kickoffAt !== undefined &&
        !dispatchReserved) ||
      task.agentProgressVeto === true ||
      this.deps.agentProgressVeto?.(configured.sessionId) === true ||
      (task.phase === 'paused' && !ownTaskUncertainty) ||
      task.phase === 'blocked' ||
      task.outcome === 'blocked' ||
      (recovery.phase === 'paused' && !ownRecoveryUncertainty && !ownRecoveryRefusal) ||
      recovery.phase === 'blocked' ||
      recovery.circuitOpen ||
      (includeFlights && (task.inFlight || recovery.inFlight))
    )
      return false;
    if (action !== 'assign' || !task.config.enabled || task.phase === 'completed' || !task.objective) return true;
    return (
      task.objective === configured.task &&
      task.criteria.length === configured.criteria.length &&
      task.criteria.every((criterion, index) => {
        const expected = configured.criteria[index];
        return (
          criterion.id === expected.id &&
          criterion.description === expected.description &&
          criterion.kind === expected.kind &&
          criterion.command === expected.command
        );
      })
    );
  }

  private operation(
    workerId: string,
    requestId: string,
    action: 'assign' | 'retry',
    preflight: (
      worker: SupervisorWorkerHandle,
      configured: SupervisorState['workers'][number],
      authority: RecoveryActionAuthority
    ) => Promise<void | (() => boolean)>,
    dispatch: (
      worker: SupervisorWorkerHandle,
      configured: SupervisorState['workers'][number],
      isCurrent: RecoveryActionAuthority,
      runtimeStartedAt: number
    ) => Promise<void>,
    callerIsCurrent?: () => boolean
  ): Promise<SupervisorState> {
    const callerCurrent = () => {
      try {
        return !callerIsCurrent || callerIsCurrent() === true;
      } catch {
        return false;
      }
    };
    const revision = this.revision;
    return this.enqueue(async () => {
      if (!callerCurrent()) throw new SupervisorOperationRefused('Supervisor credential is no longer current');
      if (this.state.handledRequestIds.includes(requestId)) {
        const binding = this.state.handledRequestBindings.find((entry) => entry.requestId === requestId);
        if (!binding || binding.workerId !== workerId || binding.action !== action)
          throw new SupervisorValidationError('Supervisor request id is bound to a different operation');
        return this.getStatus();
      }
      if (this.revision !== revision) throw new SupervisorValidationError('Supervisor action was superseded');
      if (this.state.phase !== 'active') throw new SupervisorValidationError('Supervisor is not active');
      if (this.state.handledRequestIds.length >= 128)
        throw new SupervisorValidationError('Supervisor request journal is full');
      if (this.state.inFlight)
        throw new SupervisorValidationError('Unresolved supervisor operation requires owner reset');
      const configured = this.state.workers.find((w) => w.sessionId === workerId);
      let worker = configured && this.deps.worker(workerId);
      if (!configured || !worker) throw new SupervisorValidationError('Worker is outside this supervisor');
      const selectedWorkerCurrent = worker.isCurrent?.bind(worker);
      let preparedPromptIsCurrent = () => true;
      // The first operation spends runtime during preflight too. Persist its origin
      // only once dispatch is accepted; a certified unsent refusal starts no budget.
      const runtimeStartedAt = configured.startedAt ?? this.now();
      const hasBudget = () =>
        configured.assignments < configured.maxAssignments &&
        this.hasRuntimeBudget(runtimeStartedAt, configured.maxRuntimeMs) &&
        this.hasRuntimeBudget(this.state.startedAt, SUPERVISOR_MANAGER_MAX_RUNTIME_MS);
      const isCurrent: RecoveryActionAuthority = () =>
        callerCurrent() &&
        !this.stopped &&
        this.revision === revision &&
        this.state.phase === 'active' &&
        this.deps.hasManagerAuthority?.() === true &&
        preparedPromptIsCurrent() &&
        (selectedWorkerCurrent ? selectedWorkerCurrent() === true : true) &&
        hasBudget() &&
        !!worker &&
        this.workerAllowsAction(worker, configured, action, false);
      isCurrent.getActionDeadline = () =>
        Math.min(
          runtimeStartedAt + configured.maxRuntimeMs,
          (this.state.startedAt ?? NaN) + SUPERVISOR_MANAGER_MAX_RUNTIME_MS
        );
      isCurrent.prepareEvidence = async (source) =>
        isCurrent() && (await this.deps.prepareManagerAuthority(workerId, source)) === true && isCurrent();
      if (this.deps.getInputIssuer)
        isCurrent.getInputIssuer = () => (isCurrent() ? this.deps.getInputIssuer!() : undefined);
      const requireCurrent = () => {
        if (!hasBudget()) throw new SupervisorOperationRefused('Worker assignment budget exhausted');
        if (!isCurrent()) throw new SupervisorOperationRefused('Supervisor operation was cancelled');
      };
      const requireManagerAuthority = async () => {
        let authorized = false;
        try {
          authorized = (await this.deps.validateManagerAuthority()) && this.deps.hasManagerAuthority();
        } catch {
          // A failed manager read grants no authority and has made no worker effect.
        }
        if (!authorized) {
          this.state.phase = 'paused';
          await this.save('manager-attention-required');
          throw new SupervisorOperationRefused('Manager task requires owner Start');
        }
      };
      await requireManagerAuthority();
      requireCurrent();
      if (!this.workerAllowsAction(worker, configured, action, true))
        throw new SupervisorValidationError('Worker task or recovery requires owner attention');
      preparedPromptIsCurrent = (await preflight(worker, configured, isCurrent)) ?? (() => true);
      await requireManagerAuthority();
      requireCurrent();
      this.state.inFlight = { requestId, workerId, action, reservedAt: this.now() };
      await this.save(`${action}-reserved`, workerId);
      try {
        await requireManagerAuthority();
        requireCurrent();
        try {
          this.deps.validateWorkers([workerId]);
        } catch (error) {
          if (error instanceof SupervisorValidationError)
            throw new SupervisorOperationRefused('Worker eligibility changed');
          throw error;
        }
        if (this.deps.leaseHolder(workerId, this.state.supervisorSessionId))
          throw new SupervisorOperationRefused('Worker lease changed');
        worker = this.deps.worker(workerId);
        if (!worker) throw new SupervisorOperationRefused('Worker is no longer available');
        if (!this.workerAllowsAction(worker, configured, action, true))
          throw new SupervisorOperationRefused('Worker task or recovery requires owner attention');
        requireCurrent();
        preparedPromptIsCurrent = () => true;
        await dispatch(worker, configured, isCurrent, runtimeStartedAt);
      } catch (error) {
        if (error instanceof SupervisorOperationRefused) {
          delete this.state.inFlight;
          if (!this.deps.hasManagerAuthority()) this.state.phase = 'paused';
          await this.save(`${action}-refused`, workerId);
          throw error;
        }
        // Dispatch may have reached the worker. Keep the durable reservation and require owner reset.
        this.state.phase = 'paused';
        await this.save(`${action}-uncertain`, workerId).catch(() => {});
        throw error;
      }
      configured.assignments++;
      configured.startedAt ??= runtimeStartedAt;
      configured.lastRequestId = requestId;
      this.state.handledRequestIds = [...this.state.handledRequestIds, requestId];
      this.state.handledRequestBindings = [...this.state.handledRequestBindings, { requestId, workerId, action }];
      delete this.state.inFlight;
      return this.save(`${action}-accepted`, workerId);
    });
  }
}
