/**
 * @fileoverview Bounded Codex rollout classifier. Never classifies assistant prose as a control event.
 * Event shapes follow openai/codex rust-v0.162.1 protocol.rs (task_started/task_complete aliases,
 * turn_aborted, error, stream_error). Unknown/partial schemas remain non-actionable.
 */
import { createHash } from 'node:crypto';
import { CODEX_REASONING_EFFORTS } from '../types/session.js';
import type { RecoveryActivity, RecoveryObservation, RecoveryReason } from './types.js';

type JsonObject = Record<string, unknown>;
const object = (v: unknown): JsonObject | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : undefined;
const token = (v: unknown): string | undefined => (typeof v === 'string' && /^[\w-]{1,100}$/.test(v) ? v : undefined);

function terminalChildStatus(status: unknown): boolean {
  if (typeof status === 'string') return /^(completed|errored|shutdown|not_found)$/i.test(status);
  const value = object(status);
  if (!value) return false;
  const keys = Object.keys(value);
  // An ambiguous object cannot certify a child is finished. Completed carries
  // a nullable message; errored carries an error string in the Codex protocol.
  if (keys.length !== 1) return false;
  const kind = keys[0].toLowerCase();
  return (
    (kind === 'completed' && (value[keys[0]] === null || typeof value[keys[0]] === 'string')) ||
    (kind === 'errored' && typeof value[keys[0]] === 'string') ||
    (['shutdown', 'not_found'].includes(kind) && value[keys[0]] === null)
  );
}

function errorKind(error: JsonObject): string | undefined {
  if (error.codex_error_info !== undefined && error.codexErrorInfo !== undefined) return undefined;
  const info = error.codex_error_info ?? error.codexErrorInfo;
  if (info === undefined || info === null) return '';
  const variants = object(info);
  if (typeof info !== 'string' && (!variants || Object.keys(variants).length !== 1)) return undefined;
  const name = typeof info === 'string' ? info : Object.keys(variants!)[0];
  const kind = name.replace(/_/g, '').toLowerCase();
  if (
    ['responsestreamdisconnected', 'responsestreamconnectionfailed', 'responsetoomanyfailedattempts'].includes(kind)
  ) {
    // These are struct variants in the pinned Codex protocol, never unit strings.
    const details = variants && object(variants[name]);
    if (!details || Object.keys(details).some((key) => key !== 'http_status_code')) return undefined;
    const status = details.http_status_code;
    if (
      status !== undefined &&
      status !== null &&
      !(Number.isInteger(status) && Number(status) >= 0 && Number(status) <= 65535)
    )
      return undefined;
  }
  return kind;
}

function classifyError(error: JsonObject): { activity: RecoveryActivity; reason: RecoveryReason } {
  if (typeof error.message !== 'string') return { activity: 'unknown', reason: 'observing' };
  const kind = errorKind(error);
  if (kind === undefined) return { activity: 'blocked', reason: 'observing' };
  const message = typeof error.message === 'string' ? error.message.slice(0, 2048) : '';
  if (['usagelimitexceeded', 'ratelimitexceeded', 'sessionbudgetexceeded'].includes(kind)) {
    return { activity: 'blocked', reason: 'usage-limit' };
  }
  if (kind === 'unauthorized') return { activity: 'blocked', reason: 'authentication-required' };
  if (kind === 'activeturnnotsteerable' || kind === 'threadrollbackfailed') {
    return { activity: 'unknown', reason: 'observing' };
  }
  if (/Model interrupted to submit steer instructions/i.test(message)) {
    return { activity: 'working', reason: 'internal-retry' };
  }
  if (
    ['responsestreamdisconnected', 'responsestreamconnectionfailed', 'responsetoomanyfailedattempts'].includes(kind)
  ) {
    return { activity: 'interrupted', reason: 'turn-failed' };
  }
  if (kind !== '') return { activity: 'blocked', reason: 'observing' };
  if (/^Conversation interrupted(?:[.!:]|$)/i.test(message.trim())) {
    return { activity: 'interrupted', reason: 'turn-interrupted' };
  }
  // Unknown errors can require changed configuration or permissions. They are never retried blindly.
  return { activity: 'blocked', reason: 'observing' };
}

export interface CodexClassificationContext {
  conversationId: string;
  now: number;
  screen: string | null;
  busy: boolean;
  watching: boolean;
  /** Only a complete rollout can establish the absence of earlier live subagents. */
  tailTruncated?: boolean;
  lastIntentionalStopAt?: number;
}

