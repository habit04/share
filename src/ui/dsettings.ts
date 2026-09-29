import type { Editor } from '../app/editor';
import type { OsnapModes, UserSettings } from '../app/settings';
import { updateSettings } from './options';
import { modal, button, tabbedDialog, dlgRow, dlgGroup, dlgCheck, numberInput, selectInput, textField } from './dialogkit';
import { t } from '../app/i18n';
import { INSUNIT_NAMES } from '../core/units';
import { drawingUnitsOf, drawingUnitScale, setDrawingUnits, MM_PER_INCH, type DrawingUnits } from '../electrical/wdm';

export const OSNAP_LABELS: Array<[keyof OsnapModes, string, string]> = [
  ['endpoint', 'Endpoint', 'endpoint'],
  ['midpoint', 'Midpoint', 'midpoint'],
  ['center', 'Center', 'center'],
  ['quadrant', 'Quadrant', 'quadrant'],
  ['intersection', 'Intersection', 'intersection'],
  ['perpendicular', 'Perpendicular', 'perpendicular'],
  ['nearest', 'Nearest', 'nearest'],
];

/** Draw the AutoSnap marker glyph for a mode (mirrors the viewport markers). */
export function markerGlyph(kind: string, color = '#3ff23f'): string {
  const r = 6;
  const c = 8;
  const body = (() => {
    switch (kind) {
      case 'endpoint':
        return `<rect x="${c - r}" y="${c - r}" width="${r * 2}" height="${r * 2}"/>`;
      case 'midpoint':
        return `<path d="M${c} ${c - r}L${c + r} ${c + r}L${c - r} ${c + r}Z"/>`;
      case 'center':
        return `<circle cx="${c}" cy="${c}" r="${r}"/>`;
      case 'quadrant':
        return `<path d="M${c} ${c - r}L${c + r} ${c}L${c} ${c + r}L${c - r} ${c}Z"/>`;
      case 'intersection':
        return `<path d="M${c - r} ${c - r}L${c + r} ${c + r}M${c - r} ${c + r}L${c + r} ${c - r}"/>`;
      case 'perpendicular':
        return `<path d="M${c - r} ${c - r}V${c + r}H${c + r}M${c - r} ${c}H${c}V${c + r}"/>`;
      case 'nearest':
        return `<path d="M${c - r} ${c - r}L${c + r} ${c + r}L${c - r} ${c + r}L${c + r} ${c - r}Z"/>`;
      default:
        return `<rect x="${c - r}" y="${c - r}" width="${r * 2}" height="${r * 2}"/>`;
    }
  })();
  return `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="${color}" stroke-width="1.6">${body}</svg>`;
}

/**
 * The Drawing Units page: inches or millimetres for the electrical symbols (WD_M UNITS and
 * $INSUNITS together), with the offer to rescale what is already drawn. It changes the
 * document (one undo step), so it applies with its own button rather than live.
 */
export function drawingUnitsPage(editor: Editor): HTMLElement {
  const page = document.createElement('div');
  let choice: DrawingUnits = drawingUnitsOf(editor.doc);
  let rescale = editor.doc.entities.length > 0;
  const info = document.createElement('div');
  info.className = 'dlg-note';
  const countNote = document.createElement('div');
  countNote.className = 'dlg-note';
  const objects = () => editor.doc.entities.filter((e) => !(e.type === 'insert' && e.block === 'WD_M')).length;
  const refresh = () => {
    const ins = editor.doc.header.units.insunits;
    info.textContent = t('dsettings.units.current', { units: drawingUnitsOf(editor.doc) === 'mm' ? t('units.millimeters') : t('units.inches'), insunits: `${ins} (${INSUNIT_NAMES[ins] ?? '?'})`, scale: Number(drawingUnitScale(editor.doc).toFixed(4)) });
    const same = choice === drawingUnitsOf(editor.doc);
    countNote.textContent = same ? t('dsettings.units.noChange') : rescale ? t('dsettings.units.willScale', { count: objects(), factor: choice === 'mm' ? MM_PER_INCH : `1/${MM_PER_INCH}` }) : t('dsettings.units.keep');
    apply.disabled = same;
  };
  const select = selectInput([['in', t('dsettings.units.inches')], ['mm', t('dsettings.units.mm')]], choice, (v) => {
    choice = v === 'mm' ? 'mm' : 'in';
    refresh();
  });
  const rescaleCheck = dlgCheck(t('dsettings.units.rescale'), rescale, (v) => {
    rescale = v;
    refresh();
  });
  const apply = button(t('dsettings.units.apply'));
  apply.addEventListener('click', () => {
    const r = setDrawingUnits(editor.doc, choice, { rescale });
    editor.log(t('dsettings.units.done', { from: r.from, to: r.to, count: r.count }));
    if (r.factor !== 1) editor.zoomExtents();
    editor.render();
    refresh();
  });
  page.append(
    dlgGroup(t('dsettings.units.group'), [dlgRow(t('dsettings.units.label'), select), rescaleCheck, countNote, apply]),
    dlgGroup(t('dsettings.units.status'), [info]),
    (() => {
      const n = document.createElement('div');
      n.className = 'dlg-note';
      n.textContent = t('dsettings.units.note');
      return n;
    })(),
  );
  refresh();
  return page;
}

