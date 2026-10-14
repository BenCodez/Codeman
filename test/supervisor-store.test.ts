import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SupervisorController } from '../src/supervisor/controller.js';
import { initialSupervisorState } from '../src/supervisor/schema.js';
import { SupervisorStore } from '../src/supervisor/store.js';

const dirs: string[] = [];
const SID = '11111111-1111-4111-8111-111111111111';
async function journal(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'codeman-supervisor-store-'));
  dirs.push(dir);
  return { dir, path: join(dir, 'supervisors.json') };
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('SupervisorStore', () => {
  it.each(['objective', 'task'] as const)(
    'preserves a historical %s containing terminal controls without re-enabling a manager',
    async (field) => {
      const { path } = await journal();
      const state = {
        ...initialSupervisorState(SID),
        objective: 'Coordinate work',
        enabled: true,
        workers: [
          {
            sessionId: '22222222-2222-4222-8222-222222222222',
            task: 'Owner task',
            criteria: [{ id: 'review', kind: 'manual', description: 'Owner accepts' }],
            assignments: 0,
            maxAssignments: 1,
            maxRuntimeMs: 60000,
          },
        ],
      };
      if (field === 'objective') state.objective += '\0';
      else state.workers[0].task += '\0';
      const bytes = JSON.stringify({ version: 1, supervisors: { [SID]: state } });
      await writeFile(path, bytes);
      const store = new SupervisorStore(path);
      expect(store.loadFailed).toBe(true);
      expect(store.get(SID)).toMatchObject({ enabled: false, phase: 'blocked', reason: 'persistence-failed' });
      await expect(store.save(SID, initialSupervisorState(SID))).rejects.toThrow();
      expect(await readFile(path, 'utf8')).toBe(bytes);
    }
  );

  it('reclaims 100 unreachable settled managers before admitting a new record', async () => {
    const { path } = await journal();
    const records = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => {
        const id = `orphan-manager-${i}`;
        return [id, initialSupervisorState(id)];
      })
    );
    await writeFile(path, JSON.stringify({ version: 1, supervisors: records }));
    const store = new SupervisorStore(path);
    await expect(store.save(SID, initialSupervisorState(SID))).rejects.toThrow(/capacity/);
    expect(await store.pruneOrphans(() => false)).toBe(100);
    await store.save(SID, initialSupervisorState(SID));
    expect(new SupervisorStore(path).all()).toEqual([initialSupervisorState(SID)]);
  });

  it('keeps accepted bindings for current managers without rewriting an unchanged journal', async () => {
    const { path } = await journal();
    const store = new SupervisorStore(path);
    const state = {
      ...initialSupervisorState(SID),
      handledRequestIds: ['request-accepted'],
      handledRequestBindings: [{ requestId: 'request-accepted', workerId: SID, action: 'assign' as const }],
    };
    await store.save(SID, state);
    const before = await stat(path);
    expect(await store.pruneOrphans((id) => id === SID)).toBe(0);
    expect((await stat(path)).ino).toBe(before.ino);
    expect(new SupervisorStore(path).get(SID)).toEqual(state);
  });

  it('serializes pruning behind uncertain operation reservations and preserves their exact binding', async () => {
    const { path } = await journal();
    const store = new SupervisorStore(path);
    await store.save('orphan-manager', initialSupervisorState('orphan-manager'));
    const reserved = {
      ...initialSupervisorState(SID),
      inFlight: {
        requestId: 'request-uncertain',
        workerId: SID,
        action: 'assign' as const,
        reservedAt: Date.now(),
      },
    };
    const save = store.save(SID, reserved);
    const prune = store.pruneOrphans(() => false);
    await save;
    expect(await prune).toBe(1);
    expect(new SupervisorStore(path).all()).toEqual([reserved]);
  });

  it('preserves unreadable bytes and readable records when orphan replacement fails', async () => {
    const { path } = await journal();
    await writeFile(path, '{unreadable}');
    await expect(new SupervisorStore(path).pruneOrphans(() => false)).rejects.toThrow(/failed to load/);
    expect(await readFile(path, 'utf8')).toBe('{unreadable}');
    await rm(path);
    const store = new SupervisorStore(path);
    await store.save(SID, initialSupervisorState(SID));
    const before = await readFile(path, 'utf8');
    Reflect.set(store, 'path', join(path, 'blocked'));
    await expect(store.pruneOrphans(() => false)).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(store.all()).toEqual([initialSupervisorState(SID)]);
    Reflect.set(store, 'path', path);
    expect(await store.pruneOrphans(() => false)).toBe(1);
  });

  it('atomically round-trips a bounded journal with owner-only file permissions', async () => {
    const { path } = await journal();
    const store = new SupervisorStore(path);
    const state = initialSupervisorState(SID);
    state.objective = 'Coordinate the release';
    state.enabled = true;
    state.phase = 'ready';
    await store.save(SID, state);
    await store.flush();

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      version: 1,
      supervisors: { [SID]: { objective: 'Coordinate the release', phase: 'ready' } },
    });
    expect(new SupervisorStore(path).get(SID)).toMatchObject(state);
  });

  it.each(['wrong-id', 'invalid-key'])(
    'preserves a malformed %s journal instead of attributing a lease to another manager',
    async (kind) => {
      const { path } = await journal();
      const state = { ...initialSupervisorState(SID), enabled: true };
      const key = kind === 'wrong-id' ? '22222222-2222-4222-8222-222222222222' : 'invalid key';
      const text = JSON.stringify({ version: 1, supervisors: { [key]: state } });
      await writeFile(path, text, { mode: 0o600 });
      const store = new SupervisorStore(path);
      expect(store.loadFailed).toBe(true);
      expect(store.get(SID)).toMatchObject({ enabled: false, phase: 'blocked', reason: 'persistence-failed' });
      expect(store.all()).toEqual([]);
      await expect(store.save(SID, initialSupervisorState(SID))).rejects.toThrow(/failed to load/);
      await expect(store.drop(key)).rejects.toThrow(/failed to load/);
      expect(await readFile(path, 'utf8')).toBe(text);
    }
  );

  it('rejects mismatched saves while retaining the original exclusive worker lease', async () => {
    const { path } = await journal();
    const store = new SupervisorStore(path);
    const other = '22222222-2222-4222-8222-222222222222';
    const worker = '33333333-3333-4333-8333-333333333333';
    const config = {
      enabled: true,
      objective: 'Coordinate the repair',
      workers: [
        {
          sessionId: worker,
          task: 'Fix the parser',
          criteria: [{ id: 'review', description: 'Owner review', kind: 'manual' as const }],
          maxAssignments: 1,
          maxRuntimeMs: 1000,
        },
      ],
    };
    const original = {
      ...initialSupervisorState(SID),
      ...config,
      workers: config.workers.map((plan) => ({ ...plan, assignments: 0 })),
    };
    await store.save(SID, original);
    const originalText = await readFile(path, 'utf8');
    await expect(store.save(SID, { ...original, supervisorSessionId: other })).rejects.toThrow(/identity mismatch/);
    expect(await readFile(path, 'utf8')).toBe(originalText);
    expect(new SupervisorStore(path).get(SID)).toEqual(original);
    const next = new SupervisorController(
      {
        validateWorkers: () => {},
        worker: () => undefined,
        persist: (state) => store.save(other, state),
        withLeases: (fn) => fn(),
        leaseHolder: (id, excluding) =>
          store
            .all()
            .find(
              (state) =>
                state.enabled &&
                state.supervisorSessionId !== excluding &&
                state.workers.some((plan) => plan.sessionId === id)
            )?.supervisorSessionId,
        startManager: async () => true,
        hasManagerAuthority: () => true,
        validateManagerAuthority: async () => true,
        pauseManager: async () => {},
        resetManager: async () => {},
        changed: () => {},
      },
      other
    );
    await expect(next.configure(config)).rejects.toThrow('Worker already has an active supervisor');
    expect(store.get(other).enabled).toBe(false);
    expect(store.get(SID)).toEqual(original);
  });

  it('fails closed after a corrupt load and refuses to overwrite the evidence', async () => {
    const { path } = await journal();
    await writeFile(path, '{corrupt', { mode: 0o600 });
    const store = new SupervisorStore(path);

    expect(store.loadFailed).toBe(true);
    expect(store.get(SID)).toMatchObject({ enabled: false, phase: 'blocked', reason: 'persistence-failed' });
    await expect(store.save(SID, initialSupervisorState(SID))).rejects.toThrow(/failed to load/);
    expect(await readFile(path, 'utf8')).toBe('{corrupt');
  });
});
