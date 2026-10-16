/** Offline bundled model metadata for a private restricted-manager catalog. */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

export const MAX_SUPERVISOR_CATALOG_BYTES = 1_048_576;
let active = 0;

/** Preserve native metadata while pinning the restricted manager's tool selectors. */
export function sanitizeSupervisorManagerCatalog(raw: string): string | undefined {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_SUPERVISOR_CATALOG_BYTES) return undefined;
  try {
    const value = JSON.parse(raw, (_key, item: unknown) => {
      if (typeof item === 'number' && !Number.isFinite(item)) throw Error('Invalid catalog number');
      return item;
    });
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      !Array.isArray(value.models) ||
      value.models.length === 0 ||
      value.models.length > 128
    )
      return undefined;
    const slugs = new Set<string>();
    for (const model of value.models) {
      if (
        !model ||
        typeof model !== 'object' ||
        Array.isArray(model) ||
        typeof model.slug !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model.slug) ||
        slugs.has(model.slug) ||
        !Object.hasOwn(model, 'apply_patch_tool_type') ||
        (model.apply_patch_tool_type !== null && model.apply_patch_tool_type !== 'freeform') ||
        (model.tool_mode !== undefined &&
          model.tool_mode !== null &&
          !['direct', 'code_mode', 'code_mode_only'].includes(model.tool_mode))
      )
        return undefined;
      slugs.add(model.slug);
      model.apply_patch_tool_type = null;
      model.tool_mode = 'direct';
    }
    const result = JSON.stringify(value);
    return Buffer.byteLength(result) <= MAX_SUPERVISOR_CATALOG_BYTES ? result : undefined;
  } catch {
    return undefined;
  }
}

/** Never starts an agent: this command only prints the CLI's embedded catalog. */
export async function readSupervisorManagerCatalog(options: {
  deadline: number;
  isCurrent(): boolean;
}): Promise<string | undefined> {
  if (!Number.isFinite(options.deadline)) return undefined;
  const deadline = Math.min(options.deadline, performance.now() + 2_000);
  let cancelled = false;
  const current = () => {
    try {
      const verdict: unknown = options.isCurrent();
      if (verdict && typeof (verdict as { then?: unknown }).then === 'function')
        void Promise.resolve(verdict).catch(() => {});
      return !cancelled && Number.isFinite(deadline) && performance.now() < deadline && verdict === true;
    } catch {
      return false;
    }
  };
  if (!current() || active >= 2) return undefined;
  active++;
  let child: ReturnType<typeof spawn> | undefined;
  let directory: string | undefined, owned: Stats | undefined;
  let finish!: (value: string | undefined) => void;
  let settled = false;
  const result = new Promise<string | undefined>((resolve) => {
    finish = (value) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (poll) clearInterval(poll);
      resolve(value);
    };
  });
  const fail = () => {
    if (settled) return;
    cancelled = true;
    finish(undefined);
    try {
      child?.kill();
    } catch {
      /* Keep the slot until actual close. */
    }
  };
  const timeout = setTimeout(fail, Math.max(1, Math.ceil(deadline - performance.now())));
  const poll = setInterval(() => {
    if (!current()) fail();
  }, 25);
  const work = (async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'codeman-manager-catalog-'));
    owned = await fs.lstat(directory);
    if (!owned.isDirectory() || owned.isSymbolicLink() || (owned.mode & 0o077) !== 0 || !current()) return;
    const before = await fs.lstat(directory);
    if (before.dev !== owned.dev || before.ino !== owned.ino || before.isSymbolicLink() || !current()) return;
    child = spawn('codex', ['debug', 'models', '--bundled'], {
      cwd: directory,
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: directory,
        CODEX_HOME: directory,
        XDG_CONFIG_HOME: directory,
        XDG_DATA_HOME: directory,
        XDG_CACHE_HOME: directory,
        XDG_STATE_HOME: directory,
        TMPDIR: directory,
        TMP: directory,
        TEMP: directory,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    let size = 0,
      errors = 0;
    await new Promise<void>((resolve) => {
      child!.once('close', (code, signal) => {
        if (!settled && current() && code === 0 && signal === null) {
          try {
            finish(
              sanitizeSupervisorManagerCatalog(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(stdout)))
            );
          } catch {
            finish(undefined);
          }
        } else finish(undefined);
        resolve();
      });
      child!.on('error', fail);
      child!.stdout?.on('error', fail);
      child!.stderr?.on('error', fail);
      child!.stdout?.on('data', (chunk: Buffer) => {
        if (settled) return;
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_SUPERVISOR_CATALOG_BYTES) {
          fail();
          return;
        }
        stdout.push(bytes);
      });
      child!.stderr?.on('data', (chunk: Buffer) => {
        if (settled) return;
        errors += Buffer.byteLength(chunk);
        if (errors > 16_384) fail();
      });
      if (!current()) fail();
    });
  })();
  void work.catch(fail).finally(async () => {
    finish(undefined);
    // A failed/unkillable child retains both its slot and temporary HOME until
    // close. Never remove a replacement path or any existing user directory.
    try {
      if (directory && owned) {
        const now = await fs.lstat(directory);
        if (now.isDirectory() && !now.isSymbolicLink() && now.dev === owned.dev && now.ino === owned.ino)
          await fs.rm(directory, { recursive: true, force: false });
      }
    } catch {
      /* Unknown replacement/cleanup failure is never a launch proof. */
    } finally {
      active--;
    }
  });
  const value = await result;
  return current() ? value : undefined;
}
