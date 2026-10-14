/** @fileoverview Recovery contracts. Observation and automation state are deliberately independent. */

export interface RecoveryConfig {
  enabled: boolean;
  recoverInterrupted: boolean;
  recoverCrashes: boolean;
  detectStalls: boolean;
  maxRetries: number;
  retryDelayMs: number;
  maxRetryDelayMs: number;
  maxRecoveryDurationMs: number;
  stalledAfterMs: number;
}

export const DEFAULT_RECOVERY_CONFIG: RecoveryConfig = {
  enabled: false,
  recoverInterrupted: true,
  recoverCrashes: true,
  detectStalls: false,
  maxRetries: 3,
  retryDelayMs: 15_000,
  maxRetryDelayMs: 120_000,
  maxRecoveryDurationMs: 15 * 60_000,
  stalledAfterMs: 5 * 60_000,
};

export type RecoveryActivity =
  | 'unknown'
  | 'idle'
  | 'working'
  | 'watching'
  | 'interrupted'
  | 'completed'
  | 'paused'
  | 'blocked'
  | 'crashed'
  | 'exited';

export type RecoveryPhase = 'idle' | 'watching' | 'recovering' | 'paused' | 'blocked' | 'completed' | 'failed';
export type RecoveryAction = 'continue' | 'restart';

/** Reasons are closed, sanitized codes: never persist raw terminal, transcript or SSH diagnostics. */
export type RecoveryReason =
  | 'disabled'
  | 'observing'
  | 'identity-unverified'
  | 'identity-changed'
  | 'managed-daemon'
  | 'unsupported-location'
  | 'transport-unreachable'
  | 'transport-unavailable'
  | 'remote-inspector-unavailable'
  | 'remote-session-missing'
  | 'unowned-session'
  | 'user-input'
  | 'user-interrupted'
  | 'approval-required'
  | 'authentication-required'
  | 'usage-limit'
  | 'internal-retry'
  | 'turn-running'
  | 'background-work'
  | 'turn-completed'
  | 'turn-interrupted'
  | 'turn-failed'
  | 'process-crashed'
  | 'clean-exit'
  | 'pane-unverified'
  | 'stalled'
  | 'stall-unverified'
  | 'scheduled'
  | 'continuation-sent'
  | 'process-resumed'
  | 'recovery-accepted'
  | 'delivery-failed'
  | 'acceptance-unverified'
  | 'retries-exhausted'
  | 'recovery-window-exhausted'
  | 'restart-in-flight'
  | 'persistence-failed'
  | 'manual-reset';

export interface RecoveryObservation {
  activity: RecoveryActivity;
  reason: RecoveryReason;
  at: number;
  conversationId?: string;
  /** Current-turn failure or process-exit identity. Repeated observations share this key. */
  evidenceKey?: string;
  /** Stable identity for a structured turn that started but has no terminal event. */
  stallEvidenceKey?: string;
  /** True only when a fresh local pane probe also proves an abnormal dead process. */
  stallRestartable?: boolean;
  /** Last structured user-message identity, for verifying that a continuation was accepted. */
  submissionKey?: string;
  turnId?: string;
  progressAt?: number;
  submissionHash?: string;
  processReady?: boolean;
  /** A matching remote pane was directly observed live at this time before a newly detected crash. */
  liveProofAt?: number;
  /** Adapter revalidates ownership, identity, process state and empty composer immediately before acting. */
  safeToAct: boolean;
}

export interface RecoveryEvent {
  at: number;
  kind: 'state' | 'scheduled' | 'continue' | 'restart' | 'accepted' | 'attention' | 'reset';
  reason: RecoveryReason;
  attempt: number;
}

export interface RecoveryFlight {
  key: string;
  action: RecoveryAction;
  conversationId: string;
  startedAt: number;
  reason?: RecoveryReason;
  previousSubmissionKey?: string;
  /** Exact structured silence baseline reserved for this stall recovery cycle. */
  stallProgressAt?: number;
}

export interface RecoveryState {
  version: 1;
  config: RecoveryConfig;
  activity: RecoveryActivity;
  phase: RecoveryPhase;
  conversationId?: string;
  attempts: number;
  failedAttempts: number;
  windowStartedAt?: number;
  nextRetryAt?: number;
  lastSuccessfulRecovery?: number;
  armedAt?: number;
  lastReason: RecoveryReason;
  circuitOpen: boolean;
  needsAttention: boolean;
  /** Durable warning identity only. Fresh private dead-pane confirmations are still required to restart. */
  stallAlert?: { key: string; conversationId: string; progressAt: number };
  inFlight?: RecoveryFlight;
  pending?: { key: string; action: RecoveryAction; conversationId: string; reason?: RecoveryReason };
  handledEvidence: string[];
  history: RecoveryEvent[];
}

export const CONTINUATION_PROMPT =
  'Continue the previous unfinished task from the last verified state. Inspect recent actions and repository changes before proceeding. Do not duplicate completed edits, commits, external actions, or destructive operations. If the task is complete or requires user approval, stop and report its status.';

export function initialRecoveryState(): RecoveryState {
  return {
    version: 1,
    config: { ...DEFAULT_RECOVERY_CONFIG },
    activity: 'unknown',
    phase: 'idle',
    attempts: 0,
    failedAttempts: 0,
    lastReason: 'disabled',
    circuitOpen: false,
    needsAttention: false,
    handledEvidence: [],
    history: [],
  };
}
