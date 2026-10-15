/** Optional guard setup may fail before a fake native launch; every process API is sealed. */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { TmuxManager as Manager } from '../src/tmux-manager.js';
import { CodexInputBroker } from '../src/recovery/codex-input-broker.js';

const effects = vi.hoisted(() => ({ sync: vi.fn(), exec: vi.fn(), file: vi.fn(), pty: vi.fn() }));
vi.mock('node-pty', () => ({ spawn: effects.pty }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const exec = (...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback === 'function') queueMicrotask(() => callback(null, '', ''));
    return { on: vi.fn(), kill: vi.fn(), pid: 12345 };
  };
  Object.defineProperty(exec, Symbol.for('nodejs.util.promisify.custom'), { value: effects.exec });
  const execFile = () => {
    throw Error('Unmocked native effect');
  };
  Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), { value: effects.file });
  const denied = () => {
    throw Error('Unmocked native effect: ' + new Error().stack);
  };
  return {
    ...actual,
    exec,
    execFile,
    execSync: effects.sync,
    spawn: denied,
    spawnSync: denied,
    execFileSync: denied,
    fork: denied,
  };
});
let TmuxManager: typeof import('../src/tmux-manager.js').TmuxManager;
let manager: Manager;
const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const options = {
  sessionId: SID,
  workingDir: '/fixture/work',
  mode: 'codex' as const,
  codexConfig: { noDaemon: true, resumeSessionId: '11111111-2222-3333-4444-555555555555' },
  envOverrides: { CODEX_HOME: '/fixture/codex' },
};
beforeAll(async () => {
  const saved = process.env.VITEST;
  delete process.env.VITEST;
  try {
    ({ TmuxManager } = await import('../src/tmux-manager.js'));
  } finally {
    if (saved !== undefined) process.env.VITEST = saved;
  }
});
beforeEach(() => {
  effects.pty.mockReset().mockReturnValue({
    pid: 0,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
  });
  effects.sync.mockReset().mockImplementation((command: string) => nativeDispatchReceipt(command) || '700\n');
  effects.exec
    .mockReset()
    .mockImplementation(async (command: string) => ({ stdout: nativeDispatchReceipt(command), stderr: '' }));
  effects.file.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
  manager = new TmuxManager();
  const internal = manager as unknown as {
    buildPathExport: () => { pathExport: string; dir: string };
    saveSessions: () => void;
  };
  vi.spyOn(internal, 'buildPathExport').mockReturnValue({ pathExport: '', dir: '/fixture/bin' });
  vi.spyOn(internal, 'saveSessions').mockImplementation(() => {});
  effects.sync.mockClear();
});
afterEach(() => {
  manager.destroy();
  vi.restoreAllMocks();
});
afterAll(() => {
  vi.restoreAllMocks();
});
function commands() {
  return [...effects.sync.mock.calls, ...effects.exec.mock.calls].map(([command]) => String(command));
}
function nativeDispatchReceipt(command: string): string {
  return command.includes('CODEMAN_OPTIONAL_BROKER_DISPATCHED')
    ? 'CODEMAN_OPTIONAL_BROKER_DISPATCHED|$1|%7|700|800\n'
    : '';
}
function successfulBroker() {
  return {
    directory: '/fixture/private/broker',
    incarnation: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
    configurationDigest: 'a'.repeat(64),
    startupReceipt: vi.fn(async () => 'started' as const),
  } as unknown as CodexInputBroker;
}

