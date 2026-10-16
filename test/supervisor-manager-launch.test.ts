/** Actual private profile files and Session conversion; all native effects are explicit fakes. */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

function prepareAt(p: { home: string; work: string }, isCurrent = () => true) {
  return prepareSupervisorManagerLaunch({
    home: p.home,
    workingDir: p.work,
    conversationId: CID,
    expectedPane: { paneId: '%7', panePid: 600 },
    token: TOKEN,
    endpoint: 'http://127.0.0.1:3000/api/supervisor-mcp',
    bridgeCommand: 'codeman',
    bridgeArgs: ['agent', 'supervisor-mcp'],
    isCurrent,
  });
}

it.each(['config.toml', 'requirements.toml', 'managed_config.toml'])(
  'refuses an inherited system %s catalog before creating artifacts',
  async (name) => {
    const p = await paths(),
      system = join(p.root, 'system');
    await fs.mkdir(system);
    await fs.writeFile(join(system, name), '[mcp_servers.foreign]\ncommand="unrestricted"\n');
    const original = fs.lstat.bind(fs);
    vi.spyOn(fs, 'lstat').mockImplementation((...args) =>
      original(String(args[0]) === '/etc/codex' ? system : args[0], args[1])
    );
    expect(await prepareAt(p)).toBeUndefined();
    expect(await fs.readdir(p.home)).toEqual([]);
    expect(await fs.readFile(join(system, name), 'utf8')).toContain('unrestricted');
  }
);

it.each(['managed_config.toml', 'cloud-config-bundle-cache.json'])(
  'refuses unknown inherited %s evidence instead of merging it',
  async (name) => {
    const p = await paths(),
      file = join(p.home, name),
      bytes = 'unverified managed MCP bundle';
    await fs.writeFile(file, bytes);
    expect(await prepareAt(p)).toBeUndefined();
    expect(await fs.readdir(p.home)).toEqual([name]);
    expect(await fs.readFile(file, 'utf8')).toBe(bytes);
  }
);

it('refuses unreadable system configuration evidence before any private artifacts', async () => {
  const p = await paths(),
    original = fs.lstat.bind(fs);
  vi.spyOn(fs, 'lstat').mockImplementation((...args) =>
    String(args[0]) === '/etc/codex'
      ? Promise.reject(Object.assign(new Error('unreadable system policy'), { code: 'EACCES' }))
      : original(...args)
  );
  expect(await prepareAt(p)).toBeUndefined();
  expect(await fs.readdir(p.home)).toEqual([]);
});

it('pins the verified absent system parent and rejects its symlink or later replacement', async () => {
  const p = await profile(),
    system = join(p.root, 'managed'),
    link = join(p.root, 'managed-link');
  expect(p.profile.missing).toContain('/etc/codex');
  await fs.mkdir(system);
  await fs.symlink(system, link);
  const original = fs.lstat.bind(fs);
  vi.spyOn(fs, 'lstat').mockImplementation((...args) =>
    original(String(args[0]) === '/etc/codex' ? link : args[0], args[1])
  );
  expect(await p.profile.confirm()).toBe(false);
  await p.profile.revoke();
  expect(await prepareAt(p)).toBeUndefined();
  expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
});

it('admits and pins synthetic API-key-only file auth while excluding keyring and external managed identities', async () => {
  const p = await paths(),
    path = join(p.home, 'auth.json');
  const bytes = JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'synthetic-not-a-real-key', tokens: null });
  await fs.writeFile(path, bytes, { mode: 0o600 });
  const prepared = await prepareAt(p);
  expect(prepared).toBeDefined();
  expect(prepared!.files.some((file) => file.path === path)).toBe(true);
  expect(await prepared!.confirm()).toBe(true);
  const command = supervisorManagerCommand(prepared!, { noDaemon: true });
  expect(command).toContain('cli_auth_credentials_store="file"');
  for (const key of [
    'CODEX_ACCESS_TOKEN',
    'OPENAI_FEDERATION_RULE_ID',
    'OPENAI_IDENTITY_TOKEN_FILE',
    'OPENAI_WORKLOAD_IDENTITY_CONTEXT',
  ])
    expect(command).toContain(`-u ${key}`);
  expect(command).not.toContain('synthetic-not-a-real-key');
  await fs.rename(path, path + '.old');
  await fs.writeFile(path, bytes, { mode: 0o600 });
  expect(await prepared!.confirm()).toBe(false);
  await prepared!.revoke();
  expect(await fs.readFile(path, 'utf8')).toBe(bytes);
});

