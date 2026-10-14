/** Recognizable invalid task reports retain bounded submission attribution and never look absent. */
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { latestProgressMarker } from '../src/supervision/evidence.js';

const now = 10_000;
const line = (at: number, payload: unknown) =>
  JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload });
const user = line(now - 2, { type: 'user_message', message: 'Authorized objective' });
const submissionKey = createHash('sha256').update(user).digest('hex');
const report = (message: string) =>
  line(now - 1, { type: 'agent_message', message: 'CODEMAN_TASK_PROGRESS ' + message });

it.each([
  { name: 'oversized', row: report('x'.repeat(16_001)) + '\n', uncertain: false },
  { name: 'malformed payload', row: report('{broken') + '\n', uncertain: false },
  { name: 'unterminated complete frame', row: report('{"outcome":"unfinished"}'), uncertain: true },
  { name: 'truncated frame', row: report('{"outcome":"unfinished"}').slice(0, -5), uncertain: true },
  { name: 'malformed recognized frame', row: '{bad CODEMAN_TASK_PROGRESS {broken\n', uncertain: true },
  {
    name: 'untrusted timestamp',
    row:
      JSON.stringify({
        timestamp: 'bad',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'CODEMAN_TASK_PROGRESS {"outcome":"unfinished"}' },
      }) + '\n',
    uncertain: true,
  },
])('retains $name as attributed unknown evidence', ({ row, uncertain }) => {
  const marker = latestProgressMarker(user + '\n' + row, 0, now);
  expect(marker).toMatchObject({ submissionKey, progress: null });
  expect(marker?.key).toMatch(/^progress:[a-f0-9]{64}$/);
  expect(!!marker?.uncertain).toBe(uncertain);
});

it('retains uncertainty after a recognized report when a later frame is incomplete', () => {
  const marker = latestProgressMarker(user + '\n' + report('{"outcome":"unfinished"}') + '\n{"type":', 0, now);
  expect(marker).toMatchObject({ submissionKey, progress: null, uncertain: true });
});

it('preserves a valid complete report and ignores ordinary text without a task marker', () => {
  expect(latestProgressMarker(user + '\n' + report('{"outcome":"unfinished"}') + '\n', 0, now)).toMatchObject({
    submissionKey,
    progress: { outcome: 'unfinished' },
  });
  expect(latestProgressMarker(user + '\nordinary truncated text', 0, now)).toBeUndefined();
});

it('does not carry an earlier malformed report into a later structured user submission', () => {
  const next = line(now, { type: 'user_message', message: 'New authorized objective' });
  expect(latestProgressMarker(user + '\n' + report('x'.repeat(16_001)) + '\n' + next + '\n', 0, now)).toBeUndefined();
});

it('keeps the existing scan byte limit without treating an oversized tail as actionable evidence', () => {
  expect(latestProgressMarker(user + '\n' + report('x'.repeat(262_144)) + '\n', 0, now)).toBeUndefined();
});
