import type { Editor } from '../app/editor';
import { libraryCategories } from '../electrical/library';
import { userLibrary } from '../electrical/userlib';
import type { BlockDef } from '../core/entities';
import { drawPreview } from '../render/draw';
import { icon } from './icons';
import './icons-ui';
import { esc } from './dom';
import { makeDraggable } from './palettes';
import { saveSettings } from '../app/settings';

/** TOOLPALETTES (Ctrl+3): floating window with the symbol library as clickable tiles per category. */
export class ToolPalettes {
  readonly el: HTMLElement;
  private tabsEl: HTMLElement;
  private gridEl: HTMLElement;
  private searchEl: HTMLInputElement;
  private active = 0;

  constructor(private editor: Editor, container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'tool-palettes palette hidden';
    this.el.style.width = `${editor.settings.paletteWidths.toolPalettes}px`;
    const strip = document.createElement('div');
    strip.className = 'palette-strip';
    strip.innerHTML = `<span class="palette-strip-btns">${icon('close')}${icon('drag')}</span><span class="palette-strip-title">Tool Palettes - Schematic Symbols</span>`;
    strip.querySelector('svg')!.addEventListener('click', () => this.toggle(false));
    // The dotted grip is the drag handle (makeDraggable ignores the other strip icons).
    strip.querySelectorAll('svg')[1]?.setAttribute('data-drag-handle', '');
    const main = document.createElement('div');
    main.className = 'tp-main';
    this.searchEl = document.createElement('input');
    this.searchEl.className = 'tp-search';
    this.searchEl.placeholder = 'Search symbols';
    this.searchEl.spellcheck = false;
    this.searchEl.addEventListener('input', () => this.renderGrid());
    this.searchEl.addEventListener('keydown', (ev) => ev.stopPropagation());
    const body = document.createElement('div');
    body.className = 'tp-body';
    this.tabsEl = document.createElement('div');
    this.tabsEl.className = 'tp-tabs';
    this.gridEl = document.createElement('div');
    this.gridEl.className = 'tp-grid';
    body.append(this.gridEl, this.tabsEl);
    main.append(this.searchEl, body);
    this.el.append(strip, main);
    container.appendChild(this.el);
    makeDraggable(this.el, strip);
    this.renderTabs();
    this.renderGrid();
    userLibrary.onChange(() => {
      this.active = Math.min(this.active, Math.max(0, this.categories().length - 1));
      this.renderTabs();
      if (!this.el.classList.contains('hidden')) this.renderGrid();
    });
    if (editor.settings.toolPalettesVisible) this.toggle(true);
  }

  private categories(): Array<{ name: string; symbols: BlockDef[] }> {
    return [...libraryCategories('JIC'), ...libraryCategories('IEC')];
  }

  toggle(show?: boolean): void {
    const vis = show ?? this.el.classList.contains('hidden');
    this.el.classList.toggle('hidden', !vis);
    this.editor.settings = { ...this.editor.settings, toolPalettesVisible: vis };
    saveSettings(this.editor.settings);
    if (vis) this.renderGrid();
  }

  private renderTabs(): void {
    this.tabsEl.innerHTML = '';
    this.categories().forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'tp-tab' + (i === this.active ? ' active' : '');
      b.textContent = c.name.replace(/^IEC: /, 'IEC ');
      b.title = c.name;
      b.addEventListener('click', () => {
        this.active = i;
        this.searchEl.value = '';
        this.renderTabs();
        this.renderGrid();
      });
      this.tabsEl.appendChild(b);
    });
  }

  private renderGrid(): void {
    this.gridEl.innerHTML = '';
    const q = this.searchEl.value.trim().toLowerCase();
    const cats = this.categories();
    const symbols = q ? cats.flatMap((c) => c.symbols).filter((s) => (s.description ?? '').toLowerCase().includes(q) || s.name.toLowerCase().includes(q)) : (cats[this.active]?.symbols ?? []);
    for (const s of symbols) {
      const tile = document.createElement('button');
      tile.className = 'tp-tile';
      tile.title = `${s.description ?? s.name}  (AECOMPONENT ${s.name})`;
      const c = document.createElement('canvas');
      c.width = 56;
      c.height = 40;
      drawPreview(c.getContext('2d')!, s.entities, this.editor.doc.layers, this.editor.doc.lookupBlock, 56, 40, '#e6e6e6', 5);
      const label = document.createElement('span');
      label.innerHTML = esc(s.description ?? s.name);
      tile.append(c, label);
      tile.addEventListener('click', () => this.editor.runCommand(`AECOMPONENT ${s.name}`));
      this.gridEl.appendChild(tile);
    }
    if (symbols.length === 0) {
      const n = document.createElement('div');
      n.className = 'dlg-note';
      n.textContent = 'No symbols match.';
      this.gridEl.appendChild(n);
    }
  }
}
