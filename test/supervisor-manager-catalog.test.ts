/** Offline catalog subprocesses are strict fakes; only disposable temp directories are real. */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const effects = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const refuse = () => {
    throw Error('All uninjected processes forbidden');
  };
  return {
    ...actual,
    spawn: effects.spawn,
    exec: refuse,
    execFile: refuse,
    execSync: refuse,
    execFileSync: refuse,
    spawnSync: refuse,
    fork: refuse,
  };
});
import {
  readSupervisorManagerCatalog,
  sanitizeSupervisorManagerCatalog,
  MAX_SUPERVISOR_CATALOG_BYTES,
} from '../src/supervisor/manager-catalog.js';

const catalog = () => ({
  models: [
    {
      slug: 'fixture-sol',
      apply_patch_tool_type: 'freeform',
      tool_mode: 'code_mode_only',
      experimental_supported_tools: ['clock', 'send_user_message_async', 'test_sync_tool'],
      context_window: 200000,
      instructions: 'Private fixture café 🧭',
      reasoning: { supported: ['low', 'high'] },
    },
    { slug: 'fixture-disabled', apply_patch_tool_type: null, other: [true, 1, null] },
  ],
});
const raw = () => JSON.stringify(catalog());
const originalNow = performance.now.bind(performance);
let now = 1000;
const children: Array<ReturnType<typeof fakeChild>> = [];
function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => false),
  });
}
function nextChild() {
  let started!: () => void;
  const reached = new Promise<void>((resolve) => (started = resolve));
  const child = fakeChild();
  children.push(child);
  effects.spawn.mockImplementationOnce(() => {
    started();
    return child;
  });
  return { child, reached };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
async function drained() {
  const deadline = originalNow() + 2000;
  const dirs = effects.spawn.mock.calls.map((call) => call[2].cwd as string);
  while (originalNow() < deadline) {
    if (
      (
        await Promise.all(
          dirs.map((dir) =>
            fs.lstat(dir).then(
              () => false,
              (error) => error.code === 'ENOENT'
            )
          )
        )
      ).every(Boolean)
    ) {
      await flush();
      return;
    }
    await flush();
  }
  throw Error('Catalog fixture cleanup did not finish');
}
beforeEach(() => {
  effects.spawn.mockReset();
  now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});
afterEach(async () => {
  for (const child of children.splice(0)) child.emit('close', 1, null);
  await drained();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('clears patch selectors, pins direct mode and preserves other bundled settings', () => {
  const expected = JSON.parse(raw());
  for (const model of expected.models) {
    model.apply_patch_tool_type = null;
    model.tool_mode = 'direct';
    model.experimental_supported_tools = [];
  }
  expect(JSON.parse(sanitizeSupervisorManagerCatalog(raw())!)).toEqual(expected);
});
it.each(['direct', 'code_mode', 'code_mode_only', null, undefined])(
  'pins direct tools despite the model-selected mode %s',
  (tool_mode) => {
    const value = { models: [{ slug: 'fixture', apply_patch_tool_type: null, tool_mode }] };
    expect(JSON.parse(sanitizeSupervisorManagerCatalog(JSON.stringify(value))!).models[0]).toEqual({
      slug: 'fixture',
      apply_patch_tool_type: null,
      tool_mode: 'direct',
      experimental_supported_tools: [],
    });
  }
);
it.each([[], ['clock'], ['send_user_message_async', 'test_sync_tool'], ['future_utility']].map((value) => [value]))(
  'removes every model-selected experimental utility %#',
  (experimental_supported_tools) => {
    const sanitized = sanitizeSupervisorManagerCatalog(
      JSON.stringify({ models: [{ slug: 'fixture', apply_patch_tool_type: null, experimental_supported_tools }] })
    );
    expect(JSON.parse(sanitized!).models[0].experimental_supported_tools).toEqual([]);
  }
);
it.each([null, false, 'clock', {}, [1], [null]].map((value) => [value]))(
  'refuses malformed model utility selectors %#',
  (experimental_supported_tools) => {
    expect(
      sanitizeSupervisorManagerCatalog(
        JSON.stringify({ models: [{ slug: 'fixture', apply_patch_tool_type: null, experimental_supported_tools }] })
      )
    ).toBeUndefined();
  }
);
it.each(['future-mode', '', false, 0, {}, []])('refuses an unknown model tool selector %#', (tool_mode) => {
  expect(
    sanitizeSupervisorManagerCatalog(
      JSON.stringify({ models: [{ slug: 'fixture', apply_patch_tool_type: null, tool_mode }] })
    )
  ).toBeUndefined();
});
it.each([
  'not json',
  '[]',
  '{}',
  '{"models":[]}',
  '{"models":{}}',
  JSON.stringify({ models: Array.from({ length: 129 }, (_, n) => ({ slug: 'm' + n, apply_patch_tool_type: null })) }),
  JSON.stringify({
    models: [
      { slug: 'same', apply_patch_tool_type: null },
      { slug: 'same', apply_patch_tool_type: null },
    ],
  }),
  ...['', '../model', 'x'.repeat(129)].map((slug) =>
    JSON.stringify({ models: [{ slug, apply_patch_tool_type: null }] })
  ),
  ...['function', 'unknown', false, {}, []].map((apply_patch_tool_type) =>
    JSON.stringify({ models: [{ slug: 'm', apply_patch_tool_type }] })
  ),
  '{"models":[{"slug":"m"}]}',
  '{"models":[null]}',
  '{"models":[{"slug":"m","apply_patch_tool_type":null,"size":1e999}]}',
  JSON.stringify({ ...catalog(), unknown: true }),
  ' '.repeat(MAX_SUPERVISOR_CATALOG_BYTES + 1),
])('refuses an unverifiable catalog shape %#', (value) => {
  expect(sanitizeSupervisorManagerCatalog(value)).toBeUndefined();
});

it('reads only the bundled offline command in a new credential-free HOME/cwd', async () => {
  vi.stubEnv('CODEMAN_PASSWORD', 'never-forward-fixture');
  vi.stubEnv('OPENAI_API_KEY', 'never-forward-fixture');
  const { child, reached } = nextChild();
  const reading = readSupervisorManagerCatalog({ deadline: now + 2000, isCurrent: () => true });
  await reached;
  const [command, args, options] = effects.spawn.mock.calls[0];
  expect(command).toBe('codex');
  expect(args).toEqual(['debug', 'models', '--bundled']);
  expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  expect(options.shell).toBeUndefined();
  expect(options.env.HOME).toBe(options.cwd);
  expect(options.env.CODEX_HOME).toBe(options.cwd);
  expect(options.env.XDG_CONFIG_HOME).toBe(options.cwd);
  expect(options.env.TMPDIR).toBe(options.cwd);
  expect(options.cwd).not.toBe(process.env.HOME);
  expect((await fs.lstat(options.cwd)).mode & 0o777).toBe(0o700);
  expect(Object.values(options.env)).not.toContain('never-forward-fixture');
  expect(options.env).not.toHaveProperty('CODEMAN_PASSWORD');
  expect(options.env).not.toHaveProperty('OPENAI_API_KEY');
  for (const byte of Buffer.from(raw())) child.stdout.write(Buffer.from([byte]));
  child.emit('close', 0, null);
  const result = JSON.parse((await reading)!);
  expect(result.models.every((model: { apply_patch_tool_type: unknown }) => model.apply_patch_tool_type === null)).toBe(
    true
  );
  expect(result.models.every((model: { tool_mode: unknown }) => model.tool_mode === 'direct')).toBe(true);
  expect(
    result.models.every(
      (model: { experimental_supported_tools: unknown[] }) => model.experimental_supported_tools.length === 0
    )
  ).toBe(true);
  expect(result.models[0].instructions).toBe(catalog().models[0].instructions);
});
it.each([NaN, Infinity, -1, 1000])('refuses an invalid/expired deadline %s without spawning', async (deadline) => {
  expect(await readSupervisorManagerCatalog({ deadline, isCurrent: () => true })).toBeUndefined();
  expect(effects.spawn).not.toHaveBeenCalled();
});
it.each([
  () => false,
  () => undefined,
  () => Promise.resolve(true),
  () => {
    throw Error('revoked');
  },
])('refuses malformed or cancelled current authority %# before creating a child', async (isCurrent) => {
  expect(
    await readSupervisorManagerCatalog({ deadline: now + 2000, isCurrent: isCurrent as () => boolean })
  ).toBeUndefined();
  expect(effects.spawn).not.toHaveBeenCalled();
});
it.each(['stdout-overflow', 'stderr-overflow', 'error', 'stdout-error', 'stderr-error', 'timeout', 'cancel'] as const)(
  'returns unknown after %s and retains the temporary home until actual close',
  async (fault) => {
    let current = true;
    const { child, reached } = nextChild();
    const reading = readSupervisorManagerCatalog({ deadline: now + 2000, isCurrent: () => current });
    await reached;
    const dir = effects.spawn.mock.calls[0][2].cwd;
    if (fault === 'stdout-overflow') child.stdout.write(Buffer.alloc(MAX_SUPERVISOR_CATALOG_BYTES + 1));
    else if (fault === 'stderr-overflow') child.stderr.write(Buffer.alloc(16385));
    else if (fault === 'timeout') {
      now += 2001;
      await vi.advanceTimersByTimeAsync(2001);
    } else if (fault === 'cancel') {
      current = false;
      await vi.advanceTimersByTimeAsync(25);
    } else if (fault === 'error') child.emit('error', Error('Missing binary'));
    else child[fault === 'stdout-error' ? 'stdout' : 'stderr'].emit('error', Error('Bad pipe'));
    expect(await reading).toBeUndefined();
    expect(child.kill).toHaveBeenCalledOnce();
    expect((await fs.lstat(dir)).isDirectory()).toBe(true);
    child.stdout.write(raw());
    child.emit('close', 0, null);
    await drained();
    await expect(fs.lstat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  }
);
it.each(['kill-false', 'kill-throws'] as const)('caps two unclosed failed children after %s', async (fault) => {
  const retained = [nextChild(), nextChild()];
  for (const f of retained) {
    if (fault === 'kill-throws')
      f.child.kill.mockImplementation(() => {
        throw Error('kill failed');
      });
    const reading = readSupervisorManagerCatalog({ deadline: now + 2000, isCurrent: () => true });
    await f.reached;
    f.child.emit('error', Error('Failed process'));
    expect(await reading).toBeUndefined();
  }
  expect(await readSupervisorManagerCatalog({ deadline: now + 2000, isCurrent: () => true })).toBeUndefined();
  expect(effects.spawn).toHaveBeenCalledTimes(2);
  retained[0].child.emit('close', 1, null);
  const firstDir = effects.spawn.mock.calls[0][2].cwd;
  const until = originalNow() + 2000;
  while (
    originalNow() < until &&
    (await fs.lstat(firstDir).then(
      () => true,
      () => false
    ))
  )
    await flush();
  await flush();
  const fresh = nextChild();
  const reading = readSupervisorManagerCatalog({ deadline: now + 2000, isCurrent: () => true });
  await fresh.reached;
  fresh.child.stdout.write(raw());
  fresh.child.emit('close', 0, null);
  expect(await reading).toBeDefined();
  expect(effects.spawn).toHaveBeenCalledTimes(3);
});
it.each(['exit', 'signal', 'malformed', 'utf8'] as const)(
  'rejects unsuccessful/unknown native output: %s',
  async (fault) => {
    const { child, reached } = nextChild();
    const reading = readSupervisorManagerCatalog({ deadline: now + 2000, isCurrent: () => true });
    await reached;
    child.stdout.write(fault === 'malformed' ? '{}' : fault === 'utf8' ? Buffer.from([0xff]) : raw());
    child.emit('close', fault === 'exit' ? 1 : 0, fault === 'signal' ? 'SIGTERM' : null);
    expect(await reading).toBeUndefined();
  }
);
it('rechecks cancellation after the child closes before returning its catalog', async () => {
  let current = true;
  const { child, reached } = nextChild();
  const reading = readSupervisorManagerCatalog({ deadline: now + 2000, isCurrent: () => current });
  await reached;
  child.stdout.write(raw());
  child.emit('close', 0, null);
  current = false;
  expect(await reading).toBeUndefined();
});
it('retains a child which returns from spawn after its original deadline', async () => {
  const child = fakeChild();
  children.push(child);
  effects.spawn.mockImplementationOnce(() => {
    now += 2001;
    return child;
  });
  const reading = readSupervisorManagerCatalog({ deadline: now + 2000, isCurrent: () => true });
  await flush();
  expect(await reading).toBeUndefined();
  expect(child.kill).toHaveBeenCalledOnce();
  expect(effects.spawn).toHaveBeenCalledOnce();
});
