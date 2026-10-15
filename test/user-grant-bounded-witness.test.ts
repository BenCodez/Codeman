/** Isolated owner grants: no live workers, user data, blocking FIFO, or installed homes. */
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDataDirPath } from '../src/config/instance.js';
import * as users from '../src/user-store.js';
import { clampRecoveryLaunchForOwner } from '../src/session-env-clamp.js';

let dir: string;
const account = (patch: Record<string, unknown> = {}) => ({
  username: 'owner',
  role: 'user',
  canBypassPermissions: true,
  ...patch,
});
const path = () => join(dir, 'users.json');
const payload = (records: unknown[] = [account()]) => JSON.stringify({ version: 1, users: records });
async function replace(text = payload()) {
  await fs.writeFile(`${path()}.replacement`, text);
  await fs.rename(`${path()}.replacement`, path());
}
function held<T>() {
  let release!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'codeman-bounded-grant-'));
  vi.stubEnv('CODEMAN_DATA_DIR', dir);
  vi.stubEnv('CODEMAN_MULTIUSER', '1');
  users.invalidateUsersCache();
  await replace();
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  users.invalidateUsersCache();
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('private recovery owner evidence', () => {
  it('keeps same-file manager and worker grants current and exposes only immutable private stats/hash', async () => {
    const [manager, worker] = await Promise.all([
      users.prepareRecoveryPrivilegeGrant('owner'),
      users.prepareRecoveryPrivilegeGrant('owner'),
    ]);
    expect(manager.privileged).toBe(true);
    expect(worker.privileged).toBe(true);
    expect(manager.isCurrent()).toBe(true);
    expect(worker.isCurrent()).toBe(true);
    expect(await manager.verifyCurrent()).toBe(true);
    expect(manager.fileWitness).toMatchObject({ path: path(), maxBytes: 2 * 1024 * 1024 });
    expect(manager.fileWitness?.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(manager.fileWitness)).toBe(true);
    const copy = manager.getFileWitness()!;
    copy.hash = 'changed';
    expect(manager.getFileWitness()?.hash).not.toBe('changed');
    expect(Object.keys(manager.fileWitness!)).toEqual([
      'path',
      'dev',
      'ino',
      'size',
      'mtimeMs',
      'ctimeMs',
      'hash',
      'maxBytes',
    ]);
  });

  it('does no filesystem work in the final pure predicate, even if filesystems would throw', async () => {
    const grant = await users.prepareRecoveryPrivilegeGrant('owner');
    const stat = vi.spyOn(syncFs, 'statSync').mockImplementation(() => {
      throw new Error('sync filesystem prohibited');
    });
    const mkdir = vi.spyOn(syncFs, 'mkdirSync').mockImplementation(() => {
      throw new Error('sync mkdir prohibited');
    });
    const read = vi.spyOn(fs, 'readFile').mockRejectedValue(new Error('no read'));
    const lstat = vi.spyOn(fs, 'lstat').mockRejectedValue(new Error('no stat'));
    for (let index = 0; index < 10; index++) expect(grant.isCurrent()).toBe(true);
    expect(stat).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(lstat).not.toHaveBeenCalled();
    expect(getDataDirPath()).toBe(dir);
  });

  it.each(['same-bytes-new-inode', 'revoked', 'disabled', 'missing', 'malformed'])(
    'vetoes changed external file in its async witness: %s',
    async (change) => {
      const grant = await users.prepareRecoveryPrivilegeGrant('owner');
      if (change === 'same-bytes-new-inode') await replace();
      if (change === 'revoked') await replace(payload([account({ canBypassPermissions: false })]));
      if (change === 'disabled') await replace(payload([account({ disabled: true })]));
      if (change === 'missing') await fs.unlink(path());
      if (change === 'malformed') await replace('{broken');
      // External bytes belong to the joined asynchronous witness, never a synchronous stat.
      expect(grant.isCurrent()).toBe(true);
      expect(await grant.verifyCurrent()).toBe(false);
    }
  );

  it.each(['cache-permission', 'invalidate', 'mode', 'data-dir', 'home', 'instance'])(
    'immediately vetoes known memory/scope changes: %s',
    async (change) => {
      const grant = await users.prepareRecoveryPrivilegeGrant('owner');
      if (change === 'cache-permission') (await users.findUser('owner'))!.canBypassPermissions = false;
      if (change === 'invalidate') users.invalidateUsersCache();
      if (change === 'mode') vi.stubEnv('CODEMAN_MULTIUSER', 'true');
      if (change === 'data-dir') vi.stubEnv('CODEMAN_DATA_DIR', `${dir}-other`);
      if (change === 'home') vi.stubEnv('HOME', `${dir}-home`);
      if (change === 'instance') vi.stubEnv('CODEMAN_INSTANCE', 'different-grant-realm');
      expect(grant.isCurrent()).toBe(false);
      expect(await grant.verifyCurrent()).toBe(false);
    }
  );

  it('clamps a current safe-mode owner and carries the private witness to the final caller', async () => {
    await replace(payload([account({ canBypassPermissions: false })]));
    const clamp = await clampRecoveryLaunchForOwner(
      'owner',
      { codexConfig: { sandbox: 'danger-full-access', dangerouslyBypassApprovals: true } },
      { DSH_HOME: '/fixture/profile', CODEX_HOME: '/fixture/codex', SAFE_ENV: 'safe' }
    );
    expect(clamp.configs.codexConfig).toEqual({ sandbox: 'workspace-write', dangerouslyBypassApprovals: false });
    expect(clamp.env).toEqual({ SAFE_ENV: 'safe' });
    expect(clamp.isCurrent()).toBe(true);
    expect(clamp.getFileWitness()).toEqual(clamp.fileWitness);
    expect(await clamp.verifyCurrent()).toBe(true);
  });

  it('known account writes invalidate old grants while a fresh safe grant remains current', async () => {
    const previous = await users.prepareRecoveryPrivilegeGrant('owner');
    await users.updateUser('owner', { canBypassPermissions: false });
    expect(previous.isCurrent()).toBe(false);
    const safe = await users.prepareRecoveryPrivilegeGrant('owner');
    expect(safe.privileged).toBe(false);
    expect(safe.isCurrent()).toBe(true);
    expect(await safe.verifyCurrent()).toBe(true);
  });

  it('single-user has no file authority and still binds the original data/mode scope', async () => {
    vi.stubEnv('CODEMAN_MULTIUSER', '0');
    await fs.unlink(path());
    const open = vi.spyOn(fs, 'open');
    const grant = await users.prepareRecoveryPrivilegeGrant(undefined);
    expect(grant.privileged).toBe(true);
    expect(grant.getFileWitness()).toBeUndefined();
    expect(await grant.verifyCurrent()).toBe(true);
    expect(open).not.toHaveBeenCalled();
    vi.stubEnv('CODEMAN_DATA_DIR', `${dir}-other`);
    expect(grant.isCurrent()).toBe(false);
  });

  it.each([
    '{malformed',
    JSON.stringify({ version: 1, users: [account()], extra: true }),
    payload([]),
    payload([account(), account()]),
    payload([account({ disabled: true })]),
    payload([account({ role: 'unknown' })]),
    payload([account({ disabled: 'false' })]),
    payload([account({ canBypassPermissions: 'true' })]),
  ])('refuses malformed, ambiguous, missing or disabled owner: %s', async (text) => {
    await replace(text);
    const grant = await users.prepareRecoveryPrivilegeGrant('owner');
    expect(grant.isCurrent()).toBe(false);
    expect(grant.fileWitness).toBeUndefined();
  });

  it.each(['password', 'unrelated'])('refuses malformed UTF-8 even inside an irrelevant %s field', async (field) => {
    const bytes = Buffer.concat([
      Buffer.from(`{"version":1,"users":[{"username":"owner","role":"admin","${field}":"`),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}]}'),
    ]);
    await fs.writeFile(path(), bytes);
    const grant = await users.prepareRecoveryPrivilegeGrant('owner');
    expect(grant.privileged).toBe(false);
    expect(grant.isCurrent()).toBe(false);
    expect(grant.fileWitness).toBeUndefined();
  });

  it('does not open an oversized or symlink leaf', async () => {
    const open = vi.spyOn(fs, 'open');
    await fs.writeFile(path(), Buffer.alloc(2 * 1024 * 1024 + 1));
    expect((await users.prepareRecoveryPrivilegeGrant('owner')).isCurrent()).toBe(false);
    expect(open).not.toHaveBeenCalled();
    await fs.unlink(path());
    await fs.writeFile(join(dir, 'actual'), payload());
    await fs.symlink(join(dir, 'actual'), path());
    expect((await users.prepareRecoveryPrivilegeGrant('owner')).isCurrent()).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});

