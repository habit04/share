/**
 * Symbol Builder UI: the start dialog ("Symbol Builder"), the docked palette
 * shown while a symbol tab is active, the user-symbol chooser used by the
 * icon menu's Edit... button and the small Rename / error dialogs. The logic
 * lives in src/tools/symbol-builder.ts (controller) and
 * src/electrical/symbol-builder-core.ts (conversions).
 */
import type { Editor } from '../app/editor';
import type { BlockDef, Entity, TextEntity } from '../core/entities';
import { entityBounds } from '../core/entities';
import type { DrawingState } from '../core/document';
import type { Bounds } from '../core/geometry';
import { unionBounds } from '../core/geometry';
import { drawEntity, type Transform } from '../render/draw';
import { LIBRARY_SYMBOLS, findLibrarySymbol, searchLibrary, libraryCategoryNames, isBuiltinSymbol } from '../electrical/library';
import { tagPrefix } from '../electrical/symbols';
import { userLibrary, DEFAULT_USER_CATEGORY, type SymbolStandard } from '../electrical/userlib';
import {
  SYMBOL_KINDS,
  SYMBOL_KIND_SHORT,
  PIN_DIRECTIONS,
  PLACEABLE_ATTRIBUTES,
  DEFAULT_EDITABLE_ATTRIBUTES,
  BASE_POINT_CHOICES,
  ORIENTATIONS,
  kindFromBlock,
  kindHint,
  orientationFromBlock,
  normalizeSymbolName,
  isPlaceholder,
  isPinMarker,
  isSymbolGeometry,
  summarizeCheck,
  attributePrompt,
  type SymbolMeta,
  type SymbolKind,
  type SymbolOrientation,
  type PinDirection,
  type BasePointChoice,
  type CheckMessage,
  type RenameChoice,
} from '../electrical/symbol-builder-core';
import { validBlockName } from '../tools/blocks';
import type { SymbolBuilder, SymbolBuilderUi, SymbolBuilderStart, StartDialogInit, SymbolSource } from '../tools/symbol-builder';
import { electricalUi } from '../app/commands-electrical';
import { modal, button } from './dialogkit';
import { makePaletteResizable } from './palettes';
import { updateSettings } from './options';
import { icon } from './icons';
import { esc } from './dom';
import type { UserSettings } from '../app/settings';

// ---------------------------------------------------------------- small DOM helpers (light dialog look)

let fieldCounter = 0;
function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  const row = document.createElement('label');
  row.className = 'field';
  const l = document.createElement('span');
  l.textContent = label;
  row.append(l, input);
  if (hint) {
    row.title = hint;
    input.title = hint;
  }
  return row;
}
/** Text input for a light dialog; Enter calls `onEnter` (submit) instead of being swallowed. */
function textInput(value: string, placeholder = '', onEnter?: () => void): HTMLInputElement {
  const i = document.createElement('input');
  i.className = 'input';
  i.value = value;
  i.placeholder = placeholder;
  i.spellcheck = false;
  i.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && onEnter) {
      ev.preventDefault();
      ev.stopPropagation();
      onEnter();
      return;
    }
    if (ev.key !== 'Escape') ev.stopPropagation();
  });
  return i;
}
function select(options: Array<[string, string]>, value: string): HTMLSelectElement {
  const s = document.createElement('select');
  s.className = 'input';
  for (const [v, label] of options) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    if (v === value) o.selected = true;
    s.appendChild(o);
  }
  return s;
}
let datalistCounter = 0;
function withDatalist(input: HTMLInputElement, values: readonly string[]): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'sb-datalist';
  const dl = document.createElement('datalist');
  dl.id = `sb-dl-${(datalistCounter += 1)}`;
  for (const v of values) {
    const o = document.createElement('option');
    o.value = v;
    dl.appendChild(o);
  }
  input.setAttribute('list', dl.id);
  wrap.append(input, dl);
  return wrap;
}
function fieldset(legend: string, ...children: HTMLElement[]): HTMLElement {
  const fs = document.createElement('fieldset');
  const lg = document.createElement('legend');
  lg.textContent = legend;
  fs.append(lg, ...children);
  return fs;
}
function hintEl(text: string, cls = 'hint'): HTMLElement {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = text;
  return d;
}

/** Families the tag-prefix table knows (built-in symbols) plus the user symbols' families. */
export function knownFamilies(): string[] {
  const set = new Set<string>();
  for (const s of LIBRARY_SYMBOLS) set.add(tagPrefix(s.name));
  for (const s of userLibrary.all()) set.add(s.family);
  set.delete('DEV');
  return [...set].sort();
}

// ---------------------------------------------------------------- previews

interface PreviewOptions {
  color?: string;
  attrColor?: string;
  pinColor?: string;
  background?: string;
  /** Draw only TAG1 among the attribute texts (chooser thumbnails). */
  tagOnly?: boolean;
  /** Small squares at the wire connection points. */
  pins?: Array<{ x: number; y: number }>;
}

function drawPreviewInto(canvas: HTMLCanvasElement, geometry: readonly Entity[], attrs: readonly TextEntity[], layers: Editor['doc']['layers'], lookup: Editor['doc']['lookupBlock'], opts: PreviewOptions): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = opts.background ?? '#202020';
  ctx.fillRect(0, 0, w, h);
  let b: Bounds | null = null;
  for (const e of [...geometry, ...attrs]) {
    try {
      b = unionBounds(b, entityBounds(e, lookup));
    } catch {
      /* a malformed imported entity must not break the whole list */
    }
  }
  if (!b) return;
  const pad = 8;
  const bw = Math.max(b.max.x - b.min.x, 1e-6);
  const bh = Math.max(b.max.y - b.min.y, 1e-6);
  const s = Math.min((w - pad * 2) / bw, (h - pad * 2) / bh);
  const cx = (b.min.x + b.max.x) / 2;
  const cy = (b.min.y + b.max.y) / 2;
  const tf: Transform = { scale: s, toScreen: (p) => ({ x: w / 2 + (p.x - cx) * s, y: h / 2 - (p.y - cy) * s }) };
  // origin marker
  const o = tf.toScreen({ x: 0, y: 0 });
  ctx.strokeStyle = 'rgba(120,200,255,0.6)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(o.x - 5, o.y);
  ctx.lineTo(o.x + 5, o.y);
  ctx.moveTo(o.x, o.y - 5);
  ctx.lineTo(o.x, o.y + 5);
  ctx.stroke();
  for (const e of geometry) {
    try {
      drawEntity(ctx, e, tf, layers, lookup, { strokeOverride: opts.color ?? '#e6e6e6', lineWidthOverride: 1 });
    } catch {
      /* skip broken entity */
    }
  }
  for (const e of attrs) drawEntity(ctx, e, tf, layers, lookup, { strokeOverride: opts.attrColor ?? '#e2c55a', lineWidthOverride: 1 });
  if (opts.pins) {
    ctx.strokeStyle = opts.pinColor ?? 'rgba(255,140,120,0.95)';
    for (const p of opts.pins) {
      const q = tf.toScreen(p);
      ctx.strokeRect(Math.round(q.x) - 2.5, Math.round(q.y) - 2.5, 5, 5);
    }
  }
}

/**
 * Draw a block preview: geometry in `color`, visible attribute tags in `attrColor`
 * (only TAG1 with `tagOnly`, for thumbnails), scaled to fit.
 */
