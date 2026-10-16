/** Private durable identity veto, acknowledged asynchronously before thread-changing input. */
import { constants, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDataDirPath } from '../config/instance.js';
import { validSubmissionClock, type RecoverySubmission } from './remote-clock.js';

export interface RebootIdentityFence {
  switchPending: boolean;
  submission?: RecoverySubmission;
  /** Exact UUID validated and launched by a completed new-pane reboot restore. */
  resumeSessionId?: string;
  untrackedInput?: boolean;
}
export class RebootIdentityFenceError extends Error {
  constructor() {
    super('Conversation identity could not be saved before input');
    this.name = 'RebootIdentityFenceError';
  }
}
export function rebootIdentityFencePath(id: string): string {
  if (!/^[\w-]{1,100}$/.test(id)) throw new Error('Invalid reboot identity');
  return join(getDataDirPath(), 'reboot-identities', `${id}.json`);
}
type FenceFile = Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>;
const sameFile = (a: FenceFile, b: FenceFile) =>
  (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const).every((key) => a[key] === b[key]);
const committedVetoes = new Map<string, { veto: 'pending' | 'untracked'; file: FenceFile }>();
// Retain actual work until it settles, including after a caller's timeout. A
// subsequent clean write cannot overtake an older pending/uncertain operation.
const pending = new Map<string, Promise<unknown>>();
const BUDGET_MS = 2000;
async function bounded<T>(
  path: string,
  operation: (check: () => void) => Promise<T>,
  originalDeadline = Infinity
): Promise<T> {
  if (pending.has(path) || pending.size >= 2) throw new RebootIdentityFenceError();
  const deadline = Math.min(performance.now() + BUDGET_MS, originalDeadline);
  if (!Number.isFinite(deadline) || deadline <= performance.now()) throw new RebootIdentityFenceError();
  const check = () => {
    if (performance.now() >= deadline) throw new RebootIdentityFenceError();
  };
  const work = Promise.resolve().then(() => operation(check));
  pending.set(path, work);
  void work.then(
    () => {
      if (pending.get(path) === work) pending.delete(path);
    },
    () => {
      if (pending.get(path) === work) pending.delete(path);
    }
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RebootIdentityFenceError()), Math.max(0, deadline - performance.now()));
      }),
    ]);
    check();
    return value;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function snapshot(
  path: string,
  check: () => void
): Promise<{ value: RebootIdentityFence; text: string; file: FenceFile } | undefined> {
  check();
  let before: Stats;
  try {
    before = await fs.lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      check();
      return undefined;
    }
    throw error;
  }
  check();
  if (!before.isFile() || before.isSymbolicLink() || before.size > 1024) throw new RebootIdentityFenceError();
  let file: Awaited<ReturnType<typeof fs.open>> | undefined;
  let text: string, opened: Stats;
  try {
    file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    check();
    opened = await file.stat();
    check();
    if (!opened.isFile() || !sameFile(before, opened)) throw new RebootIdentityFenceError();
    const bytes = Buffer.alloc(opened.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await file.read(bytes, size, bytes.length - size, size);
      check();
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    const after = await file.stat();
    check();
    if (size !== opened.size || !sameFile(opened, after)) throw new RebootIdentityFenceError();
    const data = bytes.subarray(0, size);
    text = data.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(data)) throw new RebootIdentityFenceError();
    await file.close();
    file = undefined;
    check();
  } finally {
    if (file) await file.close().catch(() => {});
  }
  const current = await fs.lstat(path);
  check();
  if (!current.isFile() || current.isSymbolicLink() || !sameFile(opened!, current))
    throw new RebootIdentityFenceError();
  return { value: parseRebootIdentityFence(text!), text: text!, file: current };
}
async function remains(path: string, expected: FenceFile | undefined, check: () => void): Promise<void> {
  let current: Stats;
  try {
    current = await fs.lstat(path);
  } catch (error) {
    check();
    if (!expected && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  check();
  if (!expected || !current.isFile() || current.isSymbolicLink() || !sameFile(expected, current))
    throw new RebootIdentityFenceError();
}
async function syncDirectory(path: string, check: () => void): Promise<void> {
  let file: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    file = await fs.open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    check();
    await file.sync();
    check();
  } finally {
    if (file) await file.close();
  }
  check();
}
/** A busy or timed-out journal is known unsent; callers retain and retry their original input identity. */
export async function writeRebootIdentityFence(
  id: string,
  identity: RebootIdentityFence,
  isCurrent: () => boolean = () => true
): Promise<RebootIdentityFence> {
  const path = rebootIdentityFencePath(id);
  const captured = structuredClone(identity);
  try {
    return await bounded(path, async (deadlineCheck) => {
      const check = () => {
        deadlineCheck();
        if (isCurrent() !== true) throw new RebootIdentityFenceError();
      };
      check();
      const existing = await snapshot(path, check);
      const cached = committedVetoes.get(path);
      const untrackedInput =
        captured.untrackedInput === true || existing?.value.untrackedInput === true || cached?.veto === 'untracked';
      const durable = untrackedInput ? { ...captured, untrackedInput: true } : captured;
      const veto = untrackedInput
        ? 'untracked'
        : durable.switchPending && durable.submission === undefined
          ? 'pending'
          : undefined;
      const previousVeto = existing?.value.untrackedInput
        ? 'untracked'
        : existing?.value.switchPending && existing.value.submission === undefined
          ? 'pending'
          : undefined;
      if (veto && cached?.veto === veto && previousVeto === veto && existing && sameFile(cached.file, existing.file))
        return existing.value;
      committedVetoes.delete(path);
      const temporary = `${path}.${randomUUID()}.tmp`;
      const text = JSON.stringify({ version: 1, ...durable });
      if (Buffer.byteLength(text) > 1024) throw new RebootIdentityFenceError();
      let temporaryPresent = true;
      let renameAttempted = false;
      let ownedTemporary: { dev: number; ino: number } | undefined;
      try {
        await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
        check();
        const parent = await fs.lstat(dirname(path));
        check();
        if (!parent.isDirectory() || parent.isSymbolicLink()) throw new RebootIdentityFenceError();
        await syncDirectory(dirname(dirname(path)), check);
        const file = await fs.open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          0o600
        );
        try {
          check();
          const opened = await file.stat();
          ownedTemporary = { dev: opened.dev, ino: opened.ino };
          check();
          await file.writeFile(text);
          check();
          await file.sync();
          check();
        } finally {
          await file.close();
        }
        check();
        const ready = await snapshot(temporary, check);
        if (
          !ready ||
          ready.file.dev !== ownedTemporary?.dev ||
          ready.file.ino !== ownedTemporary?.ino ||
          ready.text !== text
        )
          throw new RebootIdentityFenceError();
        const stillExisting = await snapshot(path, check);
        if (
          existing
            ? !stillExisting || stillExisting.text !== existing.text || !sameFile(stillExisting.file, existing.file)
            : stillExisting !== undefined
        )
          throw new RebootIdentityFenceError();
        // Both private read handles are closed before the common pathname scan.
        await remains(temporary, ready.file, check);
        await remains(path, stillExisting?.file, check);
        check();
        renameAttempted = true;
        await fs.rename(temporary, path);
        temporaryPresent = false;
        check();
        await syncDirectory(dirname(path), check);
        const acknowledged = await snapshot(path, check);
        if (
          !acknowledged ||
          acknowledged.text !== text ||
          acknowledged.file.dev !== ownedTemporary?.dev ||
          acknowledged.file.ino !== ownedTemporary?.ino
        )
          throw new RebootIdentityFenceError();
        if (veto) {
          if (committedVetoes.size >= 256) committedVetoes.clear();
          committedVetoes.set(path, { veto, file: acknowledged.file });
        }
        return acknowledged.value;
      } catch (error) {
        // A cancelled clean publication may have reached rename already. Restore
        // only this invocation's exact clean inode to its captured pending veto;
        // never replace a foreign/newer primary, and never extend the I/O budget.
        if (renameAttempted && !durable.switchPending && existing?.value.switchPending && ownedTemporary) {
          let rollbackPath: string | undefined;
          let rollbackOwned: { dev: number; ino: number } | undefined;
          try {
            const clean = await snapshot(path, deadlineCheck);
            if (
              clean &&
              clean.text === text &&
              clean.file.dev === ownedTemporary.dev &&
              clean.file.ino === ownedTemporary.ino
            ) {
              rollbackPath = `${path}.${randomUUID()}.tmp`;
              const rollback = await fs.open(
                rollbackPath,
                constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK,
                0o600
              );
              try {
                deadlineCheck();
                const info = await rollback.stat();
                rollbackOwned = { dev: info.dev, ino: info.ino };
                deadlineCheck();
                await rollback.writeFile(existing.text);
                deadlineCheck();
                await rollback.sync();
                deadlineCheck();
              } finally {
                await rollback.close();
              }
              const ready = await snapshot(rollbackPath, deadlineCheck),
                stillClean = await snapshot(path, deadlineCheck);
              if (
                !ready ||
                ready.text !== existing.text ||
                ready.file.dev !== rollbackOwned.dev ||
                ready.file.ino !== rollbackOwned.ino ||
                !stillClean ||
                stillClean.text !== clean.text ||
                !sameFile(stillClean.file, clean.file)
              )
                throw new RebootIdentityFenceError();
              await remains(rollbackPath, ready.file, deadlineCheck);
              await remains(path, stillClean.file, deadlineCheck);
              deadlineCheck();
              await fs.rename(rollbackPath, path);
              rollbackPath = undefined;
              await syncDirectory(dirname(path), deadlineCheck);
            }
          } catch {
            /* Unknown restoration stays fenced in the live Session. */
          } finally {
            if (rollbackPath && rollbackOwned) {
              try {
                const info = await fs.lstat(rollbackPath);
                if (
                  info.isFile() &&
                  !info.isSymbolicLink() &&
                  info.dev === rollbackOwned.dev &&
                  info.ino === rollbackOwned.ino
                )
                  await fs.unlink(rollbackPath);
              } catch {
                /* Unknown private entries are retained. */
              }
            }
          }
        }
        throw error;
      } finally {
        if (temporaryPresent && ownedTemporary) {
          try {
            const owned = await fs.lstat(temporary);
            if (
              owned.isFile() &&
              !owned.isSymbolicLink() &&
              owned.dev === ownedTemporary.dev &&
              owned.ino === ownedTemporary.ino
            )
              await fs.unlink(temporary);
          } catch {
            /* An unknown replacement or lost unlink acknowledgement is retained. */
          }
        }
      }
    });
  } catch {
    throw new RebootIdentityFenceError();
  }
}
/** Missing is legacy; unknown reads keep recovery fenced and can be retried later. */
export async function readRebootIdentityFence(id: string, deadline?: number): Promise<RebootIdentityFence | undefined> {
  try {
    return await loadRebootIdentityFence(id, deadline);
  } catch {
    return { switchPending: true };
  }
}
/** Initialisation needs to distinguish unavailable evidence from a known durable pending veto. */
export async function loadRebootIdentityFence(id: string, deadline?: number): Promise<RebootIdentityFence | undefined> {
  const path = rebootIdentityFencePath(id);
  return bounded(path, async (check) => (await snapshot(path, check))?.value, deadline);
}

/** Pure parser shared by bounded private launch reads; malformed evidence throws. */
export function parseRebootIdentityFence(text: string): RebootIdentityFence {
  const value = JSON.parse(text);
  if (value.version !== 1 || typeof value.switchPending !== 'boolean') throw new Error('Invalid fence');
  if (
    value.submission !== undefined &&
    (!Number.isFinite(value.submission?.at) ||
      !/^[a-f0-9]{64}$/.test(value.submission?.hash) ||
      !validSubmissionClock(value.submission))
  )
    throw new Error('Invalid proof');
  if (value.untrackedInput !== undefined && typeof value.untrackedInput !== 'boolean')
    throw new Error('Invalid handoff taint');
  if (
    value.resumeSessionId !== undefined &&
    (typeof value.resumeSessionId !== 'string' ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.resumeSessionId))
  )
    throw new Error('Invalid resumed identity');
  return {
    switchPending: value.switchPending,
    submission: value.submission,
    ...(value.resumeSessionId !== undefined ? { resumeSessionId: value.resumeSessionId } : {}),
    ...(value.untrackedInput === true ? { untrackedInput: true } : {}),
  };
}
