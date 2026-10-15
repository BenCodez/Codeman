/** Trusted janitor only: never imports or executes an incarnation's broker.py. */
export const CODEX_BROKER_CLEANUP_SOURCE = String.raw`
import errno, fcntl, hashlib, json, math, os, re, select, signal, stat, sys, time
UUID = re.compile(r'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$')
ANY_UUID = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}')
CHANNELS = ('owner-pty','owner-key','owner-mux','auto','probe')
REASONS = ('disabled', 'observing', 'identity-unverified', 'identity-changed', 'managed-daemon', 'unsupported-location', 'unowned-session', 'user-input', 'user-interrupted', 'approval-required', 'authentication-required', 'usage-limit', 'internal-retry', 'turn-running', 'background-work', 'turn-completed', 'turn-interrupted', 'turn-failed', 'process-crashed', 'clean-exit', 'pane-unverified', 'stalled', 'scheduled', 'continuation-sent', 'process-resumed', 'recovery-accepted', 'delivery-failed', 'acceptance-unverified', 'retries-exhausted', 'recovery-window-exhausted', 'restart-in-flight', 'persistence-failed', 'manual-reset')
FILES = ('broker.py','config.json','state.json','lock')
DEADLINE = time.monotonic() + 1.9

def invalid_constant(value):
    raise ValueError('non-finite JSON')

def finite_float(value):
    parsed=float(value)
    if not math.isfinite(parsed): raise ValueError('non-finite JSON')
    return parsed

def finite_int(value):
    if not math.isfinite(float(value)): raise ValueError('non-finite JSON')
    return int(value)

def strict_json(value):
    return json.loads(value,parse_constant=invalid_constant,parse_float=finite_float,parse_int=finite_int)

def check():
    if time.monotonic() >= DEADLINE: raise ValueError('deadline')

def private(st, directory=False):
    return (stat.S_ISDIR(st.st_mode) if directory else stat.S_ISREG(st.st_mode)) and st.st_uid == os.getuid() and not st.st_mode & 0o077

def signature(st):
    return (st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns)

def directory(path):
    fd = os.open(path, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_NONBLOCK)
    st=os.fstat(fd)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid() or st.st_mode & 0o022:
        os.close(fd)
        raise ValueError('directory')
    return fd

def namesat(fd, maximum=5):
    names=[]
    with os.scandir(fd) as entries:
        for entry in entries:
            check(); names.append(entry.name)
            if len(names)>maximum: raise ValueError('unknown files')
    return names

def readat(parent, name, maximum=98304, secret=True):
    check()
    fd = os.open(name, os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK, dir_fd=parent)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or (before.st_mode & (0o077 if secret else 0o022)) or before.st_size > maximum: raise ValueError('file')
        data = bytearray()
        while len(data) <= maximum:
            check()
            part = os.read(fd, min(32768, maximum+1-len(data)))
            if not part: break
            data.extend(part)
        if len(data) != before.st_size or signature(before) != signature(os.fstat(fd)): raise ValueError('changed')
    finally:
        os.close(fd)
    if signature(before) != signature(os.stat(name, dir_fd=parent, follow_symlinks=False)): raise ValueError('replaced')
    return bytes(data), signature(before), hashlib.sha256(data).hexdigest()

def native_absent(pid, birth):
    if type(pid) is not int or pid <= 0 or pid > 9007199254740991 or not isinstance(birth,str) or not re.fullmatch(r'[1-9][0-9]{0,23}',birth): return False
    try:
        fd = os.open('/proc/%d/stat'%pid, os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except FileNotFoundError:
        # A missing/unmounted proc filesystem is not evidence of process death.
        # Only the kernel's ESRCH can certify absence in that case.
        try: os.kill(pid,0)
        except ProcessLookupError: return True
        except OSError: return False
        return False
    try:
        raw = os.read(fd,8193).decode('utf-8','strict')
        end = raw.rfind(')')
        fields = raw[end+2:].split()
        if end < 0 or len(raw)>8192 or len(fields)<20 or not re.fullmatch(r'[0-9]{1,24}',fields[19]): return False
        # A zombie with the same birth still retains its process identity.
        return fields[19] != birth
    finally: os.close(fd)

def canonical(path):
    return isinstance(path,str) and path.startswith('/') and os.path.normpath(path)==path and '\x00' not in path and len(path.encode())<=4096

def paths_valid(paths):
    return isinstance(paths,list) and len(paths)<=2048 and all(isinstance(w,dict) and {'path','kind','dev','ino'}<=set(w)<={'path','kind','dev','ino','size','mtimeMs','ctimeMs'} and w['kind'] in ('directory','file') and canonical(w['path']) and all(type(w[k]) in (int,float) and math.isfinite(w[k]) and w[k]>=0 for k in set(w)-{'path','kind'}) for w in paths)

def files_valid(files):
    return isinstance(files,list) and len(files)<=8 and all(isinstance(w,dict) and set(w)=={'path','dev','ino','size','mtimeMs','ctimeMs','hash','maxBytes'} and canonical(w['path']) and type(w['maxBytes']) is int and 0<w['maxBytes']<=2097152 and type(w['size']) is int and 0<=w['size']<=w['maxBytes'] and isinstance(w['hash'],str) and re.fullmatch(r'[a-f0-9]{64}',w['hash']) and all(type(w[k]) in (int,float) and math.isfinite(w[k]) and w[k]>=0 for k in ('dev','ino','mtimeMs','ctimeMs')) for w in files)

def issuer_valid(issuer):
    if issuer is None: return True
    if not isinstance(issuer,dict) or not {'sessionId','incarnation','directory','proof'}<=set(issuer)<= {'sessionId','incarnation','directory','proof','files','paths'}: return False
    if any(not isinstance(issuer[k],str) or not UUID.fullmatch(issuer[k]) for k in ('sessionId','incarnation')) or not canonical(issuer['directory']): return False
    p=issuer['proof']
    required={'incarnation','brokerPid','childPid','brokerStart','childStart','closed','rawGeneration','launchDigest','homeDigest','ownerCounters'}
    if not isinstance(p,dict) or not required<=set(p)<=required|{'exitStatus','exitSignal','fileWitness'} or p['incarnation']!=issuer['incarnation'] or p['closed'] is not False or type(p['rawGeneration']) is not int or p['rawGeneration']!=0: return False
    if any(type(p[k]) is not int or not 0<p[k]<=9007199254740991 for k in ('brokerPid','childPid')) or any(not isinstance(p[k],str) or not re.fullmatch(r'[1-9][0-9]{0,23}',p[k]) for k in ('brokerStart','childStart')): return False
    if any(not isinstance(p[k],str) or not re.fullmatch(r'[a-f0-9]{64}',p[k]) for k in ('launchDigest','homeDigest')) or p.get('exitStatus') is not None or p.get('exitSignal') is not None: return False
    if not isinstance(p['ownerCounters'],dict) or set(p['ownerCounters'])!=set(CHANNELS[:3]) or any(type(v) is not int or not 0<=v<=9007199254740991 for v in p['ownerCounters'].values()): return False
    return files_valid(issuer.get('files',[])) and paths_valid(issuer.get('paths',[])) and ('fileWitness' not in p or files_valid([p['fileWitness']]))

def eligible(config, state, sid, inc):
    if not isinstance(config,dict) or set(config) != {'version','sessionId','incarnation','secret','command','launchDigest','homeDigest','startup'}: return False
    if type(config['version']) is not int or config['version'] != 1 or config['sessionId'] != sid or config['incarnation'] != inc or not isinstance(config['secret'],str) or not re.fullmatch(r'[a-f0-9]{64}',config['secret']): return False
    if not isinstance(config['command'],str) or not 0<len(config['command'].encode())<=65536 or hashlib.sha256(config['command'].encode()).hexdigest()!=config['launchDigest'] or not isinstance(config['homeDigest'],str) or not re.fullmatch(r'[a-f0-9]{64}',config['homeDigest']): return False
    startup=config['startup']
    if not isinstance(startup,dict) or set(startup)!={'monotonicDeadline','nonce','privateFiles','privatePaths','missingPaths','issuer'} or not isinstance(startup['nonce'],str) or not UUID.fullmatch(startup['nonce']): return False
    if startup['monotonicDeadline'] is not None and (type(startup['monotonicDeadline']) is not int or startup['monotonicDeadline']<=0): return False
    if not files_valid(startup['privateFiles']) or not paths_valid(startup['privatePaths']) or not isinstance(startup['missingPaths'],list) or len(startup['missingPaths'])>64 or any(not canonical(p) for p in startup['missingPaths']) or not issuer_valid(startup['issuer']): return False
    if not isinstance(state,dict) or set(state)!={'version','sessionId','incarnation','pid','childPid','brokerStart','childStart','tainted','rawGeneration','launchDigest','homeDigest','closed','exitStatus','exitSignal','counters','receipts','startup'}: return False
    if type(state['version']) is not int or state['version']!=1 or state['sessionId']!=sid or state['incarnation']!=inc or state['launchDigest']!=config['launchDigest'] or state['homeDigest']!=config['homeDigest'] or state['closed'] is not True or state['tainted'] is not False or type(state['rawGeneration']) is not int or state['rawGeneration']!=0: return False
    if not isinstance(state['startup'],dict) or set(state['startup'])!={'nonce','status'} or state['startup']['nonce']!=startup['nonce']: return False
    if type(state['childPid']) is not int or state['childPid']<0: return False
    if state['childPid']>0:
        if state['startup']['status']!='started' or not native_absent(state['childPid'],state['childStart']): return False
        status,signal=state['exitStatus'],state['exitSignal']
        if (status is None)==(signal is None): return False
        if status is not None and (type(status) is not int or not 0<=status<=255): return False
        if signal is not None and (type(signal) is not int or signal not in {int(s) for s in __import__('signal').valid_signals()}): return False
    elif state['startup']['status']!='not-sent' or state['childStart'] is not None or state['exitStatus'] is not None or state['exitSignal'] is not None: return False
    if not native_absent(state['pid'],state['brokerStart']): return False
    counters=state['counters']; receipts=state['receipts']
    if not isinstance(counters,dict) or set(counters)!=set(CHANNELS) or any(type(counters[c]) is not int or not 0<=counters[c]<=9007199254740991 for c in CHANNELS): return False
    if not isinstance(receipts,list) or len(receipts)>128: return False
    seen=set(); heads={}
    for receipt in receipts:
        if not isinstance(receipt,dict) or set(receipt)!={'channel','counter','nonce','conversationId','hash','status'}: return False
        channel=receipt['channel']; count=receipt['counter']
        if channel not in CHANNELS or type(count) is not int or not 0<count<=counters[channel] or (channel,count) in seen or receipt['status'] not in ('sent','not-sent'): return False
        if not isinstance(receipt['nonce'],str) or not UUID.fullmatch(receipt['nonce']) or not isinstance(receipt['conversationId'],str) or (channel=='auto' and not UUID.fullmatch(receipt['conversationId'])) or not isinstance(receipt['hash'],str) or not re.fullmatch(r'[a-f0-9]{64}',receipt['hash']): return False
        seen.add((channel,count)); heads[channel]=max(heads.get(channel,0),count)
    return all(heads[c]==counters[c] if c in heads else counters[c]==0 or len(receipts)==128 for c in CHANNELS)

def identity(value):
    return isinstance(value,str) and re.fullmatch(r'[\w-]{1,100}',value,re.ASCII)

def nonnegative(value):
    return type(value) in (int,float) and math.isfinite(value) and value>=0

def bounded_text(v,maximum,minimum=0,prompt=False):
    return isinstance(v,str) and minimum<=len(v.encode('utf-16-le'))//2<=maximum and (not prompt or not re.search(r'[\x00-\x09\x0b\x0c\x0e-\x1f\x7f-\x9f]',v))

def bounded_integer(v,minimum,maximum):
    return type(v) is int and minimum<=v<=maximum

def finite_number(v):
    return type(v) in (int,float) and math.isfinite(v)

def task_criteria_valid(criteria,verified=True):
    if not isinstance(criteria,list) or len(criteria)>30 or (not verified and not criteria): return False
    for c in criteria:
        if not isinstance(c,dict): return False
        required={'id','description','kind'}|({'verified'} if verified else set())|({'command'} if c.get('kind')=='command' else set())
        if not required<=set(c)<=required|({'evidence'} if verified else set()) or not isinstance(c['id'],str) or not re.fullmatch(r'[\w-]{1,80}',c['id'],re.ASCII) or not bounded_text(c['description'],1000,1,True) or c['kind'] not in ('manual','command'): return False
        if c['kind']=='command' and not bounded_text(c['command'],1000,1,True): return False
        if verified and type(c['verified']) is not bool: return False
        if 'evidence' in c:
            e=c['evidence']
            if not isinstance(e,dict) or not {'source','at'}<=set(e)<={'source','at','commandHash'} or e['source'] not in ('owner','command') or not finite_number(e['at']) or ('commandHash' in e and not bounded_text(e['commandHash'],64)): return False
    return verified or len({c['id'] for c in criteria})==len(criteria)

def task_rows_valid(value):
    if not isinstance(value,dict) or set(value)!={'version','sessions'} or type(value['version']) is not int or value['version']!=1 or not isinstance(value['sessions'],dict) or len(value['sessions'])>200: return False
    for sid,row in value['sessions'].items():
        required={'version','objective','criteria','checkpoint','nextAction','outcome','config','continuations','phase','reason','handledEvidence','history'}
        optional={'startedAt','configuredAt','kickoffAt','lastProgressAt','conversationId','submissionKey','agentProgressVeto'}
        # Any reservation retains its evidence even when the rest of its row is valid.
        if not identity(sid) or not isinstance(row,dict) or not required<=set(row)<=required|optional or type(row['version']) is not int or row['version']!=1: return False
        if any(not bounded_text(row[k],4000,0,True) for k in ('objective','checkpoint','nextAction')) or not task_criteria_valid(row['criteria']) or row['outcome'] not in ('unknown','unfinished','blocked','completed') or row['phase'] not in ('disabled','watching','paused','blocked','completed') or not isinstance(row['reason'],str) or not re.fullmatch(r'[\w-]{1,80}',row['reason'],re.ASCII) or not bounded_integer(row['continuations'],0,10): return False
        cfg=row['config']
        if not isinstance(cfg,dict) or set(cfg)!={'enabled','maxContinuations','maxRuntimeMs'} or type(cfg['enabled']) is not bool or not bounded_integer(cfg['maxContinuations'],0,10) or not bounded_integer(cfg['maxRuntimeMs'],1000,86400000): return False
        if any(k in row and not finite_number(row[k]) for k in ('startedAt','configuredAt','kickoffAt','lastProgressAt')) or any(k in row and not bounded_text(row[k],100) for k in ('conversationId','submissionKey')) or ('agentProgressVeto' in row and type(row['agentProgressVeto']) is not bool): return False
        if not isinstance(row['handledEvidence'],list) or len(row['handledEvidence'])>32 or any(not bounded_text(v,250) for v in row['handledEvidence']): return False
        if not isinstance(row['history'],list) or len(row['history'])>100 or any(not isinstance(e,dict) or set(e)!={'at','reason'} or not finite_number(e['at']) or not bounded_text(e['reason'],80) for e in row['history']): return False
    return True

def rows_valid(name,value):
    if name in ('tasks.json','action-reservations.json'): return task_rows_valid(value)
    if name in ('state.json','state.json.bak'):
        if not isinstance(value,dict) or not isinstance(value.get('sessions'),dict): return False
        for sid,row in value['sessions'].items():
            if not identity(sid) or not isinstance(row,dict) or row.get('id')!=sid or row.get('status') not in ('idle','busy','stopped','error') or not isinstance(row.get('workingDir'),str) or not row['workingDir'] or ('pid' not in row) or (row['pid'] is not None and (type(row['pid']) is not int or row['pid']<0)) or not nonnegative(row.get('createdAt')) or not nonnegative(row.get('lastActivityAt')): return False
            if 'recovery' in row and not rows_valid('recovery.json',{'version':1,'sessions':{sid:row['recovery']}}): return False
            if 'task' in row and not task_rows_valid({'version':1,'sessions':{sid:row['task']}}): return False
        return True
    if name=='mux-sessions.json':
        if not isinstance(value,list): return False
        for row in value:
            if not isinstance(row,dict) or not identity(row.get('sessionId')) or not isinstance(row.get('muxName'),str) or not re.fullmatch(r'codeman-[\w-]+',row['muxName'],re.ASCII) or type(row.get('pid')) is not int or row['pid']<0 or not nonnegative(row.get('createdAt')) or not isinstance(row.get('workingDir'),str) or not row['workingDir'] or not isinstance(row.get('mode'),str) or not row['mode'] or type(row.get('attached')) is not bool: return False
        return True
    if name=='recovery.json':
        if not isinstance(value,dict) or set(value)!={'version','sessions'} or type(value['version']) is not int or value['version']!=1 or not isinstance(value['sessions'],dict) or len(value['sessions'])>200: return False
        for sid,row in value['sessions'].items():
            required={'version','config','activity','phase','attempts','failedAttempts','lastReason','circuitOpen','needsAttention','handledEvidence','history'}
            optional={'conversationId','windowStartedAt','nextRetryAt','lastSuccessfulRecovery','armedAt','inFlight','pending'}
            if not identity(sid) or not isinstance(row,dict) or not required<=set(row)<=required|optional or type(row['version']) is not int or row['version']!=1: return False
            if row['activity'] not in ('unknown','idle','working','watching','interrupted','completed','paused','blocked','crashed','exited') or row['phase'] not in ('idle','watching','recovering','paused','blocked','completed','failed') or row['lastReason'] not in REASONS: return False
            if any(type(row[k]) is not int or not 0<=row[k]<=10 for k in ('attempts','failedAttempts')) or any(type(row[k]) is not bool for k in ('circuitOpen','needsAttention')): return False
            if any(k in row and not nonnegative(row[k]) for k in ('windowStartedAt','nextRetryAt','lastSuccessfulRecovery','armedAt')): return False
            if 'conversationId' in row and (not isinstance(row['conversationId'],str) or not UUID.fullmatch(row['conversationId'].lower())): return False
            cfg=row['config']
            if not isinstance(cfg,dict) or set(cfg)!={'enabled','recoverInterrupted','recoverCrashes','detectStalls','maxRetries','retryDelayMs','maxRetryDelayMs','maxRecoveryDurationMs','stalledAfterMs'} or any(type(cfg[k]) is not bool for k in ('enabled','recoverInterrupted','recoverCrashes','detectStalls')): return False
            for k,minimum,maximum in [('maxRetries',1,10),('retryDelayMs',1000,300000),('maxRetryDelayMs',1000,3600000),('maxRecoveryDurationMs',10000,3600000),('stalledAfterMs',10000,3600000)]:
                if type(cfg[k]) is not int or not minimum<=cfg[k]<=maximum: return False
            if cfg['maxRetryDelayMs']<cfg['retryDelayMs']: return False
            if not isinstance(row['handledEvidence'],list) or len(row['handledEvidence'])>32 or any(not isinstance(v,str) or len(v)>250 or not re.fullmatch(r'[\w:.-]+',v,re.ASCII) for v in row['handledEvidence']): return False
            if not isinstance(row['history'],list) or len(row['history'])>100: return False
            for event in row['history']:
                if not isinstance(event,dict) or set(event)!={'at','kind','reason','attempt'} or not nonnegative(event['at']) or event['kind'] not in ('state','scheduled','continue','restart','accepted','attention','reset') or event['reason'] not in REASONS or type(event['attempt']) is not int or not 0<=event['attempt']<=10: return False
            # Reservations/pending attempts remain reference uncertainty, regardless
            # of whether the debounced main state has copied them yet.
            if 'inFlight' in row or 'pending' in row: return False
        return True
    if name in ('reboot-restore-offer.json','reboot-restore-offer.json.previous'):
        if not isinstance(value,dict) or set(value)!={'version','builtAt','entries'} or type(value['version']) is not int or value['version']!=1 or not nonnegative(value['builtAt']) or value['builtAt']>time.time()*1000 or not isinstance(value['entries'],list) or len(value['entries'])>1000 or (value['entries'] and value['builtAt']==0): return False
        for e in value['entries']:
            required={'sessionId','workingDir','mode','resumeConversationId','state'}
            if not isinstance(e,dict) or not required<=set(e)<=required|{'name','owner'} or not identity(e['sessionId']) or not isinstance(e['mode'],str) or not e['mode'] or not isinstance(e['resumeConversationId'],str) or not e['resumeConversationId'] or any(k in e and not isinstance(e[k],str) for k in ('name','owner')): return False
            if not rows_valid('state.json',{'sessions':{e['sessionId']:e['state']}}): return False
            state=e['state']
            if state.get('remote') or state.get('docker') or state.get('owner')!=e.get('owner') or state.get('workingDir')!=e['workingDir'] or state.get('mode','claude')!=e['mode']: return False
        return True
    return False

def refs_unknown(value):
    if isinstance(value,list): return any(refs_unknown(v) for v in value)
    if not isinstance(value,dict): return False
    for key,v in value.items():
        if key in ('inFlight','deliveryUncertain','codexRestoreUncertain','recoveryInputBrokerPending') and v: return True
        if re.search('inputbroker|inputevidence',key,re.I) and v=='unknown': return True
        if re.search('inputbroker',key,re.I) and v is not None and v is not False and (not isinstance(v,str) or not UUID.fullmatch(v)): return True
        if refs_unknown(v): return True
    return False

def metadata(datafd, inc):
    captured=[]
    for name, optional in [('state.json',False),('state.json.bak',True),('mux-sessions.json',False),('recovery.json',True),('tasks.json',True),('action-reservations.json',True),('reboot-restore-offer.json',True),('reboot-restore-offer.json.previous',True)]:
        try: data,sig,digest=readat(datafd,name,2097152,False)
        except FileNotFoundError:
            if not optional: raise
            captured.append((name,None,None)); continue
        value=strict_json(data.decode('utf-8','strict'))
        if not rows_valid(name,value) or refs_unknown(value) or inc in ANY_UUID.findall(json.dumps(value)): raise ValueError('referenced')
        captured.append((name,sig,digest))
    return captured

def same_metadata(datafd, captures):
    for name,sig,digest in captures:
        if sig is None:
            try: os.stat(name,dir_fd=datafd,follow_symlinks=False)
            except FileNotFoundError: continue
            return False
        else:
            _,current,hashed=readat(datafd,name,2097152,False)
            if current!=sig or hashed!=digest: return False
    return True

def retire(rootfd, datafd, sid, name, refs, data_path):
    retired=name.startswith('.retired-'); inc=name[9:] if retired else name
    if not UUID.fullmatch(inc) or inc in refs: return False
    sessionfd=os.open(sid,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=rootfd)
    fd=lock=None
    try:
        if not private(os.fstat(sessionfd),True): return False
        fd=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=sessionfd)
        inode=signature(os.fstat(fd))
        if not private(os.fstat(fd),True): return False
        names=namesat(fd)
        marker_capture=None
        allowed=set(FILES)|{'.retirement.json'}
        if any(n not in allowed for n in names) or len(names)>5: return False
        if retired or '.retirement.json' in names:
            if not retired and not set(FILES)<=set(names): return False
            raw,marker_sig,marker_hash=readat(fd,'.retirement.json',524288)
            marker_capture=(marker_sig,marker_hash)
            marker=strict_json(raw.decode('utf-8','strict'))
            if not isinstance(marker,dict) or set(marker)!={'version','config','state','hashes'} or type(marker['version']) is not int or marker['version']!=1 or not isinstance(marker['hashes'],dict) or set(marker['hashes'])!=set(FILES): return False
            config,state,hashes=marker['config'],marker['state'],marker['hashes']
            if any(not isinstance(h,str) or not re.fullmatch(r'[a-f0-9]{64}',h) for h in hashes.values()): return False
        else:
            if set(names)!=set(FILES): return False
            initial={n:readat(fd,n,262144 if n=='broker.py' else 98304) for n in FILES}
            config=strict_json(initial['config.json'][0].decode('utf-8','strict'))
            state=strict_json(initial['state.json'][0].decode('utf-8','strict'))
            hashes={n:initial[n][2] for n in FILES}
            marker={'version':1,'config':config,'state':state,'hashes':hashes}
        if not eligible(config,state,sid,inc): return False
        captures={}
        for n in names:
            if n=='.retirement.json': continue
            _,sig,digest=readat(fd,n,262144)
            if digest!=hashes[n]: return False
            captures[n]=(sig,digest)
        if 'lock' in names:
            lock=os.open('lock',os.O_RDWR|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
            if not private(os.fstat(lock)) or signature(os.fstat(lock))!=captures['lock'][0]: return False
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        elif not retired: return False
        reference_files=metadata(datafd,inc)
        print(json.dumps({'ready':sid+'/'+inc}),flush=True)
        check()
        wait=max(0,DEADLINE-time.monotonic())
        if not select.select([sys.stdin],[],[],wait)[0] or sys.stdin.readline()!='ACK\n': return False
        check()
        def current():
            # Complete every bounded file/process read before the common final
            # pathname scan. Run again after preparing/fsyncing a new marker.
            for n,(sig,digest) in captures.items():
                _,now,hashed=readat(fd,n,262144)
                if now!=sig or hashed!=digest: return False
            if not same_metadata(datafd,reference_files) or not eligible(config,state,sid,inc): return False
            if marker_capture:
                _,sig,digest=readat(fd,'.retirement.json',524288)
                if (sig,digest)!=marker_capture: return False
            if set(namesat(fd))!=set(names): return False
            for n,(sig,_) in captures.items():
                if signature(os.stat(n,dir_fd=fd,follow_symlinks=False))!=sig: return False
            for n,sig,_ in reference_files:
                try: now=signature(os.stat(n,dir_fd=datafd,follow_symlinks=False))
                except FileNotFoundError: now=None
                if now!=sig: return False
            if marker_capture and signature(os.stat('.retirement.json',dir_fd=fd,follow_symlinks=False))!=marker_capture[0]: return False
            parent=os.stat(sid,dir_fd=rootfd,follow_symlinks=False)
            if not private(parent,True) or (os.fstat(sessionfd).st_dev,os.fstat(sessionfd).st_ino)!=(parent.st_dev,parent.st_ino): return False
            top=os.stat('codex-input-brokers',dir_fd=datafd,follow_symlinks=False)
            if not private(top,True) or (os.fstat(rootfd).st_dev,os.fstat(rootfd).st_ino)!=(top.st_dev,top.st_ino): return False
            base=os.stat(data_path,follow_symlinks=False)
            if not stat.S_ISDIR(base.st_mode) or base.st_uid!=os.getuid() or base.st_mode & 0o022 or (os.fstat(datafd).st_dev,os.fstat(datafd).st_ino)!=(base.st_dev,base.st_ino): return False
            own=os.stat(name,dir_fd=sessionfd,follow_symlinks=False)
            if not private(own,True) or (own.st_dev,own.st_ino)!=inode[:2]: return False
            check()
            return True
        if not current(): return False
        if not retired:
            target='.retired-'+inc
            try: os.stat(target,dir_fd=sessionfd,follow_symlinks=False); return False
            except FileNotFoundError: pass
            if marker_capture is None:
                markerfd=os.open('.retirement.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
                try:
                    blob=json.dumps(marker,separators=(',',':')).encode()
                    if os.write(markerfd,blob)!=len(blob): raise ValueError('marker')
                    os.fsync(markerfd)
                finally: os.close(markerfd)
                os.fsync(fd)
                _,sig,digest=readat(fd,'.retirement.json',524288)
                marker_capture=(sig,digest); names.append('.retirement.json')
            if not current(): return False
            os.rename(name,target,src_dir_fd=sessionfd,dst_dir_fd=sessionfd)
            os.fsync(sessionfd)
            name=target
        if not current(): return False
        for n in FILES:
            if n in captures:
                if not current(): return False
                check()
                if signature(os.stat(n,dir_fd=fd,follow_symlinks=False))!=captures[n][0]: return False
                os.unlink(n,dir_fd=fd)
                captures.pop(n); names.remove(n)
        os.fsync(fd)
        if not current(): return False
        check()
        os.unlink('.retirement.json',dir_fd=fd)
        os.fsync(fd)
        check()
        os.rmdir(name,dir_fd=sessionfd)
        os.fsync(sessionfd)
        return True
    except (OSError,ValueError,TypeError,KeyError): return False
    finally:
        if lock is not None: os.close(lock)
        if fd is not None: os.close(fd)
        os.close(sessionfd)

def main():
    if not sys.platform.startswith('linux'): return
    request=strict_json(sys.stdin.readline(2097153))
    data=request['dataDir']; refs=request['references']
    if not isinstance(data,str) or not data.startswith('/') or os.path.normpath(data)!=data or '\x00' in data or not isinstance(refs,list) or len(refs)>32768 or any(not isinstance(v,str) or not UUID.fullmatch(v) for v in refs): return
    if os.path.realpath(data)!=data: return
    datafd=directory(data)
    rootfd=None
    try:
        rootfd=os.open('codex-input-brokers',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=datafd)
        if not private(os.fstat(rootfd),True): return
        count=0; scanned=0
        # scandir is streamed: a large/unknown tree never becomes an unbounded list.
        with os.scandir(rootfd) as sessions:
            for entry in sessions:
                check(); scanned+=1
                if scanned>512: return
                if count>=128: return
                if not UUID.fullmatch(entry.name) or not entry.is_dir(follow_symlinks=False): continue
                sfd=os.open(entry.name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=rootfd)
                try:
                    if not private(os.fstat(sfd),True): continue
                    with os.scandir(sfd) as children:
                        for child in children:
                            check(); count+=1; scanned+=1
                            if scanned>512: return
                            if count>128: return
                            if child.is_dir(follow_symlinks=False): retire(rootfd,datafd,entry.name,child.name,set(refs),data)
                finally: os.close(sfd)
    finally:
        if rootfd is not None: os.close(rootfd)
        os.close(datafd)
try: main()
except Exception: pass
`;
