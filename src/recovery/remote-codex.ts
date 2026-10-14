/** @fileoverview Bounded, fail-closed Codex evidence and mutation over the configured SSH transport. */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { CodexConfig, SessionRemote } from '../types.js';
import { buildSshConnectionArgs, remoteLoginShellCommand, remoteSshTarget, shellescape } from '../remote-hosts.js';
import { runWithRemoteSshLimit } from '../remote-ssh-limiter.js';
import { buildRemoteCodexPaneCommand, remoteTmuxSessionName } from '../tmux-manager.js';

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
      identity: {
        reason: 'verified' | 'ambiguous' | 'unverified' | 'unreadable';
        conversationId?: string;
        tail?: string;
        tailTruncated?: boolean;
        changedAt?: number;
      };
    };

export interface RemoteCodexEvidenceRequest {
  sessionId: string;
  workingDir: string;
  codexHome?: string;
  resumeId?: string;
  submission?: { at: number; hash: string };
}

interface WireEvidence {
  v: 1;
  session: 'missing' | 'present';
  action?: 'sent' | 'not-sent';
  actionAt?: number;
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
  expected: RemoteCodexIdentityGuard & Pick<RemoteCodexPaneEvidence, 'paneId' | 'panePid'> & { screenHash: string };
  prompt: string;
}

export type RemoteCodexInputResult = { status: 'sent'; submittedAt: number } | { status: 'not-sent' | 'unknown' };

export const MAX_REMOTE_CODEX_PROMPT_BYTES = 64 * 1024;
const MAX_REMOTE_CODEX_COMMAND_BYTES = 120 * 1024;

/**
 * Runs wholly on the remote host. It emits one marked JSON record and no private
 * text outside base64 fields, caps traversal/read sizes, and refuses symlinks.
 * The source is passed as one shell token; no request value is interpolated into it.
 */
