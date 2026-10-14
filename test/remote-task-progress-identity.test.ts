/** Current remote clock provenance is required before task certification binds a UUID. */
import { afterEach, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { CodexRecoveryAdapter } from '../src/recovery/codex-adapter.js';
import { CodexTaskAdapter } from '../src/supervision/adapter.js';
import { TaskController } from '../src/supervision/controller.js';
const UUID = '11111111-2222-3333-4444-555555555555';
const sessions: Session[] = [];
const controllers: TaskController[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) {
    controller.stop();
    await controller.drain();
  }
  for (const session of sessions.splice(0)) await session.stop(false);
  vi.restoreAllMocks();
});
it.each(['current', 'missing', 'reversed'] as const)(
  'requires complete remote observation provenance for owner progress: %s',
  async (kind) => {
    const session = new Session({
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      workingDir: '/fixture/workspace',
      mode: 'codex',
      useMux: false,
      codexConfig: { noDaemon: true },
      envOverrides: { CODEX_HOME: '/fixture/remote-codex' },
      remote: {
        hostId: 'fixture',
        label: 'Fixture',
        host: 'worker.invalid',
        username: 'runner',
        remotePath: '/fixture/workspace',
        owned: true,
      },
    });
    sessions.push(session);
    vi.spyOn(CodexRecoveryAdapter.prototype, 'observe').mockResolvedValue({
      conversationId: UUID,
      activity: 'completed',
      reason: 'turn-completed',
      safeToAct: false,
      at: 10_000,
    });
    vi.spyOn(CodexRecoveryAdapter.prototype, 'getVerifiedTail').mockReturnValue('');
    vi.spyOn(CodexRecoveryAdapter.prototype, 'getVerifiedRemoteClock').mockReturnValue(
      kind === 'missing'
        ? undefined
        : {
            localBefore: 9_999,
            localAfter: 10_000,
            remoteBefore: kind === 'reversed' ? 10_001 : 9_999,
            remoteAfter: 10_000,
          }
    );
    const persist = vi.fn(async () => {});
    const act = vi.fn(async () => 'not-sent' as const);
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
      objective: 'Authorized objective',
      criteria: [{ id: 'review', kind: 'manual', description: 'Owner review' }],
    });
    const before = controller.getStatus();
    persist.mockClear();
    const progress = controller.progress({ verifiedCriteria: ['review'], outcome: 'completed' });
    if (kind === 'current') {
      expect(await progress).toMatchObject({
        conversationId: UUID,
        outcome: 'completed',
        criteria: [expect.objectContaining({ verified: true })],
      });
      expect(persist).toHaveBeenCalledOnce();
    } else {
      await expect(progress).rejects.toThrow('Task conversation is not verified');
      expect(controller.getStatus()).toEqual(before);
      expect(persist).not.toHaveBeenCalled();
    }
    expect(act).not.toHaveBeenCalled();
  }
);
