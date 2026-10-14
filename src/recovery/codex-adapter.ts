/** @fileoverview Codex-specific recovery authority. Remote transports and foreign panes are never mutated. */
import { createHash } from 'node:crypto';
import type { Session } from '../session.js';
import type { RecoveryPaneIdentity } from '../mux-interface.js';
import { matchesNativePaneSignal } from './native-pane-signal.js';
import { clampExternalCliConfigsForOwner, clampEnvOverridesForOwner } from '../session-env-clamp.js';
import { resolveCodexIdentity, confirmCodexIdentityWitness, type CodexIdentityWitness } from './codex-identity.js';
import { currentLocalCodexHome } from './codex-home.js';
import { classifyCodexTail, hasEmptyCodexComposer } from './codex-classifier.js';
import { CONTINUATION_PROMPT, type RecoveryFlight, type RecoveryObservation } from './types.js';

export class CodexRecoveryAdapter {
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
  };

  constructor(
    private readonly session: Session,
    private readonly persistSession: () => void
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
    this.verifiedTail = undefined;
    if (session.remote || session.docker) return unknown('unsupported-location');
    if (!context.managed) return unknown('unowned-session');
    if (!context.noDaemon) return unknown('managed-daemon');
    if (context.switchPending || session.paneLifecycleInFlight) return unknown('identity-unverified');
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
    if (session.codexConfig?.resumeSessionId !== identity.conversationId) {
      session.pinRecoveryConversation(identity.conversationId);
      this.persistSession();
    }
    let observation: RecoveryObservation;
    if (pane.dead) {
      const exit = session.paneExit;
      if (pane.status === 0 && !pane.signal) {
        observation = { activity: 'exited', reason: 'clean-exit', at: exit?.at ?? Date.now(), safeToAct: false };
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
    return (
      confirmCodexIdentityWitness({
        reason: 'verified',
        conversationId,
        path: expected.path,
        tail: expected.tail,
        tailTruncated: expected.tailTruncated,
        witness: expected.witness,
      }) && this.session.getRecoveryContext().generation === generation
    );
  }

  async act(flight: RecoveryFlight, isCurrent: () => boolean = () => true): Promise<'sent' | 'not-sent' | 'unknown'> {
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
    const confirmEvidence = () => this.confirmLocalEvidence(flight.conversationId, generation);
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
