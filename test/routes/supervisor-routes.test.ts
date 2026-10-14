import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSupervisorRoutes } from '../../src/web/routes/supervisor-routes.js';
import { initialSupervisorState } from '../../src/supervisor/schema.js';
import {
  SupervisorController,
  SupervisorValidationError,
  type SupervisorDependencies,
} from '../../src/supervisor/controller.js';
import { TaskValidationError } from '../../src/supervision/controller.js';
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
  const actualController = (overrides: Partial<SupervisorDependencies> = {}) =>
    new SupervisorController(
      {
        validateWorkers: () => {},
        worker: () => undefined,
        persist: async () => {},
        withLeases: (fn) => fn(),
        leaseHolder: () => undefined,
        startManager: async () => true,
        pauseManager: async () => {},
        resetManager: async () => {},
        changed: () => {},
        ...overrides,
      },
      h.ctx._sessionId
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
      report: vi.fn(),
    };
    h = await createRouteTestHarness(
      (app, ctx) => registerSupervisorRoutes(app, { ...ctx, getSupervisorController: () => controller }),
      { authUser: { username: 'alice', role: 'user' } }
    );
    Object.assign(h.ctx._session, { mode: 'codex', owner: 'alice' });
    const state = initialSupervisorState(h.ctx._sessionId);
    for (const method of ['getStatus', 'configure', 'start', 'pause', 'reset', 'assign', 'retry'])
      controller[method].mockResolvedValue?.(state);
    controller.getStatus.mockReturnValue(state);
    controller.report.mockResolvedValue({ version: 1 });
  });
  afterEach(async () => {
    controller.stop?.();
    await h.app.close();
    vi.unstubAllEnvs();
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
          progress: async () => taskState,
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

  it('keeps task evidence refusals in worker progress a sanitized validation failure', async () => {
    controller.report.mockRejectedValueOnce(new TaskValidationError('/private/criterion lacks evidence'));
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/sessions/${h.ctx._sessionId}/supervisor/workers/${workerId}/progress`,
      headers: { 'x-codeman-supervisor-session': h.ctx._sessionId },
      payload: { outcome: 'completed' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBe('INVALID_INPUT');
    expect(res.body).not.toContain('/private');
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

  it('passes bounded durable request ids to worker operations and agent progress cannot gain owner authority', async () => {
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
    const progress = { outcome: 'unfinished', verifiedCriteria: ['command-check'] };
    const report = await h.app.inject({
      method: 'POST',
      url: `/api/sessions/${h.ctx._sessionId}/supervisor/workers/${workerId}/progress`,
      headers,
      payload: progress,
    });
    expect(report.statusCode).toBe(200);
    expect(controller.report).toHaveBeenCalledWith(workerId, progress);
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
