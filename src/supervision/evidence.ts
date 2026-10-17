/** @fileoverview Only bounded paired structured execution evidence proves command success. */
import { createHash } from 'node:crypto';
import { MAX_CODEX_ROLLOUT_BYTES } from '../recovery/codex-evidence-limits.js';
import { isCodexRolloutRecord } from '../recovery/codex-classifier.js';
const SUPPORTED_POSIX_SHELLS = new Set([
  'bash',
  'sh',
  'zsh',
  '/bin/bash',
  '/bin/sh',
  '/bin/zsh',
  '/usr/bin/bash',
  '/usr/bin/sh',
  '/usr/bin/zsh',
]);
export function commandHash(command: string): string {
  return createHash('sha256').update(command).digest('hex');
}
// Keep exact execution attribution private and out of the durable/public criterion DTO.
const executionIdentities = new WeakMap<CommandSuccessEvidence, string>();
export function commandEvidenceIdentity(evidence: CommandSuccessEvidence): string | undefined {
  return executionIdentities.get(evidence);
}
/** Paired execution timestamps; a fresh end alone cannot prove post-configuration state. */
export interface CommandSuccessEvidence {
  startedAt: number;
  completedAt: number;
}
export function successfulCommands(tail: string, since: number, now: number): Map<string, CommandSuccessEvidence> {
  const result = new Map<string, CommandSuccessEvidence>();
  if (Buffer.byteLength(tail) > MAX_CODEX_ROLLOUT_BYTES || !tail.endsWith('\n')) return result;
  const pending = new Map<string, { command: string; at: number }>();
  const begunCalls = new Set<string>();
  const endedCalls = new Set<string>();
  const latest = new Map<string, { at: number; callId: string }>();
  for (const line of tail.split('\n')) {
    if (!line.trim()) continue;
    if (line.length > 262_144) return new Map();
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return new Map();
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) return new Map();
    const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
    const p = row.payload;
    if (!isCodexRolloutRecord(row)) return new Map();
    if (row.type !== 'event_msg') continue;
    if (
      typeof p.type !== 'string' ||
      !p.type ||
      typeof row.timestamp !== 'string' ||
      !Number.isFinite(at) ||
      at > now + 2000
    )
      return new Map();
    if (at < since) continue;
    if (p.type === 'exec_command_begin') {
      // Reused call identities cannot attribute an end to exactly one execution.
      // Include unsupported invocations so they cannot reuse a prior accepted begin.
      if (typeof p.call_id !== 'string' || !p.call_id || begunCalls.has(p.call_id) || endedCalls.has(p.call_id))
        return new Map();
      begunCalls.add(p.call_id);
      if (!Array.isArray(p.command) || !p.command.every((x: unknown) => typeof x === 'string')) return new Map();
      // Shell invocation must match the owner's EXACT command, without normalization.
      const c = p.command;
      const command =
        c.length === 3 && SUPPORTED_POSIX_SHELLS.has(c[0]) && ['-lc', '-c'].includes(c[1]) ? c[2] : undefined;
      if (command && command.length <= 1000) {
        const hash = commandHash(command);
        const prior = latest.get(hash);
        // Journal order says this execution began later; a backwards clock cannot preserve an older success.
        if (prior && at < prior.at) return new Map();
        if (!prior || at >= prior.at) {
          latest.set(hash, { at, callId: p.call_id });
          result.delete(hash); // a newer execution is not successful while pending or failed
        }
        if (pending.size < 100) pending.set(p.call_id, { command, at });
      }
    }
    if (p.type === 'exec_command_end') {
      if (typeof p.call_id !== 'string' || !p.call_id || !Number.isInteger(p.exit_code) || endedCalls.has(p.call_id))
        return new Map();
      endedCalls.add(p.call_id);
      const begin = pending.get(p.call_id);
      if (begin && at < begin.at) return new Map();
      if (
        p.exit_code === 0 &&
        begin &&
        at >= begin.at &&
        latest.get(commandHash(begin.command))?.callId === p.call_id
      ) {
        const hash = commandHash(begin.command);
        const prior = result.get(hash);
        // A late completion of older work must not erase a newer execution's freshness proof.
        if (!prior || begin.at > prior.startedAt || (begin.at === prior.startedAt && at > prior.completedAt)) {
          const evidence = { startedAt: begin.at, completedAt: at };
          // Keep the original execution and remote-domain timestamps stable even
          // when a later SSH sample changes their plausible local-time bounds.
          executionIdentities.set(
            evidence,
            createHash('sha256')
              .update(JSON.stringify([p.call_id, begin.at, at]))
              .digest('hex')
          );
          result.set(hash, evidence);
        }
      }
      // Every completed call releases its pending execution slot.
      pending.delete(p.call_id);
    }
  }
  return result;
}

