/** Wake ownership is not permission to flush ACKed input into an unverified remote target. */
import { expect, it, vi } from 'vitest';
import { RemoteWakeRegistry } from '../src/remote-wake.js';

function fixture() {
  let release!: () => void;
  const ready = new Promise<boolean>((resolve) => {
    release = () => resolve(true);
  });
  const logical = {
    configuration: 'home-model-cwd',
    conversationId: 'known' as string | undefined,
    incarnation: 'old' as string | undefined,
  };
  const session = {
    id: 'wake-buffer-fixture',
    owner: 'original-owner',
    paneStartedAt: 1,
    remoteWakeScope: vi.fn(() => 'owner-config-incarnation'),
    remoteWakeInputScope: () => ({ ...logical }),
    remote: {
      hostId: 'fake',
      label: 'Fake',
      host: 'worker.invalid',
      remotePath: '/fixture/work',
      jumpHost: undefined as string | undefined,
      wakeCommand: 'fake-wake',
    },
    reattachRemote: vi.fn(async () => {
      session.paneStartedAt++;
      return true;
    }),
    confirmRemoteWakeReady: vi.fn(async () => true),
    isRemoteWakeReadyCurrent: vi.fn(() => true),
    writeViaMux: vi.fn(async (_data: string) => true),
  };
  const note = vi.fn(),
    events: string[] = [];
  const delay = vi.fn(async (_ms: number) => {});
  const registry = new RemoteWakeRegistry({
    probe: async () => false,
    wake: async () => true,
    waitUntilReady: () => ready,
    delay,
    noteReconnected: note,
    broadcast: (event) => {
      events.push(event);
    },
  });
  return { session, registry, release, note, events, delay, logical };
}

it.each(['missing', 'unknown', 'throwing'] as const)(
  'retains all ACKed input on %s target evidence after TCP wakes',
  async (kind) => {
    const f = fixture();
    if (kind === 'throwing') f.session.confirmRemoteWakeReady.mockRejectedValue(new Error('Unknown remote proof'));
    else f.session.confirmRemoteWakeReady.mockResolvedValue(false);
    expect(await f.registry.handleInput(f.session, 'first')).toBe('buffered');
    expect(await f.registry.handleInput(f.session, 'second\r')).toBe('buffered');
    f.release();
    expect(await f.registry.wake(f.session)).toBe(false);
    expect(f.registry.pendingBytes(f.session.id)).toBe(12);
    expect(f.session.writeViaMux).not.toHaveBeenCalled();
    expect(f.note).not.toHaveBeenCalled();
    expect(f.events).not.toContain('remote:sessionReconnected');
    // A cached successful TCP probe must not override the failed attachment proof.
    expect(await f.registry.ensureAwake(f.session)).toBe(false);
    expect(await f.registry.handleInput(f.session, 'third')).toBe('buffered');
    await f.registry.wake(f.session);
    expect(f.registry.pendingBytes(f.session.id)).toBe(17);
    expect(f.session.writeViaMux).not.toHaveBeenCalled();
  }
);

it('flushes the retained FIFO once a healthy explicit restore makes the target verifiable', async () => {
  const f = fixture();
  f.session.confirmRemoteWakeReady.mockResolvedValue(false);
  await f.registry.handleInput(f.session, 'first');
  await f.registry.handleInput(f.session, 'second\r');
  f.release();
  expect(await f.registry.wake(f.session)).toBe(false);
  f.session.confirmRemoteWakeReady.mockResolvedValue(true);
  expect(await f.registry.ensureAwake(f.session)).toBe(true);
  expect(f.session.writeViaMux.mock.calls.map(([data]) => data)).toEqual(['first', 'second\r']);
  expect(f.registry.pendingBytes(f.session.id)).toBe(0);
  expect(f.note).toHaveBeenCalledTimes(1);
});

