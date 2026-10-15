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
import { OwnedRemoteBrokerCache, ownedRemoteBrokerCache as cache } from '../src/recovery/remote-input-broker-cache.js';
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
  const previousCacheRoot = Reflect.get(cache, 'root');
  Reflect.set(cache, 'root', join(root, 'private-brokers'));
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
    Reflect.set(cache, 'root', previousCacheRoot);
    await server.stop();
    internal.store.flushAll();
    await fs.rm(root, { recursive: true, force: true });
  }
}

it.each([false, true])(
  'retires final deleted/demoted Session cache and private provenance (pinned=%s)',
  async (pinned) =>
    fixture(async ({ internal, session, kill, scope, material }) => {
      session.setPinned(pinned);
      internal.store.setSession(session.id, session.toState());
      await internal.cleanupSession(session.id, true);
      expect(kill).toHaveBeenCalledExactlyOnceWith(session.id);
      expect(internal.sessions.has(session.id)).toBe(false);
      expect(internal.store.getSession(session.id)?.status).toBe(pinned ? 'stopped' : undefined);
      expect(cache.get(scope, material.config.incarnation)).toBeUndefined();
      expect(await cache.load(scope, material.config.incarnation)).toBeUndefined();
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
        if (kind === 'delete') expect(await cache.load(scope, material.config.incarnation)).toBeUndefined();
      } finally {
        wake.stop();
        await app.close();
        vi.unstubAllEnvs();
      }
    })
);

async function ownerDeleteApp(internal: Internal, session: Session) {
  const context = createMockRouteContext();
  Object.assign(context, {
    sessions: internal.sessions,
    store: internal.store,
    cleanupSession: internal.cleanupSession.bind(internal),
  });
  const app = Fastify();
  installRouteErrorHandler(app);
  app.addHook('preHandler', async (req) => {
    req.authUser = { username: session.owner!, role: 'user' } as NonNullable<typeof req.authUser>;
  });
  const wake = registerSessionRoutes(app, context);
  return {
    app,
    stop: async () => {
      wake.stop();
      await app.close();
    },
  };
}

it.each(['live', 'persisted'] as const)(
  'retries the actual %s delete after 130 rotations instead of losing its final bounded verdict',
  async (kind) =>
    fixture(async ({ internal, server, session, scope, material }) => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const cacheRoot = Reflect.get(cache, 'root') as string,
        sessionRoot = join(cacheRoot, session.id),
        marker = join(cacheRoot, session.id + '.cleanup.json');
      for (let index = 1; index < 130; index++) {
        const next = CodexInputBroker.provisioningMaterial(session.id, 'exec rotation-' + index, scope.codexHome);
        expect(
          await cache.prepare(scope, next, '/worker/private-brokers/' + session.id + '/' + next.config.incarnation)
        ).toBeDefined();
        expect(cache.activate(scope, next.config.incarnation)).toBe(true);
      }
      if (kind === 'persisted')
        await server.discardPartiallyBuiltSession(session.id, session, { preserveMuxPane: true });
      const route = await ownerDeleteApp(internal, session);
      // The live route delegates into the actual server cleanup; persisted-only
      // deletion uses its own production cleanup path in the same handler.
      try {
        expect((await route.app.inject({ method: 'DELETE', url: '/api/sessions/' + session.id })).statusCode).toBe(200);
      } finally {
        await route.stop();
      }
      expect(internal.store.getSession(session.id)).toBeNull();
      expect((await fs.readdir(sessionRoot)).length).toBeGreaterThan(0);
      expect(await fs.readFile(marker, 'utf8')).toContain('retiredHash');
      internal.store.flushAll();
      // Recreate both cache and persisted-state readers, with no live closure
      // retained from the HTTP request or the original cache incarnation.
      const restartedStore = new StateStore(join(session.workingDir, 'state.json')),
        restarted = new OwnedRemoteBrokerCache(cacheRoot),
        stop = restarted.startFinalCleanupRetries((id) => ({ live: false, state: restartedStore.getSession(id) }));
      try {
        await vi.waitFor(async () => expect(await fs.readdir(sessionRoot)).toEqual([]));
        await expect(fs.lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await restarted.load(scope, material.config.incarnation)).toBeUndefined();
      } finally {
        await stop();
        restartedStore.flushAll();
      }
    })
);

