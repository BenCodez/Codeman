/** Actual generated remote reader with isolated fake SSH/tmux, including native tmux signal names. */
import { constants } from 'node:os';
import { describe, expect, it } from 'vitest';
import { fixture } from './mocks/remote-reader-fixture.js';

describe('strict native remote pane frames', () => {
  it.each(['KILL', 'TERM', 'ABRT', '9'])(
    'maps known tmux signal %s on the remote OS and preserves exact restart support',
    async (token) => {
      const signal = token === '9' ? 9 : constants.signals[`SIG${token}` as keyof typeof constants.signals];
      const result = await fixture('restart', 'none', false, {
        paneRow: `1||${token}|%7|4242`,
        expectedPane: { paneId: '%7', panePid: 4242, signal },
      });
      expect(result).toMatchObject({ status: 'sent', pane: { dead: true, signal, paneId: '%7', panePid: 4242 } });
      expect(result.effects).toContain('respawn-pane');
      expect(result.effects).not.toContain(' -k ');
    }
  );

  it.each([
    '1|1||%7|4242|extra',
    '1|garbage||%7|4242',
    '1|65536||%7|4242',
    '1|01||%7|4242',
    '1||NOTASIGNAL|%7|4242',
    '1||KILLjunk|%7|4242',
    '1||65536|%7|4242',
    '1|1||%07|4242',
    '1|1||%9007199254740992|4242',
    '1|1||%7|0',
    '1|1||%7|04242',
    '1|1||%7|9007199254740992',
    '1|1||%7|NaN',
    '1|1||%7|4242\n1|1||%8|4243',
    '1|1||%7|4242 ',
    '1|1||%7|4242\r',
    '1|1||%7|4242\r\n',
    '1|1||%7|4242\n',
    '1|256||%7|4242',
    '1||SIGNALNAMEWAYTOOLONG|%7|4242',
    '1|1|KILL|%7|4242',
    '1|0|TERM|%7|4242',
    '0|0||%7|4242',
    '0||KILL|%7|4242',
    '0||0|%7|4242',
  ])('refuses malformed pane frame %j before any remote worker effect', async (paneRow) => {
    const result = await fixture('restart', 'none', false, { paneRow });
    expect(result.effects).toBe('');
    expect(result.status).toBe('unknown');
    expect(result.pane).toBeUndefined();
  });

  it('accepts the canonical POSIX status boundary without inferring clean-exit authority', async () => {
    const result = await fixture('restart', 'none', false, {
      paneRow: '1|255||%7|4242',
      expectedPane: { paneId: '%7', panePid: 4242, status: 255 },
    });
    expect(result.status).toBe('sent');
    expect(result.pane).toMatchObject({ dead: true, status: 255 });
    expect(result.effects).toContain('respawn-pane');
  });

  it('does not reuse numeric signal authority when the native signal changed', async () => {
    const result = await fixture('restart', 'none', false, {
      paneRow: '1||TERM|%7|4242',
      expectedPane: { paneId: '%7', panePid: 4242, signal: constants.signals.SIGKILL },
    });
    expect(result.status).toBe('not-sent');
    expect(result.effects).toBe('');
  });
});
