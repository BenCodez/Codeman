/** @fileoverview Atomic, bounded supervisor lease and operation journal. */
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { dataPath } from '../config/instance.js';
import { initialSupervisorState, SupervisorStateSchema, type SupervisorState } from './schema.js';

const MAX_BYTES = 2 * 1024 * 1024;
export class SupervisorStore {
  private records: Record<string, SupervisorState> = {};
  private writes: Promise<unknown> = Promise.resolve();
  readonly loadFailed: boolean;

  constructor(private readonly path = dataPath('supervisors.json')) {
    let failed = false;
    try {
      if (existsSync(path)) {
        const info = lstatSync(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) throw new Error('Invalid journal');
        const parsed = z
          .object({
            version: z.literal(1),
            supervisors: z.record(z.string().regex(/^[\w-]{8,100}$/), SupervisorStateSchema),
          })
          .strict()
          .parse(JSON.parse(readFileSync(path, 'utf8')));
        if (Object.keys(parsed.supervisors).length > 100) throw new Error('Journal is over capacity');
        if (Object.entries(parsed.supervisors).some(([id, state]) => state.supervisorSessionId !== id))
          throw new Error('Supervisor journal identity mismatch');
        this.records = parsed.supervisors;
      }
    } catch {
      failed = true;
    }
    this.loadFailed = failed;
  }

  get(id: string): SupervisorState {
    const state = structuredClone(this.records[id] ?? initialSupervisorState(id));
    if (this.loadFailed) {
      state.enabled = false;
      state.phase = 'blocked';
      state.reason = 'persistence-failed';
    }
    return state;
  }

  all(): SupervisorState[] {
    return Object.values(this.records).map((v) => structuredClone(v));
  }

  save(id: string, state: SupervisorState): Promise<void> {
    if (this.loadFailed) return Promise.reject(new Error('Supervisor journal failed to load'));
    if (!/^[\w-]{8,100}$/.test(id)) return Promise.reject(new Error('Invalid supervisor identity'));
    if (state.supervisorSessionId !== id) return Promise.reject(new Error('Supervisor journal identity mismatch'));
    SupervisorStateSchema.parse(state);
    const copy = structuredClone(state);
    const result = this.writes.then(async () => {
      const next = { ...this.records, [id]: copy };
      if (Object.keys(next).length > 100) throw new Error('Supervisor journal is over capacity');
      const serialized = JSON.stringify({ version: 1, supervisors: next });
      if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error('Supervisor journal is over byte capacity');
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
        const dir = await open(dirname(this.path), 'r');
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
      } finally {
        await unlink(temp).catch(() => {});
      }
      this.records = next;
    });
    this.writes = result.catch(() => {});
    return result;
  }

  drop(id: string): Promise<void> {
    if (this.loadFailed) return Promise.reject(new Error('Supervisor journal failed to load'));
    const result = this.writes.then(async () => {
      if (!this.records[id]) return;
      const next = { ...this.records };
      delete next[id];
      const serialized = JSON.stringify({ version: 1, supervisors: next });
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
        const dir = await open(dirname(this.path), 'r');
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
      } finally {
        await unlink(temp).catch(() => {});
      }
      this.records = next;
    });
    this.writes = result.catch(() => {});
    return result;
  }

  async flush(): Promise<void> {
    await this.writes;
  }
}
