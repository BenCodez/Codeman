/** @fileoverview Bounded, fail-closed Codex evidence and mutation over the configured SSH transport. */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, posix } from 'node:path';
import { performance } from 'node:perf_hooks';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { CodexConfig, SessionRemote } from '../types.js';
import { CODEX_REASONING_EFFORTS } from '../types/session.js';
import { buildSshConnectionArgs, remoteLoginShellCommand, remoteSshTarget, shellescape } from '../remote-hosts.js';
import { runWithRemoteSshLimit } from '../remote-ssh-limiter.js';
import { buildRemoteCodexPaneCommand, remoteTmuxSessionName } from '../tmux-manager.js';
import { CodexInputBroker, type CodexBrokerProof } from './codex-input-broker.js';
import { CODEX_INPUT_BROKER_SOURCE } from './codex-input-broker-source.js';
import { REMOTE_INPUT_BROKER_READER } from './remote-input-broker-reader.js';
import {
  ownedRemoteBrokerCache,
  type OwnedRemoteBrokerDescriptor,
  type OwnedRemoteBrokerCache,
} from './remote-input-broker-cache.js';
import type { PrivateFileWitness } from './private-file-witness.js';
import {
  provisionRemoteInputBroker,
  withRemoteBrokerIssuerLease,
  type RemoteBrokerIssuer,
  type RemoteWorkerLeaseClaim,
  type RemoteWorkerLeaseBinding,
  type RemoteBrokerPane,
  type RemoteBrokerTransport,
  type SourceHostLeaseTransport,
} from './remote-input-broker.js';
import {
  clockFromBoundary,
  consistentRemoteClock,
  remoteClockOffset,
  remoteSubmissionWindow,
  remoteToLocal,
  sampleRemoteCodexClock,
  type RecoverySubmission,
  type RemoteClockWitness,
} from './remote-clock.js';

const execAsync = promisify(exec);
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MARKER = 'CODEMAN_REMOTE_CODEX_V1:';
const MAX_REMOTE_CODEX_RECORD_BYTES = 512 * 1024;
const MAX_REMOTE_CODEX_STDOUT_BYTES = 768 * 1024;

export interface RemoteCodexPaneEvidence {
  dead: boolean;
  status?: number;
  signal?: number;
  paneId: string;
  panePid: number;
  screen: string | null;
}

export type RemoteCodexEvidence =
  | { transport: 'unreachable'; session: 'unknown'; identity: { reason: 'unreadable' } }
  | { transport: 'unavailable'; session: 'unknown'; identity: { reason: 'unreadable' } }
  | { transport: 'reachable'; session: 'unknown'; identity: { reason: 'unsupported' | 'unreadable' } }
  | {
      transport: 'reachable';
      session: 'missing' | 'present';
      pane?: RemoteCodexPaneEvidence;
      clock?: RemoteClockWitness;
      inputBroker?: { serialized: string; witness: PrivateFileWitness; historical?: true };
      frameAdmission?: RemoteFrameAdmission & { fits: boolean };
      identity: {
        reason: 'verified' | 'ambiguous' | 'unverified' | 'unreadable';
        conversationId?: string;
        tail?: string;
        tailTruncated?: boolean;
        changedAt?: number;
      };
    };

export interface RemoteFrameAdmission {
  promptHash: string;
  maxPhaseBytes: number;
  issuerLeaseBytes: number;
}

export interface RemoteCodexEvidenceRequest {
  /** Passive packet sizing only: never probes or allocates an input frame. */
  frameAdmission?: RemoteFrameAdmission;
  sessionId: string;
  workingDir: string;
  codexHome?: string;
  resumeId?: string;
  submission?: RecoverySubmission & { uncertaintyMs?: number };
  /** Internal fresh clock proof for the remote dispatch boundary. */
  dispatchClock?: { localAt: number; min: number; max: number };
  /** Private retained controlled launch; an existing remote pane cannot create this. */
  inputBroker?: OwnedRemoteBrokerDescriptor;
  issuerLease?: Readonly<RemoteWorkerLeaseClaim>;
  actionDeadline?: number;
  newInputBroker?: { descriptor: OwnedRemoteBrokerDescriptor; pane: RemoteBrokerPane };
}

interface WireEvidence {
  frameAdmission?: RemoteFrameAdmission & { fits: boolean };
  v: 1;
  session: 'missing' | 'present';
  action?: 'sent' | 'not-sent';
  actionAt?: number;
  clock?: { remoteBefore: number; remoteAfter: number };
  inputBroker?: { serialized: string; witness: PrivateFileWitness; historical?: true };
  newInputBroker?: { serialized: string; witness: PrivateFileWitness; panePid: number };
  pane?: Omit<RemoteCodexPaneEvidence, 'screen'> & { screen?: string };
  identity: {
    reason: 'verified' | 'ambiguous' | 'unverified' | 'unreadable';
    conversationId?: string;
    tail?: string;
    tailTruncated?: boolean;
    changedAt?: number;
  };
}

export interface RemoteCodexIdentityGuard {
  conversationId: string;
  tailHash: string;
}

export interface RemoteCodexInputRequest extends RemoteCodexEvidenceRequest {
  expected: RemoteCodexIdentityGuard &
    Pick<RemoteCodexPaneEvidence, 'paneId' | 'panePid'> & { screenHash: string; inputProof?: CodexBrokerProof };
  prompt: string;
}

export type RemoteCodexInputResult =
  | { status: 'sent'; submittedAt: number; clock?: RemoteClockWitness }
  | { status: 'not-sent' | 'unknown' };

export type RemoteCodexActionAuthority =
  | (() => boolean)
  | {
      check: () => boolean | Promise<boolean>;
      isCurrent: () => boolean;
      getInputIssuer?: () => RemoteBrokerIssuer | undefined;
      getActionDeadline?: () => number;
      reserveInputBroker?: (expectedOldInc: string, newInc: string) => Promise<boolean>;
      commitInputBroker?: (expectedOldInc: string, newInc: string) => Promise<boolean>;
    };

/** Explicit disposable transports are mandatory under VITEST; never a live fallback. */
export interface RemoteCodexExecutionOptions {
  transport?: {
    clock(remote: SessionRemote): Promise<RemoteClockWitness | undefined>;
    run(command: string): Promise<{ stdout: string }>;
  };
  provisionTransport?: RemoteBrokerTransport;
  issuerLeaseTransport?: SourceHostLeaseTransport;
  cache?: OwnedRemoteBrokerCache;
}

function currentRemoteAuthority(authority: RemoteCodexActionAuthority): boolean {
  try {
    const verdict: unknown = (typeof authority === 'function' ? authority : authority.isCurrent)();
    if (verdict instanceof Promise || (verdict && typeof (verdict as { then?: unknown }).then === 'function')) {
      void Promise.resolve(verdict).catch(() => {});
      return false;
    }
    return verdict === true;
  } catch {
    return false;
  }
}

export const MAX_REMOTE_CODEX_PROMPT_BYTES = 64 * 1024;
const MAX_REMOTE_CODEX_COMMAND_BYTES = 120 * 1024;

/** The source lease and target reader use identical Unicode-safe literal phases. */
export function remoteInputPhases(prompt: string): string[] {
  const chunks: string[] = [];
  let chunk = '',
    bytes = 0;
  for (const point of prompt) {
    const size = Buffer.byteLength(point);
    if (bytes + size > 8192) {
      chunks.push(chunk);
      chunk = '';
      bytes = 0;
    }
    chunk += point;
    bytes += size;
  }
  if (chunk || !chunks.length) chunks.push(chunk);
  return [...chunks, '\r'];
}

function remoteInputLeaseBound(prompt: string, issuer: RemoteBrokerIssuer) {
  const max = Number.MAX_SAFE_INTEGER,
    nonce = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  const phases = remoteInputPhases(prompt);
  const binding: RemoteWorkerLeaseBinding = {
    sessionId: nonce,
    incarnation: nonce,
    conversationId: nonce,
    action: 'input',
    fullPayloadHash: createHash('sha256').update(prompt).digest('hex'),
    allowedPhaseHashes: phases.map((phase) => createHash('sha256').update(phase).digest('hex')),
    native: {
      kind: 'input',
      paneId: '%' + max,
      brokerPid: max,
      childPid: max,
      brokerStart: String(max),
      childStart: String(max),
    },
  };
  const claim: RemoteWorkerLeaseClaim = {
    ...binding,
    version: 1,
    managerSessionId: issuer.sessionId,
    managerIncarnation: issuer.incarnation,
    nonce,
    issuedAt: max,
    deadline: max,
  };
  return { binding, claim };
}