it.each(['epoch', 'remote', 'stopped', 'proof', 'owner-config-incarnation'] as const)(
  'vetoes %s changes during attachment settle before any buffered write',
  async (kind) => {
    const f = fixture();
    f.delay.mockImplementation(async () => {
      if (kind === 'epoch') f.session.paneStartedAt++;
      if (kind === 'remote') f.session.remote.host = 'replacement.invalid';
      if (kind === 'stopped') f.registry.stop();
      if (kind === 'owner-config-incarnation') f.session.remoteWakeScope.mockReturnValue('replacement');
      if (kind === 'proof') f.session.isRemoteWakeReadyCurrent.mockReturnValue(false);
    });
    await f.registry.handleInput(f.session, 'retained');
    f.release();
    expect(await f.registry.wake(f.session)).toBe(false);
    expect(f.registry.pendingBytes(f.session.id)).toBe(8);
    expect(f.session.writeViaMux).not.toHaveBeenCalled();
    expect(f.note).not.toHaveBeenCalled();
  }
);

it('retains a known unsent preflight refusal and subsequent FIFO rather than sealing it', async () => {
  const f = fixture();
  f.session.writeViaMux.mockResolvedValueOnce(false);
  await f.registry.handleInput(f.session, 'first');
  await f.registry.handleInput(f.session, 'second');
  f.release();
  expect(await f.registry.wake(f.session)).toBe(false);
  expect(f.registry.pendingBytes(f.session.id)).toBe(11);
  expect(f.note).not.toHaveBeenCalled();
  expect(await f.registry.ensureAwake(f.session)).toBe(true);
  expect(f.session.writeViaMux.mock.calls.map(([data]) => data)).toEqual(['first', 'first', 'second']);
});

it('seals an uncertain attempted chunk and the trailing queue against later replay', async () => {
  const f = fixture();
  f.session.writeViaMux.mockRejectedValueOnce(new Error('Mux input delivery could not be confirmed'));
  await f.registry.handleInput(f.session, 'possibly-sent');
  await f.registry.handleInput(f.session, 'trailing');
  f.release();
  expect(await f.registry.wake(f.session)).toBe(false);
  expect(f.registry.pendingBytes(f.session.id)).toBe(0);
  expect(await f.registry.ensureAwake(f.session)).toBe(true);
  expect(f.session.writeViaMux.mock.calls.map(([data]) => data)).toEqual(['possibly-sent']);
});

it('retains unattempted chunks when the final scope changes during an earlier acknowledged write', async () => {
  const f = fixture();
  f.session.writeViaMux.mockImplementationOnce(async () => {
    f.session.confirmRemoteWakeReady.mockResolvedValue(false);
    return true;
  });
  await f.registry.handleInput(f.session, 'sent');
  await f.registry.handleInput(f.session, 'retained');
  f.release();
  expect(await f.registry.wake(f.session)).toBe(false);
  expect(f.session.writeViaMux.mock.calls.map(([data]) => data)).toEqual(['sent']);
  expect(f.registry.pendingBytes(f.session.id)).toBe(8);
  expect(f.note).not.toHaveBeenCalled();
});

it('does not adopt a replacement owner or broker scope when refreshing after an acknowledged chunk', async () => {
  const f = fixture();
  f.session.writeViaMux.mockImplementationOnce(async () => {
    f.session.remoteWakeScope.mockReturnValue('replacement-owner-or-incarnation');
    return true;
  });
  await f.registry.handleInput(f.session, 'sent');
  await f.registry.handleInput(f.session, 'retained');
  f.release();
  expect(await f.registry.wake(f.session)).toBe(false);
  expect(f.session.writeViaMux.mock.calls.map(([data]) => data)).toEqual(['sent']);
  expect(f.registry.pendingBytes(f.session.id)).toBe(8);
});

