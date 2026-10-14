/** @fileoverview Private bounded clock evidence captured before owned SSH input. */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import type { SessionRemote } from '../types.js';
import { buildSshConnectionArgs, remoteLoginShellCommand, remoteSshTarget, shellescape } from '../remote-hosts.js';
import { runWithRemoteSshLimit } from '../remote-ssh-limiter.js';

const execAsync = promisify(exec);
const CLOCK_MARKER = 'CODEMAN_REMOTE_CLOCK_V1:';
const MAX_CLOCK_UNCERTAINTY_MS = 1000;

export interface RemoteClockWitness {
  localBefore: number;
  localAfter: number;
  remoteBefore: number;
  remoteAfter: number;
}

export interface RecoverySubmission {
  at: number;
  hash: string;
  /** Absent on legacy local proofs; remote automation requires an explicit domain and witness. */
  clockDomain?: 'local' | 'remote';
  clock?: RemoteClockWitness;
}

export function validSubmissionClock(submission: RecoverySubmission): boolean {
  if (submission.clockDomain === undefined && submission.clock === undefined) return true;
  if (!Number.isSafeInteger(submission.at) || submission.at <= 0) return false;
  if (!submission.clock || !validRemoteClock(submission.clock)) return false;
  return submission.clockDomain === 'remote'
    ? submission.at >= submission.clock.remoteBefore && submission.at <= submission.clock.remoteAfter
    : submission.clockDomain === 'local' &&
        submission.at >= submission.clock.localAfter &&
        submission.at - submission.clock.localAfter <= 2000;
}

export function validRemoteClock(value: unknown): value is RemoteClockWitness {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const clock = value as RemoteClockWitness;
  if (
    Object.keys(clock).length !== 4 ||
    ![clock.localBefore, clock.localAfter, clock.remoteBefore, clock.remoteAfter].every(
      (at) => Number.isSafeInteger(at) && at > 0
    )
  )
    return false;
  const localElapsed = clock.localAfter - clock.localBefore;
  const remoteElapsed = clock.remoteAfter - clock.remoteBefore;
  const uncertainty = localElapsed - remoteElapsed;
  return (
    localElapsed >= 0 &&
    localElapsed <= 15_000 &&
    remoteElapsed >= 0 &&
    uncertainty >= 0 &&
    uncertainty <= MAX_CLOCK_UNCERTAINTY_MS
  );
}

export function remoteClockOffset(clock: RemoteClockWitness): { min: number; max: number } {
  return { min: clock.remoteAfter - clock.localAfter, max: clock.remoteBefore - clock.localBefore };
}

export function consistentRemoteClock(previous: RemoteClockWitness, current: RemoteClockWitness): boolean {
  if (
    !validRemoteClock(previous) ||
    !validRemoteClock(current) ||
    current.localBefore < previous.localAfter ||
    current.remoteBefore < previous.remoteAfter
  )
    return false;
  const a = remoteClockOffset(previous);
  const b = remoteClockOffset(current);
  return Math.max(a.min, b.min) <= Math.min(a.max, b.max);
}

/** Earliest plausible local time; uncertainty cannot make stale evidence fresh. */
export function remoteToLocal(at: number, clock: RemoteClockWitness): number {
  return at - remoteClockOffset(clock).max;
}

/** Latest plausible completion time; future command completion cannot become current evidence. */
export function remoteCompletionToLocal(at: number, clock: RemoteClockWitness): number {
  return at - remoteClockOffset(clock).min;
}

export function remoteSubmissionWindow(
  submission: RecoverySubmission | undefined,
  current: RemoteClockWitness
): { at: number; hash: string; uncertaintyMs: number } | undefined {
  if (
    !submission ||
    !Number.isSafeInteger(submission.at) ||
    submission.at <= 0 ||
    !/^[a-f0-9]{64}$/.test(submission.hash) ||
    !submission.clock ||
    !consistentRemoteClock(submission.clock, current)
  )
    return undefined;
  if (submission.clockDomain === 'remote')
    return submission.at >= submission.clock.remoteBefore && submission.at <= submission.clock.remoteAfter
      ? { at: submission.at, hash: submission.hash, uncertaintyMs: 0 }
      : undefined;
  if (
    submission.clockDomain !== 'local' ||
    submission.at < submission.clock.localAfter ||
    submission.at > current.localBefore ||
    submission.at - submission.clock.localAfter > 2000
  )
    return undefined;
  const offset = remoteClockOffset(submission.clock);
  return {
    at: submission.at + (offset.min + offset.max) / 2,
    hash: submission.hash,
    uncertaintyMs: (offset.max - offset.min) / 2,
  };
}

export function clockFromBoundary(
  localBefore: number,
  localAfter: number,
  remoteBefore: number,
  remoteAfter: number,
  monotonicElapsed: number
): RemoteClockWitness | undefined {
  const clock = { localBefore, localAfter, remoteBefore, remoteAfter };
  return validRemoteClock(clock) && Math.abs(localAfter - localBefore - monotonicElapsed) <= 100 ? clock : undefined;
}

/** `limited=false` is internal to an already-held SSH slot, never a nested acquisition. */
export async function sampleRemoteCodexClock(
  remote: SessionRemote,
  limited = true
): Promise<RemoteClockWitness | undefined> {
  if (process.env.VITEST) throw new Error('Remote clock IO requires an injected fixture under VITEST');
  const sample = async () => {
    const localBefore = Date.now();
    const monotonicBefore = performance.now();
    const script = `const at=Date.now();process.stdout.write('${CLOCK_MARKER}'+JSON.stringify({at})+'\\n')`;
    const command = [
      ...buildSshConnectionArgs(remote),
      remoteSshTarget(remote),
      shellescape(remoteLoginShellCommand(`node -e ${shellescape(script)}`)),
    ].join(' ');
    const { stdout } = await execAsync(command, { timeout: 2000, maxBuffer: 4096 });
    try {
      const localAfter = Date.now();
      if (Buffer.byteLength(stdout) > 4096) return undefined;
      const lines = stdout.split('\n').filter((line) => line.startsWith(CLOCK_MARKER));
      if (lines.length !== 1) return undefined;
      const value = JSON.parse(lines[0].slice(CLOCK_MARKER.length));
      if (!value || Object.keys(value).length !== 1) return undefined;
      return clockFromBoundary(localBefore, localAfter, value.at, value.at, performance.now() - monotonicBefore);
    } catch {
      return undefined;
    }
  };
  return limited ? runWithRemoteSshLimit(sample) : sample();
}
