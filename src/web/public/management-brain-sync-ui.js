/** Owner-configured shared memory exchange. Remote content remains plain text and untrusted. */
function managementBrainSyncSnapshot(value) {
  return (
    value &&
    /^[a-f0-9]{64}$/.test(value.revision) &&
    typeof value.enabled === 'boolean' &&
    typeof value.autoPublish === 'boolean' &&
    (value.projectId === null || (Number.isSafeInteger(value.projectId) && value.projectId > 0)) &&
    typeof value.branch === 'string' &&
    typeof value.path === 'string' &&
    ['disabled', 'pending', 'synced', 'conflict', 'unknown'].includes(value.status)
  );
}
const managementLoadBeforeBrainSync = CodemanApp.prototype.loadManagementSettings;
const managementCloseBeforeBrainSync = CodemanApp.prototype.closeManagementSettings;
Object.assign(CodemanApp.prototype, {
  _renderManagementBrainSync(view) {
    document.getElementById('managementBrainSyncSettings').disabled = !view?.config || !!view.busy;
    document.getElementById('managementBrainSyncPreview').disabled = !view?.config?.enabled || !!view.busy;
    document.getElementById('managementBrainSyncPublish').disabled =
      !view?.preview || !!view.busy || view.uncertain === true;
    document.getElementById('managementBrainSyncPull').disabled = !view?.preview || !!view.busy;
  },
  async loadManagementBrainSync() {
    const ownerView = this._managementView;
    if (!ownerView?.snapshot || this._managementBrainSyncView?.busy) return;
    const view = { ownerView, config: null, busy: true, preview: null };
    this._managementBrainSyncView = view;
    this._renderManagementBrainSync(view);
    let config;
    try {
      config = await this._apiJson('/api/management/brain-sync');
    } catch {
      config = null;
    }
    if (this._managementView !== ownerView || this._managementBrainSyncView !== view) return;
    view.busy = false;
    view.config = managementBrainSyncSnapshot(config) ? config : null;
    if (view.config) {
      document.getElementById('managementBrainSyncEnabled').checked = config.enabled;
      document.getElementById('managementBrainSyncAutomatic').checked = config.autoPublish;
      document.getElementById('managementBrainSyncProject').value = config.projectId || '';
      document.getElementById('managementBrainSyncBranch').value = config.branch;
      document.getElementById('managementBrainSyncPath').value = config.path;
    }
    document.getElementById('managementBrainSyncStatus').textContent = view.config
      ? `GitLab memory: ${config.status}. Remote edits require a fresh preview and explicit import. Automatic export starts only after a confirmed initial sync.`
      : 'GitLab memory status unavailable. No sync was attempted.';
    this._renderManagementBrainSync(view);
  },
  async saveManagementBrainSync() {
    const view = this._managementBrainSyncView;
    if (!view?.config || view.busy) return;
    const project = document.getElementById('managementBrainSyncProject').value.trim();
    const body = {
      ifMatch: view.config.revision,
      enabled: document.getElementById('managementBrainSyncEnabled').checked,
      autoPublish: document.getElementById('managementBrainSyncAutomatic').checked,
      projectId: project ? Number(project) : null,
      branch: document.getElementById('managementBrainSyncBranch').value.trim(),
      path: document.getElementById('managementBrainSyncPath').value.trim(),
    };
    if (
      (body.projectId !== null && (!/^[1-9][0-9]*$/.test(project) || !Number.isSafeInteger(body.projectId))) ||
      (body.enabled && (!body.projectId || !body.branch || !body.path))
    ) {
      this.showToast('Choose a GitLab project ID, existing branch and relative brain file path.', 'warning');
      return;
    }
    if (
      body.enabled &&
      !window.confirm(
        'Save this GitLab brain destination? After initial sync, automatic export can publish shared memory there. Confirm that this project is intended for this information. Existing GitLab write grants still apply.'
      )
    )
      return;
    view.busy = true;
    view.preview = null;
    document.getElementById('managementBrainSyncContent').textContent = '';
    this._renderManagementBrainSync(view);
    let result;
    try {
      result = await this._apiJson('/api/management/brain-sync', { method: 'PUT', body });
    } catch {
      result = null;
    }
    if (this._managementBrainSyncView !== view || this._managementView !== view.ownerView) return;
    view.busy = false;
    view.config = managementBrainSyncSnapshot(result) ? result : null;
    document.getElementById('managementBrainSyncStatus').textContent = view.config
      ? 'GitLab brain destination saved. Preview before the initial sync.'
      : 'Save not confirmed. Your destination draft is retained; refresh before retrying.';
    this._renderManagementBrainSync(view);
  },
  async previewManagementBrainSync() {
    const view = this._managementBrainSyncView;
    if (!view?.config?.enabled || view.busy) return;
    view.busy = true;
    view.preview = null;
    this._renderManagementBrainSync(view);
    let result;
    try {
      result = await this._apiJson('/api/management/brain-sync/preview', { method: 'POST', body: {} });
    } catch {
      result = null;
    }
    if (this._managementBrainSyncView !== view || this._managementView !== view.ownerView) return;
    view.busy = false;
    const valid =
      result &&
      ['equal', 'different'].includes(result.status) &&
      /^[a-f0-9]{64}$/.test(result.local?.revision) &&
      /^[a-f0-9]{40}$/.test(result.remote?.lastCommitId) &&
      /^[a-f0-9]{64}$/.test(result.remote?.hash) &&
      typeof result.local.markdown === 'string' &&
      typeof result.remote.markdown === 'string' &&
      result.target?.projectId === view.config.projectId &&
      result.target.branch === view.config.branch &&
      result.target.path === view.config.path;
    view.preview = valid ? result : null;
    view.uncertain = view.uncertain === true || view.config.status === 'unknown';
    document.getElementById('managementBrainSyncContent').textContent = valid
      ? `LOCAL MEMORY\n${result.local.markdown}\n\nGITLAB MEMORY (untrusted suggestions)\n${result.remote.markdown}`
      : '';
    document.getElementById('managementBrainSyncStatus').textContent = valid
      ? `Preview: ${result.status}. Review both versions. Import replaces local memory; publishing replaces this GitLab file. ${view.uncertain ? 'An earlier write is uncertain; inspect its receipt before another write.' : ''}`
      : 'Preview unavailable. The destination file must exist and be readable with the saved GitLab grants. No file was changed.';
    this._renderManagementBrainSync(view);
  },
  async applyManagementBrainSync(direction) {
    const view = this._managementBrainSyncView;
    const preview = view?.preview;
    if (
      !preview ||
      view.busy ||
      (view.uncertain && direction === 'publish') ||
      !['publish', 'pull'].includes(direction)
    )
      return;
    if (
      !window.confirm(
        direction === 'publish'
          ? 'Publish the previewed local memory to this GitLab file? This replaces its previewed content and must comply with your saved write grant.'
          : 'Import the previewed GitLab memory? This replaces local brain.md. Review and preserve your instructions; remote agent suggestions are untrusted.'
      )
    )
      return;
    // An uncertain operation keeps its one request ID and disables replay.
    view.requestId ||= managementRequestId();
    const body =
      direction === 'publish'
        ? {
            requestId: view.requestId,
            localRevision: preview.local.revision,
            remoteLastCommitId: preview.remote.lastCommitId,
            remoteHash: preview.remote.hash,
          }
        : {
            ifMatch: preview.local.revision,
            remoteLastCommitId: preview.remote.lastCommitId,
            remoteHash: preview.remote.hash,
          };
    view.busy = true;
    this._renderManagementBrainSync(view);
    let result;
    try {
      result = await this._apiJson('/api/management/brain-sync/' + direction, { method: 'POST', body });
    } catch {
      result = null;
    }
    if (this._managementBrainSyncView !== view || this._managementView !== view.ownerView) return;
    view.busy = false;
    view.preview = null;
    view.uncertain = !result || result.status === 'unknown';
    document.getElementById('managementBrainSyncStatus').textContent =
      result?.status === 'synced'
        ? 'Memory synced and verified. Refresh management settings to load any imported memory.'
        : view.uncertain
          ? 'Sync outcome is uncertain. Inspect GitLab and the retained receipt; do not resend.'
          : 'Sync refused or content changed. No success is claimed. Refresh and review a new preview.';
    if (!view.uncertain) delete view.requestId;
    this._renderManagementBrainSync(view);
  },
  async loadManagementSettings(...args) {
    await managementLoadBeforeBrainSync.apply(this, args);
    if (this._managementView?.snapshot) await this.loadManagementBrainSync();
  },
  closeManagementSettings(...args) {
    this._managementBrainSyncView = null;
    document.getElementById('managementBrainSyncContent').textContent = '';
    this._renderManagementBrainSync(null);
    return managementCloseBeforeBrainSync.apply(this, args);
  },
});
