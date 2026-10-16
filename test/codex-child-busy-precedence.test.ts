/** Real bounded rollouts and adapters; child state cannot be cleared by native busy hints. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { classifyCodexTail } from '../src/recovery/codex-classifier.js';
import {
  CHILD_NOW,
  CHILD_READY,
  CHILD_THREAD,
  childEvent,
  createChildLifecycleFixture,
  returnedChildTail,
} from './helpers/codex-child-lifecycle-fixture.js';

vi.mock('../src/session-env-clamp.js', () => ({
  clampExternalCliConfigsForOwner: vi.fn(async (_owner, configs) => configs),
  clampEnvOverridesForOwner: vi.fn(async (_owner, env) => env),
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(CHILD_NOW);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const context = (busy: boolean) => ({
  conversationId: CHILD_THREAD,
  now: CHILD_NOW,
  screen: CHILD_READY,
  busy,
  watching: false,
  tailTruncated: false,
});

it.each([false, true])(
  'retains active child authority at classifier and actual adapter boundaries (busy=%s)',
  async (busy) => {
    const body = returnedChildTail('collab_resume_end', 'running');
    const expected = { activity: 'watching', reason: 'background-work', safeToAct: false };
    expect(classifyCodexTail(body, context(busy))).toMatchObject(expected);
    const f = await createChildLifecycleFixture(body, false);
    try {
      vi.spyOn(f.session, 'isBusy').mockReturnValue(busy);
      expect(await f.adapter.observe()).toMatchObject(expected);
      await f.controller.retry();
      expect(f.delivered).not.toHaveBeenCalled();
      expect(f.store.get(f.session.id).inFlight).toBeUndefined();
    } finally {
      await f.cleanup();
    }
  }
);

it.each(['terminal-child', 'paired-failed-spawn'] as const)(
  'keeps healthy busy readiness after a certified %s closes',
  async (closed) => {
    const body =
      returnedChildTail('collab_resume_end', { completed: null }) +
      (closed === 'paired-failed-spawn'
        ? childEvent({ type: 'collab_agent_spawn_begin', call_id: 'failed-spawn' }, 23_000) +
          '\n' +
          childEvent(
            { type: 'collab_agent_spawn_end', call_id: 'failed-spawn', new_thread_id: null, status: 'not_found' },
            22_000
          ) +
          '\n'
        : '');
    const expected = { activity: 'working', reason: 'turn-running', safeToAct: false };
    expect(classifyCodexTail(body, context(true))).toMatchObject(expected);
    const f = await createChildLifecycleFixture(body, false);
    try {
      vi.spyOn(f.session, 'isBusy').mockReturnValue(true);
      expect(await f.adapter.observe()).toMatchObject({ ...expected, processReady: true });
    } finally {
      await f.cleanup();
    }
  }
);

it.each([
  {
    payload: { type: 'error', message: 'Sanitized auth fixture', codex_error_info: 'Unauthorized' },
    activity: 'blocked',
    reason: 'authentication-required',
  },
  { payload: { type: 'exec_approval_request', call_id: 'approval' }, activity: 'paused', reason: 'approval-required' },
  {
    payload: { type: 'error', message: 'Sanitized uncertain fixture', codex_error_info: 'thread_rollback_failed' },
    activity: 'unknown',
    reason: 'observing',
  },
  {
    payload: { type: 'turn_aborted', turn_id: 'current', reason: 'interrupted' },
    activity: 'paused',
    reason: 'user-interrupted',
  },
])('preserves structured $reason ahead of child and busy hints', async ({ payload, activity, reason }) => {
  const body = returnedChildTail('collab_resume_end', 'running') + childEvent(payload, 20_000) + '\n';
  const expected = { activity, reason, safeToAct: false };
  expect(classifyCodexTail(body, context(true))).toMatchObject(expected);
  const f = await createChildLifecycleFixture(body, false);
  try {
    vi.spyOn(f.session, 'isBusy').mockReturnValue(true);
    expect(await f.adapter.observe()).toMatchObject({ ...expected, processReady: false });
  } finally {
    await f.cleanup();
  }
});

it('retains a recent owner interruption ahead of pending child and busy hints', () => {
  const body = returnedChildTail('collab_resume_end', 'running', true);
  expect(classifyCodexTail(body, { ...context(true), lastIntentionalStopAt: CHILD_NOW - 24_000 })).toMatchObject({
    activity: 'paused',
    reason: 'user-interrupted',
    safeToAct: false,
  });
});
