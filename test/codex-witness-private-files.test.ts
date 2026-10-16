/** Related broker/grant files cannot become stale during the rollout's final read. */
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { resolveCodexIdentity } from '../src/recovery/codex-identity.js';
import { checkCodexIdentityWitnesses } from '../src/recovery/codex-witness-check.js';
import type { PrivateFileWitness } from '../src/recovery/private-file-witness.js';

const roots: string[] = [];
const releases: Array<() => void> = [];
afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  await new Promise<void>((done) => setImmediate(done));
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const deferred = () => {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => {
      resolve = done;
    }),
    resolve: () => resolve(),
  };
};

async function fixture() {
  const root = await fs.mkdtemp(join(homedir(), 'codex-private-proof-'));
  roots.push(root);
  const home = join(root, 'home');
  await fs.mkdir(join(home, 'sessions'), { recursive: true });
  const thread = '11111111-2222-3333-4444-555555555555';
  const rollout = join(home, 'sessions', `rollout-2026-10-13T12-00-00-${thread}.jsonl`);
  const tail =
    JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-10-13T12:00:00Z',
      payload: { id: thread, cwd: home, originator: 'codeman_fixture' },
    }) + '\n';
  await fs.writeFile(rollout, tail);
  const identity = await resolveCodexIdentity({
    sessionId: 'fixture',
    workingDir: home,
    codexHome: home,
    resumeId: thread,
    noDaemon: true,
  });
  expect(identity.reason).toBe('verified');
  const path = join(root, 'private.json');
  const raw = JSON.stringify({ tainted: false, permission: 'owner' });
  await fs.writeFile(path, raw, { mode: 0o600 });
  const stat = await fs.lstat(path);
  const file: PrivateFileWitness = {
    path,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    hash: hash(raw),
    maxBytes: 2_097_152,
  };
  return { root, identity, rollout, path, raw, file };
}

function hold(path: string, boundary: 'read' | 'close') {
  const entered = deferred(),
    release = deferred(),
    closed = deferred();
  releases.push(release.resolve);
  const open = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const file = await open(...args);
    if (String(args[0]) !== path) return file;
    const read = file.read.bind(file),
      close = file.close.bind(file);
    vi.spyOn(file, 'read').mockImplementation(async (...args) => {
      if (boundary === 'read') {
        entered.resolve();
        await release.promise;
      }
      return Reflect.apply(read, file, args);
    });
    vi.spyOn(file, 'close').mockImplementation(async () => {
      if (boundary === 'close') {
        entered.resolve();
        await release.promise;
      }
      try {
        await close();
      } finally {
        closed.resolve();
      }
    });
    return file;
  });
  return { entered, release, closed };
}

it('accepts an unchanged private file and verifies bytes beyond the rollout-only size limit', async () => {
  const f = await fixture();
  expect(await checkCodexIdentityWitnesses([f.identity], [f.file])).toBe(true);
  const raw = 'x'.repeat(262_145);
  await fs.writeFile(f.path, raw);
  const stat = await fs.lstat(f.path);
  expect(
    await checkCodexIdentityWitnesses(
      [f.identity],
      [{ ...f.file, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, hash: hash(raw) }]
    )
  ).toBe(true);
});

it.each([
  { waiting: 'rollout', boundary: 'read', changed: 'private' },
  { waiting: 'private', boundary: 'read', changed: 'rollout' },
  { waiting: 'private', boundary: 'close', changed: 'rollout' },
  { waiting: 'rollout', boundary: 'close', changed: 'private' },
] as const)('refuses $changed changes during $waiting $boundary', async ({ waiting, boundary, changed }) => {
  const f = await fixture();
  const gate = hold(waiting === 'private' ? f.path : f.rollout, boundary);
  const checking = checkCodexIdentityWitnesses([f.identity], [f.file]);
  await gate.entered.promise;
  await fs.appendFile(changed === 'private' ? f.path : f.rollout, '\n');
  gate.release.resolve();
  expect(await checking).toBe(false);
  await gate.closed.promise;
});

it('refuses changed private bytes even when the caller supplies their newest metadata', async () => {
  const f = await fixture();
  await fs.writeFile(f.path, f.raw.replace('false', 'true '));
  const stat = await fs.lstat(f.path);
  expect(
    await checkCodexIdentityWitnesses(
      [f.identity],
      [{ ...f.file, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }]
    )
  ).toBe(false);
});

it.each(['symlink', 'missing', 'invalid-hash', 'oversized', 'excess-domains'])(
  'refuses %s private evidence',
  async (kind) => {
    const f = await fixture();
    let files = [f.file];
    if (kind === 'symlink') {
      await fs.rename(f.path, f.path + '.target');
      await fs.symlink(f.path + '.target', f.path);
    }
    if (kind === 'missing') await fs.unlink(f.path);
    if (kind === 'invalid-hash') files = [{ ...f.file, hash: 'unknown' }];
    if (kind === 'oversized') files = [{ ...f.file, size: 2_097_153 }];
    if (kind === 'excess-domains') files = Array(9).fill(f.file);
    expect(await checkCodexIdentityWitnesses([f.identity], files)).toBe(false);
  }
);

it('bounds stalled private cleanup under the original deadline and does not create another reader', async () => {
  const f = await fixture();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const gate = hold(f.path, 'close');
  const checking = checkCodexIdentityWitnesses([f.identity], [f.file]);
  await gate.entered.promise;
  const same = checkCodexIdentityWitnesses([f.identity], [{ ...f.file }]);
  const opens = vi.mocked(fs.open).mock.calls.length;
  await vi.advanceTimersByTimeAsync(2_001);
  expect(await checking).toBe(false);
  expect(await same).toBe(false);
  expect(await checkCodexIdentityWitnesses([f.identity], [f.file])).toBe(false);
  expect(fs.open).toHaveBeenCalledTimes(opens);
  gate.release.resolve();
  await gate.closed.promise;
});
