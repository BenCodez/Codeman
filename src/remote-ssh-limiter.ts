/**
 * @fileoverview Global concurrency limiter for the short-lived `ssh` children that
 * remote-case file access spawns (`src/remote-files.ts`: the realpath+stat probe and
 * the buffered text read).
 *
 * Two paths can fan those out without a human behind each one:
 *
 * - `GET /api/sessions/:id/attachments` resolves every history entry (up to
 *   `ATTACHMENT_HISTORY_LIMIT`, 100), and the attachments drawer re-runs it on every
 *   `attachment:detected` event while it is open, which is exactly when an agent is
 *   writing files. The route now batches the probes, but a burst of drawers is still
 *   a burst.
 * - A `codeman://attach?path=` magic link in terminal output registers the path
 *   fire-and-forget, once per distinct link per PTY chunk. In a remote session that
 *   output is written by a process on the remote host, so a prompt-injected agent can
 *   print hundreds of links and have the server fork one `ssh` per link, each holding
 *   a 20s probe timeout.
 *
 * Without a cap that is the fork-bomb shape `document-conversion-limiter.ts` exists to
 * prevent, and it also trips OpenSSH's default `MaxStartups 10:30:100`, which starts
 * dropping connections at ten unauthenticated handshakes. This is that limiter for
 * ssh: a small fixed pool, FIFO queueing, and a slot handed straight to the next
 * waiter on release so the active count can never exceed the cap under interleaved
 * async resumption.
 *
 * Streams (`remoteCreateReadStream`) are deliberately NOT counted: one is opened per
 * browser request and held for the life of a media playback, so four open videos
 * would otherwise block every preview and the history list. They are already gated
 * behind a counted probe (the guard re-probe runs first), so their spawn RATE is
 * bounded here even though their concurrency is bounded by the browser.
 *
 * NOT re-entrant: never acquire from inside a task already holding a slot.
 */
import { performance } from 'node:perf_hooks';

/**
 * Max remote probes/reads allowed to run concurrently across the whole process.
 * Override with CODEMAN_MAX_REMOTE_FILE_SSH (clamped to >= 1). Four keeps a burst
 * well under OpenSSH's ten-handshake default.
 */
const MAX_CONCURRENT_REMOTE_SSH = (() => {
  const raw = Number(process.env.CODEMAN_MAX_REMOTE_FILE_SSH);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 4;
})();

let active = 0;
const waiters: Array<() => boolean> = [];

/** Optional bounds for feature callers; ordinary remote-file callers retain their existing FIFO. */
export interface RemoteSshAdmission {
  deadline: number;
  isCurrent?: () => boolean;
}

/** Only a refusal before its task starts certifies that no task effects occurred. */
export class RemoteSshAdmissionError extends Error {
  constructor(readonly reason: 'expired' | 'cancelled') {
    super('Remote SSH admission ' + reason);
    this.name = 'RemoteSshAdmissionError';
  }
}

function admissionFailure(admission?: RemoteSshAdmission): RemoteSshAdmissionError | undefined {
  if (!admission) return;
  if (!Number.isFinite(admission.deadline) || performance.now() >= admission.deadline)
    return new RemoteSshAdmissionError('expired');
  if (admission.isCurrent) {
    try {
      const verdict: unknown = admission.isCurrent();
      if (verdict instanceof Promise || (verdict && typeof (verdict as { then?: unknown }).then === 'function'))
        void Promise.resolve(verdict).catch(() => {});
      if (verdict === true) return;
    } catch {
      /* A throwing scope cannot admit work. */
    }
    return new RemoteSshAdmissionError('cancelled');
  }
  return undefined;
}

/** Test/diagnostic hook: remote calls currently holding a slot. */
export function getActiveRemoteSshCount(): number {
  return active;
}

/** Test/diagnostic hook: remote calls queued behind the cap. */
export function getQueuedRemoteSshCount(): number {
  return waiters.length;
}

/** The configured cap, so a test can assert against the real number. */
export function getRemoteSshLimit(): number {
  return MAX_CONCURRENT_REMOTE_SSH;
}

function acquire(admission?: RemoteSshAdmission): Promise<void> {
  const failure = admissionFailure(admission);
  if (failure) return Promise.reject(failure);
  if (active < MAX_CONCURRENT_REMOTE_SSH) {
    active++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (failure?: RemoteSshAdmissionError) => {
      settled = true;
      if (timer) clearTimeout(timer);
      const index = waiters.indexOf(grant);
      if (index !== -1) waiters.splice(index, 1);
      if (failure) reject(failure);
      else resolve();
    };
    const grant = () => {
      if (settled) return false;
      const failure = admissionFailure(admission);
      finish(failure);
      return !failure;
    };
    const check = () => {
      if (settled || !admission) return;
      const failure = admissionFailure(admission);
      if (failure) finish(failure);
      else
        timer = setTimeout(
          check,
          Math.min(admission.isCurrent ? 50 : Infinity, Math.ceil(admission.deadline - performance.now()))
        );
    };
    waiters.push(grant);
    if (admission) check();
  });
}

function release(): void {
  let next: (() => boolean) | undefined;
  while ((next = waiters.shift())) {
    // Hand the slot straight to the next waiter; `active` stays at the cap.
    if (next()) return;
  }
  active--;
}

/** A failed request may finish before its child closes; retain its slot until close. */
export type RetainRemoteSshSlot = (closed: Promise<unknown>) => void;

/** Run `task` once an ssh slot is free, retaining any registered child lifetimes. */
export async function runWithRemoteSshLimit<T>(
  task: (retain: RetainRemoteSshSlot) => Promise<T>,
  admission?: RemoteSshAdmission
): Promise<T> {
  await acquire(admission);
  const retained: Promise<unknown>[] = [];
  const retain: RetainRemoteSshSlot = (closed) => {
    retained.push(Promise.resolve(closed).catch(() => {}));
  };
  try {
    const failure = admissionFailure(admission);
    if (failure) throw failure;
    return await task(retain);
  } finally {
    if (retained.length) void Promise.all(retained).then(release);
    else release();
  }
}
