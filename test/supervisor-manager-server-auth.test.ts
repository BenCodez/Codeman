/** @fileoverview Real server authentication and routing, with disposable credentials and no native workers. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { TmuxManager } from '../src/tmux-manager.js';
import { ManagerCredentialRegistry } from '../src/supervisor/manager-credentials.js';

const MANAGER = '11111111-1111-4111-8111-111111111111';
const OWNER = 'Basic ' + Buffer.from('fixture-owner:fixture-password').toString('base64');
const servers: WebServer[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture(authenticated = true, multiUser = false) {
  const directory = await mkdtemp(join(tmpdir(), 'codeman-manager-auth-'));
  directories.push(directory);
  vi.stubEnv('CODEMAN_DATA_DIR', directory);
  vi.stubEnv('CODEMAN_MULTIUSER', multiUser ? '1' : '0');
  vi.stubEnv('CODEMAN_USERNAME', 'fixture-owner');
  vi.stubEnv('CODEMAN_PASSWORD', authenticated ? 'fixture-password' : '');
  vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);
  const server = new WebServer(0, false, true);
  servers.push(server);
  const credentials = Reflect.get(server, 'supervisorManagerCredentials') as ManagerCredentialRegistry;
  expect(credentials).toBeInstanceOf(ManagerCredentialRegistry);
  let current = true;
  const credential = credentials.issue({ sessionId: MANAGER, isCurrent: () => current });
  await Reflect.get(server, 'setupRoutes').call(server);
  const app = Reflect.get(server, 'app') as FastifyInstance;
  const effect = vi.fn();
  app.post('/api/manager-auth-probe', async () => {
    effect();
    return { success: true };
  });
  const headers = { host: '127.0.0.1', authorization: `Bearer ${credential.token}` };
  const rpc = (method: string, params?: unknown) =>
    app.inject({
      method: 'POST',
      url: '/api/supervisor-mcp',
      headers,
      payload: { jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) },
    });
  return { server, app, effect, headers, rpc, revoke: credential.revoke, expire: () => (current = false) };
}

describe('actual server restricted manager credential', () => {
  it('authenticates only six scoped tools without relying on session attribution', async () => {
    const h = await fixture();
    const result = await h.rpc('tools/list');
    expect(result.statusCode).toBe(200);
    expect(result.json().result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'supervisor_status',
      'supervisor_workers',
      'supervisor_assign',
      'supervisor_retry',
      'supervisor_message',
      'supervisor_brain',
    ]);
    const arbitrary = await h.rpc('tools/call', { name: 'send_input', arguments: { input: 'unsafe' } });
    expect(arbitrary.json()).toMatchObject({ error: { code: -32602 } });
    const widened = await h.rpc('tools/call', {
      name: 'supervisor_assign',
      arguments: { workerId: MANAGER, requestId: 'fixture-request', input: 'unsafe' },
    });
    expect(widened.json()).toMatchObject({ error: { code: -32602 } });
    expect(h.effect).not.toHaveBeenCalled();
  });

  it('rejects generic controls with all optional attribution omitted, including versioned routes', async () => {
    const h = await fixture();
    for (const prefix of ['/api', '/api/v1']) {
      for (const path of [
        '/manager-auth-probe',
        `/sessions/${MANAGER}/input`,
        `/sessions/${MANAGER}/send-key`,
        `/sessions/${MANAGER}/task/progress`,
        `/sessions/${MANAGER}/supervisor/reset`,
      ]) {
        const result = await h.app.inject({
          method: 'POST',
          url: prefix + path,
          headers: h.headers,
          payload: { input: 'unsafe', outcome: 'complete', verifiedCriteria: ['manual'] },
        });
        expect(result.statusCode).toBe(403);
      }
      expect(
        (await h.app.inject({ method: 'DELETE', url: `${prefix}/sessions/${MANAGER}`, headers: h.headers })).statusCode
      ).toBe(403);
    }
    expect(h.effect).not.toHaveBeenCalled();
  });

  it('preserves owner authentication while a manager cannot promote its token with an owner cookie', async () => {
    const h = await fixture();
    const owner = await h.app.inject({
      method: 'POST',
      url: '/api/manager-auth-probe',
      headers: { host: '127.0.0.1', authorization: OWNER },
    });
    expect(owner.statusCode).toBe(200);
    const raw = owner.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(';')[0];
    expect(cookie).toMatch(/^codeman_session=/);
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: '/api/manager-auth-probe',
          headers: { ...h.headers, cookie: cookie! },
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: '/api/manager-auth-probe',
          headers: { host: '127.0.0.1' },
        })
      ).statusCode
    ).toBe(401);
    expect(h.effect).toHaveBeenCalledOnce();
  });

  it.each(['expire', 'revoke'] as const)(
    'never falls back to owner auth after a credential becomes %s',
    async (kind) => {
      const h = await fixture();
      expect((await h.rpc('tools/list')).statusCode).toBe(200);
      h[kind]();
      expect((await h.rpc('tools/list')).statusCode).toBe(401);
      expect(
        (
          await h.app.inject({
            method: 'POST',
            url: '/api/manager-auth-probe',
            headers: h.headers,
          })
        ).statusCode
      ).toBe(401);
      expect(h.effect).not.toHaveBeenCalled();
    }
  );

  it('rejects unknown credentials even on an otherwise unauthenticated owner server', async () => {
    const h = await fixture(false);
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: '/api/manager-auth-probe',
          headers: { host: '127.0.0.1', authorization: 'Bearer codeman-manager-v1.' + '0'.repeat(64) },
        })
      ).statusCode
    ).toBe(401);
    expect((await h.rpc('tools/list')).statusCode).toBe(401);
    expect(h.effect).not.toHaveBeenCalled();
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: '/api/manager-auth-probe',
          headers: { host: '127.0.0.1' },
        })
      ).statusCode
    ).toBe(200);
    expect(h.effect).toHaveBeenCalledOnce();
  });
});

it.each([
  { authenticated: false, multiUser: false, available: false },
  { authenticated: true, multiUser: false, available: true },
  { authenticated: false, multiUser: true, available: true },
])(
  'shares actual middleware readiness for new supervisor admission: $authenticated/$multiUser',
  async ({ authenticated, multiUser, available }) => {
    const h = await fixture(authenticated, multiUser);
    const readiness = () => Reflect.get(h.server, 'supervisorManagerAuthenticationAvailable').call(h.server);
    expect(readiness()).toBe(available);
    const session = { mode: 'codex', getRecoveryContext: () => ({ managed: true, noDaemon: true }) };
    const eligible = () => Reflect.get(h.server, 'supervisorManagerIsEligible').call(h.server, session);
    expect(eligible()).toBe(available);
    Reflect.set(h.server, 'supervisorManagerAuthReady', false);
    expect(readiness()).toBe(false); // An environment credential cannot replace uninstalled middleware.
    expect(eligible()).toBe(false);
  }
);
