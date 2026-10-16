/** @fileoverview Real private broker/rollout files, responsive staged reads, and one monotonic batch budget. */
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CodexInputBroker } from '../src/recovery/codex-input-broker.js';
import { planVerifiedRebootRestore } from '../src/reboot-restore.js';
import { captureRebootBrokerBindings } from '../src/recovery/reboot-launch-witness.js';
import * as witnesses from '../src/recovery/codex-witness-check.js';
import type { SessionState } from '../src/types.js';
let root: string;
const releases: Array<() => void> = [];
const jobs: Promise<unknown>[] = [];
let delays = true;
beforeEach(async () => {
  root = await fs.mkdtemp(join(homedir(), 'reboot-history-budget-'));
  vi.stubEnv('CODEMAN_DATA_DIR', root);
  delays = true;
});
afterEach(async () => {
  delays = false;
  releases.splice(0).forEach((release) => release());
  await Promise.allSettled(jobs.splice(0));
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function until(check: () => boolean) {
  const end = process.hrtime.bigint() + 3_000_000_000n;
  while (!check()) {
    if (process.hrtime.bigint() >= end) throw Error('Actual private read stage did not arrive');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
async function fixtures(count: number) {
  const home = join(root, 'home');
  await fs.mkdir(join(home, 'sessions'), { recursive: true });
  const states: Record<string, SessionState> = {},
    bindings = new Map<string, string | null>(),
    configs: string[] = [],
    rollouts: string[] = [];
  for (let index = 0; index < count; index++) {
    const id = randomUUID(),
      cid = randomUUID(),
      work = join(root, 'work-' + index);
    await fs.mkdir(work);
    const broker = await CodexInputBroker.create(
      join(root, 'codex-input-brokers', id),
      id,
      'exec fake-unexecuted-worker',
      home,
      root
    );
    const material = JSON.parse(await fs.readFile(join(broker.directory, 'config.json'), 'utf8'));
    await fs.writeFile(
      join(broker.directory, 'state.json'),
      JSON.stringify({
        version: 1,
        sessionId: id,
        incarnation: broker.incarnation,
        pid: 999990,
        childPid: 999991,
        brokerStart: '1',
        childStart: '2',
        tainted: false,
        rawGeneration: 0,
        launchDigest: material.launchDigest,
        homeDigest: material.homeDigest,
        closed: true,
        exitStatus: 1,
        exitSignal: null,
        counters: { 'owner-pty': 0, 'owner-key': 0, 'owner-mux': 0, auto: 0, probe: 0 },
        receipts: [],
        startup: { nonce: material.startup.nonce, status: 'started' },
      }),
      { mode: 0o600 }
    );
    const rollout = join(home, 'sessions', 'rollout-fixture-' + cid + '.jsonl');
    await fs.writeFile(
      rollout,
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: cid,
          cwd: work,
          originator: 'codeman_' + id,
          timestamp: new Date(Date.now() - 10000).toISOString(),
        },
      }) + '\n'
    );
    states[id] = {
      id,
      pid: 999990,
      status: 'idle',
      mode: 'codex',
      workingDir: work,
      createdAt: Date.now() - 1000,
      currentTaskId: null,
      codexConfig: { noDaemon: true, resumeSessionId: cid },
      __codexRecoveryHome: home,
      __envOverrides: { CODEX_HOME: home },
    } as SessionState;
    bindings.set(id, broker.incarnation);
    configs.push(join(broker.directory, 'config.json'));
    rollouts.push(rollout);
  }
  return { states, bindings, configs, rollouts, home };
}
it.each([150, 650])(
  'shares the original 2s across successive responsive historical reads (%sms each)',
  async (delay) => {
    const f = await fixtures(6),
      seen = new Set<string>(),
      stages: Array<{ path: string; release: () => void }> = [],
      closed = new Set<string>(),
      open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args),
        path = String(args[0]);
      if (f.configs.includes(path) && !seen.has(path)) {
        seen.add(path);
        const read = handle.read.bind(handle),
          close = handle.close.bind(handle);
        handle.read = (async (...input: unknown[]) => {
          if (delays) {
            const stage = barrier();
            releases.push(stage.release);
            stages.push({ path, release: stage.release });
            await stage.promise;
          }
          return (read as (...args: unknown[]) => Promise<unknown>)(...input);
        }) as typeof handle.read;
        handle.close = async () => {
          await close();
          closed.add(path);
        };
      }
      return handle;
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let settled = false;
    const planning = planVerifiedRebootRestore(
      Object.keys(f.states),
      f.states,
      async () => ({ status: 'present' as const, dev: 1, ino: 1 }),
      f.bindings
    ).then((result) => {
      settled = true;
      return result;
    });
    jobs.push(planning);
    const completed = delay === 150 ? 6 : 3;
    for (let index = 0; index < completed; index++) {
      await until(() => stages.length > index);
      await vi.advanceTimersByTimeAsync(delay);
      stages[index].release();
    }
    if (delay === 650) {
      await until(() => stages.length === 4);
      await vi.advanceTimersByTimeAsync(50);
      await until(() => settled);
    }
    const plan = await planning;
    expect(plan.restore).toHaveLength(completed);
    expect(plan.skipped).toHaveLength(6 - completed);
    expect(stages).toHaveLength(delay === 150 ? 6 : 4);
    if (delay === 650) {
      expect(performance.now()).toBe(2000);
      expect(closed.has(stages[3].path)).toBe(false);
      stages[3].release();
      await until(() => closed.has(stages[3].path));
    }
  }
);
it('the final common witness read cannot start a new per-entry 2s budget', async () => {
  const f = await fixtures(1),
    entered = barrier(),
    release = barrier();
  releases.push(release.release);
  let verifying = false,
    closed = false;
  const verify = witnesses.checkCodexIdentityWitnesses;
  vi.spyOn(witnesses, 'checkCodexIdentityWitnesses').mockImplementation((...args) => {
    verifying = true;
    return verify(...args);
  });
  const open = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (verifying && args[0] === f.rollouts[0]) {
      const read = handle.read.bind(handle),
        close = handle.close.bind(handle);
      handle.read = (async (...input: unknown[]) => {
        entered.release();
        await release.promise;
        return (read as (...args: unknown[]) => Promise<unknown>)(...input);
      }) as typeof handle.read;
      handle.close = async () => {
        await close();
        closed = true;
      };
    }
    return handle;
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  // Consume the first 1800ms in genuine historical inspection before final verification.
  const inspect = CodexInputBroker.inspectHistoricalEvidence;
  vi.spyOn(CodexInputBroker, 'inspectHistoricalEvidence').mockImplementation(async (...args) => {
    await vi.advanceTimersByTimeAsync(1800);
    return inspect(...args);
  });
  let settled = false;
  const planning = planVerifiedRebootRestore(
    Object.keys(f.states),
    f.states,
    async () => ({ status: 'present' as const, dev: 1, ino: 1 }),
    f.bindings
  ).then((result) => {
    settled = true;
    return result;
  });
  jobs.push(planning);
  await entered.promise;
  await vi.advanceTimersByTimeAsync(200);
  await until(() => settled);
  expect((await planning).restore).toEqual([]);
  expect(closed).toBe(false);
  release.release();
  await until(() => closed);
});
it('expired shared evidence starts no new broker, binding, or witness filesystem job', async () => {
  const f = await fixtures(1),
    open = vi.spyOn(fs, 'open'),
    deadline = performance.now() - 1;
  expect(
    await CodexInputBroker.inspectHistoricalEvidence(
      join(root, 'codex-input-brokers', Object.keys(f.states)[0], f.bindings.values().next().value!),
      Object.keys(f.states)[0],
      f.bindings.values().next().value!,
      f.home,
      deadline
    )
  ).toBeUndefined();
  expect(await captureRebootBrokerBindings(f.states, deadline)).toBeUndefined();
  expect(await witnesses.checkCodexIdentityWitnesses([], [], deadline)).toBe(false);
  expect(open).not.toHaveBeenCalled();
});

