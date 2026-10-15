/** Actual Session and broker parser, temporary grants, fake SSH/native effects only. */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { CodexInputBroker, type CodexBrokerState, type CodexBrokerProof } from '../src/recovery/codex-input-broker.js';
import * as observation from '../src/recovery/remote-broker-launch.js';
import { dataPath } from '../src/config/instance.js';
import { invalidateUsersCache } from '../src/user-store.js';
import type { TerminalMultiplexer, MuxSession } from '../src/mux-interface.js';
import type { SessionRemote } from '../src/types.js';

let root: string;
let previousData: string | undefined, previousMultiuser: string | undefined;
const sessions: Session[] = [];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function grant(enabled = true) {
  await fs.writeFile(
    dataPath('users.json'),
    JSON.stringify({ version: 1, users: [{ username: 'owner', role: 'user', canBypassPermissions: enabled }] })
  );
}
beforeEach(async () => {
  previousData = process.env.CODEMAN_DATA_DIR;
  previousMultiuser = process.env.CODEMAN_MULTIUSER;
  root = await fs.mkdtemp(join(homedir(), 'wake-session-'));
  process.env.CODEMAN_DATA_DIR = root;
  process.env.CODEMAN_MULTIUSER = '1';
  invalidateUsersCache();
  await grant();
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const session of sessions.splice(0)) await session.stop(false);
  if (previousData === undefined) delete process.env.CODEMAN_DATA_DIR;
  else process.env.CODEMAN_DATA_DIR = previousData;
  if (previousMultiuser === undefined) delete process.env.CODEMAN_MULTIUSER;
  else process.env.CODEMAN_MULTIUSER = previousMultiuser;
  invalidateUsersCache();
  await fs.rm(root, { recursive: true, force: true });
});
function fixture(mode: 'codex' | 'claude' = 'codex', owned = true, guarded = true) {
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    home = '/fixture/codex-home';
  const remote: SessionRemote = {
    hostId: 'fixture',
    label: 'Fixture',
    host: 'worker.invalid',
    username: 'fixture',
    remotePath: '/fixture/work',
    owned,
  };
  const material = CodexInputBroker.provisioningMaterial(id, 'exec fixture-owned-worker', home);
  const descriptor = {
    directory: '/fixture/private/' + id + '/' + material.config.incarnation,
    incarnation: material.config.incarnation,
    launchDigest: material.config.launchDigest,
    homeDigest: material.config.homeDigest,
    helperDigest: hash(material.helper),
    keyDigest: hash(material.config.secret),
    startupNonce: material.config.startup.nonce,
  };
  const state: CodexBrokerState = {
    version: 1,
    sessionId: id,
    incarnation: descriptor.incarnation,
    pid: 700,
    childPid: 701,
    brokerStart: '900',
    childStart: '901',
    tainted: false,
    rawGeneration: 0,
    launchDigest: descriptor.launchDigest,
    homeDigest: descriptor.homeDigest,
    closed: false,
    exitStatus: null,
    exitSignal: null,
    counters: { 'owner-pty': 0, 'owner-key': 0, 'owner-mux': 0, auto: 0, probe: 0 },
    receipts: [],
    startup: { nonce: descriptor.startupNonce, status: 'started' },
  };
  const signer = CodexInputBroker.fromRemoteMaterial(descriptor.directory, material, state)!;
  let proof: CodexBrokerProof | undefined;
  const record = {
    sessionId: id,
    muxName: 'codeman-aaaaaaaa',
    mode,
    owner: 'owner',
    workingDir: root,
    remote,
    ...(guarded ? { recoveryInputBroker: descriptor.incarnation } : {}),
    recoveryCodexHome: home,
  } as MuxSession;
  const mux = {
    isAvailable: () => true,
    getSession: vi.fn(() => record),
    muxSessionExists: vi.fn(() => true),
    respawnPane: vi.fn(async () => 99999),
    setAttached: vi.fn(),
    getOwnedRemoteInputBroker: vi.fn(async () => descriptor),
    observeOwnedRemoteInputBroker: vi.fn(
      (_id, text, witness, pid) => (proof = signer.observeRemote(text, witness, pid))
    ),
    isOwnedRemoteInputBrokerProofCurrent: vi.fn(
      (_id, current) => proof === current && signer.authority(current)?.proof === current
    ),
  } as unknown as TerminalMultiplexer;
  const session = new Session({
    id,
    owner: 'owner',
    workingDir: root,
    mode,
    remote,
    mux,
    muxSession: record,
    useMux: true,
    codexConfig: { noDaemon: true, sandbox: 'danger-full-access', approvalPolicy: 'never' },
    envOverrides: { CODEX_HOME: home },
  });
  sessions.push(session);
  const wire = () => {
    const serialized = JSON.stringify(state);
    return {
      status: 'observed' as const,
      serialized,
      panePid: state.pid,
      witness: {
        path: descriptor.directory + '/state.json',
        dev: 1,
        ino: 2,
        size: Buffer.byteLength(serialized),
        mtimeMs: 1,
        ctimeMs: 1,
        hash: hash(serialized),
        maxBytes: 98304,
      },
    };
  };
  const observe = vi
    .spyOn(observation, 'observeOwnedRemoteBroker')
    .mockImplementation(async (_remote, request, authority) => {
      expect(request).toEqual({ sessionId: id, descriptor, inspect: true });
      return (await authority.prepare()) && authority.isCurrent() ? wire() : { status: 'not-sent' };
    });
  return { session, remote, mux, record, descriptor, state, wire, observe };
}
function unguardedFixture(kind: 'legacy' | 'unsupported-broker') {
  const f = fixture('codex', true, false);
  if (kind === 'legacy') {
    delete f.record.recoveryCodexHome;
    Reflect.set(f.session, '_codexConfig', { sandbox: 'danger-full-access', approvalPolicy: 'never' });
    Reflect.set(f.session, '_envOverrides', undefined);
  }
  return f;
}

