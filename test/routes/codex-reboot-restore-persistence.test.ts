/** Production reboot route, Session, and WebServer persistence against isolated test-mode panes. */
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataPath, getDataDir } from '../../src/config/instance.js';
import { writeCustomModelHosts } from '../../src/custom-model-hosts.js';
import { customModelConfigDir } from '../../src/custom-model-injection-apply.js';
import { planVerifiedRebootRestore, verifyCodexRebootIdentity } from '../../src/reboot-restore.js';
import { hashCodexPrompt, resolveCodexIdentity } from '../../src/recovery/codex-identity.js';
import { readRebootIdentityFence, writeRebootIdentityFence } from '../../src/recovery/reboot-identity-fence.js';
import { Session } from '../../src/session.js';
import type { StateStore } from '../../src/state-store.js';
import type { SessionState } from '../../src/types.js';
import { createUser, invalidateUsersCache } from '../../src/user-store.js';
import { rebootRestoreRegistry } from '../../src/web/reboot-restore-registry.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { registerRebootRestoreRoutes } from '../../src/web/routes/reboot-restore-routes.js';
import { WebServer } from '../../src/web/server.js';

const UUID = '12345678-1234-1234-1234-123456789abc';
const servers: WebServer[] = [];
const apps: FastifyInstance[] = [];
const originalMultiuser = process.env.CODEMAN_MULTIUSER;

function sessionMap(server: WebServer): Map<string, Session> {
  return Reflect.get(server, 'sessions');
}

async function closeServer(server: WebServer): Promise<void> {
  const sessions = [...sessionMap(server).values()];
  await server.stop();
  for (const session of sessions) await session.stop();
  servers.splice(servers.indexOf(server), 1);
}

async function harness() {
  // Do not listen or run boot/background services. The route context is the
  // real server's, including listener setup, reapply, discard and persistence.
  const server = new WebServer(0, false, true);
  servers.push(server);
  const ctx = Reflect.get(server, 'createRouteContext').call(server) as Parameters<
    typeof registerRebootRestoreRoutes
  >[1];
  ctx.getWorkspaceHooksEnabled = async () => false;
  ctx.getAgentSkillEnabled = async () => false;
  const app = Fastify({ logger: false });
  apps.push(app);
  await app.register(fastifyCookie);
  registerRebootRestoreRoutes(app, ctx);
  installRouteErrorHandler(app);
  await app.ready();
  return { server, app, store: Reflect.get(server, 'store') as StateStore };
}

function fixture(id: string, home = join(homedir(), '.codex')) {
  const workspace = join(homedir(), 'reboot-workspaces', id);
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(home, 'sessions'), { recursive: true });
  const rollout = join(home, 'sessions', `rollout-2026-10-13T15-00-00-${UUID}.jsonl`);
  writeFileSync(
    rollout,
    JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-10-13T15:00:00Z',
      payload: { id: UUID, cwd: workspace, originator: `codeman_${id}` },
    }) + '\n'
  );
  const state: SessionState = {
    id,
    mode: 'codex',
    pid: 1234,
    status: 'idle',
    workingDir: workspace,
    currentTaskId: null,
    createdAt: Date.now() - 60_000,
    codexConfig: { noDaemon: true, sandbox: 'read-only', approvalPolicy: 'on-request' },
  };
  Object.assign(state, { __envOverrides: { CODEX_HOME: home } });
  return { state, home, rollout };
}

async function offer(state: SessionState): Promise<void> {
  const plan = await planVerifiedRebootRestore([state.id], { [state.id]: state }, () => true);
  expect(plan.skipped).toEqual([]);
  expect(plan.restore).toHaveLength(1);
  rebootRestoreRegistry.set(plan.restore);
}

afterEach(async () => {
  for (const server of [...servers]) await closeServer(server);
  for (const app of apps.splice(0)) await app.close();
  rebootRestoreRegistry.reset();
  await writeCustomModelHosts(getDataDir(), []);
  if (originalMultiuser === undefined) delete process.env.CODEMAN_MULTIUSER;
  else process.env.CODEMAN_MULTIUSER = originalMultiuser;
  invalidateUsersCache();
  vi.restoreAllMocks();
});

