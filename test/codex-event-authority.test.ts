/** Pinned Codex control events cannot preserve stale recovery authority. */
import fs from 'node:fs/promises';
import { join } from 'node:path';
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
const failed = (completed = false) =>
  childEvent({ type: 'task_started', turn_id: 'current' }, 30_000) +
  '\n' +
  childEvent({ type: 'task_complete', turn_id: 'current', ...(completed ? {} : { error: CHILD_ERROR }) }, 24_000) +
  '\n';
const append = (body: string, ...payloads: Payload[]) =>
  body + payloads.map((p, i) => childEvent(p, 20_000 - i * 1000) + '\n').join('');
const activity = (kind: unknown = 'started', id = CHILD_ID): Payload => ({
  type: 'sub_agent_activity',
  event_id: 'fixture-activity',
  occurred_at_ms: CHILD_NOW - 20_000,
  agent_thread_id: id,
  agent_path: '/root/worker',
  kind,
  model: null,
  reasoning_effort: null,
});
const itemActivity = (wrapper: string, kind: unknown = 'started'): Payload => ({
  type: wrapper,
  thread_id: CHILD_THREAD,
  turn_id: 'current',
  ...(wrapper === 'item_started' ? { started_at_ms: CHILD_NOW - 20_000 } : { completed_at_ms: CHILD_NOW - 20_000 }),
  item: {
    type: 'SubAgentActivity',
    id: 'fixture-activity',
    agent_thread_id: CHILD_ID,
    agent_path: '/root/worker',
    kind,
    model: null,
    reasoning_effort: null,
  },
});
const permission: Payload = {
  type: 'request_permissions',
  call_id: 'fixture-permission',
  turn_id: 'current',
  started_at_ms: CHILD_NOW - 20_000,
  permissions: { network: { enabled: true }, file_system: null },
};
const vetoes = [
  { type: 'future_fixture_event' },
  permission,
  activity(),
  activity('interacted'),
  activity('interrupted'),
  itemActivity('item_started'),
  itemActivity('item_completed'),
  { type: 'item_completed', thread_id: CHILD_THREAD, turn_id: 'current', item: { type: 'FutureFixtureItem' } },
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(CHILD_NOW);
});
afterEach(() => vi.useRealTimers());

