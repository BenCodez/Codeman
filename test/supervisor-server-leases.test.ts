import { currentLocalCodexHome } from '../src/recovery/codex-home.js';
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
    recoveryCodexHome: currentLocalCodexHome(),
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

  beforeEach(async () => {
    vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);
    rebootRestoreRegistry.reset();
    server = new WebServer(0, false, true);
    internals = server as unknown as Internals;
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
    rebootRestoreRegistry.reset();
    for (const id of [OLD, NEXT, WORKER]) {
      await internals.stopRecoveryController(id, true);
      internals.sessions.delete(id);
      internals.store.removeSession(id);
    }
    await server.stop().catch(() => {});
    vi.restoreAllMocks();
  });

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
    vi.spyOn(CodexTaskAdapter.prototype, 'observe').mockImplementation(async () => ({
      observation: {
        activity: 'idle',
        reason: 'observing',
        at: Date.now(),
        conversationId: '44444444-4444-4444-8444-444444444444',
        processReady: true,
        safeToAct: false,
      },
      commands: new Map(),
    }));
    internals.sessions.get(NEXT)!.pinRecoveryConversation('44444444-4444-4444-8444-444444444444');
    vi.spyOn(CodexRecoveryAdapter.prototype, 'confirmLocalEvidence').mockReturnValue(true);
    vi.spyOn(CodexRecoveryAdapter.prototype, 'getVerifiedTail').mockReturnValue('');
    let submissionHash: string | undefined;
    vi.spyOn(CodexRecoveryAdapter.prototype, 'observe').mockImplementation(async () => ({
      activity: 'working',
      reason: 'turn-running',
      at: Date.now(),
      conversationId: '44444444-4444-4444-8444-444444444444',
      processReady: true,
      processReadyAt: Date.now(),
      safeToAct: false,
      submissionKey: 'accepted-manager-submission',
      submissionHash,
    }));
    await manager.start();
    submissionHash = internals.getTaskController(internals.sessions.get(NEXT)!)!.getStatus().inFlight?.promptHash;
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
