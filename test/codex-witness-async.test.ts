/** Bounded real isolated filesystem checks with held promises, never network mounts or live panes. */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveCodexIdentity } from '../src/recovery/codex-identity.js';
import { checkCodexIdentityWitness, checkCodexIdentityWitnesses } from '../src/recovery/codex-witness-check.js';

const homes: string[] = [];
const THREAD = '11111111-2222-3333-4444-555555555555';
async function fixture() {
  const home = await fs.mkdtemp(join(homedir(), 'witness-async-'));
  homes.push(home);
  await fs.mkdir(join(home, 'sessions'));
  const path = join(home, 'sessions', `rollout-2026-10-13T12-00-00-${THREAD}.jsonl`);
  const row =
    JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-10-13T12:00:00Z',
      payload: { id: THREAD, cwd: home, originator: 'codeman_fixture' },
    }) + '\n';
  await fs.writeFile(path, row);
  const identity = await resolveCodexIdentity({
    sessionId: 'fixture',
    workingDir: home,
    codexHome: home,
    resumeId: THREAD,
    noDaemon: true,
  });
  expect(identity.reason).toBe('verified');
  return { identity, home, path, row };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true });
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe('asynchronous final identity witnesses', () => {
  it.each(['single-first', 'bundle-first'] as const)('retains one job per leaf across %s groups', async (order) => {
    const worker = await fixture();
    const issuer = await fixture();
    const open = fs.open.bind(fs);
    const held = deferred();
    const entered = deferred();
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const file = await open(...args);
      if (String(args[0]) === worker.path) {
        entered.resolve();
        await held.promise;
      }
      return file;
    });
    const pending =
      order === 'single-first'
        ? checkCodexIdentityWitness(worker.identity)
        : checkCodexIdentityWitnesses([issuer.identity, worker.identity]);
    try {
      await entered.promise;
      const opens = spy.mock.calls.length;
      expect(
        await (order === 'single-first'
          ? checkCodexIdentityWitnesses([issuer.identity, worker.identity])
          : checkCodexIdentityWitness(worker.identity))
      ).toBe(false);
      expect(spy).toHaveBeenCalledTimes(opens);
      held.resolve();
      expect(await pending).toBe(true);
      expect(await checkCodexIdentityWitnesses([issuer.identity, worker.identity])).toBe(true);
    } finally {
      held.resolve();
      await pending;
    }
  });
  it.each(
    (['worker', 'issuer'] as const).flatMap((heldDomain) =>
      (['worker-first', 'issuer-first'] as const).map((order) => ({ heldDomain, order }))
    )
  )('checks both domains after held $heldDomain cleanup in $order order', async ({ heldDomain, order }) => {
    const worker = await fixture();
    const issuer = await fixture();
    const entered = deferred();
    const held = deferred();
    const open = fs.open.bind(fs);
    const waiting = heldDomain === 'worker' ? worker : issuer;
    const changed = heldDomain === 'worker' ? issuer : worker;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const file = await open(...args);
      if (String(args[0]) === waiting.path) {
        const close = file.close.bind(file);
        vi.spyOn(file, 'close').mockImplementation(async () => {
          entered.resolve();
          await held.promise;
          await close();
        });
      }
      return file;
    });
    const check = checkCodexIdentityWitnesses(
      order === 'worker-first' ? [worker.identity, issuer.identity] : [issuer.identity, worker.identity]
    );
    try {
      await entered.promise;
      await fs.appendFile(changed.path, '{}\n');
      held.resolve();
      expect(await check).toBe(false);
    } finally {
      held.resolve();
      await check;
    }
  });
  it('verifies an unchanged worker and issuer together under the same finite budget', async () => {
    const worker = await fixture();
    const issuer = await fixture();
    expect(await checkCodexIdentityWitnesses([worker.identity, issuer.identity])).toBe(true);
    expect(await checkCodexIdentityWitnesses([])).toBe(false);
    expect(await checkCodexIdentityWitnesses([worker.identity, issuer.identity, worker.identity])).toBe(false);
  });
  it('refuses rollout changes during descriptor cleanup before returning its final proof', async () => {
    const f = await fixture();
    const open = fs.open.bind(fs);
    const entered = deferred();
    const held = deferred();
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const file = await open(...args);
      const close = file.close.bind(file);
      vi.spyOn(file, 'close').mockImplementation(async () => {
        entered.resolve();
        await held.promise;
        await close();
      });
      return file;
    });
    const check = checkCodexIdentityWitness(f.identity);
    try {
      await entered.promise;
      await fs.appendFile(f.path, '{}\n');
      held.resolve();
      expect(await check).toBe(false);
    } finally {
      held.resolve();
      await check;
    }
  });
  it('refuses a successful close callback that finishes past the monotonic deadline before the timer runs', async () => {
    const f = await fixture();
    const open = fs.open.bind(fs);
    const started = performance.now();
    let late = false;
    vi.spyOn(performance, 'now').mockImplementation(() => started + (late ? 2_001 : 0));
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const file = await open(...args);
      const close = file.close.bind(file);
      vi.spyOn(file, 'close').mockImplementation(async () => {
        await close();
        late = true;
      });
      return file;
    });
    expect(await checkCodexIdentityWitness(f.identity)).toBe(false);
  });
  it('verifies exact contents and retains nonblocking no-follow open flags', async () => {
    const f = await fixture();
    const open = fs.open.bind(fs);
    const flags: number[] = [];
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      flags.push(Number(args[1]));
      return open(...args);
    });
    expect(await checkCodexIdentityWitness(f.identity)).toBe(true);
    expect(flags).toHaveLength(1);
    expect(flags[0] & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
    expect(flags[0] & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
  });
  it.each(['changed-content', 'replacement', 'symlink', 'missing-leaf', 'truncated', 'unknown-truncation'])(
    'refuses %s evidence without trusting a stale snapshot',
    async (kind) => {
      const f = await fixture();
      if (kind === 'changed-content') await fs.appendFile(f.path, '{}\n');
      if (kind === 'replacement') {
        await fs.writeFile(f.path + '.new', f.row);
        await fs.rename(f.path + '.new', f.path);
      }
      if (kind === 'symlink') {
        await fs.rename(f.path, f.path + '.target');
        await fs.symlink(f.path + '.target', f.path);
      }
      if (kind === 'missing-leaf') f.identity.witness!.paths = [];
      if (kind === 'truncated') f.identity.tailTruncated = true;
      if (kind === 'unknown-truncation') delete f.identity.tailTruncated;
      expect(await checkCodexIdentityWitness(f.identity)).toBe(false);
    }
  );
  it.each(['lstat', 'open', 'read'] as const)(
    'bounds a stalled %s while preserving single-flight and closing a late descriptor',
    async (stage) => {
      const f = await fixture();
      const held = deferred();
      const entered = deferred();
      const realLstat = fs.lstat.bind(fs);
      const realOpen = fs.open.bind(fs);
      const close = vi.fn();
      const reads = vi.fn();
      if (stage === 'lstat')
        vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
          entered.resolve();
          await held.promise;
          return realLstat(...args);
        });
      else
        vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
          const file = await realOpen(...args);
          const actualClose = file.close.bind(file);
          vi.spyOn(file, 'close').mockImplementation(async () => {
            close();
            await actualClose();
          });
          if (stage === 'open') {
            entered.resolve();
            await held.promise;
          } else {
            const actualRead = file.read.bind(file);
            vi.spyOn(file, 'read').mockImplementation(async (...readArgs) => {
              reads();
              entered.resolve();
              await held.promise;
              return Reflect.apply(actualRead, file, readArgs);
            });
          }
          return file;
        });
      const check = checkCodexIdentityWitness(f.identity);
      try {
        await entered.promise;
        const heartbeat = vi.fn();
        await new Promise<void>((done) =>
          setImmediate(() => {
            heartbeat();
            done();
          })
        );
        expect(heartbeat).toHaveBeenCalledOnce();
        expect(await check).toBe(false);
        expect(await checkCodexIdentityWitness(f.identity)).toBe(false);
        if (stage !== 'lstat') expect(fs.open).toHaveBeenCalledOnce();
        held.resolve();
        if (stage !== 'lstat') await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
        if (stage === 'open') expect(reads).not.toHaveBeenCalled();
      } finally {
        held.resolve();
        await check;
      }
    },
    7_000
  );
});
