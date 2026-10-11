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
import type { Editor } from './editor';
import { fallbackUi, type EditorInternals } from './internals';
import { rememberRecent } from './documents';

export async function saveFile(ed: Editor, st: EditorInternals, saveAs: boolean): Promise<boolean> {
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
      const stillCurrent = () => ed.sessions.all.some((s) => s === session && s.state === savedState && s.revision === sessionRevision);
      const needsReview = !!saveOverwriteWarning(savedState, target);
      const permitted = await confirmSaveOver(savedState, target, (t, m) => (ed.ui ?? fallbackUi).confirm(t, m), session, stillCurrent);
      if (needsReview && !stillCurrent()) {
        ed.lastFileError = 'the drawing changed or closed while its save destination or loss warning was open';
        ed.log(`Not saved: ${ed.lastFileError}. Save again to review the current drawing.`);
        return false;
      }
      if (permitted === 'save-as') {
        ed.log('Save As keeps the original file unchanged.');
        // Repeatedly choosing the source in Save As must keep requiring permission.
        if (!bridge.chooseDrawingPath && saveAs) return false;
        return ed.saveFile(true);
      }
      const r = await saveQueue.run(target, revision, () => !needsReview || stillCurrent() ? bridge.saveDxf(target, text, suggest) : Promise.resolve(null));
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
  const outcome = applySaveResult(ed.sessions, ed, sessionId, savedState, path, contentGeneration);
  if (outcome === 'replaced') {
    ed.log(`Saved ${path} (another drawing replaced this tab while saving; it keeps its current file).`);
    rememberRecent(ed, path);
    return true;
  }
  if (outcome === 'clean' && ed.sessions.current.id === sessionId) ed.suggestedName = null;
  ed.log(outcome === 'newer-edits' ? `Saved ${path} (edits made during the save are still unsaved).` : `Saved ${path}`);
  rememberRecent(ed, path);
  ed.hooks.drawingSaved?.(sessionId, savedState, path);
  ed.notify('file');
  return true;
}
