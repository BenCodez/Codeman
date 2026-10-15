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
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    fsyncSync(fd: number) {
      io.syncs++;
      actual.fsyncSync(fd);
    },
    fstatSync(fd: number) {
      if (io.statUnavailable) throw new Error('Private fixture metadata unavailable');
      const value = actual.fstatSync(fd);
      return io.nonregular ? Object.assign(value, { isFile: () => false }) : value;
    },
    openSync(...args: Parameters<typeof actual.openSync>) {
      if (String(args[0]) === io.unreadable) throw new Error('Private fixture read unavailable');
      if (typeof args[1] === 'number') {
        io.flags.push(args[1]);
        const callback = io.beforeOpen;
        io.beforeOpen = undefined;
        callback?.();
      }
      return Reflect.apply(actual.openSync, actual, args);
    },
    readSync(...args: Parameters<typeof actual.readSync>) {
      io.reads++;
      return Reflect.apply(actual.readSync, actual, args);
    },
    renameSync(from: fs.PathLike, to: fs.PathLike) {
      actual.renameSync(from, to);
      const callback = io.afterRename;
      io.afterRename = undefined;
      callback?.();
    },
  };
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

it.each([pending, untracked])('reuses an unchanged acknowledged veto without another fsync: %j', (value) => {
  writeRebootIdentityFence(ID, value);
  const count = io.syncs;
  const before = fs.statSync(rebootIdentityFencePath(ID));
  writeRebootIdentityFence(ID, value);
  expect(io.syncs).toBe(count);
  expect(fs.statSync(rebootIdentityFencePath(ID)).ino).toBe(before.ino);
  expect(readRebootIdentityFence(ID)).toEqual(value);
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
)('revalidates $change instead of trusting a cached $value veto', ({ value, change }) => {
  writeRebootIdentityFence(ID, value);
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
  if (change === 'directory') expect(() => writeRebootIdentityFence(ID, value)).toThrow();
  else {
    writeRebootIdentityFence(ID, value);
    io.unreadable = '';
    expect(readRebootIdentityFence(ID)).toEqual(value);
  }
  expect(io.syncs).toBeGreaterThan(count);
  if (change === 'symlink') expect(fs.readFileSync(target, 'utf8')).toBe('original-private-target');
});

it('does not cache a foreign same-veto inode substituted during publication', () => {
  const path = rebootIdentityFencePath(ID);
  io.afterRename = () => replace(path, pending);
  writeRebootIdentityFence(ID, pending);
  const foreign = fs.statSync(path).ino;
  const count = io.syncs;
  writeRebootIdentityFence(ID, pending);
  expect(io.syncs).toBeGreaterThan(count);
  expect(fs.statSync(path).ino).not.toBe(foreign);
});

it('retains previously acknowledged untracked input after a permissive replacement', () => {
  writeRebootIdentityFence(ID, untracked);
  replace(rebootIdentityFencePath(ID), { switchPending: false });
  writeRebootIdentityFence(ID, pending);
  expect(readRebootIdentityFence(ID)).toEqual(untracked);
});

it('acknowledges a durable write without caching unavailable owned metadata', () => {
  io.statUnavailable = true;
  writeRebootIdentityFence(ID, pending);
  expect(readRebootIdentityFence(ID)).toEqual(pending);
  const count = io.syncs;
  io.statUnavailable = false;
  writeRebootIdentityFence(ID, pending);
  expect(io.syncs).toBeGreaterThan(count);
});

it('rejects a replacement inode at open before reading it and durably reestablishes the veto', () => {
  writeRebootIdentityFence(ID, pending);
  const path = rebootIdentityFencePath(ID);
  const count = io.syncs;
  io.beforeOpen = () => replace(path, { switchPending: false });
  writeRebootIdentityFence(ID, pending);
  expect(io.syncs).toBeGreaterThan(count);
  expect(readRebootIdentityFence(ID)).toEqual(pending);
  for (const flags of io.flags) {
    expect(flags & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
    expect(flags & fs.constants.O_NONBLOCK).toBe(fs.constants.O_NONBLOCK);
  }
});

it('never reads a nonregular opened object or treats it as a cached durable veto', () => {
  writeRebootIdentityFence(ID, pending);
  const count = io.syncs;
  io.nonregular = true;
  io.reads = 0;
  writeRebootIdentityFence(ID, pending);
  expect(io.reads).toBe(0);
  expect(io.syncs).toBeGreaterThan(count);
  io.nonregular = false;
  expect(readRebootIdentityFence(ID)).toEqual(pending);
});
