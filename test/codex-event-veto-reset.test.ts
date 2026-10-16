/** Every reset path retains causal owner intent and unresolved account/configuration limits. */
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyCodexTail } from '../src/recovery/codex-classifier.js';
import {
  CHILD_ERROR,
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
const row = (payload: Payload, age: number) => childEvent(payload, age) + '\n';
const started = row({ type: 'task_started', turn_id: 'current' }, 30_000);
const failed = row({ type: 'task_complete', turn_id: 'current', error: CHILD_ERROR }, 10_000);
const context = (screen: string | null = CHILD_READY) => ({
  conversationId: CHILD_THREAD,
  now: CHILD_NOW,
  screen,
  busy: false,
  watching: false,
  tailTruncated: false,
});
const prompt = (wrapped = false, nativeAge = 19_000): Payload =>
  wrapped
    ? {
        type: 'item_completed',
        thread_id: CHILD_THREAD,
        turn_id: 'next',
        completed_at_ms: CHILD_NOW - nativeAge,
        item: { type: 'UserMessage', id: 'owner-next', content: [{ type: 'text', text: 'New owner fixture prompt' }] },
      }
    : { type: 'user_message', message: 'New owner fixture prompt', local_images: [] };
const command = {
  call_id: 'reset-command',
  turn_id: 'current',
  command: ['sh', '-c', 'printf fixture'],
  cwd: '/fixture',
  parsed_cmd: [],
  source: 'agent',
};
const commands = (status = 'completed') =>
  row({ ...command, type: 'exec_command_begin', started_at_ms: CHILD_NOW - 18_000 }, 18_000) +
  row(
    {
      ...command,
      type: 'exec_command_end',
      completed_at_ms: CHILD_NOW - 17_000,
      status,
      exit_code: 0,
      duration: { secs: 1, nanos: 0 },
      aggregated_output: '',
    },
    17_000
  );
const ownerVetoes = [
  ...[
    'exec_approval_request',
    'apply_patch_approval_request',
    'elicitation_request',
    'request_user_input',
    'request_permissions',
  ].map((type) => ({
    name: type,
    body: row({ type, call_id: 'owner-veto', turn_id: 'current', started_at_ms: CHILD_NOW - 20_000 }, 20_000),
  })),
  ...['replaced', 'review_ended', 'interrupted'].map((reason) => ({
    name: `owner-${reason}`,
    body: row({ type: 'turn_aborted', turn_id: 'current', reason, completed_at: (CHILD_NOW - 20_000) / 1000 }, 20_000),
  })),
  { name: 'declined', body: commands('declined') },
];
const stickyVetoes = [
  ...['thread_rollback_failed', { active_turn_not_steerable: { turn_kind: 'review' } }].map((codex_error_info, i) => ({
    name: `uncertain-control-${i}`,
    body: row({ type: 'error', message: 'Fixture uncertain control outcome', codex_error_info }, 20_000),
  })),
  ...['unauthorized', 'usage_limit_exceeded', 'rate_limit_exceeded', 'session_budget_exceeded', 'other'].map(
    (codex_error_info) => ({
      name: codex_error_info,
      body: row({ type: 'error', message: 'Fixture account/configuration condition', codex_error_info }, 20_000),
    })
  ),
  { name: 'budget-abort', body: row({ type: 'turn_aborted', turn_id: 'current', reason: 'budget_limited' }, 20_000) },
  ...[
    { spend_control_reached: true },
    { rate_limit_reached_type: 'rate_limit_reached' },
    { primary: { used_percent: 100, window_minutes: 300, resets_at: 1800000000 } },
    { credits: { has_credits: false, unlimited: false, balance: '0' } },
    { individual_limit: { limit: '10', used: '10', remaining_percent: 0, resets_at: 1800000000 } },
  ].map((rate_limits, i) => ({
    name: `quota-${i}`,
    body: row({ type: 'token_count', info: null, rate_limits }, 20_000),
  })),
];
const resets = [
  { name: 'task-start', body: row({ type: 'task_started', turn_id: 'current' }, 16_000) },
  { name: 'turn-start', body: row({ type: 'turn_started', turn_id: 'current' }, 16_000) },
  { name: 'owner-prompt', body: row(prompt(), 16_000) + row({ type: 'task_started', turn_id: 'current' }, 15_000) },
  {
    name: 'owner-item',
    body: row(prompt(true, 16_000), 16_000) + row({ type: 'task_started', turn_id: 'current' }, 15_000),
  },
  { name: 'provider-retry', body: row({ type: 'stream_error', message: 'Fixture provider retry' }, 16_000) },
  {
    name: 'auth-retry',
    body: row({ type: 'auth_recovery_started', provider: 'fixture', message: 'Fixture auth retry' }, 16_000),
  },
  { name: 'command-pair', body: commands() },
  {
    name: 'agent-item',
    body: row(
      {
        type: 'item_started',
        thread_id: CHILD_THREAD,
        turn_id: 'current',
        started_at_ms: CHILD_NOW - 16_000,
        item: { type: 'AgentMessage', id: 'output-fixture', content: [{ type: 'Text', text: 'Fixture output' }] },
      },
      16_000
    ),
  },
  { name: 'terminal-complete', body: row({ type: 'task_complete', turn_id: 'current' }, 16_000) },
  {
    name: 'terminal-interruption',
    body: row({ type: 'turn_aborted', turn_id: 'current', reason: 'interrupted', error: CHILD_ERROR }, 16_000),
  },
  { name: 'no-limit-claim', body: row({ type: 'token_count', info: null, rate_limits: null }, 16_000) },
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(CHILD_NOW);
});
afterEach(() => vi.useRealTimers());

