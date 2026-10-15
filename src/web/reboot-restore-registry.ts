/**
 * @fileoverview The pending restore plan: what a host reboot destroyed, waiting on a click.
 *
 * The boot pass builds this plan inside `restoreMuxSessions()`, in the window
 * where reconciliation has reported the dead sessions and `cleanupStaleSessions()`
 * has not pruned their records yet. The board then offers "restore N sessions
 * from before the reboot", and `web/routes/reboot-restore-routes` spends the plan
 * when the user clicks.
 *
 * Invariants:
 * - A private atomic snapshot keeps outstanding offers across server restarts.
 *   Entries held by an unfinished restore remain in the snapshot until resolved.
 *   Live-session checks prevent a crash after launch from duplicating a pane.
 * - No Session import: ownership and concurrency stay independent of launching.
 * - Spending is take-then-build: `take()` removes entries synchronously, before
 *   the route's first `await`, so a double-click or two devices cannot both
 *   reach the same entry and put two panes on one conversation.
 * - One restore runs at a time per owner. `beginSpending()` single-flights the
 *   route, so two concurrent clicks cannot interleave pane creation for the same
 *   user, while two different users never block each other.
 *
 * @dependencies reboot-restore (RebootRestoreEntry)
 * @consumedby web/server (plan build at boot), web/routes/reboot-restore-routes
 *
 * @module web/reboot-restore-registry
 */

import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { getCli } from '../config/cli-registry/registry.js';
import { planRebootRestore } from '../reboot-restore.js';
import { dirname, join } from 'node:path';
import type { RebootRestoreEntry } from '../reboot-restore.js';

/**
 * A plan older than this is dropped on read. A machine that rebooted yesterday
 * has moved on, and an offer nobody took by then is noise rather than a rescue.
 */
const PLAN_TTL_MS = 24 * 60 * 60 * 1000;

type ParkedEntry = { entry: RebootRestoreEntry; spender: string | undefined };
type SnapshotWriter = (path: string, text: string, isCurrent?: () => boolean) => void | Promise<void>;

const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

function validateSnapshot(value: unknown): { builtAt: number; entries: RebootRestoreEntry[] } {
  const saved = value as { version?: unknown; builtAt: number; entries: RebootRestoreEntry[] };
  if (
    !saved ||
    typeof saved !== 'object' ||
    Array.isArray(saved) ||
    saved.version !== 1 ||
    !Number.isFinite(saved.builtAt) ||
    saved.builtAt < 0 ||
    saved.builtAt > Date.now() ||
    !Array.isArray(saved.entries) ||
    saved.entries.length > 1000 ||
    (saved.entries.length > 0 && saved.builtAt === 0)
  )
    throw new Error('Invalid restore offer journal');
  if (
    saved.entries.some(
      (entry) =>
        !entry ||
        typeof entry !== 'object' ||
        Array.isArray(entry) ||
        typeof entry.sessionId !== 'string' ||
        typeof entry.resumeConversationId !== 'string' ||
        !entry.resumeConversationId ||
        typeof entry.workingDir !== 'string' ||
        !entry.state ||
        typeof entry.state !== 'object' ||
        Array.isArray(entry.state) ||
        entry.state.id !== entry.sessionId ||
        entry.state.remote ||
        entry.state.docker ||
        typeof entry.mode !== 'string' ||
        (entry.owner !== undefined && typeof entry.owner !== 'string') ||
        entry.owner !== entry.state.owner ||
        entry.workingDir !== entry.state.workingDir ||
        entry.mode !== (entry.state.mode ?? 'claude')
    )
  )
    throw new Error('Invalid restore offer entries');
  return saved;
}

/** Every private descriptor closes before its final pathname verdict. */
type SnapshotFile = { text: string; stat: Stats };
type WrittenSnapshot = { text: string; dev: number; ino: number };
const sameSnapshotStat = (a: Stats, b: Stats) =>
  ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'mode'].every((key) => a[key as keyof Stats] === b[key as keyof Stats]);

