/**
 * Reboot-restore route: what happens when a rebuild gets part-way and then fails.
 *
 * The other route test file deliberately uses workspaces that do not exist, so it
 * never reaches `new Session()`. This one mocks the `Session` module so the route
 * runs its whole construction path — `addSession`, `setupSessionListeners`,
 * `reapplyPersistedSessionState`, `startInteractive` — and then throws.
 *
 * The mock is the only way in. Driven against a real server, `startInteractive()`
 * does not throw for either obvious cause: the CLI resolver finds its binary by
 * absolute path rather than through PATH, and tmux falls back to another
 * directory rather than failing when it cannot enter the workspace. A mux-layer
 * failure is what is left, and it cannot be provoked from a test. Without the
 * mock this path would go unexercised, which is how the original version of this
 * route shipped a session leak the tests could not see.
 *
 * It also covers the session caps, because those too are only reachable once the
 * route is actually willing to build something.
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dataPath, getDataDir } from '../../src/config/instance.js';
import { writeCustomModelHosts, type CustomModelHost } from '../../src/custom-model-hosts.js';
import { customModelConfigDir } from '../../src/custom-model-injection-apply.js';
import { createUser, deleteUser, invalidateUsersCache } from '../../src/user-store.js';

/** Set per test: whether the mocked `startInteractive()` rejects. */
let startShouldThrow = false;
let startBarrier: Promise<void> | undefined;
/** Ordering log, so a test can assert what ran before the pane spawned. */
const callOrder: string[] = [];
const launchConfigs: Record<string, unknown>[] = [];

vi.mock('../../src/session.js', () => ({
  Session: class {
    id: string;
    mode: string;
    name?: string;
    workingDir: string;
    owner?: string;
    claudeSessionId: string | null = null;
    restoreGuard?: import('../../src/mux-interface.js').CodexRestoreLaunchGuard;
    codexRestoreWorkerMayExist = false;
    commitCodexRestoreLaunch() {
      this.codexRestoreWorkerMayExist = false;
    }
    setCodexRestoreLaunchGuard(guard: import('../../src/mux-interface.js').CodexRestoreLaunchGuard | undefined) {
      this.restoreGuard = guard;
    }
    constructor(config: { id: string; mode?: string; name?: string; workingDir: string; owner?: string }) {
      launchConfigs.push(config as unknown as Record<string, unknown>);
      this.id = config.id;
      this.mode = config.mode ?? 'claude';
      this.name = config.name;
      this.workingDir = config.workingDir;
      this.owner = config.owner;
    }
    async startInteractive() {
      callOrder.push('startInteractive');
      await startBarrier;
      if (this.restoreGuard) {
        await this.restoreGuard.prepare();
        if (this.restoreGuard.confirm() !== true) throw new Error('Reboot restoration authority changed');
      }
      if (startShouldThrow) throw new Error('spawn claude ENOENT');
      if (this.restoreGuard) {
        this.codexRestoreWorkerMayExist = true;
        this.restoreGuard.noteDispatch?.();
      }
    }
    /** The mock route context projects a session through this on broadcast. */
    toState() {
      return { id: this.id, mode: this.mode, name: this.name, workingDir: this.workingDir, owner: this.owner };
    }
    getRecoveryContext() {
      return { switchPending: false, submission: undefined, untrackedInput: false };
    }
  },
}));

const { registerRebootRestoreRoutes } = await import('../../src/web/routes/reboot-restore-routes.js');
const { rebootRestoreRegistry } = await import('../../src/web/reboot-restore-registry.js');
const { installRouteErrorHandler } = await import('../../src/web/route-error-handler.js');
const { httpStatusForErrorCode } = await import('../../src/types.js');
const { createMockRouteContext } = await import('../mocks/index.js');
type ApiErrorCode = import('../../src/types.js').ApiErrorCode;
type RebootRestoreEntry = import('../../src/reboot-restore.js').RebootRestoreEntry;
type SessionState = import('../../src/types.js').SessionState;

/** A real directory, so the route's workspace checks pass and it reaches the build. */
const WORKSPACE = process.cwd();

