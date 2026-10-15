/** Actual WebServer private reference capture only: no .start(), native launch, socket, or SSH. */
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { rebootRestoreRegistry } from '../src/web/reboot-restore-registry.js';
import type { RebootRestoreEntry } from '../src/reboot-restore.js';
import { TaskStore } from '../src/supervision/store.js';
import { initialTaskState, type TaskState } from '../src/supervision/schema.js';
import { RecoveryStore } from '../src/recovery/store.js';
import { initialRecoveryState, type RecoveryState } from '../src/recovery/types.js';
import { StateStore } from '../src/state-store.js';
import type { BrokerCleanupReferenceSnapshot } from '../src/recovery/codex-broker-cleanup.js';
import type { TerminalMultiplexer } from '../src/mux-interface.js';
const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  INC = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
interface Internals {
  store: StateStore;
  mux: TerminalMultiplexer;
  recoveryStore: RecoveryStore;
  taskStore: TaskStore;
  actionReservationStore: TaskStore;
  taskControllers: Map<string, { getStatus(): TaskState }>;
  recoveryControllers: Map<string, { getStatus(): RecoveryState }>;
  captureInputBrokerCleanupReferences(): BrokerCleanupReferenceSnapshot | undefined;
}
async function fixture(
  check: (f: { root: string; server: WebServer; internal: Internals; journal: RecoveryStore }) => Promise<void>
) {
  rebootRestoreRegistry.reset();
  const root = await fs.mkdtemp(join(homedir(), 'broker-reference-wiring-'));
  const server = new WebServer(0, false, true),
    internal = server as unknown as Internals;
  const journal = new RecoveryStore(join(root, 'recovery.json'));
  internal.recoveryStore = journal;
  internal.taskStore = new TaskStore(join(root, 'tasks.json'));
  internal.actionReservationStore = new TaskStore(join(root, 'action-reservations.json'));
  internal.store = new StateStore(join(root, 'state.json'));
  const sessions = vi.spyOn(internal.mux, 'getSessions').mockReturnValue([]);
  try {
    await check({ root, server, internal, journal });
  } finally {
    internal.recoveryControllers.clear();
    internal.taskControllers.clear();
    sessions.mockRestore();
    await server.stop();
    internal.store.flushAll();
    await fs.rm(root, { recursive: true, force: true });
    rebootRestoreRegistry.reset();
    vi.restoreAllMocks();
  }
}
function flight(): RecoveryState {
  return {
    ...initialRecoveryState(),
    inFlight: { key: 'closed-native-proof', action: 'restart', conversationId: SID, startedAt: 1 },
  };
}
it('captures exact current private broker incarnations and invalidates on scope change', async () =>
  fixture(async ({ internal }) => {
    vi.mocked(internal.mux.getSessions).mockReturnValue([
      {
        sessionId: SID,
        muxName: 'codeman-' + SID,
        pid: 17,
        createdAt: 1,
        workingDir: '/disposable',
        mode: 'codex',
        attached: false,
        recoveryInputBroker: INC,
      },
    ]);
    const snapshot = internal.captureInputBrokerCleanupReferences();
    expect(snapshot?.references).toContain(INC);
    expect(snapshot?.isCurrent()).toBe(true);
    vi.mocked(internal.mux.getSessions).mockReturnValue([]);
    expect(snapshot?.isCurrent()).toBe(false);
  }));
it('withholds a fresh live recovery reservation before debounced main-state persistence', async () =>
  fixture(async ({ internal }) => {
    expect(internal.store.getSessions()).toEqual({});
    const prior = internal.captureInputBrokerCleanupReferences();
    expect(prior).toBeDefined();
    internal.recoveryControllers.set(SID, { getStatus: flight });
    expect(internal.captureInputBrokerCleanupReferences()).toBeUndefined();
    expect(prior?.isCurrent()).toBe(false);
  }));
it('withholds orphaned durable recovery reservations outside the live controller map', async () =>
  fixture(async ({ internal, journal }) => {
    await journal.save('orphaned-worker', flight());
    expect(internal.recoveryControllers.size).toBe(0);
    expect(internal.captureInputBrokerCleanupReferences()).toBeUndefined();
  }));
it('withholds references when recovery journal loading failed', async () =>
  fixture(async ({ root, internal }) => {
    const path = join(root, 'malformed-recovery.json');
    await fs.writeFile(path, '{');
    internal.recoveryStore = new RecoveryStore(path);
    expect(internal.recoveryStore.loadFailed).toBe(true);
    expect(internal.captureInputBrokerCleanupReferences()).toBeUndefined();
  }));
