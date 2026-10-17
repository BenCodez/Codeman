/** Real bounded local reads and scoped snapshots; no SSH, pane or agent effects. */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as grants from '../src/session-env-clamp.js';
import {
  ManagementAgentReader,
  MAX_MANAGEMENT_CHAT_PAGE_BYTES,
  type ReadableManagementAgent,
} from '../src/management/agent-reader.js';
import type { CodexIdentityResult } from '../src/recovery/codex-identity.js';
const AGENT = '11111111-1111-4111-8111-111111111111';
const MANAGER = '22222222-2222-4222-8222-222222222222';
const THREAD = '33333333-3333-4333-8333-333333333333';
const NOW = Date.parse('2026-10-17T01:00:00.000Z');
const stamp = new Date(NOW - 1000).toISOString();
function row(value: unknown) {
  return JSON.stringify(value) + '\n';
}
function chat(text: string, role = 'assistant') {
  return row({
    type: 'response_item',
    timestamp: stamp,
    payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] },
  });
}
function usage(percent = 35, at = stamp) {
  return row({
    type: 'event_msg',
    timestamp: at,
    payload: {
      type: 'token_count',
      rate_limits: {
        limit_id: 'codex',
        primary: { used_percent: percent, window_minutes: 300, resets_at: Math.floor(NOW / 1000) + 3600 },
      },
    },
  });
}
function fixture(content = chat('hello', 'user') + chat('reply') + usage()) {
  let clock = NOW;
  const context = {
    generation: 1,
    managed: true,
    noDaemon: true,
    switchPending: false,
    untrackedInput: false,
    codexHome: '/fixture/.codex',
    submission: { at: NOW - 2000, hash: 'a'.repeat(64) },
  };
  const agent: ReadableManagementAgent = {
    id: AGENT,
    owner: 'owner',
    name: 'Fixture',
    mode: 'codex',
    workingDir: '/work',
    status: 'idle',
    lastActivityAt: NOW - 1000,
    textOutput: '› cached question\n\nCached answer',
    claudeSessionId: THREAD,
    codexConfig: { resumeSessionId: THREAD },
    getRecoveryContext: () => ({ ...context }),
    getEnvOverridesForPersist: () => ({ CODEX_HOME: context.codexHome }),
    toState: () => ({ inputTokens: 100, outputTokens: 50, totalCost: 0.01 }),
  };
  const agents = new Map([[AGENT, agent]]);
  const identity = vi.fn(
    async (): Promise<CodexIdentityResult> => ({
      reason: 'verified',
      conversationId: THREAD,
      tail: content,
      tailTruncated: false,
    })
  );
  const claudePath = vi.fn((): string | null => null);
  const reader = new ManagementAgentReader({
    lookup: (id) => agents.get(id),
    resolveCodexIdentity: identity,
    claudeTranscriptPath: claudePath,
    now: () => clock,
  });
  return {
    reader,
    agent,
    agents,
    identity,
    context,
    claudePath,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
describe('manager conversation and usage context', () => {
  it('reads exact native Codex conversation and actual reported usage without treating it as authority', async () => {
    const f = fixture();
    const page = await f.reader.conversation(AGENT, MANAGER, 'owner', {}, () => true);
    expect(page).toMatchObject({
      agentId: AGENT,
      conversationId: THREAD,
      source: 'codex-native-rollout',
      attribution: 'exact-native-conversation',
      trust: 'untrusted-context',
      authority: 'none',
      stale: false,
      truncated: false,
      nextCursor: null,
      messages: [
        { role: 'user', text: 'hello' },
        { role: 'assistant', text: 'reply' },
      ],
    });
    expect(f.identity).toHaveBeenCalledWith({
      sessionId: AGENT,
      workingDir: '/work',
      codexHome: '/fixture/.codex',
      noDaemon: true,
      resumeId: THREAD,
      submission: f.context.submission,
    });
    const report = await f.reader.usage(AGENT, MANAGER, 'owner', () => true);
    expect(report).toMatchObject({
      authority: 'none',
      counters: {
        source: 'codeman-session-counter-estimate',
        inputTokens: 100,
        outputTokens: 50,
        costEstimate: 0.01,
        stale: true,
      },
      providerQuota: {
        status: 'provider-reported',
        stale: false,
        currentAccountVerified: false,
        usableAsActionAuthority: false,
        windows: [{ name: 'primary', usedPercentage: 35, windowMinutes: 300, resetAt: NOW + 3_600_000 }],
      },
    });
    expect(f.identity).toHaveBeenCalledOnce();
  });
  it('lets the prepared manager inspect its own usage without opening its own chat', async () => {
    const f = fixture();
    expect((await f.reader.usage(AGENT, AGENT, 'owner', () => true)).providerQuota.status).toBe('provider-reported');
    await expect(f.reader.conversation(AGENT, AGENT, 'owner', {}, () => true)).rejects.toThrow();
    await expect(f.reader.usage(AGENT, AGENT, 'other', () => true)).rejects.toThrow();
  });
  it('pages an immutable bounded snapshot backwards with expiring agent-scoped opaque cursors', async () => {
    const f = fixture(Array.from({ length: 50 }, (_, i) => chat(`message ${i}`)).join(''));
    const first = await f.reader.conversation(AGENT, MANAGER, 'owner', { limit: 3 }, () => true);
    expect(first.messages.map((item) => item.text)).toEqual(['message 47', 'message 48', 'message 49']);
    expect(first.nextCursor).toMatch(/^[a-f0-9]{48}$/);
    const older = await f.reader.conversation(
      AGENT,
      MANAGER,
      'owner',
      { limit: 3, cursor: first.nextCursor! },
      () => true
    );
    expect(older.messages.map((item) => item.text)).toEqual(['message 44', 'message 45', 'message 46']);
    expect(older.revision).toBe(first.revision);
    expect(f.identity).toHaveBeenCalledOnce();
    await expect(
      f.reader.conversation(AGENT, MANAGER, 'other', { cursor: first.nextCursor! }, () => true)
    ).rejects.toThrow();
    await expect(
      f.reader.conversation(AGENT, AGENT, 'owner', { cursor: first.nextCursor! }, () => true)
    ).rejects.toThrow();
    f.advance(120_001);
    await expect(
      f.reader.conversation(AGENT, MANAGER, 'owner', { cursor: first.nextCursor! }, () => true)
    ).rejects.toThrow();
  });
  it('rejects a cursor when conversation, home, configuration or native registration changes', async () => {
    for (const change of ['conversation', 'home', 'registration'] as const) {
      const f = fixture(chat('one') + chat('two'));
      const first = await f.reader.conversation(AGENT, MANAGER, 'owner', { limit: 1 }, () => true);
      if (change === 'conversation') f.agent.codexConfig!.resumeSessionId = MANAGER;
      if (change === 'home') f.context.codexHome = '/different/.codex';
      if (change === 'registration') f.agents.set(AGENT, { ...f.agent });
      await expect(
        f.reader.conversation(AGENT, MANAGER, 'owner', { cursor: first.nextCursor! }, () => true)
      ).rejects.toThrow();
    }
  });
  it.each(['unverified', 'remote', 'shell', 'pending', 'home'] as const)(
    'labels %s output as cached context without local native reads or invented quota',
    async (failure) => {
      const f = fixture();
      if (failure === 'unverified') f.identity.mockResolvedValue({ reason: 'unverified' });
      if (failure === 'remote' || failure === 'shell') f.agent.remote = { host: 'worker.invalid' };
      if (failure === 'shell') f.agent.mode = 'shell';
      if (failure === 'pending') f.context.switchPending = true;
      if (failure === 'home') f.context.codexHome = '';
      const page = await f.reader.conversation(AGENT, MANAGER, 'owner', {}, () => true);
      expect(page).toMatchObject({
        source: 'codeman-cached-tab-output',
        attribution: 'unverified-tab-output',
        authority: 'none',
        conversationId: null,
      });
      expect((await f.reader.usage(AGENT, MANAGER, 'owner', () => true)).providerQuota.status).toBe('unavailable');
      if (failure !== 'unverified') expect(f.identity).not.toHaveBeenCalled();
      expect(f.claudePath).not.toHaveBeenCalled();
    }
  );
  it.each([-1, 101, NaN, '25'])('does not report malformed provider percentage %s', async (percent) => {
    const content = chat('answer') + usage() + usage(percent as number);
    const f = fixture(content);
    expect((await f.reader.usage(AGENT, MANAGER, 'owner', () => true)).providerQuota.status).toBe('unavailable');
  });
  it('does not reuse native snapshots or cursors after an owner grant is withdrawn', async () => {
    const f = fixture(chat('one') + chat('two') + usage());
    const first = await f.reader.conversation(AGENT, MANAGER, 'owner', { limit: 1 }, () => true);
    const clamp = vi.spyOn(grants, 'clampEnvOverridesForOwner').mockResolvedValue({});
    try {
      await expect(
        f.reader.conversation(AGENT, MANAGER, 'owner', { cursor: first.nextCursor! }, () => true)
      ).rejects.toThrow();
      expect((await f.reader.usage(AGENT, MANAGER, 'owner', () => true)).providerQuota.status).toBe('unavailable');
      expect(f.identity).toHaveBeenCalledOnce();
    } finally {
      clamp.mockRestore();
    }
  });
  it('does not expose an earlier quota report after a partial or malformed newer row', async () => {
    for (const suffix of ['{partial', 'not json\n', '{"type":"event_msg"']) {
      const f = fixture(chat('answer') + usage() + suffix);
      expect((await f.reader.usage(AGENT, MANAGER, 'owner', () => true)).providerQuota.status).toBe('unavailable');
    }
  });
  it('marks expired, future, reset and old native telemetry stale', async () => {
    for (const at of [new Date(NOW - 901_000).toISOString(), new Date(NOW + 1000).toISOString()]) {
      const f = fixture(chat('answer') + usage(35, at));
      expect((await f.reader.usage(AGENT, MANAGER, 'owner', () => true)).providerQuota).toMatchObject({
        status: 'provider-reported',
        stale: true,
      });
    }
    const f = fixture();
    await f.reader.usage(AGENT, MANAGER, 'owner', () => true);
    f.advance(3_600_001);
    expect((await f.reader.usage(AGENT, MANAGER, 'owner', () => true)).providerQuota).toMatchObject({ stale: true });
  });
  it('retains limits and Unicode boundaries and ignores unfinished native rows', async () => {
    const f = fixture(chat('🙂'.repeat(40_000)) + chat('short') + '{"type":"response_item"');
    const page = await f.reader.conversation(AGENT, MANAGER, 'owner', { limit: 40 }, () => true);
    expect(Buffer.byteLength(JSON.stringify(page.messages))).toBeLessThan(MAX_MANAGEMENT_CHAT_PAGE_BYTES + 512);
    expect(page.truncated).toBe(true);
    expect(page.messages.map((item) => item.text).join('')).not.toContain('�');
    expect(page.messages.at(-1)?.text).toBe('short');
  });
  it('caps complete serialized pages, including message metadata and attribution', async () => {
    const f = fixture(Array.from({ length: 20 }, (_, i) => chat(`${i}:` + 'x'.repeat(7000))).join(''));
    let cursor: string | undefined;
    let count = 0;
    do {
      const page = await f.reader.conversation(AGENT, MANAGER, 'owner', { cursor, limit: 40 }, () => true);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(MAX_MANAGEMENT_CHAT_PAGE_BYTES);
      count += page.messages.length;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(count).toBeGreaterThan(0);
  });
  it('rechecks owner and prepared-manager authority after asynchronous native reads', async () => {
    const f = fixture();
    let current = true;
    f.identity.mockImplementationOnce(async () => {
      current = false;
      return { reason: 'verified', conversationId: THREAD, tail: chat('private') };
    });
    await expect(f.reader.conversation(AGENT, MANAGER, 'owner', {}, () => current)).rejects.toThrow();
    expect(await f.reader.conversation(AGENT, MANAGER, 'owner', {}, () => true)).toMatchObject({
      source: 'codex-native-rollout',
    });
  });
  it('bounds concurrent native lookups instead of accumulating unbounded work', async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.identity.mockImplementation(async () => {
      await gate;
      return { reason: 'unverified' };
    });
    const a = f.reader.conversation(AGENT, MANAGER, 'owner', {}, () => true);
    const b = f.reader.conversation(AGENT, MANAGER, 'owner', {}, () => true);
    try {
      await expect(f.reader.conversation(AGENT, MANAGER, 'owner', {}, () => true)).rejects.toThrow();
    } finally {
      release();
      await Promise.all([a, b]);
    }
    expect(f.identity).toHaveBeenCalledTimes(2);
  });
  it('reads the existing exact Claude hook transcript through bounded local IO', async () => {
    const f = fixture();
    f.agent.mode = 'claude';
    f.agent.codexConfig = undefined;
    const dir = join(homedir(), '.claude', 'projects', 'fixture');
    await fs.mkdir(dir, { recursive: true });
    const path = join(dir, `${THREAD}.jsonl`);
    await fs.writeFile(
      path,
      row({
        type: 'user',
        sessionId: THREAD,
        timestamp: stamp,
        message: { role: 'user', content: 'Claude question' },
      }) +
        row({
          type: 'assistant',
          sessionId: THREAD,
          timestamp: stamp,
          message: { role: 'assistant', content: [{ type: 'text', text: 'Claude answer' }] },
        })
    );
    f.claudePath.mockReturnValue(path);
    const page = await f.reader.conversation(AGENT, MANAGER, 'owner', {}, () => true);
    expect(page).toMatchObject({
      source: 'claude-hook-transcript',
      conversationId: THREAD,
      messages: [
        { role: 'user', text: 'Claude question' },
        { role: 'assistant', text: 'Claude answer' },
      ],
    });
    expect(f.identity).not.toHaveBeenCalled();
    expect((await f.reader.usage(AGENT, MANAGER, 'owner', () => true)).providerQuota.status).toBe('unavailable');
  });
  it('does not mix foreign Claude conversation records into the selected chat', async () => {
    const f = fixture();
    f.agent.mode = 'claude';
    const dir = join(homedir(), '.claude', 'projects', 'mixed');
    await fs.mkdir(dir, { recursive: true });
    const path = join(dir, `${THREAD}.jsonl`);
    await fs.writeFile(
      path,
      row({ type: 'user', sessionId: THREAD, timestamp: stamp, message: { role: 'user', content: 'Selected chat' } }) +
        row({ type: 'assistant', sessionId: MANAGER, message: { role: 'assistant', content: 'Foreign private chat' } })
    );
    f.claudePath.mockReturnValue(path);
    const page = await f.reader.conversation(AGENT, MANAGER, 'owner', {}, () => true);
    expect(page.source).toBe('claude-hook-transcript');
    expect(page.truncated).toBe(true);
    expect(page.messages).toHaveLength(1);
    expect(JSON.stringify(page)).not.toContain('Foreign private chat');
  });
  it('never follows a hook symlink or a mismatched/out-of-home Claude transcript', async () => {
    const dir = join(homedir(), '.claude', 'projects', 'unsafe');
    await fs.mkdir(dir, { recursive: true });
    const target = join(homedir(), 'outside.jsonl');
    await fs.writeFile(
      target,
      row({ type: 'assistant', sessionId: THREAD, message: { role: 'assistant', content: 'private outside content' } })
    );
    const link = join(dir, `${THREAD}.jsonl`);
    await fs.symlink(target, link);
    for (const path of [link, target]) {
      const f = fixture();
      f.agent.mode = 'claude';
      f.claudePath.mockReturnValue(path);
      const page = await f.reader.conversation(AGENT, MANAGER, 'owner', {}, () => true);
      expect(page.source).toBe('codeman-cached-tab-output');
      expect(JSON.stringify(page)).not.toContain('private outside content');
    }
  });
});
