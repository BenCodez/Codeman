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

import {
  closeSync,
  constants,
  fstatSync,
  readSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getCli } from '../config/cli-registry/registry.js';
import { planRebootRestore } from '../reboot-restore.js';
import { dirname } from 'node:path';
import type { RebootRestoreEntry } from '../reboot-restore.js';

/**
 * A plan older than this is dropped on read. A machine that rebooted yesterday
 * has moved on, and an offer nobody took by then is noise rather than a rescue.
 */
const PLAN_TTL_MS = 24 * 60 * 60 * 1000;

type ParkedEntry = { entry: RebootRestoreEntry; spender: string | undefined };
type SnapshotWriter = (path: string, text: string) => void;

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

/** Preserve unreadable, malformed and replaced journals instead of overwriting them. */
function readSnapshotBytes(path: string): string | undefined {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SNAPSHOT_BYTES)
    throw new Error('Restore offer journal is unreadable');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    const matches = (current: typeof before) =>
      current.isFile() &&
      !current.isSymbolicLink() &&
      current.dev === stat.dev &&
      current.ino === stat.ino &&
      current.size === stat.size &&
      current.mtimeMs === stat.mtimeMs &&
      current.ctimeMs === stat.ctimeMs;
    if (!matches(before)) throw new Error('Restore offer journal changed');
    const bytes = Buffer.alloc(before.size);
    if (
      readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length ||
      !matches(fstatSync(fd)) ||
      !matches(lstatSync(path))
    )
      throw new Error('Restore offer journal changed');
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('Restore offer journal is malformed');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Restore offer journal is malformed');
    }
    validateSnapshot(parsed);
    return text;
  } finally {
    closeSync(fd);
  }
}

function replaceSnapshot(path: string, text: string): void {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    const directory = openSync(dirname(path), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* already renamed */
    }
  }
}

function writeAtomicSnapshot(path: string, text: string): void {
  // A surviving shadow marks an earlier unacknowledged replacement. It remains
  // authoritative until a retry commits; current pathname contents alone cannot.
  const current = readSnapshotBytes(path);
  const shadowPath = `${path}.previous`;
  const previous = readSnapshotBytes(shadowPath) ?? current ?? JSON.stringify({ version: 1, builtAt: 0, entries: [] });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  replaceSnapshot(shadowPath, previous);
  try {
    replaceSnapshot(path, text);
  } catch (error) {
    // The rename may have succeeded before directory acknowledgement failed.
    // Keep the durable shadow even if this bounded rollback also cannot fsync.
    try {
      replaceSnapshot(path, previous);
    } catch {
      /* shadow still preserves the old snapshot */
    }
    throw error;
  }
  // Reclaim only after the primary acknowledgement. A surviving/reappearing
  // shadow remains a conservative prior offer, with its original expiry and
  // explicit-restore checks. A known cleanup failure is still surfaced.
  try {
    unlinkSync(shadowPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      try {
        replaceSnapshot(path, previous);
      } catch {
        /* retain the shadow on uncertain rollback */
      }
      throw error;
    }
  }
}

export class RebootRestoreRegistry {
  private persistencePath?: string;
  private persistenceLoadFailed = false;

  constructor(private readonly snapshotWriter: SnapshotWriter = writeAtomicSnapshot) {}

  /** Load the durable offer before pruning stale records. Bounded, private and versioned. */
  configurePersistence(path: string): void {
    if (this.persistencePath === path) return;
    this.persistencePath = path;
    this.persistenceLoadFailed = false;
    this.entries.clear();
    this.parked.clear();
    this.failedReleases.clear();
    this.builtAt = 0;
    try {
      const current = readSnapshotBytes(path);
      const raw = readSnapshotBytes(`${path}.previous`) ?? current;
      if (raw === undefined) return;
      const saved = validateSnapshot(JSON.parse(raw));
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
    } catch {
      this.persistenceLoadFailed = true;
      this.entries.clear();
      this.parked.clear();
      this.builtAt = 0;
      // Unreadable/corrupt originals remain available for owner inspection.
      return;
    }
    try {
      this.dropIfExpired();
    } catch {
      /* Retain the acknowledged snapshot; a later expiry read retries without granting it. */
    }
  }

  /** A dismiss/expiry supersedes even an entry already held by a restore. */
  isHeld(entry: RebootRestoreEntry, spender: string | undefined): boolean {
    this.dropIfExpired();
    const held = this.parked.get(entry.sessionId);
    return held?.entry === entry && held.spender === spender;
  }

