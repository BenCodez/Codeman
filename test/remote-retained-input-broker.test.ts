/** Existing remote workers keep exact broker provenance when their local wrapper is recreated. */
import { createHash } from 'node:crypto';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { CodexInputBroker } from '../src/recovery/codex-input-broker.js';
import { ownedRemoteBrokerCache } from '../src/recovery/remote-input-broker-cache.js';
import { provisionRemoteInputBroker } from '../src/recovery/remote-input-broker.js';
import { observeOwnedRemoteBroker } from '../src/recovery/remote-broker-launch.js';
import type { CreateSessionOptions, MuxSession } from '../src/mux-interface.js';
import type { TmuxManager as Manager } from '../src/tmux-manager.js';

const effects = vi.hoisted(() => ({
  exec: vi.fn(),
  sync: vi.fn(),
  forbidden: vi.fn(() => {
    throw new Error('Forbidden real process');
  }),
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const exec = Object.assign(effects.forbidden, { [Symbol.for('nodejs.util.promisify.custom')]: effects.exec });
  return {
    ...actual,
    exec,
    execSync: effects.sync,
    execFile: effects.forbidden,
    execFileSync: effects.forbidden,
    spawn: effects.forbidden,
    spawnSync: effects.forbidden,
    fork: effects.forbidden,
  };
});
vi.mock('../src/recovery/remote-input-broker.js', () => ({ provisionRemoteInputBroker: vi.fn() }));
vi.mock('../src/recovery/remote-broker-launch.js', () => ({ observeOwnedRemoteBroker: vi.fn() }));
let TmuxManager: typeof import('../src/tmux-manager.js').TmuxManager;
let paneCommand: typeof import('../src/tmux-manager.js').buildRemoteCodexPaneCommand;
beforeAll(async () => {
  const vitest = process.env.VITEST;
  delete process.env.VITEST;
  try {
    const module = await import('../src/tmux-manager.js');
    TmuxManager = module.TmuxManager;
    paneCommand = module.buildRemoteCodexPaneCommand;
  } finally {
    if (vitest !== undefined) process.env.VITEST = vitest;
  }
});
afterEach(() => {
  expect(effects.forbidden).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  effects.forbidden.mockClear();
});
const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const home = '/fixture/remote-home';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture() {
  effects.exec.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
  effects.sync.mockReset().mockReturnValue('700\n');
  vi.mocked(provisionRemoteInputBroker).mockReset().mockResolvedValue({ status: 'existing' });
  vi.mocked(observeOwnedRemoteBroker).mockReset();
  const options: CreateSessionOptions = {
    sessionId: ID,
    workingDir: '/fixture/local',
    mode: 'codex',
    owner: 'alice',
    remote: { host: 'worker.invalid', remotePath: '/fixture/work', owned: true },
    codexConfig: { noDaemon: true, resumeSessionId: '11111111-2222-4333-8444-555555555555' },
    envOverrides: { CODEX_HOME: home },
  };
  const material = CodexInputBroker.provisioningMaterial(
    ID,
    paneCommand({
      sessionId: ID,
      remotePath: options.remote!.remotePath,
      codexConfig: options.codexConfig,
      codexHome: home,
    }),
    home
  );
  const directory = '/fixture/private/' + ID + '/' + material.config.incarnation;
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
  const serialized = JSON.stringify(state);
  const witness = {
    path: directory + '/state.json',
    dev: 1,
    ino: 2,
    size: Buffer.byteLength(serialized),
    mtimeMs: 1,
    ctimeMs: 1,
    hash: hash(serialized),
    maxBytes: 98304,
  };
  const broker = CodexInputBroker.fromRemoteMaterial(directory, material, state)!;
  expect(broker.observeRemote(serialized, witness, 900)).toBeDefined();
  const descriptor = {
    directory,
    incarnation: material.config.incarnation,
    launchDigest: material.config.launchDigest,
    homeDigest: material.config.homeDigest,
    keyDigest: hash(material.config.secret),
    helperDigest: hash(material.helper),
    startupNonce: material.config.startup.nonce,
  };
  // Deserialize the complete retained record, as loadSessions does, rather than retaining a live signer object.
  const record: MuxSession = JSON.parse(
    JSON.stringify({
      sessionId: ID,
      muxName: 'codeman-aaaaaaaa',
      pid: 123,
      createdAt: 1,
      workingDir: options.workingDir,
      mode: options.mode,
      owner: options.owner,
      remote: options.remote,
      attached: false,
      name: 'Existing worker history',
      recoveryCodexHome: home,
      recoveryIsolated: true,
      recoveryInputBroker: broker.incarnation,
      codexRestoreConfig: options.codexConfig,
    })
  );
  const manager = Object.create(TmuxManager.prototype) as Manager;
  Object.assign(manager, {
    sessions: new Map([[ID, record]]),
    inputBrokers: new Map(),
    inputBrokerLoads: new Map(),
    inputQueues: new Map(),
    tmuxSocket: 'fixture',
    trueColorConfigured: true,
  });
  for (const method of [
    'saveSessions',
    '_configureCliEnv',
    '_configureStatusLineUserCommand',
    'applyEnvOverrides',
    'pinCodexLaunchHome',
    'resizeWindow',
  ])
    vi.spyOn(manager as unknown as Record<string, () => void>, method).mockImplementation(() => {});
  vi.spyOn(manager, 'isAvailable').mockReturnValue(true);
  vi.spyOn(manager as unknown as { buildPathExport(): object }, 'buildPathExport').mockReturnValue({
    pathExport: '',
    dir: '/fixture/bin',
  });
  vi.spyOn(manager as unknown as { supportsLiveHistoryResize(): boolean }, 'supportsLiveHistoryResize').mockReturnValue(
    true
  );
  const scope = JSON.stringify({
    sessionId: ID,
    remote: record.remote,
    workingDir: record.remote!.remotePath,
    codexHome: home,
    owner: record.owner,
  });
  const matches = (value: unknown, inc: string) => JSON.stringify(value) === scope && inc === broker.incarnation;
  const load = vi
    .spyOn(ownedRemoteBrokerCache, 'load')
    .mockImplementation(async (value, inc) => (matches(value, inc) ? descriptor : undefined));
  vi.spyOn(ownedRemoteBrokerCache, 'get').mockImplementation((value, inc) =>
    matches(value, inc) ? descriptor : undefined
  );
  vi.spyOn(ownedRemoteBrokerCache, 'signer').mockImplementation((value, inc) =>
    matches(value, inc) ? broker : undefined
  );
  vi.spyOn(ownedRemoteBrokerCache, 'observe').mockImplementation((value, inc, text, proof, pid) =>
    matches(value, inc) ? broker.observeRemote(text, proof, pid) : undefined
  );
  vi.mocked(observeOwnedRemoteBroker).mockImplementation(async (_remote, request, authority) => {
    expect(request.descriptor).toEqual(descriptor);
    expect(request.inspect).toBe(true);
    expect(await authority.prepare()).toBe(true);
    expect(authority.isCurrent()).toBe(true);
    return { status: 'observed', serialized, witness, panePid: 900 };
  });
  return { manager, options, record, broker, descriptor, load, state, witness };
}

it('recreates only the local attach wrapper while retaining the verified original remote broker', async () => {
  const f = fixture();
  const next = await f.manager.createSession(f.options);
  expect(next.recoveryInputBroker).toBe(f.broker.incarnation);
  expect(f.load).toHaveBeenCalledOnce();
  expect(observeOwnedRemoteBroker).toHaveBeenCalledOnce();
  expect(next.recoveryInputBrokerPending).toBeUndefined();
  expect(next.recoveryCodexHome).toBe(home);
  expect(f.manager.wrapCodexOwnerInput(ID, 'owner text')).toMatchObject({ status: 'framed' });
  const launch = effects.sync.mock.calls.find(([command]) => command.includes('respawn-pane'))?.[0];
  expect(launch).toContain(' attach -t ');
  expect(launch).not.toContain('exec codex');
  expect(provisionRemoteInputBroker).toHaveBeenCalledOnce();
  expect(vi.mocked(provisionRemoteInputBroker).mock.calls[0][3]).toEqual({ planOnly: true });
});

it.each([
  'missing-cache',
  'bad-launch',
  'bad-home',
  'owner-changed',
  'record-replaced',
  'pending',
  'scope',
  'config',
  'unsupported',
  'closed',
  'tainted',
  'malformed',
  'grant-revoked',
] as const)('refuses retained controlled input authority without overwriting history: %s', async (change) => {
  const f = fixture();
  if (change === 'closed' || change === 'tainted' || change === 'malformed') {
    const serialized = change === 'malformed' ? '{invalid' : JSON.stringify({ ...f.state, [change]: true });
    vi.mocked(observeOwnedRemoteBroker).mockResolvedValue({
      status: 'observed',
      serialized,
      witness: { ...f.witness, size: Buffer.byteLength(serialized), hash: hash(serialized) },
      panePid: 900,
    });
  }
  if (change === 'grant-revoked') {
    let current = true;
    f.options.remoteLaunchCurrent = () => current;
    const observe = vi.mocked(observeOwnedRemoteBroker).getMockImplementation()!;
    vi.mocked(observeOwnedRemoteBroker).mockImplementation(async (...args) => {
      const observed = await observe(...args);
      current = false;
      return observed;
    });
  }
  if (change === 'missing-cache') f.load.mockResolvedValue(undefined);
  if (change === 'bad-launch') f.descriptor.launchDigest = '0'.repeat(64);
  if (change === 'bad-home') f.descriptor.homeDigest = '0'.repeat(64);
  if (change === 'owner-changed')
    f.load.mockImplementation(async () => {
      f.options.owner = 'bob';
      return f.descriptor;
    });
  if (change === 'record-replaced')
    f.load.mockImplementation(async () => {
      Reflect.get(f.manager, 'sessions').set(ID, { ...f.record });
      return f.descriptor;
    });
  if (change === 'pending') f.record.recoveryInputBrokerPending = f.broker.incarnation;
  if (change === 'scope') f.options.remote = { ...f.options.remote!, host: 'replacement.invalid' };
  if (change === 'config') f.options.codexConfig = { ...f.options.codexConfig, noDaemon: false };
  if (change === 'unsupported') vi.mocked(provisionRemoteInputBroker).mockResolvedValue({ status: 'unsupported' });
  await expect(f.manager.createSession(f.options)).rejects.toThrow();
  expect(f.manager.getSession(ID)).toMatchObject({
    name: 'Existing worker history',
    recoveryInputBroker: f.broker.incarnation,
    recoveryCodexHome: home,
  });
  expect(effects.sync).not.toHaveBeenCalled();
  expect(effects.exec).not.toHaveBeenCalled();
});

it('keeps ordinary unowned remote attach compatibility without inventing broker metadata', async () => {
  const f = fixture();
  f.options.remote!.owned = false;
  delete f.record.recoveryInputBroker;
  delete f.record.codexRestoreConfig;
  const next = await f.manager.createSession(f.options);
  expect(next.recoveryInputBroker).toBeUndefined();
  expect(f.load).not.toHaveBeenCalled();
  expect(observeOwnedRemoteBroker).not.toHaveBeenCalled();
});
