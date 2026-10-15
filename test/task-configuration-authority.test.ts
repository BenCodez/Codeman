/** Guarded task configuration uses disposable journals and no worker/process effects. */
import { afterEach, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { renameSync } from 'node:fs';
import { mkdtemp, open, readFile, readdir, rename, rm, unlink } from 'node:fs/promises';
import { TaskConfigurationCancelledError, TaskController } from '../src/supervision/controller.js';
import { TaskStore, type TaskSaveAuthority } from '../src/supervision/store.js';
import { initialTaskState, type TaskState, type TaskUpdate } from '../src/supervision/schema.js';
import { commandHash, type CommandSuccessEvidence } from '../src/supervision/evidence.js';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: vi.fn(fs.open), unlink: vi.fn(fs.unlink), rename: vi.fn(fs.rename) };
});
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});
afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});
const SID = 'guarded-worker';
const patch: TaskUpdate = {
  objective: 'The manager replacement task',
  criteria: [{ id: 'replacement', kind: 'manual', description: 'New acceptance' }],
  config: { enabled: false, maxContinuations: 1, maxRuntimeMs: 60_000 },
};
function priorState(): TaskState {
  return {
    ...initialTaskState(),
    objective: 'The original owner task',
    criteria: [
      { id: 'owner', kind: 'manual', description: 'Owner acceptance', verified: false },
      {
        id: 'done',
        kind: 'manual',
        description: 'Verified earlier',
        verified: true,
        evidence: { source: 'owner', at: 5_000 },
      },
    ],
    checkpoint: 'Preserve this checkpoint',
    nextAction: 'Owner review next',
    configuredAt: 4_000,
    lastProgressAt: 5_000,
    continuations: 2,
    handledEvidence: ['prior-delivered-step'],
    history: [{ at: 5_000, reason: 'progress-recorded' }],
  };
}
async function fixture() {
  const root = await mkdtemp(join(homedir(), 'task-config-authority-'));
  const path = join(root, 'tasks.json');
  const store = new TaskStore(path);
  await store.save(SID, priorState());
  const act = vi.fn(async () => 'sent' as const);
  let now = 10_000;
  const commands = new Map<string, CommandSuccessEvidence>();
  const persisted: TaskState[] = [];
  const task = new TaskController(
    {
      now: () => now,
      observe: async () => ({
        observation: {
          activity: 'idle',
          reason: 'observing',
          at: now,
          conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          processReady: true,
          safeToAct: false,
        },
        commands,
      }),
      act,
      persist: async (state, authority?: TaskSaveAuthority) => {
        await store.save(SID, state, authority);
        persisted.push(structuredClone(state));
      },
      changed: vi.fn(),
    },
    store.get(SID)
  );
  return {
    root,
    path,
    store,
    task,
    act,
    persisted,
    commands,
    clock: (at: number) => (now = at),
    cleanup: async () => {
      task.stop();
      await task.drain();
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function holdTemporarySync(path: string, phase: 'write' | 'sync' | 'close' = 'sync') {
  const nativeOpen = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open;
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  let intercepted = false;
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await nativeOpen(...args);
    if (intercepted || typeof args[0] !== 'string' || !args[0].startsWith(path + '.') || !args[0].endsWith('.tmp'))
      return handle;
    intercepted = true;
    return {
      writeFile: async (...input: Parameters<typeof handle.writeFile>) => {
        if (phase === 'write') {
          entered();
          await gate;
        }
        await handle.writeFile(...input);
      },
      close: async () => {
        if (phase === 'close') {
          entered();
          await gate;
        }
        await handle.close();
      },
      sync: async () => {
        if (phase === 'sync') {
          entered();
          await gate;
        }
        await handle.sync();
      },
    } as unknown as typeof handle;
  });
  return { held, release };
}

it.each(
  (['write', 'sync', 'close'] as const).flatMap((phase) =>
    (['external-pause', 'worker-pause', 'worker-input', 'worker-edit', 'worker-reset', 'worker-stop'] as const).map(
      (cancel) => ({ phase, cancel })
    )
  )
)('preserves owner task data when $cancel revokes configuration during temporary $phase', async ({ cancel, phase }) => {
  const f = await fixture();
  const before = f.task.getStatus();
  const originalBytes = await readFile(f.path, 'utf8');
  const barrier = await holdTemporarySync(f.path, phase);
  let current = true;
  const updating = f.task.update(patch, () => current);
  const result = updating.then(
    () => undefined,
    (error: unknown) => error
  );
  let ownerMutation: Promise<TaskState> | undefined;
  try {
    await barrier.held;
    expect(f.store.getBrokerCleanupState()).toBeUndefined();
    expect(await readFile(f.path, 'utf8')).toBe(originalBytes);
    if (cancel === 'external-pause') current = false;
    if (cancel === 'worker-pause') ownerMutation = f.task.pause();
    if (cancel === 'worker-input') f.task.noteUserInput();
    if (cancel === 'worker-edit')
      ownerMutation = f.task.update({ objective: 'New owner objective', config: { maxContinuations: 4 } });
    if (cancel === 'worker-reset') ownerMutation = f.task.reset();
    if (cancel === 'worker-stop') f.task.stop();
    barrier.release();
    expect(await result).toBeInstanceOf(TaskConfigurationCancelledError);
    await ownerMutation;
    await f.task.drain();
    const state = f.task.getStatus();
    if (cancel === 'worker-reset')
      expect(state).toMatchObject({ objective: before.objective, checkpoint: '', reason: 'owner-reset' });
    else if (cancel === 'worker-edit')
      expect(state).toMatchObject({ objective: 'New owner objective', config: { maxContinuations: 4 } });
    else
      expect(state).toMatchObject({
        objective: before.objective,
        criteria: before.criteria,
        checkpoint: before.checkpoint,
        nextAction: before.nextAction,
        continuations: before.continuations,
        handledEvidence: before.handledEvidence,
      });
    expect(f.store.get(SID)).toEqual(new TaskStore(f.path).get(SID));
    expect(f.store.getBrokerCleanupState()).toEqual(new TaskStore(f.path).getBrokerCleanupState());
    expect(f.store.get(SID).objective).toBe(state.objective);
    if (cancel === 'external-pause' || cancel === 'worker-stop') {
      expect(state).toEqual(before);
      expect(await readFile(f.path, 'utf8')).toBe(originalBytes);
    }
    expect(await readdir(f.root)).toEqual(['tasks.json']);
    expect(f.persisted.some((state) => state.objective === patch.objective)).toBe(false);
    expect(f.act).not.toHaveBeenCalled();
  } finally {
    barrier.release();
    await result;
    await ownerMutation;
    await f.cleanup();
  }
});

it('commits an authorized staged replacement to the live controller and fresh journal reader', async () => {
  const f = await fixture();
  const before = f.task.getStatus();
  const barrier = await holdTemporarySync(f.path);
  const updating = f.task.update(patch, () => true);
  try {
    await barrier.held;
    expect(f.task.getStatus()).toEqual(before);
    barrier.release();
    const state = await updating;
    expect(state).toMatchObject({
      objective: patch.objective,
      criteria: [{ id: 'replacement', verified: false }],
      checkpoint: '',
      nextAction: '',
      config: { enabled: false, maxContinuations: 1 },
    });
    expect(f.store.get(SID)).toEqual(state);
    expect(new TaskStore(f.path).get(SID)).toEqual(state);
    expect(f.act).not.toHaveBeenCalled();
  } finally {
    barrier.release();
    await updating.catch(() => {});
    await f.cleanup();
  }
});

it('rechecks delegated authority after waiting behind a different journal write', async () => {
  const f = await fixture();
  const before = f.task.getStatus();
  const barrier = await holdTemporarySync(f.path);
  let current = true;
  const predecessor = f.store.save('another-worker', initialTaskState());
  const updating = f.task.update(patch, () => current);
  const result = updating.then(
    () => undefined,
    (error: unknown) => error
  );
  try {
    await barrier.held;
    current = false;
    barrier.release();
    await predecessor;
    expect(await result).toBeInstanceOf(TaskConfigurationCancelledError);
    expect(f.task.getStatus()).toEqual(before);
    expect(f.store.get(SID)).toEqual(before);
    expect(new TaskStore(f.path).get(SID)).toEqual(before);
    expect(f.persisted).toEqual([]);
    expect(f.store.getBrokerCleanupState()).toEqual(new TaskStore(f.path).getBrokerCleanupState());
  } finally {
    barrier.release();
    await predecessor;
    await result;
    await f.cleanup();
  }
});

async function holdDirectorySync(path: string, fail = false) {
  const nativeOpen = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open;
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  let intercepted = false;
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await nativeOpen(...args);
    if (intercepted || args[0] !== path) return handle;
    intercepted = true;
    return {
      close: handle.close.bind(handle),
      sync: async () => {
        entered();
        await gate;
        if (fail) throw new Error('Fixture directory sync failed');
        await handle.sync();
      },
    } as unknown as typeof handle;
  });
  return { held, release };
}

