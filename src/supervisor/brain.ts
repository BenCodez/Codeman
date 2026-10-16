/** @fileoverview Private, bounded manager memory with receipts in the same atomic Markdown file. */
import fsSync, { constants, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, parse } from 'node:path';
import { dataPath } from '../config/instance.js';

export const MAX_BRAIN_BYTES = 32 * 1024;
export const MAX_BRAIN_NOTE_BYTES = 2 * 1024;
export const MAX_BRAIN_NOTES = 64;
const MAX_FILE_BYTES = 64 * 1024;
const HEADER = '<!-- codeman-supervisor-brain ';
const ID = /^[\w-]{8,100}$/;
const REQUEST_ID = /^[\w-]{1,100}$/;
const HASH = /^[a-f0-9]{64}$/;
// eslint-disable-next-line no-control-regex -- terminal control bytes are rejected before storing prompt memory
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const pending = new Map<string, Promise<unknown>>();
let pendingCount = 0;
export type BrainAuthority = () => boolean;
export interface BrainSnapshot {
  markdown: string;
  revision: string;
  exists: boolean;
  noteCount: number;
}
export class BrainStoreError extends Error {
  constructor(readonly code: 'invalid' | 'conflict' | 'capacity' | 'unavailable' | 'uncertain' | 'forbidden') {
    super(`Supervisor memory ${code}`);
    this.name = 'BrainStoreError';
  }
}
type Receipt = { requestId: string; hash: string };
type Record = { markdown: string; receipts: Receipt[] };
type Leaf = { text: string; info?: Stats; record: Record };
type Directory = { path: string; info: Stats };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function authorize(current: BrainAuthority): void {
  try {
    const verdict: unknown = current();
    if (verdict === true) return;
    if (verdict instanceof Promise) void verdict.catch(() => {});
    else if (verdict && typeof (verdict as { then?: unknown }).then === 'function')
      void Promise.resolve(verdict).catch(() => {});
  } catch {
    /* No caller diagnostics or private paths cross this boundary. */
  }
  throw new BrainStoreError('forbidden');
}
function privateStat(info: Stats, directory = false): boolean {
  return (
    (directory ? info.isDirectory() : info.isFile() && info.nlink === 1) &&
    !info.isSymbolicLink() &&
    (info.mode & 0o777) === (directory ? 0o700 : 0o600) &&
    (process.getuid === undefined || info.uid === process.getuid())
  );
}
function same(a: Stats, b: Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.nlink === b.nlink
  );
}
function textBytes(bytes: Buffer): string {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw new BrainStoreError('unavailable');
  return text;
}
function validText(text: unknown, limit: number): text is string {
  return (
    typeof text === 'string' &&
    !CONTROL.test(text) &&
    Buffer.byteLength(text) <= limit &&
    Buffer.from(text).toString('utf8') === text
  );
}
function decode(text: string): Record {
  const end = text.indexOf(' -->\n');
  if (!text.startsWith(HEADER) || end < HEADER.length || Buffer.byteLength(text) > MAX_FILE_BYTES)
    throw new BrainStoreError('unavailable');
  const metadata = JSON.parse(text.slice(HEADER.length, end));
  const markdown = text.slice(end + 5);
  if (
    !metadata ||
    Object.keys(metadata).sort().join(',') !== 'receipts,version' ||
    metadata.version !== 1 ||
    !Array.isArray(metadata.receipts) ||
    metadata.receipts.length > MAX_BRAIN_NOTES ||
    !validText(markdown, MAX_BRAIN_BYTES)
  )
    throw new BrainStoreError('unavailable');
  const ids = new Set<string>();
  for (const receipt of metadata.receipts) {
    if (
      !receipt ||
      Object.keys(receipt).sort().join(',') !== 'hash,requestId' ||
      typeof receipt.requestId !== 'string' ||
      !REQUEST_ID.test(receipt.requestId) ||
      typeof receipt.hash !== 'string' ||
      !HASH.test(receipt.hash) ||
      ids.has(receipt.requestId)
    )
      throw new BrainStoreError('unavailable');
    ids.add(receipt.requestId);
  }
  return { markdown, receipts: metadata.receipts };
}
function encode(record: Record): string {
  return `${HEADER}${JSON.stringify({ version: 1, receipts: record.receipts })} -->\n${record.markdown}`;
}
function snapshot(leaf: Leaf): BrainSnapshot {
  return {
    markdown: leaf.record.markdown,
    revision: hash(leaf.text),
    exists: !!leaf.info,
    noteCount: leaf.record.receipts.length,
  };
}
const absent = (): Leaf => ({ text: '', record: { markdown: '', receipts: [] } });
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}
function enqueue<T>(path: string, work: () => Promise<T>): Promise<T> {
  if (pendingCount >= 128) return Promise.reject(new BrainStoreError('capacity'));
  pendingCount++;
  const result = (pending.get(path) ?? Promise.resolve()).catch(() => {}).then(work);
  const tracked = result.finally(() => {
    pendingCount--;
    if (pending.get(path) === tracked) pending.delete(path);
  });
  pending.set(path, tracked);
  return tracked;
}

