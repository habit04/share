import type { PlotStyleTable } from '../core/plot-styles';
import { readPlotStyleFile } from '../app/plot-style-files';
import { button, dlgRow } from './dialogkit';

export interface PlotStyleSelection {
  readonly table: PlotStyleTable;
  readonly name: string;
  readonly namedStyle?: string;
}

/** Picked programs belong only to this plot dialog. Late reads cannot revive a closed dialog. */
export function plotStylePicker(onChange: (selection: PlotStyleSelection | null) => void, onBusy: (busy: boolean) => void) {
  const root = document.createElement('div'), controls = document.createElement('div');
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.ctb,.stb'; input.hidden = true;
  const load = button('Load CTB/STB…'), clear = button('Use built-in mode');
  clear.hidden = true;
  const status = document.createElement('p'); status.className = 'dlg-note';
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const named = document.createElement('select'); named.setAttribute('aria-label', 'Named style for this plot');
  const namedRow = dlgRow('Named style for this plot', named); namedRow.hidden = true;
  const note = document.createElement('p'); note.className = 'dlg-note'; note.hidden = true;
  note.textContent = 'Applies the chosen named style to every plotted object. Imported named-style assignments are not applied yet.';
  controls.append(load, clear, input);
  root.append(dlgRow('Custom plot style table', controls), status, namedRow, note);
  let revision = 0, disposed = false, selection: PlotStyleSelection | null = null;
  const show = (value: PlotStyleSelection | null) => {
    selection = value; clear.hidden = !value;
    status.textContent = value ? `Loaded ${value.name}. Unsupported effects are reported when plotted.` : '';
    status.className = 'dlg-note';
    namedRow.hidden = note.hidden = value?.table.kind !== 'stb';
    named.replaceChildren();
    if (value?.table.kind === 'stb') for (const style of value.table.styles) {
      const option = document.createElement('option'); option.value = style.name; option.textContent = style.localizedName || style.name; named.append(option);
    }
    onChange(value);
  };
  load.addEventListener('click', () => { if (!disposed) input.click(); });
  clear.addEventListener('click', () => { if (!disposed) { revision++; input.value = ''; show(null); } });
  named.addEventListener('change', () => { if (!disposed && selection) { selection = { ...selection, namedStyle: named.value }; onChange(selection); } });
  input.addEventListener('change', () => {
    const file = input.files?.[0]; if (!file || disposed) return;
    const current = ++revision;
    load.disabled = clear.disabled = named.disabled = true; onBusy(true);
    void readPlotStyleFile(file).then((loaded) => {
      if (disposed || current !== revision) return;
      show({ ...loaded, ...(loaded.table.kind === 'stb' ? { namedStyle: 'Normal' } : {}) });
    }).catch((error: unknown) => {
      if (disposed || current !== revision) return;
      status.className = 'dlg-warning';
      status.textContent = `Plot style table could not be loaded: ${error instanceof Error ? error.message : String(error)}${selection ? ' The previously loaded table is kept.' : ''}`;
    }).finally(() => {
      if (disposed || current !== revision) return;
      load.disabled = clear.disabled = named.disabled = false; onBusy(false); input.value = '';
    });
  });
  return { element: root, dispose() { disposed = true; revision++; } };
}