it.each([
  ['create', false],
  ['create', undefined],
  ['ordinary-respawn', false],
  ['ordinary-respawn', undefined],
] as const)('preserves an ordinary %s relative home with noDaemon=%s', async (kind, noDaemon) => {
  const create = vi.spyOn(CodexInputBroker, 'create');
  const launch = {
    ...options,
    codexConfig: { resumeSessionId: options.codexConfig.resumeSessionId, ...(noDaemon === false ? { noDaemon } : {}) },
    envOverrides: { CODEX_HOME: 'relative-home' },
  };
  if (kind === 'ordinary-respawn') registerOrdinary();
  const result = kind === 'create' ? await manager.createSession(launch) : await manager.respawnPane(launch);
  const session = manager.getSession(SID)!;
  expect(kind === 'create' ? session.pid : result).toBe(700);
  expect(session.recoveryCodexHome).toBeUndefined();
  expect(session.recoveryIsolated).toBe(false);
  expect(session.recoveryInputBroker).toBeUndefined();
  expect(create).not.toHaveBeenCalled();
  const envCommands = commands().filter((command) => command.includes(' CODEX_HOME '));
  expect(envCommands).toHaveLength(1);
  expect(envCommands[0]).toMatch(/ CODEX_HOME 'relative-home'$/);
  const sends = commands().filter((command) => command.includes('respawn-pane'));
  expect(sends).toHaveLength(1);
  expect(sends[0]).toContain(options.workingDir);
  expect(sends[0]).toContain('cd ');
  expect(sends[0]).toContain('codex');
  expect(sends[0]).not.toContain('--no-daemon');
  expect(sends[0]).not.toContain('broker.py');
  expect(effects.pty).not.toHaveBeenCalled();
});

it('still refuses a relative home before no-daemon broker creation or native effects', async () => {
  const create = vi.spyOn(CodexInputBroker, 'create');
  await expect(manager.createSession({ ...options, envOverrides: { CODEX_HOME: 'relative-home' } })).rejects.toThrow(
    'Local Codex launch home is unverified'
  );
  expect(create).not.toHaveBeenCalled();
  expect(commands()).toEqual([]);
  expect(effects.pty).not.toHaveBeenCalled();
});

it('still refuses a guarded respawn without absolute recorded provenance before native effects', async () => {
  registerOrdinary();
  const create = vi.spyOn(CodexInputBroker, 'create');
  const noteDispatch = vi.fn();
  expect(
    await manager.respawnPane({
      ...options,
      envOverrides: { CODEX_HOME: 'relative-home' },
      recoveryCodexHome: 'relative-home',
      onlyIfDead: true,
      recoveryDispatchGuard: { confirm: () => true, noteDispatch },
    })
  ).toBeNull();
  expect(create).not.toHaveBeenCalled();
  expect(noteDispatch).not.toHaveBeenCalled();
  expect(commands()).toEqual([]);
  expect(effects.pty).not.toHaveBeenCalled();
});

it.each(['create', 'ordinary-respawn'] as const)(
  'keeps an ordinary no-daemon %s available after optional private provisioning fails',
  async (kind) => {
    const create = vi.spyOn(CodexInputBroker, 'create').mockRejectedValue(Error('isolated disk full'));
    if (kind === 'create') {
      const session = await manager.createSession(options);
      expect(session.pid).toBe(700);
      expect(session.recoveryInputBroker).toBeUndefined();
    } else {
      manager.registerSession({
        sessionId: SID,
        muxName: 'codeman-aaaaaaaa',
        pid: 600,
        mode: 'codex',
        workingDir: options.workingDir,
        createdAt: Date.now(),
        attached: false,
      });
      expect(await manager.respawnPane(options)).toBe(700);
    }
    expect(create).toHaveBeenCalledOnce();
    const sends = commands().filter((command) => command.includes('respawn-pane'));
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain('codex');
    expect(sends[0]).toContain('--no-daemon');
    expect(sends[0]).not.toContain('broker.py');
  }
);

