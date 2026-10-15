/** Disposable private files and fake PTY effects; held actual async I/O proves before-bytes ordering. */
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { httpStatusForErrorCode, type ApiErrorCode } from '../src/types.js';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { registerSessionRoutes } from '../src/web/routes/session-routes.js';
import { registerWsRoutes } from '../src/web/routes/ws-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { createMockRouteContext } from './mocks/index.js';
import fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { planVerifiedRebootRestore } from '../src/reboot-restore.js';
import type { SessionState } from '../src/types.js';
import * as fenceModule from '../src/recovery/reboot-identity-fence.js';
import {
  readRebootIdentityFence,
  writeRebootIdentityFence,
  rebootIdentityFencePath,
  RebootIdentityFenceError,
} from '../src/recovery/reboot-identity-fence.js';

const io = vi.hoisted(() => ({
  stage: '',
  entered: undefined as (() => void) | undefined,
  held: undefined as Promise<void> | undefined,
  fileSyncs: 0,
  failFileSync: 0,
  closes: 0,
  primaryCloses: 0,
  failCleanRename: false,
  foreignAfterClean: false,
  collide: false,
  replaceTemporary: false,
  foreignPath: '',
  readPaths: [] as string[],
}));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: vi.fn(() => {
    throw Error('Unexpected native effect in private input test');
  }),
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  async function pause(stage: string) {
    if (io.stage !== stage) return;
    io.stage = '';
    io.entered?.();
    await io.held;
  }
  return {
    ...actual,
    default: {
      ...actual,
      rename: async (...args: Parameters<typeof actual.rename>) => {
        const clean = JSON.parse(await actual.readFile(args[0], 'utf8')).switchPending === false;
        if (clean) await pause('clean-rename');
        await actual.rename(...args);
        if (clean && io.failCleanRename) {
          io.failCleanRename = false;
          throw Error('Native rename lost acknowledgement');
        }
        if (clean && io.foreignAfterClean) {
          io.foreignAfterClean = false;
          const foreign = String(args[1]) + '.foreign';
          await actual.writeFile(foreign, JSON.stringify({ version: 1, switchPending: true, untrackedInput: true }));
          await actual.rename(foreign, args[1]);
        }
      },
      open: async (...args: Parameters<typeof actual.open>) => {
        const temporary = String(args[0]).endsWith('.tmp');
        if (temporary && io.collide) {
          io.collide = false;
          io.foreignPath = String(args[0]);
          await actual.writeFile(io.foreignPath, 'foreign collision', { flag: 'wx' });
          throw Object.assign(Error('collision'), { code: 'EEXIST' });
        }
        const file = await actual.open(...args);
        if (!temporary && String(args[0]).endsWith('.json')) {
          io.readPaths.push(String(args[0]));
          await pause('read-open');
        }
        return new Proxy(file, {
          get(target, key) {
            if (key === 'writeFile')
              return async (...values: Parameters<typeof file.writeFile>) => {
                await pause('write');
                return target.writeFile(...values);
              };
            if (key === 'sync')
              return async () => {
                const directory = (await target.stat()).isDirectory();
                if (!directory) io.fileSyncs++;
                await pause(directory ? 'directory-sync' : 'file-sync');
                if (temporary && io.replaceTemporary) {
                  io.replaceTemporary = false;
                  io.foreignPath = String(args[0]);
                  await actual.rename(io.foreignPath, io.foreignPath + '.owned');
                  await actual.writeFile(io.foreignPath, 'foreign replacement', { flag: 'wx' });
                  throw Error('owned temporary replaced');
                }
                if (!directory && io.fileSyncs === io.failFileSync) throw Error('Fixture file sync failed');
                return target.sync();
              };
            if (key === 'close')
              return async () => {
                if (temporary) await pause('close');
                if (!temporary && String(args[0]).endsWith('.json') && ++io.primaryCloses === 2)
                  await pause('primary-proof-close');
                io.closes++;
                return target.close();
              };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    },
  };
});
let root: string;
let release: (() => void) | undefined;
const sessions: Session[] = [];
beforeEach(async () => {
  root = await fsp.mkdtemp(join(homedir(), 'identity-async-'));
  vi.stubEnv('CODEMAN_DATA_DIR', root);
  io.failCleanRename = false;
  io.primaryCloses = 0;
  io.foreignAfterClean = false;
  io.stage = '';
  io.fileSyncs = 0;
  io.failFileSync = 0;
  io.closes = 0;
  io.collide = false;
  io.replaceTemporary = false;
  io.foreignPath = '';
  io.readPaths = [];
});
afterEach(async () => {
  release?.();
  release = undefined;
  io.stage = '';
  io.failFileSync = 0;
  for (const session of sessions.splice(0)) {
    Reflect.set(session, 'ptyProcess', null);
    await session.stop(false);
  }
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fsp.rm(root, { recursive: true, force: true });
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
async function reached(entered: Promise<void>, work: Promise<unknown>) {
  await Promise.race([
    entered,
    work.then(() => {
      throw Error('No asynchronous filesystem barrier reached');
    }),
  ]);
}
function fixture(mode: 'codex' | 'claude' = 'codex') {
  const session = new Session({ id: randomUUID(), workingDir: root, mode, codexConfig: { noDaemon: true } });
  sessions.push(session);
  const write = vi.fn();
  Reflect.set(session, 'ptyProcess', { write });
  return { session, write, path: rebootIdentityFencePath(session.id) };
}
it.each(['write', 'file-sync', 'directory-sync', 'close'])(
  'keeps heartbeat responsive and sends zero bytes until %s acknowledgement',
  async (stage) => {
    const f = fixture();
    const entered = hold(stage);
    const sending = f.session.writeAsync('exact owner prompt\r', { fromUser: true });
    await reached(entered, sending);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.write).not.toHaveBeenCalled();
    expect(f.session.getRecoveryContext().switchPending).toBe(true);
    release!();
    expect(await sending).toBe(true);
    expect(f.write).toHaveBeenCalledExactlyOnceWith('exact owner prompt\r');
    expect(await readRebootIdentityFence(f.session.id)).toMatchObject({
      switchPending: false,
      submission: { hash: expect.any(String) },
    });
  }
);
it('observes the durable pending veto at the exact PTY effect and keeps FIFO across async publication', async () => {
  const f = fixture();
  f.write.mockImplementation(() => {
    expect(JSON.parse(fs.readFileSync(f.path, 'utf8'))).toMatchObject({ switchPending: true });
  });
  const first = f.session.writeAsync('first', { fromUser: true });
  const second = f.session.writeAsync(' second\r', { fromUser: true });
  expect(await first).toBe(true);
  expect(await second).toBe(true);
  expect(f.write.mock.calls.map(([data]) => data)).toEqual(['first', ' second\r']);
  expect((await readRebootIdentityFence(f.session.id))?.switchPending).toBe(false);
});
it.each(['owner', 'config', 'stop', 'pty', 'lifecycle', 'epoch'] as const)(
  'refuses a changed %s scope while durability is held',
  async (kind) => {
    const f = fixture();
    const entered = hold('file-sync');
    const sending = f.session.writeAsync('unsubmitted\r', { fromUser: true });
    const failure = expect(sending).rejects.toBeInstanceOf(RebootIdentityFenceError);
    await reached(entered, sending);
    if (kind === 'owner') f.session.owner = 'replacement-owner';
    if (kind === 'config') Reflect.set(f.session, '_codexConfig', { noDaemon: true, model: 'new-model' });
    if (kind === 'stop') await f.session.stop(false);
    if (kind === 'pty') Reflect.set(f.session, 'ptyProcess', { write: vi.fn() });
    if (kind === 'lifecycle') Reflect.set(f.session, '_paneLifecycleOps', 1);
    if (kind === 'epoch') Reflect.set(f.session, '_paneStartedAt', f.session.paneStartedAt + 1);
    release!();
    await failure;
    expect(f.write).not.toHaveBeenCalled();
  }
);
it('keeps already-delivered bytes committed when clean identity persistence fails', async () => {
  const f = fixture();
  expect(f.session.shouldApplyInput('browser', 1)).toBe(true);
  io.failFileSync = 2;
  expect(
    await f.session.writeAsync('delivered once\r', { fromUser: true, inputSeq: { clientId: 'browser', seq: 1 } })
  ).toBe(true);
  expect(f.write).toHaveBeenCalledTimes(1);
  expect(f.session.hasAppliedInputSeq('browser', 1)).toBe(true);
  expect(f.session.shouldApplyInput('browser', 1)).toBe(false);
  expect(f.session.getRecoveryContext().switchPending).toBe(true);
  expect(await readRebootIdentityFence(f.session.id)).toMatchObject({ switchPending: true });
});
it('does not perform disk reads in construction and preserves asynchronously loaded handoff taint', async () => {
  const id = randomUUID();
  await writeRebootIdentityFence(id, { switchPending: true, untrackedInput: true });
  const session = new Session({ id, workingDir: root, mode: 'codex' });
  sessions.push(session);
  expect(session.getRecoveryContext()).toMatchObject({ managed: false, switchPending: true, untrackedInput: false });
  expect(await session.ensureRecoveryIdentityFence()).toBe(true);
  expect(session.getRecoveryContext().untrackedInput).toBe(true);
  const write = vi.fn();
  Reflect.set(session, 'ptyProcess', { write });
  expect(await session.writeAsync('new browser prompt\r', { fromUser: true })).toBe(true);
  expect(session.getRecoveryContext().switchPending).toBe(true);
  expect(await readRebootIdentityFence(id)).toMatchObject({ switchPending: true, untrackedInput: true });
});
it('refuses synchronous unprepared Codex input without bytes, while ordinary CLI write stays synchronous', () => {
  const f = fixture();
  expect(() => f.session.write('not prepared', { fromUser: true })).toThrow(RebootIdentityFenceError);
  expect(f.write).not.toHaveBeenCalled();
  expect(fs.existsSync(f.path)).toBe(false);
  const ordinary = fixture('claude');
  expect(ordinary.session.write('ordinary')).toBe(true);
  expect(ordinary.write).toHaveBeenCalledExactlyOnceWith('ordinary');
});
it('retains timed-out filesystem work and refuses a new write until the original job really settles', async () => {
  const id = randomUUID();
  const entered = hold('write');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const writing = writeRebootIdentityFence(id, { switchPending: true });
  const failure = expect(writing).rejects.toBeInstanceOf(RebootIdentityFenceError);
  await reached(entered, writing);
  await vi.advanceTimersByTimeAsync(2000);
  await failure;
  await expect(writeRebootIdentityFence(id, { switchPending: false })).rejects.toBeInstanceOf(RebootIdentityFenceError);
  release!();
  // Await actual handles/cleanup using a real event-loop barrier rather than assuming N promise turns.
  vi.useRealTimers();
  const settleDeadline = performance.now() + 2000;
  while (performance.now() < settleDeadline) {
    try {
      await writeRebootIdentityFence(id, { switchPending: true });
      return;
    } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
  }
  throw Error('Original private operation did not settle');
});

it('cannot steal an async receipt through matching public synchronous input', async () => {
  const f = fixture();
  const original = Reflect.get(f.session, '_prepareRecoveryInput').bind(f.session);
  Reflect.set(f.session, '_prepareRecoveryInput', async (...args: unknown[]) => {
    await original(...args);
    expect(() => f.session.write('exact prompt\r', { fromUser: true })).toThrow(RebootIdentityFenceError);
    expect(f.write).not.toHaveBeenCalled();
  });
  expect(await f.session.writeAsync('exact prompt\r', { fromUser: true })).toBe(true);
  expect(f.write).toHaveBeenCalledExactlyOnceWith('exact prompt\r');
});
it('persists rejected no-PTY owner intent without committing its input identity', async () => {
  const f = fixture();
  Reflect.set(f.session, 'ptyProcess', null);
  expect(f.session.shouldApplyInput('browser', 2)).toBe(true);
  expect(await f.session.writeAsync('new intent', { fromUser: true, inputSeq: { clientId: 'browser', seq: 2 } })).toBe(
    false
  );
  expect(await readRebootIdentityFence(f.session.id)).toMatchObject({ switchPending: true });
  expect(f.session.hasAppliedInputSeq('browser', 2)).toBe(false);
  expect(f.write).not.toHaveBeenCalled();
});
it.each(['collision', 'replacement'])('retains foreign temporary bytes after %s', async (kind) => {
  io.collide = kind === 'collision';
  io.replaceTemporary = kind === 'replacement';
  await expect(writeRebootIdentityFence(randomUUID(), { switchPending: true })).rejects.toBeInstanceOf(
    RebootIdentityFenceError
  );
  expect(await fsp.readFile(io.foreignPath, 'utf8')).toBe(
    kind === 'collision' ? 'foreign collision' : 'foreign replacement'
  );
});
it('does not acknowledge direct handoff after authority changes on the final durable return', async () => {
  const f = fixture();
  const original = fenceModule.writeRebootIdentityFence;
  let calls = 0;
  vi.spyOn(fenceModule, 'writeRebootIdentityFence').mockImplementation(async (...args) => {
    const result = await original(...args);
    if (++calls === 2) f.session.owner = 'changed after fs acknowledgement';
    return result;
  });
  await expect(f.session.fenceUntrackedInput()).rejects.toBeInstanceOf(RebootIdentityFenceError);
  expect(f.write).not.toHaveBeenCalled();
  expect(f.session.getRecoveryContext().untrackedInput).toBe(false);
  expect(await readRebootIdentityFence(f.session.id)).toMatchObject({ untrackedInput: true });
});
it.each(['writeAsync', 'writeViaMux', 'sendNamedKey'] as const)(
  'refuses %s admitted during pane lifecycle work',
  async (method) => {
    const f = fixture();
    Reflect.set(f.session, '_paneLifecycleOps', 1);
    const dispatch = vi.fn();
    const result = method === 'sendNamedKey' ? f.session.sendNamedKey('\r', dispatch) : f.session[method]('blocked');
    expect(await result).toBe(false);
    expect(f.write).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(fs.existsSync(f.path)).toBe(false);
  }
);

it('bounds all reboot candidate fence collection by one shared original deadline', async () => {
  const states: Record<string, SessionState> = {},
    bindings = new Map<string, string | null>();
  for (let index = 0; index < 20; index++) {
    const f = fixture();
    await writeRebootIdentityFence(f.session.id, { switchPending: false });
    states[f.session.id] = {
      ...f.session.toState(),
      status: 'idle',
      pid: 99999,
      __codexRecoveryHome: root,
    } as SessionState;
    bindings.set(f.session.id, null);
  }
  io.readPaths = [];
  const entered = hold('read-open');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const planning = planVerifiedRebootRestore(
    Object.keys(states),
    states,
    async () => ({ status: 'present' as const, dev: 1, ino: 1 }),
    bindings
  );
  await reached(entered, planning);
  await vi.advanceTimersByTimeAsync(2000);
  const plan = await planning;
  expect(plan.restore).toEqual([]);
  expect(plan.skipped).toHaveLength(20);
  expect(io.readPaths).toHaveLength(1);
  // The original operation still owns its slot after the caller's shared timeout.
  await expect(fenceModule.loadRebootIdentityFence(Object.keys(states)[0])).rejects.toBeInstanceOf(
    RebootIdentityFenceError
  );
  release!();
  vi.useRealTimers();
  await new Promise<void>((resolve) => setImmediate(resolve));
});

it.each(['primary-taint', 'same-byte-temporary'] as const)(
  'refuses %s replacement before rename without deleting foreign evidence',
  async (kind) => {
    const id = randomUUID();
    await writeRebootIdentityFence(id, { switchPending: false });
    const path = rebootIdentityFencePath(id);
    const entered = hold('close');
    const sending = writeRebootIdentityFence(id, { switchPending: true });
    const failure = expect(sending).rejects.toBeInstanceOf(RebootIdentityFenceError);
    await reached(entered, sending);
    let replaced: string;
    if (kind === 'primary-taint') {
      replaced = path;
      const next = path + '.foreign';
      await fsp.writeFile(next, JSON.stringify({ version: 1, switchPending: true, untrackedInput: true }));
      await fsp.rename(next, path);
    } else {
      const names = await fsp.readdir(join(root, 'reboot-identities'));
      replaced = join(root, 'reboot-identities', names.find((name) => name.endsWith('.tmp'))!);
      const text = await fsp.readFile(replaced);
      await fsp.rename(replaced, replaced + '.owned');
      await fsp.writeFile(replaced, text, { flag: 'wx' });
    }
    const before = await fsp.stat(replaced),
      bytes = await fsp.readFile(replaced);
    release!();
    await failure;
    expect((await fsp.stat(replaced)).ino).toBe(before.ino);
    expect(await fsp.readFile(replaced)).toEqual(bytes);
  }
);
it('persists pending owner intent before a known broker-readiness refusal', async () => {
  const f = fixture();
  Reflect.set(f.session, '_mux', { canDeliverCodexOwnerInput: () => false });
  Reflect.set(f.session, '_muxSession', { sessionId: f.session.id });
  expect(await f.session.writeViaMux('retained unsent', { fromUser: true })).toBe(false);
  expect(f.write).not.toHaveBeenCalled();
  expect(await readRebootIdentityFence(f.session.id)).toMatchObject({ switchPending: true });
});

it.each(['scope', 'stop', 'rollback-fails', 'foreign-primary', 'rename-lost-ack'] as const)(
  'retains identity uncertainty when %s revokes a held clean rename',
  async (kind) => {
    const f = fixture();
    const entered = hold('clean-rename');
    const sending = f.session.writeAsync('actually delivered\r', { fromUser: true });
    await reached(entered, sending);
    expect(f.write).toHaveBeenCalledTimes(1);
    if (kind === 'stop') await f.session.stop(false);
    else if (kind === 'rename-lost-ack') io.failCleanRename = true;
    else f.session.owner = 'changed owner';
    if (kind === 'rollback-fails') io.failFileSync = 3;
    if (kind === 'foreign-primary') io.foreignAfterClean = true;
    release!();
    expect(await sending).toBe(true);
    expect(f.session.getRecoveryContext()).toMatchObject({ switchPending: true });
    const durable = await readRebootIdentityFence(f.session.id);
    if (kind === 'rollback-fails') {
      expect(durable?.switchPending).toBe(false);
      expect(
        await f.session.deliverRecovery(
          { action: 'continue', key: 'stale', conversationId: randomUUID(), startedAt: Date.now() },
          f.session.getRecoveryContext().generation
        )
      ).toBe('not-sent');
    } else expect(durable).toMatchObject({ switchPending: true });
    if (kind === 'foreign-primary') expect(durable?.untrackedInput).toBe(true);
    expect(f.write).toHaveBeenCalledTimes(1);
  }
);
it('queues later owner input until the prior clean rename and its own pending acknowledgement finish', async () => {
  const f = fixture();
  const entered = hold('clean-rename');
  const first = f.session.writeAsync('first owner request\r', { fromUser: true });
  await reached(entered, first);
  const second = f.session.writeAsync('second owner request\r', { fromUser: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(f.write).toHaveBeenCalledExactlyOnceWith('first owner request\r');
  release!();
  expect(await first).toBe(true);
  expect(await second).toBe(true);
  expect(f.write.mock.calls.map(([value]) => value)).toEqual(['first owner request\r', 'second owner request\r']);
  expect((await readRebootIdentityFence(f.session.id))?.submission?.hash).toBe(
    f.session.getRecoveryContext().submission?.hash
  );
});

it('holds actual WS and HTTP admission in one FIFO until async durability acknowledges bytes', async () => {
  const f = fixture();
  const ctx = createMockRouteContext();
  (ctx.sessions as unknown as Map<string, Session>).set(f.session.id, f.session);
  let connect!: (...args: unknown[]) => void;
  const fakeApp = {
    get: (_path: string, _options: unknown, handler: typeof connect) => {
      connect = handler;
    },
  };
  registerWsRoutes(fakeApp as never, ctx as never, () => ({
    bindHost: '127.0.0.1',
    allowedHosts: [],
    tunnelHost: null,
  }));
  const frames: unknown[] = [];
  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    send: (data: string) => frames.push(JSON.parse(data)),
    close: vi.fn(),
    ping: vi.fn(),
    terminate: vi.fn(),
  });
  connect(socket, { params: { id: f.session.id }, query: { cid: 'browser' }, headers: { host: '127.0.0.1' } });
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  registerSessionRoutes(app, ctx as never);
  installRouteErrorHandler(app);
  await app.ready();
  const entered = hold('file-sync');
  socket.emit('message', JSON.stringify({ t: 'i', cid: 'browser', seq: 1, d: 'first' }));
  await entered;
  socket.emit('message', JSON.stringify({ t: 'i', cid: 'browser', seq: 1, d: 'first' }));
  const http = app
    .inject({
      method: 'POST',
      url: `/api/sessions/${f.session.id}/input`,
      payload: { input: ' second\r', clientId: 'browser', seq: 2, useMux: false },
    })
    .then((value) => value);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(frames).toEqual([]);
  expect(f.write).not.toHaveBeenCalled();
  expect(f.session.hasAppliedInputSeq('browser', 1)).toBe(false);
  release!();
  try {
    expect((await http).statusCode).toBe(200);
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    expect(frames).toEqual([
      { t: 'ia', seq: 1 },
      { t: 'ia', seq: 1, dup: true, last: 1 },
    ]);
    expect(f.write.mock.calls.map(([value]) => value)).toEqual(['first', ' second\r']);
    expect(f.session.lastInputSeq('browser')).toBe(2);
  } finally {
    socket.emit('close', 1000, Buffer.from('done'));
    await app.close();
  }
});

it('caps outstanding filesystem operations until both real held jobs settle', async () => {
  const enteredFirst = hold('write');
  const first = writeRebootIdentityFence(randomUUID(), { switchPending: true });
  await reached(enteredFirst, first);
  const releaseFirst = release!;
  const enteredSecond = hold('file-sync');
  const second = writeRebootIdentityFence(randomUUID(), { switchPending: true });
  await reached(enteredSecond, second);
  const releaseSecond = release!;
  await expect(writeRebootIdentityFence(randomUUID(), { switchPending: true })).rejects.toBeInstanceOf(
    RebootIdentityFenceError
  );
  releaseFirst();
  releaseSecond();
  await first;
  await second;
  expect(await writeRebootIdentityFence(randomUUID(), { switchPending: true })).toMatchObject({ switchPending: true });
});
it('retries unknown initial evidence without inventing permanent direct-input taint', async () => {
  const f = fixture();
  await fsp.mkdir(join(root, 'reboot-identities'), { recursive: true });
  await fsp.writeFile(f.path, '{unknown');
  expect(await f.session.ensureRecoveryIdentityFence()).toBe(false);
  expect(f.session.getRecoveryContext()).toMatchObject({ managed: false, switchPending: true, untrackedInput: false });
  await fsp.writeFile(f.path, JSON.stringify({ version: 1, switchPending: false }));
  expect(await f.session.ensureRecoveryIdentityFence()).toBe(true);
  expect(f.session.getRecoveryContext().untrackedInput).toBe(false);
  expect(await f.session.writeAsync('known current prompt\r', { fromUser: true })).toBe(true);
});

it('rechecks every private path after the final primary proof handle closes', async () => {
  const id = randomUUID();
  await writeRebootIdentityFence(id, { switchPending: false });
  io.primaryCloses = 0;
  const entered = hold('primary-proof-close');
  const writing = writeRebootIdentityFence(id, { switchPending: true });
  const failure = expect(writing).rejects.toBeInstanceOf(RebootIdentityFenceError);
  await reached(entered, writing);
  const folder = join(root, 'reboot-identities');
  const names = await fsp.readdir(folder);
  const temporary = join(folder, names.find((name) => name.endsWith('.tmp'))!);
  const text = await fsp.readFile(temporary);
  await fsp.rename(temporary, temporary + '.owned');
  await fsp.writeFile(temporary, text, { flag: 'wx' });
  const foreign = await fsp.stat(temporary),
    primary = await fsp.readFile(rebootIdentityFencePath(id));
  release!();
  await failure;
  expect((await fsp.stat(temporary)).ino).toBe(foreign.ino);
  expect(await fsp.readFile(temporary)).toEqual(text);
  expect(await fsp.readFile(rebootIdentityFencePath(id))).toEqual(primary);
});

it.each(['ws', 'http', 'named-key', 'handoff'] as const)(
  'refuses %s targeting a replaced board entry during private durability',
  async (kind) => {
    const f = fixture();
    Reflect.set(f.session, '_muxSession', { muxName: 'codeman-fake-scope' });
    const ctx = createMockRouteContext();
    const board = ctx.sessions as unknown as Map<string, Session>;
    board.set(f.session.id, f.session);
    let connect!: (...args: unknown[]) => void;
    registerWsRoutes(
      {
        get: (_path: string, _options: unknown, handler: typeof connect) => {
          connect = handler;
        },
      } as never,
      ctx as never,
      () => ({ bindHost: '127.0.0.1', allowedHosts: [], tunnelHost: null })
    );
    const frames: unknown[] = [];
    const socket = Object.assign(new EventEmitter(), {
      readyState: 1,
      send: (value: string) => frames.push(JSON.parse(value)),
      close: vi.fn(),
      ping: vi.fn(),
      terminate: vi.fn(),
    });
    connect(socket, { params: { id: f.session.id }, query: { cid: 'scope-browser' }, headers: { host: '127.0.0.1' } });
    const app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    registerSessionRoutes(app, ctx as never);
    installRouteErrorHandler(app);
    app.addHook('preSerialization', (_req, reply, payload: unknown, done) => {
      const result = payload as { success?: boolean; errorCode?: ApiErrorCode };
      if (result?.success === false && result.errorCode && reply.statusCode === 200)
        reply.code(httpStatusForErrorCode(result.errorCode));
      done(null, payload);
    });
    await app.ready();
    const entered = hold('file-sync');
    const response =
      kind === 'ws'
        ? undefined
        : app
            .inject({
              method: 'POST',
              url: `/api/sessions/${f.session.id}/${kind === 'http' ? 'input' : kind === 'handoff' ? 'direct-attach-fence' : 'send-key'}`,
              payload:
                kind === 'http'
                  ? { input: 'owned prompt\r', useMux: false, clientId: 'scope-browser', seq: 1 }
                  : { key: 'S-Enter' },
            })
            .then((value) => value);
    if (kind === 'ws')
      socket.emit('message', JSON.stringify({ t: 'i', cid: 'scope-browser', seq: 1, d: 'owned prompt\r' }));
    await entered;
    const replacement = new Session({ id: f.session.id, mode: 'codex', workingDir: root });
    sessions.push(replacement);
    board.set(f.session.id, replacement);
    release!();
    try {
      if (response) {
        const result = await response;
        expect(result.statusCode).toBe(422);
        expect(result.json()).toMatchObject({ retryable: true, notSent: true });
      } else await vi.waitFor(() => expect(f.session.paneLifecycleInFlight).toBe(false));
      expect(f.write).not.toHaveBeenCalled();
      expect(execFile).not.toHaveBeenCalled();
      expect(frames).toEqual([]);
      expect(f.session.hasAppliedInputSeq('scope-browser', 1)).toBe(false);
      expect(board.get(f.session.id)).toBe(replacement);
    } finally {
      socket.emit('close', 1000, Buffer.from('done'));
      await app.close();
    }
  }
);
it.each([
  () => false,
  () => Promise.resolve(true),
  () => Promise.reject(Error('Rejected malformed input authority')),
  () => {
    throw Error('Unknown input authority');
  },
])('requires literal synchronous caller authority before preparing any input: %s', async (callback) => {
  const f = fixture();
  await expect(f.session.writeAsync('not authorized', { isCurrent: callback as () => boolean })).rejects.toBeInstanceOf(
    RebootIdentityFenceError
  );
  expect(f.write).not.toHaveBeenCalled();
  expect(fs.existsSync(f.path)).toBe(false);
});

it('rechecks the handoff target after its asynchronous fence method returns', async () => {
  const f = fixture();
  const ctx = createMockRouteContext();
  const board = ctx.sessions as unknown as Map<string, Session>;
  board.set(f.session.id, f.session);
  const replacement = new Session({ id: f.session.id, mode: 'codex', workingDir: root });
  sessions.push(replacement);
  const original = f.session.fenceUntrackedInput.bind(f.session);
  vi.spyOn(f.session, 'fenceUntrackedInput').mockImplementation(async (...args) => {
    await original(...args);
    board.set(f.session.id, replacement);
  });
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  registerSessionRoutes(app, ctx as never);
  installRouteErrorHandler(app);
  try {
    const response = await app.inject({
      method: 'POST',
      url: `/api/sessions/${f.session.id}/direct-attach-fence`,
      payload: {},
    });
    expect(response.json()).toMatchObject({ success: false, retryable: true, notSent: true });
    expect(board.get(f.session.id)).toBe(replacement);
    expect(f.write).not.toHaveBeenCalled();
    expect(await readRebootIdentityFence(f.session.id)).toMatchObject({ switchPending: true, untrackedInput: true });
  } finally {
    await app.close();
  }
});
it.each([false, null, 0, 'unknown'])(
  'refuses malformed supplied caller authority without treating it as absent: %s',
  async (value) => {
    const f = fixture();
    await expect(f.session.writeAsync('not admitted', { isCurrent: value as never })).rejects.toBeInstanceOf(
      RebootIdentityFenceError
    );
    expect(f.write).not.toHaveBeenCalled();
    expect(fs.existsSync(f.path)).toBe(false);
  }
);

it('durably taints owner intent during a held recovery probe without allowing input bytes', async () => {
  const f = fixture();
  const conversationId = randomUUID();
  let finish!: (value: { dead: false; screen: string }) => void;
  const pane = new Promise<{ dead: false; screen: string }>((resolve) => {
    finish = resolve;
  });
  const mux = {
    isAvailable: () => true,
    inspectPaneForRecovery: vi.fn(() => pane),
    sendInput: vi.fn(async () => true),
  };
  Reflect.set(f.session, '_useMux', true);
  Reflect.set(f.session, '_mux', mux);
  Reflect.set(f.session, '_muxSession', {
    sessionId: f.session.id,
    muxName: 'codeman-held-recovery',
    recoveryIsolated: true,
    recoveryCodexHome: root,
  });
  Reflect.set(f.session, '_codexConfig', { noDaemon: true, resumeSessionId: conversationId });
  expect(await f.session.ensureRecoveryIdentityFence()).toBe(true);
  expect(f.session.getRecoveryContext()).toMatchObject({ managed: true, noDaemon: true, switchPending: false });
  const generation = f.session.getRecoveryContext().generation;
  const recovery = f.session.deliverRecovery(
    { action: 'continue', key: 'held', conversationId, startedAt: Date.now() },
    generation
  );
  const dispatch = vi.fn(async () => {});
  try {
    await vi.waitFor(() => expect(mux.inspectPaneForRecovery).toHaveBeenCalledOnce());
    expect(f.session.recoveryInputReserved).toBe(true);
    expect(await f.session.writeAsync('blocked ordinary', { fromUser: true })).toBe(false);
    expect(await f.session.writeViaMux('blocked mux', { fromUser: true })).toBe(false);
    expect(await f.session.sendNamedKey('\n', dispatch)).toBe(false);
    await f.session.fenceUntrackedInput();
    expect(f.session.getRecoveryContext()).toMatchObject({ switchPending: true, untrackedInput: true });
    expect(f.session.getRecoveryContext().generation).toBeGreaterThan(generation);
    expect(await readRebootIdentityFence(f.session.id)).toMatchObject({ switchPending: true, untrackedInput: true });
    expect(f.session.recoveryInputReserved).toBe(true);
    expect(await f.session.writeAsync('still blocked', { fromUser: true })).toBe(false);
    expect(f.write).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(mux.sendInput).not.toHaveBeenCalled();
  } finally {
    finish({ dead: false, screen: '›\n  fixture-model high · /tmp\n' });
    expect(await recovery).toBe('not-sent');
  }
  expect(f.session.recoveryInputReserved).toBe(false);
  expect(await f.session.writeAsync('fresh owner input', { fromUser: true })).toBe(true);
  expect(f.write).toHaveBeenCalledExactlyOnceWith('fresh owner input');
  expect(mux.sendInput).not.toHaveBeenCalled();
  expect(await readRebootIdentityFence(f.session.id)).toMatchObject({ switchPending: true, untrackedInput: true });
});
