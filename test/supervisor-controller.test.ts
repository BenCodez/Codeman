import { describe, expect, it, vi } from 'vitest';
import {
  classifyTaskKickoff,
  SupervisorController,
  SupervisorValidationError,
  type SupervisorDependencies,
  type SupervisorWorkerHandle,
} from '../src/supervisor/controller.js';
import { initialTaskState } from '../src/supervision/schema.js';
import { TaskController, type TaskObservation } from '../src/supervision/controller.js';
import { RecoveryController } from '../src/recovery/controller.js';
import { initialRecoveryState, type RecoveryObservation } from '../src/recovery/types.js';
import { buildSupervisorManagerTask, SUPERVISOR_MANAGER_MAX_RUNTIME_MS } from '../src/supervisor/manager-task.js';
import { SupervisorConfigSchema } from '../src/supervisor/schema.js';

const SUPERVISOR = '11111111-1111-4111-8111-111111111111';
const WORKER = '22222222-2222-4222-8222-222222222222';
const config = {
  objective: 'Ship the bounded fix',
  enabled: true,
  workers: [
    {
      sessionId: WORKER,
      task: 'Implement the parser',
      criteria: [{ id: 'tests', description: 'Tests pass', kind: 'command' as const, command: 'npm test' }],
      maxAssignments: 2,
      maxRuntimeMs: 60_000,
    },
  ],
};

function harness(overrides: Partial<SupervisorDependencies> = {}) {
  const taskState = initialTaskState();
  const recoveryState = initialRecoveryState();
  const worker: SupervisorWorkerHandle = {
    task: {
      getStatus: vi.fn(() => structuredClone(taskState)),
      update: vi.fn(async () => structuredClone(taskState)),
      resume: vi.fn(async () => ({
        ...structuredClone(taskState),
        config: { ...taskState.config, enabled: true },
        phase: 'watching' as const,
        reason: 'kickoff-sent',
        kickoffAt: 10_000,
        inFlight: { key: 'task-kickoff', startedAt: 10_000 },
      })),
    },
    recovery: {
      getStatus: vi.fn(() => structuredClone(recoveryState)),
      inspect: vi.fn(async () => structuredClone(recoveryState)),
      retry: vi.fn(async () => structuredClone(recoveryState)),
    },
  };
  const saved: any[] = [];
  const deps: SupervisorDependencies = {
    validateWorkers: vi.fn(),
    worker: vi.fn(() => worker),
    persist: vi.fn(async (state) => {
      saved.push(structuredClone(state));
    }),
    withLeases: (fn) => fn(),
    leaseHolder: vi.fn(() => undefined),
    startManager: vi.fn(async () => true),
    pauseManager: vi.fn(async () => {}),
    resetManager: vi.fn(async () => {}),
    changed: vi.fn(),
    now: () => 10_000,
    ...overrides,
  };
  return { controller: new SupervisorController(deps, SUPERVISOR), deps, worker, saved, recoveryState, taskState };
}

