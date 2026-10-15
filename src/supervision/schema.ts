/** @fileoverview Strict bounded task inputs and durable public state. */
import { z } from 'zod';
import type { SupervisionTaskState } from '../types/task.js';
export type { SupervisionTaskState as TaskState, TaskProgress, TaskUpdate } from '../types/task.js';
// Task prompts flatten CR/LF. Every other terminal control remains a keypress,
// including tabs and C1 controls; reject those before reserving any delivery.
export const PromptTextSchema = z
  .string()
  // eslint-disable-next-line no-control-regex -- terminal control bytes are the rejected input
  .regex(/^[^\x00-\x09\x0b\x0c\x0e-\x1f\x7f-\x9f]*$/, 'Prompt text must not contain terminal control characters');
const Text = PromptTextSchema.max(4000);
export const TaskConfigSchema = z
  .object({
    enabled: z.boolean(),
    maxContinuations: z.number().int().min(0).max(10),
    maxRuntimeMs: z.number().int().min(1000).max(86_400_000),
  })
  .strict();
const CriterionId = z.string().regex(/^[\w-]{1,80}$/);
const CriterionDescription = PromptTextSchema.min(1)
  .max(1000)
  .refine((value) => value.trim().length > 0, 'Criterion description must contain non-whitespace text');
const CriterionCommand = PromptTextSchema.min(1)
  .max(1000)
  .refine((value) => value.trim().length > 0, 'Criterion command must contain non-whitespace text');
export const CriterionSchema = z.discriminatedUnion('kind', [
  z.object({ id: CriterionId, description: CriterionDescription, kind: z.literal('manual') }).strict(),
  z
    .object({
      id: CriterionId,
      description: CriterionDescription,
      kind: z.literal('command'),
      command: CriterionCommand,
    })
    .strict(),
]);
export const CriteriaSchema = z
  .array(CriterionSchema)
  .min(1)
  .max(30)
  .refine((c) => new Set(c.map((x) => x.id)).size === c.length);
export const TaskUpdateSchema = z
  .object({
    objective: Text.min(1)
      .refine((value) => value.trim().length > 0, 'Task objective must contain non-whitespace text')
      .optional(),
    criteria: CriteriaSchema.optional(),
    config: TaskConfigSchema.partial().optional(),
  })
  .strict();
export const TaskProgressSchema = z
  .object({
    outcome: z.enum(['unknown', 'unfinished', 'blocked', 'completed']),
    checkpoint: Text.optional(),
    nextAction: Text.optional(),
    verifiedCriteria: z
      .array(z.string().regex(/^[\w-]{1,80}$/))
      .max(30)
      .optional(),
  })
  .strict();
export const TaskActionSchema = z.object({}).strict();
export const TaskStateSchema = z
  .object({
    version: z.literal(1),
    objective: Text,
    criteria: z
      .array(
        z.discriminatedUnion('kind', [
          z
            .object({
              id: CriterionId,
              description: CriterionDescription,
              kind: z.literal('manual'),
              verified: z.boolean(),
              evidence: z
                .object({
                  source: z.enum(['owner', 'command']),
                  at: z.number(),
                  commandHash: z.string().max(64).optional(),
                })
                .strict()
                .optional(),
            })
            .strict(),
          z
            .object({
              id: CriterionId,
              description: CriterionDescription,
              kind: z.literal('command'),
              command: CriterionCommand,
              verified: z.boolean(),
              evidence: z
                .object({
                  source: z.enum(['owner', 'command']),
                  at: z.number(),
                  commandHash: z.string().max(64).optional(),
                })
                .strict()
                .optional(),
            })
            .strict(),
        ])
      )
      .max(30),
    checkpoint: Text,
    nextAction: Text,
    outcome: TaskProgressSchema.shape.outcome,
    config: TaskConfigSchema,
    continuations: z.number().int().min(0).max(10),
    phase: z.enum(['disabled', 'watching', 'paused', 'blocked', 'completed']),
    reason: z.string().regex(/^[\w-]{1,80}$/),
    startedAt: z.number().optional(),
    configuredAt: z.number().optional(),
    kickoffAt: z.number().optional(),
    lastProgressAt: z.number().optional(),
    conversationId: z.string().max(100).optional(),
    submissionKey: z.string().max(100).optional(),
    agentProgressVeto: z.boolean().optional(),
    inFlight: z
      .object({
        key: z.string().min(1).max(250),
        startedAt: z.number(),
        promptHash: z.string().max(64).optional(),
        action: z.enum(['continue', 'restart']).optional(),
        accepted: z.boolean().optional(),
        acceptedAt: z.number().finite().nonnegative().optional(),
        previousSubmissionKey: z.string().max(100).optional(),
      })
      .strict()
      .optional(),
    handledEvidence: z.array(z.string().max(250)).max(32),
    history: z.array(z.object({ at: z.number(), reason: z.string().max(80) }).strict()).max(100),
  })
  .strict()
  .refine(
    (state) => {
      const flight = state.inFlight;
      if (!flight?.accepted) return true;
      return (
        !!state.conversationId &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(state.conversationId) &&
        Number.isFinite(flight.startedAt) &&
        flight.startedAt >= 0 &&
        flight.acceptedAt !== undefined &&
        flight.acceptedAt >= flight.startedAt &&
        state.handledEvidence.includes(flight.key) &&
        (flight.action === 'restart'
          ? !flight.promptHash
          : flight.action === 'continue' &&
            /^[a-f0-9]{64}$/.test(flight.promptHash ?? '') &&
            !!state.submissionKey &&
            state.submissionKey !== flight.previousSubmissionKey)
      );
    },
    { message: 'Accepted delivery evidence is incomplete', path: ['inFlight'] }
  );
export function initialTaskState(): SupervisionTaskState {
  return {
    version: 1,
    objective: '',
    criteria: [],
    checkpoint: '',
    nextAction: '',
    outcome: 'unknown',
    config: { enabled: false, maxContinuations: 3, maxRuntimeMs: 900000 },
    continuations: 0,
    phase: 'disabled',
    reason: 'disabled',
    handledEvidence: [],
    history: [],
  } satisfies SupervisionTaskState;
}
