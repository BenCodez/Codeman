import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const root = resolve(import.meta.dirname, '../src/web/public');
const read = (name: string) => readFileSync(resolve(root, name), 'utf8');
const doms: JSDOM[] = [];
const manager = '11111111-1111-4111-8111-111111111111';
const worker = '22222222-2222-4222-8222-222222222222';
const brain = { revision: 'b'.repeat(64), markdown: 'Remember agents', exists: true, noteCount: 0 };
function snapshot() {
  return {
    revision: 'a'.repeat(64),
    managerSessionId: manager,
    brain,
    agents: [
      {
        sessionId: manager,
        name: 'Manager',
        mode: 'codex',
        remote: false,
        status: 'idle',
        role: '',
        notes: '',
        allowMessages: false,
        enrolled: false,
        pendingMessages: 0,
        managerAvailable: true,
      },
      {
        sessionId: worker,
        name: '<img src=x onerror=alert(1)>',
        mode: 'shell',
        remote: true,
        status: 'busy',
        role: 'Deploy',
        notes: 'Codex inside SSH',
        allowMessages: true,
        enrolled: true,
        pendingMessages: 1,
      },
    ],
  };
}
function harness() {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', url: 'http://localhost/' });
  doms.push(dom);
  const ctx = dom.getInternalVMContext();
  (ctx as any).TextEncoder = TextEncoder;
  vm.runInContext('class CodemanApp {}', ctx);
  vm.runInContext(read('supervisor-brain-ui.js'), ctx);
  vm.runInContext(read('management-ui.js'), ctx);
  const app = vm.runInContext('new CodemanApp()', ctx) as any;
  app._apiJson = vi.fn(async () => snapshot());
  app.showToast = vi.fn();
  dom.window.confirm = vi.fn(() => true);
  const get = (id: string) => dom.window.document.getElementById(id)! as any;
  return { app, dom, get };
}
afterEach(() => {
  for (const dom of doms.splice(0)) dom.window.close();
});

