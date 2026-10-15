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
const same = (a: Stats, b: Stats) =>
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
    'view_image',
    'apps',
    'multi_agent',
    'plugins',
    'hooks',
    'remote_plugin',
    'skill_mcp_dependency_install',
    'code_mode',
  ])
    args.push('--disable', feature);
  args.push('--config', 'web_search="disabled"', '--profile', profile.name, 'resume', profile.conversationId);
  // Unset after tmux's normal exports: neither inherited server credentials nor
  // hooks are available to this restricted process or its one trusted bridge.
  return `env -u CODEMAN_PASSWORD -u CODEMAN_USERNAME -u CODEMAN_HOOK_SECRET -u CODEMAN_HOOK_SECRET_FILE -u CODEMAN_QR_TOKEN CODEMAN_SUPERVISOR_SCOPED=1 ${args.map(quote).join(' ')}`;
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
    !/^%(?:0|[1-9]\d{0,9})$/.test(options.expectedPane.paneId) ||
    !Number.isSafeInteger(options.expectedPane.panePid) ||
    options.expectedPane.panePid <= 0 ||
    !UUID.test(conversationId) ||
    !home ||
    resolve(home) !== home ||
    !options.isCurrent() ||
    pending.has(home) ||
    pending.size >= 2
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
      if (
        (await fs.realpath(home)) !== home ||
        (await fs.realpath(workingDir)) !== resolve(workingDir) ||
        !(await fs.lstat(home)).isDirectory() ||
        !current()
      )
        return undefined;
      // Existing MCP/plugin catalogs cannot be silently merged into this role.
      // Project config is deliberately refused; owner settings remain untouched.
      const base = await read(join(home, 'config.toml'));
      if (base !== undefined) {
        const config = parse(base);
        if (
          ['mcp_servers', 'plugins', 'apps', 'hooks', 'notify', 'profiles', 'profile'].some(
            (key) => config[key] !== undefined
          )
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
        await credentialFd.writeFile(JSON.stringify({ version: 1, url: options.endpoint, token: options.token }));
        await credentialFd.sync();
      } finally {
        await credentialFd.close();
      }
      await read(credentialFile);
      // The bridge gets a path, never the credential in its process arguments.
      const profile = stringify({
        features: {
          shell_tool: false,
          apply_patch_freeform: false,
          view_image: false,
          apps: false,
          multi_agent: false,
          plugins: false,
          hooks: false,
          remote_plugin: false,
        },
        web_search: 'disabled',
        mcp_servers: {
          codeman_supervisor: {
            command: options.bridgeCommand,
            args: [...options.bridgeArgs, '--credential-file', credentialFile],
            enabled_tools: ['supervisor_status', 'supervisor_workers', 'supervisor_assign', 'supervisor_retry'],
            required: true,
          },
        },
      });
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
      let revoked = false;
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
        confirm: async () => {
          if (!permanentCurrent() || pending.has(home) || pending.size >= 2) return false;
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
            return verified && performance.now() < limit && permanentCurrent();
          } finally {
            if (timeout) clearTimeout(timeout);
          }
        },
      });
      if (!current()) return undefined;
      issued.add(result);
      return result;
    } catch {
      return undefined;
    } finally {
      // Failed preparation never deletes a foreign collision or replacement.
      if (!current()) {
        for (const [path, stat] of [
          [file, owned],
          [credentialFile, credentialOwned],
        ] as const)
          if (stat)
            try {
              const now = await fs.lstat(path);
              if (now.dev === stat.dev && now.ino === stat.ino) await fs.unlink(path);
            } catch {
              /* Retain unknown material. */
            }
        if (directoryOwned)
          try {
            const now = await fs.lstat(privateDirectory);
            if (now.dev === directoryOwned.dev && now.ino === directoryOwned.ino) await fs.rmdir(privateDirectory);
          } catch {
            /* Never recurse. */
          }
      }
    }
  })();
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