export interface TaskProgressMarker {
  key: string;
  progress: unknown;
  /** Earliest plausible local timestamp. */
  at: number;
  /** Remote clock evidence may leave a bounded latest plausible timestamp. */
  latestAt?: number;
  submissionKey?: string;
  /** A recognizable report lacks a complete, trustworthy frame or timestamp. */
  uncertain?: boolean;
}

export function latestProgressMarker(tail: string, since: number, now: number): TaskProgressMarker | undefined {
  if (Buffer.byteLength(tail) > MAX_CODEX_ROLLOUT_BYTES) return undefined;
  const complete = tail.endsWith('\n');
  let marker: TaskProgressMarker | undefined;
  let submissionKey: string | undefined;
  let nativeSubmission: { threadId: string; turnId: string } | undefined;
  const uncertain = (line: string): TaskProgressMarker | undefined =>
    marker || line.includes('CODEMAN_TASK_PROGRESS ')
      ? {
          key: 'progress:' + createHash('sha256').update(line).digest('hex'),
          at: now,
          submissionKey,
          progress: null,
          uncertain: true,
        }
      : undefined;
  const lines = tail.split('\n');
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    if (line.length > 262_144) return uncertain(line);
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return uncertain(line);
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) return uncertain(line);
    let at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
    const p = row.payload;
    if (!isCodexRolloutRecord(row)) return uncertain(line);
    if (row.type !== 'event_msg') continue;
    if (
      typeof p.type !== 'string' ||
      !p.type ||
      typeof row.timestamp !== 'string' ||
      !Number.isFinite(at) ||
      at > now + 2000
    )
      return uncertain(line);
    if (p.type === 'user_message' || (p.type === 'item_completed' && p.item?.type === 'UserMessage')) {
      // Use the classifier's exact structured submission identity. Row order, not a timestamp,
      // prevents a future-dated prior turn marker from crossing a new user submission.
      submissionKey = createHash('sha256').update(line).digest('hex');
      marker = undefined;
      nativeSubmission =
        p.type === 'item_completed' &&
        typeof p.thread_id === 'string' &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(p.thread_id) &&
        typeof p.turn_id === 'string' &&
        /^[\w-]{1,100}$/.test(p.turn_id)
          ? { threadId: p.thread_id, turnId: p.turn_id }
          : undefined;
      continue;
    }
    let message: string;
    if (p.type === 'agent_message' && typeof p.message === 'string') message = p.message;
    else if (p.type === 'item_completed' && p.item?.type === 'AgentMessage') {
      const item = p.item;
      if (
        !nativeSubmission ||
        p.thread_id !== nativeSubmission.threadId ||
        p.turn_id !== nativeSubmission.turnId ||
        typeof item.id !== 'string' ||
        !/^[\w-]{1,100}$/.test(item.id) ||
        !Array.isArray(item.content) ||
        !item.content.every(
          (block: unknown) =>
            !!block &&
            typeof block === 'object' &&
            !Array.isArray(block) &&
            (block as { type?: unknown }).type === 'Text' &&
            typeof (block as { text?: unknown }).text === 'string'
        ) ||
        (item.questions !== undefined && (!Array.isArray(item.questions) || item.questions.length !== 0)) ||
        !Number.isSafeInteger(p.completed_at_ms) ||
        p.completed_at_ms <= 0 ||
        p.completed_at_ms > Math.min(now + 2000, at + 2000) ||
        (p.started_at_ms !== undefined &&
          (!Number.isSafeInteger(p.started_at_ms) || p.started_at_ms <= 0 || p.started_at_ms > p.completed_at_ms))
      )
        return uncertain(line);
      message = item.content.map((block: { text: string }) => block.text).join('');
      at = p.completed_at_ms;
    } else continue;
    if (at < since) continue;
    message = message.trim();
    if (!message.startsWith('CODEMAN_TASK_PROGRESS ')) continue;
    if (!complete && index === lines.length - 1) return uncertain(line);
    if (message.length > 16000) {
      // A recognized but oversized report is malformed evidence, never an absent report.
      marker = {
        at,
        submissionKey,
        key: 'progress:' + createHash('sha256').update(line).digest('hex'),
        progress: null,
      };
      continue;
    }
    try {
      marker = {
        at,
        submissionKey,
        key: 'progress:' + createHash('sha256').update(line).digest('hex'),
        progress: JSON.parse(message.slice(22)),
      };
    } catch {
      marker = {
        at,
        submissionKey,
        key: 'progress:' + createHash('sha256').update(line).digest('hex'),
        progress: null,
      };
    }
  }
  return !complete && marker ? uncertain(lines.at(-1) ?? '') : marker;
}