it('retains an authorized commit when owner pause follows pathname replacement during directory sync', async () => {
  const f = await fixture();
  const barrier = await holdDirectorySync(f.root);
  const updating = f.task.update(patch, () => true);
  let pausing: Promise<TaskState> | undefined;
  try {
    await barrier.held;
    expect(f.task.getStatus().objective).toBe(patch.objective);
    expect(new TaskStore(f.path).get(SID).objective).toBe(patch.objective);
    pausing = f.task.pause();
    barrier.release();
    await updating;
    await pausing;
    expect(f.task.getStatus()).toMatchObject({ objective: patch.objective, phase: 'paused', reason: 'owner-paused' });
    expect(new TaskStore(f.path).get(SID)).toEqual(f.task.getStatus());
    expect(f.act).not.toHaveBeenCalled();
  } finally {
    barrier.release();
    await updating.catch(() => {});
    await pausing;
    await f.cleanup();
  }
});

it.each([false, true])(
  'seals a post-rename durability failure for enabled=%s and refuses fresh kickoff or journal cleanup',
  async (enabled) => {
    const f = await fixture();
    const barrier = await holdDirectorySync(f.root, true);
    const updating = f.task.update({ ...patch, config: { ...patch.config, enabled } }, () => true);
    const result = updating.then(
      () => undefined,
      (error: unknown) => error
    );
    try {
      await barrier.held;
      expect(f.task.getStatus().objective).toBe(patch.objective);
      barrier.release();
      const failure = await result;
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(TaskConfigurationCancelledError);
      expect(f.task.getStatus()).toMatchObject({
        objective: patch.objective,
        phase: 'blocked',
        reason: 'persistence-failed',
        config: { enabled: false },
      });
      expect(f.store.get(SID)).toMatchObject({
        objective: patch.objective,
        phase: 'blocked',
        reason: 'persistence-failed',
        config: { enabled: false },
      });
      const uncertainBytes = await readFile(f.path, 'utf8');
      const reloadedObserve = vi.fn();
      const reloadedAct = vi.fn();
      vi.useFakeTimers();
      const reloaded = new TaskController(
        {
          observe: reloadedObserve,
          act: reloadedAct,
          persist: async () => {},
          changed: () => {},
          now: () => 10_000,
        },
        new TaskStore(f.path).get(SID)
      );
      try {
        expect(reloaded.getStatus()).toMatchObject({
          objective: patch.objective,
          phase: enabled ? 'paused' : 'disabled',
          reason: enabled ? 'restart-requires-resume' : 'configured',
        });
        await vi.advanceTimersByTimeAsync(6_000);
        expect(reloadedObserve).not.toHaveBeenCalled();
        expect(reloadedAct).not.toHaveBeenCalled();
      } finally {
        reloaded.stop();
        vi.useRealTimers();
      }

      await expect(f.task.resume()).rejects.toThrow();
      expect(f.task.getStatus()).toMatchObject({
        objective: patch.objective,
        phase: 'blocked',
        reason: 'persistence-failed',
      });
      await expect(f.store.save(SID, initialTaskState())).rejects.toThrow();
      await expect(f.store.drop(SID)).rejects.toThrow();
      await expect(f.store.pruneOrphans(() => false)).rejects.toThrow();
      expect(await readFile(f.path, 'utf8')).toBe(uncertainBytes);
      expect(f.act).not.toHaveBeenCalled();
    } finally {
      barrier.release();
      await result;
      await f.cleanup();
    }
  }
);

