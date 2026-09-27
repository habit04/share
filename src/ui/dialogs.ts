import type { Editor } from '../app/editor';
import type { LadderSettings } from '../tools/types';
import { SYMBOL_CATEGORIES, findSymbol } from '../electrical/symbols';
import { IEC_CATEGORIES, IEC_SYMBOLS } from '../electrical/iec';
import type { Report } from '../electrical/reports';
import { REPORTS, reportToCsv } from '../electrical/reports';
import { SHEET_SIZES, TITLE_BLOCK } from '../electrical/templates';
import type { SheetSize } from '../electrical/templates';
import type { PlcModuleSettings, TerminalStripSettings } from '../tools/plc';
import { WIRE_TYPES } from '../tools/plc';
import { drawPreview } from '../render/draw';
import { aciToCss, ACI_NAMES } from '../render/palette';
import { icon } from './icons';
import { esc } from './dom';

function modal(title: string, width = 520, theme: 'light' | 'dark' = 'light'): { root: HTMLElement; body: HTMLElement; footer: HTMLElement; close: () => void; onClose: (fn: () => void) => void } {
  const root = document.createElement('div');
  root.className = 'modal-backdrop';
  const dlg = document.createElement('div');
  dlg.className = `modal ${theme}`;
  dlg.style.width = `${width}px`;
  const head = document.createElement('div');
  head.className = 'modal-title';
  head.innerHTML = `<span>${title}</span><button class="modal-close" title="Close">${icon('close')}</button>`;
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
  return i;
}

/** Insert Component icon menu: categories on the left, symbol previews on the right. */
export function findAnySymbol(name: string) {
  return findSymbol(name) ?? IEC_SYMBOLS.find((s) => s.name === name);
}

export function pickSymbolDialog(editor: Editor, standard: 'JIC' | 'IEC' = 'JIC', onStandard?: (s: 'JIC' | 'IEC') => void): Promise<string | null> {
  return new Promise((resolve) => {
    const m = modal(`Insert Component: ${standard} Schematic Symbols`, 760);
    const categories = () => (standard === 'IEC' ? IEC_CATEGORIES : SYMBOL_CATEGORIES);
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    m.onClose(() => finish(null));

    const wrap = document.createElement('div');
    wrap.className = 'iconmenu';
    const cats = document.createElement('div');
    cats.className = 'iconmenu-cats';
    const grid = document.createElement('div');
    grid.className = 'iconmenu-grid';
    wrap.append(cats, grid);
    m.body.appendChild(wrap);

    let active = 0;
    const renderGrid = () => {
      grid.innerHTML = '';
      const cat = categories()[active]!;
      for (const s of cat.symbols) {
        const cell = document.createElement('button');
        cell.className = 'iconmenu-cell';
        const canvas = document.createElement('canvas');
        canvas.width = 76;
        canvas.height = 56;
        const ctx = canvas.getContext('2d')!;
        drawPreview(ctx, s.entities, editor.doc.layers, editor.doc.lookupBlock, 76, 56, '#202020', 8);
        const label = document.createElement('span');
        label.textContent = s.description ?? s.name;
        cell.append(canvas, label);
        cell.title = s.name;
        cell.addEventListener('click', () => finish(s.name));
        grid.appendChild(cell);
      }
    };
    const renderCats = () => {
      cats.innerHTML = '';
      categories().forEach((c, i) => {
        const b = document.createElement('button');
        b.className = 'iconmenu-cat' + (i === active ? ' active' : '');
        b.textContent = c.name;
        b.addEventListener('click', () => {
          active = i;
          renderCats();
          renderGrid();
        });
        cats.appendChild(b);
      });
    };
    renderCats();
    renderGrid();

    const options = document.createElement('div');
    options.className = 'iconmenu-options';
    options.innerHTML = `<label><input type="radio" name="orient" value="h" checked> Horizontal</label><label><input type="radio" name="orient" value="v"> Vertical</label><label>Scale schematic: <input class="input small" value="1.000"></label><label>Type it: <input class="input typeit" placeholder="block name"></label>`;
    const typeIt = options.querySelector('.typeit') as HTMLInputElement;
    typeIt.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && typeIt.value.trim()) finish(typeIt.value.trim().toUpperCase());
      ev.stopPropagation();
    });
    m.body.appendChild(options);
    const std = button(standard === 'JIC' ? 'Switch to IEC' : 'Switch to JIC');
    std.className += ' left';
    std.addEventListener('click', () => {
      const next = standard === 'JIC' ? 'IEC' : 'JIC';
      onStandard?.(next);
      // Close this dialog without settling the promise; the replacement dialog's choice resolves it.
      done = true;
      m.close();
      void pickSymbolDialog(editor, next, onStandard).then(resolve);
    });
    const cancel = button('Cancel');
    cancel.addEventListener('click', () => finish(null));
    m.footer.append(std, cancel);
  });
}

