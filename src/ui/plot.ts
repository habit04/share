/** Plot / Print dialog: paper size, orientation, scale and margins (remembered in settings). */
import type { Editor } from '../app/editor';
import { modal, button, dlgRow, dlgGroup, numberInput, selectInput } from './dialogkit';
import { PAPER_SIZES, PLOT_SCALES, layoutPage, type PlotOptions } from '../app/plot';
import { saveSettings } from '../app/settings';

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
    const opts: PlotOptions = { paper: s.plotPaper, orientation: s.plotOrientation, scale: s.plotScale, margin: s.plotMargin };
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
    m.body.append(
      dlgGroup('Paper', [
        dlgRow('Paper size', selectInput(PAPER_SIZES.map((p) => [p.id, p.label]), opts.paper, (v) => ((opts.paper = v), refresh()))),
        dlgRow('Orientation', selectInput([['auto', 'Automatic (follow the drawing)'], ['landscape', 'Landscape'], ['portrait', 'Portrait']], opts.orientation, (v) => ((opts.orientation = v as PlotOptions['orientation']), refresh()))),
        dlgRow('Scale', selectInput(PLOT_SCALES, opts.scale, (v) => ((opts.scale = v), refresh()))),
        dlgRow('Margins (in)', numberInput(opts.margin, 0, 5, 0.05, (v) => ((opts.margin = v), refresh()))),
      ]),
      preview,
    );
    const note = document.createElement('p');
    note.className = 'dlg-note';
    note.textContent = 'Plot to PDF writes a file at the sheet size above. Print opens the print dialog, where you pick the printer and its paper tray (choose the same paper size). Lines print black; hidden layers are left out.';
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
