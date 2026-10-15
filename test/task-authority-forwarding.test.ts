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
      const issuer = { sessionId: '99999999-9999-4999-8999-999999999999' } as NonNullable<
        ReturnType<NonNullable<RecoveryActionAuthority['getInputIssuer']>>
      >;
      const getInputIssuer = vi.fn(() => issuer);
      const authority: RecoveryActionAuthority = Object.assign(() => ownerCurrent, {
        prepareEvidence: prepare,
        getInputIssuer,
        getActionDeadline: () => 11_000,
      });
      const source: RecoveryEvidenceSource = {
        sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        identity: { reason: 'verified', conversationId: '11111111-2222-3333-4444-555555555555' },
        isCurrent: () => true,
      };
      const effects = vi.fn();
      const act = vi.fn(async (_key: string, _id: string, _prompt: string, token: RecoveryActionAuthority) => {
        expect(token.getInputIssuer).toBeTypeOf('function');
        expect(token.getActionDeadline?.()).toBe(11_000);
        if (!token.prepareEvidence || !(await token.prepareEvidence(source)) || !token()) {
          if (kind === 'owner-changed') expect(token.getInputIssuer!()).toBeUndefined();
          return 'not-sent' as const;
        }
        expect(token.getInputIssuer!()).toBe(issuer);
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
      expect(getInputIssuer).toHaveBeenCalledTimes(kind === 'authorized' ? 1 : 0);
      expect(state.phase).toBe(kind === 'authorized' ? 'watching' : 'paused');
      if (kind !== 'authorized') expect(state.inFlight).toBeUndefined();
    }
  );
});

describe('task action deadline ownership', () => {
  it.each(['own', 'shorter', 'later', 'expired', 'nan', 'throws', 'async-reject'] as const)(
    'passes the earliest original runtime cutoff to native delivery (%s)',
    async (kind) => {
      const effects = vi.fn();
      const authority: RecoveryActionAuthority = () => true;
      if (kind !== 'own')
        authority.getActionDeadline = (() => {
          if (kind === 'throws') throw new Error('Invalid inherited deadline');
          if (kind === 'async-reject') return Promise.reject(new Error('Async deadline is not authority'));
          return kind === 'shorter' ? 10_500 : kind === 'later' ? 20_000 : kind === 'expired' ? 9_999 : NaN;
        }) as () => number;
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
        act: async (_key, _thread, _prompt, token) => {
          const cutoff = token.getActionDeadline?.();
          const expected = kind === 'shorter' ? 10_500 : kind === 'expired' ? 9_999 : 11_000;
          if (['nan', 'throws', 'async-reject'].includes(kind)) expect(cutoff).toBeNaN();
          else expect(cutoff).toBe(expected);
          if (typeof cutoff !== 'number' || !Number.isFinite(cutoff) || cutoff <= 10_000 || !token()) return 'not-sent';
          effects();
          return 'sent';
        },
        persist: async () => {},
        changed: () => {},
        now: () => 10_000,
      });
      controllers.push(controller);
      await controller.update({
        objective: 'Scoped work',
        criteria: [{ id: 'owner', kind: 'manual', description: 'Owner review' }],
        config: { maxRuntimeMs: 1_000 },
      });
      const state = await controller.resume(authority);
      const allowed = ['own', 'shorter', 'later'].includes(kind);
      expect(effects).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(state.phase).toBe(allowed ? 'watching' : 'paused');
    }
  );
});
