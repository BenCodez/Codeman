/** Shared child statuses must veto local stall and remote recovery authority. No process launches. */
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CodexInputBroker, type CodexBrokerState, type CodexBrokerProof } from '../src/recovery/codex-input-broker.js';
import { OwnedRemoteBrokerCache, type OwnedRemoteBrokerScope } from '../src/recovery/remote-input-broker-cache.js';
import type { PrivateFileWitness } from '../src/recovery/private-file-witness.js';
import { buildCodexCommand } from '../src/tmux-manager.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexRecoveryAdapter, type CodexRecoveryAdapterDeps } from '../src/recovery/codex-adapter.js';
import type { RemoteCodexEvidence } from '../src/recovery/remote-codex.js';
import type { Session } from '../src/session.js';
import { RecoveryController } from '../src/recovery/controller.js';
import { initialRecoveryState } from '../src/recovery/types.js';
import { RecoveryStore } from '../src/recovery/store.js';
import { sampleRemoteCodexClock } from '../src/recovery/remote-clock.js';
import { clampExternalCliConfigsForOwner } from '../src/session-env-clamp.js';
import { createDeferred } from './mocks/index.js';
import { updateFakeInputProvenance } from './helpers/codex-input-provenance.js';
import {
  CHILD_NOW,
  CHILD_ID,
  childEvent,
  CHILD_READY,
  CHILD_THREAD,
  createChildLifecycleFixture as createBaseChildLifecycleFixture,
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

function createChildLifecycleFixture(...args: Parameters<typeof createBaseChildLifecycleFixture>) {
  return createBaseChildLifecycleFixture(args[0], args[1], args[2], args[3], { restartStalls: true, ...args[4] });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(CHILD_NOW);
});
afterEach(() => vi.useRealTimers());

