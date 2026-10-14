/** @fileoverview Codex-specific recovery authority for verified local and owned SSH panes. */
import { createHash } from 'node:crypto';
import { openSync, closeSync, fstatSync, lstatSync, readSync, constants as fsConstants } from 'node:fs';
import type { Session } from '../session.js';
import { clampExternalCliConfigsForOwner, clampEnvOverridesForOwner } from '../session-env-clamp.js';
import { resolveCodexIdentity, type CodexIdentityWitness } from './codex-identity.js';
import { currentLocalCodexHome, normalizedCodexHome } from './codex-home.js';
import { classifyCodexTail, hasEmptyCodexComposer } from './codex-classifier.js';
import {
  validRemoteClock,
  remoteSubmissionWindow,
  remoteClockOffset,
  remoteToLocal,
  remoteCompletionToLocal,
  type RemoteClockWitness,
} from './remote-clock.js';
import { CONTINUATION_PROMPT, type RecoveryFlight, type RecoveryObservation } from './types.js';
import {
  inspectRemoteCodex,
  deliverRemoteCodexInput,
  restartRemoteCodexPane,
  restoreRemoteCodexWorker,
  type RemoteCodexEvidence,
  type RemoteCodexEvidenceRequest,
  type RemoteCodexIdentityGuard,
  type RemoteCodexInputRequest,
  type RemoteCodexInputResult,
  type RemoteCodexRestartRequest,
  type RemoteCodexRestoreRequest,
  type RemoteCodexActionAuthority,
} from './remote-codex.js';

export interface CodexRecoveryAdapterDeps {
  inspectRemote(
    remote: NonNullable<Session['remote']>,
    request: RemoteCodexEvidenceRequest
  ): Promise<RemoteCodexEvidence>;
  restartRemote(
    remote: NonNullable<Session['remote']>,
    request: RemoteCodexRestartRequest,
    isCurrent?: RemoteCodexActionAuthority
  ): Promise<'sent' | 'not-sent' | 'unknown'>;
  deliverRemote(
    remote: NonNullable<Session['remote']>,
    request: RemoteCodexInputRequest,
    isCurrent?: RemoteCodexActionAuthority
  ): Promise<RemoteCodexInputResult>;
  restoreRemote?(
    remote: NonNullable<Session['remote']>,
    request: RemoteCodexRestoreRequest,
    isCurrent?: RemoteCodexActionAuthority
  ): Promise<'sent' | 'not-sent' | 'unknown'>;
}

const defaultDeps: CodexRecoveryAdapterDeps = {
  inspectRemote: inspectRemoteCodex,
  restartRemote: restartRemoteCodexPane,
  deliverRemote: deliverRemoteCodexInput,
  restoreRemote: restoreRemoteCodexWorker,
};

const REMOTE_LIVE_PROOF_MAX_AGE_MS = 30_000;

interface RemoteDeadPaneFirstSeen {
  generation: number;
  evidenceKey: string;
  at: number;
}

// Recovery and task supervision have separate adapters for one Session. Share
// the first-death bound so reconstructing either adapter cannot age the same
// unchanged pane into authority while that Session generation is still active.
const remoteDeadPaneFirstSeenBySession = new WeakMap<Session, RemoteDeadPaneFirstSeen>();

function remotePaneEvidenceKey(
  conversationId: string,
  pane: Pick<RemoteCodexRestartRequest['expectedPane'], 'paneId' | 'panePid' | 'status' | 'signal'>
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([pane.paneId, pane.panePid, pane.status ?? null, pane.signal ?? null]), 'utf8')
    .digest('hex');
  return `${conversationId}:remote-pane:${digest}`;
}

