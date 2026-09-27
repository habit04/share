import type { Editor } from '../app/editor';
import type { Entity } from '../core/entities';
import { aciToCss, ACI_NAMES } from '../render/palette';
import { icon } from './icons';
import { esc } from './dom';

/** Properties palette: shows and edits the current selection (docked right). */
export class PropertiesPalette {
  readonly el: HTMLElement;
  private bodyEl: HTMLElement;

  constructor(private editor: Editor, container: HTMLElement) {
    this.el = container;
    this.el.className = 'palette properties hidden';
    const strip = document.createElement('div');
    strip.className = 'palette-strip';
    strip.innerHTML = `<span class="palette-strip-btns">${icon('close')}${icon('pin')}</span><span class="palette-strip-title">Properties</span>`;
    strip.querySelector('svg')?.addEventListener('click', () => this.el.classList.add('hidden'));
    const body = document.createElement('div');
    body.className = 'palette-body';
    const bar = document.createElement('div');
    bar.className = 'palette-titlebar';
    bar.innerHTML = `<span class="palette-title">Properties</span>`;
    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'props-body';
    body.append(bar, this.bodyEl);
    this.el.append(body, strip);
    editor.on('selection', () => this.render());
    editor.on('change', () => this.render());
    this.render();
  }

  toggle(): void {
    this.el.classList.toggle('hidden');
    this.render();
  }

  private row(label: string, value: string | HTMLElement): HTMLElement {
    const r = document.createElement('div');
    r.className = 'prop-row';
    const l = document.createElement('span');
    l.className = 'prop-label';
    l.textContent = label;
    r.appendChild(l);
    if (typeof value === 'string') {
      const v = document.createElement('span');
      v.className = 'prop-value';
      v.textContent = value;
      r.appendChild(v);
    } else r.appendChild(value);
    return r;
  }

  private section(title: string): HTMLElement {
    const h = document.createElement('div');
    h.className = 'prop-section';
    h.textContent = title;
    return h;
  }

