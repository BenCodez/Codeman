/** Real isolated rollout witnesses with injected file-open replacements; no FIFO or worker is launched. */
import { constants, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Session } from '../src/session.js';
import { CodexRecoveryAdapter } from '../src/recovery/codex-adapter.js';
import { confirmCodexIdentityWitness, resolveCodexIdentity } from '../src/recovery/codex-identity.js';

const boundary = vi.hoisted(() => ({ path: '', kind: '', fd: -1, read: false, reads: 0, flags: [] as number[] }));
vi.mock('node:fs', async () => {
  const real = await vi.importActual<typeof import('node:fs')>('node:fs');
  const replace = () => {
    const copy = boundary.path + '.replacement';
    real.writeFileSync(copy, real.readFileSync(boundary.path));
    real.renameSync(copy, boundary.path);
  };
  return {
    ...real,
    openSync: (...args: unknown[]) => {
      if (String(args[0]) === boundary.path) {
        boundary.flags.push(Number(args[1]));
        if (boundary.kind === 'inode-before') replace();
      }
      const fd = Reflect.apply(real.openSync, real, args) as number;
      if (String(args[0]) === boundary.path) boundary.fd = fd;
      return fd;
    },
    fstatSync: (...args: unknown[]) => {
      const stat = Reflect.apply(real.fstatSync, real, args) as Stats;
      if (args[0] !== boundary.fd) return stat;
      if (boundary.kind === 'fifo-before') return Object.assign(stat, { isFile: () => false });
      if (boundary.read && boundary.kind.startsWith('after-')) {
        const field = boundary.kind.slice(6) as 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs';
        if (field in stat) Object.assign(stat, { [field]: stat[field] + 1 });
      }
      return stat;
    },
    readSync: (...args: unknown[]) => {
      const result = Reflect.apply(real.readSync, real, args) as number;
      if (args[0] === boundary.fd) {
        boundary.reads++;
        boundary.read = true;
        if (boundary.kind === 'path-after-read') replace();
      }
      return result;
    },
  };
});

const THREAD = '11111111-2222-3333-4444-555555555555';
const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const homes: string[] = [];
async function fixture() {
  const home = await fs.mkdtemp(join(homedir(), 'codex-open-boundary-'));
  homes.push(home);
  const work = join(home, 'work');
  await fs.mkdir(work);
  await fs.mkdir(join(home, 'sessions'));
  const path = join(home, 'sessions', `rollout-2026-10-13T12-00-00-${THREAD}.jsonl`);
  await fs.writeFile(
    path,
    JSON.stringify({
      timestamp: '2026-10-13T12:00:00Z',
      type: 'session_meta',
      payload: { id: THREAD, cwd: work, originator: `codeman_${SESSION}` },
    }) + '\n'
  );
  const request = { sessionId: SESSION, workingDir: work, codexHome: home, resumeId: THREAD, noDaemon: true };
  const identity = await resolveCodexIdentity(request);
  expect(identity).toMatchObject({ reason: 'verified', conversationId: THREAD, tailTruncated: false });
  return { identity, path, request };
}
afterEach(async () => {
  Object.assign(boundary, { path: '', kind: '', fd: -1, read: false, reads: 0, flags: [] });
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true });
});

it.each([
  'healthy',
  'fifo-before',
  'inode-before',
  'after-dev',
  'after-ino',
  'after-size',
  'after-mtimeMs',
  'after-ctimeMs',
  'path-after-read',
  'missing-leaf',
  'truncated',
  'unknown-truncation',
])('keeps the shared final identity check and actual adapter fence bounded: %s', async (kind) => {
  const { identity, path } = await fixture();
  boundary.path = path;
  boundary.kind = kind;
  if (kind === 'missing-leaf') identity.witness!.paths = identity.witness!.paths.filter((input) => input.path !== path);
  if (kind === 'truncated') identity.tailTruncated = true;
  if (kind === 'unknown-truncation') delete identity.tailTruncated;
  const config = { noDaemon: true, resumeSessionId: THREAD };
  const session = {
    getRecoveryContext: () => ({ generation: 4 }),
    getEnvOverridesForPersist: () => undefined,
    codexConfig: config,
  } as unknown as Session;
  const adapter = new CodexRecoveryAdapter(session, () => {});
  Reflect.set(adapter, 'verifiedTail', {
    ...identity,
    config: JSON.stringify(config),
    env: JSON.stringify(undefined),
  });
  expect(adapter.confirmLocalEvidence(THREAD, 4)).toBe(kind === 'healthy');
  if (kind === 'healthy') expect(confirmCodexIdentityWitness(identity)).toBe(true);
  else expect(confirmCodexIdentityWitness(identity)).toBe(false);
  for (const flags of boundary.flags) {
    expect(flags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
    expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
  }
  if (['fifo-before', 'inode-before', 'missing-leaf', 'truncated', 'unknown-truncation'].includes(kind))
    expect(boundary.reads).toBe(0);
  if (kind === 'healthy') expect(boundary.reads).toBe(2);
});

it.each(['healthy', 'fifo-before', 'inode-before'])(
  'opens asynchronous identity windows nonblocking and validates the opened regular file: %s',
  async (kind) => {
    const { path, request } = await fixture();
    const open = fs.open.bind(fs);
    const flags: number[] = [];
    const reads = vi.fn();
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (String(args[0]) !== path) return open(...args);
      flags.push(Number(args[1]));
      if (kind === 'inode-before') {
        await fs.copyFile(path, path + '.replacement');
        await fs.rename(path + '.replacement', path);
      }
      const handle = await open(...args);
      const stat = handle.stat.bind(handle);
      const read = handle.read.bind(handle);
      vi.spyOn(handle, 'read').mockImplementation((...readArgs) => {
        reads();
        return Reflect.apply(read, handle, readArgs);
      });
      if (kind === 'fifo-before')
        vi.spyOn(handle, 'stat').mockImplementation(async () => Object.assign(await stat(), { isFile: () => false }));
      return handle;
    });
    const identity = await resolveCodexIdentity(request);
    expect(identity.reason === 'verified').toBe(kind === 'healthy');
    expect(flags.length).toBeGreaterThan(0);
    for (const flag of flags) expect(flag & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
    if (kind !== 'healthy') {
      expect(identity.conversationId).toBeUndefined();
      expect(reads).not.toHaveBeenCalled();
    } else expect(reads).toHaveBeenCalled();
  }
);
