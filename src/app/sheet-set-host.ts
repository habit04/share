/**
 * Sheet-set host (P31A wiring — PROPOSAL-P31-A-WIRING, FILED in LEDGER.md,
 * status: awaiting contracts owner; this module is a FILED-UNADMITTED
 * prototype and is marked as such in every delivery artifact).
 *
 * The ONLY place sheet-set state lives at runtime. A sheet set spans many
 * drawings (each sheet references an external drawing by path + layout
 * name), so — per the proposal's placement decision — the set is NOT stored
 * in any DrawingState: no DrawingState shape change, no seal exemption, no
 * canonical-digest disposition. The set is held here, at app scope, next to
 * the project association (Project.sheetSetPath) and the per-document
 * binding (DocumentSession.sheetId).
 *
 * This module performs NO filesystem, DOM or Electron access: file bytes
 * arrive and leave as text through the app's existing file seam, and the
 * link resolver's exists/layouts facts are supplied by the caller (the host
 * layer reads the referenced files; the editor state is never consulted).
 */
import {
  parseDstSubsetXml,
  parseSheetSetJson,
  sheetFieldValues,
  sheetSetToJson,
  toDstSubsetXml,
  validateSheetSetLinks,
  type SheetSet,
  type SheetSetLinkIssue,
  type SheetSetLinkResolver,
  type SheetSetSheet,
} from '../project/sheet-set';
import { samePath } from './paths';
import type { DocumentSession } from './sessions';

export class SheetSetHost {
  private set: SheetSet | undefined;
  /** Path of the file the held set was opened from (null = none open). */
  filePath: string | null = null;
  /** Host dirty flag: set edits dirty the HOST only, never a drawing. */
  dirty = false;
  /** Issues from the most recent validateLinks call (reported, never repaired). */
  lastIssues: readonly SheetSetLinkIssue[] = [];

  /**
   * Open a set from file text. Dispatch is by extension (.dst → the DST
   * subset form) with an XML content fallback; anything else is the JSON
   * form. Both parsers are strict: a malformed file throws and NO partial
   * set is held (the previous set, if any, is left untouched).
   */
  openSet(text: string, path: string): void {
    const isDst = /\.dst$/i.test(path) || text.trimStart().startsWith('<');
    const parsed = isDst ? parseDstSubsetXml(text) : parseSheetSetJson(text);
    this.set = parsed;
    this.filePath = path;
    this.dirty = false;
    this.lastIssues = [];
  }

  /** The held set, or undefined when none is open. */
  current(): SheetSet | undefined {
    return this.set;
  }

  private requireSet(): SheetSet {
    if (!this.set) throw new Error('No sheet set is open.');
    return this.set;
  }

  /** Serialize the held set in the JSON (lossless) or DST (interop) form. */
  serializeSet(format: 'json' | 'dst'): string {
    const set = this.requireSet();
    return format === 'json' ? sheetSetToJson(set) : toDstSubsetXml(set);
  }

  /**
   * Apply a set edit (the checkpoint-1 model's pure functions are the edit
   * vocabulary: addSheet / moveSheet / updateSheet / removeSheet). A real
   * change replaces the held set and marks the HOST dirty; a no-op edit
   * (same object back) changes nothing. No drawing is dirtied and no undo
   * entry is created anywhere — set edits are host operations, saved by
   * writing the set file.
   */
  applyEdit(edit: (set: SheetSet) => SheetSet): SheetSet {
    const next = edit(this.requireSet());
    if (next !== this.set) {
      this.set = next;
      this.dirty = true;
    }
    return this.set;
  }

  /**
   * Validate every link in the held set through the caller-supplied
   * resolver and cache the issues. Broken entries stay in place and are
   * reported — never dropped, never retargeted (checkpoint-1 discipline).
   */
  validateLinks(resolve: SheetSetLinkResolver): readonly SheetSetLinkIssue[] {
    const issues = validateSheetSetLinks(this.requireSet(), resolve);
    this.lastIssues = issues;
    return issues;
  }

  /** The sheet whose recorded drawing path matches `path` (host path discipline). */
  sheetForDrawing(path: string | null | undefined): SheetSetSheet | undefined {
    if (!this.set || !path) return undefined;
    return this.set.sheets.find((s) => samePath(s.drawingPath, path));
  }

  /**
   * Bind a document session to the sheet its drawing file is recorded as.
   * The binding lives on the session (DocumentSession.sheetId), so it parks
   * and restores with the tab. An unmatched drawing clears the binding —
   * a binding is re-derived from the session's file, never kept stale.
   */
  bindSession(session: DocumentSession, drawingPath: string | null | undefined): SheetSetSheet | undefined {
    const sheet = this.sheetForDrawing(drawingPath);
    session.sheetId = sheet?.id;
    return sheet;
  }

  /**
   * The \AcSm field values for a session's bound sheet (the bridge consumed
   * by sheetFieldContextFor in src/tools/drafting-annot.ts). Undefined when
   * no set is open, the session is unbound, or the bound id no longer
   * resolves in the held set — in every such case field evaluation falls
   * back to the plain context and \AcSm shows ####, exactly as an unbound
   * drawing does today. A stale id NEVER resolves to a different sheet.
   */
  fieldValuesFor(session: Pick<DocumentSession, 'sheetId'>): Record<string, string> | undefined {
    if (!this.set || !session.sheetId) return undefined;
    const sheet = this.set.sheets.find((s) => s.id === session.sheetId);
    return sheet ? sheetFieldValues(this.set, sheet.id) : undefined;
  }
}
