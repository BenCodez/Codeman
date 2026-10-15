/** Owner policy consent requires fresh automatic observations; time and all effects are fake. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RecoveryController } from '../src/recovery/controller.js';
import {
  initialRecoveryState,
  type RecoveryConfig,
  type RecoveryObservation,
  type RecoveryState,
} from '../src/recovery/types.js';
const NOW = Date.UTC(2026, 9, 14, 12);
const CID = '11111111-2222-3333-4444-555555555555';
const controllers: RecoveryController[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
  vi.useRealTimers();
});
function advance(ms: number) {
  vi.setSystemTime(Date.now() + ms);
}
function fixture(kind: 'crashed' | 'interrupted', patch: Partial<RecoveryState> = {}) {
  const initial = initialRecoveryState();
  const state: RecoveryState = {
    ...initial,
    ...patch,
    armedAt: patch.armedAt ?? NOW,
    config: { ...initial.config, enabled: true, retryDelayMs: 1000, maxRetryDelayMs: 4000, ...patch.config },
  };
  const observation: RecoveryObservation = {
    activity: kind,
    reason: kind === 'crashed' ? 'process-crashed' : 'turn-failed',
    at: NOW,
    conversationId: CID,
    evidenceKey: 'same-owned-failure',
    processProofKey: 'same-native-incarnation',
    safeToAct: true,
  };
  const observe = vi.fn(async () => structuredClone(observation));
  const act = vi.fn(async (_flight: NonNullable<RecoveryState['inFlight']>) => 'sent' as const);
  const persist = vi.fn(async (_value: RecoveryState) => {});
  const controller = new RecoveryController({ observe, act, persist, changed: vi.fn(), now: Date.now }, state);
  controllers.push(controller);
  return { controller, observation, observe, act, persist };
}
const kinds = ['crashed', 'interrupted'] as const;
const flags = ['enabled', 'recoverCrashes', 'recoverInterrupted', 'detectStalls'] as const;
it.each(kinds.flatMap((kind) => flags.map((flag) => ({ kind, flag }))))(
  'requires new automatic confirmation after actual $flag consent changes for $kind',
  async ({ kind, flag }) => {
    const f = fixture(kind),
      original = structuredClone(f.observation);
    await f.controller.refresh();
    const initial = f.controller.getStatus();
    // Both owner edits precede another poll and occur at the same wall timestamp.
    // Even global enable keeps the exact event/armedAt scope in this regression.
    const before = initial.config[flag];
    await f.controller.updateConfig({ [flag]: !before });
    await f.controller.updateConfig({ [flag]: before });
    expect(f.controller.getStatus().armedAt).toBe(initial.armedAt);
    expect(f.observation).toEqual(original);
    advance(2000);
    await f.controller.refresh();
    expect(f.controller.getStatus().pending).toBeUndefined();
    expect(f.controller.getStatus().windowStartedAt).toBeUndefined();
    expect(f.act).not.toHaveBeenCalled();
    advance(1999);
    await f.controller.refresh();
    expect(f.controller.getStatus().pending).toBeUndefined();
    expect(f.act).not.toHaveBeenCalled();
    advance(1);
    await f.controller.refresh();
    expect(f.controller.getStatus().pending).toMatchObject({
      key: original.evidenceKey,
      action: kind === 'crashed' ? 'restart' : 'continue',
      conversationId: CID,
    });
    expect(f.controller.getStatus().nextRetryAt).toBe(Date.now() + 1000);
    expect(f.controller.getStatus().attempts).toBe(0);
    expect(f.act).not.toHaveBeenCalled();
    advance(1000);
    await f.controller.refresh();
    expect(f.act).toHaveBeenCalledOnce();
    expect(f.act.mock.calls[0]?.[0]).toMatchObject({ action: kind === 'crashed' ? 'restart' : 'continue' });
  }
);
it.each(kinds.flatMap((kind) => (['idempotent', 'unrelated'] as const).map((change) => ({ kind, change }))))(
  'retains confirmation for $change configuration updates during $kind',
  async ({ kind, change }) => {
    const f = fixture(kind);
    await f.controller.refresh();
    const patch: Partial<RecoveryConfig> =
      change === 'idempotent'
        ? { enabled: true, recoverCrashes: true, recoverInterrupted: true, detectStalls: false }
        : { retryDelayMs: 2000, maxRetries: 4 };
    await f.controller.updateConfig(patch);
    advance(2000);
    await f.controller.refresh();
    expect(f.controller.getStatus().pending).toMatchObject({ key: f.observation.evidenceKey });
    expect(f.controller.getStatus().nextRetryAt).toBe(Date.now() + (change === 'unrelated' ? 2000 : 1000));
    expect(f.act).not.toHaveBeenCalled();
  }
);
it.each(kinds)(
  'retains the pending intention and existing recovery budget through %s consent changes',
  async (kind) => {
    const f = fixture(kind),
      flag = kind === 'crashed' ? 'recoverCrashes' : 'recoverInterrupted';
    await f.controller.refresh();
    advance(2000);
    await f.controller.refresh();
    const before = f.controller.getStatus();
    await f.controller.updateConfig({ [flag]: false });
    await f.controller.updateConfig({ [flag]: true });
    expect(f.controller.getStatus()).toMatchObject({
      pending: before.pending,
      nextRetryAt: before.nextRetryAt,
      armedAt: before.armedAt,
      windowStartedAt: before.windowStartedAt,
      attempts: before.attempts,
      failedAttempts: before.failedAttempts,
    });
    advance(1000);
    await f.controller.refresh();
    expect(f.act).not.toHaveBeenCalled();
    advance(1999);
    await f.controller.refresh();
    expect(f.act).not.toHaveBeenCalled();
    advance(1);
    await f.controller.refresh();
    expect(f.act).toHaveBeenCalledOnce();
  }
);
it.each(kinds)('retains an unresolved %s delivery reservation and its budgets without replay', async (kind) => {
  const initial = initialRecoveryState();
  const reserved = {
    ...initial,
    attempts: 2,
    failedAttempts: 1,
    windowStartedAt: NOW - 10000,
    handledEvidence: ['earlier-owned-failure'],
    inFlight: {
      key: 'possibly-delivered',
      action: kind === 'crashed' ? ('restart' as const) : ('continue' as const),
      conversationId: CID,
      startedAt: NOW - 1000,
    },
  };
  const f = fixture(kind, reserved),
    before = f.controller.getStatus(),
    flag = kind === 'crashed' ? 'recoverCrashes' : 'recoverInterrupted';
  await f.controller.updateConfig({ [flag]: false });
  await f.controller.updateConfig({ [flag]: true });
  advance(5000);
  await f.controller.refresh();
  expect(f.controller.getStatus()).toMatchObject({
    inFlight: before.inFlight,
    attempts: 2,
    failedAttempts: 1,
    windowStartedAt: before.windowStartedAt,
    handledEvidence: before.handledEvidence,
  });
  expect(f.act).not.toHaveBeenCalled();
});
it('retains quiet-work attention and its original armed interval through kind-consent changes', async () => {
  const initial = initialRecoveryState();
  const f = fixture('interrupted', {
    armedAt: NOW - 50000,
    config: { ...initial.config, enabled: true, detectStalls: true, stalledAfterMs: 10000 },
  });
  f.observation.activity = 'working';
  f.observation.reason = 'turn-running';
  f.observation.at = NOW - 30000;
  f.observation.progressAt = NOW - 30000;
  f.observation.safeToAct = false;
  await f.controller.refresh();
  const before = f.controller.getStatus();
  expect(before).toMatchObject({ needsAttention: true, lastReason: 'stalled' });
  await f.controller.updateConfig({ recoverInterrupted: false });
  await f.controller.updateConfig({ recoverInterrupted: true });
  expect(f.controller.getStatus()).toMatchObject({
    armedAt: before.armedAt,
    needsAttention: true,
    lastReason: 'stalled',
    attempts: before.attempts,
  });
  expect(f.controller.getStatus().windowStartedAt).toBe(before.windowStartedAt);
  expect(f.act).not.toHaveBeenCalled();
});
