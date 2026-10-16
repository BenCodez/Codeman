/** @fileoverview Serialized, durable recovery controller; all action authority lives in the adapter. */
import { createHash } from 'node:crypto';
import { RecoveryConfigSchema } from './schema.js';
import { earliestActionDeadline } from './action-deadline.js';
import {
  CONTINUATION_PROMPT,
  hasFreshProcessReady,
  initialRecoveryState,
  type RecoveryConfig,
  type RecoveryEvent,
  type RecoveryObservation,
  type RecoveryReason,
  type RecoveryState,
  type RecoveryFlight,
  type RecoveryActionAuthority,
} from './types.js';

export interface RecoveryDependencies {
  acceptReservation?(key: string): Promise<boolean>;
  resetReservation?(): Promise<void>;
  /** Shared task ownership may revoke authority while a delivery reservation is saving. */
  hasActionAuthority?(): boolean;
  observe(): Promise<RecoveryObservation>;
  /** 'unknown' includes any possibly-partially-delivered operation; it must never be replayed. */
  act(flight: RecoveryFlight, isCurrent: RecoveryActionAuthority): Promise<'sent' | 'not-sent' | 'unknown'>;
  /** Explicit owner action for a verified missing owned remote worker. */
  restoreMissingRemote?(isCurrent: RecoveryActionAuthority): Promise<'sent' | 'not-sent' | 'unknown'>;
  persist(state: RecoveryState): Promise<void>;
  changed(state: RecoveryState): void;
  now?: () => number;
}

const POLL_MS = 5000;
const ACCEPTANCE_TIMEOUT_MS = 60_000;
const CONFIRM_MS = 2000;
const STALL_CONFIRM_MAX_MS = 15_000;
const promptHash = createHash('sha256').update(CONTINUATION_PROMPT).digest('hex');

/** An owner reset cannot certify that a possibly dispatched operation was never delivered. */
export class RecoveryResetBlockedError extends Error {
  constructor() {
    super('Recovery delivery is still unverified');
    this.name = 'RecoveryResetBlockedError';
  }
}

export class RecoveryController {
  private state: RecoveryState;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private revision = 0;
  private confirmation?: {
    key: string;
    kind: 'live-stall' | 'dead-stall' | 'failure';
    at: number;
    progressAt?: number;
    progressEvidenceKey?: string;
    processKey?: string;
    observedAt?: number;
  };
  // Pending intentions are discarded on reload. Keep their native proof private
  // as well: a stable turn key cannot lend an old delay to a replacement worker.
  private pendingStallProof?: {
    pending: NonNullable<RecoveryState['pending']>;
    processKey?: string;
    progressAt?: number;
    progressEvidenceKey?: string;
  };
  private legacyStallAlert?: { conversationId: string; at: number };
  private restoredFlight: boolean;
  private flightObservationComplete = false;

  constructor(
    private readonly deps: RecoveryDependencies,
    restored?: RecoveryState
  ) {
    this.state = structuredClone(restored ?? initialRecoveryState());
    // Existing journals opted into attention-only detection, never restart consent.
    this.state.config.restartStalls = this.state.config.restartStalls === true;
    if (!this.state.stallAlert && this.state.needsAttention) {
      let alertIndex = this.state.history.length - 1;
      while (alertIndex >= 0 && this.state.history[alertIndex].kind !== 'attention') alertIndex--;
      const alert = this.state.history[alertIndex];
      const released = this.state.history
        .slice(alertIndex + 1)
        .some(
          (event) =>
            event.kind === 'accepted' ||
            event.kind === 'reset' ||
            event.reason === 'user-input' ||
            event.reason === 'user-interrupted' ||
            event.reason === 'turn-completed' ||
            (event.kind === 'state' &&
              [
                'approval-required',
                'authentication-required',
                'usage-limit',
                'identity-unverified',
                'identity-changed',
                'managed-daemon',
                'unsupported-location',
                'transport-unreachable',
                'transport-unavailable',
                'remote-inspector-unavailable',
                'remote-session-missing',
                'unowned-session',
                'pane-unverified',
              ].includes(event.reason))
        );
      if (alert && ['stalled', 'stall-unverified'].includes(alert.reason) && !released && this.state.conversationId) {
        // Parent-version v1 journals called attention-only silence "stalled".
        // Settings and passive parent status reads can replace lastReason without
        // releasing the latest warning. Historical ownership is independent of that summary.
        // Bind its identity to the next unchanged turn, never action proof.
        this.legacyStallAlert = { conversationId: this.state.conversationId, at: alert.at };
      }
    }
    const restoredPending = !!this.state.pending || this.state.nextRetryAt !== undefined;
    if (restoredPending) {
      // A pending action is only an intention, not a delivery reservation. It may be
      // the stale snapshot from user input that canceled the action immediately
      // before a crash, so require fresh post-restart evidence before scheduling it.
      this.state.pending = undefined;
      this.state.nextRetryAt = undefined;
      this.state.armedAt = this.now();
      if (!this.state.inFlight && !this.state.circuitOpen) {
        this.state.phase = this.state.config.enabled ? 'watching' : 'idle';
        this.state.lastReason = this.state.config.enabled ? 'observing' : 'disabled';
      }
    }
    this.restoredFlight = !!this.state.inFlight;
    if (this.restoredFlight && !this.state.inFlight?.accepted) {
      // An unaccepted write may have landed before the server died. Observations
      // may confirm it, never replay it. Durable acceptance needs receipt cleanup
      // only; retain its phase and any newer owner/authority warning.
      this.state.phase = 'paused';
      this.state.needsAttention = true;
      this.state.lastReason = 'restart-in-flight';
    }
    if (restoredPending) {
      void this.enqueue(async () => {
        try {
          await this.save();
        } finally {
          this.arm();
        }
      }).catch(() => {});
    }
    this.arm();
  }

