/** @fileoverview Integration coverage for WebServer's shared task/recovery action boundary. */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { Session } from '../src/session.js';
import { TmuxManager } from '../src/tmux-manager.js';
import { TaskController, type TaskDependencies } from '../src/supervision/controller.js';
import { CodexTaskAdapter } from '../src/supervision/adapter.js';
import { RecoveryController, type RecoveryDependencies } from '../src/recovery/controller.js';
import { CodexRecoveryAdapter } from '../src/recovery/codex-adapter.js';
import { initialTaskState } from '../src/supervision/schema.js';
import { TaskStore } from '../src/supervision/store.js';
import { RecoveryStore } from '../src/recovery/store.js';
import { SessionActionArbiter } from '../src/supervision/action-arbiter.js';
import { createDeferred } from './mocks/index.js';
import {
  CONTINUATION_PROMPT,
  initialRecoveryState,
  type RecoveryFlight,
  type RecoveryObservation,
} from '../src/recovery/types.js';

interface ServerInternals {
  sessions: Map<string, Session>;
  taskStore: TaskStore;
  recoveryStore: RecoveryStore;
  actionReservationStore: TaskStore;
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
  if (owners.recovery) recoveryState.inFlight = { ...flight, key: 'old-recovery-flight', startedAt: Date.now() };
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

  it('defers recovery attempts while a supervised task recovers a pre-marker crash', async () => {
    let taskObservation: RecoveryObservation = {
      activity: 'idle' as const,
      reason: 'observing' as const,
      at: Date.now(),
      conversationId: flight.conversationId,
      submissionKey: 'before-kickoff',
      processReady: true,
      safeToAct: false,
    };
    vi.spyOn(CodexTaskAdapter.prototype, 'observe').mockImplementation(async () => ({
      observation: taskObservation,
      commands: new Map(),
    }));
    vi.spyOn(CodexTaskAdapter.prototype, 'act').mockResolvedValue('sent');
    const taskRecover = vi.spyOn(CodexTaskAdapter.prototype, 'recover').mockResolvedValue('sent');
    let recoveryObservation: RecoveryObservation = { ...taskObservation };
    vi.spyOn(CodexRecoveryAdapter.prototype, 'observe').mockImplementation(async () => recoveryObservation);
    const recoveryAct = vi.spyOn(CodexRecoveryAdapter.prototype, 'act').mockResolvedValue('sent');
    const { task, recovery } = controllers('task-premarker-crash');
    await recovery.updateConfig({ enabled: true, maxRetries: 1 });
    await task.update({
      objective: 'Complete the supervised task',
      criteria: [{ id: 'review', description: 'Owner review', kind: 'manual' }],
    });

    await task.resume();
    const kickoff = task.getStatus().inFlight!;
    taskObservation = {
      activity: 'working',
      reason: 'turn-running',
      at: Date.now(),
      conversationId: flight.conversationId,
      submissionKey: 'accepted-kickoff',
      submissionHash: kickoff.promptHash,
      processReady: true,
      safeToAct: false,
    };
    await task.refresh();
    expect(task.getStatus()).toMatchObject({ phase: 'watching', outcome: 'unknown' });
    expect(task.getStatus().inFlight).toBeUndefined();

    const crash = {
      activity: 'crashed' as const,
      reason: 'process-crashed' as const,
      at: Date.now() + 1000,
      conversationId: flight.conversationId,
      evidenceKey: 'premarker-crash',
      processReady: false,
      safeToAct: true,
    };
    taskObservation = crash;
    recoveryObservation = crash;

    await recovery.retry();

    expect(recovery.getStatus()).toMatchObject({ attempts: 0, failedAttempts: 0, circuitOpen: false });
    expect(recovery.getStatus().inFlight).toBeUndefined();
    expect(recoveryAct).not.toHaveBeenCalled();

    await task.refresh();

    expect(taskRecover).toHaveBeenCalledOnce();
    expect(task.getStatus()).toMatchObject({ reason: 'recovery-sent', continuations: 1, outcome: 'unknown' });
  });

