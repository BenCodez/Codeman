/** Real generated Node reader, disposable Python child and checked fake SSH/tmux only. */
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  buildRemoteCodexEvidenceCommand,
  buildRemoteCodexInputCommand,
  MAX_REMOTE_CODEX_REQUEST_BYTES,
  parseRemoteCodexInputResult,
  type RemoteCodexCommand,
} from '../src/recovery/remote-codex.js';
import { remoteBrokerReaderFixture } from './mocks/remote-broker-reader-fixture.js';

const fixtures: Awaited<ReturnType<typeof remoteBrokerReaderFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
async function fixture() {
  const f = await remoteBrokerReaderFixture();
  fixtures.push(f);
  return f;
}
// Retain the previous string-builder shape only for the causal regression run:
// a successful old request must fail the privacy assertion, not an API-shape check.
function privateRequest(request: RemoteCodexCommand | string): RemoteCodexCommand {
  if (typeof request !== 'string') return request;
  const input = [...request.matchAll(/[A-Za-z0-9+/]{30,}={0,2}/g)]
    .map(([token]) => Buffer.from(token, 'base64').toString('utf8'))
    .find((text) => text.startsWith('{') && text.includes('remoteSessionName'));
  expect(input).toBeDefined();
  return { command: request, input: input! };
}
const prompt = 'Private owner request café 🧭\n  preserve every byte  ';

it('keeps inspection and action DTOs out of shell, SSH and Node arguments', async () => {
  const f = await fixture();
  const argvPath = join(f.root, 'reader-argv.jsonl');
  const preload = join(f.root, 'record-argv.cjs');
  await fs.writeFile(
    preload,
    String.raw`require('fs').appendFileSync(${JSON.stringify(argvPath)},JSON.stringify([...process.execArgv,...process.argv])+'\n');`
  );
  f.env.NODE_OPTIONS = `${f.env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(preload)}`;
  const inspection = buildRemoteCodexEvidenceCommand(f.remote, f.request);
  expect((await f.run(inspection)).failed).toBe(false);
  const q = await f.inputRequest(prompt);
  const action = buildRemoteCodexInputCommand(f.remote, q);
  const sent = await f.run(action);
  expect(parseRemoteCodexInputResult(sent.stdout)?.status).toBe('sent');
  expect(await f.bytes()).toEqual(Buffer.from(prompt + '\r'));
  for (const value of [inspection, action]) {
    const request = privateRequest(value);
    expect(request.command).not.toContain(f.request.sessionId);
    expect(request.command).not.toContain(f.home);
    expect(request.command).not.toContain(prompt);
    expect(request.command).not.toContain(Buffer.from(request.input).toString('base64'));
  }
  expect(JSON.parse(privateRequest(action).input).action.prompt).toBe(prompt);
  const argv = (await fs.readFile(argvPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(argv.length).toBeGreaterThan(0);
  for (const row of argv) {
    expect(JSON.stringify(row)).not.toContain(prompt);
    expect(JSON.stringify(row)).not.toContain(Buffer.from(privateRequest(action).input).toString('base64'));
    expect(JSON.stringify(row)).not.toContain(f.home);
  }
});

it.each(['truncated', 'oversized', 'malformed', 'invalid-utf8'] as const)(
  'refuses %s stdin before inspecting or writing the worker',
  async (kind) => {
    const f = await fixture();
    const q = await f.inputRequest(prompt);
    const request = buildRemoteCodexInputCommand(f.remote, q);
    const before = await f.broker.readState();
    const input =
      kind === 'truncated'
        ? request.input.slice(0, -1)
        : kind === 'oversized'
          ? request.input + ' '.repeat(MAX_REMOTE_CODEX_REQUEST_BYTES)
          : kind === 'invalid-utf8'
            ? Buffer.from([0xff, 0xfe])
            : '{private request';
    const result = await f.run(request.command, input);
    expect(result.failed).toBe(true);
    expect(result.error).not.toContain('Private owner request');
    expect(result.error).not.toContain('{private request');
    expect(parseRemoteCodexInputResult(result.stdout)).toBeUndefined();
    expect(await f.bytes()).toEqual(Buffer.alloc(0));
    expect((await f.broker.readState())?.counters).toEqual(before?.counters);
  }
);

it('bounds serialized stdin before starting a transport while retaining the full prompt cap', async () => {
  const f = await fixture();
  const q = await f.inputRequest(prompt);
  expect(() => buildRemoteCodexInputCommand(f.remote, { ...q, prompt: '\t'.repeat(64 * 1024) })).toThrow(RangeError);
  expect(() =>
    buildRemoteCodexEvidenceCommand(f.remote, { ...f.request, workingDir: 'x'.repeat(MAX_REMOTE_CODEX_REQUEST_BYTES) })
  ).toThrow(RangeError);
  expect(await f.bytes()).toEqual(Buffer.alloc(0));
});
