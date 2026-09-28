/**
 * Symbol Builder UI: the start dialog ("Symbol Builder"), the docked palette
 * shown while a symbol tab is active, and the user-symbol chooser used by the
 * icon menu's Edit... button. The logic lives in src/tools/symbol-builder.ts
 * (controller) and src/electrical/symbol-builder-core.ts (conversions).
 */
import type { Editor } from '../app/editor';
import type { BlockDef, Entity, TextEntity } from '../core/entities';
import { entityBounds } from '../core/entities';
import type { Bounds } from '../core/geometry';
import { unionBounds } from '../core/geometry';
import { drawEntity, type Transform } from '../render/draw';
import { LIBRARY_SYMBOLS, findLibrarySymbol, searchLibrary, libraryCategoryNames } from '../electrical/library';
import { tagPrefix } from '../electrical/symbols';
import { userLibrary, DEFAULT_USER_CATEGORY, type SymbolStandard } from '../electrical/userlib';
import { SYMBOL_KINDS, SYMBOL_KIND_SHORT, PIN_DIRECTIONS, PLACEABLE_ATTRIBUTES, kindFromBlock, type SymbolMeta, type SymbolKind, type PinDirection, type BasePointChoice, type CheckMessage } from '../electrical/symbol-builder-core';
import { validBlockName } from '../tools/blocks';
import type { SymbolBuilder, SymbolBuilderUi, SymbolBuilderStart, StartDialogInit, SymbolSource } from '../tools/symbol-builder';
import { electricalUi } from '../app/commands-electrical';
import { modal, button } from './dialogkit';
import { makePaletteResizable } from './palettes';
import { updateSettings } from './options';
import { icon } from './icons';
import { esc } from './dom';

// ---------------------------------------------------------------- small DOM helpers (light dialog look)

function field(label: string, input: HTMLElement): HTMLElement {
  const row = document.createElement('label');
  row.className = 'field';
  const l = document.createElement('span');
  l.textContent = label;
  row.append(l, input);
  return row;
}
function textInput(value: string, placeholder = ''): HTMLInputElement {
  const i = document.createElement('input');
  i.className = 'input';
  i.value = value;
  i.placeholder = placeholder;
  i.spellcheck = false;
  i.addEventListener('keydown', (ev) => ev.stopPropagation());
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

/** Families the tag-prefix table knows (built-in symbols) plus the user symbols' families. */
export function knownFamilies(): string[] {
  const set = new Set<string>();
  for (const s of LIBRARY_SYMBOLS) set.add(tagPrefix(s.name));
  for (const s of userLibrary.all()) set.add(s.family);
  set.delete('DEV');
  return [...set].sort();
}

/**
 * Draw a block preview: geometry in `color`, visible attribute tags in `attrColor`,
 * scaled to fit (like render/draw's drawPreview, but two colours).
 */
export function drawSymbolPreview(canvas: HTMLCanvasElement, block: BlockDef, layers: Editor['doc']['layers'], lookup: Editor['doc']['lookupBlock'], color = '#e6e6e6', attrColor = '#e2c55a', background = '#202020'): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, w, h);
  const attrs: TextEntity[] = block.attributes
    .filter((a) => !a.invisible)
    .map((a) => ({ id: `pv-${a.tag}`, layer: '0', color: 'ByLayer', type: 'text', position: a.position, text: a.tag, height: a.height, rotation: 0, align: a.align }));
  const all: Entity[] = [...block.entities, ...attrs];
  let b: Bounds | null = null;
  for (const e of all) b = unionBounds(b, entityBounds(e, lookup));
  if (!b) return;
  const pad = 10;
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
  for (const e of block.entities) drawEntity(ctx, e, tf, layers, lookup, { strokeOverride: color, lineWidthOverride: 1 });
  for (const e of attrs) drawEntity(ctx, e, tf, layers, lookup, { strokeOverride: attrColor, lineWidthOverride: 1 });
}

// ---------------------------------------------------------------- start dialog

