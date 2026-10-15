import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { remoteSourceIssuer } from './helpers/remote-source-issuer.js';
import { deliverRemoteCodexInput } from '../src/recovery/remote-codex.js';
import { remoteBrokerReaderFixture } from './mocks/remote-broker-reader-fixture.js';

const fixtures: Awaited<ReturnType<typeof remoteBrokerReaderFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture() {
  const f = await remoteBrokerReaderFixture();
  fixtures.push(f);
  return f;
}

it('probes the actual child and delivers literal text plus actual child Enter once', async () => {
  const f = await fixture();
  const result = await f.input('healthy 😀\nsecond line');
  expect(result.result).toMatchObject({ status: 'sent' });
  expect(result.failed).toBe(false);
  expect((await f.bytes()).toString()).toBe('healthy 😀\nsecond line\r');
  expect(result.result && 'submittedAt' in result.result ? result.result.submittedAt : 0).toBeGreaterThan(0);
});

it('retains the exact 64 KiB Unicode prompt and ordered broker phases', async () => {
  const f = await fixture(),
    prompt = '😀'.repeat(16384);
  const result = await f.input(prompt);
  expect(
    result.result,
    ('error' in result ? String(result.error).slice(-1500) : '') + ' bytes=' + (await f.bytes()).length
  ).toMatchObject({ status: 'sent' });
  expect(await f.bytes()).toEqual(Buffer.from(prompt + '\r'));
});

it('waits for delayed healthy repaint without resending a literal phase', async () => {
  const f = await fixture();
  await f.marker('delay', '0.15');
  const result = await f.input('slow paint');
  expect(result.result).toMatchObject({ status: 'sent' });
  expect((await f.bytes()).toString()).toBe('slow paint\r');
});

it.each(['draft', 'busy', 'approval'] as const)(
  '%s before literal input refuses with zero child bytes',
  async (veto) => {
    const f = await fixture();
    await f.marker(veto);
    const result = await f.input('must not arrive');
    expect(result.result).toEqual({ status: 'not-sent' });
    expect(await f.bytes()).toEqual(Buffer.alloc(0));
  }
);

it.each(['draft-after', 'no-repaint', 'tail-after'] as const)(
  '%s after a literal phase seals partial delivery without Enter or replay',
  async (veto) => {
    const f = await fixture();
    await f.marker(veto);
    const result = await f.input('landed text');
    expect(result.result?.status).not.toBe('sent');
    expect((await f.bytes()).toString()).toBe('landed text');
  }
);

it('unretained broker material cannot authorize the otherwise exact history and empty composer', async () => {
  const f = await fixture();
  const result = await f.input('must not arrive', (q) => {
    delete q.inputBroker;
  });
  expect(result.result).toEqual({ status: 'not-sent' });
  expect(await f.bytes()).toEqual(Buffer.alloc(0));
});

it('an intervening authenticated owner frame invalidates an earlier exact proof', async () => {
  const f = await fixture();
  const result = await f.input('must not arrive', (q) => {
    q.expected.inputProof!.ownerCounters['owner-pty']++;
  });
  expect(result.result).toEqual({ status: 'not-sent' });
  expect(await f.bytes()).toEqual(Buffer.alloc(0));
});

it.each(['restart', 'restore'] as const)('rotates a certified prior worker to a fresh broker on %s', async (kind) => {
  const f = await fixture();
  const result = await f.rotate(kind);
  expect(result.result, JSON.stringify(result.wireCalls)).toBe('sent');
  expect(result.pending).toBeDefined();
  expect(result.promoted).toBe(result.pending);
  expect(result.promoted).not.toBe(f.descriptor.incarnation);
});

it.each(['restart', 'restore'] as const)(
  'keeps %s reserved after a lost final reply without replay or promotion',
  async (kind) => {
    const f = await fixture(),
      run = f.options.transport.run;
    f.options.transport.run = async (command) => {
      await run(command);
      return { stdout: '' };
    };
    const result = await f.rotate(kind);
    expect(result.result).toBe('unknown');
    expect(result.pending).toBeDefined();
    expect(result.promoted).toBeUndefined();
    expect(await f.bytes()).toEqual(Buffer.alloc(0));
  }
);

