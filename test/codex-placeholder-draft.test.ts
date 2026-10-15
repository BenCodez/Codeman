/** Plain capture cannot distinguish Codex's default placeholder from an identical owner draft. */
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { classifyCodexTail, hasCodexComposerText, hasEmptyCodexComposer } from '../src/recovery/codex-classifier.js';
import { RecoveryController } from '../src/recovery/controller.js';
import { initialRecoveryState } from '../src/recovery/types.js';
import type { TmuxManager as Manager } from '../src/tmux-manager.js';
import type { RecoveryMuxDispatchGuard } from '../src/mux-interface.js';
import { CodexInputBroker } from '../src/recovery/codex-input-broker.js';
import { fakeInputProvenance } from './helpers/codex-input-provenance.js';

const effects = vi.hoisted(() => ({ exec: vi.fn(), sync: vi.fn() }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const denied = () => {
    throw Error('Unmocked process effect forbidden');
  };
  const exec = () => {
    throw Error('Unmocked process effect forbidden');
  };
  Object.defineProperty(exec, Symbol.for('nodejs.util.promisify.custom'), { value: effects.exec });
  return {
    ...actual,
    exec,
    execSync: effects.sync,
    execFile: denied,
    execFileSync: denied,
    spawn: denied,
    spawnSync: denied,
    fork: denied,
  };
});
const PLACEHOLDER = 'Ask Codex to do anything';
const THREAD = '11111111-2222-3333-4444-555555555555';
const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const NOW = Date.UTC(2026, 9, 15, 12);
const screen = (text = '') => `› ${text}\n  fixture-model high · /fixture/work\n`;
const body =
  [
    {
      timestamp: new Date(NOW - 30000).toISOString(),
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'exact-turn' },
    },
    {
      timestamp: new Date(NOW - 20000).toISOString(),
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'exact-turn',
        error: { message: 'Conversation interrupted.', codex_error_info: null },
      },
    },
  ]
    .map((row) => JSON.stringify(row))
    .join('\n') + '\n';
