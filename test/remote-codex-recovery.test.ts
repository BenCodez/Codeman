/** @fileoverview Pure SSH command/protocol tests. No remote process, socket or tmux is touched. */
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type { SessionRemote } from '../src/types.js';
import { buildRemoteLaunchCommand } from '../src/tmux-manager.js';
import { TaskController } from '../src/supervision/controller.js';
import {
  buildRemoteCodexEvidenceCommand,
  buildRemoteCodexInputCommand,
  buildRemoteCodexRestartCommand,
  classifyRemoteCodexExecFailure,
  deliverRemoteCodexInput,
  inspectRemoteCodex,
  parseRemoteCodexAction,
  parseRemoteCodexEvidence,
  parseRemoteCodexInputResult,
  MAX_REMOTE_CODEX_PROMPT_BYTES,
  type RemoteCodexEvidenceRequest,
} from '../src/recovery/remote-codex.js';

const execFileAsync = promisify(execFile);

const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const THREAD = '11111111-2222-3333-4444-555555555555';
const remote: SessionRemote = {
  hostId: 'fixture-host',
  label: 'Fixture',
  host: 'worker.invalid',
  username: 'runner',
  port: 2207,
  remotePath: '/srv/work tree',
  identityFile: '/keys/fixture identity',
  jumpHost: 'jump.invalid:2222',
  socksProxy: '127.0.0.1:1080',
  extraSshOptions: ['StrictHostKeyChecking=yes'],
  owned: true,
};

function frame(value: object): string {
  return `login banner\nCODEMAN_REMOTE_CODEX_V1:${Buffer.from(JSON.stringify(value)).toString('base64')}\n`;
}

