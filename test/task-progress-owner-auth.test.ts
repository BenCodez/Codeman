/** @fileoverview Real HTTP auth must certify owner progress; fake workers and private temporary journals only. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, expect, it, vi } from 'vitest';
import { registerAuthMiddleware } from '../src/web/middleware/auth.js';
import { registerTaskRoutes } from '../src/web/routes/task-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { TaskController, type TaskObservation } from '../src/supervision/controller.js';
import { TaskStore, type TaskSaveAuthority } from '../src/supervision/store.js';
import type { TaskState } from '../src/supervision/schema.js';
import { commandHash } from '../src/supervision/evidence.js';
import { createUser, invalidateUsersCache } from '../src/user-store.js';
import { createMockRouteContext } from './mocks/index.js';
const OWNER = 'Basic ' + Buffer.from('alice:fixture-owner-password').toString('base64');
const apps: FastifyInstance[] = [],
  roots: string[] = [],
  controllers: TaskController[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.stop();
  for (const app of apps.splice(0)) await app.close();
  vi.unstubAllEnvs();
  invalidateUsersCache();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(mode: 'anonymous' | 'basic' | 'multiuser' = 'anonymous', syntheticIdentity = false) {
  const root = await mkdtemp(join(tmpdir(), 'task-owner-auth-'));
  roots.push(root);
  vi.stubEnv('CODEMAN_DATA_DIR', root);
  vi.stubEnv('CODEMAN_MULTIUSER', mode === 'multiuser' ? '1' : '0');
  vi.stubEnv('CODEMAN_USERNAME', 'alice');
  vi.stubEnv('CODEMAN_PASSWORD', mode === 'basic' ? 'fixture-owner-password' : '');
  invalidateUsersCache();
  if (mode === 'multiuser') await createUser({ username: 'alice', role: 'user', password: 'fixture-owner-password' });
  const app = Fastify({ rewriteUrl: (req) => (req.url ?? '/').replace(/^\/api\/v1\//, '/api/') });
  apps.push(app);
  await app.register(cookie);
  const auth = registerAuthMiddleware(app, false);
  if (syntheticIdentity)
    app.addHook('onRequest', async (req) => {
      req.authUser = { username: 'alice', role: 'admin' };
    });
  const path = join(root, 'tasks.json'),
    store = new TaskStore(path);
  let now = 10000;
  const evidence: TaskObservation = {
    observation: {
      activity: 'completed',
      reason: 'turn-completed',
      at: 12000,
      conversationId: '11111111-2222-3333-4444-555555555555',
      turnId: 'turn-1',
      submissionKey: 'owner-submission',
      safeToAct: false,
    },
    commands: new Map(),
  };
  const observe = vi.fn(async () => evidence),
    act = vi.fn(async () => 'not-sent' as const);
  const persist = vi.fn((state: TaskState, authority?: TaskSaveAuthority) => store.save('worker', state, authority));
  const controller = new TaskController({ now: () => now, observe, act, persist, changed: () => {} });
  controllers.push(controller);
  await controller.update({
    objective: 'Owner review',
    criteria: [{ id: 'review', kind: 'manual', description: 'Owner independently verifies result' }],
  });
  now = 12000;
  const ctx = createMockRouteContext();
  Object.assign(ctx._session, { mode: 'codex', owner: 'alice' });
  registerTaskRoutes(app, { ...ctx, getTaskController: () => controller } as never);
  installRouteErrorHandler(app);
  await app.ready();
  const url = `/api/sessions/${ctx._sessionId}/task`;
  const progress = (headers: Record<string, string> = {}, versioned = false) =>
    app.inject({
      method: 'POST',
      url: (versioned ? url.replace('/api/', '/api/v1/') : url) + '/progress',
      headers,
      payload: { outcome: 'completed', verifiedCriteria: ['review'] },
    });
  return {
    app,
    auth,
    controller,
    evidence,
    observe,
    act,
    persist,
    path,
    store,
    url,
    session: ctx._session,
    progress,
    advance: (time: number) => {
      now = time;
      evidence.observation.at = time;
    },
  };
}
it.each([
  {},
  { origin: 'http://localhost', 'user-agent': 'Browser' },
  { cookie: 'codeman_session=' + '0'.repeat(64) },
  { authorization: OWNER },
  { authorization: 'Bearer codeman-manager-v1.' + '0'.repeat(64) },
  { 'x-codeman-owner': 'alice', 'x-codeman-session-id': 'owner', 'x-codeman-authenticated': 'true' },
])('anonymous HTTP cannot certify manual criteria with forged context %j', async (headers) => {
  const h = await fixture();
  const before = h.controller.getStatus(),
    bytes = await readFile(h.path, 'utf8');
  h.observe.mockClear();
  h.persist.mockClear();
  const result = await h.progress(headers);
  // Later layers reserve manager Bearers and reject invalid ones in auth middleware.
  // Earlier layers reach the owner-only route; both must refuse without mutation.
  if (headers.authorization?.startsWith('Bearer codeman-manager-v1.')) expect([401, 403]).toContain(result.statusCode);
  else expect(result.statusCode).toBe(403);
  if (result.statusCode === 401) expect(result.json()).toEqual({ success: false, error: 'Invalid manager credential' });
  else {
    expect(result.json()).toMatchObject({ success: false, errorCode: 'FORBIDDEN' });
    expect(result.json().error).toContain('authenticated Codeman owner');
  }
  expect(h.controller.getStatus()).toEqual(before);
  expect(await readFile(h.path, 'utf8')).toBe(bytes);
  expect(h.observe).not.toHaveBeenCalled();
  expect(h.persist).not.toHaveBeenCalled();
  expect(h.act).not.toHaveBeenCalled();
});
it('a synthetic server authUser is not a validated owner credential', async () => {
  const h = await fixture('anonymous', true);
  expect((await h.progress()).statusCode).toBe(403);
  expect(h.store.get('worker').criteria[0].verified).toBe(false);
});
it.each([
  {},
  { cookie: 'codeman_session=forged' },
  { authorization: 'Basic ' + Buffer.from('alice:wrong-password').toString('base64') },
  { authorization: 'Bearer codeman-manager-v1.' + '0'.repeat(64) },
])('active auth rejects missing/invalid owner credential %j', async (headers) => {
  const h = await fixture('basic');
  expect((await h.progress(headers)).statusCode).toBe(401);
  expect(h.store.get('worker').criteria[0].verified).toBe(false);
});
it.each(['basic', 'multiuser'] as const)(
  'validated %s owner Basic and issued cookie can certify their task',
  async (mode) => {
    const h = await fixture(mode);
    const login = await h.app.inject({ method: 'GET', url: h.url, headers: { authorization: OWNER } });
    expect(login.statusCode).toBe(200);
    const raw = login.headers['set-cookie'],
      value = Array.isArray(raw) ? raw[0] : raw;
    const ownerCookie = value?.split(';')[0];
    expect(ownerCookie).toMatch(/^codeman_session=/);
    const first = await h.app.inject({
      method: 'POST',
      url: h.url + '/progress',
      headers: { authorization: OWNER },
      payload: { outcome: 'unfinished', checkpoint: 'Owner review in progress' },
    });
    expect(first.statusCode).toBe(200);
    const result = await h.progress({ cookie: ownerCookie! }, true);
    expect(result.statusCode).toBe(200);
    expect(h.store.get('worker')).toMatchObject({
      phase: 'completed',
      outcome: 'completed',
      criteria: [{ verified: true, evidence: { source: 'owner' } }],
    });
    expect(h.act).not.toHaveBeenCalled();
  }
);
it.each(['x-codeman-parent-session', 'x-codeman-supervisor-session'] as const)(
  'agent attribution via %s withdraws even valid owner authentication',
  async (header) => {
    const h = await fixture('basic'),
      before = h.controller.getStatus();
    for (const attribution of ['worker-session', 'unknown-caller', ''])
      expect((await h.progress({ authorization: OWNER, [header]: attribution })).statusCode).toBe(403);
    expect(h.controller.getStatus()).toEqual(before);
  }
);
it('configuration cannot inject a preverified owner criterion through a sibling endpoint', async () => {
  const h = await fixture('basic'),
    before = h.controller.getStatus();
  const result = await h.app.inject({
    method: 'PUT',
    url: h.url,
    headers: { authorization: OWNER },
    payload: {
      criteria: [
        {
          id: 'review',
          kind: 'manual',
          description: 'Claimed review',
          verified: true,
          evidence: { source: 'owner', at: 12000 },
        },
      ],
    },
  });
  expect(result.statusCode).toBe(400);
  expect(h.controller.getStatus()).toEqual(before);
});
it.each(['manual', 'command'] as const)(
  'structured agent progress retains the %s criterion authority rule',
  async (kind) => {
    const h = await fixture();
    await h.controller.update({
      criteria: [
        { id: 'review', description: 'Acceptance', kind, ...(kind === 'command' ? { command: 'npm test' } : {}) },
      ],
      config: { enabled: true },
    });
    await h.controller.progress({
      outcome: 'unfinished',
      checkpoint: 'Owner assigned the task',
      nextAction: 'Verify the declared evidence',
    });
    h.advance(14000);
    h.evidence.commands.set(commandHash('npm test'), { startedAt: 13000, completedAt: 14000 });
    h.evidence.marker = {
      key: 'progress-1',
      at: 14000,
      submissionKey: 'owner-submission',
      progress: { outcome: 'completed', verifiedCriteria: ['review'] },
    };
    await h.controller.refresh();
    const result = h.controller.getStatus();
    expect(result.criteria[0].verified).toBe(kind === 'command');
    if (kind === 'command')
      expect(result).toMatchObject({
        phase: 'completed',
        outcome: 'completed',
        criteria: [{ evidence: { source: 'command' } }],
      });
    else expect(result.outcome).not.toBe('completed');
    expect(h.act).not.toHaveBeenCalled();
  }
);

it('a genuine credential cannot certify a task owned by another user', async () => {
  const h = await fixture('multiuser');
  Object.assign(h.session, { owner: 'bob' });
  const result = await h.progress({ authorization: OWNER });
  expect(result.statusCode).toBe(404);
  expect(h.store.get('worker').criteria[0].verified).toBe(false);
});
it('a revoked cookie cannot borrow proof from its previously authenticated request', async () => {
  const h = await fixture('basic');
  const login = await h.app.inject({ method: 'GET', url: h.url, headers: { authorization: OWNER } });
  const raw = login.headers['set-cookie'],
    value = Array.isArray(raw) ? raw[0] : raw;
  const ownerCookie = value!.split(';')[0];
  h.auth.authSessions!.delete(ownerCookie.split('=')[1]);
  expect((await h.progress({ cookie: ownerCookie })).statusCode).toBe(401);
  expect(h.store.get('worker').criteria[0].verified).toBe(false);
});
