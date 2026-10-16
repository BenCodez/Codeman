/** Disposable private FS plus the trusted janitor only. No broker, worker, tmux or SSH is launched. */
import fs from 'node:fs/promises';
import { renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BrokerProvisioningRollback } from '../src/recovery/codex-broker-cleanup.js';

const hooks = vi.hoisted(() => ({
  before: undefined as ((receipt: BrokerProvisioningRollback) => Promise<void>) | undefined,
  transport: undefined as typeof spawn | undefined,
  receipt: undefined as BrokerProvisioningRollback | undefined,
}));
vi.mock('../src/recovery/codex-broker-cleanup.js', async (original) => {
  const actual = await original<typeof import('../src/recovery/codex-broker-cleanup.js')>();
  const { spawn } = await import('node:child_process');
  return {
    ...actual,
    rollbackCodexBrokerProvisioning: vi.fn(async (receipt: BrokerProvisioningRollback) => {
      hooks.receipt = structuredClone(receipt);
      await hooks.before?.(receipt);
      await actual.rollbackCodexBrokerProvisioning(receipt, hooks.transport ?? spawn);
    }),
  };
});
import { CodexInputBroker } from '../src/recovery/codex-input-broker.js';
const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const roots: string[] = [];
const holders: ChildProcess[] = [];
beforeEach(() => {
  hooks.before = undefined;
  hooks.transport = undefined;
  hooks.receipt = undefined;
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const holder of holders.splice(0)) {
    if (holder.exitCode === null) {
      const closed = once(holder, 'close');
      holder.kill('SIGKILL');
      await closed;
    }
  }
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(join(homedir(), 'broker-provision-rollback-'));
  roots.push(root);
  const session = join(root, 'codex-input-brokers', SID);
  const open = fs.open.bind(fs);
  let failure = 'directory';
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    const path = String(args[0]);
    const relative = path.startsWith(session + '/') ? path.slice(session.length + 1) : '';
    const parts = relative.split('/');
    if (
      args[1] !== 'wx' &&
      ((failure === 'directory' && parts.length === 1 && relative) ||
        (failure === 'parent' && path === dirname(session)) ||
        (parts.length === 2 && parts[1] === failure))
    ) {
      vi.spyOn(handle, 'sync').mockRejectedValueOnce(Error('fixture provisioning fsync failed'));
    }
    return handle;
  });
  return {
    root,
    session,
    open,
    fail: (value: string) => {
      failure = value;
    },
    create: () => CodexInputBroker.create(session, SID, 'exec invocation-owned-never-started-child', root, root),
  };
}
it.each(['broker.py', 'config.json', 'lock', 'directory', 'parent'])(
  'rolls back only the unlaunched invocation after a %s durability failure',
  async (stage) => {
    const f = await fixture();
    f.fail(stage);
    await expect(f.create()).rejects.toThrow('fixture provisioning fsync failed');
    expect(await fs.readdir(f.session)).toEqual([]);
    expect(hooks.receipt?.files.map((file) => file.name)).toEqual(['broker.py', 'config.json', 'lock']);
    expect(await fs.readdir(f.root)).toEqual(['codex-input-brokers']);
  }
);
it('retains an unacknowledged private write instead of assuming its partially observed file is safe to delete', async () => {
  const f = await fixture();
  const open = f.open;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[1] === 'wx' && String(args[0]).endsWith('/config.json')) {
      const write = handle.writeFile.bind(handle);
      vi.spyOn(handle, 'writeFile').mockImplementation(async (...input) => {
        await write(...input);
        throw Error('fixture private write acknowledgement lost');
      });
    }
    return handle;
  });
  await expect(f.create()).rejects.toThrow('fixture private write acknowledgement lost');
  expect(hooks.receipt?.files.map((file) => file.name)).toEqual(['broker.py']);
  expect(await fs.readdir(join(f.session, hooks.receipt!.incarnation))).toEqual(['broker.py', 'config.json']);
});
it.each(['EINVAL', 'ENOTSUP'])(
  'removes only the certified empty incarnation when directory fsync is unsupported (%s)',
  async (errorCode) => {
    const f = await fixture();
    const injection = `real_fsync=os.fsync
def directory_sync_unsupported(fd):
    if stat.S_ISDIR(os.fstat(fd).st_mode): raise OSError(errno.${errorCode},'fixture unsupported directory fsync')
    return real_fsync(fd)
os.fsync=directory_sync_unsupported
`;
    hooks.transport = ((command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) =>
      spawn(
        command,
        args.map((arg) => arg.replace('try: main()', injection + 'try: main()')),
        options
      )) as typeof spawn;
    await expect(f.create()).rejects.toThrow('fixture provisioning fsync failed');
    expect(await fs.readdir(f.session)).toEqual([]);
  }
);
it('keeps a healthy returned broker intact and never requests prelaunch rollback', async () => {
  const f = await fixture();
  f.fail('none');
  const broker = await f.create();
  expect(hooks.receipt).toBeUndefined();
  expect(await fs.readdir(broker.directory)).toEqual(['broker.py', 'config.json', 'lock']);
});
it.each([false, true])(
  'can roll back a returned but unlaunched broker after startup authority changed=%s',
  async (guarded) => {
    const f = await fixture();
    f.fail('none');
    const broker = await f.create();
    if (guarded) await broker.setStartupAuthority();
    await broker.rollbackUnlaunchedProvisioning();
    expect(await fs.readdir(f.session)).toEqual([]);
    expect(hooks.receipt?.files.map((file) => file.name)).toEqual(['broker.py', 'config.json', 'lock']);
  }
);

