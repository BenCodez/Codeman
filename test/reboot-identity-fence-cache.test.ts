/** Cached input vetoes still require their exact acknowledged private inode; temporary files only. */
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  readRebootIdentityFence,
  rebootIdentityFencePath,
  writeRebootIdentityFence,
} from '../src/recovery/reboot-identity-fence.js';

const io = vi.hoisted(() => ({
  syncs: 0,
  unreadable: '',
  statUnavailable: false,
  nonregular: false,
  reads: 0,
  flags: [] as number[],
  beforeOpen: undefined as (() => void) | undefined,
  afterRename: undefined as (() => void) | undefined,
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  const operations = {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (String(args[0]) === io.unreadable) throw new Error('Private fixture read unavailable');
      if (typeof args[1] === 'number') {
        io.flags.push(args[1]);
        const callback = io.beforeOpen;
        io.beforeOpen = undefined;
        callback?.();
      }
      const handle = await actual.open(...args);
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'sync')
            return async () => {
              io.syncs++;
              return target.sync();
            };
          if (key === 'stat')
            return async () => {
              if (io.statUnavailable) throw Error('Private fixture metadata unavailable');
              const value = await target.stat();
              return io.nonregular ? Object.assign(value, { isFile: () => false }) : value;
            };
          if (key === 'read')
            return async (...values: Parameters<typeof handle.read>) => {
              io.reads++;
              return target.read(...values);
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await actual.rename(...args);
      const callback = io.afterRename;
      io.afterRename = undefined;
      callback?.();
    },
  };
  return { ...operations, default: operations };
});

let root: string;
const ID = 'fence-cache-fixture';
const pending = { switchPending: true };
const untracked = { switchPending: true, untrackedInput: true };
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'codeman-fence-cache-'));
  vi.stubEnv('CODEMAN_DATA_DIR', root);
  io.syncs = 0;
  io.unreadable = '';
  io.statUnavailable = false;
  io.nonregular = false;
  io.reads = 0;
  io.flags = [];
  io.beforeOpen = undefined;
  io.afterRename = undefined;
});
afterEach(() => {
  io.unreadable = '';
  io.statUnavailable = false;
  io.nonregular = false;
  io.beforeOpen = undefined;
  io.afterRename = undefined;
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
function replace(path: string, value: object) {
  const next = path + '.replacement';
  fs.writeFileSync(next, JSON.stringify({ version: 1, ...value }), { mode: 0o600 });
  fs.renameSync(next, path);
}

it.each([pending, untracked])('reuses an unchanged acknowledged veto without another fsync: %j', async (value) => {
  await writeRebootIdentityFence(ID, value);
  const count = io.syncs;
  const before = fs.statSync(rebootIdentityFencePath(ID));
  await writeRebootIdentityFence(ID, value);
  expect(io.syncs).toBe(count);
  expect(fs.statSync(rebootIdentityFencePath(ID)).ino).toBe(before.ino);
  expect(await readRebootIdentityFence(ID)).toEqual(value);
});

it.each(
  [pending, untracked].flatMap((value) =>
    [
      'permissive-replacement',
      'same-veto-replacement',
      'in-place',
      'missing',
      'unreadable',
      'symlink',
      'directory',
    ].map((change) => ({ value, change }))
  )
)('revalidates $change instead of trusting a cached $value veto', async ({ value, change }) => {
  await writeRebootIdentityFence(ID, value);
  const path = rebootIdentityFencePath(ID);
  const count = io.syncs;
  const permissive = { switchPending: false };
  const target = join(root, 'untouched-target');
  if (change === 'permissive-replacement') replace(path, permissive);
  if (change === 'same-veto-replacement') replace(path, value);
  if (change === 'in-place') fs.writeFileSync(path, JSON.stringify({ version: 1, ...permissive }));
  if (change === 'missing' || change === 'directory' || change === 'symlink') fs.unlinkSync(path);
  if (change === 'directory') fs.mkdirSync(path);
  if (change === 'symlink') {
    fs.writeFileSync(target, 'original-private-target');
    fs.symlinkSync(target, path);
  }
  if (change === 'unreadable') io.unreadable = path;
  if (['directory', 'symlink', 'unreadable'].includes(change)) {
    await expect(writeRebootIdentityFence(ID, value)).rejects.toThrow();
    expect(io.syncs).toBe(count);
    if (change === 'symlink') expect(fs.readFileSync(target, 'utf8')).toBe('original-private-target');
    return;
  } else {
    await writeRebootIdentityFence(ID, value);
    io.unreadable = '';
    expect(await readRebootIdentityFence(ID)).toEqual(value);
  }
  expect(io.syncs).toBeGreaterThan(count);
  if (change === 'symlink') expect(fs.readFileSync(target, 'utf8')).toBe('original-private-target');
});

it('does not cache a foreign same-veto inode substituted during publication', async () => {
  const path = rebootIdentityFencePath(ID);
  io.afterRename = () => replace(path, pending);
  await expect(writeRebootIdentityFence(ID, pending)).rejects.toThrow();
  const foreign = fs.statSync(path).ino;
  const count = io.syncs;
  await writeRebootIdentityFence(ID, pending);
  expect(io.syncs).toBeGreaterThan(count);
  expect(fs.statSync(path).ino).not.toBe(foreign);
});

it('retains previously acknowledged untracked input after a permissive replacement', async () => {
  await writeRebootIdentityFence(ID, untracked);
  replace(rebootIdentityFencePath(ID), { switchPending: false });
  await writeRebootIdentityFence(ID, pending);
  expect(await readRebootIdentityFence(ID)).toEqual(untracked);
});

it('refuses unavailable owned metadata and permits a fresh healthy retry', async () => {
  io.statUnavailable = true;
  await expect(writeRebootIdentityFence(ID, pending)).rejects.toThrow();
  expect(await readRebootIdentityFence(ID)).toEqual(undefined);
  const count = io.syncs;
  io.statUnavailable = false;
  await writeRebootIdentityFence(ID, pending);
  expect(io.syncs).toBeGreaterThan(count);
});

it('rejects a replacement inode at open before reading it and durably reestablishes the veto', async () => {
  await writeRebootIdentityFence(ID, pending);
  const path = rebootIdentityFencePath(ID);
  const count = io.syncs;
  io.beforeOpen = () => replace(path, { switchPending: false });
  await expect(writeRebootIdentityFence(ID, pending)).rejects.toThrow();
  expect(io.syncs).toBe(count);
  await writeRebootIdentityFence(ID, pending);
  expect(io.syncs).toBeGreaterThan(count);
  expect(await readRebootIdentityFence(ID)).toEqual(pending);
  for (const flags of io.flags) {
    expect(flags & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
    expect(flags & fs.constants.O_NONBLOCK).toBe(fs.constants.O_NONBLOCK);
  }
});

it('never reads a nonregular opened object or treats it as a cached durable veto', async () => {
  await writeRebootIdentityFence(ID, pending);
  const count = io.syncs;
  io.nonregular = true;
  io.reads = 0;
  await expect(writeRebootIdentityFence(ID, pending)).rejects.toThrow();
  expect(io.reads).toBe(0);
  expect(io.syncs).toBe(count);
  io.nonregular = false;
  expect(await readRebootIdentityFence(ID)).toEqual(pending);
});
