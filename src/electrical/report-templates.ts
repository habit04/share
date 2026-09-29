/**
 * Report templates (AutoCAD Electrical's saved report formats): a named
 * configuration of one report — columns and their order, sort keys, row
 * filters, title, scope (drawing / project) and the output (show, place as
 * a table, write CSV). Templates are stored in the project file
 * (`Project.reportTemplates`) and run with AEREPORTRUN <name>.
 */
import type { Project, ProjectReportTemplate } from '../app/project';
import { withColumns, type Report } from './reports';

export type ReportTemplate = ProjectReportTemplate;
export type ReportFilter = NonNullable<ReportTemplate['filters']>[number];

export const FILTER_OPS: Array<{ op: ReportFilter['op']; label: string }> = [
  { op: 'contains', label: 'contains' },
  { op: 'equals', label: 'equals' },
  { op: 'starts', label: 'starts with' },
  { op: 'not', label: 'does not contain' },
  { op: 'empty', label: 'is empty' },
  { op: 'notempty', label: 'is not empty' },
];

const col = (r: Report, name: string) => r.columns.findIndex((c) => c.toLowerCase() === name.trim().toLowerCase());

/** Whether a cell passes a filter (case-insensitive). */
export function matchesFilter(cell: string, f: ReportFilter): boolean {
  const v = cell.toLowerCase();
  const q = (f.value ?? '').toLowerCase();
  switch (f.op) {
    case 'contains':
      return v.includes(q);
    case 'equals':
      return v === q;
    case 'starts':
      return v.startsWith(q);
    case 'not':
      return !v.includes(q);
    case 'empty':
      return v.trim() === '';
    case 'notempty':
      return v.trim() !== '';
    default:
      return true;
  }
}

/**
 * Apply a template to a built report: filters (all must match; filters on
 * columns the report lacks are ignored), then the sort keys (numeric-aware,
 * stable), then the column selection / order, then the title.
 */
export function applyTemplate(r: Report, t: Pick<ReportTemplate, 'columns' | 'sort' | 'filters' | 'title'>): Report {
  let rows = r.rows;
  for (const f of t.filters ?? []) {
    const i = col(r, f.column);
    if (i < 0) continue;
    rows = rows.filter((row) => matchesFilter(row[i] ?? '', f));
  }
  const keys = (t.sort ?? []).map((s) => ({ i: col(r, s.column), desc: !!s.desc })).filter((k) => k.i >= 0);
  if (keys.length) {
    rows = rows
      .map((row, n) => ({ row, n }))
      .sort((a, b) => {
        for (const k of keys) {
          const c = (a.row[k.i] ?? '').localeCompare(b.row[k.i] ?? '', undefined, { numeric: true });
          if (c) return k.desc ? -c : c;
        }
        return a.n - b.n;
      })
      .map((x) => x.row);
  }
  const out = withColumns({ ...r, rows }, t.columns);
  return t.title ? { ...out, title: t.title } : out;
}

/** Template names are case-insensitive keys. */
export function findTemplate(project: Pick<Project, 'reportTemplates'>, name: string): ReportTemplate | undefined {
  const n = name.trim().toLowerCase();
  return project.reportTemplates?.find((t) => t.name.toLowerCase() === n);
}

/** Project with a template added or replaced (same name). */
export function upsertTemplate<P extends Pick<Project, 'reportTemplates'>>(project: P, t: ReportTemplate): P {
  const list = (project.reportTemplates ?? []).filter((x) => x.name.toLowerCase() !== t.name.trim().toLowerCase());
  return { ...project, reportTemplates: [...list, { ...t, name: t.name.trim() }].sort((a, b) => a.name.localeCompare(b.name)) };
}

/** Project without the named template. */
export function removeTemplate<P extends Pick<Project, 'reportTemplates'>>(project: P, name: string): P {
  const list = (project.reportTemplates ?? []).filter((x) => x.name.toLowerCase() !== name.trim().toLowerCase());
  return { ...project, reportTemplates: list.length ? list : undefined };
}

/** One-line description of a template for lists. */
export function describeTemplate(t: ReportTemplate): string {
  const parts = [t.report];
  if (t.columns?.length) parts.push(`${t.columns.length} column(s)`);
  if (t.sort?.length) parts.push(`sort ${t.sort.map((s) => `${s.column}${s.desc ? ' desc' : ''}`).join(', ')}`);
  if (t.filters?.length) parts.push(`${t.filters.length} filter(s)`);
  parts.push(t.projectWide ? 'project' : 'drawing');
  parts.push(t.output === 'table' ? 'table on drawing' : t.output === 'csv' ? 'CSV' : 'view');
  return parts.join(' · ');
}
