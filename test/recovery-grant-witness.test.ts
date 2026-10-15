/** Actual grant snapshots and local Session dispatch, using temporary users and fake mux effects. */
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../src/config/instance.js';
import { Session } from '../src/session.js';
import type { MuxSession, TerminalMultiplexer } from '../src/mux-interface.js';
import * as grants from '../src/user-store.js';
import * as clamps from '../src/session-env-clamp.js';
import type { RecoveryFlight } from '../src/recovery/types.js';

let directory: string;
let previousData: string | undefined;
let previousMode: string | undefined;
const owner = 'worker';
function replace(users: unknown[]) {
  const path = dataPath('users.json');
  writeFileSync(`${path}.fixture`, JSON.stringify({ version: 1, users }));
  renameSync(`${path}.fixture`, path);
}
function account(patch: Record<string, unknown> = {}) {
  return { username: owner, role: 'user', canBypassPermissions: true, ...patch };
}
beforeEach(() => {
  previousData = process.env.CODEMAN_DATA_DIR;
  previousMode = process.env.CODEMAN_MULTIUSER;
  directory = mkdtempSync(join(homedir(), 'recovery-grant-'));
  process.env.CODEMAN_DATA_DIR = directory;
  process.env.CODEMAN_MULTIUSER = '1';
  grants.invalidateUsersCache();
  replace([account()]);
});
afterEach(() => {
  if (previousData === undefined) delete process.env.CODEMAN_DATA_DIR;
  else process.env.CODEMAN_DATA_DIR = previousData;
  if (previousMode === undefined) delete process.env.CODEMAN_MULTIUSER;
  else process.env.CODEMAN_MULTIUSER = previousMode;
  grants.invalidateUsersCache();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

describe('pure owner grant authority and bounded private disk witness', () => {
  it('uses the current disk grant even while ordinary authentication has a warm older cache', async () => {
    expect(await grants.canUsernameRunPrivilegedCommands(owner)).toBe(true);
    replace([account({ canBypassPermissions: false })]);
    expect(await grants.canUsernameRunPrivilegedCommands(owner)).toBe(true);
    const grant = await grants.prepareRecoveryPrivilegeGrant(owner);
    expect(grant.privileged).toBe(false);
    expect(grant.isCurrent()).toBe(true);
  });

  it.each(['external-revoke', 'cache-revoke', 'disabled', 'deleted', 'mode-change', 'malformed'])(
    'invalidates a prepared grant after %s',
    async (change) => {
      const grant = await grants.prepareRecoveryPrivilegeGrant(owner);
      expect(grant.privileged).toBe(true);
      expect(grant.isCurrent()).toBe(true);
      if (change === 'external-revoke') replace([account({ canBypassPermissions: false })]);
      if (change === 'cache-revoke') {
        const cached = await grants.findUser(owner);
        cached!.canBypassPermissions = false;
      }
      if (change === 'disabled') replace([account({ disabled: true })]);
      if (change === 'deleted') replace([]);
      if (change === 'mode-change') process.env.CODEMAN_MULTIUSER = '0';
      if (change === 'malformed') writeFileSync(dataPath('users.json'), '{malformed-fixture}');
      const knownMemoryChange = change === 'cache-revoke' || change === 'mode-change';
      expect(grant.isCurrent()).toBe(!knownMemoryChange);
      expect(await grant.verifyCurrent()).toBe(false);
      expect(grant.getFileWitness()).toEqual(grant.fileWitness);
    }
  );

  it.each([
    [],
    [account(), account()],
    [account({ disabled: true })],
    [account({ role: 'unknown' })],
    [account({ canBypassPermissions: 'true' })],
  ])('refuses unavailable or malformed owner permission records: %s', async (users) => {
    replace(users);
    const grant = await grants.prepareRecoveryPrivilegeGrant(owner);
    expect(grant.privileged).toBe(false);
    expect(grant.isCurrent()).toBe(false);
  });

  it('preserves default single-user operation without requiring a users file', async () => {
    process.env.CODEMAN_MULTIUSER = '0';
    rmSync(dataPath('users.json'));
    const grant = await grants.prepareRecoveryPrivilegeGrant(undefined);
    expect(grant.privileged).toBe(true);
    expect(grant.isCurrent()).toBe(true);
    expect(grant.getFileWitness()).toBeUndefined();
    expect(await grant.verifyCurrent()).toBe(true);
    process.env.CODEMAN_MULTIUSER = '1';
    expect(grant.isCurrent()).toBe(false);
    const unowned = await grants.prepareRecoveryPrivilegeGrant(undefined);
    expect(unowned.isCurrent()).toBe(false);
  });

  it.each([
    { version: 999, users: [account()] },
    { users: [account()] },
    { version: '1', users: [account()] },
    { version: 1, users: [account()], unsupported: true },
    { version: 1, users: {} },
  ])('refuses unsupported or incomplete grant file shape %s', async (payload) => {
    writeFileSync(dataPath('users.json'), JSON.stringify(payload));
    const grant = await grants.prepareRecoveryPrivilegeGrant(owner);
    expect(grant.privileged).toBe(false);
    expect(grant.isCurrent()).toBe(false);
  });
});

describe.each(['continue', 'restart'] as const)('actual local %s grant boundary', (action) => {
  it.each(['unchanged', 'after-grant-await', 'during-evidence-check'])(
    'checks grant provenance through the final %s boundary',
    async (change) => {
      const home = join(directory, 'codex');
      mkdirSync(home);
      const pane = {
        paneId: '%7',
        panePid: 700,
        dead: action === 'restart',
        status: action === 'restart' ? 1 : undefined,
        screen: action === 'restart' ? null : '›\n  fixture-model high · /tmp\n',
      };
      const mux = {
        isAvailable: () => true,
        inspectPaneForRecovery: vi.fn(async () => pane),
        sendInput: vi.fn(async () => true),
        respawnPane: vi.fn(async () => 99999),
        clearPaneExit: vi.fn(),
      };
      const worker = new Session({
        id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        owner,
        workingDir: directory,
        mode: 'codex',
        useMux: true,
        mux: mux as unknown as TerminalMultiplexer,
        muxSession: {
          muxName: 'codeman-aaaaaaaa',
          sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          recoveryIsolated: true,
          recoveryCodexHome: home,
          pid: 99999,
          createdAt: Date.now(),
          workingDir: directory,
          mode: 'codex',
          attached: true,
        } as MuxSession,
        codexConfig: { noDaemon: true, model: 'fixture-model' },
        envOverrides: { CODEX_HOME: home },
      });
      const thread = '11111111-2222-3333-4444-555555555555';
      worker.pinRecoveryConversation(thread);
      const revoke = () => replace([account({ canBypassPermissions: false })]);
      const clamp = clamps.clampRecoveryLaunchForOwner;
      if (change === 'after-grant-await')
        vi.spyOn(clamps, 'clampRecoveryLaunchForOwner').mockImplementation(async (...args) => {
          const granted = await clamp(...args);
          queueMicrotask(revoke);
          return granted;
        });
      const flight: RecoveryFlight = { action, key: 'fixture', conversationId: thread, startedAt: Date.now() };
      const result = await worker.deliverRecovery(
        flight,
        worker.getRecoveryContext().generation,
        () => true,
        'continue',
        () => {
          if (change === 'during-evidence-check') revoke();
          return true;
        }
      );
      expect(result).toBe(change === 'unchanged' ? 'sent' : 'not-sent');
      expect(mux.sendInput).toHaveBeenCalledTimes(change === 'unchanged' && action === 'continue' ? 1 : 0);
      expect(mux.respawnPane).toHaveBeenCalledTimes(change === 'unchanged' && action === 'restart' ? 1 : 0);
      await worker.stop(false);
    }
  );
});
