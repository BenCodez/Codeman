/** Run the generated reader against temporary executable tmux/SSH fakes only. */
import { describe, expect, it } from 'vitest';
import { MAX_REMOTE_CODEX_PROMPT_BYTES } from '../src/recovery/remote-codex.js';
import { fixture } from './mocks/remote-reader-fixture.js';

describe('remote worker effects bind the final native pane incarnation', () => {
  it.each(['pid', 'pane-id', 'dead', 'status', 'signal', 'session'] as const)(
    'refuses restart after native %s changes at the effect boundary',
    async (beforeEffect) => {
      const result = await fixture('restart', 'none', false, { beforeEffect });
      expect(result).toMatchObject({ status: 'not-sent', effects: '', commands: [] });
    }
  );

  it('refuses a changed raw signal token even when both tokens mean SIGKILL', async () => {
    const result = await fixture('restart', 'none', false, {
      beforeEffect: 'signal-alias',
      paneRow: '1||9|%7|4242',
      expectedPane: { paneId: '%7', panePid: 4242, signal: 9 },
    });
    expect(result).toMatchObject({ status: 'not-sent', effects: '', commands: [] });
  });

  it('retains the exact raw native token when empty and zero both decode as no signal', async () => {
    const result = await fixture('restart', 'none', false, { beforeEffect: 'no-signal-alias' });
    expect(result).toMatchObject({
      status: 'not-sent',
      identityReason: 'verified',
      nativeRefusalObserved: true,
      workerStarted: false,
      effects: '',
      commands: [],
    });
  });

  it.each(['pid', 'pane-id', 'dead', 'status', 'signal', 'session'] as const)(
    'delivers zero input bytes after native %s changes before the first paste',
    async (beforeEffect) => {
      const result = await fixture('input', 'none', false, { beforeEffect });
      expect(result).toMatchObject({ status: 'not-sent', effects: '', commands: [] });
    }
  );

  it.each(['pid', 'pane-id', 'dead', 'status', 'signal', 'session', 'session-id', 'server'] as const)(
    'does not launch Codex in a changed restore placeholder: %s',
    async (beforeEffect) => {
      const result = await fixture('restore', 'none', false, { beforeEffect });
      // This reader receives a separately provisioned inert pane. Its exact
      // native refusal certifies no child start; the public lost-ACK path remains sealed.
      expect(result).toMatchObject({ status: 'not-sent', effects: '', commands: [], workerStarted: false });
    }
  );

  it.each(['short continuation', '😀'.repeat(4096)] as const)(
    'seals a partial paste when the incarnation changes before the next effect',
    async (prompt) => {
      const result = await fixture('input', 'none', false, { beforeEffect: 'pid-after-input', prompt });
      expect(result.status).toBe('unknown');
      expect(result.commands).toHaveLength(1);
      expect(result.commands?.[0]?.slice(0, 4)).toEqual(['send-keys', '-l', '-t', '%7']);
      expect(result.commands?.[0]?.[4]).toBe(prompt === 'short continuation' ? prompt : '😀'.repeat(2048));
      expect(result.effects).not.toContain('Enter');
    }
  );

  it.each(['input', 'restart', 'restore'] as const)('allows an unchanged %s native incarnation', async (kind) => {
    const result = await fixture(kind, 'none', false, { prompt: 'owner continuation' });
    expect(result.status).toBe('sent');
    expect(result.commands?.[0]?.[0]).toBe(kind === 'input' ? 'send-keys' : 'respawn-pane');
    if (kind === 'input') expect(result.commands?.at(-1)).toEqual(['send-keys', '-t', '%7', 'Enter']);
    else expect(result.commands?.[0]).not.toContain('-k');
  });

  it.each(["quoted ' \\ ; $HOME #{pane_pid}\n\t\r\u001b\u007f 😀", '😀'.repeat(MAX_REMOTE_CODEX_PROMPT_BYTES / 4)])(
    'preserves exact bounded input bytes through the generated tmux command grammar',
    async (prompt) => {
      const result = await fixture('input', 'none', false, { prompt });
      expect(result.status).toBe('sent');
      const chunks = result.commands?.slice(0, -1).map((command) => {
        expect(command.slice(0, 4)).toEqual(['send-keys', '-l', '-t', '%7']);
        expect(Buffer.byteLength(command[4], 'utf8')).toBeLessThanOrEqual(8192);
        return command[4];
      });
      expect(chunks?.join('')).toBe(prompt);
      expect(result.commands?.at(-1)).toEqual(['send-keys', '-t', '%7', 'Enter']);
    }
  );

  it.each(['restart', 'restore'] as const)(
    'preserves control bytes in %s directory and worker-command tokens',
    async (kind) => {
      const workingDir = '/fixture/work space\n\r\t;$HOME\\literal';
      const result = await fixture(kind, 'none', false, { prompt: 'capture native commands', workingDir });
      expect(result.status).toBe('sent');
      expect(result.commands?.[0]?.slice(0, 3)).toEqual(['respawn-pane', '-c', result.workingDir]);
      expect(result.workingDir?.endsWith(workingDir)).toBe(true);
      expect(result.workerCommand).toContain(result.workingDir);
      expect(result.commands?.[0]?.at(-1)).toMatch(/^[a-f0-9]{64}$/);
      expect(result.commands).toHaveLength(1);
    }
  );
});
