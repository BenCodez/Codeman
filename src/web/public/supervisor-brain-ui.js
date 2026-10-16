/** Owner editor for one manager's private persistent brain.md. Loaded after supervisor-ui.js. */
function supervisorBrainSnapshot(value) {
  return (
    !!value &&
    typeof value.markdown === 'string' &&
    new TextEncoder().encode(value.markdown).length <= 32768 &&
    typeof value.revision === 'string' &&
    /^[a-f0-9]{64}$/.test(value.revision) &&
    typeof value.exists === 'boolean' &&
    Number.isInteger(value.noteCount) &&
    value.noteCount >= 0 &&
    value.noteCount <= 64
  );
}
Object.assign(CodemanApp.prototype, {
  _renderSupervisorBrainBusy() {
    const view = this._supervisorView;
    document.getElementById('supervisorBrainSettings').disabled = !view?.brain || !!view.brainBusy;
  },
  async loadSupervisorBrain(force = false) {
    const view = this._supervisorView;
    if (!view || view.brainBusy || (view.brain && !force)) return;
    view.brainBusy = true;
    this._renderSupervisorBrainBusy();
    let brain;
    try {
      brain = await this._apiJson(`/api/sessions/${encodeURIComponent(view.sessionId)}/supervisor/brain`);
    } catch {
      brain = null;
    }
    if (this._supervisorView !== view) return;
    view.brainBusy = false;
    view.brain = supervisorBrainSnapshot(brain) ? brain : null;
    this._renderSupervisorBrainBusy();
    const status = document.getElementById('supervisorBrainStatus');
    if (!view.brain) {
      status.textContent = supervisorUiTranslate('Memory unavailable. Refresh before editing.');
      return;
    }
    document.getElementById('supervisorBrainMarkdown').value = brain.markdown;
    status.textContent = supervisorUiTranslate(
      brain.exists
        ? 'Persistent manager memory loaded.'
        : 'No memory saved yet. Teach the manager here or in its conversation.'
    );
  },
  async saveSupervisorBrain() {
    const view = this._supervisorView;
    if (!view?.brain || view.brainBusy) return;
    const markdown = document.getElementById('supervisorBrainMarkdown').value;
    if (new TextEncoder().encode(markdown).length > 32768 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(markdown)) {
      this.showToast(supervisorUiTranslate('Memory must be plain text within 32 KiB.'), 'warning');
      return;
    }
    view.brainBusy = true;
    this._renderSupervisorBrainBusy();
    let brain;
    try {
      brain = await this._apiJson(`/api/sessions/${encodeURIComponent(view.sessionId)}/supervisor/brain`, {
        method: 'PUT',
        body: { markdown, ifMatch: view.brain.revision },
      });
    } catch {
      brain = null;
    }
    if (this._supervisorView !== view) return;
    view.brainBusy = false;
    if (!supervisorBrainSnapshot(brain)) {
      view.brain = null;
      this._renderSupervisorBrainBusy();
      document.getElementById('supervisorBrainStatus').textContent = supervisorUiTranslate(
        'Save was not confirmed or memory changed. Your draft is retained. Copy it before refreshing.'
      );
      return;
    }
    view.brain = brain;
    this._renderSupervisorBrainBusy();
    document.getElementById('supervisorBrainMarkdown').value = brain.markdown;
    document.getElementById('supervisorBrainStatus').textContent = supervisorUiTranslate('Manager memory saved.');
  },
});
