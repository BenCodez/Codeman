/** Real management markup and preview/confirmation controls; synthetic GitLab only. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
const root = resolve(import.meta.dirname, '../src/web/public');
const read = (name: string) => readFileSync(resolve(root, name), 'utf8');
const doms: JSDOM[] = [];
const config = {
  revision: 'a'.repeat(64),
  enabled: true,
  autoPublish: false,
  projectId: 42,
  branch: 'codeman/brain',
  path: 'brain.md',
  status: 'pending',
  baseline: null,
};
const preview = {
  status: 'different',
  local: { revision: 'b'.repeat(64), markdown: '# Local owner teaching' },
  remote: {
    lastCommitId: 'c'.repeat(40),
    hash: 'd'.repeat(64),
    markdown: '<img src=x onerror=alert(1)> Proposed notes',
  },
  target: { projectId: 42, branch: 'codeman/brain', path: 'brain.md' },
};
function harness() {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', url: 'https://codeman.example/' });
  doms.push(dom);
  const context = dom.getInternalVMContext();
  vm.runInContext(
    'class CodemanApp {}; CodemanApp.prototype.loadManagementSettings = async function() {}; CodemanApp.prototype.closeManagementSettings = function() {}; function managementRequestId() { return "11111111-1111-4111-8111-111111111111"; }',
    context
  );
  vm.runInContext(read('management-brain-sync-ui.js'), context);
  const app = vm.runInContext('new CodemanApp()', context) as any;
  app._managementView = { snapshot: {} };
  app._apiJson = vi.fn(async () => config);
  app.showToast = vi.fn();
  dom.window.confirm = vi.fn(() => true);
  const get = (id: string) => dom.window.document.getElementById(id)! as any;
  return { app, dom, get };
}
afterEach(() => {
  for (const dom of doms.splice(0)) dom.window.close();
});
it('loads owner destination without writing or publishing anything', async () => {
  const { app, get } = harness();
  await app.loadManagementBrainSync();
  expect(app._apiJson.mock.calls).toEqual([['/api/management/brain-sync']]);
  expect(get('managementBrainSyncProject').value).toBe('42');
  expect(get('managementBrainSyncPublish').disabled).toBe(true);
});
it('shows remote suggestions as plain text and binds publish to exact preview hashes', async () => {
  const { app, get } = harness();
  await app.loadManagementBrainSync();
  app._apiJson.mockResolvedValueOnce(preview);
  await app.previewManagementBrainSync();
  expect(get('managementBrainSyncContent').querySelector('img')).toBeNull();
  expect(get('managementBrainSyncContent').textContent).toContain('untrusted suggestions');
  app._apiJson.mockResolvedValueOnce({ status: 'synced' });
  await app.applyManagementBrainSync('publish');
  expect(app._apiJson.mock.calls.at(-1)).toEqual([
    '/api/management/brain-sync/publish',
    {
      method: 'POST',
      body: {
        requestId: expect.any(String),
        localRevision: preview.local.revision,
        remoteLastCommitId: preview.remote.lastCommitId,
        remoteHash: preview.remote.hash,
      },
    },
  ]);
  expect(get('managementBrainSyncStatus').textContent).toContain('synced and verified');
});
it('does not publish or pull when confirmation is dismissed', async () => {
  const { app, dom } = harness();
  await app.loadManagementBrainSync();
  app._apiJson.mockResolvedValueOnce(preview);
  await app.previewManagementBrainSync();
  dom.window.confirm = vi.fn(() => false);
  await app.applyManagementBrainSync('publish');
  await app.applyManagementBrainSync('pull');
  expect(app._apiJson).toHaveBeenCalledTimes(2);
});
it('seals an uncertain sync without retrying on another click', async () => {
  const { app, get } = harness();
  await app.loadManagementBrainSync();
  app._apiJson.mockResolvedValueOnce(preview);
  await app.previewManagementBrainSync();
  app._apiJson.mockResolvedValueOnce(null);
  await app.applyManagementBrainSync('publish');
  await app.applyManagementBrainSync('publish');
  expect(app._apiJson).toHaveBeenCalledTimes(3);
  expect(get('managementBrainSyncPublish').disabled).toBe(true);
  expect(get('managementBrainSyncStatus').textContent).toContain('uncertain');
});
it('requires a matching destination before enabling an import', async () => {
  const { app, get } = harness();
  await app.loadManagementBrainSync();
  app._apiJson.mockResolvedValueOnce({ ...preview, target: { ...preview.target, projectId: 99 } });
  await app.previewManagementBrainSync();
  await app.applyManagementBrainSync('pull');
  expect(get('managementBrainSyncPull').disabled).toBe(true);
  expect(app._apiJson).toHaveBeenCalledTimes(2);
});
it('clears previewed private memory on close and ignores a late preview', async () => {
  const { app, get } = harness();
  await app.loadManagementBrainSync();
  let finish!: (value: unknown) => void;
  app._apiJson.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const pending = app.previewManagementBrainSync();
  app.closeManagementSettings();
  finish(preview);
  await pending;
  expect(get('managementBrainSyncContent').textContent).toBe('');
  expect(get('managementBrainSyncPublish').disabled).toBe(true);
});