/** Insert / Edit Component dialog (tag, description). */
export function editComponentDialog(
  editor: Editor,
  init: { tag: string; desc: string; block: string; mfg?: string; cat?: string },
): Promise<{ tag: string; desc: string; mfg: string; cat: string } | null> {
  return new Promise((resolve) => {
    const m = modal('Insert / Edit Component', 640);
    let done = false;
    const finish = (v: { tag: string; desc: string; mfg: string; cat: string } | null) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    m.onClose(() => finish(null));

    const sym = findAnySymbol(init.block);
    const preview = document.createElement('canvas');
    preview.width = 150;
    preview.height = 96;
    preview.className = 'component-preview';
    if (sym) drawPreview(preview.getContext('2d')!, sym.entities, editor.doc.layers, editor.doc.lookupBlock, 150, 96, '#202020', 12);
    const previewBox = document.createElement('div');
    previewBox.className = 'component-preview-box';
    const blockLabel = document.createElement('div');
    blockLabel.className = 'hint';
    blockLabel.textContent = `${init.block}${sym?.description ? ` — ${sym.description}` : ''}`;
    previewBox.append(preview, blockLabel);

    const group = (legend: string, ...rows: HTMLElement[]) => {
      const fs = document.createElement('fieldset');
      const lg = document.createElement('legend');
      lg.textContent = legend;
      fs.append(lg, ...rows);
      return fs;
    };
    const tag = textInput(init.tag);
    const fixed = document.createElement('label');
    fixed.className = 'radio-row';
    fixed.innerHTML = '<input type="checkbox"> fixed';
    const descLines = (init.desc ?? '').split('\n');
    const desc1 = textInput(descLines[0] ?? '');
    desc1.placeholder = 'Line 1, e.g. START MOTOR';
    const desc2 = textInput(descLines[1] ?? '');
    desc2.placeholder = 'Line 2';
    const desc3 = textInput(descLines[2] ?? '');
    desc3.placeholder = 'Line 3';
    const mfg = textInput(init.mfg ?? '');
    mfg.placeholder = 'Manufacturer';
    const cat = textInput(init.cat ?? '');
    cat.placeholder = 'Catalog number';
    const assy = textInput('');
    assy.placeholder = 'Assembly code';

    const left = document.createElement('div');
    left.className = 'component-col';
    left.append(group('Component Tag', field('Tag', tag), fixed), group('Description', field('Line 1', desc1), field('Line 2', desc2), field('Line 3', desc3)));
    const right = document.createElement('div');
    right.className = 'component-col';
    right.append(previewBox, group('Catalog Data', field('Manufacturer', mfg), field('Catalog', cat), field('Assembly', assy)));
    const row = document.createElement('div');
    row.className = 'component-row';
    row.append(left, right);
    m.body.appendChild(row);

    const ok = button('OK', true);
    const cancel = button('Cancel');
    ok.addEventListener('click', () =>
      finish({
        tag: tag.value.trim().toUpperCase(),
        desc: [desc1.value, desc2.value, desc3.value].map((v) => v.trim().toUpperCase()).filter(Boolean).join('\n'),
        mfg: mfg.value.trim().toUpperCase(),
        cat: cat.value.trim().toUpperCase(),
      }),
    );
    cancel.addEventListener('click', () => finish(null));
    m.footer.append(ok, cancel);
    tag.focus();
    tag.select();
    m.root.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.target as HTMLElement).tagName !== 'BUTTON') ok.click();
    });
  });
}

