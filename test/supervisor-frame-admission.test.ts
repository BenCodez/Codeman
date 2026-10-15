/** Supervisor reservations follow exact, read-only worker/issuer wire admission. No worker is launched. */
import { afterEach, expect, it, vi } from 'vitest';
import {
  SupervisorController,
  type SupervisorDependencies,
  type SupervisorWorkerHandle,
} from '../src/supervisor/controller.js';
import { initialTaskState } from '../src/supervision/schema.js';
import { initialRecoveryState, type RecoveryEvidenceSource } from '../src/recovery/types.js';
import { CodexTaskAdapter } from '../src/supervision/adapter.js';
import { CodexRecoveryAdapter } from '../src/recovery/codex-adapter.js';
import { formatTaskPrompt, taskPromptFits } from '../src/supervision/prompt.js';
import * as grants from '../src/session-env-clamp.js';
import type { Session } from '../src/session.js';
import type { BrokerAuthority } from '../src/recovery/codex-input-broker.js';

const MANAGER = '11111111-1111-4111-8111-111111111111';
const WORKER = '22222222-2222-4222-8222-222222222222';
const THREAD = '33333333-3333-4333-8333-333333333333';
afterEach(() => vi.restoreAllMocks());

async function fixture(paths = 1, large = false) {
  let currentManager = true,
    currentWorker = true,
    currentGrant = true;
  const file = {
    path: '/fixture/worker/state.json',
    dev: 1,
    ino: 2,
    size: 20,
    mtimeMs: 1,
    ctimeMs: 1,
    hash: 'a'.repeat(64),
    maxBytes: 98_304,
  };
  const broker: BrokerAuthority = {
    sessionId: WORKER,
    incarnation: WORKER,
    directory: '/fixture/worker',
    files: [file],
    proof: {
      incarnation: WORKER,
      brokerPid: 700,
      childPid: 701,
      brokerStart: '1',
      childStart: '2',
      closed: false,
      rawGeneration: 0,
      launchDigest: 'b'.repeat(64),
      homeDigest: 'c'.repeat(64),
      ownerCounters: { 'owner-pty': 0, 'owner-key': 0, 'owner-mux': 0 },
      fileWitness: file,
    },
  };
  const managerFile = { ...file, path: '/fixture/manager/state.json', ino: 3 };
  const issuer: BrokerAuthority = {
    sessionId: MANAGER,
    incarnation: MANAGER,
    directory: '/fixture/manager',
    files: [managerFile],
    proof: {
      ...broker.proof,
      incarnation: MANAGER,
      brokerPid: 800,
      childPid: 801,
      brokerStart: '3',
      childStart: '4',
      fileWitness: managerFile,
    },
  };
  const source: RecoveryEvidenceSource = {
    sessionId: WORKER,
    inputBroker: broker,
    files: [file],
    isCurrent: () => currentWorker,
    identity: {
      reason: 'verified',
      conversationId: THREAD,
      tailTruncated: false,
      witness: {
        paths: Array.from({ length: paths }, (_, index) => ({
          path: `/fixture/worker/${'directory-'.repeat(25)}${index}`,
          kind: 'directory',
          dev: 1,
          ino: 2,
        })),
      },
    },
  };
  const session = {
    id: WORKER,
    owner: 'alice',
    codexConfig: { noDaemon: true, resumeSessionId: THREAD },
    getRecoveryContext: () => ({ generation: 1, codexHome: '/fixture/home' }),
    getEnvOverridesForPersist: () => ({ CODEX_HOME: '/fixture/home' }),
  } as unknown as Session;
  const adapter = new CodexTaskAdapter(session, () => {});
  vi.spyOn(adapter, 'observe').mockResolvedValue({
    observation: {
      conversationId: THREAD,
      activity: 'idle',
      reason: 'observing',
      at: 10_000,
      processReady: true,
      safeToAct: false,
    },
    commands: new Map(),
  });
  vi.spyOn(CodexRecoveryAdapter.prototype, 'getLocalEvidenceSource').mockImplementation(() => source);
  vi.spyOn(grants, 'clampRecoveryLaunchForOwner').mockImplementation(async (_owner, configs, env) => ({
    configs,
    env,
    isCurrent: () => currentGrant,
    getFileWitness: () => undefined,
  }));
  const taskState = initialTaskState();
  const configured = {
    sessionId: WORKER,
    task: large ? 'o'.repeat(4000) : 'Repair the parser',
    criteria: large
      ? Array.from({ length: 28 }, (_, index) => ({
          id: `c${index}`,
          description: 'd'.repeat(1000),
          kind: 'command' as const,
          command: 'c'.repeat(1000),
        }))
      : [
          { id: 'review', description: 'Owner review', kind: 'manual' as const },
          { id: 'final', description: 'Owner final acceptance', kind: 'manual' as const },
        ],
    maxAssignments: 2,
    maxRuntimeMs: 60_000,
  };
  const effects = vi.fn();
  const worker: SupervisorWorkerHandle = {
    isCurrent: () => currentWorker,
    admitPrompt: vi.fn((prompt, authority) => adapter.admitPrompt(prompt, authority)),
    task: {
      getStatus: () => structuredClone(taskState),
      update: vi.fn(async (patch, authority) => {
        expect(authority?.()).toBe(true);
        taskState.objective = patch.objective!;
        taskState.criteria = patch.criteria!.map((criterion) => ({ ...criterion, verified: false }));
        taskState.config = { ...taskState.config, ...patch.config };
        return structuredClone(taskState);
      }),
      resume: vi.fn(async (authority) => {
        expect(authority?.()).toBe(true);
        effects();
        return { ...structuredClone(taskState), phase: 'watching', reason: 'kickoff-sent' };
      }),
    },
    recovery: {
      getStatus: () => initialRecoveryState(),
      inspect: async () => initialRecoveryState(),
      inspectEvidence: async () => ({
        state: initialRecoveryState(),
        observedAt: 10_000,
        stale: false,
        isCurrent: () => true,
      }),
      retry: vi.fn(async () => initialRecoveryState()),
    },
  };
  const saved: unknown[] = [];
  const deps: SupervisorDependencies = {
    worker: () => worker,
    validateWorkers: () => {},
    persist: async (state) => {
      saved.push(structuredClone(state));
    },
    withLeases: (fn) => fn(),
    leaseHolder: () => undefined,
    hasManagerAuthority: () => currentManager,
    validateManagerAuthority: async () => currentManager,
    prepareManagerAuthority: vi.fn(async (workerId, received) => {
      expect(workerId).toBe(WORKER);
      expect(received?.sessionId).toBe(WORKER);
      return currentManager;
    }),
    getInputIssuer: () => (currentManager ? issuer : undefined),
    startManager: async () => true,
    pauseManager: async () => {},
    resetManager: async () => {},
    changed: () => {},
    now: () => 10_000,
  };
  const controller = new SupervisorController(deps, MANAGER);
  await controller.configure({ objective: 'Coordinate repair', enabled: true, workers: [configured] });
  await controller.start();
  saved.length = 0;
  return {
    controller,
    configured,
    taskState,
    worker,
    deps,
    effects,
    saved,
    issuer,
    revokeManager: () => {
      currentManager = false;
    },
    revokeWorker: () => {
      currentWorker = false;
    },
    revokeGrant: () => {
      currentGrant = false;
    },
  };
}

