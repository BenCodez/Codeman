/** Real broker and disposable Python child; no tmux, Codex, SSH or live session effects. */
import { createHash, createHmac } from 'node:crypto';
import type { PrivateFileWitness } from '../src/recovery/private-file-witness.js';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as nodePty from 'node-pty';
import { afterEach, expect, it, vi } from 'vitest';
import {
  CodexInputBroker,
  type BrokerAuthority,
  type BrokerChannel,
  type CodexBrokerState,
} from '../src/recovery/codex-input-broker.js';
import { loadRebootIdentityFence } from '../src/recovery/reboot-identity-fence.js';
import { Session } from '../src/session.js';
import { CodexRecoveryAdapter } from '../src/recovery/codex-adapter.js';
import type { RecoveryMuxDispatchGuard, TerminalMultiplexer } from '../src/mux-interface.js';

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OWNERS = { 'owner-pty': 0, 'owner-key': 0, 'owner-mux': 0 };
const CID = '11111111-2222-3333-4444-555555555555';
const running: Array<{ child: ChildProcessWithoutNullStreams; root: string; done: Promise<number | null> }> = [];
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
const JOURNAL_CHANNELS: BrokerChannel[] = ['owner-pty', 'owner-key', 'owner-mux', 'auto', 'probe'];

async function journalFrame(target: Awaited<ReturnType<typeof fixture>>, channel: BrokerChannel) {
  // Probes have no conversation or input; all other channels use the exact recorded fixture identity.
  const admitted =
    channel === 'probe'
      ? target.broker.frame(channel, '')!
      : target.broker.frame(channel, 'Known input', CID, undefined, [], OWNERS)!;
  target.child.stdin.write(admitted.data);
  expect(await target.broker.receipt(admitted.receipt)).toBe('sent');
}

