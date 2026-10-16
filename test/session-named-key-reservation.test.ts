import { randomUUID } from 'node:crypto';
/** @fileoverview Named keys own the actual Session input boundary throughout async dispatch. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import type { MuxSession, TerminalMultiplexer } from '../src/mux-interface.js';
import type { RecoveryFlight } from '../src/recovery/types.js';
import { createDeferred } from './mocks/index.js';

const THREAD = '11111111-2222-3333-4444-555555555555';
const sessions: Session[] = [];

function fixture() {
  const SID = randomUUID();
  const mux = {
    isAvailable: () => true,
    inspectPaneForRecovery: vi.fn(async () => ({ dead: true, status: 1, screen: null })),
    respawnPane: vi.fn(async () => 99999),
    clearPaneExit: vi.fn(),
    sendInput: vi.fn(async () => true),
  };
  const muxSession = {
    muxName: 'codeman-aaaaaaaa',
    sessionId: SID,
    recoveryIsolated: true,
    recoveryCodexHome: '/fixture/codex-home',
    pid: 99999,
    createdAt: Date.now(),
    workingDir: '/tmp',
    mode: 'codex',
    attached: true,
  } as MuxSession;
  const session = new Session({
    id: SID,
    workingDir: '/tmp',
    mode: 'codex',
    useMux: true,
    mux: mux as unknown as TerminalMultiplexer,
    muxSession,
    codexConfig: { noDaemon: true, noAltScreen: true },
  });
  sessions.push(session);
  session.pinRecoveryConversation(THREAD);
  const flight: RecoveryFlight = { action: 'restart', key: 'crash', conversationId: THREAD, startedAt: Date.now() };
  return { session, mux, flight };
}

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.stop(false);
  vi.restoreAllMocks();
});

describe('named-key input reservation', () => {
  it.each(['recovery', 'key'] as const)(
    'retains %s reservation ahead of rejected tagged lifecycle owner intent',
    async (reservation) => {
      const f = fixture();
      const before = f.session.getRecoveryContext().generation;
      const intent = vi.fn();
      f.session.on('recoveryUserInput', intent);
      const keyAbort = reservation === 'key' ? new AbortController() : null;
      Object.assign(f.session, {
        _paneLifecycleOps: 1,
        _recoveryDelivering: reservation === 'recovery',
        _namedKeyAbort: keyAbort,
      });
      const options = { fromUser: true, inputSeq: { clientId: 'fixture-client', seq: 1 } };
      try {
        expect(f.session.shouldApplyInput('fixture-client', 1)).toBe(true);
        expect(await f.session.writeAsync('rejected owner input\r', options)).toBe(false);
        expect(await f.session.writeViaMux('rejected owner input\r', options)).toBe(false);
        expect(f.session.write('rejected owner input\r', options)).toBe(false);
        expect(intent).not.toHaveBeenCalled();
        expect(f.session.getRecoveryContext().generation).toBe(before);
        expect(f.session.lastSubmitAt).toBe(0);
        expect(f.session.hasAppliedInputSeq('fixture-client', 1)).toBe(false);
        expect(f.mux.sendInput).not.toHaveBeenCalled();
        expect(f.session.recoveryInputReserved).toBe(true);
        expect(keyAbort?.signal.aborted).not.toBe(true);
        f.session.forgetInputSeq('fixture-client', 1);
        expect(f.session.shouldApplyInput('fixture-client', 1)).toBe(true);
      } finally {
        Object.assign(f.session, { _paneLifecycleOps: 0, _recoveryDelivering: false, _namedKeyAbort: null });
      }
    }
  );

  it.each(['pty', 'mux', 'key'] as const)(
    'cancels a tentative launch for rejected owner %s input without committing bytes or submission evidence',
    async (transport) => {
      const f = fixture();
      const before = f.session.getRecoveryContext().generation;
      const intent = vi.fn();
      f.session.on('recoveryUserInput', intent);
      Object.assign(f.session, { _paneLifecycleOps: 1 });
      expect(f.session.shouldApplyInput('fixture-client', 1)).toBe(true);
      const dispatch = vi.fn(async () => {});
      const data = 'Rejected owner request\r';
      const options = { fromUser: true, inputSeq: { clientId: 'fixture-client', seq: 1 } };
      const delivered =
        transport === 'pty'
          ? await f.session.writeAsync(data, options)
          : transport === 'mux'
            ? await f.session.writeViaMux(data, options)
            : await f.session.sendNamedKey(data, dispatch);
      expect(delivered).toBe(false);
      expect(intent).toHaveBeenCalledOnce();
      expect(f.session.getRecoveryContext()).toMatchObject({ switchPending: true, submission: undefined });
      expect(f.session.getRecoveryContext().generation).toBeGreaterThan(before);
      expect(f.session.lastSubmitAt).toBe(0);
      expect(f.session.hasAppliedInputSeq('fixture-client', 1)).toBe(false);
      expect(dispatch).not.toHaveBeenCalled();
      expect(f.mux.sendInput).not.toHaveBeenCalled();
      Object.assign(f.session, { _paneLifecycleOps: 0 });
      f.session.forgetInputSeq('fixture-client', 1);
      expect(f.session.shouldApplyInput('fixture-client', 1)).toBe(true);
    }
  );

  it('rejects programmatic lifecycle input without manufacturing owner intent', async () => {
    const f = fixture();
    const before = f.session.getRecoveryContext().generation;
    const intent = vi.fn();
    f.session.on('recoveryUserInput', intent);
    Object.assign(f.session, { _paneLifecycleOps: 1 });
    expect(await f.session.writeAsync('programmatic\r')).toBe(false);
    expect(await f.session.writeViaMux('programmatic\r')).toBe(false);
    expect(intent).not.toHaveBeenCalled();
    expect(f.session.getRecoveryContext().generation).toBe(before);
    expect(f.mux.sendInput).not.toHaveBeenCalled();
    Object.assign(f.session, { _paneLifecycleOps: 0 });
  });

  it.each(['pty', 'mux'] as const)(
    'rejects programmatic or stale-caller tagged %s input without manufacturing owner intent',
    async (transport) => {
      const f = fixture();
      const before = f.session.getRecoveryContext().generation;
      const intent = vi.fn();
      f.session.on('recoveryUserInput', intent);
      Object.assign(f.session, { _paneLifecycleOps: 1 });
      for (const options of [
        { inputSeq: { clientId: 'fixture-client', seq: 1 } },
        { fromUser: true, inputSeq: { clientId: 'fixture-client', seq: 1 }, isCurrent: () => false },
      ]) {
        const delivered =
          transport === 'pty'
            ? await f.session.writeAsync('not owner intent', options)
            : await f.session.writeViaMux('not owner intent', options);
        expect(delivered).toBe(false);
      }
      expect(intent).not.toHaveBeenCalled();
      expect(f.session.getRecoveryContext().generation).toBe(before);
      expect(f.mux.sendInput).not.toHaveBeenCalled();
      Object.assign(f.session, { _paneLifecycleOps: 0 });
    }
  );
  it('rejects direct named keys on a cached dead worker before preparation or owner intent', async () => {
    const f = fixture();
    f.session.setPaneExit({ at: Date.now(), status: 42 });
    const before = f.session.getRecoveryContext().generation;
    const intent = vi.fn();
    f.session.on('recoveryUserInput', intent);
    const prepare = vi.fn(() => true);
    const dispatch = vi.fn(async () => {});
    expect(await f.session.sendNamedKey('\n', dispatch, prepare)).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(intent).not.toHaveBeenCalled();
    expect(f.session.getRecoveryContext().generation).toBe(before);
    expect(f.session.lastSubmitAt).toBe(0);
    f.session.setPaneExit(undefined);
    expect(await f.session.sendNamedKey('\n', dispatch, prepare)).toBe(true);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('cancels old authority before dispatch and excludes recovery, another key, and text until completion', async () => {
    const f = fixture();
    expect(await f.session.ensureRecoveryIdentityFence()).toBe(true);
    const done = createDeferred<void>();
    const before = f.session.getRecoveryContext().generation;
    const dispatch = vi.fn(() => done.promise);
    const key = f.session.sendNamedKey('\n', dispatch);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    expect(f.session.getRecoveryContext().generation).toBeGreaterThan(before);
    expect(f.session.recoveryInputReserved).toBe(true);
    expect(f.session.paneLifecycleInFlight).toBe(true);
    expect(await f.session.deliverRecovery(f.flight, f.session.getRecoveryContext().generation)).toBe('not-sent');
    expect(f.mux.respawnPane).not.toHaveBeenCalled();
    expect(await f.session.writeAsync('following text', { fromUser: true })).toBe(false);
    expect(await f.session.writeViaMux('following text', { fromUser: true })).toBe(false);
    const second = vi.fn(async () => {});
    expect(await f.session.sendNamedKey('\n', second)).toBe(false);
    expect(second).not.toHaveBeenCalled();
    done.resolve();
    expect(await key).toBe(true);
    expect(f.session.recoveryInputReserved).toBe(false);
    expect(f.session.paneLifecycleInFlight).toBe(false);
  });

  it('certifies rejection without dispatch or generation changes when recovery already owns the pane', async () => {
    const f = fixture();
    expect(await f.session.ensureRecoveryIdentityFence()).toBe(true);
    const restarted = createDeferred<number>();
    f.mux.respawnPane.mockReturnValueOnce(restarted.promise);
    const recovery = f.session.deliverRecovery(f.flight, 0);
    await vi.waitFor(() => expect(f.mux.respawnPane).toHaveBeenCalledOnce());
    const before = f.session.getRecoveryContext().generation;
    const dispatch = vi.fn(async () => {});
    expect(await f.session.sendNamedKey('\n', dispatch)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(f.session.getRecoveryContext().generation).toBe(before);
    restarted.resolve(99999);
    expect(await recovery).toBe('sent');
    expect(f.session.recoveryInputReserved).toBe(false);
  });

  it('releases the slot and invalidates proof when dispatched delivery fails ambiguously', async () => {
    const f = fixture();
    expect(await f.session.ensureRecoveryIdentityFence()).toBe(true);
    await expect(
      f.session.sendNamedKey('\n', async () => {
        throw new Error('unknown delivery');
      })
    ).rejects.toThrow('unknown delivery');
    expect(f.session.recoveryInputReserved).toBe(false);
    expect(f.session.paneLifecycleInFlight).toBe(false);
    expect(f.session.getRecoveryContext()).toMatchObject({ switchPending: true, submission: undefined });
    expect(await f.session.deliverRecovery(f.flight, f.session.getRecoveryContext().generation)).toBe('not-sent');
    expect(f.mux.respawnPane).not.toHaveBeenCalled();
  });

  it('aborts a pending child when the owner stops the session', async () => {
    const f = fixture();
    expect(await f.session.ensureRecoveryIdentityFence()).toBe(true);
    let childSignal: AbortSignal | undefined;
    const key = f.session.sendNamedKey('\n', (signal) => {
      childSignal = signal;
      return new Promise<void>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('child aborted')), { once: true })
      );
    });
    const rejected = expect(key).rejects.toThrow('child aborted');
    await vi.waitFor(() => expect(childSignal).toBeDefined());
    await f.session.stop(false);
    await rejected;
    expect(childSignal?.aborted).toBe(true);
    expect(f.session.recoveryInputReserved).toBe(false);
    const dispatch = vi.fn(async () => {});
    expect(await f.session.sendNamedKey('\n', dispatch)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not let a key overtake ordinary mux input still in flight', async () => {
    const f = fixture();
    expect(await f.session.ensureRecoveryIdentityFence()).toBe(true);
    const written = createDeferred<boolean>();
    f.mux.sendInput.mockReturnValueOnce(written.promise);
    const input = f.session.writeViaMux('preceding text', { fromUser: true });
    await vi.waitFor(() => expect(f.mux.sendInput).toHaveBeenCalledOnce());
    const dispatch = vi.fn(async () => {});
    expect(await f.session.sendNamedKey('\n', dispatch)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    written.resolve(true);
    expect(await input).toBe(true);
    expect(await f.session.sendNamedKey('\n', dispatch)).toBe(true);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
  });
});
