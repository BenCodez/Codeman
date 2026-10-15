/** Bounded private proof for the exact profile, Codex identity and durable input fence. */
import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getCli } from '../config/cli-registry/registry.js';
import { getDataDirPath } from '../config/instance.js';
import { customModelHostsPath, type CustomModelHost } from '../custom-model-hosts.js';
import { buildCustomModelInjection } from '../custom-model-injection.js';
import { isCodexRestoreConfig } from './reboot-state-binding.js';
import type { SessionState } from '../types.js';
import type { BrokerPrivateEvidence } from './codex-input-broker.js';
import type { CustomModelBookkeeping } from '../types/session.js';
import type { CodexIdentityResult, CodexIdentityWitness } from './codex-identity.js';
import type { PrivateFileWitness } from './private-file-witness.js';
import {
  parseRebootIdentityFence,
  rebootIdentityFencePath,
  type RebootIdentityFence,
} from './reboot-identity-fence.js';

type ExpectedPath = CodexIdentityWitness['paths'][number];
export interface RebootFenceReceipt {
  sessionId: string;
  dataDir: string;
  path: string;
  value?: RebootIdentityFence;
}
export interface RebootLaunchEvidence {
  files: readonly PrivateFileWitness[];
  paths: CodexIdentityWitness['paths'];
  missing: readonly string[];
}
export type RebootLaunchWitness = ((
  identity?: CodexIdentityResult,
  fence?: RebootFenceReceipt,
  files?: readonly PrivateFileWitness[]
) => Promise<boolean>) & {
  /** Only the latest successful full identity/fence proof can authorize startup. */
  getStartupEvidence(): RebootLaunchEvidence | undefined;
};

const pending = new Map<string, { deadline: number; work: Promise<unknown> }>();
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const matches = (expected: ExpectedPath, current: Stats) =>
  !current.isSymbolicLink() &&
  (expected.kind === 'file' ? current.isFile() : current.isDirectory()) &&
  current.dev === expected.dev &&
  current.ino === expected.ino &&
  (expected.size === undefined || current.size === expected.size) &&
  (expected.mtimeMs === undefined || current.mtimeMs === expected.mtimeMs) &&
  (expected.ctimeMs === undefined || current.ctimeMs === expected.ctimeMs);
const snapshot = (path: string, info: Stats, kind: ExpectedPath['kind']): ExpectedPath => ({
  path,
  kind,
  dev: info.dev,
  ino: info.ino,
  size: info.size,
  mtimeMs: info.mtimeMs,
  ctimeMs: info.ctimeMs,
});

