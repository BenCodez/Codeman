/**
 * @fileoverview Fail-closed attribution of an isolated Codex pane to its rollout.
 *
 * This is an INTERNAL recovery reader: path/head/tail may contain private prompts and
 * must never be returned in an API response. Shared-daemon launches have no per-pane
 * originator authority. Neither cwd, file mtime nor a timestamp-only history match
 * authorizes recovery. A truncated, unreadable or over-budget store supplies no id.
 *
 * All filesystem work is asynchronous and serial within one home. An outstanding
 * operation retains its single-flight slot even after the caller's deadline expires,
 * so a stalled network filesystem cannot accumulate new workers on every tick.
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, parse, resolve, sep } from 'node:path';

export interface CodexIdentityRequest {
  sessionId: string;
  workingDir: string;
  codexHome?: string;
  resumeId?: string;
  noDaemon: boolean;
  submission?: { at: number; hash: string };
  previousId?: string;
}

export interface CodexIdentityResult {
  conversationId?: string;
  path?: string;
  reason: 'verified' | 'managed-daemon' | 'ambiguous' | 'unverified' | 'unreadable';
  head?: string;
  tail?: string;
}

const HEAD_BYTES = 128 * 1024;
const TAIL_BYTES = 256 * 1024;
const HISTORY_BYTES = 256 * 1024;
const HISTORY_WINDOW_MS = 2_000;
const WALL_CLOCK_MS = 2_000;
const MAX_FILES = 1_024;
const MAX_DIRECTORIES = 256;
const MAX_ENTRIES = 8_192;
const MAX_DEPTH = 5;
const MAX_HOME_COMPONENTS = 32;
const MAX_PENDING_HOMES = 2;
const UUID_SOURCE = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const UUID = new RegExp(`^${UUID_SOURCE}$`);
const ROLLOUT_NAME = new RegExp(`^rollout-[A-Za-z0-9T:._+-]+-(${UUID_SOURCE})\\.jsonl$`);

type RefusalReason = 'ambiguous' | 'unverified' | 'unreadable';

class Refusal extends Error {
  constructor(readonly reason: RefusalReason) {
    super(reason);
  }
}

interface RolloutIdentity {
  id: string;
  cwd: string;
  originator?: string;
  createdAt: number;
  subagent: boolean;
  path: string;
}

interface HistoryEntry {
  id: string;
  at: number;
  hash: string;
}

class Budget {
  readonly deadline = performance.now() + WALL_CLOCK_MS;
  files = 0;
  directories = 0;
  entries = 0;

  check(): void {
    if (performance.now() >= this.deadline) throw new Refusal('unreadable');
  }
}

const pendingHomes = new Map<string, { key: string; deadline: number; promise: Promise<CodexIdentityResult> }>();

/** Hash the exact submitted UTF-8 text. Whitespace, newlines and Unicode are not normalized. */
export function hashCodexPrompt(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}

function isAbsent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function checked<T>(budget: Budget, operation: () => Promise<T>): Promise<T> {
  budget.check();
  const value = await operation();
  budget.check();
  return value;
}

/** Validate every ancestor, without enumerating any directory outside this home. */
async function validateHome(home: string, budget: Budget): Promise<void> {
  const root = parse(home).root;
  const components = home.slice(root.length).split(sep).filter(Boolean);
  if (components.length > MAX_HOME_COMPONENTS) throw new Refusal('unverified');
  let path = root;
  for (const component of components) {
    path = join(path, component);
    const stat = await checked(budget, () => fs.lstat(path));
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Refusal('unverified');
  }
}

