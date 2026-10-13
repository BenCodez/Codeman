/** @fileoverview Reboot-offer dismissal behavior over the real banner markup. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const INDEX = readFileSync(resolve(PUBLIC, 'index.html'), 'utf8');
const UI = readFileSync(resolve(PUBLIC, 'reboot-restore-ui.js'), 'utf8');
const openDoms: JSDOM[] = [];

function harness(response: { ok: boolean } | null) {
  const dom = new JSDOM(INDEX, { runScripts: 'outside-only', url: 'http://localhost/' });
  openDoms.push(dom);
  const context = dom.getInternalVMContext();
  vm.runInContext('class CodemanApp { $(id) { return document.getElementById(id); } }', context);
  vm.runInContext(UI, context, { filename: 'reboot-restore-ui.js' });
  const app = vm.runInContext('new CodemanApp()', context) as any;
  app._apiPost = vi.fn(async () => response);
  app.showToast = vi.fn();
  app._rebootRestoreSessions = [{ id: 'session-a', name: 'Demo', workingDir: '/workspace/demo' }];
  app.renderRebootRestoreBanner();
  return { app, dom, banner: dom.window.document.getElementById('rebootRestoreBanner') as HTMLElement };
}

afterEach(() => {
  for (const dom of openDoms.splice(0)) dom.window.close();
});

describe('reboot restore banner dismissal', () => {
  it('keeps the offer visible and reports a failed durable dismissal', async () => {
    const { app, banner } = harness(null);
    await app.dismissRebootRestore();

    expect(banner.hidden).toBe(false);
    expect(app._rebootRestoreSessions).toHaveLength(1);
    expect(app.showToast).toHaveBeenCalledWith('Could not dismiss the restore offer', 'error');
    expect(banner.querySelector<HTMLButtonElement>('#rebootRestoreBannerDismiss')?.disabled).toBe(false);
  });

  it('hides the offer only after the server confirms dismissal', async () => {
    const { app, banner } = harness({ ok: true });
    await app.dismissRebootRestore();

    expect(banner.hidden).toBe(true);
    expect(app._rebootRestoreSessions).toEqual([]);
  });

  it('can dismiss a new offer refreshed after an earlier successful dismissal', async () => {
    const { app, banner } = harness({ ok: true });
    await app.dismissRebootRestore();

    app._apiJson = vi.fn(async () => ({
      sessions: [{ id: 'session-b', name: 'New offer', workingDir: '/workspace/new' }],
    }));
    await app.refreshRebootRestoreBanner();
    const button = banner.querySelector<HTMLButtonElement>('#rebootRestoreBannerDismiss');
    expect(banner.hidden).toBe(false);
    expect(button?.disabled).toBe(false);

    await app.dismissRebootRestore();
    expect(app._apiPost).toHaveBeenCalledTimes(2);
    expect(banner.hidden).toBe(true);
  });

  it('keeps a refreshed offer disabled until the pending dismissal settles', async () => {
    const { app, banner } = harness({ ok: true });
    let settle!: (response: { ok: boolean }) => void;
    app._apiPost = vi.fn(() => new Promise((resolve) => (settle = resolve)));
    const dismissing = app.dismissRebootRestore();

    app._apiJson = vi.fn(async () => ({
      sessions: [{ id: 'session-b', name: 'Still offered', workingDir: '/workspace/new' }],
    }));
    await app.refreshRebootRestoreBanner();
    const button = banner.querySelector<HTMLButtonElement>('#rebootRestoreBannerDismiss');
    expect(button?.disabled).toBe(true);
    await app.dismissRebootRestore();
    expect(app._apiPost).toHaveBeenCalledOnce();

    settle({ ok: false });
    await dismissing;
    expect(button?.disabled).toBe(false);
    expect(banner.hidden).toBe(false);
  });
});
