/** Recovery-only asynchronous profile IO; ordinary custom-model application stays synchronous. */
import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { getCli } from './config/cli-registry/registry.js';
import { getDataDir } from './config/instance.js';
import { customModelHostsPath, type CustomModelHost } from './custom-model-hosts.js';
import { customModelConfigDir, truncateApiKeyForTrustFile } from './custom-model-injection-apply.js';
import { buildCustomModelInjection } from './custom-model-injection.js';
import type { CustomModelBookkeeping } from './types/session.js';
export { captureRebootLaunchWitness as captureCustomModelRecoveryWitness } from './recovery/reboot-launch-witness.js';

export type RecoveryDirectoryProbe =
  | { status: 'present'; dev: number; ino: number }
  | { status: 'absent' }
  | { status: 'unknown' };
type WrittenProfileFile = { path: string; dev: number; ino: number; hash: string; link?: string };
export interface CreatedRecoveryProfile {
  path: string;
  dataDir: string;
  dev: number;
  ino: number;
  files: WrittenProfileFile[];
  directories: string[];
}
const pending = new Map<string, Promise<unknown>>();
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const same = (a: Stats, b: Stats) =>
  ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every((k) => a[k as keyof Stats] === b[k as keyof Stats]);
const owned = (s: Stats) => process.getuid === undefined || s.uid === process.getuid();
function current(callback: () => boolean) {
  try {
    const value: unknown = callback();
    if (value && typeof (value as { then?: unknown }).then === 'function') void Promise.resolve(value).catch(() => {});
    return value === true;
  } catch {
    return false;
  }
}
async function run<T>(
  path: string,
  isCurrent: () => boolean,
  operation: (check: () => void) => Promise<T>,
  callerDeadline?: number
): Promise<T | undefined> {
  if (
    !isAbsolute(path) ||
    path.includes('\0') ||
    Buffer.byteLength(path) > 4096 ||
    pending.has(path) ||
    pending.size >= 2
  )
    return undefined;
  const dataDir = getDataDir(),
    deadline = Math.min(performance.now() + 2000, callerDeadline ?? Infinity);
  if (!Number.isFinite(deadline) || performance.now() >= deadline) return undefined;
  let timedOut = false;
  const check = () => {
    if (timedOut || performance.now() >= deadline || getDataDir() !== dataDir || !current(isCurrent))
      throw Error('Recovery profile unavailable');
  };
  const work = Promise.resolve()
    .then(() => {
      check();
      return operation(check);
    })
    .catch(() => undefined);
  pending.set(path, work);
  void work.finally(() => {
    if (pending.get(path) === work) pending.delete(path);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      work,
      new Promise<undefined>((done) => {
        timer = setTimeout(
          () => {
            timedOut = true;
            done(undefined);
          },
          Math.max(0, deadline - performance.now())
        );
      }),
    ]);
    check();
    return value;
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function directoryProbe(path: string, check: () => void, follow = false): Promise<RecoveryDirectoryProbe> {
  check();
  let info: Stats;
  try {
    info = await (follow ? fs.stat(path) : fs.lstat(path));
    check();
  } catch (error) {
    check();
    if (!absent(error)) throw error;
    // A late or failed lookup is never converted into proof of absence.
    try {
      await fs.lstat(path);
      check();
      return { status: 'unknown' };
    } catch (second) {
      check();
      if (!absent(second)) throw second;
      return { status: 'absent' };
    }
  }
  return info.isDirectory() && !info.isSymbolicLink()
    ? { status: 'present', dev: info.dev, ino: info.ino }
    : { status: 'unknown' };
}
/** Read-only admission: an unknown answer authorizes neither profile writes nor cleanup. */
export async function probeRecoveryDirectory(
  path: string,
  isCurrent: () => boolean = () => true,
  follow = false,
  deadline?: number
): Promise<RecoveryDirectoryProbe> {
  return (
    (await run(path, isCurrent, (check) => directoryProbe(path, check, follow), deadline)) ?? { status: 'unknown' }
  );
}

export async function rebuildPersistedCustomModelEnv(
  mode: string,
  sessionId: string,
  saved: CustomModelBookkeeping,
  workingDir: string,
  options: {
    isCurrent?: () => boolean;
    directory?: RecoveryDirectoryProbe;
    deadline?: number;
    onCreated?: (profile: CreatedRecoveryProfile) => void;
  } = {}
): Promise<Record<string, string> | undefined> {
  const entry = getCli(mode);
  if (!entry || !/^[-\w]{1,100}$/.test(sessionId)) return undefined;
  const path = customModelConfigDir(sessionId),
    dataDir = getDataDir(),
    savedText = JSON.stringify(saved);
  const scope = () => JSON.stringify(saved) === savedText && current(options.isCurrent ?? (() => true));
  return run(
    path,
    scope,
    async (check) => {
      const probe = options.directory ?? (await directoryProbe(path, check));
      if (probe.status === 'unknown') return undefined;
      const read = async (filePath: string, max = 2 * 1024 * 1024) => {
        check();
        const file = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let before: Stats, bytes: Buffer;
        try {
          check();
          before = await file.stat();
          check();
          if (!before.isFile() || !owned(before) || before.size > max) throw Error('Recovery profile unreadable');
          bytes = Buffer.alloc(before.size + 1);
          let size = 0;
          while (size < bytes.length) {
            const r = await file.read(bytes, size, bytes.length - size, size);
            check();
            if (!r.bytesRead) break;
            size += r.bytesRead;
          }
          if (size !== before.size || !same(before, await file.stat())) throw Error('Recovery profile changed');
          bytes = bytes.subarray(0, size);
        } finally {
          await file.close();
        }
        check();
        if (!same(before, await fs.lstat(filePath))) throw Error('Recovery profile replaced');
        check();
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return { text, stat: before };
      };
      const hostsPath = customModelHostsPath(dataDir),
        hosts = await read(hostsPath);
      const values: unknown = JSON.parse(hosts.text);
      if (!Array.isArray(values)) return undefined;
      const candidates = values.filter((value) => value && typeof value === 'object' && value.id === saved.endpointId);
      if (candidates.length !== 1) return undefined;
      const endpoint = candidates[0] as CustomModelHost;
      if (
        endpoint.models !== undefined &&
        (!Array.isArray(endpoint.models) || !endpoint.models.every((model) => typeof model === 'string'))
      )
        return undefined;
      if (
        typeof endpoint.baseUrl !== 'string' ||
        !endpoint.baseUrl.trim() ||
        (endpoint.apiKey !== undefined && typeof endpoint.apiKey !== 'string')
      )
        return undefined;
      const contextLength = endpoint.modelContextLengths?.[saved.modelId];
      if (contextLength !== undefined && (!Number.isFinite(contextLength) || contextLength <= 0)) return undefined;
      const injection = buildCustomModelInjection(entry, endpoint, saved.modelId, contextLength);
      if (injection.kind === 'unsupported') return undefined;
      const hasDirectory = injection.kind === 'configDir' || !!injection.configDirVar;
      if (!hasDirectory) {
        check();
        return injection.kind === 'env' ? injection.envOverrides : undefined;
      }
      let created: CreatedRecoveryProfile | undefined;
      const ensure = async (directory: string) => {
        const tail = relative(dataDir, directory);
        if (tail.startsWith('..') || isAbsolute(tail)) throw Error('Recovery profile path');
        const anchor = await fs.lstat(dataDir);
        check();
        if (!anchor.isDirectory() || anchor.isSymbolicLink() || !owned(anchor)) throw Error('Recovery profile root');
        let part = dataDir;
        for (const component of tail.split(sep).filter(Boolean)) {
          part = join(part, component);
          check();
          let made = false;
          try {
            await fs.mkdir(part, { mode: 0o700 });
            made = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          }
          check();
          const stat = await fs.lstat(part);
          check();
          if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat)) throw Error('Recovery profile parent');
          if (part === path) {
            if (created && (stat.dev !== created.dev || stat.ino !== created.ino))
              throw Error('Recovery profile replaced');
            if (probe.status === 'absent' && !made && !created) throw Error('Recovery profile appeared');
            if (probe.status === 'present' && (made || stat.dev !== probe.dev || stat.ino !== probe.ino))
              throw Error('Recovery profile replaced');
            if (made) {
              created = { path, dataDir, dev: stat.dev, ino: stat.ino, files: [], directories: [path] };
              options.onCreated?.(created);
            }
          } else if (made && created) created.directories.push(part);
        }
      };
      await ensure(path);
      const directoryCurrent = async () => {
        check();
        const stat = await fs.lstat(path);
        check();
        const expected = created ?? (probe.status === 'present' ? probe : undefined);
        if (
          !expected ||
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          stat.dev !== expected.dev ||
          stat.ino !== expected.ino
        )
          throw Error('Recovery profile replaced');
        if (!same(hosts.stat, await fs.lstat(hostsPath))) throw Error('Recovery profile endpoint changed');
        check();
      };
      const filePath = (rel: string) => {
        const target = resolve(path, rel);
        if (!target.startsWith(path + sep)) throw Error('Recovery profile file');
        return target;
      };
      const write = async (rel: string, text: string) => {
        const target = filePath(rel);
        if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw Error('Recovery profile oversized');
        if (dirname(target) !== path) await ensure(dirname(target));
        await directoryCurrent();
        const parent = dirname(target),
          parentInfo = await fs.lstat(parent);
        check();
        const prior = await read(target).catch((error) => {
          if (absent(error)) return undefined;
          throw error;
        });
        check();
        const temporary = target + '.recovery-' + randomUUID();
        let ownedStage: Stats | undefined;
        let stagedText: string | undefined;
        let file: Awaited<ReturnType<typeof fs.open>> | undefined;
        const parentCurrent = async () => {
          const [directory, profile] = await Promise.all([fs.lstat(parent), fs.lstat(path)]);
          const expected = created ?? (probe.status === 'present' ? probe : undefined);
          return (
            expected &&
            directory.isDirectory() &&
            !directory.isSymbolicLink() &&
            directory.dev === parentInfo.dev &&
            directory.ino === parentInfo.ino &&
            profile.isDirectory() &&
            !profile.isSymbolicLink() &&
            profile.dev === expected.dev &&
            profile.ino === expected.ino
          );
        };
        try {
          try {
            file = await fs.open(
              temporary,
              constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK,
              0o600
            );
            ownedStage = await file.stat();
            check();
            if (!ownedStage.isFile() || !owned(ownedStage)) throw Error('Recovery profile staging unavailable');
            await file.writeFile(text, 'utf8');
            check();
            await file.sync();
            check();
          } finally {
            // Even a partial failed write belongs only to this exclusive FD. Capture
            // its actual prefix before close; unknown/foreign bytes are never deleted.
            if (file) {
              try {
                const before = await file.stat();
                if (
                  ownedStage &&
                  before.dev === ownedStage.dev &&
                  before.ino === ownedStage.ino &&
                  before.size <= Buffer.byteLength(text)
                ) {
                  const bytes = Buffer.alloc(before.size + 1);
                  let size = 0;
                  while (size < bytes.length) {
                    const result = await file.read(bytes, size, bytes.length - size, size);
                    if (!result.bytesRead) break;
                    size += result.bytesRead;
                  }
                  const after = await file.stat();
                  if (
                    size === before.size &&
                    same(before, after) &&
                    bytes.subarray(0, size).equals(Buffer.from(text).subarray(0, size))
                  ) {
                    ownedStage = after;
                    stagedText = bytes.subarray(0, size).toString('utf8');
                  }
                }
              } catch {
                /* Retain unverifiable staging bytes. */
              }
              await file.close();
            }
          }
          check();
          if (!ownedStage || stagedText !== text) throw Error('Recovery profile staging incomplete');
          await directoryCurrent();
          const currentTarget = await read(target).catch((error) => {
            if (absent(error)) return undefined;
            throw error;
          });
          check();
          if (
            prior
              ? !currentTarget || !same(prior.stat, currentTarget.stat) || prior.text !== currentTarget.text
              : currentTarget !== undefined
          )
            throw Error('Recovery profile changed');
          // All proof FDs have closed. Recheck every pathname jointly before the
          // atomic effect; a replaced temp/parent/primary is never overwritten.
          const [stageInfo, targetInfo, parentOkay, endpointInfo] = await Promise.all([
            fs.lstat(temporary),
            fs.lstat(target).catch((error) => {
              if (absent(error)) return undefined;
              throw error;
            }),
            parentCurrent(),
            fs.lstat(hostsPath),
          ]);
          if (
            !same(hosts.stat, endpointInfo) ||
            !parentOkay ||
            !same(stageInfo, ownedStage) ||
            stageInfo.isSymbolicLink() ||
            (prior ? !targetInfo || !same(prior.stat, targetInfo) : targetInfo !== undefined)
          )
            throw Error('Recovery profile replaced');
          check();
          created?.files.push({ path: target, dev: ownedStage.dev, ino: ownedStage.ino, hash: hash(text) });
          await fs.rename(temporary, target);
          check();
          const directory = await fs.open(
            parent,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK
          );
          try {
            const info = await directory.stat();
            check();
            if (info.dev !== parentInfo.dev || info.ino !== parentInfo.ino)
              throw Error('Recovery profile parent replaced');
            await directory.sync();
            check();
          } finally {
            await directory.close();
          }
          check();
          const published = await read(target);
          if (published.stat.dev !== ownedStage.dev || published.stat.ino !== ownedStage.ino || published.text !== text)
            throw Error('Recovery profile replaced');
          check();
        } finally {
          try {
            if (ownedStage && stagedText !== undefined) {
              const [final, parentOkay] = await Promise.all([fs.lstat(temporary), parentCurrent()]);
              if (parentOkay && same(ownedStage, final) && !final.isSymbolicLink()) await fs.unlink(temporary);
            }
          } catch {
            /* Unknown or replaced artifacts remain inspection-only. */
          }
        }
      };
      const json = async (rel: string) => {
        try {
          const value: unknown = JSON.parse((await read(filePath(rel))).text);
          return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
        } catch (error) {
          check();
          if (absent(error) || error instanceof SyntaxError) return {};
          throw error;
        }
      };
      let env: Record<string, string>;
      if (injection.kind === 'configDir') {
        for (const file of injection.files) await write(file.relPath, file.content);
        env = { [injection.dirEnvVar]: path, ...injection.extraEnv };
      } else {
        env = { ...injection.envOverrides, [injection.configDirVar!]: path };
        const projects = join(path, 'projects');
        try {
          await fs.lstat(projects);
          check();
        } catch (error) {
          check();
          if (!absent(error)) throw error;
          const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
          const target = join(configured || join(homedir(), '.claude'), 'projects');
          await directoryCurrent();
          try {
            await fs.symlink(target, projects, platform() === 'win32' ? 'junction' : 'dir');
            check();
            const info = await fs.lstat(projects);
            check();
            created?.files.push({ path: projects, dev: info.dev, ino: info.ino, hash: '', link: target });
          } catch (linkError) {
            check();
            if ((linkError as NodeJS.ErrnoException).code !== 'EEXIST') throw linkError;
          }
        }
        if (injection.apiKeyTrustFile) {
          const rel = injection.apiKeyTrustFile.relPath,
            value = await json(rel);
          if (injection.apiKey) {
            const old = value.customApiKeyResponses as { approved?: unknown; rejected?: unknown } | undefined;
            value.customApiKeyResponses = {
              approved: [
                ...new Set([
                  ...(Array.isArray(old?.approved) ? old.approved : []),
                  truncateApiKeyForTrustFile(injection.apiKey),
                ]),
              ],
              rejected: Array.isArray(old?.rejected) ? old.rejected : [],
            };
          }
          if (injection.skipFirstRunPrompts && workingDir) {
            value.hasCompletedOnboarding = true;
            const projects =
              value.projects && typeof value.projects === 'object' && !Array.isArray(value.projects)
                ? (value.projects as Record<string, unknown>)
                : {};
            const old = projects[workingDir];
            projects[workingDir] = {
              ...(old && typeof old === 'object' && !Array.isArray(old) ? old : {}),
              hasTrustDialogAccepted: true,
            };
            value.projects = projects;
          }
          await write(rel, JSON.stringify(value, null, 2));
        }
        if (injection.skipFirstRunPrompts && injection.apiKeyTrustFile) {
          const settings = await json('settings.json');
          settings.skipDangerousModePermissionPrompt = true;
          await write('settings.json', JSON.stringify(settings, null, 2));
        }
      }
      await directoryCurrent();
      check();
      return env;
    },
    options.deadline
  );
}

