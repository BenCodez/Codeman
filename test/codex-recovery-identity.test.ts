/**
 * @fileoverview Sanitized fixture tests for recovery's strict Codex identity reader.
 * No Codex process, tmux or SSH is started. Every store lives below the isolated HOME.
 */

import type { Dir } from 'node:fs';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hashCodexPrompt, resolveCodexIdentity, type CodexIdentityRequest } from '../src/recovery/codex-identity.js';

const A = '019a5aa0-1111-7111-8111-111111111111';
const B = '019a5aa0-2222-7222-8222-222222222222';
const C = '019a5aa0-3333-7333-8333-333333333333';
const SESSION = '019a5aa0-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const CREATED = '2026-10-10T12:00:00.000Z';
const SUBMITTED = Date.parse('2026-10-10T12:01:00.500Z');
const PROMPT = 'Inspect the sanitized fixture.\nKeep exactly this spacing. ';

let store: string;
let workspace: string;
let originalCodexHome: string | undefined;

beforeEach(async () => {
  originalCodexHome = process.env.CODEX_HOME;
  delete process.env.CODEX_HOME;
  store = await fs.mkdtemp(join(homedir(), 'codex-recovery-'));
  workspace = join(store, 'workspace');
  await fs.mkdir(workspace);
});

afterEach(async () => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  await fs.rm(store, { recursive: true, force: true });
});

function request(changes: Partial<CodexIdentityRequest> = {}): CodexIdentityRequest {
  return { sessionId: SESSION, workingDir: workspace, codexHome: store, noDaemon: true, ...changes };
}

function header(id: string, changes: Record<string, unknown> = {}, rowTimestamp: string = CREATED): string {
  return JSON.stringify({
    timestamp: rowTimestamp,
    type: 'session_meta',
    payload: { id, cwd: workspace, originator: `codeman_${SESSION}`, ...changes },
  });
}

async function rollout(
  id: string = A,
  changes: Record<string, unknown> = {},
  rowTimestamp: string = CREATED,
  home: string = store,
  body: string = JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n'
): Promise<string> {
  const directory = join(home, 'sessions', '2026', '10', '10');
  await fs.mkdir(directory, { recursive: true });
  const path = join(directory, `rollout-2026-10-10T12-00-00-${id}.jsonl`);
  await fs.writeFile(path, header(id, changes, rowTimestamp) + '\n' + body);
  return path;
}

