/** @fileoverview Final manager deletion retires private schedules/memory; detach, replacement and unknown evidence veto it. */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BrainStore } from '../src/supervisor/brain.js';
import { SupervisorAutomationStore } from '../src/supervisor/automation-store.js';
import { initialSupervisorAutomationRecord } from '../src/supervisor/automation-schema.js';
import { WebServer } from '../src/web/server.js';
import { StateStore } from '../src/state-store.js';
import { SupervisorStore } from '../src/supervisor/store.js';
import { initialSupervisorState } from '../src/supervisor/schema.js';
import { TaskStore } from '../src/supervision/store.js';
import { RecoveryStore } from '../src/recovery/store.js';
import { Session } from '../src/session.js';
import { subagentWatcher } from '../src/subagent-watcher.js';
import { ownedRemoteBrokerCache } from '../src/recovery/remote-input-broker-cache.js';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const UNKNOWN = '33333333-3333-4333-8333-333333333333';
const current = () => true;
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'management-cleanup-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
async function memory(id = ID, store = new BrainStore(join(root, 'brains'))) {
  const empty = await store.read(id, current);
  const saved = await store.replace(id, 'Private owner goals', empty.revision, current);
  await store.append(id, 'remember-role', 'Keep worker roles separate.', saved.revision, current);
  return store;
}

it('reclaims deleted manager schedules before admitting the next manager at the 100-record cap', async () => {
  const path = join(root, 'automation.json');
  const managers = Object.fromEntries(
    Array.from({ length: 100 }, (_, i) => {
      const id = `retired-manager-${String(i).padStart(3, '0')}`;
      return [id, initialSupervisorAutomationRecord(id)];
    })
  );
  await fs.writeFile(path, JSON.stringify({ version: 1, managers }), { mode: 0o600 });
  const store = new SupervisorAutomationStore(path);
  await store.drop('retired-manager-000', current);
  await store.save(ID, initialSupervisorAutomationRecord(ID));
  expect(new SupervisorAutomationStore(path).ids()).toHaveLength(100);
  expect(await store.pruneOrphans((id) => id === ID)).toBe(99);
  await store.save(OTHER, initialSupervisorAutomationRecord(OTHER));
  expect(new SupervisorAutomationStore(path).ids().sort()).toEqual([ID, OTHER].sort());
});

it('keeps unresolved schedule receipts during startup pruning and refuses malformed or uncertain journal cleanup', async () => {
  const path = join(root, 'automation.json'),
    store = new SupervisorAutomationStore(path);
  await store.save(ID, initialSupervisorAutomationRecord(ID));
  const unknown = initialSupervisorAutomationRecord(UNKNOWN);
  unknown.inFlight = {
    requestId: 'unresolved-request',
    taskId: 'owner-task',
    payloadHash: 'a'.repeat(64),
    startedAt: 1000,
    phase: 'unknown',
  };
  await store.save(UNKNOWN, unknown);
  expect(await store.pruneOrphans(() => false)).toBe(1);
  expect(new SupervisorAutomationStore(path).get(UNKNOWN).inFlight).toEqual(unknown.inFlight);
  const before = await fs.readFile(path);
  Reflect.set(store, 'uncertain', true);
  await expect(store.drop(UNKNOWN, current)).rejects.toThrow(/unavailable/);
  await expect(store.pruneOrphans(() => false)).rejects.toThrow(/unavailable/);
  expect(await fs.readFile(path)).toEqual(before);
  await fs.writeFile(path, '{unreadable}');
  const broken = new SupervisorAutomationStore(path);
  await expect(broken.pruneOrphans(() => false)).rejects.toThrow(/unavailable/);
  expect(await fs.readFile(path, 'utf8')).toBe('{unreadable}');
});

it('rechecks schedule deletion ownership after storage waits and permits a certified failed cleanup retry', async () => {
  const path = join(root, 'automation.json'),
    store = new SupervisorAutomationStore(path);
  await store.save(ID, initialSupervisorAutomationRecord(ID));
  const before = await fs.readFile(path),
    open = fs.open.bind(fs);
  let allowed = true;
  const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[1] === 'wx') allowed = false;
    return handle;
  });
  await expect(store.drop(ID, () => allowed)).rejects.toThrow(/no longer current/);
  expect(await fs.readFile(path)).toEqual(before);
  spy.mockRestore();
  allowed = true;
  await store.drop(ID, () => allowed);
  expect(new SupervisorAutomationStore(path).ids()).toEqual([]);
});

