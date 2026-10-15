/** Real boot assembly and private offer snapshots; no pane, socket or CLI effects. */
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as planning from '../src/reboot-restore.js';
import type { RebootRestoreEntry } from '../src/reboot-restore.js';
import type { SessionState } from '../src/types.js';
import { WebServer } from '../src/web/server.js';
import { RebootRestoreRegistry, rebootRestoreRegistry as registry } from '../src/web/reboot-restore-registry.js';
let root: string, path: string;
function entry(id: string, owner = 'alice'): RebootRestoreEntry {
  const state = {
    id,
    owner,
    mode: 'claude',
    workingDir: root,
    status: 'idle',
    pid: 99999,
    createdAt: Date.now() - 1000,
    lastActivityAt: Date.now() - 1000,
    currentTaskId: null,
    claudeSessionId: '11111111-2222-3333-4444-' + (id === 'old' ? '111111111111' : '222222222222'),
  } as SessionState;
  return {
    sessionId: id,
    owner,
    mode: 'claude',
    workingDir: root,
    resumeConversationId: state.claudeSessionId!,
    state,
  };
}
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const boot = Reflect.get(WebServer.prototype, 'planRebootRestoreOffer') as (
  this: unknown,
  dead: string[],
  panes: number
) => Promise<number>;
function context(states: Record<string, SessionState>) {
  return { store: { getSessions: () => states } };
}
beforeEach(async () => {
  root = await fs.mkdtemp(join(homedir(), 'offer-plan-merge-'));
  vi.stubEnv('CODEMAN_DATA_DIR', root);
  path = join(root, 'reboot-restore-offer.json');
  registry.reset();
  vi.spyOn(planning, 'looksLikeHostReboot').mockReturnValue(true);
  await registry.configurePersistence(path);
  await registry.set([entry('old')]);
  // A fresh process has only this durable offer, absent from its current mux/state.
  registry.reset();
  await registry.configurePersistence(path);
});
afterEach(async () => {
  await registry.flush();
  registry.reset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});
