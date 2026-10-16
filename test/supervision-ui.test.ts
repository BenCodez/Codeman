/** @fileoverview Task view tests use real markup and isolated owner-bound API fixtures. */
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
    ['a', { mode: 'codex', taskSupported: true }],
    ['b', { mode: 'codex', taskSupported: true }],
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
  it.each(['manual', 'command'] as const)(
    'preserves an exact multiline %s criterion when another criterion of the same kind is edited',
    async (kind) => {
      const initial = state();
      const exact = '  界 first line\r\nsecond line  ';
      initial.criteria = [
        {
          id: 'first',
          kind,
          description: kind === 'manual' ? exact : 'First human label',
          ...(kind === 'command' ? { command: exact } : {}),
          verified: false,
        },
        {
          id: 'other-kind',
          kind: kind === 'manual' ? 'command' : 'manual',
          description: 'Unchanged middle criterion',
          ...(kind === 'manual' ? { command: 'unchanged command' } : {}),
          verified: false,
        },
        {
          id: 'second',
          kind,
          description: kind === 'manual' ? 'Edit this criterion' : 'Second human label',
          ...(kind === 'command' ? { command: 'Edit this criterion' } : {}),
          verified: false,
        },
      ] as any;
      const h = harness(initial);
      await h.open();
      const field = h
        .get('taskCriteriaRows')
        .children[2].querySelector(`[data-task-field="${kind === 'manual' ? 'description' : 'command'}"]`);
      field.value = '  Edited criterion\nwith a second line  ';
      field.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
      await h.app.saveTaskConfiguration();
      const criteria = h.app._apiJson.mock.calls[1][1].body.criteria;
      expect(criteria).toHaveLength(3);
      expect(criteria.map((criterion) => criterion.id)).toEqual(['first', 'other-kind', 'second']);
      expect(criteria[0]).toMatchObject(
        kind === 'manual' ? { description: exact } : { description: 'First human label', command: exact }
      );
      expect(criteria[2]).toMatchObject(
        kind === 'manual'
          ? { description: '  Edited criterion\nwith a second line  ' }
          : { description: 'Second human label', command: '  Edited criterion\nwith a second line  ' }
      );
    }
  );
  it.each(
    (['configuration', 'progress'] as const).flatMap((action) =>
      (['network', '422', '500'] as const).map((failure) => ({ action, failure }))
    )
  )(
    'preserves the full $action draft and focus after actual API $failure, then retries',
    async ({ action, failure }) => {
      const h = harness();
      await h.open();
      const previous = h.app._taskView.state;
      const rows = [...h.get('taskCriteriaRows').children];
      const command = rows[1].querySelector('[data-task-field="command"]') as HTMLTextAreaElement;
      h.get('taskObjective').value = 'Unsaved owner objective';
      rows[0].querySelector('textarea').value = 'Manual draft\n保留';
      command.value = '  printf "你好"\nnext command  ';
      h.get('taskCheckpoint').value = 'Unsaved checkpoint';
      h.get('taskNextAction').value = 'Unsaved next action';
      h.get('taskProgressOutcome').value = 'blocked';
      h.get('taskCriteriaEvidence').querySelector('input').checked = true;
      h.app.markTaskDraft();
      const focused = action === 'configuration' ? command : h.get('taskCheckpoint');
      focused.focus();
      focused.setSelectionRange(2, 5);
      const fetch = vi.fn(async () => {
        if (failure === 'network') throw new Error('Fixture offline');
        return new Response(
          JSON.stringify({ success: false, error: failure === '500' ? 'Persistence failed' : 'Not sent' }),
          { status: Number(failure) }
        );
      });
      h.dom.window.fetch = fetch;
      delete h.app._apiJson; // Exercise the actual API helper's non-2xx/network contract.
      const save = () => (action === 'configuration' ? h.app.saveTaskConfiguration() : h.app.saveTaskProgress());
      await save();
      expect(fetch).toHaveBeenCalledOnce();
      expect(h.app._taskView.state).toBe(previous);
      expect(h.app._taskView.dirty).toBe(true);
      expect(h.app._taskView.busy).toBe(false);
      expect([...h.get('taskCriteriaRows').children]).toEqual(rows);
      expect(h.get('taskObjective').value).toBe('Unsaved owner objective');
      expect(command.value).toBe('  printf "你好"\nnext command  ');
      expect(rows[0].querySelector('textarea').value).toBe('Manual draft\n保留');
      expect(h.get('taskCheckpoint').value).toBe('Unsaved checkpoint');
      expect(h.get('taskNextAction').value).toBe('Unsaved next action');
      expect(h.get('taskProgressOutcome').value).toBe('blocked');
      expect(h.get('taskCriteriaEvidence').querySelector('input').checked).toBe(true);
      expect(h.dom.window.document.activeElement).toBe(focused);
      expect([focused.selectionStart, focused.selectionEnd]).toEqual([2, 5]);
      expect(h.get('taskSettings').disabled).toBe(false);
      expect(h.get('taskProgress').disabled).toBe(false);
      expect(h.app.showToast).toHaveBeenCalledWith('Task action failed. Refresh status before trying again.', 'error');
      const accepted = { ...state(), objective: 'Server accepted objective', checkpoint: 'Server accepted checkpoint' };
      fetch.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: accepted }), { status: 200 }));
      await save();
      expect(fetch).toHaveBeenCalledTimes(2);
      const firstBody = JSON.parse(fetch.mock.calls[0][1].body);
      const retryBody = JSON.parse(fetch.mock.calls[1][1].body);
      expect(retryBody).toEqual(firstBody);
      expect(h.app._taskView.state).toEqual(accepted);
      expect(h.app._taskView.dirty).toBe(true);
      expect(h.get('taskObjective').value).toBe(
        action === 'configuration' ? accepted.objective : 'Unsaved owner objective'
      );
      expect(h.get('taskCheckpoint').value).toBe(action === 'progress' ? accepted.checkpoint : 'Unsaved checkpoint');
    }
  );

  it.each([
    ['local', {}, true],
    ['daemon', { taskSupported: false, codexConfig: { noDaemon: false } }, false],
    ['discovered', { taskSupported: false, codexConfig: { noDaemon: true } }, false],
    ['missing eligibility', { taskSupported: undefined }, false],
    ['docker', { docker: { containerId: 'fixture' } }, false],
    ['owned SSH', { remote: { owned: true } }, true],
    ['implicit owned SSH', { remote: {} }, true],
    ['unowned SSH', { remote: { owned: false } }, false],
  ] as const)(
    'offers layer4 task controls only for local or owned SSH %s location',
    async (_location, location, supported) => {
      const h = harness();
      h.app.sessions.set('a', { mode: 'codex', taskSupported: true, ...location });
      expect(h.app.openTaskOptions('a')).toBe(supported);
      if (supported) await vi.waitFor(() => expect(h.app._taskView.loading).toBe(false));
      expect(h.app._apiJson).toHaveBeenCalledTimes(supported ? 1 : 0);
      expect(h.dom.window.document.querySelector('#sessionOptionsModal [data-tab="task"]').style.display).toBe(
        supported ? '' : 'none'
      );
      if (!supported) expect(h.app._taskView).toBeNull();
    }
  );
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
    const exactCommand = '  printf "界"\r\nnpm run lint  ';
    const restored = initialTaskState();
    restored.objective = 'Ship the verified fix';
    restored.criteria = [
      {
        id: 'custom-command',
        description: 'Unit and lint checks pass\r\n保留说明  ',
        kind: 'command',
        command: exactCommand,
        verified: true,
        evidence: { source: 'command', at: 10001, commandHash: 'a'.repeat(64) },
      },
      {
        id: 'custom-manual',
        description: '  Owner approved UI\r\nOwner approved API  ',
        kind: 'manual',
        verified: true,
        evidence: { source: 'owner', at: 10002 },
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
    expect(h.get('taskCriteriaRows').querySelector('[data-task-field="command"]').value).toBe(
      exactCommand.replace(/\r\n/g, '\n')
    );
    h.get('taskMaxContinuations').value = '5';

    await h.app.saveTaskConfiguration();

    const body = h.app._apiJson.mock.calls[1][1].body;
    expect(body.objective).toBeUndefined();
    expect(body.criteria).toBeUndefined();
    const after = controller.getStatus();
    expect(after.criteria).toEqual(before.criteria);
    expect(after.criteria.map((criterion) => criterion.id)).toEqual(['custom-command', 'custom-manual']);
    expect(after).toMatchObject({
      outcome: 'completed',
      phase: 'completed',
      continuations: 2,
      kickoffAt: 9500,
      config: { enabled: true, maxContinuations: 5, maxRuntimeMs: 900000 },
    });

    h.app.addTaskCriterion('manual');
    h.get('taskCriteriaRows').lastElementChild.querySelector('textarea').value = 'Security review complete';
    await h.app.saveTaskConfiguration();

    expect(h.app._apiJson.mock.calls[2][1].body.criteria).toBeDefined();
    const afterEdit = controller.getStatus();
    expect(afterEdit).toMatchObject({ outcome: 'unknown', phase: 'paused', continuations: 0 });
    expect(afterEdit.kickoffAt).toBeUndefined();
    expect(afterEdit.criteria.every((criterion) => !criterion.verified)).toBe(true);
    expect(afterEdit.criteria.find((criterion) => criterion.id === 'custom-command')).toMatchObject({
      description: 'Unit and lint checks pass\r\n保留说明  ',
      command: exactCommand,
    });
    expect(afterEdit.criteria.filter((criterion) => criterion.kind === 'command')).toHaveLength(1);
    controller.stop();
  });
  it('keeps duplicate criterion identities and interleaved order through removal and a multiline paste', async () => {
    const initial = state();
    initial.criteria = [
      { id: 'manual-first', kind: 'manual', description: 'Same text', verified: false },
      { id: 'command-first', kind: 'command', description: 'Command label', command: 'Same text', verified: false },
      { id: 'manual-second', kind: 'manual', description: 'Same text', verified: false },
      {
        id: 'command-second',
        kind: 'command',
        description: 'Other command label',
        command: 'Same text',
        verified: false,
      },
    ];
    const h = harness(initial);
    await h.open();
    h.get('taskCriteriaRows').firstElementChild.querySelector('button').click();
    h.app.addTaskCriterion('command');
    const added = h.get('taskCriteriaRows').lastElementChild;
    const command = added.querySelector('[data-task-field="command"]');
    command.value = '  printf "你好"\nprintf "second line"  ';
    command.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
    await h.app.saveTaskConfiguration();
    const criteria = h.app._apiJson.mock.calls[1][1].body.criteria;
    expect(criteria.slice(0, 3).map((criterion) => criterion.id)).toEqual([
      'command-first',
      'manual-second',
      'command-second',
    ]);
    expect(criteria[0]).toEqual({
      id: 'command-first',
      kind: 'command',
      description: 'Command label',
      command: 'Same text',
    });
    expect(criteria[2]).toEqual({
      id: 'command-second',
      kind: 'command',
      description: 'Other command label',
      command: 'Same text',
    });
    expect(initial.criteria.map((criterion) => criterion.id)).not.toContain(criteria[3].id);
    expect(criteria[3]).toMatchObject({ kind: 'command', command: command.value, description: command.value });
  });
  it('accepts a deliberate exact command edit while retaining its untouched CRLF description', async () => {
    const initial = state();
    initial.criteria[1].description = '  Label\r\n保留  ';
    initial.criteria[1].command = 'old\r\ncommand';
    const h = harness(initial);
    await h.open();
    const row = h.get('taskCriteriaRows').children[1];
    const command = row.querySelector('[data-task-field="command"]');
    command.value = '  new\n命令  ';
    command.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
    h.app._onSessionTask({ sessionId: 'a', state: { ...initial, outcome: 'unfinished' } });
    expect(h.get('taskCriteriaRows').children[1]).toBe(row);
    await h.app.saveTaskConfiguration();
    expect(h.app._apiJson.mock.calls[1][1].body.criteria[1]).toEqual({
      id: 'command-a',
      kind: 'command',
      description: initial.criteria[1].description,
      command: '  new\n命令  ',
    });
  });
  it('keeps focused criterion fields mounted on status-only updates and refreshes changed criteria', async () => {
    const initial = state();
    const h = harness(initial);
    await h.open();
    const row = h.get('taskCriteriaRows').children[1];
    const command = row.querySelector('[data-task-field="command"]');
    command.focus();
    command.setSelectionRange(2, 5);
    expect(h.app._taskView.dirty).toBe(false);
    h.app._onSessionTask({ sessionId: 'a', state: { ...initial, reason: 'configured', continuations: 1 } });
    expect(h.get('taskCriteriaRows').children[1]).toBe(row);
    expect(h.dom.window.document.activeElement).toBe(command);
    expect([command.selectionStart, command.selectionEnd]).toEqual([2, 5]);
    expect(h.get('taskAttempts').textContent).toBe('1 / 3');
    const changed = structuredClone(initial);
    changed.criteria[1].command = 'new exact command';
    h.app._onSessionTask({ sessionId: 'a', state: changed });
    expect(h.get('taskCriteriaRows').children[1]).not.toBe(row);
    expect(h.get('taskCriteriaRows').children[1].querySelector('[data-task-field="command"]').value).toBe(
      'new exact command'
    );
  });
  it('refuses empty rows and caps additions without dropping existing criterion identities', async () => {
    const initial = state();
    initial.criteria = Array.from({ length: 30 }, (_, index) => ({
      id: `m${index}`,
      description: 'Owner check',
      kind: 'manual',
      verified: false,
    }));
    const h = harness(initial);
    await h.open();
    expect(h.get('taskAddManualCriterion').disabled).toBe(true);
    h.app.addTaskCriterion('manual');
    expect(h.get('taskCriteriaRows').children).toHaveLength(30);
    h.get('taskCriteriaRows').firstElementChild.querySelector('button').click();
    expect(h.get('taskAddCommandCriterion').disabled).toBe(false);
    h.app.addTaskCriterion('manual');
    await h.app.saveTaskConfiguration();
    expect(h.app._apiJson).toHaveBeenCalledOnce();
    expect(h.app.showToast).toHaveBeenCalledWith(
      'Provide an objective, acceptance criteria, and valid task limits',
      'warning'
    );
    expect([...h.get('taskCriteriaRows').children].slice(0, 29).map((row: any) => row.dataset.criterionId)).toEqual(
      initial.criteria.slice(1).map((criterion) => criterion.id)
    );
    h.app.closeTaskOptions();
    expect(h.get('taskCriteriaRows').children).toHaveLength(0);
  });
  it('submits owner verification only and guards unstarted exhausted and completed actions', async () => {
    const h = harness();
    await h.open();
    const inputs = h.get('taskCriteriaEvidence').querySelectorAll('input');
    expect(inputs[1].disabled).toBe(false);
    inputs[0].checked = true;
    h.get('taskProgressOutcome').value = 'completed';
    await h.app.saveTaskProgress();
    expect(h.app._apiJson.mock.calls[1][1].body.verifiedCriteria).toEqual(['manual-a']);
    h.app._onSessionTask({ sessionId: 'a', state: { ...state(), outcome: 'completed' } });
    expect(h.get('taskResumeBtn').disabled).toBe(true);
    h.app._onSessionTask({ sessionId: 'a', state: { ...state(), continuations: 3 } });
    await h.app.taskAction('resume');
    expect(h.app._apiJson).toHaveBeenCalledTimes(2);
  });
  it.each(['owner-input', 'restart'] as const)('saving settings preserves a real %s pause', async (cause) => {
    const restored = initialTaskState();
    Object.assign(restored, {
      objective: 'Review fixture',
      criteria: [{ id: 'review', description: 'Owner review', kind: 'manual', verified: false }],
      checkpoint: 'Review ready',
      nextAction: 'Inspect result',
      outcome: 'unfinished',
      startedAt: 10000,
      configuredAt: 10000,
    });
    restored.config.enabled = true;
    const act = vi.fn(async () => 'sent' as const);
    const controller = new TaskController(
      {
        now: () => 10000,
        observe: async () => ({
          observation: {
            activity: 'completed',
            reason: 'turn-completed',
            at: 10001,
            conversationId: '11111111-2222-3333-4444-555555555555',
            turnId: 'completed-turn',
            processReady: true,
            safeToAct: false,
          },
          commands: new Map(),
        }),
        act,
        persist: async () => {},
        changed: () => {},
      },
      restored
    );
    if (cause === 'owner-input') {
      await controller.progress({ outcome: 'unfinished' });
      controller.noteUserInput();
      await controller.drain();
    }
    const h = harness(controller.getStatus());
    h.app._apiJson = vi.fn(async (_url, options) =>
      options?.method === 'PUT' ? controller.update(options.body) : controller.getStatus()
    );
    await h.open();
    h.get('taskMaxContinuations').value = '5';
    await h.app.saveTaskConfiguration();
    expect(h.app._apiJson.mock.calls[1][1].body).toEqual({
      config: { enabled: true, maxContinuations: 5, maxRuntimeMs: 900000 },
    });
    expect(controller.getStatus()).toMatchObject({
      phase: 'paused',
      reason: cause === 'owner-input' ? 'user-input' : 'restart-requires-resume',
    });
    expect(h.get('taskPhase').textContent).toBe('Paused');
    h.get('taskObjective').value = 'Review the updated objective';
    await h.app.saveTaskConfiguration();
    expect(controller.getStatus().phase).toBe('paused');
    h.app.addTaskCriterion('manual');
    h.get('taskCriteriaRows').lastElementChild.querySelector('textarea').value = 'Security review';
    await h.app.saveTaskConfiguration();
    expect(controller.getStatus().phase).toBe('paused');
    await controller.refresh();
    expect(act).not.toHaveBeenCalled();
    controller.stop();
  });
  it.each([undefined, 'task-conversation'])(
    'shows failed owner verification instead of completing under unverified identity %s',
    async (conversationId) => {
      const persist = vi.fn(async () => {});
      const act = vi.fn(async () => 'not-sent' as const);
      const controller = new TaskController({
        observe: async () => ({
          observation: {
            activity: 'completed',
            reason: 'turn-completed',
            at: 10_000,
            safeToAct: false,
            conversationId,
          },
          commands: new Map(),
        }),
        now: () => 10_000,
        act,
        persist,
        changed: () => {},
      });
      try {
        await controller.update({
          objective: 'Review fixture',
          criteria: [{ id: 'review', kind: 'manual', description: 'Owner review' }],
        });
        const before = controller.getStatus();
        persist.mockClear();
        const h = harness(before);
        h.app._apiJson = vi.fn(async (_url, options) => {
          if (options?.method !== 'POST') return controller.getStatus();
          try {
            return await controller.progress(options.body);
          } catch {
            return null;
          }
        });
        await h.open();
        h.get('taskCriteriaEvidence').querySelector('input').checked = true;
        h.get('taskProgressOutcome').value = 'completed';
        await h.app.saveTaskProgress();
        expect(controller.getStatus()).toEqual(before);
        expect(controller.getStatus().criteria[0].verified).toBe(false);
        expect(h.app._taskView.state).toEqual(before);
        expect(h.get('taskPhase').textContent).toBe('Off');
        expect(h.get('taskError').hidden).toBe(true);
        expect(h.get('taskCriteriaEvidence').querySelector('input').checked).toBe(true);
        expect(h.app.showToast).toHaveBeenCalledWith(
          'Task action failed. Refresh status before trying again.',
          'error'
        );
        expect(persist).not.toHaveBeenCalled();
        expect(act).not.toHaveBeenCalled();
      } finally {
        controller.stop();
        await controller.drain();
      }
    }
  );

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
  it('allows a zero-continuation initial kickoff and observation-only resume afterwards', async () => {
    const initial = state();
    initial.config.maxContinuations = 0;
    const h = harness(initial);
    await h.open();
    expect(h.get('taskResumeBtn').disabled).toBe(false);
    h.app._onSessionTask({ sessionId: 'a', state: { ...initial, kickoffAt: Date.now() } });
    expect(h.get('taskResumeBtn').disabled).toBe(false);
    h.app._onSessionTask({ sessionId: 'a', state: { ...state(), reason: 'continuation-accepted' } });
    expect(h.get('taskInputEvidence').textContent).toBe('Structured input acceptance verified');
  });
  it.each([
    [0, 'restart'],
    [3, 'restart'],
    [0, 'owner-input'],
    [3, 'owner-input'],
    [0, 'blocked'],
    [3, 'blocked'],
  ] as const)(
    'resumes observation after %i spent continuations and %s without dispatching input',
    async (limit, cause) => {
      const now = Date.now();
      const restored = initialTaskState();
      Object.assign(restored, {
        objective: 'Observe the accepted task',
        criteria: [{ id: 'owner', description: 'Owner certifies completion', kind: 'manual', verified: false }],
        startedAt: now - 500,
        kickoffAt: 0,
        continuations: limit,
        outcome: cause === 'blocked' ? 'blocked' : 'unfinished',
        agentProgressVeto: cause === 'blocked',
      });
      restored.config = { enabled: true, maxContinuations: limit, maxRuntimeMs: 900000 };
      const observe = vi.fn(async () => {
        throw new Error('Observation-only resume must not inspect or dispatch');
      });
      const act = vi.fn(async () => 'sent' as const);
      const controller = new TaskController({ observe, act, persist: async () => {}, changed: () => {} }, restored);
      try {
        if (cause === 'owner-input') {
          controller.noteUserInput();
          await controller.pause();
        }
        const h = harness(controller.getStatus());
        h.app._apiJson = vi.fn(async (_url, options) =>
          options?.method === 'POST' ? controller.resume() : controller.getStatus()
        );
        await h.open();
        expect(h.get('taskResumeBtn').disabled).toBe(false);
        await h.app.taskAction('resume');
        expect(h.app._apiJson.mock.calls[1][0]).toBe('/api/sessions/a/task/resume');
        expect(controller.getStatus()).toMatchObject({ phase: 'watching', continuations: limit, kickoffAt: 0 });
        expect(controller.getStatus().agentProgressVeto).toBeUndefined();
        expect(observe).not.toHaveBeenCalled();
        expect(act).not.toHaveBeenCalled();
        expect(controller.getStatus().criteria[0].verified).toBe(false);
      } finally {
        controller.stop();
      }
    }
  );
  it.each(['runtime', 'in-flight', 'completed'] as const)(
    'refuses observation-only resume with %s veto',
    async (veto) => {
      const initial = {
        ...state(),
        kickoffAt: 0,
        continuations: 3,
        ...(veto === 'runtime' ? { startedAt: Date.now() - 900001 } : {}),
        ...(veto === 'in-flight' ? { inFlight: { key: 'pending', startedAt: Date.now() } } : {}),
        ...(veto === 'completed' ? { outcome: 'completed' } : {}),
      };
      const h = harness(initial);
      await h.open();
      expect(h.get('taskResumeBtn').disabled).toBe(true);
      await h.app.taskAction('resume');
      expect(h.app._apiJson).toHaveBeenCalledOnce();
    }
  );
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
      'Owner acceptance criterion',
      'Command acceptance check',
      'Description',
      'Exact command',
      'Defaults to the command',
      'Remove criterion',
    ])
      labels.add(label);
    translator.configure({ language: 'zh-CN' });
    expect([...labels].filter((label) => translator.t(label) === label)).toEqual([]);
    translator.configure({ language: 'en' });
    expect([...labels].filter((label) => translator.t(label) !== label)).toEqual([]);
  });
});

