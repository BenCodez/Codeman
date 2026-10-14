/** Production reboot route, Session, and WebServer persistence against isolated test-mode panes. */
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataPath, getDataDir } from '../../src/config/instance.js';
import { userCasesDir } from '../../src/config/multiuser.js';
import { writeCustomModelHosts } from '../../src/custom-model-hosts.js';
import { customModelConfigDir } from '../../src/custom-model-injection-apply.js';
import { planVerifiedRebootRestore, verifyCodexRebootIdentity } from '../../src/reboot-restore.js';
import { hashCodexPrompt, resolveCodexIdentity } from '../../src/recovery/codex-identity.js';
import { readRebootIdentityFence, writeRebootIdentityFence } from '../../src/recovery/reboot-identity-fence.js';
import { Session } from '../../src/session.js';
import { TmuxManager } from '../../src/tmux-manager.js';
import type { StateStore } from '../../src/state-store.js';
import type { SessionState } from '../../src/types.js';
import { createUser, invalidateUsersCache, updateUser } from '../../src/user-store.js';
import { rebootRestoreRegistry } from '../../src/web/reboot-restore-registry.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { registerRebootRestoreRoutes } from '../../src/web/routes/reboot-restore-routes.js';
import { WebServer } from '../../src/web/server.js';
import * as launchGrants from '../../src/session-env-clamp.js';

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
  vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);
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
  return { server, app, ctx, store: Reflect.get(server, 'store') as StateStore };
}

