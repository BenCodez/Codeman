/** @fileoverview Durable acceptance retires only the exact task/recovery reservation without replay. */
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TaskController, type TaskObservation } from '../src/supervision/controller.js';
import { TaskStore } from '../src/supervision/store.js';
import { initialTaskState, type TaskState } from '../src/supervision/schema.js';
import { SessionActionArbiter, sessionActionKey, type SessionActionOwner } from '../src/supervision/action-arbiter.js';
import { RecoveryController } from '../src/recovery/controller.js';
import { RecoveryStore } from '../src/recovery/store.js';
import { CONTINUATION_PROMPT, type RecoveryObservation, type RecoveryState } from '../src/recovery/types.js';
import { createDeferred } from './mocks/index.js';

const conversationId = '11111111-2222-3333-4444-555555555555';
const worker = 'worker';
type Domain = 'task' | 'task-restart' | 'recovery' | 'recovery-restart';
type State = TaskState | RecoveryState;
async function fixture(domain: Domain) {
  const recoveryDomain = domain.startsWith('recovery');
  const dir = await mkdtemp(join(tmpdir(), 'accepted-reservation-'));
  const commonPath = join(dir, 'common.json');
  const taskPath = join(dir, 'task.json');
  const recoveryPath = join(dir, 'recovery.json');
  const commonStore = new TaskStore(commonPath);
  const taskStore = new TaskStore(taskPath);
  const recoveryStore = new RecoveryStore(recoveryPath);
  const owner: SessionActionOwner = recoveryDomain ? 'recovery' : 'task';
  let now = 10000;
  let observation: RecoveryObservation = {
    conversationId,
    activity: 'completed',
    reason: 'turn-completed',
    at: now,
    turnId: 'initial-turn',
    submissionKey: 'old-submission',
    processReady: true,
    safeToAct: false,
  };
  const effect = vi.fn(async () => (domain === 'task-restart' ? 'sent' : 'unknown') as 'sent' | 'unknown');
  const commonPersist = vi.fn(async (key: string | undefined) => {
    const state = initialTaskState();
    if (key) state.inFlight = { key, startedAt: now };
    await commonStore.save(worker, state);
  });
  let arbiter = new SessionActionArbiter(commonPersist);
  const domainPersist = vi.fn(async (state: State) => {
    if (recoveryDomain) await recoveryStore.save(worker, state as RecoveryState);
    else await taskStore.save(worker, state as TaskState);
  });
  const accepted = vi.fn((key: string) => arbiter.accept(owner, key));
  let task: TaskController | undefined;
  let recovery: RecoveryController | undefined;
  const make = (restored?: State) => {
    if (recoveryDomain) {
      recovery = new RecoveryController(
        {
          now: () => now,
          observe: async () => observation,
          persist: domainPersist,
          changed: () => {},
          acceptReservation: accepted,
          act: (flight) => arbiter.run(owner, flight.key, effect),
        },
        restored as RecoveryState | undefined
      );
    } else {
      task = new TaskController(
        {
          now: () => now,
          observe: async () => ({ observation, commands: new Map() }) as TaskObservation,
          persist: domainPersist,
          changed: () => {},
          acceptReservation: accepted,
          act: (key) => arbiter.run(owner, key, effect),
          recover: (o) => arbiter.run(owner, o.evidenceKey!, effect, o.activity === 'crashed'),
        },
        restored as TaskState | undefined
      );
    }
  };
  make();
  if (task) {
    await task.update({
      objective: 'Owner objective',
      criteria: [{ id: 'manual', kind: 'manual', description: 'Owner review' }],
      config: { enabled: true },
    });
    await task.progress({ outcome: 'unfinished', checkpoint: 'Owner checkpoint', nextAction: 'Owner action' });
    if (domain === 'task-restart')
      observation = {
        ...observation,
        activity: 'crashed',
        reason: 'process-crashed',
        at: ++now,
        liveProofAt: 10000,
        safeToAct: true,
        processReady: false,
        evidenceKey: 'task-crash',
      };
    await task.refresh();
  } else {
    observation = {
      ...observation,
      activity: domain === 'recovery-restart' ? 'crashed' : 'interrupted',
      reason: domain === 'recovery-restart' ? 'process-crashed' : 'turn-interrupted',
      at: now,
      safeToAct: true,
      evidenceKey: 'recovery-failure',
    };
    await recovery!.retry();
  }
  const get = (): State => task?.getStatus() ?? recovery!.getStatus();
  const flight = get().inFlight!;
  expect(effect).toHaveBeenCalledOnce();
  expect(commonStore.get(worker).inFlight?.key).toBe(sessionActionKey(owner, flight.key));
  const observeAccepted = (patch: Partial<RecoveryObservation> = {}) => {
    observation = {
      conversationId,
      activity: 'working',
      reason: 'turn-running',
      at: ++now,
      processReady: true,
      processReadyAt: now,
      safeToAct: false,
      submissionKey: 'new-submission',
      submissionHash:
        domain === 'task'
          ? (flight as TaskState['inFlight'])!.promptHash
          : createHash('sha256').update(CONTINUATION_PROMPT).digest('hex'),
      ...patch,
    };
  };
  const reconcile = () =>
    task
      ? task.progress({ outcome: 'unfinished', checkpoint: 'New owner checkpoint', nextAction: 'New owner action' })
      : recovery!.inspect();
  const reloadState = (): State =>
    recoveryDomain ? new RecoveryStore(recoveryPath).get(worker) : new TaskStore(taskPath).get(worker);
  return {
    domainPath: recoveryDomain ? recoveryPath : taskPath,
    owner,
    effect,
    commonPersist,
    domainPersist,
    accepted,
    flight,
    get,
    reconcile,
    reloadState,
    observeAccepted,
    common: () => new TaskStore(commonPath).get(worker),
    run: (actor: SessionActionOwner, key: string, action: () => Promise<'sent' | 'not-sent' | 'unknown'>) =>
      arbiter.run(actor, key, action),
    replaceArbiter: (key?: string) => {
      arbiter = new SessionActionArbiter(commonPersist, key);
    },
    restart: () => {
      task?.stop();
      recovery?.stop();
      make(reloadState());
    },
    clean: async () => {
      task?.stop();
      recovery?.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe('accepted common reservations', () => {
  it('preserves an empty restored reservation as unresolved rather than granting action authority', async () => {
    const persist = vi.fn(async () => {});
    const action = vi.fn(async () => 'sent' as const);
    const arbiter = new SessionActionArbiter(persist, '');
    expect(await arbiter.run('task', 'new-operation', action)).toBe('not-sent');
    expect(await arbiter.accept('task', 'new-operation')).toBe(false);
    expect(persist).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
    await arbiter.reset('task', true);
    expect(await arbiter.run('task', 'new-operation', action)).toBe('sent');
    expect(action).toHaveBeenCalledOnce();
  });

  it('rejects and preserves a malformed journal with an empty common flight key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'empty-reservation-'));
    const path = join(dir, 'common.json');
    const state = initialTaskState();
    state.inFlight = { key: '', startedAt: 1 };
    const corrupt = JSON.stringify({ version: 1, sessions: { [worker]: state } });
    try {
      await writeFile(path, corrupt);
      const store = new TaskStore(path);
      expect(store.loadFailed).toBe(true);
      await expect(store.save(worker, initialTaskState())).rejects.toThrow('could not be loaded');
      expect(await readFile(path, 'utf8')).toBe(corrupt);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(['task', 'task-restart', 'recovery'] as const)(
    'persists %s acceptance before shared release and allows the next owner once',
    async (domain) => {
      const f = await fixture(domain);
      const reached = createDeferred<void>();
      const release = createDeferred<void>();
      const persist = f.domainPersist.getMockImplementation()!;
      f.domainPersist.mockImplementation(async (state) => {
        if (state.inFlight?.accepted) {
          reached.resolve();
          await release.promise;
        }
        await persist(state);
      });
      const next = vi.fn(async () => 'sent' as const);
      try {
        f.observeAccepted();
        const settling = f.reconcile();
        await reached.promise;
        expect(f.common().inFlight?.key).toBe(sessionActionKey(f.owner, f.flight.key));
        expect(f.accepted).not.toHaveBeenCalled();
        expect(await f.run('recovery', 'next', next)).toBe('not-sent');
        release.resolve();
        await settling;
        expect(f.get().inFlight).toBeUndefined();
        expect(f.reloadState().inFlight).toBeUndefined();
        expect(f.common().inFlight).toBeUndefined();
        expect(await f.run('recovery', 'next', next)).toBe('sent');
        expect(next).toHaveBeenCalledOnce();
        expect(f.effect).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        await f.clean();
      }
    }
  );

  it.each(
    ['task', 'task-restart', 'recovery'].flatMap((domain) =>
      [false, true].map((afterWrite) => ({ domain: domain as Domain, afterWrite }))
    )
  )(
    '$domain never releases common ownership after failed acceptance persistence (write landed=$afterWrite)',
    async ({ domain, afterWrite }) => {
      const f = await fixture(domain);
      const persist = f.domainPersist.getMockImplementation()!;
      f.domainPersist.mockImplementation(async (state) => {
        if (state.inFlight?.accepted) {
          if (afterWrite) await persist(state);
          throw new Error('Fixture uncertain acceptance persistence');
        }
        await persist(state);
      });
      try {
        f.observeAccepted();
        await f.reconcile().catch(() => {});
        expect(f.accepted).not.toHaveBeenCalled();
        expect(f.common().inFlight?.key).toBe(sessionActionKey(f.owner, f.flight.key));
        expect(await f.run('recovery', 'next', vi.fn())).toBe('not-sent');
        f.domainPersist.mockImplementation(persist);
        f.restart();
        f.observeAccepted();
        await f.reconcile();
        expect(f.get().inFlight).toBeUndefined();
        expect(f.common().inFlight).toBeUndefined();
        expect(f.effect).toHaveBeenCalledOnce();
      } finally {
        await f.clean();
      }
    }
  );

  it.each(
    ['task', 'task-restart', 'recovery'].flatMap((domain) =>
      [false, true].map((afterWrite) => ({ domain: domain as Domain, afterWrite }))
    )
  )(
    '$domain keeps a replay fence when shared release fails (after durable write=$afterWrite)',
    async ({ domain, afterWrite }) => {
      const f = await fixture(domain);
      const persist = f.commonPersist.getMockImplementation()!;
      f.commonPersist.mockImplementation(async (key) => {
        if (key === undefined) {
          if (afterWrite) await persist(key);
          throw new Error('Fixture uncertain common write');
        }
        await persist(key);
      });
      try {
        f.observeAccepted();
        await f.reconcile().catch(() => {});
        expect(f.reloadState().inFlight).toMatchObject({ key: f.flight.key, accepted: true });
        expect(await f.run('recovery', 'newer', vi.fn())).toBe('not-sent');
        f.commonPersist.mockImplementation(persist);
        f.replaceArbiter(f.common().inFlight?.key);
        f.restart();
        f.observeAccepted({ submissionHash: undefined, submissionKey: 'unrelated-later-submission' });
        await f.reconcile();
        expect(f.get().inFlight).toBeUndefined();
        expect(f.common().inFlight).toBeUndefined();
        expect(f.effect).toHaveBeenCalledOnce();
      } finally {
        await f.clean();
      }
    }
  );

  it.each(
    ['task', 'task-restart', 'recovery'].flatMap((domain) =>
      [false, true].map((afterWrite) => ({ domain: domain as Domain, afterWrite }))
    )
  )(
    '$domain retries accepted cleanup after final domain deletion fails (after durable write=$afterWrite)',
    async ({ domain, afterWrite }) => {
      const f = await fixture(domain);
      const persist = f.domainPersist.getMockImplementation()!;
      f.domainPersist.mockImplementation(async (state) => {
        if (!state.inFlight) {
          if (afterWrite) await persist(state);
          throw new Error('Fixture uncertain domain deletion');
        }
        await persist(state);
      });
      try {
        f.observeAccepted();
        await f.reconcile().catch(() => {});
        expect(f.get().inFlight).toMatchObject({ key: f.flight.key, accepted: true });
        expect(f.common().inFlight).toBeUndefined();
        f.domainPersist.mockImplementation(persist);
        if (!afterWrite) f.restart();
        f.observeAccepted({ submissionHash: undefined, submissionKey: 'later-owner-submission' });
        await f.reconcile();
        expect(f.get().inFlight).toBeUndefined();
        expect(f.reloadState().inFlight).toBeUndefined();
        expect(f.effect).toHaveBeenCalledOnce();
      } finally {
        await f.clean();
      }
    }
  );

  it.each(
    ['recovery', 'recovery-restart'].flatMap((domain) =>
      ['accepted', 'user-input', 'approval-required', 'persistence-failed'].map((reason) => ({
        domain: domain as Domain,
        reason,
      }))
    )
  )('preserves disabled $domain accepted receipt state on reload: $reason', async ({ domain, reason }) => {
    const f = await fixture(domain);
    const accept = f.accepted.getMockImplementation()!;
    // Acceptance is really saved to RecoveryStore, while the exact shared
    // reservation remains durable for a later receipt-only cleanup pass.
    f.accepted.mockResolvedValue(false);
    try {
      f.observeAccepted();
      await f.reconcile();
      const accepted = f.reloadState() as RecoveryState;
      expect(accepted.config.enabled).toBe(false);
      expect(accepted.inFlight).toMatchObject({ key: f.flight.key, accepted: true });
      expect(accepted).toMatchObject({ phase: 'watching', needsAttention: false, lastReason: 'recovery-accepted' });
      if (reason !== 'accepted') {
        accepted.phase = 'paused';
        accepted.needsAttention = true;
        accepted.lastReason = reason as RecoveryState['lastReason'];
        accepted.circuitOpen = reason === 'persistence-failed';
        await f.domainPersist(accepted);
      }
      const expected = {
        phase: accepted.phase,
        needsAttention: accepted.needsAttention,
        lastReason: accepted.lastReason,
        circuitOpen: accepted.circuitOpen,
        lastSuccessfulRecovery: accepted.lastSuccessfulRecovery,
      };
      f.accepted.mockImplementation(accept);
      f.replaceArbiter(f.common().inFlight?.key);
      f.restart();
      expect(f.get()).toMatchObject(expected);
      // No new worker evidence is needed to retire an already accepted receipt,
      // and an unrelated unknown observation cannot fabricate a restart warning.
      f.observeAccepted({
        activity: 'unknown',
        reason: 'identity-unverified',
        processReady: false,
        processReadyAt: undefined,
        submissionKey: undefined,
        submissionHash: undefined,
      });
      await f.reconcile();
      expect(f.get()).toMatchObject(expected);
      expect(f.reloadState()).toMatchObject(expected);
      expect(f.get().inFlight).toBeUndefined();
      expect(f.common().inFlight).toBeUndefined();
      expect(f.effect).toHaveBeenCalledOnce();
    } finally {
      await f.clean();
    }
  });

  it.each(['recovery', 'recovery-restart'] as const)(
    'keeps unaccepted disabled %s uncertain after reload',
    async (domain) => {
      const f = await fixture(domain);
      try {
        f.replaceArbiter(f.common().inFlight?.key);
        f.restart();
        expect(f.get()).toMatchObject({ phase: 'paused', needsAttention: true, lastReason: 'restart-in-flight' });
        f.observeAccepted({
          activity: 'unknown',
          reason: 'identity-unverified',
          processReady: false,
          processReadyAt: undefined,
          submissionKey: undefined,
          submissionHash: undefined,
        });
        await f.reconcile();
        expect(f.get()).toMatchObject({ phase: 'paused', needsAttention: true, lastReason: 'acceptance-unverified' });
        expect(f.get().inFlight?.accepted).toBeUndefined();
        expect(f.common().inFlight).toBeDefined();
        expect(f.accepted).not.toHaveBeenCalled();
        expect(f.effect).toHaveBeenCalledOnce();
      } finally {
        await f.clean();
      }
    }
  );

  it.each(
    ['task', 'task-restart', 'recovery'].flatMap((domain) =>
      ['other-owner', 'newer-operation', 'legacy'].map((mismatch) => ({ domain: domain as Domain, mismatch }))
    )
  )('$domain accepted evidence cannot release a $mismatch reservation', async ({ domain, mismatch }) => {
    const f = await fixture(domain);
    const key =
      mismatch === 'legacy'
        ? `${f.owner}:old-random-uuid`
        : sessionActionKey(
            mismatch === 'other-owner' ? (f.owner === 'task' ? 'recovery' : 'task') : f.owner,
            'newer-operation'
          );
    await f.commonPersist(key);
    f.replaceArbiter(key);
    try {
      f.observeAccepted();
      await f.reconcile();
      expect(f.get().inFlight).toMatchObject({ key: f.flight.key, accepted: true });
      expect(f.common().inFlight?.key).toBe(key);
      const next = vi.fn(async () => 'sent' as const);
      expect(await f.run('task', 'next', next)).toBe('not-sent');
      expect(next).not.toHaveBeenCalled();
      expect(f.effect).toHaveBeenCalledOnce();
    } finally {
      await f.clean();
    }
  });

  it.each(
    ['task', 'recovery'].flatMap((domain) =>
      ['wrong-hash', 'old-submission', 'wrong-conversation'].map((mismatch) => ({ domain: domain as Domain, mismatch }))
    )
  )('$domain uncertain acceptance $mismatch retains exact ownership', async ({ domain, mismatch }) => {
    const f = await fixture(domain);
    try {
      f.observeAccepted(
        mismatch === 'wrong-hash'
          ? { submissionHash: 'wrong-hash' }
          : mismatch === 'old-submission'
            ? { submissionKey: 'old-submission' }
            : { conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }
      );
      await f.reconcile().catch(() => {});
      expect(f.get().inFlight?.accepted).toBeUndefined();
      expect(f.common().inFlight?.key).toBe(sessionActionKey(f.owner, f.flight.key));
      expect(f.accepted).not.toHaveBeenCalled();
      expect(f.effect).toHaveBeenCalledOnce();
    } finally {
      await f.clean();
    }
  });

  it.each(
    ['task-restart', 'recovery-restart'].flatMap((domain) =>
      [
        { name: 'missing stamp', patch: { processReadyAt: undefined } },
        { name: 'stale stamp', patch: { processReadyAt: 0 } },
        { name: 'future stamp', patch: { processReadyAt: 100000 } },
        { name: 'nonfinite stamp', patch: { processReadyAt: NaN } },
        { name: 'unknown activity', patch: { activity: 'unknown' } },
        { name: 'pending child', patch: { activity: 'watching' } },
        { name: 'owner paused', patch: { activity: 'paused' } },
        { name: 'authentication block', patch: { activity: 'blocked' } },
        { name: 'dead pane', patch: { processReady: false } },
        { name: 'changed conversation', patch: { conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } },
      ].map(({ name, patch }) => ({ domain: domain as Domain, name, patch: patch as Partial<RecoveryObservation> }))
    )
  )('$domain refuses incomplete restart acceptance: $name', async ({ domain, patch }) => {
    const f = await fixture(domain);
    try {
      f.observeAccepted(patch);
      await f.reconcile().catch(() => {});
      expect(f.get().inFlight?.accepted).toBeUndefined();
      expect(f.accepted).not.toHaveBeenCalled();
      expect(f.common().inFlight?.key).toBe(sessionActionKey(f.owner, f.flight.key));
      expect(f.effect).toHaveBeenCalledOnce();
    } finally {
      await f.clean();
    }
  });

  it.each(['task-restart', 'recovery-restart'] as const)(
    'accepts %s only from fresh live readiness even when rollout time is historical',
    async (domain) => {
      const f = await fixture(domain);
      try {
        f.observeAccepted({ at: 1 });
        await f.reconcile();
        expect(f.get().inFlight).toBeUndefined();
        expect(f.common().inFlight).toBeUndefined();
        expect(f.effect).toHaveBeenCalledOnce();
      } finally {
        await f.clean();
      }
    }
  );

  it.each(
    ['task', 'task-restart', 'recovery'].flatMap((domain) =>
      [
        'missing acceptedAt',
        'old acceptedAt',
        'missing identity',
        'missing handled key',
        ...(domain === 'task'
          ? ['missing action', 'missing hash', 'missing accepted submission', 'old accepted submission']
          : []),
        ...(domain === 'task-restart' ? ['missing action', 'conflicting prompt hash'] : []),
        ...(domain === 'recovery'
          ? ['missing success time', 'conflicting success time', 'missing accepted event']
          : []),
      ].map((malformed) => ({ domain: domain as Domain, malformed }))
    )
  )('$domain rejects a malformed accepted journal: $malformed', async ({ domain, malformed }) => {
    const f = await fixture(domain);
    const release = createDeferred<void>();
    const reached = createDeferred<void>();
    const persist = f.commonPersist.getMockImplementation()!;
    f.commonPersist.mockImplementation(async (key) => {
      if (!key) {
        reached.resolve();
        await release.promise;
      }
      await persist(key);
    });
    let settling: Promise<State> | undefined;
    try {
      f.observeAccepted();
      settling = f.reconcile();
      await reached.promise;
      const data = JSON.parse(await readFile(f.domainPath, 'utf8'));
      const state = data.sessions[worker];
      const flight = state.inFlight;
      if (malformed === 'missing acceptedAt') delete flight.acceptedAt;
      else if (malformed === 'old acceptedAt') flight.acceptedAt = flight.startedAt - 1;
      else if (malformed === 'missing identity') delete state.conversationId;
      else if (malformed === 'missing handled key') state.handledEvidence = [];
      else if (malformed === 'missing action') delete flight.action;
      else if (malformed === 'missing hash') delete flight.promptHash;
      else if (malformed === 'missing accepted submission') delete state.submissionKey;
      else if (malformed === 'old accepted submission') state.submissionKey = flight.previousSubmissionKey;
      else if (malformed === 'conflicting prompt hash') flight.promptHash = 'a'.repeat(64);
      else if (malformed === 'missing success time') delete state.lastSuccessfulRecovery;
      else if (malformed === 'conflicting success time') state.lastSuccessfulRecovery = flight.acceptedAt + 1;
      else state.history = [];
      const corrupt = JSON.stringify(data);
      await writeFile(f.domainPath, corrupt);
      const store = domain === 'recovery' ? new RecoveryStore(f.domainPath) : new TaskStore(f.domainPath);
      expect(store.loadFailed).toBe(true);
      expect(store.get(worker).config.enabled).toBe(false);
      await expect(store.save(worker, state)).rejects.toThrow('could not be loaded');
      expect(await readFile(f.domainPath, 'utf8')).toBe(corrupt);
      expect(f.common().inFlight?.key).toBe(sessionActionKey(f.owner, f.flight.key));
    } finally {
      release.resolve();
      await settling;
      await f.clean();
    }
  });

  it.each(['common-release', 'domain-deletion'] as const)(
    'retries durable accepted continuation cleanup with no later submission key: %s',
    async (failure) => {
      const f = await fixture('task');
      const commonPersist = f.commonPersist.getMockImplementation()!;
      const domainPersist = f.domainPersist.getMockImplementation()!;
      if (failure === 'common-release')
        f.commonPersist.mockImplementation(async (key) => {
          if (!key) throw new Error('Fixture failed common release');
          await commonPersist(key);
        });
      else
        f.domainPersist.mockImplementation(async (state) => {
          if (!state.inFlight) throw new Error('Fixture failed domain deletion');
          await domainPersist(state);
        });
      try {
        f.observeAccepted();
        await f.reconcile().catch(() => {});
        expect(f.reloadState().inFlight?.accepted).toBe(true);
        f.commonPersist.mockImplementation(commonPersist);
        f.domainPersist.mockImplementation(domainPersist);
        f.replaceArbiter(f.common().inFlight?.key);
        f.restart();
        f.observeAccepted({ submissionKey: undefined, submissionHash: undefined });
        await f.reconcile();
        expect(f.get().inFlight).toBeUndefined();
        expect(f.reloadState().inFlight).toBeUndefined();
        expect(f.common().inFlight).toBeUndefined();
        expect(f.effect).toHaveBeenCalledOnce();
      } finally {
        await f.clean();
      }
    }
  );

  it.each([false, true])('seals reservation failures before any action (write landed=%s)', async (afterWrite) => {
    const dir = await mkdtemp(join(tmpdir(), 'arbiter-reserve-'));
    const path = join(dir, 'common.json');
    const store = new TaskStore(path);
    const arbiter = new SessionActionArbiter(async (key) => {
      if (afterWrite) {
        const state = initialTaskState();
        state.inFlight = { key: key!, startedAt: 1 };
        await store.save(worker, state);
      }
      throw new Error('Fixture uncertain reservation write');
    });
    const action = vi.fn(async () => 'sent' as const);
    try {
      expect(await arbiter.run('task', 'operation', action)).toBe('unknown');
      expect(await arbiter.run('recovery', 'next', action)).toBe('not-sent');
      expect(action).not.toHaveBeenCalled();
      if (afterWrite) expect(new TaskStore(path).get(worker).inFlight?.key).toBe(sessionActionKey('task', 'operation'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('serializes acceptance and owner reset with newer actions while the durable clear is pending', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arbiter-clear-'));
    const path = join(dir, 'common.json');
    const store = new TaskStore(path);
    const release = createDeferred<void>();
    const reached = createDeferred<void>();
    let hold = false;
    const arbiter = new SessionActionArbiter(async (key) => {
      if (!key && hold) {
        reached.resolve();
        await release.promise;
      }
      const state = initialTaskState();
      if (key) state.inFlight = { key, startedAt: 1 };
      await store.save(worker, state);
    });
    const next = vi.fn(async () => 'sent' as const);
    try {
      await arbiter.run('task', 'first', async () => 'unknown');
      hold = true;
      const accepting = arbiter.accept('task', 'first');
      await reached.promise;
      await expect(arbiter.reset('task')).rejects.toThrow('active');
      expect(await arbiter.accept('task', 'first')).toBe(false);
      expect(await arbiter.run('recovery', 'next', next)).toBe('not-sent');
      release.resolve();
      expect(await accepting).toBe(true);
      hold = false;
      expect(await arbiter.run('recovery', 'next', next)).toBe('sent');
      expect(next).toHaveBeenCalledOnce();
      expect(new TaskStore(path).get(worker).inFlight).toBeUndefined();
    } finally {
      release.resolve();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