it('keeps guarded respawn strict when required private provisioning fails', async () => {
  vi.spyOn(CodexInputBroker, 'create').mockRejectedValue(Error('isolated disk full'));
  manager.registerSession({
    sessionId: SID,
    muxName: 'codeman-aaaaaaaa',
    pid: 600,
    mode: 'codex',
    workingDir: options.workingDir,
    createdAt: Date.now(),
    attached: false,
  });
  const noteDispatch = vi.fn();
  const prior = {
    incarnation: 'cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa',
    closed: true,
    exitStatus: 1,
    childPid: 601,
    brokerPid: 600,
    brokerStart: '900',
    childStart: '901',
    rawGeneration: 0,
    homeDigest: 'a'.repeat(64),
    launchDigest: 'b'.repeat(64),
    ownerCounters: { 'owner-pty': 0, 'owner-key': 0, 'owner-mux': 0 },
  };
  vi.spyOn(
    manager as unknown as { getInputBroker: () => Promise<CodexInputBroker> },
    'getInputBroker'
  ).mockResolvedValue({ prove: async () => prior } as unknown as CodexInputBroker);
  await expect(
    manager.respawnPane({
      ...options,
      recoveryCodexHome: '/fixture/codex',
      onlyIfDead: true,
      expectedRecoveryPane: { paneId: '%7', panePid: 600, status: 1, paneSignalToken: '', inputProvenance: prior },
      recoveryDispatchGuard: { confirm: () => true, noteDispatch },
    })
  ).rejects.toThrow('isolated disk full');
  expect(noteDispatch).not.toHaveBeenCalled();
  expect(commands().some((command) => command.includes('respawn-pane'))).toBe(false);
});

it('keeps the guarded launch command when private provisioning succeeds', async () => {
  const broker = successfulBroker();
  vi.spyOn(CodexInputBroker, 'create').mockResolvedValue(broker);
  const session = await manager.createSession(options);
  expect(session.recoveryInputBroker).toBe(broker.incarnation);
  expect(session.recoveryCodexHome).toBe('/fixture/codex');
  expect(session.recoveryIsolated).toBe(true);
  const sends = commands().filter((command) => command.includes('respawn-pane'));
  expect(sends).toHaveLength(1);
  expect(sends[0]).toContain('broker.py');
  expect(sends[0]).toContain(broker.configurationDigest);
});

it('retains the existing optional Python-preflight fallback without creating private material', async () => {
  effects.file.mockRejectedValue(Error('fixture Python missing'));
  const create = vi.spyOn(CodexInputBroker, 'create');
  expect((await manager.createSession(options)).recoveryInputBroker).toBeUndefined();
  expect(create).not.toHaveBeenCalled();
  expect(commands().filter((command) => command.includes('respawn-pane'))).toHaveLength(1);
});

it.each(['native-dispatch', 'startup-receipt'] as const)(
  'never falls back to raw input after %s may have started a broker',
  async (failure) => {
    const broker = successfulBroker(),
      create = vi.spyOn(CodexInputBroker, 'create').mockResolvedValue(broker);
    if (failure === 'native-dispatch')
      effects.sync.mockImplementation((command: string) => {
        if (command.includes('respawn-pane')) throw Error('lost native reply');
        return nativeDispatchReceipt(command) || '700\n';
      });
    else vi.mocked(broker.startupReceipt).mockRejectedValue(Error('lost broker reply'));
    await expect(manager.createSession(options)).rejects.toThrow();
    expect(create).toHaveBeenCalledOnce();
    const sends = commands().filter((command) => command.includes('respawn-pane'));
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain('broker.py');
  }
);

