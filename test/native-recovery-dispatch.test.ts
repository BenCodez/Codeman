/** Actual Session/TmuxManager effect boundaries, exclusively injected children and temporary owner data. */
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MuxSession } from '../src/mux-interface.js';
import type { Session as SessionType } from '../src/session.js';
import type { TmuxManager as ManagerType } from '../src/tmux-manager.js';

const effects = vi.hoisted(() => ({ exec: vi.fn(), sync: vi.fn() }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const exec = () => {
    throw new Error('Unmocked process effect forbidden');
  };
  Object.defineProperty(exec, Symbol.for('nodejs.util.promisify.custom'), { value: effects.exec });
  return {
    ...actual,
    exec,
    execSync: effects.sync,
    execFile: () => {
      throw new Error('Unmocked process effect forbidden');
    },
    spawn: () => {
      throw new Error('Unmocked process effect forbidden');
    },
  };
});
let Session: typeof import('../src/session.js').Session;
let TmuxManager: typeof import('../src/tmux-manager.js').TmuxManager;
let directory: string;
let previousData: string | undefined;
let previousMode: string | undefined;
const workers: SessionType[] = [];
beforeAll(async () => {
  // Enable the real command branches only after every child API is mocked.
  const vitest = process.env.VITEST;
  delete process.env.VITEST;
  try {
    ({ TmuxManager } = await import('../src/tmux-manager.js'));
    ({ Session } = await import('../src/session.js'));
  } finally {
    if (vitest !== undefined) process.env.VITEST = vitest;
  }
});
beforeEach(() => {
  directory = mkdtempSync(join(homedir(), 'native-recovery-'));
  previousData = process.env.CODEMAN_DATA_DIR;
  previousMode = process.env.CODEMAN_MULTIUSER;
  process.env.CODEMAN_DATA_DIR = directory;
  process.env.CODEMAN_MULTIUSER = '1';
  effects.exec.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
  effects.sync.mockReset().mockReturnValue('99999\n');
  setGrant(true);
});
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.stop(false);
  if (previousData === undefined) delete process.env.CODEMAN_DATA_DIR;
  else process.env.CODEMAN_DATA_DIR = previousData;
  if (previousMode === undefined) delete process.env.CODEMAN_MULTIUSER;
  else process.env.CODEMAN_MULTIUSER = previousMode;
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});
function setGrant(granted: boolean) {
  const path = join(directory, 'users.json');
  writeFileSync(
    `${path}.fixture`,
    JSON.stringify({ version: 1, users: [{ username: 'worker', role: 'user', canBypassPermissions: granted }] })
  );
  renameSync(`${path}.fixture`, path);
}
async function fixture(action: 'continue' | 'restart') {
  const home = join(directory, 'codex');
  mkdirSync(home);
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const thread = '11111111-2222-3333-4444-555555555555';
  const pane = {
    dead: action === 'restart',
    status: action === 'restart' ? 1 : undefined,
    screen: action === 'restart' ? null : '›\n  fixture-model high · /tmp\n',
  };
  // Bypass constructor/background discovery; use the real effect methods with a single owned registry entry.
  const manager = Object.create(TmuxManager.prototype) as ManagerType;
  const record = {
    sessionId: id,
    muxName: 'codeman-aaaaaaaa',
    pid: 99999,
    createdAt: Date.now(),
    workingDir: directory,
    mode: 'codex',
    attached: true,
    recoveryIsolated: true,
    recoveryCodexHome: home,
  } as MuxSession;
  Reflect.set(manager, 'sessions', new Map([[id, record]]));
  Reflect.set(manager, 'tmuxSocket', 'fixture-socket');
  Reflect.set(manager, 'paneExits', new Map());
  Reflect.set(manager, 'paneExitGeneration', 0);
  vi.spyOn(manager, 'isAvailable').mockReturnValue(true);
  vi.spyOn(manager, 'inspectPaneForRecovery').mockResolvedValue(pane);
  // These would read server credential env/bin locations; the effect boundary under test needs neither.
  vi.spyOn(manager as unknown as { _configureCliEnv(): void }, '_configureCliEnv').mockImplementation(() => {});
  vi.spyOn(
    manager as unknown as { buildPathExport(): { pathExport: string; dir: null } },
    'buildPathExport'
  ).mockReturnValue({ pathExport: '', dir: null });
  vi.spyOn(manager as unknown as { saveSessions(): void }, 'saveSessions').mockImplementation(() => {});
  const worker = new Session({
    id,
    owner: 'worker',
    workingDir: directory,
    mode: 'codex',
    useMux: true,
    mux: manager,
    muxSession: record,
    codexConfig: { noDaemon: true, model: 'fixture-model' },
    envOverrides: { CODEX_HOME: home },
  });
  worker.pinRecoveryConversation(thread);
  workers.push(worker);
  let current = true;
  let evidence = true;
  const deliver = () =>
    worker.deliverRecovery(
      { action, key: 'fixture', conversationId: thread, startedAt: Date.now() },
      worker.getRecoveryContext().generation,
      () => current,
      'Authorized fixture continuation',
      () => evidence
    );
  return {
    worker,
    manager,
    deliver,
    cancel: () => {
      current = false;
    },
    invalidate: () => {
      evidence = false;
    },
  };
}
function commands() {
  return effects.exec.mock.calls.map(([command]) => String(command));
}