async function readWindow(
  path: string,
  bytes: number,
  tail: boolean,
  budget: Budget
): Promise<{ text: string; truncated: boolean }> {
  const before = await checked(budget, () => fs.lstat(path));
  if (before.isSymbolicLink() || !before.isFile()) throw new Refusal('unverified');
  budget.check();
  // Acquire outside checked(): if open finishes after the deadline, the handle must
  // still reach this finally block instead of being lost in the deadline check.
  const file = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    budget.check();
    const stat = await checked(budget, () => file.stat());
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev) throw new Refusal('unverified');
    const length = Math.min(bytes, stat.size);
    const buffer = Buffer.alloc(length);
    const offset = tail ? Math.max(0, stat.size - length) : 0;
    const { bytesRead } = await checked(budget, () => file.read(buffer, 0, length, offset));
    if (bytesRead !== length) throw new Refusal('unverified');
    let text = buffer.toString('utf8');
    const truncated = stat.size > bytes;
    if (tail && truncated) {
      const newline = text.indexOf('\n');
      if (newline < 0) throw new Refusal('unverified');
      text = text.slice(newline + 1);
    }
    return { text, truncated };
  } finally {
    // Retain the single-flight slot until this settles too: close can block on a mount.
    await file.close();
  }
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseRolloutHeader(path: string, head: string): RolloutIdentity {
  const filenameId = ROLLOUT_NAME.exec(basename(path))?.[1];
  const newline = head.indexOf('\n');
  if (!filenameId || newline < 0) throw new Refusal('unverified');
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(head.slice(0, newline));
  } catch {
    throw new Refusal('unverified');
  }
  if (!entry || entry.type !== 'session_meta' || !entry.payload || typeof entry.payload !== 'object') {
    throw new Refusal('unverified');
  }
  const payload = entry.payload as Record<string, unknown>;
  const id = payload.id ?? payload.session_id;
  if (
    typeof id !== 'string' ||
    !UUID.test(id) ||
    id !== filenameId ||
    (payload.session_id !== undefined && payload.session_id !== id) ||
    typeof payload.cwd !== 'string' ||
    !isAbsolute(payload.cwd)
  ) {
    throw new Refusal('unverified');
  }
  const createdAt = timestamp(payload.timestamp ?? entry.timestamp);
  if (createdAt === undefined) throw new Refusal('unverified');
  if (payload.originator !== undefined && typeof payload.originator !== 'string') throw new Refusal('unverified');
  let subagent = false;
  for (const source of [payload.thread_source, payload.source]) {
    if (source === undefined) continue;
    if (typeof source === 'string') {
      if (source.toLowerCase().includes('subagent')) subagent = true;
    } else if (source && typeof source === 'object' && 'subagent' in source) {
      subagent = true;
    } else {
      throw new Refusal('unverified');
    }
  }
  return {
    id,
    cwd: resolve(payload.cwd),
    originator: payload.originator as string | undefined,
    createdAt,
    subagent,
    path,
  };
}

async function scanRollouts(home: string, budget: Budget): Promise<RolloutIdentity[]> {
  const files: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || ++budget.directories > MAX_DIRECTORIES) throw new Refusal('unverified');
    const stat = await checked(budget, () => fs.lstat(directory));
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Refusal('unverified');
    budget.check();
    // Stream entries in small batches: readdir() would allocate an arbitrarily large
    // listing before the entry budget got a chance to refuse it.
    const handle = await fs.opendir(directory, { bufferSize: 32 });
    try {
      budget.check();
      for (;;) {
        const entry = await checked(budget, () => handle.read());
        if (!entry) break;
        if (++budget.entries > MAX_ENTRIES) throw new Refusal('unverified');
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Refusal('unverified');
        if (entry.isDirectory()) {
          await visit(path, depth + 1);
        } else {
          if (++budget.files > MAX_FILES) throw new Refusal('unverified');
          if (!entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) continue;
          if (!entry.isFile() || !ROLLOUT_NAME.test(entry.name)) throw new Refusal('unverified');
          files.push(path);
        }
      }
    } finally {
      await handle.close();
    }
  };
  try {
    await visit(join(home, 'sessions'), 0);
  } catch (error) {
    if (isAbsent(error)) throw new Refusal('unverified');
    throw error;
  }
  const identities: RolloutIdentity[] = [];
  const seen = new Set<string>();
  for (const path of files) {
    const identity = parseRolloutHeader(path, (await readWindow(path, HEAD_BYTES, false, budget)).text);
    if (seen.has(identity.id)) throw new Refusal('ambiguous');
    seen.add(identity.id);
    identities.push(identity);
  }
  return identities;
}

async function matchingHistory(
  home: string,
  request: CodexIdentityRequest,
  budget: Budget
): Promise<HistoryEntry | undefined> {
  if (!request.submission) return undefined;
  let window: { text: string; truncated: boolean };
  try {
    window = await readWindow(join(home, 'history.jsonl'), HISTORY_BYTES, true, budget);
  } catch (error) {
    if (isAbsent(error)) throw new Refusal('unverified');
    throw error;
  }
  if (window.text && !window.text.endsWith('\n')) throw new Refusal('unverified');
  const history: HistoryEntry[] = [];
  for (const line of window.text.split('\n')) {
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Refusal('unverified');
    }
    if (
      !entry ||
      typeof entry.session_id !== 'string' ||
      !UUID.test(entry.session_id) ||
      typeof entry.ts !== 'number' ||
      !Number.isFinite(entry.ts) ||
      typeof entry.text !== 'string'
    ) {
      throw new Refusal('unverified');
    }
    history.push({ id: entry.session_id, at: entry.ts * 1000, hash: hashCodexPrompt(entry.text) });
  }
  if (history.some((entry, i) => i > 0 && entry.at < history[i - 1].at)) throw new Refusal('unverified');
  const lower = request.submission.at - HISTORY_WINDOW_MS;
  if (window.truncated && (!history.length || history[0].at >= lower)) throw new Refusal('unverified');
  const matches = history.filter(
    (entry) =>
      entry.hash === request.submission!.hash && Math.abs(entry.at - request.submission!.at) <= HISTORY_WINDOW_MS
  );
  if (matches.length > 1) throw new Refusal('ambiguous');
  if (matches.length !== 1) throw new Refusal('unverified');
  return matches[0];
}

