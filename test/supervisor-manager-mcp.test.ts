/** Real authentication hooks and MCP routes via inject; no socket or native/worker effects. */
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, expect, it, vi } from 'vitest';
import { ManagerCredentialRegistry } from '../src/supervisor/manager-credentials.js';
import { registerAuthMiddleware, registerHostGuard } from '../src/web/middleware/auth.js';
import { registerSupervisorMcpRoutes } from '../src/web/routes/supervisor-mcp-routes.js';
import { createDeferred } from './mocks/index.js';
import { findUser } from '../src/user-store.js';

vi.mock('../src/user-store.js', async (original) => ({
  ...(await original<typeof import('../src/user-store.js')>()),
  findUser: vi.fn(),
}));
const SID = '11111111-2222-4333-8444-555555555555';
const WORKER = '22222222-3333-4444-8555-666666666666';
const REQUEST = '33333333-4444-4555-8666-777777777777';
const apps: FastifyInstance[] = [];
async function fixture(password = 'owner-password', multiuser = false, initiallyAborted = false) {
  vi.stubEnv('CODEMAN_MULTIUSER', multiuser ? '1' : '0');
  vi.stubEnv('CODEMAN_PASSWORD', password);
  vi.stubEnv('CODEMAN_USERNAME', 'admin');
  const app = Fastify({ logger: false });
  apps.push(app);
  await app.register(cookie);
  registerHostGuard(app, () => ({ bindHost: '127.0.0.1', allowedHosts: [] }));
  // A real peer can abort while an earlier async authentication hook is held.
  // Publish that already-observed transport state before this route binds its
  // listeners; emitting only here must not be mistaken for a future event.
  app.addHook('preHandler', async (req) => {
    if (initiallyAborted) {
      Object.defineProperty(req.raw, 'aborted', { value: true, configurable: true });
      req.raw.emit('aborted');
    }
  });
  const registry = new ManagerCredentialRegistry();
  let current = true;
  const issued = registry.issue({ sessionId: SID, owner: multiuser ? 'alice' : undefined, isCurrent: () => current });
  const auth = registerAuthMiddleware(app, false, '', registry);
  app.addHook('onClose', async () => {
    for (const map of Object.values(auth)) map?.dispose();
  });
  const state = { supervisorSessionId: SID, phase: 'active', workers: [{ sessionId: WORKER }] };
  const controller = {
    getStatus: vi.fn(() => state),
    inspectWorkers: vi.fn(async () => [{ sessionId: WORKER }]),
    assign: vi.fn(async (_worker: string, _request: string, isCurrent?: () => boolean) => {
      if (!isCurrent?.()) throw Error('cancelled');
      return state;
    }),
    retry: vi.fn(async (_worker: string, _request: string, isCurrent?: () => boolean) => {
      if (!isCurrent?.()) throw Error('cancelled');
      return state;
    }),
  };
  const resolve = vi.fn((scope) =>
    scope.sessionId === SID && scope.owner === (multiuser ? 'alice' : undefined) ? controller : undefined
  );
  registerSupervisorMcpRoutes(app, { credentials: registry, resolveController: resolve } as never);
  const generic = vi.fn(async () => ({ success: true }));
  for (const path of [
    '/api/sessions',
    '/api/settings',
    `/api/sessions/${WORKER}/input`,
    `/api/sessions/${SID}/supervisor/reset`,
    '/ws/fixture',
    '/api/admin/users',
  ])
    app.route({ url: path, method: ['GET', 'POST', 'PUT', 'DELETE'], handler: generic });
  await app.ready();
  const headers = { authorization: 'Bearer ' + issued.token };
  const rpc = (method: string, params?: unknown, extra: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/supervisor-mcp',
      headers: { ...headers, ...extra },
      payload: { jsonrpc: '2.0', id: 1, method, ...(params !== undefined ? { params } : {}) },
    });
  return {
    app,
    registry,
    issued,
    controller,
    resolve,
    generic,
    rpc,
    headers,
    revoke: () => {
      current = false;
    },
  };
}
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

