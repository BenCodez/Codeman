/** Recovery journal behavior on real fixture files below test/setup.ts's isolated HOME. */
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecoveryStore } from '../src/recovery/store.js';
import { initialRecoveryState, type RecoveryState } from '../src/recovery/types.js';
import { safeRmHomeTree } from './mocks/index.js';

const NOW = Date.UTC(2026, 9, 13, 12);
const THREAD = '11111111-2222-3333-4444-555555555555';
let root: string;
let path: string;

beforeEach(async () => {
  root = await fs.mkdtemp(join(homedir(), 'codex-recovery-store-'));
  path = join(root, 'private', 'recovery.json');
});

afterEach(() => safeRmHomeTree(root));

function savedState(patch: Partial<RecoveryState> = {}): RecoveryState {
  const initial = initialRecoveryState();
  return {
    ...initial,
    ...patch,
    config: { ...initial.config, enabled: true, ...patch.config },
    conversationId: THREAD,
    armedAt: NOW - 1000,
  };
}

async function journal(data: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await fs.writeFile(path, typeof data === 'string' ? data : JSON.stringify(data));
}

describe('recovery journal durability', () => {
  it('starts disabled without a journal and does not create files during reads', async () => {
    const store = new RecoveryStore(path);
    expect(store.loadFailed).toBe(false);
    expect(store.get('missing')).toEqual(initialRecoveryState());
    await expect(fs.stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores persisted settings, a retry reservation and circuit/window state', async () => {
    const store = new RecoveryStore(path);
    const reserved = savedState({
      attempts: 2,
      failedAttempts: 1,
      windowStartedAt: NOW - 500,
      lastSuccessfulRecovery: NOW - 100,
      nextRetryAt: NOW + 3000,
      phase: 'recovering',
      inFlight: {
        key: 'failure-2',
        action: 'continue',
        conversationId: THREAD,
        startedAt: NOW,
        previousSubmissionKey: 'last-user-message',
      },
      handledEvidence: ['failure-1'],
      history: [{ at: NOW, kind: 'continue', reason: 'continuation-sent', attempt: 2 }],
    });
    reserved.config = { ...reserved.config, maxRetries: 5, detectStalls: true, recoverCrashes: false };
    const blocked = savedState({
      attempts: 3,
      failedAttempts: 3,
      windowStartedAt: NOW - 10_000,
      phase: 'failed',
      circuitOpen: true,
      needsAttention: true,
      lastReason: 'retries-exhausted',
    });
    await store.save('reserved', reserved);
    await store.save('blocked', blocked);
    await store.flush();
    const restored = new RecoveryStore(path);
    expect(restored.loadFailed).toBe(false);
    expect(restored.get('reserved')).toEqual(reserved);
    expect(restored.get('blocked')).toEqual(blocked);
  });

  it('publishes only complete old or new JSON snapshots during replacement', async () => {
    const store = new RecoveryStore(path);
    const old = savedState({ attempts: 1, windowStartedAt: NOW });
    await store.save('work', old);
    const previous = await fs.readFile(path, 'utf8');
    const next = savedState({ attempts: 2, windowStartedAt: NOW });
    const saving = store.save('work', next);
    const samples = await Promise.all(Array.from({ length: 16 }, () => fs.readFile(path, 'utf8')));
    await saving;
    const current = await fs.readFile(path, 'utf8');
    expect(current).not.toBe(previous);
    for (const sample of samples) {
      expect([previous, current]).toContain(sample);
      expect(JSON.parse(sample).version).toBe(1);
    }
    expect(new RecoveryStore(path).get('work')).toEqual(next);
    expect(await fs.readdir(dirname(path))).toEqual(['recovery.json']);
  });

  it('uses restrictive directory/file permissions and replaces a broadly-readable journal safely', async () => {
    const store = new RecoveryStore(path);
    await store.save('work', savedState());
    expect((await fs.stat(dirname(path))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    await fs.chmod(path, 0o644);
    await store.save('work', savedState({ attempts: 1 }));
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
  });

  it('serializes independent session saves without dropping siblings', async () => {
    const store = new RecoveryStore(path);
    const states = Array.from({ length: 12 }, (_, i) =>
      savedState({ attempts: i % 3, lastSuccessfulRecovery: NOW + i })
    );
    await Promise.all(states.map((state, i) => store.save(`session-${i}`, state)));
    await store.flush();
    const restored = new RecoveryStore(path);
    states.forEach((state, i) => expect(restored.get(`session-${i}`)).toEqual(state));
    expect(Object.keys(JSON.parse(await fs.readFile(path, 'utf8')).sessions)).toHaveLength(12);
  });

  it('snapshots queued saves and returns copies rather than mutable journal records', async () => {
    const store = new RecoveryStore(path);
    const state = savedState();
    const expected = structuredClone(state);
    const saving = store.save('work', state);
    state.config.enabled = false;
    state.history.push({ at: NOW, kind: 'reset', reason: 'manual-reset', attempt: 0 });
    await saving;
    const returned = store.get('work');
    returned.config.enabled = false;
    returned.handledEvidence.push('caller-mutation');
    expect(store.get('work')).toEqual(expected);
    expect(new RecoveryStore(path).get('work')).toEqual(expected);
  });

  it('keeps the last durable state after a failed save and allows later writes', async () => {
    const store = new RecoveryStore(path);
    const old = savedState({ attempts: 1 });
    await store.save('work', old);
    const dir = dirname(path);
    const held = join(root, 'held');
    await fs.rename(dir, held);
    await fs.writeFile(dir, 'a file blocks the journal directory');
    await expect(store.save('work', savedState({ attempts: 2 }))).rejects.toThrow();
    expect(store.get('work')).toEqual(old);
    expect(new RecoveryStore(join(held, 'recovery.json')).get('work')).toEqual(old);
    await fs.unlink(dir);
    await fs.rename(held, dir);
    const recovered = savedState({ attempts: 3 });
    await store.save('work', recovered);
    expect(new RecoveryStore(path).get('work')).toEqual(recovered);
    expect(await fs.readdir(dir)).toEqual(['recovery.json']);
  });

  it('drops cleaned-up sessions durably while queued sibling writes survive', async () => {
    const store = new RecoveryStore(path);
    await store.save('gone', savedState({ attempts: 1 }));
    await store.save('kept', savedState({ attempts: 2 }));
    const keep = savedState({ attempts: 3 });
    await Promise.all([store.drop('gone'), store.save('kept', keep)]);
    const restored = new RecoveryStore(path);
    expect(restored.get('gone')).toEqual(initialRecoveryState());
    expect(restored.get('kept')).toEqual(keep);
    const before = await fs.readFile(path, 'utf8');
    await store.drop('already-missing');
    expect(await fs.readFile(path, 'utf8')).toBe(before);
  });
});

describe('corrupt journals fail closed', () => {
  it.each([
    ['truncated JSON', '{"version":1,"sessions":'],
    ['unknown document version', { version: 2, sessions: {} }],
    ['unknown document field', { version: 1, sessions: {}, command: 'arbitrary text' }],
    ['invalid session identity', { version: 1, sessions: { '../escape': savedState() } }],
    ['negative attempts', { version: 1, sessions: { bad: savedState({ attempts: -1 }) } }],
    [
      'invalid conversation identity',
      { version: 1, sessions: { bad: { ...savedState(), conversationId: 'cwd-guess' } } },
    ],
    [
      'raw diagnostic reason',
      { version: 1, sessions: { bad: { ...savedState(), lastReason: 'raw secret diagnostic' } } },
    ],
    ['unknown state field', { version: 1, sessions: { bad: { ...savedState(), transcript: 'raw sensitive text' } } }],
    [
      'unknown config field',
      { version: 1, sessions: { bad: { ...savedState(), config: { ...savedState().config, command: 'arbitrary' } } } },
    ],
    ['missing config fields', { version: 1, sessions: { bad: { ...savedState(), config: { enabled: true } } } }],
    [
      'oversized history',
      {
        version: 1,
        sessions: {
          bad: savedState({
            history: Array.from({ length: 101 }, () => ({
              at: NOW,
              kind: 'state' as const,
              reason: 'observing' as const,
              attempt: 0,
            })),
          }),
        },
      },
    ],
    [
      'oversized evidence history',
      {
        version: 1,
        sessions: { bad: savedState({ handledEvidence: Array.from({ length: 33 }, (_, i) => `failure-${i}`) }) },
      },
    ],
    [
      'over-capacity session map',
      {
        version: 1,
        sessions: Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`session-${i}`, savedState()])),
      },
    ],
    ['oversized file', ' '.repeat(2 * 1024 * 1024 + 1)],
  ])('refuses %s without enabling any session', async (_label, data) => {
    await journal(data);
    const store = new RecoveryStore(path);
    expect(store.loadFailed).toBe(true);
    expect(store.get('bad')).toMatchObject({
      config: { enabled: false },
      circuitOpen: true,
      needsAttention: true,
      phase: 'blocked',
      lastReason: 'persistence-failed',
    });
    expect(store.get('bad').inFlight).toBeUndefined();
  });

  it('does not salvage enabled siblings from a partially invalid document', async () => {
    await journal({ version: 1, sessions: { good: savedState(), bad: { ...savedState(), attempts: -1 } } });
    const store = new RecoveryStore(path);
    expect(store.get('good').config.enabled).toBe(false);
    expect(store.get('good').circuitOpen).toBe(true);
  });

  it('refuses a symlinked journal without following or changing its target', async () => {
    const target = join(root, 'another-journal.json');
    const bytes = JSON.stringify({ version: 1, sessions: { work: savedState() } });
    await fs.writeFile(target, bytes);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.symlink(target, path);
    const store = new RecoveryStore(path);
    expect(store.loadFailed).toBe(true);
    expect(store.get('work').config.enabled).toBe(false);
    expect(await fs.readFile(target, 'utf8')).toBe(bytes);
  });

  it('refuses a directory at the journal path', async () => {
    await fs.mkdir(path, { recursive: true });
    const store = new RecoveryStore(path);
    expect(store.loadFailed).toBe(true);
    expect(store.get('work').config.enabled).toBe(false);
  });
});
