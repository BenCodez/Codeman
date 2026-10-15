/** @fileoverview Exact startup bytes stay bound across the Node-to-Python handoff; only disposable children run. */
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { CodexInputBroker } from '../src/recovery/codex-input-broker.js';

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const roots: string[] = [];
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await fs.mkdtemp(join(homedir(), 'broker-startup-bytes-'));
  roots.push(root);
  const started = join(root, 'expected-child'),
    wrong = join(root, 'wrong-child');
  const broker = await CodexInputBroker.create(join(root, 'control'), SID, `printf expected > ${quote(started)}`, root);
  const path = join(broker.directory, 'config.json');
  return { root, broker, path, started, wrong };
}
async function run(broker: CodexInputBroker, root: string, expected?: string) {
  const child = spawn(
    'python3',
    [join(broker.directory, 'broker.py'), broker.directory, ...(expected === undefined ? [] : [expected])],
    {
      env: { ...process.env, CODEX_HOME: root },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  child.stdout.resume();
  child.stderr.resume();
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { code, pid: child.pid! };
}
it.each(['command', 'secret', 'startup-owner', 'runtime-authority', 'whitespace'] as const)(
  'does not fork when %s changes after the final app authority check',
  async (change) => {
    const { root, broker, path, started, wrong } = await setup();
    if (change === 'runtime-authority')
      await broker.setStartupAuthority([], undefined, [], [], Number(process.hrtime.bigint() / 1_000_000n) - 1);
    const bytes = await fs.readFile(path),
      expected = digest(bytes);
    const config = JSON.parse(bytes.toString());
    if (change === 'command') {
      config.command = `printf wrong > ${quote(wrong)}`;
      config.launchDigest = digest(config.command);
    }
    if (change === 'secret') config.secret = 'ab'.repeat(32);
    if (change === 'startup-owner') {
      config.sessionId = randomUUID();
      config.incarnation = randomUUID();
      config.startup.nonce = randomUUID();
    }
    if (change === 'runtime-authority') config.startup.monotonicDeadline = null;
    await fs.writeFile(path, JSON.stringify(config, null, change === 'whitespace' ? 2 : undefined), { mode: 0o600 });
    const result = await run(broker, root, expected);
    expect(result.code).toBe(1);
    await expect(fs.stat(started)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(wrong)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await broker.readState()).toBeUndefined();
    if (change === 'command') expect(await broker.startupReceipt(result.pid)).toBe('unknown');
  }
);
it.each([undefined, '', 'not-a-digest', 'a'.repeat(63), 'A'.repeat(64), '0'.repeat(64)])(
  'requires the exact canonical startup digest (%s)',
  async (expected) => {
    const { broker, root, started } = await setup();
    expect((await run(broker, root, expected)).code).toBe(1);
    await expect(fs.stat(started)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await broker.readState()).toBeUndefined();
  }
);
it.each([false, true])('accepts the exact current ordinary/guarded config (%s guarded)', async (guarded) => {
  const { broker, root, path, started } = await setup();
  if (guarded) await broker.setStartupAuthority();
  const expected = digest(await fs.readFile(path));
  expect(broker.configurationDigest).toBe(expected);
  expect((await run(broker, root, expected)).code).toBe(0);
  expect(await fs.readFile(started, 'utf8')).toBe('expected');
  expect(await broker.readState()).toMatchObject({ childPid: expect.any(Number), startup: { status: 'started' } });
});

it('retains the digest of exact loaded bytes rather than their JSON reserialization', async () => {
  const { broker, root, path } = await setup();
  expect((await run(broker, root, broker.configurationDigest)).code).toBe(0);
  const config = JSON.parse((await fs.readFile(path)).toString());
  const serialized = JSON.stringify(config, null, 2) + '\n';
  await fs.writeFile(path, serialized, { mode: 0o600 });
  const loaded = await CodexInputBroker.load(broker.directory, SID);
  expect(loaded?.configurationDigest).toBe(digest(serialized));
  expect(loaded?.configurationDigest).not.toBe(broker.configurationDigest);
});
