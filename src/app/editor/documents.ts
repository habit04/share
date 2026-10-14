/**
 * Documents and tabs: new drawings, opening a drawing (DXF or DWG) into the tab that started the
 * open (or a new tab when that one changed meanwhile), files already open in a tab, import
 * reports, the Save / Don't Save / Cancel question and the recent-files list.
 * The Editor's public methods delegate here (their documentation is on the Editor).
 */
import { Drawing } from '../../core/document';
import type { DrawingState } from '../../core/document';
import { WIRE_DOT } from '../../electrical/symbols';
import { LIBRARY_SYMBOLS, withByBlockLibrarySymbols } from '../../electrical/library';
import { TITLE_BLOCK } from '../../electrical/templates';
import { SOURCE_ARROW, DEST_ARROW } from '../../tools/plc';
import { convertDwg } from '../../io/dwg';
import { isAbsolutePath, registerWindowsPathIdentity } from '../paths';
import { saveSettings, pushRecent } from '../settings';
import { describeFileError } from '../file-errors';
import { readDxfForOpen, reportNeedsAttention, importReportLog, importReportOf } from '../import-open';
import { hasDwgSave } from '../drawing-save';
import type { Editor } from './editor';
import { fallbackUi } from './internals';
import type { DocumentSession } from '../sessions';
import { adoptOpenedSourceProof, releaseOpenedSourceProof } from '../opened-source-proof';

/**
 * Why an open failed: file errors in plain words ("... could not be read: the folder is not
 * available"), anything else (a damaged DXF, an unknown path) with its own message.
 */
export function openErrorText(err: unknown, path?: string | null): string {
  const info = describeFileError(err, { action: 'read', path: path ?? null });
  return info.kind !== 'unknown' ? info.message : info.detail;
}

/** Where an opened drawing went (Editor.deliverOpened) and what the log says about it. */
export type OpenedWhere = 'active' | 'background' | 'new-tab' | 'new-background-tab';
const OPENED_WHERE: Record<OpenedWhere, string> = {
  active: '',
  background: ' (in the tab it was opened from)',
  'new-tab': ' (in a new tab: the tab it was opened from changed meanwhile)',
  'new-background-tab': ' (in a new tab in the background: the tab it was opened from changed meanwhile)',
};

export async function confirmDiscard(ed: Editor): Promise<boolean> {
  if (!ed.doc.dirty) return true;
  const ui = ed.ui ?? fallbackUi;
  if (ui.saveChanges) {
    const r = await ui.saveChanges(ed.fileName());
    if (r === 'cancel') return false;
    if (r === 'save') return (await ed.saveFile(false)) && !ed.doc.dirty;
    return true;
  }
  return ui.confirm('Unsaved changes', `${ed.fileName()} has unsaved changes. Discard them?`);
}

export function newDrawing(ed: Editor): void {
  void confirmDiscard(ed).then((ok) => {
    if (ok) ed.newDrawingNow();
  });
}

export function newDrawingNow(ed: Editor): void {
  const fresh = new Drawing();
  ed.doc.load(fresh.snapshot, null);
  ed.doc.ensureBlocks([...LIBRARY_SYMBOLS, TITLE_BLOCK, SOURCE_ARROW, DEST_ARROW, WIRE_DOT]);
  ed.selection.clear();
  ed.viewport.zoomToBounds(null);
  ed.log('New drawing.');
  ed.notify('file');
  ed.notify('selection');
  ed.render();
}

export function loadState(ed: Editor, state: DrawingState, path: string | null): void {
  // Library symbols saved by earlier versions (ByLayer on layer 0) keep taking the reference's colour.
  ed.doc.load(withByBlockLibrarySymbols(state), path);
  ed.doc.ensureBlocks([...LIBRARY_SYMBOLS, TITLE_BLOCK, SOURCE_ARROW, DEST_ARROW, WIRE_DOT]);
  ed.selection.clear();
  ed.zoomExtents();
  ed.notify('file');
  ed.notify('selection');
}

