/** Certified startup cleanup of real isolated task/shared journals; no panes or agent effects. */
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { Session } from '../src/session.js';
import { StateStore } from '../src/state-store.js';
import { RecoveryStore } from '../src/recovery/store.js';
import { initialRecoveryState, type RecoveryState } from '../src/recovery/types.js';
import { TaskStore } from '../src/supervision/store.js';
import { SupervisorStore } from '../src/supervisor/store.js';
import { initialTaskState, type TaskState } from '../src/supervision/schema.js';
import { TaskController } from '../src/supervision/controller.js';
import { rebootRestoreRegistry } from '../src/web/reboot-restore-registry.js';

const THREAD = '11111111-2222-3333-4444-555555555555';
interface StartupInternals {
  sessions: Map<string, Session>;
  store: StateStore;
  recoveryStore: RecoveryStore;
  taskStore: TaskStore;
  actionReservationStore: TaskStore;
  recoveryControllers: Map<string, unknown>;
  taskControllers: Map<string, unknown>;
  actionArbiters: Map<string, unknown>;
  tabLayouts: unknown;
  cleanupStaleSessions(): Promise<number>;
}
type Journals = {
  recovery?: Record<string, RecoveryState> | string;
  tasks?: Record<string, TaskState> | string;
  actions?: Record<string, TaskState> | string;
};

afterEach(() => {
  rebootRestoreRegistry.reset();
  vi.restoreAllMocks();
});

