import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { TextEncoder } from 'node:util';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const SID = '11111111-1111-4111-8111-111111111111';
const TASK = 'custom-task-one';
const REVISION = 'a'.repeat(64);
const doms: JSDOM[] = [];
function automation() {
  return {
    checkIns: { enabled: false, intervalMinutes: 60 },
    tasks: [],
    status: { phase: 'idle', reason: 'configured', runs: [] },
  };
}
function harness() {
  const dom = new JSDOM(readFileSync(resolve(publicDir, 'index.html'), 'utf8'), {
    runScripts: 'outside-only',
    url: 'http://localhost/',
  });
  doms.push(dom);
  const ctx = dom.getInternalVMContext();
  (dom.window as any).TextEncoder = TextEncoder;
  vm.runInContext('class CodemanApp {}', ctx);
  for (const file of ['supervisor-ui.js', 'supervisor-automation-ui.js', 'supervisor-brain-ui.js'])
    vm.runInContext(readFileSync(resolve(publicDir, file), 'utf8'), ctx);
  const app = vm.runInContext('new CodemanApp()', ctx) as any;
  app._supervisorView = { sessionId: SID, state: { phase: 'active' } };
  app._apiJson = vi.fn(async () => automation());
  app.showToast = vi.fn();
  const get = (id: string) => dom.window.document.getElementById(id)! as any;
  return { app, dom, get, ctx };
}
afterEach(() => {
  for (const dom of doms.splice(0)) dom.window.close();
});

