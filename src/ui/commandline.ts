import type { Editor } from '../app/editor';
import { icon } from './icons';
import { rankSuggestions, cycleIndex, pushRecentInput, looksLikeCommandText, type Suggestion } from './autocomplete';
import { esc } from './dom';

/** Docked command window: scrolling history, AutoComplete list and the input line. */
export class CommandLine {
  readonly el: HTMLElement;
  private historyEl: HTMLElement;
  private promptEl: HTMLElement;
  private listEl: HTMLElement;
  readonly input: HTMLInputElement;
  private typed: string[] = [];
  private typedIndex = -1;
  /** Newest first; feeds the AutoComplete ranking and the right-click "Recent Input" menu. */
  private recent: string[] = [];
  private suggestions: Suggestion[] = [];
  private highlighted = -1;
  /** Called after the user submits a line (used to persist recent input). */
  onRecentChanged: ((recent: readonly string[]) => void) | null = null;

  constructor(private editor: Editor, container: HTMLElement, initialRecent: readonly string[] = []) {
    this.recent = [...initialRecent];
    this.el = container;
    this.el.className = 'command-window';
    this.historyEl = document.createElement('div');
    this.historyEl.className = 'command-history';
    this.listEl = document.createElement('div');
    this.listEl.className = 'command-suggest hidden';
    const line = document.createElement('div');
    line.className = 'command-line';
    const mark = document.createElement('span');
    mark.className = 'command-mark';
    mark.innerHTML = icon('menu');
    mark.title = 'Command window options';
    this.promptEl = document.createElement('span');
    this.promptEl.className = 'command-prompt';
    this.input = document.createElement('input');
    this.input.className = 'command-input';
    this.input.spellcheck = false;
    this.input.autocomplete = 'off';
    this.input.placeholder = '';
    line.append(mark, this.promptEl, this.input);
    this.el.append(this.historyEl, this.listEl, line);

    this.input.addEventListener('keydown', (ev) => this.onKey(ev));
    this.input.addEventListener('input', () => this.updateSuggestions());
    this.input.addEventListener('blur', () => setTimeout(() => this.hideSuggestions(), 120));
    mark.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.showOptionsMenu(mark);
    });

    editor.on('log', () => this.renderHistory());
    editor.on('tool', () => this.renderPrompt());
    this.renderHistory();
    this.renderPrompt();
  }

  focus(): void {
    this.input.focus();
  }

  /** Recently typed input, newest first. */
  recentInput(): readonly string[] {
    return this.recent;
  }

  /** Put text in the input (used by the Recent Input menu). */
  setText(text: string, submit = false): void {
    this.input.value = text;
    this.focus();
    if (submit) this.submit(text);
    else this.updateSuggestions();
  }

  private submit(v: string): void {
    if (v.trim()) {
      this.typed.push(v);
      this.typedIndex = this.typed.length;
      if (!this.editor.tool && looksLikeCommandText(v)) {
        this.recent = pushRecentInput(this.recent, v.trim().toUpperCase());
        this.onRecentChanged?.(this.recent);
      }
    }
    this.input.value = '';
    this.hideSuggestions();
    this.editor.submitInput(v);
  }

  private onKey(ev: KeyboardEvent): void {
    const listOpen = this.suggestions.length > 0 && !this.listEl.classList.contains('hidden');
    if (ev.key === 'Enter') {
      ev.preventDefault();
      if (listOpen && this.highlighted >= 0) {
        const s = this.suggestions[this.highlighted]!;
        const rest = this.input.value.trim().split(/\s+/).slice(1).join(' ');
        this.submit(rest ? `${s.name} ${rest}` : s.name);
        return;
      }
      this.submit(this.input.value);
    } else if (ev.key === ' ' && !this.editor.acceptsFreeText()) {
      // Space acts as Enter (AutoCAD muscle memory: "L<space>"), except while typing text content.
      ev.preventDefault();
      if (listOpen && this.highlighted >= 0) {
        this.submit(this.suggestions[this.highlighted]!.name);
        return;
      }
      this.submit(this.input.value);
    } else if (ev.key === 'Tab' && listOpen) {
      ev.preventDefault();
      this.highlight(cycleIndex(this.highlighted, this.suggestions.length, ev.shiftKey ? -1 : 1));
    } else if (ev.key === 'ArrowDown' && listOpen) {
      ev.preventDefault();
      this.highlight(cycleIndex(this.highlighted, this.suggestions.length, 1));
    } else if (ev.key === 'ArrowUp' && listOpen) {
      ev.preventDefault();
      this.highlight(cycleIndex(this.highlighted, this.suggestions.length, -1));
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (this.typedIndex > 0) {
        this.typedIndex -= 1;
        this.input.value = this.typed[this.typedIndex] ?? '';
      }
    } else if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (this.typedIndex < this.typed.length - 1) {
        this.typedIndex += 1;
        this.input.value = this.typed[this.typedIndex] ?? '';
      } else {
        this.typedIndex = this.typed.length;
        this.input.value = '';
      }
    } else if (ev.key === 'Escape') {
      if (listOpen) {
        ev.stopPropagation();
        this.hideSuggestions();
        return;
      }
      // The window-level handler cancels the command; here we only clear the typed text.
      this.input.value = '';
    }
  }

  // ------------------------------------------------------------- AutoComplete
  private updateSuggestions(): void {
    const text = this.input.value;
    if (this.editor.tool || this.editor.acceptsFreeText() || !looksLikeCommandText(text)) {
      this.hideSuggestions();
      return;
    }
    this.suggestions = rankSuggestions(text, this.editor.commands.values(), this.recent, 8);
    if (this.suggestions.length === 0) {
      this.hideSuggestions();
      return;
    }
    this.highlighted = -1;
    this.renderSuggestions(text.trim().split(/\s+/)[0] ?? '');
  }

  private renderSuggestions(q: string): void {
    const Q = q.toUpperCase();
    const mark = (s: string) => {
      const i = s.indexOf(Q);
      if (i < 0 || !Q) return esc(s);
      return `${esc(s.slice(0, i))}<b>${esc(s.slice(i, i + Q.length))}</b>${esc(s.slice(i + Q.length))}`;
    };
    this.listEl.innerHTML = '';
    this.suggestions.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'suggest-row' + (i === this.highlighted ? ' active' : '');
      const label = s.matchedAlias ? `${mark(s.matchedAlias)} <span class="suggest-full">(${esc(s.name)})</span>` : mark(s.name);
      const aliases = s.aliases.length ? `<span class="suggest-alias">${esc(s.aliases.join(', '))}</span>` : '';
      row.innerHTML = `<span class="suggest-ic">${s.recent ? icon('history') : icon('command')}</span><span class="suggest-name">${label}</span>${aliases}<span class="suggest-desc">${esc(s.description)}</span>`;
      row.addEventListener('mousedown', (ev) => ev.preventDefault());
      row.addEventListener('click', () => this.submit(s.name));
      row.addEventListener('mousemove', () => {
        if (this.highlighted !== i) this.highlight(i);
      });
      this.listEl.appendChild(row);
    });
    this.listEl.classList.remove('hidden');
  }

  private highlight(i: number): void {
    this.highlighted = i;
    this.listEl.querySelectorAll('.suggest-row').forEach((r, k) => r.classList.toggle('active', k === i));
  }

  private hideSuggestions(): void {
    this.suggestions = [];
    this.highlighted = -1;
    this.listEl.classList.add('hidden');
  }

  /** Small menu on the command-window icon: recent input, text window, options. */
  private showOptionsMenu(anchor: HTMLElement): void {
    document.querySelectorAll('.context-menu').forEach((m) => m.remove());
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    const items: Array<[string, () => void] | null> = [
      ['Recent Commands', () => {}],
      ...this.recent.slice(0, 8).map((r): [string, () => void] => [`   ${r}`, () => this.setText(r, true)]),
      null,
      ['Text Window (F2)', () => this.editor.runCommand('TEXTSCR')],
      ['Options...', () => this.editor.runCommand('OPTIONS')],
    ];
    for (const it of items) {
      if (!it) {
        const sep = document.createElement('div');
        sep.className = 'context-sep';
        menu.appendChild(sep);
        continue;
      }
      const b = document.createElement('button');
      b.className = 'context-item';
      b.textContent = it[0];
      b.addEventListener('click', () => {
        menu.remove();
        it[1]();
      });
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.left = `${r.left}px`;
    menu.style.top = `${r.top - menu.getBoundingClientRect().height - 2}px`;
    const off = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node)) {
        menu.remove();
        window.removeEventListener('mousedown', off);
      }
    };
    window.addEventListener('mousedown', off);
  }

  private renderPrompt(): void {
    const promptText = this.editor.prompt === 'Type a command' ? '' : this.editor.prompt;
    const text = this.editor.tool || promptText ? `${this.editor.toolName ? this.editor.toolName + ' ' : ''}${promptText}`.trim() : '';
    this.promptEl.innerHTML = '';
    // Render [Option/Keywords] in accent colour like AutoCAD's clickable options.
    const parts = text.split(/(\[[^\]]*\])/);
    for (const part of parts) {
      if (!part) continue;
      if (part.startsWith('[') && part.endsWith(']')) {
        this.promptEl.appendChild(document.createTextNode('['));
        part
          .slice(1, -1)
          .split('/')
          .forEach((opt, i, arr) => {
            const b = document.createElement('span');
            b.className = 'prompt-option';
            b.textContent = opt;
            b.title = `Option: ${opt}`;
            b.addEventListener('click', () => this.editor.submitInput(opt.replace(/[^A-Za-z]/g, '').slice(0, 1)));
            this.promptEl.appendChild(b);
            if (i < arr.length - 1) this.promptEl.appendChild(document.createTextNode('/'));
          });
        this.promptEl.appendChild(document.createTextNode(']'));
      } else this.promptEl.appendChild(document.createTextNode(part));
    }
    this.input.placeholder = this.editor.tool ? '' : 'Type a command';
    if (this.editor.tool) this.hideSuggestions();
  }

  private renderHistory(): void {
    const lines = this.editor.history.slice(-200);
    this.historyEl.innerHTML = '';
    for (const l of lines) {
      const d = document.createElement('div');
      d.textContent = l;
      this.historyEl.appendChild(d);
    }
    this.historyEl.scrollTop = this.historyEl.scrollHeight;
  }
}
