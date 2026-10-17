import { MAX_CODEX_ROLLOUT_BYTES } from './codex-evidence-limits.js';
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
// Persisted RolloutItemWire variants in the pinned rust-v0.162.1 history protocol.
const ROLLOUT_TYPES = new Set([
  'session_meta',
  'response_item',
  'inter_agent_communication',
  'inter_agent_communication_metadata',
  'compacted',
  'turn_context',
  'token_usage_record',
  'world_state',
  'security_risk_score',
  'retained_context',
  'event_msg',
  'realtime_item',
]);
export function isCodexRolloutRecord(value: unknown): value is JsonObject {
  const entry = object(value);
  return !!entry && typeof entry.type === 'string' && ROLLOUT_TYPES.has(entry.type) && !!object(entry.payload);
}

const token = (v: unknown): string | undefined => (typeof v === 'string' && /^[\w-]{1,100}$/.test(v) ? v : undefined);
const threadId = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const agentPath = (v: unknown): boolean =>
  typeof v === 'string' &&
  v.length <= 1024 &&
  (v === '/morpheus' ||
    (v.startsWith('/root') &&
      v
        .split('/')
        .slice(1)
        .every((part, i) => (i === 0 ? part === 'root' : /^[a-z0-9_]+$/.test(part) && part !== 'root'))));

const optionalString = (value: unknown): boolean => value === undefined || value === null || typeof value === 'string';
const optionalNatural = (value: unknown): boolean =>
  value === undefined || value === null || (Number.isSafeInteger(value) && Number(value) >= 0);
function tokenUsage(value: unknown): boolean {
  const usage = object(value);
  return (
    !!usage &&
    ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'].every(
      (key) => Number.isSafeInteger(usage[key]) && Number(usage[key]) >= 0
    ) &&
    optionalNatural(usage.cache_write_input_tokens)
  );
}
function rateLimits(value: unknown): boolean {
  const rate = object(value);
  if (!rate) return value === null;
  for (const key of ['limit_id', 'limit_name', 'normal_model_slug', 'plan_type'])
    if (!optionalString(rate[key])) return false;
  for (const key of ['primary', 'secondary']) {
    if (rate[key] === null || rate[key] === undefined) continue;
    const window = object(rate[key]);
    if (
      !window ||
      typeof window.used_percent !== 'number' ||
      !Number.isFinite(window.used_percent) ||
      window.used_percent < 0 ||
      !optionalNatural(window.window_minutes) ||
      !optionalNatural(window.resets_at)
    )
      return false;
  }
  const credits = rate.credits;
  if (
    credits !== undefined &&
    credits !== null &&
    (!object(credits) ||
      typeof object(credits)!.has_credits !== 'boolean' ||
      typeof object(credits)!.unlimited !== 'boolean' ||
      !optionalString(object(credits)!.balance))
  )
    return false;
  const individual = rate.individual_limit;
  if (
    individual !== undefined &&
    individual !== null &&
    (!object(individual) ||
      typeof object(individual)!.limit !== 'string' ||
      typeof object(individual)!.used !== 'string' ||
      !Number.isInteger(object(individual)!.remaining_percent) ||
      !Number.isSafeInteger(object(individual)!.resets_at))
  )
    return false;
  return (
    (rate.spend_control_reached === undefined ||
      rate.spend_control_reached === null ||
      typeof rate.spend_control_reached === 'boolean') &&
    (rate.rate_limit_reached_type === undefined ||
      rate.rate_limit_reached_type === null ||
      [
        'rate_limit_reached',
        'workspace_owner_credits_depleted',
        'workspace_member_credits_depleted',
        'workspace_owner_usage_limit_reached',
        'workspace_member_usage_limit_reached',
      ].includes(typeof rate.rate_limit_reached_type === 'string' ? rate.rate_limit_reached_type : ''))
  );
}

