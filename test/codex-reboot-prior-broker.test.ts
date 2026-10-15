/** Historical launch-owned broker proof with disposable Python children and isolated route effects. */
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexInputBroker } from '../src/recovery/codex-input-broker.js';
import {
  planVerifiedRebootRestore,
  verifyCodexRebootEvidence,
  verifyCodexRebootIdentity,
} from '../src/reboot-restore.js';
import {
  captureRebootIdentityFenceWitness,
  captureRebootLaunchWitness,
} from '../src/recovery/reboot-launch-witness.js';
import { registerRebootRestoreRoutes } from '../src/web/routes/reboot-restore-routes.js';
import { rebootRestoreRegistry } from '../src/web/reboot-restore-registry.js';
import { writeRebootIdentityFence, rebootIdentityFencePath } from '../src/recovery/reboot-identity-fence.js';
import { StateStore } from '../src/state-store.js';
import { WebServer } from '../src/web/server.js';
import { TmuxManager } from '../src/tmux-manager.js';
import type { SessionState } from '../src/types.js';

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CID = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-2222-3333-4444-555555555555';
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
const previousData = process.env.CODEMAN_DATA_DIR;
const fixtures: Array<{ root: string; child: ChildProcessWithoutNullStreams; done: Promise<number | null> }> = [];
const servers: WebServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  rebootRestoreRegistry.reset();
  for (const { root, child, done } of fixtures.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) await fs.writeFile(join(root, 'stop'), 'stop');
    await Promise.race([
      done,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Disposable child did not exit')), 3_000)),
    ]);
    await fs.rm(root, { recursive: true, force: true });
  }
  if (previousData === undefined) delete process.env.CODEMAN_DATA_DIR;
  else process.env.CODEMAN_DATA_DIR = previousData;
  vi.restoreAllMocks();
});

