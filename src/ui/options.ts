import type { Editor } from '../app/editor';
import { DEFAULT_SETTINGS, saveSettings, type UserSettings } from '../app/settings';
import { modal, button, tabbedDialog, dlgRow, dlgGroup, dlgCheck, numberInput, colorInput, selectInput } from './dialogkit';

/**
 * Apply the Options / Drafting Settings values that live outside Editor.applySettings()
 * (viewport appearance, snap modes, pick box, grid spacing). Safe to call at any time.
 */
export function applyUiSettings(editor: Editor): void {
  const s = editor.settings;
  const vs = editor.viewport.settings;
  vs.background = s.modelBackground;
  vs.crosshairColor = s.crosshairColor;
  vs.crosshairSize = s.crosshairSize;
  vs.pickBox = s.pickboxSize;
  vs.gripSize = s.gripSize;
  vs.gripColor = s.gripColor;
  vs.snapMarkerSize = s.autosnapMarkerSize;
  vs.snapMarkerColor = s.autosnapMarkerColor;
  vs.selectionEffect = s.selectionEffect;
  vs.gridSize = s.gridSpacing;
  vs.gridStyle = s.gridStyle;
  editor.snap.gridSize = s.snapSpacing;
  editor.snap.polarIncrement = s.polarIncrement;
  for (const k of Object.keys(s.osnapModes) as Array<keyof typeof s.osnapModes>) editor.snap[k] = s.osnapModes[k];
  document.getElementById('ribbon')?.classList.toggle('light', s.ribbonTheme === 'light');
  editor.render();
}

export function updateSettings(editor: Editor, patch: Partial<UserSettings>): void {
  editor.settings = { ...editor.settings, ...patch };
  saveSettings(editor.settings);
  applyUiSettings(editor);
  editor.notify('snap');
}

