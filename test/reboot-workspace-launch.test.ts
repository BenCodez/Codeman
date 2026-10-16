/** Actual temp directories + generated child code; no native pane or worker is started. */
import fs from 'node:fs/promises';
import * as nativeFs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invalidateUsersCache } from '../src/user-store.js';
import {
  prepareRebootWorkspaceLaunch,
  REBOOT_WORKSPACE_CHILD,
  type RebootWorkspaceLaunch,
} from '../src/recovery/reboot-workspace-launch.js';

let root: string, base: string, workspace: string, foreign: string;
let saved: Record<string, string | undefined>;
const leases: RebootWorkspaceLaunch[] = [];
const handles: import('node:fs/promises').FileHandle[] = [];
const releases: Array<() => void> = [];
const actualOpen = fs.open.bind(fs);
const trackedOpen: typeof fs.open = async (...args) => {
  const handle = await actualOpen(...args);
  handles.push(handle);
  return handle;
};
function users(role = 'user') {
  nativeFs.writeFileSync(
    join(root, 'users.json'),
    JSON.stringify({ version: 1, users: [{ username: 'alice', role }] })
  );
  invalidateUsersCache();
}
beforeEach(() => {
  saved = Object.fromEntries(
    ['CODEMAN_DATA_DIR', 'CODEMAN_MULTIUSER', 'CODEMAN_USER_SPACES_DIR'].map((key) => [key, process.env[key]])
  );
  root = nativeFs.mkdtempSync(join(tmpdir(), 'reboot-cwd-identity-'));
  process.env.CODEMAN_DATA_DIR = root;
  process.env.CODEMAN_MULTIUSER = '1';
  process.env.CODEMAN_USER_SPACES_DIR = join(root, 'spaces');
  base = join(root, 'spaces', 'alice', 'cases');
  workspace = join(base, 'parent', 'project');
  foreign = join(root, 'foreign');
  nativeFs.mkdirSync(workspace, { recursive: true });
  nativeFs.mkdirSync(join(foreign, 'project'), { recursive: true });
  users();
  const open = trackedOpen;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    handles.push(handle);
    return handle;
  });
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const lease of leases.splice(0)) lease.release();
  vi.useRealTimers();
  await vi.waitFor(() => expect(handles.every((handle) => handle.fd === -1)).toBe(true), { timeout: 3000 });
  handles.length = 0;
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  invalidateUsersCache();
  nativeFs.rmSync(root, { recursive: true, force: true });
});
async function prepare(current = () => true, deadline?: number) {
  const lease = await prepareRebootWorkspaceLaunch('alice', workspace, current, deadline);
  if (lease) leases.push(lease);
  return lease;
}
function payload(lease: RebootWorkspaceLaunch) {
  const command = lease.wrap('fixture-worker --resume exact-conversation');
  // Only the final shell word is JSON. Test paths/command do not contain quotes.
  const start = command.lastIndexOf(" '{");
  expect(start).toBeGreaterThan(0);
  return JSON.parse(command.slice(start + 2, -1));
}
function child(value: ReturnType<typeof payload>, afterStat?: () => void, clock?: () => bigint) {
  const executed = vi.fn();
  const cwd = vi.fn();
  const opened: number[] = [];
  const effects = {
    ...nativeFs,
    openSync: (...args: Parameters<typeof nativeFs.openSync>) => {
      const fd = nativeFs.openSync(...args);
      opened.push(fd);
      return fd;
    },
    fstatSync: (...args: Parameters<typeof nativeFs.fstatSync>) => {
      const result = nativeFs.fstatSync(...args);
      afterStat?.();
      return result;
    },
    closeSync: (fd: number) => {
      nativeFs.closeSync(fd);
      opened.splice(opened.indexOf(fd), 1);
    },
  };
  const exit = (code: number) => {
    throw Error(`exit ${code}`);
  };
  try {
    runInNewContext(REBOOT_WORKSPACE_CHILD, {
      require: (name: string) => {
        if (name !== 'node:fs') throw Error('Unexpected dependency');
        return effects;
      },
      process: {
        argv: ['node', JSON.stringify(value)],
        env: { FIXTURE: '1' },
        hrtime: { bigint: clock ?? process.hrtime.bigint },
        exit,
        chdir: (path: string) => cwd(nativeFs.statSync(path, { bigint: true }).ino.toString()),
        execve: executed,
      },
    });
  } catch (error) {
    expect(String(error)).toContain('exit 125');
  } finally {
    for (const fd of opened) nativeFs.closeSync(fd);
  }
  return { executed, cwd };
}
it('binds healthy child cwd before execve, preserving the exact command and native PID', async () => {
  const lease = await prepare();
  expect(lease).toBeDefined();
  const value = payload(lease!);
  const result = child(value);
  expect(result.cwd).toHaveBeenCalledExactlyOnceWith(nativeFs.statSync(workspace, { bigint: true }).ino.toString());
  expect(result.executed).toHaveBeenCalledExactlyOnceWith('/bin/bash', ['bash', '-c', value.command], { FIXTURE: '1' });
  expect(value.command).toBe('fixture-worker --resume exact-conversation');
});
it.each(['leaf', 'ancestor'] as const)('refuses a %s symlink escape after the final parent proof', async (kind) => {
  const lease = await prepare();
  const value = payload(lease!);
  const changed = kind === 'leaf' ? workspace : join(base, 'parent');
  nativeFs.renameSync(changed, changed + '-original');
  nativeFs.symlinkSync(kind === 'leaf' ? foreign : foreign, changed, 'dir');
  const result = child(value);
  expect(result.executed).not.toHaveBeenCalled();
  expect(result.cwd).not.toHaveBeenCalled();
});
it('uses the child-owned FD when the path changes after its own fstat', async () => {
  const lease = await prepare();
  const value = payload(lease!);
  const original = nativeFs.statSync(workspace, { bigint: true }).ino.toString();
  const result = child(value, () => {
    nativeFs.renameSync(workspace, workspace + '-original');
    nativeFs.symlinkSync(foreign, workspace, 'dir');
  });
  expect(result.cwd).toHaveBeenCalledExactlyOnceWith(original);
  expect(result.executed).toHaveBeenCalledOnce();
  expect(result.cwd).not.toHaveBeenCalledWith(nativeFs.statSync(foreign, { bigint: true }).ino.toString());
});
it('refuses an ancestor replacement while parent capture opens the anchored relative directory', async () => {
  const open = trackedOpen;
  let changed = false;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    if (!changed && String(args[0]).endsWith('/parent')) {
      changed = true;
      nativeFs.renameSync(join(base, 'parent'), join(base, 'old-parent'));
      nativeFs.symlinkSync(foreign, join(base, 'parent'), 'dir');
    }
    return open(...args);
  });
  expect(await prepare()).toBeUndefined();
  expect(changed).toBe(true);
});
it('refuses a case-root ancestor replacement during the original confinement capture', async () => {
  const open = trackedOpen;
  let changed = false;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    if (!changed && String(args[0]).endsWith('/alice')) {
      changed = true;
      nativeFs.renameSync(join(root, 'spaces', 'alice'), join(root, 'spaces', 'old-alice'));
      nativeFs.mkdirSync(join(foreign, 'cases', 'parent', 'project'), { recursive: true });
      nativeFs.symlinkSync(foreign, join(root, 'spaces', 'alice'), 'dir');
    }
    return open(...args);
  });
  expect(await prepare()).toBeUndefined();
  expect(changed).toBe(true);
});
it.each(['cancel', 'role', 'spaces'] as const)('refuses %s during held directory capture', async (kind) => {
  let allowed = true,
    signal!: () => void,
    release!: () => void;
  const entered = new Promise<void>((resolve) => (signal = resolve)),
    wait = new Promise<void>((resolve) => (release = resolve));
  releases.push(release);
  const realpath = fs.realpath.bind(fs);
  let held = false;
  vi.spyOn(fs, 'realpath').mockImplementation(async (...args) => {
    if (!held && String(args[0]) === workspace) {
      held = true;
      signal();
      await wait;
    }
    return realpath(...args);
  });
  const pending = prepare(() => allowed);
  await entered;
  if (kind === 'cancel') allowed = false;
  if (kind === 'role') users('admin');
  if (kind === 'spaces') process.env.CODEMAN_USER_SPACES_DIR = join(root, 'different');
  release();
  expect(await pending).toBeUndefined();
});
it('keeps timed-out opens at the two-job cap until their actual settlement', async () => {
  vi.useFakeTimers();
  let entered!: () => void,
    release!: () => void,
    calls = 0,
    settled = 0;
  const at = new Promise<void>((resolve) => (entered = resolve)),
    wait = new Promise<void>((resolve) => (release = resolve));
  releases.push(release);
  const open = trackedOpen;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    if ((Number(args[1]) & nativeFs.constants.O_DIRECTORY) !== 0) {
      calls++;
      if (calls === 2) entered();
      await wait;
      try {
        return await open(...args);
      } finally {
        settled++;
      }
    }
    return open(...args);
  });
  const first = prepare(() => true, performance.now() + 50),
    second = prepare(() => true, performance.now() + 50);
  await at;
  await vi.advanceTimersByTimeAsync(50);
  expect(await first).toBeUndefined();
  expect(await second).toBeUndefined();
  expect(await prepare()).toBeUndefined();
  expect(calls).toBe(2);
  release();
  vi.useRealTimers();
  await vi.waitFor(() => expect(settled).toBe(2));
  await vi.waitFor(() => expect(handles.every((handle) => handle.fd === -1)).toBe(true));
});
it('retains the verified inode until the fixed dispatch deadline and rejects late child work', async () => {
  const lease = await prepare(() => true, performance.now() + 150);
  expect(lease).toBeDefined();
  const value = payload(lease!);
  lease!.noteDispatch();
  lease!.release();
  expect(handles.some((handle) => handle.fd >= 0)).toBe(true);
  const result = child(value, undefined, () => BigInt(value.deadline) * 1000000n);
  expect(result.executed).not.toHaveBeenCalled();
  expect(result.cwd).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(handles.every((handle) => handle.fd === -1)).toBe(true));
});
it('refuses expiry between the child open/fstat and its cwd transition', async () => {
  const lease = await prepare();
  const value = payload(lease!);
  let expired = false;
  const result = child(
    value,
    () => (expired = true),
    () => BigInt(value.deadline - (expired ? 0 : 1)) * 1000000n
  );
  expect(result.executed).not.toHaveBeenCalled();
  expect(result.cwd).not.toHaveBeenCalled();
});
it('refuses a runtime without PID-preserving execve before native worker effects', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'execve')!;
  try {
    Object.defineProperty(process, 'execve', { ...descriptor, value: undefined });
    expect(await prepare()).toBeUndefined();
  } finally {
    Object.defineProperty(process, 'execve', descriptor);
  }
});
it('keeps legacy-unowned and admin confinement semantics', async () => {
  const legacy = await prepareRebootWorkspaceLaunch(undefined, foreign, () => true);
  expect(legacy?.wrap('exact-command')).toContain(foreign);
  users('admin');
  const admin = await prepareRebootWorkspaceLaunch('alice', foreign, () => true);
  expect(admin?.wrap('exact-command')).toContain(foreign);
  legacy?.release();
  admin?.release();
});
