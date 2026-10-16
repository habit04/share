import type { Editor } from '../app/editor/editor';
import { AiAskController, type AiAskStatus } from '../ai/ask-controller';
import { AiDraftController, type AiDraftStatus } from '../ai/draft-controller';
import { captureDraftContext, type AiDraftSource } from '../ai/draft-context';
import { createEditorAiSource } from '../ai/editor-source';
import { createEditorAiDraftSource } from '../ai/editor-draft-source';
import { previewSets } from '../ai/draft-compiler';
import { FixtureProvider } from '../ai/fixture-provider';
import { FixtureDraftProvider } from '../ai/fixture-draft';
import { LiveProvider, LiveDraftProvider } from '../ai/live-provider';
import { serializeSnapshot } from '../ai/snapshot';
import { INSUNIT_NAMES } from '../core/units';
import type { WindowAiConnection, AiConnectionState } from '../ai/host-bridge';
import { AiError, type AiBinding, type AiDraftProvider, type AiProvider, type AiSnapshot } from '../ai/types';
import { icon } from './icons';

/**
 * “Ask about selected objects” palette (docs/AI-ASSISTANT.md, milestone 2
 * in docs/AI-ASSISTANT-M2.md).
 *
 * Strictly read-only: it reads the editor through the AI snapshot source,
 * never dispatches a command (so it can never cancel the current tool),
 * never writes selection/document/undo/dirty state, and renders every
 * dynamic string — drawing text, questions, answers, host state — through
 * textContent. The only innerHTML uses are the compile-time icon markup
 * every palette uses for its strip, and clearing containers with ''.
 *
 * Milestone 2 adds the connection section when the Electron host bridge
 * is present: host-authoritative provider/model state, a password field
 * whose value is cleared immediately after submission, session-only key
 * storage by default with opt-in encrypted persistence, Test Connection,
 * Replace/Forget Key, and an explicit Enable Live AI control. Without a
 * bridge (plain browser) the panel is exactly the milestone-1 demo.
 */

/** Display labels + model presets per provider (host ids stay authoritative). */
const PROVIDER_LABELS: Readonly<Record<string, string>> = { openai: 'OpenAI', anthropic: 'Anthropic' };
const MODEL_PRESETS: Readonly<Record<string, readonly string[]>> = {
  openai: ['gpt-5', 'gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-luna'],
  anthropic: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
};

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

const OFFLINE_LABEL = 'Offline demo — no AI model connected. Responses are generated locally; nothing is sent outside JCad.';

function billingNote(provider: string): string {
  const label = providerLabel(provider);
  return `Questions are billed to your ${label} API account. Cancelling stops JCad from waiting, but a request already processing at ${label} may still be charged.`;
}

function retentionNote(provider: string): string {
  if (provider === 'anthropic') {
    return 'Requests go directly to Anthropic. Anthropic does not train on API inputs or outputs; standard API retention applies — this is not zero retention.';
  }
  return 'Requests set store: false, so responses are not stored as API application state. That is not zero retention: OpenAI states API data is not used for training unless you opt in, while abuse-monitoring logs may retain prompts and responses for up to 30 days.';
}

function probeNote(provider: string): string {
  return `Test Connection makes a real ${providerLabel(provider)} API call with a fixed message and no drawing content. It may incur a small charge on your account.`;
}

function credentialNote(problem: string): string {
  if (problem === 'credential-corrupt') return 'API key: saved key cannot be decrypted. Replace or forget it.';
  if (problem === 'credential-rollback-failed') return 'API key: the previous key update could not be restored. Replace or forget it.';
  return 'API key: unavailable. Replace or forget it before enabling Live AI.';
}

export class AiAssistantPanel {
  readonly el: HTMLElement;
  private readonly controller: AiAskController;
  private readonly editorRef: Editor;
  private readonly unsubscribes: Array<() => void> = [];

  // Milestone 3 Draft / Edit state.
  private readonly draftController: AiDraftController;
  private readonly draftSource: AiDraftSource;
  private readonly fixtureDraftProvider = new FixtureDraftProvider();
  private mode: 'ask' | 'draft' = 'ask';
  private applyingDraft = false;
  private askSectionEl: HTMLElement | null = null;
  private draftEls: {
    section: HTMLElement;
    askTab: HTMLButtonElement;
    draftTab: HTMLButtonElement;
    summaryEl: HTMLElement;
    sentLabelEl: HTMLElement;
    sentEl: HTMLElement;
    promptEl: HTMLTextAreaElement;
    generateBtn: HTMLButtonElement;
    cancelBtn: HTMLButtonElement;
    statusEl: HTMLElement;
    changesEl: HTMLElement;
    applyBtn: HTMLButtonElement;
    discardBtn: HTMLButtonElement;
    fitBtn: HTMLButtonElement;
  } | null = null;
  private readonly summaryEl: HTMLElement;
  private readonly sentEl: HTMLElement;
  private readonly sentLabelEl: HTMLElement;
  private readonly questionEl: HTMLTextAreaElement;
  private readonly askBtn: HTMLButtonElement;
  private readonly cancelBtn: HTMLButtonElement;
  private readonly statusEl: HTMLElement;
  private readonly answerEl: HTMLElement;
  private readonly refsEl: HTMLElement;
  private readonly providerLabelEl: HTMLElement;
  private readonly billingEl: HTMLElement;
  private readonly usageEl: HTMLElement;
  private answerBinding: AiBinding | null = null;

