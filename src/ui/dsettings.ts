import type { Editor } from '../app/editor';
import type { OsnapModes, UserSettings } from '../app/settings';
import { updateSettings } from './options';
import { modal, button, tabbedDialog, dlgRow, dlgGroup, dlgCheck, numberInput, selectInput, textField } from './dialogkit';

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

/** DSETTINGS: Snap and Grid / Polar Tracking / Object Snap / Dynamic Input. */
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

  m.body.appendChild(tabbedDialog([['Snap and Grid', snapGrid], ['Polar Tracking', polar], ['Object Snap', osnap], ['Dynamic Input', dyn]], initialTab));
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
