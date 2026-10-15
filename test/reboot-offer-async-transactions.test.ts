/** Real disposable offer journals, held async filesystem stages, and injected routes only. */
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RebootRestoreRegistry, rebootRestoreRegistry } from '../src/web/reboot-restore-registry.js';
import { WebServer } from '../src/web/server.js';
import { registerRebootRestoreRoutes } from '../src/web/routes/reboot-restore-routes.js';
import { createRouteTestHarness } from './routes/_route-test-utils.js';
import type { RebootRestoreEntry } from '../src/reboot-restore.js';

const io = vi.hoisted(() => ({
  target: '',
  stage: '',
  entered: undefined as (() => void) | undefined,
  held: undefined as Promise<void> | undefined,
  renamed: '',
  archived: '',
  primaryWrites: 0,
  failPrimaryAck: false,
  collide: false,
  foreignTemporary: '',
  primaryTemporary: '',
}));
vi.mock('node:fs/promises', async (original) => {
  const native = await original<typeof import('node:fs/promises')>();
  const pause = async (stage: string) => {
    if (io.stage !== stage) return;
    io.stage = '';
    io.entered?.();
    await io.held;
  };
  return {
    ...native,
    open: async (...args: Parameters<typeof native.open>) => {
      const path = String(args[0]);
      const shadow = path.startsWith(io.target + '.previous.tmp-') && args[1] === 'wx';
      const candidate = path.startsWith(io.target + '.tmp-') && args[1] === 'wx';
      if (candidate && io.collide) {
        io.collide = false;
        io.foreignTemporary = path;
        await native.writeFile(path, 'foreign collision', { flag: 'wx', mode: 0o600 });
      }
      const file = await native.open(...args);
      if (candidate) {
        io.primaryWrites++;
        io.primaryTemporary = path;
      }
      return new Proxy(file, {
        get(target, key) {
          if (key === 'writeFile')
            return async (...input: Parameters<typeof file.writeFile>) => {
              if (candidate) await pause('primary-write');
              return target.writeFile(...input);
            };
          if (key === 'chmod')
            return async (mode: number) => {
              if (path.includes('.unacknowledged-')) await pause('archive-chmod');
              return target.chmod(mode);
            };
          if (key === 'sync')
            return async () => {
              const directory = (await target.stat()).isDirectory();
              if (shadow) await pause('shadow-file-sync');
              if (candidate) await pause('primary-file-sync');
              if (directory && io.renamed === io.target) {
                await pause('primary-directory-sync');
                if (io.failPrimaryAck) {
                  io.failPrimaryAck = false;
                  throw Error('Fixture primary ACK lost');
                }
              }
              return target.sync();
            };
          if (key === 'close')
            return async () => {
              if (path === io.target) await pause('read-close');
              if (candidate) await pause(io.primaryWrites > 1 ? 'rollback-close' : 'primary-close');
              return target.close();
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    rename: async (...args: Parameters<typeof native.rename>) => {
      if (String(args[1]) === io.target) await pause('primary-rename');
      await native.rename(...args);
      io.renamed = String(args[1]);
      if (String(args[1]).includes('.unacknowledged-')) io.archived = String(args[1]);
    },
    unlink: async (...args: Parameters<typeof native.unlink>) => {
      if (String(args[0]) === io.target + '.previous') await pause('shadow-unlink');
      return native.unlink(...args);
    },
  };
});
let root: string, path: string, registry: RebootRestoreRegistry;
let release: (() => void) | undefined;
function entry(id: string, owner = 'alice'): RebootRestoreEntry {
  const state = {
    id,
    owner,
    mode: 'claude' as const,
    workingDir: root,
    status: 'idle' as const,
    pid: 99999,
    createdAt: Date.now() - 1000,
    lastActivityAt: Date.now() - 1000,
    currentTaskId: null,
    claudeSessionId: '11111111-2222-3333-4444-555555555555',
  };
  return { sessionId: id, owner, mode: 'claude', workingDir: root, state, resumeConversationId: state.claudeSessionId };
}
const alice = (owner: string | undefined) => owner === 'alice';
beforeEach(async () => {
  root = await fs.mkdtemp(join(homedir(), 'offer-async-'));
  path = join(root, 'offer.json');
  Object.assign(io, {
    target: path,
    stage: '',
    renamed: '',
    archived: '',
    primaryWrites: 0,
    failPrimaryAck: false,
    collide: false,
    foreignTemporary: '',
    primaryTemporary: '',
  });
  registry = new RebootRestoreRegistry();
  await registry.configurePersistence(path);
  await registry.set([entry('alice'), entry('bob', 'bob')]);
  io.primaryWrites = 0;
  io.renamed = '';
});
afterEach(async () => {
  release?.();
  release = undefined;
  io.stage = '';
  io.failPrimaryAck = false;
  await drain(registry);
  await drain(rebootRestoreRegistry);
  rebootRestoreRegistry.reset();
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
async function drain(value: RebootRestoreRegistry) {
  const flush = Reflect.get(value, 'flush') as (() => Promise<void>) | undefined;
  await flush?.call(value);
}
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
    operation.then(() => {
      throw Error('Completed without async barrier');
    }),
  ]);
}
async function heartbeat() {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 0));
}
async function restoredIds() {
  const restored = new RebootRestoreRegistry();
  await restored.configurePersistence(path);
  const ids = restored.list(() => true).map((e) => e.sessionId);
  await restored.flush();
  return ids;
}

it.each([
  'primary-write',
  'shadow-file-sync',
  'primary-file-sync',
  'primary-close',
  'primary-rename',
  'primary-directory-sync',
  'shadow-unlink',
])('revokes only dismissed held authority immediately while async %s is blocked', async (stage) => {
  const [heldAlice] = registry.take(alice, undefined, 'alice');
  const [heldBob] = registry.take((owner) => owner === 'bob', undefined, 'bob');
  const entered = hold(stage);
  let finished = false;
  const clearing = Promise.resolve(registry.clear(alice)).then((count) => {
    finished = true;
    return count;
  });
  expect(registry.isHeld(heldAlice, 'alice')).toBe(false);
  await reached(entered, clearing);
  await heartbeat();
  expect(finished).toBe(false);
  expect(registry.isHeld(heldBob, 'bob')).toBe(true);
  expect(registry.beginSpending('new-owner')).toBe(false);
  expect(registry.getBrokerCleanupState()).toBeUndefined();
  release!();
  expect(await clearing).toBe(1);
  expect(await restoredIds()).toEqual(['bob']);
});
it('keeps read/configuration asynchronous and publishes nothing before its final FD closes', async () => {
  const loading = new RebootRestoreRegistry();
  const entered = hold('read-close');
  const work = loading.configurePersistence(path);
  await reached(entered, work);
  await heartbeat();
  expect(loading.list(() => true)).toEqual([]);
  expect(loading.beginSpending('alice')).toBe(false);
  expect(loading.getBrokerCleanupState()).toBeUndefined();
  release!();
  await work;
  expect(loading.list(() => true)).toHaveLength(2);
});
it('does not let a queued dismiss erase a later replacement plan or revive its old held reference', async () => {
  const [held] = registry.take(alice, undefined, 'alice');
  const entered = hold('primary-write'),
    replacing = registry.set([entry('new')]);
  expect(registry.isHeld(held, 'alice')).toBe(false);
  await reached(entered, replacing);
  const clearing = registry.clear(alice);
  release!();
  await replacing;
  expect(await clearing).toBe(0);
  expect(registry.list(() => true).map((e) => e.sessionId)).toEqual(['new']);
  expect(await restoredIds()).toEqual(['new']);
  expect(registry.isHeld(held, 'alice')).toBe(false);
});
it('a dismiss during a held release cannot re-offer the captured entry after its ACK', async () => {
  const taken = registry.take(alice, undefined, 'alice');
  const entered = hold('primary-file-sync'),
    releasing = registry.releaseFlight('alice', taken);
  await reached(entered, releasing);
  const clearing = registry.clear(alice);
  expect(registry.isHeld(taken[0], 'alice')).toBe(false);
  release!();
  await releasing;
  await clearing;
  expect(await restoredIds()).toEqual(['bob']);
});
it('preserves original bytes and a failed-ACK veto, then permits an acknowledged explicit retry', async () => {
  const old = await fs.readFile(path, 'utf8'),
    taken = registry.take(alice, undefined, 'alice');
  io.failPrimaryAck = true;
  await expect(registry.clear(alice)).rejects.toThrow('ACK lost');
  expect(await fs.readFile(path, 'utf8')).toBe(old);
  expect(await fs.readFile(path + '.previous', 'utf8')).toBe(old);
  expect(registry.isHeld(taken[0], 'alice')).toBe(false);
  expect(registry.beginSpending('alice')).toBe(false);
  expect(registry.getBrokerCleanupState()).toBeUndefined();
  expect(await restoredIds()).toEqual(['alice', 'bob']);
  await registry.releaseFlight('alice', taken);
  const [fresh] = registry.take(alice, undefined, 'alice');
  expect(fresh).not.toBe(taken[0]);
  expect(registry.isHeld(fresh, 'alice')).toBe(true);
  expect(registry.isHeld(taken[0], 'alice')).toBe(false);
});
it('retains a foreign temporary collision that this transaction never opened', async () => {
  const old = await fs.readFile(path, 'utf8');
  io.collide = true;
  await expect(registry.clear(alice)).rejects.toThrow(/EEXIST/);
  expect(await fs.readFile(io.foreignTemporary, 'utf8')).toBe('foreign collision');
  expect(await fs.readFile(path, 'utf8')).toBe(old);
  expect(await fs.readFile(path + '.previous', 'utf8')).toBe(old);
  expect(registry.beginSpending('alice')).toBe(false);
  expect(registry.getBrokerCleanupState()).toBeUndefined();
});
it('neither publishes nor deletes an equal-byte foreign replacement of its temporary file', async () => {
  const old = await fs.readFile(path, 'utf8'),
    entered = hold('primary-close');
  const clearing = registry.clear(alice);
  const failure = expect(clearing).rejects.toThrow(/changed/);
  await reached(entered, clearing);
  const temporary = io.primaryTemporary,
    candidate = await fs.readFile(temporary, 'utf8'),
    original = await fs.lstat(temporary);
  await fs.writeFile(temporary + '.foreign', candidate);
  await fs.rename(temporary + '.foreign', temporary);
  expect((await fs.lstat(temporary)).ino).not.toBe(original.ino);
  release!();
  await failure;
  expect(await fs.readFile(temporary, 'utf8')).toBe(candidate);
  expect(await fs.readFile(path, 'utf8')).toBe(old);
  expect(await fs.readFile(path + '.previous', 'utf8')).toBe(old);
  expect(registry.getBrokerCleanupState()).toBeUndefined();
});
it('preserves a foreign primary replaced while rollback staging closes', async () => {
  io.failPrimaryAck = true;
  const entered = hold('rollback-close'),
    clearing = registry.clear(alice);
  const failure = expect(clearing).rejects.toThrow('ACK lost');
  await reached(entered, clearing);
  const bytes = JSON.stringify({ version: 1, builtAt: Date.now(), entries: [entry('foreign')] });
  await fs.writeFile(path + '.foreign', bytes);
  await fs.rename(path + '.foreign', path);
  release!();
  await failure;
  expect(await fs.readFile(path, 'utf8')).toBe(bytes);
  expect(registry.getBrokerCleanupState()).toBeUndefined();
});
it('a reset during held rename cannot publish a superseded plan over fresh in-memory intent', async () => {
  const old = await fs.readFile(path, 'utf8'),
    entered = hold('primary-rename');
  const replacing = registry.set([entry('stale')]);
  const failure = expect(replacing).rejects.toThrow(/changed|superseded/);
  await reached(entered, replacing);
  registry.reset();
  await registry.set([entry('fresh')]);
  release!();
  await failure;
  await registry.flush();
  expect(registry.list(() => true).map((e) => e.sessionId)).toEqual(['fresh']);
  expect(await fs.readFile(path, 'utf8')).toBe(old);
});
it('does not chmod a replacement symlink while preserving an unacknowledged primary', async () => {
  const previous = await fs.readFile(path, 'utf8');
  await fs.writeFile(path + '.previous', previous);
  await fs.writeFile(path, '{damaged primary');
  const entered = hold('archive-chmod'),
    clearing = registry.clear(alice);
  const failure = expect(clearing).rejects.toThrow('changed');
  await reached(entered, clearing);
  const foreign = join(root, 'foreign');
  await fs.writeFile(foreign, 'foreign', { mode: 0o644 });
  await fs.rename(io.archived, io.archived + '.original');
  await fs.symlink(foreign, io.archived);
  release!();
  await failure;
  expect((await fs.stat(foreign)).mode & 0o777).toBe(0o644);
  expect(await fs.readFile(foreign, 'utf8')).toBe('foreign');
  expect(await fs.readFile(io.archived + '.original', 'utf8')).toBe('{damaged primary');
  expect(await fs.readFile(path + '.previous', 'utf8')).toBe(previous);
});
it('a superseded expiry no-op cannot clear a later failed snapshot acknowledgement', async () => {
  let writes = 0,
    entered!: () => void,
    resume!: () => void;
  const blocked = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const other = new RebootRestoreRegistry(async (target, text) => {
    writes++;
    if (writes === 2) {
      entered();
      await gate;
    }
    if (writes === 3) throw Error('Later queued ACK failed');
    await fs.writeFile(target, text);
  });
  await other.configurePersistence(join(root, 'noop.json'));
  await other.set([entry('old')]);
  const replacing = other.set([entry('new')]);
  await blocked;
  const clearing = other.clear(alice);
  const failure = expect(clearing).rejects.toThrow('queued ACK failed');
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 25 * 60 * 60 * 1000);
  expect(other.list(() => true)).toEqual([]);
  resume();
  await replacing;
  await failure;
  await other.flush();
  expect(writes).toBe(3);
  expect(other.getBrokerCleanupState()).toBeUndefined();
  expect(Reflect.get(other, 'persistenceWriteFailed')).toBe(true);
});
it('GET expiry returns immediately and withdraws held input before queued durable cleanup', async () => {
  const [held] = registry.take(alice, undefined, 'alice');
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 25 * 60 * 60 * 1000);
  const entered = hold('primary-directory-sync');
  expect(registry.list(() => true)).toEqual([]);
  expect(registry.isHeld(held, 'alice')).toBe(false);
  await entered;
  await heartbeat();
  expect(registry.getBrokerCleanupState()).toBeUndefined();
  release!();
  await registry.flush();
  expect(await restoredIds()).toEqual([]);
});
it('acknowledged owner dismissal recovers only the fully removed failed release domain', async () => {
  expect(registry.beginSpending('alice')).toBe(true);
  registry.take(alice, undefined, 'alice');
  const [bob] = registry.take((owner) => owner === 'bob', undefined, 'bob');
  io.failPrimaryAck = true;
  await expect(registry.releaseFlight('alice', [])).rejects.toThrow('ACK lost');
  expect(registry.getBrokerCleanupState()).toBeUndefined();
  expect(await registry.clear(alice)).toBe(1);
  expect(registry.getBrokerCleanupState()).toBeUndefined(); // The live spender still owns its lease.
  expect(registry.isHeld(bob, 'bob')).toBe(true);
  registry.endSpending('alice');
  expect(registry.getBrokerCleanupState()).toEqual({ entries: [], parked: [{ entry: bob, spender: 'bob' }] });
  expect(await restoredIds()).toEqual(['bob']);
});
it('shutdown drains expiry enqueued by the last closing request', async () => {
  rebootRestoreRegistry.reset();
  await rebootRestoreRegistry.configurePersistence(path);
  const server = new WebServer(0, false, true);
  const app = Reflect.get(server, 'app') as { close(): Promise<void> };
  vi.spyOn(app, 'close').mockImplementation(async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 25 * 60 * 60 * 1000);
    expect(rebootRestoreRegistry.list(() => true)).toEqual([]);
  });
  const entered = hold('primary-file-sync');
  let finished = false;
  const stopping = server.stop().then(() => {
    finished = true;
  });
  await reached(entered, stopping);
  await heartbeat();
  expect(finished).toBe(false);
  release!();
  await stopping;
  expect(await restoredIds()).toEqual([]);
});
it('actual dismiss waits for durable ACK while GET and competing restore stay responsive and effect-free', async () => {
  rebootRestoreRegistry.reset();
  await rebootRestoreRegistry.configurePersistence(path);
  const [held] = rebootRestoreRegistry.take(alice, undefined, 'alice');
  const h = await createRouteTestHarness(registerRebootRestoreRoutes);
  const entered = hold('primary-file-sync');
  const dismissing = h.app.inject({ method: 'POST', url: '/api/reboot-restore/dismiss', payload: {} });
  const response = Promise.resolve(dismissing);
  await reached(entered, response);
  try {
    expect(rebootRestoreRegistry.isHeld(held, 'alice')).toBe(false);
    const get = await h.app.inject({ method: 'GET', url: '/api/reboot-restore' });
    expect(get.statusCode).toBe(200);
    const competing = await h.app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    expect(competing.statusCode).toBe(409);
    expect(h.ctx.addSession).not.toHaveBeenCalled();
    release!();
    expect((await response).statusCode).toBe(200);
    expect(await restoredIds()).toEqual([]);
  } finally {
    release?.();
    await h.app.close();
  }
});
