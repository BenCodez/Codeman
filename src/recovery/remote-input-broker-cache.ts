/** Private source-host material for controlled owned-SSH launches; never remote adoption. */
import { createHash, randomUUID } from 'node:crypto';
import { constants, lstatSync, type Dir, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import { join, posix } from 'node:path';
import { getDataDirPath } from '../config/instance.js';
import type { SessionRemote } from '../types.js';
import { CodexInputBroker, type BrokerProvisioningMaterial } from './codex-input-broker.js';
import { CODEX_INPUT_BROKER_SOURCE } from './codex-input-broker-source.js';
import type { PrivateFileWitness } from './private-file-witness.js';
import { cleanupRemoteBroker, type RemoteBrokerCleanupTarget } from './remote-broker-cleanup.js';

export interface OwnedRemoteBrokerScope {
  sessionId: string;
  remote: SessionRemote;
  workingDir: string;
  codexHome: string;
  owner?: string;
}
/** Internal reader parameters only. Keys and the source-host cache path are absent. */
export interface OwnedRemoteBrokerDescriptor {
  directory: string;
  incarnation: string;
  launchDigest: string;
  homeDigest: string;
  keyDigest: string;
  helperDigest: string;
  startupNonce: string;
}
type Entry = {
  epoch: CacheEpoch;
  scope: string;
  material: BrokerProvisioningMaterial;
  descriptor: OwnedRemoteBrokerDescriptor;
  signer?: CodexInputBroker;
};
type CacheEpoch = { id: string; pending: number };
type Preparation = {
  entry: Entry;
  epoch: CacheEpoch;
  file: Stats;
  parents: Stats[];
  bytes: Buffer;
  /** Completed private write that was never handed to a launch caller. */
  unpublished?: boolean;
  unlinked?: boolean;
  removed?: boolean;
};
type CleanupIntent = {
  version: 1 | 2;
  sessionId: string;
  retiredHash: string;
  rootDev: number;
  rootIno: number;
  sessionDev: number;
  sessionIno: number;
  target?: RemoteBrokerCleanupTarget;
};
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const MAX_BYTES = 524_288;
const digest = (input: string) => createHash('sha256').update(input).digest('hex');
const pending = new Map<string, { deadline: number; work: Promise<unknown> }>();
async function bounded<T>(
  key: string,
  operation: () => Promise<T>,
  retained?: (work: Promise<unknown>) => void
): Promise<T | undefined> {
  let job = pending.get(key);
  if (!job) {
    if (pending.size >= 2) return undefined;
    const work = Promise.resolve()
      .then(operation)
      .catch(() => undefined);
    job = { deadline: performance.now() + 2000, work };
    pending.set(key, job);
    void work.finally(() => {
      if (pending.get(key)?.work === work) pending.delete(key);
    });
  }
  retained?.(job.work);
  const budget = job.deadline - performance.now();
  if (budget <= 0) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      job.work,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), budget);
      }),
    ]);
    return performance.now() < job.deadline ? (value as T | undefined) : undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function scopeKey(scope: OwnedRemoteBrokerScope): string | undefined {
  try {
    if (
      !UUID.test(scope.sessionId) ||
      scope.remote.owned === false ||
      !posix.isAbsolute(scope.workingDir) ||
      !posix.isAbsolute(scope.codexHome) ||
      [scope.workingDir, scope.codexHome].some((text) => !text || text.includes('\0') || Buffer.byteLength(text) > 4096)
    )
      return undefined;
    const text = JSON.stringify(scope, (_key, value: unknown) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : value
    );
    return Buffer.byteLength(text) <= 65_536 ? digest(text) : undefined;
  } catch {
    return undefined;
  }
}
function privateStat(value: Stats, directory = false): boolean {
  return (
    !value.isSymbolicLink() &&
    (directory ? value.isDirectory() : value.isFile()) &&
    (value.mode & 0o077) === 0 &&
    (process.getuid === undefined || value.uid === process.getuid())
  );
}
function same(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function validCleanupTarget(value: RemoteBrokerCleanupTarget): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => key === 'remote' || key === 'owner') &&
    (value.owner === undefined || (typeof value.owner === 'string' && /^[\w-]{1,100}$/.test(value.owner))) &&
    !!value.remote &&
    typeof value.remote === 'object' &&
    !Array.isArray(value.remote) &&
    value.remote.owned !== false &&
    ['host', 'hostId', 'username', 'remotePath'].every(
      (key) =>
        typeof value.remote[key as keyof SessionRemote] === 'string' &&
        (value.remote[key as keyof SessionRemote] as string).length > 0
    ) &&
    Buffer.byteLength(JSON.stringify(value)) <= 65536
  );
}
function privateMaterialKeys(value: object): boolean {
  return (
    Object.keys(value).sort().join(',') ===
    ['directory', 'material', 'scope', 'version', ...(Object.hasOwn(value, 'scopeData') ? ['scopeData'] : [])]
      .sort()
      .join(',')
  );
}
function validStoredScope(value: { scope: unknown; scopeData?: OwnedRemoteBrokerScope }, sessionId: string): boolean {
  return (
    value.scopeData === undefined ||
    (value.scopeData?.sessionId === sessionId && scopeKey(value.scopeData) === value.scope)
  );
}
function descriptor(
  scope: { sessionId: string; codexHome?: string },
  material: BrokerProvisioningMaterial,
  directory: string
): OwnedRemoteBrokerDescriptor | undefined {
  try {
    const config = material.config;
    const startup = config.startup;
    if (
      Object.keys(material).sort().join(',') !== 'config,helper' ||
      Object.keys(config).sort().join(',') !==
        'command,homeDigest,incarnation,launchDigest,secret,sessionId,startup,version' ||
      config.version !== 1 ||
      !startup ||
      typeof startup !== 'object' ||
      Array.isArray(startup) ||
      Object.keys(startup).sort().join(',') !==
        [
          'issuer',
          'missingPaths',
          'monotonicDeadline',
          'nonce',
          'privateFiles',
          'privatePaths',
          ...(startup.issuerLease === undefined ? [] : ['issuerLease']),
        ]
          .sort()
          .join(',') ||
      typeof startup.nonce !== 'string' ||
      !UUID.test(startup.nonce) ||
      (startup.monotonicDeadline !== null &&
        (!Number.isSafeInteger(startup.monotonicDeadline) || startup.monotonicDeadline <= 0)) ||
      !Array.isArray(startup.privateFiles) ||
      startup.privateFiles.length > 8 ||
      !Array.isArray(startup.privatePaths) ||
      startup.privatePaths.length > 2048 ||
      !Array.isArray(startup.missingPaths) ||
      startup.missingPaths.length > 64 ||
      (startup.issuer !== null && (typeof startup.issuer !== 'object' || Array.isArray(startup.issuer))) ||
      // This is the pristine source-host template. Remote worker witnesses and
      // the target-clock lease are filled only by the bounded remote reader.
      startup.monotonicDeadline !== null ||
      startup.issuer !== null ||
      startup.issuerLease !== undefined ||
      startup.privateFiles.length !== 0 ||
      startup.privatePaths.length !== 0 ||
      startup.missingPaths.length !== 0 ||
      typeof config.command !== 'string' ||
      !config.command ||
      config.command.includes('\0') ||
      Buffer.from(config.command).toString('utf8') !== config.command ||
      Buffer.byteLength(config.command) > 65536 ||
      material.helper !== CODEX_INPUT_BROKER_SOURCE ||
      config.sessionId !== scope.sessionId ||
      typeof config.incarnation !== 'string' ||
      typeof config.secret !== 'string' ||
      !UUID.test(config.incarnation) ||
      !/^[a-f0-9]{64}$/.test(config.secret) ||
      config.launchDigest !== digest(config.command) ||
      !/^[a-f0-9]{64}$/.test(config.homeDigest) ||
      (scope.codexHome !== undefined && config.homeDigest !== digest(scope.codexHome)) ||
      !posix.isAbsolute(directory) ||
      posix.normalize(directory) !== directory ||
      Buffer.byteLength(directory) > 4096 ||
      Array.from(directory).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
      !directory.endsWith('/' + scope.sessionId + '/' + config.incarnation)
    )
      return undefined;
    return {
      directory,
      incarnation: config.incarnation,
      launchDigest: config.launchDigest,
      homeDigest: config.homeDigest,
      keyDigest: digest(config.secret),
      helperDigest: digest(material.helper),
      startupNonce: config.startup.nonce,
    };
  } catch {
    return undefined;
  }
}

