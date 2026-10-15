/** Real metadata methods, disposable files, and held asynchronous filesystem ACKs; no native effects. */
import fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { TmuxManager as Manager } from '../src/tmux-manager.js';
import type { MuxSession } from '../src/mux-interface.js';
const io = vi.hoisted(() => ({
  stage: '',
  entered: undefined as (() => void) | undefined,
  held: undefined as Promise<void> | undefined,
  failure: '',
  error: new Error('Fixture metadata ACK failed'),
  commits: 0,
  temporary: '',
}));
vi.mock('node:child_process', () => {
  const refused = () => {
    throw new Error('Native effects forbidden in metadata tests');
  };
  return {
    exec: refused,
    execSync: refused,
    execFile: refused,
    execFileSync: refused,
    spawn: refused,
    spawnSync: refused,
  };
});
vi.mock('node-pty', () => ({
  spawn: () => {
    throw new Error('PTY effects forbidden');
  },
}));
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  const pause = async (stage: string) => {
    if (io.stage !== stage) return;
    io.stage = '';
    io.entered?.();
    await io.held;
  };
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const path = String(args[0]);
      if (path.endsWith('.reboot.tmp') && args[1] === 'wx') {
        io.temporary = path;
        if (io.failure === 'wx-collision') await real.writeFile(path, 'foreign temporary');
      }
      if (io.failure === 'primary-read' && path.endsWith('mux-sessions.json'))
        throw Object.assign(new Error('Unreadable primary'), { code: 'EACCES' });
      const file = await real.open(...args);
      const candidate = path.endsWith('.reboot.tmp');
      if (candidate) await pause('open');
      return new Proxy(file, {
        get(target, key) {
          if (key === 'writeFile')
            return async (...input: Parameters<typeof file.writeFile>) => {
              if (candidate) {
                await pause('write');
                if (io.failure === 'write') throw io.error;
              }
              return target.writeFile(...input);
            };
          if (key === 'sync')
            return async () => {
              const directory = (await target.stat()).isDirectory();
              if (directory) {
                await pause('directory-sync');
                if (io.failure === 'directory-sync') throw io.error;
              } else if (candidate) await pause('file-sync');
              return target.sync();
            };
          if (key === 'close')
            return async () => {
              const directory = (await target.stat()).isDirectory();
              if (path.endsWith('.reboot.tmp') && typeof args[1] === 'number') await pause('temp-proof-close');
              if (candidate) await pause('close');
              else if (directory) await pause('directory-close');
              return target.close();
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    rename: async (...args: Parameters<typeof real.rename>) => {
      if (String(args[0]).endsWith('.reboot.tmp')) {
        await pause('rename');
        await real.rename(...args);
        io.commits++;
        if (io.failure === 'rename-ack') throw io.error;
        return;
      }
      return real.rename(...args);
    },
    lstat: async (...args: Parameters<typeof real.lstat>) => {
      if (String(args[0]).endsWith('.reboot.tmp') && io.commits > 0) await pause('success-cleanup');
      return real.lstat(...args);
    },
    writeFile: async (...args: Parameters<typeof real.writeFile>) => {
      await pause('ordinary-write');
      return real.writeFile(...args);
    },
  };
});
let TmuxManager: typeof import('../src/tmux-manager.js').TmuxManager;
let root: string, path: string, previousData: string | undefined, manager: Manager;
let release: (() => void) | undefined;
const record = (pid = 10) =>
  ({ sessionId: 'metadata-fixture', muxName: 'codeman_fixture', pid, codexRestoreUncertain: true }) as MuxSession;
beforeAll(async () => {
  root = fs.mkdtempSync(join(homedir(), 'reboot-async-mux-'));
  path = join(root, 'mux-sessions.json');
  previousData = process.env.CODEMAN_DATA_DIR;
  process.env.CODEMAN_DATA_DIR = root;
  const previousVitest = process.env.VITEST;
  delete process.env.VITEST;
  try {
    ({ TmuxManager } = await import('../src/tmux-manager.js'));
  } finally {
    if (previousVitest === undefined) delete process.env.VITEST;
    else process.env.VITEST = previousVitest;
  }
});
beforeEach(() => {
  manager = Object.create(TmuxManager.prototype) as Manager;
  Object.assign(manager, {
    sessions: new Map([['metadata-fixture', record()]]),
    sessionSaves: Promise.resolve(),
    sessionPersistenceUnknown: false,
  });
  fs.writeFileSync(path, JSON.stringify([record(1)]));
  Object.assign(io, { stage: '', entered: undefined, held: undefined, failure: '', commits: 0 });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  release?.();
  release = undefined;
  io.stage = '';
  io.failure = '';
  await manager.drainSessionSaves?.();
  vi.restoreAllMocks();
});
afterAll(() => {
  if (previousData === undefined) delete process.env.CODEMAN_DATA_DIR;
  else process.env.CODEMAN_DATA_DIR = previousData;
  fs.rmSync(root, { recursive: true, force: true });
});
function hold(stage: string) {
  io.stage = stage;
  const entered = new Promise<void>((resolve) => {
    io.entered = resolve;
  });
  io.held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return entered;
}
async function reached(entered: Promise<void>, operation: Promise<unknown>) {
  await Promise.race([
    entered,
    operation.then(
      () => {
        throw Error('Commit bypassed async filesystem barrier');
      },
      (error) => {
        throw error;
      }
    ),
  ]);
}
function change(pid: number) {
  (Reflect.get(manager, 'sessions') as Map<string, MuxSession>).set('metadata-fixture', record(pid));
}
function ordinary() {
  Reflect.get(manager, 'saveSessions').call(manager);
}
const disk = () => JSON.parse(fs.readFileSync(path, 'utf8')) as MuxSession[];

it('keeps the event loop responsive while the actual metadata FileHandle write is held', async () => {
  const entered = hold('write');
  const operation = manager.flushSessionsDurably();
  await reached(entered, operation);
  let timer = false;
  await new Promise<void>((resolve) =>
    setTimeout(() => {
      timer = true;
      resolve();
    }, 0)
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(timer).toBe(true);
  expect(disk()[0].pid).toBe(1);
  release!();
  await operation;
  expect(disk()[0].pid).toBe(10);
});
it.each(['open', 'write', 'file-sync', 'close'])(
  'refuses owner revocation during %s before publishing metadata',
  async (stage) => {
    let current = true;
    const entered = hold(stage);
    const operation = manager.flushSessionsDurably(() => current);
    const rejected = expect(operation).rejects.toThrow('cancelled');
    await reached(entered, operation);
    current = false;
    release!();
    await rejected;
    expect(disk()[0].pid).toBe(1);
    expect(io.commits).toBe(0);
  }
);
it.each(['rename', 'directory-sync', 'directory-close', 'success-cleanup'])(
  'retains uncertain committed metadata after cancellation during %s',
  async (stage) => {
    let current = true;
    const entered = hold(stage);
    const operation = manager.flushSessionsDurably(() => current);
    const rejected = expect(operation).rejects.toThrow('cancelled');
    await reached(entered, operation);
    current = false;
    release!();
    await rejected;
    expect(disk()[0].pid).toBe(10);
    expect(Reflect.get(manager, 'sessionPersistenceUnknown')).toBe(true);
    change(20);
    ordinary();
    await manager.drainSessionSaves();
    expect(disk()[0].pid).toBe(10);
    await manager.flushSessionsDurably();
    expect(disk()[0].pid).toBe(20);
    expect(Reflect.get(manager, 'sessionPersistenceUnknown')).toBe(false);
  }
);
it('does not overwrite a concurrent map edit with its staged snapshot, and drains the newer queued save', async () => {
  const entered = hold('write');
  const operation = manager.flushSessionsDurably();
  const rejected = expect(operation).rejects.toThrow('cancelled');
  await reached(entered, operation);
  change(20);
  ordinary();
  release!();
  await rejected;
  await manager.drainSessionSaves();
  expect(disk()[0].pid).toBe(20);
});
it('takes its snapshot after an older ordinary write and serializes both strict commits', async () => {
  const entered = hold('ordinary-write');
  ordinary();
  await entered;
  change(20);
  const first = manager.flushSessionsDurably();
  const second = manager.flushSessionsDurably();
  release!();
  await Promise.all([first, second]);
  expect(disk()[0].pid).toBe(20);
  expect(io.commits).toBe(2);
});
it('keeps shutdown draining until writes enqueued by request cleanup settle', async () => {
  const entered = hold('ordinary-write');
  ordinary();
  await entered;
  let done = false;
  const drain = manager.drainSessionSaves().then(() => {
    done = true;
  });
  change(20);
  ordinary();
  await Promise.resolve();
  expect(done).toBe(false);
  release!();
  await drain;
  expect(disk()[0].pid).toBe(20);
});
it.each(['write', 'rename-ack', 'directory-sync'])(
  'propagates its own %s failure without poisoning the queue or rolling back a possible worker',
  async (failure) => {
    io.failure = failure;
    await expect(manager.flushSessionsDurably()).rejects.toBe(io.error);
    expect(disk()[0].pid).toBe(failure === 'write' ? 1 : 10);
    io.failure = '';
    change(30);
    await manager.flushSessionsDurably();
    expect(disk()[0].pid).toBe(30);
  }
);
it.each(['malformed', 'primary-read'])(
  'seals ordinary saves after %s primary evidence until an acknowledged repair',
  async (failure) => {
    if (failure === 'malformed') fs.writeFileSync(path, '{partial');
    else io.failure = failure;
    const original = fs.readFileSync(path, 'utf8');
    await expect(manager.flushSessionsDurably()).rejects.toThrow();
    io.failure = '';
    change(20);
    ordinary();
    await manager.drainSessionSaves();
    expect(fs.readFileSync(path, 'utf8')).toBe(original);
    fs.writeFileSync(path, JSON.stringify([record(1)]));
    await manager.flushSessionsDurably();
    change(30);
    ordinary();
    await manager.drainSessionSaves();
    expect(disk()[0].pid).toBe(30);
  }
);
it('refuses a replaced primary and retains the foreign bytes through later ordinary saves', async () => {
  const entered = hold('file-sync');
  const operation = manager.flushSessionsDurably();
  const rejected = expect(operation).rejects.toThrow('target changed');
  await reached(entered, operation);
  const foreign = JSON.stringify([record(77)]);
  const replacement = join(root, 'replacement');
  fs.writeFileSync(replacement, foreign);
  fs.renameSync(replacement, path);
  release!();
  await rejected;
  change(20);
  ordinary();
  await manager.drainSessionSaves();
  expect(fs.readFileSync(path, 'utf8')).toBe(foreign);
});
it('requires a pure final current predicate when confirmation awaits, and rechecks it after the await', async () => {
  await expect(manager.flushSessionsDurably(async () => true)).rejects.toThrow('synchronous guard');
  expect(io.commits).toBe(0);
  let current = true;
  await manager.flushSessionsDurably(
    async () => true,
    () => current
  );
  expect(io.commits).toBe(1);
  const entered = hold('file-sync');
  const operation = manager.flushSessionsDurably(
    async () => true,
    () => current
  );
  const rejected = expect(operation).rejects.toThrow('cancelled');
  await reached(entered, operation);
  current = false;
  release!();
  await rejected;
  expect(io.commits).toBe(1);
});
it('creates the missing metadata parent asynchronously', async () => {
  fs.rmSync(root, { recursive: true, force: true });
  await manager.flushSessionsDurably();
  expect(disk()[0].pid).toBe(10);
});
it('uses no synchronous filesystem calls while durable metadata IO is pending', async () => {
  const entered = hold('file-sync');
  const operation = manager.flushSessionsDurably();
  await reached(entered, operation);
  const spies = ['writeFileSync', 'fsyncSync', 'renameSync', 'mkdirSync'].map((name) =>
    vi.spyOn(fs, name as 'writeFileSync').mockImplementation(() => {
      throw Error('Synchronous filesystem work forbidden');
    })
  );
  release!();
  await operation;
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
});

it('preserves a foreign temporary file when exclusive creation collides', async () => {
  io.failure = 'wx-collision';
  await expect(manager.flushSessionsDurably()).rejects.toMatchObject({ code: 'EEXIST' });
  expect(fs.readFileSync(io.temporary, 'utf8')).toBe('foreign temporary');
  expect(disk()[0].pid).toBe(1);
});
it('never publishes or removes an equal-byte replacement of its staged mux temporary inode', async () => {
  const entered = hold('close'),
    operation = manager.flushSessionsDurably();
  const rejected = expect(operation).rejects.toThrow('staged file changed');
  await reached(entered, operation);
  const bytes = fs.readFileSync(io.temporary, 'utf8'),
    inode = fs.statSync(io.temporary).ino;
  const foreign = join(root, 'foreign-temporary');
  fs.writeFileSync(foreign, bytes);
  fs.renameSync(foreign, io.temporary);
  expect(fs.statSync(io.temporary).ino).not.toBe(inode);
  release!();
  await rejected;
  expect(fs.readFileSync(io.temporary, 'utf8')).toBe(bytes);
  expect(disk()[0].pid).toBe(1);
  expect(io.commits).toBe(0);
});
it('retains a primary replaced while the temporary proof descriptor closes', async () => {
  const entered = hold('temp-proof-close'),
    operation = manager.flushSessionsDurably();
  const rejected = expect(operation).rejects.toThrow('target changed');
  await reached(entered, operation);
  const bytes = JSON.stringify([record(77)]),
    foreign = join(root, 'foreign-primary');
  fs.writeFileSync(foreign, bytes);
  fs.renameSync(foreign, path);
  release!();
  await rejected;
  expect(fs.readFileSync(path, 'utf8')).toBe(bytes);
  expect(io.commits).toBe(0);
  expect(Reflect.get(manager, 'sessionPersistenceUnknown')).toBe(true);
});