describe('causal owner intent clearance', () => {
  it.each(ownerVetoes)('$name cannot be cleared by older/equal owner intent or worker reset paths', ({ body }) => {
    for (const wrapped of [false, true])
      for (const age of [25_000, 20_000]) {
        // Decline occurs at -17s, so these prompts are stale too.
        for (const screen of [CHILD_READY, null]) {
          const old = row(prompt(wrapped, age), age);
          const result = classifyCodexTail(
            started + body + old + row({ type: 'task_started', turn_id: 'current' }, 14_000) + failed,
            context(screen)
          );
          expect(result.safeToAct).toBe(false);
          expect(['unknown', 'paused']).toContain(result.activity);
        }
      }
    for (const reset of resets.filter((r) => !r.name.startsWith('owner-'))) {
      expect(classifyCodexTail(started + body + reset.body + failed, context()).safeToAct).toBe(false);
    }
  });

  it.each(ownerVetoes)('$name permits only a genuinely newer well-formed owner prompt', ({ body }) => {
    for (const wrapped of [false, true]) {
      const next = row(prompt(wrapped, 14_000), 14_000) + row({ type: 'task_started', turn_id: 'current' }, 13_000);
      expect(classifyCodexTail(started + body + next + failed, context()).safeToAct).toBe(true);
    }
  });

  it('uses native request/decline time and both item/row times, rather than append order', () => {
    const native = row(
      { type: 'request_permissions', call_id: 'native-veto', started_at_ms: CHILD_NOW - 18_000 },
      20_000
    );
    for (const [owner, age] of [
      [prompt(), 19_000],
      [prompt(), 18_000],
      [prompt(true, 19_000), 17_000],
      [prompt(true, 17_000), 19_000],
    ] as const) {
      expect(
        classifyCodexTail(
          started + native + row(owner, age) + row({ type: 'task_started', turn_id: 'current' }, 13_000) + failed,
          context()
        ).safeToAct
      ).toBe(false);
    }
    expect(
      classifyCodexTail(
        started + native + row(prompt(), 17_000) + row({ type: 'task_started', turn_id: 'current' }, 13_000) + failed,
        context()
      ).safeToAct
    ).toBe(true);
  });

  it('latest auth/account veto also fences old owner intent while preserving its stronger veto', () => {
    const body =
      started +
      ownerVetoes[0].body +
      row({ type: 'error', message: 'Sign in', codex_error_info: 'unauthorized' }, 15_000) +
      row(prompt(), 18_000) +
      row({ type: 'task_started', turn_id: 'current' }, 13_000) +
      failed;
    expect(classifyCodexTail(body, context()).safeToAct).toBe(false);
  });

  it.each([undefined, 'not-a-time'])('missing/malformed owner timestamp cannot clear a veto (%j)', (timestamp) => {
    const raw = JSON.stringify({ type: 'event_msg', payload: prompt(), timestamp }) + '\n';
    expect(classifyCodexTail(started + ownerVetoes[0].body + raw + failed, context())).toMatchObject({
      activity: 'unknown',
      safeToAct: false,
    });
  });
});

