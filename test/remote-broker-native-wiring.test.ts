/** Native manager branches with every process effect injected; only temporary metadata is real. */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { CreateSessionOptions, MuxSession } from '../src/mux-interface.js';
import type { CodexBrokerState } from '../src/recovery/codex-input-broker.js';
import type { TmuxManager as Manager } from '../src/tmux-manager.js';
import type { Session as SessionType } from '../src/session.js';
const effects = vi.hoisted(() => ({ sync: vi.fn(), exec: vi.fn(), provision: vi.fn(), observe: vi.fn() }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const refused = () => {
    throw new Error('All real process effects forbidden');
  };
  Object.defineProperty(refused, Symbol.for('nodejs.util.promisify.custom'), { value: effects.exec });
  return {
    ...actual,
    exec: refused,
    execSync: effects.sync,
    execFile: refused,
    execFileSync: refused,
    spawn: refused,
    spawnSync: refused,
    fork: refused,
  };
});
vi.mock('../src/recovery/remote-input-broker.js', async (original) => ({
  ...(await original<typeof import('../src/recovery/remote-input-broker.js')>()),
  provisionRemoteInputBroker: effects.provision,
}));
vi.mock('../src/recovery/remote-broker-launch.js', () => ({ observeOwnedRemoteBroker: effects.observe }));
vi.mock('node-pty', () => ({
  spawn: () => {
    throw new Error('Real PTY effects forbidden');
  },
}));
let TmuxManager: typeof Manager;
let Session: typeof SessionType;
let root: string, oldData: string | undefined;
const managers: Manager[] = [];
const sessions: SessionType[] = [];
const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
beforeAll(async () => {
  root = await fs.mkdtemp(join(homedir(), 'remote-native-wiring-'));
  oldData = process.env.CODEMAN_DATA_DIR;
  process.env.CODEMAN_DATA_DIR = root;
  const vitest = process.env.VITEST;
  delete process.env.VITEST;
  try {
    ({ TmuxManager } = await import('../src/tmux-manager.js'));
    ({ Session } = await import('../src/session.js'));
  } finally {
    if (vitest !== undefined) process.env.VITEST = vitest;
  }
});
afterAll(async () => {
  if (oldData === undefined) delete process.env.CODEMAN_DATA_DIR;
  else process.env.CODEMAN_DATA_DIR = oldData;
  await fs.rm(root, { recursive: true, force: true });
});
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.stop(false);
  for (const manager of managers.splice(0)) await Reflect.get(manager, 'sessionSaves');
  vi.restoreAllMocks();
});
beforeEach(async () => {
  effects.sync.mockReset().mockReturnValue('99999\n');
  effects.exec.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
  effects.provision.mockReset().mockImplementation(async (_remote, material, authority) => {
    expect(authority.isCurrent()).toBe(true);
    expect(await authority.prepare()).toBe(true);
    return {
      status: 'provisioned',
      directory: `/fixture/private/${material.sessionId}/${material.incarnation}`,
      incarnation: material.incarnation,
      pane: { sessionId: '$17', paneId: '%9', panePid: 9009, serverPid: 17000 },
    };
  });
  effects.observe.mockReset().mockImplementation(async (_remote, request, authority) => {
    expect(authority.isCurrent()).toBe(true);
    expect(await authority.prepare()).toBe(true);
    const records = JSON.parse(await fs.readFile(join(root, 'mux-sessions.json'), 'utf8')) as MuxSession[];
    const record = records.find((entry) => entry.sessionId === request.sessionId)!;
    expect(record.recoveryInputBrokerPending).toBe(request.descriptor.incarnation);
    expect(record.recoveryInputBroker).toBeUndefined();
    expect(record.pid).toBe(0);
    const state: CodexBrokerState = {
      version: 1,
      sessionId: request.sessionId,
      incarnation: request.descriptor.incarnation,
      pid: 42,
      childPid: 43,
      brokerStart: '1',
      childStart: '2',
      launchDigest: request.descriptor.launchDigest,
      homeDigest: request.descriptor.homeDigest,
      rawGeneration: 0,
      tainted: false,
      closed: false,
      exitStatus: null,
      exitSignal: null,
      counters: { 'owner-pty': 0, 'owner-key': 0, 'owner-mux': 0, auto: 0, probe: 0 },
      receipts: [],
      startup: { nonce: request.descriptor.startupNonce, status: 'started' },
    };
    const serialized = JSON.stringify(state);
    return {
      status: 'observed',
      serialized,
      panePid: 42,
      witness: {
        path: request.descriptor.directory + '/state.json',
        dev: 1,
        ino: 2,
        size: Buffer.byteLength(serialized),
        mtimeMs: 1,
        ctimeMs: 1,
        hash: hash(serialized),
        maxBytes: 98_304,
      },
    };
  });
});
function fixture() {
  const id = randomUUID();
  const manager = Object.create(TmuxManager.prototype) as Manager;
  for (const key of [
    'sessions',
    'inputBrokers',
    'inputBrokerLoads',
    'inputQueues',
    'paneExits',
    'reconnectState',
    'reconnectGuard',
    'remoteAliveCache',
    'remoteAliveInFlight',
  ])
    Reflect.set(manager, key, new Map());
  Reflect.set(manager, 'sessionSaves', Promise.resolve());
  Reflect.set(manager, 'tmuxSocket', 'fixture-socket');
  Reflect.set(manager, 'paneExitGeneration', 0);
  managers.push(manager);
  vi.spyOn(manager, 'isAvailable').mockReturnValue(true);
  vi.spyOn(manager, 'resizeWindow').mockImplementation(() => {});
  vi.spyOn(manager as unknown as { buildPathExport(): unknown }, 'buildPathExport').mockReturnValue({
    pathExport: '',
    dir: '/fixture/bin',
  });
  vi.spyOn(manager as unknown as { supportsLiveHistoryResize(): boolean }, 'supportsLiveHistoryResize').mockReturnValue(
    true
  );
  for (const key of ['_configureCliEnv', '_configureStatusLineUserCommand', 'applyEnvOverrides', 'pinCodexLaunchHome'])
    vi.spyOn(manager as unknown as Record<string, () => void>, key).mockImplementation(() => {});
  const options: CreateSessionOptions = {
    sessionId: id,
    mode: 'codex',
    workingDir: root,
    codexConfig: { noDaemon: true },
    envOverrides: { CODEX_HOME: '/fixture/codex-home' },
    owner: 'fixture-owner',
    remote: {
      hostId: 'fixture',
      label: 'Fixture',
      host: 'worker.invalid',
      username: 'runner',
      port: 22,
      remotePath: '/fixture/actual-remote-cwd',
      owned: true,
    },
    remoteLaunchCurrent: () => true,
    remoteLaunchPrepare: async () => true,
  };
  return { manager, options };
}
it('persists the exact pending incarnation before remote fork and commits before local SSH attachment', async () => {
  const { manager, options } = fixture();
  const session = await manager.createSession(options);
  expect(session.recoveryInputBroker).toMatch(/^[a-f0-9-]{36}$/);
  expect(session.recoveryInputBrokerPending).toBeUndefined();
  expect(session.recoveryCodexHome).toBe('/fixture/codex-home');
  expect(session.recoveryIsolated).toBe(true);
  expect(session.pid).toBe(99999);
  expect(effects.observe).toHaveBeenCalledTimes(1);
  expect(effects.observe.mock.calls[0][1]).toMatchObject({ codexHome: '/fixture/codex-home' });
  const native = effects.sync.mock.calls.map(([command]) => String(command));
  expect(native.filter((command) => command.includes('respawn-pane'))[0]).toContain('attach');
  expect(manager.wrapCodexOwnerInput(options.sessionId, '😀\ntext').status).toBe('framed');
  expect(manager.canDeliverCodexOwnerInput(options.sessionId)).toBe(true);
  const descriptor = await manager.getOwnedRemoteInputBroker(options.sessionId);
  expect(descriptor?.incarnation).toBe(session.recoveryInputBroker);
});
it.each(['unknown', 'not-sent'] as const)(
  'keeps %s launch sealed without native/local or fresh-worker fallback',
  async (status) => {
    const { manager, options } = fixture();
    effects.observe.mockResolvedValue({ status });
    await expect(manager.createSession(options)).rejects.toThrow('needs owner inspection');
    expect(effects.observe).toHaveBeenCalledTimes(1);
    expect(effects.sync).not.toHaveBeenCalled();
    const record = manager.getSession(options.sessionId)!;
    expect(record.recoveryInputBrokerPending).toMatch(/^[a-f0-9-]{36}$/);
    expect(manager.wrapCodexOwnerInput(options.sessionId, 'owner intent')).toEqual({ status: 'refused' });
    expect(manager.canDeliverCodexOwnerInput(options.sessionId)).toBe(false);
  }
);
it('refuses remote fork when the exact pending registration cannot be acknowledged durably', async () => {
  const { manager, options } = fixture();
  vi.spyOn(manager, 'flushSessionsDurably').mockRejectedValue(new Error('Durability lost'));
  await expect(manager.createSession(options)).rejects.toThrow('reservation needs owner inspection');
  expect(effects.observe).not.toHaveBeenCalled();
  expect(effects.sync).not.toHaveBeenCalled();
  expect(manager.getSession(options.sessionId)?.recoveryInputBrokerPending).toBeDefined();
});
it('retains pending uncertainty if startup was acknowledged but durable promotion failed', async () => {
  const { manager, options } = fixture();
  const actual = manager.flushSessionsDurably.bind(manager);
  let flushes = 0;
  vi.spyOn(manager, 'flushSessionsDurably').mockImplementation(async (current) => {
    if (++flushes === 2) throw new Error('Promotion ACK lost');
    await actual(current);
  });
  await expect(manager.createSession(options)).rejects.toThrow('commit needs owner inspection');
  expect(effects.observe).toHaveBeenCalledTimes(1);
  expect(effects.sync).not.toHaveBeenCalled();
  const record = manager.getSession(options.sessionId)!;
  expect(record.recoveryInputBroker).toBeUndefined();
  expect(record.recoveryInputBrokerPending).toBeDefined();
});
it('attaches an existing remote session without adopting an input signer or sending a fresh launch', async () => {
  const { manager, options } = fixture();
  effects.provision.mockResolvedValue({ status: 'existing' });
  const session = await manager.createSession(options);
  expect(session.recoveryInputBroker).toBeUndefined();
  expect(effects.observe).not.toHaveBeenCalled();
  expect(
    effects.sync.mock.calls.map(([command]) => String(command)).find((command) => command.includes('respawn-pane'))
  ).toContain('attach');
});
it.each([
  () => false,
  () => undefined,
  () => Promise.resolve(true),
  () => Promise.reject(new Error('Bad async owner fence')),
])('refuses malformed or withdrawn owner launch authority (%s)', async (verdict) => {
  const { manager, options } = fixture();
  options.remoteLaunchCurrent = verdict as () => boolean;
  effects.provision.mockImplementation(async (_remote, _material, authority) => {
    expect(authority.isCurrent()).toBe(false);
    return { status: 'not-sent' };
  });
  await expect(manager.createSession(options)).rejects.toThrow('authority changed');
  expect(effects.observe).not.toHaveBeenCalled();
  expect(effects.sync).not.toHaveBeenCalled();
});
it('never probes or frames a remote PID using local broker evidence', async () => {
  const { manager, options } = fixture();
  const session = await manager.createSession(options);
  expect(await manager.inspectCodexInputProvenance(options.sessionId, session.pid)).toBeUndefined();
  const framed = manager.wrapCodexOwnerInput(options.sessionId, '\t', 'owner-key');
  expect(framed.status).toBe('framed');
  expect(framed.data).not.toContain('undefined');
  expect(session.sessionId).not.toBe(SID);
});

