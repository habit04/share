import type { Editor } from '../app/editor';
import type { Layer, ColorSpec } from '../core/entities';
import { aciToCss, ACI_NAMES } from '../render/palette';
import { icon } from './icons';
import './icons-ui';
import { esc } from './dom';
import { showMenu, closeMenus, type MenuItem } from './menu';

/*
 * Home > Layers panel (layer control dropdown with inline On / Freeze / Lock / colour toggles,
 * Make Current, Match, Isolate / Unisolate, Off, Lock) and Home > Properties panel
 * (Color / Linetype / Lineweight "ByLayer" combos), like AutoCAD's ribbon.
 *
 * Freeze and isolation state are UI-level (the core Layer model has visible/locked only):
 * frozen layers are also turned off, and LAYUNISO restores the visibility snapshot.
 */
const frozenBySession = new Map<number, Set<string>>();
const isolateBackup = new Map<number, Map<string, boolean>>();

function frozenSet(editor: Editor): Set<string> {
  const id = editor.sessions.current.id;
  let s = frozenBySession.get(id);
  if (!s) {
    s = new Set();
    frozenBySession.set(id, s);
  }
  return s;
}

export function isFrozen(editor: Editor, name: string): boolean {
  return frozenSet(editor).has(name);
}

export function setFrozen(editor: Editor, name: string, frozen: boolean): void {
  const s = frozenSet(editor);
  if (frozen) {
    if (name === editor.doc.currentLayer) {
      editor.log('Cannot freeze the current layer.');
      return;
    }
    s.add(name);
    editor.doc.updateLayer(name, { visible: false });
  } else {
    s.delete(name);
    editor.doc.updateLayer(name, { visible: true });
  }
}

