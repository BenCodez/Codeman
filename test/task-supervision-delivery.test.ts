import { currentLocalCodexHome } from '../src/recovery/codex-home.js';
/** Real Session + real tmux input normalization, with an injected recording runner and no processes. */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Session } from '../src/session.js';
import { TmuxManager } from '../src/tmux-manager.js';
import type { MuxSession } from '../src/mux-interface.js';
import { TaskController } from '../src/supervision/controller.js';
import { classifyCodexTail } from '../src/recovery/codex-classifier.js';
import { commandHash, latestProgressMarker } from '../src/supervision/evidence.js';
import { CodexTaskAdapter } from '../src/supervision/adapter.js';
import type { CodexRecoveryAdapterDeps } from '../src/recovery/codex-adapter.js';
import type { RemoteCodexEvidence } from '../src/recovery/remote-codex.js';
import { buildRemoteCodexInputCommand } from '../src/recovery/remote-codex.js';
import { CodexRecoveryAdapter } from '../src/recovery/codex-adapter.js';
import * as codexIdentity from '../src/recovery/codex-identity.js';
const THREAD = '11111111-2222-3333-4444-555555555555';
const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
let session: Session | undefined;
let controller: TaskController | undefined;
afterEach(async () => {
  controller?.stop();
  await controller?.drain();
  await session?.stop(false);
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const line = (at: number, payload: unknown) =>
  JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload }) + '\n';
