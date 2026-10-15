import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CodexInputBroker } from '../src/recovery/codex-input-broker.js';
import { fakeInputProvenance, updateFakeInputProvenance } from './helpers/codex-input-provenance.js';
import { currentLocalCodexHome } from '../src/recovery/codex-home.js';
/** Real Session + real tmux input normalization, with an injected recording runner and no processes. */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { Session } from '../src/session.js';
import { TmuxManager } from '../src/tmux-manager.js';
import type { MuxSession } from '../src/mux-interface.js';
import { TaskController } from '../src/supervision/controller.js';
import { classifyCodexTail } from '../src/recovery/codex-classifier.js';
import { latestProgressMarker } from '../src/supervision/evidence.js';
import { CodexTaskAdapter } from '../src/supervision/adapter.js';
import { CodexRecoveryAdapter } from '../src/recovery/codex-adapter.js';
import * as codexIdentity from '../src/recovery/codex-identity.js';
import { commandHash } from '../src/supervision/evidence.js';
const nativeRead = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('A test runner must never read a real pane');
  })
);
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execSync: nativeRead,
}));
const THREAD = '11111111-2222-3333-4444-555555555555';
const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
let session: Session | undefined;
let controller: TaskController | undefined;
const brokerRoots: string[] = [];
afterEach(async () => {
  controller?.stop();
  await controller?.drain();
  await session?.stop(false);
  vi.restoreAllMocks();
  nativeRead.mockClear();
  for (const root of brokerRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const line = (at: number, payload: unknown) =>
  JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload }) + '\n';
// Decode POSIX shell quoting independently of the command builder. No process is executed.
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
describe('transport canonical task prompts', () => {
  it.each(['unchanged', 'missing-tail', 'generation-changed', 'malformed-command'])(
    'uses one coherent recovery snapshot for task evidence: %s',
    async (change) => {
      let generation = 1;
      const now = Date.now();
      const command = {
        call_id: 'acceptance',
        turn_id: 'task-turn',
        command: ['bash', '-lc', 'npm test'],
        cwd: '/fixture/workspace',
        parsed_cmd: [{ type: 'unknown', cmd: 'npm test' }],
        source: 'agent',
      };
      const tail =
        line(now - 4, { type: 'user_message', message: 'Authorized task' }) +
        line(now - 3, { type: 'task_started', turn_id: 'task-turn' }) +
        line(now - 2, { ...command, type: 'exec_command_begin', started_at_ms: now - 2 }) +
        line(now - 1, {
          ...command,
          type: 'exec_command_end',
          completed_at_ms: now - 1,
          exit_code: 0,
          duration: { secs: 0, nanos: 1_000_000 },
          status: change === 'malformed-command' ? 'future_status' : 'completed',
        }) +
        line(now, { type: 'task_complete', turn_id: 'task-turn' }) +
        line(now, { type: 'agent_message', message: 'CODEMAN_TASK_PROGRESS {"outcome":"completed"}' });
      const fakeSession = {
        id: SESSION,
        workingDir: '/fixture/workspace',
        getRecoveryContext: () => ({ generation, noDaemon: true, codexHome: '/fixture/codex-home' }),
      } as unknown as Session;
      vi.spyOn(CodexRecoveryAdapter.prototype, 'observe').mockImplementation(async () => {
        const observation = {
          ...classifyCodexTail(tail, {
            conversationId: THREAD,
            now,
            screen: '›\n',
            busy: false,
            watching: false,
            tailTruncated: false,
          }),
          processReady: true,
        };
        if (change === 'generation-changed') generation++;
        return observation;
      });
      const cachedTail = vi
        .spyOn(CodexRecoveryAdapter.prototype, 'getVerifiedTail')
        .mockReturnValue(change === 'missing-tail' ? undefined : tail);
      const secondScan = vi
        .spyOn(codexIdentity, 'resolveCodexIdentity')
        .mockRejectedValue(new Error('A task observation must not perform a second identity scan'));
      const result = await new CodexTaskAdapter(fakeSession, () => {}).observe();
      expect(secondScan).not.toHaveBeenCalled();
      if (change === 'unchanged') {
        expect(cachedTail).toHaveBeenCalledWith(THREAD);
        expect(result.observation.activity).toBe('completed');
        expect(result.commands.get(commandHash('npm test'))).toEqual({ startedAt: now - 2, completedAt: now - 1 });
        expect(result.marker?.progress).toEqual({ outcome: 'completed' });
      } else {
        expect(result.observation).toMatchObject({ activity: 'unknown', safeToAct: false });
        expect(result.commands.size).toBe(0);
        expect(result.marker).toBeUndefined();
      }
    }
  );

  it.each(['unchanged', 'blocked', 'unknown', 'malformed', 'checkpoint', 'submission', 'completed', 'owner-progress'])(
    'rechecks %s task evidence after the durable continuation reservation',
    async (change) => {
      let now = 10_000;
      let tail =
        line(9999, { type: 'user_message', message: 'Authorized task' }) +
        line(10_000, { type: 'task_started', turn_id: 'task-turn' }) +
        line(10_000, { type: 'task_complete', turn_id: 'task-turn' });
      const marker = (progress: unknown) =>
        line(now, {
          type: 'agent_message',
          message: 'CODEMAN_TASK_PROGRESS ' + JSON.stringify(progress),
        });
      const initialProgress = { outcome: 'unfinished', checkpoint: 'Verified step', nextAction: 'Run the check' };
      if (change !== 'owner-progress') tail += marker(initialProgress);
      const deliver = vi.fn(async () => 'sent' as const);
      const fakeSession = {
        id: SESSION,
        workingDir: '/fixture/workspace',
        getRecoveryContext: () => ({ generation: 1, noDaemon: true, codexHome: '/fixture/codex-home' }),
        deliverRecovery: deliver,
      } as unknown as Session;
      vi.spyOn(CodexRecoveryAdapter.prototype, 'observe').mockImplementation(async () => ({
        ...classifyCodexTail(tail, {
          conversationId: THREAD,
          now,
          screen: '›\n',
          busy: false,
          watching: false,
          tailTruncated: false,
        }),
        processReady: true,
      }));
      vi.spyOn(CodexRecoveryAdapter.prototype, 'getVerifiedTail').mockImplementation(() => tail);
      const adapter = new CodexTaskAdapter(fakeSession, () => {});
      const task = new TaskController({
        now: () => now,
        observe: () => adapter.observe(),
        act: (key, conversationId, prompt, current) => adapter.act(key, conversationId, prompt, current),
        changed: () => {},
        persist: async (state) => {
          if (state.reason !== 'continuation-reserved') return;
          now += 1;
          if (change === 'submission') tail += line(now, { type: 'user_message', message: 'New owner request' });
          else if (change === 'malformed')
            tail += line(now, { type: 'agent_message', message: 'CODEMAN_TASK_PROGRESS {broken' });
          else if (change === 'checkpoint') tail += marker({ ...initialProgress, checkpoint: 'Different step' });
          else if (!['unchanged', 'owner-progress'].includes(change)) tail += marker({ outcome: change });
        },
      });
      try {
        await task.update({
          objective: 'Finish the task',
          criteria: [{ id: 'review', description: 'Owner review', kind: 'manual' }],
          config: { enabled: true },
        });
        await task.progress(initialProgress as { outcome: 'unfinished'; checkpoint: string; nextAction: string });
        await task.refresh();
        const accepted = ['unchanged', 'owner-progress'].includes(change);
        expect(deliver).toHaveBeenCalledTimes(accepted ? 1 : 0);
        expect(task.getStatus().reason).toBe(accepted ? 'continuation-sent' : 'delivery-cancelled');
        expect(!!task.getStatus().inFlight).toBe(accepted);
      } finally {
        task.stop();
      }
    }
  );

  it('allows an explicit kickoff despite a historical blocked progress marker', async () => {
    const now = 10_000;
    const tail =
      line(9997, { type: 'user_message', message: 'Historical task' }) +
      line(9998, { type: 'task_complete', turn_id: 'previous-turn' }) +
      line(9999, { type: 'agent_message', message: 'CODEMAN_TASK_PROGRESS {"outcome":"blocked"}' });
    const deliver = vi.fn(async () => 'sent' as const);
    const fakeSession = {
      id: SESSION,
      workingDir: '/fixture/workspace',
      getRecoveryContext: () => ({ generation: 1, noDaemon: true, codexHome: '/fixture/codex-home' }),
      deliverRecovery: deliver,
    } as unknown as Session;
    vi.spyOn(CodexRecoveryAdapter.prototype, 'observe').mockImplementation(async () => ({
      ...classifyCodexTail(tail, {
        conversationId: THREAD,
        now,
        screen: '›\n',
        busy: false,
        watching: false,
        tailTruncated: false,
      }),
      processReady: true,
    }));
    vi.spyOn(CodexRecoveryAdapter.prototype, 'getVerifiedTail').mockReturnValue(tail);
    const adapter = new CodexTaskAdapter(fakeSession, () => {});
    const task = new TaskController({
      now: () => now,
      observe: () => adapter.observe(),
      act: (key, id, prompt, current) => adapter.act(key, id, prompt, current),
      persist: async () => {},
      changed: () => {},
    });
    try {
      await task.update({
        objective: 'Start new owner task',
        criteria: [{ id: 'review', description: 'Owner review', kind: 'manual' }],
      });
      await task.resume();
      expect(deliver).toHaveBeenCalledOnce();
      expect(task.getStatus().reason).toBe('kickoff-sent');
    } finally {
      task.stop();
    }
  });

  it('refuses an injected guarded runner without a composer reader before any native read or input', async () => {
    const commands = vi.fn(async (_command: string) => {});
    const mux = new TmuxManager(commands);
    mux.registerSession({
      sessionId: SESSION,
      muxName: 'codeman-aaaaaaaa',
      pid: 99999,
      createdAt: 10000,
      workingDir: '/tmp',
      mode: 'codex',
      attached: true,
      recoveryIsolated: true,
      recoveryCodexHome: currentLocalCodexHome(),
    } as MuxSession);
    const guard = {
      expectedLivePane: { paneId: '%7', panePid: 700 },
      confirm: () => true,
      noteDispatch: vi.fn(),
      noteRefusal: vi.fn(),
    };
    expect(await mux.sendInput(SESSION, 'Authorized task\r', guard)).toBe(false);
    expect(guard.noteRefusal).toHaveBeenCalledOnce();
    expect(guard.noteDispatch).not.toHaveBeenCalled();
    expect(commands).not.toHaveBeenCalled();
    expect(nativeRead).not.toHaveBeenCalled();
  });

  it.each([
    ['missing-reader', undefined],
    ['different-session', 'codeman-bbbbbbbb|%7|700|0||\n'],
    ['different-pane', 'codeman-aaaaaaaa|%8|700|0||\n'],
    ['different-process', 'codeman-aaaaaaaa|%7|701|0||\n'],
    ['dead-pane', 'codeman-aaaaaaaa|%7|700|1|1|\n'],
    ['live-exit-status', 'codeman-aaaaaaaa|%7|700|0|0|\n'],
    ['live-signal', 'codeman-aaaaaaaa|%7|700|0||KILL\n'],
    ['trailing-cr', 'codeman-aaaaaaaa|%7|700|0||\r\n'],
    ['unterminated', 'codeman-aaaaaaaa|%7|700|0||'],
    ['empty-reader', null],
  ] as const)(
    'refuses injected guarded input with %s native scope before any real read or input',
    async (_kind, frame) => {
      const commands = vi.fn(async () => ({ stdout: '' }));
      const composer = vi.fn(() => '›\n  example-model high · /tmp\n');
      const mux = new TmuxManager(commands, composer, frame === undefined ? undefined : () => frame);
      mux.registerSession({
        sessionId: SESSION,
        muxName: 'codeman-aaaaaaaa',
        pid: 99999,
        createdAt: 10_000,
        workingDir: '/tmp',
        mode: 'codex',
        attached: true,
        recoveryIsolated: true,
        recoveryCodexHome: currentLocalCodexHome(),
      } as MuxSession);
      const guard = {
        expectedLivePane: { paneId: '%7', panePid: 700 },
        confirm: () => true,
        noteDispatch: vi.fn(),
        noteRefusal: vi.fn(),
      };
      expect(await mux.sendInput(SESSION, 'Authorized fixture task\r', guard)).toBe(false);
      expect(guard.noteDispatch).not.toHaveBeenCalled();
      expect(guard.noteRefusal).toHaveBeenCalled();
      expect(commands).not.toHaveBeenCalled();
      expect(composer).not.toHaveBeenCalled();
      expect(nativeRead).not.toHaveBeenCalled();
    }
  );

  it('accepts both real kickoff and continuation bytes and processes subsequent structured progress', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const root = await fs.mkdtemp(join(homedir(), 'task-canonical-input-'));
    brokerRoots.push(root);
    const broker = await CodexInputBroker.create(root, SESSION, 'explicit fake worker', currentLocalCodexHome());
    const privateConfig = JSON.parse(await fs.readFile(join(broker.directory, 'config.json'), 'utf8'));
    const inputProof = fakeInputProvenance(
      { brokerPid: 700, childPid: 701, incarnation: broker.incarnation, launchDigest: privateConfig.launchDigest },
      currentLocalCodexHome()
    );
    inputProof.fileWitness!.path = join(broker.directory, 'state.json');
    updateFakeInputProvenance(inputProof, {}, (proof) => ({
      version: 1,
      sessionId: SESSION,
      incarnation: proof.incarnation,
      pid: proof.brokerPid,
      childPid: proof.childPid,
      brokerStart: proof.brokerStart,
      childStart: proof.childStart,
      tainted: false,
      rawGeneration: 0,
      launchDigest: proof.launchDigest,
      homeDigest: proof.homeDigest,
      closed: false,
      exitStatus: null,
      exitSignal: null,
      counters: { ...proof.ownerCounters, auto: 0, probe: 0 },
      receipts: [],
      startup: { nonce: privateConfig.startup.nonce, status: 'started' },
    }));
    const journalText = await fs.readFile(inputProof.fileWitness!.path, 'utf8');
    expect(await broker.readState()).toBeDefined();
    vi.spyOn(broker, 'prove').mockImplementation(async () => inputProof);
    vi.spyOn(broker, 'receipt').mockResolvedValue('sent');
    const delivered: string[] = [];
    let enters = 0;
    const screen = '›\n  example-model high · /tmp\n';
    let joinedScreen = screen;
    const captured: string[] = [];
    const mux = new TmuxManager(
      async (command) => {
        const tokens = shellWords(command);
        const conditional = tokens.indexOf('if-shell');
        expect(conditional).toBeGreaterThan(0);
        expect(tokens.slice(conditional + 1, conditional + 4)).toEqual(['-F', '-t', '%7']);
        const expected = {
          session_name: 'codeman-aaaaaaaa',
          pane_id: '%7',
          pane_pid: '700',
          pane_dead: '0',
          pane_dead_status: '',
          pane_dead_signal: '',
        };
        const terms = [...tokens[conditional + 4].matchAll(/#\{==:#\{([^}]+)\},([^}]*)\}/g)];
        expect(terms).toHaveLength(6);
        expect(terms.every((term) => expected[term[1] as keyof typeof expected] === term[2])).toBe(true);
        const send = shellWords(tokens[conditional + 5]);
        expect(send.slice(0, 3)).toEqual(['send-keys', '-t', '%7']);
        if (send[3] === '-l') {
          expect(send).toHaveLength(5);
          const match = send[4].match(/CODEMAN_INPUT_V1:([A-Za-z0-9+/=]+):[a-f0-9]{64}/);
          expect(match).not.toBeNull();
          const packet = JSON.parse(Buffer.from(match![1], 'base64').toString());
          expect(packet.channel).toBe('auto');
          expect(packet.conversationId).toBe(THREAD);
          const bytes = Buffer.from(packet.data, 'base64').toString();
          if (bytes === '\r') {
            enters++;
            joinedScreen = screen;
            return { stdout: '' };
          }
          delivered.push(bytes);
          joinedScreen = `› ${delivered.at(-1)}\n  example-model high · /tmp\n`;
        } else if (send[3] === 'Enter') {
          expect(send).toHaveLength(4);
          enters++;
          joinedScreen = screen;
        } else throw new Error('Unexpected fixture command');
        return { stdout: '' };
      },
      (muxName) => {
        expect(muxName).toBe('codeman-aaaaaaaa');
        captured.push(joinedScreen);
        return joinedScreen;
      },
      (muxName) => {
        expect(muxName).toBe('codeman-aaaaaaaa');
        return 'codeman-aaaaaaaa|%7|700|0||\n';
      }
    );
    const muxSession = {
      sessionId: SESSION,
      muxName: 'codeman-aaaaaaaa',
      pid: 700,
      recoveryInputBroker: broker.incarnation,
      createdAt: 10000,
      workingDir: '/tmp',
      mode: 'codex',
      attached: true,
      recoveryIsolated: true,
      recoveryCodexHome: currentLocalCodexHome(),
    } as MuxSession;
    mux.registerSession(muxSession);
    Reflect.get(mux, 'inputBrokers').set(SESSION, broker);
    vi.spyOn(mux, 'inspectPaneForRecovery').mockResolvedValue({
      paneId: '%7',
      panePid: 700,
      inputProvenance: inputProof,
      dead: false,
      screen,
      status: undefined,
      signal: undefined,
    });
    session = new Session({
      id: SESSION,
      workingDir: '/tmp',
      mode: 'codex',
      useMux: true,
      mux,
      muxSession,
      codexConfig: {
        noDaemon: true,
        model: 'example-model',
        reasoningEffort: 'high',
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
      },
    });
    expect(await session.ensureRecoveryIdentityFence()).toBe(true);
    session.pinRecoveryConversation(THREAD);
    let now = 10000;
    let tail =
      line(9998, { type: 'user_message', message: 'Earlier task' }) +
      line(9999, { type: 'task_complete', turn_id: 'previous' });
    controller = new TaskController({
      now: () => now,
      persist: async () => {},
      changed: () => {},
      observe: async () => ({
        observation: {
          ...classifyCodexTail(tail, { conversationId: THREAD, now, screen, busy: false, watching: false }),
          processReady: true,
        },
        commands: new Map(),
        marker: latestProgressMarker(tail, 10000, now),
      }),
      act: async (key, conversationId, prompt, isCurrent) =>
        session!.deliverRecovery(
          { action: 'continue', key, conversationId, startedAt: now },
          session!.getRecoveryContext().generation,
          isCurrent,
          prompt,
          Object.assign(async () => true, {
            getEvidenceSource: () => ({
              sessionId: SESSION,
              inputBroker: broker.authority(inputProof),
              files: [inputProof.fileWitness!],
              identity: {
                reason: 'verified' as const,
                conversationId: THREAD,
                path: inputProof.fileWitness!.path,
                tail: journalText,
                tailTruncated: false,
                witness: { paths: [{ ...inputProof.fileWitness!, kind: 'file' as const }] },
              },
              isCurrent: () => true,
            }),
          })
        ),
    });
    await controller.update({
      objective: "Fix the user's\r\nreported bug\nwithout duplicates",
      criteria: [{ id: 'review', description: 'Owner review', kind: 'manual' }],
    });
    tail += line(11500, {
      type: 'agent_message',
      message:
        'CODEMAN_TASK_PROGRESS ' +
        JSON.stringify({
          outcome: 'unfinished',
          checkpoint: 'Wrong prior-turn checkpoint',
          nextAction: 'Repeat earlier work',
        }),
    });
    await controller.resume();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).not.toMatch(/[\r\n]/);
    expect(delivered[0]).toContain("Fix the user's reported bug without duplicates");
    const kickoffFlight = controller.getStatus().inFlight!;
    // Another old-turn marker arrives after reservation with an allowed future timestamp.
    tail += line(11501, {
      type: 'agent_message',
      message:
        'CODEMAN_TASK_PROGRESS ' +
        JSON.stringify({
          outcome: 'unfinished',
          checkpoint: 'Stale startup marker',
          nextAction: 'Repeat earlier task',
        }),
    });
    now = 10003;
    tail +=
      line(10001, { type: 'user_message', message: delivered[0] }) +
      line(10002, { type: 'task_started', turn_id: 'kickoff' });
    await controller.refresh();
    expect(controller.getStatus().inFlight).toBeUndefined();
    expect(controller.getStatus().reason).toBe('continuation-accepted');
    expect(controller.getStatus().outcome).toBe('unknown');
    expect(controller.getStatus().checkpoint).toBe('');
    tail += line(10003, {
      type: 'agent_message',
      message:
        'CODEMAN_TASK_PROGRESS {"outcome":"unfinished","checkpoint":"Located the bug","nextAction":"Apply the fix"}',
    });
    now = 10004;
    await controller.refresh();
    expect(controller.getStatus().checkpoint).toBe('Located the bug');
    tail += line(10005, { type: 'task_complete', turn_id: 'kickoff' });
    now = 10006;
    await controller.refresh();
    expect(delivered).toHaveLength(2);
    expect(delivered[1]).not.toMatch(/[\r\n]/);
    expect(controller.getStatus().inFlight?.promptHash).toBeDefined();
    tail += line(11550, {
      type: 'agent_message',
      message:
        'CODEMAN_TASK_PROGRESS ' +
        JSON.stringify({
          outcome: 'unfinished',
          checkpoint: 'Stale prior-continuation marker',
          nextAction: 'Repeat old action',
        }),
    });
    tail +=
      line(10007, { type: 'user_message', message: delivered[1] }) +
      line(10008, { type: 'task_started', turn_id: 'continuation' });
    now = 10008;
    await controller.refresh();
    expect(controller.getStatus().outcome).toBe('unknown');
    expect(controller.getStatus().checkpoint).toBe('Located the bug');
    expect(controller.getStatus().inFlight).toBeUndefined();
    tail += line(10009, {
      type: 'agent_message',
      message:
        'CODEMAN_TASK_PROGRESS {"outcome":"unfinished","checkpoint":"Applied the fix","nextAction":"Request owner review"}',
    });
    now = 10010;
    await controller.refresh();
    expect(controller.getStatus().inFlight).toBeUndefined();
    expect(controller.getStatus().checkpoint).toBe('Applied the fix');
    expect(controller.getStatus().phase).toBe('watching');
    expect(enters).toBe(2);
    expect(captured).toEqual([
      screen,
      screen,
      `› ${delivered[0]}\n  example-model high · /tmp\n`,
      `› ${delivered[0]}\n  example-model high · /tmp\n`,
      screen,
      screen,
      `› ${delivered[1]}\n  example-model high · /tmp\n`,
      `› ${delivered[1]}\n  example-model high · /tmp\n`,
    ]);
    expect(kickoffFlight.promptHash).toBeDefined();
  });
});