export function drawSymbolPreview(canvas: HTMLCanvasElement, block: BlockDef, layers: Editor['doc']['layers'], lookup: Editor['doc']['lookupBlock'], opts: PreviewOptions = {}): void {
  const attrs: TextEntity[] = block.attributes
    .filter((a) => !a.invisible && (!opts.tagOnly || a.tag === 'TAG1'))
    .map((a) => ({ id: `pv-${a.tag}`, layer: '0', color: 'ByLayer', type: 'text', position: a.position, text: a.tag, height: a.height, rotation: (a as { rotation?: number }).rotation ?? 0, align: a.align }));
  drawPreviewInto(canvas, block.entities, attrs, layers, lookup, opts);
}

/** Preview of an editing state: exactly the geometry and the placeholders in the state, plus the compiled pin points. */
export function drawSymbolStatePreview(canvas: HTMLCanvasElement, state: DrawingState, pins: Array<{ x: number; y: number }>, layers: Editor['doc']['layers'], lookup: Editor['doc']['lookupBlock']): void {
  const geometry = state.entities.filter((e) => isSymbolGeometry(e));
  const attrs = state.entities.filter(isPlaceholder).map((t) => ({ ...t, text: t.text.trim().toUpperCase() }));
  drawPreviewInto(canvas, geometry, attrs, layers, lookup, { pins });
}

// ---------------------------------------------------------------- start dialog

