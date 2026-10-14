/** @fileoverview Same-owner attributed task observations and guarded delivery. */
import type { Session } from '../session.js';
import { CodexRecoveryAdapter, type CodexRecoveryAdapterDeps } from '../recovery/codex-adapter.js';
import { successfulCommands, latestProgressMarker } from './evidence.js';
import type { TaskObservation } from './controller.js';
import { validRemoteClock, remoteToLocal, remoteCompletionToLocal } from '../recovery/remote-clock.js';
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
    persist: () => void,
    deps?: CodexRecoveryAdapterDeps
  ) {
    this.recovery = new CodexRecoveryAdapter(session, persist, deps);
  }
  async observe(): Promise<TaskObservation> {
    this.continuationProof = undefined;
    const context = this.session.getRecoveryContext();
    const observation = await this.recovery.observe();
    if (!observation.conversationId || ['unknown', 'blocked', 'paused'].includes(observation.activity))
      return { observation, commands: new Map() };
    const tail = this.recovery.getVerifiedTail(observation.conversationId);
    if (tail === undefined || context.generation !== this.session.getRecoveryContext().generation)
      return { observation: { ...observation, activity: 'unknown', safeToAct: false }, commands: new Map() };
    const clock = this.recovery.getVerifiedRemoteClock(observation.conversationId);
    if (this.session.remote && !validRemoteClock(clock))
      return { observation: { ...observation, activity: 'unknown', safeToAct: false }, commands: new Map() };
    const now = clock?.remoteAfter ?? Date.now();
    const commands = successfulCommands(tail, 0, now);
    const marker = latestProgressMarker(tail, 0, now);
    if (clock) {
      for (const command of commands.values()) {
        command.startedAt = remoteToLocal(command.startedAt, clock);
        command.completedAt = remoteCompletionToLocal(command.completedAt, clock);
      }
      if (marker) {
        marker.latestAt = remoteCompletionToLocal(marker.at, clock);
        marker.at = remoteToLocal(marker.at, clock);
      }
    }
    return this.recordObservation(
      {
        observation,
        commands,
        marker,
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
    isCurrent: () => boolean
  ): Promise<'sent' | 'not-sent' | 'unknown'> {
    if (!observation.conversationId || !observation.evidenceKey) return 'not-sent';
    // Establish the recovery adapter's current generation-bound proof then let it revalidate again at dispatch.
    const current = await this.recovery.observe();
    if (!current.safeToAct || current.evidenceKey !== observation.evidenceKey) return 'not-sent';
    return this.recovery.act(
      {
        key: observation.evidenceKey,
        conversationId: observation.conversationId,
        action: observation.activity === 'crashed' ? 'restart' : 'continue',
        startedAt: Date.now(),
      },
      isCurrent
    );
  }
  async act(
    key: string,
    conversationId: string,
    prompt: string,
    isCurrent: () => boolean
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
    if (this.session.remote) {
      return this.recovery.deliverRemotePrompt(conversationId, context.generation, prompt, isCurrent);
    }
    return this.session.deliverRecovery(
      { key, conversationId, action: 'continue', startedAt: Date.now() },
      context.generation,
      isCurrent,
      prompt,
      () => this.recovery.confirmLocalEvidence(conversationId, context.generation)
    );
  }
}
