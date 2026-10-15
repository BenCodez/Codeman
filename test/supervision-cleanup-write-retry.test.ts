/** Successful full journal acknowledgement can restore cleanup; no-op/failure cannot. */
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { TaskStore } from '../src/supervision/store.js';
import { initialTaskState } from '../src/supervision/schema.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
it.each(['save', 'drop', 'prune'] as const)(
  'restores only an acknowledged cleanup snapshot after failed %s',
  async (operation) => {
    const root = await fs.mkdtemp(join(homedir(), 'supervision-cleanup-retry-'));
    roots.push(root);
    const path = join(root, 'journal.json');
    const store = new TaskStore(path);
    const state = (_id: string) => initialTaskState();
    await store.save('keep-worker', state('keep-worker'));
    await store.save('drop-worker', state('drop-worker'));
    const apply = () =>
      operation === 'save'
        ? store.save('new-worker', state('new-worker'))
        : operation === 'drop'
          ? store.drop('drop-worker')
          : store.pruneOrphans((id) => id === 'keep-worker');
    const previous = await fs.readFile(path, 'utf8');
    Reflect.set(store, 'path', join(path, 'blocked'));
    try {
      await expect(apply()).rejects.toThrow();
    } finally {
      Reflect.set(store, 'path', path);
    }
    expect(store.getBrokerCleanupState()).toBeUndefined();
    expect(await fs.readFile(path, 'utf8')).toBe(previous);
    await store.drop('missing-worker');
    await store.pruneOrphans(() => true);
    expect(store.getBrokerCleanupState()).toBeUndefined();
    await apply();
    expect(store.getBrokerCleanupState()).toEqual(new TaskStore(path).getBrokerCleanupState());
    expect(store.getBrokerCleanupState()?.['keep-worker']).toEqual(state('keep-worker'));
  }
);
