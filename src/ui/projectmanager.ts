import type { Editor } from '../app/editor';
import { icon } from './icons';
import { esc } from './dom';

/** Left-docked Project Manager palette (project tree + details pane). */
export class ProjectManager {
  readonly el: HTMLElement;
  private treeEl: HTMLElement;
  private detailsEl: HTMLElement;

  constructor(private editor: Editor, container: HTMLElement) {
    this.el = container;
    this.el.className = 'palette project-manager';

    // AutoCAD palettes carry a vertical title strip on the docked edge.
    const strip = document.createElement('div');
    strip.className = 'palette-strip';
    strip.innerHTML = `<span class="palette-strip-btns">${icon('close')}${icon('pin')}${icon('settings')}</span><span class="palette-strip-title">Project Manager</span>`;
    strip.querySelector('svg')?.addEventListener('click', () => this.el.classList.add('hidden'));
    const body = document.createElement('div');
    body.className = 'palette-body';
    const bar = document.createElement('div');
    bar.className = 'palette-titlebar';
    bar.innerHTML = `<span class="palette-title">Project Manager</span>`;

    const toolbar = document.createElement('div');
    toolbar.className = 'palette-toolbar';
    const mk = (ic: string, title: string, cmd: string) => {
      const b = document.createElement('button');
      b.className = 'palette-tool';
      b.innerHTML = icon(ic);
      b.title = title;
      b.addEventListener('click', () => this.editor.runCommand(cmd));
      return b;
    };
    toolbar.append(mk('new', 'New drawing', 'NEW'), mk('open', 'Open drawing', 'OPEN'), mk('save', 'Save drawing', 'SAVE'), mk('report', 'Reports', 'LIST'), mk('settings', 'Project properties', 'HELP'));
    const proj = document.createElement('div');
    proj.className = 'palette-project-select';
    proj.innerHTML = `<span>Sample Project</span>${icon('chevron')}`;

    this.treeEl = document.createElement('div');
    this.treeEl.className = 'project-tree';

    const detailsHeader = document.createElement('div');
    detailsHeader.className = 'palette-section-title';
    detailsHeader.innerHTML = `<span>Details</span><span>Preview</span>`;
    this.detailsEl = document.createElement('div');
    this.detailsEl.className = 'project-details';

    body.append(bar, toolbar, proj, this.treeEl, detailsHeader, this.detailsEl);
    this.el.append(strip, body);

    editor.on('file', () => this.render());
    editor.on('change', () => this.renderDetails());
    editor.on('selection', () => this.renderDetails());
    this.render();
  }

  toggle(): void {
    this.el.classList.toggle('hidden');
  }

  private render(): void {
    const name = this.editor.fileName();
    const others = ['001 - Main Power.dxf', '002 - Motor Control.dxf', '003 - PLC I/O.dxf', '004 - Panel Layout.dxf'];
    this.treeEl.innerHTML = `
      <div class="tree-node open"><span class="tree-twisty">▾</span>${icon('project')}<span>Sample Project</span></div>
      <div class="tree-node active lvl1"><span class="tree-twisty"></span>${icon('model')}<span>${esc(name)}${this.editor.doc.dirty ? '*' : ''}</span></div>
      ${others.map((o) => `<div class="tree-node lvl1"><span class="tree-twisty"></span>${icon('model')}<span>${o}</span></div>`).join('')}
      <div class="tree-node lvl1 muted"><span class="tree-twisty">▸</span>${icon('report')}<span>Reports</span></div>
    `;
    this.renderDetails();
  }

  private renderDetails(): void {
    const doc = this.editor.doc;
    const counts = new Map<string, number>();
    for (const e of doc.entities) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    const comps = doc.entities.filter((e) => e.type === 'insert').length;
    const wires = doc.entities.filter((e) => e.type === 'line' && e.layer === 'WIRES').length;
    const sel = this.editor.selection.size;
    this.detailsEl.innerHTML = `
      <div class="kv"><span>File</span><span>${esc(this.editor.fileName())}</span></div>
      <div class="kv"><span>Status</span><span>${doc.dirty ? 'Modified' : 'Saved'}</span></div>
      <div class="kv"><span>Layers</span><span>${doc.layers.length}</span></div>
      <div class="kv"><span>Objects</span><span>${doc.entities.length}</span></div>
      <div class="kv"><span>Components</span><span>${comps}</span></div>
      <div class="kv"><span>Wires</span><span>${wires}</span></div>
      <div class="kv"><span>Selected</span><span>${sel}</span></div>
    `;
  }
}
