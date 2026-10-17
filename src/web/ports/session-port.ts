/**
 * @fileoverview Session port — capabilities for session lifecycle management.
 * Route modules that manage sessions depend on this port.
 */

import type { Session } from '../../session.js';
import type { SessionState } from '../../types.js';

export interface SessionPort {
  readonly sessions: ReadonlyMap<string, Session>;
  /** Fence pre-reboot recovery evidence without resetting settings or retry budgets. */
  prepareRebootRestoreRecovery?(sessionId: string): Promise<void>;
  /** Tentative restores preserve the historical record through every state writer until committed. */
  addSession(session: Session, options?: { tentative?: boolean }): Promise<void>;
  commitSessionRegistration(session: Session): void;
  /** Strict main-state and mux-metadata acknowledgement before a reboot offer is consumed. */
  persistRebootRestoreDurably(session: Session, isCurrent: () => boolean): Promise<void>;
  cleanupSession(sessionId: string, killMux?: boolean, reason?: string): Promise<void>;
  /** Retire optional manager data only while final session retirement remains current. */
  dropSupervisorManagementState(sessionId: string, current: () => boolean): Promise<void>;
  setupSessionListeners(session: Session): Promise<void>;
  persistSessionState(session: Session): void;
  persistSessionStateNow(session: Session): void;
  /**
   * Re-apply the persisted state a freshly CONSTRUCTED session does not carry.
   *
   * A `Session` built from a record holds only what its constructor takes, so
   * persisting it would otherwise REPLACE the fuller record with the reduced one.
   * Two phases: `before-spawn` shapes the pane (the custom-model environment and
   * the nice priority) and must precede `startInteractive()`; `after-spawn` is
   * the session's own history (the pin, token and cost totals, auto-compact,
   * auto-clear, auto-resume, colour, image watcher, flicker filter) and must NOT
   * land on a session whose pane failed to start.
   */
  reapplyPersistedSessionState(
    session: Session,
    saved: SessionState,
    phase: 'before-spawn' | 'after-spawn',
    options?: {
      /** Reboot-only environment already rebuilt and bound to its final launch witness. */
      rebootCustomModelEnv?: Record<string, string>;
      /**
       * Re-arm a PENDING auto-resume schedule from the record's `autoResumeAt`.
       * Default true, which is what a Codeman restart wants: the limit footer
       * will not reprint on its own, so dropping the stamp there strands the
       * pause. A reboot restore passes false: the stamp predates the reboot,
       * the pane is new, and re-arming means every restored session types
       * `continue` into itself about a minute after one click. Auto-resume
       * stays ENABLED either way, so it re-arms on fresh evidence.
       */
      rearmAutoResumeSchedule?: boolean;
    }
  ): Promise<void>;
  /**
   * Undo a session that was registered but never got a working pane: the map
   * entry, its tab-layout slot, and any pane the launch created before throwing.
   * Unlike {@link cleanupSession} it leaves the persisted record, the lifetime
   * token totals, the Ralph state and the workspace's own files untouched.
   */
  discardPartiallyBuiltSession(
    sessionId: string,
    expectedSession?: Session,
    options?: { preserveCustomModelConfigDir?: boolean; preserveMuxPane?: boolean; retainForInspection?: boolean }
  ): Promise<void>;
  getSessionStateWithRespawn(session: Session): unknown;
}