it('keeps unsafe material and its durable cleanup request until a later certified retry', async () =>
  fixture(async ({ internal, server, session, material }) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const cacheRoot = Reflect.get(cache, 'root') as string,
      file = join(cacheRoot, session.id, material.config.incarnation, 'private.json'),
      marker = join(cacheRoot, session.id + '.cleanup.json'),
      bytes = await fs.readFile(file);
    await fs.chmod(file, 0o644);
    await server.discardPartiallyBuiltSession(session.id, session, { preserveMuxPane: true });
    const route = await ownerDeleteApp(internal, session);
    try {
      expect((await route.app.inject({ method: 'DELETE', url: '/api/sessions/' + session.id })).statusCode).toBe(200);
      expect(await fs.readFile(file)).toEqual(bytes);
      expect((await fs.lstat(marker)).isFile()).toBe(true);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await fs.readFile(file)).toEqual(bytes);
      expect((await fs.lstat(marker)).isFile()).toBe(true);
      await fs.chmod(file, 0o600);
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(async () => expect(await fs.readdir(join(cacheRoot, session.id))).toEqual([]));
      await expect(fs.lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await route.stop();
    }
  }));

it.each(['live', 'owner', 'record', 'cache-parent'] as const)(
  'retains pending cleanup after a %s replacement veto, including after restart',
  async (change) =>
    fixture(async ({ internal, server, session, material }) => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const cacheRoot = Reflect.get(cache, 'root') as string,
        sessionRoot = join(cacheRoot, session.id),
        file = join(sessionRoot, material.config.incarnation, 'private.json'),
        bytes = await fs.readFile(file);
      await server.discardPartiallyBuiltSession(session.id, session, { preserveMuxPane: true });
      const before = internal.store.getSession(session.id)!;
      await cache.stageFinalCleanup(session.id, undefined, () => internal.store.getSession(session.id) === before);
      internal.store.demoteOrRemoveSession(session.id);
      if (change === 'live') internal.sessions.set(session.id, session);
      if (change === 'owner') internal.store.setSession(session.id, { ...before, owner: 'replacement-owner' });
      if (change === 'record') internal.store.setSession(session.id, { ...before, name: 'replacement record' });
      if (change === 'cache-parent') {
        await fs.rename(sessionRoot, sessionRoot + '.old');
        await fs.mkdir(sessionRoot, { mode: 0o700 });
        await fs.cp(sessionRoot + '.old', sessionRoot, { recursive: true, preserveTimestamps: true });
      }
      const restarted = new OwnedRemoteBrokerCache(cacheRoot),
        stop = restarted.startFinalCleanupRetries((id) => ({
          live: internal.sessions.has(id),
          state: internal.store.getSession(id),
        }));
      try {
        await vi.advanceTimersByTimeAsync(30_000);
        await stop();
        expect(await fs.readFile(file)).toEqual(bytes);
        expect((await fs.lstat(join(cacheRoot, session.id + '.cleanup.json'))).isFile()).toBe(true);
        if (change === 'cache-parent')
          expect(await fs.readFile(join(sessionRoot + '.old', material.config.incarnation, 'private.json'))).toEqual(
            bytes
          );
      } finally {
        await stop();
      }
    })
);

it('does not remove the owner record when ownership changes during intent acknowledgement', async () =>
  fixture(async ({ internal, server, session, material }) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const cacheRoot = Reflect.get(cache, 'root') as string,
      marker = join(cacheRoot, session.id + '.cleanup.json'),
      file = join(cacheRoot, session.id, material.config.incarnation, 'private.json'),
      bytes = await fs.readFile(file);
    await server.discardPartiallyBuiltSession(session.id, session, { preserveMuxPane: true });
    const route = await ownerDeleteApp(internal, session),
      open = fs.open.bind(fs);
    let changed = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === marker) {
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          if (!changed) {
            changed = true;
            internal.store.getSession(session.id)!.owner = 'new-owner';
          }
        };
      }
      return handle;
    });
    try {
      expect((await route.app.inject({ method: 'DELETE', url: '/api/sessions/' + session.id })).statusCode).toBe(500);
      expect(changed).toBe(true);
      expect(internal.store.getSession(session.id)?.owner).toBe('new-owner');
      await vi.advanceTimersByTimeAsync(30_000);
      await route.stop();
      expect(await fs.readFile(file)).toEqual(bytes);
    } finally {
      await route.stop();
    }
  }));

