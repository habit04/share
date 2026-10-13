/**
 * Opening and saving drawings that came with an import report (io/import-report.ts): the
 * damaged-file recovery prompt, the log lines after open, and the warning before Save writes over
 * a source file whose content JCad could not keep. Used by Editor.openFile / Editor.saveFile;
 * kept here so the editor only needs a few calls.
 */
import type { DrawingState } from '../core/document';
import { readDxf, DxfReadError } from '../io/dxf';
import { importReportOf, lossCount, countOf, countLines, saveOverwriteWarning, type ImportReport } from '../io/import-report';

export type Confirm = (title: string, message: string) => Promise<boolean>;

/**
 * Read a DXF file for OPEN. A file that ends early asks "open what was readable?" and, on yes,
 * opens the readable part marked as recovered; null = the user declined. Other damage throws
 * the reader's DxfReadError (its message says what and where). `model3d` is the experimental 3D
 * setting: polyface meshes of other programs become mesh solids only when it is on (JCad's own 3D
 * solids are read either way; see io/dxf/mesh3d-read.ts).
 */
export async function readDxfForOpen(text: string, path: string | null, confirm: Confirm, model3d = false): Promise<DrawingState | null> {
  try {
    return readDxf(text, { filePath: path, model3d });
  } catch (err) {
    if (!(err instanceof DxfReadError) || !err.truncated) throw err;
    const ok = await confirm('Damaged drawing file', `${err.message} Open what was readable? The drawing opens as recovered: check it, then use Save As to keep it under a new name.`);
    if (!ok) return null;
    return readDxf(text, { filePath: path, recover: true, model3d });
  }
}

/** Show the report dialog after open? Only when something was lost, recovered or is not supported (kept-only content is just logged). */
export function reportNeedsAttention(r: ImportReport | undefined): r is ImportReport {
  return !!r && (lossCount(r) > 0 || !!r.recovered || countOf(r, 'unsupported') > 0);
}

/** Command-line lines summarising a report (after open). */
export function importReportLog(r: ImportReport): string[] {
  const out: string[] = [];
  if (r.recovered) out.push(`RECOVERED drawing: ${r.recovered.message}. Only what was readable was opened; save it with SAVEAS.`);
  const loss = lossCount(r);
  const kept = countOf(r, 'kept');
  const unsupported = countOf(r, 'unsupported');
  if (loss || kept || unsupported) {
    out.push(`${r.format} import: ${loss} object(s) dropped or simplified, ${kept} kept without being shown${unsupported ? `, ${unsupported} not supported yet` : ''}. IMPORTREPORT lists them.`);
    for (const l of countLines(r).slice(0, 8)) out.push(`  ${l}`);
  }
  return out;
}

/** Approval belongs to this import report and caller session, never just to a file name. */
const acknowledged = new WeakMap<ImportReport, Set<unknown>>();

/**
 * Before Save writes to `path`: 'save' to go ahead, 'save-as' when the user chose to keep the
 * original (the caller switches to Save As). Asks once per file and session.
 */
export async function confirmSaveOver(state: DrawingState, path: string | null, confirm: Confirm, scope: unknown = state, current: () => boolean = () => true): Promise<'save' | 'save-as'> {
  const warning = saveOverwriteWarning(state, path);
  const report = importReportOf(state);
  if (!warning || !path || !report || acknowledged.get(report)?.has(scope)) return 'save';
  const ok = await confirm('Save over the original file?', `${warning}\n\nYes saves over it; No opens Save As.`);
  if (!ok) return 'save-as';
  if (current()) {
    const approvals = acknowledged.get(report) ?? new Set<unknown>();
    approvals.add(scope);
    acknowledged.set(report, approvals);
  }
  return 'save';
}

/** The import report of the drawing state (for IMPORTREPORT). */
export { importReportOf };
