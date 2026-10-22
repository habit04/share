/**
 * Data links (P31-B) — PROPOSAL-P31-B, ADMITTED FOR DEVELOPMENT by the
 * lead 2026-10-21 with the Q1/Q7/Q8 dispositions noted below; the design
 * of record is docs/P31B-DATA-LINKS-DESIGN.md.
 *
 * A data link binds a rectangle of a table in the drawing to a range of an
 * external delimited-text source (CSV/TSV). Refresh copies the source
 * snapshot's text into the rectangle's OWNER cells — the model-level
 * analogue of a spreadsheet "refresh data links". Everything in this
 * module is pure: no filesystem, DOM, Electron or clock access. The host
 * seam (src/app/data-link-refresh.ts) reads and parses the source and
 * performs the single refresh transaction on the Drawing.
 *
 * THE SHAPE OF THE SLICE (read before trusting any of it):
 * - Records are plain serializable data only: strings, finite numbers,
 *   arrays and plain objects. validateDataLinks is a TOTAL validator —
 *   any violation throws and the whole state is refused — so Drawing
 *   construction/load and every transition stay fail-closed with NO
 *   seal-exemption posture for these records: they are seal-certified
 *   like all other plain data (contrast signatureRecord, exempt by
 *   ruling; acceptance example (9) probes the difference).
 * - IN-SESSION ONLY: nothing serializes `dataLinks` into DXF/DWG or any
 *   other artifact. Links survive undo/redo, tab parking and layout
 *   switches inside the session and are LOST on save/reopen; refreshed
 *   CONTENT persists as ordinary table content. The host seam states
 *   this limit to the user on every create/refresh outcome.
 * - Q1 (lead ruling): `dataLinks` is EXCLUDED from the canonical content
 *   digest (see src/project/canonical-digest.ts). What the exclusion
 *   attests: NOTHING about the link records — a tampered, re-targeted or
 *   deleted link record does not change the digest and does not, by
 *   itself, invalidate a preserved signature. What IS digested: the
 *   linked cell CONTENT, as ordinary table content — so a refresh
 *   (which changes content) changes the digest, and the Q8 edit
 *   consequence below applies. The digest is a change detector over
 *   content, never evidence about links.
 * - Q8 (as proposed): a refresh IS a drawing edit. It is applied as one
 *   transactDrawing, so the existing commitTransition detection
 *   invalidates a preserved signature record in the same operation;
 *   link-record-only edits (create, re-range) invalidate likewise — no
 *   special case. The read-only issue/staleness computation
 *   (dataLinkIssues) never touches the state and never invalidates.
 * - The six §7.1 never-assumes hold: resolution keys on cadIdentity +
 *   (row, col), never the entity `id` (an in-session lookup accelerator
 *   at creation only, never the stored key); a cadIdentity resolving to
 *   zero or several tables never silently rebinds; indices are
 *   positional and R1–R6 are the answer to positional drift; rectangles
 *   are defined over OWNER cells (covered cells are virtual); no UUID
 *   is introduced anywhere — fingerprints are a refusal heuristic, not
 *   an identity; style names and handles are never keys.
 *
 * RECONCILIATION (R1–R6 of the design note; any failure refuses the
 * whole refresh, state untouched, reason reported as a DataLinkIssue):
 * R1 the target tableCadIdentity resolves to exactly one table.
 * R2 the source snapshot's shape equals the recorded range shape (no
 *    auto-fit; the remedy is an explicit re-range).
 * R3 the target rectangle still fits the table grid.
 * R4 fingerprints: a grid shape (rows × cols of the cells grid) differing
 *    from the recorded shape is `grid-shape-changed` — an UNCONDITIONAL
 *    refusal a confirmation can never override (the duplicated-header
 *    case: every fingerprint can match while a row was inserted);
 *    owner-cell fingerprints differing is
 *    `cells-modified-since-refresh` with the differing owner
 *    coordinates, gated on a PER-REFRESH confirmation (never a stored
 *    bit).
 * R5 merge integrity: every grid position in the rectangle is owned from
 *    inside the rectangle and no span crosses its boundary; refresh
 *    writes OWNER cells only and never alters a span.
 * R6 no second link's rectangle overlaps this one on the same table.
 * Pinned evaluation order: R1 → R6 → R2 → R3 → R5 → baseline presence →
 * R4 shape → R4 fingerprints → already-current. (R6 sits with resolution:
 * it is a property of the link set, not of the source or the grid.)
 *
 * BASELINE SEMANTICS (pinned here — the design note's wording admits two
 * readings and the acceptance examples force this one): at creation and
 * at re-range, `lastRefresh` is baselined on the CURRENT target cells:
 * `sourceDigest` is the snapshot digest of the rectangle's
 * owner-expanded cell TEXTS (a covered position contributes its owner's
 * text), fingerprints are the current owner fingerprints, `refreshedAt`
 * is the act's timestamp and `sourceModifiedAt` is absent. The recorded
 * digest therefore means "the digest of the source snapshot the current
 * cell content corresponds to": a first refresh against an unchanged
 * source whose grid equals the current cells is already-current and
 * performs no write; after any refresh the recorded digest is the digest
 * of the source snapshot that was actually written. A link record with
 * NO `lastRefresh` has no baseline: refresh refuses (kind `broken`)
 * until an explicit re-range re-baselines it — it is never silently
 * overwritten on a first refresh.
 *
 * CANONICAL ENCODINGS (pinned; both sides of every comparison use them):
 * - cell fingerprint: sha256Hex over 'jcad-p31b-cell-v1\n' +
 *   JSON.stringify([text, raw ?? '']) — the (text, raw) pair, so a
 *   raw-only edit is drift too.
 * - snapshot digest: sha256Hex over the grid's rows, each row encoded as
 *   JSON.stringify(row), joined with '\n' (LF), no trailing newline.
 *   JSON encoding makes the canonical form unambiguous — no delimiter
 *   collisions, whatever the cell texts contain.
 * - grid shape: rows = cells.length, cols = the widest row.
 *   rowHeights / columnWidths are geometry; refresh never reads or
 *   writes them.
 * - the source digest is a change detector, NOT a signature: digest
 *   equality is the whole already-current claim, nothing more.
 *
 * STALENESS IS SHOWN, NEVER HEALED: there are no edit hooks; detection
 * is refresh-time (evaluateRefreshDataLink) or report-time
 * (dataLinkIssues). A link whose target no longer resolves is reported
 * broken/ambiguous and is never deleted, retargeted or auto-healed.
 */