it('preserves absent prior offers and their original expiry while durably adding the new verified plan', async () => {
  const original = JSON.parse(await fs.readFile(path, 'utf8'));
  const fresh = entry('fresh', 'bob');
  await boot.call(context({ fresh: fresh.state }), ['fresh'], 0);
  expect(registry.list(() => true).map((e) => [e.sessionId, e.owner])).toEqual([
    ['old', 'alice'],
    ['fresh', 'bob'],
  ]);
  const saved = JSON.parse(await fs.readFile(path, 'utf8'));
  expect(saved.builtAt).toBe(original.builtAt);
  expect(saved.entries[0]).toEqual(original.entries[0]);
  const restarted = new RebootRestoreRegistry();
  await restarted.configurePersistence(path);
  expect(restarted.list(() => true).map((e) => e.sessionId)).toEqual(['old', 'fresh']);
});
it('keeps an unrelated prior offer when the newly scanned state is refused', async () => {
  const fresh = entry('fresh');
  fresh.state.status = 'stopped';
  await boot.call(context({ fresh: fresh.state }), ['fresh'], 0);
  expect(registry.list(() => true).map((e) => e.sessionId)).toEqual(['old']);
});
it.each(['verified-new-owner', 'stopped', 'blocked', 'unknown-identity'] as const)(
  'does not substitute old owner authority for freshly scanned %s state',
  async (change) => {
    const fresh = entry('old', 'bob');
    if (change === 'stopped') fresh.state.status = 'stopped';
    if (change === 'blocked') fresh.state.respawnBlocked = true;
    if (change === 'unknown-identity') {
      fresh.state.mode = 'codex';
      fresh.state.codexConfig = { noDaemon: true };
    }
    await boot.call(context({ old: fresh.state }), ['old'], 0);
    expect(registry.list(() => true).map((e) => [e.sessionId, e.owner])).toEqual(
      change === 'verified-new-owner' ? [['old', 'bob']] : []
    );
  }
);
it.each(['dismiss', 'consume', 'new-owner-plan', 'persisted-owner-change'] as const)(
  'a concurrent %s supersedes a held boot plan without resurrection',
  async (change) => {
    const fresh = entry('fresh'),
      states = { fresh: fresh.state },
      entered = barrier(),
      release = barrier();
    const original = planning.planVerifiedRebootRestore;
    vi.spyOn(planning, 'planVerifiedRebootRestore').mockImplementation(async (...args) => {
      entered.release();
      await release.promise;
      return original(...args);
    });
    const work = boot.call(context(states), ['fresh'], 0);
    await entered.promise;
    try {
      if (change === 'dismiss') await registry.clear(() => true);
      if (change === 'consume') {
        expect(registry.beginSpending('alice')).toBe(true);
        const taken = registry.take(() => true, ['old'], 'alice');
        expect(taken).toHaveLength(1);
        await registry.releaseFlight('alice', []);
        registry.endSpending('alice');
      }
      if (change === 'new-owner-plan') await registry.set([entry('newer', 'carol')]);
      if (change === 'persisted-owner-change') states.fresh.owner = 'new-current-owner';
    } finally {
      release.release();
    }
    await work;
    expect(registry.list(() => true).map((e) => e.sessionId)).toEqual(
      change === 'new-owner-plan' ? ['newer'] : change === 'persisted-owner-change' ? ['old'] : []
    );
    if (change === 'persisted-owner-change') expect(states.fresh.owner).toBe('new-current-owner');
  }
);
it('does not revive an expired old offer when a fresh boot plan is built', async () => {
  registry.reset();
  const old = entry('old');
  await fs.writeFile(path, JSON.stringify({ version: 1, builtAt: Date.now() - 86_400_001, entries: [old] }), {
    mode: 0o600,
  });
  await registry.configurePersistence(path);
  const fresh = entry('fresh');
  await boot.call(context({ fresh: fresh.state }), ['fresh'], 0);
  expect(registry.list(() => true).map((e) => e.sessionId)).toEqual(['fresh']);
});
it('keeps authoritative shadow offers when the primary is damaged', async () => {
  const saved = await fs.readFile(path);
  registry.reset();
  await fs.writeFile(path + '.previous', saved, { mode: 0o600 });
  await fs.writeFile(path, '{unreadable', { mode: 0o600 });
  await registry.configurePersistence(path);
  const fresh = entry('fresh');
  await boot.call(context({ fresh: fresh.state }), ['fresh'], 0);
  expect(registry.list(() => true).map((e) => e.sessionId)).toEqual(['old', 'fresh']);
  expect((await fs.readdir(root)).some((p) => p.startsWith('reboot-restore-offer.json.unacknowledged-'))).toBe(true);
});
it('never overwrites an unreadable authoritative journal with a new boot plan', async () => {
  registry.reset();
  const damaged = '{unreadable';
  await fs.writeFile(path + '.previous', damaged, { mode: 0o600 });
  await registry.configurePersistence(path);
  const fresh = entry('fresh');
  await boot.call(context({ fresh: fresh.state }), ['fresh'], 0);
  expect(registry.list(() => true)).toEqual([]);
  expect(await fs.readFile(path + '.previous', 'utf8')).toBe(damaged);
});
it('retains the old snapshot and fences spending when the merged write is not acknowledged', async () => {
  let fail = false;
  const local = new RebootRestoreRegistry(async () => {
    if (fail) throw Error('write not acknowledged');
  });
  await local.configurePersistence(join(root, 'fake-writer.json'));
  await local.set([entry('old')]);
  const merge = await local.preparePlanMerge();
  fail = true;
  await expect(merge([entry('fresh')], () => true, ['fresh'])).rejects.toThrow('write not acknowledged');
  expect(local.list(() => true).map((e) => e.sessionId)).toEqual(['old']);
  expect(local.beginSpending('alice')).toBe(false);
});
