/** Real session/route eligibility with temporary journals and no native effects. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import type { FastifyInstance } from 'fastify';
import { JSDOM } from 'jsdom';
import { expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import type { MuxSession } from '../src/mux-interface.js';
import { WebServer } from '../src/web/server.js';
import { SupervisorStore } from '../src/supervisor/store.js';
import { initialSupervisorState } from '../src/supervisor/schema.js';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
it.each([
  ['isolated local', true, true, true, false, false, true],
  ['daemon local', false, true, true, false, false, false],
  ['manual-only fallback', true, false, true, false, false, false],
  ['missing pinned home', true, true, false, false, false, false],
  ['discovered pane', true, true, true, true, false, false],
  ['durable ineligible role', false, false, false, false, true, true],
] as const)(
  'aligns public state, actual API and UI for %s',
  async (_name, noDaemon, isolated, pinnedHome, discovered, durableRole, supported) => {
    const directory = await mkdtemp(join(homedir(), 'supervisor-ui-eligibility-'));
    const server = new WebServer(0, false, true);
    const id = randomUUID();
    const sessions = Reflect.get(server, 'sessions') as Map<string, Session>;
    const store = new SupervisorStore(join(directory, 'supervisors.json'));
    Reflect.set(server, 'supervisorStore', store);
    const muxSession: MuxSession = {
      sessionId: id,
      muxName: 'fixture-supervisor-ui',
      pid: 777,
      createdAt: 1,
      workingDir: directory,
      mode: 'codex',
      attached: false,
      recoveryIsolated: isolated,
      ...(pinnedHome ? { recoveryCodexHome: directory } : {}),
    };
    const session = new Session({
      id,
      workingDir: directory,
      mode: 'codex',
      useMux: true,
      muxSession,
      codexConfig: { noDaemon },
      discoveredMuxSession: discovered,
    });
    await session.ensureRecoveryIdentityFence();
    sessions.set(id, session);
    if (durableRole) await store.save(id, initialSupervisorState(id));
    const dom = new JSDOM(readFileSync(join(publicDir, 'index.html'), 'utf8'), {
      runScripts: 'outside-only',
      url: 'http://localhost/',
    });
    try {
      const state = Reflect.get(server, 'getSessionStateWithRespawn').call(server, session);
      expect(state.supervisorAvailable).toBe(supported);
      await Reflect.get(server, 'setupRoutes').call(server);
      const api = Reflect.get(server, 'app') as FastifyInstance;
      const response = await api.inject({ method: 'GET', url: `/api/sessions/${id}/supervisor` });
      expect(response.statusCode).toBe(supported ? 200 : 400);
      const context = dom.getInternalVMContext();
      vm.runInContext('class CodemanApp {}', context);
      vm.runInContext(readFileSync(join(publicDir, 'supervisor-ui.js'), 'utf8'), context);
      const app = vm.runInContext('new CodemanApp()', context);
      app.sessions = new Map([[id, state]]);
      app.supportsSessionRecovery = () => true;
      app.showToast = vi.fn();
      app._apiJson = vi.fn(async () => response.json().data);
      expect(app.openSupervisorOptions(id)).toBe(supported);
      if (supported) await vi.waitFor(() => expect(app._supervisorView.busy).toBe(false));
      expect(app._apiJson).toHaveBeenCalledTimes(supported ? 1 : 0);
      expect(dom.window.document.querySelector<HTMLElement>('[data-tab="supervisor"]')!.style.display).toBe(
        supported ? '' : 'none'
      );
    } finally {
      dom.window.close();
      sessions.clear();
      await server.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
);
