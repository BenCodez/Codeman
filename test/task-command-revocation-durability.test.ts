/** @fileoverview Real task journals and fake rollout evidence retain command revocations without worker effects. */
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskController, type TaskDependencies } from '../src/supervision/controller.js';
import { latestProgressMarker, successfulCommands } from '../src/supervision/evidence.js';
import type { TaskState } from '../src/supervision/schema.js';
import { TaskStore, type TaskSaveAuthority } from '../src/supervision/store.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});
afterEach(() => vi.restoreAllMocks());
const SID = 'revocation-worker';
const CID = '11111111-2222-3333-4444-555555555555';
const line = (at: number, payload: unknown) =>
  JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload }) + '\n';
const begin = (at: number, call_id: string) =>
  line(at, { type: 'exec_command_begin', call_id, command: ['bash', '-lc', 'check A'] });
const end = (at: number, call_id: string, exit_code = 0) => line(at, { type: 'exec_command_end', call_id, exit_code });
const reruns = {
  pending: begin(14000, 'newer'),
  failed: begin(14000, 'newer') + end(15000, 'newer', 1),
  malformed: '{truncated\n',
  overlap: begin(14000, 'older') + begin(15000, 'newer') + end(16000, 'newer', 1) + end(17000, 'older'),
};
async function fixture(activity: 'working' | 'watching' = 'working') {
  const root = await mkdtemp(join(homedir(), 'task-command-revocation-'));
  const path = join(root, 'tasks.json');
  const store = new TaskStore(path);
  let now = 10000;
  const submission = line(now, { type: 'user_message', message: 'Run the owner acceptance checks' });
  const submissionKey = createHash('sha256').update(submission.trimEnd()).digest('hex');
  let tail = submission;
  const changed = vi.fn();
  const persist = vi.fn((state: TaskState, authority?: TaskSaveAuthority) => store.save(SID, state, authority));
  const act = vi.fn(async () => 'sent' as const);
  const recover = vi.fn(async () => 'sent' as const);
  const deps: TaskDependencies = {
    now: () => now,
    observe: async () => ({
      observation: { activity, reason: 'turn-running', at: now, conversationId: CID, submissionKey, safeToAct: false },
      commands: successfulCommands(tail, 0, now),
      marker: latestProgressMarker(tail, 0, now),
    }),
    persist,
    changed,
    act,
    recover,
  };
  const task = new TaskController(deps);
  await task.update({
    objective: 'Verify command checks and owner acceptance',
    criteria: [
      { id: 'A', description: 'First check passes', kind: 'command', command: 'check A' },
      { id: 'B', description: 'Second check passes', kind: 'command', command: 'check B' },
      { id: 'owner', description: 'Owner accepts result', kind: 'manual' },
    ],
    config: { enabled: true },
  });
  tail += begin(11000, 'first') + end(12000, 'first');
  now = 13000;
  await task.progress({
    outcome: 'unfinished',
    checkpoint: 'First check and owner review passed',
    nextAction: 'Run second check',
    verifiedCriteria: ['A', 'owner'],
  });
  expect(new TaskStore(path).get(SID).criteria.map((criterion) => criterion.verified)).toEqual([true, false, true]);
  changed.mockClear();
  persist.mockClear();
  return {
    task,
    store,
    path,
    deps,
    act,
    recover,
    changed,
    persist,
    append: (text: string) => {
      tail += text;
      now = 20000;
    },
    bytes: async () => JSON.parse(await readFile(path, 'utf8')).sessions[SID] as TaskState,
    cleanup: async () => {
      task.stop();
      await task.drain();
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function interceptWrite(path: string, failure = false) {
  const actual = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open;
  let entered!: () => void, release!: () => void;
  const held = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let intercepted = false;
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await actual(...args);
    if (intercepted || typeof args[0] !== 'string' || !args[0].startsWith(path + '.') || !args[0].endsWith('.tmp'))
      return handle;
    intercepted = true;
    const write = handle.writeFile.bind(handle);
    handle.writeFile = async (...input) => {
      entered();
      await gate;
      if (failure) throw new Error('Fixture task journal write failed');
      return write(...input);
    };
    return handle;
  });
  return { held, release };
}

it.each(
  (['working', 'watching'] as const).flatMap((activity) =>
    Object.entries(reruns).map(([run, tail]) => ({ activity, run, tail }))
  )
)(
  'durably publishes command revocation for $run while $activity without a progress marker',
  async ({ activity, tail }) => {
    const f = await fixture(activity);
    try {
      f.append(tail);
      const result = await f.task.refresh();
      expect(result).toMatchObject({
        phase: 'watching',
        outcome: 'unfinished',
        reason: 'command-evidence-invalidated',
      });
      expect(result.criteria[0]).toMatchObject({ id: 'A', verified: false });
      expect(result.criteria[0].evidence).toBeUndefined();
      expect(result.criteria[2]).toMatchObject({ verified: true, evidence: { source: 'owner', at: 13000 } });
      expect(f.persist).toHaveBeenCalledOnce();
      expect(f.changed).toHaveBeenCalledOnce();
      expect(f.changed.mock.calls[0][0]).toEqual(result);
      expect(await f.bytes()).toEqual(result);
      const reloaded = new TaskStore(f.path);
      expect(reloaded.loadFailed).toBe(false);
      expect(reloaded.get(SID).criteria.map((criterion) => criterion.verified)).toEqual([false, false, true]);
      const restarted = new TaskController(f.deps, reloaded.get(SID));
      expect(restarted.getStatus()).toMatchObject({ phase: 'paused', reason: 'restart-requires-resume' });
      expect(restarted.getStatus().criteria[0].verified).toBe(false);
      restarted.stop();
      await restarted.drain();
      await f.task.refresh();
      expect(f.persist).toHaveBeenCalledOnce();
      expect(f.changed).toHaveBeenCalledOnce();
      expect(f.act).not.toHaveBeenCalled();
      expect(f.recover).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  }
);
it.each(['unchanged', 'new-success'] as const)(
  'does not write or publish a spurious revocation for %s command evidence',
  async (kind) => {
    const f = await fixture();
    try {
      f.append(kind === 'new-success' ? begin(14000, 'newer') + end(15000, 'newer') : '');
      const before = await f.bytes();
      await f.task.refresh();
      expect(await f.bytes()).toEqual(before);
      expect(f.task.getStatus().criteria.map((criterion) => criterion.verified)).toEqual([true, false, true]);
      expect(f.persist).not.toHaveBeenCalled();
      expect(f.changed).not.toHaveBeenCalled();
      expect(f.act).not.toHaveBeenCalled();
      expect(f.recover).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  }
);
it.each(['owner-input', 'write-failure'] as const)(
  'retains cancellation and journal vetoes during revocation persistence: %s',
  async (kind) => {
    const f = await fixture();
    const hold = await interceptWrite(f.path, kind === 'write-failure');
    try {
      f.append(reruns.pending);
      const refresh = f.task.refresh();
      const result = refresh.catch((error: unknown) => error);
      await hold.held;
      expect(f.changed).not.toHaveBeenCalled();
      expect((await f.bytes()).criteria[0].verified).toBe(true);
      if (kind === 'owner-input') f.task.noteUserInput();
      hold.release();
      if (kind === 'write-failure') {
        expect(await result).toBeInstanceOf(Error);
        expect(f.task.getStatus()).toMatchObject({
          phase: 'blocked',
          reason: 'persistence-failed',
          config: { enabled: false },
        });
        expect((await f.bytes()).criteria[0].verified).toBe(true);
        expect(f.changed).toHaveBeenCalledOnce();
        expect(f.changed.mock.calls[0][0]).toMatchObject({ phase: 'blocked', config: { enabled: false } });
        expect(f.store.getBrokerCleanupState()).toBeUndefined();
      } else {
        await result;
        await f.task.drain();
        expect(f.task.getStatus()).toMatchObject({ phase: 'paused', reason: 'user-input' });
        expect((await f.bytes()).criteria.map((criterion) => criterion.verified)).toEqual([false, false, true]);
        expect(new TaskStore(f.path).get(SID).criteria[0].verified).toBe(false);
        expect(f.changed.mock.calls.at(-1)![0]).toMatchObject({ phase: 'paused', reason: 'user-input' });
      }
      expect(f.act).not.toHaveBeenCalled();
      expect(f.recover).not.toHaveBeenCalled();
    } finally {
      hold.release();
      await f.cleanup();
    }
  }
);
