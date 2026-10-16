/** @fileoverview Completed task Pause is a durable no-op; all worker effects are fake. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskController, type TaskObservation } from '../src/supervision/controller.js';
import { commandHash } from '../src/supervision/evidence.js';
import { TaskStore, type TaskSaveAuthority } from '../src/supervision/store.js';
import type { TaskState } from '../src/supervision/schema.js';
const roots: string[] = [];
const controllers: TaskController[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(kind: 'manual' | 'command') {
  const root = await mkdtemp(join(tmpdir(), 'codeman-completed-pause-'));
  roots.push(root);
  const path = join(root, 'tasks.json'),
    store = new TaskStore(path);
  let now = 10000;
  const observe = vi.fn(
    async (): Promise<TaskObservation> => ({
      observation: {
        activity: 'completed',
        reason: 'turn-completed',
        at: now,
        conversationId: '11111111-2222-3333-4444-555555555555',
        turnId: 'finished-turn',
        processReady: true,
        safeToAct: false,
      },
      commands: new Map([[commandHash('npm test'), { startedAt: now - 1000, completedAt: now }]]),
    })
  );
  const act = vi.fn(async () => 'sent' as const),
    recover = vi.fn(async () => 'sent' as const),
    changed = vi.fn();
  const persist = vi.fn((state: TaskState, authority?: TaskSaveAuthority) => store.save('worker', state, authority));
  const controller = new TaskController({ observe, act, recover, changed, persist, now: () => now });
  controllers.push(controller);
  await controller.update({
    objective: 'Finish the owner task',
    criteria: [
      {
        id: 'acceptance',
        kind,
        description: 'Owner acceptance',
        ...(kind === 'command' ? { command: 'npm test' } : {}),
      },
    ],
    config: { enabled: true },
  });
  now += 2000;
  return { controller, observe, act, recover, changed, persist, store, path };
}
it.each(['manual', 'command'] as const)(
  'Pause preserves a completed %s task and its exact durable evidence',
  async (kind) => {
    const f = await fixture(kind);
    await f.controller.progress({ outcome: 'completed', verifiedCriteria: ['acceptance'] });
    const before = f.controller.getStatus(),
      bytes = await readFile(f.path, 'utf8');
    expect(before).toMatchObject({ phase: 'completed', outcome: 'completed', config: { enabled: true } });
    f.persist.mockClear();
    f.changed.mockClear();
    f.observe.mockClear();
    expect(await f.controller.pause()).toEqual(before);
    expect(await f.controller.pause()).toEqual(before);
    expect(await readFile(f.path, 'utf8')).toBe(bytes);
    expect(new TaskStore(f.path).get('worker')).toEqual(before);
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.changed).not.toHaveBeenCalled();
    expect(f.observe).not.toHaveBeenCalled();
    expect(f.act).not.toHaveBeenCalled();
    expect(f.recover).not.toHaveBeenCalled();
  }
);
it('Pause still persists owner control for an unfinished enabled task without certifying its criteria', async () => {
  const f = await fixture('manual');
  const before = f.controller.getStatus();
  expect(before.outcome).not.toBe('completed');
  const paused = await f.controller.pause();
  expect(paused).toMatchObject({
    phase: 'paused',
    reason: 'owner-paused',
    config: { enabled: true },
    criteria: [{ verified: false }],
  });
  expect(new TaskStore(f.path).get('worker')).toEqual(paused);
  expect(f.act).not.toHaveBeenCalled();
  expect(f.recover).not.toHaveBeenCalled();
});
