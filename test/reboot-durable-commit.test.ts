/** Actual reboot route, StateStore and fake in-memory tmux; all files live under the isolated test HOME. */
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dataPath } from '../src/config/instance.js';
import { planVerifiedRebootRestore } from '../src/reboot-restore.js';
import { StateStore } from '../src/state-store.js';
import { Session } from '../src/session.js';
import { TmuxManager } from '../src/tmux-manager.js';
import type { SessionState } from '../src/types.js';
import { rebootRestoreRegistry } from '../src/web/reboot-restore-registry.js';
import { registerRebootRestoreRoutes } from '../src/web/routes/reboot-restore-routes.js';
import { WebServer } from '../src/web/server.js';
import { createDeferred } from './mocks/index.js';

const io = vi.hoisted(() => ({
  paths: new Map<number, string>(),
  lastFile: '',
  phases: [] as string[],
  fault: '',
  blockedWrite: undefined as Promise<void> | undefined,
  blockPrefix: '',
  entered: false,
  targetSessionId: '',
  finalizingMux: false,
}));
vi.mock('node:fs', async () => {
  const real = await vi.importActual<typeof import('node:fs')>('node:fs');
  const open = (...args: Parameters<typeof real.openSync>) => {
    const fd = real.openSync(...args);
    io.paths.set(fd, String(args[0]));
    return fd;
  };
  const sync = (fd: number) => {
    const path = io.paths.get(fd) ?? '';
    if (!real.fstatSync(fd).isDirectory()) {
      io.lastFile = path;
      if (path.includes('mux-sessions.json.')) {
        const records = JSON.parse(real.readFileSync(path, 'utf8')) as Array<{
          sessionId: string;
          codexRestoreUncertain?: boolean;
        }>;
        io.finalizingMux =
          records.find((record) => record.sessionId === io.targetSessionId)?.codexRestoreUncertain === false;
      }
    }
    const domain = io.lastFile.includes('mux-sessions.json.')
      ? 'mux'
      : io.lastFile.includes('state.json.')
        ? 'state'
        : '';
    const phase = domain
      ? `${domain}${domain === 'mux' && io.finalizingMux ? '-clear' : ''}-${real.fstatSync(fd).isDirectory() ? 'directory' : 'file'}`
      : '';
    if (phase) io.phases.push(phase);
    if (phase && io.fault === phase) {
      io.fault = '';
      throw new Error('Fixture durability acknowledgement failed');
    }
    real.fsyncSync(fd);
  };
  return { ...real, default: { ...real, openSync: open, fsyncSync: sync }, openSync: open, fsyncSync: sync };
});
vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...real,
    writeFile: async (...args: Parameters<typeof real.writeFile>) => {
      if (io.blockedWrite && String(args[0]).startsWith(io.blockPrefix)) {
        const wait = io.blockedWrite;
        io.blockedWrite = undefined;
        io.entered = true;
        await wait;
      }
      return real.writeFile(...args);
    },
  };
});

