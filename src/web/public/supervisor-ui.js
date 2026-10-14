/**
 * @fileoverview Owner-facing configuration for the optional Codex manager role.
 * @mixin Extends CodemanApp.prototype with guarded supervisor controls.
 * @dependency app.js, recovery-ui.js, session-ui.js, api-client.js
 * @loadorder 8.2 of 16, after recovery-ui.js and supervision-ui.js, before session-ui.js
 */
const SUPERVISOR_UI_PHASES = Object.freeze({
  disabled: 'Off',
  ready: 'Ready',
  active: 'Active',
  paused: 'Paused',
  blocked: 'Blocked',
});
const SUPERVISOR_UI_REASONS = Object.freeze({
  disabled: 'Supervisor is off',
  configured: 'Supervisor configuration saved',
  'manager-start-reserved': 'Manager start reserved',
  'manager-start-uncertain': 'Manager start is uncertain; owner reset required',
  'manager-start-refused': 'Manager conversation is not ready; run one normal turn first',
  'owner-started': 'Manager started',
  'owner-paused': 'Paused by owner',
  'owner-reset': 'Supervisor reset and disabled',
  'restart-in-flight': 'Unresolved operation after restart; owner reset required',
  'restart-requires-resume': 'Owner start required after restart',
  'persistence-failed': 'Supervisor journal write failed',
});
function supervisorUiTranslate(text) {
  return window.CodemanI18n?.t(text) ?? text;
}
Object.assign(CodemanApp.prototype, {
  openSupervisorOptions(sessionId) {
    this.closeSupervisorOptions();
    const session = this.sessions.get(sessionId);
    const supported = this.supportsSessionRecovery?.(session) === true;
    const rail = document.querySelector('#sessionOptionsModal [data-tab="supervisor"]');
    if (rail) rail.style.display = supported ? '' : 'none';
    if (!supported) return false;
    this._supervisorView = { sessionId, state: null, workerStatus: [], busy: false, workersBusy: false };
    void this.loadSupervisorStatus();
    return true;
  },
  closeSupervisorOptions() {
    this._supervisorView = null;
    document.getElementById('supervisorWorkerStatus')?.replaceChildren();
  },
  async loadSupervisorStatus() {
    const view = this._supervisorView;
    if (!view || view.busy) return;
    view.busy = true;
    const state = await this._apiJson(`/api/sessions/${encodeURIComponent(view.sessionId)}/supervisor`);
    if (this._supervisorView !== view) return;
    view.busy = false;
    view.state = state?.version === 1 ? state : null;
    this._renderSupervisorStatus(true);
    if (view.state?.phase === 'active') await this.loadSupervisorWorkers();
  },
  _renderSupervisorStatus(force = false) {
    const view = this._supervisorView;
    const state = view?.state;
    const available = !!state && !view.busy;
    document.getElementById('supervisorError').hidden = !!state || !!view?.busy;
    document.getElementById('supervisorPhase').textContent = supervisorUiTranslate(
      SUPERVISOR_UI_PHASES[state?.phase] ?? 'Unavailable'
    );
    document.getElementById('supervisorReason').textContent = supervisorUiTranslate(
      SUPERVISOR_UI_REASONS[state?.reason] ?? state?.reason ?? '—'
    );
    document.getElementById('supervisorSettings').disabled = !available;
    document.getElementById('supervisorStartBtn').disabled =
      !available ||
      !state.enabled ||
      !state.objective ||
      !state.workers.length ||
      state.phase === 'active' ||
      !!state.inFlight;
    document.getElementById('supervisorPauseBtn').disabled = !available || state.phase !== 'active';
    document.getElementById('supervisorResetBtn').disabled = !available;
    if (force && state) {
      document.getElementById('supervisorObjective').value = state.objective;
      document.getElementById('supervisorEnabled').checked = state.enabled;
      document.getElementById('supervisorWorkers').value = JSON.stringify(
        state.workers.map(({ sessionId, task, criteria, maxAssignments, maxRuntimeMs }) => ({
          sessionId,
          task,
          criteria,
          maxAssignments,
          maxRuntimeMs,
        })),
        null,
        2
      );
    }
    const inspections = new Map((view?.workerStatus ?? []).map((worker) => [worker.sessionId, worker]));
    const list = document.getElementById('supervisorWorkerStatus');
    list.replaceChildren();
    for (const worker of state?.workers ?? []) {
      const row = document.createElement('li');
      row.dataset.i18nSkip = '';
      const inspection = inspections.get(worker.sessionId);
      const evidence = document.createElement('span');
      evidence.textContent = `${worker.sessionId.slice(0, 8)} — ${worker.assignments}/${worker.maxAssignments} assignments — ${inspection?.health ?? 'not inspected'}${inspection?.stale ? ' (stale)' : ''}${inspection?.task?.phase ? ` — task ${inspection.task.phase}` : ''}`;
      row.appendChild(evidence);
      const assign = document.createElement('button');
      assign.className = 'btn-toolbar btn-sm';
      assign.textContent = 'Assign task';
      assign.disabled = state.phase !== 'active' || !!view.workersBusy;
      assign.addEventListener('click', () => void this.supervisorWorkerAction(worker.sessionId, 'assign'));
      row.appendChild(assign);
      const retry = document.createElement('button');
      retry.className = 'btn-toolbar btn-sm';
      retry.textContent = 'Retry crash';
      retry.disabled =
        state.phase !== 'active' ||
        !!view.workersBusy ||
        !['dead-pane', 'interrupted'].includes(inspection?.health ?? '');
      retry.addEventListener('click', () => void this.supervisorWorkerAction(worker.sessionId, 'retry'));
      row.appendChild(retry);
      list.appendChild(row);
    }
  },
  async loadSupervisorWorkers() {
    const view = this._supervisorView;
    if (!view || view.workersBusy || view.state?.phase !== 'active') return;
    view.workersBusy = true;
    this._renderSupervisorStatus();
    const workers = await this._apiJson(`/api/sessions/${encodeURIComponent(view.sessionId)}/supervisor/workers`, {
      headers: { 'X-Codeman-Supervisor-Session': view.sessionId },
    });
    if (this._supervisorView !== view) return;
    view.workersBusy = false;
    view.workerStatus = Array.isArray(workers) ? workers : [];
    this._renderSupervisorStatus();
  },
  async supervisorWorkerAction(workerId, action) {
    const view = this._supervisorView;
    if (!view || view.workersBusy || !['assign', 'retry'].includes(action)) return;
    view.workersBusy = true;
    this._renderSupervisorStatus();
    const requestId = globalThis.crypto?.randomUUID?.() ?? `owner-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const state = await this._apiJson(
      `/api/sessions/${encodeURIComponent(view.sessionId)}/supervisor/workers/${encodeURIComponent(workerId)}/${action}`,
      {
        method: 'POST',
        headers: { 'X-Codeman-Supervisor-Session': view.sessionId },
        body: { requestId },
      }
    );
    if (this._supervisorView !== view) return;
    view.workersBusy = false;
    if (state?.version === 1) view.state = state;
    else this.showToast(supervisorUiTranslate('Worker action was refused or its delivery is uncertain.'), 'error');
    this._renderSupervisorStatus(true);
    if (view.state?.phase === 'active') await this.loadSupervisorWorkers();
  },
  async saveSupervisorConfiguration() {
    const view = this._supervisorView;
    if (!view?.state || view.busy) return;
    let workers;
    try {
      workers = JSON.parse(document.getElementById('supervisorWorkers').value);
    } catch {
      workers = null;
    }
    if (!Array.isArray(workers)) {
      this.showToast(supervisorUiTranslate('Worker configuration must be a JSON array'), 'warning');
      return;
    }
    await this._performSupervisorRequest('', 'PUT', {
      objective: document.getElementById('supervisorObjective').value.trim(),
      enabled: document.getElementById('supervisorEnabled').checked,
      workers,
    });
  },
  async supervisorAction(action) {
    if (!['start', 'pause', 'reset'].includes(action)) return;
    await this._performSupervisorRequest(`/${action}`, 'POST');
  },
  async _performSupervisorRequest(path, method, body) {
    const view = this._supervisorView;
    if (!view || view.busy) return;
    view.busy = true;
    this._renderSupervisorStatus();
    const state = await this._apiJson(`/api/sessions/${encodeURIComponent(view.sessionId)}/supervisor${path}`, {
      method,
      ...(body === undefined ? {} : { body }),
    });
    if (this._supervisorView !== view) return;
    view.busy = false;
    view.state = state?.version === 1 ? state : null;
    if (!view.state)
      this.showToast(supervisorUiTranslate('Supervisor action failed. Refresh status before trying again.'), 'error');
    this._renderSupervisorStatus(true);
    if (view.state?.phase === 'active') await this.loadSupervisorWorkers();
  },
});
