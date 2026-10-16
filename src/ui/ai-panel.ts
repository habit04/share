import type { Editor } from '../app/editor/editor';
import { AiAskController, type AiAskStatus } from '../ai/ask-controller';
import { createEditorAiSource } from '../ai/editor-source';
import { FixtureProvider } from '../ai/fixture-provider';
import { LiveProvider } from '../ai/live-provider';
import { serializeSnapshot } from '../ai/snapshot';
import type { WindowAiConnection, AiConnectionState } from '../ai/host-bridge';
import { AiError, type AiBinding, type AiProvider, type AiSnapshot } from '../ai/types';
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
  openai: ['gpt-5', 'gpt-5.5', 'gpt-5.6', 'gpt-5.6-luna', 'gpt-4.1', 'gpt-4o-mini'],
  anthropic: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-sonnet-4-5'],
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

export class AiAssistantPanel {
  readonly el: HTMLElement;
  private readonly controller: AiAskController;
  private readonly unsubscribes: Array<() => void> = [];
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

  constructor(editor: Editor, container: HTMLElement, provider?: AiProvider, connection?: WindowAiConnection | null) {
    this.el = container;
    this.el.className = 'palette ai-assistant hidden';
    this.connection = connection ?? null;
    // Buttons and other focused descendants need the same boundary as the
    // textarea: Enter/Delete/Escape must never reach global CAD shortcuts.
    this.el.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Escape') {
        ev.preventDefault();
        this.controller.cancel();
      }
    });

    const strip = document.createElement('div');
    strip.className = 'palette-strip';
    strip.innerHTML = `<span class="palette-strip-btns">${icon('close')}${icon('pin')}</span><span class="palette-strip-title">AI Assistant</span>`;
    strip.querySelector('svg')?.addEventListener('click', () => this.el.classList.add('hidden'));

    const body = document.createElement('div');
    body.className = 'palette-body';
    const bar = document.createElement('div');
    bar.className = 'palette-titlebar';
    const title = document.createElement('span');
    title.className = 'palette-title';
    title.textContent = 'AI Assistant — ask about selected objects';
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

    content.append(
      this.providerLabelEl, this.summaryEl, this.sentLabelEl, this.sentEl, this.questionEl,
      buttons, this.billingEl, this.statusEl, this.answerEl, this.refsEl, this.usageEl,
    );
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
    // Rebuild the preview when the selection or document changes. The events
    // are only a hint — the controller re-reads and compares the binding
    // before showing any answer.
    for (const ev of ['selection', 'change', 'file', 'space'] as const) {
      this.unsubscribes.push(editor.on(ev, () => this.refreshPreview()));
    }
    this.renderStatus(this.controller.status);
  }

  toggle(): void {
    this.el.classList.toggle('hidden');
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
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
    this.controller.dispose();
  }

  /** Live only when the host says enabled with a key; the demo otherwise. */
  private routeProvider(): AiProvider {
    if (this.connection && this.connState?.enabled && this.connState.keyPresent && this.liveProvider) {
      return this.liveProvider;
    }
    return this.fixtureProvider;
  }

  private get liveRoute(): boolean {
    return this.routeProvider() !== this.fixtureProvider;
  }

  private async ask(): Promise<void> {
    await this.controller.ask(this.questionEl.value);
  }

  // ------------------------------------------------------------ connection

  private buildSettingsSection(): HTMLElement {
    const conn = this.connection!;
    const section = document.createElement('div');
    section.className = 'ai-settings';

    const label = document.createElement('div');
    label.className = 'ai-section-label';
    label.textContent = 'Connection settings (host-managed)';

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
      option.textContent = PROVIDER_LABELS[id]!;
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
      label, stateEl, providerRow, modelRow, keyLabel, keyInput, persistRow, keyButtons,
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
    if (!this.connection || provider === this.connState?.provider) return;
    this.controller.cancel();
    this.answerBinding = null;
    this.answerEl.textContent = '';
    this.refsEl.textContent = '';
    this.usageEl.textContent = '';
    this.statusEl.textContent = '';
    await this.applySettings(() => this.connection!.setProvider(provider));
  }

  private async refreshConnection(): Promise<void> {
    if (!this.connection) return;
    try {
      this.setConnState(await this.connection.state());
    } catch (cause) {
      this.setConnError(cause);
    }
  }

  /** Run a settings mutation, then render the authoritative host state. */
  private async applySettings(action: () => Promise<AiConnectionState>): Promise<void> {
    if (!this.settingsEls) return;
    this.settingsEls.errorEl.textContent = '';
    try {
      this.setConnState(await action());
    } catch (cause) {
      this.setConnError(cause);
      await this.refreshConnection();
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
    els.errorEl.textContent = '';
    els.stateEl.textContent = 'Testing the connection…';
    try {
      const probe = await this.connection.testConnection();
      els.stateEl.textContent = `Connection OK — ${providerLabel(this.connState?.provider ?? 'openai')} · ${probe.model}`
        + (probe.outputTokens !== undefined ? ` (probe used ${probe.outputTokens} output tokens)` : '')
        + '.';
    } catch (cause) {
      this.setConnError(cause);
      await this.refreshConnection();
    }
  }

  private setConnError(cause: unknown): void {
    if (!this.settingsEls) return;
    this.settingsEls.errorEl.textContent = cause instanceof AiError || cause instanceof Error
      ? cause.message
      : 'The AI host reported a failure.';
  }

  private setConnState(state: AiConnectionState): void {
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
      const keyText = state.keyPresent
        ? `API key: saved (${state.keySource === 'stored' ? 'encrypted on this device' : 'this session only'})`
        : 'API key: not saved';
      els.stateEl.textContent = `Provider: ${label} · Model: ${state.model} · ${keyText}`
        + (state.configProblem ? ` · Settings problem: ${state.configProblem} (defaults in use)` : '');
      els.saveKeyBtn.textContent = state.keyPresent ? 'Replace Key' : 'Save Key';
      els.forgetKeyBtn.disabled = !state.keyPresent;
      els.testBtn.disabled = !state.keyPresent;
      els.enableCheck.checked = state.enabled;
      els.enableCheck.disabled = !state.keyPresent;
      els.persistEncrypted.disabled = !state.encryptionAvailable;
      if (!state.encryptionAvailable && els.persistEncrypted.checked) els.persistSession.checked = true;
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
    this.askBtn.disabled = this.controller.status.state === 'asking';
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
