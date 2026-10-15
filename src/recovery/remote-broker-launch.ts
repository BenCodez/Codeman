/** Controlled owner launches and acknowledgements for already provisioned SSH brokers. */
import { buildSshConnectionArgs, remoteLoginShellCommand, remoteSshTarget, shellescape } from '../remote-hosts.js';
import { performance } from 'node:perf_hooks';
import { runWithRemoteSshLimit, RemoteSshAdmissionError } from '../remote-ssh-limiter.js';
import { runRemoteBrokerStdin } from './remote-broker-transport.js';
import type { SessionRemote } from '../types.js';
import type { BrokerReceipt } from './codex-input-broker.js';
import type { PrivateFileWitness } from './private-file-witness.js';
import type { OwnedRemoteBrokerDescriptor } from './remote-input-broker-cache.js';
import type { RemoteBrokerAuthority, RemoteBrokerPane, RemoteBrokerTransport } from './remote-input-broker.js';

export type RemoteBrokerObservation =
  | { status: 'observed'; serialized: string; witness: PrivateFileWitness; panePid: number }
  | { status: 'not-sent' | 'unknown' };
type Request = {
  sessionId: string;
  descriptor: OwnedRemoteBrokerDescriptor;
  codexHome?: string;
  pane?: RemoteBrokerPane;
  receipt?: BrokerReceipt;
  inspect?: true;
};
const MARKER = 'CODEMAN_REMOTE_BROKER_LAUNCH_V1:';
const MAX_OUTPUT = 160 * 1024;
const SOURCE = String.raw`
const fs=require('fs'),path=require('path'),cp=require('child_process'),crypto=require('crypto'),perf=require('perf_hooks').performance;
const began=perf.now(),wall=Date.now(),emit=x=>process.stdout.write('${MARKER}'+Buffer.from(JSON.stringify(x)).toString('base64')+'\n');
const check=()=>{const m=perf.now()-began,w=Date.now()-wall;if(m>=1800||w<0||Math.abs(m-w)>100)throw Error('expired')};
const hash=x=>crypto.createHash('sha256').update(x).digest('hex'),uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const integer=x=>Number.isSafeInteger(x)&&x>0,native=(x,p)=>typeof x==='string'&&new RegExp('^'+p+'(?:0|[1-9]\\d*)$').test(x)&&Number.isSafeInteger(+x.slice(1));
const sig=s=>[s.dev,s.ino,s.mode,s.size,s.mtimeMs,s.ctimeMs].join(':'),privateFile=s=>s.isFile()&&!s.isSymbolicLink()&&(s.mode&63)===0&&s.uid===process.getuid();
const pins=new Map(),parents=new Map();
const read=(p,n,pin=true)=>{check();const a=fs.lstatSync(p);if(!privateFile(a)||a.size>n)throw Error('private');const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);let b,s;try{s=fs.fstatSync(fd);if(sig(a)!==sig(s))throw Error('replaced');b=Buffer.alloc(s.size+1);if(fs.readSync(fd,b,0,b.length,0)!==s.size||sig(fs.fstatSync(fd))!==sig(s))throw Error('changed');b=b.subarray(0,s.size)}finally{fs.closeSync(fd)}check();if(sig(fs.lstatSync(p))!==sig(s)||!Buffer.from(b.toString('utf8')).equals(b))throw Error('changed');if(pin){const old=pins.get(p);if(old&&old!==sig(s))throw Error('replaced');pins.set(p,sig(s))}return {text:b.toString('utf8'),stat:s}};
const confirm=()=>{for(const [p,s] of parents){check();const a=fs.lstatSync(p);if(!a.isDirectory()||a.isSymbolicLink()||[a.dev,a.ino,a.mode].join(':')!==s)throw Error('parent')}for(const [p,s] of pins){check();if(sig(fs.lstatSync(p))!==s)throw Error('changed')}};
const tq=x=>"'"+String(x).replace(/['\x01-\x1f\x7f]/g,c=>c==="'"?"'\\''":"'\\"+c.charCodeAt(0).toString(8).padStart(3,"0")+"'")+"'";
const run=args=>{check();const out=cp.execFileSync('tmux',['-L','codeman-remote',...args],{encoding:'utf8',timeout:Math.max(1,Math.floor(1800-(perf.now()-began))),maxBuffer:16384});check();return out};
const proc=p=>{const t=fs.readFileSync('/proc/'+p+'/stat','utf8'),e=t.lastIndexOf(')'),a=t.slice(e+2).trim().split(/\s+/);if(e<0||!a[19]||!/^[1-9]\d*$/.test(a[19])||['Z','X','x','T','t'].includes(a[0]))throw Error('process');return {parent:+a[1],birth:a[19]}};
let dispatched=false;
try{
 const bytes=Buffer.alloc(32769);let n=0;while(n<bytes.length){const c=fs.readSync(0,bytes,n,bytes.length-n,null);if(!c)break;n+=c}if(n>32768||!Buffer.from(bytes.subarray(0,n).toString('utf8')).equals(bytes.subarray(0,n)))throw Error('request');
 const q=JSON.parse(bytes.subarray(0,n).toString('utf8')),d=q.descriptor;
 if(!q||!uuid.test(q.sessionId)||!d||!uuid.test(d.incarnation)||!uuid.test(d.startupNonce)||typeof d.directory!=='string'||!path.isAbsolute(d.directory)||path.normalize(d.directory)!==d.directory||Buffer.byteLength(d.directory)>4096||/[\x00-\x1f\x7f]/.test(d.directory)||!d.directory.endsWith('/'+q.sessionId+'/'+d.incarnation)||!['launchDigest','homeDigest','helperDigest','keyDigest'].every(k=>/^[a-f0-9]{64}$/.test(d[k]))||[!!q.pane,!!q.receipt,q.inspect===true].filter(Boolean).length!==1)throw Error('scope');
 let current=path.parse(d.directory).root;for(const part of d.directory.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);const s=fs.lstatSync(current);if(!s.isDirectory()||s.isSymbolicLink())throw Error('parent');if((current===d.directory||current===path.dirname(d.directory)||current===path.dirname(path.dirname(d.directory)))&&((s.mode&63)!==0||s.uid!==process.getuid()))throw Error('private parent');parents.set(current,[s.dev,s.ino,s.mode].join(':'))}
 const configText=read(path.join(d.directory,'config.json'),98304).text,cfg=JSON.parse(configText),helper=read(path.join(d.directory,'broker.py'),262144).text;
 if(cfg.version!==1||cfg.sessionId!==q.sessionId||cfg.incarnation!==d.incarnation||cfg.launchDigest!==d.launchDigest||cfg.homeDigest!==d.homeDigest||typeof cfg.command!=='string'||hash(cfg.command)!==d.launchDigest||typeof cfg.secret!=='string'||hash(cfg.secret)!==d.keyDigest||hash(helper)!==d.helperDigest||cfg.startup?.nonce!==d.startupNonce)throw Error('config');
 read(path.join(d.directory,'lock'),0);
 const name='codeman-ssh-'+q.sessionId.slice(0,8);
 if(q.pane){
  const p=q.pane,s=cfg.startup;
  if(!native(p.sessionId,'\\$')||!native(p.paneId,'%')||!integer(p.panePid)||!integer(p.serverPid)||typeof q.codexHome!=='string'||!path.isAbsolute(q.codexHome)||q.codexHome.includes('\0')||Buffer.byteLength(q.codexHome)>4096||hash(q.codexHome)!==d.homeDigest||Object.keys(s).sort().join(',')!=='issuer,missingPaths,monotonicDeadline,nonce,privateFiles,privatePaths'||s.monotonicDeadline!==null||s.issuer!==null||!Array.isArray(s.privateFiles)||s.privateFiles.length||!Array.isArray(s.privatePaths)||s.privatePaths.length||!Array.isArray(s.missingPaths)||s.missingPaths.length)throw Error('startup');
  const fields={session_name:name,session_id:p.sessionId,pane_id:p.paneId,pane_pid:p.panePid,pane_dead:1,pane_dead_status:1,pane_dead_signal:'',pid:p.serverPid,window_panes:1,session_windows:1};
  const terms=Object.entries(fields).map(([k,v])=>'#{==:#{'+k+'},'+v+'}'),predicate=terms.reduce((a,b)=>'#{&&:'+a+','+b+'}');
  confirm();check();dispatched=true;
  const output=run(['if-shell','-F','-t',p.paneId,predicate,['respawn-pane','-c','/tmp','-t',p.paneId,'env','CODEX_HOME='+q.codexHome,'python3',path.join(d.directory,'broker.py'),d.directory,hash(configText)].map(tq).join(' '),'display-message -p CODEMAN_BROKER_LAUNCH_REFUSED']);
  if(output==='CODEMAN_BROKER_LAUNCH_REFUSED\n'){emit({status:'not-sent'});process.exit(0)}if(output!=='')throw Error('receipt');
 }
 for(let attempt=0;attempt<80;attempt++){
  check();confirm();let observed;try{observed=read(path.join(d.directory,'state.json'),98304,false)}catch(e){if(e.code==='ENOENT'){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);continue}throw e}
  const state=JSON.parse(observed.text);
  if(state.sessionId!==q.sessionId||state.incarnation!==d.incarnation||state.launchDigest!==d.launchDigest||state.homeDigest!==d.homeDigest||state.startup?.nonce!==d.startupNonce)throw Error('journal');
  if(state.startup.status==='reserved'){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);continue}
  if(state.startup.status!=='started'||!integer(state.pid)||!integer(state.childPid))throw Error('startup receipt');
  const broker=proc(state.pid),child=proc(state.childPid);if(broker.birth!==state.brokerStart||child.birth!==state.childStart||child.parent!==state.pid)throw Error('birth');
  const row=run(['list-panes','-t',name,'-F','#{session_name}|#{pane_id}|#{pane_pid}|#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}']);
  const fields=row.endsWith('\n')?row.slice(0,-1).split('|'):[];
  if(fields.length!==6||fields[0]!==name||!native(fields[1],'%')||fields[2]!==String(state.pid)||fields.slice(3).join('|')!=='0||'||(q.pane&&fields[1]!==q.pane.paneId))throw Error('native');
  if(q.receipt){const r=q.receipt;if(!['owner-pty','owner-key','owner-mux'].includes(r.channel)||!integer(r.counter)||!uuid.test(r.nonce)||typeof r.conversationId!=='string'||typeof r.hash!=='string'||!/^[a-f0-9]{64}$/.test(r.hash)||!Array.isArray(state.receipts))throw Error('receipt');const item=state.receipts.find(x=>x.channel===r.channel&&x.counter===r.counter&&x.nonce===r.nonce&&x.conversationId===r.conversationId&&x.hash===r.hash);if(!item||item.status==='reserved'){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);continue}if(item.status!=='sent')throw Error('unsent')}
  confirm();check();if(sig(fs.lstatSync(path.join(d.directory,'state.json')))!==sig(observed.stat)||proc(state.pid).birth!==broker.birth||proc(state.childPid).birth!==child.birth)throw Error('changed');
  const s=observed.stat;emit({status:'observed',serialized:observed.text,panePid:state.pid,witness:{path:path.join(d.directory,'state.json'),dev:s.dev,ino:s.ino,size:s.size,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs,hash:hash(observed.text),maxBytes:98304}});process.exit(0)
 }
 throw Error('receipt absent')
}catch{emit({status:dispatched?'unknown':'not-sent'})}
`;

