/** @fileoverview Instance-scoped, atomic recovery journal. Persistence failure stops automation. */
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { dataPath } from '../config/instance.js';
import { RecoveryConfigSchema } from './schema.js';
import { initialRecoveryState, type RecoveryState } from './types.js';

const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;

const ReasonSchema = z.enum([
  'disabled',
  'observing',
  'identity-unverified',
  'identity-changed',
  'managed-daemon',
  'unsupported-location',
  'transport-unreachable',
  'transport-unavailable',
  'remote-inspector-unavailable',
  'remote-session-missing',
  'unowned-session',
  'user-input',
  'user-interrupted',
  'approval-required',
  'authentication-required',
  'usage-limit',
  'internal-retry',
  'turn-running',
  'background-work',
  'turn-completed',
  'turn-interrupted',
  'turn-failed',
  'process-crashed',
  'clean-exit',
  'pane-unverified',
  'stalled',
  'stall-unverified',
  'scheduled',
  'continuation-sent',
  'process-resumed',
  'recovery-accepted',
  'delivery-failed',
  'acceptance-unverified',
  'retries-exhausted',
  'recovery-window-exhausted',
  'restart-in-flight',
  'persistence-failed',
  'manual-reset',
]);
const IdSchema = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
const Stamp = z.number().finite().nonnegative();
const Evidence = z
  .string()
  .max(250)
  .regex(/^[\w:.-]+$/);
const ProgressEvidence = z.string().regex(/^remote:[a-f0-9]{64}$/);
const Pending = z
  .object({
    key: Evidence,
    action: z.enum(['continue', 'restart']),
    conversationId: IdSchema,
    reason: ReasonSchema.optional(),
  })
  .strict();
const StateSchema = z
  .object({
    version: z.literal(1),
    config: RecoveryConfigSchema.refine((c) => Object.keys(c).length === 9),
    activity: z.enum([
      'unknown',
      'idle',
      'working',
      'watching',
      'interrupted',
      'completed',
      'paused',
      'blocked',
      'crashed',
      'exited',
    ]),
    phase: z.enum(['idle', 'watching', 'recovering', 'paused', 'blocked', 'completed', 'failed']),
    conversationId: IdSchema.optional(),
    attempts: z.number().int().min(0).max(10),
    failedAttempts: z.number().int().min(0).max(10),
    windowStartedAt: Stamp.optional(),
    nextRetryAt: Stamp.optional(),
    lastSuccessfulRecovery: Stamp.optional(),
    armedAt: Stamp.optional(),
    lastReason: ReasonSchema,
    circuitOpen: z.boolean(),
    needsAttention: z.boolean(),
    stallAlert: z
      .object({
        key: Evidence,
        conversationId: IdSchema,
        progressAt: Stamp,
        progressEvidenceKey: ProgressEvidence.optional(),
      })
      .strict()
      .optional(),
    inFlight: Pending.extend({
      startedAt: Stamp,
      previousSubmissionKey: z.string().max(100).optional(),
      stallProgressAt: Stamp.positive().max(Number.MAX_SAFE_INTEGER).optional(),
      stallProgressEvidenceKey: ProgressEvidence.optional(),
      stallQuietPeriodMs: z.number().int().min(10_000).max(3_600_000).optional(),
      accepted: z.boolean().optional(),
      acceptedAt: Stamp.optional(),
    }).optional(),
    pending: Pending.optional(),
    handledEvidence: z.array(Evidence).max(32),
    history: z
      .array(
        z
          .object({
            at: Stamp,
            kind: z.enum(['state', 'scheduled', 'continue', 'restart', 'accepted', 'attention', 'reset']),
            reason: ReasonSchema,
            attempt: z.number().int().min(0).max(10),
          })
          .strict()
      )
      .max(100),
  })
  .strict()
  .refine(
    (state) => {
      const flight = state.inFlight;
      if (
        flight &&
        (flight.stallProgressEvidenceKey !== undefined || flight.stallQuietPeriodMs !== undefined) &&
        (flight.reason !== 'stalled' ||
          flight.stallProgressAt === undefined ||
          flight.stallProgressEvidenceKey === undefined ||
          flight.stallQuietPeriodMs === undefined)
      )
        return false;
      if (!flight?.accepted) return true;
      const handledKey =
        flight.reason === 'stalled' && flight.stallProgressAt !== undefined
          ? `stall:${createHash('sha256').update(flight.key).digest('hex')}:${flight.stallProgressEvidenceKey ?? flight.stallProgressAt}`
          : flight.key;
      return (
        (flight.reason !== 'stalled' || flight.stallProgressAt !== undefined) &&
        state.conversationId === flight.conversationId &&
        flight.acceptedAt !== undefined &&
        flight.acceptedAt >= flight.startedAt &&
        state.lastSuccessfulRecovery === flight.acceptedAt &&
        state.handledEvidence.includes(handledKey) &&
        state.history.some(
          (event) => event.kind === 'accepted' && event.reason === 'recovery-accepted' && event.at >= flight.startedAt
        )
      );
    },
    { message: 'Accepted delivery evidence is incomplete', path: ['inFlight'] }
  );

