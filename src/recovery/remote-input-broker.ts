/** Private owned-SSH provisioning. Broker credentials travel only over SSH stdin. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { SessionRemote } from '../types.js';
import { buildSshConnectionArgs, remoteLoginShellCommand, remoteSshTarget, shellescape } from '../remote-hosts.js';
import { performance as brokerPerformance } from 'node:perf_hooks';
import { runWithRemoteSshLimit, RemoteSshAdmissionError } from '../remote-ssh-limiter.js';
import { runRemoteBrokerStdin } from './remote-broker-transport.js';

export interface RemoteBrokerMaterial {
  source: string;
  configJson: string;
  sessionId: string;
  incarnation: string;
}
export interface RemoteBrokerAuthority {
  prepare(): Promise<boolean>;
  isCurrent(): boolean;
}
export interface RemoteBrokerPane {
  sessionId: string;
  paneId: string;
  panePid: number;
  serverPid: number;
}
export interface RemoteBrokerDeadPane {
  paneId: string;
  panePid: number;
  status?: number;
  signal?: number;
}
export type RemoteBrokerProvisionResult =
  | { status: 'existing' | 'unsupported' | 'not-sent' | 'unknown' }
  | { status: 'planned'; directory: string; incarnation: string }
  | { status: 'provisioned'; directory: string; incarnation: string; pane: RemoteBrokerPane };
export interface RemoteBrokerTransport {
  run(command: string, input: string): Promise<{ stdout: string }>;
}

/** Source-host paths remain private to the lease subprocess, never the SSH request. */
export interface RemoteBrokerIssuer {
  directory: string;
  sessionId: string;
  incarnation: string;
  proof: unknown;
  files?: readonly unknown[];
  paths?: readonly unknown[];
}
export type RemoteWorkerNativeScope =
  | {
      kind: 'input';
      paneId: string;
      brokerPid: number;
      childPid: number;
      brokerStart: string;
      childStart: string;
    }
  | { kind: 'startup'; muxSessionId: string; paneId: string; panePid: number; serverPid: number };
export interface RemoteWorkerLeaseBinding {
  sessionId: string;
  incarnation: string;
  conversationId: string;
  action: 'input' | 'restart' | 'restore';
  fullPayloadHash: string;
  allowedPhaseHashes: readonly string[];
  native: RemoteWorkerNativeScope;
}
/** The local worker signer authenticates this private scope before SSH dispatch. */
export interface RemoteWorkerLeaseClaim extends RemoteWorkerLeaseBinding {
  version: 1;
  managerSessionId: string;
  managerIncarnation: string;
  nonce: string;
  issuedAt: number;
  deadline: number;
}
export interface SourceHostLeaseProcess {
  ready: Promise<{ status: 'ready'; nonce: string; wallDeadline: number }>;
  closed: Promise<void>;
  terminate(): void;
}
export interface SourceHostLeaseTransport {
  start(helper: string, directory: string, input: string): SourceHostLeaseProcess;
}

function canonicalPrivateDirectory(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Buffer.byteLength(value) <= 4096 &&
    Buffer.from(value).toString('utf8') === value &&
    !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
    posix.isAbsolute(value) &&
    posix.normalize(value) === value
  );
}

function validLeaseNative(
  value: unknown,
  action: RemoteWorkerLeaseBinding['action']
): value is RemoteWorkerNativeScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const native = value as Record<string, unknown>;
  const fields =
    native.kind === 'input'
      ? ['kind', 'paneId', 'brokerPid', 'childPid', 'brokerStart', 'childStart']
      : ['kind', 'muxSessionId', 'paneId', 'panePid', 'serverPid'];
  const identifier = (value: unknown, prefix: string) =>
    typeof value === 'string' &&
    new RegExp('^' + prefix + '(?:0|[1-9]\\d*)$').test(value) &&
    Number.isSafeInteger(Number(value.slice(1)));
  const pid = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  const birth = (value: unknown) =>
    typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
  if (Object.keys(native).sort().join(',') !== fields.sort().join(',') || !identifier(native.paneId, '%')) return false;
  return native.kind === 'input'
    ? action === 'input' &&
        pid(native.brokerPid) &&
        pid(native.childPid) &&
        birth(native.brokerStart) &&
        birth(native.childStart)
    : native.kind === 'startup' &&
        action !== 'input' &&
        identifier(native.muxSessionId, '\\$') &&
        pid(native.panePid) &&
        pid(native.serverPid);
}

