/**
 * A server attach cannot rewrite an already-running pane's actual permissions.
 * Exercise the boot constructor with in-memory tmux and real current-user grants;
 * the attach is stubbed, so no PTY, tmux process or listening server is started.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MuxSession } from '../src/mux-interface.js';
import { CodexRecoveryAdapter } from '../src/recovery/codex-adapter.js';
import { resolveCodexIdentity } from '../src/recovery/codex-identity.js';
import type { RecoveryFlight } from '../src/recovery/types.js';
import { Session } from '../src/session.js';
import { TmuxManager } from '../src/tmux-manager.js';
import type { CodexConfig, SessionState } from '../src/types/session.js';
import { createUser, invalidateUsersCache, updateUser } from '../src/user-store.js';
import { WebServer } from '../src/web/server.js';

vi.mock('../src/recovery/codex-identity.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/recovery/codex-identity.js')>();
  return { ...actual, resolveCodexIdentity: vi.fn() };
});

const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const THREAD = '11111111-2222-3333-4444-555555555555';
const sessions: Session[] = [];
const multiplexers: TmuxManager[] = [];
const resolver = vi.mocked(resolveCodexIdentity);

beforeAll(async () => {
  process.env.CODEMAN_MULTIUSER = '1';
  invalidateUsersCache();
  const password = 'boot-policy-fixture-password';
  await createUser({ username: 'boss', role: 'admin', password });
  await createUser({ username: 'worker', role: 'user', password, canBypassPermissions: true });
});

beforeEach(async () => {
  resolver.mockReset();
  await updateUser('worker', { canBypassPermissions: true });
});

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.stop(false);
  for (const mux of multiplexers.splice(0)) mux.destroy();
  vi.restoreAllMocks();
});

afterAll(() => {
  delete process.env.CODEMAN_MULTIUSER;
  invalidateUsersCache();
});

async function attachSavedPane(config: Partial<CodexConfig> = {}, env?: Record<string, string>) {
  const codexConfig: CodexConfig = {
    noDaemon: true,
    noAltScreen: true,
    dangerouslyBypassApprovals: true,
    sandbox: 'danger-full-access',
    approvalPolicy: 'never',
    resumeSessionId: THREAD,
    ...config,
  };
  const envOverrides = env ?? { CODEX_HOME: join(homedir(), 'original-codex-profile') };
  const now = Date.now();
  const workingDir = join(homedir(), 'fixture-workspace');
  const saved: SessionState & { __envOverrides: Record<string, string> } = {
    id: SESSION,
    pid: 12345,
    status: 'idle',
    mode: 'codex',
    name: 'Original Codex policy',
    workingDir,
    currentTaskId: null,
    createdAt: now - 60_000,
    lastActivityAt: now - 1000,
    owner: 'worker',
    codexConfig,
    __envOverrides: envOverrides,
  };
  const record: MuxSession = {
    sessionId: SESSION,
    muxName: 'codeman-aaaaaaaa',
    pid: 12345,
    createdAt: saved.createdAt,
    workingDir,
    mode: 'codex',
    attached: true,
    name: saved.name,
    owner: saved.owner,
    recoveryIsolated: true,
    recoveryCodexHome: envOverrides.CODEX_HOME ?? join(homedir(), '.codex'),
  };
  const mux = new TmuxManager();
  multiplexers.push(mux);
  mux.registerSession(record);
  vi.spyOn(mux, 'startStatsCollection').mockImplementation(() => {});
  vi.spyOn(mux, 'startMouseModeSync').mockImplementation(() => {});
  vi.spyOn(mux, 'startPaneExitWatcher').mockImplementation(() => {});
  vi.spyOn(mux, 'startRemoteReconnectWatcher').mockImplementation(() => {});
  const attach = vi.spyOn(Session.prototype, 'startInteractive').mockResolvedValue();
  const context = {
    mux,
    sessions: new Map<string, Session>(),
    respawnControllers: new Map(),
    store: { getSession: vi.fn(() => saved), getSessions: vi.fn(() => ({ [SESSION]: saved })) },
    planRebootRestoreOffer: vi.fn(),
    getClaudeModeConfig: vi.fn(async () => ({ claudeMode: 'auto' as const })),
    setupSessionListeners: vi.fn(async () => {}),
    persistSessionState: vi.fn(),
    ensureHooksForRecoveredWorkspaces: vi.fn(async () => {}),
  };
  // Run the real boot assembly without constructing/listening to a WebServer.
  const restore = Reflect.get(WebServer.prototype, 'restoreMuxSessions') as (this: unknown) => Promise<boolean>;
  expect(await restore.call(context)).toBe(true);
  const session = context.sessions.get(SESSION)!;
  sessions.push(session);
  expect(attach).toHaveBeenCalledExactlyOnceWith();
  expect(context.store.getSessions).toHaveBeenCalled();
  expect(context.store.getSessions.mock.invocationCallOrder[0]).toBeLessThan(attach.mock.invocationCallOrder[0]);
  expect(context.persistSessionState).toHaveBeenCalledWith(session);
  return { session, saved, codexConfig, envOverrides };
}

async function expectCurrentGrantRefusal(session: Session): Promise<void> {
  // Restored panes retain the separate identity veto until fresh exact ordinary input.
  expect(session.getRecoveryContext().switchPending).toBe(true);
  const adapter = new CodexRecoveryAdapter(session, vi.fn());
  expect(await adapter.observe()).toMatchObject({ reason: 'identity-unverified', safeToAct: false });
  session.trackUserInput('Inspect the sanitized fixture status.\r');
  expect(session.getRecoveryContext().switchPending).toBe(true);
  session.trackUserInput('Inspect the next clean fixture status.\r');
  await Reflect.get(session, '_recoveryFencePublication');
  expect(session.getRecoveryContext().switchPending).toBe(false);
  expect(await adapter.observe()).toMatchObject({ activity: 'blocked', reason: 'approval-required', safeToAct: false });
  const flight: RecoveryFlight = {
    key: 'unverified-failure',
    action: 'continue',
    conversationId: THREAD,
    startedAt: Date.now(),
  };
  const deliver = vi.spyOn(session, 'deliverRecovery');
  expect(await adapter.act(flight)).toBe('not-sent');
  expect(deliver).not.toHaveBeenCalled();
  // Policy denial precedes rollout/pane reads; this fixture never scans a real Codex home.
  expect(resolver).not.toHaveBeenCalled();
}

describe('boot attachment preserves the actual Codex launch policy', () => {
  it('does not sanitize saved unsafe flags or the active home when the grant was revoked before boot', async () => {
    await updateUser('worker', { canBypassPermissions: false });
    const { session, saved, codexConfig, envOverrides } = await attachSavedPane();
    expect(session.codexConfig).toEqual(codexConfig);
    expect(session.toState().codexConfig).toEqual(saved.codexConfig);
    expect(session.getEnvOverridesForPersist()).toEqual(envOverrides);
    expect(session.getRecoveryContext()).toMatchObject({ noDaemon: true, codexHome: envOverrides.CODEX_HOME });
    await expectCurrentGrantRefusal(session);
    expect(session.codexConfig).toEqual(codexConfig);
    expect(session.getEnvOverridesForPersist()).toEqual(envOverrides);
  });

  it('denies recovery after a grant is revoked on an already-attached unsafe pane', async () => {
    const { session, codexConfig } = await attachSavedPane({}, {});
    await updateUser('worker', { canBypassPermissions: false });
    await expectCurrentGrantRefusal(session);
    expect(session.codexConfig).toEqual(codexConfig);
    expect(session.codexConfig?.dangerouslyBypassApprovals).toBe(true);
    expect(session.codexConfig?.sandbox).toBe('danger-full-access');
    expect(session.codexConfig?.approvalPolicy).toBe('never');
  });

  it('preserves a privileged active home and denies recovery even when the argv policy itself is safe', async () => {
    const { session, envOverrides } = await attachSavedPane({
      dangerouslyBypassApprovals: false,
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
    });
    await updateUser('worker', { canBypassPermissions: false });
    await expectCurrentGrantRefusal(session);
    expect(session.getEnvOverridesForPersist()).toEqual(envOverrides);
    expect(session.getRecoveryContext().codexHome).toBe(envOverrides.CODEX_HOME);
  });
});
