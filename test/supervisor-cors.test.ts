/** Real middleware/routes via inject only: no socket, worker or process effects. */
import { afterEach, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { registerAuthMiddleware, registerHostGuard, registerSecurityHeaders } from '../src/web/middleware/auth.js';
import { registerSupervisorRoutes } from '../src/web/routes/supervisor-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { initialSupervisorState } from '../src/supervisor/schema.js';
import { createMockRouteContext } from './mocks/mock-route-context.js';

const SID = '11111111-2222-4333-8444-555555555555';
const WORKER = '22222222-3333-4444-8555-666666666666';
const REQUEST = '33333333-4444-4555-8666-777777777777';
const ATTRIBUTION = 'X-Codeman-Supervisor-Session';
const route = `/api/sessions/${SID}/supervisor/workers/${WORKER}/assign`;
const apps: FastifyInstance[] = [];

async function fixture(password = '') {
  vi.stubEnv('CODEMAN_MULTIUSER', '0');
  vi.stubEnv('CODEMAN_PASSWORD', password);
  vi.stubEnv('CODEMAN_USERNAME', 'admin');
  const app = Fastify({ logger: false });
  apps.push(app);
  await app.register(cookie);
  registerHostGuard(app, () => ({ bindHost: '127.0.0.1', allowedHosts: [] }));
  const auth = registerAuthMiddleware(app, false);
  app.addHook('onClose', async () => {
    for (const map of Object.values(auth)) map?.dispose();
  });
  registerSecurityHeaders(app, false);
  const ctx = createMockRouteContext({ sessionId: SID });
  const assign = vi.fn(async () => initialSupervisorState(SID));
  registerSupervisorRoutes(app, { ...ctx, getSupervisorController: () => ({ assign }) } as never);
  installRouteErrorHandler(app);
  await app.ready();
  return { app, assign };
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.unstubAllEnvs();
});

it.each(['http://localhost:5173', 'http://127.0.0.1:5173'])(
  'allows the attributed worker POST preflight from %s with the existing exact header allowlist',
  async (origin) => {
    const { app, assign } = await fixture();
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: route,
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, authorization, x-codeman-supervisor-session',
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(origin);
    expect(String(preflight.headers['access-control-allow-headers']).toLowerCase().split(', ')).toEqual([
      'content-type',
      'authorization',
      'x-codeman-supervisor-session',
    ]);
    expect(String(preflight.headers['access-control-allow-methods']).split(', ')).toContain('POST');
    expect(assign).not.toHaveBeenCalled();
    const posted = await app.inject({
      method: 'POST',
      url: route,
      headers: { origin, [ATTRIBUTION]: SID },
      payload: { requestId: REQUEST },
    });
    expect(posted.statusCode).toBe(200);
    expect(posted.headers['access-control-allow-origin']).toBe(origin);
    expect(assign).toHaveBeenCalledExactlyOnceWith(WORKER, REQUEST);
  }
);

it.each(['https://foreign.invalid', 'http://localhost.foreign.invalid:5173', 'null'])(
  'retains the foreign-origin preflight and write restrictions for %s',
  async (origin) => {
    const { app, assign } = await fixture();
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: route,
      headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': ATTRIBUTION },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    expect(preflight.headers['access-control-allow-headers']).toBeUndefined();
    const posted = await app.inject({
      method: 'POST',
      url: route,
      headers: { origin, [ATTRIBUTION]: SID },
      payload: { requestId: REQUEST },
    });
    expect(posted.statusCode).toBe(403);
    expect(assign).not.toHaveBeenCalled();
  }
);

it('does not turn attribution into authentication or loosen the manager role check', async () => {
  const { app, assign } = await fixture('test-password');
  const headers = { origin: 'http://localhost:5173', [ATTRIBUTION]: SID };
  const post = (extra: Record<string, string>) =>
    app.inject({ method: 'POST', url: route, headers: { ...headers, ...extra }, payload: { requestId: REQUEST } });
  expect((await post({})).statusCode).toBe(401);
  expect(assign).not.toHaveBeenCalled();
  const authorization = 'Basic ' + Buffer.from('admin:test-password').toString('base64');
  expect((await post({ authorization, [ATTRIBUTION]: WORKER })).statusCode).toBe(403);
  expect(assign).not.toHaveBeenCalled();
  expect((await post({ authorization })).statusCode).toBe(200);
  expect(assign).toHaveBeenCalledExactlyOnceWith(WORKER, REQUEST);
});
