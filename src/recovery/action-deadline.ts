/** @fileoverview Preserve the earliest private action deadline through ownership wrappers. */
import type { RecoveryActionAuthority } from './types.js';

export function earliestActionDeadline(ownDeadline: number, inherited: RecoveryActionAuthority): number {
  if (!Number.isFinite(ownDeadline) || ownDeadline < 0) return NaN;
  if (!inherited.getActionDeadline) return ownDeadline;
  try {
    const selected: unknown = inherited.getActionDeadline();
    if (selected instanceof Promise || (selected && typeof (selected as { then?: unknown }).then === 'function')) {
      void Promise.resolve(selected).catch(() => {});
      return NaN;
    }
    return typeof selected === 'number' && Number.isFinite(selected) && selected >= 0
      ? Math.min(ownDeadline, selected)
      : NaN;
  } catch {
    return NaN;
  }
}
