/**
 * @fileoverview Structured recovery status and bounded per-session settings.
 * @mixin Extends CodemanApp.prototype; loaded after app.js and before session-ui.js.
 * Only the open modal holds recovery state. Closing aborts reads; action replies
 * are guarded by the view identity so they cannot paint a different session.
 * @dependency app.js (CodemanApp class, this.sessions, this.editingSessionId, showToast)
 * @dependency api-client.js at runtime (this._apiJson; loaded later and called only after init)
 * @loadorder 8.1, after respawn-ui.js, before supervision-ui.js
 */

const RECOVERY_UI_FIELDS = Object.freeze({
  enabled: { id: 'recoveryEnabled', boolean: true },
  recoverInterrupted: { id: 'recoveryInterrupted', boolean: true },
  recoverCrashes: { id: 'recoveryCrashes', boolean: true },
  detectStalls: { id: 'recoveryStalls', boolean: true },
  restartStalls: { id: 'recoveryRestartStalls', boolean: true },
  maxRetries: { id: 'recoveryMaxRetries', scale: 1 },
  retryDelayMs: { id: 'recoveryRetryDelay', scale: 1000 },
  maxRetryDelayMs: { id: 'recoveryMaxDelay', scale: 1000 },
  maxRecoveryDurationMs: { id: 'recoveryMaxDuration', scale: 1000 },
  stalledAfterMs: { id: 'recoveryStalledAfter', scale: 1000 },
});

const RECOVERY_UI_REASONS = Object.freeze({
  disabled: 'Automatic recovery is off',
  observing: 'Observing structured events',
  'identity-unverified': 'Conversation identity is not verified',
  'identity-changed': 'Conversation identity changed',
  'managed-daemon': 'Daemon sessions cannot be recovered automatically',
  'unsupported-location': 'Recovery requires a local session',
  'transport-unreachable': 'The SSH transport is unreachable',
  'transport-unavailable': 'The SSH transport could not be authenticated or inspected',
  'remote-inspector-unavailable': 'Remote recovery needs Node.js and tmux in the remote login path',
  'remote-session-missing': 'The owned remote worker is missing',
  'unowned-session': 'Recovery requires a Codeman-owned session',
  'user-input': 'Paused for user input',
  'user-interrupted': 'Paused after a user interruption',
  'approval-required': 'Approval is required',
  'authentication-required': 'Authentication is required',
  'usage-limit': 'Usage limit reached',
  'internal-retry': 'The CLI is retrying internally',
  'turn-running': 'A turn is still running',
  'background-work': 'Background work is still running',
  'turn-completed': 'The turn completed',
  'turn-interrupted': 'The turn was interrupted',
  'turn-failed': 'The turn failed',
  'process-crashed': 'The process crashed',
  'clean-exit': 'The process exited normally',
  'pane-unverified': 'Terminal safety could not be verified',
  stalled: 'An unfinished turn and abnormal dead pane were confirmed',
  'stall-unverified': 'No progress was observed; inspect the live agent and retry from its terminal',
  scheduled: 'Recovery is scheduled',
  'continuation-sent': 'Continuation sent; awaiting confirmation',
  'process-resumed': 'Conversation resumed; awaiting confirmation',
  'recovery-accepted': 'The CLI accepted recovery',
  'delivery-failed': 'Recovery input could not be delivered',
  'acceptance-unverified': 'Recovery acceptance could not be verified',
  'retries-exhausted': 'Recovery retry limit reached',
  'recovery-window-exhausted': 'Recovery time limit reached',
  'restart-in-flight': 'A restart is already in progress',
  'persistence-failed': 'Recovery state could not be saved',
  'manual-reset': 'Recovery limits were reset',
});

const RECOVERY_UI_ACTIVITIES = Object.freeze({
  unknown: 'Unknown',
  idle: 'Idle',
  working: 'Working',
  watching: 'Watching',
  interrupted: 'Interrupted',
  completed: 'Completed',
  paused: 'Paused',
  blocked: 'Blocked',
  crashed: 'Crashed',
  exited: 'Exited',
});

const RECOVERY_UI_PHASES = Object.freeze({
  idle: 'Idle',
  watching: 'Monitoring',
  recovering: 'Recovering',
  paused: 'Paused',
  blocked: 'Blocked',
  completed: 'Completed',
  failed: 'Failed',
});

const RECOVERY_UI_EVENTS = Object.freeze({
  state: 'State changed',
  scheduled: 'Retry scheduled',
  continue: 'Continuation',
  restart: 'Restart',
  accepted: 'Recovery accepted',
  attention: 'Attention needed',
  reset: 'Limits reset',
});

function recoveryUiLabel(dictionary, key) {
  return Object.prototype.hasOwnProperty.call(dictionary, key) ? dictionary[key] : 'Unknown';
}

