/** Disabled launch-menu entries still own persisted privileges; temporary registry/users and fake mux only. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dataPath } from '../src/config/instance.js';
import { enabledClis, getCli, listClis, reloadCliRegistry } from '../src/config/cli-registry/registry.js';
import {
  clampEnvOverridesForOwner,
  clampExternalCliConfigsForOwner,
  clampRecoveryLaunchForOwner,
  ownerClampedEnvKeys,
} from '../src/session-env-clamp.js';
import { invalidateUsersCache } from '../src/user-store.js';
import { Session } from '../src/session.js';
import type { CodexConfig } from '../src/types.js';
import type { MuxSession, RecoveryMuxDispatchGuard, TerminalMultiplexer } from '../src/mux-interface.js';

const THREAD = '11111111-2222-3333-4444-555555555555';
const OWNER = 'fixture-owner';
const sessions: Session[] = [];
let root: string;
function user(privileged: boolean) {
  writeFileSync(
    dataPath('users.json'),
    JSON.stringify({ version: 1, users: [{ username: OWNER, role: 'user', canBypassPermissions: privileged }] }),
    { mode: 0o600 }
  );
  invalidateUsersCache();
}
function registry(enabled: boolean) {
  writeFileSync(
    dataPath('clis.json'),
    JSON.stringify({ clis: { codex: { enabled }, deepseek: { enabled }, gemini: { enabled } } }),
    { mode: 0o600 }
  );
  reloadCliRegistry();
  expect(getCli('codex')?.enabled).toBe(enabled);
  expect(enabledClis().some((entry) => entry.id === 'codex')).toBe(enabled);
}
beforeEach(() => {
  root = mkdtempSync(join(homedir(), 'disabled-cli-grants-'));
  vi.stubEnv('CODEMAN_DATA_DIR', root);
  vi.stubEnv('CODEMAN_MULTIUSER', '1');
  user(false);
  registry(false);
});
afterEach(async () => {
  for (const session of sessions.splice(0)) {
    Object.assign(session, { _mux: null, _muxSession: null });
    await session.stop(false);
  }
  reloadCliRegistry();
  invalidateUsersCache();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it.each([false, true])('clamps all registered privilege configs regardless enabled=%s', async (enabled) => {
  registry(enabled);
  const unsafe = {
    codexConfig: {
      noDaemon: true,
      resumeSessionId: THREAD,
      model: 'fixture-model',
      dangerouslyBypassApprovals: true,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    },
    geminiConfig: { approvalMode: 'yolo' },
    deepSeekConfig: { permissionMode: 'danger-full-access' },
  };
  const expected = {
    ...unsafe,
    codexConfig: {
      ...unsafe.codexConfig,
      dangerouslyBypassApprovals: false,
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
    },
    geminiConfig: { approvalMode: 'auto_edit' },
    deepSeekConfig: { permissionMode: 'workspace-write' },
  };
  expect(await clampExternalCliConfigsForOwner(OWNER, unsafe)).toMatchObject(expected);
  const final = await clampRecoveryLaunchForOwner(OWNER, unsafe, undefined);
  expect(final.isCurrent()).toBe(true);
  expect(final.configs).toMatchObject(expected);
  expect(unsafe.codexConfig.dangerouslyBypassApprovals).toBe(true);
});

it.each([false, true])('strips every registered privileged environment key regardless enabled=%s', async (enabled) => {
  registry(enabled);
  const keys = [...new Set(listClis().flatMap((entry) => entry.capabilities.privilegedEnvKeys))];
  expect(keys).toContain('CODEX_HOME');
  expect(ownerClampedEnvKeys()).toEqual(expect.arrayContaining(keys));
  const unsafe = Object.fromEntries(keys.map((key) => [key, 'private-fixture-value']));
  unsafe.CODEX_FIXTURE_LOG = 'keep-ordinary-value';
  expect(await clampEnvOverridesForOwner(OWNER, unsafe)).toEqual({ CODEX_FIXTURE_LOG: 'keep-ordinary-value' });
  expect((await clampRecoveryLaunchForOwner(OWNER, {}, unsafe)).env).toEqual({
    CODEX_FIXTURE_LOG: 'keep-ordinary-value',
  });
  expect(unsafe.CODEX_HOME).toBe('private-fixture-value');
});

it.each(['granted', 'admin', 'single-user'] as const)(
  'preserves the %s owner no-op with a disabled CLI',
  async (grant) => {
    if (grant === 'single-user') vi.stubEnv('CODEMAN_MULTIUSER', '0');
    else if (grant === 'admin') {
      writeFileSync(
        dataPath('users.json'),
        JSON.stringify({ version: 1, users: [{ username: OWNER, role: 'admin' }] }),
        { mode: 0o600 }
      );
      invalidateUsersCache();
    } else user(true);
    const configs = {
      codexConfig: { dangerouslyBypassApprovals: true, sandbox: 'danger-full-access', approvalPolicy: 'never' },
    };
    const env = { CODEX_HOME: '/private/fixture-home' };
    expect(await clampExternalCliConfigsForOwner(OWNER, configs)).toBe(configs);
    expect(await clampEnvOverridesForOwner(OWNER, env)).toBe(env);
    const final = await clampRecoveryLaunchForOwner(OWNER, configs, env);
    expect(final.configs).toBe(configs);
    expect(final.env).toBe(env);
    expect(final.isCurrent()).toBe(true);
  }
);

it.each([
  undefined,
  { sandbox: 'read-only', approvalPolicy: 'untrusted' },
  { sandbox: 'workspace-write', approvalPolicy: 'on-request' },
])('preserves safe explicit or absent disabled Codex config %s', async (safe) => {
  const result = await clampRecoveryLaunchForOwner(OWNER, { codexConfig: safe }, undefined);
  expect(result.configs.codexConfig).toEqual(
    safe === undefined ? undefined : { ...safe, dangerouslyBypassApprovals: false }
  );
  expect(result.env).toBeUndefined();
});

it.each(
  (['continue', 'restart'] as const).flatMap((action) =>
    [false, true].flatMap((enabled) =>
      (['revoked', 'retained', 'safe'] as const).map((grant) => ({ action, enabled, grant }))
    )
  )
)(
  'actual Session refuses revoked persisted privilege before $action (enabled=$enabled grant=$grant)',
  async ({ action, enabled, grant }) => {
    registry(enabled);
    user(grant !== 'safe');
    const home = join(homedir(), '.codex');
    mkdirSync(home, { recursive: true });
    const pane = {
      paneId: '%7',
      panePid: 700,
      dead: action === 'restart',
      status: action === 'restart' ? 1 : undefined,
      screen: '›\n  fixture-model high · /tmp\n',
    };
    const effect = vi.fn();
    const dispatch = async (guard: RecoveryMuxDispatchGuard) => {
      if (!(await guard.prepareEvidence!()) || !guard.confirm()) return false;
      effect();
      guard.noteDispatch();
      guard.noteBrokerSent?.();
      return true;
    };
    const mux = {
      inspectPaneForRecovery: vi.fn(async () => pane),
      sendInput: vi.fn(async (_id: string, _input: string, guard: RecoveryMuxDispatchGuard) => dispatch(guard)),
      respawnPane: vi.fn(async (options: { recoveryDispatchGuard: RecoveryMuxDispatchGuard }) =>
        (await dispatch(options.recoveryDispatchGuard)) ? 701 : null
      ),
    };
    const codexConfig: CodexConfig = {
      noDaemon: true,
      resumeSessionId: THREAD,
      model: 'fixture-model',
      dangerouslyBypassApprovals: grant !== 'safe',
      sandbox: grant === 'safe' ? 'read-only' : 'danger-full-access',
      approvalPolicy: grant === 'safe' ? 'on-request' : 'never',
    };
    const session = new Session({
      owner: OWNER,
      workingDir: root,
      mode: 'codex',
      useMux: true,
      mux: mux as unknown as TerminalMultiplexer,
      muxSession: {
        muxName: 'codeman-disabled-privilege-fixture',
        recoveryIsolated: true,
        recoveryCodexHome: home,
      } as MuxSession,
      codexConfig,
    });
    sessions.push(session);
    expect(session.getRecoveryContext()).toMatchObject({ managed: true, noDaemon: true });
    if (grant === 'revoked') user(false);
    const result = await session.deliverRecovery(
      { action, key: 'exact-fixture-failure', conversationId: THREAD, startedAt: Date.now() },
      session.getRecoveryContext().generation,
      () => true,
      'Bounded continuation',
      () => true
    );
    expect(result).toBe(grant === 'revoked' ? 'not-sent' : 'sent');
    expect(effect).toHaveBeenCalledTimes(grant === 'revoked' ? 0 : 1);
    expect(session.codexConfig).toEqual(codexConfig);
  }
);
