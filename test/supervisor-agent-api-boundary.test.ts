/** Real HTTP hooks: denied manager requests cannot reach generic mutation handlers. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerSupervisorAgentBoundary } from '../src/web/middleware/supervisor-agent-boundary.js';
import { initialSupervisorState } from '../src/supervisor/schema.js';
import { WebServer } from '../src/web/server.js';
import { TmuxManager } from '../src/tmux-manager.js';
import { Session } from '../src/session.js';

const MANAGER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const WORKER = '33333333-3333-4333-8333-333333333333';
const apps: FastifyInstance[] = [];
const servers: WebServer[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const server of servers.splice(0)) await server.stop().catch(() => {});
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const app = Fastify({ rewriteUrl: (req) => (req.url ?? '/').replace(/^\/api\/v1\//, '/api/') });
  apps.push(app);
  const effects = vi.fn();
  const role = new Set([MANAGER, OTHER]);
  registerSupervisorAgentBoundary(app, (candidate) =>
    [...role].find((id) => candidate.length >= 8 && id.startsWith(candidate))
  );
  const methods = ['GET', 'POST', 'PUT', 'DELETE'] as const;
  for (const method of methods) {
    for (const url of [
      '/api/sessions',
      '/api/sessions/:id/input',
      '/api/sessions/:id/send-key',
      '/api/sessions/:id',
      '/api/sessions/:id/task/progress',
      '/api/sessions/:id/supervisor/start',
      '/api/sessions/:id/supervisor/reset',
    ]) {
      app.route({
        method,
        url,
        handler: async () => {
          effects();
          return { success: true };
        },
      });
    }
  }
  app.get('/api/sessions/:id/supervisor', async () => ({ success: true }));
  app.get('/api/sessions/:id/supervisor/workers', async () => ({ success: true }));
  for (const action of ['assign', 'retry']) {
    app.post(`/api/sessions/:id/supervisor/workers/:workerId/${action}`, async () => {
      effects();
      return { success: true };
    });
  }
  await app.ready();
  return { app, effects, role };
}

describe('supervisor manager API restrictions', () => {
  it.each([
    { method: 'POST' as const, suffix: '/input', payload: { input: 'untrusted raw input' } },
    { method: 'POST' as const, suffix: '/send-key', payload: { key: 'Escape' } },
    { method: 'DELETE' as const, suffix: '' },
    {
      method: 'POST' as const,
      suffix: '/task/progress',
      payload: { outcome: 'complete', verifiedCriteria: ['manual'] },
    },
    { method: 'POST' as const, suffix: '/supervisor/start' },
    { method: 'POST' as const, suffix: '/supervisor/reset' },
  ])(
    'rejects attributed $method $suffix before effects, including the versioned API',
    async ({ method, suffix, ...options }) => {
      const h = await fixture();
      for (const prefix of ['/api', '/api/v1']) {
        const result = await h.app.inject({
          method,
          url: `${prefix}/sessions/${WORKER}${suffix}`,
          headers: { 'x-codeman-parent-session': MANAGER },
          ...options,
        });
        expect(result.statusCode).toBe(403);
        expect(result.json()).toMatchObject({ success: false, errorCode: 'FORBIDDEN' });
      }
      expect(h.effects).not.toHaveBeenCalled();
    }
  );

  it('rejects spawn attribution from either channel and cannot replace a manager header with another body parent', async () => {
    const h = await fixture();
    expect((await h.app.inject({ url: `/api/sessions?parentSessionId=${MANAGER}` })).statusCode).toBe(403);
    for (const options of [
      { headers: { 'x-codeman-parent-session': MANAGER }, payload: { parentSessionId: WORKER } },
      { payload: { parentSessionId: MANAGER } },
      { headers: { 'x-codeman-parent-session': MANAGER.slice(0, 8) } },
      { headers: { 'x-codeman-supervisor-session': MANAGER } },
      { headers: { 'x-codeman-parent-session': `${WORKER}, ${MANAGER}` } },
    ])
      expect((await h.app.inject({ method: 'POST', url: '/api/sessions', ...options })).statusCode).toBe(403);
    expect(h.effects).not.toHaveBeenCalled();
  });

  it('allows only the attributed manager scope and rejects generic reads, other manager IDs and conflicting roles', async () => {
    const h = await fixture();
    const headers = { 'x-codeman-parent-session': MANAGER, 'x-codeman-supervisor-session': MANAGER };
    for (const suffix of ['', '/workers'])
      expect((await h.app.inject({ url: `/api/sessions/${MANAGER}/supervisor${suffix}`, headers })).statusCode).toBe(
        200
      );
    for (const action of ['assign', 'retry'])
      expect(
        (
          await h.app.inject({
            method: 'POST',
            url: `/api/sessions/${MANAGER}/supervisor/workers/${WORKER}/${action}`,
            headers,
            payload: { requestId: 'durable-request' },
          })
        ).statusCode
      ).toBe(200);
    expect(h.effects).toHaveBeenCalledTimes(2);
    expect((await h.app.inject({ url: '/api/sessions', headers })).statusCode).toBe(403);
    expect((await h.app.inject({ url: `/api/sessions/${OTHER}/supervisor`, headers })).statusCode).toBe(403);
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: `/api/sessions/${MANAGER}/supervisor/workers/${WORKER}/assign`,
          headers: { ...headers, 'x-codeman-supervisor-session': OTHER },
        })
      ).statusCode
    ).toBe(403);
    expect(h.effects).toHaveBeenCalledTimes(2);
  });

  it('keeps owner controls and ordinary worker-attributed calls available', async () => {
    const h = await fixture();
    expect((await h.app.inject({ method: 'POST', url: `/api/sessions/${MANAGER}/supervisor/reset` })).statusCode).toBe(
      200
    );
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: `/api/sessions/${OTHER}/input`,
          headers: { 'x-codeman-parent-session': WORKER },
          payload: { input: 'owner-authorized worker input' },
        })
      ).statusCode
    ).toBe(200);
    expect(h.effects).toHaveBeenCalledTimes(2);
  });
});

describe('actual server manager-role lookup', () => {
  it('installs the restriction on the real server before generic route effects', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codeman-supervisor-http-'));
    directories.push(directory);
    vi.stubEnv('CODEMAN_DATA_DIR', directory);
    vi.stubEnv('CODEMAN_MULTIUSER', '0');
    vi.stubEnv('CODEMAN_USERNAME', 'fixture-owner');
    vi.stubEnv('CODEMAN_PASSWORD', 'fixture-password');
    vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);
    const server = new WebServer(0, false, true);
    servers.push(server);
    const state = {
      ...initialSupervisorState(MANAGER),
      objective: 'Owner-selected manager',
      enabled: true,
      phase: 'active',
    };
    Reflect.get(server, 'supervisorControllers').set(MANAGER, {
      getStatus: () => state,
      stop: () => {},
      drain: async () => {},
    });
    await Reflect.get(server, 'setupRoutes').call(server);
    const app = Reflect.get(server, 'app') as FastifyInstance;
    const effect = vi.fn();
    app.post('/api/boundary-probe', async () => {
      effect();
      return { success: true };
    });
    const authorization = 'Basic ' + Buffer.from('fixture-owner:fixture-password').toString('base64');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/boundary-probe',
          headers: { host: '127.0.0.1', 'x-codeman-parent-session': MANAGER },
        })
      ).statusCode
    ).toBe(401);
    expect(effect).not.toHaveBeenCalled();
    const restricted = await app.inject({
      method: 'POST',
      url: '/api/v1/boundary-probe',
      headers: { host: '127.0.0.1', authorization, 'x-codeman-parent-session': MANAGER },
    });
    expect(restricted.statusCode).toBe(403);
    expect(effect).not.toHaveBeenCalled();
    expect(
      (await app.inject({ method: 'POST', url: '/api/boundary-probe', headers: { host: '127.0.0.1', authorization } }))
        .statusCode
    ).toBe(200);
    expect(effect).toHaveBeenCalledOnce();
  });

  it('retains durable roles after reconstruction and limits an unreadable optional journal to known Codex callers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codeman-supervisor-roles-'));
    directories.push(directory);
    vi.stubEnv('CODEMAN_DATA_DIR', directory);
    vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);
    const server = new WebServer(0, false, true);
    servers.push(server);
    const store = Reflect.get(server, 'supervisorStore');
    await store.save(MANAGER, { ...initialSupervisorState(MANAGER), objective: 'Retained owner role' });
    const resolve = Reflect.get(server, 'resolveSupervisorManagerAttribution').bind(server) as (
      id: string
    ) => string | undefined;
    expect(resolve(MANAGER)).toBe(MANAGER);
    const sessions = Reflect.get(server, 'sessions') as Map<string, Session>;
    sessions.set(OTHER, new Session({ id: OTHER, mode: 'codex', workingDir: directory, useMux: false }));
    sessions.set(WORKER, new Session({ id: WORKER, mode: 'claude', workingDir: directory, useMux: false }));
    Object.defineProperty(store, 'loadFailed', { value: true, configurable: true });
    expect(resolve(OTHER)).toBe(OTHER);
    expect(resolve(WORKER)).toBeUndefined();
  });

  it.each(['active', 'paused', 'blocked', 'disabled'] as const)(
    'retains the configured %s manager restriction without blocking unconfigured or unrelated sessions',
    async (phase) => {
      const directory = await mkdtemp(join(tmpdir(), 'codeman-supervisor-boundary-'));
      directories.push(directory);
      vi.stubEnv('CODEMAN_DATA_DIR', directory);
      vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);
      const server = new WebServer(0, false, true);
      servers.push(server);
      const state = {
        ...initialSupervisorState(MANAGER),
        objective: 'Owner-selected manager',
        enabled: phase !== 'disabled',
        phase,
      };
      Reflect.get(server, 'supervisorControllers').set(MANAGER, {
        getStatus: () => state,
        stop: () => {},
        drain: async () => {},
      });
      const resolve = Reflect.get(server, 'resolveSupervisorManagerAttribution').bind(server) as (
        id: string
      ) => string | undefined;
      expect(resolve(MANAGER)).toBe(MANAGER);
      expect(resolve(MANAGER.slice(0, 8))).toBe(MANAGER);
      expect(resolve(WORKER)).toBeUndefined();
      state.objective = '';
      state.enabled = false;
      expect(resolve(MANAGER)).toBeUndefined();
    }
  );
});