it.each(['legacy', 'unsupported-broker'] as const)(
  'reattaches an unguarded %s worker with current grants and no broker recovery authority',
  async (kind) => {
    const f = unguardedFixture(kind);
    expect(await f.session.reattachRemote()).toBe(true);
    expect(f.session.remoteWakeInputScope()).toBeUndefined();
    expect(f.mux.respawnPane).toHaveBeenCalledOnce();
    expect(f.mux.getOwnedRemoteInputBroker).not.toHaveBeenCalled();
    expect(f.observe).not.toHaveBeenCalled();
    expect(f.mux.observeOwnedRemoteInputBroker).not.toHaveBeenCalled();
    expect(await f.session.getOwnedRemoteInputBroker()).toBeUndefined();
    expect(f.observe).not.toHaveBeenCalled();
  }
);

it.each(['grant', 'owner', 'config', 'record', 'closing', 'pending', 'malformed'] as const)(
  'refuses unguarded reconnect after %s changes without losing guarded checks',
  async (kind) => {
    const f = unguardedFixture('unsupported-broker');
    if (kind === 'grant') await grant(false);
    if (kind === 'owner') f.session.owner = 'other';
    if (kind === 'config') Reflect.set(f.session, '_codexConfig', { sandbox: 'workspace-write', noDaemon: false });
    if (kind === 'record') vi.mocked(f.mux.getSession).mockReturnValue({ ...f.record });
    if (kind === 'closing') f.session.markClosing(true);
    if (kind === 'pending') f.record.recoveryInputBrokerPending = '11111111-2222-3333-4444-555555555555';
    if (kind === 'malformed') f.record.recoveryInputBroker = 'malformed';
    // A changed configuration alone is valid owner transport intent; changing it
    // after admission must invalidate the exact captured token instead.
    if (kind === 'config') {
      expect(await f.session.confirmRemoteWakeReady()).toBe(true);
      Reflect.set(f.session, '_codexConfig', { sandbox: 'read-only' });
      expect(f.session.isRemoteWakeReadyCurrent()).toBe(false);
    } else {
      expect(await f.session.reattachRemote()).toBe(false);
      expect(f.mux.respawnPane).not.toHaveBeenCalled();
    }
  }
);

it('does not reuse unguarded transport authority after a controlled incarnation is registered', async () => {
  const f = unguardedFixture('unsupported-broker');
  expect(await f.session.confirmRemoteWakeReady()).toBe(true);
  expect(f.session.isRemoteWakeReadyCurrent()).toBe(true);
  f.record.recoveryInputBroker = f.descriptor.incarnation;
  expect(f.session.isRemoteWakeReadyCurrent()).toBe(false);
  expect(f.session.remoteWakeInputScope()?.incarnation).toBe(f.descriptor.incarnation);
});

it('refuses lost broker metadata on a known controlled native record instead of downgrading to legacy transport', async () => {
  const f = fixture();
  delete f.record.recoveryInputBroker;
  expect(await f.session.reattachRemote()).toBe(false);
  expect(f.mux.respawnPane).not.toHaveBeenCalled();
  expect(f.session.remoteWakeInputScope()).toBeDefined();
});

