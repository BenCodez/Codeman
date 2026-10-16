/** @fileoverview Public HTTP contracts for the optional Codex supervisor role. */
import type { RecoveryState } from '../recovery/types.js';
import type { TaskState } from '../supervision/schema.js';
import type { TaskCriterionDefinition } from './task.js';

export type SupervisorCriterion = TaskCriterionDefinition;

export interface SupervisorWorkerPlan {
  sessionId: string;
  task: string;
  criteria: SupervisorCriterion[];
  maxAssignments: number;
  maxRuntimeMs: number;
}

export interface SupervisorWorkerState extends SupervisorWorkerPlan {
  assignments: number;
  startedAt?: number;
  lastRequestId?: string;
}

export interface SupervisorConfig {
  objective: string;
  enabled: boolean;
  workers: SupervisorWorkerPlan[];
}

export interface SupervisorState {
  version: 1;
  supervisorSessionId: string;
  objective: string;
  enabled: boolean;
  phase: 'disabled' | 'ready' | 'active' | 'paused' | 'blocked';
  reason: string;
  workers: SupervisorWorkerState[];
  startedAt?: number;
  inFlight?: {
    requestId: string;
    workerId: string;
    action: 'assign' | 'retry';
    reservedAt: number;
  };
  handledRequestIds: string[];
  handledRequestBindings: Array<{ requestId: string; workerId: string; action: 'assign' | 'retry' }>;
  history: Array<{ at: number; reason: string; workerId?: string }>;
}

export interface SupervisorOperationRequest {
  requestId: string;
}

export interface SupervisorWorkerInspection {
  sessionId: string;
  task?: TaskState;
  recovery?: RecoveryState;
  health: string;
  /** Time the recovery evidence was sampled, in Unix milliseconds; task snapshots may be older. */
  observedAt: number;
  /** True when any included evidence has not been revalidated in this inspection. */
  stale: boolean;
  /** Task checkpoints and criteria are durable controller snapshots, not a new worker observation. */
  taskStale: boolean;
  /** True when recovery inspection timed out or the worker was unavailable; health is then unknown. */
  recoveryStale: boolean;
}
