/** @fileoverview Both production broker transports use strict fake child processes and private pipes. */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const effects = vi.hoisted(() => ({ spawn: vi.fn(), exec: vi.fn() }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const refuse = () => {
    throw new Error('Uninjected process execution forbidden');
  };
  return {
    ...actual,
    spawn: effects.spawn,
    exec: effects.exec,
    execFile: refuse,
    execSync: refuse,
    execFileSync: refuse,
    spawnSync: refuse,
    fork: refuse,
  };
});
import { provisionRemoteInputBroker } from '../src/recovery/remote-input-broker.js';
import { observeOwnedRemoteBroker } from '../src/recovery/remote-broker-launch.js';
import { sampleRemoteCodexClock } from '../src/recovery/remote-clock.js';
import {
  getActiveRemoteSshCount,
  getQueuedRemoteSshCount,
  getRemoteSshLimit,
  runWithRemoteSshLimit,
} from '../src/remote-ssh-limiter.js';
import type { SessionRemote } from '../src/types.js';
const remote: SessionRemote = {
  hostId: 'fixture',
  label: 'Fixture',
  host: 'worker.invalid',
  username: 'fixture',
  remotePath: '/fixture/work',
  owned: true,
};
const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const incarnation = '11111111-2222-3333-4444-555555555555';
const secret = 'Private fixture café 🧭';
const material = {
  source: secret,
  configJson: JSON.stringify({ sessionId: id, incarnation }),
  sessionId: id,
  incarnation,
};
const descriptor = {
  directory: '/fixture/broker/' + id + '/' + incarnation,
  incarnation,
  startupNonce: incarnation,
  launchDigest: 'a'.repeat(64),
  homeDigest: 'b'.repeat(64),
  keyDigest: 'c'.repeat(64),
  helperDigest: 'd'.repeat(64),
};
const cases = ['provision', 'observe'] as const;
function authority() {
  return { prepare: vi.fn(async () => true), isCurrent: vi.fn(() => true) };
}
function request(kind: (typeof cases)[number], auth = authority()) {
  return kind === 'provision'
    ? provisionRemoteInputBroker(remote, material, auth)
    : observeOwnedRemoteBroker(remote, { sessionId: id, descriptor, inspect: true }, auth);
}
function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => false),
  });
  const input: Buffer[] = [];
  child.stdin.on('data', (chunk) => input.push(Buffer.from(chunk)));
  return Object.assign(child, { input: () => Buffer.concat(input).toString('utf8') });
}
const children: ReturnType<typeof fakeChild>[] = [];
let previousVitest: string | undefined;
let now: number;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
beforeEach(() => {
  previousVitest = process.env.VITEST;
  // Every process entry point is replaced above before exercising production IO.
  delete process.env.VITEST;
  effects.spawn.mockReset();
  effects.exec.mockReset();
  now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  effects.spawn.mockImplementation(() => {
    const child = fakeChild();
    children.push(child);
    return child;
  });
});
afterEach(async () => {
  for (const child of children.splice(0)) child.emit('close', 1);
  await flush();
  expect(getActiveRemoteSshCount()).toBe(0);
  expect(getQueuedRemoteSshCount()).toBe(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (previousVitest === undefined) delete process.env.VITEST;
  else process.env.VITEST = previousVitest;
});
it.each(cases)('keeps %s credentials on stdin and releases a healthy child only on close', async (kind) => {
  const result = request(kind);
  await flush();
  const child = children[0];
  const command = effects.spawn.mock.calls[0][0] as string;
  const actualMarker = kind === 'provision' ? 'CODEMAN_REMOTE_BROKER_V1:' : 'CODEMAN_REMOTE_BROKER_LAUNCH_V1:';
  const value = kind === 'provision' ? { status: 'existing' } : { status: 'not-sent' };
  child.stdout.write(actualMarker + Buffer.from(JSON.stringify(value)).toString('base64') + '\n');
  expect(getActiveRemoteSshCount()).toBe(1);
  expect(command).not.toContain(secret);
  expect(command).not.toContain(Buffer.from(child.input()).toString('base64'));
  expect(JSON.parse(child.input())).toMatchObject(
    kind === 'provision' ? { material: { source: secret } } : { sessionId: id, inspect: true }
  );
  child.emit('close', 0);
  expect(await result).toEqual(value);
  await flush();
  expect(getActiveRemoteSshCount()).toBe(0);
  expect(child.kill).not.toHaveBeenCalled();
});
it.each(
  cases.flatMap((kind) =>
    ['timeout', 'stdin-error', 'stdout-error', 'stderr-error', 'stdout-overflow', 'stderr-overflow', 'kill-throws'].map(
      (failure) => ({ kind, failure })
    )
  )
)('retains the slot after $kind/$failure until actual close', async ({ kind, failure }) => {
  const result = request(kind);
  await flush();
  const child = children[0];
  if (failure === 'kill-throws')
    child.kill.mockImplementation(() => {
      throw new Error('Kill failed');
    });
  if (failure === 'timeout' || failure === 'kill-throws') {
    now += 15000;
    await vi.advanceTimersByTimeAsync(15000);
  } else if (failure === 'stdout-overflow') child.stdout.write(Buffer.alloc(170 * 1024));
  else if (failure === 'stderr-overflow') child.stderr.write(Buffer.alloc(17000));
  else child[failure.slice(0, -6) as 'stdin' | 'stdout' | 'stderr'].emit('error', new Error('Lost pipe'));
  expect(await result).toEqual({ status: 'unknown' });
  expect(child.kill).toHaveBeenCalledOnce();
  expect(getActiveRemoteSshCount()).toBe(1);
  child.emit('close', 1);
  await flush();
  expect(getActiveRemoteSshCount()).toBe(0);
});
it.each(cases)('expires queued %s without preparation or spawn behind failed unclosed children', async (kind) => {
  const first = Array.from({ length: getRemoteSshLimit() }, () => request(kind));
  await flush();
  for (const child of children) child.stdin.emit('error', new Error('Lost pipe'));
  await Promise.all(first);
  expect(getActiveRemoteSshCount()).toBe(getRemoteSshLimit());
  const auth = authority(),
    waiting = request(kind, auth);
  await flush();
  expect(getQueuedRemoteSshCount()).toBe(1);
  now += 15000;
  await vi.advanceTimersByTimeAsync(15000);
  expect(await waiting).toEqual({ status: 'not-sent' });
  expect(auth.prepare).not.toHaveBeenCalled();
  expect(effects.spawn).toHaveBeenCalledTimes(getRemoteSshLimit());
  expect(getQueuedRemoteSshCount()).toBe(0);
});
it.each(cases)('cancels queued %s without dispatch and never later revives it', async (kind) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slots = Array.from({ length: getRemoteSshLimit() }, () => runWithRemoteSshLimit(() => held));
  await flush();
  const auth = authority(),
    waiting = request(kind, auth);
  await flush();
  auth.isCurrent.mockReturnValue(false);
  await vi.advanceTimersByTimeAsync(50);
  expect(await waiting).toEqual({ status: 'not-sent' });
  release();
  await Promise.all(slots);
  await flush();
  expect(auth.prepare).not.toHaveBeenCalled();
  expect(effects.spawn).not.toHaveBeenCalled();
});
it('bounds standalone clock admission before any subprocess is created', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slots = Array.from({ length: getRemoteSshLimit() }, () => runWithRemoteSshLimit(() => held));
  await flush();
  const clock = sampleRemoteCodexClock(remote);
  await flush();
  now += 15000;
  await vi.advanceTimersByTimeAsync(15000);
  expect(await clock).toBeUndefined();
  release();
  await Promise.all(slots);
  await flush();
  expect(effects.exec).not.toHaveBeenCalled();
});
it.each(cases)('does not write a %s request when spawn returns after the original deadline', async (kind) => {
  effects.spawn.mockImplementationOnce(() => {
    const child = fakeChild();
    children.push(child);
    now += 15001;
    return child;
  });
  expect(await request(kind)).toEqual({ status: 'unknown' });
  expect(children[0].input()).toBe('');
  expect(getActiveRemoteSshCount()).toBe(1);
});
it.each(cases)('rejects malformed UTF-8 on a successful %s child close', async (kind) => {
  const result = request(kind);
  await flush();
  const marker = kind === 'provision' ? 'CODEMAN_REMOTE_BROKER_V1:' : 'CODEMAN_REMOTE_BROKER_LAUNCH_V1:';
  const value = kind === 'provision' ? { status: 'existing' } : { status: 'not-sent' };
  children[0].stdout.write(marker + Buffer.from(JSON.stringify(value)).toString('base64') + '\n');
  children[0].stdout.write(Buffer.from([0xc3]));
  children[0].emit('close', 0);
  expect(await result).toEqual({ status: 'unknown' });
  expect(children[0].kill).not.toHaveBeenCalled();
});
it.each(cases)('rechecks the original %s deadline after authority preparation', async (kind) => {
  const auth = authority();
  auth.prepare.mockImplementation(async () => {
    now += 15001;
    return true;
  });
  expect(await request(kind, auth)).toEqual({ status: 'not-sent' });
  expect(effects.spawn).not.toHaveBeenCalled();
});
it.each(cases)('retains a %s child when writing stdin throws synchronously', async (kind) => {
  effects.spawn.mockImplementationOnce(() => {
    const child = fakeChild();
    children.push(child);
    vi.spyOn(child.stdin, 'end').mockImplementation(() => {
      throw new Error('Synchronous pipe failure');
    });
    return child;
  });
  expect(await request(kind)).toEqual({ status: 'unknown' });
  expect(getActiveRemoteSshCount()).toBe(1);
});
it.each(cases)('includes partial %s spawn time in the original transport budget', async (kind) => {
  effects.spawn.mockImplementationOnce(() => {
    const child = fakeChild();
    children.push(child);
    now += 5000;
    return child;
  });
  let settled = false;
  const result = request(kind).then((value) => {
    settled = true;
    return value;
  });
  await flush();
  now += 9999;
  await vi.advanceTimersByTimeAsync(9999);
  expect(settled).toBe(false);
  now += 1;
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toEqual({ status: 'unknown' });
  expect(children[0].kill).toHaveBeenCalledOnce();
  expect(getActiveRemoteSshCount()).toBe(1);
});
