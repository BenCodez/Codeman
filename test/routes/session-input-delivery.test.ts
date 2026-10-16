/**
 * @fileoverview A lost input must stay retryable.
 *
 * Tagged POST fallback input must stay retryable until a write actually lands. The
 * dedup bookkeeping admits the (clientId, seq) pair before attempting the write;
 * known unsent failures release admission without advancing the watermark, and recovery
 * ownership has to return non-2xx so the browser retains the durable queue record.
 *
 * Observed in the wild: a prompt shown as sent in a chat client, a 200 in the proxy
 * log, and an empty prompt line in the pane.
 */

import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Session } from '../../src/session.js';
import { ApiErrorCode, httpStatusForErrorCode } from '../../src/types.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { isPlainPromptInput } from '../../src/web/route-helpers.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';

async function createEnvelopeHarness(): Promise<{ app: FastifyInstance; ctx: MockRouteContext }> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  const ctx = createMockRouteContext();
  registerSessionRoutes(app, ctx as never);

  app.addHook('preSerialization', (req, reply, payload: unknown, done) => {
    if (!req.url.startsWith('/api')) return done(null, payload);
    if (payload === null || typeof payload !== 'object') return done(null, payload);
    const p = payload as { success?: unknown; errorCode?: unknown };
    if (p.success === false) {
      if (reply.statusCode === 200 && typeof p.errorCode === 'string') {
        reply.code(httpStatusForErrorCode(p.errorCode as ApiErrorCode));
      }
      return done(null, payload);
    }
    if (p.success === true) return done(null, payload);
    return done(null, { success: true, data: payload });
  });

  installRouteErrorHandler(app);
  await app.ready();
  return { app, ctx };
}

const seqOf = (s: Session, client: string) => s.lastInputSeq(client);

describe('input dedup bookkeeping', () => {
  const make = () => new Session({ workingDir: '/tmp', mode: 'claude' });

  it('accepts an increasing seq once and rejects the replay', () => {
    const s = make();
    expect(s.shouldApplyInput('c1', 1)).toBe(true);
    expect(s.shouldApplyInput('c1', 1)).toBe(false);
    s.commitInputSeq('c1', 1);
    expect(s.shouldApplyInput('c1', 2)).toBe(true);
  });

  it('forgetInputSeq re-opens a failed delivery for retry', () => {
    const s = make();
    expect(s.shouldApplyInput('c1', 7)).toBe(true);

    s.forgetInputSeq('c1', 7); // the write failed after the 200 went out

    expect(s.shouldApplyInput('c1', 7)).toBe(true);
  });

  it('does not re-open a seq that a later input has superseded', () => {
    // Rolling back blindly would let an old, already-superseded message replay.
    const s = make();
    s.shouldApplyInput('c1', 7);
    s.commitInputSeq('c1', 7);
    s.shouldApplyInput('c1', 8);
    s.commitInputSeq('c1', 8);

    s.forgetInputSeq('c1', 7);

    expect(s.shouldApplyInput('c1', 8)).toBe(false);
    expect(seqOf(s, 'c1')).toBe(8);
  });

  it('is scoped per client', () => {
    const s = make();
    s.shouldApplyInput('c1', 5);
    s.forgetInputSeq('c2', 5);
    expect(s.shouldApplyInput('c1', 5)).toBe(false);
  });

  it('tolerates a rollback for a client that was never seen', () => {
    const s = make();
    expect(() => s.forgetInputSeq('ghost', 3)).not.toThrow();
  });
});

describe('Session.write delivery signal', () => {
  it('reports false when there is no PTY instead of swallowing the data', () => {
    // The silent swallow was the third way input could vanish: no PTY, no error,
    // no return value — the caller had no way to know.
    const s = new Session({ workingDir: '/tmp', mode: 'claude' });
    expect(s.write('hello\r')).toBe(false);
  });
});

/**
 * Wiring, not primitives.
 *
 * The first version of this file tested Session directly and nothing else: reverting
 * the route to master — deleting the rollback call, the load-bearing half of the fix —
 * left all six tests green. These drive the actual HTTP route.
 */