async function fixture(raw = false, exitStatus = 1) {
  const root = await fs.mkdtemp(join(homedir(), 'reboot-prior-broker-'));
  process.env.CODEMAN_DATA_DIR = root;
  const home = join(root, 'home'),
    work = join(root, 'work');
  await fs.mkdir(join(home, 'sessions'), { recursive: true });
  await fs.mkdir(work);
  await fs.writeFile(
    join(home, 'sessions', `rollout-2026-10-14T12-00-00-${CID}.jsonl`),
    JSON.stringify({
      type: 'session_meta',
      timestamp: new Date().toISOString(),
      payload: { id: CID, cwd: work, originator: `codeman_${SID}` },
    }) + '\n'
  );
  const script = join(root, 'fake.py');
  await fs.writeFile(
    script,
    `import os, select, sys, tty, termios\ntty.setraw(0, termios.TCSANOW)\nwhile not os.path.exists(${JSON.stringify(join(root, 'stop'))}):\n if select.select([0], [], [], .01)[0]: os.read(0, 65536)\nsys.exit(${exitStatus})\n`
  );
  const broker = await CodexInputBroker.create(
    join(root, 'codex-input-brokers', SID),
    SID,
    `exec python3 ${quote(script)}`,
    home,
    root
  );
  const child = spawn('python3', [join(broker.directory, 'broker.py'), broker.directory, broker.configurationDigest], {
    env: { ...process.env, CODEX_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  child.stderr.resume();
  const done = new Promise<number | null>((resolve) => child.once('close', resolve));
  fixtures.push({ root, child, done });
  expect(await broker.startupReceipt(child.pid!)).toBe('started');
  if (raw) {
    child.stdin.write(`/resume ${OTHER}\r`);
    await vi.waitFor(async () => expect((await broker.readState())?.tainted).toBe(true));
  }
  await fs.writeFile(join(root, 'stop'), 'stop');
  await done;
  const state: SessionState = {
    id: SID,
    pid: child.pid!,
    status: 'busy',
    mode: 'codex',
    workingDir: work,
    createdAt: Date.now() - 60_000,
    currentTaskId: null,
    codexConfig: { noDaemon: true, resumeSessionId: CID },
  };
  Object.assign(state, { __codexRecoveryHome: home, __envOverrides: { CODEX_HOME: home } });
  await fs.writeFile(
    join(root, 'mux-sessions.json'),
    JSON.stringify([
      {
        sessionId: SID,
        muxName: 'codeman-aaaaaaaa',
        pid: child.pid,
        createdAt: state.createdAt,
        mode: 'codex',
        workingDir: work,
        recoveryCodexHome: home,
        recoveryIsolated: true,
        recoveryInputBroker: broker.incarnation,
        codexRestoreConfig: state.codexConfig,
      },
    ])
  );
  const journal = join(broker.directory, 'state.json'),
    config = join(broker.directory, 'config.json');
  return { root, home, work, state, broker, journal, config };
}
async function damage(path: string, kind: string) {
  const value = JSON.parse(await fs.readFile(path, 'utf8'));
  if (kind === 'missing') return fs.unlink(path);
  if (kind === 'malformed') return fs.writeFile(path, '{truncated');
  if (kind === 'reserved') {
    value.counters.auto++;
    value.receipts.push({
      channel: 'auto',
      counter: value.counters.auto,
      nonce: randomUUID(),
      conversationId: CID,
      hash: createHash('sha256').update('possibly partial').digest('hex'),
      status: 'reserved',
    });
  }
  if (kind === 'unknown-counter') value.counters['owner-pty']++;
  if (kind === 'bool-version') value.version = true;
  if (kind === 'tainted') {
    value.tainted = true;
    value.rawGeneration = 1;
  }
  if (kind === 'replaced') {
    await fs.writeFile(`${path}.replacement`, JSON.stringify(value), { mode: 0o600 });
    return fs.rename(`${path}.replacement`, path);
  }
  await fs.writeFile(path, JSON.stringify(value));
}

it.each(['healthy', 'raw-resume', 'missing', 'malformed', 'reserved', 'unknown-counter', 'bool-version'])(
  'boot verification and offering require the prior actual broker journal: %s',
  async (kind) => {
    const { state, journal, broker } = await fixture(kind === 'raw-resume');
    if (!['healthy', 'raw-resume'].includes(kind)) await damage(journal, kind);
    expect(await verifyCodexRebootIdentity(state)).toBe(kind === 'healthy' ? CID : undefined);
    const plan = await planVerifiedRebootRestore([SID], { [SID]: state }, () => true);
    if (kind === 'healthy') {
      expect(plan.skipped).toEqual([]);
      expect(plan.restore[0].state).toMatchObject({
        __codexPriorInputBroker: broker.incarnation,
        __codexPriorInputEvidence: {
          files: [
            expect.objectContaining({ path: expect.stringContaining('config.json') }),
            expect.objectContaining({ path: journal }),
          ],
        },
      });
      expect(state).not.toHaveProperty('__codexPriorInputBroker');
    } else expect(plan.restore).toEqual([]);
  }
);

it.each(['missing', 'malformed', 'bool-version'])(
  'known private config %s never becomes legacy restoration',
  async (kind) => {
    const { state, config } = await fixture();
    await damage(config, kind);
    expect(await verifyCodexRebootIdentity(state)).toBeUndefined();
  }
);
it.each([
  'known-state',
  'legacy-null-upgrade',
  'mismatch',
  'malformed-known',
  'lost-binding',
  'uncertain-mux',
  'pending-incarnation',
  'missing-config',
  'known-missing-config',
  'different-config',
  'different-resume',
  'original-no-resume',
])('binds persisted state and MUX without selecting a latest incarnation: %s', async (kind) => {
  const { state, root, broker } = await fixture();
  if (kind === 'known-state') {
    Object.assign(state, { __codexInputBroker: broker.incarnation });
    await fs.unlink(join(root, 'mux-sessions.json'));
  }
  if (kind === 'legacy-null-upgrade') Object.assign(state, { __codexInputBroker: null });
  if (kind === 'mismatch') Object.assign(state, { __codexInputBroker: OTHER });
  if (kind === 'malformed-known') Object.assign(state, { __codexInputBroker: false });
  if (kind === 'lost-binding') await fs.writeFile(join(root, 'mux-sessions.json'), '[]');
  if (kind === 'uncertain-mux' || kind === 'pending-incarnation') {
    const rows = JSON.parse(await fs.readFile(join(root, 'mux-sessions.json'), 'utf8'));
    if (kind === 'uncertain-mux') rows[0].codexRestoreUncertain = true;
    else rows[0].recoveryInputBrokerPending = OTHER;
    await fs.writeFile(join(root, 'mux-sessions.json'), JSON.stringify(rows));
  }
  if (
    ['missing-config', 'known-missing-config', 'different-config', 'different-resume', 'original-no-resume'].includes(
      kind
    )
  ) {
    const rows = JSON.parse(await fs.readFile(join(root, 'mux-sessions.json'), 'utf8'));
    if (kind === 'missing-config' || kind === 'known-missing-config') delete rows[0].codexRestoreConfig;
    if (kind === 'known-missing-config') Object.assign(state, { __codexInputBroker: broker.incarnation });
    if (kind === 'different-config') rows[0].codexRestoreConfig.model = 'other-model';
    if (kind === 'different-resume') rows[0].codexRestoreConfig.resumeSessionId = OTHER;
    if (kind === 'original-no-resume') delete rows[0].codexRestoreConfig.resumeSessionId;
    await fs.writeFile(join(root, 'mux-sessions.json'), JSON.stringify(rows));
  }
  expect(await verifyCodexRebootIdentity(state)).toBe(
    ['known-state', 'legacy-null-upgrade', 'known-missing-config', 'original-no-resume'].includes(kind)
      ? CID
      : undefined
  );
});

it.each([false, true])(
  'newer launch-origin identity vetoes an older saved pin despite a stale completed fence (%s new B)',
  async (newer) => {
    const { state, root, home, work } = await fixture();
    const now = Date.now();
    await writeRebootIdentityFence(SID, { switchPending: false, resumeSessionId: CID });
    const fenceAt = newer ? now - 10_000 : now;
    await fs.utimes(rebootIdentityFencePath(SID), fenceAt / 1_000, fenceAt / 1_000);
    const metadata = (id: string, at: number) =>
      JSON.stringify({
        type: 'session_meta',
        timestamp: new Date(at).toISOString(),
        payload: { id, cwd: work, originator: `codeman_${SID}` },
      }) + '\n';
    await fs.writeFile(
      join(home, 'sessions', `rollout-2026-10-14T12-00-00-${CID}.jsonl`),
      metadata(CID, newer ? now - 20_000 : now - 500)
    );
    if (newer)
      await fs.writeFile(
        join(home, 'sessions', `rollout-2026-10-14T12-00-01-${OTHER}.jsonl`),
        metadata(OTHER, now - 1_000)
      );
    Object.assign(state, { __codexInputBroker: null });
    const rows = JSON.parse(await fs.readFile(join(root, 'mux-sessions.json'), 'utf8'));
    delete rows[0].codexRestoreConfig.resumeSessionId;
    rows[0].createdAt = now - 1_000;
    await fs.writeFile(join(root, 'mux-sessions.json'), JSON.stringify(rows));
    const fenceModified = (await fs.stat(rebootIdentityFencePath(SID))).mtimeMs;
    if (newer) expect(fenceModified).toBeLessThan(rows[0].createdAt);
    else expect(fenceModified).toBeGreaterThan(rows[0].createdAt);
    expect(await verifyCodexRebootIdentity(state)).toBe(newer ? undefined : CID);
    expect((await planVerifiedRebootRestore([SID], { [SID]: state }, () => true)).restore).toHaveLength(newer ? 0 : 1);
  }
);

it.each([
  'healthy',
  'tainted',
  'missing',
  'malformed',
  'reserved',
  'replaced',
  'pending-incarnation',
  'new-incarnation',
  'legacy-pruned-new-broker',
  'legacy-missing-mux-new-broker',
])('the actual HTTP click retains the parked journal snapshot: %s', async (kind) => {
  const { state, root, journal, broker } = await fixture();
  const legacy = kind.startsWith('legacy-');
  const sidDirectory = join(root, 'codex-input-brokers', SID);
  if (legacy) {
    await fs.rename(sidDirectory, join(root, 'parked-broker'));
    await fs.writeFile(join(root, 'mux-sessions.json'), '[]');
  }
  const plan = await planVerifiedRebootRestore([SID], { [SID]: state }, () => true);
  if (legacy) {
    expect(plan.restore[0].state).toMatchObject({ __codexPriorInputBroker: null });
    await fs.rename(join(root, 'parked-broker'), sidDirectory);
    expect(broker.directory).toContain(sidDirectory);
    if (kind === 'legacy-missing-mux-new-broker') await fs.unlink(join(root, 'mux-sessions.json'));
  }
  expect(plan.restore).toHaveLength(1);
  await rebootRestoreRegistry.set(plan.restore);
  if (kind === 'pending-incarnation' || kind === 'new-incarnation') {
    const rows = JSON.parse(await fs.readFile(join(root, 'mux-sessions.json'), 'utf8'));
    if (kind === 'pending-incarnation') rows[0].recoveryInputBrokerPending = OTHER;
    else rows[0].recoveryInputBroker = OTHER;
    await fs.writeFile(join(root, 'mux-sessions.json'), JSON.stringify(rows));
  } else if (kind !== 'healthy' && !legacy) await damage(journal, kind);
  vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);
  const server = new WebServer(0, false, true);
  servers.push(server);
  Reflect.set(server, 'store', new StateStore(join(root, 'state.json')));
  const ctx = Reflect.get(server, 'createRouteContext').call(server) as Parameters<
    typeof registerRebootRestoreRoutes
  >[1];
  ctx.getWorkspaceHooksEnabled = async () => false;
  ctx.getAgentSkillEnabled = async () => false;
  const store = Reflect.get(server, 'store') as import('../src/state-store.js').StateStore;
  store.setSession(SID, state);
  store.flush();
  const historical = structuredClone(store.getSession(SID));
  const create = vi.spyOn(ctx.mux, 'createSession');
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  registerRebootRestoreRoutes(app, ctx);
  await app.ready();
  try {
    const response = await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    expect(response.statusCode).toBe(200);
    if (kind === 'healthy') {
      expect(response.json().restored).toHaveLength(1);
      expect(create).toHaveBeenCalledOnce();
    } else {
      expect(response.json()).toMatchObject({
        restored: [],
        skipped: [{ sessionId: SID, reason: 'identity-unverified' }],
      });
      expect(create).not.toHaveBeenCalled();
      expect(store.getSession(SID)).toEqual(historical);
      expect(JSON.parse(await fs.readFile(join(root, 'state.json'), 'utf8')).sessions[SID]).toEqual(historical);
    }
  } finally {
    await app.close();
  }
});

it.each(['healthy', 'tainted', 'missing', 'replaced'])(
  'the actual new broker rechecks prior journal bytes before child startup: %s',
  async (kind) => {
    const { state, broker, root, home, journal } = await fixture();
    const plan = await planVerifiedRebootRestore([SID], { [SID]: state }, () => true);
    const evidence = await verifyCodexRebootEvidence(plan.restore[0].state);
    expect(evidence).toBeDefined();
    const fence = await captureRebootIdentityFenceWitness(SID);
    const witness = await captureRebootLaunchWitness('codex', SID, undefined, {});
    expect(await witness!(evidence!, fence!)).toBe(true);
    const startup = witness!.getStartupEvidence()!;
    expect(startup.files.map((file) => file.path)).toContain(journal);
    expect(startup.files.map((file) => file.path)).toContain(join(broker.directory, 'config.json'));
    const marker = join(root, 'new-child');
    const next = await CodexInputBroker.create(
      join(root, 'codex-input-brokers', SID),
      SID,
      `printf new > ${quote(marker)}`,
      home,
      root
    );
    await next.setStartupAuthority(startup.files, undefined, startup.paths, startup.missing);
    if (kind !== 'healthy') await damage(journal, kind);
    const child = spawn('python3', [join(next.directory, 'broker.py'), next.directory, next.configurationDigest], {
      env: { ...process.env, CODEX_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.resume();
    child.stderr.resume();
    const done = new Promise<number | null>((resolve) => child.once('close', resolve));
    await done;
    expect(await next.startupReceipt(child.pid!)).toBe(kind === 'healthy' ? 'started' : 'not-sent');
    if (kind === 'healthy') expect(await fs.readFile(marker, 'utf8')).toBe('new');
    else {
      expect((await next.readState())?.childPid).toBe(0);
      await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  }
);

it('retains a known clean child exit veto even if ordinary session state missed the exit', async () => {
  const { state } = await fixture(false, 0);
  expect(await verifyCodexRebootIdentity(state)).toBeUndefined();
  expect((await planVerifiedRebootRestore([SID], { [SID]: state }, () => true)).restore).toEqual([]);
});

it.each([false, true])('boot captures the old broker before reconciliation prunes MUX (%s raw)', async (raw) => {
  const { state, root, broker } = await fixture(raw);
  state.createdAt = 1_000;
  vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);
  const server = new WebServer(0, false, true);
  servers.push(server);
  const store = new StateStore(join(root, 'state.json'));
  Reflect.set(server, 'store', store);
  store.setSession(SID, state);
  store.flush();
  const mux = Reflect.get(server, 'mux') as TmuxManager;
  vi.spyOn(mux, 'reconcileSessions').mockImplementation(async () => {
    await fs.writeFile(join(root, 'mux-sessions.json'), '[]');
    return { alive: [], dead: [SID], discovered: [] };
  });
  const create = vi.spyOn(mux, 'createSession');
  await Reflect.get(server, 'restoreMuxSessions').call(server);
  const offers = rebootRestoreRegistry.list(() => true);
  if (raw) expect(offers).toEqual([]);
  else expect(offers).toMatchObject([{ sessionId: SID, state: { __codexPriorInputBroker: broker.incarnation } }]);
  expect(create).not.toHaveBeenCalled();
  expect(store.getSession(SID)).toEqual(state);
});
