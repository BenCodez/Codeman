/** @fileoverview Same-owner attributed task observations and guarded delivery. */
import type { Session } from '../session.js';
import type { RecoveryActionAuthority, RecoveryEvidenceGuard } from '../recovery/types.js';
import { CodexRecoveryAdapter } from '../recovery/codex-adapter.js';
import { successfulCommands, latestProgressMarker } from './evidence.js';
import type { TaskObservation } from './controller.js';
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
