/** Task APIs reject terminal controls before durable reservations or pane effects. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { TaskController, type TaskObservation } from '../src/supervision/controller.js';
import { initialTaskState, type TaskState } from '../src/supervision/schema.js';
import { TaskStore } from '../src/supervision/store.js';
import { registerTaskRoutes } from '../src/web/routes/task-routes.js';
import { createRouteTestHarness } from './routes/_route-test-utils.js';

const controls = [
  { name: 'NUL', value: '\0' },
  { name: 'ESC', value: '\x1b' },
  { name: 'DEL', value: '\x7f' },
  { name: 'C1', value: '\x9b' },
  { name: 'TAB', value: '\t' },
  { name: 'vertical-tab', value: '\v' },
];
const fields = ['objective', 'checkpoint', 'nextAction', 'description', 'command'] as const;
type Field = (typeof fields)[number];
function invalidPatch(field: Field, value: string) {
  const text = `Before${value}after`;
  if (field === 'objective') return { objective: text };
  if (field === 'checkpoint' || field === 'nextAction')
    return { outcome: 'unfinished', checkpoint: 'Owner checkpoint', nextAction: 'Owner action', [field]: text };
  return {
    criteria: [{ id: 'check', kind: 'command', description: 'Owner check', command: 'npm test', [field]: text }],
  };
}

it.each(fields.flatMap((field) => controls.map((control) => ({ field, ...control }))))(
  'rejects $name in $field before changing durable task authority',
  async ({ field, value }) => {
    const dir = await mkdtemp(join(homedir(), 'task-prompt-control-'));
    const path = join(dir, 'tasks.json');
    const store = new TaskStore(path);
    const observe = vi.fn(
      async (): Promise<TaskObservation> => ({
        observation: {
          activity: 'completed',
          reason: 'turn-completed',
          at: 10001,
          conversationId: '11111111-2222-3333-4444-555555555555',
          turnId: 'fixture-turn',
          submissionKey: 'owner-submission',
          processReady: true,
          safeToAct: false,
        },
        commands: new Map(),
      })
    );
    const persist = vi.fn(async (state: TaskState) => store.save('worker', state));
    const act = vi.fn(async () => 'sent' as const);
    const controller = new TaskController({ now: () => 10000, observe, persist, act, changed: () => {} });
    const h = await createRouteTestHarness((app, ctx) =>
      registerTaskRoutes(app, { ...ctx, getTaskController: () => controller })
    );
    try {
      await controller.update({
        objective: 'Owner objective',
        criteria: [{ id: 'check', description: 'Owner check', kind: 'command', command: 'npm test' }],
        config: { enabled: true },
      });
      await controller.progress({ outcome: 'unfinished', checkpoint: 'Owner checkpoint', nextAction: 'Owner action' });
      const before = controller.getStatus();
      const bytes = await readFile(path);
      observe.mockClear();
      persist.mockClear();
      const progress = field === 'checkpoint' || field === 'nextAction';
      const response = await h.app.inject({
        method: progress ? 'POST' : 'PUT',
        url: `/api/sessions/${h.ctx._sessionId}/task${progress ? '/progress' : ''}`,
        payload: invalidPatch(field, value),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' });
      expect(controller.getStatus()).toEqual(before);
      expect(new TaskStore(path).get('worker')).toEqual(before);
      expect(await readFile(path)).toEqual(bytes);
      expect(observe).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
      expect(act).not.toHaveBeenCalled();
      expect(controller.getStatus().inFlight).toBeUndefined();
      // A rejected edit must neither poison the prompt nor cancel legitimate subsequent owner work.
      await controller.resume();
      expect(act).toHaveBeenCalledOnce();
      expect(controller.getStatus()).toMatchObject({ phase: 'watching', reason: 'kickoff-sent' });
    } finally {
      controller.stop();
      await controller.drain();
      await h.app.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
);

it.each(fields)('preserves an unreadable historical journal containing control text in %s', async (field) => {
  const dir = await mkdtemp(join(homedir(), 'task-old-control-journal-'));
  const path = join(dir, 'tasks.json');
  try {
    const state = {
      ...initialTaskState(),
      objective: 'Owner task',
      criteria: [{ id: 'check', kind: 'command' as const, description: 'Check', command: 'npm test', verified: false }],
    };
    if (field === 'description' || field === 'command') state.criteria[0][field] += '\0';
    else state[field] += '\0';
    const bytes = JSON.stringify({ version: 1, sessions: { worker: state } });
    await writeFile(path, bytes);
    const store = new TaskStore(path);
    expect(store.loadFailed).toBe(true);
    expect(store.get('worker')).toMatchObject({
      config: { enabled: false },
      phase: 'blocked',
      reason: 'persistence-failed',
    });
    await expect(store.save('worker', initialTaskState())).rejects.toThrow('could not be loaded');
    expect(await readFile(path, 'utf8')).toBe(bytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('permits Unicode and ordinary multiline text while keeping manual certification owner-controlled', async () => {
  const act = vi.fn(async () => 'sent' as const);
  const controller = new TaskController({
    now: () => 10000,
    observe: async () => ({
      observation: {
        activity: 'completed',
        reason: 'turn-completed',
        at: 10001,
        conversationId: '11111111-2222-3333-4444-555555555555',
        processReady: true,
        safeToAct: false,
      },
      commands: new Map(),
    }),
    persist: async () => {},
    act,
    changed: () => {},
  });
  try {
    await controller.update({
      objective: 'Review café\n修正 🌱\r\nContinue safely',
      criteria: [
        { id: 'review', description: 'Owner\nreview', kind: 'manual' },
        { id: 'check', description: 'Run\r\nchecks', kind: 'command', command: 'npm test\nprintf done' },
      ],
    });
    await controller.progress({ outcome: 'unfinished', checkpoint: 'Read\ncode', nextAction: 'Review\r\nchange' });
    await controller.resume();
    expect(act).toHaveBeenCalledOnce();
    const prompt = (act.mock.calls as unknown as Array<[string, string, string]>)[0][2];
    expect(prompt).toContain('Review café 修正 🌱 Continue safely');
    expect(prompt).toContain('Read code');
    expect(prompt).toContain('Review change');
    // eslint-disable-next-line no-control-regex -- prove the submitted prompt contains no terminal controls
    expect(prompt).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(controller.getStatus().criteria[0].verified).toBe(false);
    expect(() => controller.progress({ outcome: 'completed', verifiedCriteria: ['review'] }, false)).toThrow(
      'owner authority'
    );
  } finally {
    controller.stop();
    await controller.drain();
  }
});

it.each(['checkpoint', 'nextAction'] as const)(
  'keeps an agent marker with terminal controls in %s attention-only',
  async (field) => {
    const dir = await mkdtemp(join(homedir(), 'task-agent-control-'));
    const path = join(dir, 'tasks.json');
    const store = new TaskStore(path);
    let now = 10000;
    const observation: TaskObservation = {
      observation: {
        activity: 'completed',
        reason: 'turn-completed',
        at: 10001,
        conversationId: '11111111-2222-3333-4444-555555555555',
        turnId: 'fixture-turn',
        submissionKey: 'owner-submission',
        processReady: true,
        safeToAct: false,
      },
      commands: new Map(),
    };
    const act = vi.fn(async () => 'sent' as const);
    const controller = new TaskController({
      now: () => now,
      observe: async () => observation,
      persist: async (state) => store.save('worker', state),
      act,
      changed: () => {},
    });
    try {
      await controller.update({
        objective: 'Owner objective',
        criteria: [{ id: 'review', description: 'Owner review', kind: 'manual' }],
        config: { enabled: true },
      });
      await controller.progress({ outcome: 'unfinished', checkpoint: 'Owner checkpoint', nextAction: 'Owner action' });
      now = 10002;
      observation.marker = {
        key: 'control-marker',
        at: now,
        submissionKey: 'owner-submission',
        progress: {
          outcome: 'unfinished',
          checkpoint: 'Agent checkpoint',
          nextAction: 'Agent action',
          [field]: 'Unsafe\0marker',
        },
      };
      await controller.refresh();
      expect(act).not.toHaveBeenCalled();
      expect(controller.getStatus()).toMatchObject({
        phase: 'paused',
        outcome: 'unknown',
        checkpoint: '',
        nextAction: '',
        agentProgressVeto: true,
        reason: 'task-evidence-unknown',
      });
      expect(controller.getStatus().inFlight).toBeUndefined();
      expect(controller.getStatus().criteria[0].verified).toBe(false);
      expect(new TaskStore(path).get('worker')).toEqual(controller.getStatus());
      await controller.update({ config: { enabled: false } });
      expect(new TaskStore(path).get('worker').agentProgressVeto).toBe(true);
    } finally {
      controller.stop();
      await controller.drain();
      await rm(dir, { recursive: true, force: true });
    }
  }
);
