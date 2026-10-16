/** Source-host private cache only, under a disposable HOME; no SSH/tmux/CLI effects. */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as realTimeout, clearTimeout as clearRealTimeout } from 'node:timers';
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
  return { scope, material, remoteDirectory, cache, file, state, observe, snapshot };
}

async function partialPreparation(
  f: ReturnType<typeof fixture>,
  material: ReturnType<typeof CodexInputBroker.provisioningMaterial>,
  length: number,
  fault?: 'same-bytes' | 'symlink' | 'parent' | 'unknown-read' | 'unknown-bytes' | 'sealed'
) {
  const path = join(root, 'cache', f.scope.sessionId, material.config.incarnation, 'private.json');
  const open = fs.open.bind(fs),
    discard = f.cache.discardUnreservedPreparation.bind(f.cache);
  let finish!: (result: boolean) => void;
  const cleaned = new Promise<boolean>((resolve) => (finish = resolve));
  const discardSpy = vi.spyOn(f.cache, 'discardUnreservedPreparation').mockImplementation(async (...args) => {
    const completedWrite = (Reflect.get(f.cache, 'preparations') as WeakMap<object, unknown>).has(args[1]);
    if (fault === 'sealed' && completedWrite) f.cache.sealPreparation(args[1]);
    const result = await discard(...args);
    if (completedWrite) finish(result);
    return result;
  });
  const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[0] !== path || typeof args[1] !== 'number' || !(args[1] & constants.O_CREAT)) return handle;
    const write = handle.writeFile.bind(handle),
      close = handle.close.bind(handle);
    handle.writeFile = async (data) => {
      const prefix = Buffer.from(data as Buffer).subarray(0, length);
      await write(fault === 'unknown-bytes' ? Buffer.alloc(length, 120) : prefix);
      throw Object.assign(Error('Disposable disk full'), { code: 'ENOSPC' });
    };
    if (fault === 'unknown-read')
      handle.read = async () => {
        throw Error('Unreadable partial file');
      };
    handle.close = async () => {
      await close();
      if (fault === 'same-bytes' || fault === 'symlink') {
        await fs.rename(path, path + '.owned');
        if (fault === 'same-bytes') await fs.writeFile(path, await fs.readFile(path + '.owned'), { mode: 0o600 });
        else await fs.symlink(path + '.owned', path);
      }
      if (fault === 'parent') {
        const parent = join(root, 'cache', f.scope.sessionId, material.config.incarnation);
        await fs.rename(parent, parent + '.owned');
        await fs.mkdir(parent, { mode: 0o700 });
        await fs.writeFile(path, 'foreign parent bytes', { mode: 0o600 });
      }
    };
    return handle;
  });
  try {
    expect(
      await f.cache.prepare(
        f.scope,
        material,
        '/remote/private/' + f.scope.sessionId + '/' + material.config.incarnation
      )
    ).toBeUndefined();
    expect(f.cache.get(f.scope, material.config.incarnation)).toBeUndefined();
    let timer: ReturnType<typeof realTimeout> | undefined;
    const result = await Promise.race([
      cleaned,
      new Promise<string>((resolve) => {
        timer = realTimeout(() => resolve('cleanup missing'), 2000);
      }),
    ]).finally(() => {
      if (timer) clearRealTimeout(timer);
    });
    return { result, path };
  } finally {
    spy.mockRestore();
    discardSpy.mockRestore();
  }
}

