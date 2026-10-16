/** The complete serialized task prompt must fit the broker before task authority changes. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { TaskController, TaskValidationError, type TaskObservation } from '../src/supervision/controller.js';
import { initialTaskState, TaskUpdateSchema, type TaskState, type TaskUpdate } from '../src/supervision/schema.js';
import { TaskStore } from '../src/supervision/store.js';
import { formatTaskPrompt, taskPromptFits } from '../src/supervision/prompt.js';
import { commandHash } from '../src/supervision/evidence.js';
import { registerTaskRoutes } from '../src/web/routes/task-routes.js';
import { createRouteTestHarness } from './routes/_route-test-utils.js';

const LIMIT = 65_536;
const id = '11111111-2222-3333-4444-555555555555';
function fixture(restored?: TaskState, save?: (state: TaskState) => Promise<void>) {
  const observation: TaskObservation = {
    observation: {
      activity: 'completed',
      reason: 'turn-completed',
      at: 10_001,
      conversationId: id,
      turnId: 'finished-turn',
      submissionKey: 'owner-submission',
      processReady: true,
      safeToAct: false,
    },
    commands: new Map(),
  };
  const observe = vi.fn(async () => observation);
  const persist = vi.fn(save ?? (async () => {}));
  const changed = vi.fn();
  const act = vi.fn(async (_key: string, _conversation: string, _prompt: string) => 'sent' as const);
  const controller = new TaskController({ now: () => 10_000, observe, persist, changed, act }, restored);
  return { controller, observation, observe, persist, changed, act };
}
function configuration(text: string): TaskUpdate {
  return {
    objective: 'Authorized objective',
    criteria: Array.from({ length: 30 }, (_, i) => ({
      id: `criterion-${i}`,
      kind: 'command' as const,
      description: text,
      command: text,
    })),
  };
}
// The independent positive delivery below checks this documented serialization against the actual act argument.
function serialized(state: TaskState): string {
  return `Work on the authorized objective: ${state.objective}\nLast verified checkpoint: ${state.checkpoint}\nNext action: ${state.nextAction}\nAcceptance criteria: ${JSON.stringify(state.criteria.map((c) => ({ id: c.id, description: c.description, kind: c.kind, command: c.command, verified: c.verified })))}\nInspect recent actions before proceeding. Do not repeat completed external actions or destructive operations. Stop for approval, authentication, usage limits, completion or unknown evidence. Report progress as one structured agent message: CODEMAN_TASK_PROGRESS followed by a JSON object with outcome (unfinished, blocked, unknown, completed), checkpoint, nextAction, and optional verifiedCriteria array. Command criteria require exact command exit0 evidence; manual criteria require owner verification. Do not claim successful checks without verified evidence.`
    .replace(/[\r\n]+/g, ' ')
    .trim();
}
function stateFor(patch: TaskUpdate): TaskState {
  return {
    ...initialTaskState(),
    objective: patch.objective!,
    criteria: patch.criteria!.map((criterion) => ({ ...criterion, verified: false })),
  };
}
function boundary(bytes: number): TaskUpdate {
  const patch = configuration('x'.repeat(1000));
  const state = stateFor(patch);
  patch.objective = 'o'.repeat(bytes - Buffer.byteLength(serialized({ ...state, objective: '' })));
  expect(TaskUpdateSchema.safeParse(patch).success).toBe(true);
  expect(Buffer.byteLength(serialized(stateFor(patch)))).toBe(bytes);
  return patch;
}

it.each(
  [
    {
      name: 'maximum ASCII fields',
      patch: () => ({ ...configuration('x'.repeat(1000)), objective: 'o'.repeat(4000) }),
    },
    { name: 'multibyte fields', patch: () => configuration('界'.repeat(1000)) },
    { name: 'JSON-escaped quote fields', patch: () => configuration('"'.repeat(1000)) },
    { name: 'one byte over the exact serialized limit', patch: () => boundary(LIMIT + 1) },
  ].flatMap((test) => [false, true].map((guarded) => ({ ...test, guarded })))
)('rejects $name (guarded=$guarded) before persistence or action', async ({ patch, guarded }) => {
  const f = fixture();
  try {
    const input = patch();
    expect(TaskUpdateSchema.safeParse(input).success).toBe(true);
    expect(Buffer.byteLength(serialized(stateFor(input)))).toBeGreaterThan(LIMIT);
    const before = f.controller.getStatus();
    await expect(f.controller.update(input, guarded ? () => true : undefined)).rejects.toBeInstanceOf(
      TaskValidationError
    );
    expect(f.controller.getStatus()).toEqual(before);
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.changed).not.toHaveBeenCalled();
    expect(f.observe).not.toHaveBeenCalled();
    expect(f.act).not.toHaveBeenCalled();
  } finally {
    f.controller.stop();
    await f.controller.drain();
  }
});

it('delivers exactly 65,536 serialized UTF8 bytes with unmodified Unicode and JSON escaping', async () => {
  const f = fixture();
  try {
    const patch = boundary(LIMIT);
    // Equal UTF8 size, but different UTF16 length, and a quoted criterion requiring JSON escaping.
    patch.objective = `界${patch.objective!.slice(3)}`;
    patch.criteria![0].description = `"${patch.criteria![0].description.slice(2)}`;
    await f.controller.update(patch);
    const expected = serialized(f.controller.getStatus());
    expect(Buffer.byteLength(expected)).toBe(LIMIT);
    expect(taskPromptFits(f.controller.getStatus())).toBe(true);
    expect(formatTaskPrompt(f.controller.getStatus())).toBe(expected);
    expect(taskPromptFits(stateFor(boundary(LIMIT + 1)))).toBe(false);
    await f.controller.resume();
    expect(f.act).toHaveBeenCalledOnce();
    expect(f.act.mock.calls[0][2]).toBe(expected);
    expect(f.controller.getStatus()).toMatchObject({ phase: 'watching', reason: 'kickoff-sent' });
  } finally {
    f.controller.stop();
    await f.controller.drain();
  }
});

it.each(['paused', 'blocked', 'completed'] as const)(
  'rejects oversized partial edits without changing a %s task, and preserves valid edit semantics',
  async (phase) => {
    const state = stateFor(boundary(LIMIT));
    state.phase = phase;
    state.reason = phase === 'blocked' ? 'task-blocked' : 'owner-paused';
    state.config.enabled = true;
    state.outcome = phase === 'completed' ? 'completed' : phase === 'blocked' ? 'blocked' : 'unfinished';
    const f = fixture(state);
    try {
      if (phase === 'blocked') await f.controller.progress({ outcome: 'blocked' });
      const before = f.controller.getStatus();
      f.persist.mockClear();
      await expect(f.controller.update({ objective: `${state.objective}x` })).rejects.toBeInstanceOf(
        TaskValidationError
      );
      expect(f.controller.getStatus()).toEqual(before);
      expect(f.persist).not.toHaveBeenCalled();
      await f.controller.update({ objective: state.objective.slice(0, -1) });
      // Reload already requires explicit resume; editing must not silently reacquire watching authority.
      expect(f.controller.getStatus().phase).toBe(phase === 'completed' ? 'paused' : before.phase);
      expect(f.act).not.toHaveBeenCalled();
    } finally {
      f.controller.stop();
      await f.controller.drain();
    }
  }
);

it('refuses an oversized historical task before Start observes, persists, or reserves', async () => {
  const f = fixture(stateFor(boundary(LIMIT + 1)));
  try {
    const before = f.controller.getStatus();
    await expect(f.controller.resume()).rejects.toBeInstanceOf(TaskValidationError);
    expect(f.controller.getStatus()).toEqual(before);
    expect(f.observe).not.toHaveBeenCalled();
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.act).not.toHaveBeenCalled();
    await f.controller.update({ objective: 'Short corrected objective' });
    await f.controller.resume();
    expect(f.act).toHaveBeenCalledOnce();
  } finally {
    f.controller.stop();
    await f.controller.drain();
  }
});

it('allows explicit disable of an unchanged oversized historical task but refuses Start and oversized edits', async () => {
  const state = stateFor(boundary(LIMIT + 1));
  state.config.enabled = true;
  const f = fixture(state);
  try {
    await f.controller.update({ config: { enabled: false } });
    expect(f.controller.getStatus()).toMatchObject({ config: { enabled: false }, phase: 'disabled' });
    const disabled = f.controller.getStatus();
    f.persist.mockClear();
    await expect(f.controller.resume()).rejects.toBeInstanceOf(TaskValidationError);
    await expect(
      f.controller.update({ objective: `${state.objective}x`, config: { enabled: false } })
    ).rejects.toBeInstanceOf(TaskValidationError);
    expect(f.controller.getStatus()).toEqual(disabled);
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.act).not.toHaveBeenCalled();
  } finally {
    f.controller.stop();
    await f.controller.drain();
  }
});

it('allows verified owner completion of an oversized historical task without dispatch', async () => {
  const state = stateFor({ ...configuration('x'.repeat(1000)), objective: 'o'.repeat(4000) });
  const f = fixture(state);
  f.observation.commands.set(commandHash('x'.repeat(1000)), { startedAt: 10_000, completedAt: 10_000 });
  try {
    await f.controller.progress({
      outcome: 'completed',
      verifiedCriteria: state.criteria.map((criterion) => criterion.id),
    });
    expect(f.controller.getStatus()).toMatchObject({ phase: 'completed', outcome: 'completed' });
    expect(f.controller.getStatus().criteria.every((criterion) => criterion.verified)).toBe(true);
    expect(taskPromptFits(f.controller.getStatus())).toBe(false);
    expect(f.controller.getStatus().inFlight).toBeUndefined();
    expect(f.act).not.toHaveBeenCalled();
    f.persist.mockClear();
    await expect(f.controller.resume()).rejects.toBeInstanceOf(TaskValidationError);
    await expect(f.controller.update({ objective: state.objective.slice(0, -1) })).rejects.toBeInstanceOf(
      TaskValidationError
    );
    expect(f.controller.getStatus().phase).toBe('completed');
    expect(f.persist).not.toHaveBeenCalled();
  } finally {
    f.controller.stop();
    await f.controller.drain();
  }
});

it.each(['objective', 'checkpoint', 'nextAction'] as const)(
  'rejects non-roundtrippable UTF8 in raw %s',
  async (field) => {
    const f = fixture();
    try {
      await f.controller.update({
        objective: 'Owner task',
        criteria: [{ id: 'review', kind: 'manual', description: 'Review' }],
      });
      const before = f.controller.getStatus();
      f.persist.mockClear();
      const result =
        field === 'objective'
          ? f.controller.update({ objective: 'Broken\ud800text' })
          : f.controller.progress({ outcome: 'unfinished', [field]: 'Broken\ud800text' });
      await expect(result).rejects.toBeInstanceOf(TaskValidationError);
      expect(f.controller.getStatus()).toEqual(before);
      expect(f.persist).not.toHaveBeenCalled();
      expect(f.act).not.toHaveBeenCalled();
    } finally {
      f.controller.stop();
      await f.controller.drain();
    }
  }
);

it('permits a lone surrogate inside JSON-escaped criteria while preserving the actual wire bytes', async () => {
  const f = fixture();
  try {
    await f.controller.update({
      objective: 'Owner task',
      criteria: [{ id: 'review', kind: 'command', description: 'Review\ud800', command: 'echo \ud800' }],
    });
    await f.controller.resume();
    expect(f.act).toHaveBeenCalledOnce();
    const prompt = f.act.mock.calls[0][2];
    expect(prompt).toContain('Review\\ud800');
    expect(prompt).toContain('echo \\ud800');
    expect(Buffer.from(prompt, 'utf8').toString('utf8')).toBe(prompt);
  } finally {
    f.controller.stop();
    await f.controller.drain();
  }
});

it('rejects owner progress that exceeds the combined prompt before publishing or saving it', async () => {
  const f = fixture();
  try {
    await f.controller.update(boundary(LIMIT));
    const before = f.controller.getStatus();
    f.persist.mockClear();
    f.changed.mockClear();
    await expect(
      f.controller.progress({ outcome: 'unfinished', checkpoint: 'x', nextAction: 'y' })
    ).rejects.toBeInstanceOf(TaskValidationError);
    expect(f.controller.getStatus()).toEqual(before);
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.changed).not.toHaveBeenCalled();
    expect(f.act).not.toHaveBeenCalled();
  } finally {
    f.controller.stop();
    await f.controller.drain();
  }
});

it('keeps an overflowing agent progress marker attention-only without a continuation reservation', async () => {
  const f = fixture();
  try {
    await f.controller.update({ ...boundary(LIMIT), config: { enabled: true } });
    await f.controller.progress({ outcome: 'unfinished' });
    await f.controller.update({ config: { enabled: false } });
    await f.controller.update({ config: { enabled: true } });
    expect(f.controller.getStatus().phase).toBe('watching');
    expect(f.controller.getStatus().agentProgressVeto).toBeUndefined();
    f.observation.marker = {
      key: 'progress:oversized',
      at: 10_001,
      submissionKey: 'owner-submission',
      progress: { outcome: 'unfinished', checkpoint: 'x', nextAction: 'y' },
    };
    await f.controller.refresh();
    expect(f.controller.getStatus()).toMatchObject({
      phase: 'paused',
      reason: 'task-evidence-unknown',
      agentProgressVeto: true,
    });
    expect(f.controller.getStatus().inFlight).toBeUndefined();
    expect(f.controller.getStatus().continuations).toBe(0);
    expect(f.act).not.toHaveBeenCalled();
  } finally {
    f.controller.stop();
    await f.controller.drain();
  }
});

it('returns invalid input and retains exact durable bytes when the merged configuration overflows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'task-prompt-size-'));
  const path = join(dir, 'tasks.json');
  const store = new TaskStore(path);
  const f = fixture(undefined, (state) => store.save('worker', state));
  const h = await createRouteTestHarness((app, ctx) =>
    registerTaskRoutes(app, { ...ctx, getTaskController: () => f.controller })
  );
  try {
    await f.controller.update(boundary(LIMIT));
    const before = f.controller.getStatus();
    const bytes = await readFile(path);
    f.persist.mockClear();
    const response = await h.app.inject({
      method: 'PUT',
      url: `/api/sessions/${h.ctx._sessionId}/task`,
      payload: { objective: `${before.objective}x` },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' });
    expect(f.controller.getStatus()).toEqual(before);
    expect(await readFile(path)).toEqual(bytes);
    expect(new TaskStore(path).get('worker')).toEqual(before);
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.act).not.toHaveBeenCalled();
  } finally {
    f.controller.stop();
    await f.controller.drain();
    await h.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
