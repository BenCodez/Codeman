/** Real local Session and rollout reads, fake pane effects; never a live worker. */
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import type { MuxSession, TerminalMultiplexer } from '../src/mux-interface.js';
import { CodexTaskAdapter } from '../src/supervision/adapter.js';

const NOW = Date.UTC(2026, 9, 13, 12);
const THREAD = '11111111-2222-3333-4444-555555555555';
const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const event = (payload: unknown) =>
  JSON.stringify({ timestamp: new Date(NOW).toISOString(), type: 'event_msg', payload }) + '\n';
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());
it.each([
  'unchanged',
  'child',
  'auth',
  'approval',
  'uncertainty',
  'malformed',
  'truncated',
  'marker',
  'history-conflict',
  'owned-identity-conflict',
])('task continuation rechecks %s after the actual Session pane await', async (change) => {
  const home = await fs.mkdtemp(join(homedir(), 'codex-final-evidence-'));
  const work = join(home, 'work');
  await fs.mkdir(work);
  await fs.mkdir(join(home, 'sessions'));
  const path = join(home, 'sessions', `rollout-2026-10-13T12-00-00-${THREAD}.jsonl`);
  const pane = {
    dead: false,
    status: undefined,
    signal: undefined,
    screen: '›\n  fixture-model default · /tmp\n',
  };
  let reads = 0;
  const mux = {
    isAvailable: () => true,
    inspectPaneForRecovery: vi.fn(async () => {
      if (++reads === 3 && change !== 'unchanged') {
        const additions: Record<string, string> = {
          child: event({ type: 'collab_agent_spawn_begin', call_id: 'new-child' }),
          auth: event({
            type: 'error',
            message: 'Sanitized authentication fixture.',
            codex_error_info: 'Unauthorized',
          }),
          approval: event({ type: 'exec_approval_request', call_id: 'new-approval' }),
          uncertainty: event({
            type: 'error',
            message: 'Sanitized control fixture.',
            codex_error_info: 'thread_rollback_failed',
          }),
          marker: event({ type: 'agent_message', message: 'CODEMAN_TASK_PROGRESS {"outcome":"blocked"}' }),
          malformed: '{partial-fixture}\n',
          truncated: JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(300 * 1024) } }) + '\n',
        };
        if (change === 'history-conflict') {
          await fs.appendFile(
            join(home, 'history.jsonl'),
            JSON.stringify({
              session_id: '99999999-2222-3333-4444-555555555555',
              ts: NOW / 1000,
              text: 'Initial owner request',
            }) + '\n'
          );
        } else if (change === 'owned-identity-conflict') {
          const other = '99999999-2222-3333-4444-555555555555';
          await fs.writeFile(
            join(home, 'sessions', `rollout-2026-10-13T12-00-01-${other}.jsonl`),
            JSON.stringify({
              timestamp: new Date(NOW + 1000).toISOString(),
              type: 'session_meta',
              payload: { id: other, cwd: work, originator: `codeman_${SESSION}` },
            }) + '\n'
          );
        } else await fs.appendFile(path, additions[change]);
      }
      return { ...pane };
    }),
    sendInput: vi.fn(async () => true),
    respawnPane: vi.fn(async () => 99999),
    clearPaneExit: vi.fn(),
  };
  const muxSession: MuxSession = {
    sessionId: SESSION,
    muxName: 'codeman-aaaaaaaa',
    pid: 99999,
    createdAt: NOW,
    workingDir: work,
    mode: 'codex',
    attached: true,
    recoveryIsolated: true,
    recoveryCodexHome: home,
  };
  const session = new Session({
    id: SESSION,
    workingDir: work,
    mode: 'codex',
    mux: mux as unknown as TerminalMultiplexer,
    muxSession,
    useMux: true,
    codexConfig: {
      noDaemon: true,
      resumeSessionId: THREAD,
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
    },
    envOverrides: { CODEX_HOME: home },
    paneExit: undefined,
  });
  try {
    session.trackUserInput('Initial owner request\r');
    const submission = session.getRecoveryContext().submission;
    expect(submission).toBeDefined();
    await fs.writeFile(
      join(home, 'history.jsonl'),
      JSON.stringify({ session_id: THREAD, ts: submission!.at / 1000, text: 'Initial owner request' }) + '\n'
    );
    await fs.writeFile(
      path,
      JSON.stringify({
        timestamp: new Date(NOW - 1000).toISOString(),
        type: 'session_meta',
        payload: { id: THREAD, cwd: work, originator: `codeman_${SESSION}` },
      }) +
        '\n' +
        event({ type: 'user_message', message: 'Initial owner request' }) +
        event({ type: 'task_started', turn_id: 'fixture-turn' }) +
        event({
          type: 'task_complete',
          turn_id: 'fixture-turn',
        })
    );
    const adapter = new CodexTaskAdapter(session, () => {});
    const { observation } = await adapter.observe();
    expect(observation.activity).toBe('completed');
    expect(observation.processReady).toBe(true);
    expect(await adapter.act(`${THREAD}:task:fixture-turn`, THREAD, 'Continue the owner task', () => true)).toBe(
      change === 'unchanged' ? 'sent' : 'not-sent'
    );
    expect(reads).toBe(3);
    expect(mux.sendInput).toHaveBeenCalledTimes(change === 'unchanged' ? 1 : 0);
    expect(mux.respawnPane).toHaveBeenCalledTimes(0);
  } finally {
    await session.stop(false);
    await fs.rm(home, { recursive: true, force: true });
  }
});
