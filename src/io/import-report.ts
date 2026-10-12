/**
 * Import report: what a DXF / DWG reader dropped, simplified or kept without being able to show
 * it, so the user is told instead of losing content silently.
 *
 * The report travels with the drawing state (`meta.importReport`, like the retained raw DXF
 * records in `meta.dxfRawEntities`), so it follows the document through tabs and undo. It is
 * never written to a file: re-opening a saved drawing produces a fresh report.
 */
import type { DrawingState } from '../core/document';
import { expansionReport, MAX_INSERT_EXPANSION, MAX_BLOCK_EXPANSION_WORK, type BlockDef, type Entity } from '../core/entities';
import { mtextFormattingProblem } from '../core/mtext';
import { polylineWidthProblem } from '../core/polyline-widths';
import { samePath } from '../app/paths';
import { textPlacementProblem, placedText } from '../core/text-placement';
import { textWidth } from '../core/entities';
import { mtextBackgroundProblem } from '../core/mtext-background';
import { insertArrayProblem } from '../core/insert-array';

/**
 * - dropped: not imported; it is lost when the drawing is saved.
 * - simplified: imported in a reduced form (some of its data is not kept).
 * - kept: not shown or editable, but kept as it was and written back on save.
 * - unsupported: a property the reader cannot see at all (DWG reader limits), reported once.
 */
export type ImportAction = 'dropped' | 'simplified' | 'kept' | 'unsupported';

export interface ImportReportItem {
  /** DXF object type (LINE, 3DSOLID, VIEWPORT ...) or a property name for `unsupported`. */
  readonly type: string;
  readonly action: ImportAction;
  readonly reason: string;
  /** Handle in the source file (DXF group 5), when it has one. */
  readonly handle?: string;
  readonly layer?: string;
  /** 1-based line of the object's first group in a DXF file. */
  readonly line?: number;
  /** Where the object was: model space, a layout, a block definition. */
  readonly where?: string;
}

export interface ImportReport {
  readonly format: 'DXF' | 'DWG';
  /** The file the drawing was read from (Save over it warns while there are losses). */
  readonly sourcePath?: string | null;
  /** Counts per type and action over every item (the item list itself is capped). */
  readonly counts: Readonly<Record<string, Readonly<Partial<Record<ImportAction, number>>>>>;
  /** The first MAX_REPORT_ITEMS items. */
  readonly items: readonly ImportReportItem[];
  /** Items not listed because of the cap. */
  readonly omitted: number;
  /** Free-form remarks (approximations, estimated positions). */
  readonly notes: readonly string[];
  /** The file was damaged: what was read up to the damage was opened (explicit partial recovery). */
  readonly recovered?: { readonly line: number; readonly message: string };
}

/** One unknown ENTITIES-section record, kept as its group codes and written back verbatim. */
export interface RawDxfEntity {
  readonly type: string;
  readonly layer: string;
  /** Handle in the source file (a new one is assigned on save). */
  readonly handle?: string;
  /** Group codes and values after the type (handle, owner and references removed). */
  readonly groups: ReadonlyArray<readonly [number, string]>;
}

export const IMPORT_REPORT_META_KEY = 'importReport';
export const RAW_ENTITIES_META_KEY = 'dxfRawEntities';
export const MAX_REPORT_ITEMS = 1000;

/** Collects report items while a reader runs. */
export class ImportReportBuilder {
  readonly items: ImportReportItem[] = [];
  readonly counts: Record<string, Partial<Record<ImportAction, number>>> = {};
  readonly notes: string[] = [];
  omitted = 0;
  recovered?: { line: number; message: string };

  add(item: ImportReportItem): void {
    const c = (this.counts[item.type] ??= {});
    c[item.action] = (c[item.action] ?? 0) + 1;
    if (this.items.length < MAX_REPORT_ITEMS) this.items.push(item);
    else this.omitted += 1;
  }

  note(text: string): void {
    if (!this.notes.includes(text)) this.notes.push(text);
  }

  get empty(): boolean {
    return this.items.length === 0 && this.omitted === 0 && this.notes.length === 0 && !this.recovered;
  }

  build(format: 'DXF' | 'DWG', sourcePath?: string | null): ImportReport {
    return {
      format,
      ...(sourcePath ? { sourcePath } : {}),
      counts: this.counts,
      items: this.items,
      omitted: this.omitted,
      notes: this.notes,
      ...(this.recovered ? { recovered: this.recovered } : {}),
    };
  }
}