  // Milestone 2 connection state (present only with a host bridge).
  private readonly connection: WindowAiConnection | null;
  private readonly fixtureProvider = new FixtureProvider();
  private liveProvider: LiveProvider | null = null;
  private connState: AiConnectionState | null = null;
  private settingsEls: {
    providerSelect: HTMLSelectElement;
    modelSelect: HTMLSelectElement; modelCustom: HTMLInputElement;
    keyLabel: HTMLElement;
    keyInput: HTMLInputElement; persistSession: HTMLInputElement; persistEncrypted: HTMLInputElement;
    saveKeyBtn: HTMLButtonElement; forgetKeyBtn: HTMLButtonElement; testBtn: HTMLButtonElement;
    probeNoteEl: HTMLElement; retentionEl: HTMLElement;
    enableCheck: HTMLInputElement; stateEl: HTMLElement; errorEl: HTMLElement;
  } | null = null;
  /** Provider the settings controls were last rendered for (preset rebuilds). */
  private renderedProvider: string | null = null;
  private connectionBusy = false;
  private connectionEpoch = 0;
  private disposed = false;

  constructor(editor: Editor, container: HTMLElement, provider?: AiProvider, connection?: WindowAiConnection | null) {
    this.el = container;
    this.editorRef = editor;
    this.el.className = 'palette ai-assistant hidden';
    this.connection = connection ?? null;
    // Buttons and other focused descendants need the same boundary as the
    // textarea: Enter/Delete/Escape must never reach global CAD shortcuts.
    this.el.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Escape') {
        ev.preventDefault();
        this.controller.cancel();
        this.draftController?.cancel();
      }
    });

    const strip = document.createElement('div');
    strip.className = 'palette-strip';
    strip.innerHTML = `<span class="palette-strip-btns">${icon('close')}${icon('pin')}</span><span class="palette-strip-title">AI Assistant</span>`;
    strip.querySelector('svg')?.addEventListener('click', () => this.hide());

    const body = document.createElement('div');
    body.className = 'palette-body';
    const bar = document.createElement('div');
    bar.className = 'palette-titlebar';
    const title = document.createElement('span');
    title.className = 'palette-title';
    title.textContent = 'AI Assistant';
    bar.append(title);

    const content = document.createElement('div');
    content.className = 'ai-body';
    this.providerLabelEl = document.createElement('div');
    this.providerLabelEl.className = 'ai-provider';
    this.providerLabelEl.textContent = OFFLINE_LABEL;

    this.summaryEl = document.createElement('div');
    this.summaryEl.className = 'ai-summary';

    this.sentLabelEl = document.createElement('div');
    this.sentLabelEl.className = 'ai-section-label';
    this.sentLabelEl.textContent = 'What will be sent (exactly)';
    this.sentEl = document.createElement('pre');
    this.sentEl.className = 'ai-sent';

    this.questionEl = document.createElement('textarea');
    this.questionEl.className = 'ai-question';
    this.questionEl.placeholder = 'Ask about the selected objects…';
    this.questionEl.rows = 3;
    // Keep keystrokes out of the canvas/command line (Properties pattern),
    // and never let Enter reach a command path: it just asks.
    this.questionEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        void this.ask();
      }
    });

    const buttons = document.createElement('div');
    buttons.className = 'ai-buttons';
    this.askBtn = document.createElement('button');
    this.askBtn.className = 'ai-ask';
    this.askBtn.textContent = 'Ask';
    this.askBtn.addEventListener('click', () => { void this.ask(); });
    this.cancelBtn = document.createElement('button');
    this.cancelBtn.className = 'ai-cancel';
    this.cancelBtn.textContent = 'Cancel';
    this.cancelBtn.disabled = true;
    this.cancelBtn.addEventListener('click', () => this.controller.cancel());
    buttons.append(this.askBtn, this.cancelBtn);

    this.billingEl = document.createElement('div');
    this.billingEl.className = 'ai-note';
    this.billingEl.textContent = billingNote('openai');
    this.billingEl.classList.add('hidden');

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'ai-status';
    this.answerEl = document.createElement('div');
    this.answerEl.className = 'ai-answer';
    this.refsEl = document.createElement('div');
    this.refsEl.className = 'ai-refs';
    this.usageEl = document.createElement('div');
    this.usageEl.className = 'ai-refs';

    const askSection = document.createElement('div');
    askSection.className = 'ai-section-wrap';
    this.askSectionEl = askSection;
    askSection.append(
      this.providerLabelEl, this.summaryEl, this.sentLabelEl, this.sentEl, this.questionEl,
      buttons, this.billingEl, this.statusEl, this.answerEl, this.refsEl, this.usageEl,
    );
    const draftBuilt = this.buildDraftSection();
    content.append(draftBuilt.tabs, askSection, draftBuilt.section);
    if (this.connection) content.append(this.buildSettingsSection());
    body.append(bar, content);
    this.el.append(body, strip);

    // With a bridge, questions route per host state at ask time: live only
    // when the host reports enabled + a key present; otherwise the offline
    // fixture demo answers and nothing leaves the machine.
    const routed: AiProvider = this.connection
      ? {
          get id() { return 'router'; },
          ask: (request, signal) => this.routeProvider().ask(request, signal),
        }
      : (provider ?? this.fixtureProvider);
    this.controller = new AiAskController(createEditorAiSource(editor), routed);
    this.unsubscribes.push(this.controller.subscribe((status) => this.renderStatus(status)));
    this.draftSource = createEditorAiDraftSource(editor);
    this.draftController = new AiDraftController(this.draftSource, editor.doc);
    this.unsubscribes.push(this.draftController.subscribe((status) => this.renderDraftStatus(status)));
    // Rebuild the preview when the selection or document changes. The events
    // are only a hint — the controller re-reads and compares the binding
    // before showing any answer.
    for (const ev of ['selection', 'change', 'file', 'space'] as const) {
      this.unsubscribes.push(editor.on(ev, () => this.refreshPreview()));
    }
    // Draft invalidation mirrors the binding: any editor change, selection
    // change, space/file change or tool start drops a staged proposal. The
    // one exception is the change our own Apply commits, which is guarded
    // by applyingDraft (the proposal is consumed, not invalidated).
    for (const ev of ['selection', 'change', 'file', 'space', 'tool'] as const) {
      this.unsubscribes.push(editor.on(ev, () => {
        if (this.applyingDraft) return;
        const state = this.draftController.status.state;
        if (state === 'staged' || state === 'generating') this.draftController.invalidate();
        if (this.mode === 'draft') this.refreshDraftPreview();
      }));
    }
    this.renderStatus(this.controller.status);
    this.updateSettingsAvailability();
  }

  toggle(): void {
    if (this.disposed) return;
    if (this.isVisible) { this.hide(); return; }
    this.el.classList.remove('hidden');
    this.refreshPreview();
    if (this.isVisible) {
      this.questionEl.focus();
      void this.refreshConnection();
    }
  }

  get isVisible(): boolean {
    return !this.el.classList.contains('hidden');
  }

  dispose(): void {
    this.disposed = true;
    this.connectionEpoch += 1;
    this.clearKeyInput();
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
    this.controller.dispose();
    this.draftController.dispose();
    this.clearDraftOverlay();
  }

  // ------------------------------------------------------------ Draft / Edit (milestone 3)

  private buildDraftSection(): { tabs: HTMLElement; section: HTMLElement } {
    const tabs = document.createElement('div');
    tabs.className = 'ai-modes';
    const askTab = document.createElement('button');
    askTab.className = 'ai-mode-btn active';
    askTab.textContent = 'Ask';
    const draftTab = document.createElement('button');
    draftTab.className = 'ai-mode-btn';
    draftTab.textContent = 'Draft / Edit';
    askTab.addEventListener('click', () => this.setMode('ask'));
    draftTab.addEventListener('click', () => this.setMode('draft'));
    tabs.append(askTab, draftTab);

    const section = document.createElement('div');
    section.className = 'ai-section-wrap ai-draft hidden';
    const summaryEl = document.createElement('div');
    summaryEl.className = 'ai-summary';
    const sentLabelEl = document.createElement('div');
    sentLabelEl.className = 'ai-section-label';
    sentLabelEl.textContent = 'What will be sent (exactly)';
    const sentEl = document.createElement('pre');
    sentEl.className = 'ai-sent';
    const promptEl = document.createElement('textarea');
    promptEl.className = 'ai-question';
    promptEl.placeholder = 'Describe the drawing or edit…';
    promptEl.rows = 3;
    // Prompt edits invalidate a staged proposal: what was approved was a
    // plan for the previous wording. Enter never generates or applies —
    // generation is the button below, deliberately.
    promptEl.addEventListener('input', () => {
      if (this.draftController.status.state === 'staged') {
        this.draftController.invalidate('The description changed — generate again.');
      }
      this.refreshDraftPreview();
    });
    const buttons = document.createElement('div');
    buttons.className = 'ai-buttons';
    const generateBtn = document.createElement('button');
    generateBtn.className = 'ai-ask';
    generateBtn.textContent = 'Generate Preview';
    generateBtn.addEventListener('click', () => { void this.generateDraft(); });
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'ai-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.disabled = true;
    cancelBtn.addEventListener('click', () => this.draftController.cancel());
    buttons.append(generateBtn, cancelBtn);

    const legend = document.createElement('div');
    legend.className = 'ai-legend';
    const swatch = (color: string, label: string, dashed: boolean): void => {
      const box = document.createElement('span');
      box.className = dashed ? 'ai-swatch dashed' : 'ai-swatch';
      box.style.background = color;
      const text = document.createElement('span');
      text.textContent = label;
      legend.append(box, text);
    };
    swatch('#3fb950', 'New', false);
    swatch('#e8a13a', 'New position', false);
    swatch('#9aa4ad', 'Original', true);
    swatch('#e5534b', 'Deleted', true);

    const statusEl = document.createElement('div');
    statusEl.className = 'ai-status';
    const changesEl = document.createElement('div');
    changesEl.className = 'ai-changes';
    const actions = document.createElement('div');
    actions.className = 'ai-buttons';
    const applyBtn = document.createElement('button');
    applyBtn.className = 'ai-ask';
    applyBtn.textContent = 'Apply Changes';
    applyBtn.disabled = true;
    applyBtn.addEventListener('click', () => this.applyDraft());
    const discardBtn = document.createElement('button');
    discardBtn.textContent = 'Discard';
    discardBtn.disabled = true;
    discardBtn.addEventListener('click', () => this.draftController.discard());
    const fitBtn = document.createElement('button');
    fitBtn.textContent = 'Fit Preview';
    fitBtn.disabled = true;
    fitBtn.addEventListener('click', () => this.fitDraftPreview());
    actions.append(applyBtn, discardBtn, fitBtn);

    section.append(summaryEl, sentLabelEl, sentEl, promptEl, buttons, legend, statusEl, changesEl, actions);
    this.draftEls = {
      section, askTab, draftTab, summaryEl, sentLabelEl, sentEl, promptEl,
      generateBtn, cancelBtn, statusEl, changesEl, applyBtn, discardBtn, fitBtn,
    };
    return { tabs, section };
  }

  private setMode(mode: 'ask' | 'draft'): void {
    if (!this.draftEls || this.mode === mode) return;
    this.mode = mode;
    // Leaving Draft drops any staged proposal and its overlay.
    this.draftController.invalidate();
    this.clearDraftOverlay();
    this.draftEls.askTab.classList.toggle('active', mode === 'ask');
    this.draftEls.draftTab.classList.toggle('active', mode === 'draft');
    this.draftEls.section.classList.toggle('hidden', mode !== 'draft');
    this.askSectionEl?.classList.toggle('hidden', mode !== 'ask');
    if (mode === 'draft') this.refreshDraftPreview();
    else this.refreshPreview();
  }

  private draftConfigKey(): string {
    const s = this.connState;
    if (!s) return 'fixture';
    return [s.provider, s.model, s.enabled, s.keyPresent, s.keySource ?? '', s.keyPersistence, s.credentialProblem ?? ''].join('|');
  }

  private routeDraftProvider(): AiDraftProvider {
    if (this.connection && this.connState?.enabled && this.connState.keyPresent && !this.connState.credentialProblem) {
      return new LiveDraftProvider(this.connection.bridge, { providerId: this.connState.provider, model: this.connState.model });
    }
    return this.fixtureDraftProvider;
  }

  private async generateDraft(): Promise<void> {
    if (this.disposed || this.connectionBusy || !this.draftEls) return;
    if (this.editorRef.interactionBusy) {
      this.draftEls.statusEl.textContent = 'Finish the current command or selection first, then generate a preview.';
      return;
    }
    await this.draftController.generate(this.draftEls.promptEl.value, this.routeDraftProvider(), this.draftConfigKey());
  }

  private applyDraft(): void {
    if (!this.draftEls) return;
    if (this.editorRef.interactionBusy) {
      this.draftEls.statusEl.textContent = 'Finish the current command or selection first, then apply.';
      return;
    }
    this.applyingDraft = true;
    try {
      this.draftController.apply();
    } finally {
      this.applyingDraft = false;
    }
    this.refreshPreview();
    if (this.mode === 'draft') this.refreshDraftPreview();
  }

  private fitDraftPreview(): void {
    const status = this.draftController.status;
    if (status.state !== 'staged' || !status.proposal.bounds) return;
    const { min, max } = status.proposal.bounds;
    this.editorRef.viewport.zoomToPoints([min, max]);
  }

  private clearDraftOverlay(): void {
    if (typeof this.editorRef.setAiPreview === 'function') this.editorRef.setAiPreview(null);
  }

  private refreshDraftPreview(): void {
    const els = this.draftEls;
    if (!els || !this.isVisible || this.mode !== 'draft') return;
    if (this.draftController.status.state === 'staged' || this.draftController.status.state === 'generating') return;
    const live = this.liveRoute;
    els.sentLabelEl.textContent = live
      ? `What will be sent to ${providerLabel(this.connState!.provider)} (model: ${this.connState!.model}) — exactly`
      : 'What will be sent (exactly) — offline demonstration, nothing leaves JCad';
    els.generateBtn.textContent = live ? `Generate Preview with ${providerLabel(this.connState!.provider)}` : 'Generate Preview';
    if (!els.promptEl.value.trim()) {
      els.summaryEl.textContent = 'Describe the drawing or edit above. Nothing is sent — and nothing in the drawing changes — until you click Generate Preview, review the preview, and Apply.';
      els.sentEl.textContent = '';
      els.generateBtn.disabled = true;
      return;
    }
    try {
      const capture = captureDraftContext(this.draftSource, els.promptEl.value, this.draftConfigKey());
      const unitsName = INSUNIT_NAMES[capture.units.insunits] ?? `code ${capture.units.insunits}`;
      els.summaryEl.textContent = `Model tab · World XY · Units: ${unitsName}${capture.units.insunits === 0 ? ' (unitless — no physical scale)' : ''}`
        + ` · Creation layer: ${capture.defaults.layer} · Eligible targets: ${capture.eligibleIds.length} of ${capture.targets.length} selected.`;
      const ineligible = capture.targets.filter((t) => !t.eligible);
      if (ineligible.length > 0) {
        els.summaryEl.textContent += ` Not editable: ${ineligible.map((t) => `${t.id} (${t.reason})`).join('; ')}.`;
      }
      els.sentEl.textContent = capture.contextJson;
      els.generateBtn.disabled = this.disposed || this.connectionBusy;
    } catch (cause) {
      els.summaryEl.textContent = 'Draft / Edit is unavailable for the current drawing state.';
      els.sentEl.textContent = cause instanceof Error ? cause.message : 'The draft context could not be read.';
      els.generateBtn.disabled = true;
    }
  }

  private renderDraftStatus(status: AiDraftStatus): void {
    const els = this.draftEls;
    if (!els) return;
    els.cancelBtn.disabled = status.state !== 'generating';
    els.generateBtn.disabled = status.state === 'generating' || this.connectionBusy;
    const staged = status.state === 'staged';
    els.applyBtn.disabled = !staged;
    els.discardBtn.disabled = !staged;
    els.fitBtn.disabled = !staged;
    switch (status.state) {
      case 'idle':
        els.statusEl.textContent = '';
        els.changesEl.textContent = '';
        this.clearDraftOverlay();
        break;
      case 'generating':
        els.statusEl.textContent = 'Generating preview…';
        els.changesEl.textContent = '';
        this.clearDraftOverlay();
        break;
      case 'staged': {
        const sets = previewSets(status.proposal);
        if (typeof this.editorRef.setAiPreview === 'function') {
          this.editorRef.setAiPreview({
            added: sets.added,
            modifiedAfter: sets.modifiedAfter,
            originals: sets.originals,
            deleted: sets.deleted,
          });
        }
        const c = status.proposal.counts;
        els.statusEl.textContent = 'Preview ready — the drawing has not changed. Review the changes, then Apply or Discard.';
        els.changesEl.textContent = '';
        const counts = document.createElement('div');
        counts.textContent = `Changes: ${c.created} created, ${c.copied} copied, ${c.modified} modified, ${c.deleted} deleted.`;
        els.changesEl.append(counts);
        if (status.proposal.plan.message) {
          const note = document.createElement('div');
          note.textContent = `Provider note: ${status.proposal.plan.message}`;
          els.changesEl.append(note);
        }
        for (const change of status.proposal.changes) {
          const row = document.createElement('div');
          row.textContent = `• ${change.summary}`;
          els.changesEl.append(row);
        }
        break;
      }
      case 'message':
        els.statusEl.textContent = status.kind === 'clarification'
          ? `More detail needed: ${status.message}`
          : `Unsupported: ${status.message}`;
        els.changesEl.textContent = '';
        this.clearDraftOverlay();
        break;
      case 'invalidated':
        els.statusEl.textContent = status.message;
        els.changesEl.textContent = '';
        this.clearDraftOverlay();
        break;
      case 'error':
        els.statusEl.textContent = status.error.message;
        els.changesEl.textContent = '';
        this.clearDraftOverlay();
        break;
    }
    if (this.mode === 'draft' && status.state !== 'staged') this.refreshDraftPreview();
  }

  /** Live only when the host says enabled with a key; the demo otherwise. */
  private routeProvider(): AiProvider {
    if (this.connection && this.connState?.enabled && this.connState.keyPresent && !this.connState.credentialProblem && this.liveProvider) {
      return this.liveProvider;
    }
    return this.fixtureProvider;
  }

  private get liveRoute(): boolean {
    return this.routeProvider() !== this.fixtureProvider;
  }

  private async ask(): Promise<void> {
    if (this.disposed || this.connectionBusy) return;
    await this.controller.ask(this.questionEl.value);
  }

  private clearKeyInput(): void {
    if (this.settingsEls) this.settingsEls.keyInput.value = '';
  }

  private hide(): void {
    this.clearKeyInput();
    // A staged preview must not linger on the canvas with no panel to act on it.
    this.draftController.invalidate();
    this.clearDraftOverlay();
    this.el.classList.add('hidden');
  }

  private clearAnswer(): void {
    this.answerBinding = null;
    this.answerEl.textContent = '';
    this.refsEl.textContent = '';
    this.usageEl.textContent = '';
  }

  /** One host operation at a time; disabled controls cannot queue a different destination. */
  private startConnectionOperation(message: string, invalidate: boolean): number | null {
    if (this.disposed || this.connectionBusy) return null;
    this.connectionBusy = true;
    const epoch = ++this.connectionEpoch;
    if (invalidate) {
      this.controller.cancel();
      this.draftController.invalidate();
      this.clearAnswer();
      this.statusEl.textContent = '';
    }
    if (this.settingsEls) {
      this.settingsEls.stateEl.textContent = message;
      this.settingsEls.errorEl.textContent = '';
    }
    this.updateSettingsAvailability();
    this.refreshPreview();
    return epoch;
  }

  private currentConnectionOperation(epoch: number): boolean {
    return !this.disposed && epoch === this.connectionEpoch;
  }

  private finishConnectionOperation(epoch: number): void {
    if (!this.currentConnectionOperation(epoch)) return;
    this.connectionBusy = false;
    this.updateSettingsAvailability();
    this.refreshPreview();
  }

  private updateSettingsAvailability(): void {
    const els = this.settingsEls;
    if (!els) return;
    const ready = !this.connectionBusy && !this.disposed && this.connState !== null;
    for (const input of [els.providerSelect, els.modelSelect, els.modelCustom, els.keyInput, els.saveKeyBtn, els.persistSession]) {
      input.disabled = !ready;
    }
    els.persistEncrypted.disabled = !ready || !this.connState?.encryptionAvailable;
    els.forgetKeyBtn.disabled = !ready || !(this.connState?.keyPresent || this.connState?.keyStored);
    els.testBtn.disabled = !ready || !this.connState?.keyPresent || !!this.connState?.credentialProblem;
    els.enableCheck.disabled = !ready || !this.connState?.keyPresent || !!this.connState?.credentialProblem;
  }

  // ------------------------------------------------------------ connection

  private buildSettingsSection(): HTMLElement {
    const conn = this.connection!;
    const section = document.createElement('div');
    section.className = 'ai-settings';

    const label = document.createElement('div');
    label.className = 'ai-section-label';
    label.textContent = 'Connection settings';
    const accountNote = document.createElement('div');
    accountNote.className = 'ai-note';
    accountNote.textContent = 'Uses provider API keys and API billing; ChatGPT/Claude app sign-ins are not connected here.';

    const stateEl = document.createElement('div');
    stateEl.className = 'ai-conn-state';
    stateEl.textContent = 'Reading connection state…';

    const providerRow = document.createElement('div');
    providerRow.className = 'ai-field-row';
    const providerLabelEl2 = document.createElement('label');
    providerLabelEl2.textContent = 'Provider';
    const providerSelect = document.createElement('select');
    providerSelect.className = 'ai-provider-select';
    for (const id of Object.keys(PROVIDER_LABELS)) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = id === 'openai' ? 'OpenAI (GPT models)' : 'Anthropic (Claude)';
      providerSelect.append(option);
    }
    providerSelect.addEventListener('change', () => { void this.switchProvider(providerSelect.value); });
    providerRow.append(providerLabelEl2, providerSelect);

    const modelRow = document.createElement('div');
    modelRow.className = 'ai-field-row';
    const modelLabel = document.createElement('label');
    modelLabel.textContent = 'Model';
    const modelSelect = document.createElement('select');
    modelSelect.className = 'ai-model';
    for (const preset of MODEL_PRESETS['openai']!) {
      const option = document.createElement('option');
      option.value = preset;
      option.textContent = preset;
      modelSelect.append(option);
    }
    const customOption = document.createElement('option');
    customOption.value = '__custom__';
    customOption.textContent = 'Custom…';
    modelSelect.append(customOption);
    const modelCustom = document.createElement('input');
    modelCustom.className = 'ai-model-custom';
    modelCustom.type = 'text';
    modelCustom.placeholder = 'Custom model id';
    modelCustom.classList.add('hidden');
    modelSelect.addEventListener('change', () => {
      if (modelSelect.value === '__custom__') {
        modelCustom.classList.remove('hidden');
        modelCustom.focus();
        return;
      }
      modelCustom.classList.add('hidden');
      void this.applySettings(() => conn.setModel(modelSelect.value));
    });
    modelCustom.addEventListener('change', () => {
      const value = modelCustom.value.trim();
      if (value) void this.applySettings(() => conn.setModel(value));
    });
    modelRow.append(modelLabel, modelSelect, modelCustom);

    const keyLabel = document.createElement('label');
    keyLabel.textContent = 'OpenAI API key';
    keyLabel.className = 'ai-key-label';
    const keyInput = document.createElement('input');
    keyInput.className = 'ai-key';
    keyInput.type = 'password';
    keyInput.autocomplete = 'off';
    keyInput.placeholder = 'sk-…';

    const persistRow = document.createElement('div');
    persistRow.className = 'ai-field-row';
    const persistSession = document.createElement('input');
    persistSession.type = 'radio';
    persistSession.name = 'ai-key-persistence';
    persistSession.checked = true;
    const sessionLabel = document.createElement('label');
    sessionLabel.append(persistSession, document.createTextNode(' This session only (default)'));
    const persistEncrypted = document.createElement('input');
    persistEncrypted.type = 'radio';
    persistEncrypted.name = 'ai-key-persistence';
    const encryptedLabel = document.createElement('label');
    encryptedLabel.append(persistEncrypted, document.createTextNode(' Remember, encrypted by the OS'));
    persistRow.append(sessionLabel, encryptedLabel);

    const keyButtons = document.createElement('div');
    keyButtons.className = 'ai-buttons';
    const saveKeyBtn = document.createElement('button');
    saveKeyBtn.className = 'ai-save-key';
    saveKeyBtn.textContent = 'Save Key';
    saveKeyBtn.addEventListener('click', () => { void this.submitKey(); });
    const forgetKeyBtn = document.createElement('button');
    forgetKeyBtn.className = 'ai-forget-key';
    forgetKeyBtn.textContent = 'Forget Key';
    forgetKeyBtn.addEventListener('click', () => {
      this.clearKeyInput();
      void this.applySettings(() => conn.forgetKey());
    });
    const testBtn = document.createElement('button');
    testBtn.className = 'ai-test-connection';
    testBtn.textContent = 'Test Connection';
    testBtn.addEventListener('click', () => { void this.testConnection(); });
    keyButtons.append(saveKeyBtn, forgetKeyBtn, testBtn);

    const probeNoteEl = document.createElement('div');
    probeNoteEl.className = 'ai-note';
    probeNoteEl.textContent = probeNote('openai');

    const enableRow = document.createElement('div');
    enableRow.className = 'ai-field-row';
    const enableCheck = document.createElement('input');
    enableCheck.type = 'checkbox';
    enableCheck.className = 'ai-enable';
    enableCheck.addEventListener('change', () => {
      void this.applySettings(() => conn.setEnabled(enableCheck.checked));
    });
    const enableLabel = document.createElement('label');
    enableLabel.append(enableCheck, document.createTextNode(' Enable Live AI'));
    enableRow.append(enableLabel);

    const retention = document.createElement('div');
    retention.className = 'ai-note';
    retention.textContent = retentionNote('openai');

    const errorEl = document.createElement('div');
    errorEl.className = 'ai-conn-error';

    section.append(
      label, accountNote, stateEl, providerRow, modelRow, keyLabel, keyInput, persistRow, keyButtons,
      probeNoteEl, enableRow, retention, errorEl,
    );
    this.settingsEls = {
      providerSelect, modelSelect, modelCustom, keyLabel, keyInput,
      persistSession, persistEncrypted,
      saveKeyBtn, forgetKeyBtn, testBtn, probeNoteEl, retentionEl: retention,
      enableCheck, stateEl, errorEl,
    };
    return section;
  }

  /**
   * Switch the selected provider. The host cancels all outstanding work
   * on a switch; mirror that here — cancel the in-flight question and
   * clear the displayed answer — so an answer from the previous
   * provider can never be presented under the new one. There is no
   * automatic fallback: questions go only to the selected provider.
   */
  private async switchProvider(provider: string): Promise<void> {
    this.clearKeyInput();
    if (!this.connection || provider === this.connState?.provider) return;
    await this.applySettings(() => this.connection!.setProvider(provider));
  }

  private async refreshConnection(): Promise<void> {
    if (!this.connection) return;
    const epoch = this.startConnectionOperation('Reading connection state…', false);
    if (epoch === null) return;
    try {
      const state = await this.connection.state();
      if (this.currentConnectionOperation(epoch)) this.setConnState(state);
    } catch (cause) {
      if (this.currentConnectionOperation(epoch)) {
        this.connState = null;
        this.liveProvider = null;
        this.clearAnswer();
        if (this.settingsEls) this.settingsEls.stateEl.textContent = 'Connection unavailable — offline demo only.';
        this.setConnError(cause);
      }
    } finally {
      this.finishConnectionOperation(epoch);
    }
  }

  /** Run a settings mutation, then render the authoritative host state. */
  private async applySettings(action: () => Promise<AiConnectionState>): Promise<void> {
    if (!this.settingsEls) return;
    const epoch = this.startConnectionOperation('Updating connection settings…', true);
    if (epoch === null) return;
    try {
      const state = await action();
      if (this.currentConnectionOperation(epoch)) this.setConnState(state);
    } catch (cause) {
      if (!this.currentConnectionOperation(epoch)) return;
      this.setConnError(cause);
      try {
        const state = await this.connection!.state();
        if (this.currentConnectionOperation(epoch)) this.setConnState(state);
      } catch {
        if (this.currentConnectionOperation(epoch)) {
          this.connState = null;
          this.liveProvider = null;
          if (this.settingsEls) this.settingsEls.stateEl.textContent = 'Connection unavailable — offline demo only.';
        }
      }
    } finally {
      this.finishConnectionOperation(epoch);
    }
  }

  private async submitKey(): Promise<void> {
    const els = this.settingsEls;
    if (!els || !this.connection) return;
    const key = els.keyInput.value;
    // Clear the password field immediately after submission — before the
    // host answers — so the key never lingers in the DOM.
    els.keyInput.value = '';
    if (!key) {
      els.errorEl.textContent = 'Enter an API key first.';
      return;
    }
    const persistence = els.persistEncrypted.checked ? 'encrypted' : 'session';
    await this.applySettings(() => this.connection!.setKey(key, persistence));
  }

  private async testConnection(): Promise<void> {
    const els = this.settingsEls;
    if (!els || !this.connection) return;
    const epoch = this.startConnectionOperation('Testing the connection…', false);
    if (epoch === null) return;
    const provider = this.connState?.provider ?? 'openai';
    try {
      const probe = await this.connection.testConnection();
      if (!this.currentConnectionOperation(epoch)) return;
      els.stateEl.textContent = `Connection OK — ${providerLabel(provider)} · ${probe.model}`
        + (probe.outputTokens !== undefined ? ` (probe used ${probe.outputTokens} output tokens)` : '')
        + (probe.outputLimited ? ' — the probe reached its output limit; the connection was verified' : '')
        + '.';
    } catch (cause) {
      if (this.currentConnectionOperation(epoch)) {
        this.setConnError(cause);
        if (this.connState) this.setConnState(this.connState);
      }
    } finally {
      this.finishConnectionOperation(epoch);
    }
  }

  private setConnError(cause: unknown): void {
    if (!this.settingsEls) return;
    this.settingsEls.errorEl.textContent = cause instanceof AiError || cause instanceof Error
      ? cause.message
      : 'The AI host reported a failure.';
  }

  private setConnState(state: AiConnectionState): void {
    const previous = this.connState;
    if (previous && ['provider', 'model', 'enabled', 'keyPresent', 'keyStored', 'credentialProblem', 'keySource', 'keyPersistence'].some(
      (key) => previous[key as keyof AiConnectionState] !== state[key as keyof AiConnectionState],
    )) {
      this.controller.cancel();
      this.clearAnswer();
      // Any connection change also drops a staged draft proposal: switching
      // away and back must never revive it.
      this.draftController.invalidate();
    }
    this.connState = state;
    this.liveProvider = this.connection
      ? new LiveProvider(this.connection.bridge, { providerId: state.provider, model: state.model })
      : null;
    const els = this.settingsEls;
    if (els) {
      const label = providerLabel(state.provider);
      els.providerSelect.value = state.provider;
      if (this.renderedProvider !== state.provider) {
        this.renderedProvider = state.provider;
        // Rebuild the model presets for the newly selected provider and
        // re-render its provider-specific texts.
        els.modelSelect.innerHTML = '';
        for (const preset of MODEL_PRESETS[state.provider] ?? []) {
          const option = document.createElement('option');
          option.value = preset;
          option.textContent = preset;
          els.modelSelect.append(option);
        }
        const customOption = document.createElement('option');
        customOption.value = '__custom__';
        customOption.textContent = 'Custom…';
        els.modelSelect.append(customOption);
        els.keyLabel.textContent = `${label} API key`;
        els.keyInput.placeholder = state.provider === 'anthropic' ? 'sk-ant-…' : 'sk-…';
        els.probeNoteEl.textContent = probeNote(state.provider);
        els.retentionEl.textContent = retentionNote(state.provider);
      }
      const keyText = state.credentialProblem
        ? credentialNote(state.credentialProblem)
        : state.keyPresent
          ? `API key: saved (${state.keySource === 'stored' ? 'encrypted on this device' : 'this session only'})`
          : 'API key: not saved';
      els.stateEl.textContent = `Provider: ${label} · Model: ${state.model} · ${keyText}`
        + (state.configProblem ? ` · Settings problem: ${state.configProblem} (defaults in use)` : '');
      els.saveKeyBtn.textContent = state.keyPresent || state.keyStored ? 'Replace Key' : 'Save Key';
      els.forgetKeyBtn.disabled = !(state.keyPresent || state.keyStored);
      els.testBtn.disabled = !state.keyPresent;
      els.enableCheck.checked = state.enabled;
      els.enableCheck.disabled = !state.keyPresent;
      els.persistEncrypted.disabled = !state.encryptionAvailable;
      els.persistEncrypted.checked = state.encryptionAvailable && state.keyPersistence === 'encrypted';
      els.persistSession.checked = !els.persistEncrypted.checked;
      if ((MODEL_PRESETS[state.provider] ?? []).includes(state.model)) {
        els.modelSelect.value = state.model;
        els.modelCustom.classList.add('hidden');
      } else {
        els.modelSelect.value = '__custom__';
        els.modelCustom.value = state.model;
        els.modelCustom.classList.remove('hidden');
      }
    }
    this.providerLabelEl.textContent = this.liveRoute
      ? `Live AI: ${providerLabel(state.provider)} · ${state.model}`
      : OFFLINE_LABEL;
    this.updateSettingsAvailability();
    this.refreshPreview();
  }

  // ------------------------------------------------------------ preview/status

  private refreshPreview(): void {
    if (!this.isVisible) return;
    let snapshot: AiSnapshot;
    try {
      if (this.answerBinding && !this.controller.isCurrentBinding(this.answerBinding)) {
        this.answerBinding = null;
        this.answerEl.textContent = '';
        this.refsEl.textContent = '';
        this.usageEl.textContent = '';
        this.statusEl.textContent = 'The drawing context changed. Ask again to refresh the answer.';
      }
      snapshot = this.controller.previewSnapshot();
    } catch (cause) {
      this.askBtn.disabled = true;
      this.summaryEl.textContent = 'The current selection cannot be used as AI context.';
      this.sentEl.textContent = '';
      this.answerBinding = null;
      this.answerEl.textContent = '';
      this.refsEl.textContent = '';
      this.usageEl.textContent = '';
      this.statusEl.textContent = cause instanceof Error ? cause.message : 'The drawing context could not be read.';
      return;
    }
    this.askBtn.disabled = this.disposed || this.connectionBusy || this.controller.status.state === 'asking';
    this.providerLabelEl.textContent = this.connectionBusy
      ? 'Connection settings are updating — questions paused.'
      : this.liveRoute
        ? `Live AI: ${providerLabel(this.connState!.provider)} · ${this.connState!.model}`
        : OFFLINE_LABEL;
    const live = this.liveRoute;
    this.sentLabelEl.textContent = live
      ? `What will be sent to ${providerLabel(this.connState!.provider)} (model: ${this.connState!.model}) — exactly`
      : 'What will be sent (exactly)';
    this.askBtn.textContent = live ? `Ask ${providerLabel(this.connState!.provider)}` : 'Ask';
    if (live) this.billingEl.textContent = billingNote(this.connState!.provider);
    this.billingEl.classList.toggle('hidden', !live);
    const { total, included, omittedCount } = snapshot.selection;
    this.summaryEl.textContent = total === 0
      ? 'Nothing is selected. Select objects in the drawing, then ask about them here.'
      : `${included} of ${total} selected objects will be included`
        + (omittedCount > 0 ? `; ${omittedCount} omitted (see below for why)` : '')
        + '.';
    this.sentEl.textContent = serializeSnapshot(snapshot);
  }

  private renderStatus(status: AiAskStatus): void {
    this.askBtn.disabled = status.state === 'asking';
    this.cancelBtn.disabled = status.state !== 'asking';
    switch (status.state) {
      case 'idle':
        this.statusEl.textContent = '';
        break;
      case 'asking':
        this.statusEl.textContent = 'Asking…';
        this.answerBinding = null;
        this.answerEl.textContent = '';
        this.refsEl.textContent = '';
        this.usageEl.textContent = '';
        break;
      case 'answered': {
        this.statusEl.textContent = '';
        this.answerEl.textContent = status.answer.text;
        this.answerBinding = status.binding;
        this.refsEl.textContent = status.answer.references.length > 0
          ? `Objects discussed: ${status.answer.references.join(', ')}`
          : '';
        if (status.droppedReferences > 0) {
          this.refsEl.textContent += `${this.refsEl.textContent ? ' ' : ''}`
            + `(${status.droppedReferences} reference(s) to objects outside the selection were removed.)`;
        }
        const usage = status.answer.usage;
        this.usageEl.textContent = usage && (usage.inputTokens !== undefined || usage.outputTokens !== undefined)
          ? `Usage: ${usage.inputTokens ?? '—'} input tokens, ${usage.outputTokens ?? '—'} output tokens.`
          : '';
        break;
      }
      case 'stale':
        this.statusEl.textContent = 'The drawing, selection or space changed while asking, so that answer was not shown. Ask again.';
        this.answerEl.textContent = '';
        this.refsEl.textContent = '';
        this.usageEl.textContent = '';
        break;
      case 'cancelled':
        this.statusEl.textContent = 'Cancelled.';
        this.answerEl.textContent = '';
        this.refsEl.textContent = '';
        this.usageEl.textContent = '';
        break;
      case 'error':
        this.statusEl.textContent = status.error.message;
        this.answerEl.textContent = '';
        this.refsEl.textContent = '';
        this.usageEl.textContent = '';
        break;
    }
    this.refreshPreview();
  }
}
