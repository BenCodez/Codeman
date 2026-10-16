/** @fileoverview Owner completion retains receipt observation without granting another dispatch. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore, taskJournalHasOwnership, type TaskSaveAuthority } from '../src/supervision/store.js';
import { TaskController, type TaskObservation } from '../src/supervision/controller.js';
import { SessionActionArbiter } from '../src/supervision/action-arbiter.js';
import { type TaskState } from '../src/supervision/schema.js';
import { createDeferred } from './mocks/index.js';

const THREAD = '11111111-2222-4333-8444-555555555555';
const controllers: TaskController[] = [];
const roots: string[] = [];
const SID = 'completed-worker';
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
});
afterEach(async () => {
  for (const controller of controllers.splice(0)) {
    controller.stop();
    await controller.drain();
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function pending(kind: 'kickoff' | 'continuation' = 'kickoff', store?: TaskStore, ownerComplete = true) {
  let observation: TaskObservation = {
    observation: {
      conversationId: THREAD,
      activity: 'completed',
      reason: 'turn-completed',
      processReady: true,
      at: Date.now(),
      submissionKey: 'owner-before',
      turnId: 'owner-turn',
      safeToAct: false,
    },
    commands: new Map(),
  };
  let durable: TaskState | undefined;
  let common: string | undefined;
  const arbiter = new SessionActionArbiter(async (key) => {
    common = key;
  });
  const persist = vi.fn(async (state: TaskState, authority?: TaskSaveAuthority) => {
    if (store) await store.save(SID, state, authority);
    durable = structuredClone(state);
  });
  const observe = vi.fn(async () => observation);
  const accept = vi.fn((key: string) => arbiter.accept('task', key));
  const act = vi.fn((key: string) => arbiter.run('task', key, async () => 'sent', true));
  const recover = vi.fn(async () => 'sent' as const);
  const controller = new TaskController({
    observe,
    persist,
    act,
    recover,
    acceptReservation: accept,
    changed: () => {},
  });
  controllers.push(controller);
  const set = (patch: Partial<TaskObservation['observation']>) => {
    observation = { ...observation, observation: { ...observation.observation, ...patch } };
  };
  await controller.update({
    objective: 'Review the implementation',
    criteria: [{ id: 'review', description: 'Owner accepts the result', kind: 'manual' }],
  });
  await controller.resume();
  if (kind === 'continuation') {
    const kickoff = controller.getStatus().inFlight!;
    set({ submissionHash: kickoff.promptHash, submissionKey: 'kickoff-accepted', activity: 'working' });
    await controller.refresh();
    expect(controller.getStatus().inFlight).toBeUndefined();
    vi.setSystemTime(10_001);
    set({ activity: 'completed', turnId: 'new-turn', at: Date.now() });
    await controller.progress({ outcome: 'unfinished', checkpoint: 'Review started', nextAction: 'Finish review' });
    await controller.refresh();
  }
  const flight = controller.getStatus().inFlight!;
  expect(flight).toBeDefined();
  expect(common).toBeDefined();
  set({ activity: 'working', submissionHash: 'not-the-reserved-prompt', submissionKey: 'unaccepted' });
  if (ownerComplete) {
    await controller.progress({ outcome: 'completed', verifiedCriteria: ['review'] });
    expect(controller.getStatus()).toMatchObject({ phase: 'completed', outcome: 'completed', inFlight: flight });
  }
  observe.mockClear();
  accept.mockClear();
  return {
    controller,
    observe,
    accept,
    act,
    recover,
    persist,
    set,
    flight,
    arbiter,
    get durable() {
      return durable;
    },
    get common() {
      return common;
    },
    proof() {
      set({ submissionHash: flight.promptHash, submissionKey: 'exact-accepted', at: Date.now() });
    },
  };
}

it.each(['kickoff', 'continuation'] as const)(
  'automatically settles a pending %s receipt after owner completion, then stops polling',
  async (kind) => {
    const f = await pending(kind);
    const before = f.controller.getStatus();
    const effects = f.act.mock.calls.length;
    const blockedSibling = vi.fn(async () => 'sent' as const);
    expect(await f.arbiter.run('recovery', 'sibling', blockedSibling)).toBe('not-sent');
    expect(blockedSibling).not.toHaveBeenCalled();
    f.proof();
    await vi.advanceTimersByTimeAsync(4999);
    expect(f.observe).not.toHaveBeenCalled();
    expect(f.common).toBeDefined();
    await vi.advanceTimersByTimeAsync(1);
    await f.controller.drain();
    expect(f.observe).toHaveBeenCalledOnce();
    expect(f.accept).toHaveBeenCalledExactlyOnceWith(f.flight.key);
    expect(f.common).toBeUndefined();
    expect(f.controller.getStatus()).toMatchObject({
      phase: 'completed',
      outcome: 'completed',
      criteria: before.criteria,
      continuations: before.continuations,
      kickoffAt: before.kickoffAt,
    });
    expect(f.controller.getStatus().inFlight).toBeUndefined();
    expect(f.durable?.inFlight).toBeUndefined();
    expect(f.act).toHaveBeenCalledTimes(effects);
    expect(f.recover).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.observe).toHaveBeenCalledOnce();
  }
);

it.each(['wrong-hash', 'old-submission', 'other-conversation', 'missing-conversation'] as const)(
  'keeps the completed reservation sealed for %s while continuing read-only polling',
  async (change) => {
    const f = await pending();
    const effects = f.act.mock.calls.length;
    f.proof();
    f.set(
      change === 'wrong-hash'
        ? { submissionHash: 'wrong' }
        : change === 'old-submission'
          ? { submissionKey: f.flight.previousSubmissionKey }
          : { conversationId: change === 'other-conversation' ? '66666666-7777-4888-8999-aaaaaaaaaaaa' : undefined }
    );
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.observe).toHaveBeenCalledTimes(3);
    expect(f.controller.getStatus()).toMatchObject({ phase: 'completed', outcome: 'completed', inFlight: f.flight });
    expect(f.common).toBeDefined();
    expect(f.accept).not.toHaveBeenCalled();
    expect(f.act).toHaveBeenCalledTimes(effects);
    expect(f.recover).not.toHaveBeenCalled();
  }
);

it.each(['paused', 'blocked', 'disabled'] as const)(
  'reconciles only the exact pending receipt after reload into %s',
  async (phase) => {
    const f = await pending();
    f.controller.stop();
    const restored = f.controller.getStatus();
    restored.outcome = 'blocked';
    restored.criteria[0].verified = false;
    delete restored.criteria[0].evidence;
    restored.phase = phase;
    restored.agentProgressVeto = true;
    restored.config.enabled = phase !== 'disabled';
    const act = vi.fn();
    const recover = vi.fn();
    const controller = new TaskController(
      {
        observe: f.observe,
        act,
        recover,
        persist: f.persist,
        changed: () => {},
        acceptReservation: f.accept,
      },
      restored
    );
    controllers.push(controller);
    const before = controller.getStatus();
    f.proof();
    await vi.advanceTimersByTimeAsync(5000);
    expect(controller.getStatus().inFlight).toBeUndefined();
    expect(controller.getStatus()).toMatchObject({
      phase: before.phase,
      outcome: before.outcome,
      criteria: before.criteria,
      config: before.config,
      agentProgressVeto: true,
    });
    expect(act).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
  }
);

it('never clears the common reservation before acceptance is durable and retries a failed save', async () => {
  const f = await pending();
  const effects = f.act.mock.calls.length;
  f.proof();
  f.persist.mockRejectedValueOnce(new Error('private journal unavailable'));
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.common).toBeDefined();
  expect(f.accept).not.toHaveBeenCalled();
  expect(f.controller.getStatus().inFlight?.accepted).not.toBe(true);
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.common).toBeUndefined();
  expect(f.durable?.inFlight).toBeUndefined();
  expect(f.controller.getStatus().outcome).toBe('completed');
  expect(f.act).toHaveBeenCalledTimes(effects);
  expect(f.recover).not.toHaveBeenCalled();
});

it('withdraws a held receipt observation on stop and schedules no more work', async () => {
  const f = await pending();
  f.proof();
  const held = createDeferred<TaskObservation>();
  f.observe.mockImplementationOnce(() => held.promise);
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.observe).toHaveBeenCalledOnce();
  f.controller.stop();
  held.resolve({
    observation: {
      conversationId: THREAD,
      activity: 'working',
      reason: 'turn-running',
      at: Date.now(),
      submissionKey: 'exact-accepted',
      submissionHash: f.flight.promptHash,
      safeToAct: false,
    },
    commands: new Map(),
  });
  await f.controller.drain();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(f.observe).toHaveBeenCalledOnce();
  expect(f.accept).not.toHaveBeenCalled();
  expect(f.common).toBeDefined();
});

async function durablePending(kind: 'kickoff' | 'continuation', ownerComplete = true) {
  const root = await mkdtemp(join(tmpdir(), 'task-completed-reload-'));
  roots.push(root);
  const path = join(root, 'tasks.json'),
    store = new TaskStore(path);
  return Object.assign(await pending(kind, store, ownerComplete), { path });
}
function reload(f: Awaited<ReturnType<typeof durablePending>>) {
  f.controller.stop();
  const restored = new TaskStore(f.path).get(SID);
  const controller = new TaskController(
    {
      observe: f.observe,
      act: f.act,
      recover: f.recover,
      persist: f.persist,
      changed: () => {},
      acceptReservation: f.accept,
    },
    restored
  );
  controllers.push(controller);
  return controller;
}
it.each(['kickoff', 'continuation'] as const)(
  'a durably owner-completed %s remains terminal through reload, uncertain polling and exact receipt settlement',
  async (kind) => {
    const f = await durablePending(kind),
      before = f.controller.getStatus(),
      effects = f.act.mock.calls.length;
    expect(new TaskStore(f.path).get(SID)).toMatchObject({
      phase: 'completed',
      outcome: 'completed',
      inFlight: f.flight,
    });
    const restored = reload(f);
    expect(restored.getStatus()).toMatchObject({ phase: 'completed', outcome: 'completed', inFlight: f.flight });
    await vi.advanceTimersByTimeAsync(5000);
    await restored.drain();
    expect(restored.getStatus()).toMatchObject({ phase: 'completed', outcome: 'completed', inFlight: f.flight });
    expect(f.accept).not.toHaveBeenCalled();
    expect(f.common).toBeDefined();
    f.proof();
    await vi.advanceTimersByTimeAsync(5000);
    await restored.drain();
    const durable = new TaskStore(f.path).get(SID);
    expect(durable).toMatchObject({
      phase: 'completed',
      outcome: 'completed',
      criteria: before.criteria,
      continuations: before.continuations,
      kickoffAt: before.kickoffAt,
    });
    expect(durable.inFlight).toBeUndefined();
    expect(f.common).toBeUndefined();
    expect(taskJournalHasOwnership(durable)).toBe(false);
    expect(f.act).toHaveBeenCalledTimes(effects);
    expect(f.recover).not.toHaveBeenCalled();
    const observations = f.observe.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30000);
    expect(f.observe).toHaveBeenCalledTimes(observations);
  }
);
it.each(
  (['kickoff', 'continuation'] as const).flatMap((kind) =>
    (['unfinished', 'owner-input', 'unknown'] as const).map((veto) => ({ kind, veto }))
  )
)('reload preserves the $veto veto while settling only a $kind receipt', async ({ kind, veto }) => {
  const f = await durablePending(kind, veto !== 'unfinished');
  if (veto === 'owner-input') {
    f.controller.noteUserInput();
    await f.controller.drain();
  }
  if (veto === 'unknown') await f.controller.progress({ outcome: 'unknown' });
  const before = f.controller.getStatus(),
    effects = f.act.mock.calls.length;
  const restored = reload(f);
  expect(restored.getStatus().phase).toBe('paused');
  if (veto === 'unknown') expect(restored.getStatus().agentProgressVeto).toBe(true);
  f.proof();
  await vi.advanceTimersByTimeAsync(5000);
  await restored.drain();
  const durable = new TaskStore(f.path).get(SID);
  expect(durable).toMatchObject({
    phase: 'paused',
    outcome: before.outcome,
    criteria: before.criteria,
    config: before.config,
  });
  expect(durable.agentProgressVeto).toBe(before.agentProgressVeto);
  expect(durable.inFlight).toBeUndefined();
  expect(taskJournalHasOwnership(durable)).toBe(true);
  expect(f.act).toHaveBeenCalledTimes(effects);
  expect(f.recover).not.toHaveBeenCalled();
});