it.each(['rename-lost-ack', 'temporary-write'] as const)(
  'never certifies %s I/O failure as unsent when owner pause arrives during cleanup',
  async (fault) => {
    const f = await fixture();
    const before = f.task.getStatus();
    const bytes = await readFile(f.path, 'utf8');
    const ioError = new Error(`Task configuration was cancelled: fixture ${fault} I/O failure`);
    const nativeFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const nativePromises = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let entered!: () => void, release!: () => void;
    const cleaning = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.mocked(unlink).mockImplementationOnce(async (path) => {
      entered();
      await gate;
      await nativePromises.unlink(path);
    });
    if (fault === 'rename-lost-ack')
      vi.mocked(renameSync).mockImplementationOnce((from, to) => {
        nativeFs.renameSync(from, to);
        throw ioError;
      });
    else {
      vi.mocked(open).mockImplementationOnce(async (...args) => {
        const handle = await nativePromises.open(...args);
        return {
          writeFile: async () => {
            throw ioError;
          },
          sync: handle.sync.bind(handle),
          close: handle.close.bind(handle),
        } as unknown as typeof handle;
      });
    }
    const updating = f.task.update(patch, () => true);
    const result = updating.then(
      () => undefined,
      (error: unknown) => error
    );
    let paused: Promise<unknown> | undefined;
    try {
      await cleaning;
      const duringCleanup = await readFile(f.path, 'utf8');
      if (fault === 'rename-lost-ack') {
        expect(duringCleanup).not.toBe(bytes);
        expect(new TaskStore(f.path).get(SID).objective).toBe(patch.objective);
      } else expect(duringCleanup).toBe(bytes);
      // The error already occurred, while its asynchronous cleanup is pending.
      paused = f.task.pause().catch((error: unknown) => error);
      release();
      const failure = await result;
      expect(failure).toBe(ioError);
      expect(failure).not.toBeInstanceOf(TaskConfigurationCancelledError);
      await paused;
      if (fault === 'rename-lost-ack') {
        expect(f.store.getBrokerCleanupState()).toBeUndefined();
        await expect(f.store.save(SID, before)).rejects.toThrow(/uncertain/);
        await expect(f.store.drop(SID)).rejects.toThrow(/uncertain/);
        await expect(f.store.pruneOrphans(() => false)).rejects.toThrow(/uncertain/);
        expect(await readFile(f.path, 'utf8')).toBe(duringCleanup);
      } else {
        // The queued owner pause acknowledged a complete replacement snapshot.
        expect(f.store.getBrokerCleanupState()).toEqual({ [SID]: new TaskStore(f.path).get(SID) });
        expect(new TaskStore(f.path).get(SID)).toMatchObject({
          objective: before.objective,
          criteria: before.criteria,
          checkpoint: before.checkpoint,
          reason: 'owner-paused',
        });
      }
      await expect(f.task.resume()).rejects.toThrow(/uncertain/);
      expect(f.act).not.toHaveBeenCalled();
    } finally {
      release();
      await result;
      await paused;
      await f.cleanup();
    }
  }
);

