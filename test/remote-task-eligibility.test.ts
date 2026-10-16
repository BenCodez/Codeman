/** Actual launch metadata/API/markup controls, with inert native records and no worker effects. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import type { FastifyInstance } from 'fastify';
import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { WebServer } from '../src/web/server.js';
import { CodexTaskAdapter } from '../src/supervision/adapter.js';
import { initialTaskState } from '../src/supervision/schema.js';
import type { TaskController } from '../src/supervision/controller.js';
import type { TaskStore } from '../src/supervision/store.js';

let server: WebServer, app: FastifyInstance;
let internal: {
  sessions: Map<string, Session>;
  getTaskController(session: Session): TaskController | undefined;
  taskStore: TaskStore;
  stopRecoveryController(id: string, drop: boolean): Promise<void>;
};
const sessions: Session[] = [];
type TaskUI = {
  sessions: Map<string, unknown>;
  editingSessionId: string;
  showToast: ReturnType<typeof vi.fn>;
  _apiJson: ReturnType<typeof vi.fn>;
  _taskView: { loading: boolean; state: { phase: string } };
  openTaskOptions(id: string): boolean;
};
beforeAll(async () => {
  vi.spyOn(CodexTaskAdapter.prototype, 'observe').mockResolvedValue({
    observation: {
      activity: 'idle',
      reason: 'observing',
      safeToAct: false,
      at: Date.now(),
      conversationId: '11111111-2222-3333-4444-555555555555',
    },
    commands: new Map(),
  });
  server = new WebServer(0, false, true);
  internal = server as unknown as typeof internal;
  await Reflect.get(server, 'setupRoutes').call(server);
  app = Reflect.get(server, 'app') as FastifyInstance;
});
afterAll(async () => {
  for (const session of sessions) {
    await internal.stopRecoveryController(session.id, true);
    internal.sessions.delete(session.id);
    await session.stop(false);
  }
  await server.stop();
  vi.restoreAllMocks();
});
const cases = [
  ['controlled owned SSH', true],
  ['controlled legacy-owned SSH', true],
  ['missing home', false],
  ['relative home', false],
  ['different home', false],
  ['missing recorded home', false],
  ['relative recorded home', false],
  ['missing isolation', false],
  ['missing native record', false],
  ['missing broker', false],
  ['empty broker', false],
  ['malformed broker', false],
  ['pending-only broker', false],
  ['manual-only fallback', false],
  ['unowned SSH', false],
] as const;
function fixture(kind: (typeof cases)[number][0]) {
  const id = randomUUID();
  const config: ConstructorParameters<typeof Session>[0] = {
    id,
    mode: 'codex',
    workingDir: process.cwd(),
    useMux: true,
    codexConfig: { noDaemon: true },
    remote: {
      hostId: 'fixture',
      label: 'Fixture',
      host: 'worker.invalid',
      username: 'fixture',
      remotePath: '/fixture',
      owned: true,
    },
    envOverrides: { CODEX_HOME: '/fixture/codex-home' },
    muxSession: {
      sessionId: id,
      muxName: 'fixture-remote-task',
      pid: 777,
      createdAt: 1,
      workingDir: '/fixture',
      mode: 'codex',
      attached: false,
      recoveryCodexHome: '/fixture/codex-home',
      recoveryIsolated: true,
      recoveryInputBroker: randomUUID(),
    },
  };
  if (kind === 'controlled legacy-owned SSH') delete config.remote!.owned;
  if (kind === 'unowned SSH') config.remote!.owned = false;
  if (kind === 'missing home') config.envOverrides = undefined;
  if (kind === 'relative home') config.envOverrides!.CODEX_HOME = 'relative';
  if (kind === 'different home') config.envOverrides!.CODEX_HOME = '/other/home';
  if (kind === 'missing recorded home') delete config.muxSession!.recoveryCodexHome;
  if (kind === 'relative recorded home') config.muxSession!.recoveryCodexHome = 'relative';
  if (kind === 'missing isolation') delete config.muxSession!.recoveryIsolated;
  if (kind === 'missing native record') config.muxSession = undefined;
  if (kind === 'missing broker') delete config.muxSession!.recoveryInputBroker;
  if (kind === 'empty broker') config.muxSession!.recoveryInputBroker = '';
  if (kind === 'malformed broker') config.muxSession!.recoveryInputBroker = 'unknown-incarnation';
  if (kind === 'pending-only broker') {
    delete config.muxSession!.recoveryInputBroker;
    config.muxSession!.recoveryInputBrokerPending = randomUUID();
  }
  if (kind === 'manual-only fallback') {
    config.muxSession!.recoveryIsolated = false;
    delete config.muxSession!.recoveryInputBroker;
  }
  const session = new Session(config);
  sessions.push(session);
  internal.sessions.set(session.id, session);
  return session;
}
function view(session: Session) {
  const root = resolve(import.meta.dirname, '../src/web/public');
  const read = (file: string) => readFileSync(resolve(root, file), 'utf8');
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', url: 'http://localhost/' });
  const context = dom.getInternalVMContext();
  vm.runInContext('class CodemanApp {}', context);
  for (const file of ['api-client.js', 'recovery-ui.js', 'supervision-ui.js']) vm.runInContext(read(file), context);
  const ui = vm.runInContext('new CodemanApp()', context) as TaskUI;
  Object.assign(dom.window, { __codemanCliCatalog: [{ id: 'codex', recovery: 'codex-rollout' }] });
  ui.sessions = new Map([[session.id, session.toLightDetailedState()]]);
  ui.editingSessionId = session.id;
  ui.showToast = vi.fn();
  ui._apiJson = vi.fn(async (url: string) => {
    const response = await app.inject({ method: 'GET', url });
    if (response.statusCode !== 200) throw Error('Task API refused');
    return response.json().data;
  });
  return { dom, ui };
}
it.each(cases)(
  'advertises %s consistently from Session through actual task API and controls (%s)',
  async (kind, supported) => {
    const session = fixture(kind);
    expect(session.taskSupervisionSupported).toBe(supported);
    expect(session.toState().taskSupported).toBe(supported);
    expect(session.toLightDetailedState().taskSupported).toBe(supported);
    expect(!!internal.getTaskController(session)).toBe(supported);
    const response = await app.inject({ method: 'GET', url: `/api/sessions/${session.id}/task` });
    expect(response.statusCode).toBe(supported ? 200 : 400);
    const { dom, ui } = view(session);
    try {
      expect(ui.openTaskOptions(session.id)).toBe(supported);
      if (supported) await vi.waitFor(() => expect(ui._taskView.loading).toBe(false));
      expect(ui._apiJson).toHaveBeenCalledTimes(supported ? 1 : 0);
      expect(
        (dom.window.document.querySelector('#sessionOptionsModal [data-tab="task"]') as HTMLElement).style.display
      ).toBe(supported ? '' : 'none');
      if (!supported) {
        const enable = await app.inject({
          method: 'PUT',
          url: `/api/sessions/${session.id}/task`,
          payload: { config: { enabled: true } },
        });
        expect(enable.statusCode).toBe(400);
        expect(internal.taskStore.get(session.id)).toEqual(initialTaskState());
      }
    } finally {
      dom.window.close();
    }
  }
);
it.each(['paused', 'blocked'] as const)(
  'keeps supported owner %s controls without requiring active task work or fresh worker input',
  async (phase) => {
    const session = fixture('controlled owned SSH');
    const url = `/api/sessions/${session.id}/task`;
    expect(
      (
        await app.inject({
          method: 'PUT',
          url,
          payload: {
            objective: 'Owner fixture objective',
            criteria: [{ id: 'owner', kind: 'manual', description: 'Owner reviews fixture' }],
          },
        })
      ).statusCode
    ).toBe(200);
    if (phase === 'paused') expect((await app.inject({ method: 'POST', url: url + '/pause' })).statusCode).toBe(200);
    else
      expect(
        (
          await app.inject({
            method: 'POST',
            url: url + '/progress',
            payload: { outcome: 'blocked', checkpoint: 'Owner is waiting' },
          })
        ).statusCode
      ).toBe(200);
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.phase).toBe(phase);
    expect(session.toLightDetailedState().taskSupported).toBe(true);
    const { dom, ui } = view(session);
    try {
      expect(ui.openTaskOptions(session.id)).toBe(true);
      await vi.waitFor(() => expect(ui._taskView.loading).toBe(false));
      expect(ui._taskView.state.phase).toBe(phase);
      expect((dom.window.document.getElementById('taskResetBtn') as HTMLButtonElement).disabled).toBe(false);
      expect((dom.window.document.getElementById('taskSettings') as HTMLFieldSetElement).disabled).toBe(false);
    } finally {
      dom.window.close();
    }
  }
);