it.each([
  { auth_mode: 'chatgpt', tokens: { access_token: 'synthetic' } },
  { auth_mode: 'apikey', OPENAI_API_KEY: 'synthetic', tokens: { access_token: 'synthetic' } },
  { auth_mode: 'agentIdentity', agent_identity: 'synthetic' },
  { OPENAI_API_KEY: 'synthetic', unknown_policy: {} },
])('refuses incomplete or managed auth evidence without modifying it: %j', async (auth) => {
  const p = await paths(),
    path = join(p.home, 'auth.json'),
    bytes = JSON.stringify(auth);
  await fs.writeFile(path, bytes, { mode: 0o600 });
  expect(await prepareAt(p)).toBeUndefined();
  expect(await fs.readdir(p.home)).toEqual(['auth.json']);
  expect(await fs.readFile(path, 'utf8')).toBe(bytes);
});

it.each(['credential', 'profile', 'directory'] as const)(
  'cleans every unsuccessful preparation after %s IO fails while authority remains current',
  async (stage) => {
    const p = await paths(),
      original = fs.open.bind(fs);
    let failed = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const fd = await original(...args),
        path = String(args[0]);
      if (
        !failed &&
        ((stage === 'credential' && path.endsWith('credential.json')) ||
          (stage === 'profile' && path.endsWith('.config.toml')) ||
          (stage === 'directory' && path === p.home))
      ) {
        vi.spyOn(fd, 'sync').mockImplementation(async () => {
          failed = true;
          throw Object.assign(new Error('fixture IO failure'), { code: 'EIO' });
        });
      }
      return fd;
    });
    const current = vi.fn(() => true);
    expect(await prepareAt(p, current)).toBeUndefined();
    expect(failed).toBe(true);
    expect(current()).toBe(true);
    expect(await fs.readdir(p.home)).toEqual([]);
  }
);

it('preserves a same-byte foreign profile replacement on failed preparation', async () => {
  const p = await paths(),
    original = fs.open.bind(fs);
  let foreign: string | undefined,
    inode = 0;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const fd = await original(...args),
      path = String(args[0]);
    if (path.endsWith('.config.toml') && (Number(args[1]) & 1) !== 0) {
      vi.spyOn(fd, 'sync').mockImplementation(async () => {
        const bytes = await fs.readFile(path);
        await fs.rename(path, path + '.original');
        await fs.writeFile(path, bytes, { mode: 0o600 });
        foreign = path;
        inode = (await fs.lstat(path)).ino;
        throw Object.assign(new Error('fixture IO failure'), { code: 'EIO' });
      });
    }
    return fd;
  });
  expect(await prepareAt(p)).toBeUndefined();
  expect(foreign).toBeDefined();
  expect((await fs.lstat(foreign!)).ino).toBe(inode);
  expect(await fs.readFile(foreign!, 'utf8')).toContain('mcp_servers.codeman_supervisor');
});

it('cleans its credential directory but never a foreign exclusive-open profile collision', async () => {
  const p = await paths(),
    original = fs.open.bind(fs);
  let foreign: string | undefined;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const path = String(args[0]);
    if (!foreign && path.endsWith('.config.toml') && (Number(args[1]) & constants.O_EXCL) !== 0) {
      foreign = path;
      await fs.writeFile(path, 'foreign collision', { mode: 0o600 });
    }
    return original(...args);
  });
  expect(await prepareAt(p)).toBeUndefined();
  expect(foreign).toBeDefined();
  expect(await fs.readFile(foreign!, 'utf8')).toBe('foreign collision');
  expect(await fs.readdir(p.home)).toEqual([foreign!.slice(p.home.length + 1)]);
});

it('retains failed-preparation files when their contents cannot be verified for cleanup', async () => {
  const p = await paths(),
    original = fs.open.bind(fs);
  let failed = false;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const path = String(args[0]);
    if (failed && path.endsWith('.config.toml') && (Number(args[1]) & 1) === 0)
      throw Object.assign(new Error('cleanup proof unavailable'), { code: 'EACCES' });
    const fd = await original(...args);
    if (path.endsWith('.config.toml') && (Number(args[1]) & 1) !== 0)
      vi.spyOn(fd, 'sync').mockImplementation(async () => {
        failed = true;
        throw Object.assign(new Error('lost IO acknowledgement'), { code: 'EIO' });
      });
    return fd;
  });
  expect(await prepareAt(p)).toBeUndefined();
  expect(failed).toBe(true);
  expect((await fs.readdir(p.home)).filter((name) => name.startsWith('codeman-supervisor-'))).toHaveLength(1);
  expect((await fs.readdir(p.home)).filter((name) => name.startsWith('.codeman-supervisor-'))).toHaveLength(1);
});

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
  for (const feature of ['shell_tool', 'apply_patch_freeform', 'apps', 'multi_agent', 'plugins', 'hooks'])
    expect(command).toContain(`--disable ${feature}`);
  expect(command).not.toContain('--disable view_image');
  expect(command).toContain('--config tools.view_image=false');
  expect(parsed.tools).toEqual({ view_image: false });
  expect(command).toContain('-u CODEMAN_PASSWORD');
  expect(command).toContain('-u CODEMAN_HOOK_SECRET_FILE');
  expect(command).toContain('CODEMAN_SUPERVISOR_SCOPED=1');
  expect(command).not.toContain(TOKEN);
  expect(await fs.readFile(join(p.home, 'config.toml'), 'utf8')).toBe(base);
});

