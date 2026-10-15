/** Pure FIFO admission races; no process or network effects. */
import { performance } from 'node:perf_hooks';
import { afterEach, expect, it, vi } from 'vitest';
import {
  getActiveRemoteSshCount,
  getQueuedRemoteSshCount,
  getRemoteSshLimit,
  runWithRemoteSshLimit,
  RemoteSshAdmissionError,
} from '../src/remote-ssh-limiter.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function hold() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function fill() {
  const held = Array.from({ length: getRemoteSshLimit() }, hold);
  const work = held.map((gate) => runWithRemoteSshLimit(async () => gate.promise));
  await Promise.resolve();
  expect(getActiveRemoteSshCount()).toBe(held.length);
  return { held, work };
}

it.each(['expired', 'cancelled'] as const)(
  'rechecks an immediately granted slot after the admission await becomes %s',
  async (reason) => {
    let now = 0,
      current = true;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const effect = vi.fn(async () => 'must not run');
    const result = runWithRemoteSshLimit(effect, { deadline: 10, isCurrent: () => current }).catch((e) => e);
    if (reason === 'expired') now = 10;
    else current = false;
    expect(await result).toMatchObject({ reason });
    expect(effect).not.toHaveBeenCalled();
    expect(getActiveRemoteSshCount()).toBe(0);
    expect(getQueuedRemoteSshCount()).toBe(0);
  }
);

it('rechecks a queued grant that expires before its awaiting continuation resumes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let now = 0,
    releasing = false;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const { held, work } = await fill();
  const effect = vi.fn(async () => 'must not run');
  const result = runWithRemoteSshLimit(effect, {
    deadline: 10,
    isCurrent: () => {
      if (releasing) {
        releasing = false;
        // This runs in release's real grant check, before acquire's continuation.
        queueMicrotask(() => {
          now = 10;
        });
      }
      return true;
    },
  }).catch((e) => e);
  try {
    releasing = true;
    held[0].release();
    expect(await result).toMatchObject({ reason: 'expired' });
    expect(effect).not.toHaveBeenCalled();
    expect(getActiveRemoteSshCount()).toBe(held.length - 1);
    expect(getQueuedRemoteSshCount()).toBe(0);
  } finally {
    held.forEach((gate) => gate.release());
    await Promise.all(work);
  }
  expect(getActiveRemoteSshCount()).toBe(0);
});
it.each(['release-first', 'timer-first'] as const)(
  'removes expired waiters without disturbing FIFO or capacity in the %s race',
  async (order) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { held, work } = await fill();
    const started: string[] = [];
    const expired = runWithRemoteSshLimit(
      async () => {
        started.push('expired');
      },
      { deadline: 10 }
    ).catch((e) => e);
    const next = runWithRemoteSshLimit(
      async () => {
        started.push('next');
      },
      { deadline: 20 }
    );
    const last = runWithRemoteSshLimit(async () => {
      started.push('last');
    });
    try {
      expect(getQueuedRemoteSshCount()).toBe(3);
      now = 10;
      if (order === 'timer-first') await vi.advanceTimersByTimeAsync(10);
      held[0].release();
      await Promise.all([work[0], next, last]);
      await vi.advanceTimersByTimeAsync(10);
      expect(await expired).toBeInstanceOf(RemoteSshAdmissionError);
      expect(started).toEqual(['next', 'last']);
      expect(getQueuedRemoteSshCount()).toBe(0);
      expect(getActiveRemoteSshCount()).toBe(held.length - 1);
    } finally {
      held.forEach((gate) => gate.release());
      await Promise.all(work);
    }
    expect(getActiveRemoteSshCount()).toBe(0);
  }
);

it('settles a pure cancellation while the cap remains held and preserves an unbounded legacy waiter', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let now = 0,
    current = true;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const { held, work } = await fill();
  const effect = vi.fn(async () => 'unexpected');
  const cancelled = runWithRemoteSshLimit(effect, { deadline: 1000, isCurrent: () => current }).catch((e) => e);
  let legacyStarted = false;
  const legacy = runWithRemoteSshLimit(async () => {
    legacyStarted = true;
  });
  try {
    current = false;
    now = 50;
    await vi.advanceTimersByTimeAsync(50);
    expect(await cancelled).toMatchObject({ reason: 'cancelled' });
    expect(effect).not.toHaveBeenCalled();
    expect(legacyStarted).toBe(false);
    expect(getQueuedRemoteSshCount()).toBe(1);
    expect(getActiveRemoteSshCount()).toBe(held.length);
    held[0].release();
    await legacy;
    expect(legacyStarted).toBe(true);
  } finally {
    held.forEach((gate) => gate.release());
    await Promise.all(work);
  }
  expect(getActiveRemoteSshCount()).toBe(0);
  expect(getQueuedRemoteSshCount()).toBe(0);
});
