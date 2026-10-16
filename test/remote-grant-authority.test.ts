/** Actual owner grant lookup and remote Session authority; panes and effects are exclusively fake. */
import fs from 'node:fs/promises';
import { checkPrivateFileWitnesses } from '../src/recovery/codex-witness-check.js';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import type { MuxSession, TerminalMultiplexer } from '../src/mux-interface.js';
import { dataPath } from '../src/config/instance.js';
import { invalidateUsersCache, findUser } from '../src/user-store.js';
import * as clamp from '../src/session-env-clamp.js';

const THREAD = '11111111-2222-3333-4444-555555555555';
let directory: string;
let previousData: string | undefined;
let previousMode: string | undefined;
const sessions: Session[] = [];
function replace(granted = true) {
  const file = dataPath('users.json');
  writeFileSync(
    `${file}.fixture`,
    JSON.stringify({ version: 1, users: [{ username: 'worker', role: 'user', canBypassPermissions: granted }] })
  );
  renameSync(`${file}.fixture`, file);
}
beforeEach(() => {
  previousData = process.env.CODEMAN_DATA_DIR;
  previousMode = process.env.CODEMAN_MULTIUSER;
  directory = mkdtempSync(join(homedir(), 'remote-grant-'));
  process.env.CODEMAN_DATA_DIR = directory;
  process.env.CODEMAN_MULTIUSER = '1';
  invalidateUsersCache();
  replace();
});
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.stop(false);
  if (previousData === undefined) delete process.env.CODEMAN_DATA_DIR;
  else process.env.CODEMAN_DATA_DIR = previousData;
  if (previousMode === undefined) delete process.env.CODEMAN_MULTIUSER;
  else process.env.CODEMAN_MULTIUSER = previousMode;
  invalidateUsersCache();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});
async function worker() {
  const home = join(directory, 'codex');
  mkdirSync(home);
  const session = new Session({
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    owner: 'worker',
    workingDir: directory,
    mode: 'codex',
    useMux: true,
    mux: { isAvailable: () => true } as TerminalMultiplexer,
    muxSession: { muxName: 'codeman-aaaaaaaa', recoveryIsolated: true, recoveryCodexHome: home } as MuxSession,
    remote: {
      hostId: 'fixture',
      label: 'Fixture',
      host: 'worker.invalid',
      username: 'fixture',
      remotePath: '/fixture/work',
      owned: true,
    },
    codexConfig: { noDaemon: true, resumeSessionId: THREAD, sandbox: 'danger-full-access', approvalPolicy: 'never' },
    envOverrides: { CODEX_HOME: home },
  });
  sessions.push(session);
  expect(await session.ensureRecoveryIdentityFence()).toBe(true);
  return session;
}

it.each(['unchanged', 'external-revoke', 'cache-revoke', 'unreadable', 'mode-change'] as const)(
  'keeps actual final remote authority bound to the current grant snapshot: %s',
  async (change) => {
    const session = await worker();
    const expected = session.remoteRecoveryConfiguration();
    expect(await session.confirmRemoteRecoveryAuthority(THREAD, 0, () => true, expected)).toBe(true);
    expect(session.isRemoteRecoveryAuthorityCurrent(THREAD, 0, () => true, expected)).toBe(true);
    if (change === 'external-revoke') replace(false);
    if (change === 'cache-revoke') (await findUser('worker'))!.canBypassPermissions = false;
    if (change === 'unreadable') writeFileSync(dataPath('users.json'), '{broken-fixture}');
    if (change === 'mode-change') process.env.CODEMAN_MULTIUSER = '0';
    // Disk changes require the fresh bounded proof; the final token is pure.
    if (change === 'external-revoke' || change === 'unreadable')
      expect(await session.confirmRemoteRecoveryAuthority(THREAD, 0, () => true, expected)).toBe(false);
    expect(session.isRemoteRecoveryAuthorityCurrent(THREAD, 0, () => true, expected)).toBe(change === 'unchanged');
  }
);