it.each([
  'partial-write',
  'write-receipt',
  'file-sync',
  'file-close',
  'rename',
  'rename-receipt',
  'directory-open',
  'directory-sync',
  'directory-close',
] as const)('rolls back the exact unlaunched startup after a %s failure', async (fault) => {
  const f = await fixture();
  f.fail('none');
  const broker = await f.create();
  const path = join(broker.directory, 'config.json'),
    next = `${path}.next`;
  const original = await fs.readFile(path);
  const writeFile = fs.writeFile.bind(fs),
    rename = fs.rename.bind(fs);
  const injected = new Error(`fixture startup ${fault} failed`);
  let stagingCloseInjected = false;
  // Both the previous path writer and the owned-handle writer perform actual
  // partial/full writes before their simulated acknowledgement is lost.
  vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
    if (String(args[0]) === next && (fault === 'partial-write' || fault === 'write-receipt')) {
      const bytes = Buffer.from(args[1] as string);
      await writeFile(args[0], fault === 'partial-write' ? bytes.subarray(0, 31) : bytes, args[2]);
      throw injected;
    }
    return writeFile(...args);
  });
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const target = String(args[0]);
    if (target === broker.directory && fault === 'directory-open') throw injected;
    const handle = await f.open(...args);
    if (target === next) {
      if (args[1] === 'wx' && (fault === 'partial-write' || fault === 'write-receipt')) {
        const write = handle.writeFile.bind(handle);
        vi.spyOn(handle, 'writeFile').mockImplementation(async (...input) => {
          const bytes = Buffer.from(input[0] as string);
          await write(fault === 'partial-write' ? bytes.subarray(0, 31) : bytes);
          throw injected;
        });
      }
      if (fault === 'file-sync') vi.spyOn(handle, 'sync').mockRejectedValueOnce(injected);
      if (fault === 'file-close' && !stagingCloseInjected) {
        stagingCloseInjected = true;
        const close = handle.close.bind(handle);
        vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
          await close();
          throw injected;
        });
      }
    }
    if (target === broker.directory) {
      if (fault === 'directory-sync') vi.spyOn(handle, 'sync').mockRejectedValueOnce(injected);
      if (fault === 'directory-close') {
        const close = handle.close.bind(handle);
        vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
          await close();
          throw injected;
        });
      }
    }
    return handle;
  });
  vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
    if (String(args[0]) === next && fault === 'rename') throw injected;
    await rename(...args);
    if (String(args[0]) === next && fault === 'rename-receipt') throw injected;
  });
  await expect(broker.setStartupAuthority()).rejects.toBe(injected);
  expect(await fs.readdir(broker.directory)).toEqual(['broker.py', 'config.json', 'lock']);
  const current = await fs.readFile(path);
  const replaced = ['rename-receipt', 'directory-open', 'directory-sync', 'directory-close'].includes(fault);
  expect(current.equals(original)).toBe(!replaced);
  expect(broker.configurationDigest).toBe(createHash('sha256').update(current).digest('hex'));
  await broker.rollbackUnlaunchedProvisioning();
  expect(await fs.readdir(f.session)).toEqual([]);
  const file = hooks.receipt!.files.find((file) => file.name === 'config.json')!;
  expect(file.hash).toBe(createHash('sha256').update(current).digest('hex'));
});

