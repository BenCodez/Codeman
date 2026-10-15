/** Actual generated fake-SSH/native reader and disposable workers only. No real SSH or pane. */
import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { CodexInputBroker } from '../src/recovery/codex-input-broker.js';
import { remoteBrokerReaderFixture } from './mocks/remote-broker-reader-fixture.js';
const fixtures: Awaited<ReturnType<typeof remoteBrokerReaderFixture>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
async function fixture() {
  const f = await remoteBrokerReaderFixture();
  fixtures.push(f);
  return f;
}
it.each(['restart', 'restore'] as const)(
  'does not provision a remote %s when source-host material cannot be retained',
  async (kind) => {
    const f = await fixture(),
      provision = vi.spyOn(f.options.provisionTransport, 'run');
    vi.spyOn(f.cache, 'prepare').mockResolvedValue(undefined);
    const result = await f.rotate(kind);
    expect(result.result).toBe('not-sent');
    expect(result.pending).toBeUndefined();
    expect(provision).not.toHaveBeenCalled();
    if (kind === 'restore') expect(await fs.readFile(join(f.root, 'missing'), 'utf8')).toBe('1');
    expect(await f.starts()).toBe(1);
  }
);
it('refuses a full source-host cache before creating the missing remote target', async () => {
  const f = await fixture(),
    provision = vi.spyOn(f.options.provisionTransport, 'run');
  const material = CodexInputBroker.provisioningMaterial(
    f.scope.sessionId,
    'another pending controlled launch',
    f.home
  );
  const extra = await f.cache.prepare(f.scope, material, join(f.broker.directory, '..', material.config.incarnation));
  expect(extra).toBeDefined();
  const result = await f.rotate('restore');
  expect(result.result).toBe('not-sent');
  expect(provision).not.toHaveBeenCalled();
  expect(await fs.readFile(join(f.root, 'missing'), 'utf8')).toBe('1');
  expect(await f.starts()).toBe(1);
});
it('rechecks owner authority after retaining source material before any remote creation', async () => {
  const f = await fixture(),
    prepare = f.cache.prepare.bind(f.cache),
    provision = vi.spyOn(f.options.provisionTransport, 'run');
  let current = true;
  vi.spyOn(f.cache, 'prepare').mockImplementation(async (...args) => {
    const descriptor = await prepare(...args);
    current = false;
    return descriptor;
  });
  const result = await f.rotate('restore', (authority) => {
    authority.isCurrent = () => current;
  });
  expect(result.result).toBe('not-sent');
  expect(result.pending).toBeUndefined();
  expect(provision).not.toHaveBeenCalled();
  expect(await fs.readFile(join(f.root, 'missing'), 'utf8')).toBe('1');
});
it('reserves the exact new incarnation before a missing remote pane can be created', async () => {
  const f = await fixture(),
    provision = vi.spyOn(f.options.provisionTransport, 'run');
  const result = await f.rotate('restore', (authority) => {
    Object.assign(authority, { reserveInputBroker: async () => false });
  });
  expect(result.result).toBe('unknown');
  expect(provision).not.toHaveBeenCalled();
  expect(await fs.readFile(join(f.root, 'missing'), 'utf8')).toBe('1');
  expect(await f.starts()).toBe(1);
});
it('creates and commits a healthy missing worker only after its material and reservation are retained', async () => {
  const f = await fixture(),
    prepare = vi.spyOn(f.cache, 'prepare'),
    provision = vi.spyOn(f.options.provisionTransport, 'run');
  const result = await f.rotate('restore');
  expect(result.result).toBe('sent');
  expect(result.pending).toBe(result.promoted);
  expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(provision.mock.invocationCallOrder[0]);
  expect(await f.starts()).toBe(2);
});
