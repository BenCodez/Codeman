/** @fileoverview Bounded durable configuration for an opt-in Codex supervisor. */
import { z } from 'zod';
import { CriteriaSchema, PromptTextSchema } from '../supervision/schema.js';
import type {
  SupervisorConfig as PublicSupervisorConfig,
  SupervisorState as PublicSupervisorState,
} from '../types/supervisor.js';

const SessionId = z.string().regex(/^[\w-]{8,100}$/);
const RequestId = z.string().regex(/^[\w:.-]{8,120}$/);

export const SupervisorWorkerSchema = z
  .object({
    sessionId: SessionId,
    task: PromptTextSchema.min(1).max(4000),
    criteria: CriteriaSchema,
    maxAssignments: z.number().int().min(1).max(10),
    maxRuntimeMs: z.number().int().min(1000).max(86_400_000),
    assignments: z.number().int().min(0).max(10).default(0),
    startedAt: z.number().optional(),
    lastRequestId: RequestId.optional(),
  })
  .strict();

export const SupervisorConfigSchema = z
  .object({
    objective: PromptTextSchema.min(1).max(3000),
    enabled: z.boolean(),
    workers: z
      .array(SupervisorWorkerSchema.omit({ assignments: true, startedAt: true, lastRequestId: true }))
      .min(1)
      .max(12),
  })
  .strict()
  .refine((v) => new Set(v.workers.map((w) => w.sessionId)).size === v.workers.length, 'Duplicate worker');

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
        action: z.enum(['assign', 'retry']),
        reservedAt: z.number(),
      })
      .strict()
      .optional(),
    handledRequestIds: z.array(RequestId).max(128),
    handledRequestBindings: z
      .array(z.object({ requestId: RequestId, workerId: SessionId, action: z.enum(['assign', 'retry']) }).strict())
      .max(128),
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
