/** @fileoverview Real boot assembly and private offer snapshots; no pane, socket or CLI effects. */
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

it.each(['reload', 'replace-old', 'held-old', 'consume-old'] as const)(
  'gives new offers their own TTL while retaining original expiry through %s',
  async (kind) => {
    const original = JSON.parse(await fs.readFile(path, 'utf8'));
    const ttl = 86_400_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(original.builtAt + ttl - 60_000);
    const fresh = entry('fresh', 'bob');
    await boot.call(context({ fresh: fresh.state }), ['fresh'], 0);
    const merged = JSON.parse(await fs.readFile(path, 'utf8'));
    expect(merged.builtAt).toBe(original.builtAt);
    const freshAt = Date.now();
    if (kind === 'replace-old') {
      const rescanned = entry('old');
      await boot.call(context({ old: rescanned.state }), ['old'], 0);
    }
    let held: RebootRestoreEntry[] = [];
    if (kind === 'held-old' || kind === 'consume-old') {
      expect(registry.beginSpending('alice')).toBe(true);
      held = registry.take(() => true, ['old'], 'alice');
      expect(held).toHaveLength(1);
      if (kind === 'consume-old') {
        await registry.releaseFlight('alice', []);
        registry.endSpending('alice');
      }
    }
    now.mockReturnValue(original.builtAt + ttl + 60_000);
    expect(registry.list(() => true).map((offer) => offer.sessionId)).toEqual(['fresh']);
    expect(merged.entryBuiltAt).toEqual({ old: original.builtAt, fresh: freshAt });
    await registry.flush();
    if (kind === 'held-old') {
      expect(registry.isHeld(held[0], 'alice')).toBe(false);
      await registry.releaseFlight('alice', held);
      registry.endSpending('alice');
    }
    registry.reset();
    await registry.configurePersistence(path);
    expect(registry.list(() => true).map((offer) => offer.sessionId)).toEqual(['fresh']);
    expect(registry.beginSpending('bob')).toBe(true);
    registry.endSpending('bob');
    now.mockReturnValue(freshAt + ttl + 1);
    expect(registry.list(() => true)).toEqual([]);
    await registry.flush();
    const reopened = new RebootRestoreRegistry();
    await reopened.configurePersistence(path);
    expect(reopened.list(() => true)).toEqual([]);
  }
);
it.each(['negative', 'future', 'missing', 'foreign', 'wrong-type', 'wrong-minimum'] as const)(
  'preserves and refuses malformed per-entry offer ages: %s',
  async (kind) => {
    registry.reset();
    await fs.rm(path + '.previous', { force: true });
    const builtAt = Date.now() - 1000;
    const ages: Record<string, unknown> = { old: builtAt };
    if (kind === 'negative') ages.old = -1;
    if (kind === 'future') ages.old = Date.now() + 1_000_000;
    if (kind === 'missing') delete ages.old;
    if (kind === 'foreign') ages.foreign = builtAt;
    if (kind === 'wrong-type') ages.old = String(builtAt);
    if (kind === 'wrong-minimum') ages.old = builtAt + 1;
    const bytes = JSON.stringify({ version: 1, builtAt, entries: [entry('old')], entryBuiltAt: ages });
    await fs.writeFile(path, bytes, { mode: 0o600 });
    await registry.configurePersistence(path);
    expect(registry.list(() => true)).toEqual([]);
    expect(registry.getBrokerCleanupState()).toBeUndefined();
    await expect(registry.set([entry('fresh')])).rejects.toThrow();
    expect(await fs.readFile(path, 'utf8')).toBe(bytes);
  }
);