it('the emitted command passes a fake CLI with the registered feature inventory and disables the image tool separately', async () => {
  const p = await profile();
  const bin = join(p.root, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(
    join(bin, 'codex'),
    `#!${process.execPath}\nconst a=process.argv.slice(2);\nconst known=new Set(['shell_tool','apply_patch_freeform','apps','multi_agent','plugins','hooks','remote_plugin','skill_mcp_dependency_install','code_mode']);\nfor(let i=0;i<a.length;i++) if(a[i]==='--disable'&&!known.has(a[++i])) { console.error('Unknown feature flag: '+a[i]); process.exit(2); }\nif(!a.some((v,i)=>v==='--config'&&a[i+1]==='tools.view_image=false'))process.exit(3);\nif(!a.includes('${CID}'))process.exit(4);\n`,
    { mode: 0o700 }
  );
  const command = supervisorManagerCommand(p.profile, { noDaemon: true, resumeSessionId: CID });
  await expect(
    promisify(execFile)('/bin/sh', ['-c', command], {
      cwd: p.work,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: p.home, HOME: p.root },
      timeout: 2000,
    })
  ).resolves.toMatchObject({ stdout: '', stderr: '' });
  await expect(
    promisify(execFile)(join(bin, 'codex'), ['--disable', 'view_image'], { timeout: 2000 })
  ).rejects.toMatchObject({ code: 2 });
});

it('revokes immediately and retires exactly the issued profile and credential directory, retaining owner files', async () => {
  const p = await profile();
  const ownerFile = join(p.home, 'owner.txt');
  await fs.writeFile(ownerFile, 'owner configuration');
  expect(await p.profile.confirm()).toBe(true);
  const retiring = p.profile.revoke();
  expect(p.profile.isCurrent()).toBe(false);
  expect(await retiring).toBe(true);
  expect(await p.profile.revoke()).toBe(true);
  expect(await fs.readdir(p.home)).toEqual(['owner.txt']);
  expect(await fs.readFile(ownerFile, 'utf8')).toBe('owner configuration');
});

it.each(['profile-replacement', 'credential-symlink', 'directory-replacement'] as const)(
  'preserves unknown artifacts on %s instead of unlinking foreign material',
  async (kind) => {
    const p = await profile();
    const privateDir = join(p.home, `.${p.profile.name}`),
      credential = join(privateDir, 'credential.json');
    const profileBytes = await fs.readFile(p.profile.file),
      credentialBytes = await fs.readFile(credential);
    if (kind === 'profile-replacement') {
      await fs.rename(p.profile.file, p.profile.file + '.original');
      await fs.writeFile(p.profile.file, profileBytes, { mode: 0o600 });
    } else if (kind === 'credential-symlink') {
      const foreign = join(p.home, 'foreign.json');
      await fs.writeFile(foreign, credentialBytes, { mode: 0o600 });
      await fs.unlink(credential);
      await fs.symlink(foreign, credential);
    } else {
      await fs.rename(privateDir, privateDir + '.original');
      await fs.mkdir(privateDir, { mode: 0o700 });
      await fs.writeFile(credential, credentialBytes, { mode: 0o600 });
    }
    expect(await p.profile.revoke()).toBe(false);
    expect(p.profile.isCurrent()).toBe(false);
    expect(await fs.readFile(p.profile.file)).toEqual(profileBytes);
    expect(await fs.readFile(credential)).toEqual(credentialBytes);
    if (kind === 'credential-symlink') expect((await fs.lstat(credential)).isSymbolicLink()).toBe(true);
  }
);

