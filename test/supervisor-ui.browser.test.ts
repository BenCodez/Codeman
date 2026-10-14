/** Real Chromium smoke coverage for configuring and starting a Codex supervisor. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const html = readFileSync(resolve(publicDir, 'index.html'), 'utf8');
const styles = readFileSync(resolve(publicDir, 'styles.css'), 'utf8');
const mobileStyles = readFileSync(resolve(publicDir, 'mobile.css'), 'utf8');
const controller = readFileSync(resolve(publicDir, 'supervisor-ui.js'), 'utf8');
const SID = '11111111-1111-4111-8111-111111111111';
const WID = '22222222-2222-4222-8222-222222222222';

function modalMarkup() {
  const start = html.indexOf('<div class="modal" id="sessionOptionsModal">');
  const end = html.indexOf('<!-- Close Session Confirmation Modal -->', start);
  if (start < 0 || end < 0) throw new Error('Session Options markup not found');
  return html.slice(start, end);
}

describe('Codex supervisor UI in Chromium', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
      args: ['--no-sandbox'],
    });
  });
  afterAll(async () => browser?.close());

  async function render(width: number): Promise<Page> {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.setContent(
      `<!doctype html><html><head><style>${styles}</style><style>@media (max-width: 1023px) { ${mobileStyles} }</style></head><body>${modalMarkup()}</body></html>`
    );
    await page.addScriptTag({ content: 'class CodemanApp {}; window.CodemanApp = CodemanApp;' });
    await page.addScriptTag({ content: controller });
    await page.evaluate(
      ({ sid }) => {
        let current = {
          version: 1,
          supervisorSessionId: sid,
          objective: '',
          enabled: false,
          phase: 'disabled',
          reason: 'disabled',
          workers: [],
          handledRequestIds: [],
          handledRequestBindings: [],
          history: [],
        };
        const calls: unknown[] = [];
        const app = new (window as any).CodemanApp();
        app.sessions = new Map([[sid, { mode: 'codex', codexConfig: {} }]]);
        app.supportsSessionRecovery = () => true;
        app.showToast = () => undefined;
        app._apiJson = async (url: string, options?: any) => {
          calls.push({ url, options });
          if (url.endsWith('/workers'))
            return current.workers.map((worker: any) => ({
              sessionId: worker.sessionId,
              health: 'idle',
              stale: false,
              observedAt: Date.now(),
              task: { phase: 'watching' },
            }));
          if (url.endsWith('/assign')) return current;
          if (options?.method === 'PUT')
            current = {
              ...current,
              ...options.body,
              phase: options.body.enabled ? 'ready' : 'disabled',
              reason: 'configured',
            };
          if (url.endsWith('/start')) current = { ...current, phase: 'active', reason: 'owner-started' };
          return current;
        };
        app.switchOptionsTab = (tab: string) => {
          document
            .querySelectorAll('#sessionOptionsModal .set-section')
            .forEach((section) => section.classList.toggle('hidden', section.id !== `${tab}-tab`));
        };
        (window as any).app = app;
        (window as any).supervisorCalls = calls;
        document.getElementById('sessionOptionsModal')?.classList.add('active');
        app.openSupervisorOptions(sid);
      },
      { sid: SID }
    );
    await page.waitForFunction(() => !(window as any).app._supervisorView.busy);
    return page;
  }

  for (const width of [1440, 390]) {
    it(`configures explicit workers and starts the manager at ${width}px`, async () => {
      const page = await render(width);
      try {
        await page.locator('[data-tab="supervisor"]').click();
        await expect(page.locator('#supervisor-tab').isVisible()).resolves.toBe(true);
        await page.locator('#supervisorObjective').fill('Coordinate release');
        await page.locator('#supervisorEnabled').check();
        await page.locator('#supervisorWorkers').fill(
          JSON.stringify([
            {
              sessionId: WID,
              task: 'Fix parser',
              criteria: [{ id: 'tests', description: 'Tests pass', kind: 'command', command: 'npm test' }],
              maxAssignments: 2,
              maxRuntimeMs: 60000,
            },
          ])
        );
        await page.getByRole('button', { name: 'Save supervisor configuration' }).click();
        await page.getByRole('button', { name: 'Start manager' }).click();
        await page.getByRole('button', { name: 'Assign task' }).click();
        const calls = await page.evaluate(() => (window as any).supervisorCalls);
        expect(calls).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              url: `/api/sessions/${SID}/supervisor`,
              options: expect.objectContaining({ method: 'PUT' }),
            }),
            expect.objectContaining({
              url: `/api/sessions/${SID}/supervisor/start`,
              options: expect.objectContaining({ method: 'POST' }),
            }),
            expect.objectContaining({
              url: `/api/sessions/${SID}/supervisor/workers/${WID}/assign`,
              options: expect.objectContaining({
                method: 'POST',
                headers: { 'X-Codeman-Supervisor-Session': SID },
              }),
            }),
          ])
        );
        expect(await page.locator('#supervisor-tab').evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(
          true
        );
      } finally {
        await page.close();
      }
    });
  }
});
