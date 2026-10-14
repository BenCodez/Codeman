/** @fileoverview V1 attention-only detector; layer 5 supplies separate v2 stall lifecycle coverage. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecoveryController } from '../src/recovery/controller.js';
import { initialRecoveryState, type RecoveryObservation, type RecoveryState } from '../src/recovery/types.js';
import { createDeferred } from './mocks/index.js';

const NOW = Date.UTC(2026, 9, 14, 12);
const THREAD = '11111111-2222-3333-4444-555555555555';
const controllers: RecoveryController[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
  vi.useRealTimers();
});

function fixture(patch: Partial<RecoveryState> = {}) {
  const state = { ...initialRecoveryState(), ...patch };
  state.config.enabled = true;
  state.config.detectStalls = true;
  state.config.stalledAfterMs = 10_000;
  state.armedAt = NOW;
  const f = {
    observation: {
      activity: 'working',
      reason: 'turn-running',
      at: NOW,
      progressAt: NOW,
      conversationId: THREAD,
      safeToAct: false,
    } as RecoveryObservation,
    changes: [] as RecoveryState[],
    journal: [] as RecoveryState[],
  };
  const observe = vi.fn(async () => structuredClone(f.observation));
  const act = vi.fn(async () => 'not-sent' as const);
  const persist = vi.fn(async (next: RecoveryState) => {
    f.journal.push(structuredClone(next));
  });
  const controller = new RecoveryController(
    {
      observe,
      act,
      persist,
      changed: (next) => f.changes.push(structuredClone(next)),
      now: () => Date.now(),
    },
    state
  );
  controllers.push(controller);
  return Object.assign(f, { controller, observe, act, persist });
}

async function alert(f: ReturnType<typeof fixture>): Promise<void> {
  vi.setSystemTime(NOW + 10_000);
  await f.controller.refresh();
  expect(f.controller.getStatus()).toMatchObject({ phase: 'paused', needsAttention: true, lastReason: 'stalled' });
}

describe.runIf(Number(initialRecoveryState().version) === 1)('foundation stall attention retention', () => {
  it('retains the warning across automatic polls and mixed read-only inspections without duplicate attention events', async () => {
    const f = fixture();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.controller.getStatus()).toMatchObject({ phase: 'paused', needsAttention: true, lastReason: 'stalled' });
    for (let i = 0; i < 3; i++) {
      await f.controller.inspect();
      await f.controller.refresh();
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.controller.getStatus()).toMatchObject({ phase: 'paused', needsAttention: true, lastReason: 'stalled' });
    }
    expect(
      f.controller.getStatus().history.filter((event) => event.kind === 'attention' && event.reason === 'stalled')
    ).toHaveLength(1);
    expect(f.changes.filter((state) => state.needsAttention)).toHaveLength(1);
    expect(f.journal.filter((state) => state.needsAttention)).toHaveLength(1);
    expect(f.act).not.toHaveBeenCalled();
    expect(f.controller.getStatus().pending).toBeUndefined();
    expect(f.controller.getStatus().inFlight).toBeUndefined();
  });

  it.each(['inspect', 'refresh'] as const)('clears the warning after fresh real progress during %s', async (read) => {
    const f = fixture();
    await alert(f);
    f.observation.progressAt = Date.now();
    f.observation.at = Date.now();
    await f.controller[read]();
    expect(f.controller.getStatus()).toMatchObject({
      phase: 'watching',
      needsAttention: false,
      lastReason: 'turn-running',
    });
    await f.controller.refresh();
    expect(f.controller.getStatus().needsAttention).toBe(false);
    expect(f.act).not.toHaveBeenCalled();
  });

  it.each([
    ['blocked', 'authentication-required', 'paused', true],
    ['blocked', 'usage-limit', 'paused', true],
    ['paused', 'approval-required', 'paused', true],
    ['paused', 'user-interrupted', 'paused', true],
    ['unknown', 'identity-unverified', 'paused', true],
    ['interrupted', 'turn-failed', 'watching', true],
    ['crashed', 'process-crashed', 'watching', true],
    ['working', 'internal-retry', 'watching', false],
    ['watching', 'background-work', 'watching', false],
  ] as const)(
    'preserves the stronger current %s/%s veto instead of retaining a stale stall label',
    async (activity, reason, phase, needsAttention) => {
      const f = fixture();
      await alert(f);
      f.observation = { ...f.observation, activity, reason };
      await f.controller.inspect();
      await f.controller.refresh();
      expect(f.controller.getStatus()).toMatchObject({ phase, needsAttention, lastReason: reason });
      expect(f.act).not.toHaveBeenCalled();
    }
  );

  it('dismisses a pure stall on owner input and waits a full new quiet interval before re-alerting', async () => {
    const f = fixture();
    await alert(f);
    f.controller.noteUserInput();
    await f.controller.drain();
    expect(f.controller.getStatus()).toMatchObject({ needsAttention: false, lastReason: 'user-input' });
    vi.setSystemTime(Date.now() + 9999);
    await f.controller.inspect();
    await f.controller.refresh();
    expect(f.controller.getStatus().needsAttention).toBe(false);
    vi.setSystemTime(Date.now() + 1);
    await f.controller.refresh();
    expect(f.controller.getStatus()).toMatchObject({ phase: 'paused', needsAttention: true, lastReason: 'stalled' });
    expect(f.controller.getStatus().history.filter((event) => event.kind === 'attention')).toHaveLength(2);
    expect(f.act).not.toHaveBeenCalled();
  });

  it.each([{ enabled: false }, { detectStalls: false }])(
    'dismisses only the stall warning when owner settings change to %j',
    async (patch) => {
      const f = fixture();
      await alert(f);
      await f.controller.updateConfig(patch);
      await f.controller.inspect();
      await f.controller.refresh();
      expect(f.controller.getStatus().needsAttention).toBe(false);
      expect(f.act).not.toHaveBeenCalled();
    }
  );

  it('retains an active warning through unrelated settings edits without repeating its notification', async () => {
    const f = fixture();
    await alert(f);
    await f.controller.updateConfig({ maxRetries: 2 });
    await f.controller.inspect();
    await f.controller.refresh();
    expect(f.controller.getStatus()).toMatchObject({ phase: 'paused', needsAttention: true, lastReason: 'stalled' });
    expect(f.controller.getStatus().history.filter((event) => event.kind === 'attention')).toHaveLength(1);
    expect(f.act).not.toHaveBeenCalled();
  });

  it('honors owner input cancellation while a stale observation is still pending', async () => {
    const f = fixture();
    await alert(f);
    const entered = createDeferred<void>();
    const observed = createDeferred<RecoveryObservation>();
    f.observe.mockImplementationOnce(async () => {
      entered.resolve();
      return observed.promise;
    });
    const refreshing = f.controller.refresh();
    await entered.promise;
    try {
      f.controller.noteUserInput();
    } finally {
      observed.resolve(f.observation);
    }
    await refreshing;
    await f.controller.drain();
    expect(f.controller.getStatus()).toMatchObject({ needsAttention: false, lastReason: 'user-input' });
    expect(f.act).not.toHaveBeenCalled();
  });

  it('does not replace a persistence circuit with a quiet-pane warning', async () => {
    const f = fixture();
    await alert(f);
    f.persist.mockRejectedValue(new Error('Fixture write failure'));
    await expect(f.controller.updateConfig({ maxRetries: 2 })).rejects.toThrow();
    f.controller.noteUserInput();
    await f.controller.inspect();
    await f.controller.refresh();
    expect(f.controller.getStatus()).toMatchObject({
      circuitOpen: true,
      needsAttention: true,
      lastReason: 'persistence-failed',
    });
    expect(f.act).not.toHaveBeenCalled();
  });

  it('retains an uncertain flight through quiet observations, owner input and detector settings changes', async () => {
    const flight = { key: 'unknown-flight', action: 'continue' as const, conversationId: THREAD, startedAt: NOW };
    const f = fixture({ inFlight: flight });
    vi.setSystemTime(NOW + 10_000);
    await f.controller.refresh();
    await f.controller.inspect();
    f.controller.noteUserInput();
    await f.controller.updateConfig({ detectStalls: false });
    await f.controller.refresh();
    expect(f.controller.getStatus()).toMatchObject({
      inFlight: flight,
      phase: 'paused',
      needsAttention: true,
      lastReason: 'acceptance-unverified',
    });
    expect(f.act).not.toHaveBeenCalled();
  });

  it('preserves historical warning state when owner stop cancels an unfinished inspection', async () => {
    const f = fixture();
    await alert(f);
    const before = f.controller.getStatus();
    const writes = f.journal.length;
    const entered = createDeferred<void>();
    const observed = createDeferred<RecoveryObservation>();
    f.observe.mockImplementationOnce(async () => {
      entered.resolve();
      return observed.promise;
    });
    const inspecting = f.controller.inspect();
    await entered.promise;
    try {
      f.controller.stop();
    } finally {
      observed.resolve({ ...f.observation, progressAt: Date.now() });
    }
    await inspecting;
    expect(f.controller.getStatus()).toEqual(before);
    expect(f.journal).toHaveLength(writes);
    expect(f.act).not.toHaveBeenCalled();
  });
});
