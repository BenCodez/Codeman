import { describe, expect, it, vi } from 'vitest';
import { browserInputJournal, recordKey, settleInput } from './mocks/browser-input-journal.js';
const SID = 'same-session';

function server() {
  const accepted = new Set<string>();
  const delivered: string[] = [];
  const accept = (cid: string, seq: number, text: string) => {
    const identity = cid + ':' + seq;
    const duplicate = accepted.has(identity);
    if (!duplicate) {
      accepted.add(identity);
      delivered.push(text);
    }
    return duplicate;
  };
  const post: typeof fetch = vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const dup = accept(body.clientId, body.seq, body.input);
    return new Response('{}', {
      status: 200,
      headers: dup ? { 'x-codeman-input-ack': JSON.stringify({ seq: body.seq, dup: true, last: body.seq }) } : {},
    });
  });
  return { delivered, accept, post };
}

describe('durable input belongs to its original document and occurrence', () => {
  it('preserves two simultaneous same-session windows through crossed writes, ACK and pagehide', async () => {
    const h = browserInputJournal([['codeman:clientId', 'previous-browser-wide-id']]);
    const first = h.open(),
      second = h.open();
    first.socket(SID);
    second.socket(SID);
    first.app._sendInputAsync(SID, 'first window');
    second.app._sendInputAsync(SID, 'second window');
    expect(first.app._clientId).not.toBe(second.app._clientId);
    expect(first.frames).toMatchObject([{ cid: first.app._clientId, seq: 1, d: 'first window' }]);
    expect(second.frames).toMatchObject([{ cid: second.app._clientId, seq: 1, d: 'second window' }]);
    second.app._persistReliableNow();
    first.app._persistReliableNow();
    expect(
      h
        .records()
        .map(({ value }) => value.data)
        .sort()
    ).toEqual(['first window', 'second window']);
    const recovery = h.open(); // Also sees an active window's occurrence, without minting a new identity.
    const service = server();
    service.accept(first.frames[0].cid, 1, 'first window');
    first.app._onWsInputAck(1, {}, SID);
    first.app._persistReliableNow();
    second.app._persistReliableNow();
    expect(h.records().map(({ value }) => value.data)).toEqual(['second window']);
    recovery.transport(service.post);
    recovery.app._drainSession(SID);
    await settleInput(recovery.app);
    expect(service.delivered).toEqual(['first window', 'second window']);
    expect(recovery.fetches.map(({ body }) => [body.clientId, body.seq]).sort()).toEqual(
      [
        [first.app._clientId, 1],
        [second.app._clientId, 1],
      ].sort()
    );
    recovery.app._persistReliableNow();
    second.app._persistReliableNow();
    expect(h.records()).toEqual([]);
    expect(h.open().app._pendingDeliveries.size).toBe(0);
  });

  it('uses fresh identities despite duplicate-window sessionStorage copies and retains old IDs on replay', async () => {
    const h = browserInputJournal();
    const copied = new Map([
      ['codeman:clientId', 'copied-tab-id'],
      ['tabId', 'copied-tab-id'],
    ]);
    const first = h.open(new Map(copied));
    first.socket(SID);
    first.app._sendInputAsync(SID, 'original occurrence');
    const second = h.open(new Map(copied));
    second.socket(SID);
    second.transport(vi.fn(async () => new Response('{}', { status: 503 })));
    second.app._sendInputAsync(SID, 'duplicate window input');
    await settleInput(second.app);
    expect(second.app._clientId).not.toBe(first.app._clientId);
    expect(second.fetches[0].body).toMatchObject({
      clientId: first.app._clientId,
      seq: 1,
      input: 'original occurrence',
    });
    expect(second.frames).toEqual([]); // The old CID owns the HTTP barrier ahead of this document's socket.
    const service = server();
    second.transport(service.post);
    second.app._drainSession(SID);
    await settleInput(second.app);
    expect(second.frames).toMatchObject([{ cid: second.app._clientId, seq: 1, d: 'duplicate window input' }]);
    expect(service.delivered).toEqual(['original occurrence']);
  });

  it('replays a lost HTTP response with its original identity and keeps a new document sequence separate', async () => {
    const h = browserInputJournal();
    const service = server();
    const first = h.open();
    let lost = true;
    first.transport(
      vi.fn(async (url, init) => {
        const reply = await service.post(url, init);
        if (lost) {
          lost = false;
          throw Error('Lost committed reply');
        }
        return reply;
      })
    );
    first.app._sendInputAsync(SID, 'one application');
    await settleInput(first.app);
    const next = h.open();
    next.socket(SID);
    next.transport(service.post);
    next.app._drainSession(SID);
    await settleInput(next.app);
    expect(next.fetches[0].body).toMatchObject({ clientId: first.app._clientId, seq: 1 });
    expect(service.delivered).toEqual(['one application']);
    next.app._sendInputAsync(SID, 'fresh input');
    expect(next.frames[0]).toMatchObject({ cid: next.app._clientId, seq: 1, d: 'fresh input' });
    expect(next.app._clientId).not.toBe(first.app._clientId);
  });

  it('does not ACK a recovered CID through this document’s same-numbered WebSocket ACK', () => {
    const h = browserInputJournal();
    const first = h.open();
    first.socket(SID);
    first.app._sendInputAsync(SID, 'old ambiguous delivery');
    const next = h.open();
    next.app._onWsInputAck(1, {}, SID);
    expect(next.app._pendingDeliveries.get(SID)).toMatchObject([{ cid: first.app._clientId, seq: 1 }]);
    expect(h.records()).toHaveLength(1);
  });

  it('keeps other windows durable when quota blocks one occurrence and never persists its orphan suffix', async () => {
    const h = browserInputJournal();
    const safe = h.open();
    safe.socket(SID);
    safe.app._sendInputAsync(SID, 'other durable window');
    const own = h.open();
    own.socket('different-session');
    h.failSet((key) => key === recordKey(own.app._clientId, 'different-session', 1));
    own.app._sendInputAsync('different-session', 'storage failed prefix');
    h.failSet();
    own.app._sendNamedKey('different-session', 'S-Enter', {});
    own.app._sendInputAsync('different-session', 'dependent suffix');
    await settleInput(own.app);
    expect(h.records().map(({ value }) => value.data)).toEqual(['other durable window']);
    expect(own.app.showToast).toHaveBeenCalledWith(expect.stringContaining('keep this window open'), 'warning');
    safe.app._persistReliableNow();
    own.app._persistReliableNow();
    expect(h.open().app._pendingDeliveries.get(SID)).toMatchObject([{ data: 'other durable window' }]);
    expect(h.open().app._pendingDeliveries.has('different-session')).toBe(false);
  });

  it('retains an ACKed but undeletable record under the same replay identity', async () => {
    const h = browserInputJournal();
    const first = h.open();
    first.socket(SID);
    first.app._sendInputAsync(SID, 'already applied');
    h.failRemove(() => true);
    first.app._onWsInputAck(1, {}, SID);
    h.failRemove();
    const next = h.open(),
      service = server();
    service.accept(first.app._clientId, 1, 'already applied');
    next.transport(service.post);
    next.app._drainSession(SID);
    await settleInput(next.app);
    expect(service.delivered).toEqual(['already applied']);
    expect(h.records()).toEqual([]);
  });

  it.each(['key', 'corrupt'] as const)(
    'keeps the %s boundary ahead of every same-session imported suffix',
    async (kind) => {
      const h = browserInputJournal();
      const first = h.open();
      first.socket(SID);
      const owner = {};
      first.app._sendInputAsync(SID, 'known prefix');
      first.app._sendNamedKey(SID, 'S-Enter', owner);
      first.app._sendInputAsync(SID, 'unsafe suffix');
      const other = h.open();
      other.socket('unrelated');
      other.app._sendInputAsync('unrelated', 'unrelated input');
      if (kind === 'corrupt') h.storage.set(recordKey(first.app._clientId, SID, 2), '{');
      const recovery = h.open();
      expect(recovery.app._pendingDeliveries.get(SID)?.map((rec) => rec.data)).toEqual(['known prefix']);
      expect(recovery.app._pendingDeliveries.get('unrelated')).toMatchObject([{ data: 'unrelated input' }]);
      recovery.app._persistReliableNow();
      expect(h.storage.has(recordKey(first.app._clientId, SID, 2))).toBe(true);
      expect(h.storage.has(recordKey(first.app._clientId, SID, 3))).toBe(true);
      expect(recovery.app.showToast).toHaveBeenCalledWith(
        expect.stringContaining('following input not sent'),
        'warning'
      );
      await settleInput(first.app); // No named key passes its unacknowledged prefix.
    }
  );

  it('retains an unknown key when storage cannot delete the cancelled dependent suffix', async () => {
    const h = browserInputJournal();
    const first = h.open();
    first.socket(SID);
    const owner = {};
    first.app._sendInputAsync(SID, 'prefix');
    first.app._sendNamedKey(SID, 'C-Enter', owner);
    first.app._sendInputAsync(SID, 'must stay behind key');
    h.failRemove((key) => key === recordKey(first.app._clientId, SID, 3));
    first.app._cancelPendingKeys(owner);
    h.failRemove();
    expect(h.storage.has(recordKey(first.app._clientId, SID, 2))).toBe(true);
    expect(
      h
        .open()
        .app._pendingDeliveries.get(SID)
        ?.map((rec) => rec.data)
    ).toEqual(['prefix']);
    await settleInput(first.app);
  });

  it('never resurrects legacy occurrences or changes their replay IDs after another document ACKs them', async () => {
    const legacy = {
      version: 2,
      clientId: 'old-client',
      seqs: { [SID]: 8 },
      pending: { [SID]: [{ seq: 8, data: 'old landed input', tries: 0 }] },
    };
    const raw = JSON.stringify(legacy);
    const h = browserInputJournal([
      ['codeman:clientId', 'old-client'],
      ['codeman:pendingInput', raw],
    ]);
    const first = h.open(),
      stale = h.open(),
      service = server();
    first.transport(service.post);
    first.app._drainSession(SID);
    await settleInput(first.app);
    stale.app._persistReliableNow();
    expect(h.storage.get('codeman:pendingInput')).toBe(raw);
    expect(h.open().app._pendingDeliveries.size).toBe(0);
    stale.transport(service.post);
    stale.app._drainSession(SID);
    await settleInput(stale.app);
    expect(service.delivered).toEqual(['old landed input']);
    expect(stale.fetches[0].body).toMatchObject({ clientId: 'old-client', seq: 8 });
  });

  it('refuses a bounded scan rather than replaying a partial unknown queue', () => {
    const h = browserInputJournal();
    const first = h.open();
    first.socket(SID);
    first.app._sendInputAsync(SID, 'retained');
    for (let index = 0; index < 8193; index++) h.storage.set('unrelated:' + index, 'x');
    const next = h.open();
    expect(next.app._pendingDeliveries.size).toBe(0);
    expect(h.storage.has(recordKey(first.app._clientId, SID, 1))).toBe(true);
    expect(next.app.showToast).toHaveBeenCalledWith(expect.stringContaining('could not be verified'), 'warning');
  });
});

