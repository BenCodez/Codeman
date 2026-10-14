/** @fileoverview Recovery UI exercised over the real markup with fake API responses; no CLI, sockets, or sessions. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialRecoveryState, type RecoveryState } from '../src/recovery/types.js';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const read = (name: string) => readFileSync(resolve(PUBLIC, name), 'utf8');
const INDEX = read('index.html');
const RECOVERY = read('recovery-ui.js');
const openDoms: JSDOM[] = [];

function harness(initial = initialRecoveryState()) {
  const dom = new JSDOM(INDEX, { runScripts: 'outside-only', url: 'http://localhost/' });
  openDoms.push(dom);
  const context = dom.getInternalVMContext();
  vm.runInContext(
    'class CodemanApp {}\nclass FocusTrap { activate() {} deactivate() {} }\nfunction parseSessionPrefix() { return null; }',
    context
  );
  const browser = dom.window as unknown as {
    fetch: ReturnType<typeof vi.fn>;
    __codemanCliCatalog: Array<Record<string, unknown>>;
  };
  browser.__codemanCliCatalog = [{ id: 'codex', external: true, recovery: 'codex-rollout' }];
  let state = structuredClone(initial);
  const fetchMock = vi.fn(async (url: string, options?: { method?: string; body?: string }) => {
    if (url.endsWith('/config')) {
      state = { ...state, config: { ...state.config, ...JSON.parse(options?.body ?? '{}') } };
    } else if (url.endsWith('/retry')) {
      state = { ...state, phase: 'watching', lastReason: 'scheduled', attempts: state.attempts + 1 };
    } else if (url.endsWith('/reset')) {
      state = { ...state, attempts: 0, failedAttempts: 0, circuitOpen: false, lastReason: 'manual-reset' };
    }
    return { ok: true, json: async () => ({ success: true, data: structuredClone(state) }) };
  });
  browser.fetch = fetchMock;
  for (const file of ['api-client.js', 'recovery-ui.js', 'respawn-ui.js', 'session-ui.js']) {
    vm.runInContext(read(file), context, { filename: file });
  }
  // Plain browser UI modules deliberately have no TS declarations.
  const app = vm.runInContext('new CodemanApp()', context) as any;
  app.sessions = new Map([
    ['session-a', { id: 'session-a', mode: 'codex', pid: 123, name: 'Demo' }],
    ['session-b', { id: 'session-b', mode: 'codex', pid: 456, name: 'Other' }],
  ]);
  app.editingSessionId = 'session-a';
  app.respawnStatus = {};
  app.ralphStates = new Map();
  app.showToast = vi.fn();
  for (const name of [
    'selectDurationPreset',
    'loadSavedRespawnConfig',
    'updateAutoResumeStatus',
    'renderPresetDropdown',
    '_syncSettingsChips',
    'loadRunSummary',
    'stopRunSummaryAutoRefresh',
  ])
    app[name] = vi.fn();
  const doc = dom.window.document;
  const get = (id: string) => doc.getElementById(id)!;
  const input = (id: string) => get(id) as HTMLInputElement;
  const button = (id: string) => get(id) as HTMLButtonElement;
  async function open(id = 'session-a') {
    app.editingSessionId = id;
    app.openRecoveryOptions(id);
    await vi.waitFor(() => expect(app._recoveryView?.loading).toBe(false));
  }
  return { app, dom, doc, get, input, button, browser, fetchMock, open };
}

afterEach(() => {
  for (const dom of openDoms.splice(0)) dom.window.close();
});

function enabledState(): RecoveryState {
  const state = initialRecoveryState();
  state.config.enabled = true;
  state.activity = 'interrupted';
  state.phase = 'watching';
  state.lastReason = 'turn-interrupted';
  return state;
}

describe('Recovery Session Options', () => {
  it('allows guarded manual stall retries while automatic recovery is off', async () => {
    const state = initialRecoveryState();
    state.config.detectStalls = true;
    state.activity = 'working';
    state.lastReason = 'turn-running';
    const h = harness(state);
    await h.open();
    expect(h.button('recoveryRetryBtn').disabled).toBe(false);
    await h.app.retryRecovery();
    await vi.waitFor(() =>
      expect(h.fetchMock).toHaveBeenCalledWith(
        '/api/sessions/session-a/recovery/retry',
        expect.objectContaining({ method: 'POST' })
      )
    );
    h.app._onSessionRecovery({ sessionId: 'session-a', state: { ...state, circuitOpen: true } });
    expect(h.button('recoveryRetryBtn').disabled).toBe(true);
  });
  it('gates the tab on catalog capability and does not fetch unsupported modes', () => {
    const h = harness();
    h.browser.__codemanCliCatalog = [{ id: 'codex', external: true }];
    expect(h.app.openRecoveryOptions('session-a')).toBe(false);
    expect(h.doc.querySelector<HTMLElement>('[data-tab="recovery"]')!.style.display).toBe('none');
    expect(h.fetchMock).not.toHaveBeenCalled();
    // A capability is authoritative; the mode name alone is not.
    h.browser.__codemanCliCatalog = [{ id: 'other', recovery: 'codex-rollout' }];
    expect(h.app.supportsSessionRecovery({ mode: 'other' })).toBe(true);
  });

  it('opens the real Session Options modal on Recovery and tears down on close', async () => {
    const h = harness();
    h.app.openSessionOptions('session-a');
    await vi.waitFor(() => expect(h.app._recoveryView?.loading).toBe(false));
    expect(h.get('sessionOptionsModal').classList.contains('active')).toBe(true);
    expect(h.get('recovery-tab').classList.contains('hidden')).toBe(false);
    expect(h.get('context-tab').classList.contains('hidden')).toBe(true);
    expect(h.doc.querySelector<HTMLElement>('[data-tab="recovery"]')!.style.display).toBe('');
    h.app.closeSessionOptions();
    expect(h.get('sessionOptionsModal').classList.contains('active')).toBe(false);
    expect(h.app._recoveryView).toBeNull();
    expect(h.app.editingSessionId).toBeNull();
  });

  it('shows observation independently from default-off automation and abbreviates verified identity', async () => {
    const state = initialRecoveryState();
    state.activity = 'working';
    state.phase = 'paused';
    state.conversationId = '12345678-1234-1234-1234-123456789abc';
    state.attempts = 2;
    state.failedAttempts = 1;
    state.lastSuccessfulRecovery = 100_000;
    state.needsAttention = true;
    const h = harness(state);
    await h.open();
    expect(h.get('recoveryActivity').textContent).toBe('Working');
    expect(h.get('recoveryPhase').textContent).toBe('Off');
    expect(h.get('recoveryConversationId').textContent).toBe('12345678');
    expect(h.get('recoveryAttempts').textContent).toBe('2 / 3');
    expect(h.get('recoveryFailures').textContent).toBe('1');
    expect(h.get('recoveryLastSuccess').textContent).not.toBe('—');
    expect(h.get('recoveryAttention').textContent).toBe('Needs your attention');
    expect(h.input('recoveryEnabled').checked).toBe(false);
    expect(h.button('recoveryRetryBtn').disabled).toBe(true);
    expect((h.get('recoverySettings') as HTMLFieldSetElement).disabled).toBe(false);
  });

  it('sends bounded partial settings with seconds converted to milliseconds', async () => {
    const h = harness();
    await h.open();
    h.input('recoveryStalls').checked = true;
    await h.app.saveRecoverySetting('detectStalls', h.input('recoveryStalls'));
    h.input('recoveryRetryDelay').value = '25';
    await h.app.saveRecoverySetting('retryDelayMs', h.input('recoveryRetryDelay'));
    const requests = h.fetchMock.mock.calls.slice(1);
    expect(requests.map(([url, options]) => [url, options?.method, JSON.parse(options?.body ?? '{}')])).toEqual([
      ['/api/sessions/session-a/recovery/config', 'PUT', { detectStalls: true }],
      ['/api/sessions/session-a/recovery/config', 'PUT', { retryDelayMs: 25_000 }],
    ]);
    expect(h.input('recoveryRetryDelay').value).toBe('25');
    expect(h.get('recovery-tab').textContent).toContain('Live silence only asks for attention.');
  });

  it('rejects invalid limits and preserves the confirmed values', async () => {
    const h = harness();
    await h.open();
    h.input('recoveryMaxRetries').value = '0';
    await h.app.saveRecoverySetting('maxRetries', h.input('recoveryMaxRetries'));
    h.input('recoveryMaxDelay').value = '10';
    await h.app.saveRecoverySetting('maxRetryDelayMs', h.input('recoveryMaxDelay'));
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(h.input('recoveryMaxRetries').value).toBe('3');
    expect(h.input('recoveryMaxDelay').value).toBe('120');
    expect(h.app.showToast).toHaveBeenCalledWith('Maximum retry delay must be at least the retry delay', 'warning');
  });

  it('calls retry and reset without caller prompts and renders their returned states', async () => {
    const h = harness(enabledState());
    await h.open();
    await h.app.retryRecovery();
    expect(h.get('recoveryAttempts').textContent).toBe('1 / 3');
    expect(h.get('recoveryReason').textContent).toBe('Recovery is scheduled');
    await h.app.resetRecovery();
    expect(h.get('recoveryAttempts').textContent).toBe('0 / 3');
    expect(h.get('recoveryReason').textContent).toBe('Recovery limits were reset');
    expect(h.fetchMock.mock.calls.slice(1).map(([url, options]) => [url, options?.method, options?.body])).toEqual([
      ['/api/sessions/session-a/recovery/retry', 'POST', undefined],
      ['/api/sessions/session-a/recovery/reset', 'POST', undefined],
    ]);
  });

  it('permits an explicit one-shot retry while automatic recovery is off', async () => {
    const state = enabledState();
    state.config.enabled = false;
    const h = harness(state);
    await h.open();
    expect(h.get('recoveryPhase').textContent).toBe('Off');
    expect(h.button('recoveryRetryBtn').disabled).toBe(false);
    await h.app.retryRecovery();
    expect(h.fetchMock.mock.calls[1][0]).toBe('/api/sessions/session-a/recovery/retry');
    expect(h.input('recoveryEnabled').checked).toBe(false);
  });

  it('shows and delivers the explicit missing owned remote worker action only at its boundary', async () => {
    const state = initialRecoveryState();
    state.lastReason = 'remote-session-missing';
    const h = harness(state);
    h.app.sessions.set('session-a', {
      id: 'session-a',
      mode: 'codex',
      pid: null,
      remote: { owned: true, label: 'Fixture' },
    });
    await h.open();
    expect(h.button('recoveryRestoreRemoteBtn').hidden).toBe(false);
    expect(h.button('recoveryRestoreRemoteBtn').disabled).toBe(false);
    await h.app.restoreRemoteRecovery();
    expect(h.fetchMock.mock.calls[1]).toMatchObject([
      '/api/sessions/session-a/recovery/restore-remote',
      { method: 'POST' },
    ]);

    h.app.sessions.get('session-a').remote.owned = false;
    h.app._renderRecoveryStatus();
    expect(h.button('recoveryRestoreRemoteBtn').hidden).toBe(true);
  });

  it.each(['managed-daemon', 'unsupported-location', 'unowned-session'] as const)(
    'shows the paused reason and disables retry for %s',
    async (reason) => {
      const state = enabledState();
      state.phase = 'paused';
      state.lastReason = reason;
      const h = harness(state);
      await h.open();
      expect(h.get('recoveryPhase').textContent).toBe('Paused');
      expect(h.get('recoveryReason').textContent).not.toBe(reason);
      expect(h.button('recoveryRetryBtn').disabled).toBe(true);
      await h.app.retryRecovery();
      expect(h.fetchMock).toHaveBeenCalledTimes(1);
      expect(h.get('recovery-tab').textContent).toContain('launched with --no-daemon');
    }
  );

  it('keeps a focused numeric edit while status events arrive, and ignores other sessions', async () => {
    const h = harness();
    await h.open();
    h.input('recoveryMaxRetries').focus();
    h.input('recoveryMaxRetries').value = '5';
    h.app._onSessionRecovery({ sessionId: 'session-b', state: enabledState() });
    expect(h.get('recoveryPhase').textContent).toBe('Off');
    h.app._onSessionRecovery({ sessionId: 'session-a', state: enabledState() });
    expect(h.get('recoveryPhase').textContent).toBe('Monitoring');
    expect(h.input('recoveryMaxRetries').value).toBe('5');
  });

  it('bounds event history and renders unknown reasons as text without markup', async () => {
    const state = enabledState();
    state.history = Array.from({ length: 30 }, (_, attempt) => ({
      at: 100_000 + attempt,
      kind: 'attention',
      reason: attempt === 29 ? ('<img src=x onerror=alert(1)>' as never) : 'stalled',
      attempt,
    }));
    const h = harness(state);
    await h.open();
    expect(h.get('recoveryHistory').querySelectorAll('tr')).toHaveLength(20);
    expect(h.get('recoveryHistory').querySelector('tr')!.textContent).toContain('Unknown');
    expect(h.get('recoveryHistory').querySelector('img')).toBeNull();
    expect(h.get('recoveryHistoryEmpty').hidden).toBe(true);
  });

  it('repopulates settings when another session opens with an old numeric field focused', async () => {
    const h = harness();
    await h.open();
    h.input('recoveryMaxRetries').focus();
    h.input('recoveryMaxRetries').value = '7';
    await h.open('session-b');
    expect(h.input('recoveryMaxRetries').value).toBe('3');
    expect(h.app._recoveryView.sessionId).toBe('session-b');
  });

  it('shows API failures and rolls back settings instead of pretending they saved', async () => {
    const h = harness();
    await h.open();
    h.fetchMock.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ success: false }) }) as never);
    h.input('recoveryEnabled').checked = true;
    await h.app.saveRecoverySetting('enabled', h.input('recoveryEnabled'));
    expect(h.input('recoveryEnabled').checked).toBe(false);
    expect(h.app.showToast).toHaveBeenCalledWith(
      'Recovery action failed. Refresh status before trying again.',
      'error'
    );
  });

  it('disables stale controls when a status refresh fails, and supports refreshing again', async () => {
    const h = harness(enabledState());
    await h.open();
    h.fetchMock.mockImplementationOnce(async () => {
      throw new Error('offline');
    });
    await h.app.loadRecoveryStatus();
    expect(h.get('recoveryError').hidden).toBe(false);
    expect(h.get('recoveryPhase').textContent).toBe('Unavailable');
    expect(h.button('recoveryRetryBtn').disabled).toBe(true);
    expect(h.button('recoveryResetBtn').disabled).toBe(true);
    expect((h.get('recoverySettings') as HTMLFieldSetElement).disabled).toBe(true);
    await h.app.loadRecoveryStatus();
    expect(h.get('recoveryError').hidden).toBe(true);
    expect(h.button('recoveryRetryBtn').disabled).toBe(false);
  });

  it('does not let a stale read overwrite a newer event or another open session', async () => {
    const h = harness();
    let finish: (state: RecoveryState) => void = () => {};
    h.app._apiJson = vi.fn(
      () =>
        new Promise<RecoveryState>((resolve) => {
          finish = resolve;
        })
    );
    h.app.openRecoveryOptions('session-a');
    const signal = h.app._apiJson.mock.calls[0][1].signal as AbortSignal;
    h.app._onSessionRecovery({ sessionId: 'session-a', state: enabledState() });
    finish(initialRecoveryState());
    await vi.waitFor(() => expect(h.app._recoveryView.loading).toBe(false));
    expect(h.get('recoveryPhase').textContent).toBe('Monitoring');
    h.app.loadRecoveryStatus();
    const finishOld = finish;
    h.app.editingSessionId = 'session-b';
    h.app.openRecoveryOptions('session-b');
    finishOld(enabledState());
    await Promise.resolve();
    expect(h.app._recoveryView.sessionId).toBe('session-b');
    expect(h.get('recoveryPhase').textContent).toBe('Loading');
    h.app.closeRecoveryOptions();
    // The completed first read is not aborted; both pending reads are cancelled on view changes.
    expect(signal.aborted).toBe(false);
    expect((h.app._apiJson.mock.calls[1][1].signal as AbortSignal).aborted).toBe(true);
    expect((h.app._apiJson.mock.calls[2][1].signal as AbortSignal).aborted).toBe(true);
  });

  it('does not paint delayed action replies into a different session', async () => {
    const h = harness(enabledState());
    await h.open();
    const finishes: Array<(state: RecoveryState) => void> = [];
    h.app._apiJson = vi.fn(
      () =>
        new Promise<RecoveryState>((resolve) => {
          finishes.push(resolve);
        })
    );
    const action = h.app.retryRecovery();
    expect(h.button('recoveryResetBtn').disabled).toBe(true);
    await h.app.retryRecovery();
    expect(h.app._apiJson).toHaveBeenCalledTimes(1);
    h.app.editingSessionId = 'session-b';
    h.app.openRecoveryOptions('session-b');
    const nextView = h.app._recoveryView;
    finishes[1](initialRecoveryState());
    await vi.waitFor(() => expect(nextView.loading).toBe(false));
    finishes[0]({ ...enabledState(), attempts: 9 });
    await action;
    expect(h.get('recoveryPhase').textContent).toBe('Off');
    expect(h.get('recoveryAttempts').textContent).toBe('0 / 3');
    expect(h.app._recoveryView).toBe(nextView);
  });

  it('registers the live recovery event and refreshes after SSE reconnection', () => {
    const source = read('app.js');
    expect(source).toContain("[SSE_EVENTS.SESSION_RECOVERY, '_onSessionRecovery']");
    expect(source).toContain('if (this._recoveryView) void this.loadRecoveryStatus?.();');
    expect(INDEX).toContain('src="recovery-ui.js"');
  });

  it('translates all recovery labels and static copy to zh-CN while preserving English', () => {
    const h = harness();
    vm.runInContext(read('i18n.js'), h.dom.getInternalVMContext(), { filename: 'i18n.js' });
    const translator = (
      h.dom.window as unknown as {
        CodemanI18n: { configure(options: { language: string }): void; t(source: string): string };
      }
    ).CodemanI18n;
    const labels = new Set<string>();
    for (const name of ['REASONS', 'ACTIVITIES', 'PHASES', 'EVENTS']) {
      const block = RECOVERY.match(
        new RegExp(`const RECOVERY_UI_${name} = Object.freeze\\(\\{([\\s\\S]*?)\\}\\);`)
      )![1];
      for (const match of block.matchAll(/: '([^']+)'/g)) labels.add(match[1]);
    }
    const walker = h.doc.createTreeWalker(h.get('recovery-tab'), h.dom.window.NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node.parentElement?.closest('[data-i18n-skip]')) continue;
      const text = node.textContent?.trim() ?? '';
      if (/[A-Za-z]/.test(text)) labels.add(text);
    }
    labels.add('Choose a recovery value within the displayed limits');
    labels.add('Maximum retry delay must be at least the retry delay');
    labels.add('Recovery action failed. Refresh status before trying again.');
    expect(labels.size).toBeGreaterThan(70);
    translator.configure({ language: 'zh-CN' });
    expect([...labels].filter((label) => translator.t(label) === label)).toEqual([]);
    translator.configure({ language: 'en' });
    expect([...labels].filter((label) => translator.t(label) !== label)).toEqual([]);
  });
});
