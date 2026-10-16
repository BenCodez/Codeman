/** Cleanup snapshots use private disposable journals, never broker deletion or worker effects. */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SupervisorStore } from '../src/supervisor/store.js';
import { initialSupervisorState, type SupervisorState } from '../src/supervisor/schema.js';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, rename: vi.fn(fs.rename) };
});
afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});
const ID = 'manager-one';
const WORKER = 'worker-one';
function state() {
  return {
    ...initialSupervisorState(ID),
    objective: 'The retained manager plan',
    workers: [
      {
        sessionId: WORKER,
        task: 'Review the fix',
        criteria: [{ id: 'owner', kind: 'manual' as const, description: 'Owner acceptance' }],
        maxAssignments: 2,
        maxRuntimeMs: 60_000,
        assignments: 1,
      },
    ],
  };
}
async function fixture() {
  const root = await mkdtemp(join(homedir(), 'supervisor-cleanup-snapshot-'));
  const path = join(root, 'supervisors.json');
  const store = new SupervisorStore(path);
  await store.save(ID, state());
  return { root, path, store, cleanup: () => rm(root, { recursive: true, force: true }) };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
async function mutation(store: SupervisorStore, kind: 'save' | 'drop' | 'prune') {
  if (kind === 'save') return store.save(ID, { ...state(), objective: 'Newly committed plan' });
  if (kind === 'drop') return store.drop(ID);
  return store.pruneOrphans(() => false);
}
function holdWrite(store: SupervisorStore) {
  const original = Reflect.get(store, 'write').bind(store) as (next: Record<string, SupervisorState>) => Promise<void>;
  const entered = deferred(),
    release = deferred();
  vi.spyOn(
    store as unknown as { write(next: Record<string, SupervisorState>): Promise<void> },
    'write'
  ).mockImplementationOnce(async (next) => {
    entered.resolve();
    await release.promise;
    await original(next);
  });
  return { entered, release };
}

it('returns a complete cloned healthy domain, including settled and in-flight manager records', async () => {
  const f = await fixture();
  try {
    const pending = {
      ...state(),
      supervisorSessionId: 'manager-two',
      inFlight: { requestId: 'pending-one', workerId: WORKER, action: 'assign' as const, reservedAt: 10_000 },
    };
    await f.store.save('manager-two', pending);
    const expected = { [ID]: state(), 'manager-two': pending };
    const snapshot = f.store.getBrokerCleanupState()!;
    expect(snapshot).toEqual(expected);
    snapshot[ID].workers[0].task = 'Must not mutate the store';
    delete snapshot['manager-two'].inFlight;
    expect(f.store.getBrokerCleanupState()).toEqual(expected);
    expect(f.store.get(ID)).toEqual(state());
  } finally {
    await f.cleanup();
  }
});

it.each(['save', 'drop', 'prune'] as const)(
  'withholds a snapshot throughout a pending %s, then publishes settled records',
  async (kind) => {
    const f = await fixture();
    const barrier = holdWrite(f.store);
    const writing = mutation(f.store, kind);
    try {
      expect(f.store.getBrokerCleanupState()).toBeUndefined();
      await barrier.entered.promise;
      expect(f.store.getBrokerCleanupState()).toBeUndefined();
      expect(new SupervisorStore(f.path).get(ID)).toEqual(state());
      barrier.release.resolve();
      await writing;
      expect(f.store.getBrokerCleanupState()).toEqual(new SupervisorStore(f.path).getBrokerCleanupState());
      expect(f.store.getBrokerCleanupState()).toEqual(
        kind === 'save' ? { [ID]: { ...state(), objective: 'Newly committed plan' } } : {}
      );
    } finally {
      barrier.release.resolve();
      await writing;
      await f.cleanup();
    }
  }
);

it('withholds while a later mutation remains queued or active after its predecessor settles', async () => {
  const f = await fixture();
  const firstEntered = deferred(),
    firstRelease = deferred(),
    secondEntered = deferred(),
    secondRelease = deferred();
  const original = Reflect.get(f.store, 'write').bind(f.store) as (
    next: Record<string, SupervisorState>
  ) => Promise<void>;
  let calls = 0;
  vi.spyOn(
    f.store as unknown as { write(next: Record<string, SupervisorState>): Promise<void> },
    'write'
  ).mockImplementation(async (next) => {
    const index = calls++;
    (index ? secondEntered : firstEntered).resolve();
    await (index ? secondRelease : firstRelease).promise;
    await original(next);
  });
  const first = f.store.save(ID, { ...state(), objective: 'Queued replacement' });
  const second = f.store.drop(ID);
  try {
    await firstEntered.promise;
    expect(f.store.getBrokerCleanupState()).toBeUndefined();
    firstRelease.resolve();
    await first;
    await secondEntered.promise;
    expect(f.store.getBrokerCleanupState()).toBeUndefined();
    secondRelease.resolve();
    await second;
    expect(f.store.getBrokerCleanupState()).toEqual({});
  } finally {
    firstRelease.resolve();
    secondRelease.resolve();
    await Promise.all([first, second]);
    await f.cleanup();
  }
});

it.each(['save', 'drop', 'prune'] as const)(
  'seals cleanup and mutations after a lost %s rename acknowledgment until restart',
  async (kind) => {
    const f = await fixture();
    const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const ioError = new Error('Fixture lost rename acknowledgment');
    vi.mocked(rename).mockImplementationOnce(async (from, to) => {
      await native.rename(from, to);
      throw ioError;
    });
    try {
      await expect(mutation(f.store, kind)).rejects.toBe(ioError);
      // The pathname may contain the new state while cached ownership is stale.
      const published = await readFile(f.path, 'utf8');
      expect(f.store.get(ID)).toEqual({ ...state(), phase: 'blocked', reason: 'persistence-failed' });
      expect(new SupervisorStore(f.path).getBrokerCleanupState()).toEqual(
        kind === 'save' ? { [ID]: { ...state(), objective: 'Newly committed plan' } } : {}
      );
      expect(f.store.getBrokerCleanupState()).toBeUndefined();
      await expect(f.store.save(ID, { ...state(), objective: 'Stale rewrite' })).rejects.toThrow(/uncertain/);
      await expect(f.store.drop(ID)).rejects.toThrow(/uncertain/);
      await expect(f.store.pruneOrphans(() => false)).rejects.toThrow(/uncertain/);
      expect(await readFile(f.path, 'utf8')).toBe(published);
      const restarted = new SupervisorStore(f.path);
      await restarted.save(ID, { ...state(), objective: 'Later healthy write' });
      expect(restarted.getBrokerCleanupState()).toEqual(new SupervisorStore(f.path).getBrokerCleanupState());
      expect(new SupervisorStore(f.path).getBrokerCleanupState()?.[ID].objective).toBe('Later healthy write');
    } finally {
      await f.cleanup();
    }
  }
);

it.each(['malformed', 'identity', 'extra'] as const)(
  'withholds a complete domain when the loaded journal is %s',
  async (fault) => {
    const f = await fixture();
    try {
      const data = JSON.parse(await readFile(f.path, 'utf8'));
      if (fault === 'identity') data.supervisors[ID].supervisorSessionId = 'different-manager';
      if (fault === 'extra') data.supervisors[ID].unrecognized = true;
      const bytes = fault === 'malformed' ? '{broken' : JSON.stringify(data);
      await writeFile(f.path, bytes);
      const invalid = new SupervisorStore(f.path);
      expect(invalid.loadFailed).toBe(true);
      expect(invalid.getBrokerCleanupState()).toBeUndefined();
      await expect(invalid.save(ID, state())).rejects.toThrow();
      expect(await readFile(f.path, 'utf8')).toBe(bytes);
    } finally {
      await f.cleanup();
    }
  }
);
