/** Actual route admission and durable private-fence stages; all terminal effects are fake. */
import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyReply } from 'fastify';
import fsp from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Session } from '../../src/session.js';
import { httpStatusForErrorCode, type ApiErrorCode } from '../../src/types.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { createMockRouteContext } from '../mocks/index.js';

const stage = vi.hoisted(() => ({
  hold: false,
  entered: undefined as (() => void) | undefined,
  release: undefined as Promise<void> | undefined,
  queued: undefined as (() => void) | undefined,
}));
vi.mock('../../src/web/input-dispatch-queue.js', async (original) => {
  const actual = await original<typeof import('../../src/web/input-dispatch-queue.js')>();
  return {
    ...actual,
    queueInputDispatch: (...args: Parameters<typeof actual.queueInputDispatch>) => {
      const result = actual.queueInputDispatch(...args);
      stage.queued?.();
      return result;
    },
  };
});
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    default: {
      ...actual,
      open: async (...args: Parameters<typeof actual.open>) => {
        const file = await actual.open(...args);
        return new Proxy(file, {
          get(target, key) {
            if (key === 'sync')
              return async () => {
                if (stage.hold && String(args[0]).endsWith('.tmp')) {
                  stage.hold = false;
                  stage.entered?.();
                  await stage.release;
                }
                return target.sync();
              };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    },
  };
});
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: vi.fn(),
}));

let root: string;
let release: (() => void) | undefined;
const cleanup: Array<() => Promise<void>> = [];
beforeEach(async () => {
  root = await fsp.mkdtemp(join(homedir(), 'input-cancellation-'));
  vi.stubEnv('CODEMAN_DATA_DIR', root);
  stage.hold = false;
  stage.queued = undefined;
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    if (args[0] !== 'tmux') throw Error('Unexpected terminal effect');
    (args.at(-1) as (error: Error | null) => void)(null);
    return {} as never;
  });
});
afterEach(async () => {
  release?.();
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  await fsp.rm(root, { recursive: true, force: true });
});
function holdFence() {
  stage.hold = true;
  const entered = new Promise<void>((resolve) => {
    stage.entered = resolve;
  });
  stage.release = new Promise<void>((resolve) => {
    release = resolve;
  });
  return entered;
}
async function fixture(mode: 'codex' | 'claude' = 'codex') {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  const ctx = createMockRouteContext();
  const session = new Session({ id: 'test-session-1', workingDir: root, mode, codexConfig: { noDaemon: true } });
  const write = vi.fn();
  Object.assign(session, { ptyProcess: { write }, _muxSession: { muxName: 'isolated-cancellation' } });
  (ctx.sessions as unknown as Map<string, Session>).set(session.id, session);
  await session.ensureRecoveryIdentityFence();
  const replies = new Map<string, FastifyReply>();
  const completed = new Map<string, (result: { statusCode: number }) => void>();
  app.addHook('onRequest', async (req, reply) => {
    replies.set(String(req.headers['x-stage']), reply);
  });
  registerSessionRoutes(app, ctx as never);
  installRouteErrorHandler(app);
  app.addHook('preSerialization', (req, reply, payload: unknown, done) => {
    const value = payload as { success?: boolean; errorCode?: ApiErrorCode };
    if (value?.success === false && value.errorCode) reply.code(httpStatusForErrorCode(value.errorCode));
    completed.get(String(req.headers['x-stage']))?.({ statusCode: reply.statusCode });
    done(null, payload);
  });
  await app.ready();
  cleanup.push(async () => {
    await app.close();
    Object.assign(session, { ptyProcess: null, _muxSession: null });
    await session.stop(false);
  });
  return {
    session,
    write,
    disconnect: (name: string) => {
      const raw = replies.get(name)!.raw;
      expect(raw.writableFinished).toBe(false);
      raw.emit('close');
    },
    post: (
      name: string,
      path = 'input',
      payload: Record<string, unknown> = { input: name, useMux: false, clientId: name, seq: 1 }
    ) => {
      // A real response-close correctly rejects inject's transport promise. Observe
      // the completed route result independently so the test still awaits cleanup.
      const result = new Promise<{ statusCode: number }>((resolve) => {
        completed.set(name, resolve);
      });
      void app
        .inject({ method: 'POST', url: `/api/sessions/${session.id}/${path}`, headers: { 'x-stage': name }, payload })
        .catch((error: Error & { code?: string }) => {
          if (error.code !== 'LIGHT_ECONNRESET') throw error;
        });
      return result;
    },
  };
}

