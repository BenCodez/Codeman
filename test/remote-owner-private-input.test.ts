/** Actual local mux/frame flow for an owned SSH worker; every process API is forbidden. */
import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexInputBroker, type BrokerReceipt } from '../src/recovery/codex-input-broker.js';
import { ownedRemoteBrokerCache } from '../src/recovery/remote-input-broker-cache.js';
import { observeOwnedRemoteBroker } from '../src/recovery/remote-broker-launch.js';
import type { MuxSession } from '../src/mux-interface.js';
import { TmuxManager } from '../src/tmux-manager.js';
import { safeRmHomeTree } from './mocks/test-helpers.js';

const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('Native and SSH processes are forbidden');
  })
);
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  exec: forbidden,
  execSync: forbidden,
  execFile: forbidden,
  execFileSync: forbidden,
  spawn: forbidden,
  spawnSync: forbidden,
  fork: forbidden,
}));
vi.mock('../src/recovery/remote-broker-launch.js', () => ({ observeOwnedRemoteBroker: vi.fn() }));
const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PROMPT = 'Private owned SSH request 🧭';
const LOCAL_SSH_PID = 700;
const REMOTE_BROKER_PID = 900;
let root: string | undefined;
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.mocked(observeOwnedRemoteBroker).mockReset();
  forbidden.mockClear();
  if (root) safeRmHomeTree(root);
  root = undefined;
});

function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = '',
    quote = '',
    active = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote === "'") {
      if (char === "'") quote = '';
      else word += char;
    } else if (quote === '"') {
      if (char === '"') quote = '';
      else if (char === '\\') word += command[++i];
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      active = true;
    } else if (char === '\\') {
      word += command[++i];
      active = true;
    } else if (/\s/.test(char)) {
      if (active) {
        words.push(word);
        word = '';
        active = false;
      }
    } else {
      word += char;
      active = true;
    }
  }
  expect(quote).toBe('');
  if (active) words.push(word);
  return words;
}

