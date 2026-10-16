/** @fileoverview Private launch-owned input provenance. No secret is stored in public session metadata. */
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import { dirname, join, isAbsolute, normalize } from 'node:path';
import { CODEX_INPUT_BROKER_SOURCE } from './codex-input-broker-source.js';
import { z } from 'zod';
import { rollbackCodexBrokerProvisioning, type BrokerProvisioningRollback } from './codex-broker-cleanup.js';
import { parseNativePaneSignal } from './native-pane-signal.js';
import type { CodexIdentityWitness } from './codex-identity.js';
import type { PrivateFileWitness } from './private-file-witness.js';

export type CodexOwnerInputFrame = { status: 'passthrough' | 'framed' | 'refused'; data?: string };
export type BrokerOwnerChannel = 'owner-pty' | 'owner-key' | 'owner-mux';
export type BrokerChannel = BrokerOwnerChannel | 'auto' | 'probe';
export type BrokerReceipt = {
  channel: BrokerChannel;
  counter: number;
  nonce: string;
  conversationId: string;
  hash: string;
  status: 'reserved' | 'sent' | 'not-sent';
  deliveredAt?: { wallBefore: number; wallAfter: number; monoBefore: number; monoAfter: number };
};
export interface CodexBrokerState {
  version: 1;
  sessionId: string;
  incarnation: string;
  pid: number;
  childPid: number;
  brokerStart: string | null;
  childStart: string | null;
  tainted: boolean;
  rawGeneration: number;
  launchDigest: string;
  homeDigest: string;
  closed: boolean;
  exitStatus: number | null;
  exitSignal: number | null;
  counters: Record<BrokerChannel, number>;
  receipts: BrokerReceipt[];
  startup: { nonce: string; status: 'reserved' | 'started' | 'not-sent' };
  /** Read-time bytes and inode proof; deliberately absent from the on-disk schema. */
  fileWitness?: PrivateFileWitness;
}
export interface CodexBrokerProof {
  incarnation: string;
  brokerPid: number;
  childPid: number;
  brokerStart: string | null;
  childStart: string | null;
  closed: boolean;
  exitStatus?: number;
  exitSignal?: number;
  rawGeneration: number;
  launchDigest: string;
  homeDigest: string;
  ownerCounters: Record<BrokerOwnerChannel, number>;
  fileWitness?: PrivateFileWitness;
}
/** Private application-derived issuer scope; never supplied by an HTTP input body. */
export interface BrokerAuthority {
  sessionId: string;
  incarnation: string;
  directory: string;
  proof: CodexBrokerProof;
  files?: readonly PrivateFileWitness[];
  paths?: CodexIdentityWitness['paths'];
}
export interface BrokerConfig {
  version: 1;
  sessionId: string;
  incarnation: string;
  secret: string;
  command: string;
  launchDigest: string;
  homeDigest: string;
  startup: BrokerStartupAuthority;
}
export interface BrokerProvisioningMaterial {
  config: BrokerConfig;
  helper: string;
}
export interface BrokerPrivateEvidence {
  files: readonly PrivateFileWitness[];
  paths: CodexIdentityWitness['paths'];
  missing: readonly string[];
}
export interface BrokerStartupAuthority {
  monotonicDeadline: number | null;
  nonce: string;
  privateFiles: readonly PrivateFileWitness[];
  privatePaths: CodexIdentityWitness['paths'];
  missingPaths: readonly string[];
  issuer: BrokerAuthority | null;
  issuerLease?: BrokerRemoteIssuerLease;
}

