import type { Editor } from '../app/editor';
import { DEFAULT_SETTINGS, saveSettings, type UserSettings } from '../app/settings';
import { t, setLocale, resolveLocale, languageChoices, type LanguageSetting } from '../app/i18n';
import { modal, button, tabbedDialog, dlgRow, dlgGroup, dlgCheck, numberInput, colorInput, selectInput } from './dialogkit';

/**
 * Apply the Options / Drafting Settings values that live outside Editor.applySettings()
 * (viewport appearance, snap modes, pick box, grid spacing, UI language). Safe to call at any time.
 */
export function applyUiSettings(editor: Editor): void {
  const s = editor.settings;
  const vs = editor.viewport.settings;
  setLocale(resolveLocale(s.language));
  vs.background = s.modelBackground;
  vs.crosshairColor = s.crosshairColor;
  vs.crosshairSize = s.crosshairSize;
  // Pickbox, grip, marker and aperture sizes are CSS pixels: the viewport draws with the
  // devicePixelRatio transform, so they look the same size on a 100 % and a 200 % monitor.
  vs.pickBox = s.pickboxSize;
  vs.gripSize = s.gripSize;
  vs.gripColor = s.gripColor;
  vs.gripHoverColor = s.gripHoverColor;
  vs.snapMarkerSize = s.autosnapMarkerSize;
  vs.snapMarkerColor = s.autosnapMarkerColor;
  vs.selectionEffect = s.selectionEffect;
  vs.gridSize = s.gridSpacing;
  vs.gridStyle = s.gridStyle;
  editor.snap.gridSize = s.snapSpacing;
  editor.snap.polarIncrement = s.polarIncrement;
  editor.snap.polarAdditional = [...s.polarAdditional];
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

function note(text: string): HTMLElement {
  const n = document.createElement('div');
  n.className = 'dlg-note';
  n.textContent = text;
  return n;
}

/**
 * OPTIONS dialog: Display, Drafting, Selection, Files, Units. Changes apply live; Cancel restores
 * `restore` (the settings from before the dialog first opened; kept when the dialog re-opens itself).
 */
export function optionsDialog(editor: Editor, initialTab = 0, restore?: UserSettings): void {
  const before = restore ?? { ...editor.settings };
  const m = modal(t('options.title'), 680, 'dark');
  const set = (patch: Partial<UserSettings>) => updateSettings(editor, patch);
  const cur = () => editor.settings;
  let tab = initialTab;
  /** Rebuild the dialog in place (after a language change or Restore Defaults). */
  const reopen = () => {
    m.close();
    optionsDialog(editor, tab, before);
  };

  // ---- Display
  const display = document.createElement('div');
  display.append(
    dlgGroup(t('options.display.windowElements'), [
      dlgRow(t('options.display.language'), selectInput(languageChoices(t('options.display.languageAuto')), cur().language, (v) => {
        set({ language: v as LanguageSetting });
        reopen();
      })),
      dlgRow(t('options.display.colorScheme'), selectInput([['dark', t('options.display.dark')], ['light', t('options.display.light')]], cur().ribbonTheme, (v) => set({ ribbonTheme: v as 'dark' | 'light' }))),
      dlgRow(t('options.display.background'), colorInput(cur().modelBackground, (v) => set({ modelBackground: v }))),
      dlgRow(t('options.display.crosshairColor'), colorInput(cur().crosshairColor, (v) => set({ crosshairColor: v }))),
      dlgCheck(t('options.display.commandWindow'), cur().commandWindowVisible, (v) => {
        set({ commandWindowVisible: v });
        editor.runCommand(v ? 'COMMANDLINE' : 'COMMANDLINEHIDE');
      }),
    ]),
    dlgGroup(t('options.display.crosshairSize'), [dlgRow(t('options.display.crosshairPercent'), numberInput(cur().crosshairSize, 1, 100, 1, (v) => set({ crosshairSize: v }), true))]),
    dlgGroup(t('options.display.grid'), [
      dlgRow(t('options.display.gridStyle'), selectInput([['lines', t('options.display.gridLines')], ['dots', t('options.display.gridDots')]], cur().gridStyle, (v) => set({ gridStyle: v as 'lines' | 'dots' }))),
      dlgRow(t('options.display.gridSpacing'), numberInput(cur().gridSpacing, 0.001, 1e6, 0.1, (v) => set({ gridSpacing: v }))),
    ]),
  );

  // ---- Drafting
  const drafting = document.createElement('div');
  const markerPreview = document.createElement('canvas');
  markerPreview.className = 'snap-marker-preview';
  const drawMarker = () => {
    // Preview canvas in CSS pixels, backing store in device pixels (crisp on high-DPI screens).
    const dpr = window.devicePixelRatio || 1;
    markerPreview.style.width = '60px';
    markerPreview.style.height = '40px';
    markerPreview.width = Math.round(60 * dpr);
    markerPreview.height = Math.round(40 * dpr);
    const ctx = markerPreview.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
    ctx.moveTo(30.5, 0);
    ctx.lineTo(30.5, 40);
    ctx.moveTo(0, 20.5);
    ctx.lineTo(60, 20.5);
    ctx.stroke();
    const a = cur().apertureSize / 2;
    ctx.strokeStyle = '#bbb';
    ctx.strokeRect(30 - a + 0.5, 20 - a + 0.5, a * 2, a * 2);
  };
  drafting.append(
    dlgGroup(t('options.drafting.autosnap'), [
      dlgRow(t('options.drafting.markerColor'), colorInput(cur().autosnapMarkerColor, (v) => {
        set({ autosnapMarkerColor: v });
        drawMarker();
      })),
    ]),
    dlgGroup(t('options.drafting.markerSize'), [
      dlgRow(t('options.sizePx', { min: 1, max: 20 }), numberInput(cur().autosnapMarkerSize, 1, 20, 1, (v) => {
        set({ autosnapMarkerSize: v });
        drawMarker();
      }, true)),
    ]),
    dlgGroup(t('options.drafting.aperture'), [
      dlgRow(t('options.sizePx', { min: 1, max: 50 }), numberInput(cur().apertureSize, 1, 50, 1, (v) => {
        set({ apertureSize: v });
        drawMarker();
      }, true)),
      (() => {
        const w = document.createElement('div');
        w.className = 'dlg-note';
        w.append(t('options.drafting.preview'), ' ', markerPreview);
        return w;
      })(),
    ]),
  );
  drawMarker();

  // ---- Selection
  const selection = document.createElement('div');
  selection.append(
    dlgGroup(t('options.selection.pickbox'), [dlgRow(t('options.sizePx', { min: 0, max: 20 }), numberInput(cur().pickboxSize, 0, 20, 1, (v) => set({ pickboxSize: v }), true))]),
    dlgGroup(t('options.selection.gripSize'), [dlgRow(t('options.sizePx', { min: 1, max: 20 }), numberInput(cur().gripSize, 1, 20, 1, (v) => set({ gripSize: v }), true))]),
    dlgGroup(t('options.selection.grips'), [
      dlgRow(t('options.selection.gripColor'), colorInput(cur().gripColor, (v) => set({ gripColor: v }))),
      dlgRow(t('options.selection.gripHoverColor'), colorInput(cur().gripHoverColor, (v) => set({ gripHoverColor: v }))),
    ]),
    dlgGroup(t('options.selection.modes'), [
      dlgRow(t('options.selection.effect'), selectInput([['dashed', t('options.selection.dashed')], ['solid', t('options.selection.solid')]], cur().selectionEffect, (v) => set({ selectionEffect: v as 'dashed' | 'solid' }))),
      dlgCheck(t('options.selection.quickProperties'), cur().quickProperties, (v) => set({ quickProperties: v })),
      dlgCheck(t('options.selection.tooltips'), cur().rolloverTooltips, (v) => set({ rolloverTooltips: v })),
    ]),
  );

  // ---- Files
  const files = document.createElement('div');
  files.append(
    dlgGroup(t('options.files.autosave'), [
      dlgCheck(t('options.files.autosaveOn'), cur().autosaveMinutes > 0, (v) => set({ autosaveMinutes: v ? Math.max(1, before.autosaveMinutes || 10) : 0 })),
      dlgRow(t('options.files.minutes'), numberInput(cur().autosaveMinutes, 0, 240, 1, (v) => set({ autosaveMinutes: v }))),
      note(t('options.files.autosaveNote')),
    ]),
    dlgGroup(t('options.files.symbolLibrary'), [
      dlgRow(t('options.files.standard'), selectInput([['JIC', t('options.files.jic')], ['IEC', t('options.files.iec')]], cur().symbolStandard, (v) => set({ symbolStandard: v as 'JIC' | 'IEC' }))),
    ]),
    dlgGroup(t('options.files.recent'), [
      (() => {
        const b = button(t('options.files.clearRecent'));
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
    dlgGroup(t('options.units.length'), [
      dlgRow(t('options.units.type'), selectInput([['decimal', t('units.decimal')], ['engineering', t('units.engineering')], ['architectural', t('units.architectural')], ['fractional', t('units.fractional')]], cur().units, (v) => set({ units: v as UserSettings['units'] }))),
      dlgRow(t('options.units.precision'), numberInput(cur().precision, 0, 8, 1, (v) => set({ precision: v }))),
      dlgRow(t('options.units.label'), selectInput([['in', t('units.inches')], ['mm', t('units.millimeters')], ['ft', t('units.feet')], ['m', t('units.meters')]], cur().unitSuffix, (v) => set({ unitSuffix: v as UserSettings['unitSuffix'] }))),
      note(t('options.units.note')),
    ]),
    dlgGroup(t('options.units.coordinates'), [
      dlgRow(t('options.units.statusCoordinates'), selectInput([['absolute', t('status.coords.absolute')], ['relative', t('status.coords.relative')], ['off', t('status.coords.off')]], cur().coordDisplay, (v) => set({ coordDisplay: v as UserSettings['coordDisplay'] }))),
    ]),
  );

  m.body.appendChild(
    tabbedDialog(
      [
        [t('options.tab.display'), display],
        [t('options.tab.drafting'), drafting],
        [t('options.tab.selection'), selection],
        [t('options.tab.files'), files],
        [t('options.tab.units'), units],
      ],
      initialTab,
      (i) => (tab = i),
    ),
  );

  const ok = button(t('dialog.ok'), true);
  const cancel = button(t('dialog.cancel'));
  const reset = button(t('options.restoreDefaults'));
  reset.className += ' left';
  reset.addEventListener('click', () => {
    const keep = { recentFiles: cur().recentFiles, recentInput: cur().recentInput, ribbonTab: cur().ribbonTab, paletteWidths: cur().paletteWidths, language: cur().language };
    set({ ...DEFAULT_SETTINGS, ...keep });
    reopen();
  });
  ok.addEventListener('click', () => m.close());
  cancel.addEventListener('click', () => {
    updateSettings(editor, before);
    m.close();
  });
  m.onClose(() => updateSettings(editor, before));
  m.footer.append(reset, ok, cancel);
}