/** Linetype combo entries; picking one runs CELTYPE (the drawing's current entity linetype, applied to new objects). */
export const LINETYPES = ['ByLayer', 'ByBlock', 'Continuous', 'DASHED', 'CENTER', 'HIDDEN', 'PHANTOM', 'DOT'];
export const LINEWEIGHTS = ['ByLayer', 'ByBlock', 'Default', '0.00 mm', '0.05 mm', '0.09 mm', '0.13 mm', '0.15 mm', '0.18 mm', '0.20 mm', '0.25 mm', '0.30 mm', '0.35 mm', '0.40 mm', '0.50 mm', '0.53 mm', '0.60 mm', '0.70 mm', '0.80 mm', '0.90 mm', '1.00 mm', '1.06 mm', '1.20 mm', '1.40 mm', '1.58 mm', '2.00 mm', '2.11 mm'];
const COLOR_CHOICES: Array<[ColorSpec, string]> = [
  ['ByLayer', 'ByLayer'],
  ...([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((i): [ColorSpec, string] => [i, ACI_NAMES[i] ?? String(i)]),
  ...([250, 251, 252, 253, 254, 255] as const).map((i): [ColorSpec, string] => [i, `Color ${i}`]),
];

/** Combo label for the header's CELWEIGHT (undefined = ByLayer, -2 = ByBlock, else millimetres). */
function lineweightLabel(w: number | undefined): string {
  if (w === undefined || w === -1) return 'ByLayer';
  if (w === -2) return 'ByBlock';
  if (w === -3) return 'Default';
  return `${w.toFixed(2)} mm`;
}

function colorLabel(c: ColorSpec | '*VARIES*'): string {
  if (c === 'ByLayer' || c === '*VARIES*') return c;
  return ACI_NAMES[c] ?? `Color ${c}`;
}

/** Register layer / property commands used by the panels (additive; no Editor changes). */
export function registerLayerCommands(editor: Editor): void {
  const reg = (name: string, aliases: string[], description: string, run: (ed: Editor, arg?: string) => void) => editor.register({ name, aliases, description, run });
  const selLayers = (ed: Editor) => new Set(ed.entitiesSelected().map((e) => e.layer));

  reg('LAYMCUR', ['LAYMAKECURRENT'], "Make the selected object's layer current", (ed) => {
    const ls = [...selLayers(ed)];
    if (ls.length !== 1) return ed.log('Select one object (or objects on one layer) first.');
    ed.doc.setCurrentLayer(ls[0]!);
    ed.log(`${ls[0]} is now the current layer.`);
  });
  reg('LAYCUR', [], 'Change selected objects to the current layer', (ed) => {
    const sel = ed.entitiesSelected();
    if (sel.length === 0) return ed.log('Nothing selected.');
    ed.doc.replaceEntities(sel.map((e) => ({ ...e, layer: ed.doc.currentLayer })));
    ed.log(`${sel.length} object(s) changed to layer ${ed.doc.currentLayer}.`);
  });
  reg('LAYMCH', ['LAYMATCH'], 'Match layer: change selected objects to the layer of another object', (ed, arg) => {
    const sel = ed.entitiesSelected();
    if (sel.length === 0) return ed.log('Select the objects to change first, then LAYMCH <layer>.');
    const target = (arg ?? '').toUpperCase();
    if (!target || !ed.doc.layer(target)) return ed.log(`Usage: LAYMCH <layer>. Layers: ${ed.doc.layers.map((l) => l.name).join(', ')}`);
    ed.doc.replaceEntities(sel.map((e) => ({ ...e, layer: target })));
    ed.log(`${sel.length} object(s) changed to layer ${target}.`);
  });
  reg('LAYISO', [], 'Isolate the layers of the selected objects', (ed) => {
    const keep = selLayers(ed);
    if (keep.size === 0) return ed.log('Select objects on the layers to isolate first.');
    const id = ed.sessions.current.id;
    if (!isolateBackup.has(id)) isolateBackup.set(id, new Map(ed.doc.layers.map((l) => [l.name, l.visible])));
    for (const l of ed.doc.layers) if (!keep.has(l.name) && l.visible) ed.doc.updateLayer(l.name, { visible: false });
    ed.log(`Layers isolated: ${[...keep].join(', ')}. LAYUNISO restores.`);
  });
  reg('LAYUNISO', [], 'Restore layers hidden by LAYISO', (ed) => {
    const id = ed.sessions.current.id;
    const backup = isolateBackup.get(id);
    if (!backup) return ed.log('No layer isolation is active.');
    for (const [name, visible] of backup) if (ed.doc.layer(name) && !isFrozen(ed, name)) ed.doc.updateLayer(name, { visible });
    isolateBackup.delete(id);
    ed.log('Layer isolation ended.');
  });
  reg('LAYOFF', [], 'Turn off the layers of the selected objects', (ed) => {
    const ls = selLayers(ed);
    if (ls.size === 0) return ed.log('Nothing selected.');
    for (const n of ls) ed.doc.updateLayer(n, { visible: false });
    ed.selection.clear();
    ed.notify('selection');
    ed.log(`Layer(s) turned off: ${[...ls].join(', ')}.`);
  });
  reg('LAYON', [], 'Turn all layers on', (ed) => {
    for (const l of ed.doc.layers) if (!l.visible && !isFrozen(ed, l.name)) ed.doc.updateLayer(l.name, { visible: true });
    ed.log('All layers on.');
  });
  reg('LAYFRZ', [], 'Freeze the layers of the selected objects', (ed) => {
    const ls = selLayers(ed);
    if (ls.size === 0) return ed.log('Nothing selected.');
    for (const n of ls) setFrozen(ed, n, true);
    ed.selection.clear();
    ed.notify('selection');
  });
  reg('LAYTHW', [], 'Thaw all layers', (ed) => {
    for (const n of [...frozenSet(ed)]) setFrozen(ed, n, false);
    ed.log('All layers thawed.');
  });
  reg('LAYLCK', [], 'Lock the layers of the selected objects', (ed) => {
    for (const n of selLayers(ed)) ed.doc.updateLayer(n, { locked: true });
  });
  reg('LAYULK', [], 'Unlock all layers', (ed) => {
    for (const l of ed.doc.layers) if (l.locked) ed.doc.updateLayer(l.name, { locked: false });
  });
  reg('CLAYER', [], 'Set the current layer', (ed, arg) => {
    const n = (arg ?? '').toUpperCase();
    if (n && ed.doc.layer(n)) ed.doc.setCurrentLayer(n);
    else ed.log(`Current layer: ${ed.doc.currentLayer}`);
  });
  reg('COLOR', ['COLOUR', 'CECOLOR'], 'Set the current colour for new objects (ByLayer, 1-255)', (ed, arg) => {
    const a = (arg ?? '').trim();
    if (!a) return ed.log(`Current colour: ${colorLabel(ed.currentColor)}`);
    const c: ColorSpec | null = /^bylayer$/i.test(a) ? 'ByLayer' : /^\d+$/.test(a) ? Math.max(1, Math.min(255, parseInt(a, 10))) : null;
    if (c === null) return ed.log('Enter ByLayer or a colour index 1-255.');
    setColor(ed, c);
  });
  // LINETYPE / CELTYPE and LWEIGHT / CELWEIGHT are the drafting commands (src/app/commands-drafting.ts):
  // they set the drawing header that Drawing.addEntities applies to new objects.
}

function setColor(ed: Editor, c: ColorSpec): void {
  const sel = ed.entitiesSelected();
  if (sel.length > 0) {
    ed.doc.replaceEntities(sel.map((e) => ({ ...e, color: c })));
    ed.log(`${sel.length} object(s) set to colour ${colorLabel(c)}.`);
  } else {
    ed.currentColor = c;
    ed.notify('snap');
    ed.log(`Current colour: ${colorLabel(c)}`);
  }
}

function combo(cls = ''): { el: HTMLElement; label: HTMLElement; lead: HTMLElement } {
  const el = document.createElement('button');
  el.className = `ribbon-combo ${cls}`;
  const lead = document.createElement('span');
  lead.className = 'combo-lead';
  lead.style.display = 'flex';
  lead.style.alignItems = 'center';
  lead.style.gap = '3px';
  const label = document.createElement('span');
  label.className = 'combo-label';
  const arrow = document.createElement('span');
  arrow.className = 'combo-arrow';
  arrow.innerHTML = icon('chevron');
  el.append(lead, label, arrow);
  return { el, label, lead };
}

function stateHtml(l: Layer, frozen: boolean): string {
  return `<span class="state on-${l.visible && !frozen}" title="${l.visible ? 'On' : 'Off'}">${icon('bulb')}</span><span class="state thaw-${!frozen}" title="${frozen ? 'Frozen' : 'Thawed'}">${icon('freeze')}</span><span class="state lock-${l.locked}" title="${l.locked ? 'Locked' : 'Unlocked'}">${l.locked ? icon('lock') : icon('unlock')}</span><span class="swatch" style="background:${aciToCss(l.color)}"></span>`;
}

/** Layer control dropdown with inline toggles. */
function showLayerDropdown(editor: Editor, anchor: HTMLElement, onPick: (name: string) => void): void {
  closeMenus();
  const dd = document.createElement('div');
  dd.className = 'layer-dropdown context-menu';
  const render = () => {
    dd.innerHTML = '';
    for (const l of editor.doc.layers) {
      const frozen = isFrozen(editor, l.name);
      const row = document.createElement('div');
      row.className = 'layer-dropdown-row' + (l.name === editor.doc.currentLayer ? ' current' : '') + (!l.visible ? ' off' : '');
      row.innerHTML = `<span class="layer-row-state on-${l.visible && !frozen}" title="Turn a layer On or Off">${icon('bulb')}</span><span class="layer-row-state thaw-${!frozen}" title="Freeze or thaw">${icon('freeze')}</span><span class="layer-row-state lock-${l.locked}" title="Lock or unlock">${l.locked ? icon('lock') : icon('unlock')}</span><span class="swatch" style="background:${aciToCss(l.color)}" title="Color ${esc(ACI_NAMES[l.color] ?? String(l.color))}"></span><span class="name">${esc(l.name)}</span>`;
      const st = row.querySelectorAll<HTMLElement>('.layer-row-state');
      st[0]!.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (frozen) setFrozen(editor, l.name, false);
        else editor.doc.updateLayer(l.name, { visible: !l.visible });
        render();
      });
      st[1]!.addEventListener('click', (ev) => {
        ev.stopPropagation();
        setFrozen(editor, l.name, !frozen);
        render();
      });
      st[2]!.addEventListener('click', (ev) => {
        ev.stopPropagation();
        editor.doc.updateLayer(l.name, { locked: !l.locked });
        render();
      });
      row.querySelector('.swatch')!.addEventListener('click', (ev) => {
        ev.stopPropagation();
        showMenu(
          row.querySelector('.swatch') as HTMLElement,
          COLOR_CHOICES.filter((c) => typeof c[0] === 'number').map(([c, name]) => ({ label: name, swatch: aciToCss(c as number), check: l.color === c, run: () => editor.doc.updateLayer(l.name, { color: c as number }) })),
        );
      });
      row.addEventListener('click', () => {
        dd.remove();
        onPick(l.name);
      });
      dd.appendChild(row);
    }
  };
  render();
  document.body.appendChild(dd);
  const r = anchor.getBoundingClientRect();
  dd.style.left = `${r.left}px`;
  dd.style.top = `${r.bottom + 2}px`;
  const off = (ev: MouseEvent) => {
    if (!dd.contains(ev.target as Node) && !(ev.target as HTMLElement).closest('.context-menu')) {
      dd.remove();
      window.removeEventListener('mousedown', off, true);
    }
  };
  window.addEventListener('mousedown', off, true);
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      dd.remove();
      window.removeEventListener('keydown', onKey, true);
    }
  };
  window.addEventListener('keydown', onKey, true);
}