/** Only reviewed passive protocol events may leave a terminal result unchanged. */
/** Applied settings are owner intent, never an approval or a permission grant. */
function validThreadSettings(p: JsonObject, conversationId: string): boolean {
  const settings = object(p.thread_settings);
  if (p.thread_id !== conversationId || !settings) return false;
  const text = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= 4096;
  const absolute = (value: unknown) => text(value) && value.startsWith('/') && !value.includes('\0');
  const approval = object(settings.approval_policy);
  const granular = approval && object(approval.granular);
  const approvalKeys = ['sandbox_approval', 'rules', 'skill_approval', 'request_permissions', 'mcp_elicitations'];
  const knownApproval =
    ['untrusted', 'on-failure', 'on-request', 'never'].includes(String(settings.approval_policy)) ||
    (!!approval &&
      Object.keys(approval).length === 1 &&
      !!granular &&
      Object.keys(granular).length === approvalKeys.length &&
      approvalKeys.every((key) => typeof granular[key] === 'boolean'));
  const profile = object(settings.permission_profile);
  const fileSystem = profile && object(profile.file_system);
  const collaboration = object(settings.collaboration_mode);
  const collaborationSettings = collaboration && object(collaboration.settings);
  return (
    text(settings.model) &&
    text(settings.model_provider_id) &&
    absolute(settings.cwd) &&
    knownApproval &&
    ['user', 'guardian_subagent'].includes(String(settings.approvals_reviewer)) &&
    profile?.type === 'managed' &&
    fileSystem?.type === 'restricted' &&
    Array.isArray(fileSystem.entries) &&
    fileSystem.entries.length <= 1024 &&
    fileSystem.entries.every((entry) => {
      const rule = object(entry);
      const path = rule && object(rule.path);
      const special = path && object(path.value);
      const validPath =
        path?.type === 'path'
          ? absolute(path.path)
          : path?.type === 'special' &&
            !!special &&
            Object.keys(special).length === 1 &&
            ['root', 'slash_tmp', 'tmpdir'].includes(String(special.kind));
      return (
        !!rule &&
        validPath &&
        ['read', 'write', 'none'].includes(String(rule.access)) &&
        (rule.missing_path_behavior === undefined || rule.missing_path_behavior === 'skip')
      );
    }) &&
    ['restricted', 'enabled'].includes(String(profile.network)) &&
    (settings.service_tier === undefined || settings.service_tier === null || text(settings.service_tier)) &&
    (settings.runtime_workspace_roots === undefined ||
      (Array.isArray(settings.runtime_workspace_roots) &&
        settings.runtime_workspace_roots.length <= 100 &&
        settings.runtime_workspace_roots.every(absolute))) &&
    !!collaboration &&
    ['default', 'plan'].includes(String(collaboration.mode)) &&
    !!collaborationSettings &&
    text(collaborationSettings.model) &&
    (collaborationSettings.developer_instructions === undefined ||
      collaborationSettings.developer_instructions === null ||
      typeof collaborationSettings.developer_instructions === 'string') &&
    (collaborationSettings.reasoning_effort === undefined ||
      collaborationSettings.reasoning_effort === null ||
      CODEX_REASONING_EFFORTS.includes(
        collaborationSettings.reasoning_effort as (typeof CODEX_REASONING_EFFORTS)[number]
      )) &&
    Array.isArray(settings.disabled_plugin_ids) &&
    settings.disabled_plugin_ids.length <= 100 &&
    settings.disabled_plugin_ids.every(text)
  );
}

function passiveEvent(p: JsonObject): boolean {
  if (p.type === 'agent_message')
    return (
      typeof p.message === 'string' &&
      (p.questions === undefined || (Array.isArray(p.questions) && p.questions.length === 0))
    );
  if (p.type === 'agent_reasoning' || p.type === 'agent_reasoning_raw_content') return typeof p.text === 'string';
  if (p.type === 'agent_reasoning_section_break') {
    return (
      (p.item_id === undefined || typeof p.item_id === 'string') &&
      (p.summary_index === undefined || (Number.isSafeInteger(p.summary_index) && Number(p.summary_index) >= 0))
    );
  }
  if (p.type === 'token_count') {
    const info = object(p.info);
    return (
      (p.info === null ||
        (!!info &&
          tokenUsage(info.total_token_usage) &&
          tokenUsage(info.last_token_usage) &&
          optionalNatural(info.model_context_window))) &&
      rateLimits(p.rate_limits)
    );
  }
  if (
    ['agent_message_content_delta', 'plan_delta', 'reasoning_content_delta', 'reasoning_raw_content_delta'].includes(
      String(p.type)
    )
  ) {
    return (
      threadId(p.thread_id) &&
      !!token(p.turn_id) &&
      !!token(p.item_id) &&
      typeof p.delta === 'string' &&
      (p.summary_index === undefined || (Number.isSafeInteger(p.summary_index) && Number(p.summary_index) >= 0)) &&
      (p.content_index === undefined || (Number.isSafeInteger(p.content_index) && Number(p.content_index) >= 0))
    );
  }
  return false;
}

