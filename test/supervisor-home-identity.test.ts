/** Temporary filesystem proofs only; no manager, CLI, or native pane is launched. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { haveDistinctSupervisorHomes } from '../src/supervisor/home-identity.js';
import { createDeferred } from './mocks/index.js';

describe('supervisor local history directory proof', () => {
  let root: string;
  let manager: string;
  let worker: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(join(homedir(), 'supervisor-home-proof-'));
    manager = join(root, 'manager');
    worker = join(root, 'worker');
    await fs.mkdir(manager);
    await fs.mkdir(worker);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each(['independent', 'same', 'alias', 'missing', 'file'] as const)(
    'accepts only verified independent directories (%s)',
    async (kind) => {
      let selected = worker;
      if (kind === 'same') selected = manager;
      if (kind === 'alias') {
        selected = join(root, 'alias');
        await fs.symlink(manager, selected);
      }
      if (kind === 'missing') selected = join(root, 'missing');
      if (kind === 'file') {
        selected = join(root, 'file');
        await fs.writeFile(selected, 'not a directory');
      }
      expect(await haveDistinctSupervisorHomes(manager, selected, () => true)).toBe(kind === 'independent');
    }
  );

  it.each(['cancelled', 'replaced', 'healthy'] as const)(
    'rechecks caller authority and directory identity after held I/O (%s)',
    async (kind) => {
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const realpath = fs.realpath.bind(fs);
      let current = true;
      vi.spyOn(fs, 'realpath').mockImplementationOnce(async (path) => {
        const result = await realpath(path);
        entered.resolve();
        await release.promise;
        return result;
      });
      const proof = haveDistinctSupervisorHomes(manager, worker, () => current);
      await entered.promise;
      if (kind === 'cancelled') current = false;
      if (kind === 'replaced') {
        await fs.rename(worker, join(root, 'old-worker'));
        await fs.symlink(manager, worker);
      }
      release.resolve();
      expect(await proof).toBe(kind === 'healthy');
    }
  );

  it('times out while retaining the two actual I/O jobs and refuses excess work', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const release = createDeferred<void>();
    const entered = createDeferred<void>();
    const realpath = fs.realpath.bind(fs);
    let calls = 0;
    vi.spyOn(fs, 'realpath').mockImplementation(async (path) => {
      if (++calls === 2) entered.resolve();
      await release.promise;
      return realpath(path);
    });
    const first = haveDistinctSupervisorHomes(manager, worker, () => true, 20);
    const second = haveDistinctSupervisorHomes(manager, worker, () => true, 20);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(20);
    const firstResult = await first;
    const secondResult = await second;
    const excessResult = await haveDistinctSupervisorHomes(manager, worker, () => true, 20);
    const retainedCalls = calls;
    const settled = createDeferred<void>();
    const stat = fs.stat.bind(fs);
    let stats = 0;
    vi.spyOn(fs, 'stat').mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
      const result = await stat(...args);
      if (++stats === 8) settled.resolve();
      return result;
    });
    release.resolve();
    await settled.promise;
    // Drain the actual I/O jobs' finally handlers, rather than polling a counter.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(firstResult).toBe(false);
    expect(secondResult).toBe(false);
    expect(excessResult).toBe(false);
    expect(retainedCalls).toBe(2);
    expect(await haveDistinctSupervisorHomes(manager, worker, () => true, 20)).toBe(true);
  });
});