it.each([0, 128])('cleans an exact %i-byte ENOSPC artifact and releases capacity before reload', async (length) => {
  const f = fixture();
  const failed = [
    f.material,
    CodexInputBroker.provisioningMaterial(f.scope.sessionId, 'exec second', f.scope.codexHome),
  ];
  for (const material of failed) {
    const attempt = await partialPreparation(f, material, length);
    expect(attempt.result).toBe(true);
    await expect(fs.lstat(attempt.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((Reflect.get(f.cache, 'canceledPreparations') as Map<string, unknown>).size).toBe(0);
    expect(
      await new OwnedRemoteBrokerCache(join(root, 'cache')).load(f.scope, material.config.incarnation)
    ).toBeUndefined();
  }
  const healthy = CodexInputBroker.provisioningMaterial(f.scope.sessionId, 'exec healthy', f.scope.codexHome);
  const descriptor = await f.cache.prepare(
    f.scope,
    healthy,
    '/remote/private/' + f.scope.sessionId + '/' + healthy.config.incarnation
  );
  expect(descriptor).toBeDefined();
  expect(await new OwnedRemoteBrokerCache(join(root, 'cache')).load(f.scope, healthy.config.incarnation)).toEqual(
    descriptor
  );
});

it.each(['same-bytes', 'symlink', 'parent', 'unknown-read', 'unknown-bytes', 'sealed'] as const)(
  'preserves a failed partial preparation after %s veto',
  async (fault) => {
    const f = fixture();
    const attempt = await partialPreparation(f, f.material, 128, fault);
    expect(attempt.result).toBe(false);
    expect((Reflect.get(f.cache, 'canceledPreparations') as Map<string, unknown>).size).toBe(1);
    expect((await fs.lstat(attempt.path)).isSymbolicLink()).toBe(fault === 'symlink');
    const bytes = await fs.readFile(attempt.path);
    expect(bytes.length).toBe(fault === 'parent' ? Buffer.byteLength('foreign parent bytes') : 128);
    if (fault === 'parent') expect(bytes.toString()).toBe('foreign parent bytes');
    if (fault === 'unknown-bytes') expect(bytes).toEqual(Buffer.alloc(128, 120));
    expect(await f.cache.load(f.scope, f.material.config.incarnation)).toBeUndefined();
    expect(
      await new OwnedRemoteBrokerCache(join(root, 'cache')).load(f.scope, f.material.config.incarnation)
    ).toBeUndefined();
    expect(await fs.readFile(attempt.path)).toEqual(bytes);
  }
);

it.each([
  'write',
  'sync',
  'close',
  'retire',
  'activate',
  'replacement',
  'same-bytes',
  'symlink',
  'parent',
  'sync-error',
] as const)('retains exact rollback ownership when a private write finishes late: %s', async (fault) => {
  const f = fixture(),
    open = fs.open.bind(fs);
  let release!: () => void, entered!: () => void, finished!: (value: boolean) => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  const reached = new Promise<void>((resolve) => (entered = resolve));
  const cleaned = new Promise<boolean>((resolve) => (finished = resolve));
  const discard = f.cache.discardUnreservedPreparation.bind(f.cache);
  const discardSpy = vi.spyOn(f.cache, 'discardUnreservedPreparation').mockImplementation(async (...args) => {
    const completedWrite = (Reflect.get(f.cache, 'preparations') as WeakMap<object, unknown>).has(args[1]);
    const result = await discard(...args);
    if (completedWrite) finished(result);
    return result;
  });
  const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[0] !== f.file || typeof args[1] !== 'number' || !(args[1] & constants.O_CREAT)) return handle;
    const stage = fault === 'write' ? 'writeFile' : fault === 'sync' || fault === 'sync-error' ? 'sync' : 'close';
    const original = handle[stage].bind(handle) as (...input: unknown[]) => Promise<unknown>;
    Reflect.set(handle, stage, async (...input: unknown[]) => {
      entered();
      await blocked;
      const result = await original(...input);
      if (fault === 'sync-error') throw Object.assign(Error('lost sync ACK'), { code: 'EIO' });
      if (fault === 'replacement' || fault === 'same-bytes' || fault === 'symlink') {
        await fs.rename(f.file, f.file + '.owned');
        if (fault === 'replacement') await fs.writeFile(f.file, 'foreign bytes', { mode: 0o600 });
        else if (fault === 'same-bytes')
          await fs.writeFile(f.file, await fs.readFile(f.file + '.owned'), { mode: 0o600 });
        else await fs.symlink(f.file + '.owned', f.file);
      }
      if (fault === 'parent') {
        const dir = join(root, 'cache', f.scope.sessionId, f.material.config.incarnation);
        await fs.rename(dir, dir + '.owned');
        await fs.mkdir(dir, { mode: 0o700 });
        await fs.writeFile(f.file, 'foreign parent bytes', { mode: 0o600 });
      }
      return result;
    });
    return handle;
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const preparing = f.cache.prepare(f.scope, f.material, f.remoteDirectory);
  let replacement: { incarnation: string; directory: string } | undefined;
  try {
    await reached;
    await vi.advanceTimersByTimeAsync(2001);
    expect(await preparing).toBeUndefined();
    expect(f.cache.get(f.scope, f.material.config.incarnation)).toBeUndefined();
    expect(f.cache.signer(f.scope, f.material.config.incarnation)).toBeUndefined();
    expect(await f.cache.load(f.scope, f.material.config.incarnation)).toBeUndefined();
    if (fault === 'retire') f.cache.retire(f.scope.sessionId);
    if (fault === 'activate') {
      const next = CodexInputBroker.provisioningMaterial(f.scope.sessionId, 'exec new worker', f.scope.codexHome);
      replacement = (await f.cache.prepare(
        f.scope,
        next,
        '/remote/private/' + f.scope.sessionId + '/' + next.config.incarnation
      ))!;
      expect(replacement).toBeDefined();
      expect(f.cache.activate(f.scope, next.config.incarnation)).toBe(true);
    }
    release();
    let timer: ReturnType<typeof realTimeout> | undefined;
    const result = await Promise.race([
      cleaned,
      new Promise<string>((resolve) => {
        timer = realTimeout(() => resolve('cleanup missing'), 2000);
      }),
    ]).finally(() => {
      if (timer) clearRealTimeout(timer);
    });
    if (['replacement', 'same-bytes', 'symlink', 'parent'].includes(fault)) {
      expect(result).toBe(false);
      const receipts = Reflect.get(f.cache, 'canceledPreparations') as Map<string, unknown>;
      expect(receipts.size).toBe(1); // Exact rollback proof remains retryable, never silently orphaned.
      expect(await f.cache.load(f.scope, f.material.config.incarnation)).toBeUndefined();
      expect(await fs.readFile(f.file, 'utf8')).toContain(
        ['symlink', 'same-bytes'].includes(fault) ? '"material"' : 'foreign'
      );
      expect((await fs.lstat(f.file)).isSymbolicLink()).toBe(fault === 'symlink');
    } else {
      expect(result).toBe(true);
      await expect(fs.lstat(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((Reflect.get(f.cache, 'canceledPreparations') as Map<string, unknown>).size).toBe(0);
    }
    if (replacement) expect(f.cache.get(f.scope, replacement.incarnation)).toEqual(replacement);
    expect(f.observe()).toBeUndefined();
  } finally {
    release();
    await preparing;
    spy.mockRestore();
    discardSpy.mockRestore();
    vi.useRealTimers();
  }
});

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

it.each(['raw', 'reserved', 'birth'] as const)(
  'refuses owner input from initial and refreshed uncertain %s snapshots',
  async (fault) => {
    for (const refreshed of [false, true]) {
      const f = fixture();
      await f.cache.prepare(f.scope, f.material, f.remoteDirectory);
      if (refreshed) expect(f.observe()).toBeDefined();
      if (fault === 'raw') {
        f.state.tainted = true;
        f.state.rawGeneration = 1;
      }
      if (fault === 'birth') f.state.childStart = '0';
      if (fault === 'reserved') {
        f.state.counters.auto = 1;
        f.state.receipts = [
          {
            channel: 'auto',
            counter: 1,
            nonce: f.material.config.startup.nonce,
            conversationId: '11111111-2222-3333-4444-555555555555',
            hash: createHash('sha256').update('unfinished phase').digest('hex'),
            status: 'reserved',
          },
        ];
      }
      expect(f.observe()).toBeUndefined();
      const signer = f.cache.signer(f.scope, f.material.config.incarnation);
      if (refreshed) expect(signer).toBeDefined();
      else expect(signer).toBeUndefined();
      expect(signer?.canFrame ?? false).toBe(false);
      expect(signer?.frame('owner-pty', 'must not be ACKed')).toBeUndefined();
    }
  }
);

it('retains certified closed evidence without admitting owner input', async () => {
  const f = fixture();
  await f.cache.prepare(f.scope, f.material, f.remoteDirectory);
  f.state.closed = true;
  f.state.exitStatus = 1;
  expect(f.observe()).toMatchObject({ closed: true, exitStatus: 1 });
  const signer = f.cache.signer(f.scope, f.material.config.incarnation);
  expect(signer).toBeDefined();
  expect(signer?.canFrame).toBe(false);
  expect(signer?.frame('owner-key', '\r')).toBeUndefined();
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
      closed = 0,
      bothHeld!: () => void,
      bothClosed!: () => void;
    const reached = new Promise<void>((resolve) => {
      bothHeld = resolve;
    });
    const didClose = new Promise<void>((resolve) => {
      bothClosed = resolve;
    });
    const noteHeld = () => {
      if (++held === 2) bothHeld();
    };
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
            noteHeld();
            await barrier;
          }
          return handle.read(...input);
        },
        close: async () => {
          if (hold === 'close') {
            noteHeld();
            await barrier;
          }
          await handle.close();
          if (++closed === 2) bothClosed();
        },
      } as unknown as typeof handle;
    });
    const loads = fixtures
      .slice(0, 2)
      .map((f) => new OwnedRemoteBrokerCache(join(root, 'cache')).load(f.scope, f.material.config.incarnation));
    try {
      // Filesystem progress has no relationship to the number of event-loop turns.
      await reached;
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
      await didClose;
      expect(closed).toBe(2);
      // Final path checks must also settle before the same slot can be reused.
      // Observe actual slot release rather than assuming a number of I/O turns.
      const readyBy = process.hrtime.bigint() + 2_000_000_000n;
      let available: Awaited<ReturnType<OwnedRemoteBrokerCache['load']>>;
      do {
        available = await new OwnedRemoteBrokerCache(join(root, 'cache')).load(f.scope, f.material.config.incarnation);
        if (available) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      } while (process.hrtime.bigint() < readyBy);
      expect(available).toBeDefined();
    } finally {
      releases.forEach((release) => release());
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  }
);