function offerEntry(sessionId: string, owner?: string): RebootRestoreEntry {
  return {
    sessionId,
    name: `session ${sessionId}`,
    workingDir: WORKSPACE,
    owner,
    mode: 'claude',
    resumeConversationId: `conv-${sessionId}`,
    state: {
      id: sessionId,
      pid: null,
      status: 'idle',
      workingDir: WORKSPACE,
      currentTaskId: null,
      createdAt: 1_760_000_000_000,
      mode: 'claude',
      owner,
    } as SessionState,
  };
}

async function createHarness(ctx: ReturnType<typeof createMockRouteContext>): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  registerRebootRestoreRoutes(app, ctx as never);
  app.addHook('preSerialization', (req, reply, payload: unknown, done) => {
    if (!req.url.startsWith('/api')) return done(null, payload);
    if (payload === null || typeof payload !== 'object') return done(null, payload);
    const p = payload as { success?: unknown; errorCode?: unknown };
    if (p.success === false) {
      if (reply.statusCode === 200 && typeof p.errorCode === 'string') {
        reply.code(httpStatusForErrorCode(p.errorCode as ApiErrorCode));
      }
      return done(null, payload);
    }
    if (p.success === true) return done(null, payload);
    return done(null, { success: true, data: payload });
  });
  installRouteErrorHandler(app);
  await app.ready();
  return app;
}

beforeEach(() => {
  startShouldThrow = false;
  startBarrier = undefined;
  callOrder.length = 0;
  launchConfigs.length = 0;
});

afterEach(async () => {
  rebootRestoreRegistry.reset();
  rmSync(dataPath('reboot-identities', 'codex-original.json'), { force: true });
  await writeCustomModelHosts(getDataDir(), []);
  vi.clearAllMocks();
});