import type { DrawingState } from '../core/document';
import { newId, type Entity } from '../core/entities';
import { sha256Hex } from '../core/sha256';
import { cellOwners, type TableCell, type TableEntity } from '../core/table';

/** Bounded work: one link covers at most this many source cells. */
export const DATA_LINK_CELL_CAP = 100_000;

export interface DataLinkSourceRange {
  /** Reserved for workbook sources (out of scope for this slice); delimited text ignores it. */
  readonly sheet?: string;
  readonly firstRow: number;
  readonly firstCol: number;
  readonly rowCount: number;
  readonly colCount: number;
}

export interface DataLinkTarget {
  /** The durable resolution key, copied from the table at creation. Absent = the table had none. */
  readonly tableCadIdentity?: string;
  readonly firstRow: number;
  readonly firstCol: number;
}

export interface DataLinkLastRefresh {
  /** Digest of the source snapshot the current cell content corresponds to (see header). */
  readonly sourceDigest: string;
  readonly sourceModifiedAt?: string;
  /** Timestamp of the act that established this baseline (creation, re-range or refresh). */
  readonly refreshedAt: string;
  /** Table grid shape (cells grid) when the baseline was taken. */
  readonly gridRows: number;
  readonly gridCols: number;
  /** One fingerprint per OWNER cell of the target rectangle, row-major. */
  readonly cellFingerprints: readonly string[];
}

export interface DataLink {
  readonly id: string;
  /** Source path exactly as recorded at creation; never rewritten. */
  readonly sourcePath: string;
  readonly sourceRange: DataLinkSourceRange;
  readonly target: DataLinkTarget;
  /** Only 'down' (source → table) exists; update-from-table is a non-goal. */
  readonly direction: 'down';
  readonly lastRefresh?: DataLinkLastRefresh;
}

export type DataLinkIssueKind =
  | 'broken'
  | 'ambiguous'
  | 'unresolvable-on-reopen'
  | 'stale'
  | 'cells-modified-since-refresh'
  | 'grid-shape-changed'
  | 'source-shape-changed'
  | 'target-out-of-range'
  | 'merge-boundary'
  | 'overlap'
  | 'source-unreadable'
  | 'source-parse-refused';

export interface DataLinkIssue {
  readonly linkId: string;
  readonly kind: DataLinkIssueKind;
  readonly message: string;
  /** Grid coordinates of OWNER cells, for cells-modified-since-refresh. */
  readonly cells?: readonly (readonly [number, number])[];
}

/** A parsed source grid plus its canonical digest (see header). */
export interface SourceSnapshot {
  readonly grid: readonly (readonly string[])[];
  readonly digest: string;
}

export function snapshotDigest(grid: readonly (readonly string[])[]): string {
  return sha256Hex(grid.map((row) => JSON.stringify(row)).join('\n'));
}

export function sourceSnapshotOf(grid: readonly (readonly string[])[]): SourceSnapshot {
  return { grid, digest: snapshotDigest(grid) };
}

export function cellFingerprint(cell: Pick<TableCell, 'text' | 'raw'>): string {
  return sha256Hex(`jcad-p31b-cell-v1\n${JSON.stringify([cell.text, cell.raw ?? ''])}`);
}

export function findDataLink(state: DrawingState, linkId: string): DataLink | undefined {
  return (state.dataLinks ?? []).find((link) => link.id === linkId);
}

