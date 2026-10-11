/**
 * Recovery for the project's own unsaved changes (properties, drawing list, catalog, report
 * templates, title-block map). While the project is modified, its JSON is kept in the autosave
 * store next to the drawing autosaves (same store, public functions only) under a name that
 * drawing autosaves never use; it is removed once the project is saved or the changes are
 * discarded. At startup an autosaved project is offered for recovery.
 */
import type { AutosaveEntry, AutosaveStore } from './autosave';
import { parseProject, serializeProject, type Project } from './project';
import { contentHash } from './savequeue';

/** Drawing autosaves end in "_<session id>.sv.dxf"; project autosaves in this suffix. */
const SUFFIX = '_jcadproj.sv.dxf';

export function projectAutosaveName(p: Pick<Project, 'name' | 'path'>): string {
  const base = p.name.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'Project';
  const tag = contentHash(p.path ?? `untitled:${p.name}`).replace(/[^0-9a-f]/g, '').slice(0, 8);
  return `${base}_${tag}${SUFFIX}`;
}

export function isProjectAutosave(name: string): boolean {
  return name.endsWith(SUFFIX);
}

/** The store as the Drawing Recovery Manager should see it: drawing autosaves only. */
export function drawingAutosaves(store: AutosaveStore): AutosaveStore {
  return { ...store, list: async () => (await store.list()).filter((e) => !isProjectAutosave(e.name)) };
}

interface Payload {
  kind: 'jcad-project-autosave';
  path: string | null;
  text: string;
}

export function projectAutosaveText(p: Project): string {
  const payload: Payload = { kind: 'jcad-project-autosave', path: p.path ?? null, text: serializeProject(p) };
  return JSON.stringify(payload);
}

/** The project saved in an autosave text (with its original path), or null when unreadable. */
export function parseProjectAutosave(text: string): Project | null {
  try {
    const v = JSON.parse(text) as Partial<Payload>;
    if (!v || v.kind !== 'jcad-project-autosave' || typeof v.text !== 'string') return null;
    return parseProject(v.text, typeof v.path === 'string' ? v.path : undefined);
  } catch {
    return null;
  }
}

interface ProjectHost {
  project: Project;
  projectDirty: boolean;
  on(ev: 'project', fn: () => void): () => void;
}

export class ProjectAutosaver {
  private written: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  onError: ((err: unknown) => void) | null = null;

  constructor(
    private host: ProjectHost,
    private store: AutosaveStore,
    private enabled: () => boolean = () => true,
    private delayMs = 1500,
  ) {
    host.on('project', () => this.schedule());
  }

  /** Write (or remove) the project autosave shortly after a change. */
  schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
  }

  /** Bring the store in line with the project now: autosave while modified, nothing once saved / discarded. */
  flush(): Promise<void> {
    this.chain = this.chain.then(() => this.sync()).catch((err) => this.onError?.(err));
    return this.chain;
  }

  private async sync(): Promise<void> {
    const { project, projectDirty } = this.host;
    if (projectDirty && this.enabled()) {
      const name = projectAutosaveName(project);
      await this.store.write(name, projectAutosaveText(project), { originalPath: project.path ?? null, title: `Project ${project.name}`, savedAt: Date.now() });
      if (this.written && this.written !== name) await this.store.remove(this.written);
      this.written = name;
      return;
    }
    if (this.written) {
      const n = this.written;
      this.written = null;
      await this.store.remove(n);
    }
  }

  /** Continue writing to (and later remove) the autosave a recovered project came from. */
  adopt(name: string): void {
    this.written = name;
  }
}

export interface ProjectRecoveryHost {
  projectDirty: boolean;
  replaceProject(p: Project, dirty?: boolean): void;
  log(text: string): void;
}

/**
 * Offer the autosaved project(s) at startup. `ask` is the Project Recovery dialog; 'later' keeps
 * the autosave for the next start. Resolves the recovered project's entry, if any.
 */
export async function offerProjectRecovery(
  host: ProjectRecoveryHost,
  store: AutosaveStore,
  ask: (name: string, path: string | null, savedAt: number) => Promise<'open' | 'discard' | 'later'>,
  autosaver?: Pick<ProjectAutosaver, 'adopt'>,
): Promise<AutosaveEntry | null> {
  const entries = (await store.list()).filter((e) => isProjectAutosave(e.name)).sort((a, b) => b.savedAt - a.savedAt);
  let recovered: AutosaveEntry | null = null;
  for (const e of entries) {
    const text = await store.read(e.name);
    const p = text ? parseProjectAutosave(text) : null;
    if (!p) {
      host.log(`Project autosave ${e.name} could not be read.`);
      continue;
    }
    // Only one project is open at a time: further autosaves wait for the next start.
    if (recovered || host.projectDirty) continue;
    const choice = await ask(p.name, p.path ?? null, e.savedAt);
    if (choice === 'discard') {
      await store.remove(e.name);
      continue;
    }
    if (choice === 'later') continue;
    host.replaceProject(p, true);
    autosaver?.adopt(e.name);
    host.log(`Recovered project ${p.name} from autosave. Use PROJECTSAVE to keep the changes; the autosave is kept until then.`);
    recovered = e;
  }
  return recovered;
}
