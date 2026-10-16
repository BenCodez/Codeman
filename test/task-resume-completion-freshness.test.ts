/** @fileoverview Explicit task resume rejects pre-block completion using real isolated journals and fake observations. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskController, type TaskDependencies } from '../src/supervision/controller.js';
import { TaskStore } from '../src/supervision/store.js';
import { TaskStateSchema, initialTaskState, type TaskState } from '../src/supervision/schema.js';
import { successfulCommands } from '../src/supervision/evidence.js';
const SID = 'resume-worker';
const CID = '11111111-2222-3333-4444-555555555555';
const line = (at: number, payload: unknown) =>
  JSON.stringify({ type: 'event_msg', timestamp: new Date(at).toISOString(), payload }) + '\n';
const run = (at: number, id: string) =>
  line(at, { type: 'exec_command_begin', call_id: id, command: ['bash', '-lc', 'check'] }) +
  line(at + 1000, { type: 'exec_command_end', call_id: id, exit_code: 0 });
const owned: Array<{ root: string; tasks: TaskController[] }> = [];
afterEach(async () => {
  for (const f of owned.splice(0)) {
    for (const task of f.tasks) {
      task.stop();
      await task.drain();
    }
    await rm(f.root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});
async function fixture(kind: 'manual' | 'command', outcome: 'blocked' | 'unknown') {
  const root = await mkdtemp(join(homedir(), 'resume-completion-'));
  const path = join(root, 'tasks.json');
  const store = new TaskStore(path);
  let now = 10000,
    observedAt = 12500,
    tail = run(11000, 'initial');
  const state: TaskState = {
    ...initialTaskState(),
    objective: 'Finish owner acceptance',
    phase: 'watching',
    outcome: 'unfinished',
    configuredAt: 10000,
    startedAt: 10000,
    kickoffAt: 10000,
    conversationId: CID,
    submissionKey: 'same-submission',
    config: { enabled: true, maxContinuations: 3, maxRuntimeMs: 900000 },
    criteria: [
      { id: 'owner', kind: 'manual', description: 'Owner accepts result', verified: false },
      ...(kind === 'command'
        ? [{ id: 'command', kind: 'command' as const, command: 'check', description: 'Check passes', verified: false }]
        : []),
    ],
  };
  await store.save(SID, state);
  const act = vi.fn(async () => 'sent' as const),
    recover = vi.fn(async () => 'sent' as const);
  const deps: TaskDependencies = {
    now: () => now,
    observe: async () => ({
      observation: {
        activity: 'completed',
        reason: 'turn-completed',
        at: observedAt,
        conversationId: CID,
        turnId: 'same-turn',
        submissionKey: 'same-submission',
        processReady: true,
        safeToAct: false,
      },
      commands: successfulCommands(tail, 0, now),
    }),
    persist: (value, authority) => store.save(SID, value, authority),
    changed: () => {},
    act,
    recover,
  };
  const task = new TaskController(deps, state);
  const tasks = [task];
  owned.push({ root, tasks });
  await task.resume();
  now = 13000;
  await task.progress({ outcome, verifiedCriteria: kind === 'command' ? ['owner', 'command'] : ['owner'] });
  expect(task.getStatus()).toMatchObject({ outcome, agentProgressVeto: true });
  expect(task.getStatus().criteria.every((criterion) => criterion.verified)).toBe(true);
  now = 20000;
  await task.resume();
  return {
    task,
    deps,
    store,
    path,
    tasks,
    act,
    recover,
    clock: (at: number) => {
      now = at;
    },
    observed: (at: number) => {
      observedAt = at;
    },
    freshCommand: () => {
      tail += run(21000, 'fresh');
    },
    failedCommand: () => {
      tail +=
        line(21000, { type: 'exec_command_begin', call_id: 'failed', command: ['bash', '-lc', 'check'] }) +
        line(22000, { type: 'exec_command_end', call_id: 'failed', exit_code: 1 });
    },
    bytes: async () => JSON.parse(await readFile(path, 'utf8')).sessions[SID] as TaskState,
  };
}
it.each(
  (['manual', 'command'] as const).flatMap((kind) =>
    (['blocked', 'unknown'] as const).map((outcome) => ({ kind, outcome }))
  )
)(
  'Resume cannot complete $kind criteria from the pre-$outcome terminal turn, including reload and clock rollback',
  async ({ kind, outcome }) => {
    const f = await fixture(kind, outcome);
    expect(f.task.getStatus().criteria[0]).toMatchObject({ verified: true, evidence: { source: 'owner', at: 13000 } });
    f.clock(10000);
    const restarted = new TaskController(f.deps, new TaskStore(f.path).get(SID));
    f.tasks.push(restarted);
    expect(restarted.getStatus().outcome).not.toBe('completed');
    await restarted.resume();
    await restarted.refresh();
    expect(restarted.getStatus().outcome).not.toBe('completed');
    expect((await f.bytes()).outcome).not.toBe('completed');
    expect((await f.bytes()).resumedAt).toBe(20000);
    expect(restarted.getStatus().criteria[0]).toMatchObject({
      verified: true,
      evidence: { source: 'owner', at: 13000 },
    });
    if (kind === 'command') expect(restarted.getStatus().criteria[1].verified).toBe(false);
    expect(f.act).not.toHaveBeenCalled();
    expect(f.recover).not.toHaveBeenCalled();
  }
);
it.each(['manual', 'command'] as const)(
  'allows a fresh post-resume terminal observation for %s criteria',
  async (kind) => {
    const f = await fixture(kind, 'blocked');
    f.clock(23000);
    f.observed(22500);
    if (kind === 'command') f.freshCommand();
    await f.task.refresh();
    expect(f.task.getStatus()).toMatchObject({ phase: 'completed', outcome: 'completed' });
    expect((await f.bytes()).outcome).toBe('completed');
    expect(f.task.getStatus().criteria[0].evidence).toEqual({ source: 'owner', at: 13000 });
    expect(f.act).not.toHaveBeenCalled();
    expect(f.recover).not.toHaveBeenCalled();
  }
);
it('retains explicit manual owner completion despite an old observation', async () => {
  const f = await fixture('manual', 'unknown');
  await f.task.progress({ outcome: 'completed' });
  expect(f.task.getStatus()).toMatchObject({ phase: 'completed', outcome: 'completed' });
  expect((await f.bytes()).outcome).toBe('completed');
  expect(f.act).not.toHaveBeenCalled();
  expect(f.recover).not.toHaveBeenCalled();
});
it.each([-1, Infinity, NaN, '20000'] as const)('refuses malformed durable resume time %s', (resumedAt) => {
  expect(TaskStateSchema.safeParse({ ...initialTaskState(), resumedAt }).success).toBe(false);
});

it.each([20000, NaN, Infinity, 25001])('refuses equal-boundary or malformed/future terminal time %s', async (at) => {
  const f = await fixture('manual', 'blocked');
  f.clock(23000);
  f.observed(at);
  await f.task.refresh();
  expect(f.task.getStatus().outcome).not.toBe('completed');
  expect((await f.bytes()).outcome).not.toBe('completed');
  expect(f.task.getStatus().criteria[0].verified).toBe(true);
  expect(f.act).not.toHaveBeenCalled();
  expect(f.recover).not.toHaveBeenCalled();
});

it.each(
  (['manual', 'command'] as const).flatMap((kind) =>
    (['blocked', 'unknown'] as const).map((outcome) => ({ kind, outcome }))
  )
)(
  'settings cannot certify retained $kind criteria after $outcome Resume, including durable reload',
  async ({ kind, outcome }) => {
    const f = await fixture(kind, outcome),
      before = f.task.getStatus();
    const edited = await f.task.update({ config: { maxContinuations: 5 } });
    expect(edited).toMatchObject({
      phase: 'watching',
      outcome: 'unknown',
      resumedAt: 20000,
      config: { maxContinuations: 5 },
    });
    expect(edited.criteria).toEqual(before.criteria);
    expect((await f.bytes()).outcome).toBe('unknown');
    const restarted = new TaskController(f.deps, new TaskStore(f.path).get(SID));
    f.tasks.push(restarted);
    const reedited = await restarted.update({ config: { maxContinuations: 6 } });
    expect(reedited.outcome).toBe('unknown');
    expect((await f.bytes()).outcome).toBe('unknown');
    expect(f.act).not.toHaveBeenCalled();
    expect(f.recover).not.toHaveBeenCalled();
  }
);
it('settings after unknown Resume cannot conceal a newer failed command or stop its evidence invalidation', async () => {
  const f = await fixture('command', 'unknown');
  f.clock(23000);
  f.observed(22500);
  f.failedCommand();
  const edited = await f.task.update({ config: { maxContinuations: 5 } });
  expect(edited).toMatchObject({ phase: 'watching', outcome: 'unknown' });
  expect(edited.criteria[1].verified).toBe(true); // Settings neither sample nor certify new command evidence.
  await f.task.refresh();
  expect(f.task.getStatus().criteria[1].verified).toBe(false);
  expect((await f.bytes()).criteria[1].verified).toBe(false);
  expect((await f.bytes()).outcome).not.toBe('completed');
  expect(f.act).not.toHaveBeenCalled();
  expect(f.recover).not.toHaveBeenCalled();
});
it.each(['manual', 'command'] as const)(
  'settings retain an already completed %s task and exact acceptance evidence',
  async (kind) => {
    const f = await fixture(kind, 'blocked');
    f.clock(23000);
    f.observed(22500);
    if (kind === 'command') f.freshCommand();
    await f.task.refresh();
    const completed = f.task.getStatus();
    expect(completed.outcome).toBe('completed');
    const edited = await f.task.update({ config: { maxContinuations: 5 } });
    expect(edited).toMatchObject({ phase: 'completed', outcome: 'completed' });
    expect(edited.criteria).toEqual(completed.criteria);
    expect((await f.bytes()).criteria).toEqual(completed.criteria);
    expect(f.act).not.toHaveBeenCalled();
    expect(f.recover).not.toHaveBeenCalled();
  }
);
it('settings preserve fresh explicit manual owner completion after resumed uncertainty', async () => {
  const f = await fixture('manual', 'unknown');
  await f.task.progress({ outcome: 'completed' });
  const completed = f.task.getStatus();
  const edited = await f.task.update({ config: { maxContinuations: 5 } });
  expect(edited).toMatchObject({ phase: 'completed', outcome: 'completed' });
  expect(edited.criteria).toEqual(completed.criteria);
  expect((await f.bytes()).outcome).toBe('completed');
  expect(f.act).not.toHaveBeenCalled();
  expect(f.recover).not.toHaveBeenCalled();
});
