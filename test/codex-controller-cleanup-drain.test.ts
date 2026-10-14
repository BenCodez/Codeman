/** Real controllers, arbiter and isolated journals; deferred fake receipts, no pane effects. */
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { Session } from '../src/session.js';
import { StateStore } from '../src/state-store.js';
import { RecoveryStore } from '../src/recovery/store.js';
import { RecoveryController } from '../src/recovery/controller.js';
import { initialRecoveryState } from '../src/recovery/types.js';
import { TaskStore } from '../src/supervision/store.js';
import { SupervisorStore } from '../src/supervisor/store.js';
import { TaskController } from '../src/supervision/controller.js';
import { initialTaskState } from '../src/supervision/schema.js';
import type { SessionActionArbiter, SessionActionOwner } from '../src/supervision/action-arbiter.js';
import { createDeferred } from './mocks/index.js';

const ID = 'cleanup-owned-codex';
const THREAD = '11111111-2222-3333-4444-555555555555';
type Outcome = 'sent' | 'not-sent' | 'unknown';
interface CleanupInternals {
  store: StateStore;
  recoveryStore: RecoveryStore;
  taskStore: TaskStore;
  actionReservationStore: TaskStore;
  sessions: Map<string, Session>;
  recoveryControllers: Map<string, RecoveryController>;
  taskControllers: Map<string, TaskController>;
  actionArbiters: Map<string, SessionActionArbiter>;
  taskInputListeners: Map<string, () => void>;
  recoveryInputListeners: Map<string, () => void>;
  rebootIdentityListeners: Map<string, () => void>;
  cleaningUp: Set<string>;
  tabLayouts: {
    runSessionDeletion(owners: unknown, action: () => Promise<void>): Promise<void>;
    sessionsRemoved(sessions: Array<{ id: string; owner?: string }>): Promise<void>;
  };
  getActionArbiter(id: string): SessionActionArbiter;
  stopRecoveryController(id: string, drop: boolean): Promise<void>;
  cleanupSession(id: string, kill: boolean, reason: string): Promise<void>;
  getTaskController(session: Session): TaskController | undefined;
  getRecoveryController(session: Session): RecoveryController | undefined;
  discardPartiallyBuiltSession(
    id: string,
    expected: Session,
    options: { preserveMuxPane: boolean; preserveCustomModelConfigDir: boolean }
  ): Promise<void>;
  stop(): Promise<void>;
}
afterEach(() => vi.restoreAllMocks());

