/** Private source-host material for controlled owned-SSH launches; never remote adoption. */
import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import { join, posix } from 'node:path';
import { getDataDirPath } from '../config/instance.js';
import type { SessionRemote } from '../types.js';
import { CodexInputBroker, type BrokerProvisioningMaterial } from './codex-input-broker.js';
import { CODEX_INPUT_BROKER_SOURCE } from './codex-input-broker-source.js';
import type { PrivateFileWitness } from './private-file-witness.js';

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
  scope: string;
  material: BrokerProvisioningMaterial;
  descriptor: OwnedRemoteBrokerDescriptor;
  signer?: CodexInputBroker;
};
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const MAX_BYTES = 524_288;
const digest = (input: string) => createHash('sha256').update(input).digest('hex');
const pending = new Map<string, { deadline: number; work: Promise<unknown> }>();
async function bounded<T>(key: string, operation: () => Promise<T>): Promise<T | undefined> {
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
function descriptor(
  scope: OwnedRemoteBrokerScope,
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
      config.homeDigest !== digest(scope.codexHome) ||
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
  constructor(private readonly root = join(getDataDirPath(), 'remote-input-brokers')) {}
  private directories(sessionId: string, incarnation: string): string[] {
    return [this.root, join(this.root, sessionId), join(this.root, sessionId, incarnation)];
  }
  /** O_EXCL only, after missing/inert remote provisioning and before any broker child launch. */
  async prepare(
    scope: OwnedRemoteBrokerScope,
    material: BrokerProvisioningMaterial,
    directory: string
  ): Promise<OwnedRemoteBrokerDescriptor | undefined> {
    const key = scopeKey(scope);
    const proof = descriptor(scope, material, directory);
    if (!key || !proof) return undefined;
    let copied: BrokerProvisioningMaterial, bytes: Buffer;
    try {
      copied = structuredClone(material);
      bytes = Buffer.from(JSON.stringify({ version: 1, scope: key, directory, material: copied }));
    } catch {
      return undefined;
    }
    const entryKey = scope.sessionId + ':' + proof.incarnation;
    const prior = this.entries.get(entryKey);
    if (
      bytes.length > MAX_BYTES ||
      prior ||
      (this.scopes.has(scope.sessionId) && this.scopes.get(scope.sessionId) !== key) ||
      [...this.entries.keys()].filter((entry) => entry.startsWith(scope.sessionId + ':')).length >= 2
    )
      return undefined;
    const dirs = this.directories(scope.sessionId, copied.config.incarnation);
    const file = join(dirs[2], 'private.json');
    const prepared = await bounded(
      'write:' + file + ':' + createHash('sha256').update(bytes).digest('hex'),
      async () => {
        for (const path of dirs) {
          await fs.mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'EEXIST') throw error;
          });
          if (!privateStat(await fs.lstat(path), true)) throw new Error('Private remote cache unavailable');
        }
        const handle = await fs.open(
          file,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600
        );
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
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
      }
    );
    if (
      prepared !== true ||
      scopeKey(scope) !== key ||
      this.entries.get(entryKey) !== prior ||
      (this.scopes.has(scope.sessionId) && this.scopes.get(scope.sessionId) !== key)
    )
      return undefined;
    this.scopes.set(scope.sessionId, key);
    this.entries.set(entryKey, { scope: key, material: copied, descriptor: proof });
    return { ...proof };
  }
  /** Reads only locally retained launch material; an existing remote pane cannot create this record. */
  async load(scope: OwnedRemoteBrokerScope, incarnation: string): Promise<OwnedRemoteBrokerDescriptor | undefined> {
    const key = scopeKey(scope);
    if (!key || !UUID.test(incarnation)) return undefined;
    if (this.scopes.has(scope.sessionId) && this.scopes.get(scope.sessionId) !== key) return undefined;
    const entryKey = scope.sessionId + ':' + incarnation;
    const known = this.entries.get(entryKey);
    if (known)
      return known.scope === key && known.descriptor.incarnation === incarnation ? { ...known.descriptor } : undefined;
    const dirs = this.directories(scope.sessionId, incarnation);
    const file = join(dirs[2], 'private.json');
    const value = await bounded('read:' + file + ':' + key, async () => {
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
      };
    });
    if (
      !value ||
      Object.keys(value).sort().join(',') !== 'directory,material,scope,version' ||
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
      this.entries.set(entryKey, { scope: key, descriptor: proof, material: value.material });
    }
    return this.get(scope, incarnation);
  }
  get(scope: OwnedRemoteBrokerScope, incarnation: string): OwnedRemoteBrokerDescriptor | undefined {
    const entry = this.entries.get(scope.sessionId + ':' + incarnation);
    return entry && entry.scope === scopeKey(scope) && entry.descriptor.incarnation === incarnation
      ? { ...entry.descriptor }
      : undefined;
  }
  signer(scope: OwnedRemoteBrokerScope, incarnation: string): CodexInputBroker | undefined {
    return this.get(scope, incarnation) ? this.entries.get(scope.sessionId + ':' + incarnation)?.signer : undefined;
  }
  /** Called only after the native startup receipt and durable current-incarnation promotion. */
  activate(scope: OwnedRemoteBrokerScope, incarnation: string): boolean {
    if (!this.get(scope, incarnation)) return false;
    for (const key of this.entries.keys())
      if (key.startsWith(scope.sessionId + ':') && key !== scope.sessionId + ':' + incarnation)
        this.entries.delete(key);
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
      // Retain a valid startup signer even when raw taint/closed state makes
      // automation ineligible. Future refreshes never recreate its counters.
      if (signer.canFrame || proof) entry.signer = signer;
      return proof;
    }
    return entry.signer.observeRemote(serialized, witness, panePid);
  }
}

/** One signer per retained launch, shared by observation and all owner input paths. */
export const ownedRemoteBrokerCache = new OwnedRemoteBrokerCache();
