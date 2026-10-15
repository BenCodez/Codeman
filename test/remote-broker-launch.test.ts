/** Real disposable Python broker/child behind verified fake SSH and tmux executables. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CodexInputBroker } from '../src/recovery/codex-input-broker.js';
import { OwnedRemoteBrokerCache } from '../src/recovery/remote-input-broker-cache.js';
import { observeOwnedRemoteBroker } from '../src/recovery/remote-broker-launch.js';
import type { RemoteBrokerTransport } from '../src/recovery/remote-input-broker.js';
import type { SessionRemote } from '../src/types.js';

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SHIM = '#!/bin/sh\nfor arg; do last="$arg"; done\nexec /bin/sh -c "$last"\n';
const NATIVE = String.raw`#!/usr/bin/python3
import hashlib,json,os,re,shlex,subprocess,sys
a=sys.argv[1:];assert a[:2]==['-L','codeman-remote']
root=os.environ['FAKE_ROOT'];file=os.path.join(root,'native.json')
with open(file) as f:s=json.load(f)
with open(os.path.join(root,'native.log'),'a') as f:f.write(json.dumps(a)+'\n')
if a[2]=='if-shell':
 assert a[3:5]==['-F','-t'] and a[8]=='display-message -p CODEMAN_BROKER_LAUNCH_REFUSED'
 terms=re.findall(r'#\{==:#\{([a-z_]+)\},([^{}]*)\}',a[6]);assert len(terms)==10
 expr='#{==:#{'+terms[0][0]+'},'+terms[0][1]+'}'
 for k,v in terms[1:]:expr='#{&&:'+expr+',#{==:#{'+k+'},'+v+'}}'
 assert expr==a[6]
 opponent=os.environ.get('OPPONENT')
 if opponent in s:s[opponent]='replacement'
 if a[5]!=s['pane_id'] or not all(str(s.get(k))==v for k,v in terms):
  print('CODEMAN_BROKER_LAUNCH_REFUSED');sys.exit(0)
 cmd=shlex.split(a[7]);assert cmd[:6]==['respawn-pane','-c','/tmp','-t','%9','env'] and cmd[6]=='CODEX_HOME='+root and cmd[7]=='python3'
 assert cmd[8].endswith('/broker.py') and cmd[9]==os.path.dirname(cmd[8])
 assert len(cmd)==11 and cmd[10]==hashlib.sha256(open(os.path.join(cmd[9],'config.json'),'rb').read()).hexdigest()
 if opponent=='config-after-guard':
  config=os.path.join(cmd[9],'config.json')
  with open(config) as f:value=json.load(f)
  value['command']='printf wrong > '+shlex.quote(os.path.join(root,'wrong-command'))
  value['launchDigest']=hashlib.sha256(value['command'].encode()).hexdigest()
  with open(config,'w') as f:json.dump(value,f)
 fifo=os.open(os.path.join(root,'input.fifo'),os.O_RDWR|os.O_NONBLOCK)
 log=os.open(os.path.join(root,'broker.log'),os.O_CREAT|os.O_WRONLY,0o600)
 env=dict(os.environ);env['CODEX_HOME']=root
 child=subprocess.Popen(['/usr/bin/python3',cmd[8],cmd[9],cmd[10]],stdin=fifo,stdout=log,stderr=log,env=env,close_fds=True)
 s['pane_pid']=str(child.pid);s['pane_dead']='0';s['pane_dead_status']='';s['pane_dead_signal']=''
 with open(file,'w') as f:json.dump(s,f)
 os.close(fifo);os.close(log)
elif a[2]=='list-panes':
 assert a[3:]==['-t','codeman-ssh-aaaaaaaa','-F','#{session_name}|#{pane_id}|#{pane_pid}|#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}']
 if os.environ.get('OPPONENT')=='after-launch':s['pane_pid']='1234'
 print('|'.join(s[k] for k in ['session_name','pane_id','pane_pid','pane_dead','pane_dead_status','pane_dead_signal']))
else:raise AssertionError('Forbidden real-effect native command '+repr(a))
`;
const FAKE_CHILD = String.raw`
import os,select,sys,termios,tty
tty.setraw(0,termios.TCSANOW)
root=sys.argv[1]
fd=os.open(os.path.join(root,'bytes'),os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)
while not os.path.exists(os.path.join(root,'stop')):
 if select.select([0],[],[],.01)[0]:
  b=os.read(0,65536)
  if not b:break
  os.write(fd,b)
os.close(fd)
`;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
let root: string, bin: string, directory: string;
let material: ReturnType<typeof CodexInputBroker.provisioningMaterial>;
let descriptor: NonNullable<Awaited<ReturnType<OwnedRemoteBrokerCache['prepare']>>>;
let remote: SessionRemote, environment: NodeJS.ProcessEnv, cache: OwnedRemoteBrokerCache;
let calls: { command: string; input: string }[];
const pane = { sessionId: '$17', paneId: '%9', panePid: 9009, serverPid: 17000 };
const quote = (text: string) => `'${text.replace(/'/g, `'"'"'`)}'`;
const authority = () => ({ prepare: async () => true, isCurrent: () => true });
async function eventually(check: () => Promise<boolean>, budget = 3000) {
  const deadline = performance.now() + budget;
  while (!(await check())) {
    if (performance.now() >= deadline) throw new Error('Disposable fixture deadline');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function transport(): RemoteBrokerTransport {
  return {
    run: async (command, input) => {
      expect(environment.SHELL).toBe(join(bin, 'login-shell'));
      expect(environment.PATH).toBe(`${bin}:/usr/bin:/bin`);
      expect(await fs.readFile(join(bin, 'ssh'), 'utf8')).toBe(SHIM);
      expect(await fs.readFile(join(bin, 'login-shell'), 'utf8')).toBe(SHIM);
      expect(await fs.readFile(join(bin, 'tmux'), 'utf8')).toBe(NATIVE);
      calls.push({ command, input });
      return new Promise((resolve, reject) => {
        const child = spawn(command, { shell: true, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '',
          stderr = '';
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('Fake SSH deadline'));
        }, 5000);
        child.stdout.on('data', (bytes) => {
          stdout += bytes;
        });
        child.stderr.on('data', (bytes) => {
          stderr += bytes;
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
const scope = () => ({ sessionId: SID, remote, workingDir: remote.remotePath, codexHome: root });
const launch = () =>
  observeOwnedRemoteBroker(remote, { sessionId: SID, descriptor, codexHome: root, pane }, authority(), {
    transport: transport(),
  });
beforeEach(async () => {
  root = await fs.mkdtemp(join(homedir(), "owned-ssh-launch-' $literal `tick` -"));
  bin = join(root, 'bin');
  await fs.mkdir(bin);
  await fs.symlink(process.execPath, join(bin, 'node'));
  await fs.writeFile(join(bin, 'ssh'), SHIM, { mode: 0o700 });
  await fs.writeFile(join(bin, 'login-shell'), SHIM, { mode: 0o700 });
  await fs.writeFile(join(bin, 'tmux'), NATIVE, { mode: 0o700 });
  await fs.writeFile(join(root, 'fake-child.py'), FAKE_CHILD);
  // The fixture FIFO is created by an inert isolated Python utility, never tmux.
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/python3', [
      '-c',
      'import os,sys;os.mkfifo(sys.argv[1],0o600)',
      join(root, 'input.fifo'),
    ]);
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('Fake FIFO unavailable'))));
  });
  material = CodexInputBroker.provisioningMaterial(
    SID,
    `exec /usr/bin/python3 -u ${quote(join(root, 'fake-child.py'))} ${quote(root)}`,
    root
  );
  directory = join(root, 'remote-private', SID, material.config.incarnation);
  await fs.mkdir(join(root, 'remote-private'), { mode: 0o700 });
  await fs.mkdir(join(root, 'remote-private', SID), { mode: 0o700 });
  await fs.mkdir(directory, { mode: 0o700 });
  for (const [file, text] of [
    ['config.json', JSON.stringify(material.config)],
    ['broker.py', material.helper],
    ['lock', ''],
  ])
    await fs.writeFile(join(directory, file), text, { mode: 0o600, flag: 'wx' });
  remote = {
    hostId: 'fixture',
    label: 'Fixture',
    host: 'worker.invalid',
    username: 'runner',
    port: 22,
    remotePath: root,
    owned: true,
  };
  cache = new OwnedRemoteBrokerCache(join(root, 'source-private'));
  descriptor = (await cache.prepare(scope(), material, directory))!;
  expect(descriptor).toBeDefined();
  await fs.writeFile(
    join(root, 'native.json'),
    JSON.stringify({
      session_name: 'codeman-ssh-aaaaaaaa',
      session_id: '$17',
      pane_id: '%9',
      pane_pid: '9009',
      pid: '17000',
      pane_dead: '1',
      pane_dead_status: '1',
      pane_dead_signal: '',
      window_panes: 1,
      session_windows: 1,
    })
  );
  environment = {
    ...process.env,
    HOME: root,
    SHELL: join(bin, 'login-shell'),
    PATH: `${bin}:/usr/bin:/bin`,
    FAKE_ROOT: root,
  };
  for (const key of Object.keys(environment))
    if (key.startsWith('SSH_') || ['TMUX', 'CODEX_HOME', 'CODEMAN_MUX', 'CODEMAN_TMUX_SOCKET'].includes(key))
      delete environment[key];
  calls = [];
});
afterEach(async () => {
  await fs.writeFile(join(root, 'stop'), 'stop');
  const exists = await fs.readFile(join(directory, 'state.json'), 'utf8').catch(() => undefined);
  if (exists) {
    await eventually(async () => {
      const state = JSON.parse(await fs.readFile(join(directory, 'state.json'), 'utf8'));
      return state.closed === true || state.startup.status === 'not-sent';
    });
  }
  await fs.rm(root, { recursive: true, force: true });
});

it('launches only the exact inert pane and seeds signed Unicode owner input without local PID adoption', async () => {
  const observed = await launch();
  expect(observed.status, await fs.readFile(join(root, 'broker.log'), 'utf8').catch(() => 'no fake broker log')).toBe(
    'observed'
  );
  if (observed.status !== 'observed') return;
  const proof = cache.observe(scope(), descriptor.incarnation, observed.serialized, observed.witness, observed.panePid);
  expect(proof).toMatchObject({ closed: false, rawGeneration: 0, homeDigest: hash(root) });
  const signer = cache.signer(scope(), descriptor.incarnation)!;
  const input = 'Pasted 😀\nsecond line\r';
  const frame = signer.frame('owner-mux', input)!;
  await fs.writeFile(join(root, 'input.fifo'), frame.data);
  const receipt = await observeOwnedRemoteBroker(
    remote,
    { sessionId: SID, descriptor, receipt: frame.receipt },
    authority(),
    { transport: transport() }
  );
  expect(receipt.status).toBe('observed');
  if (receipt.status !== 'observed') return;
  expect(
    cache.observe(scope(), descriptor.incarnation, receipt.serialized, receipt.witness, receipt.panePid)
  ).toBeDefined();
  await eventually(async () => (await fs.readFile(join(root, 'bytes'), 'utf8')) === input);
  expect(calls).toHaveLength(2);
  expect(
    calls.every(
      (call) => !call.command.includes(material.config.secret) && !call.input.includes(material.config.secret)
    )
  ).toBe(true);
});

it.each([
  'session_name',
  'session_id',
  'pane_id',
  'pane_pid',
  'pane_dead',
  'pane_dead_status',
  'pane_dead_signal',
  'pid',
  'window_panes',
  'session_windows',
])('certifies no launch when native %s changed before the atomic queue', async (opponent) => {
  environment.OPPONENT = opponent;
  expect(await launch()).toEqual({ status: 'not-sent' });
  expect(await fs.readFile(join(directory, 'state.json'), 'utf8').catch(() => undefined)).toBeUndefined();
});
it.each(['config', 'helper', 'private-mode', 'symlink', 'startup-issuer', 'startup-expiry'])(
  'rejects %s before any broker child launch',
  async (opponent) => {
    if (opponent === 'config') await fs.writeFile(join(directory, 'config.json'), '{}');
    if (opponent === 'helper') await fs.appendFile(join(directory, 'broker.py'), '\n# changed');
    if (opponent === 'private-mode') await fs.chmod(join(directory, 'config.json'), 0o644);
    if (opponent === 'symlink') {
      await fs.rename(join(directory, 'config.json'), join(directory, 'old'));
      await fs.symlink(join(directory, 'old'), join(directory, 'config.json'));
    }
    if (opponent.startsWith('startup-')) {
      const config = structuredClone(material.config);
      if (opponent === 'startup-issuer') config.startup.issuer = {} as never;
      else config.startup.monotonicDeadline = 1;
      await fs.writeFile(join(directory, 'config.json'), JSON.stringify(config));
    }
    expect(await launch()).toEqual({ status: 'not-sent' });
    expect(await fs.readFile(join(root, 'native.log'), 'utf8').catch(() => '')).toBe('');
  }
);
it('keeps lost post-launch responses uncertain and does not automatically replay', async () => {
  const runner = transport();
  const result = await observeOwnedRemoteBroker(
    remote,
    { sessionId: SID, descriptor, codexHome: root, pane },
    authority(),
    {
      transport: {
        run: async (command, input) => {
          await runner.run(command, input);
          throw new Error('Lost receipt');
        },
      },
    }
  );
  expect(result).toEqual({ status: 'unknown' });
  expect(calls).toHaveLength(1);
  expect(
    (await fs.readFile(join(root, 'native.log'), 'utf8')).split('\n').filter((line) => line.includes('if-shell'))
  ).toHaveLength(1);
});
it('never treats a live replacement as the new controlled broker', async () => {
  environment.OPPONENT = 'after-launch';
  expect(await launch()).toEqual({ status: 'unknown' });
});
it('pins startup config bytes across the last native queue and Python child fork', async () => {
  environment.OPPONENT = 'config-after-guard';
  expect(await launch()).toEqual({ status: 'unknown' });
  expect(await fs.stat(join(root, 'wrong-command')).catch(() => undefined)).toBeUndefined();
});
it('retains the same signer and owner counters across passive attachment observations', async () => {
  const first = await launch();
  expect(first.status).toBe('observed');
  if (first.status !== 'observed') return;
  cache.observe(scope(), descriptor.incarnation, first.serialized, first.witness, first.panePid);
  const signer = cache.signer(scope(), descriptor.incarnation)!;
  expect(signer.frame('owner-key', '\t')).toBeDefined();
  const passive = await observeOwnedRemoteBroker(remote, { sessionId: SID, descriptor, inspect: true }, authority(), {
    transport: transport(),
  });
  expect(passive.status).toBe('observed');
  if (passive.status !== 'observed') return;
  expect(
    cache.observe(scope(), descriptor.incarnation, passive.serialized, passive.witness, passive.panePid)
  ).toBeUndefined();
  expect(cache.signer(scope(), descriptor.incarnation)).toBe(signer);
  expect(signer.frame('owner-key', '\t')?.receipt.counter).toBe(2);
});
it('checks cancellation after awaited preparation before opening the SSH transport', async () => {
  let current = true;
  expect(
    await observeOwnedRemoteBroker(
      remote,
      { sessionId: SID, descriptor, codexHome: root, pane },
      {
        prepare: async () => {
          current = false;
          return true;
        },
        isCurrent: () => current,
      },
      { transport: transport() }
    )
  ).toEqual({ status: 'not-sent' });
  expect(calls).toEqual([]);
});
