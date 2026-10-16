/**
 * Codex recovery launch settings must remain opt-in and use the registry's bounded
 * argv params. Recovery of a saved config must re-check its owner's current grant.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getCli } from '../src/config/cli-registry/registry.js';
import { CliEntrySchema } from '../src/config/cli-registry/schema.js';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';
import { buildSpawnCommandFromRegistry } from '../src/session-cli-registry-bridge.js';
import { clampExternalCliConfigsForOwner } from '../src/session-env-clamp.js';
import type { CodexConfig } from '../src/types/session.js';
import { createUser, invalidateUsersCache, updateUser } from '../src/user-store.js';
import { CreateSessionSchema, QuickStartSchema } from '../src/web/schemas.js';
import { _clampExternalCliBypassForOwner } from '../src/web/routes/session-routes.js';

const SESSION_ID = '11111111-2222-3333-4444-555555555555';
const THREAD_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const codex = getCli('codex')!;

function render(codexConfig?: CodexConfig): string | undefined {
  return buildSpawnCommandFromRegistry(codex, { mode: 'codex', sessionId: SESSION_ID, codexConfig });
}

describe('Codex launch settings', () => {
  it('keeps daemon and terminal settings opt-in on old and explicitly false configs', () => {
    expect(render()).toBe('codex');
    expect(render({ noDaemon: false, noAltScreen: false })).toBe('codex');
    expect(render({ model: 'gpt-5' })).toBe('codex --model gpt-5');
  });

  it('emits daemon/scrollback flags without adding an approval bypass', () => {
    expect(render({ noDaemon: true, noAltScreen: true })).toBe('codex --no-daemon --no-alt-screen');
  });

  it.each(['read-only', 'workspace-write', 'danger-full-access'] as const)(
    'passes the explicit %s sandbox as one enum argument',
    (sandbox) => {
      expect(render({ sandbox })).toBe(`codex --sandbox ${sandbox}`);
    }
  );

  it.each(['on-request', 'never'] as const)('passes the explicit %s approval policy', (approvalPolicy) => {
    expect(render({ approvalPolicy })).toBe(`codex --ask-for-approval ${approvalPolicy}`);
  });

  it('keeps launch options before the positional resume subcommand', () => {
    expect(
      render({
        noDaemon: true,
        noAltScreen: true,
        sandbox: 'read-only',
        approvalPolicy: 'on-request',
        reasoningEffort: 'high',
        resumeSessionId: THREAD_ID,
      })
    ).toBe(
      `codex --no-daemon --no-alt-screen --sandbox read-only --ask-for-approval on-request --config model_reasoning_effort=high resume ${THREAD_ID}`
    );
  });

  it('does not emit removed policies or arbitrary persisted flag/config expressions', () => {
    for (const approvalPolicy of ['untrusted', 'on-failure', 'never --dangerously-bypass-approvals-and-sandbox']) {
      expect(render({ approvalPolicy } as unknown as CodexConfig)).toBe('codex');
    }
    expect(render({ sandbox: 'workspace-write; touch /tmp/unwanted' } as unknown as CodexConfig)).toBe('codex');
  });

  it('preserves explicit settings on both create request shapes', () => {
    const codexConfig: CodexConfig = {
      noDaemon: true,
      noAltScreen: false,
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
    };
    expect(CreateSessionSchema.parse({ mode: 'codex', workingDir: '/tmp', codexConfig }).codexConfig).toMatchObject(
      codexConfig
    );
    expect(QuickStartSchema.parse({ mode: 'codex', caseName: 'work', codexConfig }).codexConfig).toMatchObject(
      codexConfig
    );
  });

  it('refuses invalid launch settings at either API boundary', () => {
    for (const codexConfig of [
      { noDaemon: 'true' },
      { noAltScreen: 1 },
      { sandbox: 'workspace-write --yolo' },
      { approvalPolicy: 'untrusted' },
      { approvalPolicy: 'on-failure' },
    ]) {
      expect(CreateSessionSchema.safeParse({ mode: 'codex', workingDir: '/tmp', codexConfig }).success).toBe(false);
      expect(QuickStartSchema.safeParse({ mode: 'codex', caseName: 'work', codexConfig }).success).toBe(false);
    }
  });

  it('selects recovery by a closed capability which only stock Codex declares', () => {
    expect(STOCK_CLIS.filter((entry) => entry.capabilities.recovery).map((entry) => entry.id)).toEqual(['codex']);
    const invalid = structuredClone(codex) as unknown as Record<string, unknown>;
    (invalid.capabilities as Record<string, unknown>).recovery = 'run-arbitrary-command';
    expect(CliEntrySchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects conditional clamp values outside their declared enum/bool', () => {
    for (const clamp of [
      { param: 'sandbox', clampTo: 'workspace-write', whenValues: [] },
      { param: 'sandbox', clampTo: 'workspace-write', whenValues: ['workspace-write --yolo'] },
      { param: 'sandbox', clampTo: 'workspace-write', whenValues: [true] },
      { param: 'sandbox', clampTo: 'arbitrary', whenValues: ['danger-full-access'] },
      { param: 'model', clampTo: 'gpt-5', whenValues: ['gpt-5'] },
      { param: 'sandbox', clampTo: 'workspace-write', whenValues: ['danger-full-access'], materializeWhenAbsent: true },
    ]) {
      const invalid = structuredClone(codex) as unknown as Record<string, unknown>;
      (invalid.capabilities as Record<string, unknown>).privilegedParams = [clamp];
      expect(CliEntrySchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe('saved Codex config privilege checks', () => {
  beforeAll(async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    invalidateUsersCache();
    const password = 'codex-clamp-fixture-password';
    await createUser({ username: 'boss', role: 'admin', password });
    await createUser({ username: 'worker', role: 'user', password });
    await createUser({ username: 'trusted', role: 'user', password, canBypassPermissions: true });
  });

  afterAll(() => {
    delete process.env.CODEMAN_MULTIUSER;
    invalidateUsersCache();
  });

  it('clamps dangerous sandbox/approval settings without changing daemon or terminal settings', async () => {
    const saved: CodexConfig = {
      noDaemon: false,
      noAltScreen: true,
      dangerouslyBypassApprovals: true,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
      resumeSessionId: THREAD_ID,
    };
    const clamped = await clampExternalCliConfigsForOwner('worker', { codexConfig: saved });
    expect(clamped.codexConfig).toEqual({
      ...saved,
      dangerouslyBypassApprovals: false,
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
    });
    expect(saved.sandbox).toBe('danger-full-access');
    expect(saved.dangerouslyBypassApprovals).toBe(true);
  });

  it('keeps safe explicit choices through the HTTP route clamp', async () => {
    const safe: CodexConfig = { noDaemon: true, sandbox: 'read-only', approvalPolicy: 'on-request' };
    const clamped = await _clampExternalCliBypassForOwner('worker', safe);
    expect(clamped.codexConfig).toEqual({ ...safe, dangerouslyBypassApprovals: false });
    expect(render(clamped.codexConfig)).toBe('codex --no-daemon --sandbox read-only --ask-for-approval on-request');
  });

  it('does not create optional flags or daemon certification on an old config', async () => {
    const clamped = await clampExternalCliConfigsForOwner('worker', { codexConfig: { model: 'gpt-5' } });
    expect(clamped.codexConfig).toEqual({ model: 'gpt-5', dangerouslyBypassApprovals: false });
    expect((await clampExternalCliConfigsForOwner('worker', { codexConfig: undefined })).codexConfig).toBeUndefined();
  });

  it('preserves explicit privileged choices for admins and granted owners', async () => {
    const configs = { codexConfig: { noDaemon: true, sandbox: 'danger-full-access', approvalPolicy: 'never' } };
    expect(await clampExternalCliConfigsForOwner('boss', configs)).toBe(configs);
    expect(await clampExternalCliConfigsForOwner('trusted', configs)).toBe(configs);
  });

  it('rechecks a withdrawn grant when a saved config is recovered', async () => {
    const configs = { codexConfig: { noDaemon: true, sandbox: 'danger-full-access', approvalPolicy: 'never' } };
    await updateUser('trusted', { canBypassPermissions: false });
    expect((await clampExternalCliConfigsForOwner('trusted', configs)).codexConfig).toEqual({
      noDaemon: true,
      dangerouslyBypassApprovals: false,
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
    });
  });
});
