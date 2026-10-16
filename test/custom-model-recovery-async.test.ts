/** Recovery profile IO is bounded; unknown and late work never become absence or new launch authority. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, constants } from 'node:fs';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { customModelConfigDir } from '../src/custom-model-injection-apply.js';
import { writeCustomModelHosts } from '../src/custom-model-hosts.js';
import { getDataDir } from '../src/config/instance.js';
import { getCli } from '../src/config/cli-registry/registry.js';
import { buildCustomModelInjection } from '../src/custom-model-injection.js';
import {
  probeRecoveryDirectory,
  rebuildPersistedCustomModelEnv,
  removeCreatedRecoveryProfile,
  type CreatedRecoveryProfile,
} from '../src/custom-model-recovery.js';

const syncProfileIO = vi.hoisted(() => ({ prefix: '', calls: 0 }));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    mkdirSync: (...args: Parameters<typeof actual.mkdirSync>) => {
      if (syncProfileIO.prefix && String(args[0]).startsWith(syncProfileIO.prefix)) syncProfileIO.calls++;
      return actual.mkdirSync(...args);
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (syncProfileIO.prefix && String(args[0]).startsWith(syncProfileIO.prefix)) syncProfileIO.calls++;
      return actual.writeFileSync(...args);
    },
  };
});

const endpoint = {
  id: 'async-endpoint',
  label: 'Fixture',
  baseUrl: 'http://endpoint.invalid',
  apiKey: 'fixture-key',
  models: ['model'],
};
const saved = { endpointId: endpoint.id, modelId: 'model', envKeys: ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY'] };
let root: string;
let oldData: string | undefined;
const releases: Array<() => void> = [];
function barrier() {
  let entered!: () => void, release!: () => void;
  const at = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  return { at, held, entered, release };
}
beforeEach(async () => {
  syncProfileIO.prefix = '';
  syncProfileIO.calls = 0;
  oldData = process.env.CODEMAN_DATA_DIR;
  root = mkdtempSync(join(homedir(), 'async-profile-'));
  process.env.CODEMAN_DATA_DIR = root;
  await writeCustomModelHosts(root, [endpoint]);
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  vi.useRealTimers();
  await new Promise<void>((resolve) => setImmediate(resolve));
  vi.restoreAllMocks();
  if (oldData === undefined) delete process.env.CODEMAN_DATA_DIR;
  else process.env.CODEMAN_DATA_DIR = oldData;
  rmSync(root, { recursive: true, force: true });
});

it('distinguishes existing, missing, non-directory, and unverifiable profile paths', async () => {
  const path = customModelConfigDir('probe');
  expect(await probeRecoveryDirectory(path)).toEqual({ status: 'absent' });
  mkdirSync(path, { recursive: true });
  expect(await probeRecoveryDirectory(path)).toMatchObject({ status: 'present' });
  const file = join(root, 'file');
  writeFileSync(file, 'keep');
  expect(await probeRecoveryDirectory(file)).toEqual({ status: 'unknown' });
  const lstat = fs.lstat.bind(fs);
  vi.spyOn(fs, 'lstat').mockImplementation((target, ...args) => {
    if (String(target) === path) return Promise.reject(Object.assign(new Error('unreadable'), { code: 'EACCES' }));
    return lstat(target, ...args);
  });
  expect(await probeRecoveryDirectory(path)).toEqual({ status: 'unknown' });
  expect(readFileSync(file, 'utf8')).toBe('keep');
});

it('bounds a retained directory lookup and refuses a second attempt until it actually settles', async () => {
  vi.useFakeTimers();
  const path = customModelConfigDir('held-probe'),
    stage = barrier(),
    lstat = fs.lstat.bind(fs);
  let calls = 0;
  vi.spyOn(fs, 'lstat').mockImplementation(async (target, ...args) => {
    if (String(target) === path) {
      calls++;
      stage.entered();
      await stage.held;
    }
    return lstat(target, ...args);
  });
  const first = probeRecoveryDirectory(path);
  await stage.at;
  await vi.advanceTimersByTimeAsync(2000);
  expect(await first).toEqual({ status: 'unknown' });
  expect(await probeRecoveryDirectory(path)).toEqual({ status: 'unknown' });
  expect(await rebuildPersistedCustomModelEnv('claude', 'held-probe', saved, root)).toBeUndefined();
  expect(calls).toBe(1);
  expect(existsSync(path)).toBe(false);
  stage.release();
  vi.useRealTimers();
  await vi.waitFor(async () => expect(await probeRecoveryDirectory(path)).toEqual({ status: 'absent' }));
});

it.each(['cancelled', 'expired'] as const)(
  'a %s preflight cannot become permission to create a profile',
  async (kind) => {
    vi.useFakeTimers();
    const path = customModelConfigDir('preflight'),
      stage = barrier(),
      lstat = fs.lstat.bind(fs);
    let allowed = true;
    vi.spyOn(fs, 'lstat').mockImplementation(async (target, ...args) => {
      if (String(target) === path) {
        stage.entered();
        await stage.held;
      }
      return lstat(target, ...args);
    });
    const result = rebuildPersistedCustomModelEnv('claude', 'preflight', saved, root, { isCurrent: () => allowed });
    await stage.at;
    if (kind === 'cancelled') allowed = false;
    else await vi.advanceTimersByTimeAsync(2000);
    stage.release();
    expect(await result).toBeUndefined();
    expect(existsSync(path)).toBe(false);
  }
);

it('shares the original preflight deadline with profile rebuilding', async () => {
  vi.useFakeTimers();
  const path = customModelConfigDir('shared'),
    stage = barrier(),
    lstat = fs.lstat.bind(fs);
  const deadline = performance.now() + 2000;
  vi.spyOn(fs, 'lstat').mockImplementation(async (target, ...args) => {
    if (String(target) === path) {
      stage.entered();
      await stage.held;
    }
    return lstat(target, ...args);
  });
  const probe = probeRecoveryDirectory(path, () => true, false, deadline);
  await stage.at;
  await vi.advanceTimersByTimeAsync(1900);
  stage.release();
  const directory = await probe;
  expect(directory).toEqual({ status: 'absent' });
  await vi.advanceTimersByTimeAsync(100);
  expect(
    await rebuildPersistedCustomModelEnv('claude', 'shared', saved, root, { directory, deadline })
  ).toBeUndefined();
  expect(existsSync(path)).toBe(false);
});

it('retains timed-out write ownership until actual close, then rebuilds only the current endpoint', async () => {
  vi.useFakeTimers();
  const path = customModelConfigDir('late-write'),
    stage = barrier(),
    open = fs.open.bind(fs);
  let held = false,
    closed!: () => void;
  const closure = new Promise<void>((resolve) => {
    closed = resolve;
  });
  vi.spyOn(fs, 'open').mockImplementation(async (target, flags, mode) => {
    const handle = await open(target, flags, mode);
    if (
      !held &&
      String(target).startsWith(join(path, '.claude.json') + '.recovery-') &&
      (Number(flags) & constants.O_CREAT) !== 0
    ) {
      held = true;
      const write = handle.writeFile.bind(handle),
        close = handle.close.bind(handle);
      vi.spyOn(handle, 'writeFile').mockImplementation(async (...args) => {
        stage.entered();
        await stage.held;
        return write(...args);
      });
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        await close();
        closed();
      });
    }
    return handle;
  });
  const first = rebuildPersistedCustomModelEnv('claude', 'late-write', saved, root);
  await stage.at;
  await vi.advanceTimersByTimeAsync(2000);
  expect(await first).toBeUndefined();
  await writeCustomModelHosts(root, [{ ...endpoint, apiKey: 'current-new-key' }]);
  expect(await rebuildPersistedCustomModelEnv('claude', 'late-write', saved, root)).toBeUndefined();
  stage.release();
  await closure;
  vi.useRealTimers();
  await vi.waitFor(async () => {
    const env = await rebuildPersistedCustomModelEnv('claude', 'late-write', saved, root);
    expect(env?.ANTHROPIC_API_KEY).toBe('current-new-key');
  });
  expect(JSON.parse(readFileSync(join(path, '.claude.json'), 'utf8')).customApiKeyResponses.approved).toContain(
    'current-new-key'
  );
});

it.each(['healthy', 'foreign-file', 'changed-file', 'replacement'] as const)(
  'cleans only acknowledged created profile material: %s',
  async (change) => {
    let receipt: CreatedRecoveryProfile | undefined;
    const path = customModelConfigDir('cleanup');
    expect(
      await rebuildPersistedCustomModelEnv('claude', 'cleanup', saved, root, {
        onCreated: (value) => {
          receipt = value;
        },
      })
    ).toMatchObject({ CLAUDE_CONFIG_DIR: path });
    expect(receipt).toBeDefined();
    if (change === 'foreign-file') writeFileSync(join(path, 'conversation.jsonl'), 'owner history');
    if (change === 'changed-file') writeFileSync(join(path, '.claude.json'), 'owner changed profile');
    if (change === 'replacement') {
      await fs.rename(path, path + '.original');
      mkdirSync(path);
      writeFileSync(join(path, 'keep'), 'replacement');
    }
    expect(await removeCreatedRecoveryProfile(receipt!)).toBe(change === 'healthy');
    expect(existsSync(path)).toBe(change !== 'healthy');
    if (change === 'foreign-file') expect(readFileSync(join(path, 'conversation.jsonl'), 'utf8')).toBe('owner history');
    if (change === 'changed-file')
      expect(readFileSync(join(path, '.claude.json'), 'utf8')).toBe('owner changed profile');
    if (change === 'replacement') expect(readFileSync(join(path, 'keep'), 'utf8')).toBe('replacement');
  }
);

it('never takes cleanup ownership of a preexisting conversation home', async () => {
  const path = customModelConfigDir('existing');
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, '.claude.json'),
    JSON.stringify({ machineID: 'keep', projects: { other: { hasTrustDialogAccepted: false } } })
  );
  const created = vi.fn();
  const env = await rebuildPersistedCustomModelEnv('claude', 'existing', saved, root, { onCreated: created });
  expect(env?.CLAUDE_CONFIG_DIR).toBe(path);
  expect(created).not.toHaveBeenCalled();
  expect(JSON.parse(readFileSync(join(path, '.claude.json'), 'utf8'))).toMatchObject({
    machineID: 'keep',
    projects: { other: { hasTrustDialogAccepted: false } },
  });
  expect(getDataDir()).toBe(root);
});

it('rebuilds the same launch recipe without synchronous profile writes', async () => {
  const path = customModelConfigDir('async-only');
  syncProfileIO.prefix = path;
  const result = await rebuildPersistedCustomModelEnv('claude', 'async-only', saved, root);
  syncProfileIO.prefix = '';
  expect(result).toMatchObject({ CLAUDE_CONFIG_DIR: path, ANTHROPIC_API_KEY: endpoint.apiKey });
  expect(syncProfileIO.calls).toBe(0);
  const profile = JSON.parse(readFileSync(join(path, '.claude.json'), 'utf8'));
  expect(profile.hasCompletedOnboarding).toBe(true);
  expect(profile.projects[root].hasTrustDialogAccepted).toBe(true);
});

it.each(['codex', 'pi', 'grok', 'omp'])(
  'rebuilds exact current %s config files, including nested profiles',
  async (mode) => {
    const path = customModelConfigDir(`recipe-${mode}`);
    const recipe = buildCustomModelInjection(getCli(mode)!, endpoint, 'model');
    expect(recipe.kind).toBe('configDir');
    if (recipe.kind !== 'configDir') throw Error('Fixture must exercise actual config files');
    let created: CreatedRecoveryProfile | undefined;
    const result = await rebuildPersistedCustomModelEnv(mode, `recipe-${mode}`, saved, root, {
      onCreated: (value) => {
        created = value;
      },
    });
    expect(result).toEqual({ [recipe.dirEnvVar]: path, ...recipe.extraEnv });
    for (const file of recipe.files) expect(readFileSync(join(path, file.relPath), 'utf8')).toBe(file.content);
    expect(await removeCreatedRecoveryProfile(created!)).toBe(true);
    expect(existsSync(path)).toBe(false);
  }
);

it.each(['cancel', 'deadline', 'partial-write', 'zero-write', 'sync-error'] as const)(
  'an existing shorter profile stays byte-exact when its staged replacement fails: %s',
  async (fault) => {
    const path = customModelConfigDir('atomic-existing'),
      target = join(path, 'settings.json');
    mkdirSync(path, { recursive: true });
    const prior = JSON.stringify(
      { ownerField: 'keep', skipDangerousModePermissionPrompt: 'long prior value '.repeat(200) },
      null,
      2
    );
    writeFileSync(target, prior, { mode: 0o600 });
    let allowed = true,
      reached = false;
    const deadline = performance.now() + 2000,
      open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const file = await open(...args);
      if (
        (String(args[0]) === target || String(args[0]).startsWith(target + '.recovery-')) &&
        (Number(args[1]) & 3) !== 0
      ) {
        const write = file.writeFile.bind(file),
          sync = file.sync.bind(file);
        file.writeFile = async (...input) => {
          reached = true;
          if (fault === 'partial-write' || fault === 'zero-write') {
            const bytes = Buffer.from(String(input[0]));
            await write(bytes.subarray(0, fault === 'zero-write' ? 0 : bytes.length - 2));
            throw Object.assign(Error('Partial disk write'), { code: 'ENOSPC' });
          }
          await write(...input);
          if (fault === 'cancel') allowed = false;
          if (fault === 'deadline') vi.spyOn(performance, 'now').mockReturnValue(deadline);
        };
        file.sync = async () => {
          if (fault === 'sync-error') throw Error('Unacknowledged staged bytes');
          return sync();
        };
      }
      return file;
    });
    expect(
      await rebuildPersistedCustomModelEnv('claude', 'atomic-existing', saved, root, {
        isCurrent: () => allowed,
        deadline,
      })
    ).toBeUndefined();
    expect(reached).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe(prior);
    expect(JSON.parse(readFileSync(target, 'utf8')).ownerField).toBe('keep');
    expect((await fs.readdir(path)).filter((name) => name.includes('.recovery-'))).toEqual([]);
  }
);
it('publishes an existing shorter JSON profile atomically with exact bytes and private permissions', async () => {
  const path = customModelConfigDir('atomic-healthy'),
    target = join(path, 'settings.json');
  mkdirSync(path, { recursive: true });
  writeFileSync(
    target,
    JSON.stringify({ ownerField: 'keep', skipDangerousModePermissionPrompt: 'long '.repeat(200) }),
    { mode: 0o600 }
  );
  const before = await fs.lstat(target);
  expect(await rebuildPersistedCustomModelEnv('claude', 'atomic-healthy', saved, root)).toMatchObject({
    CLAUDE_CONFIG_DIR: path,
  });
  const text = readFileSync(target, 'utf8');
  expect(text).toBe(JSON.stringify({ ownerField: 'keep', skipDangerousModePermissionPrompt: true }, null, 2));
  expect((await fs.lstat(target)).ino).not.toBe(before.ino);
  expect((await fs.lstat(target)).mode & 0o077).toBe(0);
  expect((await fs.readdir(path)).filter((name) => name.includes('.recovery-'))).toEqual([]);
});
it.each(['primary', 'temporary', 'parent'] as const)(
  'preserves a foreign %s replacement during staging',
  async (fault) => {
    const path = customModelConfigDir('atomic-foreign'),
      target = join(path, 'settings.json');
    mkdirSync(path, { recursive: true });
    const prior = JSON.stringify({ ownerField: 'keep', skipDangerousModePermissionPrompt: false });
    writeFileSync(target, prior, { mode: 0o600 });
    const open = fs.open.bind(fs);
    let stage = '',
      changed = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const file = await open(...args);
      if (String(args[0]).startsWith(target + '.recovery-')) {
        stage = String(args[0]);
        const close = file.close.bind(file);
        file.close = async () => {
          await close();
          if (changed) return;
          changed = true;
          if (fault === 'temporary') {
            const text = await fs.readFile(stage);
            await fs.rename(stage, stage + '.owned');
            await fs.writeFile(stage, text, { mode: 0o600 });
          } else if (fault === 'primary') {
            await fs.rename(target, target + '.owned');
            await fs.writeFile(target, 'foreign owner bytes', { mode: 0o600 });
          } else {
            await fs.rename(path, path + '.owned');
            await fs.mkdir(path, { mode: 0o700 });
            await fs.writeFile(target, 'foreign parent bytes', { mode: 0o600 });
          }
        };
      }
      return file;
    });
    expect(await rebuildPersistedCustomModelEnv('claude', 'atomic-foreign', saved, root)).toBeUndefined();
    expect(changed).toBe(true);
    if (fault === 'temporary') {
      expect(readFileSync(target, 'utf8')).toBe(prior);
      expect(await fs.readFile(stage, 'utf8')).toContain('skipDangerousModePermissionPrompt');
    } else
      expect(readFileSync(target, 'utf8')).toBe(fault === 'primary' ? 'foreign owner bytes' : 'foreign parent bytes');
  }
);
