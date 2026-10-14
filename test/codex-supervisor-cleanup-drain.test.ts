/** Actual manager/worker controllers and durable stores with deferred fake effects only. */
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
import { TaskController } from '../src/supervision/controller.js';
import { initialTaskState } from '../src/supervision/schema.js';
import type { SessionActionArbiter, SessionActionOwner } from '../src/supervision/action-arbiter.js';
import { SupervisorStore } from '../src/supervisor/store.js';
import { SupervisorController } from '../src/supervisor/controller.js';
import { initialSupervisorState } from '../src/supervisor/schema.js';
import { createDeferred } from './mocks/index.js';

const ID = 'cleanup-owned-manager';
const THREAD = '11111111-2222-3333-4444-555555555555';
interface Internals {
  store: StateStore;
  recoveryStore: RecoveryStore;
  taskStore: TaskStore;
  actionReservationStore: TaskStore;
  supervisorStore: SupervisorStore;
  sessions: Map<string, Session>;
  recoveryControllers: Map<string, RecoveryController>;
  taskControllers: Map<string, TaskController>;
  supervisorControllers: Map<string, SupervisorController>;
  actionArbiters: Map<string, SessionActionArbiter>;
  cleaningUp: Set<string>;
  getActionArbiter(id: string): SessionActionArbiter;
  stopRecoveryController(id: string, drop: boolean): Promise<void>;
  cleanupSession(id: string, kill: boolean, reason: string): Promise<void>;
  getRecoveryController(session: Session): RecoveryController | undefined;
  getTaskController(session: Session): TaskController | undefined;
  getSupervisorController(session: Session): SupervisorController | undefined;
  stop(): Promise<void>;
}
afterEach(() => vi.restoreAllMocks());

async function fixture(
  owner: SessionActionOwner | undefined,
  check: (f: {
    internals: Internals;
    supervisor: SupervisorController;
    recovery: RecoveryController;
    task: TaskController;
    session: Session;
    workerDone: ReturnType<typeof createDeferred<'sent' | 'not-sent' | 'unknown'>>;
    managerDone: ReturnType<typeof createDeferred<void>>;
    workerPending: Promise<unknown>;
    managerPending: Promise<unknown>;
    paths: string[];
  }) => Promise<void>
): Promise<void> {
  const root = await fs.mkdtemp(join(homedir(), 'codex-supervisor-drain-'));
  const paths = ['recovery', 'tasks', 'actions', 'supervisors'].map((name) => join(root, name + '.json'));
  const server = new WebServer(0, false, true);
  const internals = server as unknown as Internals;
  internals.store = new StateStore(join(root, 'state.json'));
  internals.recoveryStore = new RecoveryStore(paths[0]);
  internals.taskStore = new TaskStore(paths[1]);
  internals.actionReservationStore = new TaskStore(paths[2]);
  internals.supervisorStore = new SupervisorStore(paths[3]);
  await internals.recoveryStore.save(ID, initialRecoveryState());
  await internals.taskStore.save(ID, initialTaskState());
  await internals.actionReservationStore.save(ID, initialTaskState());
  await internals.supervisorStore.save(ID, initialSupervisorState(ID));
  const session = new Session({ id: ID, mode: 'codex', workingDir: root, useMux: false });
  internals.sessions.set(ID, session);
  const arbiter = internals.getActionArbiter(ID);
  const workerStarted = createDeferred<void>();
  const workerDone = createDeferred<'sent' | 'not-sent' | 'unknown'>();
  const act = () =>
    arbiter.run(owner ?? 'task', async () => {
      workerStarted.resolve();
      return workerDone.promise;
    });
  const recovery = new RecoveryController({
    observe: async () => ({
      activity: 'crashed',
      reason: 'process-crashed',
      at: Date.now(),
      conversationId: THREAD,
      evidenceKey: 'proof',
      safeToAct: true,
    }),
    act,
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
    act,
    persist: (state) => internals.taskStore.save(ID, state),
    changed: () => {},
  });
  internals.recoveryControllers.set(ID, recovery);
  internals.taskControllers.set(ID, task);
  if (owner === 'task')
    await task.update({
      objective: 'Fixture task',
      criteria: [{ id: 'manual', kind: 'manual', description: 'Owner accepts' }],
    });
  const workerPending = owner === 'task' ? task.resume() : owner === 'recovery' ? recovery.retry() : Promise.resolve();
  if (owner) await workerStarted.promise;
  const managerStarted = createDeferred<void>();
  const managerDone = createDeferred<void>();
  const supervisor = new SupervisorController(
    {
      validateWorkers: () => {},
      worker: () => undefined,
      withLeases: (fn) => fn(),
      leaseHolder: () => undefined,
      persist: async (state) => {
        managerStarted.resolve();
        await managerDone.promise;
        await internals.supervisorStore.save(ID, state);
      },
      startManager: vi.fn(async () => true),
      pauseManager: async () => {},
      resetManager: async () => {},
      changed: () => {},
    },
    ID
  );
  internals.supervisorControllers.set(ID, supervisor);
  const managerPending = supervisor.pause();
  await managerStarted.promise;
  try {
    await check({
      internals,
      supervisor,
      recovery,
      task,
      session,
      workerDone,
      managerDone,
      workerPending,
      managerPending,
      paths,
    });
  } finally {
    workerDone.resolve('unknown');
    managerDone.resolve();
    await Promise.allSettled([workerPending, managerPending]);
    supervisor.stop();
    recovery.stop();
    task.stop();
    await Promise.all([supervisor.drain(), recovery.drain(), task.drain()]);
    internals.sessions.clear();
    await server.stop();
    internals.store.flushAll();
    await fs.rm(root, { recursive: true, force: true });
  }
}