async function run<T>(
  key: string,
  dataDir: string,
  execute: (budget: ReturnType<typeof budgetFor>) => Promise<T>
): Promise<T | undefined> {
  let job = pending.get(key);
  if (!job) {
    if (pending.size >= 2) return undefined;
    const deadline = performance.now() + 2_000;
    const work = execute(budgetFor(deadline, dataDir)).catch(() => undefined);
    job = { deadline, work };
    pending.set(key, job);
    void work.finally(() => {
      if (pending.get(key)?.work === work) pending.delete(key);
    });
  }
  const remaining = job.deadline - performance.now();
  if (remaining <= 0) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      job.work,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), remaining);
      }),
    ]);
    return performance.now() < job.deadline && getDataDirPath() === dataDir ? (result as T | undefined) : undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function budgetFor(deadline: number, dataDir: string) {
  const paths: ExpectedPath[] = [];
  const missing: string[] = [];
  const files: PrivateFileWitness[] = [];
  const check = () => {
    if (performance.now() >= deadline || getDataDirPath() !== dataDir) throw new Error('Launch proof expired');
  };
  const read = async (path: string, limit: number, expected?: ExpectedPath): Promise<string> => {
    check();
    // Late opens and closes retain their pending slot until cleanup completes.
    const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      check();
      const info = await file.stat();
      check();
      if (!info.isFile() || info.size > limit || (expected && !matches(expected, info)))
        throw new Error('Invalid launch evidence');
      const bytes = Buffer.alloc(info.size);
      let size = 0;
      while (size < bytes.length) {
        const result = await file.read(bytes, size, bytes.length - size, size);
        check();
        if (!result.bytesRead) break;
        size += result.bytesRead;
      }
      const after = await file.stat();
      check();
      const captured = snapshot(path, info, 'file');
      if (size !== info.size || !matches(captured, after)) throw new Error('Launch evidence changed');
      const text = bytes.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('Invalid launch evidence');
      paths.push(captured);
      files.push({
        path,
        dev: info.dev,
        ino: info.ino,
        size: info.size,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
        hash: hash(text),
        maxBytes: limit,
      });
      return text;
    } finally {
      await file.close();
    }
  };
  const fence = async (path: string): Promise<RebootIdentityFence | undefined> => {
    try {
      return parseRebootIdentityFence(await read(path, 1_024));
    } catch (error) {
      if (!absent(error)) throw error;
      check();
      // Missing legacy fences are proved with a fresh nearest-parent snapshot,
      // then checked again after every participating FD has been closed.
      let parent = dirname(path);
      for (;;) {
        try {
          const info = await fs.lstat(parent);
          check();
          if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid fence parent');
          paths.push(snapshot(parent, info, 'directory'));
          missing.push(path);
          return undefined;
        } catch (error) {
          if (!absent(error) || dirname(parent) === parent) throw error;
          check();
          parent = dirname(parent);
        }
      }
    }
  };
  const finish = async () => {
    check();
    if (paths.length + missing.length > 2_048) return false;
    // All reads AND closes precede this common scan for every domain.
    for (const expected of paths) {
      const current = await fs.lstat(expected.path);
      check();
      if (!matches(expected, current)) return false;
    }
    for (const path of missing) {
      check();
      try {
        await fs.lstat(path);
        return false;
      } catch (error) {
        if (!absent(error)) throw error;
      }
      check();
    }
    return true;
  };
  return { check, read, fence, finish, paths, files, missing };
}

