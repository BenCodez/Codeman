/** Actual temporary profile/identity/fence domains share one bounded final proof. */
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rebuildPersistedCustomModelEnv, captureCustomModelRecoveryWitness } from '../src/custom-model-recovery.js';
import { customModelHostsPath } from '../src/custom-model-hosts.js';
import { customModelConfigDir } from '../src/custom-model-injection-apply.js';
import {
  captureRebootIdentityFenceWitness,
  captureRebootLaunchWitness,
  type RebootLaunchWitness,
} from '../src/recovery/reboot-launch-witness.js';
import { rebootIdentityFencePath } from '../src/recovery/reboot-identity-fence.js';
import type { CodexIdentityResult } from '../src/recovery/codex-identity.js';
import type { PrivateFileWitness } from '../src/recovery/private-file-witness.js';

const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const THREAD = '11111111-2222-3333-4444-555555555555';
const saved = {
  endpointId: 'fixture-endpoint',
  modelId: 'fixture-model',
  envKeys: ['CODEX_HOME', 'CODEMAN_CUSTOM_MODEL_API_KEY'],
};
const deferred = () => {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => {
      resolve = done;
    }),
    resolve: () => resolve(),
  };
};

describe('joint reboot launch evidence', () => {
  let root: string;
  let previousData: string | undefined;
  let witness: RebootLaunchWitness;
  let identity: CodexIdentityResult;
  let store: string;
  let config: string;
  let rollout: string;
  const releases: (() => void)[] = [];
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'codeman-joint-proof-'));
    previousData = process.env.CODEMAN_DATA_DIR;
    process.env.CODEMAN_DATA_DIR = root;
    store = customModelHostsPath(root);
    await fs.writeFile(
      store,
      JSON.stringify([
        {
          id: saved.endpointId,
          baseUrl: 'http://127.0.0.1:8080',
          apiKey: 'fixture-private-key',
          models: [saved.modelId],
        },
      ])
    );
    const env = await rebuildPersistedCustomModelEnv('codex', ID, saved);
    expect(env).toBeDefined();
    config = join(customModelConfigDir(ID), 'config.toml');
    rollout = join(customModelConfigDir(ID), 'rollout.jsonl');
    const tail = JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n';
    await fs.writeFile(rollout, tail);
    const stat = await fs.lstat(rollout);
    identity = {
      reason: 'verified',
      conversationId: THREAD,
      path: rollout,
      tail,
      tailTruncated: false,
      witness: {
        paths: [
          {
            path: rollout,
            kind: 'file',
            dev: stat.dev,
            ino: stat.ino,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            ctimeMs: stat.ctimeMs,
          },
        ],
      },
    };
    witness = (await captureCustomModelRecoveryWitness('codex', ID, saved, env!))!;
    expect(witness).toBeTypeOf('function');
  });
  afterEach(async () => {
    releases.splice(0).forEach((release) => release());
    await new Promise<void>((resolve) => setImmediate(resolve));
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (previousData === undefined) delete process.env.CODEMAN_DATA_DIR;
    else process.env.CODEMAN_DATA_DIR = previousData;
    await fs.rm(root, { recursive: true, force: true });
  });

  function hold(path: string, boundary: 'open' | 'read' | 'close') {
    const reached = deferred(),
      release = deferred(),
      closed = deferred(),
      secondOpened = deferred();
    releases.push(release.resolve);
    const open = fs.open.bind(fs);
    let opens = 0;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (args[0] !== path) return open(...args);
      opens++;
      if (opens === 2) secondOpened.resolve();
      expect(Number(args[1]) & constants.O_NOFOLLOW).not.toBe(0);
      expect(Number(args[1]) & constants.O_NONBLOCK).not.toBe(0);
      if (boundary === 'open') {
        reached.resolve();
        await release.promise;
      }
      const file = await open(...args);
      const read = file.read.bind(file),
        close = file.close.bind(file);
      vi.spyOn(file, 'read').mockImplementation(async (...args) => {
        if (boundary === 'read') {
          reached.resolve();
          await release.promise;
        }
        return Reflect.apply(read, file, args);
      });
      vi.spyOn(file, 'close').mockImplementation(async () => {
        if (boundary === 'close') {
          reached.resolve();
          await release.promise;
        }
        try {
          await close();
        } finally {
          closed.resolve();
        }
      });
      return file;
    });
    return { reached, release, closed, secondOpened, opens: () => opens };
  }

  it.each([true, false])(
    'accepts unchanged exact identity, generated profile and legacy absence (custom=%s)',
    async (custom) => {
      const check = custom ? witness : (await captureRebootLaunchWitness('codex', ID, undefined, {}))!;
      const fence = await captureRebootIdentityFenceWitness(ID);
      expect(fence).toMatchObject({ sessionId: ID, value: undefined });
      expect(await check(identity, fence)).toBe(true);
      const path = rebootIdentityFencePath(ID);
      await fs.mkdir(join(root, 'reboot-identities'));
      await fs.writeFile(path, JSON.stringify({ version: 1, switchPending: false, resumeSessionId: THREAD }));
      const current = await captureRebootIdentityFenceWitness(ID);
      expect(await check(identity, current)).toBe(true);
      expect(await check(identity, fence)).toBe(false);
    }
  );

  it('exports only the latest full proof with private byte and absence witnesses', async () => {
    const fence = await captureRebootIdentityFenceWitness(ID);
    expect(witness.getStartupEvidence()).toBeUndefined();
    expect(await witness(identity, fence)).toBe(true);
    const evidence = witness.getStartupEvidence()!;
    expect(evidence.files.map((file) => file.path)).toEqual(expect.arrayContaining([store, config, rollout]));
    expect(evidence.missing).toEqual([rebootIdentityFencePath(ID)]);
    expect(evidence.files.every((file) => /^[a-f0-9]{64}$/.test(file.hash))).toBe(true);
    evidence.paths.splice(0);
    evidence.files[0].hash = '0'.repeat(64);
    expect(witness.getStartupEvidence()!.paths.length).toBeGreaterThan(0);
    expect(witness.getStartupEvidence()!.files[0].hash).not.toBe('0'.repeat(64));
    expect(await witness()).toBe(true);
    expect(witness.getStartupEvidence()).toBeUndefined();
    expect(await witness(identity, fence)).toBe(true);
    expect(await witness({ ...identity, tailTruncated: true }, fence)).toBe(false);
    expect(witness.getStartupEvidence()).toBeUndefined();
  });

  it('never restores an older held startup proof after a newer refusal', async () => {
    const fence = await captureRebootIdentityFenceWitness(ID);
    const gate = hold(rollout, 'read');
    const older = witness(identity, fence);
    await gate.reached.promise;
    expect(witness.getStartupEvidence()).toBeUndefined();
    expect(await witness({ ...identity, tailTruncated: true }, fence)).toBe(false);
    gate.release.resolve();
    expect(await older).toBe(false);
    expect(witness.getStartupEvidence()).toBeUndefined();
  });

  it.each([
    { held: 'rollout', boundary: 'read', changed: 'store' },
    { held: 'config', boundary: 'read', changed: 'rollout' },
    { held: 'config', boundary: 'close', changed: 'store' },
    { held: 'rollout', boundary: 'close', changed: 'config' },
    { held: 'fence', boundary: 'read', changed: 'rollout' },
    { held: 'rollout', boundary: 'read', changed: 'fence' },
  ] as const)(
    'rejects $changed changes during the other domain $held $boundary',
    async ({ held, boundary, changed }) => {
      const fencePath = rebootIdentityFencePath(ID);
      await fs.mkdir(join(root, 'reboot-identities'));
      await fs.writeFile(fencePath, JSON.stringify({ version: 1, switchPending: false }));
      const fence = await captureRebootIdentityFenceWitness(ID);
      const paths = { rollout, config, store, fence: fencePath };
      const gate = hold(paths[held], boundary);
      const result = witness(identity, fence);
      await gate.reached.promise;
      if (changed === 'fence') await fs.writeFile(paths[changed], JSON.stringify({ version: 1, switchPending: true }));
      else await fs.appendFile(paths[changed], '\n');
      gate.release.resolve();
      expect(await result).toBe(false);
      await gate.closed.promise;
    }
  );

  it('rejects creation of a legacy fence while the identity FD is held', async () => {
    const fence = await captureRebootIdentityFenceWitness(ID);
    const gate = hold(rollout, 'read');
    const result = witness(identity, fence);
    await gate.reached.promise;
    await fs.mkdir(join(root, 'reboot-identities'));
    await fs.writeFile(rebootIdentityFencePath(ID), JSON.stringify({ version: 1, switchPending: true }));
    gate.release.resolve();
    expect(await result).toBe(false);
  });

  it.each(['open', 'read', 'close'] as const)(
    'times out a stalled %s without blocking timers or releasing its pending slot before FD cleanup',
    async (boundary) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
      const gate = hold(rollout, boundary);
      const result = witness(identity);
      await gate.reached.promise;
      const same = witness({ ...identity, witness: { paths: identity.witness!.paths.map((path) => ({ ...path })) } });
      let heartbeat = false;
      setTimeout(() => {
        heartbeat = true;
      }, 5);
      await vi.advanceTimersByTimeAsync(2_001);
      expect(heartbeat).toBe(true);
      expect(await result).toBe(false);
      expect(await same).toBe(false);
      expect(gate.opens()).toBe(1);
      expect(await witness(identity)).toBe(false);
      expect(gate.opens()).toBe(1);
      gate.release.resolve();
      await gate.closed.promise;
    }
  );

  it('does not coalesce a different identity/hash scope and bounds stalled jobs to two', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const gate = hold(store, 'open');
    const first = witness(identity);
    await gate.reached.promise;
    const second = witness({ ...identity, tail: identity.tail! + '\n' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(gate.opens()).toBe(2);
    expect(await witness({ ...identity, conversationId: '22222222-2222-3333-4444-555555555555' })).toBe(false);
    expect(gate.opens()).toBe(2);
    await vi.advanceTimersByTimeAsync(2_001);
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    gate.release.resolve();
    await gate.closed.promise;
  });

  it.each(['hash', 'truncated', 'missing-leaf', 'oversized-tail'] as const)(
    'refuses incomplete identity proof: %s',
    async (kind) => {
      const input = {
        ...identity,
        ...(kind === 'hash' ? { tail: 'changed\n' } : {}),
        ...(kind === 'truncated' ? { tailTruncated: true } : {}),
        ...(kind === 'missing-leaf' ? { witness: { paths: [] } } : {}),
        ...(kind === 'oversized-tail' ? { tail: 'x'.repeat(262_145) } : {}),
      };
      expect(await witness(input)).toBe(false);
    }
  );

  it.each(['corrupt', 'oversized', 'symlink'] as const)(
    'never treats an invalid %s fence as a legacy absence',
    async (kind) => {
      const path = rebootIdentityFencePath(ID);
      await fs.mkdir(join(root, 'reboot-identities'));
      if (kind === 'symlink') await fs.symlink(rollout, path);
      else await fs.writeFile(path, kind === 'corrupt' ? '{broken' : ' '.repeat(1025));
      expect(await captureRebootIdentityFenceWitness(ID)).toBeUndefined();
    }
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a real FIFO durable fence without waiting for a writer',
    async () => {
      const path = rebootIdentityFencePath(ID);
      await fs.mkdir(join(root, 'reboot-identities'));
      execFileSync('mkfifo', [path], { timeout: 2000 });
      expect(await captureRebootIdentityFenceWitness(ID)).toBeUndefined();
    }
  );

  async function privateGrant(): Promise<PrivateFileWitness> {
    const path = join(root, 'users.json');
    const text = JSON.stringify({ version: 1, users: [{ username: 'owner', canBypassPermissions: true }] });
    await fs.writeFile(path, text);
    const stat = await fs.lstat(path);
    return {
      path,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      hash: createHash('sha256').update(text).digest('hex'),
      maxBytes: 2_097_152,
    };
  }

  it.each([true, false])('accepts a current private grant in the same final proof (custom=%s)', async (custom) => {
    const grant = await privateGrant();
    const check = custom ? witness : (await captureRebootLaunchWitness('codex', ID, undefined, {}))!;
    const fence = await captureRebootIdentityFenceWitness(ID);
    expect(await check(identity, fence, [grant])).toBe(true);
  });

  it.each([
    { held: 'config', boundary: 'read', changed: 'grant' },
    { held: 'rollout', boundary: 'read', changed: 'grant' },
    { held: 'fence', boundary: 'read', changed: 'grant' },
    { held: 'grant', boundary: 'read', changed: 'config' },
    { held: 'grant', boundary: 'read', changed: 'rollout' },
    { held: 'grant', boundary: 'read', changed: 'fence' },
    { held: 'grant', boundary: 'close', changed: 'rollout' },
    { held: 'grant', boundary: 'close', changed: 'config' },
  ] as const)(
    'rejects $changed changes during $held $boundary in the common grant proof',
    async ({ held, boundary, changed }) => {
      const grant = await privateGrant();
      const fencePath = rebootIdentityFencePath(ID);
      await fs.mkdir(join(root, 'reboot-identities'));
      await fs.writeFile(fencePath, JSON.stringify({ version: 1, switchPending: false }));
      const fence = await captureRebootIdentityFenceWitness(ID);
      const paths = { config, rollout, fence: fencePath, grant: grant.path };
      const gate = hold(paths[held], boundary);
      const result = witness(identity, fence, [grant]);
      await gate.reached.promise;
      if (changed === 'fence') await fs.writeFile(fencePath, JSON.stringify({ version: 1, switchPending: true }));
      else await fs.appendFile(paths[changed], '\n');
      gate.release.resolve();
      expect(await result).toBe(false);
      await gate.closed.promise;
    }
  );

  it('clones private grant scope before awaiting another domain', async () => {
    const grant = await privateGrant();
    const gate = hold(rollout, 'read');
    const result = witness(identity, undefined, [grant]);
    await gate.reached.promise;
    grant.path = join(root, 'foreign-users.json');
    grant.hash = '0'.repeat(64);
    gate.release.resolve();
    expect(await result).toBe(true);
  });

  it('uses grant hashes in the singleflight scope and keeps the original timeout through late close', async () => {
    const grant = await privateGrant();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const gate = hold(grant.path, 'close');
    const first = witness(identity, undefined, [grant]);
    await gate.reached.promise;
    const same = witness(identity, undefined, [{ ...grant }]);
    const different = witness(identity, undefined, [{ ...grant, hash: '0'.repeat(64) }]);
    await gate.secondOpened.promise;
    expect(gate.opens()).toBe(2);
    expect(await witness(identity, undefined, [{ ...grant, hash: '1'.repeat(64) }])).toBe(false);
    await vi.advanceTimersByTimeAsync(2_001);
    expect(await first).toBe(false);
    expect(await same).toBe(false);
    expect(await different).toBe(false);
    expect(await witness(identity, undefined, [grant])).toBe(false);
    expect(gate.opens()).toBe(2);
    gate.release.resolve();
    await gate.closed.promise;
  });

  it.each(['hash', 'size', 'bound', 'count', 'malformed'] as const)(
    'refuses invalid private grant proof %s',
    async (kind) => {
      const grant = await privateGrant();
      const files =
        kind === 'count'
          ? Array(9).fill(grant)
          : kind === 'malformed'
            ? [undefined]
            : [
                {
                  ...grant,
                  ...(kind === 'hash' ? { hash: '0'.repeat(64) } : {}),
                  ...(kind === 'size' ? { size: grant.size + 1 } : {}),
                  ...(kind === 'bound' ? { maxBytes: 2_097_153 } : {}),
                },
              ];
      expect(await witness(identity, undefined, files as readonly PrivateFileWitness[])).toBe(false);
    }
  );

  it('rejects a fence receipt from another session or data domain before any private reads', async () => {
    const receipt = (await captureRebootIdentityFenceWitness(ID))!;
    const open = vi.spyOn(fs, 'open');
    expect(await witness(identity, { ...receipt, sessionId: THREAD })).toBe(false);
    expect(await witness(identity, { ...receipt, dataDir: root + '-other' })).toBe(false);
    expect(await witness(identity, { ...receipt, path: receipt.path + '-other' })).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});
