/** Passive generated SSH reader and task admission: disposable broker/fake tmux only. */
import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Session } from '../src/session.js';
import type { RecoveryActionAuthority } from '../src/recovery/types.js';
import { classifyCodexTail } from '../src/recovery/codex-classifier.js';
import { latestProgressMarker } from '../src/supervision/evidence.js';
import { CodexTaskAdapter } from '../src/supervision/adapter.js';
import { withRemoteBrokerIssuerLease, type RemoteWorkerLeaseBinding } from '../src/recovery/remote-input-broker.js';
import { remoteBrokerReaderFixture } from './mocks/remote-broker-reader-fixture.js';
import {
  buildRemoteCodexEvidenceCommand,
  parseRemoteCodexEvidence,
  remotePromptFrameAdmission,
  remotePromptCommandFits,
  remoteInputPhases,
} from '../src/recovery/remote-codex.js';
const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  CID = '11111111-2222-3333-4444-555555555555';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const grant = vi.hoisted(() => ({ current: true }));
vi.mock('../src/session-env-clamp.js', () => ({
  clampRecoveryLaunchForOwner: async (_owner: unknown, configs: unknown, env: unknown) => ({
    configs,
    env,
    isCurrent: () => grant.current,
  }),
}));
afterEach(() => {
  grant.current = true;
  vi.restoreAllMocks();
});
it('sizes exact phase hashes and signed clock widths, including source-private manager evidence', () => {
  const prompt = '🧪'.repeat(16_384),
    issuer = {
      sessionId: CID,
      incarnation: CID,
      directory: '/source/private',
      proof: {},
      paths: [{ path: '/source/only' }],
    };
  const preview = remotePromptFrameAdmission(prompt, issuer)!;
  expect(preview.maxPhaseBytes).toBe(8192);
  const max = Number.MAX_SAFE_INTEGER,
    nonce = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  const claim = {
    sessionId: nonce,
    incarnation: nonce,
    conversationId: nonce,
    action: 'input',
    fullPayloadHash: hash(prompt),
    allowedPhaseHashes: remoteInputPhases(prompt).map(hash),
    native: {
      kind: 'input',
      paneId: '%' + max,
      brokerPid: max,
      childPid: max,
      brokerStart: String(max),
      childStart: String(max),
    },
    version: 1,
    managerSessionId: CID,
    managerIncarnation: CID,
    nonce,
    issuedAt: max,
    deadline: max,
  };
  expect(preview.issuerLeaseBytes).toBe(
    Buffer.byteLength(
      JSON.stringify({ claim, phaseIndex: max, remoteDeadline: 2 * max, clock: { localAt: max, min: -max, max: -max } })
    )
  );
  expect(remotePromptFrameAdmission(prompt, { ...issuer, paths: [{ path: 'x'.repeat(98_304) }] })).toBeUndefined();
  const tenPhases = '€'.repeat(21_845);
  expect(remoteInputPhases(tenPhases)).toHaveLength(10);
  expect(remotePromptFrameAdmission(tenPhases, issuer)).toBeUndefined();
  expect(remotePromptFrameAdmission(tenPhases)?.maxPhaseBytes).toBe(8190);
  expect(remotePromptFrameAdmission('\ud800')).toBeUndefined();
  expect(remotePromptFrameAdmission('x'.repeat(65_537))).toBeUndefined();
});
it('checks actual current witness sizes without probes, frames or journal/cache mutations', async () => {
  const f = await remoteBrokerReaderFixture();
  try {
    const before = await fs.readFile(join(f.broker.directory, 'state.json'), 'utf8');
    const bytes = await f.bytes(),
      effects = await fs.readFile(join(f.root, 'effects'), 'utf8');
    const admission = remotePromptFrameAdmission('x'.repeat(65_536))!;
    const run = async () =>
      parseRemoteCodexEvidence(
        (await f.run(buildRemoteCodexEvidenceCommand(f.remote, { ...f.request, frameAdmission: admission }))).stdout
      );
    const healthy = await run();
    expect(healthy?.transport === 'reachable' && 'frameAdmission' in healthy && healthy.frameAdmission).toEqual({
      ...admission,
      fits: true,
    });
    for (const malformed of [null, false, 0, { ...admission, maxPhaseBytes: 8193 }]) {
      const result = await f.run(
        buildRemoteCodexEvidenceCommand(f.remote, { ...f.request, frameAdmission: malformed as never })
      );
      expect(parseRemoteCodexEvidence(result.stdout)).toBeUndefined();
    }
    expect(healthy && 'pane' in healthy && remotePromptCommandFits(f.remote, f.request, 'Short task', healthy)).toBe(
      true
    );
    const escaped = '\x01'.repeat(30_000);
    expect(remotePromptFrameAdmission(escaped)).toBeDefined();
    expect(healthy && 'pane' in healthy && remotePromptCommandFits(f.remote, f.request, escaped, healthy)).toBe(false);
    // Unrelated, valid rollout headers remain part of the bounded scan witness.
    await Promise.all(
      Array.from({ length: 300 }, (_, n) => {
        const id = `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
        return fs.writeFile(
          join(f.home, 'sessions', `rollout-${'w'.repeat(170)}-${id}.jsonl`),
          JSON.stringify({
            type: 'session_meta',
            payload: { id, cwd: '/other', timestamp: new Date().toISOString(), originator: 'other' },
          }) + '\n'
        );
      })
    );
    const oversized = await run();
    expect(oversized?.transport === 'reachable' && 'frameAdmission' in oversized && oversized.frameAdmission).toEqual({
      ...admission,
      fits: false,
    });
    expect(await fs.readFile(join(f.broker.directory, 'state.json'), 'utf8')).toBe(before);
    expect(await f.bytes()).toEqual(bytes);
    expect(await fs.readFile(join(f.root, 'effects'), 'utf8')).toBe(effects);
  } finally {
    await f.close();
  }
});
function fake() {
  const now = Date.now(),
    clock = { localBefore: now, localAfter: now, remoteBefore: now, remoteAfter: now };
  const context = {
    generation: 1,
    managed: true,
    noDaemon: true,
    intentionalStopAt: 0,
    codexHome: '/remote/home',
    submission: { at: now, hash: hash('owner'), clockDomain: 'remote', clock },
  };
  const descriptor = { incarnation: SID, directory: '/remote/private/' + SID };
  const tail =
    JSON.stringify({
      timestamp: new Date(now).toISOString(),
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-1' },
    }) + '\n';
  const session = {
    id: SID,
    owner: 'owner',
    workingDir: '/work',
    remote: { hostId: 'fixture', label: 'Fixture', host: 'worker.invalid', port: 22, owned: true, remotePath: '/work' },
    codexConfig: { noDaemon: true, resumeSessionId: CID },
    getRecoveryContext: () => context,
    getEnvOverridesForPersist: () => ({}),
    getOwnedRemoteInputBroker: vi.fn(async () => descriptor),
    isBusy: () => false,
    observeOwnedRemoteInputBroker: vi.fn(() => {
      throw Error('must not hydrate');
    }),
  } as unknown as Session;
  const inspectRemote = vi.fn(async (_remote, req) => ({
    transport: 'reachable',
    session: 'present',
    pane: { dead: false, paneId: '%7', panePid: 700, screen: '› \n' },
    identity: { reason: 'verified', conversationId: CID, tail, tailTruncated: false, changedAt: now },
    inputBroker: {
      serialized: JSON.stringify({
        sessionId: SID,
        incarnation: SID,
        pid: 700,
        childPid: 701,
        brokerStart: '1',
        childStart: '2',
        closed: false,
        rawGeneration: 0,
        launchDigest: 'a'.repeat(64),
        homeDigest: hash('/remote/home'),
        counters: { 'owner-pty': 0, 'owner-key': 0, 'owner-mux': 0 },
      }),
      witness: {
        path: '/remote/private/' + SID + '/state.json',
        dev: 1,
        ino: 2,
        size: 100,
        mtimeMs: now,
        ctimeMs: now,
        maxBytes: 98304,
        hash: 'b'.repeat(64),
      },
    },
    clock,
    frameAdmission: { ...req.frameAdmission, fits: true },
  }));
  const adapter = new CodexTaskAdapter(
    session,
    () => {
      throw Error('must not persist');
    },
    { inspectRemote, deliverRemote: vi.fn(), restartRemote: vi.fn() } as never
  );
  const observe = vi.spyOn(adapter, 'observe').mockImplementation(async () => {
    throw Error('must not probe');
  });
  return { session, context, descriptor, inspectRemote, adapter, observe, tail, clock };
}
it('admits a fresh owned SSH task without ordinary observation or broker cache hydration', async () => {
  const f = fake();
  expect(await f.adapter.admitPrompt('Task', () => true)).toBe(true);
  expect(f.observe).not.toHaveBeenCalled();
  expect(f.session.observeOwnedRemoteInputBroker).not.toHaveBeenCalled();
  expect(f.inspectRemote).toHaveBeenCalledOnce();
});
it.each(['owner', 'home', 'incarnation', 'grant', 'manager', 'missing', 'malformed', 'dead', 'clock'] as const)(
  'refuses %s before publishing SSH admission',
  async (kind) => {
    const f = fake(),
      original = f.inspectRemote.getMockImplementation()!;
    let current = true;
    const authority: RecoveryActionAuthority = () => current;
    if (kind === 'manager') authority.getInputIssuer = () => undefined;
    f.inspectRemote.mockImplementation(async (...args) => {
      const result = await original(...args);
      if (kind === 'owner') current = false;
      if (kind === 'home') f.context.codexHome = '/changed';
      if (kind === 'incarnation') f.descriptor.incarnation = CID;
      if (kind === 'grant') grant.current = false;
      if (kind === 'missing') result.frameAdmission = undefined;
      if (kind === 'malformed') result.frameAdmission.promptHash = 'f'.repeat(64);
      if (kind === 'dead') result.pane.dead = true;
      if (kind === 'clock') result.clock = undefined;
      return result;
    });
    expect(await f.adapter.admitPrompt('Task', authority)).toBe(false);
    expect(f.observe).not.toHaveBeenCalled();
    expect(f.session.observeOwnedRemoteInputBroker).not.toHaveBeenCalled();
  }
);

it.each(['unknown', 'blocked', 'completed'])(
  'refuses a newer %s marker with otherwise equal remote turn proof',
  async (outcome) => {
    const f = fake(),
      original = f.inspectRemote.getMockImplementation()!;
    const at = new Date(f.clock.remoteAfter).toISOString();
    const report = (value: string) =>
      JSON.stringify({
        timestamp: at,
        type: 'event_msg',
        payload: {
          type: 'agent_message',
          message: 'CODEMAN_TASK_PROGRESS ' + JSON.stringify({ outcome: value, checkpoint: '', nextAction: '' }),
        },
      }) + '\n';
    const oldTail = f.tail + report('unfinished'),
      newTail = f.tail + report(outcome);
    const observation = classifyCodexTail(oldTail, {
      conversationId: CID,
      now: f.clock.remoteAfter,
      screen: '› \n',
      busy: false,
      watching: false,
      tailTruncated: false,
    });
    observation.conversationId = CID;
    expect(observation.activity).toBe('completed');
    const expected = {
      observation,
      commands: new Map(),
      marker: latestProgressMarker(oldTail, 0, f.clock.remoteAfter),
    };
    expect(expected.marker?.progress).toMatchObject({ outcome: 'unfinished' });
    f.inspectRemote.mockImplementation(async (...args) => {
      const result = await original(...args);
      result.identity.tail = oldTail;
      return result;
    });
    expect(await f.adapter.admitPrompt('Task', () => true, expected)).toBe(true);
    f.inspectRemote.mockImplementation(async (...args) => {
      const result = await original(...args);
      result.identity.tail = newTail;
      return result;
    });
    expect(await f.adapter.admitPrompt('Task', () => true, expected)).toBe(false);
  }
);
it('refuses a manager proof replaced while passive SSH inspection waits', async () => {
  const f = fake(),
    original = f.inspectRemote.getMockImplementation()!;
  const issuer = { sessionId: CID, incarnation: CID, directory: '/source/private', proof: { owner: 1 } };
  const authority: RecoveryActionAuthority = () => true;
  authority.getInputIssuer = () => issuer as never;
  f.inspectRemote.mockImplementation(async (...args) => {
    issuer.proof.owner++;
    return original(...args);
  });
  expect(await f.adapter.admitPrompt('Task', authority)).toBe(false);
});

it('bounds the actual source lease implementation claim and refuses its ten-phase Unicode opponent', async () => {
  const prompt = 'x'.repeat(65_536),
    issuer = {
      sessionId: CID,
      incarnation: CID,
      directory: '/source/private',
      proof: {},
      paths: [{ path: '/source/only' }],
    };
  const max = Number.MAX_SAFE_INTEGER;
  const binding: RemoteWorkerLeaseBinding = {
    sessionId: SID,
    incarnation: SID,
    conversationId: CID,
    action: 'input',
    fullPayloadHash: hash(prompt),
    allowedPhaseHashes: remoteInputPhases(prompt).map(hash),
    native: {
      kind: 'input',
      paneId: '%' + max,
      brokerPid: max,
      childPid: max,
      brokerStart: String(max),
      childStart: String(max),
    },
  };
  let close!: () => void;
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  const start = vi.fn((_helper: string, _directory: string, input: string) => {
    const wire = JSON.parse(input);
    expect(wire.issuer).toEqual(issuer);
    expect(input.endsWith('\n')).toBe(true);
    expect(Buffer.byteLength(input)).toBeLessThanOrEqual(98_304);
    return {
      ready: Promise.resolve({ status: 'ready' as const, nonce: wire.nonce, wallDeadline: Date.now() + 2000 }),
      closed,
      terminate: close,
    };
  });
  try {
    const result = await withRemoteBrokerIssuerLease(
      issuer,
      binding,
      { prepare: async () => true, isCurrent: () => true },
      async (claim) => {
        expect(Object.keys(claim).sort()).toEqual([
          'action',
          'allowedPhaseHashes',
          'conversationId',
          'deadline',
          'fullPayloadHash',
          'incarnation',
          'issuedAt',
          'managerIncarnation',
          'managerSessionId',
          'native',
          'nonce',
          'sessionId',
          'version',
        ]);
        expect(claim.allowedPhaseHashes).toEqual(remoteInputPhases(prompt).map(hash));
        expect(
          Buffer.byteLength(
            JSON.stringify({
              claim,
              phaseIndex: 8,
              remoteDeadline: claim.deadline - max,
              clock: { localAt: max, min: -max, max: -max },
            })
          )
        ).toBeLessThanOrEqual(remotePromptFrameAdmission(prompt, issuer)!.issuerLeaseBytes);
        return 'sent';
      },
      { helper: '# fake lease source', transport: { start } }
    );
    expect(result).toBe('sent');
    expect(start).toHaveBeenCalledOnce();
    start.mockClear();
    const unicode = '€'.repeat(21_845);
    expect(
      await withRemoteBrokerIssuerLease(
        issuer,
        { ...binding, fullPayloadHash: hash(unicode), allowedPhaseHashes: remoteInputPhases(unicode).map(hash) },
        { prepare: async () => true, isCurrent: () => true },
        async () => 'sent',
        { helper: '# fake lease source', transport: { start } }
      )
    ).toBe('not-sent');
    expect(start).not.toHaveBeenCalled();
    expect(remotePromptFrameAdmission(unicode, issuer)).toBeUndefined();
  } finally {
    close();
    await closed;
  }
});
it('rejects NUL input before passive SSH while ordinary text remains admitted', async () => {
  const f = fake();
  expect(await f.adapter.admitPrompt('Task\0hidden', () => true)).toBe(false);
  expect(f.inspectRemote).not.toHaveBeenCalled();
  expect(await f.adapter.admitPrompt('Task ordinary', () => true)).toBe(true);
  expect(f.inspectRemote).toHaveBeenCalledOnce();
});

it('refuses actual escaped SSH command overflow before an input reservation', async () => {
  const f = fake();
  expect(remotePromptFrameAdmission('\x01'.repeat(30_000))).toBeDefined();
  expect(await f.adapter.admitPrompt('\x01'.repeat(30_000), () => true)).toBe(false);
  expect(await f.adapter.admitPrompt('Plain task', () => true)).toBe(true);
  expect(f.observe).not.toHaveBeenCalled();
  expect(f.session.observeOwnedRemoteInputBroker).not.toHaveBeenCalled();
});