export function symbolBuilderStartDialog(editor: Editor, init: StartDialogInit): Promise<SymbolBuilderStart | null> {
  return new Promise((resolve) => {
    const m = modal('Symbol Builder', 840, 'light');
    m.root.classList.add('sb-dialog-root');
    let done = false;
    const finish = (v: SymbolBuilderStart | null) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    m.onClose(() => finish(null));
    const submit = () => ok.click();

    // ---- left: symbol properties
    const name = textInput(init.meta.name, 'e.g. USER_PB1', submit);
    name.addEventListener('input', () => {
      const pos = name.selectionStart;
      name.value = normalizeSymbolName(name.value);
      if (pos !== null) name.setSelectionRange(pos, pos);
    });
    const desc = textInput(init.meta.description, 'shown in the icon menu', submit);
    const standard = select(
      [
        ['JIC', 'JIC (NFPA 79 ladder)'],
        ['IEC', 'IEC 60617'],
      ],
      init.meta.standard,
    );
    const category = textInput(init.meta.category || DEFAULT_USER_CATEGORY, '', submit);
    const categoryWrap = withDatalist(category, libraryCategoryNames(init.meta.standard));
    const refreshCategories = () => {
      const dl = categoryWrap.querySelector('datalist')!;
      dl.innerHTML = '';
      for (const c of libraryCategoryNames(standard.value as SymbolStandard)) {
        const o = document.createElement('option');
        o.value = c;
        dl.appendChild(o);
      }
    };
    standard.addEventListener('change', refreshCategories);
    const family = textInput(init.meta.family, 'PB, CR, LS ...', submit);
    family.addEventListener('input', () => (family.value = family.value.toUpperCase()));
    const familyWrap = withDatalist(family, knownFamilies());
    const familyHint = hintEl('Tags become PB1, PB2 ... (or the drawing’s tag format); the family also picks the default pin numbers (PB 3/4, CR A1/A2 ...).');
    const kind = select(SYMBOL_KINDS, init.meta.kind);
    const kindHintEl = hintEl(kindHint(init.meta.kind));
    const orientation = select(ORIENTATIONS, init.meta.orientation);
    const contact = select(
      [
        ['NO', 'Normally open (_NO, pins 13/14)'],
        ['NC', 'Normally closed (_NC, pins 11/12)'],
      ],
      init.meta.contact ?? 'NO',
    );
    const contactRow = field('Contact', contact, 'NO / NC pairs share a name stem: Toggle NO/NC and AESWAP flip between <name>_NO and <name>_NC.');
    const syncKind = () => {
      const k = kind.value as SymbolKind;
      kindHintEl.textContent = kindHint(k);
      contactRow.style.display = k === 'child' || k === 'standalone' ? '' : 'none';
      if (k === 'child') {
        const base = name.value.replace(/_N[OC]$/, '');
        if (base) name.value = `${base}_${contact.value}`;
      }
    };
    kind.addEventListener('change', syncKind);
    contact.addEventListener('change', () => {
      if (kind.value === 'child' || /_N[OC]$/.test(name.value)) {
        const base = name.value.replace(/_N[OC]$/, '');
        if (base) name.value = `${base}_${contact.value}`;
      }
    });
    // A new family suggests a matching name while the user has not typed their own.
    let nameTouched = !/^USER_/.test(init.meta.name);
    name.addEventListener('input', () => (nameTouched = true));
    family.addEventListener('change', () => {
      if (!nameTouched) name.value = init.suggestName(family.value) + (kind.value === 'child' ? `_${contact.value}` : '');
    });
    const nameHint = hintEl('');
    const validateName = () => {
      const n = name.value.trim().toUpperCase();
      if (!n) nameHint.textContent = 'Block name of the symbol (upper case, no spaces).';
      else if (!validBlockName(n)) nameHint.textContent = 'Invalid block name: no <>/\\":;?*|,=` characters.';
      else if (findLibrarySymbol(n) && !userLibrary.has(n)) nameHint.textContent = `${n} is a built-in library symbol; choose another name.`;
      else if (userLibrary.has(n)) nameHint.textContent = `${n} exists in the user library: saving will replace it.`;
      else nameHint.textContent = 'Block name of the symbol (upper case, no spaces).';
    };
    name.addEventListener('input', validateName);
    validateName();
    const left = fieldset(
      'Symbol',
      field('Name', name),
      nameHint,
      field('Description', desc),
      field('Standard', standard),
      field('Category', categoryWrap, 'Icon-menu category ("User: <category>")'),
      field('Family / tag prefix', familyWrap),
      familyHint,
      field('Role', kind),
      kindHintEl,
      contactRow,
      field('Orientation', orientation, 'Horizontal symbols sit inline on a rung (stubs at x = +-0.375); vertical ones on a vertical wire (stubs at y = +-0.375).'),
    );
    left.className = 'sb-col';
    syncKind();

    // ---- right: start from
    let source: SymbolSource = { kind: 'blank' };
    const radios: Array<{ input: HTMLInputElement; body: HTMLElement; kind: SymbolSource['kind'] }> = [];
    const option = (k: SymbolSource['kind'], label: string, body: HTMLElement, disabled = false) => {
      const row = document.createElement('div');
      row.className = 'sb-option';
      const l = document.createElement('label');
      l.className = 'radio-row';
      const r = document.createElement('input');
      r.type = 'radio';
      r.name = 'sb-source';
      r.value = k;
      r.disabled = disabled;
      l.append(r, document.createTextNode(` ${label}`));
      body.className = 'sb-option-body';
      row.append(l, body);
      radios.push({ input: r, body, kind: k });
      return row;
    };
    let blockApplied = false;
    const syncSource = () => {
      const active = radios.find((r) => r.input.checked)?.kind ?? 'blank';
      for (const r of radios) r.body.classList.toggle('active', r.kind === active);
      if (active === 'block' && !blockApplied) applyBlockChoice();
      if (active === 'library' && !libChoice) libInfo.textContent = 'Type to search, then pick a symbol.';
    };

    // blank
    const blankBody = hintEl('Empty symbol with the guides and the attribute template of the role (TAG1 + DESC1, or TERM01); draw with LINE / CIRCLE / ARC / PLINE around the origin.');

    // library copy
    const libBody = document.createElement('div');
    const search = textInput('', 'Search both standards by name or description (e.g. push button, HPB11_NO)');
    const libList = document.createElement('div');
    libList.className = 'sb-list';
    const libPreview = document.createElement('canvas');
    libPreview.width = 200;
    libPreview.height = 110;
    libPreview.className = 'sb-preview';
    const libInfo = hintEl('Type to search, then pick a symbol.');
    let libChoice: BlockDef | null = null;
    const applyLibChoice = (def: BlockDef) => {
      libChoice = def;
      drawSymbolPreview(libPreview, def, editor.doc.layers, editor.doc.lookupBlock);
      libInfo.textContent = `${def.name} - ${def.description ?? ''}`;
      const fam = tagPrefix(def.name);
      family.value = fam;
      if (!desc.value.trim() || desc.dataset.auto === '1') {
        desc.value = def.description ?? '';
        desc.dataset.auto = '1';
      }
      kind.value = kindFromBlock(def);
      if (kind.value === 'child' || /_N[OC]$/.test(def.name)) contact.value = /_NC$/.test(def.name) ? 'NC' : 'NO';
      standard.value = def.name.startsWith('IEC_') ? 'IEC' : 'JIC';
      orientation.value = orientationFromBlock(def);
      refreshCategories();
      if (!nameTouched) name.value = init.suggestName(fam) + (kind.value === 'child' ? `_${contact.value}` : '');
      syncKind();
      validateName();
      libList.querySelectorAll('.sb-list-item').forEach((el) => el.classList.toggle('active', (el as HTMLElement).dataset.name === def.name));
    };
    const renderLib = () => {
      libList.innerHTML = '';
      const q = search.value.trim();
      const jic = q ? searchLibrary('JIC', q) : [];
      const results = q ? [...jic, ...searchLibrary('IEC', q).filter((s) => !jic.includes(s))].slice(0, 60) : [];
      if (!q) libList.appendChild(hintEl('Enter part of a name or description.', 'dlg-note'));
      else if (results.length === 0) libList.appendChild(hintEl('No symbols match.', 'dlg-note'));
      for (const s of results) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'sb-list-item' + (libChoice?.name === s.name ? ' active' : '');
        item.dataset.name = s.name;
        item.innerHTML = `<b>${esc(s.name)}</b><span>${esc(s.description ?? '')}</span>`;
        item.addEventListener('click', () => {
          radios.find((r) => r.kind === 'library')!.input.checked = true;
          syncSource();
          applyLibChoice(s);
        });
        libList.appendChild(item);
      }
      if (q && results.length === 1 && results[0] && libChoice?.name !== results[0].name) applyLibChoice(results[0]);
    };
    search.addEventListener('input', renderLib);
    search.addEventListener('focus', () => {
      radios.find((r) => r.kind === 'library')!.input.checked = true;
      syncSource();
    });
    const libRow = document.createElement('div');
    libRow.className = 'sb-lib-row';
    const libPreviewBox = document.createElement('div');
    libPreviewBox.className = 'sb-preview-box';
    libPreviewBox.append(libPreview, libInfo);
    libRow.append(libList, libPreviewBox);
    libBody.append(search, libRow);
    renderLib();

    // block in drawing
    const blockBody = document.createElement('div');
    const blockSel = select(
      init.blocks.length ? init.blocks.map((b): [string, string] => [b.name, `${b.name}${b.description ? ` - ${b.description}` : ''}${b.libraryName ? ' (library name: saved as USER_' + b.name + ')' : ''}`]) : [['', '(no harvestable blocks in this drawing)']],
      init.blocks[0]?.name ?? '',
    );
    const blockPreview = document.createElement('canvas');
    blockPreview.width = 200;
    blockPreview.height = 110;
    blockPreview.className = 'sb-preview';
    const basePoint = select(
      BASE_POINT_CHOICES.map(([k, v]): [string, string] => [k, v]),
      'stubs',
    );
    const blockScale = document.createElement('label');
    blockScale.className = 'radio-row';
    const blockScaleInput = document.createElement('input');
    blockScaleInput.type = 'checkbox';
    blockScaleInput.checked = true;
    blockScale.append(blockScaleInput, document.createTextNode(' Scale the geometry to 0.75 in wide (inline symbol); stub ends snap onto y = 0 and x = ±0.375'));
    const blockInfo = hintEl('');
    const renderBlock = () => {
      const def = editor.doc.blocks[blockSel.value];
      const ctx = blockPreview.getContext('2d');
      if (!def) {
        if (ctx) {
          ctx.fillStyle = '#202020';
          ctx.fillRect(0, 0, blockPreview.width, blockPreview.height);
        }
        blockInfo.textContent = 'Blocks of the current drawing (e.g. from a manufacturer DWG) can be harvested; nested blocks are exploded. Blocks already in the user library are edited with Edit... instead.';
        return;
      }
      drawSymbolPreview(blockPreview, def, editor.doc.layers, editor.doc.lookupBlock);
      const attrs = def.attributes.map((a) => a.tag).join(', ');
      blockInfo.textContent = `${def.entities.length} object(s)${attrs ? `, attributes: ${attrs}` : ''}`;
    };
    const applyBlockChoice = () => {
      const def = editor.doc.blocks[blockSel.value];
      renderBlock();
      if (!def) return;
      blockApplied = true;
      if (!nameTouched) {
        const candidate = normalizeSymbolName(def.name);
        name.value = !validBlockName(candidate) ? init.suggestName(family.value) : isBuiltinSymbol(candidate) ? `USER_${candidate}` : candidate;
      }
      if (!desc.value.trim() || desc.dataset.auto === '1') {
        desc.value = def.description ?? '';
        desc.dataset.auto = '1';
      }
      kind.value = kindFromBlock(def);
      orientation.value = orientationFromBlock(def);
      syncKind();
      validateName();
    };
    blockSel.addEventListener('change', () => {
      radios.find((r) => r.kind === 'block')!.input.checked = true;
      syncSource();
      applyBlockChoice();
    });
    const blockRow = document.createElement('div');
    blockRow.className = 'sb-lib-row';
    const blockLeft = document.createElement('div');
    blockLeft.className = 'sb-block-fields';
    blockLeft.append(field('Block', blockSel), field('Base point (symbol origin)', basePoint, 'Text is ignored when measuring; "Midpoint of the wire stubs" is the midpoint between the leftmost and rightmost line ends.'), blockScale);
    const blockPreviewBox = document.createElement('div');
    blockPreviewBox.className = 'sb-preview-box';
    blockPreviewBox.append(blockPreview, blockInfo);
    blockRow.append(blockLeft, blockPreviewBox);
    blockBody.append(blockRow);
    renderBlock();

    // selection
    const selBody = document.createElement('div');
    const selInfo = hintEl(init.selectionCount ? `${init.selectionCount} object(s) selected. After OK, pick the base point (wire-connection centre) in the drawing.` : 'Select the objects in the drawing first, then start the Symbol Builder.');
    const selScale = document.createElement('label');
    selScale.className = 'radio-row';
    const selScaleInput = document.createElement('input');
    selScaleInput.type = 'checkbox';
    selScaleInput.checked = false;
    selScale.append(selScaleInput, document.createTextNode(' Scale the objects to 0.75 in wide (inline symbol)'));
    selBody.append(selInfo, selScale);

    const right = fieldset(
      'Start from',
      option('blank', 'Blank symbol', blankBody),
      option('library', 'Copy of a library symbol', libBody),
      option('block', 'Block in the current drawing (harvest a manufacturer block)', blockBody, init.blocks.length === 0),
      option('selection', `Selected objects in the current drawing (${init.selectionCount})`, selBody, init.selectionCount === 0),
    );
    right.className = 'sb-col sb-col-wide';
    radios[0]!.input.checked = true;
    for (const r of radios) r.input.addEventListener('change', syncSource);
    syncSource();

    const cols = document.createElement('div');
    cols.className = 'sb-cols';
    cols.append(left, right);
    m.body.appendChild(cols);
    m.body.appendChild(hintEl('The symbol opens in its own tab: geometry on layer 0 (inches, origin = insertion point), attribute placeholders on SYMATTR, explicit pins on SYMPIN. All drafting commands work there; the Symbol Builder palette saves it to the user library. Enter = OK.'));

    const ok = button('OK', true);
    const cancel = button('Cancel');
    ok.addEventListener('click', () => {
      const n = normalizeSymbolName(name.value.trim());
      if (!n || !validBlockName(n)) {
        nameHint.textContent = 'Enter a valid block name first.';
        name.focus();
        return;
      }
      if (findLibrarySymbol(n) && !userLibrary.has(n)) {
        nameHint.textContent = `${n} is a built-in library symbol; choose another name.`;
        name.focus();
        return;
      }
      const active = radios.find((r) => r.input.checked)?.kind ?? 'blank';
      if (active === 'library') {
        if (!libChoice) {
          libInfo.textContent = 'Pick a library symbol to copy first.';
          search.focus();
          return;
        }
        source = { kind: 'library', name: libChoice.name };
      } else if (active === 'block') {
        if (!blockSel.value) return;
        source = { kind: 'block', name: blockSel.value, basePoint: basePoint.value as BasePointChoice, scale: blockScaleInput.checked };
      } else if (active === 'selection') source = { kind: 'selection', scale: selScaleInput.checked };
      else source = { kind: 'blank' };
      const k = kind.value as SymbolKind;
      const withContact = k === 'child' || (k === 'standalone' && /_N[OC]$/.test(n));
      const meta: SymbolMeta = {
        name: k === 'child' && !/_N[OC]$/.test(n) ? `${n}_${contact.value}` : n,
        description: desc.value.trim(),
        standard: standard.value as SymbolStandard,
        category: category.value.trim() || DEFAULT_USER_CATEGORY,
        family: family.value.trim().toUpperCase() || 'DEV',
        kind: k,
        ...(withContact ? { contact: contact.value as 'NO' | 'NC' } : {}),
        orientation: orientation.value as SymbolOrientation,
        attrDefaults: {},
      };
      finish({ meta, source });
    });
    cancel.addEventListener('click', () => finish(null));
    m.footer.append(ok, cancel);
    m.root.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.target as HTMLElement).tagName !== 'BUTTON' && ev.target !== search) ok.click();
    });
    setTimeout(() => name.focus(), 0);
  });
}