it('revokes both retained incarnations and already-returned signers, without touching private launch files', async () => {
  const f = fixture();
  const first = await f.cache.prepare(f.scope, f.material, f.remoteDirectory);
  const proof = f.observe()!;
  const signer = f.cache.signer(f.scope, f.material.config.incarnation)!;
  expect(proof).toBeDefined();
  expect(signer.authority(proof)).toBeDefined();
  expect(signer.canFrame).toBe(true);
  const newer = CodexInputBroker.provisioningMaterial(f.scope.sessionId, 'exec newer-child', f.scope.codexHome);
  const newerDirectory = '/remote/private/' + f.scope.sessionId + '/' + newer.config.incarnation;
  expect(await f.cache.prepare(f.scope, newer, newerDirectory)).toBeDefined();
  const bytes = await fs.readFile(f.file);
  f.cache.retire(f.scope.sessionId);
  expect(f.cache.get(f.scope, newer.config.incarnation)).toBeUndefined();
  expect(f.cache.get(f.scope, f.material.config.incarnation)).toBeUndefined();
  expect(f.cache.signer(f.scope, f.material.config.incarnation)).toBeUndefined();
  expect(f.observe()).toBeUndefined();
  expect(f.cache.activate(f.scope, newer.config.incarnation)).toBe(false);
  expect(signer.canFrame).toBe(false);
  expect(signer.authority(proof)).toBeUndefined();
  expect(signer.frame('owner-pty', 'old draft')).toBeUndefined();
  const stale = f.snapshot();
  expect(signer.observeRemote(stale.serialized, stale.witness, 700)).toBeUndefined();
  expect(signer.canFrame).toBe(false);
  expect(f.observe()).toBeUndefined();
  expect(await fs.readFile(f.file)).toEqual(bytes);
  expect(await f.cache.load(f.scope, f.material.config.incarnation)).toEqual(first);
  expect(f.observe()).toBeDefined();
  expect(f.cache.signer(f.scope, f.material.config.incarnation)).not.toBe(signer);
  expect(signer.authority(proof)).toBeUndefined();
});

