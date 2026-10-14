/** Opposing clock evidence: stable SSH skew is safe, uncertainty never authorizes action. */
import { describe, expect, it } from 'vitest';
import {
  clockFromBoundary,
  consistentRemoteClock,
  remoteClockOffset,
  remoteCompletionToLocal,
  remoteSubmissionWindow,
  remoteToLocal,
  validRemoteClock,
  type RemoteClockWitness,
} from '../src/recovery/remote-clock.js';

const hash = 'a'.repeat(64);
const sampled = (offset = 60_000): RemoteClockWitness => ({
  localBefore: 100_000,
  localAfter: 100_100,
  remoteBefore: 100_020 + offset,
  remoteAfter: 100_080 + offset,
});
const next = (offset = 60_000): RemoteClockWitness => ({
  localBefore: 100_200,
  localAfter: 100_300,
  remoteBefore: 100_220 + offset,
  remoteAfter: 100_280 + offset,
});

describe('bounded complete remote clock witnesses', () => {
  it.each([
    undefined,
    null,
    [],
    {},
    { ...sampled(), unrelated: true },
    { ...sampled(), remoteAfter: undefined },
    { ...sampled(), localBefore: NaN },
    { ...sampled(), remoteBefore: Infinity },
    { ...sampled(), localAfter: 100_100.5 },
    { ...sampled(), localBefore: 0 },
  ])('refuses malformed or incomplete clock evidence %s', (value) => {
    expect(validRemoteClock(value)).toBe(false);
  });

  it.each([60_000, -60_000])('accepts stable absolute skew %sms without equating clock domains', (offset) => {
    const clock = sampled(offset);
    expect(validRemoteClock(clock)).toBe(true);
    expect(remoteClockOffset(clock)).toEqual({ min: offset - 20, max: offset + 20 });
    expect(consistentRemoteClock(clock, next(offset))).toBe(true);
  });

  it('refuses a slow uncertainty interval, backwards clocks, and impossible negative transit time', () => {
    expect(
      validRemoteClock({ localBefore: 100_000, localAfter: 101_001, remoteBefore: 160_000, remoteAfter: 160_000 })
    ).toBe(false);
    expect(validRemoteClock({ ...sampled(), localAfter: 99_999 })).toBe(false);
    expect(validRemoteClock({ ...sampled(), remoteAfter: 160_019 })).toBe(false);
    expect(validRemoteClock({ ...sampled(), remoteAfter: 160_121 })).toBe(false);
    expect(
      validRemoteClock({ localBefore: 100_000, localAfter: 115_001, remoteBefore: 160_000, remoteAfter: 175_001 })
    ).toBe(false);
  });

  it('accepts exactly one second of uncertainty and refuses more', () => {
    expect(
      validRemoteClock({ localBefore: 100_000, localAfter: 101_000, remoteBefore: 160_000, remoteAfter: 160_000 })
    ).toBe(true);
    expect(
      validRemoteClock({ localBefore: 100_000, localAfter: 101_001, remoteBefore: 160_000, remoteAfter: 160_000 })
    ).toBe(false);
  });

  it('uses monotonic elapsed time to veto a local wall-clock jump', () => {
    expect(clockFromBoundary(100_000, 100_100, 160_020, 160_080, 100)).toEqual(sampled());
    expect(clockFromBoundary(100_000, 100_300, 160_020, 160_080, 100)).toBeUndefined();
    expect(clockFromBoundary(100_000, 100_100, 160_020, 160_080, NaN)).toBeUndefined();
  });

  it('refuses shifted or temporally reversed proof even when both samples are individually valid', () => {
    expect(validRemoteClock(next(61_000))).toBe(true);
    expect(consistentRemoteClock(sampled(), next(61_000))).toBe(false);
    expect(consistentRemoteClock(next(), sampled())).toBe(false);
    expect(
      consistentRemoteClock(sampled(), {
        ...next(),
        localBefore: 100_090,
        localAfter: 100_190,
        remoteBefore: 160_110,
        remoteAfter: 160_170,
      })
    ).toBe(false);
    expect(consistentRemoteClock(sampled(), { ...next(), remoteBefore: 160_070, remoteAfter: 160_130 })).toBe(false);
  });
});

describe('submission correlation keeps its original clock provenance', () => {
  it.each([
    undefined,
    { at: 100_120, hash },
    { at: 100_120, hash, clockDomain: 'local' },
    { at: 100_120, hash, clock: sampled() },
    { at: 100_120, hash: 'bad', clockDomain: 'local', clock: sampled() },
  ])('refuses missing or legacy provenance %s', (submission) => {
    expect(remoteSubmissionWindow(submission as Parameters<typeof remoteSubmissionWindow>[0], next())).toBeUndefined();
  });

  it.each([60_000, -60_000])('converts a local direct-input boundary under stable %sms skew', (offset) => {
    const result = remoteSubmissionWindow(
      { at: 100_120, hash, clockDomain: 'local', clock: sampled(offset) },
      next(offset)
    );
    expect(result).toEqual({ at: 100_120 + offset, hash, uncertaintyMs: 20 });
    // An event at the old 2s edge is ambiguous after accounting for offset uncertainty.
    expect(Math.abs(result!.at + 2000 - result!.at) + result!.uncertaintyMs).toBeGreaterThan(2000);
    expect(Math.abs(result!.at + 1980 - result!.at) + result!.uncertaintyMs).toBe(2000);
  });

  it.each([100_099, 102_101, 100_201])(
    'refuses a local submission outside its certified/current boundary at %s',
    (at) => {
      expect(remoteSubmissionWindow({ at, hash, clockDomain: 'local', clock: sampled() }, next())).toBeUndefined();
    }
  );

  it('accepts a remote Enter receipt only inside its originating remote command interval', () => {
    expect(remoteSubmissionWindow({ at: 160_050, hash, clockDomain: 'remote', clock: sampled() }, next())).toEqual({
      at: 160_050,
      hash,
      uncertaintyMs: 0,
    });
    for (const at of [160_019, 160_081]) {
      expect(remoteSubmissionWindow({ at, hash, clockDomain: 'remote', clock: sampled() }, next())).toBeUndefined();
    }
  });

  it('refuses a previous submission when the remote clock offset changed', () => {
    for (const clockDomain of ['local', 'remote'] as const) {
      const at = clockDomain === 'local' ? 100_120 : 160_050;
      expect(remoteSubmissionWindow({ at, hash, clockDomain, clock: sampled() }, next(61_000))).toBeUndefined();
    }
  });
});

describe('conservative local timestamp bounds', () => {
  it.each([60_000, -60_000])(
    'cannot make stale starts or future completions appear current under %sms skew',
    (offset) => {
      const clock = sampled(offset);
      const remoteAt = 100_500 + offset;
      expect(remoteToLocal(remoteAt, clock)).toBe(100_480);
      expect(remoteCompletionToLocal(remoteAt, clock)).toBe(100_520);
      expect(remoteToLocal(remoteAt, clock)).toBeLessThan(100_500); // objective starts here
      expect(remoteCompletionToLocal(remoteAt, clock)).toBeGreaterThan(100_510); // current local time
    }
  );
});
