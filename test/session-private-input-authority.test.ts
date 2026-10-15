/** A private authority lookup cannot attach a different mux/process or become asynchronous. */
import { afterEach, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import type { MuxSession, TerminalMultiplexer } from '../src/mux-interface.js';
import { fakeInputProvenance } from './helpers/codex-input-provenance.js';

const sessions: Session[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) {
    Object.assign(session, { _mux: null, _muxSession: null });
    await session.stop(false);
  }
});

function fixture() {
  const proof = fakeInputProvenance();
  const native = { pid: proof.brokerPid, recoveryIsolated: true } as MuxSession;
  const get = vi.fn();
  const mux = { getCodexInputAuthority: get } as unknown as TerminalMultiplexer;
  const session = new Session({
    workingDir: '/tmp',
    mode: 'codex',
    useMux: true,
    codexConfig: { noDaemon: true },
    mux,
    muxSession: native,
  });
  sessions.push(session);
  const authority = { sessionId: session.id, incarnation: proof.incarnation, directory: '/tmp/private-fixture', proof };
  get.mockReturnValue(authority);
  return { session, proof, authority, get, native };
}

it('returns only the exact registered signer/proof incarnation', () => {
  const { session, proof, authority, get } = fixture();
  expect(session.getRecoveryInputAuthority(proof)).toBe(authority);
  expect(get).toHaveBeenCalledExactlyOnceWith(session.id, proof);
});

it.each(['session', 'incarnation', 'proof', 'pane', 'pane-during-lookup', 'mux', 'record'] as const)(
  'refuses a changed %s binding',
  (kind) => {
    const { session, proof, authority, get, native } = fixture();
    if (kind === 'session') get.mockReturnValue({ ...authority, sessionId: 'other-fixture' });
    if (kind === 'incarnation') get.mockReturnValue({ ...authority, incarnation: 'other-incarnation' });
    if (kind === 'proof') get.mockReturnValue({ ...authority, proof: { ...proof } });
    if (kind === 'pane') native.pid++;
    if (kind === 'pane-during-lookup')
      get.mockImplementation(() => {
        native.pid++;
        return authority;
      });
    if (kind === 'mux' || kind === 'record')
      get.mockImplementation(() => {
        Reflect.set(session, kind === 'mux' ? '_mux' : '_muxSession', {});
        return authority;
      });
    expect(session.getRecoveryInputAuthority(proof)).toBeUndefined();
  }
);

it('drains asynchronous failures and refuses thrown or status-adorned async authorities', async () => {
  const { session, proof, authority, get } = fixture();
  get.mockReturnValue(Promise.reject(new Error('Private fixture failure')));
  expect(session.getRecoveryInputAuthority(proof)).toBeUndefined();
  get.mockReturnValue(Object.assign(Promise.resolve(authority), authority));
  expect(session.getRecoveryInputAuthority(proof)).toBeUndefined();
  get.mockImplementation(() => {
    throw new Error('Private fixture failure');
  });
  expect(session.getRecoveryInputAuthority(proof)).toBeUndefined();
  await Promise.resolve();
});
