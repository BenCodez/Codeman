/** Real task adapter/parser/controller; injected passive SSH evidence, no processes. */
import { describe, expect, it, vi } from 'vitest';
import { CodexTaskAdapter } from '../src/supervision/adapter.js';
import { TaskController } from '../src/supervision/controller.js';
import { commandHash } from '../src/supervision/evidence.js';
import type { Session } from '../src/session.js';
import type { RemoteClockWitness } from '../src/recovery/remote-clock.js';

const CID = '11111111-2222-3333-4444-555555555555';
const line = (at: number, payload: unknown) =>
  JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload }) + '\n';
function tail(call = 'execution-one', start = 15000, completed = 16000) {
  return (
    line(start, { type: 'exec_command_begin', call_id: call, command: ['bash', '-lc', 'check exact'] }) +
    line(completed, { type: 'exec_command_end', call_id: call, exit_code: 0 })
  );
}
const clocks: RemoteClockWitness[] = [
  { localBefore: 21000, localAfter: 21020, remoteBefore: 22000, remoteAfter: 22000 },
  { localBefore: 21030, localAfter: 21090, remoteBefore: 22035, remoteAfter: 22035 },
];

describe('remote command completion across SSH clock samples', () => {
  it.each([
    'same',
    'call',
    'start',
    'end',
    'masked-change',
    'stale',
    'future',
    'clock',
    'identity',
    'generation',
  ] as const)('final commit rechecks %s evidence without equating sampled local bounds', async (change) => {
    let now = 10000,
      generation = 1,
      sample = -1;
    const session = {
      remote: { owned: true },
      getRecoveryContext: () => ({ generation }),
    } as unknown as Session;
    const adapter = new CodexTaskAdapter(session, () => {});
    const observations: Array<Awaited<ReturnType<typeof adapter.observe>>> = [];
    Reflect.set(adapter, 'recovery', {
      observe: async () => {
        sample++;
        if (sample === 1 && change === 'generation') generation++;
        return {
          activity: sample === 1 && change === 'identity' ? 'unknown' : 'working',
          reason: sample === 1 && change === 'identity' ? 'identity-unverified' : 'turn-running',
          at: now,
          conversationId: CID,
          submissionKey: 'same-submission',
          safeToAct: false,
        };
      },
      getVerifiedTail: () =>
        sample !== 1
          ? tail()
          : change === 'call'
            ? tail('execution-two')
            : change === 'start'
              ? tail('execution-one', 15001)
              : change === 'end'
                ? tail('execution-one', 15000, 16001)
                : change === 'masked-change'
                  ? tail('execution-one', 15005, 16005)
                  : change === 'stale'
                    ? tail('execution-one', 10000)
                    : change === 'future'
                      ? tail('execution-one', 15000, 26000)
                      : tail(),
      getVerifiedRemoteClock: () =>
        sample === 1 && change === 'clock'
          ? { ...clocks[1], localAfter: 25000 }
          : sample === 1 && change === 'masked-change'
            ? { ...clocks[1], localAfter: 21050 }
            : clocks[Math.min(sample, 1)],
    });
    const act = vi.fn(async () => 'sent' as const);
    const controller = new TaskController({
      now: () => now,
      observe: async () => {
        const value = await adapter.observe();
        observations.push(value);
        return value;
      },
      persist: async () => {},
      changed: () => {},
      act,
    });
    try {
      await controller.update({
        objective: 'Verify the exact command',
        criteria: [{ id: 'check', description: 'Required check', kind: 'command', command: 'check exact' }],
      });
      now = 21090;
      const completing = controller.progress({ outcome: 'completed', verifiedCriteria: ['check'] });
      if (change === 'same') {
        await completing;
        expect(controller.getStatus()).toMatchObject({ phase: 'completed', outcome: 'completed' });
        const key = commandHash('check exact');
        expect(observations[0].commands.get(key)).toEqual({ startedAt: 14000, completedAt: 15020 });
        expect(observations[1].commands.get(key)).toEqual({ startedAt: 13995, completedAt: 15055 });
      } else {
        await expect(completing).rejects.toThrow('Command success evidence changed');
        expect(controller.getStatus().outcome).not.toBe('completed');
        expect(controller.getStatus().criteria[0].verified).toBe(false);
      }
      expect(observations).toHaveLength(2);
      expect(act).not.toHaveBeenCalled();
    } finally {
      controller.stop();
      await controller.drain();
    }
  });
});
