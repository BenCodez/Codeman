/** @fileoverview Non-secret binding between a native reboot launch and its acknowledged main-state identity. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SessionState } from '../types.js';
import { CODEX_REASONING_EFFORTS } from '../types/session.js';
import { normalizedCodexHome } from './codex-home.js';

type Snapshot = SessionState & { __codexRecoveryHome?: string };
// Only an exact eligible launch configuration may acknowledge this transition.
const CompletedRestoreConfig = z
  .object({
    model: z
      .string()
      .max(100)
      .regex(/^[a-zA-Z0-9._\-/]+$/)
      .optional(),
    reasoningEffort: z.enum(CODEX_REASONING_EFFORTS).optional(),
    resumeSessionId: z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/),
    dangerouslyBypassApprovals: z.boolean().optional(),
    animations: z.boolean().optional(),
    noDaemon: z.literal(true),
    noAltScreen: z.boolean().optional(),
    sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
    approvalPolicy: z.enum(['on-request', 'never']).optional(),
    renderMode: z.literal('hybrid').optional(),
  })
  .strict();
const OriginalRestoreConfig = CompletedRestoreConfig.extend({
  resumeSessionId: CompletedRestoreConfig.shape.resumeSessionId.optional(),
});

/** Validate historical settings before preparation and the exact planned settings before launch. */
export function isCodexRestoreConfig(config: unknown, requireResume = false): boolean {
  return (requireResume ? CompletedRestoreConfig : OriginalRestoreConfig).safeParse(config).success;
}

export function rebootStateBinding(state: Snapshot | null | undefined): string | undefined {
  const home = normalizedCodexHome(state?.__codexRecoveryHome);
  const config = state?.codexConfig;
  if (
    !state ||
    state.mode !== 'codex' ||
    !home ||
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    !CompletedRestoreConfig.safeParse(config).success ||
    typeof state.id !== 'string' ||
    typeof state.workingDir !== 'string' ||
    (state.owner !== undefined && typeof state.owner !== 'string')
  )
    return undefined;
  const canonicalConfig = Object.fromEntries(Object.entries(config).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return createHash('sha256')
    .update(JSON.stringify([state.id, state.owner ?? null, state.workingDir, home, canonicalConfig]))
    .digest('hex');
}
