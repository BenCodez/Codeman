/** Only inert, temporary entrypoints are executed; no worker or supervisor is started. */
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { supervisorManagerBridgeCommand } from '../src/supervisor/manager-bridge-command.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.each(['js', 'ts'])('executes the exact %s entrypoint with an empty PATH and an unrelated cwd', async (extension) => {
  const root = await mkdtemp(join(homedir(), 'manager bridge '));
  roots.push(root);
  const tree = join(root, 'checkout space'),
    cwd = join(root, 'other'),
    entrypoint = join(tree, `index.${extension}`),
    module = join(tree, 'supervisor', `manager-bridge-command.${extension}`);
  await mkdir(dirname(module), { recursive: true });
  await mkdir(cwd);
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(
    entrypoint,
    `${extension === 'ts' ? 'const marker: string = "inert-bridge";' : 'const marker = "inert-bridge";'}
process.stdout.write(JSON.stringify({marker, args: process.argv.slice(2)}));`
  );
  const bridge = supervisorManagerBridgeCommand(pathToFileURL(module).href);
  expect(bridge.command).toBe(process.execPath);
  expect(bridge.args).toContain(entrypoint);
  expect(bridge.args.every((arg) => arg !== 'codeman')).toBe(true);
  if (extension === 'ts') {
    expect(bridge.args[0]).toBe('--import');
    expect(isAbsolute(bridge.args[1])).toBe(true);
  } else expect(bridge.args).toEqual([entrypoint, 'agent', 'supervisor-mcp']);
  const { stdout } = await promisify(execFile)(
    bridge.command,
    [...bridge.args, '--credential-file', join(root, 'fake credential.json')],
    { cwd, env: { PATH: '', HOME: root }, timeout: 10_000 }
  );
  expect(JSON.parse(stdout)).toEqual({
    marker: 'inert-bridge',
    args: ['agent', 'supervisor-mcp', '--credential-file', join(root, 'fake credential.json')],
  });
});

it('never falls back to a PATH command when its exact entrypoint is missing', async () => {
  const root = await mkdtemp(join(homedir(), 'manager-bridge-missing-'));
  roots.push(root);
  const bridge = supervisorManagerBridgeCommand(pathToFileURL(join(root, 'supervisor', 'bridge.js')).href);
  await expect(
    promisify(execFile)(bridge.command, bridge.args, { cwd: root, env: { PATH: '', HOME: root }, timeout: 10_000 })
  ).rejects.toMatchObject({ code: 1 });
});