/** Insert Ladder dialog. */
export function ladderDialog(init: LadderSettings): Promise<LadderSettings | null> {
  return new Promise((resolve) => {
    const m = modal('Insert Ladder', 420);
    let done = false;
    const finish = (v: LadderSettings | null) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    m.onClose(() => finish(null));
    const width = textInput(String(init.width), 'number');
    const spacing = textInput(String(init.spacing), 'number');
    const rungs = textInput(String(init.rungs), 'number');
    const first = textInput(String(init.firstReference), 'number');
    const step = textInput(String(init.referenceStep), 'number');
    const phaseWrap = document.createElement('div');
    phaseWrap.className = 'radio-row';
    phaseWrap.innerHTML = `<label><input type="radio" name="phase" value="1" ${init.threePhase ? '' : 'checked'}> 1 Phase</label><label><input type="radio" name="phase" value="3" ${init.threePhase ? 'checked' : ''}> 3 Phase</label>`;
    const rungsWrap = document.createElement('div');
    rungsWrap.className = 'radio-row';
    rungsWrap.innerHTML = `<label><input type="checkbox" id="ladder-draw-rungs" ${init.drawRungs === false ? '' : 'checked'}> Draw rungs</label>`;
    const grid = document.createElement('div');
    grid.className = 'form-grid';
    grid.append(field('Width', width), field('Spacing', spacing), field('Rungs', rungs), field('1st Reference', first), field('Index', step), field('Phase', phaseWrap), field('Rung lines', rungsWrap));
    m.body.appendChild(grid);
    const ok = button('OK', true);
    const cancel = button('Cancel');
    ok.addEventListener('click', () => {
      const s: LadderSettings = {
        width: Math.max(0.5, parseFloat(width.value) || init.width),
        spacing: Math.max(0.1, parseFloat(spacing.value) || init.spacing),
        rungs: Math.max(1, Math.min(200, Math.round(parseFloat(rungs.value) || init.rungs))),
        firstReference: Math.round(parseFloat(first.value) || init.firstReference),
        referenceStep: Math.max(1, Math.round(parseFloat(step.value) || init.referenceStep)),
        threePhase: (phaseWrap.querySelector('input[name=phase]:checked') as HTMLInputElement | null)?.value === '3',
        drawRungs: (rungsWrap.querySelector('#ladder-draw-rungs') as HTMLInputElement).checked,
      };
      finish(s);
    });
    cancel.addEventListener('click', () => finish(null));
    m.footer.append(ok, cancel);
    width.focus();
    m.root.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') ok.click();
      if (ev.key === 'Escape') cancel.click();
    });
  });
}

/** Generic single text input. */
export function textInputDialog(title: string, label: string, init: string): Promise<string | null> {
  return new Promise((resolve) => {
    const m = modal(title, 380);
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    m.onClose(() => finish(null));
    const input = textInput(init);
    m.body.appendChild(field(label, input));
    const ok = button('OK', true);
    const cancel = button('Cancel');
    ok.addEventListener('click', () => finish(input.value));
    cancel.addEventListener('click', () => finish(null));
    m.footer.append(ok, cancel);
    input.focus();
    m.root.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') ok.click();
      if (ev.key === 'Escape') cancel.click();
    });
  });
}

