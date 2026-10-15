/** Old alert-only journals cannot become restart consent; no real panes or SSH. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RecoveryController } from '../src/recovery/controller.js';
import { RecoveryStore } from '../src/recovery/store.js';
import {
  initialRecoveryState,
  type RecoveryObservation,
  type RecoveryFlight,
  type RecoveryActionAuthority,
} from '../src/recovery/types.js';
import { createDeferred } from './mocks/index.js';

const NOW = Date.UTC(2026, 9, 14, 12);
const THREAD = '11111111-2222-3333-4444-555555555555';
const STALL_POLICY_SETTINGS = ['enabled', 'detectStalls', 'restartStalls'] as const;
const controllers: RecoveryController[] = [];
const roots: string[] = [];
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
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(remote: boolean, restartStalls?: boolean, warning = true) {
  const root = await mkdtemp(join(tmpdir(), 'codeman-stall-consent-'));
  roots.push(root);
  const path = join(root, 'recovery.json');
  const old = initialRecoveryState();
  old.config = {
    ...old.config,
    enabled: true,
    detectStalls: true,
    recoverCrashes: false,
    stalledAfterMs: 10_000,
    retryDelayMs: 1000,
  };
  const config = { ...old.config } as Record<string, unknown>;
  if (restartStalls === undefined) delete config.restartStalls;
  else config.restartStalls = restartStalls;
  old.armedAt = NOW - 60_000;
  old.conversationId = THREAD;
  old.needsAttention = warning;
  old.phase = warning ? 'paused' : 'watching';
  old.lastReason = 'turn-running';
  old.history = warning ? [{ at: NOW - 1000, kind: 'attention', reason: 'stalled', attempt: 0 }] : [];
  await writeFile(path, JSON.stringify({ version: 1, sessions: { worker: { ...old, config } } }));
  const store = new RecoveryStore(path);
  expect(store.loadFailed).toBe(false);
  const observation: RecoveryObservation = {
    activity: 'working',
    reason: 'turn-running',
    at: NOW - 20_000,
    progressAt: NOW - 20_000,
    conversationId: THREAD,
    stallEvidenceKey: `${THREAD}:unfinished:stalled`,
    stallRestartable: true,
    processProofKey: 'exact-current-dead-process',
    safeToAct: false,
    ...(remote ? { progressEvidenceKey: `remote:${'a'.repeat(64)}`, progressLowerBound: NOW - 20_001 } : {}),
  };
  const effects = vi.fn(
    async (_flight: RecoveryFlight, _current: RecoveryActionAuthority): Promise<'sent' | 'not-sent' | 'unknown'> =>
      'sent'
  );
  const controller = new RecoveryController(
    {
      observe: async () => ({ ...observation, stallObservedAt: Date.now() }),
      act: effects,
      persist: (state) => store.save('worker', state),
      changed: () => {},
    },
    store.get('worker')
  );
  controllers.push(controller);
  return { controller, store, path, observation, effects };
}

it.each([false, true].flatMap((remote) => [undefined, false].map((consent) => ({ remote, consent }))))(
  'keeps actual legacy alert-only journals non-actionable despite fresh abnormal death (SSH=$remote consent=$consent)',
  async ({ remote, consent }) => {
    const f = await fixture(remote, consent);
    expect(f.store.get('worker').config.restartStalls).toBe(false);
    await f.controller.inspect();
    for (const patch of [{}, { maxRetries: 4 }, { detectStalls: true }, { restartStalls: false }]) {
      await f.controller.updateConfig(patch);
      await f.controller.refresh();
      vi.setSystemTime(Date.now() + 2000);
      await f.controller.retry();
      expect(f.effects).not.toHaveBeenCalled();
      expect(f.controller.getStatus()).toMatchObject({
        attempts: 0,
        needsAttention: true,
        config: { enabled: true, detectStalls: true, restartStalls: false },
      });
      expect(f.controller.getStatus().inFlight).toBeUndefined();
      expect(f.controller.getStatus().pending).toBeUndefined();
    }
    expect(f.controller.getStatus().history.filter((event) => event.kind === 'attention')).toHaveLength(1);
    expect(JSON.parse(await readFile(f.path, 'utf8')).sessions.worker.config.restartStalls).toBe(false);
    expect(new RecoveryStore(f.path).get('worker').config.restartStalls).toBe(false);
    // Only this explicit new owner setting can create restart authority.
    const armedAt = Date.now();
    await f.controller.updateConfig({ restartStalls: true });
    expect(f.controller.getStatus().armedAt).toBe(armedAt);
    await f.controller.retry();
    vi.setSystemTime(armedAt + 9999);
    await f.controller.retry();
    expect(f.effects).not.toHaveBeenCalled();
    vi.setSystemTime(armedAt + 10_000);
    await f.controller.retry();
    vi.setSystemTime(armedAt + 12_000);
    await f.controller.retry();
    expect(f.effects).toHaveBeenCalledOnce();
    expect(f.effects.mock.calls[0]?.[0]).toMatchObject({ action: 'restart', reason: 'stalled' });
    expect(new RecoveryStore(f.path).get('worker').config.restartStalls).toBe(true);
  }
);

it.each(STALL_POLICY_SETTINGS)(
  'withdraws %s authority during held final dispatch without any worker effect',
  async (setting) => {
    const f = await fixture(false, true);
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const workerEffect = vi.fn();
    const deps = Reflect.get(f.controller, 'deps');
    deps.act = async (_flight: unknown, isCurrent: () => boolean) => {
      entered.resolve();
      await release.promise;
      if (!isCurrent()) return 'not-sent';
      workerEffect();
      return 'sent';
    };
    await f.controller.retry();
    vi.setSystemTime(NOW + 2000);
    const action = f.controller.retry();
    await entered.promise;
    const updating = f.controller.updateConfig({ [setting]: false });
    release.resolve();
    await action;
    await updating;
    expect(workerEffect).not.toHaveBeenCalled();
    expect(f.controller.getStatus().inFlight).toBeUndefined();
    expect(f.controller.getStatus().attempts).toBe(0);
    if (setting === 'restartStalls') {
      expect(f.controller.getStatus().needsAttention).toBe(true);
      expect(f.controller.getStatus().stallAlert).toBeDefined();
    }
    expect(new RecoveryStore(f.path).get('worker').config[setting]).toBe(false);
  }
);

it.each(
  [false, true].flatMap((remote) =>
    (['unrelated', 'stalledAfterMs', ...STALL_POLICY_SETTINGS] as const).map((setting) => ({ remote, setting }))
  )
)('preserves current confirmation for an unchanged policy ($setting SSH=$remote)', async ({ remote, setting }) => {
  const f = await fixture(remote, true);
  await f.controller.retry();
  expect(f.effects).not.toHaveBeenCalled();
  await f.controller.updateConfig(
    setting === 'unrelated'
      ? { maxRetries: 4 }
      : setting === 'stalledAfterMs'
        ? { stalledAfterMs: 10_000 }
        : { [setting]: true }
  );
  expect(f.controller.getStatus().config.restartStalls).toBe(true);
  vi.setSystemTime(NOW + 2000);
  await f.controller.retry();
  expect(f.effects).toHaveBeenCalledOnce();
});

it.each(
  [false, true].flatMap((remote) =>
    [false, true].flatMap((restartable) =>
      [
        { direction: 'increase', initial: 10_000, next: 25_000, oldProgress: 20_000, firstFresh: 5000 },
        { direction: 'decrease', initial: 30_000, next: 10_000, oldProgress: 40_000, firstFresh: 2000 },
      ].map((threshold) => ({ remote, restartable, ...threshold }))
    )
  )
)(
  'requires two newly qualifying probes after a threshold $direction (SSH=$remote restartable=$restartable)',
  async ({ remote, restartable, initial, next, oldProgress, firstFresh }) => {
    const f = await fixture(remote, true, false);
    Object.assign(f.observation, {
      at: NOW - oldProgress,
      progressAt: NOW - oldProgress,
      stallRestartable: restartable,
      ...(remote ? { progressLowerBound: NOW - oldProgress - 1 } : {}),
    });
    await f.controller.updateConfig({ stalledAfterMs: initial });
    await f.controller.retry();
    const before = f.controller.getStatus();
    expect(before.pending).toBeUndefined();
    expect(before.inFlight).toBeUndefined();
    expect(before.needsAttention).toBe(false);
    vi.setSystemTime(NOW + 1000);
    await f.controller.updateConfig({ stalledAfterMs: next });
    expect(f.controller.getStatus().armedAt).toBe(before.armedAt);
    // The first post-edit observation qualifies under the new threshold and
    // still lies within the old confirmation's 15s lifetime.
    vi.setSystemTime(NOW + firstFresh);
    await f.controller.retry();
    expect(f.effects).not.toHaveBeenCalled();
    expect(f.controller.getStatus()).toMatchObject({ needsAttention: false, attempts: 0 });
    expect(f.controller.getStatus().inFlight).toBeUndefined();
    vi.setSystemTime(NOW + firstFresh + 1999);
    await f.controller.retry();
    expect(f.effects).not.toHaveBeenCalled();
    expect(f.controller.getStatus().needsAttention).toBe(false);
    vi.setSystemTime(NOW + firstFresh + 2000);
    await f.controller.retry();
    if (restartable) {
      expect(f.effects).toHaveBeenCalledOnce();
      expect(f.effects.mock.calls[0]?.[0]).toMatchObject({ action: 'restart', reason: 'stalled' });
    } else {
      expect(f.effects).not.toHaveBeenCalled();
      expect(f.controller.getStatus()).toMatchObject({
        needsAttention: true,
        lastReason: 'stall-unverified',
        attempts: 0,
      });
    }
  }
);

it.each([false, true])(
  'reconfirms a pending stall after a threshold edit before its scheduled dispatch (SSH=%s)',
  async (remote) => {
    const f = await fixture(remote, true, false);
    await f.controller.refresh();
    vi.setSystemTime(NOW + 2000);
    await f.controller.refresh();
    const before = f.controller.getStatus();
    expect(before.pending).toMatchObject({ action: 'restart', reason: 'stalled' });
    expect(before.nextRetryAt).toBe(NOW + 3000);
    await f.controller.updateConfig({ stalledAfterMs: 15_000 });
    expect(f.controller.getStatus().pending).toEqual(before.pending);
    vi.setSystemTime(NOW + 3000);
    await f.controller.refresh();
    expect(f.effects).not.toHaveBeenCalled();
    expect(f.controller.getStatus().attempts).toBe(0);
    vi.setSystemTime(NOW + 4999);
    await f.controller.refresh();
    expect(f.effects).not.toHaveBeenCalled();
    vi.setSystemTime(NOW + 5000);
    await f.controller.refresh();
    expect(f.effects).toHaveBeenCalledOnce();
  }
);

it.each(
  [false, true].flatMap((remote) =>
    STALL_POLICY_SETTINGS.flatMap((setting) => [10_000, 15_000].map((quiet) => ({ remote, setting, quiet })))
  )
)(
  'requires two fresh post-consent probes after $setting off/on (SSH=$remote quiet=$quiet)',
  async ({ remote, setting, quiet }) => {
    const f = await fixture(remote, true);
    await f.controller.updateConfig({ stalledAfterMs: quiet });
    await f.controller.retry();
    const before = f.controller.getStatus();
    expect(before.pending).toBeUndefined();
    expect(before.inFlight).toBeUndefined();
    expect(before.attempts).toBe(0);
    // Exercise both a rapid real-time change and a same-millisecond change at
    // the maximum lifetime of the old private confirmation.
    const armedAt = quiet === 10_000 ? NOW + 200 : NOW;
    vi.setSystemTime(armedAt);
    await f.controller.updateConfig({ [setting]: false });
    await f.controller.updateConfig({ [setting]: true });
    expect(f.controller.getStatus().armedAt).toBe(armedAt);
    vi.setSystemTime(armedAt + quiet);
    await f.controller.retry();
    expect(f.effects).not.toHaveBeenCalled();
    expect(f.controller.getStatus()).toMatchObject({ attempts: 0 });
    expect(f.controller.getStatus().pending).toBeUndefined();
    expect(f.controller.getStatus().inFlight).toBeUndefined();
    expect(f.controller.getStatus().history.filter((event) => event.kind === 'attention')).toEqual(
      before.history.filter((event) => event.kind === 'attention')
    );
    vi.setSystemTime(armedAt + quiet + 1999);
    await f.controller.retry();
    expect(f.effects).not.toHaveBeenCalled();
    vi.setSystemTime(armedAt + quiet + 2000);
    await f.controller.retry();
    expect(f.effects).toHaveBeenCalledOnce();
    expect(f.effects.mock.calls[0]?.[0]).toMatchObject({ action: 'restart', reason: 'stalled' });
  }
);

it.each(
  [...STALL_POLICY_SETTINGS, 'stalledAfterMs' as const].flatMap((setting) =>
    ['accepted', 'uncertain'].map((phase) => ({ setting, phase }))
  )
)('retains $phase delivery history through $setting changes without replay', async ({ setting, phase }) => {
  const f = await fixture(true, true);
  f.effects.mockResolvedValueOnce(phase === 'uncertain' ? 'unknown' : 'sent');
  await f.controller.retry();
  vi.setSystemTime(NOW + 2000);
  await f.controller.retry();
  expect(f.effects).toHaveBeenCalledOnce();
  if (phase === 'accepted') {
    vi.setSystemTime(NOW + 3000);
    Object.assign(f.observation, {
      activity: 'completed',
      reason: 'turn-completed',
      stallRestartable: false,
      processReady: true,
      processReadyAt: Date.now(),
    });
    await f.controller.inspect();
    expect(f.controller.getStatus().inFlight).toBeUndefined();
    expect(f.controller.getStatus().handledEvidence).toHaveLength(1);
    Object.assign(f.observation, {
      activity: 'working',
      reason: 'turn-running',
      stallRestartable: true,
      processReady: false,
    });
  }
  const before = f.controller.getStatus();
  if (setting === 'stalledAfterMs') {
    await f.controller.updateConfig({ stalledAfterMs: 25_000 });
    await f.controller.updateConfig({ stalledAfterMs: 10_000 });
  } else {
    await f.controller.updateConfig({ [setting]: false });
    await f.controller.updateConfig({ [setting]: true });
  }
  vi.setSystemTime(Date.now() + 10_000);
  await f.controller.retry();
  vi.setSystemTime(Date.now() + 2000);
  await f.controller.retry();
  expect(f.effects).toHaveBeenCalledOnce();
  const after = new RecoveryStore(f.path).get('worker');
  expect(after.attempts).toBe(before.attempts);
  expect(after.failedAttempts).toBe(before.failedAttempts);
  expect(after.windowStartedAt).toBe(before.windowStartedAt);
  expect(after.lastSuccessfulRecovery).toBe(before.lastSuccessfulRecovery);
  expect(after.inFlight).toEqual(before.inFlight);
  expect(after.handledEvidence).toEqual(before.handledEvidence);
  expect(after.history.filter((event) => event.kind === 'accepted')).toEqual(
    before.history.filter((event) => event.kind === 'accepted')
  );
});

it.each(STALL_POLICY_SETTINGS)(
  'durably cancels a scheduled stall action immediately when %s is withdrawn',
  async (setting) => {
    const f = await fixture(false, true, false);
    await f.controller.refresh();
    vi.setSystemTime(NOW + 2000);
    await f.controller.refresh();
    expect(f.controller.getStatus().pending).toMatchObject({ action: 'restart', reason: 'stalled' });
    await f.controller.updateConfig({ [setting]: false });
    expect(f.controller.getStatus().pending).toBeUndefined();
    expect(f.controller.getStatus().nextRetryAt).toBeUndefined();
    expect(new RecoveryStore(f.path).get('worker').pending).toBeUndefined();
    expect(f.effects).not.toHaveBeenCalled();
  }
);

it.each([false, true])(
  'raises attention for a new confirmed dead stall without old warning or restart consent (SSH=%s)',
  async (remote) => {
    const f = await fixture(remote, undefined, false);
    await f.controller.refresh();
    expect(f.controller.getStatus().needsAttention).toBe(false);
    vi.setSystemTime(NOW + 2000);
    await f.controller.refresh();
    expect(f.controller.getStatus()).toMatchObject({
      lastReason: 'stall-unverified',
      needsAttention: true,
      attempts: 0,
    });
    vi.setSystemTime(NOW + 4000);
    await f.controller.retry();
    expect(f.effects).not.toHaveBeenCalled();
    expect(f.controller.getStatus().history.filter((event) => event.kind === 'attention')).toHaveLength(1);
  }
);

it.each(['true', 1, null])('never repairs malformed restart consent into authority: %j', async (value) => {
  const f = await fixture(false);
  const document = JSON.parse(await readFile(f.path, 'utf8'));
  document.sessions.worker.config.restartStalls = value;
  const bytes = JSON.stringify(document);
  await writeFile(f.path, bytes);
  const rejected = new RecoveryStore(f.path);
  expect(rejected.loadFailed).toBe(true);
  expect(rejected.get('worker').config.restartStalls).toBe(false);
  expect(await readFile(f.path, 'utf8')).toBe(bytes);
  expect(f.effects).not.toHaveBeenCalled();
});

it.each(
  [false, true].flatMap((remote) =>
    (['recoverCrashes', 'recoverInterrupted'] as const).map((setting) => ({ remote, setting }))
  )
)(
  'requires fresh stall probes after $setting changes without resetting quiet time (SSH=$remote)',
  async ({ remote, setting }) => {
    const f = await fixture(remote, true, false);
    await f.controller.retry();
    const before = f.controller.getStatus();
    const consent = before.config[setting];
    await f.controller.updateConfig({ [setting]: !consent });
    await f.controller.updateConfig({ [setting]: consent });
    expect(f.controller.getStatus().armedAt).toBe(before.armedAt);
    vi.setSystemTime(NOW + 2000);
    await f.controller.retry();
    expect(f.effects).not.toHaveBeenCalled();
    vi.setSystemTime(NOW + 3999);
    await f.controller.retry();
    expect(f.effects).not.toHaveBeenCalled();
    vi.setSystemTime(NOW + 4000);
    await f.controller.retry();
    expect(f.effects).toHaveBeenCalledOnce();
    expect(f.effects.mock.calls[0]?.[0]).toMatchObject({ action: 'restart', reason: 'stalled' });
  }
);