async function history(
  entries: Array<{ session_id: string; ts: number; text: string }>,
  home: string = store
): Promise<void> {
  await fs.writeFile(join(home, 'history.jsonl'), entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
}

function submitted(changes: Partial<CodexIdentityRequest> = {}): CodexIdentityRequest {
  return request({ submission: { at: SUBMITTED, hash: hashCodexPrompt(PROMPT) }, ...changes });
}

describe('hashCodexPrompt', () => {
  it('hashes exact UTF-8 input without normalizing it', () => {
    expect(hashCodexPrompt('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hashCodexPrompt(PROMPT)).not.toBe(hashCodexPrompt(PROMPT.trim()));
    expect(hashCodexPrompt('é')).not.toBe(hashCodexPrompt('e\u0301'));
  });
});

describe('isolated fresh Codex identity', () => {
  it('verifies an exact per-pane originator, header UUID and cwd', async () => {
    const path = await rollout();
    const result = await resolveCodexIdentity(request());
    expect(result).toMatchObject({ reason: 'verified', conversationId: A, path, tailTruncated: false });
    expect(result.head).toContain('session_meta');
    expect(result.tail).toContain('task_complete');
  });

  it('reports managed-daemon before touching the store, even with an exact resume id', async () => {
    const read = vi.spyOn(fs, 'lstat');
    expect(await resolveCodexIdentity(request({ noDaemon: false, resumeId: A }))).toEqual({ reason: 'managed-daemon' });
    expect(read).not.toHaveBeenCalled();
  });

  it('never binds to a sibling pane with the same cwd', async () => {
    await rollout(A, { originator: `codeman_${B}` });
    expect(await resolveCodexIdentity(request())).toEqual({ reason: 'unverified' });
  });

  it('selects /new by creation timestamp despite opposite file mtimes', async () => {
    const old = await rollout(A, {}, CREATED);
    const newer = await rollout(B, {}, '2026-10-10T12:02:00.000Z');
    await fs.utimes(old, new Date('2026-10-12'), new Date('2026-10-12'));
    await fs.utimes(newer, new Date('2026-10-01'), new Date('2026-10-01'));
    expect(await resolveCodexIdentity(request({ previousId: A }))).toMatchObject({
      reason: 'verified',
      conversationId: B,
    });
  });

  it('uses session_meta creation timestamp instead of the envelope write time when present', async () => {
    await rollout(A, { timestamp: '2026-10-10T12:03:00.000Z' }, CREATED);
    await rollout(B, { timestamp: CREATED }, '2026-10-10T12:04:00.000Z');
    expect(await resolveCodexIdentity(request())).toMatchObject({ reason: 'verified', conversationId: A });
  });

  it('refuses creation-time ties instead of relying on readdir order', async () => {
    await rollout(A);
    await rollout(B);
    expect(await resolveCodexIdentity(request())).toEqual({ reason: 'ambiguous' });
  });

  it('excludes a newer subagent in either supported source shape', async () => {
    await rollout(A);
    await rollout(B, { thread_source: 'subagent' }, '2026-10-10T12:02:00.000Z');
    await rollout(C, { source: { subagent: { parent_thread_id: A } } }, '2026-10-10T12:03:00.000Z');
    expect(await resolveCodexIdentity(request())).toMatchObject({ reason: 'verified', conversationId: A });
  });

  it('refuses a wrong cwd rather than selecting a nearby workspace', async () => {
    await rollout(A, { cwd: join(workspace, 'sibling') });
    expect(await resolveCodexIdentity(request())).toEqual({ reason: 'unverified' });
  });

  it('does not use previousId as authority', async () => {
    await rollout(A, { originator: 'codex-tui' });
    expect(await resolveCodexIdentity(request({ previousId: A }))).toEqual({ reason: 'unverified' });
  });
});

describe('exact submitted-prompt history attribution', () => {
  it('verifies a resumed thread through exact text and ±2 seconds', async () => {
    await rollout(A, { originator: 'codex-tui' });
    await history([{ session_id: A, ts: Math.floor(SUBMITTED / 1000), text: PROMPT }]);
    expect(await resolveCodexIdentity(submitted())).toMatchObject({ reason: 'verified', conversationId: A });
  });

  it('does not authorize a timestamp-only or whitespace-normalized match', async () => {
    await rollout();
    await history([{ session_id: A, ts: SUBMITTED / 1000, text: PROMPT.trim() }]);
    expect(await resolveCodexIdentity(submitted())).toEqual({ reason: 'unverified' });
  });

  it.each([
    { exact: 'Fixture one\nFixture two', lossy: 'Fixture one Fixture two' },
    { exact: 'Fixture prefix edited middle', lossy: 'Fixture prefix middle' },
    { exact: 'x'.repeat(8_193), lossy: 'x'.repeat(8_192) },
  ])('never falls back to a resume seed when exact input differs from a lossy collision', async ({ exact, lossy }) => {
    await rollout(A);
    await history([{ session_id: A, ts: SUBMITTED / 1000, text: lossy }]);
    expect(
      await resolveCodexIdentity(request({ resumeId: A, submission: { at: SUBMITTED, hash: hashCodexPrompt(exact) } }))
    ).toEqual({ reason: 'unverified' });
  });

  it('does not authorize an exact prompt outside the bounded time window', async () => {
    await rollout();
    await history([{ session_id: A, ts: (SUBMITTED + 2_001) / 1000, text: PROMPT }]);
    expect(await resolveCodexIdentity(submitted())).toEqual({ reason: 'unverified' });
  });

  it('refuses two exact matches even when both refer to the same thread', async () => {
    await rollout();
    await history([
      { session_id: A, ts: SUBMITTED / 1000, text: PROMPT },
      { session_id: A, ts: (SUBMITTED + 1_000) / 1000, text: PROMPT },
    ]);
    expect(await resolveCodexIdentity(submitted())).toEqual({ reason: 'ambiguous' });
  });

  it('refuses equal prompts on two threads instead of choosing the nearest timestamp', async () => {
    await rollout(A);
    await rollout(B, { originator: 'codex-tui' }, '2026-10-10T12:00:01.000Z');
    await history([
      { session_id: A, ts: SUBMITTED / 1000, text: PROMPT },
      { session_id: B, ts: (SUBMITTED + 1_000) / 1000, text: PROMPT },
    ]);
    expect(await resolveCodexIdentity(submitted())).toEqual({ reason: 'ambiguous' });
  });

  it('tracks an in-TUI /resume past an older originator and initial resume seed', async () => {
    await rollout(A);
    await rollout(B, { originator: 'codex-tui' }, '2026-10-09T12:00:00.000Z');
    await history([{ session_id: B, ts: SUBMITTED / 1000, text: PROMPT }]);
    expect(await resolveCodexIdentity(submitted({ resumeId: A, previousId: A }))).toMatchObject({
      reason: 'verified',
      conversationId: B,
    });
  });

  it('pauses when /new created another stamped thread after the matched submit', async () => {
    await rollout(A);
    await rollout(B, {}, '2026-10-10T12:02:00.000Z');
    await history([{ session_id: A, ts: SUBMITTED / 1000, text: PROMPT }]);
    expect(await resolveCodexIdentity(submitted())).toEqual({ reason: 'ambiguous' });
  });

  it('still verifies the history-selected header cwd and excludes subagents', async () => {
    await rollout(A, { originator: 'codex-tui', thread_source: 'subagent' });
    await history([{ session_id: A, ts: SUBMITTED / 1000, text: PROMPT }]);
    expect(await resolveCodexIdentity(submitted())).toEqual({ reason: 'unverified' });
    await rollout(A, { cwd: join(workspace, 'other') });
    expect(await resolveCodexIdentity(submitted())).toEqual({ reason: 'unverified' });
  });

  it.each([1e308, 0, -1, Number.MAX_SAFE_INTEGER])(
    'refuses unrelated history seconds %s whose converted timestamp is invalid',
    async (ts) => {
      await rollout();
      const matching = { session_id: A, ts: SUBMITTED / 1000, text: PROMPT };
      const unrelated = { session_id: A, ts, text: 'Unrelated sanitized history row' };
      // Keep valid chronological order so timestamp conversion is the actual veto.
      await history(ts > 0 ? [matching, unrelated] : [unrelated, matching]);
      expect(await resolveCodexIdentity(submitted())).toEqual({ reason: 'unverified' });
    }
  );

  it('keeps ordinary fractional-positive Unix seconds eligible without rounding the proof', async () => {
    await rollout();
    const seconds = (SUBMITTED + 0.125) / 1000;
    expect(Number.isInteger(seconds * 1000)).toBe(false);
    await history([{ session_id: A, ts: seconds, text: PROMPT }]);
    expect(await resolveCodexIdentity(submitted())).toMatchObject({ reason: 'verified', conversationId: A });
  });

  it('refuses missing, malformed or incomplete history after a known submission', async () => {
    await rollout();
    expect(await resolveCodexIdentity(submitted())).toEqual({ reason: 'unverified' });
    await fs.writeFile(join(store, 'history.jsonl'), '{broken}\n');
    expect(await resolveCodexIdentity(submitted())).toEqual({ reason: 'unverified' });
    await fs.writeFile(
      join(store, 'history.jsonl'),
      JSON.stringify({ session_id: A, ts: SUBMITTED / 1000, text: PROMPT })
    );
    expect(await resolveCodexIdentity(submitted())).toEqual({ reason: 'unverified' });
  });

  it('accepts a bounded history tail only when it covers the whole match window', async () => {
    await rollout();
    await history([
      { session_id: A, ts: 1, text: 'old'.repeat(100_000) },
      { session_id: A, ts: (SUBMITTED - 3_000) / 1000, text: 'earlier' },
      { session_id: A, ts: SUBMITTED / 1000, text: PROMPT },
    ]);
    expect(await resolveCodexIdentity(submitted())).toMatchObject({ reason: 'verified', conversationId: A });
    await history([
      { session_id: A, ts: 1, text: 'old'.repeat(100_000) },
      { session_id: A, ts: SUBMITTED / 1000, text: PROMPT },
    ]);
    expect(await resolveCodexIdentity(submitted())).toEqual({ reason: 'unverified' });
  });

  it('refuses out-of-order history timestamps rather than claiming truncated coverage', async () => {
    await rollout();
    await history([
      { session_id: A, ts: SUBMITTED / 1000, text: PROMPT },
      { session_id: A, ts: (SUBMITTED - 3_000) / 1000, text: 'earlier' },
    ]);
    expect(await resolveCodexIdentity(submitted())).toEqual({ reason: 'unverified' });
  });
});

describe('resume and home confinement', () => {
  it('verifies an explicit resume seed with a matching header, without guessing by cwd', async () => {
    await rollout(A, { originator: 'codex-tui' });
    expect(await resolveCodexIdentity(request({ resumeId: A }))).toMatchObject({
      reason: 'verified',
      conversationId: A,
    });
  });

  it('refuses a seed that conflicts with a fresh stamped thread', async () => {
    await rollout(A, { originator: 'codex-tui' });
    await rollout(B, {}, '2026-10-10T12:02:00.000Z');
    expect(await resolveCodexIdentity(request({ resumeId: A }))).toEqual({ reason: 'ambiguous' });
  });

  it('reads only the supplied session-specific CODEX_HOME', async () => {
    const other = join(store, 'other-home');
    await rollout(A, {}, CREATED, other);
    await rollout(B);
    process.env.CODEX_HOME = store;
    expect(await resolveCodexIdentity(request({ codexHome: other }))).toMatchObject({
      reason: 'verified',
      conversationId: A,
    });
  });

  it('uses the process CODEX_HOME when no per-session home is supplied', async () => {
    await rollout();
    process.env.CODEX_HOME = store;
    expect(await resolveCodexIdentity(request({ codexHome: undefined }))).toMatchObject({
      reason: 'verified',
      conversationId: A,
    });
  });

  it('uses the isolated user HOME by default', async () => {
    const home = join(homedir(), '.codex');
    await rollout(A, {}, CREATED, home);
    try {
      expect(await resolveCodexIdentity(request({ codexHome: undefined }))).toMatchObject({
        reason: 'verified',
        conversationId: A,
      });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('rejects relative homes and relative working directories', async () => {
    expect(await resolveCodexIdentity(request({ codexHome: 'relative' }))).toEqual({ reason: 'unverified' });
    expect(await resolveCodexIdentity(request({ workingDir: 'relative' }))).toEqual({ reason: 'unverified' });
  });

  it('refuses a symlinked sessions tree and a symlinked rollout', async () => {
    const other = join(store, 'other-home');
    await rollout(A, {}, CREATED, other);
    await fs.symlink(join(other, 'sessions'), join(store, 'sessions'), 'dir');
    expect(await resolveCodexIdentity(request())).toEqual({ reason: 'unverified' });
    await fs.unlink(join(store, 'sessions'));
    const path = await rollout();
    const foreign = join(store, 'foreign.jsonl');
    await fs.rename(path, foreign);
    await fs.symlink(foreign, path);
    expect(await resolveCodexIdentity(request())).toEqual({ reason: 'unverified' });
  });

  it('does not follow a symlinked history file', async () => {
    await rollout();
    await fs.writeFile(
      join(store, 'foreign-history'),
      JSON.stringify({ session_id: A, ts: SUBMITTED / 1000, text: PROMPT }) + '\n'
    );
    await fs.symlink(join(store, 'foreign-history'), join(store, 'history.jsonl'));
    expect(await resolveCodexIdentity(submitted())).toEqual({ reason: 'unverified' });
  });
});

describe('corrupt and over-budget stores', () => {
  it('refuses filename/header UUID mismatch, conflicting legacy id or missing creation time', async () => {
    await rollout(A, { id: B });
    expect(await resolveCodexIdentity(request())).toEqual({ reason: 'unverified' });
    await rollout(A, { session_id: B });
    expect(await resolveCodexIdentity(request())).toEqual({ reason: 'unverified' });
    await rollout(A, {}, 'not a timestamp');
    expect(await resolveCodexIdentity(request())).toEqual({ reason: 'unverified' });
  });

  it('refuses duplicate copies of the same UUID', async () => {
    const path = await rollout();
    await fs.copyFile(path, join(store, 'sessions', `rollout-copy-${A}.jsonl`));
    expect(await resolveCodexIdentity(request())).toEqual({ reason: 'ambiguous' });
  });

  it('refuses a malformed or truncated header, including an unrelated corrupt rollout', async () => {
    const path = await rollout();
    await fs.writeFile(path, '{bad json}\n');
    expect(await resolveCodexIdentity(request())).toEqual({ reason: 'unverified' });
    await rollout();
    const broken = await rollout(B, { originator: 'codex-tui' });
    await fs.writeFile(broken, header(B));
    expect(await resolveCodexIdentity(request())).toEqual({ reason: 'unverified' });
  });

  it('refuses a header beyond 128KiB instead of reading without a bound', async () => {
    await rollout(A, { base_instructions: { text: 'x'.repeat(128 * 1024) } });
    expect(await resolveCodexIdentity(request())).toEqual({ reason: 'unverified' });
  });

  it('bounds the selected tail and drops its leading partial line', async () => {
    await rollout(
      A,
      {},
      CREATED,
      store,
      JSON.stringify({ payload: 'x'.repeat(300 * 1024) }) + '\n' + '{"last":true}\n'
    );
    const result = await resolveCodexIdentity(request());
    expect(result).toMatchObject({
      reason: 'verified',
      conversationId: A,
      tail: '{"last":true}\n',
      tailTruncated: true,
    });
    expect(Buffer.byteLength(result.tail!)).toBeLessThanOrEqual(256 * 1024);
  });

  it('refuses an incomplete selected tail', async () => {
    await rollout(A, {}, CREATED, store, '{"incomplete":');
    expect(await resolveCodexIdentity(request())).toEqual({ reason: 'unverified' });
  });

  it('refuses a depth limit rather than silently skipping a subtree', async () => {
    await rollout();
    await fs.mkdir(join(store, 'sessions', 'a', 'b', 'c', 'd', 'e', 'f'), { recursive: true });
    expect(await resolveCodexIdentity(request())).toEqual({ reason: 'unverified' });
  });

  it('refuses a file budget rather than verifying a partial listing', async () => {
    await rollout();
    const directory = join(store, 'sessions');
    await Promise.all(Array.from({ length: 1_024 }, (_, i) => fs.writeFile(join(directory, `unrelated-${i}`), '')));
    expect(await resolveCodexIdentity(request())).toEqual({ reason: 'unverified' });
  });

  it('keeps an IO error distinct from a missing store and never returns private data on refusal', async () => {
    await rollout();
    vi.spyOn(fs, 'opendir').mockRejectedValueOnce(Object.assign(new Error('private path'), { code: 'EIO' }));
    expect(await resolveCodexIdentity(request())).toEqual({ reason: 'unreadable' });
    expect(await resolveCodexIdentity(request({ codexHome: join(store, 'missing') }))).toEqual({
      reason: 'unverified',
    });
  });

  it('returns by its deadline and retains single flight while a mount is stalled', async () => {
    await rollout();
    const close = vi.fn(async () => {});
    const directory = { read: async () => null, close } as unknown as Dir;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let finish: (() => void) | undefined;
    const blocked = new Promise<typeof directory>((resolveBlocked) => {
      finish = () => resolveBlocked(directory);
    });
    const read = vi.spyOn(fs, 'opendir').mockReturnValueOnce(blocked);
    const first = resolveCodexIdentity(request());
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    const replay = resolveCodexIdentity(request());
    await vi.advanceTimersByTimeAsync(2_001);
    expect(await first).toEqual({ reason: 'unreadable' });
    expect(await replay).toEqual({ reason: 'unreadable' });
    expect(await resolveCodexIdentity(request({ previousId: A }))).toEqual({ reason: 'unverified' });
    expect(read).toHaveBeenCalledTimes(1);
    finish!();
    await vi.advanceTimersByTimeAsync(1);
    expect(close).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    expect(await resolveCodexIdentity(request())).toMatchObject({ reason: 'verified', conversationId: A });
  });
});
