/** Real-browser responsive layout coverage for Session Options. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const html = readFileSync(resolve(publicDir, 'index.html'), 'utf8');
const styles = readFileSync(resolve(publicDir, 'styles.css'), 'utf8');
const mobileStyles = readFileSync(resolve(publicDir, 'mobile.css'), 'utf8');
type PasteApp = {
  _pendingDeliveries: Map<string, Array<{ data: string; useMux: boolean }>>;
  _postDraining: Set<string>;
  _persistReliableState(): void;
  _persistReliableNow(): void;
  _loadReliableState(): void;
  _drainSession(sessionId: string): void;
};
type PasteWindow = Window & {
  app: PasteApp;
  __pasteFixture(fields: object): PasteApp;
  __openShellPaste(): void;
};

function sessionOptionsMarkup() {
  const start = html.indexOf('<div class="modal" id="sessionOptionsModal">');
  const end = html.indexOf('<!-- Close Session Confirmation Modal -->', start);
  if (start < 0 || end < 0) throw new Error('Session Options markup not found');
  return html.slice(start, end);
}

describe('Session Options responsive layout in Chromium', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  });

  afterAll(async () => browser.close());

  async function renderAt(width: number) {
    await page.setViewportSize({ width, height: 1000 });
    await page.setContent(`<!doctype html><html><head><style>${styles}</style>
      <style>@media (max-width: 1023px) { ${mobileStyles} }</style></head>
      <body>${sessionOptionsMarkup()}</body></html>`);
    await page.evaluate(() => {
      document.getElementById('sessionOptionsModal')!.classList.add('active');
      document
        .querySelectorAll('#sessionOptionsModal .set-section')
        .forEach((section) => section.classList.add('hidden'));
      document.getElementById('context-tab')!.classList.remove('hidden');
    });
  }

  async function metrics() {
    return page.evaluate(() => {
      const modal = document.querySelector<HTMLElement>('#sessionOptionsModal .modal-content')!;
      const doc = document.getElementById('sessionOptionsDoc')!;
      const panel = document.getElementById('context-tab')!;
      const header = panel.querySelector<HTMLElement>(':scope > .set-section-head')!;
      const blurb = panel.querySelector<HTMLElement>(':scope > .set-section-blurb')!;
      return {
        modalWidth: modal.getBoundingClientRect().width,
        docFits: doc.scrollWidth === doc.clientWidth,
        panelFits: panel.scrollWidth === panel.clientWidth,
        tracks: getComputedStyle(panel).gridTemplateColumns.split(' '),
        headerGridColumn: getComputedStyle(header).gridColumn,
        blurbGridColumn: getComputedStyle(blurb).gridColumn,
      };
    });
  }

  it('preserves disconnected multiline shell paste through the actual dialog and ordered HTTP fallback', async () => {
    const pastePage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const requests: Array<{ input: string; useMux?: boolean }> = [];
    let accepting = false;
    await pastePage.route('https://paste.example.invalid/**', async (route) => {
      if (route.request().url().includes('/api/sessions/')) {
        requests.push(route.request().postDataJSON());
        await route.fulfill({ status: accepting ? 200 : 503, contentType: 'application/json', body: '{}' });
      } else
        await route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><head><style>${styles}</style></head><body></body></html>`,
        });
    });
    try {
      await pastePage.goto('https://paste.example.invalid/', { waitUntil: 'domcontentloaded' });
      await pastePage.addScriptTag({ content: 'var MobileDetection = { isTouchDevice: () => true };' });
      for (const file of ['constants.js', 'app.js', 'keyboard-accessory.js']) {
        const bridge =
          file === 'app.js'
            ? '\nwindow.__pasteFixture = (fields) => (app = Object.assign(Object.create(CodemanApp.prototype), fields));'
            : file === 'keyboard-accessory.js'
              ? '\nwindow.__openShellPaste = () => KeyboardAccessoryBar.pasteFromClipboard();'
              : '';
        await pastePage.addScriptTag({ content: readFileSync(resolve(publicDir, file), 'utf8') + bridge });
      }
      await pastePage.evaluate(() => {
        const w = window as unknown as PasteWindow;
        w.app = w.__pasteFixture({
          activeSessionId: 'paste-session',
          sessions: new Map([['paste-session', { mode: 'shell' }]]),
          terminal: { focus() {} },
          _seqCounters: new Map(),
          _pendingDeliveries: new Map(),
          _postDraining: new Set(),
          _persistReliableTimer: null,
          _reliableMaxBytes: 256 * 1024,
          _updateConnectionIndicator() {},
          pendingHooks: new Map(),
          _ws: null,
          _wsSessionId: null,
          showToast() {},
        });
        w.app._persistReliableState = () => w.app._persistReliableNow();
        w.app._loadReliableState();
        w.__openShellPaste();
      });
      const text = '  first line\n🙂 last line  \t';
      await pastePage.locator('.paste-textarea').fill(text);
      await pastePage.getByRole('button', { name: 'Send', exact: true }).click();
      await expect
        .poll(() =>
          pastePage.evaluate(() => {
            const app = (window as unknown as PasteWindow).app;
            return app._pendingDeliveries.get('paste-session')?.length === 2 && app._postDraining.size === 0;
          })
        )
        .toBe(true);
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((body) => body.input === text && body.useMux === undefined)).toBe(true);
      expect(
        await pastePage.evaluate(() => {
          const app = (window as unknown as PasteWindow).app;
          return app._pendingDeliveries
            .get('paste-session')!
            .map((record) => ({ data: record.data, useMux: record.useMux }));
        })
      ).toEqual([
        { data: text, useMux: false },
        { data: '\r', useMux: true },
      ]);
      const before = requests.length;
      accepting = true;
      await pastePage.evaluate(() => (window as unknown as PasteWindow).app._drainSession('paste-session'));
      await expect
        .poll(() => pastePage.evaluate(() => (window as unknown as PasteWindow).app._pendingDeliveries.size))
        .toBe(0);
      expect(requests.slice(before).map(({ input, useMux }) => ({ input, useMux }))).toEqual([
        { input: text, useMux: undefined },
        { input: '\r', useMux: true },
      ]);
    } finally {
      await pastePage.close();
    }
  });

  it('uses one fitting column at the tablet-width desktop viewport', async () => {
    await renderAt(974);
    expect(await metrics()).toMatchObject({ docFits: true, panelFits: true, tracks: [expect.any(String)] });
  });

  it('uses two fitting columns with a full-width introduction on wide screens', async () => {
    await renderAt(1440);
    const layout = await metrics();
    expect(layout.modalWidth).toBeGreaterThan(1000);
    expect(layout.tracks).toHaveLength(2);
    expect(layout.headerGridColumn).toBe('1 / -1');
    expect(layout.blurbGridColumn).toBe('1 / -1');
    expect(layout.docFits).toBe(true);
    expect(layout.panelFits).toBe(true);
  });
});
