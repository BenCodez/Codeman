/** Owner certifications require an identity from the current Session generation. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { CodexRecoveryAdapter } from '../src/recovery/codex-adapter.js';
import { CodexTaskAdapter } from '../src/supervision/adapter.js';
import { TaskController } from '../src/supervision/controller.js';

const UUID = '11111111-2222-3333-4444-555555555555';
const controllers: TaskController[] = [];
const sessions: Session[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) {
    controller.stop();
    await controller.drain();
  }
  for (const session of sessions.splice(0)) await session.stop(false);
  vi.restoreAllMocks();
});
describe('owner progress through actual task adapter', () => {
  it.each([
    'completed-current',
    'blocked-current',
    'completed-generation-changed',
    'blocked-generation-changed',
    'missing-tail',
  ] as const)('binds manual criteria and completion only to a verified current identity: %s', async (kind) => {
    const session = new Session({
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      workingDir: '/fixture/workspace',
      mode: 'codex',
      useMux: false,
      envOverrides: { CODEX_HOME: '/fixture/isolated-codex-home' },
      codexConfig: { noDaemon: true },
    });
    sessions.push(session);
    const persist = vi.fn(async () => {});
    const act = vi.fn(async () => 'not-sent' as const);
    vi.spyOn(CodexRecoveryAdapter.prototype, 'observe').mockImplementation(async () => {
      if (kind.endsWith('generation-changed')) session.trackUserInput('Owner changed the request');
      return {
        conversationId: UUID,
        activity: kind.startsWith('blocked') ? 'blocked' : 'completed',
        reason: kind.startsWith('blocked') ? 'authentication-required' : 'turn-completed',
        safeToAct: false,
        at: 10_000,
      };
    });
    vi.spyOn(CodexRecoveryAdapter.prototype, 'getVerifiedTail').mockReturnValue(
      kind === 'missing-tail' ? undefined : ''
    );
    const adapter = new CodexTaskAdapter(session, () => {});
    const controller = new TaskController({
      observe: () => adapter.observe(),
      act,
      persist,
      changed: () => {},
      now: () => 10_000,
    });
    controllers.push(controller);
    await controller.update({
      objective: 'Owner approved objective',
      criteria: [{ id: 'review', kind: 'manual', description: 'Owner review' }],
    });
    const before = controller.getStatus();
    persist.mockClear();
    const progress = controller.progress({ verifiedCriteria: ['review'], outcome: 'completed' });
    if (kind.endsWith('current')) {
      const state = await progress;
      expect(state.conversationId).toBe(UUID);
      expect(state.outcome).toBe('completed');
      expect(state.criteria[0]).toMatchObject({ verified: true, evidence: { source: 'owner' } });
      expect(persist).toHaveBeenCalledOnce();
    } else {
      await expect(progress).rejects.toThrow('Task conversation is not verified');
      expect(controller.getStatus()).toEqual(before);
      expect(persist).not.toHaveBeenCalled();
    }
    expect(act).not.toHaveBeenCalled();
  });
});