/** Size source-private lease input and the largest remote phase without allocating a lease. */
export function remotePromptFrameAdmission(
  prompt: string,
  issuer?: RemoteBrokerIssuer
): RemoteFrameAdmission | undefined {
  const bytes = Buffer.from(prompt, 'utf8');
  if (
    !bytes.length ||
    bytes.length > MAX_REMOTE_CODEX_PROMPT_BYTES ||
    bytes.includes(0) ||
    bytes.toString('utf8') !== prompt
  )
    return undefined;
  const phases = remoteInputPhases(prompt);
  let issuerLeaseBytes = 0;
  if (issuer) {
    if (phases.length > 9) return undefined;
    if (!UUID.test(issuer.sessionId) || !UUID.test(issuer.incarnation)) return undefined;
    const nonce = 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      max = Number.MAX_SAFE_INTEGER;
    // These are the actual source lease transport's stdin and planned-binding bounds.
    if (Buffer.byteLength(JSON.stringify({ issuer, durationMs: 2000, nonce }) + '\n') > 98_304) return undefined;
    const { binding, claim } = remoteInputLeaseBound(prompt, issuer);
    if (Buffer.byteLength(JSON.stringify(binding)) > 16_384) return undefined;
    issuerLeaseBytes = Buffer.byteLength(
      JSON.stringify({ claim, phaseIndex: max, remoteDeadline: 2 * max, clock: { localAt: max, min: -max, max: -max } })
    );
  }
  return {
    promptHash: createHash('sha256').update(bytes).digest('hex'),
    maxPhaseBytes: Math.max(...phases.map((phase) => Buffer.byteLength(phase))),
    issuerLeaseBytes,
  };
}

/**
 * Runs wholly on the remote host. It emits one marked JSON record and no private
 * text outside base64 fields, caps traversal/read sizes, and refuses symlinks.
 * The source is passed as one shell token; no request value is interpolated into it.
 */
