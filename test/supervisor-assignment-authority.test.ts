/** Manager assignment configuration is a guarded task transaction; no native effects. */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  SupervisorController,
  type SupervisorDependencies,
  type SupervisorWorkerHandle,
} from '../src/supervisor/controller.js';
import { TaskConfigurationCancelledError, TaskController } from '../src/supervision/controller.js';
import { TaskStore, type TaskSaveAuthority } from '../src/supervision/store.js';
import { initialTaskState, type TaskState } from '../src/supervision/schema.js';
import { initialRecoveryState } from '../src/recovery/types.js';

const SID = '11111111-1111-4111-8111-111111111111';
const WID = '22222222-2222-4222-8222-222222222222';
const plan = {
  enabled: true,
  objective: 'Coordinate the authorized repair',
  workers: [
    {
      sessionId: WID,
      task: 'Manager parser repair',
      criteria: [{ id: 'tests', kind: 'manual' as const, description: 'Owner accepts tests' }],
      maxAssignments: 2,
      maxRuntimeMs: 60_000,
    },
  ],
};
afterEach(() => vi.restoreAllMocks());
async function fixture(afterCommit = false, ioFailure?: Error) {
  const root = await mkdtemp(join(homedir(), 'supervisor-assignment-authority-'));
  const path = join(root, 'tasks.json');
  const store = new TaskStore(path);
  const prior: TaskState = {
    ...initialTaskState(),
    objective: 'The owner dormant task',
    criteria: [
      {
        id: 'owner',
        kind: 'manual',
        description: 'Original owner criterion',
        verified: true,
        evidence: { source: 'owner', at: 4_000 },
      },
      { id: 'pending', kind: 'manual', description: 'Pending owner acceptance', verified: false },
    ],
    checkpoint: 'Original verified checkpoint',
    nextAction: 'Original owner next step',
    continuations: 2,
    configuredAt: 3_000,
    lastProgressAt: 4_000,
    handledEvidence: ['previous-task-step'],
    history: [{ at: 4_000, reason: 'progress-recorded' }],
  };
  await store.save(WID, prior);
  let now = 10_000,
    managerCurrent = true,
    selected = true;
  let entered!: () => void, release!: () => void;
  const held = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  let hold = true;
  const persisted: TaskState[] = [];
  const act = vi.fn(async () => 'sent' as const);
  const workerTask = new TaskController(
    {
      now: () => now,
      observe: async () => ({
        observation: {
          activity: 'idle',
          reason: 'observing',
          at: now,
          conversationId: WID,
          processReady: true,
          safeToAct: false,
        },
        commands: new Map(),
      }),
      act,
      persist: async (state, authority?: TaskSaveAuthority) => {
        const intercept = hold && state.objective === plan.workers[0].task;
        if (intercept) hold = false;
        if (intercept && !afterCommit) {
          entered();
          await gate;
        }
        if (ioFailure && intercept) throw ioFailure;
        await store.save(WID, state, authority);
        persisted.push(structuredClone(state));
        if (intercept && afterCommit) {
          entered();
          await gate;
        }
      },
      changed: vi.fn(),
    },
    store.get(WID)
  );
  const recoveryState = initialRecoveryState();
  const worker: SupervisorWorkerHandle = {
    isCurrent: () => selected,
    task: workerTask,
    recovery: {
      getStatus: () => structuredClone(recoveryState),
      inspect: async () => structuredClone(recoveryState),
      inspectEvidence: async () => ({
        state: structuredClone(recoveryState),
        observedAt: now,
        stale: false,
        isCurrent: () => true,
      }),
      retry: vi.fn(async () => structuredClone(recoveryState)),
    },
  };
  const deps: SupervisorDependencies = {
    validateWorkers: () => {},
    worker: () => worker,
    persist: async () => {},
    withLeases: (fn) => fn(),
    leaseHolder: () => undefined,
    hasManagerAuthority: () => managerCurrent,
    prepareManagerAuthority: async () => true,
    validateManagerAuthority: async () => managerCurrent,
    startManager: async () => true,
    pauseManager: async () => {},
    resetManager: async () => {},
    changed: vi.fn(),
    now: () => now,
  };
  const supervisor = new SupervisorController(deps, SID);
  await supervisor.configure(plan);
  await supervisor.start();
  return {
    root,
    path,
    store,
    workerTask,
    supervisor,
    act,
    held,
    release,
    persisted,
    recoveryState,
    revoke: () => {
      managerCurrent = false;
    },
    replace: () => {
      selected = false;
    },
    expire: () => {
      now += 60_001;
    },
    cleanup: async () => {
      release();
      supervisor.stop();
      workerTask.stop();
      await workerTask.drain();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it.each([
  'manager-pause',
  'manager-reset',
  'manager-grant',
  'worker-pause',
  'worker-input',
  'worker-edit',
  'worker-reset',
  'worker-replacement',
  'runtime',
  'recovery-pause',
] as const)('does not commit a manager assignment revoked by %s during task persistence', async (cancel) => {
  const f = await fixture();
  const before = f.workerTask.getStatus();
  const bytes = await readFile(f.path, 'utf8');
  const assigning = f.supervisor.assign(WID, `cancelled-assignment-${cancel}`);
  const outcome = assigning.then(
    () => undefined,
    (error: unknown) => error
  );
  let ownerMutation: Promise<unknown> | undefined;
  try {
    await f.held;
    if (cancel === 'manager-pause') ownerMutation = f.supervisor.pause();
    if (cancel === 'manager-reset') ownerMutation = f.supervisor.reset();
    if (cancel === 'manager-grant') f.revoke();
    if (cancel === 'worker-pause') ownerMutation = f.workerTask.pause();
    if (cancel === 'worker-input') f.workerTask.noteUserInput();
    if (cancel === 'worker-edit')
      ownerMutation = f.workerTask.update({
        objective: 'Newer owner objective',
        criteria: [{ id: 'new-owner', kind: 'manual', description: 'Owner replacement acceptance' }],
        config: { maxContinuations: 4 },
      });
    if (cancel === 'worker-reset') ownerMutation = f.workerTask.reset();
    if (cancel === 'worker-replacement') f.replace();
    if (cancel === 'runtime') f.expire();
    if (cancel === 'recovery-pause') f.recoveryState.phase = 'paused';
    f.release();
    expect(await outcome).toBeInstanceOf(Error);
    await ownerMutation;
    await f.workerTask.drain();
    expect(f.act).not.toHaveBeenCalled();
    expect(f.persisted.some((state) => state.objective === plan.workers[0].task)).toBe(false);
    const state = f.workerTask.getStatus();
    if (cancel === 'worker-edit')
      expect(state).toMatchObject({
        objective: 'Newer owner objective',
        criteria: [{ id: 'new-owner', verified: false }],
        config: { maxContinuations: 4 },
      });
    else if (cancel === 'worker-reset')
      expect(state).toMatchObject({ objective: before.objective, checkpoint: '', reason: 'owner-reset' });
    else
      expect(state).toMatchObject({
        objective: before.objective,
        criteria: before.criteria,
        checkpoint: before.checkpoint,
        nextAction: before.nextAction,
        continuations: before.continuations,
        handledEvidence: before.handledEvidence,
      });
    expect(new TaskStore(f.path).get(WID)).toEqual(f.store.get(WID));
    expect(f.store.get(WID).objective).toBe(state.objective);
    if (!cancel.startsWith('worker-') || cancel === 'worker-replacement')
      expect(await readFile(f.path, 'utf8')).toBe(bytes);
    expect(f.supervisor.getStatus().inFlight).toBeUndefined();
    expect(
      f.supervisor.getStatus().workers.every((worker) => worker.assignments === 0 && worker.startedAt === undefined)
    ).toBe(true);
  } finally {
    f.release();
    await outcome;
    await ownerMutation;
    await f.cleanup();
  }
});

it('commits and starts the same assignment when its authority remains current', async () => {
  const f = await fixture();
  const before = f.workerTask.getStatus();
  const assigning = f.supervisor.assign(WID, 'authorized-assignment');
  try {
    await f.held;
    expect(f.workerTask.getStatus()).toEqual(before);
    f.release();
    await expect(assigning).resolves.toMatchObject({
      workers: [expect.objectContaining({ assignments: 1 })],
      handledRequestIds: ['authorized-assignment'],
    });
    expect(f.act).toHaveBeenCalledOnce();
    expect(f.workerTask.getStatus()).toMatchObject({
      objective: plan.workers[0].task,
      phase: 'watching',
      checkpoint: '',
      config: { enabled: true },
    });
    expect(new TaskStore(f.path).get(WID)).toEqual(f.workerTask.getStatus());
  } finally {
    f.release();
    await assigning.catch(() => {});
    await f.cleanup();
  }
});

it('preserves a completed authorized configuration when manager pause arrives after commit, without kickoff', async () => {
  const f = await fixture(true);
  const assigning = f.supervisor.assign(WID, 'pause-after-configuration-commit');
  const result = assigning.then(
    () => undefined,
    (error: unknown) => error
  );
  let pausing: Promise<unknown> | undefined;
  try {
    await f.held;
    expect(f.workerTask.getStatus()).toMatchObject({ objective: plan.workers[0].task, config: { enabled: false } });
    expect(new TaskStore(f.path).get(WID)).toEqual(f.workerTask.getStatus());
    pausing = f.supervisor.pause();
    f.release();
    expect(await result).toBeInstanceOf(Error);
    await pausing;
    expect(f.act).not.toHaveBeenCalled();
    expect(f.workerTask.getStatus()).toMatchObject({ objective: plan.workers[0].task, config: { enabled: false } });
    expect(f.supervisor.getStatus()).toMatchObject({
      phase: 'paused',
      workers: [expect.objectContaining({ assignments: 0 })],
    });
    expect(f.supervisor.getStatus().inFlight).toBeUndefined();
  } finally {
    f.release();
    await result;
    await pausing;
    await f.cleanup();
  }
});

it('keeps an uncertain supervisor reservation for a persistence error despite later owner pause and a cancellation-like message', async () => {
  const ioFailure = new Error('Task configuration authority was cancelled');
  const f = await fixture(false, ioFailure);
  const before = f.workerTask.getStatus();
  const assigning = f.supervisor.assign(WID, 'configuration-io-failure');
  const result = assigning.then(
    () => undefined,
    (error: unknown) => error
  );
  let pausing: Promise<unknown> | undefined;
  try {
    await f.held;
    pausing = f.supervisor.pause();
    f.release();
    const failure = await result;
    expect(failure).toBe(ioFailure);
    expect(failure).not.toBeInstanceOf(TaskConfigurationCancelledError);
    await pausing;
    expect(f.act).not.toHaveBeenCalled();
    expect(f.workerTask.getStatus()).toMatchObject({
      objective: before.objective,
      criteria: before.criteria,
      checkpoint: before.checkpoint,
      reason: 'persistence-failed',
      phase: 'blocked',
    });
    expect(f.supervisor.getStatus()).toMatchObject({
      phase: 'paused',
      inFlight: { requestId: 'configuration-io-failure', action: 'assign' },
      handledRequestIds: [],
      workers: [expect.objectContaining({ assignments: 0 })],
    });
    expect(f.supervisor.getStatus().history.some((entry) => entry.reason === 'assign-uncertain')).toBe(true);
    await expect(f.supervisor.assign(WID, 'configuration-io-failure')).rejects.toThrow();
    expect(f.act).not.toHaveBeenCalled();
  } finally {
    f.release();
    await result;
    await pausing;
    await f.cleanup();
  }
});

it('a revoked manager credential cannot commit a held real Task assignment or dispatch its input', async () => {
  const f = await fixture();
  let credentialCurrent = true;
  const before = f.workerTask.getStatus(),
    bytes = await readFile(f.path, 'utf8');
  const work = f.supervisor.assign(WID, 'held-scoped-credential', () => credentialCurrent).catch((error) => error);
  try {
    await f.held;
    credentialCurrent = false;
    f.release();
    expect(await work).toBeInstanceOf(Error);
    expect(f.act).not.toHaveBeenCalled();
    expect(f.workerTask.getStatus()).toEqual(before);
    expect(await readFile(f.path, 'utf8')).toBe(bytes);
    expect(f.supervisor.getStatus().inFlight).toBeUndefined();
    expect(f.supervisor.getStatus().workers[0].assignments).toBe(0);
  } finally {
    f.release();
    await work;
    await f.cleanup();
  }
});
it('expired manager credentials are refused before any new operation reservation', async () => {
  const f = await fixture();
  try {
    const before = f.supervisor.getStatus();
    await expect(f.supervisor.assign(WID, 'expired-scoped-assign', () => false)).rejects.toThrow('credential');
    await expect(f.supervisor.retry(WID, 'expired-scoped-retry', () => false)).rejects.toThrow('credential');
    expect(f.supervisor.getStatus()).toEqual(before);
    expect(f.act).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
  }
});
