/** Bounded report payload. Source spelling is separate metadata; neither carries grants or proofs. */
import type { DrawingState } from '../core/document';
import { importReportOf, isPartialImport, withImportData, rawEntitiesOf, fontSubstitutionCount, MAX_REPORT_ITEMS, type ImportAction, type ImportReport, type ImportReportItem } from './import-report';

const ACTIONS: readonly ImportAction[] = ['dropped', 'simplified', 'kept', 'unsupported'];
export const AUTOSAVE_IMPORT_LIMITS = { items: 64, types: 128, notes: 16, text: 512, name: 128 } as const;
interface SourceCount { readonly type: string; readonly dropped: number; readonly simplified: number; readonly kept: number; readonly unsupported: number }
export interface PartialImportProvenance {
  readonly version: 1;
  readonly format: 'DXF' | 'DWG';
  readonly counts: readonly SourceCount[];
  readonly items: readonly ImportReportItem[];
  readonly omitted: number;
  readonly notes: readonly string[];
  readonly recovered?: { readonly line: number; readonly message: string };
  readonly fontSubstitutions?: number;
}
/** Diagnostic spelling only. Native lookups still require the host's existing authorization. */
export function cleanImportSourcePath(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
}
const add = (a: number, b: number): number => Math.min(Number.MAX_SAFE_INTEGER, a + b);
const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const text = (s: unknown, max: number): s is string => typeof s === 'string' && s.length <= max;
const fallback = (): PartialImportProvenance => ({ version: 1, format: 'DXF', counts: [{ type: 'IMPORT_SOURCE', dropped: 1, simplified: 0, kept: 0, unsupported: 0 }], items: [], omitted: 1, notes: ['The recovered copy came with incomplete import diagnostics. Its source remains protected; use Save As to a separate file.'] });

/** Invalid supplied provenance stays conservatively partial; absent older metadata stays absent. */
export function cleanPartialImportProvenance(value: unknown): PartialImportProvenance | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') return fallback();
  const v = value as PartialImportProvenance;
  if (v.version !== 1 || !['DXF', 'DWG'].includes(v.format) || !Array.isArray(v.counts) || v.counts.length > AUTOSAVE_IMPORT_LIMITS.types
    || !Array.isArray(v.items) || v.items.length > AUTOSAVE_IMPORT_LIMITS.items || !Array.isArray(v.notes) || v.notes.length > AUTOSAVE_IMPORT_LIMITS.notes || !count(v.omitted)
    || v.fontSubstitutions !== undefined && !count(v.fontSubstitutions)) return fallback();
  const counts: SourceCount[] = [];
  for (const entry of v.counts) {
    if (!entry || !text(entry.type, AUTOSAVE_IMPORT_LIMITS.name) || ACTIONS.some(action => !count(entry[action]))) return fallback();
    counts.push({ type: entry.type, dropped: entry.dropped, simplified: entry.simplified, kept: entry.kept, unsupported: entry.unsupported });
  }
  const items: ImportReportItem[] = [];
  for (const item of v.items) {
    if (!item || !text(item.type, AUTOSAVE_IMPORT_LIMITS.name) || !ACTIONS.includes(item.action) || !text(item.reason, AUTOSAVE_IMPORT_LIMITS.text)
      || item.handle !== undefined && !text(item.handle, AUTOSAVE_IMPORT_LIMITS.name) || item.layer !== undefined && !text(item.layer, AUTOSAVE_IMPORT_LIMITS.name)
      || item.where !== undefined && !text(item.where, AUTOSAVE_IMPORT_LIMITS.text) || item.line !== undefined && !count(item.line)) return fallback();
    items.push({ type: item.type, action: item.action, reason: item.reason, ...(item.handle !== undefined ? { handle: item.handle } : {}), ...(item.layer !== undefined ? { layer: item.layer } : {}), ...(item.where !== undefined ? { where: item.where } : {}), ...(item.line !== undefined ? { line: item.line } : {}) });
  }
  if (v.notes.some(note => !text(note, AUTOSAVE_IMPORT_LIMITS.text)) || v.recovered !== undefined && (!v.recovered || !count(v.recovered.line) || !text(v.recovered.message, AUTOSAVE_IMPORT_LIMITS.text))) return fallback();
  if (!v.recovered && !counts.some(entry => entry.dropped || entry.simplified)) return fallback();
  return { version: 1, format: v.format, counts, items, omitted: v.omitted, notes: [...v.notes], ...(v.recovered ? { recovered: { line: v.recovered.line, message: v.recovered.message } } : {}), ...(v.fontSubstitutions !== undefined ? { fontSubstitutions: v.fontSubstitutions } : {}) };
}

