/** @fileoverview Tagged wake input retains browser ownership until actual dispatch; all pane/wake effects are fake. */
import { EventEmitter } from 'node:events';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { Session } from '../../src/session.js';
import { RemoteWakeRegistry, REMOTE_WAKE_REQUEST_READY_TIMEOUT_MS } from '../../src/remote-wake.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { registerWsRoutes } from '../../src/web/routes/ws-routes.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { queueInputDispatch } from '../../src/web/input-dispatch-queue.js';
import { httpStatusForErrorCode, type ApiErrorCode } from '../../src/types.js';
import { createMockRouteContext } from '../mocks/index.js';
import { browserInputJournal, settleInput } from '../mocks/browser-input-journal.js';

const SID = 'fixture-wake-input';
const CID = 'fixture-original-client';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function harness(options: { partial?: boolean; authenticated?: boolean } = {}) {
  const app = Fastify({ logger: false });
  let disconnect = () => {};
  app.addHook('onRequest', async (_req, reply) => {
    disconnect = () => {
      reply.raw.destroy(new Error('Fixture browser disconnected'));
    };
  });
  const ctx = createMockRouteContext({ sessionId: SID });
  const remote = {
    hostId: 'fixture-host',
    label: 'Fixture worker',
    host: 'worker.invalid',
    username: 'fixture',
    remotePath: '/fixture',
    wakeCommand: 'fixture-wake',
  };
  const session = new Session({ id: SID, mode: 'shell', workingDir: process.env.HOME!, remote });
  const written: string[] = [];
  Object.assign(session, {
    ptyProcess: {
      write(data: string) {
        written.push(data);
        if (options.partial) throw new Error('Fixture bytes landed before the transport failed');
      },
    },
  });
  vi.spyOn(session, 'writeViaMux').mockImplementation(async (data, writeOptions) => session.write(data, writeOptions));
  const reattach = vi.spyOn(session, 'reattachRemote').mockResolvedValue(true);
  (ctx.sessions as unknown as Map<string, Session>).set(SID, session);
  if (options.authenticated) {
    const previousMultiuser = process.env.CODEMAN_MULTIUSER;
    process.env.CODEMAN_MULTIUSER = 'true';
    cleanups.push(async () => {
      if (previousMultiuser === undefined) delete process.env.CODEMAN_MULTIUSER;
      else process.env.CODEMAN_MULTIUSER = previousMultiuser;
    });
    session.owner = 'alice';
    app.addHook('onRequest', async (req) => {
      Object.assign(req, { authUser: { username: 'alice', role: 'user' } });
    });
  }
  const readiness = Promise.withResolvers<boolean>();
  const started = Promise.withResolvers<void>();
  const wake = vi.fn(async () => true);
  const registry = new RemoteWakeRegistry({
    probe: async () => false,
    wake,
    waitUntilReady: async () => {
      started.resolve();
      return readiness.promise;
    },
    delay: async () => {},
    log: () => {},
  });
  const ensureAwake = vi.spyOn(registry, 'ensureAwake');
  const ensureAwakeForInput = vi.spyOn(registry, 'ensureAwakeForInput');
  registerSessionRoutes(app, ctx as never, { remoteWake: registry });
  app.addHook('preSerialization', (req, reply, payload: unknown, done) => {
    if (!req.url.startsWith('/api') || !payload || typeof payload !== 'object') return done(null, payload);
    const result = payload as { success?: boolean; errorCode?: ApiErrorCode };
    if (result.success === false) {
      if (reply.statusCode === 200 && result.errorCode) reply.code(httpStatusForErrorCode(result.errorCode));
      return done(null, payload);
    }
    return done(null, { success: true, data: payload });
  });
  installRouteErrorHandler(app);
  await app.ready();
  // Execute the actual WS handler without opening a socket. This checks the
  // sibling transport's shared identity reservation during an awaited HTTP wake.
  let attach!: (socket: EventEmitter, req: object) => void;
  registerWsRoutes(
    {
      get: (_path: string, _opts: object, handler: typeof attach) => {
        attach = handler;
      },
    } as unknown as FastifyInstance,
    ctx as never,
    () => ({ bindHost: '127.0.0.1', allowedHosts: [], tunnelHost: null })
  );
  const acknowledgements: unknown[] = [];
  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    send: (raw: string) => acknowledgements.push(JSON.parse(raw)),
    close: (code: number, reason: string) => socket.emit('close', code, Buffer.from(reason)),
  });
  attach(socket, { params: { id: SID }, query: { cid: CID }, headers: { host: '127.0.0.1' } });
  cleanups.push(async () => {
    readiness.resolve(false);
    registry.stop();
    socket.emit('close', 1000, Buffer.alloc(0));
    await app.close();
    Object.assign(session, { ptyProcess: null });
    await session.stop(false);
  });
  const send = (seq: number, input: string, useMux = false) =>
    app.inject({
      method: 'POST',
      url: `/api/sessions/${SID}/input`,
      payload: { input, clientId: CID, seq, useMux },
    });
  return {
    app,
    ctx,
    session,
    written,
    reattach,
    registry,
    readiness,
    started: started.promise,
    send,
    socket,
    acknowledgements,
    disconnect: () => disconnect(),
    ensureAwake,
    ensureAwakeForInput,
  };
}

