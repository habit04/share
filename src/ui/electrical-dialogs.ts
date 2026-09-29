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
import { searchCatalog, catalogFamilies, catalogFamilyFor, userCatalogSize, packCatalogSize, catalogSourceLabel } from '../electrical/catalog';
import { packRegistry, packStatus, type InstalledPack } from '../electrical/packs';
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
import { DEFAULT_WDT, parseWdt, formatWdt } from '../electrical/titleblock-map';
import { locationViewReport, type LocationGroup, type LocationRow } from '../electrical/project-tools';
import { plcRowsToCsv, type PlcImport, type PlcIoRow, type PlcModuleOptions } from '../electrical/plc-import';
import { CONDUCTOR_SCHEMES, type CableAssignment } from '../electrical/cables';
import { FILTER_OPS, describeTemplate, type ReportTemplate, type ReportFilter } from '../electrical/report-templates';
import { findLibrarySymbol } from '../electrical/library';
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

const findAnySymbol = (name: string) => findLibrarySymbol(name);

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

/** "built-in + user catalog (n) + n pack(s) (m parts)" for the browser's status line. */
export function catalogSourcesSummary(): string {
  const parts = ['built-in'];
  if (userCatalogSize()) parts.push(`user catalog (${userCatalogSize()})`);
  const packs = packRegistry.list().filter((p) => p.verified.ok);
  if (packs.length) parts.push(`${packs.length} pack(s) (${packCatalogSize()} parts)`);
  return parts.join(' + ');
}

export function catalogBrowserDialog(init: { family?: string; query?: string; type?: string }, editor?: Editor): Promise<CatalogItem | null> {
  return dialog<CatalogItem>('Catalog Browser', 860, (m, finish) => {
    const family = select([['', '(all families)']], '');
    const fillFamilies = (keep: string) => {
      const fams = catalogFamilies();
      family.innerHTML = '';
      for (const [v, label] of [['', '(all families)'], ...fams.map((f): [string, string] => [f, f])] as Array<[string, string]>) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = label;
        family.appendChild(o);
      }
      family.value = keep && fams.includes(keep) ? keep : '';
    };
    fillFamilies(init.family ?? '');
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
        tr.innerHTML = [it.family, it.mfg, it.cat, it.desc, it.rating ?? '', it.type ?? '', catalogSourceLabel(it)].map((c) => `<td>${esc(c)}</td>`).join('');
        selectableRow(tr, () => (current = it), () => finish(it));
        body.appendChild(tr);
      }
      if (items.length === 0) body.innerHTML = '<tr><td colspan="7">No matching parts</td></tr>';
      const expired = packRegistry.list().filter((p) => p.verified.ok && p.verified.expired);
      status.textContent = `${items.length} part(s) — ${catalogSourcesSummary()}${expired.length ? ` — expired: ${expired.map((p) => `${p.doc.name} (${p.verified.expires})`).join(', ')}` : ''}${userCatalogSize() || packRegistry.size ? '' : ' (AECATALOGLOAD loads a user catalog; Packs... installs a catalog pack)'}`;
    };
    family.addEventListener('change', render);
    search.addEventListener('input', render);
    render();
    m.body.append(top, wrapScroll(t, 360), status);
    const ok = button('OK', true);
    const packs = button('Packs...');
    packs.title = 'Install or remove signed manufacturer catalog packs (AEPACKS)';
    packs.addEventListener('click', () => {
      void packsDialog(editor).then(() => {
        fillFamilies(family.value);
        render();
      });
    });
    const cancel = button('Cancel');
    ok.addEventListener('click', () => finish(current));
    cancel.addEventListener('click', () => finish(null));
    m.footer.append(ok, packs, cancel);
    search.focus();
    m.root.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && current && (ev.target as HTMLElement).tagName !== 'BUTTON') ok.click();
    });
  });
}

// ---------------------------------------------------------------- Catalog packs

/**
 * Pick a pack file (native dialog on the desktop, <input type=file> in a browser), verify
 * it and install it. Logs the outcome through `editor.log` when an editor is given and
 * returns the installed pack, or null when cancelled / refused.
 */
export async function installPackFromPicker(editor?: Editor): Promise<InstalledPack | null> {
  let picked: { name: string; text: string } | null = null;
  try {
    if (window.jcad?.pickPackFile) picked = await window.jcad.pickPackFile();
    else {
      const r = await browserOpenTextFile('.json,.jcadpack.json');
      picked = r ? { name: r.path, text: r.text } : null;
    }
  } catch (err) {
    editor?.log(`Catalog pack not installed: ${(err as Error).message}`);
    return null;
  }
  if (!picked) return null;
  try {
    const p = await packRegistry.install(picked.text);
    editor?.log(`Catalog pack installed: ${p.doc.name} v${p.doc.version} by ${p.doc.publisher} - ${p.items.length} part(s), licensed to ${p.doc.license.licensee}, ${packStatus(p)}.`);
    if (p.verified.expired) editor?.log(`Warning: the licence of "${p.doc.name}" expired on ${p.verified.expires}. The parts keep working; renew to receive updates.`);
    return p;
  } catch (err) {
    editor?.log(`Catalog pack ${picked.name} refused: ${(err as Error).message}`);
    return null;
  }
}