const activeLeases = new Set<object>();
export function createSourceHostLeaseTransport(
  startProcess: (helper: string, directory: string) => ChildProcessWithoutNullStreams
): SourceHostLeaseTransport {
  return {
    start(helper, directory, input) {
      const child = startProcess(helper, directory);
      let resolveReady!: (value: { status: 'ready'; nonce: string; wallDeadline: number }) => void;
      let rejectReady!: (error: Error) => void;
      let resolveClosed!: () => void;
      let seen = false,
        output = '',
        diagnostics = 0;
      const ready = new Promise<{ status: 'ready'; nonce: string; wallDeadline: number }>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      child.stdout.on('data', (bytes: Buffer) => {
        if (seen) return;
        output += bytes.toString('utf8');
        if (Buffer.byteLength(output) > MAX_OUTPUT) {
          seen = true;
          rejectReady(new Error('Issuer lease response oversized'));
          return;
        }
        if (!output.endsWith('\n')) return;
        seen = true;
        try {
          const value = JSON.parse(output);
          if (
            !value ||
            Object.keys(value).sort().join(',') !== 'nonce,status,wallDeadline' ||
            value.status !== 'ready' ||
            typeof value.nonce !== 'string' ||
            !UUID.test(value.nonce) ||
            !Number.isSafeInteger(value.wallDeadline)
          )
            throw new Error('Issuer lease response invalid');
          resolveReady(value);
        } catch {
          rejectReady(new Error('Issuer lease response invalid'));
        }
      });
      child.stderr.on('data', (bytes: Buffer) => {
        diagnostics += bytes.length;
        if (!seen && diagnostics > MAX_OUTPUT) {
          seen = true;
          rejectReady(new Error('Issuer lease diagnostics oversized'));
        }
      });
      child.on('error', (error) => {
        rejectReady(error);
      });
      child.stdin.on('error', (error) => {
        rejectReady(error);
      });
      child.on('close', () => {
        rejectReady(new Error('Issuer lease unavailable'));
        resolveClosed();
      });
      child.stdin.end(input);
      return {
        ready,
        closed,
        terminate: () => {
          child.kill();
        },
      };
    },
  };
}
const leaseTransport = createSourceHostLeaseTransport((helper, directory) => {
  if (process.env.VITEST) throw new Error('Issuer lease IO requires an injected fixture under VITEST');
  return spawn('python3', ['-c', helper, '--lease', directory], { stdio: ['pipe', 'pipe', 'pipe'] });
});

/**
 * No claim is minted before the shared broker checker holds the issuer lock.
 * Once dispatch begins, EOF, cancellation and lost replies cannot release it early.
 */
