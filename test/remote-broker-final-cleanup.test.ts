/** @fileoverview Real generated retirement over fixture-only SSH/tmux; no live host or pane. */
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CodexInputBroker, type CodexBrokerState } from '../src/recovery/codex-input-broker.js';
import { OwnedRemoteBrokerCache, type OwnedRemoteBrokerScope } from '../src/recovery/remote-input-broker-cache.js';
import { cleanupRemoteBroker, type RemoteBrokerCleanupTarget } from '../src/recovery/remote-broker-cleanup.js';
import type { RemoteBrokerTransport } from '../src/recovery/remote-input-broker.js';

let root: string, bin: string;
const SHIM = '#!/bin/sh\nfor arg; do last="$arg"; done\nexec /bin/sh -c "$last"\n';
const TMUX = `#!/bin/sh
if [ "$#" -ne 5 ] || [ "$1" != '-L' ] || [ "$2" != 'codeman-remote' ] || [ "$3" != 'has-session' ] || [ "$4" != '-t' ] || [ "$5" != "$FIXTURE_MUX_TARGET" ]; then exit 99; fi
if [ -f "$FIXTURE_MUX_LIVE" ]; then exit 0; fi
if [ -n "$FIXTURE_MUX_APPEARS" ]; then
 if [ -f "$FIXTURE_MUX_CHECKED" ]; then exit 0; fi
 : > "$FIXTURE_MUX_CHECKED"
fi
printf '%s\\n' "$FIXTURE_MUX_DIAGNOSTIC" >&2
printf '%s' "$FIXTURE_MUX_STDOUT"
exit "$FIXTURE_MUX_STATUS"
`;
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
if os.environ.get('FIXTURE_PARENT_FAILURE'):
 original_rmdir=os.rmdir
 def rmdir(path,*args,**kwargs):
  if path==os.environ['FIXTURE_PARENT_PATH']:
   if os.environ['FIXTURE_PARENT_FAILURE']=='before': raise OSError('fixture held parent removal')
   original_rmdir(path,*args,**kwargs)
   raise OSError('fixture lost parent removal ACK')
  return original_rmdir(path,*args,**kwargs)
 os.rmdir=rmdir
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
function transport(
  options: {
    offline?: boolean;
    partial?: boolean;
    parentFailure?: 'before' | 'after';
    after?: () => void;
    muxError?: string;
    muxStdout?: string;
    muxStatus?: number;
    muxAppears?: boolean;
  } = {}
): RemoteBrokerTransport {
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
            FIXTURE_MUX_TARGET: '=codeman-ssh-' + JSON.parse(input).material.config.sessionId.slice(0, 8),
            FIXTURE_MUX_DIAGNOSTIC:
              options.muxError ??
              `error connecting to ${join(root, 'tmux-' + process.getuid!(), 'codeman-remote')} (No such file or directory)`,
            FIXTURE_MUX_STATUS: String(options.muxStatus ?? 1),
            FIXTURE_MUX_STDOUT: options.muxStdout ?? '',
            FIXTURE_MUX_APPEARS: options.muxAppears ? 'yes' : '',
            FIXTURE_MUX_CHECKED: join(root, 'checked-pane'),
            FIXTURE_UNLINK_FAILURE: options.partial ? 'yes' : '',
            FIXTURE_PARENT_FAILURE: options.parentFailure ?? '',
            FIXTURE_PARENT_PATH: dirname(JSON.parse(input).directory),
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
    new OwnedRemoteBrokerCache(cacheRoot, (target, directory, material, current, options) =>
      cleanupRemoteBroker(target, directory, material, current, { ...options, transport: io })
    );
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
    await expect(fs.lstat(dirname(f.directory))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(join(root, 'remote'))).toEqual([]);
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
    await vi.waitFor(
      async () => await expect(fs.lstat(join(f.cacheRoot, f.scope.sessionId))).rejects.toMatchObject({ code: 'ENOENT' })
    );
    for (const m of materials)
      await expect(fs.lstat(join(root, 'remote', f.scope.sessionId, m.config.incarnation))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    await expect(fs.lstat(dirname(f.directory))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(join(root, 'remote'))).toEqual([]);
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

it.each([
  'host',
  'hostId',
  'username',
  'port',
  'identityFile',
  'jumpHost',
  'extraSshOptions',
  'remotePath',
  'owner',
  'legacy-unbound',
  'tampered-scope',
] as const)('never transmits old incarnation credentials using a changed or missing %s scope', async (kind) => {
  const f = await fixture();
  const run = vi.fn(transport().run);
  const cache = f.makeCache({ run });
  expect(await cache.prepare(f.scope, f.material, f.directory)).toBeDefined();
  if (kind === 'legacy-unbound' || kind === 'tampered-scope') {
    const value = JSON.parse(await fs.readFile(f.privateFile, 'utf8'));
    if (kind === 'legacy-unbound') delete value.scopeData;
    else value.scopeData.remote.wakeCommand = 'tampered-wake';
    await fs.writeFile(f.privateFile, JSON.stringify(value));
  }
  const target = structuredClone(f.target);
  if (kind === 'host') target.remote.host = 'other-worker.invalid';
  if (kind === 'hostId') target.remote.hostId = 'other-host';
  if (kind === 'username') target.remote.username = 'other-user';
  if (kind === 'port') target.remote.port = 2222;
  if (kind === 'identityFile') target.remote.identityFile = '/fixture/other-key';
  if (kind === 'jumpHost') target.remote.jumpHost = 'other-jump.invalid';
  if (kind === 'extraSshOptions') target.remote.extraSshOptions = ['ConnectTimeout=9'];
  if (kind === 'remotePath') target.remote.remotePath = '/other/work';
  if (kind === 'owner') target.owner = 'other-owner';
  target.remote.wakeCommand = 'changed-wake';
  target.remote.wakeMac = '02:00:00:00:00:02';
  await cache.stageFinalCleanup(f.scope.sessionId, undefined, () => true, target);
  expect(await cache.finishFinalCleanup(f.scope.sessionId, () => true)).toBe(false);
  expect(run).not.toHaveBeenCalled();
  expect((await fs.lstat(f.privateFile)).isFile()).toBe(true);
  expect(await fs.readFile(join(f.directory, 'config.json'), 'utf8')).toContain(f.material.config.secret);
});

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

it.each(['before', 'after'] as const)(
  'retries remote session-parent removal after a failure %s rmdir and a fresh source cache',
  async (point) => {
    const f = await fixture();
    const cache = f.makeCache(transport({ parentFailure: point }));
    expect(await cache.prepare(f.scope, f.material, f.directory)).toBeDefined();
    await cache.stageFinalCleanup(f.scope.sessionId, undefined, () => true, f.target);
    expect(await cache.finishFinalCleanup(f.scope.sessionId, () => true)).toBe(false);
    await expect(fs.lstat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.lstat(f.privateFile)).isFile()).toBe(true);
    const receipt = join(root, 'remote', `.cleanup-${f.scope.sessionId}-${f.material.config.incarnation}.json`);
    expect((await fs.lstat(receipt)).isFile()).toBe(true);
    if (point === 'before') expect(await fs.readdir(dirname(f.directory))).toEqual([]);
    else await expect(fs.lstat(dirname(f.directory))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.makeCache().finishFinalCleanup(f.scope.sessionId, () => true)).toBe(true);
    expect(await fs.readdir(join(root, 'remote'))).toEqual([]);
    expect(await fs.readdir(f.cacheRoot)).toEqual([]);
  }
);

it.each(['foreign-file', 'new-incarnation', 'replacement', 'symlink'] as const)(
  'retains remote parent authority and never removes %s while retrying final cleanup',
  async (kind) => {
    const f = await fixture();
    const cache = f.makeCache(transport({ parentFailure: 'before' }));
    expect(await cache.prepare(f.scope, f.material, f.directory)).toBeDefined();
    await cache.stageFinalCleanup(f.scope.sessionId, undefined, () => true, f.target);
    expect(await cache.finishFinalCleanup(f.scope.sessionId, () => true)).toBe(false);
    const parent = dirname(f.directory),
      original = await fs.lstat(parent);
    const artifact = join(parent, kind === 'new-incarnation' ? randomUUID() : 'owner-file');
    if (kind === 'foreign-file') await fs.writeFile(artifact, 'owner content', { mode: 0o600 });
    if (kind === 'new-incarnation') await fs.mkdir(artifact, { mode: 0o700 });
    if (kind === 'replacement' || kind === 'symlink') {
      await fs.rename(parent, parent + '.old');
      if (kind === 'replacement') await fs.mkdir(parent, { mode: 0o700 });
      else await fs.symlink(parent + '.old', parent);
    }
    expect(await f.makeCache().finishFinalCleanup(f.scope.sessionId, () => true)).toBe(false);
    expect((await fs.lstat(f.privateFile)).isFile()).toBe(true);
    if (kind === 'foreign-file') expect(await fs.readFile(artifact, 'utf8')).toBe('owner content');
    if (kind === 'new-incarnation') expect((await fs.lstat(artifact)).isDirectory()).toBe(true);
    if (kind === 'replacement') expect((await fs.lstat(parent)).ino).not.toBe(original.ino);
    if (kind === 'symlink') expect((await fs.lstat(parent)).isSymbolicLink()).toBe(true);
    if (kind === 'foreign-file') await fs.unlink(artifact);
    if (kind === 'new-incarnation') await fs.rmdir(artifact);
    if (kind === 'replacement' || kind === 'symlink') {
      if (kind === 'replacement') await fs.rmdir(parent);
      else await fs.unlink(parent);
      await fs.rename(parent + '.old', parent);
    }
    expect(await f.makeCache().finishFinalCleanup(f.scope.sessionId, () => true)).toBe(true);
    expect(await fs.readdir(join(root, 'remote'))).toEqual([]);
    expect(await fs.readdir(f.cacheRoot)).toEqual([]);
  }
);

it.each(['before-rmdir', 'after-rmdir-fsync', 'replaced', 'symlink'] as const)(
  'durably retries source parent cleanup across %s without adopting a replacement',
  async (point) => {
    const f = await fixture(),
      cache = f.makeCache(),
      parent = dirname(dirname(f.privateFile));
    expect(await cache.prepare(f.scope, f.material, f.directory)).toBeDefined();
    await cache.stageFinalCleanup(f.scope.sessionId, undefined, () => true, f.target);
    const remove = fs.rmdir.bind(fs),
      open = fs.open.bind(fs);
    let failed = false;
    if (point !== 'after-rmdir-fsync')
      vi.spyOn(fs, 'rmdir').mockImplementation(async (path) => {
        if (String(path) === parent && !failed) {
          failed = true;
          throw Error('Held source parent removal');
        }
        return remove(path);
      });
    else
      vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (String(args[0]) === f.cacheRoot && !failed) {
          try {
            await fs.lstat(parent);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              failed = true;
              vi.spyOn(handle, 'sync').mockRejectedValueOnce(Error('Lost source parent ACK'));
            }
          }
        }
        return handle;
      });
    expect(await cache.finishFinalCleanup(f.scope.sessionId, () => true)).toBe(false);
    expect(failed).toBe(true);
    vi.restoreAllMocks();
    expect((await fs.lstat(join(f.cacheRoot, f.scope.sessionId + '.cleanup.json'))).isFile()).toBe(true);
    await expect(fs.lstat(dirname(f.directory))).rejects.toMatchObject({ code: 'ENOENT' });
    if (point === 'after-rmdir-fsync') await expect(fs.lstat(parent)).rejects.toMatchObject({ code: 'ENOENT' });
    else expect(await fs.readdir(parent)).toEqual([]);
    if (point === 'replaced' || point === 'symlink') {
      const original = await fs.lstat(parent);
      await fs.rename(parent, parent + '.old');
      if (point === 'replaced') await fs.mkdir(parent, { mode: 0o700 });
      else await fs.symlink(parent + '.old', parent);
      expect(await f.makeCache().finishFinalCleanup(f.scope.sessionId, () => true)).toBe(false);
      if (point === 'replaced') {
        expect((await fs.lstat(parent)).ino).not.toBe(original.ino);
        await fs.rmdir(parent);
      } else {
        expect((await fs.lstat(parent)).isSymbolicLink()).toBe(true);
        await fs.unlink(parent);
      }
      await fs.rename(parent + '.old', parent);
    }
    expect(await f.makeCache().finishFinalCleanup(f.scope.sessionId, () => true)).toBe(true);
    expect(await fs.readdir(f.cacheRoot)).toEqual([]);
  }
);

