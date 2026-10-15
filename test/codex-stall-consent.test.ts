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
  const effects = vi.fn(async (_flight: RecoveryFlight, _current: RecoveryActionAuthority) => 'sent' as const);
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

it.each(['restartStalls', 'detectStalls'] as const)(
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

it('preserves prior explicit restart consent across an unrelated setting change', async () => {
  const f = await fixture(false, true);
  await f.controller.updateConfig({ maxRetries: 4 });
  expect(f.controller.getStatus().config.restartStalls).toBe(true);
  await f.controller.retry();
  vi.setSystemTime(NOW + 2000);
  await f.controller.retry();
  expect(f.effects).toHaveBeenCalledOnce();
});

it.each(['restartStalls', 'detectStalls'] as const)(
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
