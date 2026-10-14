/** @fileoverview Optional Codex journal failures must not prevent unrelated session deletion. */
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { Session } from '../src/session.js';
import { subagentWatcher } from '../src/subagent-watcher.js';
import { RecoveryStore } from '../src/recovery/store.js';
import { initialRecoveryState } from '../src/recovery/types.js';
import type { SessionMode } from '../src/types/session.js';

interface CleanupInternals {
  sessions: Map<string, Session>;
  recoveryStore: RecoveryStore;
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
  const session = new Session({ id, workingDir: root, mode, useMux: false });
  internals.sessions.set(id, session);
  internals.recoveryStore = journal;
  vi.spyOn(session, 'stop').mockResolvedValue();
  vi.spyOn(subagentWatcher, 'killSubagentsForSession').mockResolvedValue();
  try {
    await check({ internals, session, path });
  } finally {
    internals.sessions.delete(id);
    await server.stop();
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

  it('preserves an unreadable Codex journal and rejects its domain deletion', async () => {
    await withJournal('codex', true, async ({ internals, session, path }) => {
      await expect(internals._doCleanupSession(session.id, true, 'fixture deletion', false)).rejects.toThrow(
        'Recovery journal could not be loaded'
      );
      expect(session.stop).not.toHaveBeenCalled();
      expect(internals.sessions.get(session.id)).toBe(session);
      expect(await fs.readFile(path, 'utf8')).toBe('{corrupt-journal}');
    });
  });
});
