/**
 * @fileoverview Tests for WebSocket terminal I/O route.
 *
 * Unlike other route tests that use app.inject(), WebSocket testing requires
 * a real listening server since inject() doesn't support upgrade requests.
 * Uses the `ws` package (transitive dep of @fastify/websocket) as the client.
 *
 * @dependency test/mocks/mock-route-context.ts (createMockRouteContext)
 * @dependency src/web/routes/ws-routes.ts (registerWsRoutes)
 * Port: ephemeral (`listen({ port: 0 })`)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import WebSocket from 'ws';
import { createMockRouteContext, createDeferred, type MockRouteContext } from '../mocks/index.js';
import { registerWsRoutes } from '../../src/web/routes/ws-routes.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';

const childProcess = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: childProcess.execFile,
}));
import { MAX_INPUT_LENGTH } from '../../src/config/terminal-limits.js';
import { loadRebootIdentityFence, RebootIdentityFenceError } from '../../src/recovery/reboot-identity-fence.js';
import { Session } from '../../src/session.js';
import type { MuxSession, TerminalMultiplexer } from '../../src/mux-interface.js';
import * as remoteClock from '../../src/recovery/remote-clock.js';
import { queueInputDispatch } from '../../src/web/input-dispatch-queue.js';

/** Assigned by the OS on every listen (`port: 0`); see beforeEach. */
let PORT = 0;

/** Helper: open a WebSocket connection and wait for it to reach OPEN state. */
function connectWs(path: string, timeoutMs = 5000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS connection timeout')), timeoutMs);
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Helper: wait for the next WS message, parsed as JSON. */
function nextMessage(ws: WebSocket, timeoutMs = 2000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS message timeout')), timeoutMs);
    ws.once('message', (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(raw)));
    });
  });
}

