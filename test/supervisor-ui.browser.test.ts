/** Real Chromium coverage on an intercepted HTTP origin; no live manager or worker effects. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const html = readFileSync(resolve(publicDir, 'index.html'), 'utf8');
const styles = readFileSync(resolve(publicDir, 'styles.css'), 'utf8');
const mobileStyles = readFileSync(resolve(publicDir, 'mobile.css'), 'utf8');
const controller = readFileSync(resolve(publicDir, 'supervisor-ui.js'), 'utf8');
const apiHelpers = readFileSync(resolve(publicDir, 'api-client.js'), 'utf8');
const fixtureOrigin = 'http://codeman-supervisor.test';
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
    // A real HTTP origin gives sessionStorage its normal production semantics.
    // Every request is intercepted: this fixture has no network/server dependency.
    await page.route('**/*', async (route) => {
      if (route.request().isNavigationRequest()) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<!doctype html><html><head><style>${styles}</style><style>@media (max-width: 1023px) { ${mobileStyles} }</style></head><body>${modalMarkup()}</body></html>`,
        });
      } else await route.fulfill({ status: 204, body: '' });
    });
    await page.goto(fixtureOrigin, { waitUntil: 'domcontentloaded' });
    await mount(page);
    return page;
  }

  async function mount(page: Page): Promise<void> {
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
          if (url.endsWith('/assign')) {
            const requestId = options.body.requestId;
            const workerId = decodeURIComponent(url.split('/').at(-2)!);
            current = {
              ...current,
              workers: current.workers.map((worker: any) =>
                worker.sessionId === workerId
                  ? { ...worker, assignments: worker.assignments + 1, lastRequestId: requestId }
                  : worker
              ),
              handledRequestIds: [...current.handledRequestIds, requestId],
              handledRequestBindings: [...current.handledRequestBindings, { requestId, workerId, action: 'assign' }],
            };
            return current;
          }
          if (options?.method === 'PUT')
            current = {
              ...current,
              ...options.body,
              workers: options.body.workers.map((worker: any) => ({ ...worker, assignments: 0 })),
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
  }

  for (const width of [1440, 390]) {
    for (const responseFailure of ['lost', 'malformed-json'] as const) {
      it(`reuses an accepted request after ${responseFailure} and HTTP-origin reload at ${width}px`, async () => {
        const page = await render(width);
        const bindings = new Map<string, { workerId: string; action: string }>();
        const requests: string[] = [];
        let loseResponse = true;
        const key = 'codeman:supervisorWorkerRequests:v1';
        const state = () => ({
          version: 1,
          supervisorSessionId: SID,
          objective: 'Coordinate fixture work',
          enabled: true,
          phase: 'active',
          reason: 'owner-started',
          startedAt: Date.now(),
          workers: [
            {
              sessionId: WID,
              task: 'Review fixture',
              criteria: [{ id: 'review', description: 'Owner reviews', kind: 'manual' }],
              maxAssignments: 2,
              maxRuntimeMs: 60000,
              assignments: bindings.size,
            },
          ],
          handledRequestIds: [...bindings.keys()],
          handledRequestBindings: [...bindings].map(([requestId, binding]) => ({ requestId, ...binding })),
          history: [],
        });
        try {
          await page.route(`${fixtureOrigin}/api/**`, async (route) => {
            const request = route.request();
            const path = new URL(request.url()).pathname;
            if (request.method() === 'POST') {
              expect(path).toBe(`/api/sessions/${SID}/supervisor/workers/${WID}/assign`);
              expect(request.headers()['x-codeman-supervisor-session']).toBe(SID);
              const { requestId } = request.postDataJSON();
              requests.push(requestId);
              // A fake server records the accepted operation before losing its ACK.
              // Repeating the exact tuple/ID has no additional effect.
              const existing = bindings.get(requestId);
              if (existing) expect(existing).toEqual({ workerId: WID, action: 'assign' });
              else bindings.set(requestId, { workerId: WID, action: 'assign' });
              if (loseResponse) {
                loseResponse = false;
                if (responseFailure === 'lost') await route.abort('failed');
                else
                  await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: '{incomplete-fixture-json',
                  });
                return;
              }
            }
            const data = path.endsWith('/workers')
              ? [{ sessionId: WID, health: 'idle', stale: false, observedAt: Date.now(), task: { phase: 'watching' } }]
              : state();
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({ success: true, data }),
            });
          });
          const useActualHelpers = async () => {
            await page.addScriptTag({ content: apiHelpers });
            await page.evaluate(async () => {
              const app = (window as any).app;
              delete app._apiJson;
              await app.loadSupervisorStatus();
              app.switchOptionsTab('supervisor');
            });
          };
          await useActualHelpers();
          await page.getByRole('button', { name: 'Assign task' }).click();
          await page.waitForFunction(() => !(window as any).app._supervisorView.workersBusy);
          expect(requests).toHaveLength(1);
          expect(bindings.size).toBe(1);
          const stored = await page.evaluate((storageKey) => sessionStorage.getItem(storageKey), key);
          expect(JSON.parse(stored!)).toEqual([
            { sessionId: SID, workerId: WID, action: 'assign', requestId: requests[0] },
          ]);
          await page.reload({ waitUntil: 'domcontentloaded' });
          expect(await page.evaluate((storageKey) => sessionStorage.getItem(storageKey), key)).toBe(stored);
          await mount(page);
          await useActualHelpers();
          await page.getByRole('button', { name: 'Assign task' }).click();
          await page.waitForFunction(() => !(window as any).app._supervisorView.workersBusy);
          expect(requests).toHaveLength(2);
          expect(requests[1]).toBe(requests[0]);
          expect(bindings.size).toBe(1);
          expect(await page.evaluate((storageKey) => sessionStorage.getItem(storageKey), key)).toBe('[]');
          // An explicit new owner action after acknowledged acceptance gets a new identity.
          await page.getByRole('button', { name: 'Assign task' }).click();
          await page.waitForFunction(() => !(window as any).app._supervisorView.workersBusy);
          expect(requests).toHaveLength(3);
          expect(requests[2]).not.toBe(requests[0]);
          expect(bindings.size).toBe(2);
        } finally {
          await page.close();
        }
      });
    }
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
        await page.waitForFunction(() => !(window as any).app._supervisorView.workersBusy);
        expect(await page.evaluate(() => sessionStorage.getItem('codeman:supervisorWorkerRequests:v1'))).toBe('[]');
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