/* ------------------------------------------------------------------ */
/* Validator (total, atomic; called from validateDrawingState)         */
/* ------------------------------------------------------------------ */

const HEX64 = /^[0-9a-f]{64}$/;

function fail(problem: string): never {
  throw new Error(`data-links: ${problem}`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function checkKeys(record: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) fail(`${where}: unknown key "${key}"`);
  }
}

function requiredString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) fail(`${where}.${key}: a non-empty string is required`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string, where: string): void {
  const value = record[key];
  if (value !== undefined && typeof value !== 'string') fail(`${where}.${key}: a string is required when present`);
}

function intAtLeast(record: Record<string, unknown>, key: string, where: string, min: number): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    fail(`${where}.${key}: a safe integer >= ${min} is required`);
  }
  return value;
}

/**
 * Total validation of DrawingState.dataLinks: every reachable value is
 * checked, the first violation throws, and nothing is normalized or
 * repaired. Mirrors the validateModel3DState / validateCadState pattern:
 * called from validateDrawingProperties, so construction, load and every
 * transition refuse a malformed link record.
 */
export function validateDataLinks(state: DrawingState): void {
  const links = state.dataLinks;
  if (links === undefined) return;
  if (!Array.isArray(links)) fail('dataLinks must be an array of link records');
  const ids = new Set<string>();
  links.forEach((raw: unknown, index: number) => {
    const where = `dataLinks[${index}]`;
    if (!isPlainRecord(raw)) fail(`${where}: a link record must be a plain object`);
    checkKeys(raw, ['id', 'sourcePath', 'sourceRange', 'target', 'direction', 'lastRefresh'], where);
    const id = requiredString(raw, 'id', where);
    if (ids.has(id)) fail(`${where}: duplicate link id "${id}"`);
    ids.add(id);
    requiredString(raw, 'sourcePath', where);
    if (raw.direction !== 'down') fail(`${where}.direction: only 'down' is defined`);

    const range = raw.sourceRange;
    if (!isPlainRecord(range)) fail(`${where}.sourceRange: a plain object is required`);
    checkKeys(range, ['sheet', 'firstRow', 'firstCol', 'rowCount', 'colCount'], `${where}.sourceRange`);
    optionalString(range, 'sheet', `${where}.sourceRange`);
    intAtLeast(range, 'firstRow', `${where}.sourceRange`, 0);
    intAtLeast(range, 'firstCol', `${where}.sourceRange`, 0);
    const rowCount = intAtLeast(range, 'rowCount', `${where}.sourceRange`, 1);
    const colCount = intAtLeast(range, 'colCount', `${where}.sourceRange`, 1);
    if (rowCount * colCount > DATA_LINK_CELL_CAP) {
      fail(`${where}.sourceRange: ${rowCount}x${colCount} exceeds the ${DATA_LINK_CELL_CAP}-cell cap`);
    }

    const target = raw.target;
    if (!isPlainRecord(target)) fail(`${where}.target: a plain object is required`);
    checkKeys(target, ['tableCadIdentity', 'firstRow', 'firstCol'], `${where}.target`);
    if (target.tableCadIdentity !== undefined
      && (typeof target.tableCadIdentity !== 'string' || target.tableCadIdentity.length === 0)) {
      fail(`${where}.target.tableCadIdentity: a non-empty string is required when present`);
    }
    intAtLeast(target, 'firstRow', `${where}.target`, 0);
    intAtLeast(target, 'firstCol', `${where}.target`, 0);

    const last = raw.lastRefresh;
    if (last !== undefined) {
      if (!isPlainRecord(last)) fail(`${where}.lastRefresh: a plain object is required`);
      checkKeys(last, ['sourceDigest', 'sourceModifiedAt', 'refreshedAt', 'gridRows', 'gridCols', 'cellFingerprints'], `${where}.lastRefresh`);
      if (typeof last.sourceDigest !== 'string' || !HEX64.test(last.sourceDigest)) {
        fail(`${where}.lastRefresh.sourceDigest: a lowercase sha256 hex digest is required`);
      }
      optionalString(last, 'sourceModifiedAt', `${where}.lastRefresh`);
      requiredString(last, 'refreshedAt', `${where}.lastRefresh`);
      intAtLeast(last, 'gridRows', `${where}.lastRefresh`, 1);
      intAtLeast(last, 'gridCols', `${where}.lastRefresh`, 1);
      const fingerprints = last.cellFingerprints;
      if (!Array.isArray(fingerprints)) fail(`${where}.lastRefresh.cellFingerprints: an array is required`);
      if (fingerprints.length < 1 || fingerprints.length > rowCount * colCount) {
        fail(`${where}.lastRefresh.cellFingerprints: length ${fingerprints.length} is outside 1..${rowCount * colCount}`);
      }
      fingerprints.forEach((fingerprint: unknown, j: number) => {
        if (typeof fingerprint !== 'string' || !HEX64.test(fingerprint)) {
          fail(`${where}.lastRefresh.cellFingerprints[${j}]: a lowercase sha256 hex digest is required`);
        }
      });
    }
  });
}

