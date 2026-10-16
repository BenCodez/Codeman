/** @fileoverview Registry-capable reboot workers retain exact CLI-specific broker bindings in temporary data. */
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getCli, reloadCliRegistry } from '../src/config/cli-registry/registry.js';
import { captureRebootBrokerBindings } from '../src/recovery/reboot-launch-witness.js';
import type { SessionState } from '../src/types.js';

const SID = 'fixture-worker';
const CID = '11111111-2222-3333-4444-555555555555';
const INCARNATION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(homedir(), 'reboot-custom-cli-'));
  vi.stubEnv('CODEMAN_DATA_DIR', root);
  const codex = getCli('codex')!;
  await fs.writeFile(
    join(root, 'clis.json'),
    JSON.stringify({
      schemaVersion: 1,
      clis: {
        'fixture-codex': { ...codex, id: 'fixture-codex', label: 'Fixture Codex', order: 990 },
        'other-codex': { ...codex, id: 'other-codex', label: 'Other Codex', order: 991 },
        'unsupported-cli': {
          ...codex,
          id: 'unsupported-cli',
          label: 'Unsupported',
          order: 992,
          capabilities: { ...codex.capabilities, recovery: undefined },
        },
      },
    }),
    { mode: 0o600 }
  );
  reloadCliRegistry();
  expect(getCli('fixture-codex')?.capabilities.recovery).toBe('codex-rollout');
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  reloadCliRegistry();
  await fs.rm(root, { recursive: true, force: true });
});
function state(mode = 'fixture-codex'): SessionState {
  return {
    id: SID,
    mode,
    workingDir: join(root, 'workspace'),
    owner: 'fixture-owner',
    pid: null,
    status: 'idle',
    currentTaskId: null,
    createdAt: 10000,
    codexConfig: { noDaemon: true, resumeSessionId: CID, sandbox: 'read-only' },
    __codexRecoveryHome: join(root, 'codex-home'),
    __codexInputBroker: INCARNATION,
  } as SessionState;
}
async function writeRow(saved: SessionState, patch: Record<string, unknown> = {}) {
  await fs.writeFile(
    join(root, 'mux-sessions.json'),
    JSON.stringify([
      {
        sessionId: SID,
        mode: saved.mode,
        owner: saved.owner,
        workingDir: saved.workingDir,
        recoveryCodexHome: join(root, 'codex-home'),
        codexRestoreConfig: saved.codexConfig,
        recoveryInputBroker: INCARNATION,
        ...patch,
      },
    ])
  );
}
it.each(['codex', 'fixture-codex'])('retains the exact historical broker for capable CLI %s', async (mode) => {
  const saved = state(mode);
  await writeRow(saved);
  expect(await captureRebootBrokerBindings({ [SID]: saved })).toEqual(new Map([[SID, INCARNATION]]));
});
it('retains a custom CLI pinned broker when its mux row has been pruned', async () => {
  const saved = state();
  await fs.writeFile(join(root, 'mux-sessions.json'), '[]');
  expect(await captureRebootBrokerBindings({ [SID]: saved })).toEqual(new Map([[SID, INCARNATION]]));
});
it.each([
  { mode: 'codex' },
  { mode: 'other-codex' },
  { mode: 'unsupported-cli' },
  { owner: 'different-owner' },
  { workingDir: '/fixture/different-workspace' },
  { recoveryCodexHome: '/fixture/different-home' },
  { codexRestoreConfig: { noDaemon: true, resumeSessionId: CID, sandbox: 'workspace-write' } },
])('refuses a custom CLI historical row with a mismatching identity/config: %j', async (patch) => {
  const saved = state();
  await writeRow(saved, patch);
  expect(await captureRebootBrokerBindings({ [SID]: saved })).toEqual(new Map());
});
it.each(['unsupported-cli', 'claude', 'unregistered-cli'])(
  'does not capture Codex brokers for unsupported CLI %s',
  async (mode) => {
    const saved = state(mode);
    await writeRow(saved);
    expect(await captureRebootBrokerBindings({ [SID]: saved })).toEqual(new Map());
  }
);
it('does not share a pending binding proof between two distinct capable CLI identities', async () => {
  const first = state('codex');
  const other = state('other-codex');
  await writeRow(first);
  const open = fs.open.bind(fs);
  let entered!: () => void;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let intercepted = false;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    if (!intercepted && args[0] === join(root, 'mux-sessions.json')) {
      intercepted = true;
      entered();
      await gate;
    }
    return open(...args);
  });
  const firstRead = captureRebootBrokerBindings({ [SID]: first });
  try {
    await held;
    const otherRead = captureRebootBrokerBindings({ [SID]: other });
    release();
    const [matching, mismatched] = await Promise.all([firstRead, otherRead]);
    expect(matching).toEqual(new Map([[SID, INCARNATION]]));
    expect(mismatched).toEqual(new Map());
  } finally {
    release();
    await firstRead;
  }
});
