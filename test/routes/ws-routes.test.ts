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
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import WebSocket from 'ws';
import { createMockRouteContext, createDeferred, type MockRouteContext } from '../mocks/index.js';
import { registerWsRoutes } from '../../src/web/routes/ws-routes.js';
import { MAX_INPUT_LENGTH } from '../../src/config/terminal-limits.js';
import { RebootIdentityFenceError } from '../../src/recovery/reboot-identity-fence.js';
import { Session } from '../../src/session.js';
import type { MuxSession, TerminalMultiplexer } from '../../src/mux-interface.js';
import * as remoteClock from '../../src/recovery/remote-clock.js';

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

describe('ws-routes', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);

    ctx = createMockRouteContext({ sessionId: 'ws-test-session' });
    registerWsRoutes(app, ctx as never, () => ({ bindHost: '127.0.0.1', allowedHosts: [], tunnelHost: null }));

    await app.listen({ port: 0, host: '127.0.0.1' });
    PORT = (app.server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await app.close();
  });

  // ========== Session not found ==========

  describe('session not found', () => {
    it('closes with 4004 when session does not exist', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/sessions/nonexistent/terminal`);
      const { code, reason } = await waitForClose(ws);
      expect(code).toBe(4004);
      expect(reason).toBe('Session not found');
    });
  });

  // ========== Terminal output ==========

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

  // ========== Client input ==========

  describe('client input', () => {
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
    it.each(['recovery', 'named-key', 'remote-clock'])(
      'retains all three frames blocked by an actual Session %s reservation',
      async (owner) => {
        const thread = '11111111-2222-3333-4444-555555555555';
        const probe = createDeferred<{ dead: false; screen: string }>();
        const key = createDeferred<void>();
        const clock = createDeferred<remoteClock.RemoteClockWitness>();
        if (owner === 'remote-clock') vi.spyOn(remoteClock, 'sampleRemoteCodexClock').mockReturnValue(clock.promise);
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

  // ========== Resize validation ==========

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

  // ========== Connection limit ==========

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

  // ========== Heartbeat ==========

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

  // ========== readyState guards ==========

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

  // ========== Connection cleanup ==========

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