it.each([
  ['recovery', 'manager'],
  ['recovery', 'worker'],
  ['task', 'manager'],
  ['task', 'worker'],
] as const)(
  'stops all controllers and waits for both %s and %s-first receipts before dropping any journal',
  async (owner, first) => {
    await fixture(
      owner,
      async ({
        internals,
        supervisor,
        recovery,
        task,
        workerDone,
        managerDone,
        workerPending,
        managerPending,
        paths,
      }) => {
        const stops = [vi.spyOn(supervisor, 'stop'), vi.spyOn(recovery, 'stop'), vi.spyOn(task, 'stop')];
        const drops = [
          internals.supervisorStore,
          internals.recoveryStore,
          internals.taskStore,
          internals.actionReservationStore,
        ].map((store) => vi.spyOn(store, 'drop'));
        const cleanup = internals.stopRecoveryController(ID, true);
        try {
          for (const stop of stops) expect(stop).toHaveBeenCalledOnce();
          if (first === 'manager') {
            managerDone.resolve();
            await managerPending;
          } else {
            workerDone.resolve('not-sent');
            await workerPending;
          }
          for (const drop of drops) expect(drop).not.toHaveBeenCalled();
          expect(internals.actionArbiters.has(ID)).toBe(true);
          for (const path of paths) expect(await fs.readFile(path, 'utf8')).toContain(ID);
        } finally {
          workerDone.resolve('sent');
          managerDone.resolve();
          await Promise.allSettled([workerPending, managerPending]);
          await cleanup;
        }
        for (const path of paths) {
          const data = JSON.parse(await fs.readFile(path, 'utf8'));
          expect(data.sessions ?? data.supervisors).toEqual({});
        }
        expect(internals.actionArbiters.has(ID)).toBe(false);
      }
    );
  }
);

it.each(['recovery', 'task'] as const)(
  'fences all factories during %s detach and preserves uncertainty plus the late manager pause',
  async (owner) => {
    await fixture(
      owner,
      async ({ internals, session, workerDone, managerDone, workerPending, managerPending, paths }) => {
        // Keep eligibility true so the server cleanup fence itself must refuse.
        const context = session.getRecoveryContext();
        vi.spyOn(session, 'getRecoveryContext').mockReturnValue({ ...context, managed: true, noDaemon: true });
        expect(internals.getSupervisorController(session)).toBe(internals.supervisorControllers.get(ID));
        const stopped = createDeferred<void>();
        const finishStop = createDeferred<void>();
        vi.spyOn(session, 'stop').mockImplementation(async () => {
          stopped.resolve();
          await finishStop.promise;
        });
        const cleanup = internals.cleanupSession(ID, false, 'fixture detach');
        try {
          expect(internals.getTaskController(session)).toBeUndefined();
          expect(internals.getRecoveryController(session)).toBeUndefined();
          expect(internals.getSupervisorController(session)).toBeUndefined();
          workerDone.resolve('unknown');
          managerDone.resolve();
          await Promise.all([workerPending, managerPending]);
          await stopped.promise;
          expect(internals.sessions.get(ID)).toBe(session);
          for (const map of [internals.taskControllers, internals.recoveryControllers, internals.supervisorControllers])
            expect(map.has(ID)).toBe(false);
          const before = await Promise.all(paths.map((path) => fs.readFile(path, 'utf8')));
          expect(internals.getTaskController(session)).toBeUndefined();
          expect(internals.getRecoveryController(session)).toBeUndefined();
          expect(internals.getSupervisorController(session)).toBeUndefined();
          expect(await Promise.all(paths.map((path) => fs.readFile(path, 'utf8')))).toEqual(before);
        } finally {
          workerDone.resolve('unknown');
          managerDone.resolve();
          finishStop.resolve();
          await cleanup;
        }
        expect(new TaskStore(paths[2]).get(ID).inFlight?.key).toMatch(new RegExp(`^${owner}:`));
        expect(new SupervisorStore(paths[3]).get(ID).reason).toBe('owner-paused');
      }
    );
  }
);

it('drains a supervisor-only pending pause on server shutdown before flushing journals', async () => {
  await fixture(undefined, async ({ internals, supervisor, managerDone, managerPending, paths }) => {
    internals.recoveryControllers.clear();
    internals.taskControllers.clear();
    const stop = vi.spyOn(supervisor, 'stop');
    const shutdown = internals.stop();
    expect(stop).toHaveBeenCalled();
    managerDone.resolve();
    await managerPending;
    await shutdown;
    expect(internals.supervisorControllers.has(ID)).toBe(false);
    expect(new SupervisorStore(paths[3]).get(ID).reason).toBe('owner-paused');
  });
});