it('retains the actual route cleanup intent when both shared cache slots are held, then retries after drain', async () =>
  fixture(async ({ internal, server, session, scope, material }) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const cacheRoot = Reflect.get(cache, 'root') as string,
      file = join(cacheRoot, session.id, material.config.incarnation, 'private.json'),
      marker = join(cacheRoot, session.id + '.cleanup.json'),
      held: Array<{ scope: typeof scope; incarnation: string; file: string }> = [];
    for (let index = 0; index < 2; index++) {
      const other = { ...scope, sessionId: randomUUID() },
        next = CodexInputBroker.provisioningMaterial(other.sessionId, 'exec held-reader', scope.codexHome);
      expect(
        await cache.prepare(other, next, '/worker/private-brokers/' + other.sessionId + '/' + next.config.incarnation)
      ).toBeDefined();
      held.push({
        scope: other,
        incarnation: next.config.incarnation,
        file: join(cacheRoot, other.sessionId, next.config.incarnation, 'private.json'),
      });
    }
    await server.discardPartiallyBuiltSession(session.id, session, { preserveMuxPane: true });
    const route = await ownerDeleteApp(internal, session),
      release = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>(),
      open = fs.open.bind(fs),
      finish = cache.finishFinalCleanup.bind(cache);
    let enteredCount = 0,
      first = true,
      loads: Array<Promise<unknown>> = [];
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (held.some((item) => item.file === args[0])) {
        const read = handle.read.bind(handle);
        handle.read = (async (...readArgs: Parameters<typeof read>) => {
          if (++enteredCount === 2) entered.resolve();
          await release.promise;
          return read(...readArgs);
        }) as typeof handle.read;
      }
      return handle;
    });
    vi.spyOn(cache, 'finishFinalCleanup').mockImplementation(async (...args) => {
      if (args[0] === session.id && first && internal.store.getSessions()[session.id] === undefined) {
        first = false;
        loads = held.map((item) => new OwnedRemoteBrokerCache(cacheRoot).load(item.scope, item.incarnation));
        await entered.promise;
      }
      return finish(...args);
    });
    try {
      expect((await route.app.inject({ method: 'DELETE', url: '/api/sessions/' + session.id })).statusCode).toBe(200);
      expect(first).toBe(false);
      expect((await fs.lstat(file)).isFile()).toBe(true);
      expect((await fs.lstat(marker)).isFile()).toBe(true);
      release.resolve();
      await Promise.all(loads);
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(async () => expect(await fs.readdir(join(cacheRoot, session.id))).toEqual([]));
      await expect(fs.lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      release.resolve();
      await Promise.all(loads);
      await route.stop();
      for (const item of held) cache.retire(item.scope.sessionId);
    }
  }));

