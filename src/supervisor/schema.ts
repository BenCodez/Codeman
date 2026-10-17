/** @fileoverview Bounded durable configuration for an opt-in Codex supervisor. */
import { z } from 'zod';
import { CriteriaSchema, PromptTextSchema } from '../supervision/schema.js';
import { taskPromptFits } from '../supervision/prompt.js';
import type {
  SupervisorConfig as PublicSupervisorConfig,
  SupervisorState as PublicSupervisorState,
} from '../types/supervisor.js';

const SessionId = z.string().regex(/^[\w-]{8,100}$/);
const RequestId = z.string().regex(/^[\w:.-]{8,120}$/);
export const MAX_SUPERVISOR_REQUEST_RECEIPTS = 128;
export const DEFAULT_SUPERVISOR_MESSAGES = 20;

/** Assignments and recovery retries share one grant; messages require separate owner delegation. */
export function remainingSupervisorRequests(
  workers: readonly PublicSupervisorConfig['workers'][number][],
  spent: readonly PublicSupervisorState['workers'][number][] = []
): number {
  return workers.reduce((total, worker) => {
    const prior = spent.find((entry) => entry.sessionId === worker.sessionId);
    return (
      total +
      Math.max(0, worker.maxAssignments - (prior?.assignments ?? 0)) +
      (worker.allowMessages === true
        ? Math.max(0, (worker.maxMessages ?? DEFAULT_SUPERVISOR_MESSAGES) - (prior?.messages ?? 0))
        : 0)
    );
  }, 0);
}

export const SupervisorWorkerSchema = z
  .object({
    sessionId: SessionId,
    task: PromptTextSchema.min(1)
      .max(4000)
      .refine((value) => value.trim().length > 0, 'Worker task must contain non-whitespace text'),
    criteria: CriteriaSchema,
    maxAssignments: z.number().int().min(1).max(10),
    maxRuntimeMs: z.number().int().min(1000).max(86_400_000),
    assignments: z.number().int().min(0).max(10).default(0),
    startedAt: z.number().optional(),
    lastRequestId: RequestId.optional(),
    allowMessages: z.boolean().optional(),
    maxMessages: z.number().int().min(1).max(100).optional(),
    messages: z.number().int().min(0).max(100).optional(),
  })
  .strict();

export const SupervisorConfigSchema = z
  .object({
    objective: PromptTextSchema.min(1)
      .max(3000)
      .refine((value) => value.trim().length > 0, 'Supervisor objective must contain non-whitespace text'),
    enabled: z.boolean(),
    workers: z
      .array(SupervisorWorkerSchema.omit({ assignments: true, startedAt: true, lastRequestId: true, messages: true }))
      .min(1)
      .max(12),
  })
  .strict()
  .refine((v) => new Set(v.workers.map((w) => w.sessionId)).size === v.workers.length, 'Duplicate worker')
  .refine(
    (config) => !config.enabled || remainingSupervisorRequests(config.workers) <= MAX_SUPERVISOR_REQUEST_RECEIPTS,
    'Assignments (including retries) and delegated message grants share 128 lifetime request receipts'
  )
  .refine(
    (config) =>
      config.workers.every((worker) =>
        taskPromptFits({
          objective: worker.task,
          criteria: worker.criteria.map((criterion) => ({ ...criterion, verified: false })),
          checkpoint: '',
          nextAction: '',
        })
      ),
    'Worker task prompt must fit 64KiB of valid UTF8'
  );

export const SupervisorRequestSchema = z.object({ requestId: RequestId }).strict();
export const SupervisorActionSchema = z.object({}).strict();

export const SupervisorStateSchema = z
  .object({
    version: z.literal(1),
    supervisorSessionId: SessionId,
    objective: PromptTextSchema.max(3000),
    enabled: z.boolean(),
    phase: z.enum(['disabled', 'ready', 'active', 'paused', 'blocked']),
    reason: z.string().regex(/^[\w-]{1,80}$/),
    workers: z.array(SupervisorWorkerSchema).max(12),
    startedAt: z.number().optional(),
    inFlight: z
      .object({
        requestId: RequestId,
        workerId: SessionId,
        action: z.enum(['assign', 'retry', 'message']),
        payloadHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        reservedAt: z.number(),
      })
      .strict()
      .optional(),
    handledRequestIds: z.array(RequestId).max(MAX_SUPERVISOR_REQUEST_RECEIPTS),
    handledRequestBindings: z
      .array(
        z
          .object({
            requestId: RequestId,
            workerId: SessionId,
            action: z.enum(['assign', 'retry', 'message']),
            payloadHash: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
          })
          .strict()
      )
      .max(MAX_SUPERVISOR_REQUEST_RECEIPTS),
    history: z
      .array(
        z.object({ at: z.number(), reason: z.string().regex(/^[\w-]{1,80}$/), workerId: SessionId.optional() }).strict()
      )
      .max(100),
  })
  .strict()
  .refine(
    (state) =>
      state.handledRequestIds.length === state.handledRequestBindings.length &&
      new Set(state.handledRequestIds).size === state.handledRequestIds.length &&
      new Set(state.handledRequestBindings.map((entry) => entry.requestId)).size ===
        state.handledRequestBindings.length &&
      state.handledRequestIds.every((id) => state.handledRequestBindings.some((entry) => entry.requestId === id)),
    'Handled supervisor requests require durable operation bindings'
  )
  .refine(
    (state) =>
      [...state.handledRequestBindings, ...(state.inFlight ? [state.inFlight] : [])].every((binding) =>
        binding.action === 'message' ? binding.payloadHash !== undefined : binding.payloadHash === undefined
      ),
    'Message operations require exact payload bindings'
  );

type ParsedSupervisorState = z.infer<typeof SupervisorStateSchema>;
type ParsedSupervisorConfig = z.infer<typeof SupervisorConfigSchema>;
const _stateContract: PublicSupervisorState extends ParsedSupervisorState
  ? ParsedSupervisorState extends PublicSupervisorState
    ? true
    : never
  : never = true;
const _configContract: PublicSupervisorConfig extends ParsedSupervisorConfig
  ? ParsedSupervisorConfig extends PublicSupervisorConfig
    ? true
    : never
  : never = true;
void _stateContract;
void _configContract;
export type SupervisorState = PublicSupervisorState;
export type SupervisorConfig = PublicSupervisorConfig;

export function initialSupervisorState(supervisorSessionId: string): SupervisorState {
  return {
    version: 1,
    supervisorSessionId,
    objective: '',
    enabled: false,
    phase: 'disabled',
    reason: 'disabled',
    workers: [],
    handledRequestIds: [],
    handledRequestBindings: [],
    history: [],
  };
}
