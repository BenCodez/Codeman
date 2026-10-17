/** Conversion publication ordering; all pane effects and durable ACKs are injected. */
import { afterEach, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { WebServer } from '../src/web/server.js';
const ID = '11111111-2222-4333-8444-555555555555';
const THREAD = '22222222-3333-4444-8555-666666666666';
const sessions: Session[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const session of sessions.splice(0)) await session.stop(false);
});
async function fixture(failure?: string) {
  const remote = {
    owned: true,
    hostId: 'fixture-host',
    host: 'example.invalid',
    username: 'fixture',
    remoteSessionName: 'fixture-pane',
  };
  const previous = new Session({ id: ID, workingDir: process.cwd(), mode: 'shell', remote: remote as never });
  const replacement = new Session({
    id: ID,
    workingDir: process.cwd(),
    mode: 'codex',
    remote: remote as never,
    codexConfig: { noDaemon: true, resumeSessionId: THREAD },
  });
  sessions.push(previous, replacement);
  const order: string[] = [];
  const map = new Map([[ID, previous]]);
  let ownerCurrent = true;
  const server = Object.create(WebServer.prototype);
  const durable = vi.fn(async (_id: string, snapshot: () => unknown, current: () => boolean) => {
    expect(current()).toBe(true);
    expect(snapshot()).toEqual({ mode: 'codex' });
    order.push('state');
    if (failure === 'state') throw Error('Lost state ACK');
  });
  Object.assign(server, {
    sessions: map,
    cleaningUp: new Set(),
    recoveryStopping: false,
    recoveryStore: { loadFailed: false, get: () => ({}) },
    taskStore: { loadFailed: false, get: () => ({}) },
    recoveryControllers: new Map(),
    taskControllers: new Map(),
    supervisorStore: { get: () => ({ enabled: false }) },
    supervisorLeaseHolder: () => undefined,
    persistDeb: { cancelKey: vi.fn() },
    mux: {
      flushSessionsDurably: vi.fn(async () => {
        order.push('mux');
      }),
    },
    store: { persistSessionDurably: durable },
    buildPersistedSessionState: () => ({ mode: 'codex' }),
    sessionListenerRefs: new Map(),
    stopTranscriptWatcher: vi.fn(),
    runSummaryTrackers: new Map(),
    respawnControllers: new Map(),
    respawnTimers: new Map(),
    pendingRespawnStarts: new Map(),
    setupSessionListeners: vi.fn(async () => {
      order.push('listeners');
    }),
    broadcast: vi.fn(),
    getSessionStateWithRespawn: () => ({ id: ID, mode: 'codex' }),
  });
  vi.spyOn(replacement, 'ensureRecoveryIdentityFence').mockImplementation(async () => {
    order.push('fence');
    if (failure === 'owner') ownerCurrent = false;
    return true;
  });
  const commit = vi.spyOn(replacement, 'commitOwnedRemoteShellConversion').mockImplementation(async (current) => {
    expect(map.get(ID)).toBe(replacement);
    expect(current()).toBe(true);
    expect(durable).toHaveBeenCalledOnce();
    order.push('commit');
    return failure !== 'commit';
  });
  const stop = vi.spyOn(previous, 'retireConvertedShellTransport').mockImplementation(async (published) => {
    expect(published).toBe(replacement);
    order.push('detach');
  });
  const attach = vi.spyOn(replacement, 'startInteractive').mockImplementation(async () => {
    order.push('attach');
    if (failure === 'attach') throw Error('Lost attach ACK');
  });
  const run = () =>
    server.replaceConvertedSession(
      previous,
      replacement,
      (expected: Session = previous) => ownerCurrent && map.get(ID) === expected
    );
  return { run, previous, replacement, map, order, stop, attach, commit, durable };
}
it('commits main state before releasing the exact converted worker and attaching it', async () => {
  const f = await fixture();
  await f.run();
  expect(f.map.get(ID)).toBe(f.replacement);
  expect(f.order).toEqual(['fence', 'mux', 'state', 'commit', 'detach', 'listeners', 'attach', 'mux', 'state']);
});
it.each(['owner', 'state'])('retains the original registration after pre-publication %s failure', async (failure) => {
  const f = await fixture(failure);
  await expect(f.run()).rejects.toThrow();
  expect(f.map.get(ID)).toBe(f.previous);
  expect(f.commit).not.toHaveBeenCalled();
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.attach).not.toHaveBeenCalled();
});
it.each(['commit', 'attach'])(
  'retains the converted registration for inspection after uncertain %s ACK',
  async (failure) => {
    const f = await fixture(failure);
    await expect(f.run()).rejects.toThrow();
    expect(f.map.get(ID)).toBe(f.replacement);
    expect(f.commit).toHaveBeenCalledOnce();
    expect(f.durable).toHaveBeenCalledOnce();
    if (failure === 'commit') expect(f.attach).not.toHaveBeenCalled();
  }
);
