/** Bounded, read-only confinement for reboot launches; ordinary workspace APIs stay unchanged. */
import fs from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { getDataDir } from '../config/instance.js';
import { getUserSpacesDir, isMultiUserMode, userCasesDir } from '../config/multiuser.js';
import { prepareRecoveryPrivilegeGrant } from '../user-store.js';

const pending = new Map<string, Promise<boolean>>();
const current = (check: () => boolean): boolean => {
  try {
    const value: unknown = check();
    if (value && typeof (value as { then?: unknown }).then === 'function') void Promise.resolve(value).catch(() => {});
    return value === true;
  } catch {
    return false;
  }
};

/** Missing, inaccessible, timed-out or changing paths never prove confinement. */
export async function isRebootWorkingDirAllowed(
  username: string | undefined,
  workingDir: string,
  isCurrent: () => boolean,
  originalDeadline = Infinity
): Promise<boolean> {
  const deadline = Math.min(performance.now() + 2000, originalDeadline);
  if (!Number.isFinite(deadline) || performance.now() >= deadline || !current(isCurrent)) return false;
  const dataDir = getDataDir(),
    mode = process.env.CODEMAN_MULTIUSER,
    home = process.env.HOME,
    spaces = getUserSpacesDir();
  let expired = false;
  let grantIsCurrent = () => true;
  const check = () => {
    if (
      expired ||
      performance.now() >= deadline ||
      !current(isCurrent) ||
      !grantIsCurrent() ||
      getDataDir() !== dataDir ||
      process.env.CODEMAN_MULTIUSER !== mode ||
      process.env.HOME !== home ||
      getUserSpacesDir() !== spaces
    )
      throw Error('Reboot workspace unavailable');
  };
  // Preserve the existing legacy-unowned/single-user confinement contract.
  if (!isMultiUserMode() || !username) return true;
  if (!isAbsolute(workingDir) || workingDir.includes('\0') || Buffer.byteLength(workingDir) > 4096) return false;
  const key = JSON.stringify([dataDir, spaces, username, workingDir]);
  if (pending.has(key) || pending.size >= 2) return false;
  const work = Promise.resolve()
    .then(async () => {
      check();
      const grant = await prepareRecoveryPrivilegeGrant(username);
      grantIsCurrent = grant.isCurrent;
      check();
      if (!grant.isCurrent()) return false;
      if (grant.role === 'admin') return true;
      if (grant.role !== 'user') return false;
      const base = userCasesDir(username);
      // Restore requires an existing workspace. Creating a missing case-space
      // anchor cannot prove that its historical workspace is currently confined.
      const realBase = await fs.realpath(base);
      check();
      const realTarget = await fs.realpath(workingDir);
      check();
      const baseInfo = await fs.stat(realBase);
      check();
      const targetInfo = await fs.stat(realTarget);
      check();
      if (!baseInfo.isDirectory() || !targetInfo.isDirectory()) return false;
      const suffix = relative(realBase, realTarget);
      if (suffix.startsWith('..') || isAbsolute(suffix)) return false;
      if (!(await grant.verifyCurrent())) return false;
      check();
      // Grant IO is an await too: re-read both namespaces before returning proof.
      if ((await fs.realpath(base)) !== realBase) return false;
      check();
      if ((await fs.realpath(workingDir)) !== realTarget) return false;
      check();
      return grant.isCurrent();
    })
    .catch(() => false);
  pending.set(key, work);
  void work.finally(() => {
    if (pending.get(key) === work) pending.delete(key);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      work,
      new Promise<false>((resolve) => {
        timer = setTimeout(
          () => {
            expired = true;
            resolve(false);
          },
          Math.max(0, deadline - performance.now())
        );
      }),
    ]);
    check();
    return result;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
