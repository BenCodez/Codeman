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
  permitsCodexManagerSetup,
  hasEmptyCodexComposer,
  hasCodexComposerText,
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
  return {
    conversationId: THREAD,
    now: NOW,
    screen: READY,
    busy: false,
    watching: false,
    tailTruncated: false,
    ...patch,
  };
}

function line(payload: Payload, at = NOW - 10_000): string {
  // These lifecycle positives model native timestamps and the exact sender;
  // an explicit undefined override still models a missing evidence field.
  if (typeof payload.type === 'string' && payload.type.startsWith('collab_')) {
    payload = {
      sender_thread_id: THREAD,
      call_id: 'fixture-child-call',
      [payload.type.endsWith('_begin') ? 'started_at_ms' : 'completed_at_ms']: at,
      ...payload,
    };
  }
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
  it('vetoes unresolved structured child work even when the parent pane has no screen', () => {
    const pending = tail(start(), { type: 'collab_agent_spawn_end', new_thread_id: AGENT });
    expect(classifyCodexTail(pending, context({ screen: null }))).toMatchObject({
      activity: 'watching',
      reason: 'background-work',
      safeToAct: false,
    });
    expect(classifyCodexTail(tail(start()), context({ screen: null, watching: true }))).toMatchObject({
      activity: 'watching',
      reason: 'background-work',
      safeToAct: false,
    });
    const settled = tail(
      start(),
      { type: 'collab_agent_spawn_end', new_thread_id: AGENT },
      { type: 'collab_wait_end', statuses: { [AGENT]: { completed: 'done' } } }
    );
    expect(classifyCodexTail(settled, context({ screen: null }))).toMatchObject({
      activity: 'working',
      reason: 'turn-running',
    });
  });
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

  it('identifies the same unfinished structured turn without making silence actionable', () => {
    const result = classifyCodexTail(tail(start()), context());
    expect(result).toMatchObject({
      activity: 'working',
      reason: 'turn-running',
      turnId: TURN,
      safeToAct: false,
    });
    expect(result.stallEvidenceKey).toBe(`${THREAD}:${TURN}:${NOW - 10_000}:stalled`);
    expect(classifyCodexTail(tail(start('next-turn')), context()).stallEvidenceKey).not.toBe(result.stallEvidenceKey);
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
        activity: 'unknown',
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
    expect(hasEmptyCodexComposer('› Ask Codex to do anything\n')).toBe(false);
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

  it.each([
    '› Exact pending text\n',
    '› Exact pending text owner edit\n  fixture-model high · /tmp\n',
    '› Exact pending text \n  fixture-model high · /tmp\n',
    '›  Exact pending text\n  fixture-model high · /tmp\n',
    '› Exact pending text\n\n  fixture-model high · /tmp\n',
    '› Exact pending text\n  multiline draft\n  fixture-model high · /tmp\n',
    '› Exact pending text\n  fixture-model high · /tmp\n  unknown footer\n',
    '› Exact pending text\n› Newest owner draft\n  fixture-model high · /tmp\n',
  ])('rejects ambiguous, incomplete or changed exact input acknowledgements: %j', (screen) => {
    expect(hasCodexComposerText(screen, 'Exact pending text')).toBe(false);
  });

  it.each(['Exact pending text', 'café 🧭 漢字', JSON.stringify({ objective: 'First\nSecond' })])(
    'requires the exact joined native composer and recognized footer: %j',
    (text) => {
      expect(hasCodexComposerText(`› ${text}\n  fixture-model high · /tmp\n\n`, text)).toBe(true);
      expect(hasCodexComposerText(`› ${text}\n  fixture-model high · /tmp\n  ? for shortcuts\n`, text)).toBe(true);
    }
  );
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

  it.each([true, undefined])('does not infer no live children when tailTruncated is %s', (tailTruncated) => {
    // This is also the retained suffix when an earlier spawn is outside the read window.
    expect(classifyCodexTail(failed(), context({ tailTruncated }))).toMatchObject({
      activity: 'interrupted',
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
  it.each([
    null,
    [],
    42,
    true,
    'text',
    {},
    { type: 42, payload: {} },
    { type: '', payload: {} },
    { type: 'event_msg' },
    { type: 'event_msg', payload: [] },
    { type: 'event_msg', payload: { type: '' } },
    { type: 'response_item', payload: null },
    { type: 'unsupported_variant', payload: {} },
  ])('never borrows an earlier failure across a malformed JSON envelope %j', (entry) => {
    const malformed = JSON.stringify(entry) + '\n';
    for (const data of [failed() + malformed, malformed + failed()]) {
      expect(classifyCodexTail(data, context())).toMatchObject({ activity: 'unknown', safeToAct: false });
    }
  });
  it('retains complete supported non-event records beside a genuine terminal failure', () => {
    const record =
      JSON.stringify({
        timestamp: new Date(NOW - 7000).toISOString(),
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [] },
      }) + '\n';
    expect(classifyCodexTail(failed() + record, context()).safeToAct).toBe(true);
  });

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

describe('error variant shape is required for recovery authority', () => {
  it.each([
    7,
    ['response_stream_disconnected'],
    { response_stream_disconnected: { http_status_code: null }, unauthorized: null },
    { response_stream_disconnected: null },
    { response_stream_disconnected: { http_status_code: '503' } },
    { response_stream_disconnected: { http_status_code: -1 } },
    { response_stream_disconnected: { http_status_code: 65536 } },
    { response_stream_disconnected: { http_status_code: 503, unknown: true } },
    'response_stream_disconnected',
    'unknown_variant',
  ])('refuses malformed/unsupported error info %j even with interruption prose', (codex_error_info) => {
    expect(
      classifyCodexTail(tail(start(), complete({ message: 'Conversation interrupted.', codex_error_info })), context())
    ).toMatchObject({ safeToAct: false });
  });

  it('refuses simultaneous conflicting error-info aliases', () => {
    expect(
      classifyCodexTail(
        tail(
          start(),
          complete({ message: 'Conversation interrupted.', codex_error_info: null, codexErrorInfo: 'Unauthorized' })
        ),
        context()
      ).safeToAct
    ).toBe(false);
  });

  it.each(['response_stream_disconnected', 'response_stream_connection_failed', 'response_too_many_failed_attempts'])(
    'allows the supported %s struct with an optional bounded status',
    (kind) => {
      for (const details of [{}, { http_status_code: null }, { http_status_code: 503 }]) {
        expect(
          classifyCodexTail(
            tail(start(), complete({ message: 'Sanitized stream failure.', codex_error_info: { [kind]: details } })),
            context()
          )
        ).toMatchObject({ activity: 'interrupted', safeToAct: true });
      }
    }
  );
});

describe('fresh uncertain control errors supersede failed-turn evidence', () => {
  it.each(['thread_rollback_failed', { active_turn_not_steerable: { turn_kind: 'review' } }])(
    'invalidates a previous recoverable failure for %j',
    (codex_error_info) => {
      expect(
        classifyCodexTail(
          tail(
            start(),
            { type: 'error', message: 'Conversation interrupted.', codex_error_info: null },
            { type: 'error', message: 'Sanitized control failure.', codex_error_info }
          ),
          context()
        )
      ).toMatchObject({ activity: 'unknown', safeToAct: false });
      expect(
        classifyCodexTail(
          tail(
            start(),
            { type: 'error', message: 'Conversation interrupted.', codex_error_info: null },
            { type: 'error', message: 'Sanitized control failure.', codex_error_info },
            complete()
          ),
          context()
        )
        // A completed row is not clearance for the earlier uncertain control outcome.
      ).toMatchObject({ activity: 'unknown', safeToAct: false });
    }
  );
});

describe('native thread settings ownership boundary', () => {
  const settings = () => ({
    type: 'thread_settings_applied',
    thread_id: THREAD,
    thread_settings: {
      model: 'fixture-model',
      model_provider_id: 'fixture',
      approval_policy: 'on-request',
      approvals_reviewer: 'user',
      permission_profile: { type: 'managed', file_system: { type: 'restricted', entries: [] }, network: 'restricted' },
      cwd: '/fixture',
      runtime_workspace_roots: ['/fixture'],
      collaboration_mode: { mode: 'default', settings: { model: 'fixture-model' } },
      disabled_plugin_ids: [],
    },
  });
  it('permits only a current native settings pause above a completed, otherwise clean conversation', () => {
    const completed = tail(start(), complete(), settings());
    expect(permitsCodexManagerSetup(completed, context(), NOW - 9000)).toBe(true);
    expect(permitsCodexManagerSetup(completed, context({ tailTruncated: true }), NOW - 9000)).toBe(false);
    expect(permitsCodexManagerSetup(completed, context(), NOW - 1000)).toBe(false);
    expect(permitsCodexManagerSetup(tail(start(), settings()), context(), NOW - 10000)).toBe(false);
    expect(permitsCodexManagerSetup(completed.slice(0, -1), context(), NOW - 10000)).toBe(false);
  });
  it.each([
    { type: 'error', message: 'Authentication failed', codex_error_info: 'Unauthorized' },
    { type: 'error', message: 'Usage limit', codex_error_info: 'UsageLimitExceeded' },
    { type: 'error', message: 'failed to load workspace requirements', codex_error_info: 'Other' },
    { type: 'turn_aborted', turn_id: TURN, reason: 'interrupted' },
    { type: 'request_permissions', turn_id: TURN },
    { type: 'collab_agent_spawn_end', new_thread_id: AGENT, status: 'running' },
  ])('never removes another veto during settings setup: %j', (veto) => {
    expect(permitsCodexManagerSetup(tail(start(), complete(), veto, settings()), context(), NOW - 10000)).toBe(false);
  });

  it('requires a subsequent owner message and fresh lifecycle after applied settings', () => {
    expect(classifyCodexTail(failed(settings()), context())).toMatchObject({ activity: 'paused', safeToAct: false });
    const input = { type: 'user_message', message: 'Owner confirmed next turn', local_images: [] };
    expect(classifyCodexTail(tail(settings(), input, start(), complete()), context())).toMatchObject({
      activity: 'completed',
      safeToAct: false,
    });
    expect(classifyCodexTail(tail(settings(), start(), complete()), context())).toMatchObject({
      activity: 'paused',
      safeToAct: false,
    });
  });
  it.each([true, false])('validates native granular approval fields without guessing: %s', (valid) => {
    const event = settings() as Payload;
    const snapshot = event.thread_settings as Payload;
    snapshot.approval_policy = {
      granular: {
        sandbox_approval: false,
        rules: false,
        skill_approval: false,
        request_permissions: valid ? true : null,
        mcp_elicitations: true,
      },
    };
    snapshot.permission_profile = {
      type: 'managed',
      file_system: {
        type: 'restricted',
        entries: [
          { path: { type: 'special', value: { kind: 'root' } }, access: 'read' },
          { path: { type: 'path', path: '/fixture' }, access: 'write', missing_path_behavior: 'skip' },
        ],
      },
      network: 'restricted',
    };
    expect(
      classifyCodexTail(tail(event, { type: 'user_message', message: 'Owner request' }, start(), complete()), context())
    ).toMatchObject({ activity: valid ? 'completed' : 'unknown', safeToAct: false });
  });
  it.each(['authentication', 'quota'])('does not clear an existing %s veto', (kind) => {
    const veto =
      kind === 'authentication'
        ? { type: 'error', message: 'Authentication failed', codex_error_info: 'Unauthorized' }
        : { type: 'error', message: 'Usage limit reached', codex_error_info: 'UsageLimitExceeded' };
    const result = classifyCodexTail(
      tail(
        start(),
        veto,
        settings(),
        { type: 'user_message', message: 'Next owner prompt' },
        start('next'),
        complete(undefined, 'next')
      ),
      context()
    );
    expect(result.safeToAct).toBe(false);
    expect(['blocked', 'unknown']).toContain(result.activity);
  });
  it('refuses an incomplete permission path even after another owner prompt', () => {
    const event = settings();
    event.thread_settings.permission_profile.file_system.entries.push({ path: {}, access: 'write' } as never);
    expect(
      classifyCodexTail(tail(event, { type: 'user_message', message: 'Next' }, start(), complete()), context())
    ).toMatchObject({ activity: 'unknown', safeToAct: false });
  });
  it.each([{ thread_id: AGENT }, { thread_settings: {} }, { thread_settings: null }])(
    'refuses incomplete or unrelated settings %j',
    (patch) => {
      expect(
        classifyCodexTail(
          tail({ ...settings(), ...patch }, { type: 'user_message', message: 'Next' }, start(), complete()),
          context()
        )
      ).toMatchObject({ activity: 'unknown', safeToAct: false });
    }
  );
});

it('requires a new owner turn after the native workspace reload failure', () => {
  const error = { message: 'failed to load workspace requirements', codex_error_info: 'other' };
  const failure = [start(), complete(error)];
  expect(classifyCodexTail(tail(...failure, start('later'), complete(undefined, 'later')), context())).toMatchObject({
    activity: 'paused',
    safeToAct: false,
  });
  const retry = [
    { type: 'user_message', message: 'Retry after repairing configuration' },
    start('later'),
    complete(undefined, 'later'),
  ];
  expect(classifyCodexTail(tail(...failure, ...retry), context())).toMatchObject({
    activity: 'completed',
    reason: 'turn-completed',
  });
  for (const codex_error_info of ['unauthorized', 'usage_limit_exceeded', 'unrecognized_failure']) {
    expect(
      classifyCodexTail(tail(start(), complete({ ...error, codex_error_info }), ...retry), context())
    ).toMatchObject({ activity: 'blocked', safeToAct: false });
  }
  expect(
    classifyCodexTail(
      tail(...failure, { type: 'request_permissions' }, start('later'), complete(undefined, 'later')),
      context()
    )
  ).toMatchObject({ activity: 'paused', safeToAct: false });
});

it('retains early child and approval vetoes across a complete larger conversation', () => {
  const padding = (
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(1024) }] },
    }) + '\n'
  ).repeat(300);
  const completed = line(complete(), NOW - 1000) + '\n';
  const full = line(start(), NOW - 10000) + '\n' + padding + completed;
  expect(Buffer.byteLength(full)).toBeGreaterThan(262144);
  expect(classifyCodexTail(full, context())).toMatchObject({ activity: 'completed' });
  for (const veto of [
    { type: 'request_permissions' },
    { type: 'collab_agent_spawn_begin', call_id: 'pending', sender_thread_id: THREAD, started_at_ms: NOW - 9000 },
  ]) {
    const result = classifyCodexTail(
      line(start(), NOW - 10000) + '\n' + line(veto, NOW - 9000) + '\n' + padding + completed,
      context()
    );
    expect(result.activity).not.toBe('completed');
    expect(result.safeToAct).toBe(false);
  }
  expect(classifyCodexTail(full, context({ tailTruncated: true }))).toMatchObject({ safeToAct: false });
});

describe('native MCP item lifecycle', () => {
  const approval = 'MCP tool call requires approval, but approval policy is never';
  const item = (patch: Payload = {}): Payload => ({
    type: 'McpToolCall',
    id: 'mcp-call-fixture',
    server: 'codeman',
    tool: 'codeman_list_agents',
    arguments: {},
    status: 'completed',
    result: { content: [] },
    duration: { secs: 0, nanos: 0 },
    ...patch,
  });
  const event = (patch: Payload = {}, payload: Payload = {}): Payload => ({
    type: 'item_completed',
    thread_id: THREAD,
    turn_id: TURN,
    started_at_ms: NOW - 9000,
    completed_at_ms: NOW - 8000,
    item: item(patch),
    ...payload,
  });
  const failedCall = (message = approval) => event({ status: 'failed', result: undefined, error: { message } });
  it('retains an exact native task start persisted before its own completed owner input', () => {
    const owner = {
      type: 'item_completed',
      thread_id: THREAD,
      turn_id: TURN,
      started_at_ms: NOW - 9984,
      completed_at_ms: NOW - 9984,
      item: { type: 'UserMessage', id: 'owner-input', content: [{ type: 'text', text: 'Run scoped tool' }] },
    };
    expect(classifyCodexTail(tail(start(), owner, event(), complete()), context()).activity).toBe('completed');
    for (const change of [
      { turn_id: 'other-turn' },
      { started_at_ms: undefined },
      { started_at_ms: NOW - 15000, completed_at_ms: NOW - 15000 },
    ])
      expect(classifyCodexTail(tail(start(), { ...owner, ...change }, event(), complete()), context()).activity).toBe(
        'unknown'
      );
    expect(
      classifyCodexTail(tail(start(), complete(INTERRUPTED), owner, event(), complete()), context()).activity
    ).toBe('unknown');
    expect(
      classifyCodexTail(
        tail(start(), { type: 'user_message', message: 'Unbound owner input' }, event(), complete()),
        context()
      ).activity
    ).toBe('unknown');
  });
  it('accepts native completed-only timestamps and a later tracked owner turn after an approval refusal', () => {
    expect(classifyCodexTail(tail(start(), event(), complete()), context()).activity).toBe('completed');
    expect(classifyCodexTail(tail(start(), failedCall(), complete()), context())).toMatchObject({
      activity: 'paused',
      reason: 'approval-required',
      safeToAct: false,
    });
    expect(
      classifyCodexTail(
        tail(
          start(),
          failedCall(),
          complete(),
          { type: 'user_message', message: 'Owner repaired approval; reply READY.' },
          start('owner-turn'),
          complete(undefined, 'owner-turn')
        ),
        context()
      ).activity
    ).toBe('completed');
  });
  it('requires explicit starts to pair exactly, and keeps uncompleted MCP calls pending across owner turns', () => {
    const begin = event(
      { status: 'inProgress', result: undefined, duration: undefined },
      { type: 'item_started', completed_at_ms: undefined }
    );
    expect(classifyCodexTail(tail(start(), begin, event(), complete()), context()).activity).toBe('completed');
    expect(
      classifyCodexTail(
        tail(
          start(),
          begin,
          complete(),
          { type: 'user_message', message: 'Another owner turn' },
          start('owner-turn'),
          complete(undefined, 'owner-turn')
        ),
        context()
      )
    ).toMatchObject({ activity: 'watching', reason: 'background-work', safeToAct: false });
    expect(
      classifyCodexTail(tail(start(), begin, event({ tool: 'another_tool' }), complete()), context()).activity
    ).toBe('unknown');
  });
  it.each([
    event({}, { started_at_ms: undefined }),
    event({}, { started_at_ms: NOW - 7000 }),
    event({}, { completed_at_ms: NOW + 3000 }),
    event({}, { thread_id: AGENT }),
    event({}, { turn_id: 'other-turn' }),
    event({ status: 'inProgress' }),
    event({ status: 'failed', result: undefined }),
    event({
      status: 'failed',
      result: undefined,
      error: { message: 'Unknown error', codex_error_info: 'Unauthorized' },
    }),
    event({ error: { message: approval } }),
    event({ result: { content: 'malformed' } }),
    event({ duration: { secs: 0, nanos: -1 } }),
    event({ arguments: undefined }),
    event({ status: 'unknown' }),
  ])('vetoes malformed or unsupported MCP evidence %#', (row) => {
    expect(classifyCodexTail(tail(start(), row, complete()), context())).toMatchObject({
      activity: 'unknown',
      safeToAct: false,
    });
  });
  it('retains unknown/authentication/permission error and result-error vetoes despite later completion and owner prompts', () => {
    for (const row of [
      failedCall('Authentication required'),
      failedCall('Permission denied'),
      failedCall('Unknown tool failure'),
      event({ result: { content: [], isError: true } }),
    ])
      expect(
        classifyCodexTail(
          tail(
            start(),
            row,
            complete(),
            { type: 'user_message', message: 'Try again' },
            start('owner-turn'),
            complete(undefined, 'owner-turn')
          ),
          context()
        )
      ).toMatchObject({ activity: 'blocked', safeToAct: false });
  });
  it('refuses repeated terminal IDs and a missing start cannot erase another pending call', () => {
    expect(classifyCodexTail(tail(start(), event(), event(), complete()), context()).activity).toBe('unknown');
    const begin = event(
      { id: 'other-call', status: 'inProgress', result: undefined, duration: undefined },
      { type: 'item_started', completed_at_ms: undefined }
    );
    expect(classifyCodexTail(tail(start(), begin, event(), complete()), context())).toMatchObject({
      activity: 'watching',
      safeToAct: false,
    });
  });
});

it('does not mistake plural usage-policy prose for a native singular limit notice', () => {
  const prose =
    'Consider usage limits and rate limits when choosing worker prompts.\nThe owner wrote "usage limits" in the objective.\n';
  expect(classifyCodexTail(tail(start(), complete()), context({ screen: prose + READY })).activity).toBe('completed');
  expect(classifyCodexTail(failed(), context({ screen: prose + READY }))).toMatchObject({
    activity: 'interrupted',
    safeToAct: true,
  });
  for (const notice of ['Usage limit reached', "You've hit your usage limit. Try again later.", 'Limit reached'])
    expect(classifyCodexTail(tail(start(), complete()), context({ screen: notice + '\n' + READY }))).toMatchObject({
      activity: 'blocked',
      reason: 'usage-limit',
      safeToAct: false,
    });
  expect(
    classifyCodexTail(
      tail(
        start(),
        { type: 'error', message: 'Usage limit reached', codex_error_info: 'UsageLimitExceeded' },
        complete()
      ),
      context({ screen: prose + READY })
    )
  ).toMatchObject({ activity: 'blocked', reason: 'usage-limit', safeToAct: false });
});

it('closes only exact Codeman bridge invalid-argument failures without clearing other vetoes', () => {
  const wrapper = (tool = 'supervisor_brain') =>
    `tool call error: tool call failed for \`codeman_supervisor/${tool}\`\n\nCaused by:\n    Mcp error: -32602: Invalid manager tool arguments`;
  const row = (message = wrapper(), patch: Payload = {}): Payload => ({
    type: 'item_completed',
    thread_id: THREAD,
    turn_id: TURN,
    started_at_ms: NOW - 9000,
    completed_at_ms: NOW - 8000,
    item: {
      type: 'McpToolCall',
      id: 'validation-call',
      server: 'codeman_supervisor',
      tool: 'supervisor_brain',
      arguments: { action: 'read' },
      status: 'failed',
      error: { message },
      duration: { secs: 0, nanos: 0 },
      ...patch,
    },
  });
  for (const tool of ['supervisor_brain', 'supervisor_agent'])
    expect(classifyCodexTail(tail(start(), row(wrapper(tool), { tool }), complete()), context()).activity).toBe(
      'completed'
    );
  for (const bad of [
    row(wrapper().replace('-32602', '-32001')),
    row(wrapper() + '\nAuthentication required'),
    row(wrapper().replace('Invalid manager tool arguments', 'Permission denied')),
    row(wrapper(), { server: 'other_server' }),
    row(wrapper(), { tool: 'supervisor_agent' }),
    row(wrapper('unknown_tool'), { tool: 'unknown_tool' }),
  ])
    expect(classifyCodexTail(tail(start(), bad, complete()), context())).toMatchObject({
      activity: 'blocked',
      safeToAct: false,
    });
  for (const veto of [
    { type: 'exec_approval_request' },
    { type: 'error', message: 'Unauthorized', codex_error_info: 'Unauthorized' },
    { type: 'error', message: 'Limit exceeded', codex_error_info: 'UsageLimitExceeded' },
  ])
    expect(['paused', 'blocked']).toContain(
      classifyCodexTail(tail(start(), veto, row(), complete()), context()).activity
    );
  const begin = {
    ...row(),
    type: 'item_started',
    completed_at_ms: undefined,
    item: {
      type: 'McpToolCall',
      id: 'pending-other',
      server: 'codeman_supervisor',
      tool: 'supervisor_status',
      arguments: {},
      status: 'inProgress',
    },
  };
  expect(classifyCodexTail(tail(start(), begin, row(), complete()), context())).toMatchObject({
    activity: 'watching',
    reason: 'background-work',
    safeToAct: false,
  });
});

it('requires later owner intent after the exact scoped manager authority refusal', () => {
  const message =
    'tool call error: tool call failed for `codeman_supervisor/supervisor_agent`\n\nCaused by:\n    Mcp error: -32001: Current prepared manager authority is required';
  const row = (text = message, server = 'codeman_supervisor'): Payload => ({
    type: 'item_completed',
    thread_id: THREAD,
    turn_id: TURN,
    started_at_ms: NOW - 9000,
    completed_at_ms: NOW - 8000,
    item: {
      type: 'McpToolCall',
      id: 'manager-authority-refusal',
      server,
      tool: 'supervisor_agent',
      arguments: { mode: 'usage', agentId: THREAD },
      status: 'failed',
      error: { message: text },
      duration: { secs: 0, nanos: 0 },
    },
  });
  expect(classifyCodexTail(tail(start(), row(), complete()), context())).toMatchObject({
    activity: 'paused',
    reason: 'approval-required',
    safeToAct: false,
  });
  expect(
    classifyCodexTail(
      tail(
        start(),
        row(),
        complete(),
        { type: 'user_message', message: 'Owner repaired manager scope; continue.' },
        start('new-owner-turn'),
        complete(undefined, 'new-owner-turn')
      ),
      context()
    ).activity
  ).toBe('completed');
  for (const bad of [
    row(message + '\nAuthentication failed'),
    row(message.replace('Current prepared manager authority is required', 'Manager authentication changed')),
    row(message, 'untrusted_server'),
  ])
    expect(
      classifyCodexTail(
        tail(
          start(),
          bad,
          complete(),
          { type: 'user_message', message: 'Try again' },
          start('new-owner-turn'),
          complete(undefined, 'new-owner-turn')
        ),
        context()
      )
    ).toMatchObject({ activity: 'blocked', safeToAct: false });
});

it('allows later owner intent to supersede only an exact failed brain read with closed transport', () => {
  const message =
    'tool call error: tool call failed for `codeman_supervisor/supervisor_brain`\n\nCaused by:\n    Transport closed';
  const boundedFailure =
    'tool call error: tool call failed for `codeman_supervisor/supervisor_brain`\n\nCaused by:\n    Mcp error: -32002: Manager bridge request failed; acceptance may be uncertain. Retain requestId and inspect durable status before retrying.';
  const row = (patch: Payload = {}, envelope: Payload = {}): Payload => ({
    type: 'item_completed',
    thread_id: THREAD,
    turn_id: TURN,
    started_at_ms: NOW - 9000,
    completed_at_ms: NOW - 8000,
    item: {
      type: 'McpToolCall',
      id: 'closed-brain-read',
      server: 'codeman_supervisor',
      tool: 'supervisor_brain',
      arguments: { mode: 'read' },
      status: 'failed',
      error: { message },
      duration: { secs: 0, nanos: 0 },
      ...patch,
    },
    ...envelope,
  });
  const ownerTurn: Payload[] = [
    { type: 'user_message', message: 'Owner restored the scoped bridge; reply READY.' },
    start('new-owner-turn'),
    complete(undefined, 'new-owner-turn'),
  ];
  expect(classifyCodexTail(tail(start(), row(), complete()), context())).toMatchObject({
    activity: 'paused',
    reason: 'approval-required',
    safeToAct: false,
  });
  expect(classifyCodexTail(tail(start(), row(), complete(), ...ownerTurn), context()).activity).toBe('completed');
  expect(
    classifyCodexTail(tail(start(), row({ error: { message: boundedFailure } }), complete()), context())
  ).toMatchObject({ activity: 'paused', reason: 'approval-required', safeToAct: false });
  expect(
    classifyCodexTail(tail(start(), row({ error: { message: boundedFailure } }), complete(), ...ownerTurn), context())
      .activity
  ).toBe('completed');
  for (const bad of [
    row({ arguments: { mode: 'append', note: 'write' }, error: { message: boundedFailure } }),
    row({ arguments: { mode: 'append', note: 'write' } }),
    row({ arguments: { mode: 'replace', markdown: 'write' } }),
    row({ tool: 'supervisor_assign' }),
    row({ tool: 'supervisor_message' }),
    row({ server: 'other_server' }),
    row({ arguments: { mode: 'read', requestId: 'extra-key' } }),
    row({ arguments: { action: 'read' } }),
    row({ arguments: ['read'] }),
    row({ error: { message: message + '\nAuthentication failed' } }),
    row({}, { started_at_ms: undefined }),
  ]) {
    const result = classifyCodexTail(tail(start(), bad, complete(), ...ownerTurn), context());
    expect(result.activity).not.toBe('completed');
    expect(result.safeToAct).toBe(false);
  }
  const child = { type: 'collab_agent_spawn_end', new_thread_id: AGENT, status: 'running' };
  expect(classifyCodexTail(tail(start(), child, row(), complete(), ...ownerTurn), context())).toMatchObject({
    activity: 'watching',
    reason: 'background-work',
    safeToAct: false,
  });
  for (const codex_error_info of ['Unauthorized', 'UsageLimitExceeded'])
    expect(
      classifyCodexTail(
        tail(
          start(),
          { type: 'error', message: 'Existing native veto', codex_error_info },
          row(),
          complete(),
          ...ownerTurn
        ),
        context()
      )
    ).toMatchObject({ activity: 'blocked', safeToAct: false });
});

it('distinguishes native approval question rows from assistant conversational questions', () => {
  const prose = '• What would you like me to tell the worker?\n• The owner asked "would you like a summary?"\n';
  expect(classifyCodexTail(tail(start()), context({ screen: prose + READY })).activity).toBe('working');
  for (const notice of [
    'Would you like to run the following command?',
    '• Would you like to approve this?',
    'Press enter to confirm or esc to cancel',
    'Allow this tool?',
  ])
    expect(classifyCodexTail(tail(start()), context({ screen: prose + notice + '\n' + READY }))).toMatchObject({
      activity: 'paused',
      reason: 'approval-required',
      safeToAct: false,
    });
  expect(
    classifyCodexTail(tail(start(), { type: 'exec_approval_request' }), context({ screen: prose + READY }))
  ).toMatchObject({ activity: 'paused', safeToAct: false });
});

it('classifies complete history beyond2MiB without losing malformed, truncated or pending-child vetoes', () => {
  const padding = (JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(1024) } }) + '\n').repeat(2500);
  const base = line(start()) + '\n' + padding;
  const failed = base + line(complete(INTERRUPTED)) + '\n';
  expect(Buffer.byteLength(failed)).toBeGreaterThan(2_097_152);
  expect(classifyCodexTail(failed, context())).toMatchObject({ activity: 'interrupted', safeToAct: true });
  expect(classifyCodexTail(failed, context({ tailTruncated: true })).safeToAct).toBe(false);
  expect(classifyCodexTail(base + '{broken}\n' + line(complete(INTERRUPTED)) + '\n', context())).toMatchObject({
    activity: 'unknown',
    safeToAct: false,
  });
  const pending =
    line(start()) +
    '\n' +
    line({ type: 'collab_agent_spawn_end', new_thread_id: AGENT, status: 'running' }) +
    '\n' +
    padding +
    line(complete(INTERRUPTED)) +
    '\n';
  expect(classifyCodexTail(pending, context())).toMatchObject({
    activity: 'watching',
    reason: 'background-work',
    safeToAct: false,
  });
});

