/** Declines and stale cross-protocol child certificates must retain their vetoes. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyCodexTail } from '../src/recovery/codex-classifier.js';
import {
  CHILD_ERROR,
  CHILD_ID,
  CHILD_NOW,
  CHILD_READY,
  CHILD_THREAD,
  childEvent,
  createChildLifecycleFixture,
} from './helpers/codex-child-lifecycle-fixture.js';

vi.mock('../src/session-env-clamp.js', () => ({
  clampExternalCliConfigsForOwner: vi.fn(async (_owner, configs) => configs),
  clampEnvOverridesForOwner: vi.fn(async (_owner, env) => env),
}));
type Payload = Record<string, unknown>;
const context = (screen: string | null = CHILD_READY) => ({
  conversationId: CHILD_THREAD,
  now: CHILD_NOW,
  screen,
  busy: false,
  watching: false,
  tailTruncated: false,
});
const row = (p: Payload, age: number) => childEvent(p, age) + '\n';
const start = row({ type: 'task_started', turn_id: 'current' }, 30_000);
const failure = row({ type: 'task_complete', turn_id: 'current', error: CHILD_ERROR }, 10_000);
const child = (kind = 'started', at = CHILD_NOW - 20_000): Payload => ({
  type: 'sub_agent_activity',
  agent_thread_id: CHILD_ID,
  agent_path: '/root/worker',
  event_id: `fixture-${kind}`,
  kind,
  occurred_at_ms: at,
  model: null,
  reasoning_effort: null,
});
const command = {
  call_id: 'cmd',
  turn_id: 'current',
  command: ['sh', '-c', 'printf fixture'],
  cwd: '/fixture',
  parsed_cmd: [],
  source: 'agent',
};
const commandTail = (status: string) =>
  start +
  row({ ...command, type: 'exec_command_begin', started_at_ms: CHILD_NOW - 25_000 }, 25_000) +
  row(
    {
      ...command,
      type: 'exec_command_end',
      completed_at_ms: CHILD_NOW - 24_000,
      status,
      exit_code: status === 'failed' ? 1 : 0,
      aggregated_output: '',
      duration: { secs: 1, nanos: 0 },
    },
    24_000
  );
const ends = [
  'collab_agent_spawn_end',
  'collab_agent_interaction_end',
  'collab_resume_end',
  'collab_close_end',
  'collab_wait_end',
  'collab_waiting_end',
];
const completion = (type: string, at: unknown = CHILD_NOW - 19_000, id = CHILD_ID): Payload => ({
  type,
  call_id: 'child-end',
  sender_thread_id: CHILD_THREAD,
  completed_at_ms: at,
  ...(type.includes('wait')
    ? { statuses: { [id]: { completed: null } } }
    : type.includes('spawn')
      ? { new_thread_id: id, status: 'completed' }
      : { receiver_thread_id: id, status: 'completed' }),
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(CHILD_NOW);
});
afterEach(() => vi.useRealTimers());

describe('owner command decline', () => {
  it('retains approval through terminal failure, provider retry, and repeated/new turn-start records', () => {
    for (const after of [
      [],
      [{ type: 'stream_error', message: 'retry' }],
      [{ type: 'task_started', turn_id: 'current' }],
      [{ type: 'task_started', turn_id: 'next' }],
    ]) {
      for (const screen of [CHILD_READY, null]) {
        const turn_id = after.at(-1)?.turn_id ?? 'current';
        const body =
          commandTail('declined') +
          after.map((p) => row(p, 20_000)).join('') +
          row({ type: 'task_complete', turn_id, error: CHILD_ERROR }, 10_000);
        expect(classifyCodexTail(body, context(screen))).toMatchObject({
          activity: 'paused',
          reason: 'approval-required',
          safeToAct: false,
        });
      }
    }
  });

  it('a new owner prompt followed by its own failed turn may supersede the decline', () => {
    const body =
      commandTail('declined') +
      row({ type: 'user_message', message: 'A new owner request', local_images: [] }, 22_000) +
      row({ type: 'task_started', turn_id: 'next' }, 21_000) +
      row({ type: 'task_complete', turn_id: 'next', error: CHILD_ERROR }, 20_000);
    expect(classifyCodexTail(body, context()).safeToAct).toBe(true);
  });

  it.each([
    { type: 'user_message', message: false },
    { type: 'user_message', message: '' },
    {
      type: 'item_completed',
      thread_id: CHILD_THREAD,
      turn_id: 'next',
      item: { type: 'UserMessage', id: 'new', content: [] },
    },
  ])('malformed/empty owner prompt cannot clear a decline: %j', (payload) => {
    const body =
      commandTail('declined') +
      row(payload, 22_000) +
      row({ type: 'task_started', turn_id: 'next' }, 21_000) +
      row({ type: 'task_complete', turn_id: 'next', error: CHILD_ERROR }, 20_000);
    expect(classifyCodexTail(body, context())).toMatchObject({ activity: 'unknown', safeToAct: false });
  });

  it.each([false, true])('actual owned recovery refuses declined command (dead=%s)', async (dead) => {
    const f = await createChildLifecycleFixture(commandTail('declined') + failure, dead);
    try {
      expect(await f.adapter.observe()).toMatchObject({
        activity: 'paused',
        reason: 'approval-required',
        safeToAct: false,
      });
      await f.controller.retry();
      expect(f.delivered).not.toHaveBeenCalled();
      expect(f.controller.getStatus().inFlight).toBeUndefined();
    } finally {
      await f.cleanup();
    }
  });

  it.each(['completed', 'failed'])('ordinary %s command remains eligible after genuine turn failure', (status) => {
    expect(classifyCodexTail(commandTail(status) + failure, context()).safeToAct).toBe(true);
  });
});

describe('shared child completion causal fence', () => {
  it.each(ends)('stale/missing/coercible %s cannot release newer v2 work', (type) => {
    for (const at of [
      undefined,
      null,
      0,
      '1800000000000',
      false,
      CHILD_NOW - 21_000,
      CHILD_NOW - 20_000,
      CHILD_NOW + 3000,
    ]) {
      for (const screen of [CHILD_READY, null]) {
        expect(
          classifyCodexTail(
            start + row(child(), 20_000) + row({ ...completion(type), completed_at_ms: at }, 18_000) + failure,
            context(screen)
          )
        ).toMatchObject({ activity: 'unknown', safeToAct: false });
      }
    }
  });

  it.each(ends)('fresh exact %s releases that child but not another child', (type) => {
    expect(
      classifyCodexTail(start + row(child(), 20_000) + row(completion(type), 18_000) + failure, context()).safeToAct
    ).toBe(true);
    expect(
      classifyCodexTail(
        start +
          row(child(), 20_000) +
          row(completion(type, CHILD_NOW - 19_000, '019a5aa0-3333-7333-8333-333333333333'), 18_000) +
          failure,
        context()
      )
    ).toMatchObject({ activity: 'watching', safeToAct: false });
  });

  it.each(ends)('wrong/missing sender/call identity in %s cannot release work', (type) => {
    for (const patch of [
      { sender_thread_id: undefined },
      { sender_thread_id: CHILD_ID },
      { call_id: undefined },
      { call_id: '../invalid' },
    ]) {
      expect(
        classifyCodexTail(
          start + row(child(), 20_000) + row({ ...completion(type), ...patch }, 18_000) + failure,
          context()
        )
      ).toMatchObject({ activity: 'unknown', safeToAct: false });
    }
  });

  it.each([
    'collab_agent_interaction_begin',
    'collab_resume_begin',
    'collab_close_begin',
    'collab_wait_begin',
    'collab_waiting_begin',
  ])('%s reuse cannot be cleared by an earlier v2 completion', (type) => {
    const begin = {
      type,
      started_at_ms: CHILD_NOW - 18_000,
      sender_thread_id: CHILD_THREAD,
      call_id: 'reuse',
      ...(type.includes('wait') ? { receiver_thread_ids: [CHILD_ID] } : { receiver_thread_id: CHILD_ID }),
    };
    expect(
      classifyCodexTail(
        start +
          row(child('completed', CHILD_NOW - 21_000), 21_000) +
          row(begin, 18_000) +
          row(child('completed', CHILD_NOW - 19_000), 17_000) +
          failure,
        context()
      )
    ).toMatchObject({ activity: 'unknown', safeToAct: false });
    expect(
      classifyCodexTail(
        start +
          row(child('completed', CHILD_NOW - 21_000), 21_000) +
          row(begin, 18_000) +
          row(child('completed', CHILD_NOW - 17_000), 17_000) +
          failure,
        context()
      ).safeToAct
    ).toBe(true);
  });

  it('a prior legacy completion cannot clear a later legacy or v2 reuse', () => {
    for (const active of [
      child('interacted', CHILD_NOW - 17_000),
      {
        type: 'collab_resume_end',
        receiver_thread_id: CHILD_ID,
        status: 'running',
        completed_at_ms: CHILD_NOW - 17_000,
      },
    ]) {
      expect(
        classifyCodexTail(
          start +
            row(child(), 20_000) +
            row(completion('collab_waiting_end'), 19_000) +
            row(active, 17_000) +
            row(completion('collab_waiting_end'), 16_000) +
            failure,
          context()
        )
      ).toMatchObject({ activity: 'unknown', safeToAct: false });
    }
  });

  it.each([false, true])(
    'actual owned recovery honors stale-child veto and healthy fresh completion (dead=%s)',
    async (dead) => {
      for (const fresh of [false, true]) {
        const body =
          start +
          row(child(), 20_000) +
          row(completion('collab_waiting_end', CHILD_NOW - (fresh ? 19_000 : 21_000)), 18_000) +
          failure;
        const f = await createChildLifecycleFixture(body, dead);
        try {
          expect((await f.adapter.observe()).safeToAct).toBe(fresh);
          await f.controller.refresh();
          vi.setSystemTime(CHILD_NOW + 2000);
          await f.controller.refresh();
          vi.setSystemTime(CHILD_NOW + 3000);
          await f.controller.refresh();
          expect(f.delivered).toHaveBeenCalledTimes(fresh ? 1 : 0);
        } finally {
          await f.cleanup();
        }
        vi.setSystemTime(CHILD_NOW);
      }
    }
  );
});

it.each([
  'collab_agent_spawn_begin',
  'collab_agent_spawn_end',
  'collab_agent_interaction_begin',
  'collab_resume_begin',
  'collab_close_begin',
  'collab_wait_begin',
  'collab_waiting_begin',
])('a malformed active %s cannot be healed by a later completion', (type) => {
  const active = {
    type,
    sender_thread_id: CHILD_ID,
    call_id: 'foreign-call',
    started_at_ms: CHILD_NOW - 20_000,
    completed_at_ms: CHILD_NOW - 20_000,
    new_thread_id: CHILD_ID,
    receiver_thread_id: CHILD_ID,
    receiver_thread_ids: [CHILD_ID],
    status: 'running',
  };
  expect(
    classifyCodexTail(start + row(active, 20_000) + row(completion('collab_wait_end'), 18_000) + failure, context())
  ).toMatchObject({ activity: 'unknown', safeToAct: false });
});
