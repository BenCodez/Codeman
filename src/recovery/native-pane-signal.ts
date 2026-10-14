/** @fileoverview Strict decoding of local tmux signal tokens without losing their native identity. */
import { constants as osConstants } from 'node:os';

/** Empty means unreported; null means malformed or unsupported by this platform. */
export function parseNativePaneSignal(token: string): number | undefined | null {
  if (token === '') return undefined;
  const signals = osConstants.signals as Record<string, number>;
  if (/^(?:0|[1-9]\d{0,4})$/.test(token)) {
    const value = Number(token);
    return value === 0 || Object.values(signals).includes(value) ? value : null;
  }
  if (!/^[A-Z][A-Z0-9]{0,15}$/.test(token)) return null;
  const key = `SIG${token}`;
  return Object.hasOwn(signals, key) && Number.isSafeInteger(signals[key]) && signals[key] > 0 ? signals[key] : null;
}

export function matchesNativePaneSignal(signal: number | undefined, token: string | undefined): boolean {
  const decoded = parseNativePaneSignal(token ?? '');
  return decoded !== null && decoded === signal;
}
