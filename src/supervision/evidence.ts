/** @fileoverview Only bounded paired structured execution evidence proves command success. */
import { createHash } from 'node:crypto';
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
/** Paired execution timestamps; a fresh end alone cannot prove post-configuration state. */
export interface CommandSuccessEvidence {
  startedAt: number;
  completedAt: number;
}
export function successfulCommands(tail: string, since: number, now: number): Map<string, CommandSuccessEvidence> {
  const result = new Map<string, CommandSuccessEvidence>();
  if (Buffer.byteLength(tail) > 262144 || !tail.endsWith('\n')) return result;
  const pending = new Map<string, { command: string; at: number }>();
  const begunCalls = new Set<string>();
  const endedCalls = new Set<string>();
  const latest = new Map<string, { at: number; callId: string }>();
  for (const line of tail.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return new Map();
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) return new Map();
    const at = Date.parse(row.timestamp);
    const p = row.payload;
    if (row.type !== 'event_msg') continue;
    if (
      !p ||
      typeof p !== 'object' ||
      Array.isArray(p) ||
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
        if (!prior || begin.at > prior.startedAt || (begin.at === prior.startedAt && at > prior.completedAt))
          result.set(hash, { startedAt: begin.at, completedAt: at });
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
  at: number;
  submissionKey?: string;
  /** A recognizable report lacks a complete, trustworthy frame or timestamp. */
  uncertain?: boolean;
}

export function latestProgressMarker(tail: string, since: number, now: number): TaskProgressMarker | undefined {
  if (Buffer.byteLength(tail) > 262144) return undefined;
  const complete = tail.endsWith('\n');
  let marker: TaskProgressMarker | undefined;
  let submissionKey: string | undefined;
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
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return uncertain(line);
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) return uncertain(line);
    const at = Date.parse(row.timestamp);
    const p = row.payload;
    if (row.type !== 'event_msg' || !p || typeof p !== 'object') continue;
    if (!Number.isFinite(at) || at > now + 2000) return uncertain(line);
    if (p.type === 'user_message' || (p.type === 'item_completed' && p.item?.type === 'UserMessage')) {
      // Use the classifier's exact structured submission identity. Row order, not a timestamp,
      // prevents a future-dated prior turn marker from crossing a new user submission.
      submissionKey = createHash('sha256').update(line).digest('hex');
      marker = undefined;
      continue;
    }
    if (p.type !== 'agent_message' || typeof p.message !== 'string' || at < since) continue;
    const message = p.message.trim();
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
