/** Actual Session/WebServer final cleanup with inert mux methods; no start/socket/PTY/SSH. */
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { Session } from '../src/session.js';
import { WebServer } from '../src/web/server.js';
import { StateStore } from '../src/state-store.js';
import { subagentWatcher } from '../src/subagent-watcher.js';
import type { TerminalMultiplexer } from '../src/mux-interface.js';
import { CodexInputBroker } from '../src/recovery/codex-input-broker.js';
import { ownedRemoteBrokerCache as cache } from '../src/recovery/remote-input-broker-cache.js';
import { registerSessionRoutes } from '../src/web/routes/session-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { createMockRouteContext } from './mocks/index.js';

type Internal = {
  sessions: Map<string, Session>;
  store: StateStore;
  cleanupSession(id: string, kill: boolean): Promise<void>;
  stopRecoveryController(id: string, drop: boolean): Promise<void>;
  tabLayouts: { runSessionDeletion: (...args: unknown[]) => Promise<void> };
};
async function fixture(
  check: (f: {
    server: WebServer;
    internal: Internal;
    session: Session;
    kill: ReturnType<typeof vi.fn>;
    scope: Parameters<typeof cache.prepare>[0];
    material: ReturnType<typeof CodexInputBroker.provisioningMaterial>;
    directory: string;
  }) => Promise<void>
) {
  const root = await fs.mkdtemp(join(homedir(), 'remote-cache-cleanup-'));
  const server = new WebServer(0, false, true),
    internal = server as unknown as Internal;
  internal.store = new StateStore(join(root, 'state.json'));
  const kill = vi.fn().mockResolvedValue(true);
  const mux = {
    killSession: kill,
    flushSessionsDurably: vi.fn().mockResolvedValue(undefined),
  } as unknown as TerminalMultiplexer;
  const remote = {
    hostId: 'fake-host',
    host: 'worker.invalid',
    username: 'fixture',
    label: 'Fixture',
    remotePath: '/worker/work',
    owned: true,
  };
  const session = new Session({
    id: randomUUID(),
    workingDir: root,
    mode: 'codex',
    remote,
    owner: 'fixture-owner',
    mux,
    useMux: true,
    codexConfig: { noDaemon: true },
  });
  internal.sessions.set(session.id, session);
  internal.store.setSession(session.id, session.toState());
  const scope = {
    sessionId: session.id,
    workingDir: remote.remotePath,
    codexHome: '/worker/private-home',
    remote,
    owner: session.owner,
  };
  const material = CodexInputBroker.provisioningMaterial(session.id, 'exec fake-child', scope.codexHome);
  const directory = '/worker/private-brokers/' + session.id + '/' + material.config.incarnation;
  const descriptor = await cache.prepare(scope, material, directory);
  expect(descriptor).toBeDefined();
  vi.spyOn(subagentWatcher, 'killSubagentsForSession').mockResolvedValue(undefined);
  // Cleanup itself is real; this fixture has no running task/recovery controller to drain.
  vi.spyOn(internal, 'stopRecoveryController').mockResolvedValue(undefined);
  try {
    await check({ server, internal, session, kill, scope, material, directory });
  } finally {
    vi.restoreAllMocks();
    internal.sessions.clear();
    await session.stop(false);
    cache.retire(session.id);
    await server.stop();
    internal.store.flushAll();
    await fs.rm(root, { recursive: true, force: true });
  }
}

it.each([false, true])(
  'retires final deleted/demoted Session cache (pinned=%s) without deleting private provenance',
  async (pinned) =>
    fixture(async ({ internal, session, kill, scope, material }) => {
      session.setPinned(pinned);
      internal.store.setSession(session.id, session.toState());
      await internal.cleanupSession(session.id, true);
      expect(kill).toHaveBeenCalledExactlyOnceWith(session.id);
      expect(internal.sessions.has(session.id)).toBe(false);
      expect(internal.store.getSession(session.id)?.status).toBe(pinned ? 'stopped' : undefined);
      expect(cache.get(scope, material.config.incarnation)).toBeUndefined();
      // Verified same-scope rehydration remains possible after a later owner operation.
      expect(await cache.load(scope, material.config.incarnation)).toBeDefined();
    })
);

it('preserves cache on detach and a restorable tentative discard', async () =>
  fixture(async ({ internal, server, session, scope, material }) => {
    await internal.cleanupSession(session.id, false);
    expect(cache.get(scope, material.config.incarnation)).toBeDefined();
    expect(internal.store.getSession(session.id)).toBeDefined();
    internal.sessions.set(session.id, session);
    await server.discardPartiallyBuiltSession(session.id, session, { preserveMuxPane: true });
    expect(internal.sessions.has(session.id)).toBe(false);
    expect(cache.get(scope, material.config.incarnation)).toBeDefined();
    expect(internal.store.getSession(session.id)).toBeDefined();
  }));