  getStatus(): RecoveryState {
    return structuredClone(this.state);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    this.queue = result.catch(() => {});
    return result;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const flight = this.state.inFlight;
    const observeFlight =
      !!flight &&
      (flight.accepted || !this.flightObservationComplete) &&
      this.state.lastReason !== 'persistence-failed';
    const automate = !flight && this.state.config.enabled && !this.state.circuitOpen;
    if (!this.stopped && (automate || observeFlight)) {
      const delay =
        flight && observeFlight && !flight.accepted
          ? Math.min(POLL_MS, Math.max(0, flight.startedAt + ACCEPTANCE_TIMEOUT_MS - this.now()))
          : POLL_MS;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.refresh()
          .catch(() => {})
          .finally(() => this.arm());
      }, delay);
      this.timer.unref?.();
    }
  }

  stop(): void {
    this.stopped = true;
    this.revision++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  async drain(): Promise<void> {
    await this.queue;
  }

  /** Cancel scheduled actions on ANY user input; an Escape is not an invitation to restart. */
  noteUserInput(): void {
    const canceledScheduledAction = !!this.state.pending || this.state.nextRetryAt !== undefined;
    const canceledStallAlert = !!this.state.stallAlert || !!this.legacyStallAlert;
    this.revision++;
    this.confirmation = undefined;
    this.state.stallAlert = undefined;
    this.legacyStallAlert = undefined;
    this.state.armedAt = this.now();
    this.state.pending = undefined;
    this.state.nextRetryAt = undefined;
    if ((canceledScheduledAction || canceledStallAlert) && !this.stopped) {
      if (!this.state.inFlight && !this.state.circuitOpen) {
        this.state.phase = this.state.config.enabled ? 'watching' : 'idle';
        if (canceledStallAlert) this.state.needsAttention = false;
        this.event('state', 'user-input');
      }
      // Keep the input callback synchronous while serializing its cancellation
      // after any already-running observation/reservation save.
      void this.enqueue(async () => {
        try {
          await this.save();
        } finally {
          this.arm();
        }
      }).catch(() => {});
    }
  }

  private event(kind: RecoveryEvent['kind'], reason: RecoveryReason): void {
    if (kind === 'attention' && reason !== 'stall-unverified') {
      // A newer attention event owns the warning; the old stall marker must not clear it.
      this.state.stallAlert = undefined;
      this.legacyStallAlert = undefined;
    }
    this.state.lastReason = reason;
    this.state.history.push({ at: this.now(), kind, reason, attempt: this.state.attempts });
    this.state.history = this.state.history.slice(-100);
  }

  private async save(retainedStateOnFailure?: { state: RecoveryState; revision: number }): Promise<boolean> {
    try {
      await this.deps.persist(this.getStatus());
    } catch {
      if (retainedStateOnFailure) {
        const newerOwnerIntent = this.revision !== retainedStateOnFailure.revision;
        const armedAt = this.state.armedAt;
        this.state = retainedStateOnFailure.state;
        if (newerOwnerIntent) {
          // Input/cancellation can arrive while the failed write is awaited.
          // Restore uncertain delivery evidence without resurrecting unsent intentions.
          this.state.armedAt = armedAt;
          this.state.pending = undefined;
          this.state.nextRetryAt = undefined;
        }
      }
      this.state.phase = 'blocked';
      this.state.needsAttention = true;
      this.state.circuitOpen = true;
      this.event('attention', 'persistence-failed');
      this.deps.changed(this.getStatus());
      if (retainedStateOnFailure) return false;
      throw new Error('Recovery state could not be saved');
    }
    this.deps.changed(this.getStatus());
    return true;
  }

  async updateConfig(patch: Partial<RecoveryConfig>): Promise<RecoveryState> {
    RecoveryConfigSchema.parse(patch);
    this.revision++;
    return this.enqueue(async () => {
      const config = RecoveryConfigSchema.parse({ ...this.state.config, ...patch }) as RecoveryConfig;
      const enabledNow = config.enabled && !this.state.config.enabled;
      const stallEnabledNow = config.detectStalls && !this.state.config.detectStalls;
      const stallRestartEnabledNow = config.restartStalls && !this.state.config.restartStalls;
      const stallThresholdChanged = config.stalledAfterMs !== this.state.config.stalledAfterMs;
      const confirmationPolicyChanged = (
        ['enabled', 'recoverCrashes', 'recoverInterrupted', 'detectStalls', 'restartStalls', 'stalledAfterMs'] as const
      ).some((key) => config[key] !== this.state.config[key]);
      const pending = this.state.pending;
      const canceledOwnedStall =
        !(config.enabled && config.detectStalls && config.restartStalls) &&
        pending?.action === 'restart' &&
        pending.reason === 'stalled' &&
        this.state.stallAlert?.key === pending.key &&
        this.state.stallAlert.conversationId === pending.conversationId &&
        !this.state.needsAttention &&
        ['scheduled', 'stalled', 'stall-unverified', 'observing', 'disabled'].includes(this.state.lastReason);
      // A newly consented policy needs its own fresh observations, even when
      // the old confirmation had not yet scheduled an action.
      if (confirmationPolicyChanged) this.confirmation = undefined;
      this.state.config = config;
      if (enabledNow || stallEnabledNow || stallRestartEnabledNow) this.state.armedAt = this.now();
      if (!(config.detectStalls && config.restartStalls) && this.state.pending?.reason === 'stalled') {
        this.state.pending = undefined;
        this.pendingStallProof = undefined;
        this.state.nextRetryAt = undefined;
        this.confirmation = undefined;
        this.state.phase = config.enabled ? 'watching' : 'idle';
      }
      if (stallThresholdChanged && this.state.pending?.reason === 'stalled') {
        // The old intention's delay belongs to the prior quiet-period policy.
        // Fresh confirmations must schedule their own full retry delay.
        this.state.pending = undefined;
        this.pendingStallProof = undefined;
        this.state.nextRetryAt = undefined;
      }
      if (!config.enabled) {
        this.state.pending = undefined;
        this.state.nextRetryAt = undefined;
        if (!this.state.inFlight) this.state.phase = 'idle';
      }
      if (canceledOwnedStall && !this.state.inFlight && !this.state.circuitOpen) {
        // Scheduling hid this exact warning while recovery was pending. Canceling
        // the restart does not acknowledge the unresolved stall or a newer veto.
        this.state.needsAttention = true;
        this.state.lastReason = 'stall-unverified';
        this.state.phase = 'paused';
      }
      if (
        !config.restartStalls &&
        this.state.needsAttention &&
        (this.state.lastReason === 'stalled' || this.state.lastReason === 'stall-unverified') &&
        (this.state.stallAlert || this.legacyStallAlert) &&
        !this.state.inFlight &&
        !this.state.circuitOpen
      ) {
        // Withdrawing restart consent must not dismiss unresolved attention-only silence.
        this.state.needsAttention = true;
        this.state.phase = 'paused';
      }
      // Settings neither observe new evidence nor acknowledge an existing warning.
      // Keep its exact owner/reason, including a newer veto beside a retained stall marker.
      if (!this.state.needsAttention) this.event('state', config.enabled ? 'observing' : 'disabled');
      await this.save();
      this.arm();
      return this.getStatus();
    });
  }

  async reset(): Promise<RecoveryState> {
    this.revision++;
    return this.enqueue(async () => {
      // A reset changes retry limits, not delivery evidence. Keep the exact
      // durable reservation until acceptance (or certified no-send cleanup)
      // resolves it; otherwise a subsequent Retry could replay its effects.
      if (this.state.inFlight) throw new RecoveryResetBlockedError();
      this.state.circuitOpen = false;
      this.state.attempts = 0;
      this.state.failedAttempts = 0;
      this.state.windowStartedAt = undefined;
      this.state.nextRetryAt = undefined;
      this.state.pending = undefined;
      this.state.inFlight = undefined;
      this.state.needsAttention = false;
      this.state.phase = 'idle';
      this.restoredFlight = false;
      this.confirmation = undefined;
      this.state.stallAlert = undefined;
      this.legacyStallAlert = undefined;
      this.state.armedAt = this.now();
      this.event('reset', 'manual-reset');
      await this.save();
      // Clear the shared reservation only after this controller's uncertainty is durably gone.
      await this.deps.resetReservation?.();
      this.arm();
      return this.getStatus();
    });
  }

  async retry(externallyCurrent: RecoveryActionAuthority = () => true): Promise<RecoveryState> {
    return this.enqueue(async () => {
      try {
        await this.evaluate(true, externallyCurrent);
        return this.getStatus();
      } finally {
        this.arm();
      }
    });
  }

  async restoreMissingRemote(): Promise<RecoveryState> {
    const revision = ++this.revision;
    return this.enqueue(async () => {
      const isCurrent = () =>
        !this.stopped &&
        revision === this.revision &&
        (this.deps.hasActionAuthority ? this.deps.hasActionAuthority() === true : true);
      if (!isCurrent() || !this.deps.restoreMissingRemote || this.state.inFlight) return this.getStatus();
      const observation = await this.deps.observe();
      if (!isCurrent() || observation.reason !== 'remote-session-missing' || !observation.conversationId) {
        return this.getStatus();
      }
      const key = `${observation.conversationId}:remote-restore:${observation.at}`;
      this.flightObservationComplete = false;
      this.state.inFlight = {
        key,
        action: 'restart',
        conversationId: observation.conversationId,
        startedAt: this.now(),
      };
      this.state.phase = 'recovering';
      this.state.needsAttention = false;
      this.event('scheduled', 'scheduled');
      // Durable before the first SSH mutation. The shared arbiter adds its own
      // cross-controller reservation before dispatch as well.
      await this.save();
      let outcome: 'sent' | 'not-sent' | 'unknown';
      try {
        outcome = isCurrent() ? await this.deps.restoreMissingRemote(isCurrent) : 'not-sent';
      } catch {
        outcome = 'unknown';
      }
      if (outcome === 'sent') {
        this.event('restart', 'process-resumed');
      } else if (outcome === 'not-sent') {
        this.state.inFlight = undefined;
        this.block('delivery-failed');
      } else {
        this.block('acceptance-unverified');
      }
      await this.save();
      // Explicit restore is allowed while automation is disabled. Its durable
      // restart flight still needs the bounded acceptance observer.
      this.arm();
      return this.getStatus();
    });
  }

  async refresh(): Promise<RecoveryState> {
    return this.enqueue(async () => {
      try {
        await this.evaluate(false);
        return this.getStatus();
      } finally {
        this.arm();
      }
    });
  }

  /** A status read refreshes evidence without scheduling or dispatching recovery, even when automation is off. */
  inspect(): Promise<RecoveryState> {
    return this.inspectEvidence().then((inspection) => inspection.state);
  }

  /** An inspection receipt proves a completed read and stays bound to current owner intent. */
  async inspectEvidence(): Promise<{
    state: RecoveryState;
    observedAt: number;
    stale: boolean;
    isCurrent(): boolean;
  }> {
    return this.enqueue(async () => {
      const revision = this.revision;
      const receipt = (stale: boolean) => {
        const state = this.getStatus();
        const snapshot = JSON.stringify(state);
        return {
          state,
          observedAt: this.now(),
          stale,
          isCurrent: () =>
            !stale &&
            !this.stopped &&
            revision === this.revision &&
            snapshot === JSON.stringify(state) &&
            snapshot === JSON.stringify(this.state),
        };
      };
      try {
        if (this.stopped) return receipt(true);
        const observation = this.applyStallPolicy(await this.deps.observe());
        if (this.stopped || revision !== this.revision) return receipt(true);
        const retained = this.getStatus();
        const restoredFlight = this.restoredFlight;
        const flightObservationComplete = this.flightObservationComplete;
        const before = JSON.stringify(retained);
        this.invalidateConfirmation(observation);
        this.invalidatePendingStall(observation);
        const unchangedStall = this.retainStallAlert(observation);
        this.state.activity = observation.activity;
        if (!this.state.inFlight?.accepted) this.state.conversationId = observation.conversationId;
        const hadFlight = !!this.state.inFlight;
        if (hadFlight) this.reconcileFlight(observation);
        else if (!this.state.pending && !this.state.circuitOpen) {
          if (unchangedStall) {
            this.state.lastReason = 'stall-unverified';
            this.state.needsAttention = true;
            this.state.phase = 'paused';
          } else this.state.lastReason = observation.reason;
        }
        if (this.state.inFlight?.accepted || JSON.stringify(this.state) !== before) {
          if (!(await this.save({ state: retained, revision }))) {
            // A read still reports the durable uncertainty and persistence veto.
            // Mutation/action callers keep the throwing save contract.
            this.restoredFlight = restoredFlight;
            this.flightObservationComplete = flightObservationComplete;
            return receipt(true);
          } else if (!this.stopped && revision === this.revision && this.state.inFlight?.accepted) {
            if (!(await this.settleAcceptedFlight(revision, true))) return receipt(true);
          }
        }
        return receipt(this.stopped || revision !== this.revision);
      } finally {
        this.arm();
      }
    });
  }

  private handled(key: string): void {
    this.state.handledEvidence = [...this.state.handledEvidence.filter((x) => x !== key), key].slice(-32);
  }

  private block(reason: RecoveryReason, circuit = false): void {
    this.state.phase = circuit ? 'failed' : 'paused';
    this.state.needsAttention = true;
    this.state.pending = undefined;
    this.state.nextRetryAt = undefined;
    this.state.circuitOpen ||= circuit;
    this.event('attention', reason);
  }

  private applyStallPolicy(observation: RecoveryObservation): RecoveryObservation {
    if (
      this.state.config.detectStalls &&
      (this.state.config.restartStalls || !this.state.config.recoverCrashes) &&
      observation.activity === 'crashed' &&
      observation.reason === 'process-crashed' &&
      observation.stallEvidenceKey
    ) {
      // An owner stop or incomplete stall proof must not become live silence,
      // nor fall back to ordinary crash recovery under the selected stall policy.
      if (observation.stallRestartable !== true) return { ...observation, safeToAct: false };
      // A watcher timestamp must not bypass quiet-time confirmation. Detection
      // without either restart policy still owns the attention-only path.
      return { ...observation, activity: 'working', reason: 'turn-running', safeToAct: false };
    }
    return observation;
  }

  private stallHandledKey(key: string, progressAt: number, progressEvidenceKey?: string): string {
    return `stall:${createHash('sha256').update(key).digest('hex')}:${progressEvidenceKey ? `${progressEvidenceKey}:${progressAt}` : progressAt}`;
  }

  private sameStallProgress(
    previous: { progressAt?: number; progressEvidenceKey?: string },
    observation: RecoveryObservation
  ): boolean {
    return previous.progressEvidenceKey !== undefined || observation.progressEvidenceKey !== undefined
      ? previous.progressEvidenceKey !== undefined && previous.progressEvidenceKey === observation.progressEvidenceKey
      : previous.progressAt === (observation.progressAt ?? observation.at);
  }

  private validStallProgress(observation: RecoveryObservation): boolean {
    const progress = observation.progressAt;
    return (
      typeof progress === 'number' &&
      Number.isFinite(progress) &&
      progress > 0 &&
      progress <= Number.MAX_SAFE_INTEGER &&
      progress <= this.now() &&
      ((observation.progressEvidenceKey === undefined && observation.progressLowerBound === undefined) ||
        (typeof observation.progressEvidenceKey === 'string' &&
          /^remote:[a-f0-9]{64}$/.test(observation.progressEvidenceKey) &&
          typeof observation.progressLowerBound === 'number' &&
          Number.isSafeInteger(observation.progressLowerBound) &&
          observation.progressLowerBound > 0 &&
          observation.progressLowerBound <= progress)) &&
      Number.isFinite(observation.at) &&
      observation.at > 0 &&
      observation.at <= Number.MAX_SAFE_INTEGER &&
      observation.at <= this.now() &&
      (observation.stallObservedAt === undefined ||
        (Number.isSafeInteger(observation.stallObservedAt) &&
          observation.stallObservedAt > 0 &&
          observation.stallObservedAt <= this.now() &&
          this.now() - observation.stallObservedAt <= STALL_CONFIRM_MAX_MS))
    );
  }

  private detectsStall(observation: RecoveryObservation): boolean {
    return (
      this.state.config.detectStalls &&
      observation.activity === 'working' &&
      observation.reason === 'turn-running' &&
      !!observation.conversationId &&
      !!observation.stallEvidenceKey &&
      this.validStallProgress(observation) &&
      this.now() - this.stallQuietSince(observation) >= this.state.config.stalledAfterMs
    );
  }

  private stallQuietSince(observation: RecoveryObservation): number {
    // Historical silence cannot satisfy a newly armed policy or an accepted
    // recovery. Both durable baselines survive a journal reload.
    return Math.max(
      observation.progressAt ?? observation.at,
      this.state.armedAt ?? 0,
      this.state.lastSuccessfulRecovery ?? 0
    );
  }

  /** Status reads may invalidate proof but never count as an action confirmation. */
  private invalidateConfirmation(observation: RecoveryObservation): void {
    const confirmation = this.confirmation;
    if (!confirmation) return;
    const stall = this.detectsStall(observation);
    const kind = stall ? (observation.stallRestartable === true ? 'dead-stall' : 'live-stall') : 'failure';
    const failure = observation.activity === 'interrupted' || observation.activity === 'crashed';
    if (
      (!stall && (!failure || !observation.safeToAct)) ||
      confirmation.kind !== kind ||
      confirmation.key !== (stall ? observation.stallEvidenceKey : observation.evidenceKey) ||
      (confirmation.kind !== 'live-stall' &&
        confirmation.processKey !== (observation.processProofKey ?? observation.evidenceKey)) ||
      (stall && !this.sameStallProgress(confirmation, observation))
    ) {
      this.confirmation = undefined;
    }
  }

  private invalidatePendingStall(observation: RecoveryObservation): boolean {
    const pending = this.state.pending;
    if (!pending || pending.reason !== 'stalled') {
      this.pendingStallProof = undefined;
      return false;
    }
    const proof = this.pendingStallProof;
    if (
      proof?.pending === pending &&
      this.detectsStall(observation) &&
      observation.stallRestartable === true &&
      pending.key === observation.stallEvidenceKey &&
      pending.conversationId === observation.conversationId &&
      proof.processKey === (observation.processProofKey ?? observation.evidenceKey) &&
      this.sameStallProgress(proof, observation)
    )
      return false;
    this.pendingStallProof = undefined;
    this.state.pending = undefined;
    this.state.nextRetryAt = undefined;
    return true;
  }

  private stallObservationCanOwnAttention(observation: RecoveryObservation): boolean {
    return observation.activity === 'working' && observation.reason === 'turn-running';
  }

  /** Durable alerts carry warning identity, never the fresh pane proof required for an action. */
  private retainStallAlert(observation: RecoveryObservation): boolean {
    const progressAt = observation.progressAt ?? observation.at;
    const alert = this.state.stallAlert ?? this.legacyStallAlert;
    if (!alert) return false;
    const sameThread = observation.conversationId === alert.conversationId;
    const baseline = 'progressAt' in alert ? alert.progressAt : alert.at;
    const resolved =
      (observation.conversationId !== undefined && !sameThread) ||
      (sameThread &&
        (observation.activity === 'completed' ||
          (observation.progressEvidenceKey !== undefined &&
          'progressEvidenceKey' in alert &&
          alert.progressEvidenceKey !== undefined
            ? observation.progressEvidenceKey !== alert.progressEvidenceKey
            : observation.progressAt !== undefined &&
              (observation.progressLowerBound ?? observation.progressAt) > baseline))) ||
      ('key' in alert && !!observation.stallEvidenceKey && observation.stallEvidenceKey !== alert.key) ||
      observation.reason === 'user-input' ||
      observation.reason === 'user-interrupted';
    if (resolved) {
      this.state.stallAlert = undefined;
      this.legacyStallAlert = undefined;
      if (
        !this.state.inFlight &&
        !this.state.circuitOpen &&
        (this.stallObservationCanOwnAttention(observation) || observation.activity === 'completed')
      ) {
        // Settings may replace lastReason while this marker still owns attention.
        this.state.needsAttention = false;
        this.state.phase = observation.activity === 'completed' ? 'completed' : 'watching';
      }
      return false;
    }
    if (
      !this.state.stallAlert &&
      sameThread &&
      observation.stallEvidenceKey &&
      this.stallObservationCanOwnAttention(observation)
    ) {
      this.state.stallAlert = {
        key: observation.stallEvidenceKey,
        conversationId: alert.conversationId,
        progressAt,
        ...(observation.progressEvidenceKey !== undefined
          ? { progressEvidenceKey: observation.progressEvidenceKey }
          : {}),
      };
      this.legacyStallAlert = undefined;
    }
    // Inconclusive, child-work and blocked observations keep their current veto
    // reason. Retaining a historical warning is never evidence of a dead pane.
    return this.stallObservationCanOwnAttention(observation);
  }

  /** Reconcile only a known durable delivery reservation; this never authorizes an action. */
  private reconcileFlight(observation: RecoveryObservation): void {
    const flight = this.state.inFlight;
    if (!flight || flight.accepted) return;
    const sameThread = observation.conversationId === flight.conversationId;
    const accepted =
      sameThread &&
      (flight.action === 'restart'
        ? hasFreshProcessReady(observation, flight.startedAt, this.now())
        : observation.submissionHash === promptHash &&
          !!observation.submissionKey &&
          observation.submissionKey !== flight.previousSubmissionKey);
    if (accepted) {
      this.handled(
        flight.reason === 'stalled' && flight.stallProgressAt !== undefined
          ? this.stallHandledKey(flight.key, flight.stallProgressAt, flight.stallProgressEvidenceKey)
          : flight.key
      );
      flight.accepted = true;
      flight.acceptedAt = this.now();
      this.restoredFlight = false;
      this.flightObservationComplete = true;
      this.state.lastSuccessfulRecovery = flight.acceptedAt;
      this.confirmation = undefined;
      this.state.stallAlert = undefined;
      this.legacyStallAlert = undefined;
      this.state.needsAttention = false;
      this.state.phase = 'watching';
      this.event('accepted', 'recovery-accepted');
      return;
    }
    const timedOut = this.now() - flight.startedAt >= ACCEPTANCE_TIMEOUT_MS;
    if (this.restoredFlight || timedOut) {
      if (this.state.lastReason !== 'acceptance-unverified') this.block('acceptance-unverified');
      if (timedOut) this.flightObservationComplete = true;
    }
  }

  private async settleAcceptedFlight(revision: number, readOnly = false): Promise<boolean> {
    const flight = this.state.inFlight;
    if (!flight?.accepted) return false;
    const accepted = this.getStatus();
    try {
      if (this.deps.acceptReservation && !(await this.deps.acceptReservation(flight.key))) return false;
    } catch {
      this.block('persistence-failed', true);
      this.deps.changed(this.getStatus());
      if (!readOnly) throw new Error('Recovery reservation could not be released');
      return false;
    }
    this.state.inFlight = undefined;
    // Preserve the durable acceptance proof if the domain deletion write fails.
    return this.save({ state: accepted, revision });
  }

  private recoveryWindowExpired(): boolean {
    const origin = this.state.windowStartedAt;
    if (origin === undefined) return false;
    const elapsed = this.now() - origin;
    return !Number.isFinite(origin) || origin < 0 || elapsed < 0 || elapsed >= this.state.config.maxRecoveryDurationMs;
  }

  private async evaluate(manual: boolean, externallyCurrent: RecoveryActionAuthority = () => true): Promise<void> {
    if (this.stopped || !externallyCurrent()) return;
    const revision = this.revision;
    const isCurrent = () => !this.stopped && revision === this.revision && externallyCurrent();
    const before = JSON.stringify(this.state);
    let observation: RecoveryObservation;
    try {
      observation = this.applyStallPolicy(await this.deps.observe());
    } catch {
      observation = { activity: 'unknown', reason: 'identity-unverified', at: this.now(), safeToAct: false };
    }
    if (!isCurrent()) return;
    this.invalidateConfirmation(observation);
    if (this.invalidatePendingStall(observation)) {
      await this.save();
      if (this.stopped || revision !== this.revision) return;
    }
    const unchangedStallAlert = this.retainStallAlert(observation);
    this.state.activity = observation.activity;
    if (!this.state.inFlight?.accepted) this.state.conversationId = observation.conversationId;

    if (this.state.inFlight) {
      const retained = this.getStatus();
      this.reconcileFlight(observation);
      if (this.state.inFlight?.accepted) {
        if (!(await this.save({ state: retained, revision }))) return;
        if (!this.stopped && revision === this.revision) await this.settleAcceptedFlight(revision);
      } else if (JSON.stringify(this.state) !== before) await this.save();
      return;
    }

    if (!manual && !this.state.config.enabled) {
      if (JSON.stringify(this.state) !== before) await this.save();
      return;
    }
    if (this.state.circuitOpen) return;
    const failure = observation.activity === 'interrupted' || observation.activity === 'crashed';
    const stallDetected = this.detectsStall(observation);
    const restartableStall =
      stallDetected && this.state.config.restartStalls === true && observation.stallRestartable === true;
    const permitted =
      observation.activity === 'crashed' ? this.state.config.recoverCrashes : this.state.config.recoverInterrupted;
    const actionableFailure =
      failure && permitted && observation.safeToAct && !!observation.conversationId && !!observation.evidenceKey;
    if (!actionableFailure && !restartableStall) {
      this.state.pending = undefined;
      this.state.nextRetryAt = undefined;
      if (unchangedStallAlert) {
        this.state.phase = 'paused';
        this.state.needsAttention = true;
        this.state.lastReason = 'stall-unverified';
        if (JSON.stringify(this.state) !== before) await this.save();
        return;
      }
      if (stallDetected) {
        const key = observation.stallEvidenceKey!;
        const age = this.confirmation?.key === key ? this.now() - this.confirmation.at : Infinity;
        if (this.confirmation?.key !== key || age > STALL_CONFIRM_MAX_MS)
          this.confirmation = {
            key,
            kind: observation.stallRestartable === true ? 'dead-stall' : 'live-stall',
            at: this.now(),
            progressAt: observation.progressAt ?? observation.at,
            progressEvidenceKey: observation.progressEvidenceKey,
            ...(observation.stallRestartable === true
              ? {
                  processKey: observation.processProofKey ?? observation.evidenceKey,
                  observedAt: observation.stallObservedAt,
                }
              : {}),
          };
        else if (
          age >= CONFIRM_MS &&
          (observation.stallRestartable !== true ||
            observation.stallObservedAt === undefined ||
            observation.stallObservedAt > (this.confirmation.observedAt ?? Infinity))
        ) {
          // A live quiet turn, or a dead worker without restart consent, only
          // asks for owner attention. Neither path dispatches worker input.
          this.state.stallAlert = {
            key,
            conversationId: observation.conversationId!,
            progressAt: this.stallQuietSince(observation),
            ...(observation.progressEvidenceKey !== undefined
              ? { progressEvidenceKey: observation.progressEvidenceKey }
              : {}),
          };
          this.block('stall-unverified');
          if (JSON.stringify(this.state) !== before) await this.save();
          return;
        }
      } else this.confirmation = undefined;
      if (observation.activity === 'completed') {
        this.state.phase = 'completed';
        this.state.needsAttention = false;
        // A resume displays the old successful turn. Only a NEW successful turn ends a crash window.
        if (observation.at > (this.state.windowStartedAt ?? 0)) {
          this.state.attempts = 0;
          this.state.failedAttempts = 0;
          this.state.windowStartedAt = undefined;
        }
      } else if (
        observation.activity === 'blocked' ||
        observation.activity === 'paused' ||
        observation.activity === 'unknown'
      ) {
        this.state.phase = 'paused';
        this.state.needsAttention = this.state.config.enabled || !!this.state.stallAlert || !!this.legacyStallAlert;
      } else {
        this.state.phase = 'watching';
        if (
          observation.activity === 'working' ||
          observation.activity === 'watching' ||
          observation.activity === 'idle'
        ) {
          this.state.needsAttention = !!this.state.stallAlert || !!this.legacyStallAlert;
        }
      }
      if (!stallDetected && this.state.lastReason !== observation.reason) this.event('state', observation.reason);
      if (JSON.stringify(this.state) !== before) await this.save();
      return;
    }

    const key = restartableStall ? observation.stallEvidenceKey! : observation.evidenceKey!;
    const action = restartableStall
      ? ('restart' as const)
      : observation.activity === 'crashed'
        ? ('restart' as const)
        : ('continue' as const);
    const actionReason: RecoveryReason = restartableStall ? 'stalled' : observation.reason;
    // Preserve the adapter's exact turn key in the flight. Durable deduplication
    // distinguishes a genuinely new structured progress cycle of that same turn.
    // Old journals with a bare handled key retain their conservative veto.
    if (this.state.handledEvidence.includes(key)) return;
    if (restartableStall) {
      const progress = observation.progressAt!;
      const handledKey = this.stallHandledKey(key, progress, observation.progressEvidenceKey);
      const prefix = `stall:${createHash('sha256').update(key).digest('hex')}:`;
      const previousCycles = this.state.handledEvidence.filter((entry) => entry.startsWith(prefix));
      if (
        previousCycles.includes(handledKey) ||
        (previousCycles.length > 0 &&
          previousCycles.some((entry) => {
            const suffix = entry.slice(prefix.length);
            const remote = /^(remote:[a-f0-9]{64})(?::([0-9]+))?$/.exec(suffix);
            if (remote) {
              // Old native-only records have no reserved clock baseline. Retain
              // their veto; a probe's later acceptance time is never progress.
              if (!remote[2] || !observation.progressEvidenceKey || observation.progressEvidenceKey === remote[1])
                return true;
              const baseline = Number(remote[2]);
              return !Number.isSafeInteger(baseline) || baseline <= 0 || observation.progressLowerBound! <= baseline;
            }
            const previousProgress = Number(suffix);
            return (
              !Number.isFinite(previousProgress) ||
              previousProgress <= 0 ||
              previousProgress > Number.MAX_SAFE_INTEGER ||
              (observation.progressLowerBound ?? progress) <= previousProgress
            );
          }))
      )
        return;
    }
    // Enabling recovery never replays old failures from a historical rollout. Manual Retry is explicit.
    const armedAt = this.state.armedAt ?? this.now();
    const invalidLiveProof =
      observation.activity === 'crashed' &&
      observation.liveProofAt !== undefined &&
      (!Number.isFinite(observation.liveProofAt) ||
        observation.liveProofAt > observation.at ||
        observation.liveProofAt < armedAt);
    if (!restartableStall && !manual && (observation.at < armedAt || invalidLiveProof)) return;
    const processKey = observation.processProofKey ?? observation.evidenceKey;
    // A stall always needs repeated fresh probes. A manual click may waive delay for
    // an explicit terminal failure, but it cannot turn one dead-pane read into proof.
    if (
      (restartableStall || !manual) &&
      (this.confirmation?.key !== key ||
        this.confirmation.processKey !== processKey ||
        this.now() - this.confirmation.at < CONFIRM_MS ||
        (restartableStall &&
          observation.stallObservedAt !== undefined &&
          observation.stallObservedAt <= (this.confirmation.observedAt ?? Infinity)) ||
        (restartableStall && this.now() - this.confirmation.at > STALL_CONFIRM_MAX_MS))
    ) {
      if (
        !this.confirmation ||
        this.confirmation.key !== key ||
        this.confirmation.processKey !== processKey ||
        (restartableStall && this.now() - this.confirmation.at > STALL_CONFIRM_MAX_MS)
      )
        this.confirmation = {
          key,
          kind: restartableStall ? 'dead-stall' : 'failure',
          at: this.now(),
          processKey,
          ...(restartableStall
            ? {
                progressAt: observation.progressAt ?? observation.at,
                progressEvidenceKey: observation.progressEvidenceKey,
                observedAt: observation.stallObservedAt,
              }
            : {}),
        };
      return;
    }
    this.state.windowStartedAt ??= this.now();
    if (this.state.attempts >= this.state.config.maxRetries) {
      this.block('retries-exhausted', true);
      await this.save();
      return;
    }
    if (this.recoveryWindowExpired()) {
      this.block('recovery-window-exhausted', true);
      await this.save();
      return;
    }
    if (!this.state.pending || this.state.pending.key !== key) {
      this.state.pending = {
        key,
        action,
        conversationId: observation.conversationId!,
        reason: actionReason,
      };
      this.pendingStallProof = restartableStall
        ? {
            pending: this.state.pending,
            processKey,
            progressAt: observation.progressAt,
            progressEvidenceKey: observation.progressEvidenceKey,
          }
        : undefined;
      const delay = Math.min(
        this.state.config.maxRetryDelayMs,
        this.state.config.retryDelayMs * 2 ** this.state.attempts
      );
      this.state.nextRetryAt = manual ? this.now() : this.now() + delay;
      this.state.phase = 'watching';
      this.state.needsAttention = false;
      if (restartableStall && this.state.lastReason !== 'stalled') this.event('state', 'stalled');
      this.event('scheduled', 'scheduled');
      await this.save();
    }
    if (!manual && this.now() < (this.state.nextRetryAt ?? Infinity)) return;
    if (!isCurrent()) {
      // An external supervisor pause can race the durable scheduling write without
      // changing this controller's own revision. Remove that manual intention so a
      // later timer cannot dispatch it after the supervisor has lost authority.
      this.state.pending = undefined;
      this.state.nextRetryAt = undefined;
      this.state.phase = this.state.config.enabled ? 'watching' : 'idle';
      this.state.needsAttention = false;
      await this.save();
      return;
    }
    const pending = this.state.pending;
    if (!pending) return;
    this.state.inFlight = {
      ...pending,
      startedAt: this.now(),
      previousSubmissionKey: observation.submissionKey,
      ...(restartableStall
        ? {
            stallProgressAt: observation.progressAt!,
            ...(observation.progressEvidenceKey !== undefined
              ? {
                  stallProgressEvidenceKey: observation.progressEvidenceKey,
                  stallQuietPeriodMs: this.state.config.stalledAfterMs,
                }
              : {}),
          }
        : {}),
    };
    this.flightObservationComplete = false;
    this.state.pending = undefined;
    this.state.nextRetryAt = undefined;
    this.state.attempts++;
    this.state.phase = 'recovering';
    this.event('state', 'scheduled');
    // This reservation MUST be durable before any bytes or restart reach the pane.
    await this.save();
    // Once sampled, a withdrawn task or supervisor authority cannot revive this attempt.
    const retainedStallAlert = restartableStall ? (this.state.stallAlert ?? this.legacyStallAlert) : undefined;
    let authorityWithdrawn = false;
    const canDispatch: RecoveryActionAuthority = () => {
      if (
        !isCurrent() ||
        (restartableStall && (this.state.config.detectStalls !== true || this.state.config.restartStalls !== true)) ||
        this.recoveryWindowExpired() ||
        (this.deps.hasActionAuthority && this.deps.hasActionAuthority() !== true)
      )
        authorityWithdrawn = true;
      return !authorityWithdrawn;
    };
    if (externallyCurrent.prepareEvidence) {
      canDispatch.prepareEvidence = async (source) => {
        if (!canDispatch()) return false;
        const prepared = (await externallyCurrent.prepareEvidence!(source)) === true;
        // Sample while the admitted preparation callback is active, including
        // a false result caused by owner withdrawal before any worker effect.
        const current = canDispatch();
        return prepared && current;
      };
    }
    if (externallyCurrent.getInputIssuer)
      canDispatch.getInputIssuer = () => (canDispatch() ? externallyCurrent.getInputIssuer!() : undefined);
    canDispatch.getActionDeadline = () =>
      earliestActionDeadline(
        (this.state.windowStartedAt ?? NaN) + this.state.config.maxRecoveryDurationMs,
        externallyCurrent
      );
    let outcome: 'sent' | 'not-sent' | 'unknown';
    try {
      outcome = canDispatch() ? await this.deps.act(this.state.inFlight, canDispatch) : 'not-sent';
    } catch {
      outcome = 'unknown';
    }
    // Do not newly sample task ownership after the adapter returns: a task
    // acquiring authority during cleanup did not cause a real worker failure.
    if (
      outcome === 'not-sent' &&
      (authorityWithdrawn || this.stopped || revision !== this.revision || this.recoveryWindowExpired())
    ) {
      // The adapter certified that no bytes were sent. Release the durable reservation
      // without consuming a retry or labelling an explicit disable/shutdown as a failure.
      this.state.inFlight = undefined;
      this.state.attempts--;
      if (this.recoveryWindowExpired()) {
        // A certified unsent deadline refusal refunds the attempt, never its elapsed window.
        this.block('recovery-window-exhausted', true);
      } else {
        if (this.state.attempts === 0) this.state.windowStartedAt = undefined;
        this.state.phase = 'idle';
        this.state.needsAttention = false;
        if (
          retainedStallAlert &&
          retainedStallAlert === (this.state.stallAlert ?? this.legacyStallAlert) &&
          this.state.lastReason === 'scheduled'
        ) {
          // A certified canceled stall attempt relinquishes its reservation to the
          // same unresolved warning. Owner input and newer attention revoke that marker.
          this.state.phase = 'paused';
          this.state.needsAttention = true;
          this.state.lastReason = 'stall-unverified';
        }
      }
      await this.save();
      return;
    }
    if (outcome !== 'sent') {
      this.state.failedAttempts++;
      if (outcome === 'not-sent') {
        this.state.inFlight = undefined;
        this.block('delivery-failed', this.state.attempts >= this.state.config.maxRetries);
      } else this.block('acceptance-unverified');
    } else this.event(pending.action, pending.action === 'restart' ? 'process-resumed' : 'continuation-sent');
    await this.save();
  }
}