const REMOTE_CODEX_INSPECT_SCRIPT = String.raw`
const fs=require('fs'),path=require('path'),cp=require('child_process'),crypto=require('crypto'),signals=require('os').constants.signals,performance=require('perf_hooks').performance;
const out=x=>process.stdout.write('${MARKER}'+Buffer.from(JSON.stringify(x)).toString('base64')+'\n');
// Only the tmux server can atomically compare native identity and queue the effect.
// tmux quoted strings cannot contain raw newlines: emit control bytes as octal outside quotes.
const tq=x=>"'"+String(x).replace(/['\x01-\x1f\x7f]/g,c=>c==="'"?"'\\''":"'\\"+c.charCodeAt(0).toString(8).padStart(3,"0")+"'")+"'";
const nativeEffect=(target,fields,args)=>{check();const terms=Object.entries(fields).map(([key,value])=>"#{==:#{"+key+"},"+value+"}"),predicate=terms.reduce((all,term)=>"#{&&:"+all+","+term+"}");const result=cp.execFileSync("tmux",["-L","codeman-remote","if-shell","-F","-t",target,predicate,args.map(tq).join(" "),"display-message -p CODEMAN_REMOTE_PANE_REFUSED"],{encoding:"utf8",timeout:1500,maxBuffer:16384}).trim();if(result==="CODEMAN_REMOTE_PANE_REFUSED")return false;if(result)refusal("unreadable");return true};
// Joined captures retain literal multiline input while removing native wrapping.
// Compare exactly the bytes already pasted, never infer continuation-row indentation.
// Plain placeholder text cannot prove emptiness; only our known writes may acknowledge that text.
const composerState=(target,expected,settling=false)=>{try{check();const screen=cp.execFileSync("tmux",["-L","codeman-remote","capture-pane","-p","-J","-t",target],{encoding:"utf8",timeout:1500,maxBuffer:81920});check();const rows=screen.split("\n");while(rows.length&&!rows[rows.length-1].trim())rows.pop();let shortcut="";if(rows.length&&/^\s*(?:← for agents · )?\? for shortcuts\s*$/u.test(rows[rows.length-1]))shortcut=rows.pop();const footer=rows.pop();if(!footer||!/^\s{2,}\S+\s+(?:${['default', ...CODEX_REASONING_EFFORTS].join('|')})\s+·\s+\S.*$/u.test(footer))return "invalid";const body=rows.join("\n"),candidates=expected===undefined?[""]:[expected];for(const text of candidates){if(!body.endsWith(text))continue;const prefix=body.slice(0,body.length-text.length),match=/(?:^|\n)[ \t]*› ?$/u.exec(prefix);if(!match)continue;const chrome=prefix.slice(0,match.index)+"\n"+footer+"\n"+shortcut;if(!/esc to interrupt|reconnecting|would you like|approve this|sign in|log in|authentication failed|usage limit|limit reached/i.test(chrome))return "current";return "invalid"}if(settling){const glyph=/(?:^|\n)[ \t]*› ?/gu;let match;while((match=glyph.exec(body))){const text=body.slice(match.index+match[0].length);if(!expected.startsWith(text))continue;const chrome=body.slice(0,match.index)+"\n"+footer+"\n"+shortcut;if(!/esc to interrupt|reconnecting|would you like|approve this|sign in|log in|authentication failed|usage limit|limit reached/i.test(chrome))return "pending";return "invalid"}}return "invalid"}catch{return "invalid"}};
// Literal input is queued before the TUI paints it. Poll only read-only state;
// the original clock/private witness/native fences and deadline never reset.
let composerPolls=0;const composerSettled=(target,expected,fields)=>{for(;composerPolls<128;){composerPolls++;confirmWitness();check();const state=composerState(target,expected,true);confirmWitness();check();if(state==="current")return true;if(state!=="pending")return false;const format="#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}|#{pane_id}|#{pane_pid}",row=cp.execFileSync("tmux",["-L","codeman-remote","list-panes","-t",target,"-F",format],{encoding:"utf8",timeout:1500,maxBuffer:16384});check();if(row!==[fields.pane_dead,fields.pane_dead_status,fields.pane_dead_signal,fields.pane_id,fields.pane_pid].join("|")+"\n")return false;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20)}return false};

const req=JSON.parse(Buffer.from(process.argv[1]||'','base64').toString('utf8'));
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const refusal=r=>{throw Object.assign(new Error(r),{reason:r})};
const started=Date.now(),monotonicStarted=performance.now(),check=()=>{const elapsed=Date.now()-started,monotonic=performance.now()-monotonicStarted;if(elapsed<0||elapsed>1800||monotonic>1800||Math.abs(elapsed-monotonic)>100||(req.actionDeadline!==undefined&&Date.now()>=req.actionDeadline))refusal('unreadable')};
if(req.actionDeadline!==undefined&&(!Number.isSafeInteger(req.actionDeadline)||req.actionDeadline<=started))refusal('unverified');
if(req.dispatchClock){const c=req.dispatchClock;if(!Number.isSafeInteger(c.localAt)||c.localAt<=0||!Number.isSafeInteger(c.min)||!Number.isSafeInteger(c.max)||c.max<c.min||c.max-c.min>1000||started<c.localAt+c.min||started>c.localAt+c.max+1000)refusal('unverified')}
// Pin every bounded identity dependency across blocking pane checks. Ancestors
// need inode/type identity; scanned directories and read files also pin content.
const witness=new Map(),signature=(s,contents)=>[s.dev,s.ino,s.mode,...(contents?[s.size,s.mtimeMs,s.ctimeMs]:[])].join(':');
const remember=(p,s,contents=true)=>{const key=(contents?'content:':'identity:')+p,value=signature(s,contents),previous=witness.get(key);if(previous&&previous.value!==value)refusal('unverified');witness.set(key,{p,contents,value})};
const confirmWitness=()=>{for(const x of witness.values()){check();if(signature(fs.lstatSync(x.p),x.contents)!==x.value)refusal('unverified')}};
const read=(p,n,tail=false)=>{check();const a=fs.lstatSync(p);if(!a.isFile()||a.isSymbolicLink())refusal('unverified');remember(p,a);const f=fs.openSync(p,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0)|(fs.constants.O_NONBLOCK||0));try{const s=fs.fstatSync(f);if(signature(s,true)!==signature(a,true))refusal('unverified');const l=Math.min(n,s.size),b=Buffer.alloc(l),o=tail?Math.max(0,s.size-l):0;if(fs.readSync(f,b,0,l,o)!==l||signature(fs.fstatSync(f),true)!==signature(s,true))refusal('unverified');let t=b.toString('utf8'),truncated=s.size>n;if(tail&&truncated){const i=t.indexOf('\n');if(i<0)refusal('unverified');t=t.slice(i+1)}return {text:t,mtime:s.mtimeMs,truncated}}finally{fs.closeSync(f)}};
const validHome=x=>typeof x==='string'&&x.length>0&&Buffer.byteLength(x,'utf8')<=4096&&!x.includes('\0')&&path.isAbsolute(x);
if(!req||typeof req.sessionId!=='string'||!uuid.test(req.sessionId)||typeof req.remoteSessionName!=='string'||!/^codeman-ssh-[a-f0-9]{8}$/i.test(req.remoteSessionName)||typeof req.workingDir!=='string'||!path.isAbsolute(req.workingDir)||!validHome(req.codexHome)||(req.resumeId!==undefined&&(typeof req.resumeId!=='string'||!uuid.test(req.resumeId)))||(!req.submission||!Number.isFinite(req.submission.at)||req.submission.at<=0||typeof req.submission.hash!=='string'||!/^[a-f0-9]{64}$/.test(req.submission.hash)))refusal('unverified');
let actionPrompt;if(req.action!==undefined){const a=req.action,e=a&&a.expected;if(!a||!e||!['input','restart','restore'].includes(a.kind)||typeof e.conversationId!=='string'||!uuid.test(e.conversationId)||typeof e.tailHash!=='string'||!/^[a-f0-9]{64}$/.test(e.tailHash)||(a.kind!=='restore'&&(typeof e.paneId!=='string'||!/^%\d+$/.test(e.paneId)||!Number.isSafeInteger(e.panePid)||e.panePid<=0)))refusal('unverified');if(a.kind==='input'){if(typeof e.screenHash!=='string'||!/^[a-f0-9]{64}$/.test(e.screenHash)||typeof a.prompt!=='string')refusal('unverified');const b=Buffer.from(a.prompt,'utf8');if(b.length>65536||b.includes(0)||b.toString('utf8')!==a.prompt)refusal('unverified');actionPrompt=a.prompt}else if(typeof a.command!=='string'||!a.command||Buffer.byteLength(a.command)>32768||a.command.includes('\0')||(e.status!==undefined&&(!Number.isInteger(e.status)||e.status<0||e.status>65535))||(e.signal!==undefined&&(!Number.isInteger(e.signal)||e.signal<0||e.signal>65535)))refusal('unverified')}
const home=path.resolve(req.codexHome);
const root=path.parse(home).root,components=home.slice(root.length).split(path.sep).filter(Boolean);if(components.length>32)refusal('unverified');let cur=root;remember(root,fs.lstatSync(root),false);for(const c of components){cur=path.join(cur,c);const s=fs.lstatSync(cur);if(!s.isDirectory()||s.isSymbolicLink())refusal('unverified');remember(cur,s,false)}
let dirs=0,entries=0,files=0,found=[];
const header=p=>{const h=read(p,131072).text,n=h.indexOf('\n');if(n<0)refusal('unverified');let j;try{j=JSON.parse(h.slice(0,n))}catch{refusal('unverified')}const q=j&&j.type==='session_meta'&&j.payload,m=/^rollout-[A-Za-z0-9T:._+-]+-([a-f0-9-]{36})\.jsonl$/i.exec(path.basename(p)),at=Date.parse(q&&(q.timestamp||j.timestamp));if(!q||!m||!uuid.test(m[1])||(q.id||q.session_id)!==m[1]||(q.session_id!==undefined&&q.session_id!==m[1])||typeof q.cwd!=='string'||!path.isAbsolute(q.cwd)||!Number.isFinite(at)||(q.originator!==undefined&&typeof q.originator!=='string'))refusal('unverified');let sub=false;for(const s of [q.thread_source,q.source]){if(s===undefined)continue;if(typeof s==='string')sub||=s.toLowerCase().includes('subagent');else if(s&&typeof s==='object'&&Object.prototype.hasOwnProperty.call(s,'subagent'))sub=true;else refusal('unverified')}return{id:m[1],cwd:path.resolve(q.cwd),origin:q.originator,createdAt:at,sub,p}};
const visit=(d,depth)=>{check();if(depth>5||++dirs>256)refusal('unverified');const ds=fs.lstatSync(d);if(!ds.isDirectory()||ds.isSymbolicLink())refusal('unverified');remember(d,ds);const dh=fs.opendirSync(d,{bufferSize:32});try{for(let e;(e=dh.readSync());){check();if(++entries>8192)refusal('unverified');const p=path.join(d,e.name);if(e.isSymbolicLink())refusal('unverified');if(e.isDirectory())visit(p,depth+1);else{if(++files>1024)refusal('unverified');if(e.name.startsWith('rollout-')&&e.name.endsWith('.jsonl'))found.push(header(p))}}}finally{dh.closeSync()}};
const history=()=>{if(!req.submission)return;const uncertainty=req.submission.uncertaintyMs??0;if(!Number.isFinite(uncertainty)||uncertainty<0||uncertainty>500)refusal('unverified');const w=read(path.join(home,'history.jsonl'),262144,true);if(w.text&&!w.text.endsWith('\n'))refusal('unverified');let all=[];for(const line of w.text.split('\n')){if(!line)continue;let x;try{x=JSON.parse(line)}catch{refusal('unverified')}if(!x||typeof x.session_id!=='string'||!uuid.test(x.session_id)||!Number.isFinite(x.ts)||typeof x.text!=='string')refusal('unverified');const at=x.ts*1000;if(!Number.isFinite(at)||at<=0||at>Number.MAX_SAFE_INTEGER||at>started+2000)refusal('unverified');all.push({id:x.session_id,at,hash:crypto.createHash('sha256').update(x.text,'utf8').digest('hex')})}if(all.some((x,i)=>i&&x.at<all[i-1].at))refusal('unverified');const lower=req.submission.at-2000-uncertainty;if(w.truncated&&(!all.length||all[0].at>=lower))refusal('unverified');const matches=all.filter(x=>x.hash===req.submission.hash&&Math.abs(x.at-req.submission.at)<=2000+uncertainty);if(matches.length!==1)refusal(matches.length?'ambiguous':'unverified');if(Math.abs(matches[0].at-req.submission.at)+uncertainty>2000)refusal('unverified');if(all[all.length-1].id!==matches[0].id)refusal('ambiguous');return matches[0]};
let identity={reason:'unverified'},identityTailHash,identityProof;try{visit(path.join(home,'sessions'),0);const ids=new Set;for(const x of found){if(ids.has(x.id))refusal('ambiguous');ids.add(x.id)}const candidates=found.filter(x=>x.cwd===path.resolve(req.workingDir)&&!x.sub),fresh=candidates.filter(x=>x.origin==='codeman_'+req.sessionId).sort((a,b)=>b.createdAt-a.createdAt);if(fresh.length>1&&fresh[0].createdAt===fresh[1].createdAt)refusal('ambiguous');const newest=fresh[0],matched=history();if(!matched)refusal('unverified');const selected=candidates.find(x=>x.id===matched.id);if(newest&&newest.id!==matched.id&&newest.createdAt>matched.at)refusal('ambiguous');if(!selected)refusal('unverified');const again=header(selected.p);if(again.id!==selected.id||again.cwd!==selected.cwd||again.origin!==selected.origin||again.createdAt!==selected.createdAt||again.sub)refusal('unverified');const t=read(selected.p,262144,true);if(!t.text.endsWith('\n'))refusal('unverified');identityTailHash=crypto.createHash('sha256').update(t.text,'utf8').digest('hex');identityProof=again;identity={reason:'verified',conversationId:selected.id,tail:Buffer.from(t.text).toString('base64'),tailTruncated:t.truncated,changedAt:t.mtime}}catch(e){identity={reason:e&&e.reason||'unreadable'}}
const name=req.remoteSessionName;let session='present',pane,screenText,nativeFields;try{cp.execFileSync('tmux',['-L','codeman-remote','has-session','-t',name],{stdio:'ignore',timeout:1500})}catch(e){if(e&&e.status===1)session='missing';else refusal('unreadable')}
if(session==='present'){const row=cp.execFileSync('tmux',['-L','codeman-remote','list-panes','-t',name,'-F','#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}|#{pane_id}|#{pane_pid}'],{encoding:'utf8',timeout:1500,maxBuffer:16384}).replace(/\n$/,'').split('\n');if(row.length!==1||row[0].includes('\r'))refusal('unverified');const f=row[0].split('|');if(f.length!==5||!/^[01]$/.test(f[0])||!/^%(?:0|[1-9]\d*)$/.test(f[3])||!Number.isSafeInteger(+f[3].slice(1))||!/^[1-9]\d*$/.test(f[4])||!Number.isSafeInteger(+f[4]))refusal('unverified');const number=x=>{if(x==="")return undefined;if(!/^(?:0|[1-9]\d{0,4})$/.test(x)||+x>255)refusal("unverified");return +x},signal=x=>{if(x===""||/^(?:0|[1-9]\d{0,4})$/.test(x)){const n=number(x);if(n!==undefined&&n!==0&&!Object.values(signals).includes(n))refusal("unverified");return n;}const n=/^[A-Z][A-Z0-9]{0,15}$/.test(x)?signals["SIG"+x]:undefined;if(!Number.isSafeInteger(n)||n<=0||n>65535)refusal("unverified");return n};pane={dead:f[0]==='1',status:number(f[1]),signal:signal(f[2]),paneId:f[3],panePid:+f[4]};if((pane.status!==undefined&&(pane.signal||0)>0)||(!pane.dead&&(pane.status!==undefined||pane.signal!==undefined)))refusal("unverified");nativeFields={session_name:name,pane_id:f[3],pane_pid:f[4],pane_dead:f[0],pane_dead_status:f[1],pane_dead_signal:f[2]};if(!pane.dead){screenText=cp.execFileSync('tmux',['-L','codeman-remote','capture-pane','-p','-t',pane.paneId],{encoding:'utf8',timeout:1500,maxBuffer:65536});pane.screen=Buffer.from(screenText).toString('base64')}}
${REMOTE_INPUT_BROKER_READER}
let frameAdmission;const preview=req.frameAdmission;if(preview!==undefined&&(!brokerExact(preview,['promptHash','maxPhaseBytes','issuerLeaseBytes'])||req.action||!req.inputBroker||!/^([a-f0-9]{64})$/.test(preview.promptHash)||!Number.isSafeInteger(preview.maxPhaseBytes)||preview.maxPhaseBytes<1||preview.maxPhaseBytes>8192||!Number.isSafeInteger(preview.issuerLeaseBytes)||preview.issuerLeaseBytes<0||preview.issuerLeaseBytes>16384))refusal('unverified');
let brokerVerified=false;try{if(req.inputBroker&&(session==='missing'||pane)){brokerOpen();if(req.action){const expected=req.action.expected.inputProof;if(!expected||expected.incarnation!==brokerDescriptor.incarnation||expected.brokerPid!==brokerState.pid||expected.childPid!==brokerState.childPid||expected.brokerStart!==brokerState.brokerStart||expected.childStart!==brokerState.childStart||expected.closed!==brokerState.closed||expected.rawGeneration!==0||expected.launchDigest!==brokerState.launchDigest||expected.homeDigest!==brokerState.homeDigest||!brokerExact(expected.ownerCounters,brokerOwners)||!brokerOwners.every(k=>expected.ownerCounters[k]===brokerState.counters[k])||!expected.fileWitness||JSON.stringify(expected.fileWitness)!==JSON.stringify(brokerSnapshot.witness))refusal('unverified')}if(!preview)brokerProbe();brokerVerified=true}}catch(e){identity={reason:e&&e.reason||'unreadable'}}
if(!req.action&&identity.reason==='verified'){try{confirmWitness();if(brokerVerified)brokerCurrent()}catch(e){identity={reason:e&&e.reason||'unreadable'}}}
if(preview&&brokerVerified&&session==='present'&&pane&&!pane.dead&&identity.reason==='verified'&&identity.tailTruncated===false){const proof=brokerWitnesses();brokerCurrent();brokerNative();const packet={version:1,sessionId:req.sessionId,incarnation:brokerDescriptor.incarnation,channel:'auto',counter:Number.MAX_SAFE_INTEGER,nonce:'ffffffff-ffff-ffff-ffff-ffffffffffff',conversationId:identity.conversationId,expectedOwners:Object.fromEntries(brokerOwners.map(k=>[k,brokerState.counters[k]])),monotonicDeadline:Number.MAX_SAFE_INTEGER,issuer:null,privateFiles:proof.files,privatePaths:proof.paths,missingPaths:[],data:'A'.repeat(4*Math.ceil(preview.maxPhaseBytes/3))};const bytes=Buffer.byteLength(JSON.stringify(packet))+(preview.issuerLeaseBytes?Buffer.byteLength(',\"issuerLease\":')+preview.issuerLeaseBytes:0);frameAdmission={...preview,fits:4*Math.ceil(bytes/3)+84<=122880};}
let action,actionAt;if(req.action){action='not-sent';const a=req.action,e=a.expected;let identityMatch=brokerVerified&&!(brokerState.closed&&brokerState.exitStatus===0&&!brokerState.exitSignal)&&identity.reason==='verified'&&identity.tailTruncated===false&&identity.conversationId===e.conversationId&&identityTailHash===e.tailHash;const paneMatch=session==='present'&&pane&&pane.paneId===e.paneId&&pane.panePid===e.panePid;if(identityMatch){try{const h=header(identityProof.p),t=read(identityProof.p,262144,true),matched=history();confirmWitness();identityMatch=!!matched&&matched.id===identityProof.id&&h.id===identityProof.id&&h.cwd===identityProof.cwd&&h.origin===identityProof.origin&&h.createdAt===identityProof.createdAt&&!h.sub&&!t.truncated&&t.text.endsWith('\n')&&crypto.createHash('sha256').update(t.text,'utf8').digest('hex')===e.tailHash}catch{identityMatch=false}}if(a.kind==='input'&&identityMatch&&paneMatch&&!pane.dead&&crypto.createHash('sha256').update(screenText,'utf8').digest('hex')===e.screenHash){let pasted=false,pastedText="",chunk="",bytes=0,phase=0;const paste=()=>{brokerCurrent();if(pasted){if(!composerSettled(pane.paneId,pastedText,nativeFields))refusal("unverified")}else{const state=composerState(pane.paneId,undefined);if(state!=="current")return false}brokerCurrent();const r=brokerSend(brokerPacket('auto',chunk,phase++));if(r==='not-sent'||r.status!=='sent'){if(pasted||r!=='not-sent'&&r.status!=='not-sent')refusal('unverified');return false}pasted=true;pastedText+=chunk;return true};let current=true;for(const point of actionPrompt){const n=Buffer.byteLength(point,"utf8");if(bytes+n>8192){if(!paste()){current=false;break}chunk="";bytes=0}chunk+=point;bytes+=n}if(current&&(chunk||!pasted))current=paste();if(current){brokerCurrent();if(!composerSettled(pane.paneId,pastedText,nativeFields))refusal("unverified");brokerCurrent();check();const r=brokerSend(brokerPacket('auto','\r',phase),true);if(r==='not-sent'||r.status!=='sent')refusal('unverified');const at=r.deliveredAt;if(!brokerExact(at,['wallBefore','wallAfter','monoBefore','monoAfter'])||!Object.values(at).every(x=>Number.isSafeInteger(x)&&x>0)||at.wallBefore<started||at.wallAfter<at.wallBefore||at.wallAfter>Date.now()||at.wallAfter-at.wallBefore>500||at.monoAfter<at.monoBefore||Math.abs(at.wallAfter-at.wallBefore-at.monoAfter+at.monoBefore)>100)refusal('unverified');actionAt=at.wallBefore;action="sent"}}else if(a.kind==='restart'&&identityMatch&&paneMatch&&pane.dead&&pane.status===e.status&&pane.signal===e.signal&&req.newInputBroker){if(brokerRelaunch(a))action='sent'}else if(a.kind==='restore'&&identityMatch&&brokerHistorical&&req.newInputBroker){if(brokerRelaunch(a))action='sent'}}
out({v:1,session,pane,identity,action,actionAt,frameAdmission,inputBroker:brokerVerified?brokerEvidence():undefined,newInputBroker:newBrokerEvidence,clock:{remoteBefore:started,remoteAfter:Date.now()}});
`;

