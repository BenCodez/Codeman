/** Settings are not new recovery evidence; fake observations and the real push-change predicate only. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDeferred } from './mocks/index.js';
import { RecoveryController } from '../src/recovery/controller.js';
import {
  initialRecoveryState,
  type RecoveryConfig,
  type RecoveryObservation,
  type RecoveryReason,
  type RecoveryState,
} from '../src/recovery/types.js';

const NOW = Date.UTC(2026, 9, 15, 12);
const THREAD = '11111111-2222-3333-4444-555555555555';
const controllers: RecoveryController[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(async () => {
  for (const controller of controllers.splice(0)) {
    controller.stop();
    await controller.drain();
  }
  vi.useRealTimers();
});

function fixture(remote: boolean, legacy: boolean, change: Partial<RecoveryState> = {}) {
  const state = initialRecoveryState();
  Object.assign(state, {
    conversationId: THREAD,
    phase: 'paused',
    activity: 'working',
    armedAt: NOW - 60_000,
    needsAttention: true,
    lastReason: 'stall-unverified',
    history: [{ at: NOW - 1000, kind: 'attention', reason: legacy ? 'stalled' : 'stall-unverified', attempt: 0 }],
    ...change,
  });
  state.config = { ...state.config, enabled: true, detectStalls: true, stalledAfterMs: 10_000 };
  if (!legacy && state.needsAttention)
    state.stallAlert = {
      key: 'same-turn',
      conversationId: THREAD,
      progressAt: NOW - 20_000,
      ...(remote ? { progressEvidenceKey: `remote:${'a'.repeat(64)}` } : {}),
    };
  const f = {
    observation: {
      activity: 'working',
      reason: 'turn-running',
      at: NOW - 20_000,
      progressAt: NOW - 20_000,
      conversationId: THREAD,
      stallEvidenceKey: 'same-turn',
      safeToAct: false,
      ...(remote ? { progressEvidenceKey: `remote:${'a'.repeat(64)}`, progressLowerBound: NOW - 20_001 } : {}),
    } as RecoveryObservation,
    pushes: [] as RecoveryReason[],
  };
  let previous = { attention: state.needsAttention, reason: state.lastReason };
  const persist = vi.fn(async (_state: RecoveryState) => {});
  const act = vi.fn(async () => 'sent' as const);
  const controller = new RecoveryController(
    {
      observe: async () => ({ ...structuredClone(f.observation), stallObservedAt: Date.now() }),
      persist,
      act,
      // Keep this identical to WebServer's changed callback push admission.
      changed: (next) => {
        if (next.needsAttention && (!previous.attention || next.lastReason !== previous.reason))
          f.pushes.push(next.lastReason);
        previous = { attention: next.needsAttention, reason: next.lastReason };
      },
    },
    state
  );
  previous = { attention: controller.getStatus().needsAttention, reason: controller.getStatus().lastReason };
  controllers.push(controller);
  return Object.assign(f, { controller, persist, act });
}

const patches: Array<{ label: string; patch: Partial<RecoveryConfig> }> = [
  { label: 'empty', patch: {} },
  { label: 'unrelated', patch: { maxRetries: 4 } },
  { label: 'idempotent', patch: { detectStalls: true } },
  { label: 'disabled', patch: { enabled: false } },
  { label: 'detection withdrawn', patch: { detectStalls: false } },
  { label: 'restart enabled', patch: { restartStalls: true } },
  { label: 'restart withdrawn', patch: { restartStalls: false } },
];

it.each(
  [false, true].flatMap((remote) =>
    [false, true].flatMap((legacy) => patches.map(({ label, patch }) => ({ remote, legacy, label, patch })))
  )
)('retains owned warning across $label settings without duplicate pushes (SSH=$remote legacy=$legacy)', async (f) => {
  const x = fixture(f.remote, f.legacy);
  const before = x.controller.getStatus();
  await x.controller.updateConfig(f.patch);
  expect(x.controller.getStatus()).toMatchObject({ needsAttention: true, lastReason: 'stall-unverified' });
  expect(x.pushes).toEqual([]);
  await x.controller.inspect();
  expect(x.controller.getStatus()).toMatchObject({ needsAttention: true, lastReason: 'stall-unverified' });
  expect(x.pushes).toEqual([]);
  expect(x.controller.getStatus().history.filter((event) => event.kind === 'attention')).toEqual(before.history);
  expect(x.act).not.toHaveBeenCalled();
  expect(x.persist).toHaveBeenCalled();
});

it.each(
  [false, true].flatMap((legacy) =>
    (['approval-required', 'authentication-required', 'identity-unverified', 'transport-unreachable'] as const).map(
      (reason) => ({ legacy, reason })
    )
  )
)('retains newer passive $reason attention rather than reviving a legacy=$legacy stall', async ({ legacy, reason }) => {
  const x = fixture(true, legacy);
  x.observation.activity = 'blocked';
  x.observation.reason = reason;
  await x.controller.inspect();
  expect(x.controller.getStatus().lastReason).toBe(reason);
  x.pushes.length = 0;
  const before = x.controller.getStatus();
  await x.controller.updateConfig({ maxRetries: 4 });
  expect(x.controller.getStatus()).toMatchObject({ needsAttention: true, lastReason: reason, phase: before.phase });
  expect(x.pushes).toEqual([]);
  await x.controller.inspect();
  expect(x.pushes).toEqual([]);
  expect(x.act).not.toHaveBeenCalled();
});

it.each(['owner-input', 'reset', 'progress', 'completed'] as const)(
  'releases stall ownership after %s and allows ordinary settings summaries',
  async (release) => {
    const x = fixture(false, false);
    if (release === 'owner-input') {
      x.controller.noteUserInput();
      await x.controller.drain();
    } else if (release === 'reset') await x.controller.reset();
    else {
      x.observation = {
        ...x.observation,
        ...(release === 'completed' ? { activity: 'completed', reason: 'turn-completed' } : { progressAt: NOW }),
      };
      await x.controller.inspect();
    }
    expect(x.controller.getStatus().needsAttention).toBe(false);
    expect(x.controller.getStatus().stallAlert).toBeUndefined();
    await x.controller.updateConfig({ maxRetries: 4 });
    expect(x.controller.getStatus()).toMatchObject({ needsAttention: false, lastReason: 'observing' });
    expect(x.act).not.toHaveBeenCalled();
  }
);

it.each([
  { reason: 'persistence-failed', accepted: false },
  { reason: 'retries-exhausted', accepted: false },
  { reason: 'acceptance-unverified', accepted: false },
  { reason: 'acceptance-unverified', accepted: true },
] as const)(
  'does not replace stronger $reason attention or accepted=$accepted flight on settings updates',
  async ({ reason, accepted }) => {
    const x = fixture(false, false, {
      phase: 'failed',
      circuitOpen: reason !== 'acceptance-unverified',
      lastReason: reason,
      history: [{ at: NOW, kind: 'attention', reason, attempt: 1 }],
      ...(reason === 'acceptance-unverified'
        ? {
            inFlight: {
              key: 'reserved',
              action: 'restart',
              conversationId: THREAD,
              startedAt: NOW,
              ...(accepted ? { accepted: true, acceptedAt: NOW } : {}),
            },
          }
        : {}),
    });
    const before = x.controller.getStatus();
    x.pushes.length = 0;
    await x.controller.updateConfig({ maxRetries: 4 });
    expect(x.controller.getStatus()).toMatchObject({
      needsAttention: true,
      lastReason: before.lastReason,
      phase: before.phase,
      circuitOpen: before.circuitOpen,
    });
    expect(x.controller.getStatus().inFlight).toEqual(before.inFlight);
    expect(x.pushes).toEqual([]);
  }
);

it.each([false, true])(
  'sends one genuine stall push and none for settings or unchanged polls (SSH=%s)',
  async (remote) => {
    const x = fixture(remote, false, { needsAttention: false, history: [], lastReason: 'turn-running' });
    await x.controller.refresh();
    vi.setSystemTime(NOW + 2000);
    await x.controller.refresh();
    expect(x.pushes).toEqual(['stall-unverified']);
    for (const { patch } of patches) {
      await x.controller.updateConfig(patch);
      await x.controller.inspect();
      await x.controller.refresh();
      expect(x.pushes).toEqual(['stall-unverified']);
    }
    expect(x.act).not.toHaveBeenCalled();
  }
);

it('still reports a genuinely new persistence failure and retains it on a later successful settings save', async () => {
  const x = fixture(false, false);
  x.persist.mockRejectedValueOnce(new Error('private fake journal unavailable'));
  await expect(x.controller.updateConfig({ maxRetries: 4 })).rejects.toThrow('Recovery state could not be saved');
  expect(x.pushes).toEqual(['persistence-failed']);
  expect(x.controller.getStatus().stallAlert).toBeUndefined();
  await x.controller.updateConfig({ maxRetries: 5 });
  expect(x.controller.getStatus()).toMatchObject({
    needsAttention: true,
    lastReason: 'persistence-failed',
    circuitOpen: true,
  });
  expect(x.pushes).toEqual(['persistence-failed']);
});

it.each([false, true])('does not let a retained legacy=%s marker pause newer child-work attention', async (legacy) => {
  const x = fixture(false, legacy);
  x.observation.activity = 'watching';
  x.observation.reason = 'background-work';
  await x.controller.refresh();
  expect(x.controller.getStatus()).toMatchObject({
    needsAttention: true,
    phase: 'watching',
    lastReason: 'background-work',
  });
  x.pushes.length = 0;
  await x.controller.updateConfig({ maxRetries: 4 });
  expect(x.controller.getStatus()).toMatchObject({
    needsAttention: true,
    phase: 'watching',
    lastReason: 'background-work',
  });
  expect(x.pushes).toEqual([]);
});

it.each(['stalled', 'observing', 'disabled', 'turn-running'] as const)(
  'retains exact unresolved parent-summary %s until an actual observation migrates it',
  async (reason) => {
    const x = fixture(false, true, { lastReason: reason });
    expect(x.controller.getStatus().stallAlert).toBeUndefined();
    await x.controller.updateConfig({ maxRetries: 4 });
    expect(x.controller.getStatus()).toMatchObject({ needsAttention: true, lastReason: reason });
    expect(x.pushes).toEqual([]);
    await x.controller.inspect();
    expect(x.controller.getStatus()).toMatchObject({ needsAttention: true, lastReason: 'stall-unverified' });
    expect(x.pushes).toEqual(['stall-unverified']);
    await x.controller.updateConfig({ maxRetries: 5 });
    await x.controller.inspect();
    expect(x.pushes).toEqual(['stall-unverified']);
  }
);

it.each(['owner-input', 'task-and-owner-input', 'generic-crash'] as const)(
  'never restores an old stall warning after a certified unsent %s action',
  async (kind) => {
    const x = fixture(false, false);
    if (kind === 'generic-crash') {
      Object.assign(x.observation, {
        activity: 'crashed',
        reason: 'process-crashed',
        safeToAct: true,
        at: NOW + 10_000,
        evidenceKey: 'actual-crash',
      });
      delete x.observation.stallEvidenceKey;
    } else Object.assign(x.observation, { stallRestartable: true, processProofKey: 'exact-dead-worker' });
    await x.controller.updateConfig({ restartStalls: true });
    // Explicitly arming the policy requires its own entire quiet interval.
    vi.setSystemTime(NOW + 10_000);
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const deps = Reflect.get(x.controller, 'deps');
    let taskOwnsAction = false;
    deps.hasActionAuthority = () => !taskOwnsAction;
    deps.act = async (_flight: unknown, current: () => boolean) => {
      entered.resolve();
      await release.promise;
      expect(current()).toBe(false);
      return 'not-sent';
    };
    await x.controller.refresh();
    vi.setSystemTime(NOW + 12_000);
    const acting = x.controller.retry();
    await entered.promise;
    let updating: Promise<RecoveryState> | undefined;
    if (kind === 'generic-crash') updating = x.controller.updateConfig({ enabled: false });
    else {
      x.controller.noteUserInput();
      if (kind === 'task-and-owner-input') taskOwnsAction = true;
    }
    release.resolve();
    await acting;
    if (updating) await updating;
    await x.controller.drain();
    expect(x.controller.getStatus()).toMatchObject({ needsAttention: false, attempts: 0 });
    expect(x.controller.getStatus().inFlight).toBeUndefined();
    expect(x.controller.getStatus().lastReason).not.toBe('stall-unverified');
    if (kind !== 'generic-crash') expect(x.controller.getStatus().stallAlert).toBeUndefined();
  }
);