it('the actual Session retains an uncertain remote launch before generic fallback cleanup', async () => {
  const { manager, options } = fixture();
  effects.observe.mockResolvedValue({ status: 'unknown' });
  const session = new Session({
    id: options.sessionId,
    workingDir: root,
    owner: options.owner,
    mode: 'codex',
    useMux: true,
    mux: manager,
    codexConfig: options.codexConfig,
    envOverrides: options.envOverrides,
    remote: options.remote,
  });
  sessions.push(session);
  await expect(session.startInteractive()).rejects.toThrow('receipt needs owner inspection');
  expect(session.codexRestoreWorkerMayExist).toBe(true);
  expect(session.getRecoveryContext()).toMatchObject({ managed: false, inputBrokerPending: true });
  expect(Reflect.get(session, '_muxSession')).toBe(manager.getSession(options.sessionId));
  expect(Reflect.get(session, '_useMux')).toBe(true);
  expect(manager.getSession(options.sessionId)?.codexRestoreUncertain).toBe(true);
  expect(effects.sync).not.toHaveBeenCalled();
});

it('a reconstructed pending remote registration retains its launch veto before attachment', async () => {
  const { manager, options } = fixture();
  effects.observe.mockResolvedValue({ status: 'unknown' });
  await expect(manager.createSession(options)).rejects.toThrow();
  const record = manager.getSession(options.sessionId)!;
  expect(record.codexRestoreUncertain).not.toBe(true);
  const session = new Session({
    id: options.sessionId,
    workingDir: root,
    owner: options.owner,
    mode: 'codex',
    useMux: true,
    mux: manager,
    muxSession: record,
    codexConfig: options.codexConfig,
    envOverrides: options.envOverrides,
    remote: options.remote,
  });
  sessions.push(session);
  expect(session.codexRestoreWorkerMayExist).toBe(true);
  expect(session.getRecoveryContext()).toMatchObject({ managed: false, inputBrokerPending: true });
});
