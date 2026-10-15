/** Actual private profile files and Session conversion; all native effects are explicit fakes. */
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { parse } from 'smol-toml';
import { Session } from '../src/session.js';
import type { MuxSession, TerminalMultiplexer } from '../src/mux-interface.js';
import {
  prepareSupervisorManagerLaunch,
  supervisorManagerCommand,
  type SupervisorManagerLaunch,
} from '../src/supervisor/manager-launch.js';
import { createDeferred } from './mocks/index.js';

const SID = '11111111-1111-4111-8111-111111111111';
const CID = '22222222-2222-4222-8222-222222222222';
const TOKEN = `codeman-manager-v1.${'a'.repeat(64)}`;
const roots: string[] = [],
  sessions: Session[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const session of sessions.splice(0)) {
    await session.stop(false);
    await Reflect.get(session, '_recoveryFencePublication');
  }
  vi.unstubAllEnvs();
  for (const path of roots.splice(0)) await fs.rm(path, { recursive: true, force: true });
});
async function paths() {
  const root = await fs.mkdtemp(join(homedir(), 'manager-launch-'));
  roots.push(root);
  const home = join(root, 'home'),
    work = join(root, 'work');
  await fs.mkdir(home, { mode: 0o700 });
  await fs.mkdir(work);
  return { root, home, work };
}
async function profile() {
  const p = await paths();
  const prepared = await prepareSupervisorManagerLaunch({
    home: p.home,
    workingDir: p.work,
    conversationId: CID,
    expectedPane: { paneId: '%7', panePid: 600 },
    token: TOKEN,
    endpoint: 'https://127.0.0.1:3000/api/supervisor-mcp',
    bridgeCommand: 'codeman',
    bridgeArgs: ['agent', 'supervisor-mcp'],
    isCurrent: () => true,
  });
  expect(prepared).toBeDefined();
  return { ...p, profile: prepared! };
}

it('loads the exact adjacent named profile and keeps the only credential in its private JSON file', async () => {
  const p = await paths();
  const base = 'model = "owner-model"\n';
  await fs.writeFile(join(p.home, 'config.toml'), base);
  const prepared = await prepareSupervisorManagerLaunch({
    home: p.home,
    workingDir: p.work,
    conversationId: CID,
    expectedPane: { paneId: '%7', panePid: 600 },
    token: TOKEN,
    endpoint: 'https://127.0.0.1:3000/api/supervisor-mcp',
    bridgeCommand: 'codeman',
    bridgeArgs: ['agent', 'supervisor-mcp'],
    isCurrent: () => true,
  });
  expect(prepared).toBeDefined();
  expect(await prepared!.confirm()).toBe(true);
  expect(prepared!.file).toBe(join(p.home, `${prepared!.name}.config.toml`));
  const text = await fs.readFile(prepared!.file, 'utf8');
  expect(text).not.toContain(TOKEN);
  const parsed = parse(text),
    servers = parsed.mcp_servers as Record<string, { command: string; args: string[]; enabled_tools: string[] }>;
  expect(Object.keys(servers)).toEqual(['codeman_supervisor']);
  expect(servers.codeman_supervisor.enabled_tools).toEqual([
    'supervisor_status',
    'supervisor_workers',
    'supervisor_assign',
    'supervisor_retry',
  ]);
  const credentialFile = servers.codeman_supervisor.args.at(-1)!;
  expect(JSON.parse(await fs.readFile(credentialFile, 'utf8'))).toEqual({
    version: 1,
    url: 'https://127.0.0.1:3000/api/supervisor-mcp',
    token: TOKEN,
  });
  expect((await fs.stat(credentialFile)).mode & 0o777).toBe(0o600);
  expect((await fs.stat(join(credentialFile, '..'))).mode & 0o777).toBe(0o700);
  const command = supervisorManagerCommand(prepared!, {
    noDaemon: true,
    dangerouslyBypassApprovals: true,
    model: 'owner-model',
    resumeSessionId: CID,
  });
  expect(command).toContain(`--profile ${prepared!.name} resume ${CID}`);
  expect(command).toContain('--sandbox read-only');
  expect(command).not.toContain('dangerously-bypass');
  for (const feature of ['shell_tool', 'apply_patch_freeform', 'apps', 'multi_agent', 'plugins', 'hooks', 'view_image'])
    expect(command).toContain(`--disable ${feature}`);
  expect(command).toContain('-u CODEMAN_PASSWORD');
  expect(command).toContain('-u CODEMAN_HOOK_SECRET_FILE');
  expect(command).toContain('CODEMAN_SUPERVISOR_SCOPED=1');
  expect(command).not.toContain(TOKEN);
  expect(await fs.readFile(join(p.home, 'config.toml'), 'utf8')).toBe(base);
});

