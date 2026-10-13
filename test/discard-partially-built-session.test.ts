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
 * The retry assertion is the important one. `setupSessionListeners()` returns
 * early when `sessionListenerRefs` still holds the session id, so a discard that
 * leaves that entry makes the next attempt wire nothing at all, and the user
 * gets a tab that never shows output.
 */
import { mkdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { safeRmHomeTree } from './mocks/test-helpers.js';

import { WebServer } from '../src/web/server.js';
import { Session } from '../src/session.js';
import { TmuxManager } from '../src/tmux-manager.js';
import { dataPath } from '../src/config/instance.js';

/** Reach the private collections the discard is responsible for emptying. */
interface ServerInternals {
  app: import('fastify').FastifyInstance;
  sessions: Map<string, Session>;
  sessionListenerRefs: Map<string, unknown>;
  runSummaryTrackers: Map<string, unknown>;
  registerSessionWithLayout(session: Session): Promise<void>;
  setupSessionListeners(session: Session): Promise<void>;
  discardPartiallyBuiltSession(sessionId: string): Promise<void>;
}

const WORKSPACE = join(homedir(), '.codeman-test-discard');
const SESSION_ID = 'a1b2c3d4e5f60718';

let server: WebServer;
let internals: ServerInternals;
let mux: TmuxManager;

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

afterEach(async () => {
  await internals.discardPartiallyBuiltSession(SESSION_ID).catch(() => {});
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
});

describe('reboot recovery evidence fence', () => {
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
