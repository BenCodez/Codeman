/** Every process is a disposable Python helper/child in the test-owned HOME. No native pane or SSH runs. */
import fs from 'node:fs/promises';
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { initialTaskState } from '../src/supervision/schema.js';
import { CodexInputBroker } from '../src/recovery/codex-input-broker.js';
import { initialRecoveryState } from '../src/recovery/types.js';
import { captureBrokerCleanupReferences, pruneCodexInputBrokers } from '../src/recovery/codex-broker-cleanup.js';
const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(join(homedir(), 'broker-retirement-'));
  roots.push(root);
  const brokers = join(root, 'codex-input-brokers'),
    session = join(brokers, SID);
  await fs.mkdir(session, { recursive: true, mode: 0o700 });
  const broker = await CodexInputBroker.create(session, SID, 'exec disposable-owned-child', root, root);
  const config = JSON.parse(await fs.readFile(join(broker.directory, 'config.json'), 'utf8'));
  const state = {
    version: 1,
    sessionId: SID,
    incarnation: broker.incarnation,
    pid: 2147483640,
    childPid: 2147483641,
    brokerStart: '1',
    childStart: '1',
    tainted: false,
    rawGeneration: 0,
    launchDigest: config.launchDigest,
    homeDigest: config.homeDigest,
    closed: true,
    exitStatus: 0,
    exitSignal: null,
    counters: { 'owner-pty': 0, 'owner-key': 0, 'owner-mux': 0, auto: 0, probe: 0 },
    receipts: [] as Record<string, unknown>[],
    startup: { nonce: config.startup.nonce, status: 'started' },
  };
  const statePath = join(broker.directory, 'state.json');
  await fs.writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
  await fs.writeFile(join(root, 'state.json'), JSON.stringify({ sessions: {} }), { mode: 0o600 });
  await fs.writeFile(join(root, 'mux-sessions.json'), '[]', { mode: 0o600 });
  let references: unknown = {};
  const provider = () => captureBrokerCleanupReferences(() => references);
  const prune = async (transport: typeof spawn = spawn) => pruneCodexInputBrokers(root, provider, transport);
  const save = async () => fs.writeFile(statePath, JSON.stringify(state));
  const exists = async (path = broker.directory) => !!(await fs.lstat(path).catch(() => undefined));
  return {
    root,
    session,
    broker,
    config,
    state,
    statePath,
    save,
    exists,
    prune,
    provider,
    refs: (value: unknown) => {
      references = value;
    },
  };
}
it('prunes a certified closed unreferenced UUID incarnation from before startup', async () => {
  const f = await fixture();
  await f.prune();
  expect(await f.exists()).toBe(false);
  expect(await f.exists(f.session)).toBe(false);
});
it('prunes an already empty private UUID session directory', async () => {
  const f = await fixture();
  await fs.rm(f.broker.directory, { recursive: true });
  await f.prune();
  expect(await f.exists(f.session)).toBe(false);
});
it.each(['provider', 'metadata', 'child', 'session-inode', 'root-inode', 'symlink'] as const)(
  'retains an empty container when %s changes after its fresh handshake',
  async (change) => {
    const f = await fixture();
    await fs.rm(f.broker.directory, { recursive: true });
    const outside = join(f.root, 'private-outside');
    await fs.mkdir(outside, { mode: 0o700 });
    let reached = false;
    const transport = ((...args: Parameters<typeof spawn>) => {
      const child = spawn(...args);
      let output = '';
      child.stdout!.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
        let at: number;
        while ((at = output.indexOf('\n')) !== -1) {
          const frame = JSON.parse(output.slice(0, at));
          output = output.slice(at + 1);
          if (frame.empty !== SID) continue;
          reached = true;
          if (change === 'provider') f.refs({ current: randomUUID() });
          if (change === 'metadata')
            writeFileSync(join(f.root, 'state.json'), JSON.stringify({ sessions: {}, updated: true }));
          if (change === 'child') {
            mkdirSync(join(f.session, 'owner-new-child'), { mode: 0o700 });
            writeFileSync(join(f.session, 'owner-new-child', 'keep'), 'private owner bytes');
          }
          if (change === 'session-inode' || change === 'symlink') {
            renameSync(f.session, f.session + '.held');
            if (change === 'session-inode') mkdirSync(f.session, { mode: 0o700 });
            else symlinkSync(outside, f.session);
          }
          if (change === 'root-inode') {
            const root = join(f.root, 'codex-input-brokers');
            renameSync(root, root + '.held');
            mkdirSync(f.session, { recursive: true, mode: 0o700 });
          }
        }
      });
      return child;
    }) as typeof spawn;
    await f.prune(transport);
    expect(reached).toBe(true);
    expect(await f.exists(f.session)).toBe(true);
    expect(await fs.readdir(outside)).toEqual([]);
    if (change === 'child')
      expect(await fs.readFile(join(f.session, 'owner-new-child', 'keep'), 'utf8')).toBe('private owner bytes');
  }
);
it.each(['unknown-file', 'public-directory', 'malformed-journal', 'missing-provider'] as const)(
  'retains a session container with %s evidence',
  async (kind) => {
    const f = await fixture();
    await fs.rm(f.broker.directory, { recursive: true });
    if (kind === 'unknown-file') await fs.writeFile(join(f.session, 'owner-notes'), 'retain');
    if (kind === 'public-directory') await fs.chmod(f.session, 0o755);
    if (kind === 'malformed-journal') await fs.writeFile(join(f.root, 'state.json'), '{');
    if (kind === 'missing-provider') await pruneCodexInputBrokers(f.root, () => undefined, spawn);
    else await f.prune();
    expect(await f.exists(f.session)).toBe(true);
  }
);
it('makes bounded progress through more than 512 empty parents and reaches later private brokers', async () => {
  const f = await fixture();
  const root = join(f.root, 'codex-input-brokers');
  // Retain the same closed broker under a newly created final parent, after
  // enough historical empty parents to exhaust the old deterministic scan.
  const held = join(f.root, 'held-broker');
  await fs.rename(f.broker.directory, held);
  for (let index = 0; index < 520; index++) await fs.mkdir(join(root, randomUUID()), { mode: 0o700 });
  const last = randomUUID();
  await fs.mkdir(join(root, last), { mode: 0o700 });
  await fs.rename(held, join(root, last, f.broker.incarnation));
  const configPath = join(root, last, f.broker.incarnation, 'config.json');
  const statePath = join(root, last, f.broker.incarnation, 'state.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  config.sessionId = last;
  f.state.sessionId = last;
  await fs.writeFile(configPath, JSON.stringify(config));
  await fs.writeFile(statePath, JSON.stringify(f.state));
  const before = (await fs.readdir(root)).length;
  await f.prune();
  expect((await fs.readdir(root)).length).toBeLessThan(before);
  for (let pass = 0; pass < 4 && (await fs.readdir(root)).length; pass++) {
    const remaining = (await fs.readdir(root)).length;
    await f.prune();
    expect((await fs.readdir(root)).length).toBeLessThan(remaining);
  }
  expect(await f.exists(join(root, last))).toBe(false);
  expect(await fs.readdir(root)).toEqual([]);
});
it('retains every incarnation without a complete private reference provider', async () => {
  const f = await fixture();
  await pruneCodexInputBrokers(f.root, () => undefined, spawn);
  expect(await f.exists()).toBe(true);
});
it.each(['active', 'pending', 'prior', 'offer'])(
  'retains exact %s references, including UUIDs embedded in private evidence paths',
  async (kind) => {
    const f = await fixture();
    if (kind === 'offer')
      await fs.writeFile(
        join(f.root, 'reboot-restore-offer.json'),
        JSON.stringify({ prior: join(f.broker.directory, 'state.json') }),
        { mode: 0o600 }
      );
    else f.refs({ [kind]: kind === 'prior' ? join(f.broker.directory, 'state.json') : f.broker.incarnation });
    await f.prune();
    expect(await f.exists()).toBe(true);
  }
);
it.each(['inFlight', 'deliveryUncertain', 'codexRestoreUncertain', 'recoveryInputBrokerPending'])(
  'retains while %s makes reference ownership uncertain',
  async (key) => {
    const f = await fixture();
    f.refs({ [key]: true });
    await f.prune();
    expect(await f.exists()).toBe(true);
  }
);
it.each(['state.json', 'mux-sessions.json', 'reboot-restore-offer.json'])(
  'retains on malformed durable %s despite an empty in-memory snapshot',
  async (name) => {
    const f = await fixture();
    await fs.writeFile(join(f.root, name), '{', { mode: 0o600 });
    await f.prune();
    expect(await f.exists()).toBe(true);
  }
);
it('retains on unknown durable prior broker evidence', async () => {
  const f = await fixture();
  await fs.writeFile(
    join(f.root, 'state.json'),
    JSON.stringify({ sessions: { x: { __codexInputBroker: 'unknown' } } })
  );
  await f.prune();
  expect(await f.exists()).toBe(true);
});
it.each(['tainted', 'reserved', 'incomplete', 'live', 'malformed'])('retains %s journal evidence', async (kind) => {
  const f = await fixture();
  if (kind === 'tainted') {
    f.state.tainted = true;
    f.state.rawGeneration = 1;
  }
  if (kind === 'reserved') f.state.startup.status = 'reserved';
  if (kind === 'incomplete') f.state.counters.auto = 1;
  if (kind === 'live') f.state.closed = false;
  if (kind === 'malformed') f.state.pid = 0;
  await f.save();
  await f.prune();
  expect(await f.exists()).toBe(true);
});
it('retains a certified closed journal whose exact broker PID/birth is still present', async () => {
  const f = await fixture(),
    raw = await fs.readFile('/proc/self/stat', 'utf8');
  f.state.pid = process.pid;
  f.state.brokerStart = raw
    .slice(raw.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/)[19];
  await f.save();
  await f.prune();
  expect(await f.exists()).toBe(true);
});
it('retains a certified closed journal whose exact child PID/birth is still present', async () => {
  const f = await fixture(),
    raw = await fs.readFile('/proc/self/stat', 'utf8');
  f.state.childPid = process.pid;
  f.state.childStart = raw
    .slice(raw.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/)[19];
  await f.save();
  await f.prune();
  expect(await f.exists()).toBe(true);
});
it('retains an active kernel issuer lease even with otherwise closed native evidence', async () => {
  const f = await fixture();
  const holder = spawn(
    'python3',
    [
      '-I',
      '-c',
      "import fcntl,os,sys; f=os.open(sys.argv[1],os.O_RDWR); fcntl.flock(f,fcntl.LOCK_EX); print('ready',flush=True); sys.stdin.read(1)",
      join(f.broker.directory, 'lock'),
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );
  try {
    await once(holder.stdout, 'data');
    await f.prune();
    expect(await f.exists()).toBe(true);
  } finally {
    holder.stdin.end();
    await once(holder, 'close');
  }
  await f.prune();
  expect(await f.exists()).toBe(false);
});
it('rechecks the exact reference snapshot after helper READY and before retirement', async () => {
  const f = await fixture();
  const transport = ((...args: Parameters<typeof spawn>) => {
    const child = spawn(...args);
    child.stdout!.once('data', () => f.refs({ current: f.broker.incarnation }));
    return child;
  }) as typeof spawn;
  await f.prune(transport);
  expect(await f.exists()).toBe(true);
});
it.each(['config', 'state', 'metadata'])(
  'retains when %s changes after READY before the final private scan',
  async (kind) => {
    const f = await fixture();
    const transport = ((...args: Parameters<typeof spawn>) => {
      const child = spawn(...args);
      child.stdout!.once('data', () => {
        if (kind === 'config')
          writeFileSync(
            join(f.broker.directory, 'config.json'),
            JSON.stringify({ ...f.config, command: 'new owner command' })
          );
        if (kind === 'state')
          writeFileSync(f.statePath, JSON.stringify({ ...f.state, tainted: true, rawGeneration: 1 }));
        if (kind === 'metadata')
          writeFileSync(join(f.root, 'state.json'), JSON.stringify({ current: f.broker.incarnation }));
      });
      return child;
    }) as typeof spawn;
    await f.prune(transport);
    expect(await f.exists()).toBe(true);
    expect(await fs.stat(join(f.broker.directory, 'broker.py'))).toBeDefined();
  }
);
it('does not follow a symlink incarnation or remove unknown files', async () => {
  const f = await fixture();
  await fs.writeFile(join(f.broker.directory, 'owner-notes'), 'retain');
  const outside = join(f.root, 'outside');
  await fs.mkdir(outside, { mode: 0o700 });
  await fs.writeFile(join(outside, 'keep'), 'retain');
  await fs.symlink(outside, join(f.session, randomUUID()));
  await f.prune();
  expect(await f.exists()).toBe(true);
  expect(await fs.readFile(join(outside, 'keep'), 'utf8')).toBe('retain');
});
it('allows full-window receipt eviction while preserving each retained channel head', async () => {
  const f = await fixture();
  f.state.counters['owner-pty'] = 1;
  f.state.counters.probe = 129;
  f.state.receipts = Array.from({ length: 128 }, (_, i) => ({
    channel: 'probe',
    counter: i + 2,
    nonce: randomUUID(),
    conversationId: '',
    hash: createHash('sha256').update('probe').digest('hex'),
    status: 'sent',
  }));
  await f.save();
  await f.prune();
  expect(await f.exists()).toBe(false);
});
it('resumes only a private certified retirement tombstone after an interrupted exact-file deletion', async () => {
  const f = await fixture();
  const transport = ((command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) =>
    spawn(
      command,
      args.map((arg) =>
        arg.replace(
          'os.unlink(n,dir_fd=fd)',
          'os.unlink(n,dir_fd=fd)\n                raise ValueError("fixture interrupted")'
        )
      ),
      options
    )) as typeof spawn;
  await f.prune(transport);
  expect(await f.exists()).toBe(false);
  const retired = join(f.session, '.retired-' + f.broker.incarnation);
  expect(await f.exists(retired)).toBe(true);
  expect(await fs.readdir(retired)).not.toContain('broker.py');
  await f.prune();
  expect(await f.exists(retired)).toBe(false);
});
it('retains malformed retirement tombstones rather than deleting arbitrary leftovers', async () => {
  const f = await fixture(),
    retired = join(f.session, '.retired-' + randomUUID());
  await fs.mkdir(retired, { mode: 0o700 });
  await fs.writeFile(join(retired, '.retirement.json'), '{}', { mode: 0o600 });
  await f.prune();
  expect(await f.exists(retired)).toBe(true);
});
it('does not auto-run a janitor from test-mode runtime hooks without an explicit disposable transport', async () => {
  const f = await fixture();
  await pruneCodexInputBrokers(f.root, f.provider);
  expect(await f.exists()).toBe(true);
});
it('cleans actual normally exited disposable broker and child only after both process identities are gone', async () => {
  const f = await fixture();
  const broker = await CodexInputBroker.create(f.session, SID, 'exec python3 -c "pass"', f.root, f.root);
  const child = spawn(
    'python3',
    ['-I', join(broker.directory, 'broker.py'), broker.directory, broker.configurationDigest],
    {
      env: { PATH: process.env.PATH, CODEX_HOME: f.root },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  child.stdout.resume();
  child.stderr.resume();
  await once(child, 'close');
  const state = await broker.readState();
  expect(state).toMatchObject({ closed: true, exitStatus: 0, startup: { status: 'started' } });
  expect(state!.pid).toBe(child.pid);
  expect(state!.childPid).toBeGreaterThan(0);
  expect(await f.exists(broker.directory)).toBe(true);
  await f.prune();
  expect(await f.exists(broker.directory)).toBe(false);
});
it('bounds timed-out helpers to two retained slots until their actual process close', async () => {
  const f = await fixture();
  let launched = 0;
  const children: ReturnType<typeof spawn>[] = [];
  const transport = ((_command: string, _args: readonly string[], options: Parameters<typeof spawn>[2]) => {
    launched++;
    const child = spawn('python3', ['-I', '-c', 'import time; time.sleep(2.4)'], options);
    // Model a helper stuck in an uninterruptible filesystem syscall. It remains
    // our disposable process and exits itself; a timeout must retain its slot.
    child.kill = () => true;
    children.push(child);
    return child;
  }) as typeof spawn;
  const started = performance.now();
  await Promise.all([f.prune(transport), f.prune(transport)]);
  expect(performance.now() - started).toBeLessThan(2300);
  await f.prune(transport);
  expect(launched).toBe(2);
  expect(await f.exists()).toBe(true);
  await Promise.all(children.map((child) => once(child, 'close')));
  await f.prune();
  expect(await f.exists()).toBe(false);
});
it('accepts a closed superseded broker with valid guarded startup witnesses and a non-writable shared data ancestor', async () => {
  const f = await fixture();
  const info = await fs.stat(f.root),
    path = join(f.root, 'private-input');
  await fs.writeFile(path, 'proof', { mode: 0o600 });
  const file = await fs.stat(path);
  await f.broker.setStartupAuthority(
    [
      {
        path,
        dev: file.dev,
        ino: file.ino,
        size: file.size,
        mtimeMs: file.mtimeMs,
        ctimeMs: file.ctimeMs,
        hash: createHash('sha256').update('proof').digest('hex'),
        maxBytes: 1024,
      },
    ],
    undefined,
    [{ path: f.root, kind: 'directory', dev: info.dev, ino: info.ino }],
    [],
    Number(process.hrtime.bigint() / 1000000n) + 2000
  );
  const config = JSON.parse(await fs.readFile(join(f.broker.directory, 'config.json'), 'utf8'));
  f.state.startup.nonce = config.startup.nonce;
  await f.save();
  const currentIncarnation = randomUUID();
  await fs.writeFile(
    join(f.root, 'state.json'),
    JSON.stringify({
      sessions: {
        [SID]: {
          id: SID,
          pid: process.pid,
          status: 'idle',
          workingDir: f.root,
          createdAt: 1,
          lastActivityAt: 1,
          __codexInputBroker: currentIncarnation,
        },
      },
    })
  );
  await fs.writeFile(
    join(f.root, 'mux-sessions.json'),
    JSON.stringify([
      {
        sessionId: SID,
        muxName: 'codeman-' + SID,
        pid: process.pid,
        createdAt: 1,
        workingDir: f.root,
        mode: 'codex',
        attached: false,
        recoveryInputBroker: currentIncarnation,
      },
    ])
  );
  await fs.writeFile(
    join(f.root, 'recovery.json'),
    JSON.stringify({ version: 1, sessions: { [SID]: initialRecoveryState() } }),
    { mode: 0o600 }
  );
  await fs.chmod(f.root, 0o755);
  await f.prune();
  expect(await f.exists()).toBe(false);
  expect(await fs.readFile(path, 'utf8')).toBe('proof');
});
it('does not infer native death when proc is unavailable for a live kernel PID', async () => {
  const f = await fixture(),
    raw = await fs.readFile('/proc/self/stat', 'utf8');
  f.state.pid = process.pid;
  f.state.brokerStart = raw
    .slice(raw.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/)[19];
  await f.save();
  const transport = ((command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) =>
    spawn(
      command,
      args.map((arg) =>
        arg.replace(
          'DEADLINE = time.monotonic()',
          `real_open=os.open
def no_proc(path,*args,**kwargs):
    if isinstance(path,str) and path.startswith('/proc/'): raise FileNotFoundError('fixture proc unavailable')
    return real_open(path,*args,**kwargs)
os.open=no_proc
DEADLINE = time.monotonic()`
        )
      ),
      options
    )) as typeof spawn;
  await f.prune(transport);
  expect(await f.exists()).toBe(true);
});
it.each(['config', 'state'])(
  'retains malformed boolean %s versions rather than treating True as version 1',
  async (kind) => {
    const f = await fixture();
    const path = join(f.broker.directory, kind === 'config' ? 'config.json' : 'state.json');
    const value = JSON.parse(await fs.readFile(path, 'utf8'));
    value.version = true;
    await fs.writeFile(path, JSON.stringify(value));
    await f.prune();
    expect(await f.exists()).toBe(true);
  }
);
it('retains malformed boolean retirement marker versions', async () => {
  const f = await fixture();
  const transport = ((command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) =>
    spawn(
      command,
      args.map((arg) =>
        arg.replace(
          '        for n in FILES:\n            if n in captures:',
          '        return False\n        for n in FILES:\n            if n in captures:'
        )
      ),
      options
    )) as typeof spawn;
  await f.prune(transport);
  const retired = join(f.session, '.retired-' + f.broker.incarnation),
    path = join(retired, '.retirement.json');
  const marker = JSON.parse(await fs.readFile(path, 'utf8'));
  marker.version = true;
  await fs.writeFile(path, JSON.stringify(marker));
  await f.prune();
  expect(await f.exists(retired)).toBe(true);
});
it.each(['state-row', 'mux-row', 'recovery-flight', 'backup-reference', 'backup-malformed'])(
  'retains uncertain complete durable domain: %s',
  async (kind) => {
    const f = await fixture();
    if (kind === 'state-row')
      await fs.writeFile(join(f.root, 'state.json'), JSON.stringify({ sessions: { [SID]: null } }));
    if (kind === 'mux-row') await fs.writeFile(join(f.root, 'mux-sessions.json'), '[42]');
    if (kind === 'recovery-flight')
      await fs.writeFile(
        join(f.root, 'recovery.json'),
        JSON.stringify({ version: 1, sessions: { [SID]: { inFlight: { conversationId: SID } } } }),
        { mode: 0o600 }
      );
    if (kind === 'backup-reference')
      await fs.writeFile(
        join(f.root, 'state.json.bak'),
        JSON.stringify({ sessions: {}, prior: f.broker.incarnation }),
        { mode: 0o600 }
      );
    if (kind === 'backup-malformed') await fs.writeFile(join(f.root, 'state.json.bak'), '{', { mode: 0o600 });
    await f.prune();
    expect(await f.exists()).toBe(true);
  }
);
it.each(['root', 'nested'])(
  'rejects a thenable %s reference domain instead of treating a Promise as an empty snapshot',
  async (kind) => {
    const f = await fixture();
    const read = () =>
      kind === 'root'
        ? Promise.resolve({ prior: f.broker.incarnation })
        : { prior: Promise.resolve(f.broker.incarnation) };
    await pruneCodexInputBrokers(f.root, () => captureBrokerCleanupReferences(read), spawn);
    expect(await f.exists()).toBe(true);
  }
);
it('stops after a retirement fsync crosses the original deadline without deleting any private files', async () => {
  const f = await fixture();
  let closing: Promise<unknown> | undefined;
  const transport = ((command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
    const child = spawn(
      command,
      args.map((arg) =>
        arg.replace(
          'os.fsync(sessionfd)\n            name=target',
          'time.sleep(2.1)\n            os.fsync(sessionfd)\n            name=target'
        )
      ),
      options
    );
    child.kill = () => true;
    closing = once(child, 'close');
    return child;
  }) as typeof spawn;
  await f.prune(transport);
  await closing;
  const retired = join(f.session, '.retired-' + f.broker.incarnation);
  expect(await fs.readdir(retired)).toEqual(
    expect.arrayContaining(['broker.py', 'config.json', 'state.json', 'lock', '.retirement.json'])
  );
  await f.prune();
  expect(await f.exists(retired)).toBe(false);
});
it('rejects a final thenable reference read even when its JSON would match the original empty object', async () => {
  const f = await fixture();
  let value: unknown = {};
  const snapshot = captureBrokerCleanupReferences(() => value)!;
  value = Promise.reject(Error('fixture unavailable final references'));
  expect(snapshot.isCurrent()).toBe(false);
  await pruneCodexInputBrokers(f.root, () => snapshot, spawn);
  expect(await f.exists()).toBe(true);
});

it.each(['primary', 'shadow', 'malformed-shadow', 'future-primary', 'future-shadow', 'healthy-other-offer'] as const)(
  'rechecks the reboot offer and authoritative previous shadow (%s)',
  async (kind) => {
    const f = await fixture();
    const state = {
      id: SID,
      mode: 'codex',
      workingDir: f.root,
      status: 'error',
      pid: 123,
      createdAt: 1,
      lastActivityAt: 1,
      __codexPriorInputBroker:
        kind === 'healthy-other-offer' || kind.startsWith('future-') ? randomUUID() : f.broker.incarnation,
    };
    const value = {
      version: 1,
      builtAt: kind.startsWith('future-') ? Date.now() + 60_000 : Date.now(),
      entries: [
        {
          sessionId: SID,
          mode: 'codex',
          workingDir: f.root,
          resumeConversationId: SID,
          state,
        },
      ],
    };
    const name =
      kind === 'primary' || kind === 'future-primary' || kind === 'healthy-other-offer'
        ? 'reboot-restore-offer.json'
        : 'reboot-restore-offer.json.previous';
    await fs.writeFile(join(f.root, name), kind === 'malformed-shadow' ? '{' : JSON.stringify(value), { mode: 0o600 });
    await f.prune();
    expect(await f.exists()).toBe(kind !== 'healthy-other-offer');
  }
);

it.each(
  ['tasks.json', 'action-reservations.json'].flatMap((name) =>
    (['healthy', 'referenced', 'flight', 'malformed', 'unknown'] as const).map((kind) => ({ name, kind }))
  )
)('checks exact durable task/action journal evidence: $name $kind', async ({ name, kind }) => {
  const f = await fixture();
  const state = {
    ...initialTaskState(),
    objective: kind === 'referenced' ? f.broker.incarnation : 'Other dormant task',
  };
  const row =
    kind === 'flight'
      ? { ...state, inFlight: { key: 'unresolved', startedAt: 1 } }
      : kind === 'malformed'
        ? null
        : kind === 'unknown'
          ? { ...state, futureSchema: true }
          : state;
  await fs.writeFile(join(f.root, name), JSON.stringify({ version: 1, sessions: { [SID]: row } }), { mode: 0o600 });
  await f.prune();
  expect(await f.exists()).toBe(kind !== 'healthy');
});

it.each(['healthy', 'malformed', 'unknown'] as const)('validates nested board task evidence (%s)', async (kind) => {
  const f = await fixture();
  const task =
    kind === 'malformed'
      ? null
      : kind === 'unknown'
        ? { ...initialTaskState(), futureSchema: true }
        : initialTaskState();
  await fs.writeFile(
    join(f.root, 'state.json'),
    JSON.stringify({
      sessions: {
        [SID]: {
          id: SID,
          workingDir: f.root,
          status: 'idle',
          pid: null,
          createdAt: 1,
          lastActivityAt: 1,
          task,
        },
      },
    }),
    { mode: 0o600 }
  );
  await f.prune();
  expect(await f.exists()).toBe(kind !== 'healthy');
});

it.each(['session-key', 'criterion-id', 'reason'] as const)(
  'rejects Unicode task schema identifiers (%s)',
  async (kind) => {
    const f = await fixture();
    const state = {
      ...initialTaskState(),
      criteria: [
        {
          id: kind === 'criterion-id' ? 'réview' : 'review',
          kind: 'manual',
          description: 'Owner review',
          verified: false,
        },
      ],
      reason: kind === 'reason' ? 'désactivé' : 'disabled',
    };
    const key = kind === 'session-key' ? 'wörker' : SID;
    await fs.writeFile(join(f.root, 'tasks.json'), JSON.stringify({ version: 1, sessions: { [key]: state } }), {
      mode: 0o600,
    });
    await f.prune();
    expect(await f.exists()).toBe(true);
  }
);

it.each(['session-key', 'handled-evidence', 'mux-name'] as const)(
  'retains malformed Unicode %s metadata instead of applying Python word-character semantics',
  async (kind) => {
    const f = await fixture();
    if (kind === 'session-key') {
      expect(/^[\w-]{1,100}$/.test('worker-é')).toBe(false);
      await fs.writeFile(
        join(f.root, 'recovery.json'),
        JSON.stringify({ version: 1, sessions: { 'worker-é': initialRecoveryState() } }),
        { mode: 0o600 }
      );
    }
    if (kind === 'handled-evidence') {
      expect(/^[\w:.-]+$/.test('proof-é')).toBe(false);
      const state = initialRecoveryState();
      state.handledEvidence = ['proof-é'];
      await fs.writeFile(join(f.root, 'recovery.json'), JSON.stringify({ version: 1, sessions: { [SID]: state } }), {
        mode: 0o600,
      });
    }
    if (kind === 'mux-name')
      await fs.writeFile(
        join(f.root, 'mux-sessions.json'),
        JSON.stringify([
          {
            sessionId: SID,
            muxName: 'codeman-é',
            pid: process.pid,
            createdAt: 1,
            workingDir: f.root,
            mode: 'codex',
            attached: false,
          },
        ])
      );
    await f.prune();
    expect(await f.exists()).toBe(true);
  }
);
it('permits unrelated healthy ASCII recovery evidence and native session identifiers', async () => {
  const f = await fixture(),
    state = initialRecoveryState();
  state.handledEvidence = ['proof_A-1:received.done'];
  await fs.writeFile(
    join(f.root, 'recovery.json'),
    JSON.stringify({ version: 1, sessions: { 'worker-ASCII_1': state } }),
    { mode: 0o600 }
  );
  await fs.writeFile(
    join(f.root, 'mux-sessions.json'),
    JSON.stringify([
      {
        sessionId: SID,
        muxName: 'codeman-' + SID,
        pid: process.pid,
        createdAt: 1,
        workingDir: f.root,
        mode: 'codex',
        attached: false,
      },
    ])
  );
  await f.prune();
  expect(await f.exists()).toBe(false);
});
it.each([true, false])('checks decoded JSON private broker references (current incarnation=%s)', async (referenced) => {
  const f = await fixture();
  const prior = referenced ? f.broker.incarnation : randomUUID();
  const escaped = [...prior].map((character) => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  const raw = '{"sessions":{},"privatePrior":{"incarnation":"' + escaped + '"}}';
  expect(raw).not.toContain(f.broker.incarnation);
  await fs.writeFile(join(f.root, 'state.json'), raw);
  await f.prune();
  expect(await f.exists()).toBe(referenced);
});
it.each(['NaN', 'Infinity', '-Infinity', '1e10000', '1' + '0'.repeat(400), '-1' + '0'.repeat(400)])(
  'retains non-finite JSON metadata instead of accepting Python token %s',
  async (token) => {
    const f = await fixture();
    await fs.writeFile(join(f.root, 'state.json'), '{"sessions":{},"settings":{"unrelated":' + token + '}}');
    await f.prune();
    expect(await f.exists()).toBe(true);
  }
);
it.each(['1.25e2', '125', '9007199254740993'])('allows ordinary finite JSON metadata number %s', async (token) => {
  const f = await fixture();
  await fs.writeFile(join(f.root, 'state.json'), '{"sessions":{},"settings":{"unrelated":' + token + '}}');
  await f.prune();
  expect(await f.exists()).toBe(false);
});
