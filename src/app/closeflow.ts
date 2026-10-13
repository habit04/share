/**
 * Save All when the application closes (window close, quit, restart for an update): list every
 * modified drawing tab, every Symbol Builder tab with unsaved edits and the project; one dialog
 * answers Save All / Discard All / Cancel (with a per-item choice); saves run one after another,
 * each awaited, and the first failure aborts the close with its error. DOM-free so it can be
 * unit tested; the dialogs come in through `CloseDeps`.
 */
import type { Editor } from './editor';
import { hasSolids } from '../model3d/model';

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
  /**
   * Save the symbol of the (now active) Symbol Builder tab; resolves an error message, or null
   * once it is saved (the user library file written, not just queued).
   */
  saveSymbol(sessionId: number): Promise<string | null>;
  /** Tell the user which item failed and why (the close is aborted afterwards). */
  showError(title: string, error: string): Promise<void>;
  /**
   * Runs once everything listed was saved or discarded, before the close is approved (src/main.ts:
   * wait for the autosaves being written). Work changed meanwhile is asked about again.
   */
  settle?(): Promise<void>;
}

type CloseEditor = Pick<Editor, 'sessions' | 'project' | 'projectState' | 'projectDirty' | 'saveFile' | 'saveProject' | 'switchSession' | 'lastFileError' | 'log'>;

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
 * "a.dxf could not be saved: <why>" for the close-stopped message, or the reason itself when it is
 * already a sentence naming what could not be saved (the file error texts of file-errors.ts).
 */
export function closeErrorText(title: string, error: string): string {
  return /^(".+"|The \w+(?: copy of ".+")?) could not be /.test(error) ? error : `${title} could not be saved: ${error}`;
}

/** Save rounds before the close gives up on items that keep changing (see runCloseWorkflow). */
const MAX_ROUNDS = 3;

/**
 * Run the close workflow; resolves true when the application may close (everything chosen was
 * saved, or the user discarded), false when the user cancelled or a save failed.
 *
 * Saving one item can change another: a Symbol Builder save redefines the block in every open
 * drawing that uses it. The application also stays usable while the chosen items are saved (and
 * while `settle` waits), so a drawing or the project can be changed again meanwhile. The close is
 * only approved once every unsaved revision was decided about: anything changed after the user's
 * answer (or not listed in it) is asked about again instead of being lost with the window. Items
 * that keep changing for more than MAX_ROUNDS answers stop the close with a message.
 */
export async function runCloseWorkflow(editor: CloseEditor, deps: CloseDeps, isSymbol: (sessionId: number) => boolean): Promise<boolean> {
  type Revision = readonly [state: unknown, generation: number, revision: number] | undefined;
  /** Item key -> the revision the user decided about (saved, or chose not to save). */
  const decided = new Map<string, Revision>();
  const revisionOf = (it: UnsavedItem): Revision => {
    if (it.kind === 'project') {
      const p = editor.projectState;
      return [editor.project, p.generation, p.revision];
    }
    const s = editor.sessions.all.find((s) => s.id === it.sessionId);
    return s && [s.state, s.contentGeneration, s.revision];
  };
  // Parked drawings can also have their immutable state replaced directly (Symbol Builder).
  // State identity catches that path; the counters catch edit-and-undo and same-state reloads.
  const sameRevision = (a: Revision, b: Revision): boolean => a === b || !!a && !!b && a.every((value, i) => value === b[i]);
  const open = () => collectUnsaved(editor, isSymbol).filter((it) => !decided.has(it.key) || !sameRevision(decided.get(it.key), revisionOf(it)));
  for (let round = 1; ; round += 1) {
    let items = open();
    if (items.length === 0) {
      await deps.settle?.();
      items = open();
      if (items.length === 0) return true;
    }
    if (round > MAX_ROUNDS) {
      const titles = items.map((it) => it.title).join(', ');
      editor.log(`Close cancelled: ${titles} changed again while saving.`);
      await deps.showError(titles, 'it changed again while the other items were being saved; save it yourself, then close again');
      return false;
    }
    const shown = new Map(items.map((it) => [it.key, revisionOf(it)]));
    const decision = await deps.ask(items);
    if (decision.action === 'cancel') {
      editor.log('Close cancelled.');
      return false;
    }
    // The answer covers the revisions captured before the dialog opened. Changes during the
    // dialog or another item's save must be reviewed again.
    for (const it of items) decided.set(it.key, shown.get(it.key));
    if (decision.action === 'discard') continue;
    for (const it of items) {
      if (!decision.keys.has(it.key)) continue;
      const error = await saveItem(editor, deps, it);
      if (error) {
        editor.log(`Close cancelled. ${closeErrorText(it.title, error)}`);
        await deps.showError(it.title, error);
        return false;
      }
    }
  }
}

/**
 * CloseDeps.saveSymbol for a Symbol Builder tab: save the symbol, then wait until the user library
 * file is written (the library queues its writes); a failed write is the save's error, so the
 * close is not completed over a symbol that is only in memory.
 */
export async function saveSymbolForClose(
  builder: { save(): Promise<unknown>; firstError(): string | null },
  library: { flush(): Promise<void>; readonly lastError: string | null },
): Promise<string | null> {
  if (!(await builder.save())) return builder.firstError() ?? 'the symbol was not saved';
  await library.flush();
  return library.lastError ? `the user symbol library could not be written: ${library.lastError}` : null;
}

/**
 * Before the window closes: wait for `work` (autosaves being written, backups removed after the
 * saves just made), but at most `timeoutMs`, so a hung write cannot keep the window open.
 * Resolves true when everything finished in time.
 */
export async function settleBeforeClose(work: ReadonlyArray<Promise<unknown>>, timeoutMs = 4000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([Promise.allSettled(work).then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
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
  if (it.kind === 'symbol') {
    const error = await deps.saveSymbol(it.sessionId!);
    if (error) return error;
    const at = editor.sessions.indexOfId(it.sessionId!);
    return at >= 0 && editor.sessions.isDirty(at) ? 'the symbol changed while it was being saved' : null;
  }
  const ok = await editor.saveFile(false);
  if (!ok) return editor.lastFileError ?? 'the save was cancelled';
  const now = editor.sessions.indexOfId(it.sessionId!);
  if (now >= 0 && editor.sessions.isDirty(now)) {
    // A save without the experimental 3D objects keeps the drawing modified on purpose.
    const state = editor.sessions.all[now]?.state;
    if (state && hasSolids(state)) return 'the saved file does not hold the 3D objects of the drawing, so it stays modified';
    return 'the drawing changed while it was being saved';
  }
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
  deps: { confirmDiscard(title: string): Promise<boolean>; discardBackup(sessionId: number): void; changed?(title: string): void },
): Promise<boolean> {
  const s = sessions.all[i];
  if (!s) return false;
  const id = s.id;
  const revision = s.revision;
  const state = s.state;
  const generation = s.contentGeneration;
  if (sessions.isDirty(i) && !(await deps.confirmDiscard(sessions.titleOf(i)))) return false;
  const now = sessions.indexOfId(id);
  if (now < 0) return true; // closed meanwhile
  const current = sessions.all[now];
  if (current !== s || current.revision !== revision || current.state !== state || current.contentGeneration !== generation) {
    deps.changed?.(sessions.titleOf(now));
    return false;
  }
  sessions.close(now);
  deps.discardBackup(id);
  return true;
}
