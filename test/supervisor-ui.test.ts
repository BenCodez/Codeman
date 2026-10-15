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
  return { app, get, dom, ctx };
}
afterEach(() => {
  for (const dom of doms.splice(0)) dom.window.close();
});

describe('Codex supervisor UI', () => {
  it.each(
    [false, true].flatMap((mobile) =>
      [
        {
          label: 'fresh recovery dead pane',
          inspection: { health: 'dead-pane', recoveryStale: false, stale: true },
          allowed: true,
        },
        { label: 'fresh legacy dead pane', inspection: { health: 'dead-pane', stale: false }, allowed: true },
        {
          label: 'fresh interrupted recovery',
          inspection: { health: 'interrupted', recoveryStale: false, stale: false },
          allowed: false,
        },
        { label: 'fresh legacy interruption', inspection: { health: 'interrupted', stale: false }, allowed: false },
        {
          label: 'stale recovery dead pane',
          inspection: { health: 'dead-pane', recoveryStale: true, stale: false },
          allowed: false,
        },
        { label: 'stale legacy dead pane', inspection: { health: 'dead-pane', stale: true }, allowed: false },
        { label: 'missing freshness', inspection: { health: 'dead-pane' }, allowed: false },
        { label: 'absent inspection', inspection: undefined, allowed: false },
        { label: 'malformed health', inspection: { health: ['dead-pane'], stale: false }, allowed: false },
        { label: 'healthy worker', inspection: { health: 'working', stale: false }, allowed: false },
        { label: 'unknown worker', inspection: { health: 'unknown', stale: false }, allowed: false },
      ].map((entry) => ({ mobile, ...entry }))
    )
  )('offers crash retry only for $label (mobile=$mobile)', async ({ mobile, inspection, allowed }) => {
    const h = harness();
    h.dom.window.document.body.classList.toggle('mobile', mobile);
    const active = {
      ...state(),
      enabled: true,
      phase: 'active',
      workers: [
        {
          sessionId: WID,
          task: 'Finish the fixture',
          criteria: [{ id: 'review', description: 'Owner review', kind: 'manual' }],
          assignments: 0,
          maxAssignments: 2,
          maxRuntimeMs: 60000,
        },
      ],
    };
    const rows = inspection ? [{ sessionId: WID, ...inspection }] : [];
    h.app._supervisorView = { sessionId: SID, state: active, workerStatus: rows, workersBusy: false };
    h.app._apiJson.mockImplementation(
      async (url: string, options?: { method?: string; body?: { requestId: string } }) => {
        if (url.endsWith('/workers')) return rows;
        const requestId = options!.body!.requestId;
        return {
          ...active,
          handledRequestIds: [requestId],
          handledRequestBindings: [{ requestId, workerId: WID, action: 'retry' }],
        };
      }
    );
    h.app._renderSupervisorStatus();
    const retry = h.get('supervisorWorkerStatus').querySelectorAll('button')[1];
    expect(retry.textContent).toBe('Retry crash');
    expect(retry.disabled).toBe(!allowed);
    retry.click();
    if (allowed) {
      await vi.waitFor(() => expect(h.app._supervisorView.workersBusy).toBe(false));
      const posts = h.app._apiJson.mock.calls.filter((call: any[]) => call[1]?.method === 'POST');
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject([
        `/api/sessions/${SID}/supervisor/workers/${WID}/retry`,
        { method: 'POST', headers: { 'X-Codeman-Supervisor-Session': SID } },
      ]);
      expect(h.dom.window.sessionStorage.getItem('codeman:supervisorWorkerRequests:v1')).toBe('[]');
    } else {
      expect(h.app._apiJson).not.toHaveBeenCalled();
      expect(h.dom.window.sessionStorage.getItem('codeman:supervisorWorkerRequests:v1')).toBeNull();
    }
  });

  it.each([false, true])(
    'distinguishes cached task status from recovery freshness (recovery stale=%s)',
    (recoveryStale) => {
      const h = harness();
      h.app._supervisorView = {
        sessionId: SID,
        state: { ...state(), phase: 'active', workers: [{ sessionId: WID, assignments: 0, maxAssignments: 2 }] },
        workersBusy: false,
        workerStatus: [
          {
            sessionId: WID,
            health: 'dead-pane',
            stale: true,
            taskStale: true,
            recoveryStale,
            task: { phase: 'paused' },
          },
        ],
      };
      h.app._renderSupervisorStatus();
      const row = h.get('supervisorWorkerStatus');
      expect(row.textContent).toContain('task status may be stale');
      expect(row.textContent.includes('recovery may be stale')).toBe(recoveryStale);
      expect(row.querySelectorAll('button')[1].disabled).toBe(recoveryStale);
      expect(h.app._apiJson).not.toHaveBeenCalled();
    }
  );

  it.each([
    [null],
    [{ sessionId: 0 }],
    [
      { sessionId: WID, health: 'unknown' },
      { sessionId: WID, health: 'unknown' },
    ],
    [{ sessionId: WID, health: { toString: 'bad' } }],
    [{ sessionId: WID, health: 'unknown', task: { phase: { toString: 'bad' } } }],
  ])('refuses malformed worker inspection rows before rendering', async (...rows) => {
    const h = harness();
    h.app._supervisorView = {
      sessionId: SID,
      state: { ...state(), phase: 'active' },
      workerStatus: [],
      workersBusy: false,
    };
    h.app._apiJson.mockResolvedValue(rows);
    await h.app.loadSupervisorWorkers();
    expect(h.app._supervisorView.workerStatus).toEqual([]);
    expect(h.app._supervisorView.workersBusy).toBe(false);
    h.app._apiJson.mockResolvedValue([{ sessionId: WID, health: 'unknown' }]);
    await h.app.loadSupervisorWorkers();
    expect(h.app._supervisorView.workerStatus).toEqual([{ sessionId: WID, health: 'unknown' }]);
  });

  it.each(['status', 'configuration', 'start'] as const)(
    'refuses malformed %s state before rendering',
    async (path) => {
      const h = harness();
      h.app._supervisorView = { sessionId: SID, state: state(), workerStatus: [], workersBusy: false };
      h.app._apiJson.mockResolvedValue({ ...state(), workers: [null] });
      if (path === 'status') await h.app.loadSupervisorStatus();
      else await h.app._performSupervisorRequest(path === 'start' ? '/start' : '', path === 'start' ? 'POST' : 'PUT');
      expect(h.app._supervisorView.state).toBeNull();
      expect(h.app._supervisorView.busy).toBe(false);
      expect(h.get('supervisorSettings').disabled).toBe(true);
      h.app._apiJson.mockResolvedValue(state());
      await h.app.loadSupervisorStatus();
      expect(h.app._supervisorView.state).toEqual(state());
      expect(h.get('supervisorSettings').disabled).toBe(false);
    }
  );

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

  it.each(['lost', 'parse', 'exception', 'incomplete'] as const)(
    'reuses the durable worker request after a %s response through API helpers and reload',
    async (failure) => {
      const storageKey = 'codeman:supervisorWorkerRequests:v1';
      const records = new Map<string, { workerId: string; action: string }>();
      const requests: string[] = [];
      let loseResponse = true;
      const attach = (h: ReturnType<typeof harness>) => {
        vm.runInContext(read('api-client.js'), h.ctx);
        delete h.app._apiJson;
        h.app._supervisorView = {
          sessionId: SID,
          state: { ...state(), enabled: true, phase: 'active', workers: [] },
          workerStatus: [],
          busy: false,
          workersBusy: false,
        };
        h.dom.window.fetch = vi.fn(async (path: string, options: { method?: string; body?: string }) => {
          if (options?.method !== 'POST') return { ok: true, json: async () => ({ success: true, data: [] }) };
          const requestId = JSON.parse(options.body!).requestId;
          requests.push(requestId);
          records.set(requestId, { workerId: WID, action: 'assign' });
          if (loseResponse) {
            loseResponse = false;
            if (failure === 'lost' || failure === 'exception') throw new Error('Fixture response lost');
            if (failure === 'parse')
              return {
                ok: true,
                json: async () => {
                  throw new Error('Fixture malformed JSON');
                },
              };
            return { ok: true, json: async () => ({ version: 1, supervisorSessionId: SID, workers: [] }) };
          }
          return {
            ok: true,
            json: async () => ({
              success: true,
              data: {
                ...state(),
                enabled: true,
                phase: 'active',
                handledRequestIds: [...records.keys()],
                handledRequestBindings: [...records].map(([requestId, binding]) => ({ requestId, ...binding })),
              },
            }),
          };
        }) as never;
      };
      const first = harness();
      attach(first);
      await first.app.supervisorWorkerAction(WID, 'assign');
      expect(records.size).toBe(1);
      expect(first.app._supervisorView.workersBusy).toBe(false);
      const durable = first.dom.window.sessionStorage.getItem(storageKey)!;
      expect(JSON.parse(durable)[0].requestId).toBe(requests[0]);
      first.app.closeSupervisorOptions();
      const reloaded = harness();
      reloaded.dom.window.sessionStorage.setItem(storageKey, durable);
      attach(reloaded);
      await reloaded.app.supervisorWorkerAction(WID, 'assign');
      expect(requests).toHaveLength(2);
      expect(requests[1]).toBe(requests[0]);
      expect(records.size).toBe(1);
      expect(reloaded.dom.window.sessionStorage.getItem(storageKey)).toBe('[]');
      await reloaded.app.supervisorWorkerAction(WID, 'assign');
      expect(requests[2]).not.toBe(requests[0]);
      expect(records.size).toBe(2);
    }
  );

  it('retains uncertain IDs across worker/action changes and refuses malformed or full storage before dispatch', async () => {
    const h = harness();
    const key = 'codeman:supervisorWorkerRequests:v1';
    h.app._supervisorView = {
      sessionId: SID,
      state: { ...state(), enabled: true, phase: 'active', workers: [] },
      workerStatus: [],
      workersBusy: false,
    };
    h.app._apiJson.mockResolvedValue(null);
    await h.app.supervisorWorkerAction(WID, 'assign');
    await h.app.supervisorWorkerAction(WID, 'retry');
    const other = '33333333-3333-4333-8333-333333333333';
    await h.app.supervisorWorkerAction(other, 'assign');
    const ids = h.app._apiJson.mock.calls
      .filter((call: any[]) => call[1]?.method === 'POST')
      .map((call: any[]) => call[1].body.requestId);
    expect(new Set(ids).size).toBe(3);
    const count = h.app._apiJson.mock.calls.length;
    for (const stored of [
      '{unreadable}',
      JSON.stringify(
        Array.from({ length: 64 }, (_, i) => ({
          sessionId: SID,
          workerId: `worker-${i}`,
          action: 'assign',
          requestId: `request-${i}`,
        }))
      ),
    ]) {
      h.dom.window.sessionStorage.setItem(key, stored);
      await h.app.supervisorWorkerAction(WID, 'assign');
      expect(h.app._apiJson.mock.calls).toHaveLength(count);
      expect(h.dom.window.sessionStorage.getItem(key)).toBe(stored);
    }
  });

  it.each([
    'conflicting',
    'duplicate',
    'partial',
    'array-phase',
    'null-worker',
    'partial-worker',
    'null-history',
    'partial-flight',
    'invalid-last-request',
    'invalid-history-worker',
    'control-task',
    'control-objective',
    'control-description',
    'control-command',
    'wrong-manager',
    'wrong-worker',
    'wrong-action',
  ] as const)('retains the same ID after a %s acknowledgement', async (kind) => {
    const h = harness();
    const key = 'codeman:supervisorWorkerRequests:v1';
    const active = { ...state(), enabled: true, phase: 'active', workers: [] };
    h.app._supervisorView = { sessionId: SID, state: active, workerStatus: [], workersBusy: false };
    const requests: string[] = [];
    let first = true;
    h.app._apiJson.mockImplementation(
      async (_path: string, options?: { method?: string; body?: { requestId: string } }) => {
        if (options?.method !== 'POST') return [];
        const id = options.body!.requestId;
        requests.push(id);
        const result: any = {
          ...active,
          handledRequestIds: [id],
          handledRequestBindings: [{ requestId: id, workerId: WID, action: 'assign' }],
        };
        if (!first) return result;
        first = false;
        if (kind === 'conflicting' || kind === 'duplicate') {
          result.handledRequestIds.push(id);
          result.handledRequestBindings.push({
            requestId: id,
            workerId: WID,
            action: kind === 'conflicting' ? 'retry' : 'assign',
          });
        }
        if (kind === 'partial') delete result.phase;
        if (kind === 'array-phase') result.phase = ['active'];
        if (kind === 'null-worker') result.workers = [null];
        if (kind === 'partial-worker') result.workers = [{ sessionId: WID }];
        if (kind === 'null-history') result.history = [null];
        if (kind === 'partial-flight') result.inFlight = { requestId: id };
        if (kind === 'invalid-history-worker') result.history = [{ at: 1, reason: 'accepted', workerId: 0 }];
        if (kind === 'control-objective') result.objective = 'objective\u001b';
        if (['invalid-last-request', 'control-task', 'control-description', 'control-command'].includes(kind)) {
          const worker: any = {
            sessionId: WID,
            task: 'task',
            assignments: 1,
            maxAssignments: 2,
            maxRuntimeMs: 1000,
            criteria: [{ id: 'done', description: 'done', kind: 'manual' }],
          };
          if (kind === 'invalid-last-request') worker.lastRequestId = 0;
          if (kind === 'control-task') worker.task = 'task\u001b';
          if (kind === 'control-description') worker.criteria[0].description = 'done\u0000';
          if (kind === 'control-command')
            worker.criteria[0] = { id: 'done', description: 'done', kind: 'command', command: 'echo\u0009done' };
          result.workers = [worker];
        }
        if (kind === 'wrong-manager') result.supervisorSessionId = WID;
        if (kind === 'wrong-worker') result.handledRequestBindings[0].workerId = SID;
        if (kind === 'wrong-action') result.handledRequestBindings[0].action = 'retry';
        return result;
      }
    );
    await h.app.supervisorWorkerAction(WID, 'assign');
    expect(JSON.parse(h.dom.window.sessionStorage.getItem(key)!)[0].requestId).toBe(requests[0]);
    await h.app.supervisorWorkerAction(WID, 'assign');
    expect(requests[1]).toBe(requests[0]);
    expect(h.dom.window.sessionStorage.getItem(key)).toBe('[]');
  });

  it('refuses dispatch before a storage write failure and retains a confirmed ID when acknowledgement storage fails', async () => {
    const h = harness();
    const key = 'codeman:supervisorWorkerRequests:v1';
    const active = { ...state(), enabled: true, phase: 'active', workers: [] };
    h.app._supervisorView = { sessionId: SID, state: active, workerStatus: [], workersBusy: false };
    const storage = h.dom.window.sessionStorage;
    const save = vi.spyOn(h.dom.window.Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Fixture storage unavailable');
    });
    await h.app.supervisorWorkerAction(WID, 'assign');
    expect(h.app._apiJson).not.toHaveBeenCalled();
    save.mockRestore();
    let failAck = true;
    const requests: string[] = [];
    h.app._apiJson.mockImplementation(
      async (_path: string, options?: { method?: string; body?: { requestId: string } }) => {
        if (options?.method !== 'POST') return [];
        const id = options.body!.requestId;
        requests.push(id);
        if (failAck) {
          failAck = false;
          vi.spyOn(h.dom.window.Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('Fixture acknowledgement storage unavailable');
          });
        }
        return {
          ...active,
          handledRequestIds: [id],
          handledRequestBindings: [{ requestId: id, workerId: WID, action: 'assign' }],
        };
      }
    );
    await h.app.supervisorWorkerAction(WID, 'assign');
    expect(JSON.parse(storage.getItem(key)!)[0].requestId).toBe(requests[0]);
    vi.mocked(h.dom.window.Storage.prototype.setItem).mockRestore();
    await h.app.supervisorWorkerAction(WID, 'assign');
    expect(requests[1]).toBe(requests[0]);
    expect(storage.getItem(key)).toBe('[]');
  });
});
