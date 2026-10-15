/** App-owned PTY frames retain original prompt evidence and delivery reservations. */
import { afterEach, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { hashCodexPrompt } from '../src/recovery/codex-identity.js';

const sessions: Session[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) {
    Object.assign(session, { ptyProcess: null, _mux: null });
    await session.stop(false);
  }
});

function fixture(result: unknown = { status: 'framed', data: 'private-frame-fixture' }) {
  const session = new Session({ workingDir: '/tmp', mode: 'codex', useMux: false });
  sessions.push(session);
  const wrap = vi.fn(() => result);
  const written = vi.fn();
  Object.assign(session, { _mux: { wrapCodexOwnerInput: wrap }, ptyProcess: { write: written } });
  return { session, wrap, written };
}

it.each([false, true])(
  'frames owner input while tracking the original Unicode prompt (fallback=%s)',
  async (fallback) => {
    const { session, wrap, written } = fixture();
    const submitted = vi.fn();
    session.on('promptSubmitted', submitted);
    const raw = 'Please preserve café 🧭 exactly\r';
    expect(session.shouldApplyInput('browser', 7)).toBe(true);
    const options = { fromUser: true, inputSeq: { clientId: 'browser', seq: 7 } };
    expect(fallback ? await session.writeViaMux(raw, options) : session.write(raw, options)).toBe(true);
    expect(wrap).toHaveBeenCalledWith(session.id, raw);
    expect(written).toHaveBeenCalledExactlyOnceWith('private-frame-fixture');
    expect(submitted).toHaveBeenCalledExactlyOnceWith(raw.slice(0, -1));
    expect(session.getRecoveryContext().submission?.hash).toBe(hashCodexPrompt(raw.slice(0, -1)));
    expect(session.lastInputSeq('browser')).toBe(7);
  }
);

it.each([false, true])(
  'retains a known refused frame and its FIFO slot until the guard is ready (fallback=%s)',
  async (fallback) => {
    const { session, wrap, written } = fixture({ status: 'refused' });
    expect(session.shouldApplyInput('browser', 1)).toBe(true);
    const options = { fromUser: true, inputSeq: { clientId: 'browser', seq: 1 } };
    const send = () => (fallback ? session.writeViaMux('one', options) : session.write('one', options));
    expect(await send()).toBe(false);
    expect(written).not.toHaveBeenCalled();
    expect(session.hasAppliedInputSeq('browser', 1)).toBe(false);
    session.forgetInputSeq('browser', 1);
    expect(session.shouldApplyInput('browser', 2)).toBe(false);
    wrap.mockReturnValue({ status: 'framed', data: 'ready-frame-fixture' });
    expect(session.shouldApplyInput('browser', 1)).toBe(true);
    expect(await send()).toBe(true);
    expect(written).toHaveBeenCalledExactlyOnceWith('ready-frame-fixture');
    expect(session.lastInputSeq('browser')).toBe(1);
    expect(
      fallback ? await session.writeViaMux('\r', { fromUser: true }) : session.write('\r', { fromUser: true })
    ).toBe(true);
    expect(session.getRecoveryContext().submission?.hash).toBe(hashCodexPrompt('one'));
    expect(session.shouldApplyInput('browser', 2)).toBe(true);
  }
);

it.each([
  undefined,
  null,
  {},
  { status: 'framed' },
  { status: 'framed', data: '' },
  { status: 'framed', data: 1 },
  Promise.resolve({ status: 'passthrough' }),
])('never treats malformed or asynchronous guard results as delivery: %j', (result) => {
  const { session, wrap, written } = fixture();
  wrap.mockReturnValue(result);
  expect(session.write('owner text')).toBe(false);
  expect(written).not.toHaveBeenCalled();
});

it.each([false, true])('seals framed input if the PTY throws after bytes land (fallback=%s)', async (fallback) => {
  const { session, written } = fixture();
  const landed: string[] = [];
  written.mockImplementation((input) => {
    landed.push(input);
    throw new Error('Isolated partial write');
  });
  expect(session.shouldApplyInput('browser', 7)).toBe(true);
  const options = { inputSeq: { clientId: 'browser', seq: 7 } };
  if (fallback) await expect(session.writeViaMux('owner text', options)).rejects.toThrow('partial write');
  else expect(() => session.write('owner text', options)).toThrow('partial write');
  expect(landed).toEqual(['private-frame-fixture']);
  expect(session.hasAppliedInputSeq('browser', 7)).toBe(true);
  session.forgetInputSeq('browser', 7);
  expect(session.shouldApplyInput('browser', 7)).toBe(false);
});