async function readSnapshot(path: string, validate = true): Promise<SnapshotFile | undefined> {
  let before: Stats;
  try {
    before = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_SNAPSHOT_BYTES)
    throw new Error('Restore offer journal is unreadable');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let text: string;
  try {
    if (!sameSnapshotStat(before, await file.stat())) throw new Error('Restore offer journal changed');
    const bytes = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const next = await file.read(bytes, size, bytes.length - size, size);
      if (!next.bytesRead) break;
      size += next.bytesRead;
    }
    if (size !== before.size || !sameSnapshotStat(before, await file.stat()))
      throw new Error('Restore offer journal changed');
    text = bytes.subarray(0, size).toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes.subarray(0, size)))
      throw new Error('Restore offer journal is malformed');
  } finally {
    await file.close();
  }
  if (!sameSnapshotStat(before, await lstat(path))) throw new Error('Restore offer journal changed');
  if (validate) validateSnapshot(JSON.parse(text));
  return { text, stat: before };
}

async function matchesSnapshot(path: string, expected: SnapshotFile | undefined): Promise<boolean> {
  const current = await readSnapshot(path, false);
  return expected === undefined
    ? current === undefined
    : !!current && sameSnapshotStat(expected.stat, current.stat) && current.text === expected.text;
}
async function ownsSnapshot(path: string, expected: WrittenSnapshot | undefined): Promise<boolean> {
  if (!expected) return false;
  const current = await readSnapshot(path, false);
  return (
    !!current &&
    current.stat.dev === expected.dev &&
    current.stat.ino === expected.ino &&
    current.text === expected.text
  );
}
async function syncSnapshotDirectory(path: string): Promise<void> {
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function replaceSnapshot(
  path: string,
  text: string,
  mayReplace: () => Promise<boolean>,
  attempted: (candidate: WrittenSnapshot) => void,
  isCurrent: () => boolean = () => true
): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  let temporaryOwner: { dev: number; ino: number } | undefined;
  try {
    const file = await open(temporary, 'wx', 0o600);
    let candidate: WrittenSnapshot;
    try {
      const opened = await file.stat();
      temporaryOwner = { dev: opened.dev, ino: opened.ino };
      await file.writeFile(text);
      await file.sync();
      const stat = await file.stat();
      candidate = { text, dev: stat.dev, ino: stat.ino };
    } finally {
      await file.close();
    }
    const prepared = await readSnapshot(temporary, false);
    if (
      !prepared ||
      prepared.stat.dev !== candidate.dev ||
      prepared.stat.ino !== candidate.ino ||
      prepared.text !== candidate.text ||
      !(await mayReplace()) ||
      !sameSnapshotStat(prepared.stat, await lstat(temporary)) ||
      !isCurrent()
    )
      throw new Error('Restore offer journal changed');
    attempted(candidate);
    await rename(temporary, path);
    await syncSnapshotDirectory(path);
  } finally {
    // A failed exclusive open never owns a pre-existing path. A replacement
    // likewise belongs to somebody else, even when its bytes happen to match.
    if (temporaryOwner) {
      const current = await lstat(temporary).catch(() => undefined);
      if (
        current?.isFile() &&
        !current.isSymbolicLink() &&
        current.dev === temporaryOwner.dev &&
        current.ino === temporaryOwner.ino
      )
        await unlink(temporary).catch(() => {});
    }
  }
}