function passiveItem(item: JsonObject): boolean {
  if (!token(item.id)) return false;
  if (item.type === 'AgentMessage') {
    return (
      Array.isArray(item.content) &&
      item.content.every((block) => {
        const text = object(block);
        return text?.type === 'Text' && typeof text.text === 'string';
      }) &&
      (item.questions === undefined || (Array.isArray(item.questions) && item.questions.length === 0))
    );
  }
  if (item.type === 'Plan') return typeof item.text === 'string';
  if (item.type === 'Reasoning') {
    return (
      Array.isArray(item.summary_text) &&
      item.summary_text.every((text) => typeof text === 'string') &&
      (item.raw_content === undefined ||
        (Array.isArray(item.raw_content) && item.raw_content.every((text) => typeof text === 'string')))
    );
  }
  return false;
}

/** Exact command pairing is lifecycle evidence, never command-success certification. */
function commandShape(p: JsonObject): boolean {
  return (
    !!token(p.call_id) &&
    !!token(p.turn_id) &&
    Array.isArray(p.command) &&
    p.command.length > 0 &&
    p.command.every((part) => typeof part === 'string') &&
    typeof p.cwd === 'string' &&
    p.cwd.length > 0 &&
    Array.isArray(p.parsed_cmd) &&
    p.parsed_cmd.every((part) => {
      const parsed = object(part);
      if (!parsed || typeof parsed.cmd !== 'string') return false;
      if (parsed.type === 'unknown') return true;
      if (parsed.type === 'read') return typeof parsed.name === 'string' && typeof parsed.path === 'string';
      if (parsed.type === 'list_files') return optionalString(parsed.path);
      if (parsed.type === 'search') return optionalString(parsed.path) && optionalString(parsed.query);
      return false;
    }) &&
    (p.source === undefined ||
      (typeof p.source === 'string' &&
        ['agent', 'user_shell', 'unified_exec_startup', 'unified_exec_interaction'].includes(p.source))) &&
    (p.process_id === undefined || p.process_id === null || !!token(p.process_id)) &&
    (p.interaction_input === undefined || p.interaction_input === null || typeof p.interaction_input === 'string')
  );
}

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
  // Native Codex uses this exact terminal error when its per-turn config reload
  // fails. An explicit new owner prompt may retry after the configuration is
  // repaired; completion alone cannot clear the pause. Unknown errors and
  // explicit auth/quota/permission events retain their independent vetoes.
  if (kind === 'other' && message === 'failed to load workspace requirements')
    return { activity: 'paused', reason: 'approval-required' };

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
  return hasCodexComposerText(screen);
}

/** Exact native input acknowledgement; wrapped rows must be joined by the capture producer. */
export function hasCodexComposerText(screen: string, expected?: string): boolean {
  const capturedRows = screen.slice(-16_384).split('\n');
  // Exact pending input must retain blank draft rows; only unused capture rows
  // after the footer may disappear. The empty-composer classifier keeps its
  // historical whitespace handling.
  const rows = expected === undefined ? capturedRows.filter((row) => row.trim()) : capturedRows;
  if (expected !== undefined) while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
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
  const text = composer.replace(/^\s*› ?/u, '');
  // Plain native capture drops placeholder styling and cursor state. Its default
  // hint is indistinguishable from an identical owner draft, so only genuinely
  // blank text can authorize input. Exact text still acknowledges our own write.
  if (expected !== undefined ? text !== expected : text.trim() !== '') return false;
  // A blank first row can still contain a multiline draft. Every subsequent row must be
  // known footer chrome; unknown rows (including a changed TUI layout) veto delivery.
  const after = tail.slice(index + 1);
  if (!after.length) return expected === undefined;
  const effort = ['default', ...CODEX_REASONING_EFFORTS].join('|');
  const footer = new RegExp(`^\\s{2,}\\S+\\s+(?:${effort})\\s+·\\s+\\S.*$`, 'u');
  return (
    footer.test(after[0]) &&
    (after.length === 1 || (after.length === 2 && /^\s*(?:← for agents · )?\? for shortcuts\s*$/u.test(after[1])))
  );
}