async function fixture(
  owner: SessionActionOwner,
  check: (f: {
    internals: CleanupInternals;
    recovery: RecoveryController;
    task: TaskController;
    finish: ReturnType<typeof createDeferred<Outcome>>;
    pending: Promise<unknown>;
    paths: string[];
    rows: () => Promise<Record<string, unknown>[]>;
  }) => Promise<void>
): Promise<void> {
  const root = await fs.mkdtemp(join(homedir(), 'codex-controller-drain-'));
  const paths = ['recovery', 'tasks', 'actions'].map((name) => join(root, name + '.json'));
  const server = new WebServer(0, false, true);
  const internals = server as unknown as CleanupInternals;
  internals.store = new StateStore(join(root, 'state.json'));
  internals.recoveryStore = new RecoveryStore(paths[0]);
  internals.taskStore = new TaskStore(paths[1]);
  internals.actionReservationStore = new TaskStore(paths[2]);
  Reflect.set(server, 'supervisorStore', new SupervisorStore(join(root, 'supervisors.json')));
  const session = new Session({ id: ID, mode: 'codex', workingDir: root, useMux: false });
  internals.sessions.set(ID, session);
  for (const id of [ID, 'unrelated-retained']) {
    await internals.recoveryStore.save(id, initialRecoveryState());
    await internals.taskStore.save(id, initialTaskState());
    await internals.actionReservationStore.save(id, initialTaskState());
  }
  const arbiter = internals.getActionArbiter(ID) as SessionActionArbiter;
  const started = createDeferred<void>();
  const finish = createDeferred<Outcome>();
  const action = (key: string) =>
    arbiter.run(owner, key, async () => {
      started.resolve();
      return finish.promise;
    });
  const recovery = new RecoveryController({
    observe: async () => ({
      activity: 'crashed',
      reason: 'process-crashed',
      at: Date.now(),
      conversationId: THREAD,
      evidenceKey: 'crashed-proof',
      safeToAct: true,
    }),
    act: (flight) => action(flight.key),
    persist: (state) => internals.recoveryStore.save(ID, state),
    changed: () => {},
  });
  const task = new TaskController({
    observe: async () => ({
      observation: {
        activity: 'idle',
        reason: 'observing',
        at: Date.now(),
        conversationId: THREAD,
        processReady: true,
        safeToAct: false,
      },
      commands: new Map(),
    }),
    act: action,
    persist: (state) => internals.taskStore.save(ID, state),
    changed: () => {},
  });
  internals.recoveryControllers.set(ID, recovery);
  internals.taskControllers.set(ID, task);
  const taskInput = () => {};
  const recoveryInput = () => {};
  const identityInput = () => {};
  internals.taskInputListeners.set(ID, taskInput);
  internals.recoveryInputListeners.set(ID, recoveryInput);
  internals.rebootIdentityListeners.set(ID, identityInput);
  session.on('recoveryUserInput', taskInput);
  session.on('recoveryUserInput', recoveryInput);
  session.on('recoveryIdentityChanged', identityInput);
  const cleanups: Promise<void>[] = [];
  const stopControllers = internals.stopRecoveryController.bind(internals);
  internals.stopRecoveryController = (...args: [string, boolean]) => {
    const pendingCleanup = stopControllers(...args);
    cleanups.push(pendingCleanup);
    void pendingCleanup.catch(() => {});
    return pendingCleanup;
  };
  await task.update({
    objective: 'Fixture owner objective',
    criteria: [{ id: 'manual', kind: 'manual', description: 'Owner accepts' }],
  });
  const pending = owner === 'recovery' ? recovery.retry() : task.resume();
  try {
    await Promise.race([
      started.promise,
      pending.then(() => {
        throw new Error('Fixture action did not reach the deferred receipt');
      }),
    ]);
    await check({
      internals,
      recovery,
      task,
      finish,
      pending,
      paths,
      rows: () => Promise.all(paths.map(async (path) => JSON.parse(await fs.readFile(path, 'utf8')).sessions)),
    });
  } finally {
    finish.resolve('unknown');
    await pending.catch(() => {});
    recovery.stop();
    task.stop();
    await Promise.all([recovery.drain(), task.drain()]);
    await Promise.allSettled(cleanups);
    internals.sessions.clear();
    internals.recoveryControllers.clear();
    internals.taskControllers.clear();
    await server.stop();
    internals.store.flushAll();
    await fs.rm(root, { recursive: true, force: true });
  }
}

it.each(['recovery', 'task'] as const)(
  'stops both controllers synchronously before waiting for an active %s action',
  async (owner) => {
    await fixture(owner, async ({ internals, recovery, task, finish, pending }) => {
      const recoveryStop = vi.spyOn(recovery, 'stop');
      const taskStop = vi.spyOn(task, 'stop');
      const recoveryDrain = vi.spyOn(recovery, 'drain');
      const taskDrain = vi.spyOn(task, 'drain');
      const drop = vi.spyOn(internals.actionReservationStore, 'drop');
      const cleanup = internals.stopRecoveryController(ID, true);
      expect(recoveryStop).toHaveBeenCalledOnce();
      expect(taskStop).toHaveBeenCalledOnce();
      expect(recoveryDrain).toHaveBeenCalledOnce();
      expect(taskDrain).toHaveBeenCalledOnce();
      expect(drop).not.toHaveBeenCalled();
      finish.resolve('not-sent');
      await pending;
      await cleanup;
      expect(internals.sessions.get(ID).listenerCount('recoveryUserInput')).toBe(0);
      expect(internals.sessions.get(ID).listenerCount('recoveryIdentityChanged')).toBe(0);
    });
  }
);