export async function withRemoteBrokerIssuerLease<T>(
  issuer: RemoteBrokerIssuer,
  binding: RemoteWorkerLeaseBinding,
  authority: RemoteBrokerAuthority,
  dispatch: (claim: Readonly<RemoteWorkerLeaseClaim>) => Promise<T>,
  options: { helper: string; durationMs?: number; transport?: SourceHostLeaseTransport }
): Promise<T | 'not-sent' | 'unknown'> {
  const duration = options.durationMs ?? 2_000;
  const start = performance.now(),
    wallStart = Date.now();
  let input: string,
    planned: RemoteWorkerLeaseBinding,
    directory: string,
    issuerScope: string,
    bindingScope: string,
    managerSessionId: string,
    managerIncarnation: string;
  const nonce = randomUUID();
  try {
    if (
      !Number.isInteger(duration) ||
      duration <= 0 ||
      duration > 2_000 ||
      typeof options.helper !== 'string' ||
      !options.helper ||
      Buffer.byteLength(options.helper) > 65_536 ||
      options.helper.includes('\0') ||
      Buffer.from(options.helper).toString('utf8') !== options.helper ||
      !canonicalPrivateDirectory(issuer.directory) ||
      typeof issuer.sessionId !== 'string' ||
      typeof issuer.incarnation !== 'string' ||
      typeof binding.sessionId !== 'string' ||
      typeof binding.incarnation !== 'string' ||
      typeof binding.conversationId !== 'string' ||
      !UUID.test(issuer.sessionId) ||
      !UUID.test(issuer.incarnation) ||
      !UUID.test(binding.sessionId) ||
      !UUID.test(binding.incarnation) ||
      !UUID.test(binding.conversationId) ||
      binding.sessionId === issuer.sessionId ||
      !['input', 'restart', 'restore'].includes(binding.action) ||
      !/^[a-f0-9]{64}$/.test(binding.fullPayloadHash) ||
      !Array.isArray(binding.allowedPhaseHashes) ||
      binding.allowedPhaseHashes.length < 1 ||
      binding.allowedPhaseHashes.length > 9 ||
      binding.allowedPhaseHashes.some((hash) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) ||
      !validLeaseNative(binding.native, binding.action)
    )
      return 'not-sent';
    directory = issuer.directory;
    managerSessionId = issuer.sessionId;
    managerIncarnation = issuer.incarnation;
    issuerScope = JSON.stringify(issuer);
    bindingScope = JSON.stringify(binding);
    planned = {
      sessionId: binding.sessionId,
      incarnation: binding.incarnation,
      conversationId: binding.conversationId,
      action: binding.action,
      fullPayloadHash: binding.fullPayloadHash,
      allowedPhaseHashes: [...binding.allowedPhaseHashes],
      native: structuredClone(binding.native),
    };
    if (Buffer.byteLength(JSON.stringify(planned)) > 16_384) return 'not-sent';
    input = JSON.stringify({ issuer: JSON.parse(issuerScope), durationMs: duration, nonce }) + '\n';
    if (Buffer.byteLength(input) > 98_304) return 'not-sent';
  } catch {
    return 'not-sent';
  }
  const scopeCurrent = () => {
    try {
      return current(authority) && JSON.stringify(issuer) === issuerScope && JSON.stringify(binding) === bindingScope;
    } catch {
      return false;
    }
  };
  if (!scopeCurrent() || activeLeases.size >= 2) return 'not-sent';
  const token = {};
  activeLeases.add(token);
  let process: SourceHostLeaseProcess | undefined,
    dispatched = false,
    exited = false,
    preparationSettled = false,
    finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const preparationBudget = duration - (performance.now() - start);
    if (preparationBudget <= 0) {
      preparationSettled = true;
      return 'not-sent';
    }
    const settlePreparation = (value: unknown) => {
      preparationSettled = true;
      if (finished) activeLeases.delete(token);
      return value === true;
    };
    let preparation: Promise<boolean>;
    try {
      preparation = Promise.resolve(authority.prepare()).then(settlePreparation, () => settlePreparation(false));
    } catch {
      preparationSettled = true;
      return 'not-sent';
    }
    const prepared = await Promise.race([
      preparation,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), preparationBudget);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (prepared !== true || !scopeCurrent() || performance.now() - start >= duration) return 'not-sent';
    process = (options.transport ?? leaseTransport).start(options.helper, directory, input);
    void process.closed
      .finally(() => {
        exited = true;
        activeLeases.delete(token);
      })
      .catch(() => {});
    const remaining = duration - (performance.now() - start);
    if (remaining <= 0) return 'not-sent';
    const ready = await Promise.race([
      process.ready,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), remaining);
      }),
    ]);
    const elapsed = performance.now() - start,
      wallElapsed = Date.now() - wallStart;
    if (
      !ready ||
      ready.status !== 'ready' ||
      ready.nonce !== nonce ||
      !Number.isSafeInteger(ready.wallDeadline) ||
      ready.wallDeadline <= Date.now() ||
      ready.wallDeadline > Date.now() + duration + 100 ||
      exited ||
      elapsed >= duration ||
      wallElapsed < 0 ||
      Math.abs(elapsed - wallElapsed) > 100 ||
      !scopeCurrent()
    )
      return 'not-sent';
    const freeze = (value: unknown): void => {
      if (value && typeof value === 'object') {
        for (const item of Object.values(value)) freeze(item);
        Object.freeze(value);
      }
    };
    freeze(planned);
    const claim: Readonly<RemoteWorkerLeaseClaim> = Object.freeze({
      ...planned,
      version: 1,
      managerSessionId,
      managerIncarnation,
      nonce,
      issuedAt: Date.now(),
      deadline: Math.trunc(Math.min(ready.wallDeadline, Date.now() + duration - elapsed) - 5),
    });
    if (claim.deadline <= claim.issuedAt || !scopeCurrent()) return 'not-sent';
    dispatched = true;
    const result = await dispatch(claim);
    return scopeCurrent() ? result : 'unknown';
  } catch {
    return dispatched ? 'unknown' : 'not-sent';
  } finally {
    finished = true;
    if (timer) clearTimeout(timer);
    // A timed-out filesystem preparation retains its slot until it actually
    // settles, just as a started lease retains the slot until child cleanup.
    if (!process && preparationSettled) activeLeases.delete(token);
    else if (process && !dispatched) process.terminate();
    // The shared Python mode holds its lock until monotonic expiry, including
    // after stdin EOF. Never terminate a helper once its claim went onto SSH.
  }
}

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const MARKER = 'CODEMAN_REMOTE_BROKER_V1:';
const MAX_INPUT = 524_288;
const MAX_OUTPUT = 16_384;
const PROVISION_SOURCE = String.raw`
const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process'),crypto=require('crypto');
const started=require('perf_hooks').performance.now(),check=()=>{if(require('perf_hooks').performance.now()-started>1800)throw Error('expired')};
const emit=x=>process.stdout.write('${MARKER}'+Buffer.from(JSON.stringify(x)).toString('base64')+'\n');
const run=(args)=>{check();const result=cp.execFileSync('tmux',['-L','codeman-remote',...args],{encoding:'utf8',timeout:1500,maxBuffer:16384});check();return result};
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const text=(x,n)=>typeof x==='string'&&Buffer.byteLength(x)<=n&&!x.includes('\0')&&Buffer.from(x).toString('utf8')===x;
let created=false;
try{
 const buffer=Buffer.alloc(524289);let count=0;while(count<buffer.length){const size=fs.readSync(0,buffer,count,buffer.length-count,null);if(!size)break;count+=size}const bytes=buffer.subarray(0,count);if(bytes.length>524288||!Buffer.from(bytes.toString('utf8')).equals(bytes))throw Error('oversized');
 const req=JSON.parse(bytes.toString('utf8')),m=req.material;
 if(!m||!uuid.test(m.sessionId)||!uuid.test(m.incarnation)||!text(m.source,262144)||!m.source||!text(m.configJson,98304)||!text(req.workingDir,4096)||!path.isAbsolute(req.workingDir))throw Error('invalid');
 const cfg=JSON.parse(m.configJson);if(cfg.sessionId!==m.sessionId||cfg.incarnation!==m.incarnation)throw Error('scope');
 const name='codeman-ssh-'+m.sessionId.slice(0,8);
 let present=true;try{run(['has-session','-t',name])}catch(e){if(e.status===1)present=false;else throw e}
 if(present&&!req.expectedPane){emit({status:'existing'});process.exit(0)}
 if(!present&&req.expectedPane){emit({status:'not-sent'});process.exit(0)}
 try{cp.execFileSync('python3',['-c','import pty,fcntl,select,sys,os; assert sys.platform.startswith("linux"); fd=os.open("/proc/self/stat",os.O_RDONLY|os.O_NONBLOCK); raw=os.read(fd,8192); os.close(fd); fields=raw[raw.rfind(b")")+2:].split(); assert len(fields)>=20 and fields[19].isdigit() and 0<int(fields[19])<=9007199254740991'],{stdio:'ignore',timeout:1500});check()}catch{emit({status:'unsupported'});process.exit(0)}
 const base=req.root===undefined?path.join(os.homedir(),'.codeman-input-brokers'):req.root;
 if(!text(base,4096)||!path.isAbsolute(base))throw Error('invalid root');
 if(req.planOnly===true){emit({status:'planned',directory:path.join(base,m.sessionId,m.incarnation),incarnation:m.incarnation});process.exit(0)}
 const channel='codeman-broker-'+crypto.randomBytes(16).toString('hex');
 let row,status='1',signal='';
 if(present){const e=req.expectedPane,f=run(['list-panes','-t',name,'-F','#{session_name}|#{session_id}|#{pane_id}|#{pane_pid}|#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}|#{pid}']).replace(/\n$/,'').split('|');const number=x=>x===''?undefined:/^(?:0|[1-9]\d{0,4})$/.test(x)&&+x<=255?+x:NaN,signum=x=>x===''?undefined:/^(?:0|[1-9]\d{0,4})$/.test(x)&&(+x===0||Object.values(os.constants.signals).includes(+x))?+x:/^[A-Z][A-Z0-9]{0,15}$/.test(x)&&os.constants.signals['SIG'+x]||NaN;if(!e||f.length!==8||f[0]!==name||f[2]!==e.paneId||+f[3]!==e.panePid||f[4]!=='1'||number(f[5])!==e.status||signum(f[6])!==e.signal||(!e.status&&!e.signal))throw Error('replacement');row=[f[1],f[2],f[3],f[7]];status=f[5];signal=f[6]}
 else{created=true;row=run(['new-session','-d','-P','-F','#{session_id}|#{pane_id}|#{pane_pid}|#{pid}','-s',name,'-c',req.workingDir,'/bin/sh','-c','tmux -L codeman-remote wait-for '+channel+'; exit 1']).trim().split('|');created=true}
 if(row.length!==4||!/^\$(?:0|[1-9]\d*)$/.test(row[0])||!Number.isSafeInteger(+row[0].slice(1))||!/^%(?:0|[1-9]\d*)$/.test(row[1])||!Number.isSafeInteger(+row[1].slice(1))||!row.slice(2).every(x=>/^[1-9]\d*$/.test(x)&&Number.isSafeInteger(+x)))throw Error('invalid pane');
 const [sid,pane,pid,server]=row;
 if(!present){run(['set-option','-t',sid,'status','off',';','set-option','-t',sid,'mouse','off',';','set-option','-t',sid,'prefix','C-q',';','set-option','-t',sid,'window-size','latest',';','set-option','-t',sid,'remain-on-exit','failed']);
 run(['wait-for','-S',channel])}
 let dead=false;for(let i=0;i<50;i++){
  const value=run(['list-panes','-t',sid,'-F','#{pane_dead}|#{pane_id}|#{pane_pid}|#{pane_dead_status}|#{pane_dead_signal}|#{pid}']);
  if(value==='1|'+pane+'|'+pid+'|'+status+'|'+signal+'|'+server+'\n'){dead=true;break}
  if(value!=='0|'+pane+'|'+pid+'|||'+server+'\n')throw Error('replacement');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20)
 }
 if(!dead)throw Error('not inert');
 const fields={session_name:name,session_id:sid,pane_id:pane,pane_pid:pid,pane_dead:1,pane_dead_status:status,pane_dead_signal:signal,pid:server};
 const terms=Object.entries(fields).map(([k,v])=>'#{==:#{'+k+'},'+v+'}'),predicate=terms.reduce((a,b)=>'#{&&:'+a+','+b+'}');
 const owned=(initialize=false)=>run(['if-shell','-F','-t',pane,predicate,initialize?'set-option -s escape-time 0 ; display-message -p CODEMAN_BROKER_OWNED':'display-message -p CODEMAN_BROKER_OWNED','display-message -p CODEMAN_BROKER_REFUSED'])==='CODEMAN_BROKER_OWNED\n';
 if(!owned())throw Error('replacement');
 const privateDir=p=>{check();try{fs.mkdirSync(p,{mode:0o700})}catch(e){if(e.code!=='EEXIST')throw e}const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077)!==0||s.uid!==process.getuid())throw Error('private root');check()};
 created=true;privateDir(base);const sessionRoot=path.join(base,m.sessionId);privateDir(sessionRoot);
 const directory=path.join(sessionRoot,m.incarnation);fs.mkdirSync(directory,{mode:0o700});check();
 for(const [file,data] of [['broker.py',m.source],['config.json',m.configJson],['lock','']]){
  check();const fd=fs.openSync(path.join(directory,file),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  try{fs.writeFileSync(fd,data);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}check()
 }
 for(const p of [directory,sessionRoot,base]){const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}check()}
 if(!owned(req.ownerInitialLaunch===true&&!present))throw Error('replacement');
 emit({status:'provisioned',directory,incarnation:m.incarnation,pane:{sessionId:sid,paneId:pane,panePid:+pid,serverPid:+server}})
}catch{emit({status:created?'unknown':'not-sent'})}
`;

