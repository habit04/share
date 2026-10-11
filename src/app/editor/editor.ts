/**
 * The Editor: the drawing being edited and its tabs, tools and the command line, selection, view,
 * files and the project. The class holds the state and the public members; each responsibility
 * lives in a module next to it, which its methods delegate to (module map: docs/DEVELOPMENT.md):
 *
 *   types.ts       events, command definitions, the file bridge, the UI hooks
 *   internals.ts   the private working state those modules share, the fallback UI
 *   commands.ts    the built-in commands
 *   view.ts        settings, drafting toggles, zoom extents
 *   documents.ts   new / open, tabs, import reports, the Save / Don't Save / Cancel question
 *   save.ts        drawing saves through the save queue
 *   plotting.ts    PLOT / PRINT
 */
import type { Point } from '../../core/geometry';
import * as g from '../../core/geometry';
import type { Entity } from '../../core/entities';
import { Drawing } from '../../core/document';
import type { DrawingState } from '../../core/document';
import { defaultSnapSettings, findObjectSnap, constrainDirection, snapToGrid, type SnapResult, type SnapSettings } from '../../core/snap';
import { pickEntity, selectByBox } from '../../core/selection';
import { Viewport, type ViewportOverlay } from '../../render/viewport';
import type { Tool, ToolContext } from '../../tools/types';
import { PanTool } from '../../tools/edit';
import { WIRE_DOT } from '../../electrical/symbols';
import { LIBRARY_SYMBOLS } from '../../electrical/library';
import { TITLE_BLOCK } from '../../electrical/templates';
import { SOURCE_ARROW, DEST_ARROW } from '../../tools/plc';
import { gripPoints, moveGrip } from '../../core/entities';
import { parseProject, serializeProject, defaultProject, resolveDrawingPath, baseName, projectDrawingIndex, projectEntryFor, rebaseProject, type Project } from '../project';
import { captureRevision, saveQueue } from '../savequeue';
import { loadSettings, type UserSettings } from '../settings';
import { SessionManager } from '../sessions';
import { describeFileError } from '../file-errors';
import type { ColorSpec } from '../../core/entities';
import type { PlotOptions } from '../plot';
import { parsePointInput, isPlainNumber } from '../input';
import { trackFromPoints } from '../../core/snap';
import type { SpaceRef } from '../../core/layouts';
import type { EditorEvent, CommandDef, FileBridge, EditorHooks } from './types';
import { createInternals, fallbackUi, type EditorInternals } from './internals';
import { registerBuiltinCommands } from './commands';
import * as view from './view';
import * as documents from './documents';
import * as save from './save';
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

  resize(): void {
    this.viewport.resize();
    this.render();
    this.emit('view');
  }

  // ------------------------------------------------------------- tool context
  private makeContext(): ToolContext {
    const ed = this;
    return {
      doc: ed.doc,
      snap: ed.snap,
      get selection() {
        return ed.selection;
      },
      set selection(v: Set<string>) {
        ed.selection = v;
        ed.emit('selection');
        ed.render();
      },
      aperture: () => (ed.viewport.settings.pickBox + 2) * ed.viewport.worldPerPixel(),
      prompt: (t) => ed.setPrompt(t),
      log: (t) => ed.log(t),
      setPreview: (e) => {
        ed.overlay.preview = e;
        ed.render();
      },
      setGhost: (e) => {
        ed.overlay.ghost = e;
        ed.render();
      },
      setTrackFrom: (p) => {
        ed.overlay.trackFrom = p;
        if (p) ed.lastPoint = p;
        ed.render();
      },
      setDynText: (lines) => {
        ed.overlay.dynText = ed.dynamicInput ? lines : [];
        ed.render();
      },
      finish: () => ed.finishTool(),
      runCommand: (name) => ed.runCommand(name),
      ui: ed.ui ?? fallbackUi,
      requestSelection: (prompt, onDone) => {
        ed.internals.selReq = { prompt, onDone, ids: new Set() };
        ed.updateCursorMode();
        ed.setPrompt(prompt);
      },
    };
  }

  startTool(tool: Tool): void {
    if (this.tool) this.tool.onCancel(this.makeContext());
    this.clearOverlay();
    this.tool = tool;
    this.toolName = tool.name;
    this.lastCommand = tool.name;
    tool.start(this.makeContext());
    this.updateCursorMode();
    this.emit('tool');
    this.render();
  }

  finishTool(): void {
    this.tool = null;
    this.toolName = '';
    this.internals.selReq = null;
    this.clearOverlay();
    this.updateCursorMode();
    this.setPrompt('Type a command');
    this.emit('tool');
    this.render();
  }

  cancel(): void {
    if (this.internals.gripDrag) {
      this.internals.gripDrag = null;
      this.overlay.ghost = [];
      this.overlay.trackFrom = null;
      this.updateCursorMode();
      this.setPrompt('Type a command');
      this.render();
      return;
    }
    if (this.tool) {
      this.log('*Cancel*');
      this.tool.onCancel(this.makeContext());
      this.finishTool();
      return;
    }
    if (this.internals.selReq) {
      this.internals.selReq = null;
      this.finishTool();
      return;
    }
    if (this.selection.size > 0) {
      this.selection.clear();
      this.emit('selection');
      this.render();
    }
  }

  private clearOverlay(): void {
    this.overlay.preview = [];
    this.overlay.ghost = [];
    this.overlay.trackFrom = null;
    this.overlay.acquired = undefined;
    this.overlay.trackPaths = undefined;
    this.internals.acquired = [];
    this.overlay.dynText = [];
    this.overlay.selectionBox = null;
    this.overlay.hover = null;
    this.internals.dragStart = null;
    this.internals.dragWorld = null;
  }

  applySettings(): void {
    view.applySettings(this);
  }

  persistSettings(): void {
    view.persistSettings(this);
  }

  /** Whether typed input should be treated as literal text (TEXT command content). */
  acceptsFreeText(): boolean {
    return this.tool?.acceptsFreeText?.() ?? false;
  }

  private updateCursorMode(): void {
    this.overlay.cursorMode = this.internals.selReq ? 'select' : this.tool ? 'point' : 'idle';
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
    const text = input.trim();
    if (!text) return;
    const [name, ...rest] = text.split(/\s+/);
    const def = this.commands.get(name!.toUpperCase());
    if (!def) {
      this.log(`Unknown command "${name}". Press F1 for help.`);
      return;
    }
    if (this.tool) this.cancel();
    this.lastCommand = def.name;
    this.lastCommandLine = text;
    if (!def.startsTool) this.log(`Command: ${def.name}`);
    def.run(this, rest.join(' ') || undefined);
    this.emit('tool');
  }

  /** Handle text typed at the command line. */
  submitInput(raw: string): void {
    const text = raw.trim();
    if (text.length === 0) {
      this.pressEnter();
      return;
    }
    this.log(`${this.prompt} ${text}`);
    if (this.internals.selReq) {
      const handled = this.selectionKeyword ? this.selectionKeyword(text, this.internals.selReq.ids) : false;
      if (handled || text.toUpperCase() === 'ALL') {
        if (!handled) for (const e of this.doc.entities) this.internals.selReq.ids.add(e.id);
        this.selection = new Set(this.internals.selReq.ids);
        this.emit('selection');
        this.render();
        this.log(`${this.internals.selReq.ids.size} found`);
      } else this.log('Expects a point or Window/Last/Crossing/BOX/ALL/Fence/WPolygon/CPolygon/Add/Remove/Previous/Undo');
      return;
    }
    if (this.tool) {
      if (this.acceptsFreeText()) {
        this.tool.onText(raw, this.makeContext());
        return;
      }
      const p = this.parsePoint(text);
      if (p) {
        this.acceptPoint(p);
        return;
      }
      const num = parseFloat(text);
      if (this.tool.acceptsDistance && isPlainNumber(text) && Number.isFinite(num) && this.overlay.trackFrom && this.internals.cursorWorld) {
        // direct distance entry along the cursor direction
        const dir = constrainDirection(this.overlay.trackFrom, this.internals.cursorWorld, this.snap);
        const ang = g.angleOf(this.overlay.trackFrom, dir);
        this.acceptPoint(g.polar(this.overlay.trackFrom, ang, num));
        return;
      }
      this.tool.onText(text, this.makeContext());
      return;
    }
    this.runCommand(text);
  }

  pressEnter(): void {
    if (this.internals.selReq) {
      const req = this.internals.selReq;
      this.internals.selReq = null;
      this.updateCursorMode();
      const ids = [...req.ids];
      this.setPrompt('');
      req.onDone(ids);
      return;
    }
    if (this.tool) {
      this.tool.onEnter(this.makeContext());
      return;
    }
    if (this.lastCommandLine) this.runCommand(this.lastCommandLine);
  }

  /** Parse absolute "x,y", relative "@dx,dy" and polar "@d<a" input. */
  parsePoint(text: string): Point | null {
    return parsePointInput(text, this.lastPoint ?? { x: 0, y: 0 });
  }

  private acceptPoint(p: Point): void {
    this.lastPoint = p;
    this.internals.acquired = [];
    this.overlay.acquired = undefined;
    this.overlay.trackPaths = undefined;
    this.tool?.onPoint(p, this.makeContext());
    this.emit('tool');
  }

  dynamicInput = true;

  toggle(name: 'grid' | 'gridSnap' | 'ortho' | 'polar' | 'osnap' | 'otrack' | 'lw' | 'dyn'): void {
    view.toggle(this, name);
  }

  zoomExtents(): void {
    view.zoomExtents(this);
  }

  listSelection(): void {
    if (this.selection.size === 0) {
      this.log('Nothing selected.');
      return;
    }
    for (const e of this.doc.entities) {
      if (!this.selection.has(e.id)) continue;
      switch (e.type) {
        case 'line':
          this.log(`  LINE  Layer: "${e.layer}"  from (${e.a.x.toFixed(4)}, ${e.a.y.toFixed(4)}) to (${e.b.x.toFixed(4)}, ${e.b.y.toFixed(4)})  Length: ${g.dist(e.a, e.b).toFixed(4)}`);
          break;
        case 'circle':
          this.log(`  CIRCLE  Layer: "${e.layer}"  center (${e.center.x.toFixed(4)}, ${e.center.y.toFixed(4)})  radius ${e.radius.toFixed(4)}`);
          break;
        case 'arc':
          this.log(`  ARC  Layer: "${e.layer}"  center (${e.center.x.toFixed(4)}, ${e.center.y.toFixed(4)})  radius ${e.radius.toFixed(4)}`);
          break;
        case 'polyline':
          this.log(`  LWPOLYLINE  Layer: "${e.layer}"  ${e.points.length} vertices${e.closed ? ' (closed)' : ''}`);
          break;
        case 'text':
          this.log(`  TEXT  Layer: "${e.layer}"  "${e.text}"  height ${e.height}`);
          break;
        case 'insert':
          this.log(`  INSERT  Layer: "${e.layer}"  block "${e.block}"  ${Object.entries(e.attributes).map(([k, v]) => `${k}="${v}"`).join(' ')}`);
          break;
      }
    }
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
    return { generation: this.internals.projectGen, revision: this.internals.projectRev };
  }

  /** Apply a user change to the project data: it becomes modified (PROJECTSAVE writes it). */
  updateProject(next: Project): void {
    this.project = next;
    this.internals.projectRev += 1;
    this.projectDirty = true;
    this.hooks.projectChanged?.();
    this.emit('project');
  }

  /** Make `p` the current project (opened, created or recovered). */
  replaceProject(p: Project, dirty = false): void {
    this.project = p;
    this.internals.projectGen += 1;
    this.internals.projectRev += 1;
    this.projectDirty = dirty;
    this.hooks.projectChanged?.();
    this.emit('project');
  }

  /** Save / Don't Save / Cancel for the project's own unsaved changes; resolves true when it may be replaced. */
  async confirmDiscardProject(): Promise<boolean> {
    if (!this.projectDirty) return true;
    const ui = this.ui ?? fallbackUi;
    const label = `project ${this.project.name}`;
    if (ui.saveChanges) {
      const r = await ui.saveChanges(label);
      if (r === 'cancel') return false;
      if (r === 'save') return (await this.saveProject()) && !this.projectDirty;
      return true;
    }
    return ui.confirm('Unsaved project changes', `The ${label} has unsaved changes. Discard them?`);
  }

  /**
   * OPENPROJECT: the Open Project dialog, or the project file `file` by name. `userChosen`: the user
   * picked `file` (Recent Documents, an OS hand-over), not a plugin or a typed path.
   */
  async openProject(file?: string, opts: { userChosen?: boolean } = {}): Promise<boolean> {
    if (!this.fileBridge?.openProject) {
      this.log('Projects need the desktop app.');
      return false;
    }
    if (!(await this.confirmDiscardProject())) return false;
    const answered = this.internals.projectRev;
    try {
      const res = await this.fileBridge.openProject(file, file && opts.userChosen ? { userChosen: true } : undefined);
      if (!res) return false;
      // Changes made to the project while the Open dialog was up get their own question.
      if (this.projectDirty && this.internals.projectRev !== answered && !(await this.confirmDiscardProject())) return false;
      this.replaceProject(parseProject(res.text, res.path));
      this.log(`Project ${this.project.name}: ${this.project.drawings.length} drawing(s).`);
      documents.rememberRecent(this, res.path);
      this.emit('file');
      return true;
    } catch (err) {
      this.lastFileError = documents.openErrorText(err, file);
      this.log(`Failed to open project: ${this.lastFileError}`);
      return false;
    }
  }

  /** NEWPROJECT: an empty, untitled project (after Save / Don't Save / Cancel for the current one). */
  async newProjectCommand(name?: string): Promise<boolean> {
    if (!(await this.confirmDiscardProject())) return false;
    const answered = this.internals.projectRev;
    let n = name?.trim();
    if (!n) {
      const typed = await (this.ui ?? fallbackUi).textInput('New Project', 'Project name:', 'Project1');
      if (typed === null) return false;
      n = typed.trim() || 'Project1';
    }
    // The project may have been changed again while the name was asked for.
    if (this.projectDirty && this.internals.projectRev !== answered && !(await this.confirmDiscardProject())) return false;
    this.replaceProject({ name: n, drawings: [] });
    this.log(`New project ${n}. Add drawings with PROJECTADD and write the project file with PROJECTSAVE.`);
    this.emit('file');
    return true;
  }

  addCurrentToProject(): void {
    if (!this.doc.filePath) {
      this.log('Save the drawing first, then add it to the project.');
      return;
    }
    if (projectDrawingIndex(this.project, this.doc.filePath) >= 0) {
      this.log('Drawing is already in the project.');
      return;
    }
    const file = projectEntryFor(this.project, this.doc.filePath);
    this.updateProject({ ...this.project, drawings: [...this.project.drawings, { file }] });
    this.log(`Added ${baseName(file)} to project ${this.project.name}. Use PROJECTSAVE to write the project file.`);
    this.emit('file');
  }

  /**
   * PROJECTSAVE / PROJECTSAVEAS. Saving into another folder recalculates the relative drawing
   * and catalog paths so they still name the same files. The result is applied to the project
   * that started the save (not to one opened meanwhile); edits made during the save stay unsaved.
   * Resolves true when the file was written.
   */
  async saveProject(saveAs = false): Promise<boolean> {
    const bridge = this.fileBridge;
    const direct = !!(bridge?.saveProject && bridge.chooseProjectPath);
    if (!bridge || (!direct && !bridge.saveText)) {
      this.log('Projects need the desktop app.');
      return false;
    }
    const gen = this.internals.projectGen;
    const rev = this.internals.projectRev;
    const snapshot = this.project;
    const revision = captureRevision();
    const suggest = snapshot.path ?? `${snapshot.name.replace(/\s+/g, '_')}.jcadproj.json`;
    this.lastFileError = null;
    let written: { path: string; project: Project };
    try {
      if (direct) {
        let dest = !saveAs && snapshot.path ? snapshot.path : await bridge.chooseProjectPath!(suggest);
        if (!dest) return false;
        const write = (to: string) => saveQueue.run(to, revision, () => bridge.saveProject!(to, serializeProject(rebaseProject(snapshot, to))));
        let r;
        try {
          r = await write(dest);
        } catch (err) {
          // A path the main process does not know (a recovered project from another session): ask where to save.
          if (!/Unknown project path/.test((err as Error).message) || saveAs) throw err;
          dest = await bridge.chooseProjectPath!(suggest);
          if (!dest) return false;
          r = await write(dest);
        }
        const out = rebaseProject(snapshot, dest);
        if (r.status === 'stale') {
          this.lastFileError = `a newer version of ${dest} was saved meanwhile`;
          return false;
        }
        if (!r.value) return false;
        written = { path: r.value, project: r.value === dest ? out : rebaseProject(snapshot, r.value) };
      } else {
        // Older bridge / browser: the save dialog (or a download) picks the name; entries are written as they are.
        const p = await bridge.saveText!(suggest, serializeProject(snapshot), 'JCad Electrical Project', 'json');
        if (!p) return false;
        saveQueue.markCompleted(p, revision);
        written = { path: p, project: { ...snapshot, path: p } };
      }
    } catch (err) {
      // Nothing is marked as saved; the project stays modified (and autosaved). Retry / Save As... come from the save error dialog.
      const info = describeFileError(err, { action: 'save', path: snapshot.path });
      this.lastFileError = info.message;
      this.log(`Project not saved: ${info.message}`);
      const choice = this.hooks.saveError ? await this.hooks.saveError(info, snapshot.name, { saveAs: true }) : 'cancel';
      if (choice === 'cancel' || this.internals.projectGen !== gen) return false;
      return this.saveProject(choice === 'saveas' ? true : saveAs);
    }
    if (this.internals.projectGen !== gen) {
      this.log(`Project ${snapshot.name} saved: ${written.path} (another project is open now; it is unchanged).`);
      return true;
    }
    if (this.internals.projectRev === rev) {
      this.project = written.project;
      this.projectDirty = false;
      this.log(`Project saved: ${written.path}`);
    } else {
      // Edits made while the file was written stay (unsaved), re-expressed for the new location.
      this.project = rebaseProject(this.project, written.path);
      this.log(`Project saved: ${written.path} (changes made during the save are still unsaved).`);
    }
    documents.rememberRecent(this, written.path);
    this.hooks.projectChanged?.();
    this.emit('project');
    return true;
  }

  /** Open a drawing that belongs to the project (by index or path). */
  openProjectDrawing(index: number): void {
    const d = this.project.drawings[index];
    if (!d) return;
    void this.openFile(resolveDrawingPath(this.project, d));
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
  private hiddenLayers(): Set<string> {
    return new Set(this.doc.layers.filter((l) => !l.visible).map((l) => l.name));
  }
  private lockedLayers(): Set<string> {
    return new Set(this.doc.layers.filter((l) => l.locked).map((l) => l.name));
  }

  screenFromEvent(ev: MouseEvent): Point {
    const r = this.viewport.canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  /** Compute the effective (snapped/constrained) world point for the cursor. */
  private resolveCursor(screen: Point): { world: Point; snap: SnapResult | null } {
    const raw = this.viewport.toWorld(screen);
    // Object snap target box: Options > Drafting > Aperture Size (px, full box; default 10 -> 7 px reach).
    const aperture = (this.settings.apertureSize / 2 + 2) * this.viewport.worldPerPixel();
    const wantSnap = (this.tool !== null || this.internals.gripDrag !== null) && !this.internals.selReq;
    const snap = wantSnap
      ? findObjectSnap(raw, this.doc.entities, this.doc.lookupBlock, this.snap, aperture, this.overlay.trackFrom, this.hiddenLayers())
      : null;
    this.overlay.trackPaths = undefined;
    if (snap) {
      // Object snap tracking acquires the points the cursor pauses on (the last two).
      if (this.snap.otrack && wantSnap && snap.kind !== 'perpendicular' && snap.kind !== 'nearest') {
        if (!this.internals.acquired.some((q) => g.eq(q, snap.point, 1e-9))) this.internals.acquired = [...this.internals.acquired.slice(-1), snap.point];
        this.overlay.acquired = this.internals.acquired;
      }
      return { world: snap.point, snap };
    }
    let p = raw;
    if (this.snap.otrack && wantSnap) {
      const bases = this.overlay.trackFrom ? [...this.internals.acquired, this.overlay.trackFrom] : this.internals.acquired;
      const tr = trackFromPoints(raw, bases, this.snap, aperture);
      if (tr) {
        this.overlay.trackPaths = tr.paths;
        return { world: tr.point, snap: { point: tr.point, kind: 'tracking' } };
      }
    }
    if (this.overlay.trackFrom) p = constrainDirection(this.overlay.trackFrom, p, this.snap);
    p = snapToGrid(p, this.snap);
    return { world: p, snap: null };
  }

  onMouseMove(ev: MouseEvent): void {
    const s = this.screenFromEvent(ev);
    if (this.internals.panning) {
      this.viewport.panByPixels(s.x - this.internals.lastMouse.x, s.y - this.internals.lastMouse.y);
      this.internals.lastMouse = s;
      this.render();
      this.emit('view');
      return;
    }
    this.internals.lastMouse = s;
    const { world, snap } = this.resolveCursor(s);
    this.internals.cursorWorld = world;
    this.overlay.cursor = world;
    this.overlay.snap = snap;

    if (this.internals.gripDrag) {
      const moved = applyGrip(this.internals.gripDrag.entity, this.internals.gripDrag.index, world);
      this.overlay.ghost = moved ? [moved] : [];
      this.overlay.dynText = [`${g.dist(this.internals.gripDrag.start, world).toFixed(4)}`];
      this.render();
      this.emit('view');
      return;
    }
    if (this.internals.dragStart && this.internals.dragWorld) {
      const raw = this.viewport.toWorld(s);
      if (g.dist(this.internals.dragStart, s) > 3) {
        this.overlay.selectionBox = { a: this.internals.dragWorld, b: raw, mode: s.x >= this.internals.dragStart.x ? 'window' : 'crossing' };
      }
    } else if (this.tool) {
      this.tool.onMove(world, this.makeContext());
    } else if (this.layoutInput.hoverBlocked?.(s)) {
      this.overlay.hover = null;
    } else {
      // rollover highlight
      const hit = pickEntity(this.viewport.toWorld(s), this.doc.entities, this.doc.lookupBlock, this.pickAperture(), this.hiddenLayers(), this.lockedLayers());
      this.overlay.hover = hit?.id ?? null;
      this.overlay.dynText = [];
    }
    this.render();
    this.emit('view');
  }

  private pickAperture(): number {
    return this.viewport.settings.pickBox * this.viewport.worldPerPixel();
  }

  onMouseDown(ev: MouseEvent): void {
    const s = this.screenFromEvent(ev);
    this.internals.lastMouse = s;
    if (ev.button === 1 || (ev.button === 0 && this.tool instanceof PanTool && !this.internals.selReq)) {
      ev.preventDefault();
      this.internals.panning = true;
      return;
    }
    if (ev.button !== 0) return;
    if (!this.internals.selReq && this.layoutInput.mouseDown?.(s)) return;
    const { world } = this.resolveCursor(s);
    if (this.tool && !this.internals.selReq) {
      this.acceptPoint(world);
      return;
    }
    // Selection (default tool or selection request)
    const raw = this.viewport.toWorld(s);
    // Grip editing: press on a grip of a selected entity to stretch it.
    if (!this.internals.selReq && this.selection.size > 0) {
      const gripTol = 6 * this.viewport.worldPerPixel();
      for (const e of this.doc.entities) {
        if (!this.selection.has(e.id)) continue;
        const idx = gripPoints(e).findIndex((gp) => g.dist(gp, raw) <= gripTol);
        if (idx >= 0) {
          this.internals.gripDrag = { entity: e, index: idx, start: raw };
          this.overlay.trackFrom = gripPoints(e)[idx]!;
          this.setPrompt('** STRETCH **  Specify stretch point:');
          this.overlay.cursorMode = 'point';
          this.render();
          return;
        }
      }
    }
    const hit = pickEntity(raw, this.doc.entities, this.doc.lookupBlock, this.pickAperture(), this.hiddenLayers(), this.lockedLayers());
    if (hit) {
      this.toggleSelect([hit.id], ev.shiftKey);
      return;
    }
    this.internals.dragStart = s;
    this.internals.dragWorld = raw;
  }

  onMouseUp(ev: MouseEvent): void {
    if (ev.button === 1 || (ev.button === 0 && this.internals.panning)) {
      this.internals.panning = false;
      return;
    }
    if (ev.button !== 0) return;
    if (this.internals.gripDrag) {
      const s = this.screenFromEvent(ev);
      const { world } = this.resolveCursor(s);
      const original = gripPoints(this.internals.gripDrag.entity)[this.internals.gripDrag.index];
      const moved = original && g.dist(original, world) > 1e-9 ? applyGrip(this.internals.gripDrag.entity, this.internals.gripDrag.index, world) : null;
      this.internals.gripDrag = null;
      this.overlay.ghost = [];
      this.overlay.trackFrom = null;
      this.overlay.dynText = [];
      this.updateCursorMode();
      this.setPrompt('Type a command');
      if (moved) this.doc.replaceEntities([moved]);
      this.render();
      return;
    }
    if (this.internals.dragStart && this.internals.dragWorld) {
      const s = this.screenFromEvent(ev);
      if (this.overlay.selectionBox) {
        const box = this.overlay.selectionBox;
        const bounds = g.boundsOfPoints([box.a, box.b])!;
        const found = selectByBox(bounds, box.mode, this.doc.entities, this.doc.lookupBlock, this.hiddenLayers(), this.lockedLayers());
        this.toggleSelect(found.map((e) => e.id), ev.shiftKey);
      } else if (g.dist(s, this.internals.dragStart) <= 3 && !this.internals.selReq && !ev.shiftKey) {
        // click on empty space clears selection
        if (this.selection.size > 0) {
          this.selection.clear();
          this.emit('selection');
        }
      }
      this.internals.dragStart = null;
      this.internals.dragWorld = null;
      this.overlay.selectionBox = null;
      this.render();
    }
  }

  onDoubleClick(ev: MouseEvent): void {
    if (ev.button === 1) {
      this.zoomExtents();
      return;
    }
    if (ev.button !== 0 || this.tool) return;
    if (this.layoutInput.doubleClick?.(this.screenFromEvent(ev))) return;
    const raw = this.viewport.toWorld(this.screenFromEvent(ev));
    const hit = pickEntity(raw, this.doc.entities, this.doc.lookupBlock, this.pickAperture(), this.hiddenLayers(), this.lockedLayers());
    if (!hit) return;
    const ui = this.ui ?? fallbackUi;
    if (hit.type === 'text') {
      void ui.textInput('Edit Text', 'Contents', hit.text).then((v) => {
        if (v !== null && v !== hit.text) this.doc.replaceEntities([{ ...hit, text: v }]);
      });
    } else if (hit.type === 'insert' && (hit.attributes.TAG1 !== undefined || hit.attributes.TERM01 !== undefined)) {
      if (this.commands.has('AEEDITCOMPONENT')) {
        // The AutoCAD Electrical-style dialog edits the full data set of the picked component.
        this.selection = new Set([hit.id]);
        this.emit('selection');
        this.runCommand('AEEDITCOMPONENT');
        return;
      }
      void ui
        .editComponent({ tag: hit.attributes.TAG1 ?? hit.attributes.TERM01 ?? '', desc: hit.attributes.DESC1 ?? '', block: hit.block, mfg: hit.attributes.MFG, cat: hit.attributes.CAT })
        .then((r) => {
          if (!r) return;
          const attrs = { ...hit.attributes };
          if (hit.attributes.TAG1 !== undefined) attrs.TAG1 = r.tag;
          if (hit.attributes.TERM01 !== undefined) attrs.TERM01 = r.tag;
          attrs.DESC1 = r.desc;
          if (r.mfg) attrs.MFG = r.mfg;
          else delete attrs.MFG;
          if (r.cat) attrs.CAT = r.cat;
          else delete attrs.CAT;
          this.doc.replaceEntities([{ ...hit, attributes: attrs }]);
        });
    } else {
      this.hooks.properties?.();
    }
  }

  private toggleSelect(ids: string[], remove: boolean): void {
    const target = this.internals.selReq ? this.internals.selReq.ids : this.selection;
    for (const id of ids) {
      if (remove) target.delete(id);
      else target.add(id);
    }
    if (this.internals.selReq) {
      this.selection = new Set(this.internals.selReq.ids);
      this.log(`${ids.length} found, ${this.internals.selReq.ids.size} total`);
    }
    this.emit('selection');
    this.render();
  }

  onWheel(ev: WheelEvent): void {
    ev.preventDefault();
    const s = this.screenFromEvent(ev);
    const factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
    this.viewport.zoomAt(s, factor);
    // keep cursor overlay consistent
    const { world, snap } = this.resolveCursor(s);
    this.overlay.cursor = world;
    this.overlay.snap = snap;
    this.render();
    this.emit('view');
  }

  onMouseLeave(): void {
    this.overlay.cursor = null;
    this.overlay.snap = null;
    this.overlay.hover = null;
    this.render();
  }

  onContextMenu(ev: MouseEvent): void {
    ev.preventDefault();
  }

  // ------------------------------------------------------------- keyboard
  onKeyDown(ev: KeyboardEvent): boolean {
    const key = ev.key;
    if (key === 'Escape') {
      this.cancel();
      return true;
    }
    if (key === 'F3') {
      this.toggle('osnap');
      return true;
    }
    if (key === 'F7') {
      this.toggle('grid');
      return true;
    }
    if (key === 'F8') {
      this.toggle('ortho');
      return true;
    }
    if (key === 'F9') {
      this.toggle('gridSnap');
      return true;
    }
    if (key === 'F10') {
      this.toggle('polar');
      return true;
    }
    if (key === 'F11') {
      this.toggle('otrack');
      return true;
    }
    if (key === 'F12') {
      this.toggle('dyn');
      return true;
    }
    if (ev.ctrlKey || ev.metaKey) {
      const k = key.toLowerCase();
      if (k === 'z') {
        if (!ev.shiftKey && this.tool && (this.tool.name === 'LINE' || this.tool.name === 'PLINE' || this.tool.name === 'AEWIRE')) {
          this.tool.onText('U', this.makeContext()); // stay in the command, undo the last segment
          return true;
        }
        this.runCommand(ev.shiftKey ? 'REDO' : 'UNDO');
        return true;
      }
      if (k === 'y') {
        this.runCommand('REDO');
        return true;
      }
      if (k === 's') {
        this.runCommand(ev.shiftKey ? 'SAVEAS' : 'SAVE');
        return true;
      }
      if (k === 'o') {
        this.runCommand('OPEN');
        return true;
      }
      if (k === 'n') {
        this.runCommand('NEW');
        return true;
      }
      if (k === 'a') {
        this.runCommand('SELECTALL');
        return true;
      }
      return false;
    }
    if (key === 'Delete' && !this.tool && this.selection.size > 0) {
      this.runCommand('ERASE');
      return true;
    }
    return false;
  }

  /** Current mouse position in world coordinates for the status bar. */
  cursorPosition(): Point | null {
    return this.internals.cursorWorld;
  }

  entitiesSelected(): Entity[] {
    return this.doc.entities.filter((e) => this.selection.has(e.id));
  }
}

/** Move grip `index` of an entity to `p` (AutoCAD grip stretch semantics). */
export function applyGrip(e: Entity, index: number, p: Point): Entity | null {
  return moveGrip(e, index, p);
}
