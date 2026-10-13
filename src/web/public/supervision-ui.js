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
Object.assign(CodemanApp.prototype, {
  openTaskOptions(sessionId) {
    this.closeTaskOptions();
    const supported = this.supportsSessionRecovery?.(this.sessions.get(sessionId)) === true;
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
    for (const id of [
      'taskObjective',
      'taskManualCriteria',
      'taskCommandCriteria',
      'taskCheckpoint',
      'taskNextAction',
    ]) {
      const input = document.getElementById(id);
      if (input) input.value = '';
    }
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
  _renderTaskStatus(force = false) {
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
      (!(state.kickoffAt || state.continuations > 0) || state.continuations < state.config.maxContinuations) &&
      (!state.startedAt || Date.now() - state.startedAt < state.config.maxRuntimeMs);
    document.getElementById('taskResumeBtn').disabled =
      !available ||
      !budget ||
      !!state?.inFlight ||
      state?.outcome === 'completed' ||
      state?.outcome === 'blocked' ||
      !state?.objective ||
      !state?.criteria.length;
    document.getElementById('taskPauseBtn').disabled = !available || !state?.config.enabled;
    document.getElementById('taskResetBtn').disabled = !available;
    if (force || !view.dirty) {
      document.getElementById('taskObjective').value = state?.objective ?? '';
      const manualCriteria = state?.criteria.filter((c) => c.kind === 'manual').map((c) => c.description) ?? [];
      const commandCriteria = state?.criteria.filter((c) => c.kind === 'command').map((c) => c.command) ?? [];
      document.getElementById('taskManualCriteria').value = manualCriteria.join('\n');
      document.getElementById('taskCommandCriteria').value = commandCriteria.join('\n');
      view.configurationBaseline = {
        objective: (state?.objective ?? '').trim(),
        manual: manualCriteria.map((text) => text.trim()).filter(Boolean),
        commands: commandCriteria.map((text) => text.trim()).filter(Boolean),
      };
      document.getElementById('taskEnabled').checked = state?.config.enabled ?? false;
      document.getElementById('taskMaxContinuations').value = state?.config.maxContinuations ?? '';
      document.getElementById('taskMaxRuntime').value = state ? state.config.maxRuntimeMs / 1000 : '';
      document.getElementById('taskCheckpoint').value = state?.checkpoint ?? '';
      document.getElementById('taskNextAction').value = state?.nextAction ?? '';
      document.getElementById('taskProgressOutcome').value = state?.outcome ?? 'unknown';
    }
    const evidence = document.getElementById('taskCriteriaEvidence');
    const selected = force
      ? new Set()
      : new Set([...evidence.querySelectorAll('input:checked:not(:disabled)')].map((input) => input.value));
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
      const text = document.createElement('span');
      text.dataset.i18nSkip = '';
      text.textContent = `${criterion.description} — ${criterion.verified && criterion.evidence ? `${taskUiTranslate(criterion.evidence.source === 'owner' ? 'Owner verified' : 'Command exit verified')} (${taskUiDate(criterion.evidence.at)})` : taskUiTranslate('Unverified')}`;
      row.append(input, text);
      evidence.appendChild(row);
    }
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
    const objective = document.getElementById('taskObjective').value.trim();
    const manual = document
      .getElementById('taskManualCriteria')
      .value.split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const commands = document
      .getElementById('taskCommandCriteria')
      .value.split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const max = document.getElementById('taskMaxContinuations');
    const runtime = document.getElementById('taskMaxRuntime');
    if (
      !objective ||
      (!manual.length && !commands.length) ||
      manual.length + commands.length > 30 ||
      manual.some((text) => text.length > 1000) ||
      commands.some((text) => text.length > 1000) ||
      !max.value ||
      !runtime.value ||
      !max.checkValidity() ||
      !runtime.checkValidity()
    ) {
      this.showToast('Provide an objective, acceptance criteria, and valid task limits', 'warning');
      return;
    }
    const usedIds = new Set();
    const baseline = view.configurationBaseline ?? {
      objective: view.state.objective.trim(),
      manual: view.state.criteria.filter((c) => c.kind === 'manual').map((c) => c.description.trim()),
      commands: view.state.criteria.filter((c) => c.kind === 'command').map((c) => c.command.trim()),
    };
    const criteriaChanged =
      JSON.stringify(manual) !== JSON.stringify(baseline.manual) ||
      JSON.stringify(commands) !== JSON.stringify(baseline.commands);
    const criteria = criteriaChanged
      ? [
          ...manual.map((description) => ({ description, kind: 'manual' })),
          ...commands.map((command) => ({ description: command, command, kind: 'command' })),
        ].map((criterion, i) => {
          const old = view.state.criteria.find(
            (candidate) =>
              !usedIds.has(candidate.id) &&
              candidate.kind === criterion.kind &&
              (criterion.kind === 'command'
                ? candidate.command === criterion.command
                : candidate.description === criterion.description)
          );
          const id = old?.id ?? `criterion-${Date.now()}-${i + 1}`;
          usedIds.add(id);
          return {
            ...criterion,
            ...(old?.kind === 'command' && criterion.kind === 'command' ? { description: old.description } : {}),
            id,
          };
        })
      : undefined;
    await this._performTaskRequest('', 'PUT', {
      ...(objective !== baseline.objective ? { objective } : {}),
      ...(criteria ? { criteria } : {}),
      config: {
        enabled: document.getElementById('taskEnabled').checked,
        maxContinuations: Number(max.value),
        maxRuntimeMs: Number(runtime.value) * 1000,
      },
    });
  },
  async saveTaskProgress() {
    await this._performTaskRequest('/progress', 'POST', {
      outcome: document.getElementById('taskProgressOutcome').value,
      checkpoint: document.getElementById('taskCheckpoint').value.trim(),
      nextAction: document.getElementById('taskNextAction').value.trim(),
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
      !this.supportsSessionRecovery?.(this.sessions.get(view.sessionId))
    )
      return;
    const revision = view.revision;
    view.busy = true;
    this._renderTaskStatus();
    const state = await this._apiJson(`/api/sessions/${encodeURIComponent(view.sessionId)}/task${path}`, {
      method,
      ...(body === undefined ? {} : { body }),
    });
    if (this._taskView !== view || this.editingSessionId !== view.sessionId) return;
    view.busy = false;
    if (state?.version === 1 && state.config && Array.isArray(state.criteria)) {
      if (view.revision === revision) view.state = state;
      view.dirty = false;
    } else {
      view.state = null;
      this.showToast('Task action failed. Refresh status before trying again.', 'error');
    }
    this._renderTaskStatus(true);
  },
});
