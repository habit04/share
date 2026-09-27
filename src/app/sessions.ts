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

export interface DocumentSession {
  readonly id: number;
  state: DrawingState;
  filePath: string | null;
  dirty: boolean;
  undo: DrawingState[];
  redo: DrawingState[];
  /** null until the document has been shown once (then the host's zoom-extents view is kept). */
  view: { center: Point; scale: number } | null;
  selection: Set<string>;
  /** Name shown for drawings without a file (Drawing1.dxf, Drawing2.dxf ...). */
  untitledName: string;
}

export interface SessionHost {
  readonly doc: Drawing;
  readonly viewport: { center: Point; scale: number };
  selection: Set<string>;
  /** Replace the active document (the Editor's loadState: load, ensure library blocks, zoom extents). */
  loadState(state: DrawingState, path: string | null): void;
  notify?(ev: 'file' | 'selection' | 'view'): void;
  render?(): void;
}

/** Undo history lives in private fields of Drawing; read/write them defensively so core stays untouched. */
interface HistoryAccess {
  undoStack?: DrawingState[];
  redoStack?: DrawingState[];
}
const historyOf = (doc: Drawing): HistoryAccess => doc as unknown as HistoryAccess;

export function sessionTitle(s: Pick<DocumentSession, 'filePath' | 'untitledName'>): string {
  if (!s.filePath) return s.untitledName;
  return s.filePath.split(/[\\/]/).pop() || s.untitledName;
}

export class SessionManager {
  private list: DocumentSession[] = [];
  private activeIndex = 0;
  private nextId = 1;
  private untitledCounter = 0;
  /** Fired after the active document changed (tab switch, add, close). */
  onChange: (() => void) | null = null;

  constructor(private host: SessionHost) {
    this.list = [this.make(host.doc.snapshot, host.doc.filePath)];
  }

  private make(state: DrawingState, filePath: string | null): DocumentSession {
    this.untitledCounter += 1;
    return {
      id: this.nextId++,
      state,
      filePath,
      dirty: false,
      undo: [],
      redo: [],
      view: null,
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

  titleOf(i: number): string {
    const s = i === this.activeIndex ? this.current : this.list[i];
    return s ? sessionTitle(s) : '';
  }

  /** Capture the live document into the active session record. */
  sync(): void {
    const s = this.list[this.activeIndex];
    if (!s) return;
    const { doc, viewport } = this.host;
    const h = historyOf(doc);
    s.state = doc.snapshot;
    s.filePath = doc.filePath;
    s.dirty = doc.dirty;
    s.undo = [...(h.undoStack ?? [])];
    s.redo = [...(h.redoStack ?? [])];
    if (viewport) s.view = { center: { ...viewport.center }, scale: viewport.scale };
    s.selection = new Set(this.host.selection);
  }

  private restore(s: DocumentSession): void {
    const { host } = this;
    host.loadState(s.state, s.filePath);
    const h = historyOf(host.doc);
    h.undoStack = [...s.undo];
    h.redoStack = [...s.redo];
    host.doc.dirty = s.dirty;
    if (s.view && host.viewport) {
      host.viewport.center = { ...s.view.center };
      host.viewport.scale = s.view.scale;
    }
    host.selection = new Set(s.selection);
    host.notify?.('file');
    host.notify?.('selection');
    host.notify?.('view');
    host.render?.();
    this.onChange?.();
  }

  switchTo(i: number): boolean {
    if (i < 0 || i >= this.list.length || i === this.activeIndex) return false;
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

  /** Close tab `i` (the caller has already confirmed discarding changes). */
  close(i: number, next?: number): void {
    if (i < 0 || i >= this.list.length) return;
    if (i !== this.activeIndex) this.sync();
    this.list.splice(i, 1);
    if (this.list.length === 0) {
      // AutoCAD shows an empty application; we keep one blank drawing so the UI always has a document.
      this.untitledCounter = 0;
      this.list.push(this.make(new Drawing().snapshot, null));
      this.activeIndex = 0;
      this.restore(this.list[0]!);
      return;
    }
    let target = next ?? (i < this.activeIndex ? this.activeIndex - 1 : i === this.activeIndex ? i : this.activeIndex);
    if (next !== undefined && next > i) target = next - 1;
    target = Math.max(0, Math.min(this.list.length - 1, target));
    if (i === this.activeIndex || target !== (i < this.activeIndex ? this.activeIndex - 1 : this.activeIndex)) {
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

  indexOfPath(path: string): number {
    this.sync();
    return this.list.findIndex((s) => s.filePath === path);
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
  async openInTab(file: string | undefined, open: (file?: string) => Promise<void>): Promise<void> {
    if (file) {
      const k = this.indexOfPath(file);
      if (k >= 0) {
        this.switchTo(k);
        return;
      }
    }
    const from = this.activeIndex;
    const reuse = this.isPristine(from);
    const idx = reuse ? from : this.add();
    await open(file);
    if (!reuse && this.isPristine(idx)) this.close(idx, from);
  }
}