const REMOTE_CODEX_INSPECT_SCRIPT = String.raw`
const fs=require('fs'),path=require('path'),cp=require('child_process'),crypto=require('crypto');
const out=x=>process.stdout.write('${MARKER}'+Buffer.from(JSON.stringify(x)).toString('base64')+'\n');
const req=JSON.parse(Buffer.from(process.argv[1]||'','base64').toString('utf8'));
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const refusal=r=>{throw Object.assign(new Error(r),{reason:r})};
const started=Date.now(),check=()=>{if(Date.now()-started>1800)refusal('unreadable')};
const read=(p,n,tail=false)=>{check();const a=fs.lstatSync(p);if(!a.isFile()||a.isSymbolicLink())refusal('unverified');const f=fs.openSync(p,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));try{const s=fs.fstatSync(f);if(s.ino!==a.ino||s.dev!==a.dev)refusal('unverified');const l=Math.min(n,s.size),b=Buffer.alloc(l),o=tail?Math.max(0,s.size-l):0;if(fs.readSync(f,b,0,l,o)!==l)refusal('unverified');let t=b.toString('utf8'),truncated=s.size>n;if(tail&&truncated){const i=t.indexOf('\n');if(i<0)refusal('unverified');t=t.slice(i+1)}return {text:t,mtime:s.mtimeMs,truncated}}finally{fs.closeSync(f)}};
const validHome=x=>typeof x==='string'&&x.length>0&&Buffer.byteLength(x,'utf8')<=4096&&!x.includes('\0')&&path.isAbsolute(x);
if(!req||typeof req.sessionId!=='string'||!uuid.test(req.sessionId)||typeof req.remoteSessionName!=='string'||!/^codeman-ssh-[a-f0-9]{8}$/i.test(req.remoteSessionName)||typeof req.workingDir!=='string'||!path.isAbsolute(req.workingDir)||(req.codexHome!==undefined&&!validHome(req.codexHome))||(req.resumeId!==undefined&&(typeof req.resumeId!=='string'||!uuid.test(req.resumeId)))||(!req.submission||!Number.isFinite(req.submission.at)||req.submission.at<=0||typeof req.submission.hash!=='string'||!/^[a-f0-9]{64}$/.test(req.submission.hash)))refusal('unverified');
let actionPrompt;if(req.action!==undefined){const a=req.action,e=a&&a.expected;if(!a||!e||!['input','restart'].includes(a.kind)||typeof e.conversationId!=='string'||!uuid.test(e.conversationId)||typeof e.tailHash!=='string'||!/^[a-f0-9]{64}$/.test(e.tailHash)||typeof e.paneId!=='string'||!/^%\d+$/.test(e.paneId)||!Number.isSafeInteger(e.panePid)||e.panePid<=0)refusal('unverified');if(a.kind==='input'){if(typeof e.screenHash!=='string'||!/^[a-f0-9]{64}$/.test(e.screenHash)||typeof a.prompt!=='string')refusal('unverified');const b=Buffer.from(a.prompt,'utf8');if(b.length>65536||b.includes(0)||b.toString('utf8')!==a.prompt)refusal('unverified');actionPrompt=a.prompt}else if(typeof a.command!=='string'||!a.command||Buffer.byteLength(a.command)>32768||a.command.includes('\0')||(e.status!==undefined&&(!Number.isInteger(e.status)||e.status<0||e.status>65535))||(e.signal!==undefined&&(!Number.isInteger(e.signal)||e.signal<0||e.signal>65535)))refusal('unverified')}
const ambientHome=req.codexHome===undefined?process.env.CODEX_HOME:undefined;if(ambientHome!==undefined&&ambientHome!==''&&!validHome(ambientHome))refusal('unreadable');
const home=path.resolve(req.codexHome!==undefined?req.codexHome:(ambientHome||path.join(require('os').homedir(),'.codex')));
const root=path.parse(home).root,components=home.slice(root.length).split(path.sep).filter(Boolean);if(components.length>32)refusal('unverified');let cur=root;for(const c of components){cur=path.join(cur,c);const s=fs.lstatSync(cur);if(!s.isDirectory()||s.isSymbolicLink())refusal('unverified')}
let dirs=0,entries=0,files=0,found=[];
const header=p=>{const h=read(p,131072).text,n=h.indexOf('\n');if(n<0)refusal('unverified');let j;try{j=JSON.parse(h.slice(0,n))}catch{refusal('unverified')}const q=j&&j.type==='session_meta'&&j.payload,m=/^rollout-[A-Za-z0-9T:._+-]+-([a-f0-9-]{36})\.jsonl$/i.exec(path.basename(p)),at=Date.parse(q&&(q.timestamp||j.timestamp));if(!q||!m||!uuid.test(m[1])||(q.id||q.session_id)!==m[1]||(q.session_id!==undefined&&q.session_id!==m[1])||typeof q.cwd!=='string'||!path.isAbsolute(q.cwd)||!Number.isFinite(at)||(q.originator!==undefined&&typeof q.originator!=='string'))refusal('unverified');let sub=false;for(const s of [q.thread_source,q.source]){if(s===undefined)continue;if(typeof s==='string')sub||=s.toLowerCase().includes('subagent');else if(s&&typeof s==='object'&&Object.prototype.hasOwnProperty.call(s,'subagent'))sub=true;else refusal('unverified')}return{id:m[1],cwd:path.resolve(q.cwd),origin:q.originator,createdAt:at,sub,p}};
const visit=(d,depth)=>{check();if(depth>5||++dirs>256)refusal('unverified');const ds=fs.lstatSync(d);if(!ds.isDirectory()||ds.isSymbolicLink())refusal('unverified');const dh=fs.opendirSync(d,{bufferSize:32});try{for(let e;(e=dh.readSync());){check();if(++entries>8192)refusal('unverified');const p=path.join(d,e.name);if(e.isSymbolicLink())refusal('unverified');if(e.isDirectory())visit(p,depth+1);else{if(++files>1024)refusal('unverified');if(e.name.startsWith('rollout-')&&e.name.endsWith('.jsonl'))found.push(header(p))}}}finally{dh.closeSync()}};
const history=()=>{if(!req.submission)return;const w=read(path.join(home,'history.jsonl'),262144,true);if(w.text&&!w.text.endsWith('\n'))refusal('unverified');let all=[];for(const line of w.text.split('\n')){if(!line)continue;let x;try{x=JSON.parse(line)}catch{refusal('unverified')}if(!x||typeof x.session_id!=='string'||!uuid.test(x.session_id)||!Number.isFinite(x.ts)||typeof x.text!=='string')refusal('unverified');all.push({id:x.session_id,at:x.ts*1000,hash:crypto.createHash('sha256').update(x.text,'utf8').digest('hex')})}if(all.some((x,i)=>i&&x.at<all[i-1].at))refusal('unverified');const lower=req.submission.at-2000;if(w.truncated&&(!all.length||all[0].at>=lower))refusal('unverified');const matches=all.filter(x=>x.hash===req.submission.hash&&Math.abs(x.at-req.submission.at)<=2000);if(matches.length!==1)refusal(matches.length?'ambiguous':'unverified');return matches[0]};
let identity={reason:'unverified'},identityTailHash;try{visit(path.join(home,'sessions'),0);const ids=new Set;for(const x of found){if(ids.has(x.id))refusal('ambiguous');ids.add(x.id)}const candidates=found.filter(x=>x.cwd===path.resolve(req.workingDir)&&!x.sub),fresh=candidates.filter(x=>x.origin==='codeman_'+req.sessionId).sort((a,b)=>b.createdAt-a.createdAt);if(fresh.length>1&&fresh[0].createdAt===fresh[1].createdAt)refusal('ambiguous');const newest=fresh[0],matched=history();if(!matched)refusal('unverified');const selected=candidates.find(x=>x.id===matched.id);if(newest&&newest.id!==matched.id&&newest.createdAt>req.submission.at)refusal('ambiguous');if(!selected)refusal('unverified');const again=header(selected.p);if(again.id!==selected.id||again.cwd!==selected.cwd||again.origin!==selected.origin||again.createdAt!==selected.createdAt||again.sub)refusal('unverified');const t=read(selected.p,262144,true);if(!t.text.endsWith('\n'))refusal('unverified');identityTailHash=crypto.createHash('sha256').update(t.text,'utf8').digest('hex');identity={reason:'verified',conversationId:selected.id,tail:Buffer.from(t.text).toString('base64'),tailTruncated:t.truncated,changedAt:t.mtime}}catch(e){identity={reason:e&&e.reason||'unreadable'}}
const name=req.remoteSessionName;let session='present',pane,screenText;try{cp.execFileSync('tmux',['-L','codeman-remote','has-session','-t',name],{stdio:'ignore',timeout:1500})}catch(e){if(e&&e.status===1)session='missing';else refusal('unreadable')}
if(session==='present'){const row=cp.execFileSync('tmux',['-L','codeman-remote','list-panes','-t',name,'-F','#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}|#{pane_id}|#{pane_pid}'],{encoding:'utf8',timeout:1500,maxBuffer:16384}).trim().split('\n');if(row.length!==1)refusal('unverified');const f=row[0].split('|');if(!/^[01]$/.test(f[0])||!/^%\d+$/.test(f[3])||!/^\d+$/.test(f[4]))refusal('unverified');pane={dead:f[0]==='1',status:/^\d{1,5}$/.test(f[1])?+f[1]:undefined,signal:/^\d{1,5}$/.test(f[2])?+f[2]:undefined,paneId:f[3],panePid:+f[4]};if(!pane.dead){screenText=cp.execFileSync('tmux',['-L','codeman-remote','capture-pane','-p','-t',pane.paneId],{encoding:'utf8',timeout:1500,maxBuffer:65536});pane.screen=Buffer.from(screenText).toString('base64')}}
let action,actionAt;if(req.action){action='not-sent';const a=req.action,e=a.expected,identityMatch=identity.reason==='verified'&&identity.tailTruncated===false&&identity.conversationId===e.conversationId&&identityTailHash===e.tailHash,paneMatch=session==='present'&&pane&&pane.paneId===e.paneId&&pane.panePid===e.panePid;if(a.kind==='input'&&identityMatch&&paneMatch&&!pane.dead&&crypto.createHash('sha256').update(screenText,'utf8').digest('hex')===e.screenHash){cp.execFileSync('tmux',['-L','codeman-remote','send-keys','-l','-t',pane.paneId,actionPrompt],{stdio:'ignore',timeout:1500});actionAt=Date.now();cp.execFileSync('tmux',['-L','codeman-remote','send-keys','-t',pane.paneId,'Enter'],{stdio:'ignore',timeout:1500});action='sent'}else if(a.kind==='restart'&&identityMatch&&paneMatch&&pane.dead&&pane.status===e.status&&pane.signal===e.signal){cp.execFileSync('tmux',['-L','codeman-remote','respawn-pane','-c',req.workingDir,'-t',pane.paneId,a.command],{stdio:'ignore',timeout:1500});action='sent'}}
out({v:1,session,pane,identity,action,actionAt});
`;

