/** Scoped broker receipts distinguish no-child-effect refusal from uncertain partial delivery. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import type { MuxSession, RecoveryMuxDispatchGuard, TerminalMultiplexer } from '../src/mux-interface.js';
import type { RecoveryFlight } from '../src/recovery/types.js';

const THREAD = '11111111-2222-3333-4444-555555555555';
const sessions: Session[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) {
    Object.assign(session, { _muxSession: null, _mux: null });
    await session.stop(false);
  }
  vi.unstubAllEnvs();
});

it.each([
  { receipt: 'first-refusal', expected: 'not-sent' },
  { receipt: 'partial-then-refusal', expected: 'unknown' },
  { receipt: 'reserved', expected: 'unknown' },
  { receipt: 'lost', expected: 'unknown' },
  { receipt: 'sent', expected: 'sent' },
])('returns $expected after a certified $receipt broker outcome', async ({ receipt, expected }) => {
  vi.stubEnv('CODEMAN_MULTIUSER', '0');
  const phases: string[] = [];
  const pane = {
    paneId: '%7',
    panePid: 700,
    dead: false,
    screen: '› \n  fixture-model default · /tmp\n',
  };
  const mux = {
    inspectPaneForRecovery: vi.fn(async () => pane),
    sendInput: vi.fn(async (_id: string, _input: string, guard: RecoveryMuxDispatchGuard) => {
      expect(guard.conversationId).toBe(THREAD);
      expect(guard.confirm()).toBe(true);
      guard.noteDispatch();
      phases.push('control-frame');
      if (receipt === 'first-refusal') guard.noteBrokerRefusal?.();
      if (receipt === 'partial-then-refusal') {
        guard.noteBrokerSent?.();
        phases.push('child-literal');
        guard.noteDispatch();
        guard.noteBrokerRefusal?.();
      }
      if (receipt === 'sent') {
        guard.noteBrokerSent?.();
        phases.push('child-submission');
      }
      if (receipt === 'lost') throw new Error('Isolated lost receipt');
      return receipt === 'sent';
    }),
  };
  const session = new Session({
    workingDir: '/tmp',
    mode: 'codex',
    useMux: true,
    codexConfig: { noDaemon: true, resumeSessionId: THREAD },
    mux: mux as unknown as TerminalMultiplexer,
    muxSession: {
      muxName: 'codeman-receipt-fixture',
      recoveryIsolated: true,
      recoveryCodexHome: join(homedir(), '.codex'),
    } as MuxSession,
  });
  sessions.push(session);
  expect(await session.ensureRecoveryIdentityFence()).toBe(true);
  const context = session.getRecoveryContext();
  expect(context).toMatchObject({ managed: true, noDaemon: true, switchPending: false });
  const flight: RecoveryFlight = {
    key: 'fixture-evidence',
    conversationId: THREAD,
    action: 'continue',
    reason: 'turn-failed',
    startedAt: Date.now(),
    attempts: 1,
  } as unknown as RecoveryFlight;
  expect(await session.deliverRecovery(flight, context.generation)).toBe(expected);
  expect(mux.sendInput).toHaveBeenCalledOnce();
  expect(phases).toContain('control-frame');
  if (expected === 'not-sent') expect(phases).not.toContain('child-literal');
  expect(session.recoveryInputReserved).toBe(false);
});
