/**
 * @fileoverview Shift/Ctrl+Enter against the SHIPPED key handlers, with real keystrokes in Chromium.
 *
 * xterm runs the custom key handler for keydown, keypress AND keyup, and drops a keypress that
 * carries Ctrl/Alt but NOT a Shift-only one. A handler that returns false for keydown alone
 * therefore lets Shift+Enter's keypress fall through to onData as a bare \r, which went out over
 * the WebSocket ahead of the async send-key fetch and submitted the prompt (#520). Ctrl+Enter
 * worked all along because Chromium fires no keypress for it.
 *
 * The page is the real app served by a real WebServer, so the handlers under test are the ones
 * terminal-ui.js (the main pane, `app.terminal`) and terminal-tile.js (Pane B, a real
 * `TerminalTile`) attach. Nothing restates their predicate. What stands in for the server is
 * only the edge: a fetch wrapper records the send-key POSTs instead of letting them reach tmux, and
 * no session exists behind the ids, so nothing is ever typed into a real pane.
 *
 * Browser-driven, so it is excluded from `npm run test:ci` like the other Playwright suites:
 *   npm run test:browser -- test/shift-enter-keypress.browser.test.ts
 * The CI gate's guard on the same handlers is the source check in
 * test/shift-enter-keypress-swallowed.test.ts.
 *
 * Port: ephemeral
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';
import { TmuxManager } from '../src/tmux-manager.js';

let baseUrl: string;
const MAIN_ID = 'shift-enter-probe-main';
const PANE_B_ID = 'shift-enter-probe-pane-b';

interface Pressed {
  /** What xterm emitted through onData, i.e. what would have been written to the PTY. */
  data: string[];
  /** The send-key POSTs the handler made, as `<session id> <key>`. */
  sendKeys: string[];
  /** Whether xterm's own textarea held focus, so a key that emits nothing was really delivered. */
  focused: boolean;
}