describe('transport canonical task prompts', () => {
  it.each(['unchanged', 'missing-tail', 'generation-changed'])(
    'uses one coherent recovery snapshot for task evidence: %s',
    async (change) => {
      let generation = 1;
      const now = Date.now();
      const tail =
        line(now - 4, { type: 'user_message', message: 'Authorized task' }) +
        line(now - 3, { type: 'task_started', turn_id: 'task-turn' }) +
        line(now - 2, { type: 'exec_command_begin', call_id: 'acceptance', command: ['bash', '-lc', 'npm test'] }) +
        line(now - 1, { type: 'exec_command_end', call_id: 'acceptance', exit_code: 0 }) +
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

  it.each(
    ['unchanged', 'blocked', 'unknown', 'malformed', 'checkpoint', 'submission', 'completed', 'owner-progress'].flatMap(
      (change) => ['local', 'remote'].map((transport) => ({ change, transport }))
    )
  )(
    'rechecks $transport $change task evidence after the durable continuation reservation',
    async ({ change, transport }) => {
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
        remote: transport === 'remote' ? { owned: true } : undefined,
        deliverRecovery:
          transport === 'remote'
            ? vi.fn(async () => {
                throw new Error('No local fallback');
              })
            : deliver,
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
      vi.spyOn(CodexRecoveryAdapter.prototype, 'deliverRemotePrompt').mockImplementation(async () => deliver());
      vi.spyOn(codexIdentity, 'resolveCodexIdentity').mockRejectedValue(
        new Error('Task delivery must use the recovery observation rather than another identity scan')
      );
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
        if (transport === 'remote') {
          expect(fakeSession.deliverRecovery).not.toHaveBeenCalled();
          expect(codexIdentity.resolveCodexIdentity).not.toHaveBeenCalled();
        }
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

  it('accepts both real kickoff and continuation bytes and processes subsequent structured progress', async () => {
    const delivered: string[] = [];
    let enters = 0;
    const mux = new TmuxManager(async (command) => {
      const literal = command.match(/ -l ('[\s\S]*')$/)?.[1];
      if (literal) delivered.push(literal.slice(1, -1).split("'\\''").join("'"));
      else if (command.endsWith(' Enter')) enters++;
      else throw new Error('Unexpected fixture command');
    });
    const muxSession = {
      sessionId: SESSION,
      muxName: 'codeman-aaaaaaaa',
      pid: 99999,
      createdAt: 10000,
      workingDir: '/tmp',
      mode: 'codex',
      attached: true,
      recoveryIsolated: true,
      recoveryCodexHome: currentLocalCodexHome(),
    } as MuxSession;
    mux.registerSession(muxSession);
    const screen = '›\n  example-model high · /tmp\n';
    vi.spyOn(mux, 'inspectPaneForRecovery').mockResolvedValue({
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
          prompt
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
    expect(kickoffFlight.promptHash).toBeDefined();
  });

  it('routes remote kickoff and continuation through guarded SSH delivery at the real Session boundary', async () => {
    const mux = new TmuxManager(async () => {
      throw new Error('local mux input must not carry remote task prompts');
    });
    const muxSession = {
      sessionId: SESSION,
      muxName: 'codeman-aaaaaaaa',
      pid: 99999,
      createdAt: Date.now(),
      workingDir: '/tmp',
      mode: 'codex',
      attached: true,
      recoveryIsolated: true,
    } as MuxSession;
    mux.registerSession(muxSession);
    vi.spyOn(mux, 'inspectPaneForRecovery').mockResolvedValue({
      dead: false,
      screen: 'ssh attached',
      status: undefined,
      signal: undefined,
    });
    const screen = '›\n  fixture-model high · /tmp\n';
    let tail =
      line(Date.now() - 2000, { type: 'task_started', turn_id: 'turn-1' }) +
      line(Date.now() - 1000, { type: 'task_complete', turn_id: 'turn-1' });
    let tailTruncated: boolean | undefined = true;
    const evidence = (): RemoteCodexEvidence => ({
      transport: 'reachable',
      session: 'present',
      pane: { dead: false, paneId: '%7', panePid: 700, screen },
      identity: {
        reason: 'verified',
        conversationId: THREAD,
        tail,
        tailTruncated,
        changedAt: Date.now() - 1000,
      },
    });
    const delivered: string[] = [];
    const deps: CodexRecoveryAdapterDeps = {
      inspectRemote: vi.fn(async () => evidence()),
      restartRemote: vi.fn(async () => 'not-sent'),
      deliverRemote: vi.fn(async (_remote, request) => {
        expect(() => buildRemoteCodexInputCommand(_remote, request)).not.toThrow();
        delivered.push(request.prompt);
        return { status: 'sent', submittedAt: Date.now() };
      }),
    };
    session = new Session({
      id: SESSION,
      workingDir: '/tmp',
      mode: 'codex',
      useMux: true,
      mux,
      muxSession,
      remote: {
        hostId: 'fixture-host',
        label: 'Fixture',
        host: 'fixture.invalid',
        username: 'runner',
        remotePath: '/tmp',
        owned: true,
      },
      codexConfig: { noDaemon: true, resumeSessionId: THREAD },
      envOverrides: { CODEX_HOME: '/fixture/codex-home' },
    });
    session.trackUserInput('Initial owner request\r');
    const adapter = new CodexTaskAdapter(session, () => {}, deps);
    controller = new TaskController({
      persist: async () => {},
      changed: () => {},
      observe: () => adapter.observe(),
      act: (key, conversationId, prompt, isCurrent) => adapter.act(key, conversationId, prompt, isCurrent),
    });
    await controller.update({
      objective: 'Complete the bounded remote fixture task.',
      criteria: Array.from({ length: 9 }, (_, index) => ({
        id: `criterion-${index}`,
        description: 'd'.repeat(1000),
        kind: 'command' as const,
        command: 'c'.repeat(1000),
      })),
    });
    await controller.resume();
    expect(controller.getStatus().phase).toBe('paused');
    expect(controller.getStatus().kickoffAt).toBeUndefined();
    expect(controller.getStatus().inFlight).toBeUndefined();
    expect(delivered).toEqual([]);

    tailTruncated = false;
    await controller.resume();
    const kickoff = delivered[0];
    expect(Buffer.byteLength(kickoff, 'utf8')).toBeGreaterThan(16 * 1024);
    expect(delivered).toEqual([kickoff]);
    expect(session.getRecoveryContext().submission?.hash).toBe(
      createHash('sha256').update(kickoff, 'utf8').digest('hex')
    );

    const verifiedCommand = 'printf remote-paired-evidence';
    const commandStartedAt = Date.now() - 800;
    const commandCompletedAt = Date.now() - 500;
    tail =
      line(commandStartedAt, {
        type: 'exec_command_begin',
        call_id: 'remote-command',
        command: ['/bin/sh', '-lc', verifiedCommand],
      }) +
      line(commandCompletedAt, { type: 'exec_command_end', call_id: 'remote-command', exit_code: 0 }) +
      line(Date.now() - 200, { type: 'task_started', turn_id: 'turn-with-command' }) +
      line(Date.now() - 100, { type: 'task_complete', turn_id: 'turn-with-command' });
    expect((await adapter.observe()).commands.get(commandHash(verifiedCommand))).toEqual({
      startedAt: commandStartedAt,
      completedAt: commandCompletedAt,
    });

    tail =
      line(Date.now() - 1000, { type: 'task_started', turn_id: 'turn-2' }) +
      line(Date.now(), { type: 'task_complete', turn_id: 'turn-2' });
    await adapter.observe();
    expect(await adapter.act(`${THREAD}:task:turn-2`, THREAD, 'Sanitized remote continuation prompt', () => true)).toBe(
      'sent'
    );
    expect(delivered).toEqual([kickoff, 'Sanitized remote continuation prompt']);
    expect(mux.inspectPaneForRecovery).toHaveBeenCalled();
  });

  it('does not recover a remote crash whose exact live proof predates task supervision', async () => {
    vi.useFakeTimers();
    const observedLiveAt = Date.UTC(2026, 9, 14, 12);
    vi.setSystemTime(observedLiveAt);
    const mux = new TmuxManager(async () => {
      throw new Error('local mux input must not carry remote task recovery');
    });
    const muxSession = {
      sessionId: SESSION,
      muxName: 'codeman-aaaaaaaa',
      pid: 99999,
      createdAt: observedLiveAt,
      workingDir: '/tmp',
      mode: 'codex',
      attached: true,
      recoveryIsolated: true,
    } as MuxSession;
    mux.registerSession(muxSession);
    vi.spyOn(mux, 'inspectPaneForRecovery').mockResolvedValue({
      dead: false,
      screen: 'ssh attached',
      status: undefined,
      signal: undefined,
    });
    const tail =
      line(observedLiveAt - 2000, { type: 'task_started', turn_id: 'turn-before-supervision' }) +
      line(observedLiveAt - 1000, { type: 'task_complete', turn_id: 'turn-before-supervision' });
    let evidence: RemoteCodexEvidence = {
      transport: 'reachable',
      session: 'present',
      pane: { dead: false, paneId: '%7', panePid: 700, screen: '›\n  fixture-model high · /tmp\n' },
      identity: {
        reason: 'verified',
        conversationId: THREAD,
        tail,
        tailTruncated: false,
        changedAt: observedLiveAt - 1000,
      },
    };
    const restartRemote = vi.fn(async () => 'sent' as const);
    const deps: CodexRecoveryAdapterDeps = {
      inspectRemote: vi.fn(async () => structuredClone(evidence)),
      restartRemote,
      deliverRemote: vi.fn(async () => ({ status: 'not-sent' as const })),
    };
    session = new Session({
      id: SESSION,
      workingDir: '/tmp',
      mode: 'codex',
      useMux: true,
      mux,
      muxSession,
      remote: {
        hostId: 'fixture-host',
        label: 'Fixture',
        host: 'fixture.invalid',
        username: 'runner',
        remotePath: '/tmp',
        owned: true,
      },
      codexConfig: { noDaemon: true, resumeSessionId: THREAD },
      envOverrides: { CODEX_HOME: '/fixture/codex-home' },
    });
    session.trackUserInput('Initial owner request\r');
    const adapter = new CodexTaskAdapter(session, () => {}, deps);
    expect((await adapter.observe()).observation).toMatchObject({ activity: 'completed' });

    vi.setSystemTime(observedLiveAt + 5000);
    controller = new TaskController({
      now: () => Date.now(),
      persist: async () => {},
      changed: () => {},
      observe: () => adapter.observe(),
      recover: (observation, isCurrent) => adapter.recover(observation, isCurrent),
      act: (key, conversationId, prompt, isCurrent) => adapter.act(key, conversationId, prompt, isCurrent),
    });
    await controller.update({
      objective: 'Complete the bounded remote fixture task.',
      criteria: [{ id: 'review', description: 'Owner review', kind: 'manual' }],
      config: { enabled: true },
    });
    const taskStartedAt = controller.getStatus().startedAt!;

    vi.setSystemTime(observedLiveAt + 6000);
    evidence = {
      ...evidence,
      pane: { dead: true, status: 17, paneId: '%7', panePid: 700, screen: null },
    };
    const crash = (await adapter.observe()).observation;
    expect(crash).toMatchObject({
      activity: 'crashed',
      safeToAct: true,
      liveProofAt: observedLiveAt,
      at: observedLiveAt + 6000,
    });
    expect(crash.liveProofAt).toBeLessThan(taskStartedAt);

    await controller.refresh();
    expect(controller.getStatus()).toMatchObject({ phase: 'paused', continuations: 0 });
    expect(controller.getStatus().inFlight).toBeUndefined();
    expect(restartRemote).not.toHaveBeenCalled();
  });
});
