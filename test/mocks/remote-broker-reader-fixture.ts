/** Actual disposable broker/child, generated Node reader and strict fake native tmux; no SSH or CLI. */
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CodexInputBroker } from '../../src/recovery/codex-input-broker.js';
import { OwnedRemoteBrokerCache } from '../../src/recovery/remote-input-broker-cache.js';
import {
  buildRemoteCodexEvidenceCommand,
  buildRemoteCodexInputCommand,
  parseRemoteCodexEvidence,
  parseRemoteCodexInputResult,
  restartRemoteCodexPane,
  restoreRemoteCodexWorker,
  type RemoteCodexInputRequest,
} from '../../src/recovery/remote-codex.js';
import type { SessionRemote } from '../../src/types.js';
import { guardedNativeTmuxFixture } from './remote-native-tmux.js';

const exec = promisify(execFile);
const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CID = '11111111-2222-3333-4444-555555555555';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const quote = (text: string) => `'${text.replace(/'/g, `'"'"'`)}'`;
export async function remoteBrokerReaderFixture() {
  const root = await fs.mkdtemp(join(homedir(), 'remote-reader-broker-'));
  const home = join(root, 'home'),
    bin = join(root, 'bin'),
    sessions = join(home, 'sessions');
  const bytes = join(root, 'bytes'),
    fifo = join(root, 'input'),
    effects = join(root, 'effects');
  await fs.mkdir(sessions, { recursive: true });
  await fs.mkdir(bin);
  await fs.writeFile(bytes, '');
  await fs.writeFile(effects, '');
  const paneFile = join(root, 'pane');
  const at = Date.now();
  const rollout = join(sessions, `rollout-fixture-${CID}.jsonl`);
  const tail =
    JSON.stringify({
      type: 'session_meta',
      payload: { id: CID, cwd: root, timestamp: new Date(at - 10000).toISOString(), originator: 'codeman_' + SID },
    }) +
    '\n' +
    JSON.stringify({ type: 'event_msg', payload: { type: 'turn_aborted' } }) +
    '\n';
  await fs.writeFile(rollout, tail);
  await fs.writeFile(
    join(home, 'history.jsonl'),
    JSON.stringify({ session_id: CID, ts: at / 1000, text: 'owner prompt' }) + '\n'
  );
  const child = join(root, 'child.py');
  await fs.writeFile(
    child,
    String.raw`import os,select,sys,termios,tty
tty.setraw(0,termios.TCSANOW)
root=sys.argv[1]
with open(root+'/starts','a') as f:f.write('1\n')
open(root+'/ready','w').close()
fd=os.open(root+'/bytes',os.O_WRONLY|os.O_APPEND)
while not os.path.exists(root+'/stop'):
 if select.select([0],[],[],.01)[0]:
  data=os.read(0,65536)
  if not data:break
  os.write(fd,data)
os.close(fd)
sys.exit(int(open(root+'/exit-status').read()) if os.path.exists(root+'/exit-status') else 0)
`
  );
  const broker = await CodexInputBroker.create(
    join(root, 'private', SID),
    SID,
    `exec /usr/bin/python3 -u ${quote(child)} ${quote(root)}`,
    home,
    root
  );
  await fs.writeFile(
    join(bin, 'codex'),
    '#!/bin/sh\nexec /usr/bin/python3 -u ' + quote(child) + ' ' + quote(root) + '\n',
    { mode: 0o700 }
  );
  const configText = await fs.readFile(join(broker.directory, 'config.json'), 'utf8');
  const config = JSON.parse(configText);
  const material = { config, helper: await fs.readFile(join(broker.directory, 'broker.py'), 'utf8') };
  const processEnv = { PATH: '/usr/bin:/bin', HOME: root, CODEX_HOME: home, LANG: 'C.UTF-8' };
  const worker = spawn('/usr/bin/python3', [join(broker.directory, 'broker.py'), broker.directory, hash(configText)], {
    env: processEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  worker.stdin.on('error', () => {});
  worker.stdout.resume();
  let diagnostics = '';
  worker.stderr.on('data', (b) => {
    diagnostics += b.toString();
  });
  const closed = new Promise<void>((resolve) => worker.on('close', () => resolve()));
  const wait = async (check: () => Promise<boolean>) => {
    const end = performance.now() + 3000;
    while (!(await check())) {
      if (performance.now() >= end) throw Error('Disposable broker did not settle: ' + diagnostics);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  await wait(() =>
    fs.access(join(root, 'ready')).then(
      () => true,
      () => false
    )
  );
  await fs.writeFile(paneFile, '0|||%7|' + worker.pid + '\n');
  const remote: SessionRemote = {
    hostId: 'fake',
    label: 'Fixture',
    host: 'worker.invalid',
    remotePath: root,
    owned: true,
  };
  const scope = { sessionId: SID, remote, workingDir: root, codexHome: home };
  const cache = new OwnedRemoteBrokerCache(join(root, 'cache'));
  const descriptor = await cache.prepare(scope, material, broker.directory);
  if (!descriptor) throw Error('Pristine private cache refused');
  // Every subprocess executable is a checked temporary wrapper or an exact
  // system Python/Node path. Inherited live tmux/SSH selection is absent.
  await exec('/usr/bin/mkfifo', [fifo]);
  const fifoHandle = await fs.open(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
  let pumping = true;
  const pump = (async () => {
    const buffer = Buffer.alloc(32768);
    while (pumping) {
      try {
        const { bytesRead } = await fifoHandle.read(buffer, 0, buffer.length, null);
        if (bytesRead) worker.stdin.write(buffer.subarray(0, bytesRead));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') break;
      }
      await new Promise((r) => setTimeout(r, 2));
    }
  })();
  const shim = join(bin, 'login-shell');
  const ssh = join(bin, 'ssh');
  const delegate = join(bin, 'fake-worker');
  const native = join(bin, 'tmux');
  await fs.writeFile(
    shim,
    '#!/bin/sh\n[ "$1" = "-i" ] && [ "$2" = "-l" ] && [ "$3" = "-c" ] || exit 90\nexec /bin/sh -c "$4"\n',
    { mode: 0o700 }
  );
  await fs.writeFile(ssh, '#!/bin/sh\nfor arg do :; done\nexec /bin/sh -c "$arg"\n', { mode: 0o700 });
  await fs.writeFile(
    delegate,
    String.raw`#!/usr/bin/python3
import json,os,select,sys,time,subprocess,hashlib,shlex,base64
a=sys.argv[1:];assert a[:2]==['-L','codeman-remote'];op=a[2];root=os.environ['FAKE_BROKER_ROOT'];pid=os.environ['FIXTURE_PANE_PID']
assert root.startswith(os.environ['HOME']+'/') or root==os.environ['HOME']
if op=='has-session':sys.exit(1 if os.path.exists(root+'/missing') else 0)
if op=='new-session':
 assert os.path.exists(root+'/missing');os.unlink(root+'/missing')
 open(root+'/pane','w').write('0|||%7|9009\n');sys.stdout.write('$17|%7|9009|17000\n');sys.exit(0)
if op=='set-option':sys.exit(0)
if op=='wait-for':open(root+'/pane','w').write('1|1||%7|9009\n');sys.exit(0)
if op=='list-panes':
 fields=open(root+'/pane').read().rstrip('\n').split('|');state=dict(zip(['pane_dead','pane_dead_status','pane_dead_signal','pane_id','pane_pid'],fields));state.update(session_name='codeman-ssh-aaaaaaaa',session_id='$17',pid='17000')
 import re
 fmt=a[-1];names=re.findall(r'#\{([a-z_]+)\}',fmt);assert names
 sys.stdout.write('|'.join(state[n] for n in names)+'\n');sys.exit(0)
if op=='respawn-pane':
 assert a[3:7]==['-c',root,'-t','%7'] and a[7:10]==['env','CODEX_HOME='+os.environ['FAKE_CODEX_HOME'],'python3']
 directory=a[11];assert a[10]==directory+'/broker.py' and directory.startswith(root+'/') and len(a)==13 and len(a[12])==64
 fd=os.open(root+'/input',os.O_RDWR|os.O_NONBLOCK);log=os.open(root+'/new-broker.log',os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)
 env=dict(os.environ);env['CODEX_HOME']=os.environ['FAKE_CODEX_HOME']
 if os.path.exists(root+'/tail-before-child'):open(os.environ['ROLLOUT'],'a').write(' ')
 if os.path.exists(root+'/config-before-child'):
  config_path=directory+'/config.json';config=json.load(open(config_path));code='import pathlib,time;pathlib.Path('+repr(root+'/wrong-start')+').write_text(\"started\");time.sleep(0.5)';config['command']='exec /usr/bin/python3 -c '+shlex.quote(code);config['launchDigest']=hashlib.sha256(config['command'].encode()).hexdigest();open(config_path,'w').write(json.dumps(config))
 p=subprocess.Popen(['/usr/bin/python3',a[10],directory,a[12]],stdin=fd,stdout=log,stderr=log,env=env,close_fds=True)
 open(root+'/new-directory','w').write(directory);open(root+'/pane','w').write('0|||%7|'+str(p.pid)+'\n');os.close(fd);os.close(log);sys.exit(0)
if op=='capture-pane':
 assert '-p' in a
 text=open(root+'/bytes','rb').read().decode('utf8')
 if os.path.exists(root+'/draft') or (os.path.exists(root+'/draft-after') and text):text='Unsent owner draft'
 if os.path.exists(root+'/no-repaint'):text=''
 delay=float(open(root+'/delay').read()) if os.path.exists(root+'/delay') else 0
 if delay and text:
  if not os.path.exists(root+'/paint-at'):open(root+'/paint-at','w').write(str(time.monotonic()+delay))
  if time.monotonic()<float(open(root+'/paint-at').read()):text=''
 chrome='Working (esc to interrupt)\n' if os.path.exists(root+'/busy') else ('Would you like to approve this?\n' if os.path.exists(root+'/approval') else '')
 if os.path.exists(root+'/tail-after') and text:open(os.environ['ROLLOUT'],'a').write(' ')
 sys.stdout.write(chrome+'› '+text+'\n  fixture-model default · /fixture/work\n');sys.exit(0)
if op=='send-keys':
 assert a[3]=='-l' and a[4:6]==['-t','%7'] and len(a)==7
 data=a[6].encode('utf8');assert data.startswith(b'\x1eCODEMAN_INPUT_V1:') and data.endswith(b'\x1f')
 packet=json.loads(base64.b64decode(data.split(b':')[1]))
 expiry_event=None
 if packet['channel']=='auto' and base64.b64decode(packet['data'])==b'\r' and os.path.exists(root+'/expire-enter'):
  plan=json.load(open(root+'/expire-enter'));literal=open(root+'/bytes','rb').read();assert literal==plan['prompt'].encode('utf8')
  journal=json.load(open(root+'/private/'+packet['sessionId']+'/'+packet['incarnation']+'/state.json'))
  prior=[r for r in journal['receipts'] if r['channel']=='auto' and r['counter']==packet['counter']-1]
  assert len(prior)==1 and prior[0]['status']=='sent' and prior[0]['hash']==hashlib.sha256(literal).hexdigest()
  before=time.monotonic()*1000
  expiry=before+(plan['actionDeadline']-time.time()*1000) if 'actionDeadline' in plan else packet['monotonicDeadline']
  assert 0<expiry-before<=2000
  expiry_event={'counter':packet['counter'],'nonce':packet['nonce'],'hash':hashlib.sha256(b'\r').hexdigest(),'packetDeadline':packet['monotonicDeadline'],'expiry':expiry,'before':before,'literal':prior[0]}
  queued=os.fork()
  if queued:
   fields=open('/proc/'+str(queued)+'/stat').read().rsplit(')',1)[1].split();birth=fields[19];assert birth.isascii() and birth.isdigit() and int(birth)>0
   with open(root+'/enter-queue-process.tmp','w') as f:json.dump({'pid':queued,'birth':birth},f)
   os.replace(root+'/enter-queue-process.tmp',root+'/enter-queue-process.json')
   sys.exit(0)
  null=os.open('/dev/null',os.O_RDWR)
  for descriptor in (0,1,2):os.dup2(null,descriptor)
  if null>2:os.close(null)
  time.sleep(max(0,(expiry-time.monotonic()*1000)/1000)+.02)
 if packet['channel']=='auto' and base64.b64decode(packet['data'])==b'\r' and os.path.exists(root+'/enter-delay'):time.sleep(float(open(root+'/enter-delay').read()))
 with open(root+'/effects','a') as f:f.write(json.dumps({'frame':len(data)})+'\n')
 fd=os.open(root+'/input',os.O_WRONLY|os.O_NONBLOCK);end=time.monotonic()+1.5;offset=0
 try:
  while offset<len(data):
   try:offset+=os.write(fd,data[offset:])
   except BlockingIOError:
    if time.monotonic()>=end:raise
    select.select([],[fd],[],.01)
 finally:os.close(fd)
 if expiry_event is not None:
  expiry_event['forwarded']=time.monotonic()*1000
  target=root+'/enter-expiry-forwarded';temporary=target+'.'+str(os.getpid())
  previous=open(target).read() if os.path.exists(target) else ''
  with open(temporary,'w') as f:f.write(previous+json.dumps(expiry_event)+'\n')
  os.replace(temporary,target)
 sys.exit(0)
raise AssertionError(op)
`,
    { mode: 0o700 }
  );
  await fs.writeFile(
    native,
    guardedNativeTmuxFixture(delegate)
      .replace(
        "if op == 'if-shell':",
        String.raw`if op == 'if-shell' and args[7]=='display-message -p CODEMAN_BROKER_OWNED':
    assert args[3:5]==['-F','-t'] and args[8]=='display-message -p CODEMAN_BROKER_REFUSED'
    terms=re.findall(r'#\{==:#\{([a-z_]+)\},([^{}]*)\}',args[6]);assert len(terms)==8
    expr='#{==:#{'+terms[0][0]+'},'+terms[0][1]+'}'
    for k,v in terms[1:]:expr='#{&&:'+expr+',#{==:#{'+k+'},'+v+'}}'
    assert expr==args[6]
    row=open(os.environ['FIXTURE_PANE_FILE']).read().rstrip('\n').split('|')
    state=dict(zip(['pane_dead','pane_dead_status','pane_dead_signal','pane_id','pane_pid'],row));state.update(session_name='codeman-ssh-aaaaaaaa',session_id='$17',pid='17000')
    print('CODEMAN_BROKER_OWNED' if args[5]==state['pane_id'] and all(state.get(k)==v for k,v in terms) else 'CODEMAN_BROKER_REFUSED');sys.exit(0)
if op == 'if-shell':`
      )
      .replace(
        /os\.execv\([^\n]*\n?$/,
        'sys.argv = [' +
          JSON.stringify(delegate) +
          '] + args\nexec(compile(open(' +
          JSON.stringify(delegate) +
          ').read(), ' +
          JSON.stringify(delegate) +
          ', "exec"))\n'
      ),
    { mode: 0o700 }
  );
  const wireCalls: Array<{ failed: boolean; error?: string; stdout: string }> = [];
  const wrapperPaths = [shim, ssh, delegate, native, join(bin, 'codex')];
  const wrappers = await Promise.all(wrapperPaths.map((p) => fs.realpath(p)));
  if (
    wrappers.some((p) => !p.startsWith(bin + '/')) ||
    !(await fs.readFile(native, 'utf8')).includes('CODEMAN_REMOTE_PANE_REFUSED')
  )
    throw Error('Fake transport isolation failed');
  const wrapperHashes = await Promise.all(wrapperPaths.map(async (path) => hash(await fs.readFile(path, 'utf8'))));
  const env: NodeJS.ProcessEnv = {
    LANG: 'C.UTF-8',
    HOME: root,
    PATH: bin + ':/usr/bin:/bin',
    SHELL: shim,
    FAKE_BROKER_ROOT: root,
    FIXTURE_PANE_PID: String(worker.pid),
    EFFECT_LOG: effects,
    ROLLOUT: rollout,
    FIXTURE_PANE_FILE: paneFile,
    FAKE_CODEX_HOME: home,
  };
  for (const key of Object.keys(env))
    if (
      key === 'CODEX_HOME' ||
      key === 'TMUX' ||
      key.startsWith('SSH_') ||
      key.startsWith('CODEMAN_MUX') ||
      key === 'CODEMAN_TMUX_SOCKET'
    )
      delete env[key];
  const request = {
    sessionId: SID,
    workingDir: root,
    codexHome: home,
    inputBroker: descriptor,
    submission: {
      at,
      hash: hash('owner prompt'),
      clockDomain: 'remote' as const,
      clock: { localBefore: at, localAfter: at, remoteBefore: at, remoteAfter: at },
    },
  };
  const run = async (command: string, input?: string) => {
    if (
      env.PATH !== bin + ':/usr/bin:/bin' ||
      env.SHELL !== shim ||
      env.CODEX_HOME !== undefined ||
      (
        await Promise.all(
          wrapperPaths.map(
            async (path, index) =>
              (await fs.realpath(path)) === path && hash(await fs.readFile(path, 'utf8')) === wrapperHashes[index]
          )
        )
      ).some((valid) => !valid)
    )
      throw Error('Fixture refused an unverified executable environment');
    try {
      const task = exec('/bin/sh', ['-c', command], { env, timeout: 10000, maxBuffer: 768 * 1024 });
      task.child.stdin?.end(input);
      const stdout = (await task).stdout;
      wireCalls.push({ stdout, failed: false });
      return { stdout, failed: false };
    } catch (e) {
      const error = (e as { stderr?: string }).stderr ?? String(e);
      wireCalls.push({ stdout: (e as { stdout?: string }).stdout ?? '', failed: true, error: error.slice(-1500) });
      return { stdout: (e as { stdout?: string }).stdout ?? '', failed: true, error };
    }
  };
  const inspect = async () => {
    const result = await run(buildRemoteCodexEvidenceCommand(remote, request));
    return { evidence: parseRemoteCodexEvidence(result.stdout), ...result };
  };
  const observe = async () => {
    const { evidence, ...result } = await inspect();
    const wire = evidence && 'inputBroker' in evidence ? evidence.inputBroker : undefined;
    if (!wire)
      throw Error(
        'Missing broker evidence ' +
          JSON.stringify(evidence) +
          ' ' +
          diagnostics +
          ' ' +
          result.stdout +
          ' ' +
          ('error' in result ? result.error : '')
      );
    const proof = cache.observe(scope, descriptor.incarnation, wire.serialized, wire.witness, worker.pid!);
    if (!proof) throw Error('Broker proof refused');
    return { proof, evidence };
  };
  const inputRequest = async (prompt: string, modify?: (request: RemoteCodexInputRequest) => void) => {
    const { proof, evidence } = await observe();
    if (!evidence || !('pane' in evidence) || !evidence.pane) throw Error('Missing native pane');
    const q: RemoteCodexInputRequest = {
      ...request,
      prompt,
      expected: {
        conversationId: CID,
        tailHash: hash(tail),
        paneId: '%7',
        panePid: worker.pid!,
        screenHash: hash(evidence.pane.screen!),
        inputProof: proof,
      },
    };
    modify?.(q);
    return q;
  };
  const input = async (prompt: string, modify?: (request: RemoteCodexInputRequest) => void) => {
    const q = await inputRequest(prompt, modify);
    const result = await run(buildRemoteCodexInputCommand(remote, q));
    return { ...result, result: parseRemoteCodexInputResult(result.stdout), q };
  };
  const options = {
    cache,
    transport: {
      clock: async () => {
        const now = Date.now();
        return { localBefore: now, localAfter: now, remoteBefore: now, remoteAfter: now };
      },
      run: async (command: string) => {
        const result = await run(command);
        if (result.failed) throw Error(result.error);
        return { stdout: result.stdout };
      },
    },
    provisionTransport: {
      run: async (command: string, input: string) => {
        const result = await run(command, input);
        if (result.failed) throw Error(result.error);
        return { stdout: result.stdout };
      },
    },
  };
  const rotate = async (
    kind: 'restart' | 'restore',
    veto?: (authority: { check: () => Promise<boolean>; isCurrent: () => boolean }) => void,
    priorJournal?: (state: import('../../src/recovery/codex-input-broker.js').CodexBrokerState) => void
  ) => {
    await fs.writeFile(join(root, 'exit-status'), '1');
    await fs.writeFile(join(root, 'stop'), '');
    await closed;
    pumping = false;
    await pump;
    await fs.unlink(join(root, 'stop'));
    await fs.writeFile(paneFile, '1|1||%7|' + worker.pid + '\n');
    if (kind === 'restore') await fs.writeFile(join(root, 'missing'), '1');
    if (priorJournal) {
      const file = join(broker.directory, 'state.json'),
        state = JSON.parse(await fs.readFile(file, 'utf8'));
      priorJournal(state);
      await fs.writeFile(file, JSON.stringify(state));
    }
    const { proof } = await observe();
    let pending: string | undefined, promoted: string | undefined;
    const authority = {
      check: async () => true,
      isCurrent: () => true,
      reserveInputBroker: async (old: string, next: string) => {
        if (old !== descriptor.incarnation || pending) return false;
        pending = next;
        return true;
      },
      commitInputBroker: async (old: string, next: string) => {
        if (old !== descriptor.incarnation || pending !== next) return false;
        promoted = next;
        return cache.activate(scope, next);
      },
    };
    veto?.(authority);
    const q = {
      sessionId: SID,
      resumeId: CID,
      submission: request.submission,
      expectedIdentity: { conversationId: CID, tailHash: hash(tail) },
      codexConfig: { noDaemon: true, resumeSessionId: CID },
      codexHome: home,
      inputBroker: descriptor,
      expectedInputProof: proof,
      ...(kind === 'restart' ? { expectedPane: { paneId: '%7', panePid: worker.pid!, status: 1 } } : {}),
    };
    const result =
      kind === 'restart'
        ? await restartRemoteCodexPane(remote, q as Parameters<typeof restartRemoteCodexPane>[1], authority, options)
        : await restoreRemoteCodexWorker(remote, q, authority, options);
    return { result, pending, promoted, wireCalls: wireCalls.map((x) => ({ ...x, stdout: x.stdout.slice(0, 400) })) };
  };
  return {
    rotate,
    options,
    starts: async () => (await fs.readFile(join(root, 'starts'), 'utf8')).trim().split('\n').length,
    root,
    home,
    rollout,
    broker,
    worker,
    cache,
    scope,
    descriptor,
    request,
    remote,
    env,
    inspect,
    observe,
    input,
    inputRequest,
    run,
    bytes: () => fs.readFile(bytes),
    marker: (name: string, value = '1') => fs.writeFile(join(root, name), value),
    diagnostics: () => diagnostics,
    close: async () => {
      try {
        const queued = JSON.parse(await fs.readFile(join(root, 'enter-queue-process.json'), 'utf8'));
        if (
          Number.isSafeInteger(queued.pid) &&
          queued.pid > 0 &&
          typeof queued.birth === 'string' &&
          /^[1-9]\d*$/.test(queued.birth)
        ) {
          const isSameWriter = async () => {
            try {
              const stat = await fs.readFile('/proc/' + queued.pid + '/stat', 'utf8');
              const end = stat.lastIndexOf(')');
              if (end < 0) return false;
              const fields = stat
                .slice(end + 1)
                .trim()
                .split(/\s+/);
              if (fields[19] !== queued.birth || fields[0] === 'Z' || fields[0] === 'X') return false;
              return (await fs.readFile('/proc/' + queued.pid + '/cmdline', 'utf8')).includes(root + '/bin/');
            } catch {
              return false;
            }
          };
          // Let the already-forwarded disposable writer exit normally. Unknown
          // or changed native identity can never authorize a cleanup signal.
          const end = process.hrtime.bigint() + 300_000_000n;
          while (await isSameWriter()) {
            if (process.hrtime.bigint() >= end) {
              if (await isSameWriter()) process.kill(queued.pid, 'SIGKILL');
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }
      } catch {
        /* Missing, malformed or exited queued-process evidence is retained. */
      }
      pumping = false;
      await pump;
      await fifoHandle.close().catch(() => {});
      await fs.writeFile(join(root, 'stop'), '');
      await Promise.race([closed, new Promise<void>((r) => setTimeout(r, 300))]);
      if (worker.exitCode === null) worker.kill('SIGKILL');
      await closed;
      try {
        const directory = await fs.readFile(join(root, 'new-directory'), 'utf8');
        const state = JSON.parse(await fs.readFile(join(directory, 'state.json'), 'utf8'));
        for (const pid of [state.childPid, state.pid]) {
          try {
            const command = await fs.readFile('/proc/' + pid + '/cmdline', 'utf8');
            if (command.includes(root)) process.kill(pid, 'SIGKILL');
          } catch {
            /* The exact disposable process already exited. */
          }
        }
      } catch {
        /* No new disposable broker was launched. */
      }
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
