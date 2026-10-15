/** Actual WebServer private reference capture only: no .start(), native launch, socket, or SSH. */
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';
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
  recoveryControllers: Map<string, { getStatus(): RecoveryState }>;
  captureInputBrokerCleanupReferences(): BrokerCleanupReferenceSnapshot | undefined;
}
async function fixture(
  check: (f: { root: string; server: WebServer; internal: Internals; journal: RecoveryStore }) => Promise<void>
) {
  const root = await fs.mkdtemp(join(homedir(), 'broker-reference-wiring-'));
  const server = new WebServer(0, false, true),
    internal = server as unknown as Internals;
  const journal = new RecoveryStore(join(root, 'recovery.json'));
  internal.recoveryStore = journal;
  internal.store = new StateStore(join(root, 'state.json'));
  const sessions = vi.spyOn(internal.mux, 'getSessions').mockReturnValue([]);
  try {
    await check({ root, server, internal, journal });
  } finally {
    internal.recoveryControllers.clear();
    sessions.mockRestore();
    await server.stop();
    internal.store.flushAll();
    await fs.rm(root, { recursive: true, force: true });
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
