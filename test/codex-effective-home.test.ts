/** Launch/attach provenance uses isolated test-mode muxes; never a real tmux or Codex home. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TmuxManager } from '../src/tmux-manager.js';
import { Session } from '../src/session.js';
import { currentLocalCodexHome } from '../src/recovery/codex-home.js';
import { CreateSessionSchema } from '../src/web/schemas.js';

// Actual Session startup runs against the in-memory mux and a fake attach PTY.
// No CLI, tmux socket, process or private agent home is opened.
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    pid: 0,
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));

const managers: TmuxManager[] = [];
const sessions: Session[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.stop(false);
  for (const manager of managers.splice(0)) manager.destroy();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
function mux(): TmuxManager {
  const manager = new TmuxManager();
  managers.push(manager);
  return manager;
}

describe('effective local Codex launch home', () => {
  it.each([
    ['empty override with inherited home', 'inherited-profile', ''],
    ['empty override with default home', undefined, ''],
    ['omitted override with inherited home', 'inherited-profile', undefined],
    ['omitted override with default home', undefined, undefined],
    ['explicit override over inherited home', 'inherited-profile', 'explicit-profile'],
  ] as const)(
    'starts the actual Session with %s and preserves the exact resumed thread/settings',
    async (_label, ambient, override) => {
      const ambientHome = ambient === undefined ? undefined : join(homedir(), ambient);
      vi.stubEnv('CODEX_HOME', ambientHome);
      const selected = override ? join(homedir(), override) : override;
      const expected = selected || currentLocalCodexHome();
      const envOverrides = selected === undefined ? undefined : { CODEX_HOME: selected };
      const config = {
        noDaemon: true,
        noAltScreen: true,
        sandbox: 'read-only',
        approvalPolicy: 'on-request',
        resumeSessionId: '11111111-2222-3333-4444-555555555555',
      } as const;
      expect(CreateSessionSchema.safeParse({ mode: 'codex', workingDir: homedir(), envOverrides }).success).toBe(true);
      const manager = mux();
      const create = vi.spyOn(manager, 'createSession');
      const session = new Session({
        workingDir: homedir(),
        mode: 'codex',
        mux: manager,
        useMux: true,
        codexConfig: config,
        envOverrides,
      });
      sessions.push(session);
      await session.startInteractive();
      expect(create).toHaveBeenCalledOnce();
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ codexConfig: config, envOverrides }));
      expect(session.getRecoveryContext()).toMatchObject({ noDaemon: true, codexHome: expected });
      expect(session.codexConfig).toEqual(config);
      expect(session.claudeSessionId).toBe(config.resumeSessionId);
      vi.stubEnv('CODEX_HOME', join(homedir(), 'changed-server-profile'));
      expect(session.getRecoveryContext()).toMatchObject({ noDaemon: true, codexHome: expected });
    }
  );

  it('refuses a nonempty malformed explicit home instead of selecting an unrelated default', async () => {
    vi.stubEnv('CODEX_HOME', join(homedir(), 'server-profile'));
    const manager = mux();
    const create = vi.spyOn(manager, 'createSession');
    const session = new Session({
      workingDir: homedir(),
      mode: 'codex',
      mux: manager,
      useMux: true,
      codexConfig: { noDaemon: true },
      envOverrides: { CODEX_HOME: 'relative-profile' },
    });
    sessions.push(session);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(session.startInteractive()).rejects.toThrow(/require tmux/);
    await expect(create.mock.results[0].value).rejects.toThrow('Local Codex launch home is unverified');
    expect(session.getRecoveryContext()).toMatchObject({ noDaemon: false, codexHome: undefined });
  });

  it('retains inherited CODEX_HOME after the server environment changes', async () => {
    const original = join(homedir(), 'original-profile');
    vi.stubEnv('CODEX_HOME', original);
    const manager = mux();
    const record = await manager.createSession({
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      workingDir: '/fixture/workspace',
      mode: 'codex',
      codexConfig: { noDaemon: true },
    });
    vi.stubEnv('CODEX_HOME', join(homedir(), 'replacement-profile'));
    const session = new Session({
      id: record.sessionId,
      workingDir: record.workingDir,
      mode: 'codex',
      mux: manager,
      muxSession: record,
      codexConfig: { noDaemon: true },
    });
    expect(session.getRecoveryContext()).toMatchObject({ noDaemon: true, codexHome: original });
    expect(session.getEnvOverridesForPersist()).toBeUndefined();
  });

  it('pins the normal default home instead of using a later HOME', async () => {
    vi.stubEnv('CODEX_HOME', undefined);
    const original = currentLocalCodexHome();
    const record = await mux().createSession({
      sessionId: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee',
      workingDir: '/fixture/workspace',
      mode: 'codex',
      codexConfig: { noDaemon: true },
    });
    vi.stubEnv('HOME', join(homedir(), 'changed-home'));
    expect(record.recoveryCodexHome).toBe(original);
    expect(currentLocalCodexHome()).not.toBe(original);
  });

  it('prefers the explicitly selected home over server defaults', async () => {
    vi.stubEnv('CODEX_HOME', join(homedir(), 'server-profile'));
    const original = join(homedir(), 'explicit-profile');
    const record = await mux().createSession({
      sessionId: 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee',
      workingDir: '/fixture/workspace',
      mode: 'codex',
      codexConfig: { noDaemon: true },
      envOverrides: { CODEX_HOME: original },
    });
    expect(record.recoveryCodexHome).toBe(original);
  });

  it('does not infer the home of a legacy pane from the current ambient environment', async () => {
    const manager = mux();
    const record = await manager.createSession({
      sessionId: 'dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee',
      workingDir: '/fixture/workspace',
      mode: 'codex',
      codexConfig: { noDaemon: true },
    });
    delete record.recoveryCodexHome;
    const session = new Session({
      id: record.sessionId,
      workingDir: record.workingDir,
      mode: 'codex',
      mux: manager,
      muxSession: record,
      codexConfig: { noDaemon: true },
    });
    expect(session.getRecoveryContext()).toMatchObject({ noDaemon: false, codexHome: undefined });
  });

  it.each([null, false, 0])('does not treat malformed runtime home %j as an omitted override', async (home) => {
    const manager = mux();
    const record = await manager.createSession({
      sessionId: 'eeeeeeee-bbbb-cccc-dddd-eeeeeeeeeeee',
      workingDir: homedir(),
      mode: 'codex',
      codexConfig: { noDaemon: true },
    });
    const session = new Session({
      id: record.sessionId,
      workingDir: record.workingDir,
      mode: 'codex',
      mux: manager,
      muxSession: record,
      codexConfig: { noDaemon: true },
      envOverrides: { CODEX_HOME: home } as unknown as Record<string, string>,
    });
    sessions.push(session);
    expect(session.getRecoveryContext().noDaemon).toBe(false);
  });
});
