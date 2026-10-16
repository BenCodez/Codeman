/** @fileoverview Bounded task prompt used to start the opt-in Codex manager. */
import { TaskProgressSchema, TaskUpdateSchema, type TaskState, type TaskUpdate } from '../supervision/schema.js';
import { latestProgressMarker } from '../supervision/evidence.js';
import type { RecoveryObservation } from '../recovery/types.js';

export const SUPERVISOR_MANAGER_MAX_RUNTIME_MS = 86_400_000;

/** Inspect the same verified native tail without applying progress or certifying owner criteria. */
export function managerProgressAllowsAction(
  state: TaskState,
  observation: RecoveryObservation,
  tail: string,
  now: number
): boolean {
  const flight = state.inFlight;
  const submissionKey =
    state.submissionKey ??
    (flight?.promptHash &&
    observation.submissionHash === flight.promptHash &&
    observation.submissionKey !== flight.previousSubmissionKey
      ? observation.submissionKey
      : undefined);
  if (!submissionKey || observation.submissionKey !== submissionKey) return false;
  const marker = latestProgressMarker(tail, state.configuredAt ?? state.startedAt ?? now, now);
  if (!marker) return true;
  if (marker.submissionKey !== submissionKey) return false;
  if (marker.uncertain) return false;
  // Timestamp equality or regression cannot turn a different report into an acknowledgement.
  // Only a handled identity retains the owner's prior explicit acceptance.
  if (state.handledEvidence.includes(marker.key)) return true;
  const parsed = TaskProgressSchema.safeParse(marker.progress);
  return (
    parsed.success &&
    marker.at <= now &&
    parsed.data.outcome === 'unfinished' &&
    !!parsed.data.checkpoint?.trim() &&
    !!parsed.data.nextAction?.trim() &&
    // Manager acceptance belongs to the owner; an agent report cannot certify it.
    (parsed.data.verifiedCriteria?.length ?? 0) === 0
  );
}

export function buildSupervisorManagerTask(objective: string): TaskUpdate {
  return TaskUpdateSchema.parse({
    objective: `Manage the selected workers for this objective: ${objective}\nUse only the codeman_supervisor MCP tools. Call supervisor_workers to inspect the configured worker IDs. Assign with supervisor_assign using the exact workerId and a durable requestId; preserve that requestId after an uncertain response. Retry only a reported crash. Base status on checkpoints, verified criteria, and recovery health. Never send raw input, interrupt, kill, merge, deploy, change privileges, or claim manual acceptance. Stop for waiting-user, authentication, usage limits, unreachable or unknown state, clean exit, or uncertain delivery.`,
    criteria: [
      {
        id: 'owner-supervisor-acceptance',
        description: 'The owner reviewed the worker evidence and accepted the supervisor objective',
        kind: 'manual',
      },
    ],
    config: { enabled: false, maxContinuations: 10, maxRuntimeMs: SUPERVISOR_MANAGER_MAX_RUNTIME_MS },
  });
}