/** Owner-triggered setup may supersede a validated native settings change only.
 * This is eligibility for one fixed setup prompt, never recovery authority.
 */
export function permitsCodexManagerSetup(
  tail: string,
  context: CodexClassificationContext,
  launchStartedAt: number
): boolean {
  if (
    context.tailTruncated !== false ||
    !Number.isFinite(launchStartedAt) ||
    launchStartedAt <= 0 ||
    launchStartedAt > context.now
  )
    return false;
  const original = classifyCodexTail(tail, context);
  if (original.activity !== 'paused' || original.reason !== 'approval-required') return false;
  let currentSettings = false;
  const retained: string[] = [];
  try {
    for (const line of tail.split('\n')) {
      if (!line) continue;
      const row = object(JSON.parse(line));
      const payload = row && object(row.payload);
      if (row?.type === 'event_msg' && payload?.type === 'thread_settings_applied') {
        if (!validThreadSettings(payload, context.conversationId)) return false;
        const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
        if (!Number.isFinite(at) || at > context.now) return false;
        if (at >= launchStartedAt) currentSettings = true;
        continue;
      }
      retained.push(line);
    }
  } catch {
    return false;
  }
  if (!currentSettings) return false;
  const prior = classifyCodexTail(retained.length ? retained.join('\n') + '\n' : '', context);
  return ['idle', 'completed'].includes(prior.activity);
}

