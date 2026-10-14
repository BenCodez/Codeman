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
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
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

function writeAtomicSnapshot(path: string, text: string): void {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
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

export class RebootRestoreRegistry {
  private persistencePath?: string;

  constructor(private readonly snapshotWriter: SnapshotWriter = writeAtomicSnapshot) {}

  /** Load the durable offer before pruning stale records. Bounded, private and versioned. */
  configurePersistence(path: string): void {
    if (this.persistencePath === path) return;
    this.persistencePath = path;
    this.entries.clear();
    this.parked.clear();
    this.builtAt = 0;
    try {
      if (!existsSync(path)) return;
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) return;
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      if (
        saved.version !== 1 ||
        !Number.isFinite(saved.builtAt) ||
        saved.builtAt <= 0 ||
        saved.builtAt > Date.now() ||
        !Array.isArray(saved.entries) ||
        saved.entries.length > 1000
      )
        return;
      const entries: RebootRestoreEntry[] = saved.entries;
      if (
        entries.some(
          (entry) =>
            !entry ||
            typeof entry.sessionId !== 'string' ||
            typeof entry.resumeConversationId !== 'string' ||
            typeof entry.workingDir !== 'string' ||
            !entry.state ||
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
        return;
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
      this.dropIfExpired();
    } catch {
      // An unreadable/corrupt offer never authorizes a process launch.
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
    if (!this.persistencePath) return;
    const path = this.persistencePath;
    const outstanding = [...entries.values(), ...[...parked.values()].map((held) => held.entry)];
    const text = JSON.stringify({ version: 1, builtAt, entries: outstanding });
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('Restore offer exceeds storage budget');
    this.snapshotWriter(path, text);
  }

  private persist(): void {
    this.persistState(this.entries, this.parked, this.builtAt);
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
  /**
   * Owners with a restore in flight, between its take and its last pane.
   * Keyed by owner so one user's restore does not turn another user's click into
   * a conflict; `take()` already guarantees no two callers get the same entry.
   * Single-user mode has one key, `undefined`, so it behaves as one global flight.
   */
  private spending = new Set<string | undefined>();

  /** Replace the plan with what the boot pass found. An empty list clears it. */
  set(entries: readonly RebootRestoreEntry[]): void {
    this.entries = new Map(entries.map((entry) => [entry.sessionId, entry]));
    this.builtAt = entries.length > 0 ? Date.now() : 0;
    // A fresh boot plan supersedes anything an in-flight restore still holds.
    this.parked.clear();
    this.persist();
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
    let added = 0;
    for (const [sessionId, held] of [...this.parked]) {
      if (held.spender !== spender) continue;
      this.parked.delete(sessionId);
      // Still parked means nothing cancelled it while the restore ran. A dismiss,
      // an expiry or a fresh boot plan removes it from `parked`, and then it does
      // not come back however the restore ended.
      if (wanted.has(sessionId)) {
        this.entries.set(sessionId, held.entry);
        added += 1;
      }
    }
    if (added > 0 && this.builtAt === 0) this.builtAt = Date.now();
    this.persist();
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
  }

  /** Test hook: forget everything, including the single-flight claim. */
  reset(): void {
    this.entries.clear();
    this.parked.clear();
    this.builtAt = 0;
    this.spending.clear();
    this.persistencePath = undefined;
  }

  private dropIfExpired(): void {
    if (this.builtAt > 0 && Date.now() - this.builtAt > PLAN_TTL_MS) {
      // A restore that took entries just before the expiry must not hand them
      // back afterwards and give an expired plan another full day of life.
      this.parked.clear();
      this.entries.clear();
      this.builtAt = 0;
      this.persist();
    }
  }
}

/** Process-wide singleton, mirroring `approvalInbox`. */
export const rebootRestoreRegistry = new RebootRestoreRegistry();
