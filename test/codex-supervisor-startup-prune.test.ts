/** Real startup journal reconciliation, temporary homes and no worker or manager effects. */
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { Session } from '../src/session.js';
import { StateStore } from '../src/state-store.js';
import { RecoveryStore } from '../src/recovery/store.js';
import { initialRecoveryState } from '../src/recovery/types.js';
import { TaskStore } from '../src/supervision/store.js';
import { initialTaskState } from '../src/supervision/schema.js';
import { SupervisorStore } from '../src/supervisor/store.js';
import { SupervisorController } from '../src/supervisor/controller.js';
import { initialSupervisorState, type SupervisorState } from '../src/supervisor/schema.js';
import { rebootRestoreRegistry } from '../src/web/reboot-restore-registry.js';
import type { TabLayoutService } from '../src/tab-layout-service.js';

interface StartupInternals {
  sessions: Map<string, Session>;
  store: StateStore;
  recoveryStore: RecoveryStore;
  taskStore: TaskStore;
  actionReservationStore: TaskStore;
  supervisorStore: SupervisorStore;
  supervisorControllers: Map<string, SupervisorController>;
  tabLayouts: unknown;
  cleanupStaleSessions(): Promise<number>;
}
interface StartupFixture {
  internals: StartupInternals;
  root: string;
  paths: Record<string, string>;
  layout: TabLayoutService;
  session(id: string, mode?: 'codex' | 'shell'): Session;
  rows(name: string): Promise<string[]>;
}

const WORKER = '22222222-2222-4222-8222-222222222222';
const THREAD = '11111111-2222-3333-4444-555555555555';
function manager(id: string, worker = WORKER): SupervisorState {
  return {
    ...initialSupervisorState(id),
    enabled: true,
    phase: 'paused',
    objective: 'Fixture objective',
    workers: [
      {
        sessionId: worker,
        task: 'Fixture assignment',
        criteria: [{ id: 'manual', kind: 'manual', description: 'Owner acceptance' }],
        maxAssignments: 1,
        maxRuntimeMs: 60000,
        assignments: 0,
      },
    ],
  };
}
afterEach(() => {
  rebootRestoreRegistry.reset();
  vi.restoreAllMocks();
});

async function fixture(
  supervisors: Record<string, SupervisorState> | string,
  ids: string[],
  check: (f: StartupFixture) => Promise<void>
) {
  const root = await fs.mkdtemp(join(homedir(), 'supervisor-startup-'));
  const paths = Object.fromEntries(
    ['recovery', 'tasks', 'actions', 'supervisors'].map((name) => [name, join(root, name + '.json')])
  );
  for (const name of ['recovery', 'tasks', 'actions'])
    await fs.writeFile(
      paths[name],
      JSON.stringify({
        version: 1,
        sessions: Object.fromEntries(
          ids.map((id) => [id, name === 'recovery' ? initialRecoveryState() : initialTaskState()])
        ),
      })
    );
  await fs.writeFile(
    paths.supervisors,
    typeof supervisors === 'string' ? supervisors : JSON.stringify({ version: 1, supervisors })
  );
  const server = new WebServer(0, false, true);
  const internals = server as unknown as StartupInternals;
  const layout = internals.tabLayouts as TabLayoutService;
  internals.store = new StateStore(join(root, 'state.json'));
  internals.recoveryStore = new RecoveryStore(paths.recovery);
  internals.taskStore = new TaskStore(paths.tasks);
  internals.actionReservationStore = new TaskStore(paths.actions);
  internals.supervisorStore = new SupervisorStore(paths.supervisors);
  internals.tabLayouts = {
    runStaleSessionCleanup: vi.fn(async (_active: ReadonlySet<string>, action: (ids: Set<string>) => unknown) =>
      action(new Set(Object.keys(internals.store.getSessions())))
    ),
  };
  const session = (id: string, mode: 'codex' | 'shell' = 'codex') => {
    const value = new Session({ id, mode, workingDir: root, useMux: false });
    vi.spyOn(value, 'stop').mockResolvedValue();
    return value;
  };
  try {
    await check({
      internals,
      root,
      paths,
      layout,
      session,
      rows: async (name: string) =>
        Object.keys(
          JSON.parse(await fs.readFile(paths[name], 'utf8'))[name === 'supervisors' ? name : 'sessions']
        ).sort(),
    });
  } finally {
    internals.sessions.clear();
    await server.stop();
    internals.store.flushAll();
    await fs.rm(root, { recursive: true, force: true });
  }
}

