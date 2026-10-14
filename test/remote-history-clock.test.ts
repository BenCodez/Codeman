/** Possible correlation candidates retain their identity veto across clock uncertainty. */
import { describe, expect, it } from 'vitest';
import { fixture, kinds } from './mocks/remote-reader-fixture.js';

const paths = [...kinds, 'inspect'] as const;
describe.each(paths)('bounded uncertain history before %s', (kind) => {
  it.each(['other', 'same'] as const)(
    'refuses a possible matching %s UUID at the widened +2400ms edge',
    async (conflict) => {
      const result = await fixture(kind, 'none', false, { uncertaintyMs: 500, conflict, conflictDelta: 2400 });
      expect(result.identityReason).toBe('ambiguous');
      expect(result.effects).toBe('');
      if (kind !== 'inspect') expect(result.status).toBe('not-sent');
    }
  );

  it('refuses a unique possible-only history match rather than treating uncertain timing as proof', async () => {
    const result = await fixture(kind, 'none', false, { uncertaintyMs: 500, selectedDelta: 1900 });
    expect(result.identityReason).toBe('unverified');
    expect(result.effects).toBe('');
    if (kind !== 'inspect') expect(result.status).toBe('not-sent');
  });

  it('refuses a truncated prefix that could hide an uncertainty-edge matching UUID', async () => {
    const result = await fixture(kind, 'none', false, { uncertaintyMs: 500, truncatedPrefix: true });
    expect(result.identityReason).toBe('unverified');
    expect(result.effects).toBe('');
    if (kind !== 'inspect') expect(result.status).toBe('not-sent');
  });

  it.each([1e308, 0, -1])('refuses malformed unrelated history seconds %s', async (malformedHistoryAt) => {
    const result = await fixture(kind, 'none', false, { uncertaintyMs: 500, malformedHistoryAt });
    expect(result.identityReason).toBe('unverified');
    expect(result.effects).toBe('');
    if (kind !== 'inspect') expect(result.status).toBe('not-sent');
  });

  it.each([
    { uncertaintyMs: 500, selectedDelta: 1400 },
    { uncertaintyMs: 500, conflict: 'other' as const, conflictDelta: 2600 },
    { uncertaintyMs: 500, truncatedPrefix: true, retainedPrefixAt: -2600 },
  ])('permits one definite history match with complete interval coverage: %j', async (correlation) => {
    const result = await fixture(kind, 'none', false, correlation);
    expect(result.identityReason).toBe('verified');
    if (kind === 'inspect') expect(result.effects).toBe('');
    else {
      expect(result.status).toBe('sent');
      expect(result.effects).toContain(kind === 'input' ? 'send-keys' : 'respawn-pane');
    }
  });
});
