/** Bounded private FD verification; a stalled home never blocks the server's event loop. */
import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import type { CodexIdentityResult } from './codex-identity.js';

const pending = new Map<string, { key: string; paths: string[]; deadline: number; work: Promise<boolean> }>();
const TIMEOUT_MS = 2_000;
const MAX_PENDING = 2;

export function checkCodexIdentityWitness(identity: CodexIdentityResult): Promise<boolean> {
  return checkCodexIdentityWitnesses([identity]);
}

/** Read all participating domains before a common final path scan, under one deadline. */
export async function checkCodexIdentityWitnesses(inputs: readonly CodexIdentityResult[]): Promise<boolean> {
  if (!inputs.length || inputs.length > 2) return false;
  const identities = inputs.map((identity) => ({
    ...identity,
    witness: identity.witness && { paths: identity.witness.paths.map((input) => ({ ...input })) },
  }));
  for (const identity of identities) {
    if (
      !identity.path ||
      !identity.witness ||
      identity.tailTruncated !== false ||
      identity.tail === undefined ||
      identity.witness.paths.length > 2_048
    )
      return false;
    const leaf = identity.witness.paths.find((input) => input.path === identity.path && input.kind === 'file');
    if (!leaf || leaf.size === undefined || leaf.mtimeMs === undefined || leaf.ctimeMs === undefined) return false;
  }
  const hashes = identities.map((identity) => createHash('sha256').update(identity.tail!).digest('hex'));
  const paths = identities.map((identity) => identity.path!);
  const group = JSON.stringify(paths);
  const key = JSON.stringify([identities.map((identity) => identity.witness!.paths), hashes]);
  let job = pending.get(group);
  if (job && job.key !== key) return false;
  if (!job) {
    if (
      pending.size >= MAX_PENDING ||
      [...pending.values()].some((other) => paths.some((path) => other.paths.includes(path)))
    )
      return false;
    const deadline = performance.now() + TIMEOUT_MS;
    const work = verify(identities, deadline, hashes);
    job = { key, paths, deadline, work };
    pending.set(group, job);
    void work.finally(() => {
      if (pending.get(group)?.work === work) pending.delete(group);
    });
  }
  const remaining = job.deadline - performance.now();
  if (remaining <= 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const confirmed = await Promise.race([
      job.work,
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), remaining);
      }),
    ]);
    return confirmed === true && performance.now() < job.deadline;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function verify(
  identities: readonly CodexIdentityResult[],
  deadline: number,
  hashes: readonly string[]
): Promise<boolean> {
  const check = () => {
    if (performance.now() >= deadline) throw new Error('Identity verification expired');
  };
  const currentPaths = async () => {
    for (const identity of identities)
      for (const input of identity.witness!.paths) {
        check();
        const stat = await fs.lstat(input.path);
        check();
        if (
          stat.isSymbolicLink() ||
          (input.kind === 'file' ? !stat.isFile() : !stat.isDirectory()) ||
          stat.dev !== input.dev ||
          stat.ino !== input.ino ||
          (input.size !== undefined && stat.size !== input.size) ||
          (input.mtimeMs !== undefined && stat.mtimeMs !== input.mtimeMs) ||
          (input.ctimeMs !== undefined && stat.ctimeMs !== input.ctimeMs)
        )
          return false;
      }
    return true;
  };
  let file: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    if (!(await currentPaths())) return false;
    for (const [index, identity] of identities.entries()) {
      const leaf = identity.witness!.paths.find((input) => input.path === identity.path && input.kind === 'file')!;
      const matchesLeaf = (stat: Stats) =>
        stat.isFile() &&
        stat.dev === leaf.dev &&
        stat.ino === leaf.ino &&
        stat.size === leaf.size &&
        stat.mtimeMs === leaf.mtimeMs &&
        stat.ctimeMs === leaf.ctimeMs;
      check();
      // A late open still reaches cleanup; no domain can authorize while another read is pending.
      file = await fs.open(
        identity.path!,
        constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0)
      );
      check();
      const before = await file.stat();
      check();
      if (!matchesLeaf(before) || before.size > 262_144) return false;
      const bytes = Buffer.alloc(before.size);
      const { bytesRead } = await file.read(bytes, 0, before.size, 0);
      check();
      if (bytesRead !== before.size) return false;
      const after = await file.stat();
      check();
      if (!matchesLeaf(after) || createHash('sha256').update(bytes).digest('hex') !== hashes[index]) return false;
      await file.close();
      file = undefined;
      check();
    }
    // The common phase barrier catches either domain changing during another's read or close.
    return await currentPaths();
  } catch {
    return false;
  } finally {
    if (file) await file.close().catch(() => {});
  }
}
