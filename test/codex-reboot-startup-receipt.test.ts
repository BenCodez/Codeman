/** Exact no-child startup receipts cannot release another launch's uncertainty. */
import { afterEach, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import type { CodexRestoreLaunchGuard, TerminalMultiplexer } from '../src/mux-interface.js';

const sessions: Session[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) {
    Object.assign(session, { _mux: null });
    await session.stop(false);
  }
});

function fixture() {
  const session = new Session({
    workingDir: '/tmp',
    mode: 'codex',
    useMux: true,
    codexConfig: { noDaemon: true },
    mux: {} as TerminalMultiplexer,
  });
  sessions.push(session);
  const evidence = { files: [], paths: [], missing: [] };
  const refused = vi.fn();
  session.setCodexRestoreLaunchGuard({
    prepare: async () => {},
    confirm: () => true,
    getStartupEvidence: () => evidence,
    isCurrent: () => true,
    noteBrokerRefusal: refused,
  });
  const guard = Reflect.get(session, '_codexRestoreGuard') as CodexRestoreLaunchGuard;
  return { session, guard, evidence, refused };
}

it('releases only a first startup certified to have created no child', () => {
  const { session, guard, refused } = fixture();
  guard.noteDispatch!();
  expect(session.codexRestoreWorkerMayExist).toBe(true);
  guard.noteBrokerRefusal!();
  expect(session.codexRestoreWorkerMayExist).toBe(false);
  expect(refused).toHaveBeenCalledOnce();
});

it('keeps an earlier unresolved startup sealed if another startup is refused', () => {
  const { session, guard, refused } = fixture();
  guard.noteDispatch!();
  guard.noteDispatch!();
  guard.noteBrokerRefusal!();
  expect(session.codexRestoreWorkerMayExist).toBe(true);
  expect(refused).not.toHaveBeenCalled();
});

it("does not release another guard registration's unresolved startup", () => {
  const { session, guard } = fixture();
  guard.noteDispatch!();
  session.setCodexRestoreLaunchGuard({ prepare: async () => {}, confirm: () => true });
  const replacement = Reflect.get(session, '_codexRestoreGuard') as CodexRestoreLaunchGuard;
  replacement.noteDispatch!();
  replacement.noteBrokerRefusal!();
  expect(session.codexRestoreWorkerMayExist).toBe(true);
});

it('ignores a refusal receipt when no startup was dispatched', () => {
  const { session, guard, refused } = fixture();
  guard.noteBrokerRefusal!();
  expect(session.codexRestoreWorkerMayExist).toBe(false);
  expect(refused).not.toHaveBeenCalled();
});

it.each(['before', 'after'] as const)('retains stale-guard dispatch uncertainty %s the new guard dispatch', (order) => {
  const { session, guard } = fixture();
  session.setCodexRestoreLaunchGuard({ prepare: async () => {}, confirm: () => true });
  const replacement = Reflect.get(session, '_codexRestoreGuard') as CodexRestoreLaunchGuard;
  if (order === 'before') guard.noteDispatch!();
  replacement.noteDispatch!();
  if (order === 'after') guard.noteDispatch!();
  replacement.noteBrokerRefusal!();
  expect(session.codexRestoreWorkerMayExist).toBe(true);
});

it('revokes old guard evidence and preparation when the registration is replaced', async () => {
  const { session, guard } = fixture();
  session.setCodexRestoreLaunchGuard({ prepare: async () => {}, confirm: () => true });
  expect(guard.getStartupEvidence!()).toBeUndefined();
  expect(await guard.confirm()).toBe(false);
  await expect(guard.prepare()).rejects.toThrow('authority changed');
});

it('refuses to export a startup proof after newer owner input', async () => {
  const { session, guard, evidence } = fixture();
  expect(await guard.confirm()).toBe(true);
  expect(guard.getStartupEvidence!()).toBe(evidence);
  session.trackUserInput('New owner intent');
  expect(guard.getStartupEvidence!()).toBeUndefined();
  expect(await guard.confirm()).toBe(false);
});

it('keeps the pure startup scope bound to the exact guard and newer owner intent', async () => {
  const { session, guard } = fixture();
  expect(guard.isCurrent!()).toBe(true);
  await session.fenceUntrackedInput();
  expect(guard.isCurrent!()).toBe(false);
  session.setCodexRestoreLaunchGuard({ prepare: async () => {}, confirm: () => true, isCurrent: () => true });
  expect(guard.isCurrent!()).toBe(false);
});

it('cannot release an uncertain cleanup with an earlier no-child receipt', () => {
  const { session, guard, refused } = fixture();
  guard.noteDispatch!();
  guard.noteCleanupUncertain!();
  guard.noteBrokerRefusal!();
  expect(session.codexRestoreWorkerMayExist).toBe(true);
  expect(refused).not.toHaveBeenCalled();
});

it('never lets a replaced guard release its pending startup uncertainty', () => {
  const { session, guard, refused } = fixture();
  guard.noteDispatch!();
  session.setCodexRestoreLaunchGuard({ prepare: async () => {}, confirm: () => true });
  guard.noteBrokerRefusal!();
  expect(session.codexRestoreWorkerMayExist).toBe(true);
  expect(refused).not.toHaveBeenCalled();
});