describe('durable Codex reboot completion', () => {
  it('restores twice after the consumed submission ages out of bounded history', async () => {
    const { state, home } = fixture('aaaaaaaa-1111-2222-3333-444444444444');
    const prompt = 'Original exact task before the first reboot';
    const submission = { at: Date.now(), hash: hashCodexPrompt(prompt) };
    writeFileSync(
      join(home, 'history.jsonl'),
      JSON.stringify({ session_id: UUID, ts: submission.at / 1000, text: prompt }) + '\n'
    );
    writeRebootIdentityFence(state.id, { switchPending: false, submission });
    await offer(state);
    const first = await harness();

    const result = await first.app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    expect(result.json().restored.map((item: { id: string }) => item.id)).toEqual([state.id]);
    expect(readRebootIdentityFence(state.id)).toEqual({
      switchPending: false,
      submission: undefined,
      resumeSessionId: UUID,
    });
    // The fence must also cover the crash window before the debounced state
    // writer has replaced the original record, which has no resume UUID.
    expect(await verifyCodexRebootIdentity(state)).toBe(UUID);
    await vi.waitFor(() => expect(first.store.getSession(state.id)?.codexConfig?.resumeSessionId).toBe(UUID));
    await closeServer(first.server);
    const saved = JSON.parse(readFileSync(dataPath('state.json'), 'utf8')).sessions[state.id] as SessionState;
    expect(saved.codexConfig?.resumeSessionId).toBe(UUID);

    appendFileSync(
      join(home, 'history.jsonl'),
      Array.from({ length: 640 }, (_, i) =>
        JSON.stringify({
          session_id: UUID,
          ts: (submission.at + 1_000 + i) / 1000,
          text: `Later task ${i} ${'x'.repeat(600)}`,
        })
      ).join('\n') + '\n'
    );
    expect(
      await resolveCodexIdentity({
        sessionId: state.id,
        workingDir: state.workingDir,
        noDaemon: true,
        codexHome: home,
        submission,
      })
    ).toMatchObject({ reason: 'unverified' });

    await offer(saved);
    const second = await harness();
    const again = await second.app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    expect(again.json().restored.map((item: { id: string }) => item.id)).toEqual([state.id]);
    expect(sessionMap(second.server).get(state.id)?.codexConfig?.resumeSessionId).toBe(UUID);
  });

  it.each(['switch', 'untracked'] as const)('retains a new %s veto recorded during startup', async (kind) => {
    const { state } = fixture(`${kind === 'switch' ? 'bbbbbbbb' : 'cccccccc'}-1111-2222-3333-444444444444`);
    state.codexConfig!.resumeSessionId = UUID;
    await offer(state);
    const original = WebServer.prototype.reapplyPersistedSessionState;
    vi.spyOn(WebServer.prototype, 'reapplyPersistedSessionState').mockImplementation(
      async function (session, saved, phase, options) {
        await original.call(this, session, saved, phase, options);
        if (phase === 'after-spawn') {
          if (kind === 'untracked') session.fenceUntrackedInput();
          else session.trackUserInput('/resume different-thread\r');
        }
      }
    );
    const { server, app } = await harness();
    const result = await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    expect(result.json().restored).toHaveLength(1);
    expect(readRebootIdentityFence(state.id)).toMatchObject({ switchPending: true });
    if (kind === 'untracked') expect(readRebootIdentityFence(state.id)?.untrackedInput).toBe(true);
    expect(await verifyCodexRebootIdentity(sessionMap(server).get(state.id)!.toState())).toBeUndefined();
  });

  it('leaves the previous fence intact when a launched restore is dismissed', async () => {
    const { state, home } = fixture('dddddddd-1111-2222-3333-444444444444');
    const submission = { at: Date.now(), hash: hashCodexPrompt('pre-reboot task') };
    writeFileSync(
      join(home, 'history.jsonl'),
      JSON.stringify({ session_id: UUID, ts: submission.at / 1000, text: 'pre-reboot task' }) + '\n'
    );
    writeRebootIdentityFence(state.id, { switchPending: false, submission });
    await offer(state);
    const original = WebServer.prototype.reapplyPersistedSessionState;
    vi.spyOn(WebServer.prototype, 'reapplyPersistedSessionState').mockImplementation(async function (...args) {
      await original.apply(this, args);
      if (args[2] === 'after-spawn') rebootRestoreRegistry.clear(() => true);
    });
    const { server, app } = await harness();
    const result = await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    expect(result.json().skipped).toEqual([{ sessionId: state.id, reason: 'restore-cancelled' }]);
    expect(sessionMap(server).has(state.id)).toBe(false);
    expect(readRebootIdentityFence(state.id)).toEqual({ switchPending: false, submission });
  });
});

