/** Source-host private cache only, under a disposable HOME; no SSH/tmux/CLI effects. */
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CodexInputBroker, type CodexBrokerState } from '../src/recovery/codex-input-broker.js';
import { OwnedRemoteBrokerCache, type OwnedRemoteBrokerScope } from '../src/recovery/remote-input-broker-cache.js';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(homedir(), 'remote-cache-fixture-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
function fixture() {
  const scope: OwnedRemoteBrokerScope = {
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    workingDir: '/worker/work',
    codexHome: '/worker/private-codex',
    owner: 'fixture-owner',
    remote: {
      hostId: 'fixture',
      host: 'worker.invalid',
      username: 'fixture',
      label: 'Fixture',
      remotePath: '/worker/work',
      owned: true,
    },
  };
  const material = CodexInputBroker.provisioningMaterial(scope.sessionId, 'exec fake-cli', scope.codexHome);
  const remoteDirectory = '/remote/private/' + scope.sessionId + '/' + material.config.incarnation;
  const cache = new OwnedRemoteBrokerCache(join(root, 'cache'));
  const file = join(root, 'cache', scope.sessionId, material.config.incarnation, 'private.json');
  const state: CodexBrokerState = {
    version: 1,
    sessionId: scope.sessionId,
    incarnation: material.config.incarnation,
    pid: 700,
    childPid: 701,
    brokerStart: '123',
    childStart: '124',
    startup: { nonce: material.config.startup.nonce, status: 'started' },
    tainted: false,
    rawGeneration: 0,
    launchDigest: material.config.launchDigest,
    homeDigest: material.config.homeDigest,
    closed: false,
    exitStatus: null,
    exitSignal: null,
    counters: { 'owner-pty': 0, 'owner-key': 0, 'owner-mux': 0, auto: 0, probe: 0 },
    receipts: [],
  };
  const snapshot = () => {
    const serialized = JSON.stringify(state);
    return {
      serialized,
      witness: {
        path: remoteDirectory + '/state.json',
        dev: 1,
        ino: 2,
        size: Buffer.byteLength(serialized),
        mtimeMs: 3,
        ctimeMs: 4,
        hash: createHash('sha256').update(serialized).digest('hex'),
        maxBytes: 98304,
      },
    };
  };
  const observe = (using = cache) => {
    const sample = snapshot();
    return using.observe(scope, material.config.incarnation, sample.serialized, sample.witness, 700);
  };
  return { scope, material, remoteDirectory, cache, file, state, observe };
}

it('retains private launch material and returns only a secret-free reader descriptor', async () => {
  const f = fixture();
  const descriptor = await f.cache.prepare(f.scope, f.material, f.remoteDirectory);
  expect(descriptor).toMatchObject({
    directory: f.remoteDirectory,
    incarnation: f.material.config.incarnation,
    homeDigest: f.material.config.homeDigest,
  });
  expect(JSON.stringify(descriptor)).not.toContain(f.material.config.secret);
  expect(JSON.stringify(descriptor)).not.toContain(root);
  expect((await fs.stat(f.file)).mode & 0o777).toBe(0o600);
  for (const path of [
    join(root, 'cache'),
    join(root, 'cache', f.scope.sessionId),
    join(root, 'cache', f.scope.sessionId, f.material.config.incarnation),
  ])
    expect((await fs.stat(path)).mode & 0o777).toBe(0o700);
  expect(JSON.parse(await fs.readFile(f.file, 'utf8')).material.config.secret).toBe(f.material.config.secret);
  const reload = new OwnedRemoteBrokerCache(join(root, 'cache'));
  expect(await reload.load(f.scope, f.material.config.incarnation)).toEqual(descriptor);
  expect(f.observe(reload)).toBeDefined();
});

it('an existing remote pane or unknown incarnation cannot supply missing source-host material', async () => {
  const f = fixture();
  expect(await f.cache.load(f.scope, f.material.config.incarnation)).toBeUndefined();
  expect(f.cache.get(f.scope, f.material.config.incarnation)).toBeUndefined();
  expect(f.observe()).toBeUndefined();
  expect(
    await fs.access(f.file).then(
      () => true,
      () => false
    )
  ).toBe(false);
});

it('missing unowned material returns inspection-only without a cache entry', async () => {
  const f = fixture();
  f.scope.remote.owned = false;
  expect(f.cache.get(f.scope, f.material.config.incarnation)).toBeUndefined();
  expect(f.cache.signer(f.scope, f.material.config.incarnation)).toBeUndefined();
  expect(await f.cache.load(f.scope, f.material.config.incarnation)).toBeUndefined();
  expect(await f.cache.prepare(f.scope, f.material, f.remoteDirectory)).toBeUndefined();
});

it('repeated load/observe retains the exact signer and its pending owner counter', async () => {
  const f = fixture();
  await f.cache.prepare(f.scope, f.material, f.remoteDirectory);
  expect(f.observe()).toBeDefined();
  const signer = f.cache.signer(f.scope, f.material.config.incarnation)!;
  const first = signer.frame('owner-pty', 'owner draft')!;
  for (let repeat = 0; repeat < 3; repeat++) {
    await f.cache.load(f.scope, f.material.config.incarnation);
    expect(f.observe()).toBeUndefined();
    expect(f.cache.signer(f.scope, f.material.config.incarnation)).toBe(signer);
  }
  f.state.counters['owner-pty'] = first.receipt.counter;
  f.state.receipts.push({ ...first.receipt, status: 'sent' });
  expect(f.observe()).toBeDefined();
  expect(signer.frame('owner-pty', 'next')?.receipt.counter).toBe(2);
});

it('scope serialization order does not change a retained host/home identity', async () => {
  const f = fixture();
  await f.cache.prepare(f.scope, f.material, f.remoteDirectory);
  const reordered = Object.fromEntries(Object.entries(f.scope).reverse()) as unknown as OwnedRemoteBrokerScope;
  reordered.remote = Object.fromEntries(
    Object.entries(f.scope.remote).reverse()
  ) as unknown as OwnedRemoteBrokerScope['remote'];
  expect(
    await new OwnedRemoteBrokerCache(join(root, 'cache')).load(reordered, f.material.config.incarnation)
  ).toBeDefined();
});

it.each(['host', 'owner', 'home', 'cwd', 'unowned', 'incarnation'] as const)(
  'a changed %s cannot load or reuse a launch signer',
  async (change) => {
    const f = fixture();
    await f.cache.prepare(f.scope, f.material, f.remoteDirectory);
    expect(f.observe()).toBeDefined();
    if (change === 'host') f.scope.remote.host = 'replacement.invalid';
    if (change === 'owner') f.scope.owner = 'replacement-owner';
    if (change === 'home') f.scope.codexHome = '/other/home';
    if (change === 'cwd') f.scope.workingDir = '/other/work';
    if (change === 'unowned') f.scope.remote.owned = false;
    const incarnation =
      change === 'incarnation' ? 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff' : f.material.config.incarnation;
    expect(f.cache.get(f.scope, incarnation)).toBeUndefined();
    expect(f.cache.signer(f.scope, incarnation)).toBeUndefined();
    expect(await new OwnedRemoteBrokerCache(join(root, 'cache')).load(f.scope, incarnation)).toBeUndefined();
  }
);

it.each([
  'public-file',
  'public-parent',
  'symlink-file',
  'malformed',
  'extra',
  'wrong-key',
  'wrong-home',
  'null-startup',
] as const)('private cache %s cannot become remote provenance', async (change) => {
  const f = fixture();
  await f.cache.prepare(f.scope, f.material, f.remoteDirectory);
  if (change === 'public-file') await fs.chmod(f.file, 0o644);
  if (change === 'public-parent') await fs.chmod(join(root, 'cache', f.scope.sessionId), 0o755);
  if (change === 'symlink-file') {
    await fs.rename(f.file, f.file + '.target');
    await fs.symlink(f.file + '.target', f.file);
  }
  if (change === 'malformed') await fs.writeFile(f.file, '{incomplete');
  if (['extra', 'wrong-key', 'wrong-home', 'null-startup'].includes(change)) {
    const value = JSON.parse(await fs.readFile(f.file, 'utf8'));
    if (change === 'extra') value.extra = true;
    if (change === 'wrong-key') value.material.config.secret = 'malformed';
    if (change === 'wrong-home') value.material.config.homeDigest = '0'.repeat(64);
    if (change === 'null-startup') value.material.config.startup = null;
    await fs.writeFile(f.file, JSON.stringify(value));
  }
  expect(
    await new OwnedRemoteBrokerCache(join(root, 'cache')).load(f.scope, f.material.config.incarnation)
  ).toBeUndefined();
});

it('never overwrites the same incarnation but allows a separately controlled fresh incarnation', async () => {
  const f = fixture();
  expect(await f.cache.prepare(f.scope, f.material, f.remoteDirectory)).toBeDefined();
  const retained = await fs.readFile(f.file, 'utf8');
  expect(await f.cache.prepare(f.scope, f.material, f.remoteDirectory)).toBeUndefined();
  expect(await fs.readFile(f.file, 'utf8')).toBe(retained);
  const next = CodexInputBroker.provisioningMaterial(f.scope.sessionId, 'exec exact-resume-cli', f.scope.codexHome);
  const directory = '/remote/private/' + f.scope.sessionId + '/' + next.config.incarnation;
  expect(await f.cache.prepare(f.scope, next, directory)).toBeDefined();
  expect(f.cache.get(f.scope, f.material.config.incarnation)).toBeDefined();
  expect(f.cache.activate(f.scope, next.config.incarnation)).toBe(true);
  expect(f.cache.get(f.scope, f.material.config.incarnation)).toBeUndefined();
  expect(await fs.readFile(f.file, 'utf8')).toBe(retained);
});

it('retains the old exact signer and pending owner intent while a new incarnation is reserved', async () => {
  const f = fixture();
  await f.cache.prepare(f.scope, f.material, f.remoteDirectory);
  const oldProof = f.observe()!;
  const signer = f.cache.signer(f.scope, f.material.config.incarnation)!;
  expect(signer.authority(oldProof)).toBeDefined();
  expect(signer.frame('owner-key', '\r')).toBeDefined();
  const next = CodexInputBroker.provisioningMaterial(f.scope.sessionId, 'exec replacement', f.scope.codexHome);
  const directory = '/remote/private/' + f.scope.sessionId + '/' + next.config.incarnation;
  expect(await f.cache.prepare(f.scope, next, directory)).toBeDefined();
  expect(f.cache.signer(f.scope, f.material.config.incarnation)).toBe(signer);
  expect(signer.authority(oldProof)).toBeUndefined();
  expect(f.observe()).toBeUndefined();
  // A third preparation cannot evict an unresolved old/new pair.
  const third = CodexInputBroker.provisioningMaterial(f.scope.sessionId, 'exec another', f.scope.codexHome);
  expect(
    await f.cache.prepare(f.scope, third, '/remote/private/' + f.scope.sessionId + '/' + third.config.incarnation)
  ).toBeUndefined();
  expect(f.cache.activate({ ...f.scope, owner: 'replacement' }, next.config.incarnation)).toBe(false);
  expect(f.cache.signer(f.scope, f.material.config.incarnation)).toBe(signer);
});

it.each(['read', 'close'] as const)(
  'a stalled private %s returns on its original deadline and retains both reader slots',
  async (hold) => {
    const fixtures = [fixture(), fixture(), fixture()];
    for (const f of fixtures) expect(await f.cache.prepare(f.scope, f.material, f.remoteDirectory)).toBeDefined();
    const original = fs.open.bind(fs);
    const releases: Array<() => void> = [];
    let held = 0,
      closed = 0;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await original(...args);
      if (!fixtures.slice(0, 2).some((f) => args[0] === f.file)) return handle;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      releases.push(release);
      return {
        stat: handle.stat.bind(handle),
        read: async (...input: Parameters<typeof handle.read>) => {
          if (hold === 'read') {
            held++;
            await barrier;
          }
          return handle.read(...input);
        },
        close: async () => {
          if (hold === 'close') {
            held++;
            await barrier;
          }
          await handle.close();
          closed++;
        },
      } as unknown as typeof handle;
    });
    const loads = fixtures
      .slice(0, 2)
      .map((f) => new OwnedRemoteBrokerCache(join(root, 'cache')).load(f.scope, f.material.config.incarnation));
    try {
      for (let turn = 0; turn < 1000 && held !== 2; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
      expect(held).toBe(2);
      await vi.advanceTimersByTimeAsync(2001);
      expect(await Promise.all(loads)).toEqual([undefined, undefined]);
      const f = fixtures[2];
      const openCount = vi.mocked(fs.open).mock.calls.length;
      expect(
        await new OwnedRemoteBrokerCache(join(root, 'cache')).load(f.scope, f.material.config.incarnation)
      ).toBeUndefined();
      expect(vi.mocked(fs.open).mock.calls).toHaveLength(openCount);
      expect(closed).toBe(0);
      releases.forEach((release) => release());
      for (let turn = 0; turn < 1000 && closed !== 2; turn++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closed).toBe(2);
      // Final path checks must also settle before the same slot can be reused.
      for (let turn = 0; turn < 20; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
      expect(
        await new OwnedRemoteBrokerCache(join(root, 'cache')).load(f.scope, f.material.config.incarnation)
      ).toBeDefined();
    } finally {
      releases.forEach((release) => release());
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  }
);