it.each(['inode', 'bytes', 'symlink', 'permissions', 'directory'] as const)(
  'preserves startup staging when %s evidence no longer proves invocation ownership',
  async (change) => {
    const f = await fixture();
    f.fail('none');
    const broker = await f.create();
    const next = join(broker.directory, 'config.json.next'),
      outside = join(f.root, 'owner-private-file');
    await fs.writeFile(outside, 'keep owner bytes', { mode: 0o600 });
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await f.open(...args);
      if (String(args[0]) === next && args[1] === 'wx') {
        vi.spyOn(handle, 'sync').mockImplementationOnce(async () => {
          if (change === 'inode') {
            await fs.writeFile(next + '.owner', 'keep owner bytes', { mode: 0o600 });
            await fs.rename(next + '.owner', next);
          } else if (change === 'bytes') await fs.writeFile(next, 'keep owner bytes');
          else if (change === 'symlink') {
            await fs.unlink(next);
            await fs.symlink(outside, next);
          } else if (change === 'permissions') await fs.chmod(next, 0o644);
          else {
            await fs.rename(broker.directory, broker.directory + '.held');
            await fs.mkdir(broker.directory, { mode: 0o700 });
            await fs.writeFile(next, 'keep owner bytes', { mode: 0o600 });
          }
          throw Error('fixture staging ownership changed');
        });
      }
      return handle;
    });
    await expect(broker.setStartupAuthority()).rejects.toThrow('fixture staging ownership changed');
    await broker.rollbackUnlaunchedProvisioning();
    expect(await fs.readFile(outside, 'utf8')).toBe('keep owner bytes');
    if (change !== 'permissions') expect(await fs.readFile(next, 'utf8')).toBe('keep owner bytes');
    else expect((await fs.stat(next)).mode & 0o077).toBe(0o044);
    if (change === 'directory') expect(await fs.readdir(broker.directory + '.held')).toContain('config.json.next');
    else expect(await fs.readdir(broker.directory)).toEqual(['broker.py', 'config.json', 'config.json.next', 'lock']);
  }
);

it.each(['inode', 'bytes', 'symlink'] as const)(
  'refuses to replace a changed %s configuration and removes only its own startup stage',
  async (change) => {
    const f = await fixture();
    f.fail('none');
    const broker = await f.create();
    const path = join(broker.directory, 'config.json'),
      next = `${path}.next`;
    const original = await fs.readFile(path),
      outside = join(f.root, 'owner-config');
    await fs.writeFile(outside, original, { mode: 0o600 });
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await f.open(...args);
      if (String(args[0]) === next && args[1] === 'wx') {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, 'sync').mockImplementationOnce(async () => {
          await sync();
          if (change === 'inode') await fs.rename(outside, path);
          else if (change === 'bytes') await fs.writeFile(path, original.toString() + '\n');
          else {
            await fs.unlink(path);
            await fs.symlink(outside, path);
          }
        });
      }
      return handle;
    });
    await expect(broker.setStartupAuthority()).rejects.toThrow();
    expect(await fs.readdir(broker.directory)).toEqual(['broker.py', 'config.json', 'lock']);
    const changed = await fs.lstat(path);
    await broker.rollbackUnlaunchedProvisioning();
    expect((await fs.lstat(path)).ino).toBe(changed.ino);
    expect(await fs.readFile(path, 'utf8')).toBe(original.toString() + (change === 'bytes' ? '\n' : ''));
    if (change === 'symlink') expect(changed.isSymbolicLink()).toBe(true);
  }
);

