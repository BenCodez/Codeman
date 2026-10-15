/** @fileoverview Private synchronous identity fence committed before a thread-changing input is dispatched. */
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDataDirPath } from '../config/instance.js';
import { validSubmissionClock, type RecoverySubmission } from './remote-clock.js';

export interface RebootIdentityFence {
  switchPending: boolean;
  submission?: RecoverySubmission;
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
const committedVetoes = new Map<string, 'pending' | 'untracked'>();

export function writeRebootIdentityFence(id: string, identity: RebootIdentityFence): void {
  const path = rebootIdentityFencePath(id);
  // A supported TUI handoff gives tmux stdin directly. Once that has happened,
  // an ordinary browser Enter can be concurrent with more invisible terminal
  // input and therefore cannot clear the handoff taint. Only deleting/replacing
  // this private identity file as part of a separately proven new-pane lifecycle
  // may establish a fresh identity boundary.
  const untrackedInput = identity.untrackedInput === true || readRebootIdentityFence(id)?.untrackedInput === true;
  const durableIdentity = untrackedInput ? { ...identity, untrackedInput: true } : identity;
  const veto: 'pending' | 'untracked' | undefined = untrackedInput
    ? 'untracked'
    : identity.switchPending && identity.submission === undefined
      ? 'pending'
      : undefined;
  if (veto && committedVetoes.get(path) === veto && existsSync(path)) return;
  committedVetoes.delete(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
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
    try {
      writeFileSync(fd, JSON.stringify({ version: 1, ...durableIdentity }));
      fsyncSync(fd);
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
      if (committedVetoes.size >= 256) committedVetoes.clear();
      committedVetoes.set(path, veto);
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
    const path = rebootIdentityFencePath(id);
    if (!existsSync(path)) return undefined;
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) throw new Error('Invalid fence');
    return parseRebootIdentityFence(readFileSync(path, 'utf8'));
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