// ---------------------------------------------------------------- user symbol chooser (icon menu > Edit...)

export function chooseUserSymbolDialog(editor: Editor, title = 'Edit User Symbol'): Promise<string | null> {
  return new Promise((resolve) => {
    const m = modal(title, 580, 'light');
    let done = false;
    let offChange: (() => void) | null = null;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      offChange?.();
      m.close();
      resolve(v);
    };
    m.onClose(() => finish(null));
    const filter = textInput('', 'Filter by name, description, category or family');
    filter.setAttribute('aria-label', 'Filter user symbols');
    const list = document.createElement('div');
    list.className = 'sb-list sb-list-tall';
    let current: string | null = null;
    const ok = button('Edit', true);
    ok.disabled = true;
    const ren = button('Rename...');
    ren.className += ' left';
    ren.disabled = true;
    const del = button('Delete from Library');
    del.className += ' left';
    del.disabled = true;
    const setCurrent = (n: string | null) => {
      current = n;
      ok.disabled = ren.disabled = del.disabled = !n;
    };
    const render = () => {
      list.innerHTML = '';
      const q = filter.value.trim().toLowerCase();
      const all = userLibrary.all().filter((s) => !q || `${s.block.name} ${s.block.description ?? ''} ${s.category} ${s.family}`.toLowerCase().includes(q));
      if (userLibrary.size === 0) list.appendChild(hintEl('The user library is empty. Use New Symbol... to create one.', 'dlg-note'));
      else if (all.length === 0) list.appendChild(hintEl('No user symbols match the filter.', 'dlg-note'));
      if (current && !all.some((s) => s.block.name === current)) setCurrent(null);
      for (const s of all) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'sb-list-item sb-list-item-preview' + (current === s.block.name ? ' active' : '');
        const c = document.createElement('canvas');
        c.width = 76;
        c.height = 48;
        drawSymbolPreview(c, s.block, editor.doc.layers, editor.doc.lookupBlock, { tagOnly: true });
        const t = document.createElement('div');
        t.innerHTML = `<b>${esc(s.block.name)}</b><span>${esc(s.block.description ?? '')}</span><span class="dlg-note">${esc(s.standard)} - ${esc(s.category)} - family ${esc(s.family)}${s.wdtype && s.wdtype !== s.family ? ` - ${esc(s.wdtype)}` : ''}</span>`;
        item.append(c, t);
        item.addEventListener('click', () => {
          setCurrent(s.block.name);
          render();
        });
        item.addEventListener('dblclick', () => finish(s.block.name));
        list.appendChild(item);
      }
    };
    filter.addEventListener('input', render);
    render();
    m.body.append(filter, list);
    offChange = userLibrary.onChange(render);
    del.addEventListener('click', () => {
      if (!current) return;
      const n = current;
      void (editor.ui?.confirm('Delete symbol', `Remove ${n} from the user library? Drawings that use it keep their copy of the block.`) ?? Promise.resolve(true)).then((yes) => {
        if (!yes) return;
        userLibrary.remove(n);
        editor.log(`${n} removed from the user library.`);
        setCurrent(null);
        render();
      });
    });
    ren.addEventListener('click', () => {
      if (!current) return;
      const n = current;
      void (editor.ui?.textInput('Rename Symbol', `New block name for ${n}`, n) ?? Promise.resolve(null)).then((v) => {
        if (v === null) return;
        const target = normalizeSymbolName(v.trim());
        if (!target || target === n) return;
        if (!validBlockName(target) || isBuiltinSymbol(target)) return editor.log(`${target} is not a valid new name (invalid characters or a built-in symbol).`);
        if (userLibrary.has(target)) return editor.log(`${target} already exists in the user library.`);
        if (userLibrary.rename(n, target)) {
          editor.log(`${n} renamed to ${target} (drawings that use it keep the old block name).`);
          setCurrent(target);
          render();
        }
      });
    });
    const exp = button('Export JSON...');
    exp.className += ' left';
    exp.addEventListener('click', () => editor.runCommand(current ? `AESYMLIBEXPORT ${current}` : 'AESYMLIBEXPORT'));
    const imp = button('Import...');
    imp.className += ' left';
    imp.addEventListener('click', () => editor.runCommand('AESYMLIBIMPORT'));
    const cancel = button('Cancel');
    ok.addEventListener('click', () => finish(current));
    cancel.addEventListener('click', () => finish(null));
    m.footer.append(ren, del, exp, imp, ok, cancel);
    setTimeout(() => filter.focus(), 0);
  });
}

