/** Launch/attach provenance uses isolated test-mode muxes; never a real tmux or Codex home. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TmuxManager } from '../src/tmux-manager.js';
import { Session } from '../src/session.js';
import { currentLocalCodexHome } from '../src/recovery/codex-home.js';

const managers: TmuxManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.destroy();
  vi.unstubAllEnvs();
});
function mux(): TmuxManager {
  const manager = new TmuxManager();
  managers.push(manager);
  return manager;
}

describe('effective local Codex launch home', () => {
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
});
