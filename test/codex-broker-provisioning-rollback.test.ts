/** Disposable private FS plus the trusted janitor only. No broker, worker, tmux or SSH is launched. */
import fs from 'node:fs/promises';
import { renameSync } from 'node:fs';
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
