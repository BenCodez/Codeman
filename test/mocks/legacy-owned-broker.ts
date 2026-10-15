/** Private disposable workers for the history/composer/native reader fixtures. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { CodexInputBroker } from '../../src/recovery/codex-input-broker.js';
import { buildRemoteCodexPaneCommand } from '../../src/tmux-manager.js';
import { guardedNativeTmuxFixture } from './remote-native-tmux.js';

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CID = '11111111-2222-3333-4444-555555555555';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const quote = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;
export async function legacyOwnedBroker(
  root: string,
  home: string,
  workingDir: string,
  live: boolean,
  status = 1,
  childSignal?: number
) {
  const bin = join(root, 'bin');
  const childPath = join(root, 'owned-child.py');
  await fs.writeFile(
    childPath,
    String.raw`import os,sys,select,tty,termios,time
tty.setraw(0,termios.TCSANOW)
root=sys.argv[1]
open(root+'/child-ready','w').close()
fd=os.open(root+'/child-bytes',os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)
while not os.path.exists(root+'/child-stop'):
 if select.select([0],[],[],.01)[0]:
  b=os.read(0,65536)
  if not b:break
  os.write(fd,b)
os.close(fd)
`
  );
  await fs.writeFile(
    join(bin, 'codex'),
    '#!/bin/sh\nexec /usr/bin/python3 -u ' + quote(childPath) + ' ' + quote(root) + '\n',
    { mode: 0o700 }
  );
  const broker = await CodexInputBroker.create(
    join(root, 'private', SID),
    SID,
    `exec /usr/bin/python3 -u ${quote(childPath)} ${quote(root)}`,
    home,
    root
  );
  const workers: ChildProcessWithoutNullStreams[] = [];
  let pid = 4242;
  let pump: Promise<void> | undefined,
    pumping = false;
  const fifo = join(root, 'broker-input');
  // mkfifo is invoked by the caller through an exact system executable.
  const { execFile } = await import('node:child_process');
  await new Promise<void>((resolve, reject) =>
    execFile('/usr/bin/mkfifo', [fifo], (error) => (error ? reject(error) : resolve()))
  );
  const handle = await fs.open(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
  const close = async () => {
    pumping = false;
    await pump?.catch(() => {});
    await handle.close().catch(() => {});
    await fs.writeFile(join(root, 'child-stop'), '').catch(() => {});
    for (const worker of workers) {
      await new Promise<void>((resolve) => {
        if (worker.exitCode !== null || worker.signalCode !== null) return resolve();
        const timer = setTimeout(() => worker.kill('SIGKILL'), 1000);
        worker.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    const directory = await fs.readFile(join(root, 'replacement-directory'), 'utf8').catch(() => undefined);
    if (directory) {
      const replacementPid = Number(await fs.readFile(join(root, 'replacement-pid'), 'utf8').catch(() => undefined));
      if (Number.isSafeInteger(replacementPid) && replacementPid > 0) {
        try {
          const cmd = await fs.readFile('/proc/' + replacementPid + '/cmdline', 'utf8');
          if (cmd.split('\0').includes(join(directory, 'broker.py')) && directory.startsWith(root + '/private/'))
            process.kill(-replacementPid, 'SIGKILL');
        } catch {
          /* Exact private process group already exited. */
        }
      }
      const s = JSON.parse(await fs.readFile(join(directory, 'state.json'), 'utf8').catch(() => '{}'));
      for (const p of [s.childPid, s.pid]) {
        if (!Number.isSafeInteger(p)) continue;
        try {
          const cmd = await fs.readFile('/proc/' + p + '/cmdline', 'utf8');
          if (cmd.includes(root)) process.kill(p, 'SIGKILL');
        } catch {
          /* Exact disposable worker already exited. */
        }
      }
    }
  };
  try {
    if (live) {
      const worker = spawn(
        '/usr/bin/python3',
        [join(broker.directory, 'broker.py'), broker.directory, broker.configurationDigest],
        { env: { HOME: root, PATH: bin + ':/usr/bin:/bin', CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      workers.push(worker);
      pid = worker.pid!;
      worker.stdin.on('error', () => {});
      worker.stdout.resume();
      worker.stderr.resume();
      const end = performance.now() + 3000;
      while (!(await fs.stat(join(root, 'child-ready')).catch(() => undefined))) {
        if (performance.now() > end) throw Error('Disposable worker startup failed');
        await new Promise((r) => setTimeout(r, 10));
      }
      pumping = true;
      pump = (async () => {
        const b = Buffer.alloc(32768);
        while (pumping) {
          try {
            const { bytesRead } = await handle.read(b, 0, b.length, null);
            if (bytesRead) worker.stdin.write(b.subarray(0, bytesRead));
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EAGAIN') throw e;
          }
          await new Promise((r) => setTimeout(r, 2));
        }
      })();
    } else {
      const cfg = JSON.parse(await fs.readFile(join(broker.directory, 'config.json'), 'utf8'));
      await fs.writeFile(
        join(broker.directory, 'state.json'),
        JSON.stringify({
          version: 1,
          sessionId: SID,
          incarnation: broker.incarnation,
          pid,
          childPid: 4243,
          brokerStart: '900',
          childStart: '901',
          tainted: false,
          rawGeneration: 0,
          launchDigest: cfg.launchDigest,
          homeDigest: cfg.homeDigest,
          closed: true,
          exitStatus: childSignal ? null : status,
          exitSignal: childSignal ?? null,
          counters: { 'owner-pty': 0, 'owner-key': 0, 'owner-mux': 0, auto: 0, probe: 0 },
          receipts: [],
          startup: { nonce: cfg.startup.nonce, status: 'started' },
        }),
        { mode: 0o600 }
      );
    }
    const descriptorFor = async (b: CodexInputBroker) => {
      const cfg = JSON.parse(await fs.readFile(join(b.directory, 'config.json'), 'utf8'));
      return {
        directory: b.directory,
        incarnation: b.incarnation,
        launchDigest: cfg.launchDigest,
        homeDigest: cfg.homeDigest,
        keyDigest: hash(cfg.secret),
        helperDigest: hash(await fs.readFile(join(b.directory, 'broker.py'), 'utf8')),
        startupNonce: cfg.startup.nonce,
      };
    };
    const descriptor = await descriptorFor(broker);
    const proof = await broker.prove(pid);
    if (!proof) throw Error('Disposable owned broker proof failed');
    const workerCommand = buildRemoteCodexPaneCommand({
      remotePath: workingDir,
      sessionId: SID,
      codexHome: home,
      codexConfig: { noDaemon: true, resumeSessionId: CID, model: 'fixture-model' },
    });
    const next = await CodexInputBroker.create(join(root, 'private', SID), SID, workerCommand, home, root);
    const nextDescriptor = await descriptorFor(next);
    const native = join(bin, 'owned-tmux');
    await fs.writeFile(
      native,
      String.raw`#!/usr/bin/python3
import os,sys,json,re,base64,time
a=sys.argv[1:];op=a[2];root=os.environ['OWNED_FIXTURE_ROOT'];base=os.environ['EFFECT_LOG'];pane_file=base+'.pane'
def read(s,fallback=''):
 try:return open(base+s,'rb').read().decode('utf8')
 except FileNotFoundError:return fallback
def write(s,text):open(base+s,'w').write(text)
def change():write('.screen',read('.change'))
def paste(text):
 pasted=json.loads(read('.pasted','""'))+text;count=int(read('.pastes','0'))+1
 write('.pasted',json.dumps(pasted,ensure_ascii=False));write('.pastes',str(count))
 at=os.environ.get('REPAINT_AT','')
 if os.environ.get('REPAINT_CAPTURES') and (not at or at=='first' and count==1 or at=='final' and pasted==read('.requested')):
  write('.pending',json.dumps(dict(text=pasted,left=int(os.environ['REPAINT_CAPTURES']),captures=0,at=int(time.time()*1000))))
  prefix=read('.repaint-prefix')
  if prefix:write('.screen','› '+prefix+'\n  fixture-model default · /fixture/work\n')
 else:write('.screen','› '+pasted+'\n  fixture-model default · /fixture/work\n')
 mode=os.environ.get('COMPOSER_AT')
 if mode=='after-first-chunk' and count==1 or mode=='before-enter' and pasted==read('.requested'):change()
if op=='capture-pane':
 pending=json.loads(read('.pending','null'))
 if pending:
  pending['captures']+=1;write('.pending',json.dumps(pending));veto=os.environ.get('REPAINT_VETO','')
  if pending['captures']==2:
   if veto=='owner':change()
   if veto in ['busy','approval']:write('.screen',('Working (esc to interrupt)' if veto=='busy' else 'Would you like to approve this?')+'\n› '+pending['text']+'\n  fixture-model default · /fixture/work\n')
   if veto=='tail':open(os.environ['SELECTED_ROLLOUT'],'a').write(' ')
   if veto=='expired':write('.expired','1')
   if veto=='native':write('.pane','0|||%7|'+str(int(os.environ['FIXTURE_PANE_PID'])+1)+'\n')
  ready=int(time.time()*1000)>=pending['at']+int(os.environ['REPAINT_MS']) if os.environ.get('REPAINT_MS') else pending['left']==0
  if ready and not veto:write('.screen','› '+pending['text']+'\n  fixture-model default · /fixture/work\n');os.unlink(base+'.pending')
  elif pending['left']>0:pending['left']-=1;write('.pending',json.dumps(pending))
 current=read('.screen');count=int(read('.captures','0'))+1;write('.captures',str(count));sys.stdout.write(current)
 with open(base+'.screens','a') as f:f.write(json.dumps(current,ensure_ascii=False)+'\n')
 if os.environ.get('COMPOSER_AT')=='before-input' and count==1:change()
 pasted=json.loads(read('.pasted','""'));when=os.environ.get('WITNESS_AT')
 if when=='first-check' and count==2 or when=='final-check' and pasted and pasted==read('.requested'):open(os.environ['SELECTED_ROLLOUT'],'a').write(' ')
 sys.exit(0)
if op=='list-panes':
 row=open(pane_file,'rb').read().decode('utf8');row=row[:-1] if row.endswith('\n') else row;fields=row.split('|');names=re.findall(r'#\{([a-z_]+)\}',a[-1])
 if len(fields)!=5 or names==['pane_dead','pane_dead_status','pane_dead_signal','pane_id','pane_pid']:sys.stdout.write(row+'\n');sys.exit(0)
 state=dict(zip(['pane_dead','pane_dead_status','pane_dead_signal','pane_id','pane_pid'],fields));state.update(session_name='codeman-ssh-aaaaaaaa',session_id='$17',pid='17000')
 sys.stdout.write('|'.join(state[n] for n in names)+'\n');sys.exit(0)
if op=='send-keys':
 import select
 assert a[3:6]==['-l','-t','%7'] and len(a)==7
 wire=a[6].encode();assert wire.startswith(b'\x1eCODEMAN_INPUT_V1:') and wire.endswith(b'\x1f')
 packet=json.loads(base64.b64decode(wire.split(b':')[1]));data=base64.b64decode(packet['data'])
 fd=os.open(root+'/broker-input',os.O_WRONLY|os.O_NONBLOCK);offset=0;end=time.monotonic()+1
 try:
  while offset<len(wire):
   try:offset+=os.write(fd,wire[offset:])
   except BlockingIOError:
    if time.monotonic()>end:raise
    select.select([],[fd],[],.002)
 finally:os.close(fd)
 while time.monotonic()<end:
  try:s=json.load(open(os.environ['OWNED_BROKER_DIRECTORY']+'/state.json'));r=next((r for r in s['receipts'] if r['channel']==packet['channel'] and r['counter']==packet['counter'] and r['nonce']==packet['nonce']),None)
  except (FileNotFoundError,json.JSONDecodeError):r=None
  if r and r['status']!='reserved':break
  time.sleep(.002)
 if r and r['status']=='sent' and packet['channel']=='auto':
  command=['send-keys','-t','%7','Enter'] if data==b'\r' else ['send-keys','-l','-t','%7',data.decode()]
  with open(base+'.delivered','a') as f:f.write(json.dumps(command,ensure_ascii=False)+'\n')
  with open(base,'a') as f:f.write(' '.join(command)+'\n')
  if data!=b'\r':paste(data.decode())
 sys.exit(0)
if op=='respawn-pane':
 import subprocess
 assert '-k' not in a and a[3:5]==['-c',os.environ['OWNED_WORKING_DIR']] and a[7:10]==['env','CODEX_HOME='+os.environ['OWNED_CODEX_HOME'],'python3']
 directory=a[11];assert a[10]==directory+'/broker.py' and directory.startswith(root+'/private/') and len(a)==13
 fd=os.open(root+'/broker-input',os.O_RDWR|os.O_NONBLOCK);log=os.open(root+'/replacement.log',os.O_CREAT|os.O_WRONLY,0o600)
 env=dict(os.environ);env['CODEX_HOME']=os.environ['OWNED_CODEX_HOME']
 p=subprocess.Popen(['/usr/bin/python3',a[10],directory,a[12]],stdin=fd,stdout=log,stderr=log,env=env,close_fds=True,start_new_session=True)
 open(root+'/replacement-pid','w').write(str(p.pid))
 open(root+'/replacement-directory','w').write(directory);open(pane_file,'w').write('0|||'+a[6]+'|'+str(p.pid)+'\n');os.close(fd);os.close(log)
 with open(base,'a') as f:f.write(' '.join(a[2:])+'\n')
 with open(base+'.delivered','a') as f:f.write(json.dumps(a[2:],ensure_ascii=False)+'\n')
 sys.exit(0)
os.execv(os.environ['OWNED_LEGACY_NATIVE'],[os.environ['OWNED_LEGACY_NATIVE']]+a)
`,
      { mode: 0o700 }
    );
    // Observation probes have zero child bytes and do not count as an input phase.
    const wrapper = guardedNativeTmuxFixture(native)
      .replace('import json, os, re, sys', 'import json, os, re, sys, base64')
      .replace(
        "change = os.environ.get('NATIVE_BEFORE_EFFECT', '')",
        "probe = bool(re.search(r'CODEMAN_INPUT_V1:([A-Za-z0-9+/=]+):', args[7])) and json.loads(base64.b64decode(re.search(r'CODEMAN_INPUT_V1:([A-Za-z0-9+/=]+):', args[7]).group(1)))['channel']=='probe'\n    change = '' if probe else os.environ.get('NATIVE_BEFORE_EFFECT', '')"
      )
      .replace(
        "if change == 'signal-alias': state['pane_dead_signal'] = 'KILL'",
        "if change == 'signal-alias': state['pane_dead_signal'] = 'KILL'\n    if change == 'no-signal-alias': state['pane_dead_signal'] = '0'"
      )
      .replace(
        "print('CODEMAN_REMOTE_PANE_REFUSED')",
        "open(os.environ['EFFECT_LOG']+'.refused','w').write('refused')\n        print('CODEMAN_REMOTE_PANE_REFUSED')"
      )
      .replace('f.write(str(count + 1))', 'f.write(str(count if probe else count + 1))')
      .replace(
        /os\.execv\([^\n]*\n?$/,
        'sys.argv = [' +
          JSON.stringify(native) +
          '] + args\nexec(compile(open(' +
          JSON.stringify(native) +
          ').read(), ' +
          JSON.stringify(native) +
          ', "exec"))\n'
      );
    return {
      broker,
      pid,
      descriptor,
      proof,
      workerCommand,
      nextDescriptor,
      wrapper,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
