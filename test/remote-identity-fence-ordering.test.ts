/** Actual Session boundaries; disposable identity files and fake broker, SSH, mux, and PTY effects. */
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { rebootIdentityFencePath } from '../src/recovery/reboot-identity-fence.js';
import * as remoteClock from '../src/recovery/remote-clock.js';
import * as remoteBroker from '../src/recovery/remote-broker-launch.js';
import type { CodexBrokerProof } from '../src/recovery/codex-input-broker.js';
import type { MuxSession, TerminalMultiplexer } from '../src/mux-interface.js';

const io = vi.hoisted(() => ({
  target: '',
  failRead: false,
  events: [] as string[],
  read: undefined as { entered(): void; wait: Promise<void> } | undefined,
  pending: undefined as { entered(): void; wait: Promise<void> } | undefined,
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const refused = () => {
    throw Error('Native/SSH effects forbidden in identity ordering tests');
  };
  return {
    ...actual,
    exec: refused,
    execSync: refused,
    execFile: refused,
    execFileSync: refused,
    spawn: refused,
    spawnSync: refused,
    fork: refused,
  };
});
vi.mock('node-pty', () => ({
  spawn: () => {
    throw Error('Real PTY effects forbidden');
  },
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  const { constants } = await import('node:fs');
  const open = async (...args: Parameters<typeof actual.open>) => {
    const path = String(args[0]);
    const reading = path === io.target && typeof args[1] === 'number';
    if (reading && io.failRead) throw Object.assign(Error('Unknown initial identity evidence'), { code: 'EACCES' });
    const file = await actual.open(...args);
    if (reading && io.read) {
      const gate = io.read;
      io.read = undefined;
      io.events.push('initial-read');
      gate.entered();
      await gate.wait;
      io.events.push('initial-read-ack');
    }
    const exclusive = args[1] === 'wx' || (typeof args[1] === 'number' && (args[1] & constants.O_EXCL) !== 0);
    const temporary = path.startsWith(io.target + '.') && exclusive;
    return new Proxy(file, {
      get(target, key) {
        if (key === 'sync')
          return async () => {
            if (temporary && io.pending) {
              const value = JSON.parse(await actual.readFile(path, 'utf8'));
              if (value.switchPending === true) {
                const gate = io.pending;
                io.pending = undefined;
                io.events.push('pending-sync');
                gate.entered();
                await gate.wait;
                await target.sync();
                io.events.push('pending-sync-ack');
                return;
              }
            }
            return target.sync();
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  return { ...actual, open, default: { ...actual, open } };
});

type Method = 'writeAsync' | 'writeViaMux' | 'sendNamedKey';
const methods: Method[] = ['writeAsync', 'writeViaMux', 'sendNamedKey'];
const raw = 'Remote owner café\r';
let root: string;
const sessions: Session[] = [];
const releases: Array<() => void> = [];
beforeEach(async () => {
  root = await fs.mkdtemp(join(homedir(), 'remote-identity-order-'));
  vi.stubEnv('CODEMAN_DATA_DIR', root);
  vi.stubEnv('CODEMAN_MULTIUSER', '');
  Object.assign(io, { target: '', failRead: false, events: [], read: undefined, pending: undefined });
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  io.read = io.pending = undefined;
  io.failRead = false;
  for (const session of sessions.splice(0)) {
    Reflect.set(session, 'ptyProcess', null);
    Reflect.set(session, '_mux', null);
    Reflect.set(session, '_muxSession', null);
    await session.stop(false);
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});
function gate(which?: 'read' | 'pending') {
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  if (which) io[which] = { entered, wait };
  return { entered, reached, release, wait };
}
async function beforeFinish(barrier: Promise<void>, operation: Promise<unknown>) {
  await Promise.race([
    barrier,
    operation.then(() => {
      throw Error('Operation finished before required stage');
    }),
  ]);
}
async function fixture(identity: { switchPending: boolean; untrackedInput?: boolean } = { switchPending: false }) {
  const id = randomUUID(),
    home = '/fixture/remote-codex-home';
  const remote = {
    hostId: 'fixture',
    label: 'Fixture',
    host: 'worker.invalid',
    username: 'fixture',
    remotePath: '/fixture/work',
    owned: true,
  };
  const record = {
    sessionId: id,
    muxName: 'codeman-' + id.slice(0, 8),
    mode: 'codex',
    workingDir: root,
    remote,
    recoveryIsolated: true,
    recoveryCodexHome: home,
    recoveryInputBroker: randomUUID(),
    attached: true,
  } as MuxSession;
  const effects: string[] = [];
  const effect = vi.fn((data: string) => {
    expect(JSON.parse(readFileSync(io.target, 'utf8'))).toMatchObject({ switchPending: true });
    io.events.push('effect');
    effects.push(data);
  });
  const mux = {
    isAvailable: () => true,
    getSession: () => record,
    setAttached: vi.fn(),
    wrapCodexOwnerInput: vi.fn(() => ({ status: 'passthrough' as const })),
    canDeliverCodexOwnerInput: vi.fn(() => true),
    sendInput: vi.fn(async (_id: string, data: string) => {
      effect(data);
      return true;
    }),
  };
  const session = new Session({
    id,
    workingDir: root,
    mode: 'codex',
    useMux: true,
    mux: mux as unknown as TerminalMultiplexer,
    muxSession: record,
    remote,
    codexConfig: { noDaemon: true, sandbox: 'workspace-write', approvalPolicy: 'on-request' },
    envOverrides: { CODEX_HOME: home },
  });
  sessions.push(session);
  Reflect.set(session, 'ptyProcess', { write: effect });
  io.target = rebootIdentityFencePath(id);
  await fs.mkdir(join(root, 'reboot-identities'), { recursive: true });
  await fs.writeFile(io.target, JSON.stringify({ version: 1, ...identity }), { mode: 0o600 });
  // The broker protocol is already covered separately. These explicit fake
  // receipts keep this suite on Session initialization/order and forbid SSH.
  const descriptor = {
    directory: '/fixture/private/' + id,
    incarnation: record.recoveryInputBroker!,
    launchDigest: 'a'.repeat(64),
    homeDigest: createHash('sha256').update(home).digest('hex'),
    helperDigest: 'b'.repeat(64),
    keyDigest: 'c'.repeat(64),
    startupNonce: 'd'.repeat(64),
  };
  const proof = { closed: false, incarnation: descriptor.incarnation, brokerPid: 700 } as CodexBrokerProof;
  const brokerQuery = vi.spyOn(session, 'getOwnedRemoteInputBroker').mockResolvedValue(descriptor);
  vi.spyOn(session, 'observeOwnedRemoteInputBroker').mockReturnValue(proof);
  vi.spyOn(session, 'isOwnedRemoteInputBrokerProofCurrent').mockImplementation((value) => value === proof);
  const observe = vi
    .spyOn(remoteBroker, 'observeOwnedRemoteBroker')
    .mockImplementation(async (_remote, _request, authority) =>
      (await authority.prepare()) && authority.isCurrent()
        ? {
            status: 'observed',
            serialized: '{}',
            panePid: 700,
            witness: {
              path: '/fixture/state',
              dev: 1,
              ino: 2,
              size: 2,
              mtimeMs: 1,
              ctimeMs: 1,
              hash: createHash('sha256').update('{}').digest('hex'),
              maxBytes: 98304,
            },
          }
        : { status: 'not-sent' }
    );
  const sampling = vi.spyOn(remoteClock, 'sampleRemoteCodexClock').mockImplementation(async () => {
    throw Error('Unexpected clock sample');
  });
  const send = (method: Method) =>
    method === 'sendNamedKey'
      ? session.sendNamedKey(raw, async () => {
          effect(raw);
        })
      : session[method](raw, { fromUser: true });
  return { session, record, effects, effect, mux, send, sampling, brokerQuery, observe };
}

it.each(methods)(
  '%s waits for initialization and durable pending ACK before one clock and one effect',
  async (method) => {
    const f = await fixture(),
      reading = gate('read'),
      pending = gate('pending'),
      clock = gate();
    f.sampling.mockImplementation(async () => {
      io.events.push('clock');
      expect(JSON.parse(readFileSync(io.target, 'utf8'))).toMatchObject({ switchPending: true });
      const before = Date.now();
      clock.entered();
      await clock.wait;
      const after = Date.now();
      return { localBefore: before, localAfter: after, remoteBefore: before + 5000, remoteAfter: after + 5000 };
    });
    expect(f.session.getRecoveryContext().managed).toBe(false);
    const sending = f.send(method);
    await beforeFinish(reading.reached, sending);
    expect(f.sampling).not.toHaveBeenCalled();
    expect(f.effect).not.toHaveBeenCalled();
    reading.release();
    await beforeFinish(pending.reached, sending);
    expect(f.sampling).not.toHaveBeenCalled();
    expect(f.effect).not.toHaveBeenCalled();
    pending.release();
    await beforeFinish(clock.reached, sending);
    expect(f.sampling).toHaveBeenCalledOnce();
    expect(f.effect).not.toHaveBeenCalled();
    clock.release();
    expect(await sending).toBe(true);
    expect(f.effects).toEqual([raw]);
    expect(f.sampling).toHaveBeenCalledOnce();
    expect(io.events).toEqual([
      'initial-read',
      'initial-read-ack',
      'pending-sync',
      'pending-sync-ack',
      'clock',
      'effect',
    ]);
    const context = f.session.getRecoveryContext();
    expect(context.submission).toMatchObject({ clockDomain: 'local', clock: { remoteBefore: expect.any(Number) } });
    expect(context.submission!.at).toBeGreaterThanOrEqual(context.submission!.clock!.localAfter);
    expect(context.switchPending).toBe(false);
  }
);
it.each(methods)('%s refuses an owner change while the durable pending ACK is held', async (method) => {
  const f = await fixture(),
    pending = gate('pending');
  const sending = f.send(method),
    rejected = expect(sending).rejects.toThrow();
  await beforeFinish(pending.reached, sending);
  f.session.owner = 'replacement-owner';
  pending.release();
  await rejected;
  expect(f.sampling).not.toHaveBeenCalled();
  expect(f.effect).not.toHaveBeenCalled();
  expect(f.session.getRecoveryContext()).toMatchObject({ switchPending: true, submission: undefined });
});
it('controlled wake waits for its initial private read before querying the broker', async () => {
  const f = await fixture(),
    reading = gate('read');
  const ready = f.session.confirmRemoteWakeReady();
  await beforeFinish(reading.reached, ready);
  expect(f.brokerQuery).not.toHaveBeenCalled();
  expect(f.observe).not.toHaveBeenCalled();
  expect(f.session.isRemoteWakeReadyCurrent()).toBe(false);
  reading.release();
  expect(await ready).toBe(true);
  expect(f.brokerQuery).toHaveBeenCalledOnce();
  expect(f.observe).toHaveBeenCalledOnce();
  expect(f.session.isRemoteWakeReadyCurrent()).toBe(true);
});
it('persisted untracked input denies controlled wake after the actual initial read', async () => {
  const f = await fixture({ switchPending: true, untrackedInput: true }),
    reading = gate('read');
  const ready = f.session.confirmRemoteWakeReady();
  await beforeFinish(reading.reached, ready);
  expect(f.brokerQuery).not.toHaveBeenCalled();
  reading.release();
  expect(await ready).toBe(false);
  expect(f.session.getRecoveryContext().untrackedInput).toBe(true);
  expect(f.brokerQuery).not.toHaveBeenCalled();
  expect(f.observe).not.toHaveBeenCalled();
  expect(f.effect).not.toHaveBeenCalled();
});
it('unknown initial evidence denies wake without permanent taint and permits a healthy retry', async () => {
  const f = await fixture();
  io.failRead = true;
  expect(await f.session.confirmRemoteWakeReady()).toBe(false);
  expect(f.brokerQuery).not.toHaveBeenCalled();
  expect(f.session.getRecoveryContext().untrackedInput).toBe(false);
  io.failRead = false;
  expect(await f.session.confirmRemoteWakeReady()).toBe(true);
  expect(f.brokerQuery).toHaveBeenCalledOnce();
  expect(f.observe).toHaveBeenCalledOnce();
});
