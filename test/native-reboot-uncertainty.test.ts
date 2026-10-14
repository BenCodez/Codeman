/** @fileoverview Native launch branches with injected child/PTY effects and temporary metadata. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MuxSession } from '../src/mux-interface.js';
import type { Session as SessionType } from '../src/session.js';
import type { TmuxManager as ManagerType } from '../src/tmux-manager.js';
import type { WebServer as ServerType } from '../src/web/server.js';
import type { SessionState } from '../src/types.js';
import { rebootStateBinding } from '../src/recovery/reboot-state-binding.js';

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
let WebServer: typeof import('../src/web/server.js').WebServer;
let root: string;
let metadata: string;
let previousData: string | undefined;
const sessions: SessionType[] = [];
const managers: ManagerType[] = [];
const servers: ServerType[] = [];
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
    ({ WebServer } = await import('../src/web/server.js'));
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
  for (const server of servers.splice(0)) await server.stop();
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

  it.each([
    'empty',
    'other-live',
    'own-live',
    'failed',
    'malformed',
    'truncated',
    'invalid-exit',
    'invalid-pid',
    'nul-name',
    'control-name',
    'missing-final-newline',
    'blank-line',
    'crlf',
  ] as const)('retires uncertain identity only after a complete pane listing proves absence (%s)', async (listing) => {
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
    await manager.flushSessionsDurably();
    const sep = '|'; // Exact native PANE_LIST_FORMAT separator.
    const valid = (name: string, pid: string) => [name, pid, '0', '', ''].join(sep) + '\n';
    effects.sync.mockImplementation((command: string) => {
      expect(command).not.toContain('|| true');
      if (listing === 'failed') throw new Error('Fixture pane listing unavailable');
      return listing === 'empty'
        ? ''
        : listing === 'other-live'
          ? valid('codeman-other', '123')
          : listing === 'own-live'
            ? valid(record.muxName, '700')
            : listing === 'malformed'
              ? 'not-a-pane-frame\n'
              : listing === 'truncated'
                ? 'x'.repeat(600 * 1024)
                : listing === 'invalid-exit'
                  ? [record.muxName, '700', '0', '0', ''].join(sep) + '\n'
                  : listing === 'invalid-pid'
                    ? valid(record.muxName, '700junk')
                    : listing === 'nul-name'
                      ? valid('codeman-other\0', '123')
                      : listing === 'control-name'
                        ? valid('codeman-other\t', '123')
                        : listing === 'missing-final-newline'
                          ? valid('codeman-other', '123').slice(0, -1)
                          : listing === 'blank-line'
                            ? valid('codeman-other', '123') + '\n'
                            : valid('codeman-other', '123').replace(/\n$/, '\r\n');
    });
    const died = vi.fn();
    manager.on('sessionDied', died);
    const result = await manager.reconcileSessions();
    const absent = listing === 'empty' || listing === 'other-live';
    expect(manager.getSession(ID)).toBe(absent ? undefined : record);
    if (absent) {
      expect(result.dead).toContain(ID);
      expect(died).toHaveBeenCalledExactlyOnceWith({ sessionId: ID });
    } else {
      expect(result.dead).not.toContain(ID);
      expect(died).not.toHaveBeenCalled();
      expect(record.pid).toBe(listing === 'own-live' ? 700 : 0);
      expect(record.codexRestoreUncertain).toBe(true);
      expect(record.codexRestoreConfig).toEqual(config);
      expect(record.recoveryCodexHome).toBe(home);
    }
    await manager.flushSessionsDurably();
    const persisted = JSON.parse(readFileSync(metadata, 'utf8')) as MuxSession[];
    expect(persisted.some((saved) => saved.sessionId === ID)).toBe(!absent);
    expect(effects.sync.mock.calls).toHaveLength(1);
  });

  it.each(['failed', 'malformed', 'truncated', 'healthy', 'absent'] as const)(
    'rebuilds a completed bound worker for inspection without pruning history after a %s listing',
    async (listing) => {
      const { manager, home } = fixture();
      const state: SessionState & { __codexRecoveryHome: string; __envOverrides: Record<string, string> } = {
        id: ID,
        mode: 'codex',
        owner: 'worker',
        workingDir: root,
        pid: 700,
        status: 'idle',
        currentTaskId: null,
        createdAt: Date.now() - 60_000,
        name: 'Historical bound worker',
        codexConfig: { ...config },
        __codexRecoveryHome: home,
        __envOverrides: { CODEX_HOME: home },
      };
      const binding = rebootStateBinding(state)!;
      expect(binding).toMatch(/^[a-f0-9]{64}$/);
      const record: MuxSession = {
        sessionId: ID,
        muxName: 'codeman-aaaaaaaa',
        pid: 700,
        createdAt: state.createdAt,
        workingDir: root,
        mode: 'codex',
        owner: 'worker',
        attached: false,
        name: state.name,
        recoveryCodexHome: home,
        recoveryIsolated: true,
        codexRestoreUncertain: false,
        codexRestoreConfig: { ...config },
        codexRestoreStateBinding: binding,
      };
      manager.registerSession(record);
      await manager.flushSessionsDurably();
      vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);
      const server = new WebServer(0, false, true);
      servers.push(server);
      Reflect.set(server, 'mux', manager);
      const store = Reflect.get(server, 'store') as import('../src/state-store.js').StateStore;
      store.setSession(ID, state);
      store.flush();
      const historical = structuredClone(store.getSession(ID));
      vi.spyOn(
        server as unknown as { getWorkspaceHooksEnabled(): Promise<boolean> },
        'getWorkspaceHooksEnabled'
      ).mockResolvedValue(false);
      for (const method of [
        'startStatsCollection',
        'startMouseModeSync',
        'startPaneExitWatcher',
        'startRemoteReconnectWatcher',
        'destroy',
      ] as const)
        vi.spyOn(manager, method).mockImplementation(() => {});
      const create = vi.spyOn(manager, 'createSession');
      const respawn = vi.spyOn(manager, 'respawnPane');
      const kill = vi.spyOn(manager, 'killSession');
      vi.spyOn(manager, 'muxSessionExists').mockReturnValue(listing !== 'absent');
      vi.spyOn(manager, 'isPaneDead').mockReturnValue(false);
      effects.sync.mockImplementation((command: string) => {
        expect(command).toContain(' list-panes ');
        if (listing === 'failed') throw new Error('Fixture native listing unavailable');
        return listing === 'malformed'
          ? 'not-a-pane-frame\n'
          : listing === 'truncated'
            ? 'codeman-aaaaaaaa|700|0||'
            : listing === 'absent'
              ? ''
              : 'codeman-aaaaaaaa|700|0||\n';
      });
      let reconciliation: Awaited<ReturnType<ManagerType['reconcileSessions']>> | undefined;
      const reconcile = manager.reconcileSessions.bind(manager);
      vi.spyOn(manager, 'reconcileSessions').mockImplementation(async () => {
        reconciliation = await reconcile();
        return reconciliation;
      });
      const restored = await Reflect.get(server, 'restoreMuxSessions').call(server);
      const board = Reflect.get(server, 'sessions') as Map<string, SessionType>;
      const worker = board.get(ID);
      if (worker) sessions.push(worker);
      await Reflect.get(server, 'finalizeRestoredState').call(server, restored);
      const uncertain = !['healthy', 'absent'].includes(listing);
      expect(restored).toBe(true);
      expect(create).not.toHaveBeenCalled();
      expect(respawn).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
      if (listing === 'absent') {
        expect(worker).toBeUndefined();
        expect(manager.getSession(ID)).toBeUndefined();
        expect(reconciliation?.dead).toEqual([ID]);
      } else {
        expect(worker).toBeDefined();
        expect(manager.getSession(ID)).toBe(record);
        expect(record.codexRestoreUncertain).toBe(uncertain);
        expect(record.codexRestoreStateBinding).toBe(binding);
        expect(record.codexRestoreConfig).toEqual(config);
        expect(worker!.codexRestoreWorkerMayExist).toBe(uncertain);
        expect(worker!.getRecoveryContext().managed).toBe(!uncertain);
        expect(reconciliation).toEqual({ alive: uncertain ? [] : [ID], dead: [], discovered: [] });
        if (uncertain) {
          expect(store.getSession(ID)).toEqual(historical);
          const disk = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
          expect(disk.sessions[ID]).toEqual(historical);
        }
        await manager.flushSessionsDurably();
        const saved = JSON.parse(readFileSync(metadata, 'utf8')).find((row: MuxSession) => row.sessionId === ID);
        expect(saved).toMatchObject({
          codexRestoreUncertain: uncertain,
          codexRestoreStateBinding: binding,
          codexRestoreConfig: config,
        });
      }
    }
  );

  it.each([
    'sent',
    'lost-receipt',
    'revoked-before',
    'revoked-during-retirement',
    'retirement-file-failure',
    'record-replaced',
  ] as const)('retires a previous reboot binding before any later native respawn effect (%s)', async (outcome) => {
    const { manager, home } = fixture();
    const record: MuxSession = {
      sessionId: ID,
      muxName: 'codeman-aaaaaaaa',
      pid: 700,
      createdAt: Date.now(),
      workingDir: root,
      mode: 'codex',
      owner: 'worker',
      attached: false,
      recoveryCodexHome: home,
      recoveryIsolated: true,
      codexRestoreUncertain: false,
      codexRestoreConfig: config,
      codexRestoreStateBinding: 'a'.repeat(64),
    };
    manager.registerSession(record);
    await manager.flushSessionsDurably();
    let authorized = outcome !== 'revoked-before';
    const flush = manager.flushSessionsDurably.bind(manager);
    if (outcome === 'revoked-during-retirement')
      vi.spyOn(manager, 'flushSessionsDurably').mockImplementationOnce(async (current) => {
        await flush(current);
        authorized = false;
      });
    if (outcome === 'retirement-file-failure')
      vi.spyOn(manager, 'flushSessionsDurably').mockRejectedValueOnce(new Error('Fixture metadata fsync refused'));
    let replacement: MuxSession | undefined;
    if (outcome === 'record-replaced')
      vi.spyOn(manager, 'flushSessionsDurably').mockImplementationOnce(async (current) => {
        await flush(current);
        replacement = {
          ...record,
          codexRestoreStateBinding: 'b'.repeat(64),
          codexRestoreConfig: { ...config, model: 'replacement-model' },
        };
        manager.registerSession(replacement);
      });
    effects.exec.mockImplementation(async (command: string) => {
      if (command.includes(' respawn-pane ')) {
        const saved = JSON.parse(readFileSync(metadata, 'utf8')).find((row: MuxSession) => row.sessionId === ID);
        expect(saved.codexRestoreStateBinding).toBeUndefined();
        expect(saved.codexRestoreConfig).toBeUndefined();
        expect(saved.recoveryCodexHome).toBe(home);
        if (outcome === 'lost-receipt') throw new Error('Fixture response lost after respawn');
      }
      return { stdout: '', stderr: '' };
    });
    const result = await manager.respawnPane({
      sessionId: ID,
      workingDir: root,
      mode: 'codex',
      owner: 'worker',
      codexConfig: { ...config, model: 'new-owner-model' },
      recoveryCodexHome: home,
      onlyIfDead: true,
      recoveryDispatchGuard: { confirm: () => authorized, noteDispatch: vi.fn() },
    });
    expect(result).toBe(outcome === 'sent' ? 99999 : null);
    expect(effects.exec.mock.calls.filter(([command]) => String(command).includes(' respawn-pane '))).toHaveLength(
      outcome === 'sent' || outcome === 'lost-receipt' ? 1 : 0
    );
    if (['revoked-before', 'revoked-during-retirement', 'retirement-file-failure'].includes(outcome)) {
      await manager.flushSessionsDurably();
      const saved = JSON.parse(readFileSync(metadata, 'utf8')).find((row: MuxSession) => row.sessionId === ID);
      expect(saved.codexRestoreStateBinding).toBe('a'.repeat(64));
      expect(saved.codexRestoreConfig).toEqual(config);
      expect(record.codexRestoreStateBinding).toBe('a'.repeat(64));
      expect(record.codexRestoreConfig).toEqual(config);
    } else {
      expect(record.codexRestoreStateBinding).toBeUndefined();
      expect(record.codexRestoreConfig).toBeUndefined();
      if (outcome === 'record-replaced') {
        expect(manager.getSession(ID)).toBe(replacement);
        expect(replacement!.codexRestoreStateBinding).toBe('b'.repeat(64));
        expect(replacement!.codexRestoreConfig!.model).toBe('replacement-model');
      }
    }
  });

  it.each([false, true])('honors explicit owner stop(killMux=%s) for an uncertain worker', async (killMux) => {
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
    const kill = vi.spyOn(manager, 'killSession').mockResolvedValue(true);
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
    await session.stop(killMux);
    expect(kill).toHaveBeenCalledTimes(killMux ? 1 : 0);
    if (killMux) expect(kill).toHaveBeenCalledWith(ID);
    else expect(manager.getSession(ID)).toBe(record);
    expect(effects.sync).not.toHaveBeenCalled();
    expect(effects.attach).not.toHaveBeenCalled();
  });
});