it('reclaims 100 unreachable settled manager roles without losing the live worker journal', async () => {
  const records = Object.fromEntries(
    Array.from({ length: 100 }, (_, i) => [`orphan-manager-${i}`, manager(`orphan-manager-${i}`)])
  );
  await fixture(records, [...Object.keys(records), WORKER], async ({ internals, session, rows }) => {
    internals.sessions.set(WORKER, session(WORKER));
    await expect(internals.supervisorStore.save('new-manager', initialSupervisorState('new-manager'))).rejects.toThrow(
      /capacity/
    );
    await internals.cleanupStaleSessions();
    expect(await rows('supervisors')).toEqual([]);
    for (const name of ['recovery', 'tasks', 'actions']) expect(await rows(name)).toEqual([WORKER]);
    await internals.supervisorStore.save('new-manager', initialSupervisorState('new-manager'));
    expect(await rows('supervisors')).toEqual(['new-manager']);
  });
});

it('retains pinned, offered, taken, live and uncertain manager/worker ownership across every journal', async () => {
  const names = ['pinned-manager', 'offered-manager', 'taken-manager', 'live-manager', 'uncertain-manager'];
  const uncertainWorker = '33333333-3333-4333-8333-333333333333';
  const liveWorker = '44444444-4444-4444-8444-444444444444';
  const records = Object.fromEntries(names.map((id) => [id, manager(id)]));
  records['live-manager'] = manager('live-manager', liveWorker);
  records['uncertain-manager'] = {
    ...manager('uncertain-manager', uncertainWorker),
    enabled: false,
    inFlight: { requestId: 'request-uncertain', workerId: uncertainWorker, action: 'assign', reservedAt: Date.now() },
  };
  records['pinned-manager'].handledRequestIds = ['request-accepted'];
  records['pinned-manager'].handledRequestBindings = [
    { requestId: 'request-accepted', workerId: WORKER, action: 'assign' },
  ];
  records['orphan-manager'] = manager('orphan-manager');
  const retained = [...names, WORKER, uncertainWorker, liveWorker];
  await fixture(records, [...retained, 'orphan-manager'], async ({ internals, session, root, rows }) => {
    internals.store.setSession('pinned-manager', { ...session('pinned-manager').toState(), pinned: true });
    const entries = ['offered-manager', 'taken-manager'].map((sessionId) => ({
      sessionId,
      workingDir: root,
      mode: 'codex',
      resumeConversationId: THREAD,
      state: session(sessionId).toState(),
    }));
    rebootRestoreRegistry.set(entries);
    rebootRestoreRegistry.take(() => true, ['taken-manager'], undefined);
    const controller = new SupervisorController(
      {
        validateWorkers: () => {},
        worker: () => undefined,
        persist: async () => {},
        withLeases: (fn) => fn(),
        leaseHolder: () => undefined,
        startManager: async () => true,
        hasManagerAuthority: () => true,
        prepareManagerAuthority: async () => true,
        validateManagerAuthority: async () => true,
        pauseManager: async () => {},
        resetManager: async () => {},
        changed: () => {},
      },
      'live-manager',
      { ...records['live-manager'], enabled: false, phase: 'disabled', workers: [] }
    );
    internals.supervisorControllers.set('live-manager', controller);
    await internals.cleanupStaleSessions();
    expect(await rows('supervisors')).toEqual([...names].sort());
    for (const name of ['recovery', 'tasks', 'actions']) expect(await rows(name)).toEqual([...retained].sort());
    expect(internals.supervisorStore.get('pinned-manager').handledRequestBindings).toEqual(
      records['pinned-manager'].handledRequestBindings
    );
    expect(internals.supervisorStore.get('uncertain-manager').inFlight).toEqual(records['uncertain-manager'].inFlight);
  });
});

it('preserves unknown supervisor ownership while allowing unrelated stale shell state cleanup', async () => {
  await fixture('{unreadable}', ['orphan-manager'], async ({ internals, paths, session }) => {
    const before = await Promise.all(Object.values(paths).map((path) => fs.readFile(path as string, 'utf8')));
    internals.store.setSession('unrelated-shell', session('unrelated-shell', 'shell').toState());
    expect(await internals.cleanupStaleSessions()).toBe(1);
    expect(internals.store.getSession('unrelated-shell')).toBeNull();
    expect(await Promise.all(Object.values(paths).map((path) => fs.readFile(path as string, 'utf8')))).toEqual(before);
  });
});

it('never reclaims journals after actual layout restoration fails', async () => {
  await fixture(
    { 'orphan-manager': manager('orphan-manager') },
    ['orphan-manager'],
    async ({ internals, layout, paths }) => {
      const before = await Promise.all(Object.values(paths).map((path) => fs.readFile(path as string, 'utf8')));
      layout.markRestorationFailed();
      internals.tabLayouts = layout;
      await expect(internals.cleanupStaleSessions()).rejects.toThrow(/restoration is failed/);
      expect(await Promise.all(Object.values(paths).map((path) => fs.readFile(path as string, 'utf8')))).toEqual(
        before
      );
    }
  );
});
