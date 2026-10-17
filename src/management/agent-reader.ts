/** Bounded owner-scoped chat/usage context. None of these reports authorizes worker actions. */
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { BrainStoreError } from '../supervisor/brain.js';
import { clampEnvOverridesForOwner, clampExternalCliConfigsForOwner } from '../session-env-clamp.js';
import {
  resolveCodexIdentity,
  type CodexIdentityRequest,
  type CodexIdentityResult,
} from '../recovery/codex-identity.js';
import { normalizedCodexHome } from '../recovery/codex-home.js';
import { parseExternalCliTranscript } from '../web/response-viewer-transcript.js';
import { stripAnsi } from '../utils/regex-patterns.js';
import type { ObservableManagementAgent } from './observation.js';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export const MAX_MANAGEMENT_CHAT_CAPTURE_BYTES = 128 * 1024;
export const MAX_MANAGEMENT_CHAT_PAGE_BYTES = 16 * 1024;
const MESSAGE_BYTES = 8 * 1024;
const MAX_MESSAGES = 128;
const SNAPSHOTS = 32;
const CURSORS = 128;
const TTL = 2 * 60_000;
const STALE = 15 * 60_000;
interface RecoveryContext {
  generation?: number;
  managed: boolean;
  noDaemon: boolean;
  codexHome?: string;
  switchPending: boolean;
  untrackedInput: boolean;
  inputBrokerPending?: boolean;
  submission?: { at: number; hash: string };
}
export interface ReadableManagementAgent extends ObservableManagementAgent {
  claudeSessionId: string | null;
  codexConfig?: { resumeSessionId?: string };
  getRecoveryContext(): RecoveryContext;
  getEnvOverridesForPersist(): Record<string, string> | undefined;
  toState(): { inputTokens?: number; outputTokens?: number; totalCost?: number };
}
export interface ManagementChatMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp?: string;
  truncated: boolean;
}
interface QuotaReport {
  source: 'codex-native-rollout-token-count';
  observedAt: number;
  windows: Array<{ name: 'primary' | 'secondary'; usedPercentage: number; resetAt: number; windowMinutes: number }>;
}
interface Snapshot {
  agent: ReadableManagementAgent;
  binding: string;
  owner: string;
  managerId: string;
  conversationId?: string;
  capturedAt: number;
  observedAt: number | null;
  source: 'codex-native-rollout' | 'claude-hook-transcript' | 'codeman-cached-tab-output';
  revision: string;
  messages: ManagementChatMessage[];
  truncated: boolean;
  attribution: 'exact-native-conversation' | 'configured-conversation' | 'unverified-tab-output';
  quota?: QuotaReport;
  counters: { inputTokens?: number; outputTokens?: number; costEstimate?: number };
}
export interface ManagementAgentReaderDependencies {
  lookup(id: string): ReadableManagementAgent | undefined;
  /** Existing owner-session hook watcher only, never a caller-selected path. */
  claudeTranscriptPath(id: string): string | null;
  resolveCodexIdentity?: (request: CodexIdentityRequest) => Promise<CodexIdentityResult>;
  now?: () => number;
}
function tail(value: string, maximum: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value.slice(-maximum), 'utf8');
  let offset = Math.max(0, bytes.length - maximum);
  while (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) offset++;
  return { text: bytes.subarray(offset).toString('utf8'), truncated: value.length > maximum || offset > 0 };
}
function head(value: string, maximum: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value.slice(0, maximum), 'utf8');
  let end = Math.min(bytes.length, maximum);
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: value.length > maximum || end < bytes.length };
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
function timestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const at = Date.parse(value);
  return Number.isSafeInteger(at) && at > 0 ? at : undefined;
}
function message(role: 'user' | 'assistant', text: string, at?: unknown): ManagementChatMessage | undefined {
  if (!text.trim()) return undefined;
  const bounded = head(stripAnsi(text), MESSAGE_BYTES);
  return {
    role,
    text: bounded.text,
    ...(timestamp(at) ? { timestamp: new Date(timestamp(at)!).toISOString() } : {}),
    truncated: bounded.truncated,
  };
}
function texts(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((value) => {
      const block = object(value);
      return block &&
        ['text', 'input_text', 'output_text'].includes(String(block.type)) &&
        typeof block.text === 'string'
        ? [block.text]
        : [];
    })
    .join('\n');
}
function quota(payload: Record<string, unknown>, at: unknown): QuotaReport | undefined {
  const rate = object(payload.rate_limits),
    observedAt = timestamp(at);
  if (!rate || !observedAt || (rate.limit_id !== undefined && rate.limit_id !== 'codex')) return undefined;
  const windows: QuotaReport['windows'] = [];
  for (const name of ['primary', 'secondary'] as const) {
    const value = object(rate[name]);
    if (!value) {
      if (rate[name] != null) return undefined;
      continue;
    }
    const percent = value.used_percent,
      reset = value.resets_at,
      minutes = value.window_minutes;
    if (
      typeof percent !== 'number' ||
      !Number.isFinite(percent) ||
      percent < 0 ||
      percent > 100 ||
      !Number.isSafeInteger(reset) ||
      Number(reset) <= 0 ||
      Number(reset) > 8_640_000_000_000 ||
      !Number.isSafeInteger(minutes) ||
      Number(minutes) <= 0 ||
      Number(minutes) > 525_600
    )
      return undefined;
    windows.push({ name, usedPercentage: percent, resetAt: Number(reset) * 1000, windowMinutes: Number(minutes) });
  }
  return windows.length ? { source: 'codex-native-rollout-token-count', observedAt, windows } : undefined;
}
function parseNative(content: string, mode: 'codex' | 'claude', conversationId?: string) {
  const messages: ManagementChatMessage[] = [];
  let malformed = false,
    report: QuotaReport | undefined,
    observedAt: number | null = null;
  const lines = content.split('\n');
  // An unterminated final JSONL row may still be being written; never interpret it.
  const partial = !!lines.pop();
  if (partial) malformed = true;
  for (const line of lines) {
    if (!line) continue;
    let row: Record<string, unknown> | undefined;
    try {
      row = object(JSON.parse(line));
    } catch {
      malformed = true;
      report = undefined;
      continue;
    }
    if (!row) {
      malformed = true;
      report = undefined;
      continue;
    }
    if (
      mode === 'claude' &&
      ((row.sessionId !== undefined && row.sessionId !== conversationId) ||
        (['user', 'assistant'].includes(String(row.type)) && row.sessionId !== conversationId))
    ) {
      malformed = true;
      continue;
    }
    const at = timestamp(row.timestamp);
    if (at) observedAt = Math.max(observedAt ?? 0, at);
    let next: ManagementChatMessage | undefined;
    const payload = object(row.payload),
      msg = object(row.message);
    if (mode === 'claude' && !row.isSidechain && ['user', 'assistant'].includes(String(row.type)) && msg) {
      next = message(row.type as 'user' | 'assistant', texts(msg.content), row.timestamp);
    } else if (
      mode === 'codex' &&
      row.type === 'response_item' &&
      payload?.type === 'message' &&
      ['user', 'assistant'].includes(String(payload.role))
    ) {
      next = message(payload.role as 'user' | 'assistant', texts(payload.content), row.timestamp);
    } else if (mode === 'codex' && row.type === 'event_msg' && payload?.type === 'token_count') {
      // A malformed newer native report replaces a previous report with unknown, never stale optimism.
      report = quota(payload, row.timestamp);
    }
    if (next) messages.push(next);
    if (messages.length > MAX_MESSAGES) {
      messages.shift();
      malformed = true;
    }
  }
  return { messages, malformed, quota: partial ? undefined : report, observedAt };
}
function counters(agent: ReadableManagementAgent) {
  const state = agent.toState();
  const natural = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  return {
    ...(natural(state.inputTokens) ? { inputTokens: state.inputTokens } : {}),
    ...(natural(state.outputTokens) ? { outputTokens: state.outputTokens } : {}),
    ...(typeof state.totalCost === 'number' && Number.isFinite(state.totalCost) && state.totalCost >= 0
      ? { costEstimate: state.totalCost }
      : {}),
  };
}

