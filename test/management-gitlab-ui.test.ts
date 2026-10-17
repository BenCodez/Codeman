import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const root = resolve(import.meta.dirname, '../src/web/public');
const read = (name: string) => readFileSync(resolve(root, name), 'utf8');
const doms: JSDOM[] = [];
function config() {
  return {
    revision: 'a'.repeat(64),
    url: 'https://gitlab.example.test',
    projectIds: [12],
    allowAllProjects: false,
    allowWrite: false,
    writeBranchPrefix: 'codeman/',
    credentialConfigured: true,
  };
}
function harness(realManagement = false) {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', url: 'https://codeman.example.test/' });
  doms.push(dom);
  const ctx = dom.getInternalVMContext();
  vm.runInContext(
    'class CodemanApp { async loadManagementSettings() { this._managementView = {snapshot:{}}; } closeManagementSettings() { this._managementView = null; } }',
    ctx
  );
  if (realManagement) {
    (ctx as any).TextEncoder = TextEncoder;
    vm.runInContext(read('supervisor-brain-ui.js'), ctx);
    vm.runInContext(read('management-ui.js'), ctx);
  }
  vm.runInContext(read('management-gitlab-ui.js'), ctx);
  const app = vm.runInContext('new CodemanApp()', ctx) as any;
  app._apiJson = vi.fn(async () => config());
  app.showToast = vi.fn();
  dom.window.confirm = vi.fn(() => true);
  const get = (id: string) => dom.window.document.getElementById(id)! as any;
  return { app, get, dom };
}
afterEach(() => {
  for (const dom of doms.splice(0)) dom.window.close();
});

