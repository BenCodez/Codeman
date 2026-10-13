/** @fileoverview Integration coverage for WebServer's shared task/recovery action boundary. */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { Session } from '../src/session.js';
import { TmuxManager } from '../src/tmux-manager.js';
import { TaskController, type TaskDependencies } from '../src/supervision/controller.js';
import { CodexTaskAdapter } from '../src/supervision/adapter.js';
import { RecoveryController, type RecoveryDependencies } from '../src/recovery/controller.js';
import { CodexRecoveryAdapter } from '../src/recovery/codex-adapter.js';
import { initialTaskState } from '../src/supervision/schema.js';
import { SessionActionArbiter } from '../src/supervision/action-arbiter.js';
import {
  CONTINUATION_PROMPT,
  initialRecoveryState,
  type RecoveryFlight,
  type RecoveryState,
} from '../src/recovery/types.js';

interface ServerInternals {
  sessions: Map<string, Session>;
  taskStore: {
    save(id: string, state: ReturnType<typeof initialTaskState>): Promise<void>;
    drop(id: string): Promise<void>;
  };
  recoveryStore: { save(id: string, state: RecoveryState): Promise<void> };
  actionReservationStore: { save(id: string, state: ReturnType<typeof initialTaskState>): Promise<void> };
  getActionArbiter(id: string): SessionActionArbiter;
  getTaskController(session: Session): TaskController | undefined;
  getRecoveryController(session: Session): RecoveryController | undefined;
  stopRecoveryController(id: string, drop: boolean): Promise<void>;
}

interface TaskControllerInternals {
  deps: TaskDependencies;
}

interface RecoveryControllerInternals {
  deps: RecoveryDependencies;
}

const flight: RecoveryFlight = {
  key: 'recovery-evidence',
  action: 'continue',
  conversationId: '11111111-1111-1111-1111-111111111111',
  startedAt: 1,
};

let server: WebServer;
let internals: ServerInternals;
const ids = new Set<string>();

async function persistLegacyReservation(id: string, owners: { task: boolean; recovery: boolean }): Promise<void> {
  const taskState = initialTaskState();
  if (owners.task) taskState.inFlight = { key: 'old-task-flight', startedAt: 1 };
  await internals.taskStore.save(id, taskState);
  const recoveryState = initialRecoveryState();
  if (owners.recovery) recoveryState.inFlight = { ...flight, key: 'old-recovery-flight' };
  await internals.recoveryStore.save(id, recoveryState);
  const reservation = initialTaskState();
  reservation.inFlight = { key: 'bare-uuid-from-pr3', startedAt: 1 };
  await internals.actionReservationStore.save(id, reservation);
}

function controllers(id: string): {
  task: TaskController;
  taskDeps: TaskDependencies;
  recovery: RecoveryController;
  recoveryDeps: RecoveryDependencies;
} {
  ids.add(id);
  const session = new Session({ id, workingDir: process.cwd(), mode: 'codex', useMux: false });
  internals.sessions.set(id, session);
  const task = internals.getTaskController(session)!;
  const recovery = internals.getRecoveryController(session)!;
  return {
    task,
    taskDeps: (task as unknown as TaskControllerInternals).deps,
    recovery,
    recoveryDeps: (recovery as unknown as RecoveryControllerInternals).deps,
  };
}

beforeAll(() => {
  vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);
  server = new WebServer(0, false, true);
  internals = server as unknown as ServerInternals;
});

afterAll(async () => {
  for (const id of ids) {
    await internals.stopRecoveryController(id, true);
    internals.sessions.delete(id);
  }
  await server.stop().catch(() => {});
  vi.restoreAllMocks();
});

