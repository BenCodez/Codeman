/** @fileoverview Same-owner attributed task observations and guarded delivery. */
import type { Session } from '../session.js';
import { CodexRecoveryAdapter } from '../recovery/codex-adapter.js';
import { resolveCodexIdentity } from '../recovery/codex-identity.js';
import { successfulCommands, latestProgressMarker } from './evidence.js';
import type { TaskObservation } from './controller.js';
export class CodexTaskAdapter {
  private readonly recovery: CodexRecoveryAdapter;
  constructor(
    private readonly session: Session,
    persist: () => void
  ) {
    this.recovery = new CodexRecoveryAdapter(session, persist);
  }
  async observe(): Promise<TaskObservation> {
    const observation = await this.recovery.observe();
    const context = this.session.getRecoveryContext();
    if (!observation.conversationId || ['unknown', 'blocked', 'paused'].includes(observation.activity))
      return { observation, commands: new Map() };
    const identity = await resolveCodexIdentity({
      sessionId: this.session.id,
      workingDir: this.session.workingDir,
      codexHome: context.codexHome,
      noDaemon: context.noDaemon,
      resumeId: observation.conversationId,
      submission: context.submission,
    });
    if (
      identity.reason !== 'verified' ||
      identity.conversationId !== observation.conversationId ||
      context.generation !== this.session.getRecoveryContext().generation
    )
      return { observation: { ...observation, activity: 'unknown', safeToAct: false }, commands: new Map() };
    return {
      observation,
      commands: successfulCommands(identity.tail ?? '', 0, Date.now()),
      marker: latestProgressMarker(identity.tail ?? '', 0, Date.now()),
    };
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
    const { observation: o } = await this.observe();
    if (
      !isCurrent() ||
      context.generation !== this.session.getRecoveryContext().generation ||
      o.conversationId !== conversationId ||
      !['completed', ...(key.startsWith(`${conversationId}:task-start:`) ? ['idle'] : [])].includes(o.activity) ||
      !o.processReady ||
      (!key.startsWith(`${conversationId}:task-start:`) && key !== `${conversationId}:task:${o.turnId}`)
    )
      return 'not-sent';
    return this.session.deliverRecovery(
      { key, conversationId, action: 'continue', startedAt: Date.now() },
      context.generation,
      isCurrent,
      prompt
    );
  }
}