describe('Owner-global GitLab connection UI', () => {
  it('loads through the actual management lifecycle and clears credentials on the actual close path', async () => {
    const { app, get } = harness(true);
    app._apiJson.mockImplementation(async (path: string) =>
      path === '/api/management/gitlab'
        ? config()
        : {
            revision: 'b'.repeat(64),
            managerSessionId: null,
            agents: [],
            brain: { revision: 'c'.repeat(64), markdown: '', exists: false, noteCount: 0 },
          }
    );
    await app.loadManagementSettings();
    expect(app._apiJson.mock.calls).toEqual([['/api/management'], ['/api/management/gitlab']]);
    get('managementGitlabToken').value = 'private-draft';
    app.closeManagementSettings();
    expect(get('managementGitlabToken').value).toBe('');
    expect(app._managementView).toBeNull();
    expect(app._managementGitlabView).toBeNull();
  });
  it('preselects requested all-project editing only as an unsaved new-connection draft', async () => {
    const { app, get } = harness();
    app._apiJson.mockResolvedValueOnce({ ...config(), url: '', projectIds: [], credentialConfigured: false });
    await app.loadManagementSettings();
    expect(get('managementGitlabAllProjects').checked).toBe(true);
    expect(get('managementGitlabAllowWrite').checked).toBe(true);
    expect(get('managementGitlabStatus').textContent).toContain('Not connected');
    expect(get('managementGitlabCheck').disabled).toBe(true);
    expect(app._apiJson.mock.calls).toEqual([['/api/management/gitlab']]);
  });
  it('preserves configured restrictions and omits a blank token when saving', async () => {
    const { app, get } = harness();
    await app.loadManagementSettings();
    expect(get('managementGitlabAllProjects').checked).toBe(false);
    expect(get('managementGitlabAllowWrite').checked).toBe(false);
    get('managementGitlabProjects').value = '12, 34';
    app._apiJson.mockResolvedValueOnce({ ...config(), revision: 'b'.repeat(64), projectIds: [12, 34] });
    await app.saveManagementGitlab();
    expect(app._apiJson.mock.calls[1]).toEqual([
      '/api/management/gitlab',
      {
        method: 'PUT',
        body: {
          ifMatch: 'a'.repeat(64),
          url: 'https://gitlab.example.test',
          allowInsecureHttp: false,
          projectIds: [12, 34],
          allowAllProjects: false,
          allowWrite: false,
          writeBranchPrefix: 'codeman/',
        },
      },
    ]);
    expect(get('managementGitlabToken').value).toBe('');
    expect(get('managementGitlabStatus').textContent).toContain('No repository write');
  });
  it('requires explicit HTTP consent and preserves it in saved configuration', async () => {
    const { app, get } = harness();
    await app.loadManagementSettings();
    get('managementGitlabUrl').value = 'http://gitlab.example.test';
    await app.saveManagementGitlab();
    expect(app._apiJson).toHaveBeenCalledTimes(1);
    get('managementGitlabInsecureHttp').checked = true;
    app._apiJson.mockResolvedValueOnce({ ...config(), url: 'http://gitlab.example.test', allowInsecureHttp: true });
    await app.saveManagementGitlab();
    expect(app._apiJson.mock.calls.at(-1)[1].body).toMatchObject({
      url: 'http://gitlab.example.test',
      allowInsecureHttp: true,
    });
  });
  it('requires an explicit saved grant and clears a replacement token after confirmation', async () => {
    const { app, get, dom } = harness();
    const storage = vi.spyOn(dom.window.Storage.prototype, 'setItem');
    await app.loadManagementSettings();
    get('managementGitlabToken').value = 'fixture-private-token';
    get('managementGitlabAllProjects').checked = true;
    get('managementGitlabAllowWrite').checked = true;
    app._apiJson.mockResolvedValueOnce({
      ...config(),
      allowAllProjects: true,
      allowWrite: true,
      revision: 'b'.repeat(64),
    });
    await app.saveManagementGitlab();
    expect(app._apiJson.mock.calls[1][1].body).toMatchObject({
      token: 'fixture-private-token',
      allowAllProjects: true,
      allowWrite: true,
    });
    expect(get('managementGitlabToken').value).toBe('');
    expect(storage).not.toHaveBeenCalled();
    expect(app.showToast).not.toHaveBeenCalled();
    expect(get('managementGitlabPanel').textContent).not.toContain('fixture-private-token');
  });
  it('retains private drafts on conflict, blocks replay and clears the token when settings close', async () => {
    const { app, get } = harness();
    await app.loadManagementSettings();
    get('managementGitlabToken').value = 'fixture-private-token';
    app._apiJson.mockResolvedValueOnce(null);
    await app.saveManagementGitlab();
    expect(get('managementGitlabToken').value).toBe('fixture-private-token');
    expect(get('managementGitlabSettings').disabled).toBe(true);
    await app.saveManagementGitlab();
    expect(app._apiJson).toHaveBeenCalledTimes(2);
    expect(get('managementGitlabStatus').textContent).not.toContain('fixture-private-token');
    app.closeManagementSettings();
    expect(get('managementGitlabToken').value).toBe('');
    expect(app._managementGitlabView).toBeNull();
  });
  it('clears a saved credential only with the explicit clear checkbox', async () => {
    const { app, get, dom } = harness();
    await app.loadManagementSettings();
    get('managementGitlabToken').value = 'discard-this-draft';
    get('managementGitlabClearToken').checked = true;
    get('managementGitlabClearToken').dispatchEvent(new dom.window.Event('change'));
    expect(get('managementGitlabToken').value).toBe('');
    expect(get('managementGitlabToken').disabled).toBe(true);
    app._apiJson.mockResolvedValueOnce({ ...config(), credentialConfigured: false });
    await app.saveManagementGitlab();
    expect(app._apiJson.mock.calls[1][1].body.token).toBe('');
    expect(get('managementGitlabStatus').textContent).toContain('no GitLab access');
  });
  it.each([
    'http://gitlab.example.test',
    'https://user:secret@gitlab.example.test',
    'https://gitlab.example.test/api',
    'https://gitlab.example.test?token=secret',
  ])('refuses a non-origin URL without posting or echoing it: %s', async (url) => {
    const { app, get } = harness();
    await app.loadManagementSettings();
    get('managementGitlabUrl').value = url;
    await app.saveManagementGitlab();
    expect(app._apiJson).toHaveBeenCalledTimes(1);
    expect(app.showToast.mock.calls[0][0]).not.toContain('secret');
  });
  it('checks the saved credential read only and refuses a check of unsaved changes', async () => {
    const { app, get } = harness();
    await app.loadManagementSettings();
    get('managementGitlabAllowWrite').checked = true;
    await app.checkManagementGitlab();
    expect(app._apiJson).toHaveBeenCalledTimes(1);
    expect(get('managementGitlabStatus').textContent).toContain('Save or discard');
    get('managementGitlabAllowWrite').checked = false;
    app._apiJson.mockResolvedValueOnce({
      available: true,
      projectCount: 1,
      allowWrite: false,
      writeBranchPrefix: 'codeman/',
    });
    await app.checkManagementGitlab();
    expect(app._apiJson.mock.calls[1]).toEqual(['/api/management/gitlab/check', { method: 'POST', body: {} }]);
    expect(get('managementGitlabStatus').textContent).toContain('No write was performed');
  });
  it('ignores a late credential check after settings close', async () => {
    const { app, get } = harness();
    await app.loadManagementSettings();
    let finish!: (value: unknown) => void;
    app._apiJson.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const pending = app.checkManagementGitlab();
    app.closeManagementSettings();
    finish({ available: true, projectCount: 1 });
    await pending;
    expect(get('managementGitlabStatus').textContent).not.toContain('succeeded');
    expect(get('managementGitlabSettings').disabled).toBe(true);
  });
});