it('accepts a fresh exact live worker before any conversation UUID is known', async () => {
  const f = fixture();
  expect(f.session.codexConfig?.resumeSessionId).toBeUndefined();
  expect(f.session.isRemoteWakeReadyCurrent()).toBe(false);
  expect(await f.session.confirmRemoteWakeReady()).toBe(true);
  expect(f.session.isRemoteWakeReadyCurrent()).toBe(true);
  expect(f.mux.observeOwnedRemoteInputBroker).toHaveBeenCalledOnce();
  expect(f.mux.respawnPane).not.toHaveBeenCalled();
});
it('accepts the exact recorded remote home when no CODEX_HOME override was configured', async () => {
  const f = fixture();
  Reflect.set(f.session, '_envOverrides', { OTHER_FIXTURE: 'unchanged' });
  expect(await f.session.confirmRemoteWakeReady()).toBe(true);
  expect(f.session.isRemoteWakeReadyCurrent()).toBe(true);
});
it('keeps a known logical conversation/home target across an authorized broker rotation', () => {
  const f = fixture();
  const cid = '11111111-2222-3333-4444-555555555555';
  Reflect.set(f.session, '_codexConfig', { ...f.session.codexConfig, resumeSessionId: cid });
  Reflect.set(f.session, '_envOverrides', { OTHER_FIXTURE: 'unchanged' });
  const before = f.session.remoteWakeInputScope()!;
  Reflect.set(f.session, '_envOverrides', { CODEX_HOME: '/fixture/codex-home', OTHER_FIXTURE: 'unchanged' });
  Reflect.set(f.session, '_recoveryCodexHome', '/fixture/codex-home');
  f.record.recoveryInputBroker = '22222222-3333-4444-5555-666666666666';
  const after = f.session.remoteWakeInputScope()!;
  expect(after.configuration).toBe(before.configuration);
  expect(after.conversationId).toBe(cid);
  expect(after.incarnation).not.toBe(before.incarnation);
  expect(after.configuration).toMatch(/^[a-f0-9]{64}$/);
});
it.each(['home', 'model', 'permission', 'env', 'workspace', 'mode'] as const)(
  'changes the queued input destination when %s changes between failed wakes',
  (kind) => {
    const f = fixture(),
      before = f.session.remoteWakeInputScope()!;
    if (kind === 'home') {
      f.record.recoveryCodexHome = '/fixture/new-home';
      Reflect.set(f.session, '_envOverrides', { CODEX_HOME: '/fixture/new-home' });
    }
    if (kind === 'model') Reflect.set(f.session, '_codexConfig', { ...f.session.codexConfig, model: 'changed-model' });
    if (kind === 'permission')
      Reflect.set(f.session, '_codexConfig', { ...f.session.codexConfig, approvalPolicy: 'on-request' });
    if (kind === 'env')
      Reflect.set(f.session, '_envOverrides', { CODEX_HOME: '/fixture/codex-home', EXTRA_FIXTURE: 'changed' });
    if (kind === 'workspace') Reflect.set(f.session, 'workingDir', '/fixture/other-work');
    if (kind === 'mode') Reflect.set(f.session, 'mode', 'claude');
    const after = f.session.remoteWakeInputScope();
    if (kind === 'mode') expect(after).toBeUndefined();
    else expect(after!.configuration).not.toBe(before.configuration);
  }
);
it('separates a changed known conversation from otherwise identical launch settings', () => {
  const f = fixture();
  Reflect.set(f.session, '_codexConfig', {
    ...f.session.codexConfig,
    resumeSessionId: '11111111-2222-3333-4444-555555555555',
  });
  const before = f.session.remoteWakeInputScope()!;
  Reflect.set(f.session, '_codexConfig', {
    ...f.session.codexConfig,
    resumeSessionId: '22222222-3333-4444-5555-666666666666',
  });
  const after = f.session.remoteWakeInputScope()!;
  expect(after.configuration).toBe(before.configuration);
  expect(after.conversationId).not.toBe(before.conversationId);
});
it.each([undefined, '', 'not-an-exact-conversation'] as const)(
  'keeps an unknown/malformed identity %s bound to its original incarnation',
  (id) => {
    const f = fixture();
    Reflect.set(f.session, '_codexConfig', { ...f.session.codexConfig, resumeSessionId: id });
    const before = f.session.remoteWakeInputScope()!;
    expect(before.conversationId).toBeUndefined();
    Reflect.set(f.session, '_codexConfig', {
      ...f.session.codexConfig,
      resumeSessionId: '11111111-2222-3333-4444-555555555555',
    });
    const verified = f.session.remoteWakeInputScope()!;
    expect(verified.configuration).toBe(before.configuration);
    expect(verified.incarnation).toBe(before.incarnation);
    f.record.recoveryInputBroker = '22222222-3333-4444-5555-666666666666';
    expect(f.session.remoteWakeInputScope()!.incarnation).not.toBe(before.incarnation);
  }
);
it.each(['explicit-home', 'recovery-home', 'descriptor-home'] as const)(
  'refuses a mismatched %s before SSH',
  async (kind) => {
    const f = fixture();
    if (kind === 'explicit-home') Reflect.set(f.session, '_envOverrides', { CODEX_HOME: '/fixture/other-home' });
    if (kind === 'recovery-home') Reflect.set(f.session, '_recoveryCodexHome', '/fixture/other-home');
    if (kind === 'descriptor-home') f.descriptor.homeDigest = 'a'.repeat(64);
    expect(await f.session.confirmRemoteWakeReady()).toBe(false);
    expect(f.observe).not.toHaveBeenCalled();
  }
);
it('retains one outstanding remote read after timeout and rejects a late readiness token', async () => {
  const f = fixture();
  let release!: () => void, reached!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  f.observe.mockImplementation(async () => {
    reached();
    await held;
    return f.wire();
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
  const work = f.session.confirmRemoteWakeReady();
  await entered;
  await vi.advanceTimersByTimeAsync(2001);
  expect(await work).toBe(false);
  expect(await f.session.confirmRemoteWakeReady()).toBe(false);
  expect(f.observe).toHaveBeenCalledOnce();
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(f.session.isRemoteWakeReadyCurrent()).toBe(false);
  vi.useRealTimers();
  expect(await f.session.confirmRemoteWakeReady()).toBe(true);
});
it('keeps stable wake scope across owner-input generation but changes it with config, incarnation or home', () => {
  const f = fixture(),
    scope = f.session.remoteWakeScope();
  Reflect.set(f.session, '_recoveryGeneration', 1);
  expect(f.session.remoteWakeScope()).toBe(scope);
  f.record.recoveryInputBroker = '11111111-2222-3333-4444-555555555555';
  expect(f.session.remoteWakeScope()).not.toBe(scope);
  f.record.recoveryInputBroker = f.descriptor.incarnation;
  Reflect.set(f.session, '_recoveryCodexHome', '/fixture/other-home');
  expect(f.session.remoteWakeScope()).not.toBe(scope);
  expect(scope).toMatch(/^[a-f0-9]{64}$/);
});
it.each(['missing', 'unknown', 'closed', 'malformed', 'wrong-pid', 'pending'] as const)(
  'refuses %s worker evidence without local attach effects',
  async (kind) => {
    const f = fixture();
    if (kind === 'missing') vi.mocked(f.mux.getOwnedRemoteInputBroker!).mockResolvedValue(undefined);
    if (kind === 'unknown') f.observe.mockResolvedValue({ status: 'unknown' });
    if (kind === 'closed') {
      f.state.closed = true;
      f.state.exitStatus = 1;
    }
    if (kind === 'malformed') f.observe.mockResolvedValue({ ...f.wire(), serialized: '{}' });
    if (kind === 'wrong-pid') f.observe.mockResolvedValue({ ...f.wire(), panePid: 702 });
    if (kind === 'pending') f.record.recoveryInputBrokerPending = '11111111-2222-3333-4444-555555555555';
    expect(await f.session.confirmRemoteWakeReady()).toBe(false);
    expect(f.session.isRemoteWakeReadyCurrent()).toBe(false);
    expect(await f.session.reattachRemote()).toBe(false);
    expect(f.mux.respawnPane).not.toHaveBeenCalled();
  }
);
it.each([
  'grant',
  'owner',
  'config',
  'env',
  'generation',
  'epoch',
  'remote',
  'record',
  'closing',
  'clock',
  'expired',
] as const)('rejects %s changes during the remote read before publishing readiness', async (kind) => {
  const f = fixture();
  const now = performance.now();
  f.observe.mockImplementation(async () => {
    if (kind === 'grant') await grant(false);
    if (kind === 'owner') f.session.owner = 'other';
    if (kind === 'config') Reflect.set(f.session, '_codexConfig', { noDaemon: true, model: 'changed' });
    if (kind === 'env') Reflect.set(f.session, '_envOverrides', { CODEX_HOME: '/fixture/changed' });
    if (kind === 'generation') Reflect.set(f.session, '_recoveryGeneration', 1);
    if (kind === 'epoch') Reflect.set(f.session, '_paneStartedAt', 1);
    if (kind === 'remote') f.remote.host = 'changed.invalid';
    if (kind === 'record') vi.mocked(f.mux.getSession).mockReturnValue({ ...f.record });
    if (kind === 'closing') f.session.markClosing(true);
    if (kind === 'clock') vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 1000);
    if (kind === 'expired') vi.spyOn(performance, 'now').mockReturnValue(now + 2100);
    return f.wire();
  });
  expect(await f.session.confirmRemoteWakeReady()).toBe(false);
  expect(f.session.isRemoteWakeReadyCurrent()).toBe(false);
  expect(f.mux.respawnPane).not.toHaveBeenCalled();
});
it.each(['owner', 'generation', 'epoch', 'pending', 'owned', 'expired'] as const)(
  'pure readiness retains its exact scope after %s changes',
  async (kind) => {
    const f = fixture();
    expect(await f.session.confirmRemoteWakeReady()).toBe(true);
    const now = performance.now();
    if (kind === 'owner') f.session.owner = 'other';
    if (kind === 'generation') Reflect.set(f.session, '_recoveryGeneration', 1);
    if (kind === 'epoch') Reflect.set(f.session, '_paneStartedAt', 1);
    if (kind === 'pending') f.record.recoveryInputBrokerPending = '11111111-2222-3333-4444-555555555555';
    if (kind === 'owned') f.remote.owned = false;
    if (kind === 'expired') vi.spyOn(performance, 'now').mockReturnValue(now + 2100);
    expect(f.session.isRemoteWakeReadyCurrent()).toBe(false);
  }
);
it.each(['_discoveredMuxSession', '_respawnBlocked', '_recoverySwitchPending', '_recoveryUntrackedInput'] as const)(
  'preserves existing owner/lifecycle veto %s during proof and after a healthy proof',
  async (field) => {
    const f = fixture();
    expect(await f.session.confirmRemoteWakeReady()).toBe(true);
    Reflect.set(f.session, field, true);
    expect(f.session.isRemoteWakeReadyCurrent()).toBe(false);
    Reflect.set(f.session, field, false);
    f.observe.mockImplementation(async () => {
      Reflect.set(f.session, field, true);
      return f.wire();
    });
    expect(await f.session.confirmRemoteWakeReady()).toBe(false);
    expect(f.session.isRemoteWakeReadyCurrent()).toBe(false);
    expect(f.mux.respawnPane).not.toHaveBeenCalled();
  }
);
it('rechecks the live worker after attach dispatch before reporting reattach success', async () => {
  const f = fixture();
  vi.mocked(f.mux.respawnPane).mockImplementation(async () => {
    f.state.closed = true;
    f.state.exitStatus = 1;
    return 99999;
  });
  expect(await f.session.reattachRemote()).toBe(false);
  expect(f.mux.respawnPane).toHaveBeenCalledOnce();
  expect(f.observe).toHaveBeenCalledTimes(2);
});
it.each(['owner', 'config', 'generation', 'record'] as const)(
  'does not adopt a changed %s after attach dispatch',
  async (kind) => {
    const f = fixture();
    vi.mocked(f.mux.respawnPane).mockImplementation(async () => {
      if (kind === 'owner') {
        f.session.owner = 'other';
        f.record.owner = 'other';
      }
      if (kind === 'config') Reflect.set(f.session, '_codexConfig', { noDaemon: true });
      if (kind === 'generation') Reflect.set(f.session, '_recoveryGeneration', 1);
      if (kind === 'record') Reflect.set(f.session, '_muxSession', { ...f.record });
      return 99999;
    });
    expect(await f.session.reattachRemote()).toBe(false);
    expect(f.mux.respawnPane).toHaveBeenCalledOnce();
  }
);
it('allows a healthy attach then requires a fresh token for the new local lifecycle epoch', async () => {
  const f = fixture();
  expect(await f.session.reattachRemote()).toBe(true);
  expect(f.session.isRemoteWakeReadyCurrent()).toBe(false);
  expect(await f.session.confirmRemoteWakeReady()).toBe(true);
  expect(f.session.isRemoteWakeReadyCurrent()).toBe(true);
});
it.each([
  ['claude', true],
  ['codex', false],
] as const)('preserves %s owned=%s transport semantics', async (mode, owned) => {
  const f = fixture(mode, owned);
  expect(f.session.remoteWakeInputScope()).toBeUndefined();
  expect(await f.session.confirmRemoteWakeReady()).toBe(true);
  expect(f.session.isRemoteWakeReadyCurrent()).toBe(true);
  expect(f.observe).not.toHaveBeenCalled();
});
