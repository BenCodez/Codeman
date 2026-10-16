/** Generated reader path witnesses with exclusively temporary fake SSH/tmux effects. */
import { describe, expect, it } from 'vitest';
import { fixture, kinds } from './mocks/remote-reader-fixture.js';

describe.each(kinds)('final remote identity witness before %s', (kind) => {
  it.each(['new-conflict', 'changed-sibling'] as const)(
    'refuses a %s introduced during pane checks',
    async (mutation) => {
      expect(await fixture(kind, mutation)).toEqual({ status: 'not-sent', effects: '', laterReason: 'ambiguous' });
    }
  );

  it.each(['swap-home', 'swap-ancestor', 'swap-directory'] as const)(
    'refuses %s even when the same evidence files remain reachable',
    async (mutation) => {
      expect(await fixture(kind, mutation)).toMatchObject({ status: 'not-sent', effects: '' });
    }
  );

  it.each([false, true])('allows unchanged evidence with unrelated preexisting rollout: %s', async (unrelated) => {
    const result = await fixture(kind, 'none', unrelated);
    expect(result.status).toBe('sent');
    expect(result.effects).toContain(kind === 'input' ? 'send-keys' : 'respawn-pane');
    if (kind === 'input') expect(result.effects).toContain('Enter');
  });
});

describe('read-only remote evidence retains the same final proof', () => {
  it.each(['new-conflict', 'changed-sibling', 'swap-home', 'swap-ancestor', 'swap-directory'] as const)(
    'does not report a verified identity after %s during pane checks',
    async (mutation) => {
      expect(await fixture('inspect', mutation)).toMatchObject({
        status: undefined,
        effects: '',
        identityReason: 'unverified',
      });
    }
  );

  it.each([false, true])('reports unchanged identity with unrelated preexisting rollout: %s', async (unrelated) => {
    expect(await fixture('inspect', 'none', unrelated)).toMatchObject({
      status: undefined,
      effects: '',
      identityReason: 'verified',
    });
  });
});
