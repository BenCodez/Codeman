/** @fileoverview Same-owner attributed task observations and guarded delivery. */
import type { Session } from '../session.js';
import {
  isRecoveryEvidenceSourceCurrent,
  type RecoveryActionAuthority,
  type RecoveryEvidenceGuard,
} from '../recovery/types.js';
import { CodexRecoveryAdapter } from '../recovery/codex-adapter.js';
import { successfulCommands, latestProgressMarker } from './evidence.js';
import type { TaskObservation } from './controller.js';
import { taskPromptFrameFits } from './prompt.js';
import { clampRecoveryLaunchForOwner } from '../session-env-clamp.js';
import { currentLocalCodexHome } from '../recovery/codex-home.js';
export class CodexTaskAdapter {
  private readonly recovery: CodexRecoveryAdapter;
  private continuationProof?: {
    generation: number;
    conversationId: string;
    turnId: string;
    submissionKey?: string;
    markerKey?: string;
  };
  constructor(
    private readonly session: Session,
    persist: () => void
  ) {
    this.recovery = new CodexRecoveryAdapter(session, persist);
  }
  async observe(): Promise<TaskObservation> {
    this.continuationProof = undefined;
    const context = this.session.getRecoveryContext();
    const observation = await this.recovery.observe();
    if (context.generation !== this.session.getRecoveryContext().generation)
      return {
        observation: {
          ...observation,
          conversationId: undefined,
          reason: 'identity-unverified',
          activity: 'unknown',
          safeToAct: false,
        },
        commands: new Map(),
      };
    if (!observation.conversationId || ['unknown', 'blocked', 'paused'].includes(observation.activity))
      return { observation, commands: new Map() };
    const tail = this.recovery.getVerifiedTail(observation.conversationId);
    if (tail === undefined)
      return {
        observation: {
          ...observation,
          conversationId: undefined,
          reason: 'identity-unverified',
          activity: 'unknown',
          safeToAct: false,
        },
        commands: new Map(),
      };
    const now = Date.now();
    return this.recordObservation(
      {
        observation,
        commands: successfulCommands(tail, 0, now),
        marker: latestProgressMarker(tail, 0, now),
      },
      context.generation
    );
  }
  private recordObservation(result: TaskObservation, generation: number): TaskObservation {
    const { observation } = result;
    if (observation.activity === 'completed' && observation.conversationId && observation.turnId) {
      this.continuationProof = {
        generation,
        conversationId: observation.conversationId,
        turnId: observation.turnId,
        submissionKey: observation.submissionKey,
        markerKey: result.marker?.key,
      };
    }
    return result;
  }
  /** Read-only framing admission using the same current private evidence as delivery. */
  async admitPrompt(prompt: string, authority: RecoveryActionAuthority, expected?: TaskObservation): Promise<boolean> {
    const originalProof = this.continuationProof;
    let observed: TaskObservation;
    try {
      observed = await this.observe();
    } finally {
      this.continuationProof = originalProof;
    }
    const { observation, marker } = observed;
    const context = this.session.getRecoveryContext();
    if (
      !observation.conversationId ||
      authority() !== true ||
      ['unknown', 'blocked', 'paused', 'exited'].includes(observation.activity) ||
      (expected &&
        ['conversationId', 'activity', 'turnId', 'submissionKey', 'evidenceKey'].some(
          (key) =>
            observation[key as keyof typeof observation] !== expected.observation[key as keyof typeof observation]
        )) ||
      (expected && marker?.key !== expected.marker?.key)
    )
      return false;
    const source = this.recovery.getLocalEvidenceSource(observation.conversationId, context.generation);
    if (
      !source?.inputBroker ||
      !source.identity.witness ||
      source.identity.tailTruncated !== false ||
      !isRecoveryEvidenceSourceCurrent(source)
    )
      return false;
    const snapshot = JSON.stringify([
      this.session.owner,
      this.session.codexConfig,
      this.session.getEnvOverridesForPersist(),
      context,
    ]);
    const current = () =>
      authority() === true &&
      isRecoveryEvidenceSourceCurrent(source) &&
      snapshot ===
        JSON.stringify([
          this.session.owner,
          this.session.codexConfig,
          this.session.getEnvOverridesForPersist(),
          this.session.getRecoveryContext(),
        ]);
    const env =
      context.codexHome !== currentLocalCodexHome()
        ? { ...this.session.getEnvOverridesForPersist(), CODEX_HOME: context.codexHome! }
        : this.session.getEnvOverridesForPersist();
    const grant = await clampRecoveryLaunchForOwner(this.session.owner, { codexConfig: this.session.codexConfig }, env);
    if (
      !current() ||
      !grant.isCurrent() ||
      JSON.stringify(grant.configs.codexConfig) !== JSON.stringify(this.session.codexConfig) ||
      JSON.stringify(grant.env) !== JSON.stringify(env)
    )
      return false;
    const grantFile = grant.getFileWitness?.() ?? grant.fileWitness;
    const files = [...(source.files ?? []), ...(grantFile ? [grantFile] : [])];
    if (authority.prepareEvidence && (await authority.prepareEvidence({ ...source, files })) !== true) return false;
    if (!current() || !grant.isCurrent()) return false;
    const issuer = authority.getInputIssuer?.();
    if (issuer instanceof Promise || (issuer && typeof (issuer as unknown as { then?: unknown }).then === 'function')) {
      void Promise.resolve(issuer).catch(() => {});
      return false;
    }
    if (authority.getInputIssuer && (!issuer || issuer.sessionId === this.session.id)) return false;
    return (
      taskPromptFrameFits(prompt, {
        sessionId: this.session.id,
        incarnation: source.inputBroker.incarnation,
        conversationId: observation.conversationId,
        expectedOwners: source.inputBroker.proof.ownerCounters,
        privateFiles: [...files, ...(issuer?.files ?? [])],
        privatePaths: [...source.identity.witness.paths, ...(issuer?.paths ?? [])],
        issuer,
      }) && current()
    );
  }
  async recover(
    observation: import('../recovery/types.js').RecoveryObservation,
    isCurrent: RecoveryActionAuthority
  ): Promise<'sent' | 'not-sent' | 'unknown'> {
    if (!observation.conversationId || !observation.evidenceKey) return 'not-sent';
    // Establish the recovery adapter's current generation-bound proof then let it revalidate again at dispatch.
    const current = await this.recovery.observe();
    if (
      !current.safeToAct ||
      current.evidenceKey !== observation.evidenceKey ||
      (observation.activity === 'crashed' &&
        (!Number.isFinite(observation.liveProofAt) ||
          current.liveProofAt !== observation.liveProofAt ||
          !this.recovery.hasLivePaneProof(observation.liveProofAt!)))
    )
      return 'not-sent';
    const canDispatch: RecoveryActionAuthority = () =>
      isCurrent() && (observation.activity !== 'crashed' || this.recovery.hasLivePaneProof(observation.liveProofAt!));
    if (isCurrent.prepareEvidence) canDispatch.prepareEvidence = (source) => isCurrent.prepareEvidence!(source);
    if (isCurrent.getInputIssuer)
      canDispatch.getInputIssuer = () => (canDispatch() ? isCurrent.getInputIssuer!() : undefined);
    if (isCurrent.getActionDeadline) canDispatch.getActionDeadline = () => isCurrent.getActionDeadline!();
    return this.recovery.act(
      {
        key: observation.evidenceKey,
        conversationId: observation.conversationId,
        action: observation.activity === 'crashed' ? 'restart' : 'continue',
        startedAt: Date.now(),
      },
      canDispatch
    );
  }
  async act(
    key: string,
    conversationId: string,
    prompt: string,
    isCurrent: RecoveryActionAuthority
  ): Promise<'sent' | 'not-sent' | 'unknown'> {
    const context = this.session.getRecoveryContext();
    const proof = this.continuationProof;
    const kickoff = key.startsWith(`${conversationId}:task-start:`);
    const { observation: o, marker } = await this.observe();
    if (
      !isCurrent() ||
      context.generation !== this.session.getRecoveryContext().generation ||
      o.conversationId !== conversationId ||
      !['completed', ...(kickoff ? ['idle'] : [])].includes(o.activity) ||
      !o.processReady ||
      (!kickoff &&
        (!proof ||
          proof.generation !== context.generation ||
          proof.conversationId !== conversationId ||
          proof.turnId !== o.turnId ||
          proof.submissionKey !== o.submissionKey ||
          proof.markerKey !== marker?.key ||
          key !== `${conversationId}:task:${o.turnId}`))
    )
      return 'not-sent';
    const confirmEvidence: RecoveryEvidenceGuard = () =>
      this.recovery.confirmLocalEvidence(conversationId, context.generation);
    confirmEvidence.getEvidenceSource = () => this.recovery.getLocalEvidenceSource(conversationId, context.generation);
    return this.session.deliverRecovery(
      { key, conversationId, action: 'continue', startedAt: Date.now() },
      context.generation,
      isCurrent,
      prompt,
      confirmEvidence
    );
  }
}