export function classifyCodexTail(tail: string, context: CodexClassificationContext): RecoveryObservation {
  const unknown: RecoveryObservation = {
    activity: 'unknown',
    reason: 'observing',
    at: context.now,
    conversationId: context.conversationId,
    safeToAct: false,
  };
  if (Buffer.byteLength(tail) > MAX_CODEX_ROLLOUT_BYTES || (tail && !tail.endsWith('\n'))) return unknown;
  let result = unknown;
  let turnId: string | undefined;
  let terminalError: JsonObject | undefined;
  let submissionKey: string | undefined;
  let submissionHash: string | undefined;
  let progressAt = 0;
  let hasTurnStart = false;
  let turnStartedAt = 0;
  let pendingApproval = false;
  let ownerVetoReason: RecoveryReason = 'approval-required';
  let latestVetoAt = 0;
  let usageLimited = false;
  let blockedReason: RecoveryReason | undefined;
  let uncertainControl = false;
  const pendingAgents = new Set<string>();
  const childActivityAt = new Map<string, number>();
  const commands = new Map<string, { startedAt: number; signature: string; open: boolean }>();
  const updateChild = (
    rawId: unknown,
    status: unknown,
    nativeAt: unknown,
    recordedAt: number,
    sender: unknown,
    call: unknown
  ): boolean => {
    const id = token(rawId);
    if (!id || sender !== context.conversationId || !token(call)) return false;
    const validTime =
      Number.isSafeInteger(nativeAt) &&
      Number(nativeAt) > 0 &&
      Number(nativeAt) <= Math.min(context.now + 2000, recordedAt + 2000);
    const last = childActivityAt.get(id);
    if (terminalChildStatus(status)) {
      // A report can clear only the exact child's current causal baseline.
      // Parent journal append order is not proof that its cached status is new.
      if (
        pendingAgents.has(id) &&
        (!validTime ||
          !threadId(id) ||
          sender !== context.conversationId ||
          !token(call) ||
          Number(nativeAt) <= (last ?? 0))
      )
        return false;
      if (nativeAt !== undefined && nativeAt !== 0 && (!validTime || Number(nativeAt) < (last ?? 0))) return false;
      if (validTime) childActivityAt.set(id, Number(nativeAt));
      pendingAgents.delete(id);
    } else {
      // Legacy active records may lack native time; their row time is only a
      // conservative pending-work fence, never a completion certificate.
      if (nativeAt !== undefined && nativeAt !== 0 && !validTime) return false;
      const activeAt = validTime ? Number(nativeAt) : recordedAt;
      if (activeAt < (last ?? 0)) return false;
      childActivityAt.set(id, activeAt);
      pendingAgents.add(id); // running, interrupted, unknown or malformed status
    }
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
    if (!isCodexRolloutRecord(entry)) return unknown;
    if (entry.type !== 'event_msg') continue;
    const p = object(entry.payload);
    if (!p || typeof p.type !== 'string' || !p.type) return unknown;
    const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isFinite(at) || at > context.now + 2000) return unknown;
    progressAt = Math.max(progressAt, at);
    const update = (activity: RecoveryActivity, reason: RecoveryReason): void => {
      if (activity === 'paused') {
        pendingApproval = true;
        ownerVetoReason = reason;
        latestVetoAt = Math.max(latestVetoAt, at);
      } else if (activity === 'blocked') {
        latestVetoAt = Math.max(latestVetoAt, at);
        if (reason === 'usage-limit') usageLimited = true;
        else if (blockedReason !== 'authentication-required') blockedReason = reason;
      } else if (activity === 'unknown') {
        uncertainControl = true;
        latestVetoAt = Math.max(latestVetoAt, at);
      }
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
    const ownerVetoTime = (nativeAt: unknown): number | undefined => {
      if (nativeAt === undefined || nativeAt === 0) return at;
      if (!Number.isSafeInteger(nativeAt) || Number(nativeAt) <= 0 || Number(nativeAt) > context.now + 2000)
        return undefined;
      return Math.max(at, Number(nativeAt));
    };
    if (p.type === 'thread_settings_applied') {
      if (!validThreadSettings(p, context.conversationId)) return unknown;
      // Settings changes cannot revive older interrupted work or clear child,
      // authentication or quota vetoes. A later exact ordinary owner message
      // must supersede this control change before normal lifecycle evidence.
      update('paused', 'approval-required');
    } else if (p.type === 'user_message' || (p.type === 'item_completed' && object(p.item)?.type === 'UserMessage')) {
      const submitted = object(p.item);
      if (
        p.type === 'user_message'
          ? typeof p.message !== 'string'
          : p.thread_id !== context.conversationId ||
            !token(p.turn_id) ||
            !token(submitted?.id) ||
            !Array.isArray(submitted?.content) ||
            !submitted.content.every((block) => {
              const input = object(block);
              return input?.type === 'text' && typeof input.text === 'string';
            })
      )
        return unknown;
      let submittedAt = at;
      if (p.type === 'item_completed') {
        if (
          !Number.isSafeInteger(p.completed_at_ms) ||
          Number(p.completed_at_ms) <= 0 ||
          Number(p.completed_at_ms) > Math.min(context.now + 2000, at + 2000) ||
          (p.started_at_ms !== undefined &&
            (!Number.isSafeInteger(p.started_at_ms) ||
              Number(p.started_at_ms) <= 0 ||
              Number(p.started_at_ms) > Number(p.completed_at_ms)))
        )
          return unknown;
        submittedAt = Math.min(at, Number(p.completed_at_ms));
      }
      submissionKey = createHash('sha256').update(line).digest('hex');
      const content = object(p.item)?.content;
      const message =
        typeof p.message === 'string'
          ? p.message
          : Array.isArray(content)
            ? content.map((b) => (typeof object(b)?.text === 'string' ? object(b)?.text : '')).join('\n')
            : '';
      if (pendingApproval) {
        if (!message.trim() || submittedAt <= latestVetoAt) return unknown;
      }
      submissionHash = createHash('sha256').update(message.trim()).digest('hex');
      // A new prompt can precede task_started in the journal. It already supersedes the old failure.
      turnId = undefined;
      hasTurnStart = false;
      turnStartedAt = 0;
      pendingApproval = false;
      terminalError = undefined;
      update('working', 'turn-running');
    } else if (p.type === 'task_started' || p.type === 'turn_started') {
      turnId = token(p.turn_id);
      if (!turnId) return unknown;
      hasTurnStart = !!turnId;
      turnStartedAt = turnId ? at : 0;
      terminalError = undefined;
      update(turnId ? 'working' : 'unknown', turnId ? 'turn-running' : 'observing');
    } else if (p.type === 'stream_error' || p.type === 'auth_recovery_started') {
      // StreamError is provider-owned retry progress, not a terminal failure.
      terminalError = undefined;
      update('working', 'internal-retry');
    } else if (
      [
        'exec_approval_request',
        'apply_patch_approval_request',
        'elicitation_request',
        'request_user_input',
        'request_permissions',
      ].includes(p.type)
    ) {
      const vetoAt = ownerVetoTime(p.started_at_ms);
      if (vetoAt === undefined) return unknown;
      latestVetoAt = Math.max(latestVetoAt, vetoAt);
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
      const vetoAt = ownerVetoTime(p.completed_at === undefined ? undefined : Number(p.completed_at) * 1000);
      if (vetoAt === undefined || (p.completed_at !== undefined && !Number.isSafeInteger(p.completed_at)))
        return unknown;
      if (p.reason === 'budget_limited') update('blocked', 'usage-limit');
      else if (p.reason === 'replaced' || p.reason === 'review_ended') update('paused', 'user-interrupted');
      else if (p.reason === 'interrupted' && error) {
        const e = classifyError(error);
        update(e.activity, e.reason);
      } else update('paused', 'user-interrupted');
      if (result.activity === 'blocked' || result.activity === 'paused') latestVetoAt = Math.max(latestVetoAt, vetoAt);
    } else if (
      p.type === 'sub_agent_activity' ||
      ((p.type === 'item_started' || p.type === 'item_completed') && object(p.item)?.type === 'SubAgentActivity')
    ) {
      const item = p.type === 'sub_agent_activity' ? p : object(p.item)!;
      const id = item.agent_thread_id;
      const activityAt =
        p.type === 'sub_agent_activity'
          ? p.occurred_at_ms
          : p.type === 'item_started'
            ? p.started_at_ms
            : p.completed_at_ms;
      if (
        !threadId(id) ||
        !agentPath(item.agent_path) ||
        !token(p.type === 'sub_agent_activity' ? item.event_id : item.id) ||
        !optionalString(item.model) ||
        (item.reasoning_effort !== undefined &&
          item.reasoning_effort !== null &&
          !(
            typeof item.reasoning_effort === 'string' &&
            CODEX_REASONING_EFFORTS.some((effort) => effort === item.reasoning_effort)
          )) ||
        typeof item.kind !== 'string' ||
        !['started', 'interacted', 'interrupted', 'completed'].includes(item.kind) ||
        !Number.isSafeInteger(activityAt) ||
        Number(activityAt) <= 0 ||
        Number(activityAt) > Math.min(context.now + 2000, at + 2000) ||
        Number(activityAt) < (childActivityAt.get(id) ?? 0) ||
        (p.type !== 'sub_agent_activity' &&
          (p.thread_id !== context.conversationId || !token(p.turn_id) || (turnId && p.turn_id !== turnId)))
      )
        return unknown;
      if (
        p.type === 'item_completed' &&
        p.started_at_ms !== undefined &&
        (!Number.isSafeInteger(p.started_at_ms) ||
          Number(p.started_at_ms) <= 0 ||
          Number(p.started_at_ms) > Number(activityAt))
      )
        return unknown;
      // Completing the wrapper item does not complete a child whose kind is
      // started/interacted/interrupted. Only the child's exact completed kind does.
      if (
        !updateChild(
          id,
          item.kind === 'completed' ? 'completed' : undefined,
          activityAt,
          at,
          context.conversationId,
          p.type === 'sub_agent_activity' ? item.event_id : item.id
        )
      )
        return unknown;
    } else if (p.type === 'collab_agent_spawn_begin') {
      const call = token(p.call_id);
      if (!call || p.sender_thread_id !== context.conversationId) return unknown;
      // Spawn begins have no child identity yet. Retain their own operation
      // until the matching end provides a named child and a supported status.
      pendingAgents.add(`spawn:${call}`);
      if (
        p.started_at_ms !== undefined &&
        p.started_at_ms !== 0 &&
        (!Number.isSafeInteger(p.started_at_ms) || Number(p.started_at_ms) <= 0)
      )
        return unknown;
      const startedAt =
        Number.isSafeInteger(p.started_at_ms) && Number(p.started_at_ms) > 0 ? Number(p.started_at_ms) : at;
      if (startedAt > Math.min(context.now + 2000, at + 2000) || childActivityAt.has(`spawn:${call}`)) return unknown;
      childActivityAt.set(`spawn:${call}`, startedAt);
    } else if (p.type === 'collab_agent_spawn_end') {
      const call = token(p.call_id);
      if (!call || p.sender_thread_id !== context.conversationId) return unknown;
      if (p.new_thread_id === null || p.new_thread_id === undefined) {
        // Codex reports a failed spawn as no receiver plus NotFound. This can
        // release only its matching operation, never another named child.
        if (
          !call ||
          p.status !== 'not_found' ||
          !pendingAgents.has(`spawn:${call}`) ||
          p.sender_thread_id !== context.conversationId ||
          !Number.isSafeInteger(p.completed_at_ms) ||
          Number(p.completed_at_ms) <= (childActivityAt.get(`spawn:${call}`) ?? 0) ||
          Number(p.completed_at_ms) > Math.min(context.now + 2000, at + 2000)
        )
          return unknown;
        pendingAgents.delete(`spawn:${call}`);
      } else {
        if (!updateChild(p.new_thread_id, p.status, p.completed_at_ms, at, p.sender_thread_id, p.call_id))
          return unknown;
        if (call && pendingAgents.has(`spawn:${call}`)) {
          if (
            p.sender_thread_id !== context.conversationId ||
            !Number.isSafeInteger(p.completed_at_ms) ||
            Number(p.completed_at_ms) <= (childActivityAt.get(`spawn:${call}`) ?? 0) ||
            Number(p.completed_at_ms) > Math.min(context.now + 2000, at + 2000)
          )
            return unknown;
          pendingAgents.delete(`spawn:${call}`);
        }
      }
    } else if (['collab_agent_interaction_begin', 'collab_resume_begin', 'collab_close_begin'].includes(p.type)) {
      if (!updateChild(p.receiver_thread_id, undefined, p.started_at_ms, at, p.sender_thread_id, p.call_id))
        return unknown;
    } else if (['collab_agent_interaction_end', 'collab_resume_end', 'collab_close_end'].includes(p.type)) {
      if (!updateChild(p.receiver_thread_id, p.status, p.completed_at_ms, at, p.sender_thread_id, p.call_id))
        return unknown;
    } else if (p.type === 'collab_wait_begin' || p.type === 'collab_waiting_begin') {
      if (!Array.isArray(p.receiver_thread_ids) || p.receiver_thread_ids.length === 0) return unknown;
      for (const id of p.receiver_thread_ids)
        if (!updateChild(id, undefined, p.started_at_ms, at, p.sender_thread_id, p.call_id)) return unknown;
    } else if (p.type === 'collab_wait_end' || p.type === 'collab_waiting_end') {
      const statuses = object(p.statuses);
      if (!statuses || Object.keys(statuses).length === 0) return unknown;
      for (const [id, status] of Object.entries(statuses))
        if (!updateChild(id, status, p.completed_at_ms, at, p.sender_thread_id, p.call_id)) return unknown;
    } else if (p.type === 'exec_command_begin' || p.type === 'exec_command_end') {
      if (!commandShape(p) || !turnId || p.turn_id !== turnId) return unknown;
      const call = p.call_id as string;
      const eventAt = p.type === 'exec_command_begin' ? p.started_at_ms : p.completed_at_ms;
      if (
        !Number.isSafeInteger(eventAt) ||
        Number(eventAt) <= 0 ||
        Number(eventAt) > Math.min(context.now + 2000, at + 2000)
      )
        return unknown;
      const signature = JSON.stringify([
        p.turn_id,
        p.command,
        p.cwd,
        p.source ?? 'agent',
        p.process_id ?? null,
        p.interaction_input ?? null,
      ]);
      if (p.type === 'exec_command_begin') {
        if (commands.has(call)) return unknown;
        commands.set(call, { startedAt: Number(eventAt), signature, open: true });
      } else {
        const begin = commands.get(call);
        const duration = object(p.duration);
        if (
          !begin?.open ||
          begin.signature !== signature ||
          Number(eventAt) < begin.startedAt ||
          !Number.isInteger(p.exit_code) ||
          Number(p.exit_code) < -2147483648 ||
          Number(p.exit_code) > 2147483647 ||
          typeof p.status !== 'string' ||
          !['completed', 'failed', 'declined'].includes(p.status) ||
          (p.aggregated_output !== undefined && typeof p.aggregated_output !== 'string') ||
          !duration ||
          !Number.isSafeInteger(duration.secs) ||
          Number(duration.secs) < 0 ||
          !Number.isInteger(duration.nanos) ||
          Number(duration.nanos) < 0 ||
          Number(duration.nanos) >= 1_000_000_000
        )
          return unknown;
        begin.open = false;
        if (p.status === 'declined') {
          pendingApproval = true;
          ownerVetoReason = 'approval-required';
          latestVetoAt = Math.max(latestVetoAt, at, Number(eventAt));
        }
      }
      // New execution supersedes an old failure; a later explicit terminal turn
      // may establish a new outcome once every started command has ended.
      terminalError = undefined;
      update('working', 'turn-running');
    } else if (p.type === 'exec_command_output_delta') {
      if (
        !token(p.call_id) ||
        !commands.get(p.call_id as string)?.open ||
        typeof p.stream !== 'string' ||
        !['stdout', 'stderr'].includes(p.stream) ||
        typeof p.chunk !== 'string' ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.chunk) ||
        Buffer.from(p.chunk, 'base64').toString('base64') !== p.chunk
      )
        return unknown;
    } else if ((p.type === 'item_started' || p.type === 'item_completed') && object(p.item)) {
      const item = object(p.item)!;
      const itemAt = p.type === 'item_started' ? p.started_at_ms : p.completed_at_ms;
      if (
        p.thread_id !== context.conversationId ||
        !token(p.turn_id) ||
        (turnId && p.turn_id !== turnId) ||
        !Number.isSafeInteger(itemAt) ||
        Number(itemAt) <= 0 ||
        Number(itemAt) > Math.min(context.now + 2000, at + 2000) ||
        !passiveItem(item)
      )
        return unknown;
      if (p.type === 'item_started') {
        terminalError = undefined;
        update('working', 'turn-running');
      }
    } else if (passiveEvent(p)) {
      if (p.type.endsWith('_delta') && (p.thread_id !== context.conversationId || !turnId || p.turn_id !== turnId))
        return unknown;
      const rate = p.type === 'token_count' ? object(p.rate_limits) : undefined;
      if (
        rate &&
        (rate.spend_control_reached === true ||
          rate.rate_limit_reached_type != null ||
          ['primary', 'secondary'].some((key) => Number(object(rate[key])?.used_percent) >= 100) ||
          (object(rate.credits)?.has_credits === false && object(rate.credits)?.unlimited === false) ||
          Number(object(rate.individual_limit)?.remaining_percent) <= 0)
      ) {
        usageLimited = true;
        latestVetoAt = Math.max(latestVetoAt, at);
      }
    } else return unknown;
  }
  result.submissionKey = submissionKey;
  result.submissionHash = submissionHash;
  result.progressAt = progressAt || result.at;
  if (usageLimited) return { ...result, activity: 'blocked', reason: 'usage-limit', safeToAct: false };
  if (blockedReason) return { ...result, activity: 'blocked', reason: blockedReason, safeToAct: false };
  if (uncertainControl) return { ...result, activity: 'unknown', reason: 'observing', safeToAct: false };
  // A terminal turn row is not an owner approval receipt. An unresolved
  // request/decline keeps its veto until a new submitted owner prompt supersedes it.
  if (pendingApproval && !['unknown', 'blocked'].includes(result.activity)) {
    return { ...result, activity: 'paused', reason: ownerVetoReason, safeToAct: false };
  }
  if (
    [...commands.values()].some((command) => command.open) &&
    !['unknown', 'blocked', 'paused'].includes(result.activity)
  ) {
    return { ...result, activity: 'watching', reason: 'background-work', safeToAct: false };
  }
  if (result.activity === 'working' && result.reason === 'turn-running' && hasTurnStart && turnId && turnStartedAt) {
    result.stallEvidenceKey = `${context.conversationId}:${turnId}:${turnStartedAt}:stalled`;
  }
  if (result.activity === 'interrupted' && turnId && (context.lastIntentionalStopAt ?? 0) >= result.at - 2000) {
    result = { ...result, activity: 'paused', reason: 'user-interrupted', safeToAct: false };
  }
  const structuredVeto = ['unknown', 'blocked', 'paused'].includes(result.activity);
  if (context.screen === null && structuredVeto) return result;
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
    // Native busy hints cannot clear structured vetoes or active child work.
    if (structuredVeto) return result;
    if (context.watching || pendingAgents.size) {
      return { ...result, activity: 'watching', reason: 'background-work', safeToAct: false };
    }
    if (/esc to interrupt|reconnecting\.\.\.|retrying\.\.\./i.test(screen) || context.busy) {
      return { ...result, activity: 'working', reason: 'turn-running', safeToAct: false };
    }
    if (result.activity === 'interrupted' && turnId) {
      result.evidenceKey = `${context.conversationId}:${turnId}:${result.at}:${result.reason}`;
      result.safeToAct = context.tailTruncated === false && hasTurnStart && hasEmptyCodexComposer(screen);
    }
  }
  return result;
}