/** Bind the old incarnation before reconciliation or a new guarded launch replaces mux metadata. */
export async function captureRebootBrokerBindings(
  persisted: Readonly<Record<string, SessionState>>
): Promise<Map<string, string | null> | undefined> {
  const dataDir = getDataDirPath();
  const states = Object.values(persisted).filter((state) => state.mode === 'codex' && !state.remote && !state.docker);
  if (states.length > 1_000) return undefined;
  return run(
    hash(
      JSON.stringify([
        'old-brokers',
        dataDir,
        states.map((state) => [
          state.id,
          state.owner,
          state.workingDir,
          state.codexConfig,
          (state as SessionState & { __codexRecoveryHome?: string }).__codexRecoveryHome,
          (state as SessionState & { __codexInputBroker?: unknown }).__codexInputBroker,
          (state as SessionState & { __codexPriorInputBroker?: unknown }).__codexPriorInputBroker,
        ]),
      ])
    ),
    dataDir,
    async (budget) => {
      const result = new Map<string, string | null>();
      let rows: Array<Record<string, unknown>> = [];
      if (states.length) {
        const path = join(dataDir, 'mux-sessions.json');
        try {
          const value: unknown = JSON.parse(await budget.read(path, 2_097_152));
          if (
            !Array.isArray(value) ||
            value.length > 1_000 ||
            value.some((row) => !row || typeof row !== 'object' || Array.isArray(row))
          )
            throw new Error('Historical mux binding unavailable');
          rows = value;
        } catch (error) {
          if (!absent(error)) throw error;
          await budget.fence(path);
        }
      }
      for (const state of states) {
        budget.check();
        if (!/^[\w-]{1,100}$/.test(state.id)) continue;
        const stored = state as SessionState & {
          __codexInputBroker?: unknown;
          __codexPriorInputBroker?: unknown;
          __codexRecoveryHome?: string;
        };
        const valid = (value: unknown): value is string =>
          typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
        const matching = rows.filter((row) => row.sessionId === state.id);
        if (matching.length > 1) continue;
        const row = matching[0];
        if (row?.codexRestoreUncertain === true || row?.recoveryInputBrokerPending !== undefined) continue;
        if (
          row &&
          (row.mode !== 'codex' ||
            row.remote ||
            row.docker ||
            row.owner !== state.owner ||
            row.workingDir !== state.workingDir ||
            row.recoveryCodexHome !== stored.__codexRecoveryHome)
        )
          continue;
        const sameConfig = async () => {
          if (!isCodexRestoreConfig(row?.codexRestoreConfig) || !isCodexRestoreConfig(state.codexConfig)) return false;
          const actual = row!.codexRestoreConfig as NonNullable<SessionState['codexConfig']>;
          const saved = state.codexConfig!;
          const canonical = (config: typeof actual) =>
            JSON.stringify(
              Object.entries(config)
                .filter(([key, value]) => key !== 'resumeSessionId' && value !== undefined)
                .sort(([a], [b]) => a.localeCompare(b))
            );
          if (canonical(actual) !== canonical(saved)) return false;
          if (actual.resumeSessionId === undefined || actual.resumeSessionId === saved.resumeSessionId) return true;
          if (saved.resumeSessionId !== undefined) return false;
          // A completed explicit restoration can durably bind the UUID before
          // the older original config has been replaced in main state.
          const fence = await budget.fence(rebootIdentityFencePath(state.id));
          return fence?.switchPending === false && fence.resumeSessionId === actual.resumeSessionId;
        };
        const configMatches = row?.codexRestoreConfig !== undefined && (await sameConfig());
        if (row?.codexRestoreConfig !== undefined && !configMatches) continue;
        if (
          Object.prototype.hasOwnProperty.call(stored, '__codexInputBroker') &&
          stored.__codexInputBroker !== null &&
          !valid(stored.__codexInputBroker)
        )
          continue;
        const offered = Object.prototype.hasOwnProperty.call(stored, '__codexPriorInputBroker');
        if (offered) {
          const prior = stored.__codexPriorInputBroker;
          if (prior !== null && !valid(prior)) continue;
          if (valid(stored.__codexInputBroker) && stored.__codexInputBroker !== prior) continue;
          if (row && row.recoveryInputBroker !== prior && (prior !== null || row.recoveryInputBroker !== undefined))
            continue;
          if (prior !== null) {
            result.set(state.id, prior);
            continue;
          }
          // A legacy offer must still prove that no guarded launch has appeared
          // since it was captured. This check runs before its own new broker exists.
        } else {
          if (row?.recoveryInputBroker !== undefined) {
            if (
              valid(row.recoveryInputBroker) &&
              (stored.__codexInputBroker == null
                ? configMatches
                : stored.__codexInputBroker === row.recoveryInputBroker)
            )
              result.set(state.id, row.recoveryInputBroker);
            continue;
          }
          if (valid(stored.__codexInputBroker)) {
            // A surviving row without its old broker is a different, unproven
            // launch. A pruned row can still use the exact pinned old journal.
            if (!row) result.set(state.id, stored.__codexInputBroker);
            continue;
          }
        }
        // An omitted binding never selects an incarnation by directory order. Any
        // surviving broker artifact makes this an unknown managed history.
        const directory = join(dataDir, 'codex-input-brokers', state.id);
        try {
          await fs.lstat(directory);
          budget.check();
        } catch (error) {
          if (!absent(error)) throw error;
          await budget.fence(directory);
          result.set(state.id, null);
        }
      }
      if (!(await budget.finish())) throw new Error('Historical input binding changed');
      return result;
    }
  );
}