  it.each(['unknown', 'blocked', 'incomplete', 'malformed'] as const)(
    'retains an agent %s progress veto across sibling recovery, settings and controller restart',
    async (kind) => {
      let now = Date.now();
      let marker: Awaited<ReturnType<TaskDependencies['observe']>>['marker'];
      const taskObservation: RecoveryObservation = {
        activity: 'working',
        reason: 'turn-running',
        at: now,
        conversationId: flight.conversationId,
        submissionKey: 'agent-veto-submission',
        processReady: false,
        safeToAct: false,
      };
      vi.spyOn(CodexTaskAdapter.prototype, 'observe').mockImplementation(async () => ({
        observation: taskObservation,
        commands: new Map(),
        marker,
      }));
      vi.spyOn(CodexRecoveryAdapter.prototype, 'observe').mockImplementation(async () => ({
        activity: 'crashed',
        reason: 'process-crashed',
        at: now,
        conversationId: flight.conversationId,
        evidenceKey: `agent-${kind}-crash`,
        safeToAct: true,
      }));
      const taskRecover = vi.spyOn(CodexTaskAdapter.prototype, 'recover').mockResolvedValue('sent');
      const recoveryAct = vi.spyOn(CodexRecoveryAdapter.prototype, 'act').mockResolvedValue('sent');
      const id = `agent-progress-veto-${kind}`;
      const { task, taskDeps, recovery, recoveryDeps } = controllers(id);
      taskDeps.now = recoveryDeps.now = () => now;
      await task.update({
        objective: 'Finish the owner task',
        criteria: [{ id: 'review', description: 'Owner acceptance', kind: 'manual' }],
        config: { enabled: true },
      });
      await task.progress({ outcome: 'unfinished', checkpoint: 'Earlier checkpoint', nextAction: 'Earlier action' });
      now++;
      marker = {
        key: `agent-${kind}-marker`,
        at: now,
        submissionKey: taskObservation.submissionKey,
        progress:
          kind === 'malformed'
            ? { outcome: 'unsupported' }
            : kind === 'incomplete'
              ? { outcome: 'unfinished', checkpoint: 'Fresh checkpoint without an action' }
              : { outcome: kind },
      };
      await task.refresh();
      expect(task.getStatus()).toMatchObject({
        phase: kind === 'blocked' ? 'blocked' : 'paused',
        agentProgressVeto: true,
      });
      expect(internals.taskStore.get(id).agentProgressVeto).toBe(true);
      expect(new TaskStore().get(id).agentProgressVeto).toBe(true);
      await recovery.retry();
      expect(recovery.getStatus().attempts).toBe(0);
      expect(recovery.getStatus().inFlight).toBeUndefined();
      await task.update({ config: { enabled: false, maxContinuations: 1 } });
      await task.pause();
      expect(task.getStatus().agentProgressVeto).toBe(true);
      await recovery.retry();
      expect(recoveryAct).not.toHaveBeenCalled();

      const session = internals.sessions.get(id)!;
      await internals.stopRecoveryController(id, false);
      const restoredTask = internals.getTaskController(session)!;
      const restoredRecovery = internals.getRecoveryController(session)!;
      expect(restoredTask.getStatus().agentProgressVeto).toBe(true);
      await restoredRecovery.retry();
      expect(restoredRecovery.getStatus().attempts).toBe(0);
      expect(recoveryAct).not.toHaveBeenCalled();
      expect(taskRecover).not.toHaveBeenCalled();

      await restoredTask.reset();
      await restoredRecovery.retry();
      expect(recoveryAct).toHaveBeenCalledOnce();
      expect(restoredRecovery.getStatus().attempts).toBe(1);
    }
  );