/** Signed target-host scope; no source-host pathname is part of this record. */
export interface BrokerRemoteIssuerLease {
  claim: import('./remote-input-broker.js').RemoteWorkerLeaseClaim;
  phaseIndex: number;
  remoteDeadline: number;
  clock: { localAt: number; min: number; max: number };
}

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const OWNER_CHANNELS: BrokerChannel[] = ['owner-pty', 'owner-key', 'owner-mux'];
const CHANNELS: BrokerChannel[] = [...OWNER_CHANNELS, 'auto', 'probe'];
const MAX_FILE = 98_304;
type PrivateRead = { value: unknown; witness: PrivateFileWitness };
const pending = new Map<string, { deadline: number; work: Promise<PrivateRead> }>();

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function privateFile(stat: Stats): boolean {
  return stat.isFile() && (stat.mode & 0o077) === 0 && (process.getuid === undefined || stat.uid === process.getuid());
}
async function readPrivateJson(path: string): Promise<PrivateRead> {
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let closed = false;
  try {
    const before = await handle.stat();
    if (!privateFile(before) || before.size > MAX_FILE) throw new Error('Private input journal unavailable');
    const buffer = Buffer.alloc(before.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== before.size || !sameFile(before, await handle.stat()))
      throw new Error('Private input journal changed');
    await handle.close();
    closed = true;
    const current = await fs.lstat(path);
    if (!privateFile(current) || !sameFile(before, current)) throw new Error('Private input journal replaced');
    return {
      value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))),
      witness: {
        path,
        dev: before.dev,
        ino: before.ino,
        size: before.size,
        mtimeMs: before.mtimeMs,
        ctimeMs: before.ctimeMs,
        hash: createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex'),
        maxBytes: MAX_FILE,
      },
    };
  } finally {
    if (!closed) await handle.close();
  }
}
async function readProcessIdentity(path: string): Promise<PrivateRead> {
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let closed = false;
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('Input process identity unavailable');
    const buffer = Buffer.alloc(8_193);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (!bytesRead || bytesRead > 8_192 || !sameFile(before, await handle.stat()))
      throw new Error('Input process identity changed');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
    const end = text.lastIndexOf(')');
    const fields = text
      .slice(end + 2)
      .trim()
      .split(/\s+/u);
    if (end < 0 || fields.length < 20 || !/^\d{1,24}$/.test(fields[19]) || !/^\d+$/.test(fields[1]))
      throw new Error('Input process identity malformed');
    await handle.close();
    closed = true;
    if (!sameFile(before, await fs.lstat(path))) throw new Error('Input process identity replaced');
    return {
      value: { start: fields[19], status: fields[0], parent: Number(fields[1]) },
      witness: {
        path,
        dev: before.dev,
        ino: before.ino,
        size: before.size,
        mtimeMs: before.mtimeMs,
        ctimeMs: before.ctimeMs,
        hash: '',
        maxBytes: 8_192,
      },
    };
  } finally {
    if (!closed) await handle.close();
  }
}
/** Timed-out reads keep their slot; a stuck filesystem cannot accumulate readers. */
async function boundedRead(path: string, callerDeadline = Infinity, reader = readPrivateJson): Promise<PrivateRead> {
  if (performance.now() >= callerDeadline || Number.isNaN(callerDeadline)) throw new Error('Input journal deadline');
  let job = pending.get(path);
  if (!job) {
    if (pending.size >= 2) throw new Error('Input journal reader occupied');
    job = { deadline: performance.now() + 2_000, work: reader(path) };
    pending.set(path, job);
    void job.work
      .finally(() => {
        if (pending.get(path) === job) pending.delete(path);
      })
      .catch(() => {});
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const remaining = Math.min(job.deadline, callerDeadline) - performance.now();
    if (remaining <= 0) throw new Error('Input journal deadline');
    const result = await Promise.race([
      job.work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Input journal deadline')), remaining);
      }),
    ]);
    if (performance.now() >= Math.min(job.deadline, callerDeadline)) throw new Error('Input journal deadline');
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, names: string[]): boolean {
  return Object.keys(value).sort().join(',') === names.sort().join(',');
}
function counter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function parseState(value: unknown, config: BrokerConfig): CodexBrokerState | undefined {
  if (
    !record(value) ||
    !exact(value, [
      'version',
      'sessionId',
      'incarnation',
      'pid',
      'childPid',
      'brokerStart',
      'childStart',
      'tainted',
      'rawGeneration',
      'launchDigest',
      'homeDigest',
      'closed',
      'exitStatus',
      'exitSignal',
      'counters',
      'receipts',
      'startup',
    ]) ||
    value.version !== 1 ||
    value.sessionId !== config.sessionId ||
    value.incarnation !== config.incarnation ||
    ![value.brokerStart, value.childStart].every(
      (token) => token === null || (typeof token === 'string' && /^\d{1,24}$/.test(token))
    ) ||
    !counter(value.pid) ||
    value.pid <= 0 ||
    !counter(value.childPid) ||
    !record(value.startup) ||
    !exact(value.startup, ['nonce', 'status']) ||
    value.startup.nonce !== config.startup.nonce ||
    !['reserved', 'started', 'not-sent'].includes(value.startup.status as string) ||
    (value.childPid > 0 ? value.startup.status !== 'started' : value.startup.status === 'started') ||
    typeof value.tainted !== 'boolean' ||
    typeof value.closed !== 'boolean' ||
    !record(value.counters) ||
    !counter(value.rawGeneration) ||
    value.tainted !== value.rawGeneration > 0 ||
    value.launchDigest !== config.launchDigest ||
    value.homeDigest !== config.homeDigest ||
    !exact(value.counters, [...CHANNELS]) ||
    !CHANNELS.every((channel) => counter((value.counters as Record<string, unknown>)[channel])) ||
    !Array.isArray(value.receipts) ||
    value.receipts.length > 128 ||
    ![value.exitStatus, value.exitSignal].every((exit) => exit === null || (counter(exit) && exit <= 255)) ||
    (value.exitSignal !== null &&
      (typeof value.exitSignal !== 'number' ||
        value.exitSignal <= 0 ||
        parseNativePaneSignal(String(value.exitSignal)) !== value.exitSignal)) ||
    (value.closed && value.childPid > 0
      ? (value.exitStatus === null) === (value.exitSignal === null)
      : value.exitStatus !== null || value.exitSignal !== null)
  )
    return undefined;
  const counters = value.counters as Record<BrokerChannel, number>;
  const seen = new Set<string>();
  for (const receipt of value.receipts) {
    if (
      !record(receipt) ||
      !exact(receipt, [
        'channel',
        'counter',
        'nonce',
        'conversationId',
        'hash',
        'status',
        ...(receipt.deliveredAt === undefined ? [] : ['deliveredAt']),
      ]) ||
      !CHANNELS.includes(receipt.channel as BrokerChannel) ||
      !counter(receipt.counter) ||
      receipt.counter <= 0 ||
      receipt.counter > counters[receipt.channel as BrokerChannel] ||
      typeof receipt.nonce !== 'string' ||
      !UUID.test(receipt.nonce) ||
      typeof receipt.conversationId !== 'string' ||
      (receipt.channel === 'auto' && !UUID.test(receipt.conversationId)) ||
      typeof receipt.hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(receipt.hash) ||
      !['reserved', 'sent', 'not-sent'].includes(receipt.status as string)
    )
      return undefined;
    if (receipt.deliveredAt !== undefined) {
      const at = receipt.deliveredAt;
      if (
        receipt.channel !== 'auto' ||
        receipt.status !== 'sent' ||
        !record(at) ||
        !exact(at, ['wallBefore', 'wallAfter', 'monoBefore', 'monoAfter']) ||
        ![at.wallBefore, at.wallAfter, at.monoBefore, at.monoAfter].every((v) => counter(v) && v > 0) ||
        Number(at.wallAfter) < Number(at.wallBefore) ||
        Number(at.monoAfter) < Number(at.monoBefore) ||
        Number(at.wallAfter) - Number(at.wallBefore) > 500 ||
        Math.abs(Number(at.wallAfter) - Number(at.wallBefore) - Number(at.monoAfter) + Number(at.monoBefore)) > 100
      )
        return undefined;
    }
    const key = `${receipt.channel}:${receipt.counter}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
  }
  // A channel head can disappear only through eviction from the full retained window.
  const retained = value.receipts as BrokerReceipt[];
  if (
    CHANNELS.some((channel) => {
      const receipts = retained.filter((receipt) => receipt.channel === channel);
      return receipts.length
        ? Math.max(...receipts.map((receipt) => receipt.counter)) !== counters[channel]
        : counters[channel] > 0 && retained.length < 128;
    })
  )
    return undefined;
  return value as unknown as CodexBrokerState;
}

function uniqueFiles(files: readonly PrivateFileWitness[]): PrivateFileWitness[] | undefined {
  const unique = new Map<string, PrivateFileWitness>();
  for (const file of files) {
    const previous = unique.get(file.path);
    if (
      previous &&
      ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'hash', 'maxBytes'].some(
        (key) => previous[key as keyof PrivateFileWitness] !== file[key as keyof PrivateFileWitness]
      )
    )
      return undefined;
    unique.set(file.path, file);
  }
  return unique.size <= 8 ? [...unique.values()] : undefined;
}

const HistoricalFile = z
  .object({
    path: z.string().startsWith('/').max(4_096),
    dev: z.number().finite(),
    ino: z.number().finite(),
    size: z.number().int().nonnegative(),
    mtimeMs: z.number().finite(),
    ctimeMs: z.number().finite(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    maxBytes: z.number().int().nonnegative().max(2_097_152),
  })
  .strict()
  .refine((file) => file.size <= file.maxBytes);
const HistoricalPath = z
  .object({
    path: z.string().startsWith('/').max(4_096),
    kind: z.enum(['file', 'directory']),
    dev: z.number().finite(),
    ino: z.number().finite(),
    size: z.number().int().nonnegative().optional(),
    mtimeMs: z.number().finite().optional(),
    ctimeMs: z.number().finite().optional(),
  })
  .strict();
const HistoricalUuid = z.string().regex(UUID),
  HistoricalDigest = z.string().regex(/^[a-f0-9]{64}$/);
const HistoricalCounter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const HistoricalProof = z
  .object({
    incarnation: HistoricalUuid,
    brokerPid: HistoricalCounter.positive(),
    childPid: HistoricalCounter.positive(),
    brokerStart: z
      .string()
      .regex(/^\d{1,24}$/)
      .nullable(),
    childStart: z
      .string()
      .regex(/^\d{1,24}$/)
      .nullable(),
    closed: z.boolean(),
    exitStatus: z.number().int().min(0).max(255).optional(),
    exitSignal: z.number().int().positive().max(255).optional(),
    rawGeneration: HistoricalCounter,
    launchDigest: HistoricalDigest,
    homeDigest: HistoricalDigest,
    ownerCounters: z
      .object({ 'owner-pty': HistoricalCounter, 'owner-key': HistoricalCounter, 'owner-mux': HistoricalCounter })
      .strict(),
    fileWitness: HistoricalFile,
  })
  .strict();
const HistoricalConfig = z
  .object({
    version: z.literal(1),
    sessionId: HistoricalUuid,
    incarnation: HistoricalUuid,
    secret: HistoricalDigest,
    command: z
      .string()
      .min(1)
      .refine((command) => Buffer.byteLength(command) <= 65_536),
    launchDigest: HistoricalDigest,
    homeDigest: HistoricalDigest,
    startup: z
      .object({
        nonce: HistoricalUuid,
        monotonicDeadline: HistoricalCounter.positive().nullable(),
        privateFiles: z.array(HistoricalFile).max(8),
        privatePaths: z.array(HistoricalPath).max(2_048),
        missingPaths: z.array(z.string().startsWith('/').max(4_096)).max(64),
        issuer: z
          .object({
            sessionId: HistoricalUuid,
            incarnation: HistoricalUuid,
            directory: z.string().startsWith('/').max(4_096),
            proof: HistoricalProof,
            files: z.array(HistoricalFile).max(8).optional(),
            paths: z.array(HistoricalPath).max(2_048).optional(),
          })
          .strict()
          .nullable(),
      })
      .strict(),
  })
  .strict();

export class CodexInputBroker {
  private readonly counters: Record<BrokerChannel, number> = {
    'owner-pty': 0,
    'owner-key': 0,
    'owner-mux': 0,
    auto: 0,
    probe: 0,
  };
  private ready = false;
  private ownerCursorUncertain = false;
  private unlaunchedRollback?: BrokerProvisioningRollback;
  private constructor(
    readonly directory: string,
    private readonly config: BrokerConfig,
    private startupConfigurationDigest = createHash('sha256').update(JSON.stringify(config)).digest('hex')
  ) {}

  /** Private provisioning only: caller must never expose this material in session metadata. */
  static provisioningMaterial(sessionId: string, command: string, codexHome = ''): BrokerProvisioningMaterial {
    if (!UUID.test(sessionId) || !command || Buffer.byteLength(command) > 65_536)
      throw new Error('Invalid broker launch');
    const config: BrokerConfig = {
      version: 1,
      sessionId,
      incarnation: randomUUID(),
      secret: randomBytes(32).toString('hex'),
      command,
      launchDigest: createHash('sha256').update(command).digest('hex'),
      homeDigest: createHash('sha256').update(codexHome).digest('hex'),
      startup: {
        monotonicDeadline: null,
        nonce: randomUUID(),
        privateFiles: [],
        privatePaths: [],
        missingPaths: [],
        issuer: null,
      },
    };
    if (Buffer.byteLength(JSON.stringify(config)) > MAX_FILE) throw new Error('Input configuration oversized');
    return { config, helper: CODEX_INPUT_BROKER_SOURCE };
  }
  /** Remote owner supplies an exact private state read; no local journal adoption or counter reset. */
  static fromRemoteMaterial(
    directory: string,
    material: BrokerProvisioningMaterial,
    value: unknown
  ): CodexInputBroker | undefined {
    if (
      material.helper !== CODEX_INPUT_BROKER_SOURCE ||
      !directory.startsWith('/') ||
      !UUID.test(material.config.sessionId) ||
      !UUID.test(material.config.incarnation) ||
      !/^[a-f0-9]{64}$/.test(material.config.secret) ||
      material.config.launchDigest !== createHash('sha256').update(material.config.command).digest('hex')
    )
      return undefined;
    const config = structuredClone(material.config);
    const state = parseState(value, config);
    if (!state) return undefined;
    const broker = new CodexInputBroker(directory, config);
    Object.assign(broker.counters, state.counters);
    return broker;
  }

  /** Fresh owned-SSH bytes only; caller also attests the remote native/stream/clock boundary. */
  observeRemote(serialized: string, witness: PrivateFileWitness, panePid: number): CodexBrokerProof | undefined {
    this.ready = false;
    try {
      if (
        typeof serialized !== 'string' ||
        Buffer.from(serialized).toString('utf8') !== serialized ||
        !record(witness) ||
        !exact(witness, ['path', 'dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'hash', 'maxBytes']) ||
        witness.path !== join(this.directory, 'state.json') ||
        witness.maxBytes !== MAX_FILE ||
        ![witness.dev, witness.ino, witness.size, witness.mtimeMs, witness.ctimeMs].every(
          (value) => Number.isFinite(value) && value >= 0
        ) ||
        !Number.isSafeInteger(witness.size) ||
        witness.size > MAX_FILE ||
        witness.size !== Buffer.byteLength(serialized) ||
        witness.hash !== createHash('sha256').update(serialized).digest('hex')
      )
        return undefined;
      const state = parseState(JSON.parse(serialized), this.config);
      if (!state || state.pid !== panePid || state.childPid <= 0) return undefined;
      if (OWNER_CHANNELS.some((key) => this.counters[key] < state.counters[key])) this.ownerCursorUncertain = true;
      // Remote probes/actions have their own serialized dispatcher. They cannot
      // roll back locally minted owner reservations during a passive refresh.
      this.counters.auto = Math.max(this.counters.auto, state.counters.auto);
      this.counters.probe = Math.max(this.counters.probe, state.counters.probe);
      const birth = (token: unknown) =>
        typeof token === 'string' && /^[1-9]\d*$/.test(token) && Number.isSafeInteger(Number(token));
      if (
        this.ownerCursorUncertain ||
        state.startup.status !== 'started' ||
        state.tainted ||
        state.rawGeneration !== 0 ||
        state.receipts.some((receipt) => receipt.status === 'reserved') ||
        !birth(state.brokerStart) ||
        !birth(state.childStart)
      )
        return undefined;
      this.ready = !state.closed;
      // Locally reserved owner frames retain FIFO admission, while automation
      // still requires the remote journal to acknowledge every owner counter.
      if (OWNER_CHANNELS.some((key) => this.counters[key] !== state.counters[key])) return undefined;
      return {
        incarnation: state.incarnation,
        brokerPid: state.pid,
        childPid: state.childPid,
        brokerStart: state.brokerStart,
        childStart: state.childStart,
        closed: state.closed,
        ...(state.exitStatus === null ? {} : { exitStatus: state.exitStatus }),
        ...(state.exitSignal === null ? {} : { exitSignal: state.exitSignal }),
        rawGeneration: state.rawGeneration,
        launchDigest: state.launchDigest,
        homeDigest: state.homeDigest,
        ownerCounters: {
          'owner-pty': state.counters['owner-pty'],
          'owner-key': state.counters['owner-key'],
          'owner-mux': state.counters['owner-mux'],
        },
        fileWitness: { ...witness },
      };
    } catch {
      return undefined;
    }
  }
  /** durableParent is an existing canonical private creation boundary, never discovered after mkdir. */
  static async create(
    root: string,
    sessionId: string,
    command: string,
    codexHome = '',
    durableParent = dirname(root)
  ): Promise<CodexInputBroker> {
    if (!UUID.test(sessionId) || !command || Buffer.byteLength(command) > 65_536)
      throw new Error('Invalid broker launch');
    const { config } = CodexInputBroker.provisioningMaterial(sessionId, command, codexHome);
    const serialized = JSON.stringify(config);
    if (
      !isAbsolute(root) ||
      normalize(root) !== root ||
      root.includes('\0') ||
      !isAbsolute(durableParent) ||
      normalize(durableParent) !== durableParent ||
      durableParent === '/' ||
      !root.startsWith(`${durableParent}/`) ||
      (await fs.realpath(durableParent)) !== durableParent
    )
      throw new Error('Broker parent durability boundary is unverified');
    const parents: string[] = [];
    for (let path = root; ; path = dirname(path)) {
      parents.push(path);
      if (path === durableParent) break;
      if (parents.length >= 32) throw new Error('Broker parent durability boundary is too deep');
    }
    await fs.mkdir(root, { mode: 0o700, recursive: true });
    const parentProof: BrokerProvisioningRollback['parents'] = [];
    for (const path of parents) {
      const stat = await fs.lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Broker parent is not a private directory');
      parentProof.push({ path, dev: stat.dev, ino: stat.ino });
    }
    const directory = join(root, config.incarnation);
    await fs.mkdir(directory, { mode: 0o700 });
    const created = await fs.lstat(directory);
    const rollback: BrokerProvisioningRollback = {
      root,
      sessionId,
      incarnation: config.incarnation,
      directory: { dev: created.dev, ino: created.ino },
      parents: parentProof,
      files: [],
    };
    try {
      for (const [name, content] of [
        ['broker.py', CODEX_INPUT_BROKER_SOURCE],
        ['config.json', serialized],
        ['lock', ''],
      ]) {
        const handle = await fs.open(join(directory, name), 'wx', 0o600);
        try {
          const before = await handle.stat();
          await handle.writeFile(content);
          const after = await handle.stat();
          if (
            !privateFile(before) ||
            !privateFile(after) ||
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            after.size !== Buffer.byteLength(content)
          )
            throw new Error('Broker private creation changed');
          rollback.files.push({
            name,
            dev: after.dev,
            ino: after.ino,
            size: after.size,
            hash: createHash('sha256').update(content).digest('hex'),
          });
        } finally {
          await handle.close();
        }
      }
      const syncPaths = [
        join(directory, 'broker.py'),
        join(directory, 'config.json'),
        join(directory, 'lock'),
        directory,
        root,
      ];
      // Always acknowledge the bounded chain, including after a previous attempt
      // created directories but failed before their parent entries were durable.
      syncPaths.push(...parents.slice(1));
      for (const path of syncPaths) {
        const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
    } catch (error) {
      // No caller has received this broker or its launch command. Unknown files,
      // changed ownership, a runtime journal or a held lease prevent rollback.
      await rollbackCodexBrokerProvisioning(rollback).catch(() => {});
      throw error;
    }
    const broker = new CodexInputBroker(directory, config);
    broker.unlaunchedRollback = rollback;
    return broker;
  }
  /** Caller must certify that no native broker dispatch was attempted. */
  async rollbackUnlaunchedProvisioning(): Promise<void> {
    const receipt = this.unlaunchedRollback;
    this.unlaunchedRollback = undefined;
    if (receipt) await rollbackCodexBrokerProvisioning(receipt).catch(() => {});
  }
  static async load(
    directory: string,
    sessionId: string,
    deadline = performance.now() + 2_000
  ): Promise<CodexInputBroker | undefined> {
    try {
      const { value, witness } = await boundedRead(join(directory, 'config.json'), deadline);
      if (
        !record(value) ||
        !exact(value, [
          'version',
          'sessionId',
          'incarnation',
          'secret',
          'command',
          'launchDigest',
          'homeDigest',
          'startup',
        ]) ||
        value.version !== 1 ||
        value.sessionId !== sessionId ||
        typeof value.incarnation !== 'string' ||
        !UUID.test(value.incarnation) ||
        typeof value.secret !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.secret) ||
        typeof value.command !== 'string' ||
        !value.command ||
        Buffer.byteLength(value.command) > 65_536 ||
        value.launchDigest !== createHash('sha256').update(value.command).digest('hex') ||
        typeof value.homeDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.homeDigest) ||
        !record(value.startup) ||
        !exact(value.startup, [
          'monotonicDeadline',
          'nonce',
          'privateFiles',
          'privatePaths',
          'missingPaths',
          'issuer',
          ...(value.startup.issuerLease === undefined ? [] : ['issuerLease']),
        ]) ||
        typeof value.startup.nonce !== 'string' ||
        !UUID.test(value.startup.nonce) ||
        !Array.isArray(value.startup.privateFiles) ||
        value.startup.privateFiles.length > 8
      )
        return undefined;
      const broker = new CodexInputBroker(directory, value as unknown as BrokerConfig, witness.hash);
      const state = await broker.readState(deadline);
      if (!state) return undefined;
      Object.assign(broker.counters, state.counters);
      return broker;
    } catch {
      return undefined;
    }
  }
  /** Historical input proof only: never probes a pane or treats PID liveness as reboot authority. */
  static async inspectHistoricalEvidence(
    directory: string,
    sessionId: string,
    incarnation: string,
    codexHome: string,
    originalDeadline = Infinity
  ): Promise<BrokerPrivateEvidence | undefined> {
    const deadline = Math.min(performance.now() + 2_000, originalDeadline);
    if (!Number.isFinite(deadline) || performance.now() >= deadline) return undefined;
    try {
      const configInput = await boundedRead(join(directory, 'config.json'), deadline);
      if (!HistoricalConfig.safeParse(configInput.value).success) return undefined;
      const broker = await CodexInputBroker.load(directory, sessionId, deadline);
      if (
        !broker ||
        broker.incarnation !== incarnation ||
        broker.config.homeDigest !== createHash('sha256').update(codexHome).digest('hex') ||
        JSON.stringify(configInput.value) !== JSON.stringify(broker.config)
      )
        return undefined;
      const state = await broker.readState(deadline);
      if (
        !state ||
        !state.fileWitness ||
        state.tainted ||
        state.rawGeneration !== 0 ||
        state.startup.status !== 'started' ||
        state.childPid <= 0 ||
        (state.closed && state.exitStatus === 0) ||
        state.receipts.some((receipt) => receipt.status === 'reserved')
      )
        return undefined;
      if (
        CHANNELS.some((channel) => {
          const receipts = state.receipts.filter((receipt) => receipt.channel === channel);
          return receipts.length
            ? Math.max(...receipts.map((receipt) => receipt.counter)) !== state.counters[channel]
            : state.counters[channel] > 0 && state.receipts.length < 128;
        })
      )
        return undefined;
      const files = [configInput.witness, state.fileWitness];
      const directories: CodexIdentityWitness['paths'] = [];
      let directoryPath = directory;
      for (let depth = 0; depth < 3; depth++) {
        const captured = await boundedRead(directoryPath, deadline, async (path) => {
          const info = await fs.lstat(path);
          if (
            !info.isDirectory() ||
            info.isSymbolicLink() ||
            (info.mode & 0o077) !== 0 ||
            (process.getuid !== undefined && info.uid !== process.getuid())
          )
            throw new Error('Historical broker directory invalid');
          return { value: { path, kind: 'directory', dev: info.dev, ino: info.ino }, witness: state.fileWitness! };
        });
        directories.push(captured.value as CodexIdentityWitness['paths'][number]);
        directoryPath = dirname(directoryPath);
      }
      // All config/state FDs have closed before the common final pathname scan.
      for (const file of files) {
        const checked = await boundedRead(file.path, deadline, async (path) => {
          const current = await fs.lstat(path);
          if (
            !privateFile(current) ||
            !['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(
              (key) => current[key as keyof Stats] === file[key as keyof PrivateFileWitness]
            )
          )
            throw new Error('Historical broker replaced');
          return { value: true, witness: file };
        });
        if (checked.value !== true) return undefined;
      }
      for (const path of directories) {
        const checked = await boundedRead(path.path, deadline, async (name) => {
          const current = await fs.lstat(name);
          if (
            !current.isDirectory() ||
            current.isSymbolicLink() ||
            current.dev !== path.dev ||
            current.ino !== path.ino
          )
            throw new Error('Historical broker directory changed');
          return { value: true, witness: state.fileWitness! };
        });
        if (checked.value !== true) return undefined;
      }
      return {
        files: files.map((file) => ({ ...file })),
        paths: [
          ...directories,
          ...files.map((file) => ({
            path: file.path,
            kind: 'file' as const,
            dev: file.dev,
            ino: file.ino,
            size: file.size,
            mtimeMs: file.mtimeMs,
            ctimeMs: file.ctimeMs,
          })),
        ],
        missing: [],
      };
    } catch {
      return undefined;
    }
  }
  /** Non-secret digest of the exact acknowledged runtime configuration bytes. */
  get configurationDigest(): string {
    return this.startupConfigurationDigest;
  }
  get incarnation(): string {
    return this.config.incarnation;
  }
  /** Permanently revoke a discarded source-host signer, including references held by old callers. */
  retire(): void {
    this.ready = false;
    this.ownerCursorUncertain = true;
  }
  get canFrame(): boolean {
    return this.ready && !this.ownerCursorUncertain;
  }
  async setStartupAuthority(
    files: readonly PrivateFileWitness[] = [],
    issuer?: BrokerAuthority,
    paths: CodexIdentityWitness['paths'] = [],
    missing: readonly string[] = [],
    monotonicDeadline = Number(process.hrtime.bigint() / 1_000_000n) + 2_000
  ): Promise<void> {
    const unique = uniqueFiles(files);
    if (
      !Number.isSafeInteger(monotonicDeadline) ||
      monotonicDeadline <= 0 ||
      !unique ||
      paths.length > 2048 ||
      missing.length > 64
    )
      throw new Error('Input startup authority oversized');
    const current = await boundedRead(join(this.directory, 'config.json'));
    if (
      current.witness.hash !== this.configurationDigest ||
      JSON.stringify(current.value) !== JSON.stringify(this.config)
    )
      throw new Error('Input startup configuration changed');
    const planned: BrokerConfig = {
      ...this.config,
      startup: {
        monotonicDeadline,
        nonce: this.config.startup.nonce,
        privateFiles: unique.map((file) => ({ ...file })),
        privatePaths: paths.map((path) => ({ ...path })),
        missingPaths: [...missing],
        issuer: issuer ?? null,
      },
    };
    const data = JSON.stringify(planned);
    if (Buffer.byteLength(data) > MAX_FILE) throw new Error('Input startup configuration oversized');
    const path = join(this.directory, 'config.json');
    const next = `${path}.next`,
      bytes = Buffer.from(data),
      directoryBefore = await fs.lstat(this.directory);
    const directoryCurrent = async () => {
      const current = await fs.lstat(this.directory);
      return (
        current.isDirectory() &&
        !current.isSymbolicLink() &&
        current.dev === directoryBefore.dev &&
        current.ino === directoryBefore.ino &&
        (current.mode & 0o077) === 0 &&
        (process.getuid === undefined || current.uid === process.getuid()) &&
        (await fs.realpath(this.directory)) === this.directory
      );
    };
    if (!(await directoryCurrent())) throw new Error('Input startup directory changed');
    let created: Stats | undefined,
      renamed = false,
      renameAttempted = false;
    // Even a partial failed write belongs to this invocation only while its
    // inode, private directory and observed bytes still match the owned prefix.
    const ownedStaging = async (name: string): Promise<Stats | undefined> => {
      if (!created || !(await directoryCurrent())) return undefined;
      const handle = await fs.open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await handle.stat();
        if (
          !privateFile(before) ||
          before.dev !== created.dev ||
          before.ino !== created.ino ||
          before.size > bytes.length
        )
          return undefined;
        const buffer = Buffer.alloc(before.size + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (
          bytesRead !== before.size ||
          !buffer.subarray(0, bytesRead).equals(bytes.subarray(0, bytesRead)) ||
          !sameFile(before, await handle.stat()) ||
          !sameFile(before, await fs.lstat(name))
        )
          return undefined;
        return before;
      } finally {
        await handle.close();
      }
    };
    const acknowledgeReplacement = (replacement: Stats) => {
      // Rename has replaced config.json, even when the following directory
      // fsync/close fails. Keep the exact owned rollback receipt current now.
      Object.assign(this.config, planned);
      this.startupConfigurationDigest = createHash('sha256').update(bytes).digest('hex');
      const previous = this.unlaunchedRollback?.files.findIndex((file) => file.name === 'config.json') ?? -1;
      if (this.unlaunchedRollback && previous >= 0)
        this.unlaunchedRollback.files[previous] = {
          name: 'config.json',
          dev: replacement.dev,
          ino: replacement.ino,
          size: replacement.size,
          hash: this.startupConfigurationDigest,
        };
    };
    try {
      const handle = await fs.open(next, 'wx', 0o600);
      try {
        created = await handle.stat();
        if (!privateFile(created) || created.size !== 0) throw new Error('Input startup staging changed');
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const replacement = await ownedStaging(next);
      const original = await readPrivateJson(path);
      if (
        !replacement ||
        replacement.size !== bytes.length ||
        JSON.stringify(original.witness) !== JSON.stringify(current.witness) ||
        !(await directoryCurrent()) ||
        !sameFile(replacement, await fs.lstat(next))
      )
        throw new Error('Input startup configuration changed');
      renameAttempted = true;
      await fs.rename(next, path);
      renamed = true;
      acknowledgeReplacement(replacement);
      const directory = await fs.open(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await directory.stat();
        if (!opened.isDirectory() || opened.dev !== directoryBefore.dev || opened.ino !== directoryBefore.ino)
          throw new Error('Input startup directory changed');
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      if (renameAttempted && !renamed) {
        try {
          // A lost rename receipt is not a launch authorization. Only the exact
          // owned destination plus an absent staging name can refresh rollback.
          const replacement = await ownedStaging(path);
          const absent = await fs.lstat(next).then(
            () => false,
            (failure: NodeJS.ErrnoException) => failure.code === 'ENOENT'
          );
          if (replacement?.size === bytes.length && absent && (await directoryCurrent())) {
            renamed = true;
            acknowledgeReplacement(replacement);
          }
        } catch {
          /* Uncertain replacement remains protected by the original receipt. */
        }
      }
      if (!renamed) {
        try {
          const staging = await ownedStaging(next);
          if (staging && (await directoryCurrent()) && sameFile(staging, await fs.lstat(next))) await fs.unlink(next);
        } catch {
          /* Preserve every unproved, replaced or unreadable staging file. */
        }
      }
      throw error;
    }
  }
  async startupReceipt(panePid: number): Promise<'started' | 'not-sent' | 'unknown'> {
    const deadline = performance.now() + 2_000;
    do {
      const state = await this.readState();
      if (performance.now() >= deadline) return 'unknown';
      if (state?.pid === panePid && state.startup.nonce === this.config.startup.nonce) {
        if (state.startup.status === 'started' && state.childPid > 0) return 'started';
        if (state.startup.status === 'not-sent' && state.childPid === 0 && state.closed) return 'not-sent';
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (performance.now() < deadline);
    return 'unknown';
  }
  frame(
    channel: BrokerChannel,
    input: string,
    conversationId = '',
    issuer?: BrokerAuthority,
    privateFiles: readonly PrivateFileWitness[] = [],
    expectedOwners?: CodexBrokerProof['ownerCounters'],
    privatePaths: CodexIdentityWitness['paths'] = [],
    missingPaths: readonly string[] = [],
    monotonicDeadline = Number(process.hrtime.bigint() / 1_000_000n) + 2_000,
    issuerLease?: BrokerRemoteIssuerLease
  ): { data: string; receipt: BrokerReceipt } | undefined {
    const files = uniqueFiles(privateFiles);
    if (
      (channel === 'auto' || channel === 'probe') &&
      (!Number.isSafeInteger(monotonicDeadline) || monotonicDeadline <= 0)
    )
      return undefined;
    if (
      !files ||
      (issuerLease !== undefined && (channel !== 'auto' || issuer !== undefined)) ||
      !this.ready ||
      this.ownerCursorUncertain ||
      (channel === 'probe' && (input !== '' || conversationId !== '')) ||
      Buffer.byteLength(input) > 65_536 ||
      (channel === 'auto' && !UUID.test(conversationId)) ||
      privatePaths.length > 2048 ||
      missingPaths.length > 64 ||
      (channel === 'auto' &&
        (!expectedOwners ||
          !exact(
            expectedOwners,
            CHANNELS.filter((key) => OWNER_CHANNELS.includes(key))
          ) ||
          !Object.values(expectedOwners).every(counter))) ||
      (channel !== 'auto' && (issuer || privateFiles.length || privatePaths.length || missingPaths.length))
    )
      return undefined;
    const next = this.counters[channel] + 1;
    if (!Number.isSafeInteger(next)) {
      this.ready = false;
      return undefined;
    }
    const bytes = Buffer.from(input, 'utf8');
    const receipt: BrokerReceipt = {
      channel,
      counter: next,
      nonce: randomUUID(),
      conversationId,
      hash: createHash('sha256').update(bytes).digest('hex'),
      status: 'reserved',
    };
    const encoded = Buffer.from(
      JSON.stringify({
        version: 1,
        sessionId: this.config.sessionId,
        incarnation: this.config.incarnation,
        channel,
        counter: next,
        nonce: receipt.nonce,
        conversationId,
        expectedOwners: channel === 'auto' ? expectedOwners : null,
        monotonicDeadline: channel === 'auto' || channel === 'probe' ? monotonicDeadline : null,
        issuer: issuer ?? null,
        ...(issuerLease === undefined ? {} : { issuerLease }),
        privateFiles: files,
        privatePaths,
        missingPaths,
        data: bytes.toString('base64'),
      })
    ).toString('base64');
    if (Buffer.byteLength(encoded) + 84 > 122_880) return undefined;
    this.counters[channel] = next;
    const signature = createHmac('sha256', Buffer.from(this.config.secret, 'hex')).update(encoded).digest('hex');
    return { data: `\x1eCODEMAN_INPUT_V1:${encoded}:${signature}\x1f`, receipt };
  }
  authority(proof: CodexBrokerProof): BrokerAuthority | undefined {
    if (
      proof.incarnation === this.config.incarnation &&
      proof.fileWitness?.path === join(this.directory, 'state.json') &&
      OWNER_CHANNELS.some((key) => this.counters[key] < proof.ownerCounters[key as BrokerOwnerChannel])
    )
      this.ownerCursorUncertain = true;
    return !this.ownerCursorUncertain &&
      proof.incarnation === this.config.incarnation &&
      proof.fileWitness?.path === join(this.directory, 'state.json') &&
      CHANNELS.filter((key) => OWNER_CHANNELS.includes(key)).every(
        (key) => this.counters[key] === proof.ownerCounters[key as BrokerOwnerChannel]
      )
      ? {
          sessionId: this.config.sessionId,
          incarnation: this.config.incarnation,
          directory: this.directory,
          proof,
          files: [proof.fileWitness],
        }
      : undefined;
  }
  async readState(deadline = Infinity): Promise<CodexBrokerState | undefined> {
    try {
      const input = await boundedRead(join(this.directory, 'state.json'), deadline);
      const state = parseState(input.value, this.config);
      if (state?.startup.status === 'started' && state.childPid > 0) this.ready = true;
      if (state) Object.defineProperty(state, 'fileWitness', { value: input.witness });
      return state;
    } catch {
      return undefined;
    }
  }
  async prove(panePid: number, deadline = performance.now() + 2_000): Promise<CodexBrokerProof | undefined> {
    const state = await this.readState(deadline);
    if (state && OWNER_CHANNELS.some((key) => this.counters[key] < state.counters[key]))
      this.ownerCursorUncertain = true;
    if (this.ownerCursorUncertain) return undefined;
    if (
      !state ||
      state.pid !== panePid ||
      state.childPid <= 0 ||
      state.startup.status !== 'started' ||
      state.tainted ||
      CHANNELS.filter((key) => OWNER_CHANNELS.includes(key)).some(
        (key) => this.counters[key] !== state.counters[key]
      ) ||
      state.receipts.some((receipt) => receipt.status === 'reserved')
    )
      return undefined;
    if (!state.closed && process.platform !== 'linux') return undefined;
    if (!state.closed && process.platform === 'linux') {
      try {
        const [broker, child] = await Promise.all([
          boundedRead(`/proc/${state.pid}/stat`, deadline, readProcessIdentity),
          boundedRead(`/proc/${state.childPid}/stat`, deadline, readProcessIdentity),
        ]);
        const liveBroker = broker.value as { start: string; status: string };
        const liveChild = child.value as { start: string; status: string; parent: number };
        if (
          liveBroker.start !== state.brokerStart ||
          liveChild.start !== state.childStart ||
          liveChild.parent !== state.pid ||
          ['Z', 'X', 'x', 'T', 't'].includes(liveBroker.status) ||
          ['Z', 'X', 'x', 'T', 't'].includes(liveChild.status)
        )
          return undefined;
      } catch {
        return undefined;
      }
    }
    return {
      incarnation: state.incarnation,
      brokerPid: state.pid,
      childPid: state.childPid,
      brokerStart: state.brokerStart,
      childStart: state.childStart,
      closed: state.closed,
      exitStatus: state.exitStatus ?? undefined,
      exitSignal: state.exitSignal ?? undefined,
      rawGeneration: state.rawGeneration,
      launchDigest: state.launchDigest,
      homeDigest: state.homeDigest,
      fileWitness: state.fileWitness,
      ownerCounters: {
        'owner-pty': state.counters['owner-pty'],
        'owner-key': state.counters['owner-key'],
        'owner-mux': state.counters['owner-mux'],
      },
    };
  }
  async receipt(expected: BrokerReceipt, callerDeadline = Infinity): Promise<'sent' | 'not-sent' | 'unknown'> {
    const deadline = Math.min(callerDeadline, performance.now() + 2_000);
    do {
      const state = await this.readState(deadline);
      if (performance.now() >= deadline) return 'unknown';
      const found = state?.receipts.find(
        (receipt) =>
          receipt.channel === expected.channel &&
          receipt.counter === expected.counter &&
          receipt.nonce === expected.nonce &&
          receipt.conversationId === expected.conversationId &&
          receipt.hash === expected.hash
      );
      if (found?.status === 'sent' || found?.status === 'not-sent') return found.status;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (performance.now() < deadline);
    return 'unknown';
  }
}