/** Preserve aggregate losses even when detailed items and diagnostic text must be capped. */
export function partialImportProvenance(state: DrawingState): PartialImportProvenance | undefined {
  const report = importReportOf(state);
  if (!report || !isPartialImport(state)) return undefined;
  const clip = (s: string, max: number = AUTOSAVE_IMPORT_LIMITS.text) => s.slice(0, max);
  const counts: SourceCount[] = [];
  const overflow = { type: 'OTHER_SOURCE_RECORDS', dropped: 0, simplified: 0, kept: 0, unsupported: 0 };
  for (const [type, values] of Object.entries(report.counts)) {
    const entry = { type: clip(type, AUTOSAVE_IMPORT_LIMITS.name), dropped: values.dropped ?? 0, simplified: values.simplified ?? 0, kept: values.kept ?? 0, unsupported: values.unsupported ?? 0 };
    if (counts.length < AUTOSAVE_IMPORT_LIMITS.types - 1) counts.push(entry);
    else for (const action of ACTIONS) overflow[action] = add(overflow[action], entry[action]);
  }
  if (ACTIONS.some(action => overflow[action])) counts.push(overflow);
  const items = report.items.slice(0, AUTOSAVE_IMPORT_LIMITS.items).map(item => ({ type: clip(item.type, AUTOSAVE_IMPORT_LIMITS.name), action: item.action, reason: clip(item.reason), ...(item.handle !== undefined ? { handle: clip(item.handle, AUTOSAVE_IMPORT_LIMITS.name) } : {}), ...(item.layer !== undefined ? { layer: clip(item.layer, AUTOSAVE_IMPORT_LIMITS.name) } : {}), ...(item.where !== undefined ? { where: clip(item.where) } : {}), ...(item.line !== undefined ? { line: item.line } : {}) }));
  return cleanPartialImportProvenance({ version: 1, format: report.format, counts, items, omitted: add(report.omitted, report.items.length - items.length), notes: report.notes.slice(0, AUTOSAVE_IMPORT_LIMITS.notes).map(note => clip(note)), fontSubstitutions: fontSubstitutionCount(report), ...(report.recovered ? { recovered: { line: report.recovered.line, message: clip(report.recovered.message) } } : {}) });
}

/** The source spelling comes from bounded recovery metadata; it never grants filesystem access. */
export function restorePartialImportProvenance(state: DrawingState, value: unknown, originalPath: string | null): DrawingState {
  const source = cleanPartialImportProvenance(value);
  if (!source) return state;
  const fresh = importReportOf(state);
  const counts: Record<string, Partial<Record<ImportAction, number>>> = Object.create(null);
  for (const entry of source.counts) {
    const target = counts[entry.type] ??= {};
    for (const action of ACTIONS) if (entry[action]) target[action] = add(target[action] ?? 0, entry[action]);
  }
  for (const [type, values] of Object.entries(fresh?.counts ?? {})) {
    const target = counts[type] ??= {};
    for (const action of ACTIONS) if (values[action]) target[action] = add(target[action] ?? 0, values[action]!);
  }
  const allItems = [...source.items, ...(fresh?.items ?? [])];
  // Re-reading the same retained styles can repeat their fallback diagnostics at each
  // crash. Keep the uncapped source aggregate without counting those imports twice.
  const fonts = Math.max(source.fontSubstitutions ?? source.items.filter(item => item.type === 'STYLE' && /substitut|fallback/i.test(item.reason)).length, fresh ? fontSubstitutionCount(fresh) : 0);
  const report: ImportReport = { format: source.format, ...(originalPath ? { sourcePath: originalPath } : {}), counts, items: allItems.slice(0, MAX_REPORT_ITEMS), omitted: add(add(source.omitted, fresh?.omitted ?? 0), Math.max(0, allItems.length - MAX_REPORT_ITEMS)), notes: [...new Set([...source.notes, ...(fresh?.notes ?? [])])], fontSubstitutions: fonts, ...(source.recovered ?? fresh?.recovered ? { recovered: source.recovered ?? fresh!.recovered } : {}) };
  return withImportData(state, report, rawEntitiesOf(state));
}
