/** @fileoverview Actual HTTP/WS routes retain tagged input when the cached local worker has exited. */
import fastifyCookie from '@fastify/cookie';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Session } from '../../src/session.js';
import type { MuxSession, TerminalMultiplexer } from '../../src/mux-interface.js';
import { ApiErrorCode, httpStatusForErrorCode } from '../../src/types.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { registerWsRoutes } from '../../src/web/routes/ws-routes.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { RemoteWakeRegistry } from '../../src/remote-wake.js';
import { createDeferred, createMockRouteContext } from '../mocks/index.js';

const SID = 'cached-exit-worker';
const CID = 'cached-exit-browser';
let app: FastifyInstance;
let session: Session;
let socket: WebSocket | undefined;
let written: ReturnType<typeof vi.fn>;
let sent: ReturnType<typeof vi.fn>;
let probe: ReturnType<typeof vi.fn>;
let intent: ReturnType<typeof vi.fn>;
let acknowledgements: unknown[];

beforeEach(async () => {
  app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket);
  written = vi.fn();
  sent = vi.fn(async () => true);
  probe = vi.fn(() => {
    throw new Error('Browser input must not synchronously probe tmux');
  });
  session = new Session({
    id: SID,
    workingDir: '/tmp',
    mode: 'codex',
    useMux: true,
    mux: { isAvailable: () => true, sendInput: sent, isPaneDead: probe } as unknown as TerminalMultiplexer,
    muxSession: { muxName: 'codeman-cached-exit', pid: 321 } as MuxSession,
    codexConfig: { noDaemon: true },
  });
  Object.assign(session, { ptyProcess: { write: written } });
  intent = vi.fn();
  session.on('recoveryUserInput', intent);
  const ctx = createMockRouteContext({ sessionId: SID });
  (ctx.sessions as unknown as Map<string, Session>).set(SID, session);
  registerSessionRoutes(app, ctx as never);
  registerWsRoutes(app, ctx as never, () => ({ bindHost: '127.0.0.1', allowedHosts: [], tunnelHost: null }));
  app.addHook('preSerialization', (_req, reply, payload: unknown, done) => {
    const value = payload as { success?: unknown; errorCode?: unknown };
    if (value?.success === false && reply.statusCode === 200 && typeof value.errorCode === 'string') {
      reply.code(httpStatusForErrorCode(value.errorCode as ApiErrorCode));
    }
    done(null, payload);
  });
  installRouteErrorHandler(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  acknowledgements = [];
});

afterEach(async () => {
  socket?.terminate();
  socket = undefined;
  await app.close();
  await session.stop(false);
});

