/** Deterministic recovery behavior: fake time, observations and persistence; no real panes or CLI. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecoveryController, type RecoveryDependencies } from '../src/recovery/controller.js';
import {
  CONTINUATION_PROMPT,
  initialRecoveryState,
  type RecoveryConfig,
  type RecoveryObservation,
  type RecoveryState,
} from '../src/recovery/types.js';
import { createDeferred } from './mocks/index.js';

const NOW = Date.UTC(2026, 9, 13, 12);
const THREAD = '11111111-2222-3333-4444-555555555555';
const OTHER_THREAD = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PROMPT_HASH = createHash('sha256').update(CONTINUATION_PROMPT).digest('hex');
const controllers: RecoveryController[] = [];
type Outcome = Awaited<ReturnType<RecoveryDependencies['act']>>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
  vi.useRealTimers();
});

function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

function enabledState(patch: Partial<RecoveryState> = {}, config: Partial<RecoveryConfig> = {}): RecoveryState {
  const state = initialRecoveryState();
  return {
    ...state,
    ...patch,
    // Stall-positive fixtures were already armed before their observed quiet interval.
    armedAt: patch.armedAt ?? (config.detectStalls ? NOW - 20_000 : NOW),
    config: { ...state.config, enabled: true, retryDelayMs: 1000, maxRetryDelayMs: 4000, ...config },
  };
}

function failure(key = 'failure-1', patch: Partial<RecoveryObservation> = {}): RecoveryObservation {
  return {
    activity: 'interrupted',
    reason: 'turn-failed',
    at: Date.now(),
    conversationId: THREAD,
    evidenceKey: key,
    submissionKey: 'original-user-message',
    safeToAct: true,
    ...patch,
  };
}

function fixture(restored = initialRecoveryState()) {
  const f = {
    observation: failure(),
    outcome: 'sent' as Outcome,
    journal: [] as RecoveryState[],
    changes: [] as RecoveryState[],
    order: [] as string[],
  };
  const observe = vi.fn(async () => structuredClone(f.observation));
  const persist = vi.fn(async (state: RecoveryState) => {
    f.journal.push(structuredClone(state));
    f.order.push(state.inFlight ? 'reserved' : 'saved');
  });
  const changed = vi.fn((state: RecoveryState) => f.changes.push(structuredClone(state)));
  const act = vi.fn(async (flight: NonNullable<RecoveryState['inFlight']>, _isCurrent: () => boolean) => {
    f.order.push(`act:${flight.action}`);
    return f.outcome;
  });
  const restoreMissingRemote = vi.fn(async () => f.outcome);
  const controller = new RecoveryController(
    { observe, persist, changed, act, restoreMissingRemote, now: () => Date.now() },
    restored
  );
  controllers.push(controller);
  return Object.assign(f, { controller, observe, persist, changed, act, restoreMissingRemote });
}

async function schedule(f: ReturnType<typeof fixture>): Promise<number> {
  await f.controller.refresh();
  advance(2000);
  await f.controller.refresh();
  const next = f.controller.getStatus().nextRetryAt;
  expect(next).toBeDefined();
  return next!;
}

function acceptedSubmission(patch: Partial<RecoveryObservation> = {}): RecoveryObservation {
  return {
    activity: 'working',
    reason: 'turn-running',
    at: Date.now(),
    processReadyAt: Date.now(),
    conversationId: THREAD,
    safeToAct: false,
    submissionKey: 'new-continuation-user-message',
    submissionHash: PROMPT_HASH,
    ...patch,
  };
}

function stalled(key = 'stall-turn-1', restartable = false): RecoveryObservation {
  return {
    activity: 'working',
    reason: 'turn-running',
    at: NOW - 20_000,
    progressAt: NOW - 20_000,
    conversationId: THREAD,
    stallEvidenceKey: key,
    stallRestartable: restartable || undefined,
    safeToAct: false,
  };
}

describe('recovery action authority', () => {
  it('durably reserves an explicit missing-remote restore and never duplicates an in-flight action', async () => {
    const f = fixture();
    f.observation = {
      activity: 'unknown',
      reason: 'remote-session-missing',
      at: NOW - 1000,
      conversationId: THREAD,
      safeToAct: false,
    };
    const first = await f.controller.restoreMissingRemote();
    expect(f.journal[0].inFlight).toMatchObject({ action: 'restart', conversationId: THREAD });
    expect(f.restoreMissingRemote).toHaveBeenCalledOnce();
    expect(first.inFlight).toBeDefined();
    await f.controller.restoreMissingRemote();
    expect(f.restoreMissingRemote).toHaveBeenCalledOnce();
    const restored = fixture(f.journal.at(-1)!);
    await restored.controller.restoreMissingRemote();
    expect(restored.restoreMissingRemote).not.toHaveBeenCalled();
    expect(restored.controller.getStatus()).toMatchObject({ lastReason: 'restart-in-flight', needsAttention: true });
  });

  it('polls bounded acceptance for an explicit remote restore while automation stays disabled', async () => {
    const f = fixture();
    f.observation = {
      activity: 'unknown',
      reason: 'remote-session-missing',
      at: NOW - 1000,
      conversationId: THREAD,
      safeToAct: false,
    };
    await f.controller.restoreMissingRemote();
    expect(f.controller.getStatus()).toMatchObject({ config: { enabled: false }, phase: 'recovering' });
    f.observation = {
      activity: 'completed',
      reason: 'turn-completed',
      at: NOW,
      conversationId: THREAD,
      processReady: true,
      processReadyAt: Date.now(),
      safeToAct: false,
    };
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.controller.getStatus()).toMatchObject({
      config: { enabled: false },
      phase: 'watching',
      lastReason: 'recovery-accepted',
      inFlight: undefined,
    });
    const observations = f.observe.mock.calls.length;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(f.observe).toHaveBeenCalledTimes(observations);
  });

  it('observes acceptance for a second explicit restore after the prior restore was accepted', async () => {
    const f = fixture();
    const missing = (at: number): RecoveryObservation => ({
      activity: 'unknown',
      reason: 'remote-session-missing',
      at,
      conversationId: THREAD,
      safeToAct: false,
    });
    f.observation = missing(NOW - 1000);
    await f.controller.restoreMissingRemote();
    f.observation = {
      activity: 'completed',
      reason: 'turn-completed',
      at: NOW,
      conversationId: THREAD,
      processReady: true,
      processReadyAt: Date.now(),
      safeToAct: false,
    };
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.controller.getStatus().inFlight).toBeUndefined();

    f.observation = missing(Date.now());
    await f.controller.restoreMissingRemote();
    expect(f.controller.getStatus().inFlight).toBeDefined();
    f.observation = {
      activity: 'idle',
      reason: 'turn-completed',
      at: Date.now(),
      conversationId: THREAD,
      processReady: true,
      processReadyAt: Date.now(),
      safeToAct: false,
    };
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.controller.getStatus()).toMatchObject({
      inFlight: undefined,
      lastReason: 'recovery-accepted',
      phase: 'watching',
    });
    expect(f.restoreMissingRemote).toHaveBeenCalledTimes(2);
  });

  it('bounds a restore after an accepted manual retry instead of leaving it unobserved', async () => {
    const f = fixture();
    await f.controller.retry();
    f.observation = acceptedSubmission();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.controller.getStatus().inFlight).toBeUndefined();

    f.observation = {
      activity: 'unknown',
      reason: 'remote-session-missing',
      at: Date.now(),
      conversationId: THREAD,
      safeToAct: false,
    };
    await f.controller.restoreMissingRemote();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.controller.getStatus()).toMatchObject({
      lastReason: 'acceptance-unverified',
      phase: 'paused',
    });
    expect(f.controller.getStatus().inFlight).toBeDefined();
    const observations = f.observe.mock.calls.length;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(f.observe).toHaveBeenCalledTimes(observations);
  });

  it('requires new repeated confirmation when native incarnation changes under the same evidence key', async () => {
    const f = fixture(enabledState());
    f.observation = failure('same-cached-exit', { processProofKey: 'native-incarnation-1' });
    await f.controller.refresh();
    advance(2000);
    f.observation = failure('same-cached-exit', { processProofKey: 'native-incarnation-2' });
    await f.controller.refresh();
    expect(f.controller.getStatus().pending).toBeUndefined();
    advance(1999);
    await f.controller.refresh();
    expect(f.controller.getStatus().pending).toBeUndefined();
    expect(f.act).not.toHaveBeenCalled();
    advance(1);
    await f.controller.refresh();
    expect(f.controller.getStatus().pending).toMatchObject({ key: 'same-cached-exit' });
    advance(1000);
    await f.controller.refresh();
    expect(f.act).toHaveBeenCalledOnce();
  });

  it('is disabled by default and does not poll or act without opt-in', async () => {
    const f = fixture();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(f.observe).not.toHaveBeenCalled();
    await f.controller.refresh();
    expect(f.controller.getStatus().config.enabled).toBe(false);
    expect(f.act).not.toHaveBeenCalled();
  });

  it.each(['working', 'watching', 'completed', 'idle'] as const)(
    'never acts on %s, including manual Retry',
    async (activity) => {
      const f = fixture(enabledState());
      f.observation = failure('unchanged', { activity });
      await f.controller.refresh();
      await f.controller.retry();
      expect(f.act).not.toHaveBeenCalled();
      expect(f.controller.getStatus().inFlight).toBeUndefined();
    }
  );

  it('does not replay an old failure when recovery is enabled later', async () => {
    const f = fixture();
    f.observation = failure('historical', { at: NOW - 1 });
    await f.controller.updateConfig({ enabled: true, retryDelayMs: 1000 });
    await f.controller.refresh();
    advance(30_000);
    await f.controller.refresh();
    expect(f.act).not.toHaveBeenCalled();
    expect(f.controller.getStatus().pending).toBeUndefined();
  });

  it('requires confirmation and the configured delay before automatic action', async () => {
    const f = fixture(enabledState());
    await f.controller.refresh();
    advance(1999);
    await f.controller.refresh();
    expect(f.controller.getStatus().pending).toBeUndefined();
    advance(1);
    await f.controller.refresh();
    expect(f.controller.getStatus().nextRetryAt).toBe(NOW + 3000);
    advance(999);
    await f.controller.refresh();
    expect(f.act).not.toHaveBeenCalled();
    advance(1);
    await f.controller.refresh();
    expect(f.act).toHaveBeenCalledTimes(1);
    expect(f.act.mock.calls[0]?.[0].action).toBe('continue');
  });

  it('restarts confirmation when the failure identity changes', async () => {
    const f = fixture(enabledState());
    await f.controller.refresh();
    advance(2000);
    f.observation = failure('different-failure');
    await f.controller.refresh();
    expect(f.controller.getStatus().pending).toBeUndefined();
    advance(2000);
    await f.controller.refresh();
    expect(f.controller.getStatus().pending?.key).toBe('different-failure');
  });

  it.each([
    ['blocked', 'authentication-required'],
    ['blocked', 'usage-limit'],
    ['paused', 'approval-required'],
    ['paused', 'user-interrupted'],
    ['unknown', 'identity-unverified'],
    ['unknown', 'unowned-session'],
    ['unknown', 'managed-daemon'],
    ['unknown', 'unsupported-location'],
    ['unknown', 'pane-unverified'],
    ['working', 'internal-retry'],
    ['watching', 'background-work'],
    ['exited', 'clean-exit'],
  ] as const)('withholds actions for %s / %s', async (activity, reason) => {
    const f = fixture(enabledState());
    f.observation = failure('blocked-failure', { activity, reason, safeToAct: false });
    await f.controller.retry();
    advance(60_000);
    await f.controller.refresh();
    expect(f.act).not.toHaveBeenCalled();
  });

  it.each([
    ['classifier uncertainty', 'unknown', 'identity-unverified', 'working', 'turn-running'],
    ['user veto', 'paused', 'user-interrupted', 'idle', 'turn-completed'],
    ['resolved approval', 'paused', 'approval-required', 'working', 'turn-running'],
    ['resolved provider block', 'blocked', 'usage-limit', 'watching', 'background-work'],
  ] as const)(
    'clears attention after %s resolves to normal activity and publishes the persisted state',
    async (_label, blockedActivity, blockedReason, resolvedActivity, resolvedReason) => {
      const f = fixture(enabledState());
      f.observation = failure('temporary-veto', {
        activity: blockedActivity,
        reason: blockedReason,
        safeToAct: false,
      });
      await f.controller.refresh();
      expect(f.controller.getStatus()).toMatchObject({ phase: 'paused', needsAttention: true });

      const changesBeforeResolution = f.changes.length;
      f.observation = failure('resolved-veto', {
        activity: resolvedActivity,
        reason: resolvedReason,
        safeToAct: false,
      });
      await f.controller.refresh();

      expect(f.controller.getStatus()).toMatchObject({ phase: 'watching', needsAttention: false });
      expect(f.journal.at(-1)).toMatchObject({
        activity: resolvedActivity,
        lastReason: resolvedReason,
        needsAttention: false,
      });
      expect(f.changes.length).toBeGreaterThan(changesBeforeResolution);
      expect(f.changes.at(-1)).toMatchObject({ needsAttention: false });
      expect(f.act).not.toHaveBeenCalled();
    }
  );

  it.each(['interrupted', 'crashed'] as const)(
    'keeps attention sticky while an unresolved %s failure is still observed',
    async (activity) => {
      const f = fixture(enabledState({ phase: 'paused', needsAttention: true, lastReason: 'identity-unverified' }));
      f.observation = failure('unresolved-failure', {
        activity,
        reason: activity === 'crashed' ? 'process-crashed' : 'turn-failed',
        safeToAct: false,
      });
      await f.controller.refresh();
      expect(f.controller.getStatus().needsAttention).toBe(true);
      expect(f.journal.at(-1)?.needsAttention).toBe(true);
      expect(f.changes.at(-1)?.needsAttention).toBe(true);
      expect(f.act).not.toHaveBeenCalled();
    }
  );

  it('does not treat a classified failure as authority without safeToAct', async () => {
    const f = fixture(enabledState());
    f.observation = failure('unsafe', { safeToAct: false });
    await f.controller.retry();
    expect(f.act).not.toHaveBeenCalled();
  });

  it.each(['interrupted', 'crashed'] as const)('respects the disabled %s recovery option', async (activity) => {
    const f = fixture(
      enabledState({}, activity === 'crashed' ? { recoverCrashes: false } : { recoverInterrupted: false })
    );
    f.observation = failure('disabled-kind', { activity });
    await f.controller.retry();
    expect(f.act).not.toHaveBeenCalled();
  });

  it('fails closed when observation itself fails', async () => {
    const f = fixture(enabledState());
    f.observe.mockRejectedValueOnce(new Error('Unavailable observation'));
    await f.controller.retry();
    expect(f.controller.getStatus().lastReason).toBe('identity-unverified');
    expect(f.act).not.toHaveBeenCalled();
  });

  it('restarts a confirmed abnormal dead pane only after repeated same-turn probes and delay', async () => {
    const f = fixture(enabledState({}, { detectStalls: true, restartStalls: true, stalledAfterMs: 10_000 }));
    f.observation = stalled('stall-turn', true);
    await f.controller.refresh();
    advance(1999);
    await f.controller.refresh();
    expect(f.controller.getStatus().pending).toBeUndefined();
    advance(1);
    await f.controller.refresh();
    expect(f.controller.getStatus().pending).toMatchObject({
      key: 'stall-turn',
      action: 'restart',
      reason: 'stalled',
    });
    expect(f.controller.getStatus().history.slice(-2)).toMatchObject([
      { kind: 'state', reason: 'stalled' },
      { kind: 'scheduled', reason: 'scheduled' },
    ]);
    advance(1000);
    await f.controller.refresh();
    expect(f.act).toHaveBeenCalledTimes(1);
    expect(f.act.mock.calls[0]?.[0]).toMatchObject({ action: 'restart', reason: 'stalled' });
  });

  it.each(['automation', 'stall-policy', 'stall-restart'] as const)(
    'starts a durable fresh quiet interval when enabling %s despite historical silence',
    async (optIn) => {
      for (const dead of [false, true]) {
        const state = initialRecoveryState();
        state.config = {
          ...state.config,
          enabled: optIn !== 'automation',
          detectStalls: optIn !== 'stall-policy',
          restartStalls: optIn !== 'stall-restart',
          stalledAfterMs: 10_000,
          retryDelayMs: 1000,
        };
        state.armedAt = NOW - 60_000;
        const f = fixture(state);
        f.observation = stalled(`new-opt-in-${optIn}-${dead}`, dead);
        await f.controller.updateConfig(
          optIn === 'automation'
            ? { enabled: true }
            : optIn === 'stall-policy'
              ? { detectStalls: true }
              : { restartStalls: true }
        );
        expect(f.controller.getStatus().armedAt).toBe(NOW);
        for (const offset of [0, 2000, 9999]) {
          vi.setSystemTime(NOW + offset);
          await f.controller.refresh();
          expect(f.controller.getStatus().needsAttention).toBe(false);
          expect(f.controller.getStatus().pending).toBeUndefined();
          expect(f.act).not.toHaveBeenCalled();
        }
        const saved = f.journal.at(-1)!;
        f.controller.stop();
        const restored = fixture(saved);
        restored.observation = structuredClone(f.observation);
        vi.setSystemTime(NOW + 10_000);
        await restored.controller.refresh();
        advance(1999);
        await restored.controller.refresh();
        expect(restored.controller.getStatus().needsAttention).toBe(false);
        expect(restored.controller.getStatus().pending).toBeUndefined();
        advance(1);
        await restored.controller.refresh();
        if (dead) {
          expect(restored.controller.getStatus().pending).toMatchObject({ action: 'restart', reason: 'stalled' });
          expect(restored.act).not.toHaveBeenCalled();
          advance(1000);
          await restored.controller.refresh();
          expect(restored.act).toHaveBeenCalledOnce();
        } else {
          expect(restored.controller.getStatus()).toMatchObject({
            needsAttention: true,
            lastReason: 'stall-unverified',
          });
          expect(restored.act).not.toHaveBeenCalled();
        }
        vi.setSystemTime(NOW);
      }
    }
  );

  it('requests attention for repeated live-turn silence and never acts, even on manual Retry', async () => {
    const f = fixture(enabledState({}, { detectStalls: true, restartStalls: true, stalledAfterMs: 10_000 }));
    f.observation = stalled('silent-live-turn');
    await f.controller.refresh();
    advance(2000);
    await f.controller.refresh();
    expect(f.controller.getStatus()).toMatchObject({
      activity: 'working',
      needsAttention: true,
      lastReason: 'stall-unverified',
    });
    expect(f.controller.getStatus().history.at(-1)).toMatchObject({
      kind: 'attention',
      reason: 'stall-unverified',
    });
    const attentionEvents = f.controller.getStatus().history.filter((event) => event.kind === 'attention').length;
    for (let i = 0; i < 6; i++) {
      advance(5000);
      await f.controller.inspect();
      expect(f.controller.getStatus()).toMatchObject({ needsAttention: true, lastReason: 'stall-unverified' });
      await f.controller.refresh();
      expect(f.controller.getStatus()).toMatchObject({
        phase: 'paused',
        needsAttention: true,
        lastReason: 'stall-unverified',
      });
    }
    expect(f.controller.getStatus().history.filter((event) => event.kind === 'attention')).toHaveLength(
      attentionEvents
    );
    await f.controller.retry();
    expect(f.act).not.toHaveBeenCalled();
    expect(f.controller.getStatus().inFlight).toBeUndefined();
  });

  it('permits two guarded manual probes of a dead-pane stall with automation off', async () => {
    const state = initialRecoveryState();
    state.config.detectStalls = true;
    state.config.restartStalls = true;
    state.config.stalledAfterMs = 10_000;
    const f = fixture(state);
    f.observation = stalled('manual-dead-pane', true);
    await f.controller.retry();
    expect(f.act).not.toHaveBeenCalled();
    advance(2000);
    await f.controller.retry();
    expect(f.act).toHaveBeenCalledTimes(1);
    expect(f.act.mock.calls[0]?.[0]).toMatchObject({ action: 'restart', reason: 'stalled' });
    expect(f.controller.getStatus().config.enabled).toBe(false);
  });

  it.each([true, false])(
    'requires two fresh dead probes after a live silence alert (automatic: %s)',
    async (enabled) => {
      const f = fixture(enabledState({}, { enabled, detectStalls: true, restartStalls: true, stalledAfterMs: 10_000 }));
      f.observation = stalled('live-then-dead');
      await f.controller.retry();
      advance(2000);
      await f.controller.retry();
      expect(f.controller.getStatus().lastReason).toBe('stall-unverified');

      advance(1);
      f.observation = stalled('live-then-dead', true);
      await f.controller.retry();
      expect(f.act).not.toHaveBeenCalled();
      expect(f.controller.getStatus().pending).toBeUndefined();
      advance(1999);
      await f.controller.retry();
      expect(f.act).not.toHaveBeenCalled();
      advance(1);
      await f.controller.retry();
      expect(f.act).toHaveBeenCalledTimes(1);
      expect(f.act.mock.calls[0]?.[0]).toMatchObject({ key: 'live-then-dead', action: 'restart', reason: 'stalled' });
    }
  );

  it.each(['live pane', 'progress'] as const)(
    'invalidates dead proof when status inspection observes %s',
    async (change) => {
      const f = fixture(enabledState({}, { detectStalls: true, restartStalls: true, stalledAfterMs: 10_000 }));
      f.observation = stalled('intervening-healthy-read', true);
      await f.controller.retry();
      advance(2000);
      f.observation = {
        ...stalled('intervening-healthy-read', change === 'progress'),
        ...(change === 'progress' ? { progressAt: NOW - 15_000 } : {}),
      };
      await f.controller.inspect();
      f.observation.stallRestartable = true;
      await f.controller.retry();
      expect(f.act).not.toHaveBeenCalled();
      advance(1999);
      await f.controller.retry();
      expect(f.act).not.toHaveBeenCalled();
      advance(1);
      await f.controller.retry();
      expect(f.act).toHaveBeenCalledTimes(1);
    }
  );

  it('keeps a restored stall warning separate from fresh restart confirmation', async () => {
    const f = fixture(enabledState({}, { detectStalls: true, restartStalls: true, stalledAfterMs: 10_000 }));
    f.observation = stalled('restored-warning');
    await f.controller.retry();
    advance(2000);
    await f.controller.retry();
    f.controller.stop();
    const restored = fixture(f.journal.at(-1)!);
    restored.observation = stalled('restored-warning', true);
    await restored.controller.inspect();
    await restored.controller.retry();
    expect(restored.act).not.toHaveBeenCalled();
    advance(1999);
    await restored.controller.retry();
    expect(restored.act).not.toHaveBeenCalled();
    advance(1);
    await restored.controller.retry();
    expect(restored.act).toHaveBeenCalledTimes(1);
  });

  it.each(['stalled', 'stall-unverified'] as const)(
    'preserves legacy v1 %s warnings without treating their alert time as dead proof',
    async (legacyReason) => {
      const f = fixture(
        enabledState(
          {
            conversationId: THREAD,
            phase: 'paused',
            lastReason: legacyReason,
            needsAttention: true,
            history: [{ at: NOW, kind: 'attention', reason: legacyReason, attempt: 0 }],
          },
          { detectStalls: true, restartStalls: true, stalledAfterMs: 10_000 }
        )
      );
      f.observation = stalled('legacy-warning');
      await f.controller.inspect();
      advance(5000);
      await f.controller.refresh();
      expect(f.controller.getStatus()).toMatchObject({
        needsAttention: true,
        lastReason: 'stall-unverified',
        stallAlert: { key: 'legacy-warning', conversationId: THREAD, progressAt: NOW - 20_000 },
      });
      expect(f.controller.getStatus().history.filter((event) => event.kind === 'attention')).toHaveLength(1);
      f.observation.stallRestartable = true;
      await f.controller.retry();
      expect(f.act).not.toHaveBeenCalled();
      advance(1999);
      await f.controller.retry();
      expect(f.act).not.toHaveBeenCalled();
      advance(1);
      await f.controller.retry();
      expect(f.act).toHaveBeenCalledOnce();
    }
  );

  it('recovers successive independently confirmed deaths in one turn without resetting the durable retry budget', async () => {
    let f = fixture(
      enabledState({}, { detectStalls: true, restartStalls: true, stalledAfterMs: 10_000, maxRetries: 2 })
    );
    const firstProgress = NOW - 20_000;
    f.observation = stalled('same-unfinished-turn', true);
    await f.controller.retry();
    advance(2000);
    await f.controller.retry();
    expect(f.act).toHaveBeenCalledOnce();
    expect(f.controller.getStatus().inFlight).toMatchObject({
      key: 'same-unfinished-turn',
      stallProgressAt: firstProgress,
    });
    f.observation = { ...stalled('same-unfinished-turn'), processReady: true, processReadyAt: Date.now() };
    await f.controller.inspect();
    expect(f.controller.getStatus().handledEvidence[0]).toMatch(/^stall:[a-f0-9]{64}:/);
    const accepted = f.controller.getStatus();
    f.controller.stop();
    f = fixture(accepted);
    // Time passing and a repeated old proof cannot create another recovery cycle.
    advance(20_000);
    f.observation = stalled('same-unfinished-turn', true);
    await f.controller.retry();
    advance(2000);
    await f.controller.retry();
    expect(f.act).not.toHaveBeenCalled();
    // Actual structured progress after acceptance gives the same turn a new baseline.
    const secondProgress = Date.now();
    f.observation = { ...stalled('same-unfinished-turn', true), progressAt: secondProgress };
    await f.controller.retry();
    advance(9999);
    await f.controller.retry();
    expect(f.act).not.toHaveBeenCalled();
    advance(1);
    await f.controller.retry();
    advance(1999);
    await f.controller.retry();
    expect(f.act).not.toHaveBeenCalled();
    advance(1);
    await f.controller.retry();
    expect(f.act).toHaveBeenCalledOnce();
    expect(f.controller.getStatus()).toMatchObject({
      attempts: 2,
      inFlight: { key: 'same-unfinished-turn', stallProgressAt: secondProgress },
    });
    f.observation = { ...f.observation, stallRestartable: undefined, processReady: true, processReadyAt: Date.now() };
    await f.controller.inspect();
    advance(1);
    const thirdProgress = Date.now();
    f.observation = { ...f.observation, processReady: undefined, stallRestartable: true, progressAt: thirdProgress };
    advance(10_000);
    await f.controller.retry();
    advance(2000);
    await f.controller.retry();
    expect(f.controller.getStatus()).toMatchObject({ circuitOpen: true, lastReason: 'retries-exhausted', attempts: 2 });
    expect(f.act).toHaveBeenCalledOnce();
  });

  it.each([undefined, NaN, Infinity, -1, 0, Number.MAX_SAFE_INTEGER + 1, NOW + 1])(
    'never authorizes a stall restart from invalid structured progress %s',
    async (progressAt) => {
      const f = fixture(enabledState({}, { detectStalls: true, restartStalls: true, stalledAfterMs: 10_000 }));
      f.observation = { ...stalled('bad-progress', true), progressAt };
      await f.controller.retry();
      advance(2000);
      await f.controller.retry();
      expect(f.act).not.toHaveBeenCalled();
    }
  );

  it.each([NaN, Infinity, -1, 0, Number.MAX_SAFE_INTEGER + 1, NOW + 10_000])(
    'rejects inconsistent activity timestamps %s without consuming a stall attempt',
    async (at) => {
      const f = fixture(enabledState({}, { detectStalls: true, restartStalls: true, stalledAfterMs: 10_000 }));
      f.observation = { ...stalled('bad-at', true), at };
      await f.controller.retry();
      advance(2000);
      await f.controller.retry();
      expect(f.act).not.toHaveBeenCalled();
      expect(f.controller.getStatus().attempts).toBe(0);
    }
  );

  it('retains legacy handled turn and unknown-delivery vetoes despite new structured progress', async () => {
    for (const restored of [
      enabledState(
        { handledEvidence: ['legacy-stall'] },
        { detectStalls: true, restartStalls: true, stalledAfterMs: 10_000 }
      ),
      enabledState(
        {
          handledEvidence: [`stall:${createHash('sha256').update('legacy-stall').digest('hex')}:malformed`],
          lastSuccessfulRecovery: NOW - 20_000,
        },
        { detectStalls: true, restartStalls: true, stalledAfterMs: 10_000 }
      ),
      enabledState(
        {
          inFlight: {
            key: 'legacy-stall',
            action: 'restart',
            conversationId: THREAD,
            startedAt: NOW - 1000,
            reason: 'stalled',
            stallProgressAt: NOW - 20_000,
          },
        },
        { detectStalls: true, restartStalls: true, stalledAfterMs: 10_000 }
      ),
    ]) {
      const f = fixture(restored);
      f.observation = { ...stalled('legacy-stall', true), progressAt: NOW - 11_000 };
      await f.controller.retry();
      advance(2000);
      await f.controller.retry();
      expect(f.act).not.toHaveBeenCalled();
    }
  });

  it('retains a stall warning through inconclusive evidence and clears it on owner input', async () => {
    const f = fixture(enabledState({}, { detectStalls: true, restartStalls: true, stalledAfterMs: 10_000 }));
    f.observation = stalled('warning-owner-cancel');
    await f.controller.retry();
    advance(2000);
    await f.controller.retry();
    f.observation = { activity: 'unknown', reason: 'identity-unverified', at: Date.now(), safeToAct: false };
    await f.controller.inspect();
    await f.controller.refresh();
    expect(f.controller.getStatus()).toMatchObject({ needsAttention: true, lastReason: 'identity-unverified' });
    expect(f.controller.getStatus().stallAlert).toBeDefined();
    f.controller.noteUserInput();
    await f.controller.drain();
    expect(f.journal.at(-1)).toMatchObject({ needsAttention: false, lastReason: 'user-input', stallAlert: undefined });
    expect(f.act).not.toHaveBeenCalled();
  });

  it.each(['inspect', 'refresh'] as const)(
    'clears accepted stall restart attention through %s and requires a full fresh quiet interval before warning again',
    async (acceptanceRead) => {
      const f = fixture(enabledState({}, { detectStalls: true, restartStalls: true, stalledAfterMs: 10_000 }));
      f.observation = stalled('accepted-stall-warning');
      await f.controller.retry();
      advance(2000);
      await f.controller.retry();
      const originalAlerts = f.controller.getStatus().history.filter((event) => event.kind === 'attention').length;
      expect(f.controller.getStatus().stallAlert).toBeDefined();
      f.observation.stallRestartable = true;
      await f.controller.retry();
      advance(2000);
      await f.controller.retry();
      expect(f.act).toHaveBeenCalledOnce();
      expect(f.controller.getStatus().inFlight).toBeDefined();
      f.observation = { ...stalled('accepted-stall-warning'), processReady: true, processReadyAt: Date.now() };
      await f.controller[acceptanceRead]();
      const acceptedAt = Date.now();
      expect(f.controller.getStatus()).toMatchObject({
        needsAttention: false,
        phase: 'watching',
        lastSuccessfulRecovery: acceptedAt,
      });
      expect(f.controller.getStatus().stallAlert).toBeUndefined();
      expect(f.controller.getStatus().inFlight).toBeUndefined();
      f.controller.stop();
      const restarted = fixture(f.journal.at(-1)!);
      restarted.observation = structuredClone(f.observation);
      for (const offset of [1, 2001, 9999]) {
        vi.setSystemTime(acceptedAt + offset);
        await restarted.controller.inspect();
        await restarted.controller.refresh();
        expect(restarted.controller.getStatus()).toMatchObject({ needsAttention: false, phase: 'watching' });
        expect(restarted.controller.getStatus().stallAlert).toBeUndefined();
        expect(restarted.controller.getStatus().history.filter((event) => event.kind === 'attention')).toHaveLength(
          originalAlerts
        );
      }
      vi.setSystemTime(acceptedAt + 10_000);
      await restarted.controller.refresh();
      expect(restarted.controller.getStatus().needsAttention).toBe(false);
      advance(1999);
      await restarted.controller.refresh();
      expect(restarted.controller.getStatus().needsAttention).toBe(false);
      advance(1);
      await restarted.controller.refresh();
      expect(restarted.controller.getStatus()).toMatchObject({
        needsAttention: true,
        lastReason: 'stall-unverified',
        stallAlert: { key: 'accepted-stall-warning', conversationId: THREAD, progressAt: acceptedAt },
      });
      expect(restarted.controller.getStatus().history.filter((event) => event.kind === 'attention')).toHaveLength(
        originalAlerts + 1
      );
      expect(restarted.act).not.toHaveBeenCalled();
    }
  );

  it('retains the warning produced by an actual parent inspect without duplicate attention or automatic action', async () => {
    // Generated by the preceding layer's real inspect() with sanitized fake observation/time.
    // It overwrites lastReason without appending history or releasing needsAttention.
    const parent = JSON.parse(
      readFileSync(new URL('./fixtures/codex-parent-stall-inspected.json', import.meta.url), 'utf8')
    ) as RecoveryState;
    expect(parent).toMatchObject({ lastReason: 'turn-running', needsAttention: true });
    expect(parent.history).toEqual([{ at: NOW - 1, kind: 'attention', reason: 'stalled', attempt: 0 }]);
    const f = fixture(parent);
    f.observation = stalled('parent-inspected-warning');
    await f.controller.inspect();
    expect(f.controller.getStatus()).toMatchObject({
      needsAttention: true,
      phase: 'paused',
      lastReason: 'stall-unverified',
    });
    for (let i = 0; i < 4; i++) {
      advance(5000);
      await f.controller.refresh();
      await f.controller.inspect();
    }
    expect(f.controller.getStatus().history.filter((event) => event.kind === 'attention')).toHaveLength(1);
    expect(f.act).not.toHaveBeenCalled();
    const migrated = f.controller.getStatus();
    f.controller.stop();
    const restarted = fixture(migrated);
    restarted.observation = stalled('parent-inspected-warning');
    await restarted.controller.inspect();
    await restarted.controller.refresh();
    expect(restarted.controller.getStatus().needsAttention).toBe(true);
    expect(restarted.controller.getStatus().history.filter((event) => event.kind === 'attention')).toHaveLength(1);
    expect(restarted.act).not.toHaveBeenCalled();
  });

  it.each(['turn-running', 'background-work', 'identity-unverified', 'approval-required'] as const)(
    'derives parent warning identity from unresolved history after passive summary %s',
    async (lastReason) => {
      const parent = JSON.parse(
        readFileSync(new URL('./fixtures/codex-parent-stall-inspected.json', import.meta.url), 'utf8')
      ) as RecoveryState;
      parent.lastReason = lastReason;
      const f = fixture(parent);
      f.observation = stalled('history-owned-warning');
      await f.controller.inspect();
      await f.controller.refresh();
      expect(f.controller.getStatus()).toMatchObject({
        needsAttention: true,
        lastReason: 'stall-unverified',
        stallAlert: { key: 'history-owned-warning' },
      });
      expect(f.controller.getStatus().history.filter((event) => event.kind === 'attention')).toHaveLength(1);
      expect(f.act).not.toHaveBeenCalled();
    }
  );

  it('retains historical silence attention while fresh child-work evidence vetoes action and owns reporting', async () => {
    const parent = JSON.parse(
      readFileSync(new URL('./fixtures/codex-parent-stall-inspected.json', import.meta.url), 'utf8')
    ) as RecoveryState;
    const f = fixture(parent);
    f.observation = { ...stalled('child-work-veto'), activity: 'watching', reason: 'background-work' };
    await f.controller.inspect();
    await f.controller.refresh();
    expect(f.controller.getStatus()).toMatchObject({ needsAttention: true, lastReason: 'background-work' });
    expect(f.controller.getStatus().history.filter((event) => event.kind === 'attention')).toHaveLength(1);
    expect(f.act).not.toHaveBeenCalled();
    f.observation = stalled('child-work-veto');
    await f.controller.inspect();
    expect(f.controller.getStatus()).toMatchObject({
      needsAttention: true,
      lastReason: 'stall-unverified',
      stallAlert: { key: 'child-work-veto' },
    });
    expect(f.controller.getStatus().history.filter((event) => event.kind === 'attention')).toHaveLength(1);
  });

  it.each(['identity-unverified', 'approval-required', 'authentication-required', 'usage-limit'] as const)(
    'keeps current %s attention above migrated parent stall identity',
    async (lastReason) => {
      const f = fixture(
        enabledState(
          {
            conversationId: THREAD,
            phase: 'paused',
            needsAttention: true,
            lastReason,
            history: [{ at: NOW - 1, kind: 'attention', reason: 'stalled', attempt: 0 }],
          },
          { detectStalls: true }
        )
      );
      f.observation = {
        activity: lastReason === 'identity-unverified' ? 'unknown' : 'blocked',
        reason: lastReason,
        at: NOW,
        conversationId: THREAD,
        safeToAct: false,
      };
      await f.controller.inspect();
      await f.controller.refresh();
      expect(f.controller.getStatus()).toMatchObject({ needsAttention: true, lastReason });
      expect(f.controller.getStatus().stallAlert).toBeUndefined();
      expect(f.act).not.toHaveBeenCalled();
    }
  );

  it.each(['observing', 'disabled'] as const)(
    'migrates the latest unresolved parent stall attention after settings changed lastReason to %s',
    async (lastReason) => {
      const f = fixture(
        enabledState(
          {
            conversationId: THREAD,
            phase: lastReason === 'disabled' ? 'idle' : 'paused',
            needsAttention: true,
            lastReason,
            history: [
              { at: NOW - 1, kind: 'attention', reason: 'stalled', attempt: 0 },
              { at: NOW, kind: 'state', reason: lastReason, attempt: 0 },
            ],
          },
          { enabled: lastReason !== 'disabled', detectStalls: true, restartStalls: true, stalledAfterMs: 10_000 }
        )
      );
      f.observation = stalled('settings-parent-warning');
      await f.controller.inspect();
      await f.controller.refresh();
      expect(f.controller.getStatus()).toMatchObject({ needsAttention: true, lastReason: 'stall-unverified' });
      expect(f.controller.getStatus().stallAlert).toBeDefined();
      expect(f.controller.getStatus().history.filter((event) => event.kind === 'attention')).toHaveLength(1);
      f.observation.progressAt = NOW + 1;
      advance(1);
      await f.controller.inspect();
      expect(f.controller.getStatus().needsAttention).toBe(false);
      expect(f.controller.getStatus().stallAlert).toBeUndefined();
      expect(f.act).not.toHaveBeenCalled();
    }
  );

  it.each(['sent', 'unknown', 'not-sent'] as const)(
    'does not grant a new quiet baseline or lose warning ownership for an unaccepted %s restart',
    async (outcome) => {
      const f = fixture(enabledState({}, { detectStalls: true, restartStalls: true, stalledAfterMs: 10_000 }));
      f.observation = stalled('unaccepted-stall-warning');
      await f.controller.retry();
      advance(2000);
      await f.controller.retry();
      f.observation.stallRestartable = true;
      await f.controller.retry();
      advance(2000);
      f.outcome = outcome;
      await f.controller.retry();
      expect(f.act).toHaveBeenCalledOnce();
      await f.controller.updateConfig({ enabled: false });
      f.observation = { ...stalled('unaccepted-stall-warning'), processReady: false };
      await f.controller.inspect();
      await f.controller.refresh();
      expect(f.controller.getStatus().lastSuccessfulRecovery).toBeUndefined();
      if (outcome === 'sent') {
        // Sending starts acceptance observation; it has not resolved the warning.
        expect(f.controller.getStatus().stallAlert).toBeDefined();
        advance(60_000);
        await f.controller.inspect();
        expect(f.controller.getStatus().lastReason).toBe('acceptance-unverified');
      } else expect(f.controller.getStatus().stallAlert).toBeUndefined();
      expect(f.controller.getStatus().needsAttention).toBe(true);
      expect(f.controller.getStatus().lastSuccessfulRecovery).toBeUndefined();
      expect(!!f.controller.getStatus().inFlight).toBe(outcome !== 'not-sent');
      expect(f.act).toHaveBeenCalledOnce();
    }
  );

  it.each(['newer-attention', 'accepted', 'reset', 'user-input'] as const)(
    'does not restore parent stall ownership after a newer %s event',
    async (replacement) => {
      const newer =
        replacement === 'newer-attention'
          ? { at: NOW, kind: 'attention' as const, reason: 'approval-required' as const, attempt: 0 }
          : replacement === 'accepted'
            ? { at: NOW, kind: 'accepted' as const, reason: 'recovery-accepted' as const, attempt: 1 }
            : replacement === 'reset'
              ? { at: NOW, kind: 'reset' as const, reason: 'manual-reset' as const, attempt: 0 }
              : { at: NOW, kind: 'state' as const, reason: 'user-input' as const, attempt: 0 };
      const f = fixture(
        enabledState(
          {
            conversationId: THREAD,
            needsAttention: true,
            lastReason: 'turn-running',
            history: [{ at: NOW - 1, kind: 'attention', reason: 'stalled', attempt: 0 }, newer],
          },
          { detectStalls: false }
        )
      );
      f.observation = { ...stalled('superseded-parent-warning'), progressAt: NOW + 1 };
      advance(1);
      await f.controller.inspect();
      expect(f.controller.getStatus().stallAlert).toBeUndefined();
      expect(f.controller.getStatus().needsAttention).toBe(true);
      expect(f.controller.getStatus().lastReason).toBe('turn-running');
      expect(f.act).not.toHaveBeenCalled();
    }
  );

  it.each(['approval-required', 'observing', 'disabled', 'turn-running'] as const)(
    'does not let a parent stall warning own a newer blocked warning after lastReason becomes %s',
    async (lastReason) => {
      const f = fixture(
        enabledState(
          {
            conversationId: THREAD,
            needsAttention: true,
            phase: 'paused',
            lastReason,
            history: [
              { at: NOW - 1, kind: 'attention', reason: 'stalled', attempt: 0 },
              { at: NOW, kind: 'state', reason: 'approval-required', attempt: 0 },
              ...(lastReason === 'approval-required'
                ? []
                : [{ at: NOW, kind: 'state' as const, reason: lastReason, attempt: 0 }]),
            ],
          },
          { detectStalls: true }
        )
      );
      f.observation = {
        activity: 'blocked',
        reason: 'approval-required',
        at: NOW + 1,
        progressAt: NOW + 1,
        conversationId: THREAD,
        safeToAct: false,
      };
      advance(1);
      await f.controller.inspect();
      expect(f.controller.getStatus()).toMatchObject({
        needsAttention: true,
        lastReason: 'approval-required',
        phase: 'paused',
      });
      expect(f.controller.getStatus().stallAlert).toBeUndefined();
      await f.controller.refresh();
      expect(f.controller.getStatus()).toMatchObject({
        needsAttention: true,
        lastReason: 'approval-required',
        phase: 'paused',
      });
      expect(f.controller.getStatus().stallAlert).toBeUndefined();
      expect(f.act).not.toHaveBeenCalled();
    }
  );

  it('restarts stall confirmation when the current turn changes or user input intervenes', async () => {
    const f = fixture(enabledState({}, { detectStalls: true, restartStalls: true, stalledAfterMs: 10_000 }));
    f.observation = stalled('turn-a');
    await f.controller.refresh();
    advance(2000);
    f.observation = stalled('turn-b');
    await f.controller.refresh();
    expect(f.controller.getStatus().lastReason).not.toBe('stall-unverified');
    f.controller.noteUserInput();
    advance(2000);
    await f.controller.refresh();
    expect(f.controller.getStatus().lastReason).not.toBe('stall-unverified');
    advance(7999);
    await f.controller.refresh();
    expect(f.controller.getStatus().lastReason).not.toBe('stall-unverified');
    advance(1);
    await f.controller.refresh();
    expect(f.controller.getStatus().lastReason).not.toBe('stall-unverified');
    advance(1999);
    await f.controller.refresh();
    expect(f.controller.getStatus().lastReason).not.toBe('stall-unverified');
    advance(1);
    await f.controller.refresh();
    expect(f.controller.getStatus().lastReason).toBe('stall-unverified');
    expect(f.act).not.toHaveBeenCalled();
  });

  it('expires widely spaced stall probes instead of combining stale reads', async () => {
    const f = fixture(enabledState({}, { detectStalls: true, restartStalls: true, stalledAfterMs: 10_000 }));
    f.observation = stalled('bounded-stall', true);
    await f.controller.refresh();
    advance(15_001);
    await f.controller.refresh();
    expect(f.controller.getStatus().pending).toBeUndefined();
    advance(1999);
    await f.controller.refresh();
    expect(f.controller.getStatus().pending).toBeUndefined();
    advance(1);
    await f.controller.refresh();
    expect(f.controller.getStatus().pending?.key).toBe('bounded-stall');
  });

  it('clears an ambiguous stall alert when progress resumes', async () => {
    const f = fixture(enabledState({}, { detectStalls: true, restartStalls: true, stalledAfterMs: 10_000 }));
    f.observation = stalled('resumed-turn');
    await f.controller.refresh();
    advance(2000);
    await f.controller.refresh();
    expect(f.controller.getStatus().needsAttention).toBe(true);
    f.observation = { ...stalled('resumed-turn'), progressAt: Date.now() };
    await f.controller.refresh();
    expect(f.controller.getStatus()).toMatchObject({ needsAttention: false, lastReason: 'turn-running' });
  });

  it.each([true, false])(
    'clears owned stall attention after settings change its reason (automatic: %s)',
    async (enabled) => {
      const f = fixture(enabledState({}, { enabled, detectStalls: true, restartStalls: true, stalledAfterMs: 10_000 }));
      f.observation = stalled('settings-during-stall');
      await f.controller.retry();
      advance(2000);
      await f.controller.retry();
      expect(f.controller.getStatus()).toMatchObject({ needsAttention: true, lastReason: 'stall-unverified' });

      await f.controller.updateConfig({ maxRetries: 4 });
      expect(f.controller.getStatus()).toMatchObject({
        needsAttention: true,
        lastReason: enabled ? 'observing' : 'disabled',
      });
      f.observation.progressAt = Date.now();
      await f.controller.inspect();
      expect(f.controller.getStatus()).toMatchObject({ needsAttention: false, lastReason: 'turn-running' });
      expect(f.controller.getStatus().stallAlert).toBeUndefined();
      await f.controller.refresh();
      expect(f.journal.at(-1)?.needsAttention).toBe(false);
      expect(f.act).not.toHaveBeenCalled();
    }
  );

  it('relinquishes stall attention ownership to a newer delivery failure', async () => {
    const f = fixture(enabledState({}, { detectStalls: true, restartStalls: true, stalledAfterMs: 10_000 }));
    f.observation = stalled('replaced-stall-alert');
    await f.controller.retry();
    advance(2000);
    await f.controller.retry();
    f.observation.stallRestartable = true;
    await f.controller.retry();
    advance(2000);
    f.outcome = 'not-sent';
    await f.controller.retry();
    expect(f.controller.getStatus()).toMatchObject({
      needsAttention: true,
      lastReason: 'delivery-failed',
      circuitOpen: false,
    });
    expect(f.controller.getStatus().stallAlert).toBeUndefined();

    await f.controller.updateConfig({ enabled: false });
    f.observation.progressAt = Date.now();
    await f.controller.inspect();
    await f.controller.refresh();
    expect(f.controller.getStatus().needsAttention).toBe(true);
    expect(f.act).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['stall detection off', { detectStalls: false }, stalled('off', true)],
    ['below threshold', { detectStalls: true, restartStalls: true, stalledAfterMs: 30_000 }, stalled('recent', true)],
    [
      'provider retry',
      { detectStalls: true, restartStalls: true, stalledAfterMs: 10_000 },
      { ...stalled('retry'), reason: 'internal-retry' },
    ],
    [
      'background work',
      { detectStalls: true, restartStalls: true, stalledAfterMs: 10_000 },
      { ...stalled('agent'), activity: 'watching', reason: 'background-work' },
    ],
  ] as const)('keeps %s non-actionable', async (_label, config, observation) => {
    const f = fixture(enabledState({}, config));
    f.observation = observation;
    await f.controller.refresh();
    advance(60_000);
    await f.controller.refresh();
    expect(f.act).not.toHaveBeenCalled();
    expect(f.controller.getStatus().lastReason).not.toBe('stalled');
  });

  it('reconciles a manual retry while automation is disabled, then stops observing', async () => {
    const f = fixture();
    await f.controller.retry();
    expect(f.act).toHaveBeenCalledTimes(1);
    expect(f.controller.getStatus()).toMatchObject({ config: { enabled: false }, phase: 'recovering' });
    expect(f.controller.getStatus().inFlight).toBeDefined();

    f.observation = acceptedSubmission();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.controller.getStatus()).toMatchObject({
      config: { enabled: false },
      phase: 'watching',
      lastReason: 'recovery-accepted',
    });
    expect(f.controller.getStatus().inFlight).toBeUndefined();
    const observed = f.observe.mock.calls.length;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(f.observe).toHaveBeenCalledTimes(observed);
    expect(f.act).toHaveBeenCalledTimes(1);
  });

  it('keeps acceptance monitoring after automation is disabled following a dispatch', async () => {
    const f = fixture(enabledState());
    await f.controller.retry();
    await f.controller.updateConfig({ enabled: false });
    expect(f.controller.getStatus()).toMatchObject({ config: { enabled: false }, phase: 'recovering' });

    f.observation = acceptedSubmission();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.controller.getStatus()).toMatchObject({
      config: { enabled: false },
      lastReason: 'recovery-accepted',
    });
    expect(f.controller.getStatus().inFlight).toBeUndefined();
    expect(f.act).toHaveBeenCalledTimes(1);
  });

  it('lets a status inspection reconcile a disabled in-flight retry without dispatching', async () => {
    const f = fixture();
    await f.controller.retry();
    f.observation = acceptedSubmission();
    await f.controller.inspect();
    expect(f.controller.getStatus()).toMatchObject({
      config: { enabled: false },
      lastReason: 'recovery-accepted',
    });
    expect(f.controller.getStatus().inFlight).toBeUndefined();
    expect(f.act).toHaveBeenCalledTimes(1);
  });

  it('retains failed read-only flight reconciliation across automatic timers until a later read can commit', async () => {
    const flight = { key: 'crash-proof', action: 'restart' as const, conversationId: THREAD, startedAt: NOW };
    const f = fixture({ ...initialRecoveryState(), conversationId: THREAD, inFlight: flight });
    f.observation = acceptedSubmission({ processReady: true });
    f.persist.mockRejectedValue(new Error('Disk unavailable'));
    await expect(f.controller.inspect()).resolves.toMatchObject({
      inFlight: flight,
      phase: 'blocked',
      circuitOpen: true,
      lastReason: 'persistence-failed',
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.observe).toHaveBeenCalledTimes(1);
    expect(f.controller.getStatus().inFlight).toEqual(flight);
    expect(f.changes.every((state) => state.inFlight?.key === flight.key)).toBe(true);
    expect(f.changes.some((state) => state.history.some((event) => event.kind === 'accepted'))).toBe(false);
    f.persist.mockImplementation(async (state) => {
      f.journal.push(structuredClone(state));
    });
    await expect(f.controller.inspect()).resolves.toMatchObject({ lastReason: 'recovery-accepted' });
    expect(f.controller.getStatus().inFlight).toBeUndefined();
    expect(f.journal.at(-1)?.inFlight).toBeUndefined();
    expect(f.act).not.toHaveBeenCalled();
  });

  it('bounds disabled in-flight observation at the acceptance timeout', async () => {
    const f = fixture();
    await f.controller.retry();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.controller.getStatus()).toMatchObject({
      config: { enabled: false },
      phase: 'paused',
      lastReason: 'acceptance-unverified',
    });
    expect(f.controller.getStatus().inFlight).toBeDefined();
    const observed = f.observe.mock.calls.length;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(f.observe).toHaveBeenCalledTimes(observed);
    expect(f.act).toHaveBeenCalledTimes(1);
  });
});

describe('durable reservation and serialization', () => {
  it('clears a supervisor retry intention cancelled while its schedule is saving', async () => {
    const f = fixture(enabledState());
    const entered = createDeferred();
    const release = createDeferred();
    f.persist.mockImplementation(async (state) => {
      if (state.pending && !state.inFlight) {
        entered.resolve();
        await release.promise;
      }
      f.journal.push(structuredClone(state));
    });
    let authorized = true;
    const work = f.controller.retry(() => authorized);
    await entered.promise;
    authorized = false;
    release.resolve();
    await work;
    expect(f.act).not.toHaveBeenCalled();
    expect(f.controller.getStatus()).toMatchObject({ attempts: 0, phase: 'watching' });
    expect(f.controller.getStatus().pending).toBeUndefined();
    expect(f.controller.getStatus().nextRetryAt).toBeUndefined();
  });

  it('persists the in-flight reservation before any side effect', async () => {
    const f = fixture(enabledState());
    const entered = createDeferred();
    const release = createDeferred();
    f.persist.mockImplementation(async (state) => {
      if (state.inFlight && !f.journal.some((saved) => saved.inFlight)) {
        entered.resolve();
        await release.promise;
      }
      f.journal.push(structuredClone(state));
      f.order.push(state.inFlight ? 'reserved' : 'saved');
    });
    const work = f.controller.retry();
    await entered.promise;
    expect(f.act).not.toHaveBeenCalled();
    release.resolve();
    await work;
    expect(f.order.indexOf('reserved')).toBeLessThan(f.order.indexOf('act:continue'));
    expect(f.journal.find((saved) => saved.inFlight)?.attempts).toBe(1);
  });

  it.each(['schedule', 'reservation'] as const)('performs no action when %s persistence fails', async (stage) => {
    const f = fixture(enabledState());
    f.persist.mockImplementation(async (state) => {
      if (stage === 'schedule' || state.inFlight) throw new Error('Disk unavailable');
      f.journal.push(structuredClone(state));
    });
    await expect(f.controller.retry()).rejects.toThrow(/could not be saved/);
    expect(f.act).not.toHaveBeenCalled();
    expect(f.controller.getStatus()).toMatchObject({
      circuitOpen: true,
      needsAttention: true,
      lastReason: 'persistence-failed',
    });
  });

  it('serializes concurrent and duplicate requests into one delivered action', async () => {
    const f = fixture(enabledState());
    await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? f.controller.refresh() : f.controller.retry())));
    expect(f.act).toHaveBeenCalledTimes(1);
    f.observation = acceptedSubmission();
    await f.controller.refresh();
    f.observation = failure('failure-1');
    await Promise.all([f.controller.retry(), f.controller.retry(), f.controller.refresh()]);
    expect(f.act).toHaveBeenCalledTimes(1);
    expect(f.controller.getStatus().handledEvidence).toContain('failure-1');
  });

  it.each(['disable', 'input', 'stop'] as const)('cancels a pending observation when %s races it', async (kind) => {
    const f = fixture(enabledState());
    const due = await schedule(f);
    advance(due - Date.now());
    const entered = createDeferred();
    const observed = createDeferred<RecoveryObservation>();
    f.observe.mockImplementationOnce(async () => {
      entered.resolve();
      return observed.promise;
    });
    const work = f.controller.refresh();
    await entered.promise;
    let disabled: Promise<RecoveryState> | undefined;
    if (kind === 'disable') disabled = f.controller.updateConfig({ enabled: false });
    else if (kind === 'input') f.controller.noteUserInput();
    else f.controller.stop();
    observed.resolve(f.observation);
    await work;
    if (disabled) await disabled;
    expect(f.act).not.toHaveBeenCalled();
  });

  it.each(['disable', 'input', 'stop'] as const)(
    'cancels final adapter revalidation when %s races it',
    async (kind) => {
      const f = fixture(enabledState());
      const entered = createDeferred();
      const release = createDeferred();
      let delivered = 0;
      f.act.mockImplementationOnce(async (_flight, isCurrent) => {
        entered.resolve();
        await release.promise;
        if (!isCurrent()) return 'not-sent';
        delivered++;
        return 'sent';
      });
      const work = f.controller.retry();
      await entered.promise;
      let disabled: Promise<RecoveryState> | undefined;
      if (kind === 'disable') disabled = f.controller.updateConfig({ enabled: false });
      else if (kind === 'input') f.controller.noteUserInput();
      else f.controller.stop();
      release.resolve();
      await work;
      if (disabled) await disabled;
      expect(delivered).toBe(0);
      expect(f.controller.getStatus()).toMatchObject({ attempts: 0, failedAttempts: 0, needsAttention: false });
      expect(f.controller.getStatus().inFlight).toBeUndefined();
    }
  );

  it('never replays uncertain partial delivery, even through manual Retry or reconstruction', async () => {
    const f = fixture(enabledState());
    f.outcome = 'unknown';
    await f.controller.retry();
    const saved = f.journal.at(-1)!;
    expect(saved.inFlight).toBeDefined();
    expect(saved.needsAttention).toBe(true);
    await f.controller.retry();
    advance(60_000);
    await f.controller.refresh();
    expect(f.act).toHaveBeenCalledTimes(1);
    const restarted = fixture(saved);
    await restarted.controller.retry();
    await restarted.controller.refresh();
    expect(restarted.act).not.toHaveBeenCalled();
    expect(restarted.controller.getStatus().inFlight).toEqual(saved.inFlight);
  });

  it('discards and durably disarms a restored pending action before polling', async () => {
    vi.setSystemTime(NOW + 10_000);
    const f = fixture(
      enabledState({
        phase: 'watching',
        lastReason: 'scheduled',
        pending: { key: 'failure-1', action: 'continue', conversationId: THREAD },
        nextRetryAt: NOW + 1000,
      })
    );
    f.observation = failure('failure-1', { at: NOW });
    expect(f.controller.getStatus().pending).toBeUndefined();
    expect(f.controller.getStatus().nextRetryAt).toBeUndefined();
    await f.controller.drain();
    expect(f.journal.at(-1)).toMatchObject({ armedAt: NOW + 10_000 });
    expect(f.journal.at(-1)?.pending).toBeUndefined();

    await vi.advanceTimersByTimeAsync(300_000);
    expect(f.act).not.toHaveBeenCalled();
  });

  it('fails closed when a queued input cancellation cannot be persisted', async () => {
    const f = fixture(enabledState());
    await schedule(f);
    f.persist.mockRejectedValueOnce(new Error('Disk unavailable'));
    f.controller.noteUserInput();
    await f.controller.drain();
    expect(f.controller.getStatus()).toMatchObject({
      pending: undefined,
      nextRetryAt: undefined,
      circuitOpen: true,
      needsAttention: true,
      lastReason: 'persistence-failed',
    });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(f.act).not.toHaveBeenCalled();
  });
});

describe('accepted evidence and persistent retry bounds', () => {
  function savedFlight(): RecoveryState {
    return enabledState({
      attempts: 1,
      windowStartedAt: NOW - 1000,
      phase: 'recovering',
      inFlight: {
        key: 'failure-1',
        action: 'continue',
        conversationId: THREAD,
        startedAt: NOW - 1000,
        previousSubmissionKey: 'original-user-message',
      },
    });
  }

  it.each(['wrong-hash', 'old-key', 'missing-key', 'different-thread'] as const)(
    'does not accept %s as a verified new continuation submission',
    async (mismatch) => {
      const f = fixture(savedFlight());
      f.observation = acceptedSubmission({
        ...(mismatch === 'wrong-hash' ? { submissionHash: 'another-prompt' } : {}),
        ...(mismatch === 'old-key' ? { submissionKey: 'original-user-message' } : {}),
        ...(mismatch === 'missing-key' ? { submissionKey: undefined } : {}),
        ...(mismatch === 'different-thread' ? { conversationId: OTHER_THREAD } : {}),
      });
      await f.controller.refresh();
      expect(f.controller.getStatus().inFlight).toBeDefined();
      expect(f.controller.getStatus().lastSuccessfulRecovery).toBeUndefined();
      expect(f.act).not.toHaveBeenCalled();
    }
  );

  it('reconciles an in-flight delivery after restart only from matching new accepted evidence', async () => {
    const f = fixture(savedFlight());
    expect(f.controller.getStatus().lastReason).toBe('restart-in-flight');
    f.observation = acceptedSubmission();
    await f.controller.refresh();
    expect(f.controller.getStatus()).toMatchObject({ attempts: 1, lastSuccessfulRecovery: NOW });
    expect(f.controller.getStatus().inFlight).toBeUndefined();
    expect(f.controller.getStatus().handledEvidence).toContain('failure-1');
    expect(f.act).not.toHaveBeenCalled();
  });

  it.each(['idle', 'completed'] as const)(
    'keeps the crash budget when resume shows an old %s transcript',
    async (activity) => {
      const saved = enabledState({
        attempts: 2,
        failedAttempts: 1,
        windowStartedAt: NOW - 1000,
        inFlight: { key: 'crash-1', action: 'restart', conversationId: THREAD, startedAt: NOW - 500 },
      });
      const f = fixture(saved);
      f.observation = acceptedSubmission({ activity, reason: 'turn-completed', at: NOW - 2000, processReady: true });
      await f.controller.refresh();
      expect(f.controller.getStatus()).toMatchObject({ attempts: 2, failedAttempts: 1, windowStartedAt: NOW - 1000 });
      const restored = fixture(f.journal.at(-1)!);
      restored.observation = f.observation;
      await restored.controller.refresh();
      expect(restored.controller.getStatus().attempts).toBe(2);
      expect(restored.act).not.toHaveBeenCalled();
    }
  );

  it('resets a crash budget only after a new completed turn', async () => {
    const f = fixture(enabledState({ attempts: 2, failedAttempts: 1, windowStartedAt: NOW - 1000 }));
    f.observation = acceptedSubmission({ activity: 'completed', reason: 'turn-completed' });
    await f.controller.refresh();
    expect(f.controller.getStatus()).toMatchObject({ attempts: 0, failedAttempts: 0 });
    expect(f.controller.getStatus().windowStartedAt).toBeUndefined();
  });

  it('backs off exponentially and opens a persistent circuit at the retry cap', async () => {
    const f = fixture(enabledState({}, { maxRetries: 3 }));
    f.outcome = 'not-sent';
    const firstDue = await schedule(f);
    expect(firstDue - Date.now()).toBe(1000);
    advance(1000);
    await f.controller.refresh();
    await f.controller.refresh();
    expect(f.controller.getStatus().nextRetryAt! - Date.now()).toBe(2000);
    advance(2000);
    await f.controller.refresh();
    await f.controller.refresh();
    expect(f.controller.getStatus().nextRetryAt! - Date.now()).toBe(4000);
    advance(4000);
    await f.controller.refresh();
    expect(f.act).toHaveBeenCalledTimes(3);
    expect(f.controller.getStatus()).toMatchObject({ attempts: 3, failedAttempts: 3, circuitOpen: true });
    const restarted = fixture(f.journal.at(-1)!);
    await restarted.controller.retry();
    expect(restarted.controller.getStatus().circuitOpen).toBe(true);
    expect(restarted.act).not.toHaveBeenCalled();
  });

  it('preserves an elapsed recovery window across reconstruction and manual Retry', async () => {
    const saved = enabledState({ attempts: 1, windowStartedAt: NOW - 10_000 }, { maxRecoveryDurationMs: 10_000 });
    const f = fixture(saved);
    await f.controller.retry();
    expect(f.controller.getStatus()).toMatchObject({
      attempts: 1,
      circuitOpen: true,
      lastReason: 'recovery-window-exhausted',
    });
    expect(f.act).not.toHaveBeenCalled();
  });

  it('bounds event history and deduplication records', async () => {
    const f = fixture(enabledState({ handledEvidence: Array.from({ length: 32 }, (_, i) => `old-${i}`) }));
    for (let i = 0; i < 110; i++) {
      f.observation = failure('blocked', {
        activity: 'blocked',
        reason: i % 2 ? 'usage-limit' : 'authentication-required',
        safeToAct: false,
      });
      advance(1);
      await f.controller.refresh();
    }
    expect(f.controller.getStatus().history).toHaveLength(100);
    f.observation = failure('new-failure');
    await f.controller.retry();
    f.observation = acceptedSubmission();
    await f.controller.refresh();
    expect(f.controller.getStatus().handledEvidence).toHaveLength(32);
    expect(f.controller.getStatus().handledEvidence).not.toContain('old-0');
    expect(f.controller.getStatus().handledEvidence).toContain('new-failure');
    expect(f.controller.getStatus().history).toHaveLength(100);
  });
});

describe('recovery runtime remains bounded at final dispatch', () => {
  it('retains the first elapsed window when persistence consumes the complete budget', async () => {
    const f = fixture(enabledState({}, { maxRecoveryDurationMs: 10_000 }));
    f.persist.mockImplementation(async (state) => {
      f.journal.push(structuredClone(state));
      if (state.inFlight) advance(10_000);
    });
    await f.controller.retry();
    expect(f.act).not.toHaveBeenCalled();
    expect(f.controller.getStatus()).toMatchObject({
      attempts: 0,
      failedAttempts: 0,
      circuitOpen: true,
      windowStartedAt: NOW,
      lastReason: 'recovery-window-exhausted',
    });
    expect(f.controller.getStatus().inFlight).toBeUndefined();
    const restored = fixture(f.journal.at(-1)!);
    await restored.controller.retry();
    expect(restored.act).not.toHaveBeenCalled();
  });

  it.each(['not-sent', 'unknown'] as const)(
    'carries expiration through final adapter reads with %s outcome',
    async (outcome) => {
      const f = fixture(enabledState({ attempts: 1, windowStartedAt: NOW - 9_000 }, { maxRecoveryDurationMs: 10_000 }));
      let delivered = false;
      f.act.mockImplementation(async (_flight, isCurrent) => {
        advance(1_000);
        if (isCurrent()) delivered = true;
        return outcome;
      });
      await f.controller.retry();
      expect(delivered).toBe(false);
      expect(f.controller.getStatus().windowStartedAt).toBe(NOW - 9_000);
      if (outcome === 'not-sent') {
        expect(f.controller.getStatus()).toMatchObject({
          attempts: 1,
          circuitOpen: true,
          lastReason: 'recovery-window-exhausted',
        });
        expect(f.controller.getStatus().inFlight).toBeUndefined();
      } else {
        expect(f.controller.getStatus().inFlight).toBeDefined();
        await f.controller.retry();
        expect(f.act).toHaveBeenCalledOnce();
      }
    }
  );

  it('still permits a verified action immediately before the deadline', async () => {
    const f = fixture(enabledState({ windowStartedAt: NOW - 9_999 }, { maxRecoveryDurationMs: 10_000 }));
    await f.controller.retry();
    expect(f.act).toHaveBeenCalledOnce();
    expect(f.controller.getStatus().lastReason).toBe('continuation-sent');
  });

  it.each([NOW + 1, -1])('refuses invalid restored recovery-window origin %s', async (windowStartedAt) => {
    const f = fixture(enabledState({ windowStartedAt }));
    await f.controller.retry();
    expect(f.act).not.toHaveBeenCalled();
    expect(f.controller.getStatus()).toMatchObject({ circuitOpen: true, lastReason: 'recovery-window-exhausted' });
  });
});
