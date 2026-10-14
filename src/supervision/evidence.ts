/** @fileoverview Only bounded structured ExecCommandEnd evidence proves command success. */
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
export function successfulCommands(tail: string, since: number, now: number): Map<string, number> {
  const result = new Map<string, number>();
  if (Buffer.byteLength(tail) > 262144 || !tail.endsWith('\n')) return result;
  const pending = new Map<string, { command: string; at: number }>();
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
    if (
      row.type !== 'event_msg' ||
      !p ||
      typeof p !== 'object' ||
      !Number.isFinite(at) ||
      at < since ||
      at > now + 2000
    )
      continue;
    if (
      p.type === 'exec_command_begin' &&
      typeof p.call_id === 'string' &&
      Array.isArray(p.command) &&
      p.command.every((x: unknown) => typeof x === 'string')
    ) {
      // Shell invocation must match the owner's EXACT command, without normalization.
      const c = p.command;
      const command =
        c.length === 3 && SUPPORTED_POSIX_SHELLS.has(c[0]) && ['-lc', '-c'].includes(c[1]) ? c[2] : undefined;
      if (command && command.length <= 1000 && pending.size < 100) pending.set(p.call_id, { command, at });
    }
    if (p.type === 'exec_command_end' && typeof p.call_id === 'string' && p.exit_code === 0) {
      const begin = pending.get(p.call_id);
      if (begin && at >= begin.at) result.set(commandHash(begin.command), at);
      pending.delete(p.call_id);
    }
  }
  return result;
}

export function latestProgressMarker(
  tail: string,
  since: number,
  now: number
): { key: string; progress: unknown; at: number; submissionKey?: string } | undefined {
  if (Buffer.byteLength(tail) > 262144 || !tail.endsWith('\n')) return undefined;
  let marker: { key: string; progress: unknown; at: number; submissionKey?: string } | undefined;
  let submissionKey: string | undefined;
  for (const line of tail.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return undefined;
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) return undefined;
    const at = Date.parse(row.timestamp);
    const p = row.payload;
    if (row.type !== 'event_msg' || !p || typeof p !== 'object') continue;
    if (!Number.isFinite(at) || at > now + 2000) return undefined;
    if (p.type === 'user_message' || (p.type === 'item_completed' && p.item?.type === 'UserMessage')) {
      // Use the classifier's exact structured submission identity. Row order, not a timestamp,
      // prevents a future-dated prior turn marker from crossing a new user submission.
      submissionKey = createHash('sha256').update(line).digest('hex');
      marker = undefined;
      continue;
    }
    if (p.type !== 'agent_message' || typeof p.message !== 'string' || at < since) continue;
    const message = p.message.trim();
    if (!message.startsWith('CODEMAN_TASK_PROGRESS ') || message.length > 16000) continue;
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
  return marker;
}