  private input(value: string, onCommit: (v: string) => void): HTMLInputElement {
    const i = document.createElement('input');
    i.className = 'prop-input';
    i.value = value;
    i.spellcheck = false;
    const commit = () => {
      if (i.value !== value) onCommit(i.value);
    };
    i.addEventListener('change', commit);
    i.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        commit();
        i.blur();
      }
      ev.stopPropagation();
    });
    return i;
  }

  private select(options: Array<[string, string]>, value: string, onCommit: (v: string) => void): HTMLSelectElement {
    const sel = document.createElement('select');
    sel.className = 'prop-input';
    for (const [v, label] of options) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      if (v === value) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => onCommit(sel.value));
    return sel;
  }

  private render(): void {
    if (this.el.classList.contains('hidden')) return;
    const b = this.bodyEl;
    b.innerHTML = '';
    const sel = this.editor.entitiesSelected();
    const doc = this.editor.doc;
    const layers = doc.layers.map((l): [string, string] => [l.name, l.name]);
    const colors: Array<[string, string]> = [['ByLayer', 'ByLayer'], ...Object.entries(ACI_NAMES).map(([k, v]): [string, string] => [k, v])];

    const header = document.createElement('div');
    header.className = 'prop-header';
    header.textContent = sel.length === 0 ? 'No selection' : sel.length === 1 ? kindName(sel[0]!) : `All (${sel.length})`;
    b.appendChild(header);

    b.appendChild(this.section('General'));
    const common = <K extends 'layer' | 'color'>(key: K) => {
      const first = sel[0]?.[key];
      return sel.every((e) => e[key] === first) ? String(first ?? '') : '*VARIES*';
    };
    if (sel.length === 0) {
      b.appendChild(this.row('Layer', this.select(layers, doc.currentLayer, (v) => doc.setCurrentLayer(v))));
      b.appendChild(this.row('Objects', String(doc.entities.length)));
      b.appendChild(this.row('Layers', String(doc.layers.length)));
      b.appendChild(this.row('Blocks', String(Object.keys(doc.blocks).length)));
      return;
    }
    const layerVal = common('layer');
    b.appendChild(
      this.row(
        'Layer',
        this.select(layerVal === '*VARIES*' ? [['*VARIES*', '*VARIES*'], ...layers] : layers, layerVal, (v) => doc.replaceEntities(sel.map((e) => ({ ...e, layer: v })))),
      ),
    );
    const colorVal = common('color');
    const colorSel = this.select(colorVal === '*VARIES*' ? [['*VARIES*', '*VARIES*'], ...colors] : colors, colorVal, (v) =>
      doc.replaceEntities(sel.map((e) => ({ ...e, color: v === 'ByLayer' ? ('ByLayer' as const) : parseInt(v, 10) }))),
    );
    const swatchWrap = document.createElement('span');
    swatchWrap.className = 'prop-color';
    const sw = document.createElement('span');
    sw.className = 'swatch';
    const layerColor = doc.layer(sel[0]!.layer)?.color ?? 7;
    sw.style.background = colorVal === 'ByLayer' ? aciToCss(layerColor) : colorVal === '*VARIES*' ? '#777' : aciToCss(parseInt(colorVal, 10));
    swatchWrap.append(sw, colorSel);
    b.appendChild(this.row('Color', swatchWrap));

    if (sel.length !== 1) return;
    const e = sel[0]!;
    const num = (v: number) => v.toFixed(4);
    const patch = (p: Partial<Entity>) => doc.replaceEntities([{ ...e, ...p } as Entity]);
    const numInput = (v: number, fn: (n: number) => void) =>
      this.input(num(v), (s) => {
        const n = parseFloat(s);
        if (Number.isFinite(n)) fn(n);
      });
    b.appendChild(this.section('Geometry'));
    switch (e.type) {
      case 'line':
        b.appendChild(this.row('Start X', numInput(e.a.x, (n) => patch({ a: { x: n, y: e.a.y } }))));
        b.appendChild(this.row('Start Y', numInput(e.a.y, (n) => patch({ a: { x: e.a.x, y: n } }))));
        b.appendChild(this.row('End X', numInput(e.b.x, (n) => patch({ b: { x: n, y: e.b.y } }))));
        b.appendChild(this.row('End Y', numInput(e.b.y, (n) => patch({ b: { x: e.b.x, y: n } }))));
        b.appendChild(this.row('Length', num(Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y))));
        b.appendChild(this.row('Angle', `${((Math.atan2(e.b.y - e.a.y, e.b.x - e.a.x) * 180) / Math.PI).toFixed(2)}°`));
        break;
      case 'circle':
        b.appendChild(this.row('Center X', numInput(e.center.x, (n) => patch({ center: { x: n, y: e.center.y } }))));
        b.appendChild(this.row('Center Y', numInput(e.center.y, (n) => patch({ center: { x: e.center.x, y: n } }))));
        b.appendChild(this.row('Radius', numInput(e.radius, (n) => n > 0 && patch({ radius: n }))));
        b.appendChild(this.row('Circumference', num(2 * Math.PI * e.radius)));
        break;
      case 'arc':
        b.appendChild(this.row('Center X', numInput(e.center.x, (n) => patch({ center: { x: n, y: e.center.y } }))));
        b.appendChild(this.row('Center Y', numInput(e.center.y, (n) => patch({ center: { x: e.center.x, y: n } }))));
        b.appendChild(this.row('Radius', numInput(e.radius, (n) => n > 0 && patch({ radius: n }))));
        b.appendChild(this.row('Start angle', numInput((e.startAngle * 180) / Math.PI, (n) => patch({ startAngle: (n * Math.PI) / 180 }))));
        b.appendChild(this.row('End angle', numInput((e.endAngle * 180) / Math.PI, (n) => patch({ endAngle: (n * Math.PI) / 180 }))));
        break;
      case 'polyline':
        b.appendChild(this.row('Vertices', String(e.points.length)));
        b.appendChild(this.row('Closed', this.select([['1', 'Yes'], ['0', 'No']], e.closed ? '1' : '0', (v) => patch({ closed: v === '1' }))));
        break;
      case 'text':
        b.appendChild(this.row('Contents', this.input(e.text, (v) => patch({ text: v }))));
        b.appendChild(this.row('Height', numInput(e.height, (n) => n > 0 && patch({ height: n }))));
        b.appendChild(this.row('Rotation', numInput((e.rotation * 180) / Math.PI, (n) => patch({ rotation: (n * Math.PI) / 180 }))));
        b.appendChild(this.row('Justify', this.select([['left', 'Left'], ['center', 'Center'], ['right', 'Right']], e.align, (v) => patch({ align: v as 'left' | 'center' | 'right' }))));
        b.appendChild(this.row('X', numInput(e.position.x, (n) => patch({ position: { x: n, y: e.position.y } }))));
        b.appendChild(this.row('Y', numInput(e.position.y, (n) => patch({ position: { x: e.position.x, y: n } }))));
        break;
      case 'insert': {
        const block = doc.lookupBlock(e.block);
        b.appendChild(this.row('Block', esc(e.block)));
        if (block?.description) b.appendChild(this.row('Symbol', block.description));
        b.appendChild(this.row('X', numInput(e.position.x, (n) => patch({ position: { x: n, y: e.position.y } }))));
        b.appendChild(this.row('Y', numInput(e.position.y, (n) => patch({ position: { x: e.position.x, y: n } }))));
        b.appendChild(this.row('Rotation', numInput((e.rotation * 180) / Math.PI, (n) => patch({ rotation: (n * Math.PI) / 180 }))));
        b.appendChild(this.row('Scale', numInput(e.scale, (n) => n > 0 && patch({ scale: n }))));
        if (block && block.attributes.length) {
          b.appendChild(this.section('Attributes'));
          for (const a of block.attributes) {
            b.appendChild(this.row(a.tag, this.input(e.attributes[a.tag] ?? a.default, (v) => patch({ attributes: { ...e.attributes, [a.tag]: v } }))));
          }
        }
        break;
      }
    }
  }
}

function kindName(e: Entity): string {
  switch (e.type) {
    case 'line':
      return 'Line';
    case 'circle':
      return 'Circle';
    case 'arc':
      return 'Arc';
    case 'polyline':
      return 'Polyline';
    case 'text':
      return 'Text';
    case 'insert':
      return 'Block Reference';
  }
}
