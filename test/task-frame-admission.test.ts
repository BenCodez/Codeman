/** Exact real broker framing, without worker processes; metadata is private fixture evidence. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexInputBroker, type CodexBrokerProof } from '../src/recovery/codex-input-broker.js';
import {
  formatTaskPrompt,
  taskPromptFits,
  taskPromptFrameFits,
  type TaskFrameEvidence,
} from '../src/supervision/prompt.js';
import { initialTaskState, type TaskState } from '../src/supervision/schema.js';
import { TaskController, TaskValidationError, type TaskObservation } from '../src/supervision/controller.js';

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const THREAD = '11111111-2222-3333-4444-555555555555';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function brokerFixture(paths = 40, issuer = false) {
  const root = await mkdtemp(join(tmpdir(), 'task-frame-budget-'));
  roots.push(root);
  const broker = await CodexInputBroker.create(root, SID, 'explicit fake worker', '/fixture/home');
  Reflect.set(broker, 'ready', true);
  const owners = {
    'owner-pty': Number.MAX_SAFE_INTEGER,
    'owner-key': Number.MAX_SAFE_INTEGER,
    'owner-mux': Number.MAX_SAFE_INTEGER,
  };
  const file = {
    path: '/fixture/home/state.json',
    dev: Number.MAX_SAFE_INTEGER,
    ino: Number.MAX_SAFE_INTEGER,
    size: 98_304,
    mtimeMs: 1_700_000_000_000.999,
    ctimeMs: 1_700_000_000_000.999,
    hash: 'a'.repeat(64),
    maxBytes: 98_304,
  };
  const proof: CodexBrokerProof = {
    incarnation: broker.incarnation,
    brokerPid: 700,
    childPid: 701,
    brokerStart: '1234',
    childStart: '1235',
    closed: false,
    rawGeneration: Number.MAX_SAFE_INTEGER,
    launchDigest: 'b'.repeat(64),
    homeDigest: 'c'.repeat(64),
    ownerCounters: owners,
    fileWitness: file,
  };
  const scope: TaskFrameEvidence = {
    sessionId: SID,
    incarnation: broker.incarnation,
    conversationId: THREAD,
    expectedOwners: owners,
    privateFiles: [file],
    privatePaths: Array.from({ length: paths }, (_, i) => ({
      path: `/fixture/home/sessions/2026/10/15/${'rollout-'.repeat(15)}${i}.jsonl`,
      kind: 'file' as const,
      dev: Number.MAX_SAFE_INTEGER,
      ino: Number.MAX_SAFE_INTEGER,
      size: 262_144,
      mtimeMs: 1_700_000_000_000.999,
      ctimeMs: 1_700_000_000_000.999,
    })),
    ...(issuer
      ? {
          issuer: {
            sessionId: '22222222-3333-4444-5555-666666666666',
            incarnation: broker.incarnation,
            directory: '/fixture/manager/broker',
            proof,
            files: [file],
            paths: [],
          },
        }
      : {}),
  };
  const frame = (prompt: string) => {
    Reflect.get(broker, 'counters').auto = Number.MAX_SAFE_INTEGER - 1;
    return broker.frame(
      'auto',
      prompt,
      THREAD,
      scope.issuer,
      scope.privateFiles,
      owners,
      scope.privatePaths,
      [],
      Number.MAX_SAFE_INTEGER
    );
  };
  return { broker, scope, frame };
}

it.each([false, true])(
  'pins the preview to real broker.frame with maximum-width mutable fields (issuer=%s)',
  async (issuer) => {
    for (const count of [0, 40]) {
      const f = await brokerFixture(count, issuer);
      for (const size of [1, 16_384, 49_152, 65_536]) {
        const prompt = 'x'.repeat(size);
        const before = structuredClone(Reflect.get(f.broker, 'counters'));
        const verdict = taskPromptFrameFits(prompt, f.scope);
        expect(Reflect.get(f.broker, 'counters')).toEqual(before);
        expect(verdict).toBe(!!f.frame(prompt));
      }
    }
  }
);

it('preserves the raw 65,536-byte ordinary owner limit while accounting for automatic witnesses', async () => {
  const f = await brokerFixture();
  const prompt = 'x'.repeat(65_536);
  expect(f.broker.frame('owner-mux', prompt)).toBeDefined();
  expect(taskPromptFrameFits(prompt, f.scope)).toBe(false);
  expect(f.frame(prompt)).toBeUndefined();
  expect(taskPromptFrameFits('Short task prompt', f.scope)).toBe(true);
  expect(f.frame('Short task prompt')).toBeDefined();
});

it('matches broker witness deduplication regardless of property insertion order', async () => {
  const f = await brokerFixture(1);
  const file = f.scope.privateFiles[0];
  f.scope.privateFiles = [
    file,
    {
      maxBytes: file.maxBytes,
      hash: file.hash,
      ctimeMs: file.ctimeMs,
      mtimeMs: file.mtimeMs,
      size: file.size,
      ino: file.ino,
      dev: file.dev,
      path: file.path,
    },
  ];
  expect(taskPromptFrameFits('Small task', f.scope)).toBe(true);
  expect(f.frame('Small task')).toBeDefined();
});

it.each(['configuration', 'start', 'continuation'] as const)(
  'rejects the actual oversized envelope before %s publication or reservation',
  async (entry) => {
    const f = await brokerFixture();
    const state = initialTaskState();
    state.objective = 'o'.repeat(4000);
    state.criteria = Array.from({ length: 28 }, (_, i) => ({
      id: `c${i}`,
      kind: 'command' as const,
      description: 'd'.repeat(1000),
      command: 'c'.repeat(1000),
      verified: false,
    }));
    state.outcome = 'unfinished';
    state.checkpoint = 'Checked';
    state.nextAction = 'Continue';
    expect(taskPromptFits(state)).toBe(true);
    expect(taskPromptFrameFits(formatTaskPrompt(state), f.scope)).toBe(false);
    expect(f.frame(formatTaskPrompt(state))).toBeUndefined();
    const observed: TaskObservation = {
      observation: {
        activity: 'completed',
        reason: 'turn-completed',
        at: 10_001,
        conversationId: THREAD,
        turnId: 'turn',
        submissionKey: 'submission',
        processReady: true,
        safeToAct: false,
      },
      commands: new Map(),
    };
    const persist = vi.fn(async (_state: TaskState) => {}),
      act = vi.fn(async () => 'sent' as const);
    const admitPrompt = vi.fn(async (prompt: string) => taskPromptFrameFits(prompt, f.scope));
    const c = new TaskController(
      { now: () => 10_000, observe: async () => observed, persist, act, changed: () => {}, admitPrompt },
      state
    );
    try {
      if (entry === 'configuration') {
        const before = c.getStatus();
        await expect(c.update({ config: { enabled: true } })).rejects.toBeInstanceOf(TaskValidationError);
        expect(c.getStatus()).toEqual(before);
        expect(persist).not.toHaveBeenCalled();
      } else if (entry === 'start') {
        const before = c.getStatus();
        await expect(c.resume()).rejects.toBeInstanceOf(TaskValidationError);
        expect(c.getStatus()).toEqual(before);
        expect(persist).not.toHaveBeenCalled();
      } else {
        // Enter a genuinely watching task through a smaller proven envelope first.
        admitPrompt.mockResolvedValueOnce(true);
        await c.update({ config: { enabled: true } });
        persist.mockClear();
        await c.refresh();
        expect(c.getStatus()).toMatchObject({
          phase: 'paused',
          reason: 'task-evidence-unknown',
          agentProgressVeto: true,
        });
        expect(persist.mock.calls.some((args) => Reflect.get(args[0] ?? {}, 'inFlight'))).toBe(false);
      }
      expect(c.getStatus().inFlight).toBeUndefined();
      expect(c.getStatus().continuations).toBe(0);
      expect(act).not.toHaveBeenCalled();
    } finally {
      c.stop();
      await c.drain();
    }
  }
);

it.each(['unknown', 'changed-owner'] as const)('does not reserve on %s admission', async (kind) => {
  const hold = Promise.withResolvers<boolean>();
  const persist = vi.fn(async (_state: TaskState) => {}),
    act = vi.fn(async () => 'sent' as const);
  const c = new TaskController({
    now: () => 10_000,
    observe: async () => ({
      observation: {
        activity: 'idle',
        reason: 'observing',
        at: 10_000,
        conversationId: THREAD,
        processReady: true,
        safeToAct: false,
      },
      commands: new Map(),
    }),
    persist,
    act,
    changed: () => {},
    admitPrompt: async () => hold.promise,
  });
  try {
    await c.update({ objective: 'Task', criteria: [{ id: 'review', kind: 'manual', description: 'Review' }] });
    persist.mockClear();
    const start = c.resume();
    await Promise.resolve();
    await Promise.resolve();
    if (kind === 'changed-owner') c.noteUserInput();
    hold.resolve(kind === 'changed-owner');
    await expect(start).rejects.toBeInstanceOf(TaskValidationError);
    expect(act).not.toHaveBeenCalled();
    expect(c.getStatus().inFlight).toBeUndefined();
    expect(c.getStatus().continuations).toBe(0);
    expect(persist.mock.calls.some((args) => Reflect.get(args[0] ?? {}, 'inFlight'))).toBe(false);
  } finally {
    c.stop();
    await c.drain();
  }
});

it.each(['crashed', 'completed'] as const)(
  'resumes accepted work without an input preview, retaining admission for later %s actions',
  async (activity) => {
    const state = initialTaskState();
    state.objective = 'Finish the accepted task';
    state.criteria = [{ id: 'review', kind: 'manual', description: 'Owner review', verified: false }];
    state.config.enabled = true;
    state.startedAt = 9000;
    state.kickoffAt = 9000;
    state.conversationId = THREAD;
    state.outcome = 'unfinished';
    state.checkpoint = 'Accepted work';
    state.nextAction = 'Continue';
    let now = 10_000;
    const admitPrompt = vi.fn(async () => false);
    const recover = vi.fn(async () => 'sent' as const);
    const act = vi.fn(async () => 'sent' as const);
    const persist = vi.fn(async (_state: TaskState) => {});
    const c = new TaskController(
      {
        now: () => now,
        observe: async () => ({
          observation: {
            activity,
            reason: activity === 'crashed' ? 'process-crashed' : 'turn-completed',
            at: 10_001,
            liveProofAt: 10_001,
            conversationId: THREAD,
            evidenceKey: 'owned-crash',
            turnId: 'completed-turn',
            processReady: activity === 'completed',
            safeToAct: activity === 'crashed',
          },
          commands: new Map(),
        }),
        admitPrompt,
        recover,
        act,
        persist,
        changed: () => {},
      },
      state
    );
    try {
      await c.resume();
      expect(c.getStatus()).toMatchObject({ phase: 'watching', reason: 'owner-resumed', continuations: 0 });
      expect(admitPrompt).not.toHaveBeenCalled();
      expect(act).not.toHaveBeenCalled();
      expect(recover).not.toHaveBeenCalled();
      now = 10_002;
      await c.refresh();
      if (activity === 'crashed') {
        expect(recover).toHaveBeenCalledOnce();
        expect(admitPrompt).not.toHaveBeenCalled();
        expect(c.getStatus()).toMatchObject({ continuations: 1, reason: 'recovery-sent' });
      } else {
        expect(admitPrompt).toHaveBeenCalledOnce();
        expect(recover).not.toHaveBeenCalled();
        expect(c.getStatus()).toMatchObject({ phase: 'paused', reason: 'task-evidence-unknown', continuations: 0 });
        expect(c.getStatus().inFlight).toBeUndefined();
      }
      expect(act).not.toHaveBeenCalled();
    } finally {
      c.stop();
      await c.drain();
    }
  }
);
