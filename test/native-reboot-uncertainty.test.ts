/** @fileoverview Native launch branches with injected child/PTY effects and temporary metadata. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { CodexInputBroker } from '../src/recovery/codex-input-broker.js';
import type { CodexRestoreLaunchGuard } from '../src/mux-interface.js';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { planVerifiedRebootRestore } from '../src/reboot-restore.js';
import { rebootRestoreRegistry } from '../src/web/reboot-restore-registry.js';
import type { registerRebootRestoreRoutes as RegisterRebootRestoreRoutes } from '../src/web/routes/reboot-restore-routes.js';
let registerRebootRestoreRoutes: typeof RegisterRebootRestoreRoutes;
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import type { MuxSession } from '../src/mux-interface.js';
import type { Session as SessionType } from '../src/session.js';
import type { TmuxManager as ManagerType } from '../src/tmux-manager.js';
import type { WebServer as ServerType } from '../src/web/server.js';
import type { SessionState } from '../src/types.js';
import { fakeInputProvenance } from './helpers/codex-input-provenance.js';
import { rebootStateBinding } from '../src/recovery/reboot-state-binding.js';
import { createUser, updateUser, invalidateUsersCache } from '../src/user-store.js';
import { getCli, reloadCliRegistry } from '../src/config/cli-registry/registry.js';
import { captureRebootBrokerBindings } from '../src/recovery/reboot-launch-witness.js';

const effects = vi.hoisted(() => ({
  sync: vi.fn(),
  exec: vi.fn(),
  attach: vi.fn(),
  python: undefined as typeof import('node:child_process').spawn | undefined,
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  effects.python = actual.spawn;
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
    ({ registerRebootRestoreRoutes } = await import('../src/web/routes/reboot-restore-routes.js'));
  } finally {
    if (vitest !== undefined) process.env.VITEST = vitest;
  }
});
beforeEach(() => {
  effects.sync.mockReset().mockImplementation(nativeOutput);
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
  rmSync(join(root, 'reboot-identities', `${ID}.json`), { force: true });
});
afterEach(async () => {
  rebootRestoreRegistry.reset();
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

function nativeOutput(command: string): string {
  if (command.includes(' new-session ')) return '$1|%7|99999|88\n';
  if (command.includes('CODEMAN_OPTIONAL_BROKER_DISPATCHED'))
    return 'CODEMAN_OPTIONAL_BROKER_DISPATCHED|$1|%7|99999|88\n';
  if (command.includes('respawn-pane ') || command.includes('kill-pane ')) return '';
  return '99999\n';
}

function fixture(workerCommand = 'unused fake worker') {
  const home = join(root, 'codex-home');
  mkdirSync(home, { recursive: true });
  const manager = Object.create(TmuxManager.prototype) as ManagerType;
  Reflect.set(manager, 'sessions', new Map());
  Reflect.set(manager, 'inputBrokers', new Map());
  Reflect.set(manager, 'inputBrokerLoads', new Map());
  Reflect.set(manager, 'inputQueues', new Map());
  Reflect.set(manager, 'sessionSaves', Promise.resolve());
  Reflect.set(manager, 'tmuxSocket', 'fixture-socket');
  Reflect.set(manager, 'paneExits', new Map());
  Reflect.set(manager, 'paneExitGeneration', 0);
  Reflect.set(manager, 'reconnectState', new Map());
  Reflect.set(manager, 'reconnectGuard', new Map());
  Reflect.set(manager, 'remoteAliveCache', new Map());
  Reflect.set(manager, 'remoteAliveInFlight', new Map());
  let broker: Promise<CodexInputBroker> | undefined;
  const getBroker = () =>
    (broker ??= CodexInputBroker.create(join(root, randomUUID()), ID, workerCommand, home).then((value) => {
      vi.spyOn(value, 'startupReceipt').mockResolvedValue('started');
      return value;
    }));
  vi.spyOn(
    manager as unknown as { createInputBroker(): Promise<CodexInputBroker> },
    'createInputBroker'
  ).mockImplementation(getBroker);
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
  return { manager, home, getBroker };
}

function healthyGuard(): CodexRestoreLaunchGuard {
  return {
    prepare: async () => {},
    confirm: () => true,
    isCurrent: () => true,
    getStartupEvidence: () => ({ files: [], paths: [], missing: [] }),
  };
}

describe('native uncertain Codex reboot ownership', () => {
  it('does not durably reserve or dispatch a worker when asynchronous confirmation lacks a pure current guard', async () => {
    const { manager, home } = fixture();
    const confirm = vi.fn(async () => true);
    const guard = healthyGuard();
    delete guard.isCurrent;
    guard.confirm = confirm;
    const acknowledgedSnapshots: string[] = [];
    const flush = manager.flushSessionsDurably.bind(manager);
    vi.spyOn(manager, 'flushSessionsDurably').mockImplementation(async (...args) => {
      await flush(...args);
      acknowledgedSnapshots.push(readFileSync(metadata, 'utf8'));
    });
    writeFileSync(metadata, '[]');
    const original = readFileSync(metadata, 'utf8');
    await expect(
      manager.createSession({
        sessionId: ID,
        workingDir: root,
        mode: 'codex',
        codexConfig: config,
        recoveryCodexHome: home,
        codexRestoreGuard: guard,
      })
    ).rejects.toThrow();
    expect(readFileSync(metadata, 'utf8')).toBe(original);
    expect(acknowledgedSnapshots.every((snapshot) => !snapshot.includes(ID))).toBe(true);
    expect(effects.sync.mock.calls.some(([command]) => command.includes('respawn-pane '))).toBe(false);
  });

  it.each(['before-dispatch', 'no-child-receipt', 'unproven-creation', 'create-ack-lost'] as const)(
    'the actual restore route preserves history and inspection after uncertain native cleanup: %s',
    async (phase) => {
      const { manager, home, getBroker } = fixture();
      const broker = await getBroker();
      mkdirSync(join(home, 'sessions'), { recursive: true });
      writeFileSync(
        join(home, 'sessions', `rollout-2026-10-13T15-00-00-${THREAD}.jsonl`),
        JSON.stringify({
          type: 'session_meta',
          timestamp: '2026-10-13T15:00:00Z',
          payload: { id: THREAD, cwd: root, originator: `codeman_${ID}` },
        }) + '\n'
      );
      vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);
      const server = new WebServer(0, false, true);
      servers.push(server);
      Reflect.set(server, 'mux', manager);
      for (const method of [
        'startStatsCollection',
        'startMouseModeSync',
        'startPaneExitWatcher',
        'startRemoteReconnectWatcher',
        'destroy',
      ] as const)
        vi.spyOn(manager, method).mockImplementation(() => {});
      const board = Reflect.get(server, 'sessions') as Map<string, SessionType>;
      let nativeCurrent = true;
      if (phase === 'before-dispatch') {
        const original = broker.setStartupAuthority.bind(broker);
        vi.spyOn(broker, 'setStartupAuthority').mockImplementation(async (...args) => {
          await original(...args);
          await board.get(ID)!.fenceUntrackedInput();
          nativeCurrent = false;
        });
      } else if (phase === 'no-child-receipt')
        vi.mocked(broker.startupReceipt).mockImplementation(async () => {
          nativeCurrent = false;
          return 'not-sent';
        });
      effects.sync.mockImplementation((command: string) => {
        if (phase === 'create-ack-lost' && command.includes(' new-session ')) throw Error('Inert pane create ACK lost');
        if (phase === 'unproven-creation' && command.includes(' new-session ')) return 'incomplete native tuple';
        if (command.includes('kill-pane ')) {
          expect(nativeCurrent).toBe(false);
          return 'CODEMAN_REBOOT_CLEANUP_REFUSED\n';
        }
        return nativeOutput(command);
      });
      const state: SessionState = {
        id: ID,
        mode: 'codex',
        pid: 1234,
        status: 'idle',
        workingDir: root,
        currentTaskId: null,
        createdAt: Date.now() - 60_000,
        codexConfig: config,
      };
      Object.assign(state, { __codexRecoveryHome: home, __envOverrides: { CODEX_HOME: home } });
      const store = Reflect.get(server, 'store') as import('../src/state-store.js').StateStore;
      store.setSession(ID, state);
      store.flush();
      const historical = structuredClone(store.getSession(ID));
      const plan = await planVerifiedRebootRestore([ID], { [ID]: state }, async () => ({
        status: 'present' as const,
        dev: 1,
        ino: 1,
      }));
      expect(plan.skipped).toEqual([]);
      await rebootRestoreRegistry.set(plan.restore);
      const ctx = Reflect.get(server, 'createRouteContext').call(server) as Parameters<
        typeof registerRebootRestoreRoutes
      >[1];
      ctx.getWorkspaceHooksEnabled = async () => false;
      ctx.getAgentSkillEnabled = async () => false;
      const app = Fastify({ logger: false });
      await app.register(fastifyCookie);
      registerRebootRestoreRoutes(app, ctx);
      installRouteErrorHandler(app);
      await app.ready();
      const kill = vi.spyOn(manager, 'killSession');
      try {
        const response = await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          restored: [],
          skipped: [{ sessionId: ID, reason: 'restore-uncertain' }],
        });
        const session = board.get(ID)!;
        sessions.push(session);
        expect(session.codexRestoreWorkerMayExist).toBe(true);
        expect(store.getSession(ID)).toEqual(historical);
        expect(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')).sessions[ID]).toEqual(historical);
        expect(kill).not.toHaveBeenCalled();
        expect(effects.sync.mock.calls.some(([command]) => command.includes('kill-session '))).toBe(false);
      } finally {
        await app.close();
      }
    }
  );

  it.each(['before-dispatch', 'no-child-receipt'] as const)(
    'retains actual Server inspection instead of generic cleanup after native replacement: %s',
    async (phase) => {
      const { manager, home, getBroker } = fixture();
      const broker = await getBroker();
      let current = true;
      let nativeCurrent = true;
      if (phase === 'before-dispatch') {
        const original = broker.setStartupAuthority.bind(broker);
        vi.spyOn(broker, 'setStartupAuthority').mockImplementation(async (...args) => {
          await original(...args);
          current = false;
          nativeCurrent = false;
        });
      } else
        vi.mocked(broker.startupReceipt).mockImplementation(async () => {
          nativeCurrent = false;
          return 'not-sent';
        });
      effects.sync.mockImplementation((command: string) => {
        if (command.includes('kill-pane ')) {
          expect(nativeCurrent).toBe(false);
          return 'CODEMAN_REBOOT_CLEANUP_REFUSED\n';
        }
        return nativeOutput(command);
      });
      const session = new Session({
        id: ID,
        workingDir: root,
        owner: 'worker',
        mode: 'codex',
        useMux: true,
        mux: manager,
        codexConfig: config,
        recoveryCodexHome: home,
      });
      sessions.push(session);
      const noChild = vi.fn();
      session.setCodexRestoreLaunchGuard({ ...healthyGuard(), isCurrent: () => current, noteBrokerRefusal: noChild });
      await expect(session.startInteractive()).rejects.toThrow();
      expect(session.codexRestoreWorkerMayExist).toBe(true);
      expect(noChild).not.toHaveBeenCalled();
      const kill = vi.spyOn(manager, 'killSession');
      const server = new WebServer(0, false, true);
      servers.push(server);
      Reflect.set(server, 'mux', manager);
      for (const method of [
        'startStatsCollection',
        'startMouseModeSync',
        'startPaneExitWatcher',
        'startRemoteReconnectWatcher',
        'destroy',
      ] as const)
        vi.spyOn(manager, method).mockImplementation(() => {});
      const board = Reflect.get(server, 'sessions') as Map<string, SessionType>;
      board.set(ID, session);
      await server.discardPartiallyBuiltSession(ID, session, {
        preserveCustomModelConfigDir: true,
        preserveMuxPane: true,
        retainForInspection: true,
      });
      expect(board.get(ID)).toBe(session);
      expect(manager.getSession(ID)).toMatchObject({ codexRestoreUncertain: true });
      expect(kill).not.toHaveBeenCalled();
      expect(effects.sync.mock.calls.some(([command]) => command.includes('kill-session '))).toBe(false);
    }
  );

  it.each(['healthy', 'pane-replaced', 'session-replaced', 'server-restarted', 'extra-pane', 'extra-window'] as const)(
    'binds native launch and no-child cleanup to the atomically created single pane: %s',
    async (change) => {
      const { manager, home, getBroker } = fixture();
      const broker = await getBroker();
      const native = { session: '$1', pid: 99999, server: 88, panes: 1, windows: 1 };
      const original = broker.setStartupAuthority.bind(broker);
      vi.spyOn(broker, 'setStartupAuthority').mockImplementation(async (...args) => {
        await original(...args);
        if (change === 'pane-replaced') native.pid = 77777;
        if (change === 'session-replaced') native.session = '$2';
        if (change === 'server-restarted') native.server = 99;
        if (change === 'extra-pane') native.panes = 2;
        if (change === 'extra-window') native.windows = 2;
      });
      let workerEffects = 0;
      let cleanupEffects = 0;
      effects.sync.mockImplementation((command: string) => {
        if (command.includes('respawn-pane ') || command.includes('kill-pane ')) {
          expect(command).toContain("if-shell -F -t '%7'");
          for (const term of [
            '#{==:#{pid},88}',
            '#{==:#{session_id},$1}',
            '#{==:#{pane_id},%7}',
            '#{==:#{pane_pid},99999}',
            '#{==:#{window_panes},1}',
            '#{==:#{session_windows},1}',
          ])
            expect(command).toContain(term);
          const same =
            native.server === 88 &&
            native.session === '$1' &&
            native.pid === 99999 &&
            native.panes === 1 &&
            native.windows === 1;
          if (command.includes('respawn-pane ')) {
            if (same) workerEffects++;
            return same ? '' : 'CODEMAN_REBOOT_LAUNCH_REFUSED\n';
          }
          if (same) cleanupEffects++;
          return same ? '' : 'CODEMAN_REBOOT_CLEANUP_REFUSED\n';
        }
        return nativeOutput(command);
      });
      const refused = vi.fn();
      const launch = manager.createSession({
        sessionId: ID,
        workingDir: root,
        mode: 'codex',
        codexConfig: config,
        recoveryCodexHome: home,
        codexRestoreGuard: { ...healthyGuard(), noteBrokerRefusal: refused },
      });
      if (change === 'healthy') expect(await launch).toHaveProperty('pid', 99999);
      else {
        await expect(launch).rejects.toThrow('inert pane changed');
        expect(manager.getSession(ID)).toMatchObject({ pid: 0, codexRestoreUncertain: true });
      }
      expect(workerEffects).toBe(change === 'healthy' ? 1 : 0);
      expect(cleanupEffects).toBe(0);
      expect(refused).not.toHaveBeenCalled();
    }
  );

  it.each(['existing-session', 'malformed-created-tuple'] as const)(
    'never adopts or cleans an unproven new pane: %s',
    async (failure) => {
      const { manager, home } = fixture();
      effects.sync.mockImplementation((command: string) => {
        if (command.includes(' new-session ')) {
          if (failure === 'existing-session') throw new Error('Duplicate native session');
          return 'malformed native receipt';
        }
        return nativeOutput(command);
      });
      await expect(
        manager.createSession({
          sessionId: ID,
          workingDir: root,
          mode: 'codex',
          codexConfig: config,
          recoveryCodexHome: home,
          codexRestoreGuard: healthyGuard(),
        })
      ).rejects.toThrow();
      expect(
        effects.sync.mock.calls.some(([command]) => command.includes('respawn-pane ') || command.includes('kill-pane '))
      ).toBe(false);
      expect(manager.getSession(ID)).toBeUndefined();
    }
  );

  it.each([
    'healthy',
    'grant-changed',
    'rollout-changed',
    'fence-created',
    'config-replaced',
    'scope-changed',
    'deadline-expired',
  ] as const)('revalidates saved startup evidence inside the actual disposable broker: %s', async (outcome) => {
    const marker = join(root, `child-started-${randomUUID()}`);
    const { manager, home, getBroker } = fixture(`printf child > '${marker}'`);
    const broker = await getBroker();
    vi.mocked(broker.startupReceipt).mockRestore();
    const grant = join(root, `grant-${randomUUID()}`);
    const rollout = join(root, `rollout-${randomUUID()}`);
    const fence = join(root, `missing-fence-${randomUUID()}`);
    for (const path of [grant, rollout]) writeFileSync(path, 'initial', { mode: 0o600 });
    const files = [grant, rollout].map((path) => {
      const stat = statSync(path);
      return {
        path,
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
        maxBytes: 262_144,
      };
    });
    const directory = statSync(root);
    const paths = [{ path: root, dev: directory.dev, ino: directory.ino, kind: 'directory' as const }];
    let current = true;
    const setAuthority = broker.setStartupAuthority.bind(broker);
    const savedAuthority = vi.spyOn(broker, 'setStartupAuthority').mockImplementation(async (...args) => {
      await setAuthority(...args);
      if (outcome === 'scope-changed') current = false;
      if (outcome === 'deadline-expired') await new Promise((resolve) => setTimeout(resolve, 2_050));
    });
    let pid = 99999;
    let closed: Promise<number | null> | undefined;
    effects.sync.mockImplementation((command: string) => {
      if (command.includes('respawn-pane ')) {
        if (outcome === 'grant-changed') writeFileSync(grant, 'modified');
        if (outcome === 'rollout-changed') writeFileSync(rollout, 'new evidence');
        if (outcome === 'fence-created') writeFileSync(fence, 'cancelled');
        const digests = command.match(/[a-f0-9]{64}/g);
        expect(digests).toHaveLength(1);
        expect(digests![0]).toBe(broker.configurationDigest);
        if (outcome === 'config-replaced') {
          const path = join(broker.directory, 'config.json');
          const changed = JSON.parse(readFileSync(path, 'utf8'));
          changed.command = `printf wrong > '${marker}'`;
          changed.launchDigest = createHash('sha256').update(changed.command).digest('hex');
          changed.startup.privateFiles = [];
          writeFileSync(path, JSON.stringify(changed), { mode: 0o600 });
        }
        const child = effects.python!('python3', [join(broker.directory, 'broker.py'), broker.directory, digests![0]], {
          env: { ...process.env, CODEX_HOME: home },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        pid = child.pid!;
        child.stdout!.resume();
        child.stderr!.resume();
        closed = new Promise((resolve) => child.once('close', resolve));
      }
      if (command.includes('respawn-pane ')) return '';
      if (command.includes(' new-session ')) return '$1|%7|99999|88\n';
      if (command.includes('kill-pane ')) return '';
      return `${pid}\n`;
    });
    const dispatch = vi.fn();
    const refused = vi.fn();
    const confirm = vi.fn(() => true);
    const launch = manager.createSession({
      sessionId: ID,
      workingDir: root,
      mode: 'codex',
      codexConfig: config,
      recoveryCodexHome: home,
      codexRestoreGuard: {
        prepare: async () => {},
        confirm,
        isCurrent: () => current,
        getStartupEvidence: () => ({ files, paths, missing: [fence] }),
        noteDispatch: dispatch,
        noteBrokerRefusal: refused,
      },
    });
    if (outcome === 'healthy') {
      const record = await launch;
      expect(record).toMatchObject({ pid, recoveryInputBroker: broker.incarnation });
      expect(readFileSync(marker, 'utf8')).toBe('child');
    } else {
      await expect(launch).rejects.toThrow();
      expect(() => readFileSync(marker)).toThrow();
    }
    if (closed) await closed;
    expect(savedAuthority).toHaveBeenCalledOnce();
    expect(savedAuthority.mock.calls[0].slice(0, 4)).toEqual([files, undefined, paths, [fence]]);
    expect(confirm).toHaveBeenCalledTimes(5); // The queued metadata commit adds checks before and after its async I/O; none follow startup config persistence.
    expect(dispatch).toHaveBeenCalledTimes(['scope-changed', 'deadline-expired'].includes(outcome) ? 0 : 1);
    expect(refused).toHaveBeenCalledTimes(
      ['healthy', 'scope-changed', 'deadline-expired', 'config-replaced'].includes(outcome) ? 0 : 1
    );
    if (outcome === 'config-replaced')
      expect(manager.getSession(ID)).toMatchObject({
        recoveryInputBrokerPending: broker.incarnation,
        codexRestoreUncertain: true,
      });
    else if (outcome !== 'healthy') expect(manager.getSession(ID)).toBeUndefined();
  });

  it.each(['healthy', 'config-replaced'] as const)(
    'the actual respawn broker receives the final config digest and seals a changed config: %s',
    async (outcome) => {
      const marker = join(root, `respawn-marker-${randomUUID()}`);
      const { manager, home, getBroker } = fixture(`printf child > '${marker}'`);
      const broker = await getBroker();
      vi.mocked(broker.startupReceipt).mockRestore();
      const oldInc = randomUUID();
      const proof = fakeInputProvenance({ incarnation: oldInc, closed: true, exitStatus: 9 }, home);
      vi.spyOn(broker, 'prove').mockResolvedValue(proof);
      vi.spyOn(
        manager as unknown as { getInputBroker(): Promise<CodexInputBroker> },
        'getInputBroker'
      ).mockResolvedValue(broker);
      manager.registerSession({
        sessionId: ID,
        muxName: 'codeman-aaaaaaaa',
        pid: 700,
        createdAt: Date.now(),
        workingDir: root,
        mode: 'codex',
        attached: false,
        recoveryCodexHome: home,
        recoveryIsolated: true,
        recoveryInputBroker: oldInc,
      });
      await manager.flushSessionsDurably();
      const pristine = broker.configurationDigest;
      let pid = 700,
        closed: Promise<number | null> | undefined;
      effects.sync.mockImplementation(() => `${pid}\n`);
      effects.exec.mockImplementation(async (command: string) => {
        if (!command.includes('respawn-pane ')) return { stdout: '', stderr: '' };
        const digests = command.match(/[a-f0-9]{64}/g);
        expect(digests).toHaveLength(1);
        expect(digests![0]).toBe(broker.configurationDigest);
        expect(digests![0]).not.toBe(pristine);
        if (outcome === 'config-replaced') {
          const path = join(broker.directory, 'config.json');
          const changed = JSON.parse(readFileSync(path, 'utf8'));
          changed.command = `printf wrong > '${marker}'`;
          changed.launchDigest = createHash('sha256').update(changed.command).digest('hex');
          writeFileSync(path, JSON.stringify(changed), { mode: 0o600 });
        }
        const child = effects.python!('python3', [join(broker.directory, 'broker.py'), broker.directory, digests![0]], {
          env: { ...process.env, CODEX_HOME: home },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        pid = child.pid!;
        child.stdout!.resume();
        child.stderr!.resume();
        closed = new Promise((resolve) => child.once('close', resolve));
        return { stdout: '', stderr: '' };
      });
      const refused = vi.fn();
      const result = await manager.respawnPane({
        sessionId: ID,
        workingDir: root,
        mode: 'codex',
        codexConfig: config,
        recoveryCodexHome: home,
        onlyIfDead: true,
        expectedRecoveryPane: { paneId: '%7', panePid: 700, status: 9, inputProvenance: proof },
        recoveryDispatchGuard: {
          inputProof: proof,
          prepareEvidence: async () => true,
          confirm: () => true,
          noteDispatch: vi.fn(),
          noteBrokerRefusal: refused,
        },
      });
      if (closed) await closed;
      expect(refused).not.toHaveBeenCalled();
      if (outcome === 'healthy') {
        expect(result).toBe(pid);
        expect(readFileSync(marker, 'utf8')).toBe('child');
        expect(manager.getSession(ID)?.recoveryInputBrokerPending).toBeUndefined();
      } else {
        expect(result).toBeNull();
        expect(() => readFileSync(marker)).toThrow();
        expect(manager.getSession(ID)).toMatchObject({
          recoveryInputBrokerPending: broker.incarnation,
          codexRestoreUncertain: true,
        });
      }
    }
  );

  it.each(['not-sent', 'not-sent-replaced', 'unknown'] as const)(
    'retains uncertainty except for an exact %s receipt',
    async (status) => {
      const { manager, home, getBroker } = fixture();
      const broker = await getBroker();
      vi.mocked(broker.startupReceipt).mockImplementation(async () => {
        if (status === 'not-sent-replaced') manager.registerSession({ ...manager.getSession(ID)!, pid: 77777 });
        return status === 'unknown' ? 'unknown' : 'not-sent';
      });
      const refused = vi.fn();
      await expect(
        manager.createSession({
          sessionId: ID,
          workingDir: root,
          mode: 'codex',
          codexConfig: config,
          recoveryCodexHome: home,
          codexRestoreGuard: { ...healthyGuard(), noteBrokerRefusal: refused },
        })
      ).rejects.toThrow();
      expect(refused).toHaveBeenCalledTimes(status === 'not-sent' ? 1 : 0);
      if (status === 'unknown') {
        expect(manager.getSession(ID)).toMatchObject({
          pid: 99999,
          recoveryInputBroker: broker.incarnation,
          codexRestoreUncertain: true,
          codexRestoreConfig: config,
        });
        await manager.flushSessionsDurably();
        expect(JSON.parse(readFileSync(metadata, 'utf8'))[0]).toMatchObject({
          pid: 99999,
          recoveryInputBroker: broker.incarnation,
        });
      } else if (status === 'not-sent-replaced') expect(manager.getSession(ID)).toMatchObject({ pid: 77777 });
      else expect(manager.getSession(ID)).toBeUndefined();
      expect(effects.sync.mock.calls.filter(([command]) => command.includes('kill-pane '))).toHaveLength(
        status === 'not-sent' ? 1 : 0
      );
    }
  );

  it('requires the broker before creating even the inert restore pane when Python is unavailable', async () => {
    const { manager, home } = fixture();
    const create = vi
      .spyOn(manager as unknown as { createInputBroker(): Promise<CodexInputBroker> }, 'createInputBroker')
      .mockRejectedValue(new Error('Python unavailable'));
    const dispatch = vi.fn();
    await expect(
      manager.createSession({
        sessionId: ID,
        workingDir: root,
        mode: 'codex',
        codexConfig: config,
        recoveryCodexHome: home,
        codexRestoreGuard: { ...healthyGuard(), noteDispatch: dispatch },
      })
    ).rejects.toThrow();
    expect(create.mock.calls[0]).toHaveLength(4);
    expect(create.mock.calls[0][3]).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
    expect(effects.sync.mock.calls.some(([command]) => / (?:new-session|respawn-pane) /.test(command))).toBe(false);
  });

  it.each(['authorized', 'refused', 'throwing'] as const)(
    'awaits the final asynchronous launch proof before any worker effect: %s',
    async (outcome) => {
      const { manager, home } = fixture();
      let finish!: (value: boolean) => void;
      let fail!: (error: Error) => void;
      const held = new Promise<boolean>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      let confirmations = 0;
      const dispatch = vi.fn();
      const launch = manager.createSession({
        sessionId: ID,
        workingDir: root,
        mode: 'codex',
        codexConfig: config,
        recoveryCodexHome: home,
        codexRestoreGuard: {
          ...healthyGuard(),
          prepare: async () => {},
          confirm: () => (++confirmations === 3 ? held : true),
          noteDispatch: dispatch,
        },
      });
      const settled = launch.then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      );
      try {
        await vi.waitFor(() => expect(confirmations).toBe(3));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(dispatch).not.toHaveBeenCalled();
        expect(effects.sync.mock.calls.some(([command]) => command.includes('respawn-pane '))).toBe(false);
        if (outcome === 'throwing') fail(new Error('Fixture private proof unavailable'));
        else finish(outcome === 'authorized');
        const result = await settled;
        if (outcome === 'authorized') {
          expect(result).toHaveProperty('value');
          expect(dispatch).toHaveBeenCalledOnce();
          expect(effects.sync.mock.calls.filter(([command]) => command.includes('respawn-pane '))).toHaveLength(1);
        } else {
          expect(result).toHaveProperty('error');
          expect(dispatch).not.toHaveBeenCalled();
          expect(effects.sync.mock.calls.some(([command]) => command.includes('respawn-pane '))).toBe(false);
          expect(manager.getSession(ID)).toBeUndefined();
        }
      } finally {
        finish(false);
        await settled;
      }
    }
  );

  it('rechecks Session owner intent after an awaited launch proof', async () => {
    const { manager, home } = fixture();
    const session = new Session({
      id: ID,
      workingDir: root,
      mode: 'codex',
      useMux: true,
      mux: manager,
      codexConfig: config,
      recoveryCodexHome: home,
    });
    sessions.push(session);
    let finish!: (value: boolean) => void;
    const held = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    const proof = vi.fn(() => held);
    const create = vi.spyOn(manager, 'createSession');
    session.setCodexRestoreLaunchGuard({ ...healthyGuard(), prepare: async () => {}, confirm: proof });
    const launch = session.startInteractive().then(
      () => undefined,
      (error: unknown) => error
    );
    try {
      await vi.waitFor(() => expect(proof).toHaveBeenCalledOnce());
      await session.fenceUntrackedInput();
      finish(true);
      expect(await launch).toBeInstanceOf(Error);
      expect(create).not.toHaveBeenCalled();
      expect(effects.sync.mock.calls.some(([command]) => command.includes('respawn-pane '))).toBe(false);
    } finally {
      finish(false);
      await launch;
    }
  });

  it.each(['lost-receipt', 'unknown-pid'] as const)(
    'preserves original durable identity when worker launch has %s',
    async (failure) => {
      const { manager, home } = fixture();
      const dispatch = vi.fn();
      effects.sync.mockImplementation((command: string) => {
        if (command.includes('respawn-pane ')) {
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
        return nativeOutput(command);
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
          codexRestoreGuard: {
            ...healthyGuard(),
            prepare: async () => {},
            confirm: () => true,
            noteDispatch: dispatch,
          },
        })
      ).rejects.toThrow();
      expect(dispatch).toHaveBeenCalledOnce();
      expect(manager.getSession(ID)).toMatchObject({
        sessionId: ID,
        pid: 0,
        codexRestoreUncertain: true,
        codexRestoreConfig: config,
      });
      expect(effects.sync.mock.calls.filter(([command]) => command.includes('respawn-pane '))).toHaveLength(1);
      expect(effects.sync.mock.calls.some(([command]) => command.includes('kill-pane '))).toBe(false);
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
          ...healthyGuard(),
          prepare: async () => {
            prepares++;
          },
          confirm: () => prepares < 2,
          noteDispatch: dispatch,
        },
      })
    ).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
    expect(effects.sync.mock.calls.some(([command]) => command.includes('respawn-pane '))).toBe(false);
    expect(effects.sync.mock.calls.filter(([command]) => command.includes('kill-pane '))).toHaveLength(1);
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
          codexRestoreGuard: {
            ...healthyGuard(),
            prepare: async () => {},
            confirm: () => true,
            noteDispatch: dispatch,
          },
        })
      ).rejects.toThrow();
      expect(dispatch).not.toHaveBeenCalled();
      expect(effects.sync.mock.calls.some(([command]) => command.includes('respawn-pane '))).toBe(false);
      expect(effects.sync.mock.calls.filter(([command]) => command.includes('kill-pane '))).toHaveLength(1);
      expect(manager.getSession(ID)).toMatchObject({
        recoveryInputBrokerPending: expect.any(String),
        codexRestoreUncertain: true,
      });
      expect(readFileSync(metadata, 'utf8')).toBe(damaged);
    }
  );

  it.each(['exact', 'different-home', 'different-config', 'absent'] as const)(
    'adopts only matching original launch metadata after receipt loss: %s',
    async (metadataKind) => {
      const { manager, home } = fixture();
      effects.sync.mockImplementation((command: string) => {
        if (command.includes('respawn-pane ')) throw new Error('Fixture receipt lost after dispatch');
        return nativeOutput(command);
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
      session.setCodexRestoreLaunchGuard({ ...healthyGuard(), prepare: async () => {}, confirm: () => true });
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
      expect(effects.sync.mock.calls.filter(([command]) => command.includes('respawn-pane '))).toHaveLength(1);
      expect(effects.sync.mock.calls.some(([command]) => command.includes('kill-pane '))).toBe(false);
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
            command.includes('respawn-pane ') || command.includes(' new-session ') || command.includes('kill-pane ')
        )
      ).toBe(false);
      expect(session.codexRestoreWorkerMayExist).toBe(true);
    }
  );

  it.each(
    (['codex', 'generic'] as const).flatMap((kind) =>
      (
        [
          'empty',
          'other-live',
          'own-live',
          'own-dead',
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
          'no-server',
          'wrong-socket',
          'missing-socket',
          'no-server-signal',
          'no-server-killed',
          'no-server-status',
          'no-server-timeout',
          'no-server-output',
          'no-server-extra',
        ] as const
      ).map((listing) => ({ kind, listing }))
    )
  )(
    'retires $kind uncertain identity only after a complete pane listing proves absence ($listing)',
    async ({ kind, listing }) => {
      const { manager, home } = fixture();
      const record: MuxSession = {
        sessionId: ID,
        muxName: 'codeman-aaaaaaaa',
        pid: 0,
        createdAt: Date.now(),
        workingDir: root,
        mode: kind === 'codex' ? 'codex' : 'claude',
        owner: 'worker',
        attached: false,
        ...(kind === 'codex'
          ? { recoveryCodexHome: home, codexRestoreUncertain: true, codexRestoreConfig: config }
          : { restoreUncertain: true }),
      };
      manager.registerSession(record);
      await manager.flushSessionsDurably();
      const sep = '|'; // Exact native PANE_LIST_FORMAT separator.
      const valid = (name: string, pid: string) => [name, pid, '0', '', ''].join(sep) + '\n';
      effects.sync.mockImplementation((command: string) => {
        expect(command).not.toContain('|| true');
        if (
          listing === 'no-server' ||
          listing === 'wrong-socket' ||
          listing === 'missing-socket' ||
          listing.startsWith('no-server-')
        ) {
          const socket = join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid!()}`, 'fixture-socket');
          const diagnostic =
            listing === 'missing-socket'
              ? `error connecting to ${socket} (No such file or directory)\n`
              : `no server running on ${listing === 'wrong-socket' ? socket + '-other' : socket}\n`;
          throw Object.assign(new Error('Fixture native no-server'), {
            status: listing === 'no-server-status' ? 2 : 1,
            stdout: listing === 'no-server-output' ? 'partial listing' : '',
            stderr: diagnostic + (listing === 'no-server-extra' ? 'extra diagnostic\n' : ''),
            ...(listing === 'no-server-signal' ? { signal: 'SIGTERM' } : {}),
            ...(listing === 'no-server-killed' ? { killed: true } : {}),
            ...(listing === 'no-server-timeout' ? { code: 'ETIMEDOUT' } : {}),
          });
        }
        if (listing === 'failed') throw new Error('Fixture pane listing unavailable');
        return listing === 'empty'
          ? ''
          : listing === 'other-live'
            ? valid('codeman-other', '123')
            : listing === 'own-live'
              ? valid(record.muxName, '700')
              : listing === 'own-dead'
                ? [record.muxName, '700', '1', '1', ''].join(sep) + '\n'
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
      const absent = listing === 'empty' || listing === 'other-live' || listing === 'no-server';
      expect(manager.getSession(ID)).toBe(absent ? undefined : record);
      if (absent) {
        expect(result.dead).toContain(ID);
        expect(died).toHaveBeenCalledExactlyOnceWith({ sessionId: ID });
      } else {
        expect(result.dead).not.toContain(ID);
        expect(died).not.toHaveBeenCalled();
        expect(record.pid).toBe(listing === 'own-live' || listing === 'own-dead' ? 700 : 0);
        if (kind === 'codex') {
          expect(record.codexRestoreUncertain).toBe(true);
          expect(record.codexRestoreConfig).toEqual(config);
          expect(record.recoveryCodexHome).toBe(home);
        } else expect(record.restoreUncertain).toBe(true);
      }
      await manager.flushSessionsDurably();
      const persisted = JSON.parse(readFileSync(metadata, 'utf8')) as MuxSession[];
      expect(persisted.some((saved) => saved.sessionId === ID)).toBe(!absent);
      expect(effects.sync.mock.calls).toHaveLength(1);
    }
  );

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

  it.each(['unknown-startup', 'lost-wire', 'no-child', 'healthy'] as const)(
    'generic Server discard protects an ordinary uncertain launch without caller preservation flags: %s',
    async (outcome) => {
      const { manager, home, getBroker } = fixture();
      const broker = await getBroker();
      if (outcome === 'unknown-startup') vi.mocked(broker.startupReceipt).mockResolvedValue('unknown');
      if (outcome === 'no-child') vi.mocked(broker.startupReceipt).mockResolvedValue('not-sent');
      if (outcome === 'lost-wire')
        effects.sync.mockImplementation((command: string) => {
          if (command.includes('respawn-pane ')) throw new Error('Fixture unknown worker launch');
          return nativeOutput(command);
        });
      vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);
      const server = new WebServer(0, false, true);
      servers.push(server);
      Reflect.set(server, 'mux', manager);
      for (const method of [
        'startStatsCollection',
        'startMouseModeSync',
        'startPaneExitWatcher',
        'startRemoteReconnectWatcher',
        'destroy',
      ] as const)
        vi.spyOn(manager, method).mockImplementation(() => {});
      const session = new Session({
        id: ID,
        mode: 'codex',
        workingDir: root,
        useMux: true,
        mux: manager,
        codexConfig: config,
        recoveryCodexHome: home,
      });
      sessions.push(session);
      const board = Reflect.get(server, 'sessions') as Map<string, SessionType>;
      board.set(ID, session);
      const store = Reflect.get(server, 'store') as import('../src/state-store.js').StateStore;
      const historical = { ...session.toState(), pid: 1234, name: 'Preserved history', totalCost: 7 };
      store.setSession(ID, historical);
      store.flush();
      const configDir = join(root, 'custom-model-configs', ID);
      mkdirSync(configDir, { recursive: true });
      const marker = join(configDir, 'owned-home-marker');
      writeFileSync(marker, 'preserved config');
      if (outcome === 'healthy') await session.startInteractive();
      else await expect(session.startInteractive()).rejects.toThrow();
      const uncertain = outcome === 'unknown-startup' || outcome === 'lost-wire';
      expect(session.codexRestoreWorkerMayExist).toBe(uncertain);
      const stop = vi.spyOn(session, 'stop');
      const kill = vi.spyOn(manager, 'killSession');
      await server.discardPartiallyBuiltSession(ID, session);
      if (uncertain) {
        expect(board.get(ID)).toBe(session);
        expect(stop).not.toHaveBeenCalled();
        expect(kill).not.toHaveBeenCalled();
        expect(readFileSync(marker, 'utf8')).toBe('preserved config');
        Reflect.get(server, '_persistSessionStateNow').call(server, session);
        expect(store.getSession(ID)).toEqual(historical);
        expect(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')).sessions[ID]).toEqual(historical);
        expect(manager.getSession(ID)).toMatchObject({
          recoveryInputBrokerPending: broker.incarnation,
          codexRestoreUncertain: true,
        });
      } else {
        expect(board.has(ID)).toBe(false);
        expect(stop).toHaveBeenCalledWith(true);
        expect(() => statSync(marker)).toThrow();
      }
    }
  );

  it.each(['started', 'lost-wire', 'unknown-startup', 'no-child', 'promotion-failure'] as const)(
    'durably reserves a new ordinary broker before the worker can receive bytes: %s',
    async (outcome) => {
      const { manager, home, getBroker } = fixture();
      const broker = await getBroker();
      if (outcome === 'unknown-startup') vi.mocked(broker.startupReceipt).mockResolvedValue('unknown');
      if (outcome === 'no-child') vi.mocked(broker.startupReceipt).mockResolvedValue('not-sent');
      const flush = manager.flushSessionsDurably.bind(manager);
      let flushes = 0;
      if (outcome === 'promotion-failure')
        vi.spyOn(manager, 'flushSessionsDurably').mockImplementation(async (scope) => {
          if (++flushes === 2) throw new Error('Fixture promotion fsync failed');
          await flush(scope);
        });
      let snapshot: MuxSession | undefined;
      effects.sync.mockImplementation((command: string) => {
        if (command.includes(' new-session ')) expect(command).toContain('/bin/sleep 86400');
        if (command.includes('respawn-pane ')) {
          snapshot = JSON.parse(readFileSync(metadata, 'utf8'))[0];
          expect(snapshot).toMatchObject({
            pid: 0,
            recoveryInputBroker: broker.incarnation,
            recoveryInputBrokerPending: broker.incarnation,
            codexRestoreUncertain: true,
          });
          if (outcome === 'lost-wire') throw new Error('Fixture lost worker launch receipt');
        }
        return nativeOutput(command);
      });
      const launch = manager.createSession({
        sessionId: ID,
        workingDir: root,
        mode: 'codex',
        codexConfig: config,
        recoveryCodexHome: home,
      });
      if (outcome === 'started') {
        await launch;
        expect(manager.getSession(ID)?.recoveryInputBrokerPending).toBeUndefined();
        expect(JSON.parse(readFileSync(metadata, 'utf8'))[0]).toMatchObject({
          recoveryInputBroker: broker.incarnation,
        });
        expect(JSON.parse(readFileSync(metadata, 'utf8'))[0].recoveryInputBrokerPending).toBeUndefined();
      } else {
        await expect(launch).rejects.toThrow();
        if (outcome === 'no-child') {
          expect(manager.getSession(ID)).toBeUndefined();
          expect(JSON.parse(readFileSync(metadata, 'utf8'))).toEqual([]);
        } else {
          expect(manager.getSession(ID)).toMatchObject({
            recoveryInputBrokerPending: broker.incarnation,
            codexRestoreUncertain: true,
          });
          expect(JSON.parse(readFileSync(metadata, 'utf8'))[0]).toMatchObject({
            recoveryInputBrokerPending: broker.incarnation,
            codexRestoreUncertain: true,
          });
        }
      }
      expect(snapshot).toBeDefined();
      expect(effects.sync.mock.calls.filter(([command]) => command.includes('kill-pane '))).toHaveLength(
        outcome === 'no-child' ? 1 : 0
      );
    }
  );

  it('retains the reservation when exact no-child cleanup cannot acknowledge metadata rollback', async () => {
    const { manager, home, getBroker } = fixture();
    const broker = await getBroker();
    vi.mocked(broker.startupReceipt).mockResolvedValue('not-sent');
    const flush = manager.flushSessionsDurably.bind(manager);
    let writes = 0;
    vi.spyOn(manager, 'flushSessionsDurably').mockImplementation(async (scope) => {
      if (++writes > 1) throw new Error('Fixture cleanup metadata fsync failed');
      await flush(scope);
    });
    const refused = vi.fn(),
      uncertain = vi.fn();
    await expect(
      manager.createSession({
        sessionId: ID,
        workingDir: root,
        mode: 'codex',
        codexConfig: config,
        recoveryCodexHome: home,
        codexRestoreGuard: { ...healthyGuard(), noteBrokerRefusal: refused, noteCleanupUncertain: uncertain },
      })
    ).rejects.toThrow();
    expect(refused).not.toHaveBeenCalled();
    expect(uncertain).toHaveBeenCalledOnce();
    expect(manager.getSession(ID)).toMatchObject({
      recoveryInputBrokerPending: broker.incarnation,
      codexRestoreUncertain: true,
    });
    expect(JSON.parse(readFileSync(metadata, 'utf8'))[0]).toMatchObject({
      recoveryInputBrokerPending: broker.incarnation,
    });
    expect(effects.sync.mock.calls.filter(([command]) => command.includes('kill-pane '))).toHaveLength(1);
  });

  it('keeps an ordinary launch receipt loss available for inspection without another launch', async () => {
    const { manager, home } = fixture();
    effects.sync.mockImplementation((command: string) => {
      if (command.includes('respawn-pane ')) throw new Error('Fixture unknown worker');
      return nativeOutput(command);
    });
    const session = new Session({
      id: ID,
      mode: 'codex',
      workingDir: root,
      useMux: true,
      mux: manager,
      codexConfig: config,
      recoveryCodexHome: home,
    });
    sessions.push(session);
    await expect(session.startInteractive()).rejects.toThrow();
    expect(session.codexRestoreWorkerMayExist).toBe(true);
    expect(session.getRecoveryContext().managed).toBe(false);
    vi.spyOn(manager, 'muxSessionExists').mockReturnValue(true);
    vi.spyOn(manager, 'isPaneDead').mockReturnValue(false);
    await session.startInteractive();
    expect(effects.attach).toHaveBeenCalledOnce();
    expect(effects.sync.mock.calls.filter(([command]) => command.includes('respawn-pane '))).toHaveLength(1);
  });

  it.each([
    'sent',
    'lost-receipt',
    'revoked-before',
    'revoked-during-retirement',
    'retirement-file-failure',
    'rollback-file-failure',
    'private-proof-refused',
    'record-replaced',
  ] as const)('retires a previous reboot binding before any later native respawn effect (%s)', async (outcome) => {
    const { manager, home, getBroker } = fixture();
    const broker = await getBroker();
    const proof = fakeInputProvenance({ incarnation: broker.incarnation, closed: true, exitStatus: 9 }, home);
    vi.spyOn(broker, 'prove').mockResolvedValue(proof);
    vi.spyOn(manager as unknown as { getInputBroker(): Promise<CodexInputBroker> }, 'getInputBroker').mockResolvedValue(
      broker
    );
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
      recoveryInputBroker: '99999999-2222-3333-4444-555555555555',
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
    if (outcome === 'rollback-file-failure') {
      let calls = 0;
      vi.spyOn(manager, 'flushSessionsDurably').mockImplementation(async (scope) => {
        if (++calls > 1) throw new Error('Fixture rollback fsync failed');
        await flush(scope);
        authorized = false;
      });
    }
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
      if (command.includes('respawn-pane ')) {
        const saved = JSON.parse(readFileSync(metadata, 'utf8')).find((row: MuxSession) => row.sessionId === ID);
        expect(saved.codexRestoreStateBinding).toBeUndefined();
        expect(saved.codexRestoreConfig).toEqual({ ...config, model: 'new-owner-model' });
        expect(saved.recoveryCodexHome).toBe(home);
        expect(saved.recoveryInputBroker).toBe('99999999-2222-3333-4444-555555555555');
        expect(saved.recoveryInputBrokerPending).toBe(broker.incarnation);
        expect(saved.codexRestoreUncertain).toBe(true);
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
      expectedRecoveryPane: { paneId: '%7', panePid: 700, status: 9, inputProvenance: proof },
      recoveryDispatchGuard: {
        inputProof: proof,
        confirm: () => authorized && record.recoveryInputBroker === '99999999-2222-3333-4444-555555555555',
        prepareEvidence: async () => outcome !== 'private-proof-refused',
        noteDispatch: vi.fn(),
      },
    });
    expect(result).toBe(outcome === 'sent' ? 99999 : null);
    expect(effects.exec.mock.calls.filter(([command]) => String(command).includes('respawn-pane '))).toHaveLength(
      outcome === 'sent' || outcome === 'lost-receipt' ? 1 : 0
    );
    if (
      ['revoked-before', 'revoked-during-retirement', 'retirement-file-failure', 'private-proof-refused'].includes(
        outcome
      )
    ) {
      await manager.flushSessionsDurably();
      const saved = JSON.parse(readFileSync(metadata, 'utf8')).find((row: MuxSession) => row.sessionId === ID);
      expect(saved.codexRestoreStateBinding).toBe('a'.repeat(64));
      expect(saved.codexRestoreConfig).toEqual(config);
      expect(record.codexRestoreStateBinding).toBe('a'.repeat(64));
      expect(record.codexRestoreConfig).toEqual(config);
      expect(record.recoveryInputBrokerPending).toBeUndefined();
      expect(record.codexRestoreUncertain).toBe(false);
    } else {
      expect(record.codexRestoreStateBinding).toBeUndefined();
      expect(record.codexRestoreConfig).toEqual({ ...config, model: 'new-owner-model' });
      if (outcome === 'rollback-file-failure' || outcome === 'lost-receipt') {
        expect(record.recoveryInputBrokerPending).toBe(broker.incarnation);
        expect(record.codexRestoreUncertain).toBe(true);
        expect(JSON.parse(readFileSync(metadata, 'utf8'))[0]).toMatchObject({
          recoveryInputBrokerPending: broker.incarnation,
        });
      }
      if (outcome === 'sent') {
        expect(record.recoveryInputBrokerPending).toBeUndefined();
        expect(JSON.parse(readFileSync(metadata, 'utf8'))[0].recoveryInputBrokerPending).toBeUndefined();
      }
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

describe('non-Codex reboot restore at the actual native launch boundary', () => {
  it.each([
    ...(
      [
        'healthy',
        'owner-healthy',
        'owner-downgrade',
        'changed-profile',
        'cancelled',
        'changed-session',
        'changed-after-inert',
        'changed-native-cleanup',
        'worker-lost-ack',
        'create-lost-ack',
        'cancelled-after-launch',
        'cancelled-lost-ack',
        'cancel-after-commit-lost-ack',
      ] as const
    ).map((kind) => ({ kind, customModel: true })),
    ...(
      [
        'healthy',
        'owner-healthy',
        'owner-downgrade',
        'cancelled',
        'changed-session',
        'worker-refused',
        'worker-lost-ack',
        'create-lost-ack',
        'cancelled-after-launch',
        'cancelled-lost-ack',
        'cancel-after-commit-lost-ack',
      ] as const
    ).map((kind) => ({ kind, customModel: false })),
  ])('checks the route after internal telemetry awaits (custom=$customModel): $kind', async ({ kind, customModel }) => {
    const previousMultiuser = process.env.CODEMAN_MULTIUSER;
    const owned = kind === 'owner-healthy' || kind === 'owner-downgrade';
    if (owned) {
      process.env.CODEMAN_MULTIUSER = '1';
      writeFileSync(join(root, 'users.json'), JSON.stringify({ version: 1, users: [] }));
      invalidateUsersCache();
      await createUser({ username: 'operator', role: 'admin', password: 'fixture-password' });
      await createUser({ username: 'worker', role: 'admin', password: 'fixture-password' });
    }
    const hooks = await import('../src/hooks-config.js');
    const { writeCustomModelHosts } = await import('../src/custom-model-hosts.js');
    const { customModelHostsPath } = await import('../src/custom-model-hosts.js');
    const { customModelConfigDir } = await import('../src/custom-model-injection-apply.js');
    // Each case starts without a profile, so uncertainty preservation cannot
    // pass only because a prior case owned the directory.
    rmSync(customModelConfigDir(ID), { recursive: true, force: true });
    const endpoint = {
      id: 'native-profile',
      label: 'fixture',
      baseUrl: 'http://127.0.0.1:12345',
      apiKey: 'fixture-secret',
      models: ['fixture-model'],
    };
    await writeCustomModelHosts(root, [endpoint]);
    const { manager } = fixture();
    vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);
    const server = new WebServer(0, false, true);
    servers.push(server);
    Reflect.set(server, 'mux', manager);
    for (const method of [
      'startStatsCollection',
      'startMouseModeSync',
      'startPaneExitWatcher',
      'startRemoteReconnectWatcher',
      'destroy',
    ] as const)
      vi.spyOn(manager, method).mockImplementation(() => {});
    const board = Reflect.get(server, 'sessions') as Map<string, SessionType>;
    const state: SessionState = {
      id: ID,
      mode: 'claude',
      owner: owned ? 'worker' : undefined,
      pid: 1234,
      status: 'idle',
      workingDir: root,
      currentTaskId: null,
      createdAt: Date.now() - 60000,
    };
    if (customModel)
      Object.assign(state, {
        __customModel: {
          endpointId: endpoint.id,
          modelId: 'fixture-model',
          envKeys: [],
          configDir: customModelConfigDir(ID),
        },
      });
    await rebootRestoreRegistry.set([
      {
        sessionId: ID,
        mode: 'claude',
        owner: state.owner,
        name: 'fixture',
        workingDir: root,
        resumeConversationId: THREAD,
        state,
      },
    ]);
    const store = Reflect.get(server, 'store') as import('../src/state-store.js').StateStore;
    store.setSession(ID, state);
    store.flush();
    const historical = structuredClone(store.getSession(ID));
    const ctx = Reflect.get(server, 'createRouteContext').call(server) as Parameters<
      typeof registerRebootRestoreRoutes
    >[1];
    ctx.getWorkspaceHooksEnabled = async () => false;
    ctx.getAgentSkillEnabled = async () => false;
    const app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    registerRebootRestoreRoutes(app, ctx);
    installRouteErrorHandler(app);
    await app.ready();
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(hooks, 'readPlanUsageTelemetryEnabled').mockImplementation(async () => {
      entered();
      await held;
      return false;
    });
    vi.spyOn(hooks, 'resolveStatusLineCliCommand').mockResolvedValue(undefined);
    if (
      kind === 'worker-lost-ack' ||
      kind === 'worker-refused' ||
      kind === 'changed-native-cleanup' ||
      kind === 'create-lost-ack'
    ) {
      effects.sync.mockImplementation((command: string) => {
        if (kind === 'create-lost-ack' && command.includes(' new-session ')) {
          expect(command).toContain('/bin/sleep 86400');
          throw Error('Inert native pane may exist; create ACK lost');
        }
        if (kind === 'changed-native-cleanup' && command.includes('kill-pane '))
          return 'CODEMAN_REBOOT_CLEANUP_REFUSED\n';
        if (kind === 'worker-refused' && command.includes('respawn-pane ')) return 'CODEMAN_REBOOT_LAUNCH_REFUSED\n';
        if (
          kind === 'worker-lost-ack' &&
          (command.includes('respawn-pane ') ||
            (!customModel && command.includes(' new-session ') && !command.includes('/bin/sleep 86400')))
        )
          throw Error('Worker may have started; response lost');
        return nativeOutput(command);
      });
    }
    if (kind === 'changed-after-inert' || kind === 'changed-native-cleanup') {
      vi.mocked(Reflect.get(manager, '_configureCliEnv')).mockImplementation(() => {
        writeFileSync(customModelHostsPath(root), JSON.stringify([{ ...endpoint, apiKey: 'replacement-secret' }]));
      });
    }
    if (kind === 'cancelled-after-launch' || kind === 'cancelled-lost-ack') {
      const start = Session.prototype.startInteractive;
      vi.spyOn(Session.prototype, 'startInteractive').mockImplementation(async function () {
        await start.call(this);
        await rebootRestoreRegistry.clear(() => true);
        if (kind === 'cancelled-lost-ack') throw Error('Worker startup ACK lost after cancellation');
      });
    }
    let committed: SessionState | undefined;
    if (kind === 'cancel-after-commit-lost-ack') {
      const persist = ctx.persistRebootRestoreDurably!.bind(ctx);
      ctx.persistRebootRestoreDurably = async (...args) => {
        await persist(...args);
        expect(manager.getSession(ID)).not.toHaveProperty('restoreUncertain');
        committed = structuredClone(store.getSession(ID)!);
        await rebootRestoreRegistry.clear(() => true);
        const sync = effects.sync.getMockImplementation()!;
        effects.sync.mockImplementation((command: string) => {
          if (command.includes('CODEMAN_REBOOT_CANCEL_REFUSED')) {
            expect(
              JSON.parse(readFileSync(metadata, 'utf8')).find((entry: MuxSession) => entry.sessionId === ID)
                .restoreUncertain
            ).toBe(true);
            throw Error('Native cancellation ACK lost');
          }
          return sync(command);
        });
      };
    }
    const complete = manager.completeAcknowledgedRebootLaunch.bind(manager);
    vi.spyOn(manager, 'completeAcknowledgedRebootLaunch').mockImplementation(async (...args) => {
      // The durable main-state write must precede the marker clear.
      const persisted = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')).sessions[ID];
      expect(persisted.pid).toBe(board.get(ID)!.pid);
      expect(persisted.pid).not.toBe(historical!.pid);
      expect(args[0].restoreUncertain).toBe(true);
      return complete(...args);
    });
    const sync = effects.sync.getMockImplementation()!;
    effects.sync.mockImplementation((command: string) => {
      if (command.includes('respawn-pane ')) {
        const reservation = JSON.parse(readFileSync(metadata, 'utf8')).find(
          (entry: MuxSession) => entry.sessionId === ID
        );
        expect(reservation).toMatchObject({ restoreUncertain: true, pid: 0 });
        expect(reservation.codexRestoreUncertain).toBeUndefined();
      }
      return sync(command);
    });
    const legacyKill = vi.spyOn(manager, 'killSession');
    try {
      const pending = app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
      // A refusal before telemetry must fail promptly instead of leaving this
      // test waiting on a hook that was never reached.
      await Promise.race([
        reached,
        pending.then(() => {
          throw new Error('Restore returned before reaching the internal telemetry boundary');
        }),
      ]);
      expect(effects.sync.mock.calls.some(([command]) => command.includes(' new-session '))).toBe(false);
      if (kind === 'owner-downgrade') await updateUser('worker', { role: 'user' });
      if (kind === 'changed-profile')
        await writeCustomModelHosts(root, [{ ...endpoint, apiKey: 'replacement-secret' }]);
      if (kind === 'cancelled') await rebootRestoreRegistry.clear(() => true);
      if (kind === 'changed-session') board.get(ID)!.owner = 'different-owner';
      release();
      const result = (await pending).json();
      const launched = effects.sync.mock.calls.filter(([command]) => command.includes('respawn-pane '));
      expect(launched).toHaveLength(
        [
          'healthy',
          'owner-healthy',
          'worker-lost-ack',
          'worker-refused',
          'cancelled-after-launch',
          'cancelled-lost-ack',
          'cancel-after-commit-lost-ack',
        ].includes(kind)
          ? 1
          : 0
      );
      expect(effects.attach).toHaveBeenCalledTimes(
        [
          'healthy',
          'owner-healthy',
          'cancelled-after-launch',
          'cancelled-lost-ack',
          'cancel-after-commit-lost-ack',
        ].includes(kind)
          ? 1
          : 0
      );
      const healthy = kind === 'healthy' || kind === 'owner-healthy';
      expect(result.restored).toHaveLength(healthy ? 1 : 0);
      if (kind === 'owner-downgrade') {
        expect(effects.sync.mock.calls.some(([command]) => command.includes(' new-session '))).toBe(false);
        expect(board.has(ID)).toBe(false);
        expect(store.getSession(ID)).toEqual(historical);
        expect(rebootRestoreRegistry.list(() => true).map((entry) => entry.sessionId)).toEqual([ID]);
      }
      if (healthy) {
        const session = board.get(ID)!;
        sessions.push(session);
        expect(Reflect.get(session, '_restoreLaunchGuard')).toBeUndefined();
        expect(session.restoreLaunchMayExist).toBe(false);
        expect(manager.getSession(ID)).not.toHaveProperty('restoreUncertain');
        expect(
          JSON.parse(readFileSync(metadata, 'utf8')).find((entry: MuxSession) => entry.sessionId === ID)
        ).not.toHaveProperty('restoreUncertain');
        expect(launched[0][0]).toContain(`#{==:#{pane_pid},99999}`);
        expect(launched[0][0]).toContain('--resume');
        expect(launched[0][0]).toContain(THREAD);
        expect(effects.attach.mock.calls[0][0]).toBe('tmux');
        expect(effects.attach.mock.calls[0][1]).toContain('attach-session');
      } else if (kind === 'worker-refused') {
        expect(result.skipped).toEqual([{ sessionId: ID, reason: 'rebuild-failed' }]);
        expect(effects.sync.mock.calls.some(([command]) => command.includes('kill-session '))).toBe(false);
        expect(manager.getSession(ID)).toBeUndefined();
        expect(board.has(ID)).toBe(false);
        expect(store.getSession(ID)).toEqual(historical);
        expect(rebootRestoreRegistry.list(() => true).map((entry) => entry.sessionId)).toEqual([ID]);
        expect(effects.sync.mock.calls.filter(([command]) => command.includes('kill-pane '))).toHaveLength(1);
      } else if (kind === 'cancelled-after-launch') {
        expect(result.skipped).toEqual([{ sessionId: ID, reason: 'restore-cancelled' }]);
        expect(legacyKill).not.toHaveBeenCalled();
        expect(manager.getSession(ID)).toBeUndefined();
        expect(board.has(ID)).toBe(false);
        expect(
          effects.sync.mock.calls.filter(([command]) => command.includes('CODEMAN_REBOOT_CANCEL_REFUSED'))
        ).toHaveLength(1);
      } else if (
        kind === 'changed-native-cleanup' ||
        kind === 'worker-lost-ack' ||
        kind === 'create-lost-ack' ||
        kind === 'cancelled-lost-ack' ||
        kind === 'cancel-after-commit-lost-ack'
      ) {
        expect(result.skipped).toEqual([{ sessionId: ID, reason: 'restore-uncertain' }]);
        expect(legacyKill).not.toHaveBeenCalled();
        expect(effects.sync.mock.calls.some(([command]) => command.includes('kill-session '))).toBe(false);
        if (customModel) expect(statSync(customModelConfigDir(ID)).isDirectory()).toBe(true);
        expect(store.getSession(ID)).toEqual(committed ?? historical);
        store.flush();
        expect(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')).sessions[ID]).toEqual(
          committed ?? historical
        );
        if (kind === 'cancel-after-commit-lost-ack') {
          expect(manager.getSession(ID)?.restoreUncertain).toBe(true);
          expect(
            JSON.parse(readFileSync(metadata, 'utf8')).find((entry: MuxSession) => entry.sessionId === ID)
              .restoreUncertain
          ).toBe(true);
        }
      } else if (kind === 'changed-after-inert') {
        const cleanup = effects.sync.mock.calls.filter(([command]) => command.includes('kill-pane '));
        expect(cleanup).toHaveLength(1);
        expect(cleanup[0][0]).toContain(`#{==:#{pane_pid},99999}`);
      }
    } finally {
      release();
      await app.close();
      if (owned) {
        rmSync(join(root, 'users.json'), { force: true });
        invalidateUsersCache();
        if (previousMultiuser === undefined) delete process.env.CODEMAN_MULTIUSER;
        else process.env.CODEMAN_MULTIUSER = previousMultiuser;
      }
    }
  });

  it.each(['healthy', 'prepare-microtask', 'confirm-microtask'] as const)(
    'rechecks pure native authority after the last asynchronous %s',
    async (kind) => {
      const hooks = await import('../src/hooks-config.js');
      vi.spyOn(hooks, 'readPlanUsageTelemetryEnabled').mockResolvedValue(false);
      vi.spyOn(hooks, 'resolveStatusLineCliCommand').mockResolvedValue(undefined);
      const { manager } = fixture();
      let current = true;
      const pending = manager.createSession({
        sessionId: ID,
        mode: 'claude',
        workingDir: root,
        restoreGuard: {
          prepare: async () => {
            if (kind === 'prepare-microtask')
              queueMicrotask(() => {
                current = false;
              });
          },
          confirm: async () => {
            if (kind === 'confirm-microtask')
              queueMicrotask(() => {
                current = false;
              });
            return true;
          },
          isCurrent: () => current,
        },
      });
      if (kind === 'healthy') await pending;
      else await expect(pending).rejects.toThrow('authority changed');
      expect(effects.sync.mock.calls.some(([command]) => command.includes(' new-session '))).toBe(kind === 'healthy');
      expect(effects.sync.mock.calls.some(([command]) => command.includes('respawn-pane '))).toBe(kind === 'healthy');
    }
  );
});

describe('Dismiss during the acknowledged restore durability wait', () => {
  it.each(
    (['codex', 'claude'] as const).flatMap((mode) =>
      (['cancelled', 'owner-changed', 'native-replaced', 'lost-ack', 'state-error', 'complete'] as const).map(
        (outcome) => ({ mode, outcome })
      )
    )
  )('keeps the exact acknowledged worker cancellation proof for $mode: $outcome', async ({ mode, outcome }) => {
    const { manager, home } = fixture();
    const hooks = await import('../src/hooks-config.js');
    vi.spyOn(hooks, 'readPlanUsageTelemetryEnabled').mockResolvedValue(false);
    vi.spyOn(hooks, 'resolveStatusLineCliCommand').mockResolvedValue(undefined);
    if (mode === 'codex') {
      mkdirSync(join(home, 'sessions'), { recursive: true });
      writeFileSync(
        join(home, 'sessions', `rollout-2026-10-13T15-00-00-${THREAD}.jsonl`),
        JSON.stringify({
          type: 'session_meta',
          timestamp: '2026-10-13T15:00:00Z',
          payload: { id: THREAD, cwd: root, originator: `codeman_${ID}` },
        }) + '\n'
      );
    }
    vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);
    const server = new WebServer(0, false, true);
    servers.push(server);
    Reflect.set(server, 'mux', manager);
    for (const method of [
      'startStatsCollection',
      'startMouseModeSync',
      'startPaneExitWatcher',
      'startRemoteReconnectWatcher',
      'destroy',
    ] as const)
      vi.spyOn(manager, method).mockImplementation(() => {});
    const board = Reflect.get(server, 'sessions') as Map<string, SessionType>;
    const state: SessionState = {
      id: ID,
      mode,
      pid: 1234,
      status: 'idle',
      workingDir: root,
      currentTaskId: null,
      createdAt: Date.now() - 60000,
      ...(mode === 'codex'
        ? { codexConfig: config, __codexRecoveryHome: home, __envOverrides: { CODEX_HOME: home } }
        : {}),
    };
    const plan =
      mode === 'codex'
        ? (
            await planVerifiedRebootRestore([ID], { [ID]: state }, async () => ({
              status: 'present' as const,
              dev: 1,
              ino: 1,
            }))
          ).restore
        : [{ sessionId: ID, mode, name: 'fixture', workingDir: root, resumeConversationId: THREAD, state }];
    expect(plan).toHaveLength(1);
    await rebootRestoreRegistry.set(plan);
    const store = Reflect.get(server, 'store') as import('../src/state-store.js').StateStore;
    store.setSession(ID, state);
    store.flush();
    const historical = structuredClone(store.getSession(ID));
    const ctx = Reflect.get(server, 'createRouteContext').call(server) as Parameters<
      typeof registerRebootRestoreRoutes
    >[1];
    ctx.getWorkspaceHooksEnabled = async () => false;
    ctx.getAgentSkillEnabled = async () => false;
    const app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    registerRebootRestoreRoutes(app, ctx);
    installRouteErrorHandler(app);
    await app.ready();
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const persist = store.persistSessionDurably.bind(store);
    vi.spyOn(store, 'persistSessionDurably').mockImplementation(async (...args) => {
      // This stage is after startInteractive returned its exact startup ACK,
      // before the historical session snapshot can be replaced durably.
      entered();
      await held;
      if (outcome === 'state-error') throw Error('Fixture state write failed with offer still held');
      return persist(...args);
    });
    let exactNativeKills = 0;
    const native = effects.sync.getMockImplementation()!;
    effects.sync.mockImplementation((command: string) => {
      if (command.includes('CODEMAN_REBOOT_CANCEL_REFUSED')) {
        for (const term of [
          '#{==:#{pid},88}',
          '#{==:#{session_id},$1}',
          '#{==:#{pane_id},%7}',
          '#{==:#{pane_pid},99999}',
        ])
          expect(command).toContain(term);
        if (outcome === 'native-replaced') return 'CODEMAN_REBOOT_CANCEL_REFUSED\n';
        exactNativeKills++;
        if (outcome === 'lost-ack') throw Error('Fixture exact native cancellation ACK lost');
        return '';
      }
      return native(command);
    });
    const legacyKill = vi.spyOn(manager, 'killSession');
    try {
      const pending = app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
      await Promise.race([
        reached,
        pending.then(() => {
          throw Error('Restore returned before the durable-state stage');
        }),
      ]);
      const session = board.get(ID)!;
      expect(session.codexRestoreWorkerMayExist || session.restoreLaunchMayExist).toBe(true);
      expect(effects.attach).toHaveBeenCalledTimes(1);
      expect(store.getSession(ID)).toEqual(historical);
      expect(exactNativeKills).toBe(0);
      if (outcome !== 'state-error' && outcome !== 'complete') {
        const dismissed = await app.inject({ method: 'POST', url: '/api/reboot-restore/dismiss', payload: {} });
        expect(dismissed.statusCode).toBe(200);
        expect(rebootRestoreRegistry.list(() => true)).toEqual([]);
      }
      if (outcome === 'owner-changed') session.owner = 'replacement-owner';
      release();
      const result = (await pending).json();
      expect(result.restored).toHaveLength(outcome === 'complete' ? 1 : 0);
      expect(legacyKill).not.toHaveBeenCalled();
      expect(effects.sync.mock.calls.some(([command]) => command.includes('kill-session '))).toBe(false);
      expect(exactNativeKills).toBe(outcome === 'cancelled' || outcome === 'lost-ack' ? 1 : 0);
      if (outcome === 'complete') {
        expect(board.get(ID)).toBe(session);
        expect(session.codexRestoreWorkerMayExist || session.restoreLaunchMayExist).toBe(false);
        expect(store.getSession(ID)?.pid).not.toBe(historical!.pid);
      } else {
        expect(store.getSession(ID)).toEqual(historical);
        expect(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')).sessions[ID]).toEqual(historical);
        expect(result.skipped).toEqual([
          { sessionId: ID, reason: outcome === 'cancelled' ? 'restore-cancelled' : 'restore-uncertain' },
        ]);
        if (outcome === 'cancelled') {
          expect(board.has(ID)).toBe(false);
          expect(manager.getSession(ID)).toBeUndefined();
        } else {
          expect(manager.getSession(ID)).toMatchObject(
            mode === 'codex' ? { codexRestoreUncertain: true } : { restoreUncertain: true }
          );
          expect(session.codexRestoreWorkerMayExist || session.restoreLaunchMayExist).toBe(true);
        }
        expect(rebootRestoreRegistry.list(() => true)).toHaveLength(outcome === 'state-error' ? 1 : 0);
      }
    } finally {
      release();
      await app.close();
    }
  });
});

describe('acknowledged reboot launch cancellation native scope', () => {
  it.each([
    'healthy',
    'native-replaced',
    'record-replaced',
    'unacknowledged-clone',
    'owner-changed',
    'configuration-changed',
    'malformed-marker',
    'lost-removal-ack',
    'changed-during-removal',
  ] as const)('cancels only a freshly acknowledged exact worker: %s', async (kind) => {
    const { manager } = fixture();
    let record = await manager.createSession({
      sessionId: ID,
      mode: 'codex',
      workingDir: root,
      owner: 'fixture-owner',
      codexConfig: config,
      codexRestoreGuard: healthyGuard(),
    });
    let current = true,
      nativeKills = 0;
    effects.sync.mockImplementation((command: string) => {
      if (command.includes('CODEMAN_REBOOT_CANCEL_REFUSED')) {
        expect(command).toContain('#{==:#{pid},88}');
        expect(command).toContain('#{==:#{session_id},$1}');
        expect(command).toContain('#{==:#{pane_id},%7}');
        expect(command).toContain('#{==:#{pane_pid},99999}');
        if (kind === 'native-replaced') return 'CODEMAN_REBOOT_CANCEL_REFUSED\n';
        nativeKills++;
        return '';
      }
      return nativeOutput(command);
    });
    if (kind === 'record-replaced') Reflect.get(manager, 'sessions').set(ID, { ...record });
    if (kind === 'unacknowledged-clone') {
      record = { ...record };
      Reflect.get(manager, 'sessions').set(ID, record);
    }
    if (kind === 'owner-changed') record.owner = 'other-owner';
    if (kind === 'malformed-marker') record.restoreUncertain = null as never;
    if (kind === 'configuration-changed') record.codexRestoreConfig = { ...config, model: 'different-model' };
    if (kind === 'lost-removal-ack')
      vi.spyOn(manager, 'flushSessionsDurably').mockRejectedValue(Error('Lost metadata ACK after native kill'));
    if (kind === 'changed-during-removal')
      vi.spyOn(manager, 'flushSessionsDurably').mockImplementation(async () => {
        current = false;
      });
    const killed = await manager.cancelAcknowledgedRebootLaunch(record, () => current);
    expect(killed).toBe(kind === 'healthy');
    expect(nativeKills).toBe(['healthy', 'lost-removal-ack', 'changed-during-removal'].includes(kind) ? 1 : 0);
    expect(manager.getSession(ID) === undefined).toBe(kind === 'healthy');
    if (kind === 'lost-removal-ack' || kind === 'changed-during-removal') expect(manager.getSession(ID)).toBe(record);
    expect(effects.sync.mock.calls.some(([command]) => command.includes('kill-session '))).toBe(false);
  });
});

describe('custom-profile startup refusal ownership', () => {
  it.each(['sole-refusal', 'replaced-guard', 'later-dispatch', 'old-cleanup-uncertain'] as const)(
    'releases only the exact sole certified startup: %s',
    async (kind) => {
      const { manager } = fixture();
      const session = new Session({ id: ID, mode: 'claude', workingDir: root, useMux: true, mux: manager });
      sessions.push(session);
      const cleanup = vi.fn();
      const guard = {
        prepare: async () => {},
        confirm: () => true,
        isCurrent: () => true,
        noteCleanupUncertain: cleanup,
      };
      session.setRestoreLaunchGuard(guard);
      const old = Reflect.get(session, '_restoreLaunchGuard') as import('../src/mux-interface.js').RestoreLaunchGuard;
      if (kind !== 'old-cleanup-uncertain') old.noteDispatch!();
      let refusal = old;
      if (kind === 'later-dispatch') old.noteDispatch!();
      if (kind === 'replaced-guard' || kind === 'old-cleanup-uncertain') {
        session.setRestoreLaunchGuard(guard);
        const replacement = Reflect.get(
          session,
          '_restoreLaunchGuard'
        ) as import('../src/mux-interface.js').RestoreLaunchGuard;
        replacement.noteDispatch!();
        if (kind === 'old-cleanup-uncertain') {
          old.noteCleanupUncertain!();
          refusal = replacement;
        }
      }
      refusal.noteBrokerRefusal!();
      expect(session.restoreLaunchMayExist).toBe(kind !== 'sole-refusal');
      expect(cleanup).not.toHaveBeenCalled();
      expect(effects.sync).not.toHaveBeenCalled();
    }
  );
});

describe('durable generic restore marker completion', () => {
  it.each(['healthy', 'unacknowledged-clone', 'lost-ack', 'scope-changed'] as const)(
    'clears only a fully acknowledged exact private launch: %s',
    async (kind) => {
      const hooks = await import('../src/hooks-config.js');
      vi.spyOn(hooks, 'readPlanUsageTelemetryEnabled').mockResolvedValue(false);
      vi.spyOn(hooks, 'resolveStatusLineCliCommand').mockResolvedValue(undefined);
      const { manager } = fixture();
      let record = await manager.createSession({
        sessionId: ID,
        mode: 'claude',
        workingDir: root,
        restoreGuard: { prepare: async () => {}, confirm: () => true, isCurrent: () => true },
      });
      expect(JSON.parse(readFileSync(metadata, 'utf8'))[0].restoreUncertain).toBe(true);
      if (kind === 'unacknowledged-clone') {
        record = { ...record };
        Reflect.get(manager, 'sessions').set(ID, record);
      }
      let current = true;
      if (kind === 'lost-ack')
        vi.spyOn(manager, 'flushSessionsDurably').mockRejectedValue(Error('Marker clear ACK lost'));
      if (kind === 'scope-changed')
        vi.spyOn(manager, 'flushSessionsDurably').mockImplementation(async () => {
          current = false;
        });
      expect(await manager.completeAcknowledgedRebootLaunch(record, () => current)).toBe(kind === 'healthy');
      expect(record.restoreUncertain).toBe(kind === 'healthy' ? undefined : true);
      if (kind === 'healthy') {
        expect(JSON.parse(readFileSync(metadata, 'utf8'))[0]).not.toHaveProperty('restoreUncertain');
        // A late owner Dismiss still targets the acknowledged, legitimately cleared record.
        expect(await manager.cancelAcknowledgedRebootLaunch(record, () => true)).toBe(true);
      }
    }
  );
});

describe('boot inspection does not restart uncertain automation', () => {
  it.each(['uncertain', 'discovered', 'legacy'] as const)(
    'restores historical display but withholds launch automation and profile writes: %s',
    async (kind) => {
      const { manager } = fixture();
      const record: MuxSession = {
        sessionId: ID,
        muxName: 'codeman-aaaaaaaa',
        pid: 700,
        createdAt: Date.now() - 60000,
        workingDir: root,
        mode: 'claude',
        attached: false,
        ...(kind === 'uncertain' ? { restoreUncertain: true } : {}),
        ...(kind === 'discovered' ? { discovered: true } : {}),
        respawnConfig: { enabled: true } as MuxSession['respawnConfig'],
      };
      manager.registerSession(record);
      await manager.flushSessionsDurably();
      vi.spyOn(manager, 'reconcileSessions').mockResolvedValue({
        alive: kind === 'legacy' ? [ID] : [],
        dead: [],
        discovered: kind === 'discovered' ? [ID] : [],
      });
      vi.spyOn(manager, 'muxSessionExists').mockReturnValue(true);
      vi.spyOn(manager, 'isPaneDead').mockReturnValue(false);
      vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);
      const server = new WebServer(0, false, true);
      servers.push(server);
      Reflect.set(server, 'mux', manager);
      for (const method of [
        'startStatsCollection',
        'startMouseModeSync',
        'startPaneExitWatcher',
        'startRemoteReconnectWatcher',
        'destroy',
      ] as const)
        vi.spyOn(manager, method).mockImplementation(() => {});
      const profile = vi
        .spyOn(
          server as unknown as { _rebuildCustomModelEnv(): Promise<Record<string, string>> },
          '_rebuildCustomModelEnv'
        )
        .mockResolvedValue({ ANTHROPIC_API_KEY: 'new-fixture-secret' });
      const respawn = vi
        .spyOn(server as unknown as { restoreRespawnController(): void }, 'restoreRespawnController')
        .mockImplementation(() => {});
      const resume = vi.spyOn(Session.prototype, 'restoreAutoResume').mockImplementation(() => {});
      const { RalphTracker } = await import('../src/ralph-tracker.js');
      const ralph = vi.spyOn(RalphTracker.prototype, 'enable').mockImplementation(() => {});
      vi.spyOn(RalphTracker.prototype, 'startLoop').mockImplementation(() => {});
      vi.spyOn(
        server as unknown as { getWorkspaceHooksEnabled(): Promise<boolean> },
        'getWorkspaceHooksEnabled'
      ).mockResolvedValue(false);
      const store = Reflect.get(server, 'store') as import('../src/state-store.js').StateStore;
      const state: SessionState = {
        id: ID,
        mode: 'claude',
        pid: 700,
        status: 'idle',
        workingDir: root,
        currentTaskId: null,
        createdAt: record.createdAt,
        autoResumeEnabled: true,
        autoResumeAt: Date.now() - 1000,
        autoClearEnabled: true,
        autoCompactEnabled: true,
        ralphEnabled: true,
        ralphAutoEnableDisabled: false,
        inputTokens: 123,
        totalCost: 1.25,
        respawnEnabled: true,
        respawnConfig: { enabled: true } as SessionState['respawnConfig'],
      };
      Object.assign(state, {
        __customModel: { endpointId: 'fixture', modelId: 'fixture-model', envKeys: ['ANTHROPIC_API_KEY'] },
      });
      store.setSession(ID, state);
      store.flush();
      const historical = structuredClone(store.getSession(ID));
      expect(await Reflect.get(server, 'restoreMuxSessions').call(server)).toBe(true);
      const session = Reflect.get(server, 'sessions').get(ID) as SessionType;
      sessions.push(session);
      expect(session).toBeDefined();
      expect(effects.attach).toHaveBeenCalledTimes(1);
      expect(profile).toHaveBeenCalledTimes(kind === 'legacy' ? 1 : 0);
      expect(respawn).toHaveBeenCalledTimes(kind === 'legacy' ? 2 : 0);
      expect(resume).toHaveBeenCalledTimes(kind === 'legacy' ? 1 : 0);
      expect(ralph).toHaveBeenCalledTimes(kind === 'legacy' ? 1 : 0);
      if (kind !== 'legacy') expect(session.ralphTracker.autoEnableDisabled).toBe(true);
      expect(session.toState()).toMatchObject({
        inputTokens: 123,
        totalCost: 1.25,
        autoClearEnabled: kind === 'legacy',
        autoCompactEnabled: kind === 'legacy',
      });
      if (kind !== 'legacy') {
        Reflect.get(server, '_persistSessionStateNow').call(server, session);
        expect(store.getSession(ID)).toEqual(historical);
        expect(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')).sessions[ID]).toEqual(historical);
      }
      expect(
        effects.sync.mock.calls.some(
          ([command]) => command.includes('new-session ') || command.includes('respawn-pane ')
        )
      ).toBe(false);
    }
  );
});

describe('registered Codex-compatible live-pane restart configuration', () => {
  beforeEach(() => {
    const codex = getCli('codex')!;
    writeFileSync(
      join(root, 'clis.json'),
      JSON.stringify({
        schemaVersion: 1,
        clis: {
          'restart-codex': { ...codex, id: 'restart-codex', label: 'Restart Codex', order: 990 },
          'restart-capability-only': {
            ...codex,
            id: 'restart-capability-only',
            label: 'Capability only',
            order: 991,
            launch: { ...codex.launch, legacyConfigField: undefined },
            capabilities: { ...codex.capabilities, launchDefaults: undefined },
          },
          'restart-config-only': {
            ...codex,
            id: 'restart-config-only',
            label: 'Config only',
            order: 992,
            capabilities: { ...codex.capabilities, recovery: undefined },
          },
          'restart-unrelated': {
            ...codex,
            id: 'restart-unrelated',
            label: 'Unrelated CLI',
            order: 993,
            launch: { ...codex.launch, legacyConfigField: undefined },
            capabilities: { ...codex.capabilities, recovery: undefined, launchDefaults: undefined },
          },
        },
      }),
      { mode: 0o600 }
    );
    reloadCliRegistry();
  });
  afterEach(() => {
    rmSync(join(root, 'clis.json'), { force: true });
    reloadCliRegistry();
  });

  async function restartFixture(
    mode: string,
    savedPatch: Partial<SessionState> = {},
    nativePatch: Partial<MuxSession> = {}
  ) {
    const { manager } = fixture();
    const home = join(root, `restart-home-${randomUUID()}`);
    mkdirSync(home);
    const launchConfig = { ...config, reasoningEffort: 'high' as const, noAltScreen: true, animations: false };
    const record: MuxSession = {
      sessionId: ID,
      muxName: 'codeman-aaaaaaaa',
      pid: 700,
      createdAt: Date.now() - 60_000,
      workingDir: root,
      owner: 'fixture-owner',
      mode,
      attached: false,
      recoveryIsolated: true,
      recoveryCodexHome: home,
      ...nativePatch,
    };
    manager.registerSession(record);
    await manager.flushSessionsDurably();
    vi.spyOn(manager, 'reconcileSessions').mockResolvedValue({ alive: [ID], dead: [], discovered: [] });
    vi.spyOn(manager, 'muxSessionExists').mockReturnValue(true);
    vi.spyOn(manager, 'isPaneDead').mockReturnValue(false);
    vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);
    const server = new WebServer(0, false, true);
    servers.push(server);
    Reflect.set(server, 'mux', manager);
    for (const method of [
      'startStatsCollection',
      'startMouseModeSync',
      'startPaneExitWatcher',
      'startRemoteReconnectWatcher',
      'destroy',
    ] as const)
      vi.spyOn(manager, method).mockImplementation(() => {});
    vi.spyOn(
      server as unknown as { getWorkspaceHooksEnabled(): Promise<boolean> },
      'getWorkspaceHooksEnabled'
    ).mockResolvedValue(false);
    vi.spyOn(
      server as unknown as { setupSessionListeners(session: SessionType): Promise<void> },
      'setupSessionListeners'
    ).mockResolvedValue();
    const store = Reflect.get(server, 'store') as import('../src/state-store.js').StateStore;
    const saved: SessionState = {
      id: ID,
      mode,
      owner: record.owner,
      workingDir: root,
      pid: 1234,
      status: 'idle',
      currentTaskId: null,
      createdAt: record.createdAt,
      codexConfig: launchConfig,
      ...savedPatch,
    };
    Object.assign(saved, { __codexRecoveryHome: home, __envOverrides: { CODEX_HOME: home } });
    store.setSession(ID, saved);
    store.flush();
    const historical = structuredClone(store.getSession(ID));
    expect(await Reflect.get(server, 'restoreMuxSessions').call(server)).toBe(true);
    const session = Reflect.get(server, 'sessions').get(ID) as SessionType;
    sessions.push(session);
    expect(session).toBeDefined();
    return { server, store, session, home, launchConfig, record, historical };
  }

  it.each(['codex', 'restart-codex'])(
    'normal server restart preserves %s exact launch settings into a later verified reboot offer',
    async (mode) => {
      const f = await restartFixture(mode);
      expect(f.session.codexConfig).toEqual(f.launchConfig);
      expect(f.session.getRecoveryContext()).toMatchObject({ noDaemon: true, codexHome: f.home });
      expect(effects.attach).toHaveBeenCalledOnce();
      expect(
        effects.sync.mock.calls.some(
          ([command]) => command.includes('new-session ') || command.includes('respawn-pane ')
        )
      ).toBe(false);
      Reflect.get(f.server, '_persistSessionStateNow').call(f.server, f.session);
      f.store.flush();
      const saved = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')).sessions[ID] as SessionState;
      expect(saved).toMatchObject({
        mode,
        owner: 'fixture-owner',
        workingDir: root,
        codexConfig: f.launchConfig,
        __codexRecoveryHome: f.home,
        __codexInputBroker: null,
      });
      mkdirSync(join(f.home, 'sessions'), { recursive: true });
      writeFileSync(
        join(f.home, 'sessions', `rollout-2026-10-16T12-00-00-${THREAD}.jsonl`),
        JSON.stringify({
          type: 'session_meta',
          timestamp: new Date(Date.now() - 30_000).toISOString(),
          payload: { id: THREAD, cwd: root, originator: `codeman_${ID}` },
        }) + '\n'
      );
      const bindings = await captureRebootBrokerBindings({ [ID]: saved });
      expect(bindings).toEqual(new Map([[ID, null]]));
      const plan = await planVerifiedRebootRestore(
        [ID],
        { [ID]: saved },
        async () => ({ status: 'present', dev: 1, ino: 1 }),
        bindings
      );
      expect(plan.skipped).toEqual([]);
      expect(plan.restore).toHaveLength(1);
      expect(plan.restore[0]).toMatchObject({
        sessionId: ID,
        mode,
        resumeConversationId: THREAD,
        state: { codexConfig: f.launchConfig },
      });
    }
  );
  it.each(['restart-capability-only', 'restart-config-only'])(
    'restores settings declared by the registered %s CLI without inferring extra recovery authority',
    async (mode) => {
      const f = await restartFixture(mode);
      expect(f.session.codexConfig).toEqual(f.launchConfig);
      expect(f.session.toState().mode).toBe(mode);
      Reflect.get(f.server, '_persistSessionStateNow').call(f.server, f.session);
      f.store.flush();
      const saved = f.store.getSession(ID)!;
      expect(saved.codexConfig).toEqual(f.launchConfig);
      expect(await captureRebootBrokerBindings({ [ID]: saved })).toEqual(
        mode === 'restart-capability-only' ? new Map([[ID, null]]) : new Map()
      );
    }
  );
  it.each(['restart-unrelated', 'unregistered-restart-cli'])(
    'does not inject Codex settings into unrelated or unregistered mode %s',
    async (mode) => {
      const f = await restartFixture(mode);
      expect(f.session.codexConfig).toBeUndefined();
      expect(f.session.getRecoveryContext().noDaemon).toBe(false);
      expect(await captureRebootBrokerBindings({ [ID]: f.session.toState() })).toEqual(new Map());
    }
  );
  it.each(['codex', 'restart-config-only', 'unregistered-restart-cli'])(
    'a custom native CLI cannot borrow launch settings saved for %s',
    async (savedMode) => {
      const f = await restartFixture('restart-codex', { mode: savedMode });
      expect(f.session.codexConfig).toBeUndefined();
      expect(f.session.getRecoveryContext().noDaemon).toBe(false);
      expect(
        effects.sync.mock.calls.some(
          ([command]) => command.includes('new-session ') || command.includes('respawn-pane ')
        )
      ).toBe(false);
    }
  );
  it('retains uncertain native settings for inspection and cannot overwrite historical configuration', async () => {
    const nativeConfig = { ...config, model: 'uncertain-native-model', sandbox: 'workspace-write' as const };
    const f = await restartFixture(
      'restart-codex',
      {},
      { codexRestoreUncertain: true, codexRestoreConfig: nativeConfig }
    );
    expect(f.session.codexConfig).toEqual(nativeConfig);
    expect(f.session.getRecoveryContext().managed).toBe(false);
    Reflect.get(f.server, '_persistSessionStateNow').call(f.server, f.session);
    f.store.flush();
    expect(f.store.getSession(ID)).toEqual(f.historical);
    expect(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')).sessions[ID]).toEqual(f.historical);
    expect(
      effects.sync.mock.calls.some(([command]) => command.includes('new-session ') || command.includes('respawn-pane '))
    ).toBe(false);
  });
});

describe('registered Codex-compatible uncertain launch adoption', () => {
  beforeEach(() => {
    const codex = getCli('codex')!;
    writeFileSync(
      join(root, 'clis.json'),
      JSON.stringify({
        schemaVersion: 1,
        clis: {
          'adopt-codex': { ...codex, id: 'adopt-codex', label: 'Adopt Codex', order: 990 },
          'other-adopt-codex': { ...codex, id: 'other-adopt-codex', label: 'Other Codex', order: 991 },
          'unsupported-adopt': {
            ...codex,
            id: 'unsupported-adopt',
            label: 'Unsupported adoption',
            order: 992,
            capabilities: { ...codex.capabilities, recovery: undefined },
          },
        },
      }),
      { mode: 0o600 }
    );
    reloadCliRegistry();
  });
  afterEach(() => {
    rmSync(join(root, 'clis.json'), { force: true });
    reloadCliRegistry();
  });

  it.each(
    (['codex', 'adopt-codex'] as const).flatMap((mode) =>
      (['startup-receipt', 'metadata-ack'] as const).map((failure) => ({ mode, failure }))
    )
  )('retains an ordinary $mode worker for inspection after $failure', async ({ mode, failure }) => {
    const { manager, home, getBroker } = fixture();
    const broker = await getBroker();
    const durableFlush = manager.flushSessionsDurably.bind(manager);
    if (failure === 'startup-receipt')
      vi.mocked(broker.startupReceipt).mockRejectedValue(Error('Ordinary startup receipt lost'));
    else {
      let acknowledgements = 0;
      vi.spyOn(manager, 'flushSessionsDurably').mockImplementation(async (...args) => {
        if (++acknowledgements === 2) throw Error('Ordinary metadata acknowledgement lost');
        return durableFlush(...args);
      });
    }
    const session = new Session({
      id: ID,
      mode,
      owner: 'worker',
      workingDir: root,
      useMux: true,
      mux: manager,
      codexConfig: config,
      recoveryCodexHome: home,
    });
    sessions.push(session);
    await expect(session.startInteractive()).rejects.toThrow();
    const record = manager.getSession(ID)!;
    expect(session.codexRestoreWorkerMayExist).toBe(true);
    expect(Reflect.get(session, '_muxSession')).toBe(record);
    expect(record).toMatchObject({
      mode,
      owner: 'worker',
      workingDir: root,
      recoveryInputBrokerPending: broker.incarnation,
      codexRestoreUncertain: true,
    });
    expect(session.getRecoveryContext()).toMatchObject({ managed: false, switchPending: true, untrackedInput: true });
    expect(effects.attach).not.toHaveBeenCalled();

    // Exercise the quick-start failure cleanup which must keep this exact pane.
    const server = Object.create(WebServer.prototype) as ServerType;
    const board = new Map([[ID, session]]);
    Reflect.set(server, 'sessions', board);
    Reflect.set(server, 'mux', manager);
    Reflect.set(server, 'cleaningUp', new Set());
    Reflect.set(server, 'tentativeSessionRegistrations', new WeakSet());
    Reflect.set(server, 'persistDeb', { cancelKey: vi.fn() });
    Reflect.set(
      server,
      'stopRecoveryController',
      vi.fn(async () => {})
    );
    Reflect.set(server, 'broadcast', vi.fn());
    Reflect.set(
      server,
      'getSessionStateWithRespawn',
      vi.fn(() => ({ id: ID }))
    );
    const kill = vi.spyOn(manager, 'killSession');
    // The deliberately lost acknowledgement above was one-shot; owner cleanup
    // must still acknowledge its retained uncertainty without creating a worker.
    vi.spyOn(manager, 'flushSessionsDurably').mockImplementation(durableFlush);
    await server.discardPartiallyBuiltSession(ID, session);
    expect(board.get(ID)).toBe(session);
    expect(manager.getSession(ID)).toBe(record);
    expect(kill).not.toHaveBeenCalled();
    expect(effects.sync.mock.calls.filter(([command]) => command.includes('respawn-pane '))).toHaveLength(1);
    expect(
      effects.sync.mock.calls.some(([command]) => command.includes('kill-pane ') || command.includes('kill-session '))
    ).toBe(false);
    expect(effects.attach).not.toHaveBeenCalled();
  });

  it('keeps an ordinary uncertain custom worker from adopting another capable CLI identity', async () => {
    const { manager, home, getBroker } = fixture();
    vi.mocked((await getBroker()).startupReceipt).mockRejectedValue(Error('Ordinary startup receipt lost'));
    const session = new Session({
      id: ID,
      mode: 'adopt-codex',
      owner: 'worker',
      workingDir: root,
      useMux: true,
      mux: manager,
      codexConfig: config,
      recoveryCodexHome: home,
    });
    sessions.push(session);
    await expect(session.startInteractive()).rejects.toThrow();
    expect(session.codexRestoreWorkerMayExist).toBe(true);
    const retained = manager.getSession(ID)!;
    for (const mode of ['codex', 'other-adopt-codex', 'unsupported-adopt', 'unregistered-adopt']) {
      retained.mode = mode;
      expect(session.adoptUncertainCodexRestore()).toBe(false);
      expect(manager.getSession(ID)).toBe(retained);
    }
    retained.mode = 'adopt-codex';
    expect(session.adoptUncertainCodexRestore()).toBe(true);
    expect(effects.sync.mock.calls.filter(([command]) => command.includes('respawn-pane '))).toHaveLength(1);
    expect(effects.attach).not.toHaveBeenCalled();
  });

  it('attaches a healthy ordinary custom launch without manufacturing uncertainty', async () => {
    const { manager, home, getBroker } = fixture();
    const session = new Session({
      id: ID,
      mode: 'adopt-codex',
      owner: 'worker',
      workingDir: root,
      useMux: true,
      mux: manager,
      codexConfig: config,
      recoveryCodexHome: home,
    });
    sessions.push(session);
    await session.startInteractive();
    expect(session.codexRestoreWorkerMayExist).toBe(false);
    expect(manager.getSession(ID)?.mode).toBe('adopt-codex');
    expect(manager.getSession(ID)?.recoveryInputBroker).toBe((await getBroker()).incarnation);
    expect(manager.getSession(ID)?.recoveryInputBrokerPending).toBeUndefined();
    expect(manager.getSession(ID)?.codexRestoreUncertain).toBeUndefined();
    expect(effects.attach).toHaveBeenCalledOnce();
    expect(effects.sync.mock.calls.filter(([command]) => command.includes('respawn-pane '))).toHaveLength(1);
  });

  it.each(
    (['throw', 'timeout'] as const).flatMap((failure) =>
      (
        [
          'exact',
          'stock-mode',
          'other-capable-mode',
          'unsupported-mode',
          'unknown-mode',
          'different-owner',
          'different-session',
          'different-directory',
          'different-home',
          'different-config',
          'absent',
        ] as const
      ).map((metadataKind) => ({ failure, metadataKind }))
    )
  )('adopts only our exact custom worker after $failure: $metadataKind', async ({ failure, metadataKind }) => {
    const { manager, home, getBroker } = fixture();
    if (failure === 'throw') {
      effects.sync.mockImplementation((command: string) => {
        if (command.includes('respawn-pane ')) throw new Error('Fixture dispatch receipt lost');
        return nativeOutput(command);
      });
    } else {
      const broker = await getBroker();
      // A bounded startup-receipt timeout cannot establish whether the child started.
      vi.mocked(broker.startupReceipt).mockResolvedValue('unknown');
    }
    const session = new Session({
      id: ID,
      mode: 'adopt-codex',
      owner: 'worker',
      name: 'Original custom worker',
      workingDir: root,
      useMux: true,
      mux: manager,
      codexConfig: config,
      recoveryCodexHome: home,
    });
    sessions.push(session);
    session.setCodexRestoreLaunchGuard(healthyGuard());
    await expect(session.startInteractive()).rejects.toThrow();
    expect(session.codexRestoreWorkerMayExist).toBe(true);
    const record = manager.getSession(ID)!;
    expect(record).toMatchObject({ mode: 'adopt-codex', owner: 'worker', codexRestoreUncertain: true });
    if (metadataKind === 'stock-mode') record.mode = 'codex';
    if (metadataKind === 'other-capable-mode') record.mode = 'other-adopt-codex';
    if (metadataKind === 'unsupported-mode') record.mode = 'unsupported-adopt';
    if (metadataKind === 'unknown-mode') record.mode = 'unknown-adopt';
    if (metadataKind === 'different-owner') record.owner = 'another-owner';
    if (metadataKind === 'different-session') record.sessionId = randomUUID();
    if (metadataKind === 'different-directory') record.workingDir = join(root, 'other-directory');
    if (metadataKind === 'different-home') record.recoveryCodexHome = join(root, 'other-home');
    if (metadataKind === 'different-config') record.codexRestoreConfig = { ...config, model: 'other-model' };
    if (metadataKind === 'absent') Reflect.get(manager, 'sessions').delete(ID);
    expect(session.adoptUncertainCodexRestore()).toBe(metadataKind === 'exact');
    expect(session.getRecoveryContext().managed).toBe(false);
    if (metadataKind === 'exact') {
      expect(session.getRecoveryContext()).toMatchObject({ switchPending: true, untrackedInput: true });
      expect(manager.getSession(ID)).toMatchObject({
        sessionId: ID,
        mode: 'adopt-codex',
        owner: 'worker',
        workingDir: root,
        recoveryCodexHome: home,
        codexRestoreConfig: config,
        codexRestoreUncertain: true,
      });
      vi.spyOn(manager, 'muxSessionExists').mockReturnValue(true);
      vi.spyOn(manager, 'isPaneDead').mockReturnValue(false);
      await session.startInteractive();
      expect(effects.attach).toHaveBeenCalledOnce();
    } else {
      await expect(session.startInteractive()).rejects.toThrow();
      expect(effects.attach).not.toHaveBeenCalled();
    }
    expect(effects.sync.mock.calls.filter(([command]) => command.includes('respawn-pane '))).toHaveLength(1);
    expect(effects.sync.mock.calls.some(([command]) => command.includes('kill-pane '))).toBe(false);
  });
});

// The final native command must consume the opened-directory proof, including
// the broker's inner child command. Native tmux/worker effects remain injected.
it.each(['codex', 'claude'] as const)('binds %s guarded cwd across a post-proof symlink replacement', async (mode) => {
  const workspaceModule = await import('../src/recovery/reboot-workspace-launch.js');
  const { renameSync, symlinkSync } = await import('node:fs');
  const { manager, home, getBroker } = fixture();
  const priorMultiuser = process.env.CODEMAN_MULTIUSER;
  const priorSpaces = process.env.CODEMAN_USER_SPACES_DIR;
  const spaces = join(root, randomUUID());
  const workspace = join(spaces, 'alice', 'cases', 'workspace');
  const outside = join(root, randomUUID());
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, 'users.json'), JSON.stringify({ version: 1, users: [{ username: 'alice', role: 'user' }] }));
  process.env.CODEMAN_MULTIUSER = '1';
  process.env.CODEMAN_USER_SPACES_DIR = spaces;
  invalidateUsersCache();
  const prepare = workspaceModule.prepareRebootWorkspaceLaunch;
  let wrapped = '',
    original = '';
  vi.spyOn(workspaceModule, 'prepareRebootWorkspaceLaunch').mockImplementation(async (...args) => {
    const lease = await prepare(...args);
    if (!lease) return undefined;
    const wrap = lease.wrap;
    lease.wrap = (command) => {
      original = command;
      wrapped = wrap(command);
      return wrapped;
    };
    return lease;
  });
  let brokerCommand = '';
  vi.spyOn(
    manager as unknown as { createInputBroker(id: string, command: string): Promise<CodexInputBroker> },
    'createInputBroker'
  ).mockImplementation(async (_id, command) => {
    brokerCommand = command;
    return getBroker();
  });
  let swapped = false;
  effects.sync.mockImplementation((command) => {
    if (command.includes(' new-session ')) {
      renameSync(workspace, workspace + '-original');
      symlinkSync(outside, workspace, 'dir');
      swapped = true;
    }
    return nativeOutput(command);
  });
  const deadline = performance.now() + 2000;
  const guard = {
    prepare: async () => {},
    confirm: () => true,
    isCurrent: () => true,
    getWorkspaceDeadline: () => deadline,
  };
  try {
    const created = await manager.createSession({
      sessionId: ID,
      workingDir: workspace,
      mode,
      owner: 'alice',
      ...(mode === 'codex'
        ? {
            codexConfig: config,
            recoveryCodexHome: home,
            codexRestoreGuard: { ...guard, getStartupEvidence: () => ({ files: [], paths: [], missing: [] }) },
          }
        : { restoreGuard: guard }),
    });
    expect(swapped).toBe(true);
    expect(created.workingDir).toBe(workspace);
    expect(original).not.toContain(`cd '${workspace}'`);
    expect(wrapped).toContain(process.execPath);
    expect(wrapped).toContain('fs.fstatSync');
    expect(wrapped).toContain('process.execve');
    expect(wrapped).toContain('process.chdir');
    if (mode === 'codex') expect(brokerCommand).toBe(wrapped);
    else
      expect(
        effects.sync.mock.calls.some(
          ([command]) => command.includes('respawn-pane') && command.includes('process.execve')
        )
      ).toBe(true);
    expect(effects.sync.mock.calls.filter(([command]) => command.includes('respawn-pane'))).toHaveLength(1);
  } finally {
    if (priorMultiuser === undefined) delete process.env.CODEMAN_MULTIUSER;
    else process.env.CODEMAN_MULTIUSER = priorMultiuser;
    if (priorSpaces === undefined) delete process.env.CODEMAN_USER_SPACES_DIR;
    else process.env.CODEMAN_USER_SPACES_DIR = priorSpaces;
    invalidateUsersCache();
  }
});