describe('Shift/Ctrl+Enter through the shipped key handlers (keypress must be swallowed too)', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    // This suite serves assets and intercepts all input for nonexistent ids.
    // Test-mode mux IO is already disabled; no installed tmux is needed.
    vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);
    server = new WebServer(0, false, true);
    await server.start();
    baseUrl = `http://localhost:${server.boundPort}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
    page = await browser.newPage();
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).app?.terminal, null, { timeout: 30000 });
    await page.evaluate(
      ({ paneBId }) => {
        const w = window as any;
        // Record send-key instead of reaching the server (no tmux pane exists behind these ids).
        w.__sendKeys = [] as string[];
        const realFetch = window.fetch.bind(window);
        window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          const probe = w.__queueProbe;
          if (probe && url.match(new RegExp(`/api/sessions/${probe.id}/(input|send-key)$`))) {
            const body = JSON.parse(String(init?.body ?? '{}'));
            const value = body.key ? `<${body.key}>` : body.input;
            probe.requests.push(value);
            if (body.key && probe.reserved) {
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    success: false,
                    errorCode: 'OPERATION_FAILED',
                    retryable: true,
                    notSent: true,
                  }),
                  { status: 422, headers: { 'Content-Type': 'application/json' } }
                )
              );
            }
            probe.delivered.push(value);
            return Promise.resolve(new Response('{}', { status: 200 }));
          }
          const m = /\/api\/sessions\/([^/]+)\/send-key$/.exec(url);
          if (m) {
            w.__sendKeys.push(`${m[1]} ${JSON.parse(String(init?.body ?? '{}')).key}`);
            return Promise.resolve(
              new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
            );
          }
          return realFetch(input, init);
        };

        // Pane B, built by the real class. connect() installs the key handler synchronously,
        // before its first await; the buffer fetch and WebSocket for the missing session just fail.
        const mount = document.createElement('div');
        mount.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:300px;';
        document.body.appendChild(mount);
        const pane = new w.TerminalTile(paneBId, mount, { mode: 'claude' });
        void pane.connect().catch(() => {});
        // What xterm emits here is exactly what Pane B's own onData forwards to its WebSocket.
        w.__paneBData = [] as string[];
        pane.terminal.onData((d: string) => w.__paneBData.push(d));
        w.__paneB = pane;

        // The bare xterm the old keydown-only gate is reproduced on (see the first test).
        const host = document.createElement('div');
        host.style.cssText = 'position:fixed;left:420px;top:0;width:400px;height:300px;';
        document.body.appendChild(host);
        const old = new w.Terminal();
        old.open(host);
        w.__oldData = [] as string[];
        old.onData((d: string) => w.__oldData.push(d));
        old.attachCustomKeyEventHandler(
          (ev: KeyboardEvent) => !(ev.key === 'Enter' && (ev.shiftKey || ev.ctrlKey) && ev.type === 'keydown')
        );
        w.__oldTerm = old;
      },
      { paneBId: PANE_B_ID }
    );
  }, 90000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
    vi.restoreAllMocks();
  }, 60000);

  /**
   * Press `key` in the main pane. `sessionId` null is the welcome screen; otherwise the app thinks
   * that session is active, local echo is off (the desktop default) and its real send path,
   * `_sendInputAsync`, is recorded instead of posting.
   */
  async function pressMain(key: string, sessionId: string | null): Promise<Pressed> {
    await page.evaluate((id) => {
      const w = window as any;
      const app = w.app;
      w.__mainSaved ??= { id: app.activeSessionId, echo: app._localEchoEnabled, send: app._sendInputAsync };
      w.__mainData = [] as string[];
      w.__sendKeys.length = 0;
      app.activeSessionId = id;
      app._localEchoEnabled = false;
      app._pendingInput = '';
      app._sendInputAsync = (_sid: string, chunk: string) => void w.__mainData.push(chunk);
      app.terminal.focus();
    }, sessionId);
    const focused = await page.evaluate(() => document.activeElement === (window as any).app.terminal.textarea);
    await page.keyboard.press(key);
    // The main pane batches onData through a short flush timer before _sendInputAsync.
    await page.waitForTimeout(150);
    return page.evaluate((f) => {
      const w = window as any;
      const app = w.app;
      const out = { data: [...w.__mainData], sendKeys: [...w.__sendKeys], focused: f };
      app.activeSessionId = w.__mainSaved.id;
      app._localEchoEnabled = w.__mainSaved.echo;
      app._sendInputAsync = w.__mainSaved.send;
      app._pendingInput = '';
      return out;
    }, focused);
  }

  async function pressIn(which: 'paneB' | 'old', key: string): Promise<Pressed> {
    await page.evaluate((k) => {
      const w = window as any;
      w[k === 'paneB' ? '__paneBData' : '__oldData'].length = 0;
      w.__sendKeys.length = 0;
      (k === 'paneB' ? w.__paneB.terminal : w.__oldTerm).focus();
    }, which);
    const focused = await page.evaluate((k) => {
      const w = window as any;
      return document.activeElement === (k === 'paneB' ? w.__paneB.terminal : w.__oldTerm).textarea;
    }, which);
    await page.keyboard.press(key);
    await page.waitForTimeout(50);
    return page.evaluate(
      ({ k, f }) => {
        const w = window as any;
        return { data: [...w[k === 'paneB' ? '__paneBData' : '__oldData']], sendKeys: [...w.__sendKeys], focused: f };
      },
      { k: which, f: focused }
    );
  }

  it('reproduces the leak on a bare xterm with the old keydown-only gate (the behaviour the fix depends on)', async () => {
    // Not shipped code: this pins the xterm behaviour, so a future xterm that stops emitting the
    // Shift-only keypress shows up here instead of silently turning the tests below vacuous.
    const shift = await pressIn('old', 'Shift+Enter');
    expect(shift.focused).toBe(true);
    expect(shift.data).toEqual(['\r']);
    expect((await pressIn('old', 'Control+Enter')).data).toEqual([]);
  });

  it('main pane (terminal-ui.js): Shift+Enter and Ctrl+Enter write nothing and POST send-key exactly once', async () => {
    const shift = await pressMain('Shift+Enter', MAIN_ID);
    expect(shift.focused).toBe(true);
    expect(shift.data).toEqual([]);
    // Once, from the keydown: the swallowed keypress and keyup must not send again.
    expect(shift.sendKeys).toEqual([`${MAIN_ID} S-Enter`]);

    const ctrl = await pressMain('Control+Enter', MAIN_ID);
    expect(ctrl.data).toEqual([]);
    expect(ctrl.sendKeys).toEqual([`${MAIN_ID} C-Enter`]);
  });

  it('main pane: plain Enter still reaches the send path as \\r, and Alt+Enter as ESC CR', async () => {
    const enter = await pressMain('Enter', MAIN_ID);
    expect(enter.focused).toBe(true);
    expect(enter.data).toEqual(['\r']);
    expect(enter.sendKeys).toEqual([]);

    const alt = await pressMain('Alt+Enter', MAIN_ID);
    expect(alt.data).toEqual(['\x1b\r']);
    expect(alt.sendKeys).toEqual([]);
  });

  it('main pane on the welcome screen: Shift+Enter sends nothing and posts no send-key', async () => {
    // With no active session the app's onData drops input anyway, so this pins the send-key
    // guard (`this.activeSessionId`), not the keypress swallow; the tests above pin that.
    const shift = await pressMain('Shift+Enter', null);
    expect(shift.focused).toBe(true);
    expect(shift.data).toEqual([]);
    expect(shift.sendKeys).toEqual([]);
  });

  it("Pane B (terminal-tile.js): Shift+Enter and Ctrl+Enter write nothing and POST send-key once for Pane B's own session", async () => {
    const shift = await pressIn('paneB', 'Shift+Enter');
    expect(shift.focused).toBe(true);
    expect(shift.data).toEqual([]);
    expect(shift.sendKeys).toEqual([`${PANE_B_ID} S-Enter`]);

    const ctrl = await pressIn('paneB', 'Control+Enter');
    expect(ctrl.data).toEqual([]);
    expect(ctrl.sendKeys).toEqual([`${PANE_B_ID} C-Enter`]);

    const enter = await pressIn('paneB', 'Enter');
    expect(enter.data).toEqual(['\r']);
    expect(enter.sendKeys).toEqual([]);
  });

  it.each([
    ['main', 'Shift+Enter', 'S-Enter'],
    ['paneB', 'Control+Enter', 'C-Enter'],
  ])('%s queues a recovery-blocked %s ahead of subsequent typing, delivering it once', async (pane, chord, key) => {
    const id = pane === 'main' ? MAIN_ID : PANE_B_ID;
    await page.evaluate(
      ({ id, pane }) => {
        const w = window as any;
        const app = w.app;
        w.__queueSaved = { id: app.activeSessionId, echo: app._localEchoEnabled, socketFor: app._inputSocketFor };
        // Stand in for the transport only. Both handlers and the app's input
        // queue, ACK handling and redelivery sweep are the shipped code.
        app._inputSocketFor = () => null;
        app.activeSessionId = id;
        app._localEchoEnabled = false;
        app._pendingInput = '';
        w.__queueProbe = { id, reserved: true, requests: [], delivered: [] };
        (pane === 'main' ? app.terminal : w.__paneB.terminal).focus();
      },
      { id, pane }
    );
    try {
      await page.keyboard.type('before');
      await page.keyboard.press(chord);
      await page.waitForFunction((key) => (window as any).__queueProbe.requests.includes(`<${key}>`), key);
      await page.keyboard.type('after');
      await page.waitForTimeout(100);
      expect(await page.evaluate(() => (window as any).__queueProbe.delivered.join(''))).toBe('before');
      await page.evaluate(() => {
        (window as any).__queueProbe.reserved = false;
      });
      await page.waitForFunction(() => (window as any).__queueProbe.delivered.join('').endsWith('after'), null, {
        timeout: 10000,
      });
      const probe = await page.evaluate(() => (window as any).__queueProbe);
      expect(probe.delivered.join('')).toBe(`before<${key}>after`);
      expect(probe.delivered.filter((value: string) => value === `<${key}>`)).toHaveLength(1);
      expect(probe.requests.filter((value: string) => value === `<${key}>`).length).toBeGreaterThan(1);
    } finally {
      await page.evaluate(() => {
        const w = window as any;
        const app = w.app;
        app.activeSessionId = w.__queueSaved.id;
        app._localEchoEnabled = w.__queueSaved.echo;
        app._inputSocketFor = w.__queueSaved.socketFor;
        w.__queueProbe = null;
      });
    }
  });
  it.each(['unchanged', 'tab-switch'] as const)(
    'pastes multiline Codex text once after replay and cancels a changed target: %s',
    async (target) => {
      const result = await page.evaluate(
        async ({ id, target }) => {
          const w = window as any;
          const app = w.app;
          const previous = {
            id: app.activeSessionId,
            echo: app._localEchoEnabled,
            send: app._sendInputAsync,
            session: app.sessions.get(id),
          };
          const chunks: string[] = [];
          app.activeSessionId = id;
          app.sessions.set(id, { mode: 'codex' });
          app._localEchoEnabled = false;
          app._pendingInput = '';
          app._sendInputAsync = (_sid: string, data: string) => chunks.push(data);
          try {
            await new Promise<void>((resolve) => app.terminal.write('\x1b[?2004l', resolve));
            app._handleImagePaste();
            const trap = document.activeElement as HTMLElement;
            if (target === 'tab-switch') app.activeSessionId = 'different-paste-target';
            const clipboard = new DataTransfer();
            clipboard.setData('text/plain', '  α\r\n🙂\n終  ');
            trap.dispatchEvent(
              new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true })
            );
            trap.dispatchEvent(
              new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true })
            );
            await new Promise((resolve) => setTimeout(resolve, 150));
            return { chunks, removed: !trap.isConnected };
          } finally {
            app._activePasteCleanup?.();
            app.activeSessionId = previous.id;
            app._localEchoEnabled = previous.echo;
            app._sendInputAsync = previous.send;
            app._pendingInput = '';
            if (previous.session) app.sessions.set(id, previous.session);
            else app.sessions.delete(id);
          }
        },
        { id: MAIN_ID, target }
      );
      expect(result.removed).toBe(true);
      expect(result.chunks.join('')).toBe(target === 'unchanged' ? '\x1b[200~  α\r🙂\r終  \x1b[201~' : '');
    }
  );
});
