/** @fileoverview Exact task wire serialization and the broker's UTF8 admission bound. */
import type { SupervisionTaskState } from '../types/task.js';

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