/** Archive only the exact unacknowledged primary; damaged bytes are never parsed. */
async function preserveUnacknowledgedPrimary(path: string, isCurrent: () => boolean): Promise<void> {
  let original: Stats;
  try {
    original = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!original.isFile() || original.isSymbolicLink()) throw new Error('Restore offer journal is unreadable');
  const directory = `${path}.unacknowledged-${randomUUID()}`;
  await mkdir(directory, { mode: 0o700 });
  await syncSnapshotDirectory(path);
  if (!sameSnapshotStat(original, await lstat(path)) || !isCurrent()) throw new Error('Restore offer journal changed');
  const preserved = join(directory, 'primary');
  await rename(path, preserved);
  const moved = await lstat(preserved);
  if (
    !moved.isFile() ||
    moved.isSymbolicLink() ||
    moved.dev !== original.dev ||
    moved.ino !== original.ino ||
    moved.size !== original.size ||
    moved.mtimeMs !== original.mtimeMs ||
    moved.mode !== original.mode ||
    moved.ctimeMs < original.ctimeMs
  )
    throw new Error('Restore offer journal changed');
  const file = await open(preserved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!sameSnapshotStat(moved, await file.stat())) throw new Error('Restore offer journal changed');
    await file.chmod(0o600);
  } finally {
    await file.close();
  }
  const final = await lstat(preserved);
  if (
    !final.isFile() ||
    final.isSymbolicLink() ||
    final.dev !== moved.dev ||
    final.ino !== moved.ino ||
    final.size !== moved.size ||
    final.mtimeMs !== moved.mtimeMs ||
    final.ctimeMs < moved.ctimeMs ||
    (final.mode & 0o777) !== 0o600
  )
    throw new Error('Restore offer journal changed');
  await syncSnapshotDirectory(preserved);
  await syncSnapshotDirectory(path);
}

async function writeAtomicSnapshot(path: string, text: string, isCurrent: () => boolean = () => true): Promise<void> {
  const shadowPath = `${path}.previous`;
  const shadow = await readSnapshot(shadowPath);
  const primary = shadow ? undefined : await readSnapshot(path);
  const previous = shadow?.text ?? primary?.text ?? JSON.stringify({ version: 1, builtAt: 0, entries: [] });
  if (shadow) await preserveUnacknowledgedPrimary(path, isCurrent);
  if (!isCurrent()) throw new Error('Restore offer transaction was cancelled');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let shadowCandidate: WrittenSnapshot | undefined, primaryCandidate: WrittenSnapshot | undefined;
  await replaceSnapshot(
    shadowPath,
    previous,
    () => matchesSnapshot(shadowPath, shadow),
    (candidate) => {
      shadowCandidate = candidate;
    },
    isCurrent
  );
  try {
    await replaceSnapshot(
      path,
      text,
      () => matchesSnapshot(path, primary),
      (candidate) => {
        primaryCandidate = candidate;
      },
      isCurrent
    );
  } catch (error) {
    try {
      await replaceSnapshot(
        path,
        previous,
        () => ownsSnapshot(path, primaryCandidate),
        () => {}
      );
    } catch {
      /* The durable shadow retains the acknowledged previous snapshot. */
    }
    throw error;
  }
  try {
    if (!(await ownsSnapshot(shadowPath, shadowCandidate)) || !isCurrent())
      throw new Error('Restore offer journal changed');
    await unlink(shadowPath);
    await syncSnapshotDirectory(path);
    if (!isCurrent() || !(await ownsSnapshot(path, primaryCandidate))) throw new Error('Restore offer journal changed');
  } catch (error) {
    try {
      await replaceSnapshot(
        shadowPath,
        previous,
        async () => {
          const current = await readSnapshot(shadowPath, false);
          return (
            current === undefined ||
            (!!shadowCandidate &&
              current.stat.dev === shadowCandidate.dev &&
              current.stat.ino === shadowCandidate.ino &&
              current.text === shadowCandidate.text)
          );
        },
        () => {}
      );
    } catch {
      /* Still attempt to restore only this invocation's primary. */
    }
    try {
      await replaceSnapshot(
        path,
        previous,
        () => ownsSnapshot(path, primaryCandidate),
        () => {}
      );
    } catch {
      /* A surviving shadow retains the prior snapshot on uncertain rollback. */
    }
    throw error;
  }
}

