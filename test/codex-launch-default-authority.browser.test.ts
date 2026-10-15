/** Real Chromium run clicks and real injected routes; CLI/native/transport effects are mocked. */
import { readFileSync } from 'node:fs';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { createRouteTestHarness, type RouteTestHarness } from './routes/_route-test-utils.js';
import { registerSessionRoutes } from '../src/web/routes/session-routes.js';
import { CASES_DIR, SETTINGS_PATH } from '../src/web/route-helpers.js';
import { Session } from '../src/session.js';
import { buildCodexCommand } from '../src/tmux-manager.js';
import { safeRmHomeTree } from './mocks/index.js';
vi.mock('../src/utils/cli-launcher.js', async (original) => {
  const actual = await original<typeof import('../src/utils/cli-launcher.js')>();
  return { ...actual, resolveCliLaunchError: vi.fn().mockResolvedValue(null) };
});
let browser: Browser;
let page: Page;
let harness: RouteTestHarness;
const writes: Array<Record<string, any>> = [];
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});
beforeEach(async () => {
  writes.length = 0;
  await mkdir(dirname(SETTINGS_PATH), { recursive: true });
  harness = await createRouteTestHarness(registerSessionRoutes);
  vi.spyOn(Session.prototype, 'startInteractive').mockResolvedValue(undefined);
});
afterEach(async () => {
  await page?.close();
  await harness.app.close();
  for (const session of harness.ctx.sessions.values()) if (session instanceof Session) await session.stop(false);
  safeRmHomeTree(CASES_DIR);
  await rm(SETTINGS_PATH, { force: true });
  vi.restoreAllMocks();
});
for (const width of [390, 1280]) {
  it.each([false, true])(
    `uses current server launch defaults after a stale cached value %s at ${width}px`,
    async (cached) => {
      const current = !cached;
      await writeFile(SETTINGS_PATH, JSON.stringify({ codexNoDaemon: current, codexNoAltScreen: current }));
      const context = await browser.newContext({
        viewport: { width, height: 800 },
        ...(width < 600 ? { isMobile: true, hasTouch: true } : {}),
      });
      page = await context.newPage();
      try {
        await page.exposeFunction('launchBackend', async (url: string, raw?: string) => {
          if (url === '/api/codex/status') return { success: true, data: { available: true } };
          const payload = raw ? JSON.parse(raw) : undefined;
          if (payload) writes.push(payload);
          const response = await harness.app.inject({
            method: payload ? 'POST' : 'GET',
            url,
            ...(payload ? { payload } : {}),
          });
          expect(response.statusCode, response.body).toBe(200);
          const result = response.json();
          return result.success === undefined ? { success: true, data: result } : result;
        });
        await page.setContent(
          `<select id="quickStartCase"><option selected>codex-default-browser</option></select><input id="tabCount" value="1"><button id="runBtn" onclick="app.run()">Run</button>`
        );
        await page.addScriptTag({ content: 'window.CodemanApp = class {};' });
        for (const name of ['settings-ui.js', 'session-ui.js'])
          await page.addScriptTag({
            content: readFileSync(resolve(import.meta.dirname, '../src/web/public', name), 'utf8'),
          });
        await page.evaluate((cached) => {
          const w = window as any;
          w.app = new w.CodemanApp();
          const app = w.app;
          Object.assign(app, {
            _runMode: 'codex',
            _runMinLockMs: 0,
            _cachedAppSettings: { codexNoDaemon: cached, codexNoAltScreen: cached },
            terminal: { clear() {}, writeln() {}, focus() {} },
            getCaseSettings: () => ({}),
            buildEnvOverrides: () => ({}),
            sessions: new Map(),
            selectSession: async (id: string) => {
              w.selected = id;
            },
          });
          app._onSessionCreated = (session: { id: string }) => app.sessions.set(session.id, session);
          w.fetch = async (url: string, init?: { body?: string }) => ({
            json: async () => w.launchBackend(url, init?.body),
          });
        }, cached);
        await page.locator('#runBtn').click();
        await expect.poll(() => page.evaluate(() => (window as any).selected)).toBeTruthy();
        const session = [...harness.ctx.sessions.values()].at(-1) as Session;
        expect(session.codexConfig?.noDaemon === true).toBe(current);
        expect(session.codexConfig?.noAltScreen === true).toBe(current);
        expect(buildCodexCommand(session.codexConfig).includes('--no-daemon')).toBe(current);
        expect(buildCodexCommand(session.codexConfig).includes('--no-alt-screen')).toBe(current);
        expect(writes).toHaveLength(1);
        expect(writes[0].codexConfig).not.toHaveProperty('noDaemon');
        expect(writes[0].codexConfig).not.toHaveProperty('noAltScreen');
        expect(await page.evaluate(() => (window as any).app._cachedAppSettings.codexNoDaemon)).toBe(cached);
      } finally {
        await context.close();
      }
    }
  );
}