async function connect() {
  const port = (app.server.address() as AddressInfo).port;
  socket = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${SID}/terminal`);
  socket.on('message', (raw) => acknowledgements.push(JSON.parse(String(raw))));
  await new Promise<void>((resolve, reject) => {
    socket!.once('open', resolve);
    socket!.once('error', reject);
  });
}

async function send(transport: 'http' | 'ws', seq: number, data = `${seq}`, useMux = false) {
  if (transport === 'http') {
    return app.inject({
      method: 'POST',
      url: `/api/sessions/${SID}/input`,
      payload: { input: data, clientId: CID, seq, useMux },
    });
  }
  socket!.send(JSON.stringify({ t: 'i', d: data, cid: CID, seq }));
  await new Promise<void>((resolve) => {
    socket!.once('pong', () => resolve());
    socket!.ping();
  });
}

it.each(['http', 'ws'] as const)(
  'keeps dead %s input unacknowledged, without owner intent, and retries the same FIFO identities',
  async (transport) => {
    if (transport === 'ws') await connect();
    session.setPaneExit({ at: Date.now(), status: 42 });
    for (const seq of [7, 100]) {
      const response = await send(transport, seq);
      if (response) {
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ retryable: true, notSent: true });
      }
    }
    expect(acknowledgements).toEqual([]);
    expect(session.lastInputSeq(CID)).toBe(0);
    expect(written).not.toHaveBeenCalled();
    expect(sent).not.toHaveBeenCalled();
    expect(intent).not.toHaveBeenCalled();
    session.setPaneExit(undefined);
    const suffix = await send(transport, 100);
    if (suffix) expect(suffix.statusCode).toBeGreaterThanOrEqual(400);
    expect(written).not.toHaveBeenCalled();
    for (const seq of [7, 100]) {
      const response = await send(transport, seq);
      if (response) expect(response.statusCode).toBe(200);
    }
    if (transport === 'ws')
      await vi.waitFor(() =>
        expect(acknowledgements).toEqual([
          { t: 'ia', seq: 7 },
          { t: 'ia', seq: 100 },
        ])
      );
    expect(written.mock.calls.map(([data]) => data)).toEqual(['7', '100']);
    expect(intent).toHaveBeenCalledTimes(2);
    expect(session.lastInputSeq(CID)).toBe(100);
    session.setPaneExit({ at: Date.now(), status: 42 });
    const deadDuplicate = await send(transport, 100);
    if (deadDuplicate) {
      expect(deadDuplicate.statusCode).toBe(409);
      expect(deadDuplicate.json().notSent).toBeUndefined();
    }
    if (transport === 'ws') expect(acknowledgements).toHaveLength(2);
    session.setPaneExit(undefined);
    await send(transport, 100);
    expect(written).toHaveBeenCalledTimes(2);
    expect(probe).not.toHaveBeenCalled();
  }
);

it.each([false, true])('refuses cached-dead HTTP input before either write path (useMux=%s)', async (useMux) => {
  session.setPaneExit({ at: Date.now(), signal: 9 });
  const response = await send('http', 1, 'owner prompt', useMux);
  expect(response!.statusCode).toBe(409);
  expect(written).not.toHaveBeenCalled();
  expect(sent).not.toHaveBeenCalled();
  expect(intent).not.toHaveBeenCalled();
  expect(session.lastInputSeq(CID)).toBe(0);
});

it.each([
  ['http', false],
  ['http', true],
  ['ws', false],
  ['ws', true],
] as const)(
  'does not invent an exit for %s input (cleared=%s) or synchronously probe tmux',
  async (transport, cleared) => {
    if (cleared) {
      session.setPaneExit({ at: Date.now(), status: 0 });
      session.setPaneExit(undefined);
    }
    if (transport === 'ws') await connect();
    const response = await send(transport, 1);
    if (response) expect(response.statusCode).toBe(200);
    else await vi.waitFor(() => expect(acknowledgements).toEqual([{ t: 'ia', seq: 1 }]));
    expect(written.mock.calls.map(([data]) => data)).toEqual(['1']);
    expect(intent).toHaveBeenCalledTimes(1);
    expect(probe).not.toHaveBeenCalled();
  }
);

it('withholds HTTP ACK for an exit observed during awaited mux dispatch, while sealing the attempted identity', async () => {
  const release = createDeferred<boolean>();
  sent.mockImplementation(() => release.promise);
  const request = send('http', 1, 'possibly delivered', true);
  await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
  session.setPaneExit({ at: Date.now(), status: 42 });
  const overlapping = await send('http', 1, 'possibly delivered', true);
  expect(overlapping!.statusCode).toBe(409);
  expect(overlapping!.json().notSent).toBeUndefined();
  release.resolve(true);
  const response = await request;
  expect(response!.statusCode).toBe(409);
  expect(response!.json()).toMatchObject({ retryable: true });
  expect(response!.json().notSent).toBeUndefined();
  expect(session.lastInputSeq(CID)).toBe(1);
  expect(intent).toHaveBeenCalledTimes(1);
  session.setPaneExit(undefined);
  expect((await send('http', 1, 'possibly delivered', true))!.statusCode).toBe(200);
  expect(sent).toHaveBeenCalledTimes(1);
  expect(written).not.toHaveBeenCalled();
});

it('rechecks cached exit after asynchronous wake-target inspection before dispatch or owner intent', async () => {
  const release = createDeferred<boolean>();
  const inspected = createDeferred<void>();
  const check = vi.spyOn(RemoteWakeRegistry.prototype, 'hasWakeTarget').mockImplementation(async () => {
    inspected.resolve();
    return release.promise;
  });
  const request = send('http', 1);
  try {
    await inspected.promise;
    session.setPaneExit({ at: Date.now(), status: 42 });
    release.resolve(false);
    const response = await request;
    expect(response!.statusCode).toBe(409);
    expect(response!.json()).toMatchObject({ retryable: true, notSent: true });
    expect(written).not.toHaveBeenCalled();
    expect(sent).not.toHaveBeenCalled();
    expect(intent).not.toHaveBeenCalled();
    expect(session.lastInputSeq(CID)).toBe(0);
  } finally {
    release.resolve(false);
    check.mockRestore();
    await request;
  }
});

it('withholds WS ACK for an exit observed during a PTY attempt without reopening uncertain bytes', async () => {
  written.mockImplementation(() => {
    session.setPaneExit({ at: Date.now(), status: 42 });
  });
  await connect();
  await send('ws', 1);
  expect(acknowledgements).toEqual([]);
  expect(session.lastInputSeq(CID)).toBe(1);
  expect(written).toHaveBeenCalledTimes(1);
  session.setPaneExit(undefined);
  await send('ws', 1);
  await vi.waitFor(() => expect(acknowledgements).toEqual([{ t: 'ia', seq: 1, dup: true, last: 1 }]));
  expect(written).toHaveBeenCalledTimes(1);
});

it.each(['write', 'writeViaMux'] as const)(
  'rejects direct tagged Session.%s before submission side effects',
  async (method) => {
    session.deferInputSeq(CID, 1);
    expect(session.shouldApplyInput(CID, 1)).toBe(true);
    session.setPaneExit({ at: Date.now(), status: 0 });
    const options = { fromUser: true, inputSeq: { clientId: CID, seq: 1 } };
    expect(await session[method]('pending owner prompt\r', options)).toBe(false);
    expect(intent).not.toHaveBeenCalled();
    expect(written).not.toHaveBeenCalled();
    expect(sent).not.toHaveBeenCalled();
    expect(session.lastSubmitAt).toBe(0);
    expect(session.lastInputSeq(CID)).toBe(0);
  }
);