async function resolveInternal(
  request: CodexIdentityRequest,
  home: string,
  budget: Budget
): Promise<CodexIdentityResult> {
  try {
    await validateHome(home, budget);
    const identities = await scanRollouts(home, budget);
    const cwd = resolve(request.workingDir);
    const candidates = identities.filter((identity) => identity.cwd === cwd && !identity.subagent);
    const fresh = candidates
      .filter((identity) => identity.originator === `codeman_${request.sessionId}`)
      .sort((a, b) => b.createdAt - a.createdAt);
    if (fresh.length > 1 && fresh[0].createdAt === fresh[1].createdAt) throw new Refusal('ambiguous');
    const newest = fresh[0];
    const history = await matchingHistory(home, request, budget);
    let selected: RolloutIdentity | undefined;
    if (history) {
      selected = candidates.find((identity) => identity.id === history.id);
      if (newest && newest.id !== history.id && newest.createdAt > request.submission!.at) {
        throw new Refusal('ambiguous');
      }
    } else if (request.resumeId) {
      if (newest && newest.id !== request.resumeId) throw new Refusal('ambiguous');
      selected = candidates.find((identity) => identity.id === request.resumeId);
    } else {
      selected = newest;
    }
    if (!selected) throw new Refusal('unverified');
    const head = (await readWindow(selected.path, HEAD_BYTES, false, budget)).text;
    const recheck = parseRolloutHeader(selected.path, head);
    if (
      recheck.id !== selected.id ||
      recheck.cwd !== selected.cwd ||
      recheck.originator !== selected.originator ||
      recheck.createdAt !== selected.createdAt ||
      recheck.subagent
    ) {
      throw new Refusal('unverified');
    }
    const tail = (await readWindow(selected.path, TAIL_BYTES, true, budget)).text;
    if (!tail.endsWith('\n')) throw new Refusal('unverified');
    budget.check();
    return { reason: 'verified', conversationId: selected.id, path: selected.path, head, tail };
  } catch (error) {
    return { reason: error instanceof Refusal ? error.reason : isAbsent(error) ? 'unverified' : 'unreadable' };
  }
}

async function beforeDeadline(promise: Promise<CodexIdentityResult>, deadline: number): Promise<CodexIdentityResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<CodexIdentityResult>((finish) => {
        timer = setTimeout(() => finish({ reason: 'unreadable' }), Math.max(0, deadline - performance.now()));
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function resolveCodexIdentity(request: CodexIdentityRequest): Promise<CodexIdentityResult> {
  if (!request.noDaemon) return { reason: 'managed-daemon' };
  if (
    !request.sessionId ||
    !isAbsolute(request.workingDir) ||
    (request.resumeId !== undefined && !UUID.test(request.resumeId)) ||
    (request.previousId !== undefined && !UUID.test(request.previousId)) ||
    (request.submission !== undefined &&
      (!Number.isFinite(request.submission.at) ||
        request.submission.at <= 0 ||
        !/^[a-f0-9]{64}$/.test(request.submission.hash)))
  ) {
    return { reason: 'unverified' };
  }
  const configuredHome = request.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  if (!isAbsolute(configuredHome)) return { reason: 'unverified' };
  const home = resolve(configuredHome);
  const key = JSON.stringify([
    request.sessionId,
    resolve(request.workingDir),
    request.resumeId,
    request.submission?.at,
    request.submission?.hash,
    request.previousId,
  ]);
  const existing = pendingHomes.get(home);
  if (existing) {
    if (existing.key !== key) return { reason: 'unverified' };
    return beforeDeadline(existing.promise, existing.deadline);
  }
  if (pendingHomes.size >= MAX_PENDING_HOMES) return { reason: 'unverified' };
  const budget = new Budget();
  const promise = resolveInternal(request, home, budget);
  pendingHomes.set(home, { key, deadline: budget.deadline, promise });
  void promise.finally(() => {
    if (pendingHomes.get(home)?.promise === promise) pendingHomes.delete(home);
  });
  return beforeDeadline(promise, budget.deadline);
}
