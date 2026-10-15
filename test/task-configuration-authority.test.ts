/** Guarded task configuration uses disposable journals and no worker/process effects. */
import { afterEach, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { renameSync } from 'node:fs';
import { mkdtemp, open, readFile, readdir, rename, rm, unlink } from 'node:fs/promises';
import { TaskConfigurationCancelledError, TaskController } from '../src/supervision/controller.js';
import { TaskStore, type TaskSaveAuthority } from '../src/supervision/store.js';
import { initialTaskState, type TaskState, type TaskUpdate } from '../src/supervision/schema.js';

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
  const persisted: TaskState[] = [];
  const task = new TaskController(
    {
      now: () => 10_000,
      observe: async () => ({
        observation: {
          activity: 'idle',
          reason: 'observing',
          at: 10_000,
          conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          processReady: true,
          safeToAct: false,
        },
        commands: new Map(),
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
    const ioError = new Error(`Fixture ${fault} I/O failure`);
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
  } finally {
    await f.cleanup();
  }
});