// ---------------------------------------------------------------- small dialogs

/** Rename / Save as copy / Cancel when an existing symbol is saved under a new name. */
export function renameChoiceDialog(oldName: string, newName: string): Promise<RenameChoice> {
  return new Promise((resolve) => {
    const m = modal('Save Symbol', 460, 'light');
    let done = false;
    const finish = (v: RenameChoice) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    m.onClose(() => finish('cancel'));
    m.body.appendChild(hintEl(`You are editing ${oldName} and the name is now ${newName}.`, 'dlg-note'));
    m.body.appendChild(hintEl(`Rename replaces ${oldName} in the library (drawings that use it keep their copy under the old name). Save as copy keeps both symbols.`));
    const rename = button(`Rename to ${newName}`, true);
    const copy = button('Save as copy');
    const cancel = button('Cancel');
    rename.addEventListener('click', () => finish('rename'));
    copy.addEventListener('click', () => finish('copy'));
    cancel.addEventListener('click', () => finish('cancel'));
    m.footer.append(rename, copy, cancel);
  });
}

/** Check errors after a failed save (used from the tab-close prompt, where the palette may be hidden). */
export function checkErrorsDialog(title: string, messages: readonly CheckMessage[]): Promise<void> {
  return new Promise((resolve) => {
    const m = modal(title, 520, 'light');
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      m.close();
      resolve();
    };
    m.onClose(finish);
    m.body.appendChild(hintEl('The symbol was not saved. Fix these in the Symbol Builder palette (Check lists them), then save again:', 'dlg-note'));
    const box = document.createElement('div');
    box.className = 'sb-messages sb-messages-light';
    for (const msg of messages) {
      const d = document.createElement('div');
      d.className = `sb-msg ${msg.level}`;
      d.textContent = msg.text;
      box.appendChild(d);
    }
    m.body.appendChild(box);
    const ok = button('OK', true);
    ok.addEventListener('click', finish);
    m.footer.append(ok);
    m.root.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') ok.click();
    });
  });
}

// ---------------------------------------------------------------- palette

type SectionKey = keyof UserSettings['symbolBuilderCollapsed'];

export class SymbolBuilderPalette {
  readonly el: HTMLElement;
  private bodyEl: HTMLElement;
  private checkEl: HTMLElement;
  private actionsEl: HTMLElement;
  private ctl: SymbolBuilder | null = null;
  /** Whether the full check list is expanded (after Check / a failed save). */
  private checkExpanded = false;
  private flashCheck = false;
  private renderQueued = 0;
  private inputCounter = 0;

  constructor(
    private editor: Editor,
    container: HTMLElement,
  ) {
    this.el = container;
    this.el.className = 'palette properties symbol-builder hidden';
    const strip = document.createElement('div');
    strip.className = 'palette-strip';
    strip.innerHTML = `<span class="palette-strip-btns">${icon('close')}${icon('pin')}</span><span class="palette-strip-title">Symbol Builder</span>`;
    const svgs = strip.querySelectorAll('svg');
    svgs[0]?.setAttribute('aria-label', 'Close the Symbol Builder palette');
    svgs[0]?.setAttribute('role', 'button');
    svgs[1]?.setAttribute('aria-label', 'Auto-hide');
    svgs[0]?.addEventListener('click', () => this.el.classList.add('hidden'));
    const body = document.createElement('div');
    body.className = 'palette-body';
    const bar = document.createElement('div');
    bar.className = 'palette-titlebar';
    bar.innerHTML = `<span class="palette-title">Symbol Builder</span>`;
    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'props-body sb-body';
    this.checkEl = document.createElement('div');
    this.checkEl.className = 'sb-check';
    this.checkEl.setAttribute('role', 'status');
    this.actionsEl = document.createElement('div');
    this.actionsEl.className = 'sb-actions';
    body.append(bar, this.bodyEl, this.checkEl, this.actionsEl);
    this.el.append(body, strip);
  }

  show(ctl: SymbolBuilder): void {
    this.ctl = ctl;
    this.el.classList.remove('hidden');
    this.scheduleRender();
  }
  hide(): void {
    this.el.classList.add('hidden');
    this.ctl = null;
    this.checkExpanded = false;
    if (this.renderQueued) {
      cancelAnimationFrame(this.renderQueued);
      this.renderQueued = 0;
    }
  }