/** DSETTINGS: Snap and Grid / Polar Tracking / Object Snap / Dynamic Input / Drawing Units. */
export function draftingSettingsDialog(editor: Editor, initialTab = 0): void {
  const before = { ...editor.settings };
  const m = modal('Drafting Settings', 600, 'dark');
  const set = (patch: Partial<UserSettings>) => updateSettings(editor, patch);
  const cur = () => editor.settings;

  // ---- Snap and Grid
  const snapGrid = document.createElement('div');
  const snapOn = dlgCheck('Snap On (F9)', editor.snap.gridSnap, (v) => {
    if (v !== editor.snap.gridSnap) editor.toggle('gridSnap');
  });
  const gridOn = dlgCheck('Grid On (F7)', editor.viewport.settings.gridVisible, (v) => {
    if (v !== editor.viewport.settings.gridVisible) editor.toggle('grid');
  });
  const cols = document.createElement('div');
  cols.className = 'dlg-cols';
  cols.append(
    dlgGroup('Snap spacing', [
      snapOn,
      dlgRow('Snap spacing (X = Y)', numberInput(cur().snapSpacing, 0.001, 1e6, 0.125, (v) => set({ snapSpacing: v }))),
    ]),
    dlgGroup('Grid spacing', [
      gridOn,
      dlgRow('Grid spacing (X = Y)', numberInput(cur().gridSpacing, 0.001, 1e6, 0.125, (v) => set({ gridSpacing: v }))),
    ]),
  );
  snapGrid.append(
    cols,
    dlgGroup('Grid style', [dlgRow('Display grid as', selectInput([['lines', 'Lines'], ['dots', 'Dots']], cur().gridStyle, (v) => set({ gridStyle: v as 'lines' | 'dots' })))]),
  );

  // ---- Polar Tracking
  const polar = document.createElement('div');
  const polarOn = dlgCheck('Polar Tracking On (F10)', editor.snap.polar, (v) => {
    if (v !== editor.snap.polar) editor.toggle('polar');
  });
  const additional = document.createElement('div');
  const renderAdditional = () => {
    additional.innerHTML = '';
    for (const a of cur().polarAdditional) {
      const row = document.createElement('div');
      row.className = 'dlg-check';
      const del = button('Delete');
      del.style.minWidth = '60px';
      del.addEventListener('click', () => {
        set({ polarAdditional: cur().polarAdditional.filter((x) => x !== a) });
        renderAdditional();
      });
      row.append(document.createTextNode(`${a}°  `), del);
      additional.appendChild(row);
    }
    if (cur().polarAdditional.length === 0) {
      const n = document.createElement('div');
      n.className = 'dlg-note';
      n.textContent = 'No additional angles.';
      additional.appendChild(n);
    }
  };
  renderAdditional();
  const newAngle = textField('', () => {}, 'angle in degrees');
  const addAngle = button('New');
  addAngle.addEventListener('click', () => {
    const v = parseFloat(newAngle.value);
    if (Number.isFinite(v) && v > 0 && v < 360 && !cur().polarAdditional.includes(v)) {
      set({ polarAdditional: [...cur().polarAdditional, v].sort((a, b) => a - b) });
      newAngle.value = '';
      renderAdditional();
    }
  });
  const addRow = document.createElement('div');
  addRow.className = 'dlg-check';
  addRow.append(newAngle, addAngle);
  polar.append(
    polarOn,
    dlgGroup('Polar Angle Settings', [
      dlgRow('Increment angle', selectInput(['90', '45', '30', '22.5', '18', '15', '10', '5'].map((a) => [a, `${a}°`]), String(cur().polarIncrement), (v) => set({ polarIncrement: parseFloat(v) }))),
      (() => {
        const n = document.createElement('div');
        n.className = 'dlg-note';
        n.textContent = 'Additional angles (absolute, measured from 0° East) are tracked in both directions besides the increment angle and its multiples.';
        return n;
      })(),
      additional,
      addRow,
    ]),
  );

  // ---- Object Snap
  const osnap = document.createElement('div');
  const osnapOn = dlgCheck('Object Snap On (F3)', editor.snap.osnap, (v) => {
    if (v !== editor.snap.osnap) editor.toggle('osnap');
  });
  const modesWrap = document.createElement('div');
  modesWrap.className = 'dlg-cols';
  const modeChecks: HTMLInputElement[] = [];
  for (const [key, label, glyph] of OSNAP_LABELS) {
    const l = document.createElement('label');
    l.className = 'dlg-check';
    const i = document.createElement('input');
    i.type = 'checkbox';
    i.checked = cur().osnapModes[key];
    i.addEventListener('change', () => set({ osnapModes: { ...cur().osnapModes, [key]: i.checked } }));
    modeChecks.push(i);
    const g = document.createElement('span');
    g.innerHTML = markerGlyph(glyph, cur().autosnapMarkerColor);
    l.append(i, g, document.createTextNode(label));
    modesWrap.appendChild(l);
  }
  const selAll = button('Select All');
  const clearAll = button('Clear All');
  const setAll = (v: boolean) => {
    const modes = { ...cur().osnapModes };
    for (const [k] of OSNAP_LABELS) modes[k] = v;
    set({ osnapModes: modes });
    modeChecks.forEach((c) => (c.checked = v));
  };
  selAll.addEventListener('click', () => setAll(true));
  clearAll.addEventListener('click', () => setAll(false));
  const btnRow = document.createElement('div');
  btnRow.className = 'dlg-check';
  btnRow.append(selAll, clearAll);
  osnap.append(osnapOn, dlgGroup('Object Snap modes', [modesWrap, btnRow]), dlgGroup('Options', [dlgRow('Marker color', (() => {
    const s = document.createElement('span');
    s.innerHTML = markerGlyph('endpoint', cur().autosnapMarkerColor) + ' set in Options > Drafting';
    return s;
  })())]));

  // ---- Dynamic Input
  const dyn = document.createElement('div');
  dyn.append(
    dlgCheck('Enable Dynamic Input (F12)', editor.dynamicInput, (v) => {
      if (v !== editor.dynamicInput) editor.toggle('dyn');
    }),
    (() => {
      const n = document.createElement('div');
      n.className = 'dlg-note';
      n.textContent = 'Dynamic Input shows the values a command is asking for (coordinates, distances) next to the crosshair.';
      return n;
    })(),
  );

  m.body.appendChild(tabbedDialog([['Snap and Grid', snapGrid], ['Polar Tracking', polar], ['Object Snap', osnap], ['Dynamic Input', dyn], [t('dsettings.units.tab'), drawingUnitsPage(editor)]], initialTab));
  const ok = button('OK', true);
  const cancel = button('Cancel');
  const opt = button('Options...');
  opt.className += ' left';
  opt.addEventListener('click', () => {
    m.close();
    editor.runCommand('OPTIONS');
  });
  ok.addEventListener('click', () => m.close());
  cancel.addEventListener('click', () => {
    updateSettings(editor, before);
    m.close();
  });
  m.onClose(() => updateSettings(editor, before));
  m.footer.append(opt, ok, cancel);
}
