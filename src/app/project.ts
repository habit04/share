/**
 * Project file (.jacproj.json): the list of drawings that make up a project,
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

export interface Project {
  name: string;
  description?: string;
  /** Project description lines (LINE1 ... ) mapped onto title-block attributes. */
  descriptions?: string[];
  settings?: ProjectSettings;
  drawings: ProjectDrawing[];
  /** Absolute path of the project file (not serialised). */
  path?: string;
}

export const PROJECT_EXT = '.jacproj.json';

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
      .map((d) => ({ file: d.file, description: str(d.description), sheet: str(d.sheet), dwgno: str(d.dwgno), section: str(d.section) })),
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
    return o;
  });
  const out: Omit<Project, 'path'> = { name: p.name, description: p.description, drawings };
  if (p.descriptions && p.descriptions.some((d) => d)) out.descriptions = p.descriptions;
  if (p.settings && Object.values(p.settings).some((v) => v !== undefined && v !== '')) out.settings = p.settings;
  return JSON.stringify(out, null, 2) + '\n';
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
  fields.DATE = new Date().toISOString().slice(0, 10);
  return fields;
}