async function leaseDispatch(target: Awaited<ReturnType<typeof fixture>>, issuer: BrokerAuthority) {
  const lease = spawn('python3', [join(target.broker.directory, 'broker.py'), '--lease', target.broker.directory], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let response = '';
  const dispatch = vi.fn(() => target.child.stdin.write('LEASE_DISPATCH_EFFECT'));
  lease.stdout.on('data', (bytes) => {
    response += bytes.toString();
    if (response.includes('"status": "ready"') && !dispatch.mock.calls.length) dispatch();
  });
  lease.stderr.on('data', () => {});
  const done = new Promise<number | null>((resolve) => lease.on('close', resolve));
  lease.stdin.end(JSON.stringify({ issuer, durationMs: 80, nonce: '99999999-2222-3333-4444-555555555555' }) + '\n');
  return { code: await done, dispatch };
}

async function eventually(check: () => Promise<boolean>, timeout = 2_000): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!(await check())) {
    if (performance.now() >= deadline) throw new Error('Fake child deadline');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function fixture(
  exit = 0,
  helper?: (source: string) => string,
  childEdit?: (source: string) => string,
  setup?: (broker: CodexInputBroker, root: string) => Promise<void>,
  sid = SID,
  beforeReady?: (broker: CodexInputBroker, child: ChildProcessWithoutNullStreams) => Promise<void>
) {
  const root = await fs.mkdtemp(join(homedir(), 'input-broker-fixture-'));
  const childPath = join(root, 'fake-child.py');
  const childSource = String.raw`
import os, select, sys, termios, tty
tty.setraw(0, termios.TCSANOW)
root = sys.argv[1]
fd = os.open(os.path.join(root, 'bytes'), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
os.write(1, b'FAKE_CHILD_READY\n')
while not os.path.exists(os.path.join(root, 'stop')):
    if select.select([0], [], [], .01)[0]:
        data = os.read(0, 65536)
        if not data: break
        os.write(fd, data)
os.close(fd)
sys.exit(int(sys.argv[2]))
`;
  await fs.writeFile(childPath, childEdit ? childEdit(childSource) : childSource);
  const broker = await CodexInputBroker.create(
    join(root, 'control'),
    sid,
    `exec python3 -u ${quote(childPath)} ${quote(root)} ${exit}`,
    root
  );
  await setup?.(broker, root);
  if (helper) {
    const path = join(broker.directory, 'broker.py');
    await fs.writeFile(path, helper(await fs.readFile(path, 'utf8')));
  }
  const env = { ...process.env };
  env.CODEX_HOME = root;
  const child = spawn('python3', [join(broker.directory, 'broker.py'), broker.directory, broker.configurationDigest], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (bytes) => {
    output += bytes.toString();
  });
  child.stderr.on('data', (bytes) => {
    output += bytes.toString();
  });
  const done = new Promise<number | null>((resolve) => child.on('close', resolve));
  running.push({ child, root, done });
  await beforeReady?.(broker, child);
  await eventually(async () => output.includes('FAKE_CHILD_READY') && (await broker.readState()) !== undefined);
  const bytes = async () => fs.readFile(join(root, 'bytes'));
  return { broker, child, root, done, bytes, output: () => output };
}
afterEach(async () => {
  for (const entry of running.splice(0)) {
    await fs.writeFile(join(entry.root, 'stop'), 'stop');
    await Promise.race([
      entry.done,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Fake child failed to exit')), 3_000)),
    ]);
    await fs.rm(entry.root, { recursive: true, force: true });
  }
});

it('preserves a 64KiB UTF-8 owner paste, controls and split frame bytes exactly', async () => {
  const { broker, child, bytes } = await fixture();
  const input = `${'😀'.repeat(16_380)}\x1b[200~\n\r\t\x03\x1b[201~`;
  expect(Buffer.byteLength(input)).toBeLessThanOrEqual(65_536);
  const frame = broker.frame('owner-pty', input)!;
  expect(Buffer.byteLength(frame.data)).toBeGreaterThan(98_304);
  const encoded = Buffer.from(frame.data);
  for (let offset = 0; offset < encoded.length; offset += 13_117)
    child.stdin.write(encoded.subarray(offset, offset + 13_117));
  expect(await broker.receipt(frame.receipt)).toBe('sent');
  await eventually(async () => (await bytes()).length === Buffer.byteLength(input));
  expect(await bytes()).toEqual(Buffer.from(input));
  expect(await broker.prove(child.pid!)).toMatchObject({ rawGeneration: 0, closed: false });
});

it.each([false, true])(
  'accepts literal then Enter as distinct automatic effects and consumes duplicates once (bracketed=%s)',
  async (bracketed) => {
    const { broker, child, bytes } = await fixture();
    const input = bracketed ? '\x1b[200~Continue fixture\x1b[201~' : 'Continue fixture';
    const literal = broker.frame('auto', input, CID, undefined, [], OWNERS)!;
    expect(literal.receipt.hash).toBe(createHash('sha256').update(input).digest('hex'));
    child.stdin.write(literal.data);
    expect(await broker.receipt(literal.receipt)).toBe('sent');
    child.stdin.write(literal.data);
    const enter = broker.frame('auto', '\r', CID, undefined, [], OWNERS)!;
    child.stdin.write(enter.data);
    expect(await broker.receipt(enter.receipt)).toBe('sent');
    await eventually(async () => (await bytes()).length === Buffer.byteLength(input + '\r'));
    expect((await bytes()).toString()).toBe(input + '\r');
  }
);

it('journals direct terminal input before forwarding it and refuses later automatic bytes', async () => {
  const { broker, child, bytes } = await fixture();
  const direct = '/resume older-fixture\r';
  child.stdin.write(direct);
  const automatic = broker.frame('auto', 'Must not arrive\r', CID, undefined, [], OWNERS)!;
  child.stdin.write(automatic.data);
  expect(await broker.receipt(automatic.receipt)).toBe('not-sent');
  await eventually(async () => (await bytes()).length === direct.length);
  expect((await bytes()).toString()).toBe(direct);
  expect(await broker.prove(child.pid!)).toBeUndefined();
  const owner = broker.frame('owner-key', '\n')!;
  child.stdin.write(owner.data);
  expect(await broker.receipt(owner.receipt)).toBe('sent');
  expect((await broker.readState())?.tainted).toBe(true);
});

it('refuses Enter when direct input arrives after an accepted automatic literal', async () => {
  const { broker, child, bytes } = await fixture();
  const literal = broker.frame('auto', 'Verified fixture', CID, undefined, [], OWNERS)!;
  child.stdin.write(literal.data);
  expect(await broker.receipt(literal.receipt)).toBe('sent');
  child.stdin.write('\x1b');
  const enter = broker.frame('auto', '\r', CID, undefined, [], OWNERS)!;
  child.stdin.write(enter.data);
  expect(await broker.receipt(enter.receipt)).toBe('not-sent');
  await eventually(async () => (await bytes()).length === 'Verified fixture\x1b'.length);
  expect((await bytes()).toString()).toBe('Verified fixture\x1b');
});

it.each(['owner-pty', 'owner-key', 'owner-mux'] as const)(
  'vetoes an old automatic packet after late %s input',
  async (channel) => {
    const { broker, child, bytes } = await fixture();
    const automatic = broker.frame('auto', 'Old automatic input', CID, undefined, [], OWNERS)!;
    const owner = broker.frame(channel, 'Owner edit')!;
    child.stdin.write(owner.data + automatic.data);
    expect(await broker.receipt(owner.receipt)).toBe('sent');
    expect(await broker.receipt(automatic.receipt)).toBe('not-sent');
    expect((await broker.readState())?.tainted).toBe(false);
    await eventually(async () => (await bytes()).length === 'Owner edit'.length);
    expect((await bytes()).toString()).toBe('Owner edit');
  }
);

it.each(['malformed', 'expired'] as const)(
  'keeps recognizable %s control encoding away from the child',
  async (kind) => {
    const { broker, child, bytes } = await fixture();
    const control =
      kind === 'malformed'
        ? '\x1eCODEMAN_INPUT_V1:not-a-frame:invalid\x1f'
        : '\x1eCODEMAN_INPUT_V1:unfinished-private-path';
    child.stdin.write(control);
    await eventually(async () => (await broker.readState())?.tainted === true, 2_500);
    expect((await bytes()).length).toBe(0);
    expect(child.exitCode).toBeNull();
  }
);

it('does not forward direct input when its taint journal cannot be acknowledged', async () => {
  const { broker, child, bytes } = await fixture(0, (source) =>
    source.replace(
      'except Exception:\n            # Keep the live child and its output.',
      "except Exception:\n            if state['tainted']:\n                with open(path + '.taint-refused', 'w') as marker: marker.write('refused')\n            # Keep the live child and its output."
    )
  );
  await fs.writeFile(join(broker.directory, 'state.json.next'), 'held fake writer');
  child.stdin.write('Unacknowledged direct bytes');
  await eventually(async () =>
    fs.stat(join(broker.directory, 'state.json.taint-refused')).then(
      () => true,
      () => false
    )
  );
  expect(await fs.readFile(join(broker.directory, 'state.json.next'), 'utf8')).toBe('held fake writer');
  expect((await bytes()).length).toBe(0);
  expect(child.exitCode).toBeNull();
  expect((await broker.readState())?.tainted).toBe(false);
});

it.each([0, 7])('keeps exact child waitpid status %i and restores counters without reset', async (status) => {
  const { broker, child, root, done } = await fixture(status);
  const owner = broker.frame('owner-pty', 'Owner fixture')!;
  child.stdin.write(owner.data);
  expect(await broker.receipt(owner.receipt)).toBe('sent');
  await fs.writeFile(join(root, 'stop'), 'stop');
  expect(await done).toBe(status);
  expect(await broker.prove(child.pid!)).toMatchObject({ closed: true, exitStatus: status });
  const restored = await CodexInputBroker.load(broker.directory, SID);
  expect(restored?.frame('owner-pty', 'Next fixture')?.receipt.counter).toBe(owner.receipt.counter + 1);
});

it('rejects unknown or malformed private evidence and a foreign session binding', async () => {
  const { broker } = await fixture();
  expect(await CodexInputBroker.load(broker.directory, CID)).toBeUndefined();
  const state = await broker.readState();
  await fs.writeFile(join(broker.directory, 'state.json'), JSON.stringify({ ...state, childPid: 'unknown' }), {
    mode: 0o600,
  });
  expect(await broker.readState()).toBeUndefined();
  expect(await CodexInputBroker.load(broker.directory, SID)).toBeUndefined();
});

it('retains a sealed reservation after a partial child write and keeps the child alive', async () => {
  const { broker, child, bytes } = await fixture(0, (source) =>
    source.replace(
      'count = os.write(master, data[offset:offset + 32768])',
      "if offset:\n                        raise OSError('fixture partial write')\n                    count = os.write(master, data[offset:offset + 1])"
    )
  );
  const frame = broker.frame('auto', 'Partial fixture', CID, undefined, [], OWNERS)!;
  child.stdin.write(frame.data);
  expect(await broker.receipt(frame.receipt)).toBe('unknown');
  expect((await bytes()).toString()).toBe('P');
  expect((await broker.readState())?.receipts[0].status).toBe('reserved');
  expect(await broker.prove(child.pid!)).toBeUndefined();
  expect(child.exitCode).toBeNull();
});

it('never forwards after reservation rename succeeds but directory fsync fails', async () => {
  const { broker, child, bytes } = await fixture(0, (source) =>
    source.replace(
      'os.fsync(directory)',
      "if value.get('receipts') and value['receipts'][-1]['status'] == 'reserved':\n            raise OSError('fixture postrename failure')\n        os.fsync(directory)"
    )
  );
  const frame = broker.frame('auto', 'Unacknowledged fixture', CID, undefined, [], OWNERS)!;
  child.stdin.write(frame.data);
  expect(await broker.receipt(frame.receipt)).toBe('unknown');
  expect((await bytes()).length).toBe(0);
  expect((await broker.readState())?.receipts[0].status).toBe('reserved');
  expect(await broker.prove(child.pid!)).toBeUndefined();
  expect(child.exitCode).toBeNull();
});

it.each(['shared-deadline', 'event-loop-overshoot'] as const)(
  'keeps the original bounded private reader deadline (%s)',
  async (mode) => {
    const { broker } = await fixture();
    const path = join(broker.directory, 'state.json');
    const handle = await fs.open(path, 'r');
    const actualOpen = fs.open;
    let release!: (value: typeof handle) => void;
    const held = new Promise<typeof handle>((resolve) => {
      release = resolve;
    });
    let time = 0;
    const open = vi
      .spyOn(fs, 'open')
      .mockImplementation(((target: Parameters<typeof fs.open>[0], ...args: unknown[]) =>
        target === path ? held : Reflect.apply(actualOpen, fs, [target, ...args])) as typeof fs.open);
    vi.useFakeTimers();
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => time);
    try {
      const first = broker.readState();
      time = 1_500;
      let secondFinished = false;
      const second = broker.readState().then((value) => {
        secondFinished = true;
        return value;
      });
      if (mode === 'shared-deadline') {
        time = 2_001;
        await vi.advanceTimersByTimeAsync(2_000);
        expect(secondFinished).toBe(true);
        expect(await first).toBeUndefined();
        expect(await second).toBeUndefined();
        release(handle);
      } else {
        time = 3_000;
        release(handle);
        expect(await first).toBeUndefined();
        expect(await second).toBeUndefined();
      }
    } finally {
      release(handle);
      open.mockRestore();
      clock.mockRestore();
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
);

it.each([false, true])('real Session and adapter exclude an unobserved older resume (direct=%s)', async (direct) => {
  const { broker, child, root, bytes } = await fixture();
  const previousData = process.env.CODEMAN_DATA_DIR;
  process.env.CODEMAN_DATA_DIR = join(root, 'manager');
  await fs.mkdir(join(root, 'sessions'));
  const effects: string[] = [];
  const mux = {
    isAvailable: () => true,
    inspectPaneForRecovery: async () => ({
      paneId: '%7',
      panePid: child.pid!,
      dead: false,
      screen: '›\n  fixture-model default · /tmp\n',
      inputProvenance: await broker.prove(child.pid!),
    }),
    getCodexInputAuthority: (_id: string, proof: Parameters<typeof broker.authority>[0]) => broker.authority(proof),
    inspectCodexInputProvenance: async (_id: string, pid: number) => broker.prove(pid),
    sendInput: async (_id: string, input: string, guard?: RecoveryMuxDispatchGuard) => {
      for (const data of [input.slice(0, -1), '\r']) {
        if (!guard || !(await guard.prepareEvidence?.()) || !guard.confirm()) return false;
        const frame = broker.frame('auto', data, guard.conversationId, undefined, [], guard.inputProof?.ownerCounters)!;
        guard.noteDispatch();
        child.stdin.write(frame.data);
        const receipt = await broker.receipt(frame.receipt);
        if (receipt !== 'sent') {
          if (receipt === 'not-sent') guard.noteBrokerRefusal?.();
          return false;
        }
        guard.noteBrokerSent?.();
        effects.push(data);
      }
      return true;
    },
  };
  const now = Date.now();
  const session = new Session({
    id: SID,
    workingDir: root,
    mode: 'codex',
    useMux: true,
    mux: mux as unknown as TerminalMultiplexer,
    muxSession: {
      sessionId: SID,
      muxName: 'codeman-aaaaaaaa',
      pid: child.pid!,
      createdAt: now,
      workingDir: root,
      mode: 'codex',
      attached: true,
      recoveryIsolated: true,
      recoveryCodexHome: root,
      recoveryInputBroker: broker.incarnation,
    },
    codexConfig: { noDaemon: true, resumeSessionId: CID },
    envOverrides: { CODEX_HOME: root },
  });
  try {
    expect(await session.ensureRecoveryIdentityFence()).toBe(true);
    const request = 'Initial owner fixture';
    session.trackUserInput(`${request}\r`);
    const owner = broker.frame('owner-pty', `${request}\r`)!;
    child.stdin.write(owner.data);
    expect(await broker.receipt(owner.receipt)).toBe('sent');
    await Reflect.get(session, '_recoveryFencePublication');
    expect(session.getRecoveryContext().switchPending).toBe(false);
    const submission = session.getRecoveryContext().submission!;
    await fs.writeFile(
      join(root, 'history.jsonl'),
      JSON.stringify({ session_id: CID, ts: submission.at / 1000, text: request }) + '\n'
    );
    const other = '99999999-2222-3333-4444-555555555555';
    const event = (payload: unknown) =>
      JSON.stringify({ timestamp: new Date(now).toISOString(), type: 'event_msg', payload }) + '\n';
    for (const [id, age] of [
      [CID, 1_000],
      [other, 5_000],
    ] as const) {
      await fs.writeFile(
        join(root, 'sessions', `rollout-2026-10-14T12-00-00-${id}.jsonl`),
        JSON.stringify({
          timestamp: new Date(now - age).toISOString(),
          type: 'session_meta',
          payload: { id, cwd: root, originator: id === CID ? `codeman_${SID}` : 'prior-owner-fixture' },
        }) +
          '\n' +
          event({ type: 'user_message', message: request }) +
          event({ type: 'task_started', turn_id: 'fixture-turn' }) +
          event({
            type: 'task_complete',
            turn_id: 'fixture-turn',
            ...(id === CID ? { error: { message: 'Conversation interrupted.', codex_error_info: null } } : {}),
          })
      );
    }
    const adapter = new CodexRecoveryAdapter(session, () => {});
    const before = await adapter.observe();
    expect(before.safeToAct).toBe(true);
    if (direct) {
      child.stdin.write(`/resume ${other}\r`);
      await eventually(async () => (await broker.readState())?.tainted === true);
      expect((await fs.readFile(join(root, 'history.jsonl'), 'utf8')).includes(CID)).toBe(true);
      expect((await adapter.observe()).safeToAct).toBe(false);
    }
    const result = await adapter.act({
      action: 'continue',
      key: before.evidenceKey!,
      conversationId: CID,
      startedAt: now,
    });
    expect(result).toBe(direct ? 'not-sent' : 'sent');
    expect(effects).toHaveLength(direct ? 0 : 2);
    if (direct) {
      await eventually(async () => (await bytes()).length === Buffer.byteLength(`${request}\r/resume ${other}\r`));
      expect((await bytes()).toString()).toBe(`${request}\r/resume ${other}\r`);
    }
  } finally {
    await session.stop(false);
    await vi.waitFor(
      async () => {
        await loadRebootIdentityFence(session.id);
      },
      { timeout: 3000, interval: 5 }
    );
    if (previousData === undefined) delete process.env.CODEMAN_DATA_DIR;
    else process.env.CODEMAN_DATA_DIR = previousData;
  }
});

it.each(['owner-key', 'auto'] as const)(
  'restores fragmented 64KiB owner input before nested %s frames',
  async (channel) => {
    const { broker, child, bytes } = await fixture();
    const input = '😀'.repeat(16_384);
    const outer = broker.frame('owner-pty', input)!;
    const inner =
      channel === 'auto'
        ? broker.frame('auto', 'Forbidden pending owner', CID, undefined, [], OWNERS)!
        : broker.frame('owner-key', '\r')!;
    expect(await broker.prove(child.pid!)).toBeUndefined();
    const split = 41_111;
    child.stdin.write(outer.data.slice(0, split));
    child.stdin.write(inner.data);
    child.stdin.write(outer.data.slice(split));
    expect(await broker.receipt(outer.receipt)).toBe('sent');
    expect(await broker.receipt(inner.receipt)).toBe(channel === 'auto' ? 'not-sent' : 'sent');
    const expected = input + (channel === 'owner-key' ? '\r' : '');
    await eventually(async () => (await bytes()).length === Buffer.byteLength(expected));
    expect(await bytes()).toEqual(Buffer.from(expected));
    expect((await broker.readState())?.tainted).toBe(false);
  }
);

it('refuses an outer automatic frame when nested owner input arrives before its suffix', async () => {
  const { broker, child, bytes } = await fixture();
  const outer = broker.frame('auto', 'Forbidden old automatic bytes', CID, undefined, [], OWNERS)!;
  const owner = broker.frame('owner-key', 'Owner intent')!;
  child.stdin.write(outer.data.slice(0, 31));
  child.stdin.write(owner.data);
  child.stdin.write(outer.data.slice(31));
  expect(await broker.receipt(outer.receipt)).toBe('not-sent');
  expect(await broker.receipt(owner.receipt)).toBe('sent');
  await eventually(async () => (await bytes()).length === 'Owner intent'.length);
  expect((await bytes()).toString()).toBe('Owner intent');
});

it('keeps bidirectional child output moving during a 64KiB owner paste', async () => {
  const { broker, child, root, bytes, output } = await fixture(0, undefined, (source) =>
    source.replace(
      "while not os.path.exists(os.path.join(root, 'stop')):",
      "while not os.path.exists(os.path.join(root, 'go')): select.select([], [], [], .01)\nremaining = 20 * 1024 * 1024\nwhile remaining:\n    remaining -= os.write(1, b'x' * min(remaining, 32768))\nwhile not os.path.exists(os.path.join(root, 'stop')):"
    )
  );
  const input = 'p'.repeat(65_536);
  const owner = broker.frame('owner-pty', input)!;
  child.stdin.write(owner.data);
  await fs.writeFile(join(root, 'go'), 'go');
  expect(await broker.receipt(owner.receipt)).toBe('sent');
  await eventually(async () => output().length >= 20 * 1024 * 1024 && (await bytes()).length === input.length, 5_000);
  expect((await bytes()).toString()).toBe(input);
});

it('records clean owned-parent exit while a descendant retains the child terminal', async () => {
  const { broker, child, bytes } = await fixture(0, undefined, (source) =>
    source.replace(
      "os.write(1, b'FAKE_CHILD_READY\\n')",
      "import signal\nsignal.signal(signal.SIGHUP, signal.SIG_IGN)\nif os.fork():\n    sys.exit(0)\nos.write(1, b'FAKE_CHILD_READY\\n')"
    )
  );
  await eventually(async () => (await broker.readState())?.closed === true);
  expect(await broker.prove(child.pid!)).toMatchObject({ closed: true, exitStatus: 0 });
  const automatic = broker.frame('auto', 'Forbidden after clean exit', CID, undefined, [], OWNERS)!;
  child.stdin.write(automatic.data);
  expect(await broker.receipt(automatic.receipt)).toBe('not-sent');
  expect((await bytes()).length).toBe(0);
  expect(child.exitCode).toBeNull();
});

it('rejects invalid UTF-8 private journal bytes instead of replacement-decoding them', async () => {
  const { broker, child } = await fixture();
  const owner = broker.frame('owner-key', 'Owner fixture')!;
  child.stdin.write(owner.data);
  expect(await broker.receipt(owner.receipt)).toBe('sent');
  const path = join(broker.directory, 'state.json');
  const bytes = await fs.readFile(path);
  const needle = Buffer.from('"conversationId":""');
  const position = bytes.indexOf(needle);
  expect(position).toBeGreaterThan(0);
  await fs.writeFile(
    path,
    Buffer.concat([
      bytes.subarray(0, position),
      Buffer.from('"conversationId":"'),
      Buffer.from([0xff]),
      Buffer.from('"'),
      bytes.subarray(position + needle.length),
    ])
  );
  expect(await broker.readState()).toBeUndefined();
});

async function witness(path: string, maxBytes = 2_097_152): Promise<PrivateFileWitness> {
  const [stat, bytes] = await Promise.all([fs.stat(path), fs.readFile(path)]);
  return {
    path,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    hash: createHash('sha256').update(bytes).digest('hex'),
    maxBytes,
  };
}

it.each([262_144, 2_097_152])(
  'verifies actual %i-byte private evidence before startup and automatic delivery',
  async (size) => {
    let file!: PrivateFileWitness;
    const { broker, child, bytes } = await fixture(0, undefined, undefined, async (codec, root) => {
      const path = join(root, 'private-grant');
      await fs.writeFile(path, Buffer.alloc(size, 97), { mode: 0o600 });
      file = await witness(path);
      await codec.setStartupAuthority([file]);
    });
    expect(await broker.startupReceipt(child.pid!)).toBe('started');
    const automatic = broker.frame('auto', 'Verified grant fixture', CID, undefined, [file], OWNERS)!;
    child.stdin.write(automatic.data);
    expect(await broker.receipt(automatic.receipt)).toBe('sent');
    await eventually(async () => (await bytes()).length === 'Verified grant fixture'.length);
    expect((await bytes()).toString()).toBe('Verified grant fixture');
  }
);

it('rejects stale startup authority before any child is forked', async () => {
  const root = await fs.mkdtemp(join(homedir(), 'input-startup-refusal-'));
  const grant = join(root, 'private-grant');
  const started = join(root, 'child-started');
  await fs.writeFile(grant, 'initial', { mode: 0o600 });
  const broker = await CodexInputBroker.create(join(root, 'control'), SID, `printf child > ${quote(started)}`, root);
  await broker.setStartupAuthority([await witness(grant)]);
  await fs.writeFile(grant, 'changed', { mode: 0o600 });
  const child = spawn('python3', [join(broker.directory, 'broker.py'), broker.directory, broker.configurationDigest], {
    env: { ...process.env, CODEX_HOME: root },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const done = new Promise<number | null>((resolve) => child.on('close', resolve));
  running.push({ child, root, done });
  expect(await done).toBe(1);
  expect(await broker.startupReceipt(child.pid!)).toBe('not-sent');
  expect((await broker.readState())?.childPid).toBe(0);
  await expect(fs.stat(started)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['healthy', 'revoked', 'stripped-authority'] as const)(
  'binds the final startup issuer through the Python handoff: %s',
  async (change) => {
    const manager = await fixture(0, undefined, undefined, undefined, CID);
    const issuer = manager.broker.authority((await manager.broker.prove(manager.child.pid!))!)!;
    const root = await fs.mkdtemp(join(homedir(), 'startup-issuer-handoff-'));
    const marker = join(root, 'child-started');
    const broker = await CodexInputBroker.create(join(root, 'control'), SID, `printf started > ${quote(marker)}`, root);
    await broker.setStartupAuthority([], issuer);
    const expected = broker.configurationDigest;
    if (change !== 'healthy') {
      manager.child.stdin.write('Direct manager owner intent');
      await eventually(async () => (await manager.broker.readState())?.tainted === true);
    }
    if (change === 'stripped-authority') {
      const path = join(broker.directory, 'config.json');
      const config = JSON.parse(await fs.readFile(path, 'utf8'));
      config.startup.issuer = null;
      await fs.writeFile(path, JSON.stringify(config), { mode: 0o600 });
    }
    const child = spawn('python3', [join(broker.directory, 'broker.py'), broker.directory, expected], {
      env: { ...process.env, CODEX_HOME: root },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.resume();
    child.stderr.resume();
    const done = new Promise<number | null>((resolve) => child.once('close', resolve));
    running.push({ child, root, done });
    expect(await done).toBe(change === 'healthy' ? 0 : 1);
    if (change === 'healthy') {
      expect(await fs.readFile(marker, 'utf8')).toBe('started');
      expect(await broker.startupReceipt(child.pid!)).toBe('started');
    } else {
      await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      if (change === 'revoked') expect(await broker.startupReceipt(child.pid!)).toBe('not-sent');
      else expect(await broker.readState()).toBeUndefined();
    }
  }
);

it('rejects an issuer after direct manager input while preserving healthy exact issuer delivery', async () => {
  const manager = await fixture(0, undefined, undefined, undefined, CID);
  const worker = await fixture();
  const authority = manager.broker.authority((await manager.broker.prove(manager.child.pid!))!)!;
  const healthy = worker.broker.frame(
    'auto',
    'Healthy issuer',
    CID,
    authority,
    [authority.proof.fileWitness!],
    OWNERS
  )!;
  worker.child.stdin.write(healthy.data);
  expect(await worker.broker.receipt(healthy.receipt)).toBe('sent');
  manager.child.stdin.write('/resume direct-manager\r');
  await eventually(async () => (await manager.broker.readState())?.tainted === true);
  const vetoed = worker.broker.frame(
    'auto',
    'Forbidden old issuer',
    CID,
    authority,
    [authority.proof.fileWitness!],
    OWNERS
  )!;
  worker.child.stdin.write(vetoed.data);
  expect(await worker.broker.receipt(vetoed.receipt)).toBe('not-sent');
  await eventually(async () => (await worker.bytes()).length === 'Healthy issuer'.length);
  expect((await worker.bytes()).toString()).toBe('Healthy issuer');
});

it('bounds blocked automatic input and retains partial delivery without later bytes', async () => {
  const { broker, child, root, bytes, output } = await fixture(0, undefined, (source) =>
    source.replace(
      '    if select.select([0], [], [], .01)[0]:',
      "    os.write(1, b'heartbeat\\n')\n    if not os.path.exists(os.path.join(root, 'read-now')):\n        select.select([], [], [], .01)\n        continue\n    if select.select([0], [], [], .01)[0]:"
    )
  );
  const automatic = broker.frame('auto', 'a'.repeat(65_536), CID, undefined, [], OWNERS)!;
  child.stdin.write(automatic.data);
  expect(await broker.receipt(automatic.receipt)).toBe('unknown');
  const outputAtTimeout = output().length;
  await fs.writeFile(join(root, 'read-now'), 'read');
  await eventually(async () => (await bytes()).length > 0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const accepted = (await bytes()).length;
  expect(accepted).toBeLessThan(65_536);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect((await bytes()).length).toBe(accepted);
  expect(output().length).toBeGreaterThan(outputAtTimeout);
  expect((await broker.readState())?.receipts.at(-1)?.status).toBe('reserved');
  expect(child.exitCode).toBeNull();
});

it('keeps child output alive when private proof reads exceed the original deadline', async () => {
  const { broker, child, root, bytes, output } = await fixture(
    0,
    (source) =>
      source.replace(
        "current, _ = snapshot(witness['path'], witness['maxBytes'])",
        "if witness['path'].endswith('held-native-proof'): time.sleep(3)\n        current, _ = snapshot(witness['path'], witness['maxBytes'])"
      ),
    (source) =>
      source.replace(
        "while not os.path.exists(os.path.join(root, 'stop')):",
        "while not os.path.exists(os.path.join(root, 'stop')):\n    os.write(1, b'heartbeat\\n')"
      )
  );
  const path = join(root, 'held-native-proof');
  await fs.writeFile(path, 'held', { mode: 0o600 });
  const frame = broker.frame('auto', 'Forbidden delayed proof', CID, undefined, [await witness(path)], OWNERS)!;
  child.stdin.write(frame.data);
  expect(await broker.receipt(frame.receipt)).toBe('unknown');
  await eventually(async () => (await broker.readState())?.receipts.at(-1)?.status === 'not-sent');
  const observed = output().length;
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  expect((await bytes()).length).toBe(0);
  expect(output().length).toBeGreaterThan(observed);
  expect(child.exitCode).toBeNull();
});

it('refuses a newly created missing-path fence at the child effect boundary', async () => {
  const { broker, child, root, bytes } = await fixture();
  const fence = join(root, 'owner-intent-fence');
  const automatic = broker.frame('auto', 'Forbidden new fence', CID, undefined, [], OWNERS, [], [fence])!;
  await fs.writeFile(fence, 'owner');
  child.stdin.write(automatic.data);
  expect(await broker.receipt(automatic.receipt)).toBe('not-sent');
  expect((await bytes()).length).toBe(0);
});

it.each(['dead-child', 'wrong-child-birth', 'wrong-broker-birth'] as const)(
  'rejects issuer process scope %s',
  async (change) => {
    const manager = await fixture(0, undefined, undefined, undefined, CID);
    const worker = await fixture();
    const authority = manager.broker.authority((await manager.broker.prove(manager.child.pid!))!)!;
    if (change === 'dead-child') {
      await fs.writeFile(join(manager.root, 'stop'), 'stop');
      await manager.done;
    } else {
      authority.proof = { ...authority.proof, [change === 'wrong-child-birth' ? 'childStart' : 'brokerStart']: '0' };
    }
    const automatic = worker.broker.frame(
      'auto',
      'Forbidden issuer process',
      CID,
      authority,
      [authority.proof.fileWitness!],
      OWNERS
    )!;
    worker.child.stdin.write(automatic.data);
    expect(await worker.broker.receipt(automatic.receipt)).toBe('not-sent');
    expect((await worker.bytes()).length).toBe(0);
  }
);

it('uses a zero-child-byte ordered probe and refuses raw input queued before it', async () => {
  const { broker, child, bytes } = await fixture();
  const healthy = broker.frame('probe', '')!;
  child.stdin.write(healthy.data);
  expect(await broker.receipt(healthy.receipt)).toBe('sent');
  expect((await bytes()).length).toBe(0);
  child.stdin.write('/resume queued-direct\r');
  const denied = broker.frame('probe', '')!;
  child.stdin.write(denied.data);
  expect(await broker.receipt(denied.receipt)).toBe('not-sent');
  expect(await broker.prove(child.pid!)).toBeUndefined();
  await eventually(async () => (await bytes()).length === '/resume queued-direct\r'.length);
});

it('withholds ordered probe proof while an outer owner frame is incomplete', async () => {
  const { broker, child, bytes } = await fixture();
  const owner = broker.frame('owner-pty', 'Owner paste')!;
  const probe = broker.frame('probe', '')!;
  child.stdin.write(owner.data.slice(0, 31) + probe.data);
  expect(await broker.prove(child.pid!)).toBeUndefined();
  child.stdin.write(owner.data.slice(31));
  expect(await broker.receipt(owner.receipt)).toBe('sent');
  // A probe nested inside known pending owner input is conservatively refused.
  expect(await broker.receipt(probe.receipt)).toBe('not-sent');
  expect((await bytes()).toString()).toBe('Owner paste');
  expect(await broker.prove(child.pid!)).toBeDefined();
});

it('holds an exact issuer lease until monotonic expiry even after stdin EOF', async () => {
  const manager = await fixture(
    0,
    (source) =>
      source.replace(
        'except BlockingIOError:\n                                if time.monotonic() >= end:',
        "except BlockingIOError:\n                                with open(os.path.join(directory, 'lease-blocked'), 'w') as marker: marker.write('blocked')\n                                while not os.path.exists(os.path.join(directory, 'lease-retry')): time.sleep(.001)\n                                if time.monotonic() >= end:"
      ),
    undefined,
    undefined,
    CID
  );
  const authority = manager.broker.authority((await manager.broker.prove(manager.child.pid!))!)!;
  const nonce = '99999999-2222-3333-4444-555555555555';
  const lease = spawn('python3', [join(manager.broker.directory, 'broker.py'), '--lease', manager.broker.directory], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let response = '';
  const owner = manager.broker.frame('owner-key', 'Blocked during issuer lease')!;
  let submitted = false;
  lease.stdout.on('data', (bytes) => {
    response += bytes.toString();
    if (!submitted && response.includes('"status": "ready"')) {
      submitted = true;
      manager.child.stdin.write(owner.data);
    }
  });
  lease.stderr.on('data', () => {});
  const done = new Promise<number | null>((resolve) => lease.on('close', resolve));
  lease.stdin.end(JSON.stringify({ issuer: authority, durationMs: 400, nonce }) + '\n');
  await eventually(async () =>
    fs.stat(join(manager.broker.directory, 'lease-blocked')).then(
      () => true,
      () => false
    )
  );
  expect(submitted).toBe(true);
  expect((await manager.bytes()).length).toBe(0);
  expect(await done).toBe(0);
  await fs.writeFile(join(manager.broker.directory, 'lease-retry'), 'retry');
  expect(await manager.broker.receipt(owner.receipt)).toBe('sent');
  await eventually(async () => (await manager.bytes()).length === 'Blocked during issuer lease'.length);
});

it.each(JOURNAL_CHANNELS.flatMap((channel) => [false, true].map((closed) => ({ channel, closed }))))(
  'rejects missing and stale $channel receipt heads in a closed=$closed journal',
  async ({ channel, closed }) => {
    const target = await fixture();
    await journalFrame(target, channel);
    if (closed) {
      await fs.writeFile(join(target.root, 'stop'), 'stop');
      expect(await target.done).toBe(0);
    }
    expect(await target.broker.prove(target.child.pid!)).toMatchObject({ closed });
    expect(await CodexInputBroker.load(target.broker.directory, SID)).toBeDefined();
    const path = join(target.broker.directory, 'state.json');
    const original = JSON.parse(await fs.readFile(path, 'utf8')) as CodexBrokerState;
    for (const missing of [true, false]) {
      const incomplete = structuredClone(original);
      if (missing) incomplete.receipts = incomplete.receipts.filter((receipt) => receipt.channel !== channel);
      else incomplete.counters[channel]++;
      const bytes = JSON.stringify(incomplete);
      await fs.writeFile(path, bytes);
      expect(await target.broker.readState(), missing ? 'missing channel head' : 'stale channel head').toBeUndefined();
      expect(await CodexInputBroker.load(target.broker.directory, SID)).toBeUndefined();
      expect(await target.broker.prove(target.child.pid!)).toBeUndefined();
      expect(await fs.readFile(path, 'utf8')).toBe(bytes);
    }
  }
);

it.each(JOURNAL_CHANNELS.flatMap((channel) => [true, false].map((missing) => ({ channel, missing }))))(
  'refuses a real Python issuer lease for missing=$missing $channel head despite a fresh matching file hash',
  async ({ channel, missing }) => {
    const target = await fixture(0, undefined, undefined, undefined, CID);
    await journalFrame(target, channel);
    const issuer = target.broker.authority((await target.broker.prove(target.child.pid!))!)!;
    expect(issuer).toBeDefined();
    const path = join(target.broker.directory, 'state.json');
    const state = JSON.parse(await fs.readFile(path, 'utf8')) as CodexBrokerState;
    if (missing) state.receipts = state.receipts.filter((receipt) => receipt.channel !== channel);
    else state.counters[channel]++;
    const bytes = Buffer.from(JSON.stringify(state));
    await fs.writeFile(path, bytes);
    const stat = await fs.stat(path);
    const witness: PrivateFileWitness = {
      ...issuer.proof.fileWitness!,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      hash: createHash('sha256').update(bytes).digest('hex'),
    };
    // Rebind every file and owner-counter check to these malformed bytes: the receipt-head
    // invariant, rather than an outdated hash or permission snapshot, must deny this lease.
    issuer.proof.fileWitness = witness;
    issuer.files = [witness];
    for (const owner of ['owner-pty', 'owner-key', 'owner-mux'] as const)
      issuer.proof.ownerCounters[owner] = state.counters[owner];
    const baseline = channel === 'probe' ? '' : 'Known input';
    await eventually(async () => (await target.bytes()).toString() === baseline);
    const result = await leaseDispatch(target, issuer);
    expect(result.code).not.toBe(0);
    expect(result.dispatch).not.toHaveBeenCalled();
    expect((await target.bytes()).toString()).toBe(baseline);
    expect(await fs.readFile(path)).toEqual(bytes);
  }
);

it('preserves exact receipt heads and legitimate eviction after 129 actual acknowledged frames', async () => {
  const target = await fixture(0, undefined, undefined, undefined, CID);
  await journalFrame(target, 'owner-key');
  for (let counter = 1; counter <= 128; counter++) await journalFrame(target, 'probe');
  const state = (await target.broker.readState())!;
  expect(state.receipts).toHaveLength(128);
  expect(state.counters['owner-key']).toBe(1);
  expect(state.receipts.every((receipt) => receipt.channel === 'probe')).toBe(true);
  expect(state.receipts.at(-1)).toMatchObject({ channel: 'probe', counter: 128, status: 'sent' });
  const restored = await CodexInputBroker.load(target.broker.directory, CID);
  expect(restored).toBeDefined();
  expect(await restored!.prove(target.child.pid!)).toBeDefined();
  const issuer = target.broker.authority((await target.broker.prove(target.child.pid!))!)!;
  const result = await leaseDispatch(target, issuer);
  expect(result.code).toBe(0);
  expect(result.dispatch).toHaveBeenCalledOnce();
  await eventually(async () => (await target.bytes()).toString() === 'Known inputLEASE_DISPATCH_EFFECT');
  // A full window permits an absent old channel, never a stale retained channel head.
  const path = join(target.broker.directory, 'state.json');
  const stale = JSON.parse(await fs.readFile(path, 'utf8')) as CodexBrokerState;
  stale.counters.probe++;
  await fs.writeFile(path, JSON.stringify(stale));
  expect(await target.broker.readState()).toBeUndefined();
  expect(await CodexInputBroker.load(target.broker.directory, CID)).toBeUndefined();
});

it('grants a real Python issuer lease with every exact acknowledged channel head retained', async () => {
  const target = await fixture(0, undefined, undefined, undefined, CID);
  for (const channel of ['auto', 'probe', 'owner-pty', 'owner-key', 'owner-mux'] as const)
    await journalFrame(target, channel);
  const state = (await target.broker.readState())!;
  expect(state.receipts).toHaveLength(5);
  expect(Object.values(state.counters)).toEqual([1, 1, 1, 1, 1]);
  const issuer = target.broker.authority((await target.broker.prove(target.child.pid!))!)!;
  const result = await leaseDispatch(target, issuer);
  expect(result.code).toBe(0);
  expect(result.dispatch).toHaveBeenCalledOnce();
  await eventually(async () => (await target.bytes()).toString() === `${'Known input'.repeat(4)}LEASE_DISPATCH_EFFECT`);
});

it.each(['prefix', 'signature'] as const)('restores an owner frame interrupted inside its %s', async (part) => {
  const { broker, child, bytes } = await fixture();
  const owner = broker.frame('owner-pty', 'Exact owner bytes 🧭')!;
  const key = broker.frame('owner-key', '\r')!;
  const split = part === 'prefix' ? 5 : owner.data.length - 12;
  child.stdin.write(owner.data.slice(0, split));
  child.stdin.write(key.data.slice(0, 3));
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect((await bytes()).length).toBe(0);
  child.stdin.write(key.data.slice(3));
  child.stdin.write(owner.data.slice(split));
  expect(await broker.receipt(owner.receipt)).toBe('sent');
  expect(await broker.receipt(key.receipt)).toBe('sent');
  await eventually(async () => (await bytes()).length === Buffer.byteLength('Exact owner bytes 🧭\r'));
  expect((await bytes()).toString()).toBe('Exact owner bytes 🧭\r');
});

it('does not forward private encoding from a forged nested frame', async () => {
  const { broker, child, bytes } = await fixture();
  const owner = broker.frame('owner-pty', 'Owner plaintext')!;
  const forged = '\x1eCODEMAN_INPUT_V1:private-directory-and-grant:invalid\x1f';
  child.stdin.write(owner.data.slice(0, 31) + forged + owner.data.slice(31));
  await eventually(async () => (await broker.readState())?.tainted === true);
  expect((await bytes()).length).toBe(0);
  expect(child.exitCode).toBeNull();
});

it('does not turn an expired incomplete authenticated owner frame into model input', async () => {
  const { broker, child, bytes } = await fixture();
  const owner = broker.frame('owner-pty', 'Owner plaintext')!;
  child.stdin.write(owner.data.slice(0, -1));
  await eventually(async () => (await broker.readState())?.tainted === true, 2_500);
  expect((await bytes()).length).toBe(0);
  expect(child.exitCode).toBeNull();
});

it('deduplicates a healthy manager, worker and shared grant before the unique evidence bound', async () => {
  const manager = await fixture(0, undefined, undefined, undefined, CID);
  const worker = await fixture();
  const grant = join(worker.root, 'users-grant');
  const managerTail = join(manager.root, 'rollout');
  const workerTail = join(worker.root, 'rollout');
  await Promise.all([
    fs.writeFile(grant, 'granted'),
    fs.writeFile(managerTail, 'manager evidence'),
    fs.writeFile(workerTail, 'worker evidence'),
  ]);
  const grantFile = await witness(grant);
  const managerLeaf = await witness(managerTail);
  const workerLeaf = await witness(workerTail);
  const authority = manager.broker.authority((await manager.broker.prove(manager.child.pid!))!)!;
  authority.files = [...authority.files!, managerLeaf, grantFile];
  const proof = (await worker.broker.prove(worker.child.pid!))!;
  const files = [proof.fileWitness!, workerLeaf, grantFile, ...authority.files!];
  const frame = worker.broker.frame('auto', 'Healthy combined authority', CID, authority, files, proof.ownerCounters)!;
  worker.child.stdin.write(frame.data);
  expect(await worker.broker.receipt(frame.receipt)).toBe('sent');
  await eventually(async () => (await worker.bytes()).length === 'Healthy combined authority'.length);
});

it.each([0, 200])('rejects impossible closed child signal %i without granting restart proof', async (exitSignal) => {
  const { broker, child } = await fixture();
  const state = (await broker.readState())!;
  const altered = { ...state, closed: true, exitStatus: null, exitSignal };
  const path = join(broker.directory, 'state.json');
  const bytes = JSON.stringify(altered);
  await fs.writeFile(path, bytes);
  expect(await broker.prove(child.pid!)).toBeUndefined();
  expect((await fs.readFile(path)).toString()).toBe(bytes);
});

it('rejects stopped owned children for local input and issuer authority, then accepts healthy resumed proof', async () => {
  const manager = await fixture(0, undefined, undefined, undefined, CID);
  const worker = await fixture();
  const proof = (await manager.broker.prove(manager.child.pid!))!;
  const authority = manager.broker.authority(proof)!;
  process.kill(proof.childPid, 'SIGSTOP');
  try {
    await eventually(async () => (await manager.broker.prove(manager.child.pid!)) === undefined);
    const local = manager.broker.frame('auto', 'Forbidden stopped manager', CID, undefined, [], proof.ownerCounters)!;
    manager.child.stdin.write(local.data);
    expect(await manager.broker.receipt(local.receipt)).toBe('not-sent');
    const remote = worker.broker.frame('auto', 'Forbidden stopped issuer', CID, authority, [], OWNERS)!;
    worker.child.stdin.write(remote.data);
    expect(await worker.broker.receipt(remote.receipt)).toBe('not-sent');
    expect((await manager.bytes()).length).toBe(0);
    expect((await worker.bytes()).length).toBe(0);
  } finally {
    process.kill(proof.childPid, 'SIGCONT');
  }
  await eventually(async () => (await manager.broker.prove(manager.child.pid!)) !== undefined);
});

it.each((['worker', 'issuer'] as const).flatMap((scope) => [false, true].map((exited) => ({ scope, exited }))))(
  'rechecks clean $scope exit=$exited after the held final private evidence read',
  async ({ scope, exited }) => {
    const manager = scope === 'issuer' ? await fixture(0, undefined, undefined, undefined, CID) : undefined;
    const worker = await fixture(
      0,
      (source) =>
        source.replace(
          "current, _ = snapshot(witness['path'], witness['maxBytes'])",
          "if witness['path'].endswith('held-final-evidence'):\n            with open(witness['path'] + '.entered', 'w') as marker: marker.write('entered')\n            while not os.path.exists(witness['path'] + '.release'): time.sleep(.001)\n        current, _ = snapshot(witness['path'], witness['maxBytes'])"
        ),
      scope === 'worker'
        ? (source) =>
            source.replace(
              "while not os.path.exists(os.path.join(root, 'stop')):",
              "import signal\nsignal.signal(signal.SIGHUP, signal.SIG_IGN)\nwhile not os.path.exists(os.path.join(root, 'stop')):\n    if os.path.exists(os.path.join(root, 'exit-parent')):\n        if os.fork(): sys.exit(0)\n        os.unlink(os.path.join(root, 'exit-parent'))"
            )
        : undefined
    );
    const proof = manager && (await manager.broker.prove(manager.child.pid!))!;
    const authority = proof && manager!.broker.authority(proof);
    const target = manager ?? worker;
    const originalChild = (await target.broker.readState())!;
    expect(originalChild.closed).toBe(false);
    expect(originalChild.childPid).toBeGreaterThan(0);
    expect(originalChild.childStart).toMatch(/^[1-9]\d*$/);
    const nativeChild = async () => {
      const stat = await fs.readFile(`/proc/${originalChild.childPid}/stat`, 'utf8');
      const fields = stat
        .slice(stat.lastIndexOf(') ') + 2)
        .trim()
        .split(/\s+/);
      return { birth: fields[19], state: fields[0] };
    };
    expect(await nativeChild()).toMatchObject({ birth: originalChild.childStart });
    expect(['Z', 'X', 'x']).not.toContain((await nativeChild()).state);
    const path = join(worker.root, 'held-final-evidence');
    await fs.writeFile(path, 'unchanged');
    const text = 'Guarded clean-exit bytes';
    const deadline = Number(process.hrtime.bigint() / 1_000_000n) + 2_000;
    const frame = worker.broker.frame('auto', text, CID, authority, [await witness(path)], OWNERS, [], [], deadline)!;
    worker.child.stdin.write(frame.data);
    await eventually(async () =>
      fs.stat(path + '.entered').then(
        () => true,
        () => false
      )
    );
    expect((await worker.broker.readState())?.receipts).toContainEqual(
      expect.objectContaining({ nonce: frame.receipt.nonce, status: 'reserved' })
    );
    try {
      if (exited) {
        await fs.writeFile(join(target.root, scope === 'issuer' ? 'stop' : 'exit-parent'), 'exit');
        // The held evidence job need not let the broker publish its exit journal yet.
        // Observe actual death of the exact native PID/birth before releasing that job.
        await eventually(async () => {
          try {
            const current = await nativeChild();
            return current.birth === originalChild.childStart && ['Z', 'X', 'x'].includes(current.state);
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === 'ENOENT';
          }
        });
      }
      expect(Number(process.hrtime.bigint() / 1_000_000n)).toBeLessThan(deadline);
    } finally {
      await fs.writeFile(path + '.release', 'release');
    }
    const receipt = await worker.broker.receipt(frame.receipt);
    if (exited) {
      expect(['not-sent', 'unknown']).toContain(receipt);
      expect((await worker.bytes()).length).toBe(0);
    } else {
      expect(receipt).toBe('sent');
      await eventually(async () => (await worker.bytes()).length === text.length);
      expect((await worker.bytes()).toString()).toBe(text);
    }
    expect(worker.child.exitCode).toBeNull();
  }
);

it('refuses an unchanged automatic frame after its signed original monotonic expiry', async () => {
  const { broker, child, bytes } = await fixture();
  const deadline = Number(process.hrtime.bigint() / 1_000_000n) + 50;
  const frame = broker.frame('auto', 'Forbidden delayed frame', CID, undefined, [], OWNERS, [], [], deadline)!;
  await new Promise((resolve) => setTimeout(resolve, 80));
  child.stdin.write(frame.data);
  expect(await broker.receipt(frame.receipt)).toBe('not-sent');
  expect((await bytes()).length).toBe(0);
});

it('starts a fresh guarded worker from the exact observed manager journal', async () => {
  const manager = await fixture(0, undefined, undefined, undefined, CID);
  const probe = manager.broker.frame('probe', '')!;
  manager.child.stdin.write(probe.data);
  expect(await manager.broker.receipt(probe.receipt)).toBe('sent');
  const proof = (await manager.broker.prove(manager.child.pid!))!;
  const authority = manager.broker.authority(proof)!;
  const worker = await fixture(0, undefined, undefined, async (codec) => {
    await codec.setStartupAuthority(authority.files!, authority);
  });
  expect(await worker.broker.startupReceipt(worker.child.pid!)).toBe('started');
  expect((await worker.broker.readState())?.childPid).toBeGreaterThan(0);
  expect((await worker.bytes()).length).toBe(0);
});

it('refuses owner framing until an exact ready startup state has been read', async () => {
  const root = await fs.mkdtemp(join(homedir(), 'owner-framing-readiness-'));
  try {
    const codec = await CodexInputBroker.create(join(root, 'control'), SID, 'unused owner launch', root);
    expect(codec.canFrame).toBe(false);
    expect(codec.frame('owner-pty', 'Early owner paste')).toBeUndefined();
    expect(await codec.readState()).toBeUndefined();
    expect(codec.canFrame).toBe(false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('keeps an expired partial protocol prefix out of the child input', async () => {
  const { broker, child, bytes } = await fixture();
  const owner = broker.frame('owner-pty', 'Private owner payload')!;
  child.stdin.write(owner.data.slice(0, 9));
  await eventually(async () => (await broker.readState())?.tainted === true, 2_500);
  expect((await bytes()).length).toBe(0);
  expect(child.exitCode).toBeNull();
});

it('preserves a 64KiB owner paste before a delayed child initializes its own raw terminal', async () => {
  const input = 'p'.repeat(65_536);
  const result = await fixture(
    0,
    undefined,
    (source) =>
      source.replace('tty.setraw(0, termios.TCSANOW)', 'import time\ntime.sleep(.5)\ntty.setraw(0, termios.TCSANOW)'),
    undefined,
    SID,
    async (codec, child) => {
      expect(await codec.startupReceipt(child.pid!)).toBe('started');
      const owner = codec.frame('owner-pty', input)!;
      child.stdin.write(owner.data);
      expect(await codec.receipt(owner.receipt)).toBe('sent');
    }
  );
  await eventually(async () => (await result.bytes()).length === input.length);
  expect((await result.bytes()).toString()).toBe(input);
});

it.each(['version', 'nonce'] as const)(
  'refuses authenticated malformed packet %s before child bytes',
  async (change) => {
    const { broker, child, bytes } = await fixture();
    const owner = broker.frame('owner-key', 'Forbidden malformed packet')!;
    const encoded = owner.data.split(':')[1];
    const packet = JSON.parse(Buffer.from(encoded, 'base64').toString());
    if (change === 'version') packet.version = true;
    else packet.nonce = 'x'.repeat(36);
    const altered = Buffer.from(JSON.stringify(packet)).toString('base64');
    const config = JSON.parse(await fs.readFile(join(broker.directory, 'config.json'), 'utf8'));
    const mac = createHmac('sha256', Buffer.from(config.secret, 'hex')).update(altered).digest('hex');
    child.stdin.write(`\x1eCODEMAN_INPUT_V1:${altered}:${mac}\x1f`);
    await eventually(async () => (await broker.readState())?.tainted === true);
    expect((await bytes()).length).toBe(0);
  }
);

it('rejects a boolean startup version before any owned child starts', async () => {
  const root = await fs.mkdtemp(join(homedir(), 'startup-schema-refusal-'));
  const marker = join(root, 'child-started');
  const codec = await CodexInputBroker.create(join(root, 'control'), SID, `printf child > ${quote(marker)}`, root);
  const path = join(codec.directory, 'config.json');
  const config = JSON.parse(await fs.readFile(path, 'utf8'));
  config.version = true;
  await fs.writeFile(path, JSON.stringify(config), { mode: 0o600 });
  const child = spawn(
    'python3',
    [
      join(codec.directory, 'broker.py'),
      codec.directory,
      createHash('sha256').update(JSON.stringify(config)).digest('hex'),
    ],
    {
      env: { ...process.env, CODEX_HOME: root },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  const done = new Promise<number | null>((resolve) => child.on('close', resolve));
  running.push({ child, root, done });
  expect(await done).toBe(1);
  expect(await codec.readState()).toBeUndefined();
  await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(JSON.parse(await fs.readFile(path, 'utf8')).version).toBe(true);
});

it('continues child output while a lock open exceeds the original input deadline', async () => {
  const { broker, child, root, bytes, output } = await fixture(
    0,
    (source) =>
      source.replace(
        'fd = os.open(lock_path, os.O_RDWR',
        "if os.path.exists(os.path.join(directory, 'hold-lock-open')): time.sleep(3)\n                    fd = os.open(lock_path, os.O_RDWR"
      ),
    (source) =>
      source.replace(
        "while not os.path.exists(os.path.join(root, 'stop')):",
        "while not os.path.exists(os.path.join(root, 'stop')):\n    os.write(1, b'heartbeat\\n')"
      )
  );
  await fs.writeFile(join(broker.directory, 'hold-lock-open'), 'hold');
  const frame = broker.frame('auto', 'Forbidden delayed lock', CID, undefined, [], OWNERS)!;
  child.stdin.write(frame.data);
  const before = output().length;
  expect(await broker.receipt(frame.receipt)).toBe('unknown');
  expect(output().length).toBeGreaterThan(before + 100);
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  expect((await bytes()).length).toBe(0);
  expect(child.exitCode).toBeNull();
  await fs.unlink(join(broker.directory, 'hold-lock-open'));
  await fs.writeFile(join(root, 'stop'), 'stop');
});

it('latches an unobserved owner cursor ahead of the cached signer and never catches up by replay', async () => {
  const { broker, child, bytes } = await fixture();
  const original = (await broker.prove(child.pid!))!;
  const otherSigner = (await CodexInputBroker.load(broker.directory, SID))!;
  const unobserved = otherSigner.frame('owner-key', '/resume unobserved-owner\r')!;
  child.stdin.write(unobserved.data);
  expect(await otherSigner.receipt(unobserved.receipt)).toBe('sent');
  expect(await broker.prove(child.pid!)).toBeUndefined();
  expect(broker.authority(original)).toBeUndefined();
  expect(broker.canFrame).toBe(false);
  expect(broker.frame('owner-key', 'Cannot catch up')).toBeUndefined();
  await broker.readState();
  expect(broker.canFrame).toBe(false);
  await eventually(async () => (await bytes()).length === '/resume unobserved-owner\r'.length);
  expect((await bytes()).toString()).toBe('/resume unobserved-owner\r');
});

it('keeps output alive and disables later input after one lock-close failure', async () => {
  const { broker, child, bytes, output } = await fixture(
    0,
    (source) =>
      source.replace(
        'try: os.close(fd)\n                    except OSError:',
        "try:\n                        os.close(fd)\n                        if os.path.exists(os.path.join(directory, 'fail-close')): raise OSError('fixture close acknowledgement')\n                    except OSError:"
      ),
    (source) =>
      source.replace(
        "while not os.path.exists(os.path.join(root, 'stop')):",
        "while not os.path.exists(os.path.join(root, 'stop')):\n    os.write(1, b'heartbeat\\n')"
      )
  );
  await fs.writeFile(join(broker.directory, 'fail-close'), 'fail');
  const first = broker.frame('owner-key', 'First owner bytes')!;
  child.stdin.write(first.data);
  expect(await broker.receipt(first.receipt)).toBe('sent');
  await eventually(async () => (await bytes()).length === 'First owner bytes'.length);
  const second = broker.frame('owner-key', 'Forbidden later bytes')!;
  child.stdin.write(second.data);
  const before = output().length;
  expect(await broker.receipt(second.receipt)).toBe('unknown');
  expect((await bytes()).toString()).toBe('First owner bytes');
  expect(output().length).toBeGreaterThan(before);
  expect(child.exitCode).toBeNull();
});

it('starts under a real outer terminal and sizes the child after its PTY exists', async () => {
  const root = await fs.mkdtemp(join(homedir(), 'broker-real-tty-'));
  let terminal: nodePty.IPty | undefined;
  let exited = false;
  try {
    const childPath = join(root, 'fake-terminal-child.py');
    await fs.writeFile(
      childPath,
      `import fcntl, os, struct, termios, time
end = time.monotonic() + 2
while time.monotonic() < end:
    rows, cols, _, _ = struct.unpack('HHHH', fcntl.ioctl(0, termios.TIOCGWINSZ, b'\\0' * 8))
    if (rows, cols) == (30, 100): break
    time.sleep(.01)
os.write(1, ('FAKE_TTY_READY:%s:%s\\n' % (rows, cols)).encode())
`
    );
    const broker = await CodexInputBroker.create(join(root, 'control'), SID, `exec python3 ${quote(childPath)}`, root);
    terminal = nodePty.spawn(
      'python3',
      [join(broker.directory, 'broker.py'), broker.directory, broker.configurationDigest],
      {
        name: 'xterm-256color',
        cols: 100,
        rows: 30,
        cwd: root,
        env: { ...process.env, CODEX_HOME: root },
      }
    );
    let output = '';
    terminal.onData((data) => {
      output += data;
    });
    const done = new Promise<number>((resolve) =>
      terminal!.onExit(({ exitCode }) => {
        exited = true;
        resolve(exitCode);
      })
    );
    const exitCode = await Promise.race([
      done,
      new Promise<never>((_, reject) => setTimeout(() => reject(Error('Fake terminal child timed out')), 4000)),
    ]);
    expect(output).toContain('FAKE_TTY_READY:30:100');
    expect(output).not.toContain('input reliability guard unavailable');
    expect(exitCode).toBe(0);
    const state = await broker.readState();
    expect(state?.startup.status).toBe('started');
    expect(state?.closed).toBe(true);
    expect(state?.exitStatus).toBe(0);
  } finally {
    if (terminal && !exited) terminal.kill(); // Disposable fake child only.
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('admits only bounded terminal replies paired with fresh child queries, including fragments', async () => {
  const { broker, child, bytes } = await fixture(0, undefined, (source) =>
    source.replace(
      "os.write(1, b'FAKE_CHILD_READY\\n')",
      "os.write(1, b'\\x1b[c\\x1b[6n\\x1b]11;?\\x07FAKE_CHILD_READY\\n')"
    )
  );
  const replies = ['\x1b[?1;2c', '\x1b[12;4R', '\x1b]11;rgb:0000/1111/ffff\x1b\\'];
  for (const reply of replies) {
    child.stdin.write(reply.slice(0, 2));
    await new Promise((resolve) => setTimeout(resolve, 10));
    child.stdin.write(reply.slice(2));
  }
  await eventually(async () => (await bytes()).toString() === replies.join(''));
  expect(await broker.prove(child.pid!)).toMatchObject({ rawGeneration: 0 });
  child.stdin.write(replies[0]); // A replay has no pending query.
  await eventually(async () => (await broker.readState())?.tainted === true);
  expect(await broker.prove(child.pid!)).toBeUndefined();
});

it.each(['\x1b[12;4R', '/resume unsafe\r', '\x1b[?1;2c/resume unsafe\r'])(
  'retains the raw-input veto for unpaired or mixed input %j',
  async (data) => {
    const { broker, child } = await fixture(0, undefined, (source) =>
      source.replace("os.write(1, b'FAKE_CHILD_READY\\n')", "os.write(1, b'\\x1b[cFAKE_CHILD_READY\\n')")
    );
    child.stdin.write(data);
    await eventually(async () => (await broker.readState())?.tainted === true);
    expect(await broker.prove(child.pid!)).toBeUndefined();
  }
);

it.each(['', '0'])('accepts a single primary device reply for CSI %s c only once', async (parameter) => {
  const { broker, child, bytes } = await fixture(0, undefined, (source) =>
    source.replace("os.write(1, b'FAKE_CHILD_READY\\n')", `os.write(1, b'\\x1b[${parameter}cFAKE_CHILD_READY\\n')`)
  );
  child.stdin.write('\x1b[?1;2c');
  await eventually(async () => (await bytes()).toString() === '\x1b[?1;2c');
  expect(await broker.prove(child.pid!)).toMatchObject({ rawGeneration: 0 });
  child.stdin.write('\x1b[?1;2c');
  await eventually(async () => (await broker.readState())?.tainted === true);
  expect(await broker.prove(child.pid!)).toBeUndefined();
});

it('does not authorize a primary device reply for an unsupported parameter', async () => {
  const { broker, child } = await fixture(0, undefined, (source) =>
    source.replace("os.write(1, b'FAKE_CHILD_READY\\n')", "os.write(1, b'\\x1b[1cFAKE_CHILD_READY\\n')")
  );
  child.stdin.write('\x1b[?1;2c');
  await eventually(async () => (await broker.readState())?.tainted === true);
  expect(await broker.prove(child.pid!)).toBeUndefined();
});

it('does not accept a terminal reply after its query expires', async () => {
  const { broker, child } = await fixture(
    0,
    (source) => source.replace('now + 2)', 'now - 1)'),
    (source) => source.replace("os.write(1, b'FAKE_CHILD_READY\\n')", "os.write(1, b'\\x1b[cFAKE_CHILD_READY\\n')")
  );
  child.stdin.write('\x1b[?1;2c');
  await eventually(async () => (await broker.readState())?.tainted === true);
  expect(await broker.prove(child.pid!)).toBeUndefined();
});

it('admits native focus notifications only while the exact child enables mode1004, including fragments', async () => {
  const { broker, child, bytes } = await fixture(0, undefined, (source) =>
    source.replace(
      "os.write(1, b'FAKE_CHILD_READY\\n')",
      "os.write(1, b'\\x1b[?10'); os.write(1, b'04hFAKE_CHILD_READY\\n')"
    )
  );
  for (const report of ['\x1b[I', '\x1b[O', '\x1b[I']) {
    child.stdin.write(report.slice(0, 2));
    await new Promise((resolve) => setTimeout(resolve, 10));
    child.stdin.write(report.slice(2));
  }
  await eventually(async () => (await bytes()).toString() === '\x1b[I\x1b[O\x1b[I');
  expect(await broker.prove(child.pid!)).toMatchObject({ rawGeneration: 0 });
  const frame = broker.frame('auto', 'Known input', CID, undefined, [], OWNERS)!;
  child.stdin.write(frame.data);
  expect(await broker.receipt(frame.receipt)).toBe('sent');
});

it.each(['\x1b[I', '\x1b[O'])('keeps unsolicited or disabled focus reports tainted: %j', async (report) => {
  for (const mode of ['', '\\x1b[?1004h\\x1b[?1004l']) {
    const { broker, child } = await fixture(0, undefined, (source) =>
      source.replace("os.write(1, b'FAKE_CHILD_READY\\n')", `os.write(1, b'${mode}FAKE_CHILD_READY\\n')`)
    );
    child.stdin.write(report);
    await eventually(async () => (await broker.readState())?.tainted === true);
    expect(await broker.prove(child.pid!)).toBeUndefined();
  }
});

it.each(['/resume unsafe\r', '\x1b[<0;1;1M', '\x1b[IX', '\x1b[200~unsafe\x1b[201~'])(
  'retains the raw-input veto for arbitrary or mixed bytes while focus reporting is enabled: %j',
  async (data) => {
    const { broker, child } = await fixture(0, undefined, (source) =>
      source.replace("os.write(1, b'FAKE_CHILD_READY\\n')", "os.write(1, b'\\x1b[?1004hFAKE_CHILD_READY\\n')")
    );
    child.stdin.write(data);
    await eventually(async () => (await broker.readState())?.tainted === true);
    expect(await broker.prove(child.pid!)).toBeUndefined();
  }
);

it('revokes focus reporting immediately when the live child disables1004', async () => {
  const f = await fixture(0, undefined, (source) =>
    source
      .replace("os.write(1, b'FAKE_CHILD_READY\\n')", "os.write(1, b'\\x1b[?1004hFAKE_CHILD_READY\\n')")
      .replace(
        "while not os.path.exists(os.path.join(root, 'stop')):",
        "while not os.path.exists(os.path.join(root, 'stop')):\n    if os.path.exists(os.path.join(root, 'disable-focus')):\n        os.unlink(os.path.join(root, 'disable-focus'))\n        os.write(1, b'\\x1b[?1004lFOCUS_DISABLED\\n')"
      )
  );
  f.child.stdin.write('\x1b[I');
  await eventually(async () => (await f.bytes()).toString() === '\x1b[I');
  expect(await f.broker.prove(f.child.pid!)).toMatchObject({ rawGeneration: 0 });
  await fs.writeFile(join(f.root, 'disable-focus'), 'disable');
  await eventually(async () => f.output().includes('FOCUS_DISABLED'));
  f.child.stdin.write('\x1b[O');
  await eventually(async () => (await f.broker.readState())?.tainted === true);
  expect(await f.broker.prove(f.child.pid!)).toBeUndefined();
});
