/**
 * `WebServer.discardPartiallyBuiltSession()` against the real server object.
 *
 * The reboot-restore route calls this when a rebuild registers a session and
 * then fails to start its pane. It has to be the exact inverse of
 * `registerSessionWithLayout()` plus `setupSessionListeners()`, and it must NOT
 * be the user-initiated delete: banking the session's token totals, demoting a
 * pinned record or deleting the workspace's files would all be wrong for a
 * session that never ran.
 *
 * These tests drive the real method rather than the route, because the route
 * tests run against a mock context whose `discardPartiallyBuiltSession` is a
 * one-line stub — an earlier version of this function left four registrations
 * behind and every route test still passed.
 *
 * The custom-model transaction block below also drives the reboot route through
 * this real WebServer. Only the launch boundary is stubbed; registration,
 * cancellation and discard use their production implementations so a cleanup
 * that recursively deletes the original CODEX_HOME is observable on disk.
 *
 * The retry assertion is the important one. `setupSessionListeners()` returns
 * early when `sessionListenerRefs` still holds the session id, so a discard that
 * leaves that entry makes the next attempt wire nothing at all, and the user
 * gets a tab that never shows output.
 */
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { safeRmHomeTree } from './mocks/test-helpers.js';
import { createDeferred } from './mocks/index.js';

import { WebServer } from '../src/web/server.js';
import { Session } from '../src/session.js';
import { TmuxManager } from '../src/tmux-manager.js';
import { dataPath, getDataDir } from '../src/config/instance.js';
import { verifyCodexRebootIdentity, type RebootRestoreEntry } from '../src/reboot-restore.js';
import { readRebootIdentityFence } from '../src/recovery/reboot-identity-fence.js';
import { rebootRestoreRegistry } from '../src/web/reboot-restore-registry.js';
import { writeCustomModelHosts } from '../src/custom-model-hosts.js';
import { customModelConfigDir } from '../src/custom-model-injection-apply.js';
import type { SessionState } from '../src/types.js';
import type { RecoveryController } from '../src/recovery/controller.js';

/** Reach the private collections the discard is responsible for emptying. */
interface ServerInternals {
  app: import('fastify').FastifyInstance;
  sessions: Map<string, Session>;
  sessionListenerRefs: Map<string, unknown>;
  runSummaryTrackers: Map<string, unknown>;
  cleaningUp: Set<string>;
  mux: TmuxManager;
  broadcast: ReturnType<typeof vi.fn> | WebServer['broadcast'];
  getRecoveryController(session: Session): RecoveryController | undefined;
  registerSessionWithLayout(session: Session): Promise<void>;
  setupSessionListeners(session: Session): Promise<void>;
  discardPartiallyBuiltSession(
    sessionId: string,
    expectedSession?: Session,
    options?: { preserveCustomModelConfigDir?: boolean; preserveMuxPane?: boolean; retainForInspection?: boolean }
  ): Promise<void>;
}

const WORKSPACE = join(homedir(), '.codeman-test-discard');
const SESSION_ID = 'a1b2c3d4e5f60718';
const DIRECT_ATTACH_SESSION_ID = '2af510ab-1111-2222-3333-444444444444';
const FAILED_RESTORE_ID = 'custom-model-failed-restore';
const CANCELLED_RESTORE_ID = 'custom-model-cancelled-restore';
const REBOOT_UUID = '12345678-1234-1234-1234-123456789abc';

let server: WebServer;
let internals: ServerInternals;
let mux: TmuxManager;

function removeFixedIdentityFences(): void {
  for (const id of [SESSION_ID, DIRECT_ATTACH_SESSION_ID, FAILED_RESTORE_ID, CANCELLED_RESTORE_ID]) {
    rmSync(dataPath('reboot-identities', `${id}.json`), { force: true });
  }
}

function buildSession(): Session {
  return new Session({
    id: SESSION_ID,
    workingDir: WORKSPACE,
    mode: 'claude',
    name: 'rebuilt session',
    mux,
    useMux: true,
  });
}

beforeAll(async () => {
  // Factory availability is separate from the in-memory VITEST mux implementation.
  vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);
  mkdirSync(WORKSPACE, { recursive: true });
  // Test mode: no port is opened and no CLI is launched. One server for the file,
  // stopped at the end: the constructor registers handlers on the module-level
  // image, subagent, team and workflow watchers, and only stop() removes them.
  server = new WebServer(0, false, true);
  internals = server as unknown as ServerInternals;
  mux = new TmuxManager();
  await (server as unknown as { setupRoutes(): Promise<void> }).setupRoutes();
  await internals.app.ready();
});

