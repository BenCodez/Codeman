/**
 * @fileoverview Behavioral authority tests for the Codex recovery adapter.
 * Sessions, pane reads and owner clamps are fakes; rollout reads use isolated fixture files or fakes.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/session.js';
import type { CodexConfig } from '../src/types/session.js';
import { clampEnvOverridesForOwner, clampExternalCliConfigsForOwner } from '../src/session-env-clamp.js';
import { CodexRecoveryAdapter, type CodexRecoveryAdapterDeps } from '../src/recovery/codex-adapter.js';
import type { RemoteCodexEvidence, RemoteCodexInputResult } from '../src/recovery/remote-codex.js';
import { resolveCodexIdentity, type CodexIdentityResult } from '../src/recovery/codex-identity.js';
import { CONTINUATION_PROMPT, type RecoveryFlight, type RecoveryObservation } from '../src/recovery/types.js';
import { RecoveryController } from '../src/recovery/controller.js';
import { RecoveryStore } from '../src/recovery/store.js';
import { createDeferred } from './mocks/index.js';
import type { RecoverySubmission } from '../src/recovery/remote-clock.js';
import { CodexTaskAdapter } from '../src/supervision/adapter.js';
import { commandHash } from '../src/supervision/evidence.js';
const clockAt = (at = Date.now()) => ({ localBefore: at, localAfter: at, remoteBefore: at, remoteAfter: at });

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
const CHILD_SPAWN = {
  type: 'collab_agent_spawn_end',
  call_id: 'fixture-spawn',
  sender_thread_id: THREAD,
  new_thread_id: OTHER,
  prompt: 'Sanitized child fixture request.',
  model: 'fixture-model',
  reasoning_effort: 'low',
  status: 'running',
};
const resolver = vi.mocked(resolveCodexIdentity);
const configClamp = vi.mocked(clampExternalCliConfigsForOwner);
const envClamp = vi.mocked(clampEnvOverridesForOwner);
type Pane = NonNullable<Awaited<ReturnType<Session['inspectRecoveryPane']>>>;
type DeliveryResult = Awaited<ReturnType<Session['deliverRecovery']>>;

function event(payload: Record<string, unknown>, at: number): string {
  return JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload });
}

function failedTail(...during: string[]): string {
  return (
    [
      event({ type: 'task_started', turn_id: 'fixture-turn', model_context_window: null }, NOW - 10_000),
      ...during,
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
      submission: {
        at: NOW - 10_000,
        hash: createHash('sha256').update('Sanitized fixture request.').digest('hex'),
      } as RecoverySubmission | undefined,
    },
    pane: { paneId: '%7', panePid: 700, dead: false, screen: READY } as Pane | null,
    transportPane: { dead: true, status: 255, screen: null } as Pane | null,
    identity: {
      reason: 'verified',
      conversationId: THREAD,
      tail: failedTail(),
      tailTruncated: false,
      path: '/fixture/private-rollout.jsonl',
    } as CodexIdentityResult,
    env: undefined as Record<string, string> | undefined,
    busy: false,
    delivery: 'sent' as DeliveryResult,
    remoteEvidence: {
      transport: 'reachable',
      session: 'present',
      clock: clockAt(),
      pane: { dead: false, paneId: '%7', panePid: 700, screen: READY },
      identity: {
        reason: 'verified',
        conversationId: THREAD,
        tail: failedTail(),
        tailTruncated: false,
        changedAt: NOW - 9_000,
      },
    } as RemoteCodexEvidence,
    remoteRestart: 'sent' as const as 'sent' | 'not-sent' | 'unknown',
    remoteDelivery: { status: 'sent', submittedAt: NOW } as RemoteCodexInputResult,
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
    remoteRecoveryConfiguration: vi.fn(() => JSON.stringify([session.remote, session.codexConfig, state.env])),
    confirmRemoteRecoveryAuthority: vi.fn(async () => true),
    isRemoteRecoveryAuthorityCurrent: vi.fn(() => true),
    inspectRecoveryPane: vi.fn(async () => state.pane),
    inspectRemoteTransportPane: vi.fn(async () => state.transportPane),
    isBusy: vi.fn(() => state.busy),
    pinRecoveryConversation: vi.fn((id: string) => {
      session.codexConfig = { ...session.codexConfig, resumeSessionId: id };
    }),
    deliverRecovery: vi.fn(async (_flight: RecoveryFlight, _generation: number) => state.delivery),
    deliverRemoteRecoveryInput: vi.fn(
      async (
        _conversationId: string,
        _generation: number,
        _prompt: string,
        dispatch: () => Promise<RemoteCodexInputResult>
      ) => (await dispatch()).status
    ),
    restartRemoteRecoveryPane: vi.fn(
      async (
        _conversationId: string,
        _generation: number,
        _isCurrent: () => boolean,
        dispatch: () => Promise<DeliveryResult>
      ) => dispatch()
    ),
    restoreMissingRemoteWorker: vi.fn(
      async (
        _conversationId: string,
        _generation: number,
        isCurrent: () => boolean,
        dispatch: () => Promise<DeliveryResult>
      ) => (isCurrent() ? dispatch() : 'not-sent')
    ),
  };
  const persist = vi.fn();
  const deps: CodexRecoveryAdapterDeps = {
    inspectRemote: vi.fn(async () => structuredClone(state.remoteEvidence)),
    restartRemote: vi.fn(async () => state.remoteRestart),
    deliverRemote: vi.fn(async () => state.remoteDelivery),
    restoreRemote: vi.fn(async () => state.remoteRestart),
  };
  const adapter = new CodexRecoveryAdapter(session as unknown as Session, persist, deps);
  resolver.mockImplementation(async () => structuredClone(state.identity));
  return Object.assign(state, { session, adapter, persist, deps });
}

describe('fresh process readiness provenance', () => {
  it.each([
    'ready',
    'missing-id',
    'missing-pid',
    'dead',
    'blank-screen',
    'truncated',
    'bounded-delay',
    'expired-delay',
    'backward',
  ] as const)('keeps current live readiness separate from historical rollout time: %s', async (change) => {
    const f = fixture();
    f.identity.tail = completedTail();
    f.pane = { dead: false, screen: READY, paneId: '%7', panePid: 1234 };
    if (change === 'missing-id') delete f.pane.paneId;
    if (change === 'missing-pid') delete f.pane.panePid;
    if (change === 'dead') f.pane = { dead: true, screen: null, status: 1, paneId: '%7', panePid: 1234 };
    if (change === 'blank-screen') f.pane.screen = '';
    if (change === 'truncated') f.identity.tailTruncated = true;
    if (['bounded-delay', 'expired-delay', 'backward'].includes(change)) {
      resolver.mockImplementation(async () => {
        vi.setSystemTime(NOW + (change === 'bounded-delay' ? 30000 : change === 'expired-delay' ? 30001 : -1));
        return structuredClone(f.identity);
      });
    }
    const observation = await f.adapter.observe();
    if (change === 'ready' || change === 'bounded-delay') {
      expect(observation).toMatchObject({
        activity: 'completed',
        processReady: true,
        processReadyAt: NOW,
        at: NOW - 9000,
      });
    } else expect(observation.processReadyAt).toBeUndefined();
  });
});

describe('bounded live-pane provenance', () => {
  it.each([
    'observed',
    'first-dead',
    'missing-id',
    'changed-id',
    'changed-pid',
    'generation',
    'configuration',
    'expired',
    'backward',
    'unknown-between',
  ] as const)('binds crash live proof to a recent matching native observation (%s)', async (change) => {
    const f = fixture();
    f.pane = { dead: false, screen: READY, paneId: '%7', panePid: 1234 };
    f.identity.tail = completedTail();
    if (change === 'missing-id') delete f.pane.paneId;
    if (change !== 'first-dead') await f.adapter.observe();
    if (change === 'unknown-between') {
      f.pane = null;
      await f.adapter.observe();
    }
    const now = change === 'expired' ? NOW + 31_000 : change === 'backward' ? NOW - 1 : NOW + 1000;
    vi.setSystemTime(now);
    f.pane = {
      dead: true,
      status: 1,
      screen: null,
      paneId: change === 'changed-id' ? '%8' : '%7',
      panePid: change === 'changed-pid' ? 1235 : 1234,
    };
    f.session.paneExit = { at: now, status: 1 };
    f.identity.tail = failedTail();
    if (change === 'generation') f.context.generation++;
    if (change === 'configuration')
      f.session.codexConfig = { ...f.session.codexConfig, model: 'different-fixture-model' };
    const observation = await f.adapter.observe();
    expect(observation.activity).toBe('crashed');
    if (change === 'observed') {
      expect(observation.liveProofAt).toBe(NOW);
      expect(f.adapter.hasLivePaneProof(NOW)).toBe(true);
      await f.adapter.observe();
      expect(f.adapter.hasLivePaneProof(NOW)).toBe(true);
      vi.setSystemTime(NOW + 31_001);
      expect(f.adapter.hasLivePaneProof(NOW)).toBe(false);
    } else {
      expect(observation.liveProofAt).toBeUndefined();
      expect(f.adapter.hasLivePaneProof(NOW)).toBe(false);
    }
  });
});

async function withRollout(
  body: string,
  check: (f: ReturnType<typeof fixture>, writeBody: (nextBody: string) => Promise<void>) => Promise<void>
): Promise<void> {
  const f = fixture();
  const home = await fs.mkdtemp(join(homedir(), 'codex-adapter-rollout-'));
  try {
    f.context.codexHome = home;
    f.session.workingDir = join(home, 'workspace');
    const directory = join(home, 'sessions');
    await fs.mkdir(directory);
    const path = join(directory, `rollout-2026-10-13T12-00-00-${THREAD}.jsonl`);
    const header = JSON.stringify({
      timestamp: new Date(NOW - 60_000).toISOString(),
      type: 'session_meta',
      payload: { id: THREAD, cwd: f.session.workingDir, originator: `codeman_${SESSION}` },
    });
    const writeBody = async (nextBody: string): Promise<void> => {
      await fs.writeFile(path, `${header}\n${nextBody}`);
    };
    await fs.writeFile(
      join(home, 'history.jsonl'),
      JSON.stringify({
        session_id: THREAD,
        ts: f.context.submission!.at / 1000,
        text: 'Sanitized fixture request.',
      }) + '\n'
    );
    await writeBody(body);
    const actual = await vi.importActual<typeof import('../src/recovery/codex-identity.js')>(
      '../src/recovery/codex-identity.js'
    );
    resolver.mockImplementation(actual.resolveCodexIdentity);
    await check(f, writeBody);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

function hiddenLiveChildTail(): string {
  return (
    event(CHILD_SPAWN, NOW - 20_000) +
    '\n' +
    JSON.stringify({ type: 'response_item', payload: { message: 'x'.repeat(300 * 1024) } }) +
    '\n' +
    failedTail()
  );
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
  it.each([false, true])(
    'refuses seed-only automatic authority and clears previous evidence (%s)',
    async (previous) => {
      const f = fixture();
      let reserved: RecoveryFlight = {
        key: `${THREAD}:seed`,
        action: 'continue',
        conversationId: THREAD,
        startedAt: NOW,
      };
      if (previous) {
        reserved = flight(await f.adapter.observe());
        expect(f.adapter.getVerifiedTail(THREAD)).toBe(f.identity.tail);
      }
      f.context.submission = undefined;
      expect(await f.adapter.observe()).toMatchObject({
        activity: 'unknown',
        reason: 'identity-unverified',
        safeToAct: false,
      });
      expect(f.adapter.getVerifiedTail(THREAD)).toBeUndefined();
      expect(await f.adapter.act(reserved)).toBe('not-sent');
      expect(f.session.deliverRecovery).not.toHaveBeenCalled();
      expect(f.session.pinRecoveryConversation).not.toHaveBeenCalled();
    }
  );

  it('passes the session-specific home, exact resume seed and exact prompt hash to the resolver', async () => {
    const f = fixture();
    f.context.submission = {
      at: NOW - 20_000,
      clockDomain: 'local',
      clock: clockAt(NOW - 20_000),
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
      expect.any(Function),
      CONTINUATION_PROMPT,
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
  it('never mutates a foreign remote transport', async () => {
    const f = fixture();
    f.session.remote = { owned: false } as Session['remote'];
    expect(await f.adapter.observe()).toMatchObject({ reason: 'unowned-session', safeToAct: false });
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

  it.each([true, undefined])('does not act or certify readiness with tailTruncated:%s', async (tailTruncated) => {
    const f = fixture();
    f.identity.tailTruncated = tailTruncated;
    expect(await f.adapter.observe()).toMatchObject({
      activity: 'interrupted',
      safeToAct: false,
      processReady: false,
    });
    f.pane = { paneId: '%7', panePid: 700, dead: true, status: 1, screen: null };
    expect(await f.adapter.observe()).toMatchObject({ activity: 'crashed', safeToAct: false });
    expect(f.session.deliverRecovery).not.toHaveBeenCalled();
  });

  it('rechecks loss of ownership/isolation before spending an existing reservation', async () => {
    const f = fixture();
    const reservation = flight(await f.adapter.observe());
    f.context.managed = false;
    expect(await f.adapter.act(reservation)).toBe('not-sent');
    expect(f.session.deliverRecovery).not.toHaveBeenCalled();
  });
});

describe('bounded real rollout lifecycle evidence', () => {
  const invalidLifecycleRows = [
    { name: 'malformed JSON', row: '{broken-json}' },
    {
      name: 'unsupported lifecycle schema',
      row: event({ type: 'task_complete', turn_id: { unsupported: 'fixture-turn' } }, NOW - 9_250),
    },
    {
      name: 'unreadable control payload',
      row: JSON.stringify({ timestamp: new Date(NOW - 9_250).toISOString(), type: 'event_msg', payload: null }),
    },
  ];

  it.each(invalidLifecycleRows)('vetoes dead-pane restart with complete $name after a live child', async ({ row }) => {
    await withRollout(failedTail(event(CHILD_SPAWN, NOW - 9_500), row), async (f) => {
      const identity = await resolveCodexIdentity({
        sessionId: SESSION,
        workingDir: f.session.workingDir,
        codexHome: f.context.codexHome,
        noDaemon: true,
      });
      expect(identity).toMatchObject({ reason: 'verified', conversationId: THREAD, tailTruncated: false });
      f.pane = { paneId: '%7', panePid: 700, dead: true, status: 1, screen: null };
      expect(await f.adapter.observe()).toMatchObject({ activity: 'unknown', safeToAct: false });
      const unproved: RecoveryFlight = {
        key: `${THREAD}:pane:${f.session.paneExit!.at}:1`,
        action: 'restart',
        conversationId: THREAD,
        startedAt: NOW,
      };
      expect(await f.adapter.act(unproved)).toBe('not-sent');
      expect(f.session.deliverRecovery).not.toHaveBeenCalled();
    });
  });

  it.each(invalidLifecycleRows)('vetoes a restart reservation when final evidence has $name', async ({ row }) => {
    await withRollout(failedTail(), async (f, writeBody) => {
      f.pane = { paneId: '%7', panePid: 700, dead: true, status: 1, screen: null };
      const reservation = flight(await f.adapter.observe(), 'restart');
      await writeBody(failedTail(event(CHILD_SPAWN, NOW - 9_500), row));
      expect(await f.adapter.act(reservation)).toBe('not-sent');
      expect(f.session.deliverRecovery).not.toHaveBeenCalled();
    });
  });

  it('vetoes abnormal dead-pane restart while a complete rollout still has a pending child', async () => {
    const body = failedTail(event(CHILD_SPAWN, NOW - 9_500));
    expect(Buffer.byteLength(body)).toBeLessThan(256 * 1024);
    await withRollout(body, async (f) => {
      const identity = await resolveCodexIdentity({
        sessionId: SESSION,
        workingDir: f.session.workingDir,
        codexHome: f.context.codexHome,
        noDaemon: true,
      });
      expect(identity).toMatchObject({ reason: 'verified', conversationId: THREAD, tailTruncated: false });
      expect(identity.tail).toContain('collab_agent_spawn_end');
      f.pane = { paneId: '%7', panePid: 700, dead: true, status: 1, screen: null };
      expect(await f.adapter.observe()).toMatchObject({
        activity: 'watching',
        reason: 'background-work',
        safeToAct: false,
      });
      const unproved: RecoveryFlight = {
        key: `${THREAD}:pane:${f.session.paneExit!.at}:1`,
        action: 'restart',
        conversationId: THREAD,
        startedAt: NOW,
      };
      expect(await f.adapter.act(unproved)).toBe('not-sent');
      expect(f.session.deliverRecovery).not.toHaveBeenCalled();
    });
  });

  it('vetoes a dead-pane restart reservation when the final complete rollout reveals pending child work', async () => {
    await withRollout(failedTail(), async (f, writeBody) => {
      f.pane = { paneId: '%7', panePid: 700, dead: true, status: 1, screen: null };
      const reservation = flight(await f.adapter.observe(), 'restart');
      await writeBody(failedTail() + event(CHILD_SPAWN, NOW - 8_500) + '\n');
      expect(await f.adapter.act(reservation)).toBe('not-sent');
      expect(f.session.deliverRecovery).not.toHaveBeenCalled();
    });
  });

  it('keeps a verified dead pane without pending children eligible for restart', async () => {
    await withRollout(failedTail(), async (f) => {
      f.pane = { paneId: '%7', panePid: 700, dead: true, status: 1, screen: null };
      const observation = await f.adapter.observe();
      expect(observation).toMatchObject({ activity: 'crashed', reason: 'process-crashed', safeToAct: true });
      expect(await f.adapter.act(flight(observation, 'restart'))).toBe('sent');
      expect(f.session.deliverRecovery).toHaveBeenCalledOnce();
    });
  });

  it('keeps a hidden live child non-actionable after the 256KiB tail window loses its spawn', async () => {
    const body = hiddenLiveChildTail();
    expect(Buffer.byteLength(body)).toBeGreaterThan(256 * 1024);
    await withRollout(body, async (f) => {
      const identity = await resolveCodexIdentity({
        sessionId: SESSION,
        workingDir: f.session.workingDir,
        codexHome: f.context.codexHome,
        noDaemon: true,
      });
      expect(identity).toMatchObject({
        reason: 'verified',
        conversationId: THREAD,
        tail: failedTail(),
        tailTruncated: true,
      });
      expect(identity.tail).not.toContain('collab_agent_spawn_end');
      const observation = await f.adapter.observe();
      expect(observation).toMatchObject({ activity: 'interrupted', safeToAct: false, processReady: false });
      const unproved: RecoveryFlight = {
        key: observation.evidenceKey!,
        action: 'continue',
        conversationId: THREAD,
        startedAt: NOW,
      };
      expect(await f.adapter.act(unproved)).toBe('not-sent');
      expect(f.session.deliverRecovery).not.toHaveBeenCalled();
    });
  });

  it.each(['continue', 'restart'] as const)(
    'reprobes the actual tail and vetoes %s if earlier child evidence has fallen outside the window',
    async (action) => {
      await withRollout(failedTail(), async (f, writeBody) => {
        if (action === 'restart') f.pane = { paneId: '%7', panePid: 700, dead: true, status: 1, screen: null };
        const reservation = flight(await f.adapter.observe(), action);
        await writeBody(hiddenLiveChildTail());
        expect(await f.adapter.act(reservation)).toBe('not-sent');
        expect(f.session.deliverRecovery).not.toHaveBeenCalled();
      });
    }
  );

  it.each(['continue', 'restart'] as const)(
    'keeps a complete attributed child lifecycle eligible for %s once the child has completed',
    async (action) => {
      const body =
        event(CHILD_SPAWN, NOW - 20_000) +
        '\n' +
        event(
          {
            type: 'collab_wait_end',
            call_id: 'fixture-wait',
            sender_thread_id: THREAD,
            statuses: { [OTHER]: { completed: null } },
          },
          NOW - 19_000
        ) +
        '\n' +
        failedTail();
      await withRollout(body, async (f) => {
        if (action === 'restart') f.pane = { paneId: '%7', panePid: 700, dead: true, status: 1, screen: null };
        const observation = await f.adapter.observe();
        expect(observation).toMatchObject({
          activity: action === 'restart' ? 'crashed' : 'interrupted',
          safeToAct: true,
          ...(action === 'continue' ? { processReady: true } : {}),
        });
        expect(await f.adapter.act(flight(observation, action))).toBe('sent');
        expect(f.session.deliverRecovery).toHaveBeenCalledOnce();
      });
    }
  );
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
    f.pane = { paneId: '%7', panePid: 700, dead: true, status: 130, signal: undefined, screen: null };
    f.session.paneExit = { at: NOW - 1_000, status: 130 };
    f.context.intentionalStopAt = NOW - 1_500;
    expect(await f.adapter.observe()).toMatchObject({
      activity: 'paused',
      reason: 'user-interrupted',
      safeToAct: false,
    });
    expect(f.session.deliverRecovery).not.toHaveBeenCalled();
  });
});

describe('authoritative agent exits and process readiness', () => {
  it.each(['unchanged', 'PID', 'pane-ID', 'raw-signal', 'missing-ID', 'stale-read'] as const)(
    'binds crash delivery to the observed native incarnation while cached exit evidence stays unchanged: %s',
    async (change) => {
      const f = fixture();
      f.pane = { paneId: '%7', panePid: 700, dead: true, status: 1, screen: null };
      if (change === 'raw-signal') {
        f.pane.status = undefined;
        f.pane.signal = 9;
        f.pane.paneSignalToken = '9';
        f.session.paneExit = { at: NOW - 10_000, signal: 9 };
      }
      const before = await f.adapter.observe();
      expect(before.safeToAct).toBe(true);
      const exit = structuredClone(f.session.paneExit);
      if (change === 'PID') f.pane.panePid = 701;
      if (change === 'pane-ID') f.pane.paneId = '%8';
      if (change === 'raw-signal') f.pane.paneSignalToken = 'KILL';
      if (change === 'missing-ID') f.pane.paneId = undefined;
      if (change === 'stale-read')
        f.session.inspectRecoveryPane.mockImplementationOnce(async () => {
          vi.setSystemTime(NOW + 16_000);
          return f.pane;
        });
      expect(await f.adapter.act(flight(before, 'restart'))).toBe(change === 'unchanged' ? 'sent' : 'not-sent');
      expect(f.session.paneExit).toEqual(exit);
      expect(f.session.deliverRecovery).toHaveBeenCalledTimes(change === 'unchanged' ? 1 : 0);
    }
  );

  it('authorizes restart only for a confirmed matching abnormal local exit', async () => {
    const f = fixture();
    f.pane = { paneId: '%7', panePid: 700, dead: true, status: 1, screen: null };
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
      expect.any(Function),
      CONTINUATION_PROMPT,
      expect.any(Function),
      { paneId: '%7', panePid: 700, status: 1, signal: undefined, paneSignalToken: undefined }
    );
  });

  it('an explicit status 0 is a clean intentional exit and cannot revive', async () => {
    const f = fixture();
    f.pane = { paneId: '%7', panePid: 700, dead: true, status: 0, screen: null };
    f.session.paneExit = { at: NOW - 10_000, status: 0 };
    expect(await f.adapter.observe()).toMatchObject({ activity: 'exited', reason: 'clean-exit', safeToAct: false });
    expect(f.session.deliverRecovery).not.toHaveBeenCalled();
  });

  it('requires a positive signal or numeric abnormal status and agreement with stored exit evidence', async () => {
    const f = fixture();
    f.pane = { paneId: '%7', panePid: 700, dead: true, signal: 9, paneSignalToken: '9', screen: null };
    f.session.paneExit = { at: NOW - 10_000, signal: 9 };
    expect(await f.adapter.observe()).toMatchObject({ activity: 'crashed', safeToAct: true });
    f.pane = { paneId: '%7', panePid: 700, dead: true, screen: null };
    f.session.paneExit = { at: NOW - 10_000 };
    expect(await f.adapter.observe()).toMatchObject({ reason: 'pane-unverified', safeToAct: false });
    f.pane = { paneId: '%7', panePid: 700, dead: true, status: 1, screen: null };
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
    f.pane = { paneId: '%7', panePid: 700, dead: false, screen: '› Unsent fixture draft\n' };
    expect(await f.adapter.observe()).toMatchObject({ processReady: false, safeToAct: false });
    f.pane = { paneId: '%7', panePid: 700, dead: false, screen: `Sanitized sign in requirement\n${READY}` };
    expect(await f.adapter.observe()).toMatchObject({ activity: 'blocked', processReady: false, safeToAct: false });
  });
});

describe('owned remote evidence and mutation', () => {
  function remoteFixture() {
    const f = fixture();
    f.context.submission = {
      at: NOW - 20_000,
      clockDomain: 'local',
      clock: clockAt(NOW - 20_000),
      hash: createHash('sha256').update('Remote fixture request.').digest('hex'),
    };
    f.session.remote = {
      hostId: 'fixture-host',
      label: 'Fixture',
      host: 'fixture.invalid',
      username: 'runner',
      remotePath: '/fixture/workspace',
      owned: true,
    } as Session['remote'];
    return f;
  }

  it.each(['authorized', 'issuer-refused', 'issuer-refused-after-clock', 'owner-changed', 'grant-changed'] as const)(
    'revalidates the local issuer at queued SSH dispatch boundaries: %s',
    async (kind) => {
      const f = remoteFixture();
      const evidence = f.remoteEvidence as Extract<RemoteCodexEvidence, { session: 'present' | 'missing' }>;
      evidence.pane = { dead: false, paneId: '%7', panePid: 700, screen: READY };
      evidence.identity = {
        reason: 'verified',
        conversationId: THREAD,
        tail: completedTail(),
        tailTruncated: false,
        changedAt: NOW - 1000,
      };
      expect((await f.adapter.observe()).processReady).toBe(true);
      let ownerCurrent = true;
      let prepareCount = 0;
      f.session.isRemoteRecoveryAuthorityCurrent.mockImplementation((...args: unknown[]) =>
        (args[2] as () => boolean)()
      );
      const prepare = vi.fn(async () => {
        await Promise.resolve();
        prepareCount++;
        if (kind === 'owner-changed') ownerCurrent = false;
        if (kind === 'grant-changed') f.session.isRemoteRecoveryAuthorityCurrent.mockReturnValue(false);
        return kind !== 'issuer-refused' && !(kind === 'issuer-refused-after-clock' && prepareCount === 2);
      });
      const authority = Object.assign(() => ownerCurrent, { prepareEvidence: prepare });
      const remoteEffect = vi.fn();
      vi.mocked(f.deps.deliverRemote).mockImplementation(async (_remote, _request, token) => {
        if (!token || typeof token === 'function')
          throw new Error('Expected split asynchronous and synchronous authority');
        // The real remote mutation runner checks after queue admission, then samples the clock and checks again.
        if (!(await token.check()) || !token.isCurrent()) return { status: 'not-sent' };
        await Promise.resolve();
        if (!(await token.check()) || !token.isCurrent()) return { status: 'not-sent' };
        remoteEffect();
        return { status: 'sent', submittedAt: NOW };
      });
      const result = await f.adapter.deliverRemotePrompt(THREAD, f.context.generation, 'Authorized task', authority);
      expect(result).toBe(kind === 'authorized' ? 'sent' : 'not-sent');
      expect(prepare).toHaveBeenCalledTimes(['authorized', 'issuer-refused-after-clock'].includes(kind) ? 2 : 1);
      for (const call of prepare.mock.calls) expect(call).toEqual([]);
      expect(remoteEffect).toHaveBeenCalledTimes(kind === 'authorized' ? 1 : 0);
    }
  );

  it.each([
    'unchanged',
    'owner',
    'config',
    'env',
    'home',
    'generation',
    'pane',
    'expired',
    'transport',
    'cancelled',
  ] as const)('binds remote task crash dispatch to current private live provenance: %s', async (change) => {
    const f = remoteFixture();
    const task = new CodexTaskAdapter(f.session as unknown as Session, f.persist, f.deps);
    await task.observe();
    vi.setSystemTime(NOW + 1000);
    const evidence = f.remoteEvidence as Extract<RemoteCodexEvidence, { session: 'present' | 'missing' }>;
    evidence.clock = clockAt();
    evidence.pane = { dead: true, status: 9, paneId: '%7', panePid: 700, screen: null };
    const { observation } = await task.observe();
    expect(observation).toMatchObject({ activity: 'crashed', liveProofAt: NOW });
    if (change === 'owner') f.session.owner = 'other-owner';
    if (change === 'config') f.session.codexConfig.model = 'other-model';
    if (change === 'env') f.env = { FIXTURE_SETTING: 'changed' };
    if (change === 'home') f.context.codexHome = '/fixture/other-home';
    if (change === 'generation') f.context.generation++;
    if (change === 'pane') evidence.pane.panePid = 701;
    if (change === 'expired') vi.setSystemTime(NOW + 30_001);
    if (change === 'transport') {
      f.deps.inspectRemote = vi.fn(
        async () =>
          ({ transport: 'unreachable', session: 'unknown', identity: { reason: 'unverified' } }) as RemoteCodexEvidence
      );
      await task.observe();
      f.deps.inspectRemote = vi.fn(async () => structuredClone(evidence));
    }
    expect(await task.recover(observation, () => change !== 'cancelled')).toBe(
      change === 'unchanged' ? 'sent' : 'not-sent'
    );
    expect(f.deps.restartRemote).toHaveBeenCalledTimes(change === 'unchanged' ? 1 : 0);
    expect(f.session.deliverRecovery).not.toHaveBeenCalled();
  });

  it('dates remote live provenance at the read start when the task is enabled during the remote observation', async () => {
    const f = remoteFixture();
    const read = createDeferred<RemoteCodexEvidence>();
    f.deps.inspectRemote = vi
      .fn()
      .mockReturnValueOnce(read.promise)
      .mockImplementation(async () => structuredClone(f.remoteEvidence));
    const task = new CodexTaskAdapter(f.session as unknown as Session, f.persist, f.deps);
    const inspecting = task.observe();
    await vi.waitFor(() => expect(f.deps.inspectRemote).toHaveBeenCalledOnce());
    vi.setSystemTime(NOW + 1000);
    read.resolve({
      ...f.remoteEvidence,
      clock: { localBefore: NOW, localAfter: NOW + 1000, remoteBefore: NOW, remoteAfter: NOW + 1000 },
    } as RemoteCodexEvidence);
    expect((await inspecting).observation.processReadyAt).toBe(NOW);
    vi.setSystemTime(NOW + 2000);
    const evidence = f.remoteEvidence as Extract<RemoteCodexEvidence, { session: 'present' | 'missing' }>;
    evidence.clock = clockAt();
    evidence.pane = { dead: true, status: 9, paneId: '%7', panePid: 700, screen: null };
    const { observation } = await task.observe();
    expect(observation.liveProofAt).toBe(NOW);
    expect(observation.liveProofAt).toBeLessThan(NOW + 500); // The owner's mid-read enable boundary.
  });

  it.each(['current', 'stale', 'future', 'missing-id', 'invalid-pid', 'dead', 'blocked'] as const)(
    'exports fresh remote restart readiness only from a bounded current live pane: %s',
    async (proof) => {
      const f = remoteFixture();
      const evidence = f.remoteEvidence as Extract<RemoteCodexEvidence, { session: 'present' | 'missing' }>;
      evidence.identity.tail = completedTail();
      if (proof === 'stale') vi.setSystemTime(NOW + 30_001);
      if (proof === 'future') evidence.clock = clockAt(NOW + 1);
      if (proof === 'missing-id') evidence.pane!.paneId = '';
      if (proof === 'invalid-pid') evidence.pane!.panePid = NaN;
      if (proof === 'dead') evidence.pane = { dead: true, status: 9, paneId: '%7', panePid: 700, screen: null };
      if (proof === 'blocked')
        evidence.identity.tail +=
          event({ type: 'error', message: 'Authentication required', codex_error_info: 'unauthorized' }, NOW - 1) +
          '\n';
      const observation = await f.adapter.observe();
      expect(observation.processReadyAt).toBe(proof === 'current' ? NOW : undefined);
      if (proof === 'current') expect(observation).toMatchObject({ activity: 'completed', processReady: true });
    }
  );

  it.each(['missing-clock', 'malformed-clock', 'legacy-submission', 'changed-clock'] as const)(
    'refuses identity and task command authority from %s even with a claimed verified tail',
    async (fault) => {
      const f = remoteFixture();
      const evidence = f.remoteEvidence as Extract<RemoteCodexEvidence, { session: 'present' | 'missing' }>;
      if (fault === 'missing-clock') delete evidence.clock;
      if (fault === 'malformed-clock') evidence.clock = { ...clockAt(), localAfter: NOW - 1 };
      if (fault === 'legacy-submission') f.context.submission = { at: NOW - 20_000, hash: f.context.submission!.hash };
      if (fault === 'changed-clock')
        evidence.clock = { ...clockAt(), remoteBefore: NOW + 60_000, remoteAfter: NOW + 60_000 };
      evidence.identity.tail =
        completedTail() +
        event({ type: 'exec_command_begin', call_id: 'proof', command: ['sh', '-c', 'npm test'] }, NOW - 2000) +
        '\n' +
        event({ type: 'exec_command_end', call_id: 'proof', exit_code: 0 }, NOW - 1000) +
        '\n';
      expect(await f.adapter.observe()).toMatchObject({
        activity: 'unknown',
        reason: 'identity-unverified',
        safeToAct: false,
      });
      expect(f.adapter.getVerifiedTail(THREAD)).toBeUndefined();
      const task = await new CodexTaskAdapter(f.session as unknown as Session, f.persist, f.deps).observe();
      expect(task.observation.activity).toBe('unknown');
      expect(task.commands.size).toBe(0);
      expect(task.marker).toBeUndefined();
      expect(f.session.pinRecoveryConversation).not.toHaveBeenCalled();
    }
  );

  it.each([-60_000, 60_000])(
    'classifies native remote task/command evidence and exports bounded local times with %i ms skew',
    async (offset) => {
      const f = remoteFixture();
      f.context.submission!.clock = {
        ...clockAt(NOW - 20_000),
        remoteBefore: NOW - 20_000 + offset,
        remoteAfter: NOW - 20_000 + offset,
      };
      const evidence = f.remoteEvidence as Extract<RemoteCodexEvidence, { session: 'present' | 'missing' }>;
      evidence.clock = { ...clockAt(), remoteBefore: NOW + offset, remoteAfter: NOW + offset };
      evidence.identity.tail =
        [
          event({ type: 'task_started', turn_id: 'native-turn' }, NOW - 10_000 + offset),
          event(
            { type: 'exec_command_begin', call_id: 'native-command', command: ['sh', '-c', 'npm test'] },
            NOW - 8000 + offset
          ),
          event({ type: 'exec_command_end', call_id: 'native-command', exit_code: 0 }, NOW - 7000 + offset),
          event(
            {
              type: 'agent_message',
              message:
                'CODEMAN_TASK_PROGRESS ' +
                JSON.stringify({ outcome: 'unfinished', checkpoint: 'Verified fixture', nextAction: 'Finish fixture' }),
            },
            NOW - 6500 + offset
          ),
          event({ type: 'task_complete', turn_id: 'native-turn', last_agent_message: null }, NOW - 6000 + offset),
        ].join('\n') + '\n';
      const task = await new CodexTaskAdapter(f.session as unknown as Session, f.persist, f.deps).observe();
      expect(task.observation).toMatchObject({ activity: 'completed', at: NOW - 6000, processReady: true });
      expect(task.commands.get(commandHash('npm test'))).toEqual({ startedAt: NOW - 8000, completedAt: NOW - 7000 });
      expect(task.marker?.at).toBe(NOW - 6500);
      expect(task.marker?.progress).toMatchObject({
        outcome: 'unfinished',
        checkpoint: 'Verified fixture',
        nextAction: 'Finish fixture',
      });
      expect(f.deps.deliverRemote).not.toHaveBeenCalled();
    }
  );

  it.each([undefined, '', 'relative/home'])(
    'refuses remote authority without an explicit absolute worker home (%s)',
    async (codexHome) => {
      const f = remoteFixture();
      f.context.codexHome = codexHome;
      expect(await f.adapter.observe()).toMatchObject({
        activity: 'unknown',
        reason: 'identity-unverified',
        safeToAct: false,
      });
      expect(f.deps.inspectRemote).not.toHaveBeenCalled();
      expect(f.deps.restartRemote).not.toHaveBeenCalled();
      expect(f.deps.deliverRemote).not.toHaveBeenCalled();
    }
  );

  const invalidLifecycleRows = [
    { name: 'malformed JSON', row: '{broken-json}' },
    {
      name: 'unsupported lifecycle schema',
      row: event({ type: 'task_complete', turn_id: { unsupported: 'fixture-turn' } }, NOW - 9_250),
    },
  ];

  it.each(invalidLifecycleRows)('vetoes a dead remote pane with $name after a live child', async ({ row }) => {
    const f = remoteFixture();
    f.remoteEvidence.pane = { dead: true, status: 17, paneId: '%9', panePid: 901, screen: null };
    f.remoteEvidence.identity.tail = failedTail(event(CHILD_SPAWN, NOW - 9_500), row);
    expect(await f.adapter.observe()).toMatchObject({ activity: 'unknown', safeToAct: false });
    expect(f.session.restartRemoteRecoveryPane).not.toHaveBeenCalled();
    expect(f.deps.restartRemote).not.toHaveBeenCalled();
  });

  it.each(invalidLifecycleRows)(
    'vetoes a remote restart reservation when final evidence has $name',
    async ({ row }) => {
      const f = remoteFixture();
      f.remoteEvidence.pane = { dead: true, status: 17, paneId: '%9', panePid: 901, screen: null };
      const reservation = flight(await f.adapter.observe(), 'restart');
      f.remoteEvidence.identity.tail = failedTail(event(CHILD_SPAWN, NOW - 9_500), row);
      expect(await f.adapter.act(reservation)).toBe('not-sent');
      expect(f.session.restartRemoteRecoveryPane).not.toHaveBeenCalled();
      expect(f.deps.restartRemote).not.toHaveBeenCalled();
    }
  );

  it('permits verified remote crash restart after a complete child lifecycle settles', async () => {
    const f = remoteFixture();
    f.remoteEvidence.pane = { dead: true, status: 17, paneId: '%9', panePid: 901, screen: null };
    f.remoteEvidence.identity.tail = failedTail(
      event(CHILD_SPAWN, NOW - 9_500),
      event(
        {
          type: 'collab_wait_end',
          call_id: 'fixture-wait',
          sender_thread_id: THREAD,
          statuses: { [OTHER]: 'completed' },
        },
        NOW - 9_250
      )
    );
    expect(await f.adapter.act(flight(await f.adapter.observe(), 'restart'))).toBe('sent');
    expect(f.deps.restartRemote).toHaveBeenCalledOnce();
  });

  const remoteVetoes = [
    { type: 'error', message: 'Sanitized authentication fixture.', codex_error_info: 'Unauthorized' },
    { type: 'error', message: 'Sanitized usage fixture.', codex_error_info: 'UsageLimitExceeded' },
    { type: 'exec_approval_request', call_id: 'approval-fixture' },
    { type: 'turn_aborted', turn_id: 'fixture-turn', reason: 'replaced' },
    {
      type: 'error',
      message: 'Conversation interrupted.',
      codex_error_info: { response_stream_disconnected: { http_status_code: null }, unauthorized: null },
    },
    CHILD_SPAWN,
  ];
  const remoteVetoTail = (payload: Record<string, unknown>) =>
    event({ type: 'task_started', turn_id: 'fixture-turn' }, NOW - 20_000) + '\n' + event(payload, NOW - 11_000) + '\n';

  it.each(remoteVetoes)(
    'preserves structured remote crash veto %j at observation and final dispatch',
    async (payload) => {
      const f = remoteFixture();
      f.remoteEvidence.pane = { dead: true, status: 17, paneId: '%9', panePid: 901, screen: null };
      const reservation = flight(await f.adapter.observe(), 'restart');
      f.remoteEvidence.identity.tail = remoteVetoTail(payload);
      expect(await f.adapter.act(reservation)).toBe('not-sent');
      expect(await f.adapter.observe()).toMatchObject({ safeToAct: false });
      expect(f.session.restartRemoteRecoveryPane).not.toHaveBeenCalled();
      expect(f.deps.restartRemote).not.toHaveBeenCalled();
    }
  );

  it.each(remoteVetoes)('refuses missing-worker restore with structured veto %j', async (payload) => {
    const f = remoteFixture();
    f.remoteEvidence.session = 'missing';
    f.remoteEvidence.identity.tail = remoteVetoTail(payload);
    expect(await f.adapter.restoreMissingRemote()).toBe('not-sent');
    expect(f.session.restoreMissingRemoteWorker).not.toHaveBeenCalled();
  });

  it('rechecks child work before committing missing-worker restoration', async () => {
    const f = remoteFixture();
    f.remoteEvidence.session = 'missing';
    const inspect = f.deps.inspectRemote.getMockImplementation()!;
    f.deps.inspectRemote.mockImplementation(async (...args) => {
      const result = await inspect(...args);
      f.remoteEvidence.identity.tail = remoteVetoTail(CHILD_SPAWN);
      return result;
    });
    expect(await f.adapter.restoreMissingRemote()).toBe('not-sent');
    expect(f.session.restoreMissingRemoteWorker).not.toHaveBeenCalled();
  });

  it('separates an unreachable SSH transport from a missing remote worker', async () => {
    const f = remoteFixture();
    f.remoteEvidence = { transport: 'unreachable', session: 'unknown', identity: { reason: 'unreadable' } };
    expect(await f.adapter.observe()).toMatchObject({ reason: 'transport-unreachable', safeToAct: false });
    f.remoteEvidence = {
      transport: 'reachable',
      session: 'missing',
      clock: clockAt(),
      identity: {
        reason: 'verified',
        conversationId: THREAD,
        tail: completedTail(),
        tailTruncated: false,
        changedAt: NOW - 1000,
      },
    };
    expect(await f.adapter.observe()).toMatchObject({
      reason: 'remote-session-missing',
      conversationId: THREAD,
      safeToAct: false,
    });
  });

  it('reports an SSH authentication/inspection failure without claiming the host is unreachable', async () => {
    const f = remoteFixture();
    f.remoteEvidence = { transport: 'unavailable', session: 'unknown', identity: { reason: 'unreadable' } };
    expect(await f.adapter.observe()).toMatchObject({ reason: 'transport-unavailable', safeToAct: false });
  });

  it('reports a missing remote inspector runtime as unsupported without restart', async () => {
    const f = remoteFixture();
    f.remoteEvidence = { transport: 'reachable', session: 'unknown', identity: { reason: 'unsupported' } };
    expect(await f.adapter.observe()).toMatchObject({ reason: 'remote-inspector-unavailable', safeToAct: false });
    expect(f.deps.restartRemote).not.toHaveBeenCalled();
  });

  it.each([true, undefined])(
    'refuses remote input and restart when the bounded tail truncation signal is %s',
    async (tailTruncated) => {
      const f = remoteFixture();
      f.remoteEvidence = {
        transport: 'reachable',
        session: 'present',
        clock: clockAt(),
        pane: { dead: false, paneId: '%7', panePid: 700, screen: READY },
        identity: {
          reason: 'verified',
          conversationId: THREAD,
          tail: completedTail(),
          tailTruncated,
          changedAt: NOW - 1000,
        },
      };
      expect(await f.adapter.observe()).toMatchObject({ reason: 'identity-unverified', safeToAct: false });
      expect(await f.adapter.deliverRemotePrompt(THREAD, 3, 'Fixture kickoff', () => true)).toBe('not-sent');

      f.remoteEvidence.pane = { dead: true, status: 17, paneId: '%7', panePid: 700, screen: null };
      expect(await f.adapter.observe()).toMatchObject({ reason: 'identity-unverified', safeToAct: false });
      expect(f.session.restartRemoteRecoveryPane).not.toHaveBeenCalled();
      expect(f.deps.deliverRemote).not.toHaveBeenCalled();
      expect(f.deps.restartRemote).not.toHaveBeenCalled();
    }
  );

  it('treats a missing remote tmux after a clean ssh-wrapper exit as /exit, never reboot restore', async () => {
    const f = remoteFixture();
    f.transportPane = { dead: true, status: 0, screen: null };
    f.remoteEvidence = {
      transport: 'reachable',
      session: 'missing',
      clock: clockAt(),
      identity: {
        reason: 'verified',
        conversationId: THREAD,
        tail: completedTail(),
        tailTruncated: false,
        changedAt: NOW - 1000,
      },
    };
    expect(await f.adapter.observe()).toMatchObject({ activity: 'exited', reason: 'clean-exit', safeToAct: false });
    expect(await f.adapter.restoreMissingRemote()).toBe('not-sent');
    expect(f.session.restoreMissingRemoteWorker).not.toHaveBeenCalled();
  });

  it('sends exact current ordinary-submission proof to the remote reader', async () => {
    const f = remoteFixture();
    f.context.submission = {
      at: NOW - 20_000,
      clockDomain: 'local',
      clock: clockAt(NOW - 20_000),
      hash: createHash('sha256').update('Remote fixture request.').digest('hex'),
    };
    await f.adapter.observe();
    expect(f.deps.inspectRemote).toHaveBeenCalledWith(
      f.session.remote,
      expect.objectContaining({ submission: f.context.submission, resumeId: THREAD })
    );
  });

  it('never accepts originator or a pinned resume id without current ordinary-submission proof', async () => {
    const f = remoteFixture();
    f.context.submission = undefined;
    expect(await f.adapter.observe()).toMatchObject({ reason: 'identity-unverified', safeToAct: false });
    expect(f.deps.inspectRemote).not.toHaveBeenCalled();
  });

  it('reattaches a healthy remote worker before delivering without restarting its pane', async () => {
    const f = remoteFixture();
    const observation = await f.adapter.observe();
    expect(observation).toMatchObject({ activity: 'interrupted', safeToAct: true });
    expect(await f.adapter.act(flight(observation))).toBe('sent');
    expect(f.session.deliverRemoteRecoveryInput).toHaveBeenCalledWith(
      THREAD,
      3,
      expect.stringContaining('Continue the previous unfinished task'),
      expect.any(Function),
      expect.any(Function)
    );
    expect(f.deps.deliverRemote).toHaveBeenCalledWith(
      f.session.remote,
      expect.objectContaining({
        prompt: expect.stringContaining('Continue the previous unfinished task'),
        submission: f.context.submission,
        expected: expect.objectContaining({ conversationId: THREAD, paneId: '%7', panePid: 700 }),
      }),
      expect.objectContaining({ check: expect.any(Function), isCurrent: expect.any(Function) })
    );
    expect(f.deps.restartRemote).not.toHaveBeenCalled();
  });

  it('restarts only an exact abnormal remote dead pane and never uses the local wrapper exit', async () => {
    const f = remoteFixture();
    f.session.paneExit = { at: NOW - 1000, status: 0 } as Session['paneExit'];
    f.remoteEvidence = {
      transport: 'reachable',
      session: 'present',
      clock: clockAt(),
      pane: { dead: true, status: 17, paneId: '%9', panePid: 901, screen: null },
      identity: {
        reason: 'verified',
        conversationId: THREAD,
        tail: failedTail(),
        tailTruncated: false,
        changedAt: NOW - 9000,
      },
    };
    const observation = await f.adapter.observe();
    expect(observation).toMatchObject({ activity: 'crashed', reason: 'process-crashed', safeToAct: true });
    expect(await f.adapter.act(flight(observation, 'restart'))).toBe('sent');
    expect(f.session.restartRemoteRecoveryPane).toHaveBeenCalledWith(
      THREAD,
      3,
      expect.any(Function),
      expect.any(Function)
    );
    expect(f.deps.restartRemote).toHaveBeenCalledExactlyOnceWith(
      f.session.remote,
      expect.objectContaining({
        sessionId: SESSION,
        resumeId: THREAD,
        submission: f.context.submission,
        expectedIdentity: expect.objectContaining({ conversationId: THREAD, tailHash: expect.any(String) }),
        expectedPane: { paneId: '%9', panePid: 901, status: 17, signal: undefined },
        codexHome: '/fixture/codex-home',
        codexConfig: expect.objectContaining({ resumeSessionId: THREAD, noDaemon: true }),
      }),
      expect.objectContaining({ check: expect.any(Function), isCurrent: expect.any(Function) })
    );
  });

  it('persists and recovers a fresh live-to-dead remote pane transition when the rollout did not change', async () => {
    const f = remoteFixture();
    const root = await fs.mkdtemp(join(tmpdir(), 'codeman-remote-crash-store-'));
    const store = new RecoveryStore(join(root, 'recovery.json'));
    f.remoteEvidence = {
      transport: 'reachable',
      session: 'present',
      clock: clockAt(),
      pane: { dead: false, paneId: '%9', panePid: 901, screen: READY },
      identity: {
        reason: 'verified',
        conversationId: THREAD,
        tail: completedTail(),
        tailTruncated: false,
        changedAt: NOW + 60_000,
      },
    };
    const controller = new RecoveryController({
      observe: () => f.adapter.observe(),
      act: (reservation, isCurrent) => f.adapter.act(reservation, isCurrent),
      persist: (state) => store.save(SESSION, state),
      changed: () => {},
      now: () => Date.now(),
    });
    try {
      await controller.updateConfig({ enabled: true, retryDelayMs: 1000 });
      await controller.refresh();
      vi.setSystemTime(NOW + 1000);
      f.remoteEvidence.pane = { dead: true, status: 17, paneId: '%9', panePid: 901, screen: null };
      await controller.refresh();
      expect(controller.getStatus().inFlight).toBeUndefined();
      vi.setSystemTime(NOW + 3000);
      await controller.refresh();
      vi.setSystemTime(NOW + 4000);
      await controller.refresh();
      expect(f.deps.restartRemote).toHaveBeenCalledOnce();
      expect(controller.getStatus().inFlight).toBeDefined();
      await store.flush();
      const persisted = new RecoveryStore(join(root, 'recovery.json')).get(SESSION);
      expect(persisted.lastReason).not.toBe('persistence-failed');
      expect(persisted.inFlight?.key).toMatch(new RegExp(`^${THREAD}:remote-pane:[a-f0-9]{64}$`));
      expect(persisted.inFlight?.key).not.toContain('%9');
    } finally {
      controller.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does not recover an already-dead remote pane from a future rollout timestamp', async () => {
    const f = remoteFixture();
    f.remoteEvidence = {
      transport: 'reachable',
      session: 'present',
      clock: clockAt(),
      pane: { dead: true, status: 17, paneId: '%9', panePid: 901, screen: null },
      identity: {
        reason: 'verified',
        conversationId: THREAD,
        tail: completedTail(),
        tailTruncated: false,
        changedAt: NOW + 60_000,
      },
    };
    expect(await f.adapter.observe()).toMatchObject({ activity: 'crashed', at: 0, safeToAct: false });
    const controller = new RecoveryController({
      observe: () => f.adapter.observe(),
      act: (reservation, isCurrent) => f.adapter.act(reservation, isCurrent),
      persist: async () => {},
      changed: () => {},
      now: () => Date.now(),
    });
    try {
      await controller.updateConfig({ enabled: true, retryDelayMs: 1000 });
      await controller.refresh();
      vi.setSystemTime(NOW + 59_000);
      await controller.refresh();
      vi.setSystemTime(NOW + 60_000);
      await controller.refresh();
      vi.setSystemTime(NOW + 62_000);
      await controller.refresh();
      vi.setSystemTime(NOW + 65_000);
      await controller.refresh();

      expect(controller.getStatus()).toMatchObject({ attempts: 0, failedAttempts: 0 });
      expect(controller.getStatus().pending).toBeUndefined();
      expect(controller.getStatus().inFlight).toBeUndefined();
      expect(f.session.restartRemoteRecoveryPane).not.toHaveBeenCalled();
      expect(f.deps.restartRemote).not.toHaveBeenCalled();
      expect(await f.adapter.observe()).toMatchObject({ activity: 'crashed', at: 0, safeToAct: false });
      expect(
        await new CodexRecoveryAdapter(f.session as unknown as Session, f.persist, f.deps).observe()
      ).toMatchObject({ activity: 'crashed', at: 0, safeToAct: false });
    } finally {
      controller.stop();
    }
  });

  it('does not recover a remote pane that was already dead before recovery was enabled', async () => {
    const f = remoteFixture();
    f.remoteEvidence = {
      transport: 'reachable',
      session: 'present',
      clock: clockAt(),
      pane: { dead: false, paneId: '%9', panePid: 901, screen: READY },
      identity: {
        reason: 'verified',
        conversationId: THREAD,
        tail: completedTail(),
        tailTruncated: false,
        changedAt: NOW - 60_000,
      },
    };
    vi.setSystemTime(NOW - 10_000);
    f.remoteEvidence.clock = clockAt();
    await f.adapter.observe();
    f.remoteEvidence.pane = { dead: true, status: 17, paneId: '%9', panePid: 901, screen: null };
    vi.setSystemTime(NOW - 5000);
    f.remoteEvidence.clock = clockAt();
    expect(await f.adapter.observe()).toMatchObject({
      activity: 'crashed',
      at: NOW - 5000,
      liveProofAt: NOW - 10_000,
    });

    vi.setSystemTime(NOW);
    const controller = new RecoveryController({
      observe: () => f.adapter.observe(),
      act: (reservation, isCurrent) => f.adapter.act(reservation, isCurrent),
      persist: async () => {},
      changed: () => {},
      now: () => Date.now(),
    });
    try {
      await controller.updateConfig({ enabled: true, retryDelayMs: 1000 });
      await controller.refresh();
      vi.setSystemTime(NOW + 10_000);
      await controller.refresh();
      expect(controller.getStatus().inFlight).toBeUndefined();
      expect(f.deps.restartRemote).not.toHaveBeenCalled();
    } finally {
      controller.stop();
    }
  });

  it('vetoes a dead remote pane while structured child work is unfinished', async () => {
    const f = remoteFixture();
    const tail =
      event({ type: 'task_started', turn_id: 'fixture-turn' }, NOW - 10_000) +
      '\n' +
      event(
        {
          type: 'collab_agent_spawn_end',
          call_id: 'fixture-spawn',
          sender_thread_id: THREAD,
          new_thread_id: OTHER,
          status: 'running',
        },
        NOW - 9_500
      ) +
      '\n' +
      event(
        { type: 'task_complete', turn_id: 'fixture-turn', error: { message: 'Conversation interrupted.' } },
        NOW - 9_000
      ) +
      '\n';
    f.remoteEvidence = {
      transport: 'reachable',
      session: 'present',
      clock: clockAt(),
      pane: { dead: true, status: 17, paneId: '%9', panePid: 901, screen: null },
      identity: { reason: 'verified', conversationId: THREAD, tail, tailTruncated: false, changedAt: NOW - 9_000 },
    };
    expect(await f.adapter.observe()).toMatchObject({
      activity: 'watching',
      reason: 'background-work',
      safeToAct: false,
    });
    expect(f.deps.restartRemote).not.toHaveBeenCalled();
  });

  it.each([
    { dead: true, status: 0, paneId: '%7', panePid: 700, screen: null },
    { dead: true, paneId: '%7', panePid: 700, screen: null },
  ])('never revives clean or unverified remote pane exit %j', async (pane) => {
    const f = remoteFixture();
    f.remoteEvidence = {
      transport: 'reachable',
      session: 'present',
      clock: clockAt(),
      pane,
      identity: {
        reason: 'verified',
        conversationId: THREAD,
        tail: failedTail(),
        tailTruncated: false,
        changedAt: NOW - 9000,
      },
    };
    expect(await f.adapter.observe()).toMatchObject({ safeToAct: false });
    expect(f.deps.restartRemote).not.toHaveBeenCalled();
  });

  it('double-checks exact missing identity before explicit owner restore', async () => {
    const f = remoteFixture();
    f.remoteEvidence = {
      transport: 'reachable',
      session: 'missing',
      clock: clockAt(),
      identity: {
        reason: 'verified',
        conversationId: THREAD,
        tail: completedTail(),
        tailTruncated: false,
        changedAt: NOW - 1000,
      },
    };
    expect(await f.adapter.restoreMissingRemote()).toBe('sent');
    expect(f.deps.inspectRemote).toHaveBeenCalledTimes(2);
    expect(f.session.restoreMissingRemoteWorker).toHaveBeenCalledExactlyOnceWith(
      THREAD,
      3,
      expect.any(Function),
      expect.any(Function)
    );
    expect(f.deps.restoreRemote).toHaveBeenCalledWith(
      f.session.remote,
      expect.objectContaining({
        resumeId: THREAD,
        expectedIdentity: { conversationId: THREAD, tailHash: expect.any(String) },
        codexHome: '/fixture/codex-home',
        codexConfig: expect.objectContaining({ noDaemon: true, resumeSessionId: THREAD }),
      }),
      expect.objectContaining({ check: expect.any(Function), isCurrent: expect.any(Function) })
    );
  });

  it('refuses a missing-worker restore if another worker appears during revalidation', async () => {
    const f = remoteFixture();
    f.remoteEvidence = {
      transport: 'reachable',
      session: 'missing',
      clock: clockAt(),
      identity: {
        reason: 'verified',
        conversationId: THREAD,
        tail: completedTail(),
        tailTruncated: false,
        changedAt: NOW - 1000,
      },
    };
    vi.mocked(f.deps.inspectRemote)
      .mockResolvedValueOnce(structuredClone(f.remoteEvidence))
      .mockResolvedValueOnce({
        ...structuredClone(f.remoteEvidence),
        session: 'present',
        clock: clockAt(),
        pane: { dead: false, paneId: '%1', panePid: 1, screen: READY },
      });
    expect(await f.adapter.restoreMissingRemote()).toBe('not-sent');
    expect(f.session.restoreMissingRemoteWorker).not.toHaveBeenCalled();
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

const DEAD_PANE_VETOES = [
  {
    payload: { type: 'error', message: 'Sanitized rollback fixture.', codex_error_info: 'thread_rollback_failed' },
    activity: 'unknown',
    reason: 'observing',
  },
  {
    payload: {
      type: 'error',
      message: 'Sanitized steering fixture.',
      codex_error_info: { active_turn_not_steerable: { turn_kind: 'review' } },
    },
    activity: 'unknown',
    reason: 'observing',
  },

  {
    payload: { type: 'error', message: 'Sanitized authentication fixture.', codex_error_info: 'Unauthorized' },
    activity: 'blocked',
    reason: 'authentication-required',
  },
  {
    payload: { type: 'error', message: 'Sanitized limit fixture.', codex_error_info: 'UsageLimitExceeded' },
    activity: 'blocked',
    reason: 'usage-limit',
  },
  { payload: { type: 'error', message: 'Sanitized unknown error fixture.' }, activity: 'blocked', reason: 'observing' },
  {
    payload: { type: 'exec_approval_request', call_id: 'approval-fixture' },
    activity: 'paused',
    reason: 'approval-required',
  },
  {
    payload: { type: 'turn_aborted', turn_id: 'fixture-turn', reason: 'interrupted' },
    activity: 'paused',
    reason: 'user-interrupted',
  },
];

function deadPaneVetoTail(payload: Record<string, unknown>): string {
  return (
    event({ type: 'task_started', turn_id: 'fixture-turn' }, NOW - 20_000) + '\n' + event(payload, NOW - 11_000) + '\n'
  );
}

describe('dead local panes preserve structured recovery vetoes', () => {
  it.each(DEAD_PANE_VETOES)('preserves $reason before authorizing a crash', async ({ payload, activity, reason }) => {
    const f = fixture();
    f.pane = { paneId: '%7', panePid: 700, dead: true, status: 1, screen: null };
    f.identity.tail = deadPaneVetoTail(payload);
    expect(await f.adapter.observe()).toMatchObject({ activity, reason, safeToAct: false });
    expect(f.session.deliverRecovery).not.toHaveBeenCalled();
  });

  it.each(DEAD_PANE_VETOES)('rechecks $reason before delivering a reserved restart', async ({ payload }) => {
    const f = fixture();
    f.pane = { paneId: '%7', panePid: 700, dead: true, status: 1, screen: null };
    const reserved = flight(await f.adapter.observe(), 'restart');
    f.identity.tail = deadPaneVetoTail(payload);
    expect(await f.adapter.act(reserved)).toBe('not-sent');
    expect(f.session.deliverRecovery).not.toHaveBeenCalled();
  });

  it('still resumes a verified abnormal exit without a structured veto', async () => {
    const f = fixture();
    f.pane = { paneId: '%7', panePid: 700, dead: true, status: 1, screen: null };
    expect(await f.adapter.act(flight(await f.adapter.observe(), 'restart'))).toBe('sent');
    expect(f.session.deliverRecovery).toHaveBeenCalledOnce();
  });
});

describe('malformed error variants cannot spend an existing recovery reservation', () => {
  it.each([false, true])('denies final recovery with a contradictory error enum (dead=%s)', async (dead) => {
    const f = fixture();
    if (dead) f.pane = { paneId: '%7', panePid: 700, dead: true, status: 1, screen: null };
    const reserved = flight(await f.adapter.observe(), dead ? 'restart' : 'continue');
    f.identity.tail = deadPaneVetoTail({
      type: 'task_complete',
      turn_id: 'fixture-turn',
      error: {
        message: 'Conversation interrupted.',
        codex_error_info: { response_stream_disconnected: { http_status_code: null }, unauthorized: null },
      },
    });
    expect(await f.adapter.act(reserved)).toBe('not-sent');
    expect(f.session.deliverRecovery).not.toHaveBeenCalled();
  });
});
