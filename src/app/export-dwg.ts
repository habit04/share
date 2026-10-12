/**
 * Explicit DWG copies on Windows. The portable writer converts a captured DXF; an export never
 * changes the working drawing's file binding, dirty state, undo history or recovery checkpoint.
 */
import { withoutUnusedLibraryBlocks } from '../electrical/library';
import { writeDxf } from '../io/dxf';
import { countOf, importReportOf, saveOverwriteWarning } from '../io/import-report';
import { samePath } from './paths';
import { captureRevision, saveQueue } from './savequeue';
import { describeFileError } from './file-errors';
import type { Editor, FileBridge } from './editor';
import type { DrawingState } from '../core/document';

type DwgExportBridge = FileBridge & Required<Pick<FileBridge, 'dwgExportStatus' | 'chooseDwgPath' | 'exportDwg'>>;

/** Capability comes from the desktop bridge, never a browser's Windows user agent. */
export function hasDwgExport(bridge: FileBridge | null): bridge is DwgExportBridge {
  return bridge?.platform === 'win32' && typeof bridge.dwgExportStatus === 'function' && typeof bridge.chooseDwgPath === 'function' && typeof bridge.exportDwg === 'function';
}

/** Registered after main.ts attaches the bridge, so HELP and command completion match the OS. */
export function registerDwgExportCommand(editor: Editor): void {
  if (!hasDwgExport(editor.fileBridge)) return;
  editor.register({
    name: 'EXPORTDWG',
    aliases: [],
    description: 'Export a DWG copy with the portable writer (Windows)',
    run: async (ed) => { await exportDwgCopy(ed); },
  });
}

function overwriteWarning(state: DrawingState, path: string): string | null {
  const loss = saveOverwriteWarning(state, path);
  if (loss) return loss;
  const report = importReportOf(state);
  if (report?.format === 'DWG' && report.sourcePath && samePath(report.sourcePath, path) && countOf(report, 'unsupported')) {
    return 'The original DWG contains properties JCad cannot read (see IMPORTREPORT). Exporting the current drawing cannot restore them and may remove them from the original file.';
  }
  return null;
}

export async function exportDwgCopy(ed: Editor): Promise<boolean> {
  const bridge = ed.fileBridge;
  if (!hasDwgExport(bridge)) {
    ed.log('DWG export is available in the Windows desktop edition. Use Save As to save a DXF copy in this edition.');
    return false;
  }
  // All awaits export this exact immutable revision. Replacing a tab while a picker or warning
  // is open must never authorize writing another drawing over the selected destination.
  const session = ed.sessions.current;
  const state = ed.doc.snapshot;
  const sessionRevision = session.revision;
  const generation = session.contentGeneration;
  const revision = captureRevision();
  const suggest = (ed.suggestedName ?? ed.fileName()).replace(/\.(?:dxf|dwg)$/i, '') + '.dwg';
  const sessionExists = () => ed.sessions.all.some((s) => s === session && s.contentGeneration === generation);
  const unchanged = () => sessionExists() && session.state === state && session.revision === sessionRevision;
  const changed = () => {
    ed.log('DWG export canceled: the drawing changed or closed while choosing the destination or reviewing the warning. Export again to use the current drawing.');
    return false;
  };
  let target: string | null = null;
  try {
    const status = await bridge.dwgExportStatus();
    if (!unchanged()) return changed();
    if (!status.available) {
      ed.log(`DWG export unavailable: ${status.reason || 'the portable DWG writer could not be loaded.'} Use Save As to save a DXF copy.`);
      return false;
    }
    for (;;) {
      target = await bridge.chooseDwgPath(suggest);
      if (!target) return false;
      if (!unchanged()) return changed();
      const warning = overwriteWarning(state, target);
      if (!warning) break;
      // Ask every time the original is selected; no previous SAVE acknowledgment authorizes
      // a DWG export to replace a source file with content the importer could not keep.
      if (!ed.ui) {
        ed.log('DWG export canceled: replacing the original requires confirmation of the import losses. Choose a different destination with the desktop interface.');
        return false;
      }
      const approved = await ed.ui.confirm('Replace the original DWG?', `${warning}\n\nYes replaces it with the exported copy; No chooses another destination. DWG export cannot recover content already lost during import.`);
      if (!unchanged()) return changed();
      if (approved) break;
    }
    const text = writeDxf(withoutUnusedLibraryBlocks(state));
    const sourceOverwrite = !!overwriteWarning(state, target);
    const result = await saveQueue.run(target, revision, () => {
      if (!sessionExists() || (sourceOverwrite && !unchanged())) return Promise.resolve(null);
      ed.log('Exporting a DWG copy. The working drawing remains a DXF document; save it separately to keep edits and recovery records current.');
      return bridge.exportDwg(target!, text);
    });
    if (result.status === 'stale') {
      ed.log(`DWG export skipped: a newer drawing revision was already written to ${target}.`);
      return false;
    }
    if (!result.value) {
      if (!sessionExists() || (sourceOverwrite && !unchanged())) return changed();
      return false;
    }
    const suffix = !sessionExists() ? ' (the exported drawing closed or was replaced meanwhile)' : !unchanged() ? ' (edits made during export are not in this copy)' : '';
    ed.log(`Exported DWG copy: ${result.value}${suffix}. Save the working drawing separately as DXF.`);
    return true;
  } catch (err) {
    const info = describeFileError(err, { action: 'save', path: target });
    ed.log(`DWG export failed: ${info.message} The working drawing and its recovery copy are kept.`);
    return false;
  }
}
