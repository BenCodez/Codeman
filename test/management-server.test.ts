/** Real WebServer hooks and routes, isolated data and dormant Session objects only. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { WebServer } from '../src/web/server.js';
import { Session } from '../src/session.js';
import { TmuxManager } from '../src/tmux-manager.js';
import { createUser } from '../src/user-store.js';
import { SessionLifecycleLog } from '../src/session-lifecycle-log.js';

const SHELL = '11111111-1111-4111-8111-111111111111';
const MANAGER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const ownerHeaders = {
  host: '127.0.0.1',
  authorization: 'Basic ' + Buffer.from('fixture-owner:fixture-password').toString('base64'),
};
const directories: string[] = [];
const servers: WebServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    (Reflect.get(server, 'sessions') as Map<string, Session>).clear();
    await server.stop();
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture(directory?: string, multiUser = false) {
  const root = directory ?? (await mkdtemp(join(tmpdir(), 'codeman-management-server-')));
  if (!directory) directories.push(root);
  vi.stubEnv('CODEMAN_DATA_DIR', root);
  vi.stubEnv('CODEMAN_MULTIUSER', multiUser ? '1' : '0');
  vi.stubEnv('CODEMAN_USERNAME', 'fixture-owner');
  vi.stubEnv('CODEMAN_PASSWORD', 'fixture-password');
  vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);
  vi.spyOn(SessionLifecycleLog.prototype, 'log').mockImplementation(() => {});
  const server = new WebServer(0, false, true);
  servers.push(server);
  const sessions = Reflect.get(server, 'sessions') as Map<string, Session>;
  const shell = new Session({
    id: SHELL,
    workingDir: root,
    mode: 'shell',
    name: 'Dormant SSH worker',
    useMux: false,
    owner: multiUser ? 'alice' : undefined,
    remote: {
      hostId: 'fake-host',
      label: 'Synthetic remote',
      host: 'example.invalid',
      username: 'fixture',
      remotePath: '/synthetic',
      owned: false,
    },
  });
  const manager = new Session({
    id: MANAGER,
    workingDir: root,
    mode: 'codex',
    name: 'Dormant manager',
    useMux: false,
    owner: multiUser ? 'alice' : undefined,
    codexConfig: { noDaemon: true },
  });
  const other = new Session({
    id: OTHER,
    workingDir: root,
    mode: 'codex',
    name: 'Other owner',
    useMux: false,
    owner: 'bob',
  });
  sessions.set(SHELL, shell);
  sessions.set(MANAGER, manager);
  sessions.set(OTHER, other);
  // Eligibility is separate native-launch evidence; no real launch or pane is created here.
  vi.spyOn(server as never, 'supervisorManagerIsEligible' as never).mockImplementation(
    ((session: Session) => session === manager) as never
  );
  const effects = [
    vi.spyOn(shell, 'start'),
    vi.spyOn(shell, 'write'),
    vi.spyOn(shell, 'stop'),
    vi.spyOn(manager, 'start'),
    vi.spyOn(manager, 'write'),
  ];
  await Reflect.get(server, 'setupRoutes').call(server);
  const app = Reflect.get(server, 'app') as FastifyInstance;
  return { server, app, root, shell, manager, sessions, effects };
}

describe('actual WebServer global management integration', () => {
  it('authenticates owners, configures shared memory and enrolls dormant SSH tabs without terminal effects', async () => {
    const h = await fixture();
    expect(
      (await h.app.inject({ method: 'GET', url: '/api/management', headers: { host: '127.0.0.1' } })).statusCode
    ).toBe(401);
    const response = await h.app.inject({ method: 'GET', url: '/api/management', headers: ownerHeaders });
    expect(response.statusCode).toBe(200);
    const config = response.json().data;
    expect(config.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: SHELL, mode: 'shell', remote: true, managerAvailable: false }),
      ])
    );
    expect(config.agents.map((agent: { sessionId: string }) => agent.sessionId)).not.toContain(OTHER);
    expect(config.brain.markdown).toBe('');
    const saved = await h.app.inject({
      method: 'PUT',
      url: '/api/management',
      headers: ownerHeaders,
      payload: {
        ifMatch: config.revision,
        managerSessionId: MANAGER,
        agents: [
          { sessionId: SHELL, role: 'Backend work', notes: 'Owner says it maintains tests', allowMessages: true },
        ],
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().data.brain).toEqual(config.brain);
    const readback = await h.app.inject({ method: 'GET', url: '/api/management', headers: ownerHeaders });
    expect(saved.json().data).toEqual(readback.json().data);
    const memory = await h.app.inject({
      method: 'PUT',
      url: '/api/management/brain',
      headers: ownerHeaders,
      payload: { ifMatch: config.brain.revision, markdown: '# Owner brain\nCoordinate backend tests.' },
    });
    expect(memory.statusCode).toBe(200);
    let brain = memory.json().data;
    expect(
      (await h.app.inject({ method: 'GET', url: '/api/management/brain', headers: ownerHeaders })).json().data
    ).toEqual(brain);
    expect(
      (await h.app.inject({ method: 'GET', url: '/api/management', headers: ownerHeaders })).json().data.brain
    ).toEqual(brain);
    const legacyBrain = await h.app.inject({
      method: 'GET',
      url: `/api/sessions/${MANAGER}/supervisor/brain`,
      headers: ownerHeaders,
    });
    expect(legacyBrain.statusCode).toBe(200);
    expect(legacyBrain.json().data).toEqual(brain);
    const legacyWrite = await h.app.inject({
      method: 'PUT',
      url: `/api/sessions/${MANAGER}/supervisor/brain`,
      headers: ownerHeaders,
      payload: {
        ifMatch: brain.revision,
        markdown: '# Shared owner brain\nEdited through the existing manager controls.',
      },
    });
    expect(legacyWrite.statusCode).toBe(200);
    brain = legacyWrite.json().data;
    expect(
      (await h.app.inject({ method: 'GET', url: '/api/management/brain', headers: ownerHeaders })).json().data
    ).toEqual(brain);
    const enrolled = await h.app.inject({
      method: 'POST',
      url: `/api/management/agents/${SHELL}/enroll`,
      headers: ownerHeaders,
      payload: {},
    });
    expect(enrolled.statusCode).toBe(200);
    const token = enrolled.json().data.token;
    const agentHeaders = { host: '127.0.0.1', authorization: `Bearer ${token}` };
    const queued = await h.app.inject({
      method: 'POST',
      url: `/api/management/agents/${SHELL}/messages`,
      headers: ownerHeaders,
      payload: { message: 'Describe the tests you maintain', requestId: 'owner-message-one' },
    });
    expect(queued.statusCode).toBe(200);
    const delivered = await h.app.inject({ method: 'GET', url: '/api/management/agent-inbox', headers: agentHeaders });
    expect(delivered.statusCode).toBe(200);
    expect(delivered.json().data.messages).toEqual([
      expect.objectContaining({ message: 'Describe the tests you maintain' }),
    ]);
    const replied = await h.app.inject({
      method: 'POST',
      url: '/api/management/agent-inbox',
      headers: agentHeaders,
      payload: {
        message: 'I maintain backend tests.',
        requestId: 'agent-reply-one',
        replyTo: queued.json().data.message.id,
      },
    });
    expect(replied.statusCode).toBe(200);
    expect(
      (await h.app.inject({ method: 'GET', url: '/api/management/agent-inbox', headers: agentHeaders })).json().data
        .messages
    ).toEqual([]);
    for (const url of ['/api/management', `/api/sessions/${SHELL}/input`, '/api/v1/management', '/api/status']) {
      const denied = await h.app.inject({
        method: url.endsWith('/input') ? 'POST' : 'GET',
        url,
        headers: agentHeaders,
        ...(url.endsWith('/input') ? { payload: { input: 'unsafe' } } : {}),
      });
      expect(denied.statusCode).toBe(403);
    }
    expect(
      (await h.app.inject({ method: 'GET', url: '/api/management/agent-inbox', headers: { host: '127.0.0.1' } }))
        .statusCode
    ).toBe(401);
    for (const effect of h.effects) expect(effect).not.toHaveBeenCalled();
    const before = h.shell.toState();
    const restored = await fixture(h.root);
    const restoredConfig = (
      await restored.app.inject({ method: 'GET', url: '/api/management', headers: ownerHeaders })
    ).json().data;
    expect(restoredConfig.managerSessionId).toBe(MANAGER);
    expect(restoredConfig.brain).toEqual(brain);
    expect(
      (
        await restored.app.inject({
          method: 'GET',
          url: `/api/management/agents/${SHELL}/messages`,
          headers: ownerHeaders,
        })
      ).json().data.messages
    ).toHaveLength(2);
    expect(
      (await restored.app.inject({ method: 'GET', url: '/api/management/agent-inbox', headers: agentHeaders }))
        .statusCode
    ).toBe(200);
    expect(h.shell.toState()).toEqual(before);
    for (const effect of [...h.effects, ...restored.effects]) expect(effect).not.toHaveBeenCalled();
  });
  it('confirms a settings save in the actual UI using the real API response', async () => {
    const h = await fixture();
    const publicRoot = join(import.meta.dirname, '../src/web/public');
    const read = (name: string) => readFileSync(join(publicRoot, name), 'utf8');
    const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', url: 'http://localhost/' });
    try {
      const context = dom.getInternalVMContext();
      context.TextEncoder = TextEncoder;
      vm.runInContext('class CodemanApp {}', context);
      vm.runInContext(read('supervisor-brain-ui.js'), context);
      vm.runInContext(read('management-ui.js'), context);
      const app = vm.runInContext('new CodemanApp()', context);
      const snapshot = (await h.app.inject({ method: 'GET', url: '/api/management', headers: ownerHeaders })).json()
        .data;
      const view = {
        snapshot,
        busy: false,
        rows: snapshot.agents.map((agent: { sessionId: string }) => ({
          agent,
          role: { value: agent.sessionId === SHELL ? 'Backend tests' : '' },
          notes: { value: '' },
          grant: { checked: agent.sessionId === SHELL },
        })),
      };
      app._managementView = view;
      app._renderManagementDirectory = vi.fn();
      app._renderManagementBusy = vi.fn();
      app._apiJson = async (url: string, options: { method: 'PUT'; body: unknown }) => {
        const response = await h.app.inject({
          method: options.method,
          url,
          headers: ownerHeaders,
          payload: options.body as object,
        });
        expect(response.statusCode).toBe(200);
        return response.json().data;
      };
      await app.saveManagementSettings();
      expect(dom.window.document.getElementById('managementStatus')!.textContent).toBe(
        'Global management settings saved.'
      );
      expect(view.snapshot).not.toBeNull();
      expect(view.snapshot.brain).toEqual(snapshot.brain);
      expect(app._renderManagementDirectory).toHaveBeenCalledWith(view);
      const readback = (await h.app.inject({ method: 'GET', url: '/api/management', headers: ownerHeaders })).json()
        .data;
      expect(view.snapshot).toEqual(readback);
      expect(readback.agents.find((agent: { sessionId: string }) => agent.sessionId === SHELL).role).toBe(
        'Backend tests'
      );
    } finally {
      dom.window.close();
    }
  });
  it('keeps other owners private even from an administrative dashboard identity', async () => {
    const h = await fixture(undefined, true);
    await createUser({ username: 'alice', password: 'alice-password', role: 'admin' });
    await createUser({ username: 'bob', password: 'bob-password', role: 'user' });
    const alice = {
      host: '127.0.0.1',
      authorization: 'Basic ' + Buffer.from('alice:alice-password').toString('base64'),
    };
    const bob = { host: '127.0.0.1', authorization: 'Basic ' + Buffer.from('bob:bob-password').toString('base64') };
    const a = await h.app.inject({ method: 'GET', url: '/api/management', headers: alice });
    expect(a.statusCode).toBe(200);
    expect(a.json().data.agents.map((agent: { sessionId: string }) => agent.sessionId)).toEqual([SHELL, MANAGER]);
    const b = await h.app.inject({ method: 'GET', url: '/api/management', headers: bob });
    expect(b.statusCode).toBe(200);
    expect(b.json().data.agents.map((agent: { sessionId: string }) => agent.sessionId)).toEqual([OTHER]);
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: `/api/management/agents/${OTHER}/enroll`,
          headers: alice,
          payload: {},
        })
      ).statusCode
    ).toBe(403);
    const saved = await h.app.inject({
      method: 'PUT',
      url: '/api/management/brain',
      headers: alice,
      payload: { ifMatch: a.json().data.brain.revision, markdown: 'Alice private instructions' },
    });
    expect(saved.statusCode).toBe(200);
    expect(
      (await h.app.inject({ method: 'GET', url: '/api/management/brain', headers: bob })).json().data.markdown
    ).toBe('');
    for (const effect of h.effects) expect(effect).not.toHaveBeenCalled();
  });
});

it('imports the selected manager memory and its receipts on the first global configuration save', async () => {
  const h = await fixture();
  const legacy = Reflect.get(h.server, 'supervisorBrainStore') as import('../src/supervisor/brain.js').BrainStore;
  const missing = await legacy.read(MANAGER, () => true);
  const taught = await legacy.replace(MANAGER, '# Prior manager context', missing.revision, () => true);
  const noted = await legacy.append(MANAGER, 'old-agent-note', 'Worker A owns the API.', taught.revision, () => true);
  const before = (await h.app.inject({ method: 'GET', url: '/api/management', headers: ownerHeaders })).json().data;
  expect(before.brain.exists).toBe(false);
  const saved = await h.app.inject({
    method: 'PUT',
    url: '/api/management',
    headers: ownerHeaders,
    payload: { ifMatch: before.revision, managerSessionId: MANAGER, agents: [] },
  });
  expect(saved.statusCode).toBe(200);
  expect(saved.json().data.brain).toMatchObject({ markdown: noted.markdown, noteCount: 1 });
  const global = Reflect.get(h.server, 'managementBrainStore') as import('../src/supervisor/brain.js').BrainStore;
  const id = Reflect.get(h.server, 'managementBrainId').call(h.server, 'admin') as string;
  expect(
    (await global.append(id, 'old-agent-note', 'Worker A owns the API.', taught.revision, () => true)).duplicate
  ).toBe(true);
  expect(await legacy.read(MANAGER, () => true)).toMatchObject({
    markdown: noted.markdown,
    revision: noted.revision,
    noteCount: 1,
  });
  expect(
    (await h.app.inject({ method: 'GET', url: '/api/management/brain', headers: ownerHeaders })).json().data.markdown
  ).toBe(noted.markdown);
  for (const effect of h.effects) expect(effect).not.toHaveBeenCalled();
});
