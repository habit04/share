/**
 * Project file (.vcproj.json): the list of drawings that make up a project,
 * shown in the Project Manager. Paths are stored relative to the project file.
 */
export interface ProjectDrawing {
  file: string;
  description?: string;
  sheet?: string;
}

export interface Project {
  name: string;
  description?: string;
  drawings: ProjectDrawing[];
  /** Absolute path of the project file (not serialised). */
  path?: string;
}

export const PROJECT_EXT = '.vcproj.json';

export function parseProject(text: string, path?: string): Project {
  const raw = JSON.parse(text) as Partial<Project>;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.drawings)) throw new Error('Not a project file');
  return {
    name: typeof raw.name === 'string' ? raw.name : 'Project',
    description: typeof raw.description === 'string' ? raw.description : undefined,
    drawings: raw.drawings
      .filter((d): d is ProjectDrawing => !!d && typeof d === 'object' && typeof (d as ProjectDrawing).file === 'string')
      .map((d) => ({ file: d.file, description: d.description, sheet: d.sheet })),
    path,
  };
}

export function serializeProject(p: Project): string {
  return JSON.stringify({ name: p.name, description: p.description, drawings: p.drawings }, null, 2) + '\n';
}

export function defaultProject(): Project {
  return { name: 'Sample Project', drawings: [] };
}

/** Resolve a drawing path relative to the project file directory. */
export function resolveDrawingPath(project: Project, d: ProjectDrawing): string {
  if (!project.path || /^([a-zA-Z]:[\\/]|\/)/.test(d.file)) return d.file;
  const dir = project.path.replace(/[\\/][^\\/]*$/, '');
  return `${dir}/${d.file}`;
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
