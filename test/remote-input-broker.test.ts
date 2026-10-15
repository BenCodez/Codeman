/** Generated provisioning executes only fake SSH/tmux against temporary private files. */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRemote } from '../src/types.js';
import {
  provisionRemoteInputBroker,
  withRemoteBrokerIssuerLease,
  createSourceHostLeaseTransport,
  type SourceHostLeaseTransport,
  type RemoteWorkerLeaseBinding,
  type RemoteBrokerMaterial,
  type RemoteBrokerTransport,
} from '../src/recovery/remote-input-broker.js';

const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const INCARNATION = '11111111-2222-3333-4444-555555555555';
const secret = 'private-test-key-never-in-command';
const material: RemoteBrokerMaterial = {
  source: '# fixture Python sidecar\nprint("healthy")\n',
  configJson: JSON.stringify({ sessionId: SESSION, incarnation: INCARNATION, secret }),
  sessionId: SESSION,
  incarnation: INCARNATION,
};
const FAKE_TMUX = String.raw`#!/usr/bin/python3
import json,os,re,sys
a=sys.argv[1:]; assert a[:2]==['-L','codeman-remote']
p=os.environ['FAKE_STATE']; log=os.environ['FAKE_LOG']; op=a[2]
with open(log,'a') as f:f.write(json.dumps(a)+'\n')
def state():
 with open(p) as f:return json.load(f)
def save(s):
 with open(p,'w') as f:json.dump(s,f)
if op=='has-session':sys.exit(0 if os.path.exists(p) else 1)
if op=='new-session':
 if os.environ.get('OPPONENT')=='create-race':sys.exit(1)
 assert not os.path.exists(p)
 s={'session_name':'codeman-ssh-aaaaaaaa','session_id':'$17','pane_id':'%9','pane_pid':'9009','pid':'17000','pane_dead':'0','pane_dead_status':'','pane_dead_signal':''}
 save(s); print('$17|%9|9009|17000')
elif op=='set-option':
 commands=[];command=[]
 for arg in a[2:]:
  if arg==';':
   assert command;commands.append(command);command=[]
  else:command.append(arg)
 if command:commands.append(command)
 assert commands==[['set-option','-t','$17',k,v] for k,v in [('status','off'),('mouse','off'),('prefix','C-q'),('window-size','latest'),('remain-on-exit','failed')]]
elif op=='wait-for':
 s=state();s['pane_dead']='1';s['pane_dead_status']='1';save(s)
elif op=='list-panes':
 s=state()
 if os.environ.get('OPPONENT')=='before-list':s['pane_pid']='9010'
 print('|'.join(s[x] for x in ['pane_dead','pane_id','pane_pid','pane_dead_status','pane_dead_signal','pid']))
elif op=='if-shell':
 assert a[3:5]==['-F','-t'] and a[7]=='display-message -p CODEMAN_BROKER_OWNED' and a[8]=='display-message -p CODEMAN_BROKER_REFUSED'
 terms=re.findall(r'#\{==:#\{([a-z_]+)\},([^{}]*)\}',a[6]); assert len(terms)==8
 expression='#{==:#{'+terms[0][0]+'},'+terms[0][1]+'}'
 for k,v in terms[1:]:expression='#{&&:'+expression+',#{==:#{'+k+'},'+v+'}}'
 assert expression==a[6]
 s=state(); count=int(s.get('guards',0));s['guards']=str(count+1);save(s)
 change=os.environ.get('OPPONENT','')
 if change in ['pid','dead','status','signal','session','server']:
  k={'pid':'pane_pid','dead':'pane_dead','status':'pane_dead_status','signal':'pane_dead_signal','session':'session_id','server':'pid'}[change]
  s[k]={'pid':'9010','dead':'0','status':'2','signal':'TERM','session':'$18','server':'17001'}[change]
 if change=='after-files' and count:s['pane_pid']='9010'
 print('CODEMAN_BROKER_OWNED' if a[5]==s['pane_id'] and all(s.get(k)==v for k,v in terms) else 'CODEMAN_BROKER_REFUSED')
else:raise AssertionError('Unexpected native mutation '+op)
`;