it('does not transfer final parent authority to an unknown source incarnation', async () => {
  const f = await fixture(),
    cache = f.makeCache();
  expect(await cache.prepare(f.scope, f.material, f.directory)).toBeDefined();
  const unknown = join(f.cacheRoot, f.scope.sessionId, randomUUID());
  await fs.mkdir(unknown, { mode: 0o700 });
  await fs.writeFile(join(unknown, 'owner.txt'), 'source owner content', { mode: 0o600 });
  const remoteArtifact = join(dirname(f.directory), 'owner.txt');
  await fs.writeFile(remoteArtifact, 'remote owner content', { mode: 0o600 });
  await cache.stageFinalCleanup(f.scope.sessionId, undefined, () => true, f.target);
  expect(await cache.finishFinalCleanup(f.scope.sessionId, () => true)).toBe(false);
  expect((await fs.lstat(f.privateFile)).isFile()).toBe(true);
  expect(await fs.readFile(join(unknown, 'owner.txt'), 'utf8')).toBe('source owner content');
  await fs.unlink(join(unknown, 'owner.txt'));
  await fs.rmdir(unknown);
  expect(await f.makeCache().finishFinalCleanup(f.scope.sessionId, () => true)).toBe(false);
  expect((await fs.lstat(f.privateFile)).isFile()).toBe(true);
  expect(await fs.readFile(remoteArtifact, 'utf8')).toBe('remote owner content');
  await fs.unlink(remoteArtifact);
  expect(await f.makeCache().finishFinalCleanup(f.scope.sessionId, () => true)).toBe(true);
  expect(await fs.readdir(f.cacheRoot)).toEqual([]);
  expect(await fs.readdir(join(root, 'remote'))).toEqual([]);
});