it.each(['owner', 'remote', 'path', 'proxy'] as const)(
  'keeps queued input bound to its original %s across failed wakes',
  async (kind) => {
    const f = fixture();
    f.session.confirmRemoteWakeReady.mockResolvedValue(false);
    await f.registry.handleInput(f.session, 'original');
    f.release();
    expect(await f.registry.wake(f.session)).toBe(false);
    if (kind === 'owner') f.session.owner = 'replacement-owner';
    else if (kind === 'remote') f.session.remote.host = 'replacement.invalid';
    else if (kind === 'path') f.session.remote.remotePath = '/replacement';
    else f.session.remote.jumpHost = 'replacement.invalid';
    f.session.confirmRemoteWakeReady.mockResolvedValue(true);
    expect(await f.registry.handleInput(f.session, 'foreign')).toBe('dropped');
    expect(await f.registry.ensureAwake(f.session)).toBe(false);
    expect(f.registry.pendingBytes(f.session.id)).toBe(8);
    expect(f.session.writeViaMux).not.toHaveBeenCalled();
    if (kind === 'owner') f.session.owner = 'original-owner';
    else if (kind === 'remote') f.session.remote.host = 'worker.invalid';
    else if (kind === 'path') f.session.remote.remotePath = '/fixture/work';
    else f.session.remote.jumpHost = undefined;
    expect(await f.registry.ensureAwake(f.session)).toBe(true);
    expect(f.session.writeViaMux.mock.calls.map(([data]) => data)).toEqual(['original']);
  }
);

it('reserves an unsent chunk capacity while dispatch is pending and refuses new overflow', async () => {
  const f = fixture();
  const original = 'a'.repeat(4096);
  f.session.writeViaMux.mockImplementationOnce(async () => {
    expect(await f.registry.handleInput(f.session, 'b'.repeat(4096))).toBe('dropped');
    return false;
  });
  await f.registry.handleInput(f.session, original);
  f.release();
  expect(await f.registry.wake(f.session)).toBe(false);
  expect(f.registry.pendingBytes(f.session.id)).toBe(4096);
  expect(await f.registry.ensureAwake(f.session)).toBe(true);
  expect(f.session.writeViaMux.mock.calls.map(([data]) => data)).toEqual([original, original]);
  expect(f.registry.pendingBytes(f.session.id)).toBe(0);
});

it('does not let an older TCP probe overtake a concurrently waking attachment proof', async () => {
  const f = fixture();
  let releaseProbe!: (ready: boolean) => void;
  const probe = new Promise<boolean>((resolve) => {
    releaseProbe = resolve;
  });
  Reflect.set(f.registry, 'deps', {
    probe: () => probe,
    wake: async () => true,
    waitUntilReady: async () => true,
    delay: async () => {},
  });
  let releaseProof!: (ready: boolean) => void;
  f.session.confirmRemoteWakeReady.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        releaseProof = resolve;
      })
  );
  const input = f.registry.handleInput(f.session, 'retained');
  await new Promise<void>((resolve) => setImmediate(resolve));
  const wake = f.registry.wake(f.session);
  await vi.waitFor(() => expect(f.session.confirmRemoteWakeReady).toHaveBeenCalled());
  releaseProbe(true);
  expect(await input).toBe('buffered');
  expect(f.session.writeViaMux).not.toHaveBeenCalled();
  releaseProof(false);
  expect(await wake).toBe(false);
  expect(f.registry.pendingBytes(f.session.id)).toBe(8);
});

it('preserves an accepted FIFO when wake configuration disappears while TCP readiness is pending', async () => {
  const f = fixture();
  await f.registry.handleInput(f.session, 'first');
  f.session.remote.wakeCommand = '';
  expect(await f.registry.handleInput(f.session, 'second')).toBe('buffered');
  expect(f.registry.pendingBytes(f.session.id)).toBe(11);
  f.release();
  expect(await f.registry.wake(f.session)).toBe(false);
  expect(f.session.writeViaMux).not.toHaveBeenCalled();
});

it('send-and-wait joins a held attachment proof even when its target configuration is removed', async () => {
  const f = fixture();
  let releaseProof!: (ready: boolean) => void;
  f.session.confirmRemoteWakeReady.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        releaseProof = resolve;
      })
  );
  f.release();
  const wake = f.registry.wake(f.session);
  await vi.waitFor(() => expect(f.session.confirmRemoteWakeReady).toHaveBeenCalled());
  f.session.remote.wakeCommand = '';
  let settled = false;
  const ensure = f.registry.ensureAwake(f.session).then((ready) => {
    settled = true;
    return ready;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  releaseProof(true);
  expect(await wake).toBe(false);
  expect(await ensure).toBe(false);
});

