/** Issuer evidence survives task ownership wrappers until actual guarded delivery. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskController } from '../src/supervision/controller.js';
import type { RecoveryActionAuthority, RecoveryEvidenceSource } from '../src/recovery/types.js';

const controllers: TaskController[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
});
describe('task kickoff issuer evidence', () => {
  it.each(['authorized', 'refused', 'owner-changed'] as const)(
    'preserves fresh issuer verification and its final cancellation token: %s',
    async (kind) => {
      let ownerCurrent = true;
      const prepare = vi.fn(async () => {
        if (kind === 'owner-changed') ownerCurrent = false;
        return kind !== 'refused';
      });
      const authority: RecoveryActionAuthority = Object.assign(() => ownerCurrent, { prepareEvidence: prepare });
      const source: RecoveryEvidenceSource = {
        sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        identity: { reason: 'verified', conversationId: '11111111-2222-3333-4444-555555555555' },
        isCurrent: () => true,
      };
      const effects = vi.fn();
      const act = vi.fn(async (_key: string, _id: string, _prompt: string, token: RecoveryActionAuthority) => {
        if (!token.prepareEvidence || !(await token.prepareEvidence(source)) || !token()) return 'not-sent' as const;
        effects();
        return 'sent' as const;
      });
      const controller = new TaskController({
        observe: async () => ({
          observation: {
            conversationId: '11111111-2222-3333-4444-555555555555',
            activity: 'idle',
            reason: 'observing',
            at: 10_000,
            processReady: true,
            processReadyAt: 10_000,
            safeToAct: false,
          },
          commands: new Map(),
        }),
        act,
        persist: async () => {},
        changed: () => {},
        now: () => 10_000,
      });
      controllers.push(controller);
      await controller.update({
        objective: 'Authorized work',
        criteria: [{ id: 'owner', kind: 'manual', description: 'Owner review' }],
      });
      const state = await controller.resume(authority);
      expect(prepare).toHaveBeenCalledExactlyOnceWith(source);
      expect(act).toHaveBeenCalledOnce();
      expect(effects).toHaveBeenCalledTimes(kind === 'authorized' ? 1 : 0);
      expect(state.phase).toBe(kind === 'authorized' ? 'watching' : 'paused');
      if (kind !== 'authorized') expect(state.inFlight).toBeUndefined();
    }
  );
});
