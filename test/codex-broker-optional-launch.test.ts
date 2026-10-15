/** Optional guard setup may fail before a fake native launch; every process API is sealed. */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { TmuxManager as Manager } from '../src/tmux-manager.js';
import { CodexInputBroker } from '../src/recovery/codex-input-broker.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getDataDirPath } from '../src/config/instance.js';

const durableSnapshots: Array<{ recoveryInputBrokerPending?: string; codexRestoreUncertain?: boolean }> = [];

function nativeReply(command: string): string {
  if (command.includes('new-session') && command.includes('-P -F')) return '$1|%7|650|900\n';
  if (command.includes('respawn-pane')) return '';
  return '700\n';
}

const effects = vi.hoisted(() => ({ sync: vi.fn(), exec: vi.fn(), file: vi.fn() }));
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
  effects.sync.mockReset().mockImplementation(nativeReply);
  durableSnapshots.length = 0;
  effects.exec.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
  effects.file.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
  manager = new TmuxManager();
  const internal = manager as unknown as {
    buildPathExport: () => { pathExport: string; dir: string };
    saveSessions: () => void;
  };
  vi.spyOn(internal, 'buildPathExport').mockReturnValue({ pathExport: '', dir: '/fixture/bin' });
  vi.spyOn(internal, 'saveSessions').mockImplementation(() => {});
  vi.spyOn(manager, 'flushSessionsDurably').mockImplementation(async (isCurrent = () => true) => {
    if ((await isCurrent()) !== true) throw Error('Fixture mux reservation cancelled');
    durableSnapshots.push(structuredClone(manager.getSession(SID)!));
  });
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
function successfulBroker() {
  return {
    directory: '/fixture/private/broker',
    incarnation: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
    configurationDigest: 'a'.repeat(64),
    startupReceipt: vi.fn(async () => 'started' as const),
  } as unknown as CodexInputBroker;
}

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
  const create = vi.spyOn(CodexInputBroker, 'create').mockResolvedValue(broker);
  const session = await manager.createSession(options);
  expect(session.recoveryInputBroker).toBe(broker.incarnation);
  expect(create).toHaveBeenCalledWith(
    join(getDataDirPath(), 'codex-input-brokers', SID),
    SID,
    expect.stringContaining('--no-daemon'),
    options.envOverrides.CODEX_HOME,
    homedir()
  );
  expect(durableSnapshots).toHaveLength(2);
  expect(durableSnapshots[0]).toMatchObject({
    recoveryInputBrokerPending: broker.incarnation,
    codexRestoreUncertain: true,
  });
  expect(durableSnapshots[1].recoveryInputBrokerPending).toBeUndefined();
  expect(durableSnapshots[1].codexRestoreUncertain).toBeUndefined();
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
        return nativeReply(command);
      });
    else vi.mocked(broker.startupReceipt).mockRejectedValue(Error('lost broker reply'));
    await expect(manager.createSession(options)).rejects.toThrow();
    expect(create).toHaveBeenCalledOnce();
    const sends = commands().filter((command) => command.includes('respawn-pane'));
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain('broker.py');
    expect(durableSnapshots).toHaveLength(1);
    expect(manager.getSession(SID)).toMatchObject({
      recoveryInputBrokerPending: broker.incarnation,
      codexRestoreUncertain: true,
    });
  }
);