describe('native continuation after literal input', () => {
  it.each(['unchanged', 'cancel', 'grant', 'delay-cancel', 'delay-grant', 'evidence', 'config', 'stop', 'exception'])(
    'rechecks %s before Enter and preserves uncertain partial delivery',
    async (change) => {
      const f = await fixture('continue');
      effects.exec.mockImplementation(async (command: string) => {
        if (command.includes('send-keys') && command.includes(' -l ')) {
          if (change === 'cancel') f.cancel();
          if (change === 'grant') setGrant(false);
          if (change === 'delay-cancel') setTimeout(f.cancel, 10);
          if (change === 'delay-grant') setTimeout(() => setGrant(false), 10);
          if (change === 'evidence') f.invalidate();
          if (change === 'config') f.worker.codexConfig!.model = 'changed-fixture-model';
          if (change === 'stop') await f.worker.stop(false);
          if (change === 'exception') throw new Error('Fixture literal bytes may already have landed');
        }
        return { stdout: '', stderr: '' };
      });
      expect(await f.deliver()).toBe(change === 'unchanged' ? 'sent' : 'unknown');
      expect(commands().filter((command) => command.includes(' -l '))).toHaveLength(1);
      expect(commands().filter((command) => command.endsWith(' Enter'))).toHaveLength(change === 'unchanged' ? 1 : 0);
      expect(commands().filter((command) => command.includes('kill-'))).toHaveLength(0);
    }
  );
  it('certifies a current grant refusal before the first native input effect', async () => {
    const f = await fixture('continue');
    const nativeSend = f.manager.sendInput.bind(f.manager);
    vi.spyOn(f.manager, 'sendInput').mockImplementation((...args) => {
      setGrant(false);
      return nativeSend(...args);
    });
    expect(await f.deliver()).toBe('not-sent');
    expect(commands()).toEqual([]);
  });

  it('still sends ordinary two-argument input through the existing literal/Enter behavior', async () => {
    const f = await fixture('continue');
    expect(await f.manager.sendInput(f.worker.id, 'ordinary fixture\r')).toBe(true);
    expect(commands().filter((command) => command.endsWith(' Enter'))).toHaveLength(1);
  });
});

describe('native restart final preparation boundary', () => {
  it.each(['unchanged', 'cancel', 'grant', 'evidence', 'config'])(
    'rechecks %s after environment setup before a worker child',
    async (change) => {
      const f = await fixture('restart');
      effects.sync.mockImplementation((command: string) => {
        if (command.includes('setenv') && command.includes(' CODEX_HOME ')) {
          if (change === 'cancel') f.cancel();
          if (change === 'grant') setGrant(false);
          if (change === 'evidence') f.invalidate();
          if (change === 'config') f.worker.codexConfig!.model = 'changed-fixture-model';
        }
        return '99999\n';
      });
      expect(await f.deliver()).toBe(change === 'unchanged' ? 'sent' : 'not-sent');
      const spawns = commands().filter((command) => command.includes('respawn-pane'));
      expect(spawns).toHaveLength(change === 'unchanged' ? 1 : 0);
      if (spawns.length) expect(spawns[0]).not.toContain('respawn-pane -k');
      expect(commands().filter((command) => command.includes('kill-'))).toHaveLength(0);
    }
  );
  it('keeps a worker child response loss uncertain and never kills the worker', async () => {
    const f = await fixture('restart');
    effects.exec.mockImplementation(async () => {
      throw new Error('Fixture respawn response lost after dispatch');
    });
    expect(await f.deliver()).toBe('unknown');
    expect(commands().filter((command) => command.includes('respawn-pane'))).toHaveLength(1);
    expect(commands().filter((command) => command.includes('kill-'))).toHaveLength(0);
  });
});