/* ------------------------------------------------------------------ */
/* Table search and rectangle geometry                                 */
/* ------------------------------------------------------------------ */

interface TableMatch {
  readonly table: TableEntity;
  /** Rebuild the state with this table replaced, in its own list. */
  readonly replace: (next: TableEntity) => DrawingState;
}

function collectTables(state: DrawingState): TableMatch[] {
  const matches: TableMatch[] = [];
  const scan = (entities: readonly Entity[], replaceList: (list: readonly Entity[]) => DrawingState): void => {
    entities.forEach((entity, index) => {
      if (entity.type !== 'table') return;
      matches.push({
        table: entity,
        replace: (next) => replaceList(entities.map((e, i) => (i === index ? next : e))),
      });
    });
  };
  scan(state.entities, (list) => ({ ...state, entities: list }));
  for (const [name, def] of Object.entries(state.blocks)) {
    scan(def.entities, (list) => ({ ...state, blocks: { ...state.blocks, [name]: { ...def, entities: list } } }));
  }
  (state.layouts ?? []).forEach((layout, layoutIndex) => {
    scan(layout.entities, (list) => ({
      ...state,
      layouts: (state.layouts ?? []).map((l, i) => (i === layoutIndex ? { ...l, entities: list } : l)),
    }));
  });
  return matches;
}

function findTablesByCadIdentity(state: DrawingState, cadIdentity: string): TableMatch[] {
  return collectTables(state).filter((match) => match.table.cadIdentity === cadIdentity);
}

function gridShape(table: TableEntity): { rows: number; cols: number } {
  return {
    rows: table.cells.length,
    cols: table.cells.reduce((max, row) => Math.max(max, row.length), 0),
  };
}

interface OwnerCell {
  readonly row: number;
  readonly col: number;
  readonly cell: TableCell;
}

type RectangleOwners = { readonly ok: true; readonly owners: readonly OwnerCell[] } | { readonly ok: false };

/** R5: resolve the rectangle's distinct OWNER cells, or fail on any merge violation. */
function rectangleOwners(
  table: TableEntity, firstRow: number, firstCol: number, rowCount: number, colCount: number,
): RectangleOwners {
  const owners = cellOwners(table);
  const seen = new Map<string, OwnerCell>();
  for (let r = firstRow; r < firstRow + rowCount; r += 1) {
    for (let c = firstCol; c < firstCol + colCount; c += 1) {
      const owner = owners[r]?.[c];
      if (!owner) return { ok: false };
      const [ownerRow, ownerCol] = owner;
      if (ownerRow < firstRow || ownerRow >= firstRow + rowCount
        || ownerCol < firstCol || ownerCol >= firstCol + colCount) {
        return { ok: false };
      }
      const key = `${ownerRow},${ownerCol}`;
      if (!seen.has(key)) {
        const cell = table.cells[ownerRow]?.[ownerCol];
        if (!cell) return { ok: false };
        const spanRows = cell.span?.rows ?? 1;
        const spanCols = cell.span?.cols ?? 1;
        if (ownerRow + spanRows > firstRow + rowCount || ownerCol + spanCols > firstCol + colCount) {
          return { ok: false };
        }
        seen.set(key, { row: ownerRow, col: ownerCol, cell });
      }
    }
  }
  return { ok: true, owners: [...seen.values()] };
}

/** The rectangle as a text grid with covered positions contributing their owner's text. */
function ownerExpandedTexts(
  table: TableEntity, firstRow: number, firstCol: number, rowCount: number, colCount: number,
): string[][] {
  const owners = cellOwners(table);
  const grid: string[][] = [];
  for (let r = 0; r < rowCount; r += 1) {
    const row: string[] = [];
    for (let c = 0; c < colCount; c += 1) {
      const owner = owners[firstRow + r]?.[firstCol + c];
      row.push(owner ? (table.cells[owner[0]]?.[owner[1]]?.text ?? '') : '');
    }
    grid.push(row);
  }
  return grid;
}

function baselineLastRefresh(table: TableEntity, target: DataLinkTarget, range: DataLinkSourceRange, now: string): DataLinkLastRefresh {
  const rect = rectangleOwners(table, target.firstRow, target.firstCol, range.rowCount, range.colCount);
  if (!rect.ok) throw new Error('data-links: baseline requested for a rectangle that fails merge integrity');
  const shape = gridShape(table);
  return {
    sourceDigest: snapshotDigest(ownerExpandedTexts(table, target.firstRow, target.firstCol, range.rowCount, range.colCount)),
    refreshedAt: now,
    gridRows: shape.rows,
    gridCols: shape.cols,
    cellFingerprints: rect.owners.map((owner) => cellFingerprint(owner.cell)),
  };
}

interface Rect {
  readonly r0: number;
  readonly c0: number;
  readonly r1: number;
  readonly c1: number;
}

