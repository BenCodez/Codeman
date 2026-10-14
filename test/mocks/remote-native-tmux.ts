/** Evaluate the generated tmux format/command grammar before delegating any fake worker effect. */
export function guardedNativeTmuxFixture(delegate: string): string {
  const path = JSON.stringify(delegate);
  return String.raw`#!/usr/bin/env python3
import json, os, re, sys
args = sys.argv[1:]
assert args[:2] == ['-L', 'codeman-remote']
op = args[2]
counter = (os.environ.get('EFFECT_LOG') or os.environ.get('FIXTURE_ACTION_LOG')) + '.native-guards'
if op == 'has-session':
    try: os.unlink(counter)
    except FileNotFoundError: pass
if op == 'if-shell':
    assert len(args) == 9 and args[3:5] == ['-F', '-t']
    assert args[8] == 'display-message -p CODEMAN_REMOTE_PANE_REFUSED'
    terms = re.findall(r'#\{==:#\{([a-z_]+)\},([^{}]*)\}', args[6])
    assert len(terms) in (6, 8)
    expression = '#{==:#{' + terms[0][0] + '},' + terms[0][1] + '}'
    for key, value in terms[1:]:
        expression = '#{&&:' + expression + ',#{==:#{' + key + '},' + value + '}}'
    assert expression == args[6]
    if args[5] == '%9':
        state = {'session_name': 'codeman-ssh-aaaaaaaa', 'session_id': '$17', 'pane_id': '%9',
                 'pane_pid': '9009', 'pane_dead': '1', 'pane_dead_status': '1', 'pane_dead_signal': '', 'pid': '17000'}
        if os.environ.get('FIXTURE_LIVE_BEFORE_RESPAWN'): state['pane_dead'] = '0'
    else:
        row = os.environ.get('PANE_ROW')
        pane_file = os.environ.get('FIXTURE_PANE_FILE')
        if pane_file:
            with open(pane_file) as f: row = f.read().rstrip('\n')
        if not row:
            pid = os.environ.get('FIXTURE_PANE_PID', '4242')
            row = ('1|1||%7|' if os.environ.get('KIND') == 'restart' else '0|||%7|') + pid
        fields = row.split('|')
        assert len(fields) == 5
        state = dict(zip(['pane_dead', 'pane_dead_status', 'pane_dead_signal', 'pane_id', 'pane_pid'], fields))
        state['session_name'] = 'codeman-ssh-aaaaaaaa'
    try:
        with open(counter) as f: count = int(f.read())
    except FileNotFoundError: count = 0
    change = os.environ.get('NATIVE_BEFORE_EFFECT', '')
    if change == 'pid' or (change == 'pid-after-input' and count): state['pane_pid'] = str(int(state['pane_pid']) + 1)
    if change == 'pane-id': state['pane_id'] = '%8'
    if change == 'signal-alias': state['pane_dead_signal'] = 'KILL'
    if change == 'dead': state['pane_dead'] = '0' if state['pane_dead'] == '1' else '1'
    if change == 'status': state['pane_dead_status'] = '2'
    if change == 'signal': state['pane_dead_signal'] = 'TERM'
    if change == 'session': state['session_name'] = 'codeman-ssh-foreign'
    if change == 'session-id': state['session_id'] = '$18'
    if change == 'server': state['pid'] = '17001'
    if args[5] != state['pane_id'] or not all(state.get(key) == value for key, value in terms):
        print('CODEMAN_REMOTE_PANE_REFUSED')
        sys.exit(0)
    # tmux.1 PARSING SYNTAX: quoted strings cannot span raw lines. The
    # emitter uses only concatenated single-quoted segments and outside
    # backslash/octal escapes; refuse any expansion or command separator.
    text, command, token, active, i = args[7], [], '', False, 0
    assert '\n' not in text and '\r' not in text
    while i < len(text):
        char = text[i]
        if char == ' ':
            if active: command.append(token)
            token, active, i = '', False, i + 1
        elif char == "'":
            end = text.find("'", i + 1)
            assert end >= 0
            token, active, i = token + text[i + 1:end], True, end + 1
        elif char == '\\':
            i += 1
            assert i < len(text)
            if text[i] in '01234567':
                octal = text[i:i + 3]
                assert len(octal) == 3 and all(x in '01234567' for x in octal) and int(octal, 8) <= 255
                token, i = token + chr(int(octal, 8)), i + 3
            else:
                assert text[i] == "'"
                token, i = token + text[i], i + 1
            active = True
        else: raise AssertionError('Unexpected unquoted tmux syntax')
    if active: command.append(token)
    assert command[0] in ('send-keys', 'respawn-pane')
    assert command[0] != 'respawn-pane' or '-k' not in command[1:]
    if command[:2] == ['send-keys', '-l'] and not count:
        prompt_file = os.environ.get('FIXTURE_PROMPT_FILE')
        if prompt_file:
            try: os.unlink(prompt_file)
            except FileNotFoundError: pass
    command_log = os.environ.get('NATIVE_COMMAND_LOG')
    if command_log:
        with open(command_log, 'a') as f: f.write(json.dumps(command, ensure_ascii=False) + '\n')
    with open(counter, 'w') as f: f.write(str(count + 1))
    args = ['-L', 'codeman-remote'] + command
os.execv(${path}, [${path}] + args)
`;
}
