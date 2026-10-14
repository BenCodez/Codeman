import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const root = resolve(import.meta.dirname, '../src/web/public');
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');
const doms: JSDOM[] = [];
const SID = '11111111-1111-4111-8111-111111111111';
const WID = '22222222-2222-4222-8222-222222222222';
function state() {
  return {
    version: 1,
    supervisorSessionId: SID,
    objective: 'Ship',
    enabled: false,
    phase: 'disabled',
    reason: 'disabled',
    workers: [],
    handledRequestIds: [],
    handledRequestBindings: [],
    history: [],
  };
}
function harness() {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', url: 'http://localhost/' });
  doms.push(dom);
  const ctx = dom.getInternalVMContext();
  vm.runInContext('class CodemanApp {}', ctx);
  vm.runInContext(read('supervisor-ui.js'), ctx);
  const app = vm.runInContext('new CodemanApp()', ctx) as any;
  app.sessions = new Map([[SID, { mode: 'codex', codexConfig: { noAltScreen: true } }]]);
  app.supportsSessionRecovery = () => true;
  app.showToast = vi.fn();
  app._apiJson = vi.fn(async () => state());
  const get = (id: string) => dom.window.document.getElementById(id)! as any;
  return { app, get };
}
afterEach(() => {
  for (const dom of doms.splice(0)) dom.window.close();
});

describe('Codex supervisor UI', () => {
  it('stays disabled on open and submits explicit worker tasks, criteria and budgets', async () => {
    const h = harness();
    expect(h.app.openSupervisorOptions(SID)).toBe(true);
    await vi.waitFor(() => expect(h.app._supervisorView.busy).toBe(false));
    expect(h.get('supervisorEnabled').checked).toBe(false);
    h.get('supervisorObjective').value = 'Coordinate release';
    h.get('supervisorEnabled').checked = true;
    h.get('supervisorWorkers').value = JSON.stringify([
      {
        sessionId: WID,
        task: 'Fix parser',
        criteria: [{ id: 'tests', description: 'Tests pass', kind: 'command', command: 'npm test' }],
        maxAssignments: 2,
        maxRuntimeMs: 60000,
      },
    ]);
    await h.app.saveSupervisorConfiguration();
    expect(h.app._apiJson.mock.calls[1]).toMatchObject([
      `/api/sessions/${SID}/supervisor`,
      {
        method: 'PUT',
        body: {
          objective: 'Coordinate release',
          enabled: true,
          workers: [expect.objectContaining({ sessionId: WID, maxAssignments: 2 })],
        },
      },
    ]);
  });

  it('starts the manager through the supervisor endpoint and explains isolated identity eligibility', async () => {
    const h = harness();
    h.app.openSupervisorOptions(SID);
    await vi.waitFor(() => expect(h.app._supervisorView.busy).toBe(false));
    await h.app.supervisorAction('start');
    expect(h.app._apiJson.mock.calls[1][0]).toBe(`/api/sessions/${SID}/supervisor/start`);
    expect(read('index.html')).toMatch(/--no-daemon.*verified Codex identity/s);
  });

  it('inspects workers and assigns through the scoped controller route', async () => {
    const h = harness();
    const active = {
      ...state(),
      enabled: true,
      phase: 'active',
      workers: [
        {
          sessionId: WID,
          task: 'Fix parser',
          criteria: [{ id: 'tests', description: 'Tests pass', kind: 'command', command: 'npm test' }],
          maxAssignments: 2,
          maxRuntimeMs: 60000,
          assignments: 0,
        },
      ],
    };
    h.app._apiJson
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce([{ sessionId: WID, health: 'idle', stale: false, task: { phase: 'watching' } }])
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce([{ sessionId: WID, health: 'idle', stale: false, task: { phase: 'watching' } }]);
    h.app.openSupervisorOptions(SID);
    await vi.waitFor(() => expect(h.app._apiJson).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(h.app._supervisorView.workersBusy).toBe(false));
    const assign = h.get('supervisorWorkerStatus').querySelector('button');
    expect(assign.textContent).toBe('Assign task');
    assign.click();
    await vi.waitFor(() => expect(h.app._supervisorView.workersBusy).toBe(false));

    expect(h.app._apiJson.mock.calls[2][0]).toBe(`/api/sessions/${SID}/supervisor/workers/${WID}/assign`);
    expect(h.app._apiJson.mock.calls[2][1]).toMatchObject({
      method: 'POST',
      headers: { 'X-Codeman-Supervisor-Session': SID },
      body: { requestId: expect.stringMatching(/^.{8,120}$/) },
    });
  });
});