it('keeps manual input working for legacy panes explicitly reported as passthrough', () => {
  const { session, written } = fixture({ status: 'passthrough' });
  expect(session.write('legacy café 🧭')).toBe(true);
  expect(written).toHaveBeenCalledExactlyOnceWith('legacy café 🧭');
});

it('drains and refuses rejected or status-adorned asynchronous formatter results', async () => {
  const { session, wrap, written } = fixture();
  wrap.mockImplementationOnce(() => Promise.reject(new Error('Isolated malformed async formatter')));
  expect(session.write('owner text')).toBe(false);
  wrap.mockReturnValue(Object.assign(Promise.resolve(true), { status: 'passthrough' }));
  expect(session.write('owner text')).toBe(false);
  await Promise.resolve();
  expect(written).not.toHaveBeenCalled();
});

it('checks mux readiness before recording refused text or its Enter timestamp', async () => {
  const { session, written } = fixture();
  const ready = vi.fn(() => false);
  const native = vi.fn(async () => true);
  Object.assign(session, {
    _mux: { canDeliverCodexOwnerInput: ready, sendInput: native },
    _muxSession: { muxName: 'codeman-fixture' },
  });
  expect(await session.writeViaMux('one\r', { fromUser: true })).toBe(false);
  expect(session.lastSubmitAt).toBe(0);
  expect(native).not.toHaveBeenCalled();
  expect(written).not.toHaveBeenCalled();
  expect(session.getRecoveryContext().switchPending).toBe(true);
  ready.mockReturnValue(true);
  expect(await session.writeViaMux('one\r', { fromUser: true })).toBe(true);
  expect(native).toHaveBeenCalledExactlyOnceWith(session.id, 'one\r');
  expect(session.getRecoveryContext().submission?.hash).toBe(hashCodexPrompt('one'));
});

it.each([false, true])(
  'preserves retry evidence and owner intent after a throwing formatter (fallback=%s)',
  async (fallback) => {
    const { session, wrap, written } = fixture();
    const generation = session.getRecoveryContext().generation;
    expect(session.shouldApplyInput('browser', 1)).toBe(true);
    const options = { fromUser: true, inputSeq: { clientId: 'browser', seq: 1 } };
    wrap.mockImplementationOnce(() => {
      throw new Error('Isolated formatter failure');
    });
    expect(fallback ? await session.writeViaMux('one\r', options) : session.write('one\r', options)).toBe(false);
    expect(written).not.toHaveBeenCalled();
    expect(session.lastSubmitAt).toBe(0);
    expect(session.getRecoveryContext()).toMatchObject({ generation: generation + 1, switchPending: true });
    expect(session.hasAppliedInputSeq('browser', 1)).toBe(false);
    session.forgetInputSeq('browser', 1);
    expect(session.shouldApplyInput('browser', 2)).toBe(false);
    expect(session.shouldApplyInput('browser', 1)).toBe(true);
    expect(fallback ? await session.writeViaMux('one\r', options) : session.write('one\r', options)).toBe(true);
    expect(session.getRecoveryContext().submission?.hash).toBe(hashCodexPrompt('one'));
  }
);

it.each([false, true])('keeps a missing-PTY refusal out of the retried draft (fallback=%s)', async (fallback) => {
  const { session, written } = fixture();
  Object.assign(session, { ptyProcess: null });
  const send = () =>
    fallback ? session.writeViaMux('one\r', { fromUser: true }) : session.write('one\r', { fromUser: true });
  expect(await send()).toBe(false);
  expect(session.lastSubmitAt).toBe(0);
  expect(session.getRecoveryContext().switchPending).toBe(true);
  Object.assign(session, { ptyProcess: { write: written } });
  expect(await send()).toBe(true);
  expect(session.getRecoveryContext().submission?.hash).toBe(hashCodexPrompt('one'));
});
