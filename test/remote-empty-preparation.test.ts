/** Empty pre-file preparations, disposable directories only; no SSH/native/worker effects. */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CodexInputBroker } from '../src/recovery/codex-input-broker.js';
import { OwnedRemoteBrokerCache, type OwnedRemoteBrokerScope } from '../src/recovery/remote-input-broker-cache.js';
let root: string;
const releases: Array<() => void> = [];
const pending: Promise<unknown>[] = [];
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'empty-private-preparation-'));
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(pending.splice(0));
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
function fixture() {
  const scope: OwnedRemoteBrokerScope = {
    sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    owner: 'alice',
    workingDir: '/remote/work',
    codexHome: '/remote/home',
    remote: { hostId: 'fake', host: 'worker.invalid', username: 'runner', remotePath: '/remote/work', owned: true },
  };
  const directory = join(root, 'cache');
  return { scope, directory, cache: new OwnedRemoteBrokerCache(directory) };
}
function material(f: ReturnType<typeof fixture>) {
  return CodexInputBroker.provisioningMaterial(f.scope.sessionId, 'exec fake-worker', f.scope.codexHome);
}
async function failPrepare(
  f: ReturnType<typeof fixture>,
  fault:
    | 'ENOSPC'
    | 'EACCES'
    | 'inode'
    | 'nonempty'
    | 'replacement'
    | 'session-replacement'
    | 'stat'
    | 'held'
    | 'root-ack' = 'ENOSPC'
) {
  const m = material(f),
    inc = join(f.directory, f.scope.sessionId, m.config.incarnation),
    file = join(inc, 'private.json');
  const open = fs.open.bind(fs),
    lstat = fs.lstat.bind(fs),
    discard = f.cache.discardUnreservedPreparation.bind(f.cache);
  let done!: (value: boolean) => void,
    arrived!: () => void,
    release!: () => void,
    receipt: Parameters<typeof discard>[1] | undefined;
  const completed = new Promise<boolean>((resolve) => (done = resolve)),
    at = new Promise<void>((resolve) => (arrived = resolve)),
    held = new Promise<void>((resolve) => (release = resolve));
  releases.push(release);
  pending.push(completed);
  const seen = vi.spyOn(f.cache, 'discardUnreservedPreparation').mockImplementation(async (...args) => {
    receipt = args[1];
    const result = await discard(...args);
    done(result);
    return result;
  });
  let injected = false;
  const stat = vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
    if (fault === 'stat' && !injected && String(args[0]) === inc) {
      injected = true;
      throw Error('Initial owned inode unreadable');
    }
    return lstat(...args);
  });
  const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    if (String(args[0]) === file && (Number(args[1]) & constants.O_CREAT) !== 0) {
      if (fault === 'inode') {
        const handle = await open(...args);
        handle.stat = async () => {
          throw Error('Opened inode unknown');
        };
        return handle;
      }
      if (fault === 'nonempty') await fs.writeFile(join(inc, 'keep'), 'foreign content');
      if (fault === 'replacement') {
        await fs.rename(inc, inc + '.owned');
        await fs.mkdir(inc, { mode: 0o700 });
        await fs.writeFile(join(inc, 'keep'), 'replacement incarnation');
      }
      if (fault === 'session-replacement') {
        const parent = join(f.directory, f.scope.sessionId);
        await fs.rename(parent, parent + '.owned');
        await fs.mkdir(inc, { recursive: true, mode: 0o700 });
        await fs.writeFile(join(inc, 'keep'), 'replacement session');
      }
      throw Object.assign(Error('Private file open refused'), { code: fault === 'EACCES' ? 'EACCES' : 'ENOSPC' });
    }
    const handle = await open(...args);
    if (fault === 'held' && String(args[0]) === inc && (Number(args[1]) & constants.O_DIRECTORY) !== 0) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        arrived();
        await held;
        return sync();
      };
    }
    if (fault === 'root-ack' && String(args[0]) === f.directory && (Number(args[1]) & constants.O_DIRECTORY) !== 0) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        if (!injected) {
          injected = true;
          throw Error('Root removal ACK lost');
        }
        return sync();
      };
    }
    return handle;
  });
  const work = f.cache.prepare(f.scope, m, '/remote/private/' + f.scope.sessionId + '/' + m.config.incarnation);
  expect(await work).toBeUndefined();
  if (fault !== 'held') await completed;
  return {
    m,
    inc,
    file,
    completed,
    at,
    release,
    get receipt() {
      return receipt!;
    },
    restore() {
      spy.mockRestore();
      stat.mockRestore();
      seen.mockRestore();
    },
  };
}
it.each(['ENOSPC', 'EACCES'] as const)(
  'removes new exact empty directories after private open %s and permits repeated retries/reload',
  async (fault) => {
    const f = fixture();
    for (let index = 0; index < 4; index++) {
      const failed = await failPrepare(f, fault);
      expect(await failed.completed).toBe(true);
      await expect(fs.lstat(failed.inc)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.lstat(join(f.directory, f.scope.sessionId))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((Reflect.get(f.cache, 'canceledPreparations') as Map<string, unknown>).size).toBe(0);
      failed.restore();
    }
    const m = material(f),
      descriptor = await f.cache.prepare(
        f.scope,
        m,
        '/remote/private/' + f.scope.sessionId + '/' + m.config.incarnation
      );
    expect(descriptor).toBeDefined();
    expect(await new OwnedRemoteBrokerCache(f.directory).load(f.scope, m.config.incarnation)).toEqual(descriptor);
  }
);
it.each(['stat', 'inode', 'nonempty', 'replacement', 'session-replacement'] as const)(
  'preserves %s uncertainty and its capacity receipt across retirement',
  async (fault) => {
    const f = fixture(),
      failed = await failPrepare(f, fault);
    expect(await failed.completed).toBe(false);
    expect((await fs.lstat(failed.inc)).isDirectory()).toBe(true);
    expect((Reflect.get(f.cache, 'canceledPreparations') as Map<string, unknown>).size).toBe(1);
    f.cache.retire(f.scope.sessionId);
    expect((Reflect.get(f.cache, 'canceledPreparations') as Map<string, unknown>).size).toBe(1);
    if (fault === 'replacement' || fault === 'session-replacement')
      expect(await fs.readFile(join(failed.inc, 'keep'), 'utf8')).toContain('replacement');
    if (fault === 'nonempty') expect(await fs.readFile(join(failed.inc, 'keep'), 'utf8')).toBe('foreign content');
    failed.restore();
  }
);
it('does not remove preexisting empty directories on a known-unsent open failure', async () => {
  const f = fixture(),
    m = material(f),
    inc = join(f.directory, f.scope.sessionId, m.config.incarnation);
  await fs.mkdir(inc, { recursive: true, mode: 0o700 });
  const before = await fs.lstat(inc),
    parent = await fs.lstat(join(f.directory, f.scope.sessionId));
  const open = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    if (String(args[0]) === join(inc, 'private.json')) throw Object.assign(Error('No space'), { code: 'ENOSPC' });
    return open(...args);
  });
  expect(
    await f.cache.prepare(f.scope, m, '/remote/private/' + f.scope.sessionId + '/' + m.config.incarnation)
  ).toBeUndefined();
  expect((await fs.lstat(inc)).ino).toBe(before.ino);
  expect((await fs.lstat(join(f.directory, f.scope.sessionId))).ino).toBe(parent.ino);
});
it('retains a held cleanup and refuses sealed/reserved rollback before directory removal', async () => {
  const f = fixture(),
    failed = await failPrepare(f, 'held');
  await failed.at;
  expect((await fs.lstat(failed.inc)).isDirectory()).toBe(true);
  f.cache.retire(f.scope.sessionId);
  f.cache.sealPreparation(failed.receipt);
  failed.release();
  expect(await failed.completed).toBe(false);
  expect((await fs.lstat(failed.inc)).isDirectory()).toBe(true);
  failed.restore();
});
it('retries an exact removed-parent ACK without reviving or adopting directory ownership', async () => {
  const f = fixture(),
    failed = await failPrepare(f, 'root-ack');
  expect(await failed.completed).toBe(false);
  await expect(fs.lstat(join(f.directory, f.scope.sessionId))).rejects.toMatchObject({ code: 'ENOENT' });
  failed.restore();
  expect(await f.cache.discardUnreservedPreparation(f.scope, failed.receipt)).toBe(true);
  expect((Reflect.get(f.cache, 'canceledPreparations') as Map<string, unknown>).size).toBe(0);
});
it('a new cache cannot evade capacity by repeatedly adding incomplete directories', async () => {
  const f = fixture();
  for (let index = 0; index < 2; index++) {
    const failed = await failPrepare(f, 'stat');
    expect(await failed.completed).toBe(false);
    failed.restore();
  }
  const before = await fs.readdir(join(f.directory, f.scope.sessionId));
  expect(before).toHaveLength(2);
  const fresh = new OwnedRemoteBrokerCache(f.directory),
    m = material(f);
  expect(
    await fresh.prepare(f.scope, m, '/remote/private/' + f.scope.sessionId + '/' + m.config.incarnation)
  ).toBeUndefined();
  expect(await fs.readdir(join(f.directory, f.scope.sessionId))).toEqual(before);
});