function registerOrdinary() {
  manager.registerSession({
    sessionId: SID,
    muxName: 'codeman-aaaaaaaa',
    pid: 600,
    mode: 'codex',
    workingDir: options.workingDir,
    createdAt: Date.now(),
    attached: false,
  });
}
const nativeRow = '$1|%7|700|1|800\n';
function certifiedRefusal() {
  const broker = successfulBroker();
  vi.mocked(broker.startupReceipt).mockResolvedValue('not-sent');
  vi.spyOn(CodexInputBroker, 'create').mockResolvedValue(broker);
  effects.exec.mockImplementation(async (command: string) => ({
    stdout: command.includes(' list-panes -s ')
      ? nativeRow
      : command.includes('CODEMAN_OPTIONAL_FALLBACK_STARTED')
        ? 'CODEMAN_OPTIONAL_FALLBACK_STARTED|$1|%7|701|800\n'
        : nativeDispatchReceipt(command),
    stderr: '',
  }));
  effects.sync.mockImplementation(
    (command: string) =>
      nativeDispatchReceipt(command) ||
      (commands().some((command) => command.includes('CODEMAN_OPTIONAL_FALLBACK_STARTED')) ? '701\n' : '700\n')
  );
  return broker;
}
it.each(['create', 'ordinary-respawn'] as const)(
  'falls back after exact no-child %s refusal without broker framing',
  async (kind) => {
    const broker = certifiedRefusal();
    if (kind === 'ordinary-respawn') registerOrdinary();
    const result = kind === 'create' ? await manager.createSession(options) : await manager.respawnPane(options);
    expect(result).not.toBeNull();
    expect(manager.getSession(SID)?.recoveryInputBroker).toBeUndefined();
    expect(manager.wrapCodexOwnerInput(SID, 'ordinary owner input').status).toBe('passthrough');
    expect(broker.startupReceipt).toHaveBeenCalledWith(700);
    const fallback = commands().find((c) => c.includes('CODEMAN_OPTIONAL_FALLBACK_STARTED'))!;
    expect(fallback).toContain('#{session_id},$1');
    expect(fallback).toContain('#{pane_id},%7');
    expect(fallback).toContain('#{pane_pid},700');
    expect(fallback).toContain('#{pane_dead},1');
    expect(fallback).toContain('#{pid},800');
    expect(fallback).toContain('respawn-pane -c /tmp');
    expect(fallback).not.toContain('respawn-pane -k');
    expect(fallback).not.toContain('broker.py');
    expect(fallback).toContain('--no-daemon');
    expect(fallback).toContain(options.codexConfig.resumeSessionId);
    expect(fallback).toContain(options.workingDir);
    expect(commands().filter((c) => c.includes('respawn-pane'))).toHaveLength(2);
  }
);
it.each(['create', 'ordinary-respawn'] as const)(
  'retains %s broker provenance for an unknown startup result without raw fallback',
  async (kind) => {
    const broker = successfulBroker();
    vi.mocked(broker.startupReceipt).mockResolvedValue('unknown');
    vi.spyOn(CodexInputBroker, 'create').mockResolvedValue(broker);
    if (kind === 'ordinary-respawn') registerOrdinary();
    if (kind === 'create') await manager.createSession(options);
    else await manager.respawnPane(options);
    expect(manager.getSession(SID)?.recoveryInputBroker).toBe(broker.incarnation);
    expect(commands().filter((c) => c.includes('respawn-pane'))).toHaveLength(1);
    expect(commands().some((c) => c.includes('CODEMAN_OPTIONAL_FALLBACK_STARTED'))).toBe(false);
  }
);
it.each([
  ['live', '$1|%7|700|0|800\n'],
  ['replacement PID', '$1|%7|701|1|800\n'],
  ['malformed', '$1|%7|700|1|800'],
  ['extra pane', nativeRow + nativeRow],
  ['unsafe server', '$1|%7|700|1|0\n'],
] as const)('refuses ordinary fallback when native proof is %s', async (_name, row) => {
  certifiedRefusal();
  effects.exec.mockImplementation(async (command: string) => ({
    stdout: command.includes(' list-panes -s ') ? row : nativeDispatchReceipt(command),
    stderr: '',
  }));
  await expect(manager.createSession(options)).rejects.toThrow('could not safely fall back');
  expect(commands().filter((c) => c.includes('respawn-pane'))).toHaveLength(1);
});
it('retains uncertainty when native fallback sees a replaced pane at its final atomic gate', async () => {
  certifiedRefusal();
  effects.exec.mockImplementation(async (command: string) => ({
    stdout: command.includes(' list-panes -s ')
      ? nativeRow
      : command.includes('CODEMAN_OPTIONAL_FALLBACK_STARTED')
        ? 'CODEMAN_OPTIONAL_FALLBACK_REFUSED\n'
        : nativeDispatchReceipt(command),
    stderr: '',
  }));
  registerOrdinary();
  expect(await manager.respawnPane(options)).toBeNull();
  expect(commands().filter((c) => c.includes('respawn-pane'))).toHaveLength(2);
  const fallback = commands().find((c) => c.includes('CODEMAN_OPTIONAL_FALLBACK_STARTED'))!;
  expect(fallback).not.toContain('respawn-pane -k');
});

