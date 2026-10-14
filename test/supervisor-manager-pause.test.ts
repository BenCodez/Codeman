/** Real manager Task scheduling; worker/native effects are bounded fixtures. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskController, type TaskDependencies } from '../src/supervision/controller.js';
import { initialTaskState, type TaskState } from '../src/supervision/schema.js';
import {
  SupervisorController,
  type SupervisorDependencies,
  type SupervisorWorkerHandle,
} from '../src/supervisor/controller.js';
import { initialRecoveryState } from '../src/recovery/types.js';
import { initialSupervisorState } from '../src/supervisor/schema.js';

const MANAGER = '11111111-1111-4111-8111-111111111111';
const WORKER = '22222222-2222-4222-8222-222222222222';
const config = {
  objective: 'Coordinate the bounded task',
  enabled: true,
  workers: [
    {
      sessionId: WORKER,
      task: 'Implement the fix',
      criteria: [{ id: 'acceptance', description: 'Owner acceptance', kind: 'manual' as const }],
      maxAssignments: 2,
      maxRuntimeMs: 60_000,
    },
  ],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness() {
  const state = initialTaskState();
  Object.assign(state, {
    objective: config.objective,
    criteria: [{ ...config.workers[0].criteria[0], verified: false }],
    conversationId: MANAGER,
    kickoffAt: 9_000,
    startedAt: 10_000,
    configuredAt: 9_000,
    outcome: 'unfinished',
    checkpoint: 'Reviewed the plan',
    nextAction: 'Inspect the worker',
  });
  state.config.enabled = true;
  let activity: 'working' | 'completed' = 'working';
  const taskSaved: TaskState[] = [];
  const taskDeps: TaskDependencies = {
    now: () => Date.now(),
    observe: vi.fn(async () => ({
      observation: {
        activity,
        reason: activity,
        conversationId: MANAGER,
        turnId: 'manager-turn',
        at: Date.now(),
        safeToAct: true,
        processReady: true,
      },
      commands: new Map(),
    })),
    act: vi.fn(async () => 'sent' as const),
    persist: vi.fn(async (snapshot) => {
      taskSaved.push(snapshot);
    }),
    changed: vi.fn(),
  };
  const task = new TaskController(taskDeps, state);
  const workerState = initialTaskState();
  const recoveryState = initialRecoveryState();
  recoveryState.activity = 'crashed';
  const worker: SupervisorWorkerHandle = {
    task: {
      getStatus: () => structuredClone(workerState),
      update: vi.fn(async () => structuredClone(workerState)),
      resume: vi.fn(async () => ({
        ...workerState,
        phase: 'watching',
        reason: 'kickoff-sent',
        inFlight: { key: 'worker-kickoff', startedAt: Date.now() },
      })),
    },
    recovery: {
      getStatus: () => structuredClone(recoveryState),
      inspect: vi.fn(async () => structuredClone(recoveryState)),
      inspectEvidence: vi.fn(async () => ({
        state: structuredClone(recoveryState),
        observedAt: Date.now(),
        stale: false,
        isCurrent: () => true,
      })),
      retry: vi.fn(async () => ({
        ...recoveryState,
        phase: 'recovering',
        lastReason: 'process-resumed',
        inFlight: { key: 'worker-retry', action: 'restart', conversationId: WORKER, startedAt: Date.now() },
      })),
    },
  };
  const saved: ReturnType<SupervisorController['getStatus']>[] = [];
  let grant = () => false;
  const deps: SupervisorDependencies = {
    validateWorkers: vi.fn(),
    worker: () => worker,
    persist: vi.fn(async (snapshot) => {
      saved.push(snapshot);
    }),
    withLeases: (fn) => fn(),
    leaseHolder: () => undefined,
    startManager: vi.fn(async (_objective, _workers, isCurrent, runtimeStartedAt) => {
      await task.resume(isCurrent, runtimeStartedAt);
      grant = task.captureActionAuthority();
      return true;
    }),
    pauseManager: vi.fn(() => task.pause().then(() => {})),
    resetManager: () => task.reset().then(() => {}),
    hasManagerAuthority: () => grant(),
    prepareManagerAuthority: async () => grant(),
    validateManagerAuthority: vi.fn(async () => grant()),
    changed: vi.fn(),
    now: () => Date.now(),
  };
  const controller = new SupervisorController(deps, MANAGER);
  return {
    controller,
    deps,
    worker,
    task,
    taskDeps,
    saved,
    taskSaved,
    complete: () => {
      activity = 'completed';
    },
  };
}
let current: ReturnType<typeof harness> | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
});
afterEach(async () => {
  current?.task.stop();
  await current?.task.drain();
  current = undefined;
  vi.useRealTimers();
});
async function active() {
  const h = (current = harness());
  await h.controller.configure(config);
  await h.controller.start();
  expect(h.task.getStatus().phase).toBe('watching');
  return h;
}
async function noMoreManagerWork(h: ReturnType<typeof harness>) {
  h.complete();
  vi.mocked(h.taskDeps.observe).mockClear();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(h.taskDeps.observe).not.toHaveBeenCalled();
  expect(h.taskDeps.act).not.toHaveBeenCalled();
  expect(h.task.getStatus().criteria[0].verified).toBe(false);
}

describe('Supervisor manager Task pause invariant', () => {
  it.each(['assign', 'retry'] as const)(
    'stops automatic manager continuation after uncertain %s and preserves the lease journal',
    async (action) => {
      const h = await active();
      if (action === 'assign')
        vi.mocked(h.worker.task.resume).mockResolvedValue({
          ...initialTaskState(),
          phase: 'paused',
          reason: 'delivery-unknown',
          inFlight: { key: 'uncertain-worker', startedAt: Date.now() },
        });
      else
        vi.mocked(h.worker.recovery.retry).mockResolvedValue({
          ...initialRecoveryState(),
          phase: 'paused',
          lastReason: 'delivery-unknown',
          inFlight: { key: 'uncertain-worker', action: 'restart', conversationId: WORKER, startedAt: Date.now() },
        });
      await expect(h.controller[action](WORKER, 'uncertain-request')).rejects.toThrow(/uncertain/);
      expect(h.controller.getStatus()).toMatchObject({
        phase: 'paused',
        reason: `${action}-uncertain`,
        enabled: true,
        inFlight: { requestId: 'uncertain-request', workerId: WORKER, action },
        handledRequestIds: [],
      });
      expect(h.saved.at(-1)?.inFlight).toBeDefined();
      expect(h.task.getStatus().phase).toBe('paused');
      await noMoreManagerWork(h);
    }
  );
  it.each([1, 3])('pauses actual manager Task when authority read %s requires attention', async (read) => {
    const h = await active();
    let calls = 0;
    vi.mocked(h.deps.validateManagerAuthority).mockImplementation(async () => ++calls !== read);
    await expect(h.controller.assign(WORKER, 'attention-request')).rejects.toThrow(/owner Start/);
    expect(h.controller.getStatus().phase).toBe('paused');
    expect(h.controller.getStatus().inFlight).toBeUndefined();
    expect(h.worker.task.resume).not.toHaveBeenCalled();
    expect(h.task.getStatus().phase).toBe('paused');
    await noMoreManagerWork(h);
  });
  it('keeps the active healthy manager timer and accepted read-only receipts', async () => {
    const h = await active();
    await h.controller.assign(WORKER, 'healthy-request');
    expect(h.controller.getStatus().phase).toBe('active');
    h.complete();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.taskDeps.act).toHaveBeenCalledOnce();
    await h.controller.pause();
    const before = h.task.getStatus();
    const pauses = vi.mocked(h.deps.pauseManager).mock.calls.length;
    await h.controller.assign(WORKER, 'healthy-request');
    expect(h.task.getStatus()).toEqual(before);
    expect(h.deps.pauseManager).toHaveBeenCalledTimes(pauses);
    expect(h.worker.task.resume).toHaveBeenCalledOnce();
  });
  it.each([
    'assign-reserved',
    'assign-accepted',
    'assign-uncertain',
    'manager-attention-required',
    'manager-start-reserved',
    'owner-started',
    'owner-paused',
    'configured',
    'owner-reset',
  ])('vetoes manager polling even when Supervisor %s persistence fails', async (reason) => {
    const h = await active();
    vi.mocked(h.deps.persist).mockImplementation(async (snapshot) => {
      if (snapshot.reason === reason) throw new Error('disk failed');
      h.saved.push(snapshot);
    });
    if (reason === 'assign-uncertain')
      vi.mocked(h.worker.task.resume).mockRejectedValue(new Error('worker delivery uncertain'));
    if (reason === 'manager-attention-required') vi.mocked(h.deps.validateManagerAuthority).mockResolvedValue(false);
    let operation: Promise<unknown>;
    if (reason === 'configured') operation = h.controller.configure(config);
    else if (reason === 'owner-reset') operation = h.controller.reset();
    else if (reason === 'owner-paused') operation = h.controller.pause();
    else if (reason === 'manager-start-reserved' || reason === 'owner-started') {
      await h.controller.pause();
      operation = h.controller.start();
    } else operation = h.controller.assign(WORKER, 'persist-request');
    await expect(operation).rejects.toThrow(
      reason === 'assign-uncertain' ? /worker delivery uncertain/ : /could not be saved/
    );
    expect(h.controller.getStatus()).toMatchObject({ phase: 'blocked', reason: 'persistence-failed' });
    expect(h.task.getStatus().phase).toBe('paused');
    if (reason === 'assign-accepted' || reason === 'assign-uncertain')
      expect(h.controller.getStatus().inFlight?.requestId).toBe('persist-request');
    await noMoreManagerWork(h);
  });
  it.each(['refused', 'uncertain'] as const)(
    'pauses an already resumed manager after %s manager Start',
    async (outcome) => {
      const h = await active();
      await h.controller.pause();
      vi.mocked(h.deps.startManager).mockImplementation(async (_objective, _workers, isCurrent, origin) => {
        await h.task.resume(isCurrent, origin);
        if (outcome === 'uncertain') throw new Error('manager start uncertain');
        return false;
      });
      await expect(h.controller.start()).rejects.toThrow(/uncertain|not ready/);
      expect(h.controller.getStatus()).toMatchObject({ phase: 'paused', reason: `manager-start-${outcome}` });
      expect(h.task.getStatus().phase).toBe('paused');
      await noMoreManagerWork(h);
    }
  );
  it('pauses the manager when authority disappears during a certified unsent worker dispatch', async () => {
    const h = await active();
    const hasAuthority = h.deps.hasManagerAuthority;
    let allowed = true;
    h.deps.hasManagerAuthority = () => allowed && hasAuthority();
    vi.mocked(h.worker.task.resume).mockImplementation(async () => {
      allowed = false;
      return initialTaskState();
    });
    await expect(h.controller.assign(WORKER, 'lost-authority-request')).rejects.toThrow(/cancelled/);
    expect(h.controller.getStatus()).toMatchObject({ phase: 'paused', reason: 'assign-refused' });
    expect(h.controller.getStatus().inFlight).toBeUndefined();
    expect(h.task.getStatus().phase).toBe('paused');
    await noMoreManagerWork(h);
  });
  it('keeps healthy manager polling active after a certified unsent worker refusal', async () => {
    const h = await active();
    vi.mocked(h.worker.task.resume).mockResolvedValue(initialTaskState());
    await expect(h.controller.assign(WORKER, 'unsent-worker-request')).rejects.toThrow(/not ready/);
    expect(h.controller.getStatus()).toMatchObject({ phase: 'active', reason: 'assign-refused' });
    expect(h.controller.getStatus().inFlight).toBeUndefined();
    expect(h.task.getStatus().phase).toBe('watching');
    h.complete();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.taskDeps.act).toHaveBeenCalledOnce();
  });
  it.each(['reject', 'throw'] as const)(
    'preserves uncertain Supervisor flight when pauseManager %s fails after the Task veto',
    async (failure) => {
      const h = await active();
      vi.mocked(h.worker.task.resume).mockRejectedValue(new Error('dispatch failed'));
      if (failure === 'reject') vi.mocked(h.taskDeps.persist).mockRejectedValue(new Error('manager disk failed'));
      else
        vi.mocked(h.deps.pauseManager).mockImplementation(() => {
          void h.task.pause().catch(() => {});
          throw new Error('manager pause failed');
        });
      await expect(h.controller.assign(WORKER, 'failed-pause-request')).rejects.toThrow(/dispatch failed/);
      expect(h.controller.getStatus()).toMatchObject({
        phase: 'paused',
        reason: 'assign-uncertain',
        inFlight: { requestId: 'failed-pause-request' },
      });
      expect(h.saved.at(-1)?.inFlight?.requestId).toBe('failed-pause-request');
      await h.task.drain();
      expect(['paused', 'blocked']).toContain(h.task.getStatus().phase);
      await noMoreManagerWork(h);
    }
  );
  it('latches owner pause before a held worker dispatch drains', async () => {
    const h = await active();
    const entered = deferred<() => boolean>();
    const release = deferred<ReturnType<TaskController['getStatus']>>();
    vi.mocked(h.worker.task.resume).mockImplementation(async (isCurrent) => {
      entered.resolve(isCurrent!);
      return release.promise;
    });
    const assignment = h.controller.assign(WORKER, 'cancelled-request');
    const workerIsCurrent = await entered.promise;
    const pause = h.controller.pause();
    expect(workerIsCurrent()).toBe(false);
    await h.task.drain();
    expect(h.task.getStatus().phase).toBe('paused');
    await noMoreManagerWork(h);
    release.resolve(initialTaskState());
    await expect(assignment).rejects.toThrow(/cancelled/);
    await pause;
    expect(h.controller.getStatus().inFlight).toBeUndefined();
  });
  it('vetoes an awaiting manager delivery without clearing uncertainty or overriding newer owner intent', async () => {
    const h = await active();
    const entered = deferred<() => boolean>();
    const release = deferred<'unknown'>();
    vi.mocked(h.taskDeps.act).mockImplementation(async (_key, _id, _prompt, isCurrent) => {
      entered.resolve(isCurrent);
      return release.promise;
    });
    h.complete();
    const refresh = h.task.refresh();
    const managerIsCurrent = await entered.promise;
    const managerFlight = h.task.getStatus().inFlight!;
    vi.mocked(h.worker.task.resume).mockRejectedValue(new Error('worker uncertain'));
    const assignment = h.controller.assign(WORKER, 'held-manager-request');
    void assignment.catch(() => {});
    // Supervisor persists its journal while the manager's queued pause waits for delivery.
    for (let i = 0; i < 30 && !h.saved.some((s) => s.reason === 'assign-uncertain'); i++) await Promise.resolve();
    try {
      expect(h.controller.getStatus().phase).toBe('paused');
      expect(managerIsCurrent()).toBe(false);
      h.task.noteUserInput();
    } finally {
      release.resolve('unknown');
    }
    await refresh;
    await expect(assignment).rejects.toThrow(/worker uncertain/);
    await h.task.drain();
    expect(h.task.getStatus()).toMatchObject({ phase: 'paused', reason: 'user-input', continuations: 1 });
    expect(h.task.getStatus().inFlight).toEqual(managerFlight);
    expect(h.task.getStatus().handledEvidence).toContain(managerFlight.key);
    expect(h.taskSaved.at(-1)).toMatchObject({ phase: 'paused', reason: 'user-input', inFlight: managerFlight });
    expect(h.controller.getStatus().inFlight?.requestId).toBe('held-manager-request');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.taskDeps.act).toHaveBeenCalledOnce();
  });
  it('pauses a live watching manager when its restored Supervisor requires owner Start', async () => {
    const h = (current = harness());
    await h.task.resume();
    const restored = { ...initialSupervisorState(MANAGER), ...config, phase: 'active' as const };
    const loaded = new SupervisorController(h.deps, MANAGER, restored);
    await h.task.drain();
    expect(loaded.getStatus().phase).toBe('paused');
    expect(h.task.getStatus().phase).toBe('paused');
    await noMoreManagerWork(h);
  });
  it('stops manager polling immediately when Supervisor is stopped', async () => {
    const h = await active();
    h.controller.stop();
    await h.task.drain();
    expect(h.task.getStatus().phase).toBe('paused');
    await noMoreManagerWork(h);
  });
});