it('rejects a grant-only microtask change after the final real lookup resolves', async () => {
  const session = await worker();
  const expected = session.remoteRecoveryConfiguration();
  const original = clamp.clampRecoveryLaunchForOwner;
  vi.spyOn(clamp, 'clampRecoveryLaunchForOwner').mockImplementation(async (...args) => {
    const result = await original(...args);
    queueMicrotask(() => replace(false));
    return result;
  });
  expect(await session.confirmRemoteRecoveryAuthority(THREAD, 0, () => true, expected)).toBe(false);
  expect(session.isRemoteRecoveryAuthorityCurrent(THREAD, 0, () => true, expected)).toBe(false);
});

it('cannot reuse an earlier successful snapshot after a denied current confirmation', async () => {
  const session = await worker();
  const expected = session.remoteRecoveryConfiguration();
  expect(await session.confirmRemoteRecoveryAuthority(THREAD, 0, () => true, expected)).toBe(true);
  replace(false);
  expect(await session.confirmRemoteRecoveryAuthority(THREAD, 0, () => true, expected)).toBe(false);
  expect(session.isRemoteRecoveryAuthorityCurrent(THREAD, 0, () => true, expected)).toBe(false);
});

it.each(['unchanged', 'disk-replaced', 'owner-changed', 'cancelled', 'expired'] as const)(
  'rechecks pure scope after the bounded final grant FD read: %s',
  async (change) => {
    const session = await worker(),
      expected = session.remoteRecoveryConfiguration();
    let current = true,
      proofStage = false,
      entered!: () => void,
      release!: () => void,
      closed = false,
      closeFinished!: () => void;
    const reached = new Promise<void>((r) => {
        entered = r;
      }),
      held = new Promise<void>((r) => {
        release = r;
      }),
      didClose = new Promise<void>((r) => {
        closeFinished = r;
      });
    const originalClamp = clamp.clampRecoveryLaunchForOwner;
    vi.spyOn(clamp, 'clampRecoveryLaunchForOwner').mockImplementation(async (...args) => {
      const result = await originalClamp(...args);
      proofStage = true;
      return result;
    });
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const file = await open(...args);
      if (proofStage && String(args[0]) === dataPath('users.json')) {
        const read = file.read.bind(file),
          close = file.close.bind(file);
        vi.spyOn(file, 'read').mockImplementation(async (...readArgs) => {
          entered();
          await held;
          return Reflect.apply(read, file, readArgs);
        });
        vi.spyOn(file, 'close').mockImplementation(async () => {
          await close();
          closed = true;
          closeFinished();
        });
      }
      return file;
    });
    if (change === 'expired') vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
    const work = session.confirmRemoteRecoveryAuthority(THREAD, 0, () => current, expected);
    try {
      await reached;
      // The FD wait leaves the event loop available to owner/cancellation work.
      await new Promise<void>((r) => setImmediate(r));
      if (change === 'disk-replaced') replace(false);
      if (change === 'owner-changed') session.owner = 'replacement-owner';
      if (change === 'cancelled') current = false;
      if (change === 'expired') {
        await vi.advanceTimersByTimeAsync(2100);
        expect(await work).toBe(false);
        expect(closed).toBe(false);
      }
      release();
      expect(await work).toBe(change === 'unchanged');
      await didClose;
      expect(closed).toBe(true);
    } finally {
      release();
    }
  }
);

it('requires at least one exact bounded private file for a file-only proof', async () => {
  expect(await checkPrivateFileWitnesses([])).toBe(false);
  const session = await worker();
  const launch = await clamp.clampRecoveryLaunchForOwner(
    session.owner,
    { codexConfig: session.codexConfig },
    session.getEnvOverridesForPersist()
  );
  const file = launch.getFileWitness();
  expect(file).toBeDefined();
  expect(await checkPrivateFileWitnesses([file!])).toBe(true);
  expect(await checkPrivateFileWitnesses([{ ...file!, hash: '0'.repeat(64) }])).toBe(false);
  expect(await checkPrivateFileWitnesses([file!], performance.now() - 1)).toBe(false);
});