const rectOf = (link: DataLink): Rect => ({
  r0: link.target.firstRow,
  c0: link.target.firstCol,
  r1: link.target.firstRow + link.sourceRange.rowCount,
  c1: link.target.firstCol + link.sourceRange.colCount,
});

const rectsOverlap = (a: Rect, b: Rect): boolean => a.r0 < b.r1 && b.r0 < a.r1 && a.c0 < b.c1 && b.c0 < a.c1;

/** R6: other links whose target resolves to THIS table and whose rectangle overlaps `link`'s. */
function overlappingLinks(state: DrawingState, link: DataLink, table: TableEntity): DataLink[] {
  return (state.dataLinks ?? []).filter((other) => {
    if (other.id === link.id || !other.target.tableCadIdentity) return false;
    const matches = findTablesByCadIdentity(state, other.target.tableCadIdentity);
    return matches.length === 1 && matches[0]!.table === table && rectsOverlap(rectOf(link), rectOf(other));
  });
}

function linkIssue(link: DataLink, kind: DataLinkIssueKind, message: string, cells?: readonly (readonly [number, number])[]): DataLinkIssue {
  return { linkId: link.id, kind, message, ...(cells ? { cells } : {}) };
}

/* ------------------------------------------------------------------ */
/* Creation (binds by entity id in-session; records the durable keys)  */
/* ------------------------------------------------------------------ */

export interface CreateDataLinkSpec {
  /** Link id; a fresh id is allocated when absent. */
  readonly id?: string;
  readonly sourcePath: string;
  readonly sourceRange: DataLinkSourceRange;
  /** In-session entity id of the target table (a lookup accelerator, never the stored key). */
  readonly tableId: string;
  readonly firstRow: number;
  readonly firstCol: number;
  /** Caller-supplied timestamp (this module is clock-free). */
  readonly now: string;
}

export type CreateEvaluation =
  | { readonly kind: 'create'; readonly link: DataLink; readonly issues: readonly DataLinkIssue[] }
  | { readonly kind: 'refuse'; readonly message: string; readonly issue?: DataLinkIssue };

export function evaluateCreateDataLink(state: DrawingState, spec: CreateDataLinkSpec): CreateEvaluation {
  const refuse = (message: string, issue?: DataLinkIssue): CreateEvaluation => ({ kind: 'refuse', message, ...(issue ? { issue } : {}) });
  const id = spec.id ?? newId();
  const { rowCount, colCount } = spec.sourceRange;
  if (!Number.isSafeInteger(spec.sourceRange.firstRow) || spec.sourceRange.firstRow < 0
    || !Number.isSafeInteger(spec.sourceRange.firstCol) || spec.sourceRange.firstCol < 0
    || !Number.isSafeInteger(rowCount) || rowCount < 1
    || !Number.isSafeInteger(colCount) || colCount < 1
    || !Number.isSafeInteger(spec.firstRow) || spec.firstRow < 0
    || !Number.isSafeInteger(spec.firstCol) || spec.firstCol < 0) {
    return refuse('data-links: source range and target position must be non-negative integers with a positive range shape');
  }
  if (rowCount * colCount > DATA_LINK_CELL_CAP) {
    return refuse(`data-links: range ${rowCount}x${colCount} exceeds the ${DATA_LINK_CELL_CAP}-cell cap`);
  }
  if ((state.dataLinks ?? []).some((link) => link.id === id)) {
    return refuse(`data-links: a link with id "${id}" already exists`);
  }
  const match = collectTables(state).find((candidate) => candidate.table.id === spec.tableId);
  if (!match) {
    return refuse(
      `data-links: no table with id "${spec.tableId}" in this drawing`,
      linkIssue({ id } as DataLink, 'broken', `no table with id "${spec.tableId}" in this drawing`),
    );
  }
  const table = match.table;
  const shape = gridShape(table);
  if (spec.firstRow + rowCount > shape.rows || spec.firstCol + colCount > shape.cols) {
    return refuse(
      `data-links: target rectangle (${spec.firstRow},${spec.firstCol}) ${rowCount}x${colCount} does not fit the table grid ${shape.rows}x${shape.cols}`,
      linkIssue({ id } as DataLink, 'target-out-of-range', 'target rectangle does not fit the table grid'),
    );
  }
  const target: DataLinkTarget = {
    ...(table.cadIdentity ? { tableCadIdentity: table.cadIdentity } : {}),
    firstRow: spec.firstRow,
    firstCol: spec.firstCol,
  };
  const rect = rectangleOwners(table, spec.firstRow, spec.firstCol, rowCount, colCount);
  if (!rect.ok) {
    return refuse(
      'data-links: the target rectangle cuts a merged cell or covers a cell owned from outside the rectangle',
      linkIssue({ id } as DataLink, 'merge-boundary', 'target rectangle violates merge integrity (R5)'),
    );
  }
  const link: DataLink = {
    id,
    sourcePath: spec.sourcePath,
    sourceRange: { ...spec.sourceRange },
    target,
    direction: 'down',
    lastRefresh: baselineLastRefresh(table, target, spec.sourceRange, spec.now),
  };
  const overlaps = overlappingLinks(state, link, table);
  if (overlaps.length > 0) {
    return refuse(
      `data-links: the target rectangle overlaps link(s) ${overlaps.map((other) => other.id).join(', ')} on the same table`,
      linkIssue(link, 'overlap', 'target rectangle overlaps another link on the same table (R6)'),
    );
  }
  const issues: DataLinkIssue[] = [];
  if (!table.cadIdentity) {
    issues.push(linkIssue(link, 'unresolvable-on-reopen',
      'the target table carries no cadIdentity: this link has no durable key and cannot be resolved after the drawing is reopened'));
  }
  return { kind: 'create', link, issues };
}