/** Layer Properties Manager (dark palette like AutoCAD's). */
export function layerDialog(editor: Editor): void {
  const m = modal('Layer Properties Manager', 760, 'dark');
  const table = document.createElement('table');
  table.className = 'layer-table';
  const colourName = (c: number) => (ACI_NAMES[c] ?? String(c)).toLowerCase();
  const render = () => {
    table.innerHTML = `<thead><tr><th>S</th><th>Name</th><th>On</th><th>Freeze</th><th>Lock</th><th>Plot</th><th>Color</th><th>Linetype</th><th>Lineweight</th><th>Transparency</th></tr></thead>`;
    const tb = document.createElement('tbody');
    for (const l of editor.doc.layers) {
      const tr = document.createElement('tr');
      const isCurrent = l.name === editor.doc.currentLayer;
      tr.className = isCurrent ? 'current' : '';
      tr.innerHTML = `
        <td class="cur">${isCurrent ? icon('check') : ''}</td>
        <td class="name">${esc(l.name)}</td>
        <td class="tog on-${l.visible}">${icon('bulb')}</td>
        <td class="tog freeze-false">${icon('freeze')}</td>
        <td class="tog lock-${l.locked}">${icon('lock')}</td>
        <td class="tog plot-true">${icon('plot')}</td>
        <td class="color"><span class="swatch" style="background:${aciToCss(l.color)}"></span>${colourName(l.color)}</td>
        <td>Continuous</td>
        <td>${Math.abs(l.lineWeight - 0.25) < 1e-9 ? 'Default' : `${l.lineWeight.toFixed(2)} mm`}</td>
        <td>0</td>`;
      tr.querySelector('.name')!.addEventListener('dblclick', () => {
        editor.doc.setCurrentLayer(l.name);
        render();
      });
      tr.querySelector('.cur')!.addEventListener('click', () => {
        editor.doc.setCurrentLayer(l.name);
        render();
      });
      const togs = tr.querySelectorAll('.tog');
      togs[0]!.addEventListener('click', () => {
        editor.doc.updateLayer(l.name, { visible: !l.visible });
        render();
      });
      togs[2]!.addEventListener('click', () => {
        editor.doc.updateLayer(l.name, { locked: !l.locked });
        render();
      });
      status.textContent = `All: ${editor.doc.layers.length} layers displayed of ${editor.doc.layers.length} total layers`;
      tr.querySelector('.color')!.addEventListener('click', () => {
        const next = ((l.color % 9) + 1) as number;
        editor.doc.updateLayer(l.name, { color: next });
        render();
      });
      tb.appendChild(tr);
    }
    table.appendChild(tb);
  };
  render();
  const status = document.createElement('div');
  status.className = 'hint';
  status.textContent = `All: ${editor.doc.layers.length} layers displayed of ${editor.doc.layers.length} total layers`;
  const toolbar = document.createElement('div');
  toolbar.className = 'layer-toolbar';
  const name = textInput('');
  name.placeholder = 'Search for layer';
  name.className += ' layer-search';
  const tool = (ic: string, title: string, fn: () => void) => {
    const b = document.createElement('button');
    b.className = 'palette-tool';
    b.innerHTML = icon(ic);
    b.title = title;
    b.addEventListener('click', fn);
    return b;
  };
  toolbar.append(
    tool('plus', 'New Layer', () => {
      let n = 1;
      while (editor.doc.layer(`LAYER${n}`)) n += 1;
      editor.doc.addLayer({ name: `LAYER${n}`, color: 7, visible: true, locked: false, lineWeight: 0.25 });
      render();
    }),
    tool('erase', 'Delete selected (current) layer if unused', () => {
      const cur = editor.doc.currentLayer;
      if (cur === '0' || editor.doc.entities.some((e) => e.layer === cur)) {
        status.textContent = `Layer ${cur} cannot be deleted (in use or layer 0).`;
        return;
      }
      editor.doc.transact((s) => ({ ...s, layers: s.layers.filter((l) => l.name !== cur), currentLayer: '0' }));
      render();
    }),
    tool('check', 'Set Current (double-click a name)', () => {}),
    name,
  );
  name.addEventListener('input', () => {
    const q = name.value.trim().toUpperCase();
    table.querySelectorAll<HTMLTableRowElement>('tbody tr').forEach((tr) => {
      tr.style.display = !q || tr.querySelector('.name')!.textContent!.toUpperCase().includes(q) ? '' : 'none';
    });
  });
  m.body.append(toolbar, table, status);
  const close = button('Close', true);
  close.addEventListener('click', () => m.close());
  m.footer.append(close);
}

/** Yes / No confirmation. */
export function confirmDialog(title: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const m = modal(title, 420);
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    m.onClose(() => finish(false));
    const p = document.createElement('p');
    p.textContent = message;
    m.body.appendChild(p);
    const yes = button('Yes', true);
    const no = button('No');
    yes.addEventListener('click', () => finish(true));
    no.addEventListener('click', () => finish(false));
    m.footer.append(yes, no);
    yes.focus();
    m.root.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') yes.click();
    });
  });
}

/** Reports dialog with tabs and CSV export. */
export function reportsDialog(editor: Editor, initialKey = 'bom', saveCsv: (name: string, csv: string) => Promise<string | null>): void {
  const m = modal('Schematic Reports', 860);
  const tabs = document.createElement('div');
  tabs.className = 'report-tabs';
  const wrap = document.createElement('div');
  wrap.className = 'report-wrap';
  let current: Report = REPORTS.find((r) => r.key === initialKey)!.build(editor.doc);
  const render = (key: string) => {
    tabs.innerHTML = '';
    for (const r of REPORTS) {
      const b = document.createElement('button');
      b.className = 'report-tab' + (r.key === key ? ' active' : '');
      b.textContent = r.name;
      b.addEventListener('click', () => render(r.key));
      tabs.appendChild(b);
    }
    current = REPORTS.find((r) => r.key === key)!.build(editor.doc);
    const table = document.createElement('table');
    table.className = 'report-table';
    table.innerHTML = `<thead><tr>${current.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>`;
    const tb = document.createElement('tbody');
    for (const row of current.rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = row.map((c) => `<td>${esc(c)}</td>`).join('');
      tb.appendChild(tr);
    }
    if (current.rows.length === 0) tb.innerHTML = '<tr><td colspan="9">No data</td></tr>';
    table.appendChild(tb);
    wrap.innerHTML = '';
    wrap.appendChild(table);
  };
  render(initialKey);
  m.body.append(tabs, wrap);
  const put = button('Put on Drawing');
  put.className += ' left';
  put.disabled = true;
  put.title = 'Not available yet';
  const exp = button('Save to File...');
  exp.className += ' left';
  exp.addEventListener('click', () => {
    void saveCsv(`${current.title.replace(/[^A-Za-z0-9]+/g, '_')}.csv`, reportToCsv(current)).then((p) => {
      if (p) editor.log(`Report saved: ${p}`);
    });
  });
  const print = button('Print');
  print.className += ' left';
  print.disabled = true;
  const close = button('Close', true);
  close.addEventListener('click', () => m.close());
  m.footer.append(put, exp, print, close);
}

