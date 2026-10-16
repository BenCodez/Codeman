/** @fileoverview Actual private task-journal commit races use only fake rollout observations. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import {
  TaskController,
  TaskCompletionEvidenceCancelledError,
  TaskConfigurationCancelledError,
} from '../src/supervision/controller.js';
import { TaskStore } from '../src/supervision/store.js';
import { initialTaskState, type TaskState } from '../src/supervision/schema.js';
import { latestProgressMarker, successfulCommands } from '../src/supervision/evidence.js';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: vi.fn(fs.open) };
});
afterEach(() => vi.restoreAllMocks());
const SID = 'commit-worker';
const CID = '11111111-2222-3333-4444-555555555555';
const line = (at: number, payload: unknown) =>
  JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload }) + '\n';
const begin = (at: number, call_id: string, command = 'check') =>
  line(at, { type: 'exec_command_begin', call_id, command: ['bash', '-lc', command] });
const end = (at: number, call_id: string, exit_code = 0) => line(at, { type: 'exec_command_end', call_id, exit_code });
const marker = line(13_000, {
  type: 'agent_message',
  message: 'CODEMAN_TASK_PROGRESS {"outcome":"completed","verifiedCriteria":["check"]}',
});
async function fixture(manualOnly = false, priorCommand = false) {
  const root = await mkdtemp(join(homedir(), 'task-completion-commit-'));
  const path = join(root, 'tasks.json');
  const submission = line(10_000, { type: 'user_message', message: 'Run the authorized check' });
  const submissionKey = createHash('sha256').update(submission.trimEnd()).digest('hex');
  let now = 10_000;
  let tail = submission;
  let identity = CID;
  const initial: TaskState = {
    ...initialTaskState(),
    config: { ...initialTaskState().config, enabled: true },
    objective: 'Complete the owner acceptance',
    criteria: [
      ...(manualOnly
        ? []
        : [{ id: 'check', kind: 'command' as const, description: 'Check passes', command: 'check', verified: false }]),
      ...(priorCommand
        ? [
            {
              id: 'prior',
              kind: 'command' as const,
              description: 'Earlier accepted check',
              command: 'prior check',
              verified: true,
              evidence: { source: 'command' as const, at: 12_000 },
            },
          ]
        : []),
      {
        id: 'owner',
        kind: 'manual',
        description: 'Owner review',
        verified: !manualOnly,
        ...(!manualOnly ? { evidence: { source: 'owner' as const, at: 10_000 } } : {}),
      },
    ],
    configuredAt: 10_000,
    startedAt: 10_000,
    kickoffAt: 10_000,
    conversationId: CID,
    submissionKey,
    outcome: 'unfinished',
    phase: 'watching',
  };
  const store = new TaskStore(path);
  await store.save(SID, initial);
  const act = vi.fn(async () => 'sent' as const);
  const task = new TaskController(
    {
      now: () => now,
      observe: async () => ({
        observation: {
          conversationId: identity,
          submissionKey,
          activity: 'working',
          reason: 'turn-running',
          at: now,
          safeToAct: false,
        },
        commands: successfulCommands(tail, 0, now),
        marker: latestProgressMarker(tail, 0, now),
      }),
      persist: (state, authority) => store.save(SID, state, authority),
      changed: () => {},
      act,
    },
    store.get(SID)
  );
  // Restarted objectives require explicit owner resume; accepted kickoff needs no input.
  await task.resume();
  tail += begin(11_000, 'first') + end(12_000, 'first');
  if (priorCommand) tail += begin(11_000, 'prior-first', 'prior check') + end(12_000, 'prior-first');
  now = 20_000;
  return {
    task,
    store,
    path,
    act,
    append: (text: string) => {
      tail += text;
    },
    replace: (text: string) => {
      tail = submission + text;
    },
    changeIdentity: () => {
      identity = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    },
    bytes: async () => JSON.parse(await readFile(path, 'utf8')).sessions[SID] as TaskState,
    cleanup: async () => {
      task.stop();
      await task.drain();
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function holdTemporary(path: string, phase: 'write' | 'sync' | 'close') {
  const actual = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open;
  let entered!: () => void;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  let intercepted = false;
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await actual(...args);
    if (intercepted || typeof args[0] !== 'string' || !args[0].startsWith(path + '.') || !args[0].endsWith('.tmp'))
      return handle;
    intercepted = true;
    const wait = async (at: typeof phase) => {
      if (at === phase) {
        entered();
        await gate;
      }
    };
    return {
      writeFile: async (...input: Parameters<typeof handle.writeFile>) => {
        await wait('write');
        await handle.writeFile(...input);
      },
      sync: async () => {
        await wait('sync');
        await handle.sync();
      },
      close: async () => {
        await wait('close');
        await handle.close();
      },
    } as unknown as typeof handle;
  });
  return { held, release };
}
const invalid = {
  pending: begin(14_000, 'newer'),
  failed: begin(14_000, 'newer') + end(15_000, 'newer', 1),
  malformed: '{"type":"event_msg","payload":',
  overlap: begin(14_000, 'older') + begin(15_000, 'newer') + end(16_000, 'newer', 1) + end(17_000, 'older'),
  'same-timestamps-different-execution': begin(11_000, 'different') + end(12_000, 'different'),
  'newer-unknown-report': line(14_000, {
    type: 'agent_message',
    message: 'CODEMAN_TASK_PROGRESS {"outcome":"unknown"}',
  }),
};

describe('command completion is authorized at durable publication', () => {
  it.each(
    (['owner', 'agent'] as const).flatMap((entry) =>
      (['write', 'sync', 'close'] as const).flatMap((phase) =>
        Object.keys(invalid).map((change) => ({ entry, phase, change }))
      )
    )
  )('$entry refuses $change during temporary $phase', async ({ entry, phase, change }) => {
    const f = await fixture();
    const before = await f.bytes();
    if (entry === 'agent') f.append(marker);
    const barrier = await holdTemporary(f.path, phase);
    const pending =
      entry === 'owner' ? f.task.progress({ outcome: 'completed', verifiedCriteria: ['check'] }) : f.task.refresh();
    const result = pending.then(
      () => undefined,
      (error: unknown) => error
    );
    try {
      await barrier.held;
      expect(await f.bytes()).toEqual(before);
      if (change === 'same-timestamps-different-execution')
        f.replace(invalid[change] + (entry === 'agent' ? marker : ''));
      else f.append(invalid[change as keyof typeof invalid]);
      barrier.release();
      const error = await result;
      expect(f.task.getStatus().outcome).not.toBe('completed');
      expect((await f.bytes()).outcome).not.toBe('completed');
      if (entry === 'owner') expect(error).toBeInstanceOf(TaskCompletionEvidenceCancelledError);
      else expect(error).toBeUndefined();
      expect(f.task.getStatus().criteria[0].verified).toBe(false);
      expect(f.task.getStatus().criteria[1]).toMatchObject({ verified: true, evidence: { source: 'owner' } });
      expect(await f.bytes()).toEqual(before);
      expect(f.store.getBrokerCleanupState()).toBeDefined();
      expect(f.act).not.toHaveBeenCalled();
    } finally {
      barrier.release();
      await result;
      await f.cleanup();
    }
  });

  it.each(
    (['owner', 'agent'] as const).flatMap((entry) =>
      (['write', 'sync', 'close'] as const).map((phase) => ({ entry, phase }))
    )
  )('commits unchanged $entry healthy proof after temporary $phase', async ({ entry, phase }) => {
    const f = await fixture();
    if (entry === 'agent') f.append(marker);
    const barrier = await holdTemporary(f.path, phase);
    const pending =
      entry === 'owner' ? f.task.progress({ outcome: 'completed', verifiedCriteria: ['check'] }) : f.task.refresh();
    try {
      await barrier.held;
      expect(f.task.getStatus().outcome).not.toBe('completed');
      barrier.release();
      await pending;
      expect(f.task.getStatus()).toMatchObject({ outcome: 'completed', phase: 'completed' });
      expect(await f.bytes()).toEqual(f.task.getStatus());
      expect(f.task.getStatus().criteria[1].evidence).toEqual({ source: 'owner', at: 10_000 });
      expect(f.act).not.toHaveBeenCalled();
    } finally {
      barrier.release();
      await pending.catch(() => {});
      await f.cleanup();
    }
  });

  it('manual owner certification remains authoritative when rollout evidence changes', async () => {
    const f = await fixture(true);
    const barrier = await holdTemporary(f.path, 'sync');
    const pending = f.task.progress({ outcome: 'completed', verifiedCriteria: ['owner'] });
    try {
      await barrier.held;
      f.append(invalid.failed + invalid.malformed);
      barrier.release();
      await pending;
      expect(f.task.getStatus()).toMatchObject({ outcome: 'completed', phase: 'completed' });
      expect(await f.bytes()).toEqual(f.task.getStatus());
      expect(f.task.getStatus().criteria[0].evidence).toMatchObject({ source: 'owner' });
      expect(f.act).not.toHaveBeenCalled();
    } finally {
      barrier.release();
      await pending.catch(() => {});
      await f.cleanup();
    }
  });

  it('identity replacement during preparation cannot certify the old conversation', async () => {
    const f = await fixture();
    const barrier = await holdTemporary(f.path, 'sync');
    const pending = f.task.progress({ outcome: 'completed', verifiedCriteria: ['check'] });
    const result = pending.catch((error: unknown) => error);
    try {
      await barrier.held;
      f.changeIdentity();
      barrier.release();
      expect(await result).toBeInstanceOf(TaskCompletionEvidenceCancelledError);
      expect((await f.bytes()).outcome).not.toBe('completed');
      expect(f.act).not.toHaveBeenCalled();
    } finally {
      barrier.release();
      await result;
      await f.cleanup();
    }
  });

  it('permits a fresh successful retry after certified precommit refusal', async () => {
    const f = await fixture();
    const barrier = await holdTemporary(f.path, 'sync');
    const pending = f.task.progress({ outcome: 'completed', verifiedCriteria: ['check'] });
    const result = pending.catch((error: unknown) => error);
    try {
      await barrier.held;
      f.append(invalid.failed);
      barrier.release();
      expect(await result).toBeInstanceOf(TaskCompletionEvidenceCancelledError);
      f.append(begin(16_000, 'retry') + end(17_000, 'retry'));
      await f.task.progress({ outcome: 'completed', verifiedCriteria: ['check'] });
      expect(f.task.getStatus()).toMatchObject({ outcome: 'completed', phase: 'completed' });
      expect(await f.bytes()).toEqual(f.task.getStatus());
      expect(f.act).not.toHaveBeenCalled();
    } finally {
      barrier.release();
      await result;
      await f.cleanup();
    }
  });

  it('retains a newer owner pause during command completion preparation', async () => {
    const f = await fixture();
    const barrier = await holdTemporary(f.path, 'sync');
    const pending = f.task.progress({ outcome: 'completed', verifiedCriteria: ['check'] });
    const result = pending.catch((error: unknown) => error);
    let pausing: Promise<TaskState> | undefined;
    try {
      await barrier.held;
      pausing = f.task.pause();
      barrier.release();
      expect(await result).toBeInstanceOf(TaskConfigurationCancelledError);
      await pausing;
      expect(f.task.getStatus()).toMatchObject({ outcome: 'unfinished', phase: 'paused' });
      expect(await f.bytes()).toEqual(f.task.getStatus());
      expect(f.act).not.toHaveBeenCalled();
    } finally {
      barrier.release();
      await result;
      await pausing;
      await f.cleanup();
    }
  });

  it('revalidates previously certified commands even when only another criterion is submitted', async () => {
    const f = await fixture(false, true);
    const before = await f.bytes();
    const barrier = await holdTemporary(f.path, 'sync');
    const pending = f.task.progress({ outcome: 'completed', verifiedCriteria: ['check'] });
    const result = pending.catch((error: unknown) => error);
    try {
      await barrier.held;
      f.append(begin(14_000, 'prior-new', 'prior check') + end(15_000, 'prior-new', 1));
      barrier.release();
      expect(await result).toBeInstanceOf(TaskCompletionEvidenceCancelledError);
      expect(f.task.getStatus().outcome).not.toBe('completed');
      expect(await f.bytes()).toEqual(before);
      expect(f.act).not.toHaveBeenCalled();
    } finally {
      barrier.release();
      await result;
      await f.cleanup();
    }
  });
});