/* ------------------------------------------------------------------ */
/* Re-range (the explicit remedy for shape refusals; re-baselines)     */
/* ------------------------------------------------------------------ */

export interface ReRangeDataLinkPatch {
  readonly sourceRange?: DataLinkSourceRange;
  readonly firstRow?: number;
  readonly firstCol?: number;
}

export type ReRangeEvaluation =
  | { readonly kind: 'rerange'; readonly link: DataLink; readonly issues: readonly DataLinkIssue[] }
  | { readonly kind: 'refuse'; readonly message: string; readonly issue?: DataLinkIssue };

export function evaluateReRangeDataLink(
  state: DrawingState, link: DataLink, patch: ReRangeDataLinkPatch, now: string,
): ReRangeEvaluation {
  const refuse = (message: string, issue?: DataLinkIssue): ReRangeEvaluation => ({ kind: 'refuse', message, ...(issue ? { issue } : {}) });
  const sourceRange = patch.sourceRange ?? link.sourceRange;
  const target: DataLinkTarget = {
    ...(link.target.tableCadIdentity ? { tableCadIdentity: link.target.tableCadIdentity } : {}),
    firstRow: patch.firstRow ?? link.target.firstRow,
    firstCol: patch.firstCol ?? link.target.firstCol,
  };
  const { rowCount, colCount } = sourceRange;
  if (!Number.isSafeInteger(rowCount) || rowCount < 1 || !Number.isSafeInteger(colCount) || colCount < 1
    || !Number.isSafeInteger(target.firstRow) || target.firstRow < 0
    || !Number.isSafeInteger(target.firstCol) || target.firstCol < 0) {
    return refuse('data-links: re-range needs a positive range shape and a non-negative target position');
  }
  if (rowCount * colCount > DATA_LINK_CELL_CAP) {
    return refuse(`data-links: range ${rowCount}x${colCount} exceeds the ${DATA_LINK_CELL_CAP}-cell cap`);
  }
  const cadIdentity = link.target.tableCadIdentity;
  if (!cadIdentity) {
    return refuse(
      'data-links: the link has no tableCadIdentity and cannot be resolved for re-range',
      linkIssue(link, 'broken', 'link target cannot be resolved (no cadIdentity key)'),
    );
  }
  const matches = findTablesByCadIdentity(state, cadIdentity);
  if (matches.length === 0) {
    return refuse(`data-links: no table carries cadIdentity "${cadIdentity}"`, linkIssue(link, 'broken', 'target table not found'));
  }
  if (matches.length > 1) {
    return refuse(
      `data-links: ${matches.length} tables carry cadIdentity "${cadIdentity}"`,
      linkIssue(link, 'ambiguous', 'target cadIdentity resolves to more than one table'),
    );
  }
  const table = matches[0]!.table;
  const shape = gridShape(table);
  if (target.firstRow + rowCount > shape.rows || target.firstCol + colCount > shape.cols) {
    return refuse(
      `data-links: target rectangle (${target.firstRow},${target.firstCol}) ${rowCount}x${colCount} does not fit the table grid ${shape.rows}x${shape.cols}`,
      linkIssue(link, 'target-out-of-range', 'target rectangle does not fit the table grid'),
    );
  }
  if (!rectangleOwners(table, target.firstRow, target.firstCol, rowCount, colCount).ok) {
    return refuse(
      'data-links: the re-ranged rectangle cuts a merged cell or covers a cell owned from outside the rectangle',
      linkIssue(link, 'merge-boundary', 'target rectangle violates merge integrity (R5)'),
    );
  }
  const next: DataLink = {
    ...link,
    sourceRange: { ...sourceRange },
    target,
    lastRefresh: baselineLastRefresh(table, target, sourceRange, now),
  };
  const overlaps = overlappingLinks(state, next, table);
  if (overlaps.length > 0) {
    return refuse(
      `data-links: the re-ranged rectangle overlaps link(s) ${overlaps.map((other) => other.id).join(', ')} on the same table`,
      linkIssue(link, 'overlap', 'target rectangle overlaps another link on the same table (R6)'),
    );
  }
  return { kind: 'rerange', link: next, issues: [] };
}

/* ------------------------------------------------------------------ */
/* Refresh (pure reconciliation + transition builder)                  */
/* ------------------------------------------------------------------ */

