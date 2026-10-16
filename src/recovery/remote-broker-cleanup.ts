/** @fileoverview Final owner deletion only: trusted remote retirement, never broker code or worker input. */
import { performance } from 'node:perf_hooks';
import type { SessionRemote } from '../types.js';
import { buildSshConnectionArgs, remoteLoginShellCommand, remoteSshTarget, shellescape } from '../remote-hosts.js';
import { runWithRemoteSshLimit } from '../remote-ssh-limiter.js';
import { prepareRecoveryPrivilegeGrant } from '../user-store.js';
import { runRemoteBrokerStdin } from './remote-broker-transport.js';
import type { RemoteBrokerTransport } from './remote-input-broker.js';
import type { BrokerProvisioningMaterial } from './codex-input-broker.js';
import { CODEX_BROKER_CLEANUP_SOURCE } from './codex-broker-cleanup-source.js';

export interface RemoteBrokerCleanupTarget {
  remote: SessionRemote;
  owner?: string;
}

// Reuse the janitor's coherent bounded reads, private descriptors, and kernel
// process-birth checks. No journal discovery or executable incarnation source.
export const REMOTE_BROKER_CLEANUP_SOURCE =
  CODEX_BROKER_CLEANUP_SOURCE.split('\ndef identity(')[0] +
  String.raw`
import subprocess
def mux_absent(sid):
    check()
    name='codeman-ssh-'+sid[:8]
    result=subprocess.run(['tmux','-L','codeman-remote','has-session','-t','='+name],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=max(0.001,DEADLINE-time.monotonic()),env={**os.environ,'LC_ALL':'C'})
    if result.stdout or len(result.stderr)>16384 or result.returncode!=1: return False
    diagnostic=result.stderr.decode('utf-8','strict')
    error=diagnostic.strip()
    if error=='can\'t find session: '+name or error.startswith('no server running on '): return True
    # The explicit -L socket lives under tmux's canonical per-user directory.
    missing=re.fullmatch(r'error connecting to (/[^\x00-\x1f\x7f]+) \(No such file or directory\)\n?',diagnostic)
    if missing is None: return False
    path=missing.group(1)
    return canonical(path) and os.path.basename(path)=='codeman-remote' and os.path.basename(os.path.dirname(path))=='tmux-'+str(os.getuid())

def retired(config,state,expected):
    if not isinstance(config,dict) or set(config)!=set(expected) or type(config.get('version')) is not int: return False
    if any(config.get(k)!=v for k,v in expected.items() if k!='startup'): return False
    startup=config.get('startup')
    if not isinstance(startup,dict) or not {'monotonicDeadline','nonce','privateFiles','privatePaths','missingPaths','issuer'}<=set(startup)<={'monotonicDeadline','nonce','privateFiles','privatePaths','missingPaths','issuer','issuerLease'}: return False
    if startup.get('nonce')!=expected['startup']['nonce']: return False
    if state is None: return config==expected
    if not isinstance(state,dict) or set(state)!={'version','sessionId','incarnation','pid','childPid','brokerStart','childStart','tainted','rawGeneration','launchDigest','homeDigest','closed','exitStatus','exitSignal','counters','receipts','startup'}: return False
    if type(state.get('version')) is not int or state.get('version')!=1 or any(state.get(k)!=expected[k] for k in ('sessionId','incarnation','launchDigest','homeDigest')): return False
    if type(state.get('closed')) is not bool or state.get('tainted') is not False or type(state.get('rawGeneration')) is not int or state['rawGeneration']!=0: return False
    if not native_absent(state.get('pid'),state.get('brokerStart')): return False
    child=state.get('childPid')
    if type(child) is not int or child<0 or (child>0 and not native_absent(child,state.get('childStart'))): return False
    if not isinstance(state.get('startup'),dict) or set(state['startup'])!={'nonce','status'} or state['startup']['nonce']!=startup['nonce'] or state['startup']['status'] not in ('started','not-sent'): return False
    if child==0 and (state['startup']['status']!='not-sent' or state.get('childStart') is not None): return False
    if child>0 and state['startup']['status']!='started': return False
    if state['exitStatus'] is not None and (type(state['exitStatus']) is not int or not 0<=state['exitStatus']<=255): return False
    if state['exitSignal'] is not None and (type(state['exitSignal']) is not int or state['exitSignal'] not in {int(s) for s in signal.valid_signals()}): return False
    counters=state.get('counters'); receipts=state.get('receipts')
    if not isinstance(counters,dict) or set(counters)!=set(CHANNELS) or any(type(v) is not int or not 0<=v<=9007199254740991 for v in counters.values()): return False
    if not isinstance(receipts,list) or len(receipts)>128: return False
    seen=set();heads={}
    for r in receipts:
        fields={'channel','counter','nonce','conversationId','hash','status'}
        if not isinstance(r,dict) or set(r) not in (fields,fields|{'deliveredAt'}): return False
        c,n=r.get('channel'),r.get('counter')
        if c not in CHANNELS or type(n) is not int or not 0<n<=counters[c] or (c,n) in seen or r.get('status') not in ('sent','not-sent'): return False
        if not isinstance(r.get('nonce'),str) or not UUID.fullmatch(r['nonce']) or not isinstance(r.get('conversationId'),str) or (c=='auto' and not UUID.fullmatch(r['conversationId'])) or not isinstance(r.get('hash'),str) or not re.fullmatch(r'[a-f0-9]{64}',r['hash']): return False
        if 'deliveredAt' in r:
            d=r['deliveredAt']
            if not isinstance(d,dict) or set(d)!={'wallBefore','wallAfter','monoBefore','monoAfter'} or any(type(v) not in (int,float) or not math.isfinite(v) or v<=0 for v in d.values()) or d['wallAfter']<d['wallBefore'] or d['monoAfter']<d['monoBefore']: return False
        seen.add((c,n));heads[c]=max(heads.get(c,0),n)
    return all(heads[c]==counters[c] if c in heads else counters[c]==0 or len(receipts)==128 for c in CHANNELS)

def main():
    raw=sys.stdin.buffer.read(524289)
    if len(raw)>524288: raise ValueError('request')
    q=strict_json(raw.decode('utf-8','strict'))
    if not isinstance(q,dict) or set(q)!={'directory','material','finalSession'} or type(q.get('finalSession')) is not bool: raise ValueError('request')
    path=q['directory'];m=q['material'];expected=m['config'];sid=expected['sessionId'];inc=expected['incarnation']
    if not UUID.fullmatch(sid) or not UUID.fullmatch(inc) or not canonical(path) or not path.endswith('/'+sid+'/'+inc): raise ValueError('scope')
    if not mux_absent(sid): raise ValueError('native session')
    # Pin every ancestor, including the complete private remote root/session.
    parents=[];current='/'
    session_path=os.path.dirname(path);root_path=os.path.dirname(session_path)
    receipt_name='.cleanup-'+sid+'-'+inc+'.json'
    material_hash=hashlib.sha256(json.dumps(m,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
    def ancestors_current():
        check()
        for p,before,mode,uid in parents:
            if p in (session_path,path): continue
            now=os.lstat(p)
            if (now.st_dev,now.st_ino)!=(before[0],before[1]) or now.st_mode!=mode or now.st_uid!=uid or not stat.S_ISDIR(now.st_mode) or stat.S_ISLNK(now.st_mode): raise ValueError('ancestor changed')
    def parent_receipt(create=False):
        ancestors_current()
        rootfd=directory(root_path)
        try:
            rootstat=os.fstat(rootfd)
            for p,signature_before,mode,uid in parents:
                if p==root_path and ((rootstat.st_dev,rootstat.st_ino)!=(signature_before[0],signature_before[1]) or rootstat.st_mode!=mode or rootstat.st_uid!=uid): raise ValueError('root changed')
            try:
                data,witness,_=readat(rootfd,receipt_name,2048)
                value=strict_json(data.decode('utf-8','strict'))
            except FileNotFoundError:
                if not create: return None
                parent=os.lstat(session_path)
                if not private(parent,True): raise ValueError('session parent')
                for p,before,mode,uid in parents:
                    if p==session_path and ((parent.st_dev,parent.st_ino)!=(before[0],before[1]) or parent.st_mode!=mode or parent.st_uid!=uid): raise ValueError('session replaced')
                value={'version':1,'sessionId':sid,'incarnation':inc,'materialHash':material_hash,'rootDev':rootstat.st_dev,'rootIno':rootstat.st_ino,'sessionDev':parent.st_dev,'sessionIno':parent.st_ino}
                fd=os.open(receipt_name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=rootfd)
                try:
                    data=json.dumps(value,separators=(',',':')).encode();offset=0
                    while offset<len(data):
                        check();written=os.write(fd,data[offset:])
                        if written<=0: raise ValueError('short receipt write')
                        offset+=written
                    os.fsync(fd);witness=signature(os.fstat(fd))
                finally: os.close(fd)
                os.fsync(rootfd)
            if not isinstance(value,dict) or set(value)!={'version','sessionId','incarnation','materialHash','rootDev','rootIno','sessionDev','sessionIno'} or type(value['version']) is not int or value['version']!=1 or value['sessionId']!=sid or value['incarnation']!=inc or value['materialHash']!=material_hash or any(type(value[k]) is not int or value[k]<0 for k in ('rootDev','rootIno','sessionDev','sessionIno')) or (value['rootDev'],value['rootIno'])!=(rootstat.st_dev,rootstat.st_ino): raise ValueError('unknown parent receipt')
            if create:
                parent=os.lstat(session_path)
                if not private(parent,True) or (parent.st_dev,parent.st_ino)!=(value['sessionDev'],value['sessionIno']): raise ValueError('session replaced')
            ancestors_current()
            return value,witness
        finally: os.close(rootfd)
    def finish_parent():
        check()
        receipt=parent_receipt()
        try: parent=os.lstat(session_path)
        except FileNotFoundError: parent=None
        if receipt is None:
            # Already absent needs no deletion authority. A still-present empty
            # replacement never inherits an old incarnation's path alone.
            return parent is None or (not q['finalSession'] and private(parent,True))
        value,witness=receipt
        if parent is not None:
            if not private(parent,True) or (parent.st_dev,parent.st_ino)!=(value['sessionDev'],value['sessionIno']): raise ValueError('session replaced')
            parentfd=directory(session_path)
            try:
                if (os.fstat(parentfd).st_dev,os.fstat(parentfd).st_ino)!=(parent.st_dev,parent.st_ino): raise ValueError('session changed')
                with os.scandir(parentfd) as entries: nonempty=next(entries,None) is not None
            finally: os.close(parentfd)
            if nonempty and q['finalSession']: return False
            if not nonempty:
                if not mux_absent(sid): raise ValueError('native session')
                ancestors_current()
                if signature(os.lstat(session_path))!=signature(parent): raise ValueError('session changed')
                check()
                os.rmdir(session_path)
        ancestors_current()
        rootfd=directory(root_path)
        try:
            check()
            if (os.fstat(rootfd).st_dev,os.fstat(rootfd).st_ino)!=(value['rootDev'],value['rootIno']) or signature(os.stat(receipt_name,dir_fd=rootfd,follow_symlinks=False))!=witness: raise ValueError('parent receipt changed')
            # Retain the receipt through the directory ACK. A lost fsync or SSH
            # result can retry even after the whole session path disappeared.
            os.fsync(rootfd)
            ancestors_current()
            if signature(os.stat(receipt_name,dir_fd=rootfd,follow_symlinks=False))!=witness: raise ValueError('replaced parent receipt')
            os.unlink(receipt_name,dir_fd=rootfd);os.fsync(rootfd)
        finally: os.close(rootfd)
        return True
    for part in path.split('/')[1:]:
        check();current=os.path.join(current,part)
        try: st=os.lstat(current)
        except FileNotFoundError:
            for p,s,mode,uid in parents:
                if signature(os.lstat(p))!=s or os.lstat(p).st_mode!=mode or os.lstat(p).st_uid!=uid: raise ValueError('parent')
            if current in (session_path,path): return finish_parent()
            return True
        if not stat.S_ISDIR(st.st_mode) or stat.S_ISLNK(st.st_mode): raise ValueError('parent')
        if current in (path,os.path.dirname(path),os.path.dirname(os.path.dirname(path))) and not private(st,True): raise ValueError('private parent')
        parents.append((current,signature(st),st.st_mode,st.st_uid))
    fd=directory(path);lock=None
    try:
        names=set(namesat(fd,5)); marker='.cleanup.json'
        if not names<={'broker.py','config.json','state.json','lock',marker}: raise ValueError('foreign')
        if not names:
            parent_receipt(True)
            check()
            for p,s,mode,uid in parents:
                now=os.lstat(p)
                if (signature(now)!=s if p!=root_path else (now.st_dev,now.st_ino)!=(s[0],s[1])) or now.st_mode!=mode or now.st_uid!=uid: raise ValueError('parent')
            os.rmdir(path)
            parent=directory(os.path.dirname(path))
            try: os.fsync(parent)
            finally: os.close(parent)
            return finish_parent()
        if marker in names:
            markerbytes,markersig,_=readat(fd,marker,524288)
            plan=strict_json(markerbytes.decode('utf-8','strict'))
            if not isinstance(plan,dict) or set(plan)!={'version','materialHash','config','state','files'} or plan['version']!=1 or plan['materialHash']!=hashlib.sha256(json.dumps(m,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest(): raise ValueError('plan')
            config,state=plan['config'],plan['state'];files=plan['files']
            if not isinstance(files,dict) or not {'broker.py','config.json','lock'}<=set(files)<={'broker.py','config.json','state.json','lock'}: raise ValueError('plan files')
            if any(not isinstance(s,list) or len(s)!=5 or any(type(n) is not int or n<0 for n in s) for s in files.values()): raise ValueError('plan witness')
        else:
            if names not in ({'broker.py','config.json','lock'},{'broker.py','config.json','state.json','lock'}): raise ValueError('files')
            records={name:readat(fd,name,262144 if name=='broker.py' else 98304) for name in names}
            if records['broker.py'][0].decode('utf-8','strict')!=m['helper'] or records['lock'][0]!=b'': raise ValueError('helper')
            config=strict_json(records['config.json'][0].decode('utf-8','strict'))
            state=strict_json(records['state.json'][0].decode('utf-8','strict')) if 'state.json' in records else None
            files={name:list(record[1]) for name,record in records.items()}
            plan={'version':1,'materialHash':hashlib.sha256(json.dumps(m,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest(),'config':config,'state':state,'files':files}
        if not retired(config,state,expected): raise ValueError('not retired')
        # On retry even missing files are authorized only by the durable exact
        # plan. Replacement/unknown material never inherits that authorization.
        for name in names-{marker}:
            data,witness,_=readat(fd,name,262144 if name=='broker.py' else 98304)
            if name not in files or list(witness)!=files[name]: raise ValueError('replaced')
            if name=='broker.py' and data.decode('utf-8','strict')!=m['helper']: raise ValueError('helper')
            if name=='config.json' and strict_json(data.decode('utf-8','strict'))!=config: raise ValueError('config')
            if name=='state.json' and strict_json(data.decode('utf-8','strict'))!=state: raise ValueError('state')
            if name=='lock' and data!=b'': raise ValueError('lock')
        if 'lock' in names:
            lock=os.open('lock',os.O_RDWR|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
            if list(signature(os.fstat(lock)))!=files['lock']: raise ValueError('lock')
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        parent_receipt(True)
        if marker not in names:
            out=os.open(marker,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
            try:
                data=json.dumps(plan,separators=(',',':'),ensure_ascii=False).encode();offset=0
                while offset<len(data): offset+=os.write(out,data[offset:])
                os.fsync(out);markersig=signature(os.fstat(out))
            finally: os.close(out)
            os.fsync(fd)
        def confirm():
            check()
            for p,s,mode,uid in parents:
                # Our intent/unlinks change only incarnation metadata.
                now=os.lstat(p)
                if (now.st_dev,now.st_ino)!=(s[0],s[1]) or now.st_mode!=mode or now.st_uid!=uid or not stat.S_ISDIR(now.st_mode) or stat.S_ISLNK(now.st_mode): raise ValueError('parent')
            if signature(os.stat(marker,dir_fd=fd,follow_symlinks=False))!=markersig or not retired(config,state,expected) or not mux_absent(sid): raise ValueError('changed')
        confirm()
        for name in ('broker.py','state.json','config.json','lock'):
            if name not in names: continue
            confirm()
            if list(signature(os.stat(name,dir_fd=fd,follow_symlinks=False)))!=files[name]: raise ValueError('replaced')
            os.unlink(name,dir_fd=fd);os.fsync(fd)
        confirm()
        if namesat(fd,1)!=[marker]: raise ValueError('foreign')
        os.unlink(marker,dir_fd=fd);os.fsync(fd)
        # A retry can finish the exact private empty directory if interrupted
        # after the last unlink. rmdir never removes an unknown new artifact.
        os.rmdir(path)
        parent=directory(os.path.dirname(path))
        try: os.fsync(parent)
        finally: os.close(parent)
        return finish_parent()
    finally:
        if lock is not None: os.close(lock)
        os.close(fd)
try: print(json.dumps({'complete':main() is True}),flush=True)
except Exception: print(json.dumps({'complete':False}),flush=True)
`;

