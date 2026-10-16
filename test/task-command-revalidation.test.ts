/** @fileoverview Actual rollout command/marker parsing and controller completion; no worker effects. */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { TaskController } from '../src/supervision/controller.js';
import { commandHash, latestProgressMarker, successfulCommands } from '../src/supervision/evidence.js';
import type { TaskState } from '../src/supervision/schema.js';

const CID = '11111111-2222-3333-4444-555555555555';
const line = (at: number, payload: unknown) =>
  JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload }) + '\n';
const begin = (at: number, call_id: string, command = 'check A') =>
  line(at, { type: 'exec_command_begin', call_id, command: ['bash', '-lc', command] });
const end = (at: number, call_id: string, exit_code = 0) => line(at, { type: 'exec_command_end', call_id, exit_code });

async function fixture() {
  let now = 10000;
  const submission = line(10000, { type: 'user_message', message: 'Run the authorized acceptance checks' });
  const submissionKey = createHash('sha256').update(submission.trimEnd()).digest('hex');
  let tail = submission;
  let activity: 'working' | 'completed' = 'working';
  let saved: TaskState | undefined;
  const act = vi.fn(async () => 'sent' as const);
  const recover = vi.fn(async () => 'sent' as const);
  const controller = new TaskController({
    now: () => now,
    observe: async () => ({
      observation: {
        activity,
        reason: 'turn-running',
        at: now,
        conversationId: CID,
        submissionKey,
        safeToAct: false,
      },
      commands: successfulCommands(tail, 0, now),
      marker: latestProgressMarker(tail, 0, now),
    }),
    persist: async (state) => {
      saved = structuredClone(state);
    },
    changed: () => {},
    act,
    recover,
  });
  await controller.update({
    objective: 'Verify both independent checks',
    criteria: [
      { id: 'A', description: 'First check', kind: 'command', command: 'check A' },
      { id: 'B', description: 'Second check', kind: 'command', command: 'check B' },
      { id: 'manual', description: 'Owner review', kind: 'manual' },
    ],
    config: { enabled: true },
  });
  tail += begin(11000, 'A-first') + end(12000, 'A-first');
  now = 13000;
  await controller.progress({
    outcome: 'unfinished',
    checkpoint: 'A passed and owner reviewed',
    nextAction: 'Run B',
    verifiedCriteria: ['A', 'manual'],
  });
  expect(controller.getStatus().criteria.map((criterion) => criterion.verified)).toEqual([true, false, true]);
  return {
    controller,
    finish: () => {
      activity = 'completed';
    },
    act,
    recover,
    append: (text: string) => {
      tail += text;
    },
    clock: (at: number) => {
      now = at;
    },
    commands: () => successfulCommands(tail, 0, now),
    saved: () => saved!,
  };
}

const invalidRuns = {
  failed: begin(14000, 'A-new') + end(15000, 'A-new', 1),
  pending: begin(14000, 'A-new'),
  'older-overlap-finishes-last':
    begin(14000, 'A-old') + begin(15000, 'A-new') + end(16000, 'A-new', 1) + end(17000, 'A-old'),
  'backwards-begin': begin(10999, 'A-new') + end(15000, 'A-new'),
  'backwards-end': begin(15000, 'A-new') + end(14000, 'A-new'),
  'future-end': begin(15000, 'A-new') + end(25001, 'A-new'),
};

describe('previously verified command criteria follow current execution evidence', () => {
  it.each(Object.entries(invalidRuns))('agent completion of B cannot retain A after %s', async (_name, rerun) => {
    const f = await fixture();
    try {
      f.append(rerun + begin(18000, 'B', 'check B') + end(19000, 'B'));
      f.append(
        line(20000, {
          type: 'agent_message',
          message: 'CODEMAN_TASK_PROGRESS {"outcome":"completed","verifiedCriteria":["B"]}',
        })
      );
      f.clock(21000);
      expect(f.commands().has(commandHash('check A'))).toBe(false);
      await f.controller.refresh();
      expect(f.controller.getStatus().outcome).not.toBe('completed');
      if (['failed', 'pending', 'older-overlap-finishes-last'].includes(_name)) {
        expect(f.controller.getStatus()).toMatchObject({
          phase: 'paused',
          outcome: 'unknown',
          agentProgressVeto: true,
        });
        expect(f.saved().criteria[0].verified).toBe(false);
      }
      expect(f.controller.getStatus().criteria[0]).toMatchObject({ id: 'A', verified: false });
      expect(f.controller.getStatus().criteria[0].evidence).toBeUndefined();
      expect(f.controller.getStatus().criteria[2]).toMatchObject({
        id: 'manual',
        verified: true,
        evidence: { source: 'owner', at: 13000 },
      });
      expect(f.act).not.toHaveBeenCalled();
      expect(f.recover).not.toHaveBeenCalled();
    } finally {
      f.controller.stop();
      await f.controller.drain();
    }
  });

  it.each(['owner-progress', 'agent-marker'] as const)(
    '%s accepts a new successful A without recertifying manual review',
    async (entry) => {
      const f = await fixture();
      try {
        f.append(begin(14000, 'A-old') + begin(15000, 'A-new') + end(16000, 'A-new') + end(17000, 'A-old', 1));
        f.append(begin(18000, 'B', 'check B') + end(19000, 'B'));
        f.clock(21000);
        expect(f.commands().get(commandHash('check A'))).toEqual({ startedAt: 15000, completedAt: 16000 });
        if (entry === 'agent-marker') {
          f.finish();
          f.append(
            line(20000, {
              type: 'agent_message',
              message: 'CODEMAN_TASK_PROGRESS {"outcome":"completed","verifiedCriteria":["B"]}',
            })
          );
          await f.controller.refresh();
        } else await f.controller.progress({ outcome: 'completed', verifiedCriteria: ['B'] });
        expect(f.controller.getStatus()).toMatchObject({ phase: 'completed', outcome: 'completed' });
        expect(f.controller.getStatus().criteria.map((criterion) => criterion.verified)).toEqual([true, true, true]);
        expect(f.controller.getStatus().criteria[2].evidence).toEqual({ source: 'owner', at: 13000 });
        expect(f.act).not.toHaveBeenCalled();
      } finally {
        f.controller.stop();
        await f.controller.drain();
      }
    }
  );

  it.each(['failed', 'pending'] as const)('owner cannot complete only B after a newer %s A', async (run) => {
    const f = await fixture();
    try {
      f.append(invalidRuns[run] + begin(18000, 'B', 'check B') + end(19000, 'B'));
      f.clock(21000);
      await expect(f.controller.progress({ outcome: 'completed', verifiedCriteria: ['B'] })).rejects.toThrow(
        'Acceptance criteria'
      );
      expect(f.controller.getStatus().phase).not.toBe('completed');
      // An incremental unfinished report persists invalidation without erasing
      // the owner's independent manual certification.
      await f.controller.progress({
        outcome: 'unfinished',
        checkpoint: 'A needs rerun',
        nextAction: 'Repeat A',
        verifiedCriteria: ['B'],
      });
      expect(f.saved().criteria.map((criterion) => criterion.verified)).toEqual([false, true, true]);
      expect(f.saved().criteria[0].evidence).toBeUndefined();
      expect(f.act).not.toHaveBeenCalled();
    } finally {
      f.controller.stop();
      await f.controller.drain();
    }
  });
});
