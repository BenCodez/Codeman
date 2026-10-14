/** Real Session, resolver, adapter, controller and journal; pane/process effects are fakes. */
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import { Session } from '../../src/session.js';
import type { TerminalMultiplexer, MuxSession } from '../../src/mux-interface.js';
import { CodexRecoveryAdapter } from '../../src/recovery/codex-adapter.js';
import { RecoveryController } from '../../src/recovery/controller.js';
import { RecoveryStore } from '../../src/recovery/store.js';
import { initialRecoveryState } from '../../src/recovery/types.js';

export const CHILD_NOW = Date.UTC(2026, 9, 13, 12);
export const CHILD_THREAD = '019a5aa0-1111-7111-8111-111111111111';
export const CHILD_ID = '019a5aa0-2222-7222-8222-222222222222';
export const CHILD_SESSION = '019a5aa0-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
export const CHILD_READY = '› \n  fixture-model default · /fixture/workspace\n';
export const CHILD_ERROR = { message: 'Conversation interrupted.', codex_error_info: null };

export function childEvent(payload: Record<string, unknown>, age: number): string {
  return JSON.stringify({ timestamp: new Date(CHILD_NOW - age).toISOString(), type: 'event_msg', payload });
}

export function returnedChildTail(type: string, status: unknown = 'running', fail = false): string {
  return (
    [
      childEvent({ type: 'task_started', turn_id: 'first' }, 55_000),
      childEvent({ type: 'collab_agent_spawn_end', new_thread_id: CHILD_ID, status: 'running' }, 54_000),
      childEvent({ type: 'collab_wait_end', statuses: { [CHILD_ID]: { completed: null } } }, 53_000),
      childEvent({ type: 'task_complete', turn_id: 'first' }, 52_000),
      childEvent({ type: 'task_started', turn_id: 'current' }, 30_000),
      childEvent(
        type.includes('wait')
          ? { type, statuses: { [CHILD_ID]: status } }
          : { type, receiver_thread_id: CHILD_ID, status },
        25_000
      ),
      ...(fail ? [childEvent({ type: 'task_complete', turn_id: 'current', error: CHILD_ERROR }, 24_000)] : []),
    ].join('\n') + '\n'
  );
}

export async function createChildLifecycleFixture(
  body: string,
  dead: boolean,
  storedExit = dead,
  trackedSubmission = true
) {
  const root = await fs.mkdtemp(join(homedir(), 'codex-child-lifecycle-'));
  const workspace = join(root, 'workspace');
  const codexHome = join(root, 'codex');
  await fs.mkdir(workspace);
  await fs.mkdir(join(codexHome, 'sessions'), { recursive: true });
  const path = join(codexHome, 'sessions', `rollout-2026-10-13T12-00-00-${CHILD_THREAD}.jsonl`);
  const header = JSON.stringify({
    timestamp: new Date(CHILD_NOW - 60_000).toISOString(),
    type: 'session_meta',
    payload: { id: CHILD_THREAD, cwd: workspace, originator: `codeman_${CHILD_SESSION}` },
  });
  const pane = { paneId: '%7', panePid: 700, dead, ...(dead ? { status: 9 } : {}), screen: dead ? null : CHILD_READY };
  const mux = { inspectPaneForRecovery: vi.fn(async () => pane) };
  const session = new Session({
    id: CHILD_SESSION,
    workingDir: workspace,
    owner: 'fixture-owner',
    mode: 'codex',
    useMux: true,
    mux: mux as unknown as TerminalMultiplexer,
    muxSession: {
      muxName: 'codeman-child-fixture',
      recoveryIsolated: true,
      recoveryCodexHome: codexHome,
    } as MuxSession,
    codexConfig: { noDaemon: true, resumeSessionId: CHILD_THREAD },
    envOverrides: { CODEX_HOME: codexHome },
    ...(storedExit ? { paneExit: { at: CHILD_NOW - 20_000, status: 9 } } : {}),
  });
  const prompt = 'Sanitized child lifecycle owner request';
  if (trackedSubmission) {
    // Establish the real owner-input proof before the fixture's existing work,
    // without delivering any bytes or changing the caller's fake timer clock.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(CHILD_NOW - 60_000);
    try {
      session.trackUserInput(prompt + '\r');
    } finally {
      clock.mockRestore();
    }
    const submission = session.getRecoveryContext().submission;
    expect(submission).toMatchObject({ at: CHILD_NOW - 60_000 });
    await fs.writeFile(
      join(codexHome, 'history.jsonl'),
      JSON.stringify({ session_id: CHILD_THREAD, ts: submission!.at / 1000, text: prompt }) + '\n'
    );
  }
  await fs.writeFile(
    path,
    `${header}\n${trackedSubmission ? childEvent({ type: 'user_message', message: prompt }, 60_000) + '\n' : ''}${body}`
  );
  expect(session.getRecoveryContext()).toMatchObject({ managed: true, noDaemon: true, switchPending: false });
  const delivered = vi.spyOn(session, 'deliverRecovery').mockResolvedValue('sent');
  const adapter = new CodexRecoveryAdapter(session, vi.fn());
  const store = new RecoveryStore(join(root, 'recovery.json'));
  const state = initialRecoveryState();
  state.config = { ...state.config, enabled: true, detectStalls: true, stalledAfterMs: 10_000, retryDelayMs: 1000 };
  state.armedAt = CHILD_NOW - 60_000;
  const controller = new RecoveryController(
    {
      observe: () => adapter.observe(),
      act: (flight, isCurrent) => adapter.act(flight, isCurrent),
      persist: (next) => store.save(session.id, next),
      changed: vi.fn(),
    },
    state
  );
  return {
    session,
    adapter,
    controller,
    delivered,
    store,
    async cleanup() {
      controller.stop();
      await controller.drain();
      delivered.mockRestore();
      await session.stop(false);
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
