/**
 * Covers `buildPasteTextCommands()` and `pasteText()`: the text half of a text+Enter
 * submit (`sendInput`) goes in as ONE bracketed paste. Also `submitsAsKeys()`: a
 * single character is typed instead, since a selection dialog ignores a pasted `3`
 * and the Enter then confirms the highlighted option. And
 * `escapeTmuxTrailingSemicolon()`, which every literal text path runs through.
 *
 * Why: `send-keys -l` typed the text as an unmarked burst, and Codex's paste-burst
 * heuristic folded the Enter that followed 50 ms later into the paste as a newline,
 * so the prompt sat in the composer unsubmitted (always at 1500 chars, sometimes for
 * a one-line prompt). With `paste-buffer -p` the paste is marked and the separate
 * Enter submits.
 *
 * Strategy: pure command shape, plus a round trip through a real shell with a fake
 * `tmux` that prints its argv, so quoting and tmux's trailing-`;` rule are checked
 * on the bytes a shell actually hands over. `pasteText` runs against a recording
 * runner. No real tmux.
 *
 * Port: N/A (no server / no real tmux)
 */
import { execSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { MuxSession } from '../src/mux-interface.js';
import {
  TmuxManager,
  buildPasteTextCommands,
  escapeTmuxTrailingSemicolon,
  pasteText,
  submitsAsKeys,
} from '../src/tmux-manager.js';

const FAKE_TMUX = `${JSON.stringify(process.execPath)} -e 'console.log(JSON.stringify(process.argv.slice(1)))' --`;

function argvOf(cmd: string): string[] {
  return JSON.parse(execSync(cmd, { encoding: 'utf-8' })) as string[];
}

describe('buildPasteTextCommands', () => {
  it('fills a buffer, pastes it bracketed into the target and deletes it', () => {
    const { set, paste, discard } = buildPasteTextCommands('tmux -L codeman', 'codeman-abc12345', 'hello');
    const buffer = /set-buffer -b (\S+) -- /.exec(set)?.[1];
    expect(buffer).toMatch(/^codeman-submit-\d+-\d+$/);
    expect(set).toBe(`tmux -L codeman set-buffer -b ${buffer} -- 'hello'`);
    expect(paste).toBe(`tmux -L codeman paste-buffer -p -d -b ${buffer} -t 'codeman-abc12345'`);
    expect(discard).toBe(`tmux -L codeman delete-buffer -b ${buffer}`);
  });

  it('never types the text with send-keys (the unmarked burst Codex misreads)', () => {
    for (const cmd of Object.values(buildPasteTextCommands('tmux', 'codeman-abc12345', 'read your inbox'))) {
      expect(cmd).not.toContain('send-keys');
    }
  });

  it('uses a fresh buffer per call, so concurrent sends cannot paste each other', () => {
    const a = buildPasteTextCommands('tmux', 't', 'a').set;
    const b = buildPasteTextCommands('tmux', 't', 'b').set;
    expect(/-b (\S+)/.exec(a)?.[1]).not.toBe(/-b (\S+)/.exec(b)?.[1]);
  });

  it.each([
    ['quotes and shell syntax', `it's "quoted" $HOME \`id\` $(id) & | > <`],
    ['tmux format syntax', '#{session_name} #S'],
    ['leading dash', '-t other --help'],
    ['non-ASCII', 'Mailbox lesen — äöü “x”'],
    ['a long prompt', 'x'.repeat(1500)],
  ])('hands the text to tmux unchanged through the shell: %s', (_label, text) => {
    const { set } = buildPasteTextCommands(FAKE_TMUX, 't', text);
    expect(argvOf(set).at(-1)).toBe(text);
  });

  it.each([
    ['x;', 'x\\;'],
    [';', '\\;'],
    ['x;;', 'x;\\;'],
    ['x\\;', 'x\\\\;'],
  ])('escapes a trailing ";" (tmux command separator): %s', (text, expected) => {
    const { set } = buildPasteTextCommands(FAKE_TMUX, 't', text);
    expect(argvOf(set).at(-1)).toBe(expected);
  });

  it('leaves a ";" inside the text alone', () => {
    const { set } = buildPasteTextCommands(FAKE_TMUX, 't', 'a; b');
    expect(argvOf(set).at(-1)).toBe('a; b');
  });
});

describe('submitsAsKeys', () => {
  it.each(['3', '9', 'y', 'n', ';', 'ä', '👍'])('types a single character: %s', (text) => {
    expect(submitsAsKeys(text)).toBe(true);
  });

  it.each(['10', 'yes', '/cost', 'read your inbox', 'x'.repeat(1500)])('pastes anything longer: %s', (text) => {
    expect(submitsAsKeys(text)).toBe(false);
  });
});

describe('escapeTmuxTrailingSemicolon', () => {
  it.each([
    ['x;', 'x\\;'],
    [';', '\\;'],
    ['a; b', 'a; b'],
    ['plain', 'plain'],
  ])('%s -> %s', (text, expected) => {
    expect(escapeTmuxTrailingSemicolon(text)).toBe(expected);
  });
});

describe('pasteText', () => {
  const cmds = { set: 'SET', paste: 'PASTE', discard: 'DISCARD' };

  function recorder(failOn: string[] = []) {
    const ran: string[] = [];
    const run = async (cmd: string) => {
      ran.push(cmd);
      if (failOn.includes(cmd)) throw new Error(`${cmd} failed`);
    };
    return { ran, run };
  }

  it('fills the buffer, then pastes it; the paste deletes it, so nothing else runs', async () => {
    const { ran, run } = recorder();
    await pasteText(run, cmds);
    expect(ran).toEqual(['SET', 'PASTE']);
  });

  it('deletes the buffer when the paste fails, and reports the paste error', async () => {
    const { ran, run } = recorder(['PASTE']);
    await expect(pasteText(run, cmds)).rejects.toThrow('PASTE failed');
    expect(ran).toEqual(['SET', 'PASTE', 'DISCARD']);
  });

  it('still reports the paste error when the delete fails too', async () => {
    const { ran, run } = recorder(['PASTE', 'DISCARD']);
    await expect(pasteText(run, cmds)).rejects.toThrow('PASTE failed');
    expect(ran).toEqual(['SET', 'PASTE', 'DISCARD']);
  });

  it('does not paste when filling the buffer failed', async () => {
    const { ran, run } = recorder(['SET']);
    await expect(pasteText(run, cmds)).rejects.toThrow('SET failed');
    expect(ran).toEqual(['SET']);
  });
});

describe('sendInput wiring', () => {
  const managers: TmuxManager[] = [];
  afterEach(() => {
    for (const manager of managers.splice(0)) manager.destroy();
  });

  function fixture(effect?: (command: string, manager: TmuxManager, record: MuxSession) => Promise<void>) {
    const commands: string[] = [];
    const manager = new TmuxManager(async (command) => {
      commands.push(command);
      await effect?.(command, manager, record);
    });
    const id = randomUUID();
    const record: MuxSession = {
      sessionId: id,
      muxName: 'codeman-' + id.slice(0, 8),
      pid: 123,
      createdAt: Date.now(),
      workingDir: '/tmp/fake-submit-work',
      mode: 'codex',
      attached: true,
    };
    manager.registerSession(record);
    managers.push(manager);
    return { manager, record, commands };
  }

  it('submits ordinary text through bracketed paste and a separate Enter', async () => {
    const { manager, record, commands } = fixture();
    expect(await manager.sendInput(record.sessionId, 'read your inbox\r')).toBe(true);
    expect(commands).toHaveLength(3);
    expect(commands[0]).toMatch(/set-buffer -b \S+ -- 'read your inbox'$/);
    expect(commands[1]).toContain('paste-buffer -p -d -b ');
    expect(commands[2]).toContain('send-keys');
    expect(commands[2]).toMatch(/ Enter$/);
    expect(commands.slice(0, 2).some((command) => command.includes('send-keys'))).toBe(false);
  });

  it.each(['3', ';', '👍'])('types a single-character dialog answer before Enter: %s', async (text) => {
    const { manager, record, commands } = fixture();
    expect(await manager.sendInput(record.sessionId, text + '\r')).toBe(true);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain('send-keys');
    expect(commands[0]).toContain('-l ');
    expect(argvOf(commands[0].replace(/^tmux -L \S+/, FAKE_TMUX)).at(-1)).toBe(escapeTmuxTrailingSemicolon(text));
    expect(commands[1]).toMatch(/ Enter$/);
  });

  it.each([false, true])('preserves a final literal semicolon with submission=%s', async (submit) => {
    const { manager, record, commands } = fixture();
    expect(await manager.sendInput(record.sessionId, 'text;' + (submit ? '\r' : ''))).toBe(true);
    expect(argvOf(commands[0].replace(/^tmux -L \S+/, FAKE_TMUX)).at(-1)).toBe('text\\;');
    expect(commands[0]).toContain(submit ? 'set-buffer' : 'send-keys');
  });

  it('preserves an already bracketed payload without adding another paste envelope', async () => {
    const { manager, record, commands } = fixture();
    const input = '\x1b[200~already pasted owner text\x1b[201~';
    expect(await manager.sendInput(record.sessionId, input + '\r')).toBe(true);
    expect(commands).toHaveLength(2);
    expect(argvOf(commands[0].replace(/^tmux -L \S+/, FAKE_TMUX)).at(-1)).toBe(input);
    expect(commands[0]).not.toContain('paste-buffer');
    expect(commands[1]).toMatch(/ Enter$/);
  });

  it('refuses a replacement session after buffer setup and cleans only its own buffer', async () => {
    const { manager, record, commands } = fixture(async (command, active, old) => {
      if (command.includes('set-buffer')) active.registerSession({ ...old, pid: 456 });
    });
    expect(await manager.sendInput(record.sessionId, 'must remain unsent\r')).toBe(false);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain('set-buffer');
    expect(commands[1]).toContain('delete-buffer');
    expect(commands.some((command) => command.includes('paste-buffer') || command.endsWith(' Enter'))).toBe(false);
    expect(manager.getSession(record.sessionId)?.pid).toBe(456);
  });

  it('retains a failed paste verdict, discards its buffer, and never submits Enter', async () => {
    const { manager, record, commands } = fixture(async (command) => {
      if (command.includes('paste-buffer')) throw Error('uncertain paste acknowledgement');
    });
    expect(await manager.sendInput(record.sessionId, 'possible partial paste\r')).toBe(false);
    expect(commands.map((command) => / (set-buffer|paste-buffer|delete-buffer) /.exec(command)?.[1])).toEqual([
      'set-buffer',
      'paste-buffer',
      'delete-buffer',
    ]);
    expect(commands.some((command) => command.endsWith(' Enter'))).toBe(false);
  });
});
