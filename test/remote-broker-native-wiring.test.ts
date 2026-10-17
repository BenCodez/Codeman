/** Native manager branches with every process effect injected; only temporary metadata is real. */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createDeferred } from './mocks/index.js';
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
let ownedRemoteBrokerCache: typeof import('../src/recovery/remote-input-broker-cache.js').ownedRemoteBrokerCache;
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
    ({ ownedRemoteBrokerCache } = await import('../src/recovery/remote-input-broker-cache.js'));
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
  syncBuiltinESMExports();
  vi.unstubAllEnvs();
});
beforeEach(async () => {
  effects.sync.mockReset().mockImplementation((command: string) => {
    if (command.includes(' new-session ') && command.includes(' -P ')) return '$1|%7|10001|88\n';
    if (command.includes('CODEMAN_OPTIONAL_BROKER_DISPATCHED'))
      return 'CODEMAN_OPTIONAL_BROKER_DISPATCHED|$1|%7|99999|88\n';
    return '99999\n';
  });
  effects.exec.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
  effects.provision.mockReset().mockImplementation(async (_remote, material, authority, options) => {
    expect(authority.isCurrent()).toBe(true);
    expect(await authority.prepare()).toBe(true);
    if (options?.planOnly === true)
      return {
        status: 'planned',
        directory: `/fixture/private/${material.sessionId}/${material.incarnation}`,
        incarnation: material.incarnation,
      };
    if (options?.root) {
      const records = JSON.parse(await fs.readFile(join(root, 'mux-sessions.json'), 'utf8')) as MuxSession[];
      expect(records.find((entry) => entry.sessionId === material.sessionId)?.recoveryInputBrokerPending).toBe(
        material.incarnation
      );
      expect(options).toEqual({
        root: '/fixture/private',
        ownerInitialLaunch: !options.expectedPane,
        ...(options.expectedPane ? { expectedPane: options.expectedPane } : {}),
      });
    }
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
    expect(record.pid).toBe(record.remoteShellConversion ? 7007 : 0);
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

it.each(['owner', 'config', 'remote'] as const)(
  'rolls back repeated initial preparations cancelled by %s before reservation',
  async (change) => {
    const { manager, options } = fixture();
    let ownerCurrent = true;
    options.remoteLaunchCurrent = () => ownerCurrent;
    const originalConfig = options.codexConfig;
    const originalHost = options.remote!.host;
    const prepare = ownedRemoteBrokerCache.prepare.bind(ownedRemoteBrokerCache);
    const reserve = vi.spyOn(manager, 'reserveOwnedRemoteInputBroker');
    for (let attempt = 0; attempt < 2; attempt++) {
      let entered!: () => void, release!: () => void;
      const reached = new Promise<void>((resolve) => (entered = resolve));
      const held = new Promise<void>((resolve) => (release = resolve));
      let prepared: Awaited<ReturnType<typeof prepare>>;
      let preparedScope: Parameters<typeof prepare>[0] | undefined;
      const spy = vi.spyOn(ownedRemoteBrokerCache, 'prepare').mockImplementationOnce(async (...args) => {
        prepared = await prepare(...args);
        preparedScope = args[0];
        entered();
        await held;
        return prepared;
      });
      const creating = manager.createSession(options);
      try {
        await reached;
        expect(prepared).toBeDefined();
        const file = join(root, 'remote-input-brokers', options.sessionId, prepared!.incarnation, 'private.json');
        expect((await fs.stat(file)).isFile()).toBe(true);
        if (change === 'owner') ownerCurrent = false;
        else if (change === 'remote') options.remote!.host = 'changed-during-prepare.invalid';
        else options.codexConfig = { ...originalConfig, model: 'changed-during-prepare' };
        release();
        await expect(creating).rejects.toThrow('material unavailable');
        await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(ownedRemoteBrokerCache.get(preparedScope!, prepared!.incarnation)).toBeUndefined();
        expect(reserve).not.toHaveBeenCalled();
        expect(effects.provision.mock.calls.every((call) => call[3]?.planOnly === true)).toBe(true);
        expect(effects.observe).not.toHaveBeenCalled();
        expect(effects.sync).not.toHaveBeenCalled();
        expect(manager.getSession(options.sessionId)).toBeUndefined();
      } finally {
        release();
        await creating.catch(() => {});
        spy.mockRestore();
        ownerCurrent = true;
        options.codexConfig = originalConfig;
        options.remote!.host = originalHost;
      }
    }
    // The same logical session still has its full two-incarnation capacity.
    const healthy = await manager.createSession(options);
    expect(reserve).toHaveBeenCalledOnce();
    expect(healthy.recoveryInputBroker).toBeDefined();
    expect(healthy.recoveryInputBrokerPending).toBeUndefined();
    expect(effects.observe).toHaveBeenCalledOnce();
  }
);

it('preserves a same-byte replacement when initial preparation authority is cancelled', async () => {
  const { manager, options } = fixture();
  let current = true,
    entered!: () => void,
    release!: () => void;
  options.remoteLaunchCurrent = () => current;
  const reached = new Promise<void>((resolve) => (entered = resolve));
  const held = new Promise<void>((resolve) => (release = resolve));
  const prepare = ownedRemoteBrokerCache.prepare.bind(ownedRemoteBrokerCache);
  let prepared: Awaited<ReturnType<typeof prepare>>;
  const spy = vi.spyOn(ownedRemoteBrokerCache, 'prepare').mockImplementationOnce(async (...args) => {
    prepared = await prepare(...args);
    entered();
    await held;
    return prepared;
  });
  const reserve = vi.spyOn(manager, 'reserveOwnedRemoteInputBroker');
  const discard = vi.spyOn(ownedRemoteBrokerCache, 'discardUnreservedPreparation');
  const creating = manager.createSession(options);
  try {
    await reached;
    expect(prepared).toBeDefined();
    const file = join(root, 'remote-input-brokers', options.sessionId, prepared!.incarnation, 'private.json');
    const bytes = await fs.readFile(file);
    await fs.rename(file, file + '.original');
    await fs.writeFile(file, bytes, { mode: 0o600 });
    const replacement = await fs.lstat(file);
    current = false;
    release();
    await expect(creating).rejects.toThrow('material unavailable');
    expect(discard).toHaveBeenCalledOnce();
    expect(await discard.mock.results[0].value).toBe(false);
    expect((await fs.lstat(file)).ino).toBe(replacement.ino);
    expect(await fs.readFile(file)).toEqual(bytes);
    expect(reserve).not.toHaveBeenCalled();
    expect(effects.provision).toHaveBeenCalledOnce();
    expect(effects.observe).not.toHaveBeenCalled();
    expect(effects.sync).not.toHaveBeenCalled();
  } finally {
    release();
    await creating.catch(() => {});
    spy.mockRestore();
  }
});

it.each(['reservation-false', 'reservation-throw', 'provision-unknown', 'observe-unknown'] as const)(
  'retains exact initial material once reservation may have started: %s',
  async (failure) => {
    const { manager, options } = fixture();
    const prepare = ownedRemoteBrokerCache.prepare.bind(ownedRemoteBrokerCache);
    let prepared: Awaited<ReturnType<typeof prepare>>;
    let scope: Parameters<typeof prepare>[0] | undefined;
    vi.spyOn(ownedRemoteBrokerCache, 'prepare').mockImplementationOnce(async (...args) => {
      prepared = await prepare(...args);
      scope = args[0];
      return prepared;
    });
    const reserve = manager.reserveOwnedRemoteInputBroker.bind(manager);
    if (failure.startsWith('reservation'))
      vi.spyOn(manager, 'reserveOwnedRemoteInputBroker').mockImplementationOnce(async (...args) => {
        expect(await reserve(...args)).toBe(true);
        if (failure === 'reservation-throw') throw Error('Reservation reply lost');
        return false;
      });
    if (failure === 'provision-unknown') {
      const provision = effects.provision.getMockImplementation()!;
      effects.provision.mockImplementation(async (...args) =>
        args[3]?.planOnly ? provision(...args) : { status: 'unknown' }
      );
    }
    if (failure === 'observe-unknown') effects.observe.mockResolvedValue({ status: 'unknown' });
    const discard = vi.spyOn(ownedRemoteBrokerCache, 'discardUnreservedPreparation');
    await expect(manager.createSession(options)).rejects.toThrow();
    expect(prepared).toBeDefined();
    expect(discard).not.toHaveBeenCalled();
    expect(manager.getSession(options.sessionId)?.recoveryInputBrokerPending).toBe(prepared!.incarnation);
    const file = join(root, 'remote-input-brokers', options.sessionId, prepared!.incarnation, 'private.json');
    const bytes = await fs.readFile(file);
    expect(bytes.length).toBeGreaterThan(0);
    expect(await ownedRemoteBrokerCache.discardUnreservedPreparation(scope!, prepared!)).toBe(false);
    expect(await fs.readFile(file)).toEqual(bytes);
    expect(effects.sync).not.toHaveBeenCalled();
  }
);

it('persists the exact pending incarnation before remote fork and commits before local SSH attachment', async () => {
  const { manager, options } = fixture();
  const session = await manager.createSession(options);
  expect(session.recoveryInputBroker).toMatch(/^[a-f0-9-]{36}$/);
  expect(session.recoveryInputBrokerPending).toBeUndefined();
  expect(session.recoveryCodexHome).toBe('/fixture/codex-home');
  expect(session.recoveryIsolated).toBe(true);
  expect(session.pid).toBe(99999);
  expect(effects.observe).toHaveBeenCalledTimes(1);
  expect(effects.provision.mock.calls.map((call) => call[3])).toEqual([
    { planOnly: true },
    { root: '/fixture/private', ownerInitialLaunch: true },
  ]);
  expect(effects.observe.mock.calls[0][1]).toMatchObject({ codexHome: '/fixture/codex-home' });
  const native = effects.sync.mock.calls.map(([command]) => String(command));
  expect(native.filter((command) => command.includes('respawn-pane'))[0]).toContain('attach');
  expect(manager.wrapCodexOwnerInput(options.sessionId, '😀\ntext').status).toBe('framed');
  expect(manager.canDeliverCodexOwnerInput(options.sessionId)).toBe(true);
  const descriptor = await manager.getOwnedRemoteInputBroker(options.sessionId);
  expect(descriptor?.incarnation).toBe(session.recoveryInputBroker);
  const controlled = new Session({
    id: options.sessionId,
    workingDir: root,
    mode: 'codex',
    useMux: true,
    mux: manager,
    muxSession: session,
    codexConfig: options.codexConfig,
    envOverrides: options.envOverrides,
    remote: options.remote,
    owner: options.owner,
  });
  sessions.push(controlled);
  expect(controlled.getRecoveryContext().noDaemon).toBe(true);
  expect(controlled.taskSupervisionSupported).toBe(true);
  expect(controlled.toLightDetailedState().taskSupported).toBe(true);
});
it.each([
  'env-failed',
  'owner-revoked',
  'cleanup-refused',
  'create-lost-ack',
  'dispatch-lost-ack',
  'dispatch-malformed',
  'postdispatch-revoked',
  'map-replaced',
] as const)('owns only the exact local SSH attach wrapper after %s', async (kind) => {
  const { manager, options } = fixture();
  let current = true,
    localCreates = 0,
    attachDispatches = 0,
    localKills = 0,
    configured = false;
  options.remoteLaunchCurrent = () => current;
  const native = effects.sync.getMockImplementation()!;
  effects.sync.mockImplementation((command: string) => {
    if (command.includes(' new-session ')) {
      localCreates++;
      if (kind === 'create-lost-ack') throw Error('Fixture new local wrapper ACK lost');
    }
    if (command.includes('respawn-pane ')) {
      attachDispatches++;
      if (kind === 'dispatch-lost-ack') throw Error('Fixture local attach ACK lost');
      if (kind === 'dispatch-malformed') return 'unexpected attach receipt';
      if (kind === 'postdispatch-revoked') current = false;
      if (kind === 'map-replaced') {
        const record = manager.getSession(options.sessionId)!;
        Reflect.get(manager, 'sessions').set(options.sessionId, { ...record, owner: 'replacement-owner', pid: 77777 });
      }
    }
    if (command.includes('kill-pane ')) {
      if (kind === 'cleanup-refused') return 'CODEMAN_REBOOT_CLEANUP_REFUSED\n';
      localKills++;
      return '';
    }
    return native(command);
  });
  const configure = vi.mocked(Reflect.get(manager, '_configureCliEnv') as () => void);
  configure.mockImplementation(() => {
    configured = true;
    if (kind === 'env-failed' || kind === 'cleanup-refused') throw Error('Fixture local env setup failed');
    if (kind === 'owner-revoked') current = false;
  });
  await expect(manager.createSession(options)).rejects.toThrow();
  expect(localCreates).toBe(1);
  if (kind !== 'create-lost-ack') expect(configured).toBe(true);
  expect(effects.provision).toHaveBeenCalledTimes(2); // Plan + one remote worker, never a replacement.
  const record = manager.getSession(options.sessionId)!;
  expect(record.recoveryInputBroker).toMatch(/^[a-f0-9-]{36}$/);
  expect(record.recoveryInputBrokerPending).toBeUndefined();
  expect(effects.sync.mock.calls.some(([command]) => String(command).includes('kill-session '))).toBe(false);
  if (kind === 'env-failed' || kind === 'owner-revoked') {
    expect(localKills).toBe(1);
    expect(attachDispatches).toBe(0);
    expect(record.codexRestoreUncertain).not.toBe(true);
    // The remote worker/provenance survive exact local cleanup. Keep the
    // existing PID-0 inspection veto instead of authorizing a fresh worker.
    expect(record.pid).toBe(0);
    expect(await manager.getOwnedRemoteInputBroker(options.sessionId)).toMatchObject({
      incarnation: record.recoveryInputBroker,
    });
    expect(manager.wrapCodexOwnerInput(options.sessionId, 'no replay')).toEqual({ status: 'refused' });
    await expect(manager.createSession(options)).rejects.toThrow('uncertain');
    expect(localCreates).toBe(1);
    expect(effects.provision).toHaveBeenCalledTimes(2);
  } else if (kind === 'map-replaced') {
    expect(record.owner).toBe('replacement-owner');
    expect(record.pid).toBe(77777);
    expect(record.codexRestoreUncertain).not.toBe(true);
    expect(localKills).toBe(0);
  } else {
    expect(localKills).toBe(0);
    expect(record.codexRestoreUncertain).toBe(true);
    expect(record.pid).toBe(kind === 'cleanup-refused' ? 10001 : kind === 'postdispatch-revoked' ? 99999 : 0);
    const disk = JSON.parse(await fs.readFile(join(root, 'mux-sessions.json'), 'utf8')) as MuxSession[];
    expect(disk.find((value) => value.sessionId === options.sessionId)).toMatchObject({
      pid: record.pid,
      codexRestoreUncertain: true,
    });
    current = true;
    if (record.pid > 0) effects.provision.mockResolvedValueOnce({ status: 'existing' });
    await expect(manager.createSession(options)).rejects.toThrow();
    expect(localCreates).toBe(1);
    expect(effects.provision).toHaveBeenCalledTimes(record.pid > 0 ? 3 : 2);
    expect(effects.observe).toHaveBeenCalledOnce();
  }
  const commands = effects.sync.mock.calls.map(([command]) => String(command));
  const create = commands.find((command) => command.includes(' new-session '))!;
  expect(create).toContain(' -P -F ');
  expect(create).toContain('/bin/sleep 86400');
  for (const command of commands.filter((value) => value.includes('respawn-pane ') || value.includes('kill-pane '))) {
    for (const term of [
      '#{==:#{pid},88}',
      '#{==:#{session_id},$1}',
      '#{==:#{pane_id},%7}',
      '#{==:#{pane_pid},10001}',
      '#{==:#{window_panes},1}',
      '#{==:#{session_windows},1}',
    ])
      expect(command).toContain(term);
    if (command.includes('respawn-pane ')) {
      expect(command).toContain('attach');
      expect(command).toContain('CODEMAN_OPTIONAL_BROKER_DISPATCHED');
    }
  }
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
  expect(effects.provision).toHaveBeenCalledOnce();
  expect(effects.provision.mock.calls[0][3]).toEqual({ planOnly: true });
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

it.each(['return-undefined', 'throw'] as const)(
  'does not create a remote pane when source material persistence fails (%s)',
  async (failure) => {
    const { manager, options } = fixture();
    vi.spyOn(ownedRemoteBrokerCache, 'prepare').mockImplementation(async () => {
      if (failure === 'throw') throw new Error('Fixture cache failure');
      return undefined;
    });
    await expect(manager.createSession(options)).rejects.toThrow();
    expect(effects.provision).toHaveBeenCalledOnce();
    expect(effects.provision.mock.calls[0][3]).toEqual({ planOnly: true });
    expect(effects.observe).not.toHaveBeenCalled();
    expect(effects.sync).not.toHaveBeenCalled();
    expect(manager.getSession(options.sessionId)).toBeUndefined();
  }
);
it('retains the exact pending registration when ordinary remote provisioning loses its acknowledgement', async () => {
  const { manager, options } = fixture();
  const normal = effects.provision.getMockImplementation()!;
  effects.provision.mockImplementation(async (...args) =>
    args[3]?.planOnly === true ? normal(...args) : { status: 'unknown' }
  );
  await expect(manager.createSession(options)).rejects.toThrow('provisioning needs owner inspection');
  expect(manager.getSession(options.sessionId)?.recoveryInputBrokerPending).toBeDefined();
  expect(effects.observe).not.toHaveBeenCalled();
  expect(effects.sync).not.toHaveBeenCalled();
});

it.each(['missing-home', 'relative-home', 'unsupported-broker'] as const)(
  'the actual native %s owner fallback remains manual-only despite requested noDaemon',
  async (kind) => {
    const { manager, options } = fixture();
    if (kind === 'missing-home') options.envOverrides = undefined;
    if (kind === 'relative-home') options.envOverrides = { CODEX_HOME: 'relative-home' };
    if (kind === 'unsupported-broker') effects.provision.mockResolvedValue({ status: 'unsupported' });
    const record = await manager.createSession(options);
    expect(record.recoveryInputBroker).toBeUndefined();
    expect(record.recoveryIsolated).toBe(true);
    expect(effects.observe).not.toHaveBeenCalled();
    if (kind !== 'unsupported-broker') expect(effects.provision).not.toHaveBeenCalled();
    const session = new Session({
      id: options.sessionId,
      workingDir: root,
      mode: 'codex',
      useMux: true,
      mux: manager,
      muxSession: record,
      codexConfig: options.codexConfig,
      envOverrides: options.envOverrides,
      remote: options.remote,
      owner: options.owner,
    });
    sessions.push(session);
    expect(session.toLightDetailedState().codexConfig?.noDaemon).toBe(true);
    expect(session.getRecoveryContext().noDaemon).toBe(kind === 'unsupported-broker');
    expect(session.taskSupervisionSupported).toBe(false);
    expect(session.toLightDetailedState().taskSupported).toBe(false);
  }
);

it.each([
  'ack',
  'remote-lost',
  'remote-refused',
  'local-lost',
  'owner',
  'cancel',
  'aba',
  'malformed',
  'foreign',
  'held-owner',
] as const)('requires exact awaited native teardown acknowledgements for persisted owned SSH (%s)', async (kind) => {
  const { manager, options } = fixture();
  const native: MuxSession = {
    sessionId: options.sessionId,
    muxName: 'codeman-' + options.sessionId.slice(0, 8),
    pid: 600,
    createdAt: Date.now(),
    workingDir: root,
    owner: options.owner,
    remote: options.remote,
    mode: 'codex',
    attached: false,
  };
  if (kind === 'foreign') native.remote = { ...native.remote!, owned: false };
  Reflect.get(manager, 'sessions').set(native.sessionId, native);
  Reflect.set(manager, 'reconnectGuard', new Set());
  Reflect.set(manager, 'lastPaneCount', new Map());
  let current = true;
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
  effects.exec.mockImplementation(async (command: string) => {
    const ssh = command.startsWith('ssh ');
    if (command.includes('list-panes')) {
      if (ssh) {
        if (kind === 'owner') native.owner = 'replacement-owner';
        if (kind === 'cancel') current = false;
        return {
          stdout:
            kind === 'malformed'
              ? 'uncertain\n'
              : `codeman-ssh-${native.sessionId.slice(0, 8)}|$17|%9|9009|17000|1|1\n`,
          stderr: '',
        };
      }
      return { stdout: `${native.muxName}|$1|%7|600|88|1|1\n`, stderr: '' };
    }
    expect(command).toContain('if-shell -F');
    expect(command).toContain('kill-session -t');
    if (ssh) {
      expect(command).toContain('codeman-remote');
      expect(command).toContain('pane_pid},9009');
      expect(command).toContain('pid},17000');
      if (kind === 'held-owner') {
        entered();
        await held;
      }
      if (kind === 'remote-lost') throw Error('SSH acknowledgment lost');
      if (kind === 'remote-refused')
        return { stdout: 'CODEMAN_OWNED_KILL_REFUSED\nCODEMAN_OWNED_KILL_ACK\n', stderr: '' };
      if (kind === 'aba') Reflect.get(manager, 'sessions').set(native.sessionId, { ...native });
    } else if (kind === 'local-lost') throw Error('local acknowledgement lost');
    return { stdout: 'CODEMAN_OWNED_KILL_ACK\n', stderr: '' };
  });
  const pending = manager.killPersistedOwnedRemoteSession(native.sessionId, native, () => current);
  try {
    if (kind === 'held-owner') {
      await reached;
      expect(manager.getSession(native.sessionId)).toBe(native);
      expect(
        effects.exec.mock.calls.filter(([command]) => !command.startsWith('ssh ') && command.includes('if-shell -F'))
      ).toHaveLength(0);
      native.owner = 'replacement-owner';
    }
  } finally {
    release();
  }
  expect(await pending).toBe(kind === 'ack');
  expect(manager.getSession(native.sessionId) === undefined).toBe(kind === 'ack');
  const kills = effects.exec.mock.calls.filter(([command]) => command.includes('if-shell -F'));
  expect(kills.length).toBe(
    kind === 'ack' || kind === 'local-lost'
      ? 2
      : ['remote-lost', 'remote-refused', 'aba', 'held-owner'].includes(kind)
        ? 1
        : 0
  );
  expect(effects.sync).not.toHaveBeenCalled();
});

it.each([
  'local-present',
  'local-absent',
  'request-aborted',
  'restart',
  'owner-drift',
  'native-drift',
  'unknown-remote',
  'corrupt-receipt',
  'malformed-native',
  'unreadable-local',
  'missing-socket',
  'wrong-socket',
  'blocked-cleanup',
] as const)(
  'reuses only durable exact remote kill acknowledgement for explicit local completion (%s)',
  async (kind) => {
    const initial = fixture();
    const options = initial.options;
    let manager = initial.manager;
    if (kind === 'missing-socket' || kind === 'wrong-socket') vi.stubEnv('TMUX_TMPDIR', root);
    let native: MuxSession = {
      sessionId: options.sessionId,
      muxName: 'codeman-' + options.sessionId.slice(0, 8),
      pid: 600,
      createdAt: Date.now(),
      workingDir: root,
      owner: options.owner,
      remote: options.remote,
      mode: 'codex',
      attached: false,
    };
    Reflect.get(manager, 'sessions').set(native.sessionId, native);
    Reflect.set(manager, 'reconnectGuard', new Set());
    Reflect.set(manager, 'lastPaneCount', new Map());
    await manager.flushSessionsDurably();
    let current = true,
      phase = 1;
    const local = `${native.muxName}|$1|%7|600|88|1|1\n`;
    effects.exec.mockImplementation(async (command: string) => {
      const ssh = command.startsWith('ssh ');
      if (command.includes('list-panes')) {
        if (ssh) {
          if (phase === 2) throw Error('remote pane is already absent');
          return { stdout: `codeman-ssh-${native.sessionId.slice(0, 8)}|$17|%9|9009|17000|1|1\n`, stderr: '' };
        }
        if (phase === 2 && kind === 'unreadable-local') throw Error('local socket is unreadable');
        if (phase === 2 && (kind === 'missing-socket' || kind === 'wrong-socket'))
          throw Object.assign(Error('socket missing'), {
            code: 1,
            stdout: '',
            stderr: `error connecting to ${join(root, 'tmux-' + process.getuid!(), kind === 'wrong-socket' ? 'foreign-socket' : manager.muxSocket)} (No such file or directory)\n`,
          });
        return {
          stdout:
            phase === 2 && kind === 'local-absent'
              ? 'codeman-other|$18|%10|601|88|1|1\n'
              : phase === 2 && kind === 'native-drift'
                ? local.replace('|600|', '|602|')
                : local,
          stderr: '',
        };
      }
      if (ssh) {
        if (phase === 2) throw Error('must not repeat the remote kill');
        if (kind === 'unknown-remote') throw Error('remote kill ACK lost');
        if (kind === 'request-aborted') current = false;
      } else if (phase === 1) throw Error('local kill ACK lost');
      return { stdout: 'CODEMAN_OWNED_KILL_ACK\n', stderr: '' };
    });
    const receipt = join(
      root,
      'owned-remote-deletions',
      hash(JSON.stringify([process.env.TMUX_TMPDIR || '/tmp', manager.muxSocket, JSON.stringify(native)])) + '.json'
    );
    expect(await manager.killPersistedOwnedRemoteSession(native.sessionId, native, () => current)).toBe(false);
    expect(manager.getSession(native.sessionId)).toBe(native);
    if (kind === 'unknown-remote') await expect(fs.lstat(receipt)).rejects.toMatchObject({ code: 'ENOENT' });
    else {
      expect(JSON.parse(await fs.readFile(receipt, 'utf8'))).toMatchObject({
        version: 1,
        local: ['' + native.muxName, '$1', '%7', '600', '88', '1', '1'],
      });
      expect((await fs.stat(receipt)).mode & 0o777).toBe(0o600);
    }
    if (kind === 'restart') {
      manager = new TmuxManager();
      managers.push(manager);
      Reflect.set(manager, 'tmuxSocket', 'fixture-socket');
      native = manager.getSession(native.sessionId)!;
      expect(native).toBeDefined();
    }
    if (kind === 'owner-drift') native.owner = 'new-owner';
    if (kind === 'corrupt-receipt') await fs.writeFile(receipt, '{incomplete');
    if (kind === 'malformed-native') {
      const record = JSON.parse(await fs.readFile(receipt, 'utf8'));
      record.remote[3] = 9009;
      await fs.writeFile(receipt, JSON.stringify(record));
    }
    current = true;
    phase = 2;
    effects.exec.mockClear();
    const cleanupEntered = createDeferred<void>(),
      cleanupRelease = createDeferred<void>(),
      cleanupFinished = createDeferred<void>();
    if (kind === 'blocked-cleanup') {
      const remove = fs.unlink.bind(fs);
      vi.spyOn(fs, 'unlink').mockImplementation(async (path) => {
        if (path !== receipt) return remove(path);
        cleanupEntered.resolve();
        await cleanupRelease.promise;
        try {
          await remove(path);
        } finally {
          cleanupFinished.resolve();
        }
      });
      syncBuiltinESMExports();
    }
    const accepted = [
      'local-present',
      'local-absent',
      'missing-socket',
      'request-aborted',
      'restart',
      'blocked-cleanup',
    ].includes(kind);
    let completed = false;
    const finishing = manager
      .killPersistedOwnedRemoteSession(native.sessionId, native, () => current)
      .then((result) => {
        completed = true;
        return result;
      });
    try {
      if (kind === 'blocked-cleanup') {
        await cleanupEntered.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(completed).toBe(true);
        expect(manager.getSession(native.sessionId)).toBeUndefined();
        expect((await fs.lstat(receipt)).isFile()).toBe(true);
      }
    } finally {
      cleanupRelease.resolve();
    }
    expect(await finishing).toBe(accepted);
    if (kind === 'blocked-cleanup') await cleanupFinished.promise;
    expect(manager.getSession(native.sessionId) === undefined).toBe(accepted);
    expect(
      effects.exec.mock.calls.filter(([command]) => command.startsWith('ssh ') && command.includes('if-shell'))
    ).toHaveLength(0);
    if (accepted) {
      expect(effects.exec.mock.calls.some(([command]) => command.startsWith('ssh '))).toBe(false);
      expect(effects.exec.mock.calls.filter(([command]) => command.includes('if-shell'))).toHaveLength(
        kind === 'local-absent' || kind === 'missing-socket' ? 0 : 1
      );
      await vi.waitFor(async () => await expect(fs.lstat(receipt)).rejects.toMatchObject({ code: 'ENOENT' }));
    } else if (kind !== 'unknown-remote') expect((await fs.lstat(receipt)).isFile()).toBe(true);
  }
);

it('converts only the certified replacement pane with durable broker reservation and preserved old shell', async () => {
  const { manager, options } = fixture();
  options.codexConfig = { noDaemon: true, resumeSessionId: SID };
  options.recoveryCodexHome = '/fixture/codex-home';
  const source: MuxSession = {
    sessionId: options.sessionId,
    muxName: `codeman-${options.sessionId.slice(0, 8)}`,
    mode: 'shell',
    workingDir: options.workingDir,
    remote: options.remote,
    owner: options.owner,
    createdAt: 1,
    pid: 7007,
    attached: true,
    remoteShellConversion: {
      phase: 'pending',
      conversationId: SID,
      codexHome: '/fixture/codex-home',
      retainedSessionName: 'codeman-retained-aaaaaaaa',
    },
  };
  manager.registerSession(source);
  await manager.flushSessionsDurably();
  const replacementPane = { paneId: '%9', panePid: 9009, status: 1 };
  const converted = await manager.convertOwnedRemoteShell(options, replacementPane, source);
  expect(converted).not.toBe(source);
  expect(converted).toMatchObject({
    mode: 'codex',
    recoveryIsolated: true,
    recoveryCodexHome: '/fixture/codex-home',
    codexRestoreUncertain: false,
    remoteShellConversion: { phase: 'pending' },
    codexRestoreConfig: options.codexConfig,
  });
  expect(converted.recoveryInputBroker).toBeDefined();
  expect(converted.recoveryInputBrokerPending).toBeUndefined();
  expect(source).toMatchObject({ mode: 'shell', pid: 7007, remoteShellConversion: { phase: 'pending' } });
  expect(effects.provision.mock.calls[0][3]).toEqual({ planOnly: true, expectedPane: replacementPane });
  expect(effects.provision.mock.calls[1][3]).toEqual({
    root: '/fixture/private',
    ownerInitialLaunch: false,
    expectedPane: replacementPane,
  });
  const commands = [...effects.sync.mock.calls, ...effects.exec.mock.calls].map(([command]) => String(command));
  expect(commands.some((command) => command.includes('kill-session'))).toBe(false);
  expect(commands.some((command) => command.includes('respawn-pane') && command.includes('attach'))).toBe(true);
  // Until main state commits, generic input, creation and reconnect cannot cross this exact attempt.
  expect(manager.canDeliverCodexOwnerInput(options.sessionId)).toBe(false);
  expect(await manager.respawnPane({ ...options, remoteAttachOnly: true })).toBeNull();
  await expect(manager.createSession(options)).rejects.toThrow('requires owner inspection');
});

it('refuses conversion of a shell without a durable exact identity/home reservation', async () => {
  const { manager, options } = fixture();
  options.codexConfig = { noDaemon: true, resumeSessionId: SID };
  options.recoveryCodexHome = '/fixture/codex-home';
  const source: MuxSession = {
    sessionId: options.sessionId,
    muxName: `codeman-${options.sessionId.slice(0, 8)}`,
    mode: 'shell',
    workingDir: options.workingDir,
    remote: options.remote,
    owner: options.owner,
    createdAt: 1,
    pid: 7007,
    attached: true,
  };
  manager.registerSession(source);
  await expect(
    manager.convertOwnedRemoteShell(options, { paneId: '%9', panePid: 9009, status: 1 }, source)
  ).rejects.toThrow('authority is unavailable');
  expect(effects.provision).not.toHaveBeenCalled();
  expect(effects.observe).not.toHaveBeenCalled();
  expect(manager.getSession(options.sessionId)).toBe(source);
});

it('retains the exact new reservation without replay when conversion launch evidence is lost', async () => {
  const { manager, options } = fixture();
  options.codexConfig = { noDaemon: true, resumeSessionId: SID };
  options.recoveryCodexHome = '/fixture/codex-home';
  const source: MuxSession = {
    sessionId: options.sessionId,
    muxName: `codeman-${options.sessionId.slice(0, 8)}`,
    mode: 'shell',
    workingDir: options.workingDir,
    remote: options.remote,
    owner: options.owner,
    createdAt: 1,
    pid: 7007,
    attached: true,
    remoteShellConversion: {
      phase: 'pending',
      conversationId: SID,
      codexHome: '/fixture/codex-home',
      retainedSessionName: 'codeman-retained-aaaaaaaa',
    },
  };
  manager.registerSession(source);
  await manager.flushSessionsDurably();
  effects.observe.mockResolvedValueOnce({ status: 'unknown' });
  const pane = { paneId: '%9', panePid: 9009, status: 1 };
  await expect(manager.convertOwnedRemoteShell(options, pane, source)).rejects.toThrow(
    'receipt needs owner inspection'
  );
  const pending = manager.getSession(options.sessionId)!;
  expect(pending).not.toBe(source);
  expect(pending.remoteShellConversion?.phase).toBe('pending');
  expect(pending.recoveryInputBrokerPending).toBeDefined();
  expect(pending.recoveryInputBroker).toBeUndefined();
  expect(source).toMatchObject({ mode: 'shell', pid: 7007 });
  const calls = effects.provision.mock.calls.length;
  await expect(manager.convertOwnedRemoteShell(options, pane, source)).rejects.toThrow('authority is unavailable');
  expect(effects.provision).toHaveBeenCalledTimes(calls);
  expect(manager.canDeliverCodexOwnerInput(options.sessionId)).toBe(false);
});
