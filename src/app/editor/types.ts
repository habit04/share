/**
 * The Editor's types: events, command definitions, the file bridge to the desktop app (or the
 * browser), what an open returns, and the UI hooks main.ts provides.
 */
import type { DwgImportPayload } from '../../io/dwg';
import type { ImportReport } from '../../io/import-report';
import type { DrawingState } from '../../core/document';
import type { SheetSize } from '../../electrical/templates';
import type { PlcModuleSettings, TerminalStripSettings } from '../../tools/plc';
import type { ElectricalUi } from '../../electrical/ui';
import type { SymbolBuilderUi } from '../../tools/symbol-builder';
import type { FileErrorInfo } from '../file-errors';
import type { PlotOptions } from '../plot';
import type { Editor } from './editor';
import type { GpuDiagnostics } from '../gpu-diagnostics';

export type EditorEvent = 'change' | 'selection' | 'tool' | 'view' | 'snap' | 'file' | 'log' | 'space' | 'project';

export interface CommandDef {
  name: string;
  aliases: string[];
  description: string;
  run: (editor: Editor, arg?: string) => void | Promise<void>;
  /** The command starts a Tool (which logs "Command: NAME" itself). */
  startsTool?: boolean;
}

export interface SelectionRequest {
  prompt: string;
  onDone: (ids: string[]) => void;
  ids: Set<string>;
}

export type OpenResult =
  /** `encoding`: the code page the DXF bytes were decoded from ($DWGCODEPAGE / BOM), when the desktop build detected one. */
  | { path: string; identityPath?: string; openedSourceProof?: string; kind: 'dxf'; text: string; encoding?: string }
  | { path: string; identityPath?: string; openedSourceProof?: string; kind: 'dwg'; payload: DwgImportPayload; version?: string };

/** Runtime source context; authoritative byte/version evidence stays in the Windows host. */
export interface OpenedSourceHint {
  proof: string | null;
  path: string | null;
  mode: 'in-place' | 'save-as';
}

/** Sheet size in inches (already oriented) plus Electron's named page size when there is one. */
export interface PlotSheet {
  width: number;
  height: number;
  electron?: string;
}

/** Result of FileBridge.backupFile (`backup-file`, electron/main/ipc-drawings.cjs). */
export type BackupResult = { ok: true; path: string } | { ok: false; error: string; code?: string | null };

/** What the user chose in the save error dialog (src/ui/save-error.ts). */
export type SaveErrorChoice = 'retry' | 'saveas' | 'cancel';

