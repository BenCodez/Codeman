/** Startup planning uses one bounded asynchronous workspace scan; its final phase cannot touch disk. */
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { planRebootRestore, planVerifiedRebootRestore } from '../src/reboot-restore.js';
import { probeRecoveryDirectory } from '../src/custom-model-recovery.js';
import { WebServer } from '../src/web/server.js';
import { rebootRestoreRegistry } from '../src/web/reboot-restore-registry.js';
import type { SessionState } from '../src/types.js';
vi.mock('node:os', async (original) => ({ ...(await original<typeof import('node:os')>()), uptime: () => 5 }));
let root: string;
const releases: Array<() => void> = [];
const jobs: Promise<unknown>[] = [];
beforeEach(async () => {
  root = await fs.mkdtemp(join(homedir(), 'reboot-planning-workspace-'));
  vi.stubEnv('CODEMAN_DATA_DIR', root);
});
afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  await Promise.allSettled(jobs.splice(0));
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rebootRestoreRegistry.reset();
  await fs.rm(root, { recursive: true, force: true });
});
function barrier() {
  let entered!: () => void, release!: () => void;
  const at = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  return { entered, release, at, wait };
}
function state(id: string, dir = join(root, id)): SessionState {
  return {
    id,
    pid: 12345,
    status: 'idle',
    workingDir: dir,
    currentTaskId: null,
    createdAt: Date.now() - 60000,
    lastActivityAt: Date.now() - 60000,
    mode: 'claude',
    owner: 'alice',
    resumeSessionId: 'original-' + id,
  } as SessionState;
}
async function until(check: () => boolean) {
  const end = process.hrtime.bigint() + 3_000_000_000n;
  while (!check()) {
    if (process.hrtime.bigint() >= end) throw Error('Actual path stage did not arrive');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

it('the actual server planning callback never calls synchronous existsSync and retains the original conversation', async () => {
  const saved = state('healthy');
  await fs.mkdir(saved.workingDir);
  const persisted = { healthy: saved },
    original = structuredClone(persisted);
  const stage = barrier(),
    stat = fs.stat.bind(fs);
  let calls = 0;
  vi.spyOn(fs, 'stat').mockImplementation(async (path, ...options) => {
    if (String(path) === saved.workingDir) {
      calls++;
      stage.entered();
      await stage.wait;
    }
    return stat(path, ...options);
  });
  const server = { store: { getSessions: () => persisted } };
  const planner = (
    WebServer.prototype as unknown as { planRebootRestoreOffer(dead: string[], live: number): Promise<number> }
  ).planRebootRestoreOffer;
  const planning = planner.call(server, ['healthy'], 0);
  jobs.push(planning);
  await Promise.race([
    stage.at,
    planning.then(() => {
      throw Error('Startup planner bypassed bounded asynchronous path evidence');
    }),
  ]);
  expect(rebootRestoreRegistry.list(() => true)).toEqual([]);
  stage.release();
  expect(await planning).toBe(1);
  expect(calls).toBe(1);
  expect(rebootRestoreRegistry.list(() => true)[0]).toMatchObject({
    resumeConversationId: 'original-healthy',
    owner: 'alice',
  });
  expect(persisted).toEqual(original);
});
it.each(['absent', 'unknown', 'present'] as const)(
  'carries %s directory evidence through the pure phase without a second lookup',
  async (kind) => {
    const saved = state('worker');
    if (kind !== 'absent') await fs.mkdir(saved.workingDir);
    const stat = fs.stat.bind(fs);
    let calls = 0;
    vi.spyOn(fs, 'stat').mockImplementation(async (path, ...options) => {
      if (String(path) === saved.workingDir) {
        calls++;
        if (kind === 'unknown') throw Object.assign(Error('unreadable'), { code: 'EACCES' });
      }
      return stat(path, ...options);
    });
    const plan = await planVerifiedRebootRestore([saved.id], { [saved.id]: saved });
    expect(calls).toBe(1);
    expect(plan.restore).toHaveLength(kind === 'present' ? 1 : 0);
    if (kind !== 'present')
      expect(plan.skipped).toEqual([
        { sessionId: saved.id, reason: kind === 'absent' ? 'workspace-missing' : 'rebuild-failed' },
      ]);
  }
);
it.each(['cancelled', 'owner-edit'] as const)(
  'does not publish stale workspace proof after %s during actual path IO',
  async (kind) => {
    const saved = state('worker');
    await fs.mkdir(saved.workingDir);
    const stage = barrier(),
      stat = fs.stat.bind(fs);
    let current = true;
    vi.spyOn(fs, 'stat').mockImplementation(async (path, ...options) => {
      if (String(path) === saved.workingDir) {
        stage.entered();
        await stage.wait;
      }
      return stat(path, ...options);
    });
    const planning = planVerifiedRebootRestore([saved.id], { [saved.id]: saved }, undefined, undefined, () => current);
    jobs.push(planning);
    await stage.at;
    if (kind === 'cancelled') current = false;
    else {
      saved.owner = 'bob';
      saved.status = 'stopped';
    }
    stage.release();
    const result = await planning;
    expect(result.restore).toEqual([]);
    expect(result.skipped).toEqual([
      { sessionId: saved.id, reason: kind === 'owner-edit' ? 'intentionally-ended' : 'rebuild-failed' },
    ]);
    expect(saved.owner).toBe(kind === 'owner-edit' ? 'bob' : 'alice');
  }
);
it('shares one original deadline across responsive workspace lookups and leaves later paths unknown', async () => {
  const persisted: Record<string, SessionState> = {};
  for (let i = 0; i < 6; i++) {
    const saved = state('worker-' + i);
    await fs.mkdir(saved.workingDir);
    persisted[saved.id] = saved;
  }
  const original = structuredClone(persisted),
    stages: ReturnType<typeof barrier>[] = [],
    paths: string[] = [];
  const stat = fs.stat.bind(fs);
  vi.spyOn(fs, 'stat').mockImplementation(async (path, ...options) => {
    if (Object.values(persisted).some((saved) => saved.workingDir === String(path))) {
      const stage = barrier();
      stages.push(stage);
      paths.push(String(path));
      stage.entered();
      await stage.wait;
    }
    return stat(path, ...options);
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  let settled = false;
  const planning = planVerifiedRebootRestore(Object.keys(persisted), persisted).then((value) => {
    settled = true;
    return value;
  });
  jobs.push(planning);
  for (let i = 0; i < 3; i++) {
    await until(() => stages.length > i);
    await vi.advanceTimersByTimeAsync(650);
    stages[i].release();
  }
  await until(() => stages.length === 4);
  await vi.advanceTimersByTimeAsync(50);
  await until(() => settled);
  const result = await planning;
  expect(performance.now()).toBe(2000);
  expect(paths).toHaveLength(4);
  expect(result.restore.map((entry) => entry.sessionId)).toEqual(['worker-0', 'worker-1', 'worker-2']);
  expect(result.skipped).toEqual(
    ['worker-3', 'worker-4', 'worker-5'].map((sessionId) => ({ sessionId, reason: 'rebuild-failed' }))
  );
  expect(persisted).toEqual(original);
  stages[3].release();
});
it('retains an actually outstanding path job so a retry cannot overtake it', async () => {
  const saved = state('worker');
  await fs.mkdir(saved.workingDir);
  const stage = barrier(),
    stat = fs.stat.bind(fs);
  let calls = 0;
  vi.spyOn(fs, 'stat').mockImplementation(async (path, ...options) => {
    if (String(path) === saved.workingDir) {
      calls++;
      stage.entered();
      await stage.wait;
    }
    return stat(path, ...options);
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const first = planVerifiedRebootRestore([saved.id], { [saved.id]: saved });
  jobs.push(first);
  await stage.at;
  await vi.advanceTimersByTimeAsync(2000);
  expect((await first).restore).toEqual([]);
  expect((await planVerifiedRebootRestore([saved.id], { [saved.id]: saved })).restore).toEqual([]);
  expect(calls).toBe(1);
  stage.release();
  vi.useRealTimers();
  await vi.waitFor(async () =>
    expect((await probeRecoveryDirectory(saved.workingDir, () => true, true)).status).toBe('present')
  );
});
it('the pure planner distinguishes unknown from verified absence while retaining existing owner-intent vetoes', () => {
  const saved = state('worker');
  expect(planRebootRestore([saved.id], { worker: saved }, () => 'unknown').skipped).toEqual([
    { sessionId: saved.id, reason: 'rebuild-failed' },
  ]);
  expect(planRebootRestore([saved.id], { worker: saved }, () => 'absent').skipped).toEqual([
    { sessionId: saved.id, reason: 'workspace-missing' },
  ]);
  saved.status = 'stopped';
  const probe = vi.fn(() => 'present' as const);
  expect(planRebootRestore([saved.id], { worker: saved }, probe).skipped).toEqual([
    { sessionId: saved.id, reason: 'intentionally-ended' },
  ]);
  expect(probe).not.toHaveBeenCalled();
});
