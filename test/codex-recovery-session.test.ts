vi.mock('../src/recovery/remote-clock.js', async (original) => ({
  ...(await original<typeof import('../src/recovery/remote-clock.js')>()),
  sampleRemoteCodexClock: vi.fn(async () => clockAt()),
}));
import { sampleRemoteCodexClock } from '../src/recovery/remote-clock.js';
/** Recovery uses the real Session boundary with an isolated fake mux; never a live agent or tmux socket. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Session } from '../src/session.js';
import { TmuxManager } from '../src/tmux-manager.js';
import type { MuxSession, TerminalMultiplexer } from '../src/mux-interface.js';
import { CONTINUATION_PROMPT, type RecoveryFlight } from '../src/recovery/types.js';
import { createDeferred } from './mocks/index.js';
import { CodexRecoveryAdapter, type CodexRecoveryAdapterDeps } from '../src/recovery/codex-adapter.js';
import { CodexTaskAdapter } from '../src/supervision/adapter.js';
import { readRebootIdentityFence, writeRebootIdentityFence } from '../src/recovery/reboot-identity-fence.js';
import { dataPath } from '../src/config/instance.js';
import {
  clampEnvOverridesForOwner,
  clampExternalCliConfigsForOwner,
  clampRecoveryLaunchForOwner,
} from '../src/session-env-clamp.js';

vi.mock('../src/session-env-clamp.js', () => {
  const config = vi.fn(async (_owner, configs) => configs);
  const environment = vi.fn(async (_owner, env) => env);
  return {
    clampExternalCliConfigsForOwner: config,
    clampEnvOverridesForOwner: environment,
    clampRecoveryLaunchForOwner: vi.fn(async (owner, configs, env) => ({
      configs: await config(owner, configs),
      env: await environment(owner, env),
      isCurrent: () => true,
    })),
  };
});

const clockAt = (remoteAt = Date.now(), localAt = Date.now()) => ({
  localBefore: localAt,
  localAfter: localAt,
  remoteBefore: remoteAt,
  remoteAfter: remoteAt,
});
const THREAD = '11111111-2222-3333-4444-555555555555';
const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const sessions: Session[] = [];
const configClamp = vi.mocked(clampExternalCliConfigsForOwner);
const envClamp = vi.mocked(clampEnvOverridesForOwner);
beforeEach(() => {
  vi.mocked(sampleRemoteCodexClock)
    .mockReset()
    .mockImplementation(async () => clockAt());
  configClamp.mockReset().mockImplementation(async (_owner, configs) => configs);
  envClamp.mockReset().mockImplementation(async (_owner, env) => env);
});
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.stop(false);
  vi.useRealTimers();
});

function fixture(extra: Record<string, unknown> = {}) {
  const pane = { dead: true, status: 1, signal: undefined as number | undefined, screen: null as string | null };
  const mux = {
    isAvailable: () => true,
    inspectPaneForRecovery: vi.fn(async () => ({ ...pane })),
    respawnPane: vi.fn(async () => 99999),
    clearPaneExit: vi.fn(),
    sendInput: vi.fn(async () => true),
    capturePaneText: vi.fn(async () => '› stale prompt\n'),
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

  it('does not let a stall reservation weaken the dead abnormal-pane restart boundary', async () => {
    for (const patch of [{ dead: false }, { dead: true, status: 0 }, { dead: true, status: undefined }]) {
      const f = fixture();
      f.flight.reason = 'stalled';
      Object.assign(f.pane, patch);
      expect(await f.session.deliverRecovery(f.flight, 0)).toBe('not-sent');
      expect(f.mux.respawnPane).not.toHaveBeenCalled();
    }
  });

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
      Object.assign(f.pane, { dead: false, screen });
      f.flight.action = 'continue';
      expect(await f.session.deliverRecovery(f.flight, 0)).toBe('not-sent');
      expect(f.mux.sendInput).not.toHaveBeenCalled();
    }
  });

  it('delivers one single-line continuation through mux input', async () => {
    const f = fixture();
    Object.assign(f.pane, { dead: false, screen: '›\n  example-model high · /tmp\n' });
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
    Object.assign(f.pane, { dead: false, screen: '›\n  example-model high · /tmp\n' });
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
      if (action === 'continue') Object.assign(f.pane, { dead: false, screen: '›\n  example-model high · /tmp\n' });
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

describe('the actual owned remote Session boundary', () => {
  const ownedRemote = {
    hostId: 'fixture-host',
    label: 'Fixture',
    host: 'fixture.invalid',
    username: 'runner',
    remotePath: '/tmp',
    owned: true,
  };

  it.each([-60_000, 60_000])(
    'pins a pre-input clock witness for ordinary owner Enter with %i ms skew',
    async (offset) => {
      const f = fixture({ remote: ownedRemote });
      const at = Date.now();
      vi.mocked(sampleRemoteCodexClock).mockResolvedValue(clockAt(at + offset, at));
      expect(await f.session.writeViaMux('Sanitized owner prompt\r', { fromUser: true })).toBe(true);
      expect(f.session.getRecoveryContext().submission).toMatchObject({
        clockDomain: 'local',
        clock: clockAt(at + offset, at),
        hash: createHash('sha256').update('Sanitized owner prompt').digest('hex'),
      });
      expect(f.mux.sendInput).toHaveBeenCalledExactlyOnceWith(SESSION, 'Sanitized owner prompt\r');
    }
  );

  it.each(['closing', 'configuration', 'new-input'] as const)(
    'refuses original owner input when %s changes during the clock await',
    async (change) => {
      const f = fixture({ remote: ownedRemote });
      const release = createDeferred<ReturnType<typeof clockAt>>();
      vi.mocked(sampleRemoteCodexClock).mockReturnValue(release.promise);
      const pending = f.session.writeViaMux('Old owner prompt\r', { fromUser: true });
      expect(f.session.recoveryInputReserved).toBe(true);
      if (change === 'closing') f.session.markClosing(true);
      if (change === 'configuration') f.session.pinRecoveryConversation('22222222-2222-4222-8222-222222222222');
      if (change === 'new-input') f.session.trackUserInput('A later owner edit');
      release.resolve(clockAt());
      await expect(pending).rejects.toThrow('Owner input admission changed before dispatch');
      expect(f.mux.sendInput).not.toHaveBeenCalled();
      expect(f.session.getRecoveryContext().submission).toBeUndefined();
      expect(f.session.recoveryInputReserved).toBe(false);
    }
  );

  it('allows owner input after failed read-only clock sampling while leaving it ineligible for automation', async () => {
    const f = fixture({ remote: ownedRemote });
    vi.mocked(sampleRemoteCodexClock).mockRejectedValue(new Error('Fixture SSH transport unavailable'));
    expect(await f.session.writeViaMux('New owner prompt\r', { fromUser: true })).toBe(true);
    expect(f.session.getRecoveryContext().submission?.clock).toBeUndefined();
    expect(f.mux.sendInput).toHaveBeenCalledOnce();
  });

  it('rechecks the admission token after the preparation Promise resumes and discards canceled clock provenance', async () => {
    const f = fixture({ remote: ownedRemote });
    const prepare = f.session.prepareUserInputClock.bind(f.session);
    vi.spyOn(f.session, 'prepareUserInputClock').mockImplementation(async (data, options) => {
      const admission = await prepare(data, options);
      queueMicrotask(() => f.session.markClosing(true));
      return admission;
    });
    await expect(f.session.writeViaMux('Old owner prompt\r', { fromUser: true })).rejects.toThrow(
      'Owner input admission changed'
    );
    expect(f.mux.sendInput).not.toHaveBeenCalled();
    expect(Reflect.get(f.session, '_preparedRemoteClock')).toBeUndefined();
    expect(f.session.getRecoveryContext().submission).toBeUndefined();
  });

  it('rejects a claimed remote receipt without clock provenance while keeping actual delivery uncertain', async () => {
    const f = fixture({ remote: ownedRemote });
    const dispatch = vi.fn(async () => ({ status: 'sent' as const, submittedAt: Date.now() }));
    expect(await f.session.deliverRemoteRecoveryInput(THREAD, 0, CONTINUATION_PROMPT, dispatch)).toBe('unknown');
    expect(dispatch).toHaveBeenCalledOnce();
    expect(f.session.getRecoveryContext().submission).toBeUndefined();
  });

  it.each(['local', 'remote', 'malformed', 'domain', 'timestamp'] as const)(
    'preserves valid %s private submission clock metadata and fences malformed provenance',
    (kind) => {
      const id = `remote-clock-fence-${kind}`;
      const at = Date.now();
      const clock = clockAt(at + 60_000, at);
      const submission = {
        at: kind === 'remote' ? at + 60_000 : at,
        hash: 'a'.repeat(64),
        clockDomain: kind === 'remote' ? ('remote' as const) : ('local' as const),
        clock: kind === 'malformed' ? { ...clock, localAfter: at - 1 } : clock,
      };
      if (kind === 'domain') Reflect.set(submission, 'clockDomain', 'unknown');
      if (kind === 'timestamp') submission.at += 0.5;
      try {
        writeRebootIdentityFence(id, { switchPending: false, submission });
        expect(readRebootIdentityFence(id)).toEqual(
          ['malformed', 'domain', 'timestamp'].includes(kind)
            ? { switchPending: true }
            : { switchPending: false, submission }
        );
      } finally {
        rmSync(dataPath('reboot-identities', `${id}.json`), { force: true });
      }
    }
  );

  it.each(['unchanged', 'revoked', 'retargeted', 'cancelled'] as const)(
    'rechecks one current owner grant snapshot at final SSH admission: %s',
    async (change) => {
      const f = fixture({ remote: ownedRemote });
      const expected = f.session.remoteRecoveryConfiguration();
      if (change === 'revoked') configClamp.mockImplementation(async () => ({ codexConfig: { noDaemon: true } }));
      if (change === 'retargeted') f.session.pinRecoveryConversation('22222222-2222-4222-8222-222222222222');
      expect(await f.session.confirmRemoteRecoveryAuthority(THREAD, 0, () => change !== 'cancelled', expected)).toBe(
        change === 'unchanged'
      );
    }
  );

  it('retains the current grant snapshot token for grant-only changes after the async clamp resolves', async () => {
    const f = fixture({ remote: ownedRemote });
    const expected = f.session.remoteRecoveryConfiguration();
    let granted = true;
    vi.mocked(clampRecoveryLaunchForOwner).mockImplementationOnce(async (_owner, configs, env) => ({
      configs,
      env,
      isCurrent: () => granted,
    }));
    expect(await f.session.confirmRemoteRecoveryAuthority(THREAD, 0, () => true, expected)).toBe(true);
    expect(f.session.isRemoteRecoveryAuthorityCurrent(THREAD, 0, () => true, expected)).toBe(true);
    granted = false;
    expect(f.session.isRemoteRecoveryAuthorityCurrent(THREAD, 0, () => true, expected)).toBe(false);
  });

  it.each([undefined, '', 'relative/home'])(
    'refuses every remote mutation with an unpinned worker home (%s)',
    async (codexHome) => {
      const f = fixture({
        remote: ownedRemote,
        envOverrides: codexHome === undefined ? {} : { CODEX_HOME: codexHome },
      });
      const input = vi.fn(async () => ({ status: 'sent' as const, submittedAt: Date.now(), clock: clockAt() }));
      const restart = vi.fn(async () => 'sent' as const);
      expect(f.session.getRecoveryContext().noDaemon).toBe(false);
      expect(await f.session.deliverRemoteRecoveryInput(THREAD, 0, CONTINUATION_PROMPT, input)).toBe('not-sent');
      expect(await f.session.restartRemoteRecoveryPane(THREAD, 0, () => true, restart)).toBe('not-sent');
      expect(
        await f.session.restoreMissingRemoteWorker(
          THREAD,
          0,
          () => true,
          async () => 'sent'
        )
      ).toBe('not-sent');
      expect(input).not.toHaveBeenCalled();
      expect(restart).not.toHaveBeenCalled();
      expect(f.mux.respawnPane).not.toHaveBeenCalled();
    }
  );

  it('reattaches a healthy worker with attach-only and then delivers once', async () => {
    const f = fixture({ remote: ownedRemote });
    const dispatch = vi.fn(async () => ({ status: 'sent' as const, submittedAt: Date.now(), clock: clockAt() }));
    Object.assign(f.pane, { dead: true, status: 255, screen: null });
    expect(f.session.getRecoveryContext()).toMatchObject({ managed: true, remoteOwned: true, noDaemon: true });
    expect(await f.session.deliverRemoteRecoveryInput(THREAD, 0, CONTINUATION_PROMPT, dispatch)).toBe('sent');
    expect(f.mux.respawnPane).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sessionId: SESSION,
        onlyIfDead: true,
        remoteAttachOnly: true,
        remote: ownedRemote,
        codexConfig: expect.objectContaining({ resumeSessionId: THREAD, noDaemon: true }),
        envOverrides: { CODEX_HOME: '/srv/example/codex-home' },
      })
    );
    expect(dispatch).toHaveBeenCalledOnce();
    expect(f.mux.sendInput).not.toHaveBeenCalled();
  });

  it('does not respawn the local SSH wrapper when it is still live', async () => {
    const f = fixture({ remote: ownedRemote });
    const dispatch = vi.fn(async () => ({ status: 'sent' as const, submittedAt: Date.now(), clock: clockAt() }));
    Object.assign(f.pane, { dead: false, status: undefined, screen: 'ssh attached' });
    expect(await f.session.deliverRemoteRecoveryInput(THREAD, 0, CONTINUATION_PROMPT, dispatch)).toBe('sent');
    expect(f.mux.respawnPane).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(f.mux.sendInput).not.toHaveBeenCalled();
  });

  it('holds the input reservation through transport reattach and final guarded dispatch', async () => {
    const f = fixture({ remote: ownedRemote });
    const reattached = createDeferred<number>();
    f.mux.respawnPane.mockReturnValueOnce(reattached.promise);
    const dispatch = vi.fn(async () => ({ status: 'sent' as const, submittedAt: Date.now(), clock: clockAt() }));
    const delivery = f.session.deliverRemoteRecoveryInput(THREAD, 0, CONTINUATION_PROMPT, dispatch);
    await vi.waitFor(() => expect(f.mux.respawnPane).toHaveBeenCalledOnce());
    expect(f.session.recoveryInputReserved).toBe(true);
    expect(await f.session.writeViaMux('owner draft\r', { fromUser: true })).toBe(false);
    reattached.resolve(12345);
    expect(await delivery).toBe('sent');
    expect(dispatch).toHaveBeenCalledOnce();
    expect(f.session.recoveryInputReserved).toBe(false);
  });

  it.each(['named-key', 'ordinary-text'] as const)(
    'excludes all remote mutations while an owner %s send is still in flight',
    async (kind) => {
      const f = fixture({ remote: ownedRemote });
      const held = createDeferred<boolean>();
      const input =
        kind === 'named-key'
          ? f.session.sendNamedKey('\n', async () => {
              await held.promise;
            })
          : (() => {
              f.mux.sendInput.mockReturnValueOnce(held.promise);
              return f.session.writeViaMux('owner draft', { fromUser: true });
            })();
      // Current generation and valid identity make the in-flight input the veto.
      const context = f.session.getRecoveryContext();
      expect(context).toMatchObject({ managed: true, remoteOwned: true, switchPending: false, untrackedInput: false });
      expect(f.session.paneLifecycleInFlight).toBe(true);
      const deliver = vi.fn(async () => ({ status: 'sent' as const, submittedAt: Date.now(), clock: clockAt() }));
      const restart = vi.fn(async () => 'sent' as const);
      expect(await f.session.deliverRemoteRecoveryInput(THREAD, context.generation, CONTINUATION_PROMPT, deliver)).toBe(
        'not-sent'
      );
      expect(await f.session.restartRemoteRecoveryPane(THREAD, context.generation, () => true, restart)).toBe(
        'not-sent'
      );
      expect(
        await f.session.restoreMissingRemoteWorker(
          THREAD,
          context.generation,
          () => true,
          async () => 'sent'
        )
      ).toBe('not-sent');
      expect(deliver).not.toHaveBeenCalled();
      expect(restart).not.toHaveBeenCalled();
      expect(f.mux.inspectPaneForRecovery).not.toHaveBeenCalled();
      expect(f.mux.respawnPane).not.toHaveBeenCalled();
      held.resolve(true);
      expect(await input).toBe(true);
      expect(f.session.paneLifecycleInFlight).toBe(false);
      expect(await f.session.restartRemoteRecoveryPane(THREAD, context.generation, () => true, restart)).toBe('sent');
      expect(restart).toHaveBeenCalledOnce();
    }
  );

  it.each(['sent', 'unknown'] as const)(
    'keeps a direct-attach taint that lands while guarded remote input is in flight and resolves %s',
    async (outcome) => {
      const taintedSession = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
      const fencePath = dataPath('reboot-identities', `${taintedSession}.json`);
      rmSync(fencePath, { force: true });
      const f = fixture({ id: taintedSession, remote: ownedRemote });
      Object.assign(f.pane, { dead: false, status: undefined, screen: 'ssh attached' });
      const started = createDeferred<void>();
      const dispatched = createDeferred<{ status: 'sent'; submittedAt: number } | { status: 'unknown' }>();
      const initialGeneration = f.session.getRecoveryContext().generation;
      f.session.on('recoveryIdentityChanged', () => {
        const context = f.session.getRecoveryContext();
        writeRebootIdentityFence(taintedSession, {
          switchPending: context.switchPending,
          submission: context.submission,
          untrackedInput: context.untrackedInput,
        });
      });
      try {
        const delivery = f.session.deliverRemoteRecoveryInput(
          THREAD,
          initialGeneration,
          CONTINUATION_PROMPT,
          async () => {
            started.resolve();
            return dispatched.promise;
          }
        );
        await started.promise;
        f.session.fenceUntrackedInput();
        expect(f.session.getRecoveryContext()).toMatchObject({
          generation: initialGeneration + 1,
          submission: undefined,
          switchPending: true,
          untrackedInput: true,
        });
        dispatched.resolve(
          outcome === 'sent'
            ? { status: outcome, submittedAt: Date.now() - 3_000, clock: clockAt(Date.now() - 3_000) }
            : { status: outcome }
        );
        expect(await delivery).toBe(outcome);
        expect(f.session.getRecoveryContext()).toMatchObject({
          generation: initialGeneration + 1,
          submission: undefined,
          switchPending: true,
          untrackedInput: true,
        });
        expect(readRebootIdentityFence(taintedSession)).toEqual({
          switchPending: true,
          submission: undefined,
          untrackedInput: true,
        });

        const inspectRemote = vi.fn(async () => {
          throw new Error('tainted recovery must not inspect remote authority');
        });
        const deps: CodexRecoveryAdapterDeps = {
          inspectRemote,
          restartRemote: vi.fn(async () => 'not-sent'),
          deliverRemote: vi.fn(async () => ({ status: 'not-sent' })),
        };
        expect(await new CodexRecoveryAdapter(f.session, () => {}, deps).observe()).toMatchObject({
          activity: 'unknown',
          reason: 'identity-unverified',
          safeToAct: false,
        });
        expect((await new CodexTaskAdapter(f.session, () => {}, deps).observe()).observation).toMatchObject({
          activity: 'unknown',
          reason: 'identity-unverified',
          safeToAct: false,
        });
        expect(inspectRemote).not.toHaveBeenCalled();

        const reconstructed = new Session({
          id: taintedSession,
          workingDir: '/tmp',
          mode: 'codex',
          useMux: false,
          codexConfig: { noDaemon: true, resumeSessionId: THREAD },
        });
        sessions.push(reconstructed);
        expect(reconstructed.getRecoveryContext()).toMatchObject({ switchPending: true, untrackedInput: true });
      } finally {
        rmSync(fencePath, { force: true });
      }
    }
  );

  it('records the remote send instant after an acknowledgement delayed beyond identity tolerance', async () => {
    vi.useFakeTimers();
    const f = fixture({ remote: ownedRemote });
    Object.assign(f.pane, { dead: false, status: undefined, screen: 'ssh attached' });
    const remoteSendAt = Date.now() - 60_000;
    const delivery = f.session.deliverRemoteRecoveryInput(THREAD, 0, CONTINUATION_PROMPT, async () => {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      return { status: 'sent', submittedAt: remoteSendAt, clock: clockAt(remoteSendAt) };
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await delivery).toBe('sent');
    expect(f.session.getRecoveryContext().submission).toEqual({
      at: remoteSendAt,
      clockDomain: 'remote',
      clock: clockAt(remoteSendAt, remoteSendAt + 60_000 + 3_000),
      hash: createHash('sha256').update(CONTINUATION_PROMPT, 'utf8').digest('hex'),
    });
  });

  it.each(['input', 'restart', 'restore'] as const)(
    'cancels the stale automatic Enter verifier before remote %s reservation',
    async (kind) => {
      vi.useFakeTimers();
      const f = fixture({ remote: ownedRemote });
      f.session.verifySubmitted('stale prompt');
      const deferred = createDeferred<void>();
      let operation: Promise<'sent' | 'not-sent' | 'unknown'>;
      if (kind === 'input') {
        Object.assign(f.pane, { dead: false, status: undefined, screen: 'ssh attached' });
        operation = f.session.deliverRemoteRecoveryInput(THREAD, 0, CONTINUATION_PROMPT, async () => {
          await deferred.promise;
          return { status: 'sent', submittedAt: Date.now(), clock: clockAt() };
        });
      } else if (kind === 'restart') {
        operation = f.session.restartRemoteRecoveryPane(
          THREAD,
          0,
          () => true,
          async () => {
            await deferred.promise;
            return 'sent';
          }
        );
      } else {
        f.mux.respawnPane.mockImplementationOnce(async () => {
          await deferred.promise;
          return 99999;
        });
        operation = f.session.restoreMissingRemoteWorker(
          THREAD,
          0,
          () => true,
          async () => 'sent'
        );
      }
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.mux.capturePaneText).not.toHaveBeenCalled();
      expect(f.mux.sendInput).not.toHaveBeenCalled();
      deferred.resolve();
      expect(await operation).toBe('sent');
    }
  );

  it('reserves owner input for a remote restart and cancels before dispatch when authority changes', async () => {
    const f = fixture({ remote: ownedRemote });
    const dispatch = vi.fn(async () => 'sent' as const);
    const restart = f.session.restartRemoteRecoveryPane(THREAD, 0, () => true, dispatch);
    expect(f.session.recoveryInputReserved).toBe(true);
    f.session.markClosing(true);
    expect(await restart).toBe('not-sent');
    expect(dispatch).not.toHaveBeenCalled();
    expect(f.session.recoveryInputReserved).toBe(false);
  });

  it('explicitly rebuilds a missing worker only through a confirmed dead local wrapper', async () => {
    const f = fixture({ remote: ownedRemote });
    expect(
      await f.session.restoreMissingRemoteWorker(
        THREAD,
        0,
        () => true,
        async () => 'sent'
      )
    ).toBe('sent');
    expect(f.mux.respawnPane).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        onlyIfDead: true,
        remoteAttachOnly: true,
        remote: ownedRemote,
        codexConfig: expect.objectContaining({ resumeSessionId: THREAD }),
        envOverrides: { CODEX_HOME: '/srv/example/codex-home' },
      })
    );
    const live = fixture({ remote: ownedRemote });
    Object.assign(live.pane, { dead: false, status: undefined, screen: 'ssh attached' });
    expect(
      await live.session.restoreMissingRemoteWorker(
        THREAD,
        0,
        () => true,
        async () => 'sent'
      )
    ).toBe('not-sent');
    expect(live.mux.respawnPane).not.toHaveBeenCalled();

    const clean = fixture({ remote: ownedRemote });
    Object.assign(clean.pane, { dead: true, status: 0, signal: undefined, screen: null });
    expect(
      await clean.session.restoreMissingRemoteWorker(
        THREAD,
        0,
        () => true,
        async () => 'sent'
      )
    ).toBe('not-sent');
    expect(clean.mux.respawnPane).not.toHaveBeenCalled();
  });

  it.each(['unchanged', 'child', 'identity'] as const)(
    'dispatches missing-worker recreation under the final remote proof after late %s evidence',
    async (change) => {
      const f = fixture({ remote: ownedRemote });
      await f.session.prepareUserInputClock('exact fixture restore prompt\r', { fromUser: true });
      f.session.trackUserInput('exact fixture restore prompt\r');
      const now = Date.now();
      const baseTail =
        [
          {
            timestamp: new Date(now - 2000).toISOString(),
            type: 'event_msg',
            payload: { type: 'task_started', turn_id: 'restore-turn' },
          },
          {
            timestamp: new Date(now - 1000).toISOString(),
            type: 'event_msg',
            payload: { type: 'task_complete', turn_id: 'restore-turn' },
          },
        ]
          .map((row) => JSON.stringify(row))
          .join('\n') + '\n';
      let currentTail = baseTail;
      let currentThread = THREAD;
      let probes = 0;
      f.mux.inspectPaneForRecovery.mockImplementation(async () => {
        if (++probes === 3) {
          if (change === 'child')
            currentTail +=
              JSON.stringify({
                type: 'event_msg',
                payload: {
                  type: 'collab_agent_spawn_end',
                  call_id: 'late-spawn',
                  new_thread_id: '77777777-8888-4999-8aaa-bbbbbbbbbbbb',
                  status: 'running',
                },
              }) + '\n';
          else if (change === 'identity') currentThread = '22222222-2222-3333-4444-555555555555';
        }
        return { ...f.pane };
      });
      let creations = 0;
      const restoreRemote = vi.fn(async (_remote, request) => {
        if (
          request.expectedIdentity.conversationId !== currentThread ||
          request.expectedIdentity.tailHash !== createHash('sha256').update(currentTail).digest('hex')
        )
          return 'not-sent' as const;
        creations++;
        return 'sent' as const;
      });
      const deps: CodexRecoveryAdapterDeps = {
        inspectRemote: vi.fn(async () => ({
          transport: 'reachable',
          session: 'missing',
          clock: clockAt(),
          identity: {
            reason: 'verified',
            conversationId: THREAD,
            tail: baseTail,
            tailTruncated: false,
            changedAt: now - 1000,
          },
        })),
        restoreRemote,
        restartRemote: vi.fn(async () => 'not-sent'),
        deliverRemote: vi.fn(async () => ({ status: 'not-sent' })),
      };
      const adapter = new CodexRecoveryAdapter(f.session, () => {}, deps);
      expect(await adapter.restoreMissingRemote()).toBe(change === 'unchanged' ? 'sent' : 'not-sent');
      expect(deps.inspectRemote).toHaveBeenCalledTimes(2);
      expect(restoreRemote).toHaveBeenCalledOnce();
      expect(probes).toBe(3);
      expect(creations).toBe(change === 'unchanged' ? 1 : 0);
      expect(f.mux.respawnPane).toHaveBeenCalledTimes(change === 'unchanged' ? 1 : 0);
      expect(f.mux.sendInput).not.toHaveBeenCalled();
    }
  );

  it.each(['not-sent', 'unknown'] as const)('does not attach after guarded remote creation is %s', async (outcome) => {
    const f = fixture({ remote: ownedRemote });
    expect(
      await f.session.restoreMissingRemoteWorker(
        THREAD,
        0,
        () => true,
        async () => outcome
      )
    ).toBe(outcome);
    expect(f.mux.respawnPane).not.toHaveBeenCalled();
    expect(f.session.recoveryInputReserved).toBe(false);
  });

  it('refuses an unguarded missing-worker restore', async () => {
    const f = fixture({ remote: ownedRemote });
    expect(await f.session.restoreMissingRemoteWorker(THREAD, 0)).toBe('not-sent');
    expect(f.mux.inspectPaneForRecovery).not.toHaveBeenCalled();
    expect(f.mux.respawnPane).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'grant', 'home', 'attach-failure'] as const)(
    'retains uncertainty when %s happens after remote creation',
    async (change) => {
      const f = fixture({ remote: ownedRemote });
      let current = true;
      const dispatch = vi.fn(async () => {
        if (change === 'cancel') current = false;
        else if (change === 'grant') configClamp.mockImplementation(async () => ({ codexConfig: undefined }));
        else if (change === 'home') f.session.setCustomModel(undefined, { CODEX_HOME: '/srv/example/changed-home' });
        else f.mux.respawnPane.mockResolvedValueOnce(0);
        return 'sent' as const;
      });
      expect(await f.session.restoreMissingRemoteWorker(THREAD, 0, () => current, dispatch)).toBe('unknown');
      expect(dispatch).toHaveBeenCalledOnce();
      expect(f.mux.respawnPane).toHaveBeenCalledTimes(change === 'attach-failure' ? 1 : 0);
      expect(f.session.recoveryInputReserved).toBe(false);
    }
  );

  it.each(['cancel', 'home', 'grant'] as const)(
    'retains uncertainty if %s changes while the local wrapper reattaches',
    async (change) => {
      const f = fixture({ remote: ownedRemote });
      let current = true;
      f.mux.respawnPane.mockImplementationOnce(async () => {
        if (change === 'cancel') current = false;
        else if (change === 'home') f.session.setCustomModel(undefined, { CODEX_HOME: '/srv/example/changed-home' });
        else configClamp.mockImplementation(async () => ({ codexConfig: undefined }));
        return 99999;
      });
      const dispatch = vi.fn(async () => 'sent' as const);
      expect(await f.session.restoreMissingRemoteWorker(THREAD, 0, () => current, dispatch)).toBe('unknown');
      expect(dispatch).toHaveBeenCalledOnce();
      expect(f.mux.respawnPane).toHaveBeenCalledOnce();
    }
  );

  it.each(['closing', 'config', 'grant', 'home'] as const)(
    'rechecks %s authority after the missing-worker transport probe',
    async (change) => {
      const f = fixture({ remote: ownedRemote });
      const pending = createDeferred<typeof f.pane>();
      f.mux.inspectPaneForRecovery.mockImplementationOnce(() => pending.promise);
      const restore = f.session.restoreMissingRemoteWorker(
        THREAD,
        0,
        () => true,
        async () => 'sent'
      );
      await vi.waitFor(() => expect(f.mux.inspectPaneForRecovery).toHaveBeenCalledOnce());

      if (change === 'closing') f.session.markClosing(true);
      else if (change === 'config') f.session.pinRecoveryConversation('22222222-2222-3333-4444-555555555555');
      else if (change === 'home') f.session.setCustomModel(undefined, { CODEX_HOME: '/srv/example/changed-home' });
      else configClamp.mockImplementation(async () => ({ codexConfig: undefined }));

      pending.resolve(f.pane);
      expect(await restore).toBe('not-sent');
      expect(f.mux.respawnPane).not.toHaveBeenCalled();
    }
  );

  it('refuses foreign remote ownership at the last delivery boundary', async () => {
    const f = fixture({ remote: { ...ownedRemote, owned: false } });
    expect(f.session.getRecoveryContext().managed).toBe(false);
    expect(
      await f.session.deliverRemoteRecoveryInput(THREAD, 0, CONTINUATION_PROMPT, async () => ({
        status: 'sent',
        submittedAt: Date.now(),
      }))
    ).toBe('not-sent');
    expect(
      await f.session.restoreMissingRemoteWorker(
        THREAD,
        0,
        () => true,
        async () => 'sent'
      )
    ).toBe('not-sent');
    expect(f.mux.respawnPane).not.toHaveBeenCalled();
    expect(f.mux.sendInput).not.toHaveBeenCalled();
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

it('refuses an asynchronous evidence predicate instead of granting a new await window', async () => {
  const f = fixture();
  expect(
    await f.session.deliverRecovery(f.flight, 0, () => true, CONTINUATION_PROMPT, (() =>
      Promise.resolve(true)) as never)
  ).toBe('not-sent');
  expect(f.mux.respawnPane).not.toHaveBeenCalled();
});
