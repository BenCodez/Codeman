/** Recovery journal behavior on real fixture files below test/setup.ts's isolated HOME. */
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecoveryController } from '../src/recovery/controller.js';
import { RecoveryStore } from '../src/recovery/store.js';
import {
  initialRecoveryState,
  type RecoveryObservation,
  type RecoveryReason,
  type RecoveryState,
} from '../src/recovery/types.js';
import { registerRecoveryRoutes } from '../src/web/routes/recovery-routes.js';
import { createRouteTestHarness } from './routes/_route-test-utils.js';
import { safeRmHomeTree, createDeferred } from './mocks/index.js';

const NOW = Date.UTC(2026, 9, 13, 12);
const THREAD = '11111111-2222-3333-4444-555555555555';
let root: string;
let path: string;

beforeEach(async () => {
  root = await fs.mkdtemp(join(homedir(), 'codex-recovery-store-'));
  path = join(root, 'private', 'recovery.json');
});

afterEach(() => safeRmHomeTree(root));

function savedState(patch: Partial<RecoveryState> = {}): RecoveryState {
  const initial = initialRecoveryState();
  return {
    ...initial,
    ...patch,
    config: { ...initial.config, enabled: true, ...patch.config },
    conversationId: THREAD,
    armedAt: NOW - 1000,
  };
}

async function journal(data: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await fs.writeFile(path, typeof data === 'string' ? data : JSON.stringify(data));
}