it('does not delegate a final parent ACK to a retained incarnation on a different remote root', async () => {
  const f = await fixture(),
    cache = f.makeCache();
  expect(await cache.prepare(f.scope, f.material, f.directory)).toBeDefined();
  expect(cache.activate(f.scope, f.material.config.incarnation)).toBe(true);
  const material = CodexInputBroker.provisioningMaterial(f.scope.sessionId, 'exec other-root', f.scope.codexHome);
  const directory = join(root, 'other-remote-root', f.scope.sessionId, material.config.incarnation);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(join(directory, 'broker.py'), material.helper, { mode: 0o600 });
  await fs.writeFile(join(directory, 'config.json'), JSON.stringify(material.config), { mode: 0o600 });
  await fs.writeFile(join(directory, 'lock'), '', { mode: 0o600 });
  expect(await cache.prepare(f.scope, material, directory)).toBeDefined();
  const artifact = join(dirname(f.directory), 'owner.txt');
  await fs.writeFile(artifact, 'foreign root content', { mode: 0o600 });
  await cache.stageFinalCleanup(f.scope.sessionId, undefined, () => true, f.target);
  expect(await cache.finishFinalCleanup(f.scope.sessionId, () => true)).toBe(false);
  expect((await fs.lstat(f.privateFile)).isFile()).toBe(true);
  expect(await fs.readFile(artifact, 'utf8')).toBe('foreign root content');
  await expect(fs.lstat(dirname(directory))).rejects.toMatchObject({ code: 'ENOENT' });
  await fs.unlink(artifact);
  expect(await f.makeCache().finishFinalCleanup(f.scope.sessionId, () => true)).toBe(true);
  expect(await fs.readdir(f.cacheRoot)).toEqual([]);
  expect(await fs.readdir(join(root, 'remote'))).toEqual([]);
  expect(await fs.readdir(join(root, 'other-remote-root'))).toEqual([]);
});