it.each(['remove-earlier-key', 'insert-boundary-after-read'] as const)(
  'quarantines an incomplete cross-window index after %s',
  (change) => {
    const h = browserInputJournal([['unrelated:first', 'present']]);
    const first = h.open();
    first.socket(SID);
    first.app._sendInputAsync(SID, 'prefix');
    first.app._sendNamedKey(SID, 'S-Enter', {});
    first.app._sendInputAsync(SID, 'suffix');
    const key = recordKey(first.app._clientId, SID, 2);
    const barrier = h.storage.get(key)!;
    if (change === 'insert-boundary-after-read') h.storage.delete(key);
    let enumerations = 0,
      changed = false;
    const next = h.open(new Map(), () =>
      h.onKey((index) => {
        if (index === 0) enumerations++;
        if (!changed && (change === 'remove-earlier-key' ? index === 1 : enumerations === 3)) {
          changed = true;
          if (change === 'remove-earlier-key') h.storage.delete('unrelated:first');
          else h.storage.set(key, barrier);
        }
      })
    );
    expect(changed).toBe(true);
    expect(next.app._pendingDeliveries.size).toBe(0);
    expect(next.app.showToast).toHaveBeenCalledWith(expect.stringContaining('could not be verified'), 'warning');
    expect(h.storage.has(recordKey(first.app._clientId, SID, 3))).toBe(true);
    h.onKey();
    expect(
      h
        .open()
        .app._pendingDeliveries.get(SID)
        ?.map((rec) => rec.data)
    ).toEqual(['prefix']);
  }
);

