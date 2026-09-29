/**
 * Project file (.jcadproj.json): the list of drawings that make up a project,
 * shown in the Project Manager, plus the project description lines used by
 * the title block and project-wide settings (catalog file, tag formats,
 * IEC codes). Paths are stored relative to the project file.
 */
export interface ProjectDrawing {
  file: string;
  description?: string;
  sheet?: string;
  /** Drawing number shown in the title block (DWGNO). */
  dwgno?: string;
  /** Section / sub-section like ACADE's project tree grouping. */
  section?: string;
  /** Revision shown in the title block (REV). */
  rev?: string;
  /** Drawing date for the title block (DATE); empty = today. */
  date?: string;
}

export interface ProjectSettings {
  /** JSON parts catalog that overrides / extends the built-in one (relative to the project file). */
  catalogFile?: string;
  tagFormat?: string;
  wireFormat?: string;
  tagMode?: 'reference' | 'sequential';
  iecProject?: string;
  installation?: string;
  location?: string;
  standard?: 'JIC' | 'IEC';
}

/** Saved report configuration (see src/electrical/report-templates.ts); kept as plain JSON here. */
export interface ProjectReportTemplate {
  name: string;
  /** Report key from REPORTS (bom, components, wires, cables ...). */
  report: string;
  title?: string;
  /** Columns to output, in order (names of the report's columns); empty = all. */
  columns?: string[];
  sort?: Array<{ column: string; desc?: boolean }>;
  filters?: Array<{ column: string; op: 'contains' | 'equals' | 'not' | 'empty' | 'notempty' | 'starts'; value?: string }>;
  output?: 'view' | 'table' | 'csv';
  projectWide?: boolean;
}

export interface Project {
  name: string;
  description?: string;
  /** Project description lines (LINE1 ... ) mapped onto title-block attributes. */
  descriptions?: string[];
  settings?: ProjectSettings;
  drawings: ProjectDrawing[];
  /** Saved report configurations run by AEREPORTRUN. */
  reportTemplates?: ProjectReportTemplate[];
  /**
   * Title block attribute mapping in the AutoCAD Electrical .wdt text format
   * ("ATTRIBUTE = SOURCE" per line, see src/electrical/titleblock-map.ts); empty = built-in mapping.
   */
  titleBlockMap?: string;
  /** Absolute path of the project file (not serialised). */
  path?: string;
}

export const PROJECT_EXT = '.jcadproj.json';

/** Title-block attribute names fed by the project description lines, in order. */
export const DESCRIPTION_LINES = ['PROJECT', 'CUSTOMER', 'JOB', 'DRAWN', 'CHECKED', 'APPROVED', 'LINE7', 'LINE8', 'LINE9', 'LINE10', 'LINE11', 'LINE12'];

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export function parseProject(text: string, path?: string): Project {
  const raw = JSON.parse(text) as Partial<Project> & { settings?: Partial<ProjectSettings> };
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.drawings)) throw new Error('Not a project file');
  const settings: ProjectSettings = {};
  if (raw.settings && typeof raw.settings === 'object') {
    const s = raw.settings as Record<string, unknown>;
    settings.catalogFile = str(s.catalogFile);
    settings.tagFormat = str(s.tagFormat);
    settings.wireFormat = str(s.wireFormat);
    settings.tagMode = s.tagMode === 'sequential' ? 'sequential' : s.tagMode === 'reference' ? 'reference' : undefined;
    settings.iecProject = str(s.iecProject);
    settings.installation = str(s.installation);
    settings.location = str(s.location);
    settings.standard = s.standard === 'IEC' ? 'IEC' : s.standard === 'JIC' ? 'JIC' : undefined;
  }
  return {
    name: typeof raw.name === 'string' ? raw.name : 'Project',
    description: str(raw.description),
    descriptions: Array.isArray(raw.descriptions) ? raw.descriptions.map((d) => (typeof d === 'string' ? d : '')) : undefined,
    settings: Object.values(settings).some((v) => v !== undefined) ? settings : undefined,
    drawings: raw.drawings
      .filter((d): d is ProjectDrawing => !!d && typeof d === 'object' && typeof (d as ProjectDrawing).file === 'string')
      .map((d) => ({ file: d.file, description: str(d.description), sheet: str(d.sheet), dwgno: str(d.dwgno), section: str(d.section), rev: str(d.rev), date: str(d.date) })),
    reportTemplates: Array.isArray(raw.reportTemplates) ? parseReportTemplates(raw.reportTemplates) : undefined,
    titleBlockMap: str(raw.titleBlockMap),
    path,
  };
}