it('rejects a raw-size-valid but oversized private envelope before supervisor reservation or Task mutation', async () => {
  const f = await fixture(40, true);
  const promptState = {
    objective: f.configured.task,
    criteria: f.configured.criteria.map((criterion) => ({ ...criterion, verified: false })),
    checkpoint: '',
    nextAction: '',
  };
  expect(taskPromptFits(promptState)).toBe(true);
  const before = f.controller.getStatus(),
    taskBefore = structuredClone(f.taskState);
  try {
    await expect(f.controller.assign(WORKER, 'oversized-envelope')).rejects.toThrow(/envelope/);
    expect(f.worker.admitPrompt).toHaveBeenCalledOnce();
    expect(f.controller.getStatus()).toEqual(before);
    expect(f.taskState).toEqual(taskBefore);
    expect(f.saved).toEqual([]);
    expect(f.worker.task.update).not.toHaveBeenCalled();
    expect(f.worker.task.resume).not.toHaveBeenCalled();
    expect(f.effects).not.toHaveBeenCalled();
  } finally {
    f.controller.stop();
    await f.controller.drain();
  }
});

it('admits a fitting worker and delegated issuer before the first durable assignment reservation', async () => {
  const f = await fixture();
  try {
    await f.controller.assign(WORKER, 'fitting-envelope');
    expect(f.deps.prepareManagerAuthority).toHaveBeenCalledOnce();
    const authority = vi.mocked(f.worker.admitPrompt!).mock.calls[0][1];
    expect(authority.getInputIssuer?.()).toEqual(f.issuer);
    expect(f.effects).toHaveBeenCalledOnce();
    expect(f.controller.getStatus()).toMatchObject({
      handledRequestIds: ['fitting-envelope'],
      workers: [expect.objectContaining({ assignments: 1 })],
    });
    expect(f.controller.getStatus().inFlight).toBeUndefined();
    expect(f.saved.some((state) => Reflect.get(state as object, 'inFlight'))).toBe(true);
  } finally {
    f.controller.stop();
    await f.controller.drain();
  }
});