export class RecoveryStore {
  private records: Record<string, RecoveryState> = {};
  private writes: Promise<unknown> = Promise.resolve();
  readonly loadFailed: boolean;

  constructor(private readonly path = dataPath('recovery.json')) {
    let failed = false;
    try {
      if (existsSync(path)) {
        const info = lstatSync(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_JOURNAL_BYTES)
          throw new Error('Invalid journal');
        const data = JSON.parse(readFileSync(path, 'utf8'));
        const parsed = z
          .object({ version: z.literal(1), sessions: z.record(z.string().regex(/^[\w-]{1,100}$/), StateSchema) })
          .strict()
          .parse(data);
        if (Object.keys(parsed.sessions).length > 200) throw new Error('Journal is over capacity');
        this.records = parsed.sessions as Record<string, RecoveryState>;
      }
    } catch {
      failed = true;
    }
    this.loadFailed = failed;
  }

  get(id: string): RecoveryState {
    const state = structuredClone(this.records[id] ?? initialRecoveryState());
    if (this.loadFailed) {
      state.config.enabled = false;
      state.circuitOpen = true;
      state.needsAttention = true;
      state.phase = 'blocked';
      state.lastReason = 'persistence-failed';
    }
    return state;
  }

  save(id: string, state: RecoveryState): Promise<void> {
    if (this.loadFailed) return Promise.reject(new Error('Recovery journal could not be loaded; refusing overwrite'));
    if (!/^[\w-]{1,100}$/.test(id)) return Promise.reject(new Error('Invalid session identity'));
    StateSchema.parse(state);
    const copy = structuredClone(state);
    const result = this.writes.then(async () => {
      const next = { ...this.records, [id]: copy };
      if (Object.keys(next).length > 200) throw new Error('Recovery journal is over capacity');
      await this.write(next);
      this.records = next;
    });
    this.writes = result.catch(() => {});
    return result;
  }

  drop(id: string): Promise<void> {
    if (this.loadFailed) return Promise.reject(new Error('Recovery journal could not be loaded; refusing overwrite'));
    const result = this.writes.then(async () => {
      if (!this.records[id]) return;
      const next = { ...this.records };
      delete next[id];
      await this.write(next);
      this.records = next;
    });
    this.writes = result.catch(() => {});
    return result;
  }

  /** Remove unreachable settings/intentions; a durable delivery reservation remains evidence. */
  pruneOrphans(keep: (id: string) => boolean): Promise<number> {
    if (this.loadFailed) return Promise.reject(new Error('Recovery journal could not be loaded; refusing overwrite'));
    const result = this.writes.then(async () => {
      const next = { ...this.records };
      let removed = 0;
      for (const [id, state] of Object.entries(next)) {
        if (keep(id) || state.inFlight) continue;
        delete next[id];
        removed++;
      }
      if (removed > 0) {
        await this.write(next);
        this.records = next;
      }
      return removed;
    });
    this.writes = result.catch(() => {});
    return result;
  }

  private async write(records: Record<string, RecoveryState>): Promise<void> {
    const payload = JSON.stringify({ version: 1, sessions: records });
    if (Buffer.byteLength(payload, 'utf8') > MAX_JOURNAL_BYTES)
      throw new Error('Recovery journal is over byte capacity');
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(payload);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, this.path);
      const directory = await open(dirname(this.path), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await unlink(temp).catch(() => {});
    }
  }

  async flush(): Promise<void> {
    await this.writes;
  }
}