beforeEach(removeFixedIdentityFences);

afterEach(async () => {
  for (const id of [SESSION_ID, DIRECT_ATTACH_SESSION_ID, FAILED_RESTORE_ID, CANCELLED_RESTORE_ID]) {
    await internals.discardPartiallyBuiltSession(id).catch(() => {});
  }
  rebootRestoreRegistry.reset();
  await writeCustomModelHosts(getDataDir(), []);
  removeFixedIdentityFences();
});

afterAll(async () => {
  await server.stop().catch(() => {});
  safeRmHomeTree(WORKSPACE);
  vi.restoreAllMocks();
});

describe('discarding a session whose pane never started', () => {
  it('takes the session back out of the server', async () => {
    const session = buildSession();
    await internals.registerSessionWithLayout(session);
    await internals.setupSessionListeners(session);
    expect(internals.sessions.has(SESSION_ID)).toBe(true);

    await internals.discardPartiallyBuiltSession(SESSION_ID);
    expect(internals.sessions.has(SESSION_ID)).toBe(false);
  });

  it('releases the listener registration, so a retry can wire itself again', async () => {
    const first = buildSession();
    await internals.registerSessionWithLayout(first);
    await internals.setupSessionListeners(first);
    expect(internals.sessionListenerRefs.has(SESSION_ID)).toBe(true);

    const firstRefs = internals.sessionListenerRefs.get(SESSION_ID);
    await internals.discardPartiallyBuiltSession(SESSION_ID);
    expect(internals.sessionListenerRefs.has(SESSION_ID)).toBe(false);

    // The retry reuses the id by design. `setupSessionListeners()` returns early
    // while the refs are still there, so a session built now would run blind: no
    // terminal output, no status updates, no exit broadcast. Asserting a DIFFERENT
    // refs object is what distinguishes wiring the retry from finding the corpse
    // of the first attempt still in place.
    const retry = buildSession();
    await internals.registerSessionWithLayout(retry);
    await internals.setupSessionListeners(retry);
    const retryRefs = internals.sessionListenerRefs.get(SESSION_ID);
    expect(retryRefs).toBeDefined();
    expect(retryRefs).not.toBe(firstRefs);
  });

  it('stops the run-summary tracker, whose interval would otherwise keep firing', async () => {
    const session = buildSession();
    await internals.registerSessionWithLayout(session);
    await internals.setupSessionListeners(session);
    const tracker = internals.runSummaryTrackers.get(SESSION_ID) as { stop: () => void };
    expect(tracker).toBeDefined();
    // Dropping the map entry is not enough: the tracker arms a setInterval in its
    // constructor, and only stop() clears it, so a discard that merely forgot the
    // entry would leave the timer running for the life of the process.
    const stopped = vi.spyOn(tracker, 'stop');

    await internals.discardPartiallyBuiltSession(SESSION_ID);
    expect(stopped).toHaveBeenCalled();
    expect(internals.runSummaryTrackers.has(SESSION_ID)).toBe(false);
  });

  it('does nothing at all for a session it never registered', async () => {
    await expect(internals.discardPartiallyBuiltSession('never-existed')).resolves.toBeUndefined();
  });

  it('does not tear down a replacement that reused the tentative session id', async () => {
    const stale = buildSession();
    const replacement = buildSession();
    await internals.registerSessionWithLayout(replacement);
    await internals.setupSessionListeners(replacement);

    await internals.discardPartiallyBuiltSession(SESSION_ID, stale);

    expect(internals.sessions.get(SESSION_ID)).toBe(replacement);
    expect(internals.sessionListenerRefs.has(SESSION_ID)).toBe(true);
  });

  it('fences recovery recreation and preserves a replacement installed during the actual controller drain', async () => {
    const stale = new Session({ id: SESSION_ID, workingDir: WORKSPACE, mode: 'codex', useMux: false });
    await internals.registerSessionWithLayout(stale);
    await internals.setupSessionListeners(stale);
    const controller = internals.getRecoveryController(stale)!;
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const drain = vi.spyOn(controller, 'drain').mockImplementation(async () => {
      entered.resolve();
      await release.promise;
    });
    const discarded = internals.discardPartiallyBuiltSession(SESSION_ID, stale);
    await entered.promise;
    const replacement = buildSession();
    const stop = vi.spyOn(replacement, 'stop');
    const listeners = internals.sessionListenerRefs.get(SESSION_ID);
    const profile = customModelConfigDir(SESSION_ID);
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, 'replacement-profile'), 'keep replacement state');
    const broadcast = vi.spyOn(internals, 'broadcast');
    try {
      expect(internals.cleaningUp.has(SESSION_ID)).toBe(true);
      expect(stale.getRecoveryContext().managed).toBe(false);
      expect(internals.getRecoveryController(stale)).toBeUndefined();
      await internals.registerSessionWithLayout(replacement);
      release.resolve();
      await discarded;
      expect(internals.sessions.get(SESSION_ID)).toBe(replacement);
      expect(internals.sessionListenerRefs.get(SESSION_ID)).toBe(listeners);
      expect(readFileSync(join(profile, 'replacement-profile'), 'utf8')).toBe('keep replacement state');
      expect(stop).not.toHaveBeenCalled();
      expect(broadcast).not.toHaveBeenCalled();
      expect(internals.cleaningUp.has(SESSION_ID)).toBe(false);
    } finally {
      release.resolve();
      await discarded;
      drain.mockRestore();
      broadcast.mockRestore();
      stop.mockRestore();
      await stale.stop(false);
    }
  });

  it.each(['unchanged', 'replaced'] as const)(
    'publishes retained uncertain inspection only for its current instance after the mux flush: %s',
    async (change) => {
      const home = join(homedir(), 'retained-inspection-home');
      const record = await internals.mux.createSession({
        sessionId: SESSION_ID,
        workingDir: WORKSPACE,
        mode: 'codex',
        codexConfig: { noDaemon: true, resumeSessionId: REBOOT_UUID },
        recoveryCodexHome: home,
      });
      record.codexRestoreUncertain = true;
      const stale = new Session({
        id: SESSION_ID,
        workingDir: WORKSPACE,
        mode: 'codex',
        mux: internals.mux,
        muxSession: record,
        useMux: true,
        codexConfig: { noDaemon: true, resumeSessionId: REBOOT_UUID },
        recoveryCodexHome: home,
      });
      await internals.registerSessionWithLayout(stale);
      await internals.setupSessionListeners(stale);
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const flush = vi.spyOn(internals.mux, 'flushSessionsDurably').mockImplementation(async () => {
        entered.resolve();
        await release.promise;
      });
      const broadcast = vi.spyOn(internals, 'broadcast');
      const discarded = internals.discardPartiallyBuiltSession(SESSION_ID, stale, {
        retainForInspection: true,
        preserveMuxPane: true,
        preserveCustomModelConfigDir: true,
      });
      let replacement: Session | undefined;
      try {
        await entered.promise;
        if (change === 'replaced') {
          replacement = buildSession();
          await internals.registerSessionWithLayout(replacement);
        }
        release.resolve();
        await discarded;
        expect(internals.sessions.get(SESSION_ID)).toBe(replacement ?? stale);
        expect(broadcast.mock.calls.filter(([event]) => event === 'session:created')).toHaveLength(
          change === 'unchanged' ? 1 : 0
        );
        expect(broadcast.mock.calls.some(([event]) => event === 'session:deleted')).toBe(false);
        expect(stale.codexRestoreWorkerMayExist).toBe(true);
        expect(internals.mux.getSession(SESSION_ID)).toBe(record);
        expect(internals.cleaningUp.has(SESSION_ID)).toBe(false);
      } finally {
        release.resolve();
        await discarded;
        flush.mockRestore();
        broadcast.mockRestore();
        if (replacement) await stale.stop(false);
      }
    }
  );
});

