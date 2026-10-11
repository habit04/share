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
import type { Editor } from './editor';
import { fallbackUi, type EditorInternals } from './internals';
import { rememberRecent } from './documents';

export async function saveFile(ed: Editor, st: EditorInternals, saveAs: boolean): Promise<boolean> {
  if (!ed.fileBridge) {
    ed.log('No file access in this environment.');
    return false;
  }
  // Saving over a source file that held content JCad could not keep (or a recovered file) asks first.
  if (!saveAs && ed.doc.filePath && (await confirmSaveOver(ed.doc.snapshot, ed.doc.filePath, (t, m) => (ed.ui ?? fallbackUi).confirm(t, m))) === 'save-as') {
    ed.log('Save As keeps the original file unchanged.');
    return ed.saveFile(true);
  }
  const bridge = ed.fileBridge;
  // Remember exactly which document revision goes to disk: edits made while the file
  // dialog / write is pending (or in another tab) must stay flagged as unsaved.
  const sessionId = ed.sessions.current.id;
  const savedState = ed.doc.snapshot;
  const revision = captureRevision();
  let target = saveAs ? null : ed.doc.filePath;
  const fileName = ed.fileName();
  const suggest = ed.suggestedName ?? fileName;
  ed.lastFileError = null;
  let path: string | null;
  try {
    const text = writeDxf(withoutUnusedLibraryBlocks(savedState));
    // Save As picks the file first and then queues the write behind any save of that file still on its way.
    if (!target && bridge.chooseDrawingPath) {
      target = await bridge.chooseDrawingPath(suggest);
      if (!target) return false;
    }
    if (target) {
      const r = await saveQueue.run(target, revision, () => bridge.saveDxf(target, text, suggest));
      if (r.status === 'stale') {
        ed.lastFileError = `a newer version of ${target} was saved meanwhile`;
        return false;
      }
      path = r.value;
    } else {
      path = await bridge.saveDxf(null, text, suggest);
      if (path) saveQueue.markCompleted(path, revision);
    }
  } catch (err) {
    // Nothing is marked as saved: the dirty flag and the autosave / recovery copy stay.
    const info = describeFileError(err, { action: 'save', path: target });
    ed.lastFileError = info.message;
    ed.log(`Save failed: ${info.message} The drawing is still marked as modified and its autosave copy is kept.`);
    const choice = ed.hooks.saveError ? await ed.hooks.saveError(info, fileName, { saveAs: true }) : 'cancel';
    if (choice === 'cancel' || ed.sessions.current.id !== sessionId) return false;
    return ed.saveFile(choice === 'saveas' ? true : saveAs);
  }
  if (!path) return false;
  if ((st.savedRevisions.get(sessionId) ?? 0) > revision) {
    // A newer revision of this drawing was saved while this (slower) save ran, possibly to another
    // file: the drawing stays bound to that newer save - its file and its clean / modified state.
    ed.log(`Saved ${path} (an older revision: the drawing was saved again meanwhile and keeps that file).`);
    rememberRecent(ed, path);
    return true;
  }
  st.savedRevisions.set(sessionId, revision);
  const outcome = applySaveResult(ed.sessions, ed, sessionId, savedState, path);
  if (outcome === 'clean' && ed.sessions.current.id === sessionId) ed.suggestedName = null;
  ed.log(outcome === 'newer-edits' ? `Saved ${path} (edits made during the save are still unsaved).` : `Saved ${path}`);
  rememberRecent(ed, path);
  ed.hooks.drawingSaved?.(sessionId, savedState, path);
  ed.notify('file');
  return true;
}