it('withholds cleanup references until every queued task-journal mutation has settled', async () => {
  const f = await fixture();
  try {
    const snapshot = f.store.getBrokerCleanupState()!;
    expect(snapshot[SID].objective).toBe(priorState().objective);
    snapshot[SID].objective = 'Detached copy';
    expect(f.store.get(SID).objective).toBe(priorState().objective);
    const saving = f.store.save(SID, priorState());
    const pruning = f.store.pruneOrphans(() => true);
    expect(f.store.getBrokerCleanupState()).toBeUndefined();
    await saving;
    await pruning;
    expect(f.store.getBrokerCleanupState()).toEqual({ [SID]: priorState() });
    const dropping = f.store.drop(SID);
    expect(f.store.getBrokerCleanupState()).toBeUndefined();
    await dropping;
    expect(f.store.getBrokerCleanupState()).toEqual({});
  } finally {
    await f.cleanup();
  }
});

it('withholds cleanup references after an ordinary journal rename lands with a lost acknowledgement', async () => {
  const f = await fixture();
  const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const ioError = new Error('Fixture ordinary rename acknowledgement lost');
  vi.mocked(rename).mockImplementationOnce(async (from, to) => {
    await native.rename(from, to);
    throw ioError;
  });
  try {
    const replacement = { ...priorState(), objective: 'Durable replacement despite lost acknowledgement' };
    await expect(f.store.save(SID, replacement)).rejects.toBe(ioError);
    expect(new TaskStore(f.path).get(SID).objective).toBe(replacement.objective);
    expect(f.store.get(SID).objective).toBe(priorState().objective);
    expect(f.store.getBrokerCleanupState()).toBeUndefined();
    await expect(f.store.save(SID, priorState())).rejects.toThrow(/uncertain/);
    await expect(f.store.drop(SID)).rejects.toThrow(/uncertain/);
    await expect(f.store.pruneOrphans(() => false)).rejects.toThrow(/uncertain/);
    expect(new TaskStore(f.path).get(SID).objective).toBe(replacement.objective);
  } finally {
    await f.cleanup();
  }
});