it.each(['host', 'owner', 'home', 'incarnation'] as const)(
  'does not lend retired material to a new %s scope',
  async (kind) => {
    const f = fixture();
    await f.cache.prepare(f.scope, f.material, f.remoteDirectory);
    const other = structuredClone(f.scope);
    if (kind === 'host') other.remote.host = 'replacement.invalid';
    if (kind === 'owner') other.owner = 'replacement-owner';
    if (kind === 'home') other.codexHome += '-new';
    f.cache.retire(f.scope.sessionId);
    expect(
      await f.cache.load(
        other,
        kind === 'incarnation' ? 'dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb' : f.material.config.incarnation
      )
    ).toBeUndefined();
    expect(f.cache.get(other, f.material.config.incarnation)).toBeUndefined();
    expect(f.cache.signer(other, f.material.config.incarnation)).toBeUndefined();
    expect(f.observe()).toBeUndefined();
    // A fresh explicit launch in the replacement scope can register its own secret.
    const material = CodexInputBroker.provisioningMaterial(other.sessionId, 'exec replacement-child', other.codexHome);
    expect(
      await f.cache.prepare(other, material, '/remote/private/' + other.sessionId + '/' + material.config.incarnation)
    ).toBeDefined();
    expect(f.cache.get(f.scope, f.material.config.incarnation)).toBeUndefined();
  }
);