export async function openFile(ed: Editor, file?: string): Promise<boolean> {
  if (!ed.fileBridge) {
    ed.log('No file access in this environment.');
    return false;
  }
  if (!(await confirmDiscard(ed))) return false;
  const target = ed.sessions.current;
  const targetId = target.id;
  const before = target.state;
  const bridge = ed.fileBridge;
  let unusedProof: string | undefined;
  const acceptProof = (path: string) => (session: DocumentSession, generation: number) => {
    if (!unusedProof || !ed.sessions.all.includes(session) || session.contentGeneration !== generation) return;
    if (adoptOpenedSourceProof(session, generation, bridge, unusedProof, path)) unusedProof = undefined;
  };
  try {
    if (ed.fileBridge.openDrawing) {
      ed.log(file ? `Opening ${file} ...` : 'Opening ...');
      const res = await ed.fileBridge.openDrawing(file);
      if (!res) return false;
      unusedProof = res.openedSourceProof;
      if (ed.fileBridge.platform === 'win32' && res.identityPath) registerWindowsPathIdentity(res.path, res.identityPath);
      const writableDwg = res.kind === 'dwg' && hasDwgSave(ed.fileBridge);
      if ((res.kind === 'dxf' || writableDwg) && showAlreadyOpen(ed, res.path, targetId, before)) return true;
      if (res.kind === 'dwg') {
        const { state, skipped, notes } = convertDwg(res.payload, res.path);
        const where = deliverOpened(ed, targetId, before, state, writableDwg ? res.path : null, !writableDwg, acceptProof(res.path));
        rememberRecent(ed, res.path);
        if (where === 'active' || where === 'new-tab') ed.suggestedName = writableDwg ? null : res.path.replace(/\.dwg$/i, '.dxf').split(/[\\/]/).pop() ?? null;
        const skippedText = Object.keys(skipped).length
          ? ` Skipped unsupported: ${Object.entries(skipped).map(([k, v]) => `${k}×${v}`).join(', ')}.`
          : '';
        ed.log(`Imported DWG ${res.path} (${res.version || 'unknown version'}): ${state.entities.length} entities, ${state.layers.length} layers, ${Object.keys(state.blocks).length} blocks.${skippedText}`);
        for (const n of notes) ed.log(`DWG import: ${n}`);
        ed.log(writableDwg ? 'Save writes this DWG with the portable writer. Save As can choose DWG or DXF; review the import report before replacing the original.' : 'DWG import is read-only in this edition; use SAVE to write a DXF copy next to the original.');
        ed.notify('file');
        showOpenedReport(ed, where, state, res.path);
        return true;
      }
      const state = await ed.readDxfText(res.text, res.path);
      if (!state) {
        ed.log(`Not opened: ${res.path} is damaged.`);
        return false;
      }
      // The same file may have finished opening in another tab while this one was read (RECENT twice).
      if (showAlreadyOpen(ed, res.path, targetId, before)) return true;
      // A recovered (truncated) file opens modified: Save As keeps it under a new name.
      const where = deliverOpened(ed, targetId, before, state, res.path, !!importReportOf(state)?.recovered, acceptProof(res.path));
      rememberRecent(ed, res.path);
      ed.log(`Opened ${res.path}: ${state.entities.length} entities, ${state.layers.length} layers, ${Object.keys(state.blocks).length} blocks.${res.encoding ? ` Encoding: ${res.encoding}.` : ''}${OPENED_WHERE[where]}`);
      showOpenedReport(ed, where, state, res.path);
      return true;
    }
    const res = await ed.fileBridge.openDxf();
    if (!res) return false;
    unusedProof = res.openedSourceProof;
    if (ed.fileBridge.platform === 'win32' && res.identityPath) registerWindowsPathIdentity(res.path, res.identityPath);
    const state = await ed.readDxfText(res.text, res.path);
    if (!state) {
      ed.log(`Not opened: ${res.path} is damaged.`);
      return false;
    }
    if (showAlreadyOpen(ed, res.path, targetId, before)) return true;
    const where = deliverOpened(ed, targetId, before, state, res.path, !!importReportOf(state)?.recovered, acceptProof(res.path));
    ed.log(`Opened ${res.path}: ${state.entities.length} entities, ${state.layers.length} layers, ${Object.keys(state.blocks).length} blocks.`);
    showOpenedReport(ed, where, state, res.path);
    return true;
  } catch (err) {
    ed.lastFileError = openErrorText(err, file);
    ed.log(`Failed to open drawing: ${ed.lastFileError}`);
    return false;
  } finally { await releaseOpenedSourceProof(bridge, unusedProof); }
}

export function showImportReport(ed: Editor, force: boolean, state: DrawingState, name: string): void {
  const r = importReportOf(state);
  if (!r) {
    if (force) ed.log('This drawing has no import report: nothing was dropped or simplified when it was opened.');
    return;
  }
  for (const line of importReportLog(r)) ed.log(line);
  if (force || reportNeedsAttention(r)) ed.hooks.importReport?.(r, name);
}

export function readDxfText(ed: Editor, text: string, path: string | null): Promise<DrawingState | null> {
  return readDxfForOpen(text, path, (t, m) => (ed.ui ?? fallbackUi).confirm(t, m), ed.settings.experimental3d === true && ed.settings.importForeign3d === true);
}