it('does not infer parent completion from an older SSH cleanup intent with weaker ACK semantics', async () => {
  const f = await fixture(),
    cache = f.makeCache();
  expect(await cache.prepare(f.scope, f.material, f.directory)).toBeDefined();
  await cache.stageFinalCleanup(f.scope.sessionId, undefined, () => true, f.target);
  const marker = join(f.cacheRoot, f.scope.sessionId + '.cleanup.json');
  const intent = JSON.parse(await fs.readFile(marker, 'utf8'));
  expect(intent.version).toBe(2);
  intent.version = 1;
  await fs.writeFile(marker, JSON.stringify(intent));
  expect(await f.makeCache().finishFinalCleanup(f.scope.sessionId, () => true)).toBe(false);
  expect((await fs.lstat(f.privateFile)).isFile()).toBe(true);
  expect(await fs.readFile(join(f.directory, 'config.json'), 'utf8')).toContain(f.material.config.secret);
  expect(JSON.parse(await fs.readFile(marker, 'utf8')).version).toBe(1);
});

it('removes both exact session UUID parents before acknowledging final cleanup', async () => {
  const f = await fixture(),
    cache = f.makeCache();
  expect(await cache.prepare(f.scope, f.material, f.directory)).toBeDefined();
  await cache.stageFinalCleanup(f.scope.sessionId, undefined, () => true, f.target);
  expect(await cache.finishFinalCleanup(f.scope.sessionId, () => true)).toBe(true);
  await expect(fs.lstat(join(f.cacheRoot, f.scope.sessionId))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.lstat(dirname(f.directory))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readdir(f.cacheRoot)).toEqual([]);
  expect(await fs.readdir(join(root, 'remote'))).toEqual([]);
});

