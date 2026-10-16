/** Real routes/controller/journal in a temporary home; fake observations and effects only. */
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { RecoveryController } from '../../src/recovery/controller.js';
import { RecoveryStore } from '../../src/recovery/store.js';
import { initialRecoveryState, type RecoveryObservation, type RecoveryState } from '../../src/recovery/types.js';
import { registerRecoveryRoutes } from '../../src/web/routes/recovery-routes.js';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';

const ID = 'test-session-1';
const THREAD = '11111111-2222-3333-4444-555555555555';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function fixture(
  failure: 'corrupt' | 'unwritable',
  state: RecoveryState,
  observation: RecoveryObservation,
  check: (f: {
    harness: RouteTestHarness;
    controller: RecoveryController;
    journal: RecoveryStore;
    act: ReturnType<typeof vi.fn>;
    changes: RecoveryState[];
    bytes: () => Promise<string>;
    before: string;
    path: string;
  }) => Promise<void>
): Promise<void> {
  const root = await fs.mkdtemp(join(homedir(), 'recovery-status-'));
  const path = join(root, 'recovery.json');
  if (failure === 'corrupt') await fs.writeFile(path, '{unreadable-journal}');
  const journal = new RecoveryStore(path);
  if (failure === 'unwritable') {
    await journal.save(ID, state);
    // Force real atomic write failure without changing permissions globally.
    Reflect.set(journal, 'path', join(path, 'blocked'));
  }
  const before = await fs.readFile(path, 'utf8');
  const act = vi.fn(async () => 'not-sent' as const);
  const changes: RecoveryState[] = [];
  const controller = new RecoveryController(
    {
      observe: async () => structuredClone(observation),
      persist: (next) => journal.save(ID, next),
      changed: (next) => changes.push(structuredClone(next)),
      act,
    },
    journal.get(ID)
  );
  vi.stubEnv('CODEMAN_MULTIUSER', '1');
  const harness = await createRouteTestHarness(
    (app, ctx) => registerRecoveryRoutes(app, { ...ctx, getRecoveryController: () => controller }),
    { authUser: { username: 'alice', role: 'user' } }
  );
  Object.assign(harness.ctx._session, { mode: 'codex', owner: 'alice' });
  try {
    await check({ harness, controller, journal, act, changes, bytes: () => fs.readFile(path, 'utf8'), before, path });
  } finally {
    controller.stop();
    await controller.drain();
    await harness.app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

it.each(['corrupt', 'unwritable'] as const)(
  'returns readable blocked status for a %s journal while mutations still fail and effects remain vetoed',
  async (failure) => {
    await fixture(
      failure,
      initialRecoveryState(),
      { activity: 'idle', reason: 'observing', at: Date.now(), safeToAct: false },
      async ({ harness, act, bytes, before }) => {
        for (let i = 0; i < 2; i++) {
          const read = await harness.app.inject({ method: 'GET', url: `/api/sessions/${ID}/recovery` });
          expect(read.statusCode).toBe(200);
          expect(read.json()).toMatchObject({
            success: true,
            data: { phase: 'blocked', circuitOpen: true, needsAttention: true, lastReason: 'persistence-failed' },
          });
        }
        for (const request of [
          { method: 'PUT' as const, suffix: '/config', payload: { enabled: true } },
          { method: 'POST' as const, suffix: '/reset' },
        ]) {
          const response = await harness.app.inject({
            ...request,
            url: `/api/sessions/${ID}/recovery${request.suffix}`,
          });
          expect(response.statusCode).toBe(500);
          expect(response.json().success).toBe(false);
        }
        const retry = await harness.app.inject({ method: 'POST', url: `/api/sessions/${ID}/recovery/retry` });
        expect(retry.statusCode).toBe(200);
        expect(retry.json().data).toMatchObject({ circuitOpen: true, lastReason: 'persistence-failed' });
        expect(act).not.toHaveBeenCalled();
        expect(await bytes()).toBe(before);
      }
    );
  }
);

it('retains a durable flight and suppresses acceptance publication when read-only reconciliation cannot be saved', async () => {
  const state = {
    ...initialRecoveryState(),
    conversationId: THREAD,
    inFlight: { key: 'crash-proof', action: 'restart' as const, conversationId: THREAD, startedAt: Date.now() },
  };
  await fixture(
    'unwritable',
    state,
    {
      activity: 'working',
      reason: 'turn-running',
      at: Date.now(),
      conversationId: THREAD,
      processReady: true,
      safeToAct: false,
    },
    async ({ harness, controller, act, changes, journal, bytes, before }) => {
      const read = await harness.app.inject({ method: 'GET', url: `/api/sessions/${ID}/recovery` });
      expect(read.statusCode).toBe(200);
      expect(read.json().data).toMatchObject({
        inFlight: state.inFlight,
        circuitOpen: true,
        phase: 'blocked',
        lastReason: 'persistence-failed',
      });
      expect(controller.getStatus().lastSuccessfulRecovery).toBeUndefined();
      expect(journal.get(ID).inFlight).toEqual(state.inFlight);
      expect(changes).not.toHaveLength(0);
      for (const change of changes) {
        expect(change.inFlight).toEqual(state.inFlight);
        expect(change.history.some((event) => event.kind === 'accepted')).toBe(false);
      }
      expect(act).not.toHaveBeenCalled();
      expect(await bytes()).toBe(before);
    }
  );
});

it('keeps action scheduling writes throwing when the journal becomes unwritable before retry', async () => {
  await fixture(
    'unwritable',
    initialRecoveryState(),
    {
      activity: 'interrupted',
      reason: 'turn-failed',
      at: Date.now(),
      conversationId: THREAD,
      evidenceKey: 'failed-turn',
      safeToAct: true,
    },
    async ({ harness, controller, act, bytes, before }) => {
      const retry = await harness.app.inject({ method: 'POST', url: `/api/sessions/${ID}/recovery/retry` });
      expect(retry.statusCode).toBe(500);
      expect(retry.json().success).toBe(false);
      expect(controller.getStatus()).toMatchObject({
        phase: 'blocked',
        circuitOpen: true,
        lastReason: 'persistence-failed',
      });
      expect(act).not.toHaveBeenCalled();
      expect(await bytes()).toBe(before);
    }
  );
});

it('keeps newer owner cancellation and its timestamp when an inspection write fails, including after journal repair', async () => {
  const observation: RecoveryObservation = {
    activity: 'interrupted',
    reason: 'turn-failed',
    at: Date.now(),
    conversationId: THREAD,
    evidenceKey: 'failed-turn',
    safeToAct: true,
  };
  const state = initialRecoveryState();
  state.config.enabled = true;
  state.armedAt = observation.at;
  await fixture('unwritable', state, observation, async ({ harness, controller, journal, act, path }) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    Reflect.set(journal, 'path', path);
    await controller.refresh();
    vi.setSystemTime(Date.now() + 2100);
    observation.at = Date.now();
    await controller.refresh();
    expect(controller.getStatus().pending).toBeDefined();
    expect(controller.getStatus().nextRetryAt).toBeDefined();
    const priorArmedAt = controller.getStatus().armedAt;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const originalSave = journal.save.bind(journal);
    vi.spyOn(journal, 'save').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return originalSave(...args);
    });
    Reflect.set(journal, 'path', join(path, 'blocked'));
    observation.activity = 'idle';
    observation.reason = 'observing';
    const reading = harness.app.inject({ method: 'GET', url: `/api/sessions/${ID}/recovery` });
    await entered.promise;
    vi.setSystemTime(Date.now() + 1000);
    const ownerInputAt = Date.now();
    try {
      controller.noteUserInput();
      expect(controller.getStatus().pending).toBeUndefined();
    } finally {
      release.resolve();
    }
    const read = await reading;
    await controller.drain();
    expect(read.statusCode).toBe(200);
    expect(read.json().data).toMatchObject({ phase: 'blocked', circuitOpen: true, armedAt: ownerInputAt });
    expect(read.json().data.pending).toBeUndefined();
    expect(read.json().data.nextRetryAt).toBeUndefined();
    expect(ownerInputAt).toBeGreaterThan(priorArmedAt ?? 0);
    expect(controller.getStatus()).toMatchObject({ armedAt: ownerInputAt, lastReason: 'persistence-failed' });
    expect(controller.getStatus().pending).toBeUndefined();
    expect(controller.getStatus().nextRetryAt).toBeUndefined();
    Reflect.set(journal, 'path', path);
    observation.activity = 'working';
    observation.reason = 'turn-running';
    const repaired = await harness.app.inject({ method: 'GET', url: `/api/sessions/${ID}/recovery` });
    expect(repaired.statusCode).toBe(200);
    expect(journal.get(ID).armedAt).toBe(ownerInputAt);
    expect(journal.get(ID).pending).toBeUndefined();
    expect(journal.get(ID).nextRetryAt).toBeUndefined();
    expect(act).not.toHaveBeenCalled();
  });
});
