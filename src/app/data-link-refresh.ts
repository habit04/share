/**
 * Data-link host seam (P31-B) — PROPOSAL-P31-B, ADMITTED FOR DEVELOPMENT
 * by the lead 2026-10-21 (Q1 digest-excluded, Q7 drawing-directory path
 * resolution, Q8 refresh-is-an-edit). The pure reconciliation lives in
 * src/project/data-links.ts; this module is the ONLY place a data link
 * touches the outside world:
 *
 * - source bytes arrive through the injected DataLinkFileSeam (the app's
 *   file seam in production; an in-memory fake in tests);
 * - delimited-text parsing happens here, under the bounded-work caps;
 * - path discipline (Q7) is enforced here, before any read;
 * - the ONE refresh transact call site lives here: a proceeding
 *   evaluation is applied with a single Drawing.transactDrawing, so the
 *   refresh is one undo step and — Q8 — invalidates a preserved
 *   signature record in the same operation through the existing
 *   commitTransition detection. Creation and re-range transact the same
 *   way and invalidate likewise. Nothing else in this module mutates the
 *   drawing; checkDataLinks is strictly read-only.
 *
 * USER NOTICE (the in-session-only limit, stated where a user creating
 * or refreshing a link will see it): every outcome of createDataLink,
 * refreshDataLink and reRangeDataLink carries `notice` =
 * DATA_LINKS_NOT_SAVED_NOTICE verbatim. These outcomes ARE the
 * user-facing surface for data links in this slice (the admitted build
 * surface names no other); a future dialog renders the same constant.
 *
 * PARSING RULES (pinned; hand-scanned, no backtracking regex over
 * untrusted text): the delimiter is fixed by extension — .csv → comma,
 * .tsv/.tab → tab; anything else is refused (no sniffing; workbooks are
 * OUT — a workbook reader is a separate dependency proposal). UTF-8 with
 * BOM stripped; undecodable bytes refuse the whole parse. RFC-4180-style
 * double quotes: a quote at a field start opens a quoted section, "" is
 * an escaped quote, a closing quote must be followed by the delimiter, a
 * line ending or EOF (anything else is malformed and refuses the whole
 * parse, as does an unterminated quoted field); a quote anywhere else is
 * a literal character. CRLF, LF and lone CR are line endings. Short rows
 * are padded with empty cells (the trailing-cell convention — stated
 * here, and the snapshot digest is computed over the padded grid, so the
 * digest both sides compare is over the same canonical grid). Numbers
 * stay TEXT: nothing is coerced, and formula-looking text (e.g.
 * =SUM(A1:A2)) lands as literal cell text — refresh never evaluates.
 *
 * BOUNDED WORK (pinned): a source file over 8 MiB is refused BEFORE
 * parsing; a link range over 100,000 cells is refused at creation and
 * by the record validator; a single parsed cell over 32 KiB of UTF-8
 * refuses the whole refresh.
 *
 * PATH DISCIPLINE (Q7): a recorded absolute path is used as recorded
 * (only absolute-created links may point outside the drawing tree);
 * a recorded relative path resolves against the DRAWING-FILE directory
 * and refuses when it escapes that directory — climbsOut on the
 * relative form, or no in-tree relative form exists (relativePath
 * returns the absolute target when the two share only the filesystem
 * root) — and refuses on an unsaved drawing (no base directory).
 * Network forms (scheme:// URLs, UNC paths) are refused outright —
 * sources are local files only. The recorded path is never rewritten
 * in the link record.
 */
import type { Drawing } from '../core/document';
import { climbsOut, dirName, isAbsolutePath, normalizePath, relativePath, resolveFromFile } from './paths';
import {
  dataLinkIssues,
  evaluateCreateDataLink,
  evaluateRefreshDataLink,
  evaluateReRangeDataLink,
  findDataLink,
  snapshotDigest,
  type CreateDataLinkSpec,
  type DataLink,
  type DataLinkIssue,
  type DataLinkSourceCheck,
  type ReRangeDataLinkPatch,
} from '../project/data-links';

