/** Real isolated rollout witnesses with injected file-open replacements; no FIFO or worker is launched. */
import { constants, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fakeInputProvenance } from './helpers/codex-input-provenance.js';
import type { CodexBrokerProof } from '../src/recovery/codex-input-broker.js';
import { afterEach, expect, it, vi } from 'vitest';
import type { Session } from '../src/session.js';
import { CodexRecoveryAdapter } from '../src/recovery/codex-adapter.js';
import { confirmCodexIdentityWitness, resolveCodexIdentity } from '../src/recovery/codex-identity.js';

const boundary = { path: '', kind: '', read: false, reads: 0, flags: [] as number[] };
function injectFinalOpen() {
  const open = fs.open.bind(fs);
  const replace = async () => {
    const copy = boundary.path + '.replacement';
    await fs.copyFile(boundary.path, copy);
    await fs.rename(copy, boundary.path);
  };
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    if (String(args[0]) !== boundary.path) return open(...args);
    boundary.flags.push(Number(args[1]));
    if (boundary.kind === 'inode-before') await replace();
    const file = await open(...args);
    const stat = file.stat.bind(file);
    const read = file.read.bind(file);
    vi.spyOn(file, 'stat').mockImplementation(async (...statArgs) => {
      const value = (await stat(...statArgs)) as Stats;
      if (boundary.kind === 'fifo-before') return Object.assign(value, { isFile: () => false });
      if (boundary.read && boundary.kind.startsWith('after-')) {
        const field = boundary.kind.slice(6) as 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs';
        if (field in value) Object.assign(value, { [field]: value[field] + 1 });
      }
      return value;
    });
    vi.spyOn(file, 'read').mockImplementation(async (...readArgs) => {
      const value = await Reflect.apply(read, file, readArgs);
      boundary.reads++;
      boundary.read = true;
      if (boundary.kind === 'path-after-read') await replace();
      return value;
    });
    return file;
  });
}

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
  Object.assign(boundary, { path: '', kind: '', read: false, reads: 0, flags: [] });
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
  injectFinalOpen();
  if (kind === 'missing-leaf') identity.witness!.paths = identity.witness!.paths.filter((input) => input.path !== path);
  if (kind === 'truncated') identity.tailTruncated = true;
  if (kind === 'unknown-truncation') delete identity.tailTruncated;
  const config = { noDaemon: true, resumeSessionId: THREAD };
  const inputProof = fakeInputProvenance();
  const session = {
    inspectRecoveryInputProvenance: async () => structuredClone(inputProof),
    getRecoveryInputAuthority: (proof: CodexBrokerProof) => ({
      sessionId: SESSION,
      incarnation: proof.incarnation,
      directory: dirname(proof.fileWitness!.path),
      proof,
      files: [proof.fileWitness!],
    }),
    id: SESSION,
    getRecoveryContext: () => ({ generation: 4 }),
    getEnvOverridesForPersist: () => undefined,
    codexConfig: config,
  } as unknown as Session;
  const adapter = new CodexRecoveryAdapter(session, () => {});
  Reflect.set(adapter, 'verifiedTail', {
    ...identity,
    inputProof,
    config: JSON.stringify(config),
    env: JSON.stringify(undefined),
  });
  expect(await adapter.confirmLocalEvidence(THREAD, 4)).toBe(kind === 'healthy');
  if (kind === 'healthy') expect(await confirmCodexIdentityWitness(identity)).toBe(true);
  else expect(await confirmCodexIdentityWitness(identity)).toBe(false);
  for (const flags of boundary.flags) {
    expect(flags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
    expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
  }
  if (['fifo-before', 'inode-before', 'missing-leaf', 'truncated', 'unknown-truncation'].includes(kind))
    expect(boundary.reads).toBe(0);
  if (kind === 'healthy') expect(boundary.reads).toBe(3);
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

it.each(['healthy', 'false', 'async-current', 'rejected-current', 'throwing-current'] as const)(
  'requires literal synchronous current authority for bundled witness sources: %s',
  async (kind) => {
    const { identity } = await fixture();
    const config = { noDaemon: true, resumeSessionId: THREAD };
    const inputProof = fakeInputProvenance();
    const session = {
      inspectRecoveryInputProvenance: async () => structuredClone(inputProof),
      getRecoveryInputAuthority: (proof: CodexBrokerProof) => ({
        sessionId: SESSION,
        incarnation: proof.incarnation,
        directory: dirname(proof.fileWitness!.path),
        proof,
        files: [proof.fileWitness!],
      }),
      id: SESSION,
      getRecoveryContext: () => ({ generation: 4 }),
      getEnvOverridesForPersist: () => undefined,
      codexConfig: config,
    } as unknown as Session;
    const adapter = new CodexRecoveryAdapter(session, () => {});
    Reflect.set(adapter, 'verifiedTail', {
      ...identity,
      inputProof,
      config: JSON.stringify(config),
      env: JSON.stringify(undefined),
    });
    const source = {
      sessionId: SESSION,
      identity,
      isCurrent: (() => {
        if (kind === 'async-current') return Promise.resolve(true);
        if (kind === 'rejected-current') return Promise.reject(new Error('Malformed current fixture'));
        if (kind === 'throwing-current') throw new Error('Malformed current fixture');
        return kind === 'healthy';
      }) as () => boolean,
    };
    const open = vi.spyOn(fs, 'open');
    expect(await adapter.confirmLocalEvidence(THREAD, 4, source)).toBe(kind === 'healthy');
    expect(open.mock.calls.filter(([path]) => String(path) === identity.path)).toHaveLength(kind === 'healthy' ? 3 : 0);
  }
);
