/** Native argv is preserved through configured remote launcher executables. No SSH effects. */
import { describe, expect, it } from 'vitest';
import { remoteCodexLauncher } from '../src/recovery/remote-codex-launcher.js';
import { buildRemoteCodexPaneCommand, buildRemoteLaunchCommand } from '../src/tmux-manager.js';
import { buildRemoteCodexRestartCommand, buildRemoteCodexRestoreCommand } from '../src/recovery/remote-codex.js';
import type { SessionRemote } from '../src/types.js';
const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const thread = '11111111-2222-3333-4444-555555555555';
const remote: SessionRemote = {
  hostId: 'test',
  host: 'example.invalid',
  label: 'Test',
  username: 'owner',
  remotePath: '/srv/project',
  owned: true,
  commands: { codex: 'codex-workspace' },
};
const codexConfig = {
  noDaemon: true,
  noAltScreen: true,
  resumeSessionId: thread,
  approvalPolicy: 'on-request' as const,
  sandbox: 'workspace-write' as const,
  model: 'gpt-5',
  reasoningEffort: 'high' as const,
};
describe('remote Codex custom launcher', () => {
  it('accepts an executable name or absolute path, never arbitrary shell programs', () => {
    expect(remoteCodexLauncher({})).toBe('codex');
    for (const value of ['codex-workspace', '/opt/bin/codex-workspace'])
      expect(remoteCodexLauncher({ commands: { codex: value } })).toBe(value);
    for (const value of [
      'exec codex-workspace',
      'codex-workspace --profile x',
      'codex;id',
      '$(id)',
      './codex',
      '../codex',
      '/opt/../codex',
      '-codex',
      '/opt/codex/',
      '/opt/code x',
    ])
      expect(remoteCodexLauncher({ commands: { codex: value } })).toBeUndefined();
  });
  it('passes pinned conversation, home, model, permission and process settings to the launcher', () => {
    const command = buildRemoteCodexPaneCommand({
      remote,
      remotePath: remote.remotePath,
      sessionId,
      codexConfig,
      codexHome: '/srv/codex-home',
    });
    for (const expected of [
      'codex-workspace',
      '--no-daemon',
      '--no-alt-screen',
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'on-request',
      '--model',
      'gpt-5',
      'model_reasoning_effort=high',
      thread,
      'CODEX_HOME=',
      '/srv/codex-home',
      `codeman_${sessionId}`,
    ])
      expect(command).toContain(expected);
    expect(command).not.toContain('||');
    expect(command).not.toContain('--last');
  });
  it('uses exact flags on initial SSH launch while leaving a full shell override explicit', () => {
    const command = buildRemoteLaunchCommand({
      mode: 'codex',
      remote,
      sessionId,
      codexConfig,
      envOverrides: { CODEX_HOME: '/srv/codex-home' },
    });
    expect(command).toContain('codex-workspace');
    expect(command).toContain(thread);
    expect(command).toContain('--no-daemon');
    const legacy = buildRemoteLaunchCommand({
      mode: 'codex',
      remote: { ...remote, commands: { codex: 'exec custom --profile named' } },
      sessionId,
    });
    expect(legacy).toContain('exec custom --profile named');
    expect(legacy).not.toContain('CODEX_INTERNAL_ORIGINATOR_OVERRIDE');
  });
  it('retains the configured launcher on restore and restart, never reverting to native codex', () => {
    const base = {
      sessionId,
      codexHome: '/srv/codex-home',
      resumeId: thread,
      codexConfig,
      expectedIdentity: { conversationId: thread, tailHash: 'a'.repeat(64) },
    };
    const restore = buildRemoteCodexRestoreCommand(remote, base);
    const restart = buildRemoteCodexRestartCommand(remote, {
      ...base,
      expectedPane: { paneId: '%1', panePid: 100, status: 1 },
    });
    for (const command of [restore, restart]) {
      expect(command.input).toContain('codex-workspace');
      expect(command.input).toContain(thread);
      expect(command.input).toContain('--no-daemon');
    }
  });
  it('refuses shell syntax at guarded command construction', () => {
    expect(() =>
      buildRemoteCodexPaneCommand({
        remote: { commands: { codex: 'exec codex-workspace' } },
        remotePath: remote.remotePath,
        sessionId,
        codexConfig,
      })
    ).toThrow('launcher executable');
  });
});
