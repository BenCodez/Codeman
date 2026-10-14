/** @fileoverview Remote restoration shares the task's live and durable authority through final dispatch. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { TmuxManager } from '../src/tmux-manager.js';
import { WebServer } from '../src/web/server.js';
import { CodexRecoveryAdapter } from '../src/recovery/codex-adapter.js';
import type { RecoveryController, RecoveryDependencies } from '../src/recovery/controller.js';
import type { TaskController } from '../src/supervision/controller.js';
import { initialTaskState } from '../src/supervision/schema.js';
import { sessionActionKey } from '../src/supervision/action-arbiter.js';
import type { TaskStore } from '../src/supervision/store.js';
import { createDeferred } from './mocks/index.js';

interface Internals {
  sessions: Map<string, Session>;
  taskStore: TaskStore;
  actionReservationStore: TaskStore;
  getTaskController(session: Session): TaskController | undefined;
  getRecoveryController(session: Session): RecoveryController | undefined;
  stopRecoveryController(id: string, drop: boolean): Promise<void>;
}
const ID = '11111111-1111-4111-8111-111111111111';
const THREAD = '22222222-2222-4222-8222-222222222222';
let server: WebServer;
let internals: Internals;
let task: TaskController;
let recovery: RecoveryController;
let deps: RecoveryDependencies;

beforeEach(() => {
  vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);
  server = new WebServer(0, false, true);
  internals = server as unknown as Internals;
  const worker = new Session({ id: ID, workingDir: process.cwd(), mode: 'codex', useMux: false });
  internals.sessions.set(ID, worker);
  task = internals.getTaskController(worker)!;
  recovery = internals.getRecoveryController(worker)!;
  deps = Reflect.get(recovery, 'deps') as RecoveryDependencies;
  // All remote effects are fake: the fixture never starts SSH or a worker.
  vi.spyOn(CodexRecoveryAdapter.prototype, 'observe').mockImplementation(async () => ({
    activity: 'unknown',
    reason: 'remote-session-missing',
    conversationId: THREAD,
    at: Date.now(),
    safeToAct: false,
  }));
});
afterEach(async () => {
  await internals.stopRecoveryController(ID, true);
  internals.sessions.delete(ID);
  await server.stop();
  vi.restoreAllMocks();
});

it('keeps an explicit missing-worker restore behind durable task attention until owner reset commits', async () => {
  const restore = vi.spyOn(CodexRecoveryAdapter.prototype, 'restoreMissingRemote').mockResolvedValue('sent');
  await internals.taskStore.save(ID, { ...initialTaskState(), agentProgressVeto: true });
  await recovery.restoreMissingRemote();
  expect(restore).not.toHaveBeenCalled();
  expect(recovery.getStatus().inFlight).toBeUndefined();
  await task.reset();
  await recovery.restoreMissingRemote();
  expect(restore).toHaveBeenCalledOnce();
  expect(recovery.getStatus().inFlight?.conversationId).toBe(THREAD);
});

it.each(['unchanged', 'late-veto'] as const)(
  'rechecks task authority after the durable missing-worker reservation: %s',
  async (change) => {
    const restore = vi.spyOn(CodexRecoveryAdapter.prototype, 'restoreMissingRemote').mockResolvedValue('sent');
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const persist = deps.persist;
    deps.persist = async (state) => {
      await persist(state);
      if (state.inFlight) {
        entered.resolve();
        await release.promise;
      }
    };
    const restoring = recovery.restoreMissingRemote();
    await entered.promise;
    try {
      if (change === 'late-veto')
        await internals.taskStore.save(ID, { ...initialTaskState(), agentProgressVeto: true });
    } finally {
      release.resolve();
    }
    await restoring;
    expect(restore).toHaveBeenCalledTimes(change === 'unchanged' ? 1 : 0);
    expect(recovery.getStatus()).toMatchObject({ attempts: 0, failedAttempts: 0, circuitOpen: false });
    if (change === 'late-veto') expect(recovery.getStatus().inFlight).toBeUndefined();
  }
);

it.each(['unchanged', 'late-veto'] as const)(
  'keeps the server authority callback current throughout the adapter wait: %s',
  async (change) => {
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const input = vi.fn();
    vi.spyOn(CodexRecoveryAdapter.prototype, 'restoreMissingRemote').mockImplementation(async (current) => {
      entered.resolve();
      await release.promise;
      if (!current()) return 'not-sent';
      input();
      return 'sent';
    });
    const restoring = recovery.restoreMissingRemote();
    await entered.promise;
    const flight = recovery.getStatus().inFlight;
    expect(flight).toBeDefined();
    expect(internals.actionReservationStore.get(ID).inFlight?.key).toBe(sessionActionKey('recovery', flight!.key));
    try {
      if (change === 'late-veto')
        await internals.taskStore.save(ID, { ...initialTaskState(), agentProgressVeto: true });
    } finally {
      release.resolve();
    }
    const result = await restoring;
    expect(result.lastReason).toBe(change === 'unchanged' ? 'process-resumed' : 'delivery-failed');
    expect(!!result.inFlight).toBe(change === 'unchanged');
    expect(input).toHaveBeenCalledTimes(change === 'unchanged' ? 1 : 0);
  }
);