describe('bounded nonblocking file proof', () => {
  it.each(['FIFO', 'different-inode', 'different-size', 'after-read-change'])(
    'refuses %s without trusting replacement bytes',
    async (change) => {
      const realOpen = fs.open.bind(fs);
      const read = vi.fn();
      let flags: unknown;
      vi.spyOn(fs, 'open').mockImplementation(async (name, options) => {
        flags = options;
        const file = await realOpen(name, options);
        const originalStat = file.stat.bind(file);
        const originalRead = file.read.bind(file);
        let stats = 0;
        vi.spyOn(file, 'stat').mockImplementation(async () => {
          const value = await originalStat();
          stats++;
          if (change === 'FIFO') Object.defineProperty(value, 'isFile', { value: () => false });
          if (change === 'different-inode' || (change === 'after-read-change' && stats === 2)) value.ino++;
          if (change === 'different-size') value.size++;
          return value;
        });
        vi.spyOn(file, 'read').mockImplementation(async (...args: Parameters<typeof file.read>) => {
          read();
          return originalRead(...args);
        });
        return file;
      });
      const grant = await users.prepareRecoveryPrivilegeGrant('owner');
      expect(grant.isCurrent()).toBe(false);
      expect((flags as number) & syncFs.constants.O_NONBLOCK).toBe(syncFs.constants.O_NONBLOCK);
      expect((flags as number) & syncFs.constants.O_NOFOLLOW).toBe(syncFs.constants.O_NOFOLLOW);
      expect(read).toHaveBeenCalledTimes(change === 'after-read-change' ? 1 : 0);
    }
  );

  it('checks path replacement during asynchronous close before granting authority', async () => {
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (name, flags) => {
      const file = await realOpen(name, flags);
      const close = file.close.bind(file);
      vi.spyOn(file, 'close').mockImplementation(async () => {
        await replace();
        await close();
      });
      return file;
    });
    expect((await users.prepareRecoveryPrivilegeGrant('owner')).isCurrent()).toBe(false);
  });

  it.each(['lstat', 'open', 'read', 'close'])(
    'times out held %s without blocking, retains singleflight, and closes late handles',
    async (operation) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
      const gate = held<void>();
      const started = held<void>();
      let closes = 0;
      const realLstat = fs.lstat.bind(fs);
      const realOpen = fs.open.bind(fs);
      let invocations = 0;
      if (operation === 'lstat')
        vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
          invocations++;
          if (invocations === 1) {
            started.release();
            await gate.promise;
          }
          return realLstat(...args);
        });
      vi.spyOn(fs, 'open').mockImplementation(async (name, flags) => {
        if (operation === 'open') {
          invocations++;
          started.release();
          await gate.promise;
        }
        const file = await realOpen(name, flags);
        const close = file.close.bind(file);
        vi.spyOn(file, 'close').mockImplementation(async () => {
          if (operation === 'close') {
            invocations++;
            started.release();
            await gate.promise;
          }
          closes++;
          await close();
        });
        if (operation === 'read') {
          const read = file.read.bind(file);
          vi.spyOn(file, 'read').mockImplementation(async (...args: Parameters<typeof file.read>) => {
            invocations++;
            started.release();
            await gate.promise;
            return read(...args);
          });
        }
        return file;
      });
      const first = users.prepareRecoveryPrivilegeGrant('owner');
      await started.promise;
      let heartbeat = false;
      setTimeout(() => {
        heartbeat = true;
      }, 1);
      const second = users.prepareRecoveryPrivilegeGrant('owner');
      await vi.advanceTimersByTimeAsync(2_001);
      expect(heartbeat).toBe(true);
      expect((await first).isCurrent()).toBe(false);
      expect((await second).isCurrent()).toBe(false);
      expect((await users.prepareRecoveryPrivilegeGrant('owner')).isCurrent()).toBe(false);
      expect(invocations).toBe(1);
      gate.release();
      vi.useRealTimers();
      // Cleanup owns the late FD; wait for it without starting a replacement proof.
      for (let index = 0; index < 30 && (operation === 'lstat' ? invocations < 1 : closes < 1); index++)
        await new Promise((resolve) => setTimeout(resolve, 2));
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (operation !== 'lstat') expect(closes).toBe(1);
      expect(await users.findUser('owner')).toBeDefined();
    }
  );

  it('caps pending domains at two and retains timed-out jobs until their late work settles', async () => {
    const secondDir = join(dir, 'second');
    const thirdDir = join(dir, 'third');
    await fs.mkdir(secondDir);
    await fs.mkdir(thirdDir);
    await fs.writeFile(join(secondDir, 'users.json'), payload());
    await fs.writeFile(join(thirdDir, 'users.json'), payload());
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const realLstat = fs.lstat.bind(fs);
    const gate = held<void>();
    const started = held<void>();
    const inspected: string[] = [];
    vi.spyOn(fs, 'lstat').mockImplementation(async (name, ...args) => {
      inspected.push(String(name));
      if (inspected.length === 2) started.release();
      await gate.promise;
      return realLstat(name, ...args);
    });
    const first = users.prepareRecoveryPrivilegeGrant('owner');
    vi.stubEnv('CODEMAN_DATA_DIR', secondDir);
    const second = users.prepareRecoveryPrivilegeGrant('owner');
    await started.promise;
    vi.stubEnv('CODEMAN_DATA_DIR', thirdDir);
    expect((await users.prepareRecoveryPrivilegeGrant('owner')).isCurrent()).toBe(false);
    await vi.advanceTimersByTimeAsync(2_001);
    expect((await first).isCurrent()).toBe(false);
    expect((await second).isCurrent()).toBe(false);
    expect((await users.prepareRecoveryPrivilegeGrant('owner')).isCurrent()).toBe(false);
    expect(inspected).toEqual([path(), join(secondDir, 'users.json')]);
    gate.release();
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await users.prepareRecoveryPrivilegeGrant('owner')).isCurrent()).toBe(true);
  });

  it('refuses a short read and closes its captured descriptor', async () => {
    const realOpen = fs.open.bind(fs);
    const closed = vi.fn();
    vi.spyOn(fs, 'open').mockImplementation(async (name, flags) => {
      const file = await realOpen(name, flags);
      const close = file.close.bind(file);
      vi.spyOn(file, 'read').mockResolvedValue({ bytesRead: 0, buffer: Buffer.alloc(0) });
      vi.spyOn(file, 'close').mockImplementation(async () => {
        closed();
        await close();
      });
      return file;
    });
    expect((await users.prepareRecoveryPrivilegeGrant('owner')).isCurrent()).toBe(false);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('checks the original monotonic deadline after asynchronous close even before a timer fires', async () => {
    const realOpen = fs.open.bind(fs);
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(fs, 'open').mockImplementation(async (name, flags) => {
      const file = await realOpen(name, flags);
      const close = file.close.bind(file);
      vi.spyOn(file, 'close').mockImplementation(async () => {
        await close();
        now = 2_001;
      });
      return file;
    });
    expect((await users.prepareRecoveryPrivilegeGrant('owner')).isCurrent()).toBe(false);
  });

  it.each(['owner', 'sibling'])('a held read cannot undo a newer %s in-place permission revocation', async (target) => {
    await replace(payload([account(), account({ username: 'sibling' })]));
    const owner = await users.prepareRecoveryPrivilegeGrant('owner');
    const sibling = await users.prepareRecoveryPrivilegeGrant('sibling');
    const realOpen = fs.open.bind(fs);
    const gate = held<void>();
    const started = held<void>();
    vi.spyOn(fs, 'open').mockImplementation(async (name, flags) => {
      const file = await realOpen(name, flags);
      const read = file.read.bind(file);
      vi.spyOn(file, 'read').mockImplementation(async (...args: Parameters<typeof file.read>) => {
        const result = await read(...args);
        started.release();
        await gate.promise;
        return result;
      });
      return file;
    });
    const pending = users.prepareRecoveryPrivilegeGrant('owner');
    await started.promise;
    (await users.findUser(target))!.canBypassPermissions = false;
    gate.release();
    expect((await pending).isCurrent()).toBe(false);
    expect((await users.findUser(target))?.canBypassPermissions).toBe(false);
    expect(target === 'owner' ? owner.isCurrent() : sibling.isCurrent()).toBe(false);
    expect(target === 'owner' ? sibling.isCurrent() : owner.isCurrent()).toBe(true);
  });

  it('a late read cannot overwrite a newer revoked in-memory owner or cache', async () => {
    const previous = await users.prepareRecoveryPrivilegeGrant('owner');
    const realOpen = fs.open.bind(fs);
    const gate = held<void>();
    const started = held<void>();
    vi.spyOn(fs, 'open').mockImplementation(async (name, flags) => {
      const file = await realOpen(name, flags);
      const read = file.read.bind(file);
      vi.spyOn(file, 'read').mockImplementation(async (...args: Parameters<typeof file.read>) => {
        const result = await read(...args);
        started.release();
        await gate.promise;
        return result;
      });
      return file;
    });
    const next = users.prepareRecoveryPrivilegeGrant('owner');
    await started.promise;
    (await users.findUser('owner'))!.canBypassPermissions = false;
    users.invalidateUsersCache();
    await replace(payload([account({ canBypassPermissions: false })]));
    gate.release();
    expect((await next).isCurrent()).toBe(false);
    expect(previous.isCurrent()).toBe(false);
    expect((await users.findUser('owner'))?.canBypassPermissions).toBe(false);
  });
});