export async function captureRebootIdentityFenceWitness(sessionId: string): Promise<RebootFenceReceipt | undefined> {
  const dataDir = getDataDirPath(),
    path = rebootIdentityFencePath(sessionId);
  return run(hash(JSON.stringify(['fence', dataDir, sessionId, path])), dataDir, async (budget) => {
    const value = await budget.fence(path);
    if (!(await budget.finish())) throw new Error('Fence evidence changed');
    return { sessionId, dataDir, path, value };
  });
}

export async function captureRebootLaunchWitness(
  mode: string,
  sessionId: string,
  input: CustomModelBookkeeping | undefined,
  env: Record<string, string>
): Promise<RebootLaunchWitness | undefined> {
  if (
    input &&
    (typeof input.endpointId !== 'string' ||
      typeof input.modelId !== 'string' ||
      !Array.isArray(input.envKeys) ||
      input.envKeys.some((key) => typeof key !== 'string'))
  )
    return undefined;
  const dataDir = getDataDirPath(),
    configDir = join(dataDir, 'custom-model-configs', sessionId);
  const saved = input && { ...input, envKeys: [...input.envKeys] };
  const expectedEnv = JSON.stringify(env);
  const profileKey = hash(JSON.stringify([dataDir, mode, sessionId, saved, env]));
  const proof = async (
    input?: CodexIdentityResult,
    receipt?: RebootFenceReceipt,
    additionalFiles: readonly PrivateFileWitness[] = []
  ): Promise<{ profile: string; evidence: RebootLaunchEvidence } | undefined> => {
    const historical = (input as (CodexIdentityResult & { historicalInput?: BrokerPrivateEvidence }) | undefined)
      ?.historicalInput;
    if (
      historical &&
      (!Array.isArray(historical.files) || !Array.isArray(historical.paths) || !Array.isArray(historical.missing))
    )
      return undefined;
    additionalFiles = [...additionalFiles, ...(historical?.files ?? [])];
    if (!Array.isArray(additionalFiles) || additionalFiles.length > 8) return undefined;
    const files: PrivateFileWitness[] = [];
    for (const file of additionalFiles) {
      if (
        !file ||
        typeof file.path !== 'string' ||
        !file.path ||
        ![file.dev, file.ino, file.size, file.mtimeMs, file.ctimeMs, file.maxBytes].every(Number.isFinite) ||
        !Number.isInteger(file.size) ||
        file.size < 0 ||
        !Number.isInteger(file.maxBytes) ||
        file.maxBytes < 0 ||
        file.maxBytes > 2_097_152 ||
        file.size > file.maxBytes ||
        typeof file.hash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(file.hash)
      )
        return undefined;
      files.push({
        path: file.path,
        dev: file.dev,
        ino: file.ino,
        size: file.size,
        mtimeMs: file.mtimeMs,
        ctimeMs: file.ctimeMs,
        hash: file.hash,
        maxBytes: file.maxBytes,
      });
    }
    if (
      input &&
      (!input.witness ||
        !Array.isArray(input.witness.paths) ||
        input.witness.paths.some(
          (path) => !path || typeof path.path !== 'string' || !['file', 'directory'].includes(path.kind)
        ))
    )
      return undefined;
    const identity = input && {
      ...input,
      witness: input.witness && { paths: input.witness.paths.map((item) => ({ ...item })) },
    };
    let leaf: ExpectedPath | undefined, tailHash: string | undefined;
    if (identity) {
      if (
        identity.reason !== 'verified' ||
        !identity.path ||
        !identity.witness ||
        identity.witness.paths.length > 2_048 ||
        identity.tailTruncated !== false ||
        typeof identity.tail !== 'string' ||
        Buffer.byteLength(identity.tail, 'utf8') > 262_144
      )
        return undefined;
      leaf = identity.witness.paths.find((item) => item.path === identity.path && item.kind === 'file');
      if (!leaf || leaf.size === undefined || leaf.mtimeMs === undefined || leaf.ctimeMs === undefined)
        return undefined;
      tailHash = hash(identity.tail);
    }
    const fence = receipt && {
      ...receipt,
      value: receipt.value && {
        ...receipt.value,
        submission: receipt.value.submission && { ...receipt.value.submission },
      },
    };
    if (
      fence &&
      (fence.sessionId !== sessionId || fence.dataDir !== dataDir || fence.path !== rebootIdentityFencePath(sessionId))
    )
      return undefined;
    const key = hash(
      JSON.stringify([
        'launch',
        profileKey,
        identity && [identity.conversationId, identity.path, identity.witness, tailHash],
        fence,
        files,
        historical,
      ])
    );
    return run(key, dataDir, async (budget) => {
      let profile = 'none';
      if (saved) {
        const entry = getCli(mode);
        if (!entry) throw new Error('Unsupported profile');
        const hosts: unknown = JSON.parse(await budget.read(customModelHostsPath(dataDir), 2 * 1024 * 1024));
        if (!Array.isArray(hosts)) throw new Error('Invalid profile');
        const selected = hosts.filter((item) => item && typeof item === 'object' && item.id === saved.endpointId);
        if (selected.length !== 1) throw new Error('Invalid profile');
        const endpoint = selected[0] as CustomModelHost;
        if (
          typeof endpoint.baseUrl !== 'string' ||
          !endpoint.baseUrl.trim() ||
          (endpoint.apiKey !== undefined && typeof endpoint.apiKey !== 'string') ||
          (endpoint.models !== undefined &&
            (!Array.isArray(endpoint.models) || endpoint.models.some((model) => typeof model !== 'string')))
        )
          throw new Error('Invalid profile');
        const contextLength = endpoint.modelContextLengths?.[saved.modelId];
        if (contextLength !== undefined && (!Number.isFinite(contextLength) || contextLength <= 0))
          throw new Error('Invalid profile');
        const injection = buildCustomModelInjection(entry, endpoint, saved.modelId, contextLength);
        if (
          injection.kind !== 'configDir' ||
          JSON.stringify({ [injection.dirEnvVar]: configDir, ...injection.extraEnv }) !== expectedEnv
        )
          throw new Error('Profile changed');
        for (const file of injection.files)
          if ((await budget.read(join(configDir, file.relPath), 2 * 1024 * 1024)) !== file.content)
            throw new Error('Profile changed');
        profile = JSON.stringify({ injection, models: endpoint.models });
      }
      if (historical) {
        budget.paths.push(...historical.paths);
        budget.missing.push(...historical.missing);
      }
      if (identity) {
        if (hash(await budget.read(identity.path!, 262_144, leaf)) !== tailHash) throw new Error('Identity changed');
        budget.paths.push(...identity.witness!.paths);
      }
      if (fence && JSON.stringify(await budget.fence(fence.path)) !== JSON.stringify(fence.value))
        throw new Error('Fence changed');
      for (const file of files)
        if (hash(await budget.read(file.path, file.maxBytes, { ...file, kind: 'file' })) !== file.hash)
          throw new Error('Private authority changed');
      if (!(await budget.finish())) throw new Error('Launch evidence changed');
      return {
        profile,
        evidence: {
          files: budget.files.map((file) => ({ ...file })),
          paths: budget.paths.map((path) => ({ ...path })),
          missing: [...budget.missing],
        },
      };
    });
  };
  const initial = await proof();
  if (initial === undefined) return undefined;
  let startup: RebootLaunchEvidence | undefined;
  let revision = 0;
  const witness: RebootLaunchWitness = Object.assign(
    async (identity?: CodexIdentityResult, fence?: RebootFenceReceipt, files?: readonly PrivateFileWitness[]) => {
      const selected = ++revision;
      startup = undefined;
      const current = await proof(identity, fence, files);
      const accepted = selected === revision && current?.profile === initial.profile;
      if (accepted && identity && fence) startup = current!.evidence;
      return accepted;
    },
    {
      getStartupEvidence: () =>
        startup && {
          files: startup.files.map((file) => ({ ...file })),
          paths: startup.paths.map((path) => ({ ...path })),
          missing: [...startup.missing],
        },
    }
  );
  return witness;
}
