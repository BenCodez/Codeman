import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { BrainStore } from '../src/supervisor/brain.js';
import { ManagementService, type ManagementSession } from '../src/management/store.js';
import { registerManagementAgentAuth, isManagementAgentRequest } from '../src/web/middleware/management-agent-auth.js';
import { registerManagementRoutes } from '../src/web/routes/management-routes.js';

describe('owner-global management and cooperative inbox', () => {
  let root: string;
  let sessions: ManagementSession[];
  let service: ManagementService;
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'codeman-management-'));
    sessions = [
      {
        id: 'session-one',
        owner: 'alice',
        name: 'Remote shell',
        mode: 'shell',
        remote: true,
        status: 'running',
        managerAvailable: false,
      },
      {
        id: 'manager-one',
        owner: 'alice',
        name: 'Local manager',
        mode: 'codex',
        remote: false,
        status: 'running',
        managerAvailable: true,
      },
      {
        id: 'other-owner',
        owner: 'bob',
        name: 'Other owner',
        mode: 'codex',
        remote: true,
        status: 'running',
        managerAvailable: false,
      },
    ];
    service = new ManagementService({ root, sessions: () => sessions });
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  const enable = async () => {
    const config = await service.read('alice');
    return service.configure('alice', {
      ifMatch: config.revision,
      managerSessionId: 'manager-one',
      agents: [{ sessionId: 'session-one', role: 'backend', notes: 'Owner-taught role', allowMessages: true }],
    });
  };
  it('rejects oversized serialized configuration with capacity while preserving prior settings', async () => {
    await enable();
    const before = await service.read('alice');
    const authority = await service.captureConfiguration('alice', () => true);
    sessions = Array.from({ length: 100 }, (_, i) => ({ ...sessions[0], id: 'agent-' + i }));
    const agents = sessions.map((session) => ({
      sessionId: session.id,
      role: '',
      notes: '界'.repeat(2000),
      allowMessages: false,
    }));
    await expect(
      service.configure('alice', { ifMatch: before.revision, managerSessionId: null, agents })
    ).rejects.toMatchObject({ code: 'capacity' });
    expect(await service.read('alice')).toEqual(before);
    expect(authority.current()).toBe(true);
    const valid = agents.map((agent) => ({ ...agent, notes: 'Brief role' }));
    expect(
      (await service.configure('alice', { ifMatch: before.revision, managerSessionId: null, agents: valid })).agents
    ).toHaveLength(100);
  });
  it.each(['owner', 'agent'])(
    'reports inbox byte capacity for %s while preserving messages and replay receipts',
    async (direction) => {
      await enable();
      const enrollment = await service.enroll('alice', 'session-one');
      const scope = (await service.authenticate(enrollment.token))!;
      const send = (message: string, id: string) =>
        direction === 'owner' ? service.send('alice', 'session-one', message, id) : service.reply(scope, message, id);
      const text = '界'.repeat(2000);
      await send(text, 'capacity-initial');
      let capacity = false;
      for (let i = 0; i < 64; i++) {
        const before = await service.messages('alice', 'session-one');
        try {
          await send(text, 'capacity-next-' + i);
        } catch (error) {
          expect(error).toMatchObject({ code: 'capacity' });
          expect(await service.messages('alice', 'session-one')).toEqual(before);
          expect(before.messages.length).toBeLessThan(64);
          capacity = true;
          break;
        }
      }
      expect(capacity).toBe(true);
      expect((await send(text, 'capacity-initial')).duplicate).toBe(true);
    }
  );
  it('persists global selection and isolates even an administrative owner from other sessions', async () => {
    const data = await enable();
    expect(data.agents.map((a) => a.sessionId)).toEqual(['session-one', 'manager-one']);
    const restarted = new ManagementService({ root, sessions: () => sessions });
    expect((await restarted.read('alice')).managerSessionId).toBe('manager-one');
    await expect(service.enroll('alice', 'other-owner')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      service.configure('alice', { ifMatch: data.revision, managerSessionId: 'other-owner', agents: [] })
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('queues idempotent explicit messages, polls and replies without terminal effects', async () => {
    await enable();
    const enrollment = await service.enroll('alice', 'session-one');
    expect(enrollment.instructions).toContain(enrollment.token);
    const scope = await service.authenticate(enrollment.token);
    expect(scope).toBeDefined();
    const sent = await service.send('alice', 'session-one', 'What are you working on?', 'request-one');
    expect((await service.send('alice', 'session-one', 'What are you working on?', 'request-one')).duplicate).toBe(
      true
    );
    await expect(service.send('alice', 'session-one', 'Different', 'request-one')).rejects.toMatchObject({
      code: 'conflict',
    });
    expect((await service.receive(scope!)).messages).toHaveLength(1);
    await service.reply(scope!, 'Working on backend tests', 'reply-one', sent.message.id);
    expect((await service.receive(scope!)).messages).toHaveLength(0);
    expect((await service.messages('alice', 'session-one')).messages).toHaveLength(2);
    expect((await service.reply(scope!, 'Working on backend tests', 'reply-one', sent.message.id)).duplicate).toBe(
      true
    );
    const files = await fs.readFile(
      join(root, 'management-inboxes', createHash('sha256').update('alice\0session-one').digest('hex'), 'brain.md'),
      'utf8'
    );
    expect(files).not.toContain(enrollment.token);
  });
  it('rotation, revoked grants, deletion and owner changes invalidate credentials', async () => {
    await enable();
    const first = await service.enroll('alice', 'session-one');
    const next = await service.enroll('alice', 'session-one');
    expect(await service.authenticate(first.token)).toBeUndefined();
    expect(await service.authenticate(next.token)).toBeDefined();
    const config = await service.read('alice');
    await service.configure('alice', {
      ...config,
      ifMatch: config.revision,
      agents: [{ ...config.agents[0], allowMessages: false }],
    });
    expect(await service.authenticate(next.token)).toBeUndefined();
    await enable();
    sessions[0].owner = 'bob';
    expect(await service.authenticate(next.token)).toBeUndefined();
    sessions = sessions.filter((s) => s.id !== 'session-one');
    await expect(service.messages('alice', 'session-one')).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('vetoes active manager replacement, stale revisions and canceled writes', async () => {
    const config = await enable();
    sessions[1].managerActive = true;
    await expect(
      service.configure('alice', { ifMatch: config.revision, managerSessionId: null, agents: [] })
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(service.send('alice', 'session-one', 'Hello', 'cancel-one', () => false)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      service.configure('alice', { ifMatch: '0'.repeat(64), managerSessionId: 'manager-one', agents: [] })
    ).rejects.toMatchObject({ code: 'conflict' });
    expect((await service.messages('alice', 'session-one')).messages).toEqual([]);
  });
  it('preserves malformed private state and refuses to read or overwrite it', async () => {
    await enable();
    const path = join(root, 'management-config', createHash('sha256').update('alice').digest('hex'), 'brain.md');
    await fs.writeFile(path, 'broken', { mode: 0o600 });
    await expect(service.read('alice')).rejects.toMatchObject({ code: 'unavailable' });
    expect(await fs.readFile(path, 'utf8')).toBe('broken');
  });
  it('expires credentials after 24 hours and bounds message size and history', async () => {
    await enable();
    const enrollment = await service.enroll('alice', 'session-one');
    const scope = (await service.authenticate(enrollment.token))!;
    await expect(service.receive({ ...scope, expiresAt: Date.now() - 1 })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(service.send('alice', 'session-one', 'x'.repeat(2001), 'long-one')).rejects.toBeDefined();
    for (let n = 0; n < 64; n++) await service.send('alice', 'session-one', 'Hello', `request-${n}`);
    await expect(service.send('alice', 'session-one', 'Hello', 'overflow')).rejects.toMatchObject({ code: 'capacity' });
  });
  it('cancels an in-flight enqueue when the owner revokes messaging during its durable write', async () => {
    await enable();
    const original = BrainStore.prototype.replace;
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(BrainStore.prototype, 'replace').mockImplementation(async function (
      this: BrainStore,
      ...args: Parameters<BrainStore['replace']>
    ) {
      if (args[1].includes('race-prompt')) {
        entered();
        await gate;
      }
      return original.apply(this, args);
    });
    const pending = service.send('alice', 'session-one', 'race-prompt', 'request-race');
    const checked = expect(pending).rejects.toMatchObject({ code: 'forbidden' });
    await waiting;
    const config = await service.read('alice');
    await service.configure('alice', {
      ifMatch: config.revision,
      managerSessionId: config.managerSessionId,
      agents: [{ ...config.agents[0], allowMessages: false }],
    });
    release();
    await checked;
    expect((await service.messages('alice', 'session-one')).messages).toEqual([]);
  });
  it('revokes captured manager authority after a global settings change', async () => {
    await enable();
    const config = await service.read('alice');
    const authority = await service.captureManager('alice', 'manager-one');
    expect(authority()).toBe(true);
    await service.configure('alice', { ifMatch: config.revision, managerSessionId: null, agents: config.agents });
    expect(authority()).toBe(false);
    await expect(service.captureManager('alice', 'manager-one')).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('cannot commit an old credential reply across enrollment rotation', async () => {
    await enable();
    const first = await service.enroll('alice', 'session-one');
    const scope = (await service.authenticate(first.token))!;
    const original = BrainStore.prototype.replace;
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(BrainStore.prototype, 'replace').mockImplementation(async function (
      this: BrainStore,
      ...args: Parameters<BrainStore['replace']>
    ) {
      if (args[1].includes('race-reply')) {
        entered();
        await gate;
      }
      return original.apply(this, args);
    });
    const pending = service.reply(scope, 'race-reply', 'reply-race');
    const checked = expect(pending).rejects.toMatchObject({ code: 'conflict' });
    await waiting;
    const second = await service.enroll('alice', 'session-one');
    release();
    await checked;
    expect(await service.authenticate(first.token)).toBeUndefined();
    expect(await service.authenticate(second.token)).toBeDefined();
    expect((await service.messages('alice', 'session-one')).messages).toEqual([]);
  });
  it('serves owner settings, brain revisions and explicit enrollment through HTTP without worker effects', async () => {
    const brain = new BrainStore(join(root, 'http-brains'));
    const key = createHash('sha256').update('alice').digest('hex');
    const app = Fastify();
    app.addHook('onRequest', async (req) => {
      req.authUser = { username: 'alice', role: 'admin' };
    });
    registerManagementRoutes(app, {
      service,
      globalBrain: {
        read: async (_owner, current) => brain.read(key, current),
        replace: async (_owner, markdown, revision, current) => brain.replace(key, markdown, revision, current),
      },
    });
    const initial = (await app.inject({ method: 'GET', url: '/api/management' })).json().data;
    expect(initial.agents.map((a: { sessionId: string }) => a.sessionId)).not.toContain('other-owner');
    expect((await app.inject({ method: 'PUT', url: '/api/management', payload: {} })).statusCode).toBe(400);
    const configured = await app.inject({
      method: 'PUT',
      url: '/api/management',
      payload: {
        ifMatch: initial.revision,
        managerSessionId: 'manager-one',
        agents: [{ sessionId: 'session-one', role: 'Backend', notes: 'Manages tests', allowMessages: true }],
      },
    });
    expect(configured.statusCode).toBe(200);
    const enrollment = await app.inject({
      method: 'POST',
      url: '/api/management/agents/session-one/enroll',
      payload: {},
    });
    expect(enrollment.statusCode).toBe(200);
    expect(enrollment.headers['cache-control']).toBe('no-store');
    expect(enrollment.json().data.instructions).toContain(enrollment.json().data.token);
    const memory = (await app.inject({ method: 'GET', url: '/api/management/brain' })).json().data;
    const write = await app.inject({
      method: 'PUT',
      url: '/api/management/brain',
      payload: { ifMatch: memory.revision, markdown: '# Brain\nOwner instructions' },
    });
    expect(write.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/management/brain',
          payload: { ifMatch: memory.revision, markdown: 'stale' },
        })
      ).statusCode
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/management/agents/session-one/messages',
          payload: { message: 'Describe your work', requestId: 'http-message' },
        })
      ).statusCode
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/api/management/agents/session-one/messages' })).json().data.messages
    ).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/api/management/agent-inbox' })).statusCode).toBe(401);
    await app.close();
  });
  it('accepts token only on exact inbox endpoint, and never grants owner identity', async () => {
    vi.stubEnv('CODEMAN_PASSWORD', 'synthetic-password');
    sessions.forEach((session) => {
      if (session.owner === 'alice') session.owner = 'admin';
    });
    const config = await service.read('admin');
    await service.configure('admin', {
      ifMatch: config.revision,
      managerSessionId: 'manager-one',
      agents: [{ sessionId: 'session-one', role: '', notes: '', allowMessages: true }],
    });
    const { token } = await service.enroll('admin', 'session-one');
    const app = Fastify();
    registerManagementAgentAuth(app, service);
    app.addHook('onRequest', async (req, reply) => {
      if (!isManagementAgentRequest(req)) return reply.code(401).send();
    });
    registerManagementRoutes(app, { service, globalBrain: { read: async () => ({}), replace: async () => ({}) } });
    const headers = { authorization: `Bearer ${token}` };
    expect((await app.inject({ method: 'GET', url: '/api/management/agent-inbox', headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/management', headers })).statusCode).toBe(403);
    expect(
      (await app.inject({ method: 'GET', url: '/api/management/agent-inbox?token=anything', headers })).statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/management/agent-inbox',
          headers: { authorization: 'Bearer codeman-agent-v1.invalid' },
        })
      ).statusCode
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/management/agent-inbox',
          headers,
          payload: { message: 'I test the backend', requestId: 'reply-identity' },
        })
      ).statusCode
    ).toBe(200);
    await app.close();
  });
});
