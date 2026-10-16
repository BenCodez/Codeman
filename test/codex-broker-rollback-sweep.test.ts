/** @fileoverview Retained exact rollback proofs retry fairly with fake clocks and isolated janitors. */
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BrokerProvisioningRollback } from '../src/recovery/codex-broker-cleanup.js';

const MODULE = '../src/recovery/codex-broker-cleanup.js';
const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
let cleanup: typeof import('../src/recovery/codex-broker-cleanup.js');
let root: string;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  cleanup = await import('../src/recovery/codex-broker-cleanup.js');
  root = await fs.mkdtemp(join(homedir(), 'broker-rollback-sweep-'));
});
afterEach(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.doUnmock(MODULE);
  await fs.rm(root, { recursive: true, force: true });
});

function receipt(): BrokerProvisioningRollback {
  return {
    root: '/isolated-fake-transport-only',
    sessionId: SID,
    incarnation: randomUUID(),
    directory: { dev: 1, ino: 2 },
    parents: [{ path: '/isolated-fake-transport-only', dev: 1, ino: 3 }],
    files: [],
  };
}

function janitor(complete = true, hold = false) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      queueMicrotask(() => child.emit('close', 137));
      return true;
    }),
  });
  let current: BrokerProvisioningRollback;
  child.stdin.on('data', (raw) => {
    if (hold) return;
    if (String(raw).trim() === 'ACK') {
      if (complete)
        child.stdout.write(JSON.stringify({ rolledBack: `${current.sessionId}/${current.incarnation}` }) + '\n');
      queueMicrotask(() => child.emit('close', 0));
    } else {
      current = JSON.parse(String(raw)).rollback;
      child.stdout.write(JSON.stringify({ rollback: `${current.sessionId}/${current.incarnation}` }) + '\n');
    }
  });
  return child;
}

it.each(['none', 'replacement', 'runtime-reservation'] as const)(
  'continues failed create cleanup without a returned broker, preserving %s native veto',
  async (change) => {
    let available = false;
    let captured!: BrokerProvisioningRollback;
    let closed: Promise<unknown> | undefined;
    const transport = vi.fn((...args: Parameters<typeof spawn>) => {
      if (!available) throw Error('janitor unavailable beyond the former third attempt');
      const child = spawn(...args);
      closed = once(child, 'close');
      return child;
    });
    vi.doMock(MODULE, () => ({
      ...cleanup,
      rollbackCodexBrokerProvisioning: (proof: BrokerProvisioningRollback) => {
        captured = structuredClone(proof);
        return cleanup.rollbackCodexBrokerProvisioning(proof, transport as typeof spawn, true);
      },
    }));
    const { CodexInputBroker } = await import('../src/recovery/codex-input-broker.js');
    const session = join(root, 'codex-input-brokers', SID);
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (
        args[1] !== 'wx' &&
        String(args[0]).startsWith(session + '/') &&
        !String(args[0])
          .slice(session.length + 1)
          .includes('/')
      ) {
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(Error('failed provisioning'));
      }
      return handle;
    });
    await expect(CodexInputBroker.create(session, SID, 'exec never-launched-fixture', root, root)).rejects.toThrow(
      'failed provisioning'
    );
    const directory = join(session, captured.incarnation);
    const config = join(directory, 'config.json');
    const original = await fs.readFile(config);
    if (change === 'replacement') {
      await fs.writeFile(config + '.owner', original, { mode: 0o600 });
      await fs.rename(config + '.owner', config);
    } else if (change === 'runtime-reservation') {
      await fs.writeFile(join(directory, 'state.json'), '{"receipts":[{"status":"reserved"}]}', { mode: 0o600 });
    }
    await vi.advanceTimersByTimeAsync(20_000);
    expect(transport).toHaveBeenCalledTimes(4);
    expect(await fs.readFile(config)).toEqual(original);
    available = true;
    await vi.advanceTimersByTimeAsync(11_500);
    expect(transport).toHaveBeenCalledTimes(5);
    await closed;
    await Promise.resolve();
    if (change === 'none') {
      await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(transport).toHaveBeenCalledTimes(5);
    } else {
      expect(await fs.readFile(config)).toEqual(original);
      expect(await fs.readdir(directory)).toContain('lock');
      await vi.advanceTimersByTimeAsync(33_600);
      expect(transport).toHaveBeenCalledTimes(6);
      await closed;
      expect(await fs.readFile(config)).toEqual(original);
    }
  }
);

