/** Exact input proof fixtures use fake delivery only; never a live Codex or tmux. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import type { MuxSession, TerminalMultiplexer } from '../src/mux-interface.js';
import { CodexInputProofTracker } from '../src/recovery/codex-input-proof.js';
import { hashCodexPrompt } from '../src/recovery/codex-identity.js';
import { createDeferred } from './mocks/index.js';

const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const THREAD = '11111111-2222-3333-4444-555555555555';
const sessions: Session[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.stop(false);
});

function fixture(restored = true) {
  const mux = {
    isAvailable: () => true,
    sendInput: vi.fn(async () => true),
    clearPaneExit: vi.fn(),
  };
  const session = new Session({
    id: SESSION,
    workingDir: '/tmp',
    mode: 'codex',
    useMux: true,
    mux: mux as unknown as TerminalMultiplexer,
    muxSession: {
      muxName: 'codeman-input-fixture',
      sessionId: SESSION,
      pid: 99999,
      createdAt: Date.now(),
      workingDir: '/tmp',
      mode: 'codex',
      attached: true,
      recoveryIsolated: true,
      recoveryCodexHome: '/fixture/codex-home',
    } as MuxSession,
    preserveExitedPane: restored,
    codexConfig: { noDaemon: true, resumeSessionId: THREAD },
  });
  sessions.push(session);
  return { session, mux };
}

function attachFakePty(session: Session): void {
  Object.assign(session, { ptyProcess: { write: vi.fn() } });
}

describe('exact append-only recovery input model', () => {
  it('preserves whitespace and Unicode without trimming or normalization', () => {
    const tracker = new CodexInputProofTracker();
    const prompt = '  Sanitized é e\u0301 😀 fixture.  ';
    expect(tracker.feed(`${prompt}\r`)).toEqual({ prompts: [prompt], invalidated: false });
  });

  it('refuses surrogate halves encoded in different PTY writes', () => {
    const tracker = new CodexInputProofTracker();
    expect(tracker.feed('\ud83d')).toEqual({ prompts: [], invalidated: true });
    expect(tracker.feed('\ude00\r')).toEqual({ prompts: [undefined], invalidated: true });
  });

  it('preserves multiline LF input and Shift+Enter across frames', () => {
    const tracker = new CodexInputProofTracker();
    expect(tracker.feed('Fixture line one\n')).toEqual({ prompts: [], invalidated: false });
    expect(tracker.feed('\nFixture line three\r')).toEqual({
      prompts: ['Fixture line one\n\nFixture line three'],
      invalidated: false,
    });
  });

  it('preserves bracketed-paste LF payload and split framing exactly', () => {
    const tracker = new CodexInputProofTracker();
    tracker.feed('\x1b[20');
    tracker.feed('0~  Fixture one\n');
    tracker.feed('Fixture two  \x1b[201');
    expect(tracker.feed('~ suffix\r')).toEqual({
      prompts: ['  Fixture one\nFixture two   suffix'],
      invalidated: false,
    });
  });

  it('vetoes recovery while a framing sequence is incomplete', () => {
    const tracker = new CodexInputProofTracker();
    expect(tracker.feed('\x1b[20')).toEqual({ prompts: [], invalidated: true });
    expect(tracker.feed('0~Fixture\x1b[201~\r')).toEqual({ prompts: ['Fixture'], invalidated: false });
  });

  it('refuses CR/CRLF paste rather than guessing TUI normalization', () => {
    const tracker = new CodexInputProofTracker();
    expect(tracker.feed('\x1b[200~Fixture one\r\nFixture two\x1b[201~\r')).toEqual({
      prompts: [undefined],
      invalidated: true,
    });
  });

  it.each(['\x1b[D', '\x1b[C', '\x1b[H', '\x1b[3~', '\x1b[A', '\x10', '\t', '\x7f', '\x17', '\x15'])(
    'refuses unsupported editing or recall %j',
    (key) => {
      const tracker = new CodexInputProofTracker();
      expect(tracker.feed(`Fixture draft${key} suffix\r`)).toEqual({ prompts: [undefined], invalidated: true });
      expect(tracker.feed('Fresh fixture.\r')).toEqual({ prompts: ['Fresh fixture.'], invalidated: false });
    }
  );

  it('refuses an oversized draft instead of hashing its truncated prefix', () => {
    const tracker = new CodexInputProofTracker();
    expect(tracker.feed(`${'x'.repeat(8_193)}\r`)).toEqual({ prompts: [undefined], invalidated: true });
    expect(tracker.feed(`${'é'.repeat(4_097)}\r`)).toEqual({ prompts: [undefined], invalidated: true });
  });

  it('returns no proof for an empty submission or unknown external draft', () => {
    const tracker = new CodexInputProofTracker();
    expect(tracker.feed('\r')).toEqual({ prompts: [undefined], invalidated: false });
    tracker.invalidate();
    expect(tracker.feed('Only the visible tail\r')).toEqual({ prompts: [undefined], invalidated: false });
  });
});

describe('Session records exact delivered browser submissions', () => {
  it('keeps auto-name flattening separate from raw browser recovery hashing', () => {
    const { session } = fixture(false);
    attachFakePty(session);
    const submitted = vi.fn();
    session.on('promptSubmitted', submitted);
    const prompt = '  Fixture first line\nFixture second line  ';
    expect(session.write(`\x1b[200~${prompt}\x1b[201~\r`, { fromUser: true })).toBe(true);
    expect(submitted).toHaveBeenCalledWith('Fixture first line Fixture second line');
    expect(session.getRecoveryContext()).toMatchObject({
      switchPending: false,
      submission: { hash: hashCodexPrompt(prompt) },
    });
    expect(session.getRecoveryContext().submission?.hash).not.toBe(hashCodexPrompt(submitted.mock.calls[0][0]));
    expect(JSON.stringify(session.toDetailedState())).not.toContain('Fixture first line');
  });

  it('uses the literal Shift+Enter line feed reported outside the write path', () => {
    const { session } = fixture(false);
    attachFakePty(session);
    session.write('Fixture first', { fromUser: true });
    session.trackUserInput('\n');
    session.write('Fixture second\r', { fromUser: true });
    expect(session.getRecoveryContext()).toMatchObject({
      switchPending: false,
      submission: { hash: hashCodexPrompt('Fixture first\nFixture second') },
    });
  });

  it('keeps a restored veto until exact input has actually been delivered', async () => {
    const { session, mux } = fixture();
    await session.writeViaMux('Unknown prior draft suffix.\r', { fromUser: true });
    expect(session.getRecoveryContext()).toMatchObject({ switchPending: true, submission: undefined });
    const sent = createDeferred<boolean>();
    mux.sendInput.mockReturnValueOnce(sent.promise);
    const changed = vi.fn();
    session.on('recoveryIdentityChanged', changed);
    const writing = session.writeViaMux('Fresh fixture.\r', { fromUser: true });
    expect(session.getRecoveryContext()).toMatchObject({ switchPending: true, submission: undefined });
    sent.resolve(true);
    expect(await writing).toBe(true);
    expect(session.getRecoveryContext()).toMatchObject({
      switchPending: false,
      submission: { hash: hashCodexPrompt('Fresh fixture.') },
    });
    expect(changed).toHaveBeenCalled();
  });

  it('sets a slash-switch veto before delivery and retains it on failure', async () => {
    const { session, mux } = fixture(false);
    await session.writeViaMux('Known fixture.\r', { fromUser: true });
    const sent = createDeferred<boolean>();
    mux.sendInput.mockReturnValueOnce(sent.promise);
    const onInput = vi.fn(() => {
      expect(session.getRecoveryContext()).toMatchObject({ switchPending: true, submission: undefined });
    });
    session.on('recoveryUserInput', onInput);
    const writing = session.writeViaMux('/resume fixture\r', { fromUser: true });
    expect(onInput).toHaveBeenCalled();
    expect(session.getRecoveryContext()).toMatchObject({ switchPending: true, submission: undefined });
    sent.resolve(false);
    await expect(writing).rejects.toThrow('Mux input delivery could not be confirmed');
    expect(session.getRecoveryContext()).toMatchObject({ switchPending: true, submission: undefined });
  });

  it('does not lift a restored veto when delivery of an exact ordinary submission fails', async () => {
    const { session, mux } = fixture();
    mux.sendInput.mockResolvedValueOnce(false);
    await expect(session.writeViaMux('Undelivered fixture.\r', { fromUser: true })).rejects.toThrow(
      'Mux input delivery could not be confirmed'
    );
    expect(session.getRecoveryContext()).toMatchObject({ switchPending: true, submission: undefined });
  });

  it.each(['Fixture one\nFixture two\r', 'Fixture spaces   \r', 'Fixture one\rFixture two\r', '\n'])(
    'refuses raw proof when mux delivery itself changes input bytes',
    async (data) => {
      const { session } = fixture();
      expect(await session.writeViaMux(data, { fromUser: true })).toBe(true);
      expect(session.getRecoveryContext()).toMatchObject({ switchPending: true, submission: undefined });
    }
  );

  it.each(['Fixture\x1b[D edit\r', '\x1b[A suffix\r', `${'x'.repeat(9_000)}\r`, '\r', '/new\r'])(
    'never lifts the restored veto for uncertain, empty, oversized or slash input',
    async (data) => {
      const { session } = fixture();
      expect(await session.writeViaMux(data, { fromUser: true })).toBe(true);
      expect(session.getRecoveryContext()).toMatchObject({ switchPending: true, submission: undefined });
    }
  );

  it('invalidates old proof immediately on cursor/history input, before Enter', async () => {
    const { session } = fixture(false);
    await session.writeViaMux('Known fixture.\r', { fromUser: true });
    expect(session.getRecoveryContext().submission).toBeDefined();
    await session.writeViaMux('\x1b[A', { fromUser: true });
    expect(session.getRecoveryContext()).toMatchObject({ switchPending: true, submission: undefined });
  });

  it('does not let an older asynchronous send clear a newer switch veto', async () => {
    const { session, mux } = fixture();
    const sent = createDeferred<boolean>();
    mux.sendInput.mockReturnValueOnce(sent.promise);
    const older = session.writeViaMux('Old fixture.\r', { fromUser: true });
    await session.writeViaMux('/resume fixture\r', { fromUser: true });
    sent.resolve(true);
    expect(await older).toBe(true);
    expect(session.getRecoveryContext()).toMatchObject({ switchPending: true, submission: undefined });
  });

  it('never treats programmatic writes as browser submission evidence', async () => {
    const { session } = fixture();
    await session.writeViaMux('Fixture automation.\r');
    expect(session.getRecoveryContext()).toMatchObject({ switchPending: true, submission: undefined });
  });
});