describe('Global management settings', () => {
  it('shows shell agents safely and only eligible manager choices, without any shell input', async () => {
    const { app, get } = harness();
    await app.loadManagementSettings();
    expect(get('managementSettings').disabled).toBe(false);
    expect(app._managementView.rows[1].notes.value).toBe('Codex inside SSH');
    expect(get('managementAgents').querySelector('img')).toBeNull();
    expect(get('managementManager').options.length).toBe(2);
    expect(app._apiJson.mock.calls.map(([path]: [string]) => path)).toEqual(['/api/management']);
    expect(get('managementBrainMarkdown').value).toBe('Remember agents');
  });
  it('keeps oversized notes editable and reports directory capacity before sending a save', async () => {
    const { app, get } = harness();
    await app.loadManagementSettings();
    const row = app._managementView.rows[1];
    app._managementView.rows = Array.from({ length: 20 }, () => ({ ...row, notes: { value: '界'.repeat(2000) } }));
    await app.saveManagementSettings();
    expect(app._apiJson).toHaveBeenCalledTimes(1);
    expect(get('managementSettings').disabled).toBe(false);
    expect(app.showToast).toHaveBeenCalledWith(expect.stringContaining('32 KiB'), 'warning');
  });
  it('saves global edits and grants using the observed revision and retains drafts on conflict', async () => {
    const { app, get } = harness();
    await app.loadManagementSettings();
    app._managementView.rows[1].notes.value = 'Owns SSH work';
    app._apiJson.mockResolvedValueOnce(null);
    await app.saveManagementSettings();
    expect(app._apiJson.mock.calls[1]).toEqual([
      '/api/management',
      {
        method: 'PUT',
        body: {
          ifMatch: 'a'.repeat(64),
          managerSessionId: manager,
          agents: [{ sessionId: worker, role: 'Deploy', notes: 'Owns SSH work', allowMessages: true }],
        },
      },
    ]);
    expect(app._managementView.rows[1].notes.value).toBe('Owns SSH work');
    expect(get('managementSettings').disabled).toBe(true);
    expect(get('managementStatus').textContent).toContain('not confirmed');
  });
  it('ignores a late directory response after settings close', async () => {
    const { app, get } = harness();
    let finish!: (value: unknown) => void;
    app._apiJson.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const pending = app.loadManagementSettings();
    app.closeManagementSettings();
    finish(snapshot());
    await pending;
    expect(app._managementView).toBeNull();
    expect(get('managementSettings').disabled).toBe(true);
  });
  it('saves shared brain independently and keeps an unconfirmed draft', async () => {
    const { app, get } = harness();
    await app.loadManagementSettings();
    get('managementBrainMarkdown').value = 'Manager can update shared memory';
    app._apiJson.mockResolvedValueOnce(null);
    await app.saveManagementBrain();
    expect(app._apiJson.mock.calls[1]).toEqual([
      '/api/management/brain',
      { method: 'PUT', body: { markdown: 'Manager can update shared memory', ifMatch: brain.revision } },
    ]);
    expect(get('managementBrainMarkdown').value).toBe('Manager can update shared memory');
    expect(get('managementBrainSettings').disabled).toBe(true);
  });
  it('clears private enrollment capabilities on close and fences a late enrollment response', async () => {
    const { app, get } = harness();
    await app.loadManagementSettings();
    let finish!: (value: unknown) => void;
    app._apiJson.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const pending = app.openManagementAgent(manager, true);
    app.closeManagementSettings();
    finish({ instructions: 'private fixture capability' });
    await pending;
    expect(get('managementEnrollmentInstructions').value).toBe('');
    expect(get('managementAgentTools').hidden).toBe(true);
  });
  it('queues cooperative messages with an unchanged request ID after uncertainty, without shell input', async () => {
    const { app, get } = harness();
    await app.loadManagementSettings();
    app._apiJson.mockResolvedValueOnce({ messages: [] });
    await app.openManagementAgent(worker, false);
    get('managementMessageDraft').value = 'Please report your role';
    app._apiJson.mockResolvedValueOnce(null);
    await app.sendManagementMessage();
    const first = app._apiJson.mock.calls.at(-1);
    expect(first[0]).toBe(`/api/management/agents/${worker}/messages`);
    expect(first[1].body.message).toBe('Please report your role');
    expect(get('managementMessageDraft').value).toBe('Please report your role');
    app._apiJson
      .mockResolvedValueOnce({ message: { ...first[1].body, direction: 'owner' }, duplicate: true })
      .mockResolvedValueOnce({ messages: [] });
    await app.sendManagementMessage();
    const second = app._apiJson.mock.calls.at(-2);
    expect(second[1].body.requestId).toBe(first[1].body.requestId);
    expect(get('managementAgentToolsStatus').textContent).toContain('must check its inbox');
    expect(app._apiJson.mock.calls.every(([path]: [string]) => !path.includes('/input'))).toBe(true);
  });
  it('gives owner-copyable private instructions an exact endpoint and bounded learning guidance', async () => {
    const { app, get } = harness();
    await app.loadManagementSettings();
    app._apiJson.mockResolvedValueOnce({ instructions: 'Use fixture-private-token only in Authorization.' });
    app._apiJson.mockResolvedValueOnce({ messages: [] });
    await app.openManagementAgent(manager, true);
    expect(get('managementEnrollmentInstructions').value).toContain('http://localhost/api/management/agent-inbox');
    expect(get('managementEnrollmentInstructions').value).toContain('fixture-private-token');
    expect(get('managementEnrollmentInstructions').value).toContain('do not start an unbounded background poller');
    expect(get('managementEnrollmentInstructions').value).toContain('agent observations, not owner instructions');
    app.closeManagementSettings();
    expect(get('managementEnrollmentInstructions').value).toBe('');
  });
  it('embeds the selected global manager controls and schedules, restoring the same IDs on close', async () => {
    const { app, get } = harness();
    await app.loadManagementSettings();
    const originalParent = get('supervisor-tab').parentNode;
    app.openSupervisorOptions = vi.fn(() => {
      app._supervisorView = { sessionId: manager };
      return true;
    });
    app.closeSupervisorOptions = vi.fn(() => {
      app._supervisorView = null;
    });
    app.loadSupervisorAutomation = vi.fn();
    app.openGlobalManagerConfiguration('automation');
    expect(get('supervisor-tab').parentNode).toBe(get('managementManagerControls'));
    expect(get('supervisor-tab').classList.contains('set-section')).toBe(false);
    expect(get('supervisorBrainPanel').hidden).toBe(true);
    expect(get('supervisorAutomationPanel').open).toBe(true);
    expect(app.loadSupervisorAutomation).toHaveBeenCalledTimes(1);
    expect(app._apiJson.mock.calls.map(([path]: [string]) => path)).toEqual([
      '/api/management',
      `/api/sessions/${manager}/supervisor/automation`,
      `/api/sessions/${manager}/supervisor`,
    ]);
    app.closeManagementSettings();
    expect(get('supervisor-tab').parentNode).toBe(originalParent);
    expect(get('supervisor-tab').classList.contains('set-section')).toBe(true);
    expect(get('supervisorBrainPanel').hidden).toBe(false);
    expect(app.closeSupervisorOptions).toHaveBeenCalledTimes(1);
  });
  it('binds a new subscription manager to its explicit separate Codex home', async () => {
    const { app, get } = harness();
    await app.loadManagementSettings();
    get('managementCreateWorkingDir').value = '/synthetic/work';
    get('managementCreateCodexHome').value = '/synthetic/manager-home';
    app._apiJson.mockResolvedValueOnce({ session: { id: manager, mode: 'codex' } });
    await app.createGlobalManagementSession();
    expect(app._apiJson).toHaveBeenLastCalledWith(
      '/api/sessions',
      expect.objectContaining({
        body: expect.objectContaining({ envOverrides: { CODEX_HOME: '/synthetic/manager-home' } }),
      })
    );
  });
  it('rejects an invalid manager home before creating a session', async () => {
    const { app, get } = harness();
    await app.loadManagementSettings();
    get('managementCreateWorkingDir').value = '/synthetic/work';
    get('managementCreateCodexHome').value = 'relative-home';
    await app.createGlobalManagementSession();
    expect(app._apiJson).toHaveBeenCalledTimes(1);
    expect(app.showToast).toHaveBeenCalled();
  });
  it('creates one ordinary local manager candidate from an empty manager picker only on owner action', async () => {
    const { app, get } = harness();
    const empty = { ...snapshot(), managerSessionId: null, agents: [snapshot().agents[1]] };
    app._apiJson.mockResolvedValueOnce(empty);
    await app.loadManagementSettings();
    expect(get('managementManager').options.length).toBe(1);
    expect(app._apiJson).toHaveBeenCalledTimes(1);
    get('managementCreateWorkingDir').value = '/tmp/owner-project';
    const session = { id: manager, mode: 'codex', name: 'Management Codex', remote: undefined, pid: null };
    app._apiJson.mockResolvedValueOnce({ session });
    app._ensureCreatedSessionVisible = vi.fn();
    app.selectSession = vi.fn();
    app.closeAppSettings = vi.fn();
    await app.createGlobalManagementSession();
    expect(app._apiJson.mock.calls[1]).toEqual([
      '/api/sessions',
      {
        method: 'POST',
        body: {
          name: 'Management Codex',
          workingDir: '/tmp/owner-project',
          mode: 'codex',
          codexConfig: { noDaemon: true, noAltScreen: true, dangerouslyBypassApprovals: false },
        },
      },
    ]);
    expect(app._ensureCreatedSessionVisible).toHaveBeenCalledWith(manager, session, undefined);
    expect(app.selectSession).not.toHaveBeenCalled();
    expect(get('managementOpenCreatedSession').hidden).toBe(false);
    await app.createGlobalManagementSession();
    expect(app._apiJson).toHaveBeenCalledTimes(2);
    await app.openCreatedManagementSession();
    expect(app.selectSession).toHaveBeenCalledWith(manager);
    expect(
      app._apiJson.mock.calls.every(
        ([path]: [string]) => !path.includes('/supervisor/start') && !path.includes('/prepare-manager')
      )
    ).toBe(true);
  });
  it('retains the one created session across closing and reopening settings while creation is pending', async () => {
    const { app, get } = harness();
    await app.loadManagementSettings();
    get('managementCreateWorkingDir').value = '/tmp/owner-project';
    let finish!: (value: unknown) => void;
    app._apiJson.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    app._ensureCreatedSessionVisible = vi.fn();
    const pending = app.createGlobalManagementSession();
    app.closeManagementSettings();
    app._apiJson.mockResolvedValueOnce(snapshot());
    await app.loadManagementSettings();
    finish({ session: { id: manager, mode: 'codex', pid: null } });
    await pending;
    expect(get('managementOpenCreatedSession').hidden).toBe(false);
    expect(get('managementCreateStatus').textContent).toContain('session created');
    expect(app._ensureCreatedSessionVisible).toHaveBeenCalledTimes(1);
    expect(app._apiJson.mock.calls.filter(([path]: [string]) => path === '/api/sessions')).toHaveLength(1);
  });
  it('seals an uncertain local session creation and refuses unsafe directory text', async () => {
    const { app, get } = harness();
    await app.loadManagementSettings();
    get('managementCreateWorkingDir').value = 'remote-relative';
    await app.createGlobalManagementSession();
    expect(app._apiJson).toHaveBeenCalledTimes(1);
    get('managementCreateWorkingDir').value = '/tmp/owner-project';
    app._apiJson.mockResolvedValueOnce(null);
    await app.createGlobalManagementSession();
    await app.createGlobalManagementSession();
    expect(app._apiJson).toHaveBeenCalledTimes(2);
    expect(get('managementCreateSettings').disabled).toBe(true);
    expect(get('managementCreateStatus').textContent).toContain('not confirmed');
  });
  it('adopts imported memory from a settings save when the brain editor is pristine', async () => {
    const { app, get } = harness();
    await app.loadManagementSettings();
    const importedBrain = { ...brain, markdown: 'Legacy manager instructions', revision: 'c'.repeat(64) };
    app._apiJson.mockResolvedValueOnce({ ...snapshot(), brain: importedBrain });
    await app.saveManagementSettings();
    expect(get('managementBrainMarkdown').value).toBe(importedBrain.markdown);
    expect(app._managementView.brain.revision).toBe(importedBrain.revision);
  });
  it('preserves an unsaved brain draft and requires reconciliation after settings import newer memory', async () => {
    const { app, get } = harness();
    await app.loadManagementSettings();
    get('managementBrainMarkdown').value = 'Unsaved owner draft';
    app._apiJson.mockResolvedValueOnce({
      ...snapshot(),
      brain: { ...brain, markdown: 'Imported instructions', revision: 'c'.repeat(64) },
    });
    await app.saveManagementSettings();
    expect(get('managementBrainMarkdown').value).toBe('Unsaved owner draft');
    expect(app._managementView.brain).toBeNull();
    expect(get('managementBrainStatus').textContent).toContain('unsaved draft is retained');
    await app.saveManagementBrain();
    expect(app._apiJson).toHaveBeenCalledTimes(2);
  });
  it('does not render late replies into a different selected agent', async () => {
    const { app, get } = harness();
    await app.loadManagementSettings();
    let finish!: (value: unknown) => void;
    app._apiJson.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const pending = app.openManagementAgent(worker, false);
    app._apiJson.mockResolvedValueOnce({ messages: [{ direction: 'agent', message: 'Manager thread' }] });
    await app.openManagementAgent(manager, false);
    finish({ messages: [{ direction: 'agent', message: 'Private worker thread' }] });
    await pending;
    expect(get('managementMessageThread').textContent).toContain('Manager thread');
    expect(get('managementMessageThread').textContent).not.toContain('Private worker');
  });
});

