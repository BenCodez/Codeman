/**
 * @fileoverview Behavioral authority tests for the Codex recovery adapter.
 * Sessions, rollout resolution, pane reads and owner clamps are fakes; no live IO.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/session.js';
import type { CodexConfig } from '../src/types/session.js';
import { clampEnvOverridesForOwner, clampExternalCliConfigsForOwner } from '../src/session-env-clamp.js';
import { CodexRecoveryAdapter } from '../src/recovery/codex-adapter.js';
import { resolveCodexIdentity, type CodexIdentityResult } from '../src/recovery/codex-identity.js';
import type { RecoveryFlight, RecoveryObservation } from '../src/recovery/types.js';
import { createDeferred } from './mocks/index.js';

vi.mock('../src/recovery/codex-identity.js', () => ({ resolveCodexIdentity: vi.fn() }));
vi.mock('../src/session-env-clamp.js', () => ({
  clampExternalCliConfigsForOwner: vi.fn(),
  clampEnvOverridesForOwner: vi.fn(),
}));

const NOW = Date.UTC(2026, 9, 13, 12);
const SESSION = '019a5aa0-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const THREAD = '019a5aa0-1111-7111-8111-111111111111';
const OTHER = '019a5aa0-2222-7222-8222-222222222222';
const READY = '  Sanitized fixture result\n› \n  fixture-model default · /fixture/workspace\n';
const resolver = vi.mocked(resolveCodexIdentity);
const configClamp = vi.mocked(clampExternalCliConfigsForOwner);
const envClamp = vi.mocked(clampEnvOverridesForOwner);
type Pane = NonNullable<Awaited<ReturnType<Session['inspectRecoveryPane']>>>;
type DeliveryResult = Awaited<ReturnType<Session['deliverRecovery']>>;

function event(payload: Record<string, unknown>, at: number): string {
  return JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload });
}

function failedTail(): string {
  return (
    [
      event({ type: 'task_started', turn_id: 'fixture-turn', model_context_window: null }, NOW - 10_000),
      event(
        {
          type: 'task_complete',
          turn_id: 'fixture-turn',
          last_agent_message: null,
          error: { message: 'Conversation interrupted.', codex_error_info: null },
        },
        NOW - 9_000
      ),
    ].join('\n') + '\n'
  );
}

function completedTail(): string {
  return (
    [
      event({ type: 'task_started', turn_id: 'fixture-turn', model_context_window: null }, NOW - 10_000),
      event({ type: 'task_complete', turn_id: 'fixture-turn', last_agent_message: null }, NOW - 9_000),
    ].join('\n') + '\n'
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resolver.mockReset();
  configClamp.mockReset().mockImplementation(async (_owner, configs) => configs);
  envClamp.mockReset().mockImplementation(async (_owner, env) => env);
});

afterEach(() => vi.useRealTimers());

function fixture() {
  const state = {
    context: {
      generation: 3,
      managed: true,
      noDaemon: true,
      intentionalStopAt: 0,
      switchPending: false,
      codexHome: '/fixture/codex-home' as string | undefined,
      submission: undefined as { at: number; hash: string } | undefined,
    },
    pane: { dead: false, screen: READY } as Pane | null,
    identity: {
      reason: 'verified',
      conversationId: THREAD,
      tail: failedTail(),
      path: '/fixture/private-rollout.jsonl',
    } as CodexIdentityResult,
    env: undefined as Record<string, string> | undefined,
    busy: false,
    delivery: 'sent' as DeliveryResult,
  };
  const session = {
    id: SESSION,
    workingDir: '/fixture/workspace',
    owner: 'fixture-owner',
    remote: undefined as Session['remote'],
    docker: undefined as Session['docker'],
    codexConfig: { noDaemon: true, resumeSessionId: THREAD } as CodexConfig,
    paneLifecycleInFlight: false,
    paneExit: { at: NOW - 10_000, status: 1 } as Session['paneExit'],
    watching: null as string | null,
    getRecoveryContext: vi.fn(() => ({ ...state.context })),
    getEnvOverridesForPersist: vi.fn(() => state.env),
    inspectRecoveryPane: vi.fn(async () => state.pane),
    isBusy: vi.fn(() => state.busy),
    pinRecoveryConversation: vi.fn((id: string) => {
      session.codexConfig = { ...session.codexConfig, resumeSessionId: id };
    }),
    deliverRecovery: vi.fn(async (_flight: RecoveryFlight, _generation: number) => state.delivery),
  };
  const persist = vi.fn();
  const adapter = new CodexRecoveryAdapter(session as unknown as Session, persist);
  resolver.mockImplementation(async () => structuredClone(state.identity));
  return Object.assign(state, { session, adapter, persist });
}

function flight(observation: RecoveryObservation, action: RecoveryFlight['action'] = 'continue'): RecoveryFlight {
  expect(observation.safeToAct).toBe(true);
  expect(observation.evidenceKey).toBeDefined();
  return {
    key: observation.evidenceKey!,
    action,
    conversationId: observation.conversationId!,
    startedAt: NOW,
    previousSubmissionKey: observation.submissionKey,
  };
}

describe('exact current identity and delivery proof', () => {
  it('passes the session-specific home, exact resume seed and exact prompt hash to the resolver', async () => {
    const f = fixture();
    f.context.submission = {
      at: NOW - 20_000,
      hash: createHash('sha256').update('Sanitized fixture request.').digest('hex'),
    };
    const observation = await f.adapter.observe();
    expect(resolver).toHaveBeenCalledWith({
      sessionId: SESSION,
      workingDir: '/fixture/workspace',
      codexHome: '/fixture/codex-home',
      resumeId: THREAD,
      noDaemon: true,
      submission: f.context.submission,
    });
    expect(observation).toMatchObject({ conversationId: THREAD, activity: 'interrupted', safeToAct: true });
    expect(observation.conversationId).not.toBe(SESSION);
    expect(JSON.stringify(observation)).not.toContain('/fixture/private-rollout');
    expect(JSON.stringify(observation)).not.toContain('Conversation interrupted.');
  });

  it('pins a freshly verified UUID and persists it before delivery', async () => {
    const f = fixture();
    f.session.codexConfig = { noDaemon: true };
    const observation = await f.adapter.observe();
    expect(f.session.pinRecoveryConversation).toHaveBeenCalledWith(THREAD);
    expect(f.session.codexConfig.resumeSessionId).toBe(THREAD);
    expect(f.persist).toHaveBeenCalledTimes(1);
    expect(await f.adapter.act(flight(observation))).toBe('sent');
    expect(f.session.deliverRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: THREAD }),
      3,
      expect.any(Function)
    );
    expect(f.persist).toHaveBeenCalledTimes(2);
  });

  it('repeats identity, pane and current-owner grant proof immediately before delivery', async () => {
    const f = fixture();
    const initialIdentity = createDeferred<CodexIdentityResult>();
    const initialPane = createDeferred<Pane | null>();
    resolver.mockReturnValueOnce(initialIdentity.promise);
    f.session.inspectRecoveryPane.mockReturnValueOnce(initialPane.promise);
    const observing = f.adapter.observe();
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledTimes(1));
    const initialConfigChecks = configClamp.mock.calls.length;
    const initialEnvChecks = envClamp.mock.calls.length;
    initialIdentity.resolve(f.identity);
    initialPane.resolve(f.pane);
    const reservation = flight(await observing);
    expect(configClamp.mock.calls.length).toBeGreaterThan(initialConfigChecks);
    expect(envClamp.mock.calls.length).toBeGreaterThan(initialEnvChecks);

    const finalIdentity = createDeferred<CodexIdentityResult>();
    const finalPane = createDeferred<Pane | null>();
    resolver.mockReturnValueOnce(finalIdentity.promise);
    f.session.inspectRecoveryPane.mockReturnValueOnce(finalPane.promise);
    const acting = f.adapter.act(reservation);
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledTimes(2));
    const finalConfigChecks = configClamp.mock.calls.length;
    const finalEnvChecks = envClamp.mock.calls.length;
    expect(f.session.deliverRecovery).not.toHaveBeenCalled();
    finalIdentity.resolve(f.identity);
    finalPane.resolve(f.pane);
    expect(await acting).toBe('sent');
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(f.session.inspectRecoveryPane).toHaveBeenCalledTimes(2);
    expect(configClamp.mock.calls.length).toBeGreaterThan(finalConfigChecks);
    expect(envClamp.mock.calls.length).toBeGreaterThan(finalEnvChecks);
    const deliveryOrder = f.session.deliverRecovery.mock.invocationCallOrder[0];
    expect(configClamp.mock.invocationCallOrder.at(-1)).toBeLessThan(deliveryOrder);
    expect(envClamp.mock.invocationCallOrder.at(-1)).toBeLessThan(deliveryOrder);
    expect(configClamp).toHaveBeenCalledWith('fixture-owner', { codexConfig: f.session.codexConfig });
  });

  it('does not deliver without a prior proof or for a different failure key/thread', async () => {
    const f = fixture();
    const fabricated: RecoveryFlight = { key: 'unproved', action: 'continue', conversationId: THREAD, startedAt: NOW };
    expect(await f.adapter.act(fabricated)).toBe('not-sent');
    const reservation = flight(await f.adapter.observe());
    expect(await f.adapter.act({ ...reservation, conversationId: OTHER })).toBe('not-sent');
    expect(await f.adapter.act({ ...reservation, key: 'different' })).toBe('not-sent');
    expect(f.session.deliverRecovery).not.toHaveBeenCalled();
  });

  it('propagates disable/shutdown cancellation through the final async observation', async () => {
    const f = fixture();
    const reservation = flight(await f.adapter.observe());
    const identity = createDeferred<CodexIdentityResult>();
    resolver.mockReturnValueOnce(identity.promise);
    let current = true;
    const acting = f.adapter.act(reservation, () => current);
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledTimes(2));
    current = false;
    identity.resolve(f.identity);
    expect(await acting).toBe('not-sent');
    expect(f.session.deliverRecovery).not.toHaveBeenCalled();
  });

  it('vetoes a reservation if the exact current conversation changes', async () => {
    const f = fixture();
    const reservation = flight(await f.adapter.observe());
    f.identity.conversationId = OTHER;
    expect(await f.adapter.act(reservation)).toBe('not-sent');
    expect(f.session.deliverRecovery).not.toHaveBeenCalled();
  });

  it('vetoes a reservation when its failed turn has since completed', async () => {
    const f = fixture();
    const reservation = flight(await f.adapter.observe());
    f.identity.tail = completedTail();
    expect(await f.adapter.act(reservation)).toBe('not-sent');
    expect(f.session.deliverRecovery).not.toHaveBeenCalled();
  });

  it('preserves not-sent and unknown delivery outcomes without claiming or persisting success', async () => {
    for (const outcome of ['not-sent', 'unknown'] as const) {
      const f = fixture();
      f.delivery = outcome;
      const reservation = flight(await f.adapter.observe());
      expect(await f.adapter.act(reservation)).toBe(outcome);
      expect(f.persist).not.toHaveBeenCalled();
    }
  });
});

describe('ownership, location and isolated-launch gates', () => {
  it.each([true, false])('never mutates an owned:%s remote transport', async (owned) => {
    const f = fixture();
    f.session.remote = { owned } as Session['remote'];
    expect(await f.adapter.observe()).toMatchObject({ reason: 'unsupported-location', safeToAct: false });
    expect(resolver).not.toHaveBeenCalled();
    expect(f.session.inspectRecoveryPane).not.toHaveBeenCalled();
    expect(f.session.deliverRecovery).not.toHaveBeenCalled();
  });

  it('leaves Docker and foreign/discovered/direct-PTY contexts monitor-only', async () => {
    const docker = fixture();
    docker.session.docker = { containerId: 'fixture-container' } as Session['docker'];
    expect(await docker.adapter.observe()).toMatchObject({ reason: 'unsupported-location', safeToAct: false });
    const foreign = fixture();
    foreign.context.managed = false;
    expect(await foreign.adapter.observe()).toMatchObject({ reason: 'unowned-session', safeToAct: false });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('requires actual isolated launch evidence even if the requested config says noDaemon', async () => {
    const f = fixture();
    f.context.noDaemon = false;
    expect(f.session.codexConfig.noDaemon).toBe(true);
    expect(await f.adapter.observe()).toMatchObject({ reason: 'managed-daemon', safeToAct: false });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('refuses identity switches and overlapping pane lifecycle work', async () => {
    const switching = fixture();
    switching.context.switchPending = true;
    expect(await switching.adapter.observe()).toMatchObject({ reason: 'identity-unverified', safeToAct: false });
    const starting = fixture();
    starting.session.paneLifecycleInFlight = true;
    expect(await starting.adapter.observe()).toMatchObject({ reason: 'identity-unverified', safeToAct: false });
    expect(resolver).not.toHaveBeenCalled();
  });

  it.each(['managed-daemon', 'ambiguous', 'unverified', 'unreadable'] as const)(
    'never acts on resolver reason %s',
    async (reason) => {
      const f = fixture();
      f.identity.reason = reason;
      expect(await f.adapter.observe()).toMatchObject({ reason: 'identity-unverified', safeToAct: false });
      expect(f.session.pinRecoveryConversation).not.toHaveBeenCalled();
    }
  );

  it('requires a complete rollout tail and a current readable pane', async () => {
    const noTail = fixture();
    delete noTail.identity.tail;
    expect(await noTail.adapter.observe()).toMatchObject({ reason: 'identity-unverified', safeToAct: false });
    const noPane = fixture();
    noPane.pane = null;
    expect(await noPane.adapter.observe()).toMatchObject({ reason: 'pane-unverified', safeToAct: false });
  });

  it('rechecks loss of ownership/isolation before spending an existing reservation', async () => {
    const f = fixture();
    const reservation = flight(await f.adapter.observe());
    f.context.managed = false;
    expect(await f.adapter.act(reservation)).toBe('not-sent');
    expect(f.session.deliverRecovery).not.toHaveBeenCalled();
  });
});

describe('human input invalidates the current epoch', () => {
  it('vetoes input between observation and delivery even if the failure is unchanged', async () => {
    const f = fixture();
    const reservation = flight(await f.adapter.observe());
    f.context.generation++;
    expect(await f.adapter.act(reservation)).toBe('not-sent');
    expect(f.session.deliverRecovery).not.toHaveBeenCalled();
  });

  it('vetoes input while initial identity/pane inspection is in flight', async () => {
    const f = fixture();
    const identity = createDeferred<CodexIdentityResult>();
    resolver.mockReturnValueOnce(identity.promise);
    const observing = f.adapter.observe();
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledTimes(1));
    f.context.generation++;
    identity.resolve(f.identity);
    expect(await observing).toMatchObject({ reason: 'user-input', safeToAct: false });
    expect(f.session.pinRecoveryConversation).not.toHaveBeenCalled();
  });

  it('vetoes input while the repeated pre-delivery inspection is in flight', async () => {
    const f = fixture();
    const reservation = flight(await f.adapter.observe());
    const identity = createDeferred<CodexIdentityResult>();
    resolver.mockReturnValueOnce(identity.promise);
    const acting = f.adapter.act(reservation);
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledTimes(2));
    f.context.generation++;
    identity.resolve(f.identity);
    expect(await acting).toBe('not-sent');
    expect(f.session.deliverRecovery).not.toHaveBeenCalled();
  });

  it('does not revive a process after the user deliberately interrupted it', async () => {
    const f = fixture();
    f.pane = { dead: true, status: 130, signal: undefined, screen: null };
    f.session.paneExit = { at: NOW - 1_000, status: 130 };
    f.context.intentionalStopAt = NOW - 1_500;
    expect(await f.adapter.observe()).toMatchObject({ activity: 'crashed', safeToAct: false });
    expect(f.session.deliverRecovery).not.toHaveBeenCalled();
  });
});

describe('authoritative agent exits and process readiness', () => {
  it('authorizes restart only for a confirmed matching abnormal local exit', async () => {
    const f = fixture();
    f.pane = { dead: true, status: 1, screen: null };
    const observation = await f.adapter.observe();
    expect(observation).toMatchObject({
      activity: 'crashed',
      reason: 'process-crashed',
      conversationId: THREAD,
      safeToAct: true,
    });
    expect(await f.adapter.act(flight(observation, 'restart'))).toBe('sent');
    expect(f.session.deliverRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'restart', conversationId: THREAD }),
      3,
      expect.any(Function)
    );
  });

  it('an explicit status 0 is a clean intentional exit and cannot revive', async () => {
    const f = fixture();
    f.pane = { dead: true, status: 0, screen: null };
    f.session.paneExit = { at: NOW - 10_000, status: 0 };
    expect(await f.adapter.observe()).toMatchObject({ activity: 'exited', reason: 'clean-exit', safeToAct: false });
    expect(f.session.deliverRecovery).not.toHaveBeenCalled();
  });

  it('requires a positive signal or numeric abnormal status and agreement with stored exit evidence', async () => {
    const f = fixture();
    f.pane = { dead: true, signal: 9, screen: null };
    f.session.paneExit = { at: NOW - 10_000, signal: 9 };
    expect(await f.adapter.observe()).toMatchObject({ activity: 'crashed', safeToAct: true });
    f.pane = { dead: true, screen: null };
    f.session.paneExit = { at: NOW - 10_000 };
    expect(await f.adapter.observe()).toMatchObject({ reason: 'pane-unverified', safeToAct: false });
    f.pane = { dead: true, status: 1, screen: null };
    f.session.paneExit = { at: NOW - 10_000, status: 2 };
    expect(await f.adapter.observe()).toMatchObject({ reason: 'pane-unverified', safeToAct: false });
    f.session.paneExit = undefined;
    expect(await f.adapter.observe()).toMatchObject({ reason: 'pane-unverified', safeToAct: false });
  });

  it('a formerly crashed but now live process reports readiness for the exact resumed thread', async () => {
    const f = fixture();
    f.identity.tail = completedTail();
    f.session.paneExit = undefined;
    const observation = await f.adapter.observe();
    expect(observation).toMatchObject({
      conversationId: THREAD,
      activity: 'completed',
      processReady: true,
      safeToAct: false,
    });
    f.pane = { dead: false, screen: '› Unsent fixture draft\n' };
    expect(await f.adapter.observe()).toMatchObject({ processReady: false, safeToAct: false });
    f.pane = { dead: false, screen: `Sanitized sign in requirement\n${READY}` };
    expect(await f.adapter.observe()).toMatchObject({ activity: 'blocked', processReady: false, safeToAct: false });
  });
});

describe('current owner grants', () => {
  it('blocks current config or environment privilege revocation before observation', async () => {
    const f = fixture();
    f.session.codexConfig.dangerouslyBypassApprovals = true;
    configClamp.mockImplementation(async (_owner, configs) => ({
      ...configs,
      codexConfig: { ...(configs.codexConfig as CodexConfig), dangerouslyBypassApprovals: false },
    }));
    expect(await f.adapter.observe()).toMatchObject({
      activity: 'blocked',
      reason: 'approval-required',
      safeToAct: false,
    });
    expect(resolver).not.toHaveBeenCalled();
    configClamp.mockImplementation(async (_owner, configs) => configs);
    f.env = { CLAUDE_CONFIG_DIR: '/fixture/config' };
    envClamp.mockResolvedValue({});
    expect(await f.adapter.observe()).toMatchObject({
      activity: 'blocked',
      reason: 'approval-required',
      safeToAct: false,
    });
  });

  it('blocks a grant revoked between observation and action', async () => {
    const f = fixture();
    f.session.codexConfig.dangerouslyBypassApprovals = true;
    const reservation = flight(await f.adapter.observe());
    configClamp.mockImplementation(async (_owner, configs) => ({
      ...configs,
      codexConfig: { ...(configs.codexConfig as CodexConfig), dangerouslyBypassApprovals: false },
    }));
    expect(await f.adapter.act(reservation)).toBe('not-sent');
    expect(f.session.deliverRecovery).not.toHaveBeenCalled();
  });

  it('rechecks a grant revoked while the initial identity proof is in flight', async () => {
    const f = fixture();
    f.session.codexConfig = { noDaemon: true, dangerouslyBypassApprovals: true };
    let granted = true;
    configClamp.mockImplementation(async (_owner, configs) =>
      granted
        ? configs
        : {
            ...configs,
            codexConfig: { ...(configs.codexConfig as CodexConfig), dangerouslyBypassApprovals: false },
          }
    );
    const identity = createDeferred<CodexIdentityResult>();
    resolver.mockReturnValueOnce(identity.promise);
    const observing = f.adapter.observe();
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledTimes(1));
    granted = false;
    identity.resolve(f.identity);
    expect(await observing).toMatchObject({ activity: 'blocked', reason: 'approval-required', safeToAct: false });
    expect(f.session.pinRecoveryConversation).not.toHaveBeenCalled();
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.session.deliverRecovery).not.toHaveBeenCalled();
  });

  it('rechecks a grant revoked while the final identity proof is in flight', async () => {
    const f = fixture();
    f.session.codexConfig.dangerouslyBypassApprovals = true;
    let granted = true;
    configClamp.mockImplementation(async (_owner, configs) =>
      granted
        ? configs
        : {
            ...configs,
            codexConfig: { ...(configs.codexConfig as CodexConfig), dangerouslyBypassApprovals: false },
          }
    );
    const reservation = flight(await f.adapter.observe());
    const identity = createDeferred<CodexIdentityResult>();
    resolver.mockReturnValueOnce(identity.promise);
    const acting = f.adapter.act(reservation);
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledTimes(2));
    granted = false;
    identity.resolve(f.identity);
    expect(await acting).toBe('not-sent');
    expect(f.session.deliverRecovery).not.toHaveBeenCalled();
  });

  it('checks an active CODEX_HOME relocation even when no persisted environment snapshot is available', async () => {
    const f = fixture();
    // Legacy records can lack the home snapshot while the active session still uses it.
    f.env = undefined;
    f.context.codexHome = '/fixture/isolated-config';
    envClamp.mockImplementation(async (_owner, env) => {
      if (!env) return env;
      const safe = { ...env };
      delete safe.CODEX_HOME;
      return safe;
    });
    expect(await f.adapter.observe()).toMatchObject({
      activity: 'blocked',
      reason: 'approval-required',
      safeToAct: false,
    });
    expect(f.session.deliverRecovery).not.toHaveBeenCalled();
  });
});