describe('deleted custom endpoint on reboot', () => {
  it('rebuilds an available endpoint and drops retired injected keys for a privileged owner', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    invalidateUsersCache();
    await createUser({ username: 'current-admin', role: 'admin', password: 'fixture-password' });
    const id = '99999999-1111-2222-3333-444444444444';
    const home = customModelConfigDir(id);
    const { state, rollout } = fixture(id, home);
    state.owner = 'current-admin';
    state.codexConfig!.resumeSessionId = UUID;
    Object.assign(state, {
      __envOverrides: { CODEX_HOME: home, CODEX_RETIRED: 'stale', CODEX_OTHER: 'keep' },
      __customModel: {
        endpointId: 'current-endpoint',
        modelId: 'custom-model',
        envKeys: ['CODEX_HOME', 'CODEMAN_CUSTOM_MODEL_API_KEY', 'CODEX_RETIRED'],
        configDir: home,
      },
    });
    await writeCustomModelHosts(getDataDir(), [
      { id: 'current-endpoint', label: 'current', baseUrl: 'http://127.0.0.1:8080', apiKey: 'current-fixture-key' },
    ]);
    await offer(state);
    const { server, app } = await harness();
    const result = await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    expect(result.json().restored).toHaveLength(1);
    expect(Reflect.get(sessionMap(server).get(id)!, '_envOverrides')).toEqual({
      CODEX_HOME: home,
      CODEMAN_CUSTOM_MODEL_API_KEY: 'current-fixture-key',
      CODEX_OTHER: 'keep',
    });
    expect(readFileSync(rollout, 'utf8')).toContain(UUID);
  });

  it.each(['single-user', 'privileged-owner'] as const)('refuses stale saved config for %s', async (kind) => {
    const id = `${kind === 'single-user' ? 'eeeeeeee' : 'ffffffff'}-1111-2222-3333-444444444444`;
    const home = customModelConfigDir(id);
    const { state, rollout } = fixture(id, home);
    state.codexConfig!.resumeSessionId = UUID;
    if (kind === 'privileged-owner') {
      process.env.CODEMAN_MULTIUSER = '1';
      invalidateUsersCache();
      await createUser({ username: 'restore-admin', role: 'admin', password: 'fixture-password' });
      state.owner = 'restore-admin';
    } else delete process.env.CODEMAN_MULTIUSER;
    const history = join(home, 'history.jsonl');
    const config = join(home, 'config.toml');
    writeFileSync(history, 'original history\n');
    writeFileSync(config, 'model_provider = "deleted-endpoint"\n');
    Object.assign(state, {
      __envOverrides: { CODEX_HOME: home, CODEX_OTHER: 'keep' },
      __customModel: {
        endpointId: 'deleted-endpoint',
        modelId: 'custom-model',
        envKeys: ['CODEX_HOME', 'CODEMAN_CUSTOM_MODEL_API_KEY'],
        configDir: home,
      },
    });
    await writeCustomModelHosts(getDataDir(), []);
    await offer(state);
    const start = vi.spyOn(Session.prototype, 'startInteractive');
    const { server, app } = await harness();
    const result = await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    expect(result.json().restored).toEqual([]);
    expect(result.json().skipped).toEqual([{ sessionId: id, reason: 'rebuild-failed' }]);
    expect(start).not.toHaveBeenCalled();
    expect(sessionMap(server).has(id)).toBe(false);
    expect(rebootRestoreRegistry.list(() => true).map((entry) => entry.sessionId)).toEqual([id]);
    expect(readFileSync(rollout, 'utf8')).toContain(UUID);
    expect(readFileSync(history, 'utf8')).toBe('original history\n');
    expect(readFileSync(config, 'utf8')).toBe('model_provider = "deleted-endpoint"\n');
  });
});