export function symbolBuilderStartDialog(editor: Editor, init: StartDialogInit): Promise<SymbolBuilderStart | null> {
  return new Promise((resolve) => {
    const m = modal('Symbol Builder', 820, 'light');
    m.root.classList.add('sb-dialog-root');
    let done = false;
    const finish = (v: SymbolBuilderStart | null) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    m.onClose(() => finish(null));

    // ---- left: symbol properties
    const name = textInput(init.meta.name, 'e.g. USER_PB1');
    name.addEventListener('input', () => (name.value = name.value.toUpperCase()));
    const desc = textInput(init.meta.description, 'shown in the icon menu');
    const standard = select(
      [
        ['JIC', 'JIC (NFPA 79 ladder)'],
        ['IEC', 'IEC 60617'],
      ],
      init.meta.standard,
    );
    const category = textInput(init.meta.category || DEFAULT_USER_CATEGORY);
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
    const family = textInput(init.meta.family, 'PB, CR, LS ...');
    family.addEventListener('input', () => (family.value = family.value.toUpperCase()));
    const familyWrap = withDatalist(family, knownFamilies());
    const kind = select(SYMBOL_KINDS, init.meta.kind);
    const contact = select(
      [
        ['NO', 'Normally open (_NO, pins 13/14)'],
        ['NC', 'Normally closed (_NC, pins 11/12)'],
      ],
      init.meta.contact ?? 'NO',
    );
    const contactRow = field('Contact', contact);
    const syncKind = () => {
      contactRow.style.display = kind.value === 'child' ? '' : 'none';
      if (kind.value === 'child') {
        const base = name.value.replace(/_N[OC]$/, '');
        if (base) name.value = `${base}_${contact.value}`;
      }
    };
    kind.addEventListener('change', syncKind);
    contact.addEventListener('change', syncKind);
    // A new family suggests a matching name while the user has not typed their own.
    let nameTouched = !/^USER_/.test(init.meta.name);
    name.addEventListener('input', () => (nameTouched = true));
    family.addEventListener('change', () => {
      if (!nameTouched) name.value = init.suggestName(family.value) + (kind.value === 'child' ? `_${contact.value}` : '');
    });
    const nameHint = document.createElement('div');
    nameHint.className = 'hint';
    const validateName = () => {
      const n = name.value.trim().toUpperCase();
      if (!n) nameHint.textContent = 'Block name of the symbol (upper case).';
      else if (!validBlockName(n)) nameHint.textContent = 'Invalid block name: no <>/\\":;?*|,=` characters.';
      else if (findLibrarySymbol(n) && !userLibrary.has(n)) nameHint.textContent = `${n} is a built-in library symbol; choose another name.`;
      else if (userLibrary.has(n)) nameHint.textContent = `${n} exists in the user library: saving will replace it.`;
      else nameHint.textContent = 'Block name of the symbol (upper case).';
    };
    name.addEventListener('input', validateName);
    validateName();
    const left = fieldset('Symbol', field('Name', name), nameHint, field('Description', desc), field('Standard', standard), field('Category', categoryWrap), field('Family / tag prefix', familyWrap), field('Type', kind), contactRow);
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
    const syncSource = () => {
      const active = radios.find((r) => r.input.checked)?.kind ?? 'blank';
      for (const r of radios) r.body.classList.toggle('active', r.kind === active);
    };

    // blank
    const blankBody = document.createElement('div');
    blankBody.className = 'hint';
    blankBody.textContent = 'Empty symbol with the 0.75 in inline guides; draw with LINE / CIRCLE / ARC / PLINE around the origin.';

    // library copy
    const libBody = document.createElement('div');
    const search = textInput('', 'Search both standards by name or description (e.g. push button, HPB11_NO)');
    const libList = document.createElement('div');
    libList.className = 'sb-list';
    const libPreview = document.createElement('canvas');
    libPreview.width = 200;
    libPreview.height = 110;
    libPreview.className = 'sb-preview';
    const libInfo = document.createElement('div');
    libInfo.className = 'hint';
    libInfo.textContent = 'Type to search, then pick a symbol.';
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
      if (kind.value === 'child') contact.value = /_NC$/.test(def.name) ? 'NC' : 'NO';
      standard.value = def.name.startsWith('IEC_') ? 'IEC' : 'JIC';
      refreshCategories();
      if (!nameTouched) name.value = init.suggestName(fam) + (kind.value === 'child' ? `_${contact.value}` : '');
      syncKind();
      validateName();
      libList.querySelectorAll('.sb-list-item').forEach((el) => el.classList.toggle('active', (el as HTMLElement).dataset.name === def.name));
    };
    const renderLib = () => {
      libList.innerHTML = '';
      const q = search.value.trim();
      const results = q ? [...searchLibrary('JIC', q), ...searchLibrary('IEC', q).filter((s) => !searchLibrary('JIC', q).includes(s))].slice(0, 60) : [];
      if (!q) {
        const n = document.createElement('div');
        n.className = 'dlg-note';
        n.textContent = 'Enter part of a name or description.';
        libList.appendChild(n);
      } else if (results.length === 0) {
        const n = document.createElement('div');
        n.className = 'dlg-note';
        n.textContent = 'No symbols match.';
        libList.appendChild(n);
      }
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
    const blockSel = select(init.blocks.length ? init.blocks.map((b): [string, string] => [b.name, `${b.name}${b.description ? ` - ${b.description}` : ''}`]) : [['', '(no harvestable blocks in this drawing)']], init.blocks[0]?.name ?? '');
    const blockPreview = document.createElement('canvas');
    blockPreview.width = 200;
    blockPreview.height = 110;
    blockPreview.className = 'sb-preview';
    const basePoint = select(
      [
        ['insert', 'Block insertion point'],
        ['center', 'Centre of the geometry'],
        ['left', 'Middle of the left edge'],
        ['bottom', 'Bottom centre'],
        ['top', 'Top centre'],
      ],
      'insert',
    );
    const blockScale = document.createElement('label');
    blockScale.className = 'radio-row';
    const blockScaleInput = document.createElement('input');
    blockScaleInput.type = 'checkbox';
    blockScaleInput.checked = true;
    blockScale.append(blockScaleInput, document.createTextNode(' Scale the geometry to 0.75 in wide (inline symbol)'));
    const blockInfo = document.createElement('div');
    blockInfo.className = 'hint';
    const renderBlock = () => {
      const def = editor.doc.blocks[blockSel.value];
      const ctx = blockPreview.getContext('2d');
      if (!def) {
        if (ctx) {
          ctx.fillStyle = '#202020';
          ctx.fillRect(0, 0, blockPreview.width, blockPreview.height);
        }
        blockInfo.textContent = 'Blocks of the current drawing that are not library symbols (e.g. from a manufacturer DWG) can be harvested; nested blocks are exploded.';
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
      if (!nameTouched) {
        const candidate = def.name.toUpperCase();
        name.value = validBlockName(candidate) && !findLibrarySymbol(candidate) ? candidate : init.suggestName(family.value);
      }
      if (!desc.value.trim() || desc.dataset.auto === '1') {
        desc.value = def.description ?? '';
        desc.dataset.auto = '1';
      }
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
    blockLeft.append(field('Block', blockSel), field('Base point (symbol origin)', basePoint), blockScale);
    const blockPreviewBox = document.createElement('div');
    blockPreviewBox.className = 'sb-preview-box';
    blockPreviewBox.append(blockPreview, blockInfo);
    blockRow.append(blockLeft, blockPreviewBox);
    blockBody.append(blockRow);
    renderBlock();

    // selection
    const selBody = document.createElement('div');
    const selInfo = document.createElement('div');
    selInfo.className = 'hint';
    selInfo.textContent = init.selectionCount ? `${init.selectionCount} object(s) selected. After OK, pick the base point (wire-connection centre) in the drawing.` : 'Select the objects in the drawing first, then start the Symbol Builder.';
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
    const note = document.createElement('div');
    note.className = 'hint';
    note.textContent = 'The symbol opens in its own tab: geometry on layer 0 (inches, origin = insertion point), attribute placeholders on SYMATTR, explicit pins on SYMPIN. All drafting commands work there; the Symbol Builder palette saves it to the user library.';
    m.body.appendChild(note);

    const ok = button('OK', true);
    const cancel = button('Cancel');
    ok.addEventListener('click', () => {
      const n = name.value.trim().toUpperCase();
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
      const meta: SymbolMeta = {
        name: k === 'child' && !/_N[OC]$/.test(n) ? `${n}_${contact.value}` : n,
        description: desc.value.trim(),
        standard: standard.value as SymbolStandard,
        category: category.value.trim() || DEFAULT_USER_CATEGORY,
        family: family.value.trim().toUpperCase() || 'DEV',
        kind: k,
        ...(k === 'child' ? { contact: contact.value as 'NO' | 'NC' } : {}),
        pinDefaults: {},
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
    const m = modal(title, 560, 'light');
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    m.onClose(() => finish(null));
    const list = document.createElement('div');
    list.className = 'sb-list sb-list-tall';
    let current: string | null = null;
    const ok = button('Edit', true);
    ok.disabled = true;
    const render = () => {
      list.innerHTML = '';
      const all = userLibrary.all();
      if (all.length === 0) {
        const n = document.createElement('div');
        n.className = 'dlg-note';
        n.textContent = 'The user library is empty. Use New Symbol... to create one.';
        list.appendChild(n);
      }
      for (const s of all) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'sb-list-item sb-list-item-preview' + (current === s.block.name ? ' active' : '');
        const c = document.createElement('canvas');
        c.width = 76;
        c.height = 48;
        drawSymbolPreview(c, s.block, editor.doc.layers, editor.doc.lookupBlock);
        const t = document.createElement('div');
        t.innerHTML = `<b>${esc(s.block.name)}</b><span>${esc(s.block.description ?? '')}</span><span class="dlg-note">${esc(s.standard)} - ${esc(s.category)} - family ${esc(s.family)}${s.wdtype && s.wdtype !== s.family ? ` - ${esc(s.wdtype)}` : ''}</span>`;
        item.append(c, t);
        item.addEventListener('click', () => {
          current = s.block.name;
          ok.disabled = false;
          render();
        });
        item.addEventListener('dblclick', () => finish(s.block.name));
        list.appendChild(item);
      }
    };
    render();
    m.body.appendChild(list);
    const del = button('Delete from Library');
    del.className += ' left';
    del.addEventListener('click', () => {
      if (!current) return;
      const n = current;
      void (editor.ui?.confirm('Delete symbol', `Remove ${n} from the user library? Drawings that use it keep their copy of the block.`) ?? Promise.resolve(true)).then((yes) => {
        if (!yes) return;
        userLibrary.remove(n);
        editor.log(`${n} removed from the user library.`);
        current = null;
        ok.disabled = true;
        render();
      });
    });
    const exp = button('Export JSON...');
    exp.className += ' left';
    exp.addEventListener('click', () => editor.runCommand(current ? `AESYMLIBEXPORT ${current}` : 'AESYMLIBEXPORT'));
    const imp = button('Import...');
    imp.className += ' left';
    imp.addEventListener('click', () => {
      editor.runCommand('AESYMLIBIMPORT');
      const off = userLibrary.onChange(() => {
        render();
        off();
      });
    });
    const cancel = button('Cancel');
    ok.addEventListener('click', () => finish(current));
    cancel.addEventListener('click', () => finish(null));
    m.footer.append(del, exp, imp, ok, cancel);
  });
}

// ---------------------------------------------------------------- palette

export class SymbolBuilderPalette {
  readonly el: HTMLElement;
  private bodyEl: HTMLElement;
  private actionsEl: HTMLElement;
  private ctl: SymbolBuilder | null = null;
  private checkResults: CheckMessage[] | null = null;
  private liveCheck = false;

  constructor(
    private editor: Editor,
    container: HTMLElement,
  ) {
    this.el = container;
    this.el.className = 'palette properties symbol-builder hidden';
    const strip = document.createElement('div');
    strip.className = 'palette-strip';
    strip.innerHTML = `<span class="palette-strip-btns">${icon('close')}${icon('pin')}</span><span class="palette-strip-title">Symbol Builder</span>`;
    strip.querySelector('svg')?.addEventListener('click', () => this.el.classList.add('hidden'));
    const body = document.createElement('div');
    body.className = 'palette-body';
    const bar = document.createElement('div');
    bar.className = 'palette-titlebar';
    bar.innerHTML = `<span class="palette-title">Symbol Builder</span>`;
    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'props-body sb-body';
    this.actionsEl = document.createElement('div');
    this.actionsEl.className = 'sb-actions';
    body.append(bar, this.bodyEl, this.actionsEl);
    this.el.append(body, strip);
  }

  show(ctl: SymbolBuilder): void {
    this.ctl = ctl;
    this.el.classList.remove('hidden');
    this.render();
  }
  hide(): void {
    this.el.classList.add('hidden');
    this.ctl = null;
    this.checkResults = null;
  }

  private row(label: string, value: string | HTMLElement, title?: string): HTMLElement {
    const r = document.createElement('div');
    r.className = 'prop-row';
    const l = document.createElement('span');
    l.className = 'prop-label';
    l.textContent = label;
    if (title) l.title = title;
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
  private input(value: string, onCommit: (v: string) => void, opts: { upper?: boolean; list?: readonly string[]; placeholder?: string } = {}): HTMLElement {
    const i = document.createElement('input');
    i.className = 'prop-input';
    i.value = value;
    i.spellcheck = false;
    if (opts.placeholder) i.placeholder = opts.placeholder;
    const commit = () => {
      const v = opts.upper ? i.value.trim().toUpperCase() : i.value;
      if (v !== value) onCommit(v);
    };
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
  private smallButton(label: string, title: string, onClick: () => void, cls = ''): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = `sb-btn ${cls}`.trim();
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  render(): void {
    if (this.el.classList.contains('hidden')) return;
    const ctl = this.ctl;
    const b = this.bodyEl;
    b.innerHTML = '';
    this.actionsEl.innerHTML = '';
    const s = ctl?.active();
    if (!ctl || !s) {
      const n = document.createElement('div');
      n.className = 'prop-header';
      n.textContent = 'No symbol tab is active';
      b.appendChild(n);
      return;
    }
    const meta = s.meta;
    const doc = this.editor.doc;
    const header = document.createElement('div');
    header.className = 'prop-header';
    header.textContent = `${meta.name}${doc.dirty ? '*' : ''}${s.editing ? '  (user library)' : '  (new)'}`;
    b.appendChild(header);

    // ---- symbol meta
    b.appendChild(this.section('Symbol'));
    b.appendChild(this.row('Name', this.input(meta.name, (v) => ctl.updateMeta({ name: v }), { upper: true })));
    b.appendChild(this.row('Description', this.input(meta.description, (v) => ctl.updateMeta({ description: v }))));
    b.appendChild(
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
    b.appendChild(this.row('Category', this.input(meta.category, (v) => ctl.updateMeta({ category: v }), { list: libraryCategoryNames(meta.standard) })));
    b.appendChild(this.row('Family', this.input(meta.family, (v) => ctl.updateMeta({ family: v }), { upper: true, list: knownFamilies() }), 'Tag prefix (PB, CR, LS ...)'));
    const kindSel = this.select(SYMBOL_KIND_SHORT, meta.kind, (v) => ctl.updateMeta({ kind: v as SymbolKind }));
    kindSel.title = SYMBOL_KINDS.find(([k]) => k === meta.kind)?.[1] ?? '';
    b.appendChild(this.row('Type', kindSel));
    if (meta.kind === 'child') {
      b.appendChild(
        this.row(
          'Contact',
          this.select(
            [
              ['NO', 'Normally open'],
              ['NC', 'Normally closed'],
            ],
            meta.contact ?? 'NO',
            (v) => ctl.updateMeta({ contact: v as 'NO' | 'NC' }),
          ),
        ),
      );
    }

    // ---- preview
    b.appendChild(this.section('Preview'));
    const block = ctl.compile();
    const pv = document.createElement('canvas');
    pv.width = 220;
    pv.height = 120;
    pv.className = 'sb-preview sb-preview-palette';
    if (block) drawSymbolPreview(pv, block, doc.layers, doc.lookupBlock);
    const pvWrap = document.createElement('div');
    pvWrap.className = 'sb-preview-wrap';
    pvWrap.appendChild(pv);
    b.appendChild(pvWrap);

    // ---- attributes
    b.appendChild(this.section('Attributes'));
    const placed = ctl.placeholders();
    const placedTags = new Set(placed.map((t) => t.text.trim().toUpperCase()));
    const attrTable = document.createElement('div');
    attrTable.className = 'sb-table';
    for (const t of placed) {
      const tag = t.text.trim().toUpperCase();
      const r = document.createElement('div');
      r.className = 'sb-trow';
      r.innerHTML = `<b>${esc(tag)}</b><span class="sb-pos" title="height ${t.height}, ${esc(t.align)}">${t.position.x.toFixed(3)}, ${t.position.y.toFixed(3)}</span>`;
      r.append(
        this.smallButton('Move', 'Pick a new position for this attribute', () => ctl.placeAttribute(tag)),
        this.smallButton('x', 'Remove this attribute', () => ctl.removeEntity(t.id), 'sb-btn-x'),
      );
      r.addEventListener('mouseenter', () => {
        this.editor.selection = new Set([t.id]);
        this.editor.notify('selection');
        this.editor.render();
      });
      attrTable.appendChild(r);
    }
    if (placed.length === 0) {
      const n = document.createElement('div');
      n.className = 'sb-note';
      n.textContent = meta.kind === 'terminal' ? 'No attributes yet: add TERM01.' : 'No attributes yet: add TAG1 and DESC1.';
      attrTable.appendChild(n);
    }
    const addRow = document.createElement('div');
    addRow.className = 'sb-addrow';
    const remaining = PLACEABLE_ATTRIBUTES.filter((t) => !placedTags.has(t));
    const addSel = this.select(remaining.length ? remaining.map((t): [string, string] => [t, t]) : [['', '(all placed)']], remaining[0] ?? '', () => {});
    addRow.append(
      addSel,
      this.smallButton('Place', 'Pick the position of the attribute text', () => addSel.value && ctl.placeAttribute(addSel.value)),
      this.smallButton('Add', 'Add at its default position', () => addSel.value && ctl.addAttribute(addSel.value)),
    );
    attrTable.appendChild(addRow);
    const attrNote = document.createElement('div');
    attrNote.className = 'sb-note';
    attrNote.textContent = `Invisible data attributes (INST, LOC, MFG, CAT, ASSYCODE, RATING1-2, WDTYPE=${block?.attributes.find((a) => a.tag === 'WDTYPE')?.default ?? ''}${meta.kind === 'terminal' ? ', TAGSTRIP' : ''}) are added automatically. Placeholder text = attribute tag; edit height / justification with the Properties palette.`;
    attrTable.appendChild(attrNote);
    b.appendChild(attrTable);

    // ---- wire connections
    b.appendChild(this.section('Wire connections'));
    const pins = ctl.pins();
    const pinTable = document.createElement('div');
    pinTable.className = 'sb-table';
    const dirName = (d: PinDirection) => PIN_DIRECTIONS.find(([k]) => k === d)?.[1] ?? String(d);
    for (const p of pins) {
      const r = document.createElement('div');
      r.className = 'sb-trow';
      r.innerHTML = `<b>${esc(p.tag)}</b><span class="sb-pos" title="${esc(dirName(p.dir))} connection">${esc(dirName(p.dir).charAt(0))} ${p.point.x.toFixed(3)}, ${p.point.y.toFixed(3)}</span>`;
      if (p.markerId) {
        const id = p.markerId;
        const pinInput = this.input(p.default, (v) => ctl.setPinDefault(id, v), { placeholder: 'pin' }) as HTMLInputElement;
        pinInput.classList.add('sb-pin');
        pinInput.title = 'Default pin number';
        r.append(pinInput, this.smallButton('x', 'Remove this pin marker', () => ctl.removeEntity(id), 'sb-btn-x'));
        r.addEventListener('mouseenter', () => {
          this.editor.selection = new Set([id]);
          this.editor.notify('selection');
          this.editor.render();
        });
      } else {
        const auto = document.createElement('span');
        auto.className = 'sb-auto';
        auto.textContent = `auto, pin ${p.default}`;
        auto.title = 'Detected from a line ending at x = +-0.375 (default pin number of the family); add an explicit pin here to choose another number';
        r.appendChild(auto);
      }
      pinTable.appendChild(r);
    }
    if (pins.length === 0) {
      const n = document.createElement('div');
      n.className = 'sb-note';
      n.textContent = 'No connection yet: end a line at x = -0.375 / +0.375 on y = 0, or add an explicit pin.';
      pinTable.appendChild(n);
    }
    const pinAdd = document.createElement('div');
    pinAdd.className = 'sb-addrow';
    const dirSel = this.select(PIN_DIRECTIONS.map(([k, v]): [string, string] => [String(k), v]), '1', () => {});
    const pinNo = document.createElement('input');
    pinNo.className = 'prop-input sb-pin';
    pinNo.placeholder = 'pin';
    pinNo.title = 'Default pin number for the new connection';
    pinNo.addEventListener('keydown', (ev) => ev.stopPropagation());
    pinAdd.append(dirSel, pinNo, this.smallButton('Add pin', 'Pick the connection point', () => ctl.addPin(parseInt(dirSel.value, 10) as PinDirection, pinNo.value.trim())));
    pinTable.appendChild(pinAdd);
    b.appendChild(pinTable);

    // ---- check results
    if (this.liveCheck) this.checkResults = ctl.check();
    if (this.checkResults) {
      b.appendChild(this.section('Check'));
      const box = document.createElement('div');
      box.className = 'sb-messages';
      for (const m of this.checkResults) {
        const d = document.createElement('div');
        d.className = `sb-msg ${m.level}`;
        d.textContent = m.text;
        box.appendChild(d);
      }
      b.appendChild(box);
    }

    // ---- actions (fixed footer under the scrolling body)
    const actions = this.actionsEl;
    const act = (label: string, title: string, fn: () => void, primary = false) => {
      const btn = document.createElement('button');
      btn.className = 'btn sb-action' + (primary ? ' primary' : '');
      btn.textContent = label;
      btn.title = title;
      btn.addEventListener('click', fn);
      return btn;
    };
    actions.append(
      act('Check', 'Validate the symbol (name, connections, attributes, size)', () => {
        this.liveCheck = true;
        this.checkResults = ctl.check();
        for (const m of this.checkResults) this.editor.log(`Symbol Builder check: ${m.level === 'ok' ? '' : `[${m.level}] `}${m.text}`);
        this.render();
      }),
      act('Save to Library', 'Save the symbol to the user library (also Ctrl+S in this tab)', () => {
        if (!ctl.save()) {
          this.liveCheck = true;
          this.checkResults = ctl.check();
          this.render();
        }
      }, true),
      act('Save and Insert', 'Save, close this tab and insert the symbol in the drawing it was started from', () => ctl.saveAndInsert()),
      act('Export DXF...', 'Write the symbol as a DXF block file', () => ctl.exportDxf()),
      act('Close', 'Close the symbol tab (asks to save when changed)', () => void ctl.closeActive()),
    );
  }
}

/** Build the palette into `container` and return the hooks the controller calls. */
export function createSymbolBuilderUi(editor: Editor, container: HTMLElement): SymbolBuilderUi & { palette: SymbolBuilderPalette } {
  const palette = new SymbolBuilderPalette(editor, container);
  makePaletteResizable(palette.el, {
    edge: 'left',
    initial: editor.settings.paletteWidths.symbolBuilder,
    min: 220,
    onWidth: (w) => updateSettings(editor, { paletteWidths: { ...editor.settings.paletteWidths, symbolBuilder: Math.round(w) } }),
  });
  return {
    palette,
    start: (init) => symbolBuilderStartDialog(editor, init),
    showPalette: (ctl) => palette.show(ctl),
    hidePalette: () => palette.hide(),
    refreshPalette: () => palette.render(),
    openTextFile: (accept) => electricalUi(editor).openTextFile?.(accept) ?? Promise.resolve(null),
  };
}
