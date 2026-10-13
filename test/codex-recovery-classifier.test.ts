/**
 * @fileoverview Sanitized recovery classifier fixtures matching openai/codex rust-v0.162.1.
 * protocol.rs defines the task_started/task_complete aliases, optional terminal ErrorEvent,
 * TurnAborted reason/optional turn_id, StreamError retry progress and collab status events.
 * These are behavioral assertions, never terminal prose used as action authority.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  classifyCodexTail,
  hasEmptyCodexComposer,
  type CodexClassificationContext,
} from '../src/recovery/codex-classifier.js';

const NOW = Date.UTC(2026, 9, 13, 12);
const THREAD = '019a5aa0-1111-7111-8111-111111111111';
const AGENT = '019a5aa0-2222-7222-8222-222222222222';
const TURN = 'turn-fixture';
const READY = '  Fixture result\n\n› \n  fixture-model default · /fixture/workspace\n  ? for shortcuts\n';
const INTERRUPTED = { message: 'Conversation interrupted.', codex_error_info: null };
type Payload = Record<string, unknown>;

function context(patch: Partial<CodexClassificationContext> = {}): CodexClassificationContext {
  return { conversationId: THREAD, now: NOW, screen: READY, busy: false, watching: false, ...patch };
}

function line(payload: Payload, at = NOW - 10_000): string {
  return JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload });
}

function tail(...payloads: Payload[]): string {
  return payloads.map((payload, i) => line(payload, NOW - 10_000 + i * 1000)).join('\n') + '\n';
}

function start(turnId = TURN, type = 'task_started'): Payload {
  return { type, turn_id: turnId, model_context_window: null };
}

function complete(error?: unknown, turnId = TURN, type = 'task_complete'): Payload {
  return { type, turn_id: turnId, last_agent_message: null, ...(error === undefined ? {} : { error }) };
}

function failed(...after: Payload[]): string {
  return tail(start(), complete(INTERRUPTED), ...after);
}

describe('official Codex turn lifecycle shapes', () => {
  it.each([
    ['task_started', 'task_complete'],
    ['turn_started', 'turn_complete'],
  ])('reads %s/%s and distinguishes active from successfully completed', (started, completed) => {
    expect(classifyCodexTail(tail(start(TURN, started)), context())).toMatchObject({
      activity: 'working',
      reason: 'turn-running',
      turnId: TURN,
      safeToAct: false,
    });
    expect(
      classifyCodexTail(tail(start(TURN, started), complete(undefined, TURN, completed)), context())
    ).toMatchObject({
      activity: 'completed',
      reason: 'turn-completed',
      turnId: TURN,
      safeToAct: false,
    });
  });

  it('reads optional task_complete.error as a failed current turn', () => {
    const result = classifyCodexTail(failed(), context());
    expect(result).toMatchObject({
      activity: 'interrupted',
      reason: 'turn-interrupted',
      turnId: TURN,
      safeToAct: true,
    });
    expect(result.evidenceKey).toContain(`${THREAD}:${TURN}:`);
  });

  it('does not act on an idle composer with no structured failure', () => {
    expect(classifyCodexTail('', context()).safeToAct).toBe(false);
    expect(
      classifyCodexTail(tail({ type: 'agent_message', message: 'The fixture is complete.' }), context()).safeToAct
    ).toBe(false);
  });

  it('allows a legacy terminal ErrorEvent followed by task_complete without error', () => {
    expect(classifyCodexTail(tail(start(), { type: 'error', ...INTERRUPTED }, complete()), context())).toMatchObject({
      activity: 'interrupted',
      safeToAct: true,
    });
  });

  it('requires the current turn start within the bounded tail', () => {
    expect(classifyCodexTail(tail(complete(INTERRUPTED)), context())).toMatchObject({ safeToAct: false });
    expect(classifyCodexTail(tail({ type: 'error', ...INTERRUPTED }), context())).toMatchObject({ safeToAct: false });
    expect(classifyCodexTail(tail({ type: 'task_started' }, complete(INTERRUPTED)), context())).toMatchObject({
      safeToAct: false,
    });
  });

  it('refuses a terminal event for a different turn', () => {
    expect(classifyCodexTail(tail(start(), complete(INTERRUPTED, 'different-turn')), context())).toMatchObject({
      activity: 'unknown',
      safeToAct: false,
    });
  });

  it('does not carry an earlier failure into a new started turn', () => {
    expect(classifyCodexTail(failed(start('new-turn')), context())).toMatchObject({
      activity: 'working',
      turnId: 'new-turn',
      safeToAct: false,
    });
    expect(classifyCodexTail(failed(start('new-turn'), complete(undefined, 'new-turn')), context())).toMatchObject({
      activity: 'completed',
      turnId: 'new-turn',
      safeToAct: false,
    });
  });

  it.each(['user_message', 'item_completed'])(
    'a new %s invalidates older failure authority before task_started arrives',
    (type) => {
      const next: Payload =
        type === 'user_message'
          ? { type, message: 'Sanitized next fixture request.', local_images: [] }
          : {
              type,
              thread_id: THREAD,
              turn_id: 'new-turn',
              completed_at_ms: NOW - 7_000,
              item: {
                type: 'UserMessage',
                id: 'fixture-input',
                content: [{ type: 'text', text: 'Sanitized next fixture request.' }],
              },
            };
      expect(classifyCodexTail(failed(next), context()).safeToAct).toBe(false);
    }
  );

  it('tracks structured user-message identity without returning raw prompt content', () => {
    const input = { type: 'user_message', message: 'Sanitized fixture request.', local_images: [] };
    const result = classifyCodexTail(tail(input, start()), context());
    expect(result.submissionKey).toMatch(/^[a-f0-9]{64}$/);
    expect(result.submissionHash).toBe(createHash('sha256').update(input.message).digest('hex'));
    expect(JSON.stringify(result)).not.toContain(input.message);
  });
});

describe('interruptions and provider-owned recovery', () => {
  it('recovers TurnAborted interrupted only with an explicit terminal error', () => {
    expect(
      classifyCodexTail(
        tail(start(), { type: 'turn_aborted', turn_id: TURN, reason: 'interrupted', error: INTERRUPTED }),
        context()
      )
    ).toMatchObject({
      activity: 'interrupted',
      safeToAct: true,
    });
    expect(
      classifyCodexTail(tail(start(), { type: 'turn_aborted', turn_id: TURN, reason: 'interrupted' }), context())
    ).toMatchObject({
      activity: 'paused',
      reason: 'user-interrupted',
      safeToAct: false,
    });
  });

  it.each(['replaced', 'review_ended'])('treats %s as an intentional turn transition', (reason) => {
    expect(
      classifyCodexTail(tail(start(), { type: 'turn_aborted', turn_id: TURN, reason, error: INTERRUPTED }), context())
    ).toMatchObject({
      activity: 'paused',
      reason: 'user-interrupted',
      safeToAct: false,
    });
  });

  it('never restarts budget_limited or an optional-null abort turn id', () => {
    expect(
      classifyCodexTail(
        tail(start(), { type: 'turn_aborted', turn_id: TURN, reason: 'budget_limited', error: INTERRUPTED }),
        context()
      )
    ).toMatchObject({
      activity: 'blocked',
      reason: 'usage-limit',
      safeToAct: false,
    });
    expect(
      classifyCodexTail(tail(start(), { type: 'turn_aborted', turn_id: null, reason: 'interrupted' }), context())
        .safeToAct
    ).toBe(false);
  });

  it('keeps StreamError as active provider retry and discards earlier terminal-error authority', () => {
    const streamError = {
      type: 'stream_error',
      message: 'Sanitized reconnect attempt.',
      additional_details: null,
      codex_error_info: null,
    };
    expect(classifyCodexTail(tail(start(), streamError), context())).toMatchObject({
      activity: 'working',
      reason: 'internal-retry',
      safeToAct: false,
    });
    expect(
      classifyCodexTail(tail(start(), { type: 'error', ...INTERRUPTED }, streamError, complete()), context())
    ).toMatchObject({
      activity: 'completed',
      safeToAct: false,
    });
  });

  it('treats steer-instruction interruption as normal active work', () => {
    const steer = { message: 'Model interrupted to submit steer instructions.', codex_error_info: null };
    expect(classifyCodexTail(tail(start(), { type: 'error', ...steer }), context())).toMatchObject({
      activity: 'working',
      reason: 'internal-retry',
      safeToAct: false,
    });
  });

  it('leaves provider authentication recovery to the provider', () => {
    expect(
      classifyCodexTail(
        tail(start(), {
          type: 'auth_recovery_started',
          provider: 'fixture-provider',
          message: 'Sanitized auth recovery.',
        }),
        context()
      )
    ).toMatchObject({
      activity: 'working',
      reason: 'internal-retry',
      safeToAct: false,
    });
  });

  it('a recent user Escape vetoes otherwise verified interruption recovery', () => {
    expect(classifyCodexTail(failed(), context({ lastIntentionalStopAt: NOW - 8_000 }))).toMatchObject({
      activity: 'paused',
      reason: 'user-interrupted',
      safeToAct: false,
    });
  });
});

describe('approval, authentication and usage require attention', () => {
  it.each(['exec_approval_request', 'apply_patch_approval_request', 'elicitation_request', 'request_user_input'])(
    'does not act while %s is pending',
    (type) => {
      expect(classifyCodexTail(tail(start(), { type, call_id: 'fixture-call' }), context())).toMatchObject({
        activity: 'paused',
        reason: 'approval-required',
        safeToAct: false,
      });
    }
  );

  it.each(['usage_limit_exceeded', 'rate_limit_exceeded', 'session_budget_exceeded'])(
    'blocks %s',
    (codex_error_info) => {
      expect(
        classifyCodexTail(tail(start(), complete({ message: 'Sanitized limit.', codex_error_info })), context())
      ).toMatchObject({
        activity: 'blocked',
        reason: 'usage-limit',
        safeToAct: false,
      });
    }
  );

  it('blocks unauthorized and unknown configuration errors', () => {
    expect(
      classifyCodexTail(
        tail(start(), complete({ message: 'Sanitized sign-in requirement.', codex_error_info: 'unauthorized' })),
        context()
      )
    ).toMatchObject({
      activity: 'blocked',
      reason: 'authentication-required',
      safeToAct: false,
    });
    expect(
      classifyCodexTail(
        tail(start(), complete({ message: 'Sanitized configuration problem.', codex_error_info: 'other' })),
        context()
      )
    ).toMatchObject({
      activity: 'blocked',
      safeToAct: false,
    });
  });

  it('does not turn ActiveTurnNotSteerable or ThreadRollbackFailed into recovery failures', () => {
    for (const codex_error_info of [{ active_turn_not_steerable: { turn_kind: 'review' } }, 'thread_rollback_failed']) {
      expect(
        classifyCodexTail(
          tail(start(), { type: 'error', message: 'Sanitized rejected operation.', codex_error_info }),
          context()
        )
      ).toMatchObject({
        activity: 'working',
        safeToAct: false,
      });
    }
  });
});

describe('screen evidence may veto but never authorize recovery', () => {
  it('never treats assistant prose or terminal failure-looking text as a control event', () => {
    const prose = 'Conversation interrupted. Response stream disconnected. Please continue.';
    expect(classifyCodexTail(tail({ type: 'agent_message', message: prose }), context()).safeToAct).toBe(false);
    expect(classifyCodexTail('', context({ screen: `${prose}\n${READY}` })).safeToAct).toBe(false);
  });

  it.each([
    ['Sanitized sign in prompt', 'authentication-required'],
    ['Sanitized usage limit prompt', 'usage-limit'],
    ['Would you like to approve this fixture?', 'approval-required'],
    ['Working · esc to interrupt', 'turn-running'],
    ['Reconnecting...', 'turn-running'],
  ])('vetoes a failure when the current screen says %s', (screen, reason) => {
    expect(classifyCodexTail(failed(), context({ screen: `${screen}\n${READY}` }))).toMatchObject({
      reason,
      safeToAct: false,
    });
  });

  it('requires an empty current composer, a readable pane and no busy/watching signal', () => {
    for (const patch of [
      { screen: '› Unsent fixture draft\n' },
      { screen: null },
      { screen: 'No composer is visible\n' },
      { busy: true },
      { watching: true },
    ]) {
      expect(classifyCodexTail(failed(), context(patch)).safeToAct).toBe(false);
    }
  });

  it('reads the newest composer row and bounds the search to the footer', () => {
    expect(hasEmptyCodexComposer('› \n› Unsent fixture draft\n')).toBe(false);
    expect(hasEmptyCodexComposer('› Ask Codex to do anything\n')).toBe(true);
    expect(hasEmptyCodexComposer('› \na\nb\nc\nd\ne\nf\n')).toBe(false);
  });

  it.each([
    '›\n  unfinished second line\n  fixture-model high · /fixture/workspace\n',
    '› Ask Codex to do anything\n  unfinished second line\n',
    '›\n  fixture-model high · /fixture/workspace\n  additional draft\n',
    '›\n  unknown changed footer\n',
  ])('vetoes multiline drafts and unrecognized composer rows', (screen) => {
    expect(hasEmptyCodexComposer(screen)).toBe(false);
    expect(classifyCodexTail(failed(), context({ screen })).safeToAct).toBe(false);
  });

  it('accepts only the known model footer and optional shortcut hint after a blank composer', () => {
    expect(hasEmptyCodexComposer('›\n  fixture-model xhigh · /fixture/workspace\n')).toBe(true);
    expect(
      hasEmptyCodexComposer('›\n  fixture-model high · /fixture/workspace\n  ← for agents · ? for shortcuts\n')
    ).toBe(true);
  });
});

describe('background subagents', () => {
  const spawned: Payload = {
    type: 'collab_agent_spawn_end',
    call_id: 'fixture-spawn',
    sender_thread_id: THREAD,
    new_thread_id: AGENT,
    prompt: '',
    model: 'fixture-model',
    reasoning_effort: 'low',
    status: 'running',
  };

  it('does not recover over a spawned agent that is still running', () => {
    expect(classifyCodexTail(tail(start(), spawned, complete(INTERRUPTED)), context())).toMatchObject({
      activity: 'watching',
      reason: 'background-work',
      safeToAct: false,
    });
  });

  it.each([{ completed: null }, { errored: 'Sanitized failure.' }, 'shutdown', 'not_found'])(
    'clears terminal subagent status %j',
    (status) => {
      const waited: Payload = {
        type: 'collab_wait_end',
        sender_thread_id: THREAD,
        call_id: 'fixture-wait',
        statuses: { [AGENT]: status },
      };
      expect(classifyCodexTail(tail(start(), spawned, waited, complete(INTERRUPTED)), context()).safeToAct).toBe(true);
    }
  );
});

describe('unknown, corrupt and incomplete observations', () => {
  it('never acts on malformed JSON, a partial trailing row, an oversized tail or future events', () => {
    for (const data of [
      `${failed()}{broken}\n`,
      failed().slice(0, -1),
      'x'.repeat(262_145) + '\n',
      line(start(), NOW + 2_001) + '\n',
    ]) {
      expect(classifyCodexTail(data, context())).toMatchObject({ activity: 'unknown', safeToAct: false });
    }
  });

  it('an unreadable latest control payload cannot leave an earlier failure actionable', () => {
    const data = `${failed()}${JSON.stringify({ timestamp: new Date(NOW - 7_000).toISOString(), type: 'event_msg', payload: null })}\n`;
    expect(classifyCodexTail(data, context()).safeToAct).toBe(false);
  });

  it('does not authorize an ErrorEvent lacking the required message string', () => {
    const error = { codex_error_info: { response_stream_disconnected: { http_status_code: null } } };
    expect(classifyCodexTail(tail(start(), complete(error)), context()).safeToAct).toBe(false);
  });
});