/** The in-session-only limit, stated plainly; carried on every outcome (see header). */
export const DATA_LINKS_NOT_SAVED_NOTICE =
  'Data links are not saved with the drawing. A data link lasts only for this session and is lost when the drawing is saved and reopened; the table contents it refreshed stay in the drawing as ordinary table content.';

export const DATA_LINK_SOURCE_MAX_BYTES = 8 * 1024 * 1024;
export const DATA_LINK_CELL_MAX_BYTES = 32 * 1024;

/** The app's file seam, narrowed to what data links need. */
export interface DataLinkFileSeam {
  readBytes(path: string): Promise<Uint8Array>;
  modifiedAt?(path: string): Promise<string | undefined>;
}

export type DataLinkHostOutcome =
  | { readonly kind: 'created' | 'refreshed' | 're-ranged'; readonly link: DataLink; readonly notice: string }
  | { readonly kind: 'already-current'; readonly link: DataLink; readonly notice: string }
  | { readonly kind: 'needs-confirmation'; readonly link: DataLink; readonly issue: DataLinkIssue; readonly notice: string }
  | { readonly kind: 'refused'; readonly reason: string; readonly issue?: DataLinkIssue; readonly notice: string };

const refused = (reason: string, issue?: DataLinkIssue): DataLinkHostOutcome => ({
  kind: 'refused', reason, ...(issue ? { issue } : {}), notice: DATA_LINKS_NOT_SAVED_NOTICE,
});

/* ------------------------------------------------------------------ */
/* Path discipline (Q7)                                                */
/* ------------------------------------------------------------------ */

export type SourcePathResolution =
  | { readonly kind: 'path'; readonly path: string }
  | { readonly kind: 'refuse'; readonly reason: string };

export function resolveDataLinkSourcePath(link: DataLink, drawingFilePath: string | null): SourcePathResolution {
  const recorded = link.sourcePath;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(recorded) || recorded.startsWith('//') || recorded.startsWith('\\\\')) {
    return { kind: 'refuse', reason: `data-link source "${recorded}" is a network location; sources are local files only` };
  }
  if (isAbsolutePath(recorded)) return { kind: 'path', path: normalizePath(recorded) };
  if (!drawingFilePath) {
    return { kind: 'refuse', reason: `data-link source "${recorded}" is relative and the drawing has never been saved: there is no drawing-file directory to resolve it against` };
  }
  const resolved = resolveFromFile(drawingFilePath, recorded);
  const rel = relativePath(dirName(normalizePath(drawingFilePath)), resolved);
  if (isAbsolutePath(rel) || climbsOut(rel)) {
    return {
      kind: 'refuse',
      reason: `data-link source "${recorded}" climbs out of the drawing-file directory; only a link created with an absolute path may point outside it`,
    };
  }
  return { kind: 'path', path: resolved };
}

/* ------------------------------------------------------------------ */
/* Delimited-text parsing (rules pinned in the header)                 */
/* ------------------------------------------------------------------ */

export type DelimitedParseResult =
  | { readonly kind: 'grid'; readonly grid: string[][] }
  | { readonly kind: 'refuse'; readonly reason: string };

