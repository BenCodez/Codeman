/** @fileoverview A scheduled stall delay belongs to the confirmed native worker/progress, never just its turn. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RecoveryController } from '../src/recovery/controller.js';
import {
  initialRecoveryState,
  type RecoveryObservation,
  type RecoveryState,
  type RecoveryFlight,
  type RecoveryActionAuthority,
} from '../src/recovery/types.js';

const NOW = Date.UTC(2026, 9, 15, 17);
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

function fixture(remote: boolean) {
  const state = initialRecoveryState();
  state.config = {
    ...state.config,
    enabled: true,
    detectStalls: true,
    restartStalls: true,
    stalledAfterMs: 10_000,
    retryDelayMs: 10_000,
    maxRetryDelayMs: 10_000,
  };
  state.armedAt = NOW - 60_000;
  const observation: RecoveryObservation = {
    activity: 'working',
    reason: 'turn-running',
    safeToAct: false,
    conversationId: THREAD,
    stallEvidenceKey: 'same-unfinished-turn',
    stallRestartable: true,
    at: NOW - 30_000,
    progressAt: NOW - 30_000,
    processProofKey: 'native-worker-A',
    ...(remote ? { progressEvidenceKey: `remote:${'a'.repeat(64)}`, progressLowerBound: NOW - 30_001 } : {}),
  };
  const act = vi.fn(
    async (_flight: RecoveryFlight, _authority: RecoveryActionAuthority): Promise<'sent' | 'not-sent' | 'unknown'> =>
      'sent'
  );
  const snapshots: RecoveryState[] = [];
  const controller = new RecoveryController(
    {
      observe: async () => ({ ...observation, stallObservedAt: Date.now() }),
      act,
      persist: async (next) => {
        snapshots.push(structuredClone(next));
      },
      changed: () => {},
    },
    state
  );
  controllers.push(controller);
  return { controller, observation, act, snapshots };
}

async function schedule(remote: boolean) {
  const f = fixture(remote);
  await f.controller.refresh();
  vi.setSystemTime(NOW + 2000);
  await f.controller.refresh();
  expect(f.controller.getStatus()).toMatchObject({
    attempts: 0,
    pending: { action: 'restart', reason: 'stalled', key: 'same-unfinished-turn' },
    nextRetryAt: NOW + 12_000,
  });
  return f;
}

it.each(
  [false, true].flatMap((remote) =>
    ['process', 'progress', 'both'].flatMap((change) => [false, true].map((inspect) => ({ remote, change, inspect })))
  )
)(
  'starts a full new delay for changed $change proof within the same turn (SSH=$remote, inspect=$inspect)',
  async ({ remote, change, inspect }) => {
    const f = await schedule(remote),
      before = f.controller.getStatus();
    vi.setSystemTime(NOW + 10_000);
    if (change !== 'progress') f.observation.processProofKey = 'native-worker-B';
    if (change !== 'process') {
      f.observation.progressAt = NOW - 20_000;
      if (remote)
        Object.assign(f.observation, {
          progressEvidenceKey: `remote:${'b'.repeat(64)}`,
          progressLowerBound: NOW - 20_001,
        });
    }
    if (inspect) await f.controller.inspect();
    else await f.controller.refresh();
    expect(f.controller.getStatus().pending).toBeUndefined();
    expect(f.controller.getStatus().nextRetryAt).toBeUndefined();
    expect(f.snapshots.at(-1)?.pending).toBeUndefined();
    for (const field of ['attempts', 'failedAttempts', 'windowStartedAt', 'armedAt', 'handledEvidence'] as const)
      expect(f.controller.getStatus()[field]).toEqual(before[field]);
    // A passive read never supplies the first qualifying confirmation.
    if (inspect) await f.controller.refresh();
    vi.setSystemTime(NOW + 11_999);
    await f.controller.refresh();
    expect(f.controller.getStatus().pending).toBeUndefined();
    vi.setSystemTime(NOW + 12_000);
    await f.controller.refresh();
    expect(f.act).not.toHaveBeenCalled();
    expect(f.controller.getStatus().nextRetryAt).toBe(NOW + 22_000);
    vi.setSystemTime(NOW + 21_999);
    await f.controller.refresh();
    expect(f.act).not.toHaveBeenCalled();
    vi.setSystemTime(NOW + 22_000);
    await f.controller.refresh();
    expect(f.act).toHaveBeenCalledOnce();
    expect(f.act.mock.calls[0]?.[0]).toMatchObject({
      reason: 'stalled',
      startedAt: NOW + 22_000,
      stallProgressAt: f.observation.progressAt,
    });
  }
);

it.each([false, true])(
  'retains the original deadline for identical proof and repeated reads (SSH=%s)',
  async (remote) => {
    const f = await schedule(remote),
      pending = f.controller.getStatus().pending;
    vi.setSystemTime(NOW + 10_000);
    if (remote) {
      // A clock-projection change is not a new native progress event.
      f.observation.progressAt! += 50;
      f.observation.progressLowerBound! += 50;
    }
    await f.controller.inspect();
    await f.controller.refresh();
    expect(f.controller.getStatus().pending).toEqual(pending);
    expect(f.controller.getStatus().nextRetryAt).toBe(NOW + 12_000);
    vi.setSystemTime(NOW + 11_999);
    await f.controller.refresh();
    expect(f.act).not.toHaveBeenCalled();
    vi.setSystemTime(NOW + 12_000);
    await f.controller.refresh();
    expect(f.act).toHaveBeenCalledOnce();
  }
);

it.each([false, true])(
  'does not revive canceled owner intent when the native proof changes (SSH=%s)',
  async (remote) => {
    const f = await schedule(remote);
    f.controller.noteUserInput();
    await f.controller.drain();
    f.observation.processProofKey = 'native-worker-B';
    vi.setSystemTime(NOW + 10_000);
    await f.controller.refresh();
    vi.setSystemTime(NOW + 12_000);
    await f.controller.refresh();
    expect(f.controller.getStatus().pending).toBeUndefined();
    expect(f.act).not.toHaveBeenCalled();
  }
);

it.each([false, true])(
  'keeps uncertain durable delivery sealed across a later proof change (SSH=%s)',
  async (remote) => {
    const f = await schedule(remote);
    f.act.mockResolvedValue('unknown');
    vi.setSystemTime(NOW + 12_000);
    await f.controller.refresh();
    const before = f.controller.getStatus();
    expect(before.inFlight).toBeDefined();
    expect(before.lastReason).toBe('acceptance-unverified');
    f.observation.processProofKey = 'native-worker-B';
    f.observation.progressAt! += 1000;
    if (remote)
      Object.assign(f.observation, {
        progressEvidenceKey: `remote:${'b'.repeat(64)}`,
        progressLowerBound: NOW - 29_001,
      });
    vi.setSystemTime(NOW + 14_000);
    await f.controller.inspect();
    await f.controller.refresh();
    expect(f.controller.getStatus().inFlight).toEqual(before.inFlight);
    expect(f.controller.getStatus().attempts).toBe(before.attempts);
    expect(f.controller.getStatus().failedAttempts).toBe(before.failedAttempts);
    expect(f.controller.getStatus().pending).toBeUndefined();
    expect(f.act).toHaveBeenCalledOnce();
  }
);

it.each(['certified', 'uncertain', 'owner-input', 'newer-warning'] as const)(
  'a pre-effect evidence certificate preserves the %s final boundary',
  async (kind) => {
    const f = await schedule(false);
    await f.controller.updateConfig({ maxRetries: 1 });
    f.act.mockImplementation(async (_flight, authority) => {
      authority.withdrawEvidence?.();
      if (kind === 'owner-input') f.controller.noteUserInput();
      if (kind === 'newer-warning') {
        // An independently established newer authority warning must survive
        // receipt cleanup; the certificate only retires this unsent operation.
        const state = Reflect.get(f.controller, 'state') as RecoveryState;
        state.phase = 'paused';
        state.needsAttention = true;
        state.lastReason = 'approval-required';
      }
      return kind === 'uncertain' ? 'unknown' : 'not-sent';
    });
    vi.setSystemTime(NOW + 12_000);
    await f.controller.refresh();
    const state = f.controller.getStatus();
    expect(state).toMatchObject({
      attempts: kind === 'uncertain' ? 1 : 0,
      failedAttempts: kind === 'uncertain' ? 1 : 0,
      circuitOpen: false,
    });
    expect(!!state.inFlight).toBe(kind === 'uncertain');
    if (kind === 'uncertain') expect(state.lastReason).toBe('acceptance-unverified');
    else {
      expect(state.pending).toBeUndefined();
      expect(state.nextRetryAt).toBeUndefined();
      expect(state.history.some((event) => event.reason === 'delivery-failed')).toBe(false);
    }
    if (kind === 'owner-input') expect(state.armedAt).toBe(NOW + 12_000);
    if (kind === 'newer-warning')
      expect(state).toMatchObject({ phase: 'paused', needsAttention: true, lastReason: 'approval-required' });
  }
);
