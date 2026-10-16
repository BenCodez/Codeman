/** @fileoverview Failed recovery consent/reset publication stays fail-closed across actual journal reload. */
import fs, { open, rename, unlink } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RecoveryStore } from '../src/recovery/store.js';
import { RecoveryController } from '../src/recovery/controller.js';
import { initialRecoveryState, type RecoveryState } from '../src/recovery/types.js';
import { safeRmHomeTree } from './mocks/index.js';

vi.mock('node:fs/promises', async (original) => {
  const native = await original<typeof import('node:fs/promises')>();
  return { ...native, open: vi.fn(native.open), rename: vi.fn(native.rename), unlink: vi.fn(native.unlink) };
});
vi.mock('node:fs', async (original) => {
  const native = await original<typeof import('node:fs')>();
  return { ...native, unlinkSync: vi.fn(native.unlinkSync) };
});
const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const nativeSync = await vi.importActual<typeof import('node:fs')>('node:fs');
const NOW = Date.UTC(2026, 9, 16, 12);
const THREAD = '11111111-2222-3333-4444-555555555555';
let root: string;
let path: string;

beforeEach(async () => {
  root = await fs.mkdtemp(join(homedir(), 'recovery-consent-publication-'));
  path = join(root, 'private', 'recovery.json');
});
afterEach(async () => {
  vi.mocked(open).mockImplementation(native.open);
  vi.mocked(rename).mockImplementation(native.rename);
  vi.mocked(unlink).mockImplementation(native.unlink);
  vi.mocked(unlinkSync).mockImplementation(nativeSync.unlinkSync);
  await safeRmHomeTree(root);
});

function state(enabled = false): RecoveryState {
  const initial = initialRecoveryState();
  return { ...initial, config: { ...initial.config, enabled }, conversationId: THREAD, armedAt: NOW - 1000 };
}

function controller(store: RecoveryStore, act = vi.fn(async () => 'sent' as const)) {
  return new RecoveryController(
    {
      now: () => NOW,
      observe: async () => ({
        activity: 'interrupted',
        reason: 'turn-failed',
        at: NOW,
        conversationId: THREAD,
        evidenceKey: 'failure-1',
        submissionKey: 'owner-message',
        safeToAct: true,
      }),
      act,
      persist: (next) => store.save('owned', next),
      changed: () => {},
    },
    store.get('owned')
  );
}

it.each(['enable', 'reset'] as const)(
  'does not activate rejected %s after postrename directory failure and restart',
  async (mutation) => {
    for (const fault of ['open', 'sync', 'close']) {
      const journal = join(root, fault, 'recovery.json');
      path = journal;
      const store = new RecoveryStore(journal);
      const previous = state(mutation === 'reset');
      if (mutation === 'reset') {
        previous.attempts = 3;
        previous.failedAttempts = 3;
        previous.windowStartedAt = NOW - 500;
        previous.circuitOpen = true;
        previous.lastReason = 'retries-exhausted';
      }
      await store.save('owned', previous);
      const owner = controller(store);
      let published = false;
      vi.mocked(rename).mockImplementation(async (from, to) => {
        await native.rename(from, to);
        if (to === journal) published = true;
      });
      vi.mocked(open).mockImplementation(async (name, flags, mode) => {
        const directory = published && name === dirname(journal) && flags === 'r';
        if (directory && fault === 'open') throw new Error('postrename open');
        const handle = await native.open(name, flags, mode);
        if (directory && fault === 'sync')
          handle.sync = async () => {
            throw new Error('postrename sync');
          };
        if (directory && fault === 'close') {
          const close = handle.close.bind(handle);
          handle.close = async () => {
            await close();
            throw new Error('postrename close');
          };
        }
        return handle;
      });
      try {
        await expect(mutation === 'enable' ? owner.updateConfig({ enabled: true }) : owner.reset()).rejects.toThrow(
          /could not be saved/
        );
      } finally {
        owner.stop();
        await owner.drain();
        vi.mocked(open).mockImplementation(native.open);
        vi.mocked(rename).mockImplementation(native.rename);
      }
      const visible = JSON.parse(await fs.readFile(journal, 'utf8')).sessions.owned;
      expect(visible.config.enabled).toBe(true);
      if (mutation === 'reset') expect(visible).toMatchObject({ circuitOpen: false, attempts: 0, failedAttempts: 0 });
      const restored = new RecoveryStore(journal);
      expect(restored.loadFailed).toBe(true);
      expect(restored.get('owned')).toMatchObject({
        config: { enabled: false },
        circuitOpen: true,
        needsAttention: true,
        phase: 'blocked',
        lastReason: 'persistence-failed',
      });
      const act = vi.fn(async () => 'sent' as const);
      const restarted = controller(restored, act);
      try {
        await restarted.inspect();
        await restarted.inspect();
        expect(act).not.toHaveBeenCalled();
        await expect(restarted.reset()).rejects.toThrow(/could not be saved/);
        await expect(restarted.updateConfig({ enabled: true })).rejects.toThrow(/could not be saved/);
      } finally {
        restarted.stop();
        await restarted.drain();
      }
      expect(await fs.stat(`${journal}.pending`)).toMatchObject({ mode: expect.any(Number) });
      expect((await fs.stat(`${journal}.pending`)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await fs.readFile(journal, 'utf8')).sessions.owned).toEqual(visible);
    }
  }
);

