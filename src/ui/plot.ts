/** Plot / Print dialog: paper size, orientation, scale and margins (remembered in settings). */
import type { Editor } from '../app/editor';
import { modal, button, dlgRow, dlgGroup, numberInput, selectInput } from './dialogkit';
import { PAPER_SIZES, PLOT_SCALES, layoutPage, type PlotOptions } from '../app/plot';
import { saveSettings } from '../app/settings';

export function plotDialog(editor: Editor, mode: 'pdf' | 'print'): Promise<PlotOptions | null> {
  return new Promise((resolve) => {
    const m = modal(mode === 'pdf' ? 'Plot to PDF' : 'Print', 520, 'dark');
    let done = false;
    const finish = (v: PlotOptions | null) => {
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
    const refresh = () => {
      if (!b) {
        preview.textContent = 'Nothing to plot: the drawing is empty.';
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
    note.textContent = mode === 'pdf' ? 'The PDF page is the sheet size chosen above. Lines print black; hidden layers are left out.' : 'The system print dialog opens next: pick the printer and its paper tray there (choose the same paper size as above).';
    m.body.appendChild(note);
    refresh();
    const ok = button(mode === 'pdf' ? 'Plot' : 'Print', true);
    ok.disabled = !b;
    ok.addEventListener('click', () => {
      editor.settings = { ...editor.settings, plotPaper: opts.paper, plotOrientation: opts.orientation, plotScale: opts.scale, plotMargin: opts.margin };
      saveSettings(editor.settings);
      finish(opts);
    });
    const cancel = button('Cancel');
    cancel.addEventListener('click', () => finish(null));
    m.footer.append(ok, cancel);
  });
}
