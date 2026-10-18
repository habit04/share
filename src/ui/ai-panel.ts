import type { Editor } from '../app/editor/editor';
import { AiAskController, type AiAskStatus } from '../ai/ask-controller';
import { AiDraftController, type AiDraftStatus } from '../ai/draft-controller';
import { captureDraftContext, type AiDraftSource } from '../ai/draft-context';
import { createEditorAiSource } from '../ai/editor-source';
import { createEditorAiDraftSource } from '../ai/editor-draft-source';
import { previewSets, type CompiledProposal } from '../ai/draft-compiler';
import { buildRefineEnvelope, diffProposalChanges, type AiProposalDiff } from '../ai/draft-refine';
import { FixtureProvider } from '../ai/fixture-provider';
import { FixtureDraftProvider } from '../ai/fixture-draft';
import { LiveProvider, LiveDraftProvider } from '../ai/live-provider';
import { serializeSnapshot } from '../ai/snapshot';
import { INSUNIT_NAMES } from '../core/units';
import type { WindowAiConnection, AiConnectionState, AiLiveChecksReport } from '../ai/host-bridge';
import { aiBindingsEqual, AiError, type AiBinding, type AiDraftProvider, type AiProvider, type AiSnapshot } from '../ai/types';
import { icon } from './icons';

/**
 * “Ask about selected objects” palette (docs/AI-ASSISTANT.md, milestone 2
 * in docs/AI-ASSISTANT-M2.md).
 *
 * Ask and draft generation/preview read through the AI sources; only an
 * explicit Apply reaches the validated atomic draft commit. The panel
 * never dispatches a CAD command (so it cannot cancel the current tool), and renders every
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
  return `AI requests are billed to your ${label} API account. Cancelling stops JCad from waiting, but a request already processing at ${label} may still be charged.`;
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

/** Fixed warning shown above the live-checks controls (docs/AI-LIVE-CHECKS.md). */
const LIVE_CHECKS_NOTE = 'Live checks make up to four real OpenAI/Anthropic API calls — a connection probe, one question, one draft and one refinement — about a fixed test drawing that is not yours. They may incur a small charge on your account. Nothing in your drawing is sent, changed, or saved.';

/**
 * Render a live-checks report exactly as the harness core renders it
 * (electron/ai-live-checks-core.cjs formatReportText, including its
 * provider labels): the report is the acceptance artifact, so its text
 * must not drift between the main process and this panel.
 */