describe('manager schedule and memory controls', () => {
  it.each([
    { source: 'codeman-session-counter-estimate', available: false, inputTokens: 100 },
    { source: 'codeman-session-counter-estimate', available: true, inputTokens: 0, costEstimate: 0 },
    { source: 'codeman-session-counter-estimate', available: true, inputTokens: Infinity },
    { source: 'unverified', available: true, inputTokens: 100 },
  ])('does not turn unavailable or invalid usage into a measured zero budget', (usage) => {
    const h = harness();
    (h.dom.window as any).usage = usage;
    expect(vm.runInContext('supervisorUiUsageText(usage)', h.ctx)).toBe('Usage unavailable; provider quota unknown');
  });

  it('labels usable counters as estimates with unknown age and quota', () => {
    const h = harness();
    (h.dom.window as any).usage = {
      source: 'codeman-session-counter-estimate',
      available: true,
      inputTokens: 1500,
      costEstimate: 0.25,
    };
    const text = vm.runInContext('supervisorUiUsageText(usage)', h.ctx);
    expect(text).toContain('input tokens');
    expect(text).toContain('$0.2500 cost estimate');
    expect(text).toContain('age unknown; provider quota unknown');
  });
  it('recognizes delegated message receipts only with an exact payload binding', () => {
    const h = harness();
    const state = {
      version: 1,
      supervisorSessionId: SID,
      objective: 'Coordinate',
      enabled: true,
      phase: 'active',
      reason: 'owner-started',
      workers: [],
      handledRequestIds: ['message-request-1'],
      handledRequestBindings: [
        { requestId: 'message-request-1', workerId: SID, action: 'message', payloadHash: REVISION },
      ],
      history: [],
    };
    (h.dom.window as any).candidate = state;
    expect(vm.runInContext(`supervisorUiStateValid(candidate, '${SID}')`, h.ctx)).toBe(true);
    delete (state.handledRequestBindings[0] as any).payloadHash;
    expect(vm.runInContext(`supervisorUiStateValid(candidate, '${SID}')`, h.ctx)).toBe(false);
  });

  it('changes messaging grants only after the owner explicitly edits the grant control', async () => {
    const h = harness();
    const worker = { sessionId: SID, allowMessages: true, maxMessages: 2 };
    h.get('supervisorWorkers').value = JSON.stringify([worker]);
    h.app._performSupervisorRequest = vi.fn();
    await h.app.saveSupervisorConfiguration();
    expect(h.app._performSupervisorRequest.mock.calls[0][2].workers).toEqual([worker]);
    h.app._supervisorView.messageGrantEdited = true;
    h.get('supervisorAllowMessages').checked = false;
    await h.app.saveSupervisorConfiguration();
    expect(h.app._performSupervisorRequest.mock.calls[1][2].workers).toEqual([{ ...worker, allowMessages: false }]);
  });
  it('loads hourly defaults only on demand and preserves multiline custom instructions on save', async () => {
    const h = harness();
    expect(h.app._apiJson).not.toHaveBeenCalled();
    await h.app.loadSupervisorAutomation();
    expect(h.get('supervisorCheckInMinutes').value).toBe('60');
    h.get('supervisorCheckInsEnabled').checked = true;
    h.app.addSupervisorCustomTask();
    const row = h.get('supervisorCustomTasks').firstElementChild;
    const field = (key: string) => row.querySelector(`[data-field="${key}"]`);
    field('name').value = 'Review progress';
    const instructions = '  Inspect checkpoints 🌍\n\nKeep this whitespace.  ';
    field('instructions').value = instructions;
    field('kind').value = 'recurring';
    field('intervalMinutes').value = '60';
    field('maxRuns').value = '3';
    field('enabled').checked = true;
    h.app._apiJson.mockImplementation(async (_url: string, options: any) => ({
      ...options.body,
      status: automation().status,
    }));
    await h.app.saveSupervisorAutomation();
    const body = h.app._apiJson.mock.calls.at(-1)[1].body;
    expect(body.checkIns).toEqual({ enabled: true, intervalMinutes: 60 });
    expect(body.tasks[0]).toMatchObject({
      name: 'Review progress',
      instructions,
      enabled: true,
      kind: 'recurring',
      intervalMinutes: 60,
      maxRuns: 3,
    });
  });

  it('refuses malformed loaded evidence and invalid task drafts without making a write', async () => {
    const h = harness();
    h.app._apiJson.mockResolvedValueOnce({ ...automation(), checkIns: { enabled: true, intervalMinutes: -1 } });
    await h.app.loadSupervisorAutomation();
    expect(h.get('supervisorAutomationSettings').disabled).toBe(true);
    await h.app.saveSupervisorAutomation();
    expect(h.app._apiJson).toHaveBeenCalledTimes(1);
    await h.app.loadSupervisorAutomation(true);
    h.app.addSupervisorCustomTask();
    await h.app.saveSupervisorAutomation();
    expect(h.app._apiJson).toHaveBeenCalledTimes(2);
  });

  it('retains an uncertain run identity across a new view and acknowledges only its exact receipt', async () => {
    const h = harness();
    h.app._supervisorView.automation = automation();
    h.app._apiJson.mockRejectedValueOnce(new Error('response lost'));
    await h.app.runSupervisorCustomTask(TASK);
    const firstId = h.app._apiJson.mock.calls[0][1].body.requestId;
    const key = `codeman:supervisorTaskRun:${SID}:${TASK}`;
    expect(h.dom.window.sessionStorage.getItem(key)).toBe(firstId);
    h.app._supervisorView = { sessionId: SID, state: { phase: 'active' }, automation: automation() };
    h.app._apiJson.mockResolvedValueOnce({
      ...automation(),
      status: {
        ...automation().status,
        lastRun: { requestId: firstId, taskId: 'wrong-task', payloadHash: REVISION, phase: 'accepted' },
      },
    });
    await h.app.runSupervisorCustomTask(TASK);
    expect(h.dom.window.sessionStorage.getItem(key)).toBe(firstId);
    h.app._apiJson.mockResolvedValueOnce({
      ...automation(),
      status: {
        ...automation().status,
        lastRun: { requestId: firstId, taskId: TASK, payloadHash: REVISION, phase: 'accepted' },
      },
    });
    await h.app.runSupervisorCustomTask(TASK);
    expect(h.app._apiJson.mock.calls.map((call: any) => call[1].body.requestId)).toEqual([firstId, firstId, firstId]);
    expect(h.dom.window.sessionStorage.getItem(key)).toBeNull();
  });

  it('retains a memory draft when its compare-and-swap save conflicts', async () => {
    const h = harness();
    h.app._apiJson.mockResolvedValueOnce({ markdown: '# Goals\n', revision: REVISION, exists: true, noteCount: 0 });
    await h.app.loadSupervisorBrain();
    const draft = '# Worker roles\n\nBackend agent: API work.\n\n<img src=x onerror="throw 1">';
    h.get('supervisorBrainMarkdown').value = draft;
    h.app._apiJson.mockResolvedValueOnce(null);
    await h.app.saveSupervisorBrain();
    expect(h.app._apiJson.mock.calls.at(-1)).toEqual([
      `/api/sessions/${SID}/supervisor/brain`,
      { method: 'PUT', body: { markdown: draft, ifMatch: REVISION } },
    ]);
    expect(h.get('supervisorBrainMarkdown').value).toBe(draft);
    expect(h.get('supervisorBrainSettings').disabled).toBe(true);
    expect(h.get('supervisorBrainPanel').querySelector('img')).toBeNull();
  });

  it('does not overwrite a newly selected manager when an old memory read finishes', async () => {
    const h = harness();
    let finish!: (value: unknown) => void;
    h.app._apiJson.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const pending = h.app.loadSupervisorBrain();
    const newer = { sessionId: 'different-manager', state: { phase: 'paused' } };
    h.app._supervisorView = newer;
    finish({ markdown: 'old manager notes', revision: REVISION, exists: true, noteCount: 0 });
    await pending;
    expect(h.app._supervisorView).toBe(newer);
    expect(h.get('supervisorBrainMarkdown').value).toBe('');
  });
});