it('initializes and lists only four tools, then invokes exact owner-selected operations', async () => {
  const f = await fixture();
  expect(
    (
      await f.rpc('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'fixture', version: '1' },
      })
    ).json()
  ).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26' } });
  const listed = (await f.rpc('tools/list')).json();
  expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
    'supervisor_status',
    'supervisor_workers',
    'supervisor_assign',
    'supervisor_retry',
  ]);
  for (const name of ['supervisor_status', 'supervisor_workers', 'supervisor_assign', 'supervisor_retry']) {
    const result = await f.rpc('tools/call', {
      name,
      arguments: name.endsWith('assign') || name.endsWith('retry') ? { workerId: WORKER, requestId: REQUEST } : {},
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().error).toBeUndefined();
    expect(result.json().result.content[0].type).toBe('text');
  }
  expect(f.controller.assign).toHaveBeenCalledWith(WORKER, REQUEST, expect.any(Function));
  expect(f.controller.retry).toHaveBeenCalledWith(WORKER, REQUEST, expect.any(Function));
  expect(f.generic).not.toHaveBeenCalled();
});

it('keeps implicit resource discovery empty and never dispatches a resource URI', async () => {
  const f = await fixture();
  for (const method of ['resources/list', 'resources/templates/list']) {
    const response = await f.rpc(method);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: method === 'resources/list' ? { resources: [] } : { resourceTemplates: [] },
    });
    expect((await f.rpc(method, { cursor: 'foreign' })).json().error.code).toBe(-32602);
  }
  for (const uri of ['file:///private/credential.json', 'http://127.0.0.1/api/sessions', WORKER, '../state.json']) {
    const response = await f.rpc('resources/read', { uri });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32002, message: 'The supervisor bridge exposes no resources; use the supervisor tools' },
    });
  }
  expect(f.resolve).not.toHaveBeenCalled();
  expect(f.generic).not.toHaveBeenCalled();
  expect(f.controller.assign).not.toHaveBeenCalled();
  expect(f.controller.retry).not.toHaveBeenCalled();
  expect((await f.rpc('tools/list')).json().result.tools).toHaveLength(4);
  f.revoke();
  for (const method of ['resources/list', 'resources/templates/list', 'resources/read'])
    expect((await f.rpc(method, method === 'resources/read' ? { uri: 'file:///private' } : undefined)).statusCode).toBe(
      401
    );
});

it.each([undefined, {}, { uri: '' }, { uri: 1 }, { uri: 'x', path: '/private' }, { uri: 'x'.repeat(2049) }])(
  'refuses malformed resource reads without effects: %j',
  async (params) => {
    const f = await fixture();
    expect((await f.rpc('resources/read', params)).json().error.code).toBe(-32602);
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.generic).not.toHaveBeenCalled();
  }
);

it.each([false, true])('denies every generic endpoint with valid manager token, attribution=%s', async (attributed) => {
  const f = await fixture();
  for (const url of [
    '/api/sessions',
    '/api/settings',
    `/api/sessions/${WORKER}/input`,
    `/api/sessions/${SID}/supervisor/reset`,
    '/ws/fixture',
    '/api/admin/users',
  ]) {
    const response = await f.app.inject({
      method: 'POST',
      url,
      headers: { ...f.headers, ...(attributed ? { 'x-codeman-supervisor-session': SID } : {}) },
    });
    expect(response.statusCode).toBe(403);
  }
  expect(f.generic).not.toHaveBeenCalled();
});

it.each(['', 'owner-password'])(
  'unknown/revoked bearer never falls back to anonymous or owner cookie (password=%s)',
  async (password) => {
    const f = await fixture(password);
    const owner = await f.app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { authorization: 'Basic ' + Buffer.from('admin:owner-password').toString('base64') },
    });
    expect(owner.statusCode).toBe(200);
    const cookieHeader = owner.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    for (const authorization of ['Bearer unknown', 'Bearer', 'Bearer ' + f.issued.token]) {
      if (authorization.endsWith(f.issued.token)) f.issued.revoke();
      const denied = await f.app.inject({
        method: 'GET',
        url: '/api/sessions',
        headers: { authorization, cookie: cookieHeader },
      });
      expect(denied.statusCode).toBe(401);
    }
    expect(f.generic).toHaveBeenCalledOnce();
  }
);