it('retains a timed-out cleanup until its actual proof closes, then retries without a late unlink', async () =>
  fixture(async ({ internal, server, session, material }) => {
    const cacheRoot = Reflect.get(cache, 'root') as string,
      file = join(cacheRoot, session.id, material.config.incarnation, 'private.json'),
      marker = join(cacheRoot, session.id + '.cleanup.json'),
      bytes = await fs.readFile(file);
    await server.discardPartiallyBuiltSession(session.id, session, { preserveMuxPane: true });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    const route = await ownerDeleteApp(internal, session),
      entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>(),
      open = fs.open.bind(fs);
    let first = true;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === file && first) {
        first = false;
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          entered.resolve();
          await release.promise;
        };
      }
      return handle;
    });
    try {
      const response = route.app.inject({ method: 'DELETE', url: '/api/sessions/' + session.id });
      await entered.promise;
      await vi.advanceTimersByTimeAsync(2001);
      expect((await response).statusCode).toBe(200);
      expect(await fs.readFile(file)).toEqual(bytes);
      expect((await fs.lstat(marker)).isFile()).toBe(true);
      release.resolve();
      await vi.waitFor(() => expect((Reflect.get(cache, 'deletions') as Map<string, object>).size).toBe(0));
      expect(await fs.readFile(file)).toEqual(bytes);
      // Stop at the next retry tick: advancing a whole 15s from the expired
      // attempt could also expire the fresh pass while its disk reads await I/O.
      await vi.advanceTimersToNextTimerAsync();
      await vi.waitFor(async () => {
        await expect(fs.lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await fs.readdir(join(cacheRoot, session.id))).toEqual([]);
      });
    } finally {
      release.resolve();
      await route.stop();
    }
  }));

it.each(['same-bytes-replacement', 'symlink', 'public'] as const)(
  'retains owner state and material when the staged intent becomes %s before ACK',
  async (change) =>
    fixture(async ({ internal, server, session, material }) => {
      const cacheRoot = Reflect.get(cache, 'root') as string,
        marker = join(cacheRoot, session.id + '.cleanup.json'),
        file = join(cacheRoot, session.id, material.config.incarnation, 'private.json'),
        bytes = await fs.readFile(file);
      await server.discardPartiallyBuiltSession(session.id, session, { preserveMuxPane: true });
      const route = await ownerDeleteApp(internal, session),
        open = fs.open.bind(fs);
      let changed = false;
      vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (args[0] === marker) {
          const close = handle.close.bind(handle);
          handle.close = async () => {
            await close();
            if (changed) return;
            changed = true;
            if (change === 'public') await fs.chmod(marker, 0o644);
            else {
              await fs.rename(marker, marker + '.old');
              if (change === 'symlink') await fs.symlink(marker + '.old', marker);
              else await fs.writeFile(marker, await fs.readFile(marker + '.old'), { mode: 0o600 });
            }
          };
        }
        return handle;
      });
      try {
        expect((await route.app.inject({ method: 'DELETE', url: '/api/sessions/' + session.id })).statusCode).toBe(500);
        expect(changed).toBe(true);
        expect(internal.store.getSession(session.id)).not.toBeNull();
        expect(await fs.readFile(file)).toEqual(bytes);
        if (change === 'symlink') expect((await fs.lstat(marker)).isSymbolicLink()).toBe(true);
      } finally {
        await route.stop();
      }
    })
);

it('does not use a different retired-state intent between ACK and the final route cleanup', async () =>
  fixture(async ({ internal, server, session, material }) => {
    const cacheRoot = Reflect.get(cache, 'root') as string,
      marker = join(cacheRoot, session.id + '.cleanup.json'),
      file = join(cacheRoot, session.id, material.config.incarnation, 'private.json'),
      bytes = await fs.readFile(file);
    await server.discardPartiallyBuiltSession(session.id, session, { preserveMuxPane: true });
    const route = await ownerDeleteApp(internal, session),
      finish = cache.finishFinalCleanup.bind(cache);
    let changed = false;
    vi.spyOn(cache, 'finishFinalCleanup').mockImplementation(async (...args) => {
      if (!changed && args[0] === session.id && internal.store.getSessions()[session.id] === undefined) {
        changed = true;
        const intent = JSON.parse(await fs.readFile(marker, 'utf8'));
        intent.retiredHash = 'a'.repeat(64);
        await fs.writeFile(marker, JSON.stringify(intent));
      }
      return finish(...args);
    });
    try {
      expect((await route.app.inject({ method: 'DELETE', url: '/api/sessions/' + session.id })).statusCode).toBe(200);
      expect(changed).toBe(true);
      await route.stop();
      expect(await fs.readFile(file)).toEqual(bytes);
      expect((await fs.lstat(marker)).isFile()).toBe(true);
    } finally {
      await route.stop();
    }
  }));
