/** PDF request ownership is captured before dialogs; exported bytes never mark a drawing saved. */
import type { Editor, FileBridge, PlotSheet } from './editor';
import type { DrawingState } from '../core/document';
import type { TextGeometryContext } from '../core/text-metrics';
import { textStylesOf } from '../io/encoding';
import { renderSettings, type ImageLoader } from '../render/draw';
import { SaveAdmission, hasSaveAdmissions, committedSaveAdmissionError } from './save-admission';
import { normalizePath } from './paths';
import { registerCapturedXrefContext } from './plot-fonts';
import type { ResolvedXrefContext } from './xref-resolved';

export interface CapturedPlot {
  readonly state: DrawingState;
  readonly base: string;
  readonly bridge: FileBridge | null;
  readonly geometry?: TextGeometryContext;
  readonly vectorGeometry?: TextGeometryContext;
  readonly pdfFont?: FileBridge['pdfFont'];
  readonly imageLoader?: ImageLoader;
  /** The confined underlay byte source frozen at capture (P28): the plot builds its own resolver over the captured state. */
  readonly underlayBytes?: import('./underlay-render').UnderlayByteSource;
  /**
   * The resolved xref context frozen at capture (P20 slice 1, design
   * sections 4.1 + 3.5): the registry's context for the plotted document's
   * session stamp at the moment the state was frozen, or null when the
   * document has no live graph. A later reload commits a NEW context into
   * the registry; this capture keeps expanding the generation it pinned.
   */
  readonly xref?: ResolvedXrefContext | null;
  /**
   * The PDF security decision frozen at capture (milestone 12.4): 'none' for
   * ordinary exports, 'restricted-p2' when the user opted into the
   * editing-restrictions mode for THIS plot. It is read from the plot choice
   * at capture time and never from live settings afterwards, so changing the
   * dialog or the drawing mid-export cannot change an in-flight export.
   */
  readonly security: 'none' | 'restricted-p2';
}

/** Capture after the plot-options choice, before its destination picker or any producer awaits. */
export function capturePlot(ed: Editor, bridge: FileBridge | null = ed.fileBridge ?? null, security: CapturedPlot['security'] = 'none'): CapturedPlot {
  const state = ed.doc.snapshot;
  // Editor-shaped test doubles may carry no sessions/shxResources at all;
  // the pre-wiring code short-circuited on `ed.shxResources?.` before ever
  // evaluating `ed.sessions.current`, and that contract is preserved here.
  const session = ed.shxResources ? ed.sessions.current : undefined;
  const resources = session ? ed.shxResources?.for(session) : undefined, styles = textStylesOf(state);
  // Pin the xref context for THIS session stamp at capture time. The
  // registry refuses a stamp mismatch itself (currentContextFor returns
  // null), so a capture can never freeze another document's graph or a
  // generation other than the one the session is bound to right now.
  const xref = session ? ed.xrefSessions?.currentContextFor({ docId: session.docId, contentGeneration: session.contentGeneration }) ?? null : null;
  registerCapturedXrefContext(state, xref);
  return Object.freeze({ state, bridge, base: ed.fileName().replace(/\.[^.]+$/, ''), geometry: resources?.capture(styles), vectorGeometry: resources?.capture(styles, true),
    pdfFont: bridge?.platform === 'win32' ? bridge.pdfFont?.bind(bridge) : undefined, imageLoader: renderSettings.imageLoader, underlayBytes: renderSettings.underlayBytes, xref, security });
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
  /**
   * Save a vector PDF. With `restricted` (milestone 12.4: the preview/print
   * face requests this captured plot actually used), the frozen buffer's
   * SHA-256 + length and those claims are registered with main against the
   * bound ticket first, and the save call carries the matching digest claim;
   * main consumes the registration against the received bytes and only then
   * transforms. Without it this is exactly the ordinary save.
   */
  async savePdf(bytes: Uint8Array, name: string, restricted?: { faces: readonly import('../core/text-metrics').FontMetricsRequest[] }): Promise<string | null> {
    this.active(); const save = this.bridge?.savePdf;
    if (!save) throw new Error('Plotting is not available here.');
    const opts = this.options;
    if (this.enabled && !opts) throw new Error('Choose and bind a PDF destination before producing this export.');
    if (restricted) {
      if (!opts || !this.bridge?.registerRestrictedPdf) throw new Error('Restricted PDF export requires the Windows desktop host.');
      if (!restricted.faces.length) throw new Error('Restricted PDF export requires at least one preview/print font.');
      const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
      const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      const claim = { sha256, byteLength: bytes.byteLength };
      await this.bridge.registerRestrictedPdf(opts.admission, { path: opts.path, ...claim, faces: restricted.faces });
      this.active();
      return this.writing(() => save.call(this.bridge, bytes, name, { ...opts, restricted: claim }));
    }
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
