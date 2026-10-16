/** @fileoverview Production reboot route, Session, and WebServer persistence against isolated test-mode panes. */
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath, getDataDir } from '../../src/config/instance.js';
import { userCasesDir } from '../../src/config/multiuser.js';
import { writeCustomModelHosts } from '../../src/custom-model-hosts.js';
import { customModelConfigDir } from '../../src/custom-model-injection-apply.js';
import { planVerifiedRebootRestore, verifyCodexRebootIdentity } from '../../src/reboot-restore.js';
import { hashCodexPrompt, resolveCodexIdentity } from '../../src/recovery/codex-identity.js';
import { readRebootIdentityFence, writeRebootIdentityFence } from '../../src/recovery/reboot-identity-fence.js';
import { rebootStateBinding } from '../../src/recovery/reboot-state-binding.js';
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
import { getCli, reloadCliRegistry } from '../../src/config/cli-registry/registry.js';

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
  const plan = await planVerifiedRebootRestore([state.id], { [state.id]: state }, async () => ({
    status: 'present' as const,
    dev: 1,
    ino: 1,
  }));
  expect(plan.skipped).toEqual([]);
  expect(plan.restore).toHaveLength(1);
  await rebootRestoreRegistry.set(plan.restore);
}

afterEach(async () => {
  vi.restoreAllMocks();
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
    { sandbox: 'unsupported-sandbox' },
    { approvalPolicy: 'on-failure' },
    { noDaemon: 'true' },
    { noAltScreen: 'true' },
    { dangerouslyBypassApprovals: 'false' },
    { animations: 1 },
    { model: { name: 'model' } },
    { reasoningEffort: 'unsupported-effort' },
    { resumeSessionId: 'historical-codeman-id' },
    { resumeSessionId: null },
    { customCommand: 'unsupported command' },
  ])('refuses malformed offered launch settings before reservation or worker creation: %j', async (patch) => {
    const id = '04040404-1111-2222-3333-444444444444';
    const { state } = fixture(id);
    state.codexConfig!.resumeSessionId = UUID;
    await offer(state);
    // A durable offer can be older than the record checked at the click boundary.
    Object.assign(state.codexConfig!, patch);
    const { server, app, ctx, store } = await harness();
    store.setSession(id, state);
    store.flush();
    const historical = readFileSync(dataPath('state.json'), 'utf8');
    const prepare = vi.spyOn(ctx, 'prepareRebootRestoreRecovery');
    const add = vi.spyOn(ctx, 'addSession');
    const launch = vi.spyOn(ctx.mux, 'createSession');
    const result = await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    expect(result.json().restored).toEqual([]);
    expect(result.json().skipped).toEqual([{ sessionId: id, reason: 'identity-unverified' }]);
    expect(prepare).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(sessionMap(server).has(id)).toBe(false);
    expect(readFileSync(dataPath('state.json'), 'utf8')).toBe(historical);
    expect(rebootRestoreRegistry.list(() => true).map((entry) => entry.sessionId)).toEqual([id]);
  });

  it.each(['saved', 'derived'] as const)(
    'launches healthy exact settings with a %s resume UUID through the actual restore route',
    async (kind) => {
      const id = `${kind === 'saved' ? '05050505' : '06060606'}-1111-2222-3333-444444444444`;
      const { state, home } = fixture(id);
      state.codexConfig = {
        noDaemon: true,
        noAltScreen: true,
        model: 'example-model',
        reasoningEffort: 'high',
        sandbox: 'read-only',
        approvalPolicy: 'on-request',
        animations: false,
        dangerouslyBypassApprovals: false,
        ...(kind === 'saved' ? { resumeSessionId: UUID } : {}),
      };
      const prompt = 'Exact original restoration task';
      const submission = { at: Date.now(), hash: hashCodexPrompt(prompt) };
      writeFileSync(
        join(home, 'history.jsonl'),
        JSON.stringify({ session_id: UUID, ts: submission.at / 1000, text: prompt }) + '\n'
      );
      await writeRebootIdentityFence(id, { switchPending: false, submission });
      await offer(state);
      const { server, app, ctx, store } = await harness();
      store.setSession(id, state);
      const launch = vi.spyOn(ctx.mux, 'createSession');
      const result = await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
      expect(result.json().skipped).toEqual([]);
      expect(result.json().restored.map((item: { id: string }) => item.id)).toEqual([id]);
      const planned = { ...state.codexConfig, resumeSessionId: UUID };
      expect(launch).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ codexConfig: planned, recoveryCodexHome: home })
      );
      expect(sessionMap(server).get(id)!.codexConfig).toEqual(planned);
      expect(store.getSession(id)?.codexConfig).toEqual(planned);
    }
  );

  it.each(['inherited', 'default'] as const)(
    'restores an empty override to the exact captured %s home through the real route and fake mux',
    async (kind) => {
      const id = `${kind === 'default' ? '01010101' : '02020202'}-1111-2222-3333-444444444444`;
      const home = join(homedir(), kind === 'default' ? '.codex' : 'empty-route-inherited');
      vi.stubEnv('CODEX_HOME', kind === 'default' ? undefined : home);
      try {
        const { state } = fixture(id, home);
        state.codexConfig!.resumeSessionId = UUID;
        Object.assign(state, { __envOverrides: { CODEX_HOME: '' } });
        vi.stubEnv('CODEX_HOME', join(homedir(), 'empty-route-new-default'));
        await offer(state);
        const { server, app, ctx, store } = await harness();
        store.setSession(id, state);
        const launch = vi.spyOn(ctx.mux, 'createSession');
        const result = await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
        expect(result.json().skipped).toEqual([]);
        expect(result.json().restored.map((item: { id: string }) => item.id)).toEqual([id]);
        expect(launch).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            recoveryCodexHome: home,
            envOverrides: { CODEX_HOME: '' },
            codexConfig: state.codexConfig,
          })
        );
        expect(sessionMap(server).get(id)!.getRecoveryContext()).toMatchObject({ codexHome: home, noDaemon: true });
        expect(store.getSession(id)).toMatchObject({ __codexRecoveryHome: home, codexConfig: state.codexConfig });
        expect(rebootRestoreRegistry.list(() => true)).toEqual([]);
      } finally {
        vi.unstubAllEnvs();
      }
    }
  );

  it('refuses an empty override when the captured inherited home is no longer authorized', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    invalidateUsersCache();
    const username = 'empty-home-revoked';
    await createUser({ username, role: 'user', password: 'fixture-password', canBypassPermissions: true });
    const id = '03030303-1111-2222-3333-444444444444';
    const { state } = fixture(id, join(homedir(), 'empty-revoked-home'), join(userCasesDir(username), 'project'));
    state.owner = username;
    state.codexConfig!.resumeSessionId = UUID;
    Object.assign(state, { __envOverrides: { CODEX_HOME: '' } });
    await offer(state);
    await updateUser(username, { canBypassPermissions: false });
    const { server, app, ctx, store } = await harness();
    store.setSession(id, state);
    const launch = vi.spyOn(ctx.mux, 'createSession');
    const result = await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    expect(result.json().restored).toEqual([]);
    expect(result.json().skipped).toEqual([{ sessionId: id, reason: 'identity-unverified' }]);
    expect(launch).not.toHaveBeenCalled();
    expect(sessionMap(server).has(id)).toBe(false);
    expect(store.getSession(id)).toEqual(state);
    expect(rebootRestoreRegistry.list(() => true).map((entry) => entry.sessionId)).toEqual([id]);
  });

  it.each([
    'live',
    'dead',
    'missing',
    'no-history',
    'partial-stale',
    'partial-pruned',
    'partial-malformed',
    'partial-malformed-state',
    'partial-missing-home',
    'partial-native-config',
    'partial-native-owner',
    'partial-native-cwd',
    'partial-native-home',
    'partial-native-missing-config',
    'partial-native-missing-home',
    'binding-healthy',
    'binding-reattached',
    'binding-null-pid',
  ] as const)(
    'retains the uncertain original board identity and historical state after server reconstruction: %s',
    async (pane) => {
      const id = `aabbccdd-5555-2222-3333-${hashCodexPrompt(pane).slice(0, 12)}`;
      const { state, home } = fixture(id);
      state.name = 'Historical worker';
      state.codexConfig!.model = 'historical-model';
      const completeBinding = pane.startsWith('binding-');
      if (
        completeBinding ||
        pane.startsWith('partial-native-') ||
        ['partial-missing-home', 'partial-malformed-state'].includes(pane)
      )
        state.codexConfig!.resumeSessionId = UUID;
      const actualConfig = {
        ...state.codexConfig,
        model:
          completeBinding ||
          pane.startsWith('partial-native-') ||
          ['partial-missing-home', 'partial-malformed-state'].includes(pane)
            ? state.codexConfig.model
            : 'actual-worker-model',
        resumeSessionId: UUID,
      };
      let malformedBinding: string | undefined;
      if (pane === 'partial-malformed-state') {
        Object.assign(state.codexConfig!, { dangerouslyBypassApprovals: 'no' });
        // An old permissive digest would match these malformed saved types.
        malformedBinding = createHash('sha256')
          .update(
            JSON.stringify([
              state.id,
              state.owner ?? null,
              state.workingDir,
              home,
              Object.fromEntries(Object.entries(state.codexConfig!).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
            ])
          )
          .digest('hex');
        expect(rebootStateBinding(state)).toBeUndefined();
      }
      if (pane === 'binding-reattached') state.pid = 8765;
      if (pane === 'binding-null-pid') state.pid = null;
      const { server, ctx, store } = await harness();
      if (!['no-history', 'partial-pruned'].includes(pane)) store.setSession(id, state);
      if (pane === 'partial-missing-home') {
        const historicalWithoutHome = { ...state } as SessionState & { __codexRecoveryHome?: string };
        delete historicalWithoutHome.__codexRecoveryHome;
        store.setSession(id, historicalWithoutHome);
      }
      store.flush();
      const historical = JSON.parse(readFileSync(dataPath('state.json'), 'utf8')).sessions[id];
      await writeRebootIdentityFence(id, { resumeSessionId: UUID, switchPending: true, untrackedInput: true });
      const nativeConfig =
        pane === 'partial-native-missing-config'
          ? undefined
          : pane === 'partial-native-config'
            ? { ...actualConfig, model: 'different-native-model' }
            : actualConfig;
      const nativeHome =
        pane === 'partial-native-missing-home'
          ? undefined
          : pane === 'partial-native-home'
            ? join(home, 'different-native-home')
            : home;
      const nativeWorkingDir =
        pane === 'partial-native-cwd' ? join(state.workingDir, 'different-native-cwd') : state.workingDir;
      mkdirSync(nativeWorkingDir, { recursive: true });
      ctx.mux.registerSession({
        sessionId: id,
        muxName: `codeman-${id.slice(0, 8)}`,
        pid: 0,
        createdAt: state.createdAt,
        workingDir: nativeWorkingDir,
        mode: 'codex',
        owner: pane === 'partial-native-owner' ? 'different-native-owner' : state.owner,
        attached: false,
        name: 'Historical worker',
        recoveryCodexHome: nativeHome,
        codexRestoreUncertain: !pane.startsWith('partial-') && !completeBinding,
        codexRestoreConfig: nativeConfig,
        ...(pane.startsWith('partial-') || completeBinding
          ? {
              codexRestoreStateBinding:
                pane === 'partial-malformed'
                  ? 'not-a-binding'
                  : (malformedBinding ??
                    rebootStateBinding({
                      ...state,
                      codexConfig: actualConfig,
                      __codexRecoveryHome: home,
                    } as SessionState & { __codexRecoveryHome: string })),
            }
          : {}),
      });
      vi.spyOn(ctx.mux, 'reconcileSessions').mockResolvedValue({
        alive: completeBinding ? [id] : [],
        dead: completeBinding ? [] : [id],
        discovered: [],
      });
      vi.spyOn(ctx.mux, 'muxSessionExists').mockReturnValue(pane !== 'missing');
      vi.spyOn(ctx.mux, 'isPaneDead').mockReturnValue(pane === 'dead');
      const create = vi.spyOn(ctx.mux, 'createSession');
      const respawn = vi.spyOn(ctx.mux, 'respawnPane');
      const kill = vi.spyOn(ctx.mux, 'killSession');
      await Reflect.get(server, 'restoreMuxSessions').call(server);
      const session = sessionMap(server).get(id)!;
      expect(session).toBeDefined();
      expect(session.name).toBe(state.name);
      expect(session.claudeSessionId).toBe(nativeConfig?.resumeSessionId ?? id);
      if (!nativeConfig) expect(session.getRecoveryContext()).toMatchObject({ managed: false, noDaemon: false });
      expect(session.toState().codexConfig).toEqual(nativeConfig);
      expect(session.codexRestoreWorkerMayExist).toBe(!completeBinding);
      expect(session.getRecoveryContext()).toMatchObject({ managed: completeBinding, untrackedInput: true });
      ctx.persistSessionState(session);
      Reflect.get(server, '_persistSessionStateNow').call(server, session);
      store.flush();
      const savedAfterAttach = JSON.parse(readFileSync(dataPath('state.json'), 'utf8')).sessions[id];
      if (completeBinding) {
        expect(savedAfterAttach.codexConfig).toEqual(actualConfig);
        expect(rebootStateBinding(savedAfterAttach)).toBe(ctx.mux.getSession(id)!.codexRestoreStateBinding);
      } else expect(savedAfterAttach).toEqual(historical);
      expect(create).not.toHaveBeenCalled();
      expect(respawn).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
    }
  );

  it.each(['create-response-lost', 'attachment-failure', 'finalization-failure', 'cleanup-failure'])(
    'preserves a possibly started worker and historical evidence after %s',
    async (uncertainty) => {
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
      expect(sessionMap(server).has(id)).toBe(true);
      expect(sessionMap(server).get(id)?.codexRestoreWorkerMayExist).toBe(true);
      expect(sessionMap(server).get(id)?.getRecoveryContext()).toMatchObject({ managed: false, untrackedInput: true });
      expect(ctx.mux.getSession(id)).toMatchObject({
        codexRestoreUncertain: true,
        codexRestoreConfig: { resumeSessionId: UUID },
      });
      expect(readFileSync(rollout, 'utf8')).toBe(priorRollout);
      store.flush();
      expect(JSON.parse(readFileSync(dataPath('state.json'), 'utf8')).sessions[id]).toEqual(historical);
      expect(await readRebootIdentityFence(id)).toMatchObject({ switchPending: true });
      expect(await verifyCodexRebootIdentity(state)).toBeUndefined();
      expect(rebootRestoreRegistry.list(() => true)).toHaveLength(1);
    }
  );

  it.each(['final-grant', 'mux-preparation', 'snapshot-microtask', 'final-witness'] as const)(
    'refuses a saved privileged launch when its current grant is revoked during %s',
    async (stage) => {
      process.env.CODEMAN_MULTIUSER = '1';
      invalidateUsersCache();
      const username = `final-grant-${stage}`;
      await createUser({ username, role: 'user', password: 'fixture-password', canBypassPermissions: true });
      const id = `${hashCodexPrompt(stage).slice(0, 8)}-3333-2222-3333-444444444444`;
      const { state, rollout } = fixture(id, join(homedir(), '.codex'), join(userCasesDir(username), 'project'));
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
      if (stage === 'snapshot-microtask' || stage === 'final-witness') {
        const revoke = () => {
          const path = dataPath('users.json');
          const users = JSON.parse(readFileSync(path, 'utf8'));
          users.users.find((user: { username: string }) => user.username === username).canBypassPermissions = false;
          writeFileSync(path, JSON.stringify(users));
          revoked = true;
        };
        const clamp = launchGrants.clampRecoveryLaunchForOwner;
        let prepared = false;
        vi.spyOn(launchGrants, 'clampRecoveryLaunchForOwner').mockImplementation(async (...args) => {
          const result = await clamp(...args);
          prepared = true;
          if (stage === 'snapshot-microtask') queueMicrotask(revoke);
          return result;
        });
        if (stage === 'final-witness') {
          const open = fs.open.bind(fs);
          vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
            const file = await open(...args);
            if (args[0] !== rollout) return file;
            const read = file.read.bind(file);
            vi.spyOn(file, 'read').mockImplementation(async (...readArgs) => {
              const result = await Reflect.apply(read, file, readArgs);
              if (prepared && !revoked) revoke();
              return result;
            });
            return file;
          });
        }
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
    await writeRebootIdentityFence(id, { switchPending: false, submission });
    await offer(state);
    const { server, app, ctx, store } = await harness();
    store.setSession(id, state);
    store.flush();
    const historical = JSON.parse(readFileSync(dataPath('state.json'), 'utf8')).sessions[id];
    let changed = false;
    const mutate = async () => {
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
      } else if (change === 'switch') await writeRebootIdentityFence(id, { switchPending: true });
      else if (change === 'untracked')
        await writeRebootIdentityFence(id, { switchPending: true, untrackedInput: true });
      else if (change === 'submission')
        await writeRebootIdentityFence(id, {
          switchPending: false,
          submission: { at: now + 1, hash: hashCodexPrompt('New owner request') },
        });
      else if (change === 'owner-input')
        expect(await sessionMap(server).get(id)!.writeAsync('New owner request\r', { fromUser: true })).toBe(false);
    };
    if (stage === 'final-grant') {
      const clamp = launchGrants.clampExternalCliConfigsForOwner;
      let calls = 0;
      vi.spyOn(launchGrants, 'clampExternalCliConfigsForOwner').mockImplementation(async (...args) => {
        const result = await clamp(...args);
        if (++calls === 2) await mutate();
        return result;
      });
    }
    const originalCreate = ctx.mux.createSession.bind(ctx.mux);
    const effects: string[] = [];
    vi.spyOn(ctx.mux, 'createSession').mockImplementation(async (options) => {
      if (stage === 'mux-preparation') await mutate();
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
    await writeRebootIdentityFence(state.id, { switchPending: false, resumeSessionId: UUID });
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
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- Expose the actual awaited launch instance to the race assertion.
      launching = this;
      await barrier;
      if (outcome === 'failed') throw new Error('fixture launch failed');
    });
    const restore = app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    try {
      await vi.waitFor(() => expect(launching).toBeDefined());
      expect(sessionMap(server).get(state.id)).toBe(launching);
      if (input === 'direct-attach') await launching!.fenceUntrackedInput();
      else expect(await launching!.writeAsync('queued launch input\r', { fromUser: input === 'user' })).toBe(false);
      // Exercise the debounced writer too, beyond its ordinary 100ms window.
      Reflect.get(server, 'persistSessionState').call(server, launching);
      await new Promise((resolve) => setTimeout(resolve, 150));
      store.flush();
      expect(store.getSession(state.id)).toEqual(state);
      expect(persisted()).toEqual(originalSnapshot);
      expect(await readRebootIdentityFence(state.id)).toMatchObject({
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
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- Expose the actual awaited launch instance to the race assertion.
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
    expect(await readRebootIdentityFence(state.id)).toMatchObject({ switchPending: false, resumeSessionId: UUID });
    const session = sessionMap(server).get(state.id)!;
    expect(session.codexRestoreWorkerMayExist).toBe(false);
    session.restoreTokens(235, 124, 13);
    expect(await session.writeAsync('Current exact prompt\r', { fromUser: true })).toBe(true);
    expect(store.getSession(state.id)).toMatchObject({ inputTokens: 235, outputTokens: 124, totalCost: 13 });
    expect(store.getSession(state.id)?.lastSubmitAt).toBeGreaterThan(0);
    expect(await readRebootIdentityFence(state.id)).toMatchObject({
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
    await writeRebootIdentityFence(state.id, { switchPending: false, submission });
    await offer(state);
    const first = await harness();

    const result = await first.app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    expect(result.json().restored.map((item: { id: string }) => item.id)).toEqual([state.id]);
    expect(await readRebootIdentityFence(state.id)).toEqual({
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
          if (kind === 'untracked') await session.fenceUntrackedInput();
          else session.trackUserInput('/resume different-thread\r');
        }
      }
    );
    const { server, app } = await harness();
    const result = await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    expect(result.json().restored).toHaveLength(1);
    expect(await readRebootIdentityFence(state.id)).toMatchObject({ switchPending: true });
    if (kind === 'untracked') expect((await readRebootIdentityFence(state.id))?.untrackedInput).toBe(true);
    expect(await verifyCodexRebootIdentity(sessionMap(server).get(state.id)!.toState())).toBeUndefined();
  });

  it.each([
    'healthy',
    'cancelled-success',
    'cancelled-lost-ack',
    'changed-owner',
    'changed-generation',
    'changed-configuration',
    'changed-registration',
    'changed-grant',
    'lost-removal-ack',
  ] as const)('handles an actually acknowledged launch held at the route await: %s', async (outcome) => {
    const { state, rollout } = fixture(
      hashCodexPrompt(outcome).slice(0, 8) + '-1111-2222-3333-444444444444',
      undefined,
      outcome === 'changed-grant' ? join(userCasesDir('cancel-grant-fixture'), 'project') : undefined
    );
    state.codexConfig!.resumeSessionId = UUID;
    if (outcome === 'changed-grant') {
      process.env.CODEMAN_MULTIUSER = '1';
      invalidateUsersCache();
      state.owner = 'cancel-grant-fixture';
      await createUser({
        username: state.owner,
        role: 'user',
        password: 'fixture-password',
        canBypassPermissions: true,
      });
      state.codexConfig!.sandbox = 'danger-full-access';
      state.codexConfig!.approvalPolicy = 'never';
    }
    await offer(state);
    const { server, app, ctx, store } = await harness();
    store.setSession(state.id, state);
    store.flush();
    const historical = JSON.parse(readFileSync(dataPath('state.json'), 'utf8')).sessions[state.id];
    const originalRollout = readFileSync(rollout, 'utf8');
    let reached!: () => void, release!: () => void, launching: Session | undefined;
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const start = Session.prototype.startInteractive;
    vi.spyOn(Session.prototype, 'startInteractive').mockImplementation(async function () {
      await start.call(this);
      launching = sessionMap(server).get(state.id)!;
      expect(launching).toBe(this);
      reached();
      await held;
      if (outcome === 'cancelled-lost-ack') throw Error('Fixture lost startup response after owned launch');
    });
    const kill = vi.spyOn(ctx.mux, 'killSession');
    const cancel = vi.spyOn(ctx.mux, 'cancelAcknowledgedRebootLaunch');
    const pending = app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    await Promise.race([
      entered,
      pending.then((response) => {
        throw Error('Restore refused before the held launch: ' + response.body);
      }),
    ]);
    expect(launching!.codexRestoreWorkerMayExist).toBe(true);
    if (outcome !== 'healthy') {
      await app.inject({ method: 'POST', url: '/api/reboot-restore/dismiss', payload: {} });
      if (outcome === 'changed-owner') launching!.owner = 'replacement-owner';
      if (outcome === 'changed-generation') await launching!.fenceUntrackedInput();
      if (outcome === 'changed-configuration')
        Reflect.set(launching!, '_envOverrides', { CODEX_HOME: 'different-home' });
      if (outcome === 'changed-registration')
        sessionMap(server).set(state.id, new Session({ id: state.id, workingDir: state.workingDir, mode: 'claude' }));
      if (outcome === 'changed-grant') await updateUser(state.owner!, { canBypassPermissions: false });
      if (outcome === 'lost-removal-ack')
        vi.spyOn(ctx.mux, 'flushSessionsDurably').mockRejectedValue(Error('Lost removal metadata ACK'));
    }
    release();
    const response = (await pending).json();
    if (outcome === 'healthy') {
      expect(response.restored).toHaveLength(1);
      expect(sessionMap(server).get(state.id)).toBe(launching);
      expect(kill).not.toHaveBeenCalled();
    } else {
      const certain = outcome === 'cancelled-success';
      expect(response.restored).toEqual([]);
      expect(response.skipped).toEqual([
        { sessionId: state.id, reason: certain ? 'restore-cancelled' : 'restore-uncertain' },
      ]);
      expect(kill).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledTimes(certain || outcome === 'lost-removal-ack' ? 1 : 0);
      expect(ctx.mux.getSession(state.id) === undefined).toBe(certain);
      expect(sessionMap(server).has(state.id)).toBe(!certain);
      store.flush();
      expect(JSON.parse(readFileSync(dataPath('state.json'), 'utf8')).sessions[state.id]).toEqual(historical);
      expect(rebootRestoreRegistry.list(() => true)).toEqual([]);
    }
    expect(readFileSync(rollout, 'utf8')).toBe(originalRollout);
    if (outcome === 'changed-registration') await launching!.stop(false);
  });

  it('preserves the old submission and stops an acknowledged worker when its restore is dismissed', async () => {
    const { state, home } = fixture('dddddddd-1111-2222-3333-444444444444');
    const submission = { at: Date.now(), hash: hashCodexPrompt('pre-reboot task') };
    writeFileSync(
      join(home, 'history.jsonl'),
      JSON.stringify({ session_id: UUID, ts: submission.at / 1000, text: 'pre-reboot task' }) + '\n'
    );
    await writeRebootIdentityFence(state.id, { switchPending: false, submission });
    await offer(state);
    const original = WebServer.prototype.reapplyPersistedSessionState;
    vi.spyOn(WebServer.prototype, 'reapplyPersistedSessionState').mockImplementation(async function (...args) {
      await original.apply(this, args);
      if (args[2] === 'after-spawn') await rebootRestoreRegistry.clear(() => true);
    });
    const { server, app, ctx } = await harness();
    const kill = vi.spyOn(ctx.mux, 'killSession');
    const result = await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    expect(result.json().skipped).toEqual([{ sessionId: state.id, reason: 'restore-cancelled' }]);
    expect(sessionMap(server).has(state.id)).toBe(false);
    expect(await readRebootIdentityFence(state.id)).toEqual({ switchPending: false, submission });
    expect(ctx.mux.getSession(state.id)).toBeUndefined();
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

  it.each([
    { held: 'profile', changed: 'grant' },
    { held: 'rollout', changed: 'grant' },
    { held: 'fence', changed: 'grant' },
    { held: 'grant', changed: 'profile' },
    { held: 'grant', changed: 'rollout' },
    { held: 'grant', changed: 'fence' },
    { held: 'grant', changed: 'none' },
  ] as const)(
    'uses one final private proof when $changed changes during the $held FD read',
    async ({ held, changed }) => {
      process.env.CODEMAN_MULTIUSER = '1';
      invalidateUsersCache();
      const username = `joint-${held}-${changed}`;
      await createUser({ username, role: 'user', password: 'fixture-password', canBypassPermissions: true });
      const id = `${hashCodexPrompt(username).slice(0, 8)}-1111-2222-3333-444444444444`;
      const home = customModelConfigDir(id);
      const { state, rollout } = fixture(id, home, join(userCasesDir(username), 'project'));
      state.owner = username;
      state.codexConfig = {
        noDaemon: true,
        resumeSessionId: UUID,
        sandbox: 'danger-full-access',
        approvalPolicy: 'never',
        dangerouslyBypassApprovals: true,
      };
      Object.assign(state, {
        __envOverrides: { CODEX_HOME: home },
        __customModel: {
          endpointId: 'joint-endpoint',
          modelId: 'custom-model',
          envKeys: ['CODEX_HOME', 'CODEMAN_CUSTOM_MODEL_API_KEY'],
          configDir: home,
        },
      });
      await writeCustomModelHosts(getDataDir(), [
        { id: 'joint-endpoint', label: 'joint', baseUrl: 'http://127.0.0.1:8080', apiKey: 'joint-fixture-key' },
      ]);
      await writeRebootIdentityFence(id, { switchPending: false, resumeSessionId: UUID });
      await offer(state);
      const { server, app, ctx, store } = await harness();
      store.setSession(id, state);
      const paths = {
        profile: join(home, 'config.toml'),
        rollout,
        fence: dataPath('reboot-identities', `${id}.json`),
        grant: dataPath('users.json'),
      };
      let prepared = false,
        inspected = false;
      const clamp = launchGrants.clampRecoveryLaunchForOwner;
      vi.spyOn(launchGrants, 'clampRecoveryLaunchForOwner').mockImplementation(async (...args) => {
        const result = await clamp(...args);
        prepared = true;
        return result;
      });
      const open = fs.open.bind(fs);
      vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const file = await open(...args);
        if (args[0] !== paths[held]) return file;
        const read = file.read.bind(file);
        vi.spyOn(file, 'read').mockImplementation(async (...readArgs) => {
          const result = await Reflect.apply(read, file, readArgs);
          if (prepared && !inspected) {
            inspected = true;
            if (changed === 'grant') {
              const users = JSON.parse(readFileSync(paths.grant, 'utf8'));
              users.users.find((user: { username: string }) => user.username === username).canBypassPermissions = false;
              writeFileSync(paths.grant, JSON.stringify(users));
            } else if (changed === 'fence')
              writeFileSync(paths.fence, JSON.stringify({ version: 1, switchPending: true }));
            else if (changed !== 'none') appendFileSync(paths[changed], '\n');
          }
          return result;
        });
        return file;
      });
      const create = vi.spyOn(ctx.mux, 'createSession');
      const result = (await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} })).json();
      expect(inspected).toBe(true);
      if (changed === 'none') {
        expect(result.restored).toHaveLength(1);
        expect(create).toHaveBeenCalledOnce();
        expect(sessionMap(server).has(id)).toBe(true);
      } else {
        expect(result.restored).toEqual([]);
        expect(create).not.toHaveBeenCalled();
        expect(sessionMap(server).has(id)).toBe(false);
        expect(store.getSession(id)).toEqual(state);
        expect(rebootRestoreRegistry.list(() => true).map((entry) => entry.sessionId)).toEqual([id]);
      }
    }
  );

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

