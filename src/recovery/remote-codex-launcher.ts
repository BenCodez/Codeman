/** A remote host command can be an argv-forwarding Codex launcher executable. */
import type { SessionRemote } from '../types.js';

/** Shell programs/arguments remain legacy overrides, never controlled Codex launches. */
export function remoteCodexLauncher(remote: Pick<SessionRemote, 'commands'>): string | undefined {
  const value = remote.commands?.codex;
  if (value === undefined || value === '') return 'codex';
  if (value.length > 4096 || !/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*|\/[A-Za-z0-9_./-]+)$/.test(value)) return undefined;
  if (value.split('/').some((part) => part === '.' || part === '..') || value.endsWith('/')) return undefined;
  return value;
}
