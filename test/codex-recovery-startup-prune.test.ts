/** Startup reconciliation uses real isolated journals/state; no panes or CLI effects. */
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { Session } from '../src/session.js';
import { StateStore } from '../src/state-store.js';
import { RecoveryStore } from '../src/recovery/store.js';
import { initialRecoveryState, type RecoveryState } from '../src/recovery/types.js';
import { rebootRestoreRegistry } from '../src/web/reboot-restore-registry.js';

const THREAD = '11111111-2222-3333-4444-555555555555';
interface StartupInternals {
  sessions: Map<string, Session>;
  store: StateStore;
  recoveryStore: RecoveryStore;
  recoveryControllers: Map<string, unknown>;
  tabLayouts: { runStaleSessionCleanup: (...args: unknown[]) => Promise<unknown> };
  cleanupStaleSessions(): Promise<number>;
  finalizeRestoredState(restored: boolean): Promise<void>;
}

afterEach(() => {
  rebootRestoreRegistry.reset();
  vi.restoreAllMocks();
});

async function withStartup(
  records: Record<string, RecoveryState> | string,
  check: (f: {
    root: string;
    path: string;
    server: WebServer;
    internals: StartupInternals;
    store: StateStore;
    journal: RecoveryStore;
    add: (id: string, mode?: 'codex' | 'claude' | 'shell') => Session;
  }) => Promise<void>
): Promise<void> {
  const root = await fs.mkdtemp(join(homedir(), 'codex-startup-prune-'));
  const path = join(root, 'recovery.json');
  await fs.writeFile(path, typeof records === 'string' ? records : JSON.stringify({ version: 1, sessions: records }));
  const journal = new RecoveryStore(path);
  const store = new StateStore(join(root, 'state.json'));
  const server = new WebServer(0, false, true);
  const internals = server as unknown as StartupInternals;
  internals.store = store;
  internals.recoveryStore = journal;
  // Layout restoration is certified by this fixture; real StateStore decides
  // which absent rows are removable, including pinned historical records.
  internals.tabLayouts = {
    runStaleSessionCleanup: vi.fn(async (_active, action) =>
      (action as (ids: Set<string>) => unknown)(new Set(Object.keys(store.getSessions())))
    ),
  };
  const add = (id: string, mode: 'codex' | 'claude' | 'shell' = 'codex') => {
    const session = new Session({ id, workingDir: root, mode, useMux: false });
    vi.spyOn(session, 'stop').mockResolvedValue();
    return session;
  };
  try {
    await check({ root, path, server, internals, store, journal, add });
  } finally {
    internals.sessions.clear();
    internals.recoveryControllers.clear();
    await server.stop();
    store.flushAll();
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe('Codex recovery journal startup pruning', () => {
  it('reclaims the full 200-record journal, including rows left by earlier boots', async () => {
    const records = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`orphan-${i}`, initialRecoveryState()]));
    await withStartup(records, async ({ path, internals, store, journal, add }) => {
      const stale = add('orphan-0');
      store.setSession(stale.id, stale.toState());
      await expect(journal.save('new-session', initialRecoveryState())).rejects.toThrow(/capacity/);
      expect(await internals.cleanupStaleSessions()).toBe(1);
      expect(store.getSession(stale.id)).toBeNull();
      expect(JSON.parse(await fs.readFile(path, 'utf8')).sessions).toEqual({});
      await journal.save('new-session', initialRecoveryState());
      expect(new RecoveryStore(path).get('new-session')).toEqual(initialRecoveryState());
      expect(Object.keys(JSON.parse(await fs.readFile(path, 'utf8')).sessions)).toEqual(['new-session']);
    });
  });

  it('reclaims unreachable records near the journal byte limit', async () => {
    const large: RecoveryState = {
      ...initialRecoveryState(),
      handledEvidence: Array.from({ length: 32 }, (_, i) => `${i}:` + 'x'.repeat(246)),
      history: Array.from({ length: 100 }, () => ({
        at: Date.now(),
        kind: 'state' as const,
        reason: 'observing' as const,
        attempt: 0,
      })),
    };
    const records: Record<string, RecoveryState> = {};
    const bytes = (sessions: Record<string, RecoveryState>) =>
      Buffer.byteLength(JSON.stringify({ version: 1, sessions }), 'utf8');
    for (let i = 0; bytes({ ...records, [`orphan-${i}`]: large }) <= 2 * 1024 * 1024; i++)
      records[`orphan-${i}`] = large;
    expect(Object.keys(records).length).toBeLessThan(200);
    expect(bytes(records)).toBeGreaterThan(2 * 1024 * 1024 * 0.98);
    await withStartup(records, async ({ internals, journal, path }) => {
      await expect(journal.save('new-session', large)).rejects.toThrow(/byte capacity/);
      await internals.cleanupStaleSessions();
      await journal.save('new-session', large);
      expect(Object.keys(JSON.parse(await fs.readFile(path, 'utf8')).sessions)).toEqual(['new-session']);
      expect(new RecoveryStore(path).get('new-session')).toEqual(large);
    });
  });

  it('retains active sessions of every mode, historical rows, and offered/taken restores', async () => {
    const ids = ['active-codex', 'active-claude', 'active-shell', 'pinned', 'offered', 'taken', 'controller', 'orphan'];
    await withStartup(Object.fromEntries(ids.map((id) => [id, initialRecoveryState()])), async (f) => {
      for (const mode of ['codex', 'claude', 'shell'] as const) {
        const session = f.add(`active-${mode}`, mode);
        f.internals.sessions.set(session.id, session);
      }
      const pinned = f.add('pinned');
      f.store.setSession(pinned.id, { ...pinned.toState(), pinned: true });
      const entries = ['offered', 'taken'].map((sessionId) => {
        const session = f.add(sessionId);
        return {
          sessionId,
          workingDir: f.root,
          mode: 'codex',
          resumeConversationId: THREAD,
          state: session.toState(),
        };
      });
      rebootRestoreRegistry.set(entries);
      rebootRestoreRegistry.take(() => true, ['taken'], undefined);
      expect(rebootRestoreRegistry.list(() => true).map((entry) => entry.sessionId)).toEqual(['offered']);
      f.internals.recoveryControllers.set('controller', {});
      await f.internals.cleanupStaleSessions();
      expect(Object.keys(JSON.parse(await fs.readFile(f.path, 'utf8')).sessions).sort()).toEqual(
        ids.filter((id) => id !== 'orphan').sort()
      );
      expect(rebootRestoreRegistry.hasOutstanding('taken')).toBe(true);
      expect(f.store.getSession('pinned')).not.toBeNull();
    });
  });

  it('retains absent durable flights while reclaiming unsent pending/retry intentions and ordinary settings', async () => {
    const flight = { key: 'proof', action: 'restart' as const, conversationId: THREAD, startedAt: Date.now() };
    const pending = { key: 'proof', action: 'continue' as const, conversationId: THREAD };
    const records = {
      flight: { ...initialRecoveryState(), inFlight: flight },
      pending: { ...initialRecoveryState(), pending },
      retry: { ...initialRecoveryState(), nextRetryAt: Date.now() + 1000 },
      settings: initialRecoveryState(),
    };
    await withStartup(records, async ({ path, internals }) => {
      await internals.cleanupStaleSessions();
      const remaining = JSON.parse(await fs.readFile(path, 'utf8')).sessions;
      expect(remaining).toEqual({ flight: records.flight });
      expect(new RecoveryStore(path).loadFailed).toBe(false);
    });
  });

  it('reclaims a full orphan scheduling journal while preserving intentions belonging to retained owners', async () => {
    const pending = { key: 'proof', action: 'continue' as const, conversationId: THREAD };
    const scheduled = { ...initialRecoveryState(), pending, nextRetryAt: Date.now() + 1000 };
    const records = Object.fromEntries(Array.from({ length: 198 }, (_, i) => [`orphan-${i}`, scheduled]));
    records.live = scheduled;
    records.pinned = scheduled;
    await withStartup(records, async ({ path, internals, store, journal, add }) => {
      const live = add('live');
      internals.sessions.set(live.id, live);
      const pinned = add('pinned');
      store.setSession(pinned.id, { ...pinned.toState(), pinned: true });
      await expect(journal.save('new-session', initialRecoveryState())).rejects.toThrow(/capacity/);
      await internals.cleanupStaleSessions();
      expect(JSON.parse(await fs.readFile(path, 'utf8')).sessions).toEqual({ live: scheduled, pinned: scheduled });
      await expect(journal.save('new-session', initialRecoveryState())).resolves.toBeUndefined();
      expect(new RecoveryStore(path).get('live')).toEqual(scheduled);
      expect(new RecoveryStore(path).get('pinned')).toEqual(scheduled);
    });
  });

  it('preserves unreadable bytes without blocking unrelated stale state cleanup', async () => {
    await withStartup('{unreadable}', async ({ path, internals, journal, store, add }) => {
      const session = add('unrelated-stale', 'shell');
      store.setSession(session.id, session.toState());
      expect(journal.loadFailed).toBe(true);
      await expect(internals.cleanupStaleSessions()).resolves.toBe(1);
      expect(store.getSession(session.id)).toBeNull();
      expect(await fs.readFile(path, 'utf8')).toBe('{unreadable}');
    });
  });

  it('does not rewrite an unchanged journal', async () => {
    await withStartup({ retained: initialRecoveryState() }, async ({ path, journal }) => {
      const before = await fs.stat(path);
      expect(await journal.pruneOrphans(() => true)).toBe(0);
      expect((await fs.stat(path)).ino).toBe(before.ino);
    });
  });

  it('never prunes when mux restoration is unverified', async () => {
    await withStartup({ orphan: initialRecoveryState() }, async ({ internals, journal, path }) => {
      const before = await fs.readFile(path, 'utf8');
      const failed = vi.fn();
      Reflect.set(internals.tabLayouts, 'markRestorationFailed', failed);
      const prune = vi.spyOn(journal, 'pruneOrphans');
      await internals.finalizeRestoredState(false);
      expect(failed).toHaveBeenCalledOnce();
      expect(internals.tabLayouts.runStaleSessionCleanup).not.toHaveBeenCalled();
      expect(prune).not.toHaveBeenCalled();
      expect(await fs.readFile(path, 'utf8')).toBe(before);
    });
  });

  it('serializes pruning after a queued durable flight save', async () => {
    await withStartup({ orphan: initialRecoveryState() }, async ({ path, journal }) => {
      const saved = journal.save('reserved', {
        ...initialRecoveryState(),
        inFlight: { key: 'proof', action: 'restart', conversationId: THREAD, startedAt: Date.now() },
      });
      const pruned = journal.pruneOrphans(() => false);
      await saved;
      expect(await pruned).toBe(1);
      expect(Object.keys(JSON.parse(await fs.readFile(path, 'utf8')).sessions)).toEqual(['reserved']);
      expect(new RecoveryStore(path).get('reserved').inFlight).toBeDefined();
    });
  });

  it('preserves the readable journal when replacement cannot be committed, then permits retry', async () => {
    await withStartup({ orphan: initialRecoveryState() }, async ({ path, journal }) => {
      const before = await fs.readFile(path, 'utf8');
      // A file cannot serve as the replacement journal's parent directory.
      Reflect.set(journal, 'path', join(path, 'blocked'));
      await expect(journal.pruneOrphans(() => false)).rejects.toThrow();
      expect(await fs.readFile(path, 'utf8')).toBe(before);
      Reflect.set(journal, 'path', path);
      expect(await journal.pruneOrphans(() => false)).toBe(1);
      expect(JSON.parse(await fs.readFile(path, 'utf8')).sessions).toEqual({});
    });
  });
});