export interface FileBridge {
  /** Optional desktop capability summary; absent in browser previews and older builds. */
  gpuDiagnostics?(): Promise<GpuDiagnostics>;
  /** Desktop platform; absent for the browser file bridge. */
  platform?: string;
  /** Windows host order, captured before slow serialization, pickers or conversion. */
  issueSaveAdmission?(kind: 'drawing' | 'project' | 'export-copy' | 'text-export' | 'pdf-export'): Promise<string>;
  /** Missing leaves are provisional candidates, rather than immutable native alias evidence. */
  bindSaveAdmission?(ticket: string, kind: 'drawing' | 'project' | 'export-copy' | 'text-export' | 'pdf-export', path: string, source?: OpenedSourceHint): Promise<string | { identityPath: string; exists: boolean }>;
  /** Release unused/closed runtime read evidence; presence identifies a source-proof-capable host. */
  releaseOpenedSourceProof?(proof: string): Promise<void>;
  cancelSaveAdmission?(ticket: string, kind: 'drawing' | 'project' | 'export-copy' | 'text-export' | 'pdf-export'): Promise<void>;
  /** Resolve only a path already readable through native/project grants. */
  resolvePathIdentity?(path: string): Promise<string | null>;
  /** Consume host-proven identity from this completed commit; no fresh path lookup. */
  saveAdmissionResult?(ticket: string): Promise<{ path: string; identityPath: string; openedSourceProof?: string } | null>;
  /** One Windows host order covers a bounded project calculation before any snapshots or reads. */
  issueProjectSaveBatch?(): Promise<string>;
  bindProjectSaveBatch?(batch: string, paths: string[]): Promise<import('../project-save-batch').ProjectBatchBinding[]>;
  /** Read the original bound DXF version; later writes cannot supply a different calculation input. */
  openProjectSaveBatchDrawing?(batch: string, childTicket: string): Promise<OpenResult>;
  sealProjectSaveBatch?(batch: string, selectedChildTickets: string[]): Promise<void>;
  beginProjectSaveBatchCommit?(batch: string, remainingChildTickets?: string[]): Promise<void>;
  /** Cancellation joins the batch's active read/copy/write cleanup. */
  cancelProjectSaveBatch?(batch: string): Promise<void>;
  /** Native picker: no renderer-supplied file path or search root. */
  openShxFont?(): Promise<import('../../render/shx-fonts').ShxResource | null>;
  /** Windows only: licensed installed programs for this PDF plot, never drawing data. */
  pdfFont?(request: import('../../core/text-metrics').FontMetricsRequest): Promise<import('../pdf-fonts').PdfFontResult>;
  openDxf(): Promise<{ path: string; identityPath?: string; openedSourceProof?: string; text: string } | null>;
  /** Desktop only: open DXF or DWG (DWG parsed by LibreDWG in the main process). */
  openDrawing?(file?: string): Promise<OpenResult | null>;
  /**
   * Write a drawing. The desktop app keeps the previous file as `<path>.bak`; `opts.backup: false`
   * skips that copy (a project-wide command made its own, or the user chose to write without one).
   */
  saveDxf(path: string | null, text: string, suggestName: string, opts?: { backup?: boolean; admission?: string }): Promise<string | null>;
  /**
   * Desktop only: ask where to save a drawing (Save As); the path is not written yet. With it, a
   * Save As is written through the per-file save queue like every other save of that file.
   */
  chooseDrawingPath?(suggestName: string, format?: 'dxf'): Promise<string | null>;
  /** Windows only: whether the packaged portable DWG writer is available. */
  dwgExportStatus?(): Promise<{ available: boolean; reason?: string }>;
  /** Windows only: save a captured drawing to an authorized DWG path, with verification and backup. */
  saveDwg?(path: string, text: string, admission?: string): Promise<string | null>;
  /** Windows only: choose a DWG export destination without writing it yet. */
  chooseDwgPath?(suggestName: string): Promise<string | null>;
  /** Windows only: write a DWG copy of the captured DXF with the packaged portable writer. */
  exportDwg?(path: string, text: string, admission?: string): Promise<string | null>;
  /**
   * Read a project file: through the Open Project dialog without `file`, else by name. `userChosen`
   * is a compatibility hint only; the main process controls authorization from native choices.
   * `textOnly`: the dialog reads a JSON file for its text.
   */
  openProject?(file?: string, opts?: { userChosen?: boolean; textOnly?: boolean }): Promise<{ path: string; text: string } | null>;
  saveText?(suggestName: string, text: string, filterName: string, ext: string, opts?: { admission?: string }): Promise<string | null>;
  /**
   * Desktop only: copy a drawing/project file to `<path>.bak` before it is rewritten. Answers
   * `{ ok, path }` / `{ ok: false, error }`; older builds answered the copy's path (or null on failure).
   */
  backupFile?(path: string, opts?: { admission?: string }): Promise<BackupResult | LegacyBackupResult>;
  /** Desktop only: ask where to save the project (Save As); the path is not written yet. */
  chooseProjectPath?(suggestName: string): Promise<string | null>;
  /** Desktop only: write the project file to a path chosen before (no dialog); returns the path written. */
  saveProject?(path: string, text: string, admission?: string): Promise<string | null>;
  choosePdfPath?(suggestName: string, admission?: string): Promise<string | null>;
  plotPdf?(dataUrl: string, suggestName: string, landscape: boolean, sheet?: PlotSheet, opts?: { path?: string; admission?: string }): Promise<string | null>;
  /** Print the rendered sheet through the system print dialog; resolves true when a job was sent. */
  printDrawing?(dataUrl: string, title: string, landscape: boolean, sheet?: PlotSheet): Promise<boolean>;
  /** Save finished PDF bytes (vector plot, app/plot-vector.ts); resolves the written path or null. */
  savePdf?(bytes: Uint8Array, suggestName: string, opts?: { path?: string; admission?: string }): Promise<string | null>;
}

/** What older desktop builds answered from `backup-file`: the .bak path, or null / false on failure. */
export type LegacyBackupResult = string | boolean | null | undefined;

/** Did a backup succeed? Accepts `{ ok, path }` / `{ ok: false, error }` and the older answers. */
export function backupOutcome(r: BackupResult | LegacyBackupResult): { ok: boolean; error?: string } {
  const failed = 'the backup copy could not be written';
  if (r && typeof r === 'object') return r.ok === true ? { ok: true } : { ok: false, error: typeof r.error === 'string' && r.error ? r.error : failed };
  if (typeof r === 'string') return r ? { ok: true } : { ok: false, error: failed };
  if (r === true) return { ok: true };
  return { ok: false, error: failed };
}

/** Extra UI hooks provided by main.ts (Editor.hooks). */
export interface EditorHooks {
  reports?: (key: string) => void;
  template?: () => Promise<{ size: SheetSize; fields: Record<string, string> } | null>;
  plc?: (init: PlcModuleSettings) => Promise<PlcModuleSettings | null>;
  terminalStrip?: (init: TerminalStripSettings) => Promise<TerminalStripSettings | null>;
  wireType?: (current: string) => Promise<string | null>;
  properties?: () => void;
  projectChanged?: () => void;
  /** AutoCAD Electrical-style dialogs (see src/electrical/ui.ts); defaults come from src/ui/electrical-dialogs.ts. */
  electrical?: ElectricalUi;
  /** Symbol Builder start dialog and palette (src/ui/symbol-builder.ts). */
  symbolBuilder?: SymbolBuilderUi;
  /** Plot / Print dialog (paper, orientation, scale, margins and which output); null = cancelled. */
  plot?: (mode: 'pdf' | 'print') => Promise<{ options: PlotOptions; action: 'pdf' | 'print' } | null>;
  /** A save failed: show why and offer Retry / Save As... / Cancel (src/ui/save-error.ts). */
  saveError?: (info: FileErrorInfo, fileName: string, opts: { saveAs: boolean }) => Promise<SaveErrorChoice>;
  /** A drawing save completed: revision `state` of session `sessionId` is on disk (autosave bookkeeping). */
  drawingSaved?: (sessionId: number, state: DrawingState, path: string) => void;
  /** Import report dialog (src/ui/import-report.ts): shown after OPEN when content was lost, and by IMPORTREPORT. */
  importReport?: (report: ImportReport, fileName: string) => void;
}
