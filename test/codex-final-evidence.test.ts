/** Real local Session and rollout reads, fake pane effects; never a live worker. */
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import type { MuxSession, TerminalMultiplexer } from '../src/mux-interface.js';
import { CodexRecoveryAdapter } from '../src/recovery/codex-adapter.js';
import type { RecoveryFlight } from '../src/recovery/types.js';
import { loadRebootIdentityFence } from '../src/recovery/reboot-identity-fence.js';
import { resolveCodexIdentity } from '../src/recovery/codex-identity.js';
import { fakeInputProvenance } from './helpers/codex-input-provenance.js';

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
for (const action of ['continue', 'restart'] as const) {
  it.each([
    'unchanged',
    'unrelated-existing',
    'child',
    'auth',
    'approval',
    'uncertainty',
    'malformed',
    'truncated',
    'history-conflict',
    'owned-identity-conflict',
  ])(`${action} rechecks %s evidence after the actual Session pane await`, async (change) => {
    const home = await fs.mkdtemp(join(homedir(), 'codex-final-evidence-'));
    const previousData = process.env.CODEMAN_DATA_DIR;
    process.env.CODEMAN_DATA_DIR = join(home, 'manager');
    const work = join(home, 'work');
    await fs.mkdir(work);
    await fs.mkdir(join(home, 'sessions'));
    const path = join(home, 'sessions', `rollout-2026-10-13T12-00-00-${THREAD}.jsonl`);
    const pane = {
      paneId: '%7',
      panePid: 700,
      dead: action === 'restart',
      status: action === 'restart' ? 1 : undefined,
      signal: undefined,
      screen: action === 'restart' ? null : '›\n  fixture-model default · /tmp\n',
      inputProvenance: fakeInputProvenance(
        { closed: action === 'restart', exitStatus: action === 'restart' ? 1 : undefined },
        home
      ),
    };
    let reads = 0;
    const mux = {
      isAvailable: () => true,
      getCodexInputAuthority: (_id: string, proof: typeof pane.inputProvenance) => ({
        sessionId: SESSION,
        incarnation: proof.incarnation,
        directory: '/fake-private-broker',
        proof,
      }),
      inspectPaneForRecovery: vi.fn(async () => {
        if (++reads === 3 && !['unchanged', 'unrelated-existing'].includes(change)) {
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
      inspectCodexInputProvenance: vi.fn(async () => pane.inputProvenance),
      sendInput: vi.fn(async () => true),
      respawnPane: vi.fn(async () => 99999),
      clearPaneExit: vi.fn(),
    };
    const muxSession: MuxSession = {
      sessionId: SESSION,
      muxName: 'codeman-aaaaaaaa',
      pid: 700,
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
      paneExit: action === 'restart' ? { at: NOW, status: 1 } : undefined,
    });
    try {
      expect(await session.ensureRecoveryIdentityFence()).toBe(true);
      session.trackUserInput('Initial owner request\r');
      await Reflect.get(session, '_recoveryFencePublication');
      expect(session.getRecoveryContext().switchPending).toBe(false);
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
            error: { message: 'Conversation interrupted.', codex_error_info: null },
          })
      );
      if (change === 'unrelated-existing') {
        const unrelated = '99999999-2222-3333-4444-555555555555';
        await fs.writeFile(
          join(home, 'sessions', `rollout-2026-10-13T12-00-01-${unrelated}.jsonl`),
          JSON.stringify({
            timestamp: new Date(NOW - 5000).toISOString(),
            type: 'session_meta',
            payload: { id: unrelated, cwd: work, originator: 'unrelated-owned-fixture' },
          }) + '\n'
        );
        const currentHistory = await fs.readFile(join(home, 'history.jsonl'), 'utf8');
        await fs.writeFile(
          join(home, 'history.jsonl'),
          JSON.stringify({
            session_id: unrelated,
            ts: (NOW - 4000) / 1000,
            text: 'Different owner request',
          }) +
            '\n' +
            currentHistory
        );
      }
      const adapter = new CodexRecoveryAdapter(session, () => {});
      const observed = await adapter.observe();
      expect(observed.safeToAct).toBe(true);
      const flight: RecoveryFlight = { key: observed.evidenceKey!, conversationId: THREAD, action, startedAt: NOW };
      const permitted = ['unchanged', 'unrelated-existing'].includes(change);
      expect(await adapter.act(flight)).toBe(permitted ? 'sent' : 'not-sent');
      if (change.endsWith('conflict')) {
        expect(
          await resolveCodexIdentity({
            sessionId: SESSION,
            workingDir: work,
            codexHome: home,
            noDaemon: true,
            resumeId: THREAD,
            submission,
          })
        ).toMatchObject({ reason: 'ambiguous' });
      }
      expect(reads).toBe(3);
      expect(mux.sendInput).toHaveBeenCalledTimes(permitted && action === 'continue' ? 1 : 0);
      expect(mux.respawnPane).toHaveBeenCalledTimes(permitted && action === 'restart' ? 1 : 0);
      if (permitted && action === 'restart')
        expect(mux.respawnPane).toHaveBeenCalledWith(
          expect.objectContaining({
            onlyIfDead: true,
            expectedRecoveryPane: {
              paneId: '%7',
              panePid: 700,
              status: 1,
              signal: undefined,
              paneSignalToken: undefined,
              inputProvenance: pane.inputProvenance,
            },
            codexConfig: expect.objectContaining({
              noDaemon: true,
              resumeSessionId: THREAD,
              sandbox: 'workspace-write',
              approvalPolicy: 'on-request',
            }),
          })
        );
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
      await fs.rm(home, { recursive: true, force: true });
    }
  });
}
