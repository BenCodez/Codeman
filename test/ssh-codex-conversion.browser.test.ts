/** Real browser clicks with intercepted synthetic API; never live SSH or Codex. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
const publicDir = resolve(import.meta.dirname, '../src/web/public');
const html = readFileSync(resolve(publicDir, 'index.html'), 'utf8');
const start = html.indexOf('<div class="set-group" id="sshCodexConversionSection"');
const end = html.indexOf('<div class="set-group-head"><h4>Identity</h4>', start);
const markup = html.slice(start, html.lastIndexOf('<div class="set-group">', end));
const controller = readFileSync(resolve(publicDir, 'session-ui.js'), 'utf8');
const styles = readFileSync(resolve(publicDir, 'styles.css'), 'utf8');
const SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  CID = '11111111-2222-4333-8444-555555555555';
describe('in-place SSH Codex conversion controls', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  });
  afterAll(async () => {
    await browser?.close();
  });
  it('shows immediate progress and a visible refusal without confirming conversion', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let confirmations = 0;
    try {
      await page.route('**/*', async (route) => {
        if (route.request().isNavigationRequest())
          return route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: `<!doctype html><html><head><meta charset="UTF-8"><style>${styles}</style></head><body>${markup}</body></html>`,
          });
        if (route.request().url().endsWith('/preview')) {
          await gate;
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ success: false, error: 'Return to an idle shell before conversion.' }),
          });
        }
        if (route.request().url().endsWith('/confirm')) confirmations++;
        return route.fulfill({ status: 204, body: '' });
      });
      await page.goto('http://codeman-conversion.test', { waitUntil: 'domcontentloaded' });
      await page.addScriptTag({ content: 'class CodemanApp {}; window.CodemanApp=CodemanApp;' });
      await page.addScriptTag({ content: controller });
      await page.evaluate((id) => {
        const app = new (window as any).CodemanApp();
        app.editingSessionId = id;
        (window as any).toasts = [];
        app.showToast = (message: string) => (window as any).toasts.push(message);
        (window as any).app = app;
        document.getElementById('sshCodexConversionSection')!.style.display = '';
      }, SID);
      const button = page.locator('#sshCodexConversionPreview');
      await button.click();
      expect(await button.textContent()).toBe('Checking existing chats…');
      expect(await button.isDisabled()).toBe(true);
      release();
      await page.waitForFunction(() =>
        document.getElementById('sshCodexConversionStatus')?.textContent?.includes('Return to an idle shell')
      );
      expect(await page.evaluate(() => (window as any).toasts)).toContain('Return to an idle shell before conversion.');
      expect(await button.isEnabled()).toBe(true);
      expect(await button.textContent()).toBe('Convert to Codex chat…');
      expect(confirmations).toBe(0);
    } finally {
      release();
      await page.close();
    }
  });
  for (const recoverable of [true, false])
    it(`only enables another preview after a certified refusal: ${recoverable}`, async () => {
      const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
      let previews = 0,
        confirmations = 0;
      await page.route('**/*', async (route) => {
        if (route.request().isNavigationRequest()) {
          await route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: `<!doctype html><html><head><style>${styles}</style></head><body>${markup}</body></html>`,
          });
          return;
        }
        const url = route.request().url();
        if (!url.includes('/api/')) {
          await route.fulfill({ status: 204, body: '' });
          return;
        }
        let result;
        if (url.endsWith('/preview')) {
          previews++;
          result = {
            success: true,
            data: {
              confirmationToken: 'a'.repeat(64),
              hostLabel: 'Fixture',
              workingDir: '/fixture/project',
              codexHome: '/fixture/home',
              launcher: 'codex-workspace',
              retainedSessionName: 'codeman-retained-aaaaaaaa-abcdef012345',
              conversations: [
                {
                  id: CID,
                  modifiedAt: Date.now(),
                  config: { model: 'fixture-model', sandbox: 'read-only', approvalPolicy: 'on-request' },
                },
              ],
            },
          };
        } else {
          confirmations++;
          result = {
            success: false,
            error: 'Fixture conversion refused',
            ...(recoverable ? { canPreviewAgain: true } : {}),
          };
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
      });
      await page.goto('http://codeman-conversion.test', { waitUntil: 'domcontentloaded' });
      await page.addScriptTag({ content: 'class CodemanApp {}; window.CodemanApp=CodemanApp;' });
      await page.addScriptTag({ content: controller });
      await page.evaluate(
        ({ id }) => {
          const app = new (window as any).CodemanApp();
          app.editingSessionId = id;
          app.showToast = () => {};
          (window as any).app = app;
          document.getElementById('sshCodexConversionSection')!.style.display = '';
        },
        { id: SID }
      );
      await page.locator('#sshCodexConversionPreview').click();
      await page.locator('#sshCodexConversionConsent').check();
      await page.locator('#sshCodexConversionConfirm').click();
      await page.waitForFunction(() =>
        document.getElementById('sshCodexConversionStatus')!.textContent!.includes('Fixture conversion refused')
      );
      expect(await page.locator('#sshCodexConversionPreview').isEnabled()).toBe(recoverable);
      expect(await page.locator('#sshCodexConversionConfirm').isEnabled()).toBe(false);
      if (recoverable) {
        await page.locator('#sshCodexConversionPreview').click();
        await page.waitForFunction(
          () => !(document.getElementById('sshCodexConversionPreview') as HTMLButtonElement).disabled
        );
        expect(previews).toBe(2);
      }
      expect(confirmations).toBe(1);
      await page.close();
    });
  it('keeps an unavailable newest conversation selected until the owner explicitly chooses another', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    const older = '99999999-2222-4333-8444-555555555555';
    let requests = 0;
    await page.route('**/*', async (route) => {
      if (route.request().isNavigationRequest()) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<!doctype html><html><head><style>${styles}</style></head><body>${markup}</body></html>`,
        });
        return;
      }
      if (!route.request().url().includes('/api/')) {
        await route.fulfill({ status: 204, body: '' });
        return;
      }
      requests++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            confirmationToken: 'a'.repeat(64),
            hostLabel: 'Fixture',
            workingDir: '/fixture/project',
            codexHome: '/fixture/home',
            launcher: 'codex-workspace',
            retainedSessionName: 'codeman-retained-aaaaaaaa-abcdef012345',
            notice: 'Preserve the idle shell.',
            conversations: [
              { id: CID, modifiedAt: Date.now(), unavailableReason: 'Pending child work' },
              {
                id: older,
                modifiedAt: Date.now() - 10000,
                config: { model: 'fixture-model', sandbox: 'read-only', approvalPolicy: 'on-request' },
              },
            ],
          },
        }),
      });
    });
    await page.goto('http://codeman-conversion.test', { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ content: 'class CodemanApp {}; window.CodemanApp=CodemanApp;' });
    await page.addScriptTag({ content: controller });
    await page.evaluate(
      ({ id }) => {
        const app = new (window as any).CodemanApp();
        app.editingSessionId = id;
        app.showToast = () => {};
        (window as any).app = app;
        document.getElementById('sshCodexConversionSection')!.style.display = '';
      },
      { id: SID }
    );
    await page.locator('#sshCodexConversionPreview').click();
    await page.locator('#sshCodexConversionConfirm').waitFor({ state: 'visible' });
    expect(await page.locator('#sshCodexConversionConversation').inputValue()).toBe(CID);
    await page.locator('#sshCodexConversionConsent').check();
    expect(await page.locator('#sshCodexConversionConfirm').isEnabled()).toBe(false);
    await page.locator('#sshCodexConversionConversation').selectOption(older);
    expect(await page.locator('#sshCodexConversionConsent').isChecked()).toBe(false);
    expect(await page.locator('#sshCodexConversionConfirm').isEnabled()).toBe(false);
    await page.locator('#sshCodexConversionConsent').check();
    expect(await page.locator('#sshCodexConversionConfirm').isEnabled()).toBe(true);
    expect(requests).toBe(1);
    await page.close();
  });
  for (const width of [390, 1280])
    it(`requires exact conversation and explicit preservation consent at ${width}px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } }),
        requests: Array<{ url: string; body: any }> = [];
      await page.route('**/*', async (route) => {
        if (route.request().isNavigationRequest()) {
          await route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: `<!doctype html><html><head><style>${styles}</style></head><body>${markup}</body></html>`,
          });
          return;
        }
        const url = route.request().url();
        if (!url.includes('/api/')) {
          await route.fulfill({ status: 204, body: '' });
          return;
        }
        const body = route.request().postDataJSON();
        requests.push({ url, body });
        const data = url.endsWith('/preview')
          ? {
              confirmationToken: 'a'.repeat(64),
              hostLabel: 'Fixture',
              workingDir: '/fixture/project',
              codexHome: '/fixture/home',
              launcher: 'codex-workspace',
              retainedSessionName: 'codeman-retained-aaaaaaaa-abcdef012345',
              notice: 'Preserve the idle shell.',
              conversations: [
                {
                  id: CID,
                  modifiedAt: Date.now(),
                  config: { model: 'fixture-model', sandbox: 'workspace-write', approvalPolicy: 'on-request' },
                },
              ],
            }
          : {
              sessionId: SID,
              retainedSessionName: 'codeman-retained-aaaaaaaa-abcdef012345',
              retainedShellCommand: 'tmux -L codeman-remote attach -t codeman-retained-aaaaaaaa-abcdef012345',
            };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data }),
        });
      });
      await page.goto('http://codeman-conversion.test', { waitUntil: 'domcontentloaded' });
      await page.addScriptTag({ content: 'class CodemanApp {}; window.CodemanApp=CodemanApp;' });
      await page.addScriptTag({ content: controller });
      await page.evaluate(
        ({ id }) => {
          const app = new (window as any).CodemanApp();
          app.editingSessionId = id;
          app.showToast = () => {};
          app._renderSessionTabsImmediate = () => {};
          (window as any).app = app;
          document.getElementById('sshCodexConversionSection')!.style.display = '';
        },
        { id: SID }
      );
      await page.locator('#sshCodexConversionPreview').click();
      await page.locator('#sshCodexConversionConfirm').waitFor({ state: 'visible' });
      expect(requests).toHaveLength(1);
      expect(await page.locator('#sshCodexConversionConfirm').isEnabled()).toBe(false);
      expect(await page.locator('#sshCodexConversionConversation').inputValue()).toBe(CID);
      expect(await page.locator('#sshCodexConversionDetails').innerText()).toContain('codex-workspace');
      await page.locator('#sshCodexConversionConsent').check();
      await page.locator('#sshCodexConversionConfirm').click();
      await page.waitForFunction(() =>
        document.getElementById('sshCodexConversionStatus')!.textContent!.startsWith('Converted.')
      );
      expect(requests).toHaveLength(2);
      expect(requests[1].body).toEqual({
        confirmationToken: 'a'.repeat(64),
        conversationId: CID,
        confirmPreserveShell: true,
      });
      expect(await page.locator('#sshCodexConversionStatus').innerText()).toContain('Retained shell:');
      expect(await page.locator('#sshCodexConversionConfirm').isEnabled()).toBe(false);
      await page.close();
    });
});
