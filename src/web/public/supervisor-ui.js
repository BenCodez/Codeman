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
  'manager-attention-required': 'Manager task needs attention; owner Start required',
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
function supervisorUiUsageText(usage) {
  if (usage?.source !== 'codeman-session-counter-estimate' || usage.available !== true)
    return supervisorUiTranslate('Usage unavailable; provider quota unknown');
  const parts = [];
  const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
  if (positive(usage.inputTokens)) parts.push(`${usage.inputTokens.toLocaleString()} input tokens`);
  if (positive(usage.outputTokens)) parts.push(`${usage.outputTokens.toLocaleString()} output tokens`);
  if (positive(usage.costEstimate)) parts.push(`$${usage.costEstimate.toFixed(4)} cost estimate`);
  if (!parts.length) return supervisorUiTranslate('Usage unavailable; provider quota unknown');
  return `${parts.join(', ')} — counter estimate; age unknown; provider quota unknown`;
}
const SUPERVISOR_UI_REQUEST_STORAGE = 'codeman:supervisorWorkerRequests:v1';
function supervisorUiRequestLedger() {
  const raw = sessionStorage.getItem(SUPERVISOR_UI_REQUEST_STORAGE);
  if (raw === null) return [];
  const records = JSON.parse(raw);
  if (!Array.isArray(records) || records.length > 64) throw new Error('Invalid request ledger');
  const keys = new Set();
  for (const record of records) {
    if (
      !record ||
      !['sessionId', 'workerId'].every(
        (key) => typeof record[key] === 'string' && /^[\w-]{8,100}$/.test(record[key])
      ) ||
      typeof record.requestId !== 'string' ||
      !/^[\w:.-]{8,120}$/.test(record.requestId) ||
      !['assign', 'retry'].includes(record.action)
    )
      throw new Error('Invalid request ledger');
    const key = JSON.stringify([record.sessionId, record.workerId, record.action]);
    if (keys.has(key)) throw new Error('Conflicting request ledger');
    keys.add(key);
  }
  return records;
}
function supervisorUiRequestId(sessionId, workerId, action) {
  if (![sessionId, workerId].every((id) => typeof id === 'string' && /^[\w-]{8,100}$/.test(id)))
    throw new Error('Invalid request identity');
  const records = supervisorUiRequestLedger();
  const existing = records.find(
    (record) => record.sessionId === sessionId && record.workerId === workerId && record.action === action
  );
  if (existing) return existing.requestId;
  if (records.length >= 64) throw new Error('Pending request capacity reached');
  const requestId = globalThis.crypto?.randomUUID?.() ?? `owner-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  records.push({ sessionId, workerId, action, requestId });
  sessionStorage.setItem(SUPERVISOR_UI_REQUEST_STORAGE, JSON.stringify(records));
  return requestId;
}
function supervisorUiCompleteRequest(sessionId, workerId, action, requestId) {
  const records = supervisorUiRequestLedger();
  sessionStorage.setItem(
    SUPERVISOR_UI_REQUEST_STORAGE,
    JSON.stringify(
      records.filter(
        (record) =>
          !(
            record.sessionId === sessionId &&
            record.workerId === workerId &&
            record.action === action &&
            record.requestId === requestId
          )
      )
    )
  );
}
function supervisorUiStateValid(state, sessionId) {
  if (
    state?.version !== 1 ||
    state.supervisorSessionId !== sessionId ||
    typeof state.objective !== 'string' ||
    typeof state.enabled !== 'boolean' ||
    typeof state.phase !== 'string' ||
    !Object.hasOwn(SUPERVISOR_UI_PHASES, state.phase) ||
    typeof state.reason !== 'string' ||
    !/^[\w-]{1,80}$/.test(state.reason) ||
    !Array.isArray(state.workers) ||
    state.workers.length > 12 ||
    !Array.isArray(state.history) ||
    state.history.length > 100 ||
    !Array.isArray(state.handledRequestIds) ||
    state.handledRequestIds.length > 128 ||
    !Array.isArray(state.handledRequestBindings) ||
    state.handledRequestIds.length !== state.handledRequestBindings.length
  )
    return false;
  const id = (value) => typeof value === 'string' && /^[\w-]{8,100}$/.test(value);
  const requestId = (value) => typeof value === 'string' && /^[\w:.-]{8,120}$/.test(value);
  const text = (value, min, max) =>
    typeof value === 'string' &&
    value.length >= min &&
    value.length <= max &&
    /^[^\x00-\x09\x0b\x0c\x0e-\x1f\x7f-\x9f]*$/.test(value);
  const number = (value) => typeof value === 'number' && Number.isFinite(value);
  const range = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
  const operation = (value) =>
    ['assign', 'retry', 'message'].includes(value.action) &&
    (value.action === 'message'
      ? typeof value.payloadHash === 'string' && /^[a-f0-9]{64}$/.test(value.payloadHash)
      : value.payloadHash === undefined);
  const workers = new Set();
  for (const worker of state.workers) {
    if (
      !worker ||
      !id(worker.sessionId) ||
      workers.has(worker.sessionId) ||
      !text(worker.task, 1, 4000) ||
      !range(worker.assignments, 0, 10) ||
      !range(worker.maxAssignments, 1, 10) ||
      !range(worker.maxRuntimeMs, 1000, 86400000) ||
      (worker.allowMessages !== undefined && typeof worker.allowMessages !== 'boolean') ||
      (worker.maxMessages !== undefined && !range(worker.maxMessages, 1, 100)) ||
      (worker.messages !== undefined && !range(worker.messages, 0, 100)) ||
      (worker.startedAt !== undefined && !number(worker.startedAt)) ||
      (worker.lastRequestId !== undefined && !requestId(worker.lastRequestId)) ||
      !Array.isArray(worker.criteria) ||
      !worker.criteria.length ||
      worker.criteria.length > 30
    )
      return false;
    workers.add(worker.sessionId);
    const criteria = new Set();
    for (const criterion of worker.criteria) {
      if (
        !criterion ||
        typeof criterion.id !== 'string' ||
        !/^[\w-]{1,80}$/.test(criterion.id) ||
        criteria.has(criterion.id) ||
        !text(criterion.description, 1, 1000) ||
        !['manual', 'command'].includes(criterion.kind) ||
        (criterion.kind === 'command' && !text(criterion.command, 1, 1000)) ||
        (criterion.kind === 'manual' && criterion.command !== undefined)
      )
        return false;
      criteria.add(criterion.id);
    }
  }
  if (
    !text(state.objective, 0, 3000) ||
    (state.startedAt !== undefined && !number(state.startedAt)) ||
    state.history.some(
      (event) =>
        !event ||
        !number(event.at) ||
        typeof event.reason !== 'string' ||
        !/^[\w-]{1,80}$/.test(event.reason) ||
        (event.workerId !== undefined && !id(event.workerId))
    )
  )
    return false;
  if (state.inFlight !== undefined) {
    const flight = state.inFlight;
    if (
      !flight ||
      !requestId(flight.requestId) ||
      !id(flight.workerId) ||
      !operation(flight) ||
      !number(flight.reservedAt)
    )
      return false;
  }
  const ids = new Set(state.handledRequestIds);
  if (ids.size !== state.handledRequestIds.length) return false;
  const boundIds = new Set();
  for (const binding of state.handledRequestBindings) {
    if (
      !binding ||
      !requestId(binding.requestId) ||
      typeof binding.workerId !== 'string' ||
      !/^[\w-]{8,100}$/.test(binding.workerId) ||
      !operation(binding) ||
      !ids.has(binding.requestId) ||
      boundIds.has(binding.requestId)
    )
      return false;
    boundIds.add(binding.requestId);
  }
  return true;
}
function supervisorUiAcceptedRequest(state, sessionId, workerId, action, requestId) {
  return (
    supervisorUiStateValid(state, sessionId) &&
    state.handledRequestBindings.some(
      (binding) => binding.requestId === requestId && binding.workerId === workerId && binding.action === action
    )
  );
}
function supervisorUiReconcileRequests(state, sessionId) {
  if (!supervisorUiStateValid(state, sessionId)) return;
  try {
    const records = supervisorUiRequestLedger();
    const accepted = new Set(
      state.handledRequestBindings.map((binding) =>
        JSON.stringify([binding.workerId, binding.action, binding.requestId])
      )
    );
    const pending = records.filter(
      (record) =>
        record.sessionId !== sessionId ||
        !accepted.has(JSON.stringify([record.workerId, record.action, record.requestId]))
    );
    if (pending.length !== records.length)
      sessionStorage.setItem(SUPERVISOR_UI_REQUEST_STORAGE, JSON.stringify(pending));
  } catch {
    // Unreadable storage or a failed acknowledgement write must retain pending identities.
  }
}
Object.assign(CodemanApp.prototype, {
  openSupervisorOptions(sessionId) {
    this.closeSupervisorOptions();
    const session = this.sessions.get(sessionId);
    const supported =
      !!session &&
      (supervisorUiStateValid(session.supervisor, sessionId) ||
        (session.supervisorAvailable === true &&
          this.supportsSessionRecovery?.(session) === true &&
          !session.remote &&
          !session.docker));
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
    view.state = supervisorUiStateValid(state, view.sessionId) ? state : null;
    if (view.state) {
      const session = this.sessions.get(view.sessionId);
      if (session) session.supervisor = view.state;
      supervisorUiReconcileRequests(view.state, view.sessionId);
    }
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
    const usage = document.getElementById('supervisorUsage');
    if (usage) usage.textContent = supervisorUiUsageText(state?.usage);
    document.getElementById('supervisorSettings').disabled = !available;
    document.getElementById('supervisorPrepareBtn').disabled =
      !available || state.phase === 'active' || !!state.inFlight;
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
        state.workers.map(
          ({ sessionId, task, criteria, maxAssignments, maxRuntimeMs, allowMessages, maxMessages }) => ({
            sessionId,
            task,
            criteria,
            maxAssignments,
            maxRuntimeMs,
            ...(allowMessages === undefined ? {} : { allowMessages }),
            ...(maxMessages === undefined ? {} : { maxMessages }),
          })
        ),
        null,
        2
      );
      const messageGrant = document.getElementById('supervisorAllowMessages');
      const allowed = state.workers.filter((worker) => worker.allowMessages === true).length;
      messageGrant.checked = state.workers.length > 0 && allowed === state.workers.length;
      messageGrant.indeterminate = allowed > 0 && allowed < state.workers.length;
      view.messageGrantEdited = false;
    }
    const inspections = new Map((view?.workerStatus ?? []).map((worker) => [worker.sessionId, worker]));
    const list = document.getElementById('supervisorWorkerStatus');
    list.replaceChildren();
    for (const worker of state?.workers ?? []) {
      const row = document.createElement('li');
      row.dataset.i18nSkip = '';
      const inspection = inspections.get(worker.sessionId);
      const evidence = document.createElement('span');
      const uncertainty = [
        inspection?.recoveryStale ? 'recovery may be stale' : '',
        inspection?.taskStale ? 'task status may be stale' : '',
      ]
        .filter(Boolean)
        .join('; ');
      const stale = uncertainty ? ` (${uncertainty})` : inspection?.stale ? ' (stale)' : '';
      evidence.textContent = `${worker.sessionId.slice(0, 8)} — ${worker.assignments}/${worker.maxAssignments} assignments — ${inspection?.health ?? 'not inspected'}${stale}${inspection?.task?.phase ? ` — task ${inspection.task.phase}` : ''}`;
      row.appendChild(evidence);
      const usageEvidence = document.createElement('span');
      usageEvidence.textContent = supervisorUiUsageText(inspection?.usage);
      row.appendChild(usageEvidence);
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
        (inspection?.recoveryStale ?? inspection?.stale) !== false ||
        inspection?.health !== 'dead-pane';
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
    view.workerStatus =
      Array.isArray(workers) &&
      workers.length <= 12 &&
      workers.every(
        (worker) =>
          worker &&
          typeof worker.sessionId === 'string' &&
          /^[\w-]{8,100}$/.test(worker.sessionId) &&
          typeof worker.health === 'string' &&
          (worker.task?.phase === undefined || typeof worker.task.phase === 'string')
      ) &&
      new Set(workers.map((worker) => worker.sessionId)).size === workers.length
        ? workers
        : [];
    this._renderSupervisorStatus();
  },
  async supervisorWorkerAction(workerId, action) {
    const view = this._supervisorView;
    if (!view || view.workersBusy || !['assign', 'retry'].includes(action)) return;
    let requestId;
    try {
      requestId = supervisorUiRequestId(view.sessionId, workerId, action);
    } catch {
      this.showToast(
        supervisorUiTranslate('Worker action could not be recorded safely. Refresh status before trying again.'),
        'error'
      );
      return;
    }
    view.workersBusy = true;
    this._renderSupervisorStatus();
    let state;
    try {
      state = await this._apiJson(
        `/api/sessions/${encodeURIComponent(view.sessionId)}/supervisor/workers/${encodeURIComponent(workerId)}/${action}`,
        {
          method: 'POST',
          headers: { 'X-Codeman-Supervisor-Session': view.sessionId },
          body: { requestId },
        }
      );
    } catch {
      state = null;
    }
    if (supervisorUiAcceptedRequest(state, view.sessionId, workerId, action, requestId)) {
      try {
        supervisorUiCompleteRequest(view.sessionId, workerId, action, requestId);
      } catch {
        // Retaining an accepted ID is safer than replacing it after a storage failure.
      }
    }
    if (this._supervisorView !== view) return;
    view.workersBusy = false;
    if (supervisorUiStateValid(state, view.sessionId)) {
      view.state = state;
      supervisorUiReconcileRequests(state, view.sessionId);
    } else this.showToast(supervisorUiTranslate('Worker action was refused or its delivery is uncertain.'), 'error');
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
    if (view.messageGrantEdited) {
      const allowed = document.getElementById('supervisorAllowMessages').checked;
      workers = workers.map((worker) => ({ ...worker, allowMessages: allowed }));
    }
    await this._performSupervisorRequest('', 'PUT', {
      objective: document.getElementById('supervisorObjective').value.trim(),
      enabled: document.getElementById('supervisorEnabled').checked,
      workers,
    });
  },
  async prepareSupervisorManager() {
    const view = this._supervisorView;
    if (!view?.state || view.busy || view.state.phase === 'active' || view.state.inFlight) return;
    if (
      !window.confirm(
        supervisorUiTranslate(
          'Prepare this session as a restricted manager? This restarts the manager session in place using its verified conversation and restricted supervisor tools. Active work or uncertain delivery will refuse preparation.'
        )
      ) ||
      this._supervisorView !== view
    )
      return;
    view.busy = true;
    this._renderSupervisorStatus();
    let prepared;
    try {
      prepared = await this._apiJson(`/api/sessions/${encodeURIComponent(view.sessionId)}/supervisor/prepare-manager`, {
        method: 'POST',
        body: { confirmRestrictedManager: true },
      });
    } catch {
      prepared = null;
    } finally {
      view.busy = false;
    }
    if (this._supervisorView !== view) return;
    if (prepared?.managerReady === true)
      this.showToast(supervisorUiTranslate('Restricted manager prepared. Select Start manager to begin.'), 'success');
    else if (prepared?.managerReady === false && prepared?.managerInspectionOnly === true)
      this.showToast(
        supervisorUiTranslate(
          'Manager readiness is uncertain. The restricted conversation remains available for status and worker inspection only. Check the conversation, then select Prepare to recheck without restarting it; owner controls remain available.'
        ),
        'error'
      );
    else
      this.showToast(
        supervisorUiTranslate(
          'Manager preparation was refused or is uncertain. Inspect the pane and verify authentication, exact conversation, settings and idle state before trying again. If the pane exited, use owner Restart after inspection; automatic recovery remains fenced.'
        ),
        'error'
      );
    await this.loadSupervisorStatus();
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
    view.state = supervisorUiStateValid(state, view.sessionId) ? state : null;
    if (view.state) {
      const session = this.sessions.get(view.sessionId);
      if (session) session.supervisor = view.state;
      supervisorUiReconcileRequests(view.state, view.sessionId);
    }
    if (!view.state)
      this.showToast(supervisorUiTranslate('Supervisor action failed. Refresh status before trying again.'), 'error');
    this._renderSupervisorStatus(true);
    if (view.state?.phase === 'active') await this.loadSupervisorWorkers();
  },
});