const THREAD = '11111111-2222-3333-4444-555555555555';
let app: FastifyInstance | undefined;
let server: WebServer | undefined;
beforeEach(() => {
  io.phases = [];
  io.fault = '';
  io.lastFile = '';
  io.entered = false;
});
afterEach(async () => {
  io.fault = '';
  io.blockedWrite = undefined;
  await app?.close();
  await server?.stop();
  app = undefined;
  server = undefined;
  rebootRestoreRegistry.reset();
  vi.restoreAllMocks();
});
async function fixture(label: string, pruned = false) {
  const id = `${createHash('sha256').update(label).digest('hex').slice(0, 8)}-1111-2222-3333-444444444444`;
  const home = join(homedir(), 'durable-homes', label);
  const work = join(home, 'workspace');
  fs.mkdirSync(join(home, 'sessions'), { recursive: true });
  fs.mkdirSync(work);
  fs.writeFileSync(
    join(home, 'sessions', `rollout-2026-10-13T15-00-00-${THREAD}.jsonl`),
    JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-10-13T15:00:00Z',
      payload: { id: THREAD, cwd: work, originator: `codeman_${id}` },
    }) + '\n'
  );
  const state = {
    id,
    workingDir: work,
    mode: 'codex',
    pid: 1234,
    status: 'idle',
    currentTaskId: null,
    createdAt: Date.now() - 60000,
    inputTokens: 234,
    outputTokens: 123,
    totalCost: 12,
    codexConfig: {
      noDaemon: true,
      resumeSessionId: THREAD,
      model: 'fixture-model',
      reasoningEffort: 'high',
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
    },
    __codexRecoveryHome: home,
    __envOverrides: { CODEX_HOME: home },
  } as SessionState;
  vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);
  server = new WebServer(0, false, true);
  const store = Reflect.get(server, 'store') as StateStore;
  store.setSession(id, state);
  store.flush();
  rebootRestoreRegistry.configurePersistence(dataPath('reboot-restore-offer.json'));
  const plan = await planVerifiedRebootRestore([id], { [id]: state }, () => true);
  expect(plan.restore).toHaveLength(1);
  rebootRestoreRegistry.set(plan.restore);
  if (pruned) {
    store.removeSession(id);
    store.flush();
  }
  const ctx = Reflect.get(server, 'createRouteContext').call(server) as Parameters<
    typeof registerRebootRestoreRoutes
  >[1];
  ctx.getWorkspaceHooksEnabled = async () => false;
  ctx.getAgentSkillEnabled = async () => false;
  app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  registerRebootRestoreRoutes(app, ctx);
  await app.ready();
  const historical = fs.readFileSync(dataPath('state.json'), 'utf8');
  io.phases = [];
  io.lastFile = '';
  io.targetSessionId = id;
  io.finalizingMux = false;
  return {
    id,
    state,
    home,
    store,
    ctx,
    historical,
    restore: () => app!.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} }),
  };
}
function offers(): any[] {
  return JSON.parse(fs.readFileSync(dataPath('reboot-restore-offer.json'), 'utf8')).entries;
}

