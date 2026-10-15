/** Real manager and frame codec, recording child pipes only; never a native pane or process. */
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, afterEach, expect, it, vi } from 'vitest';
import { CodexInputBroker } from '../src/recovery/codex-input-broker.js';
import type { MuxSession, RecoveryMuxDispatchGuard } from '../src/mux-interface.js';
import type { TmuxManager as Manager } from '../src/tmux-manager.js';
import { fakeInputProvenance } from './helpers/codex-input-provenance.js';

const native = vi.hoisted(() => ({ command: vi.fn(), file: vi.fn(), capture: vi.fn() }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const exec = () => {
    throw new Error('Uninjected process forbidden');
  };
  Object.defineProperty(exec, Symbol.for('nodejs.util.promisify.custom'), { value: native.command });
  return {
    ...actual,
    exec,
    execSync: native.capture,
    execFile: native.file,
    spawn: () => {
      throw new Error('Uninjected process forbidden');
    },
  };
});

let TmuxManager: typeof import('../src/tmux-manager.js').TmuxManager;
beforeAll(async () => {
  const previous = process.env.VITEST;
  delete process.env.VITEST;
  try {
    ({ TmuxManager } = await import('../src/tmux-manager.js'));
  } finally {
    if (previous !== undefined) process.env.VITEST = previous;
  }
});

const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CID = '11111111-2222-3333-4444-555555555555';
const PROMPT = 'Private owner task 🧭';
let root: string;
let screen: string;
let paneId: string;
let panePid: number;
let dead: boolean;
let authorized: boolean;
let onLoad: (() => Promise<void>) | undefined;
let onCapture: (() => void) | undefined;
let pipeError: Error | undefined;
let loadOutput: string;
let pasteOutput: string;
let losePasteReply: boolean;
const buffers = new Map<string, string>();
const loaded: { name: string; data: string }[] = [];
const chunks: string[] = [];
const receipts = new Map<string, 'sent' | 'not-sent'>();
const trace: string[] = [];
const kills = vi.fn();

