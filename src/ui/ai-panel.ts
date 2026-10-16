import type { Editor } from '../app/editor/editor';
import { AiAskController, type AiAskStatus } from '../ai/ask-controller';
import { createEditorAiSource } from '../ai/editor-source';
import { FixtureProvider, FIXTURE_PROVIDER_ID } from '../ai/fixture-provider';
import { serializeSnapshot } from '../ai/snapshot';
import type { AiBinding, AiProvider, AiSnapshot } from '../ai/types';
import { icon } from './icons';

/**
 * “Ask about selected objects” palette (docs/AI-ASSISTANT.md).
 *
 * Strictly read-only: it reads the editor through the AI snapshot source,
 * never dispatches a command (so it can never cancel the current tool),
 * never writes selection/document/undo/dirty state, and renders every
 * dynamic string — drawing text, questions, answers — through textContent.
 * The only innerHTML uses are the compile-time icon markup every palette
 * uses for its strip, and clearing containers with ''.
 */
export class AiAssistantPanel {
  readonly el: HTMLElement;
  private readonly controller: AiAskController;
  private readonly unsubscribes: Array<() => void> = [];
  private readonly summaryEl: HTMLElement;
  private readonly sentEl: HTMLElement;
  private readonly questionEl: HTMLTextAreaElement;
  private readonly askBtn: HTMLButtonElement;
  private readonly cancelBtn: HTMLButtonElement;
  private readonly statusEl: HTMLElement;
  private readonly answerEl: HTMLElement;
  private readonly refsEl: HTMLElement;
  private answerBinding: AiBinding | null = null;

  constructor(editor: Editor, container: HTMLElement, provider: AiProvider = new FixtureProvider()) {
    this.el = container;
    this.el.className = 'palette ai-assistant hidden';
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
    const providerLabel = document.createElement('div');
    providerLabel.className = 'ai-provider';
    providerLabel.textContent = provider.id === FIXTURE_PROVIDER_ID
      ? 'Offline demo — no AI model connected. Responses are generated locally; nothing is sent outside JCad.'
      : `Provider: ${provider.id}`;

    this.summaryEl = document.createElement('div');
    this.summaryEl.className = 'ai-summary';

    const sentLabel = document.createElement('div');
    sentLabel.className = 'ai-section-label';
    sentLabel.textContent = 'What will be sent (exactly)';
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

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'ai-status';
    this.answerEl = document.createElement('div');
    this.answerEl.className = 'ai-answer';
    this.refsEl = document.createElement('div');
    this.refsEl.className = 'ai-refs';

    content.append(
      providerLabel, this.summaryEl, sentLabel, this.sentEl, this.questionEl,
      buttons, this.statusEl, this.answerEl, this.refsEl,
    );
    body.append(bar, content);
    this.el.append(body, strip);

    this.controller = new AiAskController(createEditorAiSource(editor), provider);
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
    if (this.isVisible) this.questionEl.focus();
  }

  get isVisible(): boolean {
    return !this.el.classList.contains('hidden');
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
    this.controller.dispose();
  }

  private async ask(): Promise<void> {
    await this.controller.ask(this.questionEl.value);
  }

  private refreshPreview(): void {
    if (!this.isVisible) return;
    let snapshot: AiSnapshot;
    try {
      if (this.answerBinding && !this.controller.isCurrentBinding(this.answerBinding)) {
        this.answerBinding = null;
        this.answerEl.textContent = '';
        this.refsEl.textContent = '';
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
      this.statusEl.textContent = cause instanceof Error ? cause.message : 'The drawing context could not be read.';
      return;
    }
    this.askBtn.disabled = this.controller.status.state === 'asking';
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
        break;
      case 'answered':
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
        break;
      case 'stale':
        this.statusEl.textContent = 'The drawing, selection or space changed while asking, so that answer was not shown. Ask again.';
        this.answerEl.textContent = '';
        this.refsEl.textContent = '';
        break;
      case 'cancelled':
        this.statusEl.textContent = 'Cancelled.';
        this.answerEl.textContent = '';
        this.refsEl.textContent = '';
        break;
      case 'error':
        this.statusEl.textContent = status.error.message;
        this.answerEl.textContent = '';
        this.refsEl.textContent = '';
        break;
    }
    this.refreshPreview();
  }
}