it('retains and fairly rotates a full receipt map, with at most two background attempts per tick', async () => {
  let available = false;
  const serviced: string[] = [];
  const transport = vi.fn(() => {
    if (!available) throw Error('spawn unavailable');
    const child = janitor();
    child.stdin.on('data', (raw) => {
      if (String(raw).trim() !== 'ACK') serviced.push(JSON.parse(String(raw)).rollback.incarnation);
    });
    return child;
  }) as unknown as typeof spawn;
  const receipts = Array.from({ length: 256 }, receipt);
  await Promise.all(receipts.map((proof) => cleanup.rollbackCodexBrokerProvisioning(proof, transport, true)));
  expect(transport).toHaveBeenCalledTimes(256);
  const extra = receipt();
  expect(await cleanup.rollbackCodexBrokerProvisioning(extra, transport, true)).toBe(false);
  expect(transport).toHaveBeenCalledTimes(256);
  available = true;
  await vi.advanceTimersByTimeAsync(2_100);
  expect(transport).toHaveBeenCalledTimes(258);
  expect(serviced).toEqual(receipts.slice(0, 2).map((proof) => proof.incarnation));
  expect(await cleanup.rollbackCodexBrokerProvisioning(extra, transport, true)).toBe(true);
  await vi.advanceTimersByTimeAsync(2_100);
  expect(serviced).toEqual([
    receipts[0].incarnation,
    receipts[1].incarnation,
    extra.incarnation,
    receipts[2].incarnation,
    receipts[3].incarnation,
  ]);
  await vi.advanceTimersByTimeAsync(2_100 * 126);
  expect(new Set(serviced).size).toBe(257);
  expect(serviced).toHaveLength(257);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(serviced).toHaveLength(257);
});

it('keeps the active process cap while timed-out helpers lack a native close receipt', async () => {
  const held = [janitor(false, true), janitor(false, true)];
  for (const child of held) child.kill.mockImplementation(() => true);
  const transport = vi.fn(() => held.shift()!) as unknown as typeof spawn;
  const holders: ReturnType<typeof janitor>[] = [];
  const original = vi.mocked(transport).getMockImplementation()!;
  vi.mocked(transport).mockImplementation((...args: Parameters<typeof spawn>) => {
    const child = original(...args) as unknown as ReturnType<typeof janitor>;
    holders.push(child);
    return child as never;
  });
  const work = [
    cleanup.rollbackCodexBrokerProvisioning(receipt(), transport, true),
    cleanup.rollbackCodexBrokerProvisioning(receipt(), transport, true),
  ];
  await Promise.resolve();
  await cleanup.rollbackCodexBrokerProvisioning(receipt(), transport, true);
  await vi.advanceTimersByTimeAsync(120_000);
  await Promise.all(work);
  expect(transport).toHaveBeenCalledTimes(2);
  for (const child of holders) child.emit('close', 137);
});

it('backs off persistent failure and retains missing terminal ACKs until a later background acknowledgement', async () => {
  let outcome: 'unavailable' | 'ready-only' | 'complete' = 'unavailable';
  const requests: BrokerProvisioningRollback[] = [];
  const transport = vi.fn(() => {
    if (outcome === 'unavailable') throw Error('persistent unavailable janitor');
    const child = janitor(outcome === 'complete');
    child.stdin.on('data', (raw) => {
      if (String(raw).trim() !== 'ACK') requests.push(JSON.parse(String(raw)).rollback);
    });
    return child;
  }) as unknown as typeof spawn;
  const proof = receipt();
  const expected = structuredClone(proof);
  await cleanup.rollbackCodexBrokerProvisioning(proof, transport, true);
  proof.root = '/caller-mutated-proof-must-never-be-used';
  await vi.advanceTimersByTimeAsync(3_600_000);
  const attempts = vi.mocked(transport).mock.calls.length;
  expect(attempts).toBeGreaterThan(3);
  expect(attempts).toBeLessThan(70);
  outcome = 'ready-only';
  await vi.advanceTimersByTimeAsync(60_000);
  expect(transport).toHaveBeenCalledTimes(attempts + 1);
  outcome = 'complete';
  await vi.advanceTimersByTimeAsync(60_000);
  expect(transport).toHaveBeenCalledTimes(attempts + 2);
  expect(requests).toEqual([expected, expected]);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(transport).toHaveBeenCalledTimes(attempts + 2);
});