it.each(['retire', 'activate'] as const)('does not publish a superseded prepare after %s', async (transition) => {
  const f = fixture();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (entered = resolve));
  const original = fs.open.bind(fs);
  const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args);
    if (args[0] === f.file) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (...values: Parameters<typeof handle.writeFile>) => {
        entered();
        await held;
        return write(...values);
      };
    }
    return handle;
  });
  const preparing = f.cache.prepare(f.scope, f.material, f.remoteDirectory);
  try {
    await started;
    if (transition === 'retire') f.cache.retire(f.scope.sessionId);
    const replacement = structuredClone(f.scope);
    if (transition === 'retire') replacement.owner = 'new-owner';
    const material = CodexInputBroker.provisioningMaterial(
      replacement.sessionId,
      'exec replacement',
      replacement.codexHome
    );
    const descriptor = await f.cache.prepare(
      replacement,
      material,
      '/remote/private/' + replacement.sessionId + '/' + material.config.incarnation
    );
    expect(descriptor).toBeDefined();
    if (transition === 'activate') expect(f.cache.activate(replacement, material.config.incarnation)).toBe(true);
    release();
    expect(await preparing).toBeUndefined();
    expect(f.cache.get(f.scope, f.material.config.incarnation)).toBeUndefined();
    expect(f.cache.get(replacement, material.config.incarnation)).toEqual(descriptor);
    expect(f.observe()).toBeUndefined();
    expect(f.cache.activate(f.scope, f.material.config.incarnation)).toBe(false);
  } finally {
    release();
    await preparing;
    spy.mockRestore();
  }
});

it('does not join or publish a retired lookup when the same scope is legitimately rehydrated', async () => {
  const f = fixture();
  const descriptor = await f.cache.prepare(f.scope, f.material, f.remoteDirectory);
  f.cache.retire(f.scope.sessionId);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (entered = resolve));
  const original = fs.open.bind(fs);
  let reads = 0;
  const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args);
    if (args[0] === f.file && ++reads === 1) {
      const read = handle.read.bind(handle);
      handle.read = (async (...values: unknown[]) => {
        entered();
        await held;
        return (read as (...args: unknown[]) => Promise<unknown>)(...values);
      }) as typeof handle.read;
    }
    return handle;
  });
  const loading = f.cache.load(f.scope, f.material.config.incarnation);
  try {
    await started;
    f.cache.retire(f.scope.sessionId);
    expect(await f.cache.load(f.scope, f.material.config.incarnation)).toEqual(descriptor);
    expect(reads).toBe(2);
    expect(f.observe()).toBeDefined();
    const currentSigner = f.cache.signer(f.scope, f.material.config.incarnation);
    release();
    expect(await loading).toBeUndefined();
    expect(f.cache.signer(f.scope, f.material.config.incarnation)).toBe(currentSigner);
  } finally {
    release();
    await loading;
    spy.mockRestore();
  }
});

