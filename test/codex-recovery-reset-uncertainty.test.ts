/** Real recovery journal + effect counts: Reset never certifies that an uncertain action was unsent. */
import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RecoveryController, type RecoveryDependencies } from '../src/recovery/controller.js';
import { RecoveryStore } from '../src/recovery/store.js';
import {
  CONTINUATION_PROMPT,
  initialRecoveryState,
  type RecoveryObservation,
  type RecoveryState,
} from '../src/recovery/types.js';
import { registerRecoveryRoutes } from '../src/web/routes/recovery-routes.js';
import { createDeferred } from './mocks/index.js';
const NOW = Date.UTC(2026, 9, 15, 18);
const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  THREAD = '11111111-2222-3333-4444-555555555555';
const HASH = createHash('sha256').update(CONTINUATION_PROMPT).digest('hex');
const controllers: RecoveryController[] = [],
  roots: string[] = [];
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
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
type Action = 'continue' | 'restart';
type Result = 'unknown' | 'throw' | 'sent' | 'not-sent';
async function fixture(action: Action, result: Result) {
  const root = await fs.mkdtemp(join(homedir(), 'reset-uncertainty-'));
  roots.push(root);
  const path = join(root, 'recovery.json'),
    store = new RecoveryStore(path);
  const initial = initialRecoveryState();
  initial.config.enabled = true;
  initial.armedAt = NOW;
  const f = {
    observation: {
      activity: action === 'restart' ? 'crashed' : 'interrupted',
      reason: action === 'restart' ? 'process-crashed' : 'turn-failed',
      at: NOW,
      conversationId: THREAD,
      evidenceKey: 'original-failure',
      submissionKey: 'original-owner-submission',
      safeToAct: true,
    } as RecoveryObservation,
    effects: 0,
    result,
    failResultSave: false,
    store,
    path,
  };
  const persist = vi.fn(async (state: RecoveryState) => {
    if (f.failResultSave && state.lastReason === 'acceptance-unverified') throw Error('Private journal unavailable');
    await store.save(SID, state);
  });
  const act = vi.fn(
    async (
      _flight: Parameters<RecoveryDependencies['act']>[0],
      _current: Parameters<RecoveryDependencies['act']>[1]
    ) => {
      if (f.result !== 'not-sent') f.effects++;
      if (f.result === 'throw') throw Error('Effect ACK lost');
      return f.result;
    }
  );
  const create = (state: RecoveryState) => {
    const controller = new RecoveryController(
      { observe: async () => structuredClone(f.observation), act, persist, changed: () => {} },
      state
    );
    controllers.push(controller);
    return controller;
  };
  const controller = create(initial);
  return Object.assign(f, { controller, persist, act, create });
}

it.each(
  ['continue', 'restart'].flatMap((action) =>
    ['unknown', 'throw', 'sent'].map((result) => ({ action: action as Action, result: result as Result }))
  )
)('keeps $action effects sealed through reset/reload/retry after $result delivery', async ({ action, result }) => {
  const f = await fixture(action, result);
  await f.controller.retry();
  expect(f.effects).toBe(1);
  if (result === 'sent') {
    vi.setSystemTime(NOW + 60_000);
    await f.controller.refresh();
  }
  const before = f.controller.getStatus();
  expect(before.inFlight).toBeDefined();
  if (result === 'sent') expect(before.lastReason).toBe('acceptance-unverified');
  const bytes = await fs.readFile(f.path, 'utf8'),
    writes = f.persist.mock.calls.length;
  let refusal: unknown;
  try {
    await f.controller.reset();
  } catch (error) {
    refusal = error;
  }
  const afterReset = f.controller.getStatus(),
    afterBytes = await fs.readFile(f.path, 'utf8'),
    afterWrites = f.persist.mock.calls.length;
  await f.controller.retry();
  await f.controller.refresh();
  // Assert actual duplicate effects first: the old reset path clears its only
  // reservation and dispatches this exact failure a second time.
  expect(f.effects).toBe(1);
  expect(f.act).toHaveBeenCalledOnce();
  expect(refusal).toBeInstanceOf(Error);
  expect((refusal as Error).message).toBe('Recovery delivery is still unverified');
  expect(afterReset).toEqual(before);
  expect(afterWrites).toBe(writes);
  expect(afterBytes).toBe(bytes);
  f.controller.stop();
  await f.controller.drain();
  const reload = new RecoveryStore(f.path);
  expect(reload.loadFailed).toBe(false);
  const restored = f.create(reload.get(SID));
  expect(restored.getStatus().inFlight).toEqual(before.inFlight);
  await expect(restored.reset()).rejects.toThrow('Recovery delivery is still unverified');
  await restored.retry();
  await restored.inspect();
  expect(f.effects).toBe(1);
  expect(f.act).toHaveBeenCalledOnce();
});

