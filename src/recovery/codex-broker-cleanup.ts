/** Bounded optional retirement. Unknown references or evidence always retain private files. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants, type Stats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { join, normalize, isAbsolute } from 'node:path';
import { CODEX_BROKER_CLEANUP_SOURCE } from './codex-broker-cleanup-source.js';
export interface BrokerCleanupReferenceSnapshot {
  references: readonly string[];
  isCurrent(): boolean;
}
export type BrokerCleanupReferenceProvider = () => BrokerCleanupReferenceSnapshot | undefined;
const UUID = /[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/g;
/** The caller supplies its entire private current-state/reference domain, never browser input. */
export function captureBrokerCleanupReferences(read: () => unknown): BrokerCleanupReferenceSnapshot | undefined {
  function drain(value: unknown): void {
    if (value && typeof (value as { then?: unknown }).then === 'function') void Promise.resolve(value).catch(() => {});
  }
  function plain(item: unknown): boolean {
    return (
      !!item &&
      typeof item === 'object' &&
      (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null) &&
      typeof (item as { then?: unknown }).then !== 'function'
    );
  }
  function uncertain(item: unknown): boolean {
    if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') return true;
    if (!item || typeof item !== 'object') return typeof item === 'number' && !Number.isFinite(item);
    if (!Array.isArray(item) && !plain(item)) {
      drain(item);
      return true;
    }
    return Object.entries(item).some(
      ([key, child]) =>
        (['inFlight', 'deliveryUncertain', 'codexRestoreUncertain', 'recoveryInputBrokerPending'].includes(key) &&
          !!child) ||
        (/inputbroker|inputevidence/i.test(key) && child === 'unknown') ||
        uncertain(child)
    );
  }
  function serialize(): string | undefined {
    try {
      const value = read();
      if (!plain(value) || Object.values(value as object).some((item) => item === undefined)) {
        drain(value);
        return undefined;
      }
      if (uncertain(value)) return undefined;
      const text = JSON.stringify(value);
      return text && Buffer.byteLength(text) <= 2_097_152 ? text : undefined;
    } catch {
      return undefined;
    }
  }
  const text = serialize();
  if (text === undefined) return undefined;
  const references = [...new Set(text.match(UUID) ?? [])];
  if (references.length > 32_768) return undefined;
  return { references, isCurrent: () => serialize() === text };
}

const active = new Set<ChildProcessWithoutNullStreams>();
// Non-authorizing scan positions rotate the existing bounded discovery window.
const discoveryOffsets = new Map<string, number>();
/** testSpawn is only for disposable fake transport/process fixtures, never a runtime option. */
export async function pruneCodexInputBrokers(
  dataDir: string,
  provider: BrokerCleanupReferenceProvider,
  testSpawn?: typeof spawn
): Promise<void> {
  if (active.size >= 2 || (process.env.VITEST && !testSpawn)) return;
  let snapshot: BrokerCleanupReferenceSnapshot | undefined;
  try {
    snapshot = provider();
  } catch {
    return;
  }
  if (
    !snapshot ||
    !Array.isArray(snapshot.references) ||
    snapshot.references.length > 32_768 ||
    !snapshot.references.every(
      (value) => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)
    )
  )
    return;
  const current = () => {
    try {
      const result: unknown = snapshot!.isCurrent();
      if (result && typeof (result as { then?: unknown }).then === 'function')
        void Promise.resolve(result).catch(() => {});
      return result === true;
    } catch {
      return false;
    }
  };
  if (!current()) return;
  const retiredRollbacks = new Set<string>();
  const cleaned = await runBrokerCleanup(
    { dataDir, references: snapshot.references, scanOffset: discoveryOffsets.get(dataDir) ?? 0 },
    (value) => {
      if (Object.keys(value).join(',') === 'empty') {
        return (
          typeof value.empty === 'string' &&
          /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.empty) &&
          current()
        );
      }
      const [sid, inc, extra] = typeof value.ready === 'string' ? value.ready.split('/') : [];
      return (
        Object.keys(value).join(',') === 'ready' &&
        extra === undefined &&
        !!sid &&
        !!inc &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(sid) &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(inc) &&
        !snapshot!.references.includes(inc) &&
        current()
      );
    },
    testSpawn,
    undefined,
    (value) => {
      if (Object.keys(value).join(',') === 'scanOffset') {
        if (
          !Number.isSafeInteger(value.scanOffset) ||
          (value.scanOffset as number) < 0 ||
          (value.scanOffset as number) > 512
        )
          return false;
        discoveryOffsets.delete(dataDir);
        discoveryOffsets.set(dataDir, value.scanOffset as number);
        if (discoveryOffsets.size > 32) discoveryOffsets.delete(discoveryOffsets.keys().next().value!);
        return true;
      }
      if (Object.keys(value).join(',') !== 'rolledBack') return false;
      const [sid, inc, extra] = typeof value.rolledBack === 'string' ? value.rolledBack.split('/') : [];
      if (
        extra !== undefined ||
        !sid ||
        !inc ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(sid) ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(inc) ||
        snapshot!.references.includes(inc) ||
        !current()
      )
        return false;
      retiredRollbacks.add(`${sid}/${inc}`);
      return true;
    }
  );
  if (cleaned) {
    for (const [key, pending] of pendingRollbacks) {
      const receipt = pending.receipt;
      if (
        retiredRollbacks.has(`${receipt.sessionId}/${receipt.incarnation}`) &&
        receipt.root === join(dataDir, 'codex-input-brokers', receipt.sessionId)
      )
        pendingRollbacks.delete(key);
    }
    scheduleRollbackSweep();
  }
}

