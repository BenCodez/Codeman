/** The shipped desktop/mobile controls preserve legacy alert-only consent. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const html = readFileSync(resolve(publicDir, 'index.html'), 'utf8');
const styles = readFileSync(resolve(publicDir, 'styles.css'), 'utf8');
const mobileStyles = readFileSync(resolve(publicDir, 'mobile.css'), 'utf8');
const controller = readFileSync(resolve(publicDir, 'recovery-ui.js'), 'utf8');
const start = html.indexOf('<div class="modal" id="sessionOptionsModal">');
const end = html.indexOf('<!-- Close Session Confirmation Modal -->', start);
if (start < 0 || end < 0) throw new Error('Session Options markup unavailable');
const markup = html.slice(start, end);
const SID = '11111111-1111-4111-8111-111111111111';
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
});
afterAll(async () => browser?.close());

it.each([1440, 390])('requires a distinct owner opt-in before dead-stall retry at %spx', async (width) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  try {
    await page.route('**/*', async (route) => {
      if (route.request().isNavigationRequest())
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<!doctype html><html><head><style>${styles}</style><style>@media (max-width: 1023px) { ${mobileStyles} }</style></head><body>${markup}</body></html>`,
        });
      else await route.fulfill({ status: 204, body: '' });
    });
    await page.goto('http://codeman-stall-consent.test', { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ content: 'class CodemanApp {}; window.CodemanApp = CodemanApp;' });
    await page.addScriptTag({ content: controller });
    await page.evaluate(
      ({ sid }) => {
        const w = window as any;
        w.__codemanCliCatalog = [{ id: 'codex', recovery: 'codex-rollout' }];
        const app = new w.CodemanApp();
        app.sessions = new Map([[sid, { mode: 'codex' }]]);
        app.editingSessionId = sid;
        app.showToast = () => {};
        // This is the exact pre-feature journal shape: detection has no restart flag.
        let state = {
          version: 1,
          activity: 'working',
          phase: 'paused',
          lastReason: 'stall-unverified',
          needsAttention: true,
          attempts: 0,
          failedAttempts: 0,
          history: [],
          config: {
            enabled: true,
            recoverInterrupted: true,
            recoverCrashes: false,
            detectStalls: true,
            maxRetries: 3,
            retryDelayMs: 15000,
            maxRetryDelayMs: 120000,
            maxRecoveryDurationMs: 900000,
            stalledAfterMs: 300000,
          },
        };
        w.__consentCalls = [];
        app._apiJson = async (url: string, options?: any) => {
          if (options?.method === 'PUT') {
            w.__consentCalls.push({ url, body: options.body });
            state = { ...state, config: { ...state.config, ...options.body } };
          }
          return state;
        };
        w.app = app;
        document.getElementById('sessionOptionsModal')?.classList.add('active');
        document.querySelectorAll('#sessionOptionsModal .set-section').forEach((section) => {
          section.classList.toggle('hidden', section.id !== 'recovery-tab');
        });
        app.openRecoveryOptions(sid);
      },
      { sid: SID }
    );
    await page.waitForFunction(() => !(window as any).app._recoveryView.loading);
    const detection = page.locator('#recoveryStalls');
    const restart = page.locator('#recoveryRestartStalls');
    const retry = page.locator('#recoveryRetryBtn');
    expect(await detection.isChecked()).toBe(true);
    expect(await restart.isChecked()).toBe(false);
    expect(await retry.isDisabled()).toBe(true);
    expect(await page.locator('label[for="recoveryRestartStalls"]').isVisible()).toBe(true);
    const limit = page.locator('#recoveryMaxRetries');
    await limit.fill('4');
    await limit.press('Tab');
    await page.waitForFunction(() => (window as any).__consentCalls.length === 1);
    expect(await restart.isChecked()).toBe(false);
    expect(await retry.isDisabled()).toBe(true);
    await page.locator('label[for="recoveryRestartStalls"]').click();
    await page.waitForFunction(() => !(window as any).app._recoveryView.busy);
    expect(await restart.isChecked()).toBe(true);
    expect(await retry.isDisabled()).toBe(false);
    await page.locator('label[for="recoveryStalls"]').click();
    await page.waitForFunction(() => !(window as any).app._recoveryView.busy);
    expect(await restart.isChecked()).toBe(true);
    expect(await retry.isDisabled()).toBe(true);
    expect(await page.evaluate(() => (window as any).__consentCalls)).toEqual([
      { url: `/api/sessions/${SID}/recovery/config`, body: { maxRetries: 4 } },
      { url: `/api/sessions/${SID}/recovery/config`, body: { restartStalls: true } },
      { url: `/api/sessions/${SID}/recovery/config`, body: { detectStalls: false } },
    ]);
  } finally {
    await page.close();
  }
});
