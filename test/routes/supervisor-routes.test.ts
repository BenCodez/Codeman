import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSupervisorRoutes } from '../../src/web/routes/supervisor-routes.js';
import { initialSupervisorState, type SupervisorState } from '../../src/supervisor/schema.js';
import {
  SupervisorController,
  SupervisorValidationError,
  type SupervisorDependencies,
} from '../../src/supervisor/controller.js';
import { initialTaskState } from '../../src/supervision/schema.js';
import { initialRecoveryState } from '../../src/recovery/types.js';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';

describe('supervisor routes', () => {
  let h: RouteTestHarness;
  let controller: any;
  const workerId = '22222222-2222-4222-8222-222222222222';
  const config = {
    objective: 'Coordinate the repair',
    enabled: true,
    workers: [
      {
        sessionId: workerId,
        task: 'Repair the parser',
        criteria: [{ id: 'review', description: 'Owner checks output', kind: 'manual' as const }],
        maxAssignments: 2,
        maxRuntimeMs: 60_000,
      },
    ],
  };
  const actualController = (overrides: Partial<SupervisorDependencies> = {}, restored?: SupervisorState) =>
    new SupervisorController(
      {
        validateWorkers: () => {},
        worker: () => undefined,
        persist: async () => {},
        withLeases: (fn) => fn(),
        leaseHolder: () => undefined,
        startManager: async () => true,
        hasManagerAuthority: () => true,
        prepareManagerAuthority: async () => true,
        validateManagerAuthority: async () => true,
        pauseManager: async () => {},
        resetManager: async () => {},
        changed: () => {},
        ...overrides,
      },
      h.ctx._sessionId,
      restored
    );
  beforeEach(async () => {
    vi.stubEnv('CODEMAN_MULTIUSER', '1');
    controller = {
      getStatus: vi.fn(),
      configure: vi.fn(),
      start: vi.fn(),
      pause: vi.fn(),
      reset: vi.fn(),
      inspectWorkers: vi.fn(async () => []),
      assign: vi.fn(),
      retry: vi.fn(),
      message: vi.fn(),
    };
    h = await createRouteTestHarness(
      (app, ctx) => registerSupervisorRoutes(app, { ...ctx, getSupervisorController: () => controller }),
      { authUser: { username: 'alice', role: 'user' } }
    );
    Object.assign(h.ctx._session, { mode: 'codex', owner: 'alice' });
    const state = initialSupervisorState(h.ctx._sessionId);
    for (const method of ['getStatus', 'configure', 'start', 'pause', 'reset', 'assign', 'retry', 'message'])
      controller[method].mockResolvedValue?.(state);
    controller.getStatus.mockReturnValue(state);
  });
  afterEach(async () => {
    controller.stop?.();
    await h.app.close();
    vi.unstubAllEnvs();
  });

  it.each([
    { prepared: true, ready: true, inspect: false },
    { prepared: { inspectionOnly: true }, ready: false, inspect: true },
    { prepared: false, ready: false, inspect: false },
    { prepared: { inspectionOnly: 'true' }, ready: false, inspect: false },
  ])('reports exact preparation readiness or retained inspection: $prepared', async ({ prepared, ready, inspect }) => {
    const preparation = vi.fn(async () => prepared as never);
    const local = await createRouteTestHarness(
      (app, ctx) =>
        registerSupervisorRoutes(app, {
          ...ctx,
          getSupervisorController: () => controller,
          prepareSupervisorManager: preparation,
        }),
      { authUser: { username: 'alice', role: 'user' } }
    );
    Object.assign(local.ctx._session, { mode: 'codex', owner: 'alice' });
    try {
      const response = await local.app.inject({
        method: 'POST',
        url: `/api/sessions/${local.ctx._sessionId}/supervisor/prepare-manager`,
        payload: { confirmRestrictedManager: true },
      });
      expect(response.statusCode).toBe(ready || inspect ? 200 : 400);
      if (ready || inspect)
        expect(response.json().data).toEqual(
          ready ? { managerReady: true } : { managerReady: false, managerInspectionOnly: true }
        );
      else expect(response.json().success).toBe(false);
      expect(preparation).toHaveBeenCalledOnce();
      expect(controller.start).not.toHaveBeenCalled();
    } finally {
      await local.app.close();
    }
  });

  it('requires authenticated owner access before resolving a controller', async () => {
    Object.assign(h.ctx._session, { owner: 'bob' });
    const res = await h.app.inject({ method: 'GET', url: `/api/sessions/${h.ctx._sessionId}/supervisor` });
    expect(res.statusCode).toBe(404);
  });

  it.each([
    { method: 'PUT' as const, suffix: '' },
    { method: 'POST' as const, suffix: '/start' },
    { method: 'POST' as const, suffix: '/pause' },
    { method: 'POST' as const, suffix: '/reset' },
  ])('preserves foreign-owner 404 for $method $suffix', async ({ method, suffix }) => {
    Object.assign(h.ctx._session, { owner: 'bob' });
    const res = await h.app.inject({
      method,
      url: `/api/sessions/${h.ctx._sessionId}/supervisor${suffix}`,
      ...(method === 'PUT' ? { payload: config } : {}),
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns a sanitized operational failure when valid supervisor persistence fails', async () => {
    controller = actualController({
      persist: async () => {
        throw new Error('/private/supervisors.json is read-only');
      },
    });

    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/sessions/${h.ctx._sessionId}/supervisor`,
      payload: config,
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ success: false, errorCode: 'OPERATION_FAILED' });
    expect(res.body).not.toContain('/private');
    expect(controller.getStatus()).toMatchObject({ phase: 'blocked', reason: 'persistence-failed' });
  });

  it.each(['lease', 'eligibility'] as const)(
    'keeps an intentional %s refusal a sanitized validation failure',
    async (cause) => {
      controller = actualController(
        cause === 'lease'
          ? { leaseHolder: (id) => (id === workerId ? 'another-supervisor' : undefined) }
          : {
              validateWorkers: () => {
                throw new SupervisorValidationError('/private/worker is ineligible');
              },
            }
      );

      const res = await h.app.inject({
        method: 'PUT',
        url: `/api/sessions/${h.ctx._sessionId}/supervisor`,
        payload: config,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' });
      expect(res.body).not.toContain('/private');
    }
  );

  it('keeps an operational worker validation lookup failure a server failure', async () => {
    controller = actualController({
      validateWorkers: () => {
        throw new Error('/private/journal lookup failed');
      },
    });
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/sessions/${h.ctx._sessionId}/supervisor`,
      payload: config,
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().errorCode).toBe('OPERATION_FAILED');
    expect(res.body).not.toContain('/private');
  });

  it('returns an operational failure without replaying an uncertain worker delivery', async () => {
    const taskState = initialTaskState();
    const resume = vi.fn(async () => ({ ...taskState, inFlight: { key: 'possibly-sent', startedAt: Date.now() } }));
    controller = actualController({
      worker: () => ({
        task: {
          getStatus: () => taskState,
          update: async () => taskState,
          resume,
        },
        recovery: {
          getStatus: initialRecoveryState,
          inspect: async () => initialRecoveryState(),
          retry: async () => initialRecoveryState(),
        },
      }),
    });
    await controller.configure(config);
    await controller.start();
    const request = {
      method: 'POST' as const,
      url: `/api/sessions/${h.ctx._sessionId}/supervisor/workers/${workerId}/assign`,
      headers: { 'x-codeman-supervisor-session': h.ctx._sessionId },
      payload: { requestId: 'request-uncertain' },
    };

    const res = await h.app.inject(request);
    expect(res.statusCode).toBe(500);
    expect(res.json().errorCode).toBe('OPERATION_FAILED');
    expect(controller.getStatus()).toMatchObject({
      phase: 'paused',
      reason: 'assign-uncertain',
      inFlight: { requestId: 'request-uncertain' },
      handledRequestIds: [],
    });
    expect((await h.app.inject(request)).statusCode).toBe(400);
    expect(resume).toHaveBeenCalledOnce();
  });

  it('recovers an accepted response after reload while preserving owner, attribution and operation binding', async () => {
    const task = initialTaskState();
    const resume = vi.fn(async () => ({ ...task, phase: 'watching' as const, reason: 'kickoff-sent' }));
    controller = actualController({
      worker: () => ({
        task: { getStatus: () => task, update: async () => task, resume },
        recovery: {
          getStatus: initialRecoveryState,
          inspect: async () => initialRecoveryState(),
          retry: async () => initialRecoveryState(),
        },
      }),
    });
    await controller.configure(config);
    await controller.start();
    const request = {
      method: 'POST' as const,
      url: `/api/sessions/${h.ctx._sessionId}/supervisor/workers/${workerId}/assign`,
      headers: { 'x-codeman-supervisor-session': h.ctx._sessionId },
      payload: { requestId: 'request-accepted-reload' },
    };
    expect((await h.app.inject(request)).statusCode).toBe(200);
    const accepted = controller.getStatus();
    controller.stop();
    const lookup = vi.fn(() => undefined);
    controller = actualController({ worker: lookup }, accepted);
    const duplicate = await h.app.inject(request);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().data).toMatchObject({ phase: 'paused', handledRequestIds: ['request-accepted-reload'] });
    expect((await h.app.inject({ ...request, payload: { requestId: 'request-fresh-reload' } })).statusCode).toBe(400);
    expect((await h.app.inject({ ...request, url: request.url.replace('/assign', '/retry') })).statusCode).toBe(400);
    expect((await h.app.inject({ ...request, url: request.url.replace(workerId, h.ctx._sessionId) })).statusCode).toBe(
      400
    );
    expect((await h.app.inject({ ...request, headers: {} })).statusCode).toBe(403);
    Object.assign(h.ctx._session, { owner: 'bob' });
    expect((await h.app.inject(request)).statusCode).toBe(404);
    expect(lookup).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledOnce();
  });

  it('refuses manager-authored progress instead of rearming a worker or certifying criteria', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/sessions/${h.ctx._sessionId}/supervisor/workers/${workerId}/progress`,
      headers: { 'x-codeman-supervisor-session': h.ctx._sessionId },
      payload: {
        outcome: 'unfinished',
        checkpoint: 'Manager-authored checkpoint',
        nextAction: 'Continue without owner resume',
        verifiedCriteria: ['review'],
      },
    });
    expect(res.statusCode).toBe(404);
    expect(controller.assign).not.toHaveBeenCalled();
    expect(controller.retry).not.toHaveBeenCalled();
  });

  it('treats the supervisor header as attribution, while still owner-scoping the resource', async () => {
    const url = `/api/sessions/${h.ctx._sessionId}/supervisor/workers`;
    expect((await h.app.inject({ method: 'GET', url })).statusCode).toBe(403);
    expect(
      (await h.app.inject({ method: 'GET', url, headers: { 'x-codeman-supervisor-session': 'wrong-session' } }))
        .statusCode
    ).toBe(403);
    const ok = await h.app.inject({
      method: 'GET',
      url,
      headers: { 'x-codeman-supervisor-session': h.ctx._sessionId },
    });
    expect(ok.statusCode).toBe(200);
    Object.assign(h.ctx._session, { owner: 'bob' });
    const foreign = await h.app.inject({
      method: 'GET',
      url,
      headers: { 'x-codeman-supervisor-session': h.ctx._sessionId },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('passes bounded durable request ids to worker assignments and rejects invalid retry ids', async () => {
    const workerId = '22222222-2222-4222-8222-222222222222';
    const headers = { 'x-codeman-supervisor-session': h.ctx._sessionId };
    const assign = await h.app.inject({
      method: 'POST',
      url: `/api/sessions/${h.ctx._sessionId}/supervisor/workers/${workerId}/assign`,
      headers,
      payload: { requestId: 'request-1234' },
    });
    expect(assign.statusCode).toBe(200);
    expect(controller.assign).toHaveBeenCalledWith(workerId, 'request-1234');
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: `/api/sessions/${h.ctx._sessionId}/supervisor/workers/${workerId}/retry`,
          headers,
          payload: { requestId: 'x' },
        })
      ).statusCode
    ).toBe(400);
  });

  it('routes attributed owner messages with exact content and revocable session authority', async () => {
    controller.message.mockImplementationOnce(async (_worker, _request, _message, current) => {
      expect(current()).toBe(true);
      Object.assign(h.ctx._session, { owner: 'bob' });
      expect(current()).toBe(false);
      Object.assign(h.ctx._session, { owner: 'alice' });
      expect(current()).toBe(true);
      return initialSupervisorState(h.ctx._sessionId);
    });
    const response = await h.app.inject({
      method: 'POST',
      url: `/api/sessions/${h.ctx._sessionId}/supervisor/workers/${workerId}/message`,
      headers: { 'x-codeman-supervisor-session': h.ctx._sessionId },
      payload: {
        requestId: 'owner-message-1',
        message: '  Preserve the checkpoint.\nInspect the remaining failure.  ',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(controller.message).toHaveBeenCalledWith(
      workerId,
      'owner-message-1',
      '  Preserve the checkpoint.\nInspect the remaining failure.  ',
      expect.any(Function)
    );
    const current = controller.message.mock.calls[0][3];
    expect(current()).toBe(false);
  });

  it.each(['missing-attribution', 'wrong-attribution', 'foreign-owner'])(
    'refuses a message before controller effects for %s',
    async (kind) => {
      if (kind === 'foreign-owner') Object.assign(h.ctx._session, { owner: 'bob' });
      const response = await h.app.inject({
        method: 'POST',
        url: `/api/sessions/${h.ctx._sessionId}/supervisor/workers/${workerId}/message`,
        headers:
          kind === 'missing-attribution'
            ? {}
            : {
                'x-codeman-supervisor-session': kind === 'wrong-attribution' ? 'another-manager' : h.ctx._sessionId,
              },
        payload: { requestId: 'owner-message-1', message: 'Inspect the checkpoint' },
      });
      expect(response.statusCode).toBe(kind === 'foreign-owner' ? 404 : 403);
      expect(controller.message).not.toHaveBeenCalled();
    }
  );

  it.each([
    { requestId: 'short', message: 'Inspect' },
    { requestId: 'owner-message-1', message: '' },
    { requestId: 'owner-message-1', message: '   ' },
    { requestId: 'owner-message-1', message: 'x'.repeat(4001) },
    { requestId: 'owner-message-1', message: 'unsafe\u001b[3~' },
    { requestId: 'owner-message-1', message: 'Inspect', input: 'raw terminal bytes' },
  ])('rejects malformed or widened owner messages before dispatch: %j', async (payload) => {
    const response = await h.app.inject({
      method: 'POST',
      url: `/api/sessions/${h.ctx._sessionId}/supervisor/workers/${workerId}/message`,
      headers: { 'x-codeman-supervisor-session': h.ctx._sessionId },
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(controller.message).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'retains actual message grants, budgets and request-content bindings: grant=%s',
    async (grant) => {
      const task = initialTaskState();
      Object.assign(task, { phase: 'watching', outcome: 'unfinished', objective: config.workers[0].task });
      task.config.enabled = true;
      const deliverInstruction = vi.fn(async (_message, _attribution, current) => {
        expect(current()).toBe(true);
        return 'sent' as const;
      });
      controller = actualController({
        worker: () => ({
          task: { getStatus: () => task, update: async () => task, resume: async () => task, deliverInstruction },
          recovery: {
            getStatus: initialRecoveryState,
            inspect: async () => initialRecoveryState(),
            retry: async () => initialRecoveryState(),
          },
        }),
      });
      await controller.configure({
        ...config,
        workers: config.workers.map((worker) => ({ ...worker, allowMessages: grant, maxMessages: 1 })),
      });
      await controller.start();
      const request = {
        method: 'POST' as const,
        url: `/api/sessions/${h.ctx._sessionId}/supervisor/workers/${workerId}/message`,
        headers: { 'x-codeman-supervisor-session': h.ctx._sessionId },
        payload: { requestId: 'owner-message-1', message: 'Inspect the checkpoint' },
      };
      const first = await h.app.inject(request);
      expect(first.statusCode).toBe(grant ? 200 : 400);
      if (grant) {
        expect((await h.app.inject(request)).statusCode).toBe(200);
        expect(
          (await h.app.inject({ ...request, payload: { ...request.payload, message: 'Changed instruction' } }))
            .statusCode
        ).toBe(400);
        expect(
          (await h.app.inject({ ...request, payload: { ...request.payload, requestId: 'owner-message-2' } })).statusCode
        ).toBe(400);
        expect(deliverInstruction).toHaveBeenCalledOnce();
      } else expect(deliverInstruction).not.toHaveBeenCalled();
    }
  );

  it('rejects duplicate worker criterion ids before saving the plan', async () => {
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/sessions/${h.ctx._sessionId}/supervisor`,
      payload: {
        objective: 'Coordinate the repair',
        enabled: true,
        workers: [
          {
            sessionId: '22222222-2222-4222-8222-222222222222',
            task: 'Repair the parser',
            criteria: [
              { id: 'tests', description: 'Unit tests pass', kind: 'command', command: 'npm test' },
              { id: 'tests', description: 'Owner checks output', kind: 'manual' },
            ],
            maxAssignments: 2,
            maxRuntimeMs: 60_000,
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(controller.configure).not.toHaveBeenCalled();
  });
});
