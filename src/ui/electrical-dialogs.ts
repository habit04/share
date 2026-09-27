/**
 * Dialogs for the AutoCAD Electrical-style workflows: Insert/Edit Component
 * (with ACADE data, used-tag list, pins, catalog lookup, parent pick),
 * Catalog Browser, generic list picker, Schematic List (panel), Terminal
 * Strip Editor, Drawing / Project Properties, Wire Number editor, Multiple
 * Bus, Circuit Builder, Electrical Audit (jump-to-error) and Reports
 * (project scope, CSV, put on drawing). Same modal look as dialogs.ts.
 */
import type { Editor } from '../app/editor';
import type { ElectricalUi, ComponentDialogInit, ComponentDialogResult, PickItem, DrawingPropertiesInit, DrawingPropertiesResult, WireNumberDialogInit, WireNumberDialogResult, ReportsDialogOptions } from '../electrical/ui';
import type { CatalogItem } from '../electrical/catalog';
import { searchCatalog, catalogFamilies, catalogFamilyFor, userCatalogSize } from '../electrical/catalog';
import type { SchematicListRow, TerminalRow } from '../electrical/panel';
import type { BusSettings } from '../electrical/wires';
import type { CircuitOptions } from '../electrical/circuits';
import { CIRCUIT_KINDS } from '../electrical/circuits';
import type { AuditIssue } from '../electrical/audit';
import { auditSummary } from '../electrical/audit';
import type { Report } from '../electrical/reports';
import { REPORTS, reportToCsv } from '../electrical/reports';
import { DATA_ATTRIBUTES } from '../electrical/attributes';
import type { WdSettings } from '../electrical/wdm';
import type { Project } from '../app/project';
import { DESCRIPTION_LINES } from '../app/project';
import { findSymbol } from '../electrical/symbols';
import { IEC_SYMBOLS } from '../electrical/iec';
import { drawPreview } from '../render/draw';
import { icon } from './icons';
import { esc } from './dom';

// ---------------------------------------------------------------- helpers (same look as dialogs.ts)

interface Modal {
  root: HTMLElement;
  body: HTMLElement;
  footer: HTMLElement;
  close: () => void;
  onClose: (fn: () => void) => void;
}

function modal(title: string, width = 520, theme: 'light' | 'dark' = 'light'): Modal {
  const root = document.createElement('div');
  root.className = 'modal-backdrop';
  const dlg = document.createElement('div');
  dlg.className = `modal ${theme}`;
  dlg.style.width = `${width}px`;
  const head = document.createElement('div');
  head.className = 'modal-title';
  head.innerHTML = `<span>${esc(title)}</span><button class="modal-close" title="Close">${icon('close')}</button>`;
  const body = document.createElement('div');
  body.className = 'modal-body';
  const footer = document.createElement('div');
  footer.className = 'modal-footer';
  dlg.append(head, body, footer);
  root.appendChild(dlg);
  document.body.appendChild(root);
  const closers: Array<() => void> = [];
  const close = () => {
    root.remove();
    window.removeEventListener('keydown', onKey, true);
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      for (const fn of closers) fn();
      close();
    }
  };
  window.addEventListener('keydown', onKey, true);
  head.querySelector('.modal-close')!.addEventListener('click', () => {
    for (const fn of closers) fn();
    close();
  });
  return { root, body, footer, close, onClose: (fn) => closers.push(fn) };
}

function button(label: string, primary = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'btn' + (primary ? ' primary' : '');
  b.textContent = label;
  return b;
}

function field(label: string, input: HTMLElement): HTMLElement {
  const row = document.createElement('label');
  row.className = 'field';
  const l = document.createElement('span');
  l.textContent = label;
  row.append(l, input);
  return row;
}