/** Catalog Browser > Packs...: installed packs (licensee, expiry, part count, status), Install..., Remove. */
export function packsDialog(editor?: Editor): Promise<boolean | null> {
  return dialog<boolean>('Catalog Packs', 860, (m, finish) => {
    const { table: t, body } = table(['Pack', 'Version', 'Publisher', 'Licensed to', 'Expires', 'Parts', 'Status']);
    let current: InstalledPack | null = null;
    const status = document.createElement('div');
    status.className = 'hint';
    const where = document.createElement('div');
    where.className = 'hint';
    const remove = button('Remove');
    const render = () => {
      const list = packRegistry.list();
      body.innerHTML = '';
      current = null;
      remove.disabled = true;
      for (const p of list) {
        const tr = document.createElement('tr');
        const st = packStatus(p);
        tr.innerHTML = [p.doc.name, p.doc.version, p.doc.publisher, p.doc.license.licensee, p.doc.license.expires ?? 'never', String(p.items.length), st].map((c) => `<td>${esc(c)}</td>`).join('');
        if (p.verified.expired) tr.style.color = '#8a5a00';
        selectableRow(
          tr,
          () => {
            current = p;
            remove.disabled = false;
          },
          () => undefined,
        );
        body.appendChild(tr);
      }
      if (list.length === 0) body.innerHTML = '<tr><td colspan="7">No catalog packs installed. Install... adds a signed *.jcadpack.json file issued to you by the publisher.</td></tr>';
      const errs = packRegistry.errors;
      status.textContent = errs.length ? `Not loaded: ${errs.join('; ')}` : `${list.length} pack(s), ${packCatalogSize()} part(s) searched after the user catalog and before the built-in parts.`;
      where.textContent = `Files: ${packRegistry.location ?? 'app data folder, packs/'}. Packs are verified against the publisher key on every start; an edited or unsigned file is refused, an expired one keeps working but is flagged.`;
    };
    render();
    const unsubscribe = packRegistry.onChange(render);
    m.onClose(unsubscribe);
    m.body.append(wrapScroll(t, 300), status, where);
    const install = button('Install...', true);
    install.addEventListener('click', () => {
      install.disabled = true;
      void installPackFromPicker(editor)
        .then((p) => {
          if (p) status.textContent = `Installed ${p.doc.name}: ${p.items.length} part(s), licensed to ${p.doc.license.licensee}, ${packStatus(p)}.`;
          else if (editor) status.textContent = 'Nothing installed (see the command window for the reason).';
        })
        .finally(() => (install.disabled = false));
    });
    remove.disabled = true;
    remove.addEventListener('click', () => {
      const p = current;
      if (!p) return;
      void packRegistry.remove(p.doc.id).then((ok) => {
        if (ok) editor?.log(`Catalog pack removed: ${p.doc.name}.`);
        render();
      });
    });
    const close = button('Close');
    close.addEventListener('click', () => {
      unsubscribe();
      finish(true);
    });
    m.footer.append(install, remove, close);
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

/** Drawing properties plus the project drawing entry's title block values (revision, date). */
export interface DrawingPropertiesResultEx extends DrawingPropertiesResult {
  rev?: string;
  date?: string;
}

export function drawingPropertiesDialog(init: DrawingPropertiesInit): Promise<DrawingPropertiesResultEx | null> {
  return dialog<DrawingPropertiesResultEx>(`Drawing Properties: ${init.fileName}`, 620, (m, finish) => {
    const s = init.settings;
    const sheet = textInput(init.drawing?.sheet ?? s.sheet);
    const desc = textInput(init.drawing?.description ?? s.drawingDescription);
    const dwgno = textInput(init.drawing?.dwgno ?? s.drawingNumber);
    const rev = textInput(init.drawing?.rev ?? '');
    const date = textInput(init.drawing?.date ?? '');
    date.placeholder = '(today)';
    if (!init.drawing) {
      rev.disabled = true;
      date.disabled = true;
      rev.title = date.title = 'Revision and date are stored in the project drawing entry (add the drawing to a project first)';
    }
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
    section('Sheet', field('Sheet number', sheet), field('Drawing number (DWGNO)', dwgno), field('Drawing description (TITLE)', desc), field('Symbol standard', standard), field('Revision (REV)', rev), field('Date (DATE)', date));
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
      finish({ settings, description: settings.drawingDescription, sheet: settings.sheet, dwgno: settings.drawingNumber, rev: rev.value.trim().toUpperCase(), date: date.value.trim() });
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
  return dialog<Project>('Project Properties', 680, (m, finish) => {
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
    // Title block mapping (.wdt text): which project / drawing value goes into which title block attribute.
    const mapHead = document.createElement('div');
    mapHead.className = 'hint';
    mapHead.textContent = 'Title block mapping (AutoCAD Electrical .wdt format, ATTRIBUTE = SOURCE). Sources: LINE1-LINE12, PROJ, PROJDESC, DWGDESC, DWGNO, SHEET, SHEETMAX, DATE, REV, SEC, FILENAME, IEC_PROJ/INST/LOC; A|B = first non-empty, %SHEET% OF %SHEETMAX% = template, "text" = literal. Empty = built-in mapping.';
    const map = document.createElement('textarea');
    map.className = 'input';
    map.spellcheck = false;
    map.style.cssText = 'width:100%;height:120px;font:12px var(--mono, monospace);padding:4px 6px;box-sizing:border-box;resize:vertical';
    map.value = init.titleBlockMap ?? '';
    map.placeholder = DEFAULT_WDT;
    map.addEventListener('keydown', (ev) => ev.stopPropagation());
    const mapBar = document.createElement('div');
    mapBar.style.cssText = 'display:flex;gap:6px;margin-top:4px';
    const imp = button('Import .wdt...');
    imp.addEventListener('click', () => {
      void browserOpenTextFile('.wdt,.txt').then((res) => {
        if (!res) return;
        const parsed = parseWdt(res.text);
        map.value = formatWdt(parsed);
      });
    });
    const exp = button('Export .wdt...');
    exp.addEventListener('click', () => {
      const text = map.value.trim() ? formatWdt(parseWdt(map.value)) : DEFAULT_WDT + '\n';
      const name = `${(name_.value.trim() || 'project').replace(/[^A-Za-z0-9_-]+/g, '_')}.wdt`;
      if (window.jcad?.saveText) void window.jcad.saveText(name, text, 'Title block mapping', 'wdt');
      else browserDownloadText(name, text);
    });
    const def = button('Built-in mapping');
    def.addEventListener('click', () => (map.value = DEFAULT_WDT));
    mapBar.append(imp, exp, def);
    const name_ = name;
    m.body.append(g, h, lines, dl, mapHead, map, mapBar);
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
      finish({ ...init, name: name.value.trim() || init.name, description: desc.value.trim() || undefined, descriptions: lineInputs.map((i) => i.value.trim()), settings, titleBlockMap: map.value.trim() ? map.value : undefined });
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

// ---------------------------------------------------------------- project-wide tools

function browserDownloadText(name: string, text: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** One drawing affected by a project-wide command. */
export interface AffectedDrawing {
  name: string;
  /** 'open' = updated in its tab (undoable, not saved); 'file' = closed drawing written to disk. */
  kind: 'open' | 'file';
  detail: string;
}

export interface ConfirmFilesResult {
  /** Also write the closed drawings. */
  files: boolean;
  /** Write a .bak copy of each closed drawing first. */
  backup: boolean;
}

/**
 * Confirmation for a project-wide change: lists the open drawings (updated
 * in memory) and the closed drawing files that would be rewritten; the
 * files are only written when the user keeps "Save the closed drawings" on.
 */
export function confirmFilesDialog(title: string, intro: string, items: AffectedDrawing[], opts: { backupAvailable: boolean }): Promise<ConfirmFilesResult | null> {
  return dialog<ConfirmFilesResult>(title, 640, (m, finish) => {
    const p = document.createElement('div');
    p.style.marginBottom = '8px';
    p.textContent = intro;
    const { table: t, body } = table(['Drawing', 'Status', 'Changes']);
    for (const it of items) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${esc(it.name)}</td><td>${it.kind === 'open' ? 'open (updated in its tab)' : 'closed file (saved to disk)'}</td><td>${esc(it.detail)}</td>`;
      body.appendChild(tr);
    }
    if (items.length === 0) body.innerHTML = '<tr><td colspan="3">Nothing to change</td></tr>';
    const nFiles = items.filter((i) => i.kind === 'file').length;
    const files = checkbox(`Save the ${nFiles} closed drawing file(s) listed above`, nFiles > 0);
    files.input.disabled = nFiles === 0;
    const bak = checkbox('Write a .bak copy of each file first', opts.backupAvailable);
    bak.input.disabled = !opts.backupAvailable || nFiles === 0;
    if (!opts.backupAvailable) bak.el.title = 'The file bridge of this build cannot copy files; keep your own backup (or use version control) before saving.';
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Open drawings change in their tabs (Undo works, SAVE writes them). Closed drawings are read, updated and saved as DXF only when confirmed here.';
    m.body.append(p, wrapScroll(t, 260), files.el, bak.el, hint);
    const ok = button('Apply', true);
    const cancel = button('Cancel');
    ok.disabled = items.length === 0;
    ok.addEventListener('click', () => finish({ files: files.input.checked && nFiles > 0, backup: bak.input.checked && opts.backupAvailable }));
    cancel.addEventListener('click', () => finish(null));
    m.footer.append(ok, cancel);
  });
}

export interface ReportTableOptions {
  hint?: string;
  saveCsv?: (name: string, csv: string) => Promise<string | null>;
  putOnDrawing?: (r: Report) => void;
  /** Double-click / Go To on a row. */
  onRow?: (rowIndex: number) => void;
  width?: number;
}

/** Show any report in a table with CSV export, put-on-drawing and an optional row action. */
export function reportTableDialog(editor: Editor, r: Report, o: ReportTableOptions = {}): void {
  const m = modal(r.title, o.width ?? 860);
  const { table: t, body } = table(r.columns);
  let current = -1;
  r.rows.forEach((row, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = row.map((c) => `<td>${esc(c)}</td>`).join('');
    selectableRow(tr, () => (current = i), () => o.onRow?.(i));
    body.appendChild(tr);
  });
  if (r.rows.length === 0) body.innerHTML = `<tr><td colspan="${Math.max(1, r.columns.length)}">No data</td></tr>`;
  const status = document.createElement('div');
  status.className = 'hint';
  status.textContent = o.hint ?? `${r.rows.length} row(s)`;
  m.body.append(wrapScroll(t, 400), status);
  if (o.onRow) {
    const go = button('Go To');
    go.className += ' left';
    go.addEventListener('click', () => current >= 0 && o.onRow!(current));
    m.footer.append(go);
  }
  const csv = button('Save as CSV...');
  csv.addEventListener('click', () => {
    const name = `${r.title.replace(/[^A-Za-z0-9]+/g, '_')}.csv`;
    const save = o.saveCsv ?? ((n: string, c: string) => editor.fileBridge?.saveText?.(n, c, 'CSV', 'csv') ?? Promise.resolve((browserDownloadText(n, c), n)));
    void save(name, reportToCsv(r)).then((p) => p && editor.log(`Saved: ${p}`));
  });
  m.footer.append(csv);
  if (o.putOnDrawing) {
    const put = button('Put on Drawing');
    put.addEventListener('click', () => {
      m.close();
      o.putOnDrawing!(r);
    });
    m.footer.append(put);
  }
  const close = button('Close', true);
  close.addEventListener('click', () => m.close());
  m.footer.append(close);
}

// ---------------------------------------------------------------- Location View

export interface LocationViewOptions {
  /** Sheet index of the drawing shown in the editor (rows there can be zoomed to), -1 = none. */
  currentSheet: number;
  zoomTo(row: LocationRow): void;
  saveCsv(name: string, csv: string): Promise<string | null>;
  putOnDrawing(r: Report): void;
  /** Re-read the project (after edits). */
  refresh?(): Promise<LocationGroup[]>;
  scopeLabel: string;
}

/** AELOCVIEW: components grouped by installation / location with counts, a location filter, CSV and zoom-to. */
export function locationViewDialog(editor: Editor, initial: LocationGroup[], o: LocationViewOptions): void {
  const m = modal('Location View', 980);
  let groups = initial;
  let filter = '';
  let showContacts = true;
  let current: LocationRow | null = null;
  const top = document.createElement('div');
  top.style.cssText = 'display:flex;gap:12px;align-items:center;margin-bottom:8px';
  const scope = document.createElement('span');
  scope.className = 'hint';
  scope.style.margin = '0';
  scope.textContent = o.scopeLabel;
  const filterSel = select([['', 'All locations']], '');
  filterSel.style.width = '220px';
  const contacts = checkbox('Show contacts and extra poles', true);
  top.append(field('Location', filterSel), contacts.el, scope);
  const split = document.createElement('div');
  split.style.cssText = 'display:flex;gap:10px;align-items:stretch';
  const tree = document.createElement('div');
  tree.className = 'report-wrap';
  tree.style.cssText = 'width:230px;flex:none;max-height:420px;font-size:12px';
  const right = document.createElement('div');
  right.style.cssText = 'flex:1;min-width:0';
  const { table: t, body } = table(['Tag', 'Type', 'Description', 'Catalog', 'Jumpers', 'Drawing', 'Sheet', 'Rung']);
  right.appendChild(wrapScroll(t, 420));
  split.append(tree, right);
  const status = document.createElement('div');
  status.className = 'hint';
  const renderTree = () => {
    tree.innerHTML = '';
    const total = groups.reduce((s, g) => s + g.devices, 0);
    const mk = (label: string, count: number, value: string, indent = 0) => {
      const d = document.createElement('div');
      d.style.cssText = `padding:3px 6px 3px ${6 + indent * 14}px;cursor:pointer;display:flex;justify-content:space-between;gap:8px;${filter === value ? 'background:#cce4f7' : ''}`;
      d.innerHTML = `<span>${esc(label)}</span><span style="color:#666">${count}</span>`;
      d.addEventListener('click', () => {
        filter = value;
        filterSel.value = value;
        render();
      });
      tree.appendChild(d);
    };
    mk('Project', total, '');
    const insts = [...new Set(groups.map((g) => g.inst))];
    for (const inst of insts) {
      const gs = groups.filter((g) => g.inst === inst);
      if (inst) mk(`+${inst}`, gs.reduce((s, g) => s + g.devices, 0), `+${inst}`, 1);
      for (const g of gs) mk(inst && g.loc ? `-${g.loc}` : g.label, g.devices, g.label, inst ? 2 : 1);
    }
  };
  const visible = (g: LocationGroup) => !filter || g.label === filter || (filter.startsWith('+') && !filter.includes('-', 1) && g.inst === filter.slice(1));
  const render = () => {
    filterSel.innerHTML = '';
    const opts: Array<[string, string]> = [['', 'All locations']];
    for (const inst of [...new Set(groups.filter((g) => g.inst).map((g) => g.inst))]) opts.push([`+${inst}`, `+${inst} (installation)`]);
    for (const g of groups) opts.push([g.label, `${g.label} (${g.devices})`]);
    for (const [v, l] of opts) {
      const op = document.createElement('option');
      op.value = v;
      op.textContent = l;
      if (v === filter) op.selected = true;
      filterSel.appendChild(op);
    }
    renderTree();
    body.innerHTML = '';
    current = null;
    let n = 0;
    for (const g of groups) {
      if (!visible(g)) continue;
      const head = document.createElement('tr');
      head.innerHTML = `<td colspan="8" style="background:#eef3f8;font-weight:600">${esc(g.label)} — ${g.devices} device(s)</td>`;
      body.appendChild(head);
      for (const r of g.rows) {
        if (!showContacts && (r.kind === 'contact' || r.kind === 'pole')) continue;
        n += 1;
        const tr = document.createElement('tr');
        const here = r.sheetIndex === o.currentSheet;
        tr.innerHTML = [r.tag, r.kind, r.description, r.cat, r.jumpers, r.drawing, r.sheet, r.ref].map((c) => `<td>${esc(c)}</td>`).join('');
        if (!here) tr.style.color = '#666';
        tr.title = here ? 'Double-click to zoom to the component' : 'On another drawing (open it to zoom)';
        selectableRow(tr, () => (current = r), () => here && o.zoomTo(r));
        body.appendChild(tr);
      }
    }
    if (n === 0) body.innerHTML = '<tr><td colspan="8">No components</td></tr>';
    status.textContent = `${groups.length} location(s), ${groups.reduce((s, g) => s + g.devices, 0)} device(s); ${n} row(s) shown. Grey rows are on other drawings.`;
  };
  filterSel.addEventListener('change', () => {
    filter = filterSel.value;
    render();
  });
  contacts.input.addEventListener('change', () => {
    showContacts = contacts.input.checked;
    render();
  });
  render();
  m.body.append(top, split, status);
  const rows = () => {
    const r = locationViewReport(groups.filter(visible));
    return showContacts ? r : { ...r, rows: r.rows.filter((x) => x[3] !== 'contact' && x[3] !== 'pole') };
  };
  const zoom = button('Zoom To');
  zoom.className += ' left';
  zoom.addEventListener('click', () => {
    if (current && current.sheetIndex === o.currentSheet) o.zoomTo(current);
    else if (current) editor.log(`${current.tag} is on ${current.drawing}; open that drawing to zoom to it.`);
  });
  const csv = button('Save as CSV...');
  csv.addEventListener('click', () => void o.saveCsv('Location_View.csv', reportToCsv(rows())).then((p) => p && editor.log(`Location View saved: ${p}`)));
  const put = button('Put on Drawing');
  put.addEventListener('click', () => {
    m.close();
    o.putOnDrawing(rows());
  });
  const buttons: HTMLButtonElement[] = [zoom];
  if (o.refresh) {
    const refresh = button('Refresh');
    refresh.addEventListener('click', () => {
      status.textContent = 'Reading the project...';
      void o.refresh!().then((g) => {
        groups = g;
        render();
      });
    });
    buttons.push(refresh);
  }
  const close = button('Close', true);
  close.addEventListener('click', () => m.close());
  m.footer.append(...buttons, csv, put, close);
}

// ---------------------------------------------------------------- PLC I/O import

export interface PlcImportResult {
  rows: PlcIoRow[];
  options: PlcModuleOptions;
}

/** AEPLCIO preview: the parsed rows (editable descriptions), module grouping options, CSV export and Insert. */
export function plcImportDialog(editor: Editor, parsed: PlcImport, init: PlcModuleOptions, saveCsv: (name: string, csv: string) => Promise<string | null>): Promise<PlcImportResult | null> {
  return dialog<PlcImportResult>(`PLC I/O from Spreadsheet: ${parsed.rows.length} point(s)`, 980, (m, finish) => {
    const rows = parsed.rows.map((r) => ({ ...r }));
    const per = textInput(String(init.pointsPerModule), 'number');
    const spacing = textInput(String(init.spacing), 'number');
    const tag = textInput(init.firstTag);
    const rungs = checkbox('Draw a ladder rung with the device symbol for each point that has a device tag', init.rungs);
    const g = grid(3);
    g.append(field('Points per module', per), field('Point spacing', spacing), field('First module tag', tag));
    const { table: t, body } = table(['Line', 'Module', 'Address', 'I/O', 'Description 1', 'Description 2', 'Description 3', 'Wire No.', 'Device']);
    const edit = (r: PlcIoRow, k: 'desc1' | 'desc2' | 'desc3' | 'wire' | 'device', w = 110) => {
      const i = textInput(r[k]);
      i.style.width = `${w}px`;
      i.style.height = '20px';
      i.addEventListener('input', () => (r[k] = i.value));
      i.addEventListener('keydown', (ev) => ev.stopPropagation());
      return i;
    };
    for (const r of rows) {
      const tr = document.createElement('tr');
      const cells: Array<string | HTMLElement> = [String(r.line), r.module, r.address, r.kind === 'output' ? 'Output' : 'Input', edit(r, 'desc1'), edit(r, 'desc2'), edit(r, 'desc3'), edit(r, 'wire', 60), edit(r, 'device', 70)];
      for (const c of cells) {
        const td = document.createElement('td');
        if (typeof c === 'string') td.textContent = c;
        else td.appendChild(c);
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
    if (rows.length === 0) body.innerHTML = '<tr><td colspan="9">No I/O points found</td></tr>';
    const cols = Object.entries(parsed.columns)
      .map(([k, v]) => `${k}=col ${(v ?? 0) + 1}`)
      .join(', ');
    const hint = document.createElement('div');
    hint.className = 'hint';
    const inputs = rows.filter((r) => r.kind === 'input').length;
    hint.textContent = `${inputs} input(s), ${rows.length - inputs} output(s). Columns: ${cols}.${parsed.warnings.length ? ` ${parsed.warnings.slice(0, 3).join(' ')}` : ''} Modules are grouped by the Module column (else by address prefix) and placed side by side.`;
    m.body.append(g, rungs.el, wrapScroll(t, 360), hint);
    const exp = button('Export CSV...');
    exp.className += ' left';
    exp.addEventListener('click', () => void saveCsv('PLC_IO.csv', plcRowsToCsv(rows)).then((p) => p && editor.log(`PLC I/O table saved: ${p}`)));
    const ok = button('Insert Modules', true);
    const cancel = button('Cancel');
    ok.disabled = rows.length === 0;
    ok.addEventListener('click', () =>
      finish({
        rows,
        options: {
          pointsPerModule: Math.max(1, Math.min(64, Math.round(parseFloat(per.value) || init.pointsPerModule))),
          spacing: Math.max(0.25, parseFloat(spacing.value) || init.spacing),
          firstTag: tag.value.trim().toUpperCase() || init.firstTag,
          rungs: rungs.input.checked,
        },
      }),
    );
    cancel.addEventListener('click', () => finish(null));
    m.footer.append(exp, ok, cancel);
  });
}

// ---------------------------------------------------------------- Cable

/** AECABLE: cable tag, type and conductor identification for the picked wires. */
export function cableDialog(init: CableAssignment, wires: number, existing: string[]): Promise<CableAssignment | null> {
  return dialog<CableAssignment>(`Assign ${wires} Wire(s) to a Cable`, 480, (m, finish) => {
    const cable = textInput(init.cable);
    const list = document.createElement('datalist');
    list.id = `cable-list-${Date.now()}`;
    for (const c of existing) {
      const o = document.createElement('option');
      o.value = c;
      list.appendChild(o);
    }
    cable.setAttribute('list', list.id);
    const type = textInput(init.type);
    type.placeholder = 'e.g. 4G1.5 or 7C #16 AWG';
    const scheme = select(CONDUCTOR_SCHEMES.map((s): [string, string] => [s.key, s.name]), init.scheme);
    const first = textInput(String(init.first), 'number');
    const g = grid(2);
    g.append(field('Cable tag (CABLENO)', cable), field('Cable type', type), field('Conductor identification', scheme), field('First conductor number', first));
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Each picked wire gets a cable marker with the next free conductor in pick order; wires already in a cable are moved to this one. The Cable Schedule report (AEREPORT cables) lists the conductors with their from / to terminals.';
    m.body.append(g, list, hint);
    const ok = button('OK', true);
    const cancel = button('Cancel');
    ok.addEventListener('click', () => finish({ cable: cable.value.trim().toUpperCase() || init.cable, type: type.value.trim(), scheme: scheme.value, first: Math.max(0, Math.round(parseFloat(first.value) || init.first)) }));
    cancel.addEventListener('click', () => finish(null));
    m.footer.append(ok, cancel);
    cable.focus();
    cable.select();
    m.root.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.target as HTMLElement).tagName !== 'SELECT') ok.click();
    });
  });
}

// ---------------------------------------------------------------- Report templates

export interface ReportTemplatesOptions {
  templates: ReportTemplate[];
  /** Columns of a report (built on the current drawing). */
  columnsOf(key: string): string[];
  run(t: ReportTemplate): void;
  /** Save the edited template list into the project. */
  save(list: ReportTemplate[]): void;
  projectAvailable: boolean;
}

/** Create / edit / delete / run report templates (stored in the project file). */
export function reportTemplatesDialog(o: ReportTemplatesOptions): void {
  const m = modal('Report Templates', 900);
  let list = o.templates.map((t) => ({ ...t }));
  let cur: ReportTemplate = list[0] ? { ...list[0] } : { name: 'NEW REPORT', report: REPORTS[0]!.key, output: 'view' };
  const split = document.createElement('div');
  split.style.cssText = 'display:flex;gap:12px;align-items:flex-start';
  const left = document.createElement('div');
  left.className = 'report-wrap';
  left.style.cssText = 'width:220px;flex:none;max-height:430px;font-size:12px';
  const right = document.createElement('div');
  right.style.cssText = 'flex:1;min-width:0';
  split.append(left, right);
  m.body.appendChild(split);
  const status = document.createElement('div');
  status.className = 'hint';
  m.body.appendChild(status);
  const renderList = () => {
    left.innerHTML = '';
    for (const t of list) {
      const d = document.createElement('div');
      d.style.cssText = `padding:4px 8px;cursor:pointer;${t.name === cur.name ? 'background:#cce4f7' : ''}`;
      d.innerHTML = `<div>${esc(t.name)}</div><div style="color:#666;font-size:11px">${esc(describeTemplate(t))}</div>`;
      d.addEventListener('click', () => {
        cur = { ...t };
        renderAll();
      });
      d.addEventListener('dblclick', () => o.run(t));
      left.appendChild(d);
    }
    if (list.length === 0) left.innerHTML = '<div style="padding:6px;color:#666">No templates yet: fill in the form and click Save.</div>';
  };
  const renderForm = () => {
    right.innerHTML = '';
    const name = textInput(cur.name);
    const title = textInput(cur.title ?? '');
    title.placeholder = '(report title)';
    const rep = select(REPORTS.map((r): [string, string] => [r.key, r.name]), cur.report);
    const output = select([['view', 'Show in a dialog'], ['table', 'Place on the drawing as a table'], ['csv', 'Write a CSV file']], cur.output ?? 'view');
    const scope = checkbox('Project-wide (all drawings)', !!cur.projectWide);
    scope.input.disabled = !o.projectAvailable;
    const g = grid(2);
    g.append(field('Template name (AEREPORTRUN <name>)', name), field('Report', rep), field('Title', title), field('Output', output));
    const cols = o.columnsOf(cur.report);
    const allCols = cur.projectWide ? ['Drawing', ...cols] : cols;
    // Columns: checkboxes in the chosen order, with up / down.
    const chosen = (cur.columns?.length ? cur.columns.filter((c) => allCols.includes(c)) : [...allCols]).slice();
    const colBox = document.createElement('div');
    colBox.className = 'report-wrap';
    colBox.style.cssText = 'max-height:170px;padding:4px;font-size:12px';
    const renderCols = () => {
      colBox.innerHTML = '';
      const ordered = [...chosen, ...allCols.filter((c) => !chosen.includes(c))];
      for (const c of ordered) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:6px';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = chosen.includes(c);
        cb.addEventListener('change', () => {
          if (cb.checked) chosen.push(c);
          else chosen.splice(chosen.indexOf(c), 1);
          renderCols();
        });
        const up = document.createElement('button');
        up.className = 'btn';
        up.textContent = '▲';
        up.style.cssText = 'padding:0 5px;min-width:0;height:18px';
        up.disabled = !cb.checked || chosen.indexOf(c) === 0;
        up.addEventListener('click', () => {
          const i = chosen.indexOf(c);
          chosen.splice(i, 1);
          chosen.splice(i - 1, 0, c);
          renderCols();
        });
        const lbl = document.createElement('span');
        lbl.textContent = c;
        row.append(cb, up, lbl);
        colBox.appendChild(row);
      }
    };
    renderCols();
    const sortCol = select([['', '(report order)'], ...allCols.map((c): [string, string] => [c, c])], cur.sort?.[0]?.column ?? '');
    const sortDesc = checkbox('Descending', !!cur.sort?.[0]?.desc);
    const sort2 = select([['', '(none)'], ...allCols.map((c): [string, string] => [c, c])], cur.sort?.[1]?.column ?? '');
    const filters = (cur.filters ?? []).map((f) => ({ ...f }));
    const fBox = document.createElement('div');
    const renderFilters = () => {
      fBox.innerHTML = '';
      filters.forEach((f, i) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:6px;margin-bottom:4px';
        const c = select(allCols.map((x): [string, string] => [x, x]), f.column);
        c.addEventListener('change', () => (f.column = c.value));
        const op = select(FILTER_OPS.map((x): [string, string] => [x.op, x.label]), f.op);
        op.addEventListener('change', () => (f.op = op.value as ReportFilter['op']));
        const v = textInput(f.value ?? '');
        v.addEventListener('input', () => (f.value = v.value));
        const del = button('Remove');
        del.addEventListener('click', () => {
          filters.splice(i, 1);
          renderFilters();
        });
        row.append(c, op, v, del);
        fBox.appendChild(row);
      });
      const add = button('Add filter');
      add.addEventListener('click', () => {
        filters.push({ column: allCols[0] ?? '', op: 'contains', value: '' });
        renderFilters();
      });
      fBox.appendChild(add);
    };
    renderFilters();
    const sg = grid(3);
    sg.append(field('Sort by', sortCol), field('Then by', sort2), sortDesc.el);
    const colsHead = document.createElement('div');
    colsHead.className = 'hint';
    colsHead.textContent = 'Columns (checked ones are output, in this order):';
    const fHead = document.createElement('div');
    fHead.className = 'hint';
    fHead.textContent = 'Filters (a row must pass all of them):';
    right.append(g, scope.el, colsHead, colBox, sg, fHead, fBox);
    const read = (): ReportTemplate => {
      const sort: NonNullable<ReportTemplate['sort']> = [];
      if (sortCol.value) sort.push({ column: sortCol.value, ...(sortDesc.input.checked ? { desc: true } : {}) });
      if (sort2.value) sort.push({ column: sort2.value });
      const t: ReportTemplate = { name: name.value.trim() || 'REPORT', report: rep.value };
      if (title.value.trim()) t.title = title.value.trim();
      if (chosen.length && chosen.length !== allCols.length) t.columns = [...chosen];
      else if (chosen.length && chosen.some((c, i) => allCols[i] !== c)) t.columns = [...chosen];
      if (sort.length) t.sort = sort;
      const fl = filters.filter((f) => f.column);
      if (fl.length) t.filters = fl;
      if (output.value !== 'view') t.output = output.value as ReportTemplate['output'];
      if (scope.input.checked) t.projectWide = true;
      return t;
    };
    rep.addEventListener('change', () => {
      cur = { ...read(), report: rep.value, columns: undefined, sort: undefined, filters: undefined };
      renderForm();
    });
    scope.input.addEventListener('change', () => {
      cur = { ...read(), projectWide: scope.input.checked || undefined, columns: undefined };
      renderForm();
    });
    readForm = read;
  };
  let readForm: () => ReportTemplate = () => cur;
  const renderAll = () => {
    renderList();
    renderForm();
    status.textContent = `${list.length} template(s) in the project. PROJECTSAVE writes them to the project file.`;
  };
  renderAll();
  const newBtn = button('New');
  newBtn.className += ' left';
  newBtn.addEventListener('click', () => {
    cur = { name: `REPORT ${list.length + 1}`, report: cur.report, output: 'view' };
    renderForm();
  });
  const save = button('Save');
  save.addEventListener('click', () => {
    const t = readForm();
    list = [...list.filter((x) => x.name.toLowerCase() !== t.name.toLowerCase()), t].sort((a, b) => a.name.localeCompare(b.name));
    cur = t;
    o.save(list);
    renderAll();
  });
  const del = button('Delete');
  del.addEventListener('click', () => {
    list = list.filter((x) => x.name.toLowerCase() !== cur.name.toLowerCase());
    o.save(list);
    cur = list[0] ? { ...list[0] } : { name: 'NEW REPORT', report: REPORTS[0]!.key, output: 'view' };
    renderAll();
  });
  const run = button('Run', true);
  run.addEventListener('click', () => {
    const t = readForm();
    m.close();
    o.run(t);
  });
  const close = button('Close');
  close.addEventListener('click', () => m.close());
  m.footer.append(newBtn, save, del, run, close);
}

// ---------------------------------------------------------------- file picker (browser fallback)

export function browserOpenTextFile(accept: string): Promise<{ path: string; text: string } | null> {
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
    editComponent: (init) => componentDialog(editor, init, (family, type) => catalogBrowserDialog({ family, type }, editor)),
    catalogBrowser: (init) => catalogBrowserDialog(init, editor),
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
      if (editor.fileBridge?.openProject && window.jcad) {
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
