/** @fileoverview Serialized, durable recovery controller; all action authority lives in the adapter. */
import { createHash } from 'node:crypto';
import { RecoveryConfigSchema } from './schema.js';
import {
  CONTINUATION_PROMPT,
  initialRecoveryState,
  type RecoveryConfig,
  type RecoveryEvent,
  type RecoveryObservation,
  type RecoveryReason,
  type RecoveryState,
  type RecoveryFlight,
} from './types.js';

export interface RecoveryDependencies {
  resetReservation?(): Promise<void>;
  /** Shared task ownership may revoke authority while a delivery reservation is saving. */
  hasActionAuthority?(): boolean;
  observe(): Promise<RecoveryObservation>;
  /** 'unknown' includes any possibly-partially-delivered operation; it must never be replayed. */
  act(flight: RecoveryFlight, isCurrent: () => boolean): Promise<'sent' | 'not-sent' | 'unknown'>;
  /** Explicit owner action for a verified missing owned remote worker. */
  restoreMissingRemote?(isCurrent: () => boolean): Promise<'sent' | 'not-sent' | 'unknown'>;
  persist(state: RecoveryState): Promise<void>;
  changed(state: RecoveryState): void;
  now?: () => number;
}

const POLL_MS = 5000;
const ACCEPTANCE_TIMEOUT_MS = 60_000;
const CONFIRM_MS = 2000;
const STALL_CONFIRM_MAX_MS = 15_000;
const promptHash = createHash('sha256').update(CONTINUATION_PROMPT).digest('hex');

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
  };
  private legacyStallAlert?: { conversationId: string; at: number };
  private restoredFlight: boolean;
  private flightObservationComplete = false;

  constructor(
    private readonly deps: RecoveryDependencies,
    restored?: RecoveryState
  ) {
    this.state = structuredClone(restored ?? initialRecoveryState());
    if (
      !this.state.stallAlert &&
      this.state.needsAttention &&
      ['stalled', 'stall-unverified', 'observing', 'disabled'].includes(this.state.lastReason)
    ) {
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
        // Settings can replace lastReason without releasing the latest warning.
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
    if (this.restoredFlight) {
      // The write may have landed before the server died. Observations may confirm it, never replay it.
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
    const observeFlight = !!flight && !this.flightObservationComplete && this.state.lastReason !== 'persistence-failed';
    const automate = !flight && this.state.config.enabled && !this.state.circuitOpen;
    if (!this.stopped && (automate || observeFlight)) {
      const delay =
        flight && observeFlight
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
      this.state.config = config;
      if (enabledNow) this.state.armedAt = this.now();
      if (!config.enabled) {
        this.state.pending = undefined;
        this.state.nextRetryAt = undefined;
        if (!this.state.inFlight) this.state.phase = 'idle';
      }
      this.event('state', config.enabled ? 'observing' : 'disabled');
      await this.save();
      this.arm();
      return this.getStatus();
    });
  }

  async reset(): Promise<RecoveryState> {
    this.revision++;
    return this.enqueue(async () => {
      // Reset is explicit user authorization to clear an unresolved delivery/budget, never itself a retry.
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

  async retry(externallyCurrent: () => boolean = () => true): Promise<RecoveryState> {
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
  async inspect(): Promise<RecoveryState> {
    return this.enqueue(async () => {
      try {
        if (this.stopped) return this.getStatus();
        const revision = this.revision;
        const observation = await this.deps.observe();
        if (this.stopped || revision !== this.revision) return this.getStatus();
        const retained = this.getStatus();
        const restoredFlight = this.restoredFlight;
        const flightObservationComplete = this.flightObservationComplete;
        const before = JSON.stringify(retained);
        this.invalidateConfirmation(observation);
        const unchangedStall = this.retainStallAlert(observation);
        this.state.activity = observation.activity;
        this.state.conversationId = observation.conversationId;
        const hadFlight = !!this.state.inFlight;
        if (hadFlight) this.reconcileFlight(observation);
        else if (!this.state.pending && !this.state.circuitOpen) {
          if (unchangedStall) {
            this.state.lastReason = 'stall-unverified';
            this.state.needsAttention = true;
            this.state.phase = 'paused';
          } else this.state.lastReason = observation.reason;
        }
        if (JSON.stringify(this.state) !== before) {
          if (!(await this.save({ state: retained, revision }))) {
            // A read still reports the durable uncertainty and persistence veto.
            // Mutation/action callers keep the throwing save contract.
            this.restoredFlight = restoredFlight;
            this.flightObservationComplete = flightObservationComplete;
          }
        }
        return this.getStatus();
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

  private stallHandledKey(key: string, progressAt: number): string {
    return `stall:${createHash('sha256').update(key).digest('hex')}:${progressAt}`;
  }

  private validStallProgress(observation: RecoveryObservation): boolean {
    const progress = observation.progressAt;
    return (
      typeof progress === 'number' &&
      Number.isFinite(progress) &&
      progress > 0 &&
      progress <= Number.MAX_SAFE_INTEGER &&
      progress <= this.now() &&
      Number.isFinite(observation.at) &&
      observation.at > 0 &&
      observation.at <= Number.MAX_SAFE_INTEGER &&
      observation.at <= this.now()
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
    // Old rollout progress cannot count as silence accumulated after an accepted
    // recovery. Persist this baseline so a journal reload keeps the same interval.
    return Math.max(observation.progressAt ?? observation.at, this.state.lastSuccessfulRecovery ?? 0);
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
      (stall && confirmation.progressAt !== (observation.progressAt ?? observation.at))
    ) {
      this.confirmation = undefined;
    }
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
          (observation.progressAt !== undefined && observation.progressAt > baseline))) ||
      ('key' in alert && !!observation.stallEvidenceKey && observation.stallEvidenceKey !== alert.key) ||
      observation.reason === 'user-input' ||
      observation.reason === 'user-interrupted';
    if (resolved) {
      this.state.stallAlert = undefined;
      this.legacyStallAlert = undefined;
      if (!this.state.inFlight && !this.state.circuitOpen) {
        // Settings may replace lastReason while this marker still owns attention.
        this.state.needsAttention = false;
        this.state.phase = observation.activity === 'completed' ? 'completed' : 'watching';
      }
      return false;
    }
    if (!this.state.stallAlert && sameThread && observation.stallEvidenceKey) {
      this.state.stallAlert = { key: observation.stallEvidenceKey, conversationId: alert.conversationId, progressAt };
      this.legacyStallAlert = undefined;
    }
    return true;
  }

  /** Reconcile only a known durable delivery reservation; this never authorizes an action. */
  private reconcileFlight(observation: RecoveryObservation): void {
    const flight = this.state.inFlight;
    if (!flight) return;
    const sameThread = observation.conversationId === flight.conversationId;
    const accepted =
      sameThread &&
      (flight.action === 'restart'
        ? observation.processReady === true
        : observation.submissionHash === promptHash &&
          !!observation.submissionKey &&
          observation.submissionKey !== flight.previousSubmissionKey);
    if (accepted) {
      this.handled(
        flight.reason === 'stalled' && flight.stallProgressAt !== undefined
          ? this.stallHandledKey(flight.key, flight.stallProgressAt)
          : flight.key
      );
      this.state.inFlight = undefined;
      this.restoredFlight = false;
      this.flightObservationComplete = true;
      this.state.lastSuccessfulRecovery = this.now();
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

  private recoveryWindowExpired(): boolean {
    const origin = this.state.windowStartedAt;
    if (origin === undefined) return false;
    const elapsed = this.now() - origin;
    return !Number.isFinite(origin) || origin < 0 || elapsed < 0 || elapsed >= this.state.config.maxRecoveryDurationMs;
  }

  private async evaluate(manual: boolean, externallyCurrent: () => boolean = () => true): Promise<void> {
    if (this.stopped || !externallyCurrent()) return;
    const revision = this.revision;
    const isCurrent = () => !this.stopped && revision === this.revision && externallyCurrent();
    const before = JSON.stringify(this.state);
    let observation: RecoveryObservation;
    try {
      observation = await this.deps.observe();
    } catch {
      observation = { activity: 'unknown', reason: 'identity-unverified', at: this.now(), safeToAct: false };
    }
    if (!isCurrent()) return;
    this.invalidateConfirmation(observation);
    let unchangedStallAlert = this.retainStallAlert(observation);
    this.state.activity = observation.activity;
    this.state.conversationId = observation.conversationId;

    if (this.state.inFlight) {
      this.reconcileFlight(observation);
      if (this.state.inFlight) {
        if (JSON.stringify(this.state) !== before) await this.save();
        return;
      }
      // Acceptance released the warning after this observation first retained it.
      unchangedStallAlert = false;
    }

    if (!manual && !this.state.config.enabled) {
      if (JSON.stringify(this.state) !== before) await this.save();
      return;
    }
    if (this.state.circuitOpen) return;
    const failure = observation.activity === 'interrupted' || observation.activity === 'crashed';
    const stallDetected = this.detectsStall(observation);
    const restartableStall = stallDetected && observation.stallRestartable === true;
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
            kind: 'live-stall',
            at: this.now(),
            progressAt: observation.progressAt ?? observation.at,
          };
        else if (age >= CONFIRM_MS) {
          // Repeated silence cannot prove a live Codex turn stopped. Ask the owner to
          // inspect/retry it; never send Escape, continuation input, or kill the pane.
          this.state.stallAlert = {
            key,
            conversationId: observation.conversationId!,
            progressAt: this.stallQuietSince(observation),
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
        this.state.needsAttention = this.state.config.enabled;
      } else {
        this.state.phase = 'watching';
        if (
          observation.activity === 'working' ||
          observation.activity === 'watching' ||
          observation.activity === 'idle'
        ) {
          this.state.needsAttention = false;
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
      const handledKey = this.stallHandledKey(key, progress);
      const prefix = handledKey.slice(0, handledKey.lastIndexOf(':') + 1);
      const previousCycles = this.state.handledEvidence.filter((entry) => entry.startsWith(prefix));
      if (
        previousCycles.includes(handledKey) ||
        (previousCycles.length > 0 &&
          (progress <= (this.state.lastSuccessfulRecovery ?? Infinity) ||
            previousCycles.some((entry) => {
              const previousProgress = Number(entry.slice(prefix.length));
              return (
                !Number.isFinite(previousProgress) ||
                previousProgress <= 0 ||
                previousProgress > Number.MAX_SAFE_INTEGER ||
                progress <= previousProgress
              );
            })))
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
    // A stall always needs repeated fresh probes. A manual click may waive delay for
    // an explicit terminal failure, but it cannot turn one dead-pane read into proof.
    if (
      (restartableStall || !manual) &&
      (this.confirmation?.key !== key ||
        this.now() - this.confirmation.at < CONFIRM_MS ||
        (restartableStall && this.now() - this.confirmation.at > STALL_CONFIRM_MAX_MS))
    ) {
      if (
        !this.confirmation ||
        this.confirmation.key !== key ||
        (restartableStall && this.now() - this.confirmation.at > STALL_CONFIRM_MAX_MS)
      )
        this.confirmation = {
          key,
          kind: restartableStall ? 'dead-stall' : 'failure',
          at: this.now(),
          ...(restartableStall ? { progressAt: observation.progressAt ?? observation.at } : {}),
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
      ...(restartableStall ? { stallProgressAt: observation.progressAt! } : {}),
    };
    this.flightObservationComplete = false;
    this.state.pending = undefined;
    this.state.nextRetryAt = undefined;
    this.state.attempts++;
    this.state.phase = 'recovering';
    this.event('state', 'scheduled');
    // This reservation MUST be durable before any bytes or restart reach the pane.
    await this.save();
    const canDispatch = () =>
      isCurrent() &&
      !this.recoveryWindowExpired() &&
      (this.deps.hasActionAuthority ? this.deps.hasActionAuthority() === true : true);
    let outcome: 'sent' | 'not-sent' | 'unknown';
    try {
      outcome = canDispatch() ? await this.deps.act(this.state.inFlight, canDispatch) : 'not-sent';
    } catch {
      outcome = 'unknown';
    }
    if (outcome === 'not-sent' && !canDispatch()) {
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