export class CodexRecoveryAdapter {
  private proof?: {
    key: string;
    generation: number;
    conversationId: string;
    stallProgressAt?: number;
    remotePane?: RemoteCodexRestartRequest['expectedPane'] & RemoteCodexIdentityGuard;
  };
  private remotePromptProof?: {
    generation: number;
    conversationId: string;
    expected: RemoteCodexInputRequest['expected'];
    submission: NonNullable<RemoteCodexEvidenceRequest['submission']>;
  };
  private missingProof?: { generation: number; conversationId: string; tailHash: string };
  private verifiedTail?: {
    conversationId: string;
    tail: string;
    path?: string;
    witness?: CodexIdentityWitness;
    config?: string;
    env?: string;
    clock?: RemoteClockWitness;
  };
  private remotePaneContinuity?: {
    generation: number;
    conversationId: string;
    tailHash: string;
    paneId: string;
    panePid: number;
    liveObservedAt: number;
    deadObservedAt?: number;
  };
  constructor(
    private readonly session: Session,
    private readonly persistSession: () => void,
    private readonly deps: CodexRecoveryAdapterDeps = defaultDeps
  ) {}

  async observe(): Promise<RecoveryObservation> {
    const session = this.session;
    const context = session.getRecoveryContext();
    const unknown = (reason: RecoveryObservation['reason']): RecoveryObservation => ({
      activity: 'unknown',
      reason,
      at: Date.now(),
      safeToAct: false,
    });
    this.proof = undefined;
    this.missingProof = undefined;
    this.verifiedTail = undefined;
    this.remotePromptProof = undefined;
    if (session.docker) return unknown('unsupported-location');
    if (session.remote?.owned === false) return unknown('unowned-session');
    if (!context.managed) return unknown('unowned-session');
    // A remote login environment can change between probes and restart. Only an
    // explicitly persisted absolute home pins the worker's exact configuration.
    if (session.remote && normalizedCodexHome(context.codexHome) === undefined) return unknown('identity-unverified');
    if (!context.noDaemon) return unknown('managed-daemon');
    if (context.switchPending || context.untrackedInput || session.paneLifecycleInFlight)
      return unknown('identity-unverified');
    // Re-check the owner's current grant before either continuing or relaunching a privilege-bearing pane.
    const clamped = await clampExternalCliConfigsForOwner(session.owner, { codexConfig: session.codexConfig });
    // Include the active home explicitly; the path participates in the current grant check.
    const persistedEnv = session.getEnvOverridesForPersist();
    const env =
      context.codexHome && (session.remote || context.codexHome !== currentLocalCodexHome())
        ? { ...persistedEnv, CODEX_HOME: context.codexHome }
        : persistedEnv;
    const safeEnv = await clampEnvOverridesForOwner(session.owner, env);
    if (
      JSON.stringify(clamped.codexConfig) !== JSON.stringify(session.codexConfig) ||
      JSON.stringify(env) !== JSON.stringify(safeEnv)
    ) {
      return { ...unknown('approval-required'), activity: 'blocked' };
    }
    if (session.remote) {
      const evidence = await this.deps.inspectRemote(session.remote, {
        sessionId: session.id,
        workingDir: session.workingDir,
        codexHome: context.codexHome,
        resumeId: session.codexConfig?.resumeSessionId,
        submission: context.submission,
      });
      const afterInspect = session.getRecoveryContext();
      if (afterInspect.generation !== context.generation || afterInspect.switchPending || afterInspect.untrackedInput)
        return unknown('user-input');
      const [finalConfig, finalEnv] = await Promise.all([
        clampExternalCliConfigsForOwner(session.owner, { codexConfig: session.codexConfig }),
        clampEnvOverridesForOwner(session.owner, env),
      ]);
      if (
        JSON.stringify(finalConfig.codexConfig) !== JSON.stringify(session.codexConfig) ||
        JSON.stringify(finalEnv) !== JSON.stringify(env)
      )
        return { ...unknown('approval-required'), activity: 'blocked' };
      const remoteFinal = session.getRecoveryContext();
      if (remoteFinal.generation !== context.generation || remoteFinal.switchPending || remoteFinal.untrackedInput)
        return unknown('user-input');
      if (evidence.transport !== 'reachable')
        return unknown(evidence.transport === 'unreachable' ? 'transport-unreachable' : 'transport-unavailable');
      if (evidence.identity.reason === 'unsupported') return unknown('remote-inspector-unavailable');
      // Originator and a persisted resume id can both become stale after an
      // in-TUI thread switch. Remote authority starts with the latest exact
      // ordinary submission and its matching remote history record.
      if (!context.submission) return unknown('identity-unverified');
      if (evidence.session === 'unknown') return unknown('identity-unverified');
      if (!validRemoteClock(evidence.clock)) return unknown('identity-unverified');
      if (!remoteSubmissionWindow(context.submission, evidence.clock)) return unknown('identity-unverified');
      if (
        evidence.identity.reason !== 'verified' ||
        !evidence.identity.conversationId ||
        !evidence.identity.tail ||
        evidence.identity.tailTruncated !== false
      )
        return unknown('identity-unverified');
      const conversationId = evidence.identity.conversationId;
      const tailHash = createHash('sha256').update(evidence.identity.tail, 'utf8').digest('hex');
      const remoteTail = evidence.identity.tail;
      const remoteTailTruncated = evidence.identity.tailTruncated;
      const remoteClock = evidence.clock;
      this.verifiedTail = { conversationId, tail: evidence.identity.tail, clock: evidence.clock };
      const classifyRemoteTail = (screen: string | null, busy: boolean): RecoveryObservation => {
        const clock = remoteClock;
        const result = classifyCodexTail(remoteTail, {
          conversationId,
          now: clock.remoteAfter,
          screen,
          busy,
          watching: !!session.watching,
          tailTruncated: remoteTailTruncated,
          lastIntentionalStopAt:
            context.intentionalStopAt > 0
              ? context.intentionalStopAt + remoteClockOffset(clock).max
              : context.intentionalStopAt,
        });
        result.at = remoteToLocal(result.at, clock);
        if (result.progressAt !== undefined) result.progressAt = remoteCompletionToLocal(result.progressAt, clock);
        return result;
      };
      if (session.codexConfig?.resumeSessionId !== conversationId) {
        session.pinRecoveryConversation(conversationId);
        this.persistSession();
      }
      if (evidence.session === 'missing') {
        // A clean remote `/exit` removes a `remain-on-exit failed` tmux session and
        // lets ssh exit 0. The local wrapper is transport evidence only, but that
        // clean status is the necessary veto against presenting host-reboot restore.
        const transportPane = await session.inspectRemoteTransportPane();
        if (session.getRecoveryContext().generation !== context.generation) return unknown('user-input');
        if (!transportPane?.dead) return unknown('pane-unverified');
        if (transportPane.status === 0 && !transportPane.signal) {
          return {
            activity: 'exited',
            reason: 'clean-exit',
            at: evidence.identity.changedAt ?? Date.now(),
            conversationId,
            safeToAct: false,
          };
        }
        if (!((transportPane.status ?? 0) > 0 || (transportPane.signal ?? 0) > 0)) {
          return unknown('pane-unverified');
        }
        const classified = classifyRemoteTail(null, false);
        // Explicit restoration still cannot clear active child work or a structured veto.
        if (['watching', 'unknown', 'paused', 'blocked'].includes(classified.activity)) return classified;
        this.missingProof = { generation: context.generation, conversationId, tailHash };
        return {
          activity: 'unknown',
          reason: 'remote-session-missing',
          at: evidence.identity.changedAt ?? Date.now(),
          conversationId,
          safeToAct: false,
        };
      }
      if (evidence.session !== 'present') return unknown('pane-unverified');
      const pane = evidence.pane;
      if (!pane) return unknown('pane-unverified');
      let observation: RecoveryObservation;
      if (pane.dead) {
        if (pane.status === 0 && !pane.signal) {
          observation = {
            activity: 'exited',
            reason: 'clean-exit',
            at: evidence.identity.changedAt ?? Date.now(),
            safeToAct: false,
          };
        } else if ((pane.status !== undefined && pane.status > 0) || (pane.signal ?? 0) > 0) {
          const detectedAt = Date.now();
          const evidenceKey = remotePaneEvidenceKey(conversationId, pane);
          const priorDeadPane = remoteDeadPaneFirstSeenBySession.get(session);
          const firstDeadObservedAt =
            priorDeadPane?.generation === context.generation && priorDeadPane.evidenceKey === evidenceKey
              ? priorDeadPane.at
              : detectedAt;
          remoteDeadPaneFirstSeenBySession.set(session, {
            generation: context.generation,
            evidenceKey,
            at: firstDeadObservedAt,
          });
          const continuity = this.remotePaneContinuity;
          const transitionedFromLive =
            continuity?.generation === context.generation &&
            continuity.conversationId === conversationId &&
            continuity.tailHash === tailHash &&
            continuity.paneId === pane.paneId &&
            continuity.panePid === pane.panePid &&
            (continuity.deadObservedAt !== undefined ||
              detectedAt - continuity.liveObservedAt <= REMOTE_LIVE_PROOF_MAX_AGE_MS)
              ? continuity
              : undefined;
          if (transitionedFromLive && transitionedFromLive.deadObservedAt === undefined)
            transitionedFromLive.deadObservedAt = detectedAt;
          // A rollout mtime cannot date a crash that wrote no final event. Only
          // an exact live→dead pane transition may mint a current timestamp;
          // missing historical time otherwise stays ancient and fail-closed.
          const rolloutChangedAt = evidence.identity.changedAt;
          const boundedRolloutChangedAt =
            typeof rolloutChangedAt === 'number' &&
            Number.isFinite(rolloutChangedAt) &&
            rolloutChangedAt > 0 &&
            rolloutChangedAt <= firstDeadObservedAt
              ? rolloutChangedAt
              : 0;
          const crashAt = transitionedFromLive?.deadObservedAt ?? boundedRolloutChangedAt;
          const childWork = classifyRemoteTail('', false);
          observation = ['watching', 'unknown', 'paused', 'blocked'].includes(childWork.activity)
            ? childWork
            : {
                activity: 'crashed',
                reason: 'process-crashed',
                at: crashAt,
                ...(transitionedFromLive ? { liveProofAt: transitionedFromLive.liveObservedAt } : {}),
                evidenceKey,
                safeToAct: crashAt > 0 && context.intentionalStopAt < crashAt - 2000,
              };
        } else return unknown('pane-unverified');
      } else {
        const observedAt = Date.now();
        remoteDeadPaneFirstSeenBySession.delete(session);
        this.remotePaneContinuity = {
          generation: context.generation,
          conversationId,
          tailHash,
          paneId: pane.paneId,
          panePid: pane.panePid,
          liveObservedAt: observedAt,
        };
        observation = classifyRemoteTail(pane.screen, session.isBusy());
        observation.processReady =
          evidence.identity.tailTruncated === false &&
          pane.screen !== null &&
          hasEmptyCodexComposer(pane.screen) &&
          !['blocked', 'paused', 'unknown'].includes(observation.activity);
        if (observation.processReady && pane.screen !== null) {
          this.remotePromptProof = {
            generation: context.generation,
            conversationId,
            submission: context.submission,
            expected: {
              conversationId,
              tailHash,
              paneId: pane.paneId,
              panePid: pane.panePid,
              screenHash: createHash('sha256').update(pane.screen, 'utf8').digest('hex'),
            },
          };
        }
      }
      observation.conversationId = conversationId;
      if (observation.safeToAct && observation.evidenceKey) {
        this.proof = {
          key: observation.evidenceKey,
          generation: context.generation,
          conversationId,
          ...(pane.dead
            ? {
                remotePane: {
                  conversationId,
                  tailHash,
                  paneId: pane.paneId,
                  panePid: pane.panePid,
                  status: pane.status,
                  signal: pane.signal,
                },
              }
            : {}),
        };
      }
      return observation;
    }
    const [identity, pane] = await Promise.all([
      resolveCodexIdentity({
        sessionId: session.id,
        workingDir: session.workingDir,
        codexHome: context.codexHome,
        noDaemon: context.noDaemon,
        resumeId: session.codexConfig?.resumeSessionId,
        submission: context.submission,
      }),
      session.inspectRecoveryPane(),
    ]);
    const afterIdentity = session.getRecoveryContext();
    if (afterIdentity.generation !== context.generation || afterIdentity.switchPending || afterIdentity.untrackedInput)
      return unknown('user-input');
    const finalConfig = await clampExternalCliConfigsForOwner(session.owner, { codexConfig: session.codexConfig });
    const finalEnv = await clampEnvOverridesForOwner(session.owner, env);
    if (
      JSON.stringify(finalConfig.codexConfig) !== JSON.stringify(session.codexConfig) ||
      JSON.stringify(finalEnv) !== JSON.stringify(env)
    )
      return { ...unknown('approval-required'), activity: 'blocked' };
    const localFinal = session.getRecoveryContext();
    if (localFinal.generation !== context.generation || localFinal.switchPending || localFinal.untrackedInput)
      return unknown('user-input');
    if (!identity.conversationId || identity.reason !== 'verified' || identity.tail === undefined)
      return unknown('identity-unverified');
    if (identity.tailTruncated === false)
      this.verifiedTail = {
        conversationId: identity.conversationId,
        tail: identity.tail,
        path: identity.path,
        witness: identity.witness,
        config: JSON.stringify(this.session.codexConfig),
        env: JSON.stringify(this.session.getEnvOverridesForPersist()),
      };
    if (!pane) return unknown('pane-unverified');
    if (session.codexConfig?.resumeSessionId !== identity.conversationId) {
      session.pinRecoveryConversation(identity.conversationId);
      this.persistSession();
    }
    let observation: RecoveryObservation;
    if (pane.dead) {
      const exit = session.paneExit;
      const classified = classifyCodexTail(identity.tail, {
        conversationId: identity.conversationId,
        now: Date.now(),
        screen: null,
        busy: false,
        watching: !!session.watching,
        tailTruncated: identity.tailTruncated,
        lastIntentionalStopAt: context.intentionalStopAt,
      });
      if (pane.status === 0 && !pane.signal) {
        observation = { activity: 'exited', reason: 'clean-exit', at: exit?.at ?? Date.now(), safeToAct: false };
      } else if (classified.activity === 'watching' || classified.activity === 'unknown') {
        observation = classified;
      } else if (
        exit &&
        pane.status === exit.status &&
        pane.signal === exit.signal &&
        ((pane.status !== undefined && pane.status > 0) || (pane.signal ?? 0) > 0)
      ) {
        // A confirmed parent exit cannot clear child work, owner intent or permission/authentication vetoes.
        const childWork = classifyCodexTail(identity.tail, {
          conversationId: identity.conversationId,
          now: Date.now(),
          screen: '',
          busy: false,
          watching: !!session.watching,
          tailTruncated: identity.tailTruncated,
          lastIntentionalStopAt: context.intentionalStopAt,
        });
        observation = ['watching', 'unknown', 'paused', 'blocked'].includes(childWork.activity)
          ? childWork
          : {
              activity: 'crashed',
              reason: 'process-crashed',
              at: exit.at,
              evidenceKey: `${identity.conversationId}:pane:${exit.at}:${pane.status ?? pane.signal}`,
              safeToAct: context.intentionalStopAt < exit.at - 2000,
            };
      } else if (
        classified.activity === 'working' &&
        classified.reason === 'turn-running' &&
        classified.stallEvidenceKey &&
        ((pane.status !== undefined && pane.status > 0) || (pane.signal ?? 0) > 0) &&
        context.intentionalStopAt < (classified.progressAt ?? classified.at) - 2000
      ) {
        // The rollout proves which current turn is unfinished; the fresh pane probe proves
        // the process is abnormally dead. Neither fact alone authorizes a restart.
        observation = { ...classified, stallRestartable: true };
      } else observation = unknown('pane-unverified');
    } else {
      observation = classifyCodexTail(identity.tail, {
        conversationId: identity.conversationId,
        now: Date.now(),
        screen: pane.screen,
        busy: session.isBusy(),
        watching: !!session.watching,
        tailTruncated: identity.tailTruncated,
        lastIntentionalStopAt: context.intentionalStopAt,
      });
      observation.processReady =
        identity.tailTruncated === false &&
        pane.screen !== null &&
        hasEmptyCodexComposer(pane.screen) &&
        !['blocked', 'paused', 'unknown'].includes(observation.activity);
    }
    observation.conversationId = identity.conversationId;
    // A bounded suffix can hide an earlier still-live child, including after the parent process exits.
    observation.safeToAct = observation.safeToAct && identity.tailTruncated === false;
    if (identity.tailTruncated !== false) delete observation.stallRestartable;
    const proofKey = observation.safeToAct
      ? observation.evidenceKey
      : observation.stallRestartable
        ? observation.stallEvidenceKey
        : undefined;
    if (proofKey) {
      this.proof = {
        key: proofKey,
        generation: context.generation,
        conversationId: identity.conversationId,
        ...(observation.stallRestartable ? { stallProgressAt: observation.progressAt ?? observation.at } : {}),
      };
    }
    return observation;
  }

