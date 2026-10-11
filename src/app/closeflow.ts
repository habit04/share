/**
 * Save All when the application closes (window close, quit, restart for an update): list every
 * modified drawing tab, every Symbol Builder tab with unsaved edits and the project; one dialog
 * answers Save All / Discard All / Cancel (with a per-item choice); saves run one after another,
 * each awaited, and the first failure aborts the close with its error. DOM-free so it can be
 * unit tested; the dialogs come in through `CloseDeps`.
 */
import type { Editor } from './editor';

export interface UnsavedItem {
  /** "s<session id>" for a tab, "project" for the project. */
  key: string;
  kind: 'drawing' | 'symbol' | 'project';
  title: string;
  /** Full path, or why there is none. */
  detail?: string;
  sessionId?: number;
}

export type CloseDecision = { action: 'save'; keys: ReadonlySet<string> } | { action: 'discard' } | { action: 'cancel' };

export interface CloseDeps {
  /** The Save All dialog. */
  ask(items: readonly UnsavedItem[]): Promise<CloseDecision>;
  /** Save the symbol of the (now active) Symbol Builder tab; resolves an error message, or null when saved. */
  saveSymbol(sessionId: number): Promise<string | null>;
  /** Tell the user which item failed and why (the close is aborted afterwards). */
  showError(title: string, error: string): Promise<void>;
  /**
   * Runs once everything listed was saved or discarded, before the close is approved (src/main.ts:
   * wait for the autosaves being written). Work changed meanwhile is asked about again.
   */
  settle?(): Promise<void>;
}

type CloseEditor = Pick<Editor, 'sessions' | 'project' | 'projectDirty' | 'saveFile' | 'saveProject' | 'switchSession' | 'lastFileError' | 'log'>;

/** Everything that has unsaved changes, drawings first (tab order), then symbols, then the project. */
export function collectUnsaved(editor: CloseEditor, isSymbol: (sessionId: number) => boolean): UnsavedItem[] {
  const sessions = editor.sessions.all;
  const drawings: UnsavedItem[] = [];
  const symbols: UnsavedItem[] = [];
  sessions.forEach((s, i) => {
    if (!s.dirty) return;
    const title = editor.sessions.titleOf(i);
    if (isSymbol(s.id)) symbols.push({ key: `s${s.id}`, kind: 'symbol', title, detail: 'unsaved symbol edits', sessionId: s.id });
    else drawings.push({ key: `s${s.id}`, kind: 'drawing', title, detail: s.filePath ?? 'never saved (Save As)', sessionId: s.id });
  });
  const out = [...drawings, ...symbols];
  if (editor.projectDirty) out.push({ key: 'project', kind: 'project', title: editor.project.name, detail: editor.project.path ?? 'never saved (Save As)' });
  return out;
}

/**
 * Run the close workflow; resolves true when the application may close (everything chosen was
 * saved, or the user discarded), false when the user cancelled or a save failed.
 *
 * The application stays usable while the chosen items are saved (and while `settle` waits), so a
 * drawing or the project can be changed again meanwhile. The close is only approved once every
 * unsaved revision was decided about: anything changed after the user's answer (or not listed in
 * it) is asked about again instead of being lost with the window.
 */
export async function runCloseWorkflow(editor: CloseEditor, deps: CloseDeps, isSymbol: (sessionId: number) => boolean): Promise<boolean> {
  /** Item key -> the revision the user decided about (saved, or chose not to save). */
  const decided = new Map<string, unknown>();
  const revisionOf = (it: UnsavedItem): unknown => (it.kind === 'project' ? editor.project : editor.sessions.all.find((s) => s.id === it.sessionId)?.state);
  const open = () => collectUnsaved(editor, isSymbol).filter((it) => !decided.has(it.key) || decided.get(it.key) !== revisionOf(it));
  for (;;) {
    let items = open();
    if (items.length === 0) {
      await deps.settle?.();
      items = open();
      if (items.length === 0) return true;
    }
    const decision = await deps.ask(items);
    if (decision.action === 'cancel') {
      editor.log('Close cancelled.');
      return false;
    }
    // The answer covers the revisions shown in the dialog (taken now, before any save runs): a drawing
    // edited while another item is being saved is asked about again.
    for (const it of items) decided.set(it.key, revisionOf(it));
    if (decision.action === 'discard') continue;
    for (const it of items) {
      if (!decision.keys.has(it.key)) continue;
      const error = await saveItem(editor, deps, it);
      if (error) {
        editor.log(`Close cancelled: ${it.title} could not be saved (${error}).`);
        await deps.showError(it.title, error);
        return false;
      }
    }
  }
}

/** Save one item; resolves null on success, else the reason. */
async function saveItem(editor: CloseEditor, deps: CloseDeps, it: UnsavedItem): Promise<string | null> {
  if (it.kind === 'project') {
    const ok = await editor.saveProject();
    if (!ok) return editor.lastFileError ?? 'the save was cancelled';
    return editor.projectDirty ? 'the project changed while it was being saved' : null;
  }
  const idx = editor.sessions.indexOfId(it.sessionId!);
  if (idx < 0) return null; // closed meanwhile
  if (!editor.sessions.isDirty(idx)) return null; // saved meanwhile
  if (idx !== editor.sessions.active) editor.switchSession(idx);
  if (it.kind === 'symbol') return deps.saveSymbol(it.sessionId!);
  const ok = await editor.saveFile(false);
  if (!ok) return editor.lastFileError ?? 'the save was cancelled';
  const now = editor.sessions.indexOfId(it.sessionId!);
  if (now >= 0 && editor.sessions.isDirty(now)) return 'the drawing changed while it was being saved';
  return null;
}

/**
 * CLOSE for drawing tab `i`: ask about unsaved changes, then close that same tab - found again by
 * its id, because tabs may be opened or closed while the question is shown (a background open that
 * failed closes its tab) and the index may then name another drawing. Resolves true when closed.
 */
export async function closeDrawingTab(
  sessions: Pick<Editor['sessions'], 'all' | 'isDirty' | 'titleOf' | 'indexOfId' | 'close'>,
  i: number,
  deps: { confirmDiscard(title: string): Promise<boolean>; discardBackup(sessionId: number): void },
): Promise<boolean> {
  const s = sessions.all[i];
  if (!s) return false;
  const id = s.id;
  if (sessions.isDirty(i) && !(await deps.confirmDiscard(sessions.titleOf(i)))) return false;
  const now = sessions.indexOfId(id);
  if (now < 0) return true; // closed meanwhile
  deps.discardBackup(id);
  sessions.close(now);
  return true;
}