export async function cleanupRemoteBroker(
  target: RemoteBrokerCleanupTarget,
  directory: string,
  material: BrokerProvisioningMaterial,
  isCurrent: () => boolean,
  options: { transport?: RemoteBrokerTransport; finalSession?: boolean } = {}
): Promise<boolean> {
  const deadline = performance.now() + 1800;
  try {
    const snapshot = structuredClone(target),
      text = JSON.stringify(target);
    const current = () => performance.now() < deadline && isCurrent() === true && JSON.stringify(target) === text;
    if (snapshot.remote.owned === false || !current()) return false;
    const input = JSON.stringify({ directory, material, finalSession: options.finalSession !== false });
    if (Buffer.byteLength(input) > 524288) return false;
    return await runWithRemoteSshLimit(
      async (retain) => {
        const grant = await prepareRecoveryPrivilegeGrant(snapshot.owner);
        if (!current() || !(await grant.verifyCurrent()) || !grant.isCurrent() || !current()) return false;
        const command = [
          ...buildSshConnectionArgs(snapshot.remote),
          remoteSshTarget(snapshot.remote),
          shellescape(remoteLoginShellCommand(`python3 -I -S -c ${shellescape(REMOTE_BROKER_CLEANUP_SOURCE)}`)),
        ].join(' ');
        if (!current() || !grant.isCurrent()) return false;
        const result = await (options.transport
          ? options.transport.run(command, input)
          : runRemoteBrokerStdin(command, input, { inputBytes: 524288, outputBytes: 1024, deadline }, retain));
        return current() && grant.isCurrent() && result.stdout.trim() === '{"complete": true}';
      },
      { deadline, isCurrent: current }
    );
  } catch {
    return false;
  }
}
