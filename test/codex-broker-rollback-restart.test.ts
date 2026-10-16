/** @fileoverview Restart-discovered rollback uses disposable private files and trusted Python janitors only. */
import fs from 'node:fs/promises';
import { renameSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const MODULE = '../src/recovery/codex-broker-cleanup.js';
const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
let root: string;
beforeEach(async () => {
  vi.resetModules();
  root = await fs.mkdtemp(join(homedir(), 'broker-rollback-restart-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.doUnmock(MODULE);
  await fs.rm(root, { recursive: true, force: true });
});

async function failedCreate() {
  const cleanup = await import('../src/recovery/codex-broker-cleanup.js');
  vi.doMock(MODULE, () => ({
    ...cleanup,
    rollbackCodexBrokerProvisioning: (
      receipt: import('../src/recovery/codex-broker-cleanup.js').BrokerProvisioningRollback
    ) =>
      cleanup.rollbackCodexBrokerProvisioning(
        receipt,
        (() => {
          throw Error('janitor unavailable');
        }) as typeof spawn,
        false
      ),
  }));
  const { CodexInputBroker } = await import('../src/recovery/codex-input-broker.js');
  const session = join(root, 'codex-input-brokers', SID);
  const open = fs.open.bind(fs);
  let failed = false;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (
      !failed &&
      args[1] !== 'wx' &&
      String(args[0]).startsWith(session + '/') &&
      !String(args[0])
        .slice(session.length + 1)
        .includes('/')
    ) {
      failed = true;
      vi.spyOn(handle, 'sync').mockRejectedValueOnce(Error('fixture provisioning failed'));
    }
    return handle;
  });
  await expect(CodexInputBroker.create(session, SID, 'exec never-started-fixture', root, root)).rejects.toThrow(
    'fixture provisioning failed'
  );
  vi.restoreAllMocks();
  const names = await fs.readdir(session);
  const incarnation = names.find((name) => /^[a-f0-9-]{36}$/.test(name))!;
  const directory = join(session, incarnation);
  const marker = join(session, `.rollback-${incarnation}.json`);
  await fs.writeFile(join(root, 'state.json'), JSON.stringify({ sessions: {} }), { mode: 0o600 });
  await fs.writeFile(join(root, 'mux-sessions.json'), '[]', { mode: 0o600 });
  // A new module instance has neither the failed broker object nor its pending map.
  vi.doUnmock(MODULE);
  vi.resetModules();
  const fresh = await import('../src/recovery/codex-broker-cleanup.js');
  const prune = (transport: typeof spawn = spawn, references: unknown = {}) =>
    fresh.pruneCodexInputBrokers(root, () => fresh.captureBrokerCleanupReferences(() => references), transport);
  return { session, directory, marker, incarnation, prune };
}

it('rediscovers a failed create after process-local receipts disappear and a later janitor becomes available', async () => {
  const f = await failedCreate();
  const marker = await fs.readFile(f.marker);
  await f.prune((() => {
    throw Error('still unavailable after restart');
  }) as typeof spawn);
  expect(await fs.readFile(f.marker)).toEqual(marker);
  expect(await fs.readdir(f.directory)).toEqual(['broker.py', 'config.json', 'lock']);
  await f.prune();
  await expect(fs.lstat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.lstat(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([
  'config-inode',
  'directory-inode',
  'unknown-file',
  'runtime-state',
  'malformed-marker',
  'symlink-marker',
  'wrong-marker',
  'active-reference',
  'durable-reference',
] as const)('retains restart-discovered rollback when %s opposes exact unlaunched ownership', async (change) => {
  const f = await failedCreate();
  const config = join(f.directory, 'config.json');
  const original = await fs.readFile(config);
  if (change === 'config-inode') {
    await fs.writeFile(config + '.replacement', original, { mode: 0o600 });
    await fs.rename(config + '.replacement', config);
  }
  if (change === 'directory-inode') {
    await fs.rename(f.directory, f.directory + '.original');
    await fs.mkdir(f.directory, { mode: 0o700 });
    await fs.writeFile(config, original, { mode: 0o600 });
  }
  if (change === 'unknown-file') await fs.writeFile(join(f.directory, 'owner-private'), 'keep', { mode: 0o600 });
  if (change === 'runtime-state')
    await fs.writeFile(join(f.directory, 'state.json'), '{"startup":{"status":"reserved"}}', { mode: 0o600 });
  if (change === 'malformed-marker') await fs.writeFile(f.marker, '{');
  if (change === 'symlink-marker') {
    await fs.rename(f.marker, f.marker + '.original');
    await fs.symlink(f.marker + '.original', f.marker);
  }
  if (change === 'wrong-marker') {
    const receipt = JSON.parse(await fs.readFile(f.marker, 'utf8'));
    receipt.incarnation = randomUUID();
    await fs.writeFile(f.marker, JSON.stringify(receipt));
  }
  if (change === 'durable-reference')
    await fs.writeFile(join(root, 'state.json'), JSON.stringify({ sessions: {}, privatePrior: f.incarnation }));
  await f.prune(spawn, change === 'active-reference' ? { current: f.incarnation } : {});
  expect(await fs.readFile(config)).toEqual(original);
  expect(await fs.lstat(f.marker)).toBeDefined();
});

it.each(['config', 'marker'] as const)(
  'rechecks %s replacement after discovery READY before deleting any broker bytes',
  async (change) => {
    const f = await failedCreate();
    const config = join(f.directory, 'config.json');
    const original = await fs.readFile(config);
    const markerBytes = await fs.readFile(f.marker);
    let reached = false;
    const transport = ((...args: Parameters<typeof spawn>) => {
      const child = spawn(...args);
      child.stdout!.on('data', (raw) => {
        if (reached || !String(raw).includes('"ready"')) return;
        reached = true;
        const path = change === 'config' ? config : f.marker;
        writeFileSync(path + '.replacement', change === 'config' ? original : markerBytes, { mode: 0o600 });
        renameSync(path + '.replacement', path);
      });
      return child;
    }) as typeof spawn;
    await f.prune(transport);
    expect(reached).toBe(true);
    expect(await fs.readFile(config)).toEqual(original);
    expect(await fs.readdir(f.directory)).toEqual(['broker.py', 'config.json', 'lock']);
  }
);

it('rotates bounded discovery beyond a blocked prefix instead of stranding later durable receipts', async () => {
  const f = await failedCreate();
  for (let index = 0; index < 128; index++)
    await fs.writeFile(join(f.session, `!blocked-${String(index).padStart(3, '0')}`), 'unknown owner bytes', {
      mode: 0o600,
    });
  const positions: number[] = [];
  const transport = ((command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
    const injection = `real_scandir=os.scandir
class OrderedEntries:
    def __init__(self,source):
        with real_scandir(source) as entries: self.entries=iter(sorted(list(entries),key=lambda entry:entry.name))
    def __enter__(self): return self.entries
    def __exit__(self,*args): return False
os.scandir=OrderedEntries
`;
    const child = spawn(
      command,
      args.map((arg) => arg.replace('try: main()', injection + 'try: main()')),
      options
    );
    let output = '';
    child.stdout!.on('data', (raw) => {
      output += String(raw);
      let at: number;
      while ((at = output.indexOf('\n')) !== -1) {
        const value = JSON.parse(output.slice(0, at));
        output = output.slice(at + 1);
        if (typeof value.scanOffset === 'number') positions.push(value.scanOffset);
      }
    });
    return child;
  }) as typeof spawn;
  await f.prune(transport);
  expect(await fs.readFile(join(f.directory, 'config.json'), 'utf8')).toContain('never-started-fixture');
  await f.prune(transport);
  expect(positions).toEqual([128, 0]);
  await expect(fs.lstat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await fs.readdir(f.session)).filter((name) => name.startsWith('!blocked-'))).toHaveLength(128);
});

it.each(['partial-unlink', 'removed-without-completion'] as const)(
  'resumes durable rollback after %s without reconstructing missing file identities',
  async (failure) => {
    const f = await failedCreate();
    const transport = ((command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
      const injected =
        failure === 'partial-unlink'
          ? `real_unlink=os.unlink
removed_once=False
def fail_after_one(name,*args,**kwargs):
    global removed_once
    if removed_once: raise OSError(errno.EIO,'fixture interrupted unlink')
    result=real_unlink(name,*args,**kwargs)
    removed_once=True
    return result
os.unlink=fail_after_one
`
          : '';
      return spawn(
        command,
        args.map((arg) =>
          failure === 'partial-unlink'
            ? arg.replace('try: main()', injected + 'try: main()')
            : arg.replace(
                'os.rmdir(inc,dir_fd=rootfd)\n        os.fsync(rootfd)',
                "os.rmdir(inc,dir_fd=rootfd)\n        raise OSError(errno.EIO,'fixture interrupted completion')\n        os.fsync(rootfd)"
              )
        ),
        options
      );
    }) as typeof spawn;
    await f.prune(transport);
    expect(await fs.lstat(f.marker)).toBeDefined();
    if (failure === 'partial-unlink') expect(await fs.readdir(f.directory)).toHaveLength(2);
    else await expect(fs.lstat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await f.prune();
    await expect(fs.lstat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
  }
);