it.each(['reattach', 'broker'] as const)(
  'retains failed %s admission after wake settings removal across HTTP, WS and native input',
  async (failure) => {
    const h = await harness();
    const proof = vi.spyOn(h.session, 'confirmRemoteWakeReady').mockResolvedValue(failure !== 'broker');
    if (failure === 'reattach') h.reattach.mockResolvedValue(false);
    h.readiness.resolve(true);
    expect(await h.registry.wake(h.session)).toBe(false);
    h.session.remote!.wakeCommand = undefined;
    // A later successful TCP probe cannot certify the old local SSH attachment.
    Reflect.get(h.registry, 'deps').probe = async () => true;
    expect(await h.registry.checkReachable(h.session, { force: true })).toBe(true);
    expect(await h.registry.hasWakeTarget(h.session)).toBe(false);

    const journal = browserInputJournal();
    const document = journal.open();
    const cid = document.app._clientId;
    const replies: number[] = [];
    const requests: Array<{ input: string; clientId: string; seq: number }> = [];
    const transport: typeof fetch = vi.fn(async (url, options) => {
      const payload = JSON.parse(String(options?.body));
      requests.push(payload);
      const response = await h.app.inject({ method: 'POST', url: String(url), payload });
      replies.push(response.statusCode);
      const headers = new Headers();
      const ack = response.headers['x-codeman-input-ack'];
      if (typeof ack === 'string') headers.set('x-codeman-input-ack', ack);
      return new Response(response.body, { status: response.statusCode, headers });
    });
    document.transport(transport);
    document.app._sendInputAsync(SID, 'retained-head');
    document.app._sendInputAsync(SID, 'retained-tail');
    await settleInput(document.app);
    expect(journal.records().map(({ value }) => [value.cid, value.seq, value.data])).toEqual([
      [cid, 1, 'retained-head'],
      [cid, 2, 'retained-tail'],
    ]);
    expect(replies).toEqual([422]);
    expect(h.session.hasAppliedInputSeq(cid, 1)).toBe(false);
    h.socket.emit('message', JSON.stringify({ t: 'i', d: 'retained-head', cid, seq: 1 }));
    await queueInputDispatch(h.session, 0, async () => {});
    expect(h.acknowledgements).toEqual([]);
    expect(h.session.write('direct-native')).toBe(false);
    expect(await h.session.writeAsync('async-native')).toBe(false);
    vi.mocked(h.session.writeViaMux).mockRestore();
    expect(await h.session.writeViaMux('mux-native')).toBe(false);
    const key = vi.fn(async () => {});
    expect(await h.session.sendNamedKey('\n', key)).toBe(false);
    expect(key).not.toHaveBeenCalled();
    const handoff = await h.app.inject({
      method: 'POST',
      url: `/api/sessions/${SID}/direct-attach-fence`,
      payload: {},
    });
    expect(handoff.statusCode).toBe(422);
    expect(h.written).toEqual([]);

    // Only a fresh successful attachment/proof releases the native veto; the
    // original durable browser identities then retry once in their FIFO order.
    h.session.remote!.wakeCommand = 'fixture-wake';
    h.reattach.mockResolvedValue(true);
    proof.mockResolvedValue(true);
    expect(await h.registry.ensureAwake(h.session)).toBe(true);
    const restored = journal.open();
    restored.transport(transport);
    restored.app._drainSession(SID);
    await settleInput(restored.app);
    expect(requests).toEqual([
      { input: 'retained-head', clientId: cid, seq: 1 },
      { input: 'retained-head', clientId: cid, seq: 1 },
      { input: 'retained-tail', clientId: cid, seq: 2 },
    ]);
    expect(h.written).toEqual(['retained-head', 'retained-tail']);
    expect(journal.records()).toEqual([]);
    expect(restored.app._pendingDeliveries.has(SID)).toBe(false);
    h.socket.emit('message', JSON.stringify({ t: 'i', d: 'retained-head', cid, seq: 1 }));
    await queueInputDispatch(h.session, 0, async () => {});
    expect(h.acknowledgements).toEqual([{ t: 'ia', seq: 1, dup: true, last: 2 }]);
    expect(h.written).toEqual(['retained-head', 'retained-tail']);
  }
);

