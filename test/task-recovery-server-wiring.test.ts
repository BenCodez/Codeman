/** @fileoverview Integration coverage for WebServer's shared task/recovery action boundary. */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { Session } from '../src/session.js';
import { TmuxManager } from '../src/tmux-manager.js';
import {
  TaskConfigurationCancelledError,
  TaskController,
  type TaskDependencies,
} from '../src/supervision/controller.js';
import { CodexTaskAdapter } from '../src/supervision/adapter.js';
import { RecoveryController, type RecoveryDependencies } from '../src/recovery/controller.js';
import { CodexRecoveryAdapter } from '../src/recovery/codex-adapter.js';
import { initialTaskState } from '../src/supervision/schema.js';
import { TaskStore } from '../src/supervision/store.js';
import { RecoveryStore } from '../src/recovery/store.js';
import { SessionActionArbiter, sessionActionKey } from '../src/supervision/action-arbiter.js';
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
  const session = new Session({
    id,
    workingDir: process.cwd(),
    mode: 'codex',
    useMux: true,
    codexConfig: { noDaemon: true },
  });
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

beforeAll(async () => {
  vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);
  // This suite isolates arbitration; real envelope admission has dedicated broker/adapter coverage.
  vi.spyOn(CodexTaskAdapter.prototype, 'admitPrompt').mockResolvedValue(true);
  server = new WebServer(0, false, true);
  internals = server as unknown as ServerInternals;
  await Reflect.get(server, 'setupRoutes').call(server);
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
  it.each([true, false])(
    'binds uncertain remote restoration to its exact flight and fresh acceptance (%s)',
    async (fresh) => {
      let observation: RecoveryObservation = {
        activity: 'unknown',
        reason: 'remote-session-missing',
        at: Date.now(),
        conversationId: flight.conversationId,
        safeToAct: false,
      };
      const observe = vi.spyOn(CodexRecoveryAdapter.prototype, 'observe').mockImplementation(async () => observation);
      const restore = vi.spyOn(CodexRecoveryAdapter.prototype, 'restoreMissingRemote').mockResolvedValue('unknown');
      const act = vi.spyOn(CodexRecoveryAdapter.prototype, 'act').mockResolvedValue('sent');
      const id = `remote-restore-acceptance-${fresh}`;
      const { recovery, recoveryDeps } = controllers(id);
      try {
        await recovery.restoreMissingRemote();
        const pending = recovery.getStatus().inFlight!;
        expect(pending.action).toBe('restart');
        expect(internals.actionReservationStore.get(id).inFlight?.key).toBe(sessionActionKey('recovery', pending.key));
        observation = {
          activity: 'idle',
          reason: 'observing',
          at: 1,
          conversationId: flight.conversationId,
          processReady: true,
          processReadyAt: fresh ? Date.now() : undefined,
          safeToAct: false,
        };
        await recovery.inspect();
        expect(restore).toHaveBeenCalledOnce();
        expect(!!recovery.getStatus().inFlight).toBe(!fresh);
        expect(!!internals.actionReservationStore.get(id).inFlight).toBe(!fresh);
        expect(await recoveryDeps.act(flight, () => true)).toBe(fresh ? 'sent' : 'not-sent');
        expect(act).toHaveBeenCalledTimes(fresh ? 1 : 0);
        if (fresh) await expect(recovery.reset()).resolves.toMatchObject({ lastReason: 'manual-reset' });
        else {
          const retained = recovery.getStatus();
          const journal = internals.recoveryStore.get(id);
          const reservation = internals.actionReservationStore.get(id);
          await expect(recovery.reset()).rejects.toThrow('Recovery delivery is still unverified');
          expect(recovery.getStatus()).toEqual(retained);
          expect(internals.recoveryStore.get(id)).toEqual(journal);
          expect(internals.actionReservationStore.get(id)).toEqual(reservation);
          expect(await recoveryDeps.act(flight, () => true)).toBe('not-sent');
          expect(act).not.toHaveBeenCalled();
        }
      } finally {
        observe.mockRestore();
        restore.mockRestore();
        act.mockRestore();
      }
    }
  );
  it.each([
    ['local', {}, true],
    ['daemon', { codexConfig: { noDaemon: false } }, false],
    ['default daemon', { codexConfig: undefined }, false],
    ['discovered', { discoveredMuxSession: true }, false],
    ['direct PTY', { useMux: false }, false],
    ['docker', { docker: { containerId: 'fixture' } }, false],
    ['owned SSH', { remote: { owned: true, host: 'fixture.invalid', remotePath: '/fixture' } }, true],
    ['implicit owned SSH', { remote: { host: 'fixture.invalid', remotePath: '/fixture' } }, true],
    ['unowned SSH', { remote: { owned: false, host: 'fixture.invalid', remotePath: '/fixture' } }, false],
  ] as const)('creates layer4 task workflows only for local or owned SSH %s', async (_kind, location, supported) => {
    const id = `task-location-${_kind.replaceAll(' ', '-')}`;
    ids.add(id);
    const session = new Session({
      id,
      mode: 'codex',
      workingDir: process.cwd(),
      useMux: true,
      codexConfig: { noDaemon: true },
      ...location,
    });
    internals.sessions.set(id, session);
    const controller = internals.getTaskController(session);
    expect(controller !== undefined).toBe(supported);
    expect(session.toLightDetailedState().taskSupported).toBe(supported);
    const app = Reflect.get(server, 'app') as FastifyInstance;
    const status = await app.inject({ method: 'GET', url: `/api/sessions/${id}/task` });
    expect(status.statusCode).toBe(supported ? 200 : 400);
    if (!supported) {
      const enable = await app.inject({
        method: 'PUT',
        url: `/api/sessions/${id}/task`,
        payload: { config: { enabled: true } },
      });
      expect(enable.statusCode).toBe(400);
      expect(enable.json().error).toContain('unsupported');
      expect(internals.taskStore.get(id)).toEqual(initialTaskState());
    }
  });

  it.each([false, true])(
    'forwards delegated configuration authority to the real journal (current=%s)',
    async (currentAtCommit) => {
      const id = `task-configuration-authority-${currentAtCommit}`;
      const { task } = controllers(id);
      await task.update({
        objective: 'Owner objective',
        criteria: [{ id: 'owner', description: 'Owner review', kind: 'manual' }],
      });
      const original = task.getStatus();
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const save = internals.taskStore.save.bind(internals.taskStore);
      const saving = vi
        .spyOn(internals.taskStore, 'save')
        .mockImplementationOnce(async (sessionId, state, authority) => {
          entered.resolve();
          await release.promise;
          return save(sessionId, state, authority);
        });
      let current = true;
      try {
        const updating = task.update(
          {
            objective: 'Delegated objective',
            criteria: [{ id: 'delegated', description: 'Delegated review', kind: 'manual' }],
          },
          () => current
        );
        // Attach the rejection observer before releasing the real asynchronous write.
        const settled = updating.then(
          (value) => ({ value }),
          (error) => ({ error })
        );
        await entered.promise;
        expect(task.getStatus()).toEqual(original);
        current = currentAtCommit;
        release.resolve();
        const result = await settled;
        expect(saving.mock.calls[0]?.[2]?.isCurrent).toBeTypeOf('function');
        if (currentAtCommit) {
          expect(result).toHaveProperty('value.objective', 'Delegated objective');
          expect(task.getStatus().objective).toBe('Delegated objective');
          expect(new TaskStore().get(id).objective).toBe('Delegated objective');
        } else {
          expect(result).toHaveProperty('error');
          expect('error' in result && result.error).toBeInstanceOf(TaskConfigurationCancelledError);
          expect(task.getStatus()).toEqual(original);
          expect(new TaskStore().get(id)).toEqual(original);
        }
      } finally {
        release.resolve();
        saving.mockRestore();
      }
    }
  );

  it.each(['sent', 'unknown'] as const)(
    'keeps both task restart fences after %s until fresh readiness, including owner completion and reload',
    async (result) => {
      const id = `task-restart-fence-${result}`;
      let now = Date.now();
      const crashKey = `${id}-crash`;
      let observation: RecoveryObservation = {
        activity: 'crashed',
        reason: 'process-crashed',
        at: now,
        liveProofAt: now,
        conversationId: flight.conversationId,
        evidenceKey: crashKey,
        safeToAct: true,
        processReady: false,
      };
      vi.spyOn(CodexTaskAdapter.prototype, 'observe').mockImplementation(async () => ({
        observation,
        commands: new Map(),
      }));
      const restart = vi.spyOn(CodexTaskAdapter.prototype, 'recover').mockResolvedValue(result);
      const recoveryAct = vi.spyOn(CodexRecoveryAdapter.prototype, 'act').mockResolvedValue('sent');
      const { task, taskDeps, recoveryDeps } = controllers(id);
      taskDeps.now = () => now;
      await task.update({
        objective: 'Finish the task',
        criteria: [{ id: 'review', description: 'Owner review', kind: 'manual' }],
        config: { enabled: true },
      });
      await task.progress({ outcome: 'unfinished', checkpoint: 'Verified step', nextAction: 'Next step' });
      await task.refresh();
      const reserved = task.getStatus().inFlight!;
      expect(reserved).toMatchObject({ action: 'restart', key: crashKey });
      const commonKey = sessionActionKey('task', crashKey);
      expect(new TaskStore().get(id).inFlight?.key).toBe(crashKey);
      expect(internals.actionReservationStore.get(id).inFlight?.key).toBe(commonKey);

      // An owned respawn/PID and manual completion do not establish native Codex readiness.
      observation = { ...observation, activity: 'completed', reason: 'turn-completed', processReady: true, at: ++now };
      await task.progress({ outcome: 'completed', verifiedCriteria: ['review'] });
      expect(task.getStatus().inFlight?.accepted).toBeUndefined();
      expect(internals.actionReservationStore.get(id).inFlight?.key).toBe(commonKey);
      expect(await recoveryDeps.act(flight, () => true)).toBe('not-sent');
      expect(recoveryAct).not.toHaveBeenCalled();

      const session = internals.sessions.get(id)!;
      await internals.stopRecoveryController(id, false);
      const restored = internals.getTaskController(session)!;
      const restoredDeps = (restored as unknown as TaskControllerInternals).deps;
      restoredDeps.now = () => now;
      expect(restored.getStatus().inFlight).toMatchObject(reserved);
      await restored.progress({ outcome: 'completed' });
      expect(internals.actionReservationStore.get(id).inFlight?.key).toBe(commonKey);
      observation = { ...observation, processReadyAt: ++now };
      await restored.progress({ outcome: 'completed' });
      expect(restored.getStatus().inFlight).toBeUndefined();
      expect(internals.actionReservationStore.get(id).inFlight).toBeUndefined();
      expect(new TaskStore().get(id).inFlight).toBeUndefined();
      const nextRecovery = internals.getRecoveryController(session)!;
      const nextDeps = (nextRecovery as unknown as RecoveryControllerInternals).deps;
      expect(await nextDeps.act(flight, () => true)).toBe('sent');
      expect(restart).toHaveBeenCalledOnce();
      expect(recoveryAct).toHaveBeenCalledOnce();
    }
  );

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

  it.each(['crashed', 'interrupted'] as const)(
    'defers sibling recovery while a supervised task owns a pre-marker %s',
    async (activity) => {
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
      const { task, recovery } = controllers(`task-premarker-${activity}`);
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
        activity,
        liveProofAt: Date.now(),
        reason: activity === 'crashed' ? ('process-crashed' as const) : ('turn-interrupted' as const),
        at: Date.now() + 1000,
        conversationId: flight.conversationId,
        evidenceKey: `premarker-${activity}`,
        processReady: activity === 'interrupted',
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
    }
  );

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

  it.each(
    (['unknown', 'blocked'] as const).flatMap((outcome) =>
      (['crashed', 'interrupted'] as const).map((activity) => ({ outcome, activity }))
    )
  )(
    'retains owner $outcome against sibling $activity recovery through settings and reload',
    async ({ outcome, activity }) => {
      let now = Date.now();
      vi.spyOn(CodexTaskAdapter.prototype, 'observe').mockImplementation(async () => ({
        observation: {
          activity: 'working',
          reason: 'turn-running',
          at: now,
          conversationId: flight.conversationId,
          submissionKey: 'owner-veto-submission',
          safeToAct: false,
        },
        commands: new Map(),
      }));
      vi.spyOn(CodexRecoveryAdapter.prototype, 'observe').mockImplementation(async () => ({
        activity,
        reason: activity === 'crashed' ? 'process-crashed' : 'turn-interrupted',
        at: now,
        conversationId: flight.conversationId,
        evidenceKey: `owner-${outcome}-${activity}`,
        safeToAct: true,
      }));
      const act = vi.spyOn(CodexRecoveryAdapter.prototype, 'act').mockResolvedValue('sent');
      const id = `owner-progress-veto-${outcome}-${activity}`;
      const { task, taskDeps, recovery, recoveryDeps } = controllers(id);
      taskDeps.now = recoveryDeps.now = () => now;
      await task.update({
        objective: 'Keep owner uncertainty authoritative',
        criteria: [{ id: 'review', description: 'Owner acceptance', kind: 'manual' }],
        config: { enabled: true },
      });
      await task.progress({ outcome: 'unfinished', checkpoint: 'Previous work', nextAction: 'Continue' });
      await recovery.updateConfig({ enabled: true });
      await task.progress({ outcome, checkpoint: 'Owner needs inspection' });
      await recovery.refresh();
      now += 2000;
      await recovery.refresh();
      await recovery.retry();
      expect(recovery.getStatus()).toMatchObject({ attempts: 0, failedAttempts: 0, circuitOpen: false });
      expect(recovery.getStatus().inFlight).toBeUndefined();
      expect(act).not.toHaveBeenCalled();
      expect(task.getStatus()).toMatchObject({
        outcome,
        phase: outcome === 'blocked' ? 'blocked' : 'paused',
        agentProgressVeto: true,
        continuations: 0,
      });
      expect(new TaskStore().get(id).agentProgressVeto).toBe(true);
      await task.update({ config: { maxContinuations: 1, enabled: false } });
      await task.update({ config: { enabled: true } });
      await task.pause();
      expect(task.getStatus().agentProgressVeto).toBe(true);
      const session = internals.sessions.get(id)!;
      await internals.stopRecoveryController(id, false);
      const restoredTask = internals.getTaskController(session)!;
      const restoredRecovery = internals.getRecoveryController(session)!;
      (restoredTask as unknown as TaskControllerInternals).deps.now = () => now;
      (restoredRecovery as unknown as RecoveryControllerInternals).deps.now = () => now;
      expect(restoredTask.getStatus().agentProgressVeto).toBe(true);
      expect(new TaskStore().get(id).agentProgressVeto).toBe(true);
      await restoredRecovery.retry();
      expect(restoredRecovery.getStatus().attempts).toBe(0);
      expect(act).not.toHaveBeenCalled();
      // Supported owner actions release the veto only after their journal ACK.
      if (outcome === 'unknown') {
        restoredTask.noteUserInput();
        await restoredTask.drain();
      } else await restoredTask.reset();
      expect(internals.taskStore.get(id).agentProgressVeto).toBeUndefined();
      await restoredRecovery.retry();
      expect(act).toHaveBeenCalledOnce();
      expect(restoredRecovery.getStatus().attempts).toBe(1);
    }
  );

  it.each(['unknown', 'blocked'] as const)(
    'does not auto-complete an owner %s report from older verified criteria',
    async (outcome) => {
      vi.spyOn(CodexTaskAdapter.prototype, 'observe').mockResolvedValue({
        observation: {
          activity: 'idle',
          reason: 'observing',
          at: Date.now(),
          conversationId: flight.conversationId,
          processReady: true,
          safeToAct: false,
        },
        commands: new Map(),
      });
      const act = vi.spyOn(CodexRecoveryAdapter.prototype, 'act').mockResolvedValue('sent');
      const id = `owner-completed-then-${outcome}`;
      const { task, recoveryDeps } = controllers(id);
      await task.update({
        objective: 'Acceptance does not erase later owner uncertainty',
        criteria: [{ id: 'review', description: 'Owner acceptance', kind: 'manual' }],
      });
      await task.progress({ outcome: 'completed', verifiedCriteria: ['review'] });
      expect(task.getStatus()).toMatchObject({ outcome: 'completed', phase: 'completed' });
      await task.progress({ outcome });
      await task.update({ config: { enabled: true } });
      expect(task.getStatus()).toMatchObject({ outcome, agentProgressVeto: true });
      expect(task.getStatus().criteria[0].verified).toBe(true);
      expect(await recoveryDeps.act(flight, () => true)).toBe('not-sent');
      expect(act).not.toHaveBeenCalled();
      // A fresh explicit completion remains supported with the original evidence.
      await task.progress({ outcome: 'completed' });
      expect(task.getStatus()).toMatchObject({ outcome: 'completed', phase: 'completed' });
      expect(task.getStatus().agentProgressVeto).toBeUndefined();
      expect(await recoveryDeps.act(flight, () => true)).toBe('sent');
      expect(act).toHaveBeenCalledOnce();
    }
  );

  it.each(['unknown', 'blocked'] as const)(
    'retains live owner %s before and after a failed task journal ACK',
    async (outcome) => {
      vi.spyOn(CodexTaskAdapter.prototype, 'observe').mockResolvedValue({
        observation: {
          activity: 'working',
          reason: 'turn-running',
          at: Date.now(),
          conversationId: flight.conversationId,
          safeToAct: false,
        },
        commands: new Map(),
      });
      const act = vi.spyOn(CodexRecoveryAdapter.prototype, 'act').mockResolvedValue('sent');
      const id = `owner-progress-failed-ack-${outcome}`;
      const { task, taskDeps, recoveryDeps } = controllers(id);
      await task.update({
        objective: 'A missing ACK does not authorize sibling recovery',
        criteria: [{ id: 'review', description: 'Owner acceptance', kind: 'manual' }],
        config: { enabled: true },
      });
      const persist = taskDeps.persist;
      const entered = createDeferred();
      const release = createDeferred();
      taskDeps.persist = async () => {
        entered.resolve();
        await release.promise;
        throw new Error('Fixture failed journal ACK');
      };
      const reporting = task.progress({ outcome });
      const settled = reporting.then(
        () => undefined,
        (error: unknown) => error
      );
      await entered.promise;
      try {
        expect(task.getStatus().agentProgressVeto).toBe(true);
        expect(internals.taskStore.get(id).agentProgressVeto).toBeUndefined();
        expect(await recoveryDeps.act(flight, () => true)).toBe('not-sent');
      } finally {
        release.resolve();
      }
      expect(await settled).toBeInstanceOf(Error);
      taskDeps.persist = persist;
      expect(task.getStatus()).toMatchObject({
        phase: 'blocked',
        reason: 'persistence-failed',
        agentProgressVeto: true,
      });
      expect(await recoveryDeps.act(flight, () => true)).toBe('not-sent');
      expect(act).not.toHaveBeenCalled();
      // An acknowledged owner reset repairs this exact live refusal.
      await task.reset();
      expect(await recoveryDeps.act(flight, () => true)).toBe('sent');
      expect(act).toHaveBeenCalledOnce();
    }
  );

  it.each([false, true])('keeps owner uncertainty after an existing delivery is accepted=%s', async (accepted) => {
    let now = Date.now();
    let observation: RecoveryObservation = {
      activity: 'idle',
      reason: 'observing',
      at: now,
      conversationId: flight.conversationId,
      submissionKey: 'before-owner-veto-kickoff',
      processReady: true,
      safeToAct: false,
    };
    vi.spyOn(CodexTaskAdapter.prototype, 'observe').mockImplementation(async () => ({
      observation,
      commands: new Map(),
    }));
    const kickoff = vi.spyOn(CodexTaskAdapter.prototype, 'act').mockResolvedValue('unknown');
    const act = vi.spyOn(CodexRecoveryAdapter.prototype, 'act').mockResolvedValue('sent');
    const id = `owner-veto-delivery-${accepted}`;
    const { task, taskDeps, recoveryDeps } = controllers(id);
    taskDeps.now = () => now;
    await task.update({
      objective: 'Unknown progress must outlive reservation cleanup',
      criteria: [{ id: 'review', description: 'Owner acceptance', kind: 'manual' }],
    });
    await task.resume();
    const pending = task.getStatus().inFlight!;
    expect(pending.promptHash).toBeDefined();
    expect(internals.actionReservationStore.get(id).inFlight).toBeDefined();
    observation = {
      ...observation,
      activity: 'working',
      reason: 'turn-running',
      at: ++now,
      ...(accepted ? { submissionKey: 'accepted-owner-veto-kickoff', submissionHash: pending.promptHash } : {}),
    };
    await task.progress({ outcome: 'unknown' });
    expect(task.getStatus()).toMatchObject({ outcome: 'unknown', agentProgressVeto: true, continuations: 0 });
    expect(kickoff).toHaveBeenCalledOnce();
    if (accepted) {
      // The common flight is gone: the progress veto alone must deny recovery.
      expect(task.getStatus().inFlight).toBeUndefined();
      expect(internals.actionReservationStore.get(id).inFlight).toBeUndefined();
    } else {
      expect(task.getStatus().inFlight?.key).toBe(pending.key);
      expect(internals.actionReservationStore.get(id).inFlight).toBeDefined();
    }
    expect(new TaskStore().get(id).agentProgressVeto).toBe(true);
    expect(await recoveryDeps.act(flight, () => true)).toBe('not-sent');
    expect(act).not.toHaveBeenCalled();
  });

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

  it.each(['task-veto', 'worker-failure', 'worker-failure-late-veto', 'cleanup-unknown'] as const)(
    'retains the certified final veto across asynchronous common cleanup: %s',
    async (result) => {
      const id = `final-task-veto-cleanup-${result}`;
      const workerFailure = result === 'worker-failure' || result === 'worker-failure-late-veto';
      const now = Date.now();
      vi.spyOn(CodexRecoveryAdapter.prototype, 'observe').mockResolvedValue({
        activity: 'crashed',
        reason: 'process-crashed',
        at: now,
        conversationId: flight.conversationId,
        evidenceKey: id,
        safeToAct: true,
      });
      const worker = vi.spyOn(CodexRecoveryAdapter.prototype, 'act').mockResolvedValue('not-sent');
      const { task, recovery, recoveryDeps } = controllers(id);
      recoveryDeps.now = () => now;
      await task.update({
        objective: 'Preserve task ownership at the final action boundary',
        criteria: [{ id: 'review', description: 'Owner review', kind: 'manual' }],
        config: { enabled: false },
      });
      await recovery.updateConfig({ maxRetries: 1 });
      const reservationEntered = createDeferred();
      const reservationRelease = createDeferred();
      const cleanupEntered = createDeferred();
      const cleanupRelease = createDeferred();
      const save = internals.actionReservationStore.save.bind(internals.actionReservationStore);
      const saving = vi.spyOn(internals.actionReservationStore, 'save').mockImplementation(async (key, state) => {
        if (key === id) {
          if (state.inFlight) {
            reservationEntered.resolve();
            await reservationRelease.promise;
          } else {
            cleanupEntered.resolve();
            await cleanupRelease.promise;
            if (result === 'cleanup-unknown') throw new Error('Fixture common cleanup uncertain');
          }
        }
        await save(key, state);
      });
      const retrying = recovery.retry();
      try {
        await reservationEntered.promise;
        if (!workerFailure) {
          await task.update({ config: { enabled: true } });
          expect(task.getStatus().phase).toBe('watching');
        }
        reservationRelease.resolve();
        await cleanupEntered.promise;
        // The task veto is no longer present by the time the adapter result
        // traverses the common arbiter's asynchronous durable cleanup.
        if (workerFailure) await task.update({ config: { enabled: true } });
        if (result !== 'worker-failure-late-veto') await task.pause();
        expect(task.getStatus().phase).toBe(result === 'worker-failure-late-veto' ? 'watching' : 'paused');
        cleanupRelease.resolve();
        await retrying;
        expect(worker).toHaveBeenCalledTimes(workerFailure ? 1 : 0);
        if (result === 'task-veto') {
          expect(recovery.getStatus()).toMatchObject({ attempts: 0, failedAttempts: 0, circuitOpen: false });
          expect(recovery.getStatus().inFlight).toBeUndefined();
          expect(recovery.getStatus().windowStartedAt).toBeUndefined();
          expect(internals.actionReservationStore.get(id).inFlight).toBeUndefined();
          // The sole retry remains available once the supervising task releases ownership.
          worker.mockResolvedValueOnce('sent');
          await recovery.retry();
          expect(worker).toHaveBeenCalledOnce();
          expect(recovery.getStatus().attempts).toBe(1);
        } else {
          expect(recovery.getStatus()).toMatchObject({ attempts: 1, failedAttempts: 1 });
          if (workerFailure) {
            expect(recovery.getStatus()).toMatchObject({ lastReason: 'delivery-failed', circuitOpen: true });
            expect(recovery.getStatus().inFlight).toBeUndefined();
          } else {
            expect(recovery.getStatus()).toMatchObject({ lastReason: 'acceptance-unverified' });
            expect(recovery.getStatus().inFlight).toBeDefined();
            expect(internals.actionReservationStore.get(id).inFlight).toBeDefined();
          }
        }
      } finally {
        reservationRelease.resolve();
        cleanupRelease.resolve();
        await retrying;
        saving.mockRestore();
      }
    }
  );

  it('retains an unknown partial delivery even when the task veto was observed and then withdrawn', async () => {
    const id = 'partial-task-veto-recovery';
    vi.spyOn(CodexRecoveryAdapter.prototype, 'observe').mockResolvedValue({
      activity: 'crashed',
      reason: 'process-crashed',
      at: Date.now(),
      conversationId: flight.conversationId,
      evidenceKey: id,
      safeToAct: true,
    });
    const { task, recovery } = controllers(id);
    await task.update({
      objective: 'Do not replay partial input',
      criteria: [{ id: 'review', description: 'Owner review', kind: 'manual' }],
      config: { enabled: false },
    });
    await recovery.updateConfig({ maxRetries: 1 });
    const authorityChecks: boolean[] = [];
    const worker = vi.spyOn(CodexRecoveryAdapter.prototype, 'act').mockImplementation(async (_flight, isCurrent) => {
      // Model bytes already delivered before a later owner/task change.
      await task.update({ config: { enabled: true } });
      authorityChecks.push(isCurrent());
      await task.pause();
      authorityChecks.push(isCurrent());
      return 'unknown';
    });
    await recovery.retry();
    expect(worker).toHaveBeenCalledOnce();
    expect(authorityChecks).toEqual([false, false]);
    expect(recovery.getStatus()).toMatchObject({ attempts: 1, failedAttempts: 1, lastReason: 'acceptance-unverified' });
    expect(recovery.getStatus().inFlight).toBeDefined();
    expect(internals.actionReservationStore.get(id).inFlight).toBeDefined();
    await recovery.retry();
    expect(worker).toHaveBeenCalledOnce();
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

  it('shares the recovery reservation and task phase guards for missing remote restoration', async () => {
    const observe = vi.spyOn(CodexRecoveryAdapter.prototype, 'observe').mockResolvedValue({
      activity: 'unknown',
      reason: 'remote-session-missing',
      at: Date.now(),
      conversationId: flight.conversationId,
      safeToAct: false,
    });
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
    const restore = vi.spyOn(CodexRecoveryAdapter.prototype, 'restoreMissingRemote').mockResolvedValue('unknown');
    const taskAct = vi.spyOn(CodexTaskAdapter.prototype, 'act').mockResolvedValue('sent');
    const id = 'remote-restore-action-boundary';
    const { task, taskDeps, recovery } = controllers(id);
    await task.update({
      objective: 'Verify remote work',
      criteria: [{ id: 'review', description: 'Owner review', kind: 'manual' }],
      config: { enabled: true },
    });
    await recovery.restoreMissingRemote();
    expect(recovery.getStatus().inFlight).toBeUndefined();
    expect(restore).not.toHaveBeenCalled();
    await task.pause();
    await recovery.restoreMissingRemote();
    expect(recovery.getStatus().inFlight).toBeDefined();
    expect(restore).toHaveBeenCalledOnce();
    await task.reset();
    expect(await taskDeps.act('task-key', flight.conversationId, 'continue', () => true)).toBe('not-sent');
    expect(taskAct).not.toHaveBeenCalled();
    const retained = recovery.getStatus();
    const journal = internals.recoveryStore.get(id);
    const reservation = internals.actionReservationStore.get(id);
    await expect(recovery.reset()).rejects.toThrow('Recovery delivery is still unverified');
    expect(recovery.getStatus()).toEqual(retained);
    expect(internals.recoveryStore.get(id)).toEqual(journal);
    expect(internals.actionReservationStore.get(id)).toEqual(reservation);
    expect(await taskDeps.act('task-key', flight.conversationId, 'continue', () => true)).toBe('not-sent');
    expect(taskAct).not.toHaveBeenCalled();

    observe.mockResolvedValue({
      activity: 'idle',
      reason: 'observing',
      at: Date.now(),
      conversationId: flight.conversationId,
      processReady: true,
      processReadyAt: Date.now(),
      safeToAct: false,
    });
    await recovery.inspect();
    expect(recovery.getStatus().inFlight).toBeUndefined();
    expect(internals.actionReservationStore.get(id).inFlight).toBeUndefined();
    await expect(recovery.reset()).resolves.toMatchObject({ lastReason: 'manual-reset' });
    expect(await taskDeps.act('task-key', flight.conversationId, 'continue', () => true)).toBe('sent');
    expect(taskAct).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledOnce();
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
    const retainedRecovery = recovery.getStatus();
    const retainedJournal = internals.recoveryStore.get(id);
    const retainedReservation = internals.actionReservationStore.get(id);

    await task.reset();
    expect(await taskDeps.act('new-task', flight.conversationId, 'continue', () => true)).toBe('not-sent');
    expect(taskAct).not.toHaveBeenCalled();
    await expect(recovery.reset()).rejects.toThrow('Recovery delivery is still unverified');
    expect(recovery.getStatus()).toEqual(retainedRecovery);
    expect(internals.recoveryStore.get(id)).toEqual(retainedJournal);
    expect(internals.actionReservationStore.get(id)).toEqual(retainedReservation);
    expect(await taskDeps.act('new-task', flight.conversationId, 'continue', () => true)).toBe('not-sent');
    expect(taskAct).not.toHaveBeenCalled();
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

        if (failedOwner === 'task' && oppositeFlight) {
          const retained = recovery.getStatus();
          const journal = internals.recoveryStore.get(id);
          await expect(readable.reset()).rejects.toThrow('Recovery delivery is still unverified');
          expect(recovery.getStatus()).toEqual(retained);
          expect(internals.recoveryStore.get(id)).toEqual(journal);
        } else await readable.reset();
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

  it('keeps an ambiguous restored bare reservation while recovery delivery remains unverified', async () => {
    const id = 'legacy-ambiguous-flights';
    await persistLegacyReservation(id, { task: true, recovery: true });
    const taskAct = vi.spyOn(CodexTaskAdapter.prototype, 'act').mockResolvedValue('sent');
    const { task, taskDeps, recovery } = controllers(id);
    internals.getActionArbiter(id);
    const retainedRecovery = recovery.getStatus();
    const retainedJournal = internals.recoveryStore.get(id);
    const retainedReservation = internals.actionReservationStore.get(id);

    await expect(recovery.reset()).rejects.toThrow('Recovery delivery is still unverified');
    expect(await taskDeps.act('new-task', flight.conversationId, 'continue', () => true)).toBe('not-sent');
    expect(taskAct).not.toHaveBeenCalled();
    await task.reset();
    expect(task.getStatus().inFlight).toBeUndefined();
    await expect(recovery.reset()).rejects.toThrow('Recovery delivery is still unverified');
    expect(recovery.getStatus()).toEqual(retainedRecovery);
    expect(internals.recoveryStore.get(id)).toEqual(retainedJournal);
    expect(internals.actionReservationStore.get(id)).toEqual(retainedReservation);
    expect(await taskDeps.act('new-task', flight.conversationId, 'continue', () => true)).toBe('not-sent');
    expect(taskAct).not.toHaveBeenCalled();
  });
});