it.each(['enable', 'reset'] as const)(
  'retains acknowledged %s after a healthy complete write and restart',
  async (mutation) => {
    const store = new RecoveryStore(path);
    const previous = state(mutation === 'reset');
    if (mutation === 'reset') Object.assign(previous, { attempts: 3, failedAttempts: 3, circuitOpen: true });
    await store.save('owned', previous);
    const owner = controller(store);
    try {
      const accepted = await (mutation === 'enable' ? owner.updateConfig({ enabled: true }) : owner.reset());
      const restored = new RecoveryStore(path);
      expect(restored.loadFailed).toBe(false);
      expect(restored.get('owned')).toEqual(accepted);
      expect(accepted.config.enabled).toBe(true);
      expect(accepted.circuitOpen).toBe(false);
      expect(await fs.readdir(dirname(path))).toEqual(['recovery.json']);
    } finally {
      owner.stop();
      await owner.drain();
    }
  }
);

it.each(['malformed', 'symlink', 'directory'] as const)(
  'refuses existing %s publication fence without overwriting it',
  async (kind) => {
    const store = new RecoveryStore(path);
    await store.save('owned', state());
    const marker = `${path}.pending`;
    const target = join(root, 'foreign');
    await fs.writeFile(target, 'foreign proof');
    if (kind === 'symlink') await fs.symlink(target, marker);
    else if (kind === 'directory') await fs.mkdir(marker);
    else await fs.writeFile(marker, 'unknown receipt');
    const before = await fs.readFile(path, 'utf8');
    const restored = new RecoveryStore(path);
    expect(restored.loadFailed).toBe(true);
    await expect(restored.save('owned', state(true))).rejects.toThrow(/could not be loaded/);
    // An already-created store must also refuse the exclusive fence reservation.
    await expect(store.save('owned', state(true))).rejects.toThrow();
    expect(await fs.readFile(path, 'utf8')).toBe(before);
    expect(await fs.readFile(target, 'utf8')).toBe('foreign proof');
    expect((await fs.lstat(marker)).isSymbolicLink()).toBe(kind === 'symlink');
    if (kind === 'malformed') expect(await fs.readFile(marker, 'utf8')).toBe('unknown receipt');
  }
);

it('preserves a replaced foreign fence after journal publication', async () => {
  const store = new RecoveryStore(path);
  await store.save('owned', state());
  const marker = `${path}.pending`;
  vi.mocked(rename).mockImplementation(async (from, to) => {
    await native.rename(from, to);
    if (to === path) {
      await fs.rename(marker, `${marker}.owned`);
      await fs.writeFile(marker, 'foreign replacement');
    }
  });
  await expect(store.save('owned', state(true))).rejects.toThrow(/fence changed/);
  vi.mocked(rename).mockImplementation(native.rename);
  expect(await fs.readFile(marker, 'utf8')).toBe('foreign replacement');
  expect(new RecoveryStore(path).get('owned')).toMatchObject({ config: { enabled: false }, circuitOpen: true });
});

it('keeps a failed final fence removal blocked across restart', async () => {
  const store = new RecoveryStore(path);
  await store.save('owned', state());
  vi.mocked(unlinkSync).mockImplementation(() => {
    throw new Error('fence removal denied');
  });
  await expect(store.save('owned', state(true))).rejects.toThrow(/removal denied/);
  expect(JSON.parse(await fs.readFile(path, 'utf8')).sessions.owned.config.enabled).toBe(true);
  expect(new RecoveryStore(path).get('owned')).toMatchObject({ config: { enabled: false }, circuitOpen: true });
  expect(await fs.readFile(`${path}.pending`, 'utf8')).toMatch(/^[a-f0-9-]+\n$/);
});

it.each(['marker-sync', 'directory-sync'] as const)(
  'refuses publication before %s has acknowledged the fence',
  async (fault) => {
    const store = new RecoveryStore(path);
    await store.save('owned', state());
    const before = await fs.readFile(path, 'utf8');
    vi.mocked(open).mockImplementation(async (name, flags, mode) => {
      const handle = await native.open(name, flags, mode);
      if (
        (fault === 'marker-sync' && name === `${path}.pending`) ||
        (fault === 'directory-sync' && name === dirname(path) && flags === 'r')
      ) {
        handle.sync = async () => {
          throw new Error('fence durability failed');
        };
      }
      return handle;
    });
    await expect(store.save('owned', state(true))).rejects.toThrow(/fence durability/);
    expect(await fs.readFile(path, 'utf8')).toBe(before);
    expect(new RecoveryStore(path).get('owned')).toMatchObject({ config: { enabled: false }, circuitOpen: true });
  }
);

it('does not reject acknowledged consent for cleanup failure after the final commit', async () => {
  const store = new RecoveryStore(path);
  await store.save('owned', state());
  let directorySyncs = 0;
  vi.mocked(open).mockImplementation(async (name, flags, mode) => {
    const handle = await native.open(name, flags, mode);
    if (name === dirname(path) && flags === 'r') {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        directorySyncs++;
        // A rejecting directory operation may only run while the fence exists.
        await fs.lstat(`${path}.pending`);
        await sync();
      };
    }
    return handle;
  });
  vi.mocked(unlink).mockRejectedValue(new Error('temporary cleanup denied'));
  await expect(store.save('owned', state(true))).resolves.toBeUndefined();
  expect(directorySyncs).toBe(2);
  const restored = new RecoveryStore(path);
  expect(restored.loadFailed).toBe(false);
  expect(restored.get('owned')).toEqual(state(true));
});