function textInput(value: string, type = 'text'): HTMLInputElement {
  const i = document.createElement('input');
  i.type = type;
  i.value = value;
  i.className = 'input';
  i.spellcheck = false;
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

function checkbox(label: string, checked: boolean): { el: HTMLElement; input: HTMLInputElement } {
  const wrap = document.createElement('label');
  wrap.className = 'radio-row';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  wrap.append(input, document.createTextNode(` ${label}`));
  return { el: wrap, input };
}

function grid(cols = 2): HTMLElement {
  const g = document.createElement('div');
  g.className = 'form-grid';
  if (cols !== 2) g.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  return g;
}

function table(columns: string[]): { table: HTMLTableElement; body: HTMLTableSectionElement } {
  const t = document.createElement('table');
  t.className = 'report-table';
  t.innerHTML = `<thead><tr>${columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>`;
  const body = document.createElement('tbody');
  t.appendChild(body);
  return { table: t, body };
}

function wrapScroll(el: HTMLElement, maxHeight = 380): HTMLElement {
  const w = document.createElement('div');
  w.className = 'report-wrap';
  w.style.maxHeight = `${maxHeight}px`;
  w.appendChild(el);
  return w;
}

/** Promise-style dialog scaffolding: resolves once, on OK / Cancel / Escape / close. */
function dialog<T>(title: string, width: number, build: (m: Modal, finish: (v: T | null) => void) => void): Promise<T | null> {
  return new Promise((resolve) => {
    const m = modal(title, width);
    let done = false;
    const finish = (v: T | null) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    m.onClose(() => finish(null));
    build(m, finish);
  });
}

const findAnySymbol = (name: string) => findSymbol(name) ?? IEC_SYMBOLS.find((s) => s.name === name);

const selectableRow = (tr: HTMLTableRowElement, onSelect: () => void, onActivate: () => void) => {
  tr.style.cursor = 'pointer';
  tr.addEventListener('click', () => {
    tr.parentElement?.querySelectorAll('tr').forEach((r) => r.classList.remove('current'));
    tr.classList.add('current');
    tr.style.background = '#cce4f7';
    tr.parentElement?.querySelectorAll('tr').forEach((r) => {
      if (r !== tr) (r as HTMLElement).style.background = '';
    });
    onSelect();
  });
  tr.addEventListener('dblclick', onActivate);
};

// ---------------------------------------------------------------- Insert / Edit Component

export function componentDialog(editor: Editor, init: ComponentDialogInit, catalog: (family: string, type?: string) => Promise<CatalogItem | null>): Promise<ComponentDialogResult | null> {
  return dialog<ComponentDialogResult>(`${init.isNew ? 'Insert' : 'Edit'} Component: ${init.block}`, 720, (m, finish) => {
    const sym = findAnySymbol(init.block) ?? editor.doc.lookupBlock(init.block);
    const preview = document.createElement('canvas');
    preview.width = 150;
    preview.height = 100;
    preview.className = 'component-preview';
    if (sym) drawPreview(preview.getContext('2d')!, sym.entities, editor.doc.layers, editor.doc.lookupBlock, 150, 100, '#202020', 12);
    const inputs = new Map<string, HTMLInputElement>();
    const mk = (tag: string, placeholder = '') => {
      const i = textInput(init.attrs[tag] ?? '');
      i.placeholder = placeholder;
      inputs.set(tag, i);
      return i;
    };

    // Left column: preview + tag + parent
    const left = document.createElement('div');
    left.style.display = 'flex';
    left.style.flexDirection = 'column';
    left.style.gap = '8px';
    left.style.width = '250px';
    left.appendChild(preview);
    const info = document.createElement('div');
    info.className = 'hint';
    info.style.marginTop = '0';
    info.textContent = `${init.block} — ${init.blockDescription}  (family ${init.family})`;
    left.appendChild(info);

    let parentId: string | undefined;
    if (init.isChild && init.parents) {
      const parentSel = select([['', '(no parent)'], ...init.parents.map((p): [string, string] => [p.id, `${p.tag}  ${p.description || p.block}  rung ${p.ref ?? '?'}`])], init.parents.find((p) => p.tag === init.attrs.TAG1)?.id ?? '');
      parentSel.addEventListener('change', () => {
        parentId = parentSel.value || undefined;
        const p = init.parents!.find((x) => x.id === parentId);
        if (p) {
          const parentEnt = editor.doc.entity(p.id);
          inputs.get('TAG1')!.value = p.tag;
          if (parentEnt?.type === 'insert') {
            for (const k of ['INST', 'LOC', 'DESC1', 'DESC2', 'DESC3']) if (inputs.get(k)) inputs.get(k)!.value = parentEnt.attributes[k] ?? '';
          }
        }
      });
      parentId = parentSel.value || undefined;
      left.appendChild(field('Parent (coil)', parentSel));
    }
    const tag = mk('TAG1');
    left.appendChild(field('Component Tag', tag));
    const tagRow = document.createElement('div');
    tagRow.className = 'form-inline';
    tagRow.style.marginTop = '0';
    const usedSel = select([['', `Used (${init.used.length})`], ...init.used.map((u): [string, string] => [u, u])], '');
    usedSel.title = 'Tags already used by this family; pick one to reuse it (e.g. a second pole)';
    usedSel.addEventListener('change', () => {
      if (usedSel.value) tag.value = usedSel.value;
    });
    const nextBtn = button('Next');
    nextBtn.title = `Next free tag: ${init.nextTag}`;
    nextBtn.addEventListener('click', () => (tag.value = init.nextTag));
    tagRow.append(usedSel, nextBtn);
    if (!init.isChild) left.appendChild(tagRow);

    // Right column: data grid
    const right = document.createElement('div');
    right.style.flex = '1';
    const g1 = grid(2);
    g1.append(field('Installation (INST)', mk('INST')), field('Location (LOC)', mk('LOC')));
    const gDesc = grid(1);
    gDesc.style.marginTop = '8px';
    gDesc.append(field('Description line 1', mk('DESC1', 'e.g. START MOTOR')), field('Description line 2', mk('DESC2')), field('Description line 3', mk('DESC3')));
    const g2 = grid(2);
    g2.style.marginTop = '8px';
    g2.append(field('Manufacturer (MFG)', mk('MFG')), field('Catalog (CAT)', mk('CAT')), field('Assembly code', mk('ASSYCODE')), field('Rating', mk('RATING1')));
    const catRow = document.createElement('div');
    catRow.className = 'form-inline';
    const lookup = button('Catalog Lookup...');
    lookup.addEventListener('click', () => {
      void catalog(catalogFamilyFor(init.family), /_NC$/.test(init.block) ? 'NC' : /_NO$/.test(init.block) ? 'NO' : undefined).then((item) => {
        if (!item) return;
        inputs.get('MFG')!.value = item.mfg;
        inputs.get('CAT')!.value = item.cat;
        if (!inputs.get('DESC1')!.value) inputs.get('DESC1')!.value = item.desc;
        if (item.assycode) inputs.get('ASSYCODE')!.value = item.assycode;
        if (item.rating && !inputs.get('RATING1')!.value) inputs.get('RATING1')!.value = item.rating;
      });
    });
    catRow.appendChild(lookup);
    const pinsGrid = grid(Math.min(4, Math.max(2, init.pins.length)));
    pinsGrid.style.marginTop = '8px';
    for (const p of init.pins) pinsGrid.appendChild(field(`Pin ${p.tag.slice(-2).replace(/^0/, '')} (${p.tag.slice(0, 2) === 'X1' ? 'left' : p.tag.slice(0, 2) === 'X4' ? 'right' : p.tag.slice(0, 2) === 'X2' ? 'top' : 'bottom'})`, mk(p.tag)));
    right.append(g1, gDesc, g2, catRow);
    if (init.pins.length) {
      const h = document.createElement('div');
      h.className = 'hint';
      h.textContent = 'Pins / terminal numbers (stored in the invisible X?TERM attributes):';
      right.append(h, pinsGrid);
    }
    const row = document.createElement('div');
    row.className = 'component-row';
    row.append(left, right);
    m.body.appendChild(row);

    const ok = button('OK', true);
    const cancel = button('Cancel');
    ok.addEventListener('click', () => {
      const attrs: Record<string, string> = { ...init.attrs };
      for (const [k, i] of inputs) attrs[k] = i.value.trim().toUpperCase();
      finish({ attrs, parentId });
    });
    cancel.addEventListener('click', () => finish(null));
    m.footer.append(ok, cancel);
    tag.focus();
    tag.select();
    m.root.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.target as HTMLElement).tagName !== 'SELECT') ok.click();
    });
    void DATA_ATTRIBUTES;
  });
}