it('retains the dispatched incarnation when an ordinary respawn startup reply is lost', async () => {
  const broker = successfulBroker();
  vi.spyOn(CodexInputBroker, 'create').mockResolvedValue(broker);
  vi.mocked(broker.startupReceipt).mockRejectedValue(Error('lost startup receipt'));
  registerOrdinary();
  expect(await manager.respawnPane(options)).toBeNull();
  expect(manager.getSession(SID)).toMatchObject({ pid: 700, recoveryInputBroker: broker.incarnation });
  expect(commands().filter((command) => command.includes('respawn-pane'))).toHaveLength(1);
});
it('waits for the same refused broker to exit before a no-k fallback', async () => {
  certifiedRefusal();
  let reads = 0;
  effects.exec.mockImplementation(async (command: string) => ({
    stdout: command.includes(' list-panes -s ')
      ? ++reads === 1
        ? '$1|%7|700|0|800\n'
        : nativeRow
      : command.includes('CODEMAN_OPTIONAL_FALLBACK_STARTED')
        ? 'CODEMAN_OPTIONAL_FALLBACK_STARTED|$1|%7|701|800\n'
        : nativeDispatchReceipt(command),
    stderr: '',
  }));
  expect((await manager.createSession(options)).recoveryInputBroker).toBeUndefined();
  expect(reads).toBe(2);
});
it('refuses a changed native server while waiting for a certified refused broker to exit', async () => {
  certifiedRefusal();
  let reads = 0;
  effects.exec.mockImplementation(async (command: string) => ({
    stdout: command.includes(' list-panes -s ')
      ? ++reads === 1
        ? '$1|%7|700|0|800\n'
        : '$1|%7|700|1|801\n'
      : nativeDispatchReceipt(command),
    stderr: '',
  }));
  await expect(manager.createSession(options)).rejects.toThrow('could not safely fall back');
  expect(reads).toBe(2);
  expect(commands().filter((command) => command.includes('respawn-pane'))).toHaveLength(1);
});
it('does not fallback after the registered session is replaced during native evidence', async () => {
  certifiedRefusal();
  registerOrdinary();
  effects.exec.mockImplementation(async (command: string) => {
    if (command.includes(' list-panes -s ')) {
      registerOrdinary();
      return { stdout: nativeRow, stderr: '' };
    }
    return { stdout: nativeDispatchReceipt(command), stderr: '' };
  });
  expect(await manager.respawnPane(options)).toBeNull();
  expect(commands().filter((command) => command.includes('respawn-pane'))).toHaveLength(1);
});
it('never turns a guarded certified no-child refusal into an ordinary launch', async () => {
  const broker = certifiedRefusal();
  Object.assign(broker, { setStartupAuthority: vi.fn(async () => {}) });
  registerOrdinary();
  const prior = {
    incarnation: 'cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa',
    closed: true,
    exitStatus: 1,
    childPid: 601,
    brokerPid: 600,
    brokerStart: '900',
    childStart: '901',
    rawGeneration: 0,
    homeDigest: 'a'.repeat(64),
    launchDigest: 'b'.repeat(64),
    ownerCounters: { 'owner-pty': 0, 'owner-key': 0, 'owner-mux': 0 },
  };
  vi.spyOn(
    manager as unknown as { getInputBroker: () => Promise<CodexInputBroker> },
    'getInputBroker'
  ).mockResolvedValue({ prove: async () => prior } as unknown as CodexInputBroker);
  const noteDispatch = vi.fn(),
    noteBrokerRefusal = vi.fn();
  expect(
    await manager.respawnPane({
      ...options,
      recoveryCodexHome: '/fixture/codex',
      onlyIfDead: true,
      expectedRecoveryPane: { paneId: '%7', panePid: 600, status: 1, paneSignalToken: '', inputProvenance: prior },
      recoveryDispatchGuard: { confirm: () => true, noteDispatch, noteBrokerRefusal, inputProof: prior },
    })
  ).toBeNull();
  expect(noteDispatch).toHaveBeenCalledOnce();
  expect(noteBrokerRefusal).toHaveBeenCalledOnce();
  expect(manager.getSession(SID)?.recoveryInputBroker).toBe(broker.incarnation);
  expect(commands().filter((command) => command.includes('respawn-pane'))).toHaveLength(1);
  expect(commands().some((command) => command.includes('CODEMAN_OPTIONAL_FALLBACK_STARTED'))).toBe(false);
});