/** The import report of a drawing just opened, also when it went to a background tab (see deliverOpened). */
export function showOpenedReport(ed: Editor, where: OpenedWhere, state: DrawingState, path: string): void {
  if (where === 'background' || where === 'new-background-tab') ed.showImportReport(false, state, path.split(/[\\/]/).pop() ?? path);
  else ed.showImportReport(false);
}

/**
 * The file picked in the Open dialog (or a second RECENT click) is already open in a tab: show
 * that tab instead of a second copy, whose saves would overwrite each other. Re-opening the file
 * into the very tab that holds it, unchanged since the open started, is a reload and goes ahead.
 */
export function showAlreadyOpen(ed: Editor, path: string, targetId: number, before: DrawingState): boolean {
  // The browser build only knows file names (two "a.dxf" from different folders are different files).
  if (!isAbsolutePath(path)) return false;
  const k = ed.sessions.indexOfPath(path);
  if (k < 0) return false;
  const s = ed.sessions.all[k]!;
  if (s.id === targetId && s.state === before) return false;
  // Only move the user when they are still looking at the tab the open was started from.
  if (ed.sessions.current.id === targetId) ed.sessions.switchTo(k);
  rememberRecent(ed, path);
  ed.log(`${path} is already open (tab ${k + 1}: ${ed.sessions.titleOf(k)}).`);
  return true;
}

/**
 * Put an opened drawing into tab `targetId` (see openFile); returns where it went. A new tab is
 * only brought to the front when the user is still on the tab the open started from: someone
 * working in another tab meanwhile keeps working there (no command or click lands in the new one).
 */
export function deliverOpened(ed: Editor, targetId: number, before: DrawingState, state: DrawingState, path: string | null, dirty: boolean, accepted?: (session: DocumentSession, generation: number) => void): OpenedWhere {
  const cur = ed.sessions.current;
  if (cur.id === targetId && cur.state === before) {
    const expectedLoad = ed.doc.loadCount + 1, generation = cur.contentGeneration + 1;
    ed.loadState(state, path);
    const current = ed.sessions.current;
    if (current === cur && ed.doc.loadCount === expectedLoad && current.contentGeneration === generation) {
      ed.doc.dirty = dirty;
      accepted?.(current, generation);
    }
    return 'active';
  }
  const i = ed.sessions.indexOfId(targetId);
  const s = i >= 0 ? ed.sessions.all[i] : undefined;
  if (s && s.state === before) {
    const generation = s.contentGeneration + 1;
    const d = new Drawing();
    // Same preparation as loadState: older library symbols keep taking the reference's colour.
    d.load(withByBlockLibrarySymbols(state), path);
    d.ensureBlocks([...LIBRARY_SYMBOLS, TITLE_BLOCK, SOURCE_ARROW, DEST_ARROW, WIRE_DOT]);
    ed.sessions.loadInto(targetId, d.snapshot, path, dirty);
    if (ed.sessions.all.includes(s) && s.contentGeneration === generation) accepted?.(s, generation);
    ed.notify('file');
    return 'background';
  }
  if (cur.id !== targetId) {
    const d = new Drawing();
    d.load(withByBlockLibrarySymbols(state), path);
    d.ensureBlocks([...LIBRARY_SYMBOLS, TITLE_BLOCK, SOURCE_ARROW, DEST_ARROW, WIRE_DOT]);
    const previous = new Set(ed.sessions.all);
    ed.sessions.addInBackground(d.snapshot, path, dirty);
    const added = ed.sessions.all.filter(session => !previous.has(session));
    if (added.length === 1 && added[0]!.contentGeneration === 0 && added[0]!.filePath === path) accepted?.(added[0]!, 0);
    ed.notify('file');
    return 'new-background-tab';
  }
  const previous = new Set(ed.sessions.all);
  ed.sessions.add(state, path, dirty);
  const added = ed.sessions.all.filter(session => !previous.has(session));
  if (added.length === 1 && added[0]!.contentGeneration === 0 && added[0]!.filePath === path) accepted?.(added[0]!, 0);
  return 'new-tab';
}

export function fileName(ed: Editor): string {
  if (!ed.doc.filePath) return ed.sessions.untitledName;
  return ed.doc.filePath.split(/[\\/]/).pop() ?? 'Drawing1.dxf';
}

export function rememberRecent(ed: Editor, path: string): void {
  ed.settings = { ...ed.settings, recentFiles: pushRecent(ed.settings.recentFiles, path) };
  saveSettings(ed.settings);
  ed.notify('file');
}