it.each(['input', 'send-key'])('does not dispatch a disconnected %s after its actual FIFO admission', async (path) => {
  const f = await fixture();
  const entered = holdFence();
  const first = f.post('first');
  await entered;
  const admitted = new Promise<void>((resolve) => {
    stage.queued = resolve;
  });
  const abandoned = f.post(
    'abandoned',
    path,
    path === 'input' ? { input: 'abandoned', useMux: false, clientId: 'abandoned', seq: 1 } : { key: 'S-Enter' }
  );
  await admitted;
  stage.queued = undefined;
  f.disconnect('abandoned');
  expect(f.write).not.toHaveBeenCalled();
  release!();
  expect((await first).statusCode).toBe(200);
  const result = await abandoned;
  expect(result.statusCode).toBe(422);
  expect(f.write.mock.calls).toEqual([['first']]);
  expect(execFile).not.toHaveBeenCalled();
  expect(f.session.hasAppliedInputSeq('abandoned', 1)).toBe(false);
  expect(
    (
      await f.post(
        'abandoned',
        path,
        path === 'input' ? { input: 'abandoned', useMux: false, clientId: 'abandoned', seq: 1 } : { key: 'S-Enter' }
      )
    ).statusCode
  ).toBe(200);
  expect(path === 'input' ? f.write.mock.calls : vi.mocked(execFile).mock.calls).toHaveLength(path === 'input' ? 2 : 1);
});

it.each(['input', 'send-key', 'direct-attach-fence'])(
  'revokes %s while its real private fence acknowledgement is held',
  async (path) => {
    const f = await fixture();
    const entered = holdFence();
    const response = f.post(
      'held',
      path,
      path === 'input' ? { input: 'held', useMux: false, clientId: 'held', seq: 1 } : { key: 'S-Enter' }
    );
    await entered;
    f.disconnect('held');
    release!();
    expect((await response).statusCode).toBe(422);
    expect(f.write).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(f.session.hasAppliedInputSeq('held', 1)).toBe(false);
    expect(
      (
        await f.post(
          'retry',
          path,
          path === 'input' ? { input: 'held', useMux: false, clientId: 'held', seq: 1 } : { key: 'S-Enter' }
        )
      ).statusCode
    ).toBe(200);
    if (path === 'input') expect(f.write).toHaveBeenCalledExactlyOnceWith('held');
    if (path === 'send-key') expect(execFile).toHaveBeenCalledTimes(1);
    if (path === 'direct-attach-fence') expect(f.session.getRecoveryContext().untrackedInput).toBe(true);
  }
);

it('retains an already dispatched byte receipt when the response disconnects at the terminal effect', async () => {
  const f = await fixture();
  f.write.mockImplementationOnce(() => f.disconnect('sealed'));
  const body = { input: 'sealed', useMux: false, clientId: 'sealed', seq: 1 };
  await f.post('sealed', 'input', body);
  expect(f.write).toHaveBeenCalledExactlyOnceWith('sealed');
  expect(f.session.hasAppliedInputSeq('sealed', 1)).toBe(true);
  expect((await f.post('retry', 'input', body)).statusCode).toBe(200);
  expect(f.write).toHaveBeenCalledTimes(1);
});

it('keeps an admitted explicit non-Codex background mux write after its normal response', async () => {
  const f = await fixture('claude');
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const actual = f.session.writeViaMux.bind(f.session);
  const entered = new Promise<void>((resolve) => {
    vi.spyOn(f.session, 'writeViaMux').mockImplementationOnce(async (input, options) => {
      resolve();
      await held;
      return actual(input, options);
    });
  });
  const response = f.post('background', 'input', { input: 'background', useMux: true });
  await entered;
  expect((await response).statusCode).toBe(200);
  expect(f.write).not.toHaveBeenCalled();
  finish();
  await vi.waitFor(() => expect(f.write).toHaveBeenCalledExactlyOnceWith('background'));
});
