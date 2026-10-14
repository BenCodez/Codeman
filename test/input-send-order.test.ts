/**
 * @fileoverview Input dispatch ordering for the durable, acknowledged delivery
 * layer (`CodemanApp._sendInputAsync` → `_reliableSend` → `_drainSession`).
 *
 * Local replaced the upstream best-effort "coalescing fallback queue" with the
 * durable per-(clientId, seq) layer in commit 1255e28 (docs/reliable-input-
 * delivery.md). This suite verifies the client-side ordering guarantees of that
 * layer: each input is a distinct seq-tagged frame, delivered in order over the
 * WebSocket when open, serialized over HTTP POST when not, and only dropped on a
 * server ACK (HTTP 2xx). Exactly-once application is covered server-side in
 * test/reliable-input-dedup.test.ts; the header transport indicator ("WS"/"HTTP")
 * is covered in test/connection-indicator.test.ts.
 *
 * Loaded via `vm` with a stubbed context (no jsdom).
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadCodemanAppClass() {
  const constants = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
  const context = vm.createContext({
    console,
    performance,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    HTMLCanvasElement: class HTMLCanvasElement {},
    AbortController,
    WebSocket: { OPEN: 1 },
    fetch: (...args: Parameters<typeof fetch>) => global.fetch(...args),
    document: { addEventListener: vi.fn() },
    localStorage: {
      length: 0,
      key: vi.fn(),
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    MobileDetection: {},
  });
  vm.runInContext(`${constants}\n${source}\nglobalThis.__CodemanApp = CodemanApp;`, context);
  return (context as { __CodemanApp: new () => unknown }).__CodemanApp;
}

const CodemanApp = loadCodemanAppClass();

async function waitForCalls(calls: unknown[], count: number) {
  for (let i = 0; i < 50; i++) {
    if (calls.length >= count) return;
    await new Promise((r) => setTimeout(r, 0));
  }
}

type Frame = { t: string; d: string; seq: number; cid: string };
type PostBody = { input: string; seq: number; clientId: string };

type App = {
  _sendInputAsync: (sessionId: string, input: string, opts?: { useMux?: boolean }) => void;
  _sendNamedKey: (sessionId: string, key: string, owner: object, delayMs?: number) => void;
  _cancelPendingKeys: (owner: object) => void;
  _drainSession: (sessionId: string) => void;
  _onWsInputAck: (seq: number, msg: object, sessionId: string) => void;
  _pendingDeliveries: Map<
    string,
    Array<{ seq: number; data: string; sentAt: number; key?: string; retryAt: number; ts: number; tries: number }>
  >;
  showToast: ReturnType<typeof vi.fn>;
  _ws: { readyState: number; send: (data: string) => void } | null;
  _wsSessionId: string | null;
  activeSessionId: string | null;
};

function makeApp(): App {
  const app = Object.create((CodemanApp as { prototype: object }).prototype) as App & Record<string, unknown>;
  app._clientId = 'c-test';
  app._seqCounters = new Map();
  app._pendingDeliveries = new Map();
  app._postDraining = new Set();
  app._persistReliableState = vi.fn();
  app._persistReliableNow = vi.fn();
  app._updateConnectionIndicator = vi.fn();
  app.showToast = vi.fn();
  app.clearPendingHooks = vi.fn();
  // _ackDelivery spends a pending IDLE alert through markIdleAlertSeen, which
  // reads this map; without it the real prototype method throws on every ACK.
  app.pendingHooks = new Map();
  app.activeSessionId = 'session-1';
  app.isOnline = true;
  app._connectionStatus = 'connected';
  app._ws = null;
  app._wsSessionId = null;
  return app as unknown as App;
}

describe('durable input delivery — send ordering', () => {
  it('delivers rapid input as distinct ordered seq frames over an open WebSocket (no coalescing)', () => {
    const app = makeApp();
    const frames: Frame[] = [];
    app._ws = { readyState: 1, send: (d: string) => frames.push(JSON.parse(d)) };
    app._wsSessionId = 'session-1';

    app._sendInputAsync('session-1', 'a');
    app._sendInputAsync('session-1', 'b');
    app._sendInputAsync('session-1', 'c');

    // Each keystroke is its own frame, in seq order — never merged into "abc".
    expect(frames.map((f) => f.d)).toEqual(['a', 'b', 'c']);
    expect(frames.map((f) => f.seq)).toEqual([1, 2, 3]);
    expect(frames.every((f) => f.t === 'i' && f.cid === 'c-test')).toBe(true);
  });

  it('POSTs queued input one frame at a time in seq order when no socket is open', async () => {
    const app = makeApp();
    const calls: PostBody[] = [];
    const completions: Array<() => void> = [];
    global.fetch = vi.fn(async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)) as PostBody);
      await new Promise<void>((r) => completions.push(r));
      return new Response('{}', { status: 200 });
    });

    app._sendInputAsync('session-1', 'a');
    app._sendInputAsync('session-1', 'b');

    // Serialized: only the first frame is in flight until its 2xx ACK lands.
    await waitForCalls(calls, 1);
    expect(calls.map((c) => c.input)).toEqual(['a']);

    completions.shift()?.(); // ACK 'a'
    await waitForCalls(calls, 2);
    expect(calls.map((c) => c.input)).toEqual(['a', 'b']);
    expect(calls.map((c) => c.seq)).toEqual([1, 2]);

    completions.shift()?.();
    await waitForCalls(calls, 2);
  });

  it('leaves a frame queued (unacked) when HTTP delivery fails', async () => {
    const app = makeApp();
    const calls: PostBody[] = [];
    global.fetch = vi.fn(async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)) as PostBody);
      return new Response('busy', { status: 503 });
    });

    app._sendInputAsync('session-1', 'a');
    await waitForCalls(calls, 1);
    await new Promise((r) => setTimeout(r, 0));

    // 5xx is not an ACK — the frame must survive for the sweep/reconnect to retry.
    expect(app._pendingDeliveries.get('session-1')).toHaveLength(1);
    expect(app._pendingDeliveries.get('session-1')?.[0].data).toBe('a');
  });

  it('keeps recovery-blocked input queued when the server returns 422', async () => {
    const app = makeApp();
    const calls: PostBody[] = [];
    global.fetch = vi.fn(async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)) as PostBody);
      return new Response(JSON.stringify({ success: false, errorCode: 'OPERATION_FAILED' }), { status: 422 });
    });

    app._sendInputAsync('session-1', 'retry after recovery');
    await waitForCalls(calls, 1);
    await new Promise((r) => setTimeout(r, 0));

    expect(app._pendingDeliveries.get('session-1')).toHaveLength(1);
    expect(app._pendingDeliveries.get('session-1')?.[0].data).toBe('retry after recovery');
  });

  it('drops a frame addressed to a vanished session (404) instead of retrying forever', async () => {
    const app = makeApp();
    global.fetch = vi.fn(async () => new Response('gone', { status: 404 }));

    app._sendInputAsync('session-1', 'a');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(app._pendingDeliveries.get('session-1')).toBeUndefined();
  });
});

describe('named newline keys in the input queue', () => {
  const busy = () => new Response(JSON.stringify({ success: false, retryable: true, notSent: true }), { status: 422 });

  it('repairs a stale first-attempt duplicate ACK ahead of the named key and never-attempted text', async () => {
    const app = makeApp();
    const frames: Frame[] = [];
    const delivered: string[] = [];
    app._ws = {
      readyState: 1,
      send: (d) => {
        const frame = JSON.parse(d);
        frames.push(frame);
        if (frame.seq > 10) delivered.push(frame.d); // another tab already used sequences through 10
      },
    };
    app._wsSessionId = 'session-1';
    global.fetch = vi.fn(async (_url, init) => {
      delivered.push(JSON.parse(String(init?.body)).key);
      return new Response('{}', { status: 200 });
    });
    app._sendInputAsync('session-1', 'before', { useMux: true });
    app._sendNamedKey('session-1', 'S-Enter', {});
    app._sendInputAsync('session-1', 'after');
    const original = app._pendingDeliveries.get('session-1')![0];
    const originalTs = original.ts;
    app._onWsInputAck(1, { dup: true, last: 10 }, 'session-1');
    const repaired = app._pendingDeliveries.get('session-1')!;
    expect(repaired.map((r) => [r.key || r.data, r.seq])).toEqual([
      ['before', 11],
      ['S-Enter', 12],
      ['after', 13],
    ]);
    expect(repaired[0]).toBe(original);
    expect(repaired[0].ts).toBe(originalTs);
    expect(repaired[0]).toHaveProperty('useMux', true);
    expect(delivered).toEqual(['before']);
    app._onWsInputAck(11, {}, 'session-1');
    await new Promise((r) => setTimeout(r, 0));
    expect(delivered).toEqual(['before', 'S-Enter', 'after']);
    expect(frames.map((f) => [f.d, f.seq])).toEqual([
      ['before', 1],
      ['before', 11],
      ['after', 13],
    ]);
  });

  it('keeps ordinary attempted text in its original slot until its own duplicate ACK certifies rejection', () => {
    const app = makeApp();
    const frames: Frame[] = [];
    app._ws = { readyState: 1, send: (d) => frames.push(JSON.parse(d)) };
    app._wsSessionId = 'session-1';
    app._sendInputAsync('session-1', 'before');
    app._sendInputAsync('session-1', 'after');
    app._onWsInputAck(1, { dup: true, last: 10 }, 'session-1');
    // 'after' was already attempted, so its identity cannot be changed speculatively.
    expect(app._pendingDeliveries.get('session-1')?.map((r) => [r.data, r.seq])).toEqual([
      ['before', 11],
      ['after', 2],
    ]);
    app._onWsInputAck(2, { dup: true, last: 10 }, 'session-1');
    expect(app._pendingDeliveries.get('session-1')?.map((r) => [r.data, r.seq])).toEqual([
      ['before', 11],
      ['after', 12],
    ]);
    expect(frames.map((f) => [f.d, f.seq])).toEqual([
      ['before', 1],
      ['after', 2],
      ['before', 11],
      ['after', 12],
    ]);
  });

  it('does not repair an ambiguous retried WS frame when its duplicate ACK confirms prior delivery', async () => {
    const app = makeApp();
    const frames: Frame[] = [];
    app._ws = { readyState: 1, send: (d) => frames.push(JSON.parse(d)) };
    app._wsSessionId = 'session-1';
    global.fetch = vi.fn(async () => new Response('{}', { status: 200 }));
    app._sendInputAsync('session-1', 'before');
    app._sendNamedKey('session-1', 'S-Enter', {});
    app._sendInputAsync('session-1', 'after');
    const before = app._pendingDeliveries.get('session-1')![0];
    before.sentAt = 0;
    app._drainSession('session-1'); // same occurrence retried after an unknown send
    expect(before.tries).toBe(2);
    app._onWsInputAck(1, { dup: true, last: 1 }, 'session-1');
    await new Promise((r) => setTimeout(r, 0));
    expect(frames.filter((f) => f.d === 'before').map((f) => f.seq)).toEqual([1, 1]);
    expect(frames.at(-1)?.d).toBe('after');
  });

  it('uses the HTTP duplicate ACK watermark to retain before/key/after FIFO order', async () => {
    const app = makeApp();
    const delivered: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (!body.key && body.seq <= 10) {
        return new Response('{}', {
          status: 200,
          headers: {
            'x-codeman-input-ack': JSON.stringify({ seq: body.seq, dup: true, last: 10 }),
          },
        });
      }
      delivered.push(body.key || body.input);
      return new Response('{}', { status: 200 });
    });
    app._sendInputAsync('session-1', 'before');
    app._sendNamedKey('session-1', 'S-Enter', {});
    app._sendInputAsync('session-1', 'after');
    await waitForCalls(delivered, 3);
    expect(delivered).toEqual(['before', 'S-Enter', 'after']);
    expect(bodies.map((b) => [b.key || b.input, b.seq])).toEqual([
      ['before', 1],
      ['before', 11],
      ['S-Enter', undefined],
      ['after', 13],
    ]);
  });

  it('keeps every split-paste chunk and the following key in place during HTTP sequence repair', async () => {
    const app = makeApp();
    const before = 'x'.repeat(64 * 1024) + 'tail';
    const delivered: string[] = [];
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.seq === 1)
        return new Response('{}', {
          status: 200,
          headers: {
            'x-codeman-input-ack': JSON.stringify({ seq: 1, dup: true, last: 10 }),
          },
        });
      delivered.push(body.key || body.input);
      return new Response('{}', { status: 200 });
    });
    app._sendInputAsync('session-1', before);
    app._sendNamedKey('session-1', 'S-Enter', {});
    app._sendInputAsync('session-1', 'after');
    const records = [...app._pendingDeliveries.get('session-1')!];
    await waitForCalls(delivered, 4);
    expect(delivered).toEqual(['x'.repeat(64 * 1024), 'tail', 'S-Enter', 'after']);
    expect(records.map((r) => r.seq)).toEqual([11, 12, 13, 14]);
    expect(records[1].data).toBe('tail');
  });

  it('does not replay HTTP input after an unknown send followed by a duplicate ACK', async () => {
    const app = makeApp();
    const delivered: string[] = [];
    let attempts = 0;
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.input === 'before') {
        if (++attempts === 1) {
          delivered.push(body.input);
          throw new Error('response lost after delivery');
        }
        return new Response('{}', {
          status: 200,
          headers: {
            'x-codeman-input-ack': JSON.stringify({ seq: body.seq, dup: true, last: 1 }),
          },
        });
      }
      delivered.push(body.key || body.input);
      return new Response('{}', { status: 200 });
    });
    app._sendInputAsync('session-1', 'before');
    app._sendNamedKey('session-1', 'S-Enter', {});
    app._sendInputAsync('session-1', 'after');
    await new Promise((r) => setTimeout(r, 0));
    app._drainSession('session-1');
    await waitForCalls(delivered, 3);
    expect(delivered).toEqual(['before', 'S-Enter', 'after']);
    expect(attempts).toBe(2);
  });

  it('a late HTTP ACK names the sent sequence and cannot delete a record repaired by a socket ACK', async () => {
    const app = makeApp();
    const delivered: string[] = [];
    const requests: number[] = [];
    let release: () => void = () => {};
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body.seq);
      if (body.seq === 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      else delivered.push(body.key || body.input);
      return new Response('{}', { status: 200 });
    });
    app._sendInputAsync('session-1', 'before');
    app._sendNamedKey('session-1', 'S-Enter', {});
    app._sendInputAsync('session-1', 'after');
    app._onWsInputAck(1, { dup: true, last: 10 }, 'session-1');
    expect(requests).toEqual([1]); // the existing POST retains backpressure ownership
    release();
    await waitForCalls(delivered, 3);
    expect(delivered).toEqual(['before', 'S-Enter', 'after']);
    expect(requests).toEqual([1, 11, undefined, 13]);
  });

  it('retries a certified not-sent key, holding subsequent text in order even with an open socket', async () => {
    const app = makeApp();
    const sent: string[] = [];
    app._ws = { readyState: 1, send: (d) => sent.push(JSON.parse(d).d) };
    app._wsSessionId = 'session-1';
    let reserved = true;
    const keys: string[] = [];
    global.fetch = vi.fn(async (_url, init) => {
      const key = JSON.parse(String(init?.body)).key;
      keys.push(key);
      if (reserved) return busy();
      sent.push(key === 'S-Enter' ? '\x1b\r' : '\n');
      return new Response('{}', { status: 200 });
    });
    app._sendInputAsync('session-1', 'before');
    app._sendNamedKey('session-1', 'S-Enter', {});
    app._sendInputAsync('session-1', 'after');
    expect(sent).toEqual(['before']);
    expect(keys).toEqual([]); // waits for the prior text's ACK
    app._onWsInputAck(1, {}, 'session-1');
    await waitForCalls(keys, 1);
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(['before']);
    expect(app._pendingDeliveries.get('session-1')?.map((r) => r.key || r.data)).toEqual(['S-Enter', 'after']);
    // Typing again during the retry delay cannot bypass the key or spam retries.
    app._drainSession('session-1');
    expect(keys).toEqual(['S-Enter']);
    reserved = false;
    app._pendingDeliveries.get('session-1')![0].retryAt = 0;
    app._drainSession('session-1');
    await waitForCalls(keys, 2);
    await new Promise((r) => setTimeout(r, 0));
    expect(keys).toEqual(['S-Enter', 'S-Enter']);
    expect(sent).toEqual(['before', '\x1b\r', 'after']);
  });

  it.each(['network', '500', 'untagged-422'])('never replays a key after an unknown %s outcome', async (failure) => {
    const app = makeApp();
    const requests: string[] = [];
    global.fetch = vi.fn(async (url) => {
      requests.push(String(url));
      if (String(url).endsWith('/send-key')) {
        if (failure === 'network') throw new Error('response lost');
        return new Response('{}', { status: failure === '500' ? 500 : 422 });
      }
      return new Response('{}', { status: 200 });
    });
    app._sendNamedKey('session-1', 'C-Enter', {});
    app._sendInputAsync('session-1', 'after');
    await waitForCalls(requests, 2);
    app._drainSession('session-1');
    expect(requests.filter((url) => url.endsWith('/send-key'))).toHaveLength(1);
    expect(app.showToast).toHaveBeenCalledWith(expect.stringContaining('could not be confirmed'), 'error');
  });

  it('cancels a recovery-blocked key on owner destruction and still delivers ordinary text', async () => {
    const app = makeApp();
    const owner = {};
    const requests: string[] = [];
    global.fetch = vi.fn(async (url) => {
      requests.push(String(url));
      return String(url).endsWith('/send-key') ? busy() : new Response('{}', { status: 200 });
    });
    app._sendNamedKey('session-1', 'C-Enter', owner);
    app._sendInputAsync('session-1', 'after');
    await waitForCalls(requests, 1);
    await new Promise((r) => setTimeout(r, 0));
    app._cancelPendingKeys(owner);
    await waitForCalls(requests, 2);
    expect(requests.filter((url) => url.endsWith('/send-key'))).toHaveLength(1);
    expect(app.showToast).toHaveBeenCalledWith(expect.stringContaining('cancelled'), 'warning');
  });

  it('drops an unsupported key response and releases the next text with feedback', async () => {
    const app = makeApp();
    const requests: string[] = [];
    global.fetch = vi.fn(async (url) => {
      requests.push(String(url));
      return new Response('{}', { status: String(url).endsWith('/send-key') ? 400 : 200 });
    });
    app._sendNamedKey('session-1', 'S-Enter', {});
    app._sendInputAsync('session-1', 'after');
    await waitForCalls(requests, 2);
    expect(requests.filter((url) => url.endsWith('/send-key'))).toHaveLength(1);
    expect(app.showToast).toHaveBeenCalledWith(expect.stringContaining('refused'), 'error');
  });

  it.each(['expired', 'attempts'])('bounds certified retries by %s and reports the unsent key', async (bound) => {
    const app = makeApp();
    const requests: string[] = [];
    global.fetch = vi.fn(async (url) => {
      requests.push(String(url));
      return busy();
    });
    app._sendNamedKey('session-1', 'C-Enter', {});
    await waitForCalls(requests, 1);
    await new Promise((r) => setTimeout(r, 0));
    const key = app._pendingDeliveries.get('session-1')![0];
    key.retryAt = 0;
    if (bound === 'expired') key.ts = Date.now() - 30000;
    else key.tries = 16;
    app._drainSession('session-1');
    expect(requests).toHaveLength(1);
    expect(app._pendingDeliveries.get('session-1')).toBeUndefined();
    expect(app.showToast).toHaveBeenCalledWith(expect.stringContaining('key not sent'), 'error');
  });
});

// COD-135 — durable redelivery sweep when an ACK is lost.
type RedriveApp = App & {
  _redeliverSweep: () => void;
  _reliableAckTimeoutMs: number;
  _wsLastRecvAt: number;
};

describe('durable input delivery — _redeliverSweep ACK-loss recovery (COD-135)', () => {
  it('re-drives a stale unacked frame over a STILL-LIVE socket (lost ACK, not silent)', () => {
    const app = makeApp() as RedriveApp;
    const frames: Frame[] = [];
    const close = vi.fn();
    app._ws = { readyState: 1, send: (d: string) => frames.push(JSON.parse(d)), close } as never;
    app._wsSessionId = 'session-1';
    app._reliableAckTimeoutMs = 4000;

    // Frame sent once over the open socket; ACK never arrives.
    app._sendInputAsync('session-1', 'a');
    expect(frames.map((f) => f.d)).toEqual(['a']);

    // ACK is lost, but the socket KEEPS receiving output → it is NOT silent.
    // Backdate the send so the frame is stale; keep recv timestamp fresh.
    const list = app._pendingDeliveries.get('session-1')!;
    list[0].sentAt = Date.now() - (app._reliableAckTimeoutMs + 1000);
    app._wsLastRecvAt = Date.now();

    app._redeliverSweep();

    // The stale frame must be re-sent over the live socket (a second send),
    // and the socket must NOT be force-closed (it's alive, just the ACK was lost).
    expect(frames.map((f) => f.d)).toEqual(['a', 'a']);
    expect(close).not.toHaveBeenCalled();
    expect(app._pendingDeliveries.get('session-1')).toHaveLength(1);
  });

  it('does NOT re-drive a not-yet-stale frame (sent recently)', () => {
    const app = makeApp() as RedriveApp;
    const frames: Frame[] = [];
    const close = vi.fn();
    app._ws = { readyState: 1, send: (d: string) => frames.push(JSON.parse(d)), close } as never;
    app._wsSessionId = 'session-1';
    app._reliableAckTimeoutMs = 4000;

    app._sendInputAsync('session-1', 'a');
    app._wsLastRecvAt = Date.now(); // not silent

    // sentAt is fresh (just sent) → below the stale threshold → leave it alone.
    app._redeliverSweep();

    expect(frames.map((f) => f.d)).toEqual(['a']); // no second send
    expect(close).not.toHaveBeenCalled();
  });

  it('force-closes the socket when stale AND silent (half-open — COD-134 fallback preserved)', () => {
    const app = makeApp() as RedriveApp;
    const frames: Frame[] = [];
    const close = vi.fn();
    app._ws = { readyState: 1, send: (d: string) => frames.push(JSON.parse(d)), close } as never;
    app._wsSessionId = 'session-1';
    app._reliableAckTimeoutMs = 4000;

    app._sendInputAsync('session-1', 'a');
    const list = app._pendingDeliveries.get('session-1')!;
    list[0].sentAt = Date.now() - (app._reliableAckTimeoutMs + 1000); // stale
    app._wsLastRecvAt = Date.now() - (app._reliableAckTimeoutMs + 1000); // silent

    app._redeliverSweep();

    // Half-open socket never recovers on its own → force-close to reconnect.
    // It must NOT have re-sent over the dead socket.
    expect(close).toHaveBeenCalledTimes(1);
    expect(frames.map((f) => f.d)).toEqual(['a']);
  });
});