it('requires bearer for MCP even with owner Basic and refuses manager conversion on an open server', async () => {
  const f = await fixture();
  const basic = 'Basic ' + Buffer.from('admin:owner-password').toString('base64');
  expect((await f.rpc('tools/list', undefined, { authorization: basic })).statusCode).toBe(401);
  const open = await fixture('');
  expect((await open.rpc('tools/list')).statusCode).toBe(401);
});

it.each([
  { name: 'raw_input', arguments: { workerId: WORKER, input: 'must never type' } },
  { name: 'supervisor_assign', arguments: { workerId: WORKER.slice(0, 8), requestId: REQUEST } },
  { name: 'supervisor_assign', arguments: { workerId: SID, requestId: REQUEST } },
  { name: 'supervisor_assign', arguments: { workerId: WORKER, requestId: REQUEST, task: 'unowned task' } },
  { name: 'supervisor_retry', arguments: { workerId: WORKER } },
  { name: 'supervisor_status', arguments: { sessionId: WORKER } },
])('refuses invalid or expanded tool $name arguments before controller dispatch', async (params) => {
  const f = await fixture();
  expect((await f.rpc('tools/call', params)).json().error.code).toBe(-32602);
  expect(f.controller.assign).not.toHaveBeenCalled();
  expect(f.controller.retry).not.toHaveBeenCalled();
});

it('does not execute a mutation notification or arbitrary RPC method', async () => {
  const f = await fixture();
  const notification = await f.app.inject({
    method: 'POST',
    url: '/api/supervisor-mcp',
    headers: f.headers,
    payload: {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'supervisor_assign', arguments: { workerId: WORKER, requestId: REQUEST } },
    },
  });
  expect(notification.json().error.code).toBe(-32600);
  expect((await f.rpc('sessions/delete', { id: WORKER })).json().error.code).toBe(-32601);
  expect(f.controller.assign).not.toHaveBeenCalled();
});

it('carries exact credential authority across a held operation and never exposes a revoked read', async () => {
  const f = await fixture();
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  let effects = 0;
  f.controller.assign.mockImplementation(async (_worker, _request, current) => {
    entered.resolve();
    await release.promise;
    if (!current?.()) throw Error('private rejection');
    effects++;
    return f.controller.getStatus();
  });
  const pending = f.rpc('tools/call', {
    name: 'supervisor_assign',
    arguments: { workerId: WORKER, requestId: REQUEST },
  });
  const responsePromise = Promise.resolve(pending);
  await entered.promise;
  f.revoke();
  release.resolve();
  const response = await responsePromise;
  expect(effects).toBe(0);
  expect(response.body).not.toContain('private rejection');
  expect(response.json().error).toBeDefined();
  expect((await f.rpc('tools/list')).statusCode).toBe(401);
});

it.each(['disabled', 'missing', 'password-change', 'read-error'])(
  'revalidates the actual multiuser owner: %s',
  async (failure) => {
    const f = await fixture('owner-password', true);
    vi.mocked(findUser).mockImplementation(async () => {
      if (failure === 'read-error') throw Error('private file');
      return failure === 'missing'
        ? undefined
        : ({
            username: 'alice',
            role: 'user',
            disabled: failure === 'disabled',
            mustChangePassword: failure === 'password-change',
          } as never);
    });
    expect((await f.rpc('tools/list')).statusCode).toBe(401);
    expect(f.resolve).not.toHaveBeenCalled();
  }
);

it('checks current role and credential again after the asynchronous owner read', async () => {
  const f = await fixture('owner-password', true);
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  vi.mocked(findUser).mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    return { username: 'alice', role: 'user' } as never;
  });
  const responsePromise = Promise.resolve(f.rpc('tools/list'));
  await entered.promise;
  f.issued.revoke();
  release.resolve();
  expect((await responsePromise).statusCode).toBe(401);
});

it('refuses an already-aborted request before invoking any manager operation', async () => {
  const f = await fixture('owner-password', false, true);
  const response = await f.rpc('tools/call', {
    name: 'supervisor_assign',
    arguments: { workerId: WORKER, requestId: REQUEST },
  });
  expect(response.statusCode).toBe(401);
  expect(f.resolve).not.toHaveBeenCalled();
  expect(f.controller.assign).not.toHaveBeenCalled();
  expect(f.controller.retry).not.toHaveBeenCalled();
});
