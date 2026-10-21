/**
 * Sheet-set host (P31A wiring — PROPOSAL-P31-A-WIRING, ADMITTED WITH
 * CONDITIONS C1–C8 by RULING-P31-A-WIRING in LEDGER.md; built first as a
 * FILED-UNADMITTED prototype and conformed to the ruling's conditions —
 * this module carries condition C3, same-drawing disambiguation).
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
import { activeLayout } from '../core/layouts';
import { samePath } from './paths';
import type { DocumentSession } from './sessions';

/**
 * A binding ambiguity surfaced by SheetSetHost.bindSession
 * (RULING-P31-A-WIRING C3): more than one sheet records the session's
 * drawing and the recorded layout names do not single one out against the
 * session document's active layout. A host-level record rather than a
 * SheetSetLinkIssue: the link-issue kind union lives in
 * src/project/sheet-set.ts, outside this slice's admitted surface, and an
 * ambiguity is a binding-time condition (it depends on the session's
 * document), not a defect of the set itself, so validateSheetSetLinks
 * cannot see it.
 */
export interface SheetBindingAmbiguity {
  readonly kind: 'ambiguous-drawing';
  readonly drawingPath: string;
  /** Candidate sheet ids, in set order. */
  readonly sheetIds: readonly string[];
  readonly message: string;
}

export class SheetSetHost {
  private set: SheetSet | undefined;
  /** Path of the file the held set was opened from (null = none open). */
  filePath: string | null = null;
  /** Host dirty flag: set edits dirty the HOST only, never a drawing. */
  dirty = false;
  /** Issues from the most recent validateLinks call (reported, never repaired). */
  lastIssues: readonly SheetSetLinkIssue[] = [];
  /**
   * Binding ambiguity from the most recent bindSession call (C3):
   * non-empty exactly when that bind left the session UNBOUND because
   * several sheets record its drawing and none could be singled out.
   * Reported here — never resolved silently by file order.
   */
  bindingIssues: readonly SheetBindingAmbiguity[] = [];

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
    this.bindingIssues = [];
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

  /** Every sheet whose recorded drawing path matches `path` (host path discipline), in set order. */
  sheetsForDrawing(path: string | null | undefined): readonly SheetSetSheet[] {
    if (!this.set || !path) return [];
    return this.set.sheets.filter((s) => samePath(s.drawingPath, path));
  }

  /**
   * The sheet a drawing file binds to. Zero or one recorded match resolves
   * exactly as recorded. MORE THAN ONE match — several sheets recording the
   * same drawing, the normal shape for a multi-layout drawing — is NEVER
   * resolved by silently first-matching (RULING-P31-A-WIRING C3): the
   * recorded layoutName must single out exactly one candidate against
   * `layoutName` (the relevant layout, compared case-insensitively per the
   * layouts.ts findLayout convention); where it cannot, the lookup is
   * undecidable and returns undefined.
   */
  sheetForDrawing(path: string | null | undefined, layoutName?: string): SheetSetSheet | undefined {
    const matches = this.sheetsForDrawing(path);
    if (matches.length <= 1) return matches[0];
    if (layoutName) {
      const byLayout = matches.filter((s) => s.layoutName.toUpperCase() === layoutName.toUpperCase());
      if (byLayout.length === 1) return byLayout[0];
    }
    return undefined;
  }

  /**
   * Bind a document session to the sheet its drawing file is recorded as.
   * The binding lives on the session (DocumentSession.sheetId), so it parks
   * and restores with the tab. An unmatched drawing clears the binding —
   * a binding is re-derived from the session's file, never kept stale.
   *
   * When several sheets record the session's drawing (C3), the candidate
   * is singled out by its recorded layoutName against the session
   * document's ACTIVE layout (core/layouts activeLayout — the layout the
   * document is actually presenting; the Model tab has none). Where no
   * candidate can be singled out, the session is left UNBOUND and the
   * ambiguity is surfaced in bindingIssues — one of several candidate
   * sheets' values is never served by file order.
   */
  bindSession(session: DocumentSession, drawingPath: string | null | undefined): SheetSetSheet | undefined {
    const candidates = this.sheetsForDrawing(drawingPath);
    let sheet: SheetSetSheet | undefined;
    let ambiguity: SheetBindingAmbiguity | undefined;
    if (candidates.length === 1) {
      sheet = candidates[0];
    } else if (candidates.length > 1) {
      const layoutName = session.state ? activeLayout(session.state)?.name : undefined;
      sheet = layoutName ? this.sheetForDrawing(drawingPath, layoutName) : undefined;
      if (!sheet) {
        ambiguity = {
          kind: 'ambiguous-drawing',
          drawingPath: drawingPath as string,
          sheetIds: candidates.map((s) => s.id),
          message:
            `${candidates.length} sheets record drawing "${drawingPath}" and the session document's active layout ` +
            'does not single one out; the session is left unbound rather than bound to the first by file order.',
        };
      }
    }
    session.sheetId = sheet?.id;
    this.bindingIssues = ambiguity ? [ambiguity] : [];
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
