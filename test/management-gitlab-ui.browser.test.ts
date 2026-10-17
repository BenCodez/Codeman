/** Synthetic owner connection controls; no live GitLab or agent effects. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';

const root = resolve(import.meta.dirname, '../src/web/public');
const read = (name: string) => readFileSync(resolve(root, name), 'utf8');
const html = read('index.html');
const start = html.indexOf('<div class="modal" id="appSettingsModal">');
const end = html.indexOf('<!-- Shortcut Overlay Modal -->', start);

describe('Management GitLab connection in Chromium', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
      args: ['--no-sandbox'],
    });
  });
  afterAll(async () => browser?.close());
  it.each([390, 1280])('saves owner grants and performs only a read-only credential check at %ipx', async (width) => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
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
      await page.goto('https://codeman-gitlab.example.test', { waitUntil: 'domcontentloaded' });
      await page.addScriptTag({
        content:
          'class CodemanApp { async loadManagementSettings() { this._managementView = {snapshot:{}}; } closeManagementSettings() { this._managementView = null; } }; window.CodemanApp = CodemanApp;',
      });
      await page.addScriptTag({ content: read('management-gitlab-ui.js') });
      await page.evaluate(async () => {
        const app = new (window as any).CodemanApp();
        let config = {
          revision: 'a'.repeat(64),
          url: '',
          projectIds: [],
          allowWrite: false,
          allowAllProjects: false,
          writeBranchPrefix: 'codeman/',
          credentialConfigured: false,
        };
        const calls: any[] = [];
        app.showToast = () => undefined;
        app._apiJson = async (url: string, options?: any) => {
          calls.push({
            url,
            method: options?.method,
            ...(options?.method === 'PUT'
              ? {
                  all: options.body.allowAllProjects,
                  write: options.body.allowWrite,
                  insecure: options.body.allowInsecureHttp,
                }
              : {}),
          });
          if (url.endsWith('/check'))
            return {
              available: true,
              projectCount: 2,
              allowWrite: config.allowWrite,
              allowAllProjects: config.allowAllProjects,
              writeBranchPrefix: 'codeman/',
            };
          if (options?.method === 'PUT') {
            const { token, ifMatch: _revision, ...settings } = options.body;
            config = {
              ...config,
              ...settings,
              revision: 'b'.repeat(64),
              credentialConfigured: token ? true : config.credentialConfigured,
            };
          }
          return config;
        };
        (window as any).app = app;
        (window as any).gitlabCalls = calls;
        document.getElementById('appSettingsModal')!.classList.add('active');
        await app.loadManagementSettings();
        document.getElementById('managementGitlabPanel')!.scrollIntoView();
      });
      expect(await page.locator('#managementGitlabAllProjects').isChecked()).toBe(true);
      expect(await page.locator('#managementGitlabAllowWrite').isChecked()).toBe(true);
      expect(await page.locator('#managementGitlabStatus').textContent()).toContain('Not connected');
      await page
        .locator('#managementGitlabUrl')
        .fill(width === 390 ? 'http://gitlab.example.test' : 'https://gitlab.example.test');
      expect(await page.locator('#managementGitlabInsecureHttp').isChecked()).toBe(false);
      if (width === 390) await page.locator('#managementGitlabInsecureHttp').check();
      await page.locator('#managementGitlabToken').fill('synthetic-private-credential');
      await page.getByRole('button', { name: 'Save GitLab connection', exact: true }).click();
      await page.waitForFunction(() =>
        document.getElementById('managementGitlabStatus')?.textContent?.includes('connection saved')
      );
      expect(await page.locator('#managementGitlabToken').inputValue()).toBe('');
      await page.getByRole('button', { name: 'Check saved GitLab access (read only)', exact: true }).click();
      await page.waitForFunction(() =>
        document.getElementById('managementGitlabStatus')?.textContent?.includes('Read-only access check succeeded')
      );
      expect(await page.locator('#managementGitlabStatus').textContent()).toContain('No write was performed');
      expect(await page.evaluate(() => (window as any).gitlabCalls)).toEqual([
        { url: '/api/management/gitlab' },
        { url: '/api/management/gitlab', method: 'PUT', all: true, write: true, insecure: width === 390 },
        { url: '/api/management/gitlab/check', method: 'POST' },
      ]);
      expect(await page.locator('#managementGitlabPanel').textContent()).not.toContain('synthetic-private-credential');
      expect(
        await page.locator('#settings-management').evaluate((node) => node.scrollWidth <= node.clientWidth + 1)
      ).toBe(true);
      await page.locator('#managementGitlabToken').fill('unsaved-private-draft');
      await page.evaluate(() => (window as any).app.closeManagementSettings());
      expect(await page.locator('#managementGitlabToken').inputValue()).toBe('');
    } finally {
      await page.close();
    }
  });
});
