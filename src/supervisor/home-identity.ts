/** @fileoverview Bounded, fresh local history-domain separation before supervisor leases. */
import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

let activeProofs = 0;

/** Unknown, missing, or changing directories cannot establish independent histories. */
export async function haveDistinctSupervisorHomes(
  managerHome: string | undefined,
  workerHome: string | undefined,
  isCurrent: () => boolean,
  deadline = performance.now() + 2_000
): Promise<boolean> {
  const current = () => {
    try {
      return performance.now() < deadline && isCurrent() === true;
    } catch {
      return false;
    }
  };
  if (!managerHome || !workerHome || managerHome === workerHome || !current() || activeProofs >= 2) return false;
  activeProofs++;
  const work = (async () => {
    const snapshot = async (home: string) => {
      const path = await fs.realpath(home);
      const stat = await fs.stat(path, { bigint: true });
      if (!stat.isDirectory() || !current()) throw new Error('Unknown supervisor history directory');
      return { path, dev: stat.dev, ino: stat.ino };
    };
    const manager = await snapshot(managerHome);
    const worker = await snapshot(workerHome);
    if (manager.path === worker.path || (manager.dev === worker.dev && manager.ino === worker.ino)) return false;
    const finalManager = await snapshot(managerHome);
    const finalWorker = await snapshot(workerHome);
    return (
      manager.path === finalManager.path &&
      manager.dev === finalManager.dev &&
      manager.ino === finalManager.ino &&
      worker.path === finalWorker.path &&
      worker.dev === finalWorker.dev &&
      worker.ino === finalWorker.ino &&
      current()
    );
  })()
    .catch(() => false)
    .finally(() => activeProofs--);
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
    // The active slot belongs to the actual I/O job, including after a timeout.
  }
}
