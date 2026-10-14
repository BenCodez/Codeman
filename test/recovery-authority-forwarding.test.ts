/** Fresh supervisor issuer proofs must survive recovery retry reservation wrappers. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecoveryController } from '../src/recovery/controller.js';
import {
  initialRecoveryState,
  type RecoveryActionAuthority,
  type RecoveryEvidenceSource,
} from '../src/recovery/types.js';

const controllers: RecoveryController[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
});
describe('recovery retry issuer evidence', () => {
  it.each(['authorized', 'refused', 'owner-changed'] as const)(
    'retains final issuer verification after durable reservation: %s',
    async (kind) => {
      const now = 10_000;
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
      const act = vi.fn(async (_flight, token: RecoveryActionAuthority) => {
        if (!token.prepareEvidence || !(await token.prepareEvidence(source)) || !token()) return 'not-sent' as const;
        effects();
        return 'sent' as const;
      });
      const state = initialRecoveryState();
      state.config.enabled = true;
      const controller = new RecoveryController(
        {
          observe: async () => ({
            conversationId: '11111111-2222-3333-4444-555555555555',
            activity: 'interrupted',
            reason: 'turn-failed',
            at: now,
            evidenceKey: 'fixture-failure',
            safeToAct: true,
          }),
          act,
          persist: async () => {},
          changed: () => {},
          now: () => now,
        },
        state
      );
      controllers.push(controller);
      await controller.retry(authority);
      expect(prepare).toHaveBeenCalledExactlyOnceWith(source);
      expect(act).toHaveBeenCalledOnce();
      expect(effects).toHaveBeenCalledTimes(kind === 'authorized' ? 1 : 0);
      if (kind === 'owner-changed') {
        expect(controller.getStatus().inFlight).toBeUndefined();
        expect(controller.getStatus().attempts).toBe(0);
      }
    }
  );
});