it('requires later owner intent for legacy failed GitLab reads while preserving write and auth vetoes', () => {
  const message =
    'tool call error: tool call failed for `codeman_supervisor/supervisor_gitlab`\n\nCaused by:\n    Mcp error: -32000: Supervisor operation refused or acceptance is uncertain; inspect status and retain the same requestId';
  const call = (arguments_: Payload, patch: Payload = {}): Payload => ({
    type: 'item_completed',
    thread_id: THREAD,
    turn_id: TURN,
    started_at_ms: NOW - 9000,
    completed_at_ms: NOW - 8000,
    item: {
      type: 'McpToolCall',
      id: 'failed-gitlab-read',
      server: 'codeman_supervisor',
      tool: 'supervisor_gitlab',
      arguments: arguments_,
      status: 'failed',
      error: { message },
      duration: { secs: 0, nanos: 0 },
      ...patch,
    },
  });
  const later = [
    { type: 'user_message', message: 'Owner asks to continue reading other permitted project context.' },
    start('owner-turn'),
    complete(undefined, 'owner-turn'),
  ];
  for (const operation of ['projects', 'tree', 'file', 'merge_requests', 'merge_request']) {
    const read = call({ operation, projectId: 42, branch: 'main', path: 'README.md', iid: 1 });
    expect(classifyCodexTail(tail(start(), read, complete()), context())).toMatchObject({
      activity: 'paused',
      safeToAct: false,
    });
    expect(classifyCodexTail(tail(start(), read, complete(), ...later), context()).activity).toBe('completed');
    expect(
      classifyCodexTail(tail(start(), read, complete(), ...later), context({ tailTruncated: true })).safeToAct
    ).toBe(false);
  }
  for (const blocked of [
    call({ operation: 'update_file', requestId: 'uncertain-write' }),
    call({ operation: 'create_file' }),
    call({ operation: 'create_branch' }),
    call({ operation: 'file', requestId: 'unexpected-key' }),
    call({ action: 'file' }),
    call({ operation: 'file' }, { server: 'other_server' }),
    call({ operation: 'file' }, { error: { message: message + '\nAuthentication required' } }),
  ])
    expect(classifyCodexTail(tail(start(), blocked, complete(), ...later), context()).activity).not.toBe('completed');
  for (const codex_error_info of ['Unauthorized', 'UsageLimitExceeded'])
    expect(
      classifyCodexTail(
        tail(
          start(),
          { type: 'error', message: 'Existing native veto', codex_error_info },
          call({ operation: 'projects' }),
          complete(),
          ...later
        ),
        context()
      )
    ).toMatchObject({ activity: 'blocked', safeToAct: false });
  expect(
    classifyCodexTail(
      tail(
        start(),
        { type: 'collab_agent_spawn_end', new_thread_id: AGENT, status: 'running' },
        call({ operation: 'projects' }),
        complete(),
        ...later
      ),
      context()
    )
  ).toMatchObject({ activity: 'watching', safeToAct: false });
});