it.each(['unchanged', 'stop', 'owner', 'configuration', 'environment'] as const)(
  'uses actual Session owner authority after held native refusal proof (%s)',
  async (change) => {
    const { Session } = await import('../src/session.js');
    const session = new Session({
      workingDir: options.workingDir,
      mode: 'codex',
      useMux: false,
      codexConfig: { ...options.codexConfig },
      envOverrides: { ...options.envOverrides },
      owner: 'fixture-owner',
    });
    const capture = Reflect.get(
      session,
      '_buildRespawnPaneOptions'
    ) as () => import('../src/mux-interface.js').RespawnPaneOptions;
    const launch = capture.call(session);
    const broker = certifiedRefusal();
    let release!: (row: { stdout: string; stderr: string }) => void;
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    effects.exec.mockImplementation(async (command: string) => {
      if (command.includes(' list-panes -s ')) {
        entered();
        return new Promise<{ stdout: string; stderr: string }>((resolve) => {
          release = resolve;
        });
      }
      return {
        stdout: command.includes('CODEMAN_OPTIONAL_FALLBACK_STARTED')
          ? 'CODEMAN_OPTIONAL_FALLBACK_STARTED|$1|%7|701|800\n'
          : nativeDispatchReceipt(command),
        stderr: '',
      };
    });
    const pending = manager.createSession({ ...options, ownerLaunchIsCurrent: launch.ownerLaunchIsCurrent });
    try {
      await reached;
      if (change === 'stop') await session.stop(false);
      if (change === 'owner') session.owner = 'different-owner';
      if (change === 'configuration')
        Reflect.set(session, '_codexConfig', { ...options.codexConfig, model: 'different-model' });
      if (change === 'environment') Reflect.set(session, '_envOverrides', { CODEX_HOME: '/different/home' });
      release({ stdout: nativeRow, stderr: '' });
      if (change === 'unchanged') expect((await pending).recoveryInputBroker).toBeUndefined();
      else await expect(pending).rejects.toThrow('could not safely fall back');
      expect(broker.startupReceipt).toHaveBeenCalledWith(700);
      expect(commands().filter((command) => command.includes('respawn-pane'))).toHaveLength(
        change === 'unchanged' ? 2 : 1
      );
    } finally {
      await session.stop(false);
    }
  }
);
it.each(['session', 'pane', 'server', 'same-pid', 'missing-newline'] as const)(
  'refuses an unbound fallback native acknowledgement (%s)',
  async (change) => {
    certifiedRefusal();
    const ack = {
      session: 'CODEMAN_OPTIONAL_FALLBACK_STARTED|$2|%7|701|800\n',
      pane: 'CODEMAN_OPTIONAL_FALLBACK_STARTED|$1|%8|701|800\n',
      server: 'CODEMAN_OPTIONAL_FALLBACK_STARTED|$1|%7|701|801\n',
      'same-pid': 'CODEMAN_OPTIONAL_FALLBACK_STARTED|$1|%7|700|800\n',
      'missing-newline': 'CODEMAN_OPTIONAL_FALLBACK_STARTED|$1|%7|701|800',
    }[change];
    effects.exec.mockImplementation(async (command: string) => ({
      stdout: command.includes(' list-panes -s ')
        ? nativeRow
        : command.includes('CODEMAN_OPTIONAL_FALLBACK_STARTED')
          ? ack
          : nativeDispatchReceipt(command),
      stderr: '',
    }));
    await expect(manager.createSession(options)).rejects.toThrow('could not safely fall back');
    expect(commands().filter((command) => command.includes('respawn-pane'))).toHaveLength(2);
  }
);

