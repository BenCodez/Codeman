/** Real authentication hooks and MCP routes via inject; no socket or native/worker effects. */
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import Ajv from 'ajv';
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
const TOOLS = [
  'supervisor_status',
  'supervisor_workers',
  'supervisor_assign',
  'supervisor_retry',
  'supervisor_message',
  'supervisor_brain',
];
const REVISION = 'a'.repeat(64);
const apps: FastifyInstance[] = [];
async function fixture(
  password = 'owner-password',
  multiuser = false,
  initiallyAborted = false,
  initiallyReady = true,
  withManagement = false
) {
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
  let current = true,
    ready = initiallyReady;
  const issued = registry.issue({
    sessionId: SID,
    owner: multiuser ? 'alice' : undefined,
    isCurrent: () => current,
    canOperate: () => ready,
  });
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
    message: vi.fn(async (_worker: string, _request: string, _message: string, isCurrent?: () => boolean) => {
      if (!isCurrent?.()) throw Error('cancelled');
      return state;
    }),
    captureBrainAuthority: vi.fn(async (isCurrent: () => boolean) => (isCurrent() ? isCurrent : undefined)),
  };
  const resolve = vi.fn((scope) =>
    scope.sessionId === SID && scope.owner === (multiuser ? 'alice' : undefined) ? controller : undefined
  );
  const management = {
    directory: vi.fn(async (_scope, current: () => boolean) => {
      if (!current()) throw Error('cancelled');
      return { agents: [{ sessionId: WORKER, mode: 'shell', remote: true }] };
    }),
    thread: vi.fn(async (_scope, _id, current: () => boolean) => {
      if (!current()) throw Error('cancelled');
      return { messages: [{ direction: 'agent', message: 'I maintain the API' }] };
    }),
    message: vi.fn(async (_scope, _id, _request, _message, current: () => boolean) => {
      if (!current()) throw Error('cancelled');
      return { queued: true };
    }),
  };
  const brain = {
    replace: vi.fn(async (_scope, _id, _markdown, _revision, current: () => boolean) => {
      if (!current()) throw Error('cancelled');
      return { revision: 'c'.repeat(64) };
    }),
    read: vi.fn(async (_scope, current: () => boolean) => {
      if (!current()) throw Error('cancelled');
      return { content: 'Owner teaching', revision: REVISION };
    }),
    append: vi.fn(async (_scope, _id: string, _note: string, _revision: string, current: () => boolean) => {
      if (!current()) throw Error('cancelled');
      return { revision: 'b'.repeat(64) };
    }),
  };
  registerSupervisorMcpRoutes(app, {
    credentials: registry,
    resolveController: resolve,
    brain,
    ...(withManagement ? { management } : {}),
  } as never);
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
    setReady: (value: boolean) => {
      ready = value;
    },
    registry,
    issued,
    controller,
    brain,
    management,
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

