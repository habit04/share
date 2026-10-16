/**
 * Timer-based autosave of every dirty drawing (DXF text) plus the recovery list shown at
 * startup. The store is the Electron app-data folder (IPC) or localStorage in the browser.
 */
import type { DrawingState } from '../core/document';
import { withoutUnusedLibraryBlocks } from '../electrical/library';
import { sessionTitle } from './sessions';
import { recoveryDxf } from '../model3d/save-guard';
import { partialImportProvenance, restorePartialImportProvenance, cleanPartialImportProvenance, cleanImportSourcePath, type PartialImportProvenance } from '../io/import-provenance';
import { withDwgRecoveryWarning, importReportOf } from '../io/import-report';

export interface AutosaveMeta {
  /** Path of the drawing being edited, or null for an untitled drawing. */
  originalPath: string | null;
  title: string;
  savedAt: number;
  /**
   * Experimental 3D objects the DXF recovery copy does not hold (absent = none). The copy normally
   * holds every solid and dimension; only when they would make a file JCad
   * cannot reopen (DXF_READ_LIMITS) is the copy written without them, and this records how many,
   * so the Drawing Recovery Manager says what is missing. Milestone-1 builds wrote it for every
   * solid (electron/autosave-store.cjs validates it).
   */
  omitted3d?: number;
  /** Bounded diagnostic history only; carries no source path or source-write authority. */
  partialImport?: PartialImportProvenance;
  /** Original import spelling survives Save As. Diagnostic/protection-only, never a grant or proof. */
  partialImportSourcePath?: string;
}
export interface AutosaveEntry extends AutosaveMeta {
  name: string;
}

/** The recovered source binding comes from the entry, never from persisted drawing diagnostics. */
export function restoreAutosaveImportData(state: DrawingState, entry: Pick<AutosaveMeta, 'originalPath' | 'partialImport' | 'partialImportSourcePath'>): DrawingState {
  const source = cleanImportSourcePath(entry.partialImportSourcePath) ?? entry.originalPath;
  return withDwgRecoveryWarning(restorePartialImportProvenance(state, entry.partialImport, source), source);
}

/**
 * What the Drawing Recovery Manager says about 3D objects missing from a backup (its row and the
 * log after Open), or null when the backup holds everything.
 */
export function omitted3dText(meta: Pick<AutosaveMeta, 'omitted3d'>): string | null {
  const n = meta.omitted3d ?? 0;
  if (!(n > 0)) return null;
  return `This backup does not contain ${n === 1 ? '1 3D object' : `${n} 3D objects`}: ${n === 1 ? 'it was' : 'they were'} too large for a recovery file JCad can reopen.`;
}
export interface AutosaveStore {
  write(name: string, text: string, meta: AutosaveMeta): Promise<void>;
  list(): Promise<AutosaveEntry[]>;
  read(name: string): Promise<string | null>;
  remove(name: string): Promise<void>;
}

/**
 * File name of a document's autosave: its permanent id (DocumentSession.docId, a UUID), so a
 * backup is never overwritten by another drawing, in this launch or a later one. The title,
 * path and time live in the store's index (electron/autosave-store.cjs) or the entry itself.
 */
export function autosaveName(docId: string): string {
  const id = docId.toLowerCase().replace(/[^0-9a-z-]+/g, '').slice(0, 50) || 'drawing';
  return `${id}.sv.dxf`;
}

/** Minimal storage shape so the browser store can be unit tested with a Map-backed fake. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

const PREFIX = 'jcad.autosave.';

/** Browser fallback: keeps autosaves in localStorage (small drawings only). */
export function localAutosaveStore(storage: KeyValueStorage): AutosaveStore {
  const keys = () => {
    const out: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const k = storage.key(i);
      if (k && k.startsWith(PREFIX)) out.push(k);
    }
    return out;
  };
  return {
    async write(name, text, meta) {
      // A full or blocked storage must surface as a failure: the autosaver then keeps the
      // drawing marked as not backed up and retries on the next tick.
      storage.setItem(PREFIX + name, JSON.stringify({ meta, text }));
    },
    async list() {
      const out: AutosaveEntry[] = [];
      for (const k of keys()) {
        try {
          const v = JSON.parse(storage.getItem(k) ?? '') as { meta: AutosaveMeta };
          const partialImport = cleanPartialImportProvenance(v.meta.partialImport);
          const { partialImportSourcePath: _storedSource, ...meta } = v.meta;
          const partialImportSourcePath = partialImport ? cleanImportSourcePath(v.meta.partialImportSourcePath) : undefined;
          out.push({ name: k.slice(PREFIX.length), ...meta, ...(partialImport ? { partialImport } : {}), ...(partialImportSourcePath ? { partialImportSourcePath } : {}) });
        } catch {
          /* ignore broken entries */
        }
      }
      return out.sort((a, b) => b.savedAt - a.savedAt);
    },
    async read(name) {
      try {
        const v = JSON.parse(storage.getItem(PREFIX + name) ?? '') as { text: string };
        return typeof v.text === 'string' ? v.text : null;
      } catch {
        return null;
      }
    },
    async remove(name) {
      storage.removeItem(PREFIX + name);
    },
  };
}