  /** Tail from this adapter's latest exact identity observation; never API-bound. */
  getVerifiedTail(conversationId: string): string | undefined {
    return this.verifiedTail?.conversationId === conversationId ? this.verifiedTail.tail : undefined;
  }

  getVerifiedRemoteClock(conversationId: string): RemoteClockWitness | undefined {
    return this.verifiedTail?.conversationId === conversationId ? this.verifiedTail.clock : undefined;
  }

  private remoteAuthority(conversationId: string, generation: number, isCurrent: () => boolean) {
    const expected = this.session.remoteRecoveryConfiguration();
    return {
      check: () => this.session.confirmRemoteRecoveryAuthority(conversationId, generation, isCurrent, expected),
      isCurrent: () => this.session.isRemoteRecoveryAuthorityCurrent(conversationId, generation, isCurrent, expected),
    };
  }

  /** Last local evidence read after Session has awaited pane and current grants. */
  confirmLocalEvidence(conversationId: string, generation: number): boolean {
    const expected = this.verifiedTail;
    const context = this.session.getRecoveryContext();
    if (
      this.session.remote ||
      expected?.conversationId !== conversationId ||
      !expected.path ||
      !expected.witness ||
      context.generation !== generation ||
      expected.config !== JSON.stringify(this.session.codexConfig) ||
      expected.env !== JSON.stringify(this.session.getEnvOverridesForPersist())
    )
      return false;
    let fd: number | undefined;
    try {
      // Any changed history binding, conflicting rollout or ancestor invalidates this observation.
      for (const input of expected.witness.paths) {
        const stat = lstatSync(input.path);
        if (
          stat.isSymbolicLink() ||
          (input.kind === 'file' ? !stat.isFile() : !stat.isDirectory()) ||
          stat.dev !== input.dev ||
          stat.ino !== input.ino ||
          (input.size !== undefined && stat.size !== input.size) ||
          (input.mtimeMs !== undefined && stat.mtimeMs !== input.mtimeMs) ||
          (input.ctimeMs !== undefined && stat.ctimeMs !== input.ctimeMs)
        )
          return false;
      }
      // This bounded synchronous proof introduces no new await after Session's final owner-grant read.
      fd = openSync(expected.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
      const before = fstatSync(fd);
      if (!before.isFile() || before.size > 262_144) return false;
      const bytes = Buffer.alloc(before.size);
      if (readSync(fd, bytes, 0, before.size, 0) !== before.size) return false;
      const after = fstatSync(fd);
      return (
        after.size === before.size &&
        after.mtimeMs === before.mtimeMs &&
        this.session.getRecoveryContext().generation === generation &&
        createHash('sha256').update(bytes).digest('hex') === createHash('sha256').update(expected.tail).digest('hex')
      );
    } catch {
      return false;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  async act(flight: RecoveryFlight, isCurrent: () => boolean = () => true): Promise<'sent' | 'not-sent' | 'unknown'> {
    const previous = this.proof;
    if (!isCurrent() || !previous || previous.key !== flight.key || previous.conversationId !== flight.conversationId)
      return 'not-sent';
    // Reads are repeated immediately before execution; a completed turn or new user input vetoes an old reservation.
    const current = await this.observe();
    // The turn key survives appended progress. A stall needs the same silence
    // baseline that the controller confirmed before its durable reservation.
    const currentProvesAction =
      flight.reason === 'stalled'
        ? current.stallRestartable === true &&
          current.stallEvidenceKey === flight.key &&
          previous.stallProgressAt !== undefined &&
          (current.progressAt ?? current.at) === previous.stallProgressAt
        : current.safeToAct && current.evidenceKey === flight.key;
    if (!isCurrent() || !currentProvesAction || !this.proof || this.proof.generation !== previous.generation)
      return 'not-sent';
    let result: 'sent' | 'not-sent' | 'unknown';
    if (this.session.remote) {
      if (flight.action === 'restart') {
        const pane = this.proof.remotePane;
        const context = this.session.getRecoveryContext();
        if (!pane || !this.session.codexConfig || !context.submission) return 'not-sent';
        const authority = this.remoteAuthority(flight.conversationId, this.proof.generation, isCurrent);
        result = await this.session.restartRemoteRecoveryPane(
          flight.conversationId,
          this.proof.generation,
          isCurrent,
          () =>
            this.deps.restartRemote(
              this.session.remote!,
              {
                sessionId: this.session.id,
                resumeId: flight.conversationId,
                submission: context.submission,
                expectedIdentity: { conversationId: pane.conversationId, tailHash: pane.tailHash },
                expectedPane: {
                  paneId: pane.paneId,
                  panePid: pane.panePid,
                  status: pane.status,
                  signal: pane.signal,
                },
                codexConfig: { ...this.session.codexConfig!, resumeSessionId: flight.conversationId },
                codexHome: context.codexHome,
              },
              authority
            )
        );
      } else {
        result = await this.deliverRemotePrompt(
          flight.conversationId,
          this.proof.generation,
          CONTINUATION_PROMPT,
          isCurrent
        );
      }
    } else {
      const generation = this.proof.generation;
      result = await this.session.deliverRecovery(flight, generation, isCurrent, CONTINUATION_PROMPT, () =>
        this.confirmLocalEvidence(flight.conversationId, generation)
      );
    }
    if (result === 'sent') this.persistSession();
    return result;
  }

  /** Final direct-SSH input guarded by the exact live pane, screen, rollout and current submission. */
  async deliverRemotePrompt(
    conversationId: string,
    generation: number,
    prompt: string,
    isCurrent: () => boolean = () => true
  ): Promise<'sent' | 'not-sent' | 'unknown'> {
    const proof = this.remotePromptProof;
    const remote = this.session.remote;
    const context = this.session.getRecoveryContext();
    if (
      !remote ||
      !proof ||
      proof.generation !== generation ||
      proof.conversationId !== conversationId ||
      context.generation !== generation ||
      !isCurrent()
    )
      return 'not-sent';
    const authority = this.remoteAuthority(conversationId, generation, isCurrent);
    return this.session.deliverRemoteRecoveryInput(
      conversationId,
      generation,
      prompt,
      () =>
        this.deps.deliverRemote(
          remote,
          {
            sessionId: this.session.id,
            workingDir: this.session.workingDir,
            codexHome: context.codexHome,
            resumeId: conversationId,
            submission: proof.submission,
            expected: proof.expected,
            prompt,
          },
          authority
        ),
      isCurrent
    );
  }

  /** Explicit owner-request path only; automatic evaluation never calls this. */
  async restoreMissingRemote(isCurrent: () => boolean = () => true): Promise<'sent' | 'not-sent' | 'unknown'> {
    if (!this.deps.restoreRemote) return 'not-sent';
    const first = await this.observe();
    const proof = this.missingProof;
    if (
      !isCurrent() ||
      !proof ||
      first.reason !== 'remote-session-missing' ||
      first.conversationId !== proof.conversationId
    )
      return 'not-sent';
    const second = await this.observe();
    if (
      !isCurrent() ||
      !this.missingProof ||
      this.missingProof.generation !== proof.generation ||
      this.missingProof.tailHash !== proof.tailHash ||
      second.reason !== 'remote-session-missing' ||
      second.conversationId !== proof.conversationId
    )
      return 'not-sent';
    const context = this.session.getRecoveryContext();
    if (!this.session.remote || !this.session.codexConfig || !context.submission) return 'not-sent';
    const authority = this.remoteAuthority(proof.conversationId, proof.generation, isCurrent);
    const result = await this.session.restoreMissingRemoteWorker(
      proof.conversationId,
      proof.generation,
      isCurrent,
      () =>
        this.deps.restoreRemote!(
          this.session.remote!,
          {
            sessionId: this.session.id,
            resumeId: proof.conversationId,
            submission: context.submission,
            expectedIdentity: { conversationId: proof.conversationId, tailHash: proof.tailHash },
            codexConfig: { ...this.session.codexConfig!, resumeSessionId: proof.conversationId },
            codexHome: context.codexHome,
          },
          authority
        )
    );
    if (result === 'sent') this.persistSession();
    return result;
  }
}