describe('remote Codex evidence protocol', () => {
  it('preserves every SSH connection option and sends request data as one encoded token', () => {
    const command = buildRemoteCodexEvidenceCommand(remote, {
      sessionId: SESSION,
      workingDir: remote.remotePath,
      codexHome: '/srv/custom codex',
      resumeId: THREAD,
    });
    expect(command).toContain('-p 2207');
    expect(command).toContain("-i '/keys/fixture identity'");
    expect(command).toContain("-J 'jump.invalid:2222'");
    expect(command).toContain('ProxyCommand=nc -X 5 -x 127.0.0.1:1080 %h %p');
    expect(command).toContain("-o 'StrictHostKeyChecking=yes'");
    expect(command).toContain('runner@worker.invalid');
    expect(command).not.toContain('/srv/custom codex');
    expect(command).not.toContain(THREAD);
  });

  it('parses one bounded marked result and ignores an untrusted login banner', () => {
    const tail = '{"type":"event_msg"}\n';
    expect(
      parseRemoteCodexEvidence(
        frame({
          v: 1,
          session: 'present',
          pane: {
            dead: false,
            paneId: '%3',
            panePid: 42,
            screen: Buffer.from('›\n').toString('base64'),
          },
          identity: {
            reason: 'verified',
            conversationId: THREAD,
            tail: Buffer.from(tail).toString('base64'),
            tailTruncated: false,
            changedAt: 123,
          },
        })
      )
    ).toEqual({
      transport: 'reachable',
      session: 'present',
      pane: { dead: false, paneId: '%3', panePid: 42, screen: '›\n' },
      identity: { reason: 'verified', conversationId: THREAD, tail, tailTruncated: false, changedAt: 123 },
    });
  });

  it('fails closed on duplicate markers, malformed pane identity and incomplete rollout tails', () => {
    const good = frame({
      v: 1,
      session: 'missing',
      identity: {
        reason: 'verified',
        conversationId: THREAD,
        tail: Buffer.from('{}\n').toString('base64'),
        tailTruncated: false,
      },
    });
    expect(parseRemoteCodexEvidence(good + good)).toBeUndefined();
    expect(
      parseRemoteCodexEvidence(
        frame({
          v: 1,
          session: 'present',
          pane: { dead: true, paneId: 'foreign', panePid: 1 },
          identity: { reason: 'unverified' },
        })
      )
    ).toBeUndefined();
    expect(
      parseRemoteCodexEvidence(
        frame({
          v: 1,
          session: 'missing',
          identity: {
            reason: 'verified',
            conversationId: THREAD,
            tail: Buffer.from('{}').toString('base64'),
            tailTruncated: false,
          },
        })
      )
    ).toBeUndefined();
  });

  it.each([
    { dead: 'false', paneId: '%3', panePid: 42, screen: '' },
    { dead: false, paneId: '%3', panePid: 42, status: -1, screen: '' },
    { dead: false, paneId: '%3', panePid: 42, signal: 65_536, screen: '' },
    { dead: true, paneId: '%3', panePid: 42, screen: 'unexpected' },
  ])('rejects malformed typed pane fields: %j', (pane) => {
    expect(
      parseRemoteCodexEvidence(
        frame({
          v: 1,
          session: 'present',
          pane,
          identity: {
            reason: 'verified',
            conversationId: THREAD,
            tail: Buffer.from('{}\n').toString('base64'),
            tailTruncated: false,
            changedAt: 123,
          },
        })
      )
    ).toBeUndefined();
  });

  it('rejects private identity fields on non-verified records', () => {
    expect(
      parseRemoteCodexEvidence(
        frame({
          v: 1,
          session: 'missing',
          identity: { reason: 'unverified', conversationId: THREAD },
        })
      )
    ).toBeUndefined();
    expect(
      parseRemoteCodexEvidence(
        frame({
          v: 1,
          session: 'missing',
          identity: { reason: 'unverified', tailTruncated: false },
        })
      )
    ).toBeUndefined();
  });

  it('requires an explicit boolean truncation signal for verified rollout tails', () => {
    const identity = {
      reason: 'verified',
      conversationId: THREAD,
      tail: Buffer.from('{}\n').toString('base64'),
      changedAt: 123,
    };
    expect(parseRemoteCodexEvidence(frame({ v: 1, session: 'missing', identity }))).toBeUndefined();
    expect(
      parseRemoteCodexEvidence(frame({ v: 1, session: 'missing', identity: { ...identity, tailTruncated: 'false' } }))
    ).toBeUndefined();
    expect(
      parseRemoteCodexEvidence(frame({ v: 1, session: 'missing', identity: { ...identity, tailTruncated: true } }))
    ).toMatchObject({ identity: { tailTruncated: true } });
  });

  it('validates input receipt timestamps and rejects records beyond both framing bounds', () => {
    const evidence = {
      v: 1,
      session: 'missing',
      identity: {
        reason: 'verified',
        conversationId: THREAD,
        tail: Buffer.from('{}\n').toString('base64'),
        tailTruncated: false,
        changedAt: 123,
      },
    };
    expect(parseRemoteCodexInputResult(frame({ ...evidence, action: 'sent', actionAt: 123 }))).toEqual({
      status: 'sent',
      submittedAt: 123,
    });
    expect(parseRemoteCodexInputResult(frame({ ...evidence, action: 'sent' }))).toBeUndefined();
    expect(parseRemoteCodexInputResult(frame({ ...evidence, action: 'sent', actionAt: 1.5 }))).toBeUndefined();
    expect(parseRemoteCodexInputResult(frame({ ...evidence, action: 'not-sent', actionAt: 123 }))).toBeUndefined();
    expect(parseRemoteCodexEvidence(frame({ ...evidence, padding: 'x'.repeat(513 * 1024) }))).toBeUndefined();
    expect(parseRemoteCodexEvidence(`${'x'.repeat(768 * 1024)}\n${frame(evidence)}`)).toBeUndefined();
  });

  it('executes the generated bounded reader against fixtures and follows exact current submission history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeman-remote-proof-'));
    try {
      const home = join(root, 'codex-home Ω');
      const sessions = join(home, 'sessions', '2026', '10', '13');
      const bin = join(root, 'bin');
      await mkdir(sessions, { recursive: true });
      await mkdir(bin);
      const older = THREAD;
      const resumed = '66666666-7777-8888-9999-aaaaaaaaaaaa';
      const rollout = async (id: string, originator: string, timestamp: string) => {
        const header = {
          timestamp,
          type: 'session_meta',
          payload: { id, timestamp, cwd: remote.remotePath, originator },
        };
        const text = `${JSON.stringify(header)}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`;
        const file = join(sessions, `rollout-${timestamp}-${id}.jsonl`);
        await writeFile(file, text);
        return { file, text };
      };
      await rollout(older, `codeman_${SESSION}`, '2026-10-13T10:00:00.000Z');
      const resumedRollout = await rollout(resumed, 'codex-tui', '2026-10-13T10:01:00.000Z');
      const submittedAt = Date.parse('2026-10-13T10:02:00.000Z');
      const prompt = 'exact fixture prompt\nwith preserved whitespace';
      const hash = createHash('sha256').update(prompt, 'utf8').digest('hex');
      await writeFile(
        join(home, 'history.jsonl'),
        `${JSON.stringify({ session_id: resumed, ts: submittedAt / 1000, text: prompt })}\n`
      );
      const fakeTmux = join(bin, 'tmux');
      const fakeSsh = join(bin, 'ssh');
      const fakeLoginShell = join(bin, 'login-shell');
      const paneFile = join(root, 'pane');
      const screenFile = join(root, 'screen');
      const actionLog = join(root, 'actions');
      const promptFile = join(root, 'last-prompt');
      await writeFile(paneFile, '0|||%7|4242\n');
      await writeFile(screenFile, '›\n');
      await writeFile(actionLog, '');
      await writeFile(
        fakeTmux,
        `#!/bin/sh\ncase "$*" in\n  *has-session*) exit 0 ;;\n  *list-panes*) cat "$FIXTURE_PANE_FILE" ;;\n  *capture-pane*) cat "$FIXTURE_SCREEN_FILE" ;;\n  *send-keys*)\n    printf '%s\\n' "$*" >> "$FIXTURE_ACTION_LOG"\n    for arg do last="$arg"; done\n    if [ "$4" = "-l" ]; then\n      [ -n "$FIXTURE_LITERAL_DELAY" ] && sleep "$FIXTURE_LITERAL_DELAY"\n      node -e 'require("fs").writeFileSync(process.env.FIXTURE_PROMPT_FILE,process.argv[1])' "$last"\n    elif [ "$last" = "Enter" ] && [ "$FIXTURE_APPEND_HISTORY" = "1" ]; then\n      node -e 'const fs=require("fs");fs.appendFileSync(process.env.FIXTURE_HISTORY_FILE,JSON.stringify({session_id:process.env.FIXTURE_HISTORY_SESSION,ts:Date.now()/1000,text:fs.readFileSync(process.env.FIXTURE_PROMPT_FILE,"utf8")})+"\\n")'\n    fi\n    ;;\n  *respawn-pane*) printf '%s\\n' "$*" >> "$FIXTURE_ACTION_LOG" ;;\n  *) exit 2 ;;\nesac\n`
      );
      await chmod(fakeTmux, 0o755);
      await writeFile(
        fakeSsh,
        '#!/bin/sh\nfor arg do last="$arg"; done\nif [ -n "$FIXTURE_SSH_ACK_DELAY" ]; then\n  output=$(/bin/sh -c "$last")\n  status=$?\n  sleep "$FIXTURE_SSH_ACK_DELAY"\n  printf \'%s\\n\' "$output"\n  exit "$status"\nfi\nexec /bin/sh -c "$last"\n'
      );
      await writeFile(
        fakeLoginShell,
        '#!/bin/sh\n[ "$1" = -i ] && [ "$2" = -l ] && [ "$3" = -c ]\nexec /bin/sh -c "$4"\n'
      );
      await Promise.all([chmod(fakeSsh, 0o755), chmod(fakeLoginShell, 0o755)]);
      const request = {
        sessionId: SESSION,
        workingDir: remote.remotePath,
        codexHome: home,
        resumeId: older,
        submission: { at: submittedAt, hash },
      };
      const run = async (value: RemoteCodexEvidenceRequest, ambientCodexHome = home) => {
        const command = buildRemoteCodexEvidenceCommand(remote, value);
        const { stdout } = await execFileAsync('/bin/sh', ['-c', command], {
          env: {
            ...process.env,
            CODEX_HOME: ambientCodexHome,
            PATH: `${bin}:${process.env.PATH}`,
            SHELL: fakeLoginShell,
            FIXTURE_PANE_FILE: paneFile,
            FIXTURE_SCREEN_FILE: screenFile,
            FIXTURE_ACTION_LOG: actionLog,
            FIXTURE_PROMPT_FILE: promptFile,
          },
          timeout: 5_000,
          maxBuffer: 768 * 1024,
        });
        return parseRemoteCodexEvidence(stdout);
      };

      expect(await run({ ...request, codexHome: undefined })).toMatchObject({
        transport: 'reachable',
        session: 'present',
        identity: { reason: 'verified', conversationId: resumed, tailTruncated: false },
        pane: { dead: false, paneId: '%7', panePid: 4242, screen: '›\n' },
      });
      expect(await run(request, 'relative/ignored-because-explicit')).toMatchObject({
        transport: 'reachable',
        identity: { reason: 'verified', conversationId: resumed },
      });
      await expect(run({ ...request, codexHome: undefined }, 'relative/codex-home')).rejects.toThrow('unreadable');
      await expect(run({ ...request, codexHome: undefined }, `/${'x'.repeat(4097)}`)).rejects.toThrow('unreadable');
      expect(await run({ ...request, submission: { ...request.submission, hash: '0'.repeat(64) } })).toMatchObject({
        identity: { reason: 'unverified' },
      });
      await expect(run({ ...request, submission: undefined })).rejects.toThrow('unverified');

      const runCommand = async (command: string, ambientCodexHome = home, extraEnv: Record<string, string> = {}) => {
        const { stdout } = await execFileAsync('/bin/sh', ['-c', command], {
          env: {
            ...process.env,
            CODEX_HOME: ambientCodexHome,
            PATH: `${bin}:${process.env.PATH}`,
            SHELL: fakeLoginShell,
            FIXTURE_PANE_FILE: paneFile,
            FIXTURE_SCREEN_FILE: screenFile,
            FIXTURE_ACTION_LOG: actionLog,
            FIXTURE_PROMPT_FILE: promptFile,
            ...extraEnv,
          },
          timeout: 10_000,
          maxBuffer: 768 * 1024,
        });
        return stdout;
      };
      const runAction = async (command: string, ambientCodexHome = home) =>
        parseRemoteCodexAction(await runCommand(command, ambientCodexHome));
      const runInput = async (command: string, extraEnv: Record<string, string> = {}) =>
        parseRemoteCodexInputResult(await runCommand(command, home, extraEnv));
      const expectedIdentity = {
        conversationId: resumed,
        tailHash: createHash('sha256').update(resumedRollout.text, 'utf8').digest('hex'),
      };
      const inputRequest = {
        ...request,
        resumeId: resumed,
        expected: {
          ...expectedIdentity,
          paneId: '%7',
          panePid: 4242,
          screenHash: createHash('sha256').update('›\n', 'utf8').digest('hex'),
        },
        prompt: 'Continue the sanitized fixture task.',
      };
      expect(
        await runInput(buildRemoteCodexInputCommand(remote, { ...inputRequest, codexHome: undefined }))
      ).toMatchObject({ status: 'sent', submittedAt: expect.any(Number) });
      expect(await (await import('node:fs/promises')).readFile(actionLog, 'utf8')).toContain(
        'Continue the sanitized fixture task.'
      );
      await writeFile(actionLog, '');
      const delayedPrompt = 'Record the remote send instant before this delayed acknowledgement.';
      const delayedHash = createHash('sha256').update(delayedPrompt, 'utf8').digest('hex');
      const delayedReceipt = await runInput(
        buildRemoteCodexInputCommand(remote, { ...inputRequest, prompt: delayedPrompt }),
        {
          FIXTURE_APPEND_HISTORY: '1',
          FIXTURE_HISTORY_FILE: join(home, 'history.jsonl'),
          FIXTURE_HISTORY_SESSION: resumed,
          FIXTURE_LITERAL_DELAY: '0.75',
          FIXTURE_SSH_ACK_DELAY: '3',
        }
      );
      expect(delayedReceipt).toMatchObject({ status: 'sent', submittedAt: expect.any(Number) });
      if (!delayedReceipt || delayedReceipt.status !== 'sent') throw new Error('expected a sent remote input receipt');
      const acknowledgedAt = Date.now();
      expect(acknowledgedAt - delayedReceipt.submittedAt).toBeGreaterThanOrEqual(2_500);
      const delayedHistory = (await (await import('node:fs/promises')).readFile(join(home, 'history.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { ts: number; text: string })
        .at(-1);
      expect(delayedHistory?.text).toBe(delayedPrompt);
      expect(Math.abs((delayedHistory?.ts ?? 0) * 1000 - delayedReceipt.submittedAt)).toBeLessThan(500);
      expect(
        await run({
          ...request,
          resumeId: resumed,
          submission: { at: delayedReceipt.submittedAt, hash: delayedHash },
        })
      ).toMatchObject({ identity: { reason: 'verified', conversationId: resumed } });
      expect(
        await run({ ...request, resumeId: resumed, submission: { at: acknowledgedAt, hash: delayedHash } })
      ).toMatchObject({ identity: { reason: 'unverified' } });
      await writeFile(actionLog, '');
      const injectionMarker = join(root, 'must-not-exist');
      const injection = `$(touch ${injectionMarker})`;
      let largePrompt = '';
      const task = new TaskController({
        persist: async () => {},
        changed: () => {},
        observe: async () => ({
          observation: {
            activity: 'completed',
            reason: 'turn-completed',
            at: Date.now(),
            conversationId: resumed,
            turnId: 'fixture-turn',
            processReady: true,
            safeToAct: false,
          },
          commands: new Map(),
        }),
        act: async (_key, _conversationId, prompt) => {
          largePrompt = prompt;
          return 'sent';
        },
      });
      await task.update({
        objective: 'Complete the bounded remote fixture task with safe Unicode Ω 😀 and a tab\t.',
        criteria: Array.from({ length: 9 }, (_, index) => ({
          id: `criterion-${index}`,
          description: 'd'.repeat(1000),
          kind: 'command' as const,
          command: index === 0 ? `${'c'.repeat(1000 - injection.length)}${injection}` : 'c'.repeat(1000),
        })),
      });
      await task.resume();
      task.stop();
      expect(Buffer.byteLength(largePrompt, 'utf8')).toBeGreaterThan(16 * 1024);
      expect(
        await runInput(buildRemoteCodexInputCommand(remote, { ...inputRequest, prompt: largePrompt }))
      ).toMatchObject({ status: 'sent', submittedAt: expect.any(Number) });
      await expect(access(injectionMarker)).rejects.toThrow();
      await writeFile(actionLog, '');
      await writeFile(screenFile, '› owner draft\n');
      expect(await runInput(buildRemoteCodexInputCommand(remote, inputRequest))).toEqual({ status: 'not-sent' });
      expect(await (await import('node:fs/promises')).readFile(actionLog, 'utf8')).toBe('');
      await writeFile(screenFile, '›\n');
      await writeFile(
        resumedRollout.file,
        `${resumedRollout.text}${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n`
      );
      expect(await runInput(buildRemoteCodexInputCommand(remote, inputRequest))).toEqual({ status: 'not-sent' });
      expect(await (await import('node:fs/promises')).readFile(actionLog, 'utf8')).toBe('');
      await writeFile(resumedRollout.file, resumedRollout.text);
      await writeFile(paneFile, '1|17||%7|4242\n');
      const restartRequest = {
        sessionId: SESSION,
        resumeId: resumed,
        submission: request.submission,
        expectedIdentity,
        expectedPane: { paneId: '%7', panePid: 4242, status: 17 },
        codexConfig: { noDaemon: true, resumeSessionId: resumed, model: 'fixture-model' },
        codexHome: home,
      };
      expect(
        await runAction(buildRemoteCodexRestartCommand(remote, restartRequest), join(root, 'missing ambient home'))
      ).toBe('sent');
      expect(await (await import('node:fs/promises')).readFile(actionLog, 'utf8')).toContain('respawn-pane');
      await writeFile(actionLog, '');
      await writeFile(paneFile, '0|||%7|4242\n');
      expect(await runAction(buildRemoteCodexRestartCommand(remote, restartRequest))).toBe('not-sent');
      expect(await (await import('node:fs/promises')).readFile(actionLog, 'utf8')).toBe('');

      const emptyLargeEvent = `${JSON.stringify({
        type: 'event_msg',
        payload: { type: 'fixture_near_limit', detail: '' },
      })}\n`;
      const targetTailBytes = 262_131;
      const paddingBytes = targetTailBytes - Buffer.byteLength(resumedRollout.text + emptyLargeEvent, 'utf8');
      const nearLimitTail = `${resumedRollout.text}${JSON.stringify({
        type: 'event_msg',
        payload: { type: 'fixture_near_limit', detail: 'x'.repeat(paddingBytes) },
      })}\n`;
      const nearLimitScreen = `${'s'.repeat(65_534)}\n`;
      expect(Buffer.byteLength(nearLimitTail, 'utf8')).toBe(targetTailBytes);
      expect(Buffer.byteLength(nearLimitScreen, 'utf8')).toBe(65_535);
      await writeFile(resumedRollout.file, nearLimitTail);
      await writeFile(screenFile, nearLimitScreen);
      const nearLimitEvidence = await run(request);
      expect(nearLimitEvidence).toMatchObject({
        identity: { reason: 'verified', conversationId: resumed, tail: nearLimitTail, tailTruncated: false },
        pane: { dead: false, screen: nearLimitScreen },
      });
      const nearLimitInput = {
        ...inputRequest,
        expected: {
          ...inputRequest.expected,
          tailHash: createHash('sha256').update(nearLimitTail, 'utf8').digest('hex'),
          screenHash: createHash('sha256').update(nearLimitScreen, 'utf8').digest('hex'),
        },
        prompt: 'Acknowledge the near-limit bounded protocol fixture.',
      };
      expect(await runInput(buildRemoteCodexInputCommand(remote, nearLimitInput))).toMatchObject({
        status: 'sent',
        submittedAt: expect.any(Number),
      });

      const hiddenChild = `${JSON.stringify({
        timestamp: '2026-10-13T10:03:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'collab_agent_spawn_end',
          call_id: 'fixture-spawn',
          new_thread_id: '77777777-8888-4999-8aaa-bbbbbbbbbbbb',
          status: 'running',
        },
      })}\n`;
      const oversizedMiddle = `${JSON.stringify({
        timestamp: '2026-10-13T10:03:01.000Z',
        type: 'event_msg',
        payload: { type: 'fixture_padding', detail: 'x'.repeat(270_000) },
      })}\n`;
      const apparentlyCompleteSuffix =
        `${JSON.stringify({
          timestamp: '2026-10-13T10:03:02.000Z',
          type: 'event_msg',
          payload: { type: 'task_started', turn_id: 'fixture-after-truncation' },
        })}\n` +
        `${JSON.stringify({
          timestamp: '2026-10-13T10:03:03.000Z',
          type: 'event_msg',
          payload: { type: 'task_complete', turn_id: 'fixture-after-truncation' },
        })}\n`;
      await writeFile(
        resumedRollout.file,
        `${resumedRollout.text}${hiddenChild}${oversizedMiddle}${apparentlyCompleteSuffix}`
      );
      const truncatedEvidence = await run(request);
      expect(truncatedEvidence).toMatchObject({
        identity: {
          reason: 'verified',
          conversationId: resumed,
          tailTruncated: true,
          tail: apparentlyCompleteSuffix,
        },
      });
      if (
        !truncatedEvidence ||
        truncatedEvidence.transport !== 'reachable' ||
        truncatedEvidence.identity.reason !== 'verified' ||
        truncatedEvidence.identity.tail === undefined
      ) {
        throw new Error('expected verified truncated remote evidence');
      }
      const truncatedTailHash = createHash('sha256').update(truncatedEvidence.identity.tail, 'utf8').digest('hex');
      const truncatedInput = {
        ...inputRequest,
        expected: {
          ...inputRequest.expected,
          tailHash: truncatedTailHash,
          screenHash: createHash('sha256').update(nearLimitScreen, 'utf8').digest('hex'),
        },
      };
      await writeFile(actionLog, '');
      expect(await runInput(buildRemoteCodexInputCommand(remote, truncatedInput))).toEqual({ status: 'not-sent' });
      expect(await (await import('node:fs/promises')).readFile(actionLog, 'utf8')).toBe('');

      await writeFile(paneFile, '1|17||%7|4242\n');
      expect(
        await runAction(
          buildRemoteCodexRestartCommand(remote, {
            ...restartRequest,
            expectedIdentity: { conversationId: resumed, tailHash: truncatedTailHash },
          })
        )
      ).toBe('not-sent');
      expect(await (await import('node:fs/promises')).readFile(actionLog, 'utf8')).toBe('');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('throws before real SSH IO under vitest', async () => {
    await expect(
      inspectRemoteCodex(remote, { sessionId: SESSION, workingDir: remote.remotePath, resumeId: THREAD })
    ).rejects.toThrow('injected fixture');
  });

  it('accepts bounded Unicode/control bytes and refuses oversized or malformed prompts before SSH', async () => {
    const base = {
      sessionId: SESSION,
      workingDir: remote.remotePath,
      codexHome: '/srv/custom codex',
      resumeId: THREAD,
      submission: { at: Date.parse('2026-10-13T10:02:00.000Z'), hash: 'a'.repeat(64) },
      expected: {
        conversationId: THREAD,
        tailHash: 'b'.repeat(64),
        paneId: '%7',
        panePid: 4242,
        screenHash: 'c'.repeat(64),
      },
    };
    const exactLimit = '😀'.repeat(MAX_REMOTE_CODEX_PROMPT_BYTES / 4);
    expect(Buffer.byteLength(exactLimit, 'utf8')).toBe(MAX_REMOTE_CODEX_PROMPT_BYTES);
    expect(buildRemoteCodexInputCommand(remote, { ...base, prompt: exactLimit })).not.toContain(exactLimit);
    const oversized = { ...base, prompt: `${'x'.repeat(MAX_REMOTE_CODEX_PROMPT_BYTES)}😀` };
    expect(() => buildRemoteCodexInputCommand(remote, oversized)).toThrow(RangeError);
    await expect(deliverRemoteCodexInput(remote, oversized)).resolves.toEqual({ status: 'not-sent' });
    await expect(deliverRemoteCodexInput(remote, { ...base, prompt: 'bad\0prompt' })).resolves.toEqual({
      status: 'not-sent',
    });
    await expect(deliverRemoteCodexInput(remote, { ...base, prompt: '\ud800' })).resolves.toEqual({
      status: 'not-sent',
    });
  });

  it('distinguishes network reachability, authentication, and missing inspector prerequisites', () => {
    expect(classifyRemoteCodexExecFailure({ code: 255, stderr: 'ssh: connect: No route to host' })).toMatchObject({
      transport: 'unreachable',
    });
    expect(classifyRemoteCodexExecFailure({ code: 255, stderr: 'Permission denied (publickey).' })).toMatchObject({
      transport: 'unavailable',
    });
    expect(classifyRemoteCodexExecFailure({ code: 127, stderr: 'zsh: command not found: node' })).toMatchObject({
      transport: 'reachable',
      session: 'unknown',
      identity: { reason: 'unsupported' },
    });
    expect(classifyRemoteCodexExecFailure({ code: 1, stderr: 'spawnSync tmux ENOENT' })).toMatchObject({
      transport: 'reachable',
      identity: { reason: 'unsupported' },
    });
  });
});

describe('remote Codex launch and exact dead-pane replacement', () => {
  it('carries isolated launch flags, exact resume id, custom home and originator across SSH', () => {
    const command = buildRemoteLaunchCommand({
      mode: 'codex',
      remote,
      sessionId: SESSION,
      codexConfig: {
        noDaemon: true,
        noAltScreen: true,
        resumeSessionId: THREAD,
        model: 'fixture-model',
        reasoningEffort: 'high',
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
      },
      envOverrides: { CODEX_HOME: '/srv/custom codex' },
    });
    expect(command).toContain('--no-daemon');
    expect(command).toContain('--no-alt-screen');
    expect(command).toContain(`resume ${THREAD}`);
    expect(command).toContain('--model fixture-model');
    expect(command).toContain('model_reasoning_effort=high');
    expect(command).toContain('CODEX_HOME=');
    expect(command).toContain('/srv/custom codex');
    expect(command).toContain(`CODEX_INTERNAL_ORIGINATOR_OVERRIDE=`);
    expect(command).toContain(`codeman_${SESSION}`);

    const inheritedHome = buildRemoteLaunchCommand({
      mode: 'codex',
      remote,
      sessionId: SESSION,
      codexConfig: { noDaemon: true, resumeSessionId: THREAD },
    });
    expect(inheritedHome).not.toContain('CODEX_HOME=');
  });

  it('rechecks one exact dead pane, omits kill-live-pane, and preserves SSH/config bytes', () => {
    const command = buildRemoteCodexRestartCommand(remote, {
      sessionId: SESSION,
      resumeId: THREAD,
      submission: { at: Date.parse('2026-10-13T10:02:00.000Z'), hash: 'a'.repeat(64) },
      expectedIdentity: { conversationId: THREAD, tailHash: 'b'.repeat(64) },
      expectedPane: { paneId: '%8', panePid: 808, status: 17 },
      codexConfig: { noDaemon: true, resumeSessionId: THREAD, model: 'fixture-model' },
      codexHome: '/srv/custom codex',
    });
    expect(command).toContain('-p 2207');
    expect(command).toContain("-J 'jump.invalid:2222'");
    expect(command).not.toContain('1|17||%8|808');
    expect(command).not.toMatch(/respawn-pane\s+-k/);
    expect(command).not.toContain(THREAD);
    expect(command).not.toContain('/srv/custom codex');
  });
});