// ---------------------------------------------------------------- Catalog Browser

export function catalogBrowserDialog(init: { family?: string; query?: string; type?: string }): Promise<CatalogItem | null> {
  return dialog<CatalogItem>('Catalog Browser', 820, (m, finish) => {
    const fams = catalogFamilies();
    const family = select([['', '(all families)'], ...fams.map((f): [string, string] => [f, f])], init.family && fams.includes(init.family) ? init.family : '');
    const search = textInput(init.query ?? '');
    search.placeholder = 'Search catalog number, manufacturer, description...';
    const top = grid(2);
    top.append(field('Family', family), field('Search', search));
    const { table: t, body } = table(['Family', 'Manufacturer', 'Catalog', 'Description', 'Rating', 'Type', 'Source']);
    let current: CatalogItem | null = null;
    const status = document.createElement('div');
    status.className = 'hint';
    const render = () => {
      const items = searchCatalog({ family: family.value || undefined, text: search.value, type: init.type }).slice(0, 400);
      body.innerHTML = '';
      current = null;
      for (const it of items) {
        const tr = document.createElement('tr');
        tr.innerHTML = [it.family, it.mfg, it.cat, it.desc, it.rating ?? '', it.type ?? '', it.source === 'user' ? 'user' : 'built-in'].map((c) => `<td>${esc(c)}</td>`).join('');
        selectableRow(tr, () => (current = it), () => finish(it));
        body.appendChild(tr);
      }
      if (items.length === 0) body.innerHTML = '<tr><td colspan="7">No matching parts</td></tr>';
      status.textContent = `${items.length} part(s)${userCatalogSize() ? ` — user catalog: ${userCatalogSize()} part(s)` : ' — built-in catalog (load a user catalog with AECATALOGLOAD)'}`;
    };
    family.addEventListener('change', render);
    search.addEventListener('input', render);
    render();
    m.body.append(top, wrapScroll(t, 360), status);
    const ok = button('OK', true);
    const cancel = button('Cancel');
    ok.addEventListener('click', () => finish(current));
    cancel.addEventListener('click', () => finish(null));
    m.footer.append(ok, cancel);
    search.focus();
    m.root.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && current) ok.click();
    });
  });
}

