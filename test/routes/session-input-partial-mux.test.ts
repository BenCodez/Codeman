/** Actual tmux split-send failure, with every process launch replaced by a fake. */
import fastifyCookie from '@fastify/cookie';
import { exec } from 'node:child_process';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';

import { Session } from '../../src/session.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { sessionWaits } from '../../src/web/session-wait-registry.js';
import { createMockRouteContext } from '../mocks/index.js';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    exec: vi.fn(),
    execSync: vi.fn(() => ''),
    execFile: vi.fn(() => {
      throw new Error('Unexpected execFile in isolated mux input test');
    }),
    spawn: vi.fn(() => {
      throw new Error('Unexpected spawn in isolated mux input test');
    }),
    spawnSync: vi.fn(() => {
      throw new Error('Unexpected spawnSync in isolated mux input test');
    }),
  };
});

it.each([
  [true, true, false],
  [true, true, true],
  [false, true, false],
  [false, true, true],
  [false, undefined, false],
  [false, undefined, true],
] as const)('never repeats actual partial mux input (tagged=%s,useMux=%s,wait=%s)', async (tagged, useMux, wait) => {
  // Disable only TmuxManager's module-level no-op guard, behind mocked process
  // APIs. Session and route imports retain runtime test mode; HOME is isolated.
  const originalVitest = process.env.VITEST;
  vi.resetModules();
  let TmuxManager: typeof import('../../src/tmux-manager.js').TmuxManager;
  try {
    delete process.env.VITEST;
    ({ TmuxManager } = await import('../../src/tmux-manager.js'));
  } finally {
    if (originalVitest === undefined) delete process.env.VITEST;
    else process.env.VITEST = originalVitest;
  }
  const commands: string[] = [];
  vi.mocked(exec).mockImplementation((...args: unknown[]) => {
    const command = String(args[0]);
    commands.push(command);
    const callback = args.at(-1) as (err: Error | null, stdout: string, stderr: string) => void;
    queueMicrotask(() => callback(command.endsWith(' Enter') ? new Error('Enter dispatch failed') : null, '', ''));
    return { on: vi.fn(), kill: vi.fn(), pid: 12345 } as never;
  });

  const mux = new TmuxManager();
  const app = Fastify({ logger: false });
  try {
    const muxSession = {
      sessionId: 'test-session-1',
      muxName: 'codeman-12345678',
      pid: 12345,
      createdAt: Date.now(),
      workingDir: '/tmp',
      mode: 'claude' as const,
      attached: true,
    };
    mux.registerSession(muxSession);
    const session = new Session({
      id: muxSession.sessionId,
      workingDir: '/tmp',
      mode: 'claude',
      mux,
      muxSession,
      useMux: true,
    });
    const directWrite = vi.fn();
    (session as unknown as { ptyProcess: unknown }).ptyProcess = { write: directWrite };
    const ctx = createMockRouteContext();
    (ctx.sessions as unknown as Map<string, Session>).set(session.id, session);
    await app.register(fastifyCookie);
    registerSessionRoutes(app, ctx as never);
    installRouteErrorHandler(app);
    await app.ready();
    const payload = {
      input: 'keep this literal\r',
      ...(useMux === undefined ? {} : { useMux }),
      ...(tagged ? { clientId: 'browser', seq: 7 } : {}),
      ...(wait ? { wait } : {}),
    };
    const send = () => app.inject({ method: 'POST', url: `/api/sessions/${session.id}/input`, payload });

    const first = await send();
    expect(first.statusCode).toBe(tagged || wait || useMux === undefined ? 500 : 200);
    await vi.waitFor(() => expect(commands).toHaveLength(2));
    expect(first.json()).not.toMatchObject({ retryable: true, notSent: true });
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain('-l');
    expect(commands[0]).toContain('keep this literal');
    expect(commands[1]).toMatch(/ Enter$/);
    expect(session.lastInputSeq('browser')).toBe(tagged ? 7 : 0);
    expect(directWrite).not.toHaveBeenCalled();
    expect(sessionWaits.signalWaiterCount(session.id)).toBe(0);

    if (!tagged) return;
    const retry = await app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/input`,
      payload: { ...payload, wait: false },
    });
    expect(retry.statusCode).toBe(200);
    expect(JSON.parse(String(retry.headers['x-codeman-input-ack']))).toEqual({ seq: 7, dup: true, last: 7 });
    expect(commands).toHaveLength(2);
    expect(directWrite).not.toHaveBeenCalled();
  } finally {
    await app.close();
    mux.destroy();
  }
});

it('never repeats an untagged PTY fallback that throws after bytes land', async () => {
  const app = Fastify({ logger: false });
  const session = new Session({ id: 'test-session-1', workingDir: '/tmp', mode: 'claude', useMux: false });
  const bytes: string[] = [];
  (session as unknown as { ptyProcess: unknown }).ptyProcess = {
    write: (input: string) => {
      bytes.push(input);
      throw new Error('Sanitized partial PTY fixture.');
    },
  };
  try {
    const ctx = createMockRouteContext();
    (ctx.sessions as unknown as Map<string, Session>).set(session.id, session);
    await app.register(fastifyCookie);
    registerSessionRoutes(app, ctx as never);
    installRouteErrorHandler(app);
    const result = await app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/input`,
      payload: { input: 'literal fixture\r' },
    });
    expect(result.statusCode).toBe(500);
    expect(bytes).toEqual(['literal fixture\r']);
    expect(sessionWaits.signalWaiterCount(session.id)).toBe(0);
  } finally {
    (session as unknown as { ptyProcess: unknown }).ptyProcess = null;
    await app.close();
    await session.stop(false);
  }
});
