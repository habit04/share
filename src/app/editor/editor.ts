/**
 * The Editor: the drawing being edited and its tabs, tools and the command line, selection, view,
 * files and the project. The class holds the state and the public members; each responsibility
 * lives in a module next to it, which its methods delegate to (module map: docs/DEVELOPMENT.md):
 *
 *   types.ts       events, command definitions, the file bridge, the UI hooks
 *   internals.ts   the private working state those modules share, the fallback UI
 *   commands.ts    the built-in commands
 *   prompter.ts    tools, the tool context, the command line and Enter
 *   selection.ts   LIST, picking into the selection or a selection request
 *   pointer.ts     mouse input: snapped cursor, picking, selection boxes, grips, pan, wheel zoom
 *   keyboard.ts    keys
 *   view.ts        settings, drafting toggles, zoom extents
 *   documents.ts   new / open, tabs, import reports, the Save / Don't Save / Cancel question
 *   save.ts        drawing saves through the save queue
 *   project.ts     the project and its file
 *   plotting.ts    PLOT / PRINT
 */
import type { Point } from '../../core/geometry';
import type { Entity } from '../../core/entities';
import { Drawing } from '../../core/document';
import type { DrawingState } from '../../core/document';
import { defaultSnapSettings, type SnapSettings } from '../../core/snap';
import { Viewport, type ViewportOverlay } from '../../render/viewport';
import type { Tool, ToolContext } from '../../tools/types';
import { WIRE_DOT } from '../../electrical/symbols';
import { LIBRARY_SYMBOLS } from '../../electrical/library';
import { TITLE_BLOCK } from '../../electrical/templates';
import { SOURCE_ARROW, DEST_ARROW } from '../../tools/plc';
import { defaultProject, type Project } from '../project';
import { saveQueue } from '../savequeue';
import { loadSettings, type UserSettings } from '../settings';
import { SessionManager } from '../sessions';
import type { ColorSpec } from '../../core/entities';
import type { PlotOptions } from '../plot';
import type { SpaceRef } from '../../core/layouts';
import type { EditorEvent, CommandDef, FileBridge, EditorHooks } from './types';
import { createInternals, type EditorInternals } from './internals';
import { registerBuiltinCommands } from './commands';
import * as prompter from './prompter';
import * as view from './view';
import * as select from './selection';
import * as pointer from './pointer';
import * as keyboard from './keyboard';
import * as documents from './documents';
import * as save from './save';
import * as projects from './project';
import * as plotting from './plotting';

/** Version compiled in from package.json (see vite.config.ts); 'dev' under plain vitest. */
const VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