it('initializes and lists exactly six scoped tools, then invokes exact owner-selected operations', async () => {
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
  expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(TOOLS);
  const schemas = Object.fromEntries(
    listed.result.tools.map((tool: { name: string; inputSchema: unknown }) => [tool.name, tool.inputSchema])
  );
  expect(schemas.supervisor_message).toMatchObject({
    required: ['workerId', 'requestId', 'message'],
    additionalProperties: false,
    properties: { message: { maxLength: 4000 } },
  });
  expect(schemas.supervisor_brain).toMatchObject({
    required: ['mode'],
    additionalProperties: false,
    properties: {
      mode: { enum: ['read', 'append', 'replace'] },
      note: { maxLength: 2000 },
      ifMatch: { pattern: '^[a-f0-9]{64}$' },
    },
  });
  for (const name of TOOLS) {
    const result = await f.rpc('tools/call', {
      name,
      arguments:
        name === 'supervisor_brain'
          ? { mode: 'read' }
          : name === 'supervisor_message'
            ? { workerId: WORKER, requestId: REQUEST, message: 'Continue from the owner checkpoint' }
            : name.endsWith('assign') || name.endsWith('retry')
              ? { workerId: WORKER, requestId: REQUEST }
              : {},
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().error).toBeUndefined();
    expect(result.json().result.content[0].type).toBe('text');
  }
  expect(f.controller.assign).toHaveBeenCalledWith(WORKER, REQUEST, expect.any(Function));
  expect(f.controller.retry).toHaveBeenCalledWith(WORKER, REQUEST, expect.any(Function));
  expect(f.controller.message).toHaveBeenCalledWith(
    WORKER,
    REQUEST,
    'Continue from the owner checkpoint',
    expect.any(Function)
  );
  expect(f.brain.read).toHaveBeenCalledWith(f.registry.resolve(f.issued.token), expect.any(Function));
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
  expect((await f.rpc('tools/list')).json().result.tools.map((tool: { name: string }) => tool.name)).toEqual(TOOLS);
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
  { name: 'supervisor_message', arguments: { workerId: SID, requestId: REQUEST, message: 'self' } },
  { name: 'supervisor_message', arguments: { workerId: WORKER, requestId: REQUEST, message: '   ' } },
  { name: 'supervisor_message', arguments: { workerId: WORKER, requestId: REQUEST, message: 'x'.repeat(4001) } },
  { name: 'supervisor_message', arguments: { workerId: WORKER, requestId: REQUEST, message: '\x1b' } },
  { name: 'supervisor_message', arguments: { workerId: WORKER, requestId: REQUEST, message: 'text', raw: true } },
  { name: 'supervisor_brain', arguments: { mode: 'read', path: '/private' } },
  { name: 'supervisor_brain', arguments: { mode: 'append', requestId: REQUEST, note: 'teaching' } },
  {
    name: 'supervisor_brain',
    arguments: { mode: 'append', requestId: REQUEST, note: 'x'.repeat(2001), ifMatch: REVISION },
  },
  { name: 'supervisor_brain', arguments: { mode: 'append', requestId: REQUEST, note: 'teaching', ifMatch: 'unknown' } },
])('refuses invalid or expanded tool $name arguments before controller dispatch', async (params) => {
  const f = await fixture();
  expect((await f.rpc('tools/call', params)).json().error.code).toBe(-32602);
  expect(f.controller.assign).not.toHaveBeenCalled();
  expect(f.controller.retry).not.toHaveBeenCalled();
  expect(f.controller.message).not.toHaveBeenCalled();
  expect(f.brain.append).not.toHaveBeenCalled();
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

it('keeps an uncertain launch usable for inspection while refusing every worker mutation', async () => {
  const f = await fixture('owner-password', false, false, false);
  const scope = f.registry.resolve(f.issued.token)!;
  expect(scope).toBeDefined();
  expect(f.registry.canOperate(scope)).toBe(false);
  for (const name of ['supervisor_status', 'supervisor_workers']) {
    const response = await f.rpc('tools/call', { name, arguments: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json().result.content[0].type).toBe('text');
  }
  for (const name of ['supervisor_assign', 'supervisor_retry', 'supervisor_message', 'supervisor_brain']) {
    const args =
      name === 'supervisor_brain'
        ? { mode: 'append', requestId: REQUEST, note: 'teaching', ifMatch: REVISION }
        : {
            workerId: WORKER,
            requestId: REQUEST,
            ...(name === 'supervisor_message' ? { message: 'Instruction' } : {}),
          };
    const response = await f.rpc('tools/call', { name, arguments: args });
    expect(response.json().error).toMatchObject({ code: -32001 });
  }
  expect(
    (await f.rpc('tools/call', { name: 'supervisor_brain', arguments: { mode: 'read' } })).json().error
  ).toBeUndefined();
  expect(f.controller.message).not.toHaveBeenCalled();
  expect(f.brain.append).not.toHaveBeenCalled();
  expect(f.controller.inspectWorkers).toHaveBeenCalledWith(true);
  expect(f.controller.assign).not.toHaveBeenCalled();
  expect(f.controller.retry).not.toHaveBeenCalled();
  expect((await f.rpc('tools/list')).json().result.tools.map((tool: { name: string }) => tool.name)).toEqual(TOOLS);
  f.setReady(true);
  expect(f.registry.resolve(f.issued.token)).toBe(scope);
  expect(
    (
      await f.rpc('tools/call', { name: 'supervisor_assign', arguments: { workerId: WORKER, requestId: REQUEST } })
    ).json().error
  ).toBeUndefined();
  expect(f.controller.assign).toHaveBeenCalledOnce();
  f.revoke();
  expect((await f.rpc('tools/call', { name: 'supervisor_status' })).statusCode).toBe(401);
});

it('permits scoped owner teaching while paused without granting worker actions', async () => {
  const f = await fixture();
  f.controller.getStatus().phase = 'paused';
  f.controller.assign.mockRejectedValue(Error('paused owner intent'));
  const teaching = await f.rpc('tools/call', {
    name: 'supervisor_brain',
    arguments: { mode: 'append', requestId: REQUEST, note: 'Preserve the owner review checkpoint', ifMatch: REVISION },
  });
  expect(teaching.json().error).toBeUndefined();
  expect(f.controller.captureBrainAuthority).toHaveBeenCalledWith(expect.any(Function));
  expect(f.brain.append).toHaveBeenCalledWith(
    f.registry.resolve(f.issued.token),
    REQUEST,
    'Preserve the owner review checkpoint',
    REVISION,
    expect.any(Function)
  );
  const assigning = await f.rpc('tools/call', {
    name: 'supervisor_assign',
    arguments: { workerId: WORKER, requestId: REQUEST },
  });
  expect(assigning.json().error.code).toBe(-32000);
  expect(f.controller.getStatus().phase).toBe('paused');
  expect(f.generic).not.toHaveBeenCalled();
});

it('advertises brain read and append arguments that match runtime admission', async () => {
  const f = await fixture();
  const tools = (await f.rpc('tools/list')).json().result.tools;
  const schema = tools.find((tool: { name: string }) => tool.name === 'supervisor_brain').inputSchema;
  const validate = new Ajv({ allErrors: true }).compile(schema);
  const append = { mode: 'append', requestId: REQUEST, note: 'Owner checkpoint', ifMatch: REVISION };
  const cases: { args: Record<string, unknown>; valid: boolean }[] = [
    { args: { mode: 'read' }, valid: true },
    { args: append, valid: true },
    ...['requestId', 'note', 'ifMatch'].flatMap((field) => [
      { args: Object.fromEntries(Object.entries(append).filter(([key]) => key !== field)), valid: false },
      { args: { mode: 'read', [field]: append[field as keyof typeof append] }, valid: false },
    ]),
    { args: { ...append, ifMatch: 'unknown' }, valid: false },
    { args: { ...append, note: '' }, valid: false },
    { args: { ...append, path: '/private' }, valid: false },
    { args: { mode: 'unknown' }, valid: false },
  ];
  for (const { args, valid } of cases) {
    expect(validate(args), JSON.stringify(args)).toBe(valid);
    const result = (await f.rpc('tools/call', { name: 'supervisor_brain', arguments: args })).json();
    if (valid) expect(result.error).toBeUndefined();
    else expect(result.error).toMatchObject({ code: -32602 });
  }
  expect(f.brain.read).toHaveBeenCalledOnce();
  expect(f.brain.append).toHaveBeenCalledOnce();
});

it('rechecks credential authority after held brain authorization before appending', async () => {
  const f = await fixture();
  const entered = createDeferred<void>(),
    release = createDeferred<void>();
  f.controller.captureBrainAuthority.mockImplementation(async (current) => {
    entered.resolve();
    await release.promise;
    return current() ? current : undefined;
  });
  const response = Promise.resolve(
    f.rpc('tools/call', {
      name: 'supervisor_brain',
      arguments: { mode: 'append', requestId: REQUEST, note: 'Owner teaching', ifMatch: REVISION },
    })
  );
  try {
    await entered.promise;
    f.revoke();
  } finally {
    release.resolve();
  }
  expect((await response).json().error).toBeDefined();
  expect(f.brain.append).not.toHaveBeenCalled();
});

it('aligns advertised and admitted Unicode note sizes, rejecting oversized notes before memory effects', async () => {
  const f = await fixture();
  const schema = (await f.rpc('tools/list'))
    .json()
    .result.tools.find((tool: { name: string }) => tool.name === 'supervisor_brain').inputSchema;
  const validate = new Ajv({ allErrors: true }).compile(schema);
  for (const note of ['é'.repeat(1025), '界'.repeat(2000), '🙂'.repeat(2000)]) {
    const args = { mode: 'append', requestId: REQUEST, note, ifMatch: REVISION };
    expect(validate(args)).toBe(true);
    expect((await f.rpc('tools/call', { name: 'supervisor_brain', arguments: args })).json().error).toBeUndefined();
  }
  expect(f.brain.append).toHaveBeenCalledTimes(3);
  for (const note of ['a'.repeat(2001), '🙂'.repeat(2001), '   ']) {
    const args = { mode: 'append', requestId: REQUEST, note, ifMatch: REVISION };
    expect(validate(args)).toBe(false);
    expect((await f.rpc('tools/call', { name: 'supervisor_brain', arguments: args })).json().error).toMatchObject({
      code: -32602,
    });
  }
  expect(f.brain.append).toHaveBeenCalledTimes(3);
});

it('advertises the same non-whitespace message constraint that runtime admission enforces', async () => {
  const f = await fixture();
  const schema = (await f.rpc('tools/list'))
    .json()
    .result.tools.find((tool: { name: string }) => tool.name === 'supervisor_message').inputSchema;
  const validate = new Ajv({ allErrors: true }).compile(schema);
  for (const message of ['   ', '\r\n', '\u00a0\u2003']) {
    const args = { workerId: WORKER, requestId: REQUEST, message };
    expect(validate(args)).toBe(false);
    expect((await f.rpc('tools/call', { name: 'supervisor_message', arguments: args })).json().error).toMatchObject({
      code: -32602,
    });
  }
  expect(f.controller.message).not.toHaveBeenCalled();
  for (const message of ['Inspect the checkpoint', '  Preserve spacing.\nInspect next.  ', '\u2003界\u2003']) {
    const args = { workerId: WORKER, requestId: REQUEST, message };
    expect(validate(args)).toBe(true);
    expect((await f.rpc('tools/call', { name: 'supervisor_message', arguments: args })).json().error).toBeUndefined();
    expect(f.controller.message).toHaveBeenLastCalledWith(WORKER, REQUEST, message, expect.any(Function));
  }
  expect(f.controller.message).toHaveBeenCalledTimes(3);
});

it('exposes global agent discovery and cooperative messages without calling native worker handlers', async () => {
  const f = await fixture('owner-password', false, false, true, true);
  expect((await f.rpc('tools/list')).json().result.tools.map((t: { name: string }) => t.name)).toEqual([
    ...TOOLS,
    'supervisor_agents',
    'supervisor_agent',
  ]);
  const directory = (await f.rpc('tools/call', { name: 'supervisor_agents', arguments: {} })).json();
  expect(directory.error).toBeUndefined();
  expect(f.management.directory).toHaveBeenCalledOnce();
  for (const args of [
    { mode: 'read', agentId: WORKER },
    { mode: 'message', agentId: WORKER, requestId: REQUEST, message: 'Tell me your project and current role.' },
  ]) {
    expect((await f.rpc('tools/call', { name: 'supervisor_agent', arguments: args })).json().error).toBeUndefined();
  }
  expect(f.management.thread).toHaveBeenCalledOnce();
  expect(f.management.message).toHaveBeenCalledOnce();
  expect(f.controller.assign).not.toHaveBeenCalled();
  expect(f.controller.message).not.toHaveBeenCalled();
  expect(f.generic).not.toHaveBeenCalled();
  f.setReady(false);
  expect(
    (
      await f.rpc('tools/call', {
        name: 'supervisor_agent',
        arguments: { mode: 'message', agentId: WORKER, requestId: REQUEST, message: 'Wait' },
      })
    ).json().error.code
  ).toBe(-32001);
});

it('allows revision-checked brain rewrites only with fresh prepared-manager authority', async () => {
  const f = await fixture();
  const args = {
    mode: 'replace',
    requestId: REQUEST,
    markdown: '# Goals\nPreserve owner limits.\n## Agents\nAPI worker: backend.',
    ifMatch: REVISION,
  };
  const schema = (await f.rpc('tools/list'))
    .json()
    .result.tools.find((t: { name: string }) => t.name === 'supervisor_brain').inputSchema;
  expect(new Ajv().compile(schema)(args)).toBe(true);
  expect((await f.rpc('tools/call', { name: 'supervisor_brain', arguments: args })).json().error).toBeUndefined();
  expect(f.brain.replace).toHaveBeenCalledOnce();
  f.controller.captureBrainAuthority.mockResolvedValueOnce(undefined as never);
  expect(
    (
      await f.rpc('tools/call', { name: 'supervisor_brain', arguments: { ...args, requestId: 'rewrite-second' } })
    ).json().error.code
  ).toBe(-32001);
  expect(f.brain.replace).toHaveBeenCalledOnce();
});