function fixture(id: string, home = join(homedir(), '.codex'), workspace = join(homedir(), 'reboot-workspaces', id)) {
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
  Object.assign(state, { __envOverrides: { CODEX_HOME: home }, __codexRecoveryHome: home });
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
  it.each([
    'create-response-lost',
    'attachment-failure',
    'finalization-failure',
    'cancelled-after-create',
    'cleanup-failure',
  ])('preserves a possibly started worker and historical evidence after %s', async (uncertainty) => {
    const id = `${hashCodexPrompt(uncertainty).slice(0, 8)}-5555-2222-3333-444444444444`;
    const { state, home, rollout } = fixture(id, join(homedir(), 'uncertain-restore-homes', uncertainty));
    state.codexConfig!.resumeSessionId = UUID;
    await offer(state);
    const { server, app, ctx, store } = await harness();
    store.setSession(id, state);
    store.flush();
    const historical = JSON.parse(readFileSync(dataPath('state.json'), 'utf8')).sessions[id];
    const priorRollout = readFileSync(rollout, 'utf8');
    const kill = vi.spyOn(ctx.mux, 'killSession');
    const originalCreate = ctx.mux.createSession.bind(ctx.mux);
    vi.spyOn(ctx.mux, 'createSession').mockImplementation(async (options) => {
      const result = await originalCreate(options);
      if (uncertainty === 'create-response-lost' || uncertainty === 'cleanup-failure')
        throw new Error('Fixture response lost after worker creation');
      if (uncertainty === 'cancelled-after-create') rebootRestoreRegistry.clear(() => true);
      return result;
    });
    if (uncertainty === 'attachment-failure') {
      const setup = Reflect.get(Session.prototype, '_setupOrAttachMuxSession');
      vi.spyOn(
        Session.prototype as unknown as { _setupOrAttachMuxSession(options: unknown): Promise<unknown> },
        '_setupOrAttachMuxSession'
      ).mockImplementation(async function (options) {
        await setup.call(this, options);
        throw new Error('Fixture attachment response lost');
      });
    }
    if (uncertainty === 'finalization-failure') {
      const apply = ctx.reapplyPersistedSessionState.bind(ctx);
      ctx.reapplyPersistedSessionState = async (...args) => {
        if (args[2] === 'after-spawn') throw new Error('Fixture finalization unavailable');
        await apply(...args);
      };
    }
    if (uncertainty === 'cleanup-failure') {
      const stop = Session.prototype.stop;
      vi.spyOn(Session.prototype, 'stop').mockImplementation(async function (...args) {
        await stop.apply(this, args);
        throw new Error('Fixture cleanup response lost');
      });
    }
    const result = (await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} })).json();
    expect(result.restored).toEqual([]);
    expect(result.skipped).toEqual([{ sessionId: id, reason: 'restore-uncertain' }]);
    expect(kill).not.toHaveBeenCalled();
    expect(ctx.mux.getSession(id)).toBeDefined();
    expect(sessionMap(server).has(id)).toBe(false);
    expect(readFileSync(rollout, 'utf8')).toBe(priorRollout);
    store.flush();
    expect(JSON.parse(readFileSync(dataPath('state.json'), 'utf8')).sessions[id]).toEqual(historical);
    expect(readRebootIdentityFence(id)).toMatchObject({ switchPending: true });
    expect(await verifyCodexRebootIdentity(state)).toBeUndefined();
    expect(rebootRestoreRegistry.list(() => true)).toHaveLength(uncertainty === 'cancelled-after-create' ? 0 : 1);
  });

  it.each(['final-grant', 'mux-preparation'] as const)(
    'refuses a saved privileged launch when its current grant is revoked during %s',
    async (stage) => {
      process.env.CODEMAN_MULTIUSER = '1';
      invalidateUsersCache();
      const username = `final-grant-${stage}`;
      await createUser({ username, role: 'user', password: 'fixture-password', canBypassPermissions: true });
      const id = `${hashCodexPrompt(stage).slice(0, 8)}-3333-2222-3333-444444444444`;
      const { state } = fixture(id, join(homedir(), '.codex'), join(userCasesDir(username), 'project'));
      state.owner = username;
      state.codexConfig = {
        noDaemon: true,
        resumeSessionId: UUID,
        sandbox: 'danger-full-access',
        approvalPolicy: 'never',
        dangerouslyBypassApprovals: true,
      };
      await offer(state);
      const { server, app, ctx, store } = await harness();
      store.setSession(id, state);
      let revoked = false;
      if (stage === 'final-grant') {
        const clamp = launchGrants.clampExternalCliConfigsForOwner;
        let calls = 0;
        vi.spyOn(launchGrants, 'clampExternalCliConfigsForOwner').mockImplementation(async (...args) => {
          const result = await clamp(...args);
          if (++calls === 2) {
            await updateUser(username, { canBypassPermissions: false });
            revoked = true;
          }
          return result;
        });
      }
      const originalCreate = ctx.mux.createSession.bind(ctx.mux);
      const effects: string[] = [];
      vi.spyOn(ctx.mux, 'createSession').mockImplementation(async (options) => {
        if (stage === 'mux-preparation') {
          await updateUser(username, { canBypassPermissions: false });
          revoked = true;
        }
        const created = await originalCreate(options);
        effects.push(created.sessionId);
        return created;
      });
      const result = (await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} })).json();
      expect(revoked).toBe(true);
      expect(result.restored).toEqual([]);
      expect(effects).toEqual([]);
      expect(sessionMap(server).has(id)).toBe(false);
      expect(store.getSession(id)).toEqual(state);
      expect(rebootRestoreRegistry.list(() => true).map((entry) => entry.sessionId)).toEqual([id]);
    }
  );

  it.each(
    ['final-grant', 'mux-preparation'].flatMap((stage) =>
      [
        'unchanged',
        'child',
        'auth',
        'approval',
        'unknown',
        'malformed',
        'truncated',
        'history',
        'identity',
        'switch',
        'untracked',
        'submission',
        'owner-input',
      ].map((change) => ({ stage, change }))
    )
  )('retains reboot authority through $stage only with $change evidence', async ({ stage, change }) => {
    const id = `${hashCodexPrompt(`${stage}:${change}`).slice(0, 8)}-1111-2222-3333-444444444444`;
    const { state, home, rollout } = fixture(id, join(homedir(), 'guard-homes', `${stage}-${change}`));
    state.codexConfig!.resumeSessionId = UUID;
    const now = Date.now();
    const prompt = 'Original exact owner task';
    const submission = { at: now, hash: hashCodexPrompt(prompt) };
    writeFileSync(
      join(home, 'history.jsonl'),
      JSON.stringify({ session_id: UUID, ts: now / 1000, text: prompt }) + '\n'
    );
    writeRebootIdentityFence(id, { switchPending: false, submission });
    await offer(state);
    const { server, app, ctx, store } = await harness();
    store.setSession(id, state);
    store.flush();
    const historical = JSON.parse(readFileSync(dataPath('state.json'), 'utf8')).sessions[id];
    let changed = false;
    const mutate = () => {
      if (changed) return;
      changed = true;
      const event = (payload: unknown) =>
        JSON.stringify({ type: 'event_msg', timestamp: new Date(now).toISOString(), payload }) + '\n';
      const additions: Record<string, string> = {
        child: event({ type: 'collab_agent_spawn_begin', call_id: 'new-child' }),
        auth: event({ type: 'error', message: 'Sanitized authentication fixture.', codex_error_info: 'Unauthorized' }),
        approval: event({ type: 'exec_approval_request', call_id: 'new-approval' }),
        unknown: event({
          type: 'error',
          message: 'Sanitized uncertainty fixture.',
          codex_error_info: 'thread_rollback_failed',
        }),
        malformed: '{partial-fixture}\n',
        truncated: JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(300 * 1024) } }) + '\n',
      };
      if (change in additions) appendFileSync(rollout, additions[change]);
      else if (change === 'history')
        appendFileSync(
          join(home, 'history.jsonl'),
          JSON.stringify({ session_id: '99999999-2222-3333-4444-555555555555', ts: now / 1000, text: prompt }) + '\n'
        );
      else if (change === 'identity') {
        const other = '99999999-2222-3333-4444-555555555555';
        writeFileSync(
          join(home, 'sessions', `rollout-2026-10-13T23-00-00-${other}.jsonl`),
          JSON.stringify({
            type: 'session_meta',
            timestamp: new Date(now + 1).toISOString(),
            payload: { id: other, cwd: state.workingDir, originator: `codeman_${id}` },
          }) + '\n'
        );
      } else if (change === 'switch') writeRebootIdentityFence(id, { switchPending: true });
      else if (change === 'untracked') writeRebootIdentityFence(id, { switchPending: true, untrackedInput: true });
      else if (change === 'submission')
        writeRebootIdentityFence(id, {
          switchPending: false,
          submission: { at: now + 1, hash: hashCodexPrompt('New owner request') },
        });
      else if (change === 'owner-input')
        expect(sessionMap(server).get(id)!.write('New owner request\r', { fromUser: true })).toBe(false);
    };
    if (stage === 'final-grant') {
      const clamp = launchGrants.clampExternalCliConfigsForOwner;
      let calls = 0;
      vi.spyOn(launchGrants, 'clampExternalCliConfigsForOwner').mockImplementation(async (...args) => {
        const result = await clamp(...args);
        if (++calls === 2) mutate();
        return result;
      });
    }
    const originalCreate = ctx.mux.createSession.bind(ctx.mux);
    const effects: string[] = [];
    vi.spyOn(ctx.mux, 'createSession').mockImplementation(async (options) => {
      if (stage === 'mux-preparation') mutate();
      const result = await originalCreate(options);
      effects.push(result.sessionId);
      return result;
    });
    const result = (await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} })).json();
    expect(changed).toBe(true);
    if (change === 'unchanged') {
      expect(result.restored).toHaveLength(1);
      expect(effects).toEqual([id]);
    } else {
      expect(result.restored).toEqual([]);
      expect(effects).toEqual([]);
      expect(sessionMap(server).has(id)).toBe(false);
      store.flush();
      expect(JSON.parse(readFileSync(dataPath('state.json'), 'utf8')).sessions[id]).toEqual(historical);
      expect(rebootRestoreRegistry.list(() => true).map((entry) => entry.sessionId)).toEqual([id]);
    }
  });

  it.each(['retained', 'revoked-before-click', 'revoked-during-preparation'] as const)(
    'preserves exact saved Codex config only while owner grants are %s',
    async (grant) => {
      process.env.CODEMAN_MULTIUSER = '1';
      invalidateUsersCache();
      const username = `grant-${grant}`;
      await createUser({ username, role: 'user', password: 'fixture-password', canBypassPermissions: true });
      const id = `${grant === 'retained' ? '12345678' : grant === 'revoked-before-click' ? '23456789' : '34567890'}-1111-2222-3333-444444444444`;
      const { state } = fixture(id, join(homedir(), '.codex'), join(userCasesDir(username), 'project'));
      state.owner = username;
      state.codexConfig = {
        noDaemon: true,
        noAltScreen: true,
        resumeSessionId: UUID,
        sandbox: 'danger-full-access',
        approvalPolicy: 'never',
        dangerouslyBypassApprovals: true,
        model: 'example-model',
        reasoningEffort: 'high',
      };
      Object.assign(state, { pinned: true, inputTokens: 234, outputTokens: 123, totalCost: 12 });
      // The default home remains authorized after revocation, so this regression
      // specifically exercises saved launch flags rather than home provenance.
      delete (state as SessionState & { __envOverrides?: unknown }).__envOverrides;
      await offer(state);
      const { server, app, ctx, store } = await harness();
      store.setSession(id, state);
      store.flush();
      const historicalSnapshot = JSON.parse(readFileSync(dataPath('state.json'), 'utf8')).sessions[id];
      const start = vi.spyOn(Session.prototype, 'startInteractive').mockResolvedValue();
      if (grant === 'revoked-before-click') await updateUser(username, { canBypassPermissions: false });
      if (grant === 'revoked-during-preparation') {
        const setup = ctx.setupSessionListeners.bind(ctx);
        ctx.setupSessionListeners = async (session) => {
          await setup(session);
          await updateUser(username, { canBypassPermissions: false });
        };
      }
      const result = (await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} })).json();
      if (grant === 'retained') {
        expect(result.restored).toHaveLength(1);
        expect(result.skipped).toEqual([]);
        expect(start).toHaveBeenCalledTimes(1);
        expect(sessionMap(server).get(id)!.toState().codexConfig).toEqual(state.codexConfig);
      } else {
        expect(result.restored).toEqual([]);
        expect(result.skipped).toEqual([{ sessionId: id, reason: 'identity-unverified' }]);
        expect(start).not.toHaveBeenCalled();
        expect(sessionMap(server).has(id)).toBe(false);
        store.flush();
        expect(store.getSession(id)).toEqual(state);
        expect(JSON.parse(readFileSync(dataPath('state.json'), 'utf8')).sessions[id]).toEqual(historicalSnapshot);
        expect(rebootRestoreRegistry.list(() => true).map((entry) => entry.sessionId)).toEqual([id]);
      }
    }
  );

  it.each(
    (['failed', 'cancelled'] as const).flatMap((outcome) =>
      (['programmatic', 'user', 'direct-attach'] as const).map((input) => ({ outcome, input }))
    )
  )('preserves the historical record through $input input during a $outcome launch', async ({ outcome, input }) => {
    const inputIndex = ['programmatic', 'user', 'direct-attach'].indexOf(input) + 1;
    const { state } = fixture(
      `${outcome === 'failed' ? '11111111' : '22222222'}-0000-0000-0000-00000000000${inputIndex}`
    );
    Object.assign(state, {
      pinned: true,
      pinnedAt: 456,
      inputTokens: 234,
      outputTokens: 123,
      totalCost: 12,
    });
    state.codexConfig!.resumeSessionId = UUID;
    writeRebootIdentityFence(state.id, { switchPending: false, resumeSessionId: UUID });
    await offer(state);
    const { server, app, store } = await harness();
    store.setSession(state.id, state);
    store.flush();
    const persisted = () => JSON.parse(readFileSync(dataPath('state.json'), 'utf8')).sessions[state.id];
    const originalSnapshot = persisted();

    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let launching: Session | undefined;
    vi.spyOn(Session.prototype, 'startInteractive').mockImplementation(async function () {
      launching = this;
      await barrier;
      if (outcome === 'failed') throw new Error('fixture launch failed');
    });
    const restore = app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    try {
      await vi.waitFor(() => expect(launching).toBeDefined());
      expect(sessionMap(server).get(state.id)).toBe(launching);
      if (input === 'direct-attach') launching!.fenceUntrackedInput();
      else expect(launching!.write('queued launch input\r', { fromUser: input === 'user' })).toBe(false);
      // Exercise the debounced writer too, beyond its ordinary 100ms window.
      Reflect.get(server, 'persistSessionState').call(server, launching);
      await new Promise((resolve) => setTimeout(resolve, 150));
      store.flush();
      expect(store.getSession(state.id)).toEqual(state);
      expect(persisted()).toEqual(originalSnapshot);
      expect(readRebootIdentityFence(state.id)).toMatchObject({
        switchPending: true,
        ...(input === 'direct-attach' ? { untrackedInput: true } : {}),
      });
      if (outcome === 'cancelled') {
        const dismiss = await app.inject({ method: 'POST', url: '/api/reboot-restore/dismiss', payload: {} });
        expect(dismiss.statusCode).toBe(200);
      }
    } finally {
      release();
    }
    const result = (await restore).json();
    expect(result.restored).toEqual([]);
    expect(result.skipped).toEqual([
      { sessionId: state.id, reason: outcome === 'failed' ? 'rebuild-failed' : 'restore-cancelled' },
    ]);
    expect(sessionMap(server).has(state.id)).toBe(false);
    store.flush();
    expect(store.getSession(state.id)).toEqual(state);
    expect(persisted()).toEqual(originalSnapshot);
    expect(rebootRestoreRegistry.list(() => true)).toHaveLength(outcome === 'failed' ? 1 : 0);
    // Retaining the offer does not authorize a retry through newly tainted identity.
    expect(await verifyCodexRebootIdentity(state)).toBeUndefined();
  });

  it('commits restored totals on success and persists later current-session input', async () => {
    const { state } = fixture('33333333-0000-0000-0000-000000000000');
    Object.assign(state, { pinned: true, pinnedAt: 456, inputTokens: 234, outputTokens: 123, totalCost: 12 });
    state.codexConfig!.resumeSessionId = UUID;
    await offer(state);
    const { server, app, store } = await harness();
    store.setSession(state.id, state);
    store.flush();
    const originalStart = Session.prototype.startInteractive;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let launching: Session | undefined;
    vi.spyOn(Session.prototype, 'startInteractive').mockImplementation(async function (...args) {
      launching = this;
      await barrier;
      await originalStart.apply(this, args);
    });
    const restore = app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    try {
      await vi.waitFor(() => expect(launching).toBeDefined());
      expect(store.getSession(state.id)).toEqual(state);
    } finally {
      release();
    }
    expect((await restore).json().restored).toHaveLength(1);
    await vi.waitFor(() => expect(store.getSession(state.id)?.pid).not.toBe(1234));
    expect(store.getSession(state.id)).toMatchObject({
      pinned: true,
      pinnedAt: 456,
      inputTokens: 234,
      outputTokens: 123,
      totalCost: 12,
    });
    expect(readRebootIdentityFence(state.id)).toMatchObject({ switchPending: false, resumeSessionId: UUID });
    const session = sessionMap(server).get(state.id)!;
    expect(session.codexRestoreWorkerMayExist).toBe(false);
    session.restoreTokens(235, 124, 13);
    expect(session.write('Current exact prompt\r', { fromUser: true })).toBe(true);
    expect(store.getSession(state.id)).toMatchObject({ inputTokens: 235, outputTokens: 124, totalCost: 13 });
    expect(store.getSession(state.id)?.lastSubmitAt).toBeGreaterThan(0);
    expect(readRebootIdentityFence(state.id)).toMatchObject({
      switchPending: false,
      submission: { hash: hashCodexPrompt('Current exact prompt') },
    });
    store.flush();
    expect(JSON.parse(readFileSync(dataPath('state.json'), 'utf8')).sessions[state.id].inputTokens).toBe(235);
  });

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

  it('preserves the old submission and fences an uncertain worker when a launched restore is dismissed', async () => {
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
    const { server, app, ctx } = await harness();
    const kill = vi.spyOn(ctx.mux, 'killSession');
    const result = await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    expect(result.json().skipped).toEqual([{ sessionId: state.id, reason: 'restore-uncertain' }]);
    expect(sessionMap(server).has(state.id)).toBe(false);
    expect(readRebootIdentityFence(state.id)).toEqual({ switchPending: true, submission });
    expect(ctx.mux.getSession(state.id)).toBeDefined();
    expect(kill).not.toHaveBeenCalled();
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
