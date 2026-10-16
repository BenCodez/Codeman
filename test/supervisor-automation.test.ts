/** @fileoverview Fake-clock management schedules with real durable reservations and no worker effects. */
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SupervisorAutomationController, CHECK_IN_INSTRUCTIONS } from '../src/supervisor/automation.js';
import { SupervisorAutomationStore } from '../src/supervisor/automation-store.js';
import type { SupervisorAutomationConfig, SupervisorAutomationRecord } from '../src/types/supervisor-automation.js';
import type { RecoveryActionAuthority } from '../src/recovery/types.js';
import {
  SupervisorAutomationConfigSchema,
  SupervisorAutomationRecordSchema,
  initialSupervisorAutomationRecord,
} from '../src/supervisor/automation-schema.js';
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

it('rejects overallocated recurring schedules before ACK instead of starving the later task at receipt 129', async () => {
  const f = await fixture(),
    cfg = config('recurring');
  cfg.tasks[0].maxRuns = 100;
  cfg.tasks.push({ ...cfg.tasks[0], id: 'later-task' });
  await expect(async () => f.controller.configure(cfg)).rejects.toThrow(/128 lifetime/);
  expect(f.persist).not.toHaveBeenCalled();
  expect(f.controller.getStatus().tasks).toEqual([]);
  await f.controller.tick();
  expect(f.dispatch).not.toHaveBeenCalled();
});

it('allocates enabled check-ins 100 slots and counts once tasks once and disabled custom tasks for manual runs', () => {
  const cfg = config('recurring');
  cfg.checkIns.enabled = true;
  cfg.tasks[0].maxRuns = 28;
  expect(SupervisorAutomationConfigSchema.safeParse(cfg).success).toBe(true);
  cfg.tasks[0].maxRuns = 29;
  expect(SupervisorAutomationConfigSchema.safeParse(cfg).success).toBe(false);
  cfg.tasks[0].kind = 'once';
  cfg.tasks[0].maxRuns = 100;
  expect(SupervisorAutomationConfigSchema.safeParse(cfg).success).toBe(true);
  cfg.checkIns.enabled = false;
  cfg.tasks[0].kind = 'recurring';
  cfg.tasks[0].enabled = false;
  cfg.tasks.push({ ...cfg.tasks[0], id: 'disabled-manual-task' });
  expect(SupervisorAutomationConfigSchema.safeParse(cfg).success).toBe(false);
});

it('executes both tasks to their complete allocated 128-run bound, including the later due task, then preserves receipts on reload', async () => {
  const f = await fixture(),
    cfg = config('recurring');
  cfg.tasks[0].maxRuns = 100;
  cfg.tasks.push({ ...cfg.tasks[0], id: 'later-task', instructions: 'Later task remains runnable', maxRuns: 28 });
  await f.controller.configure(cfg);
  for (let hour = 1; hour <= 100; hour++) {
    f.setTime(NOW + hour * HOUR);
    await f.controller.tick();
    await f.controller.tick();
  }
  expect(f.dispatch).toHaveBeenCalledTimes(128);
  expect(f.store.get(ID).runs).toEqual(
    expect.arrayContaining([
      { taskId: 'owner-task', attempts: 100, nextRunAt: NOW + 101 * HOUR },
      { taskId: 'later-task', attempts: 28, nextRunAt: NOW + 29 * HOUR },
    ])
  );
  const saved = f.store.get(ID);
  expect(saved.handled).toHaveLength(128);
  const reloaded = f.reload();
  await reloaded.tick();
  expect(f.dispatch).toHaveBeenCalledTimes(128);
  const last = saved.handled.at(-1)!;
  await reloaded.runTask(last.taskId, last.requestId);
  expect(f.dispatch).toHaveBeenCalledTimes(128);
  await expect(reloaded.runTask('later-task', 'new-exhausted-request')).rejects.toThrow(/full/);
  expect(f.store.get(ID).handled).toEqual(saved.handled);
});

it('includes receipts from removed tasks in edits while allowing the exact remaining allocation', async () => {
  const f = await fixture();
  await f.controller.configure(config());
  await f.controller.runTask('owner-task', 'old-task-request');
  const cfg = config('recurring');
  cfg.tasks[0].id = 'new-task';
  cfg.tasks[0].maxRuns = 100;
  cfg.tasks.push({ ...cfg.tasks[0], id: 'later-task', maxRuns: 28 });
  await expect(f.controller.configure(cfg)).rejects.toThrow(/retained history/);
  cfg.tasks[1].maxRuns = 27;
  await f.controller.configure(cfg);
  expect(f.store.get(ID).handled[0].requestId).toBe('old-task-request');
  expect(f.store.get(ID).runs.find((run) => run.taskId === 'owner-task')?.attempts).toBe(1);
  await f.controller.configure({ checkIns: cfg.checkIns, tasks: [] });
  await f.controller.runTask('owner-task', 'old-task-request');
  expect(f.dispatch).toHaveBeenCalledOnce();
});

