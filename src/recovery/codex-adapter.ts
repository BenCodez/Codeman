/** @fileoverview Codex-specific recovery authority. Remote transports and foreign panes are never mutated. */
import type { Session } from '../session.js';
import { clampExternalCliConfigsForOwner, clampEnvOverridesForOwner } from '../session-env-clamp.js';
import { resolveCodexIdentity } from './codex-identity.js';
import { classifyCodexTail, hasEmptyCodexComposer } from './codex-classifier.js';
import type { RecoveryFlight, RecoveryObservation } from './types.js';

export class CodexRecoveryAdapter {
  private proof?: { key: string; generation: number; conversationId: string };

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
    if (session.remote || session.docker) return unknown('unsupported-location');
    if (!context.managed) return unknown('unowned-session');
    if (!context.noDaemon) return unknown('managed-daemon');
    if (context.switchPending || session.paneLifecycleInFlight) return unknown('identity-unverified');
    // Re-check the owner's current grant before either continuing or relaunching a privilege-bearing pane.
    const clamped = await clampExternalCliConfigsForOwner(session.owner, { codexConfig: session.codexConfig });
    // Include the active home explicitly; the path participates in the current grant check.
    const persistedEnv = session.getEnvOverridesForPersist();
    const env = context.codexHome ? { ...persistedEnv, CODEX_HOME: context.codexHome } : persistedEnv;
    const safeEnv = await clampEnvOverridesForOwner(session.owner, env);
    if (
      JSON.stringify(clamped.codexConfig) !== JSON.stringify(session.codexConfig) ||
      JSON.stringify(env) !== JSON.stringify(safeEnv)
    ) {
      return { ...unknown('approval-required'), activity: 'blocked' };
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
        // A confirmed parent exit does not establish that its spawned children have finished.
        const childWork = classifyCodexTail(identity.tail, {
          conversationId: identity.conversationId,
          now: Date.now(),
          screen: '',
          busy: false,
          watching: !!session.watching,
          tailTruncated: identity.tailTruncated,
          lastIntentionalStopAt: context.intentionalStopAt,
        });
        observation =
          childWork.reason === 'background-work' || childWork.activity === 'unknown'
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
    // A bounded suffix can hide an earlier still-live child, including after the parent process exits.
    observation.safeToAct = observation.safeToAct && identity.tailTruncated === false;
    if (observation.safeToAct && observation.evidenceKey) {
      this.proof = {
        key: observation.evidenceKey,
        generation: context.generation,
        conversationId: identity.conversationId,
      };
    }
    return observation;
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
      this.proof.generation !== previous.generation
    )
      return 'not-sent';
    const result = await this.session.deliverRecovery(flight, this.proof.generation, isCurrent);
    if (result === 'sent') this.persistSession();
    return result;
  }
}
