/** @fileoverview Native launch branches with injected child/PTY effects and temporary metadata. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MuxSession } from '../src/mux-interface.js';
import type { Session as SessionType } from '../src/session.js';
import type { TmuxManager as ManagerType } from '../src/tmux-manager.js';

const effects = vi.hoisted(() => ({ sync: vi.fn(), exec: vi.fn(), attach: vi.fn() }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const refused = () => {
    throw new Error('Unmocked process effects forbidden');
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
vi.mock('node-pty', () => ({ spawn: effects.attach }));
let TmuxManager: typeof import('../src/tmux-manager.js').TmuxManager;
let Session: typeof import('../src/session.js').Session;
let root: string;
let metadata: string;
let previousData: string | undefined;
const sessions: SessionType[] = [];
const managers: ManagerType[] = [];
const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const THREAD = '11111111-2222-3333-4444-555555555555';
const config = {
  noDaemon: true,
  model: 'fixture-model',
  sandbox: 'read-only',
  approvalPolicy: 'on-request',
  resumeSessionId: THREAD,
} as const;
beforeAll(async () => {
  root = mkdtempSync(join(homedir(), 'native-reboot-uncertainty-'));
  metadata = join(root, 'mux-sessions.json');
  previousData = process.env.CODEMAN_DATA_DIR;
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
beforeEach(() => {
  effects.sync.mockReset().mockReturnValue('99999\n');
  effects.exec.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
  effects.attach.mockReset().mockReturnValue({
    pid: 0,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
  });
  rmSync(metadata, { force: true });
});
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.stop(false);
  for (const manager of managers.splice(0)) await Reflect.get(manager, 'sessionSaves');
  vi.restoreAllMocks();
});
afterAll(() => {
  if (previousData === undefined) delete process.env.CODEMAN_DATA_DIR;
  else process.env.CODEMAN_DATA_DIR = previousData;
  rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const home = join(root, 'codex-home');
  mkdirSync(home, { recursive: true });
  const manager = Object.create(TmuxManager.prototype) as ManagerType;
  Reflect.set(manager, 'sessions', new Map());
  Reflect.set(manager, 'sessionSaves', Promise.resolve());
  Reflect.set(manager, 'tmuxSocket', 'fixture-socket');
  Reflect.set(manager, 'paneExits', new Map());
  Reflect.set(manager, 'paneExitGeneration', 0);
  Reflect.set(manager, 'reconnectState', new Map());
  Reflect.set(manager, 'reconnectGuard', new Map());
  Reflect.set(manager, 'remoteAliveCache', new Map());
  Reflect.set(manager, 'remoteAliveInFlight', new Map());
  managers.push(manager);
  vi.spyOn(manager, 'isAvailable').mockReturnValue(true);
  vi.spyOn(manager, 'resizeWindow').mockImplementation(() => {});
  vi.spyOn(
    manager as unknown as { buildPathExport(): { pathExport: string; dir: string } },
    'buildPathExport'
  ).mockReturnValue({ pathExport: '', dir: '/fixture/bin' });
  vi.spyOn(manager as unknown as { _configureCliEnv(): void }, '_configureCliEnv').mockImplementation(() => {});
  vi.spyOn(
    manager as unknown as { _configureStatusLineUserCommand(): void },
    '_configureStatusLineUserCommand'
  ).mockImplementation(() => {});
  vi.spyOn(manager as unknown as { supportsLiveHistoryResize(): boolean }, 'supportsLiveHistoryResize').mockReturnValue(
    true
  );
  return { manager, home };
}

describe('native uncertain Codex reboot ownership', () => {
  it.each(['lost-receipt', 'unknown-pid'] as const)(
    'preserves original durable identity when worker launch has %s',
    async (failure) => {
      const { manager, home } = fixture();
      const dispatch = vi.fn();
      effects.sync.mockImplementation((command: string) => {
        if (command.includes(' respawn-pane ')) {
          const [saved] = JSON.parse(readFileSync(metadata, 'utf8'));
          expect(saved).toMatchObject({
            sessionId: ID,
            muxName: 'codeman-aaaaaaaa',
            owner: 'worker',
            workingDir: root,
            name: 'Original worker',
            recoveryCodexHome: home,
            codexRestoreUncertain: true,
            codexRestoreConfig: config,
          });
          if (failure === 'lost-receipt') throw new Error('Fixture receipt lost after dispatch');
        }
        return '99999\n';
      });
      if (failure === 'unknown-pid')
        vi.spyOn(manager as unknown as { getPanePid(name: string): number | null }, 'getPanePid').mockReturnValue(null);
      await expect(
        manager.createSession({
          sessionId: ID,
          owner: 'worker',
          workingDir: root,
          name: 'Original worker',
          mode: 'codex',
          codexConfig: config,
          recoveryCodexHome: home,
          codexRestoreGuard: { prepare: async () => {}, confirm: () => true, noteDispatch: dispatch },
        })
      ).rejects.toThrow();
      expect(dispatch).toHaveBeenCalledOnce();
      expect(manager.getSession(ID)).toMatchObject({
        sessionId: ID,
        pid: 0,
        codexRestoreUncertain: true,
        codexRestoreConfig: config,
      });
      expect(effects.sync.mock.calls.filter(([command]) => command.includes(' respawn-pane '))).toHaveLength(1);
      expect(effects.sync.mock.calls.some(([command]) => command.includes(' kill-session '))).toBe(false);
      expect(JSON.parse(readFileSync(metadata, 'utf8'))[0].sessionId).toBe(ID);
      const session = new Session({
        id: ID,
        mode: 'codex',
        owner: 'worker',
        workingDir: root,
        useMux: true,
        mux: manager,
        muxSession: manager.getSession(ID),
        codexConfig: { noDaemon: true },
        recoveryCodexHome: home,
      });
      sessions.push(session);
      expect(session.claudeSessionId).toBe(THREAD);
      expect(session.getRecoveryContext()).toMatchObject({ managed: false, codexHome: home, switchPending: true });
    }
  );

  it('removes only its owned inert shell when authority is refused before worker dispatch', async () => {
    const { manager, home } = fixture();
    let prepares = 0;
    const dispatch = vi.fn();
    await expect(
      manager.createSession({
        sessionId: ID,
        workingDir: root,
        mode: 'codex',
        codexConfig: config,
        recoveryCodexHome: home,
        codexRestoreGuard: {
          prepare: async () => {
            prepares++;
          },
          confirm: () => prepares < 2,
          noteDispatch: dispatch,
        },
      })
    ).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
    expect(effects.sync.mock.calls.some(([command]) => command.includes(' respawn-pane '))).toBe(false);
    expect(effects.sync.mock.calls.filter(([command]) => command.includes(' kill-session '))).toHaveLength(1);
    expect(manager.getSession(ID)).toBeUndefined();
    expect(JSON.parse(readFileSync(metadata, 'utf8'))).toEqual([]);
  });

  it.each(['{truncated', '{"unexpected":"object"}'])(
    'preserves unreadable mux metadata and refuses dispatch: %s',
    async (damaged) => {
      const { manager, home } = fixture();
      writeFileSync(metadata, damaged);
      const dispatch = vi.fn();
      await expect(
        manager.createSession({
          sessionId: ID,
          workingDir: root,
          mode: 'codex',
          codexConfig: config,
          recoveryCodexHome: home,
          codexRestoreGuard: { prepare: async () => {}, confirm: () => true, noteDispatch: dispatch },
        })
      ).rejects.toThrow();
      expect(dispatch).not.toHaveBeenCalled();
      expect(effects.sync.mock.calls.some(([command]) => command.includes(' respawn-pane '))).toBe(false);
      expect(effects.sync.mock.calls.filter(([command]) => command.includes(' kill-session '))).toHaveLength(1);
      expect(manager.getSession(ID)).toBeUndefined();
      expect(readFileSync(metadata, 'utf8')).toBe(damaged);
    }
  );

  it.each(['exact', 'different-home', 'different-config', 'absent'] as const)(
    'adopts only matching original launch metadata after receipt loss: %s',
    async (metadataKind) => {
      const { manager, home } = fixture();
      effects.sync.mockImplementation((command: string) => {
        if (command.includes(' respawn-pane ')) throw new Error('Fixture receipt lost after dispatch');
        return '99999\n';
      });
      const session = new Session({
        id: ID,
        mode: 'codex',
        owner: 'worker',
        name: 'Original worker',
        workingDir: root,
        useMux: true,
        mux: manager,
        codexConfig: config,
        recoveryCodexHome: home,
      });
      sessions.push(session);
      session.setCodexRestoreLaunchGuard({ prepare: async () => {}, confirm: () => true });
      await expect(session.startInteractive()).rejects.toThrow();
      expect(session.codexRestoreWorkerMayExist).toBe(true);
      const record = manager.getSession(ID)!;
      expect(record.sessionId).toBe(ID);
      if (metadataKind === 'different-home') record.recoveryCodexHome = join(root, 'different-home');
      if (metadataKind === 'different-config') record.codexRestoreConfig = { ...config, model: 'different-model' };
      if (metadataKind === 'absent') Reflect.get(manager, 'sessions').delete(ID);
      expect(session.adoptUncertainCodexRestore()).toBe(metadataKind === 'exact');
      expect(session.getRecoveryContext().managed).toBe(false);
      if (metadataKind === 'exact') {
        expect(session.getRecoveryContext()).toMatchObject({ switchPending: true, untrackedInput: true });
        expect(manager.getSession(ID)).toMatchObject({
          sessionId: ID,
          name: 'Original worker',
          recoveryCodexHome: home,
          codexRestoreConfig: config,
          codexRestoreUncertain: true,
        });
      }
      // Exact adoption permits inspection of the existing pane, while refused
      // adoption never becomes another launch.
      if (metadataKind === 'exact') {
        vi.spyOn(manager, 'muxSessionExists').mockReturnValue(true);
        vi.spyOn(manager, 'isPaneDead').mockReturnValue(false);
        await session.startInteractive();
        expect(effects.attach).toHaveBeenCalledOnce();
      } else await expect(session.startInteractive()).rejects.toThrow();
      expect(effects.sync.mock.calls.filter(([command]) => command.includes(' respawn-pane '))).toHaveLength(1);
      expect(effects.sync.mock.calls.some(([command]) => command.includes(' kill-session '))).toBe(false);
    }
  );

  it.each(['live', 'dead', 'missing'] as const)(
    'owner inspection of an uncertain %s pane never launches or respawns a worker',
    async (pane) => {
      const { manager, home } = fixture();
      const record: MuxSession = {
        sessionId: ID,
        muxName: 'codeman-aaaaaaaa',
        pid: 0,
        createdAt: Date.now(),
        workingDir: root,
        mode: 'codex',
        owner: 'worker',
        attached: false,
        recoveryCodexHome: home,
        recoveryIsolated: false,
        codexRestoreUncertain: true,
        codexRestoreConfig: config,
      };
      manager.registerSession(record);
      vi.spyOn(manager, 'muxSessionExists').mockReturnValue(pane !== 'missing');
      vi.spyOn(manager, 'isPaneDead').mockReturnValue(pane === 'dead');
      const create = vi.spyOn(manager, 'createSession');
      const respawn = vi.spyOn(manager, 'respawnPane');
      const session = new Session({
        id: ID,
        mode: 'codex',
        owner: 'worker',
        workingDir: root,
        useMux: true,
        mux: manager,
        muxSession: record,
        codexConfig: config,
        recoveryCodexHome: home,
      });
      sessions.push(session);
      if (pane === 'missing') await expect(session.startInteractive()).rejects.toThrow();
      else await session.startInteractive();
      expect(create).not.toHaveBeenCalled();
      expect(respawn).not.toHaveBeenCalled();
      expect(
        effects.sync.mock.calls.some(
          ([command]) =>
            command.includes(' respawn-pane ') ||
            command.includes(' new-session ') ||
            command.includes(' kill-session ')
        )
      ).toBe(false);
      expect(session.codexRestoreWorkerMayExist).toBe(true);
    }
  );

  it.each(['empty', 'failed'] as const)(
    'reconciliation retains uncertain identity when the pane listing is %s',
    async (listing) => {
      const { manager, home } = fixture();
      const record: MuxSession = {
        sessionId: ID,
        muxName: 'codeman-aaaaaaaa',
        pid: 0,
        createdAt: Date.now(),
        workingDir: root,
        mode: 'codex',
        owner: 'worker',
        attached: false,
        recoveryCodexHome: home,
        codexRestoreUncertain: true,
        codexRestoreConfig: config,
      };
      manager.registerSession(record);
      const other = { ...record, sessionId: 'ordinary', muxName: 'codeman-ordinary', codexRestoreUncertain: false };
      manager.registerSession(other);
      await manager.flushSessionsDurably();
      effects.sync.mockImplementation(() => {
        if (listing === 'failed') throw new Error('Fixture pane listing unavailable');
        return '';
      });
      const died = vi.fn();
      manager.on('sessionDied', died);
      await manager.reconcileSessions();
      expect(manager.getSession(ID)).toBe(record);
      expect(manager.getSession(other.sessionId)).toBeUndefined();
      expect(died).toHaveBeenCalledExactlyOnceWith({ sessionId: other.sessionId });
      await manager.flushSessionsDurably();
      expect(JSON.parse(readFileSync(metadata, 'utf8'))).toEqual([record]);
      expect(effects.sync.mock.calls).toHaveLength(1);
    }
  );
});