it('withholds queued private persistence until the actual write settles', async () =>
  fixture(async ({ internal, journal }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(journal as unknown as { write(records: unknown): Promise<void> }, 'write').mockImplementation(
      async () => held
    );
    const saving = journal.save('worker', initialRecoveryState());
    expect(journal.getCleanupSnapshot()).toBeUndefined();
    expect(internal.captureInputBrokerCleanupReferences()).toBeUndefined();
    release();
    await saving;
    expect(internal.captureInputBrokerCleanupReferences()).toBeDefined();
    const snapshot = journal.getCleanupSnapshot()!;
    snapshot.worker.inFlight = flight().inFlight;
    expect(journal.getCleanupSnapshot()!.worker.inFlight).toBeUndefined();
  }));
it('latches private persistence uncertainty after a failed recovery write', async () =>
  fixture(async ({ internal, journal }) => {
    vi.spyOn(journal as unknown as { write(records: unknown): Promise<void> }, 'write').mockRejectedValue(
      Error('fixture lost durability')
    );
    await expect(journal.save('worker', initialRecoveryState())).rejects.toThrow('fixture lost durability');
    expect(journal.getCleanupSnapshot()).toBeUndefined();
    expect(internal.captureInputBrokerCleanupReferences()).toBeUndefined();
  }));

it.each(['active', 'parked', 'spending', 'unreadable'] as const)(
  'includes reboot %s ownership before authorizing broker cleanup',
  async (kind) =>
    fixture(async ({ internal, root }) => {
      const entry = {
        sessionId: SID,
        mode: 'codex',
        workingDir: root,
        resumeConversationId: SID,
        state: { id: SID, mode: 'codex', workingDir: root, __codexPriorInputBroker: INC },
      } as unknown as RebootRestoreEntry;
      const prior = internal.captureInputBrokerCleanupReferences()!;
      await rebootRestoreRegistry.set([entry]);
      if (kind === 'parked') rebootRestoreRegistry.take(() => true, undefined, 'owner');
      if (kind === 'spending') rebootRestoreRegistry.beginSpending('owner');
      if (kind === 'unreadable') {
        const path = join(root, 'malformed-offer.json');
        await fs.writeFile(path, '{');
        await rebootRestoreRegistry.configurePersistence(path);
      }
      expect(prior.isCurrent()).toBe(false);
      const snapshot = internal.captureInputBrokerCleanupReferences();
      if (kind === 'spending' || kind === 'unreadable') expect(snapshot).toBeUndefined();
      else expect(snapshot?.references).toContain(INC);
    })
);

it.each(['task', 'action'] as const)(
  'withholds orphaned durable %s reservations and unreadable journals',
  async (kind) =>
    fixture(async ({ internal, root }) => {
      const key = kind === 'task' ? 'taskStore' : 'actionReservationStore';
      const state = { ...initialTaskState(), inFlight: { key: 'unsettled-delivery', startedAt: 1 } };
      await internal[key].save(SID, state);
      expect(internal.captureInputBrokerCleanupReferences()).toBeUndefined();
      await internal[key].drop(SID);
      expect(internal.captureInputBrokerCleanupReferences()).toBeDefined();
      const path = join(root, 'malformed-' + kind + '.json');
      await fs.writeFile(path, '{');
      internal[key] = new TaskStore(path);
      expect(internal.captureInputBrokerCleanupReferences()).toBeUndefined();
    })
);
it('includes live task ownership before its journal and debounced main state can settle', async () =>
  fixture(async ({ internal }) => {
    const prior = internal.captureInputBrokerCleanupReferences()!;
    internal.taskControllers.set(SID, {
      getStatus: () => ({ ...initialTaskState(), inFlight: { key: 'pending-task', startedAt: 1 } }),
    });
    expect(internal.captureInputBrokerCleanupReferences()).toBeUndefined();
    expect(prior.isCurrent()).toBe(false);
  }));
it('keeps exact private references in healthy task records and invalidates a changed task snapshot', async () =>
  fixture(async ({ internal }) => {
    await internal.taskStore.save(SID, { ...initialTaskState(), objective: 'Owner retained reference ' + INC });
    const prior = internal.captureInputBrokerCleanupReferences()!;
    expect(prior.references).toContain(INC);
    await internal.taskStore.drop(SID);
    expect(prior.isCurrent()).toBe(false);
    expect(internal.captureInputBrokerCleanupReferences()).toBeDefined();
  }));