export interface AutosaveBridge {
  autosaveWrite(name: string, text: string, meta: AutosaveMeta): Promise<void>;
  autosaveList(): Promise<AutosaveEntry[]>;
  autosaveRead(name: string): Promise<string | null>;
  autosaveRemove(name: string): Promise<void>;
}

export function bridgeAutosaveStore(b: AutosaveBridge): AutosaveStore {
  return { write: (n, t, m) => b.autosaveWrite(n, t, m), list: () => b.autosaveList(), read: (n) => b.autosaveRead(n), remove: (n) => b.autosaveRemove(n) };
}

/** The parts of a document session the autosaver reads (SessionManager.all provides them). */
export interface AutosaveSession {
  readonly id: number;
  readonly docId: string;
  dirty: boolean;
  state: DrawingState;
  filePath: string | null;
  untitledName: string;
}

/**
 * Decide which sessions need an autosave: dirty ones whose current revision (the immutable
 * DrawingState object) is not the one last written.
 */
export function sessionsToAutosave(sessions: ReadonlyArray<{ id: number; dirty: boolean; state: DrawingState }>, lastSaved: ReadonlyMap<number, DrawingState>): number[] {
  return sessions.filter((s) => s.dirty && lastSaved.get(s.id) !== s.state).map((s) => s.id);
}

/**
 * Timer-driven autosave of every modified drawing.
 *
 * Bookkeeping is per document revision, not per clock time: a run captures each drawing's
 * DrawingState before writing, and only that state is recorded as backed up, so edits made while
 * the write is pending stay "not backed up" and go out with the next run. Runs never overlap:
 * a request while one is writing queues exactly one more run. Save, Close and quit wait for the
 * write in flight (flush) before they remove or keep a backup.
 */
export class Autosaver {
  private timer: ReturnType<typeof setInterval> | 0 = 0;
  /** Session id -> the exact revision written to its backup file. */
  private backedUp = new Map<number, DrawingState>();
  /** Session id -> its backup file name (a recovered drawing keeps the file it came from). */
  private names = new Map<number, string>();
  private inflight: Promise<number> | null = null;
  private queued: Promise<number> | null = null;
  /** markSaved / discardFor calls still running (their callers do not wait for them). */
  private pending = new Set<Promise<unknown>>();
  onSaved: ((count: number) => void) | null = null;
  /** Called once per failed write (storage full, disk error); the drawing is retried next tick. */
  onError: ((title: string, err: unknown) => void) | null = null;

  constructor(
    private sessions: { readonly all: readonly AutosaveSession[] },
    private store: AutosaveStore,
    private minutes: () => number,
    /** Sessions that are not drawings (Symbol Builder tabs) are never autosaved. */
    private skip: (sessionId: number) => boolean = () => false,
  ) {}

  start(): void {
    this.stop();
    const m = this.minutes();
    if (!(m > 0)) return;
    this.timer = setInterval(() => void this.runNow(), m * 60_000);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = 0;
  }
  /** Re-read the interval (after Options changed). */
  restart(): void {
    this.start();
  }

  /** True while a run is writing (or one is queued behind it). */
  get busy(): boolean {
    return !!(this.inflight || this.queued);
  }

  /**
   * Write every modified drawing now. When a run is already writing, one more run is queued
   * behind it (further requests share that queued run) and its result is returned.
   */
  runNow(): Promise<number> {
    if (!this.inflight) return this.startRun();
    if (!this.queued) {
      const again = () => {
        this.queued = null;
        return this.startRun();
      };
      this.queued = this.inflight.then(again, again);
    }
    return this.queued;
  }

  /** Wait until no autosave is being written or queued (Save, Close and quit call this). */
  async flush(): Promise<void> {
    while (this.inflight || this.queued) {
      try {
        await (this.queued ?? this.inflight);
      } catch {
        /* runs report their own errors */
      }
    }
  }

  /**
   * Wait until no autosave is being written and every backup removal asked for (markSaved after a
   * save, discardFor after a close) has finished. The close workflow calls this before the window
   * goes away, so a drawing saved just before closing does not leave its backup behind.
   */
  async idle(): Promise<void> {
    await this.flush();
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.pending.add(p);
    const done = () => this.pending.delete(p);
    p.then(done, done);
    return p;
  }