describe('actual local stall controller with an abnormally dead owned pane', () => {
  it.each([false, true].flatMap((remote) => [false, true].map((recentStop) => ({ remote, recentStop }))))(
    'does not reclassify an owner-stopped unfinished worker as live silence (SSH=$remote, recent stop=$recentStop)',
    async ({ remote, recentStop }) => {
      const remoteCase = remote
        ? await remoteFixture('collab_resume_end', { completed: null }, true, true, true)
        : undefined;
      const f =
        remoteCase ??
        (await createChildLifecycleFixture(returnedChildTail('collab_resume_end', 'completed'), true, false));
      try {
        if (!remote) expect(f.session.setPaneExit({ at: CHILD_NOW - 1000, status: 9 })).toBe(true);
        expect((await f.adapter.observe()).stallRestartable).toBe(true);
        Object.assign(f.session, { _recoveryIntentionalStopAt: CHILD_NOW - (recentStop ? 500 : 4000) });
        const stopped = await f.adapter.observe();
        expect(stopped).toMatchObject({
          activity: 'crashed',
          reason: 'process-crashed',
          safeToAct: !recentStop,
          stallRestartable: false,
          progressAt: CHILD_NOW - 25_000,
        });
        expect(stopped.stallEvidenceKey).toBeDefined();
        for (const delta of [0, 2000, 15_000, 17_000, 60_000, 62_000]) {
          vi.setSystemTime(CHILD_NOW + delta);
          await f.controller.inspect();
          await f.controller.refresh();
          await f.controller.retry();
        }
        expect(f.controller.getStatus()).toMatchObject({
          activity: 'crashed',
          lastReason: 'process-crashed',
          needsAttention: false,
          attempts: 0,
        });
        expect(f.controller.getStatus().stallAlert).toBeUndefined();
        expect(f.store.get(f.session.id).history.some((event) => event.reason === 'stall-unverified')).toBe(false);
        expect(f.delivered).not.toHaveBeenCalled();
        if (remoteCase) {
          expect(remoteCase.deps.restartRemote).not.toHaveBeenCalled();
          expect(remoteCase.deps.deliverRemote).not.toHaveBeenCalled();
        }
      } finally {
        await f.cleanup();
      }
    }
  );

  it.each([false, true])(
    'withdraws restart consent during the actual adapter final proof without local or SSH effects (SSH=%s)',
    async (remote) => {
      const remoteCase = remote
        ? await remoteFixture('collab_resume_end', { completed: null }, true, true, true)
        : undefined;
      const f =
        remoteCase ??
        (await createChildLifecycleFixture(returnedChildTail('collab_resume_end', 'completed'), true, false));
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const observe = f.adapter.observe.bind(f.adapter);
      let held = false;
      const observation = vi.spyOn(f.adapter, 'observe').mockImplementation(async () => {
        const result = await observe();
        if (f.controller.getStatus().inFlight && !held) {
          held = true;
          entered.resolve();
          await release.promise;
        }
        return result;
      });
      try {
        // A broken fixture must fail here rather than waiting for a dispatch
        // boundary that the production proof correctly refuses to enter.
        expect((await f.adapter.observe()).stallRestartable).toBe(true);
        const first = CHILD_NOW + (remote ? 15_000 : 0);
        vi.setSystemTime(first);
        await f.controller.refresh();
        vi.setSystemTime(first + 2000);
        await f.controller.refresh();
        vi.setSystemTime(first + 3000);
        const action = f.controller.refresh();
        await entered.promise;
        const withdrawing = f.controller.updateConfig({ restartStalls: false });
        release.resolve();
        await action;
        await withdrawing;
        expect(f.delivered).not.toHaveBeenCalled();
        if (remoteCase) {
          expect(remoteCase.deps.restartRemote).not.toHaveBeenCalled();
          expect(remoteCase.deps.deliverRemote).not.toHaveBeenCalled();
        }
        expect(f.controller.getStatus()).toMatchObject({ attempts: 0, config: { restartStalls: false } });
        expect(f.controller.getStatus().inFlight).toBeUndefined();
      } finally {
        release.resolve();
        observation.mockRestore();
        await f.cleanup();
      }
    }
  );
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

  it.each([false, true])(
    'never mixes native PIDs and requires an explicitly owned replacement proof before fresh confirmation (owned=%s)',
    async (owned) => {
      const f = await createChildLifecycleFixture(returnedChildTail('collab_resume_end', 'completed'), true, true);
      try {
        const original = await f.session.inspectRecoveryPane();
        expect(original?.inputProvenance?.brokerPid).toBe(700);
        await f.controller.refresh();
        vi.setSystemTime(CHILD_NOW + 2000);
        let proof = original!.inputProvenance!;
        if (owned) {
          // Provision only private fixture files, never execute the helper or
          // child. A distinct owned incarnation must have its own config,
          // journal, registered PID and cached signer; two reads cannot adopt it.
          const home = f.session.getRecoveryContext().codexHome!;
          const broker = await CodexInputBroker.create(
            join(home, 'replacement-brokers'),
            f.session.id,
            buildCodexCommand(f.session.codexConfig),
            home
          );
          const config = JSON.parse(await fs.readFile(join(broker.directory, 'config.json'), 'utf8'));
          await fs.writeFile(
            join(broker.directory, 'state.json'),
            JSON.stringify({
              version: 1,
              sessionId: f.session.id,
              incarnation: broker.incarnation,
              pid: 701,
              childPid: 702,
              brokerStart: '123',
              childStart: '124',
              tainted: false,
              rawGeneration: 0,
              launchDigest: config.launchDigest,
              homeDigest: config.homeDigest,
              closed: true,
              exitStatus: 9,
              exitSignal: null,
              counters: { 'owner-pty': 0, 'owner-key': 0, 'owner-mux': 0, auto: 0, probe: 0 },
              receipts: [],
              startup: { nonce: config.startup.nonce, status: 'started' },
            }),
            { mode: 0o600 }
          );
          proof = (await broker.prove(701))!;
          expect(proof).toBeDefined();
          expect(proof.incarnation).not.toBe(original!.inputProvenance!.incarnation);
          Object.assign(Reflect.get(f.session, '_muxSession'), { pid: 701, recoveryInputBroker: broker.incarnation });
          const mux = Reflect.get(f.session, '_mux');
          vi.spyOn(mux, 'inspectCodexInputProvenance').mockImplementation(async (_id: string, pid: number) =>
            broker.prove(pid)
          );
          vi.spyOn(mux, 'getCodexInputAuthority').mockImplementation((id: string, current: typeof proof) =>
            id === f.session.id ? broker.authority(current) : undefined
          );
        }
        vi.spyOn(f.session, 'inspectRecoveryPane').mockResolvedValue({
          dead: true,
          status: 9,
          screen: null,
          paneId: '%7',
          panePid: 701,
          inputProvenance: proof,
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
        expect(f.delivered).toHaveBeenCalledTimes(owned ? 1 : 0);
        if (!owned)
          expect(await f.adapter.observe()).toMatchObject({
            activity: 'unknown',
            reason: 'pane-unverified',
            safeToAct: false,
          });
      } finally {
        await f.cleanup();
      }
    }
  );
  it.each(REACTIVATIONS.flatMap((type) => [false, true].map((storedExit) => ({ type, storedExit }))))(
    'never restarts a resumed child after two quiet-time probes ($type, watcher exit=$storedExit)',
    async ({ type, storedExit }) => {
      const f = await createChildLifecycleFixture(returnedChildTail(type), true, storedExit);
      try {
        expect(!!f.session.paneExit).toBe(storedExit);
        expect(f.controller.getStatus().config).toMatchObject({
          detectStalls: true,
          restartStalls: true,
          stalledAfterMs: 10_000,
        });
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
    { detectStalls: true, restartStalls: true, recoverCrashes: false },
    { detectStalls: true, restartStalls: true, recoverCrashes: true },
    { detectStalls: true, restartStalls: false, recoverCrashes: true },
    { detectStalls: true, restartStalls: false, recoverCrashes: false },
    { detectStalls: false, restartStalls: true, recoverCrashes: true },
    { detectStalls: false, restartStalls: true, recoverCrashes: false },
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
      expect(f.controller.getStatus().activity).toBe(
        policy.detectStalls && (policy.restartStalls || !policy.recoverCrashes) ? 'working' : 'crashed'
      );
      await f.controller.refresh();
      vi.setSystemTime(CHILD_NOW + 2000);
      await f.controller.refresh();
      vi.setSystemTime(CHILD_NOW + 3000);
      await f.controller.refresh();
      if (!policy.detectStalls || !policy.restartStalls) {
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
          const current = await f.session.inspectRecoveryPane();
          const cleanProof = updateFakeInputProvenance(current!.inputProvenance!, { closed: true, exitStatus: 0 });
          vi.spyOn(f.session, 'inspectRecoveryPane').mockResolvedValue({
            dead: true,
            status: 0,
            screen: null,
            paneId: '%7',
            panePid: 700,
            inputProvenance: cleanProof,
          });
          f.session.setPaneExit({ at: CHILD_NOW - 1000, status: 0 });
          expect(await f.adapter.observe()).toMatchObject({
            activity: 'exited',
            reason: 'clean-exit',
            safeToAct: false,
          });
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
  // The real async owner path persists its pending identity before sampling
  // the exclusively fake SSH clock and delivering bytes to the fake PTY.
  // Legacy provenance opponents model an unavailable sample, rather than
  // bypassing the same durable admission used by a healthy owner submission.
  if (!preparedClock) vi.mocked(sampleRemoteCodexClock).mockResolvedValueOnce(undefined);
  expect(await f.session.writeAsync('Sanitized fixture request\r', { fromUser: true })).toBe(true);
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
  // The remote worker is explicitly launch-owned. Use the real private cache,
  // parser and retained signer while all worker/native/SSH effects stay fake.
  const scope: OwnedRemoteBrokerScope = {
    sessionId: f.session.id,
    remote,
    workingDir: remote.remotePath,
    codexHome: f.session.getRecoveryContext().codexHome!,
    owner: f.session.owner,
  };
  const cache = new OwnedRemoteBrokerCache(join(scope.codexHome, 'fixture-remote-cache'));
  const record = Reflect.get(f.session, '_muxSession');
  const mux = Reflect.get(f.session, '_mux');
  let descriptor: NonNullable<Awaited<ReturnType<typeof cache.prepare>>>;
  let registeredPid = 700;
  let launch = 0;
  let latestProof: CodexBrokerProof | undefined;
  const rotateBroker = async (pid: number) => {
    const material = CodexInputBroker.provisioningMaterial(
      f.session.id,
      buildCodexCommand(f.session.codexConfig),
      scope.codexHome
    );
    const directory = `/fixture/private-brokers/${f.session.id}/${material.config.incarnation}`;
    const next = await cache.prepare(scope, material, directory);
    expect(next).toBeDefined();
    expect(cache.activate(scope, next!.incarnation)).toBe(true);
    descriptor = next!;
    registeredPid = pid;
    launch++;
    latestProof = undefined;
    Object.assign(record, { remote, recoveryInputBroker: descriptor.incarnation });
  };
  await rotateBroker(registeredPid);
  Object.assign(mux, {
    getOwnedRemoteInputBroker: vi.fn(async (id: string) =>
      id === f.session.id ? cache.get(scope, descriptor.incarnation) : undefined
    ),
    observeOwnedRemoteInputBroker: vi.fn((id: string, serialized: string, witness: PrivateFileWitness, pid: number) => {
      latestProof =
        id === f.session.id ? cache.observe(scope, descriptor.incarnation, serialized, witness, pid) : undefined;
      return latestProof;
    }),
    isOwnedRemoteInputBrokerProofCurrent: vi.fn(
      (id: string, proof: CodexBrokerProof) =>
        id === f.session.id &&
        proof === latestProof &&
        record.recoveryInputBroker === proof.incarnation &&
        cache.signer(scope, descriptor.incarnation)?.authority(proof)?.proof === proof
    ),
  });
  let explicitBroker = false;
  let brokerOverride: unknown;
  Object.defineProperty(evidence, 'inputBroker', {
    enumerable: true,
    configurable: true,
    get: () => {
      if (explicitBroker) return brokerOverride;
      const closed = evidence.pane?.dead === true;
      const state: CodexBrokerState = {
        version: 1,
        sessionId: f.session.id,
        incarnation: descriptor.incarnation,
        pid: registeredPid,
        childPid: registeredPid + 1,
        brokerStart: String(900 + launch * 10),
        childStart: String(901 + launch * 10),
        tainted: false,
        rawGeneration: 0,
        launchDigest: descriptor.launchDigest,
        homeDigest: descriptor.homeDigest,
        closed,
        exitStatus: closed ? 9 : null,
        exitSignal: null,
        counters: { 'owner-pty': 0, 'owner-key': 0, 'owner-mux': 0, auto: 0, probe: 0 },
        receipts: [],
        startup: { nonce: descriptor.startupNonce, status: 'started' },
      };
      const serialized = JSON.stringify(state);
      return {
        serialized,
        witness: {
          path: descriptor.directory + '/state.json',
          dev: 1,
          ino: launch,
          size: Buffer.byteLength(serialized),
          mtimeMs: CHILD_NOW,
          ctimeMs: CHILD_NOW,
          hash: createHash('sha256').update(serialized).digest('hex'),
          maxBytes: 98_304,
        },
      };
    },
    set: (value: unknown) => {
      explicitBroker = true;
      brokerOverride = value;
    },
  });
  const deps: CodexRecoveryAdapterDeps = {
    inspectRemote: vi.fn(async () => ({ ...evidence, clock: clockAt() })),
    restartRemote: vi.fn(async () => 'sent'),
    deliverRemote: vi.fn(async () => ({ status: 'sent', submittedAt: Date.now(), clock: clockAt() })),
  };
  const adapter = new CodexRecoveryAdapter(f.session, vi.fn(), deps);
  if (preparedClock && offset === 0) {
    // Negative cases must reach their named lifecycle or stall veto, rather
    // than pass vacuously because their fake private ownership is incomplete.
    const initial = await adapter.observe();
    expect(initial.reason).not.toBe('identity-unverified');
    if (status === 'running') expect(initial).toMatchObject({ activity: 'watching', reason: 'background-work' });
    else if (unfinished)
      expect(initial).toMatchObject(
        dead ? { stallRestartable: true } : { activity: 'working', reason: 'turn-running' }
      );
    else expect(initial.safeToAct).toBe(true);
  }
  const state = initialRecoveryState();
  state.config = {
    ...state.config,
    enabled: true,
    detectStalls: true,
    restartStalls: true,
    stalledAfterMs: 40_000,
    retryDelayMs: 1000,
  };
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
    rotateBroker,
    controller,
    async cleanup() {
      controller.stop();
      await controller.drain();
      await f.cleanup();
    },
  };
}

function setRemoteBrokerCleanExit(evidence: RemoteCodexEvidence) {
  const original = evidence.inputBroker!;
  const state = JSON.parse(original.serialized) as CodexBrokerState;
  Object.assign(state, { closed: true, exitStatus: 0, exitSignal: null });
  const serialized = JSON.stringify(state);
  evidence.inputBroker = {
    ...original,
    serialized,
    witness: {
      ...original.witness,
      size: Buffer.byteLength(serialized),
      hash: createHash('sha256').update(serialized).digest('hex'),
    },
  };
}

describe('actual remote adapter uses the same child lifecycle veto', () => {
  it.each(['initial-observation', 'scheduled-recheck'] as const)(
    'does not charge a remote stall restart after a clean broker child exit at %s',
    async (stage) => {
      const f = await remoteFixture('collab_resume_end', { completed: null }, true, true, true);
      try {
        // The fixture first proves that this exact owned broker and abnormal
        // outer pane qualify. Only the private child exit changes below.
        expect(f.evidence.pane).toMatchObject({ dead: true, status: 9 });
        if (stage === 'scheduled-recheck') {
          vi.setSystemTime(CHILD_NOW + 15_000);
          await f.controller.refresh();
          vi.setSystemTime(CHILD_NOW + 17_000);
          await f.controller.refresh();
          expect(f.controller.getStatus().pending).toMatchObject({ reason: 'stalled' });
          expect(f.controller.getStatus().attempts).toBe(0);
        }
        setRemoteBrokerCleanExit(f.evidence);
        const clean = await f.adapter.observe();
        expect(clean).toMatchObject({ activity: 'exited', reason: 'clean-exit', safeToAct: false });
        expect(clean.stallRestartable).toBeUndefined();
        for (const elapsed of [18_000, 20_000, 21_000]) {
          vi.setSystemTime(CHILD_NOW + elapsed);
          await f.controller.refresh();
        }
        expect(f.controller.getStatus()).toMatchObject({ attempts: 0, lastReason: 'clean-exit' });
        expect(f.controller.getStatus().pending).toBeUndefined();
        expect(f.controller.getStatus().nextRetryAt).toBeUndefined();
        expect(f.controller.getStatus().inFlight).toBeUndefined();
        expect(f.store.get(f.session.id).attempts).toBe(0);
        expect(f.deps.restartRemote).not.toHaveBeenCalled();
        expect(f.deps.deliverRemote).not.toHaveBeenCalled();
        expect(f.delivered).not.toHaveBeenCalled();
      } finally {
        await f.cleanup();
      }
    }
  );

  it.each(['missing', 'malformed', 'tainted', 'incomplete-head', 'wrong-incarnation'] as const)(
    'preserves an explicitly %s remote broker override as non-actionable',
    async (fault) => {
      const f = await remoteFixture('collab_resume_end', { completed: null }, true, true, true);
      try {
        vi.setSystemTime(CHILD_NOW + 15_000);
        const baseline = await f.adapter.observe();
        expect(baseline.stallRestartable).toBe(true);
        const original = f.evidence.inputBroker!;
        const state = JSON.parse(original.serialized) as CodexBrokerState;
        if (fault === 'tainted') Object.assign(state, { tainted: true, rawGeneration: 1 });
        if (fault === 'incomplete-head') state.counters.auto = 1;
        if (fault === 'wrong-incarnation') state.incarnation = CHILD_ID;
        const serialized = fault === 'malformed' ? '{truncated' : JSON.stringify(state);
        const override =
          fault === 'missing'
            ? undefined
            : {
                ...original,
                serialized,
                witness: {
                  ...original.witness,
                  size: Buffer.byteLength(serialized),
                  hash: createHash('sha256').update(serialized).digest('hex'),
                },
              };
        f.evidence.inputBroker = override;
        expect(f.evidence.inputBroker).toBe(override);
        expect(await f.adapter.observe()).toMatchObject({
          activity: 'unknown',
          reason: 'identity-unverified',
          safeToAct: false,
        });
        expect(f.adapter.getVerifiedTail(CHILD_THREAD)).toBeUndefined();
        expect(
          await f.adapter.act({
            key: baseline.stallEvidenceKey!,
            action: 'restart',
            reason: 'stalled',
            conversationId: CHILD_THREAD,
            startedAt: Date.now(),
            stallProgressAt: baseline.progressAt,
            stallProgressEvidenceKey: baseline.progressEvidenceKey,
            stallQuietPeriodMs: 40_000,
          })
        ).toBe('not-sent');
        expect(f.deps.restartRemote).not.toHaveBeenCalled();
        expect(f.deps.deliverRemote).not.toHaveBeenCalled();
        expect(f.delivered).not.toHaveBeenCalled();
      } finally {
        await f.cleanup();
      }
    }
  );
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
        await f.rotateBroker(701);
        vi.setSystemTime(CHILD_NOW + 19_100);
        await f.controller.refresh();
        expect(f.store.get(f.session.id).inFlight).toBeUndefined();
        expect(f.store.get(f.session.id).handledEvidence[0]).toMatch(
          /^stall:[a-f0-9]{64}:remote:[a-f0-9]{64}:[1-9]\d*$/
        );
        if (legacyNumeric) {
          const state = f.store.get(f.session.id);
          state.handledEvidence = state.handledEvidence.map((key) =>
            key.replace(/remote:[a-f0-9]{64}:[1-9]\d*$/, String(CHILD_NOW - 25_000 + 20))
          );
          expect(state.handledEvidence[0]).toMatch(/^stall:[a-f0-9]{64}:[1-9]\d*$/);
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
    { detectStalls: true, restartStalls: true, recoverCrashes: false },
    { detectStalls: true, restartStalls: true, recoverCrashes: true },
    { detectStalls: true, restartStalls: false, recoverCrashes: true },
    { detectStalls: true, restartStalls: false, recoverCrashes: false },
    { detectStalls: false, restartStalls: true, recoverCrashes: true },
    { detectStalls: false, restartStalls: true, recoverCrashes: false },
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
      if (!policy.detectStalls || !policy.restartStalls) {
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
              // These timestamps are native to the same remote host as the row.
              for (const key of ['started_at_ms', 'completed_at_ms', 'occurred_at_ms']) {
                if (Number.isSafeInteger(row.payload[key])) row.payload[key] += offset;
              }
              return JSON.stringify(row);
            })
            .join('\n') + '\n';
        vi.mocked(f.deps.inspectRemote).mockImplementation(async () => ({
          ...f.evidence,
          clock: { ...clockAt(), remoteBefore: Date.now() + offset, remoteAfter: Date.now() + offset },
        }));
        expect((await f.adapter.observe()).stallRestartable).toBe(true);
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
        f.evidence.identity.tail +=
          childEvent({ type: 'agent_message', message: 'Fresh structured remote work before dispatch' }, -16_000) +
          '\n';
      if (veto === 'transport')
        vi.mocked(f.deps.inspectRemote).mockResolvedValue({
          transport: 'unreachable',
          session: 'unknown',
          identity: { reason: 'unverified' },
        } as RemoteCodexEvidence);
      if (veto === 'clean-exit') f.evidence.pane!.status = 0;
      if (veto === 'child-running')
        f.evidence.identity.tail +=
          childEvent({ type: 'collab_resume_end', receiver_thread_id: CHILD_ID, status: 'running' }, -16_000) + '\n';
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

  it.each([
    'unchanged',
    'pane',
    'progress',
    'clean-broker-exit',
    'child-running',
    'owner-input',
    'grants',
    'cancellation',
  ] as const)('rechecks %s immediately before remote stalled dispatch', async (veto) => {
    const f = await remoteFixture('collab_resume_end', { completed: null }, true, true, true);
    try {
      vi.setSystemTime(CHILD_NOW + 15_000);
      const observation = await f.adapter.observe();
      expect(observation.stallRestartable).toBe(true);
      if (veto === 'pane') f.evidence.pane!.panePid = 701;
      if (veto === 'clean-broker-exit') setRemoteBrokerCleanExit(f.evidence);
      if (veto === 'child-running')
        f.evidence.identity.tail +=
          childEvent({ type: 'collab_resume_end', receiver_thread_id: CHILD_ID, status: 'running' }, 500) + '\n';
      if (veto === 'progress')
        f.evidence.identity.tail +=
          childEvent({ type: 'agent_message', message: 'Fresh structured remote work before dispatch' }, 500) + '\n';
      if (veto === 'owner-input')
        expect(await f.session.writeAsync('Owner changed intent\r', { fromUser: true })).toBe(true);
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
            stallProgressEvidenceKey: observation.progressEvidenceKey,
            stallQuietPeriodMs: 40_000,
          },
          () => veto !== 'cancellation'
        )
      ).toBe(veto === 'unchanged' ? 'sent' : 'not-sent');
      expect(f.deps.restartRemote).toHaveBeenCalledTimes(veto === 'unchanged' ? 1 : 0);
    } finally {
      await f.cleanup();
    }
  });

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

it.each([false, true].flatMap((remote) => [false, true].map((dead) => ({ remote, dead }))))(
  'raises durable attention without any restart consent for actual owned silence (SSH=$remote dead=$dead)',
  async ({ remote, dead }) => {
    const remoteCase = remote
      ? await remoteFixture('collab_resume_end', { completed: null }, dead, true, true)
      : undefined;
    const f =
      remoteCase ??
      (await createChildLifecycleFixture(returnedChildTail('collab_resume_end', 'completed'), dead, false));
    let reloaded: RecoveryController | undefined;
    try {
      if (!remote && dead) expect(f.session.setPaneExit({ at: CHILD_NOW - 1000, status: 9 })).toBe(true);
      await f.controller.updateConfig({
        detectStalls: true,
        restartStalls: false,
        recoverCrashes: false,
        stalledAfterMs: 10_000,
      });
      const observed = await f.adapter.observe();
      expect(observed).toMatchObject(
        dead
          ? { activity: 'crashed', reason: 'process-crashed', stallRestartable: true }
          : { activity: 'working', reason: 'turn-running' }
      );
      expect(observed.stallEvidenceKey).toBeDefined();
      await f.controller.inspect(); // reads never supply an action/attention confirmation
      await f.controller.refresh();
      vi.setSystemTime(CHILD_NOW + 1999);
      await f.controller.refresh();
      expect(f.controller.getStatus().stallAlert).toBeUndefined();
      vi.setSystemTime(CHILD_NOW + 2000);
      await f.controller.refresh();
      const status = f.controller.getStatus();
      expect(status).toMatchObject({
        phase: 'paused',
        needsAttention: true,
        lastReason: 'stall-unverified',
        attempts: 0,
        config: { detectStalls: true, restartStalls: false, recoverCrashes: false },
        stallAlert: { key: observed.stallEvidenceKey, conversationId: observed.conversationId },
      });
      expect(status.pending).toBeUndefined();
      expect(status.inFlight).toBeUndefined();
      const stored = new RecoveryStore(Reflect.get(f.store, 'path')).get(f.session.id);
      expect(stored.stallAlert).toEqual(status.stallAlert);
      expect(stored.history.filter((event) => event.kind === 'attention')).toHaveLength(1);
      f.controller.stop();
      await f.controller.drain();
      reloaded = new RecoveryController(Reflect.get(f.controller, 'deps'), stored);
      for (const delta of [4000, 6000]) {
        vi.setSystemTime(CHILD_NOW + delta);
        await reloaded.inspect();
        await reloaded.refresh();
        await reloaded.retry();
        expect(reloaded.getStatus()).toMatchObject({
          needsAttention: true,
          lastReason: 'stall-unverified',
          attempts: 0,
        });
        expect(reloaded.getStatus().pending).toBeUndefined();
        expect(reloaded.getStatus().inFlight).toBeUndefined();
      }
      expect(reloaded.getStatus().history.filter((event) => event.kind === 'attention')).toHaveLength(1);
      expect(f.delivered).not.toHaveBeenCalled();
      if (remoteCase) {
        expect(remoteCase.deps.restartRemote).not.toHaveBeenCalled();
        expect(remoteCase.deps.deliverRemote).not.toHaveBeenCalled();
      }
    } finally {
      reloaded?.stop();
      await reloaded?.drain();
      await f.cleanup();
    }
  }
);