/** Remove only the exact files this attempt created, never an original conversation or late write. */
export async function removeCreatedRecoveryProfile(
  profile: CreatedRecoveryProfile,
  isCurrent: () => boolean = () => true
): Promise<boolean> {
  if (getDataDir() !== profile.dataDir) return false;
  return (
    (await run(profile.path, isCurrent, async (check) => {
      const directory = await fs.lstat(profile.path);
      check();
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        directory.dev !== profile.dev ||
        directory.ino !== profile.ino
      )
        return false;
      for (const file of profile.files) {
        let info: Stats;
        try {
          info = await fs.lstat(file.path);
        } catch (error) {
          check();
          if (absent(error)) continue;
          throw error;
        }
        check();
        if (info.dev !== file.dev || info.ino !== file.ino) return false;
        if (file.link !== undefined) {
          if (!info.isSymbolicLink() || (await fs.readlink(file.path)) !== file.link) return false;
        } else {
          if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) return false;
          const handle = await fs.open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          let bytes: Buffer;
          try {
            check();
            if (!same(info, await handle.stat())) return false;
            bytes = Buffer.alloc(info.size + 1);
            const read = await handle.read(bytes, 0, bytes.length, 0);
            check();
            if (read.bytesRead !== info.size || !same(info, await handle.stat())) return false;
            bytes = bytes.subarray(0, read.bytesRead);
          } finally {
            await handle.close();
          }
          check();
          if (hash(bytes) !== file.hash) return false;
        }
        const [parent, after] = await Promise.all([fs.lstat(profile.path), fs.lstat(file.path)]);
        check();
        if (
          parent.isSymbolicLink() ||
          !parent.isDirectory() ||
          parent.dev !== profile.dev ||
          parent.ino !== profile.ino ||
          !same(info, after)
        )
          return false;
        check();
        await fs.unlink(file.path);
        check();
      }
      for (const path of profile.directories.slice().reverse()) {
        check();
        const root = await fs.lstat(profile.path);
        check();
        if (!root.isDirectory() || root.isSymbolicLink() || root.dev !== profile.dev || root.ino !== profile.ino)
          return false;
        await fs.rmdir(path);
        check();
      }
      return true;
    })) ?? false
  );
}
