/** Shared child statuses must veto local stall and remote recovery authority. No process launches. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexRecoveryAdapter, type CodexRecoveryAdapterDeps } from '../src/recovery/codex-adapter.js';
import type { RemoteCodexEvidence } from '../src/recovery/remote-codex.js';
import type { Session } from '../src/session.js';
import { RecoveryController } from '../src/recovery/controller.js';
import { initialRecoveryState } from '../src/recovery/types.js';
import { RecoveryStore } from '../src/recovery/store.js';
import { sampleRemoteCodexClock } from '../src/recovery/remote-clock.js';
import { clampExternalCliConfigsForOwner } from '../src/session-env-clamp.js';
import {
  CHILD_NOW,
  childEvent,
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
  it.each([true, false])(
    'keeps a pinned UUID and owned header without tracked input non-actionable (watcher=%s)',
    async (storedExit) => {
      const f = await createChildLifecycleFixture(
        returnedChildTail('collab_resume_end', 'completed'),
        true,
        storedExit,
        false
      );
      try {
        expect(f.session.getRecoveryContext().submission).toBeUndefined();
        expect(f.session.codexConfig?.resumeSessionId).toBe(CHILD_THREAD);
        expect(await f.adapter.observe()).toMatchObject({
          activity: 'unknown',
          reason: 'identity-unverified',
          safeToAct: false,
        });
        await f.controller.refresh();
        vi.setSystemTime(CHILD_NOW + 2_000);
        await f.controller.refresh();
        vi.setSystemTime(CHILD_NOW + 3_000);
        await f.controller.retry();
        expect(f.delivered).not.toHaveBeenCalled();
        expect(f.controller.getStatus().attempts).toBe(0);
        expect(f.controller.getStatus().inFlight).toBeUndefined();
        expect(f.adapter.getVerifiedTail(CHILD_THREAD)).toBeUndefined();
      } finally {
        await f.cleanup();
      }
    }
  );

  it('requires two fresh observations of one exact native process rather than mixing different dead pane PIDs', async () => {
    const f = await createChildLifecycleFixture(returnedChildTail('collab_resume_end', 'completed'), true, true);
    try {
      await f.controller.refresh();
      vi.setSystemTime(CHILD_NOW + 2000);
      vi.spyOn(f.session, 'inspectRecoveryPane').mockResolvedValue({
        dead: true,
        status: 9,
        screen: null,
        paneId: '%7',
        panePid: 701,
      });
      await f.controller.refresh();
      vi.setSystemTime(CHILD_NOW + 3000);
      await f.controller.refresh();
      expect(f.delivered).not.toHaveBeenCalled();
      expect(f.controller.getStatus().attempts).toBe(0);
      vi.setSystemTime(CHILD_NOW + 4000);
      await f.controller.refresh();
      vi.setSystemTime(CHILD_NOW + 5000);
      await f.controller.refresh();
      expect(f.delivered).toHaveBeenCalledOnce();
    } finally {
      await f.cleanup();
    }
  });
  it.each(REACTIVATIONS.flatMap((type) => [false, true].map((storedExit) => ({ type, storedExit }))))(
    'never restarts a resumed child after two quiet-time probes ($type, watcher exit=$storedExit)',
    async ({ type, storedExit }) => {
      const f = await createChildLifecycleFixture(returnedChildTail(type), true, storedExit);
      try {
        expect(!!f.session.paneExit).toBe(storedExit);
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
    }
  );

  it.each([
    { detectStalls: true, recoverCrashes: false },
    { detectStalls: true, recoverCrashes: true },
    { detectStalls: false, recoverCrashes: true },
    { detectStalls: false, recoverCrashes: false },
  ])('honors independent stall/crash policies after the actual pane watcher records an exit: %j', async (policy) => {
    const f = await createChildLifecycleFixture(returnedChildTail('collab_resume_end', 'completed'), true, false);
    try {
      expect(f.session.setPaneExit({ at: CHILD_NOW - 1000, status: 9 })).toBe(true);
      await f.controller.updateConfig({ ...policy, stalledAfterMs: 40_000 });
      expect(await f.adapter.observe()).toMatchObject({
        activity: 'crashed',
        safeToAct: true,
        stallRestartable: true,
        progressAt: CHILD_NOW - 25_000,
      });
      await f.controller.inspect();
      expect(f.controller.getStatus().activity).toBe(policy.detectStalls ? 'working' : 'crashed');
      await f.controller.refresh();
      vi.setSystemTime(CHILD_NOW + 2000);
      await f.controller.refresh();
      vi.setSystemTime(CHILD_NOW + 3000);
      await f.controller.refresh();
      if (!policy.detectStalls) {
        expect(f.delivered).toHaveBeenCalledTimes(policy.recoverCrashes ? 1 : 0);
        if (policy.recoverCrashes)
          expect(f.delivered.mock.calls[0][0]).toMatchObject({ action: 'restart', reason: 'process-crashed' });
        return;
      }
      // Recorded death cannot bypass the owner's 40-second silence threshold.
      expect(f.delivered).not.toHaveBeenCalled();
      expect(f.controller.getStatus().attempts).toBe(0);
      vi.setSystemTime(CHILD_NOW + 15_000);
      await f.controller.refresh();
      vi.setSystemTime(CHILD_NOW + 16_999);
      await f.controller.refresh();
      expect(f.delivered).not.toHaveBeenCalled();
      vi.setSystemTime(CHILD_NOW + 17_000);
      await f.controller.refresh();
      vi.setSystemTime(CHILD_NOW + 18_000);
      await f.controller.refresh();
      expect(f.delivered).toHaveBeenCalledOnce();
      expect(f.delivered.mock.calls[0][0]).toMatchObject({
        action: 'restart',
        reason: 'stalled',
        stallProgressAt: CHILD_NOW - 25_000,
      });
      expect(f.store.get(f.session.id).inFlight?.key).toContain(':stalled');
    } finally {
      await f.cleanup();
    }
  });

  it.each(['live', 'clean', 'owner-stop', 'authentication', 'usage-limit'] as const)(
    'keeps $0 authoritative over a recorded watcher death and explicit stall recovery',
    async (veto) => {
      let body = returnedChildTail('collab_resume_end', 'completed');
      if (veto === 'authentication')
        body +=
          childEvent(
            {
              type: 'task_complete',
              turn_id: 'current',
              error: { message: 'Authentication required', codex_error_info: 'unauthorized' },
            },
            24_000
          ) + '\n';
      if (veto === 'usage-limit')
        body += childEvent({ type: 'turn_aborted', turn_id: 'current', reason: 'budget_limited' }, 24_000) + '\n';
      const f = await createChildLifecycleFixture(body, veto !== 'live', false);
      try {
        if (veto === 'clean') {
          vi.spyOn(f.session, 'inspectRecoveryPane').mockResolvedValue({ dead: true, status: 0, screen: null });
          f.session.setPaneExit({ at: CHILD_NOW - 1000, status: 0 });
        } else f.session.setPaneExit({ at: CHILD_NOW - 1000, status: 9 });
        if (veto === 'owner-stop') Object.assign(f.session, { _recoveryIntentionalStopAt: CHILD_NOW - 25_000 });
        await f.controller.updateConfig({ recoverCrashes: true });
        await f.controller.refresh();
        vi.setSystemTime(CHILD_NOW + 2000);
        await f.controller.refresh();
        vi.setSystemTime(CHILD_NOW + 3000);
        await f.controller.refresh();
        await f.controller.retry();
        expect(f.delivered).not.toHaveBeenCalled();
        expect(f.controller.getStatus().attempts).toBe(0);
      } finally {
        await f.cleanup();
      }
    }
  );

  it.each([NaN, Infinity, -1, 0, Number.MAX_SAFE_INTEGER + 1, CHILD_NOW + 60_000])(
    'refuses malformed or future watcher timestamps %s despite otherwise valid stall evidence',
    async (at) => {
      const f = await createChildLifecycleFixture(returnedChildTail('collab_resume_end', 'completed'), true, false);
      try {
        f.session.setPaneExit({ at, status: 9 });
        expect(await f.adapter.observe()).toMatchObject({
          activity: 'unknown',
          reason: 'pane-unverified',
          safeToAct: false,
        });
        await f.controller.refresh();
        vi.setSystemTime(CHILD_NOW + 2000);
        await f.controller.refresh();
        expect(f.delivered).not.toHaveBeenCalled();
        expect(f.controller.getStatus().attempts).toBe(0);
      } finally {
        await f.cleanup();
      }
    }
  );

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

async function remoteFixture(
  type: string,
  status: unknown,
  dead: boolean,
  preparedClock = true,
  unfinished = false,
  offset = 0
) {
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
    expect(f.session.getRecoveryContext().submission).toMatchObject({
      clockDomain: 'local',
      clock: { ...clockAt(), remoteBefore: Date.now() + offset, remoteAfter: Date.now() + offset },
    });
  const evidence: RemoteCodexEvidence = {
    transport: 'reachable',
    session: 'present',
    pane: { dead, paneId: '%7', panePid: 700, screen: dead ? null : CHILD_READY, ...(dead ? { status: 9 } : {}) },
    identity: {
      reason: 'verified',
      conversationId: CHILD_THREAD,
      tail: returnedChildTail(type, status, !unfinished),
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
  const state = initialRecoveryState();
  state.config = { ...state.config, enabled: true, detectStalls: true, stalledAfterMs: 40_000, retryDelayMs: 1000 };
  state.armedAt = CHILD_NOW - 60_000;
  const controller = new RecoveryController(
    {
      observe: () => adapter.observe(),
      act: (flight, current) => adapter.act(flight, current),
      persist: (next) => f.store.save(f.session.id, next),
      changed: vi.fn(),
    },
    state
  );
  return {
    ...f,
    adapter,
    deps,
    evidence,
    controller,
    async cleanup() {
      controller.stop();
      await controller.drain();
      await f.cleanup();
    },
  };
}

describe('actual remote adapter uses the same child lifecycle veto', () => {
  it('confirms and dispatches unchanged native progress across varying bounded SSH latency', async () => {
    const f = await remoteFixture('collab_resume_end', { completed: null }, true, true, true);
    let probes = 0;
    vi.mocked(f.deps.inspectRemote).mockImplementation(async () => {
      const latency = [40, 90, 20, 70][probes++] ?? 50;
      const now = Date.now();
      return {
        ...f.evidence,
        clock: {
          localBefore: now - latency,
          localAfter: now,
          remoteBefore: now - latency / 2,
          remoteAfter: now - latency / 2,
        },
      };
    });
    try {
      for (const delta of [15_100, 17_100, 18_100]) {
        vi.setSystemTime(CHILD_NOW + delta);
        await f.controller.refresh();
      }
      expect(probes).toBe(4);
      expect(f.deps.restartRemote).toHaveBeenCalledOnce();
      expect(f.deps.deliverRemote).not.toHaveBeenCalled();
      expect(f.delivered).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  });

  it.each(['same-time-progress', 'new-progress', 'changed-pane', 'expired-clock', 'invalid-clock'] as const)(
    'refuses %s at the final native remote read despite clock jitter',
    async (change) => {
      const f = await remoteFixture('collab_resume_end', { completed: null }, true, true, true);
      let probes = 0;
      vi.mocked(f.deps.inspectRemote).mockImplementation(async () => {
        const latency = [40, 90, 20, 70][probes++] ?? 50;
        const now = Date.now();
        if (probes === 4) {
          if (change === 'same-time-progress' || change === 'new-progress')
            f.evidence.identity.tail +=
              childEvent(
                { type: 'agent_message', message: 'Fresh structured work' },
                change === 'same-time-progress' ? 25_000 : -17_000
              ) + '\n';
          if (change === 'changed-pane') f.evidence.pane!.panePid++;
        }
        return {
          ...f.evidence,
          clock:
            probes === 4 && change === 'expired-clock'
              ? clockAt(CHILD_NOW)
              : {
                  localBefore: now - latency,
                  localAfter: now,
                  remoteBefore: now - latency / 2,
                  remoteAfter: now - latency / 2 + (probes === 4 && change === 'invalid-clock' ? 20_000 : 0),
                },
        };
      });
      try {
        for (const delta of [15_100, 17_100, 18_100]) {
          vi.setSystemTime(CHILD_NOW + delta);
          await f.controller.refresh();
        }
        expect(probes).toBe(4);
        expect(f.deps.restartRemote).not.toHaveBeenCalled();
        expect(f.deps.deliverRemote).not.toHaveBeenCalled();
      } finally {
        await f.cleanup();
      }
    }
  );

  it('uses the latest plausible local time at the final quiet-interval boundary', async () => {
    const f = await remoteFixture('collab_resume_end', { completed: null }, true, true, true);
    let latency = 40;
    vi.mocked(f.deps.inspectRemote).mockImplementation(async () => {
      const now = Date.now();
      return {
        ...f.evidence,
        clock: {
          localBefore: now - latency,
          localAfter: now,
          remoteBefore: now - latency / 2,
          remoteAfter: now - latency / 2,
        },
      };
    });
    try {
      vi.setSystemTime(CHILD_NOW + 15_100);
      const observed = await f.adapter.observe();
      latency = 1000;
      expect(
        await f.adapter.act({
          key: observed.stallEvidenceKey!,
          conversationId: CHILD_THREAD,
          action: 'restart',
          reason: 'stalled',
          startedAt: Date.now(),
          stallProgressAt: observed.progressAt,
          stallProgressEvidenceKey: observed.progressEvidenceKey,
          stallQuietPeriodMs: 40_000,
        })
      ).toBe('not-sent');
      expect(f.deps.restartRemote).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  });

  it('retains one durable live-silence warning across changing clock uncertainty and reload', async () => {
    const f = await remoteFixture('collab_resume_end', { completed: null }, false, true, true);
    let probes = 0;
    vi.mocked(f.deps.inspectRemote).mockImplementation(async () => {
      const latency = [40, 90, 20, 70][probes++ % 4];
      const now = Date.now();
      return {
        ...f.evidence,
        clock: {
          localBefore: now - latency,
          localAfter: now,
          remoteBefore: now - latency / 2,
          remoteAfter: now - latency / 2,
        },
      };
    });
    let restored: RecoveryController | undefined;
    try {
      for (const delta of [15_100, 17_100]) {
        vi.setSystemTime(CHILD_NOW + delta);
        await f.controller.refresh();
      }
      const saved = f.store.get(f.session.id);
      expect(saved.stallAlert?.progressEvidenceKey).toMatch(/^remote:[a-f0-9]{64}$/);
      expect(
        saved.history.filter((event) => event.kind === 'attention' && event.reason === 'stall-unverified')
      ).toHaveLength(1);
      f.controller.stop();
      restored = new RecoveryController(
        {
          observe: () => f.adapter.observe(),
          act: (flight, current) => f.adapter.act(flight, current),
          persist: (state) => f.store.save(f.session.id, state),
          changed: vi.fn(),
        },
        new RecoveryStore(Reflect.get(f.store, 'path')).get(f.session.id)
      );
      vi.setSystemTime(CHILD_NOW + 18_100);
      await restored.inspect();
      await restored.refresh();
      expect(restored.getStatus()).toMatchObject({
        needsAttention: true,
        lastReason: 'stall-unverified',
        stallAlert: saved.stallAlert,
      });
      expect(
        restored
          .getStatus()
          .history.filter((event) => event.kind === 'attention' && event.reason === 'stall-unverified')
      ).toHaveLength(1);
      expect(f.deps.restartRemote).not.toHaveBeenCalled();
      expect(f.deps.deliverRemote).not.toHaveBeenCalled();
    } finally {
      restored?.stop();
      await restored?.drain();
      await f.cleanup();
    }
  });

  it.each([false, true])(
    'never replays accepted native progress after clock jitter and a durable reload, but permits a new proved cycle (legacy numeric history=%s)',
    async (legacyNumeric) => {
      const f = await remoteFixture('collab_resume_end', { completed: null }, true, true, true);
      let probes = 0;
      vi.mocked(f.deps.inspectRemote).mockImplementation(async () => {
        const latency = [40, 90, 20, 70][probes++ % 4];
        const now = Date.now();
        return {
          ...f.evidence,
          clock: {
            localBefore: now - latency,
            localAfter: now,
            remoteBefore: now - latency / 2,
            remoteAfter: now - latency / 2,
          },
        };
      });
      let restored: RecoveryController | undefined;
      try {
        for (const delta of [15_100, 17_100, 18_100]) {
          vi.setSystemTime(CHILD_NOW + delta);
          await f.controller.refresh();
        }
        expect(f.deps.restartRemote).toHaveBeenCalledOnce();
        f.evidence.pane = { dead: false, paneId: '%7', panePid: 701, screen: CHILD_READY };
        vi.setSystemTime(CHILD_NOW + 19_100);
        await f.controller.refresh();
        expect(f.store.get(f.session.id).inFlight).toBeUndefined();
        expect(f.store.get(f.session.id).handledEvidence[0]).toMatch(/^stall:[a-f0-9]{64}:remote:[a-f0-9]{64}$/);
        if (legacyNumeric) {
          const state = f.store.get(f.session.id);
          state.handledEvidence = state.handledEvidence.map((key) =>
            key.replace(/remote:[a-f0-9]{64}$/, String(CHILD_NOW - 25_000 + 20))
          );
          await f.store.save(f.session.id, state);
        }
        f.controller.stop();
        restored = new RecoveryController(
          {
            observe: () => f.adapter.observe(),
            act: (flight, current) => f.adapter.act(flight, current),
            persist: (state) => f.store.save(f.session.id, state),
            changed: vi.fn(),
          },
          new RecoveryStore(Reflect.get(f.store, 'path')).get(f.session.id)
        );
        await restored.updateConfig({ enabled: false });
        await restored.updateConfig({ enabled: true });
        f.evidence.pane = { dead: true, paneId: '%7', panePid: 701, status: 9, screen: null };
        for (const delta of [60_000, 62_000, 63_000]) {
          vi.setSystemTime(CHILD_NOW + delta);
          await restored.refresh();
        }
        expect(f.deps.restartRemote).toHaveBeenCalledOnce();
        f.evidence.identity.tail +=
          childEvent({ type: 'agent_message', message: 'New native progress after accepted recovery' }, -20_000) + '\n';
        for (const delta of [64_000, 66_000, 68_000]) {
          vi.setSystemTime(CHILD_NOW + delta);
          await restored.refresh();
        }
        expect(f.deps.restartRemote).toHaveBeenCalledTimes(2);
        expect(restored.getStatus().attempts).toBe(2);
        expect(f.deps.deliverRemote).not.toHaveBeenCalled();
      } finally {
        restored?.stop();
        await restored?.drain();
        await f.cleanup();
      }
    }
  );

  it.each([
    'missing-key',
    'missing-lower-bound',
    'malformed-key',
    'fractional-bound',
    'future-bound',
    'zero-bound',
  ] as const)('keeps incomplete remote progress metadata %s non-actionable', async (change) => {
    const f = await remoteFixture('collab_resume_end', { completed: null }, true, true, true);
    const observe = f.adapter.observe.bind(f.adapter);
    vi.spyOn(f.adapter, 'observe').mockImplementation(async () => {
      const result = await observe();
      if (change === 'missing-key') result.progressEvidenceKey = undefined;
      if (change === 'missing-lower-bound') result.progressLowerBound = undefined;
      if (change === 'malformed-key') result.progressEvidenceKey = 'remote:unknown';
      if (change === 'fractional-bound') result.progressLowerBound! -= 0.5;
      if (change === 'future-bound') result.progressLowerBound = Date.now() + 1;
      if (change === 'zero-bound') result.progressLowerBound = 0;
      return result;
    });
    try {
      for (const delta of [15_100, 17_100, 18_100]) {
        vi.setSystemTime(CHILD_NOW + delta);
        await f.controller.refresh();
      }
      expect(f.deps.restartRemote).not.toHaveBeenCalled();
      expect(f.controller.getStatus().inFlight).toBeUndefined();
    } finally {
      await f.cleanup();
    }
  });

  it.each([
    { detectStalls: true, recoverCrashes: false },
    { detectStalls: true, recoverCrashes: true },
    { detectStalls: false, recoverCrashes: true },
    { detectStalls: false, recoverCrashes: false },
  ])('honors independent remote stall/crash policies: %j', async (policy) => {
    const f = await remoteFixture('collab_resume_end', { completed: null }, true, true, true);
    try {
      await f.controller.updateConfig(policy);
      expect(await f.adapter.observe()).toMatchObject({
        activity: 'crashed',
        stallRestartable: true,
        progressAt: CHILD_NOW - 25_000,
      });
      await f.controller.refresh();
      vi.setSystemTime(CHILD_NOW + 2000);
      await f.controller.refresh();
      vi.setSystemTime(CHILD_NOW + 3000);
      await f.controller.refresh();
      if (!policy.detectStalls) {
        expect(f.deps.restartRemote).toHaveBeenCalledTimes(policy.recoverCrashes ? 1 : 0);
        if (policy.recoverCrashes) expect(f.store.get(f.session.id).inFlight?.reason).toBe('process-crashed');
        expect(f.delivered).not.toHaveBeenCalled();
        return;
      }
      expect(f.deps.restartRemote).not.toHaveBeenCalled();
      vi.setSystemTime(CHILD_NOW + 15_000);
      await f.controller.refresh();
      vi.setSystemTime(CHILD_NOW + 17_000);
      await f.controller.refresh();
      vi.setSystemTime(CHILD_NOW + 18_000);
      await f.controller.refresh();
      expect(f.deps.restartRemote).toHaveBeenCalledOnce();
      expect(f.deps.deliverRemote).not.toHaveBeenCalled();
      expect(f.store.get(f.session.id).inFlight).toMatchObject({
        action: 'restart',
        reason: 'stalled',
        stallProgressAt: CHILD_NOW - 25_000,
      });
      expect(f.delivered).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  });

  it.each([-60_000, 60_000])(
    'preserves native remote progress clock with %i ms skew during stalled dispatch',
    async (offset) => {
      vi.mocked(sampleRemoteCodexClock).mockResolvedValueOnce({
        ...clockAt(),
        remoteBefore: CHILD_NOW + offset,
        remoteAfter: CHILD_NOW + offset,
      });
      const f = await remoteFixture('collab_resume_end', { completed: null }, true, true, true, offset);
      try {
        f.evidence.identity.tail =
          f.evidence.identity
            .tail!.trim()
            .split('\n')
            .map((line) => {
              const row = JSON.parse(line);
              row.timestamp = new Date(Date.parse(row.timestamp) + offset).toISOString();
              return JSON.stringify(row);
            })
            .join('\n') + '\n';
        vi.mocked(f.deps.inspectRemote).mockImplementation(async () => ({
          ...f.evidence,
          clock: { ...clockAt(), remoteBefore: Date.now() + offset, remoteAfter: Date.now() + offset },
        }));
        vi.setSystemTime(CHILD_NOW + 15_000);
        await f.controller.refresh();
        vi.setSystemTime(CHILD_NOW + 17_000);
        await f.controller.refresh();
        vi.setSystemTime(CHILD_NOW + 18_000);
        await f.controller.refresh();
        expect(f.deps.restartRemote).toHaveBeenCalledOnce();
        expect(f.store.get(f.session.id).inFlight?.stallProgressAt).toBe(CHILD_NOW - 25_000);
      } finally {
        await f.cleanup();
      }
    }
  );

  it.each([
    'same-clock',
    'stale-clock',
    'future-clock',
    'changed-pane',
    'new-progress',
    'transport',
    'clean-exit',
    'child-running',
    'authentication',
    'usage-limit',
    'truncated',
    'malformed',
    'owner-stop',
    'unowned',
    'invalid-clock',
  ] as const)('keeps %s from authorizing a remote unfinished-turn stall restart', async (veto) => {
    const f = await remoteFixture('collab_resume_end', { completed: null }, true, true, true);
    try {
      vi.setSystemTime(CHILD_NOW + 15_000);
      await f.controller.refresh();
      vi.setSystemTime(CHILD_NOW + 17_000);
      if (veto === 'same-clock' || veto === 'stale-clock' || veto === 'future-clock') {
        const at = veto === 'same-clock' ? CHILD_NOW + 15_000 : veto === 'stale-clock' ? CHILD_NOW : CHILD_NOW + 20_000;
        vi.mocked(f.deps.inspectRemote).mockImplementation(async () => ({ ...f.evidence, clock: clockAt(at) }));
      }
      if (veto === 'changed-pane') f.evidence.pane!.panePid = 701;
      if (veto === 'new-progress')
        f.evidence.identity.tail += childEvent({ type: 'exec_command_end', call_id: 'later' }, -16_000) + '\n';
      if (veto === 'transport')
        vi.mocked(f.deps.inspectRemote).mockResolvedValue({
          transport: 'unreachable',
          session: 'unknown',
          identity: { reason: 'unverified' },
        } as RemoteCodexEvidence);
      if (veto === 'clean-exit') f.evidence.pane!.status = 0;
      if (veto === 'child-running')
        f.evidence.identity.tail +=
          childEvent({ type: 'collab_resume_end', receiver_thread_id: CHILD_THREAD, status: 'running' }, -16_000) +
          '\n';
      if (veto === 'authentication')
        f.evidence.identity.tail +=
          childEvent(
            {
              type: 'task_complete',
              turn_id: 'current',
              error: { message: 'Authentication required', codex_error_info: 'unauthorized' },
            },
            -16_000
          ) + '\n';
      if (veto === 'usage-limit')
        f.evidence.identity.tail +=
          childEvent({ type: 'turn_aborted', turn_id: 'current', reason: 'budget_limited' }, -16_000) + '\n';
      if (veto === 'truncated') f.evidence.identity.tailTruncated = true;
      if (veto === 'malformed') f.evidence.identity.tail += '{"type":"event_msg","payload":';
      if (veto === 'owner-stop') Object.assign(f.session, { _recoveryIntentionalStopAt: CHILD_NOW + 16_000 });
      if (veto === 'unowned') Object.assign(f.session.remote!, { owned: false });
      if (veto === 'invalid-clock')
        vi.mocked(f.deps.inspectRemote).mockImplementation(async () => ({
          ...f.evidence,
          clock: { ...clockAt(), localAfter: Date.now() - 1 },
        }));
      await f.controller.refresh();
      vi.setSystemTime(CHILD_NOW + 18_000);
      await f.controller.refresh();
      expect(f.deps.restartRemote).not.toHaveBeenCalled();
      expect(f.deps.deliverRemote).not.toHaveBeenCalled();
      expect(f.delivered).not.toHaveBeenCalled();
      expect(f.controller.getStatus().attempts).toBe(0);
    } finally {
      await f.cleanup();
    }
  });

  it.each(['pane', 'progress', 'owner-input', 'grants', 'cancellation'] as const)(
    'rechecks %s immediately before remote stalled dispatch',
    async (veto) => {
      const f = await remoteFixture('collab_resume_end', { completed: null }, true, true, true);
      try {
        const observation = await f.adapter.observe();
        if (veto === 'pane') f.evidence.pane!.panePid = 701;
        if (veto === 'progress')
          f.evidence.identity.tail += childEvent({ type: 'exec_command_end', call_id: 'later' }, 500) + '\n';
        if (veto === 'owner-input') f.session.write('Owner changed intent\r', { fromUser: true });
        if (veto === 'grants')
          vi.mocked(clampExternalCliConfigsForOwner).mockResolvedValueOnce({
            codexConfig: { ...f.session.codexConfig, noDaemon: false },
          });
        expect(
          await f.adapter.act(
            {
              key: observation.stallEvidenceKey!,
              action: 'restart',
              reason: 'stalled',
              conversationId: CHILD_THREAD,
              startedAt: Date.now(),
              stallProgressAt: observation.progressAt,
            },
            () => veto !== 'cancellation'
          )
        ).toBe('not-sent');
        expect(f.deps.restartRemote).not.toHaveBeenCalled();
      } finally {
        await f.cleanup();
      }
    }
  );

  it('seals an uncertain remote stall dispatch against further recovery and journal reload', async () => {
    const f = await remoteFixture('collab_resume_end', { completed: null }, true, true, true);
    try {
      vi.mocked(f.deps.restartRemote).mockResolvedValue('unknown');
      vi.setSystemTime(CHILD_NOW + 15_000);
      await f.controller.refresh();
      vi.setSystemTime(CHILD_NOW + 17_000);
      await f.controller.refresh();
      vi.setSystemTime(CHILD_NOW + 18_000);
      await f.controller.refresh();
      expect(f.store.get(f.session.id)).toMatchObject({
        attempts: 1,
        lastReason: 'acceptance-unverified',
        inFlight: { reason: 'stalled' },
      });
      const restored = new RecoveryController(
        {
          observe: () => f.adapter.observe(),
          act: (flight, current) => f.adapter.act(flight, current),
          persist: (next) => f.store.save(f.session.id, next),
          changed: vi.fn(),
        },
        f.store.get(f.session.id)
      );
      try {
        vi.setSystemTime(CHILD_NOW + 60_000);
        await restored.refresh();
        await restored.retry();
        expect(f.deps.restartRemote).toHaveBeenCalledOnce();
        expect(restored.getStatus().inFlight).toBeDefined();
      } finally {
        restored.stop();
        await restored.drain();
      }
    } finally {
      await f.cleanup();
    }
  });

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