it('durably drops brain content and receipts together, including idempotent retry after a lost empty-dir ACK', async () => {
  const brain = await memory(),
    path = join(root, 'brains', ID, 'brain.md');
  const remove = fsSync.rmdirSync.bind(fsSync);
  vi.spyOn(fsSync, 'rmdirSync').mockImplementationOnce(() => {
    throw Error('Fixture lost directory removal ACK');
  });
  await expect(brain.drop(ID, current)).rejects.toMatchObject({ code: 'uncertain' });
  await expect(fs.lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  vi.mocked(fsSync.rmdirSync).mockImplementation(remove);
  await brain.drop(ID, current);
  expect((await brain.read(ID, current)).exists).toBe(false);
  await expect(fs.lstat(dirname(path))).rejects.toMatchObject({ code: 'ENOENT' });
  await brain.drop(ID, current);
});

it.each(['symlink', 'malformed', 'foreign-file'] as const)(
  'preserves %s manager memory during refused final cleanup',
  async (kind) => {
    const brain = await memory(),
      path = join(root, 'brains', ID, 'brain.md');
    if (kind === 'symlink') {
      await fs.rename(path, join(root, 'foreign-memory'));
      await fs.symlink(join(root, 'foreign-memory'), path);
    }
    if (kind === 'malformed') await fs.writeFile(path, '{unknown memory bytes}');
    if (kind === 'foreign-file') await fs.writeFile(join(dirname(path), 'unrecognized.txt'), 'Do not remove me');
    const bytes = await fs.readFile(path);
    await expect(brain.drop(ID, current)).rejects.toMatchObject({ code: 'unavailable' });
    expect(await fs.readFile(path)).toEqual(bytes);
    if (kind === 'foreign-file')
      expect(await fs.readFile(join(dirname(path), 'unrecognized.txt'), 'utf8')).toBe('Do not remove me');
  }
);

it('vetoes brain deletion when a replacement becomes owned during the directory read', async () => {
  const brain = await memory(),
    path = join(root, 'brains', ID, 'brain.md');
  const before = await fs.readFile(path),
    opendir = fs.opendir.bind(fs);
  let allowed = true;
  vi.spyOn(fs, 'opendir').mockImplementation(async (...args) => {
    const dir = await opendir(...args);
    allowed = false;
    return dir;
  });
  await expect(brain.drop(ID, () => allowed)).rejects.toMatchObject({ code: 'forbidden' });
  expect(await fs.readFile(path)).toEqual(before);
});

it('prunes only validated orphan memories while preserving live/history ownership and unknown files', async () => {
  const brain = await memory();
  await memory(OTHER, brain);
  await memory(UNKNOWN, brain);
  const unknownPath = join(root, 'brains', UNKNOWN, 'brain.md');
  await fs.writeFile(unknownPath, '{malformed}');
  expect(await brain.pruneOrphans((id) => id === ID)).toBe(1);
  expect((await brain.read(ID, current)).exists).toBe(true);
  expect((await brain.read(OTHER, current)).exists).toBe(false);
  expect(await fs.readFile(unknownPath, 'utf8')).toBe('{malformed}');
});

type Internal = {
  sessions: Map<string, Session>;
  store: StateStore;
  supervisorStore: SupervisorStore;
  taskStore: TaskStore;
  actionReservationStore: TaskStore;
  recoveryStore: RecoveryStore;
  supervisorAutomationStore: SupervisorAutomationStore;
  supervisorBrainStore: BrainStore;
  _doCleanupSession(id: string, kill: boolean, reason: string, layouts: boolean): Promise<void>;
  cleanupStaleSessions(): Promise<number>;
};
async function serverFixture(
  check: (f: {
    server: WebServer;
    internal: Internal;
    session: Session;
    stop: ReturnType<typeof vi.spyOn>;
  }) => Promise<void>
) {
  const server = new WebServer(0, false, true),
    internal = server as unknown as Internal;
  internal.store = new StateStore(join(root, 'state.json'));
  internal.supervisorStore = new SupervisorStore(join(root, 'supervisors.json'));
  internal.taskStore = new TaskStore(join(root, 'tasks.json'));
  internal.actionReservationStore = new TaskStore(join(root, 'actions.json'));
  internal.recoveryStore = new RecoveryStore(join(root, 'recovery.json'));
  internal.supervisorAutomationStore = new SupervisorAutomationStore(join(root, 'automation.json'));
  internal.supervisorBrainStore = await memory();
  await internal.supervisorAutomationStore.save(ID, initialSupervisorAutomationRecord(ID));
  await internal.supervisorStore.save(ID, initialSupervisorState(ID));
  const session = new Session({ id: ID, owner: 'fixture-owner', workingDir: root, mode: 'codex', useMux: false });
  internal.sessions.set(ID, session);
  internal.store.setSession(ID, session.toState());
  const stop = vi.spyOn(session, 'stop').mockResolvedValue();
  vi.spyOn(subagentWatcher, 'killSubagentsForSession').mockResolvedValue();
  vi.spyOn(ownedRemoteBrokerCache, 'stageFinalCleanup').mockResolvedValue();
  vi.spyOn(ownedRemoteBrokerCache, 'finishFinalCleanup').mockResolvedValue(true);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await check({ server, internal, session, stop });
  } finally {
    internal.sessions.clear();
    await server.stop();
    internal.store.flushAll();
  }
}

