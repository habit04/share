/**
 * Save coordination for drawings: writes to one file go through the save queue in order, a save
 * older than one already written is dropped, the drawing stays bound to its newest save, edits
 * made during a save stay unsaved, and a failed save offers Retry / Save As... / Cancel.
 * The Editor's public method delegates here (its documentation is on the Editor).
 */
import { withoutUnusedLibraryBlocks } from '../../electrical/library';
import { writeDxf } from '../../io/dxf';
import { captureRevision, saveQueue } from '../savequeue';
import { applySaveResult } from '../sessions';
import { describeFileError } from '../file-errors';
import { confirmSaveOver } from '../import-open';
import { saveOverwriteWarning } from '../../io/import-report';
import { hasDwgSave } from '../drawing-save';
import type { Editor } from './editor';
import { fallbackUi, type EditorInternals } from './internals';
import { rememberRecent } from './documents';
import { model3dDwgRefusal, model3dDxfLimitRefusal, model3dDxfSaveNotes } from '../../model3d/save-guard';

export async function saveFile(ed: Editor, st: EditorInternals, saveAs: boolean, format?: 'dxf'): Promise<boolean> {
  if (!ed.fileBridge) {
    ed.log('No file access in this environment.');
    return false;
  }
  const bridge = ed.fileBridge;
  // Remember exactly which document revision goes to disk: edits made while the file
  // dialog / write is pending (or in another tab) must stay flagged as unsaved.
  const session = ed.sessions.current;
  const sessionId = session.id;
  const sessionRevision = session.revision;
  const contentGeneration = session.contentGeneration;
  const savedState = ed.doc.snapshot;
  const revision = captureRevision();
  let target = saveAs || format === 'dxf' ? null : ed.doc.filePath;
  const fileName = ed.fileName();
  const canSaveDwg = format !== 'dxf' && hasDwgSave(bridge);
  // A recovered Windows DWG can be opened in an edition that only writes DXF.
  // Keep that edition's Save behavior: choose a DXF destination for the copy.
  if (target && /\.dwg$/i.test(target) && !canSaveDwg) target = null;
  const suggest = (ed.suggestedName ?? fileName).replace(/\.dwg$/i, canSaveDwg ? '.dwg' : '.dxf');
  const sessionExists = () => ed.sessions.all.some((s) => s === session && s.contentGeneration === contentGeneration);
  const stillCurrent = () => sessionExists() && session.state === savedState && session.revision === sessionRevision;
  const changed = () => {
    ed.lastFileError = 'the drawing changed or closed while its save destination or loss warning was open';
    ed.log(`Not saved: ${ed.lastFileError}. Save again to review the current drawing.`);
    return false;
  };
  ed.lastFileError = null;
  // DXF holds the experimental 3D solids (polyface meshes with JCAD_3D data). DWG cannot: a DWG
  // destination is refused as soon as it is known, so solids are never written away silently.
  const dwgRefusal = model3dDwgRefusal(savedState);
  const refuse3d = (reason: string) => {
    ed.lastFileError = reason;
    ed.log(`Not saved: ${reason}.`);
    return false;
  };
  if (dwgRefusal && target && /\.dwg$/i.test(target)) return refuse3d(dwgRefusal);
  let path: string | null;
  let notes3d: string[] = [];
  try {
    const text = writeDxf(withoutUnusedLibraryBlocks(savedState));
    // A file JCad could not reopen is never written: solids beyond the reader's limits refuse the save
    // (the drawing stays modified). Oversized 3D histories are stored as meshes: logged, not blocking.
    const tooLarge = model3dDxfLimitRefusal(savedState, text);
    if (tooLarge) return refuse3d(tooLarge);
    // Logged after a successful write only (see below).
    notes3d = model3dDxfSaveNotes(savedState);
    // Save As picks the file first and then queues the write behind any save of that file still on its way.
    if (!target && bridge.chooseDrawingPath) {
      target = format ? await bridge.chooseDrawingPath(suggest, format) : await bridge.chooseDrawingPath(suggest);
      if (!target) return false;
    }
    if (target) {
      const dwg = /\.dwg$/i.test(target);
      if (dwg && dwgRefusal) return refuse3d(dwgRefusal);
      if (dwg && format === 'dxf') throw new Error('The DXF save destination must end in .dxf. Choose a DXF destination with Save As.');
      if (dwg && !canSaveDwg) throw new Error('DWG saving is available in the Windows desktop edition. Choose a DXF destination with Save As.');
      if (dwg && !sessionExists()) return changed();
      const needsReview = !!saveOverwriteWarning(savedState, target);
      const permitted = await confirmSaveOver(savedState, target, (t, m) => (ed.ui ?? fallbackUi).confirm(t, m), session, stillCurrent);
      if (needsReview && !stillCurrent()) return changed();
      if (permitted === 'save-as') {
        ed.log('Save As keeps the original file unchanged.');
        // Repeatedly choosing the source in Save As must keep requiring permission.
        if (!bridge.chooseDrawingPath && saveAs) return false;
        return ed.saveFile(true, format);
      }
      const r = await saveQueue.run(target, revision, async () => {
        if ((needsReview && !stillCurrent()) || (dwg && !sessionExists())) return null;
        if (!dwg) return bridge.saveDxf(target, text, suggest);
        // Never reached with solids (refused above; the state is immutable): the DWG writer would drop them.
        if (dwgRefusal) throw new Error(dwgRefusal);
        const status = await bridge.dwgExportStatus!();
        if (!sessionExists() || (needsReview && !stillCurrent())) return null;
        if (!status.available) throw new Error(`DWG saving is unavailable: ${status.reason || 'the portable DWG writer could not be loaded.'} Use Save As to save a DXF copy.`);
        return bridge.saveDwg!(target!, text);
      });
      if (r.status === 'stale') {
        ed.lastFileError = `a newer version of ${target} was saved meanwhile`;
        return false;
      }
      path = r.value;
      if (!path && dwg && (!sessionExists() || (needsReview && !stillCurrent()))) return changed();
    } else {
      path = await bridge.saveDxf(null, text, suggest);
      if (path) saveQueue.markCompleted(path, revision);
    }
  } catch (err) {
    // Nothing is marked as saved: the dirty flag and the autosave / recovery copy stay.
    const info = describeFileError(err, { action: 'save', path: target });
    ed.lastFileError = info.message;
    ed.log(`Save failed: ${info.message} The drawing is still marked as modified and its autosave copy is kept.`);
    if (!sessionExists()) return false;
    const choice = ed.hooks.saveError ? await ed.hooks.saveError(info, fileName, { saveAs: true }) : 'cancel';
    if (choice === 'cancel' || ed.sessions.current.id !== sessionId || !sessionExists()) return false;
    return ed.saveFile(choice === 'saveas' ? true : saveAs, format);
  }
  if (!path) return false;
  if ((st.savedRevisions.get(sessionId) ?? 0) > revision) {
    // A newer revision of this drawing was saved while this (slower) save ran, possibly to another
    // file: the drawing stays bound to that newer save - its file and its clean / modified state.
    ed.log(`Saved ${path} (an older revision: the drawing was saved again meanwhile and keeps that file).`);
    for (const line of notes3d) ed.log(line);
    rememberRecent(ed, path);
    return true;
  }
  st.savedRevisions.set(sessionId, revision);
  const outcome = applySaveResult(ed.sessions, ed, sessionId, savedState, path, contentGeneration);
  if (outcome === 'replaced') {
    ed.log(`Saved ${path} (another drawing replaced this tab while saving; it keeps its current file).`);
    for (const line of notes3d) ed.log(line);
    rememberRecent(ed, path);
    return true;
  }
  if (outcome === 'clean' && ed.sessions.current.id === sessionId) ed.suggestedName = null;
  ed.log(outcome === 'newer-edits' ? `Saved ${path} (edits made during the save are still unsaved).` : `Saved ${path}`);
  for (const line of notes3d) ed.log(line);
  rememberRecent(ed, path);
  ed.hooks.drawingSaved?.(sessionId, savedState, path);
  ed.notify('file');
  return true;
}