it.each(['mcp_servers', 'plugins', 'apps', 'hooks', 'notify', 'profiles', 'profile'])(
  'refuses an unknown existing %s catalog without rewriting owner config',
  async (key) => {
    const p = await paths(),
      bytes = `${key} = {}\n`;
    await fs.writeFile(join(p.home, 'config.toml'), bytes);
    expect(
      await prepareSupervisorManagerLaunch({
        home: p.home,
        workingDir: p.work,
        conversationId: CID,
        expectedPane: { paneId: '%7', panePid: 600 },
        token: TOKEN,
        endpoint: 'http://127.0.0.1:3000/api/supervisor-mcp',
        bridgeCommand: 'codeman',
        bridgeArgs: [],
        isCurrent: () => true,
      })
    ).toBeUndefined();
    expect(await fs.readFile(join(p.home, 'config.toml'), 'utf8')).toBe(bytes);
    expect(await fs.readdir(p.home)).toEqual(['config.toml']);
  }
);
it('refuses project configuration and a catalog that appears after the initial proof', async () => {
  const p = await profile();
  await fs.mkdir(join(p.work, '.codex'));
  await fs.writeFile(join(p.work, '.codex', 'config.toml'), '[mcp_servers.extra]\ncommand="untrusted"\n');
  expect(await p.profile.confirm()).toBe(false);
  expect(
    await prepareSupervisorManagerLaunch({
      home: p.home,
      workingDir: p.work,
      conversationId: CID,
      expectedPane: { paneId: '%7', panePid: 600 },
      token: TOKEN,
      endpoint: 'http://127.0.0.1:3000/api/supervisor-mcp',
      bridgeCommand: 'codeman',
      bridgeArgs: [],
      isCurrent: () => true,
    })
  ).toBeUndefined();
});
it('rejects same-byte profile replacement instead of authorizing its inode', async () => {
  const p = await profile(),
    bytes = await fs.readFile(p.profile.file);
  await fs.rename(p.profile.file, p.profile.file + '.old');
  await fs.writeFile(p.profile.file, bytes, { mode: 0o600 });
  expect(await p.profile.confirm()).toBe(false);
});