/** New drawing from a sheet template. */
export function templateDialog(): Promise<{ size: SheetSize; fields: Record<string, string> } | null> {
  return new Promise((resolve) => {
    const m = modal('New Drawing from Template', 520);
    let done = false;
    const finish = (v: { size: SheetSize; fields: Record<string, string> } | null) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    m.onClose(() => finish(null));
    const list = document.createElement('div');
    list.className = 'template-list';
    SHEET_SIZES.forEach((sz, i) => {
      const l = document.createElement('label');
      l.innerHTML = `<input type="radio" name="sheet" value="${sz.key}" ${i === 1 ? 'checked' : ''}> ${esc(sz.name)}`;
      list.appendChild(l);
    });
    const grid = document.createElement('div');
    grid.className = 'form-grid';
    const inputs = new Map<string, HTMLInputElement>();
    for (const a of TITLE_BLOCK.attributes) {
      const i = textInput(a.tag === 'DATE' ? new Date().toISOString().slice(0, 10) : a.default);
      inputs.set(a.tag, i);
      grid.appendChild(field(a.prompt, i));
    }
    m.body.append(list, grid);
    const ok = button('OK', true);
    const cancel = button('Cancel');
    ok.addEventListener('click', () => {
      const key = (list.querySelector('input[name=sheet]:checked') as HTMLInputElement | null)?.value ?? 'B';
      const size = SHEET_SIZES.find((sz) => sz.key === key) ?? SHEET_SIZES[1]!;
      const fields: Record<string, string> = {};
      for (const [k, i] of inputs) fields[k] = i.value.trim();
      finish({ size, fields });
    });
    cancel.addEventListener('click', () => finish(null));
    m.footer.append(ok, cancel);
    m.root.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') ok.click();
    });
  });
}

/** PLC module parameters. */
export function plcDialog(init: PlcModuleSettings): Promise<PlcModuleSettings | null> {
  return new Promise((resolve) => {
    const m = modal('Insert PLC Module', 460);
    let done = false;
    const finish = (v: PlcModuleSettings | null) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    m.onClose(() => finish(null));
    const tag = textInput(init.tag);
    const kind = document.createElement('select');
    kind.className = 'input';
    kind.innerHTML = `<option value="input" ${init.kind === 'input' ? 'selected' : ''}>Digital input</option><option value="output" ${init.kind === 'output' ? 'selected' : ''}>Digital output</option>`;
    const points = textInput(String(init.points), 'number');
    const prefix = textInput(init.addressPrefix);
    const first = textInput(String(init.firstAddress), 'number');
    const spacing = textInput(String(init.spacing), 'number');
    const desc = textInput(init.description);
    const grid = document.createElement('div');
    grid.className = 'form-grid';
    grid.append(field('Module tag', tag), field('Type', kind), field('I/O points', points), field('Address prefix', prefix), field('First address', first), field('Point spacing', spacing), field('Description', desc));
    m.body.appendChild(grid);
    const ok = button('OK', true);
    const cancel = button('Cancel');
    ok.addEventListener('click', () =>
      finish({
        tag: tag.value.trim().toUpperCase() || init.tag,
        kind: kind.value === 'output' ? 'output' : 'input',
        points: Math.max(1, Math.min(64, Math.round(parseFloat(points.value) || init.points))),
        addressPrefix: prefix.value,
        firstAddress: Math.max(0, Math.round(parseFloat(first.value) || 0)),
        spacing: Math.max(0.25, parseFloat(spacing.value) || init.spacing),
        description: desc.value.trim().toUpperCase(),
      }),
    );
    cancel.addEventListener('click', () => finish(null));
    m.footer.append(ok, cancel);
    tag.focus();
    m.root.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') ok.click();
    });
  });
}