it('does not let refused manual request IDs consume the remaining slots of admitted schedules', async () => {
  const f = await fixture(),
    cfg = config('recurring');
  cfg.tasks[0].maxRuns = 100;
  cfg.tasks.push({ ...cfg.tasks[0], id: 'later-task', maxRuns: 28 });
  await f.controller.configure(cfg);
  f.setAvailable(false);
  await expect(f.controller.runTask('owner-task', 'refused-before-run')).rejects.toThrow(/unallocated receipt/);
  expect(f.store.get(ID).handled).toEqual([]);
  expect(f.store.get(ID).runs.every((run) => run.attempts === 0)).toBe(true);
  f.setAvailable(true);
  await f.controller.runTask('owner-task', 'refused-before-run');
  expect(f.dispatch).toHaveBeenCalledOnce();
  expect(f.store.get(ID).handled[0]).toMatchObject({ requestId: 'refused-before-run', phase: 'accepted' });
});

it('retains a certified refusal when spare headroom exists and accounts for it on later edits', async () => {
  const f = await fixture(),
    cfg = config('recurring');
  cfg.tasks[0].maxRuns = 100;
  cfg.tasks.push({ ...cfg.tasks[0], id: 'later-task', maxRuns: 27 });
  await f.controller.configure(cfg);
  f.setAvailable(false);
  await f.controller.runTask('owner-task', 'spare-refusal-request');
  expect(f.store.get(ID).handled[0].phase).toBe('refused');
  await expect(f.controller.runTask('owner-task', 'second-spare-refusal')).rejects.toThrow(/unallocated receipt/);
  cfg.tasks[1].maxRuns = 28;
  await expect(f.controller.configure(cfg)).rejects.toThrow(/retained history/);
  f.setAvailable(true);
  await f.controller.runTask('owner-task', 'spare-refusal-request');
  expect(f.dispatch).not.toHaveBeenCalled();
});

it('keeps an old overallocated journal inspectable and blocks every new run until an owner reduces its allocation', async () => {
  const legacy = initialSupervisorAutomationRecord(ID),
    cfg = config('recurring');
  cfg.tasks[0].maxRuns = 100;
  cfg.tasks.push({ ...cfg.tasks[0], id: 'later-task' });
  Object.assign(legacy, cfg);
  legacy.runs = cfg.tasks.map((task) => ({ taskId: task.id, attempts: 0, nextRunAt: NOW }));
  expect(SupervisorAutomationRecordSchema.safeParse(legacy).success).toBe(true);
  const f = await fixture(legacy);
  expect(f.controller.getStatus().status).toMatchObject({ phase: 'blocked', reason: 'run-allocation-exhausted' });
  await f.controller.tick();
  await expect(f.controller.runTask('owner-task', 'legacy-new-request')).rejects.toThrow(/allocation/);
  expect(f.dispatch).not.toHaveBeenCalled();
  cfg.tasks[1].maxRuns = 28;
  await f.controller.configure(cfg);
  await f.controller.runTask('later-task', 'repaired-later-request');
  expect(f.dispatch).toHaveBeenCalledOnce();
});

it.each(['reserved', 'unknown'] as const)(
  'keeps an unresolved %s flight and old IDs sealed while reducing the remaining allocation',
  async (phase) => {
    const f = await fixture();
    await f.controller.configure(config('recurring'));
    f.dispatch.mockResolvedValue('unknown');
    await f.controller.runTask('owner-task', 'sealed-allocation-request');
    const saved = f.store.get(ID);
    saved.inFlight!.phase = phase;
    await f.store.save(ID, saved);
    const reloaded = f.reload(),
      cfg = config('recurring');
    await reloaded.runTask('owner-task', 'sealed-allocation-request');
    cfg.tasks[0].maxRuns = 1;
    await reloaded.configure(cfg);
    await expect(reloaded.runTask('owner-task', 'sealed-allocation-request')).rejects.toThrow(/different instructions/);
    await expect(reloaded.runTask('owner-task', 'new-allocation-request')).rejects.toThrow(/unresolved/);
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(f.store.get(ID).inFlight?.requestId).toBe('sealed-allocation-request');
  }
);

