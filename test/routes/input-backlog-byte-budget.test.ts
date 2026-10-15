/** Actual HTTP/WS routes share a byte-bounded FIFO; only the held PTY effect is fake. */
import fastifyCookie from '@fastify/cookie';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import WebSocket from 'ws';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { Session } from '../../src/session.js';
import { MAX_INPUT_LENGTH } from '../../src/config/terminal-limits.js';
import { httpStatusForErrorCode, type ApiErrorCode } from '../../src/types.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { registerWsRoutes } from '../../src/web/routes/ws-routes.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { createDeferred, createMockRouteContext } from '../mocks/index.js';

const admission = vi.hoisted(() => ({ queued: undefined as (() => void) | undefined }));
vi.mock('../../src/web/input-dispatch-queue.js', async (original) => {
  const actual = await original<typeof import('../../src/web/input-dispatch-queue.js')>();
  return {
    ...actual,
    queueInputDispatch: (...args: Parameters<typeof actual.queueInputDispatch>) => {
      const result = actual.queueInputDispatch(...args);
      admission.queued?.();
      return result;
    },
  };
});

type Transport = 'http' | 'ws';
const ID = 'byte-budget-session';
const CID = 'original-byte-budget-client';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  admission.queued = undefined;
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
});

async function timely<T>(result: PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(result),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Backpressure was not reported while dispatch was held')), 2000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fixture() {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket);
  const ctx = createMockRouteContext({ sessionId: ID });
  const session = new Session({ id: ID, workingDir: homedir(), mode: 'claude', useMux: false });
  const write = vi.fn();
  Object.assign(session, { ptyProcess: { write } });
  (ctx.sessions as unknown as Map<string, Session>).set(ID, session);
  registerSessionRoutes(app, ctx as never);
  registerWsRoutes(app, ctx as never, () => ({ bindHost: '127.0.0.1', allowedHosts: [], tunnelHost: null }));
  installRouteErrorHandler(app);
  app.addHook('preSerialization', (_req, reply, payload: unknown, done) => {
    const value = payload as { success?: boolean; errorCode?: ApiErrorCode };
    if (value?.success === false && value.errorCode) reply.code(httpStatusForErrorCode(value.errorCode));
    done(null, payload);
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  const sockets: WebSocket[] = [];
  const entered = createDeferred<void>(),
    release = createDeferred<void>();
  const actual = session.writeAsync.bind(session);
  vi.spyOn(session, 'writeAsync').mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return actual(...args);
  });
  cleanup.push(async () => {
    release.resolve();
    for (const socket of sockets) socket.terminate();
    await app.close();
    Object.assign(session, { ptyProcess: null });
    await session.stop(false);
  });
  const post = (input: string, seq: number) =>
    app.inject({
      method: 'POST',
      url: `/api/sessions/${ID}/input`,
      payload: { input, useMux: false, clientId: CID, seq },
    });
  const connect = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${ID}/terminal?cid=socket-${sockets.length}`);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return socket;
  };
  const send = async (transport: Transport, input: string, seq: number) => {
    if (transport === 'http')
      return {
        done: post(input, seq).then((response) => {
          expect(response.statusCode).toBe(200);
        }),
      };
    const socket = await connect();
    const done = new Promise<void>((resolve) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        if (message.t === 'ia' && message.seq === seq) resolve();
      });
    });
    socket.send(JSON.stringify({ t: 'i', d: input, cid: CID, seq }));
    return { done };
  };
  return { session, write, entered, release, post, connect, send };
}

it.each([
  ['http', 'http', 'http'],
  ['ws', 'ws', 'ws'],
  ['http', 'ws', 'http'],
  ['ws', 'http', 'ws'],
] as const)(
  'bounds aggregate UTF-8 bytes across held %s, queued %s and refused %s input',
  async (firstTransport, secondTransport, refusedTransport) => {
    const f = await fixture();
    const firstText = 'a'.repeat(MAX_INPUT_LENGTH / 2 + 1);
    const secondText = 'é'.repeat(MAX_INPUT_LENGTH / 4 - 1);
    expect(Buffer.byteLength(firstText) + Buffer.byteLength(secondText)).toBe(MAX_INPUT_LENGTH - 1);
    const first = await f.send(firstTransport, firstText, 1);
    await f.entered.promise;
    const queued = createDeferred<void>();
    admission.queued = () => queued.resolve();
    const second = await f.send(secondTransport, secondText, 2);
    await queued.promise;
    admission.queued = undefined;
    expect(f.write).not.toHaveBeenCalled();
    if (refusedTransport === 'http') {
      const refused = await timely(f.post('é', 3));
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toMatchObject({ retryable: true, notSent: true });
    } else {
      const socket = await f.connect();
      const messages: unknown[] = [];
      socket.on('message', (raw) => messages.push(JSON.parse(String(raw))));
      const closed = new Promise<{ code: number; reason: string }>((resolve) =>
        socket.once('close', (code, reason) => {
          resolve({ code, reason: reason.toString() });
        })
      );
      socket.send(JSON.stringify({ t: 'i', d: 'é', cid: CID, seq: 3 }));
      await expect(timely(closed)).resolves.toEqual({ code: 4008, reason: 'Input backlog full' });
      expect(messages).toEqual([]);
    }
    expect(f.session.hasAppliedInputSeq(CID, 3)).toBe(false);
    f.release.resolve();
    await Promise.all([first.done, second.done]);
    expect(f.write.mock.calls).toEqual([[firstText], [secondText]]);
    const retry = await f.send(refusedTransport, 'é', 3);
    await retry.done;
    expect(f.write.mock.calls).toEqual([[firstText], [secondText], ['é']]);
    expect(f.session.hasAppliedInputSeq(CID, 3)).toBe(true);
    const duplicate = await f.send('http', 'é', 3);
    await duplicate.done;
    expect(f.write).toHaveBeenCalledTimes(3);
  }
);

it.each(['http', 'ws'] as const)('admits an exact ASCII backlog and preserves FIFO over %s', async (transport) => {
  const f = await fixture();
  const firstText = 'a'.repeat(MAX_INPUT_LENGTH / 2);
  const secondText = 'b'.repeat(MAX_INPUT_LENGTH / 2);
  const first = await f.send(transport, firstText, 1);
  await f.entered.promise;
  const queued = createDeferred<void>();
  admission.queued = () => queued.resolve();
  const second = await f.send(transport, secondText, 2);
  await queued.promise;
  admission.queued = undefined;
  expect(f.write).not.toHaveBeenCalled();
  f.release.resolve();
  await Promise.all([first.done, second.done]);
  expect(f.write.mock.calls).toEqual([[firstText], [secondText]]);
});
