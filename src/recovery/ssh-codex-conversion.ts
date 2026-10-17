/** Explicit SSH-shell conversion: bounded native preview, preserved source, no worker input. */
import { performance } from 'node:perf_hooks';
import type { CodexConfig, SessionRemote } from '../types.js';
import { buildSshConnectionArgs, remoteLoginShellCommand, remoteSshTarget, shellescape } from '../remote-hosts.js';
import { runWithRemoteSshLimit } from '../remote-ssh-limiter.js';
import { classifyCodexTail } from './codex-classifier.js';
import { remoteCodexLauncher } from './remote-codex-launcher.js';
import { runRemoteBrokerStdin } from './remote-broker-transport.js';
import type { RemoteBrokerDeadPane, RemoteBrokerTransport } from './remote-input-broker.js';

export interface SshCodexConversation {
  id: string;
  modifiedAt: number;
  config?: CodexConfig;
  unavailableReason?: string;
  witness: { path: string; dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; sha256: string };
}
export interface SshCodexConversionPreview {
  version: 1;
  sessionName: string;
  sessionId: string;
  paneId: string;
  panePid: number;
  serverPid: number;
  processStart: string;
  cwd: string;
  codexHome: string;
  capturedAt: number;
  launcher: string;
  conversations: SshCodexConversation[];
}
export type SshCodexConversionInspection =
  | { status: 'ready'; preview: SshCodexConversionPreview }
  | { status: 'refused'; reason: string };
export type SshCodexConversionResult =
  | { status: 'converted'; retainedSessionName: string; replacementPane: RemoteBrokerDeadPane }
  | { status: 'not-sent' | 'unknown' };
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const MARKER = 'CODEMAN_SSH_CODEX_CONVERSION_V1:';
const MAX_WIRE = 2_200_000;