describe('no inferred account/configuration clearance', () => {
  it.each(stickyVetoes)('$name survives every currently recognized reset branch', ({ body }) => {
    for (const reset of resets)
      for (const screen of [CHILD_READY, null]) {
        const result = classifyCodexTail(started + body + reset.body + failed, context(screen));
        expect(result.safeToAct).toBe(false);
        expect(['blocked', 'unknown']).toContain(result.activity);
      }
  });

  it.each([...ownerVetoes, ...stickyVetoes].flatMap((veto) => [false, true].map((dead) => ({ ...veto, dead }))))(
    'actual owned adapter/controller retains $name veto (dead=$dead)',
    async ({ body, dead, name }) => {
      const staleOwner = row(prompt(), 25_000) + row({ type: 'task_started', turn_id: 'current' }, 14_000);
      const reset = ownerVetoes.some((v) => v.name === name) ? staleOwner : resets[2].body;
      const f = await createChildLifecycleFixture(started + body + reset + failed, dead);
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

  it.each([...ownerVetoes, ...stickyVetoes].flatMap((veto) => [false, true].map((dead) => ({ ...veto, dead }))))(
    'final adapter reread retains new $name veto despite reset records (dead=$dead)',
    async ({ body, dead, name }) => {
      const f = await createChildLifecycleFixture(started + failed, dead);
      try {
        const before = await f.adapter.observe();
        expect(before.safeToAct).toBe(true);
        const path = join(
          f.session.getRecoveryContext().codexHome!,
          'sessions',
          `rollout-2026-10-13T12-00-00-${CHILD_THREAD}.jsonl`
        );
        const reset = ownerVetoes.some((v) => v.name === name)
          ? row(prompt(), 25_000) + resets[0].body
          : resets[2].body;
        await fs.appendFile(
          path,
          body + reset + row({ type: 'task_complete', turn_id: 'current', error: CHILD_ERROR }, 5_000)
        );
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
  );
});

it('native decline time and native owner abort time both fence queued older owner prompts', () => {
  const declined =
    row({ ...command, type: 'exec_command_begin', started_at_ms: CHILD_NOW - 19_000 }, 19_000) +
    row(
      {
        ...command,
        type: 'exec_command_end',
        completed_at_ms: CHILD_NOW - 16_000,
        status: 'declined',
        exit_code: 0,
        duration: { secs: 1, nanos: 0 },
        aggregated_output: '',
      },
      17_000
    );
  const stopped = row(
    { type: 'turn_aborted', turn_id: 'current', reason: 'replaced', completed_at: (CHILD_NOW - 16_000) / 1000 },
    17_000
  );
  for (const body of [declined, stopped])
    for (const age of [17_000, 16_000, 15_000]) {
      const result = classifyCodexTail(
        started + body + row(prompt(), age) + row({ type: 'task_started', turn_id: 'current' }, 13_000) + failed,
        context()
      );
      expect(result.safeToAct).toBe(age === 15_000);
    }
});

it.each([
  { completed_at_ms: undefined },
  { completed_at_ms: 'fresh' },
  { completed_at_ms: 0 },
  { started_at_ms: CHILD_NOW },
  { started_at_ms: false },
  { completed_at_ms: CHILD_NOW + 3000 },
])('malformed native owner item evidence cannot clear a current veto: %j', (patch) => {
  const body =
    started +
    ownerVetoes[0].body +
    row({ ...prompt(true, 14_000), ...patch }, 14_000) +
    row({ type: 'task_started', turn_id: 'current' }, 13_000) +
    failed;
  expect(classifyCodexTail(body, context())).toMatchObject({ activity: 'unknown', safeToAct: false });
});

it.each(['thread_rollback_failed', { active_turn_not_steerable: { turn_kind: 'review' } }])(
  'direct completed/failed terminal rows cannot certify an uncertain control outcome: %j',
  (codex_error_info) => {
    for (const error of [undefined, CHILD_ERROR])
      for (const screen of [CHILD_READY, null]) {
        const body =
          started +
          row({ type: 'error', message: 'Fixture uncertain control outcome', codex_error_info }, 20_000) +
          row({ type: 'task_complete', turn_id: 'current', ...(error ? { error } : {}) }, 10_000);
        expect(classifyCodexTail(body, context(screen))).toMatchObject({ activity: 'unknown', safeToAct: false });
      }
  }
);

it('genuine completed and failed turns stay distinguishable when no uncertain control exists', () => {
  expect(
    classifyCodexTail(started + row({ type: 'task_complete', turn_id: 'current' }, 10_000), context())
  ).toMatchObject({ activity: 'completed', safeToAct: false });
  expect(classifyCodexTail(started + failed, context())).toMatchObject({ activity: 'interrupted', safeToAct: true });
});
