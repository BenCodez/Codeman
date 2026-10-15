/** Actual route responses drive browser HTTP fallback; only the PTY effect is fake. */
import fastifyCookie from '@fastify/cookie';
import Fastify from 'fastify';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { afterEach, expect, it, vi } from 'vitest';
import { Session } from '../../src/session.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { browserInputJournal, settleInput } from '../mocks/browser-input-journal.js';
import { createMockRouteContext } from '../mocks/index.js';

const ID = 'backpressure-browser-session';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
});

it.each(['clients', 'tail'] as const)(
  'retains the original durable browser occurrence through actual %s saturation, reload and retry',
  async (capacity) => {
    const journal = browserInputJournal();
    const document = journal.open();
    const clientId = document.app._clientId;
    const seq = capacity === 'clients' ? 1 : 4098;
    const input = 'Retain this owner prompt 🧭';
    if (capacity === 'tail') document.app._seqCounters.set(ID, seq - 1);

    const app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    const ctx = createMockRouteContext({ sessionId: ID });
    const session = new Session({ id: ID, workingDir: homedir(), mode: 'claude', useMux: false });
    const write = vi.fn();
    Object.assign(session, { ptyProcess: { write } });
    (ctx.sessions as unknown as Map<string, Session>).set(ID, session);
    registerSessionRoutes(app, ctx as never);
    installRouteErrorHandler(app);
    // Do not rewrite response statuses in the fixture: this route must itself
    // distinguish temporary rejection from a successful delivery ACK.
    await app.ready();
    cleanup.push(async () => {
      await app.close();
      Object.assign(session, { ptyProcess: null });
      await session.stop(false);
    });
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    if (capacity === 'clients') {
      for (let index = 0; index < 256; index++) expect(session.shouldApplyInput(`held-${index}`, 1)).toBe(true);
    } else {
      expect(session.shouldApplyInput(clientId, 1)).toBe(true);
      session.commitInputSeq(clientId, 1);
      for (let pending = 2; pending <= 4097; pending++) expect(session.deferInputSeq(clientId, pending)).toBe(true);
    }
    const replies: Array<{ status: number; body: unknown; ack: string | undefined }> = [];
    const requests: Array<{ input: string; clientId: string; seq: number }> = [];
    const transport: typeof fetch = vi.fn(async (url, options) => {
      const payload = JSON.parse(String(options?.body));
      requests.push(payload);
      const response = await app.inject({ method: 'POST', url: String(url), payload });
      const ack = response.headers['x-codeman-input-ack'];
      replies.push({
        status: response.statusCode,
        body: response.json(),
        ack: typeof ack === 'string' ? ack : undefined,
      });
      const headers = new Headers();
      if (typeof ack === 'string') headers.set('x-codeman-input-ack', ack);
      return new Response(response.body, { status: response.statusCode, headers });
    });
    document.transport(transport);
    document.app._sendInputAsync(ID, input);
    await settleInput(document.app);
    expect(replies).toEqual([
      {
        status: 429,
        body: expect.objectContaining({ success: false, retryable: true, notSent: true }),
        ack: undefined,
      },
    ]);
    expect(write).not.toHaveBeenCalled();
    expect(session.hasAppliedInputSeq(clientId, seq)).toBe(false);
    expect(document.app._pendingDeliveries.get(ID)).toMatchObject([{ cid: clientId, seq, data: input }]);
    expect(journal.records().map(({ value }) => [value.cid, value.seq, value.data])).toEqual([[clientId, seq, input]]);

    const restored = journal.open();
    expect(restored.app._clientId).not.toBe(clientId);
    expect(restored.app._pendingDeliveries.get(ID)).toMatchObject([
      { cid: clientId, seq, data: input, replayUncertain: true },
    ]);
    if (capacity === 'clients') session.commitInputSeq('held-0', 1);
    else now = 60_000;
    restored.transport(transport);
    restored.app._drainSession(ID);
    await settleInput(restored.app);
    expect(replies[1].status).toBe(200);
    expect(write).toHaveBeenCalledExactlyOnceWith(input);
    expect(session.hasAppliedInputSeq(clientId, seq)).toBe(true);
    expect(restored.app._pendingDeliveries.has(ID)).toBe(false);
    expect(journal.records()).toEqual([]);

    // The original document still has its stale in-memory occurrence. Its retry
    // receives the exact duplicate receipt and cannot reapply or rename input.
    document.app._drainSession(ID);
    await settleInput(document.app);
    expect(replies[2].status).toBe(200);
    expect(JSON.parse(replies[2].ack!)).toEqual({ seq, dup: true, last: seq });
    expect(requests).toEqual(Array.from({ length: 3 }, () => ({ input, seq, clientId })));
    expect(write).toHaveBeenCalledTimes(1);
    expect(document.app._pendingDeliveries.has(ID)).toBe(false);
    expect(journal.records()).toEqual([]);

    document.app._sendInputAsync(ID, 'Next accepted owner input');
    await settleInput(document.app);
    expect(replies[3].status).toBe(200);
    expect(replies[3].ack).toBeUndefined();
    expect(write.mock.calls).toEqual([[input], ['Next accepted owner input']]);
    expect(document.app._pendingDeliveries.has(ID)).toBe(false);
    expect(journal.records()).toEqual([]);
  }
);
