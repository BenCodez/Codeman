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
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataPath } from '../config/instance.js';

export interface RebootIdentityFence {
  switchPending: boolean;
  submission?: { at: number; hash: string };
}
export class RebootIdentityFenceError extends Error {
  constructor() {
    super('Conversation identity could not be saved before input');
    this.name = 'RebootIdentityFenceError';
  }
}
function pathFor(id: string): string {
  if (!/^[\w-]{1,100}$/.test(id)) throw new Error('Invalid reboot identity');
  return dataPath('reboot-identities', `${id}.json`);
}
// Repeated edits of an already-fenced draft need no additional synchronous fsync.
// Cache only a completed durable veto, and invalidate it BEFORE any replacement attempt.
const committedVetoes = new Set<string>();

export function writeRebootIdentityFence(id: string, identity: RebootIdentityFence): void {
  const path = pathFor(id);
  const veto = identity.switchPending && identity.submission === undefined;
  if (veto && committedVetoes.has(path)) return;
  committedVetoes.delete(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ version: 1, ...identity }));
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
      committedVetoes.add(path);
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
    const path = pathFor(id);
    if (!existsSync(path)) return undefined;
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) throw new Error('Invalid fence');
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (value.version !== 1 || typeof value.switchPending !== 'boolean') throw new Error('Invalid fence');
    if (
      value.submission !== undefined &&
      (!Number.isFinite(value.submission?.at) || !/^[a-f0-9]{64}$/.test(value.submission?.hash))
    )
      throw new Error('Invalid proof');
    return { switchPending: value.switchPending, submission: value.submission };
  } catch {
    return { switchPending: true };
  }
}
