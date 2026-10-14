/** @fileoverview Task and action journals belong to Codex session cleanup only. */
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { Session } from '../src/session.js';
import { subagentWatcher } from '../src/subagent-watcher.js';
import { TaskStore } from '../src/supervision/store.js';
import { initialTaskState } from '../src/supervision/schema.js';
import { RecoveryStore } from '../src/recovery/store.js';
import { initialRecoveryState } from '../src/recovery/types.js';
import { StateStore } from '../src/state-store.js';
import type { SessionMode } from '../src/types/session.js';

type JournalKey = 'taskStore' | 'actionReservationStore';
interface CleanupInternals {
  sessions: Map<string, Session>;
  taskStore: TaskStore;
  actionReservationStore: TaskStore;
  recoveryStore: RecoveryStore;
  store: StateStore;
  _doCleanupSession(id: string, killMux: boolean, reason: string, coordinateLayout: boolean): Promise<void>;
}

afterEach(() => vi.restoreAllMocks());

async function withJournals(
  mode: SessionMode,
  corruptKey: JournalKey | undefined,
  check: (context: {
    internals: CleanupInternals;
    session: Session;
    paths: Record<JournalKey, string>;
  }) => Promise<void>
): Promise<void> {
  const root = await fs.mkdtemp(join(homedir(), 'task-journal-cleanup-'));
  const paths = { taskStore: join(root, 'tasks.json'), actionReservationStore: join(root, 'actions.json') };
  const server = new WebServer(0, false, true);
  const internals = server as unknown as CleanupInternals;
  const id = `cleanup-domain-${mode}`;
  internals.store = new StateStore(join(root, 'state.json'));
  internals.recoveryStore = new RecoveryStore(join(root, 'recovery.json'));
  await internals.recoveryStore.save(id, initialRecoveryState());
  for (const key of ['taskStore', 'actionReservationStore'] as const) {
    if (key === corruptKey) await fs.writeFile(paths[key], '{corrupt-journal}');
    internals[key] = new TaskStore(paths[key]);
    if (key !== corruptKey) await internals[key].save(id, initialTaskState());
  }
  const session = new Session({ id, workingDir: root, mode, useMux: false });
  internals.sessions.set(id, session);
  vi.spyOn(session, 'stop').mockResolvedValue();
  vi.spyOn(subagentWatcher, 'killSubagentsForSession').mockResolvedValue();
  try {
    await check({ internals, session, paths });
  } finally {
    internals.sessions.delete(id);
    await server.stop();
    internals.store.flushAll();
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe('domain-scoped task journal cleanup', () => {
  it.each([
    ['claude', 'taskStore'],
    ['shell', 'taskStore'],
    ['claude', 'actionReservationStore'],
    ['shell', 'actionReservationStore'],
  ] as const)('deletes %s despite corrupt %s', async (mode, key) => {
    await withJournals(mode, key, async ({ internals, session, paths }) => {
      expect(internals[key].loadFailed).toBe(true);
      const taskDrop = vi.spyOn(internals.taskStore, 'drop');
      const actionDrop = vi.spyOn(internals.actionReservationStore, 'drop');
      await internals._doCleanupSession(session.id, true, 'fixture deletion', false);
      expect(session.stop).toHaveBeenCalledWith(true);
      expect(internals.sessions.has(session.id)).toBe(false);
      expect(taskDrop).not.toHaveBeenCalled();
      expect(actionDrop).not.toHaveBeenCalled();
      expect(await fs.readFile(paths[key], 'utf8')).toBe('{corrupt-journal}');
    });
  });

  it('removes both healthy journals for a deleted Codex session', async () => {
    await withJournals('codex', undefined, async ({ internals, session, paths }) => {
      await internals._doCleanupSession(session.id, true, 'fixture deletion', false);
      expect(session.stop).toHaveBeenCalledWith(true);
      for (const path of Object.values(paths)) expect(JSON.parse(await fs.readFile(path, 'utf8')).sessions).toEqual({});
    });
  });

  it.each(['taskStore', 'actionReservationStore'] as const)(
    'deletes the owned session while retaining unreadable Codex %s evidence',
    async (key) => {
      await withJournals('codex', key, async ({ internals, session, paths }) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const drops = [internals.taskStore, internals.actionReservationStore, internals.recoveryStore].map((journal) =>
          vi.spyOn(journal, 'drop')
        );
        await expect(internals._doCleanupSession(session.id, true, 'fixture deletion', false)).resolves.toBeUndefined();
        expect(session.stop).toHaveBeenCalledWith(true);
        expect(internals.sessions.has(session.id)).toBe(false);
        for (const drop of drops) expect(drop).toHaveBeenCalledWith(session.id);
        expect(await fs.readFile(paths[key], 'utf8')).toBe('{corrupt-journal}');
        const healthyKey = key === 'taskStore' ? 'actionReservationStore' : 'taskStore';
        expect(JSON.parse(await fs.readFile(paths[healthyKey], 'utf8')).sessions).toEqual({});
      });
    }
  );
});