export class OwnedRemoteBrokerCache {
  private readonly entries = new Map<string, Entry>();
  private readonly scopes = new Map<string, string>();
  private readonly epochs = new Map<string, CacheEpoch>();
  private readonly deletions = new Map<string, object>();
  private readonly preparations = new WeakMap<OwnedRemoteBrokerDescriptor, Preparation>();
  private readonly canceledPreparations = new Map<string, OwnedRemoteBrokerDescriptor>();
  private readonly preparingReceipts = new WeakSet<OwnedRemoteBrokerDescriptor>();
  constructor(
    private readonly root = join(getDataDirPath(), 'remote-input-brokers'),
    private readonly remoteCleanup?: typeof cleanupRemoteBroker
  ) {}
  private begin(sessionId: string): CacheEpoch {
    let epoch = this.epochs.get(sessionId);
    if (!epoch) {
      epoch = { id: randomUUID(), pending: 0 };
      this.epochs.set(sessionId, epoch);
    }
    epoch.pending++;
    return epoch;
  }
  private finish(sessionId: string, epoch: CacheEpoch): void {
    epoch.pending--;
    if (this.epochs.get(sessionId) === epoch && epoch.pending === 0 && !this.scopes.has(sessionId))
      this.epochs.delete(sessionId);
  }
  /** Revoke memory immediately; detach/restorable callers must not retire authority. */
  retire(sessionId: string): void {
    this.epochs.delete(sessionId);
    this.scopes.delete(sessionId);
    // Failed unpublished writes retain their exact rollback receipt even if
    // retirement occurs while the filesystem job is still running.
    for (const [key, receipt] of this.canceledPreparations)
      if (
        key.startsWith(sessionId + ':') &&
        !this.preparations.get(receipt)?.unpublished &&
        !this.preparingReceipts.has(receipt)
      )
        this.canceledPreparations.delete(key);
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(sessionId + ':')) continue;
      entry.signer?.retire();
      this.entries.delete(key);
    }
  }
  private cleanupPath(sessionId: string): string {
    return join(this.root, sessionId + '.cleanup.json');
  }
  private async readCleanupIntent(sessionId: string) {
    const result = await bounded('intent-read:' + this.cleanupPath(sessionId), async () => {
      try {
        return await this.readCleanupIntentNow(sessionId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    });
    if (!result) {
      const error = new Error('Private cleanup intent unavailable') as NodeJS.ErrnoException;
      if (result === null) error.code = 'ENOENT';
      throw error;
    }
    return result;
  }
  private async readCleanupIntentNow(sessionId: string) {
    const path = this.cleanupPath(sessionId);
    const parent = await fs.lstat(this.root);
    if (!privateStat(parent, true)) throw Error('Unknown cleanup directory');
    const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let before: Stats, bytes: Buffer;
    try {
      before = await file.stat();
      if (!privateStat(before) || before.size > MAX_BYTES) throw Error('Unknown cleanup intent');
      bytes = Buffer.alloc(before.size + 1);
      const read = await file.read(bytes, 0, bytes.length, 0);
      if (read.bytesRead !== before.size || !same(before, await file.stat())) throw Error('Changed cleanup intent');
      bytes = bytes.subarray(0, read.bytesRead);
    } finally {
      await file.close();
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value = JSON.parse(text) as CleanupIntent;
    if (
      !value ||
      Object.keys(value).sort().join(',') !==
        [
          'retiredHash',
          'rootDev',
          'rootIno',
          'sessionDev',
          'sessionId',
          'sessionIno',
          'version',
          ...(value.target === undefined ? [] : ['target']),
        ]
          .sort()
          .join(',') ||
      (value.version !== 1 && value.version !== 2) ||
      value.sessionId !== sessionId ||
      !/^[a-f0-9]{64}$/.test(value.retiredHash) ||
      (value.target !== undefined && !validCleanupTarget(value.target)) ||
      ![value.rootDev, value.rootIno, value.sessionDev, value.sessionIno].every(
        (number) => Number.isSafeInteger(number) && number >= 0
      )
    )
      throw Error('Unknown cleanup intent');
    const [after, current] = await Promise.all([fs.lstat(this.root), fs.lstat(path)]);
    if (!privateStat(after, true) || !same(parent, after) || !privateStat(current) || !same(before, current))
      throw Error('Replaced cleanup intent');
    return { value, text, stat: current };
  }
  /** Acknowledge retirement before removing the last owner-visible session record. */
  async stageFinalCleanup(
    sessionId: string,
    retiredState: unknown,
    isCurrent: () => boolean,
    target?: RemoteBrokerCleanupTarget
  ): Promise<void> {
    if (!UUID.test(sessionId)) return;
    const deadline = performance.now() + 2000,
      current = () => performance.now() < deadline && isCurrent() === true;
    const sessionRoot = join(this.root, sessionId);
    const prior = [...pending]
      .filter(([key]) => ['write:', 'read:'].some((prefix) => key.startsWith(prefix + sessionRoot + '/')))
      .map(([, job]) => job.work);
    // Optional cache cleanup must not block unrelated session deletion merely
    // because the shared cache I/O slots are busy.
    if (!prior.length) {
      try {
        await fs.lstat(sessionRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && current()) return;
        throw error;
      }
    }
    const result = await bounded('intent:' + this.root + ':' + sessionId, async () => {
      await Promise.all(prior);
      if (!current()) throw Error('Cancelled cleanup');
      let parents: Stats[];
      try {
        parents = await Promise.all([fs.lstat(this.root), fs.lstat(join(this.root, sessionId))]);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && current()) return true;
        throw error;
      }
      if (parents.some((parent) => !privateStat(parent, true))) throw Error('Unknown cleanup parents');
      const value: CleanupIntent = {
        version: 2,
        sessionId,
        retiredHash: digest(JSON.stringify(retiredState ?? null)),
        rootDev: parents[0].dev,
        rootIno: parents[0].ino,
        sessionDev: parents[1].dev,
        sessionIno: parents[1].ino,
        ...(target === undefined ? {} : { target: structuredClone(target) }),
      };
      if (value.target !== undefined && !validCleanupTarget(value.target)) throw Error('Unknown cleanup target');
      const text = JSON.stringify(value),
        path = this.cleanupPath(sessionId);
      let existing: Awaited<ReturnType<OwnedRemoteBrokerCache['readCleanupIntent']>> | undefined;
      try {
        existing = await this.readCleanupIntent(sessionId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (!current()) throw Error('Cancelled cleanup');
      if (existing && existing.text !== text) throw Error('Different cleanup intent retained');
      const file = await fs.open(
        path,
        existing
          ? constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
          : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        0o600
      );
      let written: Stats;
      try {
        written = await file.stat();
        if (!privateStat(written) || (existing && !same(written, existing.stat)))
          throw Error('Replaced cleanup intent');
        if (!existing) await file.writeFile(text);
        await file.sync();
      } finally {
        await file.close();
      }
      const parent = await fs.open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
      const acknowledged = await this.readCleanupIntent(sessionId);
      const now = await fs.lstat(join(this.root, sessionId));
      if (
        !current() ||
        acknowledged.text !== text ||
        acknowledged.stat.dev !== written.dev ||
        acknowledged.stat.ino !== written.ino ||
        !privateStat(now, true) ||
        now.dev !== value.sessionDev ||
        now.ino !== value.sessionIno ||
        lstatSync(this.root).dev !== value.rootDev ||
        lstatSync(this.root).ino !== value.rootIno
      )
        throw Error('Cleanup acknowledgement changed');
      return true;
    });
    if (result !== true) throw Error('Private broker cleanup intent could not be saved; retry deletion');
  }
  /** A false bounded verdict retains the durable intent for later passes and boots. */
  async finishFinalCleanup(sessionId: string, isCurrent: () => boolean, retiredState?: unknown): Promise<boolean> {
    if (!UUID.test(sessionId)) return true;
    if (isCurrent() !== true) return false;
    this.retire(sessionId);
    const deadline = performance.now() + 2000,
      expectedHash = digest(JSON.stringify(retiredState ?? null));
    return (
      (await bounded('intent-finish:' + this.root + ':' + sessionId, () =>
        this.finishFinalCleanupNow(sessionId, () => performance.now() < deadline && isCurrent() === true, expectedHash)
      )) === true
    );
  }
  private async finishFinalCleanupNow(
    sessionId: string,
    isCurrent: () => boolean,
    expectedHash: string
  ): Promise<boolean> {
    let intent: Awaited<ReturnType<OwnedRemoteBrokerCache['readCleanupIntent']>>;
    try {
      intent = await this.readCleanupIntent(sessionId);
    } catch {
      return false;
    }
    if (intent.value.retiredHash !== expectedHash) return false;
    // Legacy SSH intents allowed discarding the last incarnation before remote
    // parent retirement. Their empty/absent source path cannot certify that ACK.
    if (intent.value.version === 1 && intent.value.target) return false;
    const sessionRoot = join(this.root, sessionId);
    const current = () => {
      try {
        const root = lstatSync(this.root),
          marker = lstatSync(this.cleanupPath(sessionId));
        return (
          isCurrent() === true &&
          privateStat(root, true) &&
          root.dev === intent.value.rootDev &&
          root.ino === intent.value.rootIno &&
          privateStat(marker) &&
          same(marker, intent.stat)
        );
      } catch {
        return false;
      }
    };
    const sessionCurrent = () => {
      try {
        const session = lstatSync(sessionRoot);
        return (
          current() &&
          privateStat(session, true) &&
          session.dev === intent.value.sessionDev &&
          session.ino === intent.value.sessionIno
        );
      } catch {
        return false;
      }
    };
    const absent = () => {
      try {
        lstatSync(sessionRoot);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT';
      }
    };
    // The absent-parent retry must drain late cache I/O too: a timed-out
    // preparation can otherwise recreate private material after marker ACK.
    await Promise.all(
      [...pending]
        .filter(([key]) => ['write:', 'read:'].some((prefix) => key.startsWith(prefix + sessionRoot + '/')))
        .map(([, job]) => job.work)
    );
    if (!current()) return false;
    if (!absent()) {
      if (!sessionCurrent() || !(await this.retireAndDelete(sessionId, sessionCurrent, intent.value.target)))
        return false;
      // The nonrecursive remove itself vetoes new/foreign entries. A replacement
      // empty directory cannot inherit the original intent's inode authority.
      if (!sessionCurrent()) return false;
      try {
        await fs.rmdir(sessionRoot);
      } catch {
        return false;
      }
    }
    // Retry an already-removed parent after a lost fsync/ACK, without requiring
    // that inode to exist again or adopting a new directory at the same path.
    const root = await fs.open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await root.sync();
    } finally {
      await root.close();
    }
    const acknowledged = await this.readCleanupIntent(sessionId);
    if (!current() || !absent() || !same(acknowledged.stat, intent.stat) || acknowledged.text !== intent.text)
      return false;
    await fs.unlink(this.cleanupPath(sessionId));
    const parent = await fs.open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    return true;
  }
  /** Each pass is bounded and retains its cursor and private remote retry material. */
  startFinalCleanupRetries(read: (id: string) => { live: boolean; state?: unknown }): () => Promise<void> {
    let stopped = false,
      scan: Dir | undefined,
      work: Promise<void> | undefined;
    const run = () => {
      if (stopped || work) return;
      const deadline = performance.now() + 2000,
        current = () => !stopped && performance.now() < deadline;
      work = (async () => {
        try {
          if (!scan) scan = await fs.opendir(this.root);
          for (let count = 0; count < 128 && current(); count++) {
            const item = await scan.read();
            if (!item) {
              await scan.close();
              scan = undefined;
              break;
            }
            const id = item.name.replace(/\.cleanup\.json$/, '');
            if (!item.name.endsWith('.cleanup.json') || !UUID.test(id) || !item.isFile() || item.isSymbolicLink())
              continue;
            try {
              const intent = await this.readCleanupIntent(id);
              await this.finishFinalCleanup(
                id,
                () => {
                  const now = read(id);
                  return (
                    current() &&
                    now.live === false &&
                    digest(JSON.stringify(now.state ?? null)) === intent.value.retiredHash
                  );
                },
                read(id).state
              );
            } catch {
              // Unknown/changed authority or material remains private for another pass.
            }
          }
        } catch {
          await scan?.close().catch(() => {});
          scan = undefined;
        }
      })().finally(() => {
        work = undefined;
      });
    };
    const timer = setInterval(run, 15_000);
    timer.unref();
    run();
    return async () => {
      stopped = true;
      clearInterval(timer);
      await work;
      await scan?.close().catch(() => {});
      scan = undefined;
    };
  }
  /** Final owner deletion only. Unknown files remain private and are never recursively removed. */
  async retireAndDelete(
    sessionId: string,
    isCurrent: () => boolean,
    target?: RemoteBrokerCleanupTarget
  ): Promise<boolean> {
    const callerCurrent = () => {
      try {
        const verdict: unknown = isCurrent();
        if (verdict && typeof (verdict as { then?: unknown }).then === 'function')
          void Promise.resolve(verdict).catch(() => {});
        return verdict === true;
      } catch {
        return false;
      }
    };
    if (!UUID.test(sessionId) || !callerCurrent() || this.deletions.has(sessionId)) return false;
    this.retire(sessionId);
    const token = {};
    this.deletions.set(sessionId, token);
    const deadline = performance.now() + 2000;
    const current = () => performance.now() < deadline && this.deletions.get(sessionId) === token && callerCurrent();
    const sessionRoot = join(this.root, sessionId);
    // A timed-out write still owns its filesystem slot. Wait its actual close,
    // rather than deleting before a late write can publish the secret again.
    const prior = [...pending]
      .filter(([key]) => ['write:', 'read:'].some((prefix) => key.startsWith(prefix + sessionRoot + '/')))
      .map(([, job]) => job.work);
    let retained = false;
    try {
      return (
        (await bounded(
          'delete:' + sessionRoot + ':' + randomUUID(),
          async () => {
            await Promise.all(prior);
            if (!current()) return false;
            const parents = [await fs.lstat(this.root), await fs.lstat(sessionRoot)];
            if (parents.some((stat) => !privateStat(stat, true))) return false;
            const directory = await fs.opendir(sessionRoot);
            let complete = true,
              count = 0;
            try {
              for await (const item of directory) {
                if (++count > 128) return false;
                if (!current()) return false;
                if (!UUID.test(item.name) || !item.isDirectory() || item.isSymbolicLink()) {
                  complete = false;
                  continue;
                }
                const dirs = this.directories(sessionId, item.name);
                const path = join(dirs[2], 'private.json');
                try {
                  const beforeParents = await Promise.all(dirs.map((path) => fs.lstat(path)));
                  if (
                    beforeParents.some((stat) => !privateStat(stat, true)) ||
                    beforeParents.slice(0, 2).some((stat, index) => !same(stat, parents[index]))
                  )
                    return false;
                  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
                  let before: Stats, bytes: Buffer;
                  try {
                    before = await file.stat();
                    if (!privateStat(before) || before.size > MAX_BYTES) throw Error('Unknown private material');
                    bytes = Buffer.alloc(before.size + 1);
                    const read = await file.read(bytes, 0, bytes.length, 0);
                    if (read.bytesRead !== before.size || !same(before, await file.stat()))
                      throw Error('Changed private material');
                    bytes = bytes.subarray(0, read.bytesRead);
                  } finally {
                    await file.close();
                  }
                  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
                  if (
                    !value ||
                    !privateMaterialKeys(value) ||
                    !validStoredScope(value, sessionId) ||
                    value.version !== 1 ||
                    !/^[a-f0-9]{64}$/.test(value.scope) ||
                    descriptor({ sessionId }, value.material, value.directory)?.incarnation !== item.name
                  )
                    throw Error('Unknown private material');
                  // The local source template is the last exact remote identity
                  // witness. Retain it and the durable intent until remote ACK.
                  let finalSession = true;
                  if (target) {
                    const siblings = await fs.opendir(sessionRoot);
                    try {
                      for (let index = 0; index < 2; index++) {
                        const sibling = await siblings.read();
                        if (!sibling) break;
                        if (sibling.name === item.name) continue;
                        // Only another positively retained incarnation can own
                        // the later parent ACK. Unknown entries must leave this
                        // incarnation's retry material in place instead.
                        if (UUID.test(sibling.name) && sibling.isDirectory() && !sibling.isSymbolicLink()) {
                          const siblingDir = join(sessionRoot, sibling.name),
                            siblingPath = join(siblingDir, 'private.json');
                          let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
                          try {
                            const parent = await fs.lstat(siblingDir);
                            if (!privateStat(parent, true)) break;
                            handle = await fs.open(
                              siblingPath,
                              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
                            );
                            const stat = await handle.stat();
                            if (!privateStat(stat) || stat.size > MAX_BYTES) break;
                            const bytes = Buffer.alloc(stat.size + 1),
                              read = await handle.read(bytes, 0, bytes.length, 0);
                            if (read.bytesRead !== stat.size || !same(stat, await handle.stat())) break;
                            await handle.close();
                            handle = undefined;
                            const candidate = JSON.parse(
                              new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, read.bytesRead))
                            );
                            finalSession = !(
                              candidate &&
                              privateMaterialKeys(candidate) &&
                              candidate.version === 1 &&
                              candidate.scope === value.scope &&
                              !!candidate.scopeData &&
                              validStoredScope(candidate, sessionId) &&
                              posix.dirname(candidate.directory) === posix.dirname(value.directory) &&
                              descriptor({ sessionId }, candidate.material, candidate.directory)?.incarnation ===
                                sibling.name &&
                              same(stat, await fs.lstat(siblingPath)) &&
                              same(parent, await fs.lstat(siblingDir))
                            );
                          } catch {
                            /* Unknown sibling cannot take ownership of final retirement. */
                          } finally {
                            await handle?.close();
                          }
                        }
                        break;
                      }
                    } finally {
                      await siblings.close();
                    }
                  }
                  if (
                    target &&
                    (!value.scopeData ||
                      scopeKey({ ...value.scopeData, remote: target.remote, owner: target.owner }) !== value.scope ||
                      !(await (this.remoteCleanup ?? cleanupRemoteBroker)(
                        target,
                        value.directory,
                        value.material,
                        current,
                        { finalSession }
                      )))
                  ) {
                    complete = false;
                    continue;
                  }
                  // All proof handles have closed before this common final scan.
                  const after = await Promise.all([...dirs, path].map((path) => fs.lstat(path)));
                  if (
                    !current() ||
                    after
                      .slice(0, 3)
                      .some((stat, index) => !privateStat(stat, true) || !same(stat, beforeParents[index])) ||
                    !privateStat(after[3]) ||
                    !same(before, after[3])
                  )
                    return false;
                  await fs.unlink(path);
                  const parent = await fs.open(
                    dirs[2],
                    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
                  );
                  let emptied: Stats;
                  try {
                    await parent.sync();
                    emptied = await parent.stat();
                  } finally {
                    await parent.close();
                  }
                  // A processed incarnation must leave the bounded scan, or
                  // every retry would consume the same first 128 entries.
                  // Only remove the exact proved directory, nonrecursively;
                  // rmdir itself refuses any unknown files left alongside it.
                  const emptyPaths = await Promise.all(dirs.map((path) => fs.lstat(path)));
                  if (
                    !current() ||
                    !privateStat(emptied, true) ||
                    emptied.dev !== beforeParents[2].dev ||
                    emptied.ino !== beforeParents[2].ino ||
                    emptyPaths.some(
                      (stat, index) => !privateStat(stat, true) || !same(stat, index === 2 ? emptied : parents[index])
                    )
                  )
                    return false;
                  await fs.rmdir(dirs[2]);
                  const sessionParent = await fs.open(
                    sessionRoot,
                    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
                  );
                  try {
                    await sessionParent.sync();
                  } finally {
                    await sessionParent.close();
                  }
                  const nextParents = await Promise.all(dirs.slice(0, 2).map((path) => fs.lstat(path)));
                  if (
                    !current() ||
                    nextParents.some((stat) => !privateStat(stat, true)) ||
                    !same(nextParents[0], parents[0]) ||
                    nextParents[1].dev !== parents[1].dev ||
                    nextParents[1].ino !== parents[1].ino
                  )
                    return false;
                  // Our rmdir changes the session directory's timestamps and
                  // size, but cannot authorize a replacement parent inode.
                  parents[1] = nextParents[1];
                } catch {
                  complete = false;
                }
              }
            } finally {
              await directory.close().catch((error: NodeJS.ErrnoException) => {
                if (error.code !== 'ERR_DIR_CLOSED') throw error;
              });
            }
            return current() && complete;
          },
          (work) => {
            retained = true;
            void work.finally(() => {
              if (this.deletions.get(sessionId) === token) this.deletions.delete(sessionId);
            });
          }
        )) === true
      );
    } finally {
      if (!retained && this.deletions.get(sessionId) === token) this.deletions.delete(sessionId);
    }
  }
  private directories(sessionId: string, incarnation: string): string[] {
    return [this.root, join(this.root, sessionId), join(this.root, sessionId, incarnation)];
  }
  /** Caller certifies no reservation/remote dispatch was attempted for this exact prepare receipt. */
  async discardUnreservedPreparation(
    scope: OwnedRemoteBrokerScope,
    receipt: OwnedRemoteBrokerDescriptor
  ): Promise<boolean> {
    const prepared = this.preparations.get(receipt),
      key = scope.sessionId + ':' + receipt.incarnation;
    const current = () =>
      !!prepared &&
      !this.deletions.has(scope.sessionId) &&
      (prepared.unpublished
        ? this.canceledPreparations.get(key) === receipt && !this.entries.has(key)
        : this.epochs.get(scope.sessionId) === prepared.epoch && this.entries.get(key) === prepared.entry) &&
      prepared.entry.epoch === prepared.epoch &&
      prepared.entry.scope === scopeKey(scope) &&
      !prepared.entry.signer &&
      Object.keys(receipt).length === Object.keys(prepared.entry.descriptor).length &&
      Object.entries(prepared.entry.descriptor).every(
        ([field, value]) => receipt[field as keyof OwnedRemoteBrokerDescriptor] === value
      );
    if (!prepared || !current()) return false;
    this.canceledPreparations.set(key, receipt);
    const dirs = this.directories(scope.sessionId, receipt.incarnation),
      path = join(dirs[2], 'private.json'),
      expected = prepared.bytes,
      deadline = performance.now() + 2000,
      check = () => current() && performance.now() < deadline;
    const finish = async () => {
      const parent = await fs.open(dirs[1], constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
      const finalParents = dirs.slice(0, 2).map((path) => lstatSync(path));
      if (
        !check() ||
        finalParents.some(
          (stat, index) =>
            !privateStat(stat, true) ||
            stat.dev !== prepared.parents[index].dev ||
            stat.ino !== prepared.parents[index].ino
        )
      )
        return false;
      try {
        lstatSync(path);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      }
      if (this.entries.get(key) === prepared.entry) this.entries.delete(key);
      this.canceledPreparations.delete(key);
      this.preparations.delete(receipt);
      if (
        this.epochs.get(scope.sessionId) === prepared.epoch &&
        ![...this.entries.keys()].some((entry) => entry.startsWith(scope.sessionId + ':'))
      ) {
        this.scopes.delete(scope.sessionId);
        if (prepared.epoch.pending === 0) this.epochs.delete(scope.sessionId);
      }
      return true;
    };
    return (
      (await bounded('discard:' + path, async () => {
        if (prepared.removed) return finish();
        const parents = await Promise.all(dirs.map((path) => fs.lstat(path)));
        if (
          !check() ||
          parents.some(
            (stat, index) =>
              !privateStat(stat, true) ||
              stat.dev !== prepared.parents[index].dev ||
              stat.ino !== prepared.parents[index].ino
          )
        )
          return false;
        if (!prepared.unlinked) {
          const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const stat = await file.stat();
            if (!privateStat(stat) || !same(stat, prepared.file) || stat.size !== expected.length) return false;
            const bytes = Buffer.alloc(stat.size + 1),
              read = await file.read(bytes, 0, bytes.length, 0);
            if (
              read.bytesRead !== stat.size ||
              !bytes.subarray(0, read.bytesRead).equals(expected) ||
              !same(stat, await file.stat())
            )
              return false;
          } finally {
            await file.close();
          }
          const after = await Promise.all([...dirs, path].map((path) => fs.lstat(path)));
          if (
            !check() ||
            after.slice(0, 3).some((stat, index) => !privateStat(stat, true) || !same(stat, parents[index])) ||
            !privateStat(after[3]) ||
            !same(after[3], prepared.file)
          )
            return false;
          await fs.unlink(path);
          prepared.unlinked = true;
        }
        const directory = await fs.open(dirs[2], constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        let empty: Stats;
        try {
          await directory.sync();
          empty = await directory.stat();
        } finally {
          await directory.close();
        }
        const after = await Promise.all(dirs.map((path) => fs.lstat(path)));
        if (
          !check() ||
          !privateStat(empty, true) ||
          empty.dev !== prepared.parents[2].dev ||
          empty.ino !== prepared.parents[2].ino ||
          after.some((stat, index) => !privateStat(stat, true) || !same(stat, index === 2 ? empty : parents[index]))
        )
          return false;
        // No recursive removal: unrelated artifacts always remain intact.
        try {
          await fs.rmdir(dirs[2]);
          prepared.removed = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOTEMPTY') return false;
          throw error;
        }
        return finish();
      })) === true
    );
  }
  /** Reservation/dispatch permanently ends local known-unsent rollback authority. */
  sealPreparation(receipt: OwnedRemoteBrokerDescriptor): void {
    this.preparations.delete(receipt);
  }
  /** O_EXCL only, after missing/inert remote provisioning and before any broker child launch. */
  async prepare(
    scope: OwnedRemoteBrokerScope,
    material: BrokerProvisioningMaterial,
    directory: string
  ): Promise<OwnedRemoteBrokerDescriptor | undefined> {
    for (const [key, receipt] of this.canceledPreparations)
      if (key.startsWith(scope.sessionId + ':')) await this.discardUnreservedPreparation(scope, receipt);
    const key = scopeKey(scope);
    if (this.deletions.has(scope.sessionId)) return undefined;
    const proof = descriptor(scope, material, directory);
    if (!key || !proof) return undefined;
    let copied: BrokerProvisioningMaterial, bytes: Buffer;
    try {
      copied = structuredClone(material);
      bytes = Buffer.from(
        JSON.stringify({ version: 1, scope: key, directory, material: copied, scopeData: structuredClone(scope) })
      );
    } catch {
      return undefined;
    }
    const entryKey = scope.sessionId + ':' + proof.incarnation;
    const prior = this.entries.get(entryKey);
    if (
      bytes.length > MAX_BYTES ||
      prior ||
      this.canceledPreparations.has(entryKey) ||
      (this.scopes.has(scope.sessionId) && this.scopes.get(scope.sessionId) !== key) ||
      [...new Set([...this.entries.keys(), ...this.canceledPreparations.keys()])].filter((entry) =>
        entry.startsWith(scope.sessionId + ':')
      ).length >= 2
    )
      return undefined;
    const dirs = this.directories(scope.sessionId, copied.config.incarnation);
    const file = join(dirs[2], 'private.json');
    const sessionId = scope.sessionId;
    const epoch = this.begin(sessionId);
    const receipt = { ...proof },
      entry: Entry = { epoch, scope: key, material: copied, descriptor: proof },
      originalScope = structuredClone(scope);
    let retained: Promise<unknown> | undefined,
      published = false;
    let ownedFile: Stats | undefined;
    let rollbackBytes = bytes;
    const ownedParents: Stats[] = [];
    this.preparingReceipts.add(receipt);
    this.canceledPreparations.set(entryKey, receipt);
    try {
      const prepared = await bounded(
        'write:' + file + ':' + createHash('sha256').update(bytes).digest('hex') + ':' + epoch.id,
        async () => {
          try {
            for (const path of dirs) {
              await fs.mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== 'EEXIST') throw error;
              });
              const parent = await fs.lstat(path);
              if (!privateStat(parent, true)) throw new Error('Private remote cache unavailable');
              ownedParents.push(parent);
            }
            const handle = await fs.open(
              file,
              constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
              0o600
            );
            let writeCompleted = false;
            try {
              ownedFile = await handle.stat();
              await handle.writeFile(bytes);
              writeCompleted = true;
              await handle.sync();
            } finally {
              try {
                ownedFile = await handle.stat();
                if (!writeCompleted && privateStat(ownedFile) && ownedFile.size <= bytes.length) {
                  // A failed write may have left only a prefix. Capture it from
                  // our still-open O_EXCL descriptor, never from a replacement
                  // pathname, so the usual exact rollback proof can remove it.
                  const partial = Buffer.alloc(ownedFile.size + 1);
                  const read = await handle.read(partial, 0, partial.length, 0);
                  if (
                    read.bytesRead === ownedFile.size &&
                    same(ownedFile, await handle.stat()) &&
                    partial.subarray(0, read.bytesRead).equals(bytes.subarray(0, read.bytesRead))
                  )
                    rollbackBytes = partial.subarray(0, read.bytesRead);
                }
              } finally {
                await handle.close();
              }
            }
            for (const path of dirs.slice().reverse()) {
              const handle = await fs.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
              try {
                await handle.sync();
              } finally {
                await handle.close();
              }
            }
            return true;
          } finally {
            // The actual job owns this receipt, including when bounded() has
            // already returned. It can only remove its exact, unused artifact.
            if (ownedFile && ownedParents.length === 3) {
              this.preparations.set(receipt, {
                entry,
                epoch,
                file: ownedFile!,
                parents: ownedParents,
                bytes: rollbackBytes,
                unpublished: true,
              });
              this.canceledPreparations.set(entryKey, receipt);
            } else if (this.canceledPreparations.get(entryKey) === receipt) {
              this.canceledPreparations.delete(entryKey);
            }
            this.preparingReceipts.delete(receipt);
          }
        },
        (work) => {
          retained = work;
        }
      );
      if (
        prepared !== true ||
        this.epochs.get(scope.sessionId) !== epoch ||
        scopeKey(scope) !== key ||
        this.entries.get(entryKey) !== prior ||
        (this.scopes.has(scope.sessionId) && this.scopes.get(scope.sessionId) !== key)
      )
        return undefined;
      this.scopes.set(scope.sessionId, key);
      this.entries.set(entryKey, entry);
      this.preparations.get(receipt)!.unpublished = false;
      this.canceledPreparations.delete(entryKey);
      published = true;
      return receipt;
    } finally {
      if (retained)
        void retained
          .finally(async () => {
            try {
              if (!published) await this.discardUnreservedPreparation(originalScope, receipt);
            } finally {
              this.finish(sessionId, epoch);
            }
          })
          .catch(() => {});
      else {
        this.preparingReceipts.delete(receipt);
        if (this.canceledPreparations.get(entryKey) === receipt) this.canceledPreparations.delete(entryKey);
        this.finish(sessionId, epoch);
      }
    }
  }
  /** Reads only locally retained launch material; an existing remote pane cannot create this record. */
  async load(scope: OwnedRemoteBrokerScope, incarnation: string): Promise<OwnedRemoteBrokerDescriptor | undefined> {
    if (this.canceledPreparations.has(scope.sessionId + ':' + incarnation)) return undefined;
    if (this.deletions.has(scope.sessionId)) return undefined;
    const key = scopeKey(scope);
    if (!key || !UUID.test(incarnation)) return undefined;
    if (this.scopes.has(scope.sessionId) && this.scopes.get(scope.sessionId) !== key) return undefined;
    const entryKey = scope.sessionId + ':' + incarnation;
    const known = this.entries.get(entryKey);
    if (known)
      return known.scope === key && known.descriptor.incarnation === incarnation ? { ...known.descriptor } : undefined;
    const dirs = this.directories(scope.sessionId, incarnation);
    const file = join(dirs[2], 'private.json');
    const sessionId = scope.sessionId;
    const epoch = this.begin(sessionId);
    try {
      const value = await bounded('read:' + file + ':' + key + ':' + epoch.id, async () => {
        const parents: Stats[] = [];
        for (const path of dirs) parents.push(await fs.lstat(path));
        if (parents.some((value) => !privateStat(value, true))) throw new Error('Private remote cache unavailable');
        const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let before: Stats, bytes: Buffer;
        try {
          before = await handle.stat();
          if (!privateStat(before) || before.size > MAX_BYTES) throw new Error('Private remote cache unavailable');
          bytes = Buffer.alloc(before.size + 1);
          const read = await handle.read(bytes, 0, bytes.length, 0);
          if (read.bytesRead !== before.size || !same(before, await handle.stat()))
            throw new Error('Private remote cache changed');
          bytes = bytes.subarray(0, read.bytesRead);
        } finally {
          await handle.close();
        }
        const current = await fs.lstat(file);
        if (!privateStat(current) || !same(before, current)) throw new Error('Private remote cache replaced');
        const after: Stats[] = [];
        for (const path of dirs) after.push(await fs.lstat(path));
        if (after.some((value, index) => !privateStat(value, true) || !same(value, parents[index])))
          throw new Error('Private remote cache parent changed');
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as {
          version: unknown;
          scope: unknown;
          directory: string;
          material: BrokerProvisioningMaterial;
          scopeData?: OwnedRemoteBrokerScope;
        };
      });
      if (
        !value ||
        this.epochs.get(scope.sessionId) !== epoch ||
        !privateMaterialKeys(value) ||
        !validStoredScope(value, sessionId) ||
        value.version !== 1 ||
        value.scope !== key ||
        scopeKey(scope) !== key
      )
        return undefined;
      const proof = descriptor(scope, value.material, value.directory);
      if (!proof || proof.incarnation !== incarnation) return undefined;
      // Another concurrent same-scope load may already have minted owner frames.
      if (this.scopes.has(scope.sessionId) && this.scopes.get(scope.sessionId) !== key) return undefined;
      if (!this.entries.has(entryKey)) {
        if ([...this.entries.keys()].filter((entry) => entry.startsWith(scope.sessionId + ':')).length >= 2)
          return undefined;
        this.scopes.set(scope.sessionId, key);
        this.entries.set(entryKey, { epoch, scope: key, descriptor: proof, material: value.material });
      }
      return this.get(scope, incarnation);
    } finally {
      this.finish(sessionId, epoch);
    }
  }
  get(scope: OwnedRemoteBrokerScope, incarnation: string): OwnedRemoteBrokerDescriptor | undefined {
    if (this.canceledPreparations.has(scope.sessionId + ':' + incarnation)) return undefined;
    const entry = this.entries.get(scope.sessionId + ':' + incarnation);
    return entry &&
      this.epochs.get(scope.sessionId) === entry.epoch &&
      entry.scope === scopeKey(scope) &&
      entry.descriptor.incarnation === incarnation
      ? { ...entry.descriptor }
      : undefined;
  }
  signer(scope: OwnedRemoteBrokerScope, incarnation: string): CodexInputBroker | undefined {
    return this.get(scope, incarnation) ? this.entries.get(scope.sessionId + ':' + incarnation)?.signer : undefined;
  }
  /** Called only after the native startup receipt and durable current-incarnation promotion. */
  activate(scope: OwnedRemoteBrokerScope, incarnation: string): boolean {
    if (!this.get(scope, incarnation)) return false;
    // Promotion also retires pending work for superseded incarnations, not just
    // entries already published before this synchronous boundary.
    const epoch = { id: randomUUID(), pending: 0 };
    this.epochs.set(scope.sessionId, epoch);
    this.entries.get(scope.sessionId + ':' + incarnation)!.epoch = epoch;
    for (const key of this.entries.keys())
      if (key.startsWith(scope.sessionId + ':') && key !== scope.sessionId + ':' + incarnation) {
        this.entries.get(key)?.signer?.retire();
        this.entries.delete(key);
      }
    return true;
  }
  observe(
    scope: OwnedRemoteBrokerScope,
    incarnation: string,
    serialized: string,
    witness: PrivateFileWitness,
    panePid: number
  ) {
    if (!this.get(scope, incarnation)) return undefined;
    const entry = this.entries.get(scope.sessionId + ':' + incarnation)!;
    if (!entry.signer) {
      let state: unknown;
      try {
        state = JSON.parse(serialized);
      } catch {
        return undefined;
      }
      const signer = CodexInputBroker.fromRemoteMaterial(entry.descriptor.directory, entry.material, state);
      if (!signer) return undefined;
      const proof = signer.observeRemote(serialized, witness, panePid);
      // Retain witnessed live or certified closed signers. Once retained,
      // failed refreshes never recreate their existing reservation counters.
      if (signer.canFrame || proof) entry.signer = signer;
      return proof;
    }
    return entry.signer.observeRemote(serialized, witness, panePid);
  }
}

/** One signer per retained launch, shared by observation and all owner input paths. */
export const ownedRemoteBrokerCache = new OwnedRemoteBrokerCache();
