/** @fileoverview Actual Session/TmuxManager effect boundaries, exclusively injected children and temporary owner data. */
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  readFileSync,
  statSync,
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MuxSession } from '../src/mux-interface.js';
import type { Session as SessionType } from '../src/session.js';
import type { TmuxManager as ManagerType } from '../src/tmux-manager.js';
import type { RecoveryActionAuthority } from '../src/recovery/types.js';
import { CodexInputBroker } from '../src/recovery/codex-input-broker.js';
import { fakeInputProvenance, updateFakeInputProvenance } from './helpers/codex-input-provenance.js';

const effects = vi.hoisted(() => ({ exec: vi.fn(), sync: vi.fn() }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const exec = () => {
    throw new Error('Unmocked process effect forbidden');
  };
  Object.defineProperty(exec, Symbol.for('nodejs.util.promisify.custom'), { value: effects.exec });
  return {
    ...actual,
    exec,
    execSync: effects.sync,
    execFile: () => {
      throw new Error('Unmocked process effect forbidden');
    },
    spawn: () => {
      throw new Error('Unmocked process effect forbidden');
    },
    execFileSync: () => {
      throw new Error('Unmocked process effect forbidden');
    },
    spawnSync: () => {
      throw new Error('Unmocked process effect forbidden');
    },
    fork: () => {
      throw new Error('Unmocked process effect forbidden');
    },
  };
});
let Session: typeof import('../src/session.js').Session;
let TmuxManager: typeof import('../src/tmux-manager.js').TmuxManager;
let directory: string;
let previousData: string | undefined;
let previousMode: string | undefined;
const workers: SessionType[] = [];
const acceptedPackets = new Map<string, 'sent' | 'not-sent'>();
const loadedFrames = new Map<string, string>();
beforeAll(async () => {
  // Enable the real command branches only after every child API is mocked.
  const vitest = process.env.VITEST;
  delete process.env.VITEST;
  try {
    ({ TmuxManager } = await import('../src/tmux-manager.js'));
    ({ Session } = await import('../src/session.js'));
  } finally {
    if (vitest !== undefined) process.env.VITEST = vitest;
  }
});
beforeEach(() => {
  acceptedPackets.clear();
  loadedFrames.clear();
  directory = mkdtempSync(join(homedir(), 'native-recovery-'));
  previousData = process.env.CODEMAN_DATA_DIR;
  previousMode = process.env.CODEMAN_MULTIUSER;
  process.env.CODEMAN_DATA_DIR = directory;
  process.env.CODEMAN_MULTIUSER = '1';
  effects.exec.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
  effects.sync.mockReset().mockReturnValue('99999\n');
  setGrant(true);
});
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.stop(false);
  if (previousData === undefined) delete process.env.CODEMAN_DATA_DIR;
  else process.env.CODEMAN_DATA_DIR = previousData;
  if (previousMode === undefined) delete process.env.CODEMAN_MULTIUSER;
  else process.env.CODEMAN_MULTIUSER = previousMode;
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});
function setGrant(granted: boolean) {
  const path = join(directory, 'users.json');
  writeFileSync(
    `${path}.fixture`,
    JSON.stringify({ version: 1, users: [{ username: 'worker', role: 'user', canBypassPermissions: granted }] })
  );
  renameSync(`${path}.fixture`, path);
}
function bareManager(): ManagerType {
  const manager = Object.create(TmuxManager.prototype) as ManagerType;
  for (const name of ['sessions', 'inputBrokers', 'inputBrokerLoads', 'inputQueues'])
    Reflect.set(manager, name, new Map());
  Reflect.set(manager, 'sessionSaves', Promise.resolve());
  Reflect.set(manager, 'sessionPersistenceUnknown', false);
  return manager;
}
async function fixture(action: 'continue' | 'restart', prompt = 'Authorized fixture continuation') {
  const home = join(directory, 'codex');
  mkdirSync(home);
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const thread = '11111111-2222-3333-4444-555555555555';
  const pane = {
    paneId: '%7',
    panePid: 700,
    dead: action === 'restart',
    status: action === 'restart' ? 1 : undefined,
    screen: action === 'restart' ? null : '›\n  fixture-model high · /tmp\n',
    inputProvenance: fakeInputProvenance(
      { closed: action === 'restart', exitStatus: action === 'restart' ? 1 : undefined },
      home
    ),
  };
  const inputBroker = await CodexInputBroker.create(
    join(home, 'broker-control'),
    id,
    'explicit fake native child',
    home
  );
  pane.inputProvenance.fileWitness!.path = join(inputBroker.directory, 'state.json');
  const config = JSON.parse(readFileSync(join(inputBroker.directory, 'config.json'), 'utf8'));
  updateFakeInputProvenance(
    pane.inputProvenance,
    { incarnation: inputBroker.incarnation, launchDigest: config.launchDigest },
    (proof) => ({
      version: 1,
      sessionId: id,
      incarnation: proof.incarnation,
      pid: proof.brokerPid,
      childPid: proof.childPid,
      brokerStart: proof.brokerStart,
      childStart: proof.childStart,
      tainted: proof.rawGeneration > 0,
      rawGeneration: proof.rawGeneration,
      launchDigest: proof.launchDigest,
      homeDigest: proof.homeDigest,
      closed: proof.closed,
      exitStatus: proof.exitStatus ?? null,
      exitSignal: proof.exitSignal ?? null,
      counters: { ...proof.ownerCounters, auto: 0, probe: 0 },
      receipts: [],
      startup: { nonce: config.startup.nonce, status: 'started' },
    })
  );
  expect(await inputBroker.readState()).toBeDefined();
  vi.spyOn(inputBroker, 'prove').mockImplementation(async () => pane.inputProvenance);
  vi.spyOn(inputBroker, 'receipt').mockImplementation(
    async (receipt) => acceptedPackets.get(receipt.nonce) ?? 'unknown'
  );
  vi.spyOn(inputBroker, 'startupReceipt').mockResolvedValue('started');
  // Bypass constructor/background discovery; use the real effect methods with a single owned registry entry.
  const manager = bareManager();
  vi.spyOn(
    manager as unknown as { loadBrokerInputBuffer(name: string, data: string): Promise<void> },
    'loadBrokerInputBuffer'
  ).mockImplementation(async (name, data) => {
    expect(name).toMatch(/^codeman-private-[a-f0-9-]+$/);
    loadedFrames.set(name, data);
  });
  const record = {
    sessionId: id,
    muxName: 'codeman-aaaaaaaa',
    pid: 700,
    createdAt: Date.now(),
    workingDir: directory,
    mode: 'codex',
    attached: true,
    recoveryIsolated: true,
    recoveryCodexHome: home,
    recoveryInputBroker: inputBroker.incarnation,
  } as MuxSession;
  Reflect.set(manager, 'sessions', new Map([[id, record]]));
  Reflect.set(manager, 'tmuxSocket', 'fixture-socket');
  Reflect.set(manager, 'paneExits', new Map());
  Reflect.set(manager, 'paneExitGeneration', 0);
  Reflect.set(manager, 'inputBrokers', new Map([[id, inputBroker]]));
  Reflect.set(manager, 'inputBrokerLoads', new Map());
  Reflect.set(manager, 'inputQueues', new Map());
  vi.spyOn(
    manager as unknown as { createInputBroker(): Promise<CodexInputBroker> },
    'createInputBroker'
  ).mockResolvedValue(inputBroker);
  vi.spyOn(manager, 'isAvailable').mockReturnValue(true);
  vi.spyOn(manager, 'inspectPaneForRecovery').mockImplementation(async () => ({ ...pane }));
  effects.sync.mockImplementation((command: string) => {
    if (command.includes('capture-pane')) return pane.screen;
    if (command.includes('display-message') && command.includes('#{pane_pid}'))
      return `codeman-aaaaaaaa|${pane.paneId}|${pane.panePid}|${pane.dead ? 1 : 0}|${pane.status ?? ''}|\n`;
    return '99999\n';
  });
  effects.exec.mockImplementation(async (command: string) => {
    if (command.includes('display-message') && !command.includes('if-shell'))
      return {
        stdout: `codeman-aaaaaaaa|${pane.paneId}|${pane.panePid}|${pane.dead ? 1 : 0}|${pane.status ?? ''}|\n`,
        stderr: '',
      };
    if (command.includes('if-shell') && isInputCommand(command)) {
      const expected = {
        session_name: 'codeman-aaaaaaaa',
        pane_id: pane.paneId,
        pane_pid: String(pane.panePid),
        pane_dead: pane.dead ? '1' : '0',
        pane_dead_status: String(pane.status ?? ''),
        pane_dead_signal: '',
      };
      const terms = [...command.matchAll(/#\{==:#\{([^}]+)\},([^}]*)\}/g)];
      expect(terms).toHaveLength(6);
      if (!terms.every((term) => expected[term[1] as keyof typeof expected] === term[2]))
        return { stdout: 'CODEMAN_RECOVERY_PANE_REFUSED\n', stderr: '' };
    }
    acceptInput(command);
    if (isLiteral(command) && acceptedPackets.get(inputPacket(command)!.nonce) === 'sent')
      pane.screen = `› ${prompt.replace(/\r/g, '').replace(/\n/g, '').trimEnd()}\n  fixture-model high · /tmp\n`;
    return { stdout: '', stderr: '' };
  });
  // These would read server credential env/bin locations; the effect boundary under test needs neither.
  vi.spyOn(manager as unknown as { _configureCliEnv(): void }, '_configureCliEnv').mockImplementation(() => {});
  vi.spyOn(
    manager as unknown as { buildPathExport(): { pathExport: string; dir: null } },
    'buildPathExport'
  ).mockReturnValue({ pathExport: '', dir: null });
  vi.spyOn(manager as unknown as { saveSessions(): void }, 'saveSessions').mockImplementation(() => {});
  const worker = new Session({
    id,
    owner: 'worker',
    workingDir: directory,
    mode: 'codex',
    useMux: true,
    mux: manager,
    muxSession: record,
    codexConfig: { noDaemon: true, model: 'fixture-model' },
    envOverrides: { CODEX_HOME: home },
  });
  workers.push(worker);
  await worker.ensureRecoveryIdentityFence();
  worker.pinRecoveryConversation(thread);
  let current = true;
  let evidence = true;
  const deliver = (
    proof: () => boolean | Promise<boolean> = () => evidence,
    authority: RecoveryActionAuthority = () => current
  ) => {
    const evidenceGuard = proof as import('../src/recovery/types.js').RecoveryEvidenceGuard;
    evidenceGuard.getEvidenceSource = () => {
      const leaf = pane.inputProvenance.fileWitness!;
      const tail = readFileSync(leaf.path, 'utf8');
      return {
        sessionId: id,
        inputBroker: inputBroker.authority(pane.inputProvenance),
        files: [leaf],
        identity: {
          reason: 'verified',
          conversationId: thread,
          path: leaf.path,
          tail,
          tailTruncated: false,
          witness: {
            paths: [
              {
                path: leaf.path,
                kind: 'file',
                dev: leaf.dev,
                ino: leaf.ino,
                size: leaf.size,
                mtimeMs: leaf.mtimeMs,
                ctimeMs: leaf.ctimeMs,
              },
            ],
          },
        },
        isCurrent: () => current,
      };
    };
    return worker.deliverRecovery(
      { action, key: 'fixture', conversationId: thread, startedAt: Date.now() },
      worker.getRecoveryContext().generation,
      authority,
      prompt,
      evidenceGuard
    );
  };
  return {
    worker,
    manager,
    home,
    pane,
    id,
    thread,
    deliver,
    cancel: () => {
      current = false;
    },
    invalidate: () => {
      evidence = false;
    },
  };
}
function acceptInput(command: string): void {
  if (!isInputCommand(command)) return;
  const packet = inputPacket(command);
  if (!packet) return;
  const accepted = packet.privateFiles.every((file) => {
    try {
      const stat = statSync(file.path);
      return (
        stat.dev === file.dev &&
        stat.ino === file.ino &&
        stat.size === file.size &&
        stat.mtimeMs === file.mtimeMs &&
        stat.ctimeMs === file.ctimeMs &&
        createHash('sha256').update(readFileSync(file.path)).digest('hex') === file.hash
      );
    } catch {
      return false;
    }
  });
  acceptedPackets.set(packet.nonce, accepted ? 'sent' : 'not-sent');
}
function childCommands(): string[] {
  return commands().filter((command) => {
    const packet = inputPacket(command);
    return packet
      ? isInputCommand(command) && packet.channel !== 'probe' && acceptedPackets.get(packet.nonce) === 'sent'
      : !isInputCommand(command);
  });
}
function isInputCommand(command: string): boolean {
  return command.includes('send-keys') || command.includes('paste-buffer');
}
function isEnter(command: string) {
  return (
    inputData(command) === '\r' ||
    (isInputCommand(command) && !command.includes(' -l ') && / Enter(?:'|$)/.test(command))
  );
}
function inputPacket(command: string):
  | {
      data: string;
      nonce: string;
      channel: string;
      privateFiles: import('../src/recovery/private-file-witness.js').PrivateFileWitness[];
    }
  | undefined {
  const name = command.match(/codeman-private-[a-f0-9-]+/)?.[0];
  const frame = name ? loadedFrames.get(name) : command;
  const encoded = frame?.match(/CODEMAN_INPUT_V1:([A-Za-z0-9+/=]+):[a-f0-9]{64}/)?.[1];
  return encoded ? JSON.parse(Buffer.from(encoded, 'base64').toString()) : undefined;
}
function inputData(command: string): string | undefined {
  const packet = inputPacket(command);
  return packet && Buffer.from(packet.data, 'base64').toString();
}
function isLiteral(command: string): boolean {
  return (
    isInputCommand(command) &&
    (command.includes('paste-buffer') || command.includes(' -l ')) &&
    inputPacket(command)?.channel !== 'probe' &&
    !isEnter(command)
  );
}
function commands() {
  return effects.exec.mock.calls.map(([command]) => String(command));
}

describe('native recovery pane frame validation', () => {
  it.each([
    '1|9|garbage|%7|700',
    '1|9|KILL|%7|700',
    '1|0|TERM|%7|700',
    '0|0||%7|700',
    '0||KILL|%7|700',
    '1|garbage|9|%7|700',
    '1|9||%7|700|extra',
    '1|9||%7',
    '1|9||%7|700\n1|9||%8|701',
    '1|9||%7|700\n\n',
    '1|9||%7|700\r\n',
    '1|-1||%7|700',
    '1|100000||%7|700',
    '1|256||%7|700',
    '1|9|99999|%7|700',
    '1|9|-1|%7|700',
    '1|9|100000|%7|700',
    '1|9||%999999999999999999999|700',
    '1|9||%7;touch|700',
    '1|9||%07|700',
    '1|9||%7|0',
    '1|9||%7|-1',
    '1|9||%7|700 ',
    '1|9||%7|700x',
    '1|9||%7|999999999999',
    '1||NOTASIGNAL|%7|700',
    '1||TERM;touch|%7|700',
    '1||SIGKILL|%7|700',
    '1||kill|%7|700',
    '2|9||%7|700',
    '1|9| |%7|700',
    '0|garbage||%7|700',
  ])('rejects the whole malformed native frame before screen capture: %j', async (frame) => {
    const manager = bareManager();
    Reflect.set(manager, 'tmuxSocket', 'fixture-socket');
    effects.exec.mockResolvedValue({ stdout: frame, stderr: '' });
    expect(await manager.inspectPaneForRecovery('codeman-aaaaaaaa')).toBeNull();
    expect(commands()).toHaveLength(1);
    expect(commands()[0]).toContain('list-panes');
    expect(commands().some((command) => command.includes('capture-pane'))).toBe(false);
  });
  it.each([
    { frame: '1|9||%7|700\n', dead: true, status: 9, signal: undefined },
    { frame: '1||9|%7|700', dead: true, status: undefined, signal: 9 },
    { frame: '1||KILL|%7|700', dead: true, status: undefined, signal: 9 },
    { frame: '1||TERM|%7|700', dead: true, status: undefined, signal: 15 },
    { frame: '1|0|0|%0|700', dead: true, status: 0, signal: 0 },
    { frame: '0|||%7|700\n', dead: false, status: undefined, signal: undefined },
  ])(
    'accepts a complete bounded native frame with normal empty exit fields: $frame',
    async ({ frame, dead, status, signal }) => {
      const manager = bareManager();
      Reflect.set(manager, 'tmuxSocket', 'fixture-socket');
      effects.exec.mockImplementation(async (command: string) => {
        if (command.includes('list-panes')) return { stdout: frame, stderr: '' };
        if (command.includes('capture-pane')) return { stdout: 'Sanitized ready screen', stderr: '' };
        throw new Error('Unmocked native command forbidden');
      });
      expect(await manager.inspectPaneForRecovery('codeman-aaaaaaaa')).toEqual({
        dead,
        status,
        signal,
        paneId: frame.includes('%0') ? '%0' : '%7',
        panePid: 700,
        paneSignalToken: frame.split('|')[2],
        screen: dead ? null : 'Sanitized ready screen',
      });
      expect(commands()).toHaveLength(dead ? 1 : 2);
    }
  );
});

describe('native continuation after literal input', () => {
  it.each(['unchanged', 'cancel', 'grant', 'delay-cancel', 'delay-grant', 'evidence', 'config', 'stop', 'exception'])(
    'rechecks %s before Enter and preserves uncertain partial delivery',
    async (change) => {
      const f = await fixture('continue');
      effects.exec.mockImplementation(async (command: string) => {
        acceptInput(command);
        if (isLiteral(command)) {
          f.pane.screen = '› Authorized fixture continuation\n  fixture-model high · /tmp\n';
          if (change === 'cancel') f.cancel();
          if (change === 'grant') setGrant(false);
          if (change === 'delay-cancel') setTimeout(f.cancel, 10);
          if (change === 'delay-grant') setTimeout(() => setGrant(false), 10);
          if (change === 'evidence') f.invalidate();
          if (change === 'config') f.worker.codexConfig!.model = 'changed-fixture-model';
          if (change === 'stop') await f.worker.stop(false);
          if (change === 'exception') throw new Error('Fixture literal bytes may already have landed');
        }
        return { stdout: '', stderr: '' };
      });
      expect(await f.deliver()).toBe(change === 'unchanged' ? 'sent' : 'unknown');
      expect(childCommands().filter(isLiteral)).toHaveLength(1);
      expect(childCommands().filter(isEnter)).toHaveLength(change === 'unchanged' ? 1 : 0);
      expect(commands().filter((command) => command.includes('kill-'))).toHaveLength(0);
    }
  );
  it('certifies a current grant refusal before the first native input effect', async () => {
    const f = await fixture('continue');
    const nativeSend = f.manager.sendInput.bind(f.manager);
    vi.spyOn(f.manager, 'sendInput').mockImplementation((...args) => {
      setGrant(false);
      return nativeSend(...args);
    });
    expect(await f.deliver()).toBe('not-sent');
    expect(commands()).toEqual([]);
  });

  it('still sends ordinary two-argument input through the existing literal/Enter behavior', async () => {
    const f = await fixture('continue');
    expect(await f.manager.sendInput(f.worker.id, 'ordinary fixture\r')).toBe(true);
    expect(childCommands().filter(isEnter)).toHaveLength(1);
  });

  it('keeps post-paste composer uncertainty sealed through refresh, retry and durable reload', async () => {
    const f = await fixture('continue');
    const { RecoveryController } = await import('../src/recovery/controller.js');
    const { RecoveryStore } = await import('../src/recovery/store.js');
    const { initialRecoveryState } = await import('../src/recovery/types.js');
    const store = new RecoveryStore(join(directory, 'composer-recovery.json'));
    const send = effects.exec.getMockImplementation()!;
    effects.exec.mockImplementation(async (command: string) => {
      const result = await send(command);
      if (isLiteral(command))
        f.pane.screen = '› Authorized fixture continuation edited by owner\n  fixture-model high · /tmp\n';
      return result;
    });
    const deps = {
      observe: async () => ({
        activity: 'interrupted' as const,
        reason: 'turn-failed' as const,
        at: Date.now(),
        conversationId: f.thread,
        evidenceKey: 'composer-fixture',
        safeToAct: true,
      }),
      act: () => f.deliver(),
      persist: (state: ReturnType<typeof initialRecoveryState>) => store.save(f.id, state),
      changed: vi.fn(),
    };
    const controller = new RecoveryController(deps);
    let restored: InstanceType<typeof RecoveryController> | undefined;
    try {
      await controller.retry();
      expect(store.get(f.id)).toMatchObject({ lastReason: 'acceptance-unverified', inFlight: { action: 'continue' } });
      await controller.refresh();
      await controller.retry();
      restored = new RecoveryController(deps, new RecoveryStore(join(directory, 'composer-recovery.json')).get(f.id));
      await restored.refresh();
      await restored.retry();
      expect(childCommands().filter(isLiteral)).toHaveLength(1);
      expect(childCommands().filter(isEnter)).toHaveLength(0);
      expect(restored.getStatus().inFlight).toBeDefined();
    } finally {
      controller.stop();
      restored?.stop();
      await controller.drain();
      await restored?.drain();
    }
  });
});

describe('direct TUI composer edits at automatic input boundaries', () => {
  it.each(
    [1, 3].flatMap((holdAt) =>
      [
        'unchanged',
        'draft',
        'busy',
        'approval',
        'unreadable',
        'grant',
        'issuer',
        'expired',
        'native-pid',
        'native-id',
        'native-dead',
      ].map((change) => ({
        holdAt,
        change,
      }))
    )
  )('retains final native admission after held proof $holdAt with $change', async ({ holdAt, change }) => {
    const f = await fixture('continue');
    let reached!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let checks = 0;
    const nativeSend = f.manager.sendInput.bind(f.manager);
    vi.spyOn(f.manager, 'sendInput').mockImplementation((id, input, guard) => {
      const prepare = guard!.prepareEvidence!;
      guard!.prepareEvidence = async () => {
        if (++checks === holdAt) {
          reached();
          await held;
        }
        return prepare();
      };
      return nativeSend(id, input, guard);
    });
    let issuerCurrent = true;
    const issuer: RecoveryActionAuthority = () => issuerCurrent;
    issuer.prepareEvidence = async () => true;
    const delivery = f.deliver(() => true, issuer);
    await entered;
    expect(childCommands().filter((command) => isInputCommand(command))).toHaveLength(holdAt === 1 ? 0 : 1);
    if (change === 'draft') f.pane.screen = '› Direct TUI edit during private proof\n  fixture-model high · /tmp\n';
    if (change === 'busy') f.pane.screen = 'Working (esc to interrupt)\n' + f.pane.screen;
    if (change === 'approval') f.pane.screen = 'Would you like to approve this?\n' + f.pane.screen;
    if (change === 'unreadable') f.pane.screen = null;
    if (change === 'grant') setGrant(false);
    if (change === 'issuer') issuerCurrent = false;
    if (change === 'native-pid') f.pane.panePid = 701;
    if (change === 'native-id') f.pane.paneId = '%8';
    if (change === 'native-dead') f.pane.dead = true;
    if (change === 'expired') vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 3_000);
    release();
    expect(await delivery).toBe(change === 'unchanged' ? 'sent' : holdAt === 1 ? 'not-sent' : 'unknown');
    expect(childCommands().filter(isEnter)).toHaveLength(change === 'unchanged' ? 1 : 0);
  });

  it.each([
    'missing-id',
    'missing-pid',
    'bad-id',
    'bad-pid',
    'live-status',
    'live-signal',
    'malformed-native-read',
    'unterminated-native-read',
  ] as const)('refuses incomplete or malformed current continuation process identity: %s', async (change) => {
    const f = await fixture('continue');
    if (change === 'missing-id') Reflect.deleteProperty(f.pane, 'paneId');
    if (change === 'missing-pid') Reflect.deleteProperty(f.pane, 'panePid');
    if (change === 'bad-id') f.pane.paneId = '%07';
    if (change === 'bad-pid') f.pane.panePid = 0;
    if (change === 'live-status') f.pane.status = 0;
    if (change === 'live-signal') Reflect.set(f.pane, 'signal', 9);
    if (change === 'malformed-native-read' || change === 'unterminated-native-read') {
      const read = effects.sync.getMockImplementation()!;
      effects.sync.mockImplementation((command: string) =>
        command.includes('display-message') && command.includes('#{pane_pid}')
          ? `codeman-aaaaaaaa|%7|700|0||${change === 'malformed-native-read' ? '\r\n' : ''}`
          : read(command)
      );
    }
    expect(await f.deliver()).toBe('not-sent');
    expect(childCommands().filter((command) => isInputCommand(command))).toHaveLength(0);
  });

  it.each(
    [false, true].flatMap((afterLiteral) =>
      ['native-pid', 'native-id', 'native-dead'].map((change) => ({ afterLiteral, change }))
    )
  )(
    'retains exact process fencing inside native dispatch afterLiteral=$afterLiteral $change',
    async ({ afterLiteral, change }) => {
      const f = await fixture('continue');
      const send = effects.exec.getMockImplementation()!;
      let entered = 0,
        workerEffects = 0;
      effects.exec.mockImplementation(async (command: string) => {
        if (isInputCommand(command) && ++entered === (afterLiteral ? 2 : 1)) {
          if (change === 'native-pid') f.pane.panePid = 701;
          if (change === 'native-id') f.pane.paneId = '%8';
          if (change === 'native-dead') f.pane.dead = true;
        }
        const result = await send(command);
        if (isInputCommand(command) && result.stdout !== 'CODEMAN_RECOVERY_PANE_REFUSED\n') workerEffects++;
        return result;
      });
      expect(await f.deliver()).toBe('unknown');
      expect(workerEffects).toBe(afterLiteral ? 1 : 0);
      expect(entered).toBe(afterLiteral ? 2 : 1);
      expect(f.pane.screen).toBe(
        afterLiteral
          ? '› Authorized fixture continuation\n  fixture-model high · /tmp\n'
          : '›\n  fixture-model high · /tmp\n'
      );
      expect(
        commands().every((command) => !isInputCommand(command) || /if-shell -F -t (?:'%7'|%7) /.test(command))
      ).toBe(true);
    }
  );

  it.each(['continue', 'restart'] as const)(
    'composes fresh issuer proof before every %s effect and yields to revocation',
    async (action) => {
      const f = await fixture(action);
      const issuer: RecoveryActionAuthority = () => true;
      let checks = 0;
      issuer.prepareEvidence = async () => ++checks < 2;
      expect(await f.deliver(async () => true, issuer)).toBe('not-sent');
      expect(checks).toBe(2);
      expect(commands().filter((command) => isInputCommand(command) || command.includes('respawn-pane'))).toHaveLength(
        0
      );
    }
  );
  it.each(['unchanged', 'draft'] as const)(
    'rechecks the joined composer after a held literal child completes (%s)',
    async (change) => {
      const f = await fixture('continue');
      let entered!: () => void;
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const send = effects.exec.getMockImplementation()!;
      effects.exec.mockImplementation(async (command: string) => {
        const result = await send(command);
        if (isLiteral(command)) {
          entered();
          await held;
        }
        return result;
      });
      const delivery = f.deliver();
      await waiting;
      if (change === 'draft')
        f.pane.screen = '› Direct owner edit during pending literal child\n  fixture-model high · /tmp\n';
      release();
      expect(await delivery).toBe(change === 'unchanged' ? 'sent' : 'unknown');
      expect(childCommands().filter(isLiteral)).toHaveLength(1);
      expect(childCommands().filter(isEnter)).toHaveLength(change === 'unchanged' ? 1 : 0);
    }
  );

  it.each([1, 2].flatMap((capture) => (['grant', 'evidence'] as const).map((change) => ({ capture, change }))))(
    'rechecks $change at composer phase $capture, immediately before native effect',
    async ({ capture, change }) => {
      const f = await fixture('continue');
      const read = effects.sync.getMockImplementation()!;
      let changed = false;
      effects.sync.mockImplementation((command: string) => {
        const screen = read(command);
        // The second phase begins only after the real fake literal effect;
        // extra private-buffer checks cannot move this mutation into phase 1.
        if (
          command.includes('capture-pane') &&
          !changed &&
          (capture === 1 || childCommands().filter(isLiteral).length === 1)
        ) {
          changed = true;
          if (change === 'grant') setGrant(false);
          else f.invalidate();
        }
        return screen;
      });
      expect(await f.deliver()).toBe(capture === 1 ? 'not-sent' : 'unknown');
      expect(childCommands().filter(isLiteral)).toHaveLength(capture - 1);
      expect(childCommands().filter(isEnter)).toHaveLength(0);
    }
  );

  it.each(['unchanged', 'draft', 'multiline-draft', 'busy', 'unreadable'] as const)(
    'reads the actual Session composer after a held asynchronous grant (%s)',
    async (change) => {
      const f = await fixture('continue');
      const clamps = await import('../src/session-env-clamp.js');
      const clamp = clamps.clampRecoveryLaunchForOwner;
      let entered!: () => void;
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(clamps, 'clampRecoveryLaunchForOwner').mockImplementation(async (...args) => {
        const granted = await clamp(...args);
        entered();
        await held;
        return granted;
      });
      const generation = f.worker.getRecoveryContext().generation;
      const delivery = f.deliver();
      await waiting;
      if (change === 'draft') f.pane.screen = '› Unsent owner draft\n  fixture-model high · /tmp\n';
      if (change === 'multiline-draft') f.pane.screen = '›\n  Unsent owner continuation\n  fixture-model high · /tmp\n';
      if (change === 'busy') f.pane.screen = 'Working (esc to interrupt)\n›\n  fixture-model high · /tmp\n';
      if (change === 'unreadable') f.pane.screen = null;
      expect(f.worker.getRecoveryContext().generation).toBe(generation);
      release();
      expect(await delivery).toBe(change === 'unchanged' ? 'sent' : 'not-sent');
      expect(childCommands().filter((command) => isInputCommand(command))).toHaveLength(change === 'unchanged' ? 2 : 0);
    }
  );

  it.each(['unchanged', 'draft', 'busy', 'unreadable', 'grant'] as const)(
    'fences a direct composer edit after Session admission but before native input (%s)',
    async (change) => {
      const f = await fixture('continue');
      const nativeSend = f.manager.sendInput.bind(f.manager);
      vi.spyOn(f.manager, 'sendInput').mockImplementation(async (...args) => {
        if (change === 'draft') f.pane.screen = '› Direct owner draft\n  fixture-model high · /tmp\n';
        if (change === 'busy') f.pane.screen = 'Working (esc to interrupt)\n›\n  fixture-model high · /tmp\n';
        if (change === 'unreadable') f.pane.screen = null;
        if (change === 'grant') setGrant(false);
        return nativeSend(...args);
      });
      expect(await f.deliver()).toBe(change === 'unchanged' ? 'sent' : 'not-sent');
      expect(childCommands().filter((command) => isInputCommand(command))).toHaveLength(change === 'unchanged' ? 2 : 0);
    }
  );

  it.each(['unchanged', 'draft', 'busy', 'approval', 'authentication', 'unreadable'] as const)(
    'requires the exact delivered composer at Enter and seals partial bytes (%s)',
    async (change) => {
      const f = await fixture('continue');
      const send = effects.exec.getMockImplementation()!;
      effects.exec.mockImplementation(async (command: string) => {
        const result = await send(command);
        if (isLiteral(command)) {
          if (change === 'draft')
            f.pane.screen = '› Authorized fixture continuation owner edit\n  fixture-model high · /tmp\n';
          if (change === 'busy') f.pane.screen = 'Working (esc to interrupt)\n' + f.pane.screen;
          if (change === 'approval') f.pane.screen = 'Would you like to approve this?\n' + f.pane.screen;
          if (change === 'authentication') f.pane.screen = 'Authentication failed\n' + f.pane.screen;
          if (change === 'unreadable') f.pane.screen = null;
        }
        return result;
      });
      expect(await f.deliver()).toBe(change === 'unchanged' ? 'sent' : 'unknown');
      expect(childCommands().filter(isLiteral)).toHaveLength(1);
      expect(childCommands().filter(isEnter)).toHaveLength(change === 'unchanged' ? 1 : 0);
      // The generic delayed submit verifier must never press Enter after this refusal.
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(childCommands().filter(isEnter)).toHaveLength(change === 'unchanged' ? 1 : 0);
    }
  );

  it.each([
    'Healthy Unicode task: café 🧭 漢字',
    'Repair authentication failed and usage limit handling; explain would you like and approve this UI.',
    JSON.stringify({ objective: 'First line\nSecond line 🧭', checkpoint: 'Evidence\nNext step' }),
    'x'.repeat(6000) + '🧭',
  ])('delivers the exact bounded joined composer without normalizing it: %s', async (prompt) => {
    const f = await fixture('continue', prompt);
    expect(await f.deliver()).toBe('sent');
    const captures = effects.sync.mock.calls
      .map(([command]) => String(command))
      .filter((command) => command.includes('capture-pane'));
    expect(captures).toHaveLength(6);
    expect(captures.every((command) => command.includes(' -J '))).toBe(true);
    expect(childCommands().filter(isEnter)).toHaveLength(1);
  });

  it.each(
    ['Authentication failed', 'Would you like to approve this?'].flatMap((prompt) =>
      [false, true].map((surroundingVeto) => ({ prompt, surroundingVeto }))
    )
  )(
    'only excludes actual exact composer text from veto chrome ($prompt, veto=$surroundingVeto)',
    async ({ prompt, surroundingVeto }) => {
      const f = await fixture('continue', prompt);
      const send = effects.exec.getMockImplementation()!;
      effects.exec.mockImplementation(async (command: string) => {
        const result = await send(command);
        if (surroundingVeto && isLiteral(command)) f.pane.screen = `${prompt}\n${f.pane.screen}`;
        return result;
      });
      expect(await f.deliver()).toBe(surroundingVeto ? 'unknown' : 'sent');
      expect(childCommands().filter(isLiteral)).toHaveLength(1);
      expect(childCommands().filter(isEnter)).toHaveLength(surroundingVeto ? 0 : 1);
    }
  );
});

describe('current native identity after direct TUI resume', () => {
  it.each([
    'unchanged',
    'initial-older-resume',
    'older-resume',
    'unknown-latest',
    'malformed-latest',
    'final-history-change',
    'held-issuer-unchanged',
    'held-issuer-history-change',
    'held-issuer-rollout-change',
    'seed-older-resume',
    'seed-unknown-latest',
    'seed-historical-other',
    'seed-older-restart',
  ] as const)('requires current history before continuing an exact failed thread (%s)', async (change) => {
    const { CONTINUATION_PROMPT } = await import('../src/recovery/types.js');
    const { CodexRecoveryAdapter } = await import('../src/recovery/codex-adapter.js');
    const f = await fixture(change === 'seed-older-restart' ? 'restart' : 'continue', CONTINUATION_PROMPT);
    const older = '66666666-7777-4888-8999-aaaaaaaaaaaa';
    const unknown = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
    const ownerPrompt = 'Exact recorded fixture owner prompt';
    const seedOnly = change.startsWith('seed-');
    if (!seedOnly) {
      f.worker.trackUserInput(ownerPrompt + '\r');
      await Reflect.get(f.worker, '_recoveryFencePublication');
    }
    const context = f.worker.getRecoveryContext();
    if (seedOnly) expect(context.submission).toBeUndefined();
    else expect(context.submission).toBeDefined();
    const submittedAt = context.submission?.at ?? Date.now();
    mkdirSync(join(f.home, 'sessions'));
    const header = (id: string, createdAt: number, originator: string) =>
      JSON.stringify({
        timestamp: new Date(createdAt).toISOString(),
        type: 'session_meta',
        payload: { id, cwd: directory, originator },
      }) + '\n';
    const event = (payload: unknown, at: number) =>
      JSON.stringify({
        timestamp: new Date(at).toISOString(),
        type: 'event_msg',
        payload,
      }) + '\n';
    writeFileSync(
      join(f.home, 'sessions', `rollout-current-${f.thread}.jsonl`),
      header(f.thread, submittedAt - 60_000, `codeman_${f.id}`) +
        event({ type: 'user_message', message: ownerPrompt }, submittedAt) +
        event({ type: 'task_started', turn_id: 'recorded-turn' }, submittedAt + 1) +
        event(
          {
            type: 'task_complete',
            turn_id: 'recorded-turn',
            error: { message: 'Conversation interrupted.', codex_error_info: null },
          },
          submittedAt + 2
        )
    );
    writeFileSync(
      join(f.home, 'sessions', `rollout-older-${older}.jsonl`),
      header(older, submittedAt - 120_000, 'codex-tui') +
        event({ type: 'task_complete', turn_id: 'older-turn' }, submittedAt - 60_000)
    );
    const history = join(f.home, 'history.jsonl');
    writeFileSync(history, JSON.stringify({ session_id: f.thread, ts: submittedAt / 1000, text: ownerPrompt }) + '\n');
    const appendResume = (id = older) =>
      appendFileSync(
        history,
        JSON.stringify({
          session_id: id,
          ts: Math.max(Date.now(), submittedAt) / 1000,
          text: 'Direct TUI /resume to older conversation',
        }) + '\n'
      );
    const adapter = new CodexRecoveryAdapter(f.worker, vi.fn());
    if (change === 'initial-older-resume') appendResume();
    if (change === 'seed-older-resume' || change === 'seed-older-restart') appendResume();
    if (change === 'seed-unknown-latest') appendResume(unknown);
    if (change === 'seed-historical-other') {
      writeFileSync(
        history,
        JSON.stringify({ session_id: older, ts: (submittedAt - 180_000) / 1000, text: 'Historical older prompt' }) +
          '\n'
      );
    }
    const observation = await adapter.observe();
    if (change === 'initial-older-resume' || seedOnly) {
      expect(observation).toMatchObject({ activity: 'unknown', reason: 'identity-unverified', safeToAct: false });
      expect(observation.conversationId).toBeUndefined();
      expect(adapter.getVerifiedTail(f.thread)).toBeUndefined();
      expect(commands()).toEqual([]);
      return;
    }
    expect(observation).toMatchObject({ activity: 'interrupted', conversationId: f.thread, safeToAct: true });
    if (change === 'older-resume') appendResume();
    if (change === 'unknown-latest') appendResume(unknown);
    if (change === 'malformed-latest') appendFileSync(history, '{unknown-final-history}\n');
    if (change === 'final-history-change') {
      const clamps = await import('../src/session-env-clamp.js');
      const clamp = clamps.clampRecoveryLaunchForOwner;
      vi.spyOn(clamps, 'clampRecoveryLaunchForOwner').mockImplementation(async (...args) => {
        const granted = await clamp(...args);
        appendResume();
        return granted;
      });
    }
    expect(f.worker.getRecoveryContext().generation).toBe(context.generation);
    expect(f.worker.getRecoveryContext().submission).toEqual(context.submission);
    const authority: RecoveryActionAuthority = () => true;
    let reached!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let issuerChecks = 0;
    if (change.startsWith('held-issuer-'))
      authority.prepareEvidence = async (source) => {
        if (++issuerChecks === 2) {
          reached();
          await held;
        }
        const { checkCodexIdentityWitnesses } = await import('../src/recovery/codex-witness-check.js');
        return (
          !!source && source.isCurrent() && (await checkCodexIdentityWitnesses([source.identity])) && source.isCurrent()
        );
      };
    const delivery = adapter.act(
      {
        key: observation.evidenceKey!,
        action: 'continue',
        conversationId: f.thread,
        startedAt: Date.now(),
      },
      authority
    );
    if (change.startsWith('held-issuer-')) {
      await entered;
      expect(childCommands().filter((command) => isInputCommand(command))).toHaveLength(0);
      if (change === 'held-issuer-history-change') appendResume();
      if (change === 'held-issuer-rollout-change')
        appendFileSync(
          join(f.home, 'sessions', `rollout-current-${f.thread}.jsonl`),
          event({ type: 'task_started', turn_id: 'new-worker-turn' }, Date.now())
        );
      release();
    }
    const healthy = change === 'unchanged' || change === 'held-issuer-unchanged';
    expect(await delivery).toBe(healthy ? 'sent' : 'not-sent');
    expect(childCommands().filter((command) => isInputCommand(command))).toHaveLength(healthy ? 2 : 0);
  });
});

describe('native restart final preparation boundary', () => {
  it.each(
    (['recovery'] as const).flatMap((agent) =>
      (['unchanged', 'Session-PID', 'preparation-PID'] as const).map((change) => ({ agent, change }))
    )
  )(
    'passes the genuine $agent adapter private pane fence through Session and native dispatch ($change)',
    async ({ agent, change }) => {
      const f = await fixture('restart');
      const ownerPrompt = 'Exact tracked restart fixture prompt';
      f.worker.trackUserInput(ownerPrompt + '\r');
      await Reflect.get(f.worker, '_recoveryFencePublication');
      writeFileSync(
        join(f.home, 'history.jsonl'),
        JSON.stringify({
          session_id: f.thread,
          ts: f.worker.getRecoveryContext().submission!.at / 1000,
          text: ownerPrompt,
        }) + '\n'
      );
      mkdirSync(join(f.home, 'sessions'));
      const at = new Date(Date.now() - 60_000).toISOString();
      writeFileSync(
        join(f.home, 'sessions', `rollout-fixture-${f.thread}.jsonl`),
        JSON.stringify({
          timestamp: at,
          type: 'session_meta',
          payload: { id: f.thread, cwd: directory, originator: `codeman_${f.id}` },
        }) +
          '\n' +
          JSON.stringify({
            timestamp: at,
            type: 'event_msg',
            payload: { type: 'task_complete', turn_id: 'fixture-turn' },
          }) +
          '\n'
      );
      const { CodexRecoveryAdapter } = await import('../src/recovery/codex-adapter.js');
      const adapter = new CodexRecoveryAdapter(f.worker, vi.fn());
      f.pane.dead = false;
      f.pane.status = undefined;
      f.pane.screen = '›\n  fixture-model high · /tmp\n';
      await adapter.observe();
      f.pane.dead = true;
      f.pane.status = 1;
      f.pane.screen = null;
      f.worker.setPaneExit({ at: Date.now(), status: 1 });
      const observed = await adapter.observe();
      const observation = observed;
      expect(observation).toMatchObject({ activity: 'crashed', safeToAct: true });
      if (change === 'Session-PID') {
        const inspect = f.worker.inspectRecoveryPane.bind(f.worker);
        let reads = 0;
        vi.spyOn(f.worker, 'inspectRecoveryPane').mockImplementation(async () => {
          const current = await inspect();
          if (++reads === 2 && current) current.panePid = 701;
          return current;
        });
      }
      let workerEffects = 0;
      const snapshot: Record<string, string> = {
        session_name: 'codeman-aaaaaaaa',
        pane_id: '%7',
        pane_pid: '700',
        pane_dead: '1',
        pane_dead_status: '1',
        pane_dead_signal: '',
      };
      effects.sync.mockImplementation((command: string) => {
        if (change === 'preparation-PID' && command.includes('setenv') && command.includes(' CODEX_HOME '))
          snapshot.pane_pid = '701';
        return '99999\n';
      });
      effects.exec.mockImplementation(async (command: string) => {
        const terms = [...command.matchAll(/#\{==:#\{([^}]+)\},([^}]*)\}/g)];
        expect(terms).toHaveLength(6);
        if (!terms.every((term) => snapshot[term[1]] === term[2]))
          return { stdout: 'CODEMAN_RECOVERY_PANE_REFUSED\n', stderr: '' };
        workerEffects++;
        return { stdout: '', stderr: '' };
      });
      const result = await adapter.act({
        key: observation.evidenceKey!,
        action: 'restart',
        conversationId: f.thread,
        startedAt: Date.now(),
      });
      expect(result).toBe(change === 'unchanged' ? 'sent' : change === 'Session-PID' ? 'not-sent' : 'unknown');
      expect(workerEffects).toBe(change === 'unchanged' ? 1 : 0);
      if (change !== 'Session-PID') expect(commands().at(-1)).not.toContain('respawn-pane -k');
      effects.exec.mockClear();
    }
  );

  it.each(['unchanged', 'cancel', 'grant', 'evidence', 'config'])(
    'rechecks %s after environment setup before a worker child',
    async (change) => {
      const f = await fixture('restart');
      effects.sync.mockImplementation((command: string) => {
        if (command.includes('setenv') && command.includes(' CODEX_HOME ')) {
          if (change === 'cancel') f.cancel();
          if (change === 'grant') setGrant(false);
          if (change === 'evidence') f.invalidate();
          if (change === 'config') f.worker.codexConfig!.model = 'changed-fixture-model';
        }
        return '99999\n';
      });
      expect(await f.deliver()).toBe(change === 'unchanged' ? 'sent' : 'not-sent');
      const spawns = commands().filter((command) => command.includes('respawn-pane'));
      expect(spawns).toHaveLength(change === 'unchanged' ? 1 : 0);
      if (spawns.length) expect(spawns[0]).not.toContain('respawn-pane -k');
      expect(commands().filter((command) => command.includes('kill-'))).toHaveLength(0);
    }
  );
  it('renders the native worker argv from the final persisted startup authority', async () => {
    const f = await fixture('restart');
    const broker = (Reflect.get(f.manager, 'inputBrokers') as Map<string, CodexInputBroker>).get(f.id)!;
    const before = broker.configurationDigest;
    effects.sync.mockReturnValue('99999\n');
    const original = effects.exec.getMockImplementation()!;
    const spawned: string[] = [];
    effects.exec.mockImplementation(async (command: string) => {
      if (command.includes('respawn-pane ')) spawned.push(command);
      return original(command);
    });
    expect(await f.deliver()).toBe('sent');
    expect(spawned).toHaveLength(1);
    const final = createHash('sha256')
      .update(readFileSync(join(broker.directory, 'config.json')))
      .digest('hex');
    expect(final).not.toBe(before);
    expect(broker.configurationDigest).toBe(final);
    expect(spawned[0]).toContain(final);
    expect(spawned[0]).not.toContain(before);
  });
  it('keeps a worker child response loss uncertain and never kills the worker', async () => {
    const f = await fixture('restart');
    effects.exec.mockImplementation(async () => {
      throw new Error('Fixture respawn response lost after dispatch');
    });
    expect(await f.deliver()).toBe('unknown');
    expect(commands().filter((command) => command.includes('respawn-pane'))).toHaveLength(1);
    expect(commands().filter((command) => command.includes('kill-'))).toHaveLength(0);
  });
});
