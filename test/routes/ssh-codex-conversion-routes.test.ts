/** Actual preview/confirm HTTP routes; bounded fake transport and disposable journals only. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerSshCodexConversionRoutes } from '../../src/web/routes/ssh-codex-conversion-routes.js';
const SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  CID = '11111111-2222-4333-8444-555555555555';
const marker = 'CODEMAN_SSH_CODEX_CONVERSION_V1:';
function frame(value: unknown) {
  return { stdout: marker + Buffer.from(JSON.stringify(value)).toString('base64') + '\n' };
}
function nativePreview() {
  const now = Date.now() - 10000;
  return {
    version: 1,
    sessionName: 'codeman-ssh-aaaaaaaa',
    sessionId: '$1',
    paneId: '%1',
    panePid: 101,
    serverPid: 90,
    processStart: '12345',
    cwd: '/fixture/project',
    codexHome: '/fixture/home',
    capturedAt: Date.now(),
    launcher: 'codex-workspace',
    conversations: [
      {
        id: CID,
        modifiedAt: Date.now() - 10000,
        witness: {
          path: '/fixture/home/sessions/rollout.jsonl',
          dev: 1,
          ino: 1,
          size: 100,
          mtimeMs: 1,
          ctimeMs: 1,
          sha256: 'a'.repeat(64),
        },
        rollout:
          [
            { type: 'session_meta', payload: { id: CID, cwd: '/fixture/project' } },
            {
              type: 'turn_context',
              payload: {
                cwd: '/fixture/project',
                model: 'fixture-model',
                approval_policy: 'on-request',
                sandbox_policy: { type: 'workspace-write', network_access: false, writable_roots: [] },
              },
            },
            { type: 'event_msg', payload: { type: 'task_started', turn_id: 'fixture', model_context_window: null } },
            { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'fixture', last_agent_message: null } },
          ]
            .map((row, index) => JSON.stringify({ timestamp: new Date(now + index * 100).toISOString(), ...row }))
            .join('\n') + '\n',
      },
    ],
  };
}
describe('SSH Codex conversion owner controls', () => {
  let root: string,
    h: RouteTestHarness,
    run: ReturnType<typeof vi.fn>,
    replace: ReturnType<typeof vi.fn>,
    generation: number;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'codeman-conversion-route-'));
    generation = 1;
    vi.stubEnv('CODEMAN_MULTIUSER', '1');
    run = vi.fn(async (_command: string, input: string) => {
      const req = JSON.parse(input);
      return req.kind === 'preview'
        ? frame({ status: 'ready', preview: nativePreview() })
        : frame({
            status: 'converted',
            retainedSessionName: req.retainedSessionName,
            replacementPane: { paneId: '%2', panePid: 202, status: 1 },
          });
    });
    replace = vi.fn(async () => {});
    h = await createRouteTestHarness(
      (app, ctx) =>
        registerSshCodexConversionRoutes(
          app,
          { ...ctx, replaceConvertedSession: replace },
          { transport: { run }, journalRoot: root }
        ),
      { sessionId: SID, authUser: { username: 'alice', role: 'user' } }
    );
    Object.assign(h.ctx._session, {
      mode: 'shell',
      owner: 'alice',
      workingDir: '/fixture/project',
      remote: {
        hostId: 'test',
        host: 'example.invalid',
        username: 'owner',
        label: 'Test',
        remotePath: '/fixture/project',
        owned: true,
        commands: { codex: 'codex-workspace' },
      },
      getEnvOverridesForPersist: () => undefined,
      getRecoveryContext: () => ({ generation }),
      convertOwnedRemoteShell: vi.fn(async (options: any) => {
        if (!(await options.prepare())) return { status: 'not-sent' };
        const effect = await options.dispatch(h.ctx._session.remote, options.isCurrent);
        return effect.status === 'converted'
          ? { ...effect, replacement: { id: SID, mode: 'codex', toState: () => ({ id: SID, mode: 'codex' }) } }
          : effect;
      }),
    });
  });
  afterEach(async () => {
    await h.app.close();
    await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  const preview = async () =>
    await h.app.inject({ method: 'POST', url: `/api/sessions/${SID}/codex-conversion/preview`, payload: {} });
  it('requires concrete confirmation and consumes each preview once', async () => {
    const p = (await preview()).json();
    expect(p.success).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(p.data.launcher).toBe('codex-workspace');
    expect(JSON.stringify(p)).not.toContain('task_complete');
    const payload = { confirmationToken: p.data.confirmationToken, conversationId: CID, confirmPreserveShell: true };
    const result = await h.app.inject({
      method: 'POST',
      url: `/api/sessions/${SID}/codex-conversion/confirm`,
      payload,
    });
    expect(result.json().success, JSON.stringify(result.json())).toBe(true);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(join(root, `${SID}.pending.json`), 'utf8')).status).toBe('pending');
    expect(JSON.parse(await readFile(join(root, `${SID}.receipt.json`), 'utf8')).status).toBe('converted');
    await h.app.inject({ method: 'POST', url: `/api/sessions/${SID}/codex-conversion/confirm`, payload });
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('rejects stale input intent, unknown UUID and missing consent before effects', async () => {
    const p = (await preview()).json().data;
    const url = `/api/sessions/${SID}/codex-conversion/confirm`;
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url,
          payload: { confirmationToken: p.confirmationToken, conversationId: CID },
        })
      ).json().success
    ).toBe(false);
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url,
          payload: {
            confirmationToken: p.confirmationToken,
            conversationId: '99999999-2222-4333-8444-555555555555',
            confirmPreserveShell: true,
          },
        })
      ).json().success
    ).toBe(false);
    generation++;
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url,
          payload: { confirmationToken: p.confirmationToken, conversationId: CID, confirmPreserveShell: true },
        })
      ).json().success
    ).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });
  it('rejects agent-attributed conversion even with a current owner preview', async () => {
    const p = (await preview()).json().data;
    const result = await h.app.inject({
      method: 'POST',
      url: `/api/sessions/${SID}/codex-conversion/confirm`,
      headers: { 'x-codeman-supervisor-session': SID },
      payload: { confirmationToken: p.confirmationToken, conversationId: CID, confirmPreserveShell: true },
    });
    expect(result.json().success).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });
  it('hides foreign sessions and refuses unowned shells without SSH', async () => {
    h.ctx._session.owner = 'bob';
    expect((await preview()).statusCode).toBe(404);
    h.ctx._session.owner = 'alice';
    h.ctx._session.remote.owned = false;
    expect((await preview()).json().success).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
  it('keeps uncertain journals sealed and never retries the remote effect', async () => {
    const p = (await preview()).json().data;
    run.mockImplementationOnce(async () => frame({ status: 'unknown' }));
    const result = await h.app.inject({
      method: 'POST',
      url: `/api/sessions/${SID}/codex-conversion/confirm`,
      payload: { confirmationToken: p.confirmationToken, conversationId: CID, confirmPreserveShell: true },
    });
    expect(result.json().success).toBe(false);
    expect(result.json().error).toContain('inspection');
    expect((await preview()).json().success).toBe(false);
    expect(run).toHaveBeenCalledTimes(2);
    expect(replace).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(join(root, `${SID}.pending.json`), 'utf8')).retainedSessionName).toBe(
      p.retainedSessionName
    );
  });
});