/** Content for the Home > Layers ribbon panel (inserted next to the Layer Properties button). */
export function buildLayerPanelContent(editor: Editor): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'ribbon-layer-panel';
  const c = combo('layer-combo');
  c.el.title = 'Layer control: current layer, or the layer of the selection';
  const refresh = () => {
    const sel = editor.entitiesSelected();
    const names = new Set(sel.map((e) => e.layer));
    const name = names.size === 1 ? [...names][0]! : names.size > 1 ? '*VARIES*' : editor.doc.currentLayer;
    const layer = editor.doc.layer(name);
    c.lead.innerHTML = layer ? stateHtml(layer, isFrozen(editor, layer.name)) : '';
    c.label.textContent = name;
  };
  c.el.addEventListener('click', () =>
    showLayerDropdown(editor, c.el, (name) => {
      const sel = editor.entitiesSelected();
      if (sel.length > 0) {
        editor.doc.replaceEntities(sel.map((e) => ({ ...e, layer: name })));
        editor.log(`${sel.length} object(s) moved to layer ${name}.`);
      } else {
        editor.doc.setCurrentLayer(name);
        editor.notify('change');
      }
      refresh();
    }),
  );
  const tools = document.createElement('div');
  tools.className = 'ribbon-layer-tools';
  const tool = (ic: string, title: string, cmd: string) => {
    const b = document.createElement('button');
    b.className = 'ribbon-btn small';
    b.title = `${title}  (${cmd})`;
    b.innerHTML = `<span class="ribbon-icon">${icon(ic)}</span>`;
    b.addEventListener('click', () => {
      if (cmd === 'LAYMCH') {
        const sel = editor.entitiesSelected();
        if (sel.length === 0) return editor.log('Match Layer: select the objects to change first.');
        showMenu(
          b,
          editor.doc.layers.map((l): MenuItem => ({ label: l.name, swatch: aciToCss(l.color), run: () => editor.runCommand(`LAYMCH ${l.name}`) })),
        );
        return;
      }
      editor.runCommand(cmd);
    });
    return b;
  };
  tools.append(tool('current', 'Make Current: set the layer of the selected object current', 'LAYMCUR'), tool('match', 'Match Layer: move selected objects to a chosen layer', 'LAYMCH'), tool('isolate', 'Isolate the layers of the selection', 'LAYISO'), tool('layeron', 'Unisolate / turn all layers on', 'LAYUNISO'), tool('eyeoff', 'Turn the layers of the selection off', 'LAYOFF'), tool('freeze', 'Freeze the layers of the selection', 'LAYFRZ'), tool('lock', 'Lock the layers of the selection', 'LAYLCK'));
  const tools2 = document.createElement('div');
  tools2.className = 'ribbon-layer-tools';
  tools2.append(tool('layers', 'Change selected objects to the current layer', 'LAYCUR'), tool('sun', 'Thaw all layers', 'LAYTHW'), tool('unlock', 'Unlock all layers', 'LAYULK'), tool('eye', 'Turn all layers on', 'LAYON'));
  wrap.append(c.el, tools, tools2);
  editor.on('change', refresh);
  editor.on('selection', refresh);
  editor.on('file', refresh);
  refresh();
  return wrap;
}

