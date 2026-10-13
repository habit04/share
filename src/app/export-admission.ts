/** PDF request ownership is captured before dialogs; exported bytes never mark a drawing saved. */
import type { Editor, FileBridge, PlotSheet } from './editor';
import type { DrawingState } from '../core/document';
import type { TextGeometryContext } from '../core/text-metrics';
import { textStylesOf } from '../io/encoding';
import { renderSettings, type ImageLoader } from '../render/draw';
import { SaveAdmission, hasSaveAdmissions, committedSaveAdmissionError } from './save-admission';
import { normalizePath } from './paths';

export interface CapturedPlot {
  readonly state: DrawingState;
  readonly base: string;
  readonly bridge: FileBridge | null;
  readonly geometry?: TextGeometryContext;
  readonly vectorGeometry?: TextGeometryContext;
  readonly pdfFont?: FileBridge['pdfFont'];
  readonly imageLoader?: ImageLoader;
}

/** Capture after the plot-options choice, before its destination picker or any producer awaits. */
export function capturePlot(ed: Editor, bridge: FileBridge | null = ed.fileBridge ?? null): CapturedPlot {
  const state = ed.doc.snapshot;
  const resources = ed.shxResources?.for(ed.sessions.current), styles = textStylesOf(state);
  return Object.freeze({ state, bridge, base: ed.fileName().replace(/\.[^.]+$/, ''), geometry: resources?.capture(styles), vectorGeometry: resources?.capture(styles, true),
    pdfFont: bridge?.platform === 'win32' ? bridge.pdfFont?.bind(bridge) : undefined, imageLoader: renderSettings.imageLoader });
}

export class ExportAdmission {
  readonly enabled: boolean;
  readonly ready: Promise<void>;
  private readonly admission: SaveAdmission | null;
  private destination: string | null = null;
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly writes = new Set<Promise<string | null>>();

  constructor(private readonly bridge: FileBridge | null, capture = true) {
    const modern = capture && bridge?.platform === 'win32' && typeof bridge.choosePdfPath === 'function';
    this.enabled = !!modern;
    this.admission = modern && hasSaveAdmissions(bridge) ? new SaveAdmission(bridge, 'pdf-export') : null;
    this.ready = this.admission?.ready ?? (modern ? Promise.reject(new Error('The Windows PDF export host requires guarded save admissions.')) : Promise.resolve());
    void this.ready.catch(() => {});
  }
  get options(): { path: string; admission: string } | undefined {
    return this.enabled && this.destination && this.admission?.ticket ? { path: this.destination, admission: this.admission.ticket } : undefined;
  }
  private active(): void { if (this.closed) throw new Error('This PDF export has already been released.'); }
  async choose(name: string): Promise<boolean> {
    await this.ready; this.active();
    if (!this.enabled) return true;
    if (this.destination) return true;
    const path = await this.bridge!.choosePdfPath!(name, this.admission!.ticket); this.active();
    if (!path) return false;
    await this.admission!.bind(path); this.active(); this.destination = path;
    return true;
  }
  private async verified(path: string | null): Promise<string | null> {
    if (path && this.enabled) {
      if (!this.destination || normalizePath(path) !== normalizePath(this.destination)) throw committedSaveAdmissionError('The PDF export returned another destination. Review its completed replacement before exporting again.');
      if (!this.bridge?.saveAdmissionResult) throw committedSaveAdmissionError('The PDF export commit receipt is unavailable. Review the destination before exporting again.');
      await this.admission!.confirmSaved(path);
    }
    return path;
  }
  private writing(operation: () => Promise<string | null>): Promise<string | null> {
    const task = (async () => this.verified(await operation()))();
    this.writes.add(task);
    void task.then(() => this.writes.delete(task), () => this.writes.delete(task));
    return task;
  }
  async savePdf(bytes: Uint8Array, name: string): Promise<string | null> {
    this.active(); const save = this.bridge?.savePdf;
    if (!save) throw new Error('Plotting is not available here.');
    const opts = this.options;
    if (this.enabled && !opts) throw new Error('Choose and bind a PDF destination before producing this export.');
    return this.writing(() => opts ? save.call(this.bridge, bytes, name, opts) : save.call(this.bridge, bytes, name));
  }
  async plotPdf(dataUrl: string, name: string, landscape: boolean, sheet: PlotSheet): Promise<string | null> {
    this.active(); const plot = this.bridge?.plotPdf;
    if (!plot) throw new Error('Plotting is not available here.');
    const opts = this.options;
    if (this.enabled && !opts) throw new Error('Choose and bind a PDF destination before producing this export.');
    return this.writing(() => opts ? plot.call(this.bridge, dataUrl, name, landscape, sheet, opts) : plot.call(this.bridge, dataUrl, name, landscape, sheet));
  }
  /** Concurrent cancellation and finally cleanup join the same host cleanup. */
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.closed = true;
      try { await this.ready; } catch { /* Failed reservation has nothing to release. */ }
      await this.admission?.close();
      await Promise.allSettled([...this.writes]);
    })();
  }
}

export interface PlotExportContext { readonly captured: CapturedPlot; readonly admission: ExportAdmission }
