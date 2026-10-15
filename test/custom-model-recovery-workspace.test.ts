/** @fileoverview Rebuilt custom profiles retain exact workspace onboarding in temporary owner homes. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDataDir } from '../src/config/instance.js';
import { customModelConfigDir } from '../src/custom-model-injection-apply.js';
import { writeCustomModelHosts } from '../src/custom-model-hosts.js';
import { rebuildPersistedCustomModelEnv } from '../src/custom-model-recovery.js';
import { WebServer } from '../src/web/server.js';
import type { Session } from '../src/session.js';
import type { CustomModelBookkeeping } from '../src/types/session.js';

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const refuse = () => {
    throw new Error('Native process effects forbidden in profile reconstruction tests');
  };
  return {
    ...actual,
    exec: refuse,
    execSync: refuse,
    execFile: refuse,
    execFileSync: refuse,
    spawn: refuse,
    spawnSync: refuse,
    fork: refuse,
  };
});

const endpoint = {
  id: 'fixture-endpoint',
  label: 'Fixture',
  baseUrl: 'http://endpoint.invalid',
  apiKey: 'fixture-current-key',
  models: ['fixture-model'],
};
const saved: CustomModelBookkeeping = {
  endpointId: endpoint.id,
  modelId: 'fixture-model',
  envKeys: ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY'],
};
const rebuildOnServer = (
  WebServer.prototype as unknown as {
    _rebuildCustomModelEnv(
      session: Session,
      saved: CustomModelBookkeeping
    ): Promise<Record<string, string> | undefined>;
  }
)._rebuildCustomModelEnv;
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

beforeEach(async () => {
  await writeCustomModelHosts(getDataDir(), [endpoint]);
});

describe('persisted custom profile workspace', () => {
  it.each(['helper', 'server'] as const)(
    'recreates absent Claude onboarding before %s returns launch environment',
    async (path) => {
      const sessionId = `missing-${path}`;
      const workingDir = join(homedir(), 'owner workspace with spaces');
      const configDir = customModelConfigDir(sessionId);
      const homeConfigDir = join(homedir(), '.claude');
      mkdirSync(homeConfigDir, { recursive: true });
      const globalProfile = JSON.stringify({
        projects: { '/unrelated-global-workspace': { hasTrustDialogAccepted: false } },
        globalOnly: 'preserved',
      });
      writeFileSync(join(homeConfigDir, '.claude.json'), globalProfile);
      writeFileSync(join(homeConfigDir, '.credentials.json'), 'fixture-global-credentials');
      const old = { ...saved, configDir: join(homedir(), 'untrusted-saved-config-path') };
      expect(existsSync(configDir)).toBe(false);
      const env =
        path === 'helper'
          ? await rebuildPersistedCustomModelEnv('claude', sessionId, old, workingDir)
          : await rebuildOnServer.call({}, { id: sessionId, mode: 'claude', workingDir } as Session, old);
      expect(env).toMatchObject({ CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: endpoint.apiKey });
      const rebuilt = readJson(join(configDir, '.claude.json'));
      expect(rebuilt.hasCompletedOnboarding).toBe(true);
      expect(rebuilt.projects).toEqual({ [workingDir]: { hasTrustDialogAccepted: true } });
      expect(readJson(join(configDir, 'settings.json')).skipDangerousModePermissionPrompt).toBe(true);
      expect(readFileSync(join(homeConfigDir, '.claude.json'), 'utf8')).toBe(globalProfile);
      expect(readFileSync(join(homeConfigDir, '.credentials.json'), 'utf8')).toBe('fixture-global-credentials');
      expect(existsSync(join(configDir, '.credentials.json'))).toBe(false);
      expect(existsSync(old.configDir)).toBe(false);
    }
  );

  it('merges trust for only the exact current workspace and preserves existing profile fields', async () => {
    const sessionId = 'existing-profile';
    const workingDir = `${join(homedir(), 'literal workspace')}/`;
    const otherWorkspace = join(homedir(), 'unrelated workspace');
    const configDir = customModelConfigDir(sessionId);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, '.claude.json'),
      JSON.stringify({
        customField: 'keep',
        projects: {
          [workingDir]: { allowedTools: ['Read'] },
          [otherWorkspace]: { hasTrustDialogAccepted: false, allowedTools: ['Read'] },
        },
      })
    );
    await rebuildPersistedCustomModelEnv('claude', sessionId, saved, workingDir);
    const rebuilt = readJson(join(configDir, '.claude.json'));
    expect(rebuilt.hasCompletedOnboarding).toBe(true);
    expect(rebuilt.customField).toBe('keep');
    expect(rebuilt.projects).toEqual({
      [workingDir]: { hasTrustDialogAccepted: true, allowedTools: ['Read'] },
      [otherWorkspace]: { hasTrustDialogAccepted: false, allowedTools: ['Read'] },
    });
    expect(rebuilt.projects[workingDir.slice(0, -1)]).toBeUndefined();
  });

  it.each(['missing-endpoint', 'unregistered-cli'] as const)(
    'refuses %s without creating a profile or workspace trust',
    async (reason) => {
      if (reason === 'missing-endpoint') await writeCustomModelHosts(getDataDir(), []);
      const sessionId = `refused-${reason}`;
      const env = await rebuildPersistedCustomModelEnv(
        reason === 'unregistered-cli' ? 'unregistered-fixture' : 'claude',
        sessionId,
        saved,
        join(homedir(), 'owner workspace')
      );
      expect(env).toBeUndefined();
      expect(existsSync(customModelConfigDir(sessionId))).toBe(false);
    }
  );

  it('preserves Codex configuration isolation without inventing Claude onboarding files', async () => {
    const sessionId = 'codex-profile';
    const configDir = customModelConfigDir(sessionId);
    const env = await rebuildPersistedCustomModelEnv('codex', sessionId, saved, join(homedir(), 'codex workspace'));
    expect(env?.CODEX_HOME).toBe(configDir);
    expect(existsSync(join(configDir, 'config.toml'))).toBe(true);
    expect(existsSync(join(configDir, '.claude.json'))).toBe(false);
    expect(existsSync(join(configDir, 'settings.json'))).toBe(false);
  });
});
