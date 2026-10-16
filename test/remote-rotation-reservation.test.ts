/** @fileoverview Actual generated fake-SSH/native reader and disposable workers only. No real SSH or pane. */
import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { CodexInputBroker } from '../src/recovery/codex-input-broker.js';
import { remoteBrokerReaderFixture } from './mocks/remote-broker-reader-fixture.js';
import { Session } from '../src/session.js';
import type { MuxSession, TerminalMultiplexer } from '../src/mux-interface.js';
const fixtures: Awaited<ReturnType<typeof remoteBrokerReaderFixture>>[] = [];
const sessions: Session[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const session of sessions.splice(0)) await session.stop(false);
  for (const fixture of fixtures.splice(0)) await fixture.close();
  vi.unstubAllEnvs();
});
async function fixture() {
  const f = await remoteBrokerReaderFixture();
  fixtures.push(f);
  return f;
}
it.each(
  (['restart', 'restore'] as const).flatMap((kind) =>
    (['healthy', 'grant-denied', 'cancelled-after-check', 'lookup-failed'] as const).map((change) => ({ kind, change }))
  )
)('refreshes the first real Session grant before remote $kind rotation: $change', async ({ kind, change }) => {
  vi.stubEnv('CODEMAN_MULTIUSER', '0');
  const f = await fixture();
  const conversationId = '11111111-2222-3333-4444-555555555555';
  const session = new Session({
    id: f.scope.sessionId,
    workingDir: f.scope.workingDir,
    mode: 'codex',
    remote: f.remote,
    useMux: true,
    mux: { isAvailable: () => true } as TerminalMultiplexer,
    muxSession: {
      muxName: 'codeman-aaaaaaaa',
      recoveryIsolated: true,
      recoveryCodexHome: f.home,
    } as MuxSession,
    codexConfig: { noDaemon: true, resumeSessionId: conversationId },
    envOverrides: { CODEX_HOME: f.home },
  });
  sessions.push(session);
  expect(await session.ensureRecoveryIdentityFence()).toBe(true);
  const config = session.remoteRecoveryConfiguration();
  let current = true;
  const pure = () => session.isRemoteRecoveryAuthorityCurrent(conversationId, 0, () => current, config);
  expect(session.getRecoveryContext()).toMatchObject({ managed: true, remoteOwned: true });
  expect(pure()).toBe(false);
  const prepare = vi.spyOn(f.cache, 'prepare');
  const provision = vi.spyOn(f.options.provisionTransport, 'run');
  const check = vi.fn(async () => {
    if (change === 'lookup-failed') throw Error('Fixture owner lookup failed');
    if (change === 'grant-denied') vi.stubEnv('CODEMAN_MULTIUSER', '1');
    const granted = await session.confirmRemoteRecoveryAuthority(conversationId, 0, () => current, config);
    if (change === 'cancelled-after-check') current = false;
    return granted;
  });
  const result = await f.rotate(kind, (authority) => {
    authority.check = check;
    authority.isCurrent = pure;
  });
  expect(check).toHaveBeenCalled();
  if (change === 'healthy') {
    expect(result.result).toBe('sent');
    expect(result.pending).toBe(result.promoted);
    expect(check.mock.invocationCallOrder[0]).toBeLessThan(prepare.mock.invocationCallOrder[0]);
    expect(check.mock.invocationCallOrder[0]).toBeLessThan(provision.mock.invocationCallOrder[0]);
    expect(await f.starts()).toBe(2);
  } else {
    expect(result.result).toBe('not-sent');
    expect(result.pending).toBeUndefined();
    expect(prepare).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
    expect(await f.starts()).toBe(1);
  }
});
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

it.each(
  (['restart', 'restore'] as const).flatMap((kind) =>
    (['regular', 'dotted', 'trailing'] as const).map((form) => ({ kind, form }))
  )
)(
  'keeps the initial broker home bound through Session recovery $kind with a $form owner home',
  async ({ kind, form }) => {
    vi.stubEnv('CODEMAN_MULTIUSER', '0');
    const f = await fixture(),
      conversationId = '11111111-2222-3333-4444-555555555555';
    const rawHome = form === 'dotted' ? f.home + '/temporary/../' : form === 'trailing' ? f.home + '/' : f.home;
    const session = new Session({
      id: f.scope.sessionId,
      workingDir: f.scope.workingDir,
      mode: 'codex',
      remote: f.remote,
      useMux: true,
      mux: { isAvailable: () => true } as TerminalMultiplexer,
      muxSession: { muxName: 'codeman-aaaaaaaa', recoveryIsolated: true, recoveryCodexHome: f.home } as MuxSession,
      codexConfig: { noDaemon: true, resumeSessionId: conversationId },
      envOverrides: { CODEX_HOME: rawHome },
    });
    sessions.push(session);
    expect(await session.ensureRecoveryIdentityFence()).toBe(true);
    const context = session.getRecoveryContext();
    expect(context).toMatchObject({ managed: true, remoteOwned: true, noDaemon: true });
    const configuration = session.remoteRecoveryConfiguration();
    const result = await f.rotate(
      kind,
      (authority) => {
        authority.check = () => session.confirmRemoteRecoveryAuthority(conversationId, 0, () => true, configuration);
        authority.isCurrent = () =>
          session.isRemoteRecoveryAuthorityCurrent(conversationId, 0, () => true, configuration);
      },
      undefined,
      context.codexHome
    );
    expect(result.result).toBe('sent');
    expect(context.codexHome).toBe(f.home);
    expect(result.pending).toBe(result.promoted);
    expect(await f.starts()).toBe(2);
    expect(session.getEnvOverridesForPersist()).toEqual({ CODEX_HOME: rawHome });
  }
);
