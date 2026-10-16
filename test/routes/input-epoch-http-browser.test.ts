/** Actual server envelope and HTTP route drive the durable browser queue; PTY bytes are fake. */
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Session } from '../../src/session.js';
import { WebServer } from '../../src/web/server.js';
import { browserInputJournal, settleInput } from '../mocks/browser-input-journal.js';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
let root: string;
const cleanup: Array<() => Promise<void>> = [];
beforeEach(async () => {
  root = await fs.mkdtemp(join(homedir(), 'input-epoch-browser-'));
  vi.stubEnv('CODEMAN_DATA_DIR', root);
  vi.stubEnv('CODEMAN_MULTIUSER', '0');
  vi.stubEnv('CODEMAN_PASSWORD', '');
});
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const server = new WebServer(0, false, true);
  // Use the real global response-envelope hook, not the bare route fixture:
  // it changes returned OPERATION_FAILED responses from 200 to 422.
  await Reflect.get(server, 'setupRoutes').call(server);
  const app = Reflect.get(server, 'app') as FastifyInstance;
  await app.ready();
  const session = new Session({ id: ID, workingDir: root, mode: 'claude', useMux: false });
  const write = vi.fn();
  Object.assign(session, { ptyProcess: { write } });
  const sessions = Reflect.get(server, 'sessions') as Map<string, Session>;
  sessions.set(ID, session);
  cleanup.push(async () => {
    sessions.delete(ID);
    Object.assign(session, { ptyProcess: null });
    await session.stop(false);
    await server.stop();
  });
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
  return { app, session, write, replies, requests, transport };
}

it.each([true, false])('preserves HTTP/browser FIFO across queued pane-epoch replacement=%s', async (replaceEpoch) => {
  const f = await fixture();
  const journal = browserInputJournal();
  const document = journal.open();
  const cid = document.app._clientId;
  document.transport(f.transport);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  cleanup.unshift(async () => release.resolve());
  const writeAsync = f.session.writeAsync.bind(f.session);
  vi.spyOn(f.session, 'writeAsync').mockImplementationOnce(async (...args) => {
    const delivered = await writeAsync(...args);
    entered.resolve();
    await release.promise;
    // Model another accepted input's native reattach completion while it
    // still owns the route FIFO lease. No real wake, pane, or SSH is used.
    if (replaceEpoch) Reflect.set(f.session, '_paneStartedAt', f.session.paneStartedAt + 1);
    return delivered;
  });
  const prior = f.app
    .inject({
      method: 'POST',
      url: `/api/sessions/${ID}/input`,
      payload: { input: 'prior owner input', useMux: false, clientId: 'prior-owner', seq: 1 },
    })
    .then((response) => response);
  await entered.promise;
  const admitted = Promise.withResolvers<void>();
  const defer = f.session.deferInputSeq.bind(f.session);
  vi.spyOn(f.session, 'deferInputSeq').mockImplementation((clientId, seq) => {
    const result = defer(clientId, seq);
    if (clientId === cid && seq === 1) admitted.resolve();
    return result;
  });
  document.app._sendInputAsync(ID, 'Retain original occurrence 🧭');
  document.app._sendInputAsync(ID, 'Later owner input');
  await admitted.promise;
  expect(f.replies).toEqual([]);
  expect(f.write.mock.calls).toEqual([['prior owner input']]);
  release.resolve();
  expect((await prior).statusCode).toBe(200);
  await settleInput(document.app);

  if (replaceEpoch) {
    expect(journal.records().map(({ value }) => value.seq)).toEqual([1, 2]);
    expect(f.replies).toEqual([
      { status: 422, body: expect.objectContaining({ success: false, errorCode: 'OPERATION_FAILED' }), ack: undefined },
    ]);
    expect(f.session.hasAppliedInputSeq(cid, 1)).toBe(false);
    expect(document.app._pendingDeliveries.get(ID)).toMatchObject([
      { cid, seq: 1, data: 'Retain original occurrence 🧭' },
      { cid, seq: 2, data: 'Later owner input' },
    ]);
    expect(f.write.mock.calls).toEqual([['prior owner input']]);
    const restored = journal.open();
    expect(restored.app._clientId).not.toBe(cid);
    restored.transport(f.transport);
    restored.app._drainSession(ID);
    await settleInput(restored.app);
    expect(f.requests).toEqual([
      { clientId: cid, seq: 1, input: 'Retain original occurrence 🧭' },
      { clientId: cid, seq: 1, input: 'Retain original occurrence 🧭' },
      { clientId: cid, seq: 2, input: 'Later owner input' },
    ]);
    expect(restored.app._pendingDeliveries.has(ID)).toBe(false);
  }
  expect(f.write.mock.calls).toEqual([['prior owner input'], ['Retain original occurrence 🧭'], ['Later owner input']]);
  expect(f.session.lastInputSeq(cid)).toBe(2);
  expect(journal.records()).toEqual([]);
  if (!replaceEpoch) expect(document.app._pendingDeliveries.has(ID)).toBe(false);
});

it('retains an uncertain partial write until its sealed duplicate receipt, without replaying bytes', async () => {
  const f = await fixture();
  const journal = browserInputJournal();
  const document = journal.open();
  const cid = document.app._clientId;
  const effects: string[] = [];
  f.write.mockImplementationOnce((input: string) => {
    effects.push(input);
    throw new Error('Fake PTY failed after its byte effect');
  });
  document.transport(f.transport);
  document.app._sendInputAsync(ID, 'Uncertain partial input');
  await settleInput(document.app);
  expect(f.replies).toEqual([{ status: 500, body: expect.objectContaining({ success: false }), ack: undefined }]);
  expect(f.replies[0].body).not.toMatchObject({ notSent: true });
  expect(f.session.hasAppliedInputSeq(cid, 1)).toBe(true);
  expect(effects).toEqual(['Uncertain partial input']);
  expect(journal.records()).toHaveLength(1);
  document.app._drainSession(ID);
  await settleInput(document.app);
  expect(f.replies[1].status).toBe(200);
  expect(JSON.parse(f.replies[1].ack!)).toEqual({ seq: 1, dup: true, last: 1 });
  expect(f.write).toHaveBeenCalledTimes(1);
  expect(effects).toEqual(['Uncertain partial input']);
  expect(document.app._pendingDeliveries.has(ID)).toBe(false);
  expect(journal.records()).toEqual([]);
});
