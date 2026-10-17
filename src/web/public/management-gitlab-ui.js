/** Owner-configured GitLab access. Credentials remain in a private input until saved or closed. */
function managementGitlabOrigin(value, allowInsecureHttp = false) {
  if (!value) return '';
  const url = new URL(value);
  if (
    (url.protocol !== 'https:' && !(allowInsecureHttp && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('invalid-origin');
  return url.origin;
}
function managementGitlabSnapshot(value) {
  if (
    !value ||
    typeof value.revision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.revision) ||
    typeof value.url !== 'string' ||
    !Array.isArray(value.projectIds) ||
    value.projectIds.length > 100 ||
    !value.projectIds.every((id) => Number.isSafeInteger(id) && id > 0) ||
    new Set(value.projectIds).size !== value.projectIds.length ||
    typeof value.allowWrite !== 'boolean' ||
    typeof value.allowAllProjects !== 'boolean' ||
    value.writeBranchPrefix !== 'codeman/' ||
    typeof value.credentialConfigured !== 'boolean' ||
    'token' in value
  )
    return false;
  try {
    return managementGitlabOrigin(value.url, value.allowInsecureHttp === true) === value.url;
  } catch {
    return false;
  }
}
function managementGitlabProjectIds(value) {
  if (!value.trim()) return [];
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length > 100 || parts.some((part) => !/^[1-9][0-9]*$/.test(part))) throw new Error('invalid-projects');
  const ids = parts.map(Number);
  if (ids.some((id) => !Number.isSafeInteger(id)) || new Set(ids).size !== ids.length)
    throw new Error('invalid-projects');
  return ids;
}
function managementGitlabNode(tag, text, id) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (id) node.id = id;
  return node;
}
const managementLoadBeforeGitlab = CodemanApp.prototype.loadManagementSettings;
const managementCloseBeforeGitlab = CodemanApp.prototype.closeManagementSettings;
Object.assign(CodemanApp.prototype, {
  _ensureManagementGitlabPanel() {
    if (document.getElementById('managementGitlabPanel')) return;
    const panel = managementGitlabNode('div', undefined, 'managementGitlabPanel');
    panel.className = 'set-group task-form';
    panel.append(managementGitlabNode('h4', 'GitLab access for the management Codex'));
    panel.append(
      managementGitlabNode(
        'p',
        'Connect a GitLab credential privately here. The manager can read selected projects, or all projects this credential can access when you explicitly allow it. Feature-branch editing is a separate saved owner grant.'
      )
    );
    panel.append(
      managementGitlabNode(
        'p',
        'Edits are restricted to codeman/ feature branches. The manager cannot force-push, delete branches or merge through this connection. Your token stays on the server and is never revealed to the manager.'
      )
    );
    const status = managementGitlabNode('p', 'Loading GitLab connection…', 'managementGitlabStatus');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    panel.append(status);
    const fields = managementGitlabNode('fieldset', undefined, 'managementGitlabSettings');
    fields.className = 'task-form';
    fields.disabled = true;
    fields.append(managementGitlabNode('legend', 'Owner GitLab connection'));
    const input = (id, label, type, maxlength) => {
      const holder = managementGitlabNode('label', label);
      holder.htmlFor = id;
      const control = managementGitlabNode('input', undefined, id);
      control.type = type;
      control.className = 'set-input';
      if (maxlength) control.maxLength = maxlength;
      holder.append(control);
      fields.append(holder);
      return control;
    };
    input('managementGitlabUrl', 'GitLab origin', 'url', 2048).placeholder = 'https://gitlab.example.com';
    input('managementGitlabAllProjects', 'All projects accessible to this credential', 'checkbox');
    input('managementGitlabProjects', 'Project IDs (comma separated; used when All projects is off)', 'text', 2000);
    input('managementGitlabAllowWrite', 'Allow management Codex to edit codeman/ feature branches', 'checkbox');
    input(
      'managementGitlabInsecureHttp',
      'Allow HTTP: the GitLab token and repository content travel unencrypted',
      'checkbox'
    );
    const token = input(
      'managementGitlabToken',
      'Private GitLab access token (blank keeps it only for the same origin)',
      'password',
      4096
    );
    token.autocomplete = 'new-password';
    token.spellcheck = false;
    const clear = input('managementGitlabClearToken', 'Clear the saved credential when saving', 'checkbox');
    clear.addEventListener('change', () => {
      if (clear.checked) token.value = '';
      token.disabled = clear.checked;
    });
    const button = (text, action, parent, id) => {
      const node = managementGitlabNode('button', text, id);
      node.type = 'button';
      node.className = 'btn-toolbar';
      node.addEventListener('click', () => void action());
      parent.append(node);
      return node;
    };
    button('Save GitLab connection', () => this.saveManagementGitlab(), fields);
    panel.append(fields);
    const actions = managementGitlabNode('div');
    actions.className = 'task-actions';
    button(
      'Check saved GitLab access (read only)',
      () => this.checkManagementGitlab(),
      actions,
      'managementGitlabCheck'
    );
    button('Refresh GitLab connection', () => this.loadManagementGitlab(true), actions);
    button(
      'Archive finished write receipts',
      () => this.archiveManagementGitlabReceipts(),
      actions,
      'managementGitlabArchive'
    );
    panel.append(actions);
    document.getElementById('settings-management').append(panel);
  },
  closeManagementGitlab() {
    this._managementGitlabView = null;
    const token = document.getElementById('managementGitlabToken');
    if (token) token.value = '';
    const clear = document.getElementById('managementGitlabClearToken');
    if (clear) clear.checked = false;
    const fields = document.getElementById('managementGitlabSettings');
    if (fields) fields.disabled = true;
    const check = document.getElementById('managementGitlabCheck');
    if (check) check.disabled = true;
    const archive = document.getElementById('managementGitlabArchive');
    if (archive) archive.disabled = true;
  },
  _renderManagementGitlabBusy(view) {
    const archive = document.getElementById('managementGitlabArchive');
    if (archive) archive.disabled = !view?.config || !!view.busy || !(view.config.writeReceipts?.finalized > 0);
    document.getElementById('managementGitlabSettings').disabled = !view?.config || !!view.busy;
    document.getElementById('managementGitlabCheck').disabled = !view?.config?.credentialConfigured || !!view.busy;
  },
  _fillManagementGitlab(config) {
    const pristine =
      !config.credentialConfigured &&
      !config.url &&
      !config.projectIds.length &&
      !config.allowAllProjects &&
      !config.allowWrite;
    document.getElementById('managementGitlabUrl').value = config.url;
    document.getElementById('managementGitlabInsecureHttp').checked = config.allowInsecureHttp === true;
    document.getElementById('managementGitlabProjects').value = config.projectIds.join(', ');
    // Requested defaults are only a draft. Saving remains an explicit owner action.
    document.getElementById('managementGitlabAllProjects').checked = config.allowAllProjects || pristine;
    document.getElementById('managementGitlabAllowWrite').checked = config.allowWrite || pristine;
    document.getElementById('managementGitlabToken').value = '';
    document.getElementById('managementGitlabToken').disabled = false;
    document.getElementById('managementGitlabClearToken').checked = false;
  },
  async loadManagementGitlab(force = false) {
    if (!this._managementView?.snapshot) return;
    this._ensureManagementGitlabPanel();
    if (this._managementGitlabView && !force) return;
    if (
      force &&
      !window.confirm(
        'Refresh GitLab settings and discard unsaved connection changes, including any private token draft?'
      )
    )
      return;
    this.closeManagementGitlab();
    const view = { ownerView: this._managementView, config: null, busy: true };
    this._managementGitlabView = view;
    this._renderManagementGitlabBusy(view);
    document.getElementById('managementGitlabStatus').textContent = 'Loading GitLab connection…';
    let config;
    try {
      config = await this._apiJson('/api/management/gitlab');
    } catch {
      config = null;
    }
    if (this._managementGitlabView !== view || this._managementView !== view.ownerView) return;
    view.busy = false;
    view.config = managementGitlabSnapshot(config) ? config : null;
    if (view.config) this._fillManagementGitlab(view.config);
    document.getElementById('managementGitlabStatus').textContent = !view.config
      ? 'GitLab connection unavailable. Refresh before editing.'
      : view.config.credentialConfigured
        ? 'Credential saved. Access has not been checked in this view.'
        : 'Not connected. No credential is saved; the manager has no GitLab access through this connection. Review the draft grants and save your credential to connect.';
    this._renderManagementGitlabBusy(view);
  },
  _managementGitlabDraft() {
    const allowInsecureHttp = document.getElementById('managementGitlabInsecureHttp').checked;
    const url = managementGitlabOrigin(document.getElementById('managementGitlabUrl').value.trim(), allowInsecureHttp);
    const projectIds = managementGitlabProjectIds(document.getElementById('managementGitlabProjects').value);
    const allowAllProjects = document.getElementById('managementGitlabAllProjects').checked;
    const allowWrite = document.getElementById('managementGitlabAllowWrite').checked;
    const token = document.getElementById('managementGitlabToken').value.trim();
    if (token.length > 4096 || /[^\x21-\x7e]/.test(token)) throw new Error('invalid-token');
    const clear = document.getElementById('managementGitlabClearToken').checked;
    return {
      url,
      allowInsecureHttp,
      projectIds,
      allowAllProjects,
      allowWrite,
      writeBranchPrefix: 'codeman/',
      ...(clear ? { token: '' } : token ? { token } : {}),
    };
  },
  async archiveManagementGitlabReceipts() {
    const view = this._managementGitlabView;
    if (!view?.config || view.busy || this._managementView !== view.ownerView) return;
    const count = view.config.writeReceipts?.finalized;
    if (!Number.isSafeInteger(count) || count <= 0) return;
    if (
      !window.confirm(
        `Archive ${count} finished GitLab write receipts to free active slots? Uncertain receipts stay active. Archived request IDs remain sealed against replay. No GitLab request will be sent.`
      )
    )
      return;
    view.busy = true;
    this._renderManagementGitlabBusy(view);
    let result;
    try {
      result = await this._apiJson('/api/management/gitlab/receipts/archive', {
        method: 'POST',
        body: { ifMatch: view.config.revision, confirmArchiveFinalized: true },
      });
    } catch {
      result = null;
    }
    if (this._managementGitlabView !== view || this._managementView !== view.ownerView) return;
    view.busy = false;
    if (!managementGitlabSnapshot(result?.config)) {
      view.config = null;
      document.getElementById('managementGitlabStatus').textContent =
        'Archive was not confirmed. Refresh and reconcile before trying again; replay fences were retained.';
    } else {
      view.config = result.config;
      document.getElementById('managementGitlabStatus').textContent =
        `Archived ${result.archived} finished receipts. Uncertain operations and archived request IDs remain sealed. No GitLab request was sent.`;
    }
    this._renderManagementGitlabBusy(view);
  },
  async saveManagementGitlab() {
    const view = this._managementGitlabView;
    if (!view?.config || view.busy || this._managementView !== view.ownerView) return;
    let draft;
    try {
      draft = this._managementGitlabDraft();
    } catch {
      this.showToast(
        'Enter an HTTPS origin (or explicitly allow unencrypted HTTP), up to 100 unique positive project IDs and a printable token of at most 4,096 characters.',
        'warning'
      );
      return;
    }
    view.busy = true;
    this._renderManagementGitlabBusy(view);
    let config;
    try {
      config = await this._apiJson('/api/management/gitlab', {
        method: 'PUT',
        body: { ifMatch: view.config.revision, ...draft },
      });
    } catch {
      config = null;
    }
    if (this._managementGitlabView !== view || this._managementView !== view.ownerView) return;
    view.busy = false;
    if (!managementGitlabSnapshot(config)) {
      view.config = null;
      document.getElementById('managementGitlabStatus').textContent =
        'Save was not confirmed or the connection changed. Your private draft is retained until you close or refresh settings. Refresh and reconcile before saving again.';
    } else {
      view.config = config;
      this._fillManagementGitlab(config);
      document.getElementById('managementGitlabStatus').textContent = config.credentialConfigured
        ? 'GitLab connection saved. Use the read-only check to verify access. No repository write was performed.'
        : 'Credential cleared or absent. The manager has no GitLab access through this connection.';
    }
    this._renderManagementGitlabBusy(view);
  },
  async checkManagementGitlab() {
    const view = this._managementGitlabView;
    if (!view?.config?.credentialConfigured || view.busy || this._managementView !== view.ownerView) return;
    let draft;
    try {
      draft = this._managementGitlabDraft();
    } catch {
      draft = null;
    }
    const saved = view.config;
    if (
      !draft ||
      'token' in draft ||
      draft.url !== saved.url ||
      draft.allowInsecureHttp !== (saved.allowInsecureHttp === true) ||
      draft.allowWrite !== saved.allowWrite ||
      draft.allowAllProjects !== saved.allowAllProjects ||
      JSON.stringify(draft.projectIds) !== JSON.stringify(saved.projectIds)
    ) {
      document.getElementById('managementGitlabStatus').textContent =
        'Save or discard your changes before checking the saved GitLab connection.';
      return;
    }
    view.busy = true;
    this._renderManagementGitlabBusy(view);
    let result;
    try {
      result = await this._apiJson('/api/management/gitlab/check', { method: 'POST', body: {} });
    } catch {
      result = null;
    }
    if (this._managementGitlabView !== view || this._managementView !== view.ownerView) return;
    view.busy = false;
    document.getElementById('managementGitlabStatus').textContent =
      result?.available === true && Number.isSafeInteger(result.projectCount) && result.projectCount >= 0
        ? `Read-only access check succeeded for ${result.projectCount} projects. Feature-branch editing is ${saved.allowWrite ? 'enabled by your saved grant' : 'disabled'}. No write was performed.`
        : 'Access could not be verified. Check the saved URL, credential and project permissions. No write was performed.';
    this._renderManagementGitlabBusy(view);
  },
  async loadManagementSettings(...args) {
    await managementLoadBeforeGitlab.apply(this, args);
    if (this._managementView?.snapshot) await this.loadManagementGitlab();
  },
  closeManagementSettings(...args) {
    this.closeManagementGitlab();
    return managementCloseBeforeGitlab.apply(this, args);
  },
});