it.each([
  'completed-legacy',
  'broker-still-required',
  'malformed',
  'wrong-uuid',
  'changed-scope',
  'cancelled',
  'stalled-first',
] as const)('retains only completely validated identities after a later home stalls: %s', async (kind) => {
  const f = await fixtures(2);
  const [firstId, stalledId] = Object.keys(f.states);
  const first = f.states[firstId],
    stalled = f.states[stalledId];
  const stalledHome = join(root, 'stalled-home');
  await fs.mkdir(join(stalledHome, 'sessions'), { recursive: true });
  const stalledRollout = join(stalledHome, 'sessions', basename(f.rollouts[1]));
  await fs.rename(f.rollouts[1], stalledRollout);
  Object.assign(stalled, { __codexRecoveryHome: stalledHome, __envOverrides: { CODEX_HOME: stalledHome } });
  if (kind !== 'broker-still-required') f.bindings.set(firstId, null);
  f.bindings.set(stalledId, null);
  if (kind === 'malformed') await fs.writeFile(f.rollouts[0], '{bad frame\n');
  if (kind === 'wrong-uuid') first.codexConfig!.resumeSessionId = randomUUID();
  const entered = barrier(),
    release = barrier();
  releases.push(release.release);
  let closed = false,
    current = true,
    settled = false;
  const opens: Array<{ path: string; at: number }> = [];
  const open = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    opens.push({ path: String(args[0]), at: performance.now() });
    const handle = await open(...args);
    if (args[0] === stalledRollout) {
      const read = handle.read.bind(handle),
        close = handle.close.bind(handle);
      handle.read = (async (...input: unknown[]) => {
        entered.release();
        await release.promise;
        return (read as (...args: unknown[]) => Promise<unknown>)(...input);
      }) as typeof handle.read;
      handle.close = async () => {
        await close();
        closed = true;
      };
    }
    return handle;
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const ids = kind === 'stalled-first' ? [stalledId, firstId] : [firstId, stalledId];
  const planning = planVerifiedRebootRestore(
    ids,
    f.states,
    async () => ({ status: 'present' as const, dev: 1, ino: 1 }),
    f.bindings,
    () => current
  ).then((plan) => {
    settled = true;
    return plan;
  });
  jobs.push(planning);
  await entered.promise;
  if (kind === 'changed-scope') first.owner = 'changed-owner';
  if (kind === 'cancelled') current = false;
  await vi.advanceTimersByTimeAsync(2000);
  await until(() => settled);
  const plan = await planning;
  expect(plan.restore.map((entry) => entry.sessionId)).toEqual(kind === 'completed-legacy' ? [firstId] : []);
  expect(plan.skipped).toHaveLength(kind === 'completed-legacy' ? 1 : 2);
  expect(performance.now()).toBe(2000);
  expect(opens.every((entry) => entry.at < 2000)).toBe(true);
  expect(opens.some((entry) => f.configs.includes(entry.path))).toBe(false);
  expect(closed).toBe(false);
  release.release();
  await until(() => closed);
});
