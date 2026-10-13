import { mkdirSync, writeFileSync, statSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { SessionState } from '../src/types.js';
import { hashCodexPrompt } from '../src/recovery/codex-identity.js';
import { planVerifiedRebootRestore, verifyCodexRebootIdentity } from '../src/reboot-restore.js';
import { RebootRestoreRegistry } from '../src/web/reboot-restore-registry.js';
import { readRebootIdentityFence, writeRebootIdentityFence } from '../src/recovery/reboot-identity-fence.js';
import { dataPath } from '../src/config/instance.js';
import { initialRecoveryState } from '../src/recovery/types.js';

const UUID = '12345678-1234-1234-1234-123456789abc';
function fixture(overrides: Partial<SessionState> = {}): SessionState {
  const home = join(homedir(), 'custom-codex');
  mkdirSync(join(home, 'sessions'), { recursive: true });
  writeFileSync(
    join(home, 'sessions', `rollout-2026-10-13T15-00-00-${UUID}.jsonl`),
    JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-10-13T15:00:00Z',
      payload: { id: UUID, cwd: '/workspace/project', originator: 'codeman_original' },
    }) + '\n'
  );
  return {
    id: 'original',
    pid: 1234,
    status: 'busy',
    mode: 'codex',
    workingDir: '/workspace/project',
    createdAt: Date.now() - 1000,
    currentTaskId: null,
    codexConfig: {
      noDaemon: true,
      resumeSessionId: UUID,
      model: 'model',
      reasoningEffort: 'high',
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
      noAltScreen: true,
    },
    __envOverrides: { CODEX_HOME: home },
    ...overrides,
  } as SessionState;
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
beforeEach(() => {
  rmSync(join(homedir(), 'custom-codex'), { recursive: true, force: true });
  rmSync(dataPath('reboot-identities', 'original.json'), { force: true });
});