// Encoding only the static reader avoids expanding its quotes at every nested
// shell layer, retaining the bounded 64 KiB prompt inside the 120 KiB command cap.
const REMOTE_CODEX_READER_SOURCE = `eval(require("zlib").inflateRawSync(Buffer.from(${JSON.stringify(
  deflateRawSync(Buffer.from(REMOTE_CODEX_INSPECT_SCRIPT.replace(/^\/\/[^\n]*\n/gm, ''))).toString('base64')
)},"base64")).toString("utf8"))`;

function remoteCommand(remote: SessionRemote, command: string): string {
  return [...buildSshConnectionArgs(remote), remoteSshTarget(remote), shellescape(command)].join(' ');
}

function clockedRequest<T extends { submission?: RecoverySubmission }>(
  request: T,
  clock: RemoteClockWitness
): (T & RemoteCodexEvidenceRequest) | undefined {
  const submission = remoteSubmissionWindow(request.submission, clock);
  if (!submission) return undefined;
  return {
    ...request,
    submission,
    dispatchClock: { localAt: Date.now(), ...remoteClockOffset(clock) },
  } as T & RemoteCodexEvidenceRequest;
}

function responseClock(stdout: string, localBefore: number, monotonicBefore: number): RemoteClockWitness | undefined {
  const wire = decodeWireEvidence(stdout);
  return wire?.clock
    ? clockFromBoundary(
        localBefore,
        Date.now(),
        wire.clock.remoteBefore,
        wire.clock.remoteAfter,
        performance.now() - monotonicBefore
      )
    : undefined;
}

