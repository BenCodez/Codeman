/** Restarted source-host signer admission; fake remote reads and no worker/native processes. */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { TmuxManager, buildRemoteCodexPaneCommand } from '../src/tmux-manager.js';
import type { MuxSession } from '../src/mux-interface.js';
import { CodexInputBroker } from '../src/recovery/codex-input-broker.js';
import { OwnedRemoteBrokerCache, ownedRemoteBrokerCache } from '../src/recovery/remote-input-broker-cache.js';
import { observeOwnedRemoteBroker } from '../src/recovery/remote-broker-launch.js';
import { safeRmHomeTree } from './mocks/test-helpers.js';

const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error('Real worker/SSH/native processes forbidden');
  })
);
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  exec: forbidden,
  execFile: forbidden,
  execSync: forbidden,
  execFileSync: forbidden,
  spawn: forbidden,
  spawnSync: forbidden,
  fork: forbidden,
}));
vi.mock('../src/recovery/remote-broker-launch.js', () => ({ observeOwnedRemoteBroker: vi.fn() }));
const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const roots: string[] = [];
const sessions: Session[] = [];
let originalDataDir = process.env.CODEMAN_DATA_DIR;
afterEach(async () => {
  for (const session of sessions.splice(0)) await Reflect.get(session, '_ownedInputTail');
  expect(forbidden).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(observeOwnedRemoteBroker).mockReset();
  forbidden.mockClear();
  if (originalDataDir === undefined) delete process.env.CODEMAN_DATA_DIR;
  else process.env.CODEMAN_DATA_DIR = originalDataDir;
  for (const root of roots.splice(0)) safeRmHomeTree(root);
});
async function fixture() {
  originalDataDir = process.env.CODEMAN_DATA_DIR;
  const root = await fs.mkdtemp(join(homedir(), 'cold-remote-owner-'));
  roots.push(root);
  process.env.CODEMAN_DATA_DIR = join(root, 'data');
  const remote = { owned: true, host: 'worker.invalid', remotePath: '/remote/work' };
  const config = { noDaemon: true, resumeSessionId: '11111111-2222-4333-8444-555555555555' };
  const home = '/remote/home';
  const material = CodexInputBroker.provisioningMaterial(
    ID,
    buildRemoteCodexPaneCommand({ sessionId: ID, remotePath: remote.remotePath, codexHome: home, codexConfig: config }),
    home
  );
  const scope = { sessionId: ID, remote, workingDir: remote.remotePath, codexHome: home, owner: 'alice' };
  const cache = new OwnedRemoteBrokerCache(join(root, 'cache'));
  const descriptor = await cache.prepare(scope, material, `/remote/private/${ID}/${material.config.incarnation}`);
  expect(descriptor).toBeDefined();
  cache.retire(ID); // Actual source-host restart: durable private material, zero cached signers.
  expect(cache.signer(scope, material.config.incarnation)).toBeUndefined();
  for (const method of ['load', 'get', 'signer', 'observe'] as const)
    vi.spyOn(ownedRemoteBrokerCache, method).mockImplementation(cache[method].bind(cache) as never);
  const record: MuxSession = JSON.parse(
    JSON.stringify({
      sessionId: ID,
      muxName: 'codeman-aaaaaaaa',
      pid: 700,
      mode: 'codex',
      workingDir: '/local/work',
      createdAt: 1,
      attached: true,
      owner: 'alice',
      remote,
      recoveryCodexHome: home,
      recoveryIsolated: true,
      recoveryInputBroker: material.config.incarnation,
      codexRestoreConfig: config,
    })
  );
  const manager = new TmuxManager();
  Reflect.get(manager, 'sessions').set(ID, record);
  const state = {
    version: 1,
    sessionId: ID,
    incarnation: material.config.incarnation,
    pid: 900,
    childPid: 901,
    brokerStart: '100',
    childStart: '101',
    tainted: false,
    rawGeneration: 0,
    launchDigest: material.config.launchDigest,
    homeDigest: material.config.homeDigest,
    closed: false,
    exitStatus: null,
    exitSignal: null,
    counters: { 'owner-pty': 0, 'owner-key': 0, 'owner-mux': 0, auto: 0, probe: 0 },
    receipts: [],
    startup: { nonce: material.config.startup.nonce, status: 'started' },
  };
  let gate: Promise<void> | undefined;
  const observed = vi.mocked(observeOwnedRemoteBroker).mockImplementation(async (_remote, request, authority) => {
    expect(request).toMatchObject({ sessionId: ID, descriptor, inspect: true });
    expect(await authority.prepare()).toBe(true);
    await gate;
    const serialized = JSON.stringify(state);
    return {
      status: 'observed',
      serialized,
      panePid: 900,
      witness: {
        path: descriptor!.directory + '/state.json',
        dev: 1,
        ino: 2,
        size: Buffer.byteLength(serialized),
        mtimeMs: 1,
        ctimeMs: 1,
        hash: hash(serialized),
        maxBytes: 98304,
      },
    };
  });
  const session = new Session({
    id: ID,
    mode: 'codex',
    workingDir: '/local/work',
    owner: 'alice',
    remote,
    codexConfig: config,
    envOverrides: { CODEX_HOME: home },
    useMux: true,
    mux: manager,
    muxSession: record,
  });
  sessions.push(session);
  const write = vi.fn();
  Reflect.set(session, 'ptyProcess', { write, resize: vi.fn() });
  expect(await session.ensureRecoveryIdentityFence()).toBe(true);
  return {
    session,
    manager,
    record,
    cache,
    scope,
    descriptor: descriptor!,
    material,
    state,
    observed,
    write,
    privateFile: join(root, 'cache', ID, material.config.incarnation, 'private.json'),
    hold() {
      let release!: () => void;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

it.each(['pty', 'mux', 'named-key'] as const)(
  'hydrates a cold surviving worker for %s owner input without enabling or polling recovery',
  async (path) => {
    const f = await fixture();
    expect(f.manager.canDeliverCodexOwnerInput(ID)).toBe(false);
    const text = path === 'named-key' ? '\n' : 'Exact owner paste 🧭';
    const controlledSend = async () => {
      const frame = f.manager.wrapCodexOwnerInput(ID, text, path === 'named-key' ? 'owner-key' : 'owner-pty');
      expect(frame.status).toBe('framed');
      f.write(frame.data);
      return true;
    };
    if (path === 'mux') vi.spyOn(f.manager, 'sendInput').mockImplementation(controlledSend);
    const delivered =
      path === 'mux'
        ? await f.session.writeViaMux(text, { fromUser: true })
        : path === 'named-key'
          ? await f.session.sendNamedKey(text, async () => {
              await controlledSend();
            })
          : await f.session.writeAsync(text, { fromUser: true });
    expect(delivered).toBe(true);
    expect(f.observed).toHaveBeenCalledTimes(1);
    expect(f.write).toHaveBeenCalledTimes(1);
    const wire = f.write.mock.calls[0][0] as string;
    expect(wire.startsWith('\x1eCODEMAN_INPUT_V1:')).toBe(true);
    const packet = JSON.parse(Buffer.from(wire.slice(1, -1).split(':')[1], 'base64').toString());
    expect(packet).toMatchObject({
      channel: path === 'named-key' ? 'owner-key' : 'owner-pty',
      incarnation: f.material.config.incarnation,
    });
    expect(Buffer.from(packet.data, 'base64').toString('utf8')).toBe(text);
    expect(f.manager.canDeliverCodexOwnerInput(ID)).toBe(true);
    expect(await f.session.writeAsync('later owner paste', { fromUser: true })).toBe(true);
    expect(f.observed).toHaveBeenCalledTimes(1);
  }
);

it.each([
  'cancelled',
  'owner',
  'home',
  'config',
  'record',
  'pending',
  'malformed',
  'closed',
  'tainted',
  'stale-native',
] as const)('refuses cold hydration before any owner bytes when %s changes', async (change) => {
  const f = await fixture(),
    release = f.hold();
  let current = true;
  const work = f.session.writeAsync('must stay unsent', { fromUser: true, isCurrent: () => current });
  await vi.waitFor(() => expect(f.observed).toHaveBeenCalledTimes(1));
  if (change === 'cancelled') current = false;
  if (change === 'owner') f.record.owner = 'bob';
  if (change === 'home') f.record.recoveryCodexHome = '/changed/home';
  if (change === 'config') f.record.codexRestoreConfig = { ...f.record.codexRestoreConfig, model: 'changed-model' };
  if (change === 'record') Reflect.get(f.manager, 'sessions').set(ID, { ...f.record });
  if (change === 'pending') f.record.recoveryInputBrokerPending = '99999999-2222-4333-8444-555555555555';
  if (change === 'malformed') f.state.startup.nonce = 'invalid';
  if (change === 'closed') f.state.closed = true;
  if (change === 'tainted') f.state.tainted = true;
  if (change === 'stale-native') f.state.pid = 999;
  release();
  await expect(work).rejects.toThrow();
  expect(f.write).not.toHaveBeenCalled();
  expect(f.record.recoveryInputBroker).toBe(f.material.config.incarnation);
});

it('coalesces current cold hydration and refuses a revoked waiter without minting extra frames', async () => {
  const f = await fixture(),
    release = f.hold();
  const first = f.manager.prepareCodexOwnerInput(ID, () => true, f.record);
  const second = f.manager.prepareCodexOwnerInput(ID, () => true, f.record);
  let granted = true;
  const revoked = f.manager.prepareCodexOwnerInput(ID, () => granted, f.record);
  await vi.waitFor(() => expect(f.observed).toHaveBeenCalledTimes(1));
  granted = false;
  release();
  expect(await first).toBe(true);
  expect(await second).toBe(true);
  expect(await revoked).toBe(false);
  expect(f.observed).toHaveBeenCalledTimes(1);
  expect(f.write).not.toHaveBeenCalled();
  expect(f.cache.signer(f.scope, f.material.config.incarnation)?.frame('owner-pty', 'first')?.receipt.counter).toBe(1);
});

it.each(['missing-material', 'malformed-material', 'wrong-command', 'wrong-home', 'unknown-worker'] as const)(
  'keeps source metadata and refuses cold owner bytes for %s',
  async (change) => {
    const f = await fixture();
    if (change === 'missing-material') await fs.unlink(f.privateFile);
    if (change === 'malformed-material') await fs.writeFile(f.privateFile, '{}');
    if (change === 'wrong-command') f.record.codexRestoreConfig = { ...f.record.codexRestoreConfig, model: 'changed' };
    if (change === 'wrong-home') f.record.recoveryCodexHome = '/foreign/home';
    if (change === 'unknown-worker') f.observed.mockResolvedValue({ status: 'unknown' });
    await expect(f.session.writeAsync('never raw fallback', { fromUser: true })).rejects.toThrow();
    expect(f.write).not.toHaveBeenCalled();
    if (change !== 'unknown-worker') expect(f.observed).not.toHaveBeenCalled();
    expect(f.record.recoveryInputBroker).toBe(f.material.config.incarnation);
  }
);

it('keeps one expired hydration job retained until its actual remote read settles', async () => {
  const f = await fixture();
  await f.cache.load(f.scope, f.material.config.incarnation);
  const release = f.hold();
  vi.useFakeTimers();
  try {
    const first = f.manager.prepareCodexOwnerInput(ID, () => true, f.record);
    await vi.waitFor(() => expect(f.observed).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(2001);
    expect(await first).toBe(false);
    expect(await f.manager.prepareCodexOwnerInput(ID, () => true, f.record)).toBe(false);
    expect(f.observed).toHaveBeenCalledTimes(1);
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.cache.signer(f.scope, f.material.config.incarnation)).toBeUndefined();
    expect(f.write).not.toHaveBeenCalled();
  } finally {
    release();
    vi.useRealTimers();
  }
});

it('rejects an equal-looking replacement mux record before hydration for the old Session', async () => {
  const f = await fixture();
  Reflect.get(f.manager, 'sessions').set(ID, { ...f.record });
  await expect(f.session.writeAsync('old-pane text', { fromUser: true })).rejects.toThrow();
  expect(f.observed).not.toHaveBeenCalled();
  expect(f.write).not.toHaveBeenCalled();
});

it.each(['pty', 'mux', 'named-key'] as const)(
  'historical host-reboot evidence cannot ACK %s input; a fresh live worker can',
  async (path) => {
    const f = await fixture();
    await f.session.getOwnedRemoteInputBroker();
    const serialized = JSON.stringify(f.state);
    const witness = {
      path: f.descriptor.directory + '/state.json',
      dev: 1,
      ino: 2,
      size: Buffer.byteLength(serialized),
      mtimeMs: 1,
      ctimeMs: 1,
      hash: hash(serialized),
      maxBytes: 98304,
    };
    // First certify a live worker, then receive the same journal after its host
    // rebooted: the file survives with closed:false, both native processes do not.
    expect(f.session.observeOwnedRemoteInputBroker(serialized, witness, 900)).toBeDefined();
    expect(f.manager.canDeliverCodexOwnerInput(ID)).toBe(true);
    const signer = f.cache.signer(f.scope, f.material.config.incarnation)!;
    const proof = f.session.observeOwnedRemoteInputBroker(serialized, witness, 900, false)!;
    expect(proof).toMatchObject({ closed: false });
    expect(f.session.isOwnedRemoteInputBrokerProofCurrent(proof)).toBe(true);
    expect(f.manager.canDeliverCodexOwnerInput(ID)).toBe(false);
    f.observed.mockResolvedValueOnce({ status: 'unknown' });
    const send = vi.fn(async () => {
      const framed = f.manager.wrapCodexOwnerInput(
        ID,
        'retained owner input',
        path === 'named-key' ? 'owner-key' : 'owner-pty'
      );
      expect(framed.status).toBe('framed');
      f.write(framed.data);
      return true;
    });
    if (path === 'mux') vi.spyOn(f.manager, 'sendInput').mockImplementation(send);
    const deliver = () =>
      path === 'mux'
        ? f.session.writeViaMux('retained owner input', { fromUser: true })
        : path === 'named-key'
          ? f.session.sendNamedKey('Enter', async () => {
              await send();
            })
          : f.session.writeAsync('retained owner input', { fromUser: true });
    await expect(deliver()).rejects.toThrow();
    expect(f.observed).toHaveBeenCalledOnce();
    expect(f.write).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(f.cache.signer(f.scope, f.material.config.incarnation)).toBe(signer);
    expect(signer.canFrame).toBe(false);
    // The next actual live observation may restore readiness. No historical
    // frame was minted, so the original delivery still starts at owner counter1.
    expect(await deliver()).toBe(true);
    expect(f.observed).toHaveBeenCalledTimes(2);
    expect(f.write).toHaveBeenCalledOnce();
    const wire = f.write.mock.calls[0][0] as string;
    const packet = JSON.parse(Buffer.from(wire.slice(1, -1).split(':')[1], 'base64').toString());
    expect(packet.counter).toBe(1);
  }
);
