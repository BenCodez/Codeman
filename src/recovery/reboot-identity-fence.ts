/** @fileoverview Private synchronous identity fence committed before a thread-changing input is dispatched. */
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDataDirPath } from '../config/instance.js';

export interface RebootIdentityFence {
  switchPending: boolean;
  submission?: { at: number; hash: string };
  /** Exact UUID validated and launched by a completed new-pane reboot restore. */
  resumeSessionId?: string;
  /** Direct tmux owned stdin, so tracked writes can no longer prove the pane's thread. */
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
// Repeated edits of an already-fenced draft need no additional synchronous fsync.
// Cache only a completed durable veto, and invalidate it BEFORE any replacement attempt.
type FenceFile = Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>;
const committedVetoes = new Map<string, { veto: 'pending' | 'untracked'; file: FenceFile }>();
const sameFenceFile = (before: FenceFile, after: FenceFile) =>
  (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const).every((key) => before[key] === after[key]);

function readFenceSnapshot(path: string): { value: RebootIdentityFence; text: string; file: FenceFile } | undefined {
  let before: Stats;
  try {
    before = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > 1024) throw new Error('Invalid fence');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameFenceFile(before, opened)) throw new Error('Fence changed');
    const bytes = Buffer.alloc(1025);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, size);
      if (!count) break;
      size += count;
    }
    if (size > 1024 || size !== opened.size || !sameFenceFile(opened, fstatSync(fd))) throw new Error('Fence changed');
    const after = lstatSync(path);
    if (!after.isFile() || after.isSymbolicLink() || !sameFenceFile(opened, after)) throw new Error('Fence changed');
    const data = bytes.subarray(0, size);
    const text = data.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(data)) throw new Error('Invalid fence');
    return { value: parseRebootIdentityFence(text), text, file: after };
  } finally {
    closeSync(fd);
  }
}

export function writeRebootIdentityFence(id: string, identity: RebootIdentityFence): void {
  const path = rebootIdentityFencePath(id);
  // A supported TUI handoff gives tmux stdin directly. Once that has happened,
  // an ordinary browser Enter can be concurrent with more invisible terminal
  // input and therefore cannot clear the handoff taint. Only deleting/replacing
  // this private identity file as part of a separately proven new-pane lifecycle
  // may establish a fresh identity boundary.
  const cached = committedVetoes.get(path);
  let existing: ReturnType<typeof readFenceSnapshot>;
  try {
    existing = readFenceSnapshot(path);
  } catch {
    // A damaged/replaced fence cannot qualify for the cache shortcut.
  }
  const untrackedInput =
    identity.untrackedInput === true || existing?.value.untrackedInput === true || cached?.veto === 'untracked';
  const durableIdentity = untrackedInput ? { ...identity, untrackedInput: true } : identity;
  const veto: 'pending' | 'untracked' | undefined = untrackedInput
    ? 'untracked'
    : identity.switchPending && identity.submission === undefined
      ? 'pending'
      : undefined;
  const existingVeto = existing?.value.untrackedInput
    ? 'untracked'
    : existing?.value.switchPending && existing.value.submission === undefined
      ? 'pending'
      : undefined;
  if (veto && cached?.veto === veto && existingVeto === veto && existing && sameFenceFile(cached.file, existing.file))
    return;
  committedVetoes.delete(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const text = JSON.stringify({ version: 1, ...durableIdentity });
  try {
    const fenceDirectory = dirname(path);
    mkdirSync(fenceDirectory, { recursive: true, mode: 0o700 });
    // The first fence creates this child directory. Its parent link must be durable too:
    // syncing only the file and child directory can lose the entire fence after reboot.
    // Repeat after a failed parent sync, even though mkdir now finds the directory.
    const parent = openSync(dirname(fenceDirectory), 'r');
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
    const fd = openSync(temporary, 'wx', 0o600);
    let owned: FenceFile | undefined;
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
      try {
        owned = fstatSync(fd);
      } catch {
        // Metadata is only a cache optimization, not part of the durable write.
      }
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    const directory = openSync(dirname(path), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    if (veto) {
      try {
        const acknowledged = readFenceSnapshot(path);
        if (
          acknowledged &&
          owned &&
          acknowledged.file.dev === owned.dev &&
          acknowledged.file.ino === owned.ino &&
          acknowledged.file.size === owned.size &&
          acknowledged.file.mtimeMs === owned.mtimeMs &&
          acknowledged.text === text
        ) {
          if (committedVetoes.size >= 256) committedVetoes.clear();
          committedVetoes.set(path, { veto, file: acknowledged.file });
        }
      } catch {
        // The write was durable; inability to pin its exact inode only disables reuse.
      }
    }
  } catch {
    throw new RebootIdentityFenceError();
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* already renamed */
    }
  }
}

/** Missing means a legacy session. Corruption always leaves restoration fenced. */
export function readRebootIdentityFence(id: string): RebootIdentityFence | undefined {
  try {
    return readFenceSnapshot(rebootIdentityFencePath(id))?.value;
  } catch {
    return { switchPending: true };
  }
}

/** Pure parser shared by bounded private launch reads; malformed evidence throws. */
export function parseRebootIdentityFence(text: string): RebootIdentityFence {
  const value = JSON.parse(text);
  if (value.version !== 1 || typeof value.switchPending !== 'boolean') throw new Error('Invalid fence');
  if (
    value.submission !== undefined &&
    (!Number.isFinite(value.submission?.at) || !/^[a-f0-9]{64}$/.test(value.submission?.hash))
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