/** Captured only by create(); rollback callers must certify no native dispatch was attempted. */
export interface BrokerProvisioningRollback {
  root: string;
  sessionId: string;
  incarnation: string;
  directory: { dev: number; ino: number };
  parents: Array<{ path: string; dev: number; ino: number }>;
  files: Array<{ name: string; dev: number; ino: number; size: number; hash: string }>;
}
/** Publish only complete private receipts; existing marker names are never replaced. */
async function persistRollbackReceipt(receipt: BrokerProvisioningRollback): Promise<'retained' | 'retry'> {
  let staging: string | undefined,
    created: Stats | undefined,
    publicationAllowed = false,
    linkAttempted = false;
  const bytes = Buffer.from(JSON.stringify(receipt));
  const marker = join(receipt.root, `.rollback-${receipt.incarnation}.json`);
  const privateFile = (stat: Stats) =>
    stat.isFile() && (stat.mode & 0o077) === 0 && (process.getuid === undefined || stat.uid === process.getuid());
  const same = (left: Stats, right: Stats) =>
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
  const parentsCurrent = async () => {
    if ((await fs.realpath(receipt.root)) !== receipt.root) return false;
    for (const parent of receipt.parents) {
      const stat = await fs.lstat(parent.path);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.dev !== parent.dev ||
        stat.ino !== parent.ino ||
        (stat.mode & 0o022) !== 0 ||
        (process.getuid !== undefined && stat.uid !== process.getuid())
      )
        return false;
    }
    return true;
  };
  const owned = async (path: string, partial = false) => {
    if (!created) return undefined;
    const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (
        !privateFile(before) ||
        before.dev !== created.dev ||
        before.ino !== created.ino ||
        before.size > bytes.length ||
        (!partial && before.size !== bytes.length)
      )
        return undefined;
      const buffer = Buffer.alloc(before.size + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return bytesRead === before.size &&
        buffer.subarray(0, bytesRead).equals(bytes.subarray(0, bytesRead)) &&
        same(before, await handle.stat()) &&
        (await parentsCurrent()) &&
        same(before, await fs.lstat(path))
        ? before
        : undefined;
    } finally {
      await handle.close();
    }
  };
  try {
    if (
      !isAbsolute(receipt.root) ||
      normalize(receipt.root) !== receipt.root ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(receipt.incarnation) ||
      !(await parentsCurrent())
    )
      return 'retained';
    const directory = await fs.lstat(join(receipt.root, receipt.incarnation));
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      directory.dev !== receipt.directory.dev ||
      directory.ino !== receipt.directory.ino ||
      (directory.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && directory.uid !== process.getuid())
    )
      return 'retained';
    publicationAllowed = true;
    staging = join(receipt.root, `.rollback-${receipt.incarnation}.${randomUUID()}.next`);
    const handle = await fs.open(staging, 'wx', 0o600);
    try {
      created = await handle.stat();
      if (!privateFile(created) || created.size !== 0) throw new Error('Rollback staging changed');
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const staged = await owned(staging);
    if (!staged || !(await parentsCurrent()) || !same(staged, await fs.lstat(staging)))
      throw new Error('Rollback staging changed');
    // link is an atomic, exclusive commit: a foreign final name is never replaced.
    linkAttempted = true;
    await fs.link(staging, marker);
    if (!(await owned(marker))) throw new Error('Rollback publication changed');
    const parent = await fs.open(receipt.root, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await parent.stat();
      if (stat.dev !== receipt.parents[0]?.dev || stat.ino !== receipt.parents[0]?.ino) return 'retry';
      await parent.sync();
    } finally {
      await parent.close();
    }
    return 'retained';
  } catch (error) {
    if (linkAttempted && (error as NodeJS.ErrnoException).code === 'EEXIST') return 'retained';
    // A lost link/fsync acknowledgement may leave a complete owned final file.
    if (linkAttempted && (await owned(marker).catch(() => false))) return 'retained';
    return publicationAllowed ? 'retry' : 'retained';
  } finally {
    // Partial writes can be removed only with this invocation's inode and exact
    // byte-prefix proof. Unknown/replaced staging survives untouched.
    if (staging) {
      const captured = await owned(staging, true).catch(() => undefined);
      if (captured) {
        try {
          if ((await parentsCurrent()) && same(captured, await fs.lstat(staging))) await fs.unlink(staging);
        } catch {
          /* Uncertain cleanup retains staging; it never blocks a fresh exclusive attempt. */
        }
      }
    }
  }
}