it('does not reuse a cancellation Error identity to certify a later I/O failure', async () => {
  const f = await fixture();
  const reused = new TaskConfigurationCancelledError('Fixture shared error object');
  const commit = vi.fn();
  try {
    await expect(
      f.store.save(SID, priorState(), { isCurrent: () => false, cancelled: () => reused, commit })
    ).rejects.toBe(reused);
    expect(f.store.getBrokerCleanupState()).toEqual({ [SID]: priorState() });
    vi.mocked(open).mockRejectedValueOnce(reused);
    await expect(
      f.store.save(SID, priorState(), { isCurrent: () => true, cancelled: () => reused, commit })
    ).rejects.toBe(reused);
    expect(commit).not.toHaveBeenCalled();
    expect(f.store.getBrokerCleanupState()).toBeUndefined();
    await f.store.save(SID, priorState());
    expect(f.store.getBrokerCleanupState()).toEqual({ [SID]: priorState() });
  } finally {
    await f.cleanup();
  }
});

it('withholds cleanup after temporary-file cleanup fails during an otherwise certified cancellation', async () => {
  const f = await fixture();
  const original = await readFile(f.path, 'utf8');
  const barrier = await holdTemporarySync(f.path);
  let current = true;
  const updating = f.task.update(patch, () => current);
  const result = updating.catch((error: unknown) => error);
  try {
    await barrier.held;
    current = false;
    vi.mocked(unlink).mockRejectedValueOnce(new Error('Fixture temporary unlink I/O failure'));
    barrier.release();
    expect(await result).toBeInstanceOf(TaskConfigurationCancelledError);
    expect(await readFile(f.path, 'utf8')).toBe(original);
    expect(f.store.getBrokerCleanupState()).toBeUndefined();
    await f.store.save(SID, priorState());
    expect(f.store.getBrokerCleanupState()).toEqual({ [SID]: priorState() });
    expect(f.act).not.toHaveBeenCalled();
  } finally {
    barrier.release();
    await result;
    await f.cleanup();
  }
});

it.each(
  (['write', 'sync', 'close'] as const).flatMap((phase) =>
    (['delegated', 'owner', 'reset'] as const).map((mode) => ({ phase, mode }))
  )
)(
  'requires command evidence after the authorized $mode commit, excluding temporary $phase staging',
  async ({ phase, mode }) => {
    const f = await fixture();
    const commandPatch: TaskUpdate = {
      ...patch,
      criteria: [{ id: 'test', kind: 'command', description: 'Fresh tests', command: 'npm test' }],
    };
    if (mode === 'reset') await f.task.update(commandPatch);
    const barrier = await holdTemporarySync(f.path, phase);
    const updating =
      mode === 'reset' ? f.task.reset() : f.task.update(commandPatch, mode === 'delegated' ? () => true : undefined);
    try {
      await barrier.held;
      f.clock(20_000);
      barrier.release();
      const committed = await updating;
      expect(f.store.get(SID)).toEqual(committed);
      expect(new TaskStore(f.path).get(SID)).toEqual(committed);
      f.clock(22_000);
      f.commands.set(commandHash('npm test'), { startedAt: 15_000, completedAt: 21_000 });
      await expect(f.task.progress({ outcome: 'completed', verifiedCriteria: ['test'] })).rejects.toThrow(/evidence/);
      expect(f.task.getStatus().criteria[0].verified).toBe(false);
      expect(f.act).not.toHaveBeenCalled();
      f.commands.set(commandHash('npm test'), { startedAt: 20_000, completedAt: 21_000 });
      await f.task.progress({ outcome: 'completed', verifiedCriteria: ['test'] });
      expect(f.task.getStatus()).toMatchObject({ outcome: 'completed', criteria: [{ verified: true }] });
      expect(new TaskStore(f.path).get(SID)).toEqual(f.task.getStatus());
    } finally {
      barrier.release();
      await updating.catch(() => {});
      await f.cleanup();
    }
  }
);