/** Terminal strip parameters. */
export function terminalStripDialog(init: TerminalStripSettings): Promise<TerminalStripSettings | null> {
  return new Promise((resolve) => {
    const m = modal('Insert Terminal Strip', 400);
    let done = false;
    const finish = (v: TerminalStripSettings | null) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    m.onClose(() => finish(null));
    const tag = textInput(init.tag);
    const count = textInput(String(init.count), 'number');
    const first = textInput(String(init.firstNumber), 'number');
    const pitch = textInput(String(init.pitch), 'number');
    const grid = document.createElement('div');
    grid.className = 'form-grid';
    grid.append(field('Strip tag', tag), field('Terminals', count), field('First number', first), field('Pitch', pitch));
    m.body.appendChild(grid);
    const ok = button('OK', true);
    const cancel = button('Cancel');
    ok.addEventListener('click', () =>
      finish({
        tag: tag.value.trim().toUpperCase() || init.tag,
        count: Math.max(1, Math.min(200, Math.round(parseFloat(count.value) || init.count))),
        firstNumber: Math.round(parseFloat(first.value) || 1),
        pitch: Math.max(0.1, parseFloat(pitch.value) || init.pitch),
      }),
    );
    cancel.addEventListener('click', () => finish(null));
    m.footer.append(ok, cancel);
    m.root.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') ok.click();
    });
  });
}

/** Wire type picker (Set/Edit Wire Type): returns the layer to draw wires on. */
export function wireTypeDialog(editor: Editor, current: string): Promise<string | null> {
  return new Promise((resolve) => {
    const m = modal('Set/Edit Wire Type', 560);
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    m.onClose(() => finish(null));
    let selected = current;
    const wrap = document.createElement('div');
    wrap.className = 'report-wrap';
    const table = document.createElement('table');
    table.className = 'report-table selectable';
    const render = () => {
      table.innerHTML = '<thead><tr><th>Used</th><th>Wire Color</th><th>Size</th><th>Layer Name</th><th>Description</th></tr></thead>';
      const tb = document.createElement('tbody');
      for (const t of WIRE_TYPES) {
        const used = editor.doc.entities.some((e) => e.type === 'line' && e.layer === t.layer);
        const [color, size] = t.description.split(',').map((x) => x.trim());
        const tr = document.createElement('tr');
        tr.className = t.layer === selected ? 'active' : '';
        tr.innerHTML = `<td>${used ? 'x' : ''}</td><td><span class="swatch" style="display:inline-block;width:12px;height:12px;border:1px solid #555;vertical-align:middle;margin-right:6px;background:${aciToCss(t.color)}"></span>${esc(color ?? '')}</td><td>${esc(size ?? '')}</td><td>${esc(t.layer)}</td><td>${esc(t.description)}</td>`;
        tr.addEventListener('click', () => {
          selected = t.layer;
          render();
        });
        tr.addEventListener('dblclick', () => ok.click());
        tb.appendChild(tr);
      }
      table.appendChild(tb);
    };
    const ok = button('OK', true);
    render();
    wrap.appendChild(table);
    m.body.appendChild(wrap);
    const cancel = button('Cancel');
    ok.addEventListener('click', () => {
      const t = WIRE_TYPES.find((x) => x.layer === selected);
      if (t && !editor.doc.layer(t.layer)) editor.doc.addLayer({ name: t.layer, color: t.color, visible: true, locked: false, lineWeight: 0.35 });
      finish(selected);
    });
    cancel.addEventListener('click', () => finish(null));
    m.footer.append(ok, cancel);
  });
}

/** Save changes? Save / Don't Save / Cancel (default Save). */
export function saveChangesDialog(fileName: string): Promise<'save' | 'discard' | 'cancel'> {
  return new Promise((resolve) => {
    const m = modal('JCad Electrical', 440);
    let done = false;
    const finish = (v: 'save' | 'discard' | 'cancel') => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    m.onClose(() => finish('cancel'));
    const p = document.createElement('p');
    p.textContent = `Save changes to ${fileName}?`;
    m.body.appendChild(p);
    const save = button('Save', true);
    const dont = button("Don't Save");
    const cancel = button('Cancel');
    save.addEventListener('click', () => finish('save'));
    dont.addEventListener('click', () => finish('discard'));
    cancel.addEventListener('click', () => finish('cancel'));
    m.footer.append(save, dont, cancel);
    save.focus();
    m.root.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') save.click();
    });
  });
}