describe('unknown and pending event authority', () => {
  it.each(vetoes)('vetoes stale failed or completed turn after $type', (payload) => {
    for (const completed of [false, true])
      for (const screen of [CHILD_READY, null]) {
        const result = classifyCodexTail(append(failed(completed), payload), context(screen));
        expect(result.safeToAct).toBe(false);
        expect(['unknown', 'watching', 'paused']).toContain(result.activity);
      }
  });

  it.each([false, true])('preserves permission veto through later terminal output (completed=%s)', (completed) => {
    const result = classifyCodexTail(
      append(failed(), permission, {
        type: 'task_complete',
        turn_id: 'current',
        ...(completed ? {} : { error: CHILD_ERROR }),
      }),
      context()
    );
    expect(result).toMatchObject({ activity: 'paused', reason: 'approval-required', safeToAct: false });
  });

  it.each([false, true])('retains unknown evidence even before a later terminal event (completed=%s)', (completed) => {
    expect(
      classifyCodexTail(
        append(
          failed(),
          { type: 'future_fixture_event' },
          { type: 'task_complete', turn_id: 'current', ...(completed ? {} : { error: CHILD_ERROR }) }
        ),
        context()
      )
    ).toMatchObject({ activity: 'unknown', safeToAct: false });
  });

  it.each([
    { type: 'agent_message', message: 'Ordinary fixture output.' },
    { type: 'agent_reasoning', text: 'Ordinary fixture reasoning.' },
    { type: 'agent_reasoning_raw_content', text: 'Fixture content.' },
    { type: 'agent_reasoning_section_break', item_id: 'fixture', summary_index: 0 },
    { type: 'token_count', info: null, rate_limits: null },
  ])('retains genuine failure through known passive $type', (payload) => {
    expect(classifyCodexTail(append(failed(), payload), context()).safeToAct).toBe(true);
  });

  it.each(vetoes.flatMap((payload) => [false, true].map((dead) => ({ payload, dead }))))(
    'actual owned adapter/controller refuses $payload.type (dead=$dead)',
    async ({ payload, dead }) => {
      const f = await createChildLifecycleFixture(append(failed(), payload), dead);
      try {
        expect((await f.adapter.observe()).safeToAct).toBe(false);
        await f.controller.retry();
        expect(f.delivered).not.toHaveBeenCalled();
        expect(f.controller.getStatus().inFlight).toBeUndefined();
      } finally {
        await f.cleanup();
      }
    }
  );

  it.each([false, true])('actual completed activity permits exact owned recovery (dead=%s)', async (dead) => {
    const f = await createChildLifecycleFixture(
      append(failed(), activity(), {
        ...activity('completed'),
        event_id: 'completed-child',
        occurred_at_ms: CHILD_NOW - 19_000,
      }),
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
      expect(f.delivered.mock.calls[0][0]).toMatchObject({
        action: dead ? 'restart' : 'continue',
        conversationId: CHILD_THREAD,
      });
    } finally {
      await f.cleanup();
    }
  });

  it.each([false, true])(
    'final adapter reread vetoes new child or permission/unknown control (dead=%s)',
    async (dead) => {
      for (const payload of [permission, activity(), { type: 'future_fixture_event' }]) {
        const f = await createChildLifecycleFixture(failed(), dead);
        try {
          const before = await f.adapter.observe();
          expect(before.safeToAct).toBe(true);
          const path = join(
            f.session.getRecoveryContext().codexHome!,
            'sessions',
            `rollout-2026-10-13T12-00-00-${CHILD_THREAD}.jsonl`
          );
          await fs.appendFile(path, childEvent(payload, 10_000) + '\n');
          expect(
            await f.adapter.act({
              key: before.evidenceKey!,
              conversationId: CHILD_THREAD,
              action: dead ? 'restart' : 'continue',
              startedAt: CHILD_NOW,
            })
          ).toBe('not-sent');
          expect(f.delivered).not.toHaveBeenCalled();
        } finally {
          await f.cleanup();
        }
      }
    }
  );
});

