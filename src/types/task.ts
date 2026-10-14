/**
 * @fileoverview Task queue type definitions.
 *
 * Types for the prompt execution queue: TaskDefinition (input) and
 * TaskState (persisted state with execution details).
 *
 * Key exports:
 * - TaskDefinition — input type for creating a task (prompt, workingDir, priority, dependencies)
 * - TaskState — persisted state with execution details (status, assignedSessionId, output, error)
 * - TaskStatus — 'pending' | 'running' | 'completed' | 'failed'
 * - SupervisionTaskState, TaskProgress, TaskUpdate — public session task-supervision API payloads
 *
 * Cross-domain relationships:
 * - TaskState.assignedSessionId links to SessionState.id (session domain)
 * - TaskState is stored in AppState.tasks (app-state domain)
 *
 * Persisted to `~/.codeman/state.json`. No dependencies on other domain modules.
 */

/** Status of a task in the queue */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

/**
 * Definition of a task to be executed
 */
export interface TaskDefinition {
  /** Unique task identifier */
  id: string;
  /** Prompt to send to Claude */
  prompt: string;
  /** Working directory for task execution */
  workingDir: string;
  /** Priority level (higher = processed first) */
  priority: number;
  /** IDs of tasks that must complete first */
  dependencies: string[];
  /** Custom phrase to detect task completion */
  completionPhrase?: string;
  /** Timeout in milliseconds */
  timeoutMs?: number;
}

/**
 * Full state of a task including execution details
 */
export interface TaskState {
  /** Unique task identifier */
  id: string;
  /** Prompt sent to Claude */
  prompt: string;
  /** Working directory for task execution */
  workingDir: string;
  /** Priority level (higher = processed first) */
  priority: number;
  /** IDs of tasks that must complete first */
  dependencies: string[];
  /** Custom phrase to detect task completion */
  completionPhrase?: string;
  /** Timeout in milliseconds */
  timeoutMs?: number;
  /** Current task status */
  status: TaskStatus;
  /** ID of session running this task, null if not assigned */
  assignedSessionId: string | null;
  /** Timestamp when task was created */
  createdAt: number;
  /** Timestamp when task started executing */
  startedAt: number | null;
  /** Timestamp when task completed */
  completedAt: number | null;
  /** Captured output from Claude */
  output: string;
  /** Error message if task failed */
  error: string | null;
}

/** Owner-configured acceptance criterion definition for bounded session task supervision. */
export type TaskCriterionDefinition =
  | { id: string; description: string; kind: 'manual'; command?: never }
  | { id: string; description: string; kind: 'command'; command: string };

/** Acceptance criterion and its current verification evidence. */
export type TaskCriterion = TaskCriterionDefinition & {
  verified: boolean;
  evidence?: { source: 'owner' | 'command'; at: number; commandHash?: string };
};

/** Public state returned by the per-session task-supervision API. */
export interface SupervisionTaskState {
  version: 1;
  objective: string;
  criteria: TaskCriterion[];
  checkpoint: string;
  nextAction: string;
  outcome: TaskProgress['outcome'];
  config: { enabled: boolean; maxContinuations: number; maxRuntimeMs: number };
  continuations: number;
  phase: 'disabled' | 'watching' | 'paused' | 'blocked' | 'completed';
  reason: string;
  startedAt?: number;
  configuredAt?: number;
  kickoffAt?: number;
  lastProgressAt?: number;
  conversationId?: string;
  submissionKey?: string;
  /** Explicit uncertain or blocked agent progress retains authority to veto recovery. */
  agentProgressVeto?: boolean;
  inFlight?: {
    key: string;
    startedAt: number;
    promptHash?: string;
    action?: 'continue' | 'restart';
    accepted?: boolean;
    acceptedAt?: number;
    previousSubmissionKey?: string;
  };
  handledEvidence: string[];
  history: Array<{ at: number; reason: string }>;
}

/** Progress mutation accepted by the per-session task-supervision API. */
export interface TaskProgress {
  outcome: 'unknown' | 'unfinished' | 'blocked' | 'completed';
  checkpoint?: string;
  nextAction?: string;
  verifiedCriteria?: string[];
}

/** Configuration mutation accepted by the per-session task-supervision API. */
export interface TaskUpdate {
  objective?: string;
  criteria?: TaskCriterionDefinition[];
  config?: Partial<SupervisionTaskState['config']>;
}
