/** Private owned-SSH byte snapshots, without filesystem, SSH or process effects. */
import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { CodexInputBroker, type CodexBrokerState } from '../src/recovery/codex-input-broker.js';

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const hash = (data: string) => createHash('sha256').update(data).digest('hex');
function fixture() {
  const material = CodexInputBroker.provisioningMaterial(SID, 'exec fake-owned-cli', '/remote/home');
  const directory = '/private/remote/' + SID + '/' + material.config.incarnation;
  const state: CodexBrokerState = {
    version: 1,
    sessionId: SID,
    incarnation: material.config.incarnation,
    pid: 700,
    childPid: 701,
    brokerStart: '12345',
    childStart: '12346',
    tainted: false,
    rawGeneration: 0,
    launchDigest: material.config.launchDigest,
    homeDigest: material.config.homeDigest,
    closed: false,
    exitStatus: null,
    exitSignal: null,
    counters: { 'owner-pty': 0, 'owner-key': 0, 'owner-mux': 0, auto: 0, probe: 0 },
    receipts: [],
    startup: { nonce: material.config.startup.nonce, status: 'started' },
  };
  const broker = CodexInputBroker.fromRemoteMaterial(directory, material, state)!;
  const snapshot = () => {
    const serialized = JSON.stringify(state);
    return {
      serialized,
      witness: {
        path: directory + '/state.json',
        dev: 1,
        ino: 2,
        size: Buffer.byteLength(serialized),
        mtimeMs: 3,
        ctimeMs: 4,
        hash: hash(serialized),
        maxBytes: 98304,
      },
    };
  };
  const observe = () => {
    const sample = snapshot();
    return broker.observeRemote(sample.serialized, sample.witness, 700);
  };
  return { material, directory, state, broker, snapshot, observe };
}

it.each(['owner-pty', 'owner-key', 'owner-mux'] as const)(
  'a passive refresh cannot reset pending %s frames',
  (channel) => {
    const f = fixture();
    const first = f.observe()!;
    expect(f.broker.authority(first)).toBeDefined();
    const frame = f.broker.frame(channel, 'owner draft')!;
    expect(frame.receipt.counter).toBe(1);
    for (let repeat = 0; repeat < 3; repeat++) expect(f.observe()).toBeUndefined();
    expect(f.broker.authority(first)).toBeUndefined();
    f.state.counters[channel] = 1;
    f.state.receipts.push({ ...frame.receipt, status: 'sent' });
    expect(f.observe()).toBeDefined();
    expect(f.broker.frame(channel, 'next')?.receipt.counter).toBe(2);
  }
);

function receipt(channel: keyof CodexBrokerState['counters'], counter: number) {
  return {
    channel,
    counter,
    nonce: randomUUID(),
    conversationId: channel === 'auto' ? '11111111-2222-3333-4444-555555555555' : '',
    hash: hash('known delivered phase'),
    status: 'sent' as const,
  };
}

it('an observed owner counter ahead of the sole signer permanently vetoes catch-up', () => {
  const f = fixture();
  f.state.counters['owner-pty'] = 1;
  f.state.receipts = [receipt('owner-pty', 1)];
  expect(f.observe()).toBeUndefined();
  f.state.counters['owner-pty'] = 0;
  f.state.receipts = [];
  expect(f.observe()).toBeUndefined();
  expect(f.broker.frame('owner-pty', 'cannot silently rebind')).toBeUndefined();
});

it('advances only the remote auto/probe cursors and never rolls them backward', () => {
  const f = fixture();
  f.state.counters.auto = 4;
  f.state.counters.probe = 5;
  f.state.receipts = [receipt('auto', 4), receipt('probe', 5)];
  expect(f.observe()).toBeDefined();
  f.state.counters.auto = 1;
  f.state.counters.probe = 1;
  f.state.receipts = [receipt('auto', 1), receipt('probe', 1)];
  expect(f.observe()).toBeDefined();
  expect(f.broker.frame('probe', '')?.receipt.counter).toBe(6);
});