export function buildRemoteBrokerLaunchCommand(remote: SessionRemote): string {
  return [
    ...buildSshConnectionArgs(remote),
    remoteSshTarget(remote),
    shellescape(remoteLoginShellCommand(`node -e ${shellescape(SOURCE)}`)),
  ].join(' ');
}

/** An uncertain launch is never retried or replaced with a fresh remote/local conversation. */
export async function observeOwnedRemoteBroker(
  remote: SessionRemote,
  request: Request,
  authority: RemoteBrokerAuthority,
  options: { transport?: RemoteBrokerTransport } = {}
): Promise<RemoteBrokerObservation> {
  const deadline = performance.now() + 15_000;
  let input: string, scope: string, snapshot: SessionRemote;
  try {
    input = JSON.stringify(request);
    scope = JSON.stringify(remote);
    snapshot = structuredClone(remote);
    if (
      remote.owned === false ||
      Buffer.byteLength(input) > 32_768 ||
      [!!request.pane, !!request.receipt, request.inspect === true].filter(Boolean).length !== 1
    )
      return { status: 'not-sent' };
  } catch {
    return { status: 'not-sent' };
  }
  const current = () => {
    try {
      const verdict: unknown = authority.isCurrent();
      if (verdict && typeof (verdict as { then?: unknown }).then === 'function') {
        void Promise.resolve(verdict).catch(() => {});
        return false;
      }
      return performance.now() < deadline && verdict === true && JSON.stringify(remote) === scope;
    } catch {
      return false;
    }
  };
  return runWithRemoteSshLimit<RemoteBrokerObservation>(
    async (retain) => {
      let dispatched = false;
      try {
        if (!current() || (await authority.prepare()) !== true || !current()) return { status: 'not-sent' };
        const command = buildRemoteBrokerLaunchCommand(snapshot);
        if (!current()) return { status: 'not-sent' };
        dispatched = true;
        const { stdout } = await (options.transport
          ? options.transport.run(command, input)
          : runRemoteBrokerStdin(command, input, { inputBytes: 32_768, outputBytes: MAX_OUTPUT, deadline }, retain));
        if (!current() || Buffer.byteLength(stdout) > MAX_OUTPUT) return { status: 'unknown' };
        const lines = stdout.split('\n').filter((line) => line.startsWith(MARKER));
        if (lines.length !== 1) return { status: 'unknown' };
        const encoded = lines[0].slice(MARKER.length),
          bytes = Buffer.from(encoded, 'base64');
        if (bytes.toString('base64') !== encoded || !Buffer.from(bytes.toString('utf8')).equals(bytes))
          return { status: 'unknown' };
        const value = JSON.parse(bytes.toString('utf8')) as RemoteBrokerObservation;
        if ((value.status === 'not-sent' || value.status === 'unknown') && Object.keys(value).length === 1)
          return value;
        if (
          value.status !== 'observed' ||
          Object.keys(value).sort().join(',') !== 'panePid,serialized,status,witness' ||
          typeof value.serialized !== 'string' ||
          Buffer.byteLength(value.serialized) > 98_304 ||
          !Number.isSafeInteger(value.panePid) ||
          value.panePid <= 0 ||
          !value.witness ||
          typeof value.witness !== 'object'
        )
          return { status: 'unknown' };
        return value;
      } catch {
        return { status: dispatched ? 'unknown' : 'not-sent' };
      }
    },
    { deadline, isCurrent: current }
  ).catch(
    (error: unknown): RemoteBrokerObservation => ({
      status: error instanceof RemoteSshAdmissionError ? 'not-sent' : 'unknown',
    })
  );
}