it('reclaims all per-session memory without accumulating retirement tombstones or failed lookup epochs', async () => {
  const f = fixture();
  await f.cache.prepare(f.scope, f.material, f.remoteDirectory);
  f.observe();
  f.cache.retire(f.scope.sessionId);
  for (let index = 0; index < 300; index++) f.cache.retire('retired-' + index);
  expect(await f.cache.load(f.scope, 'dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb')).toBeUndefined();
  for (const field of ['entries', 'scopes', 'epochs'])
    expect((Reflect.get(f.cache, field) as Map<unknown, unknown>).size).toBe(0);
});

it('retires only the selected session, preserving another host/owner signer and pending owner counter', async () => {
  const f = fixture();
  await f.cache.prepare(f.scope, f.material, f.remoteDirectory);
  f.observe();
  const other = structuredClone(f.scope);
  other.sessionId = 'dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb';
  other.owner = 'other-owner';
  other.remote.host = 'other.invalid';
  const material = CodexInputBroker.provisioningMaterial(other.sessionId, 'exec other-child', other.codexHome);
  const directory = '/remote/private/' + other.sessionId + '/' + material.config.incarnation;
  const descriptor = await f.cache.prepare(other, material, directory);
  const state = {
    ...f.state,
    sessionId: other.sessionId,
    incarnation: material.config.incarnation,
    launchDigest: material.config.launchDigest,
    homeDigest: material.config.homeDigest,
    startup: { nonce: material.config.startup.nonce, status: 'started' },
  };
  const serialized = JSON.stringify(state);
  expect(
    f.cache.observe(
      other,
      material.config.incarnation,
      serialized,
      {
        ...f.snapshot().witness,
        path: directory + '/state.json',
        size: Buffer.byteLength(serialized),
        hash: createHash('sha256').update(serialized).digest('hex'),
      },
      700
    )
  ).toBeDefined();
  const signer = f.cache.signer(other, material.config.incarnation)!;
  const first = signer.frame('owner-pty', 'first')!;
  f.cache.retire(f.scope.sessionId);
  expect(f.cache.get(other, material.config.incarnation)).toEqual(descriptor);
  expect(f.cache.signer(other, material.config.incarnation)).toBe(signer);
  expect(signer.frame('owner-pty', 'second')?.receipt.counter).toBe(first.receipt.counter + 1);
});

it('discards only its exact unreserved preparation while preserving the active signer and old private material', async () => {
  const f = fixture();
  expect(await f.cache.prepare(f.scope, f.material, f.remoteDirectory)).toBeDefined();
  expect(f.observe()).toBeDefined();
  const signer = f.cache.signer(f.scope, f.material.config.incarnation)!,
    first = signer.frame('owner-key', '\t')!,
    oldBytes = await fs.readFile(f.file),
    next = CodexInputBroker.provisioningMaterial(f.scope.sessionId, 'exec replacement', f.scope.codexHome),
    directory = '/remote/private/' + f.scope.sessionId + '/' + next.config.incarnation,
    receipt = (await f.cache.prepare(f.scope, next, directory))!;
  expect(await f.cache.discardUnreservedPreparation(f.scope, receipt)).toBe(true);
  expect(f.cache.signer(f.scope, f.material.config.incarnation)).toBe(signer);
  expect(signer.frame('owner-key', '\t')?.receipt.counter).toBe(first.receipt.counter + 1);
  expect(await fs.readFile(f.file)).toEqual(oldBytes);
  const restarted = new OwnedRemoteBrokerCache(join(root, 'cache'));
  expect(await restarted.load(f.scope, receipt.incarnation)).toBeUndefined();
  expect(await restarted.load(f.scope, f.material.config.incarnation)).toBeDefined();
});