/** Content for the Home > Properties ribbon panel: Color / Linetype / Lineweight combos. */
export function buildPropertiesPanelContent(editor: Editor): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'ribbon-props-panel';
  const color = combo('color-combo');
  color.el.title = 'Object colour (applies to the selection, otherwise sets the current colour)';
  const lt = combo('linetype-combo');
  lt.el.title = 'Current linetype';
  const lw = combo('lineweight-combo');
  lw.el.title = 'Current lineweight';
  const refresh = () => {
    const sel = editor.entitiesSelected();
    let c: ColorSpec | '*VARIES*' = editor.currentColor;
    if (sel.length > 0) {
      const first = sel[0]!.color;
      c = sel.every((e) => e.color === first) ? first : '*VARIES*';
    }
    const swatchColor = c === 'ByLayer' ? aciToCss(editor.doc.layer(sel[0]?.layer ?? editor.doc.currentLayer)?.color ?? 7) : c === '*VARIES*' ? '#777' : aciToCss(c);
    color.lead.innerHTML = `<span class="swatch" style="background:${swatchColor}"></span>`;
    color.label.textContent = colorLabel(c);
    lt.lead.innerHTML = `<span class="combo-ic">${icon('linetype')}</span>`;
    lt.label.textContent = editor.doc.header.celtype;
    lw.lead.innerHTML = `<span class="combo-ic">${icon('lineweight')}</span>`;
    lw.label.textContent = lineweightLabel(editor.doc.header.celweight);
  };
  color.el.addEventListener('click', () =>
    showMenu(
      color.el,
      COLOR_CHOICES.map(([c, name]): MenuItem => ({
        label: name,
        swatch: c === 'ByLayer' ? aciToCss(editor.doc.layer(editor.doc.currentLayer)?.color ?? 7) : aciToCss(c),
        check: editor.currentColor === c,
        run: () => setColor(editor, c),
      })),
    ),
  );
  lt.el.addEventListener('click', () => showMenu(lt.el, LINETYPES.map((n): MenuItem => ({ label: n, check: editor.doc.header.celtype.toUpperCase() === n.toUpperCase(), run: () => editor.runCommand(`CELTYPE ${n}`) }))));
  lw.el.addEventListener('click', () =>
    showMenu(lw.el, LINEWEIGHTS.filter((n) => n !== 'Default').map((n): MenuItem => ({ label: n, check: lineweightLabel(editor.doc.header.celweight) === n, run: () => editor.runCommand(`CELWEIGHT ${n.replace(' mm', '')}`) }))),
  );
  wrap.append(color.el, lt.el, lw.el);
  editor.on('change', refresh);
  editor.on('selection', refresh);
  editor.on('snap', refresh);
  editor.on('file', refresh);
  refresh();
  return wrap;
}