export interface RefreshDataLinkOptions {
  /** Caller-supplied timestamp (this module is clock-free). */
  readonly now: string;
  /** Per-refresh confirmation for cells-modified-since-refresh; never persisted. */
  readonly confirmOverwrite?: boolean;
  readonly sourceModifiedAt?: string;
}

export type RefreshEvaluation =
  | { readonly kind: 'proceed'; readonly next: DrawingState }
  | { readonly kind: 'already-current' }
  | { readonly kind: 'needs-confirmation'; readonly issue: DataLinkIssue }
  | { readonly kind: 'refuse'; readonly issue: DataLinkIssue };

export function evaluateRefreshDataLink(
  state: DrawingState, link: DataLink, snapshot: SourceSnapshot, options: RefreshDataLinkOptions,
): RefreshEvaluation {
  const refuse = (kind: DataLinkIssueKind, message: string, cells?: readonly (readonly [number, number])[]): RefreshEvaluation => (
    { kind: 'refuse', issue: linkIssue(link, kind, message, cells) }
  );
  // R1 — resolution, never a silent rebind.
  const cadIdentity = link.target.tableCadIdentity;
  if (!cadIdentity) {
    return refuse('broken', 'the link has no tableCadIdentity key and cannot be resolved; it was reported unresolvable-on-reopen from creation');
  }
  const matches = findTablesByCadIdentity(state, cadIdentity);
  if (matches.length === 0) return refuse('broken', `no table carries cadIdentity "${cadIdentity}"`);
  if (matches.length > 1) return refuse('ambiguous', `${matches.length} tables carry cadIdentity "${cadIdentity}"; refusing to choose`);
  const match = matches[0]!;
  const table = match.table;
  // R6 — overlap on the same table.
  const overlaps = overlappingLinks(state, link, table);
  if (overlaps.length > 0) {
    return refuse('overlap', `link overlaps link(s) ${overlaps.map((other) => other.id).join(', ')} on the same table`);
  }
  // R2 — source shape must equal the recorded range shape.
  const { rowCount, colCount } = link.sourceRange;
  const snapRows = snapshot.grid.length;
  const snapCols = snapshot.grid[0]?.length ?? 0;
  if (snapRows !== rowCount || snapCols !== colCount || snapshot.grid.some((row) => row.length !== colCount)) {
    return refuse('source-shape-changed', `source snapshot is ${snapRows}x${snapCols} but the link range is ${rowCount}x${colCount}; re-range the link to adopt the new shape`);
  }
  // R3 — the target rectangle must still fit the grid.
  const shape = gridShape(table);
  const { firstRow, firstCol } = link.target;
  if (firstRow + rowCount > shape.rows || firstCol + colCount > shape.cols) {
    return refuse('target-out-of-range', `target rectangle (${firstRow},${firstCol}) ${rowCount}x${colCount} no longer fits the table grid ${shape.rows}x${shape.cols}`);
  }
  // R5 — merge integrity.
  const rect = rectangleOwners(table, firstRow, firstCol, rowCount, colCount);
  if (!rect.ok) {
    return refuse('merge-boundary', 'the target rectangle cuts a merged cell or covers a cell owned from outside the rectangle');
  }
  // Baseline presence — no baseline, no refresh (never a silent first write).
  const last = link.lastRefresh;
  if (!last) {
    return refuse('broken', 'the link carries no refresh baseline; re-range the link to re-baseline it before refreshing');
  }
  // R4 structural limb — unconditional refusal, confirmation cannot override.
  if (last.gridRows !== shape.rows || last.gridCols !== shape.cols) {
    return refuse('grid-shape-changed', `the table grid is ${shape.rows}x${shape.cols} but the last refresh recorded ${last.gridRows}x${last.gridCols}; re-range the link to re-baseline it`);
  }
  // R4 fingerprint limb — drift needs a per-refresh confirmation.
  const current = rect.owners.map((owner) => cellFingerprint(owner.cell));
  if (current.length !== last.cellFingerprints.length) {
    return refuse('grid-shape-changed', 'the rectangle owner set changed since the last refresh (a merge appeared or vanished); re-range the link to re-baseline it');
  }
  const differing: (readonly [number, number])[] = [];
  rect.owners.forEach((owner, i) => {
    if (current[i] !== last.cellFingerprints[i]) differing.push([owner.row, owner.col]);
  });
  if (differing.length > 0 && options.confirmOverwrite !== true) {
    return {
      kind: 'needs-confirmation',
      issue: linkIssue(link, 'cells-modified-since-refresh',
        `${differing.length} target cell(s) were edited since the last refresh; refreshing overwrites them`, differing),
    };
  }
  // Already-current — no write at all (Q5).
  if (differing.length === 0 && snapshot.digest === last.sourceDigest) return { kind: 'already-current' };
  // Write: OWNER cells only, one pure state transition.
  const changedByRow = new Map<number, Map<number, TableCell>>();
  for (const owner of rect.owners) {
    const newText = snapshot.grid[owner.row - firstRow]![owner.col - firstCol]!;
    if (newText === owner.cell.text) continue;
    let rowMap = changedByRow.get(owner.row);
    if (!rowMap) {
      rowMap = new Map();
      changedByRow.set(owner.row, rowMap);
    }
    rowMap.set(owner.col, { ...owner.cell, text: newText, raw: undefined });
  }
  const newCells = table.cells.map((row, r) => {
    const rowMap = changedByRow.get(r);
    return rowMap ? row.map((cell, c) => rowMap.get(c) ?? cell) : row;
  });
  const nextTable: TableEntity = { ...table, cells: newCells };
  const nextLink: DataLink = {
    ...link,
    lastRefresh: {
      sourceDigest: snapshot.digest,
      ...(options.sourceModifiedAt ? { sourceModifiedAt: options.sourceModifiedAt } : {}),
      refreshedAt: options.now,
      gridRows: shape.rows,
      gridCols: shape.cols,
      cellFingerprints: rect.owners.map((owner) => cellFingerprint(newCells[owner.row]![owner.col]!)),
    },
  };
  const replaced = match.replace(nextTable);
  const next: DrawingState = {
    ...replaced,
    dataLinks: (replaced.dataLinks ?? []).map((candidate) => (candidate.id === link.id ? nextLink : candidate)),
  };
  return { kind: 'proceed', next };
}