it.each(['continue', 'restart'] as const)(
  'preserves $action uncertainty when the post-effect journal save fails',
  async (action) => {
    const f = await fixture(action, 'unknown');
    f.failResultSave = true;
    await expect(f.controller.retry()).rejects.toThrow('Recovery state could not be saved');
    const before = f.controller.getStatus();
    expect(before).toMatchObject({ circuitOpen: true, lastReason: 'persistence-failed', attempts: 1 });
    expect(before.inFlight).toBeDefined();
    expect(f.effects).toBe(1);
    const writes = f.persist.mock.calls.length;
    await expect(f.controller.reset()).rejects.toThrow('Recovery delivery is still unverified');
    expect(f.controller.getStatus()).toEqual(before);
    expect(f.persist).toHaveBeenCalledTimes(writes);
    const reload = new RecoveryStore(f.path);
    expect(reload.get(SID).inFlight).toEqual(before.inFlight);
    f.failResultSave = false;
    const restored = f.create(reload.get(SID));
    await expect(restored.reset()).rejects.toThrow('Recovery delivery is still unverified');
    await restored.retry();
    expect(f.effects).toBe(1);
  }
);

it.each(['continue', 'restart'] as const)(
  'allows budget reset after verified $action acceptance while sealing old evidence and admitting fresh work',
  async (action) => {
    const f = await fixture(action, 'unknown');
    await f.controller.retry();
    expect(f.effects).toBe(1);
    f.observation = {
      activity: 'working',
      reason: 'turn-running',
      at: NOW,
      conversationId: THREAD,
      safeToAct: false,
      ...(action === 'restart'
        ? { processReady: true, processReadyAt: NOW }
        : { submissionHash: HASH, submissionKey: 'verified-new-continuation' }),
    };
    await f.controller.inspect();
    expect(f.controller.getStatus().inFlight).toBeUndefined();
    expect(f.controller.getStatus().handledEvidence).toContain('original-failure');
    await f.controller.reset();
    expect(f.controller.getStatus()).toMatchObject({ attempts: 0, failedAttempts: 0, lastReason: 'manual-reset' });
    const state = new RecoveryStore(f.path).get(SID);
    expect(state.inFlight).toBeUndefined();
    expect(state.handledEvidence).toContain('original-failure');
    f.observation = {
      activity: action === 'restart' ? 'crashed' : 'interrupted',
      reason: action === 'restart' ? 'process-crashed' : 'turn-failed',
      at: NOW,
      conversationId: THREAD,
      evidenceKey: 'original-failure',
      safeToAct: true,
    };
    await f.controller.retry();
    expect(f.effects).toBe(1);
    f.observation.evidenceKey = 'fresh-failure';
    f.result = 'sent';
    await f.controller.retry();
    expect(f.effects).toBe(2);
  }
);

it.each(['continue', 'restart'] as const)(
  'allows reset after certified $action non-delivery without sealing unsent evidence',
  async (action) => {
    const f = await fixture(action, 'not-sent');
    await f.controller.retry();
    expect(f.effects).toBe(0);
    expect(f.controller.getStatus().inFlight).toBeUndefined();
    await f.controller.reset();
    expect(f.controller.getStatus()).toMatchObject({ attempts: 0, lastReason: 'manual-reset' });
    f.result = 'sent';
    await f.controller.retry();
    expect(f.effects).toBe(1);
  }
);

it.each(['continue', 'restart'] as const)(
  'reset still withdraws held $action authority, allowing only certified unsent cleanup',
  async (action) => {
    const f = await fixture(action, 'sent'),
      entered = createDeferred(),
      release = createDeferred();
    f.act.mockImplementation(async (_flight, current) => {
      entered.resolve();
      await release.promise;
      if (!current()) return 'not-sent';
      f.effects++;
      return 'sent';
    });
    const work = f.controller.retry();
    await entered.promise;
    const reset = f.controller.reset();
    release.resolve();
    await work;
    await reset;
    expect(f.effects).toBe(0);
    expect(f.controller.getStatus()).toMatchObject({ attempts: 0, failedAttempts: 0, lastReason: 'manual-reset' });
    expect(f.controller.getStatus().inFlight).toBeUndefined();
  }
);

it('the actual authorized reset API reports conflict rather than clearing or acknowledging uncertain effects', async () => {
  const f = await fixture('continue', 'unknown');
  await f.controller.retry();
  const before = f.controller.getStatus(),
    app = Fastify({ logger: false });
  registerRecoveryRoutes(app, {
    sessions: new Map([[SID, { id: SID, owner: undefined }]]),
    getRecoveryController: () => f.controller,
  } as never);
  try {
    const reset = await app.inject({ method: 'POST', url: `/api/sessions/${SID}/recovery/reset` });
    expect(reset.statusCode).toBe(409);
    expect(reset.json()).toMatchObject({ success: false, errorCode: 'CONFLICT' });
    expect(f.controller.getStatus()).toEqual(before);
    const retry = await app.inject({ method: 'POST', url: `/api/sessions/${SID}/recovery/retry` });
    expect(retry.statusCode).toBe(200);
    expect(f.effects).toBe(1);
    expect(f.act).toHaveBeenCalledOnce();
  } finally {
    await app.close();
  }
});
