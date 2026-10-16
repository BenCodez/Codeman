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
        let managerReady = false;
        const calls: unknown[] = [];
        const app = new (window as any).CodemanApp();
        app.sessions = new Map([[sid, { mode: 'codex', supervisorAvailable: true, codexConfig: {} }]]);
        app.supportsSessionRecovery = () => true;
        app.showToast = () => undefined;
        app._apiJson = async (url: string, options?: any) => {
          calls.push({ url, options });
          if (url.endsWith('/prepare-manager')) {
            managerReady = options?.body?.confirmRestrictedManager === true;
            return { managerReady };
          }
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
          if (url.endsWith('/start')) {
            if (!managerReady) return null;
            current = { ...current, phase: 'active', reason: 'owner-started' };
          }
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
    it(`hides manager controls for SSH and Docker workers at ${width}px`, async () => {
      const page = await render(width);
      try {
        const results = await page.evaluate(
          ({ sid }) => {
            const app = (window as any).app;
            const calls = (window as any).supervisorCalls;
            return [
              { mode: 'codex', remote: { owned: true } },
              { mode: 'codex', remote: { owned: false } },
              { mode: 'codex', docker: { containerId: 'fixture' } },
              { mode: 'codex', supervisorAvailable: true },
            ].map((session) => {
              app.sessions.set(sid, session);
              const before = calls.length;
              const supported = app.openSupervisorOptions(sid);
              return {
                supported,
                display: (document.querySelector('#sessionOptionsModal [data-tab="supervisor"]') as HTMLElement).style
                  .display,
                calls: calls.length - before,
              };
            });
          },
          { sid: SID }
        );
        expect(results.slice(0, 3)).toEqual(
          Array.from({ length: 3 }, () => ({ supported: false, display: 'none', calls: 0 }))
        );
        expect(results[3]).toMatchObject({ supported: true, display: '' });
        expect(results[3].calls).toBeGreaterThan(0);
      } finally {
        await page.close();
      }
    });

    it(`gates new roles on isolation and preserves returned roles at ${width}px`, async () => {
      const page = await render(width);
      try {
        const result = await page.evaluate(
          async ({ sid }) => {
            const w = window as any;
            const app = w.app;
            const returned = structuredClone(app.sessions.get(sid).supervisor);
            const negative = [
              { mode: 'codex', supervisorAvailable: false, codexConfig: { noDaemon: false } },
              { mode: 'codex', supervisorAvailable: false, taskSupported: true, codexConfig: { noDaemon: true } },
              { mode: 'codex' },
              { mode: 'codex', supervisor: { ...returned, supervisorSessionId: 'different-session' } },
            ].map((session) => {
              app.sessions.set(sid, session);
              const before = w.supervisorCalls.length;
              const supported = app.openSupervisorOptions(sid);
              return {
                supported,
                calls: w.supervisorCalls.length - before,
                display: (document.querySelector('#sessionOptionsModal [data-tab="supervisor"]') as HTMLElement).style
                  .display,
              };
            });
            app.sessions.set(sid, { mode: 'codex', supervisorAvailable: false, supervisor: returned });
            const supported = app.openSupervisorOptions(sid);
            await app.loadSupervisorStatus();
            app.closeSupervisorOptions();
            return { negative, supported, reopened: app.openSupervisorOptions(sid) };
          },
          { sid: SID }
        );
        expect(result.negative).toEqual(
          Array.from({ length: 4 }, () => ({ supported: false, calls: 0, display: 'none' }))
        );
        expect(result.supported).toBe(true);
        expect(result.reopened).toBe(true);
      } finally {
        await page.close();
      }
    });

    it.each([
      {
        label: 'fresh recovery dead pane',
        inspection: { health: 'dead-pane', recoveryStale: false, stale: true },
        allowed: true,
      },
      { label: 'fresh legacy dead pane', inspection: { health: 'dead-pane', stale: false }, allowed: true },
      {
        label: 'fresh interrupted recovery',
        inspection: { health: 'interrupted', recoveryStale: false, stale: false },
        allowed: false,
      },
      { label: 'fresh legacy interruption', inspection: { health: 'interrupted', stale: false }, allowed: false },
      {
        label: 'stale dead pane',
        inspection: { health: 'dead-pane', recoveryStale: true, stale: false },
        allowed: false,
      },
      { label: 'absent inspection', inspection: undefined, allowed: false },
      { label: 'malformed health', inspection: { health: ['dead-pane'], stale: false }, allowed: false },
    ])(`offers crash retry only for $label at ${width}px`, async ({ inspection, allowed }) => {
      const page = await render(width);
      try {
        await page.evaluate(
          ({ sid, wid, inspection }) => {
            const app = (window as any).app;
            const active = {
              version: 1,
              supervisorSessionId: sid,
              objective: 'Coordinate fixture work',
              enabled: true,
              phase: 'active',
              reason: 'owner-started',
              workers: [
                {
                  sessionId: wid,
                  task: 'Finish the fixture',
                  criteria: [{ id: 'review', description: 'Owner review', kind: 'manual' }],
                  assignments: 0,
                  maxAssignments: 2,
                  maxRuntimeMs: 60000,
                },
              ],
              handledRequestIds: [],
              handledRequestBindings: [],
              history: [],
            };
            const rows = inspection ? [{ sessionId: wid, ...inspection }] : [];
            const posts: unknown[] = [];
            (window as any).crashRetryPosts = posts;
            app._apiJson = async (url: string, options?: any) => {
              if (options?.method !== 'POST') return rows;
              posts.push({ url, options });
              return {
                ...active,
                handledRequestIds: [options.body.requestId],
                handledRequestBindings: [{ requestId: options.body.requestId, workerId: wid, action: 'retry' }],
              };
            };
            app._supervisorView = {
              sessionId: sid,
              state: active,
              workerStatus: rows,
              busy: false,
              workersBusy: false,
            };
            app.switchOptionsTab('supervisor');
            app._renderSupervisorStatus();
          },
          { sid: SID, wid: WID, inspection }
        );
        const retry = page.getByRole('button', { name: 'Retry crash', exact: true });
        expect(await retry.isVisible()).toBe(true);
        expect(await retry.isDisabled()).toBe(!allowed);
        if (allowed) {
          await retry.click();
          await page.waitForFunction(() => !(window as any).app._supervisorView.workersBusy);
          const posts = await page.evaluate(() => (window as any).crashRetryPosts);
          expect(posts).toHaveLength(1);
          expect(posts[0]).toMatchObject({
            url: `/api/sessions/${SID}/supervisor/workers/${WID}/retry`,
            options: { method: 'POST', headers: { 'X-Codeman-Supervisor-Session': SID } },
          });
          expect(await page.evaluate(() => sessionStorage.getItem('codeman:supervisorWorkerRequests:v1'))).toBe('[]');
        } else {
          // Actual DOM activation respects the disabled control and creates no request identity.
          await retry.evaluate((button: HTMLButtonElement) => button.click());
          expect(await page.evaluate(() => (window as any).crashRetryPosts)).toEqual([]);
          expect(await page.evaluate(() => sessionStorage.getItem('codeman:supervisorWorkerRequests:v1'))).toBeNull();
        }
      } finally {
        await page.close();
      }
    });

    for (const responseFailure of ['lost', 'malformed-json'] as const) {
      it.each(['assign', 'retry'] as const)(
        `reconciles accepted %s after ${responseFailure} and HTTP-origin reload at ${width}px`,
        async (action) => {
          const page = await render(width);
          const bindings = new Map<string, { workerId: string; action: string }>();
          const requests: string[] = [];
          let loseResponse = true;
          let health = action === 'retry' ? 'dead-pane' : 'idle';
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
                assignments: [...bindings.values()].filter((binding) => binding.action === 'assign').length,
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
                expect(path).toBe(`/api/sessions/${SID}/supervisor/workers/${WID}/${action}`);
                expect(request.headers()['x-codeman-supervisor-session']).toBe(SID);
                const { requestId } = request.postDataJSON();
                requests.push(requestId);
                // A fake server records the accepted operation before losing its ACK.
                // Repeating the exact tuple/ID has no additional effect.
                const existing = bindings.get(requestId);
                if (existing) expect(existing).toEqual({ workerId: WID, action });
                else bindings.set(requestId, { workerId: WID, action });
                health = 'working';
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
                ? [{ sessionId: WID, health, stale: false, observedAt: Date.now(), task: { phase: 'watching' } }]
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
            await page
              .getByRole('button', { name: action === 'assign' ? 'Assign task' : 'Retry crash', exact: true })
              .click();
            await page.waitForFunction(() => !(window as any).app._supervisorView.workersBusy);
            expect(requests).toHaveLength(1);
            expect(bindings.size).toBe(1);
            const stored = await page.evaluate((storageKey) => sessionStorage.getItem(storageKey), key);
            expect(JSON.parse(stored!)).toEqual([{ sessionId: SID, workerId: WID, action, requestId: requests[0] }]);
            // The first retry recovered; a later fresh inspection now reports a second crash.
            health = action === 'retry' ? 'dead-pane' : 'idle';
            await page.reload({ waitUntil: 'domcontentloaded' });
            expect(await page.evaluate((storageKey) => sessionStorage.getItem(storageKey), key)).toBe(stored);
            await mount(page);
            await useActualHelpers();
            expect(await page.evaluate((storageKey) => sessionStorage.getItem(storageKey), key)).toBe('[]');
            expect(requests).toHaveLength(1);
            await page
              .getByRole('button', { name: action === 'assign' ? 'Assign task' : 'Retry crash', exact: true })
              .click();
            await page.waitForFunction(() => !(window as any).app._supervisorView.workersBusy);
            expect(requests).toHaveLength(2);
            expect(requests[1]).not.toBe(requests[0]);
            expect(bindings.size).toBe(2);
            expect(await page.evaluate((storageKey) => sessionStorage.getItem(storageKey), key)).toBe('[]');
          } finally {
            await page.close();
          }
        }
      );
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
        page.once('dialog', (dialog) => void dialog.dismiss());
        await page.getByRole('button', { name: 'Prepare restricted manager' }).click();
        expect(
          await page.evaluate(() =>
            (window as any).supervisorCalls.filter((call: any) => call.url.endsWith('/prepare-manager'))
          )
        ).toEqual([]);
        page.once('dialog', (dialog) => void dialog.accept());
        await page.getByRole('button', { name: 'Prepare restricted manager' }).click();
        await page.waitForFunction(() => !(window as any).app._supervisorView.busy);
        expect(await page.locator('#supervisorPhase').textContent()).toBe('Ready');
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
              url: `/api/sessions/${SID}/supervisor/prepare-manager`,
              options: { method: 'POST', body: { confirmRestrictedManager: true } },
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