/** Never places material, authentication keys or owner input in argv or environment. */
export function buildRemoteBrokerProvisionCommand(remote: SessionRemote): string {
  return [
    ...buildSshConnectionArgs(remote),
    remoteSshTarget(remote),
    shellescape(remoteLoginShellCommand(`node -e ${shellescape(PROVISION_SOURCE)}`)),
  ].join(' ');
}

function current(authority: RemoteBrokerAuthority): boolean {
  try {
    const result: unknown = authority.isCurrent();
    if (result instanceof Promise) {
      void result.catch(() => {});
      return false;
    }
    return result === true;
  } catch {
    return false;
  }
}

export async function provisionRemoteInputBroker(
  remote: SessionRemote,
  material: RemoteBrokerMaterial,
  authority: RemoteBrokerAuthority,
  options: {
    root?: string;
    transport?: RemoteBrokerTransport;
    expectedPane?: RemoteBrokerDeadPane;
    planOnly?: boolean;
    /** Only explicit ordinary owner creation may initialize the server input option. */
    ownerInitialLaunch?: boolean;
  } = {}
): Promise<RemoteBrokerProvisionResult> {
  let input: string;
  let remoteSnapshot: SessionRemote;
  let remoteScope: string;
  let planned: RemoteBrokerMaterial;
  const expectedRoot = options.root;
  const planOnly = options.planOnly === true;
  const deadline = brokerPerformance.now() + 15_000;
  const positiveInteger = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === keys.sort().join(',');
  const validText = (text: string, maximum: number) =>
    typeof text === 'string' &&
    !text.includes('\0') &&
    Buffer.byteLength(text) <= maximum &&
    Buffer.from(text).toString('utf8') === text;
  try {
    if (expectedRoot !== undefined && !canonicalPrivateDirectory(expectedRoot)) return { status: 'not-sent' };
    remoteSnapshot = structuredClone(remote);
    remoteScope = JSON.stringify(remote);
    planned = {
      source: material.source,
      configJson: material.configJson,
      sessionId: material.sessionId,
      incarnation: material.incarnation,
    };
    if (
      remote.owned === false ||
      !UUID.test(material.sessionId) ||
      !UUID.test(material.incarnation) ||
      !material.source ||
      !validText(material.source, 262_144) ||
      !validText(material.configJson, 98_304)
    )
      return { status: 'not-sent' };
    const config = JSON.parse(material.configJson);
    if (config.sessionId !== material.sessionId || config.incarnation !== material.incarnation)
      return { status: 'not-sent' };
    if (
      options.expectedPane &&
      (!/^%(?:0|[1-9]\d*)$/.test(options.expectedPane.paneId) ||
        !Number.isSafeInteger(+options.expectedPane.paneId.slice(1)) ||
        !positiveInteger(options.expectedPane.panePid) ||
        [options.expectedPane.status, options.expectedPane.signal].some(
          (x) => x !== undefined && (!Number.isSafeInteger(x) || x < 0 || x > 65535)
        ))
    )
      return { status: 'not-sent' };
    input = JSON.stringify({
      material: planned,
      workingDir: remoteSnapshot.remotePath,
      root: expectedRoot,
      expectedPane: options.expectedPane,
      planOnly,
      ownerInitialLaunch: options.ownerInitialLaunch === true,
    });
    if (Buffer.byteLength(input) > MAX_INPUT) return { status: 'not-sent' };
  } catch {
    return { status: 'not-sent' };
  }
  const scopeCurrent = () =>
    brokerPerformance.now() < deadline &&
    remote.owned !== false &&
    JSON.stringify(remote) === remoteScope &&
    current(authority);
  return runWithRemoteSshLimit<RemoteBrokerProvisionResult>(
    async (retain) => {
      let dispatched = false;
      try {
        if (!scopeCurrent() || (await authority.prepare()) !== true || !scopeCurrent()) return { status: 'not-sent' };
        const command = buildRemoteBrokerProvisionCommand(remoteSnapshot);
        if (!scopeCurrent()) return { status: 'not-sent' };
        dispatched = true;
        const { stdout } = await (options.transport
          ? options.transport.run(command, input)
          : runRemoteBrokerStdin(command, input, { inputBytes: MAX_INPUT, outputBytes: MAX_OUTPUT, deadline }, retain));
        if (Buffer.byteLength(stdout) > MAX_OUTPUT) return { status: 'unknown' };
        const lines = stdout.split('\n').filter((line) => line.startsWith(MARKER));
        if (lines.length !== 1) return { status: 'unknown' };
        const encoded = lines[0].slice(MARKER.length),
          bytes = Buffer.from(encoded, 'base64');
        if (
          bytes.toString('base64') !== encoded ||
          !Buffer.from(bytes.toString('utf8')).equals(bytes) ||
          !scopeCurrent()
        )
          return { status: 'unknown' };
        const value = JSON.parse(bytes.toString('utf8'));
        if (planOnly && value.status === 'planned') {
          if (
            !exact(value, ['status', 'directory', 'incarnation']) ||
            value.incarnation !== planned.incarnation ||
            !canonicalPrivateDirectory(value.directory) ||
            !value.directory.endsWith(`/${planned.sessionId}/${planned.incarnation}`) ||
            (expectedRoot !== undefined &&
              value.directory !== posix.join(expectedRoot, planned.sessionId, planned.incarnation))
          )
            return { status: 'not-sent' };
          return { status: 'planned', directory: value.directory, incarnation: value.incarnation };
        }
        if (
          value.status === 'existing' ||
          value.status === 'unsupported' ||
          value.status === 'not-sent' ||
          value.status === 'unknown'
        )
          return exact(value, ['status']) && scopeCurrent() ? { status: value.status } : { status: 'unknown' };
        if (planOnly) return { status: 'not-sent' };
        if (
          !exact(value, ['status', 'directory', 'incarnation', 'pane']) ||
          value.status !== 'provisioned' ||
          value.incarnation !== planned.incarnation ||
          !canonicalPrivateDirectory(value.directory) ||
          (expectedRoot !== undefined &&
            value.directory !== posix.join(expectedRoot, planned.sessionId, planned.incarnation)) ||
          !value.directory.endsWith(`/${planned.sessionId}/${planned.incarnation}`) ||
          !exact(value.pane, ['sessionId', 'paneId', 'panePid', 'serverPid']) ||
          typeof value.pane.sessionId !== 'string' ||
          !/^\$(?:0|[1-9]\d*)$/.test(value.pane.sessionId) ||
          !Number.isSafeInteger(Number(value.pane.sessionId.slice(1))) ||
          typeof value.pane.paneId !== 'string' ||
          !/^%(?:0|[1-9]\d*)$/.test(value.pane.paneId) ||
          !Number.isSafeInteger(Number(value.pane.paneId.slice(1))) ||
          !positiveInteger(value.pane.panePid) ||
          !positiveInteger(value.pane.serverPid)
        )
          return { status: 'unknown' };
        if (!scopeCurrent()) return { status: 'unknown' };
        return {
          status: 'provisioned',
          directory: value.directory,
          incarnation: value.incarnation,
          pane: {
            sessionId: value.pane.sessionId,
            paneId: value.pane.paneId,
            panePid: value.pane.panePid,
            serverPid: value.pane.serverPid,
          },
        };
      } catch {
        return { status: dispatched ? 'unknown' : 'not-sent' };
      }
    },
    { deadline, isCurrent: scopeCurrent }
  ).catch(
    (error: unknown): RemoteBrokerProvisionResult => ({
      status: error instanceof RemoteSshAdmissionError ? 'not-sent' : 'unknown',
    })
  );
}