/** A queued mutation rechecks authority only once its shared SSH slot is acquired. */
async function runRemoteCodexMutation<T extends { submission?: RecoverySubmission }>(
  remote: SessionRemote,
  request: T,
  build: (remote: SessionRemote, request: T) => string,
  isCurrent: RemoteCodexActionAuthority,
  options: RemoteCodexExecutionOptions = {}
): Promise<{ stdout: string; clock: RemoteClockWitness } | 'not-sent' | 'unknown'> {
  if (process.env.VITEST && !options.transport)
    throw new Error('Remote Codex IO requires an injected fixture under VITEST');
  const authorityCheck = typeof isCurrent === 'function' ? isCurrent : isCurrent.check;
  const owned = () => remote.owned !== false;
  const synchronouslyCurrent = (): boolean => {
    return currentRemoteAuthority(isCurrent);
  };
  return runWithRemoteSshLimit(async () => {
    let dispatched = false;
    try {
      // Bare callbacks must be synchronous. Async grants require a separate final token.
      if (
        !owned() ||
        (typeof isCurrent === 'function' && !synchronouslyCurrent()) ||
        (await authorityCheck()) !== true ||
        !synchronouslyCurrent()
      )
        return 'not-sent';
      const clock = await (options.transport?.clock(remote) ?? sampleRemoteCodexClock(remote, false));
      if (!clock) return 'not-sent';
      const normalized = clockedRequest(request, clock);
      if (!normalized || (await authorityCheck()) !== true) return 'not-sent';
      if (Date.now() < clock.localAfter || Date.now() - clock.localAfter > 2000) return 'not-sent';
      const deadline: unknown = typeof isCurrent === 'function' ? undefined : isCurrent.getActionDeadline?.();
      if (deadline instanceof Promise) void deadline.catch(() => {});
      if (
        deadline !== undefined &&
        (typeof deadline !== 'number' || !Number.isFinite(deadline) || deadline <= Date.now())
      )
        return 'not-sent';
      normalized.actionDeadline = typeof deadline === 'number' ? deadline + remoteClockOffset(clock).min : undefined;
      delete normalized.issuerLease;
      let localBefore = 0;
      let monotonicBefore = 0;
      const dispatch = async (claim?: Readonly<RemoteWorkerLeaseClaim>) => {
        normalized.dispatchClock!.localAt = Date.now();
        if (Date.now() < clock.localAfter || Date.now() - clock.localAfter > 2000) throw new Error('Expired clock');
        normalized.issuerLease = claim;
        const command = build(remote, normalized);
        localBefore = Date.now();
        monotonicBefore = performance.now();
        if (!owned() || !synchronouslyCurrent() || (typeof deadline === 'number' && deadline <= Date.now()))
          throw new Error('Expired authority');
        dispatched = true;
        return (
          options.transport?.run(command) ??
          execAsync(command, { timeout: 15_000, maxBuffer: MAX_REMOTE_CODEX_STDOUT_BYTES })
        );
      };
      let output: { stdout: string } | 'not-sent' | 'unknown';
      if (typeof isCurrent !== 'function' && isCurrent.getInputIssuer) {
        const issuer = isCurrent.getInputIssuer();
        const input = normalized as unknown as RemoteCodexInputRequest;
        const rotation = normalized.newInputBroker;
        const proof = input.expected?.inputProof;
        let binding: import('./remote-input-broker.js').RemoteWorkerLeaseBinding;
        if (rotation) {
          const restart = normalized as unknown as RemoteCodexRestartRequest;
          binding = {
            sessionId: restart.sessionId,
            incarnation: rotation.descriptor.incarnation,
            conversationId: restart.expectedIdentity.conversationId,
            action: 'expectedPane' in restart ? 'restart' : 'restore',
            fullPayloadHash: rotation.descriptor.launchDigest,
            allowedPhaseHashes: [rotation.descriptor.launchDigest],
            native: {
              kind: 'startup',
              muxSessionId: rotation.pane.sessionId,
              paneId: rotation.pane.paneId,
              panePid: rotation.pane.panePid,
              serverPid: rotation.pane.serverPid,
            },
          };
        } else {
          if (
            !input.inputBroker ||
            !proof ||
            proof.closed ||
            !proof.brokerStart ||
            !proof.childStart ||
            typeof input.prompt !== 'string'
          )
            return 'not-sent';
          binding = {
            sessionId: input.sessionId,
            incarnation: input.inputBroker.incarnation,
            conversationId: input.expected.conversationId,
            action: 'input',
            fullPayloadHash: createHash('sha256').update(input.prompt).digest('hex'),
            allowedPhaseHashes: remoteInputPhases(input.prompt).map((phase) =>
              createHash('sha256').update(phase).digest('hex')
            ),
            native: {
              kind: 'input',
              paneId: input.expected.paneId,
              brokerPid: proof.brokerPid,
              childPid: proof.childPid,
              brokerStart: proof.brokerStart,
              childStart: proof.childStart,
            },
          };
        }
        if (!issuer) return 'not-sent';
        output = await withRemoteBrokerIssuerLease(
          issuer,
          binding,
          { prepare: async () => (await authorityCheck()) === true, isCurrent: synchronouslyCurrent },
          dispatch,
          {
            helper: CODEX_INPUT_BROKER_SOURCE,
            transport: options.issuerLeaseTransport,
            durationMs: Math.min(1800, typeof deadline === 'number' ? Math.floor(deadline - Date.now()) : 1800),
          }
        );
      } else output = await dispatch();
      if (typeof output === 'string') return output;
      const { stdout } = output;
      const settled = responseClock(stdout, localBefore, monotonicBefore);
      if (
        !settled ||
        !consistentRemoteClock(clock, settled) ||
        !request.submission?.clock ||
        !consistentRemoteClock(request.submission.clock, settled)
      )
        return 'unknown';
      return { stdout, clock: settled };
    } catch {
      // Clock/grant/build refusal before the mutation child starts certifies no delivery.
      // A started child can already have typed, restarted or created the exact worker.
      return dispatched ? 'unknown' : 'not-sent';
    }
  });
}

