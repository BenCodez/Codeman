/** Receipt cleanup remains live after reload or arbiter contention, without dispatch authority. */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TaskController } from '../src/supervision/controller.js';
import { initialTaskState, TaskStateSchema } from '../src/supervision/schema.js';
import { SessionActionArbiter, sessionActionKey } from '../src/supervision/action-arbiter.js';
import { RecoveryController } from '../src/recovery/controller.js';
import { CONTINUATION_PROMPT, initialRecoveryState } from '../src/recovery/types.js';
import { createDeferred } from './mocks/index.js';

const THREAD = '11111111-2222-4333-8444-555555555555';
const KEY = 'accepted-operation';
const controllers: Array<TaskController | RecoveryController> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([false, true])('cleans a restored accepted task receipt with dispatch enabled=%s', async (enabled) => {
  const restored = initialTaskState();
  restored.config.enabled = enabled;
  restored.conversationId = THREAD;
  restored.submissionKey = 'accepted-submission';
  restored.handledEvidence = [KEY];
  restored.inFlight = {
    key: KEY,
    action: 'continue',
    startedAt: 10_000,
    accepted: true,
    acceptedAt: 10_001,
    promptHash: createHash('sha256').update(CONTINUATION_PROMPT).digest('hex'),
  };
  TaskStateSchema.parse(restored);
  const commonPersist = vi.fn(async (_key: string | undefined) => {});
  const arbiter = new SessionActionArbiter(commonPersist, sessionActionKey('task', KEY));
  const observe = vi.fn();
  const act = vi.fn();
  const persist = vi.fn(async () => {});
  const controller = new TaskController(
    {
      now: () => 20_000,
      observe,
      act,
      persist,
      changed: () => {},
      acceptReservation: (key) => arbiter.accept('task', key),
    },
    restored
  );
  controllers.push(controller);
  const phase = controller.getStatus().phase;
  await vi.advanceTimersByTimeAsync(4999);
  expect(controller.getStatus().inFlight?.accepted).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  await controller.drain();
  expect(controller.getStatus().inFlight).toBeUndefined();
  expect(controller.getStatus().phase).toBe(phase);
  expect(observe).not.toHaveBeenCalled();
  expect(act).not.toHaveBeenCalled();
  expect(commonPersist).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(persist).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(persist).toHaveBeenCalledOnce();
});

it.each(['task', 'recovery'] as const)(
  'retries exact %s receipt cleanup after transient shared contention',
  async (domain) => {
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const commonPersist = vi.fn(async (key: string | undefined) => {
      if (key === sessionActionKey('task', 'competing-start')) {
        entered.resolve();
        await release.promise;
      }
    });
    const arbiter = new SessionActionArbiter(commonPersist);
    const competingEffect = vi.fn(async () => 'not-sent' as const);
    const competing = arbiter.run('task', 'competing-start', competingEffect);
    await entered.promise;
    const accept = vi.fn((key: string) => arbiter.accept(domain, key));
    const act = vi.fn();
    const persist = vi.fn(async () => {});
    let controller: TaskController | RecoveryController;
    if (domain === 'task') {
      const restored = initialTaskState();
      restored.config.enabled = true;
      restored.conversationId = THREAD;
      restored.submissionKey = 'accepted-submission';
      restored.handledEvidence = [KEY];
      restored.inFlight = {
        key: KEY,
        action: 'continue',
        startedAt: 10_000,
        accepted: true,
        acceptedAt: 10_001,
        promptHash: createHash('sha256').update(CONTINUATION_PROMPT).digest('hex'),
      };
      controller = new TaskController(
        { now: () => 20_000, observe: vi.fn(), act, persist, changed: () => {}, acceptReservation: accept },
        restored
      );
    } else {
      const restored = initialRecoveryState();
      restored.config.enabled = false;
      restored.inFlight = {
        key: KEY,
        action: 'continue',
        conversationId: THREAD,
        reason: 'turn-interrupted',
        startedAt: 10_000,
        delivery: 'sent',
        previousSubmissionKey: 'previous-submission',
      };
      controller = new RecoveryController(
        {
          now: () => 20_000,
          observe: async () => ({
            activity: 'working',
            reason: 'turn-running',
            at: 20_000,
            conversationId: THREAD,
            submissionKey: 'accepted-submission',
            submissionHash: createHash('sha256').update(CONTINUATION_PROMPT).digest('hex'),
            safeToAct: false,
          }),
          act,
          persist,
          changed: () => {},
          acceptReservation: accept,
        },
        restored
      );
    }
    controllers.push(controller);
    try {
      await vi.advanceTimersByTimeAsync(5000);
      await controller.drain();
      expect(accept).toHaveBeenCalledExactlyOnceWith(KEY);
      expect(controller.getStatus().inFlight?.accepted).toBe(true);
      release.resolve();
      await competing;
      await vi.advanceTimersByTimeAsync(4999);
      expect(accept).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      await controller.drain();
      expect(accept).toHaveBeenCalledTimes(2);
      expect(controller.getStatus().inFlight).toBeUndefined();
      expect(act).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await competing;
    }
  }
);

it('never treats an unaccepted paused task flight as receipt cleanup authority', async () => {
  const restored = initialTaskState();
  restored.config.enabled = true;
  restored.conversationId = THREAD;
  restored.inFlight = { key: KEY, action: 'continue', startedAt: 10_000 };
  const accept = vi.fn();
  const act = vi.fn();
  const controller = new TaskController(
    { now: () => 20_000, observe: vi.fn(), act, persist: vi.fn(), changed: () => {}, acceptReservation: accept },
    restored
  );
  controllers.push(controller);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(controller.getStatus().inFlight?.key).toBe(KEY);
  expect(accept).not.toHaveBeenCalled();
  expect(act).not.toHaveBeenCalled();
});