it.each(['manager', 'worker', 'worker-grant'] as const)(
  'does not reserve when %s authority changes during admission',
  async (kind) => {
    const f = await fixture();
    vi.mocked(f.deps.prepareManagerAuthority).mockImplementation(async () => {
      if (kind === 'manager') f.revokeManager();
      else if (kind === 'worker') f.revokeWorker();
      else f.revokeGrant();
      return true;
    });
    try {
      await expect(f.controller.assign(WORKER, 'changed-authority')).rejects.toThrow();
      expect(f.controller.getStatus()).toMatchObject({
        handledRequestIds: [],
        workers: [expect.objectContaining({ assignments: 0 })],
      });
      expect(f.controller.getStatus().inFlight).toBeUndefined();
      expect(f.saved).toEqual([]);
      expect(f.worker.task.update).not.toHaveBeenCalled();
      expect(f.effects).not.toHaveBeenCalled();
    } finally {
      f.controller.stop();
      await f.controller.drain();
    }
  }
);

it('previews the exact existing task checkpoint, next action and verified criteria', async () => {
  const f = await fixture();
  Object.assign(f.taskState, {
    objective: f.configured.task,
    criteria: f.configured.criteria.map((criterion, index) => ({ ...criterion, verified: index === 0 })),
    checkpoint: 'Owner checkpoint',
    nextAction: 'Owner next action',
    outcome: 'unfinished',
  });
  const expected = formatTaskPrompt(f.taskState);
  try {
    await f.controller.assign(WORKER, 'preserved-fields');
    expect(vi.mocked(f.worker.admitPrompt!).mock.calls[0][0]).toBe(expected);
    expect(f.effects).toHaveBeenCalledOnce();
  } finally {
    f.controller.stop();
    await f.controller.drain();
  }
});

it('vetoes a changed task prompt across the final awaited manager check before reservation', async () => {
  const f = await fixture();
  let checks = 0;
  f.deps.validateManagerAuthority = async () => {
    if (++checks === 2) f.taskState.checkpoint = 'Later owner checkpoint';
    return true;
  };
  try {
    await expect(f.controller.assign(WORKER, 'changed-prompt')).rejects.toThrow(/cancelled/);
    expect(f.saved).toEqual([]);
    expect(f.worker.task.update).not.toHaveBeenCalled();
    expect(f.effects).not.toHaveBeenCalled();
    expect(f.taskState.checkpoint).toBe('Later owner checkpoint');
  } finally {
    f.controller.stop();
    await f.controller.drain();
  }
});