function remoteCommand(remote: SessionRemote, command: string): string {
  return [...buildSshConnectionArgs(remote), remoteSshTarget(remote), shellescape(command)].join(' ');
}

export function buildRemoteCodexEvidenceCommand(remote: SessionRemote, request: RemoteCodexEvidenceRequest): string {
  const payload = Buffer.from(
    JSON.stringify({ ...request, remoteSessionName: remoteTmuxSessionName(request.sessionId) })
  ).toString('base64');
  return remoteCommand(
    remote,
    remoteLoginShellCommand(`node -e ${shellescape(REMOTE_CODEX_INSPECT_SCRIPT)} ${payload}`)
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
    return { transport: 'reachable', session: wire.session, pane, identity };
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
    const { stdout } = await runWithRemoteSshLimit(() =>
      execAsync(buildRemoteCodexEvidenceCommand(remote, request), {
        timeout: 15_000,
        maxBuffer: MAX_REMOTE_CODEX_STDOUT_BYTES,
      })
    );
    return (
      parseRemoteCodexEvidence(stdout) ?? {
        transport: 'reachable',
        session: 'present',
        identity: { reason: 'unreadable' },
      }
    );
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
    remoteLoginShellCommand(`node -e ${shellescape(REMOTE_CODEX_INSPECT_SCRIPT)} ${payload}`)
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

export async function deliverRemoteCodexInput(
  remote: SessionRemote,
  request: RemoteCodexInputRequest
): Promise<RemoteCodexInputResult> {
  let command: string;
  try {
    command = buildRemoteCodexInputCommand(remote, request);
  } catch (error) {
    if (error instanceof RangeError) return { status: 'not-sent' };
    return { status: 'unknown' };
  }
  if (process.env.VITEST) throw new Error('Remote Codex IO requires an injected fixture under VITEST');
  try {
    const { stdout } = await execAsync(command, {
      timeout: 15_000,
      maxBuffer: MAX_REMOTE_CODEX_STDOUT_BYTES,
    });
    return parseRemoteCodexInputResult(stdout) ?? { status: 'unknown' };
  } catch {
    // The first literal send may have landed before Enter or the SSH response failed.
    return { status: 'unknown' };
  }
}

export interface RemoteCodexRestartRequest {
  sessionId: string;
  resumeId?: string;
  submission?: { at: number; hash: string };
  expectedIdentity: RemoteCodexIdentityGuard;
  expectedPane: Pick<RemoteCodexPaneEvidence, 'paneId' | 'panePid' | 'status' | 'signal'>;
  codexConfig: CodexConfig;
  codexHome?: string;
}

export function buildRemoteCodexRestartCommand(remote: SessionRemote, request: RemoteCodexRestartRequest): string {
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
    },
    {
      kind: 'restart',
      expected: { ...request.expectedIdentity, ...request.expectedPane },
      command: paneCommand,
    }
  );
}

export async function restartRemoteCodexPane(
  remote: SessionRemote,
  request: RemoteCodexRestartRequest
): Promise<'sent' | 'not-sent' | 'unknown'> {
  if (process.env.VITEST) throw new Error('Remote Codex IO requires an injected fixture under VITEST');
  try {
    const { stdout } = await execAsync(buildRemoteCodexRestartCommand(remote, request), {
      timeout: 15_000,
      maxBuffer: MAX_REMOTE_CODEX_STDOUT_BYTES,
    });
    return parseRemoteCodexAction(stdout) ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