describe('custom-model reboot restore cleanup through the real server route', () => {
  async function seedOffer(sessionId: string): Promise<{
    entry: RebootRestoreEntry;
    rollout: string;
    history: string;
    rolloutText: string;
    historyText: string;
  }> {
    await writeCustomModelHosts(getDataDir(), [
      {
        id: 'reboot-custom-endpoint',
        label: 'reboot custom endpoint',
        baseUrl: 'http://127.0.0.1:8080',
        apiKey: 'server-owned-secret',
        models: ['custom-model'],
      },
    ]);
    const home = customModelConfigDir(sessionId);
    const rollout = join(home, 'sessions', `rollout-2026-10-13T15-00-00-${REBOOT_UUID}.jsonl`);
    const history = join(home, 'history.jsonl');
    const rolloutText =
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-10-13T15:00:00Z',
        payload: { id: REBOOT_UUID, cwd: WORKSPACE, originator: `codeman_${sessionId}` },
      }) + '\n';
    const historyText = `${JSON.stringify({ session_id: REBOOT_UUID, ts: 1_760_368_500, text: 'original task' })}\n`;
    mkdirSync(join(home, 'sessions'), { recursive: true });
    writeFileSync(rollout, rolloutText);
    writeFileSync(history, historyText);
    const state = {
      id: sessionId,
      pid: 1234,
      status: 'idle',
      workingDir: WORKSPACE,
      currentTaskId: null,
      createdAt: 1_760_000_000_000,
      mode: 'codex',
      codexConfig: { noDaemon: true, resumeSessionId: REBOOT_UUID, model: 'custom-model' },
      __envOverrides: { CODEX_HOME: home },
      __codexRecoveryHome: home,
      __customModel: {
        endpointId: 'reboot-custom-endpoint',
        modelId: 'custom-model',
        envKeys: ['CODEX_HOME', 'CODEMAN_CUSTOM_MODEL_API_KEY'],
        configDir: home,
      },
    } as SessionState;
    expect(await verifyCodexRebootIdentity(state)).toBe(REBOOT_UUID);
    const entry: RebootRestoreEntry = {
      sessionId,
      workingDir: WORKSPACE,
      mode: 'codex',
      resumeConversationId: REBOOT_UUID,
      state,
    };
    rebootRestoreRegistry.set([entry]);
    return { entry, rollout, history, rolloutText, historyText };
  }

  function expectOriginalConversationFiles(fixture: Awaited<ReturnType<typeof seedOffer>>): void {
    expect(existsSync(fixture.rollout)).toBe(true);
    expect(existsSync(fixture.history)).toBe(true);
    expect(readFileSync(fixture.rollout, 'utf8')).toBe(fixture.rolloutText);
    expect(readFileSync(fixture.history, 'utf8')).toBe(fixture.historyText);
  }

  it('preserves the original rollout and history when launch fails and the offer becomes retryable', async () => {
    const fixture = await seedOffer(FAILED_RESTORE_ID);
    const launch = vi.spyOn(Session.prototype, 'startInteractive').mockRejectedValueOnce(new Error('launch failed'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await internals.app.inject({
        method: 'POST',
        url: '/api/reboot-restore/restore',
        payload: { sessionIds: [FAILED_RESTORE_ID] },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data.skipped).toEqual([{ sessionId: FAILED_RESTORE_ID, reason: 'rebuild-failed' }]);
      expect(internals.sessions.has(FAILED_RESTORE_ID)).toBe(false);
      expect(rebootRestoreRegistry.list(() => true).map((entry) => entry.sessionId)).toEqual([FAILED_RESTORE_ID]);
      expectOriginalConversationFiles(fixture);
    } finally {
      launch.mockRestore();
      log.mockRestore();
    }
  });

  it('preserves the original rollout and history when dismissal cancels an in-flight launch', async () => {
    const fixture = await seedOffer(CANCELLED_RESTORE_ID);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const launch = vi.spyOn(Session.prototype, 'startInteractive').mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
    });
    try {
      const restoring = internals.app.inject({
        method: 'POST',
        url: '/api/reboot-restore/restore',
        payload: { sessionIds: [CANCELLED_RESTORE_ID] },
      });
      await started.promise;
      const dismissed = await internals.app.inject({
        method: 'POST',
        url: '/api/reboot-restore/dismiss',
        payload: {},
      });
      expect(dismissed.statusCode).toBe(200);
      expect(dismissed.json().data.dismissed).toBe(1);
      release.resolve();

      const result = (await restoring).json().data;
      expect(result.restored).toEqual([]);
      expect(result.skipped).toEqual([{ sessionId: CANCELLED_RESTORE_ID, reason: 'restore-cancelled' }]);
      expect(internals.sessions.has(CANCELLED_RESTORE_ID)).toBe(false);
      expect(rebootRestoreRegistry.list(() => true)).toEqual([]);
      expectOriginalConversationFiles(fixture);
    } finally {
      release.resolve();
      launch.mockRestore();
    }
  });
});

