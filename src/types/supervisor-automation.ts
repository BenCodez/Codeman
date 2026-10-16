/** Owner-configured management instructions, never shell commands. */
export interface SupervisorAutomationConfig {
  checkIns: { enabled: boolean; intervalMinutes: number };
  tasks: Array<{
    id: string;
    name: string;
    instructions: string;
    enabled: boolean;
    kind: 'once' | 'recurring';
    intervalMinutes?: number;
    maxRuns: number;
  }>;
}

export interface SupervisorAutomationRun {
  requestId: string;
  taskId: string;
  payloadHash: string;
  startedAt: number;
  phase: 'reserved' | 'accepted' | 'refused' | 'unknown';
}

export interface SupervisorAutomationStatus extends SupervisorAutomationConfig {
  status: {
    phase: 'idle' | 'running' | 'blocked';
    reason: string;
    lastRun?: SupervisorAutomationRun;
    inFlight?: SupervisorAutomationRun;
    runs: Array<{ taskId: string; attempts: number; nextRunAt?: number }>;
  };
}

/** Private journal retains all admitted request bindings, including certified refusals. */
export interface SupervisorAutomationRecord extends SupervisorAutomationConfig {
  version: 1;
  supervisorSessionId: string;
  runs: SupervisorAutomationStatus['status']['runs'];
  handled: SupervisorAutomationRun[];
  inFlight?: SupervisorAutomationRun;
  reason: string;
}
