/** @fileoverview Instance-scoped, atomic recovery journal. Persistence failure stops automation. */
import { existsSync, lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
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
const Pending = z.object({ key: Evidence, action: z.enum(['continue', 'restart']), conversationId: IdSchema }).strict();
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
    inFlight: Pending.extend({
      startedAt: Stamp,
      previousSubmissionKey: z.string().max(100).optional(),
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
      if (!flight?.accepted) return true;
      return (
        state.conversationId === flight.conversationId &&
        flight.acceptedAt !== undefined &&
        flight.acceptedAt >= flight.startedAt &&
        state.lastSuccessfulRecovery === flight.acceptedAt &&
        state.handledEvidence.includes(flight.key) &&
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
  private writeUncertain = false;
  readonly loadFailed: boolean;
  private pendingCleanupWrites = 0;
  private cleanupWriteFailed = false;

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
      // Preserve readable reservations, but never activate an unacknowledged mutation.
      try {
        lstatSync(`${path}.pending`);
        failed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    } catch {
      failed = true;
    }
    this.loadFailed = failed;
  }

  /** Pure complete private reference domain; pending/failed durability is unknown. */
  getCleanupSnapshot(): Record<string, RecoveryState> | undefined {
    return this.loadFailed || this.writeUncertain || this.pendingCleanupWrites > 0 || this.cleanupWriteFailed
      ? undefined
      : structuredClone(this.records);
  }

  get(id: string): RecoveryState {
    const state = structuredClone(this.records[id] ?? initialRecoveryState());
    if (this.loadFailed || this.writeUncertain) {
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
    if (this.writeUncertain) return Promise.reject(new Error('Recovery journal durability is uncertain'));
    if (!/^[\w-]{1,100}$/.test(id)) return Promise.reject(new Error('Invalid session identity'));
    StateSchema.parse(state);
    const copy = structuredClone(state);
    this.pendingCleanupWrites++;
    const result = this.writes.then(async () => {
      if (this.writeUncertain) throw new Error('Recovery journal durability is uncertain');
      const next = { ...this.records, [id]: copy };
      if (Object.keys(next).length > 200) throw new Error('Recovery journal is over capacity');
      await this.write(next);
      this.records = next;
      this.cleanupWriteFailed = false;
    });
    const tracked = result
      .catch((error: unknown) => {
        this.cleanupWriteFailed = true;
        throw error;
      })
      .finally(() => {
        this.pendingCleanupWrites--;
      });
    this.writes = tracked.catch(() => {});
    return tracked;
  }

  drop(id: string): Promise<void> {
    if (this.loadFailed) return Promise.reject(new Error('Recovery journal could not be loaded; refusing overwrite'));
    if (this.writeUncertain) return Promise.reject(new Error('Recovery journal durability is uncertain'));
    this.pendingCleanupWrites++;
    const result = this.writes.then(async () => {
      if (this.writeUncertain) throw new Error('Recovery journal durability is uncertain');
      if (!this.records[id]) return;
      const next = { ...this.records };
      delete next[id];
      await this.write(next);
      this.records = next;
      this.cleanupWriteFailed = false;
    });
    const tracked = result
      .catch((error: unknown) => {
        this.cleanupWriteFailed = true;
        throw error;
      })
      .finally(() => {
        this.pendingCleanupWrites--;
      });
    this.writes = tracked.catch(() => {});
    return tracked;
  }

  /** Remove unreachable settings/intentions; a durable delivery reservation remains evidence. */
  pruneOrphans(keep: (id: string) => boolean): Promise<number> {
    if (this.loadFailed) return Promise.reject(new Error('Recovery journal could not be loaded; refusing overwrite'));
    if (this.writeUncertain) return Promise.reject(new Error('Recovery journal durability is uncertain'));
    this.pendingCleanupWrites++;
    const result = this.writes.then(async () => {
      if (this.writeUncertain) throw new Error('Recovery journal durability is uncertain');
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
        this.cleanupWriteFailed = false;
      }
      return removed;
    });
    const tracked = result
      .catch((error: unknown) => {
        this.cleanupWriteFailed = true;
        throw error;
      })
      .finally(() => {
        this.pendingCleanupWrites--;
      });
    this.writes = tracked.catch(() => {});
    return tracked;
  }

  private async write(records: Record<string, RecoveryState>): Promise<void> {
    const payload = JSON.stringify({ version: 1, sessions: records });
    if (Buffer.byteLength(payload, 'utf8') > MAX_JOURNAL_BYTES)
      throw new Error('Recovery journal is over byte capacity');
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    const marker = `${this.path}.pending`;
    const token = `${randomUUID()}\n`;
    let fenceAttempted = false;
    try {
      const handle = await open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(payload);
        await handle.sync();
      } finally {
        await handle.close();
      }
      // The fence must survive restart BEFORE a replacement can publish consent,
      // reset budgets, or delivery ownership. Failure leaves it for inspection.
      fenceAttempted = true;
      const fence = await open(marker, 'wx', 0o600);
      let identity;
      try {
        identity = await fence.stat();
        await fence.writeFile(token);
        await fence.sync();
      } finally {
        await fence.close();
      }
      await this.syncDirectory();
      await rename(temp, this.path);
      await this.syncDirectory();
      const current = lstatSync(marker);
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        readFileSync(marker, 'utf8') !== token
      )
        throw new Error('Recovery publication fence changed');
      // Final synchronous commit: no later durability/cleanup error can reject
      // consent after removing its fence. A crash may retain the fence, which
      // conservatively blocks an acknowledged write rather than enabling a failure.
      unlinkSync(marker);
    } catch (error) {
      if (fenceAttempted) this.writeUncertain = true;
      throw error;
    } finally {
      await unlink(temp).catch(() => {});
    }
  }

  private async syncDirectory(): Promise<void> {
    const directory = await open(dirname(this.path), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  async flush(): Promise<void> {
    await this.writes;
  }
}