it.each(['layout', 'drain', 'stop', 'state'] as const)('retains cache when final %s cleanup fails', async (stage) =>
  fixture(async ({ internal, session, scope, material }) => {
    if (stage === 'layout') vi.spyOn(internal.tabLayouts, 'runSessionDeletion').mockRejectedValue(Error('held layout'));
    if (stage === 'drain') vi.mocked(internal.stopRecoveryController).mockRejectedValue(Error('held drain'));
    if (stage === 'stop') vi.spyOn(session, 'stop').mockRejectedValue(Error('held stop'));
    if (stage === 'state')
      vi.spyOn(internal.store, 'demoteOrRemoveSession').mockImplementation(() => {
        throw Error('held state');
      });
    await expect(internal.cleanupSession(session.id, true)).rejects.toThrow('held');
    expect(cache.get(scope, material.config.incarnation)).toBeDefined();
  })
);

it('retains an uncertain restore Session and its cached authority during tentative discard', async () =>
  fixture(async ({ internal, server, session, scope, material, kill }) => {
    Reflect.set(session, '_codexRestoreWorkerMayExist', true);
    await server.discardPartiallyBuiltSession(session.id, session);
    expect(internal.sessions.get(session.id)).toBe(session);
    expect(session.codexRestoreWorkerMayExist).toBe(true);
    expect(cache.get(scope, material.config.incarnation)).toBeDefined();
    expect(kill).not.toHaveBeenCalled();
  }));

it('does not retire a replacement Session when the old cleanup completes late', async () =>
  fixture(async ({ internal, session, scope, material }) => {
    const replacement = new Session({ id: session.id, mode: 'codex', workingDir: session.workingDir });
    vi.spyOn(session, 'stop').mockImplementation(async () => {
      internal.sessions.set(session.id, replacement);
    });
    await internal.cleanupSession(session.id, true);
    expect(internal.sessions.get(session.id)).toBe(replacement);
    expect(cache.get(scope, material.config.incarnation)).toBeDefined();
    await replacement.stop(false);
  }));

it.each(['delete', 'detach', 'foreign', 'missing', 'state-error'] as const)(
  'persisted-only owner route %s retires only certified final cleanup',
  async (kind) =>
    fixture(async ({ internal, server, session, scope, material }) => {
      // A failed/tentative build is restorable; it must retain material until the later final delete.
      await server.discardPartiallyBuiltSession(session.id, session, { preserveMuxPane: true });
      expect(internal.sessions.has(session.id)).toBe(false);
      expect(internal.store.getSession(session.id)).toBeDefined();
      expect(cache.get(scope, material.config.incarnation)).toBeDefined();
      const context = createMockRouteContext();
      Object.assign(context, { sessions: internal.sessions, store: internal.store });
      const app = Fastify();
      installRouteErrorHandler(app);
      vi.stubEnv('CODEMAN_MULTIUSER', '1');
      app.addHook('preHandler', async (req) => {
        req.authUser = { username: kind === 'foreign' ? 'other-owner' : session.owner!, role: 'user' } as NonNullable<
          typeof req.authUser
        >;
      });
      const wake = registerSessionRoutes(app, context);
      if (kind === 'missing') internal.store.removeSession(session.id);
      if (kind === 'state-error')
        vi.spyOn(internal.store, 'demoteOrRemoveSession').mockImplementation(() => {
          throw Error('state cleanup unacknowledged');
        });
      try {
        const result = await app.inject({
          method: 'DELETE',
          url: '/api/sessions/' + session.id + (kind === 'detach' ? '?killMux=false' : ''),
        });
        expect(result.statusCode).toBe(
          kind === 'foreign' || kind === 'missing' ? 404 : kind === 'state-error' ? 500 : 200
        );
        expect(context.cleanupSession).not.toHaveBeenCalled();
        if (kind === 'delete') expect(cache.get(scope, material.config.incarnation)).toBeUndefined();
        else expect(cache.get(scope, material.config.incarnation)).toBeDefined();
        if (kind === 'foreign' || kind === 'state-error') expect(internal.store.getSession(session.id)).toBeDefined();
        if (kind === 'delete') expect(await cache.load(scope, material.config.incarnation)).toBeDefined();
      } finally {
        wake.stop();
        await app.close();
        vi.unstubAllEnvs();
      }
    })
);
