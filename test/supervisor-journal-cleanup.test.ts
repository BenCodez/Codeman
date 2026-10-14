/** @fileoverview Supervisor journal failures are scoped to Codex session cleanup. */
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { Session } from '../src/session.js';
import { subagentWatcher } from '../src/subagent-watcher.js';
import { SupervisorStore } from '../src/supervisor/store.js';
import { initialSupervisorState } from '../src/supervisor/schema.js';
import { TaskStore } from '../src/supervision/store.js';
import { initialTaskState } from '../src/supervision/schema.js';
import { RecoveryStore } from '../src/recovery/store.js';
import { initialRecoveryState } from '../src/recovery/types.js';
import { StateStore } from '../src/state-store.js';
import type { SessionMode } from '../src/types/session.js';

interface CleanupInternals {
  sessions: Map<string, Session>;
  supervisorStore: SupervisorStore;
  taskStore: TaskStore;
  actionReservationStore: TaskStore;
  recoveryStore: RecoveryStore;
  store: StateStore;
  _doCleanupSession(id: string, killMux: boolean, reason: string, coordinateLayout: boolean): Promise<void>;
}

afterEach(() => vi.restoreAllMocks());

async function withJournal(
  mode: SessionMode,
  corrupt: boolean,
  check: (context: { internals: CleanupInternals; session: Session; path: string }) => Promise<void>
): Promise<void> {
  const root = await fs.mkdtemp(join(homedir(), 'supervisor-journal-cleanup-'));
  const path = join(root, 'supervisors.json');
  const id = `cleanup-domain-${mode}`;
  if (corrupt) await fs.writeFile(path, '{corrupt-journal}');
  const journal = new SupervisorStore(path);
  if (!corrupt) await journal.save(id, initialSupervisorState(id));
  const server = new WebServer(0, false, true);
  const internals = server as unknown as CleanupInternals;
  internals.store = new StateStore(join(root, 'state.json'));
  internals.taskStore = new TaskStore(join(root, 'tasks.json'));
  internals.actionReservationStore = new TaskStore(join(root, 'actions.json'));
  internals.recoveryStore = new RecoveryStore(join(root, 'recovery.json'));
  await internals.taskStore.save(id, initialTaskState());
  await internals.actionReservationStore.save(id, initialTaskState());
  await internals.recoveryStore.save(id, initialRecoveryState());
  const session = new Session({ id, workingDir: root, mode, useMux: false });
  internals.sessions.set(id, session);
  internals.supervisorStore = journal;
  vi.spyOn(session, 'stop').mockResolvedValue();
  vi.spyOn(subagentWatcher, 'killSubagentsForSession').mockResolvedValue();
  try {
    await check({ internals, session, path });
  } finally {
    internals.sessions.delete(id);
    await server.stop();
    internals.store.flushAll();
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe('domain-scoped supervisor cleanup', () => {
  it.each(['claude', 'shell'] as const)('deletes unrelated %s while preserving a corrupt journal', async (mode) => {
    await withJournal(mode, true, async ({ internals, session, path }) => {
      expect(internals.supervisorStore.loadFailed).toBe(true);
      const drop = vi.spyOn(internals.supervisorStore, 'drop');
      await internals._doCleanupSession(session.id, true, 'fixture deletion', false);
      expect(session.stop).toHaveBeenCalledWith(true);
      expect(internals.sessions.has(session.id)).toBe(false);
      expect(drop).not.toHaveBeenCalled();
      expect(await fs.readFile(path, 'utf8')).toBe('{corrupt-journal}');
    });
  });

  it('removes a healthy supervisor journal record for a deleted Codex session', async () => {
    await withJournal('codex', false, async ({ internals, session, path }) => {
      await internals._doCleanupSession(session.id, true, 'fixture deletion', false);
      expect(session.stop).toHaveBeenCalledWith(true);
      expect(JSON.parse(await fs.readFile(path, 'utf8')).supervisors).toEqual({});
    });
  });

  it('deletes the owned session while preserving an unreadable Codex supervisor journal', async () => {
    await withJournal('codex', true, async ({ internals, session, path }) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const drops = [
        internals.supervisorStore,
        internals.taskStore,
        internals.actionReservationStore,
        internals.recoveryStore,
      ].map((journal) => vi.spyOn(journal, 'drop'));
      await expect(internals._doCleanupSession(session.id, true, 'fixture deletion', false)).resolves.toBeUndefined();
      expect(session.stop).toHaveBeenCalledWith(true);
      expect(internals.sessions.has(session.id)).toBe(false);
      for (const drop of drops) expect(drop).toHaveBeenCalledWith(session.id);
      expect(await fs.readFile(path, 'utf8')).toBe('{corrupt-journal}');
    });
  });
});