/** Only an empty, visible Codex composer certifies that a prompt can be delivered. */
export function hasEmptyCodexComposer(screen: string): boolean {
  const rows = screen
    .slice(-16_384)
    .split('\n')
    .filter((r) => r.trim());
  const tail = rows.slice(-5);
  let index = -1;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (/^\s*›(?:\s|$)/u.test(tail[i])) {
      index = i;
      break;
    }
  }
  if (index < 0) return false;
  const composer = tail[index];
  const text = composer.replace(/^\s*›\s*/u, '').trim();
  if (text !== '' && text !== 'Ask Codex to do anything') return false;
  // A blank first row can still contain a multiline draft. Every subsequent row must be
  // known footer chrome; unknown rows (including a changed TUI layout) veto delivery.
  const after = tail.slice(index + 1);
  if (!after.length) return true;
  const effort = ['default', ...CODEX_REASONING_EFFORTS].join('|');
  const footer = new RegExp(`^\\s{2,}\\S+\\s+(?:${effort})\\s+·\\s+\\S.*$`, 'u');
  return (
    footer.test(after[0]) &&
    (after.length === 1 || (after.length === 2 && /^\s*(?:← for agents · )?\? for shortcuts\s*$/u.test(after[1])))
  );
}

export function classifyCodexTail(tail: string, context: CodexClassificationContext): RecoveryObservation {
  const unknown: RecoveryObservation = {
    activity: 'unknown',
    reason: 'observing',
    at: context.now,
    conversationId: context.conversationId,
    safeToAct: false,
  };
  if (Buffer.byteLength(tail) > 262_144 || (tail && !tail.endsWith('\n'))) return unknown;
  let result = unknown;
  let turnId: string | undefined;
  let terminalError: JsonObject | undefined;
  let submissionKey: string | undefined;
  let submissionHash: string | undefined;
  let progressAt = 0;
  let hasTurnStart = false;
  const pendingAgents = new Set<string>();
  const updateChild = (rawId: unknown, status: unknown): boolean => {
    const id = token(rawId);
    if (!id) return false;
    if (terminalChildStatus(status)) pendingAgents.delete(id);
    else pendingAgents.add(id); // running, interrupted, unknown or malformed status
    return true;
  };
  for (const line of tail.split('\n')) {
    if (!line.trim()) continue;
    if (line.length > 262_144) return unknown;
    let entry: JsonObject | undefined;
    try {
      entry = object(JSON.parse(line));
    } catch {
      return unknown;
    }
    if (!entry || entry.type !== 'event_msg') continue;
    const p = object(entry.payload);
    if (!p || typeof p.type !== 'string') return unknown;
    const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isFinite(at) || at > context.now + 2000) return unknown;
    progressAt = Math.max(progressAt, at);
    const update = (activity: RecoveryActivity, reason: RecoveryReason): void => {
      result = {
        activity,
        reason,
        at,
        conversationId: context.conversationId,
        turnId,
        submissionKey,
        safeToAct: false,
      };
    };
    if (p.type === 'user_message' || (p.type === 'item_completed' && object(p.item)?.type === 'UserMessage')) {
      submissionKey = createHash('sha256').update(line).digest('hex');
      const content = object(p.item)?.content;
      const message =
        typeof p.message === 'string'
          ? p.message
          : Array.isArray(content)
            ? content.map((b) => (typeof object(b)?.text === 'string' ? object(b)?.text : '')).join('\n')
            : '';
      submissionHash = createHash('sha256').update(message.trim()).digest('hex');
      // A new prompt can precede task_started in the journal. It already supersedes the old failure.
      turnId = undefined;
      hasTurnStart = false;
      terminalError = undefined;
      update('working', 'turn-running');
    }
    if (p.type === 'task_started' || p.type === 'turn_started') {
      turnId = token(p.turn_id);
      hasTurnStart = !!turnId;
      terminalError = undefined;
      update(turnId ? 'working' : 'unknown', turnId ? 'turn-running' : 'observing');
    } else if (p.type === 'stream_error' || p.type === 'auth_recovery_started') {
      // StreamError is provider-owned retry progress, not a terminal failure.
      terminalError = undefined;
      update('working', 'internal-retry');
    } else if (
      ['exec_approval_request', 'apply_patch_approval_request', 'elicitation_request', 'request_user_input'].includes(
        p.type
      )
    ) {
      update('paused', 'approval-required');
    } else if (p.type === 'error') {
      if (typeof p.message !== 'string') return unknown;
      const e = classifyError(p);
      terminalError = e.activity === 'interrupted' || e.activity === 'blocked' ? p : undefined;
      update(e.activity, e.reason);
    } else if (p.type === 'task_complete' || p.type === 'turn_complete') {
      const id = token(p.turn_id);
      if (!id || (turnId && id !== turnId)) return unknown;
      turnId = id;
      if (p.error !== undefined && p.error !== null && !object(p.error)) return unknown;
      const error = object(p.error) ?? terminalError;
      if (error) {
        const e = classifyError(error);
        update(e.activity, e.reason);
      } else update('completed', 'turn-completed');
    } else if (p.type === 'turn_aborted') {
      const id = token(p.turn_id);
      if (!id || (turnId && id !== turnId)) return unknown;
      turnId = id;
      if (p.error !== undefined && p.error !== null && !object(p.error)) return unknown;
      const error = object(p.error);
      if (p.reason === 'budget_limited') update('blocked', 'usage-limit');
      else if (p.reason === 'replaced' || p.reason === 'review_ended') update('paused', 'user-interrupted');
      else if (p.reason === 'interrupted' && error) {
        const e = classifyError(error);
        update(e.activity, e.reason);
      } else update('paused', 'user-interrupted');
    } else if (p.type === 'collab_agent_spawn_begin') {
      const call = token(p.call_id);
      if (!call) return unknown;
      // Spawn begins have no child identity yet. Retain their own operation
      // until the matching end provides a named child and a supported status.
      pendingAgents.add(`spawn:${call}`);
    } else if (p.type === 'collab_agent_spawn_end') {
      const call = token(p.call_id);
      if (p.new_thread_id === null || p.new_thread_id === undefined) {
        // Codex reports a failed spawn as no receiver plus NotFound. This can
        // release only its matching operation, never another named child.
        if (!call || p.status !== 'not_found' || !pendingAgents.has(`spawn:${call}`)) return unknown;
        pendingAgents.delete(`spawn:${call}`);
      } else {
        if (!updateChild(p.new_thread_id, p.status)) return unknown;
        if (call) pendingAgents.delete(`spawn:${call}`);
      }
    } else if (['collab_agent_interaction_begin', 'collab_resume_begin', 'collab_close_begin'].includes(p.type)) {
      if (!updateChild(p.receiver_thread_id, undefined)) return unknown;
    } else if (['collab_agent_interaction_end', 'collab_resume_end', 'collab_close_end'].includes(p.type)) {
      if (!updateChild(p.receiver_thread_id, p.status)) return unknown;
    } else if (p.type === 'collab_wait_begin' || p.type === 'collab_waiting_begin') {
      if (!Array.isArray(p.receiver_thread_ids) || p.receiver_thread_ids.length === 0) return unknown;
      for (const id of p.receiver_thread_ids) if (!updateChild(id, undefined)) return unknown;
    } else if (p.type === 'collab_wait_end' || p.type === 'collab_waiting_end') {
      const statuses = object(p.statuses);
      if (!statuses || Object.keys(statuses).length === 0) return unknown;
      for (const [id, status] of Object.entries(statuses)) if (!updateChild(id, status)) return unknown;
    }
  }
  result.submissionKey = submissionKey;
  result.submissionHash = submissionHash;
  result.progressAt = progressAt || result.at;
  if (context.screen === null && (context.watching || pendingAgents.size)) {
    return { ...result, activity: 'watching', reason: 'background-work', safeToAct: false };
  }
  if (context.screen !== null) {
    // Screen fallbacks can only veto recovery or request attention. Transcript-looking text cannot restart anything.
    const screen = context.screen.slice(-16_384);
    if (/sign in|log in|authentication failed/i.test(screen)) {
      return { ...result, activity: 'blocked', reason: 'authentication-required', safeToAct: false };
    }
    if (/usage limit|limit reached/i.test(screen)) {
      return { ...result, activity: 'blocked', reason: 'usage-limit', safeToAct: false };
    }
    if (/would you like|approve this|allow this|press enter to confirm/i.test(screen)) {
      return { ...result, activity: 'paused', reason: 'approval-required', safeToAct: false };
    }
    if (/esc to interrupt|reconnecting\.\.\.|retrying\.\.\./i.test(screen) || context.busy) {
      return { ...result, activity: 'working', reason: 'turn-running', safeToAct: false };
    }
    if (context.watching || pendingAgents.size) {
      return { ...result, activity: 'watching', reason: 'background-work', safeToAct: false };
    }
    if (result.activity === 'interrupted' && turnId) {
      result.evidenceKey = `${context.conversationId}:${turnId}:${result.at}:${result.reason}`;
      if ((context.lastIntentionalStopAt ?? 0) >= result.at - 2000) {
        return { ...result, activity: 'paused', reason: 'user-interrupted', safeToAct: false };
      }
      result.safeToAct = context.tailTruncated === false && hasTurnStart && hasEmptyCodexComposer(screen);
    }
  }
  return result;
}
