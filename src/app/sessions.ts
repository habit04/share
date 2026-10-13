/**
 * Multiple open drawings ("file tabs").
 *
 * The Editor keeps exactly one active `Drawing`; a DocumentSession stores the
 * state of every other open document (snapshot, undo/redo history, file path,
 * dirty flag, view and selection) so switching tabs swaps that state in and out.
 * Pure of DOM so it can be unit tested with a fake host.
 */
import { Drawing, type DrawingState } from '../core/document';
import type { Point } from '../core/geometry';
import { fileBaseName, samePath, shortNames } from './paths';
import { prepareDrawingState, validateGeometryBudget } from '../core/geometry-budget';

/** Per-document views parked behind Model/paper/viewport context switches, independent of CAD data. */
export interface ParkedSpaceViews {
  readonly views: readonly (readonly [string, { readonly center: Point; readonly scale: number; readonly twist?: number }])[];
  readonly histories: readonly (readonly [string, readonly { readonly center: Point; readonly scale: number; readonly twist: number }[]])[];
  readonly lastLayout: string;
}

export interface DocumentSession {
  readonly id: number;
  /** Changes when this document changes; restoring a parked tab alone keeps it stable. */
  revision: number;
  /** Changes when a load replaces this tab's contents, independently of edits and tab switches. */
  contentGeneration: number;
  /**
   * Permanent unique id of this open document (a UUID, generated once). Unlike `id`, which
   * restarts at 1 every launch, it never repeats, so its autosave file can never overwrite an
   * unrecovered backup from an earlier session (src/app/autosave.ts).
   */
  readonly docId: string;
  state: DrawingState;
  filePath: string | null;
  dirty: boolean;
  undo: DrawingState[];
  redo: DrawingState[];
  /** null until the document has been shown once (then the host's zoom-extents view is kept). */
  view: { center: Point; scale: number; twist?: number } | null;
  parkedSpaceViews: ParkedSpaceViews | null;
  selection: Set<string>;
  /** Name shown for drawings without a file (Drawing1.dxf, Drawing2.dxf ...). */
  untitledName: string;
}

export interface SessionHost {
  readonly doc: Drawing;
  readonly viewport: { center: Point; scale: number; twist?: number };
  selection: Set<string>;
  /** Replace the active document (the Editor's loadState: load, ensure library blocks, zoom extents). */
  loadState(state: DrawingState, path: string | null): void;
  notify?(ev: 'file' | 'selection' | 'view'): void;
  render?(): void;
  captureParkedSpaceViews?(): ParkedSpaceViews;
  restoreParkedSpaceViews?(views: ParkedSpaceViews | null): void;
}


/** A random RFC 4122 version 4 UUID (crypto.randomUUID where available). */
export function newDocumentId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i += 1) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function sessionTitle(s: Pick<DocumentSession, 'filePath' | 'untitledName'>): string {
  if (!s.filePath) return s.untitledName;
  return fileBaseName(s.filePath) || s.untitledName;
}

export class SessionManager {
  private list: DocumentSession[] = [];
  private activeIndex = 0;
  private nextId = 1;
  private untitledCounter = 0;
  private observedDocumentRevision = 0;
  private observedDocumentLoadCount = 0;
  /** Fired after the active document changed (tab switch, add, close). */
  onChange: (() => void) | null = null;

  constructor(private host: SessionHost) {
    this.list = [this.make(host.doc.snapshot, host.doc.filePath)];
    this.observedDocumentRevision = host.doc.revision;
    this.observedDocumentLoadCount = host.doc.loadCount;
  }

  private make(state: DrawingState, filePath: string | null): DocumentSession {
    prepareDrawingState(state);
    this.untitledCounter += 1;
    return {
      id: this.nextId++,
      revision: 0,
      contentGeneration: 0,
      docId: newDocumentId(),
      state,
      filePath,
      dirty: false,
      undo: [],
      redo: [],
      view: null,
      parkedSpaceViews: null,
      selection: new Set(),
      untitledName: `Drawing${this.untitledCounter}.dxf`,
    };
  }

  /** All sessions; the active entry is synchronised with the live document first. */
  get all(): readonly DocumentSession[] {
    this.sync();
    return this.list;
  }
  get active(): number {
    return this.activeIndex;
  }
  /** Id of the active session, without synchronising (safe inside 'file' listeners during a switch). */
  get activeId(): number {
    return this.list[this.activeIndex]!.id;
  }
  get count(): number {
    return this.list.length;
  }
  get current(): DocumentSession {
    this.sync();
    return this.list[this.activeIndex]!;
  }
  /** Untitled name of the active drawing (Editor.fileName falls back to this). */
  get untitledName(): string {
    return this.list[this.activeIndex]?.untitledName ?? 'Drawing1.dxf';
  }

