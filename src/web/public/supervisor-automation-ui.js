/** Owner controls for durable manager check-ins and custom tasks. Loaded after supervisor-ui.js. */
function supervisorAutomationNewId() {
  return globalThis.crypto?.randomUUID?.() ?? `owner-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function supervisorAutomationConfig(value) {
  const range = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
  const text = (s, max) =>
    typeof s === 'string' && s.trim().length > 0 && s.length <= max && !/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(s);
  if (
    !value ||
    typeof value.checkIns?.enabled !== 'boolean' ||
    !range(value.checkIns.intervalMinutes, 1, 1440) ||
    !Array.isArray(value.tasks) ||
    value.tasks.length > 12
  )
    return null;
  const ids = new Set();
  for (const task of value.tasks) {
    if (
      !task ||
      typeof task.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(task.id) ||
      task.id === 'check-in' ||
      ids.has(task.id) ||
      !text(task.name, 100) ||
      !text(task.instructions, 4000) ||
      typeof task.enabled !== 'boolean' ||
      !['once', 'recurring'].includes(task.kind) ||
      !range(task.maxRuns, 1, 100) ||
      (task.kind === 'recurring' && !range(task.intervalMinutes, 1, 1440))
    )
      return null;
    ids.add(task.id);
  }
  return {
    checkIns: { enabled: value.checkIns.enabled, intervalMinutes: value.checkIns.intervalMinutes },
    tasks: value.tasks.map(({ id, name, instructions, enabled, kind, intervalMinutes, maxRuns }) => ({
      id,
      name,
      instructions,
      enabled,
      kind,
      ...(kind === 'recurring' ? { intervalMinutes } : {}),
      maxRuns,
    })),
  };
}
Object.assign(CodemanApp.prototype, {
  async loadSupervisorAutomation(force = false) {
    const view = this._supervisorView;
    if (!view || view.automationBusy || (view.automation && !force)) return;
    view.automationBusy = true;
    this._renderSupervisorAutomationBusy();
    let state;
    try {
      state = await this._apiJson(`/api/sessions/${encodeURIComponent(view.sessionId)}/supervisor/automation`);
    } catch {
      state = null;
    }
    if (this._supervisorView !== view) return;
    view.automationBusy = false;
    view.automation = supervisorAutomationConfig(state) ? state : null;
    this._renderSupervisorAutomation();
  },
  _renderSupervisorAutomationBusy() {
    const view = this._supervisorView;
    document.getElementById('supervisorAutomationSettings').disabled = !view?.automation || !!view.automationBusy;
  },
  _renderSupervisorAutomation() {
    const view = this._supervisorView;
    this._renderSupervisorAutomationBusy();
    const status = document.getElementById('supervisorAutomationStatus');
    const config = supervisorAutomationConfig(view?.automation);
    if (!config) {
      status.textContent = supervisorUiTranslate('Schedules unavailable. Refresh before editing.');
      return;
    }
    const state = view.automation.status;
    status.textContent = state
      ? `${state.phase}: ${state.reason}${state.inFlight ? ' — a delivery remains pending; do not start a duplicate run' : ''}`
      : supervisorUiTranslate('Schedules loaded');
    document.getElementById('supervisorCheckInsEnabled').checked = config.checkIns.enabled;
    document.getElementById('supervisorCheckInMinutes').value = config.checkIns.intervalMinutes;
    document.getElementById('supervisorCustomTasks').replaceChildren();
    for (const task of config.tasks) this.addSupervisorCustomTask(task);
  },
  addSupervisorCustomTask(saved) {
    const view = this._supervisorView;
    const list = document.getElementById('supervisorCustomTasks');
    if (!view?.automation || view.automationBusy || list.children.length >= 12) return;
    const task = saved ?? {
      id: supervisorAutomationNewId(),
      name: '',
      instructions: '',
      enabled: false,
      kind: 'once',
      maxRuns: 1,
    };
    const row = document.createElement('fieldset');
    row.className = 'set-group task-form';
    row.dataset.taskId = task.id;
    const legend = document.createElement('legend');
    legend.textContent = supervisorUiTranslate('Custom manager task');
    row.appendChild(legend);
    const control = (key, label, tag, attributes, value) => {
      const holder = document.createElement('label');
      holder.textContent = supervisorUiTranslate(label);
      const input = document.createElement(tag);
      input.dataset.field = key;
      input.className = tag === 'textarea' ? 'set-textarea' : 'set-input';
      for (const [name, setting] of Object.entries(attributes)) input.setAttribute(name, setting);
      if (input.type === 'checkbox') input.checked = value === true;
      else input.value = value ?? '';
      holder.appendChild(input);
      row.appendChild(holder);
      return input;
    };
    control('name', 'Task name', 'input', { maxlength: '100' }, task.name);
    control('instructions', 'Instructions', 'textarea', { maxlength: '4000', rows: '4' }, task.instructions);
    const kind = control('kind', 'Schedule', 'select', {}, '');
    for (const [value, label] of [
      ['once', 'Once'],
      ['recurring', 'Recurring'],
    ]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = supervisorUiTranslate(label);
      kind.appendChild(option);
    }
    kind.value = task.kind;
    const interval = control(
      'intervalMinutes',
      'Repeat every (minutes)',
      'input',
      { type: 'number', min: '1', max: '1440' },
      task.intervalMinutes ?? 60
    );
    const updateKind = () => {
      interval.disabled = kind.value !== 'recurring';
      interval.parentElement.hidden = kind.value !== 'recurring';
    };
    kind.addEventListener('change', updateKind);
    updateKind();
    control('maxRuns', 'Maximum runs', 'input', { type: 'number', min: '1', max: '100' }, task.maxRuns);
    control('enabled', 'Enable scheduled runs', 'input', { type: 'checkbox' }, task.enabled);
    const actions = document.createElement('div');
    actions.className = 'task-actions';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn-toolbar';
    remove.textContent = supervisorUiTranslate('Remove task');
    remove.addEventListener('click', () => row.remove());
    actions.appendChild(remove);
    const run = document.createElement('button');
    run.type = 'button';
    run.className = 'btn-toolbar';
    run.textContent = supervisorUiTranslate('Run saved task now');
    run.disabled = !saved || view.state?.phase !== 'active' || !!view.automation.status?.inFlight;
    run.addEventListener('click', () => void this.runSupervisorCustomTask(task.id));
    actions.appendChild(run);
    row.appendChild(actions);
    list.appendChild(row);
  },
  async saveSupervisorAutomation() {
    const view = this._supervisorView;
    if (!view?.automation || view.automationBusy) return;
    const tasks = [...document.getElementById('supervisorCustomTasks').children].map((row) => {
      const get = (key) => row.querySelector(`[data-field="${key}"]`);
      const kind = get('kind').value;
      return {
        id: row.dataset.taskId,
        name: get('name').value.trim(),
        instructions: get('instructions').value,
        kind,
        enabled: get('enabled').checked,
        maxRuns: Number(get('maxRuns').value),
        ...(kind === 'recurring' ? { intervalMinutes: Number(get('intervalMinutes').value) } : {}),
      };
    });
    const config = supervisorAutomationConfig({
      checkIns: {
        enabled: document.getElementById('supervisorCheckInsEnabled').checked,
        intervalMinutes: Number(document.getElementById('supervisorCheckInMinutes').value),
      },
      tasks,
    });
    if (!config) {
      this.showToast(supervisorUiTranslate('Check task names, instructions, intervals and run limits.'), 'warning');
      return;
    }
    view.automationBusy = true;
    this._renderSupervisorAutomationBusy();
    let state;
    try {
      state = await this._apiJson(`/api/sessions/${encodeURIComponent(view.sessionId)}/supervisor/automation`, {
        method: 'PUT',
        body: config,
      });
    } catch {
      state = null;
    }
    if (this._supervisorView !== view) return;
    view.automationBusy = false;
    if (!supervisorAutomationConfig(state)) {
      this.showToast(
        supervisorUiTranslate('Schedules were not confirmed. Your draft is retained; refresh before retrying.'),
        'error'
      );
      this._renderSupervisorAutomationBusy();
      return;
    }
    view.automation = state;
    this._renderSupervisorAutomation();
  },
  async runSupervisorCustomTask(taskId) {
    const view = this._supervisorView;
    if (!view?.automation || view.automationBusy || view.state?.phase !== 'active') return;
    const key = `codeman:supervisorTaskRun:${view.sessionId}:${taskId}`;
    let requestId;
    try {
      requestId = sessionStorage.getItem(key) ?? supervisorAutomationNewId();
      if (!/^[\w:.-]{8,120}$/.test(requestId)) throw new Error();
      sessionStorage.setItem(key, requestId);
    } catch {
      this.showToast(supervisorUiTranslate('Could not retain a safe run identity.'), 'error');
      return;
    }
    view.automationBusy = true;
    this._renderSupervisorAutomationBusy();
    let state;
    try {
      state = await this._apiJson(
        `/api/sessions/${encodeURIComponent(view.sessionId)}/supervisor/automation/tasks/${encodeURIComponent(taskId)}/run`,
        { method: 'POST', body: { requestId } }
      );
    } catch {
      state = null;
    }
    const receipt = state?.status?.lastRun;
    if (
      supervisorAutomationConfig(state) &&
      receipt?.requestId === requestId &&
      receipt.taskId === taskId &&
      /^[a-f0-9]{64}$/.test(receipt.payloadHash) &&
      ['accepted', 'refused'].includes(receipt.phase)
    ) {
      try {
        sessionStorage.removeItem(key);
      } catch {
        /* Preserve the ID when acknowledgement storage fails. */
      }
    }
    if (this._supervisorView !== view) return;
    view.automationBusy = false;
    if (!supervisorAutomationConfig(state)) {
      this.showToast(
        supervisorUiTranslate('Run refused or delivery uncertain. Its request identity is retained.'),
        'error'
      );
      this._renderSupervisorAutomationBusy();
      return;
    }
    view.automation = state;
    this._renderSupervisorAutomation();
  },
});