it('rejects malformed journals that put the same request in handled and unresolved receipts or exceed combined capacity', () => {
  const record = initialSupervisorAutomationRecord(ID),
    receipt = {
      requestId: 'same-receipt-id',
      taskId: 'owner-task',
      payloadHash: 'a'.repeat(64),
      startedAt: NOW,
      phase: 'accepted' as const,
    };
  record.handled = [receipt];
  record.inFlight = { ...receipt, phase: 'unknown' };
  expect(SupervisorAutomationRecordSchema.safeParse(record).success).toBe(false);
  record.handled = Array.from({ length: 128 }, (_, index) => ({ ...receipt, requestId: 'handled-request-' + index }));
  record.inFlight.requestId = 'different-flight-id';
  expect(SupervisorAutomationRecordSchema.safeParse(record).success).toBe(false);
});

it('retries an automatic pre-reservation readiness race without consuming receipts and then reaches the later due task', async () => {
  const f = await fixture(),
    cfg = config();
  cfg.tasks.push({ ...cfg.tasks[0], id: 'later-task', instructions: 'Inspect later work' });
  await f.controller.configure(cfg);
  const canRun = vi.spyOn(f.deps, 'canRun');
  canRun.mockReturnValueOnce(true).mockReturnValueOnce(false).mockReturnValue(true);
  await f.controller.tick();
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.store.get(ID).handled).toEqual([]);
  expect(f.store.get(ID).runs).toEqual(cfg.tasks.map((task) => ({ taskId: task.id, attempts: 0, nextRunAt: NOW })));
  await f.controller.tick();
  await f.controller.tick();
  expect(f.dispatch.mock.calls.map((call) => call[0])).toEqual(cfg.tasks.map((task) => task.instructions));
  expect(f.store.get(ID).handled).toHaveLength(2);
  expect(f.store.get(ID).runs.every((run) => run.attempts === 1)).toBe(true);
});

it('retries the same automatic readiness race even when all receipt slots are allocated', async () => {
  const f = await fixture(),
    cfg = config('recurring');
  cfg.tasks[0].maxRuns = 100;
  cfg.tasks.push({ ...cfg.tasks[0], id: 'later-task', maxRuns: 28 });
  await f.controller.configure(cfg);
  f.setTime(NOW + HOUR);
  vi.spyOn(f.deps, 'canRun').mockReturnValueOnce(true).mockReturnValueOnce(false).mockReturnValue(true);
  await f.controller.tick();
  expect(f.store.get(ID).handled).toEqual([]);
  await f.controller.tick();
  await f.controller.tick();
  expect(f.dispatch).toHaveBeenCalledTimes(2);
});

it('preserves a legacy automatic refused receipt on reload while issuing fresh IDs for certified unsent retries', async () => {
  const f = await fixture(),
    cfg = config();
  cfg.tasks.push({ ...cfg.tasks[0], id: 'later-task' });
  await f.controller.configure(cfg);
  const record = f.store.get(ID);
  const task = cfg.tasks[0],
    requestId = 'automation:' + createHash('sha256').update(`${ID}:${task.id}:0`).digest('hex');
  record.handled = [
    {
      requestId,
      taskId: task.id,
      payloadHash: createHash('sha256')
        .update(JSON.stringify({ taskId: task.id, task, instructions: task.instructions }))
        .digest('hex'),
      startedAt: NOW,
      phase: 'refused',
    },
  ];
  await f.store.save(ID, record);
  const reloaded = f.reload();
  await reloaded.tick();
  await reloaded.tick();
  expect(f.dispatch).toHaveBeenCalledTimes(2);
  expect(f.store.get(ID).handled).toHaveLength(3);
  expect(f.store.get(ID).handled[0]).toEqual(record.handled[0]);
  expect(f.store.get(ID).handled[1].requestId).not.toBe(requestId);
  await reloaded.runTask(task.id, requestId);
  expect(f.dispatch).toHaveBeenCalledTimes(2);
});

it('retains manual readiness refusals and post-reservation unknown seals while automatic readiness races stay unadmitted', async () => {
  const f = await fixture();
  await f.controller.configure(config());
  f.setAvailable(false);
  await f.controller.runTask('owner-task', 'manual-not-ready-id');
  expect(f.store.get(ID).handled[0].phase).toBe('refused');
  f.setAvailable(true);
  f.dispatch.mockResolvedValue('unknown');
  await f.controller.tick();
  const saved = f.store.get(ID);
  expect(saved.inFlight?.phase).toBe('unknown');
  expect(saved.runs[0].attempts).toBe(1);
  await f.controller.tick();
  await f.reload().tick();
  expect(f.dispatch).toHaveBeenCalledOnce();
  expect(f.store.get(ID)).toEqual(saved);
});