  it('checks both live and durable progress vetoes while task journal writes are pending', async () => {
    let now = Date.now();
    let marker: Awaited<ReturnType<TaskDependencies['observe']>>['marker'];
    const observation: RecoveryObservation = {
      activity: 'working',
      reason: 'turn-running',
      at: now,
      conversationId: flight.conversationId,
      submissionKey: 'pending-veto-submission',
      safeToAct: false,
    };
    vi.spyOn(CodexTaskAdapter.prototype, 'observe').mockImplementation(async () => ({
      observation,
      commands: new Map(),
      marker,
    }));
    const recoveryAct = vi.spyOn(CodexRecoveryAdapter.prototype, 'act').mockResolvedValue('sent');
    const id = 'pending-progress-veto-journal';
    const { task, taskDeps, recoveryDeps } = controllers(id);
    taskDeps.now = () => now;
    await task.update({
      objective: 'Keep the task veto durable',
      criteria: [{ id: 'review', description: 'Owner review', kind: 'manual' }],
      config: { enabled: true },
    });
    await task.progress({ outcome: 'unfinished', checkpoint: 'Previous checkpoint', nextAction: 'Previous action' });
    now++;
    marker = {
      key: 'pending-unknown-progress',
      at: now,
      submissionKey: observation.submissionKey,
      progress: { outcome: 'unknown' },
    };
    const originalPersist = taskDeps.persist;
    const entered = createDeferred();
    const release = createDeferred();
    taskDeps.persist = async (state) => {
      entered.resolve();
      await release.promise;
      await originalPersist(state);
    };
    const refreshing = task.refresh();
    await entered.promise;
    try {
      expect(task.getStatus()).toMatchObject({ phase: 'paused', agentProgressVeto: true });
      expect(internals.taskStore.get(id).agentProgressVeto).toBeUndefined();
      expect(await recoveryDeps.act(flight, () => true)).toBe('not-sent');
    } finally {
      release.resolve();
    }
    await refreshing;

    const clearingEntered = createDeferred();
    const clearingRelease = createDeferred();
    taskDeps.persist = async (state) => {
      clearingEntered.resolve();
      await clearingRelease.promise;
      await originalPersist(state);
    };
    task.noteUserInput();
    await clearingEntered.promise;
    try {
      expect(task.getStatus().agentProgressVeto).not.toBe(true);
      expect(internals.taskStore.get(id).agentProgressVeto).toBe(true);
      expect(await recoveryDeps.act(flight, () => true)).toBe('not-sent');
    } finally {
      clearingRelease.resolve();
    }
    await task.drain();
    taskDeps.persist = originalPersist;
    expect(internals.taskStore.get(id).agentProgressVeto).not.toBe(true);
    expect(await recoveryDeps.act(flight, () => true)).toBe('sent');
    expect(recoveryAct).toHaveBeenCalledOnce();
  });

  it('keeps a newly observed live agent veto when its journal write fails', async () => {
    let now = Date.now();
    let marker: Awaited<ReturnType<TaskDependencies['observe']>>['marker'];
    const observation: RecoveryObservation = {
      activity: 'working',
      reason: 'turn-running',
      at: now,
      conversationId: flight.conversationId,
      submissionKey: 'failed-save-submission',
      safeToAct: false,
    };
    vi.spyOn(CodexTaskAdapter.prototype, 'observe').mockImplementation(async () => ({
      observation,
      commands: new Map(),
      marker,
    }));
    const recoveryAct = vi.spyOn(CodexRecoveryAdapter.prototype, 'act').mockResolvedValue('sent');
    const id = 'failed-progress-veto-write';
    const { task, taskDeps, recoveryDeps } = controllers(id);
    taskDeps.now = () => now;
    await task.update({
      objective: 'Preserve uncertainty after a failed save',
      criteria: [{ id: 'review', description: 'Owner review', kind: 'manual' }],
      config: { enabled: true },
    });
    await task.progress({ outcome: 'unfinished', checkpoint: 'Earlier checkpoint', nextAction: 'Earlier action' });
    now++;
    marker = {
      key: 'failed-write-unknown-progress',
      at: now,
      submissionKey: observation.submissionKey,
      progress: { outcome: 'unknown' },
    };
    const originalPersist = taskDeps.persist;
    taskDeps.persist = async () => {
      throw new Error('Fixture journal write failure');
    };
    try {
      await expect(task.refresh()).rejects.toThrow('Task state could not be saved');
      expect(task.getStatus()).toMatchObject({
        phase: 'blocked',
        reason: 'persistence-failed',
        agentProgressVeto: true,
      });
      expect(internals.taskStore.get(id).agentProgressVeto).toBeUndefined();
      expect(await recoveryDeps.act(flight, () => true)).toBe('not-sent');
      expect(recoveryAct).not.toHaveBeenCalled();
    } finally {
      taskDeps.persist = originalPersist;
    }
    await task.reset();
    expect(await recoveryDeps.act(flight, () => true)).toBe('sent');
    expect(recoveryAct).toHaveBeenCalledOnce();
  });

