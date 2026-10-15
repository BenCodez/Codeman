/** Generated SSH reader uses only executable temporary native fakes. */
import { describe, expect, it } from 'vitest';
import { fixture, REMOTE_READY_SCREEN } from './mocks/remote-reader-fixture.js';

const footer = '  fixture-model default · /fixture/work\n';

describe('remote automatic input retains exact live composer authority', () => {
  it.each(['Arbitrary transcript\n', '›\n', `› Initial owner draft\n${footer}`])(
    'a matching initial screen hash cannot authorize arbitrary or occupied composer text: %j',
    async (initialScreen) => {
      const result = await fixture('input', 'none', false, { initialScreen, prompt: 'Authorized continuation' });
      expect(result).toMatchObject({ status: 'not-sent', effects: '', commands: [] });
    }
  );

  it('refuses ambiguous placeholder text even when the initial screen hash matches', async () => {
    const result = await fixture('input', 'none', false, {
      initialScreen: `› Ask Codex to do anything\n${footer}`,
      prompt: 'Authorized continuation',
    });
    expect(result).toMatchObject({ status: 'not-sent', effects: '', commands: [] });
  });

  it.each([
    `› Unsent owner draft\n${footer}`,
    `› Ask Codex to do anything\n${footer}`,
    `›\n  Multiline owner draft\n${footer}`,
    `Working (esc to interrupt)\n${REMOTE_READY_SCREEN}`,
    `Would you like to approve this?\n${REMOTE_READY_SCREEN}`,
    `Authentication failed\n${REMOTE_READY_SCREEN}`,
    `Usage limit reached\n${REMOTE_READY_SCREEN}`,
    '›\n',
    'Visible transcript without a live composer or recognized footer\n',
    '',
  ])('refuses a changed or ambiguous composer after initial capture with zero bytes: %j', async (composerScreen) => {
    const result = await fixture('input', 'none', false, {
      composerAt: 'before-input',
      composerScreen,
      prompt: 'Authorized continuation',
    });
    expect(result).toMatchObject({ status: 'not-sent', effects: '', commands: [] });
  });

  it.each(['after-first-chunk', 'before-enter'] as const)(
    'keeps a direct owner edit %s unknown without sending the next bytes or Enter',
    async (composerAt) => {
      const prompt = composerAt === 'after-first-chunk' ? '😀'.repeat(4096) : 'Authorized continuation';
      const result = await fixture('input', 'none', false, { composerAt, prompt });
      expect(result.status).toBe('unknown');
      expect(result.commands).toHaveLength(1);
      expect(result.commands?.[0].slice(0, 4)).toEqual(['send-keys', '-l', '-t', '%7']);
      expect(result.commands?.[0][4]).toBe(composerAt === 'after-first-chunk' ? '😀'.repeat(2048) : prompt);
      expect(result.effects).not.toContain('Enter');
    }
  );

  it.each(['after-first-chunk', 'before-enter'] as const)(
    'never overwrites a literal placeholder draft %s after its own first bytes',
    async (composerAt) => {
      const prompt = composerAt === 'after-first-chunk' ? '😀'.repeat(4096) : 'Authorized continuation';
      const result = await fixture('input', 'none', false, {
        composerAt,
        composerScreen: `› Ask Codex to do anything\n${footer}`,
        prompt,
      });
      expect(result.status).toBe('unknown');
      expect(result.commands).toHaveLength(1);
      expect(result.commands?.[0][4]).toBe(composerAt === 'after-first-chunk' ? '😀'.repeat(2048) : prompt);
      expect(result.effects).not.toContain('Enter');
    }
  );

  it.each([
    'Working (esc to interrupt)',
    'Would you like to approve this?',
    'Authentication failed',
    'Usage limit reached',
  ])('retains surrounding %s veto after exact literal bytes', async (veto) => {
    const prompt = 'Authorized continuation';
    const result = await fixture('input', 'none', false, {
      prompt,
      composerAt: 'before-enter',
      composerScreen: `${veto}\n› ${prompt}\n${footer}`,
    });
    expect(result.status).toBe('unknown');
    expect(result.commands).toHaveLength(1);
    expect(result.effects).not.toContain('Enter');
  });

  it.each(['first-check', 'final-check'] as const)(
    'rechecks private identity after the blocking %s composer capture',
    async (witnessAt) => {
      const result = await fixture('input', 'none', false, { prompt: 'Authorized continuation', witnessAt });
      expect(result.status).toBe('unknown');
      expect(result.commands).toHaveLength(witnessAt === 'first-check' ? 0 : 1);
      expect(result.effects).not.toContain('Enter');
    }
  );

  it.each(
    [
      'Healthy café 🧭 漢字',
      'Ask Codex to do anything',
      JSON.stringify({ objective: 'First line\nSecond line', checkpoint: 'Step\nNext step' }),
      "Quoted ' \\ ; $HOME #{pane_pid}\n\t\r\u001b\u007f 😀",
      'Authentication failed',
      'Would you like to approve this?',
      '😀'.repeat(16_384),
    ].map((prompt) => ({ prompt, bytes: Buffer.byteLength(prompt, 'utf8') }))
  )('accepts the exact cumulative joined composer ($bytes UTF8 bytes)', async ({ prompt }) => {
    const result = await fixture('input', 'none', false, { prompt });
    expect(result.status).toBe('sent');
    expect(
      result.commands
        ?.slice(0, -1)
        .map((command) => command[4])
        .join('')
    ).toBe(prompt);
    for (const command of result.commands?.slice(0, -1) ?? [])
      expect(Buffer.byteLength(command[4], 'utf8')).toBeLessThanOrEqual(8192);
    expect(result.commands?.at(-1)).toEqual(['send-keys', '-t', '%7', 'Enter']);
  });

  it.each(['Authentication failed', 'Would you like to approve this?'])(
    'never excludes surrounding UI equal to its own prompt: %s',
    async (prompt) => {
      const result = await fixture('input', 'none', false, {
        prompt,
        composerAt: 'before-enter',
        composerScreen: `${prompt}\n› ${prompt}\n${footer}`,
      });
      expect(result.status).toBe('unknown');
      expect(result.commands).toHaveLength(1);
    }
  );
});
