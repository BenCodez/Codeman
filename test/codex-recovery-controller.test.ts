/** Deterministic recovery behavior: fake time, observations and persistence; no real panes or CLI. */
import { createHash } from 'node:crypto';
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
    armedAt: patch.armedAt ?? NOW,
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
  const controller = new RecoveryController({ observe, persist, changed, act, now: () => Date.now() }, restored);
  controllers.push(controller);
  return Object.assign(f, { controller, observe, persist, changed, act });
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

describe('recovery action authority', () => {
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