it('refuses new overflow while an already accepted full paste waits for TCP readiness', async () => {
  const f = fixture();
  const paste = 'a'.repeat(4096);
  expect(await f.registry.handleInput(f.session, paste)).toBe('buffered');
  expect(await f.registry.handleInput(f.session, 'b')).toBe('dropped');
  expect(f.registry.pendingBytes(f.session.id)).toBe(4096);
  f.release();
  expect(await f.registry.wake(f.session)).toBe(true);
  expect(f.session.writeViaMux.mock.calls.map(([data]) => data)).toEqual([paste]);
});

it.each([
  'conversation',
  'configuration',
  'unknown-rotation',
  'unknown-no-inc',
  'same-conversation-restore',
  'same-worker-discovery',
] as const)('keeps the logical queued input target through %s', async (change) => {
  const f = fixture();
  if (change === 'unknown-rotation' || change === 'unknown-no-inc' || change === 'same-worker-discovery')
    f.logical.conversationId = undefined;
  if (change === 'unknown-no-inc') f.logical.incarnation = undefined;
  f.session.confirmRemoteWakeReady.mockResolvedValue(false);
  await f.registry.handleInput(f.session, 'original');
  f.release();
  expect(await f.registry.wake(f.session)).toBe(false);
  if (change === 'conversation' || change === 'same-worker-discovery') f.logical.conversationId = 'different-known';
  if (change === 'configuration') f.logical.configuration = 'different-home-or-model';
  if (change === 'unknown-rotation' || change === 'same-conversation-restore') f.logical.incarnation = 'new';
  f.session.confirmRemoteWakeReady.mockResolvedValue(true);
  const allowed = change === 'same-conversation-restore' || change === 'same-worker-discovery';
  expect(await f.registry.ensureAwake(f.session)).toBe(allowed);
  expect(f.session.writeViaMux.mock.calls.map(([data]) => data)).toEqual(allowed ? ['original'] : []);
  expect(f.registry.pendingBytes(f.session.id)).toBe(allowed ? 0 : 8);
});

it('send-and-wait cannot reuse an older successful TCP probe while another wake owns proof admission', async () => {
  const f = fixture();
  let releaseProbe!: (ready: boolean) => void;
  const probe = new Promise<boolean>((resolve) => {
    releaseProbe = resolve;
  });
  Reflect.set(f.registry, 'deps', {
    probe: () => probe,
    wake: async () => true,
    waitUntilReady: async () => true,
    delay: async () => {},
  });
  const ensure = f.registry.ensureAwake(f.session);
  await new Promise<void>((resolve) => setImmediate(resolve));
  let releaseProof!: (ready: boolean) => void;
  f.session.confirmRemoteWakeReady.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        releaseProof = resolve;
      })
  );
  const wake = f.registry.wake(f.session);
  await vi.waitFor(() => expect(f.session.confirmRemoteWakeReady).toHaveBeenCalled());
  let settled = false;
  void ensure.then(() => {
    settled = true;
  });
  releaseProbe(true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  releaseProof(false);
  expect(await wake).toBe(false);
  expect(await ensure).toBe(false);
});

it('send-and-wait refuses an accepted FIFO after a failed TCP wake and removal of its wake target', async () => {
  const f = fixture();
  Reflect.set(f.registry, 'deps', {
    probe: async () => false,
    wake: async () => true,
    waitUntilReady: async () => false,
    delay: async () => {},
  });
  await f.registry.handleInput(f.session, 'retained');
  expect(await f.registry.wake(f.session)).toBe(false);
  f.session.remote.wakeCommand = '';
  expect(await f.registry.ensureAwake(f.session)).toBe(false);
  expect(f.registry.pendingBytes(f.session.id)).toBe(8);
  expect(f.session.writeViaMux).not.toHaveBeenCalled();
});
