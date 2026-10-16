/** @fileoverview Instance-scoped private atomic task journal. */
import { existsSync, lstatSync, readFileSync, renameSync } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { dataPath } from '../config/instance.js';
import { TaskStateSchema, initialTaskState, type TaskState } from './schema.js';
const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;

/** The synchronous commit callback publishes an already prepared controller state. */
export interface TaskSaveAuthority {
  isCurrent(): boolean;
  /** Revalidate asynchronous evidence, then invoke commit without another await. */
  prepareCommit?(commit: () => void): Promise<void>;
  cancelled(): Error;
  commit(): void;
}

/** An unfinished objective or unresolved delivery remains owned without a live pane. */
export function taskJournalHasOwnership(state: TaskState): boolean {
  return (
    !!state.inFlight ||
    state.agentProgressVeto === true ||
    (!!state.objective &&
      (state.outcome !== 'completed' ||
        state.phase !== 'completed' ||
        state.criteria.length === 0 ||
        state.criteria.some((criterion) => !criterion.verified))) ||
    (!state.objective && state.config.enabled)
  );
}

export class TaskStore {
  private records: Record<string, TaskState> = {};
  private writes: Promise<unknown> = Promise.resolve();
  private writeUncertain = false;
  private pendingCleanupWrites = 0;
  private cleanupWriteFailed = false;
  readonly loadFailed: boolean;

  constructor(private readonly path = dataPath('tasks.json')) {
    let failed = false;
    try {
      if (existsSync(path)) {
        const info = lstatSync(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_JOURNAL_BYTES)
          throw new Error('Invalid journal');
        const data = JSON.parse(readFileSync(path, 'utf8'));
        const parsed = z
          .object({ version: z.literal(1), sessions: z.record(z.string().regex(/^[\w-]{1,100}$/), TaskStateSchema) })
          .strict()
          .parse(data);
        if (Object.keys(parsed.sessions).length > 200) throw new Error('Journal is over capacity');
        this.records = parsed.sessions as Record<string, TaskState>;
      }
    } catch {
      failed = true;
    }
    this.loadFailed = failed;
  }

  get(id: string): TaskState {
    const state = structuredClone(this.records[id] ?? initialTaskState());
    if (this.loadFailed || this.writeUncertain) {
      state.config.enabled = false;
      state.phase = 'blocked';
      state.reason = 'persistence-failed';
    }
    return state;
  }

  /** Complete private ownership domain; an uncertain journal cannot authorize cleanup. */
  getBrokerCleanupState(): Record<string, TaskState> | undefined {
    if (this.loadFailed || this.writeUncertain || this.pendingCleanupWrites > 0 || this.cleanupWriteFailed)
      return undefined;
    return structuredClone(this.records);
  }

  save(id: string, state: TaskState, authority?: TaskSaveAuthority): Promise<void> {
    if (this.loadFailed) return Promise.reject(new Error('Task journal could not be loaded'));
    if (this.writeUncertain) return Promise.reject(new Error('Task journal durability is uncertain'));
    if (!/^[\w-]{1,100}$/.test(id)) return Promise.reject(new Error('Invalid session identity'));
    TaskStateSchema.parse(state);
    const copy = structuredClone(state);
    // Certify only this save's own pure precommit guard rejection. A caller
    // may reuse an Error object, and I/O failures must never gain that proof.
    let certifiedCancellation: Error | undefined;
    const guarded = authority && {
      isCurrent: () => authority.isCurrent(),
      prepareCommit: authority.prepareCommit?.bind(authority),
      commit: () => authority.commit(),
      cancelled: () => (certifiedCancellation = authority.cancelled()),
    };
    this.pendingCleanupWrites++;
    const result = this.writes.then(async () => {
      if (this.writeUncertain) throw new Error('Task journal durability is uncertain');
      if (guarded && !guarded.isCurrent()) throw guarded.cancelled();
      const next = { ...this.records, [id]: copy };
      if (Object.keys(next).length > 200) throw new Error('Recovery journal is over capacity');
      await this.write(next, guarded, () => {
        certifiedCancellation = undefined;
      });
      this.records = next;
      this.cleanupWriteFailed = false;
    });
    const tracked = result
      .catch((error: unknown) => {
        if (error !== certifiedCancellation || certifiedCancellation === undefined) this.cleanupWriteFailed = true;
        throw error;
      })
      .finally(() => {
        this.pendingCleanupWrites--;
      });
    this.writes = tracked.catch(() => {});
    return tracked;
  }

  drop(id: string): Promise<void> {
    if (this.loadFailed) return Promise.reject(new Error('Task journal could not be loaded'));
    if (this.writeUncertain) return Promise.reject(new Error('Task journal durability is uncertain'));
    this.pendingCleanupWrites++;
    const result = this.writes.then(async () => {
      if (this.writeUncertain) throw new Error('Task journal durability is uncertain');
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

  /** Prune unreachable inactive records, preserving durable task/action ownership. */
  pruneOrphans(keep: (id: string) => boolean): Promise<number> {
    if (this.loadFailed) return Promise.reject(new Error('Task journal could not be loaded; refusing overwrite'));
    if (this.writeUncertain)
      return Promise.reject(new Error('Task journal durability is uncertain; refusing overwrite'));
    this.pendingCleanupWrites++;
    const result = this.writes.then(async () => {
      if (this.writeUncertain) throw new Error('Task journal durability is uncertain');
      const next = { ...this.records };
      let removed = 0;
      for (const [id, state] of Object.entries(next)) {
        if (keep(id) || taskJournalHasOwnership(state)) continue;
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

  private async write(
    records: Record<string, TaskState>,
    authority?: TaskSaveAuthority,
    cleanupFailed?: () => void
  ): Promise<void> {
    const serialized = JSON.stringify({ version: 1, sessions: records });
    if (Buffer.byteLength(serialized, 'utf8') > MAX_JOURNAL_BYTES)
      throw new Error('Task journal is over byte capacity');
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    let commitAttempted = false;
    try {
      const handle = await open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(serialized);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (authority) {
        const commit = () => {
          if (commitAttempted) throw new Error('Task journal commit was already attempted');
          if (!authority.isCurrent()) throw authority.cancelled();
          // No await separates final evidence validation, authority, pathname
          // replacement and controller publication. All file preparation stays async.
          commitAttempted = true;
          renameSync(temp, this.path);
          this.records = records;
          authority.commit();
        };
        if (authority.prepareCommit) {
          await authority.prepareCommit(commit);
          if (!commitAttempted) throw authority.cancelled();
        } else commit();
      } else {
        commitAttempted = true;
        await rename(temp, this.path);
      }
      const directory = await open(dirname(this.path), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      if (commitAttempted) this.writeUncertain = true;
      throw error;
    } finally {
      await unlink(temp).catch(() => {
        cleanupFailed?.();
      });
    }
  }

  async flush(): Promise<void> {
    await this.writes;
  }
}
