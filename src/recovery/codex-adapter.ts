/** @fileoverview Codex-specific recovery authority. Remote transports and foreign panes are never mutated. */
import { createHash } from 'node:crypto';
import { openSync, closeSync, fstatSync, lstatSync, readSync, constants as fsConstants } from 'node:fs';
import type { Session } from '../session.js';
import { clampExternalCliConfigsForOwner, clampEnvOverridesForOwner } from '../session-env-clamp.js';
import { resolveCodexIdentity, type CodexIdentityWitness } from './codex-identity.js';
import { currentLocalCodexHome } from './codex-home.js';
import { classifyCodexTail, hasEmptyCodexComposer } from './codex-classifier.js';
import { CONTINUATION_PROMPT, type RecoveryFlight, type RecoveryObservation } from './types.js';

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
  private proof?: { key: string; generation: number; conversationId: string };
  private verifiedTail?: {
    conversationId: string;
    tail: string;
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
    if (
      !isCurrent() ||
      !current.safeToAct ||
      current.evidenceKey !== flight.key ||
      !this.proof ||
      this.proof.generation !== previous.generation
    )
      return 'not-sent';
    const generation = this.proof.generation;
    const result = await this.session.deliverRecovery(flight, generation, isCurrent, CONTINUATION_PROMPT, () =>
      this.confirmLocalEvidence(flight.conversationId, generation)
    );
    if (result === 'sent') this.persistSession();
    return result;
  }
}