it('issuer authority lost while the final remote clock is held vetoes the reserved restart', async () => {
  const f = await fixture();
  let current = true,
    entered!: () => void,
    release!: () => void;
  const held = new Promise<void>((r) => {
      release = r;
    }),
    reached = new Promise<void>((r) => {
      entered = r;
    });
  const clock = f.options.transport.clock;
  f.options.transport.clock = async () => {
    entered();
    await held;
    return clock();
  };
  const work = f.rotate('restart', (authority) => {
    authority.isCurrent = () => current;
  });
  await reached;
  current = false;
  release();
  const result = await work;
  expect(result.result).toBe('not-sent');
  expect(result.pending).toBeDefined();
  expect(result.promoted).toBeUndefined();
  expect(await f.starts()).toBe(1);
});

it('old rollout progress during final clock preparation vetoes the new child', async () => {
  const f = await fixture(),
    clock = f.options.transport.clock;
  f.options.transport.clock = async () => {
    await fs.appendFile(f.rollout, ' ');
    return clock();
  };
  const result = await f.rotate('restart');
  expect(result.result).toBe('not-sent');
  expect(result.promoted).toBeUndefined();
  expect(await f.starts()).toBe(1);
});

it('a replacement at the atomic native restart predicate receives no new child', async () => {
  const f = await fixture();
  f.env.NATIVE_BEFORE_EFFECT = 'pid';
  const result = await f.rotate('restart');
  expect(result.result).toBe('not-sent');
  expect(result.pending).toBeDefined();
  expect(result.promoted).toBeUndefined();
  expect(await f.starts()).toBe(1);
});

it('worker progress after native dispatch is rechecked by the new broker before any child fork', async () => {
  const f = await fixture();
  await f.marker('tail-before-child');
  const result = await f.rotate('restart');
  expect(result.result).toBe('unknown');
  expect(result.pending).toBeDefined();
  expect(result.promoted).toBeUndefined();
  expect(await f.starts()).toBe(1);
});

