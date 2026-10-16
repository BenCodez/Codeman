/** @fileoverview Actual browser replay and HTTP FIFO boundaries, with disposable storage and fake fetch effects. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { browserInputJournal, recordKey } from './mocks/browser-input-journal.js';

const SID = 'input-boundary-session';
const CID = 'original-client';
const LIMIT = 65_536;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
const flush = () => vi.advanceTimersByTimeAsync(0);
const ok = () => new Response('{}', { status: 200 });
const duplicate = (seq: number) =>
  new Response('{}', {
    status: 200,
    headers: { 'x-codeman-input-ack': JSON.stringify({ seq, dup: true, last: seq }) },
  });

it.each(['legacy', 'v2', 'v3'].flatMap((format) => ['ascii', 'unicode'].map((encoding) => ({ format, encoding }))))(
  'refuses an oversized $encoding $format replay frame and its causal suffix across repeated reloads',
  async ({ format, encoding }) => {
    const oversized = encoding === 'ascii' ? 'x'.repeat(LIMIT + 1) : '🧭'.repeat(LIMIT / 4 + 1);
    expect(Buffer.byteLength(oversized)).toBeGreaterThan(LIMIT);
    const frames = [
      { seq: 1, data: 'verified-prefix', tries: 0 },
      { seq: 2, data: oversized, tries: 0 },
      { seq: 3, data: 'dangerous-suffix\r', tries: 0 },
    ];
    const seed: Array<[string, string]> =
      format === 'v3'
        ? frames.map((rec) => [
            recordKey(CID, SID, rec.seq),
            JSON.stringify({ version: 3, cid: CID, sessionId: SID, ...rec }),
          ])
        : [
            ['codeman:clientId', CID],
            [
              'codeman:pendingInput',
              JSON.stringify({ ...(format === 'v2' ? { version: 2, clientId: CID } : {}), pending: { [SID]: frames } }),
            ],
          ];
    const h = browserInputJournal(seed);
    const first = h.open();
    first.transport(vi.fn(async () => ok()));
    first.app._drainSession(SID);
    await flush();
    expect(first.fetches.map(({ body }) => body.input)).toEqual(['verified-prefix']);
    expect(first.app._postDraining.size).toBe(0);
    expect(first.app.showToast).toHaveBeenCalledWith(expect.stringContaining('following input not sent'), 'warning');
    const restored = h.open();
    restored.transport(vi.fn(async () => ok()));
    restored.app._drainSession(SID);
    await flush();
    expect(restored.fetches).toEqual([]);
  }
);

it.each(['ascii', 'unicode'] as const)(
  'replays an exact UTF-8 limit $encoding frame and its FIFO suffix',
  async (encoding) => {
    const text = encoding === 'ascii' ? 'x'.repeat(LIMIT) : '🧭'.repeat(LIMIT / 4);
    const frames = [
      { seq: 1, data: text },
      { seq: 2, data: 'suffix' },
    ];
    const h = browserInputJournal(
      frames.map((rec) => [
        recordKey(CID, SID, rec.seq),
        JSON.stringify({ version: 3, cid: CID, sessionId: SID, ...rec }),
      ])
    );
    const browser = h.open();
    browser.transport(vi.fn(async () => ok()));
    browser.app._drainSession(SID);
    await flush();
    expect(browser.fetches.map(({ body }) => [body.clientId, body.seq, body.input])).toEqual([
      [CID, 1, text],
      [CID, 2, 'suffix'],
    ]);
    expect(h.records()).toEqual([]);
  }
);

it.each([4, 5])('bounds the total restored UTF-8 byte budget for %s individually valid frames', async (count) => {
  const data = '🧭'.repeat(LIMIT / 4);
  const h = browserInputJournal(
    Array.from(
      { length: count },
      (_, index) =>
        [
          recordKey(CID, SID, index + 1),
          JSON.stringify({ version: 3, cid: CID, sessionId: SID, seq: index + 1, data }),
        ] as [string, string]
    )
  );
  const browser = h.open();
  browser.transport(vi.fn(async () => ok()));
  browser.app._drainSession(SID);
  await flush();
  expect(browser.fetches).toHaveLength(count === 4 ? 4 : 0);
  if (count === 5)
    expect(browser.app.showToast).toHaveBeenCalledWith(expect.stringContaining('could not be verified'), 'warning');
});

it.each([4, 5, 8])(
  'persists a reloadable UTF-8 prefix of %s queued emoji frames without losing live pending input',
  async (count) => {
    const h = browserInputJournal();
    const browser = h.open();
    browser.transport(vi.fn(async () => new Response('{}', { status: 503 })));
    const frame = '🧭'.repeat(LIMIT / 4);
    for (let index = 0; index < count; index++) browser.app._sendInputAsync(SID, frame);
    await flush();
    expect(browser.app._pendingDeliveries.get(SID)).toHaveLength(count);
    const stored = h.records();
    expect(stored).toHaveLength(Math.min(count, 4));
    expect(stored.reduce((bytes, rec) => bytes + Buffer.byteLength(rec.value.data), 0)).toBe(
      Math.min(count, 4) * LIMIT
    );
    expect(stored.map(({ value }) => value.seq)).toEqual(
      Array.from({ length: Math.min(count, 4) }, (_, index) => index + 1)
    );
    if (count > 4)
      expect(browser.app.showToast).toHaveBeenCalledWith(expect.stringContaining('keep this window open'), 'warning');
    else expect(browser.app.showToast).not.toHaveBeenCalled();
    const restored = h.open();
    expect(restored.app._pendingDeliveries.get(SID)).toHaveLength(Math.min(count, 4));
    expect(restored.app.showToast).not.toHaveBeenCalled();
    expect(h.records()).toEqual(stored);
    expect(restored.app._pendingDeliveries.get(SID)?.map((rec) => [rec.cid, rec.seq, rec.data])).toEqual(
      stored.map(({ value }) => [value.cid, value.seq, value.data])
    );
  }
);

it('a timed-out ordinary POST releases the drainer but keeps exact identity and FIFO through reload and acceptance', async () => {
  const h = browserInputJournal();
  const browser = h.open();
  let firstSignal: AbortSignal | undefined;
  const delivered = ['prefix']; // The server committed the first request before its response stalled.
  browser.transport(
    vi.fn((_url, init) => {
      firstSignal = init!.signal!;
      return new Promise<Response>((_resolve, reject) => {
        firstSignal?.addEventListener('abort', () => reject(new Error('Fixture response lost after delivery')));
      });
    })
  );
  browser.app._sendInputAsync(SID, 'prefix');
  browser.app._sendInputAsync(SID, 'suffix');
  const identity = browser.fetches[0].body;
  await vi.advanceTimersByTimeAsync(9_999);
  expect(firstSignal?.aborted ?? false).toBe(false);
  expect(browser.fetches).toHaveLength(1);
  expect(browser.app._postDraining.has(SID)).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(browser.app._postDraining.size).toBe(0);
  expect(firstSignal?.aborted).toBe(true);
  expect(browser.fetches).toHaveLength(1);
  expect(browser.app._pendingDeliveries.get(SID)?.map((rec) => rec.data)).toEqual(['prefix', 'suffix']);
  expect(h.records().map(({ value }) => [value.cid, value.seq])).toEqual([
    [identity.clientId, 1],
    [identity.clientId, 2],
  ]);
  const restored = h.open();
  let acknowledge!: (response: Response) => void;
  restored.transport(
    vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init!.body));
      if (body.seq === 1)
        return new Promise<Response>((resolve) => {
          acknowledge = resolve;
        });
      delivered.push(body.input);
      return ok();
    })
  );
  restored.app._drainSession(SID);
  await flush();
  expect(restored.fetches.map(({ body }) => body)).toEqual([identity]);
  expect(delivered).toEqual(['prefix']);
  acknowledge(duplicate(1));
  await flush();
  expect(restored.fetches.map(({ body }) => [body.clientId, body.seq])).toEqual([
    [identity.clientId, 1],
    [identity.clientId, 2],
  ]);
  expect(delivered).toEqual(['prefix', 'suffix']);
  expect(h.records()).toEqual([]);
  expect(restored.app._postDraining.size).toBe(0);
});

it('clears healthy ordinary request deadlines without aborting acknowledged input', async () => {
  const h = browserInputJournal();
  const browser = h.open();
  const signals: AbortSignal[] = [];
  let acknowledge!: (response: Response) => void;
  browser.transport(
    vi.fn((_url, init) => {
      signals.push(init!.signal!);
      return signals.length === 1
        ? new Promise<Response>((resolve) => {
            acknowledge = resolve;
          })
        : Promise.resolve(ok());
    })
  );
  browser.app._sendInputAsync(SID, 'prefix');
  browser.app._sendInputAsync(SID, 'suffix');
  await vi.advanceTimersByTimeAsync(9_999);
  expect(browser.fetches).toHaveLength(1);
  acknowledge(ok());
  await flush();
  expect(browser.fetches.map(({ body }) => body.input)).toEqual(['prefix', 'suffix']);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(signals.every((signal) => signal && !signal.aborted)).toBe(true);
  expect(browser.app._postDraining.size).toBe(0);
  expect(h.records()).toEqual([]);
});

it('keeps named-key timeout uncertainty sealed against dependent suffix delivery', async () => {
  const h = browserInputJournal();
  const browser = h.open();
  browser.transport(
    vi.fn(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new Error('Fixture key outcome uncertain')));
        })
    )
  );
  browser.app._sendNamedKey(SID, 'S-Enter', {});
  browser.app._sendInputAsync(SID, 'dependent-suffix');
  await vi.advanceTimersByTimeAsync(10_000);
  expect(browser.fetches.map(({ body }) => body.key ?? body.input)).toEqual(['S-Enter']);
  expect(browser.app._postDraining.size).toBe(0);
  expect(browser.app._pendingDeliveries.has(SID)).toBe(false);
  expect(h.open().app._pendingDeliveries.size).toBe(0);
  expect(browser.app.showToast).toHaveBeenCalledWith(expect.stringContaining('could not be confirmed'), 'error');
});