beforeEach(async () => {
  root = await fs.mkdtemp(join(homedir(), 'private-mux-pipe-'));
  screen = '›\n  fixture-model high · /tmp\n';
  paneId = '%7';
  panePid = 700;
  dead = false;
  authorized = true;
  onLoad = undefined;
  onCapture = undefined;
  pipeError = undefined;
  loadOutput = '';
  pasteOutput = '';
  losePasteReply = false;
  buffers.clear();
  buffers.set('unrelated-owner-buffer', 'Keep this buffer');
  loaded.length = chunks.length = trace.length = 0;
  receipts.clear();
  kills.mockReset();
  native.capture.mockReset().mockImplementation((command: string) => {
    if (command.includes('display-message')) return `codeman-aaaaaaaa|${paneId}|${panePid}|${dead ? 1 : 0}||\n`;
    if (command.includes('capture-pane')) {
      onCapture?.();
      return screen;
    }
    throw new Error('Unexpected native read');
  });
  native.file
    .mockReset()
    .mockImplementation(
      (
        binary: string,
        argv: string[],
        options: { timeout: number },
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        expect(binary).toBe('tmux');
        expect(argv.slice(0, 4)).toEqual(['-L', 'private-fixture', 'load-buffer', '-b']);
        expect(argv).toHaveLength(6);
        expect(argv[5]).toBe('-');
        expect(argv).not.toContain('-w');
        expect(options.timeout).toBeGreaterThan(0);
        expect(options.timeout).toBeLessThanOrEqual(2000);
        const pipe = new EventEmitter();
        Object.assign(pipe, {
          end(data: string) {
            trace.push('load');
            loaded.push({ name: argv[4], data });
            void (async () => {
              if (pipeError) pipe.emit('error', pipeError);
              try {
                await onLoad?.();
                buffers.set(argv[4], data);
                trace.push('load-close');
                callback(null, loadOutput, '');
              } catch (error) {
                trace.push('load-close');
                callback(error as Error, '', '');
              }
            })();
          },
        });
        return { stdin: pipe, kill: kills };
      }
    );
  native.command.mockReset().mockImplementation(async (command: string) => {
    if (!command.includes('paste-buffer') && command.includes('delete-buffer')) {
      const name = command.match(/codeman-private-[a-f0-9-]+/)![0];
      trace.push('cleanup');
      buffers.delete(name);
      return { stdout: '', stderr: '' };
    }
    if (command.includes('display-message') && !command.includes('if-shell')) {
      trace.push('native');
      return { stdout: `codeman-aaaaaaaa|${paneId}|${panePid}|${dead ? 1 : 0}||\n`, stderr: '' };
    }
    expect(command).toContain('if-shell -F -t');
    expect(command).toContain('paste-buffer -r -d -b');
    expect(command).not.toContain('paste-buffer -p');
    const name = command.match(/codeman-private-[a-f0-9-]+/)![0];
    const expected: Record<string, string> = {
      session_name: 'codeman-aaaaaaaa',
      pane_id: paneId,
      pane_pid: String(panePid),
      pane_dead: dead ? '1' : '0',
      pane_dead_status: '',
      pane_dead_signal: '',
    };
    const terms = [...command.matchAll(/#\{==:#\{([^}]+)\},([^}]*)\}/g)];
    expect(terms).toHaveLength(6);
    trace.push('paste');
    const wire = buffers.get(name);
    buffers.delete(name);
    if (!terms.every((term) => expected[term[1]] === term[2]))
      return { stdout: 'CODEMAN_RECOVERY_PANE_REFUSED\n', stderr: '' };
    expect(wire).toBeDefined();
    const packet = JSON.parse(Buffer.from(wire!.split(':')[1], 'base64').toString());
    const data = Buffer.from(packet.data, 'base64').toString();
    receipts.set(packet.nonce, 'sent');
    if (packet.channel !== 'probe') chunks.push(data);
    screen = data === '\r' ? '›\n  fixture-model high · /tmp\n' : `› ${data}\n  fixture-model high · /tmp\n`;
    if (losePasteReply) throw new Error('Fixture paste acknowledgement lost');
    return { stdout: pasteOutput, stderr: '' };
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

function fixture() {
  const material = CodexInputBroker.provisioningMaterial(ID, 'Explicit fixture worker', root);
  const proof = fakeInputProvenance({ incarnation: material.config.incarnation, brokerPid: 700, childPid: 701 }, root);
  const broker = CodexInputBroker.fromRemoteMaterial(join(root, 'broker'), material, {
    version: 1,
    sessionId: ID,
    incarnation: material.config.incarnation,
    pid: 700,
    childPid: 701,
    brokerStart: proof.brokerStart,
    childStart: proof.childStart,
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
  })!;
  expect(broker).toBeDefined();
  vi.spyOn(broker, 'prove').mockResolvedValue(proof);
  vi.spyOn(broker, 'receipt').mockImplementation(async (receipt) => receipts.get(receipt.nonce) ?? 'unknown');
  const manager = Object.create(TmuxManager.prototype) as Manager;
  const record = {
    sessionId: ID,
    muxName: 'codeman-aaaaaaaa',
    pid: 700,
    recoveryInputBroker: broker.incarnation,
  } as MuxSession;
  Reflect.set(manager, 'sessions', new Map([[ID, record]]));
  Reflect.set(manager, 'inputBrokers', new Map([[ID, broker]]));
  Reflect.set(manager, 'inputBrokerLoads', new Map());
  Reflect.set(manager, 'inputQueues', new Map());
  Reflect.set(manager, 'tmuxSocket', 'private-fixture');
  const guard: RecoveryMuxDispatchGuard = {
    conversationId: CID,
    expectedLivePane: { paneId: '%7', panePid: 700 },
    inputProof: proof,
    privateFiles: [proof.fileWitness!],
    privatePaths: [],
    confirm: () => authorized,
    prepareEvidence: async () => authorized,
    noteDispatch: vi.fn(),
    noteRefusal: vi.fn(),
    noteBrokerSent: vi.fn(),
    noteBrokerRefusal: vi.fn(),
  };
  return { manager, broker, record, guard };
}

function assertPrivateArguments() {
  const argumentsText = JSON.stringify([
    native.command.mock.calls,
    native.file.mock.calls.map((call) => call.slice(0, 3)),
  ]);
  const privateTokens = loaded.flatMap((entry) => {
    const encoded = entry.data.split(':')[1];
    const packet = JSON.parse(Buffer.from(encoded, 'base64').toString());
    return [entry.data, encoded, ...packet.privateFiles.map((file: { path: string }) => file.path)];
  });
  for (const secret of [PROMPT, root, 'CODEMAN_INPUT_V1', ...privateTokens])
    expect(argumentsText).not.toContain(secret);
  expect(new Set(loaded.map((entry) => entry.name)).size).toBe(loaded.length);
  expect([...buffers.entries()]).toEqual([['unrelated-owner-buffer', 'Keep this buffer']]);
}

it.each(['automatic', 'owner'] as const)('pipes private %s literal and Enter frames independently', async (kind) => {
  const f = fixture();
  const delivered = await f.manager.sendInput(ID, `${PROMPT}\r`, kind === 'automatic' ? f.guard : undefined);
  assertPrivateArguments();
  expect(delivered).toBe(true);
  expect(chunks).toEqual([PROMPT, '\r']);
  expect(loaded).toHaveLength(2);
  expect(trace.filter((stage) => stage !== 'native')).toEqual([
    'load',
    'load-close',
    'paste',
    'load',
    'load-close',
    'paste',
  ]);
});

it.each(['authority', 'record', 'native-id', 'draft', 'approval', 'expired', 'wall-expired'] as const)(
  'rechecks %s after the actual private load await',
  async (change) => {
    const f = fixture();
    let release!: () => void;
    onLoad = () => new Promise<void>((resolve) => (release = resolve));
    const sending = f.manager.sendInput(ID, `${PROMPT}\r`, f.guard);
    await vi.waitFor(() => expect(loaded).toHaveLength(1));
    expect(chunks).toEqual([]);
    expect(f.guard.noteDispatch).not.toHaveBeenCalled();
    if (change === 'authority') authorized = false;
    if (change === 'record') Reflect.get(f.manager, 'sessions').set(ID, { ...f.record });
    if (change === 'native-id') paneId = '%8';
    if (change === 'draft') screen = '› New owner draft\n';
    if (change === 'approval') screen = 'Would you like to approve this?\n' + screen;
    if (change === 'expired') {
      const now = process.hrtime.bigint();
      vi.spyOn(process.hrtime, 'bigint').mockReturnValue(now + 3_000_000_000n);
    }
    if (change === 'wall-expired') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3000);
    release();
    expect(await sending).toBe(false);
    expect(chunks).toEqual([]);
    expect(f.guard.noteDispatch).not.toHaveBeenCalled();
    expect(f.guard.noteRefusal).toHaveBeenCalled();
    expect(trace).not.toContain('paste');
    assertPrivateArguments();
    if (change === 'expired' || change === 'wall-expired')
      expect(native.command.mock.calls.at(-1)![1].timeout).toBeLessThanOrEqual(150);
  }
);

it.each(['dead', 'wrong-pid'] as const)(
  'refuses an initially %s controlled owner pane before loading',
  async (change) => {
    const f = fixture();
    if (change === 'dead') dead = true;
    else panePid = 701;
    expect(await f.manager.sendInput(ID, `${PROMPT}\r`)).toBe(false);
    expect(loaded).toEqual([]);
    expect(chunks).toEqual([]);
    expect(trace).toEqual(['native']);
    assertPrivateArguments();
  }
);

it('checks the original wall deadline again after the final synchronous composer capture', async () => {
  const f = fixture();
  onLoad = async () => {
    onCapture = () => {
      onCapture = undefined;
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3000);
    };
  };
  expect(await f.manager.sendInput(ID, `${PROMPT}\r`, f.guard)).toBe(false);
  expect(loaded).toHaveLength(1);
  expect(chunks).toEqual([]);
  expect(trace).not.toContain('paste');
  expect(f.guard.noteDispatch).not.toHaveBeenCalled();
  assertPrivateArguments();
});

it('pins the native owner destination before loading and rejects a replaced pane at paste', async () => {
  const f = fixture();
  onLoad = async () => {
    paneId = '%8';
  };
  expect(await f.manager.sendInput(ID, `${PROMPT}\r`)).toBe(false);
  expect(chunks).toEqual([]);
  expect(trace).toEqual(['native', 'load', 'load-close', 'paste']);
  assertPrivateArguments();
});

it.each(['lost-load', 'load-output'] as const)(
  'refuses %s before pane dispatch and deletes only its own buffer',
  async (change) => {
    const f = fixture();
    if (change === 'lost-load')
      onLoad = async () => {
        buffers.set(loaded[0].name, loaded[0].data);
        throw new Error('Fixture lost load acknowledgement');
      };
    else loadOutput = 'Unexpected load acknowledgement';
    expect(await f.manager.sendInput(ID, `${PROMPT}\r`, f.guard)).toBe(false);
    expect(chunks).toEqual([]);
    expect(f.guard.noteDispatch).not.toHaveBeenCalled();
    expect(f.guard.noteRefusal).toHaveBeenCalled();
    assertPrivateArguments();
  }
);

it('waits for a failed stdin client to close before deleting a late loaded buffer', async () => {
  const f = fixture();
  let release!: () => void;
  pipeError = new Error('Fixture pipe error');
  onLoad = () => new Promise<void>((resolve) => (release = resolve));
  const sending = f.manager.sendInput(ID, `${PROMPT}\r`, f.guard);
  await vi.waitFor(() => expect(kills).toHaveBeenCalledOnce());
  expect(trace).toEqual(['load']);
  expect(chunks).toEqual([]);
  release();
  expect(await sending).toBe(false);
  expect(trace).toEqual(['load', 'load-close', 'cleanup']);
  expect(f.guard.noteDispatch).not.toHaveBeenCalled();
  assertPrivateArguments();
});

it.each(['lost-paste', 'paste-output'] as const)(
  'keeps %s uncertain without sending Enter or replaying text',
  async (change) => {
    const f = fixture();
    if (change === 'lost-paste') losePasteReply = true;
    else pasteOutput = 'Unexpected paste acknowledgement';
    expect(await f.manager.sendInput(ID, `${PROMPT}\r`, f.guard)).toBe(false);
    expect(chunks).toEqual([PROMPT]);
    expect(loaded).toHaveLength(1);
    expect(f.guard.noteDispatch).toHaveBeenCalledOnce();
    expect(f.guard.noteBrokerSent).not.toHaveBeenCalled();
    assertPrivateArguments();
  }
);

it('uses the same private pipe and guarded native paste for a zero-child-byte probe', async () => {
  const f = fixture();
  expect(await f.manager.inspectCodexInputProvenance(ID, 700)).toBeDefined();
  expect(loaded).toHaveLength(1);
  const packet = JSON.parse(Buffer.from(loaded[0].data.split(':')[1], 'base64').toString());
  expect(packet).toMatchObject({ channel: 'probe', data: '' });
  expect(chunks).toEqual([]);
  assertPrivateArguments();
});
