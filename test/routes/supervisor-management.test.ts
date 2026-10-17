/** Owner HTTP endpoints backed by real private schedule/brain journals; no native effects. */
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { registerSupervisorRoutes } from '../../src/web/routes/supervisor-routes.js';
import { SupervisorAutomationController } from '../../src/supervisor/automation.js';
import { SupervisorAutomationStore } from '../../src/supervisor/automation-store.js';
import { BrainStore } from '../../src/supervisor/brain.js';
import { initialSupervisorState } from '../../src/supervisor/schema.js';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';

let h: RouteTestHarness,
  root: string,
  automation: SupervisorAutomationController,
  store: SupervisorAutomationStore,
  brain: BrainStore;
let result: 'sent' | 'not-sent' | 'unknown';
const dispatch = vi.fn();
const config = () => ({
  checkIns: { enabled: false, intervalMinutes: 60 },
  tasks: [
    {
      id: 'daily-plan',
      name: 'Plan next change',
      instructions: 'Read the brain and inspect workers before a concise plan.',
      enabled: true,
      kind: 'recurring',
      intervalMinutes: 60,
      maxRuns: 3,
    },
  ],
});
beforeEach(async () => {
  vi.stubEnv('CODEMAN_MULTIUSER', '1');
  root = await fs.mkdtemp(join(tmpdir(), 'management-routes-'));
  store = new SupervisorAutomationStore(join(root, 'automation.json'));
  brain = new BrainStore(join(root, 'brains'));
  result = 'sent';
  dispatch.mockReset();
  dispatch.mockImplementation(async (_prompt, current) => {
    expect(current()).toBe(true);
    return result;
  });
  h = await createRouteTestHarness(
    (app, ctx) =>
      registerSupervisorRoutes(app, {
        ...ctx,
        getSupervisorController: () => ({ getStatus: () => initialSupervisorState(ctx._sessionId) }),
        getSupervisorAutomation: () => automation,
        supervisorBrain: {
          read: (_session, current) => brain.read(ctx._sessionId, current),
          replace: (_session, markdown, ifMatch, current) => brain.replace(ctx._sessionId, markdown, ifMatch, current),
        },
      }),
    { authUser: { username: 'alice', role: 'user' } }
  );
  Object.assign(h.ctx._session, { mode: 'codex', owner: 'alice' });
  automation = build();
});
afterEach(async () => {
  automation.stop();
  await automation.drain();
  await store.flush();
  await h.app.close();
  await fs.rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function build() {
  return new SupervisorAutomationController(
    { canRun: () => true, dispatch, persist: (record) => store.save(h.ctx._sessionId, record) },
    h.ctx._sessionId,
    store.get(h.ctx._sessionId)
  );
}
const base = () => `/api/sessions/${h.ctx._sessionId}/supervisor`;
const putConfig = (payload: unknown = config()) =>
  h.app.inject({ method: 'PUT', url: base() + '/automation', payload });
const run = (requestId = 'owner-request-1') =>
  h.app.inject({ method: 'POST', url: base() + '/automation/tasks/daily-plan/run', payload: { requestId } });

it('returns disabled hourly defaults, validates config, and durably acknowledges one exact run across reload', async () => {
  expect((await h.app.inject(base() + '/automation')).json().data).toMatchObject({
    checkIns: { enabled: false, intervalMinutes: 60 },
    tasks: [],
    status: { phase: 'idle' },
  });
  expect((await putConfig()).statusCode).toBe(200);
  const accepted = await run();
  expect(accepted.statusCode).toBe(200);
  expect(accepted.json().data.status.lastRun).toMatchObject({
    requestId: 'owner-request-1',
    taskId: 'daily-plan',
    phase: 'accepted',
    payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(dispatch).toHaveBeenCalledOnce();
  automation.stop();
  await automation.drain();
  store = new SupervisorAutomationStore(join(root, 'automation.json'));
  automation = build();
  expect((await run()).json().data.status.lastRun).toEqual(accepted.json().data.status.lastRun);
  expect(dispatch).toHaveBeenCalledOnce();
  const changed = config();
  changed.tasks[0].instructions = 'Different owner instructions';
  expect((await putConfig(changed)).statusCode).toBe(200);
  expect((await run()).statusCode).toBe(400);
  expect(dispatch).toHaveBeenCalledOnce();
});

it('keeps an unknown matching run ID visible after reload without dispatching it again', async () => {
  await putConfig();
  result = 'unknown';
  const unknown = await run('unresolved-request');
  expect(unknown.statusCode).toBe(200);
  expect(unknown.json().data.status.inFlight).toMatchObject({ requestId: 'unresolved-request', phase: 'unknown' });
  automation.stop();
  await automation.drain();
  automation = build();
  const retry = await run('unresolved-request');
  expect(retry.statusCode).toBe(200);
  expect(retry.json().data.status.inFlight.phase).toBe('unknown');
  expect((await run('different-request')).statusCode).toBe(400);
  expect(dispatch).toHaveBeenCalledOnce();
});

it.each(['config', 'run', 'brain-read', 'brain-write'] as const)(
  'refuses another owner before any %s private journal access',
  async (kind) => {
    Object.assign(h.ctx._session, { owner: 'bob' });
    const response =
      kind === 'config'
        ? await putConfig()
        : kind === 'run'
          ? await run()
          : await h.app.inject({
              method: kind === 'brain-read' ? 'GET' : 'PUT',
              url: base() + '/brain',
              ...(kind === 'brain-write' ? { payload: { markdown: 'foreign', ifMatch: 'a'.repeat(64) } } : {}),
            });
    expect(response.statusCode).toBe(404);
    expect(dispatch).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([]);
  }
);

it('round-trips owner-taught brain instructions with revision CAS and refuses arbitrary paths', async () => {
  const original = (await h.app.inject(base() + '/brain')).json().data;
  expect(original).toMatchObject({ exists: false, markdown: '' });
  const written = await h.app.inject({
    method: 'PUT',
    url: base() + '/brain',
    payload: { markdown: '# Working agreement\nKeep changes focused.', ifMatch: original.revision },
  });
  expect(written.statusCode).toBe(200);
  expect(written.json().data).toMatchObject({ exists: true, markdown: '# Working agreement\nKeep changes focused.' });
  expect(
    (
      await h.app.inject({
        method: 'PUT',
        url: base() + '/brain',
        payload: { markdown: 'stale overwrite', ifMatch: original.revision },
      })
    ).statusCode
  ).toBe(409);
  expect(
    (
      await h.app.inject({
        method: 'PUT',
        url: base() + '/brain',
        payload: { markdown: 'path injection', ifMatch: written.json().data.revision, path: '/outside' },
      })
    ).statusCode
  ).toBe(400);
  expect((await h.app.inject(base() + '/brain')).json().data).toEqual(written.json().data);
});

it('rejects command-like extra config fields and malformed bounded run IDs before any instruction', async () => {
  expect((await putConfig({ ...config(), command: 'shell command' })).statusCode).toBe(400);
  expect((await run('short')).statusCode).toBe(400);
  expect(dispatch).not.toHaveBeenCalled();
});

it('does not ACK or dispatch a schedule when the exact owner/session is replaced during the durable config stage', async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const save = store.save.bind(store);
  vi.spyOn(store, 'save').mockImplementationOnce(async (id, state) => {
    entered.resolve();
    await release.promise;
    return save(id, state);
  });
  const pending = putConfig();
  await entered.promise;
  Object.assign(h.ctx._session, { owner: 'bob' });
  release.resolve();
  expect((await pending).statusCode).toBe(400);
  await automation.tick();
  expect(dispatch).not.toHaveBeenCalled();
  expect(automation.getStatus().tasks[0].enabled).toBe(false);
});

it.each(['é'.repeat(16385), '🙂'.repeat(8193), '\ud800'])(
  'rejects over-byte-budget or malformed UTF-8 memory as invalid input before store access',
  async (markdown) => {
    const replace = vi.spyOn(brain, 'replace');
    const response = await h.app.inject({
      method: 'PUT',
      url: base() + '/brain',
      payload: { markdown, ifMatch: 'a'.repeat(64) },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' });
    expect(replace).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([]);
  }
);

it('accepts exactly 32 KiB of multibyte memory through the real store and preserves revision conflicts', async () => {
  const initial = (await h.app.inject(base() + '/brain')).json().data;
  const markdown = 'é'.repeat(16384);
  expect(Buffer.byteLength(markdown, 'utf8')).toBe(32768);
  const saved = await h.app.inject({
    method: 'PUT',
    url: base() + '/brain',
    payload: { markdown, ifMatch: initial.revision },
  });
  expect(saved.statusCode).toBe(200);
  expect(saved.json().data.markdown).toBe(markdown);
  const conflict = await h.app.inject({
    method: 'PUT',
    url: base() + '/brain',
    payload: { markdown: 'Valid update', ifMatch: initial.revision },
  });
  expect(conflict.statusCode).toBe(409);
  expect((await h.app.inject(base() + '/brain')).json().data).toEqual(saved.json().data);
});

it('classifies invalid store input as 400 while keeping real persistence failures sanitized 500s', async () => {
  const initial = (await h.app.inject(base() + '/brain')).json().data;
  const invalid = await h.app.inject({
    method: 'PUT',
    url: base() + '/brain',
    payload: { markdown: 'invalid\u0000text', ifMatch: initial.revision },
  });
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json().errorCode).toBe('INVALID_INPUT');
  expect((await h.app.inject(base() + '/brain')).json().data).toEqual(initial);
  vi.spyOn(brain, 'replace').mockRejectedValueOnce(new Error('/private/brain-store is read-only'));
  const failed = await h.app.inject({
    method: 'PUT',
    url: base() + '/brain',
    payload: { markdown: 'Valid text', ifMatch: initial.revision },
  });
  expect(failed.statusCode).toBe(500);
  expect(failed.json().errorCode).toBe('OPERATION_FAILED');
  expect(failed.body).not.toContain('/private');
});