it.each(['copied-receipt', 'foreign-scope', 'observed', 'promoted', 'sealed'] as const)(
  'cannot discard a %s preparation',
  async (change) => {
    const f = fixture(),
      receipt = (await f.cache.prepare(f.scope, f.material, f.remoteDirectory))!,
      bytes = await fs.readFile(f.file);
    if (change === 'observed') expect(f.observe()).toBeDefined();
    if (change === 'promoted') expect(f.cache.activate(f.scope, receipt.incarnation)).toBe(true);
    if (change === 'sealed') f.cache.sealPreparation(receipt);
    expect(
      await f.cache.discardUnreservedPreparation(
        change === 'foreign-scope' ? { ...f.scope, owner: 'different-owner' } : f.scope,
        change === 'copied-receipt' ? { ...receipt } : receipt
      )
    ).toBe(false);
    expect(await fs.readFile(f.file)).toEqual(bytes);
    expect(f.cache.get(f.scope, receipt.incarnation)).toEqual(receipt);
  }
);

it.each(['same-bytes', 'symlink'] as const)(
  'preserves %s replacement during cancellation proof close',
  async (change) => {
    const f = fixture(),
      receipt = (await f.cache.prepare(f.scope, f.material, f.remoteDirectory))!,
      bytes = await fs.readFile(f.file),
      open = fs.open.bind(fs);
    let changed = false;
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === f.file) {
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          if (changed) return;
          changed = true;
          await fs.rename(f.file, f.file + '.old');
          if (change === 'same-bytes') await fs.writeFile(f.file, bytes, { mode: 0o600 });
          else await fs.symlink(f.file + '.old', f.file);
        };
      }
      return handle;
    });
    try {
      expect(await f.cache.discardUnreservedPreparation(f.scope, receipt)).toBe(false);
      expect(changed).toBe(true);
      expect(await fs.readFile(f.file)).toEqual(bytes);
      expect((await fs.lstat(f.file)).isSymbolicLink()).toBe(change === 'symlink');
    } finally {
      spy.mockRestore();
    }
  }
);

it.each(['foreign-artifact', 'lost-parent-sync'] as const)(
  'retries a known cancellation after %s without evicting the active incarnation',
  async (change) => {
    const f = fixture();
    expect(await f.cache.prepare(f.scope, f.material, f.remoteDirectory)).toBeDefined();
    const material = CodexInputBroker.provisioningMaterial(f.scope.sessionId, 'exec provisional', f.scope.codexHome),
      directory = '/remote/private/' + f.scope.sessionId + '/' + material.config.incarnation,
      receipt = (await f.cache.prepare(f.scope, material, directory))!,
      localDirectory = join(root, 'cache', f.scope.sessionId, receipt.incarnation),
      artifact = join(localDirectory, 'owner-note'),
      open = fs.open.bind(fs);
    let failed = false;
    if (change === 'foreign-artifact') await fs.writeFile(artifact, 'keep owner bytes', { mode: 0o600 });
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (change === 'lost-parent-sync' && args[0] === join(root, 'cache', f.scope.sessionId)) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          if (!failed) {
            failed = true;
            throw Object.assign(Error('Fixture sync failure'), { code: 'EIO' });
          }
          return sync();
        };
      }
      return handle;
    });
    try {
      expect(await f.cache.discardUnreservedPreparation(f.scope, receipt)).toBe(false);
      expect(f.cache.get(f.scope, f.material.config.incarnation)).toBeDefined();
      if (change === 'foreign-artifact') {
        expect(await fs.readFile(artifact, 'utf8')).toBe('keep owner bytes');
        await fs.unlink(artifact); // Explicit disposable owner resolution, never recursive cleanup.
      } else {
        expect(failed).toBe(true);
        await expect(fs.lstat(localDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
      }
      const fresh = CodexInputBroker.provisioningMaterial(f.scope.sessionId, 'exec next attempt', f.scope.codexHome);
      expect(
        await f.cache.prepare(f.scope, fresh, '/remote/private/' + f.scope.sessionId + '/' + fresh.config.incarnation)
      ).toBeDefined();
      expect(f.cache.get(f.scope, f.material.config.incarnation)).toBeDefined();
      expect(await new OwnedRemoteBrokerCache(join(root, 'cache')).load(f.scope, receipt.incarnation)).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  }
);