async function fixture() {
  const p = await paths();
  vi.stubEnv('CODEMAN_DATA_DIR', join(p.root, 'data'));
  await fs.mkdir(join(p.root, 'data'));
  let current = true,
    acknowledged: SupervisorManagerLaunch | undefined;
  const record: MuxSession = {
    sessionId: SID,
    muxName: 'codeman-11111111',
    pid: 600,
    createdAt: Date.now(),
    mode: 'codex',
    workingDir: p.work,
    attached: true,
    recoveryCodexHome: p.home,
    recoveryIsolated: true,
  };
  const respawn = vi.fn(async (options) => {
    expect(options.codexConfig.resumeSessionId).toBe(CID);
    if (!options.ownerLaunchIsCurrent() || !(await options.supervisorManager.confirm())) return null;
    acknowledged = options.supervisorManager;
    record.pid = 700;
    return 700;
  });
  const mux = {
    inspectPaneForRecovery: vi.fn(async () => ({ dead: false, panePid: record.pid, paneId: '%7', screen: '› ' })),
    respawnPane: respawn,
    isSupervisorManagerLaunchCurrent: (_id: string, profile: SupervisorManagerLaunch) =>
      acknowledged === profile && record.pid === 700,
    isAvailable: () => true,
    clearPaneExit: () => {},
  } as unknown as TerminalMultiplexer;
  const session = new Session({
    id: SID,
    mode: 'codex',
    useMux: true,
    mux,
    muxSession: record,
    workingDir: p.work,
    codexConfig: { noDaemon: true, resumeSessionId: CID },
    envOverrides: { CODEX_HOME: p.home },
  });
  sessions.push(session);
  expect(await session.ensureRecoveryIdentityFence()).toBe(true);
  return {
    ...p,
    session,
    mux,
    record,
    respawn,
    revoke: () => {
      current = false;
    },
    options: { token: TOKEN, endpoint: 'http://127.0.0.1:3000/api/supervisor-mcp', isCurrent: () => current },
  };
}
it('ordinary restored Session cannot adopt a manager role; exact acknowledged restricted conversion works and owner intent revokes it', async () => {
  const f = await fixture();
  expect(f.session.isSupervisorManagerLaunchCurrent()).toBe(false);
  expect(await f.session.prepareSupervisorManager(f.options)).toBe(true);
  expect(f.respawn).toHaveBeenCalledOnce();
  expect(f.session.isSupervisorManagerLaunchCurrent()).toBe(true);
  expect(f.session.codexConfig?.resumeSessionId).toBe(CID);
  expect(f.session.getRecoveryContext().codexHome).toBe(f.home);
  f.session.trackUserInput('Owner takes over\r');
  await Reflect.get(f.session, '_recoveryFencePublication');
  expect(f.session.isSupervisorManagerLaunchCurrent()).toBe(false);
});
it.each(['refused', 'unknown'] as const)('never creates a new worker after %s conversion receipt', async () => {
  const f = await fixture();
  f.respawn.mockResolvedValue(null);
  expect(await f.session.prepareSupervisorManager(f.options)).toBe(false);
  expect(f.respawn).toHaveBeenCalledOnce();
  expect(f.session.isSupervisorManagerLaunchCurrent()).toBe(false);
});
it('revocation while private profile sync is held prevents native restart', async () => {
  const f = await fixture(),
    entered = createDeferred(),
    release = createDeferred();
  const original = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const fd = await original(...args);
    if (String(args[0]).endsWith('.config.toml') && (Number(args[1]) & 1) !== 0) {
      const sync = fd.sync.bind(fd);
      vi.spyOn(fd, 'sync').mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        await sync();
      });
    }
    return fd;
  });
  const work = f.session.prepareSupervisorManager(f.options);
  await entered.promise;
  f.revoke();
  release.resolve();
  expect(await work).toBe(false);
  expect(f.respawn).not.toHaveBeenCalled();
  expect(f.session.isSupervisorManagerLaunchCurrent()).toBe(false);
});
it('a changed caller, lifecycle, pending broker or nonempty composer refuses conversion before effects', async () => {
  const f = await fixture();
  f.revoke();
  expect(await f.session.prepareSupervisorManager(f.options)).toBe(false);
  expect(f.respawn).not.toHaveBeenCalled();
  const other = await fixture();
  other.record.recoveryInputBrokerPending = '33333333-3333-4333-8333-333333333333';
  expect(await other.session.prepareSupervisorManager(other.options)).toBe(false);
  expect(other.respawn).not.toHaveBeenCalled();
  const draft = await fixture();
  vi.mocked(draft.mux.inspectPaneForRecovery!).mockResolvedValue({
    dead: false,
    panePid: 600,
    paneId: '%7',
    screen: '› Owner draft',
  } as never);
  expect(await draft.session.prepareSupervisorManager(draft.options)).toBe(false);
  expect(draft.respawn).not.toHaveBeenCalled();
});
