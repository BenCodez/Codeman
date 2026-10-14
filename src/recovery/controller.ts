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
  observe(): Promise<RecoveryObservation>;
  /** 'unknown' includes any possibly-partially-delivered operation; it must never be replayed. */
  act(flight: RecoveryFlight, isCurrent: () => boolean): Promise<'sent' | 'not-sent' | 'unknown'>;
  persist(state: RecoveryState): Promise<void>;
  changed(state: RecoveryState): void;
  now?: () => number;
}

const POLL_MS = 5000;
const ACCEPTANCE_TIMEOUT_MS = 60_000;
const CONFIRM_MS = 2000;
const promptHash = createHash('sha256').update(CONTINUATION_PROMPT).digest('hex');

export class RecoveryController {
  private state: RecoveryState;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private revision = 0;
  private confirmation?: { key: string; at: number };
  private restoredFlight: boolean;
  private flightObservationComplete = false;

  constructor(
    private readonly deps: RecoveryDependencies,
    restored?: RecoveryState
  ) {
    this.state = structuredClone(restored ?? initialRecoveryState());
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
    const observeFlight = !!flight && !this.flightObservationComplete;
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
    this.revision++;
    this.confirmation = undefined;
    this.state.armedAt = this.now();
    this.state.pending = undefined;
    this.state.nextRetryAt = undefined;
    if (canceledScheduledAction && !this.stopped) {
      this.state.phase = this.state.config.enabled ? 'watching' : 'idle';
      this.event('state', 'user-input');
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
    this.state.lastReason = reason;
    this.state.history.push({ at: this.now(), kind, reason, attempt: this.state.attempts });
    this.state.history = this.state.history.slice(-100);
  }

  private async save(): Promise<void> {
    try {
      await this.deps.persist(this.getStatus());
    } catch {
      this.state.phase = 'blocked';
      this.state.needsAttention = true;
      this.state.circuitOpen = true;
      this.event('attention', 'persistence-failed');
      this.deps.changed(this.getStatus());
      throw new Error('Recovery state could not be saved');
    }
    this.deps.changed(this.getStatus());
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
      this.state.armedAt = this.now();
      this.event('reset', 'manual-reset');
      await this.save();
      // Clear the shared reservation only after this controller's uncertainty is durably gone.
      await this.deps.resetReservation?.();
      this.arm();
      return this.getStatus();
    });
  }

  async retry(): Promise<RecoveryState> {
    return this.enqueue(async () => {
      try {
        await this.evaluate(true);
        return this.getStatus();
      } finally {
        this.arm();
      }
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
        const before = JSON.stringify(this.state);
        this.state.activity = observation.activity;
        this.state.conversationId = observation.conversationId;
        const hadFlight = !!this.state.inFlight;
        if (hadFlight) this.reconcileFlight(observation);
        else if (!this.state.pending && !this.state.circuitOpen) this.state.lastReason = observation.reason;
        if (JSON.stringify(this.state) !== before) await this.save();
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
      this.handled(flight.key);
      this.state.inFlight = undefined;
      this.restoredFlight = false;
      this.flightObservationComplete = true;
      this.state.lastSuccessfulRecovery = this.now();
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

  private async evaluate(manual: boolean): Promise<void> {
    if (this.stopped) return;
    const revision = this.revision;
    const before = JSON.stringify(this.state);
    let observation: RecoveryObservation;
    try {
      observation = await this.deps.observe();
    } catch {
      observation = { activity: 'unknown', reason: 'identity-unverified', at: this.now(), safeToAct: false };
    }
    if (this.stopped || revision !== this.revision) return;
    this.state.activity = observation.activity;
    this.state.conversationId = observation.conversationId;

    if (this.state.inFlight) {
      this.reconcileFlight(observation);
      if (this.state.inFlight) {
        if (JSON.stringify(this.state) !== before) await this.save();
        return;
      }
    }

    if (!manual && !this.state.config.enabled) {
      if (JSON.stringify(this.state) !== before) await this.save();
      return;
    }
    if (this.state.circuitOpen) return;
    const failure = observation.activity === 'interrupted' || observation.activity === 'crashed';
    const permitted =
      observation.activity === 'crashed' ? this.state.config.recoverCrashes : this.state.config.recoverInterrupted;
    if (!failure || !permitted || !observation.safeToAct || !observation.conversationId || !observation.evidenceKey) {
      this.state.pending = undefined;
      this.state.nextRetryAt = undefined;
      this.confirmation = undefined;
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
      if (
        this.state.config.detectStalls &&
        observation.activity === 'working' &&
        this.now() - (observation.progressAt ?? observation.at) >= this.state.config.stalledAfterMs
      ) {
        if (this.state.lastReason !== 'stalled') this.block('stalled');
      } else if (this.state.lastReason !== observation.reason) this.event('state', observation.reason);
      if (JSON.stringify(this.state) !== before) await this.save();
      return;
    }

    const key = observation.evidenceKey;
    if (this.state.handledEvidence.includes(key)) return;
    // Enabling recovery never replays old failures from a historical rollout. Manual Retry is explicit.
    if (!manual && observation.at < (this.state.armedAt ?? this.now())) return;
    if (!manual && (this.confirmation?.key !== key || this.now() - this.confirmation.at < CONFIRM_MS)) {
      this.confirmation ??= { key, at: this.now() };
      if (this.confirmation.key !== key) this.confirmation = { key, at: this.now() };
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
        action: observation.activity === 'crashed' ? 'restart' : 'continue',
        conversationId: observation.conversationId,
      };
      const delay = Math.min(
        this.state.config.maxRetryDelayMs,
        this.state.config.retryDelayMs * 2 ** this.state.attempts
      );
      this.state.nextRetryAt = manual ? this.now() : this.now() + delay;
      this.state.phase = 'watching';
      this.state.needsAttention = false;
      this.event('scheduled', 'scheduled');
      await this.save();
    }
    if (!manual && this.now() < (this.state.nextRetryAt ?? Infinity)) return;
    if (this.stopped || revision !== this.revision) return;
    const pending = this.state.pending;
    if (!pending) return;
    this.state.inFlight = { ...pending, startedAt: this.now(), previousSubmissionKey: observation.submissionKey };
    this.flightObservationComplete = false;
    this.state.pending = undefined;
    this.state.nextRetryAt = undefined;
    this.state.attempts++;
    this.state.phase = 'recovering';
    this.event('state', 'scheduled');
    // This reservation MUST be durable before any bytes or restart reach the pane.
    await this.save();
    const isCurrent = () => !this.stopped && revision === this.revision && !this.recoveryWindowExpired();
    let outcome: 'sent' | 'not-sent' | 'unknown';
    try {
      outcome = isCurrent() ? await this.deps.act(this.state.inFlight, isCurrent) : 'not-sent';
    } catch {
      outcome = 'unknown';
    }
    if (outcome === 'not-sent' && !isCurrent()) {
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