// ---------------------------------------------------------------- generic list picker

export function pickListDialog(title: string, items: PickItem[], opts: { detailHeader?: string; okLabel?: string } = {}): Promise<string | null> {
  return dialog<string>(title, 560, (m, finish) => {
    const { table: t, body } = table(['Item', opts.detailHeader ?? 'Detail']);
    let current: string | null = items[0]?.value ?? null;
    items.forEach((it, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${esc(it.label)}</td><td>${esc(it.detail ?? '')}</td>`;
      if (i === 0) tr.style.background = '#cce4f7';
      selectableRow(tr, () => (current = it.value), () => finish(it.value));
      body.appendChild(tr);
    });
    m.body.appendChild(wrapScroll(t, 340));
    const ok = button(opts.okLabel ?? 'OK', true);
    const cancel = button('Cancel');
    ok.addEventListener('click', () => finish(current));
    cancel.addEventListener('click', () => finish(null));
    m.footer.append(ok, cancel);
    m.root.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') ok.click();
    });
  });
}

// ---------------------------------------------------------------- Schematic List (panel)

export function schematicListDialog(rows: SchematicListRow[]): Promise<SchematicListRow | null> {
  return dialog<SchematicListRow>('Schematic List: insert panel footprints', 860, (m, finish) => {
    const hide = checkbox('Hide components already placed on the panel', true);
    const { table: t, body } = table(['Tag', 'Family', 'Description', 'Manufacturer', 'Catalog', 'Inst/Loc', 'Drawing', 'Rung', 'Placed']);
    let current: SchematicListRow | null = null;
    const render = () => {
      body.innerHTML = '';
      current = null;
      const list = rows.filter((r) => !(hide.input.checked && r.placed));
      for (const r of list) {
        const tr = document.createElement('tr');
        tr.innerHTML = [r.tag, r.family, r.desc, r.mfg, r.cat, `${r.inst ? `+${r.inst}` : ''}${r.loc ? `-${r.loc}` : ''}`, r.drawing, r.ref, r.placed ? 'yes' : ''].map((c) => `<td>${esc(c)}</td>`).join('');
        selectableRow(tr, () => (current = r), () => finish(r));
        body.appendChild(tr);
      }
      if (list.length === 0) body.innerHTML = '<tr><td colspan="9">All schematic components are placed</td></tr>';
    };
    hide.input.addEventListener('change', render);
    render();
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = `${rows.filter((r) => !r.placed).length} of ${rows.length} component(s) not yet on the panel. Select one and click Insert, then pick the footprint location.`;
    m.body.append(hide.el, wrapScroll(t, 380), hint);
    const ok = button('Insert', true);
    const cancel = button('Close');
    ok.addEventListener('click', () => finish(current));
    cancel.addEventListener('click', () => finish(null));
    m.footer.append(ok, cancel);
  });
}

// ---------------------------------------------------------------- Terminal Strip Editor

export function terminalStripEditorDialog(rows: TerminalRow[]): Promise<TerminalRow[] | null> {
  return dialog<TerminalRow[]>('Terminal Strip Editor', 820, (m, finish) => {
    const { table: t, body } = table(['Strip', 'Terminal', 'Left Wire', 'Left Device', 'Right Wire', 'Right Device', 'Rung']);
    const edits = rows.map((r) => ({ ...r }));
    for (const r of edits) {
      const tr = document.createElement('tr');
      const strip = textInput(r.strip);
      strip.style.width = '70px';
      const num = textInput(r.number);
      num.style.width = '60px';
      strip.addEventListener('input', () => (r.strip = strip.value.trim().toUpperCase()));
      num.addEventListener('input', () => (r.number = num.value.trim()));
      const cells = [strip, num, r.leftWire, r.leftDevice, r.rightWire, r.rightDevice, r.ref];
      for (const c of cells) {
        const td = document.createElement('td');
        if (typeof c === 'string') td.textContent = c;
        else td.appendChild(c);
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
    const renumber = button('Renumber 1..n');
    renumber.className += ' left';
    renumber.addEventListener('click', () => {
      edits.forEach((r, i) => (r.number = String(i + 1)));
      body.querySelectorAll('tr').forEach((tr, i) => ((tr.querySelectorAll('input')[1] as HTMLInputElement).value = String(i + 1)));
    });
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Wire numbers and devices are read from the schematic. Edit strip tags / terminal numbers and click OK to update the terminal symbols.';
    m.body.append(wrapScroll(t, 380), hint);
    const ok = button('OK', true);
    const cancel = button('Cancel');
    ok.addEventListener('click', () => finish(edits));
    cancel.addEventListener('click', () => finish(null));
    m.footer.append(renumber, ok, cancel);
  });
}

// ---------------------------------------------------------------- Drawing Properties

export function drawingPropertiesDialog(init: DrawingPropertiesInit): Promise<DrawingPropertiesResult | null> {
  return dialog<DrawingPropertiesResult>(`Drawing Properties: ${init.fileName}`, 620, (m, finish) => {
    const s = init.settings;
    const sheet = textInput(init.drawing?.sheet ?? s.sheet);
    const desc = textInput(init.drawing?.description ?? s.drawingDescription);
    const dwgno = textInput(init.drawing?.dwgno ?? s.drawingNumber);
    const standard = select([['JIC', 'JIC / NFPA (inch ladder)'], ['IEC', 'IEC 60617']], s.standard);
    const tagMode = select([['reference', 'Reference-based (PB101, PB101A)'], ['sequential', 'Sequential (PB1, PB2)']], s.tagMode);
    const tagFormat = textInput(s.tagFormat);
    tagFormat.placeholder = '%F%N';
    const tagStart = textInput(String(s.tagStart), 'number');
    const wireMode = select([['reference', 'Reference-based (100, 100A)'], ['sequential', 'Sequential']], s.wireMode);
    const wireFormat = textInput(s.wireFormat);
    const wireStart = textInput(String(s.wireStart), 'number');
    const wirePos = select([['above', 'Above wire'], ['below', 'Below wire'], ['inline', 'In-line (gap)']], s.wirePosition);
    const xrefFormat = textInput(s.xrefFormat);
    const xrefStyle = select([['text', 'Compact text (NO 101, 102 / NC 103)'], ['table', 'Small table below the coil']], s.xrefStyle);
    const iecProj = textInput(s.iecProject);
    const iecInst = textInput(s.iecInstallation);
    const iecLoc = textInput(s.iecLocation);
    const rung = textInput(String(s.rungSpacing), 'number');
    const width = textInput(String(s.ladderWidth), 'number');
    const section = (title: string, ...els: HTMLElement[]) => {
      const h = document.createElement('div');
      h.className = 'palette-section-title';
      h.style.margin = '10px 0 4px';
      h.style.fontWeight = '600';
      h.textContent = title;
      const g = grid(2);
      g.append(...els);
      m.body.append(h, g);
    };
    section('Sheet', field('Sheet number', sheet), field('Drawing number (DWGNO)', dwgno), field('Drawing description (TITLE)', desc), field('Symbol standard', standard));
    section('Component tags', field('Tag mode', tagMode), field('Tag format (%F family, %N number, %S sheet)', tagFormat), field('Sequential start', tagStart), field('Cross-reference format (%N rung, %S sheet)', xrefFormat), field('Cross-reference style', xrefStyle));
    section('Wire numbers', field('Wire number mode', wireMode), field('Wire number format', wireFormat), field('Sequential start', wireStart), field('Position', wirePos));
    section('IEC codes / ladder', field('Project code', iecProj), field('Installation (INST default)', iecInst), field('Location (LOC default)', iecLoc), field('Rung spacing', rung), field('Ladder width', width));
    const ok = button('OK', true);
    const cancel = button('Cancel');
    ok.addEventListener('click', () => {
      const num = (i: HTMLInputElement, d: number) => (Number.isFinite(parseFloat(i.value)) ? parseFloat(i.value) : d);
      const settings: WdSettings = {
        ...s,
        sheet: sheet.value.trim(),
        drawingNumber: dwgno.value.trim(),
        drawingDescription: desc.value.trim().toUpperCase(),
        standard: standard.value === 'IEC' ? 'IEC' : 'JIC',
        tagMode: tagMode.value === 'sequential' ? 'sequential' : 'reference',
        tagFormat: tagFormat.value.trim() || '%F%N',
        tagStart: Math.max(1, Math.round(num(tagStart, s.tagStart))),
        wireMode: wireMode.value === 'sequential' ? 'sequential' : 'reference',
        wireFormat: wireFormat.value.trim() || '%N',
        wireStart: Math.round(num(wireStart, s.wireStart)),
        wirePosition: wirePos.value === 'below' ? 'below' : wirePos.value === 'inline' ? 'inline' : 'above',
        xrefFormat: xrefFormat.value.trim() || '%N',
        xrefStyle: xrefStyle.value === 'table' ? 'table' : 'text',
        iecProject: iecProj.value.trim().toUpperCase(),
        iecInstallation: iecInst.value.trim().toUpperCase(),
        iecLocation: iecLoc.value.trim().toUpperCase(),
        rungSpacing: Math.max(0.1, num(rung, s.rungSpacing)),
        ladderWidth: Math.max(1, num(width, s.ladderWidth)),
      };
      finish({ settings, description: settings.drawingDescription, sheet: settings.sheet, dwgno: settings.drawingNumber });
    });
    cancel.addEventListener('click', () => finish(null));
    m.footer.append(ok, cancel);
    sheet.focus();
    m.root.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.target as HTMLElement).tagName !== 'SELECT') ok.click();
    });
  });
}

// ---------------------------------------------------------------- Project Properties

export function projectPropertiesDialog(init: Project): Promise<Project | null> {
  return dialog<Project>('Project Properties', 640, (m, finish) => {
    const name = textInput(init.name);
    const desc = textInput(init.description ?? '');
    const catalogFile = textInput(init.settings?.catalogFile ?? '');
    catalogFile.placeholder = 'parts.json (relative to the project file)';
    const tagFormat = textInput(init.settings?.tagFormat ?? '');
    tagFormat.placeholder = '(drawing default)';
    const tagMode = select([['', '(drawing default)'], ['reference', 'Reference-based'], ['sequential', 'Sequential']], init.settings?.tagMode ?? '');
    const standard = select([['', '(drawing default)'], ['JIC', 'JIC'], ['IEC', 'IEC']], init.settings?.standard ?? '');
    const iecProject = textInput(init.settings?.iecProject ?? '');
    const inst = textInput(init.settings?.installation ?? '');
    const loc = textInput(init.settings?.location ?? '');
    const g = grid(2);
    g.append(field('Project name', name), field('Description', desc), field('User catalog file', catalogFile), field('Tag format override', tagFormat), field('Tag mode override', tagMode), field('Symbol standard', standard), field('IEC project code', iecProject), field('Default installation', inst), field('Default location', loc));
    const h = document.createElement('div');
    h.className = 'hint';
    h.textContent = 'Project description lines feed the title block (UPDATE TITLE BLOCK): PROJECT, CUSTOMER, JOB, DRAWN, CHECKED, APPROVED, LINE7...';
    const lines = grid(2);
    const lineInputs = DESCRIPTION_LINES.map((tag, i) => {
      const inp = textInput(init.descriptions?.[i] ?? '');
      lines.appendChild(field(`Line ${i + 1} (${tag})`, inp));
      return inp;
    });
    const dl = document.createElement('div');
    dl.className = 'hint';
    dl.textContent = `Drawings in project: ${init.drawings.length}${init.path ? ` — ${init.path}` : ' (unsaved)'}`;
    m.body.append(g, h, lines, dl);
    const ok = button('OK', true);
    const cancel = button('Cancel');
    ok.addEventListener('click', () => {
      const settings = {
        ...init.settings,
        catalogFile: catalogFile.value.trim() || undefined,
        tagFormat: tagFormat.value.trim() || undefined,
        tagMode: (tagMode.value || undefined) as 'reference' | 'sequential' | undefined,
        standard: (standard.value || undefined) as 'JIC' | 'IEC' | undefined,
        iecProject: iecProject.value.trim() || undefined,
        installation: inst.value.trim().toUpperCase() || undefined,
        location: loc.value.trim().toUpperCase() || undefined,
      };
      finish({ ...init, name: name.value.trim() || init.name, description: desc.value.trim() || undefined, descriptions: lineInputs.map((i) => i.value.trim()), settings });
    });
    cancel.addEventListener('click', () => finish(null));
    m.footer.append(ok, cancel);
    name.focus();
  });
}

// ---------------------------------------------------------------- Wire number editor

export function wireNumberDialog(init: WireNumberDialogInit): Promise<WireNumberDialogResult | null> {
  return dialog<WireNumberDialogResult>('Edit Wire Number', 460, (m, finish) => {
    const label = textInput(init.label);
    const fixed = checkbox('Fixed (kept by AEWIRENO renumbering)', init.fixed);
    const pos = select([['above', 'Above wire'], ['below', 'Below wire'], ['inline', 'In-line (gap in wire)']], init.position);
    const g = grid(2);
    g.append(field('Wire number', label), field('Position', pos));
    const h = document.createElement('div');
    h.className = 'hint';
    h.textContent = `Find / replace across all ${init.all.length} wire numbers (optional):`;
    const find = textInput('');
    find.placeholder = 'find';
    const replace = textInput('');
    replace.placeholder = 'replace with';
    const fr = grid(2);
    fr.append(field('Find', find), field('Replace', replace));
    m.body.append(g, fixed.el, h, fr);
    const ok = button('OK', true);
    const cancel = button('Cancel');
    ok.addEventListener('click', () =>
      finish({
        edit: { label: label.value.trim().toUpperCase() || init.label, fixed: fixed.input.checked, position: pos.value === 'below' ? 'below' : pos.value === 'inline' ? 'inline' : 'above' },
        findReplace: find.value ? { find: find.value, replace: replace.value } : undefined,
      }),
    );
    cancel.addEventListener('click', () => finish(null));
    m.footer.append(ok, cancel);
    label.focus();
    label.select();
    m.root.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.target as HTMLElement).tagName !== 'SELECT') ok.click();
    });
  });
}

// ---------------------------------------------------------------- Multiple bus

export function busDialog(init: BusSettings): Promise<BusSettings | null> {
  return dialog<BusSettings>('Multiple Bus', 400, (m, finish) => {
    const count = textInput(String(init.count), 'number');
    const spacing = textInput(String(init.spacing), 'number');
    const dir = select([['vertical', 'Vertical (3-phase bus)'], ['horizontal', 'Horizontal']], init.direction);
    const g = grid(2);
    g.append(field('Number of wires', count), field('Spacing', spacing), field('Direction', dir));
    m.body.appendChild(g);
    const ok = button('OK', true);
    const cancel = button('Cancel');
    ok.addEventListener('click', () => finish({ ...init, count: Math.max(1, Math.min(12, Math.round(parseFloat(count.value) || init.count))), spacing: Math.max(0.05, parseFloat(spacing.value) || init.spacing), direction: dir.value === 'horizontal' ? 'horizontal' : 'vertical' }));
    cancel.addEventListener('click', () => finish(null));
    m.footer.append(ok, cancel);
    count.focus();
    m.root.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.target as HTMLElement).tagName !== 'SELECT') ok.click();
    });
  });
}

// ---------------------------------------------------------------- Circuit builder

export function circuitBuilderDialog(init: CircuitOptions): Promise<CircuitOptions | null> {
  return dialog<CircuitOptions>('Circuit Builder', 520, (m, finish) => {
    const kind = select(CIRCUIT_KINDS.map((k): [string, string] => [k.kind, k.name]), init.kind);
    const standard = select([['JIC', 'JIC'], ['IEC', 'IEC']], init.standard);
    const load = textInput(init.loadDescription);
    const width = textInput(String(init.right - init.left), 'number');
    const spacing = textInput(String(init.spacing), 'number');
    const first = textInput(String(init.firstReference), 'number');
    const ladder = checkbox('Draw rails and rung references (when not placed on an existing ladder)', init.drawLadder);
    const g = grid(2);
    g.append(field('Circuit', kind), field('Symbol standard', standard), field('Load description', load), field('Ladder width (no rails found)', width), field('Rung spacing', spacing), field('First rung reference', first));
    const h = document.createElement('div');
    h.className = 'hint';
    h.textContent = 'Pick the first rung at the left rail of an existing ladder: rails, rung spacing and references are detected. Tags follow the drawing tag format; wire numbers and cross-references update afterwards.';
    m.body.append(g, ladder.el, h);
    const ok = button('OK', true);
    const cancel = button('Cancel');
    ok.addEventListener('click', () =>
      finish({
        ...init,
        kind: (CIRCUIT_KINDS.find((k) => k.kind === kind.value)?.kind ?? init.kind) as CircuitOptions['kind'],
        standard: standard.value === 'IEC' ? 'IEC' : 'JIC',
        loadDescription: load.value.trim().toUpperCase() || init.loadDescription,
        right: init.left + Math.max(2, parseFloat(width.value) || init.right - init.left),
        spacing: Math.max(0.25, parseFloat(spacing.value) || init.spacing),
        firstReference: Math.round(parseFloat(first.value) || init.firstReference),
        drawLadder: ladder.input.checked,
      }),
    );
    cancel.addEventListener('click', () => finish(null));
    m.footer.append(ok, cancel);
  });
}

// ---------------------------------------------------------------- Electrical audit

export function auditDialog(editor: Editor, issues: AuditIssue[], onJump: (issue: AuditIssue) => void, onRefresh: () => AuditIssue[]): void {
  const m = modal('Electrical Audit', 820);
  const { table: t, body } = table(['', 'Check', 'Item', 'Detail']);
  const status = document.createElement('div');
  status.className = 'hint';
  let list = issues;
  let current: AuditIssue | null = null;
  const render = () => {
    body.innerHTML = '';
    current = null;
    for (const i of list) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td style="color:${i.severity === 'error' ? '#c00' : '#b07800'}">${i.severity === 'error' ? 'ERROR' : 'warn'}</td><td>${esc(i.check)}</td><td>${esc(i.item)}</td><td>${esc(i.detail)}</td>`;
      selectableRow(tr, () => (current = i), () => onJump(i));
      body.appendChild(tr);
    }
    if (list.length === 0) body.innerHTML = '<tr><td colspan="4">No problems found</td></tr>';
    const s = auditSummary(list);
    status.textContent = `${s.errors} error(s), ${s.warnings} warning(s). Double-click (or Go To) zooms to the item and selects it.`;
  };
  render();
  m.body.append(wrapScroll(t, 400), status);
  const go = button('Go To');
  go.className += ' left';
  go.addEventListener('click', () => current && onJump(current));
  const refresh = button('Re-run');
  refresh.addEventListener('click', () => {
    list = onRefresh();
    render();
  });
  const csv = button('Save as CSV...');
  csv.addEventListener('click', () => {
    const r: Report = { title: 'Electrical Audit', columns: ['Severity', 'Check', 'Item', 'Detail'], rows: list.map((i) => [i.severity, i.check, i.item, i.detail]) };
    const text = reportToCsv(r);
    const save = editor.fileBridge?.saveText?.('Electrical_Audit.csv', text, 'CSV', 'csv');
    if (save) void save.then((p) => p && editor.log(`Audit saved: ${p}`));
  });
  const close = button('Close', true);
  close.addEventListener('click', () => m.close());
  m.footer.append(go, refresh, csv, close);
}

// ---------------------------------------------------------------- Reports

export function electricalReportsDialog(editor: Editor, opts: ReportsDialogOptions): void {
  const m = modal('Reports', 900);
  const tabs = document.createElement('div');
  tabs.className = 'report-tabs';
  tabs.style.flexWrap = 'wrap';
  const wrap = document.createElement('div');
  wrap.className = 'report-wrap';
  const scope = checkbox(`Project-wide (all ${editor.project.drawings.length} drawing(s) in ${editor.project.name})`, false);
  scope.input.disabled = !opts.projectAvailable;
  if (!opts.projectAvailable) scope.el.title = 'Open a project with drawings in the desktop app to report across drawings';
  let current: Report = { title: '', columns: [], rows: [] };
  let key = opts.initialKey;
  const status = document.createElement('div');
  status.className = 'hint';
  const render = async () => {
    tabs.innerHTML = '';
    for (const r of REPORTS) {
      const b = document.createElement('button');
      b.className = 'report-tab' + (r.key === key ? ' active' : '');
      b.textContent = r.name;
      b.addEventListener('click', () => {
        key = r.key;
        void render();
      });
      tabs.appendChild(b);
    }
    status.textContent = 'Building report...';
    current = await opts.build(key, scope.input.checked);
    const t = document.createElement('table');
    t.className = 'report-table';
    t.innerHTML = `<thead><tr>${current.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>`;
    const tb = document.createElement('tbody');
    for (const row of current.rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = row.map((c) => `<td>${esc(c)}</td>`).join('');
      tb.appendChild(tr);
    }
    if (current.rows.length === 0) tb.innerHTML = '<tr><td colspan="12">No data</td></tr>';
    t.appendChild(tb);
    wrap.innerHTML = '';
    wrap.appendChild(t);
    status.textContent = `${current.title}: ${current.rows.length} row(s)`;
  };
  scope.input.addEventListener('change', () => void render());
  void render();
  m.body.append(tabs, scope.el, wrap, status);
  const exp = button('Save as CSV...');
  exp.className += ' left';
  exp.addEventListener('click', () => {
    void opts.saveCsv(`${current.title.replace(/[^A-Za-z0-9]+/g, '_')}.csv`, reportToCsv(current)).then((p) => {
      if (p) editor.log(`Report saved: ${p}`);
    });
  });
  const put = button('Put on Drawing');
  put.addEventListener('click', () => {
    m.close();
    opts.putOnDrawing(current);
  });
  const close = button('Close', true);
  close.addEventListener('click', () => m.close());
  m.footer.append(exp, put, close);
}

// ---------------------------------------------------------------- file picker (browser fallback)

function browserOpenTextFile(accept: string): Promise<{ path: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      resolve({ path: f.name, text: await f.text() });
    });
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/** The default dialog set installed on editor.hooks.electrical. */
export function createElectricalDialogs(editor: Editor): ElectricalUi {
  const ui: ElectricalUi = {
    editComponent: (init) => componentDialog(editor, init, (family, type) => catalogBrowserDialog({ family, type })),
    catalogBrowser: (init) => catalogBrowserDialog(init),
    pickList: (title, items, opts) => pickListDialog(title, items, opts),
    schematicList: (rows) => schematicListDialog(rows),
    terminalStripEditor: (rows) => terminalStripEditorDialog(rows),
    drawingProperties: (init) => drawingPropertiesDialog(init),
    projectProperties: (init) => projectPropertiesDialog(init),
    wireNumberEdit: (init) => wireNumberDialog(init),
    busSettings: (init) => busDialog(init),
    circuitBuilder: (init) => circuitBuilderDialog(init),
    audit: (issues, onJump, onRefresh) => auditDialog(editor, issues, onJump, onRefresh),
    reports: (opts) => electricalReportsDialog(editor, opts),
    openTextFile: async (accept) => {
      // Desktop: the project file dialog reads any JSON file; browser: a file input.
      if (editor.fileBridge?.openProject && window.jautocad) {
        try {
          return await editor.fileBridge.openProject();
        } catch {
          return null;
        }
      }
      return browserOpenTextFile(accept);
    },
  };
  return ui;
}