for (const kind of ['create', 'ordinary-respawn'] as const) {
  it.each(['session', 'pane', 'server'] as const)(
    `never selects a first-observed replacement ${kind} tuple with the same broker PID (%s)`,
    async (change) => {
      certifiedRefusal();
      if (kind === 'ordinary-respawn') registerOrdinary();
      const fields = ['$1', '%7', '700', '1', '800'];
      fields[{ session: 0, pane: 1, server: 4 }[change]] = { session: '$2', pane: '%8', server: '801' }[change];
      effects.exec.mockImplementation(async (command: string) => ({
        stdout: command.includes(' list-panes -s ')
          ? fields.join('|') + '\n'
          : command.includes('CODEMAN_OPTIONAL_FALLBACK_STARTED')
            ? `CODEMAN_OPTIONAL_FALLBACK_STARTED|${fields[0]}|${fields[1]}|701|${fields[4]}\n`
            : command.includes('CODEMAN_OPTIONAL_BROKER_DISPATCHED')
              ? 'CODEMAN_OPTIONAL_BROKER_DISPATCHED|$1|%7|700|800\n'
              : nativeDispatchReceipt(command),
        stderr: '',
      }));
      if (kind === 'create') await expect(manager.createSession(options)).rejects.toThrow();
      else expect(await manager.respawnPane(options)).toBeNull();
      expect(commands().filter((command) => command.includes('respawn-pane'))).toHaveLength(1);
      expect(commands().some((command) => command.includes('CODEMAN_OPTIONAL_FALLBACK_STARTED'))).toBe(false);
    }
  );
}

it.each([
  'healthy',
  'native-home-populated',
  'native-home-replaced',
  'replacement-tuple',
  'lost-fallback-ack',
  'owner-changed',
  'configuration-changed',
  'environment-changed',
  'stopped',
] as const)('the actual Session dead-pane path never creates another worker after %s', async (failure) => {
  const { Session } = await import('../src/session.js');
  certifiedRefusal();
  registerOrdinary();
  vi.spyOn(manager, 'isAvailable').mockReturnValue(true);
  vi.spyOn(manager, 'muxSessionExists').mockReturnValue(true);
  vi.spyOn(manager, 'isPaneDead').mockReturnValue(true);
  const session = new Session({
    id: SID,
    mode: 'codex',
    workingDir: options.workingDir,
    useMux: true,
    mux: manager,
    muxSession: manager.getSession(SID),
    codexConfig: { ...options.codexConfig },
    envOverrides: { ...options.envOverrides },
    owner: 'fixture-owner',
  });
  session.on('error', () => {});
  const original = effects.exec.getMockImplementation()!;
  effects.exec.mockImplementation(async (command: string) => {
    if (command.includes(' list-panes -s ')) {
      if (failure === 'native-home-populated') manager.getSession(SID)!.recoveryCodexHome = '/fixture/codex';
      if (failure === 'native-home-replaced') manager.getSession(SID)!.recoveryCodexHome = '/different/home';
      if (failure === 'owner-changed') session.owner = 'different-owner';
      if (failure === 'configuration-changed')
        Reflect.set(session, '_codexConfig', { ...options.codexConfig, model: 'different-model' });
      if (failure === 'environment-changed') Reflect.set(session, '_envOverrides', { CODEX_HOME: '/different/home' });
      if (failure === 'stopped') await session.stop(false);
      return { stdout: failure === 'replacement-tuple' ? '$2|%7|700|1|800\n' : nativeRow, stderr: '' };
    }
    if (failure === 'lost-fallback-ack' && command.includes('CODEMAN_OPTIONAL_FALLBACK_STARTED'))
      throw Error('Lost native fallback ACK');
    return original(command);
  });
  try {
    const healthy = failure === 'healthy' || failure === 'native-home-populated';
    if (healthy) await session.startInteractive();
    else await expect(session.startInteractive()).rejects.toThrow();
    const expectedDispatches = healthy || failure === 'lost-fallback-ack' ? 2 : 1;
    expect(commands().filter((command) => command.includes('respawn-pane'))).toHaveLength(expectedDispatches);
    expect(commands().filter((command) => command.includes(' new-session '))).toHaveLength(0);
    expect(effects.pty).toHaveBeenCalledTimes(healthy ? 1 : 0);
    await expect(session.startInteractive()).rejects.toThrow();
    expect(commands().filter((command) => command.includes('respawn-pane'))).toHaveLength(expectedDispatches);
  } finally {
    await session.stop(false);
  }
});

