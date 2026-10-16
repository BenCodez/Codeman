/**
 * @fileoverview Owner-bound task supervision configuration, progress evidence and controls.
 * @dependency app.js (CodemanApp class, this.sessions, this.editingSessionId, showToast)
 * @dependency api-client.js at runtime (this._apiJson; loaded later and called only after init)
 * @dependency recovery-ui.js (taskUiReason falls back to RECOVERY_UI_REASONS)
 * @loadorder 8.2, after recovery-ui.js, before ralph-panel.js
 */
const TASK_UI_PHASES = Object.freeze({
  disabled: 'Off',
  watching: 'Monitoring',
  paused: 'Paused',
  blocked: 'Blocked',
  completed: 'Completed',
});
const TASK_UI_OUTCOMES = Object.freeze({
  unknown: 'Unknown',
  unfinished: 'Unfinished',
  blocked: 'Blocked',
  completed: 'Completed',
});
const TASK_UI_REASONS = Object.freeze({
  disabled: 'Task supervision is off',
  configured: 'Task configuration saved',
  'owner-paused': 'Paused by owner',
  'owner-resumed': 'Resumed by owner',
  'owner-reset': 'Task reset and disabled',
  'progress-recorded': 'Checkpoint and verification recorded',
  'task-evidence-unknown': 'Unfinished work is not verified',
  'budget-exhausted': 'Task continuation or runtime limit reached',
  'continuation-reserved': 'Continuation reserved; delivery unverified',
  'kickoff-reserved': 'Continuation reserved; delivery unverified',
  'kickoff-sent': 'Continuation delivered; acceptance unverified',
  'delivery-cancelled': 'Continuation delivery cancelled',
  'continuation-sent': 'Continuation delivered; acceptance unverified',
  'continuation-accepted': 'Structured input acceptance verified',
  'kickoff-not-ready': 'Waiting for a verified idle conversation',
  'delivery-unknown': 'Delivery is unknown; reset required',
  'restart-in-flight': 'Unresolved continuation after restart; reset required',
  'restart-requires-resume': 'Resume required after restart',
  completed: 'All acceptance criteria verified',
});
function taskUiTranslate(text) {
  return window.CodemanI18n?.t(text) ?? text;
}
function taskUiReason(reason) {
  return taskUiTranslate(
    TASK_UI_REASONS[reason] ??
      (typeof RECOVERY_UI_REASONS !== 'undefined' ? RECOVERY_UI_REASONS[reason] : undefined) ??
      'Unknown'
  );
}
function taskUiDate(at) {
  return Number.isFinite(at) && at > 0 ? new Date(at).toLocaleString() : '\u2014';
}
function taskUiCriterionInput(criterion) {
  return {
    id: criterion.id,
    kind: criterion.kind,
    description: criterion.description,
    ...(criterion.kind === 'command' ? { command: criterion.command } : {}),
  };
}
Object.assign(CodemanApp.prototype, {
  supportsSessionTask(session) {
    return (
      this.supportsSessionRecovery?.(session) === true &&
      session.taskSupported === true &&
      !session.remote &&
      !session.docker
    );
  },
  openTaskOptions(sessionId) {
    this.closeTaskOptions();
    const supported = this.supportsSessionTask(this.sessions.get(sessionId));
    const rail = document.querySelector('#sessionOptionsModal [data-tab="task"]');
    if (rail) rail.style.display = supported ? '' : 'none';
    if (!supported) return false;
    this._taskView = {
      sessionId,
      revision: 0,
      state: null,
      loading: false,
      busy: false,
      dirty: false,
      configurationBaseline: null,
    };
    this._renderTaskStatus(true);
    this._taskView.timer = setInterval(() => this._updateTaskRuntime(), 1000);
    void this.loadTaskStatus();
    return true;
  },
  closeTaskOptions() {
    this._taskView?.readAbort?.abort();
    clearInterval(this._taskView?.timer);
    this._taskView = null;
    const verified = document.getElementById('taskLastVerified');
    if (verified) verified.textContent = '\u2014';
    // Remove user-authored content as soon as the owner-bound view closes.
    for (const id of ['taskObjective', 'taskCheckpoint', 'taskNextAction']) {
      const input = document.getElementById(id);
      if (input) input.value = '';
    }
    document.getElementById('taskCriteriaRows')?.replaceChildren();
    document.getElementById('taskCriteriaEvidence')?.replaceChildren();
    document.getElementById('taskHistory')?.replaceChildren();
  },
  async loadTaskStatus() {
    const view = this._taskView;
    if (!view || view.busy || this.editingSessionId !== view.sessionId) return;
    view.readAbort?.abort();
    const abort = new AbortController();
    view.readAbort = abort;
    const revision = view.revision;
    view.loading = true;
    this._renderTaskStatus();
    const state = await this._apiJson(`/api/sessions/${encodeURIComponent(view.sessionId)}/task`, {
      signal: abort.signal,
    });
    if (this._taskView !== view || view.readAbort !== abort || this.editingSessionId !== view.sessionId) return;
    view.readAbort = null;
    view.loading = false;
    if (view.revision === revision) {
      view.state = state?.version === 1 && state.config && Array.isArray(state.criteria) ? state : null;
    }
    this._renderTaskStatus();
  },
  _onSessionTask(data) {
    const view = this._taskView;
    if (
      !view ||
      data.sessionId !== view.sessionId ||
      this.editingSessionId !== view.sessionId ||
      !this.sessions.has(view.sessionId)
    )
      return;
    if (data.state?.version !== 1 || !data.state.config || !Array.isArray(data.state.criteria)) return;
    view.revision++;
    view.state = data.state;
    this._renderTaskStatus();
  },
  markTaskDraft() {
    if (this._taskView) this._taskView.dirty = true;
  },
  _taskDraftSnapshot(section) {
    const value = (id) => document.getElementById(id).value;
    return JSON.stringify(
      section === 'configuration'
        ? {
            objective: value('taskObjective'),
            enabled: document.getElementById('taskEnabled').checked,
            maxContinuations: value('taskMaxContinuations'),
            maxRuntime: value('taskMaxRuntime'),
            criteria: (this._taskView?.criterionRows ?? []).map((row) => ({
              id: row.id,
              kind: row.kind,
              fields: Object.fromEntries(Object.entries(row.fields).map(([key, field]) => [key, field.input.value])),
            })),
          }
        : {
            checkpoint: value('taskCheckpoint'),
            nextAction: value('taskNextAction'),
            outcome: value('taskProgressOutcome'),
            verifiedCriteria: [...document.querySelectorAll('#taskCriteriaEvidence input:checked')]
              .filter((input) => input.dataset.taskVerified !== 'true')
              .map((input) => input.value),
          }
    );
  },
  _appendTaskCriterion(view, criterion, added = false) {
    const element = document.createElement('div');
    element.className = 'task-criterion-editor';
    element.dataset.taskCriterionRow = '';
    element.dataset.criterionId = criterion.id;
    const row = { id: criterion.id, kind: criterion.kind, element, added, fields: {} };
    const title = document.createElement('strong');
    title.textContent = taskUiTranslate(
      criterion.kind === 'command' ? 'Command acceptance check' : 'Owner acceptance criterion'
    );
    element.appendChild(title);
    const field = (key, title) => {
      const label = document.createElement('label');
      const text = document.createElement('span');
      text.textContent = taskUiTranslate(title);
      const input = document.createElement('textarea');
      input.className = 'set-textarea';
      input.rows = 2;
      input.maxLength = 1000;
      input.dataset.i18nSkip = '';
      input.dataset.taskField = key;
      const original = criterion[key] ?? '';
      input.value = original;
      // Browsers normalize CR/CRLF in textareas. An untouched visible value
      // must retain the API's exact original bytes, including line endings.
      row.fields[key] = { input, baseline: input.value, original };
      input.addEventListener('input', () => {
        if (this._taskView === view) this.markTaskDraft();
      });
      label.append(text, input);
      element.appendChild(label);
    };
    field('description', 'Description');
    if (criterion.kind === 'command') {
      field('command', 'Exact command');
      if (added) row.fields.description.input.placeholder = taskUiTranslate('Defaults to the command');
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn-toolbar';
    remove.textContent = taskUiTranslate('Remove criterion');
    remove.addEventListener('click', () => {
      if (this._taskView !== view || view.busy || view.loading || this.editingSessionId !== view.sessionId) return;
      view.criterionRows = view.criterionRows.filter((candidate) => candidate !== row);
      element.remove();
      this.markTaskDraft();
      this._updateTaskCriterionButtons();
    });
    element.appendChild(remove);
    view.criterionRows.push(row);
    document.getElementById('taskCriteriaRows').appendChild(element);
  },
  _updateTaskCriterionButtons() {
    const full = (this._taskView?.criterionRows?.length ?? 0) >= 30;
    document.getElementById('taskAddManualCriterion').disabled = full;
    document.getElementById('taskAddCommandCriterion').disabled = full;
  },
  addTaskCriterion(kind) {
    const view = this._taskView;
    if (
      !view?.state ||
      view.busy ||
      view.loading ||
      this.editingSessionId !== view.sessionId ||
      !['manual', 'command'].includes(kind) ||
      view.criterionRows.length >= 30
    )
      return;
    let id;
    do {
      id = `criterion-${Date.now()}-${++view.criterionSequence}`;
    } while (view.usedCriterionIds.has(id));
    view.usedCriterionIds.add(id);
    this._appendTaskCriterion(
      view,
      { id, kind, description: '', ...(kind === 'command' ? { command: '' } : {}) },
      true
    );
    this.markTaskDraft();
    this._updateTaskCriterionButtons();
    view.criterionRows.at(-1).fields[kind === 'command' ? 'command' : 'description'].input.focus();
  },
  _renderTaskStatus(force = false, savedSection) {
    const view = this._taskView;
    if (!view || this.editingSessionId !== view.sessionId) return;
    const state = view.state;
    const set = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };
    const available = !!state && !view.loading && !view.busy;
    document.getElementById('task-tab')?.setAttribute('aria-busy', String(view.loading || view.busy));
    document.getElementById('taskSettings').disabled = !available;
    document.getElementById('taskProgress').disabled = !available;
    document.getElementById('taskError').hidden = !!state || view.loading;
    set('taskPhase', state ? (TASK_UI_PHASES[state.phase] ?? 'Unknown') : view.loading ? 'Loading' : 'Unavailable');
    set('taskOutcome', state ? (TASK_UI_OUTCOMES[state.outcome] ?? 'Unknown') : '\u2014');
    set('taskReason', state ? taskUiReason(state.reason) : '\u2014');
    set('taskAttempts', state ? `${state.continuations} / ${state.config.maxContinuations}` : '\u2014');
    set(
      'taskRuntime',
      state?.startedAt
        ? `${Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000))} / ${state.config.maxRuntimeMs / 1000}`
        : '\u2014'
    );
    set('taskCurrentAttempt', state?.inFlight ? taskUiDate(state.inFlight.startedAt) : '\u2014');
    const verified = state?.criteria.filter((c) => c.verified && c.evidence) ?? [];
    const last = verified.reduce((at, c) => Math.max(at, c.evidence.at), 0);
    const lastCriterion = verified.find((c) => c.evidence.at === last);
    set('taskLastVerified', lastCriterion ? `${lastCriterion.description} (${taskUiDate(last)})` : '\u2014');
    set(
      'taskInputEvidence',
      state?.reason === 'continuation-accepted'
        ? 'Structured input acceptance verified'
        : ['continuation-sent', 'kickoff-sent'].includes(state?.reason)
          ? 'Continuation delivered; acceptance unverified'
          : state?.inFlight
            ? 'Continuation attempt pending; acceptance unverified'
            : 'No input awaiting acceptance'
    );
    document.getElementById('taskRefreshBtn').disabled = view.loading || view.busy;
    const budget =
      !!state &&
      (state.kickoffAt !== undefined ||
        state.continuations === 0 ||
        state.continuations < state.config.maxContinuations) &&
      (!state.startedAt || Date.now() - state.startedAt < state.config.maxRuntimeMs);
    document.getElementById('taskResumeBtn').disabled =
      !available ||
      !budget ||
      !!state?.inFlight ||
      state?.outcome === 'completed' ||
      !state?.objective ||
      !state?.criteria.length;
    document.getElementById('taskPauseBtn').disabled =
      !available || !state?.config.enabled || state?.outcome === 'completed';
    document.getElementById('taskResetBtn').disabled = !available;
    const configurationDirty =
      view.configurationDraftBaseline !== undefined &&
      this._taskDraftSnapshot('configuration') !== view.configurationDraftBaseline;
    const progressDirty =
      view.progressDraftBaseline !== undefined && this._taskDraftSnapshot('progress') !== view.progressDraftBaseline;
    const renderConfiguration = force || !configurationDirty || savedSection === 'configuration';
    const renderProgress = force || !progressDirty || savedSection === 'progress';
    if (renderConfiguration) {
      const objectiveInput = document.getElementById('taskObjective');
      const originalObjective = state?.objective ?? '';
      objectiveInput.value = originalObjective;
      view.objectiveTextBaseline = { original: originalObjective, baseline: objectiveInput.value };
      const criteria = (state?.criteria ?? []).map(taskUiCriterionInput);
      const criteriaSignature = JSON.stringify(criteria);
      // Status-only updates must not interrupt a focused field before its first input.
      if (force || view.configurationBaseline?.criteria !== criteriaSignature) {
        view.criterionRows = [];
        view.criterionSequence = 0;
        view.usedCriterionIds = new Set(criteria.map((criterion) => criterion.id));
        document.getElementById('taskCriteriaRows').replaceChildren();
        for (const criterion of criteria) this._appendTaskCriterion(view, criterion);
        this._updateTaskCriterionButtons();
      }
      view.configurationBaseline = {
        objective: originalObjective,
        criteria: criteriaSignature,
      };
      document.getElementById('taskEnabled').checked = state?.config.enabled ?? false;
      document.getElementById('taskMaxContinuations').value = state?.config.maxContinuations ?? '';
      document.getElementById('taskMaxRuntime').value = state ? state.config.maxRuntimeMs / 1000 : '';
      view.configurationDraftBaseline = this._taskDraftSnapshot('configuration');
    }
    if (renderProgress) {
      view.progressTextBaseline = {};
      for (const [id, key] of [
        ['taskCheckpoint', 'checkpoint'],
        ['taskNextAction', 'nextAction'],
      ]) {
        const input = document.getElementById(id);
        const original = state?.[key] ?? '';
        input.value = original;
        view.progressTextBaseline[key] = { original, baseline: input.value };
      }
      document.getElementById('taskProgressOutcome').value = state?.outcome ?? 'unknown';
    }
    const evidence = document.getElementById('taskCriteriaEvidence');
    // A configuration edit resets every criterion's evidence, even when IDs are reused.
    // Preserve unsaved selections only for the exact objective and evidence generation.
    const evidenceBinding = JSON.stringify([
      state?.objective,
      state?.configuredAt,
      (state?.criteria ?? []).map(taskUiCriterionInput),
    ]);
    const selected =
      renderProgress || view.progressEvidenceBinding !== evidenceBinding
        ? new Set()
        : new Set(
            [...evidence.querySelectorAll('input:checked')]
              .filter((input) => input.dataset.taskVerified !== 'true')
              .map((input) => input.value)
          );
    view.progressEvidenceBinding = evidenceBinding;
    evidence.replaceChildren();
    for (const criterion of state?.criteria ?? []) {
      const row = document.createElement('label');
      row.className = 'task-criterion';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = criterion.id;
      input.checked = criterion.verified || selected.has(criterion.id);
      input.disabled = !available || criterion.verified;
      input.dataset.taskCriterion = '';
      input.dataset.taskVerified = String(criterion.verified === true);
      input.addEventListener('change', () => {
        if (this._taskView === view) this.markTaskDraft();
      });
      const text = document.createElement('span');
      text.dataset.i18nSkip = '';
      text.textContent = `${criterion.description} — ${criterion.verified && criterion.evidence ? `${taskUiTranslate(criterion.evidence.source === 'owner' ? 'Owner verified' : 'Command exit verified')} (${taskUiDate(criterion.evidence.at)})` : taskUiTranslate('Unverified')}`;
      row.append(input, text);
      evidence.appendChild(row);
    }
    if (renderProgress) view.progressDraftBaseline = this._taskDraftSnapshot('progress');
    const history = document.getElementById('taskHistory');
    history.replaceChildren();
    for (const event of (state?.history ?? []).slice(-20).reverse()) {
      const row = document.createElement('li');
      row.dataset.i18nSkip = '';
      row.textContent = `${taskUiDate(event.at)} — ${taskUiReason(event.reason)}`;
      history.appendChild(row);
    }
    document.getElementById('taskHistoryEmpty').hidden = !!history.children.length;
  },
  _updateTaskRuntime() {
    const view = this._taskView;
    if (!view?.state || this.editingSessionId !== view.sessionId) return;
    const state = view.state;
    if (state.startedAt)
      document.getElementById('taskRuntime').textContent =
        `${Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000))} / ${state.config.maxRuntimeMs / 1000}`;
    if (state.startedAt && Date.now() - state.startedAt >= state.config.maxRuntimeMs)
      document.getElementById('taskResumeBtn').disabled = true;
  },
  async saveTaskConfiguration() {
    const view = this._taskView;
    if (!view?.state || view.busy || view.loading) return;
    const objectiveInput = document.getElementById('taskObjective').value;
    const objectiveField = view.objectiveTextBaseline;
    const objective =
      objectiveField && objectiveInput === objectiveField.baseline ? objectiveField.original : objectiveInput;
    const baseline = view.configurationBaseline;
    const read = (field) => (field.input.value === field.baseline ? field.original : field.input.value);
    const criteria = view.criterionRows.map((row) => {
      const command = row.kind === 'command' ? read(row.fields.command) : undefined;
      const description = read(row.fields.description);
      return {
        id: row.id,
        kind: row.kind,
        description: row.added && row.kind === 'command' && description === '' ? command : description,
        ...(row.kind === 'command' ? { command } : {}),
      };
    });
    const max = document.getElementById('taskMaxContinuations');
    const runtime = document.getElementById('taskMaxRuntime');
    if (
      !objective.trim() ||
      !criteria.length ||
      criteria.length > 30 ||
      criteria.some(
        (criterion) =>
          !criterion.description.trim() ||
          criterion.description.length > 1000 ||
          (criterion.kind === 'command' && (!criterion.command.trim() || criterion.command.length > 1000))
      ) ||
      !max.value ||
      !runtime.value ||
      !max.checkValidity() ||
      !runtime.checkValidity()
    ) {
      this.showToast('Provide an objective, acceptance criteria, and valid task limits', 'warning');
      return;
    }
    const criteriaChanged = JSON.stringify(criteria) !== baseline.criteria;
    await this._performTaskRequest('', 'PUT', {
      ...(objective !== baseline.objective ? { objective } : {}),
      ...(criteriaChanged ? { criteria } : {}),
      config: {
        enabled: document.getElementById('taskEnabled').checked,
        maxContinuations: Number(max.value),
        maxRuntimeMs: Number(runtime.value) * 1000,
      },
    });
  },
  async saveTaskProgress() {
    const read = (id, key) => {
      const value = document.getElementById(id).value;
      const field = this._taskView?.progressTextBaseline?.[key];
      return field && value === field.baseline ? field.original : value;
    };
    await this._performTaskRequest('/progress', 'POST', {
      outcome: document.getElementById('taskProgressOutcome').value,
      checkpoint: read('taskCheckpoint', 'checkpoint'),
      nextAction: read('taskNextAction', 'nextAction'),
      verifiedCriteria: [...document.querySelectorAll('#taskCriteriaEvidence input:checked:not(:disabled)')].map(
        (input) => input.value
      ),
    });
  },
  async taskAction(action) {
    if (!['pause', 'resume', 'reset'].includes(action)) return;
    this._renderTaskStatus();
    const id = { pause: 'taskPauseBtn', resume: 'taskResumeBtn', reset: 'taskResetBtn' }[action];
    if (document.getElementById(id)?.disabled) return;
    await this._performTaskRequest(`/${action}`, 'POST');
  },
  async _performTaskRequest(path, method, body) {
    const view = this._taskView;
    if (
      !view?.state ||
      view.busy ||
      view.loading ||
      this.editingSessionId !== view.sessionId ||
      !this.supportsSessionTask(this.sessions.get(view.sessionId))
    )
      return;
    const revision = view.revision;
    const focused = document.activeElement;
    const selection =
      typeof focused?.selectionStart === 'number'
        ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection]
        : null;
    if (body !== undefined) view.dirty = true;
    view.busy = true;
    this._renderTaskStatus();
    const state = await this._apiJson(`/api/sessions/${encodeURIComponent(view.sessionId)}/task${path}`, {
      method,
      ...(body === undefined ? {} : { body }),
    });
    if (this._taskView !== view || this.editingSessionId !== view.sessionId) return;
    view.busy = false;
    let savedSection;
    if (state?.version === 1 && state.config && Array.isArray(state.criteria)) {
      const current = view.revision === revision;
      if (current) view.state = state;
      // Controls persist no draft. A save may acknowledge its matching SSE
      // publication, but an older response cannot clear a newer server view.
      if (body !== undefined && (current || JSON.stringify(state) === JSON.stringify(view.state))) {
        savedSection = path === '/progress' ? 'progress' : 'configuration';
        const otherSection = savedSection === 'progress' ? 'configuration' : 'progress';
        view.dirty = this._taskDraftSnapshot(otherSection) !== view[`${otherSection}DraftBaseline`];
      }
    } else {
      this.showToast('Task action failed. Refresh status before trying again.', 'error');
      this._renderTaskStatus();
      if (focused?.isConnected && document.getElementById('task-tab')?.contains(focused)) {
        focused.focus();
        if (selection) focused.setSelectionRange(...selection);
      }
      return;
    }
    this._renderTaskStatus(!view.dirty, savedSection);
  },
});