  /**
   * Tab title: the file name, plus the parent folder when another open tab has a file with
   * the same name in a different folder ("a.dxf (line1)" / "a.dxf (line2)").
   */
  titleOf(i: number): string {
    const s = i === this.activeIndex ? this.current : this.list[i];
    if (!s) return '';
    const name = sessionTitle(s);
    if (!s.filePath || !this.list.some((x) => x !== s && x.filePath && !samePath(x.filePath, s.filePath) && sessionTitle(x).toLowerCase() === name.toLowerCase())) return name;
    return shortNames(this.list.map((x) => x.filePath), this.list.map((x) => x.untitledName))[i] ?? name;
  }

  /** Index of the session with this id (-1 when it was closed). */
  indexOfId(id: number): number {
    return this.list.findIndex((s) => s.id === id);
  }

  /** Capture the live document into the active session record. */
  sync(): void {
    // While a session is being loaded into the editor the live document is half restored (just
    // loaded: clean, no undo history); capturing it then would wipe the session's dirty flag.
    if (this.restoring) return;
    const s = this.list[this.activeIndex];
    if (!s) return;
    const { doc, viewport } = this.host;
    if (doc.loadCount !== this.observedDocumentLoadCount) {
      s.contentGeneration += 1;
      this.observedDocumentLoadCount = doc.loadCount;
    }
    if (doc.revision !== this.observedDocumentRevision) {
      s.revision += 1;
      this.observedDocumentRevision = doc.revision;
    }
    const h = doc.history();
    s.state = doc.snapshot;
    s.filePath = doc.filePath;
    s.dirty = doc.dirty;
    s.undo = [...h.undo];
    s.redo = [...h.redo];
    if (viewport) s.view = { center: { ...viewport.center }, scale: viewport.scale, ...(viewport.twist ? { twist: viewport.twist } : {}) };
    s.parkedSpaceViews = this.host.captureParkedSpaceViews?.() ?? null;
    s.selection = new Set(this.host.selection);
  }

  private restoring = false;

  private restore(s: DocumentSession): void {
    const { host } = this;
    this.restoring = true;
    try {
      host.loadState(s.state, s.filePath);
    } finally {
      this.observedDocumentRevision = host.doc.revision;
      this.observedDocumentLoadCount = host.doc.loadCount;
      this.restoring = false;
    }
    host.doc.restoreHistory({ undo: s.undo, redo: s.redo });
    host.doc.dirty = s.dirty;
    if (s.view && host.viewport) {
      host.viewport.center = { ...s.view.center };
      host.viewport.scale = s.view.scale;
      if ('twist' in host.viewport) host.viewport.twist = s.view.twist ?? 0;
    }
    host.selection = new Set(s.selection);
    host.restoreParkedSpaceViews?.(s.parkedSpaceViews);
    host.notify?.('file');
    host.notify?.('selection');
    host.notify?.('view');
    host.render?.();
    this.onChange?.();
  }

  switchTo(i: number): boolean {
    if (i < 0 || i >= this.list.length || i === this.activeIndex) return false;
    validateGeometryBudget(this.list[i]!.state);
    this.sync();
    this.activeIndex = i;
    this.restore(this.list[i]!);
    return true;
  }

  /** Ctrl+Tab style cycling. */
  cycle(dir: 1 | -1): void {
    const n = this.list.length;
    if (n < 2) return;
    this.switchTo((this.activeIndex + dir + n) % n);
  }

  /** Open a new tab (blank drawing by default) and make it active. Returns its index. */
  add(state?: DrawingState, filePath: string | null = null, dirty = false): number {
    this.sync();
    const s = this.make(state ?? new Drawing().snapshot, filePath);
    s.dirty = dirty;
    this.list.push(s);
    this.activeIndex = this.list.length - 1;
    this.restore(s);
    return this.activeIndex;
  }

  /** Open a new tab without switching to it (an open that finished while the user works in another tab). Returns its index. */
  addInBackground(state: DrawingState, filePath: string | null = null, dirty = false): number {
    this.sync();
    const s = this.make(state, filePath);
    s.dirty = dirty;
    this.list.push(s);
    this.onChange?.();
    return this.list.length - 1;
  }