/**
 * Report how the drawing's blocks expand (security review E-13): blocks that insert themselves
 * (the repeated reference is not drawn), blocks one reference to which expands to more than
 * MAX_INSERT_EXPANSION objects, and a drawing whose references add up to more than that. These
 * counts retain definitions without allocating expansions; Drawing acceptance enforces the
 * stricter work budgets. The blocks are kept and saved as they are, so the items are `kept`:
 * they are listed, but neither open the report dialog nor ask before saving over the file.
 */
export function reportBlockExpansion(report: ImportReportBuilder, blocks: Readonly<Record<string, BlockDef>>, topLevel: readonly Entity[]): void {
  const r = expansionReport(blocks, topLevel);
  const cap = MAX_INSERT_EXPANSION.toLocaleString('en-US');
  const workCap = MAX_BLOCK_EXPANSION_WORK.toLocaleString('en-US');
  for (const name of r.cyclic) report.add({ type: 'BLOCK', action: 'kept', reason: `block "${name}" inserts itself (directly or through other blocks): the repeated reference is not drawn` });
  for (const name of r.oversized) report.add({ type: 'BLOCK', action: 'kept', reason: `block "${name}" expands to more than ${cap} objects through its nested blocks: its definition is kept, but drawing acceptance rejects references exceeding the ${workCap}-work geometry budget` });
  if (r.total > MAX_INSERT_EXPANSION) report.note(`The block references of this drawing expand to ${r.total > MAX_INSERT_EXPANSION * 999 ? 'billions of' : `about ${r.total.toLocaleString('en-US')}`} objects (more than ${cap}); drawing acceptance enforces the per-reference and whole-drawing geometry budgets before rendering.`);
}

/** Whether a value holds a non-finite number anywhere (deep). Fast path: no allocation. */
function allFinite(v: unknown, depth: number): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (v === null || typeof v !== 'object' || depth > 6) return true;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i += 1) if (!allFinite(v[i], depth + 1)) return false;
    return true;
  }
  const o = v as Record<string, unknown>;
  for (const k in o) if (!allFinite(o[k], depth + 1)) return false;
  return true;
}

/** The first non-finite number in a value (deep), as a path for the message; null when all are finite. */
function nonFinite(v: unknown, path: string, depth = 0): string | null {
  if (depth === 0 && allFinite(v, 0)) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? null : path;
  if (!v || typeof v !== 'object' || depth > 6) return null;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i += 1) {
      const r = nonFinite(v[i], `${path}[${i}]`, depth + 1);
      if (r) return r;
    }
    return null;
  }
  for (const [k, x] of Object.entries(v)) {
    const r = nonFinite(x, path ? `${path}.${k}` : k, depth + 1);
    if (r) return r;
  }
  return null;
}

/**
 * Why an imported object's geometry is invalid (null = valid): coordinates or sizes that are
 * not finite numbers (NaN, Infinity, unreadable text), negative radii, polylines with fewer
 * than 2 vertices. Readers reject such objects and list them in the import report.
 */
export function geometryProblem(e: Entity): string | null {
  const bad = nonFinite(e, '');
  if (bad) return `${bad} is not a finite number`;
  switch (e.type) {
    case 'insert':
      return insertArrayProblem(e);
    case 'circle':
    case 'arc':
      return e.radius < 0 ? `negative radius ${e.radius}` : null;
    case 'polyline':
      return e.points.length < 2 ? `a polyline needs at least 2 vertices (it has ${e.points.length})` : polylineWidthProblem(e);
    case 'text': {
      if (e.height < 0) return `negative text height ${e.height}`;
      const placement = textPlacementProblem(e);
      if (placement) return placement;
      const derived = placedText(e, textWidth);
      return Number.isFinite(derived.height) && Number.isFinite(derived.widthFactor ?? 1) && Number.isFinite(derived.position.x) && Number.isFinite(derived.position.y) ? null : 'TEXT justification produces nonfinite geometry';
    }
    case 'mtext': {
      const background = mtextBackgroundProblem(e);
      if (background) return background;
      if (e.raw) {
        const format = mtextFormattingProblem(e.raw, e.height);
        if (format) return format;
      }
      return e.height < 0 ? `negative text height ${e.height}` : null;
    }
    case 'leader':
      return mtextBackgroundProblem({ background: e.textBackground, height: e.textHeight }) ?? (e.raw ? mtextFormattingProblem(e.raw, e.textHeight ?? 1) ?? null : null);
    case 'table':
      if (!Array.isArray(e.cells)) return 'table cells must be an array';
      for (const row of e.cells) {
        if (!Array.isArray(row)) return 'table cell rows must be arrays';
        for (const cell of row) {
          if (!cell || typeof cell !== 'object' || typeof cell.text !== 'string') return 'table cells must contain text';
          if (cell.raw) {
            if (typeof cell.raw !== 'string') return 'table formatting source must be text';
            const format = mtextFormattingProblem(cell.raw, cell.height ?? e.textHeight);
            if (format) return format;
          }
        }
      }
      return null;
    default:
      return null;
  }
}

