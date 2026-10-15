/** Real-browser responsive layout coverage for Session Options. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const html = readFileSync(resolve(publicDir, 'index.html'), 'utf8');
const styles = readFileSync(resolve(publicDir, 'styles.css'), 'utf8');
const mobileStyles = readFileSync(resolve(publicDir, 'mobile.css'), 'utf8');

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

  it.each([390, 1280])(
    'round-trips distinct multiline task criteria and exact untouched CRLF at %spx',
    async (width) => {
      await page.close();
      page = await browser.newPage();
      await renderAt(width);
      await page.addScriptTag({ content: 'window.CodemanApp = class {};' });
      for (const file of ['api-client.js', 'recovery-ui.js', 'supervision-ui.js'])
        await page.addScriptTag({ content: readFileSync(resolve(publicDir, file), 'utf8') });
      const exact = '  printf "界"\r\nprintf "old second line"  ';
      const original = {
        version: 1,
        objective: 'Review fixture',
        criteria: [
          {
            id: 'command-first',
            description: 'First label\r\n保留  ',
            kind: 'command',
            command: exact,
            verified: true,
            evidence: { source: 'command', at: 10000, commandHash: 'a'.repeat(64) },
          },
          { id: 'manual-middle', description: 'Owner review\nsecond line', kind: 'manual', verified: false },
          {
            id: 'command-second',
            description: 'Second human label',
            kind: 'command',
            command: 'printf second',
            verified: false,
          },
        ],
        config: { enabled: false, maxContinuations: 3, maxRuntimeMs: 900000 },
        phase: 'disabled',
        outcome: 'unfinished',
        reason: 'disabled',
        continuations: 0,
        checkpoint: '',
        nextAction: '',
        history: [],
      };
      await page.evaluate(async (initial) => {
        const w = window as any;
        document
          .querySelectorAll('#sessionOptionsModal .set-section')
          .forEach((section) => section.classList.add('hidden'));
        document.getElementById('task-tab')!.classList.remove('hidden');
        w.__codemanCliCatalog = [{ id: 'codex', recovery: 'codex-rollout' }];
        w.app = new w.CodemanApp();
        const app = w.app;
        app.sessions = new Map([
          ['a', { mode: 'codex' }],
          ['b', { mode: 'codex' }],
        ]);
        app.editingSessionId = 'a';
        app.showToast = () => {};
        w.taskWrites = [];
        const current = structuredClone(initial);
        app._apiJson = async (url: string, options?: { method?: string; body?: any }) => {
          if (url.includes('/b/'))
            return {
              ...initial,
              criteria: [{ id: 'b-only', description: 'Other session criterion', kind: 'manual', verified: false }],
            };
          if (options?.method === 'PUT') {
            w.taskWrites.push({ url, body: structuredClone(options.body) });
            const patch = options.body;
            if (patch.criteria)
              current.criteria = patch.criteria.map((criterion: any) => ({ ...criterion, verified: false }));
            if (patch.objective) current.objective = patch.objective;
            current.config = { ...current.config, ...patch.config };
          }
          return structuredClone(current);
        };
        app.openTaskOptions('a');
        await app.loadTaskStatus();
      }, original);
      const rows = page.locator('#taskCriteriaRows > [data-task-criterion-row]');
      await expect.poll(() => rows.count()).toBe(3);
      expect(await rows.first().locator('[data-task-field="command"]').inputValue()).toBe(exact.replace(/\r\n/g, '\n'));
      await rows.first().locator('[data-task-field="command"]').focus();
      expect(
        await page.evaluate(() => {
          const input = document.activeElement;
          const app = (window as any).app;
          app._onSessionTask({ sessionId: 'a', state: { ...app._taskView.state, reason: 'configured' } });
          return document.activeElement === input && input?.isConnected;
        })
      ).toBe(true);
      await page.locator('#taskMaxContinuations').fill('5');
      await page.getByRole('button', { name: 'Save task configuration', exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as any).taskWrites.length)).toBe(1);
      expect(await page.evaluate(() => (window as any).taskWrites[0].body.criteria)).toBeUndefined();
      expect(await page.evaluate(() => (window as any).app._taskView.state.criteria[0])).toEqual(original.criteria[0]);
      const edited = '  printf "新"\nprintf "edited second line"  ';
      await rows.nth(2).locator('[data-task-field="command"]').fill(edited);
      await page.getByRole('button', { name: 'Save task configuration', exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as any).taskWrites.length)).toBe(2);
      const firstEdit = await page.evaluate(() => (window as any).taskWrites[1].body.criteria);
      expect(firstEdit.map((criterion: any) => criterion.id)).toEqual(
        original.criteria.map((criterion) => criterion.id)
      );
      expect(firstEdit[0]).toMatchObject({ command: exact, description: original.criteria[0].description });
      expect(firstEdit[2]).toMatchObject({ command: edited, description: 'Second human label' });
      await page.locator('#taskAddCommandCriterion').click();
      await rows.last().locator('[data-task-field="command"]').fill(edited);
      await rows.nth(1).getByRole('button', { name: 'Remove criterion', exact: true }).click();
      await page.getByRole('button', { name: 'Save task configuration', exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as any).taskWrites.length)).toBe(3);
      const added = await page.evaluate(() => (window as any).taskWrites[2].body.criteria);
      expect(added).toHaveLength(3);
      expect(added.slice(0, 2).map((criterion: any) => criterion.id)).toEqual(['command-first', 'command-second']);
      expect(added[0].command).toBe(exact);
      expect(added[2]).toMatchObject({ kind: 'command', description: edited, command: edited });
      expect(original.criteria.map((criterion) => criterion.id)).not.toContain(added[2].id);
      const layout = await page.evaluate(() => {
        const panel = document.getElementById('task-tab')!;
        const remove = panel.querySelector('[data-task-criterion-row] button')!;
        return { fits: panel.scrollWidth <= panel.clientWidth, removeHeight: remove.getBoundingClientRect().height };
      });
      expect(layout.fits).toBe(true);
      if (width < 600) expect(layout.removeHeight).toBeGreaterThanOrEqual(44);
      await page.evaluate(async () => {
        const app = (window as any).app;
        app.editingSessionId = 'b';
        app.openTaskOptions('b');
        await app.loadTaskStatus();
      });
      await expect.poll(() => rows.count()).toBe(1);
      expect(await rows.first().locator('textarea').inputValue()).toBe('Other session criterion');
      expect(
        await page.evaluate(() =>
          (window as any).taskWrites.every((write: any) => write.url === '/api/sessions/a/task')
        )
      ).toBe(true);
      await page.evaluate(() => (window as any).app.closeTaskOptions());
      expect(await rows.count()).toBe(0);
    }
  );
});