it.each(['healthy', 'signer-replaced', 'scope-replaced', 'lost-remote-ack', 'native-veto'] as const)(
  'keeps private local input and remote receipt ordering: %s',
  async (change) => {
    root = await fs.mkdtemp(join(homedir(), 'remote-owner-private-'));
    const material = CodexInputBroker.provisioningMaterial(ID, 'Explicit remote fixture worker', root);
    const directory = `/remote/private/${ID}/${material.config.incarnation}`;
    const state = {
      version: 1,
      sessionId: ID,
      incarnation: material.config.incarnation,
      pid: REMOTE_BROKER_PID,
      childPid: 901,
      brokerStart: '123',
      childStart: '124',
      tainted: false,
      rawGeneration: 0,
      launchDigest: material.config.launchDigest,
      homeDigest: material.config.homeDigest,
      closed: false,
      exitStatus: null,
      exitSignal: null,
      counters: { 'owner-pty': 0, 'owner-key': 0, 'owner-mux': 0, auto: 0, probe: 0 },
      receipts: [] as BrokerReceipt[],
      startup: { nonce: material.config.startup.nonce, status: 'started' },
    };
    const snapshot = () => {
      const serialized = JSON.stringify(state);
      return {
        serialized,
        panePid: REMOTE_BROKER_PID,
        witness: {
          path: join(directory, 'state.json'),
          dev: 1,
          ino: 2,
          size: Buffer.byteLength(serialized),
          mtimeMs: 1,
          ctimeMs: 1,
          hash: createHash('sha256').update(serialized).digest('hex'),
          maxBytes: 98_304,
        },
      };
    };
    const broker = CodexInputBroker.fromRemoteMaterial(directory, material, state)!;
    const initial = snapshot();
    expect(broker.observeRemote(initial.serialized, initial.witness, REMOTE_BROKER_PID)).toBeDefined();
    expect(broker.canFrame).toBe(true);
    let signer: CodexInputBroker | undefined = broker;
    const record = {
      sessionId: ID,
      muxName: 'codeman-aaaaaaaa',
      pid: LOCAL_SSH_PID,
      recoveryInputBroker: broker.incarnation,
      recoveryCodexHome: root,
      owner: 'alice',
      remote: { host: 'worker.invalid', remotePath: '/remote/work', owned: true },
    } as MuxSession;
    const scope = {
      sessionId: ID,
      remote: record.remote!,
      workingDir: '/remote/work',
      codexHome: root,
      owner: 'alice',
    };
    const originalScope = JSON.stringify(scope);
    const descriptor = {
      directory,
      incarnation: broker.incarnation,
      launchDigest: material.config.launchDigest,
      homeDigest: material.config.homeDigest,
      helperDigest: createHash('sha256').update(material.helper).digest('hex'),
      keyDigest: createHash('sha256').update(material.config.secret).digest('hex'),
      startupNonce: material.config.startup.nonce,
    };
    const currentScope = (value: unknown, incarnation: string) =>
      JSON.stringify(value) === originalScope && incarnation === broker.incarnation;
    vi.spyOn(ownedRemoteBrokerCache, 'load').mockImplementation(async (value, incarnation) =>
      currentScope(value, incarnation) ? descriptor : undefined
    );
    vi.spyOn(ownedRemoteBrokerCache, 'get').mockImplementation((value, incarnation) =>
      currentScope(value, incarnation) ? descriptor : undefined
    );
    vi.spyOn(ownedRemoteBrokerCache, 'signer').mockImplementation((value, incarnation) =>
      currentScope(value, incarnation) ? signer : undefined
    );
    const trace: string[] = [],
      commands: string[] = [],
      delivered: string[] = [];
    const buffers = new Map<string, string>();
    const loaded: string[] = [];
    let nativePane = '%7';
    let lastPacket: { counter: number; nonce: string; data: string } | undefined;
    const cached = vi
      .spyOn(ownedRemoteBrokerCache, 'observe')
      .mockImplementation((value, incarnation, serialized, witness, panePid) => {
        expect(currentScope(value, incarnation)).toBe(true);
        trace.push('cache-ack');
        return broker.observeRemote(serialized, witness, panePid);
      });
    vi.mocked(observeOwnedRemoteBroker).mockImplementation(async (remote, request, authority) => {
      trace.push('remote-ack');
      expect(remote).toBe(record.remote);
      expect(authority.isCurrent()).toBe(true);
      expect(await authority.prepare()).toBe(true);
      expect(request.descriptor).toEqual(descriptor);
      expect(request.sessionId).toBe(ID);
      expect(request.receipt).toMatchObject({
        channel: 'owner-mux',
        counter: lastPacket!.counter,
        nonce: lastPacket!.nonce,
      });
      expect(request.receipt!.hash).toBe(createHash('sha256').update(delivered.at(-1)!).digest('hex'));
      if (change === 'lost-remote-ack') return { status: 'unknown' };
      state.counters['owner-mux'] = request.receipt!.counter;
      state.receipts.push({ ...request.receipt!, status: 'sent' });
      return { status: 'observed', ...snapshot() };
    });
    const manager = new TmuxManager(
      async (command) => {
        commands.push(command);
        const words = shellWords(command);
        const at = words.indexOf('if-shell');
        if (at < 0) {
          expect(words.slice(-3, -1)).toEqual(['delete-buffer', '-b']);
          buffers.delete(words.at(-1)!);
          return { stdout: '' };
        }
        expect(words.slice(at + 1, at + 4)).toEqual(['-F', '-t', '%7']);
        const expected: Record<string, string> = {
          session_name: record.muxName,
          pane_id: nativePane,
          pane_pid: String(LOCAL_SSH_PID),
          pane_dead: '0',
          pane_dead_status: '',
          pane_dead_signal: '',
        };
        const terms = [...words[at + 4].matchAll(/#\{==:#\{([^}]+)\},([^}]*)\}/g)];
        expect(terms).toHaveLength(6);
        expect(terms.map((term) => term[1]).sort()).toEqual(Object.keys(expected).sort());
        const paste = shellWords(words[at + 5]);
        expect(paste.slice(0, 4)).toEqual(['paste-buffer', '-r', '-d', '-b']);
        expect(paste.slice(5)).toEqual(['-t', '%7']);
        expect(paste).toHaveLength(7);
        const wire = buffers.get(paste[4])!;
        expect(wire).toBeDefined();
        buffers.delete(paste[4]);
        trace.push('native-check');
        if (!terms.every((term) => expected[term[1]] === term[2])) return { stdout: 'CODEMAN_RECOVERY_PANE_REFUSED\n' };
        const [marker, encoded, signed] = wire.slice(1, -1).split(':');
        expect(marker).toBe('CODEMAN_INPUT_V1');
        expect(signed).toBe(
          createHmac('sha256', Buffer.from(material.config.secret, 'hex')).update(encoded).digest('hex')
        );
        lastPacket = JSON.parse(Buffer.from(encoded, 'base64').toString());
        expect(lastPacket).toMatchObject({
          sessionId: ID,
          incarnation: broker.incarnation,
          channel: 'owner-mux',
          conversationId: '',
        });
        delivered.push(Buffer.from(lastPacket!.data, 'base64').toString());
        trace.push('paste');
        return { stdout: '' };
      },
      undefined,
      (name) => {
        expect(name).toBe(record.muxName);
        return `${record.muxName}|${nativePane}|${LOCAL_SSH_PID}|0||\n`;
      }
    );
    manager.registerSession(record);
    let loadedSignal!: () => void, release!: () => void;
    const held = new Promise<void>((resolve) => {
      loadedSignal = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(
      manager as unknown as { loadBrokerInputBuffer(name: string, data: string): Promise<void> },
      'loadBrokerInputBuffer'
    ).mockImplementation(async (name, data) => {
      expect(name).toMatch(/^codeman-private-[a-f0-9-]+$/);
      expect(buffers.has(name)).toBe(false);
      loaded.push(data);
      buffers.set(name, data);
      trace.push('load');
      if (change === 'signer-replaced' || change === 'scope-replaced' || change === 'native-veto') {
        loadedSignal();
        await gate;
      }
    });
    const sending = manager.sendInput(ID, `${PROMPT}\r`);
    if (change === 'signer-replaced' || change === 'scope-replaced' || change === 'native-veto') {
      await held;
      expect(delivered).toEqual([]);
      expect(observeOwnedRemoteBroker).not.toHaveBeenCalled();
      if (change === 'signer-replaced') {
        signer = CodexInputBroker.fromRemoteMaterial(directory, material, state)!;
        const replacement = snapshot();
        expect(signer.observeRemote(replacement.serialized, replacement.witness, REMOTE_BROKER_PID)).toBeDefined();
        expect(signer).not.toBe(broker);
      }
      if (change === 'scope-replaced') record.remote!.host = 'replacement.invalid';
      if (change === 'native-veto') nativePane = '%8';
      release();
    }
    expect(await sending).toBe(change === 'healthy');
    expect(delivered).toEqual(change === 'healthy' ? [PROMPT, '\r'] : change === 'lost-remote-ack' ? [PROMPT] : []);
    expect(loaded).toHaveLength(change === 'healthy' ? 2 : 1);
    expect(observeOwnedRemoteBroker).toHaveBeenCalledTimes(
      change === 'healthy' ? 2 : change === 'lost-remote-ack' ? 1 : 0
    );
    expect(cached).toHaveBeenCalledTimes(change === 'healthy' ? 2 : 0);
    if (change === 'healthy')
      expect(trace).toEqual([
        'load',
        'native-check',
        'paste',
        'remote-ack',
        'cache-ack',
        'load',
        'native-check',
        'paste',
        'remote-ack',
        'cache-ack',
      ]);
    if (change === 'signer-replaced' || change === 'scope-replaced') expect(trace).toEqual(['load']);
    expect(buffers.size).toBe(0);
    const allCommands = commands.join('\n');
    for (const secret of [
      PROMPT,
      root!,
      directory,
      material.config.secret,
      'CODEMAN_INPUT_V1',
      ...loaded.flatMap((wire) => [wire, wire.split(':')[1]]),
    ])
      expect(allCommands).not.toContain(secret);
    expect(allCommands).not.toContain('send-keys');
    expect(forbidden).not.toHaveBeenCalled();
  }
);