it('pins the final private configuration before any child command executes', async () => {
  const f = await fixture();
  await f.marker('config-before-child');
  const result = await f.rotate('restart');
  expect(result.result).toBe('unknown');
  let started = false;
  const deadline = performance.now() + 500;
  while (performance.now() < deadline) {
    started = await fs.access(f.root + '/wrong-start').then(
      () => true,
      () => false
    );
    if (started) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(started).toBe(false);
  expect(result.promoted).toBeUndefined();
});

// The native command has accepted a signed frame, but Python has not consumed it.
// Its fixed packet expiry must include the original action budget.
it.each([
  { label: 'within', delay: '0.05', budget: 1500, sent: true },
  { label: 'after', delay: '0.65', budget: 600, sent: false },
])('queued Enter $label the action deadline preserves child-boundary authority', async ({ delay, budget, sent }) => {
  const f = await fixture();
  await f.marker('enter-delay', delay);
  const result = await f.input('deadline text', (q) => {
    q.actionDeadline = Date.now() + budget;
  });
  if (sent) expect(result.result).toMatchObject({ status: 'sent' });
  else {
    expect(result.failed).toBe(true);
    expect(result.result).toBeUndefined();
  }
  await new Promise((r) => setTimeout(r, 150));
  // Polling cannot turn the delayed control frame into an extra literal send.
  expect((await f.bytes()).toString()).toBe('deadline text' + (sent ? '\r' : ''));
});

it.each(['healthy', 'manager-journal', 'worker-progress', 'owner-input', 'native-replaced', 'expired-enter'] as const)(
  'couples the real source-host issuer lease to generated child input: %s',
  async (change) => {
    const f = await fixture(),
      manager = await remoteSourceIssuer(f.root);
    try {
      const prompt = 'leased worker input',
        q = await f.inputRequest(prompt);
      if (change === 'expired-enter') await f.marker('enter-delay', '0.65');
      if (change === 'manager-journal') await fs.appendFile(manager.broker.directory + '/state.json', ' ');
      if (change === 'native-replaced') f.env.NATIVE_BEFORE_EFFECT = 'pid';
      let wireCalls = 0;
      const run = f.options.transport.run;
      const options = {
        ...f.options,
        issuerLeaseTransport: manager.transport,
        transport: {
          ...f.options.transport,
          run: async (command: string) => {
            wireCalls++;
            expect(command).not.toContain(manager.broker.directory);
            if (change === 'worker-progress') await fs.appendFile(f.rollout, ' ');
            if (change === 'owner-input') {
              f.worker.stdin.write('owner raw draft');
              await new Promise((r) => setTimeout(r, 20));
            }
            return run(command);
          },
        },
      };
      const result = await deliverRemoteCodexInput(
        f.remote,
        q,
        {
          check: async () => true,
          isCurrent: () => true,
          getInputIssuer: () => manager.issuer,
          ...(change === 'expired-enter' ? { getActionDeadline: () => Date.now() + 600 } : {}),
        },
        options
      );
      await new Promise((r) => setTimeout(r, 150));
      if (change === 'healthy') {
        expect(result).toMatchObject({ status: 'sent' });
        expect((await f.bytes()).toString()).toBe(prompt + '\r');
        expect(wireCalls).toBe(1);
      } else if (change === 'expired-enter') {
        expect(result).toEqual({ status: 'unknown' });
        expect((await f.bytes()).toString()).toBe(prompt);
        expect(wireCalls).toBe(1);
      } else {
        expect(result.status).not.toBe('sent');
        expect((await f.bytes()).toString()).toBe(change === 'owner-input' ? 'owner raw draft' : '');
        expect(wireCalls).toBe(change === 'manager-journal' ? 0 : 1);
      }
    } finally {
      await manager.close();
    }
  }
);

it.each(['restart', 'restore'] as const)(
  'holds actual source-host authority through fresh remote %s startup',
  async (kind) => {
    const f = await fixture(),
      manager = await remoteSourceIssuer(f.root);
    try {
      Object.assign(f.options, { issuerLeaseTransport: manager.transport });
      const result = await f.rotate(kind, (authority) => {
        Object.assign(authority, { getInputIssuer: () => manager.issuer });
      });
      expect(result.result, JSON.stringify(result.wireCalls)).toBe('sent');
      expect(result.pending).toBeDefined();
      expect(result.promoted).toBe(result.pending);
      // The receipt attests the fork; wait read-only for the child fixture's
      // first instruction before counting its launch under scheduler load.
      const readyBy = performance.now() + 2000;
      while ((await f.starts()) !== 2 && performance.now() < readyBy) await new Promise((r) => setTimeout(r, 5));
      expect(await f.starts()).toBe(2);
    } finally {
      await manager.close();
    }
  }
);

it.each(['owner-pty', 'owner-key', 'owner-mux', 'auto', 'probe'] as const)(
  'refuses a live journal missing the latest %s receipt before any input',
  async (channel) => {
    const f = await fixture(),
      file = f.broker.directory + '/state.json';
    const state = JSON.parse(await fs.readFile(file, 'utf8'));
    state.counters[channel] = 1;
    state.receipts = [];
    await fs.writeFile(file, JSON.stringify(state));
    const observed = await f.inspect();
    expect(observed.evidence?.inputBroker).toBeUndefined();
    expect(await f.bytes()).toEqual(Buffer.alloc(0));
    expect(await f.starts()).toBe(1);
  }
);

it.each(['owner-pty', 'owner-key', 'owner-mux', 'auto', 'probe'] as const)(
  'refuses closed-worker rotation missing the latest %s receipt',
  async (channel) => {
    const f = await fixture();
    await expect(
      f.rotate('restart', undefined, (state) => {
        state.counters[channel] = 1;
        state.receipts = [];
      })
    ).rejects.toThrow('Missing broker evidence');
    expect(await f.starts()).toBe(1);
    expect(await f.bytes()).toEqual(Buffer.alloc(0));
  }
);

it('accepts an exact closed journal whose older probe receipt was pruned by 128 later auto receipts', async () => {
  const f = await fixture();
  const result = await f.rotate('restart', undefined, (state) => {
    state.counters.probe = 1;
    state.counters.auto = 128;
    state.receipts = Array.from({ length: 128 }, (_, i) => ({
      channel: 'auto',
      counter: i + 1,
      nonce: randomUUID(),
      conversationId: '11111111-2222-3333-4444-555555555555',
      hash: createHash('sha256').update('prior input').digest('hex'),
      status: 'sent',
    }));
  });
  expect(result.result, JSON.stringify(result.wireCalls)).toBe('sent');
  expect(await f.starts()).toBe(2);
});