describe('path-based child lifecycle', () => {
  it.each(['sub_agent_activity', 'item_started', 'item_completed'])(
    'releases only actual completed kind in %s',
    (wrapper) => {
      const started = wrapper === 'sub_agent_activity' ? activity() : itemActivity(wrapper);
      const completed =
        wrapper === 'sub_agent_activity'
          ? { ...activity('completed'), event_id: 'fixture-completed', occurred_at_ms: CHILD_NOW - 19_000 }
          : {
              ...itemActivity(wrapper, 'completed'),
              started_at_ms: CHILD_NOW - 19_000,
              completed_at_ms: CHILD_NOW - 19_000,
            };
      expect(classifyCodexTail(append(failed(), started, completed), context()).safeToAct).toBe(true);
    }
  );

  it('does not release another child or a reused child with an older completion', () => {
    expect(
      classifyCodexTail(
        append(failed(), activity(), {
          ...activity('completed', '019a5aa0-3333-7333-8333-333333333333'),
          occurred_at_ms: CHILD_NOW - 19_000,
        }),
        context()
      )
    ).toMatchObject({ activity: 'watching', safeToAct: false });
    expect(
      classifyCodexTail(
        append(failed(), activity(), { ...activity('completed'), occurred_at_ms: CHILD_NOW - 21_000 }),
        context()
      )
    ).toMatchObject({ activity: 'unknown', safeToAct: false });
  });

  it.each([
    { kind: 'future-kind' },
    { kind: null },
    { agent_thread_id: '../child' },
    { agent_thread_id: '' },
    { agent_path: '/root/../worker' },
    { agent_path: '/root/root' },
    { agent_path: '/root/UPPER' },
    { occurred_at_ms: 'later' },
    { occurred_at_ms: CHILD_NOW + 3000 },
    { event_id: null },
  ])('malformed activity cannot release pending work: %j', (patch) => {
    expect(
      classifyCodexTail(append(failed(), activity(), { ...activity('completed'), ...patch }), context())
    ).toMatchObject({ activity: 'unknown', safeToAct: false });
  });

  it.each([
    { thread_id: '019a5aa0-3333-7333-8333-333333333333' },
    { turn_id: 'other-turn' },
    { completed_at_ms: 0 },
    { completed_at_ms: CHILD_NOW + 3000 },
    { started_at_ms: CHILD_NOW },
    { item: { type: 'SubAgentActivity' } },
  ])('malformed wrapper cannot release a child: %j', (patch) => {
    expect(
      classifyCodexTail(
        append(failed(), activity(), { ...itemActivity('item_completed', 'completed'), ...patch }),
        context()
      )
    ).toMatchObject({ activity: 'unknown', safeToAct: false });
  });

  it('accepts canonical nested/root/morpheus paths without guessing malformed paths', () => {
    for (const agent_path of ['/root', '/root/worker_2/nested3', '/morpheus']) {
      expect(classifyCodexTail(append(failed(), { ...activity('completed'), agent_path }), context()).safeToAct).toBe(
        true
      );
    }
  });

  it.each([
    { type: 'agent_message', message: null },
    { type: 'agent_reasoning', text: [] },
    { type: 'agent_reasoning_section_break', summary_index: -1 },
    { type: 'token_count', info: false, rate_limits: null },
  ])('malformed passive event cannot retain failure: %j', (payload) => {
    expect(classifyCodexTail(append(failed(), payload), context())).toMatchObject({
      activity: 'unknown',
      safeToAct: false,
    });
  });

  it('interacted/interrupted reactivate an already completed child', () => {
    for (const kind of ['interacted', 'interrupted']) {
      expect(
        classifyCodexTail(
          append(failed(), activity('completed'), { ...activity(kind), occurred_at_ms: CHILD_NOW - 19_000 }),
          context()
        )
      ).toMatchObject({ activity: 'watching', safeToAct: false });
    }
  });
});

const command = {
  call_id: 'command-fixture',
  turn_id: 'current',
  command: ['sh', '-c', 'printf fixture'],
  cwd: '/fixture/workspace',
  parsed_cmd: [{ type: 'unknown', cmd: 'printf fixture' }],
  source: 'agent',
};
const beginCommand: Payload = { ...command, type: 'exec_command_begin', started_at_ms: CHILD_NOW - 23_000 };
const endCommand: Payload = {
  ...command,
  type: 'exec_command_end',
  completed_at_ms: CHILD_NOW - 22_000,
  aggregated_output: 'fixture',
  exit_code: 0,
  duration: { secs: 1, nanos: 0 },
  status: 'completed',
};
const commandTail = () =>
  childEvent({ type: 'task_started', turn_id: 'current' }, 30_000) +
  '\n' +
  childEvent(beginCommand, 23_000) +
  '\n' +
  childEvent(endCommand, 22_000) +
  '\n' +
  childEvent({ type: 'task_complete', turn_id: 'current', error: CHILD_ERROR }, 21_000) +
  '\n';