it('restores each original CID in sequence order despite interleaved storage indices', async () => {
  const h = browserInputJournal();
  const first = h.open();
  first.socket(SID);
  for (const text of ['one', 'two', 'three']) first.app._sendInputAsync(SID, text);
  const middle = recordKey(first.app._clientId, SID, 2),
    value = h.storage.get(middle)!;
  h.storage.delete(middle);
  h.storage.set(middle, value);
  const next = h.open(),
    service = server();
  next.transport(service.post);
  next.app._drainSession(SID);
  await settleInput(next.app);
  expect(next.fetches.map(({ body }) => [body.clientId, body.seq])).toEqual(
    [1, 2, 3].map((seq) => [first.app._clientId, seq])
  );
  expect(service.delivered).toEqual(['one', 'two', 'three']);
});

it.each(['legacy-no-timestamp', 'backwards-wall-clock'] as const)(
  'retains cross-CID causal order after %s',
  async (kind) => {
    const h = browserInputJournal(
      kind === 'legacy-no-timestamp'
        ? [
            ['codeman:clientId', 'old-client'],
            [
              'codeman:pendingInput',
              JSON.stringify({ version: 2, clientId: 'old-client', pending: { [SID]: [{ seq: 8, data: 'prefix' }] } }),
            ],
          ]
        : []
    );
    let originalCid = 'old-client';
    if (kind === 'backwards-wall-clock') {
      const first = h.open();
      first.socket(SID);
      first.app._sendInputAsync(SID, 'prefix');
      originalCid = first.app._clientId;
    }
    const append = h.open();
    if (kind === 'backwards-wall-clock') vi.spyOn(Date, 'now').mockReturnValue(1);
    try {
      append.app._sendInputAsync(SID, 'suffix');
      await settleInput(append.app);
    } finally {
      vi.restoreAllMocks();
    }
    const next = h.open(),
      service = server();
    next.transport(service.post);
    next.app._drainSession(SID);
    await settleInput(next.app);
    expect(service.delivered).toEqual(['prefix', 'suffix']);
    expect(next.fetches.map(({ body }) => body.clientId)).toEqual([originalCid, append.app._clientId]);
  }
);