export class Editor {
  readonly doc = new Drawing();
  // ---- UI/workflow extensions (file tabs, Properties panel) — logic lives in app/sessions.ts / src/ui.
  /** Open drawings ("file tabs"); the active one is `doc`. */
  readonly sessions: SessionManager = new SessionManager(this);
  /** Current colour for new objects (Home > Properties panel; applied by Drawing.addEntities). Linetype / lineweight live in the drawing header (CELTYPE / CELWEIGHT). */
  get currentColor(): ColorSpec {
    return this.doc.currentColor;
  }
  set currentColor(c: ColorSpec) {
    this.doc.currentColor = c;
  }
  readonly viewport: Viewport;
  readonly snap: SnapSettings = defaultSnapSettings();
  selection = new Set<string>();
  tool: Tool | null = null;
  toolName = '';
  lastCommand = '';
  /** Full command line (with arguments) for Enter-to-repeat. */
  lastCommandLine = '';
  lastPoint: Point | null = null;
  history: string[] = [];
  prompt = 'Type a command';
  readonly commands = new Map<string, CommandDef>();
  private overlay: ViewportOverlay = {
    preview: [],
    ghost: [],
    selection: this.selection,
    hover: null,
    selectionBox: null,
    snap: null,
    cursor: null,
    trackFrom: null,
    dynText: [],
    cursorMode: 'idle',
  };
  private listeners: Record<EditorEvent, Set<() => void>> = {
    change: new Set(),
    selection: new Set(),
    tool: new Set(),
    view: new Set(),
    snap: new Set(),
    file: new Set(),
    log: new Set(),
    space: new Set(),
    project: new Set(),
  };
  /** The private working state the editor's modules share (internals.ts). */
  private readonly internals: EditorInternals = createInternals(this.overlay);
  ui: ToolContext['ui'] | null = null;
  fileBridge: FileBridge | null = null;
  /** Extra UI hooks provided by main.ts. */
  hooks: EditorHooks = {};
  settings: UserSettings = loadSettings();
  project: Project = defaultProject();
  /**
   * The project data (properties, drawing list, catalog, report templates, title-block map)
   * has changes that are not in the project file yet. Separate from the drawings' dirty flags.
   */
  projectDirty = false;
  /** Message of the last failed save / open (for the close workflow's error report). */
  lastFileError: string | null = null;
  /**
   * More than 0 while a plugin starts a command through the plugin API (`jcad.commands.run`): a
   * project that command opens is opened by name, not chosen by the user (no write access to its
   * drawings outside the project folder).
   */
  apiCommandDepth = 0;
  /** Layer new wires go on (AEWIRETYPE). */
  wireLayer = 'WIRES';
  /** File name to suggest in Save As (set by DWG import). */
  suggestedName: string | null = null;
  /** Mouse hooks of the layout controller (tools/layouts.ts): viewport activation by (double-)click. */
  layoutInput: { doubleClick?(screen: Point): boolean; mouseDown?(screen: Point): boolean; hoverBlocked?(screen: Point): boolean } = {};
  /** Active space ('space' event): undefined = Model tab, else the layout and the MSPACE viewport. */
  get activeSpace(): SpaceRef | undefined {
    return this.doc.space;
  }

  constructor(canvas: HTMLCanvasElement) {
    this.viewport = new Viewport(canvas, this.doc);
    this.doc.ensureBlocks([...LIBRARY_SYMBOLS, WIRE_DOT, TITLE_BLOCK, SOURCE_ARROW, DEST_ARROW]);
    this.applySettings();
    this.doc.subscribe(() => {
      // Drop selection ids that no longer exist.
      const ids = new Set(this.doc.entities.map((e) => e.id));
      let changed = false;
      for (const id of this.selection) if (!ids.has(id)) {
        this.selection.delete(id);
        changed = true;
      }
      if (changed) this.emit('selection');
      this.emit('change');
      this.render();
    });
    registerBuiltinCommands(this);
    saveQueue.log = (t) => this.log(t);
    this.log(`JCad Electrical ${VERSION} — type a command (LINE, AEWIRE, AELADDER, AECOMPONENT ...) or HELP.`);
  }

  // ------------------------------------------------------------- events
  on(ev: EditorEvent, fn: () => void): () => void {
    this.listeners[ev].add(fn);
    return () => this.listeners[ev].delete(fn);
  }
  private emit(ev: EditorEvent): void {
    for (const fn of this.listeners[ev]) fn();
  }
  /** Public event dispatch for UI-layer modules (sessions, palettes). */
  notify(ev: EditorEvent): void {
    this.emit(ev);
  }
  /** Activate an open drawing tab (see `sessions`). */
  switchSession(i: number): boolean {
    return this.sessions.switchTo(i);
  }

  log(text: string): void {
    this.history.push(text);
    if (this.history.length > 500) this.history.shift();
    this.emit('log');
  }

  setPrompt(text: string): void {
    this.prompt = text;
    this.emit('tool');
  }

  render(): void {
    this.overlay.selection = this.selection;
    this.viewport.requestRender(this.overlay);
  }

  /** Highlight an object the way the cursor's rollover does (null: none), e.g. for the palette row under the cursor. */
  setHover(id: string | null): void {
    if (this.overlay.hover === id) return;
    this.overlay.hover = id;
    this.render();
  }