  /** All updates go through one animation frame: several change / file events (a tab switch fires a handful) rebuild the DOM once. */
  scheduleRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = requestAnimationFrame(() => {
      this.renderQueued = 0;
      this.render();
    });
  }

  /** Expand the check list and make it visible (failed save). */
  revealCheck(): void {
    this.checkExpanded = true;
    this.flashCheck = true;
    this.scheduleRender();
  }

  // ---- DOM helpers
  private setHover(id: string | null): void {
    const ov = (this.editor as unknown as { overlay?: { hover: string | null } }).overlay;
    if (!ov) return;
    if (ov.hover === id) return;
    ov.hover = id;
    this.editor.render();
  }
  private hoverRow(row: HTMLElement, id: string): void {
    row.addEventListener('mouseenter', () => this.setHover(id));
    row.addEventListener('mouseleave', () => this.setHover(null));
    row.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).closest('button, input, select')) return;
      this.editor.selection = new Set([id]);
      this.editor.notify('selection');
      this.editor.render();
    });
  }
  private row(label: string, value: string | HTMLElement, title?: string): HTMLElement {
    const r = document.createElement('div');
    r.className = 'prop-row';
    const l = document.createElement('label');
    l.className = 'prop-label';
    l.textContent = label;
    if (title) l.title = title;
    r.appendChild(l);
    if (typeof value === 'string') {
      const v = document.createElement('span');
      v.className = 'prop-value';
      v.textContent = value;
      r.appendChild(v);
    } else {
      const control = value.matches('input, select') ? value : value.querySelector('input, select');
      if (control) {
        if (!control.id) control.id = `sb-in-${(this.inputCounter += 1)}`;
        l.htmlFor = control.id;
      }
      r.appendChild(value);
    }
    return r;
  }
  private section(key: SectionKey, title: string, badge?: string): { header: HTMLElement; body: HTMLElement } {
    const collapsed = this.editor.settings.symbolBuilderCollapsed[key];
    const h = document.createElement('button');
    h.type = 'button';
    h.className = 'prop-section sb-section' + (collapsed ? ' collapsed' : '');
    h.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    h.innerHTML = `<span class="sb-section-arrow">${icon('chevron')}</span><span class="sb-section-title">${esc(title)}</span>${badge ? `<span class="sb-section-badge">${esc(badge)}</span>` : ''}`;
    const body = document.createElement('div');
    body.className = 'sb-section-body';
    if (collapsed) body.hidden = true;
    h.addEventListener('click', () => {
      const next = !this.editor.settings.symbolBuilderCollapsed[key];
      updateSettings(this.editor, { symbolBuilderCollapsed: { ...this.editor.settings.symbolBuilderCollapsed, [key]: next } });
      this.scheduleRender();
    });
    return { header: h, body };
  }
  private input(value: string, onCommit: (v: string) => void, opts: { upper?: boolean; list?: readonly string[]; placeholder?: string; label?: string; name?: boolean } = {}): HTMLElement {
    const i = document.createElement('input');
    i.className = 'prop-input';
    i.value = value;
    i.spellcheck = false;
    if (opts.placeholder) i.placeholder = opts.placeholder;
    if (opts.label) i.setAttribute('aria-label', opts.label);
    const commit = () => {
      const v = opts.name ? normalizeSymbolName(i.value.trim()) : opts.upper ? i.value.trim().toUpperCase() : i.value;
      if (v !== value) onCommit(v);
    };
    if (opts.name) {
      i.addEventListener('input', () => {
        const pos = i.selectionStart;
        i.value = normalizeSymbolName(i.value);
        if (pos !== null) i.setSelectionRange(pos, pos);
      });
    }
    i.addEventListener('change', commit);
    i.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        commit();
        i.blur();
      }
      ev.stopPropagation();
    });
    return opts.list ? withDatalist(i, opts.list) : i;
  }
  private select(options: Array<[string, string]>, value: string, onCommit: (v: string) => void, label?: string): HTMLSelectElement {
    const sel = document.createElement('select');
    sel.className = 'prop-input';
    if (label) sel.setAttribute('aria-label', label);
    for (const [v, text] of options) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = text;
      if (v === value) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => onCommit(sel.value));
    return sel;
  }
  private smallButton(label: string, title: string, onClick: () => void, cls = ''): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `sb-btn ${cls}`.trim();
    b.textContent = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', onClick);
    return b;
  }
  private removeButton(title: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sb-btn sb-btn-x';
    b.innerHTML = icon('close');
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', onClick);
    return b;
  }
  private note(text: string): HTMLElement {
    const n = document.createElement('div');
    n.className = 'sb-note';
    n.textContent = text;
    return n;
  }

  render(): void {
    if (this.el.classList.contains('hidden')) return;
    const ctl = this.ctl;
    const b = this.bodyEl;
    const scrollTop = b.scrollTop;
    b.innerHTML = '';
    this.actionsEl.innerHTML = '';
    this.checkEl.innerHTML = '';
    const s = ctl?.active();
    const meta = ctl?.meta ?? null;
    if (!ctl || !s || !meta) {
      const n = document.createElement('div');
      n.className = 'prop-header';
      n.textContent = 'No symbol tab is active';
      b.appendChild(n);
      return;
    }
    const doc = this.editor.doc;
    const msgs = ctl.check();
    const summary = summarizeCheck(msgs);
    const vertical = meta.orientation === 'V';

    const header = document.createElement('div');
    header.className = 'prop-header';
    header.textContent = `${meta.name}${doc.dirty ? '*' : ''}${s.editing ? '  (user library)' : '  (new)'}`;
    b.appendChild(header);
    b.appendChild(this.note(`Layer 0 = geometry, SYMATTR (yellow) = attribute placeholders, SYMPIN (red) = explicit pins. ${vertical ? 'Vertical: stubs end at y = ±0.375 on x = 0.' : 'Inline: stubs end at x = ±0.375 on y = 0.'} Ctrl+Z also undoes the fields below.`));

    // ---- symbol meta
    {
      const sec = this.section('symbol', 'Symbol', `${meta.family || '?'} / ${SYMBOL_KIND_SHORT.find(([k]) => k === meta.kind)?.[1] ?? meta.kind}`);
      b.appendChild(sec.header);
      const body = sec.body;
      body.appendChild(this.row('Name', this.input(meta.name, (v) => ctl.updateMeta({ name: v }), { name: true }), 'Block name (upper case, spaces become _)'));
      body.appendChild(this.row('Description', this.input(meta.description, (v) => ctl.updateMeta({ description: v }))));
      body.appendChild(
        this.row(
          'Standard',
          this.select(
            [
              ['JIC', 'JIC'],
              ['IEC', 'IEC'],
            ],
            meta.standard,
            (v) => ctl.updateMeta({ standard: v as SymbolStandard }),
          ),
        ),
      );
      body.appendChild(this.row('Category', this.input(meta.category, (v) => ctl.updateMeta({ category: v }), { list: libraryCategoryNames(meta.standard) }), 'Icon-menu category (User: <category>)'));
      body.appendChild(this.row('Family', this.input(meta.family, (v) => ctl.updateMeta({ family: v }), { upper: true, list: knownFamilies() }), 'Tag prefix (PB, CR, LS ...); tags become PB1, PB2 ... and the family picks the default pin numbers'));
      const kindSel = this.select(SYMBOL_KIND_SHORT, meta.kind, (v) => ctl.updateMeta({ kind: v as SymbolKind }));
      kindSel.title = kindHint(meta.kind);
      body.appendChild(this.row('Role', kindSel, kindHint(meta.kind)));
      body.appendChild(this.note(kindHint(meta.kind)));
      if (meta.kind === 'child' || meta.kind === 'standalone') {
        const contactSel = this.select(
          [
            ['', meta.kind === 'child' ? 'Normally open' : '(no NO / NC variant)'],
            ['NO', 'Normally open (_NO)'],
            ['NC', 'Normally closed (_NC)'],
          ].filter(([v]) => meta.kind !== 'child' || v !== '') as Array<[string, string]>,
          meta.contact ?? '',
          (v) => ctl.updateMeta({ contact: (v || undefined) as 'NO' | 'NC' | undefined }),
        );
        const wrap = document.createElement('div');
        wrap.className = 'sb-inline';
        wrap.append(contactSel, this.smallButton(`${meta.contact === 'NC' ? 'NO' : 'NC'} twin`, `Create the ${meta.contact === 'NC' ? 'normally open' : 'normally closed'} twin of this symbol in a new tab (name with _${meta.contact === 'NC' ? 'NO' : 'NC'}, default pins swapped, blade added / removed for a standard contact)`, () => ctl.createTwin()));
        body.appendChild(this.row('Contact', wrap, 'NO / NC pairs share a name stem so Toggle NO/NC (AETOGGLENC) and AESWAP can flip between them'));
      }
      const orientSel = this.select(
        ORIENTATIONS.map(([k, v]): [string, string] => [k, v.replace(/\s*\(.*\)$/, '')]),
        meta.orientation,
        (v) => ctl.updateMeta({ orientation: v as SymbolOrientation }),
      );
      const owrap = document.createElement('div');
      owrap.className = 'sb-inline';
      owrap.append(orientSel);
      if (!vertical) owrap.appendChild(this.smallButton('Make vertical', 'Open the vertical variant in a new tab: geometry rotated, left / right pins become top / bottom, TAG1 and DESC1 move to the right of the stub', () => ctl.makeVerticalVariant()));
      body.appendChild(this.row('Orientation', owrap, 'Horizontal: inline on a rung (stubs at x = +-0.375). Vertical: on a vertical wire (stubs at y = +-0.375).'));
      b.appendChild(body);
    }

    // ---- preview (what the state holds: geometry, placeholders, pin points)
    const pins = ctl.pins();
    {
      const sec = this.section('preview', 'Preview', `${pins.length} pin${pins.length === 1 ? '' : 's'}`);
      b.appendChild(sec.header);
      const pv = document.createElement('canvas');
      pv.width = 240;
      pv.height = 72;
      pv.className = 'sb-preview sb-preview-palette';
      pv.setAttribute('aria-label', 'Symbol preview');
      if (!sec.body.hidden) drawSymbolStatePreview(pv, doc.snapshot, pins.map((p) => p.point), doc.layers, doc.lookupBlock);
      const pvWrap = document.createElement('div');
      pvWrap.className = 'sb-preview-wrap';
      pvWrap.appendChild(pv);
      sec.body.appendChild(pvWrap);
      b.appendChild(sec.body);
    }

    // ---- attributes
    const placed = ctl.placeholders();
    {
      const sec = this.section('attributes', 'Attributes', String(placed.length));
      b.appendChild(sec.header);
      const placedTags = new Set(placed.map((t) => t.text.trim().toUpperCase()));
      const attrTable = document.createElement('div');
      attrTable.className = 'sb-table';
      const head = document.createElement('div');
      head.className = 'sb-thead';
      head.innerHTML = '<b>Tag</b><span class="sb-pos">Position</span><span class="sb-default">Default</span><span class="sb-th-actions"></span>';
      attrTable.appendChild(head);
      for (const t of placed) {
        const tag = t.text.trim().toUpperCase();
        const r = document.createElement('div');
        r.className = 'sb-trow';
        r.innerHTML = `<b>${esc(tag)}</b><span class="sb-pos" title="${esc(attributePrompt(tag, meta.kind))}; height ${t.height}, ${esc(t.align)}${t.rotation ? `, rotated ${Math.round((t.rotation * 180) / Math.PI)}°` : ''}">${t.position.x.toFixed(3)}, ${t.position.y.toFixed(3)}</span>`;
        const def = this.input(meta.attrDefaults[tag] ?? '', (v) => ctl.setAttrDefault(tag, v), { placeholder: tag === 'TAG1' ? (meta.kind === 'plc' ? 'I:0.0' : 'PB?') : 'default', label: `Default value of ${tag}` });
        def.classList.add('sb-default');
        def.title = `Default value of ${tag} (what a new insert shows before it is edited)`;
        r.append(def, this.smallButton('Move', `Pick a new position for ${tag}`, () => ctl.placeAttribute(tag)), this.removeButton(`Remove ${tag}`, () => ctl.removeEntity(t.id)));
        this.hoverRow(r, t.id);
        attrTable.appendChild(r);
      }
      if (placed.length === 0) attrTable.appendChild(this.note(meta.kind === 'terminal' ? 'No attributes yet: add TERM01.' : 'No attributes yet: add TAG1 and DESC1.'));
      const addRow = document.createElement('div');
      addRow.className = 'sb-addrow';
      const remaining = PLACEABLE_ATTRIBUTES.filter((t) => !placedTags.has(t));
      const addSel = this.select(remaining.length ? remaining.map((t): [string, string] => [t, t]) : [['', '(all placed)']], remaining[0] ?? '', () => {}, 'Attribute to add');
      addRow.append(
        addSel,
        this.smallButton('Place', 'Pick the position of the attribute text (snaps to the 1/16 in grid)', () => addSel.value && ctl.placeAttribute(addSel.value)),
        this.smallButton('Add', `Add at its default position for a ${vertical ? 'vertical' : 'horizontal'} symbol`, () => addSel.value && ctl.addAttribute(addSel.value)),
      );
      attrTable.appendChild(addRow);
      const convRow = document.createElement('div');
      convRow.className = 'sb-addrow';
      const selectedTexts = this.editor.entitiesSelected().filter((e) => e.type === 'text' && !isPlaceholder(e) && !isPinMarker(e)).length;
      const conv = this.smallButton('Convert selected text to attribute', 'Turn selected plain text (e.g. a vendor block’s "TAG1") into an attribute placeholder on layer SYMATTR', () => ctl.convertSelectedText());
      conv.disabled = selectedTexts === 0;
      if (selectedTexts) conv.textContent = `Convert ${selectedTexts} selected text${selectedTexts === 1 ? '' : 's'} to attribute`;
      convRow.appendChild(conv);
      attrTable.appendChild(convRow);
      attrTable.appendChild(this.note(`Placeholder text = attribute tag; edit height / justification / rotation with the Properties palette (Ctrl+1). DESC2 / DESC3, INST, LOC, MFG, CAT, ASSYCODE, RATING1-2 and WDTYPE=${esc(meta.kind === 'standalone' ? meta.family || 'DEV' : meta.kind === 'parent' ? 'COIL' : meta.kind === 'child' ? 'CONTACT' : meta.kind.toUpperCase())}${meta.kind === 'terminal' ? ', TAGSTRIP' : ''} are added as invisible attributes unless you place them.`));
      sec.body.appendChild(attrTable);
      b.appendChild(sec.body);
    }

    // ---- invisible data defaults
    {
      const extraKeys = Object.keys(meta.attrDefaults).filter((k) => !(DEFAULT_EDITABLE_ATTRIBUTES as readonly string[]).includes(k) && !placed.some((t) => t.text.trim().toUpperCase() === k));
      const filled = [...DEFAULT_EDITABLE_ATTRIBUTES, ...extraKeys].filter((k) => (meta.attrDefaults[k] ?? '') !== '').length;
      const sec = this.section('defaults', 'Data defaults', filled ? `${filled} set` : undefined);
      b.appendChild(sec.header);
      const table = document.createElement('div');
      table.className = 'sb-table';
      for (const tag of [...DEFAULT_EDITABLE_ATTRIBUTES, ...extraKeys]) {
        const r = document.createElement('div');
        r.className = 'sb-trow';
        r.innerHTML = `<b>${esc(tag)}</b><span class="sb-pos">${esc(attributePrompt(tag, meta.kind))}</span>`;
        const def = this.input(meta.attrDefaults[tag] ?? '', (v) => ctl.setAttrDefault(tag, v), { placeholder: 'default', label: `Default value of ${tag}` });
        def.classList.add('sb-default');
        r.appendChild(def);
        if (extraKeys.includes(tag)) r.appendChild(this.removeButton(`Remove the ${tag} attribute`, () => ctl.setAttrDefault(tag, '')));
        table.appendChild(r);
      }
      const addRow = document.createElement('div');
      addRow.className = 'sb-addrow';
      const newTag = document.createElement('input');
      newTag.className = 'prop-input';
      newTag.placeholder = 'vendor attribute tag';
      newTag.setAttribute('aria-label', 'New invisible attribute tag');
      newTag.addEventListener('keydown', (ev) => ev.stopPropagation());
      const newVal = document.createElement('input');
      newVal.className = 'prop-input';
      newVal.placeholder = 'value';
      newVal.setAttribute('aria-label', 'New invisible attribute value');
      newVal.addEventListener('keydown', (ev) => ev.stopPropagation());
      addRow.append(
        newTag,
        newVal,
        this.smallButton('Add', 'Add an invisible attribute with this default (vendor data such as a part family or a plate code)', () => {
          const t = normalizeSymbolName(newTag.value.trim());
          if (!t) return;
          ctl.setAttrDefault(t, newVal.value);
        }),
      );
      table.appendChild(addRow);
      table.appendChild(this.note('Invisible attributes every insert carries (MFG / CAT drive the BOM; vendor blocks keep their own tags). Harvested defaults land here.'));
      sec.body.appendChild(table);
      b.appendChild(sec.body);
    }

    // ---- wire connections
    {
      const sec = this.section('pins', 'Wire connections', String(pins.length));
      b.appendChild(sec.header);
      const pinTable = document.createElement('div');
      pinTable.className = 'sb-table';
      const dirName = (d: PinDirection) => PIN_DIRECTIONS.find(([k]) => k === d)?.[1] ?? String(d);
      for (const p of pins) {
        const r = document.createElement('div');
        r.className = 'sb-trow';
        const warn = p.markerId && (!p.onEndpoint || p.textDir !== p.dir) ? ' sb-warn' : '';
        r.innerHTML = `<b class="${warn.trim()}">${esc(p.tag)}</b><span class="sb-pos" title="${esc(dirName(p.dir))} connection${p.markerId ? (p.onEndpoint ? ' (on a line end)' : ' (not on a line end)') : ' (detected from the geometry)'}">${esc(dirName(p.dir).charAt(0))} ${p.point.x.toFixed(3)}, ${p.point.y.toFixed(3)}</span>`;
        if (p.markerId) {
          const id = p.markerId;
          const pinInput = this.input(p.explicitDefault ?? '', (v) => ctl.setPinDefault(id, v), { placeholder: p.default, label: `Default pin number of ${p.tag}` }) as HTMLInputElement;
          pinInput.classList.add('sb-pin');
          pinInput.title = `Default pin number (blank = family default ${p.default})`;
          r.append(pinInput, this.removeButton(`Remove pin ${p.tag}`, () => ctl.removeEntity(id)));
          this.hoverRow(r, id);
        } else {
          const auto = document.createElement('span');
          auto.className = 'sb-auto';
          auto.textContent = `auto, pin ${p.default}`;
          auto.title = `Detected from a line ending at ${vertical ? 'y = +-0.375' : 'x = +-0.375'} (default pin number of the family); add an explicit pin here to choose another number`;
          r.appendChild(auto);
        }
        pinTable.appendChild(r);
      }
      if (pins.length === 0) pinTable.appendChild(this.note(vertical ? 'No connection yet: end a line at y = +0.375 / -0.375 on x = 0, or add an explicit pin.' : 'No connection yet: end a line at x = -0.375 / +0.375 on y = 0, or add an explicit pin.'));
      const pinAdd = document.createElement('div');
      pinAdd.className = 'sb-addrow';
      const dirSel = this.select(PIN_DIRECTIONS.map(([k, v]): [string, string] => [String(k), v]), vertical ? '2' : '1', () => {}, 'Direction of the new pin');
      const pinNo = document.createElement('input');
      pinNo.className = 'prop-input sb-pin';
      pinNo.placeholder = 'pin';
      pinNo.title = 'Default pin number for the new connection';
      pinNo.setAttribute('aria-label', 'Default pin number for the new connection');
      pinNo.addEventListener('keydown', (ev) => ev.stopPropagation());
      pinAdd.append(dirSel, pinNo, this.smallButton('Add pin', 'Pick the connection point (snaps to the 1/16 in grid); the direction follows the line end it sits on', () => ctl.addPin(parseInt(dirSel.value, 10) as PinDirection, pinNo.value.trim())));
      pinTable.appendChild(pinAdd);
      pinTable.appendChild(this.note('Pin labels (X1TERM01 ...) are renumbered from the geometry: left / right / top / bottom follow the line end a marker sits on, so MIRROR and ROTATE keep them right.'));
      sec.body.appendChild(pinTable);
      b.appendChild(sec.body);
    }

    // ---- check area (fixed above the buttons)
    {
      const c = this.checkEl;
      c.classList.toggle('has-errors', summary.errors > 0);
      c.classList.toggle('has-warnings', summary.errors === 0 && summary.warnings > 0);
      const line = document.createElement('button');
      line.type = 'button';
      line.className = 'sb-check-line';
      line.setAttribute('aria-expanded', this.checkExpanded ? 'true' : 'false');
      line.innerHTML = `<span class="sb-section-arrow${this.checkExpanded ? '' : ' collapsed'}">${icon('chevron')}</span><span>Check: ${esc(summary.text)}</span>`;
      line.title = this.checkExpanded ? 'Hide the check messages' : 'Show the check messages';
      line.addEventListener('click', () => {
        this.checkExpanded = !this.checkExpanded;
        this.scheduleRender();
      });
      c.appendChild(line);
      if (this.checkExpanded) {
        const box = document.createElement('div');
        box.className = 'sb-messages' + (this.flashCheck ? ' flash' : '');
        for (const m of msgs) {
          const d = document.createElement('div');
          d.className = `sb-msg ${m.level}`;
          d.textContent = m.text;
          box.appendChild(d);
        }
        c.appendChild(box);
        if (this.flashCheck) {
          this.flashCheck = false;
          setTimeout(() => box.classList.remove('flash'), 900);
        }
      }
    }

    // ---- actions (fixed footer)
    const actions = this.actionsEl;
    const act = (label: string, title: string, fn: () => void, primary = false) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn sb-action' + (primary ? ' primary' : '');
      btn.textContent = label;
      btn.title = title;
      btn.addEventListener('click', fn);
      return btn;
    };
    const checkBtn = act(summary.errors ? `Check: ${summary.errors} error${summary.errors === 1 ? '' : 's'}` : summary.warnings ? `Check: ${summary.warnings} warning${summary.warnings === 1 ? '' : 's'}` : 'Check', 'Validate the symbol (name, connections, attributes, size) and list the messages', () => {
      const list = ctl.check();
      for (const m of list) this.editor.log(`Symbol Builder check: ${m.level === 'ok' ? '' : `[${m.level}] `}${m.text}`);
      this.checkExpanded = true;
      this.scheduleRender();
    });
    if (summary.errors) checkBtn.classList.add('has-errors');
    const saveBtn = act('Save to Library', summary.errors ? `Cannot save: ${ctl.firstError() ?? 'fix the check errors'}` : 'Save the symbol to the user library (also Ctrl+S in this tab)', () => void ctl.save(), true);
    saveBtn.disabled = summary.errors > 0;
    const insertBtn = act('Save and Insert', summary.errors ? `Cannot save: ${ctl.firstError() ?? 'fix the check errors'}` : 'Save, close this tab and insert the symbol in the drawing it was started from', () => void ctl.saveAndInsert());
    insertBtn.disabled = summary.errors > 0;
    actions.append(checkBtn, saveBtn, insertBtn, act('Export DXF...', 'Write the symbol as a DXF block file (also Save As in this tab)', () => ctl.exportDxf()), act('Close', 'Close the symbol tab (asks to save when changed)', () => void ctl.closeActive()));
    b.scrollTop = scrollTop;
  }
}

/** Build the palette into `container` and return the hooks the controller calls. */
export function createSymbolBuilderUi(editor: Editor, container: HTMLElement): SymbolBuilderUi & { palette: SymbolBuilderPalette } {
  const palette = new SymbolBuilderPalette(editor, container);
  makePaletteResizable(palette.el, {
    edge: 'left',
    initial: editor.settings.paletteWidths.symbolBuilder,
    min: 240,
    onWidth: (w) => updateSettings(editor, { paletteWidths: { ...editor.settings.paletteWidths, symbolBuilder: Math.round(w) } }),
  });
  return {
    palette,
    start: (init) => symbolBuilderStartDialog(editor, init),
    showPalette: (ctl) => palette.show(ctl),
    hidePalette: () => palette.hide(),
    refreshPalette: () => palette.scheduleRender(),
    revealCheck: () => palette.revealCheck(),
    askRename: (oldName, newName) => renameChoiceDialog(oldName, newName),
    showErrors: (title, messages) => checkErrorsDialog(title, messages),
    openTextFile: (accept) => electricalUi(editor).openTextFile?.(accept) ?? Promise.resolve(null),
  };
}
