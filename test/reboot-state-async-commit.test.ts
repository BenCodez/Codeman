/** Asynchronous reboot commits with disposable files and held filesystem acknowledgements. */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StateStore } from '../src/state-store.js';
import type { SessionState } from '../src/types.js';

const io = vi.hoisted(() => ({
  stage: '',
  entered: undefined as (() => void) | undefined,
  held: undefined as Promise<void> | undefined,
  failure: '',
  error: new Error('Fixture filesystem acknowledgement failed'),
  writes: 0,
  directorySyncs: 0,
  commits: 0,
  temporary: '',
  primaryCloses: 0,
  onStage: undefined as ((stage: string) => void) | undefined,
}));
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  const pause = async (stage: string) => {
    io.onStage?.(stage);
    if (io.stage !== stage) return;
    io.stage = '';
    io.entered?.();
    await io.held;
  };
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const path = String(args[0]);
      if (path.endsWith('.reboot.tmp') && args[1] === 'wx') {
        io.temporary = path;
        if (io.failure === 'wx-collision') await real.writeFile(path, 'foreign temporary');
      }
      const file = await real.open(...args);
      const candidate = path.endsWith('.reboot.tmp') && args[1] === 'wx';
      if (candidate) await pause('open');
      return new Proxy(file, {
        get(target, key) {
          if (key === 'writeFile')
            return async (...input: Parameters<typeof file.writeFile>) => {
              if (candidate) {
                io.writes++;
                await pause(io.writes === 1 ? 'write' : 'rollback-write');
                if (io.failure === 'write') {
                  io.failure = '';
                  throw io.error;
                }
              }
              return target.writeFile(...input);
            };
          if (key === 'sync')
            return async () => {
              const directory = (await target.stat()).isDirectory();
              if (directory) {
                io.directorySyncs++;
                await pause('directory-sync');
                if (io.failure === 'directory-sync' && io.directorySyncs === 1) {
                  io.failure = '';
                  throw io.error;
                }
              } else if (candidate) {
                await pause('file-sync');
                if (io.failure === 'file-sync') {
                  io.failure = '';
                  throw io.error;
                }
              }
              return target.sync();
            };
          if (key === 'close')
            return async () => {
              const directory = (await target.stat()).isDirectory();
              if (path.endsWith('.reboot.tmp') && typeof args[1] === 'number') await pause('temp-proof-close');
              if (candidate) await pause('close');
              else if (directory) await pause('directory-close');
              else if (path.endsWith('state.json')) {
                if (io.writes === 0) await pause('initial-proof-close');
                io.primaryCloses++;
                if (io.writes >= 2) await pause('rollback-proof-close');
              }
              return target.close();
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    lstat: async (...args: Parameters<typeof real.lstat>) => {
      if (String(args[0]).endsWith('.reboot.tmp') && io.commits > 0) await pause('success-cleanup');
      return real.lstat(...args);
    },
    rename: async (...args: Parameters<typeof real.rename>) => {
      if (String(args[0]).endsWith('.reboot.tmp')) {
        await pause('rename');
        await real.rename(...args);
        io.commits++;
        if (io.failure === 'rename-ack') {
          io.failure = '';
          throw io.error;
        }
        return;
      }
      return real.rename(...args);
    },
    writeFile: async (...args: Parameters<typeof real.writeFile>) => {
      if (String(args[0]).endsWith('.tmp') && !String(args[0]).endsWith('.reboot.tmp')) await pause('ordinary-write');
      return real.writeFile(...args);
    },
  };
});
const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
const historical = {
  id: ID,
  name: 'Historical',
  mode: 'claude',
  workingDir: '/fixture/work',
  status: 'stopped',
  pid: 0,
  createdAt: 1,
  currentTaskId: null,
} as SessionState;
const tentative = () => ({ ...historical, name: 'Restored', pid: 99999 });
let root: string, path: string, store: StateStore;
let release: (() => void) | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(join(homedir(), 'reboot-async-state-'));
  path = join(root, 'state.json');
  store = new StateStore(path);
  store.setSession(ID, structuredClone(historical));
  store.flush();
  io.stage = '';
  io.failure = '';
  io.writes = 0;
  io.commits = 0;
  io.directorySyncs = 0;
  io.entered = undefined;
  io.held = undefined;
  io.onStage = undefined;
});
afterEach(async () => {
  release?.();
  release = undefined;
  io.stage = '';
  io.failure = '';
  io.onStage = undefined;
  // Baseline compatibility is cleanup-only, so the old synchronous method can
  // fail the causal barrier test without a missing-new-API teardown error.
  const drain = Reflect.get(store, 'flushAllAsync') as (() => Promise<void>) | undefined;
  if (drain) await drain.call(store);
  else store.flushAll();
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function hold(stage: string) {
  io.stage = stage;
  const entered = new Promise<void>((resolve) => {
    io.entered = resolve;
  });
  io.held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return entered;
}
async function reached(entered: Promise<void>, operation: Promise<unknown>) {
  await Promise.race([
    entered,
    operation.then(
      () => {
        throw Error('Commit completed without asynchronous filesystem barrier');
      },
      (error) => {
        throw error;
      }
    ),
  ]);
}
function reload() {
  return new StateStore(path);
}

function seedUnrelatedState() {
  store.setSession(OTHER, { ...historical, id: OTHER, name: 'Unrelated historical session' });
  store.setTask('unrelated-task', {
    id: 'unrelated-task',
    prompt: 'Owner task',
    workingDir: '/fixture/work',
    priority: 0,
    dependencies: [],
    status: 'pending',
    assignedSessionId: null,
    createdAt: 1,
    startedAt: null,
    completedAt: null,
    output: '',
    error: null,
  });
  store.flush();
}

function editUnrelatedState(kind: 'session' | 'config' | 'task') {
  if (kind === 'session') store.getSession(OTHER)!.name = 'Unrelated concurrent owner edit';
  if (kind === 'config') store.getConfig().pollIntervalMs += 1000;
  if (kind === 'task') store.getTask('unrelated-task')!.output = 'Unrelated concurrent task edit';
  store.save();
}

it.each(
  (['codex', 'claude'] as const).flatMap((mode) =>
    (['file-sync', 'directory-sync'] as const).map((stage) => ({ mode, stage }))
  )
)(
  'restages live $mode status/activity/accounting during $stage without cancelling its restore',
  async ({ mode, stage }) => {
    const record: SessionState = {
      ...tentative(),
      mode,
      status: 'idle',
      lastActivityAt: 10,
      inputTokens: 20,
      outputTokens: 30,
      totalCost: 1,
    };
    const entered = hold(stage),
      before = fs.readFileSync(path, 'utf8');
    const committing = store.persistSessionDurably(ID, () => record);
    await reached(entered, committing);
    expect(store.getSession(ID)).toEqual(historical);
    Object.assign(record, { status: 'busy', lastActivityAt: 100, inputTokens: 200, outputTokens: 300, totalCost: 2 });
    release!();
    await committing;
    expect(store.getSession(ID)).toEqual(record);
    expect(reload().getSession(ID)).toEqual(record);
    expect(fs.readFileSync(path, 'utf8')).not.toBe(before);
    expect(io.writes).toBeGreaterThan(1);
    expect(Reflect.get(store, 'circuitBreakerOpen')).toBe(false);
  }
);

it.each(['owner', 'config', 'conversation', 'home', 'broker', 'dismiss'] as const)(
  'live accounting drift cannot mask a changed %s restore authority',
  async (change) => {
    const record: SessionState = {
      ...tentative(),
      mode: 'codex',
      status: 'idle',
      lastActivityAt: 10,
      codexConfig: { noDaemon: true, resumeSessionId: ID, sandbox: 'read-only' },
    };
    Object.assign(record, { __codexRecoveryHome: '/fixture/home', __codexInputBroker: ID });
    let current = true;
    const entered = hold('file-sync'),
      before = fs.readFileSync(path, 'utf8');
    const committing = store.persistSessionDurably(
      ID,
      () => record,
      () => current
    );
    const rejected = expect(committing).rejects.toThrow('cancelled');
    await reached(entered, committing);
    record.lastActivityAt = 100;
    if (change === 'owner') record.owner = 'replacement-owner';
    if (change === 'config') record.codexConfig = { ...record.codexConfig, sandbox: 'workspace-write' };
    if (change === 'conversation') record.codexConfig = { ...record.codexConfig, resumeSessionId: OTHER };
    if (change === 'home') Reflect.set(record, '__codexRecoveryHome', '/fixture/replacement-home');
    if (change === 'broker') Reflect.set(record, '__codexInputBroker', OTHER);
    if (change === 'dismiss') current = false; // Owner/role/grant cancellation stays a separate pure authority verdict.
    release!();
    await rejected;
    expect(io.writes).toBe(1);
    expect(store.getSession(ID)).toEqual(historical);
    expect(fs.readFileSync(path, 'utf8')).toBe(before);
    expect(reload().getSession(ID)).toEqual(historical);
  }
);

it.each(['file-sync', 'directory-sync'] as const)(
  'bounds continuous live activity churn during %s as restaging rather than cancellation',
  async (stage) => {
    const record: SessionState = { ...tentative(), lastActivityAt: 1 };
    const before = fs.readFileSync(path, 'utf8');
    let changes = 0;
    io.onStage = (current) => {
      if (current === stage) record.lastActivityAt = ++changes + 1;
    };
    await expect(store.persistSessionDurably(ID, () => record)).rejects.toThrow('Concurrent state edit');
    io.onStage = undefined;
    expect(changes).toBeGreaterThanOrEqual(3);
    expect(io.writes).toBeLessThanOrEqual(stage === 'file-sync' ? 3 : 6);
    expect(store.getSession(ID)).toEqual(historical);
    expect(fs.readFileSync(path, 'utf8')).toBe(before);
    expect(Reflect.get(store, 'circuitBreakerOpen')).toBe(false);
    // The bounded save lease releases, so stable output can commit without
    // inventing a new worker or treating the previous churn as owner Dismiss.
    await store.persistSessionDurably(ID, () => record);
    expect(reload().getSession(ID)).toEqual(record);
  }
);

it.each(
  ['file-sync', 'rename', 'directory-sync', 'directory-close'].flatMap((stage) =>
    (['session', 'config', 'task'] as const).map((kind) => ({ stage, kind }))
  )
)(
  'durably includes a same-object $kind edit during $stage before ACK, even with ordinary writes held',
  async ({ stage, kind }) => {
    seedUnrelatedState();
    const entered = hold(stage);
    const committing = store.persistSessionDurably(ID, tentative());
    await reached(entered, committing);
    editUnrelatedState(kind);
    const expected = structuredClone(store.getState());
    expected.sessions[ID] = tentative();
    const releaseCandidate = release!;
    // An ordinary save must not repair stale durable bytes before this assertion.
    // The new strict transaction may make this queued write unnecessary entirely.
    hold('ordinary-write');
    const ordinary = store.saveNowAsync();
    releaseCandidate();
    try {
      await committing;
      expect(JSON.parse(fs.readFileSync(path, 'utf8'))).toEqual(expected);
      expect(store.getState()).toEqual(expected);
      expect(reload().getState()).toEqual(expected);
    } finally {
      release!();
      await ordinary;
    }
  }
);

it.each(['file-sync', 'directory-sync'])(
  'bounds continuous unrelated edits during %s and refuses success with historical owner bytes intact',
  async (stage) => {
    const previous = fs.readFileSync(path, 'utf8');
    let edits = 0;
    io.onStage = (current) => {
      if (current === stage) {
        edits++;
        store.setConfig({ pollIntervalMs: 1000 + edits });
      }
    };
    await expect(store.persistSessionDurably(ID, tentative())).rejects.toThrow('Concurrent state edit');
    io.onStage = undefined;
    expect(edits).toBeGreaterThanOrEqual(3);
    expect(io.writes).toBeLessThanOrEqual(stage === 'file-sync' ? 3 : 6);
    expect(store.getSession(ID)).toEqual(historical);
    expect(fs.readFileSync(path, 'utf8')).toBe(previous);
    expect(Reflect.get(store, 'dirty')).toBe(true);
    expect(Reflect.get(store, 'circuitBreakerOpen')).toBe(false);
    // The bounded refusal releases the shared queue; ordinary saves preserve
    // the latest unrelated intent without publishing a restored worker.
    await store.saveNowAsync();
    expect(reload().getConfig().pollIntervalMs).toBe(1000 + edits);
    expect(reload().getSession(ID)).toEqual(historical);
  }
);

it.each(['owner', 'producer', 'cancel', 'equal-replacement'] as const)(
  'does not adopt a changed %s anchor while restaging a concurrent unrelated edit',
  async (change) => {
    const previous = fs.readFileSync(path, 'utf8');
    const first = hold('file-sync');
    let record = tentative(),
      current = true;
    const committing = store.persistSessionDurably(
      ID,
      () => record,
      () => current
    );
    const rejected = expect(committing).rejects.toThrow('cancelled');
    await reached(first, committing);
    store.setConfig({ pollIntervalMs: 12345 });
    const releaseFirst = release!;
    const second = hold('rollback-write');
    releaseFirst();
    await reached(second, committing);
    if (change === 'owner') store.getSession(ID)!.owner = 'new-owner';
    if (change === 'producer') record = { ...record, owner: 'new-owner' };
    if (change === 'cancel') current = false;
    if (change === 'equal-replacement') store.setSession(ID, structuredClone(historical));
    const expected = structuredClone(store.getSession(ID));
    release!();
    await rejected;
    expect(store.getSession(ID)).toEqual(expected);
    expect(fs.readFileSync(path, 'utf8')).toBe(previous);
    expect(io.commits).toBe(0);
    await store.saveNowAsync();
    expect(reload().getSession(ID)).toEqual(expected);
    expect(reload().getConfig().pollIntervalMs).toBe(12345);
  }
);

it.each(['write', 'file-sync', 'rename-ack', 'directory-sync'])(
  'never retries a real %s error as a concurrent snapshot edit',
  async (fault) => {
    const previous = fs.readFileSync(path, 'utf8');
    const entered = hold(fault === 'write' ? 'write' : fault === 'file-sync' ? 'file-sync' : 'rename');
    io.failure = fault;
    const committing = store.persistSessionDurably(ID, tentative());
    const rejected = expect(committing).rejects.toBe(io.error);
    await reached(entered, committing);
    store.setConfig({ pollIntervalMs: 12345 });
    release!();
    await rejected;
    expect(io.writes).toBe(fault === 'write' || fault === 'file-sync' ? 1 : 2);
    expect(store.getSession(ID)).toEqual(historical);
    expect(fs.readFileSync(path, 'utf8')).toBe(previous);
    await store.saveNowAsync();
    expect(reload().getSession(ID)).toEqual(historical);
    expect(reload().getConfig().pollIntervalMs).toBe(12345);
  }
);

it.each(['write', 'directory-sync'])(
  'does not retry a changed snapshot after a rollback %s acknowledgement fails',
  async (fault) => {
    const entered = hold('directory-sync');
    const committing = store.persistSessionDurably(ID, tentative());
    const rejected = expect(committing).rejects.toThrow('uncertain durable commit');
    await reached(entered, committing);
    store.setConfig({ pollIntervalMs: 12345 });
    io.onStage = (stage) => {
      if (fault === 'write' && stage === 'rollback-write') throw io.error;
      if (fault === 'directory-sync' && stage === 'directory-sync' && io.directorySyncs === 2) throw io.error;
    };
    release!();
    await rejected;
    io.onStage = undefined;
    expect(io.writes).toBe(2);
    expect(io.commits).toBe(fault === 'write' ? 1 : 2);
    expect(store.getSession(ID)).toEqual(historical);
    if (fault === 'write') {
      expect(Reflect.get(store, 'circuitBreakerOpen')).toBe(true);
      const uncertain = fs.readFileSync(path, 'utf8');
      await store.saveNowAsync();
      expect(fs.readFileSync(path, 'utf8')).toBe(uncertain);
    } else expect(reload().getSession(ID)).toEqual(historical);
  }
);

it.each(['open', 'write', 'file-sync', 'close', 'rename', 'directory-sync', 'directory-close', 'success-cleanup'])(
  'keeps the event loop responsive and historical memory until asynchronous %s acknowledges',
  async (stage) => {
    const entered = hold(stage);
    let finished = false;
    const committing = store.persistSessionDurably(ID, tentative()).then(() => {
      finished = true;
    });
    await reached(entered, committing);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(finished).toBe(false);
    expect(store.getSession(ID)).toEqual(historical);
    release!();
    await committing;
    expect(store.getSession(ID)).toEqual(tentative());
    expect(reload().getSession(ID)).toEqual(tentative());
  }
);
it.each(['write', 'file-sync', 'close', 'rename', 'directory-sync', 'directory-close', 'success-cleanup'])(
  'preserves historical bytes when owner authority is withdrawn during %s',
  async (stage) => {
    const previous = fs.readFileSync(path, 'utf8');
    const entered = hold(stage);
    let current = true;
    const committing = store.persistSessionDurably(ID, tentative(), () => current);
    const failure = expect(committing).rejects.toThrow('cancelled');
    await reached(entered, committing);
    current = false;
    release!();
    await failure;
    expect(store.getSession(ID)).toEqual(historical);
    expect(fs.readFileSync(path, 'utf8')).toBe(previous);
    expect(reload().getSession(ID)).toEqual(historical);
  }
);
it('serializes ordinary and synchronous saves after the durable write without losing another session edit', async () => {
  const entered = hold('write');
  const committing = store.persistSessionDurably(ID, tentative());
  await reached(entered, committing);
  const other = { ...historical, id: OTHER, name: 'New owner edit' };
  store.setSession(OTHER, other);
  store.flush();
  const ordinary = store.saveNowAsync();
  expect(reload().getSession(OTHER)).toBeNull();
  release!();
  await committing;
  await ordinary;
  expect(reload().getSession(ID)).toEqual(tentative());
  expect(reload().getSession(OTHER)).toEqual(other);
  store.setSession(OTHER, { ...other, name: 'Next edit' });
  await store.saveNowAsync();
  expect(reload().getSession(OTHER)?.name).toBe('Next edit');
});
it.each(['replace', 'remove', 'in-place', 'reset', 'backup', 'record-thunk'])(
  'refuses to republish a staged target after concurrent %s intent',
  async (change) => {
    const entered = hold('write');
    let record = tentative();
    const committing = store.persistSessionDurably(ID, () => record);
    const failure = expect(committing).rejects.toThrow('cancelled');
    await reached(entered, committing);
    if (change === 'replace') store.setSession(ID, { ...historical, name: 'Owner edit' });
    if (change === 'remove') store.removeSession(ID);
    if (change === 'in-place') {
      store.getSession(ID)!.name = 'In-place edit';
      store.save();
    }
    if (change === 'reset') store.reset();
    if (change === 'backup') {
      const saved = JSON.parse(fs.readFileSync(path, 'utf8'));
      saved.sessions[ID].name = 'Recovered owner edit';
      fs.writeFileSync(path + '.bak', JSON.stringify(saved));
      expect(store.recoverFromBackup()).toBe(true);
      store.flush();
    }
    if (change === 'record-thunk') record = { ...record, owner: 'new-owner' };
    const expected = structuredClone(store.getSession(ID));
    release!();
    await failure;
    await store.saveNowAsync();
    expect(store.getSession(ID)).toEqual(expected);
    expect(reload().getSession(ID)).toEqual(expected);
    expect(io.commits).toBe(0);
  }
);
it('waits for an older ordinary write before staging a durable snapshot', async () => {
  const entered = hold('ordinary-write');
  store.setSession(OTHER, { ...historical, id: OTHER, name: 'Older write' });
  const older = store.saveNowAsync();
  await reached(entered, older);
  const committing = store.persistSessionDurably(ID, tentative());
  expect(io.writes).toBe(0);
  store.setSession(OTHER, { ...historical, id: OTHER, name: 'Latest while older held' });
  release!();
  await older;
  await committing;
  expect(reload().getSession(OTHER)?.name).toBe('Latest while older held');
  expect(reload().getSession(ID)).toEqual(tentative());
});
it('does not swallow reset when a synchronous flush meets an ordinary in-flight snapshot', async () => {
  const entered = hold('ordinary-write');
  store.setSession(OTHER, { ...historical, id: OTHER });
  const older = store.saveNowAsync();
  await reached(entered, older);
  store.reset();
  release!();
  await older;
  await store.saveNowAsync();
  expect(Object.keys(reload().getSessions())).toEqual([]);
});
it.each(['write', 'rename-ack', 'directory-sync'])(
  'reports the actual %s error and restores historical primary bytes before draining later edits',
  async (fault) => {
    const previous = fs.readFileSync(path, 'utf8');
    io.failure = fault;
    const entered = hold(fault === 'write' ? 'write' : 'rename');
    const committing = store.persistSessionDurably(ID, tentative());
    const failure = expect(committing).rejects.toBe(io.error);
    await reached(entered, committing);
    store.setSession(OTHER, { ...historical, id: OTHER, name: 'Queued after failure' });
    const saving = store.saveNowAsync();
    release!();
    await failure;
    // The queued save must survive the rejected restore's queue latch.
    await saving;
    expect(store.getSession(ID)).toEqual(historical);
    expect(reload().getSession(ID)).toEqual(historical);
    expect(reload().getSession(OTHER)?.name).toBe('Queued after failure');
    expect(previous).toContain('Historical');
  }
);
it.each(['replacement', 'in-place'])(
  'preserves an external %s during rollback staging instead of restoring stale backup bytes',
  async (change) => {
    const entered = hold('rollback-write');
    io.failure = 'directory-sync';
    const committing = store.persistSessionDurably(ID, tentative());
    const failure = expect(committing).rejects.toBe(io.error);
    await reached(entered, committing);
    const external = JSON.parse(fs.readFileSync(path, 'utf8'));
    external.sessions[ID].name = 'External writer';
    const bytes = JSON.stringify(external);
    if (change === 'replacement') {
      await fsp.writeFile(path + '.foreign', bytes);
      await fsp.rename(path + '.foreign', path);
    } else await fsp.writeFile(path, bytes);
    release!();
    await failure;
    expect(fs.readFileSync(path, 'utf8')).toBe(bytes);
    expect(store.getSession(ID)).toEqual(historical);
    expect(Reflect.get(store, 'circuitBreakerOpen')).toBe(true);
    store.setSession(OTHER, { ...historical, id: OTHER });
    await store.saveNowAsync();
    expect(fs.readFileSync(path, 'utf8')).toBe(bytes);
  }
);
it('keeps shutdown pending through a held commit and queued owner save', async () => {
  const entered = hold('write');
  const committing = store.persistSessionDurably(ID, tentative());
  await reached(entered, committing);
  store.setSession(OTHER, { ...historical, id: OTHER, name: 'Shutdown edit' });
  let stopped = false;
  const stopping = store.flushAllAsync().then(() => {
    stopped = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(stopped).toBe(false);
  release!();
  await committing;
  await stopping;
  expect(reload().getSession(ID)).toEqual(tentative());
  expect(reload().getSession(OTHER)?.name).toBe('Shutdown edit');
});

it.each(['replacement', 'in-place'])(
  'rechecks primary identity after a held final rollback proof close (%s)',
  async (change) => {
    const entered = hold('rollback-proof-close');
    io.failure = 'directory-sync';
    const committing = store.persistSessionDurably(ID, tentative());
    const failure = expect(committing).rejects.toBe(io.error);
    await reached(entered, committing);
    const external = JSON.parse(fs.readFileSync(path, 'utf8'));
    external.sessions[ID].name = 'Changed during final FD close';
    const bytes = JSON.stringify(external);
    if (change === 'replacement') {
      await fsp.writeFile(path + '.foreign', bytes);
      await fsp.rename(path + '.foreign', path);
    } else await fsp.writeFile(path, bytes);
    release!();
    await failure;
    expect(fs.readFileSync(path, 'utf8')).toBe(bytes);
    expect(store.getSession(ID)).toEqual(historical);
    expect(io.commits).toBe(1);
  }
);
it.each(['malformed', 'unreadable'])(
  'preserves a %s initial primary through failed restore and automatic flush',
  async (kind) => {
    const bytes = kind === 'malformed' ? '{malformed primary' : 'unreadable';
    if (kind === 'malformed') await fsp.writeFile(path, bytes);
    else {
      await fsp.unlink(path);
      await fsp.mkdir(path);
    }
    await expect(store.persistSessionDurably(ID, tentative())).rejects.toThrow();
    store.setSession(OTHER, { ...historical, id: OTHER });
    await store.saveNowAsync();
    store.flush();
    expect(store.getSession(ID)).toEqual(historical);
    if (kind === 'malformed') expect(fs.readFileSync(path, 'utf8')).toBe(bytes);
    else expect(fs.statSync(path).isDirectory()).toBe(true);
    expect(Reflect.get(store, 'dirty')).toBe(true);
  }
);
it('refuses a replacement primary while the candidate is still staging', async () => {
  const entered = hold('write');
  const committing = store.persistSessionDurably(ID, tentative());
  const failure = expect(committing).rejects.toThrow('target changed');
  await reached(entered, committing);
  const external = JSON.parse(fs.readFileSync(path, 'utf8'));
  external.sessions[ID].name = 'External before candidate rename';
  const bytes = JSON.stringify(external);
  await fsp.writeFile(path + '.foreign', bytes);
  await fsp.rename(path + '.foreign', path);
  release!();
  await failure;
  store.flush();
  await store.saveNowAsync();
  expect(fs.readFileSync(path, 'utf8')).toBe(bytes);
  expect(store.getSession(ID)).toEqual(historical);
  expect(io.commits).toBe(0);
});

it('does not transfer a failed older ordinary save into the independent durable caller', async () => {
  const oldError = new Error('Older ordinary directory preparation failed');
  vi.spyOn(store as unknown as { ensureDir(): void }, 'ensureDir').mockImplementationOnce(() => {
    throw oldError;
  });
  store.setSession(OTHER, { ...historical, id: OTHER, name: 'New owner edit' });
  const older = store.saveNowAsync();
  const failed = expect(older).rejects.toBe(oldError);
  const committing = store.persistSessionDurably(ID, tentative());
  await failed;
  await committing;
  expect(reload().getSession(ID)).toEqual(tentative());
  expect(reload().getSession(OTHER)?.name).toBe('New owner edit');
});

it('preserves a foreign temporary file when strict state creation collides', async () => {
  const original = fs.readFileSync(path, 'utf8');
  io.failure = 'wx-collision';
  await expect(store.persistSessionDurably(ID, tentative())).rejects.toMatchObject({ code: 'EEXIST' });
  expect(fs.readFileSync(io.temporary, 'utf8')).toBe('foreign temporary');
  expect(fs.readFileSync(path, 'utf8')).toBe(original);
});
it('never publishes or removes a same-byte replacement of its strict candidate temporary inode', async () => {
  const original = fs.readFileSync(path, 'utf8'),
    entered = hold('close');
  const operation = store.persistSessionDurably(ID, tentative()),
    rejected = expect(operation).rejects.toThrow('staged file changed');
  await reached(entered, operation);
  const bytes = fs.readFileSync(io.temporary, 'utf8'),
    inode = fs.statSync(io.temporary).ino;
  const foreign = join(root, 'foreign-temporary');
  fs.writeFileSync(foreign, bytes);
  fs.renameSync(foreign, io.temporary);
  expect(fs.statSync(io.temporary).ino).not.toBe(inode);
  release!();
  await rejected;
  expect(fs.readFileSync(io.temporary, 'utf8')).toBe(bytes);
  expect(fs.readFileSync(path, 'utf8')).toBe(original);
  expect(io.commits).toBe(0);
});
it('refuses a foreign equal-byte rollback temporary instead of publishing or deleting it', async () => {
  const previous = fs.readFileSync(path, 'utf8');
  io.failure = 'directory-sync';
  const entered = hold('rollback-write');
  const operation = store.persistSessionDurably(ID, tentative()),
    rejected = expect(operation).rejects.toBe(io.error);
  await reached(entered, operation);
  // Pause occurs before this FileHandle writes; move its owned inode aside and
  // replace its pathname with the exact bytes that rollback is about to write.
  const bytes = previous;
  const foreign = join(root, 'foreign-rollback');
  fs.writeFileSync(foreign, bytes);
  fs.renameSync(foreign, io.temporary);
  release!();
  await rejected;
  expect(fs.readFileSync(io.temporary, 'utf8')).toBe(bytes);
  expect(JSON.parse(fs.readFileSync(path, 'utf8')).sessions[ID].name).toBe('Restored');
  expect(Reflect.get(store, 'circuitBreakerOpen')).toBe(true);
});
it('retains a primary replaced while its temporary proof descriptor closes', async () => {
  const entered = hold('temp-proof-close'),
    operation = store.persistSessionDurably(ID, tentative());
  const rejected = expect(operation).rejects.toThrow('target changed');
  await reached(entered, operation);
  const current = JSON.parse(fs.readFileSync(path, 'utf8'));
  current.sessions[ID].name = 'Foreign owner';
  const bytes = JSON.stringify(current),
    foreign = join(root, 'foreign-primary');
  fs.writeFileSync(foreign, bytes);
  fs.renameSync(foreign, path);
  release!();
  await rejected;
  expect(fs.readFileSync(path, 'utf8')).toBe(bytes);
  expect(io.commits).toBe(0);
  expect(Reflect.get(store, 'circuitBreakerOpen')).toBe(true);
});

it('does not reinterpret removal during the initial primary proof close as an absent original', async () => {
  const entered = hold('initial-proof-close'),
    operation = store.persistSessionDurably(ID, tentative());
  const rejected = expect(operation).rejects.toThrow('State file changed');
  await reached(entered, operation);
  fs.unlinkSync(path);
  release!();
  await rejected;
  expect(fs.existsSync(path)).toBe(false);
  expect(io.commits).toBe(0);
  expect(Reflect.get(store, 'circuitBreakerOpen')).toBe(true);
});