it.each([false, true])(
  'commits exact unpinned recovery state and mux durability before consuming the offer; pruned=%s',
  async (pruned) => {
    const f = await fixture(pruned ? 'pruned' : 'saved', pruned);
    const result = (await f.restore()).json();
    expect(result.restored).toHaveLength(1);
    expect(offers()).toEqual([]);
    const disk = new StateStore(dataPath('state.json')).getSession(f.id) as SessionState & {
      __codexRecoveryHome: string;
    };
    expect(disk).toMatchObject({
      inputTokens: 234,
      outputTokens: 123,
      totalCost: 12,
      codexConfig: f.state.codexConfig,
      __codexRecoveryHome: f.home,
    });
    expect(disk.pid).toBe(f.ctx.sessions.get(f.id)!.pid);
    expect(disk.pid).not.toBe(1234);
    expect(JSON.parse(fs.readFileSync(dataPath('mux-sessions.json'), 'utf8'))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: f.id,
          recoveryCodexHome: f.home,
          recoveryIsolated: true,
          codexRestoreUncertain: false,
        }),
      ])
    );
    expect(io.phases.indexOf('mux-directory')).toBeLessThan(io.phases.indexOf('state-file'));
    expect(io.phases).toContain('state-directory');
    expect(io.phases.indexOf('mux-clear-directory')).toBeLessThan(io.phases.indexOf('state-file'));
    expect(f.ctx.sessions.get(f.id)!.codexRestoreWorkerMayExist).toBe(false);
  }
);
it.each(['state-file', 'state-directory', 'mux-file', 'mux-directory', 'mux-clear-file', 'mux-clear-directory'])(
  'retains history, offer, and possibly running worker when %s durability fails',
  async (fault) => {
    const f = await fixture(fault);
    const kill = vi.spyOn(f.ctx.mux, 'killSession');
    io.fault = fault;
    const result = (await f.restore()).json();
    expect(result.restored).toEqual([]);
    expect(result.skipped).toEqual([{ sessionId: f.id, reason: 'restore-uncertain' }]);
    expect(offers()).toHaveLength(1);
    expect(offers()[0].state).toEqual(f.state);
    expect(fs.readFileSync(dataPath('state.json'), 'utf8')).toBe(f.historical);
    expect(f.store.getSession(f.id)).toEqual(f.state);
    expect(kill).not.toHaveBeenCalled();
    expect(f.ctx.mux.getSession(f.id)).toMatchObject({
      codexRestoreUncertain: true,
      recoveryCodexHome: f.home,
      codexRestoreConfig: f.state.codexConfig,
    });
    expect(f.ctx.sessions.get(f.id)!.codexRestoreWorkerMayExist).toBe(true);
    expect(JSON.parse(fs.readFileSync(dataPath('mux-sessions.json'), 'utf8'))).toEqual(
      expect.arrayContaining([expect.objectContaining({ sessionId: f.id, codexRestoreUncertain: true })])
    );
  }
);
it.each(['complete', 'cancel'])(
  'keeps the durable offer and historical state through deferred mux persistence: %s',
  async (outcome) => {
    const f = await fixture(`mux-${outcome}`);
    const gate = createDeferred<void>();
    const entered = createDeferred<void>();
    const flush = f.ctx.mux.flushSessionsDurably.bind(f.ctx.mux);
    vi.spyOn(f.ctx.mux, 'flushSessionsDurably').mockImplementation(async (current) => {
      entered.resolve();
      await gate.promise;
      await flush(current);
    });
    let completed = false;
    const result = f.restore().then((reply) => {
      completed = true;
      return reply;
    });
    await entered.promise;
    expect(completed).toBe(false);
    expect(offers()).toHaveLength(1);
    expect(fs.readFileSync(dataPath('state.json'), 'utf8')).toBe(f.historical);
    if (outcome === 'cancel') rebootRestoreRegistry.clear(() => true);
    gate.resolve();
    const reply = (await result).json();
    expect(reply.restored).toHaveLength(outcome === 'complete' ? 1 : 0);
    if (outcome === 'cancel') expect(fs.readFileSync(dataPath('state.json'), 'utf8')).toBe(f.historical);
  }
);
it.each(['complete', 'cancel', 'state-failure'] as const)(
  'holds the offer and live worker veto after durable uncertainty clearance until state commit (%s)',
  async (outcome) => {
    const f = await fixture(`mux-clear-${outcome}`);
    const gate = createDeferred<void>();
    const entered = createDeferred<void>();
    const flush = f.ctx.mux.flushSessionsDurably.bind(f.ctx.mux);
    const kill = vi.spyOn(f.ctx.mux, 'killSession');
    let held = false;
    vi.spyOn(f.ctx.mux, 'flushSessionsDurably').mockImplementation(async (current) => {
      await flush(current);
      if (!held && f.ctx.mux.getSession(f.id)?.codexRestoreUncertain === false) {
        held = true;
        entered.resolve();
        await gate.promise;
      }
    });
    const restoring = f.restore();
    await entered.promise;
    try {
      expect(offers()).toHaveLength(1);
      expect(fs.readFileSync(dataPath('state.json'), 'utf8')).toBe(f.historical);
      expect(f.store.getSession(f.id)).toEqual(f.state);
      const worker = f.ctx.sessions.get(f.id)!;
      expect(worker.codexRestoreWorkerMayExist).toBe(true);
      expect(worker.getRecoveryContext().managed).toBe(false);
      expect(JSON.parse(fs.readFileSync(dataPath('mux-sessions.json'), 'utf8'))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionId: f.id,
            codexRestoreUncertain: false,
            recoveryCodexHome: f.home,
            codexRestoreConfig: f.state.codexConfig,
          }),
        ])
      );
      if (outcome === 'cancel') rebootRestoreRegistry.clear(() => true);
      if (outcome === 'state-failure')
        vi.spyOn(f.store, 'persistSessionDurably').mockRejectedValueOnce(
          new Error('Fixture state journal unavailable')
        );
    } finally {
      gate.resolve();
    }
    const reply = (await restoring).json();
    expect(reply.restored).toHaveLength(outcome === 'complete' ? 1 : 0);
    expect(kill).not.toHaveBeenCalled();
    expect(offers()).toHaveLength(outcome === 'state-failure' ? 1 : 0);
    const record = f.ctx.mux.getSession(f.id)!;
    expect(record.codexRestoreUncertain).toBe(outcome !== 'complete');
    expect(record.codexRestoreConfig).toEqual(f.state.codexConfig);
    expect(record.recoveryCodexHome).toBe(f.home);
    expect(JSON.parse(fs.readFileSync(dataPath('mux-sessions.json'), 'utf8'))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: f.id, codexRestoreUncertain: outcome !== 'complete' }),
      ])
    );
    if (outcome !== 'complete') {
      expect(fs.readFileSync(dataPath('state.json'), 'utf8')).toBe(f.historical);
      expect(f.store.getSession(f.id)).toEqual(f.state);
      expect(f.ctx.sessions.get(f.id)!.codexRestoreWorkerMayExist).toBe(true);
    }
  }
);