describe('reboot recovery evidence fence', () => {
  it('fences old conversation A before a supported attach can resume older conversation B', async () => {
    // Earlier cases intentionally retain uncertain launches. This historical
    // legacy attach owns a distinct ID and never deletes or adopts those panes.
    const id = DIRECT_ATTACH_SESSION_ID;
    const oldConversation = '12345678-1234-1234-1234-123456789abc';
    const resumedOlderConversation = '99999999-1234-1234-1234-123456789abc';
    const home = join(WORKSPACE, 'direct-attach-codex-home');
    mkdirSync(join(home, 'sessions'), { recursive: true });
    for (const [conversationId, timestamp, fileStamp] of [
      [oldConversation, '2026-10-13T15:00:00Z', '2026-10-13T15-00-00'],
      [resumedOlderConversation, '2025-10-13T15:00:00Z', '2025-10-13T15-00-00'],
    ]) {
      writeFileSync(
        join(home, 'sessions', `rollout-${fileStamp}-${conversationId}.jsonl`),
        JSON.stringify({
          type: 'session_meta',
          timestamp,
          payload: { id: conversationId, cwd: WORKSPACE, originator: `codeman_${id}` },
        }) + '\n'
      );
    }
    const session = new Session({
      id,
      workingDir: WORKSPACE,
      mode: 'codex',
      useMux: false,
      codexConfig: { noDaemon: true, resumeSessionId: oldConversation },
      envOverrides: { CODEX_HOME: home },
    });
    const saved = {
      ...session.toState(),
      pid: 1234,
      __envOverrides: { CODEX_HOME: home },
      __codexRecoveryHome: home,
      __codexPriorInputBroker: null,
    };
    const brokerDirectory = dataPath('codex-input-brokers', id);
    expect(existsSync(brokerDirectory)).toBe(false);
    // Even an explicit legacy offer cannot hide a now-unknown guarded launch.
    // Create and remove only this fixture's new empty directory, never the
    // previously retained uncertain workers or private journals.
    mkdirSync(brokerDirectory, { recursive: true, mode: 0o700 });
    try {
      expect(await verifyCodexRebootIdentity(saved)).toBeUndefined();
    } finally {
      rmdirSync(brokerDirectory);
    }
    expect(await verifyCodexRebootIdentity(saved)).toBe(oldConversation);
    await internals.registerSessionWithLayout(session);
    await internals.setupSessionListeners(session);

    const response = await internals.app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/direct-attach-fence`,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(readRebootIdentityFence(id)).toEqual({
      switchPending: true,
      submission: undefined,
      untrackedInput: true,
    });
    const directWrite = vi.fn();
    (session as unknown as { ptyProcess: unknown }).ptyProcess = { write: directWrite };
    try {
      const browserInput = await internals.app.inject({
        method: 'POST',
        url: `/api/sessions/${id}/input`,
        payload: { input: 'tracked browser prompt\r', useMux: false },
      });
      expect(browserInput.statusCode).toBe(200);
      expect(directWrite).toHaveBeenCalledWith('tracked browser prompt\r');
      expect(session.getRecoveryContext()).toMatchObject({ switchPending: true, untrackedInput: true });
      expect(readRebootIdentityFence(id)).toEqual({
        switchPending: true,
        submission: undefined,
        untrackedInput: true,
      });
    } finally {
      (session as unknown as { ptyProcess: unknown }).ptyProcess = null;
    }
    // Input during the ensuing tmux attach is deliberately invisible. Even if
    // the user selected the older B rollout, the stale persisted A can no
    // longer authorize a reboot restore.
    expect(await verifyCodexRebootIdentity(saved)).toBeUndefined();

    // Reconstructing the live Session is the server-restart boundary. The new
    // object must reload the independent fence before any browser input can
    // publish an apparently exact proof over the still-untracked pane.
    await internals.discardPartiallyBuiltSession(id, session);
    const reconstructed = new Session({
      id,
      workingDir: WORKSPACE,
      mode: 'codex',
      useMux: false,
      preserveExitedPane: true,
      codexConfig: { noDaemon: true, resumeSessionId: oldConversation },
      envOverrides: { CODEX_HOME: home },
    });
    expect(reconstructed.getRecoveryContext()).toMatchObject({ switchPending: true, untrackedInput: true });
    await internals.registerSessionWithLayout(reconstructed);
    await internals.setupSessionListeners(reconstructed);
    const restartedWrite = vi.fn();
    (reconstructed as unknown as { ptyProcess: unknown }).ptyProcess = { write: restartedWrite };
    try {
      const browserInput = await internals.app.inject({
        method: 'POST',
        url: `/api/sessions/${id}/input`,
        payload: { input: 'prompt after server restart\r', useMux: false },
      });
      expect(browserInput.statusCode).toBe(200);
      expect(restartedWrite).toHaveBeenCalledOnce();
      expect(reconstructed.getRecoveryContext()).toMatchObject({ switchPending: true, untrackedInput: true });
      expect(await verifyCodexRebootIdentity(saved)).toBeUndefined();
    } finally {
      (reconstructed as unknown as { ptyProcess: unknown }).ptyProcess = null;
    }
  });

  it('releases a send-and-wait pane watcher when the pre-dispatch fence fails', async () => {
    const id = 'wait-fence-failure';
    const session = new Session({ id, workingDir: WORKSPACE, mode: 'codex', mux, useMux: true });
    (session as unknown as { _muxSession: unknown })._muxSession = { muxName: 'fence-watched-pane' };
    await internals.registerSessionWithLayout(session);
    await internals.setupSessionListeners(session);
    const path = dataPath('reboot-identities', `${id}.json`);
    mkdirSync(path, { recursive: true });
    const { _paneDeathWatcherCount } = await import('../src/web/routes/session-routes.js');
    const before = _paneDeathWatcherCount();
    try {
      const response = await internals.app.inject({
        method: 'POST',
        url: `/api/sessions/${id}/input`,
        payload: { input: '/resume\r', useMux: false, wait: 'exit', waitTimeout: 1000 },
      });
      expect(response.statusCode).toBe(500);
      expect(_paneDeathWatcherCount()).toBe(before);
    } finally {
      rmdirSync(path);
    }
  });
  it('keeps a tagged HTTP input retryable when its pre-dispatch fence fails', async () => {
    const id = 'http-fence-retry';
    const session = new Session({ id, workingDir: WORKSPACE, mode: 'codex', useMux: false });
    await internals.registerSessionWithLayout(session);
    await internals.setupSessionListeners(session);
    const write = vi.fn();
    (session as unknown as { ptyProcess: unknown }).ptyProcess = { write };
    const path = dataPath('reboot-identities', `${id}.json`);
    mkdirSync(path, { recursive: true });
    const request = {
      method: 'POST' as const,
      url: `/api/sessions/${id}/input`,
      payload: { input: '/resume\r', useMux: false, clientId: 'fence-retry-client', seq: 1 },
    };
    try {
      expect((await internals.app.inject(request)).statusCode).toBe(500);
      expect((await internals.app.inject(request)).statusCode).toBe(500);
      expect(write).not.toHaveBeenCalled();
      rmdirSync(path);
      expect((await internals.app.inject(request)).statusCode).toBe(200);
      expect(write).toHaveBeenCalledOnce();
      expect((await internals.app.inject(request)).statusCode).toBe(200);
      expect(write).toHaveBeenCalledOnce();
    } finally {
      (session as unknown as { ptyProcess: unknown }).ptyProcess = null;
    }
  });
  it('refuses a thread-changing write when the durable fence cannot be committed', async () => {
    const id = 'fence-storage-failure';
    const session = new Session({ id, workingDir: WORKSPACE, mode: 'codex', useMux: false });
    await internals.registerSessionWithLayout(session);
    await internals.setupSessionListeners(session);
    const write = vi.fn();
    (session as unknown as { ptyProcess: unknown }).ptyProcess = { write };
    const path = dataPath('reboot-identities', `${id}.json`);
    mkdirSync(path, { recursive: true });
    try {
      expect(() => session.write('/resume\r', { fromUser: true })).toThrow();
      expect(() => session.write('/resume\r', { fromUser: true })).toThrow();
      await expect(session.writeViaMux('/resume\r', { fromUser: true })).rejects.toThrow();
      expect(write).not.toHaveBeenCalled();
    } finally {
      (session as unknown as { ptyProcess: unknown }).ptyProcess = null;
      rmdirSync(path);
    }
  });
  it('does not report landed input as failed if the post-dispatch proof cannot be saved', async () => {
    const id = 'post-dispatch-fence';
    const session = new Session({ id, workingDir: WORKSPACE, mode: 'codex', useMux: false });
    await internals.registerSessionWithLayout(session);
    await internals.setupSessionListeners(session);
    const path = dataPath('reboot-identities', `${id}.json`);
    const write = vi.fn(() => {
      unlinkSync(path);
      mkdirSync(path);
    });
    (session as unknown as { ptyProcess: unknown }).ptyProcess = { write };
    try {
      expect(session.write('authorized task\r', { fromUser: true })).toBe(true);
      expect(write).toHaveBeenCalledOnce();
      expect(session.getRecoveryContext().switchPending).toBe(true);
    } finally {
      (session as unknown as { ptyProcess: unknown }).ptyProcess = null;
      rmdirSync(path);
    }
  });
  it('fences a slash switch on a restored pane whose runtime veto was already set', async () => {
    const id = 'restored-fence';
    const { writeRebootIdentityFence, readRebootIdentityFence } =
      await import('../src/recovery/reboot-identity-fence.js');
    writeRebootIdentityFence(id, { switchPending: false });
    const session = new Session({ id, workingDir: WORKSPACE, mode: 'codex', useMux: false, preserveExitedPane: true });
    await internals.registerSessionWithLayout(session);
    await internals.setupSessionListeners(session);
    session.trackUserInput('/resume\r');
    expect(readRebootIdentityFence(id)?.switchPending).toBe(true);
  });
  it('persists a slash-switch veto before an old UUID can be reused after reboot', async () => {
    const session = new Session({
      id: SESSION_ID,
      workingDir: WORKSPACE,
      mode: 'codex',
      mux,
      useMux: true,
      codexConfig: { noDaemon: true, resumeSessionId: '12345678-1234-1234-1234-123456789abc' },
    });
    await internals.registerSessionWithLayout(session);
    await internals.setupSessionListeners(session);
    session.trackUserInput('/resume\r');
    const persisted = (
      server as unknown as {
        store: { getSessions(): Record<string, unknown> };
      }
    ).store.getSessions()[SESSION_ID] as { __codexRebootIdentity: { switchPending: boolean; submission?: unknown } };
    expect(persisted.__codexRebootIdentity.switchPending).toBe(true);
    expect(persisted.__codexRebootIdentity.submission).toBeUndefined();
    const { readRebootIdentityFence } = await import('../src/recovery/reboot-identity-fence.js');
    // Read the independent on-disk fence immediately, before state.json's debounce.
    expect(readRebootIdentityFence(SESSION_ID)).toEqual({ switchPending: true, submission: undefined });
  });

  it('keeps settings and exhausted budgets while removing the pre-reboot pending action', async () => {
    const { initialRecoveryState } = await import('../src/recovery/types.js');
    const state = initialRecoveryState();
    state.config.enabled = false;
    state.config.maxRetries = 7;
    state.attempts = 3;
    state.failedAttempts = 2;
    state.circuitOpen = true;
    state.windowStartedAt = Date.now() - 60_000;
    state.pending = { key: 'old-failure', action: 'continue', conversationId: '12345678-1234-1234-1234-123456789abc' };
    state.nextRetryAt = Date.now() + 30_000;
    const recovery = server as unknown as {
      recoveryStore: import('../src/recovery/store.js').RecoveryStore;
      prepareRebootRestoreRecovery(id: string): Promise<void>;
    };
    await recovery.recoveryStore.save('reboot-original', state);
    const before = Date.now();
    await recovery.prepareRebootRestoreRecovery('reboot-original');
    const restored = recovery.recoveryStore.get('reboot-original');
    expect(restored.config).toEqual(state.config);
    expect(restored.attempts).toBe(3);
    expect(restored.failedAttempts).toBe(2);
    expect(restored.circuitOpen).toBe(true);
    expect(restored.windowStartedAt).toBe(state.windowStartedAt);
    expect(restored.pending).toBeUndefined();
    expect(restored.nextRetryAt).toBeUndefined();
    expect(restored.armedAt).toBeGreaterThanOrEqual(before);
  });
});
