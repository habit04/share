import type { Editor } from '../app/editor';
import { icon } from './icons';
import { lineweightDisplay } from '../render/draw';

interface ToggleDef {
  key: string;
  icon: string;
  title: string;
  isOn: (ed: Editor) => boolean;
  toggle: (ed: Editor) => void;
}

const TOGGLES: ToggleDef[] = [
  { key: 'grid', icon: 'grid', title: 'Display drawing grid (F7)', isOn: (e) => e.viewport.settings.gridVisible, toggle: (e) => e.toggle('grid') },
  { key: 'snap', icon: 'snap', title: 'Snap to drawing grid (F9)', isOn: (e) => e.snap.gridSnap, toggle: (e) => e.toggle('gridSnap') },
  { key: 'ortho', icon: 'ortho', title: 'Restrict cursor orthogonally (F8)', isOn: (e) => e.snap.ortho, toggle: (e) => e.toggle('ortho') },
  { key: 'polar', icon: 'polar', title: 'Polar tracking (F10)', isOn: (e) => e.snap.polar, toggle: (e) => e.toggle('polar') },
  { key: 'osnap', icon: 'osnap', title: 'Object snap (F3)', isOn: (e) => e.snap.osnap, toggle: (e) => e.toggle('osnap') },
  { key: 'otrack', icon: 'otrack', title: 'Object snap tracking (F11)', isOn: () => false, toggle: () => {} },
  { key: 'dyn', icon: 'dyn', title: 'Dynamic input (F12)', isOn: (e) => e.dynamicInput, toggle: (e) => e.toggle('dyn') },
  { key: 'lw', icon: 'lw', title: 'Show/hide lineweight (LWDISPLAY)', isOn: () => lineweightDisplay.enabled, toggle: (e) => e.toggle('lw') },
];

export class StatusBar {
  readonly el: HTMLElement;
  private coordsEl: HTMLElement;
  private buttons = new Map<string, HTMLButtonElement>();
  private scaleEl: HTMLElement;

  constructor(private editor: Editor, container: HTMLElement) {
    this.el = container;
    this.el.className = 'statusbar';

    this.coordsEl = document.createElement('div');
    this.coordsEl.className = 'status-coords';
    this.coordsEl.textContent = '0.0000, 0.0000, 0.0000';
    this.el.appendChild(this.coordsEl);

    const model = document.createElement('button');
    model.className = 'status-btn on text';
    model.textContent = 'MODEL';
    model.title = 'Model space';
    this.el.appendChild(model);

    for (const t of TOGGLES) {
      const b = document.createElement('button');
      b.className = 'status-btn';
      b.innerHTML = icon(t.icon);
      b.title = t.title;
      b.addEventListener('click', () => {
        t.toggle(this.editor);
        this.refresh();
      });
      this.buttons.set(t.key, b);
      this.el.appendChild(b);
    }

    const spacer = document.createElement('div');
    spacer.className = 'status-spacer';
    this.el.appendChild(spacer);

    this.scaleEl = document.createElement('div');
    this.scaleEl.className = 'status-text';
    this.scaleEl.innerHTML = `<span>1:1</span>${icon('chevron')}`;
    this.scaleEl.title = 'Annotation scale';
    this.el.appendChild(this.scaleEl);

    const ws = document.createElement('div');
    ws.className = 'status-text';
    ws.innerHTML = `${icon('settings')} <span>ACADE &amp; 2D Drafting</span>`;
    ws.title = 'Workspace';
    this.el.appendChild(ws);

    const units = document.createElement('div');
    units.className = 'status-text';
    units.textContent = 'Decimal · in';
    this.el.appendChild(units);

    const customize = document.createElement('button');
    customize.className = 'status-btn';
    customize.innerHTML = icon('menu');
    customize.title = 'Customization';
    this.el.appendChild(customize);

    editor.on('view', () => this.refreshCoords());
    editor.on('snap', () => this.refresh());
    this.refresh();
  }

  private refreshCoords(): void {
    const p = this.editor.cursorPosition();
    if (p) this.coordsEl.textContent = `${p.x.toFixed(4)}, ${p.y.toFixed(4)}, 0.0000`;
  }

  refresh(): void {
    for (const t of TOGGLES) {
      const b = this.buttons.get(t.key)!;
      b.classList.toggle('on', t.isOn(this.editor));
    }
    this.refreshCoords();
  }
}