  /** Close tab `i` (the caller has already confirmed discarding changes). */
  close(i: number, next?: number): void {
    if (i < 0 || i >= this.list.length) return;
    if (i !== this.activeIndex) this.sync();
    const remaining = this.list.filter((_session, index) => index !== i);
    let target = next ?? (i < this.activeIndex ? this.activeIndex - 1 : i === this.activeIndex ? i : this.activeIndex);
    if (next !== undefined && next > i) target = next - 1;
    target = Math.max(0, Math.min(remaining.length - 1, target));
    const restores = i === this.activeIndex || target !== (i < this.activeIndex ? this.activeIndex - 1 : this.activeIndex);
    // A rejected target must leave the outgoing tab and active index untouched.
    if (remaining.length && restores) validateGeometryBudget(remaining[target]!.state);
    this.list.splice(i, 1);
    if (this.list.length === 0) {
      // AutoCAD shows an empty application; we keep one blank drawing so the UI always has a document.
      this.untitledCounter = 0;
      this.list.push(this.make(new Drawing().snapshot, null));
      this.activeIndex = 0;
      this.restore(this.list[0]!);
      return;
    }
    if (restores) {
      this.activeIndex = target;
      this.restore(this.list[target]!);
    } else {
      this.activeIndex = target;
      this.onChange?.();
    }
  }

  isDirty(i: number): boolean {
    return i === this.activeIndex ? this.host.doc.dirty : (this.list[i]?.dirty ?? false);
  }

  anyDirty(): boolean {
    this.sync();
    return this.list.some((s) => s.dirty);
  }

  /** Tab showing this file (normalised full-path comparison, case-insensitive for Windows paths). */
  indexOfPath(path: string): number {
    this.sync();
    return this.list.findIndex((s) => samePath(s.filePath, path));
  }

  /**
   * Put a freshly opened document into session `id` without activating it (an open that
   * finished after the user switched to another tab). Returns false when the tab is gone.
   */
  loadInto(id: number, state: DrawingState, filePath: string | null, dirty = false): boolean {
    const i = this.indexOfId(id);
    if (i < 0) return false;
    prepareDrawingState(state);
    if (i === this.activeIndex) {
      this.host.loadState(state, filePath);
      this.host.doc.dirty = dirty;
      return true;
    }
    const s = this.list[i]!;
    s.revision += 1;
    s.contentGeneration += 1;
    s.state = state;
    s.filePath = filePath;
    s.dirty = dirty;
    s.undo = [];
    s.redo = [];
    s.view = null;
    s.parkedSpaceViews = null;
    s.selection = new Set();
    this.onChange?.();
    return true;
  }

  /** A blank, untouched drawing (reused instead of opening a new tab, like AutoCAD's Drawing1). */
  isPristine(i: number): boolean {
    const s = i === this.activeIndex ? this.current : this.list[i];
    return !!s && !s.filePath && !s.dirty && s.state.entities.length === 0 && s.undo.length === 0;
  }

  /**
   * Open a file in its own tab: reuse the pristine current tab, switch to an already-open
   * tab, otherwise add a new tab and run `open` in it; a cancelled dialog closes the tab again.
   */
  async openInTab(file: string | undefined, open: (file?: string) => Promise<unknown>): Promise<void> {
    if (file) {
      const k = this.indexOfPath(file);
      if (k >= 0) {
        this.switchTo(k);
        return;
      }
    }
    const fromId = this.current.id;
    const reuse = this.isPristine(this.activeIndex);
    const idx = reuse ? this.activeIndex : this.add();
    const id = this.list[idx]!.id;
    await open(file);
    // Tabs may have been switched, opened or closed while the file was loading: find ours by id.
    const now = this.indexOfId(id);
    if (!reuse && now >= 0 && this.isPristine(now)) {
      const back = this.indexOfId(fromId);
      this.close(now, now === this.activeIndex && back >= 0 ? back : undefined);
    }
  }
}

/**
 * Record the outcome of a completed save. The save serialised `savedState` of session
 * `sessionId`; only that revision is marked clean, so edits made while the file was
 * being written (or in another tab) keep their "unsaved changes" flag.
 * Returns what happened for the command log.
 */
export function applySaveResult(sessions: SessionManager, host: SessionHost, sessionId: number, savedState: DrawingState, path: string, contentGeneration: number): 'clean' | 'newer-edits' | 'closed' | 'replaced' {
  const active = sessions.current;
  if (active.id === sessionId) {
    if (active.contentGeneration !== contentGeneration) return 'replaced';
    host.doc.filePath = path;
    if (host.doc.snapshot === savedState) {
      host.doc.dirty = false;
      return 'clean';
    }
    return 'newer-edits';
  }
  const s = sessions.all.find((x) => x.id === sessionId);
  if (!s) return 'closed';
  if (s.contentGeneration !== contentGeneration) return 'replaced';
  s.filePath = path;
  if (s.state === savedState) {
    s.dirty = false;
    return 'clean';
  }
  return 'newer-edits';
}