/** Helper: wait for WS close event and return { code, reason }. */
function waitForClose(ws: WebSocket, timeoutMs = 2000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS close timeout')), timeoutMs);
    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

/** Helper: collect N messages from a WebSocket. */
function collectMessages(ws: WebSocket, count: number, timeoutMs = 3000): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Only received ${msgs.length}/${count} messages`)), timeoutMs);
    const msgs: unknown[] = [];
    const onMessage = (raw: WebSocket.RawData) => {
      msgs.push(JSON.parse(String(raw)));
      if (msgs.length >= count) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(msgs);
      }
    };
    ws.on('message', onMessage);
  });
}

const ownedRemoteFixtures = new Set<Session>();
async function isolatedRemoteWsSession() {
  const session = new Session({
    id: 'ws-test-session',
    workingDir: '/tmp',
    mode: 'codex',
    useMux: true,
    mux: { isAvailable: () => true } as unknown as TerminalMultiplexer,
    muxSession: {
      muxName: 'codeman-ws-fixture',
      recoveryIsolated: true,
      recoveryCodexHome: '/fixture/codex-home',
    } as MuxSession,
    codexConfig: { noDaemon: true, resumeSessionId: '11111111-2222-3333-4444-555555555555' },
    remote: {
      hostId: 'fixture',
      label: 'Fixture',
      host: 'worker.invalid',
      username: 'fixture',
      remotePath: '/tmp',
      owned: true,
    },
    envOverrides: { CODEX_HOME: '/fixture/codex-home' },
  });
  const written = vi.fn();
  Object.assign(session, { ptyProcess: { write: written, resize: vi.fn() } });
  ownedRemoteFixtures.add(session);
  expect(await session.ensureRecoveryIdentityFence()).toBe(true);
  // These route tests isolate input admission and actual pane lifecycle/epoch
  // transitions. Native ownership/readiness proof has its own Session suite.
  vi.spyOn(session, 'confirmRemoteWakeReady').mockResolvedValue(true);
  vi.spyOn(session, 'isRemoteWakeReadyCurrent').mockReturnValue(true);
  return { session, written };
}
function currentClockWitness(): remoteClock.RemoteClockWitness {
  const at = Date.now();
  return { localBefore: at, localAfter: at, remoteBefore: at, remoteAfter: at };
}
async function inputReceived(ws: WebSocket): Promise<void> {
  const pong = new Promise<void>((resolve) => ws.once('pong', () => resolve()));
  ws.ping();
  await pong;
}

describe('ws-routes', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let fixtureDirectory: string;
  let requestUser: { username: string; role: 'user' | 'admin' } | undefined;

  beforeEach(async () => {
    fixtureDirectory = await mkdtemp(join(homedir(), 'ws-input-fence-'));
    vi.stubEnv('CODEMAN_DATA_DIR', fixtureDirectory);
    ownedRemoteFixtures.clear();
    requestUser = undefined;
    app = Fastify({ logger: false });
    app.addHook('onRequest', async (req) => {
      if (requestUser) req.authUser = requestUser;
    });
    await app.register(fastifyWebsocket);

    ctx = createMockRouteContext({ sessionId: 'ws-test-session' });
    registerWsRoutes(app, ctx as never, () => ({ bindHost: '127.0.0.1', allowedHosts: [], tunnelHost: null }));
    registerSessionRoutes(app, ctx as never, { remoteWake: { hasWakeTarget: async () => false } as never });
    childProcess.execFile.mockReset();

    await app.listen({ port: 0, host: '127.0.0.1' });
    PORT = (app.server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
    for (const value of ctx.sessions.values()) if (value instanceof Session) ownedRemoteFixtures.add(value);
    for (const session of ownedRemoteFixtures) {
      await session.stop(false);
      await vi.waitFor(
        async () => {
          await loadRebootIdentityFence(session.id);
        },
        { timeout: 3000, interval: 5 }
      );
    }
    vi.unstubAllEnvs();
    await rm(fixtureDirectory, { recursive: true, force: true });
  });

  // ========== Session not found ===

  describe('session not found', () => {
    it('closes with 4004 when session does not exist', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/sessions/nonexistent/terminal`);
      const { code, reason } = await waitForClose(ws);
      expect(code).toBe(4004);
      expect(reason).toBe('Session not found');
    });
  });

  // ========== Terminal output ===

  describe('terminal output', () => {
    it('receives terminal output via WS with DEC 2026 sync markers', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        // Emit terminal data from mock session
        session.emit('terminal', 'hello world');

        // Wait for the micro-batched message (8ms batch interval + margin)
        const msg = (await nextMessage(ws)) as { t: string; d: string };
        expect(msg.t).toBe('o');
        // Should contain DEC 2026 sync markers wrapping the data
        expect(msg.d).toContain('hello world');
        expect(msg.d).toMatch(/^\x1b\[\?2026h/); // starts with DEC 2026 start
        expect(msg.d).toMatch(/\x1b\[\?2026l$/); // ends with DEC 2026 end
      } finally {
        ws.close();
      }
    });

    it('sends clearTerminal event as {"t":"c"}', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        ctx._session.emit('clearTerminal');

        const msg = (await nextMessage(ws)) as { t: string };
        expect(msg.t).toBe('c');
      } finally {
        ws.close();
      }
    });

    it('sends needsRefresh event as {"t":"r"}', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        ctx._session.emit('needsRefresh');

        const msg = (await nextMessage(ws)) as { t: string };
        expect(msg.t).toBe('r');
      } finally {
        ws.close();
      }
    });

    it('coalesces rapid terminal emissions into a single frame', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        // Emit multiple small chunks in rapid succession (within the 8ms batch window)
        session.emit('terminal', 'chunk1');
        session.emit('terminal', 'chunk2');
        session.emit('terminal', 'chunk3');

        // Should arrive as a single coalesced message
        const msg = (await nextMessage(ws)) as { t: string; d: string };
        expect(msg.t).toBe('o');
        expect(msg.d).toContain('chunk1chunk2chunk3');
      } finally {
        ws.close();
      }
    });

    it('flushes immediately when batch exceeds size threshold', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        // Emit data larger than WS_BATCH_FLUSH_THRESHOLD (16384)
        const largeData = 'X'.repeat(17000);
        session.emit('terminal', largeData);

        // Should flush immediately (no 8ms wait) — use a tight timeout
        const msg = (await nextMessage(ws, 500)) as { t: string; d: string };
        expect(msg.t).toBe('o');
        expect(msg.d).toContain(largeData);
      } finally {
        ws.close();
      }
    });
  });

  // ========== Client input ===

  describe('client input', () => {
    it('closes a saturated 256-client backlog without ACK and retries after drain without replaying committed bytes', async () => {
      const session = new Session({ id: 'ws-test-session', workingDir: '/tmp', mode: 'claude' });
      const written = vi.fn();
      Object.assign(session, { ptyProcess: { write: written } });
      (ctx.sessions as unknown as Map<string, Session>).set(session.id, session);
      const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
      expect(session.shouldApplyInput('sealed', 7)).toBe(true);
      session.commitInputSeq('sealed', 7);
      expect(session.shouldApplyInput('sealed', 8)).toBe(true);
      for (let index = 0; index < 255; index++) expect(session.shouldApplyInput(`pending-${index}`, 1)).toBe(true);
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal?cid=backlog-client');
      let restored: WebSocket | undefined;
      try {
        const first = new Promise((resolve) => {
          ws.once('message', (raw) => resolve({ message: JSON.parse(String(raw)) }));
          ws.once('close', (code, reason) => resolve({ code, reason: String(reason) }));
        });
        const frame = { t: 'i', d: 'paste first\n', cid: 'backlog-client', seq: 17 };
        ws.send(JSON.stringify(frame));
        expect(await first).toEqual({ code: 4008, reason: 'Input backlog full' });
        expect(written).not.toHaveBeenCalled();
        expect(Reflect.get(session, '_appliedInputSeq').has(frame.cid)).toBe(false);
        expect(session.hasAppliedInputSeq(frame.cid, frame.seq)).toBe(false);
        // Only a completed in-flight occurrence releases one client slot.
        session.commitInputSeq('pending-0', 1);
        restored = await connectWs('/ws/sessions/ws-test-session/terminal?cid=backlog-client');
        let ack = nextMessage(restored);
        restored.send(JSON.stringify(frame));
        expect(await ack).toEqual({ t: 'ia', seq: 17 });
        ack = nextMessage(restored);
        restored.send(JSON.stringify({ ...frame, d: 'paste second', seq: 18 }));
        expect(await ack).toEqual({ t: 'ia', seq: 18 });
        ack = nextMessage(restored);
        restored.send(JSON.stringify(frame));
        expect(await ack).toEqual({ t: 'ia', seq: 17, dup: true, last: 18 });
        ack = nextMessage(restored);
        restored.send(JSON.stringify({ t: 'i', d: 'already committed', cid: 'sealed', seq: 7 }));
        expect(await ack).toEqual({ t: 'ia', seq: 7, dup: true, last: 7 });
        expect(session.shouldApplyInput('sealed', 8)).toBe(false);
        expect(written.mock.calls.map(([data]) => data)).toEqual(['paste first\n', 'paste second']);
      } finally {
        clock.mockRestore();
        ws.close();
        restored?.close();
        await session.stop(false);
      }
    });

    it('closes an exhausted per-client deferred tail without ACK and retries the exact identity after its lease', async () => {
      const session = new Session({ id: 'ws-test-session', workingDir: '/tmp', mode: 'claude' });
      const written = vi.fn();
      Object.assign(session, { ptyProcess: { write: written } });
      (ctx.sessions as unknown as Map<string, Session>).set(session.id, session);
      let now = 0;
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
      expect(session.shouldApplyInput('tail-client', 1)).toBe(true);
      session.commitInputSeq('tail-client', 1);
      for (let seq = 2; seq <= 4097; seq++) expect(session.deferInputSeq('tail-client', seq)).toBe(true);
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal?cid=tail-client');
      let restored: WebSocket | undefined;
      try {
        const first = new Promise((resolve) => {
          ws.once('message', (raw) => resolve({ message: JSON.parse(String(raw)) }));
          ws.once('close', (code, reason) => resolve({ code, reason: String(reason) }));
        });
        const frame = { t: 'i', d: 'retained paste', cid: 'tail-client', seq: 4098 };
        ws.send(JSON.stringify(frame));
        expect(await first).toEqual({ code: 4008, reason: 'Input backlog full' });
        expect(written).not.toHaveBeenCalled();
        expect(session.lastInputSeq(frame.cid)).toBe(1);
        expect(session.hasAppliedInputSeq(frame.cid, frame.seq)).toBe(false);
        now = 60_000;
        restored = await connectWs('/ws/sessions/ws-test-session/terminal?cid=tail-client');
        let ack = nextMessage(restored);
        restored.send(JSON.stringify(frame));
        expect(await ack).toEqual({ t: 'ia', seq: 4098 });
        ack = nextMessage(restored);
        restored.send(JSON.stringify(frame));
        expect(await ack).toEqual({ t: 'ia', seq: 4098, dup: true, last: 4098 });
        expect(written).toHaveBeenCalledExactlyOnceWith(frame.d);
      } finally {
        clock.mockRestore();
        ws.close();
        restored?.close();
        await session.stop(false);
      }
    });

    it('retries the same frame after a pre-dispatch identity fence throws', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      const session = ctx._session;
      const write = vi.spyOn(session, 'write').mockImplementationOnce(() => {
        throw new RebootIdentityFenceError();
      });
      try {
        const frame = JSON.stringify({ t: 'i', d: '/resume\r', cid: 'fence-client', seq: 1 });
        ws.send(frame);
        await expect(nextMessage(ws, 600)).rejects.toThrow(/timeout/);
        expect(session.writeBuffer).toEqual([]);
        const acknowledged = nextMessage(ws);
        ws.send(frame);
        expect(await acknowledged).toEqual({ t: 'ia', seq: 1 });
        expect(session.writeBuffer).toEqual(['/resume\r']);
      } finally {
        write.mockRestore();
        ws.close();
      }
    });

    it('recovers admission after 256 known-unsent clients disconnect during a pane reservation', async () => {
      const session = new Session({ id: 'ws-test-session', workingDir: '/tmp', mode: 'claude' });
      const written = vi.fn();
      Object.assign(session, { ptyProcess: { write: written } });
      (ctx.sessions as unknown as Map<string, Session>).set(session.id, session);
      let now = 0;
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
      const key = createDeferred<void>();
      const held = session.sendNamedKey('\n', () => key.promise);
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      const messages: unknown[] = [];
      ws.on('message', (raw) => messages.push(JSON.parse(String(raw))));
      let restored: WebSocket | undefined;
      try {
        expect(session.recoveryInputReserved).toBe(true);
        for (let i = 0; i < 256; i++) ws.send(JSON.stringify({ t: 'i', d: 'unsent', cid: `abandoned-${i}`, seq: 1 }));
        const pong = new Promise<void>((resolve) => ws.once('pong', () => resolve()));
        ws.ping();
        await pong;
        expect(Reflect.get(session, '_appliedInputSeq').size).toBe(256);
        expect(written).not.toHaveBeenCalled();
        expect(messages).toEqual([]);
        const closed = waitForClose(ws);
        ws.close();
        await closed;
        key.resolve();
        await held;
        now = 60_000;
        restored = await connectWs('/ws/sessions/ws-test-session/terminal');
        let ack = nextMessage(restored);
        restored.send(JSON.stringify({ t: 'i', d: 'fresh', cid: 'fresh-client', seq: 1 }));
        expect(await ack).toEqual({ t: 'ia', seq: 1 });
        expect(written).toHaveBeenCalledExactlyOnceWith('fresh');
        // Reclaiming a certified-unsent reservation must not ACK it as delivered.
        ack = nextMessage(restored);
        restored.send(JSON.stringify({ t: 'i', d: 'retried-unsent', cid: 'abandoned-0', seq: 1 }));
        expect(await ack).toEqual({ t: 'ia', seq: 1 });
        expect(written.mock.calls.map(([data]) => data)).toEqual(['fresh', 'retried-unsent']);
      } finally {
        clock.mockRestore();
        key.resolve();
        await held;
        ws.close();
        restored?.close();
        await session.stop(false);
      }
    });

    it.each([
      { label: 'empty cid', metadata: { cid: '', seq: 1 } },
      { label: '129-char cid', metadata: { cid: 'c'.repeat(129), seq: 1 } },
      { label: 'near-frame-limit cid', metadata: { cid: 'c'.repeat(MAX_INPUT_LENGTH), seq: 1 } },
      { label: 'non-string cid', metadata: { cid: 7, seq: 1 } },
      { label: 'null cid', metadata: { cid: null, seq: 1 } },
      {
        label: 'oversized input with invalid cid',
        metadata: { cid: 'c'.repeat(129), seq: 1 },
        input: 'x'.repeat(MAX_INPUT_LENGTH + 1),
      },
      {
        label: 'oversized input with invalid seq',
        metadata: { cid: 'bounded-client', seq: Number.MAX_SAFE_INTEGER + 1 },
        input: 'x'.repeat(MAX_INPUT_LENGTH + 1),
      },
      { label: 'negative seq', metadata: { cid: 'bounded-client', seq: -1 } },
      { label: 'fractional seq', metadata: { cid: 'bounded-client', seq: 1.5 } },
      { label: 'unsafe seq', metadata: { cid: 'bounded-client', seq: Number.MAX_SAFE_INTEGER + 1 } },
      { label: 'null seq', metadata: { cid: 'bounded-client', seq: null } },
      { label: 'string seq', metadata: { cid: 'bounded-client', seq: '1' } },
      { label: 'cid without seq still invalid', metadata: { cid: 'c'.repeat(129) } },
      { label: 'seq without cid still invalid', metadata: { seq: -1 } },
      { label: 'NaN encoding', raw: '{"t":"i","d":"forbidden","cid":"bounded-client","seq":NaN}' },
      { label: 'infinite seq', raw: '{"t":"i","d":"forbidden","cid":"bounded-client","seq":1e309}' },
    ])('rejects $label before retaining delivery identity or downgrading to legacy input', async (entry) => {
      const session = new Session({ id: 'ws-test-session', workingDir: '/tmp', mode: 'claude' });
      const written = vi.fn();
      const deferred = vi.spyOn(session, 'deferInputSeq');
      Object.assign(session, { ptyProcess: { write: written } });
      (ctx.sessions as unknown as Map<string, Session>).set(session.id, session);
      const key = createDeferred<void>();
      const held = session.sendNamedKey('\n', () => key.promise);
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      const messages: unknown[] = [];
      ws.on('message', (raw) => messages.push(JSON.parse(String(raw))));
      const sync = async () => {
        const pong = new Promise<void>((resolve) => ws.once('pong', () => resolve()));
        ws.ping();
        await pong;
      };
      const frame = entry.raw ?? JSON.stringify({ t: 'i', d: entry.input ?? 'forbidden', ...entry.metadata });
      try {
        expect(session.recoveryInputReserved).toBe(true);
        ws.send(frame);
        await sync();
        expect(deferred).not.toHaveBeenCalled();
        expect(Reflect.get(session, '_appliedInputSeq').size).toBe(0);
        key.resolve();
        await held;
        ws.send(frame);
        await sync();
        expect(deferred).not.toHaveBeenCalled();
        expect(written).not.toHaveBeenCalled();
        expect(messages).toEqual([]);
        expect(Reflect.get(session, '_appliedInputSeq').size).toBe(0);
      } finally {
        key.resolve();
        await held;
        ws.close();
        await session.stop(false);
      }
    });

    it('retains 128-character client IDs and safe sequence boundaries in actual FIFO admission', async () => {
      const session = new Session({ id: 'ws-test-session', workingDir: '/tmp', mode: 'claude' });
      const written = vi.fn();
      Object.assign(session, { ptyProcess: { write: written } });
      (ctx.sessions as unknown as Map<string, Session>).set(session.id, session);
      const key = createDeferred<void>();
      const held = session.sendNamedKey('\n', () => key.promise);
      const cid = 'c'.repeat(128);
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      const sync = async () => {
        const pong = new Promise<void>((resolve) => ws.once('pong', () => resolve()));
        ws.ping();
        await pong;
      };
      const frame = (seq: number) => JSON.stringify({ t: 'i', d: String(seq), cid, seq });
      try {
        ws.send(frame(0));
        ws.send(frame(Number.MAX_SAFE_INTEGER));
        await sync();
        expect(written).not.toHaveBeenCalled();
        expect(session.hasAppliedInputSeq(cid, 0)).toBe(false);
        expect(Reflect.get(session, '_appliedInputSeq').get(cid).waiting.size).toBe(2);
        key.resolve();
        await held;
        // A later sparse retry still cannot overtake the retained zero identity.
        ws.send(frame(Number.MAX_SAFE_INTEGER));
        await sync();
        expect(written).not.toHaveBeenCalled();
        const applied = collectMessages(ws, 2);
        ws.send(frame(0));
        ws.send(frame(Number.MAX_SAFE_INTEGER));
        expect(await applied).toEqual([
          { t: 'ia', seq: 0 },
          { t: 'ia', seq: Number.MAX_SAFE_INTEGER },
        ]);
        expect(written.mock.calls.map(([data]) => data)).toEqual(['0', String(Number.MAX_SAFE_INTEGER)]);
        const duplicates = collectMessages(ws, 2);
        ws.send(frame(0));
        ws.send(frame(Number.MAX_SAFE_INTEGER));
        expect(await duplicates).toEqual([
          { t: 'ia', seq: 0, dup: true, last: Number.MAX_SAFE_INTEGER },
          { t: 'ia', seq: Number.MAX_SAFE_INTEGER, dup: true, last: Number.MAX_SAFE_INTEGER },
        ]);
        expect(written).toHaveBeenCalledTimes(2);
      } finally {
        key.resolve();
        await held;
        ws.close();
        await session.stop(false);
      }
    });

    it('gates a higher frame when the key lock releases between earlier blocked frames and its arrival', async () => {
      const session = new Session({ id: 'ws-test-session', workingDir: '/tmp', mode: 'claude' });
      const written = vi.fn();
      Object.assign(session, { ptyProcess: { write: written } });
      (ctx.sessions as unknown as Map<string, Session>).set(session.id, session);
      const key = createDeferred<void>();
      const held = session.sendNamedKey('\n', () => key.promise);
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      const sync = async () => {
        const pong = new Promise<void>((resolve) => ws.once('pong', () => resolve()));
        ws.ping();
        await pong;
      };
      try {
        for (const seq of [1, 2]) ws.send(JSON.stringify({ t: 'i', d: `${seq}`, cid: 'mid-burst', seq }));
        await sync();
        key.resolve();
        await held;
        ws.send(JSON.stringify({ t: 'i', d: '3', cid: 'mid-burst', seq: 3 }));
        await sync();
        expect(written).not.toHaveBeenCalled();
        expect(session.lastInputSeq('mid-burst')).toBe(0);
        const acked = collectMessages(ws, 3);
        for (const seq of [1, 2, 3]) ws.send(JSON.stringify({ t: 'i', d: `${seq}`, cid: 'mid-burst', seq }));
        expect(await acked).toEqual([
          { t: 'ia', seq: 1 },
          { t: 'ia', seq: 2 },
          { t: 'ia', seq: 3 },
        ]);
        expect(written.mock.calls.map(([data]) => data)).toEqual(['1', '2', '3']);
      } finally {
        key.resolve();
        await held;
        ws.close();
        await session.stop(false);
      }
    });

    it('never replays bytes after an actual Session submission listener throws after the PTY write', async () => {
      const session = new Session({ id: 'ws-test-session', workingDir: '/tmp', mode: 'claude' });
      const written = vi.fn();
      Object.assign(session, { ptyProcess: { write: written } });
      session.on('promptSubmitted', () => {
        throw new Error('listener failed after write');
      });
      (ctx.sessions as unknown as Map<string, Session>).set(session.id, session);
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        ws.send(JSON.stringify({ t: 'i', d: 'committed\r', cid: 'after-write', seq: 7 }));
        const pong = new Promise<void>((resolve) => ws.once('pong', () => resolve()));
        ws.ping();
        await pong;
        expect(written).toHaveBeenCalledTimes(1);
        expect(session.lastInputSeq('after-write')).toBe(7);
        const duplicate = nextMessage(ws);
        ws.send(JSON.stringify({ t: 'i', d: 'committed\r', cid: 'after-write', seq: 7 }));
        expect(await duplicate).toEqual({ t: 'ia', seq: 7, dup: true, last: 7 });
        expect(written).toHaveBeenCalledTimes(1);
      } finally {
        ws.close();
        await session.stop(false);
      }
    });
    it('closes queued legacy input after owner access is lost', async () => {
      const previousMultiuser = process.env.CODEMAN_MULTIUSER;
      process.env.CODEMAN_MULTIUSER = '1';
      requestUser = { username: 'alice', role: 'user' };
      const { session, written } = await isolatedRemoteWsSession();
      session.owner = 'alice';
      (ctx.sessions as unknown as Map<string, Session>).set(session.id, session);
      const blocker = createDeferred<void>();
      const queued = queueInputDispatch(session, 0, () => blocker.promise);
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      const closed = waitForClose(ws);
      try {
        ws.send(JSON.stringify({ t: 'i', d: 'owner bytes' }));
        await inputReceived(ws);
        session.owner = 'bob';
        blocker.resolve();
        await queued;
        expect((await closed).code).toBe(4011);
        expect(written).not.toHaveBeenCalled();
      } finally {
        blocker.resolve();
        await queued;
        ws.close();
        await session.stop(false);
        if (previousMultiuser === undefined) delete process.env.CODEMAN_MULTIUSER;
        else process.env.CODEMAN_MULTIUSER = previousMultiuser;
      }
    });

    it.each(['ws', 'http', 'named-key'] as const)(
      'records rejected %s owner intent once during an actual tentative pane lifecycle',
      async (transport) => {
        const { session, written } = await isolatedRemoteWsSession();
        const respawn = createDeferred<number>();
        Object.assign(session, { _mux: { muxSessionExists: () => true, respawnPane: () => respawn.promise } });
        (ctx.sessions as unknown as Map<string, Session>).set(session.id, session);
        const ownerIntent = vi.fn();
        session.on('recoveryUserInput', ownerIntent);
        const lifecycle = session.reattachRemote();
        const before = session.getRecoveryContext().generation;
        const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
        const closed = transport === 'ws' ? waitForClose(ws) : undefined;
        try {
          expect(session.inputDispatchAllowed).toBe(false);
          if (transport === 'ws') {
            ws.send(JSON.stringify({ t: 'i', d: 'cancel launch' }));
            expect((await closed!).code).toBe(4011);
          } else {
            const response = await app.inject({
              method: 'POST',
              url: `/api/sessions/${session.id}/${transport === 'http' ? 'input' : 'send-key'}`,
              payload:
                transport === 'http'
                  ? { input: 'cancel launch', useMux: false, clientId: 'intent', seq: 1 }
                  : { key: 'C-Enter' },
            });
            expect(response.json()).toMatchObject({ success: false, errorCode: 'OPERATION_FAILED' });
          }
          expect(session.getRecoveryContext().generation).toBe(before + 1);
          expect(ownerIntent).toHaveBeenCalledTimes(1);
          expect(written).not.toHaveBeenCalled();
        } finally {
          respawn.resolve(123);
          await lifecycle;
          ws.close();
          await session.stop(false);
        }
      }
    );

    it.each(['ws', 'http'] as const)(
      'does not manufacture %s owner intent for an applied duplicate',
      async (transport) => {
        const { session, written } = await isolatedRemoteWsSession();
        const respawn = createDeferred<number>();
        Object.assign(session, { _mux: { muxSessionExists: () => true, respawnPane: () => respawn.promise } });
        (ctx.sessions as unknown as Map<string, Session>).set(session.id, session);
        session.shouldApplyInput('applied', 1);
        session.commitInputSeq('applied', 1);
        const lifecycle = session.reattachRemote();
        const before = session.getRecoveryContext().generation;
        const ownerIntent = vi.fn();
        session.on('recoveryUserInput', ownerIntent);
        const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
        try {
          expect(session.inputDispatchAllowed).toBe(false);
          if (transport === 'ws') {
            ws.send(JSON.stringify({ t: 'i', d: 'duplicate', cid: 'applied', seq: 1 }));
            await inputReceived(ws);
            expect(ws.readyState).toBe(WebSocket.OPEN);
          } else {
            await app.inject({
              method: 'POST',
              url: `/api/sessions/${session.id}/input`,
              payload: { input: 'duplicate', clientId: 'applied', seq: 1, wait: 'stop', waitTimeout: 5 },
            });
          }
          expect(session.getRecoveryContext().generation).toBe(before);
          expect(ownerIntent).not.toHaveBeenCalled();
          expect(written).not.toHaveBeenCalled();
        } finally {
          respawn.resolve(123);
          await lifecycle;
          ws.close();
          await session.stop(false);
        }
      }
    );

    it.each(['restart', 'reattach'] as const)(
      'closes an untagged socket when queued input crosses an actual %s pane epoch',
      async (action) => {
        const { session, written } = await isolatedRemoteWsSession();
        const mux = { isAvailable: () => true, muxSessionExists: () => true, respawnPane: vi.fn(async () => 123) };
        Object.assign(session, { _mux: mux });
        (ctx.sessions as unknown as Map<string, Session>).set(session.id, session);
        const blocker = createDeferred<void>();
        const queued = queueInputDispatch(session, 0, () => blocker.promise);
        const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
        const closed = waitForClose(ws);
        const before = session.paneStartedAt;
        try {
          for (const d of ['a', 'b', '\r']) ws.send(JSON.stringify({ t: 'i', d }));
          await inputReceived(ws);
          expect(await (action === 'restart' ? session.restartCli() : session.reattachRemote())).toBe(true);
          expect(session.paneStartedAt).toBeGreaterThan(before);
          blocker.resolve();
          await queued;
          expect(await closed).toEqual({ code: 4011, reason: 'Input delivery not confirmed' });
          expect(written).not.toHaveBeenCalled();
          expect(mux.respawnPane).toHaveBeenCalledTimes(1);
        } finally {
          blocker.resolve();
          await queued;
          ws.close();
          await session.stop(false);
        }
      }
    );

    it.each(['named-key', 'clock'] as const)(
      'closes an untagged socket while an actual %s operation owns input',
      async (operation) => {
        const { session, written } = await isolatedRemoteWsSession();
        (ctx.sessions as unknown as Map<string, Session>).set(session.id, session);
        const key = createDeferred<void>();
        const clock = createDeferred<remoteClock.RemoteClockWitness>();
        vi.spyOn(remoteClock, 'sampleRemoteCodexClock').mockReset().mockReturnValue(clock.promise);
        const held =
          operation === 'named-key'
            ? session.sendNamedKey('A', () => key.promise)
            : session.prepareUserInputClock('Owner prompt\r', { fromUser: true });
        const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
        const closed = waitForClose(ws);
        try {
          expect(session.recoveryInputReserved).toBe(true);
          for (const d of ['a', 'b', '\r']) ws.send(JSON.stringify({ t: 'i', d }));
          expect(await closed).toEqual({ code: 4011, reason: 'Input delivery not confirmed' });
          key.resolve();
          clock.resolve(currentClockWitness());
          await held;
          expect(written).not.toHaveBeenCalled();
          expect(session.lastInputSeq('legacy')).toBe(0);
        } finally {
          key.resolve();
          clock.resolve(currentClockWitness());
          await held;
          ws.close();
          await session.stop(false);
        }
      }
    );

    it.each(['false', 'partial'] as const)('closes legacy input after %s delivery without replay', async (outcome) => {
      const { session, written } = await isolatedRemoteWsSession();
      (ctx.sessions as unknown as Map<string, Session>).set(session.id, session);
      if (outcome === 'false') Object.assign(session, { ptyProcess: null });
      else
        written.mockImplementation(() => {
          throw new Error('Fixture partial dispatch');
        });
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      const closed = waitForClose(ws);
      ws.send(JSON.stringify({ t: 'i', d: 'once' }));
      ws.send(JSON.stringify({ t: 'i', d: 'tail' }));
      try {
        expect(await closed).toEqual({ code: 4011, reason: 'Input delivery not confirmed' });
        expect(written).toHaveBeenCalledTimes(outcome === 'partial' ? 1 : 0);
      } finally {
        ws.close();
        await session.stop(false);
      }
    });

    it.each(['recovery', 'named-key', 'remote-clock'])(
      'retains all three frames blocked by an actual Session %s reservation',
      async (owner) => {
        const thread = '11111111-2222-3333-4444-555555555555';
        const probe = createDeferred<{ dead: false; screen: string }>();
        const key = createDeferred<void>();
        const clock = createDeferred<remoteClock.RemoteClockWitness>();
        if (owner === 'remote-clock')
          vi.spyOn(remoteClock, 'sampleRemoteCodexClock').mockReset().mockReturnValue(clock.promise);
        const mux = {
          isAvailable: () => true,
          inspectPaneForRecovery: () => probe.promise,
          sendInput: vi.fn(async () => true),
        };
        const session = new Session({
          id: 'ws-test-session',
          workingDir: '/tmp',
          mode: 'codex',
          useMux: true,
          mux: mux as unknown as TerminalMultiplexer,
          muxSession: {
            muxName: 'codeman-ws-fixture',
            recoveryIsolated: true,
            recoveryCodexHome: '/fixture/codex-home',
          } as MuxSession,
          codexConfig: { noDaemon: true, resumeSessionId: thread },
          ...(owner === 'remote-clock'
            ? {
                remote: {
                  hostId: 'fixture',
                  label: 'Fixture',
                  host: 'worker.invalid',
                  username: 'fixture',
                  remotePath: '/tmp',
                  owned: true,
                },
                envOverrides: { CODEX_HOME: '/fixture/codex-home' },
              }
            : {}),
        });
        const written = vi.fn();
        Object.assign(session, { ptyProcess: { write: written } });
        (ctx.sessions as unknown as Map<string, Session>).set(session.id, session);
        expect(await session.ensureRecoveryIdentityFence()).toBe(true);
        const held =
          owner === 'remote-clock'
            ? session.prepareUserInputClock('Owner prompt\r', { fromUser: true })
            : owner === 'named-key'
              ? session.sendNamedKey('\n', () => key.promise)
              : session.deliverRecovery(
                  {
                    action: 'continue',
                    key: 'fixture',
                    conversationId: thread,
                    startedAt: Date.now(),
                  },
                  0
                );
        const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
        const received: unknown[] = [];
        ws.on('message', (raw) => received.push(JSON.parse(String(raw))));
        try {
          expect(session.recoveryInputReserved).toBe(true);
          for (let seq = 1; seq <= 3; seq++) ws.send(JSON.stringify({ t: 'i', d: `${seq}`, cid: 'locked', seq }));
          // Pong follows the preceding frames on this socket, proving they were handled.
          const pong = new Promise<void>((resolve) => ws.once('pong', () => resolve()));
          ws.ping();
          await pong;
          expect(session.lastInputSeq('locked')).toBe(0);
          expect(written).not.toHaveBeenCalled();
          expect(received).toEqual([]);
          key.resolve();
          clock.resolve({
            localBefore: Date.now(),
            localAfter: Date.now(),
            remoteBefore: Date.now(),
            remoteAfter: Date.now(),
          });
          probe.resolve({ dead: false, screen: '›\n  example-model high · /tmp\n' });
          await held;
          const acks = collectMessages(ws, 3);
          for (let seq = 1; seq <= 3; seq++) ws.send(JSON.stringify({ t: 'i', d: `${seq}`, cid: 'locked', seq }));
          expect(await acks).toEqual([
            { t: 'ia', seq: 1 },
            { t: 'ia', seq: 2 },
            { t: 'ia', seq: 3 },
          ]);
          expect(written.mock.calls.map(([data]) => data)).toEqual(['1', '2', '3']);
          expect(session.lastInputSeq('locked')).toBe(3);
          const dup = nextMessage(ws);
          ws.send(JSON.stringify({ t: 'i', d: '3', cid: 'locked', seq: 3 }));
          expect(await dup).toEqual({ t: 'ia', seq: 3, dup: true, last: 3 });
          expect(written).toHaveBeenCalledTimes(3);
        } finally {
          key.resolve();
          clock.resolve({
            localBefore: Date.now(),
            localAfter: Date.now(),
            remoteBefore: Date.now(),
            remoteAfter: Date.now(),
          });
          probe.resolve({ dead: false, screen: '›\n  example-model high · /tmp\n' });
          await held;
          ws.close();
          await session.stop(false);
        }
      }
    );

    it.each([false, true])(
      'preserves rapid remote owner input through SSH clock admission (tagged: %s)',
      async (tagged) => {
        const clock = createDeferred<remoteClock.RemoteClockWitness>();
        const witness = () => ({
          localBefore: Date.now(),
          localAfter: Date.now(),
          remoteBefore: Date.now(),
          remoteAfter: Date.now(),
        });
        const sampling = vi
          .spyOn(remoteClock, 'sampleRemoteCodexClock')
          .mockReset()
          .mockImplementation(async () => witness())
          .mockReturnValueOnce(clock.promise);
        const session = new Session({
          id: 'ws-test-session',
          workingDir: '/tmp',
          mode: 'codex',
          useMux: true,
          mux: { isAvailable: () => true } as unknown as TerminalMultiplexer,
          muxSession: {
            muxName: 'codeman-ws-fixture',
            recoveryIsolated: true,
            recoveryCodexHome: '/fixture/codex-home',
          } as MuxSession,
          codexConfig: { noDaemon: true, resumeSessionId: '11111111-2222-3333-4444-555555555555' },
          remote: {
            hostId: 'fixture',
            label: 'Fixture',
            host: 'worker.invalid',
            username: 'fixture',
            remotePath: '/tmp',
            owned: true,
          },
          envOverrides: { CODEX_HOME: '/fixture/codex-home' },
        });
        const written = vi.fn();
        Object.assign(session, { ptyProcess: { write: written, resize: vi.fn() } });
        (ctx.sessions as unknown as Map<string, Session>).set(session.id, session);
        const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
        const received: unknown[] = [];
        ws.on('message', (raw) => received.push(JSON.parse(String(raw))));
        expect(await session.ensureRecoveryIdentityFence()).toBe(true);
        const frames = ['first\r', 'n', 'e', 'x', 't', '\r'];
        try {
          for (const [index, d] of frames.entries())
            ws.send(JSON.stringify({ t: 'i', d, ...(tagged ? { cid: 'ordered-clock', seq: index + 1 } : {}) }));
          // A resize and pong are handled while ordinary owner input awaits SSH.
          const resized = nextMessage(ws);
          ws.send(JSON.stringify({ t: 'z', c: 100, r: 30 }));
          expect(await resized).toMatchObject({ t: 'zc' });
          await vi.waitFor(() => expect(sampling).toHaveBeenCalledOnce());
          expect(session.recoveryInputReserved).toBe(true);
          expect(written).not.toHaveBeenCalled();
          clock.resolve(witness());
          await vi.waitFor(() => expect(written.mock.calls.map(([data]) => data)).toEqual(frames));
          expect(sampling).toHaveBeenCalledTimes(2);
          if (tagged) {
            await vi.waitFor(() => expect(received.filter((msg) => (msg as { t: string }).t === 'ia')).toHaveLength(6));
            const duplicate = nextMessage(ws);
            ws.send(JSON.stringify({ t: 'i', d: '\r', cid: 'ordered-clock', seq: 6 }));
            expect(await duplicate).toEqual({ t: 'ia', seq: 6, dup: true, last: 6 });
            expect(written).toHaveBeenCalledTimes(6);
          } else expect(received.filter((msg) => (msg as { t: string }).t === 'ia')).toEqual([]);
        } finally {
          clock.resolve(witness());
          ws.close();
          await session.stop(false);
        }
      }
    );

    it.each(
      [false, true].flatMap((firstTagged) =>
        [false, true].flatMap((secondTagged) =>
          ['valid', 'missing', 'throw'].map((clockResult) => ({ firstTagged, secondTagged, clockResult }))
        )
      )
    )(
      'orders two sockets through $clockResult clock admission (first=$firstTagged second=$secondTagged)',
      async ({ firstTagged, secondTagged, clockResult }) => {
        const clock = createDeferred<remoteClock.RemoteClockWitness | undefined>();
        const sampling = vi
          .spyOn(remoteClock, 'sampleRemoteCodexClock')
          .mockReset()
          .mockImplementation(async () => currentClockWitness())
          .mockReturnValueOnce(clock.promise);
        const { session, written } = await isolatedRemoteWsSession();
        (ctx.sessions as unknown as Map<string, Session>).set(session.id, session);
        const admitted = vi.spyOn(session, 'deferInputSeq');
        const write = session.writeAsync;
        const receipts: Array<ReturnType<Session['getRecoveryContext']>['submission']> = [];
        vi.spyOn(session, 'writeAsync').mockImplementation(async (data, options) => {
          const sent = await write.call(session, data, options);
          if (data.includes('\r')) receipts.push(session.getRecoveryContext().submission);
          return sent;
        });
        const first = await connectWs('/ws/sessions/ws-test-session/terminal?cid=first-socket');
        const second = await connectWs('/ws/sessions/ws-test-session/terminal?cid=second-socket');
        const firstMessages: Array<{ t: string; seq?: number }> = [];
        const secondMessages: Array<{ t: string; seq?: number }> = [];
        first.on('message', (raw) => firstMessages.push(JSON.parse(String(raw))));
        second.on('message', (raw) => secondMessages.push(JSON.parse(String(raw))));
        const send = (ws: WebSocket, d: string, seq: number, tagged: boolean) =>
          ws.send(JSON.stringify({ t: 'i', d, ...(tagged ? { cid: 'shared-clock-client', seq } : {}) }));
        try {
          send(first, 'first\r', 1, firstTagged);
          await vi.waitFor(() => expect(sampling).toHaveBeenCalledTimes(1));
          send(first, 'A', 2, firstTagged);
          await inputReceived(first);
          send(second, 'B', 3, secondTagged);
          send(second, 'C', 4, secondTagged);
          send(second, '\r', 5, secondTagged);
          await inputReceived(second);
          if (firstTagged) expect(admitted).toHaveBeenCalledWith('shared-clock-client', 2);
          if (secondTagged)
            for (const seq of [3, 4, 5]) expect(admitted).toHaveBeenCalledWith('shared-clock-client', seq);
          expect(session.recoveryInputReserved).toBe(true);
          expect(written).not.toHaveBeenCalled();
          expect(sampling).toHaveBeenCalledTimes(1);
          const resized = nextMessage(second);
          second.send(JSON.stringify({ t: 'z', c: 100, r: 30 }));
          expect(await resized).toMatchObject({ t: 'zc' });
          if (clockResult === 'throw') clock.reject(new Error('Fixture clock transport unavailable'));
          else clock.resolve(clockResult === 'valid' ? currentClockWitness() : undefined);
          await vi.waitFor(() =>
            expect(written.mock.calls.map(([data]) => data)).toEqual(['first\r', 'A', 'B', 'C', '\r'])
          );
          expect(sampling).toHaveBeenCalledTimes(2);
          await vi.waitFor(() => {
            expect(firstMessages.filter((message) => message.t === 'ia').map((message) => message.seq)).toEqual(
              firstTagged ? [1, 2] : []
            );
            expect(secondMessages.filter((message) => message.t === 'ia').map((message) => message.seq)).toEqual(
              secondTagged ? [3, 4, 5] : []
            );
          });
          expect(receipts[0]?.hash).toBeDefined();
          if (clockResult === 'valid') expect(receipts[0]?.clockDomain).toBe('local');
          else expect(receipts[0]?.clock).toBeUndefined();
          if (firstTagged || secondTagged) {
            const socket = secondTagged ? second : first;
            const seq = secondTagged ? 5 : 2;
            const duplicate = nextMessage(socket);
            send(socket, secondTagged ? '\r' : 'A', seq, true);
            expect(await duplicate).toEqual({ t: 'ia', seq, dup: true, last: seq });
            expect(written).toHaveBeenCalledTimes(5);
          }
        } finally {
          clock.resolve(currentClockWitness());
          first.close();
          second.close();
          await session.stop(false);
        }
      }
    );

    it.each(
      [false, true].flatMap((tagged) => ['valid', 'missing', 'throw'].map((clockResult) => ({ tagged, clockResult })))
    )(
      'retains two sockets after HTTP clock admission ($clockResult, tagged=$tagged)',
      async ({ tagged, clockResult }) => {
        const clock = createDeferred<remoteClock.RemoteClockWitness | undefined>();
        const sampling = vi
          .spyOn(remoteClock, 'sampleRemoteCodexClock')
          .mockReset()
          .mockImplementation(async () => currentClockWitness())
          .mockReturnValueOnce(clock.promise);
        const { session, written } = await isolatedRemoteWsSession();
        (ctx.sessions as unknown as Map<string, Session>).set(session.id, session);
        const admitted = vi.spyOn(session, 'deferInputSeq');
        const first = await connectWs('/ws/sessions/ws-test-session/terminal?cid=http-first');
        const second = await connectWs('/ws/sessions/ws-test-session/terminal?cid=http-second');
        let request: Promise<Response> | undefined;
        try {
          request = fetch(`http://127.0.0.1:${PORT}/api/sessions/${session.id}/input`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              input: 'HTTP\r',
              useMux: false,
              ...(tagged ? { clientId: 'http-owner', seq: 1 } : {}),
            }),
          });
          await vi.waitFor(() => expect(sampling).toHaveBeenCalledTimes(1));
          first.send(JSON.stringify({ t: 'i', d: 'A', ...(tagged ? { cid: 'http-owner', seq: 2 } : {}) }));
          await inputReceived(first);
          second.send(JSON.stringify({ t: 'i', d: 'B', ...(tagged ? { cid: 'http-owner', seq: 3 } : {}) }));
          second.send(JSON.stringify({ t: 'i', d: '\r', ...(tagged ? { cid: 'http-owner', seq: 4 } : {}) }));
          await inputReceived(second);
          if (tagged) for (const seq of [2, 3, 4]) expect(admitted).toHaveBeenCalledWith('http-owner', seq);
          expect(written).not.toHaveBeenCalled();
          const resized = nextMessage(second);
          second.send(JSON.stringify({ t: 'z', c: 100, r: 30 }));
          expect(await resized).toMatchObject({ t: 'zc' });
          if (clockResult === 'throw') clock.reject(new Error('Fixture clock unavailable'));
          else clock.resolve(clockResult === 'valid' ? currentClockWitness() : undefined);
          expect((await request).status).toBe(200);
          await vi.waitFor(() => expect(written.mock.calls.map(([data]) => data)).toEqual(['HTTP\r', 'A', 'B', '\r']));
          expect(sampling).toHaveBeenCalledTimes(2);
          if (tagged) {
            await vi.waitFor(() => expect(session.lastInputSeq('http-owner')).toBe(4));
            const ack = nextMessage(second);
            second.send(JSON.stringify({ t: 'i', d: '\r', cid: 'http-owner', seq: 4 }));
            expect(await ack).toMatchObject({ t: 'ia', seq: 4, dup: true });
            expect(written).toHaveBeenCalledTimes(4);
          }
        } finally {
          clock.resolve(currentClockWitness());
          await request;
          first.close();
          second.close();
          await session.stop(false);
        }
      }
    );

    it.each(['closed-socket', 'aborted-http', 'closing-session', 'replaced-session', 'replaced-pane'] as const)(
      'retains current owner input and cancellation vetoes after HTTP admission: %s',
      async (change) => {
        const clock = createDeferred<remoteClock.RemoteClockWitness>();
        const sampling = vi
          .spyOn(remoteClock, 'sampleRemoteCodexClock')
          .mockReset()
          .mockImplementation(async () => currentClockWitness())
          .mockReturnValueOnce(clock.promise);
        const { session, written } = await isolatedRemoteWsSession();
        (ctx.sessions as unknown as Map<string, Session>).set(session.id, session);
        const first = await connectWs('/ws/sessions/ws-test-session/terminal?cid=http-cancel-first');
        const second = await connectWs('/ws/sessions/ws-test-session/terminal?cid=http-cancel-second');
        const abort = new AbortController();
        const httpClosed = createDeferred<void>();
        const observeHttp = (req: IncomingMessage) => {
          if (req.url?.endsWith('/input')) req.socket.once('close', () => httpClosed.resolve());
        };
        app.server.on('request', observeHttp);
        const request = fetch(`http://127.0.0.1:${PORT}/api/sessions/${session.id}/input`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: abort.signal,
          body: JSON.stringify({ input: 'HTTP\r', useMux: false }),
        }).catch(() => undefined);
        let replacement: Awaited<ReturnType<typeof isolatedRemoteWsSession>> | undefined;
        try {
          await vi.waitFor(() => expect(sampling).toHaveBeenCalledTimes(1));
          first.send(JSON.stringify({ t: 'i', d: 'A' }));
          await inputReceived(first);
          second.send(JSON.stringify({ t: 'i', d: 'B' }));
          await inputReceived(second);
          if (change === 'closed-socket') {
            const closed = waitForClose(first);
            first.close();
            await closed;
          } else if (change === 'aborted-http') {
            abort.abort();
            await request;
            await httpClosed.promise;
          } else if (change === 'closing-session') session.markClosing(true);
          else if (change === 'replaced-session') {
            replacement = await isolatedRemoteWsSession();
            (ctx.sessions as unknown as Map<string, Session>).set(session.id, replacement.session);
          } else Object.assign(session, { _paneStartedAt: session.paneStartedAt + 1 });
          const rejected = ['closing-session', 'replaced-session', 'replaced-pane'].includes(change)
            ? waitForClose(second)
            : undefined;
          clock.resolve(currentClockWitness());
          await request;
          const expected = change === 'closed-socket' ? ['HTTP\r', 'B'] : change === 'aborted-http' ? ['A', 'B'] : [];
          await vi.waitFor(() => expect(written.mock.calls.map(([data]) => data)).toEqual(expected));
          if (rejected) expect((await rejected).code).toBe(4011);
          else await inputReceived(second);
          expect(written.mock.calls.map(([data]) => data)).toEqual(expected);
        } finally {
          clock.resolve(currentClockWitness());
          await request;
          first.close();
          second.close();
          await session.stop(false);
          await replacement?.session.stop(false);
          app.server.off('request', observeHttp);
        }
      }
    );

    it('refuses HTTP and named-key overflow before effects and retries after the shared backlog drains', async () => {
      const heldMux = createDeferred<boolean>();
      const { session, written } = await isolatedRemoteWsSession();
      (ctx.sessions as unknown as Map<string, Session>).set(session.id, session);
      const muxWrite = vi.spyOn(session, 'writeViaMux').mockReturnValueOnce(heldMux.promise);
      const socket = await connectWs('/ws/sessions/ws-test-session/terminal?cid=shared-overflow');
      const post = (path: string, body: unknown) =>
        fetch(`http://127.0.0.1:${PORT}/api/sessions/${session.id}/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      const request = post('input', { input: 'HTTP', useMux: true });
      try {
        await vi.waitFor(() => expect(muxWrite).toHaveBeenCalledTimes(1));
        const tail = 'a'.repeat(MAX_INPUT_LENGTH - 4);
        socket.send(JSON.stringify({ t: 'i', d: tail }));
        await inputReceived(socket);
        const refused = await (
          await post('input', { input: 'Z', useMux: false, clientId: 'overflow-owner', seq: 1 })
        ).json();
        expect(refused).toMatchObject({ success: false, retryable: true, notSent: true });
        const keyRefused = await (await post('send-key', { key: 'C-Enter' })).json();
        expect(keyRefused).toMatchObject({ success: false, retryable: true, notSent: true });
        expect(childProcess.execFile).not.toHaveBeenCalled();
        expect(written).not.toHaveBeenCalled();
        heldMux.resolve(true);
        await request;
        await vi.waitFor(() => expect(written.mock.calls.map(([data]) => data)).toEqual([tail]));
        const retry = await post('input', { input: 'Z', useMux: false, clientId: 'overflow-owner', seq: 1 });
        expect(await retry.json()).toEqual({});
        expect(written.mock.calls.map(([data]) => data)).toEqual([tail, 'Z']);
        childProcess.execFile.mockImplementation((_cmd, _args, _options, callback) => callback(null));
        expect(await (await post('send-key', { key: 'C-Enter' })).json()).toEqual({});
        expect(childProcess.execFile).toHaveBeenCalledTimes(1);
      } finally {
        heldMux.resolve(true);
        await request;
        socket.close();
        await session.stop(false);
      }
    });

    it.each([false, true])(
      'keeps socket input behind named-key dispatch (unknown child failure=%s)',
      async (failed) => {
        vi.spyOn(remoteClock, 'sampleRemoteCodexClock')
          .mockReset()
          .mockImplementation(async () => currentClockWitness());
        const { session, written } = await isolatedRemoteWsSession();
        (ctx.sessions as unknown as Map<string, Session>).set(session.id, session);
        const first = await connectWs('/ws/sessions/ws-test-session/terminal?cid=key-first');
        const second = await connectWs('/ws/sessions/ws-test-session/terminal?cid=key-second');
        let finishKey: ((error: Error | null) => void) | undefined;
        childProcess.execFile.mockImplementation((_cmd, _args, _options, callback) => {
          finishKey = callback;
        });
        const request = fetch(`http://127.0.0.1:${PORT}/api/sessions/${session.id}/send-key`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: 'S-Enter' }),
        });
        try {
          await vi.waitFor(() => expect(finishKey).toBeDefined());
          first.send(JSON.stringify({ t: 'i', d: 'A' }));
          await inputReceived(first);
          second.send(JSON.stringify({ t: 'i', d: 'B', cid: 'key-owner', seq: 1 }));
          await inputReceived(second);
          expect(written).not.toHaveBeenCalled();
          finishKey!(failed ? new Error('Fixture unknown child outcome') : null);
          const response = await request;
          const body = await response.json();
          if (failed) {
            expect(body).toMatchObject({ success: false });
            expect(body.notSent).toBeUndefined();
          }
          await vi.waitFor(() => expect(written.mock.calls.map(([data]) => data)).toEqual(['A', 'B']));
          expect(childProcess.execFile).toHaveBeenCalledTimes(1);
          expect(childProcess.execFile.mock.calls[0]?.[1]).toEqual([
            '-L',
            ctx.mux.muxSocket,
            'send-keys',
            '-H',
            '-t',
            session.muxName,
            '0a',
          ]);
        } finally {
          finishKey?.(null);
          await request;
          first.close();
          second.close();
          await session.stop(false);
        }
      }
    );

    it.each(['closed-second', 'closed-first', 'superseded-first', 'replaced-session'] as const)(
      'keeps per-socket and exact Session vetoes after $0 while another socket is queued',
      async (change) => {
        const clock = createDeferred<remoteClock.RemoteClockWitness>();
        const sampling = vi
          .spyOn(remoteClock, 'sampleRemoteCodexClock')
          .mockReset()
          .mockImplementation(async () => currentClockWitness())
          .mockReturnValueOnce(clock.promise);
        const { session, written } = await isolatedRemoteWsSession();
        (ctx.sessions as unknown as Map<string, Session>).set(session.id, session);
        const first = await connectWs('/ws/sessions/ws-test-session/terminal?cid=replaceable-first');
        const second = await connectWs('/ws/sessions/ws-test-session/terminal?cid=independent-second');
        let replacementSocket: WebSocket | undefined;
        let replacementSession: Session | undefined;
        try {
          first.send(JSON.stringify({ t: 'i', d: 'first\r', cid: 'first-frame', seq: 1 }));
          await vi.waitFor(() => expect(sampling).toHaveBeenCalledTimes(1));
          second.send(JSON.stringify({ t: 'i', d: 'second' }));
          await inputReceived(second);
          if (change === 'closed-second') {
            const closed = waitForClose(second);
            second.close();
            await closed;
            first.send(JSON.stringify({ t: 'i', d: 'tail', cid: 'first-frame', seq: 2 }));
            await inputReceived(first);
          } else if (change === 'closed-first') {
            const closed = waitForClose(first);
            first.close();
            await closed;
          } else if (change === 'superseded-first') {
            const closed = waitForClose(first);
            replacementSocket = await connectWs('/ws/sessions/ws-test-session/terminal?cid=replaceable-first');
            expect((await closed).code).toBe(4010);
            replacementSocket.send(JSON.stringify({ t: 'i', d: 'first\r', cid: 'first-frame', seq: 1 }));
            await inputReceived(replacementSocket);
          } else {
            const replacement = await isolatedRemoteWsSession();
            replacementSession = replacement.session;
            (ctx.sessions as unknown as Map<string, Session>).set(session.id, replacementSession);
            replacementSocket = await connectWs('/ws/sessions/ws-test-session/terminal?cid=new-session');
            const ack = nextMessage(replacementSocket);
            replacementSocket.send(JSON.stringify({ t: 'i', d: 'new\r', cid: 'new-frame', seq: 1 }));
            expect(await ack).toEqual({ t: 'ia', seq: 1 });
            expect(replacement.written.mock.calls.map(([data]) => data)).toEqual(['new\r']);
            expect(written).not.toHaveBeenCalled();
          }
          const rejectedSecond = change === 'replaced-session' ? waitForClose(second) : undefined;
          clock.resolve(currentClockWitness());
          await vi.waitFor(() => expect(session.recoveryInputReserved).toBe(false));
          if (change === 'closed-second')
            await vi.waitFor(() => expect(written.mock.calls.map(([data]) => data)).toEqual(['first\r', 'tail']));
          if (change === 'closed-first') {
            await vi.waitFor(() => expect(written.mock.calls.map(([data]) => data)).toEqual(['second']));
            expect(session.lastInputSeq('first-frame')).toBe(0);
          }
          if (change === 'superseded-first') {
            await vi.waitFor(() => expect(written.mock.calls.map(([data]) => data)).toEqual(['second', 'first\r']));
            expect(session.lastInputSeq('first-frame')).toBe(1);
          }
          if (change === 'replaced-session') {
            expect((await rejectedSecond!).code).toBe(4011);
            expect(written).not.toHaveBeenCalled();
            expect(session.lastInputSeq('first-frame')).toBe(0);
          }
        } finally {
          clock.resolve(currentClockWitness());
          first.close();
          second.close();
          replacementSocket?.close();
          await session.stop(false);
          await replacementSession?.stop(false);
        }
      }
    );

    it.each(['bytes', 'frames'] as const)(
      'keeps reliable input retryable after shared %s backlog saturation without changing delivery proof',
      async (limit) => {
        const { session, written } = await isolatedRemoteWsSession();
        (ctx.sessions as unknown as Map<string, Session>).set(session.id, session);
        const socket = await connectWs('/ws/sessions/ws-test-session/terminal?cid=retry-backlog');
        let retry: WebSocket | undefined;
        const held = createDeferred<void>();
        const entered = createDeferred<void>();
        const pending: Promise<void>[] = [];
        try {
          const firstAck = nextMessage(socket);
          socket.send(JSON.stringify({ t: 'i', d: 'committed', cid: 'backlog-client', seq: 1 }));
          expect(await firstAck).toEqual({ t: 'ia', seq: 1 });
          expect(written.mock.calls.map(([data]) => data)).toEqual(['committed']);
          pending.push(
            queueInputDispatch(session, limit === 'bytes' ? MAX_INPUT_LENGTH : 1, async () => {
              entered.resolve();
              await held.promise;
            })
          );
          if (limit === 'frames')
            for (let i = 1; i < 512; i++) pending.push(queueInputDispatch(session, 1, async () => {}));
          await entered.promise;
          const defer = vi.spyOn(session, 'deferInputSeq');
          const received: unknown[] = [];
          socket.on('message', (raw) => received.push(JSON.parse(String(raw))));
          const rejected = new Promise<unknown>((resolve) => {
            socket.once('close', (code) => resolve({ closed: code }));
            socket.once('message', (raw) => resolve({ ack: JSON.parse(String(raw)) }));
          });
          socket.send(JSON.stringify({ t: 'i', d: 'retained paste', cid: 'backlog-client', seq: 2 }));
          expect(await rejected).toEqual({ closed: 4008 });
          expect(received).toEqual([]);
          expect(defer).not.toHaveBeenCalled();
          expect(session.lastInputSeq('backlog-client')).toBe(1);
          expect(session.hasAppliedInputSeq('backlog-client', 2)).toBe(false);
          expect(written.mock.calls.map(([data]) => data)).toEqual(['committed']);
          held.resolve();
          await Promise.all(pending);
          retry = await connectWs('/ws/sessions/ws-test-session/terminal?cid=retry-backlog');
          const acks = collectMessages(retry, 3);
          // Include a previously committed occurrence whose ACK was lost. It
          // keeps its identity and must never become another native write.
          retry.send(JSON.stringify({ t: 'i', d: 'committed', cid: 'backlog-client', seq: 1 }));
          retry.send(JSON.stringify({ t: 'i', d: 'retained paste', cid: 'backlog-client', seq: 2 }));
          retry.send(JSON.stringify({ t: 'i', d: 'following text', cid: 'backlog-client', seq: 3 }));
          expect(await acks).toEqual([
            { t: 'ia', seq: 1, dup: true, last: 1 },
            { t: 'ia', seq: 2 },
            { t: 'ia', seq: 3 },
          ]);
          expect(written.mock.calls.map(([data]) => data)).toEqual(['committed', 'retained paste', 'following text']);
          expect(session.lastInputSeq('backlog-client')).toBe(3);
        } finally {
          held.resolve();
          await Promise.all(pending);
          socket.close();
          retry?.close();
          await session.stop(false);
        }
      }
    );

    it.each(['bytes', 'frames'] as const)(
      'bounds the combined %s backlog across independent session sockets',
      async (limit) => {
        const clock = createDeferred<remoteClock.RemoteClockWitness>();
        const sampling = vi.spyOn(remoteClock, 'sampleRemoteCodexClock').mockReset().mockReturnValue(clock.promise);
        const { session, written } = await isolatedRemoteWsSession();
        (ctx.sessions as unknown as Map<string, Session>).set(session.id, session);
        const first = await connectWs('/ws/sessions/ws-test-session/terminal?cid=quota-first');
        const second = await connectWs('/ws/sessions/ws-test-session/terminal?cid=quota-second');
        const admittedFirst =
          limit === 'bytes' ? ['x'.repeat(Math.floor(MAX_INPUT_LENGTH / 2))] : Array.from({ length: 255 }, () => 'a');
        try {
          first.send(JSON.stringify({ t: 'i', d: 'first\r', cid: 'quota-client', seq: 1 }));
          await vi.waitFor(() => expect(sampling).toHaveBeenCalledTimes(1));
          for (const d of admittedFirst) first.send(JSON.stringify({ t: 'i', d }));
          await inputReceived(first);
          const closed = waitForClose(second);
          if (limit === 'bytes')
            second.send(JSON.stringify({ t: 'i', d: 'y'.repeat(Math.floor(MAX_INPUT_LENGTH / 2)) }));
          else {
            for (let i = 0; i < 257; i++) second.send(JSON.stringify({ t: 'i', d: 'b' }));
          }
          expect((await closed).code).toBe(4008);
          expect(written).not.toHaveBeenCalled();
          clock.resolve(currentClockWitness());
          await vi.waitFor(() =>
            expect(written.mock.calls.map(([data]) => data)).toEqual(['first\r', ...admittedFirst])
          );
          expect(session.lastInputSeq('quota-client')).toBe(1);
        } finally {
          clock.resolve(currentClockWitness());
          first.close();
          second.close();
          await session.stop(false);
        }
      }
    );

    it.each(['owner close', 'legacy byte overflow', 'legacy frame overflow'] as const)(
      'drops queued input without dispatch or delivery ACK after %s',
      async (cause) => {
        const clock = createDeferred<remoteClock.RemoteClockWitness>();
        const sampling = vi.spyOn(remoteClock, 'sampleRemoteCodexClock').mockReset().mockReturnValue(clock.promise);
        const session = ctx._session;
        session.requiresRemoteInputClock = vi.fn(() => true);
        session.prepareUserInputClock = vi.fn(async () => {
          await sampling({} as never);
          return () => true;
        });
        const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
        try {
          ws.send(JSON.stringify({ t: 'i', d: 'first\r', cid: 'closed', seq: 1 }));
          await vi.waitFor(() => expect(sampling).toHaveBeenCalledTimes(1));
          ws.send(JSON.stringify({ t: 'i', d: 'queued', cid: 'closed', seq: 2 }));
          const closed = waitForClose(ws);
          if (cause === 'owner close') ws.close();
          else if (cause === 'legacy byte overflow')
            ws.send(JSON.stringify({ t: 'i', d: 'x'.repeat(MAX_INPUT_LENGTH) }));
          else for (let i = 0; i < 512; i++) ws.send(JSON.stringify({ t: 'i', d: 'x' }));
          expect((await closed).code).toBe(cause === 'owner close' ? 1005 : 4008);
          clock.resolve({ localBefore: 1, localAfter: 1, remoteBefore: 1, remoteAfter: 1 });
          await vi.waitFor(() => expect(session.prepareUserInputClock).toHaveBeenCalledTimes(1));
          expect(session.writeBuffer).toEqual([]);
          expect(session.lastInputSeq('closed')).toBe(0);
        } finally {
          clock.resolve({ localBefore: 1, localAfter: 1, remoteBefore: 1, remoteAfter: 1 });
          ws.close();
        }
      }
    );

    it('does not invent watermarks for sparse failed writes on the actual Session', async () => {
      const session = new Session({ id: 'ws-test-session', workingDir: '/tmp', mode: 'shell' });
      (ctx.sessions as unknown as Map<string, Session>).set(session.id, session);
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        for (const seq of [7, 100]) ws.send(JSON.stringify({ t: 'i', d: `${seq}`, cid: 'gap', seq }));
        const pong = new Promise<void>((resolve) => ws.once('pong', () => resolve()));
        ws.ping();
        await pong;
        expect(session.lastInputSeq('gap')).toBe(0);
        const written = vi.fn();
        Object.assign(session, { ptyProcess: { write: written } });
        const acks = collectMessages(ws, 2);
        for (const seq of [7, 100]) ws.send(JSON.stringify({ t: 'i', d: `${seq}`, cid: 'gap', seq }));
        expect(await acks).toEqual([
          { t: 'ia', seq: 7 },
          { t: 'ia', seq: 100 },
        ]);
        expect(written.mock.calls.map(([data]) => data)).toEqual(['7', '100']);
        expect(session.lastInputSeq('gap')).toBe(100);
      } finally {
        ws.close();
        await session.stop(false);
      }
    });
    it('forwards input messages to session.write()', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'i', d: 'ls -la\r' }));

        // Give the message handler time to process
        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('ls -la\r');
        });
      } finally {
        ws.close();
      }
    });

    it('ACKs a delivered input and burns its seq', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;
        ws.send(JSON.stringify({ t: 'i', d: 'ok\r', cid: 'c1', seq: 1 }));

        expect(await nextMessage(ws)).toEqual({ t: 'ia', seq: 1 });
        expect(session.shouldApplyInput('c1', 1)).toBe(false);
      } finally {
        ws.close();
      }
    });

    it('withholds the ACK and re-opens the seq when the write did not land', async () => {
      // A session whose PTY is gone swallows the write. ACKing anyway told the
      // client to drop the frame from its durable queue while the seq stayed
      // burnt, so the retry that reliable delivery exists for was rejected as a
      // duplicate — the input was lost for good.
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;
        session.failWrites = true;

        ws.send(JSON.stringify({ t: 'i', d: 'lost\r', cid: 'c1', seq: 1 }));

        await expect(nextMessage(ws, 600)).rejects.toThrow(/timeout/);
        expect(session.shouldApplyInput('c1', 1)).toBe(true);
      } finally {
        ws.close();
      }
    });

    it('still ACKs a duplicate frame the server deliberately skipped', async () => {
      // Dedup must stay silent-but-acknowledged: the client has to be able to
      // drop a frame it already delivered once.
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;
        session.shouldApplyInput('c1', 7);
        session.commitInputSeq('c1', 7); // pretend seq 7 already landed

        ws.send(JSON.stringify({ t: 'i', d: 'again\r', cid: 'c1', seq: 7 }));

        // The ACK now SAYS it was a duplicate and hands back the watermark: a bare
        // ACK is indistinguishable from "applied", and that ambiguity left a client
        // whose seq counter had rolled back silently unable to type at all.
        expect(await nextMessage(ws)).toEqual({ t: 'ia', seq: 7, dup: true, last: 7 });
        expect(session.writeBuffer).not.toContain('again\r');
      } finally {
        ws.close();
      }
    });

    it('ignores input exceeding MAX_INPUT_LENGTH', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        const hugeInput = 'x'.repeat(MAX_INPUT_LENGTH + 1);
        ws.send(JSON.stringify({ t: 'i', d: hugeInput }));

        // Send a valid message after to confirm the connection still works
        ws.send(JSON.stringify({ t: 'i', d: 'ok' }));

        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('ok');
        });

        // The oversized input should not have been written
        expect(session.writeBuffer).not.toContain(hugeInput);
      } finally {
        ws.close();
      }
    });

    it('refuses an oversized sequenced frame with an error ACK, so the client can drop it', async () => {
      // Issue #484: a silent return left the frame unACKed, and the client's
      // durable queue re-sent it every few seconds forever.
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;
        const hugeInput = 'y'.repeat(MAX_INPUT_LENGTH + 1);
        ws.send(JSON.stringify({ t: 'i', d: hugeInput, cid: 'c1', seq: 3 }));

        expect(await nextMessage(ws)).toEqual({ t: 'ia', seq: 3, err: 'too_large', max: MAX_INPUT_LENGTH });
        expect(session.writeBuffer).not.toContain(hugeInput);
      } finally {
        ws.close();
      }
    });

    it('ignores malformed JSON messages', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send('not-json{{{');

        // Send valid input to verify connection still alive
        ws.send(JSON.stringify({ t: 'i', d: 'after-bad' }));

        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('after-bad');
        });

        // Only 'after-bad' should be in the buffer
        expect(session.writeBuffer).toHaveLength(1);
      } finally {
        ws.close();
      }
    });

    it('ignores unknown message types without breaking the connection', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        // Send unknown type
        ws.send(JSON.stringify({ t: 'x', d: 'mystery' }));

        // Connection should still work
        ws.send(JSON.stringify({ t: 'i', d: 'still-alive' }));

        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('still-alive');
        });

        // Unknown type should not have been written
        expect(session.writeBuffer).toHaveLength(1);
      } finally {
        ws.close();
      }
    });
  });

  // ========== Resize validation ===

  describe('resize validation', () => {
    it('accepts valid resize within bounds', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 120, r: 40 }));

        await vi.waitFor(() => {
          expect(session.resize).toHaveBeenCalledWith(120, 40, { viewportType: undefined, force: false });
        });
      } finally {
        ws.close();
      }
    });

    it('passes viewport type through for resize arbitration', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 48, r: 28, v: 'mobile' }));

        await vi.waitFor(() => {
          expect(session.resize).toHaveBeenCalledWith(48, 28, { viewportType: 'mobile', force: false });
        });
      } finally {
        ws.close();
      }
    });

    it('passes force resize through for redraw requests', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 120, r: 40, f: true }));

        await vi.waitFor(() => {
          expect(session.resize).toHaveBeenCalledWith(120, 40, { viewportType: undefined, force: true });
        });
      } finally {
        ws.close();
      }
    });

    it('claims desktop sizing on a desktop resize and releases it on close', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      const session = ctx._session;
      try {
        ws.send(JSON.stringify({ t: 'z', c: 160, r: 48, v: 'desktop' }));

        await vi.waitFor(() => {
          expect(session.claimDesktopSizing).toHaveBeenCalledTimes(1);
        });
        const token = session.claimDesktopSizing.mock.calls[0][0];

        // A later small-viewport resize on the SAME connection drops the claim
        // (window narrowed past the breakpoint).
        ws.send(JSON.stringify({ t: 'z', c: 48, r: 28, v: 'tablet' }));
        await vi.waitFor(() => {
          expect(session.releaseDesktopSizing).toHaveBeenCalledWith(token);
        });
      } finally {
        ws.close();
      }

      // Socket close releases the claim again (idempotent set delete).
      await vi.waitFor(() => {
        expect(session.releaseDesktopSizing.mock.calls.length).toBeGreaterThanOrEqual(2);
      });
    });

    it('accepts resize at minimum bounds (1x1)', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 1, r: 1 }));

        await vi.waitFor(() => {
          expect(session.resize).toHaveBeenCalledWith(1, 1, { viewportType: undefined, force: false });
        });
      } finally {
        ws.close();
      }
    });

    it('accepts resize at maximum bounds (500x200)', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 500, r: 200 }));

        await vi.waitFor(() => {
          expect(session.resize).toHaveBeenCalledWith(500, 200, { viewportType: undefined, force: false });
        });
      } finally {
        ws.close();
      }
    });

    it('rejects resize with cols out of bounds (0 cols)', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 0, r: 40 }));

        // Send a valid message to confirm processing continues
        ws.send(JSON.stringify({ t: 'i', d: 'sentinel' }));
        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('sentinel');
        });

        expect(session.resize).not.toHaveBeenCalled();
      } finally {
        ws.close();
      }
    });

    it('rejects resize with cols exceeding 500', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 501, r: 40 }));

        ws.send(JSON.stringify({ t: 'i', d: 'sentinel' }));
        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('sentinel');
        });

        expect(session.resize).not.toHaveBeenCalled();
      } finally {
        ws.close();
      }
    });

    it('rejects resize with rows exceeding 200', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 80, r: 201 }));

        ws.send(JSON.stringify({ t: 'i', d: 'sentinel' }));
        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('sentinel');
        });

        expect(session.resize).not.toHaveBeenCalled();
      } finally {
        ws.close();
      }
    });

    it('rejects resize with non-integer values', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 80.5, r: 24 }));

        ws.send(JSON.stringify({ t: 'i', d: 'sentinel' }));
        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('sentinel');
        });

        expect(session.resize).not.toHaveBeenCalled();
      } finally {
        ws.close();
      }
    });

    it('rejects resize with negative values', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: -1, r: 24 }));

        ws.send(JSON.stringify({ t: 'i', d: 'sentinel' }));
        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('sentinel');
        });

        expect(session.resize).not.toHaveBeenCalled();
      } finally {
        ws.close();
      }
    });
  });

  // ========== Connection limit ===

  describe('connection limit', () => {
    it('closes with 4008 when too many connections per session', async () => {
      const connections: WebSocket[] = [];
      try {
        // Open 5 connections (the max)
        for (let i = 0; i < 5; i++) {
          connections.push(await connectWs('/ws/sessions/ws-test-session/terminal'));
        }

        // 6th connection should be rejected
        const ws6 = new WebSocket(`ws://127.0.0.1:${PORT}/ws/sessions/ws-test-session/terminal`);
        const { code, reason } = await waitForClose(ws6);
        expect(code).toBe(4008);
        expect(reason).toBe('Too many connections');
      } finally {
        for (const ws of connections) ws.close();
      }
    });

    it('reconnecting client (same cid) is admitted at the cap instead of 4008 (COD-137)', async () => {
      const connections: WebSocket[] = [];
      try {
        // Fill all 5 slots with DISTINCT clients, one of which is "alice".
        for (const c of ['alice', 'b', 'c', 'd', 'e']) {
          connections.push(await connectWs(`/ws/sessions/ws-test-session/terminal?cid=${c}`));
        }

        // Alice reconnects WHILE her old socket is still registered (the
        // over-count window). This must reclaim her slot, not hit the cap.
        const aliceNew = await connectWs('/ws/sessions/ws-test-session/terminal?cid=alice');
        connections.push(aliceNew);

        // Sanity: the reconnected socket is live and usable.
        ctx._session.emit('terminal', 'reconnected-ok');
        const msg = (await nextMessage(aliceNew)) as { t: string; d: string };
        expect(msg.t).toBe('o');
        expect(msg.d).toContain('reconnected-ok');
      } finally {
        for (const ws of connections) ws.close();
      }
    });
  });

  // ========== Heartbeat ===

  describe('heartbeat', () => {
    it('responds to server ping with pong (connection stays alive)', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        // The ws library automatically responds to pings with pongs.
        // Verify the connection survives by sending data after a brief delay.
        const session = ctx._session;
        session.emit('terminal', 'heartbeat-test');

        const msg = (await nextMessage(ws)) as { t: string; d: string };
        expect(msg.t).toBe('o');
        expect(msg.d).toContain('heartbeat-test');
      } finally {
        ws.close();
      }
    });
  });

  // ========== readyState guards ===

  describe('readyState guards', () => {
    it('does not throw when clearTerminal fires after close', async () => {
      const session = ctx._session;
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');

      ws.close();
      await waitForClose(ws);

      // These should be no-ops, not throw
      expect(() => session.emit('clearTerminal')).not.toThrow();
      expect(() => session.emit('needsRefresh')).not.toThrow();
    });
  });

  // ========== Connection cleanup ===

  describe('connection cleanup', () => {
    it('removes session event listeners on close', async () => {
      const session = ctx._session;
      const listenersBefore = session.listenerCount('terminal');

      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');

      // A listener was added for 'terminal'
      expect(session.listenerCount('terminal')).toBe(listenersBefore + 1);
      expect(session.listenerCount('clearTerminal')).toBeGreaterThanOrEqual(1);
      expect(session.listenerCount('needsRefresh')).toBeGreaterThanOrEqual(1);

      // Close the WS connection
      ws.close();
      await waitForClose(ws);

      // Wait for server-side close handler
      await vi.waitFor(() => {
        expect(session.listenerCount('terminal')).toBe(listenersBefore);
      });

      expect(session.listenerCount('clearTerminal')).toBe(0);
      expect(session.listenerCount('needsRefresh')).toBe(0);
    });
  });
});
