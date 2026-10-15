/** Plain capture cannot distinguish Codex's default placeholder from an identical owner draft. */
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { classifyCodexTail, hasCodexComposerText, hasEmptyCodexComposer } from '../src/recovery/codex-classifier.js';
import { RecoveryController } from '../src/recovery/controller.js';
import { initialRecoveryState } from '../src/recovery/types.js';
import type { TmuxManager as Manager } from '../src/tmux-manager.js';
import type { RecoveryMuxDispatchGuard } from '../src/mux-interface.js';

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
const INC = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
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
  const record = { sessionId: SID, muxName: 'codeman-aaaaaaaa', pid: 700, recoveryInputBroker: INC };
  const accepted: string[] = [];
  let current = screen(initial),
    pending = '',
    preparations = 0;
  const broker = {
    incarnation: INC,
    prove: async () => ({}),
    frame: (_channel: string, text: string) => {
      pending = text;
      return { data: 'SIGNED_FIXTURE', receipt: {} };
    },
    receipt: async () => 'sent',
  };
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
    if (!command.includes('if-shell') || !command.includes('send-keys')) throw Error('Unexpected native effect');
    accepted.push(pending);
    current = pending === '\r' ? screen() : screen(pending);
    return { stdout: '', stderr: '' };
  });
  const guard: RecoveryMuxDispatchGuard = {
    conversationId: THREAD,
    expectedLivePane: { paneId: '%7', panePid: 700 },
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