it.each(['owner-command', 'agent-command', 'agent-report', 'completed-turn'] as const)(
  'requires fresh evidence after reload without changing durable task state (%s)',
  async (entry) => {
    const f = await fixture();
    const state: TaskState = {
      ...priorState(),
      config: { ...priorState().config, enabled: true },
      criteria: [{ id: 'test', kind: 'command', description: 'Fresh tests', command: 'npm test', verified: false }],
      outcome: 'unfinished',
      submissionKey: 'restored-submission',
      lastProgressAt: 5_000,
      kickoffAt: 6_000,
    };
    await f.store.save(SID, state);
    let at = 25_000;
    let now = 30_000;
    const effects = vi.fn(async () => 'sent' as const);
    const task = new TaskController(
      {
        now: () => now,
        observe: async () => ({
          observation: {
            activity: 'completed',
            reason: 'turn-completed',
            at,
            conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            turnId: `turn-${at}`,
            submissionKey: state.submissionKey,
            processReady: true,
          },
          commands: new Map([[commandHash('npm test'), { startedAt: at, completedAt: at + 1 }]]),
          ...(entry.startsWith('agent')
            ? {
                marker: {
                  key: `progress:${'a'.repeat(63)}${at === 25_000 ? '1' : '2'}`,
                  at,
                  submissionKey: state.submissionKey,
                  progress:
                    entry === 'agent-command'
                      ? { outcome: 'completed', verifiedCriteria: ['test'] }
                      : { outcome: 'unfinished', checkpoint: `Checkpoint ${at}`, nextAction: 'Fresh step' },
                },
              }
            : {}),
        }),
        act: effects,
        persist: (value, authority) => f.store.save(SID, value, authority),
        changed: () => {},
      },
      new TaskStore(f.path).get(SID)
    );
    try {
      const restored = task.getStatus();
      if (entry === 'owner-command') {
        await expect(task.progress({ outcome: 'completed', verifiedCriteria: ['test'] })).rejects.toThrow(/evidence/);
      } else {
        await task.resume();
        await task.refresh();
        expect(task.getStatus().criteria[0].verified).toBe(false);
        expect(task.getStatus().checkpoint).toBe(restored.checkpoint);
        expect(effects).not.toHaveBeenCalled();
      }
      at = 30_000;
      now = 30_100;
      if (entry === 'owner-command') await task.progress({ outcome: 'completed', verifiedCriteria: ['test'] });
      else await task.refresh();
      if (entry.endsWith('command')) expect(task.getStatus().criteria[0].verified).toBe(true);
      if (entry === 'agent-report') expect(task.getStatus().checkpoint).toBe('Checkpoint 30000');
      if (entry === 'completed-turn') expect(effects).toHaveBeenCalledOnce();
    } finally {
      task.stop();
      await task.drain();
      await f.cleanup();
    }
  }
);

