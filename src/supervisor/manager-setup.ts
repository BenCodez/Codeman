/** Durable owner-only setup receipts. Reserved or uncertain phases are never replayed. */
import { lstatSync, readFileSync } from 'node:fs';
import { mkdir, open, rename, unlink, link } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { dataPath } from '../config/instance.js';

export const MANAGER_SETUP_PROMPT = 'Reply READY only.';
const Phase = z.enum([
  'preparing',
  'literal-reserved',
  'literal-sent',
  'enter-reserved',
  'submitted',
  'turn-completed',
  'starting',
  'started',
  'refused',
  'uncertain',
]);
export type ManagerSetupPhase = z.infer<typeof Phase>;
const Receipt = z
  .object({
    sessionId: z.string().uuid(),
    requestId: z
      .string()
      .min(8)
      .max(120)
      .regex(/^[A-Za-z0-9_:.-]+$/),
    scope: z.string().regex(/^[a-f0-9]{64}$/),
    phase: Phase,
    at: z.number().int().nonnegative(),
  })
  .strict();
export type ManagerSetupReceipt = z.infer<typeof Receipt>;
const Journal = z.object({ version: z.literal(1), receipts: z.array(Receipt).max(128) }).strict();
const MAX_BYTES = 131072;
export interface ManagerSetupDependencies {
  current(): boolean;
  prepare(): Promise<boolean | { inspectionOnly: true }>;
  setupTurn(reserve: (phase: ManagerSetupPhase) => Promise<void>): Promise<boolean>;
  start(): Promise<boolean>;
}
export class ManagerSetupJournal {
  private records: ManagerSetupReceipt[] = [];
  private writes: Promise<unknown> = Promise.resolve();
  private readonly active = new Set<string>();
  private failed = false;
  constructor(private readonly path = dataPath('manager-setup.json')) {
    try {
      let info;
      try {
        info = lstatSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (info) {
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) throw Error('Invalid setup journal');
        this.records = Journal.parse(JSON.parse(readFileSync(path, 'utf8'))).receipts;
        if (new Set(this.records.map((r) => r.sessionId + ':' + r.requestId)).size !== this.records.length)
          throw Error('Duplicate setup receipt');
      }
    } catch {
      this.failed = true;
    }
  }
  private archivePath(sessionId: string, requestId: string): string {
    const key = createHash('sha256')
      .update(JSON.stringify([sessionId, requestId]))
      .digest('hex');
    return this.path + '.archive/' + key + '.json';
  }
  private archived(sessionId: string, requestId: string): ManagerSetupReceipt | undefined {
    const path = this.archivePath(sessionId, requestId);
    let info;
    try {
      info = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) throw Error('Invalid setup archive');
    const receipt = Receipt.parse(JSON.parse(readFileSync(path, 'utf8')));
    if (
      receipt.sessionId !== sessionId ||
      receipt.requestId !== requestId ||
      !['started', 'refused'].includes(receipt.phase)
    )
      throw Error('Invalid setup archive binding');
    return receipt;
  }
  private async archive(receipt: ManagerSetupReceipt): Promise<void> {
    const target = this.archivePath(receipt.sessionId, receipt.requestId);
    const existing = this.archived(receipt.sessionId, receipt.requestId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(receipt)) throw Error('Setup archive changed');
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temp = target + '.' + randomUUID() + '.tmp';
    try {
      if (!existing) {
        const file = await open(temp, 'wx', 0o600);
        try {
          await file.writeFile(JSON.stringify(receipt));
          await file.sync();
        } finally {
          await file.close();
        }
        // Immutable publication: an existing replay fence can never be replaced.
        try {
          await link(temp, target);
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
            JSON.stringify(this.archived(receipt.sessionId, receipt.requestId)) !== JSON.stringify(receipt)
          )
            throw error;
        }
      }
      const dir = await open(dirname(target), 'r');
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
      // Persist the archive directory entry before dropping anything from primary.
      const parent = await open(dirname(this.path), 'r');
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } finally {
      await unlink(temp).catch(() => {});
    }
  }
  private save(receipt: ManagerSetupReceipt): Promise<void> {
    const result = this.writes.then(async () => {
      if (this.failed) throw Error('Manager setup journal is unavailable');
      const next = this.records.filter((r) => r.sessionId !== receipt.sessionId || r.requestId !== receipt.requestId);
      next.push(Receipt.parse(receipt));
      while (next.length > 128) {
        const index = next.findIndex((r) => ['started', 'refused'].includes(r.phase));
        if (index < 0) throw Error('Manager setup journal is full of unresolved requests');
        await this.archive(next[index]);
        next.splice(index, 1);
      }
      const serialized = JSON.stringify(Journal.parse({ version: 1, receipts: next }));
      if (Buffer.byteLength(serialized) > MAX_BYTES) throw Error('Manager setup journal is full');
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temp = this.path + '.' + randomUUID() + '.tmp';
      let replacing = false;
      try {
        const file = await open(temp, 'wx', 0o600);
        try {
          await file.writeFile(serialized);
          await file.sync();
        } finally {
          await file.close();
        }
        replacing = true;
        await rename(temp, this.path);
        const dir = await open(dirname(this.path), 'r');
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
        this.records = next;
      } catch (error) {
        if (replacing) this.failed = true;
        throw error;
      } finally {
        await unlink(temp).catch(() => {});
      }
    });
    this.writes = result.catch(() => {});
    return result;
  }
  async run(
    sessionId: string,
    requestId: string,
    scope: string,
    deps: ManagerSetupDependencies
  ): Promise<ManagerSetupReceipt> {
    const existing =
      this.records.find((r) => r.sessionId === sessionId && r.requestId === requestId) ??
      this.archived(sessionId, requestId);
    if (existing) {
      if (existing.scope !== scope) throw Error('Manager setup request scope changed');
      return structuredClone(existing);
    }
    if (this.failed || this.active.has(sessionId) || !deps.current()) throw Error('Manager setup is unavailable');
    if (this.records.some((r) => r.sessionId === sessionId && !['started', 'refused'].includes(r.phase)))
      throw Error('Unresolved manager setup requires owner inspection');
    const receipt: ManagerSetupReceipt = Receipt.parse({
      sessionId,
      requestId,
      scope,
      phase: 'preparing',
      at: Date.now(),
    });
    this.active.add(sessionId);
    const reserve = async (phase: ManagerSetupPhase) => {
      if (!deps.current()) throw Error('Manager setup was cancelled');
      const next = { ...receipt, phase, at: Date.now() };
      await this.save(next);
      Object.assign(receipt, next);
      if (!deps.current()) throw Error('Manager setup was cancelled');
    };
    try {
      await reserve('preparing');
      let prepared = await deps.prepare();
      if (prepared !== true && prepared && prepared.inspectionOnly) {
        if (!deps.current() || !(await deps.setupTurn(reserve))) {
          await reserve(receipt.phase === 'preparing' ? 'refused' : 'uncertain');
          return receipt;
        }
        prepared = await deps.prepare();
      }
      if (prepared !== true) {
        await reserve('refused');
        return receipt;
      }
      await reserve('starting');
      if (!(await deps.start())) {
        await reserve('uncertain');
        return receipt;
      }
      await reserve('started');
      return receipt;
    } catch {
      // Never turn a reserved send into permission to replay, including response loss.
      if (!['preparing', 'refused', 'started'].includes(receipt.phase)) {
        try {
          await this.save({ ...receipt, phase: 'uncertain', at: Date.now() });
          receipt.phase = 'uncertain';
        } catch {
          /* Preserve the earlier reservation. */
        }
      }
      return structuredClone(receipt);
    } finally {
      this.active.delete(sessionId);
    }
  }
}