type PendingRollback = {
  receipt: BrokerProvisioningRollback;
  spawn?: typeof spawn;
  retry: boolean;
  attempts: number;
  nextRetryAt: number;
  retryPublication?: boolean;
  work?: Promise<boolean>;
};
// Keep exact ownership proof until deletion is positively acknowledged. One
// unref'ed sweep admits at most two retries per tick and rotates serviced entries
// behind their peers; unavailable helpers back off rather than becoming inert.
const pendingRollbacks = new Map<string, PendingRollback>();
const ROLLBACK_RETRY_MIN_MS = 2_100;
const ROLLBACK_RETRY_MAX_MS = 60_000;
let rollbackSweep: ReturnType<typeof setTimeout> | undefined;
let rollbackSweepAt = Infinity;
function scheduleRollbackSweep(): void {
  let next = Infinity;
  for (const pending of pendingRollbacks.values()) {
    if (pending.retry && !pending.work) next = Math.min(next, pending.nextRetryAt);
  }
  if (!Number.isFinite(next)) {
    if (rollbackSweep) clearTimeout(rollbackSweep);
    rollbackSweep = undefined;
    rollbackSweepAt = Infinity;
    return;
  }
  const now = performance.now();
  const at = Math.max(next, now + ROLLBACK_RETRY_MIN_MS);
  if (rollbackSweep && rollbackSweepAt <= at) return;
  if (rollbackSweep) clearTimeout(rollbackSweep);
  rollbackSweepAt = at;
  rollbackSweep = setTimeout(() => {
    rollbackSweep = undefined;
    rollbackSweepAt = Infinity;
    const due = performance.now();
    let admitted = 0;
    for (const [key, pending] of [...pendingRollbacks]) {
      if (!pending.retry || pending.work || pending.nextRetryAt > due) continue;
      pendingRollbacks.delete(key);
      pendingRollbacks.set(key, pending);
      void attemptRollback(key, pending);
      if (++admitted === 2) break;
    }
    scheduleRollbackSweep();
  }, at - now);
  rollbackSweep.unref?.();
}
function attemptRollback(key: string, pending: PendingRollback): Promise<boolean> {
  if (pending.work) return pending.work;
  pending.attempts = Math.min(pending.attempts + 1, 6);
  const request = pending.receipt;
  const publication = pending.retryPublication
    ? persistRollbackReceipt(request).then((result) => {
        pending.retryPublication = result === 'retry';
      })
    : Promise.resolve();
  const work = publication
    .then(() =>
      runBrokerCleanup(
        { rollback: request },
        (value) =>
          Object.keys(value).join(',') === 'rollback' &&
          value.rollback === `${request.sessionId}/${request.incarnation}`,
        pending.spawn,
        (value) =>
          Object.keys(value).join(',') === 'rolledBack' &&
          value.rolledBack === `${request.sessionId}/${request.incarnation}`
      )
    )
    .catch(() => false)
    .then((removed) => {
      pending.work = undefined;
      if (removed) pendingRollbacks.delete(key);
      else
        pending.nextRetryAt =
          performance.now() + Math.min(ROLLBACK_RETRY_MAX_MS, ROLLBACK_RETRY_MIN_MS * 2 ** (pending.attempts - 1));
      scheduleRollbackSweep();
      return removed;
    });
  pending.work = work;
  return work;
}
/** True requires terminal deletion/anchored-absence ACK; failed receipts stay retryable.
 * testSpawn/testRetry exercise disposable janitors only; neither is a runtime option. */