describe('custom CLI exact reboot state bindings', () => {
  beforeEach(async () => {
    const codex = getCli('codex')!;
    await fs.mkdir(getDataDir(), { recursive: true });
    await fs.writeFile(
      dataPath('clis.json'),
      JSON.stringify({
        schemaVersion: 1,
        clis: {
          'binding-codex-a': { ...codex, id: 'binding-codex-a', label: 'Binding A', order: 990 },
          'binding-codex-b': { ...codex, id: 'binding-codex-b', label: 'Binding B', order: 991 },
          'binding-no-recovery': {
            ...codex,
            id: 'binding-no-recovery',
            label: 'Unsupported',
            order: 992,
            capabilities: { ...codex.capabilities, recovery: undefined },
          },
        },
      }),
      { mode: 0o600 }
    );
    reloadCliRegistry();
  });
  afterEach(async () => {
    await fs.rm(dataPath('clis.json'), { force: true });
    reloadCliRegistry();
  });
  it.each(['codex', 'binding-codex-a'])(
    'durably commits an exact %s restore through the actual route',
    async (mode) => {
      const id = `${mode === 'codex' ? '60606060' : '60606061'}-1111-2222-3333-444444444444`;
      const { state, home } = fixture(id, join(homedir(), `binding-route-${mode}`));
      state.mode = mode;
      state.codexConfig!.resumeSessionId = UUID;
      await offer(state);
      const { app, ctx, store } = await harness();
      store.setSession(id, state);
      store.flush();
      const result = await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
      expect(result.json().skipped).toEqual([]);
      expect(result.json().restored.map((item: { id: string }) => item.id)).toEqual([id]);
      const saved = JSON.parse(readFileSync(dataPath('state.json'), 'utf8')).sessions[id];
      const binding = rebootStateBinding(saved);
      expect(binding).toMatch(/^[a-f0-9]{64}$/);
      expect(saved).toMatchObject({ mode, codexConfig: state.codexConfig, __codexRecoveryHome: home });
      expect(ctx.mux.getSession(id)).toMatchObject({
        mode,
        codexRestoreUncertain: false,
        codexRestoreStateBinding: binding,
      });
    }
  );
  it('exact capable CLI identities cannot share a digest even with identical owner/home/config', () => {
    const { state } = fixture('61616161-1111-2222-3333-444444444444');
    state.codexConfig!.resumeSessionId = UUID;
    const bindings = ['codex', 'binding-codex-a', 'binding-codex-b'].map((mode) =>
      rebootStateBinding({ ...state, mode })
    );
    expect(bindings.every((binding) => /^[a-f0-9]{64}$/.test(binding!))).toBe(true);
    expect(new Set(bindings).size).toBe(3);
    const reordered = Object.fromEntries(Object.entries(state.codexConfig!).reverse()) as NonNullable<
      SessionState['codexConfig']
    >;
    expect(rebootStateBinding({ ...state, codexConfig: reordered })).toBe(bindings[0]);
  });
  it.each(['binding-no-recovery', 'unregistered-binding-cli', 'claude'])(
    'does not create a Codex receipt for unsupported CLI %s',
    (mode) => {
      const { state } = fixture('62626262-1111-2222-3333-444444444444');
      state.codexConfig!.resumeSessionId = UUID;
      expect(rebootStateBinding({ ...state, mode })).toBeUndefined();
    }
  );
  it.each(['binding-codex-a', 'binding-codex-b'])(
    'normal restart validates custom CLI receipt originally issued for %s',
    async (receiptMode) => {
      const id = '63636363-1111-2222-3333-444444444444';
      const { state, home } = fixture(id, join(homedir(), `binding-restart-${receiptMode}`));
      state.mode = 'binding-codex-a';
      state.codexConfig!.resumeSessionId = UUID;
      const { server, ctx, store } = await harness();
      store.setSession(id, state);
      store.flush();
      const before = structuredClone(store.getSession(id));
      ctx.mux.registerSession({
        sessionId: id,
        muxName: `codeman-${id.slice(0, 8)}`,
        pid: 0,
        createdAt: state.createdAt,
        workingDir: state.workingDir,
        mode: state.mode,
        owner: state.owner,
        attached: false,
        recoveryCodexHome: home,
        codexRestoreUncertain: false,
        codexRestoreConfig: state.codexConfig,
        codexRestoreStateBinding: rebootStateBinding({ ...state, mode: receiptMode }),
      });
      vi.spyOn(ctx.mux, 'reconcileSessions').mockResolvedValue({ alive: [id], dead: [], discovered: [] });
      vi.spyOn(ctx.mux, 'muxSessionExists').mockReturnValue(true);
      vi.spyOn(ctx.mux, 'isPaneDead').mockReturnValue(false);
      const create = vi.spyOn(ctx.mux, 'createSession');
      const respawn = vi.spyOn(ctx.mux, 'respawnPane');
      const kill = vi.spyOn(ctx.mux, 'killSession');
      await Reflect.get(server, 'restoreMuxSessions').call(server);
      const session = sessionMap(server).get(id)!;
      expect(session).toBeDefined();
      expect(session.codexRestoreWorkerMayExist).toBe(receiptMode !== state.mode);
      Reflect.get(server, '_persistSessionStateNow').call(server, session);
      store.flush();
      if (receiptMode !== state.mode) expect(store.getSession(id)).toEqual(before);
      else expect(rebootStateBinding(store.getSession(id)!)).toBe(rebootStateBinding(state));
      expect(create).not.toHaveBeenCalled();
      expect(respawn).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
    }
  );
});