/** Authorization is supplied by the existing owner route or exact manager credential, never by file contents. */
export class BrainStore {
  constructor(private readonly root = dataPath('supervisor-brains')) {
    if (!isAbsolute(root)) throw new BrainStoreError('invalid');
  }
  private path(id: string): string {
    if (typeof id !== 'string' || !ID.test(id)) throw new BrainStoreError('invalid');
    return join(this.root, id, 'brain.md');
  }
  private ancestorsCurrent(): boolean {
    try {
      let path = dirname(this.root);
      for (;;) {
        const info = fsSync.lstatSync(path);
        if (!info.isDirectory() || info.isSymbolicLink()) return false;
        if (path === parse(path).root) return true;
        path = dirname(path);
      }
    } catch {
      return false;
    }
  }
  private current(dirs: Directory[], authority: BrainAuthority): void {
    authorize(authority);
    if (!this.ancestorsCurrent()) throw new BrainStoreError('unavailable');
    for (const dir of dirs) {
      const info = fsSync.lstatSync(dir.path);
      if (!privateStat(info, true) || info.dev !== dir.info.dev || info.ino !== dir.info.ino)
        throw new BrainStoreError('unavailable');
    }
  }
  private async directories(id: string, create: boolean, authority: BrainAuthority): Promise<Directory[] | undefined> {
    authorize(authority);
    if (!this.ancestorsCurrent()) throw new BrainStoreError('unavailable');
    const dirs: Directory[] = [];
    for (const path of [this.root, join(this.root, id)]) {
      try {
        await fs.lstat(path);
      } catch (error) {
        if (!missing(error)) throw error;
        if (!create) {
          this.current(dirs, authority);
          try {
            fsSync.lstatSync(path);
          } catch (error) {
            if (missing(error)) return undefined;
            throw error;
          }
          throw new BrainStoreError('unavailable');
        }
        this.current(dirs, authority);
        try {
          await fs.mkdir(path, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      this.current(dirs, authority);
      const handle = await fs.open(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
      try {
        const info = await handle.stat();
        authorize(authority);
        if (!privateStat(info, true)) throw new BrainStoreError('unavailable');
        dirs.push({ path, info });
      } finally {
        await handle.close();
      }
      this.current(dirs, authority);
    }
    return dirs;
  }
  private readSync(path: string): Leaf {
    let fd: number;
    try {
      fd = fsSync.openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (missing(error)) return absent();
      throw error;
    }
    try {
      const info = fsSync.fstatSync(fd);
      if (!privateStat(info) || info.size > MAX_FILE_BYTES) throw new BrainStoreError('unavailable');
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      const count = fsSync.readSync(fd, buffer, 0, buffer.length, 0);
      if (count !== info.size || !same(info, fsSync.fstatSync(fd)) || !same(info, fsSync.lstatSync(path)))
        throw new BrainStoreError('unavailable');
      const text = textBytes(buffer.subarray(0, count));
      return { text, info, record: decode(text) };
    } finally {
      fsSync.closeSync(fd);
    }
  }
  private readLeaf(path: string, dirs: Directory[], authority: BrainAuthority): Leaf {
    this.current(dirs, authority);
    const leaf = this.readSync(path);
    this.current(dirs, authority);
    return leaf;
  }
  private async syncDirectories(dirs: Directory[], authority: BrainAuthority): Promise<void> {
    for (const path of [...dirs.map((dir) => dir.path).reverse(), dirname(this.root)]) {
      this.current(dirs, authority);
      const handle = await fs.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        this.current(dirs, authority);
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.current(dirs, authority);
    }
  }
  private async write(
    path: string,
    dirs: Directory[],
    before: Leaf,
    record: Record,
    authority: BrainAuthority
  ): Promise<BrainSnapshot> {
    const text = encode(record);
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new BrainStoreError('capacity');
    const temporary = join(dirname(path), `.brain-${randomUUID()}.tmp`);
    let published = false;
    let temporaryInfo: Stats | undefined;
    try {
      this.current(dirs, authority);
      const handle = await fs.open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      try {
        this.current(dirs, authority);
        await handle.writeFile(text);
        this.current(dirs, authority);
        await handle.sync();
        this.current(dirs, authority);
      } finally {
        temporaryInfo = await handle.stat().catch(() => undefined);
        await handle.close();
      }
      const latest = this.readLeaf(path, dirs, authority);
      if (
        latest.text !== before.text ||
        !!latest.info !== !!before.info ||
        (latest.info && before.info && !same(latest.info, before.info))
      )
        throw new BrainStoreError('conflict');
      // The final CAS and publication have no awaited gap. Cooperative writers
      // share the path queue, including independently constructed store objects.
      this.current(dirs, authority);
      if (!temporaryInfo || !privateStat(temporaryInfo) || !same(temporaryInfo, fsSync.lstatSync(temporary)))
        throw new BrainStoreError('unavailable');
      fsSync.renameSync(temporary, path);
      published = true;
      await this.syncDirectories(dirs, authority);
      const saved = this.readLeaf(path, dirs, authority);
      if (saved.text !== text) throw new BrainStoreError('uncertain');
      return snapshot(saved);
    } catch (error) {
      if (published) throw new BrainStoreError('uncertain');
      throw error;
    } finally {
      if (!published && temporaryInfo && privateStat(temporaryInfo)) {
        try {
          this.current(dirs, () => true);
          if (same(temporaryInfo, fsSync.lstatSync(temporary))) fsSync.unlinkSync(temporary);
        } catch {
          /* Preserve replaced or unrecognized temporary paths. */
        }
      }
    }
  }
  private run<T>(id: string, authority: BrainAuthority, work: (path: string) => Promise<T>): Promise<T> {
    let path: string;
    try {
      path = this.path(id);
      authorize(authority);
    } catch (error) {
      return Promise.reject(error);
    }
    return enqueue(path, async () => {
      try {
        authorize(authority);
        return await work(path);
      } catch (error) {
        throw error instanceof BrainStoreError ? error : new BrainStoreError('unavailable');
      }
    });
  }
  read(id: string, authority: BrainAuthority): Promise<BrainSnapshot> {
    return this.run(id, authority, async (path) => {
      const dirs = await this.directories(id, false, authority);
      return snapshot(dirs ? this.readLeaf(path, dirs, authority) : absent());
    });
  }
  replace(id: string, markdown: string, ifMatch: string, authority: BrainAuthority): Promise<BrainSnapshot> {
    if (!validText(markdown, MAX_BRAIN_BYTES) || typeof ifMatch !== 'string' || !HASH.test(ifMatch))
      return Promise.reject(new BrainStoreError('invalid'));
    return this.run(id, authority, async (path) => {
      const dirs = (await this.directories(id, true, authority))!;
      const before = this.readLeaf(path, dirs, authority);
      if (snapshot(before).revision !== ifMatch) throw new BrainStoreError('conflict');
      return this.write(path, dirs, before, { markdown, receipts: before.record.receipts }, authority);
    });
  }
  append(
    id: string,
    requestId: string,
    note: string,
    ifMatch: string,
    authority: BrainAuthority
  ): Promise<BrainSnapshot & { duplicate: boolean }> {
    if (
      typeof requestId !== 'string' ||
      !REQUEST_ID.test(requestId) ||
      !validText(note, MAX_BRAIN_NOTE_BYTES) ||
      !note.trim() ||
      typeof ifMatch !== 'string' ||
      !HASH.test(ifMatch)
    )
      return Promise.reject(new BrainStoreError('invalid'));
    return this.run(id, authority, async (path) => {
      const dirs = (await this.directories(id, true, authority))!;
      const before = this.readLeaf(path, dirs, authority);
      const receipt = before.record.receipts.find((receipt) => receipt.requestId === requestId);
      if (receipt) {
        if (receipt.hash !== hash(note)) throw new BrainStoreError('conflict');
        // A prior publication may have lost its ACK. Re-confirm durability of
        // the exact receipt without appending or rewriting any bytes.
        const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          this.current(dirs, authority);
          if (!before.info || !same(before.info, await handle.stat())) throw new BrainStoreError('unavailable');
          this.current(dirs, authority);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await this.syncDirectories(dirs, authority);
        const after = this.readLeaf(path, dirs, authority);
        if (after.text !== before.text || !after.info || !before.info || !same(after.info, before.info))
          throw new BrainStoreError('conflict');
        return { ...snapshot(after), duplicate: true };
      }
      if (snapshot(before).revision !== ifMatch) throw new BrainStoreError('conflict');
      if (before.record.receipts.length >= MAX_BRAIN_NOTES) throw new BrainStoreError('capacity');
      const markdown = `${before.record.markdown}${before.record.markdown ? '\n\n' : ''}${note}`;
      if (!validText(markdown, MAX_BRAIN_BYTES)) throw new BrainStoreError('capacity');
      const saved = await this.write(
        path,
        dirs,
        before,
        { markdown, receipts: [...before.record.receipts, { requestId, hash: hash(note) }] },
        authority
      );
      return { ...saved, duplicate: false };
    });
  }
}
