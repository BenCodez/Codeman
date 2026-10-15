/** Only new disposable private directories and files are synced; no native worker runs. */
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexInputBroker } from '../src/recovery/codex-input-broker.js';
const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture(existing = false) {
  const root = await fs.mkdtemp(join(homedir(), 'broker-durable-parent-'));
  roots.push(root);
  const data = join(root, 'data'),
    brokers = join(data, 'codex-input-brokers'),
    session = join(brokers, SID);
  if (existing) await fs.mkdir(session, { recursive: true, mode: 0o700 });
  const events: string[] = [],
    closed: string[] = [];
  let fail: string | undefined;
  const open = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args),
      path = String(args[0]),
      sync = handle.sync.bind(handle),
      close = handle.close.bind(handle);
    vi.spyOn(handle, 'sync').mockImplementation(async () => {
      events.push(path);
      if (path === fail) throw Error('fixture parent sync failed');
      await sync();
    });
    vi.spyOn(handle, 'close').mockImplementation(async () => {
      await close();
      closed.push(path);
    });
    return handle;
  });
  return {
    root,
    data,
    brokers,
    session,
    events,
    closed,
    fail: (path: string | undefined) => {
      fail = path;
    },
  };
}
it('durably links every newly created ancestor before exposing a broker', async () => {
  const f = await fixture();
  const broker = await CodexInputBroker.create(f.session, SID, 'exec fixture-owned-child', f.root, f.root);
  expect(f.events.slice(-4)).toEqual([f.session, f.brokers, f.data, f.root]);
  expect(f.events.indexOf(broker.directory)).toBeLessThan(f.events.indexOf(f.session));
  expect(f.events).not.toContain(dirname(f.root));
  expect(f.closed).toEqual(f.events);
});
it('acknowledges only the explicit bounded private chain for an existing root', async () => {
  const f = await fixture(true);
  const broker = await CodexInputBroker.create(f.session, SID, 'exec fixture-owned-child', f.root, f.root);
  expect(f.events).toContain(broker.directory);
  expect(f.events.slice(-4)).toEqual([f.session, f.brokers, f.data, f.root]);
  expect(f.events).not.toContain(dirname(f.root));
});
it('refuses readiness and closes the FD when a required new parent entry cannot be synced', async () => {
  const f = await fixture();
  f.fail(f.brokers);
  await expect(CodexInputBroker.create(f.session, SID, 'exec fixture-owned-child', f.root, f.root)).rejects.toThrow(
    'fixture parent sync failed'
  );
  expect(f.closed).toContain(f.brokers);
  expect(f.events).not.toContain(f.data);
});

it.each(['brokers', 'data'] as const)(
  'acknowledges failed new %s ancestry on retry of the same root',
  async (ancestor) => {
    const f = await fixture();
    f.fail(f[ancestor]);
    await expect(CodexInputBroker.create(f.session, SID, 'exec fixture-owned-child', f.root, f.root)).rejects.toThrow(
      'fixture parent sync failed'
    );
    f.fail(undefined);
    f.events.length = 0;
    f.closed.length = 0;
    await CodexInputBroker.create(f.session, SID, 'exec fixture-owned-child', f.root, f.root);
    expect(f.events.slice(-4)).toEqual([f.session, f.brokers, f.data, f.root]);
    expect(f.closed).toEqual(f.events);
    expect(f.events).not.toContain(dirname(f.root));
  }
);
it('refuses an absent boundary before creating any private ancestor', async () => {
  const f = await fixture();
  await expect(CodexInputBroker.create(f.session, SID, 'exec fixture-owned-child', f.root, f.data)).rejects.toThrow();
  await expect(fs.stat(f.data)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('refuses a symlink boundary before creating any private ancestor', async () => {
  const f = await fixture();
  const alias = join(f.root, 'alias');
  await fs.symlink(f.root, alias);
  await expect(
    CodexInputBroker.create(join(alias, 'worker'), SID, 'exec fixture-owned-child', f.root, alias)
  ).rejects.toThrow('boundary');
  await expect(fs.stat(join(f.root, 'worker'))).rejects.toMatchObject({ code: 'ENOENT' });
});
