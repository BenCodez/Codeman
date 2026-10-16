/** @fileoverview Private bounded schedule journal; unknown replacement ACKs prohibit further writes. */
import { existsSync, lstatSync, readFileSync, renameSync, constants } from 'node:fs';
import fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { dataPath } from '../config/instance.js';
import type { SupervisorAutomationRecord } from '../types/supervisor-automation.js';
import { initialSupervisorAutomationRecord, SupervisorAutomationRecordSchema } from './automation-schema.js';

const MAX_BYTES = 2 * 1024 * 1024;
const Journal = z
  .object({
    version: z.literal(1),
    managers: z.record(z.string().regex(/^[\w-]{8,100}$/), SupervisorAutomationRecordSchema),
  })
  .strict();
type Stat = Awaited<ReturnType<typeof fs.lstat>>;
const same = (a: Stat, b: Stat) =>
  a.isFile() &&
  b.isFile() &&
  !a.isSymbolicLink() &&
  !b.isSymbolicLink() &&
  ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every((key) => a[key as keyof Stat] === b[key as keyof Stat]);
export class SupervisorAutomationStore {
  private records: Record<string, SupervisorAutomationRecord> = {};
  private writes: Promise<unknown> = Promise.resolve();
  private uncertain = false;
  readonly loadFailed: boolean;
  constructor(private readonly path = dataPath('supervisor-automation.json')) {
    let failed = false;
    try {
      if (existsSync(path)) {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw Error('Unknown schedule journal');
        const bytes = readFileSync(path);
        if (bytes.length !== stat.size || bytes.length > MAX_BYTES || !same(stat, lstatSync(path)))
          throw Error('Management journal changed');
        this.records = Journal.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))).managers;
        if (
          Object.keys(this.records).length > 100 ||
          Object.entries(this.records).some(([id, row]) => row.supervisorSessionId !== id)
        )
          throw Error('Unknown schedule journal');
      }
    } catch {
      failed = true;
      this.records = {};
    }
    this.loadFailed = failed;
  }
  get(id: string): SupervisorAutomationRecord {
    if (this.loadFailed || this.uncertain) throw Error('Management schedule journal is unavailable');
    return structuredClone(this.records[id] ?? initialSupervisorAutomationRecord(id));
  }
  ids(): string[] {
    return Object.keys(this.records);
  }
  save(id: string, state: SupervisorAutomationRecord): Promise<void> {
    SupervisorAutomationRecordSchema.parse(state);
    if (state.supervisorSessionId !== id || !/^[\w-]{8,100}$/.test(id))
      return Promise.reject(Error('Management identity mismatch'));
    const copy = structuredClone(state);
    const writing = this.writes.then(async () => {
      if (this.loadFailed || this.uncertain) throw Error('Management schedule journal is unavailable');
      const next = { ...this.records, [id]: copy };
      if (Object.keys(next).length > 100) throw Error('Management schedule journal is full');
      await this.write(next);
      this.records = next;
    });
    this.writes = writing.catch(() => {});
    return writing;
  }
  /** Final owner deletion, serialized after all admitted schedule writes. */
  drop(id: string, current: () => boolean): Promise<void> {
    const writing = this.writes.then(async () => {
      if (this.loadFailed || this.uncertain) throw Error('Management schedule journal is unavailable');
      if (current() !== true) throw Error('Management deletion is no longer current');
      if (!Object.hasOwn(this.records, id)) return;
      const before = this.records[id],
        next = { ...this.records };
      delete next[id];
      await this.write(next, () => current() === true && this.records[id] === before);
      this.records = next;
    });
    this.writes = writing.catch(() => {});
    return writing;
  }
  /** Startup may reclaim settled, unreachable schedules; unknown operations retain their receipt seal. */
  pruneOrphans(keep: (id: string) => boolean): Promise<number> {
    const writing = this.writes.then(async () => {
      if (this.loadFailed || this.uncertain) throw Error('Management schedule journal is unavailable');
      const next = { ...this.records },
        removed: string[] = [];
      for (const [id, row] of Object.entries(next)) {
        if (keep(id) !== false || row.inFlight) continue;
        delete next[id];
        removed.push(id);
      }
      if (removed.length) {
        await this.write(next, () => removed.every((id) => keep(id) === false && !this.records[id]?.inFlight));
        this.records = next;
      }
      return removed.length;
    });
    this.writes = writing.catch(() => {});
    return writing;
  }
  private async snapshot(path: string): Promise<{ stat: Stat; bytes: Buffer } | undefined> {
    let file: Awaited<ReturnType<typeof fs.open>>;
    try {
      file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    let stat: Stat, bytes: Buffer;
    try {
      stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) throw Error('Unknown management journal');
      const buffer = Buffer.alloc(stat.size + 1),
        read = await file.read(buffer, 0, buffer.length, 0);
      bytes = buffer.subarray(0, read.bytesRead);
      if (bytes.length !== stat.size || !same(stat, await file.stat())) throw Error('Management journal changed');
    } finally {
      await file.close();
    }
    if (!same(stat, await fs.lstat(path))) throw Error('Management journal changed');
    return { stat, bytes };
  }
  private async write(next: Record<string, SupervisorAutomationRecord>, current?: () => boolean): Promise<void> {
    const bytes = Buffer.from(JSON.stringify({ version: 1, managers: next }));
    if (bytes.length > MAX_BYTES) throw Error('Management schedule journal is full');
    await fs.mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const parent = await fs.lstat(dirname(this.path));
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw Error('Unknown journal directory');
    const prior = await this.snapshot(this.path),
      temp = this.path + '.' + randomUUID() + '.tmp';
    let owned: Stat | undefined,
      attempted = false;
    try {
      const file = await fs.open(temp, 'wx', 0o600);
      try {
        owned = await file.stat();
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      const staged = await this.snapshot(temp),
        present = await this.snapshot(this.path);
      const parentNow = await fs.lstat(dirname(this.path));
      if (
        !staged ||
        !owned ||
        staged.stat.dev !== owned.dev ||
        staged.stat.ino !== owned.ino ||
        !staged.bytes.equals(bytes) ||
        !!prior !== !!present ||
        (prior && present && (!same(prior.stat, present.stat) || !prior.bytes.equals(present.bytes))) ||
        !parentNow.isDirectory() ||
        parentNow.isSymbolicLink() ||
        parentNow.dev !== parent.dev ||
        parentNow.ino !== parent.ino ||
        !same(staged.stat, await fs.lstat(temp)) ||
        (present && !same(present.stat, await fs.lstat(this.path)))
      )
        throw Error('Management journal changed');
      if (current) {
        // Cleanup authority and exact directory/file ownership share the final
        // synchronous boundary; a newly restored session cannot inherit deletion.
        const finalParent = lstatSync(dirname(this.path));
        let finalFile: Stat | undefined;
        try {
          finalFile = lstatSync(this.path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (
          !!prior !== !!finalFile ||
          current() !== true ||
          !finalParent.isDirectory() ||
          finalParent.isSymbolicLink() ||
          finalParent.dev !== parent.dev ||
          finalParent.ino !== parent.ino ||
          !same(staged.stat, lstatSync(temp)) ||
          (prior && finalFile && !same(prior.stat, finalFile))
        )
          throw Error('Management deletion is no longer current');
        attempted = true;
        renameSync(temp, this.path);
      } else {
        attempted = true;
        await fs.rename(temp, this.path);
      }
      const directory = await fs.open(
        dirname(this.path),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      try {
        const stat = await directory.stat();
        if (stat.dev !== parent.dev || stat.ino !== parent.ino) throw Error('Journal directory changed');
        await directory.sync();
      } finally {
        await directory.close();
      }
      const committed = await this.snapshot(this.path);
      if (
        !committed ||
        committed.stat.dev !== owned.dev ||
        committed.stat.ino !== owned.ino ||
        !committed.bytes.equals(bytes)
      )
        throw Error('Management journal ACK changed');
    } catch (error) {
      if (attempted) this.uncertain = true;
      throw error;
    } finally {
      if (owned) {
        const stat = await fs.lstat(temp).catch(() => undefined);
        if (stat?.isFile() && !stat.isSymbolicLink() && stat.dev === owned.dev && stat.ino === owned.ino)
          await fs.unlink(temp).catch(() => {});
      }
    }
  }
  async flush(): Promise<void> {
    await this.writes;
  }
}