it('bounds the legacy ACK marker scan when another window grows the index during enumeration', async () => {
  const h = browserInputJournal([
    ['codeman:clientId', 'old-client'],
    [
      'codeman:pendingInput',
      JSON.stringify({ version: 2, clientId: 'old-client', pending: { [SID]: [{ seq: 1, data: 'legacy' }] } }),
    ],
  ]);
  const doc = h.open(),
    service = server();
  doc.transport(service.post);
  let calls = 0;
  const capturedLength = h.storage.size;
  h.onKey(() => {
    if (++calls === 1) for (let index = 0; index < 9000; index++) h.storage.set('other:' + index, 'x');
  });
  doc.app._drainSession(SID);
  await settleInput(doc.app);
  expect(calls).toBeLessThanOrEqual(capturedLength);
  expect([...h.storage.keys()].some((key) => key.startsWith('codeman:pendingInput:legacyAck:'))).toBe(false);
  h.onKey();
});

it('does not mistake a quarantined cross-CID predecessor for an acknowledged missing record', async () => {
  const h = browserInputJournal();
  const first = h.open();
  first.socket(SID);
  first.app._sendInputAsync(SID, 'required prefix');
  const next = h.open();
  next.app._sendInputAsync(SID, 'dependent suffix');
  next.app._sendNamedKey(SID, 'S-Enter', {});
  await settleInput(next.app);
  const recovery = h.open();
  expect(recovery.app._pendingDeliveries.has(SID)).toBe(false);
  expect(recovery.app.showToast).toHaveBeenCalledWith(expect.stringContaining('following input not sent'), 'warning');
  expect(h.records()).toHaveLength(3);
});

it('releases an immutable causal dependency only after its exact predecessor was removed by ACK', async () => {
  const h = browserInputJournal();
  const first = h.open();
  first.socket(SID);
  first.app._sendInputAsync(SID, 'prefix');
  const next = h.open();
  next.app._sendInputAsync(SID, 'suffix');
  await settleInput(next.app);
  first.app._onWsInputAck(1, {}, SID);
  const recovery = h.open(),
    service = server();
  recovery.transport(service.post);
  recovery.app._drainSession(SID);
  await settleInput(recovery.app);
  expect(service.delivered).toEqual(['suffix']);
  expect(recovery.fetches[0].body).toMatchObject({ clientId: next.app._clientId, seq: 1 });
});

it('refuses malformed cross-CID cycles without deleting either durable occurrence', () => {
  const h = browserInputJournal();
  const first = h.open();
  first.socket(SID);
  first.app._sendInputAsync(SID, 'one');
  const second = h.open();
  second.app._sendInputAsync(SID, 'two');
  for (const [doc, predecessor] of [
    [first, second],
    [second, first],
  ]) {
    const key = recordKey(doc.app._clientId, SID, 1),
      rec = JSON.parse(h.storage.get(key)!);
    rec.after = { cid: predecessor.app._clientId, seq: 1 };
    h.storage.set(key, JSON.stringify(rec));
  }
  expect(h.open().app._pendingDeliveries.has(SID)).toBe(false);
  expect(h.records()).toHaveLength(2);
});