function recoveryUiDate(value) {
  return Number.isFinite(value) && value > 0 ? new Date(value).toLocaleString() : '\u2014';
}

Object.assign(CodemanApp.prototype, {
  supportsSessionRecovery(session) {
    if (!session) return false;
    const catalog = typeof window !== 'undefined' ? window.__codemanCliCatalog : [];
    const entry = Array.isArray(catalog) ? catalog.find((cli) => cli.id === session.mode) : null;
    return (entry?.recovery ?? entry?.capabilities?.recovery) === 'codex-rollout';
  },

  openRecoveryOptions(sessionId) {
    this.closeRecoveryOptions();
    const supported = this.supportsSessionRecovery(this.sessions.get(sessionId));
    const rail = document.querySelector('#sessionOptionsModal [data-tab="recovery"]');
    if (rail) rail.style.display = supported ? '' : 'none';
    if (!supported) return false;
    this._recoveryView = { sessionId, state: null, revision: 0, loading: false, busy: false, error: false };
    this._renderRecoveryStatus(true);
    void this.loadRecoveryStatus();
    return true;
  },

  closeRecoveryOptions() {
    this._recoveryView?.readAbort?.abort();
    this._recoveryView = null;
  },

  async loadRecoveryStatus() {
    const view = this._recoveryView;
    if (!view || view.busy || this.editingSessionId !== view.sessionId) return;
    view.readAbort?.abort();
    const abort = new AbortController();
    view.readAbort = abort;
    const revision = view.revision;
    view.loading = true;
    view.error = false;
    this._renderRecoveryStatus();
    const state = await this._apiJson(`/api/sessions/${encodeURIComponent(view.sessionId)}/recovery`, {
      signal: abort.signal,
    });
    if (this._recoveryView !== view || view.readAbort !== abort) return;
    view.readAbort = null;
    view.loading = false;
    // An SSE update arriving during this read is newer than its snapshot.
    if (view.revision === revision) {
      if (state?.version === 1 && state.config) view.state = state;
      else {
        view.state = null;
        view.error = true;
      }
    }
    this._renderRecoveryStatus(true);
  },

  _onSessionRecovery(data) {
    const view = this._recoveryView;
    if (!view || data.sessionId !== view.sessionId || this.editingSessionId !== view.sessionId) return;
    if (!this.sessions.has(view.sessionId) || data.state?.version !== 1 || !data.state.config) return;
    view.revision++;
    view.state = data.state;
    view.error = false;
    this._renderRecoveryStatus();
  },

  _renderRecoveryStatus(forceSettings = false) {
    const view = this._recoveryView;
    if (!view || this.editingSessionId !== view.sessionId) return;
    const state = view.state;
    const set = (id, value) => {
      const element = document.getElementById(id);
      if (element && element.dataset.recoveryEnglish !== String(value)) {
        element.dataset.recoveryEnglish = String(value);
        element.textContent = value;
      }
    };
    const fallback = view.error ? 'Unavailable' : 'Loading';
    set('recoveryActivity', state ? recoveryUiLabel(RECOVERY_UI_ACTIVITIES, state.activity) : fallback);
    set(
      'recoveryPhase',
      state ? (state.config.enabled ? recoveryUiLabel(RECOVERY_UI_PHASES, state.phase) : 'Off') : fallback
    );
    set(
      'recoveryConversationId',
      typeof state?.conversationId === 'string' ? state.conversationId.slice(0, 8) : '\u2014'
    );
    set('recoveryAttempts', state ? `${state.attempts} / ${state.config.maxRetries}` : '\u2014');
    set('recoveryFailures', state ? String(state.failedAttempts) : '\u2014');
    set('recoveryLastSuccess', recoveryUiDate(state?.lastSuccessfulRecovery));
    set('recoveryNextRetry', recoveryUiDate(state?.nextRetryAt));
    set(
      'recoveryAttention',
      state ? (state.needsAttention || state.circuitOpen ? 'Needs your attention' : 'No attention needed') : fallback
    );
    set('recoveryReason', state ? recoveryUiLabel(RECOVERY_UI_REASONS, state.lastReason) : fallback);
    const error = document.getElementById('recoveryError');
    if (error) error.hidden = !view.error;
    const section = document.getElementById('recovery-tab');
    section?.setAttribute('aria-busy', String(view.busy || view.loading));
    const settings = document.getElementById('recoverySettings');
    if (settings) settings.disabled = !state || view.busy || view.loading;
    const refresh = document.getElementById('recoveryRefreshBtn');
    if (refresh) refresh.disabled = view.busy || view.loading;
    const retry = document.getElementById('recoveryRetryBtn');
    if (retry) {
      retry.disabled =
        !state ||
        view.busy ||
        view.loading ||
        state.circuitOpen ||
        !!state.inFlight ||
        !(
          ['interrupted', 'crashed'].includes(state.activity) ||
          (state.config.detectStalls && state.config.restartStalls && state.activity === 'working')
        ) ||
        ['managed-daemon', 'unsupported-location', 'unowned-session'].includes(state.lastReason);
    }
    const reset = document.getElementById('recoveryResetBtn');
    if (reset) reset.disabled = !state || view.busy || view.loading;
    const restoreRemote = document.getElementById('recoveryRestoreRemoteBtn');
    if (restoreRemote) {
      const session = this.sessions.get(view.sessionId);
      restoreRemote.hidden = !(
        session?.remote &&
        session.remote.owned !== false &&
        state?.lastReason === 'remote-session-missing'
      );
      restoreRemote.disabled = !state || view.busy || view.loading || !!state.inFlight;
    }

    for (const [key, field] of Object.entries(RECOVERY_UI_FIELDS)) {
      const input = document.getElementById(field.id);
      // Preserve an unsaved numeric edit during background status events.
      if (!input || (!forceSettings && input === document.activeElement && !field.boolean)) continue;
      if (field.boolean) input.checked = state?.config[key] ?? false;
      else input.value = state ? state.config[key] / field.scale : '';
    }

    const history = Array.isArray(state?.history) ? state.history.slice(-20).reverse() : [];
    const body = document.getElementById('recoveryHistory');
    if (body) {
      body.replaceChildren();
      for (const event of history) {
        const row = document.createElement('tr');
        const values = [
          recoveryUiDate(event.at),
          recoveryUiLabel(RECOVERY_UI_EVENTS, event.kind),
          recoveryUiLabel(RECOVERY_UI_REASONS, event.reason),
          String(event.attempt),
        ];
        values.forEach((value, index) => {
          const cell = document.createElement('td');
          if (index === 0 || index === 3) cell.dataset.i18nSkip = '';
          cell.textContent = value;
          row.appendChild(cell);
        });
        body.appendChild(row);
      }
    }
    const empty = document.getElementById('recoveryHistoryEmpty');
    if (empty) empty.hidden = history.length > 0;
    const wrap = document.getElementById('recoveryHistoryWrap');
    if (wrap) wrap.hidden = history.length === 0;
  },

  async saveRecoverySetting(key, input) {
    const view = this._recoveryView;
    if (!view?.state || view.busy || view.loading || this.editingSessionId !== view.sessionId) return;
    if (!Object.prototype.hasOwnProperty.call(RECOVERY_UI_FIELDS, key)) return;
    const field = RECOVERY_UI_FIELDS[key];
    if (input !== document.getElementById(field.id)) return;
    const value = field.boolean ? input.checked : Number(input.value) * field.scale;
    if (!field.boolean && (!input.checkValidity() || !input.value || !Number.isSafeInteger(value))) {
      this.showToast('Choose a recovery value within the displayed limits', 'warning');
      this._renderRecoveryStatus(true);
      return;
    }
    const merged = { ...view.state.config, [key]: value };
    if (merged.maxRetryDelayMs < merged.retryDelayMs) {
      this.showToast('Maximum retry delay must be at least the retry delay', 'warning');
      this._renderRecoveryStatus(true);
      return;
    }
    await this._performRecoveryRequest('config', 'PUT', { [key]: value });
  },

  async retryRecovery() {
    const button = document.getElementById('recoveryRetryBtn');
    if (!button || button.disabled) return;
    await this._performRecoveryRequest('retry', 'POST');
  },

  async resetRecovery() {
    const button = document.getElementById('recoveryResetBtn');
    if (!button || button.disabled) return;
    await this._performRecoveryRequest('reset', 'POST');
  },

  async restoreRemoteRecovery() {
    const button = document.getElementById('recoveryRestoreRemoteBtn');
    if (!button || button.disabled || button.hidden) return;
    await this._performRecoveryRequest('restore-remote', 'POST');
  },

  async _performRecoveryRequest(action, method, body) {
    const view = this._recoveryView;
    if (!view?.state || view.busy || view.loading || this.editingSessionId !== view.sessionId) return;
    if (!this.supportsSessionRecovery(this.sessions.get(view.sessionId))) return;
    const revision = view.revision;
    view.busy = true;
    this._renderRecoveryStatus();
    const state = await this._apiJson(`/api/sessions/${encodeURIComponent(view.sessionId)}/recovery/${action}`, {
      method,
      ...(body === undefined ? {} : { body }),
    });
    if (this._recoveryView !== view) return;
    view.busy = false;
    if (state?.version === 1 && state.config) {
      if (view.revision === revision) view.state = state;
    } else {
      this.showToast('Recovery action failed. Refresh status before trying again.', 'error');
    }
    this._renderRecoveryStatus(true);
  },
});