describe('owned SSH private broker provisioning', () => {
  let root: string;
  let bin: string;
  let privateRoot: string;
  let remote: SessionRemote;
  let calls: { command: string; input: string }[];
  let environment: NodeJS.ProcessEnv;
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'codeman-remote-broker-'));
    bin = join(root, 'bin');
    privateRoot = join(root, 'private brokers');
    await fs.mkdir(bin);
    await fs.symlink(process.execPath, join(bin, 'node'));
    await fs.writeFile(join(bin, 'ssh'), '#!/bin/sh\nfor arg; do last="$arg"; done\nexec /bin/sh -c "$last"\n', {
      mode: 0o700,
    });
    await fs.writeFile(join(bin, 'tmux'), FAKE_TMUX, { mode: 0o700 });
    await fs.writeFile(
      join(bin, 'login-shell'),
      '#!/bin/sh\nfor arg; do last="$arg"; done\nexec /bin/sh -c "$last"\n',
      { mode: 0o700 }
    );
    await fs.writeFile(join(bin, 'python3'), '#!/bin/sh\nexec /usr/bin/python3 "$@"\n', { mode: 0o700 });
    environment = {
      ...process.env,
      HOME: root,
      SHELL: join(bin, 'login-shell'),
      PATH: `${bin}:/usr/bin:/bin`,
      FAKE_STATE: join(root, 'native.json'),
      FAKE_LOG: join(root, 'native.log'),
    };
    delete environment.CODEX_HOME;
    delete environment.CODEMAN_MUX;
    delete environment.CODEMAN_TMUX_SOCKET;
    delete environment.TMUX;
    for (const key of Object.keys(environment)) if (key.startsWith('SSH_')) delete environment[key];
    calls = [];
    remote = {
      hostId: 'fixture',
      label: 'Fixture',
      host: 'worker.invalid',
      username: 'runner',
      port: 22,
      remotePath: '/fixture/work',
      owned: true,
    };
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const authority = () => ({ prepare: async () => true, isCurrent: () => true });
  function runner(): RemoteBrokerTransport {
    return {
      run: async (command, input) => {
        if (
          environment.SHELL !== join(bin, 'login-shell') ||
          environment.PATH !== `${bin}:/usr/bin:/bin` ||
          (await fs.readFile(join(bin, 'tmux'), 'utf8')) !== FAKE_TMUX ||
          (await fs.readFile(join(bin, 'ssh'), 'utf8')) !==
            '#!/bin/sh\nfor arg; do last="$arg"; done\nexec /bin/sh -c "$last"\n' ||
          (await fs.readFile(join(bin, 'login-shell'), 'utf8')) !==
            '#!/bin/sh\nfor arg; do last="$arg"; done\nexec /bin/sh -c "$last"\n'
        )
          throw new Error('Fake transport isolation mismatch');
        calls.push({ command, input });
        return new Promise((resolve, reject) => {
          const child = spawn(command, { shell: true, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
          let stdout = '',
            stderr = '';
          const timer = setTimeout(() => {
            child.kill();
            reject(new Error('Fake SSH expired'));
          }, 5000);
          child.stdout.on('data', (value) => {
            stdout += value;
          });
          child.stderr.on('data', (value) => {
            stderr += value;
          });
          child.on('error', reject);
          child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) resolve({ stdout });
            else reject(new Error(stderr));
          });
          child.stdin.end(input);
        });
      },
    };
  }
  const directory = () => join(privateRoot, SESSION, INCARNATION);
  async function provision(input = material) {
    return provisionRemoteInputBroker(remote, input, authority(), { root: privateRoot, transport: runner() });
  }

  it('plans the exact remote directory without creating a pane or private files', async () => {
    const result = await provisionRemoteInputBroker(remote, material, authority(), {
      root: privateRoot,
      transport: runner(),
      planOnly: true,
    });
    expect(result).toEqual({ status: 'planned', directory: directory(), incarnation: INCARNATION });
    await expect(fs.stat(privateRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(environment.FAKE_STATE!)).rejects.toMatchObject({ code: 'ENOENT' });
    const operations = (await fs.readFile(environment.FAKE_LOG!, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(operations).toEqual([['-L', 'codeman-remote', 'has-session', '-t', 'codeman-ssh-aaaaaaaa']]);
  });

  it.each(['foreign-incarnation', 'uncanonical-directory', 'extra-fields', 'wrong-root'] as const)(
    'rejects a malformed read-only %s plan before any second provisioning',
    async (kind) => {
      const value = { status: 'planned', directory: directory(), incarnation: INCARNATION } as Record<string, unknown>;
      if (kind === 'foreign-incarnation') value.incarnation = SESSION;
      if (kind === 'uncanonical-directory') value.directory = privateRoot + '/./' + SESSION + '/' + INCARNATION;
      if (kind === 'extra-fields') value.pane = {};
      if (kind === 'wrong-root') value.directory = '/foreign/' + SESSION + '/' + INCARNATION;
      const run = vi.fn(async () => ({
        stdout: 'CODEMAN_REMOTE_BROKER_V1:' + Buffer.from(JSON.stringify(value)).toString('base64') + '\n',
      }));
      expect(
        await provisionRemoteInputBroker(remote, material, authority(), {
          root: privateRoot,
          transport: { run },
          planOnly: true,
        })
      ).toEqual({ status: 'not-sent' });
      expect(run).toHaveBeenCalledOnce();
      await expect(fs.stat(privateRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );

  it('provisions a new inert exact pane with private exclusive files and no CLI/input launch', async () => {
    const result = await provision();
    expect(result).toEqual({
      status: 'provisioned',
      directory: directory(),
      incarnation: INCARNATION,
      pane: { sessionId: '$17', paneId: '%9', panePid: 9009, serverPid: 17000 },
    });
    expect(await fs.readFile(join(directory(), 'config.json'), 'utf8')).toBe(material.configJson);
    expect(await fs.readFile(join(directory(), 'broker.py'), 'utf8')).toBe(material.source);
    for (const path of [privateRoot, join(privateRoot, SESSION), directory()])
      expect((await fs.stat(path)).mode & 0o777).toBe(0o700);
    for (const path of ['config.json', 'broker.py', 'lock'])
      expect((await fs.stat(join(directory(), path))).mode & 0o777).toBe(0o600);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).not.toContain(secret);
    expect(calls[0].command).not.toContain(material.configJson);
    expect(calls[0].input).toContain(secret);
    const operations = await fs.readFile(environment.FAKE_LOG!, 'utf8');
    expect(operations).not.toMatch(/send-keys|respawn-pane|"-s", "escape-time"/);
    expect(operations).not.toContain(secret);
  });

  it('an existing remote session never provisions or rewrites a broker', async () => {
    await fs.writeFile(environment.FAKE_STATE!, '{}');
    await fs.mkdir(directory(), { recursive: true });
    await fs.writeFile(join(directory(), 'config.json'), 'existing private config');
    expect(await provision()).toEqual({ status: 'existing' });
    expect(await fs.readFile(join(directory(), 'config.json'), 'utf8')).toBe('existing private config');
    expect((await fs.readFile(environment.FAKE_LOG!, 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it('missing Python leaves the missing pane and home untouched', async () => {
    await fs.writeFile(join(bin, 'python3'), '#!/bin/sh\nexit 127\n', { mode: 0o700 });
    expect(await provision()).toEqual({ status: 'unsupported' });
    await expect(fs.stat(environment.FAKE_STATE!)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(privateRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['platform', 'proc'] as const)(
    'unsupported %s capability refuses before any inert pane or private file',
    async (kind) => {
      const source =
        kind === 'platform'
          ? 'import sys; sys.platform="darwin"; exec(sys.argv[1])'
          : 'import os,sys; original=os.open; os.open=lambda path,*args: (_ for _ in ()).throw(OSError("no process proof")) if path=="/proc/self/stat" else original(path,*args); exec(sys.argv[1])';
      await fs.writeFile(
        join(bin, 'python3'),
        '#!/bin/sh\n[ "$1" = "-c" ] || exit 91\nexec /usr/bin/python3 -c ' +
          "'" +
          source.replace(/'/g, "'\\''") +
          "'" +
          ' "$2"\n',
        { mode: 0o700 }
      );
      expect(await provision()).toEqual({ status: 'unsupported' });
      await expect(fs.stat(environment.FAKE_STATE!)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(privateRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readFile(environment.FAKE_LOG!, 'utf8')).not.toMatch(/new-session|respawn-pane|send-keys/);
    }
  );

  it.each(['before-list', 'pid', 'dead', 'status', 'signal', 'session', 'server', 'create-race'])(
    'refuses native replacement %s before creating private files',
    async (opponent) => {
      environment.OPPONENT = opponent;
      expect((await provision()).status).toBe('unknown');
      await expect(fs.stat(privateRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );

  it('replacement after provisioning stays uncertain and never launches or reuses another incarnation', async () => {
    environment.OPPONENT = 'after-files';
    expect(await provision()).toEqual({ status: 'unknown' });
    expect(await fs.readFile(join(directory(), 'config.json'), 'utf8')).toBe(material.configJson);
    expect(await fs.readFile(environment.FAKE_LOG!, 'utf8')).not.toMatch(/send-keys|respawn-pane/);
  });

  it('an existing private incarnation is never reset, even if its pane is missing', async () => {
    await fs.mkdir(directory(), { recursive: true, mode: 0o700 });
    await fs.writeFile(join(directory(), 'config.json'), 'old credential');
    expect(await provision()).toEqual({ status: 'unknown' });
    expect(await fs.readFile(join(directory(), 'config.json'), 'utf8')).toBe('old credential');
  });

  it.each(['symlink', 'public'] as const)('refuses an unsafe %s private root', async (kind) => {
    if (kind === 'symlink') await fs.symlink(root, privateRoot);
    else await fs.mkdir(privateRoot, { mode: 0o755 });
    expect(await provision()).toEqual({ status: 'unknown' });
    await expect(fs.stat(join(root, SESSION))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(directory())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['owner', 'host', 'cancel'] as const)(
    'vetoes %s changes during authority preparation before SSH',
    async (kind) => {
      let valid = true;
      const result = await provisionRemoteInputBroker(
        remote,
        material,
        {
          isCurrent: () => valid,
          prepare: async () => {
            if (kind === 'host') remote.host = 'replacement.invalid';
            else if (kind === 'owner') remote.owned = false;
            else valid = false;
            return true;
          },
        },
        { root: privateRoot, transport: runner() }
      );
      expect(result).toEqual({ status: 'not-sent' });
      expect(calls).toEqual([]);
    }
  );

  it.each([
    'existing-extra',
    'unsupported-extra',
    'not-sent-extra',
    'provisioned-extra',
    'pane-extra',
    'dot-directory',
    'parent-directory',
    'double-slash',
    'newline-directory',
    'nul-directory',
    'foreign-root',
    'oversized-directory',
    'duplicate-record',
    'bad-base64',
  ] as const)('refuses malformed private wire response %s', async (kind) => {
    const normal = {
      status: 'provisioned',
      directory: directory(),
      incarnation: INCARNATION,
      pane: { sessionId: '$17', paneId: '%9', panePid: 9009, serverPid: 17000 },
    };
    let record: object = normal;
    if (kind.endsWith('-extra') && kind !== 'provisioned-extra' && kind !== 'pane-extra')
      record = { status: kind.slice(0, -6), unexpected: secret };
    if (kind === 'provisioned-extra') record = { ...normal, unexpected: secret };
    if (kind === 'pane-extra') record = { ...normal, pane: { ...normal.pane, secret } };
    if (kind === 'dot-directory') record = { ...normal, directory: privateRoot + '/./' + SESSION + '/' + INCARNATION };
    if (kind === 'parent-directory')
      record = { ...normal, directory: privateRoot + '/foreign/../' + SESSION + '/' + INCARNATION };
    if (kind === 'double-slash') record = { ...normal, directory: privateRoot + '//' + SESSION + '/' + INCARNATION };
    if (kind === 'newline-directory')
      record = { ...normal, directory: privateRoot + '\n/' + SESSION + '/' + INCARNATION };
    if (kind === 'nul-directory') record = { ...normal, directory: privateRoot + '\0/' + SESSION + '/' + INCARNATION };
    if (kind === 'foreign-root') record = { ...normal, directory: root + '/foreign/' + SESSION + '/' + INCARNATION };
    if (kind === 'oversized-directory')
      record = { ...normal, directory: '/' + 'x'.repeat(4097) + '/' + SESSION + '/' + INCARNATION };
    let stdout = 'CODEMAN_REMOTE_BROKER_V1:' + Buffer.from(JSON.stringify(record)).toString('base64') + '\n';
    if (kind === 'duplicate-record') stdout += stdout;
    if (kind === 'bad-base64') stdout = stdout.replace(':', ':!');
    expect(
      await provisionRemoteInputBroker(remote, material, authority(), {
        root: privateRoot,
        transport: { run: async () => ({ stdout }) },
      })
    ).toEqual({ status: 'unknown' });
  });

  it('captures immutable UTF8 material before asynchronous authority work', async () => {
    const input = { ...material, source: '# fixture 🙂\n'.repeat(4000) };
    const expected = { ...input };
    const result = await provisionRemoteInputBroker(
      remote,
      input,
      {
        isCurrent: () => true,
        prepare: async () => {
          input.incarnation = SESSION;
          input.configJson = '{}';
          input.source = 'changed';
          return true;
        },
      },
      { root: privateRoot, transport: runner() }
    );
    expect(result.status).toBe('provisioned');
    expect(await fs.readFile(join(directory(), 'broker.py'), 'utf8')).toBe(expected.source);
    expect(await fs.readFile(join(directory(), 'config.json'), 'utf8')).toBe(expected.configJson);
  });

  it('a pure scope change after remote preparation cannot expose a launch receipt', async () => {
    let valid = true;
    const fake = runner();
    const result = await provisionRemoteInputBroker(
      remote,
      material,
      { prepare: async () => true, isCurrent: () => valid },
      {
        root: privateRoot,
        transport: {
          run: async (...args) => {
            const value = await fake.run(...args);
            valid = false;
            return value;
          },
        },
      }
    );
    expect(result).toEqual({ status: 'unknown' });
    expect(await fs.readFile(join(directory(), 'config.json'), 'utf8')).toBe(material.configJson);
  });

  it('an unexpected async current callback refuses without leaking a rejection or starting SSH', async () => {
    const result = await provisionRemoteInputBroker(
      remote,
      material,
      {
        prepare: async () => true,
        isCurrent: (() => Promise.reject(new Error('invalid callback'))) as unknown as () => boolean,
      },
      { root: privateRoot, transport: runner() }
    );
    expect(result).toEqual({ status: 'not-sent' });
    expect(calls).toEqual([]);
  });

  it('stops before any process if a fake wrapper was replaced', async () => {
    await fs.writeFile(join(bin, 'ssh'), '#!/bin/sh\nexit 99\n');
    expect(await provision()).toEqual({ status: 'unknown' });
    expect(calls).toEqual([]);
    await expect(fs.stat(environment.FAKE_LOG!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a lost transport response remains unknown with no fresh fallback', async () => {
    expect(
      await provisionRemoteInputBroker(remote, material, authority(), {
        root: privateRoot,
        transport: {
          run: async () => {
            throw new Error('lost reply');
          },
        },
      })
    ).toEqual({ status: 'unknown' });
  });

  it.each(['wrong-session', 'wrong-incarnation', 'oversized', 'invalid-utf8'] as const)(
    'rejects malformed material %s without any transport',
    async (kind) => {
      const value = {
        ...material,
        ...(kind === 'wrong-session' ? { sessionId: INCARNATION } : {}),
        ...(kind === 'wrong-incarnation' ? { incarnation: SESSION } : {}),
        ...(kind === 'oversized' ? { source: 'x'.repeat(262_145) } : {}),
        ...(kind === 'invalid-utf8' ? { source: '\ud800' } : {}),
      };
      expect(await provision(value)).toEqual({ status: 'not-sent' });
      expect(calls).toEqual([]);
    }
  );
});

describe('source-host manager lease delegation', () => {
  const releases: (() => void)[] = [];
  afterEach(async () => {
    releases.splice(0).forEach((release) => release());
    await Promise.resolve();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  function fixture() {
    const issuer = {
      directory: '/isolated/manager',
      sessionId: '66666666-7777-8888-9999-aaaaaaaaaaaa',
      incarnation: INCARNATION,
      proof: { private: 'manager-only' },
      files: [{ path: '/isolated/users.json' }],
      paths: [],
    };
    const binding: RemoteWorkerLeaseBinding = {
      sessionId: SESSION,
      incarnation: INCARNATION,
      conversationId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
      action: 'input',
      fullPayloadHash: 'a'.repeat(64),
      allowedPhaseHashes: ['b'.repeat(64), 'c'.repeat(64)],
      native: {
        kind: 'input',
        paneId: '%9',
        brokerPid: 9009,
        childPid: 9010,
        brokerStart: '12345',
        childStart: '12346',
      },
    };
    const calls: string[] = [];
    let readyCallback: (() => void) | undefined,
      terminated = 0,
      pending = false;
    const transport: SourceHostLeaseTransport = {
      start: (_helper, _directory, input) => {
        calls.push(input);
        const request = JSON.parse(input);
        let close!: () => void, resolve!: (value: { status: 'ready'; nonce: string; wallDeadline: number }) => void;
        const closed = new Promise<void>((done) => {
          close = done;
        });
        const ready = new Promise<{ status: 'ready'; nonce: string; wallDeadline: number }>((done) => {
          resolve = done;
        });
        releases.push(close);
        readyCallback = () =>
          resolve({ status: 'ready', nonce: request.nonce, wallDeadline: Date.now() + request.durationMs });
        if (!pending) readyCallback();
        return {
          ready,
          closed,
          terminate: () => {
            terminated++;
          },
        };
      },
    };
    return {
      issuer,
      binding,
      calls,
      transport,
      terminateCount: () => terminated,
      pending: () => {
        pending = true;
      },
      ready: () => readyCallback?.(),
      waitUntilStarted: async () => {
        for (let turn = 0; turn < 10 && calls.length === 0; turn++) await Promise.resolve();
        expect(calls).toHaveLength(1);
      },
    };
  }
  const authority = () => ({ prepare: async () => true, isCurrent: () => true });
  const options = (transport: SourceHostLeaseTransport) => ({
    helper: '# trusted frozen broker source',
    durationMs: 200,
    transport,
  });

  it('mints an immutable phase-bound worker claim only after the private manager lease is ready', async () => {
    const f = fixture();
    const result = await withRemoteBrokerIssuerLease(
      f.issuer,
      f.binding,
      authority(),
      async (claim) => {
        expect(claim).toMatchObject(f.binding);
        expect(claim.managerSessionId).toBe(f.issuer.sessionId);
        expect(claim.managerIncarnation).toBe(f.issuer.incarnation);
        expect(claim.nonce).toMatch(/^[a-f0-9-]{36}$/);
        expect(claim.deadline).toBeGreaterThan(claim.issuedAt);
        expect(claim.deadline - claim.issuedAt).toBeLessThanOrEqual(200);
        expect(Object.isFrozen(claim)).toBe(true);
        expect(Object.isFrozen(claim.allowedPhaseHashes)).toBe(true);
        expect(Object.isFrozen(claim.native)).toBe(true);
        expect(JSON.stringify(claim)).not.toContain('manager-only');
        expect(JSON.stringify(claim)).not.toContain(f.issuer.directory);
        expect(JSON.stringify(claim)).not.toContain('/isolated/users.json');
        return 'sent';
      },
      options(f.transport)
    );
    expect(result).toBe('sent');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toContain(f.issuer.directory);
    expect(f.terminateCount()).toBe(0);
  });

  it.each(['input', 'startup'] as const)('accepts canonical multi-digit native IDs for %s scope', async (kind) => {
    const f = fixture();
    if (kind === 'startup') {
      f.binding.action = 'restart';
      f.binding.allowedPhaseHashes = [f.binding.fullPayloadHash];
      f.binding.native = { kind: 'startup', muxSessionId: '$17', paneId: '%19', panePid: 9009, serverPid: 17000 };
    } else f.binding.native.paneId = '%19';
    expect(
      await withRemoteBrokerIssuerLease(f.issuer, f.binding, authority(), async () => 'sent', options(f.transport))
    ).toBe('sent');
  });

  it.each(['owner', 'grant', 'worker', 'phase'] as const)(
    'vetoes %s changes during private manager validation before SSH',
    async (kind) => {
      const f = fixture();
      f.pending();
      let current = true,
        effects = 0;
      const result = withRemoteBrokerIssuerLease(
        f.issuer,
        f.binding,
        { prepare: async () => true, isCurrent: () => current },
        async () => {
          effects++;
          return 'sent';
        },
        options(f.transport)
      );
      await f.waitUntilStarted();
      if (kind === 'worker' && f.binding.native.kind === 'input') f.binding.native.brokerPid = 9011;
      else if (kind === 'phase') (f.binding.allowedPhaseHashes as string[])[0] = 'd'.repeat(64);
      else if (kind === 'grant') f.issuer.files[0].path = '/isolated/replaced-users.json';
      else current = false;
      f.ready();
      expect(await result).toBe('not-sent');
      expect(effects).toBe(0);
      expect(f.terminateCount()).toBe(1);
    }
  );

  it.skipIf(process.platform !== 'linux')(
    'the real fake Python lease holds its kernel lock through EOF and a lost SSH receipt',
    async () => {
      const root = await fs.mkdtemp(join(tmpdir(), 'codeman-source-lease-'));
      const f = fixture();
      f.issuer.directory = root;
      f.issuer.files = [];
      const lock = join(root, 'lock');
      await fs.writeFile(lock, '', { mode: 0o600 });
      const helper = String.raw`import fcntl,json,os,sys,time
request=json.loads(sys.stdin.buffer.readline(98305))
assert request['issuer']['directory']==sys.argv[2]
fd=os.open(os.path.join(sys.argv[2],'lock'),os.O_RDWR|os.O_NOFOLLOW)
fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
deadline=time.monotonic()+request['durationMs']/1000
assert sys.stdin.buffer.read(1)==b''
eof_at=time.monotonic()
# Linux flock locks belong to open file descriptions: a separate open in this
# process must conflict too, without starting a probe process inside the lease.
probe_fd=os.open(os.path.join(sys.argv[2],'lock'),os.O_RDWR|os.O_NOFOLLOW)
blocked=False
try:
 try:fcntl.flock(probe_fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except BlockingIOError:blocked=True
finally:os.close(probe_fd)
blocked_at=time.monotonic()
assert blocked and eof_at<=blocked_at<deadline
def trace(name,value):
 path=os.path.join(sys.argv[2],name)
 with open(path+'.pending','w') as output:json.dump(value,output)
 os.replace(path+'.pending',path)
trace('held',{'eof':True,'blocked':blocked,'eofAt':eof_at,'blockedAt':blocked_at,'deadline':deadline,'durationMs':request['durationMs']})
print(json.dumps({'status':'ready','nonce':request['nonce'],'wallDeadline':int(time.time()*1000+(deadline-time.monotonic())*1000)}),flush=True)
while time.monotonic()<deadline:time.sleep(.005)
os.close(fd)
trace('released',{'at':time.monotonic(),'deadline':deadline})
`;
      const environment = { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8' };
      let finished: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
      const realTransport = createSourceHostLeaseTransport((source, directory) => {
        if (source !== helper || directory !== root) throw new Error('Fake lease isolation mismatch');
        const child = spawn('/usr/bin/python3', ['-c', source, '--lease', directory], {
          env: environment,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        finished = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
        return child;
      });
      let terminateCount = 0;
      const transport: SourceHostLeaseTransport = {
        start: (source, directory, input) => {
          const lease = realTransport.start(source, directory, input);
          return {
            ...lease,
            terminate: () => {
              terminateCount++;
              lease.terminate();
            },
          };
        },
      };
      const probe = () =>
        execFileSync(
          '/usr/bin/python3',
          [
            '-c',
            String.raw`import fcntl,os,sys
fd=os.open(sys.argv[1],os.O_RDWR)
try:
 fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);print('free')
except BlockingIOError:print('locked')
finally:os.close(fd)
`,
            lock,
          ],
          { env: environment, encoding: 'utf8', timeout: 1000 }
        ).trim();
      try {
        let dispatchCount = 0;
        expect(
          await withRemoteBrokerIssuerLease(
            f.issuer,
            f.binding,
            authority(),
            async () => {
              dispatchCount++;
              throw new Error('lost SSH reply');
            },
            { helper, transport, durationMs: 500 }
          )
        ).toBe('unknown');
        expect(dispatchCount).toBe(1);
        expect(terminateCount).toBe(0);
        expect(await finished).toEqual({ code: 0, signal: null });
        const held = JSON.parse(await fs.readFile(join(root, 'held'), 'utf8'));
        const released = JSON.parse(await fs.readFile(join(root, 'released'), 'utf8'));
        expect(held).toMatchObject({ eof: true, blocked: true, durationMs: 500 });
        expect(held.eofAt).toBeLessThanOrEqual(held.blockedAt);
        expect(held.blockedAt).toBeLessThan(held.deadline);
        expect(released.deadline).toBe(held.deadline);
        expect(released.at).toBeGreaterThanOrEqual(held.deadline);
        expect(probe()).toBe('free');
      } finally {
        if (finished) await finished;
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  );

  it('manager identity in a caller binding cannot override the validated immutable issuer', async () => {
    const f = fixture();
    Object.assign(f.binding, { managerSessionId: SESSION, managerIncarnation: SESSION });
    expect(
      await withRemoteBrokerIssuerLease(
        f.issuer,
        f.binding,
        authority(),
        async (claim) => {
          expect(claim.managerSessionId).toBe(f.issuer.sessionId);
          expect(claim.managerIncarnation).toBe(f.issuer.incarnation);
          return 'sent';
        },
        options(f.transport)
      )
    ).toBe('sent');
  });

  it('a lost SSH receipt or post-wire cancellation never terminates an issued manager lease', async () => {
    const f = fixture();
    let current = true;
    const result = await withRemoteBrokerIssuerLease(
      f.issuer,
      f.binding,
      { prepare: async () => true, isCurrent: () => current },
      async () => {
        current = false;
        throw new Error('transport reply lost');
      },
      options(f.transport)
    );
    expect(result).toBe('unknown');
    expect(f.terminateCount()).toBe(0);
  });

  it('late validation cannot reset the original budget or admit a backward wall clock', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const f = fixture();
    f.pending();
    let effects = 0;
    const result = withRemoteBrokerIssuerLease(
      f.issuer,
      f.binding,
      authority(),
      async () => {
        effects++;
        return 'sent';
      },
      options(f.transport)
    );
    await f.waitUntilStarted();
    await vi.advanceTimersByTimeAsync(201);
    f.ready();
    expect(await result).toBe('not-sent');
    expect(effects).toBe(0);
    const g = fixture();
    g.pending();
    const second = withRemoteBrokerIssuerLease(
      g.issuer,
      g.binding,
      authority(),
      async () => {
        effects++;
        return 'sent';
      },
      options(g.transport)
    );
    await g.waitUntilStarted();
    vi.setSystemTime(Date.now() - 500);
    g.ready();
    expect(await second).toBe('not-sent');
    expect(effects).toBe(0);
  });

  it('expired processes retain both pending slots until actual process cleanup', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const f = fixture();
    f.pending();
    const g = fixture();
    g.pending();
    let effects = 0;
    const first = withRemoteBrokerIssuerLease(
      f.issuer,
      f.binding,
      authority(),
      async () => {
        effects++;
        return 'sent';
      },
      options(f.transport)
    );
    const second = withRemoteBrokerIssuerLease(
      g.issuer,
      g.binding,
      authority(),
      async () => {
        effects++;
        return 'sent';
      },
      options(g.transport)
    );
    await f.waitUntilStarted();
    await g.waitUntilStarted();
    await vi.advanceTimersByTimeAsync(201);
    expect(await first).toBe('not-sent');
    expect(await second).toBe('not-sent');
    const h = fixture();
    expect(
      await withRemoteBrokerIssuerLease(
        h.issuer,
        h.binding,
        authority(),
        async () => {
          effects++;
          return 'sent';
        },
        options(h.transport)
      )
    ).toBe('not-sent');
    expect(h.calls).toEqual([]);
    expect(effects).toBe(0);
    releases.splice(0).forEach((release) => release());
    await Promise.resolve();
    await Promise.resolve();
    expect(
      await withRemoteBrokerIssuerLease(
        h.issuer,
        h.binding,
        authority(),
        async () => {
          effects++;
          return 'sent';
        },
        options(h.transport)
      )
    ).toBe('sent');
    expect(effects).toBe(1);
  });

  it('hung preparation expires without starting a lease and retains both slots until actual settlement', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const f = fixture();
    let preparations = 0,
      effects = 0;
    const pending: Array<(value: boolean) => void> = [];
    const held = {
      isCurrent: () => true,
      prepare: () => {
        preparations++;
        return new Promise<boolean>((resolve) => pending.push(resolve));
      },
    };
    const dispatch = async () => {
      effects++;
      return 'sent';
    };
    const first = withRemoteBrokerIssuerLease(f.issuer, f.binding, held, dispatch, options(f.transport));
    const second = withRemoteBrokerIssuerLease(f.issuer, f.binding, held, dispatch, options(f.transport));
    const completed: string[] = [];
    void first.then((result) => completed.push(result));
    void second.then((result) => completed.push(result));
    expect(preparations).toBe(2);
    const rejected = withRemoteBrokerIssuerLease(f.issuer, f.binding, held, dispatch, options(f.transport));
    expect(preparations).toBe(2);
    expect(await rejected).toBe('not-sent');
    await vi.advanceTimersByTimeAsync(201);
    expect(completed).toEqual(['not-sent', 'not-sent']);
    expect(await first).toBe('not-sent');
    expect(await second).toBe('not-sent');
    expect(f.calls).toEqual([]);
    expect(effects).toBe(0);
    expect(await withRemoteBrokerIssuerLease(f.issuer, f.binding, held, dispatch, options(f.transport))).toBe(
      'not-sent'
    );
    expect(preparations).toBe(2);
    pending[0](true);
    pending[1](false);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.calls).toEqual([]);
    expect(effects).toBe(0);
    expect(await withRemoteBrokerIssuerLease(f.issuer, f.binding, authority(), dispatch, options(f.transport))).toBe(
      'sent'
    );
    expect(effects).toBe(1);
  });

  it('healthy delayed preparation consumes the original budget before the lease is ready', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const f = fixture();
    let resolve!: (value: boolean) => void;
    const started = Date.now();
    const result = withRemoteBrokerIssuerLease(
      f.issuer,
      f.binding,
      {
        isCurrent: () => true,
        prepare: () =>
          new Promise<boolean>((done) => {
            resolve = done;
          }),
      },
      async (claim) => {
        expect(claim.deadline).toBeLessThanOrEqual(started + 200);
        expect(claim.deadline - claim.issuedAt).toBeLessThanOrEqual(115);
        return 'sent';
      },
      options(f.transport)
    );
    await vi.advanceTimersByTimeAsync(80);
    expect(f.calls).toEqual([]);
    resolve(true);
    expect(await result).toBe('sent');
    expect(f.calls).toHaveLength(1);
  });

  it.each([
    'too-many-phases',
    'hash',
    'same-session',
    'helper-utf8',
    'null-birth',
    'zero-birth',
    'leading-birth',
  ] as const)('refuses invalid private lease scope %s before starting any process', async (kind) => {
    const f = fixture();
    if (kind === 'too-many-phases') f.binding.allowedPhaseHashes = Array(10).fill('a'.repeat(64));
    if (kind === 'hash') f.binding.fullPayloadHash = 'bad';
    if (kind.endsWith('-birth') && f.binding.native.kind === 'input')
      f.binding.native.brokerStart = (kind === 'null-birth'
        ? null
        : kind === 'zero-birth'
          ? '0'
          : '0123') as unknown as string;
    if (kind === 'same-session') f.binding.sessionId = f.issuer.sessionId;
    let effects = 0;
    const settings = options(f.transport);
    if (kind === 'helper-utf8') settings.helper = '\ud800';
    expect(
      await withRemoteBrokerIssuerLease(
        f.issuer,
        f.binding,
        authority(),
        async () => {
          effects++;
          return 'sent';
        },
        settings
      )
    ).toBe('not-sent');
    expect(f.calls).toEqual([]);
    expect(effects).toBe(0);
  });
});
