/** Actual wake/reconnect command generation may not create a missing owned Codex worker. */
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { MuxSession } from '../src/mux-interface.js';
import type { Session as SessionType } from '../src/session.js';
import type { TmuxManager as ManagerType } from '../src/tmux-manager.js';
import { RemoteWakeRegistry } from '../src/remote-wake.js';

const effects = vi.hoisted(() => ({ exec: vi.fn(), sync: vi.fn() }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const forbidden = () => {
    throw new Error('Uninjected process effect');
  };
  Object.defineProperty(forbidden, Symbol.for('nodejs.util.promisify.custom'), { value: effects.exec });
  return {
    ...actual,
    exec: forbidden,
    execSync: effects.sync,
    execFile: forbidden,
    execFileSync: forbidden,
    spawn: forbidden,
    spawnSync: forbidden,
    fork: forbidden,
  };
});
let Session: typeof import('../src/session.js').Session;
let TmuxManager: typeof import('../src/tmux-manager.js').TmuxManager;
const workers: SessionType[] = [];
beforeAll(async () => {
  const vitest = process.env.VITEST;
  delete process.env.VITEST;
  try {
    ({ Session } = await import('../src/session.js'));
    ({ TmuxManager } = await import('../src/tmux-manager.js'));
  } finally {
    if (vitest !== undefined) process.env.VITEST = vitest;
  }
});
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.stop(false);
  vi.restoreAllMocks();
});

function fixture(mode: 'codex' | 'claude', owned?: boolean, bound = true) {
  effects.exec.mockReset().mockResolvedValue({ stdout: '99999\n', stderr: '' });
  effects.sync.mockReset().mockReturnValue('99999\n');
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const manager = Object.create(TmuxManager.prototype) as ManagerType;
  const record = {
    sessionId: id,
    muxName: 'codeman-aaaaaaaa',
    pid: 99999,
    createdAt: Date.now(),
    workingDir: '/fixture/workspace',
    mode,
    attached: true,
  } as MuxSession;
  Reflect.set(manager, 'sessions', new Map([[id, record]]));
  Reflect.set(manager, 'inputBrokers', new Map());
  Reflect.set(manager, 'inputBrokerLoads', new Map());
  Reflect.set(manager, 'inputQueues', new Map());
  Reflect.set(manager, 'tmuxSocket', 'fixture-socket');
  Reflect.set(manager, 'paneExits', new Map());
  Reflect.set(manager, 'paneExitGeneration', 0);
  vi.spyOn(manager, 'isAvailable').mockReturnValue(true);
  vi.spyOn(manager as unknown as { _configureCliEnv(): void }, '_configureCliEnv').mockImplementation(() => {});
  vi.spyOn(
    manager as unknown as { buildPathExport(): { pathExport: string; dir: null } },
    'buildPathExport'
  ).mockReturnValue({ pathExport: '', dir: null });
  vi.spyOn(manager as unknown as { saveSessions(): void }, 'saveSessions').mockImplementation(() => {});
  const worker = new Session({
    id,
    mode,
    workingDir: '/fixture/workspace',
    useMux: true,
    mux: manager,
    muxSession: record,
    owner: 'fixture-owner',
    codexConfig: {
      noDaemon: true,
      dangerouslyBypassApprovals: true,
      ...(bound ? { resumeSessionId: '11111111-2222-4333-8444-555555555555' } : {}),
    },
    remote: {
      hostId: 'fixture-host',
      label: 'Fixture',
      host: 'worker.invalid',
      username: 'fixture',
      remotePath: '/fixture/remote',
      owned,
      wakeCommand: '/fixture/wake',
      remoteSessionName: 'discovered-worker',
    },
  });
  workers.push(worker);
  const registry = new RemoteWakeRegistry({
    probe: async () => false,
    wake: async () => true,
    waitUntilReady: async () => true,
    delay: async () => {},
    log: () => {},
  });
  return {
    worker,
    registry,
    command: () => effects.exec.mock.calls.find(([command]) => command.includes('respawn-pane'))?.[0] as string,
  };
}

it.each([true, undefined, false])(
  'wake attaches an existing Codex target without creation (owned=%s)',
  async (owned) => {
    const f = fixture('codex', owned);
    await expect(f.registry.ensureAwake(f.worker)).resolves.toBe(true);
    const command = f.command();
    expect(command).toContain(' attach -t ');
    expect(command).not.toContain('new-session');
    expect(command).not.toContain('dangerously-bypass');
    expect(command).not.toContain('exec codex');
    expect(command).toContain(owned === false ? 'discovered-worker' : 'codeman-ssh-aaaaaaaa');
  }
);

it('ordinary reconnect uses attach-only even before a Codex conversation is bound', async () => {
  const f = fixture('codex', true, false);
  await expect(f.worker.reattachRemote()).resolves.toBe(true);
  expect(f.command()).toContain(' attach -t ');
  expect(f.command()).not.toContain('new-session');
  expect(f.command()).not.toContain('dangerously-bypass');
});

it('retains ordinary launch/reattach semantics for other owned CLI sessions', async () => {
  const f = fixture('claude', true);
  await expect(f.registry.ensureAwake(f.worker)).resolves.toBe(true);
  expect(f.command()).toContain('new-session -A');
});