it('preserves ordinary remote input with no wake target and no failed attachment state', async () => {
  const h = await harness();
  h.session.remote!.wakeCommand = undefined;
  expect(await h.registry.requiresInputReadiness(h.session)).toBe(false);
  expect(h.session.inputDispatchAllowed).toBe(true);
  expect((await h.send(1, 'healthy-ordinary')).statusCode).toBe(200);
  expect(h.written).toEqual(['healthy-ordinary']);
  expect(h.reattach).not.toHaveBeenCalled();
});

it.each([false, true].flatMap((useMux) => [2500, 5000].map((bytes) => ({ useMux, bytes }))))(
  'ACKs a tagged $bytes-byte wake input only after actual dispatch (mux=$useMux)',
  async ({ useMux, bytes }) => {
    const h = await harness();
    const input = bytes === 5000 ? '🧭'.repeat(1250) : 'x'.repeat(bytes);
    let settled = false;
    const first = h.send(1, input, useMux).then((response) => {
      settled = true;
      return response;
    });
    let suffixSettled = false;
    let suffix!: Promise<Awaited<ReturnType<typeof h.send>>>;
    await h.started;
    try {
      expect(h.ensureAwakeForInput).toHaveBeenCalledWith(h.session, h.session.paneStartedAt, {
        timeoutMs: REMOTE_WAKE_REQUEST_READY_TIMEOUT_MS,
      });
      expect(h.ensureAwake).toHaveBeenCalledWith(h.session, { timeoutMs: REMOTE_WAKE_REQUEST_READY_TIMEOUT_MS });
      expect(h.session.hasAppliedInputSeq(CID, 1)).toBe(false);
      expect(h.registry.pendingBytes(SID)).toBe(0);
      expect(settled).toBe(false);
      expect(h.written).toEqual([]);
      // This layer serializes input dispatch across HTTP and WS before private
      // fence admission. The suffix stays queued while its predecessor wakes.
      suffix = h.send(2, 'suffix', useMux).then((response) => {
        suffixSettled = true;
        return response;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(suffixSettled).toBe(false);
      h.socket.emit('message', JSON.stringify({ t: 'i', d: input, cid: CID, seq: 1 }));
      h.socket.emit('message', JSON.stringify({ t: 'i', d: 'suffix', cid: CID, seq: 2 }));
      expect(h.acknowledgements).toEqual([]);
      expect(h.written).toEqual([]);
    } finally {
      h.readiness.resolve(true);
    }
    expect((await first).statusCode).toBe(200);
    expect((await suffix).statusCode).toBe(200);
    expect(h.written).toEqual([input, 'suffix']);
    expect(h.session.hasAppliedInputSeq(CID, 1)).toBe(true);
    expect((await h.send(1, input, useMux)).statusCode).toBe(200);
    expect((await h.send(2, 'suffix', useMux)).statusCode).toBe(200);
    h.socket.emit('message', JSON.stringify({ t: 'i', d: input, cid: CID, seq: 1 }));
    await queueInputDispatch(h.session, 0, async () => {});
    // Both transports kept their frames while the predecessor woke. Whichever
    // reaches suffix admission first writes it once; every queued WS frame is
    // ACKed after dispatch, with the watermark certified at its own queue slot.
    expect([
      [
        { t: 'ia', seq: 1, dup: true, last: 1 },
        { t: 'ia', seq: 2 },
        { t: 'ia', seq: 1, dup: true, last: 2 },
      ],
      [
        { t: 'ia', seq: 1, dup: true, last: 2 },
        { t: 'ia', seq: 2, dup: true, last: 2 },
        { t: 'ia', seq: 1, dup: true, last: 2 },
      ],
    ]).toContainEqual(h.acknowledgements);
    expect(h.written).toEqual([input, 'suffix']);
  }
);

it('never ACKs a failed wake and retries the same original input identity', async () => {
  const h = await harness();
  const first = h.send(1, 'retained');
  // Fastify's injection starts when the thenable is consumed.
  const response = Promise.resolve(first);
  await h.started;
  h.readiness.resolve(false);
  expect((await response).statusCode).toBe(422);
  expect(h.session.hasAppliedInputSeq(CID, 1)).toBe(false);
  expect(h.written).toEqual([]);
  expect(h.session.shouldApplyInput(CID, 1)).toBe(true);
  h.session.forgetInputSeq(CID, 1);
});

it('keeps a partial write after a successful wake sealed across HTTP and WS retries', async () => {
  const h = await harness({ partial: true });
  const first = Promise.resolve(h.send(1, 'possibly-landed'));
  await h.started;
  h.readiness.resolve(true);
  expect((await first).statusCode).toBe(500);
  expect(h.written).toEqual(['possibly-landed']);
  expect(h.session.hasAppliedInputSeq(CID, 1)).toBe(true);
  expect((await h.send(1, 'possibly-landed')).statusCode).toBe(200);
  h.socket.emit('message', JSON.stringify({ t: 'i', d: 'possibly-landed', cid: CID, seq: 1 }));
  await queueInputDispatch(h.session, 0, async () => {});
  expect(h.acknowledgements).toEqual([{ t: 'ia', seq: 1, dup: true, last: 1 }]);
  expect(h.written).toEqual(['possibly-landed']);
});

it('releases the original unsent identity when the requesting browser disconnects during wake', async () => {
  const h = await harness();
  const first = Promise.resolve(
    h.app.inject({
      method: 'POST',
      url: `/api/sessions/${SID}/input`,
      payload: { input: 'disconnected', clientId: CID, seq: 1 },
    })
  ).catch((error: unknown) => error);
  await h.started;
  h.disconnect();
  expect(await first).toBeInstanceOf(Error);
  h.readiness.resolve(true);
  await vi.waitFor(() => expect(h.session.shouldApplyInput(CID, 1)).toBe(true));
  h.session.forgetInputSeq(CID, 1);
  expect(h.written).toEqual([]);
  expect(h.session.hasAppliedInputSeq(CID, 1)).toBe(false);
});

it.each(['removed', 'replaced', 'owner-changed', 'recovery-reserved'] as const)(
  'refuses input when its target becomes %s while wake is awaited',
  async (change) => {
    const h = await harness({ authenticated: true });
    const first = Promise.resolve(h.send(1, 'cancelled'));
    await h.started;
    if (change === 'removed') h.ctx.sessions.delete(SID);
    else if (change === 'replaced') h.ctx.sessions.set(SID, createMockRouteContext({ sessionId: SID })._session);
    else if (change === 'owner-changed') h.session.owner = 'bob';
    else Object.assign(h.session, { _recoveryDelivering: true });
    h.readiness.resolve(true);
    const response = await first;
    // An actual Session binds ownership into the remote wake scope, so owner
    // changes veto readiness before the route's later ownership recheck.
    expect(response.statusCode).toBe(change === 'owner-changed' || change === 'recovery-reserved' ? 422 : 409);
    expect(response.json().errorCode).toBe('OPERATION_FAILED');
    expect(h.written).toEqual([]);
    expect(h.session.hasAppliedInputSeq(CID, 1)).toBe(false);
  }
);