export function buildRemoteCodexEvidenceCommand(remote: SessionRemote, request: RemoteCodexEvidenceRequest): string {
  const payload = Buffer.from(
    JSON.stringify({ ...request, remoteSessionName: remoteTmuxSessionName(request.sessionId) })
  ).toString('base64');
  return remoteCommand(
    remote,
    remoteLoginShellCommand(`node -e ${shellescape(REMOTE_CODEX_READER_SOURCE)} ${payload}`)
  );
}

function decodeBoundedBase64(value: unknown, maxBytes: number): Buffer | undefined {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4 + 4) return undefined;
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    return undefined;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length <= maxBytes && decoded.toString('base64') === value ? decoded : undefined;
}

function decodeWireEvidence(stdout: string): WireEvidence | undefined {
  if (Buffer.byteLength(stdout, 'utf8') > MAX_REMOTE_CODEX_STDOUT_BYTES) return undefined;
  const lines = stdout.split('\n').filter((line) => line.startsWith(MARKER));
  if (lines.length !== 1) return undefined;
  try {
    const encoded = lines[0].slice(MARKER.length);
    const record = decodeBoundedBase64(encoded, MAX_REMOTE_CODEX_RECORD_BYTES);
    if (!record) return undefined;
    return JSON.parse(record.toString('utf8')) as WireEvidence;
  } catch {
    return undefined;
  }
}

export function parseRemoteCodexEvidence(stdout: string): RemoteCodexEvidence | undefined {
  try {
    const wire = decodeWireEvidence(stdout);
    if (!wire) return undefined;
    if (wire.v !== 1 || !['missing', 'present'].includes(wire.session)) return undefined;
    const identity = { ...wire.identity };
    if (!['verified', 'ambiguous', 'unverified', 'unreadable'].includes(identity.reason)) return undefined;
    if (identity.reason === 'verified') {
      if (
        !identity.conversationId ||
        !UUID.test(identity.conversationId) ||
        typeof identity.tailTruncated !== 'boolean' ||
        !Number.isFinite(identity.changedAt) ||
        (identity.changedAt ?? 0) <= 0
      )
        return undefined;
      const tail = decodeBoundedBase64(identity.tail, 256 * 1024);
      if (!tail) return undefined;
      identity.tail = tail.toString('utf8');
      if (!identity.tail.endsWith('\n')) return undefined;
    } else {
      if (
        identity.changedAt !== undefined ||
        identity.conversationId !== undefined ||
        identity.tail !== undefined ||
        identity.tailTruncated !== undefined
      )
        return undefined;
    }
    let pane: RemoteCodexPaneEvidence | undefined;
    if (wire.session === 'present') {
      const p = wire.pane;
      if (
        !p ||
        typeof p.dead !== 'boolean' ||
        !/^%\d+$/.test(p.paneId) ||
        !Number.isSafeInteger(p.panePid) ||
        p.panePid <= 0 ||
        (p.status !== undefined && (!Number.isInteger(p.status) || p.status < 0 || p.status > 65_535)) ||
        (p.signal !== undefined && (!Number.isInteger(p.signal) || p.signal < 0 || p.signal > 65_535))
      )
        return undefined;
      if (p.dead && p.screen !== undefined) return undefined;
      const screen = p.dead ? undefined : decodeBoundedBase64(p.screen, 64 * 1024);
      if (!p.dead && !screen) return undefined;
      pane = { ...p, screen: p.dead ? null : screen!.toString('utf8') };
    } else if (wire.pane !== undefined) {
      return undefined;
    }
    if (wire.inputBroker !== undefined) {
      const b = wire.inputBroker;
      if (
        !b ||
        !['serialized,witness', 'historical,serialized,witness'].includes(Object.keys(b).sort().join(',')) ||
        (b.historical !== undefined && b.historical !== true) ||
        typeof b.serialized !== 'string' ||
        Buffer.byteLength(b.serialized) > 98304 ||
        !b.witness ||
        Object.keys(b.witness).sort().join(',') !== 'ctimeMs,dev,hash,ino,maxBytes,mtimeMs,path,size' ||
        typeof b.witness.path !== 'string' ||
        !isAbsolute(b.witness.path) ||
        b.witness.maxBytes !== 98304 ||
        b.witness.size !== Buffer.byteLength(b.serialized) ||
        b.witness.hash !== createHash('sha256').update(b.serialized).digest('hex') ||
        ![b.witness.dev, b.witness.ino, b.witness.size, b.witness.mtimeMs, b.witness.ctimeMs].every(
          (x) => Number.isFinite(x) && x >= 0
        )
      )
        return undefined;
    }
    const admission = wire.frameAdmission;
    if (
      admission !== undefined &&
      (!admission ||
        Object.keys(admission).sort().join(',') !== 'fits,issuerLeaseBytes,maxPhaseBytes,promptHash' ||
        typeof admission.fits !== 'boolean' ||
        !/^[a-f0-9]{64}$/.test(admission.promptHash) ||
        !Number.isSafeInteger(admission.maxPhaseBytes) ||
        admission.maxPhaseBytes < 1 ||
        admission.maxPhaseBytes > 8192 ||
        !Number.isSafeInteger(admission.issuerLeaseBytes) ||
        admission.issuerLeaseBytes < 0 ||
        admission.issuerLeaseBytes > 16384)
    )
      return undefined;
    return {
      transport: 'reachable',
      session: wire.session,
      pane,
      identity,
      inputBroker: wire.inputBroker,
      frameAdmission: admission,
    };
  } catch {
    return undefined;
  }
}

export function classifyRemoteCodexExecFailure(failure: {
  code?: unknown;
  killed?: boolean;
  stderr?: unknown;
}): RemoteCodexEvidence {
  const stderr = typeof failure.stderr === 'string' ? failure.stderr : '';
  if (
    failure.killed ||
    failure.code === 'ETIMEDOUT' ||
    /(?:connection timed out|no route to host|could not resolve hostname|connection refused|network is unreachable)/i.test(
      stderr
    )
  ) {
    return { transport: 'unreachable', session: 'unknown', identity: { reason: 'unreadable' } };
  }
  if (failure.code === 255) {
    return { transport: 'unavailable', session: 'unknown', identity: { reason: 'unreadable' } };
  }
  if (
    (failure.code === 127 &&
      /(?:node:\s*(?:command )?not found|command not found:\s*node|node:\s*not found)/i.test(stderr)) ||
    /(?:spawnSync tmux ENOENT|tmux:\s*(?:command )?not found|command not found:\s*tmux)/i.test(stderr)
  ) {
    return { transport: 'reachable', session: 'unknown', identity: { reason: 'unsupported' } };
  }
  return { transport: 'reachable', session: 'unknown', identity: { reason: 'unreadable' } };
}

