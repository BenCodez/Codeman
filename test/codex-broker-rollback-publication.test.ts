/** @fileoverview Marker publication uses disposable private files, failed fake helpers and trusted cleanup only. */
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BrokerProvisioningRollback } from '../src/recovery/codex-broker-cleanup.js';
import { createDeferred } from './mocks/index.js';

const MODULE = '../src/recovery/codex-broker-cleanup.js';
const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
let root: string;
beforeEach(async () => {
  vi.resetModules();
  root = await fs.mkdtemp(join(homedir(), 'broker-rollback-publication-'));
});
afterEach(async () => {
  if (vi.isFakeTimers()) vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.doUnmock(MODULE);
  await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const cleanup = await import('../src/recovery/codex-broker-cleanup.js');
  const transport = vi.fn(() => {
    throw Error('isolated unavailable janitor');
  }) as unknown as typeof spawn;
  vi.doMock(MODULE, () => ({
    ...cleanup,
    rollbackCodexBrokerProvisioning: (receipt: BrokerProvisioningRollback) =>
      cleanup.rollbackCodexBrokerProvisioning(receipt, transport, false),
  }));
  const { CodexInputBroker } = await import('../src/recovery/codex-input-broker.js');
  const session = join(root, 'codex-input-brokers', SID);
  const broker = await CodexInputBroker.create(session, SID, 'exec never-launched-fixture', root, root);
  const receipt = structuredClone(Reflect.get(broker, 'unlaunchedRollback')) as BrokerProvisioningRollback;
  const marker = join(session, `.rollback-${broker.incarnation}.json`);
  await fs.writeFile(join(root, 'state.json'), JSON.stringify({ sessions: {} }), { mode: 0o600 });
  await fs.writeFile(join(root, 'mux-sessions.json'), '[]', { mode: 0o600 });
  const coldCleanup = async () => {
    vi.doUnmock(MODULE);
    vi.resetModules();
    const fresh = await import('../src/recovery/codex-broker-cleanup.js');
    await fresh.pruneCodexInputBrokers(root, () => fresh.captureBrokerCleanupReferences(() => ({})), spawn);
  };
  return { cleanup, transport, session, broker, receipt, marker, coldCleanup };
}

function interruptWrite(code: string, replace?: 'same-bytes' | 'different') {
  const open = fs.open.bind(fs);
  let staging = '';
  let replacement = Buffer.alloc(0);
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[1] === 'wx' && /\.rollback-.*\.(?:next|json)$/.test(String(args[0]))) {
      staging = String(args[0]);
      const write = handle.writeFile.bind(handle);
      vi.spyOn(handle, 'writeFile').mockImplementationOnce(async (data) => {
        const prefix = Buffer.from(data as Uint8Array).subarray(0, 37);
        await write(prefix);
        if (replace) {
          await fs.rename(staging, staging + '.original');
          replacement = replace === 'same-bytes' ? prefix : Buffer.from('foreign owner bytes');
          await fs.writeFile(staging, replacement, { mode: 0o600 });
        }
        throw Object.assign(Error('interrupted receipt write'), { code });
      });
    }
    return handle;
  });
  return { staging: () => staging, replacement: () => replacement };
}