it('waits for an actual held confirmation before cleanup and never lends the revoked profile again', async () => {
  const p = await profile(),
    entered = createDeferred(),
    release = createDeferred();
  const original = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const fd = await original(...args);
    if (String(args[0]) === p.profile.file) {
      const close = fd.close.bind(fd);
      vi.spyOn(fd, 'close').mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        await close();
      });
    }
    return fd;
  });
  const confirm = p.profile.confirm();
  await entered.promise;
  const unlink = vi.spyOn(fs, 'unlink');
  const retiring = p.profile.revoke();
  expect(p.profile.isCurrent()).toBe(false);
  expect(unlink).not.toHaveBeenCalled();
  release.resolve();
  expect(await confirm).toBe(false);
  expect(await retiring).toBe(true);
  expect(await fs.readdir(p.home)).toEqual([]);
});

it('leaves unexpected private-directory entries untouched without recursive deletion', async () => {
  const p = await profile();
  const directory = join(p.home, `.${p.profile.name}`),
    foreign = join(directory, 'owner-file');
  await fs.writeFile(foreign, 'keep');
  expect(await p.profile.revoke()).toBe(false);
  expect(await fs.readFile(foreign, 'utf8')).toBe('keep');
  expect(await fs.readdir(directory)).toEqual(['owner-file']);
  await expect(fs.lstat(p.profile.file)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('bounds a held cleanup, retains its actual-work fence, and preserves artifacts after deadline expiry', async () => {
  const p = await profile(),
    entered = createDeferred(),
    release = createDeferred(),
    completed = createDeferred();
  const original = fs.lstat.bind(fs);
  const now = performance.now();
  vi.spyOn(performance, 'now').mockReturnValue(now);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let held = false;
  vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
    if (String(args[0]) === p.home && !held) {
      held = true;
      entered.resolve();
      await release.promise;
      const value = await original(...args);
      completed.resolve();
      return value;
    }
    return original(...args);
  });
  const retiring = p.profile.revoke();
  try {
    await entered.promise;
    vi.mocked(performance.now).mockReturnValue(now + 2001);
    await vi.advanceTimersByTimeAsync(2001);
    expect(await retiring).toBe(false);
    expect(
      await prepareSupervisorManagerLaunch({
        home: p.home,
        workingDir: p.work,
        expectedPane: { paneId: '%7', panePid: 600 },
        conversationId: CID,
        token: TOKEN,
        endpoint: 'http://127.0.0.1:3000/api/supervisor-mcp',
        bridgeCommand: 'codeman',
        bridgeArgs: [],
        isCurrent: () => true,
      })
    ).toBeUndefined();
  } finally {
    release.resolve();
    await completed.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    vi.useRealTimers();
  }
  expect(await fs.readFile(p.profile.file, 'utf8')).toContain('[mcp_servers.codeman_supervisor]');
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
  await p.profile.revoke();
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
  await p.profile.revoke();
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
  await f.session.revokeSupervisorManagerLaunch();
  expect(await fs.readdir(f.home)).toEqual([]);
});

it('retires an older conversion before issuing the replacement and retains the new exact artifacts', async () => {
  const f = await fixture();
  expect(await f.session.prepareSupervisorManager(f.options)).toBe(true);
  const prior = Reflect.get(f.session, '_supervisorManagerProfile') as SupervisorManagerLaunch;
  expect(await f.session.prepareSupervisorManager(f.options)).toBe(true);
  const next = Reflect.get(f.session, '_supervisorManagerProfile') as SupervisorManagerLaunch;
  expect(next).not.toBe(prior);
  expect(prior.isCurrent()).toBe(false);
  await expect(fs.lstat(prior.file)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await next.confirm()).toBe(true);
  expect(await fs.readdir(f.home)).toEqual([`.${next.name}`, `${next.name}.config.toml`].sort());
});

it.each(['stop', 'restart'] as const)(
  'retires the private artifacts on ordinary %s without starting a manager',
  async (kind) => {
    const f = await fixture();
    expect(await f.session.prepareSupervisorManager(f.options)).toBe(true);
    f.respawn.mockClear();
    if (kind === 'stop') await f.session.stop(false);
    else {
      vi.spyOn(f.session as unknown as { _doRestartCli(): Promise<boolean> }, '_doRestartCli').mockResolvedValue(false);
      expect(await f.session.restartCli()).toBe(false);
    }
    expect(f.respawn).not.toHaveBeenCalled();
    expect(f.session.isSupervisorManagerLaunchCurrent()).toBe(false);
    expect(await fs.readdir(f.home)).toEqual([]);
  }
);
it.each(['refused', 'unknown'] as const)('never creates a new worker after %s conversion receipt', async () => {
  const f = await fixture();
  f.respawn.mockResolvedValue(null);
  expect(await f.session.prepareSupervisorManager(f.options)).toBe(false);
  expect(f.respawn).toHaveBeenCalledOnce();
  expect(f.session.isSupervisorManagerLaunchCurrent()).toBe(false);
  expect(await fs.readdir(f.home)).toEqual([]);
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