  it.each(['unchanged', 'late-agent-veto'] as const)(
    'rechecks shared task authority after a delayed recovery reservation: %s',
    async (change) => {
      let now = Date.now();
      let marker: Awaited<ReturnType<TaskDependencies['observe']>>['marker'];
      const observation: RecoveryObservation = {
        activity: 'working',
        reason: 'turn-running',
        at: now,
        conversationId: flight.conversationId,
        submissionKey: 'late-task-veto-submission',
        safeToAct: false,
      };
      vi.spyOn(CodexTaskAdapter.prototype, 'observe').mockImplementation(async () => ({
        observation,
        commands: new Map(),
        marker,
      }));
      vi.spyOn(CodexRecoveryAdapter.prototype, 'observe').mockImplementation(async () => ({
        activity: 'crashed',
        reason: 'process-crashed',
        at: now,
        conversationId: flight.conversationId,
        evidenceKey: `late-task-veto-${change}`,
        safeToAct: true,
      }));
      const recoveryAct = vi.spyOn(CodexRecoveryAdapter.prototype, 'act').mockResolvedValue('sent');
      const { task, taskDeps, recovery, recoveryDeps } = controllers(`delayed-recovery-${change}`);
      taskDeps.now = recoveryDeps.now = () => now;
      await task.update({
        objective: 'The owner worker task',
        criteria: [{ id: 'review', description: 'Owner review', kind: 'manual' }],
        config: { enabled: false },
      });
      const originalPersist = recoveryDeps.persist;
      const entered = createDeferred();
      const release = createDeferred();
      recoveryDeps.persist = async (state) => {
        if (state.inFlight) {
          entered.resolve();
          await release.promise;
        }
        await originalPersist(state);
      };
      const retrying = recovery.retry();
      await entered.promise;
      try {
        if (change === 'late-agent-veto') {
          await task.update({ config: { enabled: true } });
          await task.progress({ outcome: 'unfinished', checkpoint: 'Owner checkpoint', nextAction: 'Owner action' });
          now++;
          marker = {
            key: 'late-unknown-agent-marker',
            at: now,
            submissionKey: observation.submissionKey,
            progress: { outcome: 'unknown' },
          };
          await task.refresh();
          await task.update({ config: { enabled: false } });
          expect(task.getStatus()).toMatchObject({ phase: 'disabled', agentProgressVeto: true });
        }
      } finally {
        release.resolve();
      }
      await retrying;
      recoveryDeps.persist = originalPersist;
      expect(recoveryAct).toHaveBeenCalledTimes(change === 'unchanged' ? 1 : 0);
      expect(recovery.getStatus()).toMatchObject({
        attempts: change === 'unchanged' ? 1 : 0,
        failedAttempts: 0,
        circuitOpen: false,
      });
      if (change === 'late-agent-veto') {
        expect(recovery.getStatus().inFlight).toBeUndefined();
        expect(recovery.getStatus().pending).toBeUndefined();
        expect(recovery.getStatus().windowStartedAt).toBeUndefined();
      }
    }
  );

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
    const taskAct = vi.spyOn(CodexTaskAdapter.prototype, 'act').mockResolvedValue('sent');
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
      phase: 'paused',
    });
    expect(task.getStatus().kickoffAt).toBeUndefined();
    await task.refresh();
    expect(taskAct).toHaveBeenCalledOnce();

    observe.mockResolvedValue({
      observation: {
        activity: 'idle',
        reason: 'observing',
        at: Date.now() + 2,
        conversationId: flight.conversationId,
        submissionKey: 'accepted-kickoff',
        processReady: true,
        safeToAct: false,
      },
      commands: new Map(),
    });
    await task.resume();
    expect(taskAct).toHaveBeenCalledTimes(2);
    expect(taskAct.mock.lastCall?.[2]).toContain('Review the follow-up work');
    expect(task.getStatus()).toMatchObject({
      phase: 'watching',
      reason: 'kickoff-sent',
      inFlight: { previousSubmissionKey: 'accepted-kickoff' },
    });
    expect(task.getStatus().inFlight?.promptHash).not.toBe(pending.promptHash);
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

  it('attributes a restored bare reservation to its exclusive durable recovery flight', async () => {
    const id = 'legacy-exclusive-recovery';
    await persistLegacyReservation(id, { task: false, recovery: true });
    const taskAct = vi.spyOn(CodexTaskAdapter.prototype, 'act').mockResolvedValue('sent');
    const { task, recovery, taskDeps } = controllers(id);

    await task.reset();
    expect(await taskDeps.act('new-task', flight.conversationId, 'continue', () => true)).toBe('not-sent');
    expect(taskAct).not.toHaveBeenCalled();
    await recovery.reset();
    expect(await taskDeps.act('new-task', flight.conversationId, 'continue', () => true)).toBe('sent');
    expect(taskAct).toHaveBeenCalledOnce();
  });

  it.each([
    ['task', true],
    ['task', false],
    ['recovery', true],
    ['recovery', false],
  ] as const)(
    'preserves a bare reservation with an unreadable %s journal and opposite flight %s',
    async (failedOwner, oppositeFlight) => {
      const id = `corrupt-${failedOwner}-${oppositeFlight}`;
      const unreservedId = `${id}-unreserved`;
      const root = await mkdtemp(join(homedir(), 'task-recovery-corrupt-'));
      const taskPath = join(root, 'tasks.json');
      const recoveryPath = join(root, 'recovery.json');
      const failedPath = failedOwner === 'task' ? taskPath : recoveryPath;
      const corruptBytes = '{"version":1,"sessions":';
      await writeFile(failedPath, corruptBytes);
      const original = {
        taskStore: internals.taskStore,
        recoveryStore: internals.recoveryStore,
        actionReservationStore: internals.actionReservationStore,
      };
      internals.taskStore = new TaskStore(taskPath);
      internals.recoveryStore = new RecoveryStore(recoveryPath);
      internals.actionReservationStore = new TaskStore(join(root, 'action-reservations.json'));
      expect(failedOwner === 'task' ? internals.taskStore.loadFailed : internals.recoveryStore.loadFailed).toBe(true);
      try {
        if (failedOwner === 'task') {
          const state = initialRecoveryState();
          if (oppositeFlight) state.inFlight = { ...flight, startedAt: Date.now() };
          await internals.recoveryStore.save(id, state);
        } else {
          const state = initialTaskState();
          if (oppositeFlight) state.inFlight = { key: 'old-task-flight', startedAt: 1 };
          await internals.taskStore.save(id, state);
        }
        const reservation = initialTaskState();
        reservation.inFlight = { key: 'bare-legacy-reservation', startedAt: 1 };
        await internals.actionReservationStore.save(id, reservation);
        const taskAct = vi.spyOn(CodexTaskAdapter.prototype, 'act').mockResolvedValue('sent');
        const recoveryAct = vi.spyOn(CodexRecoveryAdapter.prototype, 'act').mockResolvedValue('sent');
        const { task, recovery, taskDeps, recoveryDeps } = controllers(id);
        internals.getActionArbiter(id);
        const readable = failedOwner === 'task' ? recovery : task;
        const unreadable = failedOwner === 'task' ? task : recovery;

        await readable.reset();
        expect(internals.actionReservationStore.get(id).inFlight?.key).toBe('bare-legacy-reservation');
        await expect(unreadable.reset()).rejects.toThrow('could not be saved');
        expect(internals.actionReservationStore.get(id).inFlight?.key).toBe('bare-legacy-reservation');
        expect(await taskDeps.act('new-task', flight.conversationId, 'continue', () => true)).toBe('not-sent');
        expect(await recoveryDeps.act(flight, () => true)).toBe('not-sent');
        // An unreadable opposite journal also vetoes dispatch when no shared key is retained.
        const unreserved = controllers(unreservedId);
        expect(
          await (failedOwner === 'task'
            ? unreserved.recoveryDeps.act(flight, () => true)
            : unreserved.taskDeps.act('new-task', flight.conversationId, 'continue', () => true))
        ).toBe('not-sent');
        expect(taskAct).not.toHaveBeenCalled();
        expect(recoveryAct).not.toHaveBeenCalled();
        expect(await readFile(failedPath, 'utf8')).toBe(corruptBytes);
      } finally {
        await internals.stopRecoveryController(id, false);
        await internals.stopRecoveryController(unreservedId, false);
        internals.sessions.delete(id);
        internals.sessions.delete(unreservedId);
        ids.delete(id);
        ids.delete(unreservedId);
        Object.assign(internals, original);
      }
    }
  );

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