it.each([' ', '\r\n ', '\u00a0\u2028\u3000'])(
  'rejects a normalized blank objective before mutation: %j',
  async (objective) => {
    const f = await fixture();
    try {
      const before = f.task.getStatus();
      expect(() => f.task.update({ objective })).toThrow();
      expect(f.task.getStatus()).toEqual(before);
      expect(f.persisted).toEqual([]);
      expect(f.act).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  }
);

it('preserves meaningful multiline Unicode objective bytes', async () => {
  const f = await fixture();
  const objective = '  Review 日本語\r\n Preserve emoji 🐈 and spacing  ';
  try {
    await f.task.update({ objective });
    expect(f.task.getStatus().objective).toBe(objective);
    expect(new TaskStore(f.path).get(SID).objective).toBe(objective);
  } finally {
    await f.cleanup();
  }
});

it('stamps delegated freshness at authorized pathname publication before directory acknowledgment', async () => {
  const f = await fixture();
  const barrier = await holdDirectorySync(f.root);
  const updating = f.task.update(
    { ...patch, criteria: [{ id: 'test', kind: 'command', description: 'Tests', command: 'npm test' }] },
    () => true
  );
  try {
    await barrier.held;
    expect(new TaskStore(f.path).get(SID)).toEqual(f.task.getStatus());
    f.clock(20_000);
    barrier.release();
    await updating;
    f.commands.set(commandHash('npm test'), { startedAt: 15_000, completedAt: 19_000 });
    await f.task.progress({ outcome: 'completed', verifiedCriteria: ['test'] });
    expect(f.task.getStatus().criteria[0].verified).toBe(true);
  } finally {
    barrier.release();
    await updating.catch(() => {});
    await f.cleanup();
  }
});

it('keeps existing evidence authority across a configuration-only budget change', async () => {
  const f = await fixture();
  try {
    await f.task.update({
      ...patch,
      criteria: [{ id: 'test', kind: 'command', description: 'Tests', command: 'npm test' }],
    });
    f.clock(20_000);
    await f.task.update({ config: { maxContinuations: 2 } }, () => true);
    f.commands.set(commandHash('npm test'), { startedAt: 15_000, completedAt: 19_000 });
    await f.task.progress({ outcome: 'completed', verifiedCriteria: ['test'] });
    expect(f.task.getStatus().criteria[0].verified).toBe(true);
  } finally {
    await f.cleanup();
  }
});

it.each(['resume', 'enable'] as const)(
  'refuses %s of a legacy blank objective before observing or delivery',
  async (mode) => {
    const f = await fixture();
    const observe = vi.fn(async () => ({
      observation: { activity: 'idle' as const, reason: 'observing' as const, at: 10_000 },
      commands: new Map(),
    }));
    const task = new TaskController(
      { now: () => 10_000, observe, act: f.act, persist: async () => {}, changed: () => {} },
      { ...priorState(), objective: ' \r\n ' }
    );
    try {
      const starting = mode === 'resume' ? task.resume() : task.update({ config: { enabled: true } });
      await expect(starting).rejects.toThrow(/task|objective/i);
      expect(observe).not.toHaveBeenCalled();
      expect(f.act).not.toHaveBeenCalled();
    } finally {
      task.stop();
      await task.drain();
      await f.cleanup();
    }
  }
);

it.each(
  ['manual-description', 'command-description', 'command'].flatMap((field) =>
    [' ', '\r\n ', '\u00a0\u2028\u3000'].map((blank) => ({ field, blank }))
  )
)('rejects blank required criterion $field before task mutation: $blank', async ({ field, blank }) => {
  const f = await fixture();
  try {
    const before = f.task.getStatus();
    const bytes = await readFile(f.path, 'utf8');
    const criteria: TaskUpdate['criteria'] =
      field === 'manual-description'
        ? [{ id: 'accept', kind: 'manual', description: blank }]
        : [
            {
              id: 'accept',
              kind: 'command',
              description: field === 'command-description' ? blank : 'Run tests',
              command: field === 'command' ? blank : 'npm test',
            },
          ];
    expect(() => f.task.update({ criteria })).toThrow();
    expect(f.task.getStatus()).toEqual(before);
    expect(await readFile(f.path, 'utf8')).toBe(bytes);
    expect(f.persisted).toEqual([]);
    expect(f.act).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
  }
});

it('preserves meaningful multiline Unicode criterion and exact command bytes', async () => {
  const f = await fixture();
  const criteria: NonNullable<TaskUpdate['criteria']> = [
    { id: 'accept', kind: 'manual', description: '  日本語\r\n Owner review 🐈  ' },
    {
      id: 'tests',
      kind: 'command',
      description: '  Run 日本語 tests\n then review  ',
      command: '  printf 日本語\r\n npm test  ',
    },
  ];
  try {
    await f.task.update({ criteria });
    expect(f.task.getStatus().criteria).toEqual(criteria.map((criterion) => ({ ...criterion, verified: false })));
    expect(new TaskStore(f.path).get(SID)).toEqual(f.task.getStatus());
    expect(f.act).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
  }
});
