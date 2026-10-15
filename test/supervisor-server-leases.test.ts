import { currentLocalCodexHome } from '../src/recovery/codex-home.js';
import { join, dirname } from 'node:path';
import { fakeInputProvenance } from './helpers/codex-input-provenance.js';
/** @fileoverview Supervisor leases follow surviving/restorable manager identities after boot. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { Session } from '../src/session.js';
import { TmuxManager } from '../src/tmux-manager.js';
import type { MuxSession, TerminalMultiplexer } from '../src/mux-interface.js';
import { initialSupervisorState, type SupervisorState } from '../src/supervisor/schema.js';
import type { SupervisorController } from '../src/supervisor/controller.js';
import type { SupervisorStore } from '../src/supervisor/store.js';
import type { StateStore } from '../src/state-store.js';
import { rebootRestoreRegistry } from '../src/web/reboot-restore-registry.js';
import type { RebootRestoreEntry } from '../src/reboot-restore.js';
import type { TaskStore } from '../src/supervision/store.js';
import { initialTaskState } from '../src/supervision/schema.js';
import { CodexTaskAdapter } from '../src/supervision/adapter.js';
import { CodexRecoveryAdapter } from '../src/recovery/codex-adapter.js';
import type { TaskController } from '../src/supervision/controller.js';
import { registerSupervisorRoutes } from '../src/web/routes/supervisor-routes.js';
import { createRouteTestHarness, type RouteTestHarness } from './routes/_route-test-utils.js';

const OLD = '11111111-1111-4111-8111-111111111111';
const NEXT = '22222222-2222-4222-8222-222222222222';
const WORKER = '33333333-3333-4333-8333-333333333333';
const config = {
  objective: 'Coordinate the fix',
  enabled: true,
  workers: [
    {
      sessionId: WORKER,
      task: 'Repair the parser',
      criteria: [{ id: 'review', description: 'Owner verifies the fix', kind: 'manual' as const }],
      maxAssignments: 2,
      maxRuntimeMs: 60_000,
    },
  ],
};

interface Internals {
  sessions: Map<string, Session>;
  store: StateStore;
  supervisorStore: SupervisorStore;
  taskStore: TaskStore;
  tabLayouts: { markRestorationComplete(): void };
  cleanupStaleSessions(): Promise<number>;
  getSupervisorController(session: Session): SupervisorController | undefined;
  getTaskController(session: Session): TaskController | undefined;
  supervisorLeaseHolder(workerId: string, excluding: string): string | undefined;
  stopRecoveryController(id: string, drop: boolean): Promise<void>;
}

function session(id: string): Session {
  const mux = { isAvailable: () => true } as unknown as TerminalMultiplexer;
  const muxSession = {
    sessionId: id,
    muxName: `fixture-${id}`,
    recoveryIsolated: true,
    recoveryCodexHome: join(currentLocalCodexHome(), `fixture-${id}`),
    workingDir: process.cwd(),
    mode: 'codex',
    attached: true,
    pid: 99999,
    createdAt: Date.now(),
  } as MuxSession;
  return new Session({
    id,
    mode: 'codex',
    owner: 'alice',
    workingDir: process.cwd(),
    useMux: true,
    mux,
    muxSession,
    codexConfig: { noDaemon: true },
  });
}

describe('server supervisor lease reconciliation', () => {
  let server: WebServer;
  let internals: Internals;
  let old: Session;
  let journal: SupervisorState;
  let routes: RouteTestHarness[];

  const route = async (username = 'alice') => {
    vi.stubEnv('CODEMAN_MULTIUSER', '1');
    const h = await createRouteTestHarness(
      (app, ctx) =>
        registerSupervisorRoutes(app, {
          ...ctx,
          sessions: internals.sessions,
          getSupervisorController: (selected: Session) => internals.getSupervisorController(selected),
        }),
      { authUser: { username, role: 'user' } }
    );
    routes.push(h);
    return h.app;
  };

  const revoke = async (kind: 'stopped' | 'breaker' | 'isolation') => {
    if (kind === 'stopped') await old.stop(false);
    else if (kind === 'breaker') Reflect.set(old, '_respawnBlocked', true);
    else Reflect.set(old, '_codexConfig', { noDaemon: false });
    expect(old.getRecoveryContext().managed && old.getRecoveryContext().noDaemon).toBe(false);
  };

  beforeEach(async () => {
    vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);
    // This suite isolates durable role/lease ownership; complete framing has
    // dedicated real adapter and supervisor admission coverage.
    vi.spyOn(CodexTaskAdapter.prototype, 'admitPrompt').mockResolvedValue(true);
    rebootRestoreRegistry.reset();
    server = new WebServer(0, false, true);
    internals = server as unknown as Internals;
    routes = [];
    old = session(OLD);
    journal = {
      ...initialSupervisorState(OLD),
      ...config,
      phase: 'paused',
      workers: config.workers.map((worker) => ({ ...worker, assignments: 1 })),
      inFlight: { requestId: 'request-unknown', workerId: WORKER, action: 'assign', reservedAt: Date.now() },
    };
    await internals.supervisorStore.save(OLD, journal);
    internals.store.setSession(OLD, old.toState());
    internals.sessions.set(WORKER, session(WORKER));
    internals.sessions.set(NEXT, session(NEXT));
    internals.tabLayouts.markRestorationComplete();
  });

  afterEach(async () => {
    for (const h of routes) await h.app.close();
    rebootRestoreRegistry.reset();
    for (const id of [OLD, NEXT, WORKER]) {
      await internals.stopRecoveryController(id, true);
      internals.sessions.delete(id);
      internals.store.removeSession(id);
    }
    await server.stop().catch(() => {});
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(['stopped', 'breaker'] as const)(
    'keeps owner status/pause/reset available for an existing %s manager and releases its durable lease',
    async (kind) => {
      internals.sessions.set(OLD, old);
      const manager = internals.getSupervisorController(old)!;
      const app = await route();
      await revoke(kind);
      expect(internals.supervisorLeaseHolder(WORKER, NEXT)).toBe(OLD);
      const status = await app.inject({ method: 'GET', url: `/api/sessions/${OLD}/supervisor` });
      expect(status.statusCode).toBe(200);
      expect(status.json().data.inFlight).toEqual(journal.inFlight);
      const pause = await app.inject({ method: 'POST', url: `/api/sessions/${OLD}/supervisor/pause` });
      expect(pause.statusCode).toBe(200);
      expect(manager.getStatus()).toMatchObject({ enabled: true, phase: 'paused', inFlight: journal.inFlight });
      expect(internals.supervisorLeaseHolder(WORKER, NEXT)).toBe(OLD);
      const reset = await app.inject({ method: 'POST', url: `/api/sessions/${OLD}/supervisor/reset` });
      expect(reset.statusCode).toBe(200);
      expect(reset.json().data).toMatchObject({ enabled: false, workers: [] });
      expect(internals.supervisorStore.get(OLD).enabled).toBe(false);
      expect(internals.supervisorLeaseHolder(WORKER, NEXT)).toBeUndefined();
      await expect(
        internals.getSupervisorController(internals.sessions.get(NEXT)!)!.configure(config)
      ).resolves.toMatchObject({ enabled: true });
    }
  );

  it.each(['stopped', 'breaker'] as const)('does not create a new controller for a %s manager', async (kind) => {
    internals.sessions.set(OLD, old);
    await revoke(kind);
    const app = await route();
    expect((await app.inject({ method: 'GET', url: `/api/sessions/${OLD}/supervisor` })).statusCode).toBe(400);
    expect(internals.supervisorStore.get(OLD)).toEqual(journal);
    expect(internals.supervisorLeaseHolder(WORKER, NEXT)).toBe(OLD);
  });

  it.each(['stopped', 'breaker', 'isolation'] as const)(
    'refuses a fresh task kickoff through the existing %s manager',
    async (kind) => {
      internals.sessions.set(OLD, old);
      await internals.supervisorStore.save(OLD, { ...journal, inFlight: undefined });
      const manager = internals.getSupervisorController(old)!;
      const task = internals.getTaskController(old)!;
      const update = vi.spyOn(task, 'update');
      const resume = vi.spyOn(task, 'resume');
      const act = vi.spyOn(CodexTaskAdapter.prototype, 'act');
      const input = vi.spyOn(old, 'writeViaMux');
      await revoke(kind);
      const app = await route();
      expect((await app.inject({ method: 'POST', url: `/api/sessions/${OLD}/supervisor/start` })).statusCode).toBe(400);
      expect(update).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
      expect(act).not.toHaveBeenCalled();
      expect(input).not.toHaveBeenCalled();
      expect(manager.getStatus().phase).toBe('paused');
      expect(internals.supervisorLeaseHolder(WORKER, NEXT)).toBe(OLD);
    }
  );

  it.each(['stopped', 'breaker', 'isolation'] as const)(
    'does not resume a manager task when %s eligibility is lost during its awaited update',
    async (kind) => {
      internals.sessions.set(OLD, old);
      await internals.supervisorStore.save(OLD, { ...journal, inFlight: undefined });
      const manager = internals.getSupervisorController(old)!;
      const task = internals.getTaskController(old)!;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const update = vi.spyOn(task, 'update').mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        return task.getStatus();
      });
      const resume = vi.spyOn(task, 'resume');
      const act = vi.spyOn(CodexTaskAdapter.prototype, 'act');
      const input = vi.spyOn(old, 'writeViaMux');
      const starting = manager.start();
      await entered.promise;
      await revoke(kind);
      release.resolve();
      await expect(starting).rejects.toThrow(/not ready/);
      expect(update).toHaveBeenCalledOnce();
      expect(resume).not.toHaveBeenCalled();
      expect(act).not.toHaveBeenCalled();
      expect(input).not.toHaveBeenCalled();
      expect(manager.getStatus().phase).toBe('paused');
    }
  );

  it.each(['', '/pause', '/reset', '/start'])(
    'keeps foreign-owner access hidden for an existing revoked manager at %s',
    async (suffix) => {
      internals.sessions.set(OLD, old);
      const manager = internals.getSupervisorController(old)!;
      await revoke('breaker');
      const before = manager.getStatus();
      const app = await route('bob');
      expect(
        (await app.inject({ method: suffix ? 'POST' : 'GET', url: `/api/sessions/${OLD}/supervisor${suffix}` }))
          .statusCode
      ).toBe(404);
      expect(manager.getStatus()).toEqual(before);
      expect(internals.supervisorLeaseHolder(WORKER, NEXT)).toBe(OLD);
    }
  );

  it('releases an unreachable pruned manager lease without erasing uncertain operations', async () => {
    expect(internals.supervisorLeaseHolder(WORKER, NEXT)).toBe(OLD);
    expect(await internals.cleanupStaleSessions()).toBeGreaterThanOrEqual(1);
    expect(internals.store.getSession(OLD)).toBeNull();
    expect(internals.sessions.has(OLD)).toBe(false);
    expect(internals.supervisorLeaseHolder(WORKER, NEXT)).toBeUndefined();
    await expect(
      internals.getSupervisorController(internals.sessions.get(NEXT)!)!.configure(config)
    ).resolves.toMatchObject({
      enabled: true,
      phase: 'ready',
    });
    expect(internals.supervisorStore.get(OLD)).toEqual(journal);
  });

  it('retains the lease of a surviving manager', async () => {
    internals.sessions.set(OLD, old);
    await internals.cleanupStaleSessions();
    expect(internals.supervisorLeaseHolder(WORKER, NEXT)).toBe(OLD);
    await expect(internals.getSupervisorController(internals.sessions.get(NEXT)!)!.configure(config)).rejects.toThrow(
      'Worker already has an active supervisor'
    );
  });

  it('retains a pinned detached manager record', async () => {
    internals.store.setSession(OLD, { ...old.toState(), pinned: true });
    await internals.cleanupStaleSessions();
    expect(internals.supervisorLeaseHolder(WORKER, NEXT)).toBe(OLD);
  });

  it('refuses shared-home configuration after a lease release without committing a new role', async () => {
    await internals.cleanupStaleSessions();
    expect(internals.supervisorLeaseHolder(WORKER, NEXT)).toBeUndefined();
    const managerSession = internals.sessions.get(NEXT)!;
    const worker = internals.sessions.get(WORKER)!;
    Reflect.set(worker, '_envOverrides', { CODEX_HOME: managerSession.getRecoveryContext().codexHome });
    Reflect.get(worker, '_muxSession').recoveryCodexHome = managerSession.getRecoveryContext().codexHome;
    const manager = internals.getSupervisorController(managerSession)!;
    const before = manager.getStatus();
    await expect(manager.configure(config)).rejects.toThrow(/distinct Codex homes/);
    expect(manager.getStatus()).toEqual(before);
    expect(internals.supervisorStore.get(NEXT).enabled).toBe(false);
    expect(internals.supervisorStore.get(OLD)).toEqual(journal);
    expect(internals.supervisorLeaseHolder(WORKER, OLD)).toBeUndefined();
  });

  it('retains durable ownership after a failed reset until the release commits', async () => {
    internals.sessions.set(OLD, old);
    const manager = internals.getSupervisorController(old)!;
    const next = internals.getSupervisorController(internals.sessions.get(NEXT)!)!;
    vi.spyOn(internals.supervisorStore, 'save').mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(manager.reset()).rejects.toThrow('Supervisor state could not be saved');
    expect(manager.getStatus()).toMatchObject({ enabled: false, reason: 'persistence-failed' });
    expect(internals.supervisorStore.get(OLD).enabled).toBe(true);
    expect(internals.supervisorLeaseHolder(WORKER, NEXT)).toBe(OLD);
    await expect(next.configure(config)).rejects.toThrow('Worker already has an active supervisor');
    expect(internals.supervisorStore.get(NEXT).enabled).toBe(false);
    await manager.reset();
    expect(internals.supervisorStore.get(OLD).enabled).toBe(false);
    expect(internals.supervisorLeaseHolder(WORKER, NEXT)).toBeUndefined();
    await expect(next.configure(config)).resolves.toMatchObject({ enabled: true, phase: 'ready' });
  });

  it('keeps a durable manager out of worker roles until its reset commits', async () => {
    internals.sessions.set(OLD, old);
    const manager = internals.getSupervisorController(old)!;
    const next = internals.getSupervisorController(internals.sessions.get(NEXT)!)!;
    const superviseManager = {
      ...config,
      workers: [{ ...config.workers[0], sessionId: OLD }],
    };
    vi.spyOn(internals.supervisorStore, 'save').mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(manager.reset()).rejects.toThrow('Supervisor state could not be saved');
    expect(manager.getStatus()).toMatchObject({ enabled: false, reason: 'persistence-failed' });
    expect(internals.supervisorStore.get(OLD).enabled).toBe(true);
    await expect(next.configure(superviseManager)).rejects.toThrow('Supervisor cycles are not allowed');
    expect(next.getStatus().enabled).toBe(false);
    expect(internals.supervisorStore.get(NEXT).enabled).toBe(false);
    await manager.reset();
    expect(internals.supervisorStore.get(OLD).enabled).toBe(false);
    await expect(next.configure(superviseManager)).resolves.toMatchObject({ enabled: true, phase: 'ready' });
  });

  it('retains offered and in-flight restore roles, then releases a dismissed role', async () => {
    const entry = {
      sessionId: OLD,
      name: 'manager',
      workingDir: process.cwd(),
      owner: 'alice',
      mode: 'codex',
      resumeConversationId: '44444444-4444-4444-8444-444444444444',
      state: old.toState(),
    } as RebootRestoreEntry;
    rebootRestoreRegistry.set([entry]);
    await internals.cleanupStaleSessions();
    expect(internals.supervisorLeaseHolder(WORKER, NEXT)).toBe(OLD);
    expect(rebootRestoreRegistry.take(() => true, [OLD], 'alice')).toEqual([entry]);
    expect(internals.supervisorLeaseHolder(WORKER, NEXT)).toBe(OLD);
    rebootRestoreRegistry.clear(() => true);
    expect(internals.supervisorLeaseHolder(WORKER, NEXT)).toBeUndefined();
    expect(internals.supervisorStore.get(OLD).inFlight).toEqual(journal.inFlight);
  });

  it('refuses assignment while a durable agent stop remains after the live task is cleared, then accepts committed owner release', async () => {
    await internals.supervisorStore.save(OLD, initialSupervisorState(OLD));
    const manager = internals.getSupervisorController(internals.sessions.get(NEXT)!)!;
    await manager.configure(config);
    const act = vi.spyOn(CodexTaskAdapter.prototype, 'act').mockResolvedValue('sent');
    const accepted: { submissionHash?: string } = {};
    vi.spyOn(CodexTaskAdapter.prototype, 'observe').mockImplementation(async function (this: CodexTaskAdapter) {
      const submissionHash = Reflect.get(this, 'session').id === NEXT ? accepted.submissionHash : undefined;
      return {
        observation: {
          activity: submissionHash ? 'working' : 'idle',
          reason: submissionHash ? 'turn-running' : 'observing',
          at: Date.now(),
          conversationId: '44444444-4444-4444-8444-444444444444',
          processReady: true,
          safeToAct: false,
          submissionKey: submissionHash ? 'accepted-manager-submission' : undefined,
          submissionHash,
        },
        commands: new Map(),
      };
    });
    internals.sessions.get(NEXT)!.pinRecoveryConversation('44444444-4444-4444-8444-444444444444');
    internals.sessions.get(NEXT)!.trackUserInput('Initial owner prompt in the selected manager thread\r');
    vi.spyOn(CodexRecoveryAdapter.prototype, 'confirmLocalEvidence').mockResolvedValue(true);
    // This lease test stubs identity verification above; supply its explicit
    // private issuer scope too. Native delivery stays mocked by `act`.
    const proof = fakeInputProvenance(
      { brokerPid: 99999 },
      internals.sessions.get(NEXT)!.getRecoveryContext().codexHome
    );
    vi.spyOn(CodexRecoveryAdapter.prototype, 'getLocalEvidenceSource').mockImplementation(
      function (conversationId, generation) {
        const selected = Reflect.get(this, 'session') as Session;
        return {
          sessionId: selected.id,
          identity: { reason: 'verified', conversationId },
          inputBroker: {
            sessionId: selected.id,
            incarnation: proof.incarnation,
            directory: dirname(proof.fileWitness!.path),
            proof,
            files: [proof.fileWitness!],
          },
          isCurrent: () =>
            internals.sessions.get(selected.id) === selected && selected.getRecoveryContext().generation === generation,
        };
      }
    );
    vi.spyOn(CodexRecoveryAdapter.prototype, 'getVerifiedTail').mockReturnValue('');
    vi.spyOn(CodexRecoveryAdapter.prototype, 'observe').mockImplementation(async () => ({
      activity: 'working',
      reason: 'turn-running',
      at: Date.now(),
      conversationId: '44444444-4444-4444-8444-444444444444',
      processReady: true,
      processReadyAt: Date.now(),
      safeToAct: false,
      submissionKey: 'accepted-manager-submission',
      submissionHash: accepted.submissionHash,
    }));
    await manager.start();
    const managerTask = internals.getTaskController(internals.sessions.get(NEXT)!)!;
    accepted.submissionHash = managerTask.getStatus().inFlight?.promptHash;
    await managerTask.refresh();
    expect(managerTask.getStatus().inFlight).toBeUndefined();
    act.mockClear();
    await internals.taskStore.save(WORKER, { ...initialTaskState(), agentProgressVeto: true });
    await expect(manager.assign(WORKER, 'durable-stop')).rejects.toThrow('cancelled');
    expect(act).not.toHaveBeenCalled();
    expect(manager.getStatus().workers[0].assignments).toBe(0);
    expect(manager.getStatus().inFlight).toBeUndefined();
    await internals.taskStore.save(WORKER, initialTaskState());
    await expect(manager.assign(WORKER, 'owner-released')).resolves.toMatchObject({
      workers: [expect.objectContaining({ assignments: 1 })],
    });
    expect(act).toHaveBeenCalledOnce();
  });
});
