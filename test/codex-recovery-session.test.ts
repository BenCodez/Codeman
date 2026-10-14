/** Recovery uses the real Session boundary with an isolated fake mux; never a live agent or tmux socket. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { TmuxManager } from '../src/tmux-manager.js';
import type { MuxSession, TerminalMultiplexer } from '../src/mux-interface.js';
import { CONTINUATION_PROMPT, type RecoveryFlight } from '../src/recovery/types.js';
import { createDeferred } from './mocks/index.js';

const THREAD = '11111111-2222-3333-4444-555555555555';
const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const sessions: Session[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.stop(false);
  vi.useRealTimers();
});

function fixture(extra: Record<string, unknown> = {}) {
  const pane = {
    paneId: '%7',
    panePid: 700,
    dead: true,
    status: 1 as number | undefined,
    signal: undefined as number | undefined,
    screen: null as string | null,
  };
  const mux = {
    isAvailable: () => true,
    inspectPaneForRecovery: vi.fn(async () => ({ ...pane })),
    respawnPane: vi.fn(async () => 99999),
    clearPaneExit: vi.fn(),
    sendInput: vi.fn(async () => true),
  };
  const muxSession = {
    muxName: 'codeman-aaaaaaaa',
    sessionId: SESSION,
    recoveryIsolated: true,
    recoveryCodexHome: '/srv/example/codex-home',
    pid: 99999,
    createdAt: Date.now(),
    workingDir: '/tmp',
    mode: 'codex',
    attached: true,
  } as MuxSession;
  const session = new Session({
    id: SESSION,
    workingDir: '/tmp',
    mode: 'codex',
    useMux: true,
    mux: mux as unknown as TerminalMultiplexer,
    muxSession,
    codexConfig: {
      noDaemon: true,
      noAltScreen: true,
      model: 'example-model',
      reasoningEffort: 'high',
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
    },
    envOverrides: { CODEX_HOME: '/srv/example/codex-home' },
    ...extra,
  });
  sessions.push(session);
  session.pinRecoveryConversation(THREAD);
  const flight: RecoveryFlight = { action: 'restart', key: 'crash', conversationId: THREAD, startedAt: Date.now() };
  return { session, mux, muxSession, pane, flight };
}

describe('the actual Session recovery boundary', () => {
  it('requires realized isolated launch evidence, not just the requested flag', async () => {
    const f = fixture();
    f.muxSession.recoveryIsolated = undefined;
    expect(f.session.getRecoveryContext().noDaemon).toBe(false);
    expect(await f.session.deliverRecovery(f.flight, 0)).toBe('not-sent');
    expect(f.mux.respawnPane).not.toHaveBeenCalled();
  });

  it('refuses legacy isolated panes without actual home provenance', async () => {
    const f = fixture();
    f.muxSession.recoveryCodexHome = undefined;
    expect(f.session.getRecoveryContext().noDaemon).toBe(false);
    expect(await f.session.deliverRecovery(f.flight, 0)).toBe('not-sent');
    expect(f.mux.respawnPane).not.toHaveBeenCalled();
  });

  it('pins the exact thread and preserves all launch settings and the session home on restart', async () => {
    const f = fixture();
    expect(await f.session.deliverRecovery(f.flight, 0)).toBe('sent');
    expect(f.mux.respawnPane).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        onlyIfDead: true,
        recoveryCodexHome: '/srv/example/codex-home',
        sessionId: SESSION,
        workingDir: '/tmp',
        codexConfig: {
          resumeSessionId: THREAD,
          noDaemon: true,
          noAltScreen: true,
          model: 'example-model',
          reasoningEffort: 'high',
          sandbox: 'workspace-write',
          approvalPolicy: 'on-request',
        },
        envOverrides: { CODEX_HOME: '/srv/example/codex-home' },
      })
    );
    expect(f.session.toState().codexConfig?.resumeSessionId).toBe(THREAD);
    expect(f.mux.clearPaneExit).toHaveBeenCalled();
  });

  it.each([{ dead: false }, { status: 0 }, { status: undefined, signal: undefined }])(
    'never restarts a live, cleanly exited, or unverified pane: %j',
    async (patch) => {
      const f = fixture();
      Object.assign(f.pane, patch);
      expect(await f.session.deliverRecovery(f.flight, 0)).toBe('not-sent');
      expect(f.mux.respawnPane).not.toHaveBeenCalled();
    }
  );

  it('pauses instead of inventing a new conversation when the exact identity differs', async () => {
    const f = fixture();
    f.flight.conversationId = '22222222-2222-3333-4444-555555555555';
    expect(await f.session.deliverRecovery(f.flight, 0)).toBe('not-sent');
    expect(f.mux.respawnPane).not.toHaveBeenCalled();
  });

  it('never injects a continuation into a working screen or typed composer', async () => {
    for (const screen of [
      'Working (esc to interrupt)\n›\n  example-model high · /tmp\n',
      '› user typing\n  example-model high · /tmp\n',
      '›\n  user multiline draft\n  example-model high · /tmp\n',
    ]) {
      const f = fixture();
      Object.assign(f.pane, { dead: false, status: undefined, screen });
      f.flight.action = 'continue';
      expect(await f.session.deliverRecovery(f.flight, 0)).toBe('not-sent');
      expect(f.mux.sendInput).not.toHaveBeenCalled();
    }
  });

  it('delivers one single-line continuation through mux input', async () => {
    const f = fixture();
    Object.assign(f.pane, { dead: false, status: undefined, screen: '›\n  example-model high · /tmp\n' });
    f.flight.action = 'continue';
    expect(await f.session.deliverRecovery(f.flight, 0)).toBe('sent');
    expect(f.mux.sendInput).toHaveBeenCalledExactlyOnceWith(
      SESSION,
      `${CONTINUATION_PROMPT}\r`,
      expect.objectContaining({ confirm: expect.any(Function), noteDispatch: expect.any(Function) })
    );
    expect(f.mux.respawnPane).not.toHaveBeenCalled();
  });

  it('never re-presses Enter for an unaccepted continuation or a subsequently edited draft', async () => {
    vi.useFakeTimers();
    const f = fixture();
    Object.assign(f.pane, { dead: false, status: undefined, screen: '›\n  example-model high · /tmp\n' });
    Object.assign(f.mux, { capturePaneText: vi.fn(() => `› ${CONTINUATION_PROMPT} edited draft\n`) });
    f.flight.action = 'continue';
    expect(await f.session.deliverRecovery(f.flight, 0)).toBe('sent');
    await vi.advanceTimersByTimeAsync(2000);
    f.session.trackUserInput(' edited draft');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.mux.sendInput).toHaveBeenCalledExactlyOnceWith(
      SESSION,
      `${CONTINUATION_PROMPT}\r`,
      expect.objectContaining({ confirm: expect.any(Function), noteDispatch: expect.any(Function) })
    );
  });

  it('cancels when user input or cleanup changes the generation during the fresh probe', async () => {
    const f = fixture();
    const pending = createDeferred<typeof f.pane>();
    f.mux.inspectPaneForRecovery.mockImplementationOnce(() => pending.promise);
    const action = f.session.deliverRecovery(f.flight, 0);
    f.session.trackUserInput('\n');
    pending.resolve(f.pane);
    expect(await action).toBe('not-sent');
    expect(f.mux.respawnPane).not.toHaveBeenCalled();
  });

  it('reserves user write paths while recovery dispatch is in flight', async () => {
    const f = fixture();
    const pending = createDeferred<number>();
    f.mux.respawnPane.mockImplementationOnce(() => pending.promise);
    const action = f.session.deliverRecovery(f.flight, 0);
    await Promise.resolve();
    expect(f.session.recoveryInputReserved).toBe(true);
    expect(await f.session.writeViaMux('new user prompt\r', { fromUser: true })).toBe(false);
    expect(f.session.write('x', { fromUser: true })).toBe(false);
    pending.resolve(99999);
    expect(await action).toBe('sent');
    expect(f.session.recoveryInputReserved).toBe(false);
  });

  it.each(['stop', 'identity', 'isolation'] as const)(
    'rechecks %s at the final Session dispatch boundary',
    async (change) => {
      const f = fixture();
      const pending = createDeferred<typeof f.pane>();
      f.mux.inspectPaneForRecovery.mockImplementationOnce(() => pending.promise);
      const delivery = f.session.deliverRecovery(f.flight, 0);
      if (change === 'stop') await f.session.stop(false);
      else if (change === 'identity') f.session.pinRecoveryConversation('22222222-2222-3333-4444-555555555555');
      else f.muxSession.recoveryIsolated = false;
      pending.resolve(f.pane);
      expect(await delivery).toBe('not-sent');
      expect(f.mux.respawnPane).not.toHaveBeenCalled();
      expect(f.mux.sendInput).not.toHaveBeenCalled();
    }
  );

  it.each(['continue', 'restart'] as const)(
    'respects controller cancellation during the final %s probe',
    async (action) => {
      const f = fixture();
      f.flight.action = action;
      if (action === 'continue')
        Object.assign(f.pane, { dead: false, status: undefined, screen: '›\n  example-model high · /tmp\n' });
      const pending = createDeferred<typeof f.pane>();
      f.mux.inspectPaneForRecovery.mockImplementationOnce(() => pending.promise);
      let current = true;
      const delivery = f.session.deliverRecovery(f.flight, 0, () => current);
      current = false;
      pending.resolve(f.pane);
      expect(await delivery).toBe('not-sent');
      expect(f.mux.respawnPane).not.toHaveBeenCalled();
      expect(f.mux.sendInput).not.toHaveBeenCalled();
    }
  );

  it('persists only the Codex home path and keeps all environment overrides off public state', () => {
    const f = fixture({
      envOverrides: {
        CODEX_HOME: '/srv/example/codex-home',
        CODEX_API_KEY: 'fixture-secret',
        OPENCODE_API_KEY: 'fixture-secret',
      },
    });
    expect(f.session.getEnvOverridesForPersist()).toEqual({ CODEX_HOME: '/srv/example/codex-home' });
    expect(JSON.stringify(f.session.toDetailedState())).not.toContain('/srv/example/codex-home');
    expect(JSON.stringify(f.session.toDetailedState())).not.toContain('fixture-secret');
  });

  it('treats a partial dispatch as uncertain, so the controller can avoid replaying it', async () => {
    const f = fixture();
    f.mux.respawnPane.mockResolvedValueOnce(null as unknown as number);
    expect(await f.session.deliverRecovery(f.flight, 0)).toBe('unknown');
  });

  it('refuses foreign, remote, Docker, closing and direct-PTY session shapes', async () => {
    for (const extra of [
      { discoveredMuxSession: true },
      { remote: { hostId: 'example-host', host: 'example.invalid', user: 'example' } },
      { docker: { hostId: 'example-container', containerName: 'example' } },
      { useMux: false },
    ]) {
      const f = fixture(extra);
      expect(await f.session.deliverRecovery(f.flight, 0)).toBe('not-sent');
      expect(f.mux.respawnPane).not.toHaveBeenCalled();
    }
    const f = fixture();
    f.session.markClosing(true);
    expect(await f.session.deliverRecovery(f.flight, 0)).toBe('not-sent');
  });
});

describe('Codeman reboot of its own server preserves crashed panes and circuit control', () => {
  it('vetoes the old resume seed on every restored pane, including switches missed during downtime', async () => {
    const f = fixture({ preserveExitedPane: true, codexConfig: { noDaemon: true, resumeSessionId: THREAD } });
    expect(f.session.getRecoveryContext().switchPending).toBe(true);
    expect(await f.session.deliverRecovery(f.flight, 0)).toBe('not-sent');
    expect(f.mux.respawnPane).not.toHaveBeenCalled();
  });

  it('attaches to the dead pane without automatically launching a new Codex process', async () => {
    const mux = new TmuxManager();
    const record = await mux.createSession({ sessionId: SESSION, workingDir: '/tmp', mode: 'codex' });
    vi.spyOn(mux, 'muxSessionExists').mockReturnValue(true);
    vi.spyOn(mux, 'isPaneDead').mockReturnValue(true);
    const respawn = vi.spyOn(mux, 'respawnPane');
    const create = vi.spyOn(mux, 'createSession');
    const session = new Session({
      id: SESSION,
      workingDir: '/tmp',
      mode: 'codex',
      mux,
      muxSession: record,
      useMux: true,
      preserveExitedPane: true,
      codexConfig: { noDaemon: true, resumeSessionId: THREAD },
    });
    sessions.push(session);
    await session.startInteractive();
    expect(respawn).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(session.toState().codexConfig?.resumeSessionId).toBe(THREAD);
  });
});

it.each(['unchanged', 'cancelled'] as const)(
  'awaits fresh asynchronous evidence while retaining pure current authority: %s',
  async (change) => {
    const f = fixture();
    const entered = createDeferred<void>();
    const held = createDeferred<boolean>();
    let current = true;
    const delivery = f.session.deliverRecovery(
      f.flight,
      0,
      () => current,
      CONTINUATION_PROMPT,
      async () => {
        entered.resolve();
        return held.promise;
      }
    );
    await entered.promise;
    expect(f.mux.respawnPane).not.toHaveBeenCalled();
    if (change === 'cancelled') current = false;
    held.resolve(true);
    expect(await delivery).toBe(change === 'unchanged' ? 'sent' : 'not-sent');
    expect(f.mux.respawnPane).toHaveBeenCalledTimes(change === 'unchanged' ? 1 : 0);
  }
);