export function serializeProject(p: Project): string {
  const drawings = p.drawings.map((d) => {
    const o: ProjectDrawing = { file: d.file };
    if (d.description) o.description = d.description;
    if (d.sheet) o.sheet = d.sheet;
    if (d.dwgno) o.dwgno = d.dwgno;
    if (d.section) o.section = d.section;
    if (d.rev) o.rev = d.rev;
    if (d.date) o.date = d.date;
    return o;
  });
  const out: Omit<Project, 'path'> = { name: p.name, description: p.description, drawings };
  if (p.descriptions && p.descriptions.some((d) => d)) out.descriptions = p.descriptions;
  if (p.settings && Object.values(p.settings).some((v) => v !== undefined && v !== '')) out.settings = p.settings;
  if (p.reportTemplates && p.reportTemplates.length) out.reportTemplates = p.reportTemplates;
  if (p.titleBlockMap && p.titleBlockMap.trim()) out.titleBlockMap = p.titleBlockMap;
  return JSON.stringify(out, null, 2) + '\n';
}

/** Report templates from untrusted JSON: keep well-formed entries, drop the rest. */
export function parseReportTemplates(raw: unknown[]): ProjectReportTemplate[] {
  const out: ProjectReportTemplate[] = [];
  const strs = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);
  const ops = ['contains', 'equals', 'not', 'empty', 'notempty', 'starts'] as const;
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.name !== 'string' || !o.name.trim() || typeof o.report !== 'string') continue;
    const t: ProjectReportTemplate = { name: o.name.trim(), report: o.report };
    if (typeof o.title === 'string' && o.title) t.title = o.title;
    const cols = strs(o.columns);
    if (cols && cols.length) t.columns = cols;
    if (Array.isArray(o.sort)) {
      const sort = o.sort
        .filter((x): x is { column: string; desc?: unknown } => !!x && typeof x === 'object' && typeof (x as { column?: unknown }).column === 'string')
        .map((x) => (x.desc === true ? { column: x.column, desc: true } : { column: x.column }));
      if (sort.length) t.sort = sort;
    }
    if (Array.isArray(o.filters)) {
      const filters = o.filters
        .filter((x): x is { column: string; op: string; value?: unknown } => !!x && typeof x === 'object' && typeof (x as { column?: unknown }).column === 'string' && (ops as readonly unknown[]).includes((x as { op?: unknown }).op))
        .map((x) => ({ column: x.column, op: x.op as (typeof ops)[number], ...(typeof x.value === 'string' ? { value: x.value } : {}) }));
      if (filters.length) t.filters = filters;
    }
    if (o.output === 'table' || o.output === 'csv' || o.output === 'view') t.output = o.output;
    if (o.projectWide === true) t.projectWide = true;
    out.push(t);
  }
  return out;
}

export function defaultProject(): Project {
  return { name: 'Sample Project', drawings: [] };
}

/** Resolve a drawing (or any project-relative) path against the project file directory. */
export function resolveDrawingPath(project: Project, d: ProjectDrawing): string {
  return resolveProjectPath(project, d.file);
}

export function resolveProjectPath(project: Project, file: string): string {
  if (!project.path || /^([a-zA-Z]:[\\/]|\/)/.test(file)) return file;
  const dir = project.path.replace(/[\\/][^\\/]*$/, '');
  return `${dir}/${file}`;
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Index of the drawing in the project, matched by resolved path or file name. */
export function projectDrawingIndex(project: Project, filePath: string | null): number {
  if (!filePath) return -1;
  return project.drawings.findIndex((d) => resolveDrawingPath(project, d) === filePath || d.file === filePath || baseName(d.file) === baseName(filePath));
}

/**
 * Title-block fields from the project + drawing entry: PROJECT/… from the
 * description lines, TITLE from the drawing description, SHEET as "n OF total".
 */
export function titleBlockFields(project: Project, drawingIndex: number, drawingDescription = '', drawingNumber = ''): Record<string, string> {
  const fields: Record<string, string> = {};
  const lines = project.descriptions ?? [];
  DESCRIPTION_LINES.forEach((tag, i) => {
    const v = lines[i];
    if (v) fields[tag] = v;
  });
  if (!fields.PROJECT) fields.PROJECT = project.name;
  const d = drawingIndex >= 0 ? project.drawings[drawingIndex] : undefined;
  fields.TITLE = d?.description || drawingDescription || project.description || '';
  const total = project.drawings.length;
  const sheet = d?.sheet || (drawingIndex >= 0 ? String(drawingIndex + 1) : '');
  if (sheet) fields.SHEET = total ? `${sheet} OF ${total}` : sheet;
  const dwgno = d?.dwgno || drawingNumber || (d ? baseName(d.file).replace(/\.[^.]+$/, '') : '');
  if (dwgno) fields.DWGNO = dwgno;
  fields.DATE = d?.date || new Date().toISOString().slice(0, 10);
  if (d?.rev) fields.REV = d.rev;
  return fields;
}
