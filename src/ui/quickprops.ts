import type { Editor } from '../app/editor';
import type { Entity } from '../core/entities';
import { entityBounds } from '../core/entities';
import * as g from '../core/geometry';
import { pickEntity } from '../core/selection';
import { aciToCss, ACI_NAMES } from '../render/palette';
import { icon } from './icons';
import { esc } from './dom';

export function kindName(e: Entity): string {
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

/** Quick Properties: a small floating panel next to the selection (QP / QPMODE). */
export class QuickProperties {
  readonly el: HTMLElement;
  private headEl: HTMLElement;
  private bodyEl: HTMLElement;
  private dragOffset: g.Point | null = null;
  private manualPos: g.Point | null = null;
  private dismissedFor = '';

  constructor(private editor: Editor, private container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'quick-props hidden';
    this.headEl = document.createElement('div');
    this.headEl.className = 'quick-props-head';
    this.bodyEl = document.createElement('div');
    this.el.append(this.headEl, this.bodyEl);
    container.appendChild(this.el);
    this.headEl.addEventListener('mousedown', (ev) => {
      if ((ev.target as HTMLElement).closest('button')) return;
      const r = this.el.getBoundingClientRect();
      this.dragOffset = { x: ev.clientX - r.left, y: ev.clientY - r.top };
      ev.preventDefault();
    });
    window.addEventListener('mousemove', (ev) => {
      if (!this.dragOffset) return;
      const cr = this.container.getBoundingClientRect();
      this.manualPos = { x: ev.clientX - cr.left - this.dragOffset.x, y: ev.clientY - cr.top - this.dragOffset.y };
      this.place();
    });
    window.addEventListener('mouseup', () => (this.dragOffset = null));
    editor.on('selection', () => this.render());
    editor.on('change', () => this.render());
    editor.on('view', () => this.place());
    editor.on('snap', () => this.render());
  }

  private key(): string {
    return [...this.editor.selection].sort().join('|');
  }

  render(): void {
    const sel = this.editor.entitiesSelected();
    if (!this.editor.settings.quickProperties || sel.length === 0 || this.editor.tool || this.dismissedFor === this.key()) {
      this.el.classList.add('hidden');
      if (sel.length === 0) {
        this.dismissedFor = '';
        this.manualPos = null;
      }
      return;
    }
    const doc = this.editor.doc;
    this.headEl.innerHTML = `<span class="qp-title">${sel.length === 1 ? kindName(sel[0]!) : `All (${sel.length})`}</span><button title="Customize (Options > Selection)">${icon('settings')}</button><button title="Close">${icon('close')}</button>`;
    const btns = this.headEl.querySelectorAll('button');
    btns[0]!.addEventListener('click', () => this.editor.runCommand('OPTIONS'));
    btns[1]!.addEventListener('click', () => {
      this.dismissedFor = this.key();
      this.el.classList.add('hidden');
    });
    const b = this.bodyEl;
    b.innerHTML = '';
    const layers = doc.layers.map((l): [string, string] => [l.name, l.name]);
    const common = <K extends 'layer' | 'color'>(key: K) => {
      const first = sel[0]?.[key];
      return sel.every((e) => e[key] === first) ? String(first ?? '') : '*VARIES*';
    };
    const layerVal = common('layer');
    b.appendChild(row('Layer', select(layerVal === '*VARIES*' ? [['*VARIES*', '*VARIES*'], ...layers] : layers, layerVal, (v) => doc.replaceEntities(sel.map((e) => ({ ...e, layer: v }))))));
    const colorVal = common('color');
    const colors: Array<[string, string]> = [['ByLayer', 'ByLayer'], ...Object.entries(ACI_NAMES).map(([k, v]): [string, string] => [k, v])];
    const colorSel = select(colorVal === '*VARIES*' ? [['*VARIES*', '*VARIES*'], ...colors] : colors, colorVal, (v) => doc.replaceEntities(sel.map((e) => ({ ...e, color: v === 'ByLayer' ? ('ByLayer' as const) : parseInt(v, 10) }))));
    const cw = document.createElement('span');
    cw.className = 'prop-color';
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = colorVal === 'ByLayer' ? aciToCss(doc.layer(sel[0]!.layer)?.color ?? 7) : colorVal === '*VARIES*' ? '#777' : aciToCss(parseInt(colorVal, 10));
    cw.append(sw, colorSel);
    b.appendChild(row('Color', cw));
    if (sel.length === 1) {
      const e = sel[0]!;
      const patch = (p: Partial<Entity>) => doc.replaceEntities([{ ...e, ...p } as Entity]);
      const num = (v: number, fn: (n: number) => void) =>
        input(v.toFixed(4), (s) => {
          const n = parseFloat(s);
          if (Number.isFinite(n)) fn(n);
        });
      switch (e.type) {
        case 'line':
          b.append(row('Start X', num(e.a.x, (n) => patch({ a: { x: n, y: e.a.y } }))), row('Start Y', num(e.a.y, (n) => patch({ a: { x: e.a.x, y: n } }))), row('End X', num(e.b.x, (n) => patch({ b: { x: n, y: e.b.y } }))), row('End Y', num(e.b.y, (n) => patch({ b: { x: e.b.x, y: n } }))), row('Length', g.dist(e.a, e.b).toFixed(4)));
          break;
        case 'circle':
          b.append(row('Center X', num(e.center.x, (n) => patch({ center: { x: n, y: e.center.y } }))), row('Center Y', num(e.center.y, (n) => patch({ center: { x: e.center.x, y: n } }))), row('Radius', num(e.radius, (n) => n > 0 && patch({ radius: n }))));
          break;
        case 'arc':
          b.append(row('Center X', num(e.center.x, (n) => patch({ center: { x: n, y: e.center.y } }))), row('Center Y', num(e.center.y, (n) => patch({ center: { x: e.center.x, y: n } }))), row('Radius', num(e.radius, (n) => n > 0 && patch({ radius: n }))));
          break;
        case 'polyline':
          b.append(row('Vertices', String(e.points.length)), row('Closed', select([['1', 'Yes'], ['0', 'No']], e.closed ? '1' : '0', (v) => patch({ closed: v === '1' }))));
          break;
        case 'text':
          b.append(row('Contents', input(e.text, (v) => patch({ text: v }))), row('Height', num(e.height, (n) => n > 0 && patch({ height: n }))), row('Rotation', num((e.rotation * 180) / Math.PI, (n) => patch({ rotation: (n * Math.PI) / 180 }))));
          break;
        case 'insert': {
          b.append(row('Name', esc(e.block)), row('Rotation', num((e.rotation * 180) / Math.PI, (n) => patch({ rotation: (n * Math.PI) / 180 }))));
          for (const tag of ['TAG1', 'DESC1', 'TERM01'] as const) {
            if (e.attributes[tag] !== undefined) b.append(row(tag, input(e.attributes[tag] ?? '', (v) => patch({ attributes: { ...e.attributes, [tag]: v } }))));
          }
          break;
        }
      }
    }
    this.el.classList.remove('hidden');
    this.place();
  }

  private place(): void {
    if (this.el.classList.contains('hidden')) return;
    const sel = this.editor.entitiesSelected();
    let pos = this.manualPos;
    if (!pos) {
      let bounds: g.Bounds | null = null;
      for (const e of sel) bounds = g.unionBounds(bounds, entityBounds(e, this.editor.doc.lookupBlock));
      if (!bounds) return;
      const s = this.editor.viewport.toScreen({ x: bounds.max.x, y: bounds.max.y });
      pos = { x: s.x + 24, y: s.y - 10 };
    }
    const cw = this.container.clientWidth;
    const ch = this.container.clientHeight;
    const w = this.el.offsetWidth || 250;
    const h = this.el.offsetHeight || 120;
    const x = Math.max(4, Math.min(cw - w - 4, pos.x));
    const y = Math.max(4, Math.min(ch - h - 4, pos.y));
    this.el.style.left = `${x}px`;
    this.el.style.top = `${y}px`;
  }
}

function row(label: string, value: string | HTMLElement): HTMLElement {
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
function input(value: string, onCommit: (v: string) => void): HTMLInputElement {
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
function select(options: Array<[string, string]>, value: string, onCommit: (v: string) => void): HTMLSelectElement {
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
  sel.addEventListener('keydown', (ev) => ev.stopPropagation());
  return sel;
}

/** Rollover tooltips: after ~500 ms over an object, show its type, layer and colour. */
export function installRolloverTooltips(editor: Editor, canvas: HTMLElement, container: HTMLElement): void {
  let tip: HTMLElement | null = null;
  let timer = 0;
  const hide = () => {
    window.clearTimeout(timer);
    tip?.remove();
    tip = null;
  };
  canvas.addEventListener('mousemove', (ev) => {
    hide();
    if (!editor.settings.rolloverTooltips || editor.tool) return;
    timer = window.setTimeout(() => {
      const world = editor.cursorPosition();
      if (!world) return;
      const hidden = new Set(editor.doc.layers.filter((l) => !l.visible).map((l) => l.name));
      const locked = new Set(editor.doc.layers.filter((l) => l.locked).map((l) => l.name));
      const hit = pickEntity(world, editor.doc.entities, editor.doc.lookupBlock, editor.viewport.settings.pickBox * editor.viewport.worldPerPixel(), hidden, locked);
      if (!hit) return;
      tip = document.createElement('div');
      tip.className = 'rollover-tip';
      const color = hit.color === 'ByLayer' ? 'ByLayer' : (ACI_NAMES[hit.color] ?? String(hit.color));
      const extra = hit.type === 'insert' ? `<div class="kv"><span>Block</span><span>${esc(hit.block)}${hit.attributes.TAG1 ? ` (${esc(hit.attributes.TAG1)})` : ''}</span></div>` : hit.type === 'line' ? `<div class="kv"><span>Length</span><span>${g.dist(hit.a, hit.b).toFixed(4)}</span></div>` : hit.type === 'text' ? `<div class="kv"><span>Contents</span><span>${esc(hit.text)}</span></div>` : hit.type === 'circle' || hit.type === 'arc' ? `<div class="kv"><span>Radius</span><span>${hit.radius.toFixed(4)}</span></div>` : '';
      tip.innerHTML = `<b>${kindName(hit)}</b><div class="kv"><span>Layer</span><span>${esc(hit.layer)}</span></div><div class="kv"><span>Color</span><span>${esc(color)}</span></div>${extra}`;
      container.appendChild(tip);
      const cr = container.getBoundingClientRect();
      tip.style.left = `${Math.min(ev.clientX - cr.left + 16, cr.width - tip.offsetWidth - 4)}px`;
      tip.style.top = `${Math.min(ev.clientY - cr.top + 18, cr.height - tip.offsetHeight - 4)}px`;
    }, 500);
  });
  canvas.addEventListener('mouseleave', hide);
  canvas.addEventListener('mousedown', hide);
  canvas.addEventListener('wheel', hide);
}