export class RebootRestoreRegistry {
  private persistencePath?: string;
  private persistenceLoadFailed = false;
  private writes: Promise<unknown> = Promise.resolve();
  private readonly pendingWrites = new Set<symbol>();
  private persistenceWriteFailed = false;
  private loading = false;
  private epoch = 0;
  private stateRevision = 0;
  private expired = false;
  private expiryScheduled = false;
  private revoked = new WeakSet<RebootRestoreEntry>();
  private configurationWork?: Promise<void>;

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const epoch = this.epoch,
      token = Symbol();
    this.pendingWrites.add(token);
    const result = this.writes.then(async () => {
      if (this.epoch !== epoch) throw new Error('Restore offer transaction was superseded');
      const value = await action();
      if (this.epoch !== epoch) throw new Error('Restore offer transaction was superseded');
      return value;
    });
    const tracked = result
      .catch((error: unknown) => {
        if (this.epoch === epoch) this.persistenceWriteFailed = true;
        throw error;
      })
      .finally(() => {
        this.pendingWrites.delete(token);
      });
    this.writes = tracked.catch(() => {});
    return tracked;
  }

  async flush(): Promise<void> {
    while (this.pendingWrites.size) await this.writes;
  }

  constructor(private readonly snapshotWriter: SnapshotWriter = writeAtomicSnapshot) {}

  /** Load the durable offer before pruning stale records. Bounded, private and versioned. */
  configurePersistence(path: string): Promise<void> {
    if (this.persistencePath === path) return this.configurationWork ?? Promise.resolve();
    this.epoch++;
    this.persistencePath = path;
    this.persistenceLoadFailed = false;
    this.persistenceWriteFailed = false;
    this.loading = true;
    for (const held of this.parked.values()) this.revoked.add(held.entry);
    this.entries.clear();
    this.parked.clear();
    this.failedReleases.clear();
    this.builtAt = 0;
    this.expired = false;
    const epoch = this.epoch;
    const work = this.enqueue(async () => {
      try {
        const raw = (await readSnapshot(`${path}.previous`)) ?? (await readSnapshot(path));
        if (this.epoch !== epoch) return;
        if (raw) {
          const saved = validateSnapshot(JSON.parse(raw.text));
          const entries = saved.entries;
          const eligible = planRebootRestore(
            entries.map((entry) => entry.sessionId),
            Object.fromEntries(entries.map((entry) => [entry.sessionId, entry.state])),
            () => true,
            new Map(
              entries
                .filter((entry) => getCli(entry.mode)?.capabilities.recovery === 'codex-rollout')
                .map((entry) => [entry.sessionId, entry.resumeConversationId])
            )
          );
          const ids = new Set(eligible.restore.map((entry) => entry.sessionId));
          this.entries = new Map(
            entries.filter((entry) => ids.has(entry.sessionId)).map((entry) => [entry.sessionId, entry])
          );
          this.builtAt = saved.builtAt;
          this.stateRevision++;
        }
      } catch {
        if (this.epoch !== epoch) return;
        this.persistenceLoadFailed = true;
        this.entries.clear();
        this.parked.clear();
        this.builtAt = 0;
      } finally {
        if (this.epoch === epoch) this.loading = false;
      }
    });
    this.configurationWork = work;
    return work.then(() => {
      if (this.epoch === epoch) this.dropIfExpired();
    });
  }

  /** A dismiss/expiry supersedes even an entry already held by a restore. */
  isHeld(entry: RebootRestoreEntry, spender: string | undefined): boolean {
    this.dropIfExpired();
    const held = this.parked.get(entry.sessionId);
    return (
      !this.loading &&
      !this.expired &&
      !this.persistenceWriteFailed &&
      !this.revoked.has(entry) &&
      held?.entry === entry &&
      held.spender === spender
    );
  }

  private async persistState(
    entries: ReadonlyMap<string, RebootRestoreEntry>,
    parked: ReadonlyMap<string, ParkedEntry>,
    builtAt: number
  ): Promise<void> {
    if (this.persistenceLoadFailed) throw new Error('Restore offer journal could not be loaded; refusing overwrite');
    if (!this.persistencePath) return;
    const path = this.persistencePath;
    const outstanding = [...entries.values(), ...[...parked.values()].map((held) => held.entry)];
    if (outstanding.length > 1000) throw new Error('Restore offer exceeds entry budget');
    const text = JSON.stringify({ version: 1, builtAt, entries: outstanding });
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('Restore offer exceeds storage budget');
    const epoch = this.epoch;
    const current = () =>
      this.epoch === epoch &&
      this.persistencePath === path &&
      JSON.stringify({ version: 1, builtAt, entries: outstanding }) === text;
    if (!current()) throw new Error('Restore offer transaction was superseded');
    await this.snapshotWriter(path, text, current);
    if (!current()) throw new Error('Restore offer transaction was superseded');
    this.persistenceWriteFailed = false;
  }

  /** Keyed by session id, in the order the boot pass found them. */
  private entries = new Map<string, RebootRestoreEntry>();
  /** When the boot pass built the plan, in ms since the epoch. */
  private builtAt = 0;
  /**
   * Entries handed to a restore that has not finished, by session id, each
   * remembering which caller is spending it.
   *
   * A taken entry is still part of the offer until its restore resolves it, so
   * it has to stay reachable by everything that can invalidate an offer. Holding
   * the entries themselves — rather than a counter to compare against later —
   * means `clear()` filters them by the SAME `canAccess(entry.owner)` predicate
   * it already applies to the plan. A counter cannot do that, because the caller
   * spending an entry need not be its owner: an admin may restore another user's
   * sessions, and then the spender and the owner are different keys.
   */
  private parked = new Map<string, ParkedEntry>();
  private failedReleases = new Set<string | undefined>();
  /**
   * Owners with a restore in flight, between its take and its last pane.
   * Keyed by owner so one user's restore does not turn another user's click into
   * a conflict; `take()` already guarantees no two callers get the same entry.
   * Single-user mode has one key, `undefined`, so it behaves as one global flight.
   */
  private spending = new Set<string | undefined>();

  /** Pure private ownership snapshot: cleanup must never expire or spend an offer. */
  getBrokerCleanupState(): { entries: RebootRestoreEntry[]; parked: ParkedEntry[] } | undefined {
    if (
      this.persistenceLoadFailed ||
      this.persistenceWriteFailed ||
      this.loading ||
      this.pendingWrites.size > 0 ||
      this.spending.size > 0 ||
      this.failedReleases.size > 0
    )
      return undefined;
    return structuredClone({ entries: [...this.entries.values()], parked: [...this.parked.values()] });
  }

  /** Replace the plan with what the boot pass found. An empty list clears it. */
  set(entries: readonly RebootRestoreEntry[]): Promise<void> {
    const nextEntries = new Map(entries.map((entry) => [entry.sessionId, entry]));
    const nextBuiltAt = entries.length > 0 ? Date.now() : 0;
    try {
      if (nextEntries.size > 1000) throw new Error('Restore offer exceeds entry budget');
      if (
        Buffer.byteLength(JSON.stringify({ version: 1, builtAt: nextBuiltAt, entries: [...nextEntries.values()] })) >
        MAX_SNAPSHOT_BYTES
      )
        throw new Error('Restore offer exceeds storage budget');
    } catch (error) {
      return Promise.reject(error);
    }
    for (const held of this.parked.values()) this.revoked.add(held.entry);
    const publish = () => {
      this.entries = nextEntries;
      this.builtAt = nextBuiltAt;
      this.parked.clear();
      this.failedReleases.clear();
      this.expired = false;
      this.stateRevision++;
    };
    if (!this.persistencePath) {
      publish();
      return Promise.resolve();
    }
    return this.enqueue(async () => {
      await this.persistState(nextEntries, new Map(), nextBuiltAt);
      publish();
    });
  }

  /**
   * The entries a viewer may see, newest plan first-come order preserved.
   *
   * @param canAccess Ownership predicate, so a user sees their own entries and
   *   an admin sees all. Applied here rather than in the route so the count the
   *   banner shows and the entries a click spends come from one filter.
   */
  list(canAccess: (owner: string | undefined) => boolean): RebootRestoreEntry[] {
    this.dropIfExpired();
    return this.expired || this.loading ? [] : [...this.entries.values()].filter((entry) => canAccess(entry.owner));
  }

  /** Include a restore already in flight when retaining an absent session's role. */
  hasOutstanding(sessionId: string): boolean {
    this.dropIfExpired();
    return this.entries.has(sessionId) || this.parked.has(sessionId);
  }

  /**
   * Remove and return the entries a click is about to spend.
   *
   * Synchronous and total: an entry leaves the plan here, before any pane is
   * created, so a second click finds nothing to spend. Entries a caller may not
   * access are left in place, and unknown ids are ignored.
   *
   * @param sessionIds The ids to spend, or undefined for every visible entry.
   */
  take(
    canAccess: (owner: string | undefined) => boolean,
    sessionIds: readonly string[] | undefined,
    spender: string | undefined
  ): RebootRestoreEntry[] {
    this.dropIfExpired();
    if (this.loading || this.expired || this.persistenceWriteFailed || this.pendingWrites.size) return [];
    const wanted = sessionIds ? new Set(sessionIds) : undefined;
    const taken: RebootRestoreEntry[] = [];
    for (const entry of [...this.entries.values()]) {
      if (wanted && !wanted.has(entry.sessionId)) continue;
      if (!canAccess(entry.owner)) continue;
      this.entries.delete(entry.sessionId);
      // Parked rather than forgotten: until this restore resolves the entry, a
      // dismiss still has to be able to reach and cancel it.
      // A fresh explicit click gets a fresh identity after an earlier cancelled
      // flight. Its old held callback can never regain authority.
      const heldEntry = this.revoked.has(entry) ? structuredClone(entry) : entry;
      this.parked.set(entry.sessionId, { entry: heldEntry, spender });
      taken.push(heldEntry);
    }
    // Parking leaves the durable outstanding offer unchanged until the flight resolves.
    return taken;
  }

  /**
   * Put entries back after a rebuild never got as far as creating a pane.
   *
   * Used for the click-time rejections that may resolve themselves: a workspace
   * that comes back, a capacity limit the user makes room under, a CLI that
   * starts once its binary is on the PATH. A conversation the user resumed by
   * hand is NOT put back, because that one cannot stop being true, and an entry
   * the banner keeps re-offering forever is noise only Dismiss can clear.
   */
  releaseFlight(spender: string | undefined, keep: readonly RebootRestoreEntry[]): Promise<void> {
    const captured = new Map([...this.parked].filter(([, held]) => held.spender === spender));
    const wanted = new Set(keep.map((entry) => entry.sessionId));
    const transition = () => {
      const nextEntries = new Map(this.entries),
        nextParked = new Map(this.parked);
      for (const [id, held] of captured) {
        if (nextParked.get(id) !== held) continue;
        nextParked.delete(id);
        if (!this.expired && wanted.has(id)) nextEntries.set(id, held.entry);
      }
      return { nextEntries, nextParked };
    };
    const publish = (next: ReturnType<typeof transition>) => {
      this.entries = next.nextEntries;
      this.parked = next.nextParked;
      if (!this.entries.size && !this.parked.size) this.builtAt = 0;
      this.failedReleases.delete(spender);
      this.stateRevision++;
    };
    if (!this.persistencePath) {
      publish(transition());
      return Promise.resolve();
    }
    return this.enqueue(async () => {
      const next = transition();
      try {
        await this.persistState(next.nextEntries, next.nextParked, this.builtAt);
      } catch (error) {
        this.failedReleases.add(spender);
        throw error;
      }
      publish(next);
    });
  }

  /** Drop the entries a viewer can see. Returns how many went. */
  clear(canAccess: (owner: string | undefined) => boolean): Promise<number> {
    const captured = new Set([
      ...[...this.entries.values()].filter((entry) => canAccess(entry.owner)),
      ...[...this.parked.values()].filter((held) => canAccess(held.entry.owner)).map((held) => held.entry),
    ]);
    // Owner intent is immediate even while fsync is held. A failed acknowledgement
    // retains the old journal, never revives that already-withdrawn launch authority.
    for (const entry of captured) this.revoked.add(entry);
    const transition = () => {
      const nextEntries = new Map(this.entries),
        nextParked = new Map(this.parked);
      let removed = 0;
      const removedSpenders = new Set<string | undefined>();
      for (const [id, entry] of nextEntries)
        if (captured.has(entry)) {
          nextEntries.delete(id);
          removed++;
        }
      for (const [id, held] of nextParked)
        if (captured.has(held.entry)) {
          nextParked.delete(id);
          removedSpenders.add(held.spender);
          removed++;
        }
      return {
        nextEntries,
        nextParked,
        removed,
        removedSpenders,
        builtAt: nextEntries.size || nextParked.size ? this.builtAt : 0,
      };
    };
    const publish = (next: ReturnType<typeof transition>) => {
      this.entries = next.nextEntries;
      this.parked = next.nextParked;
      this.builtAt = next.builtAt;
      // This acknowledged snapshot has removed all held entries for these
      // spenders. Keep unrelated failed flights until their own complete ACK.
      for (const spender of next.removedSpenders) {
        if (![...next.nextParked.values()].some((held) => held.spender === spender))
          this.failedReleases.delete(spender);
      }
      this.stateRevision++;
      return next.removed;
    };
    if (!this.persistencePath) return Promise.resolve(publish(transition()));
    return this.enqueue(async () => {
      const next = transition();
      await this.persistState(next.nextEntries, next.nextParked, next.builtAt);
      return publish(next);
    });
  }

  /**
   * Claim the right to run a restore for one owner, or report that owner already
   * has one running. Callers that get `true` must call `endSpending()` in a
   * `finally` with the same owner.
   */
  beginSpending(owner?: string): boolean {
    this.dropIfExpired();
    if (
      this.spending.has(owner) ||
      this.loading ||
      this.expired ||
      this.persistenceWriteFailed ||
      this.pendingWrites.size
    )
      return false;
    this.spending.add(owner);
    return true;
  }

  endSpending(owner?: string): void {
    this.spending.delete(owner);
    if (!this.failedReleases.delete(owner)) return;
    // A failed release retained the acknowledged outstanding set. End the
    // ephemeral lease without losing it or allowing a later empty take to
    // consume orphaned parks. Any actual/live worker still vetoes a new restore.
    for (const [id, held] of this.parked) {
      if (held.spender !== owner) continue;
      if (!this.expired) this.entries.set(id, held.entry);
      this.parked.delete(id);
    }
  }

  /** Test hook: forget everything, including the single-flight claim. */
  reset(): void {
    this.epoch++;
    this.revoked = new WeakSet();
    this.persistenceWriteFailed = false;
    this.loading = false;
    this.expired = false;
    this.expiryScheduled = false;
    this.configurationWork = undefined;
    this.entries.clear();
    this.parked.clear();
    this.builtAt = 0;
    this.spending.clear();
    this.failedReleases.clear();
    this.persistencePath = undefined;
    this.persistenceLoadFailed = false;
  }

  private dropIfExpired(): void {
    if (!(this.builtAt > 0 && Date.now() - this.builtAt > PLAN_TTL_MS)) return;
    this.expired = true;
    for (const held of this.parked.values()) this.revoked.add(held.entry);
    if (this.expiryScheduled) return;
    const revision = this.stateRevision;
    const publish = () => {
      this.entries.clear();
      this.parked.clear();
      this.builtAt = 0;
      this.expired = false;
      this.stateRevision++;
    };
    if (!this.persistencePath) {
      publish();
      return;
    }
    this.expiryScheduled = true;
    void this.enqueue(async () => {
      if (revision !== this.stateRevision) return;
      await this.persistState(new Map(), new Map(), 0);
      if (revision === this.stateRevision) publish();
    })
      .catch(() => {
        /* Old bytes remain evidence; expiry never grants authority. */
      })
      .finally(() => {
        this.expiryScheduled = false;
      });
  }
}

/** Process-wide singleton, mirroring `approvalInbox`. */
export const rebootRestoreRegistry = new RebootRestoreRegistry();
