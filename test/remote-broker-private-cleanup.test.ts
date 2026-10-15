/** Disposable local cache files only; no remote process or pane effects. */
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OwnedRemoteBrokerCache, type OwnedRemoteBrokerScope } from '../src/recovery/remote-input-broker-cache.js';
import { CodexInputBroker } from '../src/recovery/codex-input-broker.js';
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'broker-private-cleanup-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await fs.rm(root, { recursive: true, force: true });
});
function fixture() {
  const scope: OwnedRemoteBrokerScope = {
    sessionId: randomUUID(),
    workingDir: '/worker/work',
    codexHome: '/worker/home',
    owner: 'fixture',
    remote: {
      hostId: 'fixture',
      label: 'Fixture',
      host: 'worker.invalid',
      username: 'fixture',
      owned: true,
      remotePath: '/worker/work',
    },
  };
  const material = CodexInputBroker.provisioningMaterial(scope.sessionId, 'exec fake-child', scope.codexHome);
  const cacheRoot = join(root, 'cache'),
    cache = new OwnedRemoteBrokerCache(cacheRoot);
  const directory = '/worker/brokers/' + scope.sessionId + '/' + material.config.incarnation;
  const file = join(cacheRoot, scope.sessionId, material.config.incarnation, 'private.json');
  return {
    scope,
    material,
    cacheRoot,
    cache,
    directory,
    file,
    prepare: () => cache.prepare(scope, material, directory),
  };
}
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
it('removes exact current and superseded local private material, preserving unrelated session bytes', async () => {
  const f = fixture(),
    other = fixture();
  expect(await f.prepare()).toBeDefined();
  expect(await other.prepare()).toBeDefined();
  const otherBytes = await fs.readFile(other.file);
  const next = CodexInputBroker.provisioningMaterial(f.scope.sessionId, 'exec next', f.scope.codexHome);
  expect(
    await f.cache.prepare(f.scope, next, '/worker/brokers/' + f.scope.sessionId + '/' + next.config.incarnation)
  ).toBeDefined();
  expect(f.cache.activate(f.scope, next.config.incarnation)).toBe(true);
  expect(await f.cache.retireAndDelete(f.scope.sessionId, () => true)).toBe(true);
  await expect(fs.lstat(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(
    fs.lstat(join(f.cacheRoot, f.scope.sessionId, next.config.incarnation, 'private.json'))
  ).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await f.cache.load(f.scope, next.config.incarnation)).toBeUndefined();
  expect(await fs.readFile(other.file)).toEqual(otherBytes);
  expect(other.cache.get(other.scope, other.material.config.incarnation)).toBeDefined();
});
it('can certify retained private material after a fresh cache instance loses its memory', async () => {
  const f = fixture();
  expect(await f.prepare()).toBeDefined();
  const restarted = new OwnedRemoteBrokerCache(f.cacheRoot);
  expect(await restarted.retireAndDelete(f.scope.sessionId, () => true)).toBe(true);
  expect(await restarted.load(f.scope, f.material.config.incarnation)).toBeUndefined();
});
it.each([
  'malformed',
  'extra',
  'wrong-session',
  'wrong-incarnation',
  'wrong-helper',
  'wrong-key',
  'public-file',
  'public-parent',
  'symlink',
] as const)('retains unknown %s material without lending authority', async (fault) => {
  const f = fixture();
  await f.prepare();
  if (fault === 'public-file') await fs.chmod(f.file, 0o644);
  else if (fault === 'public-parent') await fs.chmod(join(f.cacheRoot, f.scope.sessionId), 0o755);
  else if (fault === 'symlink') {
    await fs.rename(f.file, f.file + '.original');
    await fs.symlink(f.file + '.original', f.file);
  } else if (fault === 'malformed') await fs.writeFile(f.file, '{unknown');
  else {
    const value = JSON.parse(await fs.readFile(f.file, 'utf8'));
    if (fault === 'extra') value.extra = true;
    if (fault === 'wrong-session') value.material.config.sessionId = randomUUID();
    if (fault === 'wrong-incarnation') value.material.config.incarnation = randomUUID();
    if (fault === 'wrong-helper') value.material.helper = 'untrusted code';
    if (fault === 'wrong-key') value.material.config.secret = 'not-a-key';
    await fs.writeFile(f.file, JSON.stringify(value));
  }
  const bytes = await fs.readFile(f.file);
  expect(await f.cache.retireAndDelete(f.scope.sessionId, () => true)).toBe(false);
  expect(await fs.readFile(f.file)).toEqual(bytes);
  expect(f.cache.get(f.scope, f.material.config.incarnation)).toBeUndefined();
});
it('waits the actual held private write before deletion and refuses new grants until completion', async () => {
  const f = fixture(),
    entered = barrier(),
    release = barrier();
  const open = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[0] === f.file) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (...args: Parameters<typeof write>) => {
        entered.release();
        await release.promise;
        return write(...args);
      };
    }
    return handle;
  });
  const preparing = f.prepare();
  await entered.promise;
  const deleting = f.cache.retireAndDelete(f.scope.sessionId, () => true);
  expect(await f.cache.load(f.scope, f.material.config.incarnation)).toBeUndefined();
  const next = CodexInputBroker.provisioningMaterial(f.scope.sessionId, 'exec new grant', f.scope.codexHome);
  expect(
    await f.cache.prepare(f.scope, next, '/worker/brokers/' + f.scope.sessionId + '/' + next.config.incarnation)
  ).toBeUndefined();
  release.release();
  expect(await preparing).toBeUndefined();
  expect(await deleting).toBe(true);
  await expect(fs.lstat(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
  vi.restoreAllMocks();
  expect(
    await f.cache.prepare(f.scope, next, '/worker/brokers/' + f.scope.sessionId + '/' + next.config.incarnation)
  ).toBeDefined();
});
it.each(['caller', 'same-bytes-replacement', 'symlink-replacement'] as const)(
  'preserves %s changes during a private file proof close',
  async (fault) => {
    const f = fixture();
    await f.prepare();
    const original = await fs.readFile(f.file);
    let current = true;
    const open = fs.open.bind(fs);
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === f.file) {
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          if (fault === 'caller') current = false;
          else {
            await fs.rename(f.file, f.file + '.old');
            if (fault === 'same-bytes-replacement') await fs.writeFile(f.file, original, { mode: 0o600 });
            else await fs.symlink(f.file + '.old', f.file);
          }
        };
      }
      return handle;
    });
    expect(await f.cache.retireAndDelete(f.scope.sessionId, () => current)).toBe(false);
    spy.mockRestore();
    expect(await fs.readFile(f.file)).toEqual(original);
    if (fault === 'symlink-replacement') expect((await fs.lstat(f.file)).isSymbolicLink()).toBe(true);
  }
);
it('times out without deleting after a held write, retains its cleanup lease until actual settlement', async () => {
  const f = fixture(),
    entered = barrier(),
    release = barrier(),
    closed = barrier();
  const open = fs.open.bind(fs);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[0] === f.file) {
      const write = handle.writeFile.bind(handle),
        close = handle.close.bind(handle);
      handle.writeFile = async (...args: Parameters<typeof write>) => {
        entered.release();
        await release.promise;
        return write(...args);
      };
      handle.close = async () => {
        await close();
        closed.release();
      };
    }
    return handle;
  });
  const preparing = f.prepare();
  await entered.promise;
  const deleting = f.cache.retireAndDelete(f.scope.sessionId, () => true);
  await vi.advanceTimersByTimeAsync(2001);
  expect(await preparing).toBeUndefined();
  expect(await deleting).toBe(false);
  expect(await f.cache.load(f.scope, f.material.config.incarnation)).toBeUndefined();
  release.release();
  await closed.promise;
  // The expired cleanup may finish its retained job, but cannot start an unlink.
  const until = process.hrtime.bigint() + 2_000_000_000n;
  while ((Reflect.get(f.cache, 'deletions') as Map<string, object>).size && process.hrtime.bigint() < until)
    await new Promise<void>((resolve) => setImmediate(resolve));
  expect((Reflect.get(f.cache, 'deletions') as Map<string, object>).size).toBe(0);
  vi.useRealTimers();
  expect(await fs.readFile(f.file, 'utf8')).toContain(f.material.config.secret);
});