  resize(): void {
    this.viewport.resize();
    this.render();
    this.emit('view');
  }

  // ------------------------------------------------------------- tool context
  startTool(tool: Tool): void {
    prompter.startTool(this, this.internals, tool);
  }

  finishTool(): void {
    prompter.finishTool(this, this.internals);
  }

  cancel(): void {
    prompter.cancel(this, this.internals);
  }

  applySettings(): void {
    view.applySettings(this);
  }

  persistSettings(): void {
    view.persistSettings(this);
  }

  /** Whether typed input should be treated as literal text (TEXT command content). */
  acceptsFreeText(): boolean {
    return prompter.acceptsFreeText(this);
  }

  // ------------------------------------------------------------- commands
  register(def: CommandDef): void {
    this.commands.set(def.name.toUpperCase(), def);
    for (const a of def.aliases) this.commands.set(a.toUpperCase(), def);
  }

  /** Hook for keywords typed at a "Select objects:" prompt (ALL / Last / Previous); returns true when handled. */
  selectionKeyword: ((text: string, ids: Set<string>) => boolean) | null = null;

  layerDialogRequested: (() => void) | null = null;

  runCommand(input: string): void {
    prompter.runCommand(this, input);
  }

  /** Handle text typed at the command line. */
  submitInput(raw: string): void {
    prompter.submitInput(this, this.internals, raw);
  }

  pressEnter(): void {
    prompter.pressEnter(this, this.internals);
  }

  /** Parse absolute "x,y", relative "@dx,dy" and polar "@d<a" input. */
  parsePoint(text: string): Point | null {
    return prompter.parsePoint(this, text);
  }

  dynamicInput = true;

  toggle(name: 'grid' | 'gridSnap' | 'ortho' | 'polar' | 'osnap' | 'otrack' | 'lw' | 'dyn'): void {
    view.toggle(this, name);
  }

  zoomExtents(): void {
    view.zoomExtents(this);
  }

  listSelection(): void {
    select.listSelection(this);
  }

  // ------------------------------------------------------------- files
  newDrawing(): void {
    documents.newDrawing(this);
  }

  newDrawingNow(): void {
    documents.newDrawingNow(this);
  }

  loadState(state: DrawingState, path: string | null): void {
    documents.loadState(this, state, path);
  }

  /**
   * Open a drawing into the tab that started the open. When the user switched tabs while the
   * file was loading, the drawing still lands in that tab (in the background); when that tab
   * was closed or edited meanwhile, it opens in a new tab instead of replacing anything.
   */
  openFile(file?: string): Promise<boolean> {
    return documents.openFile(this, file);
  }

  /**
   * Log the drawing's import report and, when content was lost (or `force`, IMPORTREPORT), show
   * the report dialog. `state` / `name` default to the active drawing.
   */
  showImportReport(force: boolean, state: DrawingState = this.doc.snapshot, name: string = this.fileName()): void {
    documents.showImportReport(this, force, state, name);
  }

  /**
   * Read DXF text the way OPEN does (see import-open.ts readDxfForOpen): a file that ends early
   * asks whether to open what was readable (marked as recovered); null = declined.
   */
  readDxfText(text: string, path: string | null): Promise<DrawingState | null> {
    return documents.readDxfText(this, text, path);
  }

  /**
   * Save the active drawing. Writes to the same file are queued in order, and a save whose
   * snapshot is older than one already written to that file is dropped (see savequeue.ts).
   * Resolves true when the file was written.
   */
  saveFile(saveAs: boolean): Promise<boolean> {
    return save.saveFile(this, this.internals, saveAs);
  }

  confirmDiscardPublic(): Promise<boolean> {
    return documents.confirmDiscard(this);
  }

  /** Generation (another project opened / created) and revision (any change) of the project data. */
  get projectState(): { generation: number; revision: number } {
    return projects.projectState(this.internals);
  }

  /** Apply a user change to the project data: it becomes modified (PROJECTSAVE writes it). */
  updateProject(next: Project): void {
    projects.updateProject(this, this.internals, next);
  }

