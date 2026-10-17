/** Real WebServer, manager Task and worker controllers; only native observations/effects are fixtures. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFile, writeFile, mkdtemp, rm, rename } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { lstatSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { invalidateUsersCache, findUser } from '../src/user-store.js';
import { clampRecoveryLaunchForOwner } from '../src/session-env-clamp.js';
import { dataPath } from '../src/config/instance.js';
import { currentLocalCodexHome } from '../src/recovery/codex-home.js';
import { WebServer } from '../src/web/server.js';
import { ManagerCredentialRegistry } from '../src/supervisor/manager-credentials.js';
import { registerSupervisorRoutes } from '../src/web/routes/supervisor-routes.js';
import { createRouteTestHarness } from './routes/_route-test-utils.js';
import { Session } from '../src/session.js';
import { TmuxManager } from '../src/tmux-manager.js';
import type { MuxSession, RecoveryMuxDispatchGuard, TerminalMultiplexer } from '../src/mux-interface.js';
import { TaskController, type TaskDependencies } from '../src/supervision/controller.js';
import type { TaskState } from '../src/supervision/schema.js';
import { TaskStore } from '../src/supervision/store.js';
import { latestProgressMarker } from '../src/supervision/evidence.js';
import { CodexTaskAdapter } from '../src/supervision/adapter.js';
import { CodexRecoveryAdapter } from '../src/recovery/codex-adapter.js';
import {
  classifyCodexTail,
  hasEmptyCodexComposer,
  permitsCodexManagerSetup,
} from '../src/recovery/codex-classifier.js';
import type { RecoveryActionAuthority, RecoveryEvidenceSource, RecoveryObservation } from '../src/recovery/types.js';
import { RecoveryController, type RecoveryDependencies } from '../src/recovery/controller.js';
import { SupervisorController, type SupervisorDependencies } from '../src/supervisor/controller.js';
import type { SupervisorStore } from '../src/supervisor/store.js';
import { initialSupervisorState } from '../src/supervisor/schema.js';
import { createDeferred } from './mocks/index.js';
import { fakeInputProvenance, updateFakeInputProvenance } from './helpers/codex-input-provenance.js';
import type { CodexBrokerProof } from '../src/recovery/codex-input-broker.js';
import type { CodexIdentityWitness } from '../src/recovery/codex-identity.js';
import { taskPromptFits } from '../src/supervision/prompt.js';

const MANAGER = '11111111-1111-4111-8111-111111111111';
const WORKER = '22222222-2222-4222-8222-222222222222';
const MANAGER_THREAD = '33333333-3333-4333-8333-333333333333';
const WORKER_THREAD = '44444444-4444-4444-8444-444444444444';
const OTHER_THREAD = '55555555-5555-4555-8555-555555555555';
const config = {
  objective: 'Coordinate the authorized repair',
  enabled: true,
  workers: [
    {
      sessionId: WORKER,
      task: 'Repair the parser',
      criteria: [{ id: 'review', description: 'Owner review', kind: 'manual' as const }],
      maxAssignments: 2,
      maxRuntimeMs: 60_000,
    },
  ],
};
interface Internals {
  sessions: Map<string, Session>;
  taskControllers: Map<string, TaskController>;
  taskStore: TaskStore;
  supervisorStore: SupervisorStore;
  getSupervisorController(session: Session): SupervisorController | undefined;
  prepareSupervisorManager(session: Session, isCurrent: () => boolean): Promise<boolean | { inspectionOnly: true }>;
  getTaskController(session: Session): TaskController | undefined;
  getRecoveryController(session: Session): RecoveryController | undefined;
  stopRecoveryController(id: string, drop: boolean): Promise<void>;
}
function expectManagerEvidenceUnchanged(actual: TaskState, before: TaskState, paused: boolean): void {
  const expected = paused
    ? {
        ...before,
        phase: 'paused',
        reason: 'owner-paused',
        history: [...before.history, { at: Date.now(), reason: 'owner-paused' }].slice(-100),
      }
    : before;
  expect(actual).toEqual(expected);
}
const inputProofs = new WeakMap<Session, CodexBrokerProof>();
const constructedSessions: Session[] = [];
async function fakeSession(id: string, conversationId: string): Promise<Session> {
  const muxSession = {
    sessionId: id,
    muxName: `fixture-${id}`,
    recoveryIsolated: true,
    recoveryCodexHome: id === MANAGER ? currentLocalCodexHome() : join(currentLocalCodexHome(), `fixture-${id}`),
    workingDir: process.cwd(),
    mode: 'codex',
    attached: true,
    pid: 99999,
    createdAt: Date.now(),
  } as MuxSession;
  // Real directory identity, isolated under the suite's temporary HOME.
  await fs.mkdir(muxSession.recoveryCodexHome!, { recursive: true, mode: 0o700 });
  const inputProof = fakeInputProvenance({ brokerPid: 99999, childPid: 100000 }, muxSession.recoveryCodexHome);
  let probeSequence = 0;
  const session = new Session({
    id,
    owner: 'alice',
    mode: 'codex',
    workingDir: process.cwd(),
    useMux: true,
    mux: {
      isAvailable: () => true,
      inspectCodexInputProvenance: async (sessionId: string, panePid: number) => {
        if (sessionId !== id || panePid !== 99999) return undefined;
        // Every real zero-child probe commits a fresh private receipt. Keep that
        // file change in this fake so a stale self-witness cannot pass unnoticed.
        updateFakeInputProvenance(inputProof, {}, (proof) => ({ ...proof, probeSequence: ++probeSequence }));
        return structuredClone(inputProof);
      },
      getCodexInputAuthority: (sessionId: string, proof: CodexBrokerProof) =>
        sessionId === id && proof.incarnation === inputProof.incarnation && proof.rawGeneration === 0
          ? {
              sessionId: id,
              incarnation: proof.incarnation,
              directory: dirname(proof.fileWitness!.path),
              proof,
              files: [proof.fileWitness!],
            }
          : undefined,
    } as unknown as TerminalMultiplexer,
    muxSession,
    codexConfig: { noDaemon: true, resumeSessionId: conversationId },
  });
  // This suite isolates Task/native issuer authority after the separate restricted launch boundary.
  vi.spyOn(session, 'isSupervisorManagerLaunchCurrent').mockReturnValue(true);
  vi.spyOn(session, 'confirmSupervisorManagerLaunch').mockImplementation(async () =>
    session.isSupervisorManagerLaunchCurrent()
  );
  vi.spyOn(session, 'captureSupervisorManagerLaunchAuthority').mockImplementation(() =>
    Object.assign(() => session.isSupervisorManagerLaunchCurrent(), {
      revoke: () => session.revokeSupervisorManagerLaunch(),
    })
  );
  constructedSessions.push(session);
  expect(await session.ensureRecoveryIdentityFence()).toBe(true);
  inputProofs.set(session, inputProof);
  session.trackUserInput('Exact initial owner fixture prompt\r');
  await Reflect.get(session, '_recoveryFencePublication');
  return session;
}

function privateEvidenceSource(session: Session, path: string, conversationId: string): RecoveryEvidenceSource {
  const stat = lstatSync(path);
  const scope = () =>
    JSON.stringify([
      session.owner,
      session.workingDir,
      session.codexConfig,
      session.getEnvOverridesForPersist(),
      session.getRecoveryContext(),
    ]);
  const snapshot = scope();
  return {
    sessionId: session.id,
    files: [inputProofs.get(session)!.fileWitness!],
    inputBroker: session.getRecoveryInputAuthority(inputProofs.get(session)!),
    identity: {
      reason: 'verified',
      conversationId,
      path,
      tail: readFileSync(path, 'utf8'),
      tailTruncated: false,
      witness: {
        paths: [
          {
            path,
            kind: 'file',
            dev: stat.dev,
            ino: stat.ino,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            ctimeMs: stat.ctimeMs,
          },
        ],
      },
    },
    isCurrent: () => scope() === snapshot,
  };
}
async function prepared(current: RecoveryActionAuthority, source: RecoveryEvidenceSource): Promise<boolean> {
  return current() && (!current.prepareEvidence || (await current.prepareEvidence(source)) === true) && current();
}

describe('manager authority at the real server boundary', () => {
  let server: WebServer;
  let internals: Internals;
  let originalTaskStore: TaskStore;
  let managerSession: Session;
  let manager: SupervisorController;
  let managerTask: TaskController;
  let managerDeps: SupervisorDependencies;
  let observation: RecoveryObservation;
  let workerObservation: RecoveryObservation;
  let taskAct: ReturnType<typeof vi.spyOn>;
  let recoveryAct: ReturnType<typeof vi.spyOn>;
  let rolloutPath: string;
  let workerRolloutPath: string;
  let workerPaths: CodexIdentityWitness['paths'];
  let effects: ReturnType<typeof vi.fn>;
  let grantDirectory: string | undefined;
  let fixtureData: string;
  let previousData: string | undefined;
  let previousMode: string | undefined;
  let previousPassword: string | undefined;

  beforeEach(async () => {
    // Native MCP transport is separately exercised through the real route suite.
    vi.spyOn(ManagerCredentialRegistry.prototype, 'hasToolsDiscovery').mockReturnValue(true);
    previousData = process.env.CODEMAN_DATA_DIR;
    previousMode = process.env.CODEMAN_MULTIUSER;
    previousPassword = process.env.CODEMAN_PASSWORD;
    process.env.CODEMAN_MULTIUSER = '0';
    process.env.CODEMAN_PASSWORD = 'fixture-owner-auth';
    grantDirectory = undefined;
    fixtureData = await mkdtemp(join(homedir(), 'manager-authority-state-'));
    process.env.CODEMAN_DATA_DIR = fixtureData;
    workerPaths = [];
    vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);
    server = new WebServer(0, false, true);
    Reflect.set(server, 'supervisorManagerAuthReady', true);
    internals = server as unknown as Internals;
    originalTaskStore = internals.taskStore;
    managerSession = await fakeSession(MANAGER, MANAGER_THREAD);
    internals.sessions.set(MANAGER, managerSession);
    internals.sessions.set(WORKER, await fakeSession(WORKER, WORKER_THREAD));
    observation = {
      conversationId: MANAGER_THREAD,
      activity: 'idle',
      reason: 'observing',
      at: Date.now(),
      processReady: true,
      safeToAct: false,
      submissionKey: 'old-manager-submission',
    };
    workerObservation = {
      conversationId: WORKER_THREAD,
      activity: 'crashed',
      reason: 'process-crashed',
      at: Date.now(),
      liveProofAt: Date.now(),
      evidenceKey: 'worker-crash',
      processReady: false,
      safeToAct: true,
    };
    rolloutPath = dataPath('manager-authority-rollout.jsonl');
    workerRolloutPath = dataPath('worker-authority-rollout.jsonl');
    await writeFile(
      rolloutPath,
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Initial owner prompt' } }) + '\n'
    );
    await writeFile(
      workerRolloutPath,
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n'
    );
    vi.spyOn(CodexTaskAdapter.prototype, 'observe').mockImplementation(async function () {
      const session = Reflect.get(this, 'session') as Session;
      if (session.id === WORKER || session.id === MANAGER) {
        const source = privateEvidenceSource(
          session,
          session.id === WORKER ? workerRolloutPath : rolloutPath,
          session.id === WORKER ? WORKER_THREAD : MANAGER_THREAD
        );
        if (session.id === WORKER) source.identity.witness!.paths.push(...workerPaths);
        Reflect.set(Reflect.get(this, 'recovery'), 'verifiedTail', {
          ...source.identity,
          inputProof: inputProofs.get(session),
          config: JSON.stringify(session.codexConfig),
          env: JSON.stringify(session.getEnvOverridesForPersist()),
        });
      }
      const path = session.id === MANAGER ? rolloutPath : workerRolloutPath;
      return {
        observation:
          session.id === MANAGER
            ? observation
            : {
                ...workerObservation,
                activity: 'idle',
                reason: 'observing',
                processReady: true,
                safeToAct: false,
              },
        commands: new Map(),
        marker: latestProgressMarker(readFileSync(path, 'utf8'), 0, Date.now()),
      };
    });
    vi.spyOn(CodexRecoveryAdapter.prototype, 'observe').mockImplementation(async function () {
      const session = Reflect.get(this, 'session') as Session;
      if (session.id !== MANAGER) return workerObservation;
      const stat = lstatSync(rolloutPath);
      Reflect.set(this, 'verifiedTail', {
        inputProof: inputProofs.get(session),
        conversationId: observation.conversationId,
        path: rolloutPath,
        tail: readFileSync(rolloutPath, 'utf8'),
        tailTruncated: false,
        witness: {
          paths: [
            {
              path: rolloutPath,
              kind: 'file',
              dev: stat.dev,
              ino: stat.ino,
              size: stat.size,
              mtimeMs: stat.mtimeMs,
              ctimeMs: stat.ctimeMs,
            },
          ],
        },
        config: JSON.stringify(session.codexConfig),
        env: JSON.stringify(session.getEnvOverridesForPersist()),
      });
      return { ...observation, processReadyAt: observation.processReadyAt ?? Date.now() };
    });
    effects = vi.fn();
    taskAct = vi
      .spyOn(CodexTaskAdapter.prototype, 'act')
      .mockImplementation(async (_key, _thread, _prompt, current) => {
        if (
          !(await prepared(
            current,
            privateEvidenceSource(internals.sessions.get(WORKER)!, workerRolloutPath, WORKER_THREAD)
          ))
        )
          return 'not-sent';
        effects();
        return 'sent';
      });
    recoveryAct = vi.spyOn(CodexRecoveryAdapter.prototype, 'act').mockImplementation(async (_flight, current) => {
      if (
        !(await prepared(
          current,
          privateEvidenceSource(internals.sessions.get(WORKER)!, workerRolloutPath, WORKER_THREAD)
        ))
      )
        return 'not-sent';
      effects();
      return 'sent';
    });
    manager = internals.getSupervisorController(managerSession)!;
    managerDeps = Reflect.get(manager, 'deps') as SupervisorDependencies;
    await manager.configure(config);
    await manager.start();
    managerTask = internals.getTaskController(managerSession)!;
    const kickoff = managerTask.getStatus().inFlight!;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10);
    const userLine = JSON.stringify({
      timestamp: new Date(Date.now()).toISOString(),
      type: 'event_msg',
      payload: { type: 'user_message', message: taskAct.mock.calls[0][2] },
    });
    const submissionKey = createHash('sha256').update(userLine).digest('hex');
    await writeFile(
      rolloutPath,
      userLine +
        '\n' +
        JSON.stringify({
          timestamp: new Date(Date.now()).toISOString(),
          type: 'event_msg',
          payload: { type: 'task_started', turn_id: 'manager-turn' },
        }) +
        '\n'
    );
    observation = {
      ...observation,
      activity: 'working',
      reason: 'turn-running',
      submissionKey,
      submissionHash: kickoff.promptHash,
    };
    await managerTask.refresh();
    expect(managerTask.getStatus().inFlight).toBeUndefined();
    taskAct.mockClear();
    recoveryAct.mockClear();
    effects.mockClear();
  });

  afterEach(async () => {
    for (const session of constructedSessions.splice(0)) await Reflect.get(session, '_recoveryFencePublication');
    internals.taskStore = originalTaskStore;
    for (const id of [MANAGER, WORKER]) {
      await internals.stopRecoveryController(id, true).catch(() => {});
      internals.sessions.delete(id);
    }
    await server.stop().catch(() => {});
    if (previousData === undefined) delete process.env.CODEMAN_DATA_DIR;
    else process.env.CODEMAN_DATA_DIR = previousData;
    if (previousMode === undefined) delete process.env.CODEMAN_MULTIUSER;
    else process.env.CODEMAN_MULTIUSER = previousMode;
    if (previousPassword === undefined) delete process.env.CODEMAN_PASSWORD;
    else process.env.CODEMAN_PASSWORD = previousPassword;
    invalidateUsersCache();
    if (grantDirectory) await rm(grantDirectory, { recursive: true, force: true });
    await rm(fixtureData, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function appendProgress(progress: unknown, at = Date.now()): Promise<void> {
    const message = typeof progress === 'string' ? progress : JSON.stringify(progress);
    await appendFile(
      rolloutPath,
      JSON.stringify({
        timestamp: new Date(at).toISOString(),
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'CODEMAN_TASK_PROGRESS ' + message },
      }) + '\n'
    );
  }

  it('owner reset revokes the manager credential and launch artifacts before awaiting its journal', async () => {
    const registry = Reflect.get(
      server,
      'supervisorManagerCredentials'
    ) as import('../src/supervisor/manager-credentials.js').ManagerCredentialRegistry;
    const credential = registry.issue({ sessionId: MANAGER, owner: 'alice', isCurrent: () => true });
    expect(registry.resolve(credential.token)).toBeDefined();
    const revoke = vi.spyOn(managerSession, 'revokeSupervisorManagerLaunch');
    const entered = createDeferred(),
      release = createDeferred();
    const save = internals.supervisorStore.save.bind(internals.supervisorStore);
    vi.spyOn(internals.supervisorStore, 'save').mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      await save(...args);
    });
    const resetting = manager.reset();
    expect(revoke).toHaveBeenCalledOnce();
    expect(registry.resolve(credential.token)).toBeUndefined();
    try {
      await entered.promise;
    } finally {
      release.resolve();
    }
    await resetting;
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(effects).not.toHaveBeenCalled();
  });

  it.each([
    'live-paused',
    'live-blocked',
    'durable-paused',
    'durable-blocked',
    'matching',
    'without-launch',
    'disabled',
    'late-task',
  ] as const)('preserves owner task ownership during manager preparation (%s)', async (kind) => {
    await manager.pause();
    observation = { ...observation, activity: 'completed', reason: 'turn-completed', safeToAct: false };
    const original = managerTask.getStatus();
    const changed: TaskState = {
      ...original,
      objective: 'Preserve the owner repair objective',
      checkpoint: 'Keep the owner checkpoint',
      phase: kind.includes('blocked') ? 'blocked' : 'paused',
      config: { ...original.config, enabled: kind !== 'disabled' },
    };
    if (kind.startsWith('live-') || kind === 'disabled') Reflect.set(managerTask, 'state', changed);
    if (kind.startsWith('durable-')) await internals.taskStore.save(MANAGER, changed);
    if (kind === 'without-launch') vi.mocked(managerSession.isSupervisorManagerLaunchCurrent).mockReturnValue(false);
    const beforeLive = managerTask.getStatus(),
      beforeDurable = internals.taskStore.get(MANAGER);
    const prepare = vi.spyOn(managerSession, 'prepareSupervisorManager').mockImplementation(async (options) => {
      if (kind === 'late-task') Reflect.set(managerTask, 'state', changed);
      return options.isCurrent();
    });
    const result = await internals.prepareSupervisorManager(managerSession, () => true);
    expect(result).toBe(kind === 'matching' || kind === 'disabled');
    if (['matching', 'disabled', 'late-task'].includes(kind)) expect(prepare).toHaveBeenCalledOnce();
    else expect(prepare).not.toHaveBeenCalled();
    expect(managerTask.getStatus()).toEqual(kind === 'late-task' ? changed : beforeLive);
    expect(internals.taskStore.get(MANAGER)).toEqual(beforeDurable);
    expect(effects).not.toHaveBeenCalled();
  });

  it.each(['existing', 'queued', 'late'] as const)(
    'keeps a leased worker out of manager conversion through %s authority',
    async (kind) => {
      await manager.pause();
      observation = { ...observation, activity: 'completed', reason: 'turn-completed', safeToAct: false };
      const otherId = '66666666-6666-4666-8666-666666666666';
      const other = await fakeSession(otherId, OTHER_THREAD);
      internals.sessions.set(otherId, other);
      const lease = () =>
        internals.supervisorStore.save(otherId, {
          ...initialSupervisorState(otherId),
          ...config,
          phase: 'ready',
          workers: [{ ...config.workers[0], sessionId: MANAGER, assignments: 0 }],
        });
      const prepare = vi.spyOn(managerSession, 'prepareSupervisorManager').mockImplementation(async (options) => {
        if (kind === 'late') await lease();
        return options.isCurrent();
      });
      const entered = createDeferred(),
        release = createDeferred();
      let held: Promise<unknown> | undefined;
      try {
        if (kind === 'existing') await lease();
        if (kind === 'queued') {
          held = Reflect.get(server, 'withSupervisorLeases').call(server, async () => {
            await lease();
            entered.resolve();
            await release.promise;
          });
          await entered.promise;
        }
        const converting = internals.prepareSupervisorManager(managerSession, () => true);
        if (kind === 'queued') {
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(prepare).not.toHaveBeenCalled();
          release.resolve();
          await held;
        }
        expect(await converting).toBe(false);
        if (kind === 'late') expect(prepare).toHaveBeenCalledOnce();
        else expect(prepare).not.toHaveBeenCalled();
        expect(internals.supervisorStore.get(otherId).enabled).toBe(true);
        expect(effects).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await held;
        internals.sessions.delete(otherId);
        await other.stop(false);
      }
    }
  );

  it.each(['teaching', 'owner-changed', 'untracked-input'] as const)(
    'keeps paused owner teaching separate from worker authority through the actual server (%s)',
    async (kind) => {
      await manager.pause();
      observation = { ...observation, activity: 'completed', reason: 'turn-completed', safeToAct: false };
      const revoke = vi.fn(async () => {});
      vi.spyOn(managerSession, 'prepareSupervisorManager').mockImplementation(async (options) => {
        // Native launch is a fixture; retain the REAL server preparation scope
        // and exercise Session's real profile lifecycle after acknowledgment.
        Reflect.set(managerSession, '_supervisorManagerProfile', {
          isCurrent: () =>
            options.isCurrent() &&
            !managerSession.getRecoveryContext().switchPending &&
            !managerSession.getRecoveryContext().untrackedInput,
          revoke,
        });
        const mux = Reflect.get(managerSession, '_mux') as TerminalMultiplexer;
        Reflect.set(mux, 'isSupervisorManagerLaunchCurrent', () => true);
        return options.isCurrent();
      });
      expect(await internals.prepareSupervisorManager(managerSession, () => true)).toBe(true);
      vi.mocked(managerSession.isSupervisorManagerLaunchCurrent).mockRestore();
      vi.mocked(managerSession.captureSupervisorManagerLaunchAuthority).mockRestore();
      expect(managerSession.isSupervisorManagerLaunchCurrent()).toBe(true);
      managerSession.emit('recoveryUserInput');
      await managerTask.drain();
      expect(managerSession.hasSupervisorManagerLaunch()).toBe(true);
      expect(revoke).not.toHaveBeenCalled();
      // Hold the tracked input publication boundary. It grants no manager
      // operations while pending and must not destroy the exact profile.
      Reflect.set(managerSession, '_recoverySwitchPending', true);
      expect(managerSession.isSupervisorManagerLaunchCurrent()).toBe(false);
      expect(managerSession.hasSupervisorManagerLaunch()).toBe(true);
      expect(revoke).not.toHaveBeenCalled();
      expect(await manager.captureBrainAuthority(() => true)).toBeUndefined();
      Reflect.set(managerSession, '_recoverySwitchPending', false);
      expect(managerTask.getStatus().phase).toBe('paused');
      if (kind === 'owner-changed') Reflect.set(managerSession, 'owner', 'different-owner');
      if (kind === 'untracked-input') Reflect.set(managerSession, '_recoveryUntrackedInput', true);
      const authority = await manager.captureBrainAuthority(() => true);
      const brain = Reflect.get(server, 'supervisorBrainStore') as import('../src/supervisor/brain.js').BrainStore;
      if (kind === 'teaching') {
        expect(authority?.()).toBe(true);
        const before = await brain.read(MANAGER, authority!);
        const saved = await brain.append(
          MANAGER,
          'owner-teaching-0001',
          'API worker owns backend changes. Keep prompts concise.',
          before.revision,
          authority!
        );
        expect(saved.markdown).toContain('API worker owns backend changes.');
        expect(saved.noteCount).toBe(1);
      } else {
        expect(authority).toBeUndefined();
        expect((await brain.read(MANAGER, () => true)).exists).toBe(false);
      }
      await expect(manager.assign(WORKER, 'no-worker-action-after-owner-input')).rejects.toThrow();
      expect(effects).not.toHaveBeenCalled();
      expect(taskAct).not.toHaveBeenCalled();
      expect(recoveryAct).not.toHaveBeenCalled();
    }
  );

  it.each([true, false])(
    'establishes an uninspected manager identity only through adapter proof: %s',
    async (verified) => {
      await manager.pause();
      await managerTask.update({ config: { enabled: false } });
      process.env.CODEMAN_PASSWORD = 'fixture-owner-auth';
      Reflect.set(server, 'supervisorManagerAuthReady', true);
      Reflect.set(managerSession, '_codexConfig', { ...managerSession.codexConfig, resumeSessionId: undefined });
      observation = { ...observation, activity: 'completed', reason: 'turn-completed', safeToAct: false };
      const observe = vi.mocked(CodexRecoveryAdapter.prototype.observe);
      const original = observe.getMockImplementation()!;
      observe.mockImplementation(async function () {
        if (verified) managerSession.pinRecoveryConversation(MANAGER_THREAD);
        return original.call(this);
      });
      const prepare = vi.spyOn(managerSession, 'prepareSupervisorManager').mockResolvedValue(true);
      expect(await internals.prepareSupervisorManager(managerSession, () => true)).toBe(verified);
      expect(observe).toHaveBeenCalled();
      expect(prepare).toHaveBeenCalledTimes(verified ? 1 : 0);
    }
  );

  it.each(['completed', 'draft-changed', 'owner-cancelled'] as const)(
    'uses real tagged owner writes for the bounded setup turn: %s',
    async (kind) => {
      await manager.pause();
      const at = Date.now();
      Reflect.set(managerSession, '_paneStartedAt', at - 1000);
      const setting = {
        type: 'thread_settings_applied',
        thread_id: MANAGER_THREAD,
        thread_settings: {
          model: 'fixture',
          model_provider_id: 'fixture',
          approval_policy: 'on-request',
          approvals_reviewer: 'user',
          permission_profile: {
            type: 'managed',
            file_system: { type: 'restricted', entries: [] },
            network: 'restricted',
          },
          cwd: '/fixture',
          runtime_workspace_roots: ['/fixture'],
          collaboration_mode: { mode: 'default', settings: { model: 'fixture' } },
          disabled_plugin_ids: [],
        },
      };
      const nativeLine = (payload: unknown) =>
        JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload }) + '\n';
      await writeFile(
        rolloutPath,
        nativeLine({ type: 'user_message', message: 'Prior owner prompt' }) +
          nativeLine({ type: 'task_started', turn_id: 'prior-turn' }) +
          nativeLine({ type: 'task_complete', turn_id: 'prior-turn' }) +
          nativeLine(setting)
      );
      observation = { ...observation, activity: 'paused', reason: 'approval-required', processReady: true };
      vi.mocked(managerSession.isSupervisorManagerLaunchCurrent).mockRestore();
      vi.mocked(managerSession.captureSupervisorManagerLaunchAuthority).mockRestore();
      const profile = { isCurrent: () => true, confirm: async () => true, revoke: vi.fn(async () => {}) };
      Reflect.set(managerSession, '_supervisorManagerProfile', profile);
      const mux = Reflect.get(managerSession, '_mux') as TerminalMultiplexer;
      Reflect.set(mux, 'isSupervisorManagerLaunchCurrent', () => true);
      let draft = '',
        current = true;
      Reflect.set(mux, 'inspectPaneForRecovery', async () => ({
        dead: false,
        paneId: '%7',
        panePid: 99999,
        screen: `› ${draft}\n\n  fixture default · /fixture\n  ? for shortcuts\n`,
      }));
      const writes: string[] = [];
      const previousPty = managerSession.ptyProcess;
      Reflect.set(managerSession, 'ptyProcess', {
        write: (input: string) => {
          writes.push(input);
          if (input !== '\r') {
            draft = kind === 'draft-changed' ? 'Different owner draft' : input;
            if (kind === 'owner-cancelled') current = false;
          } else {
            draft = '';
            const text = writes[0];
            appendFileSync(
              rolloutPath,
              nativeLine({ type: 'user_message', message: text }) +
                nativeLine({ type: 'task_started', turn_id: 'setup-turn' }) +
                nativeLine({ type: 'task_complete', turn_id: 'setup-turn' })
            );
            observation = {
              ...observation,
              activity: 'completed',
              reason: 'turn-completed',
              submissionHash: createHash('sha256').update(text).digest('hex'),
            };
          }
        },
      });
      const phases: string[] = [];
      try {
        expect(managerSession.captureSupervisorManagerOwnerInputAuthority()?.()).toBe(true);
        expect(Reflect.get(server, 'managerTaskAllowsPreparation').call(server, managerSession)).toBe(true);
        const preflight = new CodexRecoveryAdapter(managerSession);
        const observed = await preflight.observe();
        const source = preflight.getLocalEvidenceSource(MANAGER_THREAD, managerSession.getRecoveryContext().generation);
        expect(observed.activity).toBe('paused');
        expect(source).toBeDefined();
        expect(
          permitsCodexManagerSetup(
            readFileSync(rolloutPath, 'utf8'),
            {
              conversationId: MANAGER_THREAD,
              now: at,
              screen: '› ',
              busy: false,
              watching: false,
              tailTruncated: false,
            },
            at - 1000
          )
        ).toBe(true);
        expect(
          await preflight.confirmLocalEvidence(MANAGER_THREAD, managerSession.getRecoveryContext().generation)
        ).toBe(true);
        const result = await Reflect.get(server, 'sendManagerSetupTurn').call(
          server,
          managerSession,
          'owner-setup-test',
          () => current,
          async (phase: string) => {
            phases.push(phase);
          }
        );
        expect(result).toBe(kind === 'completed');
        expect(writes).toEqual(kind === 'completed' ? ['Reply READY only.', '\r'] : ['Reply READY only.']);
        expect(phases).toContain('literal-reserved');
        if (kind === 'completed') expect(phases.at(-1)).toBe('turn-completed');
      } finally {
        Reflect.set(managerSession, 'ptyProcess', previousPty);
      }
    }
  );

  it.each([false, true])(
    'retains exact newly prepared task ownership through start, pause and teaching (unrelated task: %s)',
    async (unrelated) => {
      await manager.reset();
      await manager.configure(config);
      vi.mocked(managerSession.isSupervisorManagerLaunchCurrent).mockRestore();
      vi.mocked(managerSession.captureSupervisorManagerLaunchAuthority).mockRestore();
      expect(managerSession.isSupervisorManagerLaunchCurrent()).toBe(false);
      observation = { ...observation, activity: 'completed', reason: 'turn-completed', safeToAct: false };
      const revoke = vi.fn(async () => {});
      vi.spyOn(managerSession, 'prepareSupervisorManager').mockImplementation(async (options) => {
        Reflect.set(managerSession, '_supervisorManagerProfile', { isCurrent: options.isCurrent, revoke });
        Reflect.set(Reflect.get(managerSession, '_mux'), 'isSupervisorManagerLaunchCurrent', () => true);
        return options.isCurrent();
      });
      expect(await internals.prepareSupervisorManager(managerSession, () => true)).toBe(true);
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
      expect((await manager.start()).phase).toBe('active');
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10);
      // Settle the known kickoff before the owner pauses and teaches the manager.
      const kickoff = managerTask.getStatus().inFlight!;
      const userLine = JSON.stringify({
        timestamp: new Date(Date.now()).toISOString(),
        type: 'event_msg',
        payload: { type: 'user_message', message: taskAct.mock.calls[0][2] },
      });
      await writeFile(rolloutPath, userLine + '\n');
      observation = {
        ...observation,
        submissionKey: createHash('sha256').update(userLine).digest('hex'),
        submissionHash: kickoff.promptHash,
      };
      await managerTask.refresh();
      expect(managerTask.getStatus().inFlight).toBeUndefined();
      await manager.pause();
      managerSession.emit('recoveryUserInput');
      await managerTask.drain();
      if (unrelated) await managerTask.update({ objective: 'An unrelated owner task' });
      const result = await internals.prepareSupervisorManager(managerSession, () => true);
      if (unrelated) expect(result).not.toBe(true);
      else {
        expect(result).toBe(true);
        expect((await manager.start()).phase).toBe('active');
      }
      expect(revoke).not.toHaveBeenCalled();
    }
  );

  it('requires native tool discovery and refreshes idle evidence after an earlier ready result', async () => {
    await manager.pause();
    observation = { ...observation, activity: 'completed', reason: 'turn-completed', safeToAct: false };
    vi.mocked(ManagerCredentialRegistry.prototype.hasToolsDiscovery).mockReturnValue(false);
    let launched = false;
    let offset = 0;
    const now = performance.now();
    vi.spyOn(performance, 'now').mockImplementation(() => now + offset);
    const observe = vi.mocked(CodexRecoveryAdapter.prototype.observe);
    const original = observe.getMockImplementation()!;
    observe.mockImplementation(async function () {
      const result = await original.call(this);
      if (launched) offset += 5_001;
      return result;
    });
    const prepare = vi.spyOn(managerSession, 'prepareSupervisorManager').mockImplementation(async () => {
      launched = true;
      return true;
    });
    expect(await internals.prepareSupervisorManager(managerSession, () => true)).toEqual({ inspectionOnly: true });
    await expect(manager.start()).rejects.toThrow(/restricted manager/);
    vi.mocked(ManagerCredentialRegistry.prototype.hasToolsDiscovery).mockReturnValue(true);
    expect(await internals.prepareSupervisorManager(managerSession, () => true)).toBe(true);
    observation = { ...observation, activity: 'working', processReady: true };
    expect(await internals.prepareSupervisorManager(managerSession, () => true)).toEqual({ inspectionOnly: true });
    expect(prepare).toHaveBeenCalledOnce();
    await expect(manager.start()).rejects.toThrow(/restricted manager/);
    expect(effects).not.toHaveBeenCalled();
  });

  it('prepares only a verified idle manager with explicit request scope, retaining UUID and private startup evidence', async () => {
    await manager.pause();
    process.env.CODEMAN_PASSWORD = 'fixture-owner-auth';
    // Global HTTP authentication is independently exercised by the actual server auth suite.
    Reflect.set(server, 'supervisorManagerAuthReady', true);
    observation = { ...observation, activity: 'completed', reason: 'turn-completed', safeToAct: false };
    const prepare = vi.spyOn(managerSession, 'prepareSupervisorManager').mockImplementation(async (options) => {
      expect(options.isCurrent()).toBe(true);
      expect(options.token).toMatch(/^codeman-manager-v1\.[a-f0-9]{64}$/);
      expect(options.files?.some((file) => file.path === rolloutPath)).toBe(true);
      expect(managerSession.codexConfig?.resumeSessionId).toBe(MANAGER_THREAD);
      return true;
    });
    expect(await internals.prepareSupervisorManager(managerSession, () => true)).toBe(true);
    expect(prepare).toHaveBeenCalledOnce();
  });

  it.each(['reset', 'current-ready', 'current-uncertain', 'unknown', 'replacement', 'cancelled'] as const)(
    'handles one confirmed Prepare after %s at the real HTTP boundary',
    async (kind) => {
      await manager.pause();
      observation = { ...observation, activity: 'completed', reason: 'turn-completed', safeToAct: false };
      let ownerCurrent = true,
        launches = 0,
        offset = 0;
      const now = performance.now();
      vi.spyOn(performance, 'now').mockImplementation(() => now + offset);
      const observe = vi.mocked(CodexRecoveryAdapter.prototype.observe),
        originalObserve = observe.getMockImplementation()!;
      observe.mockImplementation(async function () {
        if (launches && kind === 'current-uncertain') {
          offset += 5001;
          return { ...observation, activity: 'unknown', processReady: false };
        }
        return originalObserve.call(this);
      });
      vi.mocked(managerSession.captureSupervisorManagerLaunchAuthority).mockImplementation(() =>
        Session.prototype.captureSupervisorManagerLaunchAuthority.call(managerSession)
      );
      const profiles: Array<{ isCurrent(): boolean; revoke: ReturnType<typeof vi.fn> }> = [];
      const prepare = vi.spyOn(managerSession, 'prepareSupervisorManager').mockImplementation(async (options) => {
        expect(options.isCurrent()).toBe(true);
        const profile = { isCurrent: () => true, revoke: vi.fn(async () => true) };
        profiles.push(profile);
        Reflect.set(managerSession, '_supervisorManagerProfile', profile);
        launches++;
        return true;
      });
      const h = await createRouteTestHarness(
        (app, ctx) =>
          registerSupervisorRoutes(app, {
            ...ctx,
            sessions: internals.sessions,
            getSupervisorController: (session: Session) => internals.getSupervisorController(session),
            prepareSupervisorManager: (session: Session, current: () => boolean) =>
              internals.prepareSupervisorManager(session, () => current() && ownerCurrent),
          }),
        { authUser: { username: 'alice', role: 'user' } }
      );
      // Real responses carry writableFinished; synthetic injection responses do not.
      await h.app.listen({ port: 0, host: '127.0.0.1' });
      const port = (h.app.server.address() as { port: number }).port;
      const request = async (action = 'prepare-manager') => {
        const response = await fetch(`http://127.0.0.1:${port}/api/sessions/${MANAGER}/supervisor/${action}`, {
          method: 'POST',
          ...(action === 'prepare-manager'
            ? {
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ confirmRestrictedManager: true }),
              }
            : {}),
        });
        const body = await response.json();
        return { statusCode: response.status, json: () => body };
      };
      let replacement: { isCurrent(): boolean; revoke: ReturnType<typeof vi.fn> } | undefined;
      try {
        const first = await request();
        expect(first.statusCode).toBe(200);
        expect(first.json().data).toEqual(
          kind === 'current-uncertain' ? { managerReady: false, managerInspectionOnly: true } : { managerReady: true }
        );
        expect(prepare).toHaveBeenCalledOnce();
        if (['reset', 'unknown', 'cancelled'].includes(kind)) {
          const reset = await request('reset');
          expect(reset.statusCode).toBe(200);
          expect(profiles[0].revoke).toHaveBeenCalledOnce();
          expect(managerSession.hasSupervisorManagerLaunch()).toBe(false);
        }
        if (kind === 'unknown') observation = { ...observation, activity: 'unknown', processReady: false };
        if (kind === 'cancelled') ownerCurrent = false;
        if (kind === 'replacement') {
          replacement = { isCurrent: () => true, revoke: vi.fn(async () => true) };
          Reflect.set(managerSession, '_supervisorManagerProfile', replacement);
        }
        const second = await request();
        if (kind === 'reset' || kind === 'current-ready') {
          expect(second.statusCode).toBe(200);
          expect(second.json().data).toEqual({ managerReady: true });
          expect(prepare).toHaveBeenCalledTimes(kind === 'reset' ? 2 : 1);
          if (kind === 'reset') expect(Reflect.get(managerSession, '_supervisorManagerProfile')).toBe(profiles[1]);
        } else if (kind === 'current-uncertain') {
          expect(second.statusCode).toBe(200);
          expect(second.json().data).toEqual({ managerReady: false, managerInspectionOnly: true });
          expect(prepare).toHaveBeenCalledOnce();
        } else {
          expect(second.statusCode).toBe(400);
          expect(prepare).toHaveBeenCalledOnce();
          if (replacement) {
            expect(Reflect.get(managerSession, '_supervisorManagerProfile')).toBe(replacement);
            expect(replacement.revoke).not.toHaveBeenCalled();
          }
        }
        expect(taskAct).not.toHaveBeenCalled();
        expect(recoveryAct).not.toHaveBeenCalled();
        expect(effects).not.toHaveBeenCalled();
      } finally {
        await h.app.close();
        Reflect.set(managerSession, '_supervisorManagerProfile', undefined);
      }
    }
  );

  it('binds inspection authority and retirement to one exact profile, preserving a replacement', async () => {
    const original = {},
      replacement = {};
    Reflect.set(managerSession, '_supervisorManagerProfile', original);
    const authority = Session.prototype.captureSupervisorManagerLaunchAuthority.call(managerSession)!;
    const revoke = vi.spyOn(managerSession, 'revokeSupervisorManagerLaunch');
    try {
      expect(authority()).toBe(true);
      Reflect.set(managerSession, '_supervisorManagerProfile', replacement);
      expect(authority()).toBe(false);
      await authority.revoke();
      expect(revoke).not.toHaveBeenCalled();
      expect(Reflect.get(managerSession, '_supervisorManagerProfile')).toBe(replacement);
    } finally {
      Reflect.set(managerSession, '_supervisorManagerProfile', undefined);
    }
  });

  it.each(['timeout', 'observe-failure', 'working'] as const)(
    'retains an acknowledged exact launch for inspection after %s and rechecks without respawning',
    async (kind) => {
      await manager.pause();
      Reflect.set(server, 'supervisorManagerAuthReady', true);
      observation = { ...observation, activity: 'completed', reason: 'turn-completed', safeToAct: false };
      const registry = Reflect.get(
        server,
        'supervisorManagerCredentials'
      ) as import('../src/supervisor/manager-credentials.js').ManagerCredentialRegistry;
      let launched = false,
        inspect = true,
        token = '',
        offset = 0;
      const monotonic = performance.now.bind(performance);
      const now = monotonic();
      vi.spyOn(performance, 'now').mockImplementation(() => now + offset);
      const observe = vi.mocked(CodexRecoveryAdapter.prototype.observe);
      const original = observe.getMockImplementation()!;
      observe.mockImplementation(async function () {
        if (launched && inspect) {
          if (kind === 'observe-failure') throw Error('fixture failed readiness observation');
          if (kind === 'timeout') offset += 5_001;
          return { ...observation, activity: kind === 'working' ? 'working' : 'unknown', processReady: false };
        }
        return original.call(this);
      });
      const revoke = vi.spyOn(managerSession, 'revokeSupervisorManagerLaunch');
      const prepare = vi.spyOn(managerSession, 'prepareSupervisorManager').mockImplementation(async (options) => {
        token = options.token;
        launched = true;
        return true;
      });
      expect(await internals.prepareSupervisorManager(managerSession, () => true)).toEqual({ inspectionOnly: true });
      const scope = registry.resolve(token)!;
      expect(scope).toBeDefined();
      expect(registry.canOperate(scope)).toBe(false);
      expect(revoke).not.toHaveBeenCalled();
      expect(await internals.prepareSupervisorManager(managerSession, () => true)).toEqual({ inspectionOnly: true });
      expect(prepare).toHaveBeenCalledOnce();
      expect(registry.canOperate(scope)).toBe(false);
      await expect(manager.inspectWorkers()).rejects.toThrow(/not active/);
      expect((await manager.inspectWorkers(true)).map((worker) => worker.sessionId)).toEqual([WORKER]);
      const taskBeforeStart = managerTask.getStatus();
      await expect(manager.start()).rejects.toThrow(/restricted manager/);
      expectManagerEvidenceUnchanged(managerTask.getStatus(), taskBeforeStart, true);
      expect(registry.resolve(token)).toBe(scope);
      expect(prepare).toHaveBeenCalledOnce();
      inspect = false;
      expect(await internals.prepareSupervisorManager(managerSession, () => true)).toBe(true);
      expect(prepare).toHaveBeenCalledOnce();
      expect(registry.resolve(token)).toBe(scope);
      expect(registry.canOperate(scope)).toBe(true);
      expect(await internals.prepareSupervisorManager(managerSession, () => true)).toBe(true);
      expect(prepare).toHaveBeenCalledOnce();
      expect(effects).not.toHaveBeenCalled();
    }
  );
  it.each(['owner', 'config', 'authentication', 'incarnation', 'cancelled'] as const)(
    'revokes instead of retaining a launch with changed %s proof',
    async (kind) => {
      await manager.pause();
      Reflect.set(server, 'supervisorManagerAuthReady', true);
      observation = { ...observation, activity: 'completed', reason: 'turn-completed', safeToAct: false };
      let current = true,
        token = '';
      const revoke = vi.spyOn(managerSession, 'revokeSupervisorManagerLaunch');
      vi.spyOn(managerSession, 'prepareSupervisorManager').mockImplementation(async (options) => {
        token = options.token;
        if (kind === 'owner') managerSession.owner = 'changed-owner';
        if (kind === 'config')
          Reflect.set(managerSession, '_codexConfig', { ...managerSession.codexConfig, model: 'changed-model' });
        if (kind === 'authentication') process.env.CODEMAN_PASSWORD = 'changed-fixture-password';
        if (kind === 'incarnation') vi.mocked(managerSession.isSupervisorManagerLaunchCurrent).mockReturnValue(false);
        if (kind === 'cancelled') current = false;
        return true;
      });
      expect(await internals.prepareSupervisorManager(managerSession, () => current)).toBe(false);
      const registry = Reflect.get(
        server,
        'supervisorManagerCredentials'
      ) as import('../src/supervisor/manager-credentials.js').ManagerCredentialRegistry;
      expect(registry.resolve(token)).toBeUndefined();
      expect(revoke).toHaveBeenCalled();
      expect(effects).not.toHaveBeenCalled();
    }
  );

  it.each(['active', 'working', 'unknown'] as const)(
    'does not interrupt a %s manager to convert its role',
    async (kind) => {
      const prepare = vi.spyOn(managerSession, 'prepareSupervisorManager');
      if (kind !== 'active') await manager.pause();
      observation = {
        ...observation,
        activity: kind === 'unknown' ? 'unknown' : 'working',
        reason: kind === 'unknown' ? 'identity-unverified' : 'turn-running',
        processReady: kind !== 'unknown',
      };
      expect(await internals.prepareSupervisorManager(managerSession, () => true)).toBe(false);
      expect(prepare).not.toHaveBeenCalled();
    }
  );

  it('does not acknowledge conversion after its owner request is cancelled during the final launch await', async () => {
    await manager.pause();
    process.env.CODEMAN_PASSWORD = 'fixture-owner-auth';
    // Global HTTP authentication is independently exercised by the actual server auth suite.
    Reflect.set(server, 'supervisorManagerAuthReady', true);
    observation = { ...observation, activity: 'completed', reason: 'turn-completed', safeToAct: false };
    const entered = createDeferred(),
      release = createDeferred();
    let current = true;
    vi.spyOn(managerSession, 'prepareSupervisorManager').mockImplementation(async (options) => {
      expect(options.isCurrent()).toBe(true);
      entered.resolve();
      await release.promise;
      return true;
    });
    const work = internals.prepareSupervisorManager(managerSession, () => current);
    try {
      await entered.promise;
      current = false;
      release.resolve();
      expect(await work).toBe(false);
    } finally {
      release.resolve();
      await work;
    }
  });

  it('does not convert on an anonymous server or adopt an unscoped running CLI at Start', async () => {
    await manager.pause();
    const priorMode = process.env.CODEMAN_MULTIUSER,
      priorPassword = process.env.CODEMAN_PASSWORD;
    const prepare = vi.spyOn(managerSession, 'prepareSupervisorManager');
    try {
      process.env.CODEMAN_MULTIUSER = '0';
      delete process.env.CODEMAN_PASSWORD;
      expect(await internals.prepareSupervisorManager(managerSession, () => true)).toBe(false);
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      if (priorMode === undefined) delete process.env.CODEMAN_MULTIUSER;
      else process.env.CODEMAN_MULTIUSER = priorMode;
      if (priorPassword === undefined) delete process.env.CODEMAN_PASSWORD;
      else process.env.CODEMAN_PASSWORD = priorPassword;
    }
    vi.mocked(managerSession.isSupervisorManagerLaunchCurrent).mockReturnValue(false);
    await expect(manager.start()).rejects.toThrow(/restricted manager/);
    expect(effects).not.toHaveBeenCalled();
  });

  const unfinished = {
    outcome: 'unfinished',
    checkpoint: 'Verified worker evidence',
    nextAction: 'Assign the authorized repair',
  };

  it.each([
    'allowed',
    'pause',
    'io-pause',
    'manager-session',
    'manager-controller',
    'manager-owner',
    'manager-config',
  ] as const)('binds actual manager startup configuration to current authority (%s)', async (outcome) => {
    await managerTask.progress({
      outcome: 'unfinished',
      checkpoint: 'Retain original manager checkpoint',
      nextAction: 'Owner review next',
    });
    await manager.pause();
    await managerTask.drain();
    await manager.configure({ ...config, objective: 'A replacement manager objective' });
    await managerTask.drain();
    observation = { ...observation, activity: 'idle', reason: 'observing', processReady: true, at: Date.now() };
    const before = managerTask.getStatus();
    const priorHistoryLength = manager.getStatus().history.length;
    const bytes = await fs.readFile(Reflect.get(internals.taskStore, 'path') as string, 'utf8');
    const entered = createDeferred();
    const release = createDeferred();
    const taskDeps = Reflect.get(managerTask, 'deps') as TaskDependencies;
    const persist = taskDeps.persist.bind(taskDeps);
    const ioError = new Error('Task configuration authority was cancelled');
    vi.spyOn(taskDeps, 'persist').mockImplementationOnce(async (state, authority) => {
      entered.resolve();
      await release.promise;
      if (outcome === 'io-pause') throw ioError;
      await persist(state, authority);
    });
    const starting = manager.start();
    const result = starting.then(
      (state) => state,
      (error: unknown) => error
    );
    let pausing: Promise<unknown> | undefined;
    try {
      await entered.promise;
      // Configuration is still the owner's original state during preparation.
      expect(managerTask.getStatus()).toEqual(before);
      expect(await fs.readFile(Reflect.get(internals.taskStore, 'path') as string, 'utf8')).toBe(bytes);
      if (outcome === 'pause' || outcome === 'io-pause') pausing = manager.pause();
      if (outcome === 'manager-session') internals.sessions.set(MANAGER, await fakeSession(MANAGER, MANAGER_THREAD));
      if (outcome === 'manager-controller')
        internals.taskControllers.set(MANAGER, new TaskController(taskDeps, before));
      if (outcome === 'manager-owner') managerSession.owner = 'replacement-owner';
      if (outcome === 'manager-config')
        Reflect.set(managerSession, '_codexConfig', { ...managerSession.codexConfig, model: 'replacement-model' });
      release.resolve();
      const finished = await result;
      await pausing;
      await managerTask.drain();
      if (outcome === 'allowed') {
        expect(finished).toMatchObject({ phase: 'active', reason: 'owner-started' });
        expect(taskAct).toHaveBeenCalledOnce();
        expect(managerTask.getStatus()).toMatchObject({
          checkpoint: '',
          phase: 'watching',
          config: { enabled: true },
        });
        expect(managerTask.getStatus().objective).toContain('A replacement manager objective');
      } else {
        expect(finished).toBeInstanceOf(Error);
        expect(taskAct).not.toHaveBeenCalled();
        expect(managerTask.getStatus()).toMatchObject({
          objective: before.objective,
          criteria: before.criteria,
          checkpoint: before.checkpoint,
          nextAction: before.nextAction,
        });
        const history = manager.getStatus().history.slice(priorHistoryLength);
        if (outcome !== 'io-pause') {
          expect(history.some((entry) => entry.reason === 'manager-start-refused')).toBe(true);
          expect(history.some((entry) => entry.reason === 'manager-start-uncertain')).toBe(false);
        } else {
          expect(finished).toBe(ioError);
          expect(history.some((entry) => entry.reason === 'manager-start-uncertain')).toBe(true);
          await expect(manager.start()).rejects.toThrow(/uncertain/);
          expect(taskAct).not.toHaveBeenCalled();
        }
      }
      const currentTask = internals.taskControllers.get(MANAGER)!;
      await currentTask.drain();
      expect(internals.taskStore.get(MANAGER)).toEqual(currentTask.getStatus());
      expect(new TaskStore(Reflect.get(internals.taskStore, 'path') as string).get(MANAGER)).toEqual(
        currentTask.getStatus()
      );
      if (outcome === 'manager-controller') expect(managerTask.getStatus()).toEqual(before);
    } finally {
      release.resolve();
      await result;
      await pausing;
      if (outcome === 'manager-controller') managerTask.stop();
    }
  });

  it.each(
    (['assign', 'retry'] as const).flatMap((action) =>
      [false, true].flatMap((busy) =>
        ['spawn-begin', 'running', 'completed', 'shutdown', 'missing-fields'].map((child) => ({ action, busy, child }))
      )
    )
  )(
    'uses actual manager child classification before $action (busy=$busy, child=$child)',
    async ({ action, busy, child }) => {
      const childId = '66666666-6666-4666-8666-666666666666';
      const payload =
        child === 'spawn-begin'
          ? {
              type: 'collab_agent_spawn_begin',
              call_id: 'actual-manager-child',
              sender_thread_id: MANAGER_THREAD,
              started_at_ms: Date.now(),
            }
          : {
              type: 'collab_agent_spawn_end',
              call_id: 'actual-manager-child',
              new_thread_id: childId,
              ...(child === 'missing-fields' ? {} : { sender_thread_id: MANAGER_THREAD, completed_at_ms: Date.now() }),
              status: child === 'completed' ? { completed: null } : child === 'shutdown' ? { shutdown: null } : child,
            };
      await appendFile(
        rolloutPath,
        JSON.stringify({ timestamp: new Date(Date.now()).toISOString(), type: 'event_msg', payload }) + '\n'
      );
      const observe = vi.mocked(CodexRecoveryAdapter.prototype.observe).getMockImplementation()!;
      vi.mocked(CodexRecoveryAdapter.prototype.observe).mockImplementation(async function () {
        const native = await observe.call(this);
        const session = Reflect.get(this, 'session') as Session;
        if (session.id !== MANAGER) return native;
        // Keep the fixture's actual file witness; classify its current complete
        // tail instead of injecting the desired child activity into the observation.
        const screen = '›\n  fixture-model default · /fixture/workspace\n';
        const classified = classifyCodexTail(readFileSync(rolloutPath, 'utf8'), {
          conversationId: native.conversationId!,
          now: Date.now(),
          screen,
          busy,
          watching: false,
          tailTruncated: false,
        });
        expect(classified.activity === 'unknown').toBe(child === 'missing-fields');
        return {
          ...classified,
          processReady:
            hasEmptyCodexComposer(screen) && !['blocked', 'paused', 'unknown'].includes(classified.activity),
          processReadyAt: Date.now(),
        };
      });
      const before = managerTask.getStatus();
      const allowed = child === 'completed' || child === 'shutdown';
      const operating = manager[action](WORKER, 'actual-manager-child-status');
      if (allowed) {
        await expect(operating).resolves.toMatchObject({ workers: [expect.objectContaining({ assignments: 1 })] });
        expect(effects).toHaveBeenCalledOnce();
      } else {
        await expect(operating).rejects.toThrow(/owner Start/);
        expect(effects).not.toHaveBeenCalled();
        expect(manager.getStatus().inFlight).toBeUndefined();
        expect(manager.getStatus().workers[0].assignments).toBe(0);
      }
      expectManagerEvidenceUnchanged(managerTask.getStatus(), before, !allowed);
      expectManagerEvidenceUnchanged(internals.taskStore.get(MANAGER), before, !allowed);
    }
  );
  it.each(
    (['assign', 'retry'] as const).flatMap((action) =>
      [
        { kind: 'blocked', progress: { outcome: 'blocked' } },
        { kind: 'unknown', progress: { outcome: 'unknown' } },
        { kind: 'completed', progress: { outcome: 'completed' } },
        { kind: 'malformed', progress: '{broken' },
        { kind: 'oversized', progress: 'x'.repeat(16_001) },
        { kind: 'truncated-frame', progress: null },
        { kind: 'unconfirmed-frame', progress: unfinished },
        { kind: 'invalid-timestamp', progress: unfinished },
        { kind: 'incomplete', progress: { outcome: 'unfinished', checkpoint: 'No actionable next step' } },
        { kind: 'foreign-objective', progress: { ...unfinished, objective: 'Work on a different objective' } },
        { kind: 'manual-claim', progress: { ...unfinished, verifiedCriteria: ['owner-supervisor-acceptance'] } },
      ].map((report) => ({ action, ...report }))
    )
  )(
    'refuses $action with an already present fresh $kind manager report before the Task poll',
    async ({ action, kind, progress }) => {
      const before = managerTask.getStatus();
      if (kind === 'truncated-frame') {
        await appendFile(
          rolloutPath,
          '{"type":"event_msg","payload":{"type":"agent_message","message":"CODEMAN_TASK_PROGRESS {'
        );
      } else if (kind === 'unconfirmed-frame' || kind === 'invalid-timestamp') {
        await appendFile(
          rolloutPath,
          JSON.stringify({
            timestamp: kind === 'invalid-timestamp' ? 'bad' : new Date(Date.now()).toISOString(),
            type: 'event_msg',
            payload: { type: 'agent_message', message: 'CODEMAN_TASK_PROGRESS ' + JSON.stringify(progress) },
          }) + (kind === 'unconfirmed-frame' ? '' : '\n')
        );
      } else await appendProgress(progress);
      await expect(manager[action](WORKER, 'fresh-manager-progress-veto')).rejects.toThrow(/owner Start/);
      expectManagerEvidenceUnchanged(managerTask.getStatus(), before, true);
      expectManagerEvidenceUnchanged(internals.taskStore.get(MANAGER), before, true);
      expect(internals.taskStore.get(MANAGER).criteria[0].verified).toBe(false);
      expect(manager.getStatus()).toMatchObject({
        phase: 'paused',
        workers: [expect.objectContaining({ assignments: 0 })],
      });
      expect(effects).not.toHaveBeenCalled();
      expect(taskAct).not.toHaveBeenCalled();
      expect(recoveryAct).not.toHaveBeenCalled();
    }
  );

  it.each((['assign', 'retry'] as const).flatMap((action) => ['none', 'unfinished'].map((kind) => ({ action, kind }))))(
    'accepts $action with $kind progress without changing manager Task progress or criteria',
    async ({ action, kind }) => {
      if (kind === 'unfinished') await appendProgress(unfinished);
      const before = managerTask.getStatus();
      await manager[action](WORKER, 'healthy-manager-progress');
      expect(managerTask.getStatus()).toEqual(before);
      expect(internals.taskStore.get(MANAGER)).toEqual(before);
      expect(manager.getStatus().workers[0].assignments).toBe(1);
      expect(effects).toHaveBeenCalledOnce();
    }
  );

  it.each(
    (['assign', 'retry'] as const).flatMap((action) =>
      [
        { kind: 'blocked', progress: { outcome: 'blocked' }, allowed: false },
        { kind: 'unknown', progress: { outcome: 'unknown' }, allowed: false },
        { kind: 'completed', progress: { outcome: 'completed' }, allowed: false },
        { kind: 'malformed', progress: '{broken', allowed: false },
        {
          kind: 'same-time unfinished',
          progress: { ...unfinished, checkpoint: 'New valid checkpoint' },
          allowed: true,
        },
        { kind: 'stale unfinished', progress: { ...unfinished, checkpoint: 'Older valid checkpoint' }, allowed: true },
      ].map((report) => ({ action, ...report }))
    )
  )(
    'checks a different-key $kind report after a genuine manager Task poll before $action',
    async ({ action, kind, progress, allowed }) => {
      const deps = Reflect.get(managerTask, 'deps') as TaskDependencies;
      const observe = deps.observe;
      deps.observe = async () => ({
        ...(await observe()),
        marker: latestProgressMarker(readFileSync(rolloutPath, 'utf8'), 0, Date.now()),
      });
      await appendProgress(unfinished);
      await managerTask.refresh();
      const cached = managerTask.getStatus();
      expect(cached).toMatchObject({ phase: 'watching', outcome: 'unfinished', lastProgressAt: Date.now() });
      await appendProgress(progress, Date.now() - (kind === 'stale unfinished' ? 1 : 0));
      const operating = manager[action](WORKER, 'same-time-manager-report');
      if (allowed) {
        await expect(operating).resolves.toMatchObject({ workers: [expect.objectContaining({ assignments: 1 })] });
        expect(effects).toHaveBeenCalledOnce();
      } else {
        await expect(operating).rejects.toThrow(/owner Start/);
        expect(effects).not.toHaveBeenCalled();
      }
      // Attention pauses polling without advancing progress or certifying acceptance.
      expectManagerEvidenceUnchanged(managerTask.getStatus(), cached, !allowed);
      expectManagerEvidenceUnchanged(internals.taskStore.get(MANAGER), cached, !allowed);
      expect(cached.criteria[0].verified).toBe(false);
    }
  );

  it('refuses a progress report under a different submission before the manager Task poll', async () => {
    await appendFile(
      rolloutPath,
      JSON.stringify({
        timestamp: new Date(Date.now()).toISOString(),
        type: 'event_msg',
        payload: { type: 'user_message', message: 'A different owner objective' },
      }) + '\n'
    );
    await appendProgress(unfinished);
    await expect(manager.assign(WORKER, 'foreign-manager-submission')).rejects.toThrow(/owner Start/);
    expect(effects).not.toHaveBeenCalled();
  });

  it('keeps a report veto latched until Supervisor Start even after a healthy report replaces it', async () => {
    await appendProgress({ outcome: 'blocked' });
    await expect(manager.assign(WORKER, 'blocked-report')).rejects.toThrow(/owner Start/);
    await appendProgress(unfinished);
    await expect(manager.assign(WORKER, 'report-without-owner-start')).rejects.toThrow(/not active/);
    expect(effects).not.toHaveBeenCalled();
    await manager.start();
    await manager.assign(WORKER, 'report-after-owner-start');
    expect(effects).toHaveBeenCalledOnce();
    expect(managerTask.getStatus().criteria[0].verified).toBe(false);
  });

  async function veto(kind: string): Promise<void> {
    if (kind === 'owner-input') {
      managerSession.emit('recoveryUserInput');
      await managerTask.drain();
    } else if (kind === 'resumed-task') {
      managerSession.emit('recoveryUserInput');
      await managerTask.drain();
      await managerTask.resume();
      expect(managerTask.getStatus().phase).toBe('watching');
    } else if (kind === 'raw-uuid') managerSession.pinRecoveryConversation(OTHER_THREAD);
    else if (kind === 'raw-env')
      vi.spyOn(managerSession, 'getEnvOverridesForPersist').mockReturnValue({ CODEX_MODEL: 'changed-model' });
    else if (kind === 'raw-home' || kind === 'raw-generation') {
      const context = managerSession.getRecoveryContext();
      vi.spyOn(managerSession, 'getRecoveryContext').mockReturnValue({
        ...context,
        ...(kind === 'raw-home' ? { codexHome: '/fixture/different-home' } : { generation: context.generation + 1 }),
      });
    } else if (kind === 'controller-replaced') {
      const replacement = new TaskController(
        Reflect.get(managerTask, 'deps') as TaskDependencies,
        managerTask.getStatus()
      );
      managerTask.stop();
      internals.taskControllers.set(MANAGER, replacement);
    } else if (kind === 'durable-paused') {
      await internals.taskStore.save(MANAGER, { ...managerTask.getStatus(), phase: 'paused', reason: 'user-input' });
    } else if (kind === 'durable-malformed') {
      const get = internals.taskStore.get.bind(internals.taskStore);
      vi.spyOn(internals.taskStore, 'get').mockImplementation((id) =>
        id === MANAGER ? { ...get(id), continuations: -1 } : get(id)
      );
    } else if (kind === 'live-malformed') {
      Reflect.set(managerTask, 'state', { ...managerTask.getStatus(), continuations: -1 });
    } else if (kind === 'unreadable-journal') {
      const path = dataPath('unreadable-manager-task.json');
      await writeFile(path, '{broken');
      internals.taskStore = new TaskStore(path);
    } else if (kind === 'runtime') {
      const state = managerTask.getStatus();
      state.startedAt = Date.now() - state.config.maxRuntimeMs;
      Reflect.set(managerTask, 'state', state);
    } else if (kind === 'continuation-budget') {
      const state = managerTask.getStatus();
      state.continuations = state.config.maxContinuations;
      Reflect.set(managerTask, 'state', state);
    } else if (kind === 'manual-completion') {
      await managerTask.progress({ outcome: 'completed', verifiedCriteria: ['owner-supervisor-acceptance'] });
    } else if (kind === 'stale-native') {
      observation.processReadyAt = Date.now() - 31_000;
    } else if (kind === 'unreadable-native') {
      vi.spyOn(CodexRecoveryAdapter.prototype, 'observe').mockRejectedValueOnce(
        new Error('Fixture unreadable manager rollout')
      );
    } else {
      observation = {
        ...observation,
        ...(kind === 'observed-uuid' ? { conversationId: OTHER_THREAD } : {}),
        activity: kind === 'pending-child' ? 'watching' : kind === 'observed-uuid' ? 'working' : 'blocked',
        reason:
          kind === 'authentication'
            ? 'authentication-required'
            : kind === 'approval'
              ? 'approval-required'
              : kind === 'usage'
                ? 'usage-limit'
                : 'turn-running',
      };
      if (kind === 'observed-uuid') await managerTask.refresh();
    }
  }

  it.each(['assign', 'retry'] as const)(
    'accepts healthy manager %s once and returns read-only receipts after owner input',
    async (action) => {
      await manager[action](WORKER, 'healthy-operation');
      expect(manager.getStatus().workers[0].assignments).toBe(1);
      expect(taskAct).toHaveBeenCalledTimes(action === 'assign' ? 1 : 0);
      expect(recoveryAct).toHaveBeenCalledTimes(action === 'retry' ? 1 : 0);
      await veto('owner-input');
      await expect(manager[action](WORKER, 'new-operation-after-input')).rejects.toThrow(/owner Start/);
      expect(manager.getStatus().phase).toBe('paused');
      const bytes = manager.getStatus();
      const persist = vi.spyOn(managerDeps, 'persist');
      await manager[action](WORKER, 'healthy-operation');
      expect(manager.getStatus()).toEqual(bytes);
      expect(persist).not.toHaveBeenCalled();
      expect(taskAct).toHaveBeenCalledTimes(action === 'assign' ? 1 : 0);
      expect(recoveryAct).toHaveBeenCalledTimes(action === 'retry' ? 1 : 0);
    }
  );

  it('does not reserve the actual server assignment when current private metadata makes the worker prompt too large', async () => {
    grantDirectory = await mkdtemp(join(homedir(), 'supervisor-envelope-'));
    for (let index = 0; index < 40; index++) {
      const path = join(grantDirectory, `${'directory-'.repeat(24)}${index}`);
      await fs.mkdir(path);
      const stat = lstatSync(path);
      workerPaths.push({ path, kind: 'directory', dev: stat.dev, ino: stat.ino });
    }
    const largeWorker = {
      ...config.workers[0],
      task: 'o'.repeat(4000),
      criteria: Array.from({ length: 28 }, (_, index) => ({
        id: `c${index}`,
        description: 'd'.repeat(1000),
        kind: 'command' as const,
        command: 'c'.repeat(1000),
      })),
    };
    expect(
      taskPromptFits({
        objective: largeWorker.task,
        criteria: largeWorker.criteria.map((criterion) => ({ ...criterion, verified: false })),
        checkpoint: '',
        nextAction: '',
      })
    ).toBe(true);
    await manager.configure({ ...config, workers: [largeWorker] });
    await manager.start();
    taskAct.mockClear();
    effects.mockClear();
    const before = manager.getStatus();
    const workerTask = internals.getTaskController(internals.sessions.get(WORKER)!)!;
    const taskBefore = workerTask.getStatus();
    await expect(manager.assign(WORKER, 'oversized-private-envelope')).rejects.toThrow(/envelope/);
    expect(manager.getStatus()).toEqual(before);
    expect(internals.supervisorStore.get(MANAGER)).toEqual(before);
    expect(workerTask.getStatus()).toEqual(taskBefore);
    expect(taskAct).not.toHaveBeenCalled();
    expect(effects).not.toHaveBeenCalled();
  });

  it.each(
    (['assign', 'retry'] as const).flatMap((action) =>
      [
        'owner-input',
        'resumed-task',
        'raw-uuid',
        'raw-home',
        'raw-generation',
        'raw-env',
        'observed-uuid',
        'authentication',
        'approval',
        'usage',
        'pending-child',
        'durable-paused',
        'durable-malformed',
        'live-malformed',
        'stale-native',
        'unreadable-native',
        'unreadable-journal',
        'controller-replaced',
        'runtime',
        'continuation-budget',
        'manual-completion',
      ].map((kind) => ({ action, kind }))
    )
  )('refuses $action with manager $kind before touching the worker', async ({ action, kind }) => {
    await veto(kind);
    await expect(manager[action](WORKER, 'vetoed-operation')).rejects.toThrow(
      kind === 'live-malformed' || kind === 'unreadable-journal'
        ? /Task state could not be saved/
        : /owner Start|cancelled/
    );
    expect(taskAct).not.toHaveBeenCalled();
    expect(recoveryAct).not.toHaveBeenCalled();
    expect(manager.getStatus()).toMatchObject({
      phase: 'paused',
      workers: [expect.objectContaining({ assignments: 0 })],
    });
    expect(manager.getStatus().inFlight).toBeUndefined();
    expect(manager.getStatus().handledRequestIds).toEqual([]);
    expect(internals.getTaskController(internals.sessions.get(WORKER)!)!.getStatus().objective).toBe('');
  });

  it.each(
    (['assign', 'retry'] as const).flatMap((action) =>
      ['reservation', 'worker-await', 'adapter-await'].flatMap((boundary) =>
        [
          'owner-input',
          'native-auth',
          'native-child',
          'progress-blocked',
          'progress-malformed',
          'manager-dead',
          'manager-clean',
          'manager-signal',
          'manager-native-expired',
          'healthy-native-age',
          'manager-native-expired-during-proof',
          'healthy-native-proof-age',
        ]
          // Reservation release obtains a new manager read; the later worker awaits do not.
          .filter(
            (kind) =>
              !['manager-native-expired', 'manager-native-expired-during-proof', 'healthy-native-proof-age'].includes(
                kind
              ) || boundary !== 'reservation'
          )
          .map((kind) => ({ action, boundary, kind }))
      )
    )
  )(
    'rechecks manager $kind after $action $boundary and clears only certified unsent reservations',
    async ({ action, boundary, kind }) => {
      const reached = createDeferred();
      const release = createDeferred();
      if (boundary === 'reservation') {
        const persist = managerDeps.persist;
        managerDeps.persist = async (state) => {
          if (state.reason === `${action}-reserved`) {
            reached.resolve();
            await release.promise;
          }
          await persist(state);
        };
      } else if (boundary === 'adapter-await') {
        const finalDispatch = async (current: RecoveryActionAuthority) => {
          expect(current()).toBe(true);
          reached.resolve();
          await release.promise;
          if (
            !(await prepared(
              current,
              privateEvidenceSource(internals.sessions.get(WORKER)!, workerRolloutPath, WORKER_THREAD)
            ))
          )
            return 'not-sent' as const;
          effects();
          return 'sent' as const;
        };
        if (action === 'assign')
          taskAct.mockImplementation(async (_key, _thread, _prompt, current) => finalDispatch(current));
        else recoveryAct.mockImplementation(async (_flight, current) => finalDispatch(current));
      } else if (action === 'assign') {
        const task = internals.getTaskController(internals.sessions.get(WORKER)!)!;
        const deps = Reflect.get(task, 'deps') as TaskDependencies;
        const observe = deps.observe;
        deps.observe = async () => {
          reached.resolve();
          await release.promise;
          return observe();
        };
      } else {
        const recovery = internals.getRecoveryController(internals.sessions.get(WORKER)!)!;
        const deps = Reflect.get(recovery, 'deps') as RecoveryDependencies;
        const observe = deps.observe;
        let reads = 0;
        deps.observe = async () => {
          if (++reads > 1) {
            reached.resolve();
            await release.promise;
          }
          return observe();
        };
      }
      const operating = manager[action](WORKER, 'late-input-operation');
      await reached.promise;
      if (kind === 'owner-input') await veto(kind);
      else if (kind === 'manager-dead' || kind === 'manager-clean' || kind === 'manager-signal')
        managerSession.setPaneExit({
          at: Date.now(),
          ...(kind === 'manager-signal' ? { signal: 9 } : { status: kind === 'manager-clean' ? 0 : 1 }),
        });
      else if (kind === 'manager-native-expired' || kind === 'healthy-native-age')
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + (kind === 'manager-native-expired' ? 30_001 : 29_999));
      else if (kind === 'manager-native-expired-during-proof' || kind === 'healthy-native-proof-age') {
        const confirm = CodexRecoveryAdapter.prototype.confirmLocalEvidence;
        vi.spyOn(CodexRecoveryAdapter.prototype, 'confirmLocalEvidence').mockImplementationOnce(function (
          this: CodexRecoveryAdapter,
          conversationId: string,
          generation: number,
          source?: RecoveryEvidenceSource
        ) {
          const verified = confirm.call(this, conversationId, generation, source);
          vi.spyOn(Date, 'now').mockReturnValue(
            Date.now() + (kind === 'manager-native-expired-during-proof' ? 30_001 : 29_999)
          );
          return verified;
        });
      } else if (kind.startsWith('progress-'))
        await appendProgress(kind === 'progress-blocked' ? { outcome: 'blocked' } : '{broken');
      else {
        await appendFile(
          rolloutPath,
          JSON.stringify({
            type: 'event_msg',
            payload:
              kind === 'native-auth'
                ? { type: 'error', message: 'Authentication required' }
                : { type: 'collab_agent_spawn_begin', call_id: 'pending-child' },
          }) + '\n'
        );
        if (boundary === 'reservation') {
          observation = {
            ...observation,
            activity: kind === 'native-child' ? 'watching' : 'blocked',
            reason: kind === 'native-child' ? 'background-work' : 'authentication-required',
          };
        }
      }
      release.resolve();
      if (kind === 'healthy-native-age' || kind === 'healthy-native-proof-age') {
        await expect(operating).resolves.toMatchObject({ workers: [expect.objectContaining({ assignments: 1 })] });
        expect(effects).toHaveBeenCalledOnce();
        expect(manager.getStatus().inFlight).toBeUndefined();
        return;
      }
      await expect(operating).rejects.toThrow(/owner Start|cancelled|refused/);
      const enteredFinalPreparation =
        boundary === 'adapter-await' ||
        (boundary === 'worker-await' &&
          [
            'native-auth',
            'native-child',
            'progress-blocked',
            'progress-malformed',
            'manager-native-expired-during-proof',
          ].includes(kind));
      expect(taskAct).toHaveBeenCalledTimes(enteredFinalPreparation && action === 'assign' ? 1 : 0);
      expect(recoveryAct).toHaveBeenCalledTimes(enteredFinalPreparation && action === 'retry' ? 1 : 0);
      expect(effects).not.toHaveBeenCalled();
      expect(manager.getStatus().inFlight).toBeUndefined();
      expect(manager.getStatus().workers[0].assignments).toBe(0);
    }
  );

  it.each(
    (['assign', 'retry'] as const).flatMap((action) =>
      ['worker-await', 'adapter-await'].flatMap((boundary) =>
        [
          'healthy-safe',
          'healthy-privileged',
          'healthy-custom-home',
          'bypass-revoked',
          'home-revoked',
          'disabled',
          'unreadable',
          'mode-changed',
          'config-changed',
          'home-changed',
          'cache-revoked',
          'revoked-during-proof',
        ].map((kind) => ({ action, boundary, kind }))
      )
    )
  )('retains current manager grants through $action $boundary: $kind', async ({ action, boundary, kind }) => {
    grantDirectory = await mkdtemp(join(homedir(), 'supervisor-manager-grant-'));
    process.env.CODEMAN_DATA_DIR = grantDirectory;
    process.env.CODEMAN_MULTIUSER = '1';
    invalidateUsersCache();
    const account = (patch: Record<string, unknown> = {}) => ({
      username: 'alice',
      role: 'user',
      canBypassPermissions: kind !== 'healthy-safe',
      ...patch,
    });
    const replace = async (patch: Record<string, unknown> = {}) => {
      const path = dataPath('users.json');
      await writeFile(path + '.fixture', JSON.stringify({ version: 1, users: [account(patch)] }));
      await rename(path + '.fixture', path);
    };
    await replace();
    const safeConfig = { dangerouslyBypassApprovals: false, sandbox: 'read-only', approvalPolicy: 'on-request' };
    const workerSession = internals.sessions.get(WORKER)!;
    Reflect.set(workerSession, '_codexConfig', { ...workerSession.codexConfig, ...safeConfig });
    if (kind === 'healthy-safe' && action === 'assign') {
      // This table isolates the manager grant. Its worker delivery was already
      // mocked; the synthetic distinct worker home has no unprivileged env grant.
      // Keep manager admission real; actual worker admission/grants are covered separately.
      const admit = CodexTaskAdapter.prototype.admitPrompt;
      vi.spyOn(CodexTaskAdapter.prototype, 'admitPrompt').mockImplementation(function (...args) {
        return Reflect.get(this, 'session').id === WORKER ? Promise.resolve(true) : admit.apply(this, args);
      });
    }
    if (kind === 'healthy-safe')
      Reflect.set(managerSession, '_codexConfig', { ...managerSession.codexConfig, ...safeConfig });
    if (['healthy-privileged', 'bypass-revoked'].includes(kind))
      Reflect.set(managerSession, '_codexConfig', {
        ...managerSession.codexConfig,
        dangerouslyBypassApprovals: true,
        sandbox: 'danger-full-access',
        approvalPolicy: 'never',
      });
    if (['healthy-custom-home', 'home-revoked'].includes(kind)) {
      Reflect.get(managerSession, '_muxSession').recoveryCodexHome = join(grantDirectory, 'owned-home');
      await fs.mkdir(join(grantDirectory, 'owned-home'));
    }
    await manager.pause();
    await manager.start();
    taskAct.mockClear();
    recoveryAct.mockClear();
    effects.mockClear();
    const reached = createDeferred();
    const release = createDeferred();
    if (boundary === 'adapter-await') {
      const finalDispatch = async (current: RecoveryActionAuthority) => {
        expect(current()).toBe(true);
        reached.resolve();
        await release.promise;
        if (
          !(await prepared(
            current,
            privateEvidenceSource(internals.sessions.get(WORKER)!, workerRolloutPath, WORKER_THREAD)
          ))
        )
          return 'not-sent' as const;
        effects();
        return 'sent' as const;
      };
      if (action === 'assign')
        taskAct.mockImplementation(async (_key, _thread, _prompt, current) => finalDispatch(current));
      else recoveryAct.mockImplementation(async (_flight, current) => finalDispatch(current));
    } else if (action === 'assign') {
      const task = internals.getTaskController(internals.sessions.get(WORKER)!)!;
      const deps = Reflect.get(task, 'deps') as TaskDependencies;
      const observe = deps.observe;
      deps.observe = async () => {
        reached.resolve();
        await release.promise;
        return observe();
      };
    } else {
      const recovery = internals.getRecoveryController(internals.sessions.get(WORKER)!)!;
      const deps = Reflect.get(recovery, 'deps') as RecoveryDependencies;
      const observe = deps.observe;
      let reads = 0;
      deps.observe = async () => {
        if (++reads > 1) {
          reached.resolve();
          await release.promise;
        }
        return observe();
      };
    }
    const operating = manager[action](WORKER, 'current-manager-grant');
    await Promise.race([
      reached.promise,
      operating.then(() => {
        throw new Error('Fixture dispatch completed before its held boundary');
      }),
    ]);
    if (['bypass-revoked', 'home-revoked'].includes(kind)) {
      await replace({ canBypassPermissions: false });
      // The same owner's safe worker remains eligible; only the manager grant changed.
      const workerGrant = await clampRecoveryLaunchForOwner(
        'alice',
        { codexConfig: workerSession.codexConfig },
        undefined
      );
      expect(workerGrant.isCurrent()).toBe(true);
      expect(workerGrant.configs.codexConfig).toEqual(workerSession.codexConfig);
    }
    if (kind === 'disabled') await replace({ disabled: true });
    if (kind === 'unreadable') await writeFile(dataPath('users.json'), '{malformed-fixture}');
    if (kind === 'mode-changed') process.env.CODEMAN_MULTIUSER = '0';
    if (kind === 'config-changed')
      Reflect.set(managerSession, '_codexConfig', { ...managerSession.codexConfig, model: 'changed-model' });
    if (kind === 'home-changed')
      Reflect.get(managerSession, '_muxSession').recoveryCodexHome = join(grantDirectory, 'changed-home');
    if (kind === 'cache-revoked') (await findUser('alice'))!.canBypassPermissions = false;
    if (kind === 'revoked-during-proof') {
      const confirm = CodexRecoveryAdapter.prototype.confirmLocalEvidence;
      vi.spyOn(CodexRecoveryAdapter.prototype, 'confirmLocalEvidence').mockImplementationOnce(function (
        this: CodexRecoveryAdapter,
        conversationId: string,
        generation: number,
        source?: RecoveryEvidenceSource
      ) {
        const verified = confirm.call(this, conversationId, generation, source);
        // No asynchronous gap: the durable grant version changes during the final proof.
        const path = dataPath('users.json');
        writeFileSync(
          path + '.fixture',
          JSON.stringify({ version: 1, users: [account({ canBypassPermissions: false })] })
        );
        renameSync(path + '.fixture', path);
        return verified;
      });
    }
    release.resolve();
    if (kind.startsWith('healthy-')) {
      await expect(operating).resolves.toMatchObject({ workers: [expect.objectContaining({ assignments: 1 })] });
      expect(effects).toHaveBeenCalledOnce();
    } else {
      await expect(operating).rejects.toThrow(/owner Start|cancelled|refused/);
      expect(effects).not.toHaveBeenCalled();
      expect(manager.getStatus().workers[0].assignments).toBe(0);
    }
    expect(managerTask.getStatus().criteria[0].verified).toBe(false);
    expect(manager.getStatus().inFlight).toBeUndefined();
  });

  it('requires explicit Supervisor Start to renew a grant after a separate manager Task resume', async () => {
    await veto('resumed-task');
    await expect(manager.assign(WORKER, 'old-manager-grant')).rejects.toThrow(/owner Start/);
    expect(taskAct).not.toHaveBeenCalled();
    await manager.start();
    await manager.assign(WORKER, 'renewed-manager-grant');
    expect(manager.getStatus().workers[0].assignments).toBe(1);
    expect(taskAct).toHaveBeenCalledOnce();
    expect(internals.getTaskController(internals.sessions.get(WORKER)!)!.getStatus().criteria[0].verified).toBe(false);
  });

  it.each(
    (['pane', 'worker-proof', 'combined-read'] as const).flatMap((boundary) =>
      (
        [
          'healthy',
          'private-file',
          'owner-input',
          'owner-changed',
          'manager-replaced',
          'worker-replaced',
          'grant-revoked',
        ] as const
      ).map((change) => ({ boundary, change }))
    )
  )(
    'rechecks the actual manager authority after the worker Session final $boundary await: $change',
    async ({ boundary, change }) => {
      const worker = internals.sessions.get(WORKER)!;
      const originalWorkerTask = internals.getTaskController(worker)!;
      if (change === 'grant-revoked') {
        grantDirectory = await mkdtemp(join(homedir(), 'supervisor-final-grant-'));
        process.env.CODEMAN_DATA_DIR = grantDirectory;
        process.env.CODEMAN_MULTIUSER = '1';
        invalidateUsersCache();
        await writeFile(
          dataPath('users.json'),
          JSON.stringify({ version: 1, users: [{ username: 'alice', role: 'user', canBypassPermissions: true }] })
        );
      }
      const reached = createDeferred();
      const release = createDeferred();
      let proofHeld = false;
      let workerActionEntered = false;
      const confirm = CodexRecoveryAdapter.prototype.confirmLocalEvidence;
      vi.spyOn(CodexRecoveryAdapter.prototype, 'confirmLocalEvidence').mockImplementation(async function (
        this: CodexRecoveryAdapter,
        conversationId: string,
        generation: number,
        source?: RecoveryEvidenceSource
      ) {
        if (Reflect.get(this, 'session').id !== WORKER) {
          return confirm.call(this, conversationId, generation, source);
        }
        if (!proofHeld && boundary === 'worker-proof') {
          proofHeld = true;
          reached.resolve();
          await release.promise;
        }
        return true;
      });
      if (boundary === 'combined-read') {
        const open = fs.open.bind(fs);
        vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
          const file = await open(...args);
          if (args[0] === workerRolloutPath) {
            const read = file.read.bind(file);
            vi.spyOn(file, 'read').mockImplementation(async (...readArgs) => {
              if (!proofHeld && workerActionEntered) {
                proofHeld = true;
                reached.resolve();
                await release.promise;
              }
              return Reflect.apply(read, file, readArgs);
            });
          }
          return file;
        });
      }
      taskAct.mockRestore();
      const realAct = CodexTaskAdapter.prototype.act;
      vi.spyOn(CodexTaskAdapter.prototype, 'act').mockImplementation(async function (...args) {
        if (Reflect.get(this, 'session').id === WORKER) workerActionEntered = true;
        return realAct.apply(this, args);
      });
      Reflect.set(worker, '_mux', {
        ...Reflect.get(worker, '_mux'),
        isAvailable: () => true,
        inspectPaneForRecovery: async () => {
          if (boundary === 'pane') {
            reached.resolve();
            await release.promise;
          }
          return {
            paneId: '%7',
            panePid: 99999,
            inputProvenance: inputProofs.get(worker),
            dead: false,
            screen: '›\n  fixture-model high · /tmp\n',
          };
        },
        sendInput: async (_id: string, _input: string, guard: RecoveryMuxDispatchGuard) => {
          if (!guard.prepareEvidence || !(await guard.prepareEvidence())) return false;
          const prepared = await guard.prepareEvidence();
          if (!prepared || !guard.confirm()) {
            guard.noteRefusal?.();
            return false;
          }
          guard.noteDispatch();
          effects();
          return true;
        },
      });
      const operation = manager.assign(WORKER, `session-final-proof-${change}`);
      try {
        await Promise.race([
          reached.promise,
          operation.then(() => {
            throw new Error('Worker operation completed before its held Session boundary');
          }),
        ]);
        if (change === 'private-file') await appendProgress({ outcome: 'blocked' });
        if (change === 'owner-input') {
          managerSession.trackUserInput('New owner draft');
          await Reflect.get(managerSession, '_recoveryFencePublication');
        }
        if (change === 'owner-changed') Reflect.set(managerSession, '_owner', 'bob');
        if (change === 'manager-replaced') internals.sessions.set(MANAGER, await fakeSession(MANAGER, MANAGER_THREAD));
        if (change === 'worker-replaced') internals.sessions.set(WORKER, await fakeSession(WORKER, WORKER_THREAD));
        if (change === 'grant-revoked') {
          const path = dataPath('users.json');
          await writeFile(
            path + '.fixture',
            JSON.stringify({ version: 1, users: [{ username: 'alice', role: 'user', disabled: true }] })
          );
          await rename(path + '.fixture', path);
        }
        release.resolve();
        if (change === 'healthy') {
          await expect(operation).resolves.toMatchObject({ workers: [expect.objectContaining({ assignments: 1 })] });
          expect(effects).toHaveBeenCalledOnce();
        } else {
          await expect(operation).rejects.toThrow(/refused|cancelled|owner Start/);
          expect(effects).not.toHaveBeenCalled();
          expect(manager.getStatus().workers[0].assignments).toBe(0);
          expect(originalWorkerTask.getStatus().inFlight).toBeUndefined();
        }
        expect(manager.getStatus().inFlight).toBeUndefined();
      } finally {
        release.resolve();
        await operation.catch(() => {});
      }
    }
  );

  it('never borrows a newer manager evidence object while its previous private proof is held', async () => {
    expect(await managerDeps.validateManagerAuthority()).toBe(true);
    const confirm = CodexRecoveryAdapter.prototype.confirmLocalEvidence;
    const reached = createDeferred();
    const release = createDeferred();
    vi.spyOn(CodexRecoveryAdapter.prototype, 'confirmLocalEvidence').mockImplementationOnce(async function (
      this: CodexRecoveryAdapter,
      conversationId: string,
      generation: number,
      source?: RecoveryEvidenceSource
    ) {
      reached.resolve();
      await release.promise;
      return confirm.call(this, conversationId, generation, source);
    });
    const source = privateEvidenceSource(internals.sessions.get(WORKER)!, workerRolloutPath, WORKER_THREAD);
    const preparing = managerDeps.prepareManagerAuthority(WORKER, source);
    try {
      await reached.promise;
      expect(await managerDeps.validateManagerAuthority()).toBe(true);
      release.resolve();
      expect(await preparing).toBe(false);
      expect(managerDeps.hasManagerAuthority()).toBe(true);
      expect(await managerDeps.prepareManagerAuthority(WORKER, source)).toBe(true);
      expect(effects).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await preparing;
    }
  });

  it.each(['healthy', 'manager', 'worker'] as const)(
    'couples both private broker journals with the final manager/worker evidence (%s)',
    async (kind) => {
      expect(await managerDeps.validateManagerAuthority()).toBe(true);
      const worker = internals.sessions.get(WORKER)!;
      const source = privateEvidenceSource(worker, workerRolloutPath, WORKER_THREAD);
      if (kind !== 'healthy') {
        const proof = inputProofs.get(kind === 'manager' ? managerSession : worker)!;
        // Replace after observation without refreshing the captured witness.
        if (kind === 'manager') updateFakeInputProvenance(proof, { rawGeneration: 1 });
        else await writeFile(proof.fileWitness!.path, '{"unobservedRawInput":true}');
      }
      expect(await managerDeps.prepareManagerAuthority(WORKER, source)).toBe(kind === 'healthy');
      if (kind === 'healthy') {
        const issuer = managerDeps.getInputIssuer?.();
        expect(issuer?.sessionId).toBe(MANAGER);
        expect(issuer?.proof.incarnation).toBe(inputProofs.get(managerSession)!.incarnation);
        expect(issuer?.files?.map((file) => file.path)).toContain(inputProofs.get(managerSession)!.fileWitness!.path);
      }
      expect(effects).not.toHaveBeenCalled();
    }
  );

  it('refuses a fulfilled false private-proof Promise before worker dispatch', async () => {
    vi.spyOn(CodexRecoveryAdapter.prototype, 'confirmLocalEvidence').mockImplementationOnce(async () => false);
    await expect(manager.assign(WORKER, 'false-manager-proof')).rejects.toThrow(/owner Start/);
    expect(taskAct).not.toHaveBeenCalled();
    expect(effects).not.toHaveBeenCalled();
    expect(manager.getStatus()).toMatchObject({
      phase: 'paused',
      workers: [expect.objectContaining({ assignments: 0 })],
    });
    expect(manager.getStatus().inFlight).toBeUndefined();
  });

  it.each([
    'healthy',
    'missing',
    'wrong-session',
    'wrong-uuid',
    'stale',
    'throws',
    'async-true',
    'async-reject',
  ] as const)('binds local private evidence to the exact selected worker (%s)', async (kind) => {
    expect(await managerDeps.validateManagerAuthority()).toBe(true);
    const worker = internals.sessions.get(WORKER)!;
    const source = privateEvidenceSource(worker, workerRolloutPath, WORKER_THREAD);
    if (kind === 'wrong-session') source.sessionId = MANAGER;
    if (kind === 'wrong-uuid') source.identity.conversationId = OTHER_THREAD;
    if (kind === 'stale') {
      worker.trackUserInput('Later owner draft');
      await Reflect.get(worker, '_recoveryFencePublication');
    }
    if (kind === 'throws')
      source.isCurrent = () => {
        throw new Error('Fixture source check failed');
      };
    if (kind === 'async-true') source.isCurrent = (() => Promise.resolve(true)) as unknown as () => boolean;
    if (kind === 'async-reject')
      source.isCurrent = (() =>
        Promise.reject(new Error('Fixture async source check failed'))) as unknown as () => boolean;
    expect(await managerDeps.prepareManagerAuthority(WORKER, kind === 'missing' ? undefined : source)).toBe(
      kind === 'healthy'
    );
    expect(effects).not.toHaveBeenCalled();
  });

  it.each((['configure', 'start'] as const).flatMap((action) => [true, false].map((ready) => ({ action, ready }))))(
    'refuses a disabled restricted manager as worker at $action (ready=$ready)',
    async ({ action, ready }) => {
      await manager.pause();
      const worker = internals.sessions.get(WORKER)!;
      expect(internals.getSupervisorController(worker)!.getStatus().enabled).toBe(false);
      const profile = { isCurrent: () => ready, revoke: vi.fn(async () => {}) };
      Reflect.set(worker, '_supervisorManagerProfile', profile);
      vi.mocked(worker.isSupervisorManagerLaunchCurrent).mockReturnValue(ready);
      try {
        expect(worker.hasSupervisorManagerLaunch()).toBe(true);
        await expect(action === 'configure' ? manager.configure(config) : manager.start()).rejects.toThrow(/cycles/);
        expect(managerDeps.worker(WORKER)).toBeUndefined();
        expect(await managerDeps.prepareManagerAuthority(WORKER)).toBe(false);
        expect(taskAct).not.toHaveBeenCalled();
        expect(recoveryAct).not.toHaveBeenCalled();
        expect(effects).not.toHaveBeenCalled();
        expect(Reflect.get(worker, '_supervisorManagerProfile')).toBe(profile);
      } finally {
        Reflect.set(worker, '_supervisorManagerProfile', undefined);
      }
    }
  );

  it.each(
    (['assign', 'retry'] as const).flatMap((action) => [true, false].map((restricted) => ({ action, restricted })))
  )(
    'rechecks a disabled worker restriction at final $action dispatch (restricted=$restricted)',
    async ({ action, restricted }) => {
      const worker = internals.sessions.get(WORKER)!;
      expect(internals.getSupervisorController(worker)!.getStatus().enabled).toBe(false);
      const selected = managerDeps.worker(WORKER)!;
      const profile = { isCurrent: () => true, revoke: vi.fn(async () => {}) };
      const finalDispatch = async (current: RecoveryActionAuthority) => {
        expect(current()).toBe(true);
        if (restricted) Reflect.set(worker, '_supervisorManagerProfile', profile);
        if (!(await prepared(current, privateEvidenceSource(worker, workerRolloutPath, WORKER_THREAD))))
          return 'not-sent' as const;
        effects();
        return 'sent' as const;
      };
      if (action === 'assign')
        taskAct.mockImplementation(async (_key, _thread, _prompt, current) => finalDispatch(current));
      else recoveryAct.mockImplementation(async (_flight, current) => finalDispatch(current));
      try {
        if (restricted) {
          await expect(manager[action](WORKER, 'restricted-worker-operation')).rejects.toThrow();
          expect(selected.isCurrent?.()).toBe(false);
          expect(await managerDeps.prepareManagerAuthority(WORKER)).toBe(false);
          expect(effects).not.toHaveBeenCalled();
          expect(manager.getStatus().workers[0].assignments).toBe(0);
          expect(manager.getStatus().inFlight).toBeUndefined();
          expect(Reflect.get(worker, '_supervisorManagerProfile')).toBe(profile);
        } else {
          await expect(manager[action](WORKER, 'ordinary-worker-operation')).resolves.toMatchObject({
            workers: [expect.objectContaining({ assignments: 1 })],
          });
          expect(effects).toHaveBeenCalledOnce();
        }
      } finally {
        Reflect.set(worker, '_supervisorManagerProfile', undefined);
      }
    }
  );

  it('rejects a local worker sharing the manager history home before configuration', async () => {
    const worker = internals.sessions.get(WORKER)!;
    Reflect.get(worker, '_muxSession').recoveryCodexHome = managerSession.getRecoveryContext().codexHome;
    const before = manager.getStatus();
    await expect(manager.configure(config)).rejects.toThrow(/distinct Codex homes/);
    const paused = manager.getStatus();
    expect(paused).toEqual({
      ...before,
      phase: 'paused',
      reason: 'configuration-refused',
      history: [...before.history, { at: expect.any(Number), reason: 'configuration-refused' }].slice(-100),
    });
    expect(internals.supervisorStore.get(MANAGER)).toEqual(paused);
    expect(managerTask.getStatus()).toMatchObject({ phase: 'paused', reason: 'owner-paused' });
    expect(effects).not.toHaveBeenCalled();
  });

  it.each(['direct-alias', 'ancestor-alias', 'missing', 'independent'] as const)(
    'requires verified independent local history directories (%s)',
    async (kind) => {
      const worker = internals.sessions.get(WORKER)!;
      const home = managerSession.getRecoveryContext().codexHome!;
      const candidate = join(fixtureData, 'candidate-home');
      if (kind === 'direct-alias') await fs.symlink(home, candidate);
      if (kind === 'ancestor-alias') {
        await fs.symlink(dirname(home), candidate);
      }
      if (kind === 'independent') await fs.mkdir(candidate);
      Reflect.get(worker, '_muxSession').recoveryCodexHome =
        kind === 'ancestor-alias' ? join(candidate, home.split('/').at(-1)!) : candidate;
      if (kind === 'independent') {
        await expect(manager.configure(config)).resolves.toMatchObject({ phase: 'ready' });
      } else {
        await expect(manager.configure(config)).rejects.toThrow(/verified distinct Codex homes/);
        expect(manager.getStatus().phase).toBe('paused');
      }
      expect(effects).not.toHaveBeenCalled();
    }
  );

  it('rechecks a history alias introduced after configuration before granting an action', async () => {
    expect(await managerDeps.validateManagerAuthority()).toBe(true);
    const worker = internals.sessions.get(WORKER)!;
    const alias = join(fixtureData, 'late-history-alias');
    await fs.symlink(managerSession.getRecoveryContext().codexHome!, alias);
    Reflect.get(worker, '_muxSession').recoveryCodexHome = alias;
    await expect(manager.assign(WORKER, 'alias-worker-request')).rejects.toThrow();
    expect(taskAct).not.toHaveBeenCalled();
    expect(recoveryAct).not.toHaveBeenCalled();
    expect(effects).not.toHaveBeenCalled();
  });

  it('does not grant a worker lease when owner pause supersedes a held directory proof', async () => {
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const home = managerSession.getRecoveryContext().codexHome!;
    const realpath = fs.realpath.bind(fs);
    let held = false;
    vi.spyOn(fs, 'realpath').mockImplementation(async (path) => {
      const result = await realpath(path);
      if (path === home && !held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return result;
    });
    const replacement = manager.configure({ ...config, objective: 'Superseded owner objective' });
    const refused = expect(replacement).rejects.toThrow(/superseded/);
    await entered.promise;
    const pause = manager.pause();
    release.resolve();
    await refused;
    await pause;
    expect(manager.getStatus()).toMatchObject({ phase: 'paused', objective: config.objective });
    expect(effects).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'keeps an owned SSH history domain separate from the same local home string (%s)',
    async (owned) => {
      expect(await managerDeps.validateManagerAuthority()).toBe(true);
      const worker = internals.sessions.get(WORKER)!;
      Reflect.set(worker, '_remote', {
        hostId: 'fixture-host',
        label: 'Fixture',
        host: 'worker.invalid',
        username: 'runner',
        port: 22,
        remotePath: '/fixture/work',
        owned,
      });
      Reflect.set(worker, '_envOverrides', { CODEX_HOME: managerSession.getRecoveryContext().codexHome });
      const record = Reflect.get(worker, '_muxSession') as MuxSession;
      if (owned) {
        expect(() => managerDeps.validateWorkers([WORKER])).toThrow(/eligible/);
        expect(await managerDeps.prepareManagerAuthority(WORKER)).toBe(false);
      }
      record.remote = worker.remote;
      record.recoveryCodexHome = managerSession.getRecoveryContext().codexHome;
      // A remote scope alone cannot turn a local fixture into a controlled SSH worker.
      expect(worker.taskSupervisionSupported).toBe(false);
      expect(() => managerDeps.validateWorkers([WORKER])).toThrow(/eligible/);
      record.recoveryInputBroker = inputProofs.get(worker)!.incarnation;
      expect(worker.taskSupervisionSupported).toBe(owned);

      if (owned) expect(() => managerDeps.validateWorkers([WORKER])).not.toThrow();
      else expect(() => managerDeps.validateWorkers([WORKER])).toThrow(/eligible/);
      expect(await managerDeps.prepareManagerAuthority(WORKER)).toBe(owned);
      expect(effects).not.toHaveBeenCalled();
    }
  );

  it('seals a partial worker send when manager evidence changes before Enter and never replays it', async () => {
    const worker = internals.sessions.get(WORKER)!;
    const confirm = CodexRecoveryAdapter.prototype.confirmLocalEvidence;
    vi.spyOn(CodexRecoveryAdapter.prototype, 'confirmLocalEvidence').mockImplementation(async function (
      this: CodexRecoveryAdapter,
      conversationId: string,
      generation: number,
      source?: RecoveryEvidenceSource
    ) {
      return Reflect.get(this, 'session').id === WORKER ? true : confirm.call(this, conversationId, generation, source);
    });
    taskAct.mockRestore();
    Reflect.set(worker, '_mux', {
      ...Reflect.get(worker, '_mux'),
      isAvailable: () => true,
      inspectPaneForRecovery: async () => ({
        paneId: '%7',
        panePid: 99999,
        inputProvenance: inputProofs.get(worker),
        dead: false,
        screen: '›\n  fixture-model high · /tmp\n',
      }),
      sendInput: async (_id: string, _input: string, guard: RecoveryMuxDispatchGuard) => {
        if (!guard.prepareEvidence || !(await guard.prepareEvidence()) || !guard.confirm()) return false;
        guard.noteDispatch();
        effects('literal');
        await appendProgress({ outcome: 'blocked' });
        if (!(await guard.prepareEvidence()) || !guard.confirm()) return false;
        effects('Enter');
        return true;
      },
    });
    await expect(manager.assign(WORKER, 'partial-manager-veto')).rejects.toThrow(/uncertain|may have started/);
    expect(effects.mock.calls).toEqual([['literal']]);
    expect(manager.getStatus()).toMatchObject({ phase: 'paused', inFlight: { requestId: 'partial-manager-veto' } });
    expect(manager.getStatus().workers[0].assignments).toBe(0);
    expect(internals.getTaskController(worker)!.getStatus().inFlight).toBeDefined();
    await expect(manager.assign(WORKER, 'partial-manager-veto')).rejects.toThrow(/not active|reset/);
    expect(effects.mock.calls).toEqual([['literal']]);
  });
});