/** OPTIONS dialog: Display, Drafting, Selection, Files, Units. Changes apply live; Cancel restores. */
export function optionsDialog(editor: Editor, initialTab = 0): void {
  const before = { ...editor.settings };
  const m = modal('Options', 680, 'dark');
  const set = (patch: Partial<UserSettings>) => updateSettings(editor, patch);
  const cur = () => editor.settings;

  // ---- Display
  const display = document.createElement('div');
  display.append(
    dlgGroup('Window Elements', [
      dlgRow('Color scheme (ribbon)', selectInput([['dark', 'Dark'], ['light', 'Light']], cur().ribbonTheme, (v) => set({ ribbonTheme: v as 'dark' | 'light' }))),
      dlgRow('Model space background', colorInput(cur().modelBackground, (v) => set({ modelBackground: v }))),
      dlgRow('Crosshair color', colorInput(cur().crosshairColor, (v) => set({ crosshairColor: v }))),
      dlgCheck('Display the command window (Ctrl+9)', cur().commandWindowVisible, (v) => {
        set({ commandWindowVisible: v });
        editor.runCommand(v ? 'COMMANDLINE' : 'COMMANDLINEHIDE');
      }),
    ]),
    dlgGroup('Crosshair Size', [dlgRow(`Percent of screen (1-100)`, numberInput(cur().crosshairSize, 1, 100, 1, (v) => set({ crosshairSize: v }), true))]),
    dlgGroup('Grid', [
      dlgRow('Grid style', selectInput([['lines', 'Lines (2D model space)'], ['dots', 'Dots']], cur().gridStyle, (v) => set({ gridStyle: v as 'lines' | 'dots' }))),
      dlgRow('Grid spacing', numberInput(cur().gridSpacing, 0.001, 1e6, 0.1, (v) => set({ gridSpacing: v }))),
    ]),
  );

  // ---- Drafting
  const drafting = document.createElement('div');
  const markerPreview = document.createElement('canvas');
  markerPreview.width = 60;
  markerPreview.height = 40;
  markerPreview.className = 'snap-marker-preview';
  const drawMarker = () => {
    const ctx = markerPreview.getContext('2d')!;
    ctx.clearRect(0, 0, 60, 40);
    ctx.fillStyle = cur().modelBackground;
    ctx.fillRect(0, 0, 60, 40);
    const r = cur().autosnapMarkerSize;
    ctx.strokeStyle = cur().autosnapMarkerColor;
    ctx.lineWidth = 2;
    ctx.strokeRect(30 - r, 20 - r, r * 2, r * 2);
    ctx.strokeStyle = cur().crosshairColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(30, 0);
    ctx.lineTo(30, 40);
    ctx.moveTo(0, 20);
    ctx.lineTo(60, 20);
    ctx.stroke();
    const a = cur().apertureSize / 2;
    ctx.strokeStyle = '#bbb';
    ctx.strokeRect(30 - a + 0.5, 20 - a + 0.5, a * 2, a * 2);
  };
  drafting.append(
    dlgGroup('AutoSnap Settings', [
      dlgCheck('Marker', true, () => {}),
      dlgCheck('Magnet', true, () => {}),
      dlgCheck('Display AutoSnap tooltip', cur().rolloverTooltips, (v) => set({ rolloverTooltips: v })),
      dlgRow('AutoSnap marker color', colorInput(cur().autosnapMarkerColor, (v) => {
        set({ autosnapMarkerColor: v });
        drawMarker();
      })),
    ]),
    dlgGroup('AutoSnap Marker Size', [
      dlgRow('Size (1-20 px)', numberInput(cur().autosnapMarkerSize, 1, 20, 1, (v) => {
        set({ autosnapMarkerSize: v });
        drawMarker();
      }, true)),
    ]),
    dlgGroup('Aperture Size', [
      dlgRow('Size (1-50 px)', numberInput(cur().apertureSize, 1, 50, 1, (v) => {
        set({ apertureSize: v });
        drawMarker();
      }, true)),
      (() => {
        const w = document.createElement('div');
        w.className = 'dlg-note';
        w.append('Preview: ', markerPreview);
        return w;
      })(),
    ]),
  );
  drawMarker();

  // ---- Selection
  const selection = document.createElement('div');
  selection.append(
    dlgGroup('Pickbox Size', [dlgRow('Size (0-20 px)', numberInput(cur().pickboxSize, 0, 20, 1, (v) => set({ pickboxSize: v }), true))]),
    dlgGroup('Grip Size', [dlgRow('Size (1-20 px)', numberInput(cur().gripSize, 1, 20, 1, (v) => set({ gripSize: v }), true))]),
    dlgGroup('Grips', [
      dlgRow('Unselected grip color', colorInput(cur().gripColor, (v) => set({ gripColor: v }))),
      dlgRow('Hover grip color', colorInput(cur().gripHoverColor, (v) => set({ gripHoverColor: v }))),
    ]),
    dlgGroup('Selection Modes', [
      dlgRow('Selection effect', selectInput([['dashed', 'Dashed highlight (classic)'], ['solid', 'Thick solid highlight']], cur().selectionEffect, (v) => set({ selectionEffect: v as 'dashed' | 'solid' }))),
      dlgCheck('Quick Properties on selection (QP)', cur().quickProperties, (v) => set({ quickProperties: v })),
      dlgCheck('Rollover tooltips', cur().rolloverTooltips, (v) => set({ rolloverTooltips: v })),
    ]),
  );

  // ---- Files
  const files = document.createElement('div');
  files.append(
    dlgGroup('Automatic Save', [
      dlgCheck('Automatic save', cur().autosaveMinutes > 0, (v) => set({ autosaveMinutes: v ? Math.max(1, before.autosaveMinutes || 10) : 0 })),
      dlgRow('Minutes between saves', numberInput(cur().autosaveMinutes, 0, 240, 1, (v) => set({ autosaveMinutes: v }))),
      (() => {
        const n = document.createElement('div');
        n.className = 'dlg-note';
        n.textContent = 'Autosave files are written to the application data folder and offered by the Drawing Recovery prompt at the next start. 0 disables autosave.';
        return n;
      })(),
    ]),
    dlgGroup('Symbol Library', [
      dlgRow('Default symbol standard', selectInput([['JIC', 'JIC (NFPA)'], ['IEC', 'IEC 60617']], cur().symbolStandard, (v) => set({ symbolStandard: v as 'JIC' | 'IEC' }))),
    ]),
    dlgGroup('Recent Documents', [
      (() => {
        const b = button('Clear recent file list');
        b.addEventListener('click', () => {
          set({ recentFiles: [] });
          editor.notify('file');
        });
        return b;
      })(),
    ]),
  );

  // ---- Units
  const units = document.createElement('div');
  units.append(
    dlgGroup('Length', [
      dlgRow('Type', selectInput([['decimal', 'Decimal'], ['engineering', 'Engineering'], ['architectural', 'Architectural'], ['fractional', 'Fractional']], cur().units, (v) => set({ units: v as UserSettings['units'] }))),
      dlgRow('Precision (decimal places)', numberInput(cur().precision, 0, 8, 1, (v) => set({ precision: v }))),
      dlgRow('Insertion scale unit', selectInput([['in', 'Inches'], ['mm', 'Millimeters'], ['ft', 'Feet'], ['m', 'Meters']], cur().unitSuffix, (v) => set({ unitSuffix: v as UserSettings['unitSuffix'] }))),
    ]),
    dlgGroup('Coordinate Display', [
      dlgRow('Status bar coordinates', selectInput([['absolute', 'Absolute'], ['relative', 'Relative to last point'], ['off', 'Off']], cur().coordDisplay, (v) => set({ coordDisplay: v as UserSettings['coordDisplay'] }))),
    ]),
  );

  m.body.appendChild(tabbedDialog([['Display', display], ['Drafting', drafting], ['Selection', selection], ['Files', files], ['Units', units]], initialTab));

  const ok = button('OK', true);
  const cancel = button('Cancel');
  const reset = button('Restore Defaults');
  reset.className += ' left';
  reset.addEventListener('click', () => {
    const keep = { recentFiles: cur().recentFiles, recentInput: cur().recentInput, ribbonTab: cur().ribbonTab, paletteWidths: cur().paletteWidths };
    set({ ...DEFAULT_SETTINGS, ...keep });
    m.close();
    optionsDialog(editor, initialTab);
  });
  ok.addEventListener('click', () => m.close());
  cancel.addEventListener('click', () => {
    updateSettings(editor, before);
    m.close();
  });
  m.onClose(() => updateSettings(editor, before));
  m.footer.append(reset, ok, cancel);
}
