import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { CONTINUATION_PROMPT } from '../src/recovery/types.js';
import { TaskController, type TaskObservation } from '../src/supervision/controller.js';
import { TaskStore } from '../src/supervision/store.js';
import { initialTaskState, type TaskUpdate } from '../src/supervision/schema.js';
import { successfulCommands, commandHash, latestProgressMarker } from '../src/supervision/evidence.js';
import { SessionActionArbiter } from '../src/supervision/action-arbiter.js';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const id = '11111111-1111-1111-1111-111111111111';
function fixture() {
  let now = 10000;
  let observation: TaskObservation = {
    observation: {
      activity: 'completed',
      reason: 'turn-completed',
      at: 10001,
      conversationId: id,
      turnId: 't1',
      submissionKey: 'fixture-submission',
      processReady: true,
      safeToAct: false,
    },
    commands: new Map(),
  };
  const persist = vi.fn(async () => {});
  const act = vi.fn(async () => 'sent' as const);
  const recover = vi.fn(async () => 'sent' as const);
  const observe = vi.fn(async () => observation);
  const controller = new TaskController({
    now: () => now,
    observe,
    persist,
    changed: () => {},
    act,
    recover,
  });
  return {
    controller,
    observe: (fn: () => Promise<TaskObservation>) => {
      observe.mockImplementation(fn);
    },
    persist,
    act,
    recover,
    set: (o: Partial<TaskObservation['observation']>) => {
      observation = { ...observation, observation: { ...observation.observation, ...o } };
    },
    marker: (marker: TaskObservation['marker']) => {
      observation = { ...observation, marker };
    },
    clock: (n: number) => {
      now = n;
    },
    commands: observation.commands,
  };
}
async function configure(c: TaskController) {
  await c.update({
    objective: 'Fix the bug',
    criteria: [{ id: 'test', description: 'Run tests', kind: 'command', command: 'npm test' }],
    config: { enabled: true },
  });
  await c.progress({ outcome: 'unfinished', checkpoint: 'Located bug', nextAction: 'Apply fix' });
}
describe('task supervision', () => {
  it('defaults off and idle never continues', async () => {
    const f = fixture();
    expect(f.controller.getStatus().config.enabled).toBe(false);
    await configure(f.controller);
    f.set({ activity: 'idle' });
    await f.controller.refresh();
    expect(f.act).not.toHaveBeenCalled();
    f.controller.stop();
  });
  it('does not persist ordinary input while task automation is disabled', async () => {
    const f = fixture();
    for (let i = 0; i < 100; i++) f.controller.noteUserInput();
    await f.controller.drain();
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.controller.getStatus().phase).toBe('disabled');
    f.controller.stop();
  });
  it('coalesces repeated input into one durable pause while task automation is enabled', async () => {
    const f = fixture();
    await configure(f.controller);
    f.persist.mockClear();
    for (let i = 0; i < 100; i++) f.controller.noteUserInput();
    await f.controller.drain();
    expect(f.persist).toHaveBeenCalledOnce();
    for (let i = 0; i < 100; i++) f.controller.noteUserInput();
    await f.controller.drain();
    expect(f.persist).toHaveBeenCalledOnce();
    expect(f.controller.getStatus()).toMatchObject({ phase: 'paused', reason: 'user-input' });
    f.controller.stop();
  });
  it('journals reservation before delivery and sends only once per completed turn', async () => {
    const f = fixture();
    await configure(f.controller);
    await f.controller.refresh();
    expect(f.act).toHaveBeenCalledOnce();
    expect(f.persist.mock.calls.some(([s]: any[]) => s.inFlight?.key)).toBe(true);
    await f.controller.progress({ outcome: 'unfinished', checkpoint: 'Fixed', nextAction: 'Test' });
    await f.controller.refresh();
    expect(f.act).toHaveBeenCalledOnce();
    f.controller.stop();
  });
  it.each(['unknown', 'blocked', 'paused', 'crashed', 'exited'] as const)('stops on %s', async (activity) => {
    const f = fixture();
    await configure(f.controller);
    f.set({ activity });
    await f.controller.refresh();
    expect(f.act).not.toHaveBeenCalled();
    expect(f.controller.getStatus().phase).not.toBe('watching');
    f.controller.stop();
  });
  it('requires explicit unfinished checkpoint and next action', async () => {
    const f = fixture();
    await f.controller.update({
      objective: 'Fix',
      criteria: [{ id: 'a', description: 'Review', kind: 'manual' }],
      config: { enabled: true },
    });
    await f.controller.refresh();
    expect(f.act).not.toHaveBeenCalled();
    expect(f.controller.getStatus().reason).toBe('task-evidence-unknown');
    f.controller.stop();
  });
  it('rejects unverified completion without mutating criteria', async () => {
    const f = fixture();
    await configure(f.controller);
    await expect(f.controller.progress({ outcome: 'completed', verifiedCriteria: ['test'] })).rejects.toThrow();
    expect(f.controller.getStatus().criteria[0].verified).toBe(false);
    f.commands.set(commandHash('npm test'), { startedAt: 10000, completedAt: 10001 });
    await f.controller.progress({ outcome: 'completed', verifiedCriteria: ['test'] });
    await f.controller.refresh();
    expect(f.controller.getStatus().phase).toBe('completed');
    expect(f.act).not.toHaveBeenCalled();
    f.controller.stop();
  });
  it.each(['owner-progress', 'agent-marker'] as const)(
    '%s verifies only commands that begin after task configuration',
    async (entry) => {
      const line = (at: number, payload: unknown) =>
        JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload }) + '\n';
      const end = line(10002, { type: 'exec_command_end', call_id: 'test-command', exit_code: 0 });
      for (const startedAt of [9999, undefined, 10000]) {
        const f = fixture();
        await configure(f.controller);
        f.clock(10003);
        const begin =
          startedAt === undefined
            ? ''
            : line(startedAt, {
                type: 'exec_command_begin',
                call_id: 'test-command',
                command: ['bash', '-lc', 'npm test'],
              });
        f.observe(async () => ({
          observation: {
            activity: 'completed',
            reason: 'turn-completed',
            at: 10003,
            conversationId: id,
            submissionKey: 'fixture-submission',
            turnId: 'verification-turn',
            processReady: true,
            safeToAct: false,
          },
          commands: successfulCommands(begin + end, 0, 10003),
          ...(entry === 'agent-marker'
            ? {
                marker: {
                  key: 'verification-marker',
                  at: 10003,
                  submissionKey: 'fixture-submission',
                  progress: { outcome: 'completed', verifiedCriteria: ['test'] },
                },
              }
            : {}),
        }));
        const verify = () =>
          entry === 'owner-progress'
            ? f.controller.progress({ outcome: 'completed', verifiedCriteria: ['test'] })
            : f.controller.refresh();
        if (startedAt === 10000) {
          await verify();
          expect(f.controller.getStatus()).toMatchObject({ phase: 'completed', outcome: 'completed' });
          expect(f.controller.getStatus().criteria[0].evidence).toMatchObject({ source: 'command', at: 10002 });
        } else {
          if (entry === 'owner-progress') await expect(verify()).rejects.toThrow('success evidence');
          else {
            await verify();
            expect(f.controller.getStatus()).toMatchObject({
              phase: 'paused',
              reason: 'criterion-evidence-unverified',
            });
          }
          expect(f.controller.getStatus().criteria[0].verified).toBe(false);
        }
        expect(f.act).not.toHaveBeenCalled();
        f.controller.stop();
      }
    }
  );
  it.each([undefined, NaN, Infinity, 10002])(
    'rejects missing, invalid or impossible command start %s',
    async (startedAt) => {
      const f = fixture();
      await configure(f.controller);
      f.commands.set(commandHash('npm test'), { startedAt, completedAt: 10001 } as any);
      await expect(f.controller.progress({ outcome: 'completed', verifiedCriteria: ['test'] })).rejects.toThrow(
        'success evidence'
      );
      expect(f.controller.getStatus().criteria[0].verified).toBe(false);
      f.controller.stop();
    }
  );
  it.each(['owner-progress', 'agent-marker'] as const)(
    '%s retains fresh success when an overlapping pre-configuration command finishes later',
    async (entry) => {
      const line = (at: number, payload: unknown) =>
        JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload }) + '\n';
      const submission = line(9000, { type: 'user_message', message: 'Run the authorized checks' });
      const submissionKey = createHash('sha256').update(submission.trimEnd()).digest('hex');
      const begin = (at: number, call_id: string) =>
        line(at, {
          type: 'exec_command_begin',
          call_id,
          command: ['bash', '-lc', 'npm test'],
        });
      const end = (at: number, call_id: string) => line(at, { type: 'exec_command_end', call_id, exit_code: 0 });
      const tail =
        submission +
        begin(9000, 'old') +
        begin(10001, 'fresh') +
        end(10005, 'fresh') +
        end(10010, 'old') +
        line(10011, {
          type: 'agent_message',
          message: 'CODEMAN_TASK_PROGRESS {"outcome":"completed","verifiedCriteria":["test"]}',
        });
      const f = fixture();
      f.set({ submissionKey });
      await configure(f.controller);
      f.clock(10011);
      f.observe(async () => ({
        observation: {
          activity: 'completed',
          reason: 'turn-completed',
          at: 10011,
          conversationId: id,
          submissionKey,
          turnId: 'overlapping-checks',
          processReady: true,
          safeToAct: false,
        },
        commands: successfulCommands(tail, 0, 10011),
        marker: latestProgressMarker(tail, 0, 10011),
      }));

      if (entry === 'owner-progress') await f.controller.progress({ outcome: 'completed', verifiedCriteria: ['test'] });
      else await f.controller.refresh();

      expect(f.controller.getStatus()).toMatchObject({ phase: 'completed', outcome: 'completed' });
      expect(f.controller.getStatus().criteria[0].evidence).toMatchObject({ source: 'command', at: 10005 });
      expect(f.act).not.toHaveBeenCalled();
      f.controller.stop();
    }
  );
  it.each(['owner-progress', 'agent-marker'] as const)(
    '%s verifies a fresh acceptance check after 100 completed command failures',
    async (entry) => {
      const line = (at: number, payload: unknown) =>
        JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload }) + '\n';
      const submission = line(9000, { type: 'user_message', message: 'Run the authorized checks' });
      const submissionKey = createHash('sha256').update(submission.trimEnd()).digest('hex');
      const failures = Array.from({ length: 100 }, (_, index) => {
        const call_id = `failed-search-${index}`;
        return (
          line(10001 + 2 * index, {
            type: 'exec_command_begin',
            call_id,
            command: ['bash', '-lc', 'rg missing-pattern'],
          }) + line(10002 + 2 * index, { type: 'exec_command_end', call_id, exit_code: index % 2 ? 1 : 2 })
        );
      }).join('');
      const tail =
        submission +
        failures +
        line(10201, { type: 'exec_command_begin', call_id: 'acceptance', command: ['bash', '-lc', 'npm test'] }) +
        line(10202, { type: 'exec_command_end', call_id: 'acceptance', exit_code: 0 }) +
        line(10203, {
          type: 'agent_message',
          message: 'CODEMAN_TASK_PROGRESS {"outcome":"completed","verifiedCriteria":["test"]}',
        });
      const commands = successfulCommands(tail, 0, 10203);
      expect(commands.size).toBe(1);
      expect(commands.get(commandHash('npm test'))).toEqual({ startedAt: 10201, completedAt: 10202 });
      const f = fixture();
      f.set({ submissionKey });
      await configure(f.controller);
      f.clock(10203);
      f.observe(async () => ({
        observation: {
          activity: 'completed',
          reason: 'turn-completed',
          at: 10203,
          conversationId: id,
          submissionKey,
          turnId: 'check-after-failures',
          processReady: true,
          safeToAct: false,
        },
        commands,
        marker: latestProgressMarker(tail, 0, 10203),
      }));
      if (entry === 'owner-progress') await f.controller.progress({ outcome: 'completed', verifiedCriteria: ['test'] });
      else await f.controller.refresh();
      expect(f.controller.getStatus()).toMatchObject({ phase: 'completed', outcome: 'completed' });
      expect(f.controller.getStatus().criteria[0].evidence).toMatchObject({ source: 'command', at: 10202 });
      expect(f.act).not.toHaveBeenCalled();
      f.controller.stop();
    }
  );
  it('preserves evidence on equal settings and validates config atomically', async () => {
    const f = fixture();
    await configure(f.controller);
    await f.controller.update({ objective: 'Fix the bug' });
    expect(f.controller.getStatus().criteria).toHaveLength(1);
    expect(() => f.controller.update({ objective: '', config: { enabled: true } })).toThrow();
    expect(f.controller.getStatus().objective).toBe('Fix the bug');
    f.controller.stop();
  });
  it.each(['owner-input', 'restart'] as const)(
    'settings edits preserve the %s pause until explicit resume',
    async (cause) => {
      const f = fixture();
      await configure(f.controller);
      // Model a task whose kickoff was already accepted before the owner's pause or restart.
      const started = await f.controller.resume();
      f.set({ activity: 'working', submissionHash: started.inFlight!.promptHash, submissionKey: 'accepted-kickoff' });
      await f.controller.refresh();
      f.set({ activity: 'completed', turnId: 'new-turn', at: 10001 });
      await f.controller.progress({ outcome: 'unfinished', checkpoint: 'Located bug', nextAction: 'Apply fix' });
      let controller = f.controller;
      if (cause === 'owner-input') {
        controller.noteUserInput();
        await controller.drain();
      } else {
        const restored = controller.getStatus();
        controller.stop();
        controller = new TaskController(
          {
            now: () => 10000,
            observe: async () => ({
              observation: {
                activity: 'completed',
                reason: 'turn-completed',
                at: 10001,
                conversationId: id,
                turnId: 'new-turn',
                processReady: true,
                safeToAct: false,
              },
              commands: new Map(),
            }),
            act: f.act,
            persist: f.persist,
            changed: () => {},
          },
          restored
        );
      }
      f.act.mockClear();
      const reason = cause === 'owner-input' ? 'user-input' : 'restart-requires-resume';
      const patches: TaskUpdate[] = [
        { config: { maxContinuations: 5 } },
        { config: { enabled: true, maxRuntimeMs: 120000 } },
        {},
        { objective: 'Fix the updated objective', config: { enabled: true } },
        { criteria: [{ id: 'review', description: 'Owner review', kind: 'manual' }] },
      ];
      for (const patch of patches) {
        await controller.update(patch);
        await controller.refresh();
        expect(controller.getStatus()).toMatchObject({ phase: 'paused', reason, config: { enabled: true } });
        expect(f.act).not.toHaveBeenCalled();
      }
      await controller.resume();
      await controller.refresh();
      expect(f.act).toHaveBeenCalledOnce();
      controller.stop();
    }
  );
  it('settings edits preserve a blocked task while a real enabled-state change arms it', async () => {
    const f = fixture();
    await configure(f.controller);
    await f.controller.progress({ outcome: 'blocked', checkpoint: 'Needs owner approval', nextAction: 'Review' });
    await f.controller.update({ config: { enabled: true, maxContinuations: 5 } });
    expect(f.controller.getStatus()).toMatchObject({ phase: 'blocked', reason: 'progress-recorded' });
    await f.controller.update({ objective: 'Review the updated objective' });
    await f.controller.update({ criteria: [{ id: 'review', description: 'Owner review', kind: 'manual' }] });
    expect(f.controller.getStatus()).toMatchObject({ phase: 'blocked', reason: 'progress-recorded' });
    await f.controller.refresh();
    expect(f.act).not.toHaveBeenCalled();
    await f.controller.update({ config: { enabled: false } });
    expect(f.controller.getStatus().phase).toBe('disabled');
    await f.controller.update({ config: { enabled: true } });
    expect(f.controller.getStatus().phase).toBe('watching');
    f.controller.stop();
  });
  it.each(['objective', 'criteria'] as const)('preserves configured limits across a partial %s edit', async (field) => {
    const f = fixture();
    await configure(f.controller);
    await f.controller.update({ config: { maxContinuations: 7, maxRuntimeMs: 123_000 } });
    await f.controller.update(
      field === 'objective'
        ? { objective: 'Fix the other bug' }
        : { criteria: [{ id: 'review', description: 'Owner review', kind: 'manual' }] }
    );
    expect(f.controller.getStatus().config).toEqual({
      enabled: true,
      maxContinuations: 7,
      maxRuntimeMs: 123_000,
    });
    f.controller.stop();
  });
  it('enforces zero continuation budget and runtime budget', async () => {
    const f = fixture();
    await configure(f.controller);
    await f.controller.update({ config: { maxContinuations: 0 } });
    await f.controller.refresh();
    expect(f.controller.getStatus().reason).toBe('budget-exhausted');
    expect(f.act).not.toHaveBeenCalled();
    f.controller.stop();
  });
  it.each(['kickoff', 'continuation', 'recovery'] as const)(
    'does not start %s delivery when its runtime expires while saving the reservation',
    async (kind) => {
      const f = fixture();
      if (kind === 'kickoff') {
        await f.controller.update({
          objective: 'Review the fix',
          criteria: [{ id: 'review', description: 'Owner review', kind: 'manual' }],
          config: { maxRuntimeMs: 1000 },
        });
      } else {
        await configure(f.controller);
        await f.controller.update({ config: { maxRuntimeMs: 1000 } });
      }
      if (kind === 'recovery')
        f.set({ activity: 'crashed', safeToAct: true, evidenceKey: 'crash-after-deadline', at: 10001 });
      f.persist.mockImplementationOnce(async () => f.clock(11001));

      await (kind === 'kickoff' ? f.controller.resume() : f.controller.refresh());

      expect(kind === 'recovery' ? f.recover : f.act).not.toHaveBeenCalled();
      expect(f.controller.getStatus()).toMatchObject({ phase: 'blocked', reason: 'budget-exhausted' });
      expect(f.controller.getStatus().inFlight).toBeUndefined();
      if (kind === 'kickoff') expect(f.controller.getStatus().kickoffAt).toBeUndefined();
      f.controller.stop();
    }
  );
  it.each(['kickoff', 'continuation', 'recovery'] as const)(
    'revokes %s adapter authority when its runtime expires while delivery is awaiting',
    async (kind) => {
      const f = fixture();
      if (kind === 'kickoff') {
        await f.controller.update({
          objective: 'Review the fix',
          criteria: [{ id: 'review', description: 'Owner review', kind: 'manual' }],
          config: { maxRuntimeMs: 1000 },
        });
      } else {
        await configure(f.controller);
        await f.controller.update({ config: { maxRuntimeMs: 1000 } });
      }
      if (kind === 'recovery')
        f.set({ activity: 'crashed', safeToAct: true, evidenceKey: 'crash-at-deadline', at: 10001 });
      const expire = async (isCurrent: () => boolean) => {
        expect(isCurrent()).toBe(true);
        f.clock(11001);
        expect(isCurrent()).toBe(false);
        return 'not-sent' as const;
      };
      if (kind === 'recovery') f.recover.mockImplementationOnce(async (_observation, isCurrent) => expire(isCurrent));
      else f.act.mockImplementationOnce(async (_key, _conversationId, _prompt, isCurrent) => expire(isCurrent));

      await (kind === 'kickoff' ? f.controller.resume() : f.controller.refresh());

      expect(kind === 'recovery' ? f.recover : f.act).toHaveBeenCalledOnce();
      expect(f.controller.getStatus()).toMatchObject({ phase: 'blocked', reason: 'budget-exhausted' });
      expect(f.controller.getStatus().inFlight).toBeUndefined();
      f.controller.stop();
    }
  );
  it.each(['unknown', 'sent'] as const)(
    'retains a possibly delivered reservation after a %s deadline result',
    async (result) => {
      const f = fixture();
      await configure(f.controller);
      await f.controller.update({ config: { maxRuntimeMs: 1000 } });
      f.act.mockImplementationOnce(async (_key, _conversationId, _prompt, isCurrent) => {
        expect(isCurrent()).toBe(true);
        f.clock(11001);
        expect(isCurrent()).toBe(false);
        return result as 'sent';
      });

      await f.controller.refresh();

      expect(f.controller.getStatus()).toMatchObject({ phase: 'blocked', reason: 'budget-exhausted' });
      expect(f.controller.getStatus().inFlight).toBeDefined();
      f.controller.stop();
    }
  );
  it.each(['kickoff', 'continuation'] as const)('observes completion after the final allowed %s', async (kind) => {
    const f = fixture();
    await configure(f.controller);
    await f.controller.update({ config: { maxContinuations: kind === 'kickoff' ? 0 : 1 } });
    if (kind === 'kickoff') await f.controller.resume();
    else await f.controller.refresh();
    expect(f.act).toHaveBeenCalledOnce();
    const prompt = f.act.mock.calls[0]![2] as string;
    f.set({
      activity: 'working',
      reason: 'turn-running',
      submissionKey: 'accepted-final-submission',
      submissionHash: createHash('sha256').update(prompt.trim()).digest('hex'),
    });
    await f.controller.refresh();
    expect(f.controller.getStatus().inFlight).toBeUndefined();
    expect(f.controller.getStatus().phase).toBe('watching');
    f.commands.set(commandHash('npm test'), { startedAt: 10000, completedAt: 10003 });
    f.marker({
      key: 'final-completion',
      at: 10004,
      submissionKey: 'accepted-final-submission',
      progress: { outcome: 'completed', verifiedCriteria: ['test'] },
    });
    f.set({ activity: 'completed', reason: 'turn-completed', at: 10004 });
    await f.controller.refresh();
    expect(f.controller.getStatus().phase).toBe('completed');
    expect(f.controller.getStatus().criteria[0]!.verified).toBe(true);
    expect(f.act).toHaveBeenCalledOnce();
    f.controller.stop();
  });
  it.each([true, false])('preserves pending acceptance across task edits with enabled=%s', async (enabled) => {
    const f = fixture();
    await configure(f.controller);
    await f.controller.resume();
    const flight = f.controller.getStatus().inFlight;
    expect(flight).toBeDefined();
    await f.controller.update({ config: { enabled: false } });
    await expect(f.controller.update({ objective: 'Another task', config: { enabled } })).rejects.toThrow('reset');
    await expect(
      f.controller.update({ criteria: [{ id: 'new', description: 'New criterion', kind: 'manual' }] })
    ).rejects.toThrow('reset');
    expect(f.controller.getStatus().objective).toBe('Fix the bug');
    expect(f.controller.getStatus().inFlight).toEqual(flight);
    await expect(f.controller.resume()).rejects.toThrow('reset');
    expect(f.act).toHaveBeenCalledOnce();
    await f.controller.reset();
    await f.controller.update({ objective: 'Another task', config: { enabled: true } });
    await f.controller.resume();
    expect(f.act).toHaveBeenCalledTimes(2);
    f.controller.stop();
  });
  it('restored reservations require owner reset and cannot replay', async () => {
    const state = initialTaskState();
    state.config.enabled = true;
    state.inFlight = { key: 'old', startedAt: 1 };
    const act = vi.fn();
    const c = new TaskController({ observe: vi.fn(), act, persist: async () => {}, changed: () => {} }, state);
    await c.refresh();
    await expect(c.resume()).rejects.toThrow();
    expect(act).not.toHaveBeenCalled();
    await c.reset();
    expect(c.getStatus().config.enabled).toBe(false);
    expect(c.getStatus().inFlight).toBeUndefined();
    c.stop();
  });
  it('restores fully verified acceptance criteria as completed without reopening work', async () => {
    const state = initialTaskState();
    state.objective = 'Previously completed work';
    state.criteria = [
      {
        id: 'review',
        description: 'Owner review',
        kind: 'manual',
        verified: true,
        evidence: { source: 'owner', at: 10000 },
      },
    ];
    state.config = { enabled: true, maxContinuations: 7, maxRuntimeMs: 123_000 };
    state.outcome = 'unfinished';
    state.phase = 'watching';
    state.continuations = 3;
    const act = vi.fn();
    const c = new TaskController({ observe: vi.fn(), act, persist: async () => {}, changed: () => {} }, state);

    expect(c.getStatus()).toMatchObject({
      outcome: 'completed',
      phase: 'completed',
      continuations: 3,
      config: { enabled: true, maxContinuations: 7, maxRuntimeMs: 123_000 },
    });
    await expect(c.resume()).rejects.toThrow('No unfinished task');
    expect(act).not.toHaveBeenCalled();
    c.stop();
  });
  it('fails closed before dispatch when persistence fails', async () => {
    const f = fixture();
    await configure(f.controller);
    f.persist.mockRejectedValueOnce(new Error());
    await expect(f.controller.refresh()).rejects.toThrow();
    expect(f.act).not.toHaveBeenCalled();
    expect(f.controller.getStatus().reason).toBe('persistence-failed');
    f.controller.stop();
  });
  it('shares one action slot across actors', async () => {
    const arbiter = new SessionActionArbiter();
    let release!: () => void;
    const p = arbiter.run('task', async () => {
      await new Promise<void>((r) => (release = r));
      return 'sent';
    });
    expect(await arbiter.run('recovery', async () => 'sent')).toBe('not-sent');
    await expect(arbiter.reset('task')).rejects.toThrow('active');
    await expect(arbiter.reset('recovery')).resolves.toBeUndefined();
    release();
    expect(await p).toBe('sent');
  });
  it('explicit resume sends the objective from verified idle and confirms structured acceptance', async () => {
    const f = fixture();
    await f.controller.update({
      objective: 'Fix bug',
      criteria: [{ id: 'review', description: 'Owner review', kind: 'manual' }],
    });
    f.set({ activity: 'idle' });
    await f.controller.resume();
    expect(f.act).toHaveBeenCalledOnce();
    expect(f.act.mock.calls[0][2]).toContain('Fix bug');
    const flight = f.controller.getStatus().inFlight!;
    expect(flight.promptHash).toBeTruthy();
    f.set({ activity: 'working', submissionHash: flight.promptHash, submissionKey: 'new-submission' });
    await f.controller.refresh();
    expect(f.controller.getStatus().inFlight).toBeUndefined();
    expect(f.controller.getStatus().reason).toBe('continuation-accepted');
    f.controller.stop();
  });
  it('retains a kickoff reservation when owner progress lacks exact acceptance proof', async () => {
    const f = fixture();
    await f.controller.update({
      objective: 'Review the fix',
      criteria: [{ id: 'review', description: 'Owner review', kind: 'manual' }],
    });
    f.set({ activity: 'idle', submissionKey: 'before-kickoff' });
    await f.controller.resume();
    const pending = f.controller.getStatus().inFlight!;
    f.set({ activity: 'working', submissionKey: 'new-submission', submissionHash: 'wrong-prompt-hash' });

    await f.controller.progress({ outcome: 'unfinished', verifiedCriteria: ['review'] });

    expect(f.controller.getStatus()).toMatchObject({ outcome: 'completed', phase: 'completed', inFlight: pending });
    await expect(f.controller.update({ objective: 'New work' })).rejects.toThrow('reset');
    f.controller.stop();
  });
  it('requires explicit reset for unresolved shared durable delivery after restart', async () => {
    let key: string | undefined;
    const a = new SessionActionArbiter(async (next) => {
      key = next;
    });
    expect(await a.run('task', async () => 'unknown')).toBe('unknown');
    expect(key).toBeTruthy();
    const restarted = new SessionActionArbiter(async (next) => {
      key = next;
    }, key);
    const act = vi.fn(async () => 'sent' as const);
    expect(await restarted.run('task', act)).toBe('not-sent');
    expect(act).not.toHaveBeenCalled();
    await restarted.reset('task');
    expect(await restarted.run('task', act)).toBe('sent');
  });
  it("does not let one actor reset another actor's unresolved reservation", async () => {
    const arbiter = new SessionActionArbiter();
    const act = vi.fn(async () => 'sent' as const);
    expect(await arbiter.run('task', async () => 'unknown')).toBe('unknown');
    await arbiter.reset('recovery');
    expect(await arbiter.run('recovery', act)).toBe('not-sent');
    expect(act).not.toHaveBeenCalled();
    await arbiter.reset('task');
    expect(await arbiter.run('recovery', act)).toBe('sent');
  });
  it('requires an explicit safe claim before clearing a legacy unowned reservation', async () => {
    const arbiter = new SessionActionArbiter(undefined, 'bare-uuid');
    const act = vi.fn(async () => 'sent' as const);
    await arbiter.reset('task');
    expect(await arbiter.run('task', act)).toBe('not-sent');
    await arbiter.reset('task', true);
    expect(await arbiter.run('task', act)).toBe('sent');
  });
  it('uses same authority for genuine crashes and bounds recovery', async () => {
    const f = fixture();
    await configure(f.controller);
    f.set({ activity: 'crashed', safeToAct: true, evidenceKey: 'crash', at: 10001 });
    const state = f.controller.getStatus();
    f.controller.stop();
    const recover = vi.fn(async () => 'sent' as const);
    const c = new TaskController(
      {
        now: () => 10002,
        observe: async () => ({
          observation: {
            activity: 'crashed',
            reason: 'process-crashed',
            at: 10001,
            conversationId: id,
            safeToAct: true,
            evidenceKey: 'crash',
          },
          commands: new Map(),
        }),
        act: vi.fn(),
        recover,
        persist: async () => {},
        changed: () => {},
      },
      state
    );
    await c.update({ config: { enabled: false } });
    await c.update({ config: { enabled: true } });
    await c.refresh();
    expect(recover).toHaveBeenCalledOnce();
    expect(c.getStatus().continuations).toBe(1);
    c.stop();
  });
  it.each([11000, NaN, Infinity, 20001, 15000])(
    'requires crash live proof %s to fall within the armed task lifetime',
    async (liveProofAt) => {
      const f = fixture();
      await f.controller.update({
        objective: 'Review',
        criteria: [{ id: 'review', description: 'Owner review', kind: 'manual' }],
      });
      f.clock(11000);
      await f.controller.progress({
        outcome: 'unfinished',
        checkpoint: 'Verified while disabled',
        nextAction: 'Review result',
      });
      f.clock(15000);
      await f.controller.update({ config: { enabled: true } });
      f.clock(20000);
      f.set({
        activity: 'crashed',
        reason: 'process-crashed',
        safeToAct: true,
        evidenceKey: 'newly-observed-crash',
        at: 20000,
        liveProofAt,
      });
      await f.controller.refresh();
      if (liveProofAt === 15000) {
        expect(f.recover).toHaveBeenCalledOnce();
        expect(f.controller.getStatus().reason).toBe('recovery-sent');
      } else {
        expect(f.recover).not.toHaveBeenCalled();
        expect(f.controller.getStatus()).toMatchObject({ phase: 'paused', continuations: 0 });
        expect(f.controller.getStatus().inFlight).toBeUndefined();
      }
      f.controller.stop();
    }
  );
  it('agent markers never verify manual criteria', async () => {
    const f = fixture();
    await f.controller.update({
      objective: 'Review fix',
      criteria: [{ id: 'review', description: 'Owner review', kind: 'manual' }],
      config: { enabled: true },
    });
    await f.controller.progress({ outcome: 'unfinished' });
    f.marker({
      key: 'marker',
      submissionKey: 'fixture-submission',
      at: 10001,
      progress: { outcome: 'completed', verifiedCriteria: ['review'] },
    });
    await f.controller.refresh();
    expect(f.controller.getStatus().criteria[0].verified).toBe(false);
    expect(f.controller.getStatus().reason).toBe('criterion-evidence-unverified');
    expect(f.act).not.toHaveBeenCalled();
    f.controller.stop();
  });
  it('agent command acknowledgment completes only with actual correlated command evidence', async () => {
    const f = fixture();
    await configure(f.controller);
    f.commands.set(commandHash('npm test'), { startedAt: 10000, completedAt: 10001 });
    f.marker({
      key: 'marker',
      submissionKey: 'fixture-submission',
      at: 10002,
      progress: { outcome: 'completed', verifiedCriteria: ['test'] },
    });
    await f.controller.refresh();
    expect(f.controller.getStatus().phase).toBe('completed');
    expect(f.controller.getStatus().criteria[0].evidence?.source).toBe('command');
    expect(f.act).not.toHaveBeenCalled();
    f.controller.stop();
  });
  it('treats fully verified command criteria as terminal despite an unfinished marker', async () => {
    const f = fixture();
    await configure(f.controller);
    f.commands.set(commandHash('npm test'), { startedAt: 10000, completedAt: 10001 });
    f.marker({
      key: 'contradictory-marker',
      submissionKey: 'fixture-submission',
      at: 10002,
      progress: {
        outcome: 'unfinished',
        checkpoint: 'All checks passed',
        nextAction: 'Continue anyway',
        verifiedCriteria: ['test'],
      },
    });

    await f.controller.refresh();

    expect(f.controller.getStatus()).toMatchObject({ outcome: 'completed', phase: 'completed' });
    expect(f.controller.getStatus().criteria[0].evidence?.source).toBe('command');
    expect(f.act).not.toHaveBeenCalled();

    await f.controller.update({ config: { maxContinuations: 7 } });
    expect(f.controller.getStatus()).toMatchObject({ outcome: 'completed', phase: 'completed' });
    await expect(f.controller.resume()).rejects.toThrow('No unfinished task');
    expect(f.act).not.toHaveBeenCalled();

    await f.controller.update({ objective: 'Fix a newly discovered bug' });
    expect(f.controller.getStatus()).toMatchObject({ outcome: 'unknown', phase: 'paused' });
    expect(f.controller.getStatus().criteria[0].verified).toBe(false);
    await f.controller.refresh();
    expect(f.act).not.toHaveBeenCalled();
    await f.controller.resume();
    expect(f.act).toHaveBeenCalledOnce();
    f.controller.stop();
  });
  it('completes when the owner verifies the final manual criterion', async () => {
    const f = fixture();
    await f.controller.update({
      objective: 'Review the fix',
      criteria: [{ id: 'review', description: 'Owner review', kind: 'manual' }],
      config: { enabled: true },
    });

    await f.controller.progress({
      outcome: 'unfinished',
      checkpoint: 'Review passed',
      nextAction: 'Continue anyway',
      verifiedCriteria: ['review'],
    });

    expect(f.controller.getStatus()).toMatchObject({ outcome: 'completed', phase: 'completed' });
    expect(f.controller.getStatus().criteria[0].evidence?.source).toBe('owner');
    await f.controller.refresh();
    expect(f.act).not.toHaveBeenCalled();
    f.controller.stop();
  });
  it('stale and malformed markers cannot authorize continuation', async () => {
    const f = fixture();
    await configure(f.controller);
    f.marker({ key: 'marker', submissionKey: 'fixture-submission', at: 10002, progress: null });
    await f.controller.refresh();
    expect(f.controller.getStatus().phase).toBe('paused');
    expect(f.act).not.toHaveBeenCalled();
    f.controller.stop();
  });
  it('runtime begins on enable rather than disabled task configuration', async () => {
    const f = fixture();
    await f.controller.update({
      objective: 'Review',
      criteria: [{ id: 'a', description: 'Owner review', kind: 'manual' }],
    });
    expect(f.controller.getStatus().startedAt).toBeUndefined();
    f.clock(500000);
    await f.controller.update({ config: { enabled: true } });
    expect(f.controller.getStatus().startedAt).toBe(500000);
    f.controller.stop();
  });
  it('rejects byte-over-cap saves before replacing the prior reloadable journal', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'tasks-cap-')), 'tasks.json');
    const store = new TaskStore(path);
    const state = initialTaskState();
    state.objective = 'o'.repeat(4000);
    state.checkpoint = 'c'.repeat(4000);
    state.nextAction = 'n'.repeat(4000);
    state.criteria = Array.from({ length: 30 }, (_, i) => ({
      id: `criterion-${i}`,
      description: 'd'.repeat(1000),
      kind: 'command' as const,
      command: 'x'.repeat(1000),
      verified: false,
    }));
    let prior = '';
    let rejected = false;
    for (let i = 0; i < 100; i++) {
      try {
        await store.save(`session-${i}`, state);
        prior = await readFile(path, 'utf8');
      } catch {
        rejected = true;
        expect(await readFile(path, 'utf8')).toBe(prior);
        expect(new TaskStore(path).loadFailed).toBe(false);
        expect(new TaskStore(path).get(`session-${i}`).objective).toBe('');
        break;
      }
    }
    expect(rejected).toBe(true);
    expect(Buffer.byteLength(prior)).toBeLessThanOrEqual(2 * 1024 * 1024);
  });
  it('failed API mutation restores the prior persisted task details and disables dispatch', async () => {
    const f = fixture();
    await configure(f.controller);
    f.persist.mockRejectedValueOnce(new Error('capacity'));
    await expect(f.controller.update({ objective: 'Replacement objective' })).rejects.toThrow();
    expect(f.controller.getStatus().objective).toBe('Fix the bug');
    expect(f.controller.getStatus().criteria[0].command).toBe('npm test');
    expect(f.controller.getStatus().config.enabled).toBe(false);
    expect(f.controller.getStatus().reason).toBe('persistence-failed');
    f.controller.stop();
  });
  it('resumes paused supervision without repeating its initial objective prompt', async () => {
    const f = fixture();
    await f.controller.update({
      objective: 'Fix bug',
      criteria: [{ id: 'review', description: 'Owner review', kind: 'manual' }],
    });
    await f.controller.resume();
    const flight = f.controller.getStatus().inFlight!;
    f.set({ activity: 'working', submissionHash: flight.promptHash, submissionKey: 'accepted' });
    await f.controller.refresh();
    await f.controller.pause();
    await f.controller.resume();
    expect(f.act).toHaveBeenCalledOnce();
    expect(f.controller.getStatus().phase).toBe('watching');
    f.controller.stop();
  });
  it.each(['kickoff', 'continuation'] as const)(
    'keeps a user-input pause after %s delivery returns sent',
    async (kind) => {
      const f = fixture();
      if (kind === 'kickoff') {
        await f.controller.update({
          objective: 'Fix bug',
          criteria: [{ id: 'a', description: 'Review', kind: 'manual' }],
        });
      } else await configure(f.controller);
      f.act.mockImplementationOnce(async () => {
        f.controller.noteUserInput();
        return 'sent';
      });
      const result = await (kind === 'kickoff' ? f.controller.resume() : f.controller.refresh());
      await f.controller.drain();
      expect(result.phase).toBe('paused');
      expect(f.controller.getStatus().phase).toBe('paused');
      expect(f.controller.getStatus().reason).toBe('user-input');
      expect(f.controller.getStatus().inFlight).toBeDefined();
      await f.controller.refresh();
      expect(f.act).toHaveBeenCalledOnce();
      f.controller.stop();
    }
  );
  it('preserves user-input cancellation during crash recovery and retains its uncertain flight', async () => {
    const f = fixture();
    await configure(f.controller);
    const state = f.controller.getStatus();
    f.controller.stop();
    let c: TaskController;
    const recover = vi.fn(async () => {
      c.noteUserInput();
      return 'sent' as const;
    });
    c = new TaskController(
      {
        now: () => 10002,
        observe: async () => ({
          observation: {
            activity: 'crashed',
            reason: 'process-crashed',
            at: 10001,
            conversationId: id,
            safeToAct: true,
            evidenceKey: 'crash',
          },
          commands: new Map(),
        }),
        act: vi.fn(),
        recover,
        persist: async () => {},
        changed: () => {},
      },
      state
    );
    await c.update({ config: { enabled: false } });
    await c.update({ config: { enabled: true } });
    await c.refresh();
    await c.drain();
    expect(c.getStatus().phase).toBe('paused');
    expect(c.getStatus().reason).toBe('user-input');
    expect(c.getStatus().inFlight?.key).toBe('crash');
    await c.refresh();
    expect(recover).toHaveBeenCalledOnce();
    c.stop();
  });
  it('never re-arms a controller stopped while delivery returns sent', async () => {
    const f = fixture();
    await configure(f.controller);
    f.act.mockImplementationOnce(async () => {
      f.controller.stop();
      return 'sent';
    });
    await f.controller.refresh();
    expect(f.controller.getStatus().phase).toBe('paused');
    expect(f.controller.getStatus().reason).toBe('delivery-cancelled');
    expect(f.controller.getStatus().inFlight).toBeDefined();
    await f.controller.refresh();
    expect(f.act).toHaveBeenCalledOnce();
  });
  it('rejects progress superseded by user input during observation without re-arming', async () => {
    const f = fixture();
    await configure(f.controller);
    f.observe(async () => {
      f.controller.noteUserInput();
      return {
        observation: {
          activity: 'completed',
          reason: 'turn-completed',
          conversationId: id,
          turnId: 'later',
          at: 10002,
          processReady: true,
          safeToAct: false,
        },
        commands: new Map(),
      };
    });
    await expect(
      f.controller.progress({ outcome: 'unfinished', checkpoint: 'Stale checkpoint', nextAction: 'Stale next action' })
    ).rejects.toThrow('superseded');
    await f.controller.drain();
    expect(f.controller.getStatus().phase).toBe('paused');
    expect(f.controller.getStatus().checkpoint).toBe('Located bug');
    await f.controller.refresh();
    expect(f.act).not.toHaveBeenCalled();
    f.controller.stop();
  });
  it('rejects kickoff superseded by user input during observation before delivery', async () => {
    const f = fixture();
    await f.controller.update({
      objective: 'Fix bug',
      criteria: [{ id: 'a', description: 'Review', kind: 'manual' }],
      config: { enabled: true },
    });
    f.observe(async () => {
      f.controller.noteUserInput();
      return {
        observation: {
          activity: 'idle',
          reason: 'observing',
          conversationId: id,
          at: 10002,
          processReady: true,
          safeToAct: false,
        },
        commands: new Map(),
      };
    });
    await expect(f.controller.resume()).rejects.toThrow('superseded');
    await f.controller.drain();
    expect(f.controller.getStatus().phase).toBe('paused');
    expect(f.controller.getStatus().inFlight).toBeUndefined();
    expect(f.act).not.toHaveBeenCalled();
    f.controller.stop();
  });
  it('cancels kickoff while its durable reservation is saving before calling delivery', async () => {
    const f = fixture();
    await f.controller.update({
      objective: 'Fix bug',
      criteria: [{ id: 'a', description: 'Review', kind: 'manual' }],
      config: { enabled: true },
    });
    f.persist.mockImplementationOnce(async () => {
      f.controller.noteUserInput();
    });
    await f.controller.resume();
    await f.controller.drain();
    expect(f.controller.getStatus().phase).toBe('paused');
    expect(f.controller.getStatus().inFlight).toBeUndefined();
    expect(f.act).not.toHaveBeenCalled();
    f.controller.stop();
  });
  it.each(['interrupted', 'crashed'] as const)(
    'requires fresh progress after successful %s recovery before any further continuation',
    async (activity) => {
      const f = fixture();
      await configure(f.controller);
      const state = f.controller.getStatus();
      f.controller.stop();
      let observation: TaskObservation = {
        observation: {
          activity,
          reason: activity === 'crashed' ? 'process-crashed' : 'turn-interrupted',
          at: 12001,
          conversationId: id,
          safeToAct: true,
          evidenceKey: `failure-${activity}`,
          submissionKey: 'original-submission',
        },
        commands: new Map(),
      };
      const recover = vi.fn(async () => 'sent' as const);
      const act = vi.fn(async () => 'sent' as const);
      const c = new TaskController(
        {
          now: () => 12002,
          observe: async () => observation,
          recover,
          act,
          persist: async () => {},
          changed: () => {},
        },
        state
      );
      await c.update({ config: { enabled: false } });
      await c.update({ config: { enabled: true } });
      await c.refresh();
      expect(c.getStatus().outcome).toBe('unknown');
      if (activity === 'interrupted') {
        expect(c.getStatus().inFlight?.promptHash).toBe(createHash('sha256').update(CONTINUATION_PROMPT).digest('hex'));
      } else expect(c.getStatus().inFlight).toBeUndefined();
      observation = {
        observation: {
          activity: 'completed',
          reason: 'turn-completed',
          at: 12003,
          conversationId: id,
          turnId: 'recovered-turn',
          safeToAct: false,
          processReady: true,
          submissionKey: 'recovery-submission',
          submissionHash: createHash('sha256').update(CONTINUATION_PROMPT).digest('hex'),
        },
        commands: new Map(),
      };
      await c.refresh();
      expect(c.getStatus().inFlight).toBeUndefined();
      expect(c.getStatus().phase).toBe('paused');
      expect(c.getStatus().reason).toBe('task-evidence-unknown');
      expect(act).not.toHaveBeenCalled();
      expect(recover).toHaveBeenCalledOnce();
      c.stop();
    }
  );
  it('does not reuse a pre-recovery checkpoint when fresh progress omits the next action', async () => {
    const f = fixture();
    await configure(f.controller);
    const state = f.controller.getStatus();
    f.controller.stop();
    let observation: TaskObservation = {
      observation: {
        activity: 'interrupted',
        reason: 'turn-interrupted',
        at: 12001,
        conversationId: id,
        safeToAct: true,
        evidenceKey: 'interrupted-with-incomplete-progress',
        submissionKey: 'original-submission',
      },
      commands: new Map(),
    };
    const act = vi.fn(async () => 'sent' as const);
    const c = new TaskController(
      {
        now: () => 12002,
        observe: async () => observation,
        recover: async () => 'sent',
        act,
        persist: async () => {},
        changed: () => {},
      },
      state
    );
    await c.update({ config: { enabled: false } });
    await c.update({ config: { enabled: true } });
    await c.refresh();
    expect(c.getStatus()).toMatchObject({ outcome: 'unknown', checkpoint: '', nextAction: '' });
    observation = {
      observation: {
        activity: 'completed',
        reason: 'turn-completed',
        at: 12003,
        conversationId: id,
        turnId: 'recovered-turn',
        processReady: true,
        safeToAct: false,
        submissionKey: 'recovery-submission',
        submissionHash: createHash('sha256').update(CONTINUATION_PROMPT).digest('hex'),
      },
      commands: new Map(),
      marker: {
        key: 'fresh-incomplete-progress',
        at: 12003,
        submissionKey: 'recovery-submission',
        progress: { outcome: 'unfinished' },
      },
    };
    await c.refresh();
    expect(c.getStatus()).toMatchObject({
      outcome: 'unfinished',
      checkpoint: '',
      nextAction: '',
      phase: 'paused',
      reason: 'task-evidence-unknown',
    });
    expect(act).not.toHaveBeenCalled();
    c.stop();
  });
  it('accepts fresh progress for the existing submission after a crash restart', async () => {
    const f = fixture();
    await configure(f.controller);
    const state = f.controller.getStatus();
    f.controller.stop();
    let observation: TaskObservation = {
      observation: {
        activity: 'crashed',
        reason: 'process-crashed',
        at: 12001,
        conversationId: id,
        safeToAct: true,
        evidenceKey: 'crash-without-submission-key',
      },
      commands: new Map(),
    };
    const c = new TaskController(
      {
        now: () => 12002,
        observe: async () => observation,
        recover: async () => 'sent',
        act: vi.fn(),
        persist: async () => {},
        changed: () => {},
      },
      state
    );
    await c.update({ config: { enabled: false } });
    await c.update({ config: { enabled: true } });
    await c.refresh();
    expect(c.getStatus().submissionKey).toBe('fixture-submission');
    expect(c.getStatus().outcome).toBe('unknown');
    observation = {
      observation: {
        activity: 'working',
        reason: 'turn-running',
        at: 12003,
        conversationId: id,
        submissionKey: 'fixture-submission',
        safeToAct: false,
      },
      commands: new Map(),
      marker: {
        key: 'fresh-recovered-progress',
        at: 12003,
        submissionKey: 'fixture-submission',
        progress: { outcome: 'unfinished', checkpoint: 'Recovered work', nextAction: 'Run tests' },
      },
    };
    await c.refresh();
    expect(c.getStatus().outcome).toBe('unfinished');
    expect(c.getStatus().checkpoint).toBe('Recovered work');
    expect(c.getStatus().phase).toBe('watching');
    c.stop();
  });
  it('writes private atomic state and rejects corrupt persistence', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'tasks-')), 'tasks.json');
    const store = new TaskStore(path);
    await store.save('session', initialTaskState());
    expect(JSON.parse(await readFile(path, 'utf8')).sessions.session.config.enabled).toBe(false);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(new TaskStore(path).get('session').outcome).toBe('unknown');
    await writeFile(path, '{}');
    const corrupt = new TaskStore(path);
    expect(corrupt.get('session').reason).toBe('persistence-failed');
    await expect(corrupt.save('session', initialTaskState())).rejects.toThrow('could not be loaded');
    await expect(corrupt.drop('session')).rejects.toThrow('could not be loaded');
    expect(await readFile(path, 'utf8')).toBe('{}');
  });
});
describe('structured command evidence', () => {
  const line = (at: number, payload: unknown) =>
    JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload }) + '\n';
  it('bounds truly pending commands and reclaims capacity only for matching completed calls', () => {
    const begin = (at: number, call_id: string) =>
      line(at, { type: 'exec_command_begin', call_id, command: ['bash', '-lc', 'npm test'] });
    const end = (at: number, call_id: string, exit_code: number) =>
      line(at, { type: 'exec_command_end', call_id, exit_code });
    const pending = Array.from({ length: 100 }, (_, index) => begin(10000 + index, `pending-${index}`)).join('');
    const unknown = end(10100, 'unknown-call', 1);
    const overflow = begin(10101, 'over-capacity') + end(10102, 'over-capacity', 0);
    expect(successfulCommands(pending + unknown + overflow, 0, 10105).size).toBe(0);
    const reclaimed = end(10103, 'pending-0', 1) + begin(10104, 'admitted') + end(10105, 'admitted', 0);
    expect(successfulCommands(pending + unknown + overflow + reclaimed, 0, 10105).get(commandHash('npm test'))).toEqual(
      {
        startedAt: 10104,
        completedAt: 10105,
      }
    );
  });
  it('does not reuse a failed completion or malformed begin as success evidence', () => {
    const begin = line(10000, { type: 'exec_command_begin', call_id: 'failed', command: ['bash', '-lc', 'npm test'] });
    const failed = line(10001, { type: 'exec_command_end', call_id: 'failed', exit_code: 1 });
    const later = line(10002, { type: 'exec_command_end', call_id: 'failed', exit_code: 0 });
    expect(successfulCommands(begin + failed + later, 0, 10002).size).toBe(0);
    const malformed = line(10000, { type: 'exec_command_begin', call_id: 'failed', command: ['bash', '-lc'] });
    expect(successfulCommands(malformed + later, 0, 10002).size).toBe(0);
  });
  it.each([false, true])('keeps the latest completion for equal execution starts, reverse order %s', (reverse) => {
    const begin = (call_id: string) =>
      line(10001, { type: 'exec_command_begin', call_id, command: ['bash', '-lc', 'npm test'] });
    const earlier = line(10004, { type: 'exec_command_end', call_id: 'earlier', exit_code: 0 });
    const later = line(10005, { type: 'exec_command_end', call_id: 'later', exit_code: 0 });
    const tail = begin('earlier') + begin('later') + (reverse ? later + earlier : earlier + later);
    expect(successfulCommands(tail, 0, 10011).get(commandHash('npm test'))).toEqual({
      startedAt: 10001,
      completedAt: 10005,
    });
  });
  it('correlates supported Codex shells and rejects failed, partial, or arbitrary wrapper evidence', () => {
    for (const [index, shell] of ['bash', '/bin/zsh', '/usr/bin/bash', '/usr/bin/sh', '/usr/bin/zsh'].entries()) {
      const callId = `supported-${index}`;
      const begin = line(10000, {
        type: 'exec_command_begin',
        call_id: callId,
        command: [shell, '-lc', 'npm test'],
      });
      const end = line(10001, { type: 'exec_command_end', call_id: callId, exit_code: 0 });
      expect(successfulCommands(begin + end, 9000, 11000).get(commandHash('npm test'))).toEqual({
        startedAt: 10000,
        completedAt: 10001,
      });
    }
    const begin = line(10000, { type: 'exec_command_begin', call_id: 'c', command: ['bash', '-lc', 'npm test'] });
    const end = line(10001, { type: 'exec_command_end', call_id: 'c', exit_code: 0 });
    expect(successfulCommands(end, 9000, 11000).size).toBe(0);
    expect(successfulCommands(begin + end.trim(), 9000, 11000).size).toBe(0);
    expect(
      successfulCommands(begin + line(10001, { type: 'exec_command_end', call_id: 'c', exit_code: 1 }), 9000, 11000)
        .size
    ).toBe(0);
    const arbitrary = line(10000, {
      type: 'exec_command_begin',
      call_id: 'arbitrary',
      command: ['/tmp/bash', '-lc', 'npm test'],
    });
    const arbitraryEnd = line(10001, { type: 'exec_command_end', call_id: 'arbitrary', exit_code: 0 });
    expect(successfulCommands(arbitrary + arbitraryEnd, 9000, 11000).size).toBe(0);
  });
  it('clears a future-dated prior marker on a later user row and attributes new markers to the classifier submission identity', () => {
    const earlier = line(9999, { type: 'user_message', message: 'Earlier task' });
    const marker = line(11500, { type: 'agent_message', message: 'CODEMAN_TASK_PROGRESS {"outcome":"unfinished"}' });
    const current = line(10001, { type: 'user_message', message: 'Current task' });
    expect(latestProgressMarker(earlier + marker + current, 10000, 10002)).toBeUndefined();
    const fresh = line(10002, { type: 'agent_message', message: 'CODEMAN_TASK_PROGRESS {"outcome":"unfinished"}' });
    expect(latestProgressMarker(earlier + marker + current + fresh, 10000, 10003)?.submissionKey).toBe(
      createHash('sha256').update(current.slice(0, -1)).digest('hex')
    );
  });
  it('accepts only explicit structured agent marker', () => {
    expect(
      latestProgressMarker(
        line(10000, { type: 'agent_message', message: 'CODEMAN_TASK_PROGRESS {"outcome":"unfinished"}' }),
        9000,
        11000
      )?.progress
    ).toEqual({ outcome: 'unfinished' });
    expect(
      latestProgressMarker(
        line(10000, { type: 'task_complete', message: 'CODEMAN_TASK_PROGRESS {"outcome":"completed"}' }),
        9000,
        11000
      )
    ).toBeUndefined();
  });
});
