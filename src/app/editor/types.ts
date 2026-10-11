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

export type EditorEvent = 'change' | 'selection' | 'tool' | 'view' | 'snap' | 'file' | 'log' | 'space' | 'project';

export interface CommandDef {
  name: string;
  aliases: string[];
  description: string;
  run: (editor: Editor, arg?: string) => void;
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
  | { path: string; kind: 'dxf'; text: string; encoding?: string }
  | { path: string; kind: 'dwg'; payload: DwgImportPayload; version?: string };

/** Sheet size in inches (already oriented) plus Electron's named page size when there is one. */
export interface PlotSheet {
  width: number;
  height: number;
  electron?: string;
}

/** Result of FileBridge.backupFile (electron/main.cjs `backup-file`). */
export type BackupResult = { ok: true; path: string } | { ok: false; error: string; code?: string | null };

/** What the user chose in the save error dialog (src/ui/save-error.ts). */
export type SaveErrorChoice = 'retry' | 'saveas' | 'cancel';

export interface FileBridge {
  openDxf(): Promise<{ path: string; text: string } | null>;
  /** Desktop only: open DXF or DWG (DWG parsed by LibreDWG in the main process). */
  openDrawing?(file?: string): Promise<OpenResult | null>;
  /**
   * Write a drawing. The desktop app keeps the previous file as `<path>.bak`; `opts.backup: false`
   * skips that copy (a project-wide command made its own, or the user chose to write without one).
   */
  saveDxf(path: string | null, text: string, suggestName: string, opts?: { backup?: boolean }): Promise<string | null>;
  /**
   * Desktop only: ask where to save a drawing (Save As); the path is not written yet. With it, a
   * Save As is written through the per-file save queue like every other save of that file.
   */
  chooseDrawingPath?(suggestName: string): Promise<string | null>;
  /**
   * Read a project file: through the Open Project dialog without `file`, else by name. `userChosen`:
   * the user picked it (Recent Documents); its drawings outside the project folder may then be
   * written too (electron/path-registry.cjs). `textOnly`: the dialog reads a JSON file for its text.
   */
  openProject?(file?: string, opts?: { userChosen?: boolean; textOnly?: boolean }): Promise<{ path: string; text: string } | null>;
  saveText?(suggestName: string, text: string, filterName: string, ext: string): Promise<string | null>;
  /**
   * Desktop only: copy a drawing/project file to `<path>.bak` before it is rewritten. Answers
   * `{ ok, path }` / `{ ok: false, error }`; older builds answered the copy's path (or null on failure).
   */
  backupFile?(path: string): Promise<BackupResult | LegacyBackupResult>;
  /** Desktop only: ask where to save the project (Save As); the path is not written yet. */
  chooseProjectPath?(suggestName: string): Promise<string | null>;
  /** Desktop only: write the project file to a path chosen before (no dialog); returns the path written. */
  saveProject?(path: string, text: string): Promise<string | null>;
  plotPdf?(dataUrl: string, suggestName: string, landscape: boolean, sheet?: PlotSheet): Promise<string | null>;
  /** Print the rendered sheet through the system print dialog; resolves true when a job was sent. */
  printDrawing?(dataUrl: string, title: string, landscape: boolean, sheet?: PlotSheet): Promise<boolean>;
  /** Save finished PDF bytes (vector plot, app/plot-vector.ts); resolves the written path or null. */
  savePdf?(bytes: Uint8Array, suggestName: string): Promise<string | null>;
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
