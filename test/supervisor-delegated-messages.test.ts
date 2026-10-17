/** Real Task/Supervisor controllers; every delivery is an explicit fake effect. No pane or model. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TaskController, type TaskObservation } from '../src/supervision/controller.js';
import { initialTaskState, type TaskState } from '../src/supervision/schema.js';
import { SupervisorController, type SupervisorDependencies } from '../src/supervisor/controller.js';
import { initialRecoveryState, type RecoveryActionAuthority } from '../src/recovery/types.js';
import { SupervisorStateSchema } from '../src/supervisor/schema.js';

const MANAGER = '11111111-2222-4333-8444-555555555555',
  WORKER = '22222222-3333-4444-8555-666666666666';
const THREAD = '33333333-4444-4555-8666-777777777777';
const stops: Array<() => void> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  vi.useRealTimers();
});
async function fixture(
  options: {
    grant?: boolean;
    result?: 'sent' | 'not-sent' | 'unknown';
    maxMessages?: number;
    continuations?: number;
  } = {}
) {
  const initial = initialTaskState();
  Object.assign(initial, {
    objective: 'Implement the bounded parser',
    criteria: [{ id: 'owner', description: 'Owner accepts the result', kind: 'manual', verified: false }],
    checkpoint: 'The parser is inspected',
    nextAction: 'Implement the remaining bounded change',
    outcome: 'unfinished',
    conversationId: THREAD,
    configuredAt: 1000,
    startedAt: 1000,
    kickoffAt: 2000,
    continuations: options.continuations ?? 0,
    config: { enabled: true, maxContinuations: 3, maxRuntimeMs: 60_000 },
  });
  let now = 10_000;
  const observation: TaskObservation = {
    observation: {
      activity: 'completed',
      reason: 'turn-completed',
      at: 10_001,
      conversationId: THREAD,
      turnId: 'turn-1',
      processReady: true,
      processReadyAt: 10_000,
      safeToAct: false,
      submissionKey: 'old-submission',
    },
    commands: new Map(),
  };
  const taskSaves: TaskState[] = [];
  const persistTask = vi.fn(async (state: TaskState) => {
    taskSaves.push(structuredClone(state));
  });
  const act = vi.fn(async (_key: string, _thread: string, _prompt: string, current: RecoveryActionAuthority) => {
    expect(taskSaves.at(-1)?.inFlight).toBeDefined();
    expect(current()).toBe(true);
    return options.result ?? 'sent';
  });
  const admit = vi.fn(async (_prompt: string, current: RecoveryActionAuthority) => current() === true);
  const task = new TaskController(
    {
      now: () => now,
      observe: async () => structuredClone(observation),
      persist: persistTask,
      changed: () => {},
      act,
      admitPrompt: admit,
    },
    initial
  );
  stops.push(() => task.stop());
  await task.resume();
  const recovery = initialRecoveryState();
  const roleSaves: ReturnType<SupervisorController['getStatus']>[] = [];
  const deps: SupervisorDependencies = {
    validateWorkers: vi.fn(),
    worker: (id) =>
      id === WORKER
        ? {
            task,
            isCurrent: () => true,
            admitPrompt: admit,
            recovery: {
              getStatus: () => structuredClone(recovery),
              inspect: async () => structuredClone(recovery),
              inspectEvidence: async () => ({
                state: structuredClone(recovery),
                observedAt: now,
                stale: false,
                isCurrent: () => true,
              }),
              retry: vi.fn(async () => structuredClone(recovery)),
            },
          }
        : undefined,
    persist: async (state) => {
      SupervisorStateSchema.parse(state);
      roleSaves.push(structuredClone(state));
    },
    withLeases: (fn) => fn(),
    leaseHolder: () => undefined,
    hasManagerAuthority: () => true,
    prepareManagerAuthority: async () => true,
    validateManagerAuthority: async () => true,
    startManager: async () => true,
    pauseManager: async () => {},
    resetManager: async () => {},
    changed: () => {},
    now: () => now,
  };
  const role = new SupervisorController(deps, MANAGER);
  stops.push(() => role.stop());
  const config = {
    objective: 'Manage the parser task',
    enabled: true,
    workers: [
      {
        sessionId: WORKER,
        task: initial.objective,
        criteria: [{ id: 'owner', description: 'Owner accepts the result', kind: 'manual' as const }],
        maxAssignments: 2,
        maxRuntimeMs: 60_000,
        allowMessages: options.grant ?? true,
        maxMessages: options.maxMessages ?? 2,
      },
    ],
  };
  await role.configure(config);
  await role.start();
  return {
    task,
    role,
    initial,
    observation,
    act,
    admit,
    persistTask,
    taskSaves,
    roleSaves,
    deps,
    config,
    time: (at: number) => {
      now = at;
    },
  };
}

it('sends one attributed structured message through accounted Task delivery and seals duplicate request IDs', async () => {
  const f = await fixture();
  const state = await f.role.message(WORKER, 'message-request-1', 'Add the bounded empty-input regression.');
  expect(f.act).toHaveBeenCalledOnce();
  const [key, conversationId, prompt] = f.act.mock.calls[0];
  expect(key).toBe(`${THREAD}:task:turn-1`);
  expect(conversationId).toBe(THREAD);
  expect(prompt).toContain('Owner-authorized delegated instruction from supervisor:' + MANAGER);
  expect(prompt).toContain('Add the bounded empty-input regression.');
  expect(prompt).toContain('Owner accepts the result');
  expect(state.workers[0]).toMatchObject({ assignments: 0, messages: 1, startedAt: 10_000 });
  expect(state.handledRequestBindings[0]).toMatchObject({
    requestId: 'message-request-1',
    workerId: WORKER,
    action: 'message',
    payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(f.task.getStatus()).toMatchObject({
    continuations: 1,
    startedAt: 1000,
    criteria: [{ verified: false }],
    reason: 'delegated-instruction-sent',
  });
  expect(f.roleSaves.some((saved) => saved.inFlight?.action === 'message' && saved.inFlight.payloadHash)).toBe(true);
  await f.role.message(WORKER, 'message-request-1', 'Add the bounded empty-input regression.');
  await expect(f.role.message(WORKER, 'message-request-1', 'Different owner intent')).rejects.toThrow(
    'different operation'
  );
  expect(f.act).toHaveBeenCalledOnce();
});

it.each([
  'no-grant',
  'outside-worker',
  'paused-role',
  'paused-worker',
  'working',
  'manual-accepted',
  'budget',
  'expired',
  'revoked',
] as const)('refuses delegated messages without widening %s authority', async (cause) => {
  const f = await fixture({ grant: cause !== 'no-grant', continuations: cause === 'budget' ? 3 : 0 });
  if (cause === 'paused-role') await f.role.pause();
  if (cause === 'paused-worker') await f.task.pause();
  if (cause === 'working') f.observation.observation.activity = 'working';
  if (cause === 'manual-accepted') await f.task.progress({ outcome: 'completed', verifiedCriteria: ['owner'] });
  if (cause === 'expired') f.time(70_000);
  await expect(
    f.role.message(
      cause === 'outside-worker' ? MANAGER : WORKER,
      'message-denied-1',
      'Do not interrupt work',
      () => cause !== 'revoked'
    )
  ).rejects.toThrow();
  expect(f.act).not.toHaveBeenCalled();
  expect(f.task.getStatus().criteria[0].verified).toBe(cause === 'manual-accepted');
});

it('retains unknown Task and supervisor flights across retry/reload rather than replaying a delegated message', async () => {
  const f = await fixture({ result: 'unknown' });
  await expect(f.role.message(WORKER, 'uncertain-message-1', 'Bounded instructions')).rejects.toThrow();
  expect(f.role.getStatus()).toMatchObject({
    phase: 'paused',
    inFlight: { action: 'message', requestId: 'uncertain-message-1' },
  });
  expect(f.task.getStatus()).toMatchObject({ phase: 'paused', continuations: 1, inFlight: { action: 'continue' } });
  await expect(f.role.message(WORKER, 'uncertain-message-1', 'Bounded instructions')).rejects.toThrow();
  const reloaded = new SupervisorController(f.deps, MANAGER, f.role.getStatus());
  stops.push(() => reloaded.stop());
  await expect(reloaded.message(WORKER, 'uncertain-message-1', 'Bounded instructions')).rejects.toThrow();
  expect(f.task.getStatus().inFlight).toBeDefined();
  expect(f.act).toHaveBeenCalledOnce();
});

it('cancels a held message reservation before any effect when the owner pauses the role', async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>(),
    held = Promise.withResolvers<void>();
  f.persistTask.mockImplementationOnce(async (state) => {
    f.taskSaves.push(structuredClone(state));
    entered.resolve();
    await held.promise;
  });
  const sending = f.role.message(WORKER, 'held-message-1', 'Bounded instructions').catch((error: unknown) => error);
  await entered.promise;
  const pausing = f.role.pause();
  held.resolve();
  expect(await sending).toBeInstanceOf(Error);
  await pausing;
  expect(f.act).not.toHaveBeenCalled();
  expect(f.role.getStatus().phase).toBe('paused');
  expect(f.task.getStatus().startedAt).toBe(1000);
});

it('spends the final Task slot once without resetting its original runtime or manual criteria', async () => {
  const f = await fixture({ continuations: 2, maxMessages: 1 });
  await f.role.message(WORKER, 'last-slot-message', 'Complete only the bounded change');
  expect(f.task.getStatus()).toMatchObject({ continuations: 3, startedAt: 1000, criteria: [{ verified: false }] });
  await expect(f.role.message(WORKER, 'over-budget-message', 'Another message')).rejects.toThrow('budget');
  expect(f.act).toHaveBeenCalledOnce();
});

it('retains unresolved delivery when acknowledgement persistence fails after a possible effect', async () => {
  const f = await fixture();
  f.act.mockImplementationOnce(async () => {
    f.persistTask.mockRejectedValueOnce(Error('Lost Task journal ACK'));
    return 'sent';
  });
  await expect(f.role.message(WORKER, 'lost-ack-message', 'Bounded message')).rejects.toThrow();
  expect(f.role.getStatus().inFlight?.requestId).toBe('lost-ack-message');
  await expect(f.role.message(WORKER, 'lost-ack-message', 'Bounded message')).rejects.toThrow();
  expect(f.act).toHaveBeenCalledOnce();
});

it('feeds a management check-in through the same accounted manager Task without renewing runtime or owner criteria', async () => {
  const f = await fixture();
  const capture = f.task.captureInstructionAuthority();
  const role = new SupervisorController(
    {
      ...f.deps,
      managerInstructionAvailable: () => capture(),
      dispatchManagerInstruction: (instructions, current) =>
        f.task.deliverInstruction(instructions, 'owner-management-schedule', current),
    },
    MANAGER
  );
  stops.push(() => role.stop());
  await role.configure(f.config);
  await role.start();
  expect(
    await role.runManagementInstruction(
      'Read supervisor_brain and worker usage; provide a concise check-in.',
      () => true
    )
  ).toBe('sent');
  expect(f.act).toHaveBeenCalledOnce();
  expect(f.act.mock.calls[0][2]).toContain('owner-management-schedule');
  expect(f.task.getStatus()).toMatchObject({
    startedAt: 1000,
    continuations: 1,
    criteria: [{ verified: false }],
    outcome: 'unknown',
  });
  expect(await role.runManagementInstruction('Do not replay the old completed turn', () => true)).toBe('not-sent');
  expect(f.act).toHaveBeenCalledOnce();
  await f.task.pause();
  expect(role.canRunManagementInstruction()).toBe(false);
});