describe('recognized bounded ordinary command lifecycle', () => {
  it.each([false, true])('genuine command-bearing failure stays recoverable (dead=%s)', async (dead) => {
    const f = await createChildLifecycleFixture(commandTail(), dead);
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

  it.each([
    { call_id: 'another-call' },
    { turn_id: 'another-turn' },
    { command: ['different'] },
    { cwd: [] },
    { parsed_cmd: [{ type: 'future-command', cmd: 'fixture' }] },
    { source: false },
    { completed_at_ms: CHILD_NOW - 24_000 },
    { completed_at_ms: CHILD_NOW + 3000 },
    { exit_code: '0' },
    { status: 'running' },
    { duration: { secs: 0, nanos: 1e9 } },
  ])('malformed/unpaired command cannot be superseded by terminal failure: %j', (patch) => {
    const body =
      childEvent({ type: 'task_started', turn_id: 'current' }, 30_000) +
      '\n' +
      childEvent(beginCommand, 23_000) +
      '\n' +
      childEvent({ ...endCommand, ...patch }, 22_000) +
      '\n' +
      childEvent({ type: 'task_complete', turn_id: 'current', error: CHILD_ERROR }, 21_000) +
      '\n';
    expect(classifyCodexTail(body, context())).toMatchObject({ activity: 'unknown', safeToAct: false });
  });

  it.each([false, true])('open command retains pending-work veto on an owned pane (dead=%s)', async (dead) => {
    const body = append(
      failed(),
      { ...beginCommand, started_at_ms: CHILD_NOW - 20_000 },
      { type: 'task_complete', turn_id: 'current', error: CHILD_ERROR }
    );
    const f = await createChildLifecycleFixture(body, dead);
    try {
      expect(await f.adapter.observe()).toMatchObject({ activity: 'watching', safeToAct: false });
      await f.controller.retry();
      expect(f.delivered).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  });

  it('a new paired execution clears prior failure until another terminal turn', () => {
    expect(
      classifyCodexTail(
        append(
          failed(),
          { ...beginCommand, started_at_ms: CHILD_NOW - 20_000 },
          { ...endCommand, completed_at_ms: CHILD_NOW - 19_000 }
        ),
        context()
      )
    ).toMatchObject({ activity: 'working', safeToAct: false });
  });

  it('accepts only valid output for an open matching command', () => {
    const start =
      childEvent({ type: 'task_started', turn_id: 'current' }, 30_000) + '\n' + childEvent(beginCommand, 23_000) + '\n';
    for (const patch of [{}, { call_id: 'other' }, { chunk: '%%%bad' }, { stream: 'future-stream' }]) {
      const body =
        append(start, {
          type: 'exec_command_output_delta',
          call_id: command.call_id,
          stream: 'stdout',
          chunk: 'Zml4dHVyZQ==',
          ...patch,
        }) +
        childEvent(endCommand, 19_000) +
        '\n' +
        childEvent({ type: 'task_complete', turn_id: 'current', error: CHILD_ERROR }, 18_000) +
        '\n';
      expect(classifyCodexTail(body, context()).safeToAct).toBe(Object.keys(patch).length === 0);
    }
  });
});

describe('recognized passive v2 item shapes', () => {
  it.each([
    { type: 'AgentMessage', content: [{ type: 'Text', text: 'Fixture output' }] },
    { type: 'Plan', text: 'Fixture plan' },
    { type: 'Reasoning', summary_text: ['Fixture summary'], raw_content: [] },
  ])('allows complete $type output without treating prose as action evidence', (item) => {
    const payload = {
      type: 'item_completed',
      thread_id: CHILD_THREAD,
      turn_id: 'current',
      completed_at_ms: CHILD_NOW - 20_000,
      item: { id: 'fixture-item', ...item },
    };
    expect(classifyCodexTail(append(failed(), payload), context()).safeToAct).toBe(true);
    expect(
      classifyCodexTail(
        append(failed(), { ...payload, type: 'item_started', started_at_ms: CHILD_NOW - 20_000 }),
        context()
      )
    ).toMatchObject({ activity: 'working', safeToAct: false });
    expect(
      classifyCodexTail(append(failed(), { ...payload, item: { id: 'fixture-item', type: item.type } }), context())
    ).toMatchObject({ activity: 'unknown', safeToAct: false });
  });
});

const usage = {
  input_tokens: 10,
  cached_input_tokens: 0,
  output_tokens: 2,
  reasoning_output_tokens: 0,
  total_tokens: 12,
};
const quota: Payload = {
  limit_id: null,
  limit_name: null,
  primary: { used_percent: 10, window_minutes: 300, resets_at: 1800000000 },
  secondary: null,
  credits: { has_credits: true, unlimited: false, balance: '10' },
  individual_limit: null,
  spend_control_reached: false,
  plan_type: null,
  rate_limit_reached_type: null,
};
describe('passive metadata remains bounded and retains relevant limit vetoes', () => {
  it('recognizes real usage and ordinary current rate snapshots', () => {
    expect(
      classifyCodexTail(
        append(failed(), {
          type: 'token_count',
          info: { total_token_usage: usage, last_token_usage: usage, model_context_window: 100000 },
          rate_limits: quota,
        }),
        context()
      ).safeToAct
    ).toBe(true);
  });

  it.each([
    { primary: { used_percent: 100, window_minutes: 300, resets_at: 1800000000 } },
    { spend_control_reached: true },
    { rate_limit_reached_type: 'workspace_member_usage_limit_reached' },
    { credits: { has_credits: false, unlimited: false, balance: '0' } },
    { individual_limit: { limit: '10', used: '10', remaining_percent: 0, resets_at: 1800000000 } },
  ])('terminal rows cannot clear a current usage veto: %j', (patch) => {
    for (const screen of [CHILD_READY, null]) {
      expect(
        classifyCodexTail(
          append(
            failed(),
            { type: 'token_count', info: null, rate_limits: { ...quota, ...patch } },
            { type: 'task_complete', turn_id: 'current', error: CHILD_ERROR }
          ),
          context(screen)
        )
      ).toMatchObject({ activity: 'blocked', reason: 'usage-limit', safeToAct: false });
    }
  });

  it.each([
    { primary: { used_percent: '0' } },
    { spend_control_reached: 'false' },
    { rate_limit_reached_type: ['rate_limit_reached'] },
    { credits: { has_credits: 1, unlimited: false } },
    { individual_limit: { remaining_percent: 100 } },
  ])('malformed usage snapshot cannot authorize: %j', (patch) => {
    expect(
      classifyCodexTail(
        append(failed(), { type: 'token_count', info: null, rate_limits: { ...quota, ...patch } }),
        context()
      )
    ).toMatchObject({ activity: 'unknown', safeToAct: false });
  });

  it.each(['agent_message_content_delta', 'plan_delta', 'reasoning_content_delta', 'reasoning_raw_content_delta'])(
    'recognizes only well-formed current %s output',
    (type) => {
      const payload = {
        type,
        thread_id: CHILD_THREAD,
        turn_id: 'current',
        item_id: 'fixture-output',
        delta: 'fixture',
        summary_index: 0,
        content_index: 0,
      };
      expect(classifyCodexTail(append(failed(), payload), context()).safeToAct).toBe(true);
      for (const patch of [{ delta: false }, { thread_id: CHILD_ID }, { turn_id: 'other' }, { content_index: [] }]) {
        expect(classifyCodexTail(append(failed(), { ...payload, ...patch }), context())).toMatchObject({
          activity: 'unknown',
          safeToAct: false,
        });
      }
    }
  );

  it.each([
    { source: ['agent'] },
    { status: ['completed'] },
    { parsed_cmd: [{ type: 'read', cmd: 'x' }] },
    { duration: { secs: false, nanos: 0 } },
  ])('coercible malformed command fields stay unknown: %j', (patch) => {
    const body =
      childEvent({ type: 'task_started', turn_id: 'current' }, 30_000) +
      '\n' +
      childEvent({ ...beginCommand, ...(Object.hasOwn(patch, 'source') ? patch : {}) }, 23_000) +
      '\n' +
      childEvent({ ...endCommand, ...patch }, 22_000) +
      '\n' +
      childEvent({ type: 'task_complete', turn_id: 'current', error: CHILD_ERROR }, 21_000) +
      '\n';
    expect(classifyCodexTail(body, context())).toMatchObject({ activity: 'unknown', safeToAct: false });
  });
});