it('waits for an older asynchronous main-state snapshot so it cannot overwrite the acknowledged restored record', async () => {
  const f = await fixture('older');
  const gate = createDeferred<void>();
  io.blockPrefix = dataPath('state.json') + '.';
  io.blockedWrite = gate.promise;
  f.store.setSession(f.id, f.state);
  const older = f.store.saveNowAsync();
  await vi.waitFor(() => expect(io.entered).toBe(true));
  let completed = false;
  const result = f.restore().then((reply) => {
    completed = true;
    return reply;
  });
  await vi.waitFor(() => expect(f.ctx.mux.getSession(f.id)).toBeDefined());
  expect(completed).toBe(false);
  expect(offers()).toHaveLength(1);
  f.ctx.sessions.get(f.id)!.restoreTokens(235, 124, 13);
  gate.resolve();
  await older;
  expect((await result).json().restored).toHaveLength(1);
  expect(new StateStore(dataPath('state.json')).getSession(f.id)?.pid).toBe(f.ctx.sessions.get(f.id)!.pid);
  expect(new StateStore(dataPath('state.json')).getSession(f.id)).toMatchObject({
    inputTokens: 235,
    outputTokens: 124,
    totalCost: 13,
  });
  expect(offers()).toEqual([]);
});

it('waits for an older mux rename before acknowledging current exact home and isolation metadata', async () => {
  const f = await fixture('older-mux');
  const gate = createDeferred<void>();
  const previousWrite = gate.promise.then(() => fs.writeFileSync(dataPath('mux-sessions.json'), '[]'));
  Reflect.set(f.ctx.mux, 'sessionSaves', previousWrite);
  let completed = false;
  const result = f.restore().then((reply) => {
    completed = true;
    return reply;
  });
  await vi.waitFor(() => expect(f.ctx.mux.getSession(f.id)).toBeDefined());
  expect(completed).toBe(false);
  expect(offers()).toHaveLength(1);
  gate.resolve();
  await previousWrite;
  expect((await result).json().restored).toHaveLength(1);
  expect(JSON.parse(fs.readFileSync(dataPath('mux-sessions.json'), 'utf8'))).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        sessionId: f.id,
        recoveryCodexHome: f.home,
        recoveryIsolated: true,
        codexRestoreUncertain: false,
      }),
    ])
  );
});

it.each(['state.json', 'mux-sessions.json'])('preserves malformed %s instead of consuming an offer', async (file) => {
  const f = await fixture(`malformed-${file}`);
  fs.writeFileSync(dataPath(file), '{malformed-fixture}');
  const result = (await f.restore()).json();
  expect(result.restored).toEqual([]);
  expect(offers()).toHaveLength(1);
  expect(fs.readFileSync(dataPath(file), 'utf8')).toBe('{malformed-fixture}');
});
