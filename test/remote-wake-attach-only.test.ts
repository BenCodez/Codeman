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

function fixture(mode: 'codex' | 'claude', owned?: boolean, bound = true, stubReadiness = true) {
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
    owner: 'fixture-owner',
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
  record.remote = worker.remote;
  workers.push(worker);
  // These cases isolate attach-command generation. Private target readiness
  // is exercised by the actual Session readiness suite.
  if (stubReadiness) {
    vi.spyOn(worker, 'confirmRemoteWakeReady').mockResolvedValue(true);
    vi.spyOn(worker, 'isRemoteWakeReadyCurrent').mockReturnValue(true);
  }
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

it('wakes an unguarded owned Codex worker through actual Session readiness and attach-only command generation', async () => {
  const f = fixture('codex', true, false, false);
  await expect(f.registry.ensureAwake(f.worker)).resolves.toBe(true);
  expect(f.worker.remoteWakeInputScope()).toBeUndefined();
  expect(f.command()).toContain(' attach -t ');
  expect(f.command()).not.toContain('new-session');
  expect(f.command()).not.toContain('exec codex');
  expect(f.command()).not.toContain('dangerously-bypass');
  expect(await f.worker.getOwnedRemoteInputBroker()).toBeUndefined();
});

it('retains ordinary launch/reattach semantics for other owned CLI sessions', async () => {
  const f = fixture('claude', true);
  await expect(f.registry.ensureAwake(f.worker)).resolves.toBe(true);
  expect(f.command()).toContain('new-session -A');
});

it.each([
  ['claude', true],
  ['codex', false],
] as const)(
  'flushes ordinary %s owned=%s buffered input without controlled-worker identity requirements',
  async (mode, owned) => {
    const f = fixture(mode, owned, false);
    const delivered = vi.spyOn(f.worker, 'writeViaMux').mockResolvedValue(true);
    expect(await f.registry.handleInput(f.worker, 'queued')).toBe('buffered');
    expect(await f.registry.wake(f.worker)).toBe(true);
    expect(delivered).toHaveBeenCalledWith('queued', { fromUser: true });
    expect(f.registry.pendingBytes(f.worker.id)).toBe(0);
  }
);

it.each(['completed', 'uncertain'] as const)(
  'reattach cannot replace a pane between literal text and Enter (%s)',
  async (outcome) => {
    const f = fixture('claude', true);
    let entering!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      entering = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bytes: string[] = [];
    effects.exec.mockImplementation(async (command: string) => {
      if (command.includes('send-keys') && command.includes(' -l ')) bytes.push('literal');
      else if (command.includes('send-keys') && command.includes('Enter')) {
        entering();
        await pending;
        if (outcome === 'uncertain') throw new Error('Fixture lost Enter ACK');
        bytes.push('Enter');
      }
      return { stdout: '99999\n', stderr: '' };
    });
    const identity = { clientId: 'reconnect-owner', seq: 1 };
    expect(f.worker.deferInputSeq(identity.clientId, identity.seq)).toBe(true);
    expect(f.worker.shouldApplyInput(identity.clientId, identity.seq)).toBe(true);
    const writing = f.worker.writeViaMux('literal\r', { fromUser: true, inputSeq: identity }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );
    await entered;
    try {
      expect(bytes).toEqual(['literal']);
      expect(f.worker.paneLifecycleInFlight).toBe(true);
      expect(await f.worker.reattachRemote()).toBe(false);
      expect(await f.registry.ensureAwake(f.worker)).toBe(false);
      expect(f.command()).toBeUndefined();
    } finally {
      release();
    }
    const result = await writing;
    if (outcome === 'completed') expect(result).toEqual({ value: true });
    else expect(result).toHaveProperty('error');
    expect(f.worker.paneLifecycleInFlight).toBe(false);
    expect(await f.worker.reattachRemote()).toBe(true);
    expect(f.command()).toContain('new-session -A');
    // A successful reconnect must never reopen a delivered or uncertain identity.
    expect(f.worker.shouldApplyInput(identity.clientId, identity.seq)).toBe(false);
    expect(bytes).toEqual(outcome === 'completed' ? ['literal', 'Enter'] : ['literal']);
  }
);

it('ordinary reconnect proceeds after a certified pre-dispatch input refusal', async () => {
  const f = fixture('claude', true);
  vi.spyOn(Reflect.get(f.worker, '_mux') as ManagerType, 'canDeliverCodexOwnerInput').mockReturnValue(false);
  await expect(f.worker.writeViaMux('not sent\r', { fromUser: true })).resolves.toBe(false);
  expect(effects.exec.mock.calls.some(([command]) => command.includes('send-keys'))).toBe(false);
  expect(f.worker.paneLifecycleInFlight).toBe(false);
  await expect(f.worker.reattachRemote()).resolves.toBe(true);
  expect(f.command()).toContain('new-session -A');
});