export class ManagementAgentReader {
  private snapshots = new Map<string, Snapshot>();
  private cursors = new Map<string, { snapshot: Snapshot; end: number; expiresAt: number }>();
  private active = 0;
  constructor(private readonly dependencies: ManagementAgentReaderDependencies) {}
  private now() {
    return (this.dependencies.now ?? Date.now)();
  }
  private binding(agent: ReadableManagementAgent) {
    const context = agent.getRecoveryContext();
    return JSON.stringify([
      agent.id,
      agent.owner,
      agent.mode,
      agent.remote,
      agent.docker,
      agent.workingDir,
      agent.claudeSessionId,
      agent.codexConfig,
      context.codexHome,
      context.generation,
      agent.getEnvOverridesForPersist(),
    ]);
  }
  private guard(agentId: string, managerId: string, owner: string, current: () => boolean, allowSelf = false) {
    const agent = this.dependencies.lookup(agentId);
    if (
      !agent ||
      (agentId === managerId && !allowSelf) ||
      !UUID.test(agentId) ||
      (agent.owner ?? 'admin') !== owner ||
      agent.docker ||
      !(['codex', 'claude'].includes(agent.mode) || (agent.mode === 'shell' && agent.remote))
    )
      throw new BrainStoreError('forbidden');
    const binding = this.binding(agent);
    const check = () => {
      if (
        current() !== true ||
        this.dependencies.lookup(agentId) !== agent ||
        (agent.owner ?? 'admin') !== owner ||
        this.binding(agent) !== binding
      )
        throw new BrainStoreError('forbidden');
    };
    check();
    return { agent, binding, check };
  }
  private prune() {
    const now = this.now();
    for (const [key, value] of this.snapshots)
      if (now - value.capturedAt > TTL || now < value.capturedAt) this.snapshots.delete(key);
    for (const [key, value] of this.cursors)
      if (now > value.expiresAt || now < value.snapshot.capturedAt) this.cursors.delete(key);
    while (this.snapshots.size >= SNAPSHOTS) this.snapshots.delete(this.snapshots.keys().next().value!);
    while (this.cursors.size >= CURSORS) this.cursors.delete(this.cursors.keys().next().value!);
  }
  private async claude(agent: ReadableManagementAgent, check: () => void) {
    const id = agent.claudeSessionId,
      path = this.dependencies.claudeTranscriptPath(agent.id);
    if (!id || !UUID.test(id) || !path || path.length > 4096 || basename(path) !== `${id}.jsonl` || !isAbsolute(path))
      return undefined;
    const configured = agent.getEnvOverridesForPersist()?.CLAUDE_CONFIG_DIR;
    const root = resolve(configured || join(homedir(), '.claude'), 'projects');
    const within = relative(root, path);
    if (!within || within.startsWith('..' + sep) || isAbsolute(within)) return undefined;
    // Never follow a symlink in an owner-supplied hook path, including parent components.
    let part = resolve(path).startsWith(sep) ? sep : '';
    let expectedFile: Awaited<ReturnType<typeof fs.lstat>> | undefined;
    for (const component of resolve(path).split(sep).filter(Boolean)) {
      part = join(part, component);
      const st = await fs.lstat(part);
      check();
      if (st.isSymbolicLink()) return undefined;
      expectedFile = st;
    }
    const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat();
      check();
      if (!before.isFile() || before.dev !== expectedFile?.dev || before.ino !== expectedFile.ino) return undefined;
      const header = Buffer.alloc(Math.min(before.size, 64 * 1024));
      await file.read(header, 0, header.length, 0);
      check();
      if (
        !header
          .toString('utf8')
          .split('\n')
          .some((line) => {
            try {
              return object(JSON.parse(line))?.sessionId === id;
            } catch {
              return false;
            }
          })
      )
        return undefined;
      const size = Math.min(before.size, MAX_MANAGEMENT_CHAT_CAPTURE_BYTES),
        offset = before.size - size;
      const bytes = Buffer.alloc(size);
      const read = await file.read(bytes, 0, size, offset);
      check();
      const after = await file.stat();
      check();
      if (
        read.bytesRead !== size ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        return undefined;
      let content = bytes.toString('utf8');
      if (offset > 0) content = content.slice(content.indexOf('\n') + 1);
      return { content, truncated: offset > 0, conversationId: id };
    } finally {
      await file.close();
    }
  }
  private async nativeGrantCurrent(agent: ReadableManagementAgent, check: () => void) {
    const persistedEnv = agent.getEnvOverridesForPersist();
    const [safeEnv, safeConfig] = await Promise.all([
      clampEnvOverridesForOwner(agent.owner, persistedEnv),
      clampExternalCliConfigsForOwner(agent.owner, { codexConfig: agent.codexConfig }),
    ]);
    check();
    return (
      JSON.stringify(safeEnv) === JSON.stringify(persistedEnv) &&
      JSON.stringify(safeConfig.codexConfig) === JSON.stringify(agent.codexConfig)
    );
  }
  private async capture(agentId: string, managerId: string, owner: string, current: () => boolean, allowSelf = false) {
    this.prune();
    const { agent, binding, check } = this.guard(agentId, managerId, owner, current, allowSelf);
    const key = owner + ':' + managerId + ':' + agentId;
    const cached = this.snapshots.get(key);
    if (this.active >= 2) throw new BrainStoreError('forbidden');
    this.active++;
    try {
      const nativeGrantCurrent = await this.nativeGrantCurrent(agent, check);
      if (
        cached?.binding === binding &&
        cached.agent === agent &&
        this.now() - cached.capturedAt <= 5000 &&
        (nativeGrantCurrent || cached.source === 'codeman-cached-tab-output')
      )
        return cached;
      const captured = tail(
        stripAnsi(agent.textOutput.slice(-MAX_MANAGEMENT_CHAT_CAPTURE_BYTES)),
        MAX_MANAGEMENT_CHAT_CAPTURE_BYTES
      );
      let source: Snapshot['source'] = 'codeman-cached-tab-output';
      let attribution: Snapshot['attribution'] = 'unverified-tab-output';
      let conversationId: string | undefined, report: QuotaReport | undefined;
      let messages = parseExternalCliTranscript(captured.text, agent.mode).flatMap((block) => {
        const next = message(block.role, block.text);
        return next ? [next] : [];
      });
      let truncated = captured.truncated || agent.textOutput.length > MAX_MANAGEMENT_CHAT_CAPTURE_BYTES;
      let observedAt: number | null =
        Number.isFinite(agent.lastActivityAt) && agent.lastActivityAt > 0 ? agent.lastActivityAt : null;
      if (nativeGrantCurrent && !agent.remote && agent.mode === 'codex') {
        const context = agent.getRecoveryContext();
        if (
          context.managed &&
          context.noDaemon &&
          !context.switchPending &&
          !context.untrackedInput &&
          !context.inputBrokerPending &&
          normalizedCodexHome(context.codexHome)
        ) {
          const identity = await (this.dependencies.resolveCodexIdentity ?? resolveCodexIdentity)({
            sessionId: agent.id,
            workingDir: agent.workingDir,
            codexHome: context.codexHome,
            noDaemon: true,
            resumeId: agent.codexConfig?.resumeSessionId,
            submission: context.submission,
          });
          check();
          if (
            identity.reason === 'verified' &&
            identity.conversationId &&
            UUID.test(identity.conversationId) &&
            identity.tail !== undefined &&
            (!agent.codexConfig?.resumeSessionId || agent.codexConfig.resumeSessionId === identity.conversationId)
          ) {
            const bounded = tail(identity.tail, MAX_MANAGEMENT_CHAT_CAPTURE_BYTES);
            const parsed = parseNative(bounded.text, 'codex');
            source = 'codex-native-rollout';
            attribution = 'exact-native-conversation';
            conversationId = identity.conversationId;
            messages = parsed.messages;
            report = parsed.quota;
            observedAt = parsed.observedAt;
            truncated = identity.tailTruncated !== false || bounded.truncated || parsed.malformed;
          }
        }
      } else if (nativeGrantCurrent && !agent.remote && agent.mode === 'claude') {
        const native = await this.claude(agent, check).catch(() => undefined);
        check();
        if (native) {
          const parsed = parseNative(native.content, 'claude', native.conversationId);
          source = 'claude-hook-transcript';
          attribution = 'configured-conversation';
          conversationId = native.conversationId;
          messages = parsed.messages;
          observedAt = parsed.observedAt;
          truncated = native.truncated || parsed.malformed;
        }
      }
      if (messages.length > MAX_MESSAGES) truncated = true;
      let bytes = 0;
      messages = messages
        .slice(-MAX_MESSAGES)
        .reverse()
        .filter((item) => {
          bytes += Buffer.byteLength(item.text);
          if (bytes > MAX_MANAGEMENT_CHAT_CAPTURE_BYTES) {
            truncated = true;
            return false;
          }
          return true;
        })
        .reverse();
      const snapshot: Snapshot = {
        agent,
        binding,
        owner,
        managerId,
        conversationId,
        capturedAt: this.now(),
        observedAt,
        source,
        attribution,
        messages,
        truncated,
        ...(report ? { quota: report } : {}),
        counters: counters(agent),
        revision: createHash('sha256')
          .update(JSON.stringify([source, conversationId, messages, observedAt]))
          .digest('hex'),
      };
      check();
      if (source !== 'codeman-cached-tab-output' && !(await this.nativeGrantCurrent(agent, check)))
        throw new BrainStoreError('forbidden');
      this.snapshots.set(key, snapshot);
      return snapshot;
    } finally {
      this.active--;
    }
  }
  async conversation(
    agentId: string,
    managerId: string,
    owner: string,
    options: { cursor?: string; limit?: number },
    current: () => boolean
  ) {
    const limit = options.limit ?? 20;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 40 ||
      (options.cursor !== undefined && !/^[a-f0-9]{48}$/.test(options.cursor))
    )
      throw new BrainStoreError('forbidden');
    this.prune();
    const guard = this.guard(agentId, managerId, owner, current);
    const continuation = options.cursor ? this.cursors.get(options.cursor) : undefined;
    if (
      options.cursor &&
      (!continuation ||
        continuation.snapshot.agent !== guard.agent ||
        continuation.snapshot.binding !== guard.binding ||
        continuation.snapshot.owner !== owner ||
        continuation.snapshot.managerId !== managerId ||
        continuation.expiresAt < this.now())
    )
      throw new BrainStoreError('conflict');
    const snapshot = continuation?.snapshot ?? (await this.capture(agentId, managerId, owner, current));
    let start = continuation?.end ?? snapshot.messages.length,
      bytes = 0;
    const end = start;
    while (start > 0 && end - start < limit) {
      const size = Buffer.byteLength(JSON.stringify(snapshot.messages[start - 1])) + 1;
      // Reserve room for the fixed attribution/cursor envelope as well as message JSON.
      if (bytes + size > MAX_MANAGEMENT_CHAT_PAGE_BYTES - 2048) break;
      bytes += size;
      start--;
    }
    let nextCursor: string | undefined;
    if (start > 0) {
      nextCursor = randomBytes(24).toString('hex');
      this.cursors.set(nextCursor, { snapshot, end: start, expiresAt: snapshot.capturedAt + TTL });
    }
    guard.check();
    if (snapshot.source !== 'codeman-cached-tab-output' && !(await this.nativeGrantCurrent(guard.agent, guard.check)))
      throw new BrainStoreError('forbidden');
    return {
      agentId,
      mode: guard.agent.mode,
      conversationId: snapshot.conversationId ?? null,
      source: snapshot.source,
      attribution: snapshot.attribution,
      capturedAt: snapshot.capturedAt,
      observedAt: snapshot.observedAt,
      stale: !snapshot.observedAt || this.now() < snapshot.observedAt || this.now() - snapshot.observedAt > STALE,
      trust: 'untrusted-context',
      authority: 'none',
      revision: snapshot.revision,
      messages: snapshot.messages.slice(start, end),
      direction: 'older',
      nextCursor: nextCursor ?? null,
      truncated: snapshot.truncated || snapshot.messages.some((item) => item.truncated),
      snapshotExpiresAt: snapshot.capturedAt + TTL,
    };
  }
  async usage(agentId: string, managerId: string, owner: string, current: () => boolean) {
    const snapshot = await this.capture(agentId, managerId, owner, current, true);
    const report = snapshot.quota;
    const stale =
      !report ||
      this.now() < report.observedAt ||
      this.now() - report.observedAt > STALE ||
      report.windows.some((window) => window.resetAt <= this.now());
    this.guard(agentId, managerId, owner, current, true).check();
    return {
      agentId,
      capturedAt: snapshot.capturedAt,
      authority: 'none',
      counters: {
        source: 'codeman-session-counter-estimate',
        available: Object.keys(snapshot.counters).length > 0,
        stale: true,
        ...snapshot.counters,
      },
      providerQuota: report
        ? {
            source: report.source,
            status: 'provider-reported',
            scope: 'conversation-home',
            conversationId: snapshot.conversationId,
            observedAt: report.observedAt,
            stale,
            currentAccountVerified: false,
            usableAsActionAuthority: false,
            windows: report.windows,
          }
        : {
            status: 'unavailable',
            stale: true,
            reason: 'No attributed native provider report is cached for this agent.',
          },
    };
  }
}
