/** Real Session + real tmux input normalization, with an injected recording runner and no processes. */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { Session } from '../src/session.js';
import { TmuxManager } from '../src/tmux-manager.js';
import type { MuxSession } from '../src/mux-interface.js';
import { TaskController } from '../src/supervision/controller.js';
import { classifyCodexTail } from '../src/recovery/codex-classifier.js';
import { latestProgressMarker } from '../src/supervision/evidence.js';
const THREAD = '11111111-2222-3333-4444-555555555555';
const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
let session: Session | undefined;
let controller: TaskController | undefined;
afterEach(async () => {
  controller?.stop();
  await controller?.drain();
  await session?.stop(false);
  vi.restoreAllMocks();
});
const line = (at: number, payload: unknown) =>
  JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload }) + '\n';
describe('transport canonical task prompts', () => {
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
});