it.each(['EIO', 'ETIMEDOUT'] as const)(
  'republishes a partial %s write and remains discoverable after a fresh reload',
  async (code) => {
    const f = await fixture();
    const interrupted = interruptWrite(code);
    await f.broker.rollbackUnlaunchedProvisioning();
    expect(f.transport).not.toHaveBeenCalled();
    await expect(fs.lstat(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(interrupted.staging())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(f.broker.directory)).toEqual(['broker.py', 'config.json', 'lock']);
    vi.restoreAllMocks();
    await f.broker.rollbackUnlaunchedProvisioning();
    expect(JSON.parse(await fs.readFile(f.marker, 'utf8'))).toEqual(f.receipt);
    expect((await fs.stat(f.marker)).mode & 0o077).toBe(0);
    await f.coldCleanup();
    await expect(fs.lstat(f.broker.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
  }
);

it.each(['write', 'link', 'fsync'] as const)(
  'defers helper dispatch until %s publication failure is repaired by the bounded retry',
  async (fault) => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    if (fault === 'write') interruptWrite('EIO');
    if (fault === 'link') vi.spyOn(fs, 'link').mockRejectedValueOnce(Error('fixture publication link refused'));
    if (fault === 'fsync') {
      const open = fs.open.bind(fs);
      vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (args[1] === 'wx' && String(args[0]).endsWith('.next'))
          vi.spyOn(handle, 'sync').mockRejectedValueOnce(Error('fixture publication fsync refused'));
        return handle;
      });
    }
    expect(await f.cleanup.rollbackCodexBrokerProvisioning(f.receipt, f.transport, true)).toBe(false);
    await expect(fs.lstat(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.transport).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    await vi.advanceTimersByTimeAsync(2_100);
    await vi.waitFor(async () => {
      expect(JSON.parse(await fs.readFile(f.marker, 'utf8'))).toEqual(f.receipt);
      expect(f.transport).toHaveBeenCalledOnce();
    });
    vi.clearAllTimers();
    vi.useRealTimers();
    await f.coldCleanup();
    await expect(fs.lstat(f.broker.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  }
);

it.each(['same-bytes', 'different'] as const)(
  'preserves %s replacement staging instead of unlinking a foreign inode',
  async (replacement) => {
    const f = await fixture();
    const interrupted = interruptWrite('EIO', replacement);
    await f.broker.rollbackUnlaunchedProvisioning();
    expect(await fs.readFile(interrupted.staging())).toEqual(interrupted.replacement());
    expect(await fs.readFile(join(f.broker.directory, 'config.json'), 'utf8')).toContain('never-launched-fixture');
    vi.restoreAllMocks();
    await f.broker.rollbackUnlaunchedProvisioning();
    expect(JSON.parse(await fs.readFile(f.marker, 'utf8'))).toEqual(f.receipt);
    expect(await fs.readFile(interrupted.staging())).toEqual(interrupted.replacement());
  }
);

it('never overwrites an existing foreign final marker', async () => {
  const f = await fixture();
  const foreign = 'owner private marker bytes';
  await fs.writeFile(f.marker, foreign, { mode: 0o600 });
  const before = await fs.lstat(f.marker);
  await f.broker.rollbackUnlaunchedProvisioning();
  await f.broker.rollbackUnlaunchedProvisioning();
  const after = await fs.lstat(f.marker);
  expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
  expect(await fs.readFile(f.marker, 'utf8')).toBe(foreign);
  expect(await fs.readdir(f.session)).toEqual([`.rollback-${f.broker.incarnation}.json`, f.broker.incarnation].sort());
});

it('retains a complete atomic publication after a lost link acknowledgement', async () => {
  const f = await fixture();
  const link = fs.link.bind(fs);
  vi.spyOn(fs, 'link').mockImplementationOnce(async (...args) => {
    await link(...args);
    throw Object.assign(Error('lost committed link receipt'), { code: 'EIO' });
  });
  await f.broker.rollbackUnlaunchedProvisioning();
  expect(JSON.parse(await fs.readFile(f.marker, 'utf8'))).toEqual(f.receipt);
  expect((await fs.readdir(f.session)).filter((name) => name.endsWith('.next'))).toEqual([]);
  vi.restoreAllMocks();
  await f.coldCleanup();
  await expect(fs.lstat(f.broker.directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not publish a staging file whose complete bytes were replaced before commit', async () => {
  const f = await fixture();
  const open = fs.open.bind(fs);
  let staging = '';
  let original = Buffer.alloc(0);
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[1] === 'wx' && String(args[0]).endsWith('.next')) {
      staging = String(args[0]);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
        await close();
        original = await fs.readFile(staging);
        await fs.rename(staging, staging + '.original');
        await fs.writeFile(staging, original, { mode: 0o600 });
      });
    }
    return handle;
  });
  await f.broker.rollbackUnlaunchedProvisioning();
  expect(staging).not.toBe('');
  expect(await fs.readFile(staging)).toEqual(original);
  await expect(fs.lstat(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readdir(f.broker.directory)).toEqual(['broker.py', 'config.json', 'lock']);
});

it('rechecks staging identity after closing its read witness before the exclusive commit', async () => {
  const f = await fixture();
  const open = fs.open.bind(fs);
  let staging = '';
  let replaced = false;
  let original = Buffer.alloc(0);
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (!replaced && args[1] !== 'wx' && String(args[0]).endsWith('.next')) {
      staging = String(args[0]);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
        await close();
        replaced = true;
        original = await fs.readFile(staging);
        await fs.rename(staging, staging + '.original');
        await fs.writeFile(staging, original, { mode: 0o600 });
      });
    }
    return handle;
  });
  await f.broker.rollbackUnlaunchedProvisioning();
  expect(replaced).toBe(true);
  expect(await fs.readFile(staging)).toEqual(original);
  await expect(fs.lstat(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('coalesces duplicate rollback callers while publication has not completed', async () => {
  const f = await fixture();
  const release = createDeferred<void>();
  const open = fs.open.bind(fs);
  let writes = 0;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[1] === 'wx' && String(args[0]).endsWith('.next')) {
      const write = handle.writeFile.bind(handle);
      vi.spyOn(handle, 'writeFile').mockImplementationOnce(async (...data) => {
        writes++;
        await release.promise;
        return write(...data);
      });
    }
    return handle;
  });
  const first = f.broker.rollbackUnlaunchedProvisioning();
  const second = f.broker.rollbackUnlaunchedProvisioning();
  try {
    await vi.waitFor(() => expect(writes).toBe(1));
    expect((await fs.readdir(f.session)).filter((name) => name.endsWith('.next'))).toHaveLength(1);
    expect(f.transport).not.toHaveBeenCalled();
    await expect(fs.lstat(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    release.resolve();
    await Promise.all([first, second]);
  }
  expect(JSON.parse(await fs.readFile(f.marker, 'utf8'))).toEqual(f.receipt);
  expect(f.transport).toHaveBeenCalledOnce();
});