it('makes a formerly quota-blocked suffix durable once its prefix receives an exact ACK', () => {
  const h = browserInputJournal(),
    doc = h.open();
  doc.socket(SID);
  h.failSet(() => true);
  doc.app._sendInputAsync(SID, 'prefix');
  h.failSet();
  doc.app._sendInputAsync(SID, 'suffix');
  expect(h.records()).toEqual([]);
  doc.app._onWsInputAck(1, {}, SID);
  expect(h.records().map(({ value }) => [value.cid, value.seq, value.data])).toEqual([
    [doc.app._clientId, 2, 'suffix'],
  ]);
  expect(h.open().app._pendingDeliveries.get(SID)).toMatchObject([
    { cid: doc.app._clientId, seq: 2, data: 'suffix', replayUncertain: true },
  ]);
});

function removeSession(app: object, sid: string) {
  for (const key of [
    'sessions',
    'terminalBuffers',
    'terminalBufferCache',
    'ralphStates',
    'ralphClosedSessions',
    'projectInsights',
    'pendingHooks',
    'tabAlerts',
    'attachmentHistoryCounts',
    'terminalLoadStates',
    'idleTimers',
  ])
    Reflect.set(app, key, new Map());
  for (const key of ['respawnStatus', 'respawnTimers', 'respawnCountdownTimers', 'respawnActionLogs'])
    Reflect.set(app, key, {});
  Reflect.set(app, 'sessionOrder', []);
  for (const key of [
    '_markTerminalBufferReconciled',
    '_clearHistoryTruncation',
    'clearCountdownTimers',
    'closeSessionLogViewerWindows',
    'closeSessionImagePopups',
    'closeSessionAttachmentCards',
    'closeSessionSubagentWindows',
  ])
    Reflect.set(app, key, vi.fn());
  Reflect.get(app, '_cleanupSessionData').call(app, sid);
}

it.each([false, true])(
  'verified removal preserves key/suffix evidence and another session (reloaded=%s)',
  async (reload) => {
    const h = browserInputJournal(),
      original = h.open();
    original.socket(SID);
    original.app._sendInputAsync(SID, 'prefix');
    original.app._sendNamedKey(SID, 'S-Enter', {});
    original.app._sendInputAsync(SID, 'suffix');
    original.app._sendInputAsync('other-session', 'keep');
    await settleInput(original.app);
    const recovery = reload ? h.open() : original;
    expect(recovery.app._pendingDeliveries.get(SID)).toHaveLength(reload ? 1 : 3);
    const removed: string[] = [];
    h.failRemove((key) => {
      removed.push(key);
      return key === recordKey(original.app._clientId, SID, 3);
    });
    removeSession(recovery.app, SID);
    h.failRemove();
    expect(removed).not.toContain(recordKey(original.app._clientId, SID, 3));
    expect(h.records().map(({ value }) => [value.sessionId, value.seq])).toEqual([
      [SID, 2],
      [SID, 3],
      ['other-session', 1],
    ]);
    const next = h.open();
    expect(next.app._pendingDeliveries.has(SID)).toBe(false);
    expect(next.app._pendingDeliveries.get('other-session')?.map((rec) => rec.data)).toEqual(['keep']);
  }
);

it('allows fresh-document owner input after an explicit restore reuses a removed session ID', () => {
  const h = browserInputJournal(),
    original = h.open();
  original.socket(SID);
  original.app._sendInputAsync(SID, 'old worker input');
  removeSession(original.app, SID);
  const restored = h.open();
  restored.socket(SID);
  restored.app._sendInputAsync(SID, 'new owner input');
  expect(restored.frames.map((frame) => frame.d)).toEqual(['new owner input']);
  expect(restored.app._clientId).not.toBe(original.app._clientId);
  expect(
    h
      .open()
      .app._pendingDeliveries.get(SID)
      ?.map((rec) => rec.data)
  ).toEqual(['new owner input']);
});

it('stops prefix cleanup on a failed exact removal without erasing its earlier causal ancestor', async () => {
  const h = browserInputJournal(),
    original = h.open();
  original.socket(SID);
  original.app._sendInputAsync(SID, 'prefix one');
  original.app._sendInputAsync(SID, 'prefix two');
  original.app._sendNamedKey(SID, 'S-Enter', {});
  original.app._sendInputAsync(SID, 'suffix');
  await settleInput(original.app);
  h.failRemove((key) => key === recordKey(original.app._clientId, SID, 2));
  removeSession(original.app, SID);
  h.failRemove();
  expect(h.records().map(({ value }) => value.seq)).toEqual([1, 2, 3, 4]);
  expect(
    h
      .open()
      .app._pendingDeliveries.get(SID)
      ?.map((rec) => rec.data)
  ).toEqual(['prefix one', 'prefix two']);
});