export function importReportOf(state: DrawingState): ImportReport | undefined {
  const r = state.meta?.[IMPORT_REPORT_META_KEY] as ImportReport | undefined;
  return r && typeof r === 'object' && Array.isArray(r.items) ? r : undefined;
}

export function rawEntitiesOf(state: DrawingState): readonly RawDxfEntity[] {
  const r = state.meta?.[RAW_ENTITIES_META_KEY];
  return Array.isArray(r) ? (r as RawDxfEntity[]) : [];
}

/** Attach a report (and retained raw records) to a state; an empty report is not stored. */
export function withImportData(state: DrawingState, report: ImportReport | null, raw: readonly RawDxfEntity[] = []): DrawingState {
  const meta: Record<string, unknown> = { ...(state.meta ?? {}) };
  delete meta[IMPORT_REPORT_META_KEY];
  delete meta[RAW_ENTITIES_META_KEY];
  if (report && hasContent(report)) meta[IMPORT_REPORT_META_KEY] = report;
  if (raw.length) meta[RAW_ENTITIES_META_KEY] = raw;
  const { meta: _old, ...rest } = state;
  return Object.keys(meta).length ? { ...rest, meta } : rest;
}

export function hasContent(r: ImportReport): boolean {
  return r.items.length > 0 || r.omitted > 0 || r.notes.length > 0 || !!r.recovered;
}

/** Total over every type for one action. */
export function countOf(r: ImportReport, action: ImportAction): number {
  let n = 0;
  for (const c of Object.values(r.counts)) n += c[action] ?? 0;
  return n;
}

/** Objects that a save cannot write back as they were in the source (dropped or simplified). */
export function lossCount(r: ImportReport): number {
  return countOf(r, 'dropped') + countOf(r, 'simplified');
}

/** One line per type: "3DSOLID: 2 kept (not shown)". */
export function countLines(r: ImportReport): string[] {
  const words: Record<ImportAction, string> = { dropped: 'dropped', simplified: 'simplified', kept: 'kept (not shown, written back on save)', unsupported: 'not supported yet' };
  return Object.entries(r.counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, c]) => `${type}: ${(Object.keys(words) as ImportAction[]).filter((a) => c[a]).map((a) => `${c[a]} ${words[a]}`).join(', ')}`);
}

export function describeItem(i: ImportReportItem): string {
  const where = [i.handle ? `handle ${i.handle}` : '', i.layer !== undefined ? `layer "${i.layer}"` : '', i.where ?? '', i.line ? `line ${i.line}` : ''].filter(Boolean).join(', ');
  return `${i.type} ${i.action}${where ? ` (${where})` : ''}: ${i.reason}`;
}

/** The whole report as plain text (Copy Report). */
export function formatImportReport(r: ImportReport, fileName = r.sourcePath ?? ''): string {
  const out: string[] = [`JCad Electrical ${r.format} import report${fileName ? `: ${fileName}` : ''}`];
  if (r.recovered) out.push(`RECOVERED: ${r.recovered.message}`);
  const loss = lossCount(r);
  const kept = countOf(r, 'kept');
  out.push(`${loss} object(s) dropped or simplified, ${kept} kept without being shown, ${countOf(r, 'unsupported')} property group(s) not supported.`);
  const counts = countLines(r);
  if (counts.length) out.push('', 'By type:', ...counts.map((l) => `  ${l}`));
  if (r.notes.length) out.push('', 'Notes:', ...r.notes.map((n) => `  ${n}`));
  if (r.items.length) out.push('', 'Objects:', ...r.items.map((i) => `  ${describeItem(i)}`));
  if (r.omitted) out.push(`  ... and ${r.omitted} more`);
  return out.join('\n');
}

/**
 * Warning before Save writes over `path`: the drawing was read from that file and the file
 * holds content JCad could not keep, or it was recovered from a damaged file. Null = no warning.
 */
export function saveOverwriteWarning(state: DrawingState, path: string | null): string | null {
  const r = importReportOf(state);
  if (!r || !path || !r.sourcePath || !samePath(r.sourcePath, path)) return null;
  if (r.recovered) return `This drawing was recovered from a damaged file (${r.recovered.message}). Saving over ${baseName(path)} replaces the original with what could be read. Use Save As to keep the original file. Save over it anyway?`;
  const n = lossCount(r);
  if (n === 0) return null;
  return `${baseName(path)} contained ${n} object(s) JCad cannot keep (see the import report). Saving over it removes them from the file. Use Save As to keep the original. Save over it anyway?`;
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}
