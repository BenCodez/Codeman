/** A malformed envelope cannot preserve an older command success or completion report. */
import { describe, expect, it } from 'vitest';
import { successfulCommands, commandHash, latestProgressMarker } from '../src/supervision/evidence.js';

const now = Date.UTC(2026, 9, 13, 12);
const event = (payload: unknown, age: number) =>
  JSON.stringify({ timestamp: new Date(now - age).toISOString(), type: 'event_msg', payload }) + '\n';
const verified =
  event({ type: 'exec_command_begin', call_id: 'owned', command: ['bash', '-lc', 'npm test'] }, 3000) +
  event({ type: 'exec_command_end', call_id: 'owned', exit_code: 0 }, 2000) +
  event(
    { type: 'agent_message', message: 'CODEMAN_TASK_PROGRESS {"outcome":"completed","verifiedCriteria":["tests"]}' },
    1000
  );

describe('task evidence envelope boundaries', () => {
  it.each([
    null,
    [],
    42,
    true,
    'text',
    {},
    { type: 42, payload: {} },
    { type: '', payload: {} },
    { type: 'response_item', payload: null },
    { type: 'unsupported_variant', payload: {} },
    { type: 'event_msg', payload: [] },
    { type: 'event_msg', payload: {} },
    { type: 'event_msg', payload: { type: '' } },
    { type: 'event_msg', timestamp: 1, payload: { type: 'token_count' } },
  ])('invalidates earlier paired execution and completion evidence after %j', (record) => {
    const tail = verified + JSON.stringify(record) + '\n';
    expect(successfulCommands(tail, now - 5000, now).size).toBe(0);
    expect(latestProgressMarker(tail, now - 5000, now)).toMatchObject({ uncertain: true, progress: null });
    expect(successfulCommands(JSON.stringify(record) + '\n' + verified, now - 5000, now).size).toBe(0);
    expect(latestProgressMarker(JSON.stringify(record) + '\n' + verified, now - 5000, now)).toBeUndefined();
  });
  it('preserves a genuine paired success and complete report alongside a supported non-event record', () => {
    const record =
      JSON.stringify({
        type: 'response_item',
        timestamp: new Date(now).toISOString(),
        payload: { type: 'message', role: 'assistant', content: [] },
      }) + '\n';
    expect(successfulCommands(verified + record, now - 5000, now).get(commandHash('npm test'))).toEqual({
      startedAt: now - 3000,
      completedAt: now - 2000,
    });
    expect(latestProgressMarker(verified + record, now - 5000, now)?.progress).toMatchObject({
      outcome: 'completed',
      verifiedCriteria: ['tests'],
    });
    expect(latestProgressMarker(verified + record, now - 5000, now)?.uncertain).toBeUndefined();
  });
});