describe('verified local Codex reboot offers', () => {
  it('honors a newer durable fence over an older debounced state snapshot', async () => {
    const state = fixture();
    (state as unknown as Record<string, unknown>).__codexRebootIdentity = { switchPending: false };
    writeRebootIdentityFence(state.id, { switchPending: true });
    expect(readRebootIdentityFence(state.id)).toEqual({ switchPending: true, submission: undefined });
    expect(statSync(dataPath('reboot-identities', `${state.id}.json`)).mode & 0o777).toBe(0o600);
    expect(await verifyCodexRebootIdentity(state)).toBeUndefined();
  });
  it('rejects restoration when its private identity fence is corrupt', async () => {
    const state = fixture();
    writeRebootIdentityFence(state.id, { switchPending: false });
    writeFileSync(dataPath('reboot-identities', `${state.id}.json`), '{partial');
    expect(await verifyCodexRebootIdentity(state)).toBeUndefined();
  });
  it('keeps the exact conversation, original managed id and full launch state', async () => {
    const state = fixture();
    const plan = await planVerifiedRebootRestore(['original'], { original: state }, () => true);
    expect(plan.skipped).toEqual([]);
    expect(plan.restore[0].resumeConversationId).toBe(UUID);
    expect(plan.restore[0].sessionId).toBe('original');
    expect(plan.restore[0].state).toBe(state);
    expect(state.codexConfig?.noAltScreen).toBe(true);
  });
  it('refuses unverified, managed-daemon and conflicting persisted identities', async () => {
    expect(
      await verifyCodexRebootIdentity(fixture({ codexConfig: { noDaemon: false, resumeSessionId: UUID } }))
    ).toBeUndefined();
    expect(
      await verifyCodexRebootIdentity(fixture({ codexConfig: { noDaemon: true, resumeSessionId: 'original' } }))
    ).toBeUndefined();
    const state = fixture();
    state.recovery = { conversationId: '99999999-1234-1234-1234-123456789abc' } as SessionState['recovery'];
    expect(await verifyCodexRebootIdentity(state)).toBeUndefined();
  });
  it('rejects stopped, clean-exited and remote records independently of valid UUIDs', async () => {
    for (const state of [
      fixture({ status: 'stopped' }),
      fixture({ paneExit: { status: 0, at: 1 } }),
      fixture({ remote: { host: 'remote' } as SessionState['remote'] }),
    ]) {
      expect((await planVerifiedRebootRestore(['original'], { original: state }, () => true)).restore).toEqual([]);
    }
  });
  it('rejects an unresolved slash switch even when the previous UUID still verifies', async () => {
    const state = fixture();
    (state as unknown as Record<string, unknown>).__codexRebootIdentity = { switchPending: true };
    expect(await verifyCodexRebootIdentity(state)).toBeUndefined();
  });
  it('rejects a stale UUID when a proven ordinary submission belongs to a different resumed thread', async () => {
    const state = fixture();
    const home = (state as unknown as { __envOverrides: Record<string, string> }).__envOverrides.CODEX_HOME;
    const other = '99999999-1234-1234-1234-123456789abc';
    writeFileSync(
      join(home, 'sessions', `rollout-2026-10-12T15-00-00-${other}.jsonl`),
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-10-12T15:00:00Z',
        payload: { id: other, cwd: state.workingDir, originator: 'codeman_other' },
      }) + '\n'
    );
    const at = Date.parse('2026-10-13T15:01:00Z');
    writeFileSync(
      join(home, 'history.jsonl'),
      JSON.stringify({ session_id: other, ts: at / 1000, text: 'new thread task' }) + '\n'
    );
    (state as unknown as Record<string, unknown>).__codexRebootIdentity = {
      switchPending: false,
      submission: { at, hash: hashCodexPrompt('new thread task') },
    };
    expect(await verifyCodexRebootIdentity(state)).toBeUndefined();
  });
  it('restores a fresh isolated session with recovery disabled from exact durable submission proof', async () => {
    const state = fixture({ codexConfig: { noDaemon: true }, recovery: initialRecoveryState() });
    const home = (state as unknown as { __envOverrides: Record<string, string> }).__envOverrides.CODEX_HOME;
    const prompt = 'ordinary task while automation is disabled';
    const at = Date.parse('2026-10-13T15:01:00Z');
    writeFileSync(
      join(home, 'history.jsonl'),
      JSON.stringify({ session_id: UUID, ts: at / 1000, text: prompt }) + '\n'
    );
    writeRebootIdentityFence(state.id, {
      switchPending: false,
      submission: { at, hash: hashCodexPrompt(prompt) },
    });

    expect(state.recovery?.config.enabled).toBe(false);
    expect(state.codexConfig?.resumeSessionId).toBeUndefined();
    const plan = await planVerifiedRebootRestore(['original'], { original: state }, () => true);
    expect(plan.skipped).toEqual([]);
    expect(plan.restore[0].resumeConversationId).toBe(UUID);
  });
  it('fails closed for repeated or corrupt proof history when no UUID was persisted', async () => {
    const state = fixture({ codexConfig: { noDaemon: true }, recovery: initialRecoveryState() });
    const home = (state as unknown as { __envOverrides: Record<string, string> }).__envOverrides.CODEX_HOME;
    const prompt = 'repeated ordinary task';
    const at = Date.parse('2026-10-13T15:01:00Z');
    writeRebootIdentityFence(state.id, {
      switchPending: false,
      submission: { at, hash: hashCodexPrompt(prompt) },
    });
    writeFileSync(
      join(home, 'history.jsonl'),
      JSON.stringify({ session_id: UUID, ts: at / 1000, text: 'different task' }) + '\n'
    );
    expect(await verifyCodexRebootIdentity(state)).toBeUndefined();

    writeFileSync(
      join(home, 'history.jsonl'),
      [
        JSON.stringify({ session_id: UUID, ts: at / 1000, text: prompt }),
        JSON.stringify({ session_id: UUID, ts: (at + 1_000) / 1000, text: prompt }),
      ].join('\n') + '\n'
    );
    expect(await verifyCodexRebootIdentity(state)).toBeUndefined();

    writeFileSync(join(home, 'history.jsonl'), '{corrupt}\n');
    expect(await verifyCodexRebootIdentity(state)).toBeUndefined();
  });
  it('does not infer identity from a matching cwd or an absent UUID', async () => {
    expect(await verifyCodexRebootIdentity(fixture({ codexConfig: { noDaemon: true } }))).toBeUndefined();
    expect(await verifyCodexRebootIdentity(fixture({ workingDir: '/different/project' }))).toBeUndefined();
  });

  it('indexes one shared CODEX_HOME once for many dead sessions', async () => {
    const home = join(homedir(), 'custom-codex');
    rmSync(join(home, 'sessions'), { recursive: true, force: true });
    mkdirSync(join(home, 'sessions'), { recursive: true });
    const persisted: Record<string, SessionState> = {};
    const dead: string[] = [];
    const history: string[] = [];
    const baseAt = Date.parse('2026-10-13T15:01:00Z');
    for (let i = 0; i < 24; i += 1) {
      const id = `fresh-${i}`;
      const conversationId = `12345678-1234-1234-1234-${i.toString().padStart(12, '0')}`;
      const workingDir = `/workspace/project-${i}`;
      const prompt = `exact task ${i}`;
      const at = baseAt + i * 1_000;
      writeFileSync(
        join(home, 'sessions', `rollout-2026-10-13T15-00-${i.toString().padStart(2, '0')}-${conversationId}.jsonl`),
        JSON.stringify({
          type: 'session_meta',
          timestamp: new Date(baseAt - 60_000 + i).toISOString(),
          payload: { id: conversationId, cwd: workingDir, originator: `codeman_${id}` },
        }) + '\n'
      );
      history.push(JSON.stringify({ session_id: conversationId, ts: at / 1000, text: prompt }));
      persisted[id] = {
        ...fixture(),
        id,
        workingDir,
        codexConfig: { noDaemon: true },
        recovery: initialRecoveryState(),
        __envOverrides: { CODEX_HOME: home },
        __codexRebootIdentity: {
          switchPending: false,
          submission: { at, hash: hashCodexPrompt(prompt) },
        },
      } as SessionState;
      dead.push(id);
    }
    writeFileSync(join(home, 'history.jsonl'), history.join('\n') + '\n');
    const scan = vi.spyOn(fs, 'opendir');

    const plan = await planVerifiedRebootRestore(dead, persisted, () => true);

    expect(plan.restore).toHaveLength(dead.length);
    expect(plan.skipped).toEqual([]);
    expect(scan).toHaveBeenCalledTimes(1);
  });
});

