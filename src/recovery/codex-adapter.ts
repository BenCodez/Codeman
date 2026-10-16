/** @fileoverview Codex-specific recovery authority for verified local and owned SSH panes. */
import { createHash } from 'node:crypto';
import type { Session } from '../session.js';
import type { RecoveryPaneIdentity } from '../mux-interface.js';
import { matchesNativePaneSignal } from './native-pane-signal.js';
import {
  clampExternalCliConfigsForOwner,
  clampEnvOverridesForOwner,
  clampRecoveryLaunchForOwner,
} from '../session-env-clamp.js';
import { resolveCodexIdentity, type CodexIdentityWitness } from './codex-identity.js';
import { checkCodexIdentityWitnesses } from './codex-witness-check.js';
import { currentLocalCodexHome, normalizedCodexHome } from './codex-home.js';
import type { CodexBrokerProof } from './codex-input-broker.js';
import type { OwnedRemoteBrokerDescriptor } from './remote-input-broker-cache.js';
import { classifyCodexTail, hasEmptyCodexComposer } from './codex-classifier.js';
import {
  validRemoteClock,
  remoteSubmissionWindow,
  remoteClockOffset,
  remoteToLocal,
  remoteCompletionToLocal,
  type RemoteClockWitness,
} from './remote-clock.js';
import {
  CONTINUATION_PROMPT,
  isRecoveryEvidenceSourceCurrent,
  type RecoveryFlight,
  type RecoveryObservation,
} from './types.js';
import {
  inspectRemoteCodex,
  remotePromptFrameAdmission,
  remotePromptCommandFits,
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
  pane: Pick<RemoteCodexRestartRequest['expectedPane'], 'paneId' | 'panePid' | 'status' | 'signal'>,
  processKey: string
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([pane.paneId, pane.panePid, pane.status ?? null, pane.signal ?? null, processKey]), 'utf8')
    .digest('hex');
  return `${conversationId}:remote-pane:${digest}`;
}

export class CodexRecoveryAdapter {
  private livePaneProof?: { paneId: string; panePid: number; at: number; conversationId: string; scope: string };
  private latestLiveProofAt?: number;

  private liveProofScope(): string {
    const context = this.session.getRecoveryContext();
    return JSON.stringify([
      context.generation,
      this.session.owner,
      this.session.workingDir,
      this.session.codexConfig,
      this.session.getEnvOverridesForPersist(),
      context.codexHome,
      this.session.remote,
    ]);
  }

  /** Live evidence is private, process-specific, short-lived and never restored from disk. */
  hasLivePaneProof(at: number): boolean {
    const elapsed = Date.now() - at;
    if (this.session.remote) {
      const live = this.remotePaneContinuity;
      const pane = this.proof?.remotePane;
      return (
        Number.isFinite(at) &&
        this.latestLiveProofAt === at &&
        !!live &&
        live.liveObservedAt === at &&
        live.deadObservedAt !== undefined &&
        live.scope === this.liveProofScope() &&
        !!pane &&
        this.proof?.generation === live.generation &&
        this.proof.processProofKey === live.processKey &&
        pane.conversationId === live.conversationId &&
        pane.tailHash === live.tailHash &&
        pane.paneId === live.paneId &&
        pane.panePid === live.panePid &&
        Number.isFinite(elapsed) &&
        elapsed >= 0 &&
        elapsed <= REMOTE_LIVE_PROOF_MAX_AGE_MS
      );
    }
    return (
      Number.isFinite(at) &&
      !!this.livePaneProof &&
      this.latestLiveProofAt === at &&
      this.livePaneProof?.at === at &&
      this.livePaneProof.scope === this.liveProofScope() &&
      Number.isFinite(elapsed) &&
      elapsed >= 0 &&
      elapsed <= 30_000
    );
  }
  private proof?: {
    key: string;
    generation: number;
    conversationId: string;
    stallProgressAt?: number;
    stallProgressEvidenceKey?: string;
    stallEvidenceKey?: string;
    processProofKey?: string;
    nativePane?: RecoveryPaneIdentity;
    remotePane?: RemoteCodexRestartRequest['expectedPane'] & RemoteCodexIdentityGuard;
  };
  private remotePromptProof?: {
    generation: number;
    conversationId: string;
    expected: RemoteCodexInputRequest['expected'];
    submission: NonNullable<RemoteCodexEvidenceRequest['submission']>;
    inputBroker: OwnedRemoteBrokerDescriptor;
  };
  private missingProof?: { generation: number; conversationId: string; tailHash: string };
  private verifiedTail?: {
    conversationId: string;
    tail: string;
    tailTruncated?: boolean;
    path?: string;
    witness?: CodexIdentityWitness;
    config: string;
    env: string;
    inputProof?: CodexBrokerProof;
    clock?: RemoteClockWitness;
  };
  private remotePaneContinuity?: {
    generation: number;
    conversationId: string;
    tailHash: string;
    paneId: string;
    panePid: number;
    processKey: string;
    liveObservedAt: number;
    scope: string;
    deadObservedAt?: number;
  };
  constructor(
    private readonly session: Session,
    private readonly persistSession: () => void,
    private readonly deps: CodexRecoveryAdapterDeps = defaultDeps
  ) {}