it('removes durable automation and brain only after actual successful final Session retirement', async () =>
  serverFixture(async ({ internal, stop }) => {
    await internal._doCleanupSession(ID, true, 'fixture final deletion', false);
    expect(stop).toHaveBeenCalledWith(true);
    expect(internal.sessions.has(ID)).toBe(false);
    expect(internal.supervisorAutomationStore.ids()).not.toContain(ID);
    expect((await internal.supervisorBrainStore.read(ID, current)).exists).toBe(false);
  }));

it('preserves schedules and brain on detach and server restart shutdown', async () =>
  serverFixture(async ({ server, internal }) => {
    await internal._doCleanupSession(ID, false, 'fixture detach', false);
    await server.stop();
    expect(internal.supervisorAutomationStore.ids()).toContain(ID);
    expect((await internal.supervisorBrainStore.read(ID, current)).exists).toBe(true);
  }));

it('preserves metadata on a failed native stop, then cleans it when deletion is retried successfully', async () =>
  serverFixture(async ({ internal, stop }) => {
    stop.mockRejectedValueOnce(Error('Fixture native stop failed'));
    await expect(internal._doCleanupSession(ID, true, 'fixture failed deletion', false)).rejects.toThrow(
      /native stop failed/
    );
    expect(internal.sessions.has(ID)).toBe(true);
    expect(internal.supervisorAutomationStore.ids()).toContain(ID);
    expect((await internal.supervisorBrainStore.read(ID, current)).exists).toBe(true);
    await internal._doCleanupSession(ID, true, 'fixture retry', false);
    expect(internal.supervisorAutomationStore.ids()).not.toContain(ID);
    expect((await internal.supervisorBrainStore.read(ID, current)).exists).toBe(false);
  }));

it('retains both metadata domains when a new Session with the same ID appears before optional cleanup', async () =>
  serverFixture(async ({ internal }) => {
    const original = internal.supervisorAutomationStore.drop.bind(internal.supervisorAutomationStore);
    const replacement = new Session({ id: ID, owner: 'new-owner', workingDir: root, mode: 'codex', useMux: false });
    vi.spyOn(internal.supervisorAutomationStore, 'drop').mockImplementation(async (...args) => {
      internal.sessions.set(ID, replacement);
      return original(...args);
    });
    await internal._doCleanupSession(ID, true, 'fixture replacement', false);
    expect(internal.sessions.get(ID)).toBe(replacement);
    expect(internal.supervisorAutomationStore.ids()).toContain(ID);
    expect((await internal.supervisorBrainStore.read(ID, current)).exists).toBe(true);
  }));

it('startup stale cleanup prunes settled orphan metadata and preserves current history and unknown flights', async () =>
  serverFixture(async ({ internal }) => {
    await internal.supervisorAutomationStore.save(OTHER, initialSupervisorAutomationRecord(OTHER));
    const unresolved = initialSupervisorAutomationRecord(UNKNOWN);
    unresolved.inFlight = {
      requestId: 'unresolved-owner-request',
      taskId: 'owner-task',
      payloadHash: 'a'.repeat(64),
      startedAt: 1000,
      phase: 'unknown',
    };
    await internal.supervisorAutomationStore.save(UNKNOWN, unresolved);
    await memory(OTHER, internal.supervisorBrainStore);
    await memory(UNKNOWN, internal.supervisorBrainStore);
    await internal.cleanupStaleSessions();
    expect(internal.supervisorAutomationStore.ids().sort()).toEqual([ID, UNKNOWN].sort());
    expect((await internal.supervisorBrainStore.read(ID, current)).exists).toBe(true);
    expect((await internal.supervisorBrainStore.read(OTHER, current)).exists).toBe(false);
    expect((await internal.supervisorBrainStore.read(UNKNOWN, current)).exists).toBe(true);
  }));
