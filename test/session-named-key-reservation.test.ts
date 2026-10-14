/** @fileoverview Named keys own the actual Session input boundary throughout async dispatch. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import type { MuxSession, TerminalMultiplexer } from '../src/mux-interface.js';
import type { RecoveryFlight } from '../src/recovery/types.js';
import { createDeferred } from './mocks/index.js';

const THREAD = '11111111-2222-3333-4444-555555555555';
const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const sessions: Session[] = [];

function fixture() {
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
  it('cancels old authority before dispatch and excludes recovery, another key, and text until completion', async () => {
    const f = fixture();
    const done = createDeferred<void>();
    const before = f.session.getRecoveryContext().generation;
    const dispatch = vi.fn(() => done.promise);
    const key = f.session.sendNamedKey('\n', dispatch);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(f.session.getRecoveryContext().generation).toBeGreaterThan(before);
    expect(f.session.recoveryInputReserved).toBe(true);
    expect(f.session.paneLifecycleInFlight).toBe(true);
    expect(await f.session.deliverRecovery(f.flight, f.session.getRecoveryContext().generation)).toBe('not-sent');
    expect(f.mux.respawnPane).not.toHaveBeenCalled();
    expect(f.session.write('following text', { fromUser: true })).toBe(false);
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
    let childSignal: AbortSignal | undefined;
    const key = f.session.sendNamedKey('\n', (signal) => {
      childSignal = signal;
      return new Promise<void>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('child aborted')), { once: true })
      );
    });
    const rejected = expect(key).rejects.toThrow('child aborted');
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
    expect(dispatch).toHaveBeenCalledOnce();
  });
});