  /** Passive SSH envelope proof; never hydrates the broker cache or mints delivery authority. */
  async previewRemotePrompt(
    prompt: string,
    authority: import('./types.js').RecoveryActionAuthority
  ): Promise<{ observation: RecoveryObservation; tail: string; clock: RemoteClockWitness } | undefined> {
    const session = this.session;
    if (session.ensureRecoveryIdentityFence && !(await session.ensureRecoveryIdentityFence())) return undefined;
    const context = session.getRecoveryContext();
    if (
      !session.remote ||
      session.remote.owned === false ||
      session.docker ||
      !context.managed ||
      !context.noDaemon ||
      !normalizedCodexHome(context.codexHome) ||
      !context.submission ||
      context.switchPending ||
      context.untrackedInput ||
      context.inputBrokerPending ||
      session.paneLifecycleInFlight ||
      authority() !== true
    )
      return undefined;
    const scope = () =>
      JSON.stringify([
        session.owner,
        session.workingDir,
        session.remote,
        session.codexConfig,
        session.getEnvOverridesForPersist(),
        session.getRecoveryContext(),
        session.paneLifecycleInFlight,
      ]);
    const snapshot = scope(),
      current = () => authority() === true && scope() === snapshot;
    const env = { ...session.getEnvOverridesForPersist(), CODEX_HOME: context.codexHome! };
    const grant = await clampRecoveryLaunchForOwner(session.owner, { codexConfig: session.codexConfig }, env);
    if (
      !current() ||
      !grant.isCurrent() ||
      JSON.stringify(grant.configs.codexConfig) !== JSON.stringify(session.codexConfig) ||
      JSON.stringify(grant.env) !== JSON.stringify(env)
    )
      return undefined;
    const inputBroker = await session.getOwnedRemoteInputBroker();
    if (!inputBroker || !current() || !grant.isCurrent()) return undefined;
    if (authority.prepareEvidence && (await authority.prepareEvidence()) !== true) return undefined;
    if (!current() || !grant.isCurrent()) return undefined;
    const issuer = authority.getInputIssuer?.();
    if (issuer instanceof Promise || (issuer && typeof (issuer as unknown as { then?: unknown }).then === 'function')) {
      void Promise.resolve(issuer).catch(() => {});
      return undefined;
    }
    if (authority.getInputIssuer && (!issuer || issuer.sessionId === session.id)) return undefined;
    const admission = remotePromptFrameAdmission(prompt, issuer);
    if (!admission) return undefined;
    const issuerSnapshot = JSON.stringify(issuer);
    const brokerSnapshot = JSON.stringify(inputBroker);
    const request: RemoteCodexEvidenceRequest = {
      sessionId: session.id,
      workingDir: session.remote.remotePath,
      codexHome: context.codexHome,
      resumeId: session.codexConfig?.resumeSessionId,
      submission: context.submission,
      inputBroker,
      frameAdmission: admission,
    };
    const evidence = await this.deps.inspectRemote(session.remote, request);
    const retained = await session.getOwnedRemoteInputBroker();
    const finalIssuer = authority.getInputIssuer?.();
    if (
      finalIssuer instanceof Promise ||
      (finalIssuer && typeof (finalIssuer as unknown as { then?: unknown }).then === 'function')
    ) {
      void Promise.resolve(finalIssuer).catch(() => {});
      return undefined;
    }
    if (JSON.stringify(finalIssuer) !== issuerSnapshot) return undefined;
    if (
      !current() ||
      !grant.isCurrent() ||
      JSON.stringify(retained) !== brokerSnapshot ||
      evidence.transport !== 'reachable' ||
      evidence.session !== 'present' ||
      !evidence.pane ||
      evidence.pane.dead ||
      !evidence.inputBroker ||
      evidence.identity.reason !== 'verified' ||
      !evidence.identity.conversationId ||
      !evidence.identity.tail ||
      evidence.identity.tailTruncated !== false ||
      !validRemoteClock(evidence.clock) ||
      !remoteSubmissionWindow(context.submission, evidence.clock) ||
      !evidence.frameAdmission?.fits ||
      ['promptHash', 'maxPhaseBytes', 'issuerLeaseBytes'].some(
        (key) => evidence.frameAdmission![key as keyof typeof admission] !== admission[key as keyof typeof admission]
      )
    )
      return undefined;
    if (!remotePromptCommandFits(session.remote, request, prompt, evidence, issuer)) return undefined;
    const clock = evidence.clock;
    const observation = classifyCodexTail(evidence.identity.tail, {
      conversationId: evidence.identity.conversationId,
      now: clock.remoteAfter,
      screen: evidence.pane.screen,
      busy: session.isBusy(),
      watching: !!session.watching,
      tailTruncated: false,
      lastIntentionalStopAt:
        context.intentionalStopAt > 0
          ? context.intentionalStopAt + remoteClockOffset(clock).max
          : context.intentionalStopAt,
    });
    observation.at = remoteToLocal(observation.at, clock);
    if (observation.progressAt !== undefined)
      observation.progressAt = remoteCompletionToLocal(observation.progressAt, clock);
    observation.conversationId = evidence.identity.conversationId;
    observation.processReady =
      evidence.pane.screen !== null &&
      hasEmptyCodexComposer(evidence.pane.screen) &&
      !['blocked', 'paused', 'unknown'].includes(observation.activity);
    return current() && grant.isCurrent() ? { observation, tail: evidence.identity.tail, clock } : undefined;
  }

