/** @fileoverview Instance-scoped private atomic task journal. */
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { dataPath } from '../config/instance.js';
import { TaskStateSchema, initialTaskState, type TaskState } from './schema.js';
const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;

export class TaskStore {
  private records: Record<string, TaskState> = {};
  private writes: Promise<unknown> = Promise.resolve();
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
    if (this.loadFailed) {
      state.config.enabled = false;
      state.phase = 'blocked';
      state.reason = 'persistence-failed';
    }
    return state;
  }

  save(id: string, state: TaskState): Promise<void> {
    if (!/^[\w-]{1,100}$/.test(id)) return Promise.reject(new Error('Invalid session identity'));
    TaskStateSchema.parse(state);
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

  private async write(records: Record<string, TaskState>): Promise<void> {
    const serialized = JSON.stringify({ version: 1, sessions: records });
    if (Buffer.byteLength(serialized, 'utf8') > MAX_JOURNAL_BYTES)
      throw new Error('Task journal is over byte capacity');
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(serialized);
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