describe('POST /api/sessions/:id/input rollback wiring', () => {
  let harness: { app: FastifyInstance; ctx: MockRouteContext };

  beforeEach(async () => {
    harness = await createEnvelopeHarness();
  });
  afterEach(async () => {
    await harness.app.close();
  });

  const post = (body: Record<string, unknown>, id = 'test-session-1') =>
    harness.app.inject({ method: 'POST', url: `/api/sessions/${id}/input`, payload: body });

  it('refuses UTF-8 overflow permanently before claiming or dispatching its original identity', async () => {
    const session = harness.ctx._session;
    const defer = vi.spyOn(session, 'deferInputSeq');
    const write = vi.spyOn(session, 'write');
    const body = { input: '🧭'.repeat(16_385), clientId: 'unicode-client', seq: 8 };
    expect(body.input.length).toBeLessThan(65_536);
    const refused = await post(body);
    expect(refused.statusCode).toBe(413);
    expect(refused.json()).toMatchObject({ success: false, notSent: true });
    expect(defer).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(session.hasAppliedInputSeq(body.clientId, body.seq)).toBe(false);
    const exact = { ...body, input: '🧭'.repeat(16_384) };
    expect((await post(exact)).statusCode).toBe(200);
    expect(session.writeBuffer).toEqual([exact.input]);
    expect((await post(exact)).statusCode).toBe(200);
    expect(session.writeBuffer).toEqual([exact.input]);
  });

  it('delivers the valid zero sequence once without mistaking its initial watermark for delivery', async () => {
    const session = harness.ctx.sessions.get('test-session-1')!;
    const body = { input: 'zero', clientId: 'zero', seq: 0 };
    expect((await post(body)).statusCode).toBe(200);
    expect((await post(body)).statusCode).toBe(200);
    expect(session.writeBuffer).toEqual(['zero']);
    expect(session.hasAppliedInputSeq('zero', 0)).toBe(true);
  });

  it('retains earlier lock-rejected HTTP identities so an unlock cannot admit a higher frame ahead of them', async () => {
    const session = harness.ctx.sessions.get('test-session-1')!;
    session.recoveryInputReserved = true;
    for (const seq of [1, 2]) expect((await post({ input: `${seq}`, clientId: 'ordered', seq })).statusCode).toBe(422);
    session.recoveryInputReserved = false;
    expect((await post({ input: '3', clientId: 'ordered', seq: 3 })).statusCode).toBe(422);
    expect(session.writeBuffer).toEqual([]);
    expect(session.lastInputSeq('ordered')).toBe(0);
    for (const seq of [1, 2, 3])
      expect((await post({ input: `${seq}`, clientId: 'ordered', seq })).statusCode).toBe(200);
    expect(session.writeBuffer).toEqual(['1', '2', '3']);
    expect(session.lastInputSeq('ordered')).toBe(3);
  });

  it.each([false, true])('seals actual byte dispatch before a post-write listener throws (mux=%s)', async (useMux) => {
    const mux = { isAvailable: () => true, sendInput: vi.fn(async () => true) };
    const session = new Session({ id: 'test-session-1', workingDir: '/tmp', mode: 'claude' });
    const written = vi.fn();
    Object.assign(session, {
      ptyProcess: { write: written },
      ...(useMux ? { _mux: mux, _muxSession: { muxName: 'fixture' } } : {}),
    });
    session.on('promptSubmitted', () => {
      throw new Error('listener after bytes');
    });
    (harness.ctx.sessions as unknown as Map<string, Session>).set(session.id, session);
    const body = { input: 'committed\r', useMux, clientId: 'committed', seq: 7 };
    expect((await post(body)).statusCode).toBe(500);
    expect(session.lastInputSeq('committed')).toBe(7);
    const duplicate = await post(body);
    expect(duplicate.statusCode).toBe(200);
    expect(JSON.parse(String(duplicate.headers['x-codeman-input-ack']))).toEqual({ seq: 7, dup: true, last: 7 });
    expect(useMux ? mux.sendInput : written).toHaveBeenCalledTimes(1);
    if (useMux) expect(written).not.toHaveBeenCalled();
    await session.stop(false);
  });

  it('does not replay or fall back after a mux reports a potentially partial dispatch', async () => {
    const mux = { sendInput: vi.fn(async () => false) };
    const session = new Session({ id: 'test-session-1', workingDir: '/tmp', mode: 'claude' });
    const written = vi.fn();
    Object.assign(session, { ptyProcess: { write: written }, _mux: mux, _muxSession: { muxName: 'fixture' } });
    (harness.ctx.sessions as unknown as Map<string, Session>).set(session.id, session);
    const body = { input: 'potentially partial\r', useMux: true, clientId: 'partial', seq: 7 };
    expect((await post(body)).statusCode).toBe(500);
    expect(written).not.toHaveBeenCalled();
    expect((await post(body)).statusCode).toBe(200);
    expect(mux.sendInput).toHaveBeenCalledTimes(1);
    expect(written).not.toHaveBeenCalled();
    await session.stop(false);
  });

  it('withholds a duplicate delivery ACK while the original asynchronous write is uncommitted', async () => {
    const session = harness.ctx.sessions.get('test-session-1')!;
    let finish: (ok: boolean) => void = () => {};
    const write = vi.spyOn(session, 'writeViaMux').mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        })
    );
    const original = post({ input: 'pending', useMux: true, clientId: 'pending-client', seq: 7 }).then(
      (response) => response
    );
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    let duplicateAcknowledged = false;
    const pending = post({ input: 'pending', useMux: true, clientId: 'pending-client', seq: 7 }).then((response) => {
      duplicateAcknowledged = true;
      return response;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(duplicateAcknowledged).toBe(false);
    expect(session.lastInputSeq('pending-client')).toBe(0);
    finish(true);
    expect((await original).statusCode).toBe(200);
    const acknowledged = await pending;
    expect(acknowledged.statusCode).toBe(200);
    expect(JSON.parse(String(acknowledged.headers['x-codeman-input-ack']))).toEqual({ seq: 7, dup: true, last: 7 });
    expect(session.lastInputSeq('pending-client')).toBe(7);
    const retry = await post({ input: 'pending', useMux: true, clientId: 'pending-client', seq: 7 });
    expect(retry.statusCode).toBe(200);
    expect(JSON.parse(String(retry.headers['x-codeman-input-ack']))).toEqual({ seq: 7, dup: true, last: 7 });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('returns the actual duplicate watermark in an HTTP ACK header, retaining its successful envelope', async () => {
    const session = new Session({ id: 'test-session-1', workingDir: '/tmp', mode: 'codex' });
    (harness.ctx.sessions as unknown as Map<string, Session>).set(session.id, session);
    session.shouldApplyInput('two-tabs', 10);
    session.commitInputSeq('two-tabs', 10);
    const direct = vi.spyOn(session, 'writeAsync').mockResolvedValue(true);
    const duplicate = await post({ input: 'before', clientId: 'two-tabs', seq: 1 });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toEqual({ success: true, data: {} });
    expect(JSON.parse(String(duplicate.headers['x-codeman-input-ack']))).toEqual({ seq: 1, dup: true, last: 10 });
    expect(direct).not.toHaveBeenCalled();
    const corrected = await post({ input: 'before', clientId: 'two-tabs', seq: 11 });
    expect(corrected.statusCode).toBe(200);
    expect(corrected.headers['x-codeman-input-ack']).toBeUndefined();
    expect(direct).toHaveBeenCalledTimes(1);
    const retry = await post({ input: 'before', clientId: 'two-tabs', seq: 11 });
    expect(JSON.parse(String(retry.headers['x-codeman-input-ack']))).toEqual({ seq: 11, dup: true, last: 11 });
    expect(direct).toHaveBeenCalledTimes(1);
  });

  it('rolls the seq back when both the mux write and the direct write fail', async () => {
    const session = harness.ctx.sessions.get('test-session-1')!;
    session.failWrites = true; // writeViaMux false AND write() false

    await post({ input: 'lost\r', useMux: true, clientId: 'c1', seq: 1 });
    await new Promise((r) => setTimeout(r, 20)); // the mux write is fire-and-forget

    // The retry the client would make must be accepted, not swallowed as a duplicate.
    expect(session.shouldApplyInput('c1', 1)).toBe(true);
  });

  it('keeps the seq burnt when delivery succeeded', async () => {
    const session = harness.ctx.sessions.get('test-session-1')!;

    await post({ input: 'fine\r', useMux: true, clientId: 'c1', seq: 1 });
    await new Promise((r) => setTimeout(r, 20));

    expect(session.shouldApplyInput('c1', 1)).toBe(false);
  });

  it('keeps a failed tagged non-mux delivery retryable without inventing applied input', async () => {
    // A tagged 2xx is a delivery ACK; untagged legacy input keeps its historical status.
    const session = harness.ctx.sessions.get('test-session-1')!;
    session.failWrites = true;

    const res = await post({ input: 'x\r', useMux: false, clientId: 'c2', seq: 5 });

    expect(res.statusCode).toBe(422);
    expect(session.lastInputSeq('c2')).toBe(0);
    expect(session.shouldApplyInput('c2', 5)).toBe(true);
  });

  it('returns a retryable failure and re-opens the seq while recovery owns input', async () => {
    const session = harness.ctx.sessions.get('test-session-1')!;
    session.recoveryInputReserved = true;
    const viaMux = vi.spyOn(session, 'writeViaMux');
    const direct = vi.spyOn(session, 'write');

    const blocked = await post({ input: 'keep me\r', useMux: true, clientId: 'browser-1', seq: 9 });

    expect(blocked.statusCode).toBe(422);
    expect(blocked.json()).toMatchObject({ success: false, errorCode: 'OPERATION_FAILED' });
    expect(viaMux).not.toHaveBeenCalled();
    expect(direct).not.toHaveBeenCalled();
    expect(session.shouldApplyInput('browser-1', 9)).toBe(true);

    session.forgetInputSeq('browser-1', 9);
    session.recoveryInputReserved = false;
    const retried = await post({ input: 'keep me\r', useMux: true, clientId: 'browser-1', seq: 9 });
    expect(retried.statusCode).toBe(200);
    expect(session.writeBuffer).toContain('keep me\r');
  });

  it('does not disturb real recovery ownership or input proof tracking when rejecting the frame', async () => {
    const session = new Session({ id: 'test-session-1', workingDir: '/tmp', mode: 'codex' });
    (harness.ctx.sessions as unknown as Map<string, Session>).set(session.id, session);
    const internals = session as unknown as { _recoveryDelivering: boolean; _recoveryGeneration: number };
    internals._recoveryDelivering = true;
    const generation = internals._recoveryGeneration;
    const recoveryInput = vi.fn();
    const promptSubmitted = vi.fn();
    session.on('recoveryUserInput', recoveryInput);
    session.on('promptSubmitted', promptSubmitted);
    const viaMux = vi.spyOn(session, 'writeViaMux');
    const direct = vi.spyOn(session, 'write');

    const blocked = await post({ input: 'preserve exact input\r', clientId: 'browser-2', seq: 3 });

    expect(blocked.statusCode).toBe(422);
    expect(viaMux).not.toHaveBeenCalled();
    expect(direct).not.toHaveBeenCalled();
    expect(internals._recoveryGeneration).toBe(generation);
    expect(recoveryInput).not.toHaveBeenCalled();
    expect(promptSubmitted).not.toHaveBeenCalled();
    expect(session.shouldApplyInput('browser-2', 3)).toBe(true);
  });

  it('returns a retryable failure when recovery acquires input during an awaited mux write', async () => {
    const session = harness.ctx.sessions.get('test-session-1')!;
    vi.spyOn(session, 'writeViaMux').mockImplementationOnce(async () => {
      session.recoveryInputReserved = true;
      return false;
    });

    const blocked = await post({ input: 'race-safe\r', useMux: true, clientId: 'browser-3', seq: 4 });

    expect(blocked.statusCode).toBe(422);
    expect(blocked.json()).toMatchObject({ success: false, errorCode: 'OPERATION_FAILED' });
    expect(session.writeBuffer).not.toContain('race-safe\r');
    expect(session.shouldApplyInput('browser-3', 4)).toBe(true);
  });
});

/**
 * A plain prompt goes through the mux even when the caller did not say `useMux`.
 *
 * Measured on Claude Code 2.1.283: a direct write of `<text>\r` arrives as one burst,
 * a burst of about a hundred characters is taken as a paste, and its `\r` lands as a
 * newline in the composer, so a script's prompt sat there unsent while the route
 * answered 200. The mux path types the text, presses Enter on its own, and arms the
 * submit verifier.
 */
describe('POST /api/sessions/:id/input plain-prompt routing', () => {
  let harness: { app: FastifyInstance; ctx: MockRouteContext };

  beforeEach(async () => {
    harness = await createEnvelopeHarness();
  });
  afterEach(async () => {
    await harness.app.close();
  });

  const post = (body: Record<string, unknown>) =>
    harness.app.inject({ method: 'POST', url: '/api/sessions/test-session-1/input', payload: body });
  const spies = () => {
    const session = harness.ctx.sessions.get('test-session-1')!;
    return { session, viaMux: vi.spyOn(session, 'writeViaMux'), direct: vi.spyOn(session, 'write') };
  };
  const LONG_PROMPT =
    'Reply with only the word ok and nothing else, this sentence is padding to reach about one hundred chars.\r';

  it('sends a prompt with no useMux through the mux, not as one burst', async () => {
    const { viaMux, direct } = spies();

    const res = await post({ input: LONG_PROMPT });

    expect(res.statusCode).toBe(200);
    expect(viaMux).toHaveBeenCalledWith(LONG_PROMPT, { fromUser: true, isCurrent: expect.any(Function) });
    expect(direct).not.toHaveBeenCalled();
  });

  it('answers only once the mux write is done, so the next frame cannot overtake it', async () => {
    // The browser's POST fallback sends frames one at a time and waits for each 2xx;
    // a fire-and-forget write here would let its next keystroke land before the Enter.
    const { viaMux } = spies();
    let finished = false;
    viaMux.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      finished = true;
      return true;
    });

    await post({ input: 'ok\r', clientId: 'browser-1', seq: 1 });

    expect(finished).toBe(true);
  });

  it('falls back to the direct write when the mux write fails', async () => {
    const { viaMux, direct } = spies();
    viaMux.mockResolvedValue(false);

    await post({ input: 'hello\r' });

    expect(direct).toHaveBeenCalledWith('hello\r', { fromUser: true, isCurrent: expect.any(Function) });
  });

  it('keeps the raw write for an explicit useMux: false', async () => {
    const { viaMux, direct } = spies();

    await post({ input: LONG_PROMPT, useMux: false });

    expect(direct).toHaveBeenCalledWith(LONG_PROMPT, { fromUser: true, isCurrent: expect.any(Function) });
    expect(viaMux).not.toHaveBeenCalled();
  });

  it.each([
    ['a bare Enter', '\r'],
    ['text with no Enter', 'hello'],
    ['an arrow key', '\x1b[A'],
    ['a bracketed paste frame', '\x1b[200~line one\nline two\x1b[201~'],
    ['a line feed inside', 'line one\nline two\r'],
    ['two Enters', 'hello\r\r'],
    ['a tab', 'a\tb\r'],
  ])('leaves %s on the direct write', async (_label, input) => {
    const { viaMux, direct } = spies();

    await post({ input });

    expect(direct).toHaveBeenCalledWith(input, { fromUser: true, isCurrent: expect.any(Function) });
    expect(viaMux).not.toHaveBeenCalled();
  });
});

describe('isPlainPromptInput', () => {
  it('accepts printable text ending in exactly one carriage return', () => {
    expect(isPlainPromptInput('run the tests\r')).toBe(true);
    expect(isPlainPromptInput('ünïcødé and emoji 🚀\r')).toBe(true);
  });

  it('refuses anything carrying another control character', () => {
    for (const input of ['\r', 'x', 'x\n', 'x\r\n', 'x\r\r', '\x1b[Ax\r', 'a\tb\r', 'x\x7f\r', 'x\u009b\r', '\rx']) {
      expect(isPlainPromptInput(input), JSON.stringify(input)).toBe(false);
    }
  });
});