  async observe(): Promise<RecoveryObservation> {
    this.latestLiveProofAt = undefined;
    const session = this.session;
    const unknown = (reason: RecoveryObservation['reason']): RecoveryObservation => {
      this.livePaneProof = undefined;
      this.remotePaneContinuity = undefined;
      return { activity: 'unknown', reason, at: Date.now(), safeToAct: false };
    };
    this.proof = undefined;
    this.missingProof = undefined;
    this.verifiedTail = undefined;
    this.remotePromptProof = undefined;
    if (session.ensureRecoveryIdentityFence && !(await session.ensureRecoveryIdentityFence()))
      return unknown('identity-unverified');
    const context = session.getRecoveryContext();
    if (session.docker) return unknown('unsupported-location');
    if (session.remote?.owned === false) return unknown('unowned-session');
    if (!context.managed) return unknown('unowned-session');
    // A remote login environment can change between probes and restart. Only an
    // explicitly persisted absolute home pins the worker's exact configuration.
    if (session.remote && normalizedCodexHome(context.codexHome) === undefined) return unknown('identity-unverified');
    if (!context.noDaemon) return unknown('managed-daemon');
    if (context.switchPending || context.untrackedInput || context.inputBrokerPending || session.paneLifecycleInFlight)
      return unknown('identity-unverified');
    // A launch seed cannot witness an untracked direct-TUI /resume.
    // Effects require an exact owner submission and its current history identity.
    if (!context.submission) return unknown('identity-unverified');
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
      const inputBroker = await session.getOwnedRemoteInputBroker();
      if (session.getRecoveryContext().generation !== context.generation) return unknown('user-input');
      const evidence = await this.deps.inspectRemote(session.remote, {
        sessionId: session.id,
        workingDir: session.remote.remotePath,
        codexHome: context.codexHome,
        resumeId: session.codexConfig?.resumeSessionId,
        submission: context.submission,
        inputBroker,
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
        if (result.progressAt !== undefined) {
          const nativeProgressAt = result.progressAt;
          result.progressAt = remoteCompletionToLocal(nativeProgressAt, clock);
          result.progressLowerBound = remoteToLocal(nativeProgressAt, clock);
          // Only validated native events define progress. Probe latency and rollout
          // metadata changes must not mint another silence/recovery cycle.
          result.progressEvidenceKey = `remote:${createHash('sha256')
            .update(
              remoteTail
                .split('\n')
                .filter((line) => line.trim() && JSON.parse(line)?.type === 'event_msg')
                .join('\n')
            )
            .digest('hex')}`;
        }
        return result;
      };
      let brokerPanePid: number;
      try {
        brokerPanePid = evidence.pane?.panePid ?? JSON.parse(evidence.inputBroker?.serialized ?? 'null')?.pid;
      } catch {
        return unknown('identity-unverified');
      }
      if (evidence.session === 'missing' && evidence.inputBroker?.historical !== true)
        return unknown('identity-unverified');
      if (!inputBroker || !evidence.inputBroker) return unknown('identity-unverified');
      const inputProof = session.observeOwnedRemoteInputBroker(
        evidence.inputBroker.serialized,
        evidence.inputBroker.witness,
        brokerPanePid,
        evidence.session === 'present' && evidence.inputBroker.historical !== true
      );
      if (
        !inputProof ||
        !session.isOwnedRemoteInputBrokerProofCurrent(inputProof) ||
        inputProof.incarnation !== inputBroker.incarnation ||
        (evidence.session === 'present' && inputProof.closed !== evidence.pane?.dead) ||
        inputProof.homeDigest !== createHash('sha256').update(context.codexHome!).digest('hex')
      ) {
        this.verifiedTail = undefined;
        return unknown('identity-unverified');
      }
      this.verifiedTail = {
        conversationId,
        tail: evidence.identity.tail,
        tailTruncated: evidence.identity.tailTruncated,
        clock: evidence.clock,
        config: JSON.stringify(this.session.codexConfig),
        env: JSON.stringify(this.session.getEnvOverridesForPersist()),
      };
      if (session.codexConfig?.resumeSessionId !== conversationId) {
        session.pinRecoveryConversation(conversationId);
        this.persistSession();
      }
      if (this.verifiedTail) this.verifiedTail.inputProof = inputProof;
      const remoteProcessKey = JSON.stringify([
        inputProof.incarnation,
        inputProof.brokerPid,
        inputProof.childPid,
        inputProof.brokerStart,
        inputProof.childStart,
      ]);
      if (evidence.session === 'missing') {
        if (inputProof.closed && inputProof.exitStatus === 0 && !inputProof.exitSignal)
          return {
            activity: 'exited',
            reason: 'clean-exit',
            at: evidence.identity.changedAt ?? Date.now(),
            conversationId,
            safeToAct: false,
          };
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
      if (
        !pane ||
        !/^%\d+$/.test(pane.paneId) ||
        !Number.isSafeInteger(Number(pane.paneId.slice(1))) ||
        !Number.isSafeInteger(pane.panePid) ||
        pane.panePid <= 0
      )
        return unknown('pane-unverified');
      if (!pane.dead && (pane.status !== undefined || pane.signal !== undefined)) return unknown('pane-unverified');
      let observation: RecoveryObservation;
      if (pane.dead) {
        if (
          (inputProof.closed && inputProof.exitStatus === 0 && !inputProof.exitSignal) ||
          (pane.status === 0 && !pane.signal)
        ) {
          observation = {
            activity: 'exited',
            reason: 'clean-exit',
            at: evidence.identity.changedAt ?? Date.now(),
            safeToAct: false,
          };
        } else if ((pane.status !== undefined && pane.status > 0) || (pane.signal ?? 0) > 0) {
          const detectedAt = Date.now();
          const evidenceKey = remotePaneEvidenceKey(conversationId, pane, remoteProcessKey);
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
            continuity.scope === this.liveProofScope() &&
            continuity.conversationId === conversationId &&
            continuity.tailHash === tailHash &&
            continuity.paneId === pane.paneId &&
            continuity.panePid === pane.panePid &&
            continuity.processKey === remoteProcessKey &&
            (continuity.deadObservedAt !== undefined ||
              detectedAt - continuity.liveObservedAt <= REMOTE_LIVE_PROOF_MAX_AGE_MS)
              ? continuity
              : undefined;
          if (transitionedFromLive && transitionedFromLive.deadObservedAt === undefined)
            transitionedFromLive.deadObservedAt = detectedAt;
          if (transitionedFromLive) this.latestLiveProofAt = transitionedFromLive.liveObservedAt;
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
                ...(childWork.activity === 'working' &&
                childWork.reason === 'turn-running' &&
                childWork.stallEvidenceKey
                  ? {
                      stallEvidenceKey: childWork.stallEvidenceKey,
                      progressAt: childWork.progressAt ?? childWork.at,
                      progressEvidenceKey: childWork.progressEvidenceKey,
                      progressLowerBound: childWork.progressLowerBound,
                      stallObservedAt: remoteClock.localBefore,
                      stallRestartable:
                        crashAt > 0 &&
                        context.intentionalStopAt <
                          (childWork.progressLowerBound ?? childWork.progressAt ?? childWork.at) - 2000 &&
                        detectedAt >= remoteClock.localAfter &&
                        detectedAt - remoteClock.localBefore <= 15_000,
                    }
                  : {}),
              };
        } else return unknown('pane-unverified');
      } else {
        const observedAt = remoteClock.localBefore;
        remoteDeadPaneFirstSeenBySession.delete(session);
        this.remotePaneContinuity =
          Date.now() >= remoteClock.localAfter && Date.now() - observedAt <= REMOTE_LIVE_PROOF_MAX_AGE_MS
            ? {
                generation: context.generation,
                conversationId,
                tailHash,
                paneId: pane.paneId,
                panePid: pane.panePid,
                processKey: remoteProcessKey,
                liveObservedAt: observedAt,
                scope: this.liveProofScope(),
              }
            : undefined;
        observation = classifyRemoteTail(pane.screen, session.isBusy());
        observation.processReady =
          evidence.identity.tailTruncated === false &&
          pane.screen !== null &&
          hasEmptyCodexComposer(pane.screen) &&
          !['blocked', 'paused', 'unknown'].includes(observation.activity);
        if (observation.processReady === true && this.remotePaneContinuity) observation.processReadyAt = observedAt;
        if (observation.processReady && pane.screen !== null) {
          this.remotePromptProof = {
            generation: context.generation,
            conversationId,
            submission: context.submission,
            inputBroker,
            expected: {
              conversationId,
              tailHash,
              paneId: pane.paneId,
              panePid: pane.panePid,
              screenHash: createHash('sha256').update(pane.screen, 'utf8').digest('hex'),
              inputProof,
            },
          };
        }
      }
      observation.conversationId = conversationId;
      observation.processProofKey = remoteProcessKey;
      const proofKey = observation.safeToAct
        ? observation.evidenceKey
        : observation.stallRestartable
          ? observation.stallEvidenceKey
          : undefined;
      if (proofKey) {
        this.proof = {
          key: proofKey,
          generation: context.generation,
          conversationId,
          processProofKey: remoteProcessKey,
          ...(observation.stallRestartable
            ? {
                stallEvidenceKey: observation.stallEvidenceKey,
                stallProgressAt: observation.progressAt ?? observation.at,
                stallProgressEvidenceKey: observation.progressEvidenceKey,
              }
            : {}),
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
    const paneReadStartedAt = Date.now();
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
        tailTruncated: identity.tailTruncated,
        path: identity.path,
        witness: identity.witness,
        config: JSON.stringify(this.session.codexConfig),
        env: JSON.stringify(this.session.getEnvOverridesForPersist()),
      };
    if (!pane) return unknown('pane-unverified');
    if (!pane.dead && (pane.status !== undefined || pane.signal !== undefined || !!pane.paneSignalToken))
      return unknown('pane-unverified');
    // History identifies submitted input, not an unobserved direct /resume.
    // Only a launch-owned input broker can exclude that unseen input path.
    const inputProof = pane.inputProvenance;
    if (!inputProof || !inputProof.fileWitness) return unknown('identity-unverified');
    if (!context.codexHome || inputProof.homeDigest !== createHash('sha256').update(context.codexHome).digest('hex'))
      return unknown('identity-unverified');
    if (
      inputProof.brokerPid !== pane.panePid ||
      inputProof.closed !== pane.dead ||
      !Number.isSafeInteger(inputProof.childPid) ||
      inputProof.childPid <= 0
    )
      return unknown('pane-unverified');
    if (this.verifiedTail) this.verifiedTail.inputProof = inputProof;
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
      if (inputProof.exitStatus === 0 && !inputProof.exitSignal) {
        observation = { activity: 'exited', reason: 'clean-exit', at: exit?.at ?? Date.now(), safeToAct: false };
      } else if (classified.activity === 'watching' || classified.activity === 'unknown') {
        observation = classified;
      } else if (
        exit &&
        pane.status === exit.status &&
        pane.signal === exit.signal &&
        ((inputProof.exitStatus ?? 0) > 0 || (inputProof.exitSignal ?? 0) > 0) &&
        ((pane.status !== undefined && pane.status > 0) || (pane.signal ?? 0) > 0)
      ) {
        if (!Number.isFinite(exit.at) || exit.at <= 0 || exit.at > Number.MAX_SAFE_INTEGER || exit.at > Date.now())
          return unknown('pane-unverified');
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
              // Keep the structured unfinished-turn proof alongside the watcher
              // crash proof. The controller's explicit stall policy chooses it.
              ...(childWork.activity === 'working' && childWork.reason === 'turn-running' && childWork.stallEvidenceKey
                ? {
                    stallEvidenceKey: childWork.stallEvidenceKey,
                    progressAt: childWork.progressAt ?? childWork.at,
                    stallRestartable: context.intentionalStopAt < (childWork.progressAt ?? childWork.at) - 2000,
                  }
                : {}),
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
    const nativePane =
      pane.dead &&
      /^%(?:0|[1-9]\d{0,9})$/.test(pane.paneId ?? '') &&
      Number.isSafeInteger(Number(pane.paneId?.slice(1))) &&
      Number.isSafeInteger(pane.panePid) &&
      /^[1-9]\d{0,9}$/.test(String(pane.panePid)) &&
      pane.panePid! > 0 &&
      (pane.status === undefined ||
        (Number.isSafeInteger(pane.status) && pane.status >= 0 && pane.status <= 255 && !(pane.signal! > 0))) &&
      matchesNativePaneSignal(pane.signal, pane.paneSignalToken) &&
      ((pane.status ?? 0) > 0 || (pane.signal ?? 0) > 0) &&
      Date.now() >= paneReadStartedAt &&
      Date.now() - paneReadStartedAt <= 15_000
        ? {
            paneId: pane.paneId!,
            panePid: pane.panePid!,
            status: pane.status,
            signal: pane.signal,
            paneSignalToken: pane.paneSignalToken,
            inputProvenance: inputProof,
          }
        : undefined;
    if (nativePane) observation.processProofKey = createHash('sha256').update(JSON.stringify(nativePane)).digest('hex');
    if (observation.activity === 'crashed' && !nativePane) observation.safeToAct = false;
    if (observation.stallRestartable === true) {
      if (!nativePane) delete observation.stallRestartable;
      else observation.stallObservedAt = paneReadStartedAt;
    }
    const now = Date.now();
    const scope = this.liveProofScope();
    if (
      !pane.dead &&
      /^%\d+$/.test(pane.paneId ?? '') &&
      Number.isSafeInteger(pane.panePid) &&
      pane.panePid! > 0 &&
      now >= paneReadStartedAt &&
      now - paneReadStartedAt <= 30_000
    ) {
      if (observation.processReady === true) observation.processReadyAt = paneReadStartedAt;
      this.livePaneProof = {
        paneId: pane.paneId!,
        panePid: pane.panePid!,
        at: paneReadStartedAt,
        conversationId: identity.conversationId,
        scope,
      };
    } else if (
      pane.dead &&
      this.livePaneProof &&
      this.livePaneProof.paneId === pane.paneId &&
      this.livePaneProof.panePid === pane.panePid &&
      this.livePaneProof.conversationId === identity.conversationId &&
      this.livePaneProof.scope === scope &&
      this.livePaneProof.at <= observation.at &&
      now >= this.livePaneProof.at &&
      now - this.livePaneProof.at <= 30_000
    ) {
      observation.liveProofAt = this.livePaneProof.at;
      this.latestLiveProofAt = this.livePaneProof.at;
    } else this.livePaneProof = undefined;
    if (
      (observation.activity === 'working' || observation.activity === 'crashed') &&
      observation.progressAt !== undefined &&
      Number.isFinite(observation.progressAt) &&
      observation.progressAt > 0
    ) {
      // Classification accepted every complete record and its lifecycle schema.
      // Only native events define progress: metadata and read latency do not.
      const events = identity.tail.split('\n').filter((line) => line.trim() && JSON.parse(line)?.type === 'event_msg');
      observation.progressEvidenceKey = `local:${createHash('sha256').update(events.join('\n')).digest('hex')}`;
      observation.progressLowerBound = observation.progressAt;
    }
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
        ...(nativePane ? { nativePane, processProofKey: observation.processProofKey } : {}),
        ...(observation.stallRestartable
          ? {
              stallEvidenceKey: observation.stallEvidenceKey,
              stallProgressAt: observation.progressAt ?? observation.at,
              stallProgressEvidenceKey: observation.progressEvidenceKey,
            }
          : {}),
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

  private remoteAuthority(
    conversationId: string,
    generation: number,
    isCurrent: import('./types.js').RecoveryActionAuthority
  ) {
    const expected = this.session.remoteRecoveryConfiguration();
    const inputProof = this.verifiedTail?.inputProof;
    const current = () =>
      !!inputProof &&
      this.session.isOwnedRemoteInputBrokerProofCurrent(inputProof) &&
      this.session.isRemoteRecoveryAuthorityCurrent(conversationId, generation, isCurrent, expected);
    return {
      check: async () => {
        if (!(await this.session.confirmRemoteRecoveryAuthority(conversationId, generation, isCurrent, expected)))
          return false;
        // The shared SSH slot and clock sampling can wait. Revalidate the local
        // issuer after those waits before the remote reader performs its own private checks.
        if (isCurrent.prepareEvidence && (await isCurrent.prepareEvidence()) !== true) return false;
        return current();
      },
      isCurrent: current,
      ...(isCurrent.getInputIssuer ? { getInputIssuer: () => isCurrent.getInputIssuer!() } : {}),
      ...(isCurrent.getActionDeadline ? { getActionDeadline: () => isCurrent.getActionDeadline!() } : {}),
      reserveInputBroker: (oldInc: string, newInc: string) =>
        this.session.reserveOwnedRemoteInputBroker(oldInc, newInc),
      commitInputBroker: (oldInc: string, newInc: string) => this.session.commitOwnedRemoteInputBroker(oldInc, newInc),
      rollbackInputBroker: (oldInc: string, newInc: string) =>
        this.session.rollbackOwnedRemoteInputBroker(oldInc, newInc),
    };
  }

  /** Immutable private witness plus pure scope, for one shared worker/issuer verification. */
  getLocalEvidenceSource(
    conversationId: string,
    generation: number
  ): import('./types.js').RecoveryEvidenceSource | undefined {
    const expected = this.verifiedTail;
    const context = this.session.getRecoveryContext();
    if (
      this.session.remote ||
      expected?.conversationId !== conversationId ||
      !expected.path ||
      !expected.witness ||
      !expected.inputProof?.fileWitness ||
      context.generation !== generation ||
      expected.config !== JSON.stringify(this.session.codexConfig) ||
      expected.env !== JSON.stringify(this.session.getEnvOverridesForPersist())
    )
      return undefined;
    const scope = () =>
      JSON.stringify([
        this.session.owner,
        this.session.workingDir,
        this.session.codexConfig,
        this.session.getEnvOverridesForPersist(),
        this.session.getRecoveryContext(),
        this.session.remote,
      ]);
    const snapshot = scope();
    const authority = this.session.getRecoveryInputAuthority(expected.inputProof);
    const leaf = expected.witness.paths.find((path) => path.path === expected.path && path.kind === 'file');
    if (!authority || !leaf || leaf.size === undefined || leaf.mtimeMs === undefined || leaf.ctimeMs === undefined)
      return undefined;
    authority.files = [
      ...(authority.files ?? []),
      {
        path: expected.path,
        dev: leaf.dev,
        ino: leaf.ino,
        size: leaf.size,
        mtimeMs: leaf.mtimeMs,
        ctimeMs: leaf.ctimeMs,
        hash: createHash('sha256').update(expected.tail).digest('hex'),
        maxBytes: 262_144,
      },
    ];
    authority.paths = expected.witness.paths.map((path) => ({ ...path }));
    return {
      sessionId: this.session.id,
      inputBroker: authority,
      files: authority.files,
      identity: {
        reason: 'verified',
        conversationId,
        path: expected.path,
        tail: expected.tail,
        tailTruncated: expected.tailTruncated,
        witness: expected.witness,
      },
      isCurrent: () =>
        !!this.session.getRecoveryInputAuthority(expected.inputProof!) &&
        this.verifiedTail === expected &&
        scope() === snapshot &&
        this.session.getRecoveryContext().generation === generation,
    };
  }

  /** Last bounded evidence check after asynchronous launch preparation; issuer and worker share one barrier. */
  async confirmLocalEvidence(
    conversationId: string,
    generation: number,
    otherSource?: import('./types.js').RecoveryEvidenceSource
  ): Promise<boolean> {
    const expected = this.verifiedTail?.inputProof;
    if (!expected) return false;
    const fresh = await this.session.inspectRecoveryInputProvenance(expected.brokerPid);
    if (
      !fresh ||
      fresh.incarnation !== expected.incarnation ||
      fresh.brokerPid !== expected.brokerPid ||
      fresh.childPid !== expected.childPid ||
      fresh.brokerStart !== expected.brokerStart ||
      fresh.childStart !== expected.childStart ||
      fresh.closed !== expected.closed ||
      fresh.exitStatus !== expected.exitStatus ||
      fresh.exitSignal !== expected.exitSignal ||
      fresh.rawGeneration !== expected.rawGeneration ||
      fresh.launchDigest !== expected.launchDigest ||
      fresh.homeDigest !== expected.homeDigest ||
      JSON.stringify(fresh.ownerCounters) !== JSON.stringify(expected.ownerCounters) ||
      !fresh.fileWitness
    )
      return false;
    if (this.verifiedTail) this.verifiedTail.inputProof = fresh;
    const source = this.getLocalEvidenceSource(conversationId, generation);
    if (
      !source ||
      !isRecoveryEvidenceSourceCurrent(source) ||
      (otherSource && !isRecoveryEvidenceSourceCurrent(otherSource))
    )
      return false;
    return (
      (await checkCodexIdentityWitnesses(
        [source.identity, ...(otherSource ? [otherSource.identity] : [])],
        [...(source.files ?? []), ...(otherSource?.files ?? [])]
      )) &&
      isRecoveryEvidenceSourceCurrent(source) &&
      (!otherSource || isRecoveryEvidenceSourceCurrent(otherSource))
    );
  }

  async act(
    flight: RecoveryFlight,
    isCurrent: import('./types.js').RecoveryActionAuthority = () => true
  ): Promise<'sent' | 'not-sent' | 'unknown'> {
    const previous = this.proof;
    if (
      !isCurrent() ||
      !previous ||
      previous.conversationId !== flight.conversationId ||
      (flight.reason === 'stalled' ? previous.stallEvidenceKey !== flight.key : previous.key !== flight.key)
    )
      return 'not-sent';
    const refuseChangedEvidence = (): 'not-sent' => {
      // No Session/SSH delivery method has been called on these paths.
      isCurrent.withdrawEvidence?.();
      return 'not-sent';
    };
    // Reads are repeated immediately before execution; a completed turn or new user input vetoes an old reservation.
    const current = await this.observe();
    // The turn key survives appended progress. A stall needs the same silence
    // baseline that the controller confirmed before its durable reservation.
    const currentProvesAction =
      flight.reason === 'stalled'
        ? current.stallRestartable === true &&
          current.stallEvidenceKey === flight.key &&
          previous.stallProgressAt !== undefined &&
          (previous.stallProgressEvidenceKey !== undefined
            ? flight.stallProgressEvidenceKey === previous.stallProgressEvidenceKey &&
              current.progressEvidenceKey === previous.stallProgressEvidenceKey &&
              flight.stallQuietPeriodMs !== undefined &&
              Number.isInteger(flight.stallQuietPeriodMs) &&
              flight.stallQuietPeriodMs >= 10_000 &&
              flight.stallQuietPeriodMs <= 3_600_000 &&
              current.progressAt !== undefined &&
              Number.isFinite(current.progressAt) &&
              Date.now() - current.progressAt >= flight.stallQuietPeriodMs
            : flight.stallProgressEvidenceKey === undefined &&
              current.progressEvidenceKey === undefined &&
              (flight.stallProgressAt === undefined || flight.stallProgressAt === previous.stallProgressAt) &&
              (current.progressAt ?? current.at) === previous.stallProgressAt)
        : current.safeToAct && current.evidenceKey === flight.key;
    if (
      flight.reason === 'stalled' &&
      previous.remotePane &&
      (JSON.stringify(this.proof?.remotePane) !== JSON.stringify(previous.remotePane) ||
        previous.processProofKey !== this.proof?.processProofKey)
    )
      return refuseChangedEvidence();
    if (
      flight.action === 'restart' &&
      !this.session.remote &&
      (!previous.nativePane || previous.processProofKey !== this.proof?.processProofKey)
    )
      return refuseChangedEvidence();
    if (!isCurrent()) return 'not-sent';
    if (!currentProvesAction || !this.proof || this.proof.generation !== previous.generation)
      return refuseChangedEvidence();
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
          async () =>
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
                inputBroker: await this.session.getOwnedRemoteInputBroker(),
                expectedInputProof: this.verifiedTail?.inputProof,
                owner: this.session.owner,
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
      const confirmEvidence: import('./types.js').RecoveryEvidenceGuard = async () => {
        const confirmed = await this.confirmLocalEvidence(flight.conversationId, generation);
        if (!confirmed) isCurrent.withdrawEvidence?.();
        return confirmed;
      };
      confirmEvidence.getEvidenceSource = () => this.getLocalEvidenceSource(flight.conversationId, generation);
      result =
        flight.action === 'restart'
          ? await this.session.deliverRecovery(
              flight,
              generation,
              isCurrent,
              CONTINUATION_PROMPT,
              confirmEvidence,
              previous.nativePane
            )
          : await this.session.deliverRecovery(flight, generation, isCurrent, CONTINUATION_PROMPT, confirmEvidence);
    }
    if (result === 'sent') this.persistSession();
    return result;
  }

  /** Final direct-SSH input guarded by the exact live pane, screen, rollout and current submission. */
  async deliverRemotePrompt(
    conversationId: string,
    generation: number,
    prompt: string,
    isCurrent: import('./types.js').RecoveryActionAuthority = () => true
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
            workingDir: remote.remotePath,
            codexHome: context.codexHome,
            resumeId: conversationId,
            submission: proof.submission,
            expected: proof.expected,
            prompt,
            inputBroker: proof.inputBroker,
          },
          authority
        ),
      isCurrent
    );
  }

  /** Explicit owner-request path only; automatic evaluation never calls this. */
  async restoreMissingRemote(
    isCurrent: import('./types.js').RecoveryActionAuthority = () => true
  ): Promise<'sent' | 'not-sent' | 'unknown'> {
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
      async () =>
        this.deps.restoreRemote!(
          this.session.remote!,
          {
            sessionId: this.session.id,
            resumeId: proof.conversationId,
            submission: context.submission,
            expectedIdentity: { conversationId: proof.conversationId, tailHash: proof.tailHash },
            codexConfig: { ...this.session.codexConfig!, resumeSessionId: proof.conversationId },
            codexHome: context.codexHome,
            inputBroker: await this.session.getOwnedRemoteInputBroker(),
            expectedInputProof: this.verifiedTail?.inputProof,
            owner: this.session.owner,
          },
          authority
        )
    );
    if (result === 'sent') this.persistSession();
    return result;
  }
}
