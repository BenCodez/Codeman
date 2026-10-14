/**
 * @fileoverview Behavioral authority tests for the Codex recovery adapter.
 * Sessions, pane reads and owner clamps are fakes; rollout reads use isolated fixture files or fakes.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/session.js';
import type { CodexConfig } from '../src/types/session.js';
import { clampEnvOverridesForOwner, clampExternalCliConfigsForOwner } from '../src/session-env-clamp.js';
import { CodexRecoveryAdapter } from '../src/recovery/codex-adapter.js';
import { resolveCodexIdentity, type CodexIdentityResult } from '../src/recovery/codex-identity.js';
import { CONTINUATION_PROMPT, type RecoveryFlight, type RecoveryObservation } from '../src/recovery/types.js';
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
      submission: undefined as { at: number; hash: string } | undefined,
    },
    pane: { paneId: '%7', panePid: 700, dead: false, screen: READY } as Pane | null,
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
