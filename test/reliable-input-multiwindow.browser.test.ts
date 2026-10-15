/** Actual Chromium documents share storage; every network edge is intercepted and no worker exists. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
const constants = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
});
afterAll(async () => {
  await browser?.close();
});
async function initialize(page: Page) {
  await page.addScriptTag({
    content:
      'var MobileDetection = {};\n' + constants + '\n' + source + '\nwindow.__InputPrototype=CodemanApp.prototype;',
  });
  await page.evaluate(() => {
    const w = window as any;
    const app = Object.assign(Object.create(w.__InputPrototype), {
      _seqCounters: new Map(),
      _pendingDeliveries: new Map(),
      _postDraining: new Set(),
      _persistReliableTimer: null,
      _reliableMaxBytes: 256 * 1024,
      _updateConnectionIndicator() {},
      pendingHooks: new Map(),
      _wsSessionId: 'fixture-session',
      showToast() {},
      _frames: [],
    });
    app._persistReliableState = () => app._persistReliableNow();
    app._loadReliableState();
    app._ws = { readyState: 1, send: (raw: string) => app._frames.push(JSON.parse(raw)) };
    w.queue = app;
    window.addEventListener('pagehide', () => app._persistReliableNow());
  });
}
it.each([
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
])('retains same-session input across actual duplicate windows, ACKs and reload at $width px', async (viewport) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  const accepted = new Set<string>(),
    delivered: string[] = [];
  const unexpected: string[] = [];
  const requests: { clientId: string; seq: number; input: string }[] = [];
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (new URL(request.url()).pathname === '/api/sessions/fixture-session/input') {
      const body = request.postDataJSON();
      requests.push(body);
      const id = body.clientId + ':' + body.seq,
        dup = accepted.has(id);
      if (!dup) {
        accepted.add(id);
        delivered.push(body.input);
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{}',
        headers: dup ? { 'x-codeman-input-ack': JSON.stringify({ seq: body.seq, dup: true, last: body.seq }) } : {},
      });
    } else if (new URL(request.url()).pathname === '/api/crash-diag') {
      const diagnostic = request.postDataJSON();
      if (typeof diagnostic?.data !== 'string' || !/^[\d:.]+ PAGE LOAD$/.test(diagnostic.data))
        unexpected.push(request.url() + ' ' + request.postData());
      await route.fulfill({ status: 204, body: '' });
    } else if (new URL(request.url()).pathname === '/favicon.ico') {
      await route.fulfill({ status: 204, body: '' });
    } else if (request.isNavigationRequest() && new URL(request.url()).origin === 'http://input-fixture.invalid') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Isolated input fixture</title>' });
    } else {
      unexpected.push(request.url() + ' ' + request.postData());
      await route.abort();
    }
  });
  try {
    const first = await context.newPage();
    await first.goto('http://input-fixture.invalid', { waitUntil: 'domcontentloaded' });
    await first.evaluate(() => sessionStorage.setItem('copied-tab-identity', 'original-window'));
    await initialize(first);
    const [second] = await Promise.all([
      first.waitForEvent('popup'),
      first.evaluate(() => {
        window.open('/');
      }),
    ]);
    await second.waitForLoadState('domcontentloaded');
    await initialize(second);
    expect(await second.evaluate(() => sessionStorage.getItem('copied-tab-identity'))).toBe('original-window');
    await Promise.all([
      first.evaluate(() => (window as any).queue._sendInputAsync('fixture-session', 'first window 🧭\n')),
      second.evaluate(() => (window as any).queue._sendInputAsync('fixture-session', 'second window')),
    ]);
    const a = await first.evaluate(() => ({
      cid: (window as any).queue._clientId,
      frames: (window as any).queue._frames,
    }));
    const b = await second.evaluate(() => ({
      cid: (window as any).queue._clientId,
      frames: (window as any).queue._frames,
    }));
    expect(a.cid).not.toBe(b.cid);
    expect(a.frames[0].seq).toBe(1);
    expect(b.frames[0].seq).toBe(1);
    // First bytes landed but their ACK was lost. Another document restores both immutable records.
    accepted.add(a.cid + ':1');
    delivered.push('first window 🧭\n');
    const recovery = await context.newPage();
    await recovery.goto('http://input-fixture.invalid', { waitUntil: 'domcontentloaded' });
    await initialize(recovery);
    await first.evaluate(() => {
      const app = (window as any).queue;
      app._onWsInputAck(1, {}, 'fixture-session');
      window.dispatchEvent(new PageTransitionEvent('pagehide'));
    });
    await second.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    expect(
      await first.evaluate(
        () => Object.keys(localStorage).filter((key) => key.startsWith('codeman:pendingInput:v3:')).length
      )
    ).toBe(1);
    await recovery.evaluate(async () => {
      const app = (window as any).queue;
      app._drainSession('fixture-session');
      const end = performance.now() + 2000;
      while (app._postDraining.size && performance.now() < end) await new Promise((done) => setTimeout(done, 0));
      if (app._postDraining.size) throw Error('Private HTTP replay did not settle');
    });
    expect(requests.map((body) => [body.clientId, body.seq]).sort()).toEqual(
      [
        [a.cid, 1],
        [b.cid, 1],
      ].sort()
    );
    expect(delivered).toEqual(['first window 🧭\n', 'second window']);
    await second.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    await recovery.reload({ waitUntil: 'domcontentloaded' });
    await initialize(recovery);
    expect(await recovery.evaluate(() => (window as any).queue._pendingDeliveries.size)).toBe(0);
    expect(await recovery.evaluate(() => (window as any).queue._clientId)).not.toBe(a.cid);
    expect(await recovery.evaluate(() => (window as any).queue._clientId)).not.toBe(b.cid);
    expect(
      await recovery.evaluate(() =>
        Object.keys(localStorage).filter((key) => key.startsWith('codeman:pendingInput:v3:'))
      )
    ).toEqual([]);
    expect(unexpected).toEqual([]);
  } finally {
    await context.close();
  }
});