describe('recovery journal durability', () => {
  it('round-trips near byte capacity and preserves the last readable snapshot after an oversized save', async () => {
    const maxBytes = 2 * 1024 * 1024;
    const large = savedState({
      handledEvidence: Array.from({ length: 32 }, (_, i) => `${i}:` + 'x'.repeat(246)),
      history: Array.from({ length: 100 }, () => ({
        at: NOW,
        kind: 'state' as const,
        reason: 'observing' as const,
        attempt: 0,
      })),
      inFlight: {
        key: 'flight',
        action: 'continue',
        conversationId: THREAD,
        startedAt: NOW,
        previousSubmissionKey: '😀'.repeat(50),
      },
    });
    const records: Record<string, RecoveryState> = {};
    const bytes = (sessions: Record<string, RecoveryState>) =>
      Buffer.byteLength(JSON.stringify({ version: 1, sessions }), 'utf8');
    let count = 0;
    while (bytes({ ...records, [`session-${count}`]: large }) <= maxBytes) records[`session-${count++}`] = large;
    expect(count).toBeLessThan(200);
    expect(bytes(records)).toBeGreaterThan(maxBytes * 0.98);
    await journal({ version: 1, sessions: records });
    const store = new RecoveryStore(path);
    expect(store.loadFailed).toBe(false);
    const updated = { ...large, attempts: 1 };
    await store.save('session-0', updated);
    const previous = await fs.readFile(path, 'utf8');
    expect(new RecoveryStore(path).get('session-0')).toEqual(updated);
    expect(bytes({ ...records, extra: large })).toBeGreaterThan(maxBytes);
    await expect(store.save('extra', large)).rejects.toThrow(/byte capacity/);
    expect(await fs.readFile(path, 'utf8')).toBe(previous);
    expect(store.get('extra')).toEqual(initialRecoveryState());
    const reloaded = new RecoveryStore(path);
    expect(reloaded.loadFailed).toBe(false);
    expect(reloaded.get('session-0')).toEqual(updated);
    expect(Object.keys(JSON.parse(previous).sessions)).toHaveLength(count);
    await store.drop(`session-${count - 1}`);
    await store.save('extra', large);
    expect(new RecoveryStore(path).get('extra')).toEqual(large);
  });
  it('preserves the exact stall progress baseline across reservation and accepted-cycle reloads', async () => {
    const store = new RecoveryStore(path);
    const reserved = savedState({
      inFlight: {
        key: 'same-turn',
        action: 'restart',
        conversationId: THREAD,
        startedAt: NOW,
        reason: 'stalled',
        stallProgressAt: NOW - 20_000,
      },
    });
    await store.save('worker', reserved);
    expect(new RecoveryStore(path).get('worker').inFlight).toEqual(reserved.inFlight);
    const accepted = {
      ...reserved,
      inFlight: undefined,
      handledEvidence: ['stall:' + 'a'.repeat(64) + ':' + (NOW - 20_000)],
    };
    await store.save('worker', accepted);
    expect(new RecoveryStore(path).get('worker').handledEvidence).toEqual(accepted.handledEvidence);
    expect(() =>
      store.save('worker', {
        ...reserved,
        inFlight: { ...reserved.inFlight!, stallProgressAt: Number.MAX_SAFE_INTEGER + 1 },
      })
    ).toThrow();
    expect(new RecoveryStore(path).get('worker')).toEqual(accepted);
  });

  it('durably retains a qualified stalled acceptance until its exact shared reservation can be released', async () => {
    const store = new RecoveryStore(path);
    const state = savedState({
      attempts: 1,
      inFlight: {
        key: 'same-turn',
        action: 'restart',
        conversationId: THREAD,
        startedAt: NOW - 1000,
        reason: 'stalled',
        stallProgressAt: NOW - 20_000,
      },
      stallAlert: { key: 'same-turn', conversationId: THREAD, progressAt: NOW - 20_000 },
      needsAttention: true,
    });
    await store.save('worker', state);
    let observation: RecoveryObservation = {
      activity: 'working',
      reason: 'turn-running',
      conversationId: THREAD,
      at: NOW - 20_000,
      processReady: true,
      processReadyAt: NOW,
      safeToAct: false,
    };
    const acceptReservation = vi.fn(async (_key: string) => false);
    const act = vi.fn(async () => 'sent' as const);
    const deps = {
      observe: async () => observation,
      persist: (next: RecoveryState) => store.save('worker', next),
      changed: () => {},
      act,
      acceptReservation,
      now: () => NOW,
    };
    const controller = new RecoveryController(deps, state);
    let restored: RecoveryController | undefined;
    try {
      await controller.inspect();
      const accepted = new RecoveryStore(path).get('worker');
      const handledKey = `stall:${createHash('sha256').update('same-turn').digest('hex')}:${NOW - 20_000}`;
      expect(accepted).toMatchObject({
        attempts: 1,
        lastSuccessfulRecovery: NOW,
        needsAttention: false,
        inFlight: { key: 'same-turn', accepted: true, acceptedAt: NOW, stallProgressAt: NOW - 20_000 },
        handledEvidence: [handledKey],
      });
      expect(accepted.stallAlert).toBeUndefined();
      expect(acceptReservation).toHaveBeenCalledExactlyOnceWith('same-turn');
      const previous = await fs.readFile(path, 'utf8');
      for (const incomplete of [
        { ...accepted, handledEvidence: ['same-turn'] },
        { ...accepted, handledEvidence: [handledKey.replace(String(NOW - 20_000), String(NOW - 19_000))] },
        { ...accepted, inFlight: { ...accepted.inFlight!, acceptedAt: undefined } },
        { ...accepted, inFlight: { ...accepted.inFlight!, stallProgressAt: undefined } },
        {
          ...accepted,
          handledEvidence: ['same-turn'],
          inFlight: { ...accepted.inFlight!, stallProgressAt: undefined },
        },
      ]) {
        expect(() => store.save('worker', incomplete)).toThrow();
        expect(await fs.readFile(path, 'utf8')).toBe(previous);
      }
      controller.stop();
      observation = { activity: 'unknown', reason: 'identity-unverified', at: NOW, safeToAct: false };
      acceptReservation.mockResolvedValue(true);
      restored = new RecoveryController(deps, accepted);
      await restored.inspect();
      expect(acceptReservation).toHaveBeenLastCalledWith('same-turn');
      const settled = new RecoveryStore(path).get('worker');
      expect(settled.inFlight).toBeUndefined();
      expect(settled.handledEvidence).toEqual([handledKey]);
      expect(settled.attempts).toBe(1);
      expect(settled.conversationId).toBe(THREAD);
      expect(act).not.toHaveBeenCalled();
    } finally {
      controller.stop();
      restored?.stop();
    }
  });

  it('starts disabled without a journal and does not create files during reads', async () => {
    const store = new RecoveryStore(path);
    expect(store.loadFailed).toBe(false);
    expect(store.get('missing')).toEqual(initialRecoveryState());
    await expect(fs.stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores persisted settings, a retry reservation and circuit/window state', async () => {
    const store = new RecoveryStore(path);
    const reserved = savedState({
      attempts: 2,
      failedAttempts: 1,
      windowStartedAt: NOW - 500,
      lastSuccessfulRecovery: NOW - 100,
      nextRetryAt: NOW + 3000,
      phase: 'recovering',
      inFlight: {
        key: 'stall-turn-2',
        action: 'restart',
        conversationId: THREAD,
        startedAt: NOW,
        reason: 'stalled',
        previousSubmissionKey: 'last-user-message',
      },
      handledEvidence: ['failure-1'],
      history: [{ at: NOW, kind: 'continue', reason: 'continuation-sent', attempt: 2 }],
    });
    reserved.config = { ...reserved.config, maxRetries: 5, detectStalls: true, recoverCrashes: false };
    const blocked = savedState({
      attempts: 3,
      failedAttempts: 3,
      windowStartedAt: NOW - 10_000,
      phase: 'failed',
      circuitOpen: true,
      needsAttention: true,
      lastReason: 'retries-exhausted',
    });
    await store.save('reserved', reserved);
    await store.save('blocked', blocked);
    await store.flush();
    const restored = new RecoveryStore(path);
    expect(restored.loadFailed).toBe(false);
    expect(restored.get('reserved')).toEqual(reserved);
    expect(restored.get('blocked')).toEqual(blocked);
  });

  it.each<RecoveryReason>([
    'transport-unreachable',
    'transport-unavailable',
    'remote-inspector-unavailable',
    'remote-session-missing',
  ])('round trips the remote recovery reason %s', async (reason) => {
    const store = new RecoveryStore(path);
    const state = savedState({
      lastReason: reason,
      history: [{ at: NOW, kind: 'state', reason, attempt: 0 }],
    });
    await store.save('remote', state);
    await store.flush();
    expect(new RecoveryStore(path).get('remote')).toEqual(state);
  });

  it('persists an explicit missing-remote restore reservation with a store-safe key', async () => {
    const store = new RecoveryStore(path);
    const controller = new RecoveryController({
      observe: async () => ({
        activity: 'unknown',
        reason: 'remote-session-missing',
        at: NOW,
        conversationId: THREAD,
        safeToAct: false,
      }),
      act: async () => 'not-sent',
      restoreMissingRemote: async () => 'sent',
      persist: (state) => store.save('remote-restore', state),
      changed: () => {},
      now: () => NOW,
    });
    try {
      await controller.restoreMissingRemote();
      await store.flush();
      expect(new RecoveryStore(path).get('remote-restore').inFlight?.key).toBe(`${THREAD}:remote-restore:${NOW}`);
    } finally {
      controller.stop();
    }
  });

  it('publishes only complete old or new JSON snapshots during replacement', async () => {
    const store = new RecoveryStore(path);
    const old = savedState({ attempts: 1, windowStartedAt: NOW });
    await store.save('work', old);
    const previous = await fs.readFile(path, 'utf8');
    const next = savedState({ attempts: 2, windowStartedAt: NOW });
    const saving = store.save('work', next);
    const samples = await Promise.all(Array.from({ length: 16 }, () => fs.readFile(path, 'utf8')));
    await saving;
    const current = await fs.readFile(path, 'utf8');
    expect(current).not.toBe(previous);
    for (const sample of samples) {
      expect([previous, current]).toContain(sample);
      expect(JSON.parse(sample).version).toBe(1);
    }
    expect(new RecoveryStore(path).get('work')).toEqual(next);
    expect(await fs.readdir(dirname(path))).toEqual(['recovery.json']);
  });

  it('uses restrictive directory/file permissions and replaces a broadly-readable journal safely', async () => {
    const store = new RecoveryStore(path);
    await store.save('work', savedState());
    expect((await fs.stat(dirname(path))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    await fs.chmod(path, 0o644);
    await store.save('work', savedState({ attempts: 1 }));
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
  });

  it('serializes independent session saves without dropping siblings', async () => {
    const store = new RecoveryStore(path);
    const states = Array.from({ length: 12 }, (_, i) =>
      savedState({ attempts: i % 3, lastSuccessfulRecovery: NOW + i })
    );
    await Promise.all(states.map((state, i) => store.save(`session-${i}`, state)));
    await store.flush();
    const restored = new RecoveryStore(path);
    states.forEach((state, i) => expect(restored.get(`session-${i}`)).toEqual(state));
    expect(Object.keys(JSON.parse(await fs.readFile(path, 'utf8')).sessions)).toHaveLength(12);
  });

  it('snapshots queued saves and returns copies rather than mutable journal records', async () => {
    const store = new RecoveryStore(path);
    const state = savedState();
    const expected = structuredClone(state);
    const saving = store.save('work', state);
    state.config.enabled = false;
    state.history.push({ at: NOW, kind: 'reset', reason: 'manual-reset', attempt: 0 });
    await saving;
    const returned = store.get('work');
    returned.config.enabled = false;
    returned.handledEvidence.push('caller-mutation');
    expect(store.get('work')).toEqual(expected);
    expect(new RecoveryStore(path).get('work')).toEqual(expected);
  });

  it('keeps the last durable state after a failed save and allows later writes', async () => {
    const store = new RecoveryStore(path);
    const old = savedState({ attempts: 1 });
    await store.save('work', old);
    const dir = dirname(path);
    const held = join(root, 'held');
    await fs.rename(dir, held);
    await fs.writeFile(dir, 'a file blocks the journal directory');
    await expect(store.save('work', savedState({ attempts: 2 }))).rejects.toThrow();
    expect(store.get('work')).toEqual(old);
    expect(new RecoveryStore(join(held, 'recovery.json')).get('work')).toEqual(old);
    await fs.unlink(dir);
    await fs.rename(held, dir);
    const recovered = savedState({ attempts: 3 });
    await store.save('work', recovered);
    expect(new RecoveryStore(path).get('work')).toEqual(recovered);
    expect(await fs.readdir(dir)).toEqual(['recovery.json']);
  });

  it('drops cleaned-up sessions durably while queued sibling writes survive', async () => {
    const store = new RecoveryStore(path);
    await store.save('gone', savedState({ attempts: 1 }));
    await store.save('kept', savedState({ attempts: 2 }));
    const keep = savedState({ attempts: 3 });
    await Promise.all([store.drop('gone'), store.save('kept', keep)]);
    const restored = new RecoveryStore(path);
    expect(restored.get('gone')).toEqual(initialRecoveryState());
    expect(restored.get('kept')).toEqual(keep);
    const before = await fs.readFile(path, 'utf8');
    await store.drop('already-missing');
    expect(await fs.readFile(path, 'utf8')).toBe(before);
  });

  it('persists input cancellation before restart can restore a scheduled action', async () => {
    let now = NOW;
    const store = new RecoveryStore(path);
    const state = savedState();
    state.config.retryDelayMs = 1000;
    state.config.maxRetryDelayMs = 4000;
    const observation = {
      activity: 'interrupted' as const,
      reason: 'turn-failed' as const,
      at: NOW,
      conversationId: THREAD,
      evidenceKey: 'failure-1',
      submissionKey: 'original-user-message',
      safeToAct: true,
    };
    const act = vi.fn(async () => 'sent' as const);
    const controller = new RecoveryController(
      {
        observe: async () => observation,
        act,
        persist: (next) => store.save('work', next),
        changed: () => {},
        now: () => now,
      },
      state
    );
    await controller.refresh();
    now += 2000;
    await controller.refresh();
    expect(controller.getStatus().pending).toBeDefined();

    controller.noteUserInput();
    expect(controller.getStatus().pending).toBeUndefined();
    await controller.drain();
    controller.stop();
    await store.flush();

    const restoredStore = new RecoveryStore(path);
    const restoredState = restoredStore.get('work');
    expect(restoredState.pending).toBeUndefined();
    expect(restoredState.nextRetryAt).toBeUndefined();
    expect(restoredState.armedAt).toBe(now);
    expect(restoredState.lastReason).toBe('user-input');
    const restarted = new RecoveryController(
      {
        observe: async () => observation,
        act,
        persist: (next) => restoredStore.save('work', next),
        changed: () => {},
        now: () => now,
      },
      restoredState
    );
    await restarted.refresh();
    restarted.stop();
    expect(act).not.toHaveBeenCalled();
  });

  it.each(['unchanged', 'progress', 'dead-pane'] as const)(
    'loads an actual parent-version stalled warning and preserves its warning-only authority for %s',
    async (nextEvidence) => {
      let now = NOW;
      const observation = {
        activity: 'working' as const,
        reason: 'turn-running' as const,
        at: NOW - 20_000,
        progressAt: NOW - 20_000,
        conversationId: THREAD,
        stallEvidenceKey: 'parent-v1-turn',
        stallRestartable: false,
        safeToAct: false,
      };
      const state = savedState({
        activity: 'working',
        phase: 'paused',
        needsAttention: true,
        lastReason: 'stalled',
        attempts: 1,
        failedAttempts: 1,
        windowStartedAt: NOW - 1000,
        history: [{ at: NOW, kind: 'attention', reason: 'stalled', attempt: 1 }],
      });
      state.config.detectStalls = true;
      state.config.stalledAfterMs = 10_000;
      // This is the complete old on-disk shape: no new stallAlert field or reason.
      await journal({ version: 1, sessions: { work: state } });
      const store = new RecoveryStore(path);
      expect(store.loadFailed).toBe(false);
      expect(store.get('work')).toEqual(state);
      const act = vi.fn(async () => 'sent' as const);
      const controller = new RecoveryController(
        {
          observe: async () => observation,
          act,
          persist: (next) => store.save('work', next),
          changed: () => {},
          now: () => now,
        },
        store.get('work')
      );
      try {
        await controller.inspect();
        for (let i = 0; i < 3; i++) {
          now += 5000;
          await controller.refresh();
          expect(controller.getStatus()).toMatchObject({
            phase: 'paused',
            needsAttention: true,
            lastReason: 'stall-unverified',
            attempts: 1,
            failedAttempts: 1,
            windowStartedAt: NOW - 1000,
          });
          expect(controller.getStatus().history.filter((event) => event.kind === 'attention')).toHaveLength(1);
          expect(controller.getStatus().pending).toBeUndefined();
          expect(controller.getStatus().inFlight).toBeUndefined();
        }
        expect(act).not.toHaveBeenCalled();
        expect(new RecoveryStore(path).get('work')).toMatchObject({
          needsAttention: true,
          stallAlert: { key: 'parent-v1-turn', conversationId: THREAD, progressAt: NOW - 20_000 },
        });
        if (nextEvidence === 'progress') {
          observation.progressAt += 1000;
          await controller.inspect();
          expect(controller.getStatus().needsAttention).toBe(false);
          expect(controller.getStatus().stallAlert).toBeUndefined();
          expect(new RecoveryStore(path).get('work').needsAttention).toBe(false);
        } else if (nextEvidence === 'dead-pane') {
          observation.stallRestartable = true;
          await controller.retry();
          expect(act).not.toHaveBeenCalled();
          now += 1999;
          await controller.retry();
          expect(act).not.toHaveBeenCalled();
          now += 1;
          await controller.retry();
          expect(act).toHaveBeenCalledOnce();
          expect(controller.getStatus().attempts).toBe(2);
        }
      } finally {
        controller.stop();
      }
    }
  );

  it('preserves a saved stall warning through reconstruction, GET inspection and timer polling until progress', async () => {
    vi.useFakeTimers();
    let now = NOW;
    const act = vi.fn(async () => 'sent' as const);
    const observation = {
      activity: 'working' as const,
      reason: 'turn-running' as const,
      at: NOW - 20_000,
      progressAt: NOW - 20_000,
      conversationId: THREAD,
      stallEvidenceKey: 'unfinished-turn',
      safeToAct: false,
    };
    const store = new RecoveryStore(path);
    const state = savedState({ attempts: 1, failedAttempts: 1, windowStartedAt: NOW - 1000 });
    state.config.detectStalls = true;
    state.config.stalledAfterMs = 10_000;
    const controller = new RecoveryController(
      {
        observe: async () => observation,
        act,
        persist: (next) => store.save('work', next),
        changed: () => {},
        now: () => now,
      },
      state
    );
    let restarted: RecoveryController | undefined;
    let harness: Awaited<ReturnType<typeof createRouteTestHarness>> | undefined;
    try {
      await controller.refresh();
      now += 2000;
      await controller.refresh();
      controller.stop();
      await store.flush();
      const restoredStore = new RecoveryStore(path);
      restarted = new RecoveryController(
        {
          observe: async () => observation,
          act,
          persist: (next) => restoredStore.save('work', next),
          changed: () => {},
          now: () => now,
        },
        restoredStore.get('work')
      );
      harness = await createRouteTestHarness((app, ctx) =>
        registerRecoveryRoutes(app, { ...ctx, getRecoveryController: () => restarted! })
      );
      Object.assign(harness.ctx._session, { mode: 'codex' });
      const response = await harness.app.inject({ method: 'GET', url: '/api/sessions/test-session-1/recovery' });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toMatchObject({
        phase: 'paused',
        needsAttention: true,
        lastReason: 'stall-unverified',
        attempts: 1,
      });
      now += 5000;
      await vi.advanceTimersByTimeAsync(5000);
      await restarted.drain();
      expect(restarted.getStatus()).toMatchObject({
        phase: 'paused',
        needsAttention: true,
        lastReason: 'stall-unverified',
        attempts: 1,
      });
      expect(restarted.getStatus().pending).toBeUndefined();
      expect(restarted.getStatus().inFlight).toBeUndefined();
      expect(act).not.toHaveBeenCalled();

      observation.progressAt += 1000; // New structured progress clears attention even when it is already old.
      await restarted.inspect();
      expect(restarted.getStatus()).toMatchObject({
        needsAttention: false,
        lastReason: 'turn-running',
        attempts: 1,
        failedAttempts: 1,
        windowStartedAt: NOW - 1000,
      });
      await restarted.refresh();
      expect(restarted.getStatus().needsAttention).toBe(false);
      expect(act).not.toHaveBeenCalled();
    } finally {
      controller.stop();
      restarted?.stop();
      if (harness) await harness.app.close();
      vi.useRealTimers();
    }
  });
});

describe('corrupt journals fail closed', () => {
  it.each(['{"version":1,"sessions":', ' '.repeat(2 * 1024 * 1024 + 1)])(
    'refuses save and drop after a failed load without replacing unknown journal bytes',
    async (bytes) => {
      await journal(bytes);
      const store = new RecoveryStore(path);
      expect(store.loadFailed).toBe(true);
      await expect(store.save('work', savedState())).rejects.toThrow(/could not be loaded/);
      await expect(store.drop('work')).rejects.toThrow(/could not be loaded/);
      expect(await fs.readFile(path, 'utf8')).toBe(bytes);
    }
  );
  it.each([
    ['truncated JSON', '{"version":1,"sessions":'],
    ['unknown document version', { version: 2, sessions: {} }],
    ['unknown document field', { version: 1, sessions: {}, command: 'arbitrary text' }],
    ['invalid session identity', { version: 1, sessions: { '../escape': savedState() } }],
    ['negative attempts', { version: 1, sessions: { bad: savedState({ attempts: -1 }) } }],
    [
      'invalid conversation identity',
      { version: 1, sessions: { bad: { ...savedState(), conversationId: 'cwd-guess' } } },
    ],
    [
      'raw diagnostic reason',
      { version: 1, sessions: { bad: { ...savedState(), lastReason: 'raw secret diagnostic' } } },
    ],
    ['unknown state field', { version: 1, sessions: { bad: { ...savedState(), transcript: 'raw sensitive text' } } }],
    ...[
      { key: 'raw private diagnostic', conversationId: THREAD, progressAt: NOW },
      { key: 'turn', conversationId: 'unverified', progressAt: NOW },
      { key: 'turn', conversationId: THREAD, progressAt: -1 },
      { key: 'turn', conversationId: THREAD, progressAt: NOW, transcript: 'raw sensitive text' },
    ].map((stallAlert) => [
      'invalid stall warning identity',
      { version: 1, sessions: { bad: { ...savedState(), stallAlert } } },
    ]),
    [
      'unknown config field',
      { version: 1, sessions: { bad: { ...savedState(), config: { ...savedState().config, command: 'arbitrary' } } } },
    ],
    ['missing config fields', { version: 1, sessions: { bad: { ...savedState(), config: { enabled: true } } } }],
    [
      'oversized history',
      {
        version: 1,
        sessions: {
          bad: savedState({
            history: Array.from({ length: 101 }, () => ({
              at: NOW,
              kind: 'state' as const,
              reason: 'observing' as const,
              attempt: 0,
            })),
          }),
        },
      },
    ],
    [
      'oversized evidence history',
      {
        version: 1,
        sessions: { bad: savedState({ handledEvidence: Array.from({ length: 33 }, (_, i) => `failure-${i}`) }) },
      },
    ],
    [
      'over-capacity session map',
      {
        version: 1,
        sessions: Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`session-${i}`, savedState()])),
      },
    ],
    ['oversized file', ' '.repeat(2 * 1024 * 1024 + 1)],
  ])('refuses %s without enabling any session', async (_label, data) => {
    await journal(data);
    const store = new RecoveryStore(path);
    expect(store.loadFailed).toBe(true);
    expect(store.get('bad')).toMatchObject({
      config: { enabled: false },
      circuitOpen: true,
      needsAttention: true,
      phase: 'blocked',
      lastReason: 'persistence-failed',
    });
    expect(store.get('bad').inFlight).toBeUndefined();
  });

  it('does not salvage enabled siblings from a partially invalid document', async () => {
    await journal({ version: 1, sessions: { good: savedState(), bad: { ...savedState(), attempts: -1 } } });
    const store = new RecoveryStore(path);
    expect(store.get('good').config.enabled).toBe(false);
    expect(store.get('good').circuitOpen).toBe(true);
  });

  it('refuses a symlinked journal without following or changing its target', async () => {
    const target = join(root, 'another-journal.json');
    const bytes = JSON.stringify({ version: 1, sessions: { work: savedState() } });
    await fs.writeFile(target, bytes);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.symlink(target, path);
    const store = new RecoveryStore(path);
    expect(store.loadFailed).toBe(true);
    expect(store.get('work').config.enabled).toBe(false);
    expect(await fs.readFile(target, 'utf8')).toBe(bytes);
  });

  it('refuses a directory at the journal path', async () => {
    await fs.mkdir(path, { recursive: true });
    const store = new RecoveryStore(path);
    expect(store.loadFailed).toBe(true);
    expect(store.get('work').config.enabled).toBe(false);
  });
});

it('does not acknowledge a recovery reservation until its directory rename is synced', async () => {
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  const probe = await fs.open(join(root, 'handle-probe'), 'w');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalSync = prototype.sync;
  const synced = vi.spyOn(prototype, 'sync').mockImplementation(async function (this: typeof probe) {
    if ((await this.stat()).isDirectory()) {
      entered.resolve();
      await release.promise;
    }
    await originalSync.call(this);
  });
  try {
    const store = new RecoveryStore(path);
    let acknowledged = false;
    const state = savedState({
      inFlight: { key: 'durable-flight', action: 'restart', conversationId: THREAD, startedAt: NOW },
      attempts: 1,
    });
    const saving = store.save('owned-session', state).then(() => {
      acknowledged = true;
    });
    await entered.promise;
    expect(acknowledged).toBe(false);
    expect(store.get('owned-session').inFlight).toBeUndefined();
    release.resolve();
    await saving;
    expect(acknowledged).toBe(true);
    expect(new RecoveryStore(path).get('owned-session').inFlight).toEqual(state.inFlight);
  } finally {
    release.resolve();
    synced.mockRestore();
  }
});
