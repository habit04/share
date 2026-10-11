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
import { newDocumentId } from './sessions';

/**
 * Drawing autosaves are "<document id>.sv.dxf"; project autosaves end in this suffix, which the
 * main process's store (electron/autosave-store.cjs PROJECT_SUFFIX) never renames or migrates.
 */
const SUFFIX = '_jcadproj.sv.dxf';

export function projectAutosaveName(p: Pick<Project, 'name' | 'path'>, owner?: string): string {
  const base = p.name.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'Project';
  if (owner) return `${base.slice(0, 8)}_${owner.replace(/-/g, '')}${SUFFIX}`;
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
  readonly projectState?: { generation: number; revision: number };
  on(ev: 'project', fn: () => void): () => void;
}

export class ProjectAutosaver {
  private owner: { generation: number | undefined; id: string; written: string | null; discarded: boolean };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  onError: ((err: unknown) => void) | null = null;

  constructor(
    private host: ProjectHost,
    private store: AutosaveStore,
    private enabled: () => boolean = () => true,
    private delayMs = 1500,
  ) {
    this.owner = { generation: host.projectState?.generation, id: newDocumentId(), written: null, discarded: false };
    host.on('project', () => this.schedule());
  }

  private ownership() {
    const generation = this.host.projectState?.generation;
    if (generation !== this.owner.generation) {
      // Unadopted backups of prior generations remain available for explicit recovery.
      this.owner = { generation, id: newDocumentId(), written: null, discarded: false };
    }
    return this.owner;
  }

  /** Write (or remove) the project autosave shortly after a change. */
  schedule(): void {
    this.ownership().discarded = false;
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
    const owner = this.ownership();
    if (projectDirty && this.enabled() && !owner.discarded) {
      const name = owner.written ?? projectAutosaveName(project, owner.id);
      await this.store.write(name, projectAutosaveText(project), { originalPath: project.path ?? null, title: `Project ${project.name}`, savedAt: Date.now() });
      owner.written = name;
      return;
    }
    if (owner.written) {
      const n = owner.written;
      await this.store.remove(n);
      if (owner.written === n) owner.written = null;
    }
  }

  /**
   * The user discarded the project's changes without opening another project (Discard All or an
   * unticked project when the application closes): remove its autosave instead of writing one, so
   * the next start does not offer what was thrown away on purpose.
   */
  discard(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const owner = this.ownership();
    owner.discarded = true;
    this.chain = this.chain
      .then(async () => {
        const name = owner.written;
        if (name) await this.store.remove(name);
        if (owner.written === name) owner.written = null;
      })
      .catch((err) => this.onError?.(err));
    return this.chain;
  }

  /** Continue writing to (and later remove) the autosave a recovered project came from. */
  adopt(name: string): void {
    this.ownership().written = name;
  }
}

export interface ProjectRecoveryHost {
  projectDirty: boolean;
  readonly projectState?: { generation: number; revision: number };
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
  readFailure?: (name: string, error: unknown) => Promise<'retry' | 'later'>,
): Promise<AutosaveEntry | null> {
  let entries: AutosaveEntry[];
  while (true) {
    try {
      entries = (await store.list()).filter((e) => isProjectAutosave(e.name)).sort((a, b) => b.savedAt - a.savedAt);
      break;
    } catch (err) {
      host.log('Project autosaves could not be listed; recovery copies were kept.');
      if (!readFailure || await readFailure('Project autosaves', err) !== 'retry') return null;
    }
  }
  let recovered: AutosaveEntry | null = null;
  for (const e of entries) {
    let p: Project | null = null;
    while (true) {
      try {
        const text = await store.read(e.name);
        p = text ? parseProjectAutosave(text) : null;
        if (!p) throw new Error('The project recovery copy is missing or unreadable.');
        break;
      } catch (err) {
        host.log(`Project autosave ${e.name} could not be read; its recovery copy was kept.`);
        if (!readFailure || await readFailure(e.title || e.name, err) !== 'retry') break;
      }
    }
    if (!p) continue;
    // Only one project is open at a time: further autosaves wait for the next start.
    if (recovered || host.projectDirty) continue;
    const state = host.projectState;
    const choice = await ask(p.name, p.path ?? null, e.savedAt);
    if (choice === 'discard') {
      await store.remove(e.name);
      continue;
    }
    if (choice === 'later') continue;
    if (host.projectDirty || (state && (host.projectState?.generation !== state.generation || host.projectState?.revision !== state.revision))) {
      host.log(`Project ${p.name} was not recovered because the current project changed while recovery was offered. Its recovery copy is kept.`);
      continue;
    }
    host.replaceProject(p, true);
    autosaver?.adopt(e.name);
    host.log(`Recovered project ${p.name} from autosave. Use PROJECTSAVE to keep the changes; the autosave is kept until then.`);
    recovered = e;
  }
  return recovered;
}