let TmuxManager: typeof import('../src/tmux-manager.js').TmuxManager;
beforeAll(async () => {
  const prior = process.env.VITEST;
  delete process.env.VITEST;
  try {
    ({ TmuxManager } = await import('../src/tmux-manager.js'));
  } finally {
    if (prior !== undefined) process.env.VITEST = prior;
  }
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  effects.exec.mockReset();
  effects.sync.mockReset();
});
function classify(text: string) {
  return classifyCodexTail(body, {
    conversationId: THREAD,
    now: NOW,
    screen: screen(text),
    busy: false,
    watching: false,
    tailTruncated: false,
  });
}
it.each([PLACEHOLDER, ` ${PLACEHOLDER}`, `${PLACEHOLDER} `])(
  'never treats plain placeholder-like text as empty (%s)',
  (text) => {
    expect(hasEmptyCodexComposer(screen(text))).toBe(false);
    expect(classify(text)).toMatchObject({ activity: 'interrupted', safeToAct: false });
  }
);
it('still acknowledges the exact known text of our own guarded input', () => {
  expect(hasCodexComposerText(screen(PLACEHOLDER), PLACEHOLDER)).toBe(true);
  expect(hasEmptyCodexComposer(screen())).toBe(true);
  expect(classify('')).toMatchObject({ activity: 'interrupted', safeToAct: true });
});
it.each(['', PLACEHOLDER])('manual Retry respects actual classified composer evidence (%s)', async (text) => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const state = initialRecoveryState();
  state.armedAt = NOW; // Older failure is intentionally eligible only for manual Retry.
  const act = vi.fn(async () => 'sent' as const);
  const controller = new RecoveryController(
    { observe: async () => classify(text), act, persist: async () => {}, changed: () => {}, now: () => Date.now() },
    state
  );
  try {
    await controller.retry();
    vi.setSystemTime(NOW + 2000);
    await controller.retry();
    expect(act).toHaveBeenCalledTimes(text ? 0 : 1);
    expect(controller.getStatus().attempts).toBe(text ? 0 : 1);
  } finally {
    controller.stop();
    await controller.drain();
  }
});
function nativeFixture(initial: string, prompt = 'Authorized fixture continuation', lateDraft = false) {
  const manager = Object.create(TmuxManager.prototype) as Manager;
  const material = CodexInputBroker.provisioningMaterial(SID, 'Explicit fixture worker', '/fixture/home');
  const proof = fakeInputProvenance({ incarnation: material.config.incarnation, brokerPid: 700, childPid: 701 });
  const broker = CodexInputBroker.fromRemoteMaterial('/fixture/private-broker', material, {
    version: 1,
    sessionId: SID,
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
  vi.spyOn(broker, 'receipt').mockResolvedValue('sent');
  const record = { sessionId: SID, muxName: 'codeman-aaaaaaaa', pid: 700, recoveryInputBroker: broker.incarnation };
  const accepted: string[] = [];
  const buffers = new Map<string, string>();
  let current = screen(initial),
    preparations = 0;
  vi.spyOn(
    manager as unknown as { loadBrokerInputBuffer(name: string, data: string): Promise<void> },
    'loadBrokerInputBuffer'
  ).mockImplementation(async (name, data) => {
    buffers.set(name, data);
  });
  for (const [name, value] of Object.entries({
    sessions: new Map([[SID, record]]),
    inputBrokers: new Map([[SID, broker]]),
    inputBrokerLoads: new Map(),
    inputQueues: new Map(),
    tmuxSocket: 'fixture-socket',
  }))
    Reflect.set(manager, name, value);
  effects.sync.mockImplementation((command: string) => {
    if (command.includes('capture-pane')) return current;
    if (command.includes('display-message')) return 'codeman-aaaaaaaa|%7|700|0||\n';
    throw Error('Unexpected native read');
  });
  effects.exec.mockImplementation(async (command: string) => {
    if (!command.includes('if-shell') || !command.includes('paste-buffer -r -d'))
      throw Error('Unexpected native effect');
    const name = command.match(/codeman-private-[a-f0-9-]+/)![0];
    const wire = buffers.get(name)!;
    expect(wire.startsWith('\x1eCODEMAN_INPUT_V1:')).toBe(true);
    expect(command).not.toContain(wire);
    const packet = JSON.parse(Buffer.from(wire.split(':')[1], 'base64').toString());
    const pending = Buffer.from(packet.data, 'base64').toString();
    buffers.delete(name);
    accepted.push(pending);
    current = pending === '\r' ? screen() : screen(pending);
    return { stdout: '', stderr: '' };
  });
  const guard: RecoveryMuxDispatchGuard = {
    conversationId: THREAD,
    expectedLivePane: { paneId: '%7', panePid: 700 },
    inputProof: proof,
    confirm: () => true,
    prepareEvidence: async () => {
      if (++preparations === 2 && lateDraft) current = screen(PLACEHOLDER);
      return true;
    },
    noteDispatch: vi.fn(),
    noteRefusal: vi.fn(),
  };
  return { accepted, guard, deliver: () => manager.sendInput(SID, prompt + '\r', guard) };
}
it.each(['initial', 'after-proof'] as const)(
  'final native admission preserves a literal owner draft at %s',
  async (stage) => {
    const f = nativeFixture(
      stage === 'initial' ? PLACEHOLDER : '',
      'Authorized fixture continuation',
      stage === 'after-proof'
    );
    expect(await f.deliver()).toBe(false);
    expect(f.accepted).toEqual([]);
    expect(f.guard.noteDispatch).not.toHaveBeenCalled();
    expect(f.guard.noteRefusal).toHaveBeenCalled();
  }
);
it.each(['Authorized fixture continuation', PLACEHOLDER])(
  'native healthy empty composer accepts known managed text (%s)',
  async (prompt) => {
    const f = nativeFixture('', prompt);
    expect(await f.deliver()).toBe(true);
    expect(f.accepted).toEqual([prompt, '\r']);
    expect(f.guard.noteDispatch).toHaveBeenCalledTimes(2);
  }
);