/* ------------------------------------------------------------------ */
/* Link issues (read-only reporting; never heals, never dirties)       */
/* ------------------------------------------------------------------ */

export interface DataLinkSourceCheck {
  /** Digest of the live source snapshot, when the host could read and parse it. */
  readonly digest?: string;
  readonly unreadableReason?: string;
  readonly parseRefusalReason?: string;
}

export function dataLinkIssues(state: DrawingState, link: DataLink, sourceCheck: DataLinkSourceCheck = {}): DataLinkIssue[] {
  const issues: DataLinkIssue[] = [];
  const push = (kind: DataLinkIssueKind, message: string, cells?: readonly (readonly [number, number])[]): void => {
    issues.push(linkIssue(link, kind, message, cells));
  };
  const cadIdentity = link.target.tableCadIdentity;
  let table: TableEntity | undefined;
  if (!cadIdentity) {
    push('unresolvable-on-reopen', 'the target table carries no cadIdentity: this link has no durable key and cannot be resolved after the drawing is reopened');
  } else {
    const matches = findTablesByCadIdentity(state, cadIdentity);
    if (matches.length === 0) push('broken', `no table carries cadIdentity "${cadIdentity}"`);
    else if (matches.length > 1) push('ambiguous', `${matches.length} tables carry cadIdentity "${cadIdentity}"; refusing to choose`);
    else table = matches[0]!.table;
  }
  if (table) {
    const overlaps = overlappingLinks(state, link, table);
    if (overlaps.length > 0) {
      push('overlap', `link overlaps link(s) ${overlaps.map((other) => other.id).join(', ')} on the same table`);
    }
    const shape = gridShape(table);
    const { firstRow, firstCol } = link.target;
    const { rowCount, colCount } = link.sourceRange;
    if (firstRow + rowCount > shape.rows || firstCol + colCount > shape.cols) {
      push('target-out-of-range', `target rectangle (${firstRow},${firstCol}) ${rowCount}x${colCount} no longer fits the table grid ${shape.rows}x${shape.cols}`);
    } else {
      const rect = rectangleOwners(table, firstRow, firstCol, rowCount, colCount);
      if (!rect.ok) push('merge-boundary', 'the target rectangle cuts a merged cell or covers a cell owned from outside the rectangle');
      const last = link.lastRefresh;
      if (last) {
        if (last.gridRows !== shape.rows || last.gridCols !== shape.cols) {
          push('grid-shape-changed', `the table grid is ${shape.rows}x${shape.cols} but the last refresh recorded ${last.gridRows}x${last.gridCols}`);
        } else if (rect.ok) {
          const current = rect.owners.map((owner) => cellFingerprint(owner.cell));
          if (current.length === last.cellFingerprints.length) {
            const differing: (readonly [number, number])[] = [];
            rect.owners.forEach((owner, i) => {
              if (current[i] !== last.cellFingerprints[i]) differing.push([owner.row, owner.col]);
            });
            if (differing.length > 0) {
              push('cells-modified-since-refresh', `${differing.length} target cell(s) were edited since the last refresh`, differing);
            }
          }
        }
      }
    }
  }
  if (sourceCheck.unreadableReason) push('source-unreadable', sourceCheck.unreadableReason);
  if (sourceCheck.parseRefusalReason) push('source-parse-refused', sourceCheck.parseRefusalReason);
  if (sourceCheck.digest !== undefined && link.lastRefresh && sourceCheck.digest !== link.lastRefresh.sourceDigest) {
    push('stale', 'the source snapshot differs from the one the current cell content corresponds to');
  }
  return issues;
}