for (const kind of ['create', 'ordinary-respawn'] as const) {
  it.each([
    'missing',
    'missing-newline',
    'double-newline',
    'multiple-rows',
    'zero-pid',
    'zero-server',
    'wrong-marker',
    'lost-ack',
  ] as const)(`never falls back without an exact original ${kind} dispatch acknowledgement (%s)`, async (failure) => {
    const broker = certifiedRefusal();
    if (kind === 'ordinary-respawn') registerOrdinary();
    const row = 'CODEMAN_OPTIONAL_BROKER_DISPATCHED|$1|%7|700|800\n';
    const malformed = {
      missing: '',
      'missing-newline': row.trimEnd(),
      'double-newline': row + '\n',
      'multiple-rows': row + row,
      'zero-pid': row.replace('|700|', '|0|'),
      'zero-server': row.replace('|800', '|0'),
      'wrong-marker': row.replace('DISPATCHED', 'OTHER'),
      'lost-ack': '',
    }[failure];
    const sync = effects.sync.getMockImplementation()!;
    const exec = effects.exec.getMockImplementation()!;
    const response = () => {
      if (failure === 'lost-ack') throw Error('Native dispatch acknowledgement lost');
      return malformed;
    };
    effects.sync.mockImplementation((command: string) =>
      command.includes('CODEMAN_OPTIONAL_BROKER_DISPATCHED') ? response() : sync(command)
    );
    effects.exec.mockImplementation(async (command: string) =>
      command.includes('CODEMAN_OPTIONAL_BROKER_DISPATCHED') ? { stdout: response(), stderr: '' } : exec(command)
    );
    if (kind === 'create') await expect(manager.createSession(options)).rejects.toThrow();
    else {
      expect(await manager.respawnPane(options)).toBeNull();
      expect(manager.getSession(SID)).toMatchObject({ pid: 0, recoveryInputBroker: broker.incarnation });
    }
    expect(commands().filter((command) => command.includes('respawn-pane'))).toHaveLength(1);
    expect(commands().some((command) => command.includes('CODEMAN_OPTIONAL_FALLBACK_STARTED'))).toBe(false);
    expect(broker.startupReceipt).not.toHaveBeenCalled();
  });
  it(`uses the original ${kind} dispatch PID rather than a later numeric PID alias`, async () => {
    const broker = certifiedRefusal();
    if (kind === 'ordinary-respawn') registerOrdinary();
    const sync = effects.sync.getMockImplementation()!;
    effects.sync.mockImplementation((command: string) =>
      command.includes('display-message -p') && !command.includes('CODEMAN_OPTIONAL_BROKER_DISPATCHED')
        ? '999\n'
        : sync(command)
    );
    if (kind === 'create') expect((await manager.createSession(options)).pid).toBe(701);
    else expect(await manager.respawnPane(options)).toBe(701);
    expect(broker.startupReceipt).toHaveBeenCalledExactlyOnceWith(700);
  });
}