function liveChecksReportText(report: AiLiveChecksReport): string {
  const labels: Readonly<Record<string, string>> = { openai: 'OpenAI', anthropic: 'Anthropic Claude' };
  const label = (report.provider ? labels[report.provider] : undefined) ?? report.provider ?? 'No provider';
  const lines = [`JCad live provider checks — ${label} · ${report.model ?? 'no model'}`];
  if (report.status === 'refused') {
    lines.push(`Result: REFUSED (${report.refusal ?? 'unknown reason'}) — no provider call was made.`);
    return lines.join('\n');
  }
  const verdict = { pass: 'PASS', fail: 'FAIL', cancelled: 'CANCELLED' }[report.status] ?? report.status.toUpperCase();
  const tokens = report.totals.tokens
    ? `, ${report.totals.tokens.inputTokens} input / ${report.totals.tokens.outputTokens} output tokens reported`
    : '';
  lines.push(`Result: ${verdict} — ${report.totals.attempts} service attempt(s) in ${report.totals.durationMs} ms${tokens}.`);
  report.checks.forEach((check, index) => {
    const usage = check.usage ? ` [${check.usage.inputTokens ?? '?'} in / ${check.usage.outputTokens ?? '?'} out tokens]` : '';
    lines.push(`${index + 1}. ${check.title} — ${check.status.toUpperCase()}${check.errorKind ? ` (${check.errorKind})` : ''} — ${check.detail ?? ''}${usage}`);
  });
  return lines.join('\n');
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
  private draftCommitInProgress = false;
  private readonly draftPreviewOwner = {};
  private draftConfigEpoch = 0;
  private draftUiEpoch = 0;
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
    versionEl: HTMLElement;
    followWrap: HTMLElement;
    followUpEl: HTMLTextAreaElement;
    refineBtn: HTMLButtonElement;
    discardFollowUpBtn: HTMLButtonElement;
    refineSentLabel: HTMLElement;
    refineSentEl: HTMLElement;
  } | null = null;
  /** Milestone 4: the proposal currently on screen and its diff vs the prior version. */
  private shownProposal: CompiledProposal | null = null;
  private lastDiff: AiProposalDiff | null = null;
  private refinePreviewBlocked = false;
  private refineIntentEpoch = 0;
  private preparingRefine = false;
  private restoringFollowUp = false;
  private refineConnectionCheck: Promise<boolean> | null = null;
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
    liveRunBtn: HTMLButtonElement; liveCancelBtn: HTMLButtonElement;
    liveConfirmEl: HTMLElement; liveConfirmText: HTMLElement;
    liveConfirmBtn: HTMLButtonElement; liveConfirmCancelBtn: HTMLButtonElement;
    liveResultEl: HTMLElement;
  } | null = null;
  /** Live provider checks: a run is main-side; the panel only starts/cancels it and renders the report. */
  private liveChecksRunning = false;
  /** The destination a shown live-checks confirmation is pinned to; any settings change clears it. */
  private liveConfirm: { provider: string; model: string } | null = null;
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
        this.draftController?.discard();
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
      this.summaryEl, this.sentLabelEl, this.sentEl, this.questionEl,
      buttons, this.statusEl, this.answerEl, this.refsEl, this.usageEl,
    );
    const draftBuilt = this.buildDraftSection();
    content.append(this.providerLabelEl, draftBuilt.tabs, this.billingEl, askSection, draftBuilt.section);
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
    this.draftController = new AiDraftController(this.draftSource, editor.doc, { configKeyNow: () => this.draftConfigKey() });
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
    // by draftCommitInProgress (the proposal is consumed, not invalidated).
    for (const ev of ['selection', 'change', 'file', 'space', 'tool', 'interaction'] as const) {
      this.unsubscribes.push(editor.on(ev, () => {
        if (this.draftCommitInProgress) return;
        this.draftUiEpoch += 1;
        const state = this.draftController.status.state;
        if (state === 'staged' || state === 'generating') this.draftController.invalidate();
        if (this.mode === 'draft') this.refreshDraftPreview();
      }));
    }
    // Navigation preserves a staged preview. Refresh controls on pan end
    // without rebuilding its context or invalidating the proposal.
    this.unsubscribes.push(editor.on('view', () => this.updateDraftAvailability()));
    this.renderStatus(this.controller.status);
    this.updateSettingsAvailability();
  }

  toggle(): void {
    if (this.disposed) return;
    if (this.isVisible) { this.hide(); return; }
    this.el.classList.remove('hidden');
    this.refreshPreview();
    if (this.isVisible) {
      (this.mode === 'draft' ? this.draftEls?.promptEl : this.questionEl)?.focus();
      void this.refreshConnection();
    }
  }

  get isVisible(): boolean {
    return !this.el.classList.contains('hidden');
  }

  dispose(): void {
    this.disposed = true;
    this.draftUiEpoch += 1;
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
      this.draftUiEpoch += 1;
      if (this.draftController.status.state === 'staged' || this.draftController.status.state === 'generating') {
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
    cancelBtn.addEventListener('click', () => {
      this.cancelDraftWork();
    });
    buttons.append(generateBtn, cancelBtn);

    const legend = document.createElement('div');
    legend.className = 'ai-legend';
    const swatch = (color: string, label: string, dashed: boolean): void => {
      const box = document.createElement('span');
      box.className = dashed ? 'ai-swatch dashed' : 'ai-swatch';
      box.style.background = color;
      box.style.color = color;
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
    applyBtn.addEventListener('click', () => { void this.applyDraft(); });
    const discardBtn = document.createElement('button');
    discardBtn.textContent = 'Discard';
    discardBtn.disabled = true;
    discardBtn.addEventListener('click', () => this.draftController.discard());
    const fitBtn = document.createElement('button');
    fitBtn.textContent = 'Fit Preview';
    fitBtn.disabled = true;
    fitBtn.addEventListener('click', () => this.fitDraftPreview());
    actions.append(applyBtn, discardBtn, fitBtn);

    // Milestone 4: follow-up refinement of the staged preview. The previous
    // preview stays on screen (labelled with its version) while a follow-up
    // is unresolved; Apply stays paused until Refine Preview replaces the
    // preview or Discard Follow-up restores it after fresh checks.
    const versionEl = document.createElement('div');
    versionEl.className = 'ai-summary';
    const followWrap = document.createElement('div');
    followWrap.className = 'ai-followup hidden';
    const followLabel = document.createElement('div');
    followLabel.className = 'ai-section-label';
    followLabel.textContent = 'Follow-up instruction — refine this preview';
    const followUpEl = document.createElement('textarea');
    followUpEl.className = 'ai-question';
    followUpEl.placeholder = 'e.g. Change the rectangle width to 120…';
    followUpEl.rows = 2;
    // Typing never sends anything: it only records the follow-up (which
    // pauses Apply) and refreshes the exact refinement context preview.
    followUpEl.addEventListener('input', () => {
      this.refineIntentEpoch += 1;
      this.draftUiEpoch += 1;
      this.preparingRefine = false;
      this.restoringFollowUp = false;
      this.draftController.followUpEdited(followUpEl.value);
      if (this.draftController.status.state === 'staged') this.refreshRefinePreview();
      this.updateDraftAvailability();
    });
    const followButtons = document.createElement('div');
    followButtons.className = 'ai-buttons';
    const refineBtn = document.createElement('button');
    refineBtn.className = 'ai-ask';
    refineBtn.textContent = 'Refine Preview';
    refineBtn.disabled = true;
    refineBtn.addEventListener('click', () => { void this.refineDraft(); });
    const discardFollowUpBtn = document.createElement('button');
    discardFollowUpBtn.textContent = 'Discard Follow-up';
    discardFollowUpBtn.disabled = true;
    discardFollowUpBtn.addEventListener('click', () => { void this.discardDraftFollowUp(); });
    followButtons.append(refineBtn, discardFollowUpBtn);
    const refineSentLabel = document.createElement('div');
    refineSentLabel.className = 'ai-section-label';
    refineSentLabel.textContent = 'Refinement context to be sent (exactly)';
    const refineSentEl = document.createElement('pre');
    refineSentEl.className = 'ai-sent';
    followWrap.append(followLabel, followUpEl, followButtons, refineSentLabel, refineSentEl);

    section.append(summaryEl, sentLabelEl, sentEl, promptEl, buttons, legend, statusEl, changesEl, actions, versionEl, followWrap);
    this.draftEls = {
      section, askTab, draftTab, summaryEl, sentLabelEl, sentEl, promptEl,
      generateBtn, cancelBtn, statusEl, changesEl, applyBtn, discardBtn, fitBtn,
      versionEl, followWrap, followUpEl, refineBtn, discardFollowUpBtn, refineSentLabel, refineSentEl,
    };
    return { tabs, section };
  }

  private setMode(mode: 'ask' | 'draft'): void {
    if (this.disposed || !this.draftEls || this.mode === mode) return;
    this.mode = mode;
    this.draftUiEpoch += 1;
    // Leaving Draft drops any staged proposal and its overlay.
    this.draftController.invalidate();
    this.controller.cancel();
    this.clearDraftOverlay();
    this.draftEls.askTab.classList.toggle('active', mode === 'ask');
    this.draftEls.draftTab.classList.toggle('active', mode === 'draft');
    this.draftEls.section.classList.toggle('hidden', mode !== 'draft');
    this.askSectionEl?.classList.toggle('hidden', mode !== 'ask');
    if (mode === 'draft') this.refreshDraftPreview();
    else this.refreshPreview();
    (mode === 'draft' ? this.draftEls.promptEl : this.questionEl).focus();
  }

  private draftConfigKey(): string {
    const s = this.connState;
    if (!s) return `fixture|${this.draftConfigEpoch}`;
    return [s.configGeneration ?? '', this.draftConfigEpoch, s.provider, s.model, s.enabled, s.keyPresent, s.keySource ?? '', s.keyPersistence, s.credentialProblem ?? ''].join('|');
  }

  private routeDraftProvider(): AiDraftProvider {
    if (this.connection && this.connState?.enabled && this.connState.keyPresent && !this.connState.credentialProblem) {
      return new LiveDraftProvider(this.connection.bridge, { providerId: this.connState.provider, model: this.connState.model, configGeneration: this.connState.configGeneration });
    }
    return this.fixtureDraftProvider;
  }

  private async generateDraft(): Promise<void> {
    if (this.disposed || this.connectionBusy || this.applyingDraft || !this.isVisible || this.mode !== 'draft' || !this.draftEls) return;
    if (this.editorRef.interactionBusy) {
      this.draftEls.statusEl.textContent = 'Finish the current command or selection first, then generate a preview.';
      return;
    }
    const uiEpoch = this.draftUiEpoch;
    const configAtClick = this.draftConfigKey();
    let bindingAtClick: AiBinding;
    let defaultsAtClick: string;
    try {
      bindingAtClick = this.draftSource.binding();
      defaultsAtClick = JSON.stringify(this.draftSource.frozenDefaults());
    } catch {
      this.draftEls.statusEl.textContent = 'The drawing context could not be verified. Try again.';
      return;
    }
    this.draftController.invalidate();
    if (this.connection) {
      const checked = await this.refreshConnection();
      if (this.disposed || !this.isVisible || this.mode !== 'draft' || uiEpoch !== this.draftUiEpoch) return;
      if (!checked) {
        this.draftEls.statusEl.textContent = 'Connection settings could not be verified. Try again before generating.';
        return;
      }
      if (configAtClick !== this.draftConfigKey()) {
        this.draftEls.statusEl.textContent = 'Connection settings changed. Review the destination, then Generate Preview again.';
        return;
      }
      try {
        if (!aiBindingsEqual(bindingAtClick, this.draftSource.binding()) || defaultsAtClick !== JSON.stringify(this.draftSource.frozenDefaults())) {
          this.draftEls.statusEl.textContent = 'The drawing context changed. Review it, then Generate Preview again.';
          return;
        }
      } catch {
        this.draftEls.statusEl.textContent = 'The drawing context could not be verified. Try again.';
        return;
      }
    }
    await this.draftController.generate(this.draftEls.promptEl.value, this.routeDraftProvider(), this.draftConfigKey());
  }

  private async applyDraft(): Promise<void> {
    if (this.disposed || this.connectionBusy || this.applyingDraft || !this.isVisible || this.mode !== 'draft' || !this.draftEls) return;
    const stagedAtClick = this.draftController.status;
    if (stagedAtClick.state !== 'staged' || stagedAtClick.followUp || this.draftEls.followUpEl.value.trim()) return;
    if (this.editorRef.interactionBusy) {
      this.draftEls.statusEl.textContent = 'Finish the current command or selection first, then apply.';
      return;
    }
    const uiEpoch = this.draftUiEpoch;
    this.applyingDraft = true;
    try {
      if (this.connection) {
        const epoch = this.startConnectionOperation('Checking connection settings before Apply…', false);
        if (epoch === null) return;
        try {
          const state = await this.connection.state();
          if (!this.currentConnectionOperation(epoch)) return;
          this.setConnState(state);
        } catch (cause) {
          if (this.currentConnectionOperation(epoch)) {
            this.draftController.invalidate('Connection settings could not be verified — generate again.');
            this.setConnError(cause);
          }
          return;
        } finally {
          this.finishConnectionOperation(epoch);
        }
      }
      if (this.disposed || !this.isVisible || this.mode !== 'draft' || uiEpoch !== this.draftUiEpoch || this.editorRef.interactionBusy) return;
      const staged = this.draftController.status;
      if (staged.state !== 'staged' || staged.capture !== stagedAtClick.capture || staged.proposal !== stagedAtClick.proposal) return;
      if (staged.capture.prompt !== this.draftEls.promptEl.value.trim()) {
        this.draftController.invalidate('The description changed — generate again.');
        return;
      }
      this.draftCommitInProgress = true;
      try { this.draftController.apply(); } finally { this.draftCommitInProgress = false; }
    } finally {
      this.applyingDraft = false;
      this.refreshPreview();
      if (this.mode === 'draft') this.refreshDraftPreview();
    }
  }

  private fitDraftPreview(): void {
    const status = this.draftController.status;
    if (this.disposed || this.connectionBusy || this.applyingDraft || this.editorRef.interactionBusy || status.state !== 'staged' || !status.proposal.bounds) return;
    const { min, max } = status.proposal.bounds;
    this.editorRef.viewport.zoomToPoints([min, { x: max.x, y: min.y }, max, { x: min.x, y: max.y }]);
    this.editorRef.render();
  }

  private clearDraftOverlay(): void {
    if (typeof this.editorRef.setAiPreview === 'function') this.editorRef.setAiPreview(null, this.draftPreviewOwner);
  }

  private refreshDraftPreview(): void {
    const els = this.draftEls;
    if (!els || !this.isVisible || this.mode !== 'draft') return;
    this.updateDraftAvailability();
    if (this.draftController.status.state === 'staged' || this.draftController.status.state === 'generating') return;
    const live = this.liveRoute;
    els.sentLabelEl.textContent = live
      ? `What will be sent to ${providerLabel(this.connState!.provider)} (model: ${this.connState!.model}) — exactly`
      : 'What will be sent (exactly) — offline demonstration, nothing leaves JCad';
    els.generateBtn.textContent = live ? `Generate Preview with ${providerLabel(this.connState!.provider)}` : 'Generate Preview';
    if (!els.promptEl.value.trim()) {
      els.summaryEl.textContent = 'Describe the drawing or edit. Generate Preview sends the request to the displayed provider when live AI is enabled. Drawing changes happen only when you click Apply Changes.';
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
      els.generateBtn.disabled = this.disposed || this.connectionBusy || this.applyingDraft || this.editorRef.interactionBusy;
    } catch (cause) {
      els.summaryEl.textContent = 'Draft / Edit is unavailable for the current drawing state.';
      els.sentEl.textContent = cause instanceof Error ? cause.message : 'The draft context could not be read.';
      els.generateBtn.disabled = true;
    }
  }

  private updateDraftAvailability(): void {
    const els = this.draftEls;
    if (!els) return;
    const status = this.draftController.status;
    const available = !this.disposed && this.isVisible && this.mode === 'draft' && !this.connectionBusy && !this.applyingDraft && !this.preparingRefine && !this.restoringFollowUp && !this.editorRef.interactionBusy;
    const followUp = status.state === 'staged' ? status.followUp : null;
    const refining = followUp?.phase === 'refining';
    els.generateBtn.disabled = !available || status.state === 'generating' || !els.promptEl.value.trim();
    // An unresolved follow-up pauses Apply even though a preview is staged.
    els.applyBtn.disabled = !available || status.state !== 'staged' || followUp !== null;
    els.discardBtn.disabled = this.disposed || status.state !== 'staged';
    els.fitBtn.disabled = !available || status.state !== 'staged';
    els.cancelBtn.disabled = this.disposed || !(status.state === 'generating' || refining || this.preparingRefine || this.restoringFollowUp);
    els.refineBtn.disabled = !available || this.preparingRefine || this.restoringFollowUp || status.state !== 'staged' || refining || !els.followUpEl.value.trim() || this.refinePreviewBlocked;
    els.discardFollowUpBtn.disabled = this.disposed || this.restoringFollowUp || (this.connectionBusy && !this.preparingRefine) || status.state !== 'staged' || followUp === null;
    els.followUpEl.disabled = this.disposed || status.state !== 'staged';
  }

  /**
   * Show the exact refinement envelope for the current follow-up text
   * (milestone 4). Typing only rebuilds this preview — Refine Preview is
   * the only action that sends it.
   */
  private refreshRefinePreview(): void {
    const els = this.draftEls;
    if (!els) return;
    const status = this.draftController.status;
    if (status.state !== 'staged') {
      els.refineSentEl.textContent = '';
      this.refinePreviewBlocked = false;
      return;
    }
    const live = this.connection && this.connState?.enabled && this.connState.keyPresent && !this.connState.credentialProblem;
    els.refineSentLabel.textContent = live && this.connState
      ? `Refinement context for ${this.connState.provider === 'anthropic' ? 'Anthropic Claude' : 'OpenAI GPT'} / ${this.connState.model} (exactly)`
      : 'Refinement context (offline demonstration, exactly)';
    if (!els.followUpEl.value.trim()) {
      els.refineSentEl.textContent = 'Type a follow-up instruction to see the exact refinement context before refining.';
      this.refinePreviewBlocked = false;
      return;
    }
    try {
      els.refineSentEl.textContent = buildRefineEnvelope(status.capture, status.proposal, els.followUpEl.value).envelopeJson;
      this.refinePreviewBlocked = false;
    } catch (cause) {
      els.refineSentEl.textContent = cause instanceof AiError ? cause.message : 'The refinement context could not be built.';
      this.refinePreviewBlocked = true;
    }
  }

  /** Refine Preview click: re-verify connection and context, then send exactly the previewed envelope. */
  private async refineDraft(): Promise<void> {
    if (this.disposed || this.connectionBusy || this.applyingDraft || !this.isVisible || this.mode !== 'draft' || !this.draftEls) return;
    if (this.preparingRefine || this.restoringFollowUp || this.refinePreviewBlocked || this.draftController.status.state !== 'staged' || !this.draftEls.followUpEl.value.trim()) return;
    if (this.editorRef.interactionBusy) {
      this.draftEls.statusEl.textContent = 'Finish the current command or selection first, then refine.';
      return;
    }
    const uiEpoch = this.draftUiEpoch;
    const intent = ++this.refineIntentEpoch;
    const instruction = this.draftEls.followUpEl.value;
    const staged = this.draftController.status;
    const configAtClick = this.draftConfigKey();
    this.preparingRefine = true;
    this.updateDraftAvailability();
    try {
      if (this.connection) {
        const check = this.refreshConnection();
        this.refineConnectionCheck = check;
        const checked = await check;
        if (this.refineConnectionCheck === check) this.refineConnectionCheck = null;
        if (this.disposed || !this.isVisible || this.mode !== 'draft' || uiEpoch !== this.draftUiEpoch || intent !== this.refineIntentEpoch || instruction !== this.draftEls.followUpEl.value) return;
        if (!checked) {
          this.draftEls.statusEl.textContent = 'Connection settings could not be verified. Try again before refining.';
          return;
        }
        if (configAtClick !== this.draftConfigKey()) {
          this.draftEls.statusEl.textContent = 'Connection settings changed. Review the destination, then Generate Preview again.';
          return;
        }
        const current = this.draftController.status;
        if (current.state !== 'staged' || current.capture !== staged.capture || current.proposal !== staged.proposal) return;
      }
      this.preparingRefine = false;
      await this.draftController.refine(instruction, this.routeDraftProvider(), this.draftConfigKey());
    } finally {
      if (intent === this.refineIntentEpoch) this.preparingRefine = false;
      this.updateDraftAvailability();
    }
  }

  private cancelDraftWork(): void {
    const wasPreparing = this.preparingRefine || this.restoringFollowUp;
    this.refineIntentEpoch += 1;
    this.preparingRefine = false;
    this.restoringFollowUp = false;
    const status = this.draftController.status;
    if (status.state === 'staged') this.draftController.cancelRefine();
    else this.draftController.cancel();
    if (wasPreparing && this.draftEls) this.draftEls.statusEl.textContent = 'Refinement cancelled. The previous preview is still shown; retry or Discard Follow-up.';
    this.updateDraftAvailability();
  }

  /** Restoring Apply is explicit and requires fresh host as well as document checks. */
  private async discardDraftFollowUp(): Promise<void> {
    if (this.disposed || !this.isVisible || this.mode !== 'draft' || !this.draftEls || this.restoringFollowUp) return;
    const pendingCheck = this.preparingRefine ? this.refineConnectionCheck : null;
    if (this.connectionBusy && !pendingCheck) return;
    const staged = this.draftController.status;
    if (staged.state !== 'staged' || !staged.followUp) return;
    const intent = ++this.refineIntentEpoch;
    const uiEpoch = this.draftUiEpoch;
    this.preparingRefine = false;
    this.restoringFollowUp = true;
    this.draftController.cancelRefine();
    this.updateDraftAvailability();
    try {
      if (this.connection) {
        const checked = await (pendingCheck ?? this.refreshConnection());
        if (this.disposed || !this.isVisible || this.mode !== 'draft' || uiEpoch !== this.draftUiEpoch || intent !== this.refineIntentEpoch) return;
        if (!checked) {
          this.draftEls.statusEl.textContent = 'Connection settings could not be verified. The follow-up remains unresolved; try Discard Follow-up again.';
          return;
        }
      }
      const current = this.draftController.status;
      if (current.state !== 'staged' || current.capture !== staged.capture || current.proposal !== staged.proposal) return;
      this.draftController.discardFollowUp();
    } finally {
      if (intent === this.refineIntentEpoch) this.restoringFollowUp = false;
      this.updateDraftAvailability();
    }
  }

  private renderDraftStatus(status: AiDraftStatus): void {
    const els = this.draftEls;
    if (!els) return;
    els.cancelBtn.disabled = status.state !== 'generating';
    els.generateBtn.disabled = status.state === 'generating' || this.connectionBusy;
    if (status.state !== 'staged') {
      this.refineIntentEpoch += 1;
      this.preparingRefine = false;
      this.restoringFollowUp = false;
      els.versionEl.textContent = '';
      els.followWrap.classList.add('hidden');
      this.shownProposal = null;
      this.lastDiff = null;
      els.followUpEl.value = '';
      els.refineSentEl.textContent = '';
      this.refinePreviewBlocked = false;
    }
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
        els.sentEl.textContent = status.capture.contextJson;
        const sets = previewSets(status.proposal);
        if (typeof this.editorRef.setAiPreview === 'function') {
          this.editorRef.setAiPreview({
            added: sets.added,
            modifiedAfter: sets.modifiedAfter,
            originals: sets.originals,
            deleted: sets.deleted,
          }, this.draftPreviewOwner);
        }
        const c = status.proposal.counts;
        els.statusEl.textContent = 'Preview ready — the drawing has not changed. Review the changes, then Apply or Discard.';
        if (status.version > 1 && !status.followUp) {
          els.statusEl.textContent = 'Updated preview ready — the drawing has not changed. Review the changes, then Apply or Discard.';
        }
        if (status.followUp) {
          const followUp = status.followUp;
          els.statusEl.textContent = followUp.phase === 'refining'
            ? `Refining… still showing preview version ${status.version}. The drawing has not changed.`
            : followUp.phase === 'entered'
              ? `${followUp.message ? `${followUp.message} ` : 'Follow-up entered — '}Choose Refine Preview to update this preview, or Discard Follow-up to keep it. Apply is paused while a follow-up is unresolved.`
              : followUp.phase === 'clarification'
                ? `More detail needed: ${followUp.message ?? ''} Edit the follow-up and refine again, or Discard Follow-up to keep this preview.`
                : followUp.phase === 'unsupported'
                  ? `That follow-up is not supported: ${followUp.message ?? ''} Edit it and refine again, or Discard Follow-up to keep this preview.`
                  : `Refinement failed: ${followUp.message ?? ''} Refine again, or Discard Follow-up to keep this preview.`;
        }
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
          row.textContent = `• [${change.label}] ${change.summary}\nLayer: ${change.layer}; targets: ${change.targetIds.join(', ') || 'none'}; new IDs: ${change.createdIds.join(', ') || 'none'}.`;
          els.changesEl.append(row);
        }
        const exact = document.createElement('pre');
        exact.className = 'ai-sent';
        exact.textContent = JSON.stringify({ coordinateFrame: 'World XY, Model tab', units: status.capture.units, creationDefaults: status.capture.defaults, operations: status.proposal.plan.operations }, null, 2);
        const exactLabel = document.createElement('div');
        exactLabel.textContent = 'Exact operations in drawing units (unrounded values):';
        els.changesEl.append(exactLabel, exact);
        els.versionEl.textContent = `Preview version ${status.version}${status.followUp ? ' — this version stays on screen while the follow-up is unresolved' : ''}`;
        els.followWrap.classList.remove('hidden');
        if (this.shownProposal !== status.proposal) {
          this.lastDiff = this.shownProposal ? diffProposalChanges(this.shownProposal, status.proposal) : null;
          this.shownProposal = status.proposal;
        }
        if (this.lastDiff && (this.lastDiff.updated.length > 0 || this.lastDiff.added.length > 0 || this.lastDiff.removed.length > 0)) {
          const head = document.createElement('div');
          head.textContent = 'Changes from the previous preview version:';
          els.changesEl.append(head);
          for (const updated of this.lastDiff.updated) {
            const row = document.createElement('div');
            row.textContent = `• ${updated.label} changed — was: ${updated.before} → now: ${updated.after}`;
            els.changesEl.append(row);
          }
          for (const added of this.lastDiff.added) {
            const row = document.createElement('div');
            row.textContent = `• ${added.label} added: ${added.summary}`;
            els.changesEl.append(row);
          }
          for (const removed of this.lastDiff.removed) {
            const row = document.createElement('div');
            row.textContent = `• ${removed.label} removed (was: ${removed.summary})`;
            els.changesEl.append(row);
          }
        }
        if (!status.followUp) els.followUpEl.value = '';
        this.refreshRefinePreview();
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
    this.updateDraftAvailability();
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
    this.draftUiEpoch += 1;
    this.clearKeyInput();
    this.resetLiveChecksConfirm();
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
    // Any connection operation supersedes a pending live-checks
    // confirmation: its pinned destination may be about to change.
    this.liveConfirm = null;
    if (invalidate) {
      this.draftConfigEpoch += 1;
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
    this.refreshDraftPreview();
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
    this.refreshDraftPreview();
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
    // Live checks spend real provider calls, so they need the full
    // precondition set the host enforces: key present, provider enabled,
    // no credential or configuration problem.
    const liveReady = ready && !!this.connState?.keyPresent && !!this.connState?.enabled
      && !this.connState?.credentialProblem && !this.connState?.configProblem;
    els.liveRunBtn.disabled = !liveReady || this.liveChecksRunning;
    els.liveConfirmBtn.disabled = !liveReady || this.liveChecksRunning;
    els.liveCancelBtn.disabled = !this.liveChecksRunning;
    this.renderLiveChecks();
  }

  /** Show exactly one of: Run button, inline confirmation, Cancel while running. */
  private renderLiveChecks(): void {
    const els = this.settingsEls;
    if (!els) return;
    const confirming = !this.liveChecksRunning && this.liveConfirm !== null;
    els.liveRunBtn.classList.toggle('hidden', this.liveChecksRunning || confirming);
    els.liveCancelBtn.classList.toggle('hidden', !this.liveChecksRunning);
    els.liveConfirmEl.classList.toggle('hidden', !confirming);
  }

  /** Drop a pending live-checks confirmation without touching a running run. */
  private resetLiveChecksConfirm(): void {
    this.liveConfirm = null;
    this.renderLiveChecks();
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

    // Live provider checks (docs/AI-LIVE-CHECKS.md): a manual, two-step
    // acceptance aid under Test Connection. The first click only reveals
    // the confirmation; the run itself executes main-side over the
    // payload-free channel and this panel just renders its report.
    const liveBlock = document.createElement('div');
    liveBlock.className = 'ai-live-checks';
    const liveLabel = document.createElement('div');
    liveLabel.className = 'ai-section-label';
    liveLabel.textContent = 'Live provider checks';
    const liveNoteEl = document.createElement('div');
    liveNoteEl.className = 'ai-note';
    liveNoteEl.textContent = LIVE_CHECKS_NOTE;
    const liveButtons = document.createElement('div');
    liveButtons.className = 'ai-buttons';
    const liveRunBtn = document.createElement('button');
    liveRunBtn.className = 'ai-live-checks-run';
    liveRunBtn.textContent = 'Run Live Checks';
    liveRunBtn.addEventListener('click', () => this.showLiveChecksConfirm());
    const liveCancelBtn = document.createElement('button');
    liveCancelBtn.className = 'ai-live-checks-cancel hidden';
    liveCancelBtn.textContent = 'Cancel checks';
    liveCancelBtn.addEventListener('click', () => { void this.cancelLiveChecks(); });
    liveButtons.append(liveRunBtn, liveCancelBtn);
    const liveConfirmEl = document.createElement('div');
    liveConfirmEl.className = 'ai-live-checks-confirm hidden';
    const liveConfirmText = document.createElement('div');
    liveConfirmText.className = 'ai-note';
    const liveConfirmButtons = document.createElement('div');
    liveConfirmButtons.className = 'ai-buttons';
    const liveConfirmBtn = document.createElement('button');
    liveConfirmBtn.className = 'ai-live-checks-confirm-run';
    liveConfirmBtn.textContent = 'Run checks';
    liveConfirmBtn.addEventListener('click', () => { void this.runLiveChecks(); });
    const liveConfirmCancelBtn = document.createElement('button');
    liveConfirmCancelBtn.className = 'ai-live-checks-confirm-cancel';
    liveConfirmCancelBtn.textContent = 'Cancel';
    liveConfirmCancelBtn.addEventListener('click', () => this.resetLiveChecksConfirm());
    liveConfirmButtons.append(liveConfirmBtn, liveConfirmCancelBtn);
    liveConfirmEl.append(liveConfirmText, liveConfirmButtons);
    const liveResultEl = document.createElement('pre');
    liveResultEl.className = 'ai-sent ai-live-checks-result hidden';
    liveBlock.append(liveLabel, liveNoteEl, liveButtons, liveConfirmEl, liveResultEl);

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
      probeNoteEl, liveBlock, enableRow, retention, errorEl,
    );
    this.settingsEls = {
      providerSelect, modelSelect, modelCustom, keyLabel, keyInput,
      persistSession, persistEncrypted,
      saveKeyBtn, forgetKeyBtn, testBtn, probeNoteEl, retentionEl: retention,
      enableCheck, stateEl, errorEl,
      liveRunBtn, liveCancelBtn, liveConfirmEl, liveConfirmText,
      liveConfirmBtn, liveConfirmCancelBtn, liveResultEl,
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

  private async refreshConnection(): Promise<boolean> {
    if (!this.connection) return false;
    const epoch = this.startConnectionOperation('Reading connection state…', false);
    if (epoch === null) return false;
    try {
      const state = await this.connection.state();
      if (!this.currentConnectionOperation(epoch)) return false;
      this.setConnState(state);
      return true;
    } catch (cause) {
      if (this.currentConnectionOperation(epoch)) {
        this.connState = null;
        this.liveProvider = null;
        this.clearAnswer();
        if (this.settingsEls) this.settingsEls.stateEl.textContent = 'Connection unavailable — offline demo only.';
        this.setConnError(cause);
      }
      return false;
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

  /**
   * First click of Run Live Checks: reveal the inline confirmation
   * naming the live destination. Nothing is invoked — the run starts
   * only on the second, explicit click (docs/AI-LIVE-CHECKS.md).
   */
  private showLiveChecksConfirm(): void {
    const els = this.settingsEls;
    const state = this.connState;
    if (!els || !state || this.liveChecksRunning || this.connectionBusy) return;
    this.liveConfirm = { provider: state.provider, model: state.model };
    els.liveConfirmText.textContent = `Run 4 checks against ${providerLabel(state.provider)} · ${state.model} now?`;
    this.renderLiveChecks();
  }

  /**
   * Second click: run the fixed live-checks sequence main-side. The
   * confirmation was pinned to a destination; if the connection state
   * has moved since it was shown, the run is refused here and the
   * confirmation is dropped — a run never starts against a destination
   * the user did not confirm.
   */
  private async runLiveChecks(): Promise<void> {
    const els = this.settingsEls;
    if (!els || !this.connection || this.liveChecksRunning) return;
    const confirm = this.liveConfirm;
    const state = this.connState;
    if (!confirm || !state || state.provider !== confirm.provider || state.model !== confirm.model) {
      this.resetLiveChecksConfirm();
      return;
    }
    // Marked running before the operation starts so the availability
    // pass it triggers enables Cancel and disables re-entry.
    this.liveChecksRunning = true;
    const epoch = this.startConnectionOperation('Running live provider checks…', false);
    if (epoch === null) {
      this.liveChecksRunning = false;
      this.renderLiveChecks();
      return;
    }
    this.renderLiveChecks();
    // A new run supersedes any earlier report: clear and hide the
    // previous result at admission, so a rejection of this invocation
    // can never leave a stale PASS on screen reading as current.
    els.liveResultEl.textContent = '';
    els.liveResultEl.classList.add('hidden');
    try {
      const report = await this.connection.runLiveChecks();
      if (!this.currentConnectionOperation(epoch)) return;
      els.liveResultEl.textContent = liveChecksReportText(report);
      els.liveResultEl.classList.remove('hidden');
      if (this.connState) this.setConnState(this.connState);
    } catch (cause) {
      if (this.currentConnectionOperation(epoch)) {
        this.setConnError(cause);
        if (this.connState) this.setConnState(this.connState);
      }
    } finally {
      this.liveChecksRunning = false;
      this.finishConnectionOperation(epoch);
      this.renderLiveChecks();
    }
  }

  /** Cancel the active run (owner-checked main-side); the run settles as cancelled. */
  private async cancelLiveChecks(): Promise<void> {
    if (!this.connection) return;
    try { await this.connection.cancelLiveChecks(); } catch { /* The run settles on its own; cancellation is best-effort. */ }
  }

  private setConnError(cause: unknown): void {
    if (!this.settingsEls) return;
    this.settingsEls.errorEl.textContent = cause instanceof AiError || cause instanceof Error
      ? cause.message
      : 'The AI host reported a failure.';
  }

  private setConnState(state: AiConnectionState): void {
    const previous = this.connState;
    if (previous && ['configGeneration', 'provider', 'model', 'enabled', 'keyPresent', 'keyStored', 'credentialProblem', 'keySource', 'keyPersistence'].some(
      (key) => previous[key as keyof AiConnectionState] !== state[key as keyof AiConnectionState],
    )) {
      this.draftConfigEpoch += 1;
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
    this.refreshDraftPreview();
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