export async function inspectRemoteCodex(
  remote: SessionRemote,
  request: RemoteCodexEvidenceRequest
): Promise<RemoteCodexEvidence> {
  if (process.env.VITEST) throw new Error('Remote Codex IO requires an injected fixture under VITEST');
  try {
    return await runWithRemoteSshLimit(async () => {
      const clock = await sampleRemoteCodexClock(remote, false);
      const normalized = clock && clockedRequest(request, clock);
      if (!normalized) return { transport: 'reachable', session: 'unknown', identity: { reason: 'unreadable' } };
      const localBefore = Date.now();
      const monotonicBefore = performance.now();
      const { stdout } = await execAsync(buildRemoteCodexEvidenceCommand(remote, normalized), {
        timeout: 15_000,
        maxBuffer: MAX_REMOTE_CODEX_STDOUT_BYTES,
      });
      const settled = responseClock(stdout, localBefore, monotonicBefore);
      const evidence = parseRemoteCodexEvidence(stdout);
      if (
        !settled ||
        !consistentRemoteClock(clock!, settled) ||
        !request.submission?.clock ||
        !consistentRemoteClock(request.submission.clock, settled) ||
        !evidence
      )
        return { transport: 'reachable', session: 'unknown', identity: { reason: 'unreadable' } };
      if (evidence.transport === 'reachable' && ['missing', 'present'].includes(evidence.session)) {
        const result = evidence as Extract<RemoteCodexEvidence, { session: 'missing' | 'present' }>;
        result.clock = settled;
        if (result.identity.changedAt !== undefined)
          result.identity.changedAt = remoteToLocal(result.identity.changedAt, settled);
      }
      return evidence;
    });
  } catch (error) {
    return classifyRemoteCodexExecFailure(error as { code?: unknown; killed?: boolean; stderr?: unknown });
  }
}

export function parseRemoteCodexAction(stdout: string): 'sent' | 'not-sent' | undefined {
  const wire = decodeWireEvidence(stdout);
  if (
    !wire ||
    !parseRemoteCodexEvidence(stdout) ||
    !['sent', 'not-sent'].includes(wire.action ?? '') ||
    (wire.actionAt !== undefined && (!Number.isSafeInteger(wire.actionAt) || wire.actionAt <= 0))
  )
    return undefined;
  return wire.action;
}

export function parseRemoteCodexInputResult(stdout: string): RemoteCodexInputResult | undefined {
  const wire = decodeWireEvidence(stdout);
  const action = parseRemoteCodexAction(stdout);
  if (!wire || !action) return undefined;
  if (action === 'not-sent') return wire.actionAt === undefined ? { status: action } : undefined;
  return Number.isSafeInteger(wire.actionAt) && (wire.actionAt ?? 0) > 0
    ? { status: action, submittedAt: wire.actionAt! }
    : undefined;
}

function buildRemoteCodexActionCommand(
  remote: SessionRemote,
  request: RemoteCodexEvidenceRequest,
  action: Record<string, unknown>
): string {
  const payload = Buffer.from(
    JSON.stringify({ ...request, remoteSessionName: remoteTmuxSessionName(request.sessionId), action })
  ).toString('base64');
  return remoteCommand(
    remote,
    remoteLoginShellCommand(`node -e ${shellescape(REMOTE_CODEX_READER_SOURCE)} ${payload}`)
  );
}

export function buildRemoteCodexInputCommand(remote: SessionRemote, request: RemoteCodexInputRequest): string {
  const { expected, prompt, ...evidence } = request;
  const bytes = Buffer.from(prompt, 'utf8');
  if (bytes.length > MAX_REMOTE_CODEX_PROMPT_BYTES || bytes.includes(0) || bytes.toString('utf8') !== prompt) {
    throw new RangeError('Remote Codex prompt is not safely representable');
  }
  const command = buildRemoteCodexActionCommand(remote, evidence, {
    kind: 'input',
    expected,
    prompt,
  });
  if (Buffer.byteLength(command, 'utf8') > MAX_REMOTE_CODEX_COMMAND_BYTES) {
    throw new RangeError('Remote Codex command exceeds the safe shell argument bound');
  }
  return command;
}

/** Preview both actual SSH command forms without allocating a frame, nonce or lease. */
export function remotePromptCommandFits(
  remote: SessionRemote,
  request: RemoteCodexEvidenceRequest,
  prompt: string,
  evidence: Extract<RemoteCodexEvidence, { session: 'present' | 'missing' }>,
  issuer?: RemoteBrokerIssuer
): boolean {
  try {
    const state = JSON.parse(evidence.inputBroker?.serialized ?? 'null');
    if (
      !state ||
      !request.inputBroker ||
      !evidence.inputBroker ||
      !evidence.pane ||
      !evidence.identity.conversationId ||
      !evidence.identity.tail ||
      state.sessionId !== request.sessionId ||
      state.incarnation !== request.inputBroker.incarnation ||
      state.pid !== evidence.pane.panePid ||
      state.closed !== false ||
      !state.counters
    )
      return false;
    const { frameAdmission: _preview, ...base } = request;
    // Linux stat values are finite positive JSON numbers. 17 significant digits
    // plus the longest non-exponential leading-zero prefix occupy at most 24 bytes.
    const widestStat = 0.0000012345678901234567;
    const proof: CodexBrokerProof = {
      incarnation: state.incarnation,
      brokerPid: state.pid,
      childPid: state.childPid,
      brokerStart: state.brokerStart,
      childStart: state.childStart,
      closed: state.closed,
      rawGeneration: state.rawGeneration,
      launchDigest: state.launchDigest,
      homeDigest: state.homeDigest,
      ownerCounters: Object.fromEntries(
        ['owner-pty', 'owner-key', 'owner-mux'].map((key) => [key, state.counters[key]])
      ) as CodexBrokerProof['ownerCounters'],
      fileWitness: {
        ...evidence.inputBroker.witness,
        dev: widestStat,
        ino: widestStat,
        size: 98304,
        mtimeMs: widestStat,
        ctimeMs: widestStat,
      },
    };
    const expected = {
      conversationId: evidence.identity.conversationId,
      tailHash: createHash('sha256').update(evidence.identity.tail).digest('hex'),
      paneId: evidence.pane.paneId,
      panePid: evidence.pane.panePid,
      screenHash: createHash('sha256')
        .update(evidence.pane.screen ?? '')
        .digest('hex'),
      inputProof: proof,
    };
    // Delivery first builds the original request, then the normalized clock/lease request.
    buildRemoteCodexInputCommand(remote, { ...base, expected, prompt });
    const max = Number.MAX_SAFE_INTEGER;
    buildRemoteCodexInputCommand(remote, {
      ...base,
      submission: { at: max / 2, hash: request.submission!.hash, uncertaintyMs: 499.5 },
      dispatchClock: { localAt: max, min: -max, max: -max },
      actionDeadline: 2 * max,
      ...(issuer ? { issuerLease: remoteInputLeaseBound(prompt, issuer).claim } : {}),
      expected,
      prompt,
    });
    return true;
  } catch {
    return false;
  }
}

export async function deliverRemoteCodexInput(
  remote: SessionRemote,
  request: RemoteCodexInputRequest,
  isCurrent: RemoteCodexActionAuthority = () => true,
  options: RemoteCodexExecutionOptions = {}
): Promise<RemoteCodexInputResult> {
  try {
    buildRemoteCodexInputCommand(remote, request);
  } catch {
    return { status: 'not-sent' }; // No mutation child was constructed or started.
  }
  const result = await runRemoteCodexMutation(remote, request, buildRemoteCodexInputCommand, isCurrent, options);
  if (typeof result === 'string') return { status: result };
  const receipt = parseRemoteCodexInputResult(result.stdout);
  if (receipt?.status !== 'sent') return receipt ?? { status: 'unknown' };
  if (receipt.submittedAt < result.clock.remoteBefore || receipt.submittedAt > result.clock.remoteAfter)
    return { status: 'unknown' };
  return { ...receipt, clock: result.clock };
}

export interface RemoteCodexRestartRequest {
  sessionId: string;
  resumeId?: string;
  submission?: RecoverySubmission & { uncertaintyMs?: number };
  dispatchClock?: RemoteCodexEvidenceRequest['dispatchClock'];
  expectedIdentity: RemoteCodexIdentityGuard;
  expectedPane: Pick<RemoteCodexPaneEvidence, 'paneId' | 'panePid' | 'status' | 'signal'>;
  codexConfig: CodexConfig;
  codexHome?: string;
  inputBroker?: OwnedRemoteBrokerDescriptor;
  expectedInputProof?: CodexBrokerProof;
  owner?: string;
  newInputBroker?: RemoteCodexEvidenceRequest['newInputBroker'];
  issuerLease?: Readonly<RemoteWorkerLeaseClaim>;
  actionDeadline?: number;
}

export type RemoteCodexRestoreRequest = Omit<RemoteCodexRestartRequest, 'expectedPane'>;

