/** Task view tests use real markup and isolated owner-bound API fixtures. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskController } from '../src/supervision/controller.js';
import { initialTaskState } from '../src/supervision/schema.js';
const root = resolve(import.meta.dirname, '../src/web/public');
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');
const doms: JSDOM[] = [];
function state() {
  return {
    version: 1,
    objective: 'Review fixture',
    criteria: [
      { id: 'manual-a', description: 'Owner reviewed result', kind: 'manual', verified: false },
      { id: 'command-a', description: 'npm test', kind: 'command', command: 'npm test', verified: false },
    ],
    config: { enabled: false, maxContinuations: 3, maxRuntimeMs: 900000 },
    phase: 'disabled',
    outcome: 'unknown',
    reason: 'disabled',
    continuations: 0,
    checkpoint: '',
    nextAction: '',
    history: [],
  };
}
function harness(initial = state()) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', url: 'http://localhost/' });
  doms.push(dom);
  const ctx = dom.getInternalVMContext();
  vm.runInContext('class CodemanApp {}', ctx);
  for (const file of ['api-client.js', 'recovery-ui.js', 'supervision-ui.js']) vm.runInContext(read(file), ctx);
  const app = vm.runInContext('new CodemanApp()', ctx) as any;
  (dom.window as any).__codemanCliCatalog = [{ id: 'codex', recovery: 'codex-rollout' }];
  app.sessions = new Map([
    ['a', { mode: 'codex' }],
    ['b', { mode: 'codex' }],
  ]);
  app.editingSessionId = 'a';
  app.showToast = vi.fn();
  app._apiJson = vi.fn(async () => structuredClone(initial));
  const get = (id: string) => dom.window.document.getElementById(id)! as any;
  const open = async (id = 'a') => {
    app.editingSessionId = id;
    app.openTaskOptions(id);
    await vi.waitFor(() => expect(app._taskView.loading).toBe(false));
  };
  return { app, dom, get, open };
}
afterEach(() => {
  for (const dom of doms.splice(0)) dom.window.close();
});
describe('Task supervision UI', () => {
  it('is separately disabled by default and sends no activation request on open', async () => {
    const h = harness();
    await h.open();
    expect(h.get('taskEnabled').checked).toBe(false);
    expect(h.get('taskPhase').textContent).toBe('Off');
    expect(h.app._apiJson.mock.calls).toHaveLength(1);
    expect(h.get('taskResumeBtn').disabled).toBe(false);
    h.app.sessions.set('a', { mode: 'shell' });
    expect(h.app.openTaskOptions('a')).toBe(false);
    expect(h.app._apiJson.mock.calls).toHaveLength(1);
  });
  it('persists explicit criteria, command verification configuration and bounded budgets', async () => {
    const h = harness();
    await h.open();
    h.get('taskObjective').value = 'New objective';
    h.get('taskMaxRuntime').value = '120';
    await h.app.saveTaskConfiguration();
    const [url, options] = h.app._apiJson.mock.calls[1];
    expect(url).toBe('/api/sessions/a/task');
    expect(options.method).toBe('PUT');
    expect(options.body.config).toEqual({ enabled: false, maxContinuations: 3, maxRuntimeMs: 120000 });
    expect(options.body.criteria).toBeUndefined();
    expect(h.app._taskView.state.criteria[1]).toMatchObject({ id: 'command-a', kind: 'command', command: 'npm test' });
    h.get('taskMaxRuntime').value = '0';
    await h.app.saveTaskConfiguration();
    expect(h.app._apiJson).toHaveBeenCalledTimes(2);
  });
  it('sends a config-only patch without resetting exact completed criteria or spent budgets', async () => {
    const restored = initialTaskState();
    restored.objective = 'Ship the verified fix';
    restored.criteria = [
      {
        id: 'custom-command',
        description: 'Unit tests pass',
        kind: 'command',
        command: 'npm test',
        verified: true,
        evidence: { source: 'command', at: 10001, commandHash: 'a'.repeat(64) },
      },
      {
        id: 'custom-manual',
        description: 'Owner approved release',
        kind: 'manual',
        verified: true,
        evidence: { source: 'owner', at: 10002 },
      },
      {
        id: 'custom-lint',
        description: 'Lint checks pass',
        kind: 'command',
        command: 'npm run lint',
        verified: true,
        evidence: { source: 'command', at: 10003, commandHash: 'b'.repeat(64) },
      },
    ];
    restored.config = { enabled: true, maxContinuations: 3, maxRuntimeMs: 900000 };
    restored.outcome = 'unfinished';
    restored.phase = 'watching';
    restored.startedAt = 9000;
    restored.configuredAt = 9000;
    restored.kickoffAt = 9500;
    restored.continuations = 2;
    const controller = new TaskController(
      {
        observe: async () => {
          throw new Error('Config-only updates must not observe the session');
        },
        act: async () => 'not-sent',
        persist: async () => {},
        changed: () => {},
      },
      restored
    );
    const before = controller.getStatus();
    const h = harness(before);
    h.app._apiJson = vi.fn(async (_url, options) =>
      options?.method === 'PUT' ? controller.update(options.body) : controller.getStatus()
    );
    await h.open();
    h.get('taskMaxContinuations').value = '5';

    await h.app.saveTaskConfiguration();

    const body = h.app._apiJson.mock.calls[1][1].body;
    expect(body.objective).toBeUndefined();
    expect(body.criteria).toBeUndefined();
    const after = controller.getStatus();
    expect(after.criteria).toEqual(before.criteria);
    expect(after.criteria.map((criterion) => criterion.id)).toEqual(['custom-command', 'custom-manual', 'custom-lint']);
    expect(after).toMatchObject({
      outcome: 'completed',
      phase: 'completed',
      continuations: 2,
      kickoffAt: 9500,
      config: { enabled: true, maxContinuations: 5, maxRuntimeMs: 900000 },
    });

    h.get('taskManualCriteria').value += '\nSecurity review complete';
    await h.app.saveTaskConfiguration();

    expect(h.app._apiJson.mock.calls[2][1].body.criteria).toBeDefined();
    const afterEdit = controller.getStatus();
    expect(afterEdit).toMatchObject({ outcome: 'unknown', phase: 'watching', continuations: 0 });
    expect(afterEdit.kickoffAt).toBeUndefined();
    expect(afterEdit.criteria.every((criterion) => !criterion.verified)).toBe(true);
    expect(afterEdit.criteria.find((criterion) => criterion.id === 'custom-command')).toMatchObject({
      description: 'Unit tests pass',
      command: 'npm test',
    });
    controller.stop();
  });
  it('submits owner verification only and guards exhausted, blocked and completed actions', async () => {
    const h = harness();
    await h.open();
    const inputs = h.get('taskCriteriaEvidence').querySelectorAll('input');
    expect(inputs[1].disabled).toBe(false);
    inputs[0].checked = true;
    h.get('taskProgressOutcome').value = 'completed';
    await h.app.saveTaskProgress();
    expect(h.app._apiJson.mock.calls[1][1].body.verifiedCriteria).toEqual(['manual-a']);
    for (const outcome of ['completed', 'blocked']) {
      h.app._onSessionTask({ sessionId: 'a', state: { ...state(), outcome } });
      expect(h.get('taskResumeBtn').disabled).toBe(true);
    }
    h.app._onSessionTask({ sessionId: 'a', state: { ...state(), continuations: 3 } });
    await h.app.taskAction('resume');
    expect(h.app._apiJson).toHaveBeenCalledTimes(2);
  });
  it('shows evidence, timestamped bounded history and safe text', async () => {
    const s: any = state();
    s.criteria[0].verified = true;
    s.criteria[0].evidence = { source: 'owner', at: 100000 };
    s.history = Array.from({ length: 30 }, (_, at) => ({ at: 100000 + at, reason: '<img src=x>' }));
    const h = harness(s);
    await h.open();
    expect(h.get('taskCriteriaEvidence').textContent).toContain('Owner verified');
    expect(h.get('taskHistory').children).toHaveLength(20);
    expect(h.get('taskHistory').querySelector('img')).toBeNull();
    expect(h.get('taskLastVerified').textContent).not.toBe('—');
  });
  it('preserves unsaved drafts and ignores events for other owners', async () => {
    const h = harness();
    await h.open();
    h.get('taskObjective').value = 'Unsaved';
    h.app.markTaskDraft();
    h.app._onSessionTask({ sessionId: 'b', state: { ...state(), outcome: 'completed' } });
    expect(h.get('taskOutcome').textContent).toBe('Unknown');
    h.app._onSessionTask({ sessionId: 'a', state: { ...state(), outcome: 'unfinished' } });
    expect(h.get('taskObjective').value).toBe('Unsaved');
    h.app.closeTaskOptions();
    expect(h.get('taskObjective').value).toBe('');
    expect(h.get('taskCriteriaEvidence').children).toHaveLength(0);
  });
  it('aborts replaced reads and rejects delayed query/action replies', async () => {
    const h = harness();
    await h.open();
    const pending: Array<(s: any) => void> = [];
    h.app._apiJson = vi.fn(() => new Promise((resolve) => pending.push(resolve)));
    const readPromise = h.app.loadTaskStatus();
    h.app._onSessionTask({ sessionId: 'a', state: { ...state(), outcome: 'unfinished' } });
    pending[0](state());
    await readPromise;
    expect(h.get('taskOutcome').textContent).toBe('Unfinished');
    const action = h.app.taskAction('resume');
    expect(h.get('taskPauseBtn').disabled).toBe(true);
    h.app.editingSessionId = 'b';
    h.app.openTaskOptions('b');
    pending[2](state());
    await vi.waitFor(() => expect(h.app._taskView.loading).toBe(false));
    pending[1]({ ...state(), outcome: 'completed' });
    await action;
    expect(h.get('taskOutcome').textContent).toBe('Unknown');
    h.app.loadTaskStatus();
    const abort = h.app._apiJson.mock.calls[3][1].signal;
    h.app.closeTaskOptions();
    expect(abort.aborted).toBe(true);
    pending[3](state());
  });
  it('disables all stale controls after failed reads and refreshes after reconnection', async () => {
    const h = harness();
    await h.open();
    h.app._apiJson.mockResolvedValueOnce(null);
    await h.app.loadTaskStatus();
    expect(h.get('taskError').hidden).toBe(false);
    expect(h.get('taskResumeBtn').disabled).toBe(true);
    expect(h.get('taskSettings').disabled).toBe(true);
    expect(read('app.js')).toContain("[SSE_EVENTS.SESSION_TASK, '_onSessionTask']");
    expect(read('app.js')).toContain('if (this._taskView) void this.loadTaskStatus?.();');
    expect(read('respawn-ui.js')).toContain('this.closeTaskOptions?.();');
  });
  it('allows a zero-continuation initial kickoff, then guards the spent continuation budget', async () => {
    const initial = state();
    initial.config.maxContinuations = 0;
    const h = harness(initial);
    await h.open();
    expect(h.get('taskResumeBtn').disabled).toBe(false);
    h.app._onSessionTask({ sessionId: 'a', state: { ...initial, kickoffAt: Date.now() } });
    expect(h.get('taskResumeBtn').disabled).toBe(true);
    h.app._onSessionTask({ sessionId: 'a', state: { ...state(), reason: 'continuation-accepted' } });
    expect(h.get('taskInputEvidence').textContent).toBe('Structured input acceptance verified');
  });
  it('translates task labels and explanatory copy while leaving user input untouched', () => {
    const h = harness();
    vm.runInContext(read('i18n.js'), h.dom.getInternalVMContext());
    const translator = (h.dom.window as any).CodemanI18n;
    const labels = new Set<string>();
    const walker = h.dom.window.document.createTreeWalker(h.get('task-tab'), h.dom.window.NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node.parentElement?.closest('[data-i18n-skip]')) continue;
      const value = node.textContent?.trim() ?? '';
      if (/[A-Za-z]/.test(value)) labels.add(value);
    }
    for (const label of [
      'Owner verified',
      'Command exit verified',
      'Unverified',
      'Continuation attempt pending; acceptance unverified',
      'Provide an objective, acceptance criteria, and valid task limits',
      'Task action failed. Refresh status before trying again.',
    ])
      labels.add(label);
    translator.configure({ language: 'zh-CN' });
    expect([...labels].filter((label) => translator.t(label) === label)).toEqual([]);
    translator.configure({ language: 'en' });
    expect([...labels].filter((label) => translator.t(label) !== label)).toEqual([]);
  });
});
