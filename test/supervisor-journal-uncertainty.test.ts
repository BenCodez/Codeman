/** A visible replacement with an uncertain ACK must never be overwritten from stale memory. */
import { mkdtemp, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SupervisorStore } from '../src/supervisor/store.js';
import { initialSupervisorState, type SupervisorState } from '../src/supervisor/schema.js';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: vi.fn(fs.open), rename: vi.fn(fs.rename) };
});
const roots: string[] = [];
const A = 'manager-first';
const B = 'manager-second';
const C = 'manager-third';
const W = 'owned-worker';
type Operation = 'save' | 'drop' | 'prune';
const operations: Operation[] = ['save', 'drop', 'prune'];
const faults = ['directory-open', 'directory-sync', 'directory-close', 'rename-lost-ack'] as const;
afterEach(async () => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function state(id: string): SupervisorState {
  return {
    ...initialSupervisorState(id),
    objective: 'Owner selected objective',
    enabled: true,
    phase: 'ready',
    workers: [
      {
        sessionId: W,
        task: 'Owner selected worker task',
        criteria: [{ id: 'owner-review', kind: 'manual', description: 'Owner certifies the result' }],
        assignments: 0,
        maxAssignments: 1,
        maxRuntimeMs: 60000,
      },
    ],
  };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'codeman-supervisor-uncertainty-'));
  roots.push(root);
  const path = join(root, 'supervisors.json');
  const store = new SupervisorStore(path);
  const first = state(A);
  const second = initialSupervisorState(B);
  await store.save(A, first);
  await store.save(B, second);
  const replacement: SupervisorState = {
    ...first,
    objective: 'Accepted replacement configuration',
    handledRequestIds: ['request-accepted'],
    handledRequestBindings: [{ requestId: 'request-accepted', workerId: W, action: 'assign' }],
  };
  const apply = (operation: Operation) =>
    operation === 'save'
      ? store.save(A, replacement)
      : operation === 'drop'
        ? store.drop(A)
        : store.pruneOrphans((id) => id !== A);
  return { root, path, store, first, second, replacement, apply };
}

it.each(operations.flatMap((operation) => faults.map((fault) => ({ operation, fault }))))(
  'seals queued and later mutations after $operation has a visible $fault failure',
  async ({ operation, fault }) => {
    const f = await fixture();
    const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const error = new Error('Fixture acknowledgement lost');
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fail = async () => {
      entered();
      await gate;
      throw error;
    };
    if (fault === 'rename-lost-ack') {
      vi.mocked(rename).mockImplementationOnce(async (...args) => {
        await native.rename(...args);
        await fail();
      });
    } else {
      vi.mocked(open).mockImplementation(async (...args) => {
        if (args[0] === f.root && fault === 'directory-open') await fail();
        const handle = await native.open(...args);
        if (args[0] !== f.root) return handle;
        return {
          sync: async () => {
            if (fault === 'directory-sync') await fail();
            await handle.sync();
          },
          close: async () => {
            await handle.close();
            if (fault === 'directory-close') await fail();
          },
        } as unknown as typeof handle;
      });
    }
    const pending = f.apply(operation).catch((value: unknown) => value);
    try {
      await reached;
      const published = await readFile(f.path, 'utf8');
      expect(JSON.parse(published).supervisors).toEqual({
        ...(operation === 'save' ? { [A]: f.replacement } : {}),
        [B]: f.second,
      });
      // All three mutations were admitted before the uncertain write settled.
      const queued = [
        f.store.save(C, initialSupervisorState(C)),
        f.store.drop(B),
        f.store.pruneOrphans(() => false),
      ].map((job) => job.catch((value: unknown) => value));
      release();
      expect(await pending).toBe(error);
      const results = await Promise.all(queued);
      expect(await readFile(f.path, 'utf8')).toBe(published);
      for (const result of results) expect(result).toBeInstanceOf(Error);
      expect(f.store.get(A)).toMatchObject({ enabled: false, phase: 'blocked', reason: 'persistence-failed' });
      expect(f.store.getBrokerCleanupState()).toBeUndefined();
      await expect(f.store.save(C, initialSupervisorState(C))).rejects.toThrow(/uncertain/);
      await expect(f.store.drop(B)).rejects.toThrow(/uncertain/);
      await expect(f.store.pruneOrphans(() => false)).rejects.toThrow(/uncertain/);
      await f.store.flush();
      expect(await readFile(f.path, 'utf8')).toBe(published);
      expect(await readdir(f.root)).toEqual(['supervisors.json']);

      vi.mocked(open).mockImplementation(native.open);
      vi.mocked(rename).mockImplementation(native.rename);
      const restarted = new SupervisorStore(f.path);
      expect(restarted.loadFailed).toBe(false);
      expect(restarted.all()).toEqual(Object.values(JSON.parse(published).supervisors));
      await restarted.save(C, initialSupervisorState(C));
      await restarted.drop(B);
      expect(await restarted.pruneOrphans((id) => id !== C)).toBe(1);
      expect(new SupervisorStore(f.path).all()).toEqual(operation === 'save' ? [f.replacement] : []);
    } finally {
      release();
      await pending;
    }
  }
);

it.each(operations)('allows a fresh acknowledged retry after a certified pre-rename %s failure', async (operation) => {
  const f = await fixture();
  const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const previous = await readFile(f.path, 'utf8');
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    const handle = await native.open(...args);
    return {
      writeFile: handle.writeFile.bind(handle),
      sync: async () => {
        throw new Error('Fixture temporary file sync refused');
      },
      close: handle.close.bind(handle),
    } as unknown as typeof handle;
  });
  await expect(f.apply(operation)).rejects.toThrow(/temporary file sync/);
  expect(await readFile(f.path, 'utf8')).toBe(previous);
  expect(f.store.get(A)).toEqual(f.first);
  expect(f.store.getBrokerCleanupState()).toBeUndefined();
  await f.apply(operation);
  const reloaded = new SupervisorStore(f.path);
  expect(f.store.getBrokerCleanupState()).toEqual(
    Object.fromEntries(reloaded.all().map((entry) => [entry.supervisorSessionId, entry]))
  );
  expect(reloaded.all()).toEqual(operation === 'save' ? [f.replacement, f.second] : [f.second]);
});
