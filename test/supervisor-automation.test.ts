/** @fileoverview Fake-clock management schedules with real durable reservations and no worker effects. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SupervisorAutomationController, CHECK_IN_INSTRUCTIONS } from '../src/supervisor/automation.js';
import { SupervisorAutomationStore } from '../src/supervisor/automation-store.js';
import type { SupervisorAutomationConfig, SupervisorAutomationRecord } from '../src/types/supervisor-automation.js';
import type { RecoveryActionAuthority } from '../src/recovery/types.js';
import { createDeferred } from './mocks/index.js';

const ID = '11111111-1111-4111-8111-111111111111';
const NOW = Date.UTC(2026, 9, 16, 12);
const HOUR = 60 * 60_000;
const roots: string[] = [];
const controllers: SupervisorAutomationController[] = [];
const releases: Array<() => void> = [];
function heldRelease() {
  const deferred = createDeferred<void>();
  releases.push(() => deferred.resolve());
  return deferred;
}
afterEach(async () => {
  const stopping = controllers.splice(0);
  for (const controller of stopping) controller.stop();
  for (const release of releases.splice(0)) release();
  for (const controller of stopping) await controller.drain();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const config = (kind: 'once' | 'recurring' = 'once'): SupervisorAutomationConfig => ({
  checkIns: { enabled: false, intervalMinutes: 60 },
  tasks: [
    {
      id: 'owner-task',
      name: 'Owner task',
      instructions: 'Inspect current progress and report blockers.',
      enabled: true,
      kind,
      ...(kind === 'recurring' ? { intervalMinutes: 60 } : {}),
      maxRuns: 2,
    },
  ],
});
async function fixture(restored?: SupervisorAutomationRecord) {
  const root = await mkdtemp(join(tmpdir(), 'supervisor-schedule-'));
  roots.push(root);
  const path = join(root, 'automation.json');
  const store = new SupervisorAutomationStore(path);
  let now = NOW,
    available = true;
  const dispatch = vi.fn(
    async (_instructions: string, authority: RecoveryActionAuthority): Promise<'sent' | 'not-sent' | 'unknown'> =>
      authority() ? 'sent' : 'not-sent'
  );
  const persist = vi.fn(async (record: SupervisorAutomationRecord) => store.save(ID, record));
  const deps = { canRun: () => available, dispatch, persist, now: () => now, changed: vi.fn() };
  const controller = new SupervisorAutomationController(deps, ID, restored);
  controllers.push(controller);
  return {
    controller,
    deps,
    dispatch,
    persist,
    store,
    path,
    setTime: (value: number) => {
      now = value;
    },
    setAvailable: (value: boolean) => {
      available = value;
    },
    reload: () => {
      const reloaded = new SupervisorAutomationController(deps, ID, new SupervisorAutomationStore(path).get(ID));
      controllers.push(reloaded);
      return reloaded;
    },
  };
}

it('runs a once task exactly once, without repeating overdue work or treating instructions as a command', async () => {
  const f = await fixture(),
    cfg = config();
  cfg.tasks[0].instructions = 'Explain this literal text: $(never-execute)\nKeep the current workers.';
  await f.controller.configure(cfg);
  await f.controller.tick();
  expect(f.dispatch).toHaveBeenCalledExactlyOnceWith(cfg.tasks[0].instructions, expect.any(Function));
  f.setTime(NOW + 10 * HOUR);
  for (let i = 0; i < 3; i++) await f.controller.tick();
  const reloaded = f.reload();
  await reloaded.tick();
  expect(f.dispatch).toHaveBeenCalledOnce();
  expect(f.store.get(ID).runs).toEqual([{ taskId: 'owner-task', attempts: 1 }]);
  expect(reloaded.getStatus().status.lastRun?.phase).toBe('accepted');
});

it('performs hourly check-ins only when due and schedules one future run after a long clock gap', async () => {
  const f = await fixture();
  await f.controller.configure({ checkIns: { enabled: true, intervalMinutes: 60 }, tasks: [] });
  f.setTime(NOW + HOUR - 1);
  await f.controller.tick();
  expect(f.dispatch).not.toHaveBeenCalled();
  f.setTime(NOW + HOUR);
  await f.controller.tick();
  expect(f.dispatch).toHaveBeenCalledExactlyOnceWith(CHECK_IN_INSTRUCTIONS, expect.any(Function));
  await f.controller.tick();
  expect(f.dispatch).toHaveBeenCalledOnce();
  f.setTime(NOW + 5 * HOUR);
  await f.reload().tick();
  expect(f.dispatch).toHaveBeenCalledTimes(2);
  expect(f.store.get(ID).runs).toEqual([{ taskId: 'check-in', attempts: 2, nextRunAt: NOW + 6 * HOUR }]);
});

it('keeps recurring task limits and spent run counts through edits, disable/re-enable, removal and reuse', async () => {
  const f = await fixture(),
    cfg = config('recurring');
  await f.controller.configure(cfg);
  for (const n of [1, 2]) {
    f.setTime(NOW + n * HOUR);
    await f.controller.tick();
  }
  expect(f.dispatch).toHaveBeenCalledTimes(2);
  cfg.tasks[0].name = 'Renamed owner task';
  cfg.tasks[0].instructions = 'Updated owner instructions';
  await f.controller.configure(cfg);
  cfg.tasks[0].enabled = false;
  await f.controller.configure(cfg);
  cfg.tasks[0].enabled = true;
  await f.controller.configure(cfg);
  await f.controller.configure({ checkIns: cfg.checkIns, tasks: [] });
  await f.controller.configure(cfg);
  f.setTime(NOW + 10 * HOUR);
  await f.controller.tick();
  await f.reload().tick();
  expect(f.dispatch).toHaveBeenCalledTimes(2);
  expect(f.store.get(ID).runs.find((run) => run.taskId === 'owner-task')?.attempts).toBe(2);
});

it('serializes overlapping ticks and explicit runs while one instruction is held', async () => {
  const f = await fixture(),
    entered = createDeferred<void>(),
    release = heldRelease();
  await f.controller.configure(config('recurring'));
  let active = 0,
    maximum = 0;
  f.dispatch.mockImplementation(async () => {
    active++;
    maximum = Math.max(maximum, active);
    entered.resolve();
    await release.promise;
    active--;
    return 'sent';
  });
  f.setTime(NOW + HOUR);
  const first = f.controller.tick();
  await entered.promise;
  f.setTime(NOW + 2 * HOUR);
  await f.controller.tick();
  const manual = f.controller.runTask('owner-task', 'owner-manual-request');
  expect(f.dispatch).toHaveBeenCalledOnce();
  release.resolve();
  await first;
  await manual;
  expect(maximum).toBe(1);
  expect(f.dispatch).toHaveBeenCalledTimes(2);
});

it('acknowledges the same request binding without spending a run and rejects changed instructions or task ID reuse', async () => {
  const f = await fixture(),
    cfg = config();
  await f.controller.configure(cfg);
  await f.controller.runTask('owner-task', 'owner-request-001');
  await f.controller.runTask('owner-task', 'owner-request-001');
  expect(f.dispatch).toHaveBeenCalledOnce();
  cfg.tasks[0].instructions = 'Different owner objective';
  await f.controller.configure(cfg);
  await expect(f.controller.runTask('owner-task', 'owner-request-001')).rejects.toThrow(/different instructions/);
  cfg.tasks.push({ ...cfg.tasks[0], id: 'second-task' });
  await f.controller.configure(cfg);
  await expect(f.controller.runTask('second-task', 'owner-request-001')).rejects.toThrow(/different instructions/);
  expect(f.dispatch).toHaveBeenCalledOnce();
});

it.each(['reserved', 'unknown'] as const)(
  'never replays a durable %s instruction on restart, settings edits or new requests',
  async (phase) => {
    const f = await fixture();
    await f.controller.configure(config());
    f.dispatch.mockResolvedValue('unknown');
    await f.controller.runTask('owner-task', 'uncertain-owner-request');
    const record = f.store.get(ID);
    record.inFlight!.phase = phase;
    await f.store.save(ID, record);
    const reloaded = f.reload();
    expect(reloaded.getStatus().status).toMatchObject({
      phase: 'blocked',
      reason: 'restart-in-flight',
      inFlight: { phase: 'unknown' },
    });
    await reloaded.tick();
    await reloaded.runTask('owner-task', 'uncertain-owner-request');
    await expect(reloaded.runTask('owner-task', 'new-owner-request')).rejects.toThrow(/unresolved/);
    const cfg = config();
    cfg.tasks[0].enabled = false;
    await reloaded.configure(cfg);
    cfg.tasks[0].enabled = true;
    await reloaded.configure(cfg);
    await reloaded.tick();
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(f.store.get(ID).inFlight).toMatchObject({ requestId: 'uncertain-owner-request', phase: 'unknown' });
  }
);

it('persists the actual reservation before any effect and retains it if the final dispatch ACK is lost', async () => {
  const f = await fixture();
  await f.controller.configure(config());
  const persist = f.persist.getMockImplementation()!,
    entered = createDeferred<void>(),
    release = heldRelease();
  f.persist.mockImplementation(async (record) => {
    await persist(record);
    if (record.inFlight?.phase === 'reserved') {
      entered.resolve();
      await release.promise;
    }
  });
  const operation = f.controller.runTask('owner-task', 'durable-owner-request');
  await entered.promise;
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(new SupervisorAutomationStore(f.path).get(ID).inFlight).toMatchObject({
    requestId: 'durable-owner-request',
    phase: 'reserved',
  });
  f.persist.mockImplementation(async (record) => {
    if (!record.inFlight) throw Error('Fixture lost final ACK');
    await persist(record);
  });
  release.resolve();
  await expect(operation).rejects.toThrow(/lost final ACK/);
  expect(f.dispatch).toHaveBeenCalledOnce();
  expect(f.controller.getStatus().status).toMatchObject({ phase: 'blocked', inFlight: { phase: 'unknown' } });
  await f.controller.tick();
  expect(f.dispatch).toHaveBeenCalledOnce();
});

it('never dispatches when saving the initial reservation fails', async () => {
  const f = await fixture();
  await f.controller.configure(config());
  f.persist.mockRejectedValue(Error('Fixture storage failed'));
  await expect(f.controller.runTask('owner-task', 'failed-owner-request')).rejects.toThrow(/storage failed/);
  await f.controller.tick();
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.controller.getStatus().status).toMatchObject({ phase: 'blocked', reason: 'persistence-failed' });
});

it('disables scheduling durably if configuration authority is cancelled during its saved ACK', async () => {
  const f = await fixture(),
    entered = createDeferred<void>(),
    release = heldRelease();
  const persist = f.persist.getMockImplementation()!;
  let allowed = true;
  f.persist.mockImplementation(async (record) => {
    await persist(record);
    if (record.reason === 'configured') {
      entered.resolve();
      await release.promise;
    }
  });
  const setting = f.controller.configure(config(), () => allowed);
  await entered.promise;
  await f.controller.tick();
  expect(f.dispatch).not.toHaveBeenCalled();
  allowed = false;
  release.resolve();
  await expect(setting).rejects.toThrow(/cancelled/);
  const reloaded = f.reload();
  await reloaded.tick();
  expect(f.store.get(ID).tasks.every((task) => !task.enabled)).toBe(true);
  expect(f.dispatch).not.toHaveBeenCalled();
});

it.each(['owner', 'manager-budget'] as const)(
  'rechecks %s availability after reservation durability and before fake dispatch',
  async (withdrawal) => {
    const f = await fixture();
    await f.controller.configure(config());
    const persist = f.persist.getMockImplementation()!;
    let owner = true;
    f.persist.mockImplementation(async (record) => {
      await persist(record);
      if (record.inFlight) {
        if (withdrawal === 'owner') owner = false;
        else f.setAvailable(false);
      }
    });
    await f.controller.runTask('owner-task', 'withdrawn-owner-request', () => owner);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.store.get(ID).handled.at(-1)?.phase).toBe('refused');
  }
);

it('leaves disabled schedules and unavailable managers idle without launching or charging any run', async () => {
  const f = await fixture(),
    cfg = config();
  cfg.tasks[0].enabled = false;
  await f.controller.configure(cfg);
  await f.controller.tick();
  expect(f.dispatch).not.toHaveBeenCalled();
  cfg.tasks[0].enabled = true;
  await f.controller.configure(cfg);
  f.setAvailable(false);
  await f.controller.tick();
  expect(f.store.get(ID).runs[0].attempts).toBe(0);
  f.setAvailable(true);
  await f.controller.tick();
  expect(f.dispatch).toHaveBeenCalledOnce();
});

it.each([NaN, Infinity, -1])('fails closed for invalid dispatch clock %s through the actual journal', async (clock) => {
  const f = await fixture();
  await f.controller.configure(config());
  f.setTime(clock);
  await expect(f.controller.runTask('owner-task', 'invalid-clock-request')).rejects.toThrow();
  expect(f.dispatch).not.toHaveBeenCalled();
});

it('does not run a recurring task early after a backward clock adjustment', async () => {
  const f = await fixture();
  await f.controller.configure(config('recurring'));
  f.setTime(NOW - HOUR);
  await f.controller.tick();
  expect(f.dispatch).not.toHaveBeenCalled();
  f.setTime(NOW + HOUR);
  await f.controller.tick();
  expect(f.dispatch).toHaveBeenCalledOnce();
});
