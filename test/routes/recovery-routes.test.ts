/** @fileoverview Recovery route contracts using fake controllers and app.inject(); no live sessions or ports. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialRecoveryState, type RecoveryConfig, type RecoveryState } from '../../src/recovery/types.js';
import { RecoveryConfigSchema } from '../../src/recovery/schema.js';
import { registerRecoveryRoutes } from '../../src/web/routes/recovery-routes.js';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';

describe('recovery-routes', () => {
  let harness: RouteTestHarness;
  let state: RecoveryState;
  let supported: boolean;
  let controller: {
    getStatus: ReturnType<typeof vi.fn>;
    inspect: ReturnType<typeof vi.fn>;
    updateConfig: ReturnType<typeof vi.fn>;
    retry: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    restoreMissingRemote: ReturnType<typeof vi.fn>;
  };
  let getController: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.stubEnv('CODEMAN_MULTIUSER', '1');
    state = initialRecoveryState();
    supported = true;
    controller = {
      getStatus: vi.fn(() => structuredClone(state)),
      inspect: vi.fn(async () => structuredClone(state)),
      updateConfig: vi.fn(async (patch: Partial<RecoveryConfig>) => {
        state.config = { ...state.config, ...patch };
        return structuredClone(state);
      }),
      retry: vi.fn(async () => ({ ...structuredClone(state), phase: 'watching' })),
      reset: vi.fn(async () => ({ ...structuredClone(state), attempts: 0, lastReason: 'manual-reset' })),
      restoreMissingRemote: vi.fn(async () => ({ ...structuredClone(state), phase: 'recovering' })),
    };
    getController = vi.fn(() => (supported ? controller : undefined));
    harness = await createRouteTestHarness(
      (app, ctx) => registerRecoveryRoutes(app, { ...ctx, getRecoveryController: getController }),
      { authUser: { username: 'alice', role: 'user' } }
    );
    Object.assign(harness.ctx._session, { mode: 'codex', owner: 'alice' });
  });

  afterEach(async () => {
    await harness.app.close();
    vi.unstubAllEnvs();
  });

  const operations = [
    { method: 'GET' as const, suffix: '' },
    { method: 'PUT' as const, suffix: '/config', payload: { enabled: true } },
    { method: 'POST' as const, suffix: '/retry' },
    { method: 'POST' as const, suffix: '/reset' },
  ];

  for (const operation of operations) {
    it(`${operation.method} ${operation.suffix || 'status'} hides foreign and missing sessions before controller access`, async () => {
      Object.assign(harness.ctx._session, { owner: 'bob' });
      const foreign = await harness.app.inject({
        ...operation,
        url: `/api/sessions/${harness.ctx._sessionId}/recovery${operation.suffix}`,
      });
      const missing = await harness.app.inject({
        ...operation,
        url: `/api/sessions/missing/recovery${operation.suffix}`,
      });
      expect(foreign.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      expect(foreign.json()).toMatchObject({ success: false, errorCode: 'NOT_FOUND' });
      expect(missing.json()).toMatchObject({ success: false, errorCode: 'NOT_FOUND' });
      expect(getController).not.toHaveBeenCalled();
      expect(controller.getStatus).not.toHaveBeenCalled();
      expect(controller.inspect).not.toHaveBeenCalled();
      expect(controller.updateConfig).not.toHaveBeenCalled();
      expect(controller.retry).not.toHaveBeenCalled();
      expect(controller.reset).not.toHaveBeenCalled();
    });

    it(`${operation.method} ${operation.suffix || 'status'} rejects unsupported sessions with a 400 envelope`, async () => {
      supported = false;
      const response = await harness.app.inject({
        ...operation,
        url: `/api/sessions/${harness.ctx._sessionId}/recovery${operation.suffix}`,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' });
    });
  }

  it('inspects disabled recovery state once without dispatching or changing settings', async () => {
    state.activity = 'interrupted';
    state.conversationId = '12345678-1234-1234-1234-123456789abc';
    state.lastReason = 'turn-interrupted';
    const response = await harness.app.inject({ method: 'GET', url: '/api/sessions/test-session-1/recovery' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true, data: state });
    expect(getController).toHaveBeenCalledWith(harness.ctx._session);
    expect(controller.inspect).toHaveBeenCalledExactlyOnceWith();
    expect(controller.getStatus).not.toHaveBeenCalled();
    expect(controller.updateConfig).not.toHaveBeenCalled();
    expect(controller.retry).not.toHaveBeenCalled();
    expect(controller.reset).not.toHaveBeenCalled();
    expect(response.json().data.config.enabled).toBe(false);
  });

  it('updates only the provided config fields and returns the controller state', async () => {
    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api/sessions/test-session-1/recovery/config',
      payload: { enabled: true, detectStalls: true, maxRetries: 2 },
    });
    expect(response.statusCode).toBe(200);
    expect(controller.updateConfig).toHaveBeenCalledExactlyOnceWith({
      enabled: true,
      detectStalls: true,
      maxRetries: 2,
    });
    expect(response.json().data.config).toEqual({
      ...initialRecoveryState().config,
      enabled: true,
      detectStalls: true,
      maxRetries: 2,
    });
  });

  it.each([
    { maxRetries: 0 },
    { maxRetries: 11 },
    { maxRetries: 1.5 },
    { retryDelayMs: 999 },
    { retryDelayMs: 300_001 },
    { maxRetryDelayMs: 3_600_001 },
    { maxRecoveryDurationMs: 9_999 },
    { maxRecoveryDurationMs: 3_600_001 },
    { stalledAfterMs: 9_999 },
    { stalledAfterMs: 3_600_001 },
    { enabled: 'true' },
    { enabled: null },
    { continuationPrompt: 'do something else' },
    { customCommand: 'anything' },
    { conversationId: 'caller-selected' },
  ])('rejects invalid or unknown settings %j before any update', async (payload) => {
    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api/sessions/test-session-1/recovery/config',
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' });
    expect(controller.updateConfig).not.toHaveBeenCalled();
  });

  it('validates retry delays against omitted current settings', async () => {
    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api/sessions/test-session-1/recovery/config',
      payload: { retryDelayMs: 121_000 },
    });
    expect(response.statusCode).toBe(400);
    expect(controller.updateConfig).not.toHaveBeenCalled();
  });

  it('accepts bounded delay updates together', async () => {
    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api/sessions/test-session-1/recovery/config',
      payload: { retryDelayMs: 300_000, maxRetryDelayMs: 300_000 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.config.retryDelayMs).toBe(300_000);
  });

  it('returns 400 when queued controller validation detects a concurrent settings conflict', async () => {
    controller.updateConfig.mockImplementationOnce(async () => {
      RecoveryConfigSchema.parse({ retryDelayMs: 300_000, maxRetryDelayMs: 120_000 });
    });
    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api/sessions/test-session-1/recovery/config',
      payload: { maxRetryDelayMs: 120_000 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' });
  });

  for (const action of ['retry', 'reset'] as const) {
    it(`${action} invokes the real port action and awaits its result`, async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/test-session-1/recovery/${action}`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
      expect(controller[action]).toHaveBeenCalledExactlyOnceWith();
      expect(response.json().data[action === 'retry' ? 'phase' : 'lastReason']).toBe(
        action === 'retry' ? 'watching' : 'manual-reset'
      );
    });

    it(`${action} refuses prompts and caller-selected identities`, async () => {
      for (const payload of [{ prompt: 'continue differently' }, { conversationId: 'someone-else' }]) {
        const response = await harness.app.inject({
          method: 'POST',
          url: `/api/sessions/test-session-1/recovery/${action}`,
          payload,
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' });
      }
      expect(controller[action]).not.toHaveBeenCalled();
    });
  }

  it('delivers an explicit owned missing-remote restore through the controller boundary', async () => {
    Object.assign(harness.ctx._session, {
      remote: { hostId: 'fixture', host: 'fixture.invalid', username: 'runner', remotePath: '/srv/work', owned: true },
    });
    state.lastReason = 'remote-session-missing';
    controller.inspect.mockResolvedValue(structuredClone(state));
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-1/recovery/restore-remote',
    });
    expect(response.statusCode).toBe(200);
    expect(controller.inspect).toHaveBeenCalledExactlyOnceWith();
    expect(controller.restoreMissingRemote).toHaveBeenCalledExactlyOnceWith();
    expect(response.json().data.phase).toBe('recovering');
  });

  it('refuses foreign, local, live, and caller-parameterized remote restores', async () => {
    for (const remote of [undefined, { owned: false }, { owned: true }]) {
      Object.assign(harness.ctx._session, { remote });
      state.lastReason = remote?.owned ? 'turn-running' : 'remote-session-missing';
      controller.inspect.mockResolvedValue(structuredClone(state));
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/test-session-1/recovery/restore-remote',
      });
      expect(response.statusCode).toBe(remote?.owned ? 409 : 400);
    }
    Object.assign(harness.ctx._session, { remote: { owned: true } });
    const injected = await harness.app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-1/recovery/restore-remote',
      payload: { conversationId: 'caller-selected' },
    });
    expect(injected.statusCode).toBe(400);
    expect(controller.restoreMissingRemote).not.toHaveBeenCalled();
  });
});