  /** Make `p` the current project (opened, created or recovered). */
  replaceProject(p: Project, dirty = false): void {
    projects.replaceProject(this, this.internals, p, dirty);
  }

  /** Save / Don't Save / Cancel for the project's own unsaved changes; resolves true when it may be replaced. */
  confirmDiscardProject(): Promise<boolean> {
    return projects.confirmDiscardProject(this);
  }

  /**
   * OPENPROJECT: the Open Project dialog, or the project file `file` by name. `userChosen`: the user
   * picked `file` (Recent Documents, an OS hand-over), not a plugin or a typed path.
   */
  openProject(file?: string, opts: { userChosen?: boolean } = {}): Promise<boolean> {
    return projects.openProject(this, this.internals, file, opts);
  }

  /** NEWPROJECT: an empty, untitled project (after Save / Don't Save / Cancel for the current one). */
  newProjectCommand(name?: string): Promise<boolean> {
    return projects.newProjectCommand(this, this.internals, name);
  }

  addCurrentToProject(): void {
    projects.addCurrentToProject(this);
  }

  /**
   * PROJECTSAVE / PROJECTSAVEAS. Saving into another folder recalculates the relative drawing
   * and catalog paths so they still name the same files. The result is applied to the project
   * that started the save (not to one opened meanwhile); edits made during the save stay unsaved.
   * Resolves true when the file was written.
   */
  saveProject(saveAs = false): Promise<boolean> {
    return projects.saveProject(this, this.internals, saveAs);
  }

  /** Open a drawing that belongs to the project (by index or path). */
  openProjectDrawing(index: number): void {
    projects.openProjectDrawing(this, index);
  }

  /** Render the drawing extents to a white sheet and hand it to the main process as PDF. */
  /**
   * Render the drawing extents onto the chosen paper (white sheet, black lines, hidden
   * layers left out) for plotting / printing. The image has exactly the sheet's proportions.
   */
  renderPlotImage(opts: PlotOptions): Promise<{ dataUrl: string; landscape: boolean; sheet: { width: number; height: number }; electron?: string; reducedToFit: boolean } | null> {
    return plotting.renderPlotImage(this, opts);
  }

  /** PLOT: open the Plot / Print dialog (default: PDF) and run the chosen output. */
  plot(): Promise<void> {
    return plotting.plot(this);
  }

  /** PRINT: open the Plot / Print dialog (default: printer) and run the chosen output. */
  print(): Promise<void> {
    return plotting.print(this);
  }

  fileName(): string {
    return documents.fileName(this);
  }

  // ------------------------------------------------------------- mouse
  screenFromEvent(ev: MouseEvent): Point {
    return pointer.screenFromEvent(this, ev);
  }

  onMouseMove(ev: MouseEvent): void {
    pointer.onMouseMove(this, this.internals, ev);
  }

  onMouseDown(ev: MouseEvent): void {
    pointer.onMouseDown(this, this.internals, ev);
  }

  onMouseUp(ev: MouseEvent): void {
    pointer.onMouseUp(this, this.internals, ev);
  }

  onDoubleClick(ev: MouseEvent): void {
    pointer.onDoubleClick(this, ev);
  }

  onWheel(ev: WheelEvent): void {
    pointer.onWheel(this, this.internals, ev);
  }

  onMouseLeave(): void {
    pointer.onMouseLeave(this, this.internals);
  }

  onContextMenu(ev: MouseEvent): void {
    pointer.onContextMenu(ev);
  }

  // ------------------------------------------------------------- keyboard
  onKeyDown(ev: KeyboardEvent): boolean {
    return keyboard.onKeyDown(this, this.internals, ev);
  }

  /** Current mouse position in world coordinates for the status bar. */
  cursorPosition(): Point | null {
    return this.internals.cursorWorld;
  }

  entitiesSelected(): Entity[] {
    return select.entitiesSelected(this);
  }
}