async function rotateRemoteCodexBroker(
  remote: SessionRemote,
  request: RemoteCodexRestartRequest | RemoteCodexRestoreRequest,
  authority: RemoteCodexActionAuthority,
  kind: 'restart' | 'restore',
  options: RemoteCodexExecutionOptions = {}
): Promise<'sent' | 'not-sent' | 'unknown'> {
  if (
    typeof authority === 'function' ||
    !authority.reserveInputBroker ||
    !authority.commitInputBroker ||
    !request.inputBroker ||
    !request.expectedInputProof ||
    request.expectedInputProof.incarnation !== request.inputBroker.incarnation ||
    (request.expectedInputProof.closed &&
      request.expectedInputProof.exitStatus === 0 &&
      !request.expectedInputProof.exitSignal)
  )
    return 'not-sent';
  const sourceScope = {
    sessionId: request.sessionId,
    remote,
    workingDir: remote.remotePath,
    codexHome: request.codexHome!,
    owner: request.owner,
  };
  const oldInc = request.inputBroker.incarnation;
  const cache = options.cache ?? ownedRemoteBrokerCache;
  let reservationAttempted = false;
  try {
    assertExactRemoteResume(request);
    if ((await authority.check()) !== true || !currentRemoteAuthority(authority)) return 'not-sent';
    const command = buildRemoteCodexPaneCommand({
      remotePath: remote.remotePath,
      sessionId: request.sessionId,
      codexConfig: request.codexConfig,
      codexHome: request.codexHome,
    });
    const retained = cache.get(sourceScope, oldInc);
    if (
      !retained ||
      Object.keys(retained).length !== Object.keys(request.inputBroker).length ||
      Object.keys(retained).some(
        (key) =>
          retained[key as keyof OwnedRemoteBrokerDescriptor] !==
          request.inputBroker![key as keyof OwnedRemoteBrokerDescriptor]
      )
    )
      return 'not-sent';
    const material = CodexInputBroker.provisioningMaterial(request.sessionId, command, request.codexHome);
    // The retained old incarnation pins the exact remote private session root.
    // A cache failure or cancellation must occur before creating an inert pane.
    const directory = posix.join(posix.dirname(retained.directory), material.config.incarnation);
    const descriptor = await cache.prepare(sourceScope, material, directory);
    if (!descriptor || !currentRemoteAuthority(authority)) return 'not-sent';
    reservationAttempted = true;
    if (!(await authority.reserveInputBroker(oldInc, descriptor.incarnation)) || !currentRemoteAuthority(authority))
      return 'unknown';
    const prepared = await provisionRemoteInputBroker(
      remote,
      {
        sessionId: request.sessionId,
        incarnation: material.config.incarnation,
        source: material.helper,
        configJson: JSON.stringify(material.config),
      },
      { prepare: async () => (await authority.check()) === true, isCurrent: () => currentRemoteAuthority(authority) },
      {
        root: posix.dirname(posix.dirname(directory)),
        expectedPane: kind === 'restart' ? (request as RemoteCodexRestartRequest).expectedPane : undefined,
        transport: options.provisionTransport,
      }
    );
    if (prepared.status !== 'provisioned') return prepared.status === 'unknown' ? 'unknown' : 'not-sent';
    if (
      prepared.directory !== descriptor.directory ||
      prepared.incarnation !== descriptor.incarnation ||
      !currentRemoteAuthority(authority)
    )
      return 'unknown';
    const finalRequest = { ...request, newInputBroker: { descriptor, pane: prepared.pane } };
    const build = kind === 'restart' ? buildRemoteCodexRestartCommand : buildRemoteCodexRestoreCommand;
    const result = await runRemoteCodexMutation(
      remote,
      finalRequest,
      (host, q) => build(host, q as RemoteCodexRestartRequest),
      authority,
      options
    );
    // A pending incarnation survives every unknown/refusal until explicit inspection.
    if (typeof result === 'string') return result === 'unknown' ? 'unknown' : 'not-sent';
    const status = parseRemoteCodexAction(result.stdout);
    if (status !== 'sent') return status ?? 'unknown';
    const wire = decodeWireEvidence(result.stdout),
      fresh = wire?.newInputBroker;
    if (!fresh || !currentRemoteAuthority(authority)) return 'unknown';
    const proof = cache.observe(sourceScope, descriptor.incarnation, fresh.serialized, fresh.witness, fresh.panePid);
    if (
      !proof ||
      proof.closed ||
      proof.incarnation !== descriptor.incarnation ||
      !currentRemoteAuthority(authority) ||
      (await authority.commitInputBroker(oldInc, descriptor.incarnation)) !== true
    )
      return 'unknown';
    return 'sent';
  } catch {
    return reservationAttempted ? 'unknown' : 'not-sent';
  }
}

function assertExactRemoteResume(request: RemoteCodexRestoreRequest): void {
  if (
    !request.resumeId ||
    !UUID.test(request.resumeId) ||
    request.expectedIdentity.conversationId !== request.resumeId ||
    request.codexConfig.resumeSessionId !== request.resumeId ||
    request.codexConfig.noDaemon !== true ||
    !request.codexHome ||
    !isAbsolute(request.codexHome) ||
    request.codexHome.includes('\0') ||
    Buffer.byteLength(request.codexHome) > 4096
  )
    throw new RangeError('Remote recovery requires an exact isolated conversation and pinned home');
}

/** Recreate only the verified missing owned worker, never attach to a concurrent session. */
export function buildRemoteCodexRestoreCommand(remote: SessionRemote, request: RemoteCodexRestoreRequest): string {
  assertExactRemoteResume(request);
  const command = buildRemoteCodexPaneCommand({
    remotePath: remote.remotePath,
    sessionId: request.sessionId,
    codexConfig: request.codexConfig,
    codexHome: request.codexHome,
  });
  return buildRemoteCodexActionCommand(
    remote,
    {
      sessionId: request.sessionId,
      workingDir: remote.remotePath,
      codexHome: request.codexHome,
      resumeId: request.resumeId,
      submission: request.submission,
      dispatchClock: request.dispatchClock,
      inputBroker: request.inputBroker,
      newInputBroker: request.newInputBroker,
      issuerLease: request.issuerLease,
      actionDeadline: request.actionDeadline,
    },
    { kind: 'restore', expected: { ...request.expectedIdentity, inputProof: request.expectedInputProof }, command }
  );
}

export async function restoreRemoteCodexWorker(
  remote: SessionRemote,
  request: RemoteCodexRestoreRequest,
  isCurrent: RemoteCodexActionAuthority = () => true,
  options: RemoteCodexExecutionOptions = {}
): Promise<'sent' | 'not-sent' | 'unknown'> {
  return rotateRemoteCodexBroker(remote, request, isCurrent, 'restore', options);
}

export function buildRemoteCodexRestartCommand(remote: SessionRemote, request: RemoteCodexRestartRequest): string {
  assertExactRemoteResume(request);
  const paneCommand = buildRemoteCodexPaneCommand({
    remotePath: remote.remotePath,
    sessionId: request.sessionId,
    codexConfig: request.codexConfig,
    codexHome: request.codexHome,
  });
  return buildRemoteCodexActionCommand(
    remote,
    {
      sessionId: request.sessionId,
      workingDir: remote.remotePath,
      codexHome: request.codexHome,
      resumeId: request.resumeId,
      submission: request.submission,
      dispatchClock: request.dispatchClock,
      inputBroker: request.inputBroker,
      newInputBroker: request.newInputBroker,
      issuerLease: request.issuerLease,
      actionDeadline: request.actionDeadline,
    },
    {
      kind: 'restart',
      expected: { ...request.expectedIdentity, ...request.expectedPane, inputProof: request.expectedInputProof },
      command: paneCommand,
    }
  );
}

export async function restartRemoteCodexPane(
  remote: SessionRemote,
  request: RemoteCodexRestartRequest,
  isCurrent: RemoteCodexActionAuthority = () => true,
  options: RemoteCodexExecutionOptions = {}
): Promise<'sent' | 'not-sent' | 'unknown'> {
  return rotateRemoteCodexBroker(remote, request, isCurrent, 'restart', options);
}
