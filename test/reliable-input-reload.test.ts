/** Real browser queue methods with durable storage and fake transport effects. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type RecordFrame = {
  cid: string;
  seq: number;
  data: string;
  key?: string;
  tries: number;
  sentAt: number;
  replayUncertain?: boolean;
};
type App = {
  _clientId: string;
  _sendInputAsync(session: string, input: string): void;
  _sendNamedKey(session: string, key: string, owner: object): void;
  _cancelPendingKeys(owner: object): void;
  _drainSession(session: string): void;
  _loadReliableState(): void;
  _persistReliableNow(): void;
  _onWsReady(session: string): void;
  _onWsInputAck(seq: number, message: object, session: string): void;
  _pendingDeliveries: Map<string, RecordFrame[]>;
  _seqCounters: Map<string, number>;
  _postDraining: Set<string>;
  _ws: { readyState: number; send(data: string): void } | null;
  _wsSessionId: string | null;
  showToast: ReturnType<typeof vi.fn>;
};
const constants = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');

function harness(initial?: object) {
  const storage = new Map<string, string>([['codeman:clientId', 'c-reload-test']]);
  if (initial) storage.set('codeman:pendingInput', JSON.stringify(initial));
  let failWrite = false;
  let transport: typeof fetch = vi.fn(async () => new Response('{}', { status: 200 }));
  const context = vm.createContext({
    console,
    crypto: { randomUUID },
    performance,
    setTimeout,
    clearTimeout,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    requestAnimationFrame: vi.fn(),
    HTMLCanvasElement: class {},
    AbortController,
    WebSocket: { OPEN: 1 },
    document: { addEventListener: vi.fn() },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    MobileDetection: {},
    fetch: (...args: Parameters<typeof fetch>) => transport(...args),
    localStorage: {
      get length() {
        return storage.size;
      },
      key: (index: number) => [...storage.keys()][index] ?? null,
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (failWrite) throw new Error('quota');
        storage.set(key, value);
      },
      removeItem: (key: string) => storage.delete(key),
    },
  });
  vm.runInContext(`${constants}\n${source}\nglobalThis.__CodemanApp = CodemanApp;`, context);
  const prototype = (context as { __CodemanApp: { prototype: object } }).__CodemanApp.prototype;
  const load = () => {
    const app = Object.create(prototype) as App & Record<string, unknown>;
    app._seqCounters = new Map();
    app._pendingDeliveries = new Map();
    app._postDraining = new Set();
    app._persistReliableTimer = null;
    app._reliableMaxBytes = 256 * 1024;
    app._updateConnectionIndicator = vi.fn();
    // Ack debouncing is irrelevant to this crash proof; keep immediate writes real.
    app._persistReliableState = vi.fn();
    app.pendingHooks = new Map();
    app._ws = null;
    app._wsSessionId = null;
    app.showToast = vi.fn();
    app._loadReliableState();
    return app;
  };
  return {
    load,
    snapshot: () => {
      const pending: Record<string, RecordFrame[]> = {};
      for (const [key, text] of storage)
        if (key.startsWith('codeman:pendingInput:v3:')) {
          const rec = JSON.parse(text);
          (pending[rec.sessionId] ??= []).push(rec);
        }
      return { pending };
    },
    transport: (next: typeof fetch) => {
      transport = next;
    },
    failWrites: (fail: boolean) => {
      failWrite = fail;
    },
    removeIdentity: () => {
      storage.delete('codeman:clientId');
    },
  };
}
async function settle(app: App) {
  for (let i = 0; i < 50 && app._postDraining.size; i++) await new Promise((r) => setTimeout(r, 0));
  expect(app._postDraining.size).toBe(0);
}
function duplicate(seq: number, last = seq) {
  return new Response('{}', {
    status: 200,
    headers: { 'x-codeman-input-ack': JSON.stringify({ seq, dup: true, last }) },
  });
}

const session = 'test-session';
describe('reload never converts an uncertain occurrence into fresh input', () => {
  it.each([
    'envelope-overflow',
    'unicode-overflow',
    'escaped-overflow',
    'exact-body-limit',
    'under-body-limit',
    'small-unicode',
  ] as const)('sizes HTTP keepalive from the serialized body and drains the durable FIFO: %s', async (kind) => {
    const h = harness();
    const app = h.load();
    const overhead = Buffer.byteLength(JSON.stringify({ input: '', seq: 1, clientId: app._clientId }));
    const text =
      kind === 'unicode-overflow'
        ? '🧭'.repeat(16_384)
        : kind === 'escaped-overflow'
          ? '\0'.repeat(11_000)
          : kind === 'exact-body-limit'
            ? 'a'.repeat(65_536 - overhead)
            : kind === 'under-body-limit'
              ? 'a'.repeat(65_535 - overhead)
              : kind === 'small-unicode'
                ? '🧭 owner input'
                : 'a'.repeat(65_535);
    let acknowledge!: () => void;
    const firstAck = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const requests: { body: { input: string; seq: number; clientId: string }; keepalive: unknown; bytes: number }[] =
      [];
    const effects: string[] = [];
    h.transport(
      vi.fn(async (_url, init) => {
        const serialized = init!.body as string;
        const bytes = Buffer.byteLength(serialized);
        // Model the browser's Fetch body budget; the old plaintext check makes
        // these valid records fail before any network request can begin.
        if (init!.keepalive && bytes > 65_536) throw new TypeError('keepalive body budget exceeded');
        const body = JSON.parse(serialized);
        requests.push({ body, keepalive: init!.keepalive, bytes });
        if (requests.length === 1) await firstAck;
        effects.push(body.input);
        return new Response('{}', { status: 200 });
      })
    );
    try {
      app._sendInputAsync(session, text);
      app._sendInputAsync(session, 'next');
      expect(requests).toHaveLength(1);
      const first = requests[0];
      expect(first.body).toEqual({ input: text, seq: 1, clientId: app._clientId });
      if (kind === 'exact-body-limit') expect(first.bytes).toBe(65_536);
      if (kind === 'under-body-limit') expect(first.bytes).toBe(65_535);
      expect(first.keepalive).toBe(first.bytes < 65_536);
      expect(effects).toEqual([]);
      expect(h.snapshot().pending[session].map((record) => [record.cid, record.seq, record.data])).toEqual([
        [app._clientId, 1, text],
        [app._clientId, 2, 'next'],
      ]);
      acknowledge();
      await settle(app);
      expect(requests.map((request) => request.body)).toEqual([
        { input: text, seq: 1, clientId: app._clientId },
        { input: 'next', seq: 2, clientId: app._clientId },
      ]);
      expect(requests[1].keepalive).toBe(true);
      expect(effects).toEqual([text, 'next']);
      expect(app._pendingDeliveries.has(session)).toBe(false);
      expect(h.snapshot().pending[session]).toBeUndefined();
    } finally {
      acknowledge();
      await settle(app);
    }
  });

  it.each([false, true])(
    'keeps the exact HTTP identity after response loss (attempt write fails: %s)',
    async (quota) => {
      const h = harness();
      const original = h.load();
      const originalPersist = original._persistReliableNow.bind(original);
      let writes = 0;
      original._persistReliableNow = () => {
        if (++writes === 2 && quota) h.failWrites(true);
        originalPersist();
      };
      const landed: string[] = [];
      const requests: number[] = [];
      const last = new Map<string, number>();
      h.transport(
        vi.fn(async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          requests.push(body.seq);
          if (body.seq <= (last.get(body.clientId) ?? 0)) return duplicate(body.seq, last.get(body.clientId));
          last.set(body.clientId, body.seq);
          landed.push(body.input);
          if (landed.length === 1) throw new Error('committed, response lost');
          return new Response('{}', { status: 200 });
        })
      );
      original._sendInputAsync(session, 'owner input');
      await settle(original);
      // Immutable records may always say tries:0; reload must still treat them as uncertain.
      expect(h.snapshot().pending[session][0].tries).toBe(0);
      h.failWrites(false);
      const restored = h.load();
      restored._drainSession(session);
      await settle(restored);
      expect(requests).toEqual([1, 1]);
      expect(landed).toEqual(['owner input']);
      expect(restored._pendingDeliveries.has(session)).toBe(false);
      restored._sendInputAsync(session, 'new owner input');
      await settle(restored);
      expect(requests).toEqual([1, 1, 1]);
      expect(restored._clientId).not.toBe(original._clientId);
      expect(landed).toEqual(['owner input', 'new owner input']);
    }
  );

  it.each([undefined, 0, 1, 7, 'malformed'])(
    'treats legacy attempt metadata %s as replay uncertainty',
    async (tries) => {
      const h = harness({ seqs: { [session]: 1 }, pending: { [session]: [{ seq: 1, data: 'previous', tries }] } });
      const app = h.load();
      const requests: number[] = [];
      h.transport(
        vi.fn(async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          requests.push(body.seq);
          return duplicate(body.seq, 12);
        })
      );
      app._drainSession(session);
      await settle(app);
      expect(requests).toEqual([1]);
      expect(app._seqCounters.get(session)).toBeUndefined();
      expect(app._clientId).not.toBe('c-reload-test');
      expect(app._pendingDeliveries.has(session)).toBe(false);
    }
  );

  it.each(['missing', 'changed'])('never replays saved input with a %s durable client identity', (identity) => {
    const h = harness({
      version: 2,
      clientId: 'previous-client',
      seqs: { [session]: 1 },
      pending: { [session]: [{ seq: 1, data: 'previous input', tries: 1 }] },
    });
    if (identity === 'missing') h.removeIdentity();
    const app = h.load();
    const transport = vi.fn(async () => new Response('{}', { status: 200 }));
    h.transport(transport);
    app._drainSession(session);
    expect(transport).not.toHaveBeenCalled();
    expect(app._pendingDeliveries.size).toBe(0);
    expect(app.showToast).toHaveBeenCalledWith(expect.stringContaining('identity could not be verified'), 'warning');
  });

  it.each([undefined, '', 42, { identity: 'c-reload-test' }])(
    'refuses malformed version2 payload identity %s',
    (clientId) => {
      const h = harness({
        version: 2,
        clientId,
        seqs: { [session]: 1 },
        pending: { [session]: [{ seq: 1, data: 'previous input', tries: 1 }] },
      });
      const app = h.load();
      const transport = vi.fn(async () => new Response('{}', { status: 200 }));
      h.transport(transport);
      app._drainSession(session);
      expect(transport).not.toHaveBeenCalled();
      expect(app._pendingDeliveries.size).toBe(0);
      expect(app.showToast).toHaveBeenCalledWith(expect.stringContaining('identity could not be verified'), 'warning');
    }
  );

  it.each([null, 1, 3, '2'])('refuses unsupported explicit snapshot version %s', (version) => {
    const h = harness({
      version,
      clientId: 'c-reload-test',
      seqs: { [session]: 1 },
      pending: { [session]: [{ seq: 1, data: 'previous input', tries: 1 }] },
    });
    const app = h.load();
    const transport = vi.fn(async () => new Response('{}', { status: 200 }));
    h.transport(transport);
    app._drainSession(session);
    expect(transport).not.toHaveBeenCalled();
    expect(app._pendingDeliveries.size).toBe(0);
    expect(app._seqCounters.get(session)).toBeUndefined();
    expect(app.showToast).toHaveBeenCalledWith(expect.stringContaining('format could not be verified'), 'warning');
  });

  it.each([1.5, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'never turns persisted counter %s into unsequenced replayable WebSocket bytes',
    (counter) => {
      const h = harness({ version: 2, clientId: 'c-reload-test', seqs: { [session]: counter }, pending: {} });
      const app = h.load();
      const frames: Array<{ seq: number; d: string }> = [];
      const applied: string[] = [];
      const committed = new Set<number>();
      app._wsSessionId = session;
      app._ws = {
        readyState: 1,
        send: (raw) => {
          const frame = JSON.parse(raw);
          frames.push(frame);
          // Match the real WS admission: a noninteger seq is unsequenced legacy input.
          if (!Number.isInteger(frame.seq) || !committed.has(frame.seq)) applied.push(frame.d);
          if (Number.isInteger(frame.seq)) committed.add(frame.seq);
          // Lose the first ACK, then reconnect and retry the exact occurrence.
        },
      };
      app._sendInputAsync(session, 'fresh owner input');
      app._onWsReady(session);
      expect(frames.map((frame) => frame.seq)).toEqual([1, 1]);
      expect(frames.every((frame) => Number.isSafeInteger(frame.seq))).toBe(true);
      expect(applied).toEqual(['fresh owner input']);
    }
  );

  it('preserves an original persisted sequence while fresh document input owns a different CID', async () => {
    const h = harness({
      version: 2,
      clientId: 'c-reload-test',
      seqs: { [session]: 17 },
      pending: { [session]: [{ seq: 17, data: 'already committed', tries: 1 }] },
    });
    const app = h.load();
    const replay: { clientId: string; seq: number; input: string }[] = [];
    h.transport(
      vi.fn(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        replay.push(body);
        return duplicate(body.seq, 17);
      })
    );
    const frames: { cid: string; seq: number; d: string }[] = [];
    app._wsSessionId = session;
    app._ws = {
      readyState: 1,
      send: (raw) => {
        const frame = JSON.parse(raw);
        frames.push(frame);
        app._onWsInputAck(frame.seq, {}, session);
      },
    };
    app._drainSession(session);
    await settle(app);
    expect(replay).toMatchObject([{ clientId: 'c-reload-test', seq: 17, input: 'already committed' }]);
    app._sendInputAsync(session, 'fresh owner input');
    expect(frames).toEqual([{ t: 'i', cid: app._clientId, seq: 1, d: 'fresh owner input' }]);
    expect(app._clientId).not.toBe('c-reload-test');
    expect(app._pendingDeliveries.size).toBe(0);
    expect(app.showToast).not.toHaveBeenCalled();
  });

  it('refuses new text and named keys at an exhausted counter without resetting or reusing identity', () => {
    const h = harness({
      version: 2,
      clientId: 'c-reload-test',
      seqs: { [session]: Number.MAX_SAFE_INTEGER },
      pending: {},
    });
    const app = h.load();
    app._seqCounters.set(session, Number.MAX_SAFE_INTEGER);
    const originalCid = app._clientId;
    const frames: string[] = [];
    const transport = vi.fn(async () => new Response('{}', { status: 200 }));
    h.transport(transport);
    app._wsSessionId = session;
    app._ws = { readyState: 1, send: (frame) => frames.push(frame) };
    app._sendInputAsync(session, 'fresh owner input');
    app._sendNamedKey(session, 'S-Enter', {});
    expect(frames).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
    expect(app._pendingDeliveries.size).toBe(0);
    expect(app._seqCounters.get(session)).toBe(Number.MAX_SAFE_INTEGER);
    expect(app._clientId).toBe(originalCid);
    expect(h.snapshot().pending).toEqual({});
    expect(
      app.showToast.mock.calls.every(
        ([message, level]) => String(message).includes('delivery limit') && level === 'warning'
      )
    ).toBe(true);
  });

  it('refuses an exhausted whole-queue repair without releasing its dependent newline/text', async () => {
    const h = harness({ seqs: { [session]: Number.MAX_SAFE_INTEGER - 3 } });
    const app = h.load();
    app._seqCounters.set(session, Number.MAX_SAFE_INTEGER - 3);
    const requests: string[] = [];
    let finish: (() => void) | undefined;
    h.transport(
      vi.fn(async (url) => {
        requests.push(String(url));
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return duplicate(Number.MAX_SAFE_INTEGER - 2, Number.MAX_SAFE_INTEGER - 1);
      })
    );
    app._sendInputAsync(session, 'before');
    app._sendNamedKey(session, 'C-Enter', {});
    app._sendInputAsync(session, 'after');
    finish!();
    await settle(app);
    expect(requests).toEqual([`/api/sessions/${session}/input`]);
    expect(app._pendingDeliveries.size).toBe(0);
    expect(app._seqCounters.get(session)).toBe(Number.MAX_SAFE_INTEGER);
    expect(app.showToast).toHaveBeenCalledWith(expect.stringContaining('pending input not replayed'), 'warning');
  });

  it('retains fresh first-attempt stale-counter repair without changing its FIFO slot', async () => {
    const h = harness({ seqs: { [session]: 0 } });
    const app = h.load();
    const requests: Array<{ seq: number; input: string }> = [];
    h.transport(
      vi.fn(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        requests.push(body);
        return body.seq === 1 ? duplicate(1, 10) : new Response('{}', { status: 200 });
      })
    );
    app._sendInputAsync(session, 'fresh');
    app._sendInputAsync(session, 'following');
    await settle(app);
    expect(requests.map(({ seq, input }) => [seq, input])).toEqual([
      [1, 'fresh'],
      [11, 'fresh'],
      [12, 'following'],
    ]);
  });

  it('seals a WebSocket attempt before bytes land even when send throws afterward', async () => {
    const h = harness();
    const app = h.load();
    const landed: string[] = [];
    app._wsSessionId = session;
    app._ws = {
      readyState: 1,
      send: (data) => {
        const frame = JSON.parse(data);
        expect(h.snapshot().pending[session][0].tries).toBe(0);
        expect(app._pendingDeliveries.get(session)![0].tries).toBe(1);
        landed.push(frame.d);
        throw new Error('after bytes');
      },
    };
    app._sendInputAsync(session, 'once');
    const restored = h.load();
    const requests: number[] = [];
    h.transport(
      vi.fn(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        requests.push(body.seq);
        return duplicate(body.seq);
      })
    );
    restored._drainSession(session);
    await settle(restored);
    expect(requests).toEqual([1]);
    expect(landed).toEqual(['once']);
  });
});

describe('non-deduplicated newline boundaries survive as refusal barriers', () => {
  it.each(['S-Enter', 'C-Enter'])('does not join text across a persisted %s on reload', async (key) => {
    const h = harness();
    const old = h.load();
    h.transport(vi.fn(() => new Promise<Response>(() => {})));
    old._sendInputAsync(session, 'before');
    old._sendNamedKey(session, key, {});
    old._sendInputAsync(session, 'after');
    expect(h.snapshot().pending[session].map((r: RecordFrame) => r.key || r.data)).toEqual(['before', key, 'after']);
    const app = h.load();
    const requests: string[] = [];
    h.transport(
      vi.fn(async (url, init) => {
        requests.push(`${String(url).split('/').at(-1)}:${JSON.parse(String(init?.body)).input}`);
        return new Response('{}', { status: 200 });
      })
    );
    app._drainSession(session);
    await settle(app);
    expect(requests).toEqual(['input:before']);
    expect(app.showToast).toHaveBeenCalledWith(expect.stringContaining('following input not sent'), 'warning');
    // A second reload cannot resurrect the dependent suffix once the prefix ACKs.
    expect(h.load()._pendingDeliveries.size).toBe(0);
  });

  it.each([undefined, 2])(
    'refuses dependent text behind an incomplete empty barrier in snapshot %s',
    async (version) => {
      const h = harness({
        version,
        clientId: 'c-reload-test',
        seqs: { [session]: 3 },
        pending: {
          [session]: [
            { seq: 1, data: 'before', tries: 1 },
            { seq: 2, data: '', tries: 0 },
            { seq: 3, data: 'after', tries: 0 },
          ],
        },
      });
      const app = h.load();
      const requests: string[] = [];
      h.transport(
        vi.fn(async (_url, init) => {
          requests.push(JSON.parse(String(init?.body)).input);
          return new Response('{}', { status: 200 });
        })
      );
      app._drainSession(session);
      await settle(app);
      expect(requests).toEqual(['before']);
      expect(app._seqCounters.get(session)).toBeUndefined();
      expect(app.showToast).toHaveBeenCalledWith(expect.stringContaining('following input not sent'), 'warning');
      expect(h.load()._pendingDeliveries.size).toBe(0);
    }
  );

  it.each([Number.MAX_SAFE_INTEGER + 1, -1, 0])(
    'refuses the suffix behind malformed record identity %s',
    async (seq) => {
      const h = harness({
        version: 2,
        clientId: 'c-reload-test',
        seqs: { [session]: 3 },
        pending: {
          [session]: [
            { seq: 1, data: 'before', tries: 1 },
            { seq, data: 'invalid', tries: 0 },
            { seq: 3, data: 'after', tries: 0 },
          ],
        },
      });
      const app = h.load();
      const requests: string[] = [];
      h.transport(
        vi.fn(async (_url, init) => {
          requests.push(JSON.parse(String(init?.body)).input);
          return new Response('{}', { status: 200 });
        })
      );
      app._drainSession(session);
      await settle(app);
      expect(requests).toEqual(['before']);
      expect(app.showToast).toHaveBeenCalledWith(expect.stringContaining('following input not sent'), 'warning');
    }
  );

  it('refuses the suffix behind a gap left by a legacy omitted key', async () => {
    const h = harness({
      seqs: { [session]: 3 },
      pending: {
        [session]: [
          { seq: 1, data: 'before', tries: 1 },
          { seq: 3, data: 'after', tries: 0 },
        ],
      },
    });
    const app = h.load();
    const requests: string[] = [];
    h.transport(
      vi.fn(async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)).input);
        return new Response('{}', { status: 200 });
      })
    );
    app._drainSession(session);
    await settle(app);
    expect(requests).toEqual(['before']);
    expect(app._seqCounters.get(session)).toBeUndefined();
    expect(app.showToast).toHaveBeenCalledWith(expect.stringContaining('following input not sent'), 'warning');
  });

  it('refuses a legacy suffix whose preceding key was omitted at the queue head', async () => {
    const h = harness({ seqs: { [session]: 2 }, pending: { [session]: [{ seq: 2, data: 'after', tries: 0 }] } });
    const app = h.load();
    const transport = vi.fn(async () => new Response('{}', { status: 200 }));
    h.transport(transport);
    app._drainSession(session);
    expect(transport).not.toHaveBeenCalled();
    expect(app._seqCounters.get(session)).toBeUndefined();
    expect(app.showToast).toHaveBeenCalledWith(expect.stringContaining('following input not sent'), 'warning');
  });

  it('never retries an in-flight key or releases its suffix after reload', async () => {
    const h = harness();
    const old = h.load();
    h.transport(vi.fn(() => new Promise<Response>(() => {})));
    old._sendNamedKey(session, 'C-Enter', {});
    old._sendInputAsync(session, 'after');
    const app = h.load();
    const transport = vi.fn(async () => new Response('{}', { status: 200 }));
    h.transport(transport);
    app._drainSession(session);
    expect(transport).not.toHaveBeenCalled();
    expect(app._pendingDeliveries.size).toBe(0);
    expect(app.showToast).toHaveBeenCalledOnce();
  });

  it('does not release the suffix when owner teardown aborts an uncertain key', async () => {
    const h = harness();
    const app = h.load();
    const owner = {};
    const requests: string[] = [];
    h.transport(
      vi.fn(async (url, init) => {
        requests.push(String(url));
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('unknown outcome')));
        });
      })
    );
    app._sendNamedKey(session, 'S-Enter', owner);
    app._sendInputAsync(session, 'after');
    app._cancelPendingKeys(owner);
    await settle(app);
    expect(requests).toEqual([`/api/sessions/${session}/send-key`]);
    expect(app._pendingDeliveries.size).toBe(0);
    expect(app.showToast).toHaveBeenCalledWith(expect.stringContaining('following input not sent'), 'warning');
  });

  it('persists certified-unsent teardown cancellation before reload without releasing dependent text', async () => {
    const h = harness();
    const app = h.load();
    const owner = {};
    const requests: string[] = [];
    h.transport(
      vi.fn(async (url) => {
        requests.push(String(url));
        return String(url).endsWith('/send-key')
          ? new Response(JSON.stringify({ success: false, retryable: true, notSent: true }), { status: 422 })
          : new Response('{}', { status: 200 });
      })
    );
    app._sendNamedKey(session, 'C-Enter', owner);
    app._sendInputAsync(session, 'dependent');
    await settle(app);
    expect(app._pendingDeliveries.get(session)?.map((rec) => rec.key || rec.data)).toEqual(['C-Enter', 'dependent']);
    app._cancelPendingKeys(owner);
    await settle(app);
    const restored = h.load();
    restored._drainSession(session);
    await settle(restored);
    expect(requests).toEqual([`/api/sessions/${session}/send-key`]);
    expect(app._pendingDeliveries.size).toBe(0);
    expect(restored._pendingDeliveries.size).toBe(0);
    expect(restored._seqCounters.get(session)).toBeUndefined();
    expect(restored._clientId).not.toBe(app._clientId);
    expect(app.showToast).toHaveBeenCalledWith(expect.stringContaining('following input not sent'), 'warning');
  });
});
