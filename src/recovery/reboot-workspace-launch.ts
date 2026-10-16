/** Bind a guarded reboot's actual child cwd to a bounded, opened directory identity. */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { getDataDir } from '../config/instance.js';
import { getUserSpacesDir, isMultiUserMode, userCasesDir } from '../config/multiuser.js';
import { prepareRecoveryPrivilegeGrant } from '../user-store.js';

export interface RebootWorkspaceLaunch {
  wrap(commandWithoutCd: string): string;
  isCurrent(): boolean;
  noteDispatch(): void;
  confirmStartup?(panePid?: number): Promise<boolean>;
  remainingStartupMs?(): number;
  release(): void;
}
const active = new Set<object>();
const safeCurrent = (check: () => boolean) => {
  try {
    const value: unknown = check();
    if (value && typeof (value as { then?: unknown }).then === 'function') void Promise.resolve(value).catch(() => {});
    return value === true;
  } catch {
    return false;
  }
};
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

// Runs in the new pane, never on the web event loop. execve preserves the native
// pane/child PID. The opened child FD is private to this process: neither an
// ancestor swap nor a replacement after fstat can retarget its cwd.
export const REBOOT_WORKSPACE_CHILD = String.raw`
const fs = require('node:fs');
try {
  const p = JSON.parse(process.argv[1]);
  const current = () => Number(process.hrtime.bigint() / 1000000n) < p.deadline;
  if (typeof process.execve !== 'function' || !current()) process.exit(125);
  const fd = fs.openSync(p.path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  const info = fs.fstatSync(fd, {bigint:true});
  if (!info.isDirectory() || String(info.dev) !== p.dev || String(info.ino) !== p.ino || !current()) process.exit(125);
  process.chdir('/proc/self/fd/' + fd);
  if (!current()) process.exit(125);
  fs.closeSync(fd);
  const receipt = fs.openSync(p.receipt.path, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  const receiptInfo = fs.fstatSync(receipt, {bigint:true});
  if (!receiptInfo.isFile() || String(receiptInfo.dev) !== p.receipt.dev || String(receiptInfo.ino) !== p.receipt.ino || receiptInfo.size !== 0n || (receiptInfo.mode & 63n) !== 0n || !current()) process.exit(125);
  // No deadline refusal follows this acknowledgment: the cwd/deadline checks
  // have accepted this exact handoff. execve retains the native pane PID.
  const acknowledgment = p.receipt.nonce + '|' + process.pid + '|ready';
  if (fs.writeSync(receipt, acknowledgment, 0, 'utf8') !== acknowledgment.length) process.exit(125);
  fs.closeSync(receipt);
  process.execve('/bin/bash', ['bash', '-c', p.command], process.env);
} catch { process.exit(125); }
`;

