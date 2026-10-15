/**
 * @fileoverview Exactly-once input delivery — Session.shouldApplyInput dedup.
 *
 * Guards the server half of the reliable-input-delivery feature: the web client
 * tags each input frame with a stable clientId + a monotonic per-session seq and
 * redelivers anything it hasn't seen ACKed (a half-open socket silently drops
 * frames on a flaky link). shouldApplyInput must apply each (clientId, seq)
 * exactly once so a redelivery can never type the prompt twice — while still
 * applying untagged input (curl/legacy) unconditionally at the call sites.
 *
 * See docs/reliable-input-delivery.md.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { Session } from '../src/session.js';

function makeSession(): Session {
  // workingDir is the only required field; no PTY is spawned until start(),
  // and TmuxManager no-ops under VITEST — so this is a cheap, side-effect-free
  // instance for exercising the pure dedup bookkeeping.
  return new Session({ workingDir: '/tmp' });
}

function apply(s: Session, clientId: string, seq: number): boolean {
  const accepted = s.shouldApplyInput(clientId, seq);
  if (accepted) s.commitInputSeq(clientId, seq);
  return accepted;
}

afterEach(() => vi.restoreAllMocks());

describe('abandoned known-unsent input admission', () => {
  function clock() {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    return (next: number) => {
      now = next;
    };
  }

  it('reclaims 256 abandoned never-dispatched clients after the monotonic lease', () => {
    const setTime = clock();
    const s = makeSession();
    for (let i = 0; i < 256; i++) expect(s.deferInputSeq(`abandoned-${i}`, 1)).toBe(true);
    expect(s.deferInputSeq('fresh-client', 1)).toBe(false);
    setTime(60_000);
    expect(s.shouldApplyInput('fresh-client', 1)).toBe(true);
    expect(s.hasAppliedInputSeq('fresh-client', 1)).toBe(false);
    s.commitInputSeq('fresh-client', 1);
    expect(s.hasAppliedInputSeq('fresh-client', 1)).toBe(true);
  });

  it('reclaims an expired 4096-frame unsent tail while retaining its committed watermark', () => {
    const setTime = clock();
    const s = makeSession();
    expect(apply(s, 'client', 7)).toBe(true);
    for (let seq = 8; seq < 4104; seq++) expect(s.deferInputSeq('client', seq)).toBe(true);
    expect(s.deferInputSeq('client', 4104)).toBe(false);
    setTime(60_000);
    expect(s.shouldApplyInput('client', 4104)).toBe(true);
    expect(s.lastInputSeq('client')).toBe(7);
    expect(s.hasAppliedInputSeq('client', 7)).toBe(true);
    expect(s.hasAppliedInputSeq('client', 8)).toBe(false);
  });

  it('keeps actively retried known-unsent input ahead of later frames', () => {
    const setTime = clock();
    const s = makeSession();
    expect(s.deferInputSeq('active', 1)).toBe(true);
    for (let i = 0; i < 255; i++) expect(s.deferInputSeq(`abandoned-${i}`, 1)).toBe(true);
    for (const at of [30_000, 60_000, 90_000]) {
      setTime(at);
      expect(s.deferInputSeq('active', 1)).toBe(true);
    }
    expect(s.deferInputSeq('fresh-client', 1)).toBe(true);
    expect(s.shouldApplyInput('active', 2)).toBe(false);
    expect(apply(s, 'active', 1)).toBe(true);
    expect(apply(s, 'active', 2)).toBe(true);
  });

  it('retains a quiet known-unsent FIFO when no admission capacity needs reclaiming', () => {
    const setTime = clock();
    const s = makeSession();
    expect(s.deferInputSeq('quiet-client', 1)).toBe(true);
    setTime(600_000);
    expect(s.shouldApplyInput('quiet-client', 2)).toBe(false);
    expect(s.hasAppliedInputSeq('quiet-client', 1)).toBe(false);
    expect(apply(s, 'quiet-client', 1)).toBe(true);
    expect(apply(s, 'quiet-client', 2)).toBe(true);
  });

  it.each(['failed', 'committed'] as const)('renews queued FIFO after a long pending delivery is %s', (outcome) => {
    const setTime = clock();
    const s = makeSession();
    expect(s.shouldApplyInput('active', 1)).toBe(true);
    expect(s.deferInputSeq('active', 2)).toBe(true);
    setTime(600_000);
    if (outcome === 'failed') s.forgetInputSeq('active', 1);
    else s.commitInputSeq('active', 1);
    expect(s.shouldApplyInput('active', 3)).toBe(false);
    if (outcome === 'failed') expect(apply(s, 'active', 1)).toBe(true);
    expect(apply(s, 'active', 2)).toBe(true);
    expect(apply(s, 'active', 3)).toBe(true);
  });

  it('never expires pending input or turns an earlier sparse unsent hole into an ACK', () => {
    const setTime = clock();
    const s = makeSession();
    expect(s.shouldApplyInput('pending', 10)).toBe(true);
    expect(s.deferInputSeq('pending', 3)).toBe(true);
    setTime(600_000);
    expect(s.shouldApplyInput('pending', 10)).toBe(false);
    expect(s.shouldApplyInput('pending', 11)).toBe(false);
    expect(s.hasAppliedInputSeq('pending', 10)).toBe(false);
    s.commitInputSeq('pending', 10);
    setTime(1_200_000);
    expect(s.shouldApplyInput('pending', 11)).toBe(false);
    expect(s.lastInputSeq('pending')).toBe(10);
    expect(s.hasAppliedInputSeq('pending', 3)).toBe(false);
    expect(apply(s, 'pending', 3)).toBe(true);
    expect(apply(s, 'pending', 11)).toBe(true);
  });

  it('preserves all pending clients under pressure even after the lease', () => {
    const setTime = clock();
    const s = makeSession();
    for (let i = 0; i < 256; i++) expect(s.shouldApplyInput(`pending-${i}`, 1)).toBe(true);
    setTime(600_000);
    expect(s.deferInputSeq('fresh-client', 1)).toBe(false);
    expect(s.shouldApplyInput('pending-0', 1)).toBe(false);
    s.commitInputSeq('pending-0', 1);
    expect(s.hasAppliedInputSeq('pending-0', 1)).toBe(true);
  });

  it('does not expire known-unsent input after wall-clock changes or a backwards monotonic sample', () => {
    const setTime = clock();
    setTime(100);
    const s = makeSession();
    expect(s.deferInputSeq('active', 1)).toBe(true);
    const wall = vi.spyOn(Date, 'now').mockReturnValue(Number.MAX_SAFE_INTEGER);
    setTime(99);
    expect(s.shouldApplyInput('active', 2)).toBe(false);
    expect(s.hasAppliedInputSeq('active', 1)).toBe(false);
    wall.mockRestore();
    expect(apply(s, 'active', 1)).toBe(true);
  });
});

describe('Session.shouldApplyInput (exactly-once input dedup)', () => {
  it('accepts and deduplicates the schema-valid initial zero sequence', () => {
    const s = makeSession();
    expect(s.hasAppliedInputSeq('zero', 0)).toBe(false);
    expect(apply(s, 'zero', 0)).toBe(true);
    expect(s.hasAppliedInputSeq('zero', 0)).toBe(true);
    expect(apply(s, 'zero', 0)).toBe(false);
  });
  it('applies a fresh (clientId, seq) exactly once', () => {
    const s = makeSession();
    expect(apply(s, 'clientA', 1)).toBe(true);
    // Same seq redelivered (lost ACK) — must NOT apply again.
    expect(apply(s, 'clientA', 1)).toBe(false);
  });

  it('applies strictly increasing seqs and rejects stale ones', () => {
    const s = makeSession();
    expect(apply(s, 'c', 1)).toBe(true);
    expect(apply(s, 'c', 2)).toBe(true);
    expect(apply(s, 'c', 3)).toBe(true);
    // Out-of-order / replayed lower seqs are duplicates.
    expect(apply(s, 'c', 2)).toBe(false);
    expect(apply(s, 'c', 1)).toBe(false);
    // The next genuinely-new seq still applies.
    expect(apply(s, 'c', 4)).toBe(true);
  });

  it('tracks each client independently', () => {
    const s = makeSession();
    expect(apply(s, 'a', 5)).toBe(true);
    // A different client at seq 1 is not shadowed by client a's higher seq.
    expect(apply(s, 'b', 1)).toBe(true);
    expect(apply(s, 'b', 1)).toBe(false);
    expect(apply(s, 'a', 6)).toBe(true);
  });

  it('tolerates a seq gap (skips never collapse a new seq to a duplicate)', () => {
    const s = makeSession();
    expect(apply(s, 'c', 1)).toBe(true);
    // Client jumped seq (e.g. resumed after a reload that kept the counter).
    expect(apply(s, 'c', 100)).toBe(true);
    expect(apply(s, 'c', 100)).toBe(false);
    expect(apply(s, 'c', 50)).toBe(false);
    expect(apply(s, 'c', 101)).toBe(true);
  });

  it('keeps recent clients dedup-correct past the eviction bound', () => {
    const s = makeSession();
    // Far exceed MAX_INPUT_DEDUP_CLIENTS (256) with one-shot clients, then prove
    // a freshly-active client is still deduped correctly (MRU eviction).
    for (let i = 0; i < 400; i++) {
      expect(apply(s, `oneshot-${i}`, 1)).toBe(true);
    }
    expect(apply(s, 'recent', 1)).toBe(true);
    expect(apply(s, 'recent', 1)).toBe(false);
    expect(apply(s, 'recent', 2)).toBe(true);
  });
});

describe('Session.lastInputSeq (the watermark a stuck client needs)', () => {
  it('failed sparse and overlapping reservations retain only the genuinely applied watermark', () => {
    const s = makeSession();
    apply(s, 'c-1', 7);
    expect(s.shouldApplyInput('c-1', 10)).toBe(true);
    expect(s.shouldApplyInput('c-1', 100)).toBe(false);
    expect(s.lastInputSeq('c-1')).toBe(7);
    s.forgetInputSeq('c-1', 10);
    s.forgetInputSeq('c-1', 100);
    expect(s.lastInputSeq('c-1')).toBe(7);
    expect(apply(s, 'c-1', 10)).toBe(true);
    expect(apply(s, 'c-1', 100)).toBe(true);
    expect(s.lastInputSeq('c-1')).toBe(100);
    expect(apply(s, 'c-1', 100)).toBe(false);
  });

  it('failure of a later reservation keeps an older in-flight identity protected', () => {
    const s = makeSession();
    s.shouldApplyInput('c-1', 1);
    expect(s.shouldApplyInput('c-1', 3)).toBe(false);
    s.forgetInputSeq('c-1', 3);
    expect(s.shouldApplyInput('c-1', 1)).toBe(false);
    expect(s.lastInputSeq('c-1')).toBe(0);
    s.commitInputSeq('c-1', 1);
    expect(s.lastInputSeq('c-1')).toBe(1);
    expect(apply(s, 'c-1', 3)).toBe(true);
  });

  it('keeps an earlier received identity undelivered when a higher in-flight sparse frame commits', () => {
    const s = makeSession();
    expect(s.shouldApplyInput('c-1', 7)).toBe(true);
    expect(s.shouldApplyInput('c-1', 3)).toBe(false);
    s.commitInputSeq('c-1', 7);
    expect(s.lastInputSeq('c-1')).toBe(7);
    expect(s.hasAppliedInputSeq('c-1', 3)).toBe(false);
    expect(apply(s, 'c-1', 8)).toBe(false);
    expect(apply(s, 'c-1', 3)).toBe(true);
    expect(s.hasAppliedInputSeq('c-1', 3)).toBe(true);
    expect(apply(s, 'c-1', 8)).toBe(true);
  });

  it('bounds deferred identities and reopens capacity after the earliest retry commits', () => {
    const s = makeSession();
    for (let seq = 1; seq <= 4096; seq++) expect(s.deferInputSeq('c-1', seq)).toBe(true);
    expect(s.deferInputSeq('c-1', 4097)).toBe(false);
    expect(s.lastInputSeq('c-1')).toBe(0);
    expect(apply(s, 'c-1', 1)).toBe(true);
    expect(s.deferInputSeq('c-1', 4097)).toBe(true);
  });

  it('never evicts received but undelivered identities to admit another client', () => {
    const s = makeSession();
    for (let i = 0; i < 256; i++) expect(s.deferInputSeq(`waiting-${i}`, 1)).toBe(true);
    expect(s.deferInputSeq('overflow', 1)).toBe(false);
    expect(apply(s, 'waiting-0', 1)).toBe(true);
    expect(s.deferInputSeq('overflow', 1)).toBe(true);
    expect(s.shouldApplyInput('waiting-1', 2)).toBe(false);
    expect(apply(s, 'waiting-1', 1)).toBe(true);
  });
  it('reports 0 for a client it has never seen', () => {
    expect(makeSession().lastInputSeq('c-new')).toBe(0);
  });

  it('reports the highest seq applied for that client', () => {
    const s = makeSession();
    apply(s, 'c-1', 7);
    expect(s.lastInputSeq('c-1')).toBe(7);
  });

  it('is what a rolled-back client must clear to be heard again', () => {
    // The failure this exists for: the client's seq counter persists on a
    // DEBOUNCED write, so a tab killed between a send and that write comes back
    // counting from below the watermark. Every later keystroke then lands at or
    // under it and is rejected — silently, because a rejected frame is ACKed too.
    const s = makeSession();
    for (let i = 1; i <= 40; i++) apply(s, 'c-1', i);
    // Restored counter starts over at 1: dropped, and every subsequent one too.
    expect(apply(s, 'c-1', 1)).toBe(false);
    expect(apply(s, 'c-1', 2)).toBe(false);
    // The watermark it is handed back is exactly what makes it recoverable.
    const watermark = s.lastInputSeq('c-1');
    expect(watermark).toBe(40);
    expect(apply(s, 'c-1', watermark + 1)).toBe(true);
  });

  it('does not resurrect a seq that forgetInputSeq rolled back', () => {
    const s = makeSession();
    apply(s, 'c-1', 3);
    s.shouldApplyInput('c-1', 5);
    s.forgetInputSeq('c-1', 5);
    expect(s.lastInputSeq('c-1')).toBe(3);
    expect(apply(s, 'c-1', 5)).toBe(true);
  });
});
