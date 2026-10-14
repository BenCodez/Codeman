/** Shared child statuses must veto local stall and remote recovery authority. No process launches. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexRecoveryAdapter, type CodexRecoveryAdapterDeps } from '../src/recovery/codex-adapter.js';
import type { RemoteCodexEvidence } from '../src/recovery/remote-codex.js';
import type { Session } from '../src/session.js';
import {
  CHILD_NOW,
  CHILD_READY,
  CHILD_THREAD,
  createChildLifecycleFixture,
  returnedChildTail,
} from './helpers/codex-child-lifecycle-fixture.js';

vi.mock('../src/recovery/remote-clock.js', async (original) => ({
  ...(await original<typeof import('../src/recovery/remote-clock.js')>()),
  sampleRemoteCodexClock: vi.fn(async () => clockAt()),
}));
const clockAt = (at = Date.now()) => ({ localBefore: at, localAfter: at, remoteBefore: at, remoteAfter: at });

vi.mock('../src/session-env-clamp.js', () => ({
  clampExternalCliConfigsForOwner: vi.fn(async (_owner, configs) => configs),
  clampEnvOverridesForOwner: vi.fn(async (_owner, env) => env),
}));

const REACTIVATIONS = ['collab_agent_interaction_end', 'collab_resume_end', 'collab_wait_end'];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(CHILD_NOW);
});
afterEach(() => vi.useRealTimers());

describe('actual local stall controller with an abnormally dead owned pane', () => {
  it.each(REACTIVATIONS)('never restarts a resumed child after two quiet-time probes (%s)', async (type) => {
    const f = await createChildLifecycleFixture(returnedChildTail(type), true, false);
    try {
      expect(f.session.paneExit).toBeUndefined();
      expect(f.controller.getStatus().config).toMatchObject({ detectStalls: true, stalledAfterMs: 10_000 });
      expect(await f.adapter.observe()).toMatchObject({
        activity: 'watching',
        reason: 'background-work',
        safeToAct: false,
      });
      await f.controller.refresh();
      vi.setSystemTime(CHILD_NOW + 2000);
      await f.controller.refresh();
      expect(f.delivered).not.toHaveBeenCalled();
      expect(f.controller.getStatus().pending).toBeUndefined();
      vi.setSystemTime(CHILD_NOW + 3000);
      await f.controller.refresh();
      await f.controller.retry(); // Even explicit Retry cannot overtake certified child work.
      expect(f.delivered).not.toHaveBeenCalled();
      expect(f.controller.getStatus()).toMatchObject({ attempts: 0, lastReason: 'background-work' });
      expect(f.controller.getStatus().inFlight).toBeUndefined();
    } finally {
      await f.cleanup();
    }
  });

  it.each(['completed', 'shutdown'])(
    'permits an otherwise proven stall after the named child is %s',
    async (status) => {
      const f = await createChildLifecycleFixture(returnedChildTail('collab_resume_end', status), true, false);
      try {
        expect(await f.adapter.observe()).toMatchObject({
          activity: 'working',
          reason: 'turn-running',
          stallRestartable: true,
        });
        await f.controller.refresh();
        vi.setSystemTime(CHILD_NOW + 2000);
        await f.controller.refresh();
        vi.setSystemTime(CHILD_NOW + 3000);
        await f.controller.refresh();
        expect(f.delivered).toHaveBeenCalledTimes(1);
        expect(f.delivered.mock.calls[0][0]).toMatchObject({ action: 'restart', reason: 'stalled' });
      } finally {
        await f.cleanup();
      }
    }
  );
});

async function remoteFixture(type: string, status: unknown, dead: boolean, preparedClock = true) {
  const f = await createChildLifecycleFixture(returnedChildTail(type, status, true), false);
  const remote = {
    hostId: 'fixture-host',
    label: 'Fixture',
    host: 'fixture.invalid',
    username: 'runner',
    remotePath: '/fixture/workspace',
    owned: true,
  } as NonNullable<Session['remote']>;
  Object.assign(f.session, {
    _remote: remote,
    ptyProcess: { write: vi.fn(), kill: vi.fn() },
  });
  // Prepare the real Session admission before the owner bytes, with exclusively fake clock IO.
  if (preparedClock) {
    const admission = await f.session.prepareUserInputClock('Sanitized fixture request\r', { fromUser: true });
    expect(admission?.()).toBe(true);
  }
  expect(f.session.write('Sanitized fixture request\r', { fromUser: true })).toBe(true);
  expect(f.session.getRecoveryContext()).toMatchObject({ managed: true, noDaemon: true, remoteOwned: true });
  expect(f.session.getRecoveryContext().submission).toBeDefined();
  if (preparedClock)
    expect(f.session.getRecoveryContext().submission).toMatchObject({ clockDomain: 'local', clock: clockAt() });
  const evidence: RemoteCodexEvidence = {
    transport: 'reachable',
    session: 'present',
    pane: { dead, paneId: '%7', panePid: 700, screen: dead ? null : CHILD_READY, ...(dead ? { status: 9 } : {}) },
    identity: {
      reason: 'verified',
      conversationId: CHILD_THREAD,
      tail: returnedChildTail(type, status, true),
      tailTruncated: false,
      changedAt: CHILD_NOW - 1000,
    },
  };
  const deps: CodexRecoveryAdapterDeps = {
    inspectRemote: vi.fn(async () => ({ ...evidence, clock: clockAt() })),
    restartRemote: vi.fn(async () => 'sent'),
    deliverRemote: vi.fn(async () => ({ status: 'sent', submittedAt: Date.now(), clock: clockAt() })),
  };
  const adapter = new CodexRecoveryAdapter(f.session, vi.fn(), deps);
  return { ...f, adapter, deps };
}

describe('actual remote adapter uses the same child lifecycle veto', () => {
  it.each([false, true])('refuses legacy remote submission without clock provenance (dead=%s)', async (dead) => {
    const f = await remoteFixture('collab_resume_end', { completed: null }, dead, false);
    try {
      expect(f.session.getRecoveryContext().submission?.clock).toBeUndefined();
      expect(await f.adapter.observe()).toMatchObject({
        activity: 'unknown',
        reason: 'identity-unverified',
        safeToAct: false,
      });
      expect(
        await f.adapter.act({
          key: 'legacy-clock',
          action: dead ? 'restart' : 'continue',
          conversationId: CHILD_THREAD,
          startedAt: Date.now(),
        })
      ).toBe('not-sent');
      expect(f.deps.restartRemote).not.toHaveBeenCalled();
      expect(f.deps.deliverRemote).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  });

  it.each(REACTIVATIONS)('never continues or restarts while %s reports a reactivated child', async (type) => {
    for (const dead of [false, true]) {
      const f = await remoteFixture(type, 'running', dead);
      try {
        expect(await f.adapter.observe()).toMatchObject({
          activity: 'watching',
          reason: 'background-work',
          safeToAct: false,
        });
        vi.setSystemTime(CHILD_NOW + 2000);
        expect(await f.adapter.observe()).toMatchObject({ activity: 'watching', safeToAct: false });
        expect(
          await f.adapter.act({
            key: 'unproved-child-fixture',
            action: dead ? 'restart' : 'continue',
            conversationId: CHILD_THREAD,
            startedAt: Date.now(),
          })
        ).toBe('not-sent');
        expect(f.deps.restartRemote).not.toHaveBeenCalled();
        expect(f.deps.deliverRemote).not.toHaveBeenCalled();
      } finally {
        await f.cleanup();
      }
      vi.setSystemTime(CHILD_NOW);
    }
  });

  it.each([false, true])('keeps remote terminal-child recovery supported (dead=%s)', async (dead) => {
    const f = await remoteFixture('collab_resume_end', { completed: null }, dead);
    try {
      const observation = await f.adapter.observe();
      expect(observation.safeToAct).toBe(true);
      expect(
        await f.adapter.act({
          key: observation.evidenceKey!,
          action: dead ? 'restart' : 'continue',
          conversationId: CHILD_THREAD,
          startedAt: Date.now(),
        })
      ).toBe('sent');
      expect(dead ? f.deps.restartRemote : f.deps.deliverRemote).toHaveBeenCalledTimes(1);
    } finally {
      await f.cleanup();
    }
  });
});
