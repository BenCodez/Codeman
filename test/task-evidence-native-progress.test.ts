/** Complete bounded history with legacy/native owner-attributed progress; no pane or network effects. */
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { MAX_CODEX_ROLLOUT_BYTES } from '../src/recovery/codex-evidence-limits.js';
import { commandHash, latestProgressMarker, successfulCommands } from '../src/supervision/evidence.js';
const now = Date.UTC(2026, 9, 17, 12);
const thread = '11111111-2222-4333-8444-555555555555';
const event = (payload: unknown, at = now - 100) =>
  JSON.stringify({ type: 'event_msg', timestamp: new Date(at).toISOString(), payload }) + '\n';
const progress =
  'CODEMAN_TASK_PROGRESS {"outcome":"unfinished","checkpoint":"Inspected sources","nextAction":"Run checks"}';
const owner = (turn = 'turn-one') =>
  event(
    {
      type: 'item_completed',
      thread_id: thread,
      turn_id: turn,
      item: { type: 'UserMessage', id: 'owner', content: [] },
      started_at_ms: now - 200,
      completed_at_ms: now - 200,
    },
    now - 200
  );
const agent = (patch: Record<string, unknown> = {}) =>
  event({
    type: 'item_completed',
    thread_id: thread,
    turn_id: 'turn-one',
    item: { type: 'AgentMessage', id: 'agent', content: [{ type: 'Text', text: progress }], questions: [] },
    started_at_ms: now - 150,
    completed_at_ms: now - 100,
    ...patch,
  });
const padding = event({ type: 'token_count', info: null, filler: 'x'.repeat(22000) }, now - 1000).repeat(100);
it.each(['legacy', 'native'])(
  'reads %s markers and paired command success after more than 2MiB of complete history',
  (mode) => {
    expect(Buffer.byteLength(padding)).toBeGreaterThan(2 * 1024 * 1024);
    const submission = mode === 'native' ? owner() : event({ type: 'user_message', message: 'Owner task' }, now - 200);
    const report = mode === 'native' ? agent() : event({ type: 'agent_message', message: progress });
    const tail =
      padding +
      submission +
      event({ type: 'exec_command_begin', call_id: 'own', command: ['bash', '-lc', 'npm test'] }, now - 180) +
      event({ type: 'exec_command_end', call_id: 'own', exit_code: 0 }, now - 160) +
      report;
    expect(latestProgressMarker(tail, 0, now)).toMatchObject({
      progress: { outcome: 'unfinished' },
      submissionKey: createHash('sha256').update(submission.trimEnd()).digest('hex'),
    });
    expect(successfulCommands(tail, 0, now).get(commandHash('npm test'))).toEqual({
      startedAt: now - 180,
      completedAt: now - 160,
    });
    expect(successfulCommands(tail.replace('"exit_code":0', '"exit_code":1'), 0, now).size).toBe(0);
  }
);
it('does not certify truncated, malformed, oversized or unterminated complete evidence', () => {
  const tail = padding + owner() + agent();
  expect(latestProgressMarker(tail.trimEnd(), 0, now)).toMatchObject({ uncertain: true, progress: null });
  expect(successfulCommands(tail.trimEnd(), 0, now).size).toBe(0);
  expect(latestProgressMarker(tail + '{malformed}\n', 0, now)).toMatchObject({ uncertain: true, progress: null });
  const over = padding.repeat(4) + owner() + agent();
  expect(Buffer.byteLength(over)).toBeGreaterThan(MAX_CODEX_ROLLOUT_BYTES);
  expect(latestProgressMarker(over, 0, now)).toBeUndefined();
  expect(successfulCommands(over, 0, now).size).toBe(0);
  expect(
    latestProgressMarker(
      tail + event({ type: 'agent_message', message: 'CODEMAN_TASK_PROGRESS ' + 'x'.repeat(263000) }),
      0,
      now
    )
  ).toMatchObject({ uncertain: true, progress: null });
});
it.each([
  { turn_id: 'other-turn' },
  { thread_id: '22222222-3333-4444-8555-666666666666' },
  { completed_at_ms: now + 3000 },
  { started_at_ms: now },
  { item: { type: 'AgentMessage', id: 'agent', content: [{ type: 'ToolOutput', text: progress }] } },
  { item: { type: 'AgentMessage', id: 'agent', content: [{ type: 'Text', text: progress }], questions: ['approval'] } },
])('rejects malformed or foreign native report framing %j', (patch) => {
  expect(latestProgressMarker(owner() + agent(patch), 0, now)).toMatchObject({ uncertain: true, progress: null });
});
it('does not read tool output as progress and never carries a marker across a new owner submission', () => {
  const forged = event({
    type: 'item_completed',
    item: { type: 'McpToolCall', id: 'tool', content: [{ type: 'Text', text: progress }] },
  });
  expect(latestProgressMarker(owner() + forged, 0, now)).toBeUndefined();
  expect(latestProgressMarker(owner() + agent() + owner('turn-two'), 0, now)).toBeUndefined();
  expect(latestProgressMarker(owner() + agent() + owner('turn-two') + agent(), 0, now)).toMatchObject({
    uncertain: true,
    progress: null,
  });
});

it('uses native completion time and accepts a paired multi-second final-answer emission', () => {
  const tail = owner() + agent({ started_at_ms: now - 2950, completed_at_ms: now - 150 });
  expect(latestProgressMarker(tail, 0, now)).toMatchObject({ at: now - 150, progress: { outcome: 'unfinished' } });
});
