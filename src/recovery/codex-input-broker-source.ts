/** @fileoverview Python's standard library owns the child PTY and journals input before forwarding it. */
export const CODEX_INPUT_BROKER_SOURCE = String.raw`
import base64, errno, fcntl, hashlib, hmac, json, os, pty, re, select, signal, sys, termios, threading, time, tty

PREFIX = b'\x1eCODEMAN_INPUT_V1:'
SUFFIX = b'\x1f'
LIMIT = 98304
FRAME_LIMIT = 196608
STREAM_LIMIT = 524288
OWNER_CHANNELS = ('owner-pty', 'owner-key', 'owner-mux')
CHANNELS = OWNER_CHANNELS + ('auto', 'probe')
LAST = None

def snapshot(path, maximum=LIMIT):
    import stat
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size > maximum:
            raise ValueError('input evidence unavailable')
        data = bytearray()
        while len(data) <= maximum:
            part = os.read(fd, min(32768, maximum + 1 - len(data)))
            if not part: break
            data.extend(part)
        after = os.fstat(fd)
        if len(data) != before.st_size or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError('input evidence changed')
    finally:
        os.close(fd)
    current = os.lstat(path)
    fields = lambda st: (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)
    if fields(before) != fields(current):
        raise ValueError('input evidence replaced')
    return fields(before) + (hashlib.sha256(data).hexdigest(),), bytes(data)

def files_current(files, own_path, paths=None, missing=None):
    if not isinstance(files, list) or len(files) > 16:
        return False
    unique = {}
    for witness in files:
        if not isinstance(witness, dict) or not isinstance(witness.get('path'), str): return False
        previous = unique.get(witness['path'])
        if previous is not None and previous != witness: return False
        unique[witness['path']] = witness
    if len(unique) > 8: return False
    captured = []
    if own_path:
        actual, _ = snapshot(own_path)
        if actual != LAST: return False
        captured.append((own_path, actual))
    for witness in unique.values():
        if (not isinstance(witness, dict) or set(witness) != {'path', 'dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'hash', 'maxBytes'} or
            not isinstance(witness['path'], str) or not os.path.isabs(witness['path']) or
            type(witness['maxBytes']) is not int or not 0 < witness['maxBytes'] <= 2097152):
            return False
        if witness['path'] == own_path:
            continue
        current, _ = snapshot(witness['path'], witness['maxBytes'])
        millis = lambda ns: (ns // 1000000000) * 1000 + (ns % 1000000000) / 1000000
        if (current[0] != witness['dev'] or current[1] != witness['ino'] or current[2] != witness['size'] or
            millis(current[3]) != witness['mtimeMs'] or millis(current[4]) != witness['ctimeMs'] or current[5] != witness['hash']):
            return False
        captured.append((witness['path'], current))
    # Close every participating FD before one common pathname scan.
    if not paths_current(paths or [], missing or []): return False
    for path, expected in captured:
        stat = os.lstat(path)
        if (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns) != expected[:5]:
            return False
    return True

def paths_current(paths, missing):
    import stat
    if not isinstance(paths, list) or len(paths) > 2048 or not isinstance(missing, list) or len(missing) > 64: return False
    millis = lambda ns: (ns // 1000000000) * 1000 + (ns % 1000000000) / 1000000
    for expected in paths:
        if (not isinstance(expected, dict) or not {'path', 'kind', 'dev', 'ino'} <= set(expected) or
            not set(expected) <= {'path', 'kind', 'dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'} or
            not isinstance(expected['path'], str) or not os.path.isabs(expected['path']) or
            expected['kind'] not in ('directory', 'file')): return False
        current = os.lstat(expected['path'])
        if (stat.S_ISLNK(current.st_mode) or
            not (stat.S_ISREG(current.st_mode) if expected['kind'] == 'file' else stat.S_ISDIR(current.st_mode)) or
            current.st_dev != expected['dev'] or current.st_ino != expected['ino'] or
            ('size' in expected and current.st_size != expected['size']) or
            ('mtimeMs' in expected and millis(current.st_mtime_ns) != expected['mtimeMs']) or
            ('ctimeMs' in expected and millis(current.st_ctime_ns) != expected['ctimeMs'])): return False
    for path in missing:
        if not isinstance(path, str) or not os.path.isabs(path): return False
        try: os.lstat(path)
        except FileNotFoundError: continue
        return False
    return True

def load(path, limit, expected_hash=None):
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    try:
        st = os.fstat(fd)
        if not stat_is_private(st) or st.st_size > limit:
            raise ValueError('private input journal unavailable')
        data = bytearray()
        while len(data) <= limit:
            part = os.read(fd, min(32768, limit + 1 - len(data)))
            if not part: break
            data.extend(part)
        after = os.fstat(fd)
        fields = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
        if len(data) != st.st_size or len(data) > limit or fields(st) != fields(after):
            raise ValueError('input journal changed')
        # Hash the very bytes parsed from this FD. A self-consistent replacement
        # command or startup grant must never replace the app's authorized config.
        if expected_hash is not None and not hmac.compare_digest(hashlib.sha256(data).hexdigest(), expected_hash):
            raise ValueError('input startup configuration changed')
        return json.loads(data)
    finally:
        os.close(fd)

def stat_is_private(st):
    import stat
    return stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and st.st_mode & 0o077 == 0

def save(path, value):
    global LAST
    data = json.dumps(value, separators=(',', ':')).encode()
    if len(data) > LIMIT:
        raise ValueError('input journal oversized')
    if LAST is not None and snapshot(path)[0] != LAST:
        raise ValueError('input journal ownership changed')
    if LAST is None and os.path.lexists(path):
        raise ValueError('input journal already exists')
    temporary = path + '.next'
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        offset = 0
        while offset < len(data):
            offset += os.write(fd, data[offset:])
        os.fsync(fd)
    finally:
        os.close(fd)
    if LAST is not None and snapshot(path)[0] != LAST:
        raise ValueError('input journal ownership changed')
    if LAST is None:
        os.link(temporary, path)
        os.unlink(temporary)
    else:
        os.replace(temporary, path)
    directory = os.open(os.path.dirname(path), os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    captured, actual = snapshot(path)
    if actual != data:
        raise ValueError('input journal changed before acknowledgement')
    LAST = captured

def process_identity(pid):
    if not sys.platform.startswith('linux'): return None
    fd = os.open('/proc/' + str(pid) + '/stat', os.O_RDONLY | getattr(os, 'O_NONBLOCK', 0))
    try:
        raw = os.read(fd, 8192).decode('ascii')
    finally:
        os.close(fd)
    fields = raw[raw.rfind(')') + 2:].split()
    if len(fields) < 20 or not fields[19].isdigit(): raise ValueError('input process identity unavailable')
    return fields[19], fields[0], int(fields[1])

def issuer_process_current(issuer):
    if issuer is None: return True
    if not sys.platform.startswith('linux'): return False
    proof = issuer['proof']
    broker_identity = process_identity(proof['brokerPid'])
    child_identity = process_identity(proof['childPid'])
    return (broker_identity[0] == proof['brokerStart'] and child_identity[0] == proof['childStart'] and
            broker_identity[1] not in ('Z', 'X', 'x', 'T', 't') and child_identity[1] not in ('Z', 'X', 'x', 'T', 't') and
            child_identity[2] == proof['brokerPid'])

def issuer_current(issuer, extra_files=None, extra_paths=None, missing=None, own_path=''):
    extra_files, extra_paths, missing = extra_files or [], extra_paths or [], missing or []
    if issuer is None: return files_current(extra_files, own_path, extra_paths, missing)
    other = load(os.path.join(issuer['directory'], 'state.json'), LIMIT)
    proof = issuer['proof']
    if (not isinstance(other, dict) or set(other) != {'version', 'sessionId', 'incarnation', 'pid', 'childPid',
            'brokerStart', 'childStart', 'tainted', 'rawGeneration', 'launchDigest', 'homeDigest', 'closed', 'exitStatus', 'exitSignal', 'counters', 'receipts', 'startup'} or
        not isinstance(proof, dict) or type(other['pid']) is not int or other['pid'] <= 0 or
        type(other['childPid']) is not int or other['childPid'] <= 0 or
        not isinstance(other['launchDigest'], str) or not re.fullmatch('[a-f0-9]{64}', other['launchDigest']) or
        not isinstance(other['homeDigest'], str) or not re.fullmatch('[a-f0-9]{64}', other['homeDigest']) or
        other['exitStatus'] is not None or other['exitSignal'] is not None or
        not isinstance(other['counters'], dict) or set(other['counters']) != set(CHANNELS) or
        any(type(n) is not int or n < 0 or n > 9007199254740991 for n in other['counters'].values()) or
        not isinstance(other['receipts'], list) or len(other['receipts']) > 128): return False
    if (type(other['version']) is not int or other['version'] != 1 or type(other['rawGeneration']) is not int or
        type(other['closed']) is not bool or type(other['tainted']) is not bool or
        not isinstance(other['startup'], dict) or set(other['startup']) != {'nonce', 'status'} or
        other['startup']['status'] != 'started' or not isinstance(other['startup']['nonce'], str) or
        not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', other['startup']['nonce']) or
        type(proof.get('rawGeneration')) is not int or not isinstance(proof.get('ownerCounters'), dict) or set(proof['ownerCounters']) != set(OWNER_CHANNELS) or
        any(type(n) is not int or n < 0 or n > 9007199254740991 for n in proof['ownerCounters'].values()) or
        not isinstance(other['brokerStart'], str) or not isinstance(other['childStart'], str) or
        other['brokerStart'] != proof.get('brokerStart') or other['childStart'] != proof.get('childStart') or
        not isinstance(proof.get('fileWitness'), dict) or proof['fileWitness'].get('path') != os.path.join(issuer['directory'], 'state.json')): return False
    seen = set()
    for receipt in other['receipts']:
        fields = {'channel', 'counter', 'nonce', 'conversationId', 'hash', 'status'}
        if (not isinstance(receipt, dict) or set(receipt) not in (fields, fields | {'deliveredAt'}) or
            receipt['channel'] not in CHANNELS or type(receipt['counter']) is not int or
            not 0 < receipt['counter'] <= other['counters'][receipt['channel']] or
            not isinstance(receipt['nonce'], str) or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', receipt['nonce']) or
            not isinstance(receipt['conversationId'], str) or
            (receipt['channel'] == 'auto' and not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', receipt['conversationId'])) or
            not isinstance(receipt['hash'], str) or not re.fullmatch('[a-f0-9]{64}', receipt['hash']) or
            receipt['status'] not in ('sent', 'not-sent') or (receipt['channel'], receipt['counter']) in seen): return False
        if 'deliveredAt' in receipt:
            at = receipt['deliveredAt']
            if (receipt['channel'] != 'auto' or receipt['status'] != 'sent' or not isinstance(at, dict) or
                set(at) != {'wallBefore', 'wallAfter', 'monoBefore', 'monoAfter'} or
                any(type(value) is not int or not 0 < value <= 9007199254740991 for value in at.values()) or
                not 0 <= at['wallAfter'] - at['wallBefore'] <= 500 or at['monoAfter'] < at['monoBefore'] or
                abs(at['wallAfter'] - at['wallBefore'] - at['monoAfter'] + at['monoBefore']) > 100): return False
        seen.add((receipt['channel'], receipt['counter']))
    for channel in CHANNELS:
        heads = [receipt['counter'] for receipt in other['receipts'] if receipt['channel'] == channel]
        if ((heads and max(heads) != other['counters'][channel]) or
            (not heads and other['counters'][channel] > 0 and len(other['receipts']) < 128)): return False
    if not files_current([proof['fileWitness']] + issuer.get('files', []) + extra_files, own_path, issuer.get('paths', []) + extra_paths, missing): return False
    if not issuer_process_current(issuer): return False
    return (other.get('version') == 1 and other.get('sessionId') == issuer['sessionId'] and
            other.get('incarnation') == issuer['incarnation'] == proof.get('incarnation') and
            other.get('pid') == proof.get('brokerPid') and other.get('childPid') == proof.get('childPid') and
            other.get('closed') is False and proof.get('closed') is False and other.get('tainted') is False and
            other.get('rawGeneration') == proof.get('rawGeneration') == 0 and
            other.get('launchDigest') == proof.get('launchDigest') and other.get('homeDigest') == proof.get('homeDigest') and
            isinstance(other.get('counters'), dict) and
            all(other['counters'].get(channel) == proof.get('ownerCounters', {}).get(channel) for channel in OWNER_CHANNELS) and
            all(receipt.get('status') != 'reserved' for receipt in other.get('receipts', [])))
def run_lease():
    directory = sys.argv[2]
    request = sys.stdin.buffer.readline(LIMIT + 1)
    if len(request) > LIMIT: raise ValueError('issuer lease oversized')
    request = json.loads(request)
    if (not isinstance(request, dict) or set(request) != {'issuer', 'durationMs', 'nonce'} or
        type(request['durationMs']) is not int or not 0 < request['durationMs'] <= 2000 or
        not isinstance(request['nonce'], str) or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', request['nonce']) or
        not isinstance(request['issuer'], dict) or request['issuer'].get('directory') != directory):
        raise ValueError('issuer lease invalid')
    deadline = time.monotonic() + request['durationMs'] / 1000
    lock = os.open(os.path.join(directory, 'lock'), os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    try:
        if not stat_is_private(os.fstat(lock)): raise ValueError('issuer lease lock unavailable')
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline: raise ValueError('issuer lease deadline')
                time.sleep(.01)
        result = []
        complete = threading.Event()
        def verify():
            try:
                issuer = request['issuer']
                result.append(issuer_current(issuer))
            except Exception: result.append(False)
            finally: complete.set()
        threading.Thread(target=verify, daemon=True).start()
        complete.wait(max(0, deadline - time.monotonic()))
        if not complete.is_set() or not result[0] or time.monotonic() >= deadline:
            raise ValueError('issuer lease unverified')
        if not issuer_process_current(request['issuer']) or time.monotonic() >= deadline:
            raise ValueError('issuer lease process changed')
        remaining = deadline - time.monotonic()
        sys.stdout.write(json.dumps({'status': 'ready', 'nonce': request['nonce'], 'wallDeadline': int(time.time() * 1000 + remaining * 1000)}) + '\n')
        sys.stdout.flush()
        # A lost remote receipt or stdin EOF never releases an issued lease.
        while time.monotonic() < deadline:
            time.sleep(min(.01, deadline - time.monotonic()))
        return 0
    finally:
        os.close(lock)

def remote_lease_scope(value, config, state, expiry, conversation, data, startup=False):
    # This is worker-HMAC authenticated data, not a request to open manager paths.
    try:
        if not sys.platform.startswith('linux') or not isinstance(value, dict) or set(value) != {'claim', 'phaseIndex', 'remoteDeadline', 'clock'}: return False
        claim, clock = value['claim'], value['clock']
        if not isinstance(claim, dict) or set(claim) != {'version', 'sessionId', 'incarnation', 'conversationId', 'action', 'fullPayloadHash', 'allowedPhaseHashes', 'native', 'managerSessionId', 'managerIncarnation', 'nonce', 'issuedAt', 'deadline'}: return False
        valid_uuid = lambda text: isinstance(text, str) and re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', text)
        integer = lambda number: type(number) is int and abs(number) <= 9007199254740991
        positive = lambda number: integer(number) and number > 0
        digest = lambda text: isinstance(text, str) and re.fullmatch(r'[a-f0-9]{64}', text)
        if (type(claim['version']) is not int or claim['version'] != 1 or
            any(not valid_uuid(claim[key]) for key in ('sessionId', 'incarnation', 'conversationId', 'managerSessionId', 'managerIncarnation', 'nonce')) or
            claim['sessionId'] != config['sessionId'] or claim['incarnation'] != config['incarnation'] or
            claim['managerSessionId'] == config['sessionId'] or not digest(claim['fullPayloadHash']) or
            not positive(claim['issuedAt']) or not positive(claim['deadline']) or not 0 < claim['deadline'] - claim['issuedAt'] <= 2000): return False
        if (not isinstance(clock, dict) or set(clock) != {'localAt', 'min', 'max'} or
            not positive(clock['localAt']) or not integer(clock['min']) or not integer(clock['max']) or
            not 0 <= clock['max'] - clock['min'] <= 1000 or
            not claim['issuedAt'] - 2000 <= clock['localAt'] <= claim['deadline'] or
            not positive(value['remoteDeadline']) or value['remoteDeadline'] != claim['deadline'] + clock['min'] or
            not positive(expiry)): return False
        wall, mono = int(time.time() * 1000), int(time.monotonic() * 1000)
        if (not clock['localAt'] + clock['min'] <= wall <= clock['localAt'] + clock['max'] + 2000 or
            not 0 < value['remoteDeadline'] - wall <= 2000 or not 0 < expiry - mono <= 2000 or
            abs(value['remoteDeadline'] - wall - expiry + mono) > 100): return False
        phases, phase = claim['allowedPhaseHashes'], value['phaseIndex']
        if not isinstance(phases, list) or not 1 <= len(phases) <= 9 or any(not digest(item) for item in phases) or type(phase) is not int or not 0 <= phase < len(phases): return False
        if phases[phase] != hashlib.sha256(data).hexdigest(): return False
        native = claim['native']
        identifier = lambda text, prefix: (isinstance(text, str) and len(text) <= 17 and
            re.fullmatch(re.escape(prefix) + r'(?:0|[1-9]\d*)', text) and int(text[1:]) <= 9007199254740991)
        if not isinstance(native, dict) or not identifier(native.get('paneId'), '%'): return False
        if startup:
            return (claim['action'] in ('restart', 'restore') and phase == 0 and len(phases) == 1 and
                    claim['fullPayloadHash'] == config['launchDigest'] == phases[0] and
                    set(native) == {'kind', 'muxSessionId', 'paneId', 'panePid', 'serverPid'} and native['kind'] == 'startup' and
                    identifier(native['muxSessionId'], '$') and
                    positive(native['panePid']) and positive(native['serverPid']))
        birth = lambda token: isinstance(token, str) and re.fullmatch(r'[1-9]\d*', token) and positive(int(token))
        return (claim['action'] == 'input' and claim['conversationId'] == conversation and
                set(native) == {'kind', 'paneId', 'brokerPid', 'childPid', 'brokerStart', 'childStart'} and native['kind'] == 'input' and
                positive(native['brokerPid']) and positive(native['childPid']) and birth(native['brokerStart']) and birth(native['childStart']) and
                native['brokerPid'] == state['pid'] == os.getpid() and native['childPid'] == state['childPid'] and
                native['brokerStart'] == state['brokerStart'] and native['childStart'] == state['childStart'] and
                process_identity(native['brokerPid'])[0] == native['brokerStart'] and
                process_identity(native['childPid'])[0] == native['childStart'])
    except Exception: return False

def run():
    if len(sys.argv) != 3 or not re.fullmatch('[a-f0-9]{64}', sys.argv[2]):
        raise ValueError('input startup configuration unbound')
    directory = sys.argv[1]
    config = load(os.path.join(directory, 'config.json'), LIMIT, sys.argv[2])
    if set(config) != {'version', 'sessionId', 'incarnation', 'secret', 'command', 'launchDigest', 'homeDigest', 'startup'} or type(config['version']) is not int or config['version'] != 1:
        raise ValueError('invalid input configuration')
    if (not isinstance(config['startup'], dict) or set(config['startup']) not in ({'monotonicDeadline', 'nonce', 'privateFiles', 'privatePaths', 'missingPaths', 'issuer'}, {'monotonicDeadline', 'nonce', 'privateFiles', 'privatePaths', 'missingPaths', 'issuer', 'issuerLease'}) or
        not isinstance(config['startup']['nonce'], str) or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', config['startup']['nonce'])):
        raise ValueError('invalid input startup authority')
    if (not isinstance(config['sessionId'], str) or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', config['sessionId']) or
        not isinstance(config['incarnation'], str) or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', config['incarnation']) or
        not isinstance(config['secret'], str) or not re.fullmatch('[a-f0-9]{64}', config['secret'])):
        raise ValueError('invalid input configuration')
    secret = bytes.fromhex(config['secret'])
    if len(secret) != 32 or not isinstance(config['command'], str):
        raise ValueError('invalid input configuration')
    if (hashlib.sha256(config['command'].encode()).hexdigest() != config['launchDigest'] or
        hashlib.sha256(os.environ.get('CODEX_HOME', '').encode()).hexdigest() != config['homeDigest']):
        raise ValueError('input launch scope changed')
    path = os.path.join(directory, 'state.json')
    # A broker process is a single launch incarnation. An existing journal is
    # never reset, even if its previous child or receipt is uncertain.
    if os.path.lexists(path):
        raise ValueError('input incarnation already launched')
    state = {'version': 1, 'sessionId': config['sessionId'], 'incarnation': config['incarnation'],
             'pid': os.getpid(), 'childPid': 0, 'brokerStart': process_identity(os.getpid())[0] if sys.platform.startswith('linux') else None, 'childStart': None, 'tainted': False, 'rawGeneration': 0,
             'launchDigest': config['launchDigest'], 'homeDigest': config['homeDigest'],
             'closed': False, 'exitStatus': None, 'exitSignal': None,
             'counters': dict((channel, 0) for channel in CHANNELS), 'receipts': [],
             'startup': {'nonce': config['startup']['nonce'], 'status': 'reserved'}}
    remote_leases = {}
    save(path, state)
    child, master = 0, -1
    original = termios.tcgetattr(0) if os.isatty(0) else None
    if original is not None:
        tty.setraw(0, termios.TCSANOW)
    def resize(_signal=None, _frame=None):
        if master < 0: return
        try:
            size = fcntl.ioctl(0, termios.TIOCGWINSZ, b'\0' * 8)
            fcntl.ioctl(master, termios.TIOCSWINSZ, size)
        except OSError:
            pass
    signal.signal(signal.SIGWINCH, resize)
    resize()
    pending = bytearray()
    deadline = None
    writable = True
    journal_failed = False
    io_jobs = []
    cleanup_jobs = []
    stdin_open = True
    output_open = True
    output_pending = bytearray()
    output_limit = 1048576
    child_status = None
    lock_depth = 0
    master_open = True
    os.set_blocking(1, False)
    def poll_child():
        nonlocal child_status, writable
        if child > 0 and child_status is None:
            found, status = os.waitpid(child, os.WNOHANG)
            if found:
                child_status = status
                state['closed'] = True
                state['exitStatus'] = os.WEXITSTATUS(status) if os.WIFEXITED(status) else None
                state['exitSignal'] = os.WTERMSIG(status) if os.WIFSIGNALED(status) else None
                handles = []
                try:
                    if not journal_failed:
                        if not lock_depth: handles = acquire()
                        persist()
                except Exception:
                    writable = False
                finally:
                    release(handles)
        return child_status is None
    def child_ready():
        return poll_child() and (not sys.platform.startswith('linux') or process_identity(child)[1] not in ('Z', 'X', 'x', 'T', 't'))
    def drain_output(ready):
        nonlocal output_open, master_open
        if master in ready and master_open:
            try:
                output = os.read(master, min(32768, output_limit - len(output_pending)))
                if not output: master_open = False
                elif output_open: output_pending.extend(output)
            except BlockingIOError:
                pass
            except OSError as error:
                if error.errno == errno.EIO: master_open = False
                else: raise
        if 1 in ready and output_pending:
            try:
                count = os.write(1, output_pending)
                del output_pending[:count]
            except BlockingIOError:
                pass
            except OSError as error:
                if error.errno != errno.EPIPE: raise
                output_open = False
                output_pending.clear()
    def output_sources():
        reads = [master] if master_open and len(output_pending) < output_limit else []
        writes = [1] if output_open and output_pending else []
        return reads, writes
    def bounded_io(operation, end=None, dispose=None):
        if end is None: end = time.monotonic() + 2
        io_jobs[:] = [job for job in io_jobs if not job.is_set()]
        if len(io_jobs) >= 2 or time.monotonic() >= end:
            raise ValueError('input evidence reader occupied')
        finished = threading.Event()
        ready = threading.Event()
        claim = threading.Event()
        result = []
        claimed = False
        def work():
            try: result.append((True, operation()))
            except Exception as error: result.append((False, error))
            ready.set()
            claim.wait()
            try:
                if not claimed and result[0][0] and dispose is not None: dispose(result[0][1])
            finally: finished.set()
        io_jobs.append(finished)
        threading.Thread(target=work, daemon=True).start()
        try:
            while not ready.is_set():
                if time.monotonic() >= end: raise ValueError('input evidence deadline')
                if master < 0 or not master_open: ready.wait(.01)
                else:
                    reads, writes = output_sources()
                    output, ready_writes, _ = select.select(reads, writes, [], .01)
                    drain_output(output + ready_writes)
            if time.monotonic() >= end: raise ValueError('input evidence deadline')
            claimed = True
            # The operation is finished; the remaining claim handshake has no
            # IO and cannot occupy another reader slot while its thread wakes.
            finished.set()
            if not result[0][0]: raise result[0][1]
            return result[0][1]
        finally:
            # An unclaimed late/overshot FD result is closed in its retained
            # job, never handed to a caller after the original deadline.
            claim.set()
    def persist():
        nonlocal writable, deadline, journal_failed
        if journal_failed: return False
        try:
            captured = json.loads(json.dumps(state))
            bounded_io(lambda: save(path, captured))
            return True
        except Exception:
            # Keep the live child and its output. Stop consuming input rather
            # than forward bytes whose taint or reservation is not durable.
            writable = False
            journal_failed = True
            deadline = None
            return False
    def forward(data, end=None, validate=None, native=None):
        offset = 0
        first = None
        last = None
        while offset < len(data):
            if end is not None and time.monotonic() >= end:
                raise OSError('input delivery deadline')
            if not poll_child():
                raise OSError('owned input child exited')
            reads, writes = output_sources()
            ready, writable_fds, _ = select.select(reads, writes + [master], [], .05)
            drain_output(ready + writable_fds)
            if master in writable_fds:
                if validate is not None and not bounded_io(validate, end):
                    raise OSError('input authority changed during delivery')
                if native is not None and not native(): raise OSError('input issuer exited')
                if end is not None and time.monotonic() >= end: raise OSError('input delivery deadline')
                if not (child_ready() if end is not None else poll_child()): raise OSError('owned input child unavailable')
                if end is not None and time.monotonic() >= end: raise OSError('input delivery deadline')
                try:
                    before = (int(time.time() * 1000), int(time.monotonic() * 1000))
                    count = os.write(master, data[offset:offset + 32768])
                    if count:
                        first = first or before
                        last = (int(time.time() * 1000), int(time.monotonic() * 1000))
                        offset += count
                except BlockingIOError:
                    pass
        return {'wallBefore': first[0], 'wallAfter': last[0], 'monoBefore': first[1], 'monoAfter': last[1]} if first else None
    def close_handles(handles):
        nonlocal writable, journal_failed
        if not handles: return
        cleanup_jobs[:] = [job for job in cleanup_jobs if not job.is_set()]
        if len(cleanup_jobs) >= 2:
            raise ValueError('input cleanup occupied')
        finished = threading.Event()
        cleanup_jobs.append(finished)
        failures = []
        def close():
            try:
                for fd in reversed(handles):
                    try: os.close(fd)
                    except OSError: failures.append(True)
            finally: finished.set()
        threading.Thread(target=close, daemon=True).start()
        end = time.monotonic() + 2
        while not finished.is_set():
            if time.monotonic() >= end:
                writable = False
                journal_failed = True
                return
            if master < 0 or not master_open: finished.wait(.01)
            else:
                reads, writes = output_sources()
                output, ready_writes, _ = select.select(reads, writes, [], .01)
                drain_output(output + ready_writes)
        if failures:
            writable = False
            journal_failed = True
    def acquire(issuer=None, end=None):
        nonlocal lock_depth
        paths = [os.path.join(directory, 'lock')]
        if issuer is not None:
            if (not isinstance(issuer, dict) or set(issuer) not in ({'sessionId', 'incarnation', 'directory', 'proof'}, {'sessionId', 'incarnation', 'directory', 'proof', 'files'}, {'sessionId', 'incarnation', 'directory', 'proof', 'paths'}, {'sessionId', 'incarnation', 'directory', 'proof', 'files', 'paths'}) or
                issuer['sessionId'] == config['sessionId'] or not isinstance(issuer['directory'], str) or
                not os.path.isabs(issuer['directory']) or issuer['directory'] == directory):
                raise ValueError('invalid input issuer')
            paths.append(os.path.join(issuer['directory'], 'lock'))
        handles = []
        end = min(time.monotonic() + 2, end) if end is not None else time.monotonic() + 2
        try:
            for lock_path in sorted(set(paths)):
                def open_lock():
                    fd = os.open(lock_path, os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
                    try:
                        if not stat_is_private(os.fstat(fd)): raise ValueError('input lock unavailable')
                        while True:
                            try:
                                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                                return fd
                            except BlockingIOError:
                                if time.monotonic() >= end: raise ValueError('input lock deadline')
                                time.sleep(.01)
                    except Exception:
                        os.close(fd)
                        raise
                handles.append(bounded_io(open_lock, end, os.close))
            lock_depth += 1
            return handles
        except Exception:
            close_handles(handles)
            raise
    def release(handles):
        nonlocal lock_depth
        if handles: lock_depth -= 1
        close_handles(handles)
    def ordinary(data):
        nonlocal writable, deadline
        if not data:
            return True
        handles = []
        try:
            handles = acquire()
            state['tainted'] = True
            state['rawGeneration'] += 1
            if not persist():
                return False
            forward(data)
            return True
        except Exception:
            writable = False
            deadline = None
            return False
        finally:
            release(handles)
    def framed(encoded, signature, validate_only=False, force_refusal=False):
        nonlocal writable
        try:
            if not hmac.compare_digest(hmac.new(secret, encoded, hashlib.sha256).hexdigest().encode(), signature):
                return False
            packet = json.loads(base64.b64decode(encoded, validate=True))
            fields = {'version', 'sessionId', 'incarnation', 'channel', 'counter', 'nonce', 'conversationId', 'expectedOwners', 'monotonicDeadline', 'issuer', 'privateFiles', 'privatePaths', 'missingPaths', 'data'}
            if set(packet) not in (fields, fields | {'issuerLease'}):
                return False
            channel = packet['channel']
            counter = packet['counter']
            if (type(packet['version']) is not int or packet['version'] != 1 or packet['sessionId'] != config['sessionId'] or
                packet['incarnation'] != config['incarnation'] or channel not in CHANNELS or
                type(counter) is not int or counter <= 0 or counter > 9007199254740991 or
                not isinstance(packet['nonce'], str) or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', packet['nonce']) or
                not isinstance(packet['conversationId'], str) or
                (channel == 'auto' and not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', packet['conversationId']))):
                return False
            data = base64.b64decode(packet['data'], validate=True)
            owners = packet['expectedOwners']
            if channel == 'auto':
                if (not isinstance(owners, dict) or set(owners) != set(OWNER_CHANNELS) or
                    any(type(n) is not int or n < 0 or n > 9007199254740991 for n in owners.values())):
                    return False
            elif owners is not None:
                return False
            if channel != 'auto' and (packet['issuer'] is not None or packet['privateFiles'] or packet['privatePaths'] or packet['missingPaths']):
                return False
            if 'issuerLease' in packet and (channel != 'auto' or packet['issuer'] is not None or not isinstance(packet['issuerLease'], dict)): return False
            if channel == 'probe' and (data or packet['conversationId']): return False
            expiry = packet['monotonicDeadline']
            if channel in ('auto', 'probe'):
                if type(expiry) is not int or expiry <= 0: return False
            elif expiry is not None: return False
            if len(data) > 65536:
                return False
        except Exception:
            return False
        if validate_only:
            return True
        # An authenticated duplicate is consumed but can never duplicate bytes.
        if counter <= state['counters'][channel]:
            return True
        handles = []
        deadline = min(time.monotonic() + 2, packet['monotonicDeadline'] / 1000) if channel in ('auto', 'probe') else time.monotonic() + 2
        try:
            expired = channel in ('auto', 'probe') and time.monotonic() >= deadline
            handles = acquire(None if expired else packet['issuer'], None if expired else deadline)
            return deliver_packet(packet, data, owners, deadline, force_refusal or expired)
        except Exception:
            writable = False
            return True
        finally:
            release(handles)
    def deliver_packet(packet, data, owners, deadline, force_refusal):
        nonlocal writable
        live_child = child_ready() if packet['channel'] in ('auto', 'probe') else poll_child()
        channel = packet['channel']
        counter = packet['counter']
        lease = packet.get('issuerLease')
        lease_key = None
        def lease_current():
            nonlocal lease_key
            if lease is None: return True
            if not remote_lease_scope(lease, config, state, packet['monotonicDeadline'], packet['conversationId'], data): return False
            for nonce, item in list(remote_leases.items()):
                if item['expires'] <= time.monotonic() * 1000: del remote_leases[nonce]
            claim = lease['claim']
            lease_key = json.dumps([claim, lease['remoteDeadline'], lease['clock'], packet['monotonicDeadline']], sort_keys=True)
            item = remote_leases.get(claim['nonce'])
            if item is None:
                if lease['phaseIndex'] != 0 or len(remote_leases) >= 32: return False
                item = {'key': lease_key, 'next': 0, 'digest': hashlib.sha256(), 'bytes': 0, 'expires': packet['monotonicDeadline']}
            if item['key'] != lease_key or item['next'] != lease['phaseIndex']: return False
            if lease['phaseIndex'] == len(claim['allowedPhaseHashes']) - 1:
                return data == b'\r' and item['digest'].hexdigest() == claim['fullPayloadHash']
            return item['bytes'] + len(data) <= 65536
        receipt = {'channel': channel, 'counter': counter, 'nonce': packet['nonce'],
                   'conversationId': packet['conversationId'], 'hash': hashlib.sha256(data).hexdigest(),
                   'status': 'not-sent' if channel in ('auto', 'probe') and
                   (time.monotonic() >= deadline or force_refusal or not live_child or state['tainted'] or not lease_current() or (channel == 'auto' and any(state['counters'][name] != owners[name] for name in OWNER_CHANNELS))) else 'reserved'}
        state['counters'][channel] = counter
        state['receipts'] = (state['receipts'] + [receipt])[-128:]
        if not persist():
            return True
        if receipt['status'] == 'not-sent':
            return True
        if channel == 'auto':
            try:
                accepted = bounded_io(lambda: issuer_current(packet['issuer'], packet['privateFiles'], packet['privatePaths'], packet['missingPaths'], path), deadline) and lease_current()
            except Exception:
                accepted = False
            if not accepted:
                receipt['status'] = 'not-sent'
                persist()
                return True
        try:
            validator = (lambda: issuer_current(packet['issuer'], packet['privateFiles'], packet['privatePaths'], packet['missingPaths'], path)) if channel == 'auto' else None
            delivery = forward(data, deadline if channel == 'auto' else None, validator, (lambda: issuer_process_current(packet['issuer']) and lease_current()) if channel == 'auto' else None) if channel != 'probe' else None
            if channel == 'auto' and data == b'\r':
                if (not delivery or not 0 <= delivery['wallAfter'] - delivery['wallBefore'] <= 500 or
                    abs(delivery['wallAfter'] - delivery['wallBefore'] - delivery['monoAfter'] + delivery['monoBefore']) > 100): raise ValueError('input clock changed')
                receipt['deliveredAt'] = delivery
            if lease is not None:
                claim = lease['claim']
                item = remote_leases.setdefault(claim['nonce'], {'key': lease_key, 'next': 0, 'digest': hashlib.sha256(), 'bytes': 0, 'expires': packet['monotonicDeadline']})
                if lease['phaseIndex'] == len(claim['allowedPhaseHashes']) - 1:
                    if (not delivery or not 0 <= delivery['wallAfter'] - delivery['wallBefore'] <= 500 or
                        abs(delivery['wallAfter'] - delivery['wallBefore'] - delivery['monoAfter'] + delivery['monoBefore']) > 100): raise ValueError('input clock changed')
                    receipt['deliveredAt'] = delivery
                else:
                    item['digest'].update(data)
                    item['bytes'] += len(data)
                item['next'] += 1
        except Exception:
            # Reserved is the durable unknown receipt after any possible byte.
            writable = False
            return True
        receipt['status'] = 'sent'
        persist()
        return True
    def reject_control():
        nonlocal writable, deadline
        handles = []
        try:
            handles = acquire()
            state['tainted'] = True
            state['rawGeneration'] += 1
            persist()
        except Exception:
            pass
        finally:
            release(handles)
            writable = False
            deadline = None
        # Encoded control material is never ordinary child input, including
        # partial authenticated frames whose completion cannot be established.
        pending.clear()
    def collect_frame(start, depth=0):
        if depth >= 8: return None
        position = start
        nested = []
        for index, expected in enumerate(PREFIX):
            while True:
                if position >= len(pending): return None
                if pending[position] == expected:
                    position += 1
                    break
                if index and pending[position:position + len(PREFIX)] == PREFIX:
                    child_frame = collect_frame(position, depth + 1)
                    if child_frame is None: return None
                    nodes, position = child_frame
                    nested.extend(nodes)
                    if len(nested) >= 8: return None
                    continue
                return None
        body = bytearray()
        while True:
            finish = pending.find(SUFFIX, position)
            begin = pending.find(PREFIX, position)
            if finish < 0: return None
            if begin >= 0 and begin < finish:
                body.extend(pending[position:begin])
                child_frame = collect_frame(begin, depth + 1)
                if child_frame is None: return None
                nodes, position = child_frame
                nested.extend(nodes)
                if len(nested) >= 8: return None
            else:
                body.extend(pending[position:finish])
                return [PREFIX + bytes(body) + SUFFIX] + nested, finish + 1
    def consume(expired=False):
        nonlocal deadline, writable
        while pending and writable:
            if expired and PREFIX.startswith(bytes(pending)):
                reject_control()
                return
            interrupted_prefix = False
            if not pending.startswith(PREFIX):
                for count in range(1, min(len(PREFIX), len(pending))):
                    if pending[:count] == PREFIX[:count] and pending[count] == PREFIX[0]:
                        interrupted_prefix = True
                        break
            if not pending.startswith(PREFIX) and not interrupted_prefix:
                position = pending.find(PREFIX)
                if position < 0:
                    keep = 0
                    if not expired:
                        for n in range(1, min(len(pending), len(PREFIX)) + 1):
                            if pending[-n:] == PREFIX[:n]:
                                keep = n
                    count = len(pending) - keep
                else:
                    count = position
                if count:
                    data = bytes(pending[:count])
                    if not ordinary(data):
                        return
                    del pending[:count]
                    continue
                if expired:
                    if ordinary(bytes(pending)):
                        pending.clear()
                    break
                deadline = deadline or time.monotonic() + 1
                break
            parsed = collect_frame(0)
            if parsed is None:
                if expired or len(pending) >= STREAM_LIMIT:
                    reject_control()
                    return
                deadline = deadline or time.monotonic() + 1
                break
            frames, end = parsed
            if len(frames) > 8 or any(len(frame) > FRAME_LIMIT for frame in frames):
                reject_control()
                return
            else:
                pieces = [frame[len(PREFIX):-1].split(b':') for frame in frames]
                verified = [len(parts) == 2 and len(parts[1]) == 64 and framed(*parts, validate_only=True) for parts in pieces]
                if not all(verified):
                    # Stop before any child byte; a forged inner frame cannot
                    # turn private outer control encoding into model input.
                    reject_control()
                    return
                owner_pending = any(json.loads(base64.b64decode(parts[0]))['channel'] in OWNER_CHANNELS for parts in pieces)
                for parts in pieces:
                    framed(*parts, force_refusal=owner_pending)
            del pending[:end]
            deadline = None
        if not pending:
            deadline = None
    startup_locks = []
    startup_expiry = config['startup']['monotonicDeadline']
    startup_lease = config['startup'].get('issuerLease')
    if startup_expiry is not None and (type(startup_expiry) is not int or startup_expiry <= 0): raise ValueError('invalid input startup deadline')
    startup_deadline = min(time.monotonic() + 2, startup_expiry / 1000) if startup_expiry is not None else time.monotonic() + 2
    try:
        if 'issuerLease' in config['startup'] and config['startup']['issuer'] is not None: raise ValueError('remote input issuer must not contain local paths')
        startup_locks = acquire(config['startup']['issuer'], startup_deadline)
        accepted = bounded_io(lambda: issuer_current(config['startup']['issuer'], config['startup']['privateFiles'], config['startup']['privatePaths'], config['startup']['missingPaths'], path), startup_deadline)
        remote_startup_current = lambda: ('issuerLease' not in config['startup'] or (config['startup']['issuer'] is None and remote_lease_scope(startup_lease, config, state, startup_expiry, startup_lease.get('claim', {}).get('conversationId') if isinstance(startup_lease, dict) else None, config['command'].encode('utf-8'), True)))
        if not accepted or not issuer_process_current(config['startup']['issuer']) or not remote_startup_current() or time.monotonic() >= startup_deadline:
            state['startup']['status'] = 'not-sent'
            state['closed'] = True
            persist()
            if original is not None: termios.tcsetattr(0, termios.TCSANOW, original)
            return 1
        child, master = pty.fork()
        if child == 0:
            try:
                tty.setraw(0, termios.TCSANOW)
                os.execl('/bin/bash', 'bash', '-c', config['command'])
            except Exception:
                os._exit(127)
        tty.setraw(master, termios.TCSANOW)
        os.set_blocking(master, False)
        state['childPid'] = child
        state['childStart'] = process_identity(child)[0] if sys.platform.startswith('linux') else None
        state['startup']['status'] = 'started'
        persist()
        resize()
    except Exception:
        if child == 0:
            state['startup']['status'] = 'not-sent'
            state['closed'] = True
            persist()
            if original is not None: termios.tcsetattr(0, termios.TCSANOW, original)
            return 1
        writable = False
    finally:
        release(startup_locks)
    try:
        while master_open or output_pending:
            poll_child()
            timeout = min(.05, max(0, deadline - time.monotonic())) if deadline is not None else .05
            sources, destinations = output_sources()
            if stdin_open and writable: sources.append(0)
            ready, ready_writes, _ = select.select(sources, destinations, [], timeout)
            drain_output(ready + ready_writes)
            if deadline is not None and time.monotonic() >= deadline:
                consume(True)
            if 0 in ready:
                data = os.read(0, 32768)
                if not data:
                    stdin_open = False
                    consume(True)
                    # Retain child output after transport EOF. Never kill or
                    # replace the existing child to resolve missing input.
                else:
                    pending.extend(data)
                    consume()
    finally:
        if original is not None:
            termios.tcsetattr(0, termios.TCSANOW, original)
        os.close(master)
    if child_status is None:
        _, child_status = os.waitpid(child, 0)
    status = child_status
    state['closed'] = True
    state['exitStatus'] = os.WEXITSTATUS(status) if os.WIFEXITED(status) else None
    state['exitSignal'] = os.WTERMSIG(status) if os.WIFSIGNALED(status) else None
    handles = []
    try:
        if not journal_failed:
            handles = acquire()
            persist()
    except Exception:
        pass
    finally:
        release(handles)
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return 1

if __name__ == '__main__':
    try:
        sys.exit(run_lease() if len(sys.argv) > 1 and sys.argv[1] == '--lease' else run())
    except Exception:
        # Configuration and durability failures never start a fresh fallback.
        sys.stderr.write('Codeman input reliability guard unavailable.\n')
        sys.exit(1)
`;