/** Fixed helper: request paths are validated against the owner-selected session scope. */
export const SSH_CODEX_CONVERSION_SOURCE = String.raw`
const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process'),crypto=require('crypto');
const procRoot='/proc';
const started=require('perf_hooks').performance.now();
const check=()=>{if(require('perf_hooks').performance.now()-started>7000)throw Error('inspection deadline exceeded')};
const emit=value=>process.stdout.write('${MARKER}'+Buffer.from(JSON.stringify(value)).toString('base64')+'\n');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const clean=x=>typeof x==='string'&&x.length>0&&Buffer.byteLength(x)<=4096&&!/[\x00-\x1f\x7f]/.test(x)&&Buffer.from(x).toString('utf8')===x;
const absolute=x=>clean(x)&&path.isAbsolute(x)&&path.normalize(x)===x;
const read=(file,limit)=>{check();const stdin=file==='/dev/stdin',fd=stdin?0:fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);try{const before=fs.fstatSync(fd);if((!stdin&&!before.isFile())||before.size>limit)throw Error('unsupported file');const b=Buffer.alloc(limit+1);let n=0;while(n<b.length){let k=fs.readSync(fd,b,n,b.length-n,null);if(!k)break;n+=k;check()}if(n>limit)throw Error('file exceeds inspection limit');const after=fs.fstatSync(fd);if(['dev','ino','size','mtimeMs','ctimeMs'].some(k=>before[k]!==after[k]))throw Error('file changed');const bytes=b.subarray(0,n);if(!Buffer.from(bytes.toString('utf8')).equals(bytes))throw Error('invalid text');return{bytes,text:bytes.toString('utf8'),stat:after}}finally{if(!stdin)fs.closeSync(fd)}};
const run=args=>{check();return cp.execFileSync('tmux',['-L','codeman-remote',...args],{encoding:'utf8',timeout:1500,maxBuffer:16384})};
const env=pid=>{const text=read(path.join(procRoot,''+pid,'environ'),65536).text,values={};for(const item of text.split('\0').filter(Boolean)){const at=item.indexOf('=');if(at<1)throw Error('invalid native environment');const key=item.slice(0,at);if(Object.hasOwn(values,key))throw Error('duplicate native environment');values[key]=item.slice(at+1)}return values};
const homeOf=e=>{const home=e.CODEX_HOME||path.join(e.HOME||os.homedir(),'.codex');if(!absolute(home))throw Error('Codex home is not an absolute canonical path');return home};
const stat=pid=>{const value=read(path.join(procRoot,''+pid,'stat'),8192).text;const close=value.lastIndexOf(')');if(close<2)throw Error('native process stat unavailable');const f=value.slice(close+2).trim().split(/\s+/);if(f.length<20||!/^\d+$/.test(f[19]))throw Error('native process birth unavailable');return{state:f[0],group:f[2],foreground:f[5],birth:f[19]}};
const pane=name=>{const text=run(['list-panes','-t',name,'-F','#{session_name}|#{session_id}|#{pane_id}|#{pane_pid}|#{pane_dead}|#{pid}|#{session_windows}|#{window_panes}']);if(text.split('\n').filter(Boolean).length!==1)throw Error('conversion requires one owned shell pane');const f=text.trim().split('|');if(f.length!==8||f[0]!==name||!/^\$\d+$/.test(f[1])||!/^%\d+$/.test(f[2])||!f.slice(3,6).every((x,i)=>i===1?x==='0':/^[1-9]\d*$/.test(x))||f[6]!=='1'||f[7]!=='1')throw Error('owned shell pane is unavailable');return{sessionName:name,sessionId:f[1],paneId:f[2],panePid:+f[3],serverPid:+f[5]}};
const native=(req)=>{const name='codeman-ssh-'+req.sessionId.slice(0,8),p=pane(name),s=stat(p.panePid);if(s.state!=='S'||s.group!==s.foreground)throw Error('Pane is not at a verified shell prompt. A Codex chat awaiting input is still running; exit it to the shell before converting.');const info=fs.statSync(path.join(procRoot,''+p.panePid));if(info.uid!==process.getuid())throw Error('shell is not owned by this SSH account');const cmd=read(path.join(procRoot,''+p.panePid,'cmdline'),8192).text.split('\0').filter(Boolean);if(!cmd.length||!['sh','bash','dash','zsh','fish','ksh'].includes(path.basename(cmd[0]).replace(/^-/ ,''))||cmd.slice(1).some(x=>!['-l','-i','-il','-li','--login','--interactive'].includes(x)))throw Error('A CLI is still open, even if its chat is idle. Exit it to the shell prompt, then preview to resume the same conversation.');const children=read(path.join(procRoot,''+p.panePid,'task',''+p.panePid,'children'),8192).text.trim();if(children)throw Error('Shell has child work; an idle chat still counts as a running program. Return to its shell prompt first.');const cwd=fs.readlinkSync(path.join(procRoot,''+p.panePid,'cwd'));if(cwd!==req.workingDir)throw Error('shell working directory changed; update the case before converting');const codexHome=homeOf(env(p.panePid));return{version:1,...p,processStart:s.birth,cwd,codexHome,launcher:req.launcher}};
const noOtherCodex=home=>{let count=0;for(const entry of fs.readdirSync(procRoot)){check();if(!/^\d+$/.test(entry)||+entry===process.pid)continue;if(++count>4096)throw Error('process inspection incomplete');const root=path.join(procRoot,entry);let info;try{info=fs.statSync(root)}catch{throw Error('process inventory changed; preview again')}if(info.uid!==process.getuid())continue;const raw=read(path.join(root,'cmdline'),65536).text;if(!raw)continue;const args=raw.split('\0').filter(Boolean);if(!args.slice(0,2).some(a=>/(?:^|[-_\/])codex(?:$|[-_.])/.test(a)))continue;if(homeOf(env(+entry))===home)throw Error('a Codex process already uses this home; leave existing chats open or close it before converting')}};
const same=(a,b,keys)=>keys.every(k=>a[k]===b[k]);
// Resolve every component relative to a held no-follow directory descriptor. A
// Dirent is only a hint: it never authorizes traversing its later pathname.
const secureDirectory=(directory,operation)=>{if(!absolute(directory))throw Error('unsafe discovery path');const opened=[],chain=[];try{let fd=fs.openSync('/',fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);opened.push(fd);let current='/';for(const part of directory.split('/').filter(Boolean)){check();current=path.join(current,part);fd=fs.openSync('/proc/self/fd/'+fd+'/'+part,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);opened.push(fd);chain.push({path:current,stat:fs.fstatSync(fd)})}const verify=()=>{check();for(const item of chain){const actual=fs.lstatSync(item.path);if(!actual.isDirectory()||actual.isSymbolicLink()||!same(actual,item.stat,['dev','ino']))throw Error('conversation directory changed')}};verify();const result=operation('/proc/self/fd/'+fd,verify);verify();return result}finally{for(const fd of opened.reverse())fs.closeSync(fd)}};
const readConversation=(file,limit)=>{if(!absolute(file))throw Error('unsafe conversation path');return secureDirectory(path.dirname(file),directory=>read(path.join(directory,path.basename(file)),limit))};
const candidates=(home,cwd)=>{const root=path.join(home,'sessions');let entries=0,total=0;const found=[];const visit=(directory,depth)=>{if(depth>4)throw Error('conversation discovery too deep');return secureDirectory(directory,(anchored,verify)=>{for(const item of fs.readdirSync(anchored,{withFileTypes:true})){check();verify();if(++entries>2000)throw Error('conversation discovery incomplete');const file=path.join(directory,item.name),anchoredFile=path.join(anchored,item.name);if(item.isSymbolicLink())throw Error('conversation discovery contains links');if(item.isDirectory()){visit(file,depth+1);continue}if(!item.isFile()||!/^rollout-.*\.jsonl$/.test(item.name))continue;const st=fs.lstatSync(anchoredFile);if(!st.isFile()||st.uid!==process.getuid()||st.isSymbolicLink())throw Error('conversation file is not owned');const fd=fs.openSync(anchoredFile,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);let first;try{if(!same(st,fs.fstatSync(fd),['dev','ino','size','mtimeMs','ctimeMs']))throw Error('conversation changed');const b=Buffer.alloc(Math.min(st.size,65536));const n=fs.readSync(fd,b,0,b.length,0);const end=b.subarray(0,n).indexOf(10);if(end<0)continue;first=JSON.parse(b.subarray(0,end).toString('utf8'));if(!same(st,fs.fstatSync(fd),['dev','ino','size','mtimeMs','ctimeMs']))throw Error('conversation changed')}finally{fs.closeSync(fd)}verify();if(first.type!=='session_meta'||!first.payload||first.payload.cwd!==cwd)continue;const id=first.payload.id;if(typeof id!=='string'||!uuid.test(id))throw Error('conversation identity is malformed');if(found.some(x=>x.id===id))throw Error('conversation identity is ambiguous');if(found.length>=32)throw Error('too many matching conversations');let text='',sha256='',unavailableReason;const current=fs.lstatSync(anchoredFile);if(!same(st,current,['dev','ino','size','mtimeMs','ctimeMs']))throw Error('conversation changed');if(st.size>524288||total+st.size>1400000){unavailableReason='Conversation exceeds the complete evidence bound; use the normal Codex resume interface.'}else{const value=read(anchoredFile,524288);verify();if(!same(st,value.stat,['dev','ino','size','mtimeMs','ctimeMs']))throw Error('conversation changed');text=value.text;total+=value.bytes.length;sha256=hash(value.bytes);if(!text.endsWith('\n'))unavailableReason='Conversation contains an incomplete record.'}found.push({id,modifiedAt:st.mtimeMs,witness:{path:file,dev:st.dev,ino:st.ino,size:st.size,mtimeMs:st.mtimeMs,ctimeMs:st.ctimeMs,sha256},rollout:text,unavailableReason})}})};visit(root,0);return found.sort((a,b)=>b.modifiedAt-a.modifiedAt||a.id.localeCompare(b.id))};
let changed=false;
try{const data=read('/dev/stdin',131072).text;const req=JSON.parse(data);if(!req||!uuid.test(req.sessionId)||!absolute(req.workingDir)||typeof req.launcher!=='string'||! /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*|\/[A-Za-z0-9_.\/-]+)$/.test(req.launcher))throw Error('invalid request');const before=native(req);noOtherCodex(before.codexHome);
if(req.kind==='preview'){const conversations=candidates(before.codexHome,before.cwd);const after=native(req);if(JSON.stringify(before)!==JSON.stringify(after))throw Error('shell changed during preview');emit({status:'ready',preview:{...before,capturedAt:Date.now(),conversations}})}
else if(req.kind==='apply'){
const expected=req.preview,thread=expected&&expected.conversations.find(x=>x.id===req.conversationId);if(!expected||!thread||thread.unavailableReason||!uuid.test(req.conversationId)||!/^codeman-retained-[a-f0-9]{8}-[a-f0-9]{12}$/.test(req.retainedSessionName)||!same(before,expected,['version','sessionName','sessionId','paneId','panePid','serverPid','processStart','cwd','codexHome','launcher'])||Date.now()-expected.capturedAt<0||Date.now()-expected.capturedAt>120000)throw Error('preview expired or shell changed');if(!thread.witness.path.startsWith(path.join(before.codexHome,'sessions')+'/'))throw Error('conversation is outside its home');const value=readConversation(thread.witness.path,524288);if(!same(value.stat,thread.witness,['dev','ino','size','mtimeMs','ctimeMs'])||hash(value.bytes)!==thread.witness.sha256)throw Error('conversation changed after preview');
let exists=true;try{run(['has-session','-t',req.retainedSessionName])}catch(e){if(e.status===1)exists=false;else throw e}if(exists)throw Error('retained shell name already exists');
const staging='codeman-converting-'+req.retainedSessionName.slice(-12),channel='codeman-convert-'+crypto.randomBytes(16).toString('hex');changed=true;const row=run(['new-session','-d','-P','-F','#{session_id}|#{pane_id}|#{pane_pid}|#{pid}','-s',staging,'-c',before.cwd,'/bin/sh','-c','tmux -L codeman-remote wait-for '+channel+'; exit 1']).trim().split('|');if(row.length!==4||!/^\$\d+$/.test(row[0])||!/^%\d+$/.test(row[1])||!row.slice(2).every(x=>/^[1-9]\d*$/.test(x)))throw Error('inert pane identity unavailable');run(['set-option','-t',row[0],'remain-on-exit','failed',';','wait-for','-S',channel]);let inert=false;for(let i=0;i<50;i++){const status=run(['display-message','-p','-t',row[1],'#{pane_dead}|#{pane_pid}|#{pane_dead_status}']);if(status==='1|'+row[2]+'|1\n'){inert=true;break}Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20)}if(!inert)throw Error('new pane is not inert');
const current=native(req);noOtherCodex(before.codexHome);if(JSON.stringify(current)!==JSON.stringify(before))throw Error('shell changed');const final=readConversation(thread.witness.path,524288);if(!same(final.stat,thread.witness,['dev','ino','size','mtimeMs','ctimeMs'])||hash(final.bytes)!==thread.witness.sha256)throw Error('conversation changed');
const pred=fields=>Object.entries(fields).map(([k,v])=>'#{==:#{'+k+'},'+v+'}').reduce((a,b)=>'#{&&:'+a+','+b+'}');const original=pred({session_name:before.sessionName,session_id:before.sessionId,pane_id:before.paneId,pane_pid:before.panePid,pane_dead:0,pid:before.serverPid,session_windows:1,window_panes:1});const fresh=pred({session_name:staging,session_id:row[0],pane_id:row[1],pane_pid:row[2],pane_dead:1,pane_dead_status:1,pid:row[3],session_windows:1,window_panes:1});const quote=x=>"'"+x.replace(/'/g,"'\\''")+"'";const rename='rename-session -t '+quote(before.sessionId)+' '+req.retainedSessionName+' ; rename-session -t '+quote(row[0])+' '+before.sessionName+' ; display-message -p CODEMAN_CONVERSION_ACK';const guarded='if-shell -F -t '+quote(row[1])+' '+quote(fresh)+' '+quote(rename)+' '+quote('display-message -p CODEMAN_CONVERSION_REFUSED');const response=run(['if-shell','-F','-t',before.paneId,original,guarded,'display-message -p CODEMAN_CONVERSION_REFUSED']);if(response!=='CODEMAN_CONVERSION_ACK\n')throw Error('native pane replacement refused');emit({status:'converted',retainedSessionName:req.retainedSessionName,replacementPane:{paneId:row[1],panePid:+row[2],status:1}})
}else throw Error('unsupported request')
}catch(e){emit({status:changed?'unknown':'refused',reason:changed?'Conversion needs inspection; the retained shell or inert staging pane may exist.':String(e.message).slice(0,200)})}
`;