it.each(['recovery', 'task'] as const)(
  'refuses controller factories throughout slow actual session cleanup after an active %s action',
  async (owner) => {
    await fixture(owner, async ({ internals, finish, pending, paths }) => {
      const session = internals.sessions.get(ID) as Session;
      const stopped = createDeferred<void>();
      const releaseStop = createDeferred<void>();
      vi.spyOn(session, 'stop').mockImplementation(async () => {
        stopped.resolve();
        await releaseStop.promise;
      });
      const cleanup = internals.cleanupSession(ID, false, 'fixture detach');
      try {
        expect(internals.cleaningUp.has(ID)).toBe(true);
        expect(internals.getTaskController(session)).toBeUndefined();
        expect(internals.getRecoveryController(session)).toBeUndefined();
        finish.resolve('not-sent');
        await pending;
        await stopped.promise;
        expect(internals.taskControllers.has(ID)).toBe(false);
        expect(internals.recoveryControllers.has(ID)).toBe(false);
        expect(internals.actionArbiters.has(ID)).toBe(false);
        expect(internals.sessions.get(ID)).toBe(session);
        const before = await Promise.all(paths.map((path) => fs.readFile(path, 'utf8')));
        expect(internals.getTaskController(session)).toBeUndefined();
        expect(internals.getRecoveryController(session)).toBeUndefined();
        expect(internals.taskControllers.has(ID)).toBe(false);
        expect(internals.recoveryControllers.has(ID)).toBe(false);
        expect(internals.actionArbiters.has(ID)).toBe(false);
        expect(await Promise.all(paths.map((path) => fs.readFile(path, 'utf8')))).toEqual(before);
      } finally {
        finish.resolve('not-sent');
        releaseStop.resolve();
        await cleanup;
      }
      expect(internals.cleaningUp.has(ID)).toBe(false);
      expect(internals.sessions.has(ID)).toBe(false);
    });
  }
);

it.each([
  ['recovery', 'sent'],
  ['recovery', 'not-sent'],
  ['recovery', 'unknown'],
  ['task', 'sent'],
  ['task', 'not-sent'],
  ['task', 'unknown'],
] as const)(
  'waits for %s %s receipts and journal writes before dropping the shared arbiter',
  async (owner, outcome) => {
    await fixture(owner, async ({ internals, finish, pending, rows, paths }) => {
      const taskDrop = vi.spyOn(internals.taskStore, 'drop');
      const actionDrop = vi.spyOn(internals.actionReservationStore, 'drop');
      const recoveryDrop = vi.spyOn(internals.recoveryStore, 'drop');
      const cleanup = internals.stopRecoveryController(ID, true);
      // Let any premature old-order drop operations finish while receipt is still pending.
      await Promise.all([
        internals.taskStore.flush(),
        internals.actionReservationStore.flush(),
        internals.recoveryStore.flush(),
      ]);
      expect(taskDrop).not.toHaveBeenCalled();
      expect(actionDrop).not.toHaveBeenCalled();
      expect(recoveryDrop).not.toHaveBeenCalled();
      expect(internals.actionArbiters.has(ID)).toBe(true);
      expect((await rows())[2][ID]).toHaveProperty('inFlight');
      finish.resolve(outcome);
      await pending;
      await cleanup;
      expect(internals.actionArbiters.has(ID)).toBe(false);
      expect(internals.recoveryControllers.has(ID)).toBe(false);
      expect(internals.taskControllers.has(ID)).toBe(false);
      for (const records of await rows()) expect(Object.keys(records)).toEqual(['unrelated-retained']);
      expect(new RecoveryStore(paths[0]).get(ID)).toEqual(initialRecoveryState());
      expect(new TaskStore(paths[1]).get(ID)).toEqual(initialTaskState());
      expect(new TaskStore(paths[2]).get(ID)).toEqual(initialTaskState());
    });
  }
);

it.each(['recovery', 'task'] as const)(
  'keeps durable uncertainty when %s cleanup only detaches controllers',
  async (owner) => {
    await fixture(owner, async ({ internals, finish, pending, rows, paths }) => {
      const cleanup = internals.stopRecoveryController(ID, false);
      finish.resolve('unknown');
      await pending;
      await cleanup;
      const records = await rows();
      for (const journal of records) expect(journal[ID]).toBeDefined();
      expect(new TaskStore(paths[2]).get(ID).inFlight?.key).toMatch(new RegExp(`^${owner}:`));
      if (owner === 'recovery') expect(new RecoveryStore(paths[0]).get(ID).inFlight).toBeDefined();
      else expect(new TaskStore(paths[1]).get(ID).inFlight).toBeDefined();
    });
  }
);