it.each(['enoent', 'enoent-space-directory', 'no-server', 'missing-session'] as const)(
  'retires an exact closed incarnation after the recognized native absence response: %s',
  async (kind) => {
    const f = await fixture();
    await f.writeState();
    const socket = join(
      root,
      kind === 'enoent-space-directory' ? 'socket fixtures' : 'sockets',
      'tmux-' + process.getuid!(),
      'codeman-remote'
    );
    const muxError =
      kind === 'no-server'
        ? 'no server running on ' + socket
        : kind === 'missing-session'
          ? "can't find session: codeman-ssh-" + f.scope.sessionId.slice(0, 8)
          : `error connecting to ${socket} (No such file or directory)`;
    expect(await f.clean(transport({ muxError }))).toBe(true);
    await expect(fs.lstat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(dirname(f.directory))).rejects.toMatchObject({ code: 'ENOENT' });
  }
);
it.each([
  'permission',
  'refused',
  'not-directory',
  'unknown',
  'wrong-socket',
  'wrong-user',
  'relative',
  'dot-segment',
  'control-path',
  'extra-line',
  'suffix',
  'stdout',
  'wrong-status',
  'leading-whitespace',
  'trailing-whitespace',
  'extra-newline',
] as const)('retains private cleanup material after an unverified native diagnostic: %s', async (kind) => {
  const f = await fixture();
  await f.writeState();
  const socket = join(root, 'tmux-' + process.getuid!(), 'codeman-remote');
  const missing = (path: string) => `error connecting to ${path} (No such file or directory)`;
  const muxError =
    kind === 'permission'
      ? `error connecting to ${socket} (Permission denied)`
      : kind === 'refused'
        ? `error connecting to ${socket} (Connection refused)`
        : kind === 'not-directory'
          ? `error connecting to ${socket} (Not a directory)`
          : kind === 'unknown'
            ? 'unrecognized native error'
            : kind === 'wrong-socket'
              ? missing(socket + '-other')
              : kind === 'wrong-user'
                ? missing(join(root, 'tmux-' + (process.getuid!() + 1), 'codeman-remote'))
                : kind === 'relative'
                  ? missing('tmux-' + process.getuid!() + '/codeman-remote')
                  : kind === 'dot-segment'
                    ? missing(root + '/other/../tmux-' + process.getuid!() + '/codeman-remote')
                    : kind === 'control-path'
                      ? missing(root + '/bad\npath/tmux-' + process.getuid!() + '/codeman-remote')
                      : kind === 'extra-line'
                        ? missing(socket) + '\nunknown native error'
                        : kind === 'suffix'
                          ? missing(socket) + ' unexpected'
                          : kind === 'leading-whitespace'
                            ? ' ' + missing(socket)
                            : kind === 'trailing-whitespace'
                              ? missing(socket) + ' '
                              : kind === 'extra-newline'
                                ? missing(socket) + '\n'
                                : missing(socket);
  const original = await fs.readFile(join(f.directory, 'config.json'));
  expect(
    await f.clean(
      transport({
        muxError,
        muxStdout: kind === 'stdout' ? 'unexpected stdout' : '',
        muxStatus: kind === 'wrong-status' ? 2 : 1,
      })
    )
  ).toBe(false);
  expect(await fs.readFile(join(f.directory, 'config.json'))).toEqual(original);
  expect((await fs.lstat(dirname(f.directory))).isDirectory()).toBe(true);
});
it('rechecks native absence before unlinking when a pane appears after the initial ENOENT', async () => {
  const f = await fixture();
  await f.writeState();
  const original = await fs.readFile(join(f.directory, 'config.json'));
  expect(await f.clean(transport({ muxAppears: true }))).toBe(false);
  expect(await fs.readFile(join(f.directory, 'config.json'))).toEqual(original);
  expect((await fs.lstat(dirname(f.directory))).isDirectory()).toBe(true);
});

