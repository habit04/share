import type { Editor } from '../app/editor';

/** Docked command window: scrolling history plus the input line. */
export class CommandLine {
  readonly el: HTMLElement;
  private historyEl: HTMLElement;
  private promptEl: HTMLElement;
  readonly input: HTMLInputElement;
  private typed: string[] = [];
  private typedIndex = -1;

  constructor(private editor: Editor, container: HTMLElement) {
    this.el = container;
    this.el.className = 'command-window';
    this.historyEl = document.createElement('div');
    this.historyEl.className = 'command-history';
    const line = document.createElement('div');
    line.className = 'command-line';
    const mark = document.createElement('span');
    mark.className = 'command-mark';
    mark.textContent = '⌨';
    this.promptEl = document.createElement('span');
    this.promptEl.className = 'command-prompt';
    this.input = document.createElement('input');
    this.input.className = 'command-input';
    this.input.spellcheck = false;
    this.input.autocomplete = 'off';
    this.input.placeholder = '';
    line.append(mark, this.promptEl, this.input);
    this.el.append(this.historyEl, line);

    this.input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        const v = this.input.value;
        if (v.trim()) {
          this.typed.push(v);
          this.typedIndex = this.typed.length;
        }
        this.input.value = '';
        this.editor.submitInput(v);
      } else if (ev.key === ' ' && this.input.value.trim() === '' ) {
        // Space acts as Enter in AutoCAD when the line is empty
        ev.preventDefault();
        this.editor.submitInput('');
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
        this.input.value = '';
        this.editor.cancel();
      } else if (ev.key.startsWith('F') && ev.key.length <= 3) {
        if (this.editor.onKeyDown(ev)) ev.preventDefault();
      }
    });

    editor.on('log', () => this.renderHistory());
    editor.on('tool', () => this.renderPrompt());
    this.renderHistory();
    this.renderPrompt();
  }

  focus(): void {
    this.input.focus();
  }

  private renderPrompt(): void {
    this.promptEl.textContent = this.editor.tool || this.editor.prompt !== 'Type a command' ? `${this.editor.toolName ? this.editor.toolName + ' ' : ''}${this.editor.prompt}` : '';
    this.input.placeholder = this.editor.tool ? '' : 'Type a command';
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