it.each([
  'hash',
  'path',
  'size',
  'max',
  'extra',
  'utf8',
  'session',
  'incarnation',
  'home',
  'launch',
  'pid',
  'birth',
  'reserved',
  'raw',
  'unknown-status',
] as const)('refuses uncertain remote byte/native scope %s', (change) => {
  const f = fixture();
  if (change === 'session') f.state.sessionId = randomUUID();
  if (change === 'incarnation') f.state.incarnation = randomUUID();
  if (change === 'home') f.state.homeDigest = hash('/other-home');
  if (change === 'launch') f.state.launchDigest = hash('other-cli');
  if (change === 'pid') f.state.pid++;
  if (change === 'birth') f.state.childStart = '0';
  if (change === 'raw') {
    f.state.rawGeneration = 1;
    f.state.tainted = true;
  }
  if (change === 'unknown-status') Object.assign(f.state.startup, { status: 'unknown' });
  if (change === 'reserved') {
    f.state.counters.auto = 1;
    f.state.receipts.push({
      channel: 'auto',
      counter: 1,
      nonce: randomUUID(),
      conversationId: randomUUID(),
      hash: hash('own partial'),
      status: 'reserved',
    });
  }
  const sample = f.snapshot();
  if (change === 'hash') sample.witness.hash = hash('other bytes');
  if (change === 'path') sample.witness.path = '/foreign/state.json';
  if (change === 'size') sample.witness.size++;
  if (change === 'max') sample.witness.maxBytes++;
  if (change === 'extra') Object.assign(sample.witness, { secret: 'must not accept arbitrary fields' });
  if (change === 'utf8') sample.serialized += '\ud800';
  expect(f.broker.observeRemote(sample.serialized, sample.witness, 700)).toBeUndefined();
});

it('keeps the exact certified child exit available while refusing new owner frames to the closed process', () => {
  const f = fixture();
  f.state.closed = true;
  f.state.exitStatus = 9;
  expect(f.observe()).toMatchObject({ closed: true, exitStatus: 9, brokerPid: 700, childPid: 701 });
  expect(f.broker.frame('owner-pty', 'dead child')).toBeUndefined();
});

it('an invalid byte witness cannot leave a previous cached readiness true', () => {
  const f = fixture();
  expect(f.observe()).toBeDefined();
  expect(f.broker.canFrame).toBe(true);
  const sample = f.snapshot();
  sample.witness.hash = hash('replaced state');
  expect(f.broker.observeRemote(sample.serialized, sample.witness, 700)).toBeUndefined();
  expect(f.broker.canFrame).toBe(false);
  expect(f.broker.frame('owner-pty', 'must not leave on stale readiness')).toBeUndefined();
  expect(f.observe()).toBeDefined();
  expect(f.broker.canFrame).toBe(true);
});

it.each(['owner-pty', 'owner-key', 'owner-mux', 'auto', 'probe'] as const)(
  'refuses incomplete %s receipt heads for live and closed snapshots',
  (channel) => {
    for (const closed of [false, true]) {
      const f = fixture();
      f.state.closed = closed;
      f.state.exitStatus = closed ? 1 : null;
      f.state.counters[channel] = 2;
      // A missing last receipt cannot turn a reservation into a certified refusal.
      for (const receipts of [[], [receipt(channel, 1)]]) {
        f.state.receipts = receipts;
        expect(CodexInputBroker.fromRemoteMaterial(f.directory, f.material, f.state)).toBeUndefined();
        expect(f.observe()).toBeUndefined();
      }
      f.state.receipts = [receipt(channel, 2)];
      const signer = CodexInputBroker.fromRemoteMaterial(f.directory, f.material, f.state);
      expect(signer).toBeDefined();
      const snapshot = f.snapshot();
      expect(signer?.observeRemote(snapshot.serialized, snapshot.witness, 700)).toBeDefined();
    }
  }
);

it('accepts a known older probe receipt evicted by a full 128-receipt auto window', () => {
  const f = fixture();
  f.state.counters.probe = 1;
  f.state.counters.auto = 128;
  f.state.receipts = Array.from({ length: 128 }, (_, index) => receipt('auto', index + 1));
  expect(f.observe()).toBeDefined();
  expect(f.broker.frame('probe', '')?.receipt.counter).toBe(2);
});