describe('durable reboot offer', () => {
  it('survives restart, includes a parked flight and durably respects owner-scoped dismissal', async () => {
    const state = fixture({ owner: 'alice' });
    const entry = (await planVerifiedRebootRestore(['original'], { original: state }, () => true)).restore[0];
    const path = join(homedir(), 'offers.json');
    const first = new RebootRestoreRegistry();
    first.configurePersistence(path);
    first.set([entry]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(first.take(() => true, undefined, 'admin')).toEqual([entry]);
    const restarted = new RebootRestoreRegistry();
    restarted.configurePersistence(path);
    expect(restarted.list(() => true)).toHaveLength(1);
    expect(first.clear((owner) => owner === 'bob')).toBe(0);
    expect(first.isHeld(entry, 'admin')).toBe(true);
    expect(first.clear((owner) => owner === 'alice')).toBe(1);
    expect(first.isHeld(entry, 'admin')).toBe(false);
    first.releaseFlight('admin', [entry]);
    const afterDismiss = new RebootRestoreRegistry();
    afterDismiss.configurePersistence(path);
    expect(afterDismiss.list(() => true)).toEqual([]);
  });
  it('retains the original expiration across restarts', async () => {
    vi.useFakeTimers();
    const state = fixture();
    vi.useRealTimers();
    const entry = (await planVerifiedRebootRestore(['original'], { original: state }, () => true)).restore[0];
    const path = join(homedir(), 'expired-offers.json');
    const first = new RebootRestoreRegistry();
    first.configurePersistence(path);
    first.set([entry]);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    const restarted = new RebootRestoreRegistry();
    restarted.configurePersistence(path);
    expect(restarted.list(() => true)).toEqual([]);
  });
  it('keeps durable and parked offers intact when dismissal storage fails', async () => {
    const state = fixture({ owner: 'alice' });
    const entry = (await planVerifiedRebootRestore(['original'], { original: state }, () => true)).restore[0];
    const path = join(homedir(), 'failed-dismiss-offers.json');
    let failWrites = false;
    const registry = new RebootRestoreRegistry((target, text) => {
      if (failWrites) throw new Error('injected storage failure');
      writeFileSync(target, text, { mode: 0o600 });
    });
    registry.configurePersistence(path);
    registry.set([entry]);
    expect(registry.take(() => true, undefined, 'alice')).toEqual([entry]);

    failWrites = true;
    expect(() => registry.clear((owner) => owner === 'alice')).toThrow('injected storage failure');
    // The failed transaction must not cancel the concurrent restore in memory.
    expect(registry.isHeld(entry, 'alice')).toBe(true);
    // Nor may it erase the old durable offer that a restart will read.
    const restarted = new RebootRestoreRegistry();
    restarted.configurePersistence(path);
    expect(restarted.list(() => true).map((offer) => offer.sessionId)).toEqual(['original']);

    failWrites = false;
    registry.releaseFlight('alice', [entry]);
    expect(registry.list(() => true).map((offer) => offer.sessionId)).toEqual(['original']);
  });
});
