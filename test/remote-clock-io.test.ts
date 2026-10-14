/** Shared SSH admission and native clock provenance; exec is exclusively an injected fixture. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionRemote } from '../src/types.js';
import { sampleRemoteCodexClock } from '../src/recovery/remote-clock.js';
import {
  deliverRemoteCodexInput,
  inspectRemoteCodex,
  restartRemoteCodexPane,
  restoreRemoteCodexWorker,
} from '../src/recovery/remote-codex.js';
import { getRemoteSshLimit, getQueuedRemoteSshCount, runWithRemoteSshLimit } from '../src/remote-ssh-limiter.js';
import { createDeferred } from './mocks/index.js';

const fixture = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const exec = () => {
    throw new Error('Unmocked child execution is forbidden');
  };
  Object.defineProperty(exec, Symbol.for('nodejs.util.promisify.custom'), { value: fixture.exec });
  return { ...actual, exec };
});

const THREAD = '11111111-2222-3333-4444-555555555555';
const remote: SessionRemote = {
  hostId: 'fixture',
  label: 'Fixture',
  host: 'worker.invalid',
  username: 'fixture',
  remotePath: '/fixture/work',
  owned: true,
};
const hash = 'a'.repeat(64);
function request(offset = 60_000) {
  const at = Date.now() - 100;
  return {
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    workingDir: remote.remotePath,
    codexHome: '/fixture/codex',
    resumeId: THREAD,
    submission: {
      at,
      hash,
      clockDomain: 'local' as const,
      clock: { localBefore: at, localAfter: at, remoteBefore: at + offset, remoteAfter: at + offset },
    },
    expected: { conversationId: THREAD, tailHash: hash, paneId: '%7', panePid: 700, screenHash: hash },
    expectedIdentity: { conversationId: THREAD, tailHash: hash },
    expectedPane: { paneId: '%7', panePid: 700, status: 1 },
    codexConfig: { noDaemon: true, resumeSessionId: THREAD },
    prompt: 'Fixture continuation',
  };
}
function response(offset: number, action = 'sent', actionAt?: number) {
  const at = Date.now() + offset;
  const value = {
    v: 1,
    session: 'present',
    action,
    ...(action === 'sent' ? { actionAt: actionAt ?? at } : {}),
    pane: { dead: false, paneId: '%7', panePid: 700, screen: Buffer.from('›\n').toString('base64') },
    identity: {
      reason: 'verified',
      conversationId: THREAD,
      tail: Buffer.from('{}\n').toString('base64'),
      tailTruncated: false,
      changedAt: at,
    },
    clock: { remoteBefore: at, remoteAfter: at },
  };
  return { stdout: `CODEMAN_REMOTE_CODEX_V1:${Buffer.from(JSON.stringify(value)).toString('base64')}\n` };
}
function validExec(offset = 60_000) {
  fixture.exec.mockImplementation(async (command: string) =>
    command.includes('CODEMAN_REMOTE_CLOCK_V1')
      ? { stdout: `CODEMAN_REMOTE_CLOCK_V1:${JSON.stringify({ at: Date.now() + offset })}\n` }
      : response(offset)
  );
}
let vitest: string | undefined;
beforeEach(() => {
  vitest = process.env.VITEST;
  delete process.env.VITEST;
  fixture.exec.mockReset();
  validExec();
});
afterEach(() => {
  if (vitest === undefined) delete process.env.VITEST;
  else process.env.VITEST = vitest;
});

describe('shared queued SSH mutations', () => {
  const mutations = {
    input: deliverRemoteCodexInput,
    restart: restartRemoteCodexPane,
    restore: restoreRemoteCodexWorker,
  };
  it.each(['input', 'restart', 'restore'] as const)(
    'rechecks %s authority after the shared slot and certifies no child started',
    async (kind) => {
      const release = createDeferred<void>();
      const holding = Array.from({ length: getRemoteSshLimit() }, () => runWithRemoteSshLimit(() => release.promise));
      let current = true;
      const authority = vi.fn(() => current);
      const pending = mutations[kind](remote, request(), authority);
      await vi.waitFor(() => expect(getQueuedRemoteSshCount()).toBe(1));
      expect(fixture.exec).not.toHaveBeenCalled();
      current = false;
      release.resolve();
      await Promise.all(holding);
      expect(await pending).toEqual(kind === 'input' ? { status: 'not-sent' } : 'not-sent');
      expect(authority).toHaveBeenCalledOnce();
      expect(fixture.exec).not.toHaveBeenCalled();
    }
  );
  it.each(['input', 'restart', 'restore'] as const)(
    'uses a separate synchronous token after the %s async final grant await',
    async (kind) => {
      let current = true;
      let checks = 0;
      const check = async () => {
        if (++checks === 2)
          queueMicrotask(() => {
            current = false;
          });
        return true;
      };
      expect(await mutations[kind](remote, request(), { check, isCurrent: () => current })).toEqual(
        kind === 'input' ? { status: 'not-sent' } : 'not-sent'
      );
      expect(fixture.exec).toHaveBeenCalledOnce();
      expect(fixture.exec.mock.calls[0][0]).toContain('CODEMAN_REMOTE_CLOCK_V1');
    }
  );
  it('refuses a Promise-returning bare authority callback without a synchronous final token', async () => {
    expect(await deliverRemoteCodexInput(remote, request(), (async () => true) as never)).toEqual({
      status: 'not-sent',
    });
    expect(fixture.exec).not.toHaveBeenCalled();
  });
  it.each(['input', 'restart', 'restore'] as const)(
    'rechecks %s current grants after the clock probe',
    async (kind) => {
      const authority = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
      expect(await mutations[kind](remote, request(), { check: authority, isCurrent: () => true })).toEqual(
        kind === 'input' ? { status: 'not-sent' } : 'not-sent'
      );
      expect(fixture.exec).toHaveBeenCalledOnce();
      expect(fixture.exec.mock.calls[0][0]).toContain('CODEMAN_REMOTE_CLOCK_V1');
    }
  );
  it.each([-60_000, 60_000])('retains native actual Enter receipt with %i ms skew', async (offset) => {
    validExec(offset);
    const result = await deliverRemoteCodexInput(remote, request(offset), () => true);
    expect(result).toMatchObject({ status: 'sent' });
    if (result.status === 'sent') {
      expect(result.submittedAt).toBeGreaterThanOrEqual(result.clock!.remoteBefore);
      expect(result.submittedAt).toBeLessThanOrEqual(result.clock!.remoteAfter);
      expect(result.clock!.remoteAfter - result.clock!.localAfter).toBeCloseTo(offset, -2);
    }
    expect(fixture.exec).toHaveBeenCalledTimes(2);
  });
  it('refuses changed clock and legacy untagged proof before a mutation child', async () => {
    expect(await deliverRemoteCodexInput(remote, request(-60_000))).toEqual({ status: 'not-sent' });
    const legacy = request();
    delete (legacy.submission as { clock?: unknown }).clock;
    expect(await deliverRemoteCodexInput(remote, legacy)).toEqual({ status: 'not-sent' });
    expect(fixture.exec).toHaveBeenCalledTimes(2);
    expect(fixture.exec.mock.calls.every(([command]) => command.includes('CODEMAN_REMOTE_CLOCK_V1'))).toBe(true);
  });
  it.each(['missing-resume', 'different-resume', 'different-identity', 'daemon', 'missing-home'] as const)(
    'refuses an incomplete exact restart configuration before any SSH child: %s',
    async (fault) => {
      const configured = request();
      if (fault === 'missing-resume') Reflect.deleteProperty(configured.codexConfig, 'resumeSessionId');
      if (fault === 'different-resume') configured.codexConfig.resumeSessionId = '22222222-2222-4222-8222-222222222222';
      if (fault === 'different-identity')
        configured.expectedIdentity.conversationId = '22222222-2222-4222-8222-222222222222';
      if (fault === 'daemon') configured.codexConfig.noDaemon = false;
      if (fault === 'missing-home') Reflect.deleteProperty(configured, 'codexHome');
      expect(await restartRemoteCodexPane(remote, configured)).toBe('not-sent');
      expect(fixture.exec).not.toHaveBeenCalled();
    }
  );
  it('seals uncertain delivery when a started mutation fails or returns an out-of-bound receipt', async () => {
    const sample = fixture.exec.getMockImplementation()!;
    fixture.exec.mockImplementation(async (command: string) => {
      if (command.includes('CODEMAN_REMOTE_CLOCK_V1')) return sample(command);
      throw new Error('Fixture child failed after bytes may have landed');
    });
    expect(await deliverRemoteCodexInput(remote, request())).toEqual({ status: 'unknown' });
    fixture.exec.mockImplementation(async (command: string) =>
      command.includes('CODEMAN_REMOTE_CLOCK_V1')
        ? sample(command)
        : response(60_000, 'sent', Date.now() + 60_000 - 10_000)
    );
    expect(await deliverRemoteCodexInput(remote, request())).toEqual({ status: 'unknown' });
  });
});

describe('clock sample transport separation', () => {
  it.each([-60_000, 60_000])(
    'normalizes verified remote mtime while retaining native clock with %i ms skew',
    async (offset) => {
      validExec(offset);
      const evidence = await inspectRemoteCodex(remote, request(offset));
      expect(evidence).toMatchObject({ transport: 'reachable', session: 'present', identity: { reason: 'verified' } });
      if (evidence.transport === 'reachable' && evidence.session !== 'unknown') {
        expect(evidence.identity.changedAt).toBeLessThanOrEqual(Date.now());
        expect(evidence.identity.changedAt).toBeGreaterThan(Date.now() - 1000);
        expect(evidence.clock!.remoteAfter - evidence.clock!.localAfter).toBeCloseTo(offset, -2);
      }
    }
  );
  it('reports failed SSH transport but malformed successful clock output as reachable uncertainty', async () => {
    fixture.exec.mockRejectedValue({ code: 255, stderr: 'ssh: connect to host worker.invalid: Connection refused' });
    expect(await inspectRemoteCodex(remote, request())).toMatchObject({ transport: 'unreachable', session: 'unknown' });
    expect(await deliverRemoteCodexInput(remote, request())).toEqual({ status: 'not-sent' });
    fixture.exec.mockResolvedValue({ stdout: 'CODEMAN_REMOTE_CLOCK_V1:{broken}\n' });
    expect(await inspectRemoteCodex(remote, request())).toMatchObject({
      transport: 'reachable',
      session: 'unknown',
      identity: { reason: 'unreadable' },
    });
    expect(await deliverRemoteCodexInput(remote, request())).toEqual({ status: 'not-sent' });
  });
  it('executes the generated clock sampling script only through a temporary fake ssh and fake login shell', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'codeman-clock-fake-ssh-'));
    try {
      const ssh = join(temp, 'ssh');
      const shell = join(temp, 'fixture-shell');
      await writeFile(ssh, '#!/bin/sh\nfor arg do last=$arg; done\nexec /bin/sh -c "$last"\n');
      await writeFile(shell, '#!/bin/sh\nfor arg do last=$arg; done\nexec /bin/sh -c "$last"\n');
      await chmod(ssh, 0o700);
      await chmod(shell, 0o700);
      const execFileAsync = promisify(execFile);
      fixture.exec.mockImplementation((command: string) =>
        execFileAsync('/bin/sh', ['-c', command], {
          env: { ...process.env, PATH: `${temp}:${process.env.PATH}`, SHELL: shell },
          timeout: 2000,
          maxBuffer: 4096,
        })
      );
      const clock = await sampleRemoteCodexClock(remote);
      expect(clock).toBeDefined();
      expect(clock!.remoteAfter).toBeGreaterThanOrEqual(clock!.localBefore);
      expect(clock!.remoteAfter).toBeLessThanOrEqual(clock!.localAfter);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
