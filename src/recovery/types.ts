/** @fileoverview Recovery contracts. Observation and automation state are deliberately independent. */
import type { CodexIdentityResult } from './codex-identity.js';

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
/** Pure current owner authority plus a fresh issuer evidence check at each effect boundary. */
export interface RecoveryEvidenceSource {
  sessionId: string;
  identity: CodexIdentityResult;
  isCurrent(): boolean;
}
export function isRecoveryEvidenceSourceCurrent(source: RecoveryEvidenceSource): boolean {
  try {
    const verdict: unknown = source.isCurrent();
    if (verdict instanceof Promise) {
      void verdict.catch(() => {});
      return false;
    }
    return verdict === true;
  } catch {
    return false;
  }
}

export type RecoveryEvidenceGuard = (() => boolean | Promise<boolean>) & {
  getEvidenceSource?: () => RecoveryEvidenceSource | undefined;
};
export type RecoveryActionAuthority = (() => boolean) & {
  prepareEvidence?: (source?: RecoveryEvidenceSource) => Promise<boolean>;
};

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
  /** True only when a fresh owned pane probe also proves an abnormal dead process. */
  stallRestartable?: boolean;
  /** Local clock boundary of a remote dead-pane observation; repeated reads must advance it. */
  stallObservedAt?: number;
  /** Private process discriminator for repeated dead-pane proofs, independent of the durable turn identity. */
  processProofKey?: string;
  /** Last structured user-message identity, for verifying that a continuation was accepted. */
  submissionKey?: string;
  turnId?: string;
  progressAt?: number;
  /** Stable complete native remote event identity; local clock bounds cannot identify progress. */
  progressEvidenceKey?: string;
  /** Earliest plausible local progress time, for conservative owner/recovery ordering. */
  progressLowerBound?: number;
  submissionHash?: string;
  processReady?: boolean;
  /** Conservative start of the current bounded live-pane read, independent of historical rollout time. */
  processReadyAt?: number;
  /** A matching owned pane was directly observed live at this time before a newly detected crash. */
  liveProofAt?: number;
  /** Adapter revalidates ownership, identity, process state and empty composer immediately before acting. */
  safeToAct: boolean;
}

/** Fresh live-pane readiness confirms a restart; historical rollout content cannot. */
export function hasFreshProcessReady(observation: RecoveryObservation, startedAt: number, now: number): boolean {
  const at = observation.processReadyAt;
  return (
    observation.processReady === true &&
    ['idle', 'working', 'completed'].includes(observation.activity) &&
    Number.isFinite(startedAt) &&
    startedAt >= 0 &&
    typeof at === 'number' &&
    Number.isFinite(at) &&
    at >= startedAt &&
    at <= now &&
    now - at <= 30_000
  );
}

export interface RecoveryEvent {
  at: number;
  kind: 'state' | 'scheduled' | 'continue' | 'restart' | 'accepted' | 'attention' | 'reset';
  reason: RecoveryReason;
  attempt: number;
}

export interface RecoveryFlight {
  accepted?: boolean;
  acceptedAt?: number;
  key: string;
  action: RecoveryAction;
  conversationId: string;
  startedAt: number;
  reason?: RecoveryReason;
  previousSubmissionKey?: string;
  /** Exact structured silence baseline reserved for this stall recovery cycle. */
  stallProgressAt?: number;
  stallProgressEvidenceKey?: string;
  /** Final remote read must still satisfy the owner's full quiet interval. */
  stallQuietPeriodMs?: number;
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
  stallAlert?: { key: string; conversationId: string; progressAt: number; progressEvidenceKey?: string };
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
