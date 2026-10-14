import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { registerTaskRoutes } from '../../src/web/routes/task-routes.js';
import { initialTaskState } from '../../src/supervision/schema.js';
import { TaskController, TaskValidationError } from '../../src/supervision/controller.js';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
describe('task routes ownership and bounded inputs', () => {
  let h: RouteTestHarness;
  let getController: ReturnType<typeof vi.fn>;
  const controller = {
    getStatus: vi.fn(() => initialTaskState()),
    update: vi.fn(async () => initialTaskState()),
    progress: vi.fn(async () => initialTaskState()),
    pause: vi.fn(async () => initialTaskState()),
    resume: vi.fn(async () => initialTaskState()),
    reset: vi.fn(async () => initialTaskState()),
  };
  beforeEach(async () => {
    vi.stubEnv('CODEMAN_MULTIUSER', '1');
    getController = vi.fn(() => controller);
    h = await createRouteTestHarness(
      (app, ctx) => registerTaskRoutes(app, { ...ctx, getTaskController: getController }),
      { authUser: { username: 'alice', role: 'user' } }
    );
    Object.assign(h.ctx._session, { mode: 'codex', owner: 'alice' });
  });
  afterEach(async () => {
    await h.app.close();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });
  for (const op of [
    { method: 'GET', suffix: '' },
    { method: 'PUT', suffix: '', payload: { config: { enabled: true } } },
    { method: 'POST', suffix: '/progress', payload: { outcome: 'unfinished' } },
    { method: 'POST', suffix: '/pause' },
    { method: 'POST', suffix: '/resume' },
    { method: 'POST', suffix: '/reset' },
  ] as const) {
    it(`hides foreign task before ${op.method} ${op.suffix}`, async () => {
      Object.assign(h.ctx._session, { owner: 'bob' });
      const res = await h.app.inject({ ...op, url: `/api/sessions/${h.ctx._sessionId}/task${op.suffix}` });
      expect(res.statusCode).toBe(404);
      expect(getController).not.toHaveBeenCalled();
    });
  }
  it('defaults status off', async () => {
    const res = await h.app.inject({ method: 'GET', url: `/api/sessions/${h.ctx._sessionId}/task` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.config.enabled).toBe(false);
  });
  it('rejects unbounded and unknown config options', async () => {
    for (const config of [{ maxContinuations: 11 }, { maxRuntimeMs: 86400001 }, { executeShell: true }]) {
      const res = await h.app.inject({
        method: 'PUT',
        url: `/api/sessions/${h.ctx._sessionId}/task`,
        payload: { config },
      });
      expect(res.statusCode).toBe(400);
    }
    expect(controller.update).not.toHaveBeenCalled();
  });
  it('rejects command text on owner-verified manual criteria', async () => {
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/sessions/${h.ctx._sessionId}/task`,
      payload: {
        criteria: [{ id: 'review', description: 'Owner review', kind: 'manual', command: 'npm test' }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(controller.update).not.toHaveBeenCalled();
  });
  it.each(['owner-input', 'restart'] as const)('a settings-only PUT keeps a real %s pause', async (cause) => {
    const act = vi.fn(async () => 'sent' as const);
    const deps = {
      now: () => 10000,
      observe: async () => ({
        observation: {
          activity: 'completed' as const,
          reason: 'turn-completed' as const,
          at: 10001,
          conversationId: 'task-conversation',
          turnId: 'completed-turn',
          processReady: true,
          safeToAct: false,
        },
        commands: new Map(),
      }),
      act,
      persist: async () => {},
      changed: () => {},
    };
    let actual = new TaskController(deps);
    await actual.update({
      objective: 'Review',
      criteria: [{ id: 'review', description: 'Owner review', kind: 'manual' }],
      config: { enabled: true },
    });
    await actual.progress({ outcome: 'unfinished', checkpoint: 'Review ready', nextAction: 'Inspect result' });
    if (cause === 'owner-input') {
      actual.noteUserInput();
      await actual.drain();
    } else {
      const restored = actual.getStatus();
      actual.stop();
      actual = new TaskController(deps, restored);
    }
    getController.mockReturnValue(actual);
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/sessions/${h.ctx._sessionId}/task`,
      payload: { config: { enabled: true, maxContinuations: 5 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      phase: 'paused',
      reason: cause === 'owner-input' ? 'user-input' : 'restart-requires-resume',
      config: { enabled: true, maxContinuations: 5 },
    });
    await actual.refresh();
    expect(act).not.toHaveBeenCalled();
    actual.stop();
  });
  it('does not expose internal verification errors', async () => {
    controller.progress.mockRejectedValueOnce(new TaskValidationError('/private/transcript'));
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/sessions/${h.ctx._sessionId}/task/progress`,
      payload: { outcome: 'completed' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('/private');
  });
  it('returns a sanitized operational failure when valid task persistence fails', async () => {
    const actual = new TaskController({
      observe: async () => {
        throw new Error('not used');
      },
      act: async () => 'not-sent',
      persist: async () => {
        throw new Error('/private/tasks.json is read-only');
      },
      changed: () => {},
    });
    getController.mockReturnValueOnce(actual);

    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/sessions/${h.ctx._sessionId}/task`,
      payload: {
        objective: 'Verify persistence handling',
        criteria: [{ id: 'review', description: 'Owner review', kind: 'manual' }],
      },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ success: false, errorCode: 'OPERATION_FAILED' });
    expect(res.body).not.toContain('/private');
    actual.stop();
  });
});
