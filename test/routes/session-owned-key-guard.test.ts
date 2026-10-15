/** Named newline keys use the same owner guard without exposing raw broker bytes. */
import fastifyCookie from '@fastify/cookie';
import { execFile } from 'node:child_process';
import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { Session } from '../../src/session.js';
import { hashCodexPrompt } from '../../src/recovery/codex-identity.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { type ApiErrorCode, httpStatusForErrorCode } from '../../src/types.js';
import { createMockRouteContext } from '../mocks/index.js';

vi.mock('node:child_process', async () => ({
  ...(await vi.importActual('node:child_process')),
  execFile: vi.fn(),
}));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.clearAllMocks();
});

async function fixture() {
  const ctx = createMockRouteContext();
  const session = new Session({ id: 'test-session-1', workingDir: '/tmp', mode: 'codex', useMux: false });
  Object.assign(session, { _muxSession: { muxName: 'codeman-key-test' }, ptyProcess: { write: vi.fn() } });
  (ctx.sessions as unknown as Map<string, Session>).set(session.id, session);
  const wrap = vi.fn((): unknown => ({ status: 'framed', data: 'guarded-newline' }));
  Object.assign(ctx.mux, { wrapCodexOwnerInput: wrap });
  const effects: string[][] = [];
  let completion: ((err: Error | null) => void) | undefined;
  let held = false;
  let failure: Error | null = null;
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    if (args[0] !== 'tmux') throw new Error('Unexpected process in isolated key test');
    effects.push(args[1] as string[]);
    const callback = args.at(-1) as (error: Error | null) => void;
    if (held) completion = callback;
    else queueMicrotask(() => callback(failure));
    return { on: vi.fn(), kill: vi.fn(), pid: 12345 } as never;
  });
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  registerSessionRoutes(app, ctx as never);
  installRouteErrorHandler(app);
  app.addHook('preSerialization', (_req, reply, payload: unknown, done) => {
    const result = payload as { success?: boolean; errorCode?: ApiErrorCode };
    if (result?.success === false && result.errorCode && reply.statusCode === 200)
      reply.code(httpStatusForErrorCode(result.errorCode));
    done(null, payload);
  });
  await app.ready();
  cleanups.push(async () => {
    await app.close();
    Object.assign(session, { _muxSession: null, ptyProcess: null });
    await session.stop(false);
  });
  return {
    session,
    wrap,
    effects,
    post: (key = 'S-Enter') =>
      app.inject({ method: 'POST', url: '/api/sessions/test-session-1/send-key', payload: { key } }),
    hold: () => {
      held = true;
    },
    release: () => {
      held = false;
      completion?.(null);
    },
    fail: () => {
      failure = new Error('Isolated uncertain native key');
    },
  };
}

it.each(['S-Enter', 'C-Enter'])('frames %s while tracking only its original line feed', async (key) => {
  const f = await fixture();
  const track = vi.spyOn(f.session as never, '_trackSubmit');
  const result = await f.post(key);
  expect(result.statusCode).toBe(200);
  expect(f.wrap).toHaveBeenCalledExactlyOnceWith(f.session.id, '\n', 'owner-key');
  expect(f.effects).toHaveLength(1);
  expect(f.effects[0].slice(0, 7)).toEqual(['-L', 'codeman', 'send-keys', '-H', '-t', 'codeman-key-test', '67']);
  expect(Buffer.from(f.effects[0].slice(6).map((hex) => parseInt(hex, 16))).toString()).toBe('guarded-newline');
  expect(track).toHaveBeenCalledExactlyOnceWith('\n', { fromUser: true });
});

it.each([{ status: 'refused' }, { status: 'framed' }, Promise.resolve({ status: 'passthrough' })])(
  'certifies a guard refusal as retryable before any native key: %j',
  async (receipt) => {
    const f = await fixture();
    f.wrap.mockReturnValue(receipt);
    const refused = await f.post();
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ retryable: true, notSent: true });
    expect(f.effects).toEqual([]);
    expect(f.session.recoveryInputReserved).toBe(false);
    f.wrap.mockReturnValue({ status: 'framed', data: 'ready-newline' });
    expect((await f.post()).statusCode).toBe(200);
    expect(f.effects).toHaveLength(1);
  }
);

it('never certifies a native key failure as safe to replay', async () => {
  const f = await fixture();
  f.fail();
  const uncertain = await f.post();
  expect(uncertain.statusCode).toBe(500);
  expect(uncertain.json()).not.toMatchObject({ retryable: true, notSent: true });
  expect(f.effects).toHaveLength(1);
  expect(f.session.recoveryInputReserved).toBe(false);
});

it('rejects overlapping keys before encoding a frame that could supersede the first', async () => {
  const f = await fixture();
  f.hold();
  const first = f.post();
  await vi.waitFor(() => expect(f.effects).toHaveLength(1));
  const second = await f.post();
  expect(second.statusCode).toBe(422);
  expect(second.json()).toMatchObject({ retryable: true, notSent: true });
  expect(f.wrap).toHaveBeenCalledOnce();
  f.release();
  expect((await first).statusCode).toBe(200);
  expect((await f.post()).statusCode).toBe(200);
  expect(f.wrap).toHaveBeenCalledTimes(2);
});

it('preserves explicitly unframed legacy newline delivery', async () => {
  const f = await fixture();
  f.wrap.mockReturnValue({ status: 'passthrough' });
  expect((await f.post()).statusCode).toBe(200);
  expect(f.effects).toEqual([['-L', 'codeman', 'send-keys', '-H', '-t', 'codeman-key-test', '0a']]);
});

it('keeps a refused newline out of the draft and drains malformed async formatters', async () => {
  const f = await fixture();
  expect(f.session.write('first', { fromUser: true })).toBe(true);
  f.wrap.mockImplementationOnce(() => Promise.reject(new Error('Isolated malformed key formatter')));
  const refused = await f.post();
  expect(refused.statusCode).toBe(422);
  expect(refused.json()).toMatchObject({ retryable: true, notSent: true });
  expect(f.session.lastSubmitAt).toBe(0);
  expect(f.effects).toHaveLength(0);
  f.wrap.mockReturnValue(Object.assign(Promise.resolve(true), { status: 'passthrough' }));
  expect((await f.post()).statusCode).toBe(422);
  expect(f.effects).toHaveLength(0);
  f.wrap.mockReturnValue({ status: 'framed', data: 'ready-newline' });
  expect((await f.post()).statusCode).toBe(200);
  expect(f.session.write('second\r', { fromUser: true })).toBe(true);
  expect(f.session.getRecoveryContext().submission?.hash).toBe(hashCodexPrompt('first\nsecond'));
});
