/** @fileoverview Optional Codex journal failures must not prevent unrelated session deletion. */
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { Session } from '../src/session.js';
import { subagentWatcher } from '../src/subagent-watcher.js';
import { RecoveryStore } from '../src/recovery/store.js';
import type { RecoveryController } from '../src/recovery/controller.js';
import { StateStore } from '../src/state-store.js';
import { initialRecoveryState } from '../src/recovery/types.js';
import type { SessionMode } from '../src/types/session.js';

interface CleanupInternals {
  sessions: Map<string, Session>;
  recoveryStore: RecoveryStore;
  store: StateStore;
  recoveryControllers: Map<string, Pick<RecoveryController, 'stop' | 'drain'>>;
  getRecoveryController(session: Session): RecoveryController | undefined;
  cleanupSession(id: string, killMux: boolean, reason: string): Promise<void>;
  _doCleanupSession(id: string, killMux: boolean, reason: string, coordinateLayout: boolean): Promise<void>;
}

afterEach(() => vi.restoreAllMocks());

async function withJournal(
  mode: SessionMode,
  corrupt: boolean,
  check: (context: { internals: CleanupInternals; session: Session; path: string }) => Promise<void>
): Promise<void> {
  const root = await fs.mkdtemp(join(homedir(), 'codex-journal-cleanup-'));
  const path = join(root, 'recovery.json');
  const id = `cleanup-domain-${mode}`;
  if (corrupt) await fs.writeFile(path, '{corrupt-journal}');
  const journal = new RecoveryStore(path);
  if (!corrupt) await journal.save(id, initialRecoveryState());
  const server = new WebServer(0, false, true);
  const internals = server as unknown as CleanupInternals;
  internals.store = new StateStore(join(root, 'state.json'));
  const session = new Session({ id, workingDir: root, mode, useMux: false });
  internals.sessions.set(id, session);
  internals.recoveryStore = journal;
  vi.spyOn(session, 'stop').mockResolvedValue();
  vi.spyOn(subagentWatcher, 'killSubagentsForSession').mockResolvedValue();
  try {
    await check({ internals, session, path });
  } finally {
    internals.sessions.delete(id);
    internals.recoveryControllers.clear();
    await server.stop();
    internals.store.flushAll();
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe('domain-scoped Codex recovery cleanup', () => {
  it.each(['claude', 'shell'] as const)(
    'deletes an unrelated %s session while retaining a corrupt journal',
    async (mode) => {
      await withJournal(mode, true, async ({ internals, session, path }) => {
        expect(internals.recoveryStore.loadFailed).toBe(true);
        const drop = vi.spyOn(internals.recoveryStore, 'drop');
        await internals._doCleanupSession(session.id, true, 'fixture deletion', false);
        expect(session.stop).toHaveBeenCalledWith(true);
        expect(internals.sessions.has(session.id)).toBe(false);
        expect(drop).not.toHaveBeenCalled();
        expect(await fs.readFile(path, 'utf8')).toBe('{corrupt-journal}');
      });
    }
  );

  it('removes a healthy Codex record when its session is deleted', async () => {
    await withJournal('codex', false, async ({ internals, session, path }) => {
      await internals._doCleanupSession(session.id, true, 'fixture deletion', false);
      expect(session.stop).toHaveBeenCalledWith(true);
      expect(internals.sessions.has(session.id)).toBe(false);
      expect(JSON.parse(await fs.readFile(path, 'utf8')).sessions).toEqual({});
    });
  });

  it('deletes an owned Codex session while preserving its unreadable journal', async () => {
    await withJournal('codex', true, async ({ internals, session, path }) => {
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await expect(internals._doCleanupSession(session.id, true, 'fixture deletion', false)).resolves.toBeUndefined();
      expect(session.stop).toHaveBeenCalledWith(true);
      expect(internals.sessions.has(session.id)).toBe(false);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('Recovery journal deletion failed'));
      expect(await fs.readFile(path, 'utf8')).toBe('{corrupt-journal}');
    });
  });

  it('deletes a Codex session despite an unwritable journal without losing prior evidence or pinned history', async () => {
    await withJournal('codex', false, async ({ internals, session, path }) => {
      session.setPinned(true);
      internals.store.setSession(session.id, session.toState());
      const before = await fs.readFile(path, 'utf8');
      // A file cannot serve as the parent directory of an atomic replacement.
      Reflect.set(internals.recoveryStore, 'path', join(path, 'blocked'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await expect(internals.cleanupSession(session.id, true, 'fixture deletion')).resolves.toBeUndefined();
      expect(session.stop).toHaveBeenCalledWith(true);
      expect(internals.sessions.has(session.id)).toBe(false);
      expect(internals.store.getSession(session.id)).toMatchObject({ pinned: true, status: 'stopped' });
      expect(await fs.readFile(path, 'utf8')).toBe(before);
    });
  });

  it('stops and drains recovery before attempting a failed journal deletion and refuses controller recreation', async () => {
    await withJournal('codex', true, async ({ internals, session, path }) => {
      session.setPinned(true);
      const drained = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const controller = {
        stop: vi.fn(),
        drain: vi.fn(() => {
          entered.resolve();
          return drained.promise;
        }),
      };
      internals.recoveryControllers.set(session.id, controller);
      const drop = vi.spyOn(internals.recoveryStore, 'drop');
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const deleting = internals.cleanupSession(session.id, true, 'fixture deletion');
      await entered.promise;
      try {
        expect(controller.stop).toHaveBeenCalledOnce();
        expect(drop).not.toHaveBeenCalled();
        expect(session.stop).not.toHaveBeenCalled();
        expect(internals.getRecoveryController(session)).toBeUndefined();
      } finally {
        drained.resolve();
      }
      await expect(deleting).resolves.toBeUndefined();
      expect(drop).toHaveBeenCalledWith(session.id);
      expect(internals.recoveryControllers.has(session.id)).toBe(false);
      expect(session.stop).toHaveBeenCalledWith(true);
      expect(internals.sessions.has(session.id)).toBe(false);
      expect(await fs.readFile(path, 'utf8')).toBe('{corrupt-journal}');
    });
  });

  it('retains a healthy recovery journal when its session is detached instead of deleted', async () => {
    await withJournal('codex', false, async ({ internals, session, path }) => {
      internals.store.setSession(session.id, session.toState());
      const before = await fs.readFile(path, 'utf8');
      const drop = vi.spyOn(internals.recoveryStore, 'drop');
      await internals._doCleanupSession(session.id, false, 'fixture detach', false);
      expect(session.stop).toHaveBeenCalledWith(false);
      expect(drop).not.toHaveBeenCalled();
      expect(internals.store.getSession(session.id)).not.toBeNull();
      expect(await fs.readFile(path, 'utf8')).toBe(before);
    });
  });
});
