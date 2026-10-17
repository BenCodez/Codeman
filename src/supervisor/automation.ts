/** Durable, single-flight management instructions. Scheduling never creates or restarts a manager. */
import { createHash } from 'node:crypto';
import type { RecoveryActionAuthority } from '../recovery/types.js';
import type {
  SupervisorAutomationConfig,
  SupervisorAutomationRecord,
  SupervisorAutomationRun,
  SupervisorAutomationStatus,
} from '../types/supervisor-automation.js';
import {
  initialSupervisorAutomationRecord,
  MAX_SUPERVISOR_AUTOMATION_RECEIPTS,
  SUPERVISOR_CHECK_IN_MAX_RUNS,
  remainingAutomationRuns,
  SupervisorAutomationConfigSchema,
  SupervisorAutomationRecordSchema,
  SupervisorAutomationRequestSchema,
} from './automation-schema.js';

export class SupervisorAutomationError extends Error {}
export const CHECK_IN_INSTRUCTIONS =
  'Check in on the owner-selected workers. Read supervisor_brain and supervisor_workers, including evidence freshness and usage. Report concise progress, blockers, and the next useful action. Use only the scoped tools and owner-granted messages. Do not interrupt active work, override a pause or manual acceptance, create workers, or change budgets.';
export interface SupervisorAutomationDependencies {
  /** Pure current prepared manager, active role, task/runtime and owner authority. */
  canRun(): boolean;
  dispatch(instructions: string, authority: RecoveryActionAuthority): Promise<'sent' | 'not-sent' | 'unknown'>;
  persist(state: SupervisorAutomationRecord): Promise<void>;
  now?: () => number;
  changed?(): void;
}
export class SupervisorAutomationController {
  private state: SupervisorAutomationRecord;
  private queue: Promise<unknown> = Promise.resolve();
  private revision = 0;
  private stopped = false;
  private failed = false;
  private ticking = false;
  private configuring = 0;
  constructor(
    private readonly deps: SupervisorAutomationDependencies,
    id: string,
    restored?: SupervisorAutomationRecord
  ) {
    this.state = structuredClone(restored ?? initialSupervisorAutomationRecord(id));
    SupervisorAutomationRecordSchema.parse(this.state);
    if (this.state.inFlight) {
      this.state.inFlight.phase = 'unknown';
      this.state.reason = 'restart-in-flight';
    }
  }
  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
  private current(caller: () => boolean): boolean {
    try {
      return caller() === true;
    } catch {
      return false;
    }
  }
  private available(): boolean {
    return this.current(() => this.deps.canRun());
  }
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const running = this.queue.then(fn, fn);
    this.queue = running.catch(() => {});
    return running;
  }
  private async save(): Promise<void> {
    try {
      await this.deps.persist(structuredClone(this.state));
    } catch (error) {
      this.failed = true;
      this.state.reason = 'persistence-failed';
      throw error;
    }
    this.deps.changed?.();
  }
  private receiptCapacity(config: SupervisorAutomationConfig = this.state): {
    limit: number;
    used: number;
    reserved: number;
    remaining: number;
  } {
    const used = this.state.handled.length + (this.state.inFlight ? 1 : 0);
    const reserved = remainingAutomationRuns(config, this.state.runs);
    return {
      limit: MAX_SUPERVISOR_AUTOMATION_RECEIPTS,
      used,
      reserved,
      remaining: MAX_SUPERVISOR_AUTOMATION_RECEIPTS - used - reserved,
    };
  }
  getStatus(): SupervisorAutomationStatus {
    return structuredClone({
      checkIns: this.state.checkIns,
      tasks: this.state.tasks,
      status: {
        phase:
          this.failed || this.state.inFlight?.phase === 'unknown' || this.receiptCapacity().remaining < 0
            ? 'blocked'
            : this.state.inFlight
              ? 'running'
              : 'idle',
        reason:
          !this.failed && !this.state.inFlight && this.receiptCapacity().remaining < 0
            ? 'run-allocation-exhausted'
            : this.state.reason,
        ...(this.state.handled.at(-1) ? { lastRun: this.state.handled.at(-1) } : {}),
        ...(this.state.inFlight ? { inFlight: this.state.inFlight } : {}),
        runs: this.state.runs,
      },
    });
  }
  configure(
    input: SupervisorAutomationConfig,
    callerCurrent: () => boolean = () => true
  ): Promise<SupervisorAutomationStatus> {
    const config = SupervisorAutomationConfigSchema.parse(input),
      revision = ++this.revision;
    this.configuring++;
    return this.enqueue(async () => {
      if (this.stopped || this.failed || revision !== this.revision || !this.current(callerCurrent))
        throw new SupervisorAutomationError('Management configuration is no longer current');
      if (this.receiptCapacity(config).remaining < 0)
        throw new SupervisorAutomationError(
          'Management schedules share 128 lifetime receipt slots, including retained history; reduce the remaining run allocation'
        );
      const previous = this.state;
      const runs = previous.runs.map((run) => ({ ...run }));
      const schedule = (taskId: string, due: number) => {
        if (!runs.some((run) => run.taskId === taskId)) runs.push({ taskId, attempts: 0, nextRunAt: due });
      };
      if (config.checkIns.enabled) {
        schedule('check-in', this.now() + config.checkIns.intervalMinutes * 60_000);
        if (!previous.checkIns.enabled || previous.checkIns.intervalMinutes !== config.checkIns.intervalMinutes)
          runs.find((run) => run.taskId === 'check-in')!.nextRunAt =
            this.now() + config.checkIns.intervalMinutes * 60_000;
      }
      for (const task of config.tasks) {
        if (task.enabled)
          schedule(task.id, task.kind === 'once' ? this.now() : this.now() + task.intervalMinutes! * 60_000);
        const old = previous.tasks.find((item) => item.id === task.id),
          run = runs.find((item) => item.taskId === task.id);
        if (
          run &&
          task.enabled &&
          (!old?.enabled || old.kind !== task.kind || old.intervalMinutes !== task.intervalMinutes)
        )
          run.nextRunAt = task.kind === 'once' ? this.now() : this.now() + task.intervalMinutes! * 60_000;
      }
      if (runs.length > 128) throw new SupervisorAutomationError('Management schedule history is full');
      this.state = { ...previous, ...config, runs, reason: previous.inFlight ? previous.reason : 'configured' };
      await this.save();
      if (!this.current(callerCurrent) || revision !== this.revision) {
        this.state.checkIns.enabled = false;
        this.state.tasks = this.state.tasks.map((task) => ({ ...task, enabled: false }));
        this.state.reason = 'configuration-cancelled';
        await this.save();
        throw new SupervisorAutomationError('Management configuration acknowledgement was cancelled');
      }
      return this.getStatus();
    }).finally(() => {
      this.configuring--;
    });
  }
  private plan(
    taskId: string
  ): { instructions: string; interval?: number; maxRuns: number; enabled: boolean; hash: string } | undefined {
    const task = taskId === 'check-in' ? undefined : this.state.tasks.find((item) => item.id === taskId);
    if (taskId !== 'check-in' && !task) return undefined;
    const instructions = task?.instructions ?? CHECK_IN_INSTRUCTIONS;
    const interval = task
      ? task.kind === 'recurring'
        ? task.intervalMinutes! * 60_000
        : undefined
      : this.state.checkIns.intervalMinutes * 60_000;
    return {
      instructions,
      interval,
      maxRuns: task ? (task.kind === 'once' ? 1 : task.maxRuns) : SUPERVISOR_CHECK_IN_MAX_RUNS,
      enabled: task?.enabled ?? this.state.checkIns.enabled,
      hash: createHash('sha256')
        .update(JSON.stringify({ taskId, task: task ?? this.state.checkIns, instructions }))
        .digest('hex'),
    };
  }
  runTask(
    taskId: string,
    requestId: string,
    callerCurrent: () => boolean = () => true
  ): Promise<SupervisorAutomationStatus> {
    return this.runInstruction(taskId, requestId, callerCurrent, false);
  }
  private runInstruction(
    taskId: string,
    requestId: string,
    callerCurrent: () => boolean,
    automatic: boolean
  ): Promise<SupervisorAutomationStatus> {
    SupervisorAutomationRequestSchema.parse({ requestId });
    const revision = this.revision;
    return this.enqueue(async () => {
      if (this.stopped || this.failed || !this.current(callerCurrent))
        throw new SupervisorAutomationError('Management scheduling is unavailable');
      const plan = this.plan(taskId),
        bound =
          this.state.inFlight?.requestId === requestId
            ? this.state.inFlight
            : this.state.handled.find((run) => run.requestId === requestId);
      if (bound) {
        if (bound.taskId !== taskId || (plan && bound.payloadHash !== plan.hash))
          throw new SupervisorAutomationError('Request ID is bound to different instructions');
        const status = this.getStatus();
        status.status.lastRun = structuredClone(bound);
        return status;
      }
      if (!plan || revision !== this.revision)
        throw new SupervisorAutomationError('Management task is no longer configured');
      if (this.state.inFlight) throw new SupervisorAutomationError('A management instruction remains unresolved');
      if (taskId === 'check-in' && !plan.enabled) throw new SupervisorAutomationError('Check-ins are disabled');
      if (this.receiptCapacity().remaining < 0)
        throw new SupervisorAutomationError('Management run allocation exceeds the shared 128 lifetime receipt slots');
      if (this.state.handled.length >= MAX_SUPERVISOR_AUTOMATION_RECEIPTS)
        throw new SupervisorAutomationError('Management request journal is full');
      const run = this.state.runs.find((item) => item.taskId === taskId) ?? { taskId, attempts: 0 };
      const flight: SupervisorAutomationRun = {
        requestId,
        taskId,
        payloadHash: plan.hash,
        startedAt: this.now(),
        phase: 'reserved',
      };
      if (run.attempts >= plan.maxRuns || !this.available()) {
        // Timer readiness is only a hint. A known-unsent race is not an admitted
        // request and must leave its deterministic ID, due time and receipt budget unused.
        if (automatic) return this.getStatus();
        // A refused manual request must not consume the slots already allocated to future work.
        if (this.receiptCapacity().remaining === 0)
          throw new SupervisorAutomationError(
            'No unallocated receipt slots remain for a refused request; scheduled runs retain their budget'
          );
        flight.phase = 'refused';
        this.state.handled.push(flight);
        this.state.reason = 'manager-not-ready';
        await this.save();
        return this.getStatus();
      }
      const priorRun = { ...run };
      if (!this.state.runs.includes(run)) this.state.runs.push(run);
      run.attempts++;
      run.nextRunAt = plan.interval === undefined ? undefined : this.now() + plan.interval;
      this.state.inFlight = flight;
      this.state.reason = 'instruction-reserved';
      await this.save();
      const current: RecoveryActionAuthority = () =>
        !this.stopped &&
        !this.failed &&
        revision === this.revision &&
        this.current(callerCurrent) &&
        this.state.inFlight === flight &&
        this.available();
      let result: 'sent' | 'not-sent' | 'unknown' = 'not-sent';
      try {
        if (current()) result = await this.deps.dispatch(plan.instructions, current);
      } catch {
        result = 'unknown';
      }
      if (result === 'unknown') {
        flight.phase = 'unknown';
        this.state.reason = 'instruction-uncertain';
        await this.save();
        return this.getStatus();
      }
      if (automatic && result === 'not-sent') {
        // Certified zero-byte automatic refusals are retryable. Release the exact
        // durable reservation before reusing its ID; do not consume a receipt slot.
        const reservedRun = { ...run };
        Object.assign(run, priorRun);
        if (priorRun.nextRunAt === undefined) delete run.nextRunAt;
        delete this.state.inFlight;
        this.state.reason = 'instruction-retryable';
        try {
          await this.save();
        } catch (error) {
          Object.assign(run, reservedRun);
          this.state.inFlight = { ...flight, phase: 'unknown' };
          throw error;
        }
        return this.getStatus();
      }
      flight.phase = result === 'sent' ? 'accepted' : 'refused';
      this.state.handled.push({ ...flight });
      delete this.state.inFlight;
      this.state.reason = result === 'sent' ? 'instruction-accepted' : 'instruction-refused';
      try {
        await this.save();
      } catch (error) {
        this.state.inFlight = { ...flight, phase: 'unknown' };
        throw error;
      }
      return this.getStatus();
    });
  }
  async tick(): Promise<void> {
    if (
      this.ticking ||
      this.configuring > 0 ||
      this.stopped ||
      this.failed ||
      this.state.inFlight ||
      this.receiptCapacity().remaining < 0 ||
      !this.available()
    )
      return;
    this.ticking = true;
    try {
      const due = this.state.runs
        .filter((run) => run.nextRunAt !== undefined && run.nextRunAt <= this.now())
        .sort((a, b) => a.nextRunAt! - b.nextRunAt!);
      for (const run of due) {
        const plan = this.plan(run.taskId);
        if (!plan?.enabled || run.attempts >= plan.maxRuns) continue;
        let requestId =
          'automation:' +
          createHash('sha256').update(`${this.state.supervisorSessionId}:${run.taskId}:${run.attempts}`).digest('hex');
        const previous = this.state.handled.find((receipt) => receipt.requestId === requestId);
        if (previous) {
          // Older versions durably refused a pre-reservation readiness race. Keep
          // that exact receipt sealed, but permit a new ID only for certified unsent work.
          if (previous.phase !== 'refused' || previous.taskId !== run.taskId) continue;
          requestId =
            'automation:' +
            createHash('sha256').update(`${requestId}:retry:${this.state.handled.length}`).digest('hex');
        }
        const revision = this.revision;
        const result = await this.runInstruction(
          run.taskId,
          requestId,
          () =>
            revision === this.revision &&
            this.plan(run.taskId)?.enabled === true &&
            this.plan(run.taskId)?.hash === plan.hash,
          true
        );
        // A certified unsent first task must not starve other due instructions.
        // Still stop after any accepted/unknown dispatch; the due list is bounded.
        if (result.status.reason === 'instruction-retryable' && this.available()) continue;
        break;
      }
    } finally {
      this.ticking = false;
    }
  }
  stop(): void {
    this.stopped = true;
    this.revision++;
  }
  async drain(): Promise<void> {
    await this.queue;
  }
}