function ownerWorkState(requestId = 'aaaaaaaa-1111-4111-8111-111111111111', phase?: string) {
  const taskId = `owner-work-${requestId}`;
  return {
    checkIns: { enabled: true, intervalMinutes: 60 },
    tasks: [
      { id: taskId, name: '<b>Owner work</b>', instructions: 'Owner work', enabled: true, kind: 'once', maxRuns: 1 },
    ],
    status: {
      phase: 'idle',
      reason: 'configured',
      runs: phase ? [{ taskId, attempts: 1 }] : [],
      ...(phase ? { lastRun: { taskId, phase } } : {}),
    },
  };
}
it('queues objective and criteria through a durable owner task without terminal input', async () => {
  const { app, get, dom } = harness();
  await app.loadManagementSettings();
  get('managementWorkObjective').value = 'Have the API worker implement the change';
  get('managementWorkCriteria').value = 'Tests pass; owner reviews it';
  get('managementWorkStart').checked = false;
  app._apiJson.mockImplementation(async (url: string, options: any) =>
    url.endsWith('/owner-work') ? ownerWorkState(options.body.requestId) : snapshot()
  );
  await app.queueManagementWork();
  const [url, options] = app._apiJson.mock.calls.at(-1);
  expect(url).toBe(`/api/sessions/${manager}/supervisor/automation/owner-work`);
  expect(options.body).toMatchObject({
    objective: 'Have the API worker implement the change',
    completionCriteria: 'Tests pass; owner reviews it',
  });
  expect(dom.window.sessionStorage.getItem(`codeman:managerWorkRequest:${manager}`)).toBeNull();
  expect(get('managementWorkStatus').textContent).toContain('queued');
  expect(get('managementWorkRequests').querySelector('b')).toBeNull();
  expect(get('managementWorkObjective').value).toBe('');
  expect(app._apiJson.mock.calls.every(([path]: [string]) => !path.includes('/input'))).toBe(true);
});
it('retains the same request and draft after uncertain save, without automatically starting or retrying', async () => {
  const { app, get, dom } = harness();
  await app.loadManagementSettings();
  get('managementWorkObjective').value = 'Inspect project changes';
  get('managementWorkCriteria').value = 'Report evidence';
  get('managementWorkStart').checked = false;
  app._apiJson.mockResolvedValue(null);
  await app.queueManagementWork();
  const first = app._apiJson.mock.calls.at(-1)[1].body.requestId;
  expect(dom.window.sessionStorage.getItem(`codeman:managerWorkRequest:${manager}`)).toBe(first);
  expect(get('managementWorkObjective').value).toBe('Inspect project changes');
  await app.queueManagementWork();
  expect(app._apiJson.mock.calls.at(-1)[1].body.requestId).toBe(first);
  expect(get('managementWorkStatus').textContent).toContain('not confirmed');
});
it.each(['accepted', 'refused', 'unknown'])('does not equate %s delivery with completion', async (phase) => {
  const { app, get } = harness();
  await app.loadManagementSettings();
  app._managementView.work = { automation: ownerWorkState(undefined, phase) };
  app._renderManagementWork();
  expect(get('managementWorkRequests').textContent).not.toMatch(/work completed/i);
  if (phase === 'accepted')
    expect(get('managementWorkRequests').textContent).toContain('completion and required owner review are unverified');
});
it('starts a paused configured manager only after explicit work-and-start confirmation', async () => {
  const { app, get, dom } = harness();
  await app.loadManagementSettings();
  get('managementWorkObjective').value = 'Coordinate implementation';
  get('managementWorkCriteria').value = 'Required tests pass';
  dom.window.confirm = vi.fn(() => false);
  const before = app._apiJson.mock.calls.length;
  await app.queueManagementWork();
  expect(app._apiJson.mock.calls).toHaveLength(before);
  dom.window.confirm = vi.fn(() => true);
  app._apiJson.mockImplementation(async (url: string, options: any) => {
    if (url.endsWith('/owner-work')) return ownerWorkState(options.body.requestId);
    if (url.endsWith('/setup-manager'))
      return { sessionId: manager, requestId: options.body.requestId, phase: 'started' };
    return { phase: 'paused', enabled: true, objective: 'Manage owner work' };
  });
  await app.queueManagementWork();
  expect(app._apiJson.mock.calls.some(([url]: [string]) => url.endsWith('/setup-manager'))).toBe(true);
  expect(get('managementWorkStatus').textContent).toContain('Manager started');
});
