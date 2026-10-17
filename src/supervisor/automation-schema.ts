/** Bounded instruction schedules; owner intent is never interpreted as an OS command. */
import { z } from 'zod';
import { PromptTextSchema } from '../supervision/schema.js';
import type { SupervisorAutomationConfig, SupervisorAutomationRecord } from '../types/supervisor-automation.js';

export const MAX_SUPERVISOR_AUTOMATION_RECEIPTS = 128;
export const SUPERVISOR_CHECK_IN_MAX_RUNS = 100;

/** Disabled custom tasks remain runnable explicitly; enabled only controls their timer. */
export function remainingAutomationRuns(
  config: SupervisorAutomationConfig,
  runs: SupervisorAutomationRecord['runs'] = []
): number {
  const remaining = (id: string, limit: number) =>
    Math.max(0, limit - (runs.find((run) => run.taskId === id)?.attempts ?? 0));
  return (
    (config.checkIns.enabled ? remaining('check-in', SUPERVISOR_CHECK_IN_MAX_RUNS) : 0) +
    config.tasks.reduce((sum, task) => sum + remaining(task.id, task.kind === 'once' ? 1 : task.maxRuns), 0)
  );
}

export const AutomationTaskId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/)
  .refine((id) => id !== 'check-in');
const Task = z
  .object({
    id: AutomationTaskId,
    name: PromptTextSchema.min(1)
      .max(100)
      .refine((text) => !!text.trim()),
    instructions: PromptTextSchema.min(1)
      .max(4000)
      .refine((text) => !!text.trim()),
    enabled: z.boolean(),
    kind: z.enum(['once', 'recurring']),
    intervalMinutes: z.number().int().min(1).max(1440).optional(),
    maxRuns: z.number().int().min(1).max(100),
  })
  .strict()
  .refine(
    (task) => task.kind !== 'recurring' || task.intervalMinutes !== undefined,
    'Recurring tasks require an interval'
  );
const DurableConfigSchema = z
  .object({
    checkIns: z.object({ enabled: z.boolean(), intervalMinutes: z.number().int().min(1).max(1440) }).strict(),
    tasks: z.array(Task).max(12),
  })
  .strict()
  .refine((config) => new Set(config.tasks.map((task) => task.id)).size === config.tasks.length, 'Duplicate task ID');
export const SupervisorAutomationConfigSchema = DurableConfigSchema.refine(
  (config) => remainingAutomationRuns(config) <= MAX_SUPERVISOR_AUTOMATION_RECEIPTS,
  'Management schedules share 128 lifetime receipt slots; enabled check-ins allocate 100, once tasks 1, and recurring tasks maxRuns (including disabled custom tasks).'
);
export const SupervisorAutomationRequestSchema = z.object({ requestId: z.string().regex(/^[\w:.-]{8,120}$/) }).strict();
const Run = z
  .object({
    requestId: SupervisorAutomationRequestSchema.shape.requestId,
    taskId: z.union([AutomationTaskId, z.literal('check-in')]),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    startedAt: z.number().finite().nonnegative(),
    phase: z.enum(['reserved', 'accepted', 'refused', 'unknown']),
  })
  .strict();
// Older overallocated schedules remain inspectable and repairable without dropping receipts.
export const SupervisorAutomationRecordSchema = DurableConfigSchema.safeExtend({
  version: z.literal(1),
  supervisorSessionId: z.string().regex(/^[\w-]{8,100}$/),
  runs: z
    .array(
      z
        .object({
          taskId: Run.shape.taskId,
          attempts: z.number().int().min(0).max(MAX_SUPERVISOR_AUTOMATION_RECEIPTS),
          nextRunAt: z.number().finite().nonnegative().optional(),
        })
        .strict()
    )
    .max(MAX_SUPERVISOR_AUTOMATION_RECEIPTS),
  handled: z.array(Run).max(MAX_SUPERVISOR_AUTOMATION_RECEIPTS),
  inFlight: Run.optional(),
  reason: z.string().regex(/^[\w-]{1,80}$/),
})
  .refine(
    (state) =>
      new Set(state.handled.map((run) => run.requestId)).size === state.handled.length &&
      new Set(state.runs.map((run) => run.taskId)).size === state.runs.length &&
      (!state.inFlight || !state.handled.some((run) => run.requestId === state.inFlight!.requestId)),
    'Duplicate durable run binding'
  )
  .refine(
    (state) => state.handled.length + (state.inFlight ? 1 : 0) <= MAX_SUPERVISOR_AUTOMATION_RECEIPTS,
    'Management receipt capacity exceeded'
  )
  .refine(
    (state) =>
      state.handled.every((run) => run.phase === 'accepted' || run.phase === 'refused') &&
      (!state.inFlight || ['reserved', 'unknown'].includes(state.inFlight.phase)),
    'Unresolved instructions retain their in-flight seal'
  );

export function initialSupervisorAutomationRecord(supervisorSessionId: string): SupervisorAutomationRecord {
  return {
    version: 1,
    supervisorSessionId,
    checkIns: { enabled: false, intervalMinutes: 60 },
    tasks: [],
    runs: [],
    handled: [],
    reason: 'disabled',
  };
}