describe('a rebuild that fails after the session is registered', () => {
  it('restores Claude without depending on the Codex recovery journal', async () => {
    rebootRestoreRegistry.set([offerEntry('claude-with-full-codex-journal')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    const prepare = vi.fn(async () => {
      throw new Error('Codex journal is over capacity');
    });
    Object.assign(ctx, { prepareRebootRestoreRecovery: prepare });
    const app = await createHarness(ctx);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
      expect(response.statusCode).toBe(200);
      expect(response.json().data.restored).toHaveLength(1);
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('releases the owner lock even when final offer persistence fails', async () => {
    rebootRestoreRegistry.set([offerEntry('a')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    const app = await createHarness(ctx);
    const release = vi.spyOn(rebootRestoreRegistry, 'releaseFlight').mockImplementationOnce(() => {
      throw new Error('simulated storage failure');
    });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
      expect(response.statusCode).toBe(500);
      expect(rebootRestoreRegistry.beginSpending(undefined)).toBe(true);
      rebootRestoreRegistry.endSpending(undefined);
    } finally {
      release.mockRestore();
      await app.close();
    }
  });
  it('reports why it failed rather than blaming the workspace', async () => {
    startShouldThrow = true;
    rebootRestoreRegistry.set([offerEntry('a')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    const app = await createHarness(ctx);

    const res = (await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} })).json().data;
    expect(res.restored).toEqual([]);
    // Not `workspace-missing`: the directory is there, the agent would not start.
    expect(res.skipped).toEqual([{ sessionId: 'a', reason: 'rebuild-failed' }]);
    await app.close();
  });

  it('does not leave a registered session with no pane behind it', async () => {
    startShouldThrow = true;
    rebootRestoreRegistry.set([offerEntry('a')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    const app = await createHarness(ctx);

    await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    // The session reached ctx.sessions via addSession; the route has to take it
    // back out, or the board shows a tab whose pane never existed.
    expect(ctx.discardPartiallyBuiltSession).toHaveBeenCalledWith('a', expect.objectContaining({ id: 'a' }));
    expect(ctx.sessions.has('a')).toBe(false);
    expect(ctx.cleanupSession).not.toHaveBeenCalled();
    expect(ctx.persistSessionState).not.toHaveBeenCalled();
    // NOT the user-initiated delete: that would bank this session's historical
    // tokens into the lifetime totals, demote a pinned record to `stopped`, and
    // delete the workspace's .codeman-uploads.
    await app.close();
  });

  it('keeps the entry on offer, so the user can fix the PATH and click again', async () => {
    startShouldThrow = true;
    rebootRestoreRegistry.set([offerEntry('a')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    const app = await createHarness(ctx);

    await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    const left = (await app.inject({ method: 'GET', url: '/api/reboot-restore' })).json().data;
    expect(left.sessions.map((s: { id: string }) => s.id)).toEqual(['a']);
    await app.close();
  });
});

describe('a rebuild that succeeds', () => {
  it('re-applies the persisted state before the record is written again', async () => {
    rebootRestoreRegistry.set([offerEntry('a')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    const app = await createHarness(ctx);

    const res = (await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} })).json().data;
    expect(res.restored.map((s: { id: string }) => s.id)).toEqual(['a']);
    // A session built from a record carries none of the pin, token totals or
    // custom-model selection, so persisting it first would replace the fuller
    // record with the reduced one.
    expect(ctx.reapplyPersistedSessionState).toHaveBeenCalled();
    const reapplyOrder = (ctx.reapplyPersistedSessionState as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const persistOrder = (ctx.persistRebootRestoreDurably as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(reapplyOrder).toBeLessThan(persistOrder);
    await app.close();
  });

  it('shapes the pane before it spawns, and restores the history after', async () => {
    rebootRestoreRegistry.set([offerEntry('a')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    (ctx.reapplyPersistedSessionState as ReturnType<typeof vi.fn>).mockImplementation(
      async (_s: unknown, _saved: unknown, phase: string) => {
        callOrder.push(`reapply:${phase}`);
      }
    );
    (ctx.setupSessionListeners as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push('setupSessionListeners');
    });
    const app = await createHarness(ctx);

    await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    // `setupSessionListeners()` READS the image-watcher flag that `before-spawn`
    // restores, so the phase has to precede it or the session comes back
    // reporting the watcher as on with nothing watching. The custom-model
    // environment has to reach the process, and the token totals must not land
    // on a session whose pane never started.
    expect(callOrder).toEqual([
      'reapply:before-spawn',
      'setupSessionListeners',
      'startInteractive',
      'reapply:after-spawn',
    ]);
    await app.close();
  });

  it('tells every other board about the rebuilt session', async () => {
    rebootRestoreRegistry.set([offerEntry('a')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    const app = await createHarness(ctx);

    await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    expect(ctx.broadcast).toHaveBeenCalledWith('session:created', expect.anything());
    await app.close();
  });

  it('spends the entry, so it is no longer on offer', async () => {
    rebootRestoreRegistry.set([offerEntry('a')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    const app = await createHarness(ctx);

    await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    const left = (await app.inject({ method: 'GET', url: '/api/reboot-restore' })).json().data;
    expect(left.sessions).toEqual([]);
    await app.close();
  });
});

describe('the session caps', () => {
  it('counts the sessions it is itself creating, not just the ones it started with', async () => {
    rebootRestoreRegistry.set([offerEntry('a'), offerEntry('b')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    // One seat short of the documented maximum of 50, counting the session the
    // mock context seeds. A check that ran once before the loop would restore
    // BOTH entries; only a per-iteration check refuses the second.
    for (let i = 0; i < 48; i += 1) {
      ctx.sessions.set(`filler-${i}`, { id: `filler-${i}`, owner: undefined } as never);
    }
    const app = await createHarness(ctx);

    const res = (await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} })).json().data;
    expect(res.restored.map((s: { id: string }) => s.id)).toEqual(['a']);
    expect(res.skipped).toEqual([{ sessionId: 'b', reason: 'capacity-reached' }]);

    // Refused rather than lost: closing a session and clicking again works.
    const left = (await app.inject({ method: 'GET', url: '/api/reboot-restore' })).json().data;
    expect(left.sessions.map((s: { id: string }) => s.id)).toEqual(['b']);
    await app.close();
  });

  it('refuses every entry when the board is already at the cap', async () => {
    rebootRestoreRegistry.set([offerEntry('a'), offerEntry('b')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    for (let i = 0; i < 50; i += 1) {
      ctx.sessions.set(`filler-${i}`, { id: `filler-${i}`, owner: undefined } as never);
    }
    const app = await createHarness(ctx);

    const res = (await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} })).json().data;
    expect(res.restored).toEqual([]);
    expect(res.skipped.map((s: { reason: string }) => s.reason)).toEqual(['capacity-reached', 'capacity-reached']);
    await app.close();
  });
});

describe('a failure before any entry is considered', () => {
  it('returns the whole plan rather than spending it', async () => {
    rebootRestoreRegistry.set([offerEntry('a'), offerEntry('b')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    (ctx.getWorkspaceHooksEnabled as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('settings unreadable'));
    const app = await createHarness(ctx);

    const res = await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);

    // The plan cannot be rebuilt once boot has pruned the records, so a throw
    // anywhere in the route has to hand the entries back.
    const left = (await app.inject({ method: 'GET', url: '/api/reboot-restore' })).json().data;
    expect(left.sessions.map((s: { id: string }) => s.id).sort()).toEqual(['a', 'b']);
    await app.close();
  });

  it('releases the single flight, so the next click is not refused', async () => {
    rebootRestoreRegistry.set([offerEntry('a')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    (ctx.getWorkspaceHooksEnabled as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('settings unreadable'));
    const app = await createHarness(ctx);

    await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    expect(rebootRestoreRegistry.beginSpending(undefined)).toBe(true);
    rebootRestoreRegistry.endSpending(undefined);
    await app.close();
  });
});

describe('a dismiss that lands while a restore is running', () => {
  it('cancels and discards the exact tentative session when launch finishes after dismissal', async () => {
    rebootRestoreRegistry.set([offerEntry('a')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    let releaseStart!: () => void;
    startBarrier = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const app = await createHarness(ctx);

    const restore = app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    await vi.waitFor(() => expect(callOrder).toContain('startInteractive'));
    const dismiss = await app.inject({ method: 'POST', url: '/api/reboot-restore/dismiss', payload: {} });
    expect(dismiss.json().data.dismissed).toBe(1);
    releaseStart();

    const result = (await restore).json().data;
    expect(result.restored).toEqual([]);
    expect(result.skipped).toEqual([{ sessionId: 'a', reason: 'restore-cancelled' }]);
    expect(ctx.discardPartiallyBuiltSession).toHaveBeenCalledWith('a', expect.objectContaining({ id: 'a' }));
    expect(ctx.sessions.has('a')).toBe(false);
    expect(ctx.cleanupSession).not.toHaveBeenCalled();
    expect(ctx.persistSessionState).not.toHaveBeenCalled();
    expect(ctx.reapplyPersistedSessionState).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'after-spawn',
      expect.anything()
    );
    expect(rebootRestoreRegistry.list(() => true)).toEqual([]);
    await app.close();
  });

  it('cancels while post-start state restoration is still finishing', async () => {
    rebootRestoreRegistry.set([offerEntry('a')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    let releaseAfterSpawn!: () => void;
    const afterSpawnBarrier = new Promise<void>((resolve) => {
      releaseAfterSpawn = resolve;
    });
    ctx.reapplyPersistedSessionState.mockImplementation(async (_session, _saved, phase) => {
      if (phase === 'after-spawn') await afterSpawnBarrier;
    });
    const app = await createHarness(ctx);

    const restore = app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    await vi.waitFor(() =>
      expect(ctx.reapplyPersistedSessionState).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'after-spawn',
        {
          rearmAutoResumeSchedule: false,
        }
      )
    );
    const dismiss = await app.inject({ method: 'POST', url: '/api/reboot-restore/dismiss', payload: {} });
    expect(dismiss.json().data.dismissed).toBe(1);
    releaseAfterSpawn();

    const result = (await restore).json().data;
    expect(result.restored).toEqual([]);
    expect(result.skipped).toEqual([{ sessionId: 'a', reason: 'restore-cancelled' }]);
    expect(ctx.discardPartiallyBuiltSession).toHaveBeenCalledWith('a', expect.objectContaining({ id: 'a' }));
    expect(ctx.sessions.has('a')).toBe(false);
    expect(ctx.persistSessionState).not.toHaveBeenCalled();
    expect(ctx.broadcast).not.toHaveBeenCalled();
    expect(rebootRestoreRegistry.list(() => true)).toEqual([]);
    await app.close();
  });

  it('wins when an admin is restoring the entries and their owner dismisses', async () => {
    const theirs = offerEntry('theirs', 'bob');
    rebootRestoreRegistry.set([theirs]);
    // An admin may spend another user's entries, so the caller doing the restore
    // and the owner of what is being restored are different people.
    const taken = rebootRestoreRegistry.take(() => true, undefined, 'admin');
    expect(taken.map((e) => e.sessionId)).toEqual(['theirs']);

    // Bob dismisses his own banner. Nothing of his is in the plan any more, and
    // the restore is running under a different name than his.
    rebootRestoreRegistry.clear((owner) => owner === 'bob');
    rebootRestoreRegistry.releaseFlight('admin', taken);

    expect(rebootRestoreRegistry.list(() => true)).toEqual([]);
  });

  it('wins when an admin dismisses everything mid-restore', async () => {
    rebootRestoreRegistry.set([offerEntry('theirs', 'bob')]);
    const taken = rebootRestoreRegistry.take(() => true, undefined, 'admin');

    rebootRestoreRegistry.clear(() => true);
    rebootRestoreRegistry.releaseFlight('admin', taken);

    expect(rebootRestoreRegistry.list(() => true)).toEqual([]);
  });

  it('wins, rather than being undone when the route hands its entries back', async () => {
    rebootRestoreRegistry.set([offerEntry('a')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    // The user clicks Dismiss while the restore is between its take and its
    // return. Driven through the ROUTE, so removing the generation argument from
    // the route would make this fail.
    (ctx.getWorkspaceHooksEnabled as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      rebootRestoreRegistry.clear(() => true);
      throw new Error('settings unreadable');
    });
    const app = await createHarness(ctx);

    await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });

    const left = (await app.inject({ method: 'GET', url: '/api/reboot-restore' })).json().data;
    expect(left.sessions).toEqual([]);
    await app.close();
  });

  it('reaches an in-flight restore the dismisser can see, even once its entries are taken', async () => {
    const mine = offerEntry('mine', 'alice');
    rebootRestoreRegistry.set([mine]);
    const taken = rebootRestoreRegistry.take((owner) => owner === 'alice', undefined, 'alice');
    expect(taken).toHaveLength(1);

    // The plan is empty now, so the dismiss has nothing of Alice's left in the
    // plan; it has to reach the entry the restore is holding.
    rebootRestoreRegistry.clear((owner) => owner === 'alice');
    rebootRestoreRegistry.releaseFlight('alice', taken);

    expect(rebootRestoreRegistry.list(() => true)).toEqual([]);
  });

  it('does not reach another owner, whose unspent entries still come back', async () => {
    const mine = offerEntry('mine', 'alice');
    const theirs = offerEntry('theirs', 'bob');
    rebootRestoreRegistry.set([mine, theirs]);

    // Bob is mid-restore, holding his own entry.
    const bobsTaken = rebootRestoreRegistry.take((owner) => owner === 'bob', undefined, 'bob');
    expect(bobsTaken.map((e) => e.sessionId)).toEqual(['theirs']);

    // Alice dismisses her own banner meanwhile.
    rebootRestoreRegistry.clear((owner) => owner === 'alice');

    // Bob's restore finishes and hands his entry back. Alice's dismiss covered
    // her entries, not his, so his offer survives.
    rebootRestoreRegistry.releaseFlight('bob', bobsTaken);
    expect(rebootRestoreRegistry.list(() => true).map((e) => e.sessionId)).toEqual(['theirs']);
  });
});

describe('Codex reboot launch and cancellation', () => {
  const uuid = '12345678-1234-1234-1234-123456789abc';
  function codexOffer(): RebootRestoreEntry {
    const home = join(homedir(), 'codex-reboot-route');
    mkdirSync(join(home, 'sessions'), { recursive: true });
    writeFileSync(
      join(home, 'sessions', `rollout-2026-10-13T15-00-00-${uuid}.jsonl`),
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-10-13T15:00:00Z',
        payload: { id: uuid, cwd: WORKSPACE, originator: 'codeman_codex-original' },
      }) + '\n'
    );
    const entry = offerEntry('codex-original');
    entry.mode = 'codex';
    entry.resumeConversationId = uuid;
    entry.state.mode = 'codex';
    entry.state.pid = 1234;
    entry.state.codexConfig = {
      noDaemon: true,
      noAltScreen: true,
      resumeSessionId: uuid,
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
      model: 'custom-model',
      reasoningEffort: 'high',
    };
    (entry.state as unknown as Record<string, unknown>).__envOverrides = { CODEX_HOME: home, CODEX_OTHER: 'keep' };
    (entry.state as unknown as Record<string, unknown>).__codexRecoveryHome = home;
    return entry;
  }
  it('launches original UUID with supported settings and preserves the original journal key', async () => {
    const entry = codexOffer();
    rebootRestoreRegistry.set([entry]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    const prepare = vi.fn(async (_id: string) => {
      callOrder.push('prepareRecovery');
    });
    Object.assign(ctx, { prepareRebootRestoreRecovery: prepare });
    const app = await createHarness(ctx);
    const res = (await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} })).json().data;
    expect(res.restored.map((item: { id: string }) => item.id)).toEqual(['codex-original']);
    expect(launchConfigs[0]).toMatchObject({
      id: 'codex-original',
      mode: 'codex',
      codexConfig: entry.state.codexConfig,
      envOverrides: { CODEX_OTHER: 'keep' },
    });
    expect(launchConfigs[0].resumeSessionId).toBeUndefined();
    expect(prepare).toHaveBeenCalledWith('codex-original');
    expect(callOrder.indexOf('prepareRecovery')).toBeLessThan(callOrder.indexOf('startInteractive'));
    expect(ctx.reapplyPersistedSessionState).toHaveBeenCalledWith(expect.anything(), entry.state, 'after-spawn', {
      rearmAutoResumeSchedule: false,
    });
    await app.close();
  });
  it('rechecks the rollout on click and leaves an invalid identity on offer without launching', async () => {
    const entry = codexOffer();
    entry.state.workingDir = WORKSPACE;
    entry.state.codexConfig!.resumeSessionId = '99999999-1234-1234-1234-123456789abc';
    rebootRestoreRegistry.set([entry]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    const app = await createHarness(ctx);
    const res = (await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} })).json().data;
    expect(res.skipped).toEqual([{ sessionId: 'codex-original', reason: 'identity-unverified' }]);
    expect(launchConfigs).toEqual([]);
    expect(rebootRestoreRegistry.list(() => true)).toHaveLength(1);
    await app.close();
  });
  it.each(['enabled', 'missing', 'deleted'] as const)(
    'requires a current %s regular owner when re-deriving a custom-model home',
    async (ownerStatus) => {
      const previousMultiuser = process.env.CODEMAN_MULTIUSER;
      const previousSpaces = process.env.CODEMAN_USER_SPACES_DIR;
      const spaces = join(homedir(), 'regular-custom-model-spaces');
      process.env.CODEMAN_MULTIUSER = '1';
      process.env.CODEMAN_USER_SPACES_DIR = spaces;
      const workspace = join(spaces, 'alice', 'cases', 'project');
      mkdirSync(workspace, { recursive: true });
      const endpoint: CustomModelHost = {
        id: 'admin-endpoint',
        label: 'admin endpoint',
        baseUrl: 'http://127.0.0.1:8080',
        apiKey: 'server-owned-secret',
        models: ['custom-model'],
      };
      await writeCustomModelHosts(getDataDir(), [endpoint]);
      writeFileSync(dataPath('users.json'), JSON.stringify({ version: 1, users: [] }));
      invalidateUsersCache();
      if (ownerStatus !== 'missing') {
        const owner = await createUser({ username: 'alice', role: 'user', password: 'fixture-password' });
        expect(owner).toMatchObject({ role: 'user', disabled: false, canBypassPermissions: false });
        if (ownerStatus === 'deleted') await deleteUser('alice');
      }

      const entry = codexOffer();
      entry.owner = 'alice';
      entry.workingDir = workspace;
      entry.state.owner = 'alice';
      entry.state.workingDir = workspace;
      const trustedHome = customModelConfigDir(entry.sessionId);
      (entry.state as unknown as Record<string, unknown>).__codexRecoveryHome = trustedHome;
      mkdirSync(join(trustedHome, 'sessions'), { recursive: true });
      writeFileSync(
        join(trustedHome, 'sessions', `rollout-2026-10-13T15-00-00-${uuid}.jsonl`),
        JSON.stringify({
          type: 'session_meta',
          timestamp: '2026-10-13T15:00:00Z',
          payload: { id: uuid, cwd: workspace, originator: 'codeman_codex-original' },
        }) + '\n'
      );
      (entry.state as unknown as Record<string, unknown>).__customModel = {
        endpointId: endpoint.id,
        modelId: 'custom-model',
        envKeys: ['CODEX_HOME', 'CODEMAN_CUSTOM_MODEL_API_KEY'],
        configDir: trustedHome,
      };
      (entry.state as unknown as Record<string, unknown>).__envOverrides = {
        CODEX_HOME: join(homedir(), 'attacker-controlled-home'),
        CODEMAN_CUSTOM_MODEL_API_KEY: 'attacker-secret',
        CODEX_OTHER: 'keep',
      };
      rebootRestoreRegistry.set([entry]);
      const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
      const app = await createHarness(ctx);
      try {
        const result = (await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} })).json()
          .data;
        if (ownerStatus === 'enabled') {
          expect(result.restored.map((item: { id: string }) => item.id)).toEqual(['codex-original']);
          expect(launchConfigs[0].envOverrides).toEqual({
            CODEX_OTHER: 'keep',
            CODEX_HOME: trustedHome,
            CODEMAN_CUSTOM_MODEL_API_KEY: 'server-owned-secret',
          });
        } else {
          expect(result.restored).toEqual([]);
          expect(result.skipped).toEqual([{ sessionId: 'codex-original', reason: 'rebuild-failed' }]);
          // Construction is tentative; the final launch guard refuses before dispatch.
          expect(ctx.discardPartiallyBuiltSession).toHaveBeenCalledWith(
            'codex-original',
            expect.objectContaining({ codexRestoreWorkerMayExist: false }),
            { preserveCustomModelConfigDir: true }
          );
          expect(ctx.sessions.has('codex-original')).toBe(false);
          expect(rebootRestoreRegistry.list(() => true)).toEqual([entry]);
          expect(ctx.persistRebootRestoreDurably).not.toHaveBeenCalled();
        }
      } finally {
        await app.close();
        rmSync(dataPath('users.json'), { force: true });
        invalidateUsersCache();
        if (previousMultiuser === undefined) delete process.env.CODEMAN_MULTIUSER;
        else process.env.CODEMAN_MULTIUSER = previousMultiuser;
        if (previousSpaces === undefined) delete process.env.CODEMAN_USER_SPACES_DIR;
        else process.env.CODEMAN_USER_SPACES_DIR = previousSpaces;
      }
    }
  );
  it('rejects a regular owner persisted CODEX_HOME when no current admin endpoint authorizes it', async () => {
    const previousMultiuser = process.env.CODEMAN_MULTIUSER;
    const previousSpaces = process.env.CODEMAN_USER_SPACES_DIR;
    const spaces = join(homedir(), 'untrusted-custom-model-spaces');
    invalidateUsersCache();
    const owner = await createUser({ username: 'alice', role: 'user', password: 'fixture-password' });
    expect(owner).toMatchObject({ role: 'user', disabled: false, canBypassPermissions: false });
    process.env.CODEMAN_MULTIUSER = '1';
    process.env.CODEMAN_USER_SPACES_DIR = spaces;
    const workspace = join(spaces, 'alice', 'cases', 'project');
    mkdirSync(workspace, { recursive: true });
    const entry = codexOffer();
    entry.owner = 'alice';
    entry.workingDir = workspace;
    entry.state.owner = 'alice';
    entry.state.workingDir = workspace;
    const untrustedHome = (entry.state as unknown as { __envOverrides: Record<string, string> }).__envOverrides
      .CODEX_HOME;
    writeFileSync(
      join(untrustedHome, 'sessions', `rollout-2026-10-13T15-00-00-${uuid}.jsonl`),
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-10-13T15:00:00Z',
        payload: { id: uuid, cwd: workspace, originator: 'codeman_codex-original' },
      }) + '\n'
    );
    (entry.state as unknown as Record<string, unknown>).__customModel = {
      endpointId: 'deleted-endpoint',
      modelId: 'custom-model',
      envKeys: ['CODEX_HOME'],
    };
    rebootRestoreRegistry.set([entry]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    const app = await createHarness(ctx);
    try {
      const result = (await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} })).json()
        .data;
      expect(result.skipped).toEqual([{ sessionId: 'codex-original', reason: 'rebuild-failed' }]);
      expect(launchConfigs).toEqual([]);
    } finally {
      await app.close();
      rmSync(dataPath('users.json'), { force: true });
      invalidateUsersCache();
      if (previousMultiuser === undefined) delete process.env.CODEMAN_MULTIUSER;
      else process.env.CODEMAN_MULTIUSER = previousMultiuser;
      if (previousSpaces === undefined) delete process.env.CODEMAN_USER_SPACES_DIR;
      else process.env.CODEMAN_USER_SPACES_DIR = previousSpaces;
    }
  });
  it.each([
    { type: 'collab_agent_spawn_end', call_id: 'spawn', new_thread_id: 'child', status: 'running' },
    { type: 'exec_approval_request' },
    { type: 'error', message: 'Sanitized authentication fixture.', codex_error_info: 'unauthorized' },
  ])('rechecks a newly appended $type veto after startup preparation', async (payload) => {
    const entry = codexOffer();
    rebootRestoreRegistry.set([entry]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    ctx.setupSessionListeners.mockImplementation(async () => {
      const home = (entry.state as SessionState & { __codexRecoveryHome: string }).__codexRecoveryHome;
      appendFileSync(
        join(home, 'sessions', `rollout-2026-10-13T15-00-00-${uuid}.jsonl`),
        JSON.stringify({ timestamp: new Date(Date.now() - 1000).toISOString(), type: 'event_msg', payload }) + '\n'
      );
    });
    const app = await createHarness(ctx);
    const res = (await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} })).json().data;
    expect(res.skipped).toEqual([{ sessionId: 'codex-original', reason: 'identity-unverified' }]);
    expect(callOrder).not.toContain('startInteractive');
    expect(ctx.discardPartiallyBuiltSession).toHaveBeenCalledWith('codex-original', expect.anything());
    expect(rebootRestoreRegistry.list(() => true)).toHaveLength(1);
    await app.close();
  });

  it('dismissal during pre-spawn preparation prevents launching and releases partial registration', async () => {
    const entry = codexOffer();
    rebootRestoreRegistry.set([entry]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    ctx.reapplyPersistedSessionState.mockImplementation(async (_session, _saved, phase) => {
      if (phase === 'before-spawn') rebootRestoreRegistry.clear(() => true);
    });
    const app = await createHarness(ctx);
    const res = (await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} })).json().data;
    expect(res.skipped).toEqual([{ sessionId: 'codex-original', reason: 'restore-cancelled' }]);
    expect(callOrder).not.toContain('startInteractive');
    expect(ctx.discardPartiallyBuiltSession).toHaveBeenCalledWith(
      'codex-original',
      expect.objectContaining({ id: 'codex-original' })
    );
    expect(rebootRestoreRegistry.list(() => true)).toEqual([]);
    await app.close();
  });
});