it.each(['changed', 'removed', 'reloaded-janitor'] as const)(
  'retires launch-bound private material after wake-only settings are %s',
  async (kind) => {
    const f = await fixture(),
      cache = f.makeCache();
    f.scope.remote.wakeCommand = 'old-wake';
    f.scope.remote.wakeMac = '02:00:00:00:00:01';
    expect(await cache.prepare(f.scope, f.material, f.directory)).toBeDefined();
    const target = structuredClone(f.target);
    if (kind === 'removed') {
      delete target.remote.wakeCommand;
      delete target.remote.wakeMac;
    } else {
      target.remote.wakeCommand = 'new-wake';
      target.remote.wakeMac = '02:00:00:00:00:02';
    }
    await cache.stageFinalCleanup(f.scope.sessionId, undefined, () => true, target);
    if (kind === 'reloaded-janitor') {
      // Reload the unchanged old-format full launch hash and persisted cleanup
      // intent; no in-memory scope or newly minted authority can help this pass.
      const stop = f.makeCache().startFinalCleanupRetries(() => ({ live: false }));
      try {
        await vi.waitFor(async () => expect(await fs.readdir(f.cacheRoot)).toEqual([]));
      } finally {
        await stop();
      }
    } else expect(await cache.finishFinalCleanup(f.scope.sessionId, () => true)).toBe(true);
    await expect(fs.lstat(f.privateFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(join(root, 'remote'))).toEqual([]);
  }
);