it.each(['unknown-file', 'started-child', 'reserved-receipt', 'replaced-config'] as const)(
  'retains an updated post-rename broker when %s vetoes unlaunched rollback',
  async (change) => {
    const f = await fixture();
    f.fail('none');
    const broker = await f.create();
    const path = join(broker.directory, 'config.json');
    let current!: Buffer;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await f.open(...args);
      if (String(args[0]) === broker.directory)
        vi.spyOn(handle, 'sync').mockImplementationOnce(async () => {
          current = await fs.readFile(path);
          if (change === 'unknown-file')
            await fs.writeFile(join(broker.directory, 'owner-file'), 'keep', { mode: 0o600 });
          else if (change === 'started-child' || change === 'reserved-receipt')
            await fs.writeFile(
              join(broker.directory, 'state.json'),
              JSON.stringify(
                change === 'started-child'
                  ? { startup: { status: 'started' }, childPid: 123 }
                  : { receipts: [{ status: 'reserved' }] }
              ),
              { mode: 0o600 }
            );
          else {
            await fs.writeFile(path + '.owner', current, { mode: 0o600 });
            await fs.rename(path + '.owner', path);
          }
          throw Error('fixture post-rename sync failed');
        });
      return handle;
    });
    await expect(broker.setStartupAuthority()).rejects.toThrow('fixture post-rename sync failed');
    await broker.rollbackUnlaunchedProvisioning();
    expect(await fs.readFile(path)).toEqual(current);
    expect(await fs.readdir(broker.directory)).toContain('broker.py');
    expect(hooks.receipt!.files.find((file) => file.name === 'config.json')?.hash).toBe(
      createHash('sha256').update(current).digest('hex')
    );
  }
);
it.each([
  'directory',
  'parent',
  'file-inode',
  'file-bytes',
  'symlink',
  'unknown-file',
  'tainted-journal',
  'reserved-receipt',
  'permissions',
])('retains private files when %s evidence makes failed provisioning uncertain', async (change) => {
  const f = await fixture();
  let original = '';
  hooks.before = async (receipt) => {
    original = join(receipt.root, receipt.incarnation);
    const config = join(original, 'config.json');
    if (change === 'directory') {
      await fs.rename(original, original + '.held');
      await fs.mkdir(original, { mode: 0o700 });
      await fs.writeFile(join(original, 'owner-file'), 'keep', { mode: 0o600 });
    } else if (change === 'parent') {
      await fs.rename(f.session, f.session + '.held');
      await fs.mkdir(f.session, { mode: 0o700 });
    } else if (change === 'file-inode') {
      const replacement = join(f.root, 'replacement');
      await fs.writeFile(replacement, await fs.readFile(config), { mode: 0o600 });
      await fs.rename(replacement, config);
    } else if (change === 'file-bytes') await fs.writeFile(config, 'owner replacement bytes');
    else if (change === 'symlink') {
      const outside = join(f.root, 'outside');
      await fs.writeFile(outside, 'outside private bytes', { mode: 0o600 });
      await fs.unlink(config);
      await fs.symlink(outside, config);
    } else if (change === 'unknown-file') await fs.writeFile(join(original, 'owner-file'), 'keep', { mode: 0o600 });
    else if (change === 'tainted-journal')
      await fs.writeFile(join(original, 'state.json'), '{"tainted":true}', { mode: 0o600 });
    else if (change === 'reserved-receipt')
      await fs.writeFile(join(original, 'state.json'), '{"receipts":[{"status":"reserved"}]}', { mode: 0o600 });
    else await fs.chmod(config, 0o644);
  };
  await expect(f.create()).rejects.toThrow('fixture provisioning fsync failed');
  const kept =
    change === 'directory'
      ? original + '.held'
      : change === 'parent'
        ? join(f.session + '.held', hooks.receipt!.incarnation)
        : original;
  expect(await fs.readdir(kept)).toEqual(expect.arrayContaining(['broker.py', 'config.json', 'lock']));
  if (change === 'directory') expect(await fs.readFile(join(original, 'owner-file'), 'utf8')).toBe('keep');
  if (change === 'symlink') expect(await fs.readFile(join(f.root, 'outside'), 'utf8')).toBe('outside private bytes');
});
it('retains a failed unlaunched directory while an actual kernel lease holds its lock', async () => {
  const f = await fixture();
  hooks.before = async (receipt) => {
    const holder = spawn(
      'python3',
      [
        '-I',
        '-c',
        'import fcntl,sys,time; f=open(sys.argv[1],"r+"); fcntl.flock(f,fcntl.LOCK_EX); print("READY",flush=True); time.sleep(10)',
        join(receipt.root, receipt.incarnation, 'lock'),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    holders.push(holder);
    const [ready] = await once(holder.stdout!, 'data');
    expect(String(ready)).toBe('READY\n');
  };
  await expect(f.create()).rejects.toThrow('fixture provisioning fsync failed');
  expect(await fs.readdir(join(f.session, hooks.receipt!.incarnation))).toEqual(['broker.py', 'config.json', 'lock']);
});
it('rechecks a captured file after rollback READY before removing any secret bytes', async () => {
  const f = await fixture();
  let changed = false;
  hooks.before = async (receipt) => {
    await fs.writeFile(
      join(f.root, 'replacement'),
      await fs.readFile(join(receipt.root, receipt.incarnation, 'config.json')),
      { mode: 0o600 }
    );
  };
  hooks.transport = ((...args: Parameters<typeof spawn>) => {
    const child = spawn(...args);
    child.stdout!.on('data', (raw: Buffer) => {
      if (!String(raw).includes('"rollback"')) return;
      changed = true;
      renameSync(join(f.root, 'replacement'), join(hooks.receipt!.root, hooks.receipt!.incarnation, 'config.json'));
    });
    return child;
  }) as typeof spawn;
  await expect(f.create()).rejects.toThrow('fixture provisioning fsync failed');
  expect(changed).toBe(true);
  expect(await fs.readdir(join(f.session, hooks.receipt!.incarnation))).toEqual(['broker.py', 'config.json', 'lock']);
});
