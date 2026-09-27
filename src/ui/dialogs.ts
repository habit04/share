import type { Editor } from '../app/editor';
import type { LadderSettings } from '../tools/types';
import { SYMBOL_CATEGORIES, findSymbol } from '../electrical/symbols';
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
export function pickSymbolDialog(editor: Editor): Promise<string | null> {
  return new Promise((resolve) => {
    const m = modal('Insert Component: JIC Schematic Symbols', 720);
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
      const cat = SYMBOL_CATEGORIES[active]!;
      for (const s of cat.symbols) {
        const cell = document.createElement('button');
        cell.className = 'iconmenu-cell';
        const canvas = document.createElement('canvas');
        canvas.width = 96;
        canvas.height = 72;
        const ctx = canvas.getContext('2d')!;
        drawPreview(ctx, s.entities, editor.doc.layers, editor.doc.lookupBlock, 96, 72, '#202020', 10);
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
      SYMBOL_CATEGORIES.forEach((c, i) => {
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

    const cancel = button('Cancel');
    cancel.addEventListener('click', () => finish(null));
    m.footer.append(cancel);
  });
}

/** Insert / Edit Component dialog (tag, description). */
export function editComponentDialog(
  editor: Editor,
  init: { tag: string; desc: string; block: string },
): Promise<{ tag: string; desc: string } | null> {
  return new Promise((resolve) => {
    const m = modal('Insert / Edit Component', 480);
    let done = false;
    const finish = (v: { tag: string; desc: string } | null) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    m.onClose(() => finish(null));

    const sym = findSymbol(init.block);
    const preview = document.createElement('canvas');
    preview.width = 140;
    preview.height = 90;
    preview.className = 'component-preview';
    if (sym) drawPreview(preview.getContext('2d')!, sym.entities, editor.doc.layers, editor.doc.lookupBlock, 140, 90, '#202020', 12);

    const tag = textInput(init.tag);
    const desc = textInput(init.desc);
    desc.placeholder = 'e.g. START MOTOR';
    const group = document.createElement('div');
    group.className = 'form-grid';
    group.append(
      field('Component Tag', tag),
      field('Description', desc),
      field('Block', textInput(`${init.block}${sym?.description ? ` — ${sym.description}` : ''}`)),
    );
    (group.lastElementChild!.querySelector('input') as HTMLInputElement).readOnly = true;
    const row = document.createElement('div');
    row.className = 'component-row';
    row.append(preview, group);
    m.body.appendChild(row);

    const ok = button('OK', true);
    const cancel = button('Cancel');
    ok.addEventListener('click', () => finish({ tag: tag.value.trim().toUpperCase(), desc: desc.value.trim().toUpperCase() }));
    cancel.addEventListener('click', () => finish(null));
    m.footer.append(ok, cancel);
    tag.focus();
    tag.select();
    m.root.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') ok.click();
      if (ev.key === 'Escape') cancel.click();
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
    grid.append(field('Width', width), field('Spacing', spacing), field('Rungs', rungs), field('1st Reference', first), field('Index', step), field('Phase', phaseWrap), field('Rungs', rungsWrap));
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
    table.innerHTML = `<thead><tr><th>S</th><th>Name</th><th>On</th><th>Freeze</th><th>Lock</th><th>Color</th><th>Linetype</th><th>Lineweight</th><th>Plot</th></tr></thead>`;
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
        <td class="color"><span class="swatch" style="background:${aciToCss(l.color)}"></span>${colourName(l.color)}</td>
        <td>Continuous</td>
        <td>${Math.abs(l.lineWeight - 0.25) < 1e-9 ? 'Default' : `${l.lineWeight.toFixed(2)} mm`}</td>
        <td class="tog plot-true">${icon('plot')}</td>`;
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
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = 'Click the first column to set current. Click On / Lock / Color to toggle or cycle.';
  const newRow = document.createElement('div');
  newRow.className = 'form-inline';
  const name = textInput('');
  name.placeholder = 'New layer name';
  const add = button('New Layer');
  add.addEventListener('click', () => {
    const n = name.value.trim().toUpperCase();
    if (!n) return;
    editor.doc.addLayer({ name: n, color: 7, visible: true, locked: false, lineWeight: 0.25 });
    name.value = '';
    render();
  });
  newRow.append(name, add);
  m.body.append(table, newRow, hint);
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