function enterControlDraft(h: ReturnType<typeof harness>) {
  const rows = [...h.get('taskCriteriaRows').children];
  const manual = rows[0].querySelector('textarea') as HTMLTextAreaElement;
  const command = rows[1].querySelector('[data-task-field="command"]') as HTMLTextAreaElement;
  manual.value = '  Unsaved manual acceptance\n保留  ';
  manual.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
  command.value = '  printf "界"\nnext command  ';
  command.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
  h.get('taskObjective').value = '  Unsaved objective\nsecond line  ';
  h.get('taskEnabled').checked = false;
  h.get('taskMaxContinuations').value = '7';
  h.get('taskMaxRuntime').value = '321';
  h.get('taskCheckpoint').value = '  Unsaved checkpoint\n界  ';
  h.get('taskNextAction').value = '  Unsaved next action\n界  ';
  h.get('taskProgressOutcome').value = 'blocked';
  h.get('taskCriteriaEvidence').querySelector('input').checked = true;
  return { rows, manual, command };
}
function expectControlDraft(h: ReturnType<typeof harness>, draft: ReturnType<typeof enterControlDraft>) {
  expect([...h.get('taskCriteriaRows').children]).toEqual(draft.rows);
  expect(draft.manual.value).toBe('  Unsaved manual acceptance\n保留  ');
  expect(draft.command.value).toBe('  printf "界"\nnext command  ');
  expect(h.get('taskObjective').value).toBe('  Unsaved objective\nsecond line  ');
  expect(h.get('taskEnabled').checked).toBe(false);
  expect(h.get('taskMaxContinuations').value).toBe('7');
  expect(h.get('taskMaxRuntime').value).toBe('321');
  expect(h.get('taskCheckpoint').value).toBe('  Unsaved checkpoint\n界  ');
  expect(h.get('taskNextAction').value).toBe('  Unsaved next action\n界  ');
  expect(h.get('taskProgressOutcome').value).toBe('blocked');
  expect(h.get('taskCriteriaEvidence').querySelector('input').checked).toBe(true);
  expect(h.app._taskView.dirty).toBe(true);
  expect(h.app._taskView.busy).toBe(false);
}
it.each(['pause', 'resume', 'reset'] as const)(
  'successful bodyless %s updates current controls while preserving every unsaved editor field',
  async (action) => {
    const initial = {
      ...state(),
      config: { ...state().config, enabled: true },
      phase: action === 'resume' ? 'paused' : 'watching',
    };
    const h = harness(initial);
    await h.open();
    const draft = enterControlDraft(h);
    const accepted = {
      ...initial,
      phase: action === 'resume' ? 'watching' : action === 'reset' ? 'disabled' : 'paused',
      config: { ...initial.config, enabled: action !== 'reset' },
      reason: { pause: 'owner-paused', resume: 'owner-resumed', reset: 'owner-reset' }[action],
    };
    const fetch = vi.fn(async () => new Response(JSON.stringify({ success: true, data: accepted }), { status: 200 }));
    h.dom.window.fetch = fetch;
    delete h.app._apiJson;
    await h.app.taskAction(action);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe(`/api/sessions/a/task/${action}`);
    expect(fetch.mock.calls[0][1].body).toBeUndefined();
    expectControlDraft(h, draft);
    expect(h.get('taskPhase').textContent).toBe(
      action === 'resume' ? 'Monitoring' : action === 'reset' ? 'Off' : 'Paused'
    );
    expect(h.get('taskPauseBtn').disabled).toBe(action === 'reset');
    expect(h.get('taskResumeBtn').disabled).toBe(false);
    expect(h.app._taskView.state).toEqual(accepted);
  }
);
it.each(['network', '500', 'malformed'] as const)(
  'failed bodyless pause preserves the complete draft after %s',
  async (failure) => {
    const initial = { ...state(), config: { ...state().config, enabled: true }, phase: 'watching' };
    const h = harness(initial);
    await h.open();
    const draft = enterControlDraft(h);
    h.dom.window.fetch = vi.fn(async () => {
      if (failure === 'network') throw new Error('Fixture offline');
      return new Response(failure === 'malformed' ? '{' : JSON.stringify({ success: false }), {
        status: failure === '500' ? 500 : 200,
      });
    });
    delete h.app._apiJson;
    await h.app.taskAction('pause');
    expectControlDraft(h, draft);
    expect(h.get('taskPhase').textContent).toBe('Monitoring');
    expect(h.app.showToast).toHaveBeenCalledWith('Task action failed. Refresh status before trying again.', 'error');
  }
);
it.each(['control', 'save'] as const)(
  'a stale successful %s reply cannot clear a newer draft or replace current server controls',
  async (action) => {
    const initial = { ...state(), config: { ...state().config, enabled: true }, phase: 'watching' };
    const h = harness(initial);
    await h.open();
    const draft = enterControlDraft(h);
    let release!: (value: unknown) => void;
    h.app._apiJson = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const pending = action === 'control' ? h.app.taskAction('pause') : h.app.saveTaskConfiguration();
    const latest = { ...initial, phase: 'blocked', reason: 'task-evidence-unknown' };
    h.app._onSessionTask({ sessionId: 'a', state: latest });
    release({ ...initial, phase: 'paused', reason: 'owner-paused' });
    await pending;
    expectControlDraft(h, draft);
    expect(h.app._taskView.state).toEqual(latest);
    expect(h.get('taskPhase').textContent).toBe('Blocked');
  }
);
it('clean control replies refresh saved fields without manufacturing a draft', async () => {
  const h = harness({ ...state(), config: { ...state().config, enabled: true }, phase: 'watching' });
  await h.open();
  const accepted = {
    ...state(),
    config: { ...state().config, enabled: true },
    phase: 'paused',
    objective: 'Current server objective',
    checkpoint: 'Current server checkpoint',
  };
  h.app._apiJson.mockResolvedValueOnce(accepted);
  await h.app.taskAction('pause');
  expect(h.app._taskView.dirty).toBe(false);
  expect(h.get('taskObjective').value).toBe(accepted.objective);
  expect(h.get('taskCheckpoint').value).toBe(accepted.checkpoint);
  expect(h.get('taskPhase').textContent).toBe('Paused');
});
it('an unsaved criterion selection alone remains a draft through pause', async () => {
  const initial = { ...state(), config: { ...state().config, enabled: true }, phase: 'watching' };
  const h = harness(initial);
  await h.open();
  const checkbox = h.get('taskCriteriaEvidence').querySelector('input');
  checkbox.checked = true;
  checkbox.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
  expect(h.app._taskView.dirty).toBe(true);
  h.app._apiJson.mockResolvedValueOnce({ ...initial, phase: 'paused' });
  await h.app.taskAction('pause');
  expect(h.get('taskCriteriaEvidence').querySelector('input').checked).toBe(true);
  expect(h.app._taskView.dirty).toBe(true);
});
it('a configuration save acknowledges matching SSE while retaining the independent progress draft', async () => {
  const h = harness();
  await h.open();
  enterControlDraft(h);
  let release!: (value: unknown) => void;
  h.app._apiJson = vi.fn(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const pending = h.app.saveTaskConfiguration();
  const body = h.app._apiJson.mock.calls[0][1].body;
  const accepted = {
    ...state(),
    ...body,
    criteria: body.criteria.map((criterion: any) => ({ ...criterion, verified: false })),
    reason: 'configured',
  };
  h.app._onSessionTask({ sessionId: 'a', state: structuredClone(accepted) });
  release(structuredClone(accepted));
  await pending;
  expect(h.app._taskView.dirty).toBe(true);
  expect(h.get('taskCheckpoint').value).toBe('  Unsaved checkpoint\n界  ');
  expect(h.app._taskView.state).toEqual(accepted);
  expect(h.get('taskObjective').value).toBe(accepted.objective);
});

describe('owner progress text preserves exact whitespace', () => {
  it.each(['untouched', 'edited', 'empty', 'whitespace-only'] as const)(
    'saves %s checkpoint and next action without normalization',
    async (edit) => {
      const initial = {
        ...state(),
        checkpoint: ' \tOwner checkpoint\r\n界\r\n  ',
        nextAction: '\r\n  Next owner action\r\n\t ',
      };
      const h = harness(initial);
      await h.open();
      let checkpoint = initial.checkpoint,
        nextAction = initial.nextAction;
      if (edit !== 'untouched') {
        checkpoint = edit === 'empty' ? '' : edit === 'whitespace-only' ? ' \t\n  ' : ' \nEdited checkpoint 界\n  ';
        nextAction = edit === 'empty' ? '' : edit === 'whitespace-only' ? '\n \t ' : '\t Edited next action\n界  ';
        h.get('taskCheckpoint').value = checkpoint;
        h.get('taskNextAction').value = nextAction;
      }
      const checkbox = h.get('taskCriteriaEvidence').querySelector('input');
      checkbox.checked = true;
      checkbox.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
      h.get('taskProgressOutcome').value = 'blocked';
      await h.app.saveTaskProgress();
      const request = h.app._apiJson.mock.calls[1];
      expect(request[0]).toBe('/api/sessions/a/task/progress');
      expect(request[1].body).toEqual({ outcome: 'blocked', checkpoint, nextAction, verifiedCriteria: ['manual-a'] });
    }
  );
  it('failed progress keeps original CRLF evidence through an exact retry', async () => {
    const initial = { ...state(), checkpoint: '  Checkpoint\r\n界  ', nextAction: '\r\n  Owner next action\t ' };
    const h = harness(initial);
    await h.open();
    h.app._apiJson.mockResolvedValueOnce(null);
    await h.app.saveTaskProgress();
    expect(h.app._taskView.dirty).toBe(true);
    await h.app.saveTaskProgress();
    expect(h.app._apiJson.mock.calls[1][1].body).toEqual(h.app._apiJson.mock.calls[2][1].body);
    expect(h.app._apiJson.mock.calls[2][1].body).toMatchObject({
      checkpoint: initial.checkpoint,
      nextAction: initial.nextAction,
    });
  });
});

describe('owner objective preserves exact whitespace', () => {
  it.each(['untouched', 'remove-boundaries', 'add-boundaries', 'edited-multiline', 'blank'] as const)(
    'saves the exact %s objective without normalizing owner intent',
    async (edit) => {
      const initial = { ...state(), objective: '  Owner objective\r\n界  ' };
      const h = harness(initial);
      await h.open();
      const objective =
        edit === 'remove-boundaries'
          ? 'Owner objective\n界'
          : edit === 'add-boundaries'
            ? ' \t  Owner objective\n界  \n '
            : edit === 'edited-multiline'
              ? '  Edited objective\n 界\n  '
              : edit === 'blank'
                ? ' \t\n '
                : initial.objective;
      if (edit !== 'untouched') {
        h.get('taskObjective').value = objective;
        h.get('taskObjective').dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
        h.app.markTaskDraft(); // JSDOM's outside-only fixture does not execute inline handlers.
      }
      h.get('taskMaxContinuations').value = '5';
      await h.app.saveTaskConfiguration();
      if (edit === 'blank') {
        expect(h.app._apiJson).toHaveBeenCalledOnce();
        expect(h.get('taskObjective').value).toBe(objective);
        expect(h.app._taskView.dirty).toBe(true);
      } else {
        const body = h.app._apiJson.mock.calls[1][1].body;
        expect(body.config.maxContinuations).toBe(5);
        if (edit === 'untouched') expect(Object.hasOwn(body, 'objective')).toBe(false);
        else expect(body.objective).toBe(objective);
      }
    }
  );
  it('retries a rejected boundary-only objective edit with its exact bytes', async () => {
    const h = harness({ ...state(), objective: '  Owner objective  ' });
    await h.open();
    h.get('taskObjective').value = 'Owner objective';
    h.app.markTaskDraft();
    h.app._apiJson.mockResolvedValueOnce(null);
    await h.app.saveTaskConfiguration();
    expect(h.app._taskView.dirty).toBe(true);
    expect(h.get('taskObjective').value).toBe('Owner objective');
    await h.app.saveTaskConfiguration();
    expect(h.app._apiJson.mock.calls[1][1].body.objective).toBe('Owner objective');
    expect(h.app._apiJson.mock.calls[2][1].body).toEqual(h.app._apiJson.mock.calls[1][1].body);
  });
});

describe('task saves retain independent configuration and progress drafts', () => {
  it.each(
    (['configuration', 'progress'] as const).flatMap((first) =>
      (['paused', 'blocked'] as const).map((phase) => ({ first, phase }))
    )
  )('saves $first first without losing the sibling draft while $phase', async ({ first, phase }) => {
    let accepted = {
      ...state(),
      phase,
      objective: '  Original objective\r\n界  ',
      checkpoint: '  Original checkpoint\r\n界  ',
      nextAction: 'Original action\r\n  ',
    };
    accepted.criteria[1].description = '  Original label\r\n界  ';
    const h = harness(accepted);
    await h.open();
    const manual = h.get('taskCriteriaRows').children[0].querySelector('textarea');
    const command = h.get('taskCriteriaRows').children[1].querySelector('[data-task-field="command"]');
    const objective = '  Edited objective\n界  ',
      description = '  Owner criterion draft\n界  ',
      exactCommand = '  printf "界"\nnext command  ';
    h.get('taskObjective').value = objective;
    manual.value = description;
    command.value = exactCommand;
    h.get('taskMaxContinuations').value = '7';
    h.get('taskEnabled').checked = true;
    h.get('taskCheckpoint').value = '  Edited checkpoint\n界  ';
    h.get('taskNextAction').value = '  Edited next action\n  ';
    h.get('taskProgressOutcome').value = 'unfinished';
    const check = h.get('taskCriteriaEvidence').querySelector('input');
    check.checked = true;
    check.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
    const writes: Array<{ method: string; body: any }> = [];
    h.dom.window.fetch = vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      writes.push({ method: options.method, body });
      if (options.method === 'PUT')
        accepted = {
          ...accepted,
          ...body,
          criteria: (body.criteria ?? accepted.criteria).map((criterion) => ({ ...criterion, verified: false })),
        };
      else
        accepted = {
          ...accepted,
          checkpoint: body.checkpoint,
          nextAction: body.nextAction,
          outcome: body.outcome,
          criteria: accepted.criteria.map((criterion) =>
            body.verifiedCriteria.includes(criterion.id) ? { ...criterion, verified: true } : criterion
          ),
        };
      return new Response(JSON.stringify({ success: true, data: accepted }), { status: 200 });
    });
    delete h.app._apiJson;
    const save = (part: string) =>
      part === 'configuration' ? h.app.saveTaskConfiguration() : h.app.saveTaskProgress();
    await save(first);
    expect(h.app._taskView.dirty).toBe(true);
    expect(h.get('taskPhase').textContent).toBe(phase === 'blocked' ? 'Blocked' : 'Paused');
    expect(h.get('taskObjective').value).toBe(objective);
    expect(h.get('taskCriteriaRows').children[0].querySelector('textarea').value).toBe(description);
    expect(h.get('taskCriteriaRows').children[1].querySelector('[data-task-field="command"]').value).toBe(exactCommand);
    expect(h.get('taskCheckpoint').value).toBe('  Edited checkpoint\n界  ');
    expect(h.get('taskNextAction').value).toBe('  Edited next action\n  ');
    expect(h.get('taskCriteriaEvidence').querySelector('input').checked).toBe(true);
    await save(first === 'configuration' ? 'progress' : 'configuration');
    expect(h.app._taskView.dirty).toBe(false);
    expect(writes).toHaveLength(2);
    const config = writes.find((write) => write.method === 'PUT')!.body;
    const progress = writes.find((write) => write.method === 'POST')!.body;
    expect(config.objective).toBe(objective);
    expect(config.criteria[0].description).toBe(description);
    expect(config.criteria[1].command).toBe(exactCommand);
    expect(config.criteria[1].description).toBe('  Original label\r\n界  ');
    expect(progress).toEqual({
      outcome: 'unfinished',
      checkpoint: '  Edited checkpoint\n界  ',
      nextAction: '  Edited next action\n  ',
      verifiedCriteria: ['manual-a'],
    });
  });
  it('keeps a checkbox-only progress draft through configuration save and preserves untouched CRLF at its later save', async () => {
    const initial = { ...state(), checkpoint: '  Original\r\n界  ', nextAction: 'Next\r\n  ' };
    const h = harness(initial);
    await h.open();
    h.get('taskObjective').value = 'New objective';
    const check = h.get('taskCriteriaEvidence').querySelector('input');
    check.checked = true;
    check.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
    h.app._apiJson.mockResolvedValueOnce({ ...initial, objective: 'New objective' });
    await h.app.saveTaskConfiguration();
    expect(h.app._taskView.dirty).toBe(true);
    expect(h.get('taskCriteriaEvidence').querySelector('input').checked).toBe(true);
    await h.app.saveTaskProgress();
    expect(h.app._apiJson.mock.calls[2][1].body).toMatchObject({
      checkpoint: initial.checkpoint,
      nextAction: initial.nextAction,
      verifiedCriteria: ['manual-a'],
    });
    expect(h.app._taskView.dirty).toBe(false);
  });
});
