/** @fileoverview HTML capability capacity, reuse, expiry and ownership regressions. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HtmlViewCapabilityStore } from '../src/html-view-capabilities.js';
import { MAX_WEBVIEW_CAPABILITIES } from '../src/config/webview-limits.js';

describe('HtmlViewCapabilityStore capacity', () => {
  let store: HtmlViewCapabilityStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new HtmlViewCapabilityStore(1_000);
  });

  afterEach(() => {
    store.dispose();
    vi.useRealTimers();
  });

  function fill(owner = 'alice'): string[] {
    return Array.from({ length: MAX_WEBVIEW_CAPABILITIES }, (_, i) => store.mint(`/site/${i}`, owner));
  }

  it('retains exactly 200 live capabilities and evicts the oldest on the 201st mint', () => {
    const tokens = fill();
    expect(tokens).toHaveLength(200);
    expect(store.size).toBe(200);
    for (const token of tokens) expect(store.resolve(token)).toBeDefined();

    const next = store.mint('/next', 'alice');
    expect(store.size).toBe(200);
    expect(store.resolve(tokens[0])).toBeUndefined();
    for (const token of tokens.slice(1)) expect(store.resolve(token)).toBeDefined();
    expect(store.resolve(next)?.rootDir).toBe('/next');

    // Reopening the evicted directory must create a valid replacement rather
    // than returning a stale reverse-index token.
    const replacement = store.mint('/site/0', 'alice');
    expect(replacement).not.toBe(tokens[0]);
    expect(store.resolve(replacement)?.rootDir).toBe('/site/0');
    expect(store.resolve(tokens[1])).toBeUndefined();
    expect(store.size).toBe(200);
  });

  it('reuses a live capability at capacity without evicting or changing its authority', () => {
    const tokens = fill();
    vi.setSystemTime(Date.now() + 900);
    expect(store.mint('/site/0', 'alice')).toBe(tokens[0]);
    expect(store.size).toBe(200);
    for (const token of tokens) expect(store.resolve(token)?.owner).toBe('alice');
    vi.setSystemTime(Date.now() + 900);
    expect(store.resolve(tokens[0])?.rootDir).toBe('/site/0');
  });

  it('reclaims expired entries before evicting any remaining live capability', () => {
    const tokens = fill();
    vi.setSystemTime(Date.now() + 900);
    expect(store.resolve(tokens[0])).toBeDefined();
    vi.setSystemTime(Date.now() + 101);

    const next = store.mint('/next', 'bob');
    expect(store.size).toBe(2);
    expect(store.resolve(tokens[0])?.owner).toBe('alice');
    for (const token of tokens.slice(1)) expect(store.resolve(token)).toBeUndefined();
    expect(store.resolve(next)?.owner).toBe('bob');
    const reopened = store.mint('/site/1', 'alice');
    expect(reopened).not.toBe(tokens[1]);
    expect(store.resolve(reopened)?.rootDir).toBe('/site/1');
  });

  it('keeps identities and workspace-confinement authority distinct at capacity', () => {
    const tokens = fill();
    const bob = store.mint('/site/199', 'bob');
    const outside = store.mint('/site/199', 'alice', true);
    expect(new Set([tokens[199], bob, outside]).size).toBe(3);
    expect(store.resolve(tokens[199])).toMatchObject({ owner: 'alice', outsideWorkspace: false });
    expect(store.resolve(bob)).toMatchObject({ owner: 'bob', outsideWorkspace: false });
    expect(store.resolve(outside)).toMatchObject({ owner: 'alice', outsideWorkspace: true });
    expect(store.mint('/site/199', 'alice')).toBe(tokens[199]);
    expect(store.mint('/site/199', 'bob')).toBe(bob);
    expect(store.mint('/site/199', 'alice', true)).toBe(outside);
    expect(store.size).toBe(200);
  });

  it('releases only the revoked owner and admits new mints without evicting survivors', () => {
    const tokens = fill();
    const bob = store.mint('/bob', 'bob');
    expect(store.revokeOwner('alice')).toBe(199);
    expect(store.size).toBe(1);
    for (const token of tokens) expect(store.resolve(token)).toBeUndefined();
    const next = store.mint('/next', 'carol');
    expect(store.resolve(bob)?.owner).toBe('bob');
    expect(store.resolve(next)?.owner).toBe('carol');
    expect(store.size).toBe(2);
    store.dispose();
    expect(store.size).toBe(0);
    expect(store.resolve(bob)).toBeUndefined();
    expect(store.resolve(next)).toBeUndefined();
  });
});
