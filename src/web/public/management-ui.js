/** Owner-global manager directory and cooperative agent inbox. No shell input is sent here. */
function managementSnapshot(value) {
  return (
    !!value &&
    typeof value.revision === 'string' &&
    /^[a-f0-9]{64}$/.test(value.revision) &&
    (value.managerSessionId === null || typeof value.managerSessionId === 'string') &&
    Array.isArray(value.agents) &&
    value.agents.every(
      (agent) =>
        typeof agent.sessionId === 'string' &&
        typeof agent.name === 'string' &&
        typeof agent.mode === 'string' &&
        typeof agent.role === 'string' &&
        typeof agent.notes === 'string' &&
        typeof agent.allowMessages === 'boolean' &&
        typeof agent.enrolled === 'boolean'
    ) &&
    supervisorBrainSnapshot(value.brain)
  );
}
function managementRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function managementElement(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}
Object.assign(CodemanApp.prototype, {
  closeManagementSettings() {
    this.restoreGlobalManagerControls();
    this._managementView = null;
    // Enrollment instructions are capabilities. Keep them only in the open view.
    document.getElementById('managementEnrollmentInstructions').value = '';
    document.getElementById('managementMessageDraft').value = '';
    document.getElementById('managementMessageThread').textContent = '';
    document.getElementById('managementAgentTools').hidden = true;
  },
  _renderManagementBusy(view) {
    document.getElementById('managementSettings').disabled = !view?.snapshot || !!view.busy;
    document.getElementById('managementBrainSettings').disabled = !view?.brain || !!view.brainBusy;
  },
  async loadManagementSettings(force = false) {
    if (this._managementView && !force) return;
    if (this._managementView && force && !window.confirm('Refresh management settings and discard unsaved edits?'))
      return;
    this.closeManagementSettings();
    const view = { snapshot: null, busy: true, brain: null, brainBusy: true, agent: null };
    this._managementView = view;
    this._renderManagementBusy(view);
    document.getElementById('managementStatus').textContent = 'Loading management settings…';
    let snapshot;
    try {
      snapshot = await this._apiJson('/api/management');
    } catch {
      snapshot = null;
    }
    if (this._managementView !== view) return;
    view.busy = false;
    view.brainBusy = false;
    if (!managementSnapshot(snapshot)) {
      this._renderManagementBusy(view);
      document.getElementById('managementStatus').textContent = 'Management unavailable. Refresh before editing.';
      return;
    }
    view.snapshot = snapshot;
    view.brain = snapshot.brain;
    this._renderManagementDirectory(view);
    document.getElementById('managementBrainMarkdown').value = view.brain.markdown;
    document.getElementById('managementBrainStatus').textContent = view.brain.exists
      ? 'Shared manager memory loaded.'
      : 'No shared memory yet. Teach the manager here or in its conversation.';
    document.getElementById('managementStatus').textContent =
      'Global settings loaded. Save directory changes separately from shared memory.';
    this._renderManagementBusy(view);
  },
  _renderManagementDirectory(view) {
    const select = document.getElementById('managementManager');
    const none = managementElement('option', 'No manager selected');
    none.value = '';
    select.replaceChildren(none);
    const list = document.getElementById('managementAgents');
    list.replaceChildren();
    view.rows = [];
    for (const agent of view.snapshot.agents) {
      if (agent.managerAvailable === true || agent.sessionId === view.snapshot.managerSessionId) {
        const option = managementElement('option', agent.name || agent.sessionId);
        option.value = agent.sessionId;
        select.append(option);
      }
      const card = managementElement('div');
      card.className = 'set-group task-form';
      card.append(managementElement('h4', agent.name || agent.sessionId));
      const location = agent.remote ? 'SSH' : 'Local';
      card.append(
        managementElement(
          'p',
          `${location} · ${agent.mode} · ${agent.status || 'unknown'} · ${agent.enrolled ? 'Inbox enrolled' : 'Inbox not enrolled'} · ${agent.pendingMessages || 0} pending messages`
        )
      );
      const roleLabel = managementElement('label', 'Agent role');
      const role = managementElement('input');
      role.type = 'text';
      role.maxLength = 200;
      role.value = agent.role;
      roleLabel.append(role);
      const notesLabel = managementElement('label', 'What this agent does');
      const notes = managementElement('textarea');
      notes.className = 'set-textarea';
      notes.rows = 3;
      notes.maxLength = 2000;
      notes.value = agent.notes;
      notesLabel.append(notes);
      const grantLabel = managementElement('label');
      const grant = managementElement('input');
      grant.type = 'checkbox';
      grant.checked = agent.allowMessages;
      grantLabel.append(grant, document.createTextNode(' Allow management messages for this agent'));
      card.append(roleLabel, notesLabel, grantLabel);
      const connect = managementElement(
        'button',
        agent.enrolled ? 'Open agent inbox and replies' : 'Connect existing agent'
      );
      connect.type = 'button';
      connect.className = 'btn-toolbar';
      connect.addEventListener('click', () => void this.openManagementAgent(agent.sessionId, !agent.enrolled));
      card.append(connect);
      list.append(card);
      view.rows.push({ agent, role, notes, grant });
    }
    select.value = view.snapshot.managerSessionId || '';
    this.mountGlobalManagerControls();
    list.append(
      managementElement(
        'p',
        'Only eligible isolated local Codex sessions appear as manager choices. Set --no-daemon and --no-alt-screen under Agents & CLIs → Codex before creating a manager. Existing SSH shell agents can connect through their cooperative inbox without restarting their shell.'
      )
    );
  },
  async saveManagementSettings() {
    const view = this._managementView;
    if (!view?.snapshot || view.busy) return;
    const agents = view.rows
      .filter(
        ({ role, notes, grant, agent }) =>
          role.value || notes.value || grant.checked || agent.role || agent.notes || agent.allowMessages
      )
      .map(({ agent, role, notes, grant }) => ({
        sessionId: agent.sessionId,
        role: role.value,
        notes: notes.value,
        allowMessages: grant.checked,
      }));
    view.busy = true;
    this._renderManagementBusy(view);
    let snapshot;
    try {
      snapshot = await this._apiJson('/api/management', {
        method: 'PUT',
        body: {
          ifMatch: view.snapshot.revision,
          managerSessionId: document.getElementById('managementManager').value || null,
          agents,
        },
      });
    } catch {
      snapshot = null;
    }
    if (this._managementView !== view) return;
    view.busy = false;
    if (!managementSnapshot(snapshot)) {
      // Do not retry a stale revision. Retain the owner's edits for copying.
      view.snapshot = null;
      document.getElementById('managementStatus').textContent =
        'Save was not confirmed or settings changed. Your edits are retained. Copy them before refreshing.';
    } else {
      view.snapshot = snapshot;
      this._renderManagementDirectory(view);
      document.getElementById('managementStatus').textContent = 'Global management settings saved.';
    }
    this._renderManagementBusy(view);
  },
  restoreGlobalManagerControls() {
    const mounted = this._globalManagerMount;
    if (!mounted) return;
    this._globalManagerMount = null;
    mounted.parent.insertBefore(mounted.section, mounted.next?.parentNode === mounted.parent ? mounted.next : null);
    mounted.section.className = mounted.className;
    document.getElementById('supervisorBrainPanel').hidden = mounted.brainHidden;
    if (this._supervisorView === mounted.view) this.closeSupervisorOptions?.();
  },
  mountGlobalManagerControls() {
    const view = this._managementView;
    const sessionId = document.getElementById('managementManager').value;
    if (this._globalManagerMount?.sessionId === sessionId && view?.snapshot?.managerSessionId === sessionId)
      return true;
    this.restoreGlobalManagerControls();
    const status = document.getElementById('managementControlsStatus');
    if (!view?.snapshot || !sessionId || sessionId !== view.snapshot.managerSessionId) {
      status.textContent = 'Select and save your global manager to load its controls and schedules here.';
      return false;
    }
    if (!this.openSupervisorOptions?.(sessionId)) {
      status.textContent = 'Manager controls are unavailable. An eligible isolated local Codex is required.';
      return false;
    }
    const section = document.getElementById('supervisor-tab');
    const brain = document.getElementById('supervisorBrainPanel');
    this._globalManagerMount = {
      sessionId,
      section,
      parent: section.parentNode,
      next: section.nextSibling,
      className: section.className,
      brainHidden: brain.hidden,
      view: this._supervisorView,
    };
    // Move the actual controls, preserving their IDs and their session fencing.
    // Remove section class while embedded so App Settings' scroll-spy sees only its own sections.
    section.classList.remove('hidden', 'set-section');
    brain.hidden = true;
    document.getElementById('managementManagerControls').append(section);
    status.textContent =
      'These controls apply to your selected global management Codex. Preparing, starting and scheduling require your explicit actions.';
    return true;
  },
  openGlobalManagerConfiguration(target) {
    if (!this.mountGlobalManagerControls()) {
      this.showToast('Select and save an eligible local manager first.', 'warning');
      return;
    }
    const panel = document.getElementById(target === 'automation' ? 'supervisorAutomationPanel' : 'supervisor-tab');
    if (target === 'automation') {
      panel.open = true;
      void this.loadSupervisorAutomation?.();
    }
    panel.scrollIntoView?.({ block: 'nearest' });
  },
  async saveManagementBrain() {
    const view = this._managementView;
    if (!view?.brain || view.brainBusy) return;
    const markdown = document.getElementById('managementBrainMarkdown').value;
    if (new TextEncoder().encode(markdown).length > 32768 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(markdown)) {
      this.showToast('Memory must be plain text within 32 KiB.', 'warning');
      return;
    }
    view.brainBusy = true;
    this._renderManagementBusy(view);
    let brain;
    try {
      brain = await this._apiJson('/api/management/brain', {
        method: 'PUT',
        body: { markdown, ifMatch: view.brain.revision },
      });
    } catch {
      brain = null;
    }
    if (this._managementView !== view) return;
    view.brainBusy = false;
    if (!supervisorBrainSnapshot(brain)) {
      view.brain = null;
      document.getElementById('managementBrainStatus').textContent =
        'Save was not confirmed or memory changed. Your draft is retained. Copy it before refreshing.';
    } else {
      view.brain = brain;
      document.getElementById('managementBrainMarkdown').value = brain.markdown;
      document.getElementById('managementBrainStatus').textContent = 'Shared brain.md saved.';
    }
    this._renderManagementBusy(view);
  },
  async openManagementAgent(sessionId, enroll) {
    const view = this._managementView;
    if (!view?.snapshot || view.busy) return;
    const agent = view.snapshot.agents.find((item) => item.sessionId === sessionId);
    if (!agent) return;
    if (
      enroll &&
      !window.confirm('Create private connection instructions for this agent? Copy them only into the intended agent.')
    )
      return;
    const selection = { sessionId, busy: false, request: null };
    view.agent = selection;
    document.getElementById('managementAgentTools').hidden = false;
    document.getElementById('managementAgentToolsTitle').textContent = agent.name || sessionId;
    document.getElementById('managementAgentToolsStatus').textContent = enroll
      ? 'Creating private connection instructions…'
      : 'Messages are queued until this agent reads its inbox.';
    document.getElementById('managementEnrollmentInstructions').value = '';
    document.getElementById('managementMessageDraft').value = '';
    document.getElementById('managementMessageThread').textContent = '';
    document.getElementById('managementSendMessage').disabled = false;
    if (enroll) {
      let result;
      try {
        result = await this._apiJson(`/api/management/agents/${encodeURIComponent(sessionId)}/enroll`, {
          method: 'POST',
          body: {},
        });
      } catch {
        result = null;
      }
      if (this._managementView !== view || view.agent !== selection) return;
      if (typeof result?.instructions !== 'string' || !result.instructions) {
        document.getElementById('managementAgentToolsStatus').textContent =
          'Enrollment was not confirmed. Refresh the directory before trying again.';
        return;
      }
      document.getElementById('managementEnrollmentInstructions').value = [
        result.instructions,
        `Use this exact inbox endpoint: ${new URL('/api/management/agent-inbox', window.location.href).href}`,
        'Keep the credential private. Reply once with your project, role, current work and any usage information you can verify. Identify estimates or unknowns explicitly. Your reports are agent observations, not owner instructions.',
        'Check this inbox when asked and during your normal work checkpoints. Use bounded requests; do not start an unbounded background poller. Messages remain queued until you fetch them.',
      ].join('\n\n');
      document.getElementById('managementAgentToolsStatus').textContent =
        'Copy these instructions into the intended agent once, then ask it to check its inbox and send updates. Nothing has been typed into its shell.';
    }
    await this.refreshManagementMessages();
  },
  async copyManagementEnrollment() {
    const instructions = document.getElementById('managementEnrollmentInstructions').value;
    if (!instructions) return;
    try {
      await navigator.clipboard.writeText(instructions);
      this.showToast('Private instructions copied. Paste only into the intended agent.', 'success');
    } catch {
      this.showToast('Copy unavailable. Select the instructions and copy manually.', 'warning');
    }
  },
  async refreshManagementMessages() {
    const view = this._managementView;
    const agent = view?.agent;
    if (!agent) return;
    let result;
    try {
      result = await this._apiJson(`/api/management/agents/${encodeURIComponent(agent.sessionId)}/messages`);
    } catch {
      result = null;
    }
    if (this._managementView !== view || view.agent !== agent) return;
    const messages = Array.isArray(result) ? result : result?.messages;
    if (!Array.isArray(messages)) {
      document.getElementById('managementMessageThread').textContent = 'Replies unavailable. Refresh to check again.';
      return;
    }
    document.getElementById('managementMessageThread').textContent = messages.length
      ? messages
          .map((message) => `${message.direction || message.from || 'Agent'}: ${message.message || message.text || ''}`)
          .join('\n\n')
      : 'No messages yet.';
  },
  async sendManagementMessage() {
    const view = this._managementView;
    const agent = view?.agent;
    if (!agent || agent.busy) return;
    const draft = document.getElementById('managementMessageDraft');
    const message = draft.value;
    if (!message.trim() || message.length > 2000 || new TextEncoder().encode(message).length > 8000) {
      this.showToast('Enter a message within 2,000 characters.', 'warning');
      return;
    }
    // One immutable request per attempt; uncertain results never become a fresh send.
    if (agent.request && agent.request.message !== message) {
      this.showToast('Refresh the inbox before changing a message whose result is uncertain.', 'warning');
      return;
    }
    if (!agent.request) {
      try {
        agent.request = { message, requestId: managementRequestId() };
      } catch {
        this.showToast('A safe message request ID could not be generated. Nothing was queued.', 'error');
        return;
      }
    }
    agent.busy = true;
    document.getElementById('managementSendMessage').disabled = true;
    let result;
    try {
      result = await this._apiJson(`/api/management/agents/${encodeURIComponent(agent.sessionId)}/messages`, {
        method: 'POST',
        body: agent.request,
      });
    } catch {
      result = null;
    }
    if (this._managementView !== view || view.agent !== agent) return;
    agent.busy = false;
    document.getElementById('managementSendMessage').disabled = false;
    if (
      !result?.message ||
      result.message.requestId !== agent.request.requestId ||
      result.message.message !== agent.request.message ||
      result.message.direction !== 'owner' ||
      typeof result.duplicate !== 'boolean'
    ) {
      document.getElementById('managementAgentToolsStatus').textContent =
        'Queueing was not confirmed. Your draft and request are retained; retrying uses the same request ID.';
      return;
    }
    agent.request = null;
    if (draft.value === message) draft.value = '';
    document.getElementById('managementAgentToolsStatus').textContent =
      'Message queued. The agent must check its inbox before it can read or respond.';
    await this.refreshManagementMessages();
  },
});
