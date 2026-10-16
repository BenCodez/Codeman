/** @fileoverview Real-browser responsive layout coverage for Session Options. */
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
          ['a', { mode: 'codex', taskSupported: true }],
          ['b', { mode: 'codex', taskSupported: true }],
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
  it.each([390, 1280])(
    'preserves focused task drafts after failed saves and allows exact retry at %spx',
    async (width) => {
      await page.close();
      page = await browser.newPage();
      await renderAt(width);
      await page.addScriptTag({ content: 'window.CodemanApp = class {};' });
      for (const file of ['api-client.js', 'recovery-ui.js', 'supervision-ui.js'])
        await page.addScriptTag({ content: readFileSync(resolve(publicDir, file), 'utf8') });
      await page.evaluate(async () => {
        const w = window as any;
        document.getElementById('context-tab')!.classList.add('hidden');
        document.getElementById('task-tab')!.classList.remove('hidden');
        w.__codemanCliCatalog = [{ id: 'codex', recovery: 'codex-rollout' }];
        w.app = new w.CodemanApp();
        w.app.sessions = new Map([['a', { mode: 'codex', taskSupported: true }]]);
        w.app.editingSessionId = 'a';
        w.app.showToast = (message: string) => (w.lastTaskError = message);
        w.taskState = {
          version: 1,
          objective: 'Stored objective',
          criteria: [
            { id: 'exact', kind: 'command', description: 'Existing label', command: 'old command', verified: false },
          ],
          config: { enabled: false, maxContinuations: 3, maxRuntimeMs: 900000 },
          phase: 'disabled',
          outcome: 'unknown',
          reason: 'disabled',
          continuations: 0,
          checkpoint: '',
          nextAction: '',
          history: [],
        };
        w.taskRequests = [];
        w.taskFailure = true;
        w.fetch = async (_url: string, options?: { method?: string; body?: string }) => {
          if (options?.method !== 'GET') {
            w.taskRequests.push(JSON.parse(options!.body!));
            if (w.taskFailure) return new Response(JSON.stringify({ success: false }), { status: 500 });
            const patch = JSON.parse(options!.body!);
            if (options?.method === 'PUT') w.taskState = { ...w.taskState, ...patch };
            else
              w.taskState = {
                ...w.taskState,
                checkpoint: patch.checkpoint,
                nextAction: patch.nextAction,
                outcome: patch.outcome,
                criteria: w.taskState.criteria.map((criterion: any) =>
                  patch.verifiedCriteria.includes(criterion.id) ? { ...criterion, verified: true } : criterion
                ),
              };
          }
          return new Response(JSON.stringify({ success: true, data: w.taskState }), { status: 200 });
        };
        w.app.openTaskOptions('a');
        await w.app.loadTaskStatus();
      });
      const command = page.locator('#taskCriteriaRows [data-task-field="command"]');
      await page.locator('#taskObjective').fill('Draft objective');
      await command.fill('  printf "界"\nnext line  ');
      await page.locator('#taskCheckpoint').fill('Draft checkpoint');
      await page.locator('#taskNextAction').fill('Draft next action');
      await page.locator('#taskProgressOutcome').selectOption('blocked');
      await page.locator('#taskCriteriaEvidence input').check();
      for (const action of ['saveTaskConfiguration', 'saveTaskProgress']) {
        await command.focus();
        await command.evaluate((node) => (node as HTMLTextAreaElement).setSelectionRange(2, 5));
        const retained = await page.evaluate(async (method) => {
          const app = (window as any).app,
            input = document.activeElement,
            state = app._taskView.state;
          await app[method]();
          const textarea = input as HTMLTextAreaElement;
          return {
            sameNode: input?.isConnected && document.activeElement === input,
            sameState: app._taskView.state === state,
            selection: [textarea.selectionStart, textarea.selectionEnd],
            dirty: app._taskView.dirty,
            busy: app._taskView.busy,
          };
        }, action);
        expect(retained).toEqual({ sameNode: true, sameState: true, selection: [2, 5], dirty: true, busy: false });
        expect(await page.locator('#taskObjective').inputValue()).toBe('Draft objective');
        expect(await command.inputValue()).toBe('  printf "界"\nnext line  ');
        expect(await page.locator('#taskCheckpoint').inputValue()).toBe('Draft checkpoint');
        expect(await page.locator('#taskNextAction').inputValue()).toBe('Draft next action');
        expect(await page.locator('#taskCriteriaEvidence input').isChecked()).toBe(true);
        expect(await page.locator('#taskSettings').isEnabled()).toBe(true);
        expect(await page.evaluate(() => (window as any).lastTaskError)).toContain('Task action failed');
      }
      await page.evaluate(async () => {
        const w = window as any;
        w.taskFailure = false;
        await w.app.saveTaskProgress();
      });
      const requests = await page.evaluate(() => (window as any).taskRequests);
      expect(requests[2]).toEqual(requests[1]);
      expect(await page.evaluate(() => (window as any).app._taskView.dirty)).toBe(true);
      expect(await page.locator('#taskObjective').inputValue()).toBe('Draft objective');
      expect(await command.inputValue()).toBe('  printf "界"\nnext line  ');
      await page.getByRole('button', { name: 'Save task configuration', exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as any).app._taskView.dirty)).toBe(false);
      expect(await page.locator('#taskObjective').inputValue()).toBe('Draft objective');
      await page.evaluate(() => (window as any).app.closeTaskOptions());
    }
  );
  it.each([390, 1280])('preserves every unsaved task field through successful Pause/Resume at %spx', async (width) => {
    await page.close();
    page = await browser.newPage();
    await renderAt(width);
    await page.addScriptTag({ content: 'window.CodemanApp = class {};' });
    for (const file of ['api-client.js', 'recovery-ui.js', 'supervision-ui.js'])
      await page.addScriptTag({ content: readFileSync(resolve(publicDir, file), 'utf8') });
    await page.evaluate(async () => {
      const w = window as any;
      document.getElementById('context-tab')!.classList.add('hidden');
      document.getElementById('task-tab')!.classList.remove('hidden');
      w.__codemanCliCatalog = [{ id: 'codex', recovery: 'codex-rollout' }];
      w.app = new w.CodemanApp();
      w.app.sessions = new Map([['a', { mode: 'codex', taskSupported: true }]]);
      w.app.editingSessionId = 'a';
      w.app.showToast = (message: string) => (w.lastTaskError = message);
      w.taskState = {
        version: 1,
        objective: 'Saved objective',
        criteria: [
          { id: 'manual', kind: 'manual', description: 'Saved manual criterion', verified: false },
          {
            id: 'command',
            kind: 'command',
            description: 'Saved command label',
            command: 'saved check',
            verified: false,
          },
        ],
        config: { enabled: true, maxContinuations: 3, maxRuntimeMs: 900000 },
        phase: 'watching',
        outcome: 'unfinished',
        reason: 'configured',
        continuations: 0,
        checkpoint: 'Saved checkpoint',
        nextAction: 'Saved action',
        history: [],
      };
      w.taskRequests = [];
      w.failTaskControl = false;
      w.fetch = async (url: string, options?: { method?: string; body?: string }) => {
        if (options?.method !== 'GET') {
          w.taskRequests.push({
            url,
            method: options?.method,
            body: options?.body === undefined ? null : JSON.parse(options.body),
          });
          if (w.failTaskControl) return new Response(JSON.stringify({ success: false }), { status: 500 });
          if (url.endsWith('/pause')) w.taskState = { ...w.taskState, phase: 'paused', reason: 'owner-paused' };
          if (url.endsWith('/resume')) w.taskState = { ...w.taskState, phase: 'watching', reason: 'owner-resumed' };
          if (url.endsWith('/progress')) {
            const patch = JSON.parse(options.body!);
            w.taskState = {
              ...w.taskState,
              checkpoint: patch.checkpoint,
              nextAction: patch.nextAction,
              outcome: patch.outcome,
              criteria: w.taskState.criteria.map((criterion: any) =>
                patch.verifiedCriteria.includes(criterion.id) ? { ...criterion, verified: true } : criterion
              ),
            };
          }
          if (options?.method === 'PUT') {
            const patch = JSON.parse(options.body!);
            w.taskState = {
              ...w.taskState,
              ...patch,
              phase: patch.config.enabled ? 'watching' : 'disabled',
              reason: 'configured',
              config: { ...w.taskState.config, ...patch.config },
              criteria: patch.criteria.map((criterion: any) => ({ ...criterion, verified: false })),
            };
          }
        }
        return new Response(JSON.stringify({ success: true, data: w.taskState }), { status: 200 });
      };
      w.app.openTaskOptions('a');
      await w.app.loadTaskStatus();
    });
    const rows = page.locator('#taskCriteriaRows > [data-task-criterion-row]');
    await page.locator('#taskObjective').fill('  Unsaved objective\n界  ');
    await rows.first().locator('textarea').fill('  Unsaved manual criterion\n界  ');
    await rows.nth(1).locator('[data-task-field="description"]').fill('Unsaved command label');
    await rows.nth(1).locator('[data-task-field="command"]').fill('  printf "界"\nnext check  ');
    await page.locator('#taskAddManualCriterion').click();
    await rows.last().locator('textarea').fill('Added manual acceptance');
    await page.locator('#taskEnabled').uncheck();
    await page.locator('#taskMaxContinuations').fill('7');
    await page.locator('#taskMaxRuntime').fill('321');
    await page.locator('#taskCheckpoint').fill('  Unsaved checkpoint\n界  ');
    await page.locator('#taskNextAction').fill('  Unsaved next action\n界  ');
    await page.locator('#taskProgressOutcome').selectOption('blocked');
    await page.locator('#taskCriteriaEvidence input').first().check();
    const snapshot = () =>
      page.evaluate(() => {
        const input = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
        return {
          objective: input('taskObjective'),
          enabled: (document.getElementById('taskEnabled') as HTMLInputElement).checked,
          max: input('taskMaxContinuations'),
          runtime: input('taskMaxRuntime'),
          checkpoint: input('taskCheckpoint'),
          nextAction: input('taskNextAction'),
          outcome: input('taskProgressOutcome'),
          rows: [...document.querySelectorAll<HTMLElement>('#taskCriteriaRows [data-task-criterion-row]')].map(
            (row) => ({
              id: row.dataset.criterionId,
              fields: [...row.querySelectorAll('textarea')].map((field) => field.value),
            })
          ),
          selected: [...document.querySelectorAll<HTMLInputElement>('#taskCriteriaEvidence input:checked')].map(
            (field) => field.value
          ),
        };
      });
    const draft = await snapshot();
    for (const action of ['pause', 'resume']) {
      await page.locator(action === 'pause' ? '#taskPauseBtn' : '#taskResumeBtn').click();
      await expect
        .poll(() => page.locator('#taskPhase').textContent())
        .toBe(action === 'pause' ? 'Paused' : 'Monitoring');
      expect(await snapshot()).toEqual(draft);
      expect(await page.evaluate(() => (window as any).app._taskView.dirty)).toBe(true);
      expect(await page.locator('#taskPauseBtn').isEnabled()).toBe(true);
      expect(await page.locator('#taskResumeBtn').isEnabled()).toBe(true);
    }
    await page.evaluate(() => {
      (window as any).failTaskControl = true;
    });
    await page.locator('#taskPauseBtn').click();
    await expect.poll(() => page.evaluate(() => (window as any).lastTaskError)).toContain('Task action failed');
    expect(await snapshot()).toEqual(draft);
    expect(await page.locator('#taskPhase').textContent()).toBe('Monitoring');
    await page.evaluate(() => {
      (window as any).failTaskControl = false;
    });
    await page.getByRole('button', { name: 'Save task configuration', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).taskRequests.length)).toBe(4);
    const requests = await page.evaluate(() => (window as any).taskRequests);
    expect(requests.slice(0, 3).map((request: any) => request.body)).toEqual([null, null, null]);
    expect(requests[3].body).toMatchObject({
      objective: draft.objective,
      config: { enabled: false, maxContinuations: 7, maxRuntimeMs: 321000 },
    });
    expect(requests[3].body.criteria.map((criterion: any) => criterion.id)).toEqual(draft.rows.map((row) => row.id));
    expect(requests[3].body.criteria[1].command).toBe(draft.rows[1].fields[1]);
    await expect.poll(() => page.evaluate(() => (window as any).app._taskView.dirty)).toBe(true);
    expect(await page.locator('#taskCheckpoint').inputValue()).toBe(draft.checkpoint);
    expect(await page.locator('#taskNextAction').inputValue()).toBe(draft.nextAction);
    expect(await page.locator('#taskCriteriaEvidence input').first().isChecked()).toBe(true);
    await page.getByRole('button', { name: 'Save checkpoint / verification', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).app._taskView.dirty)).toBe(false);
    const progress = await page.evaluate(() => (window as any).taskRequests[4]);
    expect(progress.body).toMatchObject({
      checkpoint: draft.checkpoint,
      nextAction: draft.nextAction,
      verifiedCriteria: ['manual'],
    });
    await page.evaluate(() => (window as any).app.closeTaskOptions());
  });
  it.each([390, 1280])('preserves original and edited checkpoint whitespace at %spx', async (width) => {
    await page.close();
    page = await browser.newPage();
    await renderAt(width);
    await page.addScriptTag({ content: 'window.CodemanApp = class {};' });
    for (const file of ['api-client.js', 'recovery-ui.js', 'supervision-ui.js'])
      await page.addScriptTag({ content: readFileSync(resolve(publicDir, file), 'utf8') });
    const original = { checkpoint: ' \tOwner checkpoint\r\n界\r\n  ', nextAction: '\r\n  Next action\r\n\t ' };
    await page.evaluate(async (text) => {
      const w = window as any;
      document.getElementById('context-tab')!.classList.add('hidden');
      document.getElementById('task-tab')!.classList.remove('hidden');
      w.__codemanCliCatalog = [{ id: 'codex', recovery: 'codex-rollout' }];
      w.app = new w.CodemanApp();
      w.app.sessions = new Map([['a', { mode: 'codex', taskSupported: true }]]);
      w.app.editingSessionId = 'a';
      w.app.showToast = () => {};
      w.taskState = {
        version: 1,
        objective: 'Owner review',
        criteria: [{ id: 'owner', kind: 'manual', description: 'Owner acceptance', verified: false }],
        config: { enabled: false, maxContinuations: 3, maxRuntimeMs: 900000 },
        phase: 'paused',
        outcome: 'unknown',
        reason: 'configured',
        continuations: 0,
        history: [],
        ...text,
      };
      w.progressWrites = [];
      w.fetch = async (_url: string, options?: { method?: string; body?: string }) => {
        if (options?.method === 'POST') {
          const patch = JSON.parse(options.body!);
          w.progressWrites.push(patch);
          w.taskState = {
            ...w.taskState,
            checkpoint: patch.checkpoint,
            nextAction: patch.nextAction,
            outcome: patch.outcome,
            phase: patch.outcome === 'blocked' ? 'blocked' : 'paused',
            agentProgressVeto: true,
            reason: 'progress-recorded',
            criteria: w.taskState.criteria.map((criterion: any) =>
              patch.verifiedCriteria.includes(criterion.id)
                ? { ...criterion, verified: true, evidence: { source: 'owner', at: 10000 } }
                : criterion
            ),
          };
        }
        return new Response(JSON.stringify({ success: true, data: w.taskState }), { status: 200 });
      };
      w.app.openTaskOptions('a');
      await w.app.loadTaskStatus();
    }, original);
    expect(await page.locator('#taskCheckpoint').inputValue()).toBe(original.checkpoint.replace(/\r\n/g, '\n'));
    await page.locator('#taskCriteriaEvidence input').check();
    await page.locator('#taskProgressOutcome').selectOption('blocked');
    await page.getByRole('button', { name: 'Save checkpoint / verification', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).app._taskView.dirty)).toBe(false);
    const first = await page.evaluate(() => (window as any).progressWrites[0]);
    expect(first).toEqual({ ...original, outcome: 'blocked', verifiedCriteria: ['owner'] });
    const edited = ' \n Edited owner checkpoint 界\n\t ';
    await page.locator('#taskCheckpoint').fill(edited);
    await page.locator('#taskProgressOutcome').selectOption('unknown');
    await page.getByRole('button', { name: 'Save checkpoint / verification', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).app._taskView.dirty)).toBe(false);
    const second = await page.evaluate(() => (window as any).progressWrites[1]);
    expect(second).toMatchObject({ checkpoint: edited, nextAction: original.nextAction, outcome: 'unknown' });
    expect(await page.locator('#taskCheckpoint').inputValue()).toBe(edited);
    expect(await page.evaluate(() => (window as any).app._taskView.state.nextAction)).toBe(original.nextAction);
    await page.evaluate(() => (window as any).app.closeTaskOptions());
  });
  it.each([390, 1280])('preserves exact objective edits and untouched CRLF at %spx', async (width) => {
    await page.close();
    page = await browser.newPage();
    await renderAt(width);
    await page.addScriptTag({ content: 'window.CodemanApp = class {};' });
    for (const file of ['api-client.js', 'recovery-ui.js', 'supervision-ui.js'])
      await page.addScriptTag({ content: readFileSync(resolve(publicDir, file), 'utf8') });
    const original = '  Owner objective\r\n界  ';
    await page.evaluate(async (objective) => {
      const w = window as any;
      document.getElementById('context-tab')!.classList.add('hidden');
      document.getElementById('task-tab')!.classList.remove('hidden');
      w.__codemanCliCatalog = [{ id: 'codex', recovery: 'codex-rollout' }];
      w.app = new w.CodemanApp();
      w.app.sessions = new Map([['a', { mode: 'codex', taskSupported: true }]]);
      w.app.editingSessionId = 'a';
      w.app.showToast = () => {};
      w.taskState = {
        version: 1,
        objective,
        criteria: [{ id: 'owner', kind: 'manual', description: 'Owner acceptance', verified: false }],
        config: { enabled: false, maxContinuations: 3, maxRuntimeMs: 900000 },
        phase: 'paused',
        outcome: 'unknown',
        reason: 'configured',
        continuations: 0,
        history: [],
      };
      w.configurationWrites = [];
      w.fetch = async (_url: string, options?: { method?: string; body?: string }) => {
        if (options?.method === 'PUT') {
          const patch = JSON.parse(options.body!);
          w.configurationWrites.push(patch);
          w.taskState = { ...w.taskState, ...patch };
        }
        return new Response(JSON.stringify({ success: true, data: w.taskState }), { status: 200 });
      };
      w.app.openTaskOptions('a');
      await w.app.loadTaskStatus();
    }, original);
    const save = async (count: number) => {
      await page.getByRole('button', { name: 'Save task configuration', exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as any).configurationWrites.length)).toBe(count);
      await expect.poll(() => page.evaluate(() => (window as any).app._taskView.dirty)).toBe(false);
    };
    await page.locator('#taskMaxContinuations').fill('5');
    await save(1);
    expect(await page.evaluate(() => Object.hasOwn((window as any).configurationWrites[0], 'objective'))).toBe(false);
    expect(await page.evaluate(() => (window as any).taskState.objective)).toBe(original);
    await page.locator('#taskObjective').fill('Owner objective\n界');
    await save(2);
    expect(await page.evaluate(() => (window as any).configurationWrites[1].objective)).toBe('Owner objective\n界');
    const padded = ' \tOwner objective\n界  \n ';
    await page.locator('#taskObjective').fill(padded);
    await save(3);
    expect(await page.evaluate(() => (window as any).configurationWrites[2].objective)).toBe(padded);
    expect(await page.locator('#taskObjective').inputValue()).toBe(padded);
    await page.locator('#taskObjective').fill(' \t\n ');
    await page.getByRole('button', { name: 'Save task configuration', exact: true }).click();
    expect(await page.evaluate(() => (window as any).configurationWrites.length)).toBe(3);
    expect(await page.locator('#taskObjective').inputValue()).toBe(' \t\n ');
    await page.evaluate(() => (window as any).app.closeTaskOptions());
  });
  it.each([390, 1280].flatMap((width) => ['configuration', 'progress'].map((dirty) => ({ width, dirty }))))(
    'refreshes the clean sibling from SSE while $dirty stays edited at $width px',
    async ({ width, dirty }) => {
      await page.close();
      page = await browser.newPage();
      await renderAt(width);
      await page.addScriptTag({ content: 'window.CodemanApp = class {};' });
      for (const file of ['api-client.js', 'recovery-ui.js', 'supervision-ui.js'])
        await page.addScriptTag({ content: readFileSync(resolve(publicDir, file), 'utf8') });
      await page.evaluate(async () => {
        const w = window as any;
        document.getElementById('context-tab')!.classList.add('hidden');
        document.getElementById('task-tab')!.classList.remove('hidden');
        w.__codemanCliCatalog = [{ id: 'codex', recovery: 'codex-rollout' }];
        w.app = new w.CodemanApp();
        w.app.sessions = new Map([['a', { mode: 'codex', taskSupported: true }]]);
        w.app.editingSessionId = 'a';
        w.app.showToast = () => {};
        w.taskState = {
          version: 1,
          objective: 'Original objective',
          checkpoint: 'Original checkpoint',
          nextAction: 'Original action',
          criteria: [{ id: 'owner', kind: 'manual', description: 'Owner acceptance', verified: false }],
          config: { enabled: false, maxContinuations: 3, maxRuntimeMs: 900000 },
          phase: 'paused',
          outcome: 'unknown',
          reason: 'configured',
          continuations: 0,
          history: [],
        };
        w.writes = [];
        w.fetch = async (_url: string, options?: { method?: string; body?: string }) => {
          if (options?.body) {
            const body = JSON.parse(options.body);
            w.writes.push(body);
            w.taskState =
              options.method === 'PUT'
                ? { ...w.taskState, ...body }
                : {
                    ...w.taskState,
                    checkpoint: body.checkpoint,
                    nextAction: body.nextAction,
                    outcome: body.outcome,
                    criteria: w.taskState.criteria.map((criterion: any) =>
                      body.verifiedCriteria.includes(criterion.id) ? { ...criterion, verified: true } : criterion
                    ),
                  };
          }
          return new Response(JSON.stringify({ success: true, data: w.taskState }), { status: 200 });
        };
        w.app.openTaskOptions('a');
        await w.app.loadTaskStatus();
      });
      if (dirty === 'configuration') {
        await page.locator('#taskObjective').fill('Unsaved owner objective');
        await page.locator('#taskCriteriaRows textarea').fill('Unsaved owner criterion');
      } else {
        await page.locator('#taskCheckpoint').fill('Unsaved owner checkpoint');
        await page.locator('#taskNextAction').fill('Unsaved owner action');
        await page.locator('#taskCriteriaEvidence input').check();
      }
      const latest = {
        objective: '  Server objective\r\n界  ',
        checkpoint: '  Server checkpoint\r\n界  ',
        nextAction: 'Server action\r\n  ',
      };
      await page.evaluate((text) => {
        const w = window as any;
        w.taskState = {
          ...w.taskState,
          ...text,
          phase: 'blocked',
          reason: 'task-blocked',
          criteria: [{ id: 'owner', kind: 'manual', description: 'Latest server owner criterion', verified: false }],
          config: { ...w.taskState.config, maxContinuations: 7 },
        };
        w.app._onSessionTask({ sessionId: 'a', state: w.taskState });
      }, latest);
      expect(await page.locator('#taskPhase').textContent()).toBe('Blocked');
      if (dirty === 'configuration') {
        expect(await page.locator('#taskObjective').inputValue()).toBe('Unsaved owner objective');
        expect(await page.locator('#taskCriteriaRows textarea').inputValue()).toBe('Unsaved owner criterion');
        expect(await page.locator('#taskCheckpoint').inputValue()).toBe(latest.checkpoint.replace(/\r\n/g, '\n'));
        await page.locator('#taskCriteriaEvidence input').check();
        await page.getByRole('button', { name: 'Save checkpoint / verification', exact: true }).click();
      } else {
        expect(await page.locator('#taskObjective').inputValue()).toBe(latest.objective.replace(/\r\n/g, '\n'));
        expect(await page.locator('#taskCriteriaRows textarea').inputValue()).toBe('Latest server owner criterion');
        expect(await page.locator('#taskMaxContinuations').inputValue()).toBe('7');
        expect(await page.locator('#taskCheckpoint').inputValue()).toBe('Unsaved owner checkpoint');
        expect(await page.locator('#taskCriteriaEvidence input').isChecked()).toBe(true);
        await page.getByRole('button', { name: 'Save task configuration', exact: true }).click();
      }
      await expect.poll(() => page.evaluate(() => (window as any).writes.length)).toBe(1);
      const body = await page.evaluate(() => (window as any).writes[0]);
      if (dirty === 'configuration') {
        expect(body).toMatchObject({
          checkpoint: latest.checkpoint,
          nextAction: latest.nextAction,
          verifiedCriteria: ['owner'],
        });
        expect(await page.locator('#taskObjective').inputValue()).toBe('Unsaved owner objective');
      } else {
        expect(body).toEqual({ config: { enabled: false, maxContinuations: 7, maxRuntimeMs: 900000 } });
        expect(await page.locator('#taskCheckpoint').inputValue()).toBe('Unsaved owner checkpoint');
      }
      expect(await page.evaluate(() => (window as any).app._taskView.dirty)).toBe(true);
      await page.evaluate(() => (window as any).app.closeTaskOptions());
    }
  );
  it.each([390, 1280])(
    'keeps completed task Pause disabled, then pauses new unfinished work at %spx',
    async (width) => {
      await page.close();
      page = await browser.newPage();
      await renderAt(width);
      await page.addScriptTag({ content: 'window.CodemanApp = class {};' });
      for (const file of ['api-client.js', 'recovery-ui.js', 'supervision-ui.js'])
        await page.addScriptTag({ content: readFileSync(resolve(publicDir, file), 'utf8') });
      await page.evaluate(async () => {
        const w = window as any;
        document.getElementById('context-tab')!.classList.add('hidden');
        document.getElementById('task-tab')!.classList.remove('hidden');
        w.__codemanCliCatalog = [{ id: 'codex', recovery: 'codex-rollout' }];
        w.app = new w.CodemanApp();
        w.app.sessions = new Map([['a', { mode: 'codex', taskSupported: true }]]);
        w.app.editingSessionId = 'a';
        w.app.showToast = () => {};
        w.taskState = {
          version: 1,
          objective: 'Finished owner task',
          criteria: [{ id: 'owner', kind: 'manual', description: 'Owner accepted', verified: true }],
          config: { enabled: true, maxContinuations: 3, maxRuntimeMs: 900000 },
          phase: 'completed',
          outcome: 'completed',
          reason: 'completed',
          continuations: 0,
          history: [],
        };
        w.pauseRequests = 0;
        w.fetch = async (url: string, options?: { method?: string }) => {
          if (url.endsWith('/pause') && options?.method === 'POST') {
            w.pauseRequests++;
            w.taskState = { ...w.taskState, phase: 'paused', reason: 'owner-paused' };
          }
          return new Response(JSON.stringify({ success: true, data: w.taskState }), { status: 200 });
        };
        w.app.openTaskOptions('a');
        await w.app.loadTaskStatus();
      });
      expect(await page.locator('#taskPauseBtn').isDisabled()).toBe(true);
      expect(await page.locator('#taskPhase').textContent()).toBe('Completed');
      await page.evaluate(async () => (window as any).app.taskAction('pause'));
      expect(await page.evaluate(() => (window as any).pauseRequests)).toBe(0);
      await page.evaluate(() => {
        const w = window as any;
        w.taskState = { ...w.taskState, objective: 'New unfinished task', phase: 'watching', outcome: 'unfinished' };
        w.app._onSessionTask({ sessionId: 'a', state: w.taskState });
      });
      expect(await page.locator('#taskPauseBtn').isEnabled()).toBe(true);
      await page.locator('#taskPauseBtn').click();
      await expect.poll(() => page.evaluate(() => (window as any).pauseRequests)).toBe(1);
      await expect.poll(() => page.locator('#taskPhase').textContent()).toBe('Paused');
      await page.evaluate(() => (window as any).app.closeTaskOptions());
    }
  );
});