function command(remote: SessionRemote): string {
  return [
    ...buildSshConnectionArgs(remote),
    remoteSshTarget(remote),
    shellescape(remoteLoginShellCommand(`node -e ${shellescape(SSH_CODEX_CONVERSION_SOURCE)}`)),
  ].join(' ');
}
function parsed(stdout: string): unknown {
  if (Buffer.byteLength(stdout) > MAX_WIRE) throw new Error('Conversion response exceeds bound');
  const rows = stdout.split('\n').filter((row) => row.startsWith(MARKER));
  if (rows.length !== 1) throw new Error('Conversion response is ambiguous');
  const text = rows[0].slice(MARKER.length);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text))
    throw new Error('Conversion response is malformed');
  return JSON.parse(Buffer.from(text, 'base64').toString('utf8'));
}
function configuration(rollout: string, id: string): CodexConfig | undefined {
  try {
    const records = rollout
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    if (records[0]?.type !== 'session_meta' || records[0]?.payload?.id !== id) return undefined;
    const observation = classifyCodexTail(rollout, {
      conversationId: id,
      now: Date.now(),
      screen: null,
      busy: false,
      watching: false,
      tailTruncated: false,
    });
    if (!['completed', 'idle'].includes(observation.activity)) return undefined;
    const settings = records.filter((row) => row.type === 'turn_context').at(-1)?.payload;
    if (
      !settings ||
      settings.cwd !== records[0].payload.cwd ||
      !['on-request', 'never'].includes(settings.approval_policy) ||
      typeof settings.model !== 'string' ||
      !/^[\w.:-]{1,100}$/.test(settings.model)
    )
      return undefined;
    const sandbox = settings.sandbox_policy;
    if (!sandbox || !['read-only', 'workspace-write', 'danger-full-access'].includes(sandbox.type)) return undefined;
    const sandboxKeys =
      sandbox.type === 'workspace-write'
        ? ['type', 'writable_roots', 'network_access', 'exclude_tmpdir_env_var', 'exclude_slash_tmp']
        : sandbox.type === 'read-only'
          ? ['type', 'network_access']
          : ['type'];
    if (Object.keys(sandbox).some((key) => !sandboxKeys.includes(key))) return undefined;
    if (
      sandbox.type === 'workspace-write' &&
      (!Array.isArray(sandbox.writable_roots) ||
        sandbox.writable_roots.length ||
        sandbox.network_access !== false ||
        [sandbox.exclude_tmpdir_env_var, sandbox.exclude_slash_tmp].some(
          (value) => value !== undefined && value !== false
        ))
    )
      return undefined;
    if (sandbox.type === 'read-only' && sandbox.network_access !== undefined && sandbox.network_access !== false)
      return undefined;
    if (
      settings.effort !== undefined &&
      !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(settings.effort)
    )
      return undefined;
    return {
      resumeSessionId: id,
      noDaemon: true,
      noAltScreen: true,
      renderMode: 'hybrid',
      model: settings.model,
      sandbox: sandbox.type,
      approvalPolicy: settings.approval_policy,
      ...(settings.effort ? { reasoningEffort: settings.effort } : {}),
    };
  } catch {
    return undefined;
  }
}
async function run(
  remote: SessionRemote,
  request: unknown,
  current: () => boolean,
  transport?: RemoteBrokerTransport,
  onDispatch?: () => void
): Promise<unknown> {
  const snapshot = JSON.stringify(remote),
    deadline = performance.now() + 12_000;
  const admitted = () =>
    current() === true && remote.owned !== false && JSON.stringify(remote) === snapshot && performance.now() < deadline;
  if (!admitted()) throw new Error('Conversion ownership changed');
  return runWithRemoteSshLimit(
    async (retain) => {
      if (!admitted()) throw new Error('Conversion ownership changed');
      const input = JSON.stringify(request);
      if (Buffer.byteLength(input) > 131072) throw new Error('Conversion request too large');
      const remoteCommand = command(remote);
      onDispatch?.();
      const response = await (transport?.run(remoteCommand, input) ??
        runRemoteBrokerStdin(remoteCommand, input, { inputBytes: 131072, outputBytes: MAX_WIRE, deadline }, retain));
      return parsed(response.stdout);
    },
    { deadline, isCurrent: admitted }
  );
}
export async function inspectSshCodexConversion(
  remote: SessionRemote,
  sessionId: string,
  options: { transport?: RemoteBrokerTransport; isCurrent?: () => boolean } = {}
): Promise<SshCodexConversionInspection> {
  const launcher = remoteCodexLauncher(remote);
  if (!UUID.test(sessionId) || remote.owned === false || !launcher)
    return {
      status: 'refused',
      reason: 'Conversion needs an owned SSH shell and an argv-forwarding Codex executable.',
    };
  try {
    const value = (await run(
      remote,
      { kind: 'preview', sessionId, workingDir: remote.remotePath, launcher },
      options.isCurrent ?? (() => true),
      options.transport
    )) as {
      status?: string;
      reason?: string;
      preview?: Omit<SshCodexConversionPreview, 'conversations'> & {
        conversations: Array<SshCodexConversation & { rollout?: string }>;
      };
    };
    if (value.status !== 'ready' || !value.preview)
      return {
        status: 'refused',
        reason: typeof value.reason === 'string' ? value.reason : 'Remote shell inspection is incomplete.',
      };
    const preview = value.preview;
    if (
      preview.version !== 1 ||
      preview.sessionName !== `codeman-ssh-${sessionId.slice(0, 8)}` ||
      !/^\$\d+$/.test(preview.sessionId) ||
      !/^%\d+$/.test(preview.paneId) ||
      ![preview.panePid, preview.serverPid].every((n) => Number.isSafeInteger(n) && n > 0) ||
      !/^[1-9]\d*$/.test(preview.processStart) ||
      preview.cwd !== remote.remotePath ||
      !preview.codexHome.startsWith('/') ||
      preview.launcher !== launcher ||
      !Number.isSafeInteger(preview.capturedAt) ||
      !Array.isArray(preview.conversations) ||
      preview.conversations.length > 32
    )
      throw new Error('Malformed preview');
    const conversations = preview.conversations.map((candidate) => {
      if (
        !UUID.test(candidate.id) ||
        !Number.isFinite(candidate.modifiedAt) ||
        !candidate.witness ||
        typeof candidate.witness.path !== 'string' ||
        !candidate.witness.path.startsWith(`${preview.codexHome}/sessions/`) ||
        typeof candidate.witness.sha256 !== 'string' ||
        !['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(
          (key) =>
            typeof candidate.witness[key as keyof typeof candidate.witness] === 'number' &&
            Number.isFinite(candidate.witness[key as keyof typeof candidate.witness])
        )
      )
        throw new Error('Malformed conversation');
      const config =
        !candidate.unavailableReason && typeof candidate.rollout === 'string'
          ? configuration(candidate.rollout, candidate.id)
          : undefined;
      return {
        id: candidate.id,
        modifiedAt: candidate.modifiedAt,
        witness: candidate.witness,
        ...(config
          ? { config }
          : {
              unavailableReason:
                candidate.unavailableReason ??
                'Complete idle lifecycle and exact launch settings could not be verified.',
            }),
      };
    });
    if (options.isCurrent && options.isCurrent() !== true) throw new Error('Owner changed');
    return { status: 'ready', preview: { ...preview, conversations } };
  } catch {
    return {
      status: 'refused',
      reason: 'Remote inspection failed or returned incomplete evidence; nothing was changed.',
    };
  }
}
export async function applySshCodexConversion(
  remote: SessionRemote,
  sessionId: string,
  preview: SshCodexConversionPreview,
  conversationId: string,
  retainedSessionName: string,
  isCurrent: () => boolean,
  options: { transport?: RemoteBrokerTransport } = {}
): Promise<SshCodexConversionResult> {
  if (
    !isCurrent() ||
    !UUID.test(sessionId) ||
    !UUID.test(conversationId) ||
    !preview.conversations.find((entry) => entry.id === conversationId && entry.config && !entry.unavailableReason) ||
    !/^codeman-retained-[a-f0-9]{8}-[a-f0-9]{12}$/.test(retainedSessionName)
  )
    return { status: 'not-sent' };
  let submitted = false;
  try {
    const result = (await run(
      remote,
      {
        kind: 'apply',
        sessionId,
        workingDir: remote.remotePath,
        launcher: preview.launcher,
        preview: { ...preview, conversations: preview.conversations.filter((entry) => entry.id === conversationId) },
        conversationId,
        retainedSessionName,
      },
      isCurrent,
      options.transport,
      () => {
        submitted = true;
      }
    )) as { status?: string; retainedSessionName?: string; replacementPane?: RemoteBrokerDeadPane };
    if (result.status === 'refused') return { status: 'not-sent' };
    if (
      result.status !== 'converted' ||
      result.retainedSessionName !== retainedSessionName ||
      !result.replacementPane ||
      !/^%\d+$/.test(result.replacementPane.paneId) ||
      !Number.isSafeInteger(result.replacementPane.panePid) ||
      result.replacementPane.panePid <= 0 ||
      result.replacementPane.status !== 1 ||
      result.replacementPane.signal !== undefined
    )
      return { status: 'unknown' };
    return { status: 'converted', retainedSessionName, replacementPane: result.replacementPane };
  } catch {
    return { status: submitted ? 'unknown' : 'not-sent' };
  }
}
