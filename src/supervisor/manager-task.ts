/** @fileoverview Bounded task prompt used to start the opt-in Codex manager. */
import { TaskUpdateSchema, type TaskUpdate } from '../supervision/schema.js';

export const SUPERVISOR_MANAGER_MAX_RUNTIME_MS = 86_400_000;

export function buildSupervisorManagerTask(objective: string): TaskUpdate {
  return TaskUpdateSchema.parse({
    objective: `Manage the selected workers for this objective: ${objective}\nUse only codeman agent supervisor commands. Run "codeman agent supervisor workers" to inspect the configured worker IDs. Assign with "codeman agent supervisor assign <worker-id> --request-id <durable-id>". Retry only a reported crash. Base status on checkpoints, verified criteria, and recovery health. Never send raw input, interrupt, kill, merge, deploy, change privileges, or claim manual acceptance. Stop for waiting-user, authentication, usage limits, unreachable or unknown state, clean exit, or uncertain delivery.`,
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