  private startRun(): Promise<number> {
    const run: Promise<number> = this.runOnce().finally(() => {
      if (this.inflight === run) this.inflight = null;
    });
    this.inflight = run;
    return run;
  }

  private async runOnce(): Promise<number> {
    // Capture every revision first: whatever happens during the writes below, the bookkeeping
    // refers to exactly these states.
    const jobs = this.sessions.all
      .filter((s) => s.dirty && this.backedUp.get(s.id) !== s.state && !this.skip(s.id))
      .map((s) => ({ id: s.id, state: s.state, name: this.names.get(s.id) ?? autosaveName(s.docId), title: sessionTitle(s), originalPath: s.filePath, savedAt: Date.now() }));
    let n = 0;
    for (const job of jobs) {
      try {
        // Recovery copies are DXF, which holds the experimental 3D solids (state.model3d) as
        // polyface meshes with JCAD_3D data. An incomplete fallback may create a first backup,
        // but must never replace a previously written or adopted recovery copy.
        const { text, omitted3d } = recoveryDxf(withoutUnusedLibraryBlocks(job.state));
        if (omitted3d > 0 && this.names.has(job.id)) throw new Error(`Recovery was not updated: ${omitted3d} 3D ${omitted3d === 1 ? 'object does' : 'objects do'} not fit the reopenable copy. The previous recovery copy is kept.`);
        const partialImport = partialImportProvenance(job.state);
        const partialImportSourcePath = partialImport ? cleanImportSourcePath(importReportOf(job.state)?.sourcePath) : undefined;
        const meta: AutosaveMeta = { originalPath: job.originalPath, title: job.title, savedAt: job.savedAt, ...(omitted3d > 0 ? { omitted3d } : {}), ...(partialImport ? { partialImport } : {}), ...(partialImportSourcePath ? { partialImportSourcePath } : {}) };
        await this.store.write(job.name, text, meta);
        // Only a complete copy proves this immutable revision is backed up. A first partial
        // copy retains its omission metadata and stays eligible for a complete later revision.
        if (omitted3d === 0) this.backedUp.set(job.id, job.state);
        this.names.set(job.id, job.name);
        n += 1;
      } catch (err) {
        this.onError?.(job.title, err);
      }
    }
    if (n) this.onSaved?.(n);
    return n;
  }

  /**
   * A drawing opened from the Drawing Recovery Manager keeps its backup file until it is
   * saved for real (markSaved / discardFor) - a second crash before then must not lose the work.
   */
  adopt(sessionId: number, name: string): void {
    this.names.set(sessionId, name);
    this.backedUp.delete(sessionId);
  }
  /** Backup file name currently associated with a session, if any. */
  nameFor(sessionId: number): string | undefined {
    return this.names.get(sessionId);
  }
  /** Is this backup file one of this launch's own (a drawing being edited now)? */
  owns(name: string): boolean {
    for (const n of this.names.values()) if (n === name) return true;
    return false;
  }
  /** The revision last written to the session's backup (undefined when none). */
  backedUpState(sessionId: number): DrawingState | undefined {
    return this.backedUp.get(sessionId);
  }

  /**
   * A save of `savedState` completed. Once any autosave in flight has finished, the backup is
   * removed only when the drawing is still exactly that revision and clean; when it was edited
   * meanwhile the backup is kept (and refreshed by the next run), so newer edits are never
   * treated as safe.
   */
  markSaved(sessionId: number, savedState: DrawingState): Promise<'removed' | 'kept' | 'none'> {
    return this.track(this.markSavedNow(sessionId, savedState));
  }

  private async markSavedNow(sessionId: number, savedState: DrawingState): Promise<'removed' | 'kept' | 'none'> {
    await this.flush();
    const s = this.sessions.all.find((x) => x.id === sessionId);
    if (s && (s.dirty || s.state !== savedState)) return 'kept';
    if (!this.names.has(sessionId)) {
      this.backedUp.delete(sessionId);
      return 'none';
    }
    return (await this.discardFor(sessionId)) ? 'removed' : 'kept';
  }

  /**
   * The drawing was closed (changes discarded or saved): its backup is obsolete. Waits for an
   * autosave in flight first, so that write cannot re-create the file afterwards.
   * Resolves false when the file could not be removed (reported through onError).
   */
  discardFor(sessionId: number): Promise<boolean> {
    return this.track(this.discardNow(sessionId));
  }

  private async discardNow(sessionId: number): Promise<boolean> {
    await this.flush();
    const name = this.names.get(sessionId);
    this.backedUp.delete(sessionId);
    this.names.delete(sessionId);
    if (!name) return true;
    try {
      await this.store.remove(name);
      return true;
    } catch (err) {
      this.onError?.(name, err);
      return false;
    }
  }
}
