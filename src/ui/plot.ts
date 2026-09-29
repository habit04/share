/** Plot / Print dialog: paper size, orientation, scale and margins (remembered in settings). */
import type { Editor } from '../app/editor';
import { modal, button, dlgRow, dlgGroup, dlgCheck, numberInput, selectInput } from './dialogkit';
import { PAPER_SIZES, PLOT_SCALES, layoutPage, type PlotOptions } from '../app/plot';
import { saveSettings } from '../app/settings';
// Track E: layouts plot their page setup; vector PDF output and plot styles.
import { activeLayout, layoutsOf, paperLabel, sheetInches } from '../core/layouts';
import { PLOT_STYLE_LABELS, pageSetupDialog } from './layouts';

export interface PlotChoice {
  options: PlotOptions;
  action: 'pdf' | 'print';
}

/** One dialog for both outputs: "Plot to PDF" writes a file, "Print" opens the system / browser print dialog. */
export function plotDialog(editor: Editor, mode: 'pdf' | 'print'): Promise<PlotChoice | null> {
  return new Promise((resolve) => {
    const m = modal(mode === 'pdf' ? 'Plot to PDF' : 'Print', 560, 'dark');
    let done = false;
    const finish = (v: PlotChoice | null) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    m.onClose(() => finish(null));
    const s = editor.settings;
    const layout = activeLayout(editor.doc.snapshot);
    const opts: PlotOptions = {
      paper: s.plotPaper,
      orientation: s.plotOrientation,
      scale: s.plotScale,
      margin: s.plotMargin,
      output: 'vector',
      what: 'current',
      style: layout?.plotStyle ?? 'monochrome',
      screening: layout?.screening,
      lineweights: layout ? layout.plotLineweights !== false : true,
      usePlotStyles: layout ? layout.usePlotStyles !== false : true,
    };
    const preview = document.createElement('div');
    preview.className = 'dlg-note';
    const b = editor.doc.extents();
    const empty = document.createElement('div');
    empty.className = 'dlg-warning';
    if (!b) {
      const hiddenAll = editor.doc.entities.length > 0;
      empty.textContent = hiddenAll
        ? 'Nothing to plot: every object in this tab is on a hidden layer. Turn a layer on (LAYER) and try again.'
        : `Nothing to plot: the tab "${editor.fileName()}" has no objects. Open a drawing (OPEN) or switch to its tab in the strip above the canvas, then plot again.`;
      m.body.appendChild(empty);
    }
    const refresh = () => {
      if (opts.what === 'layouts') {
        const ls = layoutsOf(editor.doc.snapshot);
        preview.textContent = `${ls.length} page(s): ${ls.map((l) => `${l.name} (${paperLabel(l.paper)} ${l.paper.orientation})`).join(', ')}; each layout plots its page setup.`;
        return;
      }
      if (layout) {
        const sh = sheetInches(layout);
        preview.textContent = `Layout ${layout.name}: sheet ${sh.width.toFixed(2)} x ${sh.height.toFixed(2)} in ${layout.paper.orientation} (${paperLabel(layout.paper)}), plotted ${layout.plotScale === 'fit' ? 'fit to paper' : layout.plotScale} from its page setup.`;
        return;
      }
      if (!b) {
        preview.textContent = '';
        return;
      }
      const w = b.max.x - b.min.x;
      const h = b.max.y - b.min.y;
      const lay = layoutPage(w, h, opts);
      const sheet = `${lay.sheet.width.toFixed(2)} x ${lay.sheet.height.toFixed(2)} in ${lay.landscape ? 'landscape' : 'portrait'}`;
      const scale = lay.scale >= 1 ? `${lay.scale.toFixed(2)}:1` : `1:${(1 / lay.scale).toFixed(2)}`;
      preview.textContent = `Sheet ${sheet}; drawing ${w.toFixed(2)} x ${h.toFixed(2)} units at ${scale}${lay.reducedToFit ? ' (reduced to fit the paper)' : ''}.`;
    };
    if (layout) {
      // A layout plots its own sheet: paper, orientation, scale and margins come from its page setup.
      const setup = button('Page Setup…');
      setup.addEventListener('click', () => {
        finish(null);
        pageSetupDialog(editor, layout.name);
      });
      m.body.append(dlgGroup('Page setup', [dlgRow('Layout', setup)]));
    } else {
      m.body.append(
        dlgGroup('Paper', [
          dlgRow('Paper size', selectInput(PAPER_SIZES.map((p) => [p.id, p.label]), opts.paper, (v) => ((opts.paper = v), refresh()))),
          dlgRow('Orientation', selectInput([['auto', 'Automatic (follow the drawing)'], ['landscape', 'Landscape'], ['portrait', 'Portrait']], opts.orientation, (v) => ((opts.orientation = v as PlotOptions['orientation']), refresh()))),
          dlgRow('Scale', selectInput(PLOT_SCALES, opts.scale, (v) => ((opts.scale = v), refresh()))),
          dlgRow('Margins (in)', numberInput(opts.margin, 0, 5, 0.05, (v) => ((opts.margin = v), refresh()))),
        ]),
      );
    }
    const screenRow = dlgRow('Screening (%)', numberInput(opts.screening ?? 50, 5, 100, 5, (v) => (opts.screening = v)));
    screenRow.style.display = opts.style === 'screening' ? '' : 'none';
    m.body.append(
      dlgGroup('Output', [
        dlgRow('PDF output', selectInput([['vector', 'Vector (recommended)'], ['raster', 'Raster image']], opts.output!, (v) => (opts.output = v as PlotOptions['output']))),
        dlgRow('What to plot', selectInput([['current', layout ? `Current layout (${layout.name})` : 'Model tab'], ['layouts', 'All layouts (one page each)']], opts.what!, (v) => ((opts.what = v as PlotOptions['what']), refresh()))),
        dlgRow('Plot style table', selectInput(PLOT_STYLE_LABELS, opts.style!, (v) => ((opts.style = v as PlotOptions['style']), (screenRow.style.display = v === 'screening' ? '' : 'none')))),
        screenRow,
        dlgCheck('Plot object lineweights', opts.lineweights !== false, (v) => (opts.lineweights = v)),
        dlgCheck('Plot with plot styles', opts.usePlotStyles !== false, (v) => (opts.usePlotStyles = v)),
      ]),
      preview,
    );
    const note = document.createElement('p');
    note.className = 'dlg-note';
    note.textContent = 'Plot to PDF writes a file at the sheet size above (vector paths; Raster image embeds a picture of the sheet). Print opens the print dialog, where you pick the printer and its paper tray (choose the same paper size). Hidden and no-plot layers are left out.';
    m.body.appendChild(note);
    refresh();
    const choose = (action: 'pdf' | 'print') => {
      editor.settings = { ...editor.settings, plotPaper: opts.paper, plotOrientation: opts.orientation, plotScale: opts.scale, plotMargin: opts.margin };
      saveSettings(editor.settings);
      finish({ options: opts, action });
    };
    const pdf = button('Plot to PDF', mode === 'pdf');
    pdf.disabled = !b;
    pdf.title = b ? 'Write a PDF file' : 'Nothing to plot';
    pdf.addEventListener('click', () => choose('pdf'));
    const print = button('Print…', mode === 'print');
    print.disabled = !b;
    print.title = b ? 'Open the print dialog to choose a printer' : 'Nothing to print';
    print.addEventListener('click', () => choose('print'));
    const cancel = button('Cancel');
    cancel.addEventListener('click', () => finish(null));
    m.footer.append(pdf, print, cancel);
  });
}
