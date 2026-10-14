/** Supported child lifecycle events must keep recovery out of a child's active work. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyCodexTail } from '../src/recovery/codex-classifier.js';
import {
  CHILD_ID,
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

const ENDS = ['collab_agent_interaction_end', 'collab_resume_end', 'collab_close_end', 'collab_wait_end'];
const context = (screen: string | null = CHILD_READY) => ({
  conversationId: CHILD_THREAD,
  now: CHILD_NOW,
  screen,
  busy: false,
  watching: false,
  tailTruncated: false,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(CHILD_NOW);
});
afterEach(() => vi.useRealTimers());

describe('shared child status lifecycle', () => {
  it.each(ENDS)('restores an already completed child to pending on %s', (type) => {
    for (const status of ['running', 'pending_init', 'interrupted', { running: null }, 'future-status']) {
      for (const screen of [CHILD_READY, null]) {
        expect(classifyCodexTail(returnedChildTail(type, status, true), context(screen))).toMatchObject({
          activity: 'watching',
          reason: 'background-work',
          safeToAct: false,
        });
      }
    }
  });

  it.each(ENDS)('clears only a certified named child on terminal %s', (type) => {
    for (const status of [
      'completed',
      'errored',
      'shutdown',
      'not_found',
      { completed: null },
      { errored: 'fixture' },
    ]) {
      expect(classifyCodexTail(returnedChildTail(type, status, true), context()).safeToAct).toBe(true);
    }
  });

  it.each(ENDS)('retains a named child for malformed or missing status on %s', (type) => {
    for (const status of [null, undefined, 42, {}, [], { completed: null, running: null }, { completed: false }]) {
      expect(classifyCodexTail(returnedChildTail(type, status, true), context())).toMatchObject({
        activity: 'watching',
        safeToAct: false,
      });
    }
  });

  it.each(['collab_agent_interaction_begin', 'collab_resume_begin', 'collab_close_begin'])(
    'never treats %s as a terminal status certificate',
    (type) => {
      expect(classifyCodexTail(returnedChildTail(type, 'completed', true), context())).toMatchObject({
        activity: 'watching',
        safeToAct: false,
      });
    }
  );

  it('keeps a spawn begin pending until its own named terminal end arrives', () => {
    const failed = returnedChildTail('collab_wait_end', 'completed', true);
    const begin = childEvent({ type: 'collab_agent_spawn_begin', call_id: 'next-spawn' }, 23_000) + '\n';
    expect(classifyCodexTail(failed + begin, context()).safeToAct).toBe(false);
    const end =
      childEvent(
        { type: 'collab_agent_spawn_end', call_id: 'next-spawn', new_thread_id: CHILD_ID, status: 'shutdown' },
        22_000
      ) + '\n';
    expect(classifyCodexTail(failed + begin + end, context()).safeToAct).toBe(true);
  });

  it.each(['collab_wait_begin', 'collab_waiting_begin'])('retains every named child at %s', (type) => {
    const body =
      returnedChildTail('collab_wait_end', 'completed', true) +
      childEvent({ type, receiver_thread_ids: [CHILD_ID, 'other-child'] }, 23_000) +
      '\n' +
      childEvent({ type: 'collab_wait_end', statuses: { [CHILD_ID]: 'completed' } }, 22_000) +
      '\n';
    expect(classifyCodexTail(body, context())).toMatchObject({ activity: 'watching', safeToAct: false });
  });

  it('releases only a paired failed-spawn placeholder with a certified absent receiver', () => {
    const failed = returnedChildTail('collab_wait_end', 'completed', true);
    const begin = childEvent({ type: 'collab_agent_spawn_begin', call_id: 'failed-spawn' }, 23_000) + '\n';
    for (const receiver of [{ new_thread_id: null }, {}]) {
      const end =
        childEvent(
          { type: 'collab_agent_spawn_end', call_id: 'failed-spawn', ...receiver, status: 'not_found' },
          22_000
        ) + '\n';
      expect(classifyCodexTail(failed + begin + end, context()).safeToAct).toBe(true);
      expect(
        classifyCodexTail(returnedChildTail('collab_resume_end', 'running', true) + begin + end, context())
      ).toMatchObject({
        activity: 'watching',
        safeToAct: false,
      });
    }
    for (const status of ['running', 'completed', null, { not_found: null }]) {
      const end =
        childEvent({ type: 'collab_agent_spawn_end', call_id: 'failed-spawn', new_thread_id: null, status }, 22_000) +
        '\n';
      expect(classifyCodexTail(failed + begin + end, context())).toMatchObject({
        activity: 'unknown',
        safeToAct: false,
      });
    }
  });

  it('supports the official waiting-end alias and both string/object statuses', () => {
    expect(classifyCodexTail(returnedChildTail('collab_waiting_end', 'running', true), context()).safeToAct).toBe(
      false
    );
    expect(
      classifyCodexTail(returnedChildTail('collab_waiting_end', { completed: null }, true), context()).safeToAct
    ).toBe(true);
  });

  it('fails closed on unnamed or malformed child identity/status maps', () => {
    for (const payload of [
      { type: 'collab_agent_spawn_end', new_thread_id: null, status: 'completed' },
      { type: 'collab_resume_end', receiver_thread_id: '../unknown', status: 'completed' },
      { type: 'collab_wait_end', statuses: [] },
      { type: 'collab_wait_end', statuses: {} },
      { type: 'collab_wait_end', statuses: { '../unknown': 'completed' } },
    ]) {
      expect(
        classifyCodexTail(
          returnedChildTail('collab_wait_end', 'completed', true) + childEvent(payload, 23_000) + '\n',
          context()
        )
      ).toMatchObject({
        activity: 'unknown',
        safeToAct: false,
      });
    }
  });
});

describe('real owned local recovery lifecycle', () => {
  it.each(ENDS)('never continues or restarts over a reactivated child reported by %s', async (type) => {
    for (const dead of [false, true]) {
      const f = await createChildLifecycleFixture(returnedChildTail(type, 'running', true), dead);
      try {
        expect(await f.adapter.observe()).toMatchObject({
          activity: 'watching',
          reason: 'background-work',
          safeToAct: false,
        });
        await f.controller.refresh();
        vi.setSystemTime(CHILD_NOW + 2000);
        await f.controller.refresh();
        vi.setSystemTime(CHILD_NOW + 3000);
        await f.controller.refresh();
        expect(f.delivered).not.toHaveBeenCalled();
        expect(f.controller.getStatus()).toMatchObject({ attempts: 0, lastReason: 'background-work' });
        expect(f.controller.getStatus().inFlight).toBeUndefined();
        expect(f.store.get(f.session.id)?.inFlight).toBeUndefined();
      } finally {
        await f.cleanup();
      }
      vi.setSystemTime(CHILD_NOW);
    }
  });

  it.each([false, true])('recovers with a certified terminal child (dead=%s)', async (dead) => {
    const f = await createChildLifecycleFixture(
      returnedChildTail('collab_resume_end', { completed: null }, true),
      dead
    );
    try {
      expect((await f.adapter.observe()).safeToAct).toBe(true);
      await f.controller.refresh();
      vi.setSystemTime(CHILD_NOW + 2000);
      await f.controller.refresh();
      vi.setSystemTime(CHILD_NOW + 3000);
      await f.controller.refresh();
      expect(f.delivered).toHaveBeenCalledTimes(1);
      expect(f.delivered.mock.calls[0][0]).toMatchObject({ action: dead ? 'restart' : 'continue' });
    } finally {
      await f.cleanup();
    }
  });
});