it.each(['task', 'actions', 'recovery'] as const)(
  'stops both controllers and completes owner deletion when the %s journal cannot be removed',
  async (failed) => {
    await fixture('recovery', async ({ internals, recovery, task, finish, pending, paths }) => {
      const session = internals.sessions.get(ID) as Session;
      const stop = vi.spyOn(session, 'stop').mockResolvedValue();
      const recoveryStop = vi.spyOn(recovery, 'stop');
      const taskStop = vi.spyOn(task, 'stop');
      const journals = [internals.recoveryStore, internals.taskStore, internals.actionReservationStore];
      const index = failed === 'recovery' ? 0 : failed === 'task' ? 1 : 2;
      const before = await fs.readFile(paths[index], 'utf8');
      const drops = journals.map((journal) => vi.spyOn(journal, 'drop'));
      Reflect.set(journals[index], 'path', join(paths[index], 'blocked'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(internals.tabLayouts, 'runSessionDeletion').mockImplementation(
        async (_owners: unknown, action: () => Promise<void>) => action()
      );
      const cleanup = internals.cleanupSession(ID, true, 'fixture owner deletion');
      finish.resolve('unknown');
      await pending.catch(() => {});
      await cleanup;
      expect(recoveryStop).toHaveBeenCalledOnce();
      expect(taskStop).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledWith(true);
      expect(internals.sessions.has(ID)).toBe(false);
      expect(internals.cleaningUp.has(ID)).toBe(false);
      expect(await fs.readFile(paths[index], 'utf8')).toBe(before);
      for (const drop of drops) expect(drop).toHaveBeenCalledWith(ID);
      for (let i = 0; i < paths.length; i++) {
        if (i !== index) expect(JSON.parse(await fs.readFile(paths[i], 'utf8')).sessions[ID]).toBeUndefined();
      }
      Reflect.set(journals[index], 'path', paths[index]);
    });
  }
);

it('synchronously stops and drains a task-only server shutdown before flushing its durable uncertainty', async () => {
  await fixture('task', async ({ internals, task, finish, pending, paths }) => {
    internals.recoveryControllers.delete(ID);
    const stopped = vi.spyOn(task, 'stop');
    const shutdown = internals.stop();
    expect(stopped).toHaveBeenCalled();
    finish.resolve('unknown');
    await pending;
    await shutdown;
    expect(internals.taskControllers.has(ID)).toBe(false);
    expect(internals.actionArbiters.has(ID)).toBe(false);
    expect(new TaskStore(paths[1]).get(ID).inFlight).toBeDefined();
    expect(new TaskStore(paths[2]).get(ID).inFlight?.key).toMatch(/^task:/);
  });
});

it.each([
  ['recovery', false],
  ['recovery', true],
  ['task', false],
  ['task', true],
] as const)(
  'fences partial discard while %s drains with an existing outer cleanup fence: %s',
  async (owner, outerFence) => {
    await fixture(owner, async ({ internals, finish, pending, paths }) => {
      const session = internals.sessions.get(ID)!;
      const stop = vi.spyOn(session, 'stop').mockResolvedValue();
      const closing = vi.spyOn(session, 'markClosing');
      vi.spyOn(internals.tabLayouts, 'sessionsRemoved').mockResolvedValue();
      if (owner === 'task') internals.recoveryControllers.delete(ID);
      else internals.taskControllers.delete(ID);
      if (outerFence) internals.cleaningUp.add(ID);
      const discard = internals.discardPartiallyBuiltSession(ID, session, {
        preserveMuxPane: true,
        preserveCustomModelConfigDir: true,
      });
      expect(closing).toHaveBeenCalledWith(true);
      expect(internals.cleaningUp.has(ID)).toBe(true);
      expect(internals.getTaskController(session)).toBeUndefined();
      expect(internals.getRecoveryController(session)).toBeUndefined();
      finish.resolve('unknown');
      await pending;
      await discard;
      expect(internals.sessions.has(ID)).toBe(false);
      expect(internals.cleaningUp.has(ID)).toBe(outerFence);
      expect(stop).toHaveBeenCalledWith(false);
      expect(new TaskStore(paths[2]).get(ID).inFlight?.key).toMatch(new RegExp(`^${owner}:`));
    });
  }
);

it('keeps a newer replacement session when partial discard finishes draining the prior instance', async () => {
  await fixture('recovery', async ({ internals, finish, pending }) => {
    const session = internals.sessions.get(ID)!;
    const stop = vi.spyOn(session, 'stop').mockResolvedValue();
    const discard = internals.discardPartiallyBuiltSession(ID, session, {
      preserveMuxPane: true,
      preserveCustomModelConfigDir: true,
    });
    const replacement = new Session({ id: ID, mode: 'codex', workingDir: session.workingDir, useMux: false });
    internals.sessions.set(ID, replacement);
    finish.resolve('unknown');
    await pending;
    await discard;
    expect(internals.sessions.get(ID)).toBe(replacement);
    expect(internals.cleaningUp.has(ID)).toBe(false);
    expect(stop).not.toHaveBeenCalled();
  });
});
