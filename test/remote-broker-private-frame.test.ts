import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { remoteBrokerReaderFixture } from './mocks/remote-broker-reader-fixture.js';
import {
  buildRemoteCodexInputCommand,
  deliverRemoteCodexInput,
  parseRemoteCodexInputResult,
} from '../src/recovery/remote-codex.js';

const fixtures: Awaited<ReturnType<typeof remoteBrokerReaderFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture() {
  const f = await remoteBrokerReaderFixture();
  fixtures.push(f);
  f.env.PRIVATE_ARGV_LOG = join(f.root, 'private-argv');
  return f;
}
async function buffers(f: Awaited<ReturnType<typeof fixture>>) {
  return (await fs.readdir(f.root)).filter((name) => /^effects\.buffer-codeman-private-/.test(name));
}
async function commands(f: Awaited<ReturnType<typeof fixture>>): Promise<string[][]> {
  return (await fs.readFile(f.env.PRIVATE_ARGV_LOG!, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

it('carries actual signed Unicode/newline frames only through stdin and pastes each exactly once', async () => {
  const f = await fixture();
  const prompt = "Private objective: 'quoted' 😀\nsecond line";
  const result = await f.input(prompt);
  expect(result.result).toMatchObject({ status: 'sent' });
  expect(await f.bytes()).toEqual(Buffer.from(prompt + '\r'));
  const argv = await commands(f);
  const config = JSON.parse(await fs.readFile(join(f.descriptor.directory, 'config.json'), 'utf8'));
  const text = JSON.stringify(argv);
  for (const sensitive of [prompt, Buffer.from(prompt).toString('base64'), config.secret, 'CODEMAN_INPUT_V1:'])
    expect(text.includes(sensitive)).toBe(false);
  expect(argv.some((args) => args[2] === 'send-keys')).toBe(false);
  const loads = argv.filter((args) => args[2] === 'load-buffer');
  expect(loads.length).toBeGreaterThanOrEqual(3);
  expect(new Set(loads.map((args) => args[4])).size).toBe(loads.length);
  for (const args of loads) expect(args.slice(3)).toEqual(['-b', expect.stringMatching(/^codeman-private-/), '-']);
  const stdin = (await fs.readFile(f.env.PRIVATE_ARGV_LOG! + '.stdin', 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(stdin.filter((entry) => entry.channel === 'auto').map((entry) => entry.counter)).toEqual([1, 2]);
  expect((await f.broker.readState())?.receipts.filter((r) => r.channel === 'auto').map((r) => r.status)).toEqual([
    'sent',
    'sent',
  ]);
  expect(await buffers(f)).toEqual([]);
});

it.each(['native', 'witness', 'load-ack', 'composer'] as const)(
  'retains zero child bytes and removes its own buffer after %s refusal',
  async (fault) => {
    const f = await fixture();
    const q = await f.inputRequest('must not arrive');
    const unrelated = join(f.root, 'effects.buffer-codeman-private-11111111-2222-3333-4444-555555555555');
    await fs.writeFile(unrelated, 'unrelated private buffer');
    f.env.PRIVATE_BUFFER_FAULT = fault;
    const result = await f.run(buildRemoteCodexInputCommand(f.remote, q));
    expect(parseRemoteCodexInputResult(result.stdout)?.status).not.toBe('sent');
    if (fault === 'native') expect(parseRemoteCodexInputResult(result.stdout)).toEqual({ status: 'not-sent' });
    expect(await f.bytes()).toEqual(Buffer.alloc(0));
    expect((await f.broker.readState())?.counters.auto).toBe(0);
    expect(await buffers(f)).toEqual([unrelated.slice(f.root.length + 1)]);
    expect(await fs.readFile(unrelated, 'utf8')).toBe('unrelated private buffer');
  }
);

it('seals a lost paste acknowledgement without Enter, raw fallback or replay', async () => {
  const f = await fixture();
  const prompt = 'private one-shot';
  const q = await f.inputRequest(prompt);
  f.env.PRIVATE_BUFFER_FAULT = 'paste-ack';
  const command = buildRemoteCodexInputCommand(f.remote, q);
  const result = await deliverRemoteCodexInput(f.remote, q, undefined, f.options);
  expect(result.status).toBe('unknown');
  // The fake native effect forwards the real frame before losing its reply.
  const until = performance.now() + 3000;
  while (
    !(await f.broker.readState())?.receipts.some(
      (r) => r.channel === 'auto' && r.counter === 1 && r.status === 'sent'
    ) ||
    !(await f.bytes()).equals(Buffer.from(prompt))
  ) {
    if (performance.now() >= until) throw Error('Actual frame delivery was not published');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  delete f.env.PRIVATE_BUFFER_FAULT;
  const replay = await f.run(command);
  expect(parseRemoteCodexInputResult(replay.stdout)?.status).not.toBe('sent');
  expect(await f.bytes()).toEqual(Buffer.from(prompt));
  expect((await f.broker.readState())?.counters.auto).toBe(1);
  expect(await buffers(f)).toEqual([]);
});

it('rechecks the known literal composer after loading Enter without submitting a new owner draft', async () => {
  const f = await fixture();
  const prompt = 'already pasted private text';
  const q = await f.inputRequest(prompt);
  f.env.PRIVATE_BUFFER_FAULT = 'composer-enter';
  const result = await deliverRemoteCodexInput(f.remote, q, undefined, f.options);
  expect(result.status).toBe('unknown');
  expect(await f.bytes()).toEqual(Buffer.from(prompt));
  expect((await f.broker.readState())?.counters.auto).toBe(1);
  expect(await buffers(f)).toEqual([]);
});

it('retires its private buffer after the original action deadline without pasting expired bytes', async () => {
  const f = await fixture();
  const q = await f.inputRequest('expired private bytes');
  f.env.PRIVATE_BUFFER_FAULT = 'expired-load';
  // Expire before the independent 1500ms native-process cap, so the original
  // signed action deadline is the cause of cancellation and cleanup.
  const deadline = Date.now() + 1000;
  const result = await deliverRemoteCodexInput(
    f.remote,
    q,
    {
      check: async () => true,
      isCurrent: () => true,
      getActionDeadline: () => deadline,
    },
    f.options
  );
  expect(result.status).toBe('unknown');
  const stage = JSON.parse(await fs.readFile(f.env.PRIVATE_ARGV_LOG! + '.expiry', 'utf8'));
  expect(stage.before).toBeLessThan(stage.deadline);
  expect(Number(process.hrtime.bigint() / 1000000n)).toBeGreaterThanOrEqual(stage.deadline);
  const loads = (await fs.readFile(f.env.PRIVATE_ARGV_LOG! + '.stdin', 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const automatic = loads.filter((entry) => entry.channel === 'auto');
  expect(automatic).toHaveLength(1);
  expect((await commands(f)).some((args) => args[2] === 'if-shell' && args[7].includes(automatic[0].name))).toBe(false);
  expect(await f.bytes()).toEqual(Buffer.alloc(0));
  expect((await f.broker.readState())?.counters.auto).toBe(0);
  expect(await buffers(f)).toEqual([]);
});
