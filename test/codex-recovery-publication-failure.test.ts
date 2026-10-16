/** @fileoverview Recovery journal replacement faults preserve reservations on real isolated files. */
import fs, { open, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RecoveryStore } from '../src/recovery/store.js';
import { RecoveryController } from '../src/recovery/controller.js';
import { initialRecoveryState, type RecoveryState } from '../src/recovery/types.js';
import { safeRmHomeTree } from './mocks/index.js';

vi.mock('node:fs/promises', async (original) => {
  const native = await original<typeof import('node:fs/promises')>();
  return { ...native, open: vi.fn(native.open), rename: vi.fn(native.rename) };
});

const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const NOW = Date.UTC(2026, 9, 13, 12);
const THREAD = '11111111-2222-3333-4444-555555555555';
let root: string;
let path: string;

beforeEach(async () => {
  root = await fs.mkdtemp(join(homedir(), 'recovery-publication-'));
  path = join(root, 'private', 'recovery.json');
});
afterEach(async () => {
  vi.mocked(open).mockImplementation(native.open);
  vi.mocked(rename).mockImplementation(native.rename);
  await safeRmHomeTree(root);
});

function state(patch: Partial<RecoveryState> = {}): RecoveryState {
  const initial = initialRecoveryState();
  return {
    ...initial,
    config: { ...initial.config, enabled: true },
    conversationId: THREAD,
    armedAt: NOW - 1000,
    ...patch,
  };
}

it.each(['directory-open', 'directory-sync', 'directory-close', 'rename-ack'] as const)(
  'seals queued and later writes after %s failure until the published reservation is reloaded',
  async (fault) => {
    const store = new RecoveryStore(path);
    const previous = state();
    await store.save('owned', previous);
    await store.save('sibling', previous);
    const reserved = state({
      attempts: 1,
      inFlight: { key: 'failure-1', action: 'continue', conversationId: THREAD, startedAt: NOW },
    });
    vi.mocked(open).mockImplementation(async (name, flags, mode) => {
      const directory = name === dirname(path) && flags === 'r';
      if (directory && fault === 'directory-open') throw new Error(fault);
      const handle = await native.open(name, flags, mode);
      if (directory && fault === 'directory-sync')
        handle.sync = async () => {
          throw new Error(fault);
        };
      if (directory && fault === 'directory-close') {
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          throw new Error(fault);
        };
      }
      return handle;
    });
    vi.mocked(rename).mockImplementation(async (from, to) => {
      await native.rename(from, to);
      if (to === path && fault === 'rename-ack') throw new Error(fault);
    });
    const results = await Promise.allSettled([
      store.save('owned', reserved),
      store.save('queued-sibling', previous),
      store.drop('sibling'),
      store.pruneOrphans(() => false),
    ]);
    expect(results.map((result) => result.status)).toEqual(Array(4).fill('rejected'));
    expect(results[0]).toMatchObject({ reason: new Error(fault) });
    const published = await fs.readFile(path, 'utf8');
    expect(JSON.parse(published).sessions.owned?.inFlight).toEqual(reserved.inFlight);
    expect(JSON.parse(published).sessions.sibling).toEqual(previous);
    expect(JSON.parse(published).sessions['queued-sibling']).toBeUndefined();
    expect(store.get('owned')).toMatchObject({
      config: { enabled: false },
      circuitOpen: true,
      phase: 'blocked',
      lastReason: 'persistence-failed',
    });
    expect(store.getCleanupSnapshot()).toBeUndefined();
    // Repairing I/O alone cannot restore authority to a stale in-memory snapshot.
    vi.mocked(open).mockImplementation(native.open);
    vi.mocked(rename).mockImplementation(native.rename);
    await expect(store.save('later-sibling', previous)).rejects.toThrow(/uncertain/);
    await expect(store.drop('owned')).rejects.toThrow(/uncertain/);
    await expect(store.pruneOrphans(() => false)).rejects.toThrow(/uncertain/);
    expect(await fs.readFile(path, 'utf8')).toBe(published);
    const restored = new RecoveryStore(path);
    expect(restored.loadFailed).toBe(false);
    expect(restored.get('owned')).toEqual(reserved);
    await restored.save('later-sibling', previous);
    expect(new RecoveryStore(path).get('owned').inFlight).toEqual(reserved.inFlight);
    const act = vi.fn(async () => 'sent' as const);
    const controller = new RecoveryController(
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
        persist: (next) => restored.save('owned', next),
        changed: () => {},
      },
      restored.get('owned')
    );
    try {
      await controller.refresh();
      await controller.refresh();
      expect(act).not.toHaveBeenCalled();
      expect(controller.getStatus().inFlight).toEqual(reserved.inFlight);
    } finally {
      controller.stop();
      await controller.drain();
    }
  }
);

it.each(['file-sync', 'file-close'] as const)(
  'allows a healthy retry after %s fails before replacement',
  async (fault) => {
    const store = new RecoveryStore(path);
    const previous = state();
    await store.save('owned', previous);
    const bytes = await fs.readFile(path, 'utf8');
    vi.mocked(open).mockImplementation(async (name, flags, mode) => {
      const handle = await native.open(name, flags, mode);
      if (flags === 'wx' && fault === 'file-sync')
        handle.sync = async () => {
          throw new Error(fault);
        };
      if (flags === 'wx' && fault === 'file-close') {
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          throw new Error(fault);
        };
      }
      return handle;
    });
    await expect(store.save('owned', state({ attempts: 1 }))).rejects.toThrow(fault);
    expect(await fs.readFile(path, 'utf8')).toBe(bytes);
    expect(store.get('owned')).toEqual(previous);
    vi.mocked(open).mockImplementation(native.open);
    await store.save('sibling', state());
    expect(new RecoveryStore(path).get('owned')).toEqual(previous);
    expect(store.getCleanupSnapshot()?.sibling).toEqual(state());
  }
);

it('keeps an unreadable replacement sealed when a fresh load cannot reconcile it', async () => {
  const store = new RecoveryStore(path);
  await store.save('owned', state());
  vi.mocked(rename).mockImplementation(async (from, to) => {
    await native.rename(from, to);
    if (to === path) throw new Error('lost rename acknowledgement');
  });
  await expect(store.save('owned', state({ attempts: 1 }))).rejects.toThrow();
  vi.mocked(rename).mockImplementation(native.rename);
  const damaged = '{"version":1,"sessions":';
  await fs.writeFile(path, damaged);
  const reloaded = new RecoveryStore(path);
  expect(reloaded.loadFailed).toBe(true);
  await expect(reloaded.save('sibling', state())).rejects.toThrow(/could not be loaded/);
  await expect(store.save('sibling', state())).rejects.toThrow(/uncertain/);
  expect(await fs.readFile(path, 'utf8')).toBe(damaged);
});
