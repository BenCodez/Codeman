import { expect, it, vi } from 'vitest';
import { ManagerCredentialRegistry } from '../src/supervisor/manager-credentials.js';

const SID = '11111111-2222-4333-8444-555555555555';
it('binds an unguessable credential to the immutable exact live launch scope', () => {
  const registry = new ManagerCredentialRegistry();
  let current = false;
  const options = { sessionId: SID, owner: 'alice', isCurrent: () => current };
  const issued = registry.issue(options);
  expect(issued.token).toMatch(/^codeman-manager-v1\.[a-f0-9]{64}$/);
  expect(registry.resolve(issued.token)).toBeUndefined();
  current = true;
  const scope = registry.resolve(issued.token)!;
  expect(scope).toEqual({ sessionId: SID, owner: 'alice' });
  expect(Object.isFrozen(scope)).toBe(true);
  options.owner = 'mallory';
  expect(registry.resolve(issued.token)).toBe(scope);
  expect(registry.isCurrent({ ...scope })).toBe(false);
  current = false;
  expect(registry.resolve(issued.token)).toBeUndefined();
  current = true;
  issued.revoke();
  expect(registry.resolve(issued.token)).toBeUndefined();
  expect(registry.isCurrent(scope)).toBe(false);
});

it.each([
  undefined,
  false,
  null,
  'true',
  1,
  () => {
    throw Error('private fixture diagnostic');
  },
  () => Promise.reject(Error('async refusal')),
])('fails closed for a nonliteral current verdict %s', async (verdict) => {
  const registry = new ManagerCredentialRegistry();
  const issued = registry.issue({
    sessionId: SID,
    isCurrent: (typeof verdict === 'function' ? verdict : () => verdict) as () => boolean,
  });
  expect(registry.resolve(issued.token)).toBeUndefined();
  await Promise.resolve();
});

it('revokes independently and bounds credentials without evicting a live manager', () => {
  const registry = new ManagerCredentialRegistry();
  const first = registry.issue({ sessionId: SID, isCurrent: () => true });
  for (let index = 1; index < 256; index++)
    registry.issue({
      sessionId: `22222222-3333-4444-8555-${index.toString(16).padStart(12, '0')}`,
      isCurrent: () => true,
    });
  expect(() => registry.issue({ sessionId: '33333333-4444-4555-8666-777777777777', isCurrent: () => true })).toThrow(
    'capacity'
  );
  expect(registry.resolve(first.token)).toBeDefined();
  first.revoke();
  const replacement = registry.issue({ sessionId: SID, isCurrent: () => true });
  expect(replacement.token).not.toBe(first.token);
  registry.revokeAll();
  expect(registry.resolve(replacement.token)).toBeUndefined();
});

it('rejects malformed scope and token before invoking authority', () => {
  const registry = new ManagerCredentialRegistry();
  const current = vi.fn(() => true);
  expect(() => registry.issue({ sessionId: 'short', isCurrent: current })).toThrow('scope');
  expect(registry.resolve('x'.repeat(10000))).toBeUndefined();
  expect(current).not.toHaveBeenCalled();
});

it('a new launch for the same session retires the old token without reviving it', () => {
  const registry = new ManagerCredentialRegistry();
  const old = registry.issue({ sessionId: SID, owner: 'alice', isCurrent: () => true });
  const oldScope = registry.resolve(old.token)!;
  const fresh = registry.issue({ sessionId: SID, owner: 'alice', isCurrent: () => true });
  expect(registry.resolve(old.token)).toBeUndefined();
  expect(registry.isCurrent(oldScope)).toBe(false);
  expect(registry.resolve(fresh.token)).toBeDefined();
  old.revoke();
  expect(registry.resolve(fresh.token)).toBeDefined();
  registry.revokeSession(SID);
  expect(registry.resolve(fresh.token)).toBeUndefined();
});
