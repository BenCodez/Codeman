/** Private, launch-owned Codex manager profile. Never accepted from a request or persisted as Session settings. */
import { randomUUID, createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parse, stringify } from 'smol-toml';
import type { CodexConfig } from '../types.js';
import type { PrivateFileWitness } from '../recovery/private-file-witness.js';
import { checkPrivateFileWitnesses } from '../recovery/codex-witness-check.js';

const MAX_FILE = 65_536;
const issued = new WeakSet<SupervisorManagerLaunch>();
const pending = new Set<string>();
const pendingWork = new Map<string, Promise<unknown>>();
const retirements = new Map<string, Promise<boolean>>();
let retirementWork: Promise<unknown> = Promise.resolve();
type FileIdentity = Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>;
const same = (a: FileIdentity, b: FileIdentity) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const quote = (text: string) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`);

export interface SupervisorManagerLaunch {
  readonly expectedPane: Readonly<{ paneId: string; panePid: number }>;
  readonly conversationId: string;
  readonly home: string;
  readonly name: string;
  readonly file: string;
  readonly files: readonly PrivateFileWitness[];
  readonly missing: readonly string[];
  isCurrent(): boolean;
  confirm(): Promise<boolean>;
  /** Revoke immediately, then remove only this invocation's verified private artifacts. */
  revoke(): Promise<boolean>;
}

/** A restricted manager never inherits ordinary shell, patch, app, plugin or subagent tools. */
export function supervisorManagerCommand(profile: SupervisorManagerLaunch, config?: CodexConfig): string {
  if (!issued.has(profile) || !profile.isCurrent() || !UUID.test(profile.conversationId) || config?.noDaemon !== true)
    throw new Error('Restricted manager launch is not current');
  const args = ['codex', '--no-daemon', '--sandbox', 'read-only', '--ask-for-approval', 'never'];
  if (config.model) args.push('--model', config.model);
  if (config.reasoningEffort) args.push('--config', `model_reasoning_effort=${JSON.stringify(config.reasoningEffort)}`);
  if (config.noAltScreen) args.push('--no-alt-screen');
  for (const feature of [
    'shell_tool',
    'apply_patch_freeform',
    'apps',
    'multi_agent',
    'plugins',
    'hooks',
    'remote_plugin',
    'skill_mcp_dependency_install',
    'code_mode',
  ])
    args.push('--disable', feature);
  args.push(
    '--config',
    'tools.view_image=false',
    '--config',
    'agents.enabled=false',
    '--config',
    'features.multi_agent_v2.enabled=false',
    '--config',
    'cli_auth_credentials_store="file"',
    '--config',
    'web_search="disabled"',
    '--profile',
    profile.name,
    'resume',
    profile.conversationId
  );
  // Unset after tmux's normal exports: neither inherited server credentials nor
  // hooks are available to this restricted process or its one trusted bridge.
  return `env -u CODEMAN_PASSWORD -u CODEMAN_USERNAME -u CODEMAN_HOOK_SECRET -u CODEMAN_HOOK_SECRET_FILE -u CODEMAN_QR_TOKEN -u CODEX_ACCESS_TOKEN -u OPENAI_FEDERATION_RULE_ID -u OPENAI_IDENTITY_TOKEN_FILE -u OPENAI_WORKLOAD_IDENTITY_CONTEXT CODEMAN_SUPERVISOR_SCOPED=1 ${args.map(quote).join(' ')}`;
}

export async function prepareSupervisorManagerLaunch(options: {
  home: string;
  expectedPane: { paneId: string; panePid: number };
  additionalFiles?: readonly PrivateFileWitness[];
  workingDir: string;
  conversationId: string;
  token: string;
  endpoint: string;
  bridgeCommand: string;
  bridgeArgs: readonly string[];
  isCurrent(): boolean;
}): Promise<SupervisorManagerLaunch | undefined> {
  const { home, workingDir, conversationId } = options;
  if (
    process.platform !== 'linux' ||
    !/^%(?:0|[1-9]\d{0,9})$/.test(options.expectedPane.paneId) ||
    !Number.isSafeInteger(options.expectedPane.panePid) ||
    options.expectedPane.panePid <= 0 ||
    !UUID.test(conversationId) ||
    !home ||
    resolve(home) !== home ||
    !options.isCurrent() ||
    pending.has(home) ||
    retirements.has(home) ||
    pending.size + retirements.size >= 2
  )
    return undefined;
  const deadline = performance.now() + 2_000;
  const current = () => performance.now() < deadline && options.isCurrent() === true;
  const name = `codeman-supervisor-${randomUUID()}`;
  const file = join(home, `${name}.config.toml`);
  const privateDirectory = join(home, `.${name}`);
  const credentialFile = join(privateDirectory, 'credential.json');
  let owned: Stats | undefined;
  let credentialOwned: Stats | undefined;
  let directoryOwned: Stats | undefined;
  let homeOwned: Stats | undefined;
  let successful = false;
  let profileText: string | undefined;
  const credentialText = JSON.stringify({ version: 1, url: options.endpoint, token: options.token });
  pending.add(home);
  const work = (async (): Promise<SupervisorManagerLaunch | undefined> => {
    const files: PrivateFileWitness[] = (options.additionalFiles ?? []).map((value) => ({ ...value })),
      missing: string[] = [];
    if (files.length > 4) return undefined;
    const read = async (path: string): Promise<string | undefined> => {
      if (!current()) throw new Error('Manager preparation cancelled');
      let before: Stats;
      try {
        before = await fs.lstat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          missing.push(path);
          return undefined;
        }
        throw error;
      }
      if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE)
        throw new Error('Manager configuration is unverifiable');
      const fd = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const stat = await fd.stat();
        if (!same(before, stat)) throw new Error('Manager configuration changed');
        bytes = await fd.readFile();
        if (bytes.length > MAX_FILE || !same(stat, await fd.stat())) throw new Error('Manager configuration changed');
      } finally {
        await fd.close();
      }
      if (!same(before, await fs.lstat(path)) || !current()) throw new Error('Manager configuration changed');
      files.push({
        path,
        dev: before.dev,
        ino: before.ino,
        size: before.size,
        mtimeMs: before.mtimeMs,
        ctimeMs: before.ctimeMs,
        hash: createHash('sha256').update(bytes).digest('hex'),
        maxBytes: MAX_FILE,
      });
      return bytes.toString('utf8');
    };
    try {
      homeOwned = await fs.lstat(home);
      if (
        (await fs.realpath(home)) !== home ||
        (await fs.realpath(workingDir)) !== resolve(workingDir) ||
        !homeOwned.isDirectory() ||
        homeOwned.isSymbolicLink() ||
        !current()
      )
        return undefined;
      // System/legacy/MDM policy can override CLI restrictions. The supported
      // subset excludes those sources instead of guessing the merged catalog.
      for (const path of [
        '/etc/codex',
        join(home, 'managed_config.toml'),
        join(home, 'cloud-config-bundle-cache.json'),
      ]) {
        try {
          await fs.lstat(path);
          return undefined;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
          missing.push(path);
        }
        if (!current()) return undefined;
      }
      // Existing MCP/plugin catalogs cannot be silently merged into this role.
      // Project config is deliberately refused; owner settings remain untouched.
      const base = await read(join(home, 'config.toml'));
      if (base !== undefined) {
        const config = parse(base);
        if (
          [
            'mcp_servers',
            'plugins',
            'apps',
            'hooks',
            'notify',
            'profiles',
            'profile',
            'forced_login_method',
            'forced_chatgpt_workspace_id',
          ].some((key) => config[key] !== undefined)
        )
          return undefined;
      }
      // A new no-daemon process has no ephemeral auth. Force file-only storage
      // and admit only no stored auth or the documented API-key-only shape.
      // ChatGPT/PAT/agent-identity auth can fetch an enterprise bundle at launch.
      const authText = await read(join(home, 'auth.json'));
      if (authText !== undefined) {
        const auth: unknown = JSON.parse(authText);
        if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return undefined;
        const value = auth as Record<string, unknown>;
        const allowed = new Set([
          'auth_mode',
          'OPENAI_API_KEY',
          'tokens',
          'last_refresh',
          'agent_identity',
          'personal_access_token',
          'bedrock_api_key',
          'bedrock_access_keys',
        ]);
        if (
          Object.keys(value).some((key) => !allowed.has(key)) ||
          (value.auth_mode !== undefined && value.auth_mode !== null && value.auth_mode !== 'apikey') ||
          typeof value.OPENAI_API_KEY !== 'string' ||
          !value.OPENAI_API_KEY.trim() ||
          Object.keys(value).some((key) => !['auth_mode', 'OPENAI_API_KEY'].includes(key) && value[key] !== null)
        )
          return undefined;
      }
      let directory = resolve(workingDir);
      for (let depth = 0; ; depth++) {
        if (depth > 32) return undefined;
        const projectDirectory = join(directory, '.codex');
        const project = join(projectDirectory, 'config.toml');
        let projectPresent = false;
        try {
          const stat = await fs.lstat(projectDirectory);
          if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
          projectPresent = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
          missing.push(projectDirectory);
        }
        if (!current()) return undefined;
        if (projectPresent && project !== join(home, 'config.toml') && (await read(project)) !== undefined)
          return undefined;
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
      await fs.mkdir(privateDirectory, { mode: 0o700 });
      directoryOwned = await fs.lstat(privateDirectory);
      if (!directoryOwned.isDirectory() || directoryOwned.isSymbolicLink() || !current()) return undefined;
      const credentialFd = await fs.open(
        credentialFile,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      try {
        credentialOwned = await credentialFd.stat();
        await credentialFd.writeFile(credentialText);
        await credentialFd.sync();
      } finally {
        await credentialFd.close();
      }
      await read(credentialFile);
      // The bridge gets a path, never the credential in its process arguments.
      const profile = (profileText = stringify({
        features: {
          shell_tool: false,
          apply_patch_freeform: false,
          apps: false,
          multi_agent: false,
          multi_agent_v2: { enabled: false },
          plugins: false,
          hooks: false,
          remote_plugin: false,
        },
        web_search: 'disabled',
        tools: { view_image: false },
        agents: { enabled: false },
        cli_auth_credentials_store: 'file',
        mcp_servers: {
          codeman_supervisor: {
            command: options.bridgeCommand,
            args: [...options.bridgeArgs, '--credential-file', credentialFile],
            enabled_tools: ['supervisor_status', 'supervisor_workers', 'supervisor_assign', 'supervisor_retry'],
            required: true,
          },
        },
      }));
      if (!current() || Buffer.byteLength(profile) > MAX_FILE) return undefined;
      const fd = await fs.open(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      try {
        owned = await fd.stat();
        await fd.writeFile(profile);
        await fd.sync();
      } finally {
        await fd.close();
      }
      const directoryFd = await fs.open(home, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        await directoryFd.sync();
      } finally {
        await directoryFd.close();
      }
      await read(file);
      const privateOwned = await fs.lstat(privateDirectory);
      const preparedHome = homeOwned;
      const artifactFiles = files.filter((value) => value.path === file || value.path === credentialFile);
      if (
        !owned ||
        !credentialOwned ||
        !directoryOwned ||
        privateOwned.dev !== directoryOwned.dev ||
        privateOwned.ino !== directoryOwned.ino ||
        artifactFiles.some((value) => {
          const created = value.path === file ? owned! : credentialOwned!;
          return value.dev !== created.dev || value.ino !== created.ino;
        })
      )
        return undefined;
      let revoked = false;
      let retirement: Promise<boolean> | undefined;
      const permanentCurrent = () => !revoked && options.isCurrent() === true;
      const result: SupervisorManagerLaunch = Object.freeze({
        expectedPane: Object.freeze({ ...options.expectedPane }),
        conversationId,
        home,
        name,
        file,
        files: Object.freeze(files.map((value) => Object.freeze(value))),
        missing: Object.freeze(missing),
        isCurrent: permanentCurrent,
        revoke: () => {
          revoked = true;
          if (retirement) return retirement;
          const responseDeadline = performance.now() + 2_000;
          const before = Promise.allSettled([retirements.get(home) ?? pendingWork.get(home), retirementWork]);
          const cleanup = before
            .then(async () => {
              // Waiting for other homes must not consume this artifact's cleanup budget.
              const limit = performance.now() + 2_000;
              const current = () => performance.now() < limit;
              const directories = [
                [home, preparedHome],
                [privateDirectory, privateOwned],
              ] as const;
              const directoriesCurrent = async () => {
                for (const [path, owned] of directories) {
                  const now = await fs.lstat(path);
                  if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== owned.dev || now.ino !== owned.ino)
                    return false;
                }
                return current();
              };
              try {
                if (!current() || artifactFiles.length !== 2 || !(await directoriesCurrent())) return false;
                if (!(await checkPrivateFileWitnesses(artifactFiles, limit))) return false;
                if (!(await directoriesCurrent())) return false;
                // All file proof descriptors have closed. Recheck both leaves in a
                // common final scan before removing anything; replacements survive.
                for (const witness of artifactFiles) {
                  const now = await fs.lstat(witness.path);
                  if (!same(now, witness) || now.isSymbolicLink() || !now.isFile()) return false;
                }
                if (!current()) return false;
                for (const path of [credentialFile, file]) {
                  if (!(await directoriesCurrent())) return false;
                  const witness = artifactFiles.find((value) => value.path === path)!;
                  const now = await fs.lstat(path);
                  if (!same(now, witness) || !now.isFile() || now.isSymbolicLink() || !current()) return false;
                  await fs.unlink(path);
                }
                if (!(await directoriesCurrent())) return false;
                await fs.rmdir(privateDirectory); // Never recurse into unknown entries.
                return current();
              } catch {
                return false; // Uncertain IO and foreign material remain untouched.
              }
            })
            .finally(() => {
              if (retirements.get(home) === cleanup) retirements.delete(home);
            });
          retirements.set(home, cleanup);
          retirementWork = cleanup;
          retirement = (async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              return await Promise.race([
                cleanup,
                new Promise<false>((resolve) => {
                  timer = setTimeout(() => resolve(false), Math.max(0, responseDeadline - performance.now()));
                }),
              ]);
            } finally {
              if (timer) clearTimeout(timer);
            }
          })();
          return retirement;
        },
        confirm: async () => {
          if (!permanentCurrent() || pending.has(home) || retirements.has(home) || pending.size + retirements.size >= 2)
            return false;
          const limit = performance.now() + 2_000;
          pending.add(home);
          const verify = (async () => {
            try {
              if (!(await checkPrivateFileWitnesses(files, limit))) return false;
              for (const path of missing) {
                try {
                  await fs.lstat(path);
                  return false;
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
                }
                if (!permanentCurrent() || performance.now() >= limit) return false;
              }
              return permanentCurrent() && (await checkPrivateFileWitnesses(files, limit)) && permanentCurrent();
            } catch {
              return false;
            } finally {
              pending.delete(home);
            }
          })();
          pendingWork.set(home, verify);
          void verify.finally(() => {
            if (pendingWork.get(home) === verify) pendingWork.delete(home);
          });
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            const verified = await Promise.race([
              verify,
              new Promise<false>((resolve) => {
                timeout = setTimeout(
                  () => {
                    revoked = true;
                    resolve(false);
                  },
                  Math.max(0, limit - performance.now())
                );
              }),
            ]);
            const accepted = verified && performance.now() < limit && permanentCurrent();
            if (!accepted) void result.revoke();
            return accepted;
          } finally {
            if (timeout) clearTimeout(timeout);
          }
        },
      });
      if (!current()) return undefined;
      issued.add(result);
      successful = true;
      return result;
    } catch {
      return undefined;
    } finally {
      // Every unsuccessful construction retires its known artifacts, including
      // ordinary IO errors while owner authority is still current.
      if (!successful && homeOwned && directoryOwned)
        await (async () => {
          const limit = performance.now() + 2_000;
          const directoriesCurrent = async () => {
            for (const [path, expected] of [
              [home, homeOwned!],
              [privateDirectory, directoryOwned!],
            ] as const) {
              const stat = await fs.lstat(path);
              if (
                !stat.isDirectory() ||
                stat.isSymbolicLink() ||
                stat.dev !== expected.dev ||
                stat.ino !== expected.ino
              )
                return false;
            }
            return performance.now() < limit;
          };
          if (!(await directoriesCurrent())) return;
          const artifacts: PrivateFileWitness[] = [];
          for (const [path, created, text] of [
            [file, owned, profileText],
            [credentialFile, credentialOwned, credentialText],
          ] as const) {
            if (!created) continue; // A failed exclusive open never owns its collision.
            if (text === undefined) return;
            const stat = await fs.lstat(path);
            if (
              !stat.isFile() ||
              stat.isSymbolicLink() ||
              stat.dev !== created.dev ||
              stat.ino !== created.ino ||
              stat.size !== Buffer.byteLength(text)
            )
              return;
            artifacts.push({
              path,
              dev: stat.dev,
              ino: stat.ino,
              size: stat.size,
              mtimeMs: stat.mtimeMs,
              ctimeMs: stat.ctimeMs,
              hash: createHash('sha256').update(text).digest('hex'),
              maxBytes: MAX_FILE,
            });
          }
          if (artifacts.length && !(await checkPrivateFileWitnesses(artifacts, limit))) return;
          if (!(await directoriesCurrent())) return;
          for (const witness of artifacts) if (!same(await fs.lstat(witness.path), witness)) return;
          for (const witness of artifacts) {
            if (
              !(await directoriesCurrent()) ||
              !same(await fs.lstat(witness.path), witness) ||
              performance.now() >= limit
            )
              return;
            await fs.unlink(witness.path);
          }
          if (await directoriesCurrent()) await fs.rmdir(privateDirectory); // Never recurse.
        })().catch(() => {}); // Unknown IO/inodes/bytes are retained.
    }
  })();
  pendingWork.set(home, work);
  void work.finally(() => {
    if (pendingWork.get(home) === work) pendingWork.delete(home);
  });
  void work.finally(() => pending.delete(home));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), Math.max(0, deadline - performance.now()));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