export async function rollbackCodexBrokerProvisioning(
  receipt: BrokerProvisioningRollback,
  testSpawn?: typeof spawn,
  testRetry = !process.env.VITEST
): Promise<boolean> {
  const key = JSON.stringify(receipt);
  if (Buffer.byteLength(key) > 262_144) return false;
  const captured: BrokerProvisioningRollback = JSON.parse(key);
  let pending = pendingRollbacks.get(key);
  if (!pending) {
    if (pendingRollbacks.size >= 256) {
      await persistRollbackReceipt(captured);
      return false;
    }
    pending = {
      receipt: captured,
      spawn: testSpawn,
      retry: testRetry,
      attempts: 0,
      nextRetryAt: Infinity,
    };
    pendingRollbacks.set(key, pending);
  } else {
    if (pending.work) return pending.work;
    pending.spawn = testSpawn;
    pending.retry = testRetry;
  }
  // Own publication and cleanup together: duplicate callers cannot accumulate
  // staging writes while this receipt's first write is still pending.
  pending.retryPublication = true;
  return attemptRollback(key, pending);
}

async function runBrokerCleanup(
  request: object,
  accept: (value: Record<string, unknown>) => boolean,
  testSpawn?: typeof spawn,
  complete?: (value: Record<string, unknown>) => boolean,
  notification?: (value: Record<string, unknown>) => boolean
): Promise<boolean> {
  if (active.size >= 2 || (process.env.VITEST && !testSpawn)) return false;
  const serialized = JSON.stringify(request);
  if (Buffer.byteLength(serialized) > 2_097_152) return false;
  let child: ChildProcessWithoutNullStreams;
  try {
    child = (testSpawn ?? spawn)('python3', ['-I', '-c', CODEX_BROKER_CLEANUP_SOURCE], {
      env: { PATH: process.env.PATH, LANG: 'C.UTF-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
  } catch {
    return false;
  }
  active.add(child);
  return new Promise<boolean>((resolve) => {
    let output = '',
      bytes = 0,
      settled = false,
      acknowledged = false,
      completed = false,
      failed = false;
    const finish = (success = false) => {
      if (!settled) {
        settled = true;
        resolve(success && acknowledged && (!complete || completed) && !failed && output.length === 0);
      }
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish();
    }, 2_000);
    child.on('close', (code) => {
      active.delete(child);
      clearTimeout(timeout);
      finish(code === 0);
    });
    child.on('error', () => {
      child.kill('SIGKILL');
      finish();
    });
    child.stdin.on('error', () => {});
    child.stderr.on('data', (data: Buffer) => {
      bytes += data.length;
      if (bytes > 65_536) {
        failed = true;
        child.kill('SIGKILL');
      }
    });
    child.stdout.on('data', (data: Buffer) => {
      bytes += data.length;
      output += data.toString('utf8');
      if (bytes > 65_536) {
        failed = true;
        child.kill('SIGKILL');
        return;
      }
      let at: number;
      while ((at = output.indexOf('\n')) !== -1) {
        const line = output.slice(0, at);
        output = output.slice(at + 1);
        try {
          const value = JSON.parse(line);
          // Periodic discovery can retire several exact proofs. Completion
          // notices never send an ACK that a later READY could accidentally use.
          if (notification?.(value)) continue;
          if (acknowledged && !completed && complete?.(value)) {
            completed = true;
            continue;
          }
          if (completed || !accept(value)) {
            failed = true;
            child.kill('SIGKILL');
            return;
          }
          acknowledged = true;
          child.stdin.write('ACK\n');
        } catch {
          failed = true;
          child.kill('SIGKILL');
          return;
        }
      }
    });
    child.stdin.write(serialized + '\n');
  });
}
