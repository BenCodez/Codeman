/** Real generated retirement over fixture-only SSH/tmux; no live host or pane. */
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CodexInputBroker, type CodexBrokerState } from '../src/recovery/codex-input-broker.js';
import { OwnedRemoteBrokerCache, type OwnedRemoteBrokerScope } from '../src/recovery/remote-input-broker-cache.js';
import { cleanupRemoteBroker, type RemoteBrokerCleanupTarget } from '../src/recovery/remote-broker-cleanup.js';
import type { RemoteBrokerTransport } from '../src/recovery/remote-input-broker.js';

let root: string, bin: string;
const SHIM = '#!/bin/sh\nfor arg; do last="$arg"; done\nexec /bin/sh -c "$last"\n';
const TMUX =
  '#!/bin/sh\nif [ -f "$FIXTURE_MUX_LIVE" ]; then exit 0; fi\nprintf "no server running on fixture-only\\n" >&2\nexit 1\n';
const PYTHON = `#!/usr/bin/python3 -S
import os,sys
assert sys.argv[1:4]==['-I','-S','-c'] and len(sys.argv)==5
source=sys.argv[4]
if os.environ.get('FIXTURE_UNLINK_FAILURE'):
 original=os.unlink
 def unlink(path,*args,**kwargs):
  if path=='config.json': raise OSError('fixture held config unlink')
  return original(path,*args,**kwargs)
 os.unlink=unlink
exec(compile(source,'<trusted-cleanup>','exec'))
`;
beforeEach(async () => {
  root = await fs.mkdtemp(join(homedir(), 'remote-final-cleanup-'));
  bin = join(root, 'bin');
  await fs.mkdir(bin, { mode: 0o700 });
  for (const [name, content] of [
    ['ssh', SHIM],
    ['login-shell', SHIM],
    ['tmux', TMUX],
    ['python3', PYTHON],
  ])
    await fs.writeFile(join(bin, name!), content!, { mode: 0o700 });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await fs.rm(root, { recursive: true, force: true });
});
function transport(options: { offline?: boolean; partial?: boolean; after?: () => void } = {}): RemoteBrokerTransport {
  return {
    run: async (command, input) => {
      if (options.offline) throw Error('fixture offline');
      for (const [name, content] of [
        ['ssh', SHIM],
        ['login-shell', SHIM],
        ['tmux', TMUX],
        ['python3', PYTHON],
      ])
        if ((await fs.readFile(join(bin, name!), 'utf8')) !== content) throw Error('Fixture replaced');
      if (!command.startsWith('ssh ') || !command.includes('worker.invalid') || command.includes('kill-session'))
        throw Error('Unsafe fixture command');
      return await new Promise((resolve, reject) => {
        const child = spawn('/bin/sh', ['-c', command], {
          env: {
            ...process.env,
            HOME: root,
            SHELL: join(bin, 'login-shell'),
            PATH: `${bin}:/usr/bin:/bin`,
            FIXTURE_MUX_LIVE: join(root, 'live-pane'),
            FIXTURE_UNLINK_FAILURE: options.partial ? 'yes' : '',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '',
          stderr = '';
        const timer = setTimeout(() => {
          child.kill();
          reject(Error('Fixture transport timed out'));
        }, 5000);
        child.stdout.on('data', (bytes) => {
          stdout += bytes;
        });
        child.stderr.on('data', (bytes) => {
          stderr += bytes;
        });
        child.once('error', reject);
        child.once('close', (code) => {
          clearTimeout(timer);
          options.after?.();
          if (code === 0) resolve({ stdout });
          else reject(Error(stderr));
        });
        child.stdin.end(input);
      });
    },
  };
}
async function fixture() {
  const scope: OwnedRemoteBrokerScope = {
    sessionId: randomUUID(),
    workingDir: '/fixture/work',
    codexHome: '/fixture/home',
    owner: 'fixture',
    remote: {
      hostId: 'fixture',
      label: 'Fixture',
      host: 'worker.invalid',
      username: 'fixture',
      remotePath: '/fixture/work',
      owned: true,
    },
  };
  const material = CodexInputBroker.provisioningMaterial(scope.sessionId, 'exec fixture-child', scope.codexHome);
  const directory = join(root, 'remote', scope.sessionId, material.config.incarnation);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(join(directory, 'broker.py'), material.helper, { mode: 0o600 });
  await fs.writeFile(join(directory, 'config.json'), JSON.stringify(material.config), { mode: 0o600 });
  await fs.writeFile(join(directory, 'lock'), '', { mode: 0o600 });
  const target: RemoteBrokerCleanupTarget = { remote: scope.remote, owner: scope.owner };
  const state: CodexBrokerState = {
    version: 1,
    sessionId: scope.sessionId,
    incarnation: material.config.incarnation,
    pid: 2147483647,
    childPid: 2147483646,
    brokerStart: '12345',
    childStart: '12346',
    tainted: false,
    rawGeneration: 0,
    launchDigest: material.config.launchDigest,
    homeDigest: material.config.homeDigest,
    closed: true,
    exitStatus: 0,
    exitSignal: null,
    counters: { 'owner-pty': 0, 'owner-key': 0, 'owner-mux': 0, auto: 0, probe: 0 },
    receipts: [],
    startup: { nonce: material.config.startup.nonce, status: 'started' },
  };
  const writeState = () => fs.writeFile(join(directory, 'state.json'), JSON.stringify(state), { mode: 0o600 });
  const clean = (io = transport(), current = () => true) =>
    cleanupRemoteBroker(target, directory, material, current, { transport: io });
  const cacheRoot = join(root, 'cache');
  const makeCache = (io = transport()) =>
    new OwnedRemoteBrokerCache(cacheRoot, (...args) => cleanupRemoteBroker(...args, { transport: io }));
  const privateFile = join(cacheRoot, scope.sessionId, material.config.incarnation, 'private.json');
  return { scope, material, directory, target, state, writeState, clean, cacheRoot, makeCache, privateFile };
}

it.each(['unstarted', 'closed', 'abruptly-stopped'] as const)(
  'removes only the exact retired %s incarnation and its secret',
  async (kind) => {
    const f = await fixture();
    if (kind !== 'unstarted') {
      if (kind === 'abruptly-stopped') {
        f.state.closed = false;
        f.state.exitStatus = null;
      }
      await f.writeState();
    }
    expect(await f.clean()).toBe(true);
    await expect(fs.lstat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.clean()).toBe(true); // lost ACK / idempotent retry
  }
);

it.each([
  'live-pane',
  'live-broker',
  'live-child',
  'reserved',
  'tainted',
  'raw-input',
  'foreign-secret',
  'foreign-helper',
  'foreign-file',
  'symlink',
  'public-config',
] as const)('retains remote and source identity for %s', async (kind) => {
  const f = await fixture();
  await f.writeState();
  if (kind === 'live-pane') await fs.writeFile(join(root, 'live-pane'), 'live');
  if (kind === 'live-broker' || kind === 'live-child') {
    const native = await fs.readFile(`/proc/${process.pid}/stat`, 'utf8');
    const birth = native.slice(native.lastIndexOf(')') + 2).split(/\s+/)[19]!;
    if (kind === 'live-broker') {
      f.state.pid = process.pid;
      f.state.brokerStart = birth;
    } else {
      f.state.childPid = process.pid;
      f.state.childStart = birth;
    }
    await f.writeState();
  }
  if (kind === 'reserved') {
    f.state.counters.auto = 1;
    f.state.receipts.push({
      channel: 'auto',
      counter: 1,
      nonce: randomUUID(),
      conversationId: randomUUID(),
      hash: 'a'.repeat(64),
      status: 'reserved',
    });
    await f.writeState();
  }
  if (kind === 'tainted' || kind === 'raw-input') {
    f.state.tainted = kind === 'tainted';
    f.state.rawGeneration = kind === 'raw-input' ? 1 : 0;
    await f.writeState();
  }
  if (kind === 'foreign-secret')
    await fs.writeFile(
      join(f.directory, 'config.json'),
      JSON.stringify({ ...f.material.config, secret: 'b'.repeat(64) })
    );
  if (kind === 'foreign-helper') await fs.writeFile(join(f.directory, 'broker.py'), 'foreign helper');
  if (kind === 'foreign-file') await fs.writeFile(join(f.directory, 'owner-notes'), 'keep');
  if (kind === 'public-config') await fs.chmod(join(f.directory, 'config.json'), 0o644);
  if (kind === 'symlink') {
    await fs.rename(f.directory, f.directory + '-original');
    await fs.symlink(f.directory + '-original', f.directory);
  }
  const cache = f.makeCache();
  expect(await cache.prepare(f.scope, f.material, f.directory)).toBeDefined();
  await cache.stageFinalCleanup(f.scope.sessionId, undefined, () => true, f.target);
  const original = await fs.readFile(f.privateFile);
  expect(await cache.finishFinalCleanup(f.scope.sessionId, () => true)).toBe(false);
  expect(await fs.readFile(f.privateFile)).toEqual(original);
  expect((await fs.lstat(join(f.cacheRoot, f.scope.sessionId + '.cleanup.json'))).isFile()).toBe(true);
});

it('retains offline cleanup authority through cache reload and retries every rotation', async () => {
  const f = await fixture();
  const cache = f.makeCache(transport({ offline: true }));
  const materials = [f.material];
  for (let index = 0; index < 3; index++) {
    const m =
      index === 0
        ? f.material
        : CodexInputBroker.provisioningMaterial(f.scope.sessionId, 'exec rotation-' + index, f.scope.codexHome);
    if (index) materials.push(m);
    const directory = join(root, 'remote', f.scope.sessionId, m.config.incarnation);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(join(directory, 'broker.py'), m.helper, { mode: 0o600 });
    await fs.writeFile(join(directory, 'config.json'), JSON.stringify(m.config), { mode: 0o600 });
    await fs.writeFile(join(directory, 'lock'), '', { mode: 0o600 });
    expect(await cache.prepare(f.scope, m, directory)).toBeDefined();
    expect(cache.activate(f.scope, m.config.incarnation)).toBe(true);
  }
  await cache.stageFinalCleanup(f.scope.sessionId, undefined, () => true, f.target);
  expect(await cache.finishFinalCleanup(f.scope.sessionId, () => true)).toBe(false);
  const bytes = await fs.readFile(join(f.cacheRoot, f.scope.sessionId + '.cleanup.json'), 'utf8');
  expect(JSON.parse(bytes).target).toEqual(f.target);
  for (const m of materials)
    expect(
      (await fs.lstat(join(root, 'remote', f.scope.sessionId, m.config.incarnation, 'config.json'))).isFile()
    ).toBe(true);
  const reopened = f.makeCache();
  const stop = reopened.startFinalCleanupRetries(() => ({ live: false }));
  try {
    await vi.waitFor(async () => expect(await fs.readdir(join(f.cacheRoot, f.scope.sessionId))).toEqual([]));
    for (const m of materials)
      await expect(fs.lstat(join(root, 'remote', f.scope.sessionId, m.config.incarnation))).rejects.toMatchObject({
        code: 'ENOENT',
      });
  } finally {
    await stop();
  }
});

it('resumes exact interrupted remote unlink after restart without discarding source retry material', async () => {
  const f = await fixture();
  await f.writeState();
  const cache = f.makeCache(transport({ partial: true }));
  expect(await cache.prepare(f.scope, f.material, f.directory)).toBeDefined();
  await cache.stageFinalCleanup(f.scope.sessionId, undefined, () => true, f.target);
  expect(await cache.finishFinalCleanup(f.scope.sessionId, () => true)).toBe(false);
  expect(await fs.readdir(f.directory)).toEqual(expect.arrayContaining(['.cleanup.json', 'config.json', 'lock']));
  await expect(fs.lstat(join(f.directory, 'state.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await fs.lstat(f.privateFile)).isFile()).toBe(true);
  expect(await f.makeCache().finishFinalCleanup(f.scope.sessionId, () => true)).toBe(true);
  await expect(fs.lstat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('keeps a replacement file after interrupted cleanup, then completes only once the owner removes it', async () => {
  const f = await fixture();
  await f.writeState();
  expect(await f.clean(transport({ partial: true }))).toBe(false);
  await fs.writeFile(join(f.directory, 'broker.py'), 'foreign replacement', { mode: 0o600 });
  expect(await f.clean()).toBe(false);
  expect(await fs.readFile(join(f.directory, 'broker.py'), 'utf8')).toBe('foreign replacement');
  await fs.unlink(join(f.directory, 'broker.py'));
  expect(await f.clean()).toBe(true);
});

it('does not discard local authority on a canceled/lost remote ACK, and retries missing remote files safely', async () => {
  const f = await fixture();
  let current = true;
  const cache = f.makeCache(
    transport({
      after: () => {
        current = false;
      },
    })
  );
  expect(await cache.prepare(f.scope, f.material, f.directory)).toBeDefined();
  await cache.stageFinalCleanup(f.scope.sessionId, undefined, () => true, f.target);
  expect(await cache.finishFinalCleanup(f.scope.sessionId, () => current)).toBe(false);
  expect((await fs.lstat(f.privateFile)).isFile()).toBe(true);
  await expect(fs.lstat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await f.makeCache().finishFinalCleanup(f.scope.sessionId, () => true)).toBe(true);
});

it.each(['host', 'owner', 'legacy-unbound'] as const)(
  'never transmits old incarnation credentials using a changed or missing %s scope',
  async (kind) => {
    const f = await fixture();
    const run = vi.fn(transport().run);
    const cache = f.makeCache({ run });
    expect(await cache.prepare(f.scope, f.material, f.directory)).toBeDefined();
    if (kind === 'legacy-unbound') {
      const value = JSON.parse(await fs.readFile(f.privateFile, 'utf8'));
      delete value.scopeData;
      await fs.writeFile(f.privateFile, JSON.stringify(value));
    }
    const target = structuredClone(f.target);
    if (kind === 'host') target.remote.host = 'other-worker.invalid';
    if (kind === 'owner') target.owner = 'other-owner';
    await cache.stageFinalCleanup(f.scope.sessionId, undefined, () => true, target);
    expect(await cache.finishFinalCleanup(f.scope.sessionId, () => true)).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect((await fs.lstat(f.privateFile)).isFile()).toBe(true);
    expect(await fs.readFile(join(f.directory, 'config.json'), 'utf8')).toContain(f.material.config.secret);
  }
);

it.each(['missing', 'disabled', 'regular-owner'] as const)(
  'revalidates current %s authority before offline cleanup retry can open SSH',
  async (kind) => {
    const f = await fixture();
    const run = vi.fn(transport().run);
    const cache = f.makeCache({ run });
    expect(await cache.prepare(f.scope, f.material, f.directory)).toBeDefined();
    await cache.stageFinalCleanup(f.scope.sessionId, undefined, () => true, f.target);
    const userDir = join(root, 'users');
    await fs.mkdir(userDir, { mode: 0o700 });
    await fs.writeFile(
      join(userDir, 'users.json'),
      JSON.stringify({
        version: 1,
        users: kind === 'missing' ? [] : [{ username: 'fixture', role: 'user', disabled: kind === 'disabled' }],
      }),
      { mode: 0o600 }
    );
    vi.stubEnv('CODEMAN_DATA_DIR', userDir);
    vi.stubEnv('CODEMAN_MULTIUSER', '1');
    try {
      expect(await cache.finishFinalCleanup(f.scope.sessionId, () => true)).toBe(kind === 'regular-owner');
      if (kind === 'regular-owner') expect(run).toHaveBeenCalledTimes(1);
      else {
        expect(run).not.toHaveBeenCalled();
        expect((await fs.lstat(f.privateFile)).isFile()).toBe(true);
        expect(await fs.readFile(join(f.directory, 'config.json'), 'utf8')).toContain(f.material.config.secret);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  }
);