describe('SupervisorController', () => {
  it('starts the real manager task, then assigns the exact owner-configured worker task once per durable request', async () => {
    const h = harness();
    await h.controller.configure(config);
    await h.controller.start();
    expect(h.deps.startManager).toHaveBeenCalledWith(config.objective, expect.any(Array), expect.any(Function), 10_000);
    await h.controller.assign(WORKER, 'request-0001');
    expect(h.worker.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        objective: 'Implement the parser',
        criteria: config.workers[0].criteria,
        config: { enabled: false, maxContinuations: 2, maxRuntimeMs: 60_000 },
      })
    );
    expect(h.worker.task.resume).toHaveBeenCalledTimes(1);
    await h.controller.assign(WORKER, 'request-0001');
    expect(h.worker.task.resume).toHaveBeenCalledTimes(1);
    await expect(h.controller.retry(WORKER, 'request-0001')).rejects.toThrow(/different operation/);
    expect(h.saved.some((s) => s.inFlight?.requestId === 'request-0001')).toBe(true);
  });

  it('does not mark the manager active until its guarded task kickoff is accepted', async () => {
    const h = harness({ startManager: vi.fn(async () => false) });
    await h.controller.configure(config);
    await expect(h.controller.start()).rejects.toThrow(/not ready/);
    expect(h.controller.getStatus()).toMatchObject({ phase: 'paused', reason: 'manager-start-refused' });
  });

  it.each(['owner-stricter', 'plan-stricter', 'same-inactive', 'new-task', 'claimed-completed'] as const)(
    'keeps the tighter actual worker task budgets for %s',
    async (caseName) => {
      const plan = {
        ...config,
        workers: config.workers.map((worker) => ({
          ...worker,
          criteria:
            caseName === 'claimed-completed'
              ? [{ id: 'review', description: 'Owner acceptance', kind: 'manual' as const }]
              : worker.criteria,
          maxAssignments: caseName === 'plan-stricter' ? 2 : 10,
          maxRuntimeMs: caseName === 'plan-stricter' ? 60_000 : 600_000,
        })),
      };
      let now = 9_000;
      let freshCompletionClaim = false;
      const act = vi.fn(async () => 'sent' as const);
      const task = new TaskController({
        now: () => now,
        observe: async () => ({
          observation: {
            activity: freshCompletionClaim ? 'working' : 'idle',
            reason: freshCompletionClaim ? 'turn-running' : 'observing',
            at: now,
            conversationId: WORKER,
            processReady: true,
            safeToAct: false,
            submissionKey: 'claimed-task-submission',
          },
          commands: new Map(),
          ...(freshCompletionClaim
            ? {
                marker: {
                  key: 'claimed-task-completion',
                  at: now,
                  submissionKey: 'claimed-task-submission',
                  progress: { outcome: 'completed' as const },
                },
              }
            : {}),
        }),
        act,
        persist: async () => {},
        changed: () => {},
      });
      const h = harness();
      h.worker.task = task;
      try {
        if (caseName !== 'new-task')
          await task.update({
            objective: plan.workers[0].task,
            criteria: plan.workers[0].criteria,
            config: {
              enabled: caseName !== 'same-inactive',
              maxContinuations: caseName === 'plan-stricter' ? 10 : 1,
              maxRuntimeMs: caseName === 'plan-stricter' ? 900_000 : 60_000,
            },
          });
        if (caseName === 'claimed-completed') {
          await task.progress({ outcome: 'unfinished', checkpoint: 'Pending owner acceptance', nextAction: 'Review' });
          await expect(task.progress({ outcome: 'completed' })).rejects.toThrow(/criteria remain unverified/);
          now = 10_000;
          freshCompletionClaim = true;
          await task.refresh();
          freshCompletionClaim = false;
          expect(task.getStatus()).toMatchObject({
            phase: 'watching',
            outcome: 'unknown',
            criteria: [{ kind: 'manual', verified: false }],
          });
        }
        now = 10_000;
        await h.controller.configure(plan);
        await h.controller.start();
        await h.controller.assign(WORKER, `request-budget-${caseName}`);
        expect(act).toHaveBeenCalledOnce();
        const expected =
          caseName === 'new-task'
            ? { maxContinuations: 10, maxRuntimeMs: 600_000 }
            : caseName === 'plan-stricter'
              ? { maxContinuations: 2, maxRuntimeMs: 60_000 }
              : { maxContinuations: 1, maxRuntimeMs: 60_000 };
        expect(task.getStatus()).toMatchObject({
          phase: 'watching',
          config: { enabled: true, ...expected },
          startedAt: caseName === 'new-task' || caseName === 'same-inactive' ? 10_000 : 9_000,
        });
      } finally {
        task.stop();
        h.controller.stop();
      }
    }
  );

  it.each(['paused', 'blocked', 'other-task', 'owner-cleared'] as const)(
    'preserves actual worker task ownership for %s before a manager assignment',
    async (state) => {
      const act = vi.fn(async () => 'sent' as const);
      const task = new TaskController({
        now: () => 10_000,
        observe: async () => ({
          observation: {
            activity: 'idle',
            reason: 'observing',
            at: 10_000,
            conversationId: WORKER,
            processReady: true,
            safeToAct: false,
          },
          commands: new Map(),
        }),
        act,
        persist: async () => {},
        changed: () => {},
      });
      const h = harness();
      h.worker.task = task;
      try {
        await task.update({
          objective: 'The owner worker objective',
          criteria: [{ id: 'review', description: 'Owner acceptance', kind: 'manual' }],
          config: { enabled: true },
        });
        if (state === 'blocked') await task.progress({ outcome: 'blocked', checkpoint: 'Owner decision needed' });
        else if (state !== 'other-task') await task.pause();
        if (state === 'owner-cleared') await task.reset();
        const before = task.getStatus();
        await h.controller.configure(config);
        await h.controller.start();
        const assigning = h.controller.assign(WORKER, `request-owner-${state}`);
        if (state === 'owner-cleared') {
          await assigning;
          expect(act).toHaveBeenCalledOnce();
          expect(task.getStatus()).toMatchObject({ objective: config.workers[0].task, phase: 'watching' });
        } else {
          await expect(assigning).rejects.toThrow(/cancelled|owner attention/);
          expect(act).not.toHaveBeenCalled();
          expect(task.getStatus()).toEqual(before);
          expect(h.controller.getStatus().inFlight).toBeUndefined();
          expect(h.controller.getStatus().workers[0].assignments).toBe(0);
        }
      } finally {
        task.stop();
        h.controller.stop();
      }
    }
  );

  it.each(['assign', 'retry'] as const)(
    'keeps task/recovery attention vetoes for manager %s until the owner clears them',
    async (action) => {
      for (const domain of ['task-pause', 'task-block', 'recovery-pause', 'recovery-block'] as const) {
        const h = harness();
        if (domain === 'task-pause') h.taskState.phase = 'paused';
        else if (domain === 'task-block') h.taskState.phase = 'blocked';
        else if (domain === 'recovery-pause') h.recoveryState.phase = 'paused';
        else h.recoveryState.phase = 'blocked';
        await h.controller.configure(config);
        await h.controller.start();
        await expect(h.controller[action](WORKER, `request-${action}-${domain}`)).rejects.toThrow(
          /cancelled|owner attention/
        );
        expect(h.worker.task.update).not.toHaveBeenCalled();
        expect(h.worker.task.resume).not.toHaveBeenCalled();
        expect(h.worker.recovery.retry).not.toHaveBeenCalled();
        expect(h.controller.getStatus().workers[0].assignments).toBe(0);
      }
    }
  );

  it.each(['assign', 'retry'] as const)(
    'rechecks worker owner pause after the durable %s reservation',
    async (action) => {
      const h = harness();
      h.recoveryState.activity = 'crashed';
      vi.mocked(h.deps.persist).mockImplementation(async (snapshot) => {
        if (snapshot.reason === `${action}-reserved`) h.taskState.phase = 'paused';
      });
      await h.controller.configure(config);
      await h.controller.start();
      await expect(h.controller[action](WORKER, `request-race-${action}`)).rejects.toThrow(/cancelled/);
      expect(h.worker.task.update).not.toHaveBeenCalled();
      expect(h.worker.task.resume).not.toHaveBeenCalled();
      expect(h.worker.recovery.retry).not.toHaveBeenCalled();
      expect(h.controller.getStatus().inFlight).toBeUndefined();
      expect(h.controller.getStatus().workers[0].assignments).toBe(0);
    }
  );

  it('does not resume a worker paused while assignment configuration is saved', async () => {
    const h = harness();
    vi.mocked(h.worker.task.update).mockImplementationOnce(async () => {
      h.taskState.phase = 'paused';
      return structuredClone(h.taskState);
    });
    await h.controller.configure(config);
    await h.controller.start();
    await expect(h.controller.assign(WORKER, 'request-worker-paused-update')).rejects.toThrow(/cancelled/);
    expect(h.worker.task.resume).not.toHaveBeenCalled();
    expect(h.controller.getStatus().inFlight).toBeUndefined();
    expect(h.controller.getStatus().workers[0].assignments).toBe(0);
  });

  it('refuses to reassign the same verified completed task until the owner changes the plan', async () => {
    const h = harness();
    h.taskState.objective = config.workers[0].task;
    h.taskState.outcome = 'completed';
    h.taskState.phase = 'completed';
    h.taskState.criteria = config.workers[0].criteria.map((criterion) => ({
      ...criterion,
      verified: true,
      evidence: { source: 'command' as const, at: 9_000, commandHash: 'verified' },
    }));
    await h.controller.configure(config);
    await h.controller.start();
    await expect(h.controller.assign(WORKER, 'request-done1')).rejects.toThrow(/already completed/);
    expect(h.worker.task.update).not.toHaveBeenCalled();
    expect(h.controller.getStatus()).toMatchObject({ phase: 'active', handledRequestIds: [] });
  });

  it('refuses a second manager kickoff while the supervisor is already active', async () => {
    const h = harness();
    await h.controller.configure(config);
    await h.controller.start();
    await expect(h.controller.start()).rejects.toThrow(/already active/);
    expect(h.deps.startManager).toHaveBeenCalledTimes(1);
  });

  it('pauses and resets the manager task controller when the owner revokes the role', async () => {
    const h = harness();
    await h.controller.configure(config);
    await h.controller.start();
    await h.controller.pause();
    expect(h.deps.pauseManager).toHaveBeenCalled();
    await h.controller.reset();
    expect(h.deps.resetManager).toHaveBeenCalledOnce();
    expect(h.controller.getStatus()).toMatchObject({ enabled: false, phase: 'disabled' });
  });

  it('keeps an uncertain dispatch reservation and pauses instead of replaying', async () => {
    const h = harness();
    await h.controller.configure(config);
    await h.controller.start();
    vi.mocked(h.worker.task.resume).mockRejectedValueOnce(new Error('lost response'));
    await expect(h.controller.assign(WORKER, 'request-0002')).rejects.toThrow();
    expect(h.controller.getStatus()).toMatchObject({
      phase: 'paused',
      reason: 'assign-uncertain',
      inFlight: { requestId: 'request-0002' },
    });
    await expect(h.controller.assign(WORKER, 'request-0003')).rejects.toThrow(/not active/);
  });

  it('exposes no manager-authored worker progress operation', async () => {
    const h = harness();
    await h.controller.configure(config);
    await h.controller.start();
    expect('report' in h.controller).toBe(false);
  });

  it('retries only through recovery and refuses clean exits and ineffective retries', async () => {
    const h = harness();
    await h.controller.configure(config);
    await h.controller.start();
    h.recoveryState.activity = 'exited';
    h.recoveryState.lastReason = 'clean-exit';
    await expect(h.controller.retry(WORKER, 'request-0004')).rejects.toThrow(/retryable crash/);
    expect(h.worker.recovery.retry).not.toHaveBeenCalled();
  });

  it('restores enabled supervisors paused and never replays an in-flight operation', async () => {
    const h = harness();
    await h.controller.configure(config);
    await h.controller.start();
    vi.mocked(h.worker.task.resume).mockRejectedValueOnce(new Error('uncertain'));
    await expect(h.controller.assign(WORKER, 'request-0005')).rejects.toThrow();
    const restored = new SupervisorController(h.deps, SUPERVISOR, h.controller.getStatus());
    expect(restored.getStatus()).toMatchObject({ phase: 'paused', reason: 'restart-in-flight' });
    expect(h.worker.task.resume).toHaveBeenCalledTimes(1);
  });

  it('serializes durable leases so two supervisors cannot claim one worker in a race', async () => {
    const records = new Map<string, any>();
    let leaseQueue: Promise<unknown> = Promise.resolve();
    const withLeases = <T>(fn: () => Promise<T>) => {
      const result = leaseQueue.then(fn, fn);
      leaseQueue = result.catch(() => {});
      return result;
    };
    const make = (id: string) => {
      const h = harness({
        withLeases,
        persist: async (state) => {
          records.set(id, structuredClone(state));
        },
        leaseHolder: (workerId, excluding) =>
          [...records.values()].find(
            (state) =>
              state.supervisorSessionId !== excluding &&
              state.enabled &&
              state.workers.some((worker: any) => worker.sessionId === workerId)
          )?.supervisorSessionId,
      });
      return new SupervisorController(h.deps, id);
    };
    const a = make('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const b = make('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    const outcomes = await Promise.allSettled([a.configure(config), b.configure(config)]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('fails closed with the durable reservation intact when the completion write fails', async () => {
    let writes = 0;
    const h = harness({
      persist: vi.fn(async () => {
        if (++writes === 5) throw new Error('disk full');
      }),
    });
    await h.controller.configure(config); // 1
    await h.controller.start(); // 2,3
    await expect(h.controller.assign(WORKER, 'request-0006')).rejects.toThrow(/could not be saved/); // 4 reserve, 5 completion
    expect(h.controller.getStatus()).toMatchObject({
      phase: 'blocked',
      reason: 'persistence-failed',
      inFlight: { requestId: 'request-0006' },
    });
    await expect(h.controller.assign(WORKER, 'request-0007')).rejects.toThrow(/not active/);
    expect(h.worker.task.resume).toHaveBeenCalledTimes(1);
  });

  it('revalidates live worker eligibility after reserving and before dispatch', async () => {
    const h = harness();
    await h.controller.configure(config);
    await h.controller.start();
    vi.mocked(h.deps.validateWorkers).mockImplementationOnce(() => {
      throw new SupervisorValidationError('worker deleted');
    });
    await expect(h.controller.assign(WORKER, 'request-0008')).rejects.toThrow(/eligibility changed/);
    expect(h.worker.task.update).not.toHaveBeenCalled();
    expect(h.controller.getStatus().inFlight).toBeUndefined();
  });

  it('does not certify an operational eligibility lookup failure as an unsent refusal', async () => {
    const h = harness();
    await h.controller.configure(config);
    await h.controller.start();
    const failure = new Error('journal lookup failed');
    vi.mocked(h.deps.validateWorkers).mockImplementationOnce(() => {
      throw failure;
    });

    await expect(h.controller.assign(WORKER, 'request-lookup-failed')).rejects.toBe(failure);

    expect(h.worker.task.update).not.toHaveBeenCalled();
    expect(h.controller.getStatus()).toMatchObject({
      phase: 'paused',
      reason: 'assign-uncertain',
      inFlight: { requestId: 'request-lookup-failed' },
    });
  });

  it('cancels before worker kickoff when an owner pause arrives during task configuration', async () => {
    const h = harness();
    await h.controller.configure(config);
    await h.controller.start();
    let release!: () => void;
    vi.mocked(h.worker.task.update).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(initialTaskState());
        })
    );
    const assigning = h.controller.assign(WORKER, 'request-0009');
    await vi.waitFor(() => expect(h.worker.task.update).toHaveBeenCalled());
    const pausing = h.controller.pause();
    release();
    await expect(assigning).rejects.toThrow(/cancelled/);
    await pausing;
    expect(h.worker.task.resume).not.toHaveBeenCalled();
    expect(h.controller.getStatus().phase).toBe('paused');
    expect(h.controller.getStatus().inFlight).toBeUndefined();
  });

  it('propagates owner pause through a real worker task observation before dispatch', async () => {
    let release!: (value: TaskObservation) => void;
    let entered!: () => void;
    const observing = new Promise<void>((resolve) => (entered = resolve));
    const act = vi.fn(async () => 'sent' as const);
    const task = new TaskController({
      now: () => 10_000,
      observe: () =>
        new Promise((resolve) => {
          release = resolve;
          entered();
        }),
      act,
      persist: async () => {},
      changed: () => {},
    });
    const base = harness();
    const realWorker: SupervisorWorkerHandle = { ...base.worker, task };
    const controller = new SupervisorController({ ...base.deps, worker: () => realWorker }, SUPERVISOR);
    await controller.configure(config);
    await controller.start();
    const assigning = controller.assign(WORKER, 'request-real-task');
    await observing;
    const pausing = controller.pause();
    release({
      observation: {
        activity: 'idle',
        reason: 'observing',
        at: 10_000,
        conversationId: WORKER,
        processReady: true,
        safeToAct: false,
      },
      commands: new Map(),
    });
    await expect(assigning).rejects.toThrow(/cancelled/);
    await pausing;
    expect(act).not.toHaveBeenCalled();
    expect(task.getStatus()).toMatchObject({ phase: 'paused', reason: 'delivery-cancelled' });
    expect(task.getStatus().inFlight).toBeUndefined();
    expect(controller.getStatus().phase).toBe('paused');
    expect(controller.getStatus().inFlight).toBeUndefined();
    task.stop();
  });

  it('retains the supervisor reservation when cancellation races a possibly sent worker kickoff', async () => {
    const h = harness();
    let release!: () => void;
    let entered!: () => void;
    const dispatching = new Promise<void>((resolve) => (entered = resolve));
    vi.mocked(h.worker.task.resume).mockImplementationOnce(async () => {
      entered();
      await new Promise<void>((resolve) => (release = resolve));
      return {
        ...initialTaskState(),
        phase: 'paused',
        inFlight: { key: 'possibly-sent', startedAt: 10_000 },
      };
    });
    await h.controller.configure(config);
    await h.controller.start();
    const assigning = h.controller.assign(WORKER, 'request-uncertain-cancel');
    await dispatching;
    const pausing = h.controller.pause();
    release();
    await expect(assigning).rejects.toThrow(/may have started/);
    await pausing;
    expect(h.controller.getStatus().phase).toBe('paused');
    expect(h.controller.getStatus().inFlight).toMatchObject({ requestId: 'request-uncertain-cancel' });
    expect(h.controller.getStatus().handledRequestIds).not.toContain('request-uncertain-cancel');
  });

  it('pauses with both reservations intact when a real worker kickoff has an unknown delivery', async () => {
    const task = new TaskController({
      now: () => 10_000,
      observe: async () => ({
        observation: {
          activity: 'idle',
          reason: 'observing',
          at: 10_000,
          conversationId: WORKER,
          processReady: true,
          safeToAct: true,
        },
        commands: new Map(),
      }),
      act: async () => 'unknown',
      persist: async () => {},
      changed: () => {},
    });
    const base = harness();
    const worker: SupervisorWorkerHandle = { ...base.worker, task };
    const controller = new SupervisorController({ ...base.deps, worker: () => worker }, SUPERVISOR);
    await controller.configure(config);
    await controller.start();

    await expect(controller.assign(WORKER, 'request-task-unknown')).rejects.toThrow(/acceptance is uncertain/);

    expect(task.getStatus()).toMatchObject({ phase: 'paused', reason: 'delivery-unknown' });
    expect(task.getStatus().inFlight).toBeDefined();
    expect(controller.getStatus()).toMatchObject({
      phase: 'paused',
      reason: 'assign-uncertain',
      inFlight: { requestId: 'request-task-unknown' },
      handledRequestIds: [],
      workers: [{ assignments: 0 }],
    });
    task.stop();
  });

  it('accepts a known-sent real worker kickoff and lets its future poll verify delivery', async () => {
    let observation: RecoveryObservation = {
      activity: 'idle',
      reason: 'observing',
      at: 10_000,
      conversationId: WORKER,
      submissionKey: 'before-kickoff',
      processReady: true,
      safeToAct: true,
    };
    const task = new TaskController({
      now: () => 10_000,
      observe: async () => ({ observation, commands: new Map() }),
      act: async () => 'sent',
      persist: async () => {},
      changed: () => {},
    });
    const base = harness();
    const worker: SupervisorWorkerHandle = { ...base.worker, task };
    const controller = new SupervisorController({ ...base.deps, worker: () => worker }, SUPERVISOR);
    await controller.configure(config);
    await controller.start();

    await controller.assign(WORKER, 'request-task-sent');
    const flight = task.getStatus().inFlight!;
    expect(task.getStatus()).toMatchObject({ phase: 'watching', reason: 'kickoff-sent' });
    expect(controller.getStatus()).toMatchObject({
      phase: 'active',
      handledRequestIds: ['request-task-sent'],
      workers: [{ assignments: 1 }],
    });

    observation = {
      activity: 'working',
      reason: 'turn-running',
      at: 10_001,
      conversationId: WORKER,
      submissionKey: 'accepted-kickoff',
      submissionHash: flight.promptHash,
      processReady: true,
      safeToAct: false,
    };
    await task.refresh();
    expect(task.getStatus()).toMatchObject({ phase: 'watching', reason: 'continuation-accepted' });
    expect(task.getStatus().inFlight).toBeUndefined();
    task.stop();
  });

  it('pauses manager startup when its real task kickoff has an unknown delivery', async () => {
    const managerTask = new TaskController({
      now: () => 10_000,
      observe: async () => ({
        observation: {
          activity: 'idle',
          reason: 'observing',
          at: 10_000,
          conversationId: SUPERVISOR,
          processReady: true,
          safeToAct: true,
        },
        commands: new Map(),
      }),
      act: async () => 'unknown',
      persist: async () => {},
      changed: () => {},
    });
    const h = harness({
      startManager: async (objective, _workers, isCurrent, runtimeStartedAt) => {
        await managerTask.update(buildSupervisorManagerTask(objective));
        const outcome = classifyTaskKickoff(await managerTask.resume(isCurrent, runtimeStartedAt));
        if (outcome === 'uncertain') throw new Error('Manager task delivery acceptance is uncertain');
        return outcome === 'accepted';
      },
    });
    await h.controller.configure(config);

    await expect(h.controller.start()).rejects.toThrow(/acceptance is uncertain/);

    expect(managerTask.getStatus()).toMatchObject({ phase: 'paused', reason: 'delivery-unknown' });
    expect(managerTask.getStatus().inFlight).toBeDefined();
    expect(h.controller.getStatus()).toMatchObject({ phase: 'paused', reason: 'manager-start-uncertain' });
    expect(h.controller.getStatus().history.map((entry) => entry.reason)).not.toContain('owner-started');
    managerTask.stop();
  });

  it('propagates owner pause through a real manager task startup', async () => {
    let release!: (value: TaskObservation) => void;
    let entered!: () => void;
    const observing = new Promise<void>((resolve) => (entered = resolve));
    const act = vi.fn(async () => 'sent' as const);
    const managerTask = new TaskController({
      now: () => 10_000,
      observe: () =>
        new Promise((resolve) => {
          release = resolve;
          entered();
        }),
      act,
      persist: async () => {},
      changed: () => {},
    });
    const h = harness({
      startManager: async (objective, _workers, isCurrent, runtimeStartedAt) => {
        await managerTask.update(buildSupervisorManagerTask(objective));
        if (!isCurrent()) return false;
        const started = await managerTask.resume(isCurrent, runtimeStartedAt);
        if (!isCurrent()) {
          if (started.inFlight) throw new Error('Manager delivery is uncertain');
          return false;
        }
        return classifyTaskKickoff(started) === 'accepted';
      },
      pauseManager: () => managerTask.pause().then(() => {}),
    });
    await h.controller.configure(config);
    const starting = h.controller.start();
    await observing;
    const pausing = h.controller.pause();
    release({
      observation: {
        activity: 'idle',
        reason: 'observing',
        at: 10_000,
        conversationId: SUPERVISOR,
        processReady: true,
        safeToAct: false,
      },
      commands: new Map(),
    });
    await expect(starting).rejects.toThrow(/not ready/);
    await pausing;
    expect(act).not.toHaveBeenCalled();
    expect(managerTask.getStatus()).toMatchObject({ phase: 'paused' });
    managerTask.stop();
  });

  it('propagates owner pause through a real recovery retry observation', async () => {
    const crash: RecoveryObservation = {
      activity: 'crashed',
      reason: 'process-crashed',
      at: 10_000,
      conversationId: WORKER,
      evidenceKey: 'worker-crash',
      safeToAct: true,
    };
    let calls = 0;
    let release!: (value: RecoveryObservation) => void;
    let entered!: () => void;
    const observing = new Promise<void>((resolve) => (entered = resolve));
    const act = vi.fn(async () => 'sent' as const);
    const recovery = new RecoveryController({
      now: () => 10_000,
      observe: async () => {
        if (++calls === 1) return crash;
        entered();
        return new Promise((resolve) => (release = resolve));
      },
      act,
      persist: async () => {},
      changed: () => {},
    });
    const base = harness();
    const realWorker: SupervisorWorkerHandle = { ...base.worker, recovery };
    const controller = new SupervisorController({ ...base.deps, worker: () => realWorker }, SUPERVISOR);
    await controller.configure(config);
    await controller.start();
    const retrying = controller.retry(WORKER, 'request-real-retry');
    await observing;
    const pausing = controller.pause();
    release(crash);
    await expect(retrying).rejects.toThrow(/cancelled/);
    await pausing;
    expect(act).not.toHaveBeenCalled();
    expect(recovery.getStatus().attempts).toBe(0);
    expect(recovery.getStatus().inFlight).toBeUndefined();
    expect(controller.getStatus().phase).toBe('paused');
    expect(controller.getStatus().inFlight).toBeUndefined();
    recovery.stop();
  });

  it.each([
    {
      delivery: 'unknown' as const,
      requestId: 'request-retry-unknown',
      supervisorPhase: 'paused',
      supervisorReason: 'retry-uncertain',
      controllerReason: 'acceptance-unverified',
      retainsSupervisorFlight: true,
      retainsRecoveryFlight: true,
      accepted: false,
    },
    {
      delivery: 'not-sent' as const,
      requestId: 'request-retry-refused',
      supervisorPhase: 'active',
      supervisorReason: 'retry-refused',
      controllerReason: 'delivery-failed',
      retainsSupervisorFlight: false,
      retainsRecoveryFlight: false,
      accepted: false,
    },
    {
      delivery: 'sent' as const,
      requestId: 'request-retry-sent',
      supervisorPhase: 'active',
      supervisorReason: 'retry-accepted',
      controllerReason: 'process-resumed',
      retainsSupervisorFlight: false,
      retainsRecoveryFlight: true,
      accepted: true,
    },
  ])(
    'classifies a real recovery $delivery result without false acknowledgement',
    async ({
      delivery,
      requestId,
      supervisorPhase,
      supervisorReason,
      controllerReason,
      retainsSupervisorFlight,
      retainsRecoveryFlight,
      accepted,
    }) => {
      let observation: RecoveryObservation = {
        activity: 'crashed',
        reason: 'process-crashed',
        at: 10_000,
        conversationId: WORKER,
        evidenceKey: `crash-${delivery}`,
        processReady: false,
        safeToAct: true,
      };
      const recovery = new RecoveryController({
        now: () => 10_000,
        observe: async () => observation,
        act: async () => delivery,
        persist: async () => {},
        changed: () => {},
      });
      const base = harness();
      const worker: SupervisorWorkerHandle = { ...base.worker, recovery };
      const controller = new SupervisorController({ ...base.deps, worker: () => worker }, SUPERVISOR);
      await controller.configure(config);
      await controller.start();

      const retry = controller.retry(WORKER, requestId);
      if (accepted) await retry;
      else await expect(retry).rejects.toThrow(delivery === 'unknown' ? /acceptance is uncertain/ : /refused/);

      expect(recovery.getStatus()).toMatchObject({
        attempts: 1,
        failedAttempts: delivery === 'sent' ? 0 : 1,
        lastReason: controllerReason,
      });
      expect(!!recovery.getStatus().inFlight).toBe(retainsRecoveryFlight);
      expect(controller.getStatus()).toMatchObject({
        phase: supervisorPhase,
        reason: supervisorReason,
        handledRequestIds: accepted ? [requestId] : [],
        workers: [{ assignments: accepted ? 1 : 0 }],
      });
      expect(!!controller.getStatus().inFlight).toBe(retainsSupervisorFlight);

      if (delivery === 'sent') {
        observation = {
          activity: 'idle',
          reason: 'observing',
          at: 10_001,
          conversationId: WORKER,
          processReady: true,
          safeToAct: false,
        };
        await recovery.inspect();
        expect(recovery.getStatus()).toMatchObject({ phase: 'watching', lastReason: 'recovery-accepted' });
        expect(recovery.getStatus().inFlight).toBeUndefined();
      }
      recovery.stop();
    }
  );

  it('never evicts accepted request ids; a full bounded journal refuses new dispatch until owner reset', async () => {
    const h = harness();
    await h.controller.configure(config);
    await h.controller.start();
    const restored = h.controller.getStatus();
    restored.handledRequestIds = Array.from({ length: 128 }, (_, i) => `request-${String(i).padStart(4, '0')}`);
    const full = new SupervisorController(h.deps, SUPERVISOR, restored);
    await full.start();
    await expect(full.assign(WORKER, 'request-new1')).rejects.toThrow(/journal is full/);
    expect(h.worker.task.update).not.toHaveBeenCalled();
    expect(full.getStatus().handledRequestIds).toHaveLength(128);
  });

  it('deduplicates overlapping worker inspection and returns bounded stale evidence at an expired deadline', async () => {
    let release!: (state: ReturnType<typeof initialRecoveryState>) => void;
    const h = harness({ inspectionTimeoutMs: 1000, inspectionConcurrency: 1 });
    vi.mocked(h.worker.recovery.inspect).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    await h.controller.configure(config);
    await h.controller.start();

    const firstRead = h.controller.inspectWorkers();
    const duplicateRead = h.controller.inspectWorkers();
    await vi.waitFor(() => expect(h.worker.recovery.inspect).toHaveBeenCalledTimes(1));
    release(initialRecoveryState());
    const [first, duplicate] = await Promise.all([firstRead, duplicateRead]);
    expect(h.worker.recovery.inspect).toHaveBeenCalledTimes(1);
    expect(first).toEqual(duplicate);
    expect(first[0]).toMatchObject({ sessionId: WORKER, health: 'unknown', stale: false });

    const expired = harness({ inspectionTimeoutMs: 0, inspectionConcurrency: 1 });
    await expired.controller.configure(config);
    await expired.controller.start();
    expect((await expired.controller.inspectWorkers())[0]).toMatchObject({ health: 'unknown', stale: true });
    expect(expired.worker.recovery.inspect).not.toHaveBeenCalled();
  });

  it('keeps the largest valid owner objective inside the guarded manager task schema', () => {
    const maximal = { ...config, objective: 'x'.repeat(3000) };
    expect(SupervisorConfigSchema.parse(maximal).objective).toHaveLength(3000);
    const task = buildSupervisorManagerTask(maximal.objective);
    expect(task.objective).toContain(maximal.objective);
    expect(task.objective?.length).toBeLessThanOrEqual(4000);
    expect(task.objective).toContain('codeman agent supervisor workers');
  });

  describe('worker runtime authority', () => {
    async function runtimeHarness(
      options: {
        expireAt?: string;
        firstOperation?: boolean;
        startedAt?: number;
        initialNow?: number;
        assignments?: number;
        delivery?: 'sent' | 'unknown';
      } = {}
    ) {
      const origin = options.firstOperation ? undefined : (options.startedAt ?? 10_000);
      const deadline = (origin ?? 10_000) + 1000;
      let now = options.initialNow ?? (origin === undefined ? 10_000 : origin + 500);
      let armed = false;
      let effects = 0;
      let observations = 0;
      let taskObservation: TaskObservation | undefined;
      const boundary = (name: string) => {
        if (armed && options.expireAt === name) now = deadline;
      };
      const act = vi.fn(async (isCurrent: () => boolean) => {
        expect(isCurrent()).toBe(true);
        boundary('adapter-preflight');
        if (!isCurrent()) return 'not-sent' as const;
        effects++;
        boundary('delivery-completion');
        return options.delivery ?? ('sent' as const);
      });
      const task = new TaskController({
        now: () => now,
        observe: async () => {
          boundary('task-observation');
          if (taskObservation) return taskObservation;
          return {
            observation: {
              activity: 'idle',
              reason: 'observing',
              at: now,
              conversationId: WORKER,
              processReady: true,
              safeToAct: true,
            },
            commands: new Map(),
          };
        },
        act: (_key, _conversationId, _prompt, isCurrent) => act(isCurrent),
        persist: async (state) => {
          if (state.reason === 'configured') boundary('task-update');
          if (state.reason === 'kickoff-reserved') boundary('task-reservation');
          if (state.reason === 'kickoff-sent') boundary('task-acceptance-save');
        },
        changed: () => {},
      });
      const recovery = new RecoveryController({
        now: () => now,
        observe: async () => {
          boundary(++observations === 1 ? 'recovery-inspect' : 'recovery-observation');
          return {
            activity: 'crashed',
            reason: 'process-crashed',
            at: now,
            conversationId: WORKER,
            evidenceKey: 'runtime-worker-crash',
            safeToAct: true,
          };
        },
        act: (_flight, isCurrent) => act(isCurrent),
        persist: async (state) => {
          if (state.pending) boundary('recovery-schedule');
          else if (state.inFlight) boundary('recovery-reservation');
          else if (observations === 1) boundary('recovery-inspect-save');
          if (state.lastReason === 'process-resumed') boundary('recovery-acceptance-save');
        },
        changed: () => {},
      });
      const base = harness({
        now: () => now,
        worker: () => ({ task, recovery }),
        persist: async (state) => {
          base.saved.push(structuredClone(state));
          if (state.reason === 'assign-reserved' || state.reason === 'retry-reserved')
            boundary('supervisor-reservation');
        },
      });
      await base.controller.configure({
        ...config,
        workers: config.workers.map((worker) => ({ ...worker, maxRuntimeMs: 1000 })),
      });
      const restored = base.controller.getStatus();
      restored.workers[0].startedAt = origin;
      restored.workers[0].assignments = options.assignments ?? (origin === undefined ? 0 : 1);
      const controller = new SupervisorController(base.deps, SUPERVISOR, restored);
      await controller.start();
      base.saved.length = 0;
      armed = true;
      return {
        controller,
        task,
        recovery,
        act,
        saved: base.saved,
        effects: () => effects,
        setNow: (value: number) => {
          now = value;
        },
        setTaskObservation: (value: TaskObservation) => {
          taskObservation = value;
        },
        stop: () => {
          controller.stop();
          task.stop();
          recovery.stop();
        },
      };
    }

    it.each([
      ['assign', 'supervisor-reservation'],
      ['assign', 'task-update'],
      ['assign', 'task-observation'],
      ['assign', 'task-reservation'],
      ['retry', 'recovery-inspect'],
      ['retry', 'recovery-inspect-save'],
      ['retry', 'supervisor-reservation'],
      ['retry', 'recovery-observation'],
      ['retry', 'recovery-schedule'],
      ['retry', 'recovery-reservation'],
    ] as const)('refuses %s when %s reaches the worker deadline', async (action, expireAt) => {
      const h = await runtimeHarness({ expireAt });
      try {
        await expect(h.controller[action](WORKER, `request-runtime-${action}`)).rejects.toThrow(
          /budget exhausted|cancelled/
        );
        expect(h.act).not.toHaveBeenCalled();
        expect(h.task.getStatus().inFlight).toBeUndefined();
        expect(h.recovery.getStatus()).toMatchObject({ attempts: 0 });
        expect(h.recovery.getStatus().inFlight).toBeUndefined();
        expect(h.recovery.getStatus().pending).toBeUndefined();
        expect(h.controller.getStatus()).toMatchObject({
          phase: 'active',
          handledRequestIds: [],
          workers: [{ assignments: 1, startedAt: 10_000 }],
        });
        expect(h.controller.getStatus().inFlight).toBeUndefined();
        if (expireAt.startsWith('recovery-inspect'))
          expect(h.saved.some((state) => state.reason === 'retry-reserved')).toBe(false);
      } finally {
        h.stop();
      }
    });

    it.each([
      ['assign', 'task-update'],
      ['retry', 'recovery-inspect'],
    ] as const)('counts first %s preflight time before %s completes', async (action, expireAt) => {
      const h = await runtimeHarness({ firstOperation: true, expireAt });
      try {
        await expect(h.controller[action](WORKER, 'request-first-expired')).rejects.toThrow(
          /budget exhausted|cancelled/
        );
        expect(h.act).not.toHaveBeenCalled();
        expect(h.controller.getStatus().workers[0]).toMatchObject({ assignments: 0 });
        expect(h.controller.getStatus().workers[0].startedAt).toBeUndefined();
        expect(h.controller.getStatus().inFlight).toBeUndefined();
      } finally {
        h.stop();
      }
    });

    it.each(['assign', 'retry'] as const)(
      'honors a zero runtime origin and the assignment cap for %s',
      async (action) => {
        for (const options of [{ startedAt: 0, initialNow: 1000 }, { assignments: 2 }]) {
          const h = await runtimeHarness(options);
          try {
            await expect(h.controller[action](WORKER, 'request-budget-exhausted')).rejects.toThrow(/budget exhausted/);
            expect(h.act).not.toHaveBeenCalled();
            expect(h.saved).toHaveLength(0);
          } finally {
            h.stop();
          }
        }
      }
    );

    it.each(['assign', 'retry'] as const)(
      'refuses %s when a saved worker origin is in the future or invalid',
      async (action) => {
        for (const options of [
          { startedAt: 10_000, initialNow: 9999 },
          { startedAt: -1, initialNow: 0 },
        ]) {
          const h = await runtimeHarness(options);
          try {
            await expect(h.controller[action](WORKER, 'request-clock-regression')).rejects.toThrow(/budget exhausted/);
            expect(h.act).not.toHaveBeenCalled();
            expect(h.controller.getStatus().inFlight).toBeUndefined();
          } finally {
            h.stop();
          }
        }
      }
    );

    it.each(['assign', 'retry'] as const)(
      'releases only a certified unsent %s after adapter preflight expiry',
      async (action) => {
        const h = await runtimeHarness({ expireAt: 'adapter-preflight' });
        try {
          await expect(h.controller[action](WORKER, 'request-adapter-expired')).rejects.toThrow(/cancelled/);
          expect(h.act).toHaveBeenCalledOnce();
          expect(h.effects()).toBe(0);
          expect(h.task.getStatus().inFlight).toBeUndefined();
          expect(h.recovery.getStatus()).toMatchObject({ attempts: 0 });
          expect(h.recovery.getStatus().inFlight).toBeUndefined();
          expect(h.controller.getStatus()).toMatchObject({
            phase: 'active',
            reason: `${action}-refused`,
            workers: [{ assignments: 1 }],
          });
          expect(h.controller.getStatus().inFlight).toBeUndefined();
        } finally {
          h.stop();
        }
      }
    );

    it.each([
      ['assign', 'sent', 'delivery-completion'],
      ['assign', 'unknown', 'delivery-completion'],
      ['retry', 'sent', 'delivery-completion'],
      ['retry', 'unknown', 'delivery-completion'],
      ['assign', 'sent', 'task-acceptance-save'],
      ['retry', 'sent', 'recovery-acceptance-save'],
    ] as const)(
      'retains both %s reservations when %s reaches %s after the deadline',
      async (action, delivery, expireAt) => {
        const h = await runtimeHarness({ expireAt, delivery });
        try {
          await expect(h.controller[action](WORKER, 'request-late-delivery')).rejects.toThrow(/may have started/);
          expect(h.act).toHaveBeenCalledOnce();
          expect(h.act.mock.calls[0][0]()).toBe(false);
          expect((action === 'assign' ? h.task : h.recovery).getStatus().inFlight).toBeDefined();
          expect(h.controller.getStatus()).toMatchObject({
            phase: 'paused',
            reason: `${action}-uncertain`,
            inFlight: { requestId: 'request-late-delivery' },
            handledRequestIds: [],
            workers: [{ assignments: 1, startedAt: 10_000 }],
          });
        } finally {
          h.stop();
        }
      }
    );

    it.each(['assign', 'retry'] as const)('persists the first %s runtime origin after acceptance', async (action) => {
      const h = await runtimeHarness({ firstOperation: true });
      try {
        h.act.mockImplementationOnce(async (isCurrent) => {
          h.setNow(10_800);
          expect(isCurrent()).toBe(true);
          return 'sent';
        });
        await h.controller[action](WORKER, 'request-origin-accepted');
        expect(h.controller.getStatus().workers[0]).toMatchObject({ assignments: 1, startedAt: 10_000 });
        expect(h.saved.at(-1).workers[0].startedAt).toBe(10_000);
        h.setNow(11_000);
        await expect(h.controller[action](WORKER, 'request-origin-expired')).rejects.toThrow(/budget exhausted/);
        expect(h.act).toHaveBeenCalledOnce();
      } finally {
        h.stop();
      }
    });

    it.each([-1, 0])('bounds later worker continuations at the shared plan deadline (%s ms)', async (offset) => {
      const h = await runtimeHarness();
      try {
        await h.controller.assign(WORKER, 'request-late-kickoff');
        expect(h.task.getStatus().startedAt).toBe(10_000);
        const flight = h.task.getStatus().inFlight!;
        h.setNow(10_600);
        const accepted: RecoveryObservation = {
          activity: 'working',
          reason: 'turn-running',
          at: 10_600,
          conversationId: WORKER,
          submissionKey: 'accepted-kickoff',
          submissionHash: flight.promptHash,
          processReady: true,
          safeToAct: false,
        };
        h.setTaskObservation({ observation: accepted, commands: new Map() });
        await h.task.refresh();
        expect(h.task.getStatus().inFlight).toBeUndefined();
        const at = 11_000 + offset;
        h.setNow(at);
        h.setTaskObservation({
          observation: { ...accepted, activity: 'completed', reason: 'turn-completed', at, turnId: 'finished-turn' },
          commands: new Map(),
          marker: {
            key: 'fresh-worker-progress',
            at,
            submissionKey: 'accepted-kickoff',
            progress: { outcome: 'unfinished', checkpoint: 'Parser implemented', nextAction: 'Run the check' },
          },
        });
        await h.task.refresh();
        expect(h.effects()).toBe(offset < 0 ? 2 : 1);
        expect(h.task.getStatus().reason).toBe(offset < 0 ? 'continuation-sent' : 'budget-exhausted');
      } finally {
        h.stop();
      }
    });

    it('charges task configuration time against the first worker runtime before later polling', async () => {
      const h = await runtimeHarness({ firstOperation: true });
      try {
        h.setNow(10_000);
        const update = h.task.update.bind(h.task);
        vi.spyOn(h.task, 'update').mockImplementation(async (patch) => {
          const updated = await update(patch);
          h.setNow(10_800);
          return updated;
        });
        await h.controller.assign(WORKER, 'request-preflight-origin');
        expect(h.controller.getStatus().workers[0].startedAt).toBe(10_000);
        expect(h.task.getStatus().startedAt).toBe(10_000);
        expect(h.effects()).toBe(1);
      } finally {
        h.stop();
      }
    });
  });

  it.each(['assign', 'retry'] as const)(
    'refuses %s after the manager runtime even with fresh worker budget',
    async (action) => {
      let now = 10_000;
      const h = harness({ now: () => now });
      await h.controller.configure(config);
      await h.controller.start();
      now += SUPERVISOR_MANAGER_MAX_RUNTIME_MS;
      await expect(h.controller[action](WORKER, 'request-manager-expired')).rejects.toThrow(/budget exhausted/);
      expect(h.worker.task.update).not.toHaveBeenCalled();
      expect(h.worker.recovery.inspect).not.toHaveBeenCalled();
      expect(h.controller.getStatus().inFlight).toBeUndefined();
    }
  );

  it.each([-1, 10_001])('refuses manager startup with an invalid or future runtime origin (%s)', async (startedAt) => {
    const h = harness();
    await h.controller.configure(config);
    const restored = { ...h.controller.getStatus(), startedAt };
    const controller = new SupervisorController(h.deps, SUPERVISOR, restored);
    await expect(controller.start()).rejects.toThrow(/cancelled/);
    expect(h.deps.startManager).not.toHaveBeenCalled();
    expect(controller.getStatus()).toMatchObject({ phase: 'paused', reason: 'manager-start-refused' });
  });

  it.each([-1, 0])('preserves the manager runtime through late kickoff and later polling (%s ms)', async (offset) => {
    const origin = 10_000;
    const deadline = origin + SUPERVISOR_MANAGER_MAX_RUNTIME_MS;
    let now = deadline - 500;
    let observation: RecoveryObservation = {
      activity: 'idle',
      reason: 'observing',
      at: now,
      conversationId: SUPERVISOR,
      submissionKey: 'before-manager-kickoff',
      processReady: true,
      safeToAct: false,
    };
    let marker: TaskObservation['marker'];
    const act = vi.fn(async () => 'sent' as const);
    const task = new TaskController({
      now: () => now,
      observe: async () => ({ observation, commands: new Map(), marker }),
      act,
      persist: async () => {},
      changed: () => {},
    });
    const h = harness({
      now: () => now,
      startManager: async (objective, _workers, isCurrent, runtimeStartedAt) => {
        await task.update(buildSupervisorManagerTask(objective));
        return classifyTaskKickoff(await task.resume(isCurrent, runtimeStartedAt)) === 'accepted';
      },
    });
    await h.controller.configure(config);
    const controller = new SupervisorController(h.deps, SUPERVISOR, {
      ...h.controller.getStatus(),
      startedAt: origin,
    });
    try {
      await controller.start();
      expect(task.getStatus().startedAt).toBe(origin);
      const flight = task.getStatus().inFlight!;
      now += 1;
      observation = {
        ...observation,
        activity: 'working',
        reason: 'turn-running',
        at: now,
        submissionKey: 'accepted-manager-kickoff',
        submissionHash: flight.promptHash,
      };
      await task.refresh();
      expect(task.getStatus().inFlight).toBeUndefined();
      now = deadline + offset;
      observation = {
        ...observation,
        activity: 'completed',
        reason: 'turn-completed',
        at: now,
        turnId: 'manager-turn',
      };
      marker = {
        key: 'fresh-manager-progress',
        at: now,
        submissionKey: 'accepted-manager-kickoff',
        progress: { outcome: 'unfinished', checkpoint: 'Worker evidence checked', nextAction: 'Inspect again' },
      };
      await task.refresh();
      expect(act).toHaveBeenCalledTimes(offset < 0 ? 2 : 1);
      expect(task.getStatus().reason).toBe(offset < 0 ? 'continuation-sent' : 'budget-exhausted');
    } finally {
      task.stop();
      controller.stop();
    }
  });

  it.each(['assign', 'retry'] as const)('cancels %s when the clock moves before the manager origin', async (action) => {
    let now = 10_000;
    const h = harness({ now: () => now });
    await h.controller.configure(config);
    await h.controller.start();
    now = 9999;
    await expect(h.controller[action](WORKER, 'request-manager-clock')).rejects.toThrow(/budget exhausted/);
    expect(h.worker.task.update).not.toHaveBeenCalled();
    expect(h.worker.recovery.inspect).not.toHaveBeenCalled();
    expect(h.controller.getStatus().inFlight).toBeUndefined();
  });
});