export function parseDelimitedSource(bytes: Uint8Array, fileName: string): DelimitedParseResult {
  const lower = fileName.toLowerCase();
  const delimiter = lower.endsWith('.csv') ? ',' : (lower.endsWith('.tsv') || lower.endsWith('.tab')) ? '\t' : undefined;
  if (delimiter === undefined) {
    return { kind: 'refuse', reason: `unsupported data-link source "${fileName}": only .csv / .tsv delimited text is supported (workbooks are out of scope)` };
  }
  if (bytes.length > DATA_LINK_SOURCE_MAX_BYTES) {
    return { kind: 'refuse', reason: `source is ${bytes.length} bytes, over the 8 MiB cap` };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { kind: 'refuse', reason: 'source is not decodable as UTF-8' };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldStart = true;
  let fieldQuoted = false;
  let rowHasContent = false;
  const endField = (): void => {
    row.push(field);
    field = '';
    fieldStart = true;
    fieldQuoted = false;
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
    rowHasContent = false;
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (fieldQuoted && ch !== delimiter && ch !== '\n' && ch !== '\r') {
      return { kind: 'refuse', reason: `malformed quote: character "${ch}" after a closing quote at offset ${i}` };
    }
    if (ch === '"' && fieldStart) {
      inQuotes = true;
      fieldQuoted = true;
      fieldStart = false;
      rowHasContent = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      endField();
      rowHasContent = true;
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      endRow();
      i += 1;
      continue;
    }
    field += ch;
    fieldStart = false;
    rowHasContent = true;
    i += 1;
  }
  if (inQuotes) return { kind: 'refuse', reason: 'malformed quote: unterminated quoted field' };
  if (rowHasContent || row.length > 0 || field.length > 0) endRow();

  const width = rows.reduce((max, r) => Math.max(max, r.length), 0);
  const encoder = new TextEncoder();
  for (const r of rows) {
    while (r.length < width) r.push('');
    for (const cellText of r) {
      if (encoder.encode(cellText).length > DATA_LINK_CELL_MAX_BYTES) {
        return { kind: 'refuse', reason: 'a source cell exceeds the 32 KiB cap' };
      }
    }
  }
  return { kind: 'grid', grid: rows };
}

/**
 * The source range sliced out of a parsed grid: exactly what the file
 * covers, never padded into existence — a short slice is how R2 sees a
 * source that shrank.
 */
export function extractSourceRange(
  grid: readonly (readonly string[])[], range: DataLink['sourceRange'],
): string[][] {
  const rows: string[][] = [];
  const endRow = Math.min(range.firstRow + range.rowCount, grid.length);
  for (let r = range.firstRow; r < endRow; r += 1) {
    rows.push(grid[r]!.slice(range.firstCol, range.firstCol + range.colCount));
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* Flows                                                               */
/* ------------------------------------------------------------------ */

export function createDataLink(drawing: Drawing, spec: CreateDataLinkSpec): DataLinkHostOutcome {
  const evaluation = evaluateCreateDataLink(drawing.snapshot, spec);
  if (evaluation.kind === 'refuse') return refused(evaluation.message, evaluation.issue);
  const link = evaluation.link;
  drawing.transactDrawing((state) => ({ ...state, dataLinks: [...(state.dataLinks ?? []), link] }));
  return { kind: 'created', link, notice: DATA_LINKS_NOT_SAVED_NOTICE };
}

export function reRangeDataLink(
  drawing: Drawing, linkId: string, patch: ReRangeDataLinkPatch, now: string,
): DataLinkHostOutcome {
  const link = findDataLink(drawing.snapshot, linkId);
  if (!link) return refused(`no data link with id "${linkId}" in this drawing`);
  const evaluation = evaluateReRangeDataLink(drawing.snapshot, link, patch, now);
  if (evaluation.kind === 'refuse') return refused(evaluation.message, evaluation.issue);
  const next = evaluation.link;
  drawing.transactDrawing((state) => ({
    ...state,
    dataLinks: (state.dataLinks ?? []).map((candidate) => (candidate.id === linkId ? next : candidate)),
  }));
  return { kind: 're-ranged', link: next, notice: DATA_LINKS_NOT_SAVED_NOTICE };
}

/** Read + parse + slice one link's source snapshot through the seam. */
async function readSourceSnapshot(
  drawing: Drawing, seam: DataLinkFileSeam, link: DataLink,
): Promise<
  | { readonly kind: 'snapshot'; readonly grid: string[][]; readonly digest: string; readonly sourceModifiedAt?: string }
  | { readonly kind: 'refused'; readonly outcome: DataLinkHostOutcome }
> {
  const resolved = resolveDataLinkSourcePath(link, drawing.filePath);
  if (resolved.kind === 'refuse') {
    return {
      kind: 'refused',
      outcome: refused(resolved.reason, { linkId: link.id, kind: 'source-unreadable', message: resolved.reason }),
    };
  }
  let bytes: Uint8Array;
  try {
    bytes = await seam.readBytes(resolved.path);
  } catch (err) {
    const reason = `source unreadable: ${err instanceof Error ? err.message : String(err)}`;
    return { kind: 'refused', outcome: refused(reason, { linkId: link.id, kind: 'source-unreadable', message: reason }) };
  }
  if (bytes.length > DATA_LINK_SOURCE_MAX_BYTES) {
    const reason = `source is ${bytes.length} bytes, over the 8 MiB cap (refused before parsing)`;
    return { kind: 'refused', outcome: refused(reason, { linkId: link.id, kind: 'source-unreadable', message: reason }) };
  }
  const parsed = parseDelimitedSource(bytes, resolved.path);
  if (parsed.kind === 'refuse') {
    return {
      kind: 'refused',
      outcome: refused(parsed.reason, { linkId: link.id, kind: 'source-parse-refused', message: parsed.reason }),
    };
  }
  const grid = extractSourceRange(parsed.grid, link.sourceRange);
  let sourceModifiedAt: string | undefined;
  try {
    sourceModifiedAt = await seam.modifiedAt?.(resolved.path);
  } catch {
    sourceModifiedAt = undefined;
  }
  return { kind: 'snapshot', grid, digest: snapshotDigest(grid), ...(sourceModifiedAt ? { sourceModifiedAt } : {}) };
}

export async function refreshDataLink(
  drawing: Drawing,
  seam: DataLinkFileSeam,
  linkId: string,
  options: { readonly confirmOverwrite?: boolean } = {},
): Promise<DataLinkHostOutcome> {
  const link = findDataLink(drawing.snapshot, linkId);
  if (!link) return refused(`no data link with id "${linkId}" in this drawing`);
  const source = await readSourceSnapshot(drawing, seam, link);
  if (source.kind === 'refused') return source.outcome;
  const evaluation = evaluateRefreshDataLink(
    drawing.snapshot,
    link,
    { grid: source.grid, digest: source.digest },
    {
      now: new Date().toISOString(),
      confirmOverwrite: options.confirmOverwrite === true,
      ...(source.sourceModifiedAt ? { sourceModifiedAt: source.sourceModifiedAt } : {}),
    },
  );
  switch (evaluation.kind) {
    case 'already-current':
      return { kind: 'already-current', link, notice: DATA_LINKS_NOT_SAVED_NOTICE };
    case 'needs-confirmation':
      return { kind: 'needs-confirmation', link, issue: evaluation.issue, notice: DATA_LINKS_NOT_SAVED_NOTICE };
    case 'refuse':
      return refused(evaluation.issue.message, evaluation.issue);
    case 'proceed': {
      const next = evaluation.next;
      // THE one refresh transact call site (Q8: one undo step; signature
      // invalidation folds into this same transition via commitTransition).
      drawing.transactDrawing(() => next);
      return { kind: 'refreshed', link: findDataLink(drawing.snapshot, linkId) ?? link, notice: DATA_LINKS_NOT_SAVED_NOTICE };
    }
  }
}

/** Read-only staleness/issue report for every link in the drawing. */
export async function checkDataLinks(
  drawing: Drawing, seam: DataLinkFileSeam,
): Promise<readonly { readonly link: DataLink; readonly issues: readonly DataLinkIssue[] }[]> {
  const state = drawing.snapshot;
  const results: { link: DataLink; issues: readonly DataLinkIssue[] }[] = [];
  for (const link of state.dataLinks ?? []) {
    let sourceCheck: DataLinkSourceCheck = {};
    const resolved = resolveDataLinkSourcePath(link, drawing.filePath);
    if (resolved.kind === 'refuse') {
      sourceCheck = { unreadableReason: resolved.reason };
    } else {
      try {
        const bytes = await seam.readBytes(resolved.path);
        if (bytes.length > DATA_LINK_SOURCE_MAX_BYTES) {
          sourceCheck = { unreadableReason: `source is ${bytes.length} bytes, over the 8 MiB cap` };
        } else {
          const parsed = parseDelimitedSource(bytes, resolved.path);
          if (parsed.kind === 'refuse') sourceCheck = { parseRefusalReason: parsed.reason };
          else sourceCheck = { digest: snapshotDigest(extractSourceRange(parsed.grid, link.sourceRange)) };
        }
      } catch (err) {
        sourceCheck = { unreadableReason: `source unreadable: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    results.push({ link, issues: dataLinkIssues(state, link, sourceCheck) });
  }
  return results;
}
