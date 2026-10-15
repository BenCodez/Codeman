/** Real atomic fixture journals; failed/no-op/pending writes cannot certify cleanup. */
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { RecoveryStore } from '../src/recovery/store.js';
import { initialRecoveryState, type RecoveryState } from '../src/recovery/types.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(join(homedir(), 'recovery-cleanup-retry-'));
  roots.push(root);
  const path = join(root, 'recovery.json');
  const store = new RecoveryStore(path);
  const state = initialRecoveryState();
  await store.save('keep', state);
  await store.save('remove', state);
  const operation = (kind: string) =>
    kind === 'save'
      ? store.save('added', { ...state, attempts: 1 })
      : kind === 'drop'
        ? store.drop('remove')
        : store.pruneOrphans((id) => id === 'keep');
  const fail = async (kind: string) => {
    Reflect.set(store, 'path', join(path, 'blocked'));
    try {
      await expect(operation(kind)).rejects.toThrow();
    } finally {
      Reflect.set(store, 'path', path);
    }
    expect(store.getCleanupSnapshot()).toBeUndefined();
  };
  return { root, path, store, state, operation, fail };
}
it.each(
  ['save', 'drop', 'prune'].flatMap((failed) => ['save', 'drop', 'prune'].map((success) => ({ failed, success })))
)(
  'reenables a complete cleanup snapshot after failed $failed then acknowledged $success',
  async ({ failed, success }) => {
    const f = await fixture();
    const previous = await fs.readFile(f.path, 'utf8');
    await f.fail(failed);
    expect(await fs.readFile(f.path, 'utf8')).toBe(previous);
    await f.operation(success);
    const reloaded = new RecoveryStore(f.path);
    expect(reloaded.loadFailed).toBe(false);
    expect(f.store.getCleanupSnapshot()).toEqual(reloaded.getCleanupSnapshot());
    expect(f.store.getCleanupSnapshot()?.keep).toEqual(f.state);
    await f.fail('save');
    expect(f.store.getCleanupSnapshot()).toBeUndefined();
  }
);
it('does not treat no-op deletion or pruning as a durable rewrite', async () => {
  const f = await fixture();
  await f.fail('save');
  const previous = await fs.readFile(f.path, 'utf8');
  await f.store.drop('missing');
  await f.store.pruneOrphans(() => true);
  expect(f.store.getCleanupSnapshot()).toBeUndefined();
  expect(await fs.readFile(f.path, 'utf8')).toBe(previous);
  await f.store.save('keep', f.state);
  expect(f.store.getCleanupSnapshot()).toEqual(new RecoveryStore(f.path).getCleanupSnapshot());
});
it('keeps cleanup unknown until all queued rewrites finish, including a later failed write', async () => {
  const f = await fixture();
  await f.fail('save');
  const held = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const internals = f.store as unknown as { write(records: Record<string, RecoveryState>): Promise<void> };
  const original = internals.write.bind(f.store);
  vi.spyOn(internals, 'write')
    .mockImplementationOnce(async (records) => {
      entered.resolve();
      await held.promise;
      await original(records);
    })
    .mockRejectedValueOnce(new Error('Fixture next queued write failed'));
  const first = f.store.save('keep', f.state);
  const next = f.store.save('added', f.state);
  const rejected = expect(next).rejects.toThrow('next queued write');
  await entered.promise;
  expect(f.store.getCleanupSnapshot()).toBeUndefined();
  held.resolve();
  await first;
  await rejected;
  expect(f.store.getCleanupSnapshot()).toBeUndefined();
  await f.store.save('keep', f.state);
  expect(f.store.getCleanupSnapshot()).toEqual(new RecoveryStore(f.path).getCleanupSnapshot());
});
it('never clears an unreadable journal veto', async () => {
  const f = await fixture();
  await fs.writeFile(f.path, '{malformed');
  const broken = new RecoveryStore(f.path);
  expect(broken.loadFailed).toBe(true);
  await expect(broken.save('keep', f.state)).rejects.toThrow();
  await expect(broken.drop('keep')).rejects.toThrow();
  await expect(broken.pruneOrphans(() => false)).rejects.toThrow();
  expect(broken.getCleanupSnapshot()).toBeUndefined();
  expect(await fs.readFile(f.path, 'utf8')).toBe('{malformed');
});
