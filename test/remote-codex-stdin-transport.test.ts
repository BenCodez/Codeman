/** Default pipe transport with every process constructor replaced by a strict fake. */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const effects = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const refused = () => {
    throw Error('Unmocked process execution forbidden');
  };
  return {
    ...actual,
    spawn: effects.spawn,
    exec: refused,
    execFile: refused,
    execSync: refused,
    execFileSync: refused,
    spawnSync: refused,
    fork: refused,
  };
});
vi.mock('../src/recovery/remote-clock.js', async (original) => ({
  ...(await original<typeof import('../src/recovery/remote-clock.js')>()),
  sampleRemoteCodexClock: vi.fn(async () => clock()),
}));
import { deliverRemoteCodexInput, inspectRemoteCodex, runRemoteCodexStdin } from '../src/recovery/remote-codex.js';
import { getActiveRemoteSshCount, getQueuedRemoteSshCount, getRemoteSshLimit } from '../src/remote-ssh-limiter.js';
import type { SessionRemote } from '../src/types.js';
import { performance } from 'node:perf_hooks';
import { sampleRemoteCodexClock } from '../src/recovery/remote-clock.js';

const remote: SessionRemote = {
  hostId: 'fixture',
  label: 'Fixture',
  host: 'worker.invalid',
  username: 'fixture',
  remotePath: '/private/work',
  owned: true,
};
const clock = () => {
  // This fake models a single point in both domains. Separate wall reads can
  // invent an offset/negative uncertainty when one crosses a millisecond tick.
  const at = Date.now();
  return { localBefore: at, localAfter: at, remoteBefore: at, remoteAfter: at };
};
const prompt = 'Private fixture request café 🧭';
function request() {
  const submitted = clock();
  return {
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    workingDir: remote.remotePath,
    codexHome: '/private/home',
    submission: { at: submitted.remoteAfter, hash: 'a'.repeat(64), clockDomain: 'remote' as const, clock: submitted },
    expected: {
      conversationId: '11111111-2222-3333-4444-555555555555',
      tailHash: 'b'.repeat(64),
      paneId: '%7',
      panePid: 700,
      screenHash: 'c'.repeat(64),
    },
    prompt,
  };
}
beforeEach(() => effects.spawn.mockReset());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function fixtureIo<T>(work: () => Promise<T>): Promise<T> {
  // Only the strict fake above can receive this fixture command; no real process API exists.
  const previous = process.env.VITEST;
  delete process.env.VITEST;
  try {
    return await work();
  } finally {
    if (previous === undefined) delete process.env.VITEST;
    else process.env.VITEST = previous;
  }
}
function child(onInput: (child: ReturnType<typeof fakeChild>) => void) {
  const value = fakeChild();
  value.stdin.on('finish', () => queueMicrotask(() => onInput(value)));
  effects.spawn.mockReturnValue(value);
  return value;
}
function fakeChild() {
  const emitter = new EventEmitter();
  const stdin = new PassThrough(),
    stdout = new PassThrough(),
    stderr = new PassThrough();
  const chunks: Buffer[] = [];
  stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  const kill = vi.fn(() => {
    emitter.emit('close', 1);
    return true;
  });
  return Object.assign(emitter, { stdin, stdout, stderr, kill, input: () => Buffer.concat(chunks).toString('utf8') });
}
it.each(['steady', 'millisecond-boundary'] as const)(
  'passes the complete private request only to stdin for inspection: %s',
  async (timing) => {
    if (timing === 'millisecond-boundary') {
      let reads = 0;
      const at = Date.now();
      vi.spyOn(Date, 'now').mockImplementation(() => at + (++reads <= 3 ? 0 : reads <= 5 ? 1 : 2));
      vi.spyOn(performance, 'now').mockReturnValue(0);
    }
    const f = child((f) => {
      const now = Date.now();
      f.stdout.write(
        'CODEMAN_REMOTE_CODEX_V1:' +
          Buffer.from(
            JSON.stringify({
              v: 1,
              session: 'missing',
              identity: { reason: 'unverified' },
              clock: { remoteBefore: now, remoteAfter: now },
            })
          ).toString('base64') +
          '\n'
      );
      f.emit('close', 0);
    });
    expect(await fixtureIo(() => inspectRemoteCodex(remote, request()))).toMatchObject({
      transport: 'reachable',
      session: 'missing',
    });
    const [command, options] = effects.spawn.mock.calls[0];
    expect(options).toEqual({ shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
    expect(command).not.toContain(prompt);
    expect(command).not.toContain(Buffer.from(f.input()).toString('base64'));
    expect(command).not.toContain('/private/home');
    expect(JSON.parse(f.input())).toMatchObject({ sessionId: request().sessionId, codexHome: '/private/home' });
  }
);
it('keeps contradictory injected clock evidence unknown before spawning the transport', async () => {
  const at = Date.now();
  const q = request();
  q.submission = {
    ...q.submission,
    at,
    clock: { localBefore: at, localAfter: at, remoteBefore: at, remoteAfter: at },
  };
  vi.mocked(sampleRemoteCodexClock).mockResolvedValueOnce({
    localBefore: at + 10,
    localAfter: at + 10,
    remoteBefore: at + 11,
    remoteAfter: at + 11,
  });
  expect(await fixtureIo(() => inspectRemoteCodex(remote, q))).toEqual({
    transport: 'reachable',
    session: 'unknown',
    identity: { reason: 'unreadable' },
  });
  expect(effects.spawn).not.toHaveBeenCalled();
});
it.each(['stdin-error', 'stdout-error', 'stderr-error', 'stdout-overflow', 'stderr-overflow'] as const)(
  'seals a dispatched request after %s',
  async (fault) => {
    const f = child((f) => {
      if (fault === 'stdin-error')
        f.stdin.emit('error', Object.assign(Error('Fake broken input pipe'), { code: 'EPIPE' }));
      else if (fault === 'stdout-error' || fault === 'stderr-error')
        (fault === 'stdout-error' ? f.stdout : f.stderr).emit('error', Error('Fake output pipe failure'));
      else (fault === 'stdout-overflow' ? f.stdout : f.stderr).emit('data', Buffer.alloc(768 * 1024 + 1));
    });
    expect(await fixtureIo(() => deliverRemoteCodexInput(remote, request()))).toEqual({ status: 'unknown' });
    expect(effects.spawn).toHaveBeenCalledOnce();
    expect(JSON.parse(f.input()).action.prompt).toBe(prompt);
    expect(f.kill).toHaveBeenCalledOnce();
  }
);
it('keeps a cancelled authority and an oversized payload before every process effect', async () => {
  expect(await fixtureIo(() => deliverRemoteCodexInput(remote, request(), () => false))).toEqual({
    status: 'not-sent',
  });
  expect(await fixtureIo(() => deliverRemoteCodexInput(remote, { ...request(), prompt: '\t'.repeat(65536) }))).toEqual({
    status: 'not-sent',
  });
  expect(effects.spawn).not.toHaveBeenCalled();
});
it('bounds a stalled stdin transport and retains an unknown post-dispatch result', async () => {
  vi.useFakeTimers();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = fakeChild();
  effects.spawn.mockImplementation(() => {
    entered();
    return f;
  });
  const sending = fixtureIo(() => deliverRemoteCodexInput(remote, request()));
  await started;
  await vi.advanceTimersByTimeAsync(15000);
  expect(await sending).toEqual({ status: 'unknown' });
  expect(f.kill).toHaveBeenCalledOnce();
});

it('retains complete Unicode stdout when transport chunks split a multibyte character', async () => {
  const expected = 'SSH banner café 🧭\n';
  const bytes = Buffer.from(expected);
  child((f) => {
    for (const byte of bytes) f.stdout.emit('data', Buffer.from([byte]));
    f.emit('close', 0);
  });
  expect(await fixtureIo(() => runRemoteCodexStdin('STRICT_FAKE_COMMAND', '{}'))).toEqual({ stdout: expected });
});

it('retains the global SSH slots after request failure until each child actually closes', async () => {
  const cap = getRemoteSshLimit();
  const retained = Array.from({ length: cap }, () => fakeChild());
  for (const f of retained) {
    f.kill.mockImplementation(() => {
      throw Error('Fake kill failure');
    });
    f.stdin.on('finish', () => queueMicrotask(() => f.stdin.emit('error', Error('Fake failed pipe'))));
  }
  const released = fakeChild();
  released.stdin.on('finish', () => queueMicrotask(() => released.emit('close', 0)));
  for (const f of [...retained, released]) effects.spawn.mockReturnValueOnce(f);
  try {
    const results = await fixtureIo(() => Promise.all(retained.map(() => deliverRemoteCodexInput(remote, request()))));
    expect(results).toEqual(retained.map(() => ({ status: 'unknown' })));
    expect(getActiveRemoteSshCount()).toBe(cap);
    expect(effects.spawn).toHaveBeenCalledTimes(cap);
    const queued = fixtureIo(() => deliverRemoteCodexInput(remote, request()));
    expect(getQueuedRemoteSshCount()).toBe(1);
    await Promise.resolve();
    expect(effects.spawn).toHaveBeenCalledTimes(cap);
    retained[0].emit('close', 1);
    expect(await queued).toEqual({ status: 'unknown' });
    expect(effects.spawn).toHaveBeenCalledTimes(cap + 1);
    expect(getActiveRemoteSshCount()).toBe(cap - 1);
  } finally {
    for (const f of retained) f.emit('close', 1);
    released.emit('close', 0);
    const deadline = performance.now() + 2000;
    while (getActiveRemoteSshCount() !== 0 && performance.now() < deadline)
      await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(getActiveRemoteSshCount()).toBe(0);
  expect(getQueuedRemoteSshCount()).toBe(0);
});

it.each(['inspection', 'mutation'] as const)(
  'expires a queued %s without clock/process work or dispatch after a retained child later closes',
  async (kind) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let monotonic = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
    const cap = getRemoteSshLimit();
    const retained = Array.from({ length: cap }, () => fakeChild());
    for (const f of retained) {
      f.kill.mockImplementation(() => false);
      f.stdin.on('finish', () => queueMicrotask(() => f.stdin.emit('error', Error('Held failed input pipe'))));
      effects.spawn.mockReturnValueOnce(f);
    }
    effects.spawn.mockImplementation(() => {
      throw Error('Unexpected stale transport dispatch');
    });
    let waiting: Promise<unknown> | undefined;
    try {
      await fixtureIo(async () => {
        expect(await Promise.all(retained.map(() => deliverRemoteCodexInput(remote, request())))).toEqual(
          retained.map(() => ({ status: 'unknown' }))
        );
        expect(getActiveRemoteSshCount()).toBe(cap);
        const clock = vi.fn(async () => ({
          localBefore: Date.now(),
          localAfter: Date.now(),
          remoteBefore: Date.now(),
          remoteAfter: Date.now(),
        }));
        const run = vi.fn(async () => ({ stdout: '' }));
        const options = { transport: { clock, run } };
        let settled = false;
        waiting =
          kind === 'inspection'
            ? inspectRemoteCodex(remote, request(), options)
            : deliverRemoteCodexInput(remote, request(), undefined, options);
        void waiting.then(() => {
          settled = true;
        });
        expect(getQueuedRemoteSshCount()).toBe(1);
        monotonic = 15_000;
        await vi.advanceTimersByTimeAsync(15_000);
        expect(settled).toBe(true);
        expect(await waiting).toEqual(
          kind === 'inspection'
            ? { transport: 'reachable', session: 'unknown', identity: { reason: 'unreadable' } }
            : { status: 'not-sent' }
        );
        expect(clock).not.toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();
        expect(effects.spawn).toHaveBeenCalledTimes(cap);
        expect(getQueuedRemoteSshCount()).toBe(0);
        expect(getActiveRemoteSshCount()).toBe(cap);

        retained[0].emit('close', 1);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(clock).not.toHaveBeenCalled();
        expect(effects.spawn).toHaveBeenCalledTimes(cap);
        // A later independent call can use the released slot, not the expired waiter.
        const fresh = child((f) => {
          const now = Date.now();
          f.stdout.write(
            'CODEMAN_REMOTE_CODEX_V1:' +
              Buffer.from(
                JSON.stringify({
                  v: 1,
                  session: 'missing',
                  identity: { reason: 'unverified' },
                  clock: { remoteBefore: now, remoteAfter: now },
                })
              ).toString('base64') +
              '\n'
          );
          f.emit('close', 0);
        });
        expect(await inspectRemoteCodex(remote, request())).toMatchObject({
          transport: 'reachable',
          session: 'missing',
        });
        expect(effects.spawn).toHaveBeenCalledTimes(cap + 1);
        expect(JSON.parse(fresh.input())).toHaveProperty('sessionId', request().sessionId);
      });
    } finally {
      for (const f of retained) f.emit('close', 1);
      await waiting;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(getActiveRemoteSshCount()).toBe(0);
    expect(getQueuedRemoteSshCount()).toBe(0);
  }
);

it('keeps first-grant initialization before its one action-deadline read', async () => {
  let prepared = false;
  const getActionDeadline = vi.fn(() => {
    expect(prepared).toBe(true);
    return Date.now() + 1000;
  });
  const f = child((f) => f.emit('close', 0));
  expect(
    await fixtureIo(() =>
      deliverRemoteCodexInput(remote, request(), {
        check: async () => {
          prepared = true;
          return true;
        },
        isCurrent: () => prepared,
        getActionDeadline,
      })
    )
  ).toEqual({ status: 'unknown' });
  expect(getActionDeadline).toHaveBeenCalledOnce();
  expect(JSON.parse(f.input()).action.prompt).toBe(prompt);
});
