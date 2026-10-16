/** @fileoverview Exact task wire serialization and the broker's UTF8 admission bound. */
import type { SupervisionTaskState } from '../types/task.js';
import type { BrokerAuthority, CodexBrokerProof } from '../recovery/codex-input-broker.js';
import type { CodexIdentityWitness } from '../recovery/codex-identity.js';
import type { PrivateFileWitness } from '../recovery/private-file-witness.js';

export type TaskPromptState = Pick<SupervisionTaskState, 'objective' | 'criteria' | 'checkpoint' | 'nextAction'>;

export function formatTaskPrompt(state: TaskPromptState): string {
  return `Work on the authorized objective: ${state.objective}\nLast verified checkpoint: ${state.checkpoint}\nNext action: ${state.nextAction}\nAcceptance criteria: ${JSON.stringify(state.criteria.map((c) => ({ id: c.id, description: c.description, kind: c.kind, command: c.command, verified: c.verified })))}\nInspect recent actions before proceeding. Do not repeat completed external actions or destructive operations. Stop for approval, authentication, usage limits, completion or unknown evidence. Report progress as one structured agent message: CODEMAN_TASK_PROGRESS followed by a JSON object with outcome (unfinished, blocked, unknown, completed), checkpoint, nextAction, and optional verifiedCriteria array. Command criteria require exact command exit0 evidence; manual criteria require owner verification. Do not claim successful checks without verified evidence.`
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

export function taskPromptFits(state: TaskPromptState): boolean {
  // Count the actual wire text, including JSON escaping and instructions, not field lengths.
  const prompt = formatTaskPrompt(state);
  const bytes = Buffer.from(prompt, 'utf8');
  return bytes.length <= 65_536 && bytes.toString('utf8') === prompt;
}

export interface TaskFrameEvidence {
  sessionId: string;
  incarnation: string;
  conversationId: string;
  expectedOwners: CodexBrokerProof['ownerCounters'];
  privateFiles: readonly PrivateFileWitness[];
  privatePaths: CodexIdentityWitness['paths'];
  issuer?: BrokerAuthority;
}

/** Pure upper bound for the broker's double-base64 frame, without allocating a reservation. */
export function taskPromptFrameFits(prompt: string, evidence: TaskFrameEvidence): boolean {
  try {
    const bytes = Buffer.from(prompt, 'utf8');
    if (bytes.length > 65_536 || bytes.toString('utf8') !== prompt || evidence.privatePaths.length > 2048) return false;
    const files = new Map<string, PrivateFileWitness>();
    for (const file of evidence.privateFiles) {
      const previous = files.get(file.path);
      if (
        previous &&
        ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'hash', 'maxBytes'].some(
          (key) => previous[key as keyof PrivateFileWitness] !== file[key as keyof PrivateFileWitness]
        )
      )
        return false;
      files.set(file.path, file);
    }
    if (files.size > 8) return false;
    // These fields are the broker.frame protocol. The real-frame regression pins
    // every key and the limit; maximum-width mutable integers leave room for the
    // counter/deadline advancing after this read-only preview.
    const packet = {
      version: 1,
      sessionId: evidence.sessionId,
      incarnation: evidence.incarnation,
      channel: 'auto',
      counter: Number.MAX_SAFE_INTEGER,
      nonce: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      conversationId: evidence.conversationId,
      expectedOwners: evidence.expectedOwners,
      monotonicDeadline: Number.MAX_SAFE_INTEGER,
      issuer: evidence.issuer ?? null,
      privateFiles: [...files.values()],
      privatePaths: evidence.privatePaths,
      missingPaths: [],
      data: bytes.toString('base64'),
    };
    return Buffer.byteLength(Buffer.from(JSON.stringify(packet)).toString('base64')) + 84 <= 122_880;
  } catch {
    return false;
  }
}