  private persistState(
    entries: ReadonlyMap<string, RebootRestoreEntry>,
    parked: ReadonlyMap<string, ParkedEntry>,
    builtAt: number
  ): void {
    if (this.persistenceLoadFailed) throw new Error('Restore offer journal could not be loaded; refusing overwrite');
    if (!this.persistencePath) return;
    const path = this.persistencePath;
    const outstanding = [...entries.values(), ...[...parked.values()].map((held) => held.entry)];
    if (outstanding.length > 1000) throw new Error('Restore offer exceeds entry budget');
    const text = JSON.stringify({ version: 1, builtAt, entries: outstanding });
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('Restore offer exceeds storage budget');
    this.snapshotWriter(path, text);
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

  /** Replace the plan with what the boot pass found. An empty list clears it. */
  set(entries: readonly RebootRestoreEntry[]): void {
    const nextEntries = new Map(entries.map((entry) => [entry.sessionId, entry]));
    const nextBuiltAt = entries.length > 0 ? Date.now() : 0;
    this.persistState(nextEntries, new Map(), nextBuiltAt);
    this.entries = nextEntries;
    this.builtAt = nextBuiltAt;
    // Acknowledged fresh plans supersede old held work.
    this.parked.clear();
    this.failedReleases.clear();
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
    return [...this.entries.values()].filter((entry) => canAccess(entry.owner));
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
    const wanted = sessionIds ? new Set(sessionIds) : undefined;
    const taken: RebootRestoreEntry[] = [];
    for (const entry of [...this.entries.values()]) {
      if (wanted && !wanted.has(entry.sessionId)) continue;
      if (!canAccess(entry.owner)) continue;
      this.entries.delete(entry.sessionId);
      // Parked rather than forgotten: until this restore resolves the entry, a
      // dismiss still has to be able to reach and cancel it.
      this.parked.set(entry.sessionId, { entry, spender });
      taken.push(entry);
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
  releaseFlight(spender: string | undefined, keep: readonly RebootRestoreEntry[]): void {
    const wanted = new Set(keep.map((entry) => entry.sessionId));
    const nextEntries = new Map(this.entries);
    const nextParked = new Map(this.parked);
    let added = 0;
    for (const [sessionId, held] of nextParked) {
      if (held.spender !== spender) continue;
      nextParked.delete(sessionId);
      if (wanted.has(sessionId)) {
        nextEntries.set(sessionId, held.entry);
        added++;
      }
    }
    const nextBuiltAt = added > 0 && this.builtAt === 0 ? Date.now() : this.builtAt;
    try {
      this.persistState(nextEntries, nextParked, nextBuiltAt);
    } catch (error) {
      this.failedReleases.add(spender);
      throw error;
    }
    this.failedReleases.delete(spender);
    this.entries = nextEntries;
    this.parked = nextParked;
    this.builtAt = nextBuiltAt;
  }

  /** Drop the entries a viewer can see. Returns how many went. */
  clear(canAccess: (owner: string | undefined) => boolean): number {
    const nextEntries = new Map(this.entries);
    const nextParked = new Map(this.parked);
    const removable = [...nextEntries.values()].filter((entry) => canAccess(entry.owner));
    for (const entry of removable) nextEntries.delete(entry.sessionId);
    // Entries a restore is holding are dismissed by the same rule, so a dismiss
    // that lands mid-restore wins. Judged on the ENTRY's owner, exactly as above,
    // rather than on who happens to be restoring it.
    let parkedRemoved = 0;
    for (const [sessionId, held] of [...nextParked]) {
      if (!canAccess(held.entry.owner)) continue;
      nextParked.delete(sessionId);
      parkedRemoved += 1;
    }
    const nextBuiltAt = nextEntries.size === 0 && nextParked.size === 0 ? 0 : this.builtAt;
    // A dismiss is one transaction: the durable snapshot must commit before
    // isHeld() can begin cancelling a concurrent restore. If storage fails,
    // both the on-disk offer and all in-memory active/parked entries survive.
    this.persistState(nextEntries, nextParked, nextBuiltAt);
    this.entries = nextEntries;
    this.parked = nextParked;
    this.builtAt = nextBuiltAt;
    return removable.length + parkedRemoved;
  }

  /**
   * Claim the right to run a restore for one owner, or report that owner already
   * has one running. Callers that get `true` must call `endSpending()` in a
   * `finally` with the same owner.
   */
  beginSpending(owner?: string): boolean {
    if (this.spending.has(owner)) return false;
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
      this.entries.set(id, held.entry);
      this.parked.delete(id);
    }
  }

  /** Test hook: forget everything, including the single-flight claim. */
  reset(): void {
    this.entries.clear();
    this.parked.clear();
    this.builtAt = 0;
    this.spending.clear();
    this.failedReleases.clear();
    this.persistencePath = undefined;
    this.persistenceLoadFailed = false;
  }

  private dropIfExpired(): void {
    if (this.builtAt > 0 && Date.now() - this.builtAt > PLAN_TTL_MS) {
      // A restore that took entries just before the expiry must not hand them
      // back afterwards and give an expired plan another full day of life.
      this.persistState(new Map(), new Map(), 0);
      this.parked.clear();
      this.entries.clear();
      this.builtAt = 0;
    }
  }
}

/** Process-wide singleton, mirroring `approvalInbox`. */
export const rebootRestoreRegistry = new RebootRestoreRegistry();
