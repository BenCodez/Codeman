/** Reboot confinement never blocks the event loop or promotes unknown owner/path evidence. */
import fs from 'node:fs/promises';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { isRebootWorkingDirAllowed } from '../src/recovery/reboot-workspace.js';
import { invalidateUsersCache } from '../src/user-store.js';

let root: string, base: string, workspace: string;
let saved: Record<string, string | undefined>;
const releases: Array<() => void> = [];
function barrier() {
  let entered!: () => void, release!: () => void;
  const at = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  return { entered, release, at, wait };
}
function users(change: Record<string, unknown> = {}) {
  writeFileSync(
    join(root, 'users.json'),
    JSON.stringify({ version: 1, users: [{ username: 'alice', role: 'user', canBypassPermissions: true, ...change }] })
  );
}
beforeEach(() => {
  saved = Object.fromEntries(
    ['CODEMAN_DATA_DIR', 'CODEMAN_MULTIUSER', 'CODEMAN_USER_SPACES_DIR'].map((key) => [key, process.env[key]])
  );
  root = mkdtempSync(join(homedir(), 'reboot-workspace-'));
  process.env.CODEMAN_DATA_DIR = root;
  process.env.CODEMAN_MULTIUSER = '1';
  process.env.CODEMAN_USER_SPACES_DIR = join(root, 'spaces');
  base = join(root, 'spaces', 'alice', 'cases');
  workspace = join(base, 'project');
  mkdirSync(workspace, { recursive: true });
  users();
  invalidateUsersCache();
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  vi.useRealTimers();
  await new Promise<void>((resolve) => setImmediate(resolve));
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  invalidateUsersCache();
  rmSync(root, { recursive: true, force: true });
});

it('confines a bypass-granted regular owner and keeps the bounded snapshot role distinct from privilege', async () => {
  expect(await isRebootWorkingDirAllowed('alice', workspace, () => true)).toBe(true);
  expect(await isRebootWorkingDirAllowed('alice', root, () => true)).toBe(false);
  users({ role: 'admin' });
  invalidateUsersCache();
  expect(await isRebootWorkingDirAllowed('alice', root, () => true)).toBe(true);
});
it.each(['single-user', 'legacy-unowned'] as const)(
  'preserves the %s no-confinement contract without path IO',
  async (kind) => {
    if (kind === 'single-user') process.env.CODEMAN_MULTIUSER = '0';
    const paths = vi.spyOn(fs, 'realpath').mockRejectedValue(Error('No path IO expected'));
    expect(await isRebootWorkingDirAllowed(kind === 'legacy-unowned' ? undefined : 'alice', root, () => true)).toBe(
      true
    );
    expect(paths).not.toHaveBeenCalled();
  }
);
it.each(['missing', 'unreadable', 'symlink-escape'] as const)(
  'refuses %s without creating a case-space anchor',
  async (kind) => {
    const target = join(base, 'target');
    if (kind === 'symlink-escape') symlinkSync(root, target, 'dir');
    if (kind === 'unreadable')
      vi.spyOn(fs, 'realpath').mockRejectedValue(Object.assign(Error('unreadable'), { code: 'EACCES' }));
    const mkdir = vi.spyOn(fs, 'mkdir');
    expect(await isRebootWorkingDirAllowed('alice', target, () => true)).toBe(false);
    expect(mkdir).not.toHaveBeenCalled();
  }
);
it('retains timed-out path work until settlement and shares the original monotonic deadline', async () => {
  vi.useFakeTimers();
  const stage = barrier(),
    realpath = fs.realpath.bind(fs);
  let calls = 0;
  vi.spyOn(fs, 'realpath').mockImplementation(async (path, ...options) => {
    if (String(path) === base) {
      calls++;
      stage.entered();
      await stage.wait;
    }
    return realpath(path, ...options);
  });
  const first = isRebootWorkingDirAllowed('alice', workspace, () => true, performance.now() + 100);
  await stage.at;
  await vi.advanceTimersByTimeAsync(100);
  expect(await first).toBe(false);
  expect(await isRebootWorkingDirAllowed('alice', workspace, () => true)).toBe(false);
  expect(calls).toBe(1);
  stage.release();
  vi.useRealTimers();
  await vi.waitFor(async () => expect(await isRebootWorkingDirAllowed('alice', workspace, () => true)).toBe(true));
});
it.each(['cancel', 'role', 'disabled', 'spaces', 'disk-role'] as const)(
  'refuses a %s change during held asynchronous confinement',
  async (change) => {
    const stage = barrier(),
      realpath = fs.realpath.bind(fs);
    let allowed = true,
      held = false;
    vi.spyOn(fs, 'realpath').mockImplementation(async (path, ...options) => {
      if (!held && String(path) === base) {
        held = true;
        stage.entered();
        await stage.wait;
      }
      return realpath(path, ...options);
    });
    const result = isRebootWorkingDirAllowed('alice', workspace, () => allowed);
    await stage.at;
    if (change === 'cancel') allowed = false;
    if (change === 'role' || change === 'disk-role') users({ role: 'admin' });
    if (change === 'disabled') users({ disabled: true });
    if (change === 'spaces') process.env.CODEMAN_USER_SPACES_DIR = join(root, 'another-space');
    if (change === 'role' || change === 'disabled') invalidateUsersCache();
    stage.release();
    expect(await result).toBe(false);
  }
);
it('rechecks the real workspace namespace after the awaited grant proof', async () => {
  const link = join(base, 'workspace-link');
  symlinkSync(workspace, link, 'dir');
  const realpath = fs.realpath.bind(fs);
  let reads = 0;
  vi.spyOn(fs, 'realpath').mockImplementation(async (path, ...options) => {
    if (String(path) === link && ++reads === 2) {
      unlinkSync(link);
      symlinkSync(root, link, 'dir');
    }
    return realpath(path, ...options);
  });
  expect(await isRebootWorkingDirAllowed('alice', link, () => true)).toBe(false);
  expect(reads).toBe(2);
});