describe('task and recovery server action wiring', () => {
  it('keeps a task-owned unknown delivery reserved when recovery is reset', async () => {
    vi.spyOn(CodexTaskAdapter.prototype, 'act').mockResolvedValueOnce('unknown');
    const recoveryAct = vi.spyOn(CodexRecoveryAdapter.prototype, 'act').mockResolvedValue('sent');
    const { task, taskDeps, recovery, recoveryDeps } = controllers('task-owned-unknown');

    expect(await taskDeps.act('task-key', flight.conversationId, 'continue', () => true)).toBe('unknown');
    await recovery.reset();
    expect(await recoveryDeps.act(flight, () => true)).toBe('not-sent');
    expect(recoveryAct).not.toHaveBeenCalled();

    await task.reset();
    expect(await recoveryDeps.act(flight, () => true)).toBe('sent');
    expect(recoveryAct).toHaveBeenCalledOnce();
  });

  it('blocks recovery only while task supervision is watching or has an unresolved delivery', async () => {
    vi.spyOn(CodexTaskAdapter.prototype, 'observe').mockResolvedValue({
      observation: {
        activity: 'completed',
        reason: 'turn-completed',
        at: Date.now(),
        conversationId: flight.conversationId,
        processReady: true,
        safeToAct: false,
      },
      commands: new Map(),
    });
    const recoveryAct = vi.spyOn(CodexRecoveryAdapter.prototype, 'act').mockResolvedValue('sent');
    const { task, recoveryDeps } = controllers('task-phase-gate');
    await task.update({
      objective: 'Verify the fix',
      criteria: [{ id: 'review', description: 'Owner review', kind: 'manual' }],
      config: { enabled: true },
    });

    expect(task.getStatus().phase).toBe('watching');
    expect(await recoveryDeps.act(flight, () => true)).toBe('not-sent');
    await task.pause();
    expect(await recoveryDeps.act(flight, () => true)).toBe('sent');
    await task.progress({ outcome: 'completed', verifiedCriteria: ['review'] });
    expect(task.getStatus().phase).toBe('completed');
    expect(await recoveryDeps.act(flight, () => true)).toBe('sent');
    expect(recoveryAct).toHaveBeenCalledTimes(2);
  });

  it('settles an accepted kickoff when the owner completes the task before the acceptance poll', async () => {
    const observe = vi.spyOn(CodexTaskAdapter.prototype, 'observe').mockResolvedValue({
      observation: {
        activity: 'idle',
        reason: 'turn-idle',
        at: Date.now(),
        conversationId: flight.conversationId,
        submissionKey: 'before-kickoff',
        processReady: true,
        safeToAct: false,
      },
      commands: new Map(),
    });
    vi.spyOn(CodexTaskAdapter.prototype, 'act').mockResolvedValue('sent');
    const recoveryAct = vi.spyOn(CodexRecoveryAdapter.prototype, 'act').mockResolvedValue('sent');
    const { task, recoveryDeps } = controllers('owner-completes-accepted-kickoff');
    await task.update({
      objective: 'Review the completed work',
      criteria: [{ id: 'review', description: 'Owner review', kind: 'manual' }],
    });

    await task.resume();
    const pending = task.getStatus().inFlight!;
    expect(pending.promptHash).toBeTruthy();
    observe.mockResolvedValue({
      observation: {
        activity: 'working',
        reason: 'turn-running',
        at: Date.now() + 1,
        conversationId: flight.conversationId,
        submissionKey: 'accepted-kickoff',
        submissionHash: pending.promptHash,
        processReady: true,
        safeToAct: false,
      },
      commands: new Map(),
    });

    await task.progress({ outcome: 'unfinished', verifiedCriteria: ['review'] });

    expect(task.getStatus()).toMatchObject({ outcome: 'completed', phase: 'completed' });
    expect(task.getStatus().inFlight).toBeUndefined();
    expect(task.getStatus().criteria[0].evidence?.source).toBe('owner');
    expect(await recoveryDeps.act(flight, () => true)).toBe('sent');
    expect(recoveryAct).toHaveBeenCalledOnce();
    await expect(task.update({ objective: 'Review the follow-up work' })).resolves.toMatchObject({
      objective: 'Review the follow-up work',
      outcome: 'unknown',
      phase: 'watching',
    });
  });

  it('blocks task delivery until a sent recovery action has verified acceptance', async () => {
    const observe = vi.spyOn(CodexRecoveryAdapter.prototype, 'observe').mockResolvedValue({
      activity: 'interrupted',
      reason: 'turn-interrupted',
      at: Date.now(),
      conversationId: flight.conversationId,
      evidenceKey: 'sent-recovery-awaiting-acceptance',
      submissionKey: 'before-recovery',
      safeToAct: true,
    });
    vi.spyOn(CodexRecoveryAdapter.prototype, 'act').mockResolvedValue('sent');
    const taskAct = vi.spyOn(CodexTaskAdapter.prototype, 'act').mockResolvedValue('sent');
    const { taskDeps, recovery } = controllers('recovery-flight-gates-task');

    await recovery.retry();
    expect(recovery.getStatus().inFlight).toBeDefined();
    expect(await taskDeps.act('task-ready', flight.conversationId, 'continue task', () => true)).toBe('not-sent');
    expect(taskAct).not.toHaveBeenCalled();

    observe.mockResolvedValue({
      activity: 'working',
      reason: 'turn-running',
      at: Date.now() + 1,
      conversationId: flight.conversationId,
      submissionKey: 'accepted-recovery',
      submissionHash: createHash('sha256').update(CONTINUATION_PROMPT).digest('hex'),
      safeToAct: false,
    });
    await recovery.refresh();
    expect(recovery.getStatus().inFlight).toBeUndefined();
    expect(await taskDeps.act('task-ready', flight.conversationId, 'continue task', () => true)).toBe('sent');
    expect(taskAct).toHaveBeenCalledOnce();
  });

  it('allows recovery beside task supervision paused by a server restart', async () => {
    const id = 'task-restart-paused';
    const state = initialTaskState();
    state.objective = 'Verify the fix';
    state.criteria = [{ id: 'review', description: 'Owner review', kind: 'manual', verified: false }];
    state.config.enabled = true;
    state.phase = 'watching';
    await internals.taskStore.save(id, state);
    const recoveryAct = vi.spyOn(CodexRecoveryAdapter.prototype, 'act').mockResolvedValue('sent');
    const { task, recoveryDeps } = controllers(id);

    expect(task.getStatus()).toMatchObject({ phase: 'paused', reason: 'restart-requires-resume' });
    expect(await recoveryDeps.act(flight, () => true)).toBe('sent');
    expect(recoveryAct).toHaveBeenCalledOnce();
  });

  it('attributes a restored bare reservation to its exclusive durable task flight', async () => {
    const id = 'legacy-exclusive-task';
    await persistLegacyReservation(id, { task: true, recovery: false });
    const recoveryAct = vi.spyOn(CodexRecoveryAdapter.prototype, 'act').mockResolvedValue('sent');
    const { task, recovery, recoveryDeps } = controllers(id);

    await recovery.reset();
    expect(await recoveryDeps.act(flight, () => true)).toBe('not-sent');
    expect(recoveryAct).not.toHaveBeenCalled();
    await task.reset();
    expect(await recoveryDeps.act(flight, () => true)).toBe('sent');
    expect(recoveryAct).toHaveBeenCalledOnce();
  });

  it('clears an ambiguous restored bare reservation only after both flights are explicitly reset', async () => {
    const id = 'legacy-ambiguous-flights';
    await persistLegacyReservation(id, { task: true, recovery: true });
    const taskAct = vi.spyOn(CodexTaskAdapter.prototype, 'act').mockResolvedValue('sent');
    const { task, taskDeps, recovery } = controllers(id);
    internals.getActionArbiter(id);

    await recovery.reset();
    expect(await taskDeps.act('new-task', flight.conversationId, 'continue', () => true)).toBe('not-sent');
    expect(taskAct).not.toHaveBeenCalled();
    await task.reset();
    expect(await taskDeps.act('new-task', flight.conversationId, 'continue', () => true)).toBe('sent');
    expect(taskAct).toHaveBeenCalledOnce();
  });
});