async function withStartup(
  records: Journals,
  check: (f: {
    root: string;
    paths: Record<keyof Journals, string>;
    internals: StartupInternals;
    ids: (name: keyof Journals) => Promise<string[]>;
  }) => Promise<void>
): Promise<void> {
  const root = await fs.mkdtemp(join(homedir(), 'codex-task-startup-prune-'));
  const paths = {
    recovery: join(root, 'recovery.json'),
    tasks: join(root, 'tasks.json'),
    actions: join(root, 'actions.json'),
  };
  for (const name of ['recovery', 'tasks', 'actions'] as const)
    await fs.writeFile(
      paths[name],
      typeof records[name] === 'string' ? records[name] : JSON.stringify({ version: 1, sessions: records[name] ?? {} })
    );
  const server = new WebServer(0, false, true);
  const internals = server as unknown as StartupInternals;
  internals.store = new StateStore(join(root, 'state.json'));
  internals.recoveryStore = new RecoveryStore(paths.recovery);
  internals.taskStore = new TaskStore(paths.tasks);
  internals.actionReservationStore = new TaskStore(paths.actions);
  Reflect.set(server, 'supervisorStore', new SupervisorStore(join(root, 'supervisors.json')));
  internals.tabLayouts = {
    runStaleSessionCleanup: vi.fn(async (_active, action: (ids: Set<string>) => unknown) =>
      action(new Set(Object.keys(internals.store.getSessions())))
    ),
  };
  try {
    await check({
      root,
      paths,
      internals,
      ids: async (name) => Object.keys(JSON.parse(await fs.readFile(paths[name], 'utf8')).sessions).sort(),
    });
  } finally {
    internals.sessions.clear();
    internals.recoveryControllers.clear();
    internals.taskControllers.clear();
    internals.actionArbiters.clear();
    await server.stop();
    internals.store.flushAll();
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe('task and shared-action startup journal cleanup', () => {
  it('reclaims both full 200-record journals after vanished state rows and earlier orphaned boots', async () => {
    const records = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`orphan-${i}`, initialTaskState()]));
    await withStartup({ tasks: records, actions: records }, async ({ root, internals, ids }) => {
      const stale = new Session({ id: 'orphan-0', workingDir: root, mode: 'codex', useMux: false });
      internals.store.setSession(stale.id, stale.toState());
      for (const journal of [internals.taskStore, internals.actionReservationStore])
        await expect(journal.save('new-session', initialTaskState())).rejects.toThrow(/capacity/);
      expect(await internals.cleanupStaleSessions()).toBe(1);
      expect(await ids('tasks')).toEqual([]);
      expect(await ids('actions')).toEqual([]);
      for (const journal of [internals.taskStore, internals.actionReservationStore])
        await journal.save('new-session', initialTaskState());
      expect(await ids('tasks')).toEqual(['new-session']);
      expect(await ids('actions')).toEqual(['new-session']);
    });
  });

  it('retains every sibling journal for active objectives, vetoes, live owners and unresolved actions', async () => {
    const ownedIds = [
      'objective',
      'veto',
      'task-flight',
      'action-flight',
      'recovery-flight',
      'live-task',
      'live-arbiter',
    ];
    const allIds = [...ownedIds, 'recovery-pending', 'recovery-retry', 'orphan'];
    const tasks = Object.fromEntries(allIds.map((id) => [id, initialTaskState()]));
    tasks.objective = {
      ...initialTaskState(),
      objective: 'Finish the owner objective',
      phase: 'paused',
      outcome: 'unfinished',
      criteria: [{ id: 'manual', description: 'Owner accepts', kind: 'manual', verified: false }],
    };
    tasks.veto = { ...initialTaskState(), agentProgressVeto: true };
    tasks['task-flight'] = { ...initialTaskState(), inFlight: { key: 'task:pending', startedAt: Date.now() } };
    const actions = Object.fromEntries(allIds.map((id) => [id, initialTaskState()]));
    actions['action-flight'] = { ...initialTaskState(), inFlight: { key: 'recovery:pending', startedAt: Date.now() } };
    const recovery = Object.fromEntries(allIds.map((id) => [id, initialRecoveryState()]));
    recovery['recovery-flight'] = {
      ...initialRecoveryState(),
      inFlight: { key: 'proof', action: 'restart', conversationId: THREAD, startedAt: Date.now() },
    };
    recovery['recovery-pending'] = {
      ...initialRecoveryState(),
      pending: { key: 'proof', action: 'continue', conversationId: THREAD },
    };
    recovery['recovery-retry'] = { ...initialRecoveryState(), nextRetryAt: Date.now() + 1000 };
    await withStartup({ recovery, tasks, actions }, async ({ internals, ids }) => {
      internals.taskControllers.set('live-task', {});
      internals.actionArbiters.set('live-arbiter', {});
      await internals.cleanupStaleSessions();
      for (const name of ['recovery', 'tasks', 'actions'] as const)
        expect(await ids(name)).toEqual([...ownedIds].sort());
    });
  });

  it('reclaims an owner-certified completed objective while retaining an unverified completion claim', async () => {
    const initial = initialTaskState();
    const claimed: TaskState = {
      ...initial,
      objective: 'Claimed completion',
      phase: 'completed',
      outcome: 'completed',
      criteria: [{ id: 'manual', description: 'Owner accepts', kind: 'manual', verified: false }],
    };
    await withStartup(
      {
        recovery: { completed: initialRecoveryState(), claimed: initialRecoveryState() },
        tasks: { completed: initial, claimed },
        actions: { completed: initial, claimed: initial },
      },
      async ({ internals, ids }) => {
        const act = vi.fn(async () => 'not-sent' as const);
        const task = new TaskController({
          observe: async () => ({
            observation: { activity: 'idle', reason: 'observing', at: Date.now(), safeToAct: false },
            commands: new Map(),
          }),
          act,
          persist: (state) => internals.taskStore.save('completed', state),
          changed: () => {},
        });
        try {
          await task.update({
            objective: 'Finished objective',
            criteria: [{ id: 'manual', description: 'Owner accepts', kind: 'manual' }],
            config: { enabled: true },
          });
          await task.progress({ outcome: 'completed', verifiedCriteria: ['manual'] });
        } finally {
          task.stop();
        }
        await internals.cleanupStaleSessions();
        for (const name of ['recovery', 'tasks', 'actions'] as const) expect(await ids(name)).toEqual(['claimed']);
        expect(act).not.toHaveBeenCalled();
      }
    );
  });

  it.each(['recovery', 'tasks', 'actions'] as const)(
    'preserves all sibling ownership evidence when the %s journal cannot be read',
    async (corrupt) => {
      const records: Journals = {
        recovery: { orphan: initialRecoveryState() },
        tasks: { orphan: initialTaskState() },
        actions: { orphan: initialTaskState() },
      };
      records[corrupt] = '{unreadable}';
      await withStartup(records, async ({ root, internals, paths }) => {
        const before = await Promise.all(Object.values(paths).map((path) => fs.readFile(path, 'utf8')));
        const unrelated = new Session({ id: 'unrelated-stale', workingDir: root, mode: 'shell', useMux: false });
        internals.store.setSession(unrelated.id, unrelated.toState());
        await expect(internals.cleanupStaleSessions()).resolves.toBe(1);
        expect(internals.store.getSession(unrelated.id)).toBeNull();
        expect(await Promise.all(Object.values(paths).map((path) => fs.readFile(path, 'utf8')))).toEqual(before);
      });
    }
  );

  it('serializes a flight save before pruning and leaves unchanged bytes untouched', async () => {
    await withStartup({ tasks: { orphan: initialTaskState() } }, async ({ internals, paths, ids }) => {
      const journal = internals.taskStore;
      const saved = journal.save('reserved', {
        ...initialTaskState(),
        inFlight: { key: 'task:pending', startedAt: Date.now() },
      });
      const pruned = journal.pruneOrphans(() => false);
      await saved;
      expect(await pruned).toBe(1);
      expect(await ids('tasks')).toEqual(['reserved']);
      const before = await fs.stat(paths.tasks);
      expect(await journal.pruneOrphans(() => false)).toBe(0);
      expect((await fs.stat(paths.tasks)).ino).toBe(before.ino);
    });
  });

  it('preserves the task journal on a failed atomic replacement and permits a later retry', async () => {
    await withStartup({ tasks: { orphan: initialTaskState() } }, async ({ internals, paths, ids }) => {
      const journal = internals.taskStore;
      const before = await fs.readFile(paths.tasks, 'utf8');
      Reflect.set(journal, 'path', join(paths.tasks, 'blocked'));
      await expect(journal.pruneOrphans(() => false)).rejects.toThrow();
      expect(await fs.readFile(paths.tasks, 'utf8')).toBe(before);
      Reflect.set(journal, 'path', paths.tasks);
      expect(await journal.pruneOrphans(() => false)).toBe(1);
      expect(await ids('tasks')).toEqual([]);
    });
  });
});
