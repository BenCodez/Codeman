/** @fileoverview Codex-specific recovery authority. Remote transports and foreign panes are never mutated. */
import { createHash } from 'node:crypto';
import type { Session } from '../session.js';
import type { RecoveryPaneIdentity } from '../mux-interface.js';
import { matchesNativePaneSignal } from './native-pane-signal.js';
import { clampExternalCliConfigsForOwner, clampEnvOverridesForOwner } from '../session-env-clamp.js';
import { resolveCodexIdentity, type CodexIdentityWitness } from './codex-identity.js';
import { checkCodexIdentityWitnesses } from './codex-witness-check.js';
import type { CodexBrokerProof } from './codex-input-broker.js';
import { currentLocalCodexHome } from './codex-home.js';
import { classifyCodexTail, hasEmptyCodexComposer } from './codex-classifier.js';
import {
  CONTINUATION_PROMPT,
  isRecoveryEvidenceSourceCurrent,
  type RecoveryFlight,
  type RecoveryObservation,
} from './types.js';

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
    ]);
  }

  /** Live evidence is private, process-specific, short-lived and never restored from disk. */
  hasLivePaneProof(at: number): boolean {
    const elapsed = Date.now() - at;
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
    nativePane?: RecoveryPaneIdentity;
    processProofKey?: string;
  };
  private verifiedTail?: {
    conversationId: string;
    tail: string;
    tailTruncated?: boolean;
    path?: string;
    witness?: CodexIdentityWitness;
    config: string;
    env: string;
    inputProof?: CodexBrokerProof;
  };

  constructor(
    private readonly session: Session,
    private readonly persistSession: () => void
  ) {}

  async observe(): Promise<RecoveryObservation> {
    this.latestLiveProofAt = undefined;
    const session = this.session;
    const context = session.getRecoveryContext();
    const unknown = (reason: RecoveryObservation['reason']): RecoveryObservation => {
      this.livePaneProof = undefined;
      return { activity: 'unknown', reason, at: Date.now(), safeToAct: false };
    };
    this.proof = undefined;
    this.verifiedTail = undefined;
    if (session.remote || session.docker) return unknown('unsupported-location');
    if (!context.managed) return unknown('unowned-session');
    if (!context.noDaemon) return unknown('managed-daemon');
    if (context.switchPending || session.paneLifecycleInFlight) return unknown('identity-unverified');
    // A launch seed cannot witness an untracked direct-TUI /resume. Automatic
    // effects need an exact owner submission and its current history identity.
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
    if (session.getRecoveryContext().generation !== context.generation) return unknown('user-input');
    const finalConfig = await clampExternalCliConfigsForOwner(session.owner, { codexConfig: session.codexConfig });
    const finalEnv = await clampEnvOverridesForOwner(session.owner, env);
    if (
      JSON.stringify(finalConfig.codexConfig) !== JSON.stringify(session.codexConfig) ||
      JSON.stringify(finalEnv) !== JSON.stringify(env)
    )
      return { ...unknown('approval-required'), activity: 'blocked' };
    if (session.getRecoveryContext().generation !== context.generation) return unknown('user-input');
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
      if (inputProof.exitStatus === 0 && !inputProof.exitSignal) {
        observation = { activity: 'exited', reason: 'clean-exit', at: exit?.at ?? Date.now(), safeToAct: false };
      } else if (
        exit &&
        pane.status === exit.status &&
        pane.signal === exit.signal &&
        ((inputProof.exitStatus ?? 0) > 0 || (inputProof.exitSignal ?? 0) > 0) &&
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

    // A bounded suffix can hide an earlier still-live child, including after the parent process exits.
    observation.safeToAct = observation.safeToAct && identity.tailTruncated === false;
    if (observation.safeToAct && observation.evidenceKey) {
      this.proof = {
        key: observation.evidenceKey,
        generation: context.generation,
        conversationId: identity.conversationId,
        ...(nativePane ? { nativePane, processProofKey: observation.processProofKey } : {}),
      };
    }
    return observation;
  }

  /** Tail from this adapter's latest exact identity observation; never API-bound. */
  getVerifiedTail(conversationId: string): string | undefined {
    return this.verifiedTail?.conversationId === conversationId ? this.verifiedTail.tail : undefined;
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
    if (!isCurrent() || !previous || previous.key !== flight.key || previous.conversationId !== flight.conversationId)
      return 'not-sent';
    // Reads are repeated immediately before execution; a completed turn or new user input vetoes an old reservation.
    const current = await this.observe();
    if (
      !isCurrent() ||
      !current.safeToAct ||
      current.evidenceKey !== flight.key ||
      !this.proof ||
      this.proof.generation !== previous.generation ||
      (flight.action === 'restart' && (!previous.nativePane || previous.processProofKey !== this.proof.processProofKey))
    )
      return 'not-sent';
    const generation = this.proof.generation;
    const confirmEvidence: import('./types.js').RecoveryEvidenceGuard = () =>
      this.confirmLocalEvidence(flight.conversationId, generation);
    confirmEvidence.getEvidenceSource = () => this.getLocalEvidenceSource(flight.conversationId, generation);
    const result =
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
    if (result === 'sent') this.persistSession();
    return result;
  }
}