/** Unknown, cancelled and timed-out work retains its slot/FDs until actual settlement. */
export async function prepareRebootWorkspaceLaunch(
  owner: string | undefined,
  workingDir: string,
  isCurrent: () => boolean,
  originalDeadline = Infinity
): Promise<RebootWorkspaceLaunch | undefined> {
  const deadline = Math.min(performance.now() + 2000, originalDeadline);
  if (!Number.isFinite(deadline) || performance.now() >= deadline || !safeCurrent(isCurrent)) return undefined;
  // The existing single-user/unowned contract imposes no confinement policy.
  if (!isMultiUserMode() || !owner)
    return {
      wrap: (command) => `cd ${quote(workingDir)} && ${command}`,
      isCurrent: () => safeCurrent(isCurrent),
      noteDispatch() {},
      release() {},
    };
  if (!isAbsolute(workingDir) || workingDir.includes('\0') || Buffer.byteLength(workingDir) > 4096 || active.size >= 2)
    return undefined;
  const scope = [getDataDir(), getUserSpacesDir(), process.env.CODEMAN_MULTIUSER, process.env.HOME];
  const scopeIsCurrent = () =>
    scope.every(
      (value, index) =>
        value === [getDataDir(), getUserSpacesDir(), process.env.CODEMAN_MULTIUSER, process.env.HOME][index]
    );
  const token = {};
  active.add(token);
  const handles = new Set<FileHandle>();
  let expired = false,
    released = false,
    dispatched = false,
    settled = false;
  let grantCurrent = () => true;
  const check = () =>
    !expired &&
    !released &&
    performance.now() < deadline &&
    safeCurrent(isCurrent) &&
    grantCurrent() &&
    scopeIsCurrent();
  const assert = () => {
    if (!check()) throw Error('Reboot workspace changed');
  };
  const close = async () => {
    const results = await Promise.allSettled([...handles].map((handle) => handle.close()));
    // A rejected close is unknown; do not lend another acquisition its capacity.
    if (results.every((result) => result.status === 'fulfilled')) {
      handles.clear();
      active.delete(token);
    }
  };
  let startup:
    | {
        directory: string;
        directoryDev: number;
        directoryIno: number;
        path: string;
        file: FileHandle;
        dev: number;
        ino: number;
        nonce: string;
      }
    | undefined;
  let startupDirectory: { path: string; dev: number; ino: number } | undefined;
  const removeStartup = async () => {
    if (!startup) {
      if (startupDirectory) {
        try {
          const info = await fs.lstat(startupDirectory.path);
          if (
            info.isDirectory() &&
            !info.isSymbolicLink() &&
            info.dev === startupDirectory.dev &&
            info.ino === startupDirectory.ino
          )
            await fs.rmdir(startupDirectory.path);
        } catch {
          /* Nonempty, unknown or replaced directories are retained. */
        }
      }
      return;
    }
    try {
      const directory = await fs.lstat(startup.directory),
        file = await fs.lstat(startup.path);
      if (
        directory.isSymbolicLink() ||
        !directory.isDirectory() ||
        directory.dev !== startup.directoryDev ||
        directory.ino !== startup.directoryIno ||
        file.isSymbolicLink() ||
        !file.isFile() ||
        file.dev !== startup.dev ||
        file.ino !== startup.ino
      )
        return;
      await fs.unlink(startup.path);
      await fs.rmdir(startup.directory);
    } catch {
      /* Unknown/replaced artifacts are retained. */
    }
  };
  let closing: Promise<void> | undefined;
  const startClose = () => {
    if (!settled || closing) return;
    // A delayed child must not see a recycled parent inode while its fixed
    // startup deadline is still admissible. Metadata-only release never launches.
    closing = (async () => {
      while (dispatched && performance.now() < deadline)
        await new Promise<void>((resolve) => setTimeout(resolve, Math.max(1, deadline - performance.now())));
      await close();
      await removeStartup();
    })();
    void closing.catch(() => {});
  };
  const release = () => {
    released = true;
    startClose();
  };
  const work = (async (): Promise<RebootWorkspaceLaunch | undefined> => {
    try {
      assert();
      const grant = await prepareRecoveryPrivilegeGrant(owner);
      grantCurrent = grant.isCurrent;
      assert();
      if (grant.role === 'admin') {
        release();
        return {
          wrap: (command) => `cd ${quote(workingDir)} && ${command}`,
          isCurrent: () =>
            !expired && performance.now() < deadline && safeCurrent(isCurrent) && scopeIsCurrent() && grant.isCurrent(),
          noteDispatch() {},
          release() {},
        };
      }
      if (
        grant.role !== 'user' ||
        process.platform !== 'linux' ||
        typeof (process as NodeJS.Process & { execve?: unknown }).execve !== 'function'
      )
        throw Error('Reboot workspace unavailable');
      const basePath = userCasesDir(owner);
      const base = await fs.realpath(basePath);
      assert();
      const target = await fs.realpath(workingDir);
      assert();
      const suffix = relative(base, target);
      if (suffix.startsWith('..') || isAbsolute(suffix)) throw Error('Reboot workspace outside owner space');
      const components = suffix ? suffix.split('/') : [];
      if (components.length > 64 || components.some((part) => !part || part === '.' || part === '..'))
        throw Error('Reboot workspace unavailable');
      const open = async (path: string) => {
        assert();
        const handle = await fs.open(
          path,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
        handles.add(handle);
        assert();
        if (!(await handle.stat()).isDirectory()) throw Error('Reboot workspace unavailable');
        assert();
        return handle;
      };
      // Pin the configured case root without following even an ancestor
      // symlink. Resolving it first and then opening its canonical pathname
      // would still allow a replacement while the initial proof is captured.
      const anchorParts = basePath.split('/').filter(Boolean);
      if (!isAbsolute(basePath) || anchorParts.length > 64 || anchorParts.some((part) => part === '.' || part === '..'))
        throw Error('Reboot workspace anchor unavailable');
      let handle = await open('/');
      for (const part of anchorParts) handle = await open(`/proc/self/fd/${handle.fd}/${part}`);
      if ((await fs.realpath(`/proc/self/fd/${handle.fd}`)) !== base) throw Error('Reboot workspace anchor changed');
      assert();
      // Each lookup is relative to a held directory, with no symlink traversal.
      for (const part of components) handle = await open(`/proc/self/fd/${handle.fd}/${part}`);
      const info = await handle.stat({ bigint: true });
      assert();
      if ((await fs.realpath(`/proc/self/fd/${handle.fd}`)) !== target) throw Error('Reboot workspace changed');
      assert();
      if ((await fs.realpath(basePath)) !== base || !(await grant.verifyCurrent()))
        throw Error('Reboot workspace changed');
      assert();
      const startupDirectoryPath = await fs.mkdtemp(join(getDataDir(), 'reboot-workspace-startup-'));
      const directoryInfo = await fs.lstat(startupDirectoryPath);
      startupDirectory = { path: startupDirectoryPath, dev: directoryInfo.dev, ino: directoryInfo.ino };
      const startupPath = join(startupDirectoryPath, 'receipt');
      const startupFile = await fs.open(startupPath, 'wx+', 0o600);
      handles.add(startupFile);
      const startupInfo = await startupFile.stat();
      startup = {
        directory: startupDirectoryPath,
        directoryDev: directoryInfo.dev,
        directoryIno: directoryInfo.ino,
        path: startupPath,
        file: startupFile,
        dev: startupInfo.dev,
        ino: startupInfo.ino,
        nonce: randomUUID(),
      };
      assert();
      const childDeadline = Math.floor(Number(process.hrtime.bigint() / 1000000n) + deadline - performance.now());
      return {
        isCurrent: check,
        wrap: (command) => {
          assert();
          return `exec ${quote(process.execPath)} -e ${quote(REBOOT_WORKSPACE_CHILD)} ${quote(
            JSON.stringify({
              path: target,
              dev: String(info.dev),
              ino: String(info.ino),
              deadline: childDeadline,
              command,
              receipt: {
                path: startup!.path,
                dev: String(startup!.dev),
                ino: String(startup!.ino),
                nonce: startup!.nonce,
              },
            })
          )}`;
        },
        remainingStartupMs: () => Math.max(0, deadline - performance.now()),
        confirmStartup: async (panePid) => {
          const work = (async () => {
            while (check()) {
              try {
                const info = await startup!.file.stat();
                if (
                  !info.isFile() ||
                  (info.mode & 0o077) !== 0 ||
                  (process.getuid !== undefined && info.uid !== process.getuid()) ||
                  info.size > 128 ||
                  info.dev !== startup!.dev ||
                  info.ino !== startup!.ino
                )
                  return false;
                if (info.size === 0) {
                  await new Promise<void>((resolve) =>
                    setTimeout(resolve, Math.min(10, Math.max(1, deadline - performance.now())))
                  );
                  continue;
                }
                const bytes = Buffer.alloc(129);
                const { bytesRead } = await startup!.file.read(bytes, 0, bytes.length, 0);
                const receipt = bytes.subarray(0, bytesRead).toString('utf8');
                const expected = receipt.split('|');
                const after = await startup!.file.stat();
                if (
                  info.size !== bytesRead ||
                  after.size !== bytesRead ||
                  after.mtimeMs !== info.mtimeMs ||
                  after.ctimeMs !== info.ctimeMs
                )
                  return false;
                const pathInfo = await fs.lstat(startup!.path);
                if (pathInfo.isSymbolicLink() || pathInfo.dev !== startup!.dev || pathInfo.ino !== startup!.ino)
                  return false;
                if (bytesRead)
                  return (
                    check() &&
                    expected.length === 3 &&
                    expected[2] === 'ready' &&
                    expected[0] === startup!.nonce &&
                    /^[1-9]\d{0,9}$/.test(expected[1]) &&
                    (panePid === undefined || Number(expected[1]) === panePid)
                  );
              } catch {
                return false;
              }
              await new Promise<void>((resolve) =>
                setTimeout(resolve, Math.min(10, Math.max(1, deadline - performance.now())))
              );
            }
            return false;
          })();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([
              work,
              new Promise<false>((resolve) => {
                timer = setTimeout(() => resolve(false), Math.max(0, deadline - performance.now()));
              }),
            ]);
          } finally {
            if (timer) clearTimeout(timer);
          }
        },
        noteDispatch: () => {
          assert();
          dispatched = true;
        },
        release,
      };
    } catch {
      return undefined;
    }
  })();
  void work.then((result) => {
    settled = true;
    if (!result || expired || released) release();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      work,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(
          () => {
            expired = true;
            resolve(undefined);
          },
          Math.max(0, deadline - performance.now())
        );
      }),
    ]);
    if (!result || !result.isCurrent()) {
      expired = true;
      release();
      return undefined;
    }
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
