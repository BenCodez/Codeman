/** Actual browser controls; intercepted requests and synthetic agents only. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';

const root = resolve(import.meta.dirname, '../src/web/public');
const read = (name: string) => readFileSync(resolve(root, name), 'utf8');
const html = read('index.html');
const supervisorStart = html.indexOf('<section class="set-section hidden" id="supervisor-tab"');
const supervisorMarkup = html.slice(supervisorStart, html.indexOf('</section>', supervisorStart) + '</section>'.length);
const start = html.indexOf('<div class="modal" id="appSettingsModal">');
const end = html.indexOf('<!-- Shortcut Overlay Modal -->', start);
const worker = '22222222-2222-4222-8222-222222222222';
const manager = '11111111-1111-4111-8111-111111111111';

describe('Global management controls in Chromium', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
      args: ['--no-sandbox'],
    });
  });
  afterAll(async () => browser?.close());
  it.each([390, 1280])('saves global memory and queues cooperative SSH messages at %ipx', async (width) => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      await page.route('**/*', async (route) => {
        if (route.request().isNavigationRequest())
          await route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: `<!doctype html><html><head><style>${read('styles.css')}</style><style>${read('mobile.css')}</style></head><body>${html.slice(start, end)}<div id="sessionOptionsModal"><div id="sessionOptionsDoc">${supervisorMarkup}</div></div></body></html>`,
          });
        else await route.fulfill({ status: 204, body: '' });
      });
      await page.goto('http://codeman-management.test', { waitUntil: 'domcontentloaded' });
      await page.addScriptTag({ content: 'class CodemanApp {}; window.CodemanApp = CodemanApp;' });
      await page.addScriptTag({ content: read('supervisor-ui.js') });
      await page.addScriptTag({ content: read('supervisor-automation-ui.js') });
      await page.addScriptTag({ content: read('supervisor-brain-ui.js') });
      await page.addScriptTag({ content: read('management-ui.js') });
      await page.evaluate(
        async ({ worker, manager }) => {
          const calls: any[] = [];
          const app = new (window as any).CodemanApp();
          app.showToast = () => undefined;
          app.sessions = new Map([[manager, { mode: 'codex', supervisorAvailable: true }]]);
          app.supportsSessionRecovery = () => true;
          app._apiJson = async (url: string, options?: any) => {
            calls.push({ url, options });
            if (url.endsWith('/supervisor/automation'))
              return options?.method === 'PUT'
                ? options.body
                : { checkIns: { enabled: false, intervalMinutes: 60 }, tasks: [] };
            if (url.endsWith('/supervisor'))
              return {
                version: 1,
                supervisorSessionId: manager,
                objective: 'Manage SSH agents',
                enabled: false,
                phase: 'disabled',
                reason: 'disabled',
                workers: [],
                handledRequestIds: [],
                handledRequestBindings: [],
                history: [],
              };
            if (url.endsWith('/brain'))
              return { markdown: options.body.markdown, revision: 'c'.repeat(64), exists: true, noteCount: 0 };
            if (url.endsWith('/messages'))
              return options?.method === 'POST'
                ? { message: { ...options.body, direction: 'owner' }, duplicate: false }
                : { messages: [{ direction: 'agent', message: 'I maintain remote builds.' }] };
            return {
              revision: 'a'.repeat(64),
              managerSessionId: manager,
              brain: { markdown: '', revision: 'b'.repeat(64), exists: false, noteCount: 0 },
              agents: [
                {
                  sessionId: manager,
                  name: 'Local manager',
                  mode: 'codex',
                  remote: false,
                  status: 'idle',
                  role: '',
                  notes: '',
                  allowMessages: false,
                  enrolled: false,
                  pendingMessages: 0,
                  managerAvailable: true,
                },
                {
                  sessionId: worker,
                  name: 'SSH Codex',
                  mode: 'shell',
                  remote: true,
                  status: 'idle',
                  role: 'Builds',
                  notes: 'Existing shell agent',
                  allowMessages: true,
                  enrolled: true,
                  pendingMessages: 0,
                  managerAvailable: false,
                },
              ],
            };
          };
          (window as any).app = app;
          (window as any).managementCalls = calls;
          document.getElementById('appSettingsModal')!.classList.add('active');
          await app.loadManagementSettings();
          document.getElementById('settings-management')!.scrollIntoView();
        },
        { worker, manager }
      );
      expect(await page.locator('#managementManagerControls #supervisor-tab').count()).toBe(1);
      await page.getByRole('button', { name: 'Manager schedules and custom tasks', exact: true }).click();
      await page.waitForFunction(
        () => !(document.getElementById('supervisorAutomationSettings') as HTMLFieldSetElement)?.disabled
      );
      expect(await page.locator('#supervisorCheckInMinutes').inputValue()).toBe('60');
      await page.locator('#supervisorCheckInMinutes').fill('90');
      await page.locator('#supervisorCheckInsEnabled').check();
      await page.getByRole('button', { name: 'Save schedules', exact: true }).click();
      expect(
        await page.evaluate(() =>
          (window as any).managementCalls.some(
            (call: any) =>
              call.url.endsWith('/supervisor/automation') &&
              call.options?.method === 'PUT' &&
              call.options.body.checkIns.intervalMinutes === 90 &&
              call.options.body.checkIns.enabled
          )
        )
      ).toBe(true);
      const memory = page.locator('#managementBrainMarkdown');
      await memory.fill('The manager maintains a shared agent directory.');
      await page.getByRole('button', { name: 'Save shared brain.md', exact: true }).click();
      expect(await page.locator('#managementBrainStatus').textContent()).toContain('saved');
      await page.getByRole('button', { name: 'Open agent inbox and replies', exact: true }).click();
      expect(await page.locator('#managementMessageThread').textContent()).toContain('remote builds');
      await page.locator('#managementMessageDraft').fill('Please report build usage.');
      await page.getByRole('button', { name: 'Queue message', exact: true }).click();
      await page.waitForFunction(() =>
        document.getElementById('managementAgentToolsStatus')?.textContent?.includes('must check its inbox')
      );
      expect(await page.locator('#managementAgentToolsStatus').textContent()).toContain('must check its inbox');
      expect(await page.locator('#managementMessageDraft').inputValue()).toBe('');
      expect(
        await page.evaluate(() => (window as any).managementCalls.every((call: any) => !call.url.includes('/input')))
      ).toBe(true);
      expect(
        await page.locator('#settings-management').evaluate((node) => node.scrollWidth <= node.clientWidth + 1)
      ).toBe(true);
    } finally {
      await page.close();
    }
  });
  it('offers an empty manager picker a safe explicit local-session setup flow', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    try {
      await page.route('**/*', async (route) => {
        if (route.request().isNavigationRequest())
          await route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: `<!doctype html><html><head><style>${read('styles.css')}</style><style>${read('mobile.css')}</style></head><body>${html.slice(start, end)}</body></html>`,
          });
        else await route.fulfill({ status: 204, body: '' });
      });
      await page.goto('http://codeman-management.test', { waitUntil: 'domcontentloaded' });
      await page.addScriptTag({ content: 'class CodemanApp {}; window.CodemanApp = CodemanApp;' });
      await page.addScriptTag({ content: read('supervisor-brain-ui.js') });
      await page.addScriptTag({ content: read('management-ui.js') });
      await page.evaluate(
        async ({ worker, manager }) => {
          const calls: any[] = [];
          const app = new (window as any).CodemanApp();
          app.showToast = () => undefined;
          app._ensureCreatedSessionVisible = async (id: string) => calls.push({ upsert: id });
          app.selectSession = async (id: string) => calls.push({ opened: id });
          app.closeAppSettings = () => document.getElementById('appSettingsModal')!.classList.remove('active');
          app._apiJson = async (url: string, options?: any) => {
            calls.push({ url, options });
            if (url === '/api/sessions')
              return { session: { id: manager, mode: 'codex', name: 'Management Codex', pid: null } };
            return {
              revision: 'a'.repeat(64),
              managerSessionId: null,
              brain: { markdown: '', revision: 'b'.repeat(64), exists: false, noteCount: 0 },
              agents: [
                {
                  sessionId: worker,
                  name: 'Existing SSH shell',
                  mode: 'shell',
                  remote: true,
                  status: 'idle',
                  role: '',
                  notes: '',
                  allowMessages: false,
                  enrolled: false,
                  pendingMessages: 0,
                  managerAvailable: false,
                },
              ],
            };
          };
          (window as any).app = app;
          (window as any).managementCalls = calls;
          document.getElementById('appSettingsModal')!.classList.add('active');
          await app.loadManagementSettings();
          document.getElementById('settings-management')!.scrollIntoView();
        },
        { worker, manager }
      );
      expect(await page.locator('#managementManager option').count()).toBe(1);
      expect(await page.locator('#managementCreateStatus').textContent()).toContain('existing directory');
      await page.locator('#managementCreateWorkingDir').fill('/tmp/owner-project');
      await page.locator('#managementCreateCodexHome').fill('/synthetic/subscription-manager');
      await page.getByRole('button', { name: 'Create local management Codex', exact: true }).click();
      await page.waitForFunction(() => !document.getElementById('managementOpenCreatedSession')!.hidden);
      expect(
        await page.evaluate(() =>
          (window as any).managementCalls
            .filter((call: any) => call.url === '/api/sessions')
            .map((call: any) => call.options.body)
        )
      ).toEqual([
        {
          name: 'Management Codex',
          workingDir: '/tmp/owner-project',
          mode: 'codex',
          envOverrides: { CODEX_HOME: '/synthetic/subscription-manager' },
          codexConfig: { noDaemon: true, noAltScreen: true, dangerouslyBypassApprovals: false },
        },
      ]);
      expect(await page.evaluate(() => (window as any).managementCalls.some((call: any) => call.opened))).toBe(false);
      expect(await page.locator('#managementCreateStatus').textContent()).toContain('one normal turn');
      await page.getByRole('button', { name: 'Open new manager session', exact: true }).click();
      expect(
        await page.evaluate(() =>
          (window as any).managementCalls.filter((call: any) => call.opened).map((call: any) => call.opened)
        )
      ).toEqual([manager]);
      expect(
        await page.evaluate(() =>
          (window as any).managementCalls.some(
            (call: any) => call.url?.includes('/supervisor/start') || call.url?.includes('/prepare-manager')
          )
        )
      ).toBe(false);
    } finally {
      await page.close();
    }
  });
});
