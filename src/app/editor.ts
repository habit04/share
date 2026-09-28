import type { Point } from '../core/geometry';
import * as g from '../core/geometry';
import type { Entity } from '../core/entities';
import { Drawing } from '../core/document';
import type { DrawingState } from '../core/document';
import { defaultSnapSettings, findObjectSnap, constrainDirection, snapToGrid, type SnapResult, type SnapSettings } from '../core/snap';
import { pickEntity, selectByBox } from '../core/selection';
import { Viewport, type ViewportOverlay } from '../render/viewport';
import type { Tool, ToolContext, LadderSettings } from '../tools/types';
import { LineTool, PolylineTool, CircleTool, ArcTool, RectangleTool, TextTool } from '../tools/draw';
import { EraseTool, MoveTool, CopyTool, RotateTool, DistTool } from '../tools/modify';
import { WireTool, LadderTool, ComponentTool, assignWireNumbers } from '../tools/electrical';
import { TrimTool, ExtendTool, OffsetTool, MirrorTool, ScaleTool, ExplodeTool, ZoomWindowTool, PanTool } from '../tools/edit';
import { lineweightDisplay } from '../render/draw';
import { WIRE_DOT } from '../electrical/symbols';
import { LIBRARY_SYMBOLS, withoutUnusedLibraryBlocks } from '../electrical/library';
import { updateCrossReferences } from '../electrical/xref';
import { TITLE_BLOCK, newFromTemplate, SHEET_SIZES, type SheetSize } from '../electrical/templates';
import { PlcModuleTool, SignalArrowTool, TerminalStripTool, DEFAULT_PLC, DEFAULT_STRIP, SOURCE_ARROW, DEST_ARROW, type PlcModuleSettings, type TerminalStripSettings } from '../tools/plc';
import { gripPoints, moveGrip } from '../core/entities';
import { parseProject, serializeProject, defaultProject, resolveDrawingPath, baseName, type Project } from './project';
import { loadSettings, saveSettings, pushRecent, type UserSettings } from './settings';
import { SessionManager, applySaveResult } from './sessions';
import type { ColorSpec } from '../core/entities';
import { readDxf, writeDxf } from '../io/dxf';
import { layoutPage, type PlotOptions } from './plot';
import { parsePointInput, isPlainNumber } from './input';
import { convertDwg, type DwgImportPayload } from '../io/dwg';
import type { ElectricalUi } from '../electrical/ui';
import { registerElectricalCommands } from './commands-electrical';
import { registerDraftingCommands } from './commands-drafting';
import { registerSymbolBuilderCommands, type SymbolBuilderUi } from '../tools/symbol-builder';
import { trackFromPoints } from '../core/snap';

export type EditorEvent = 'change' | 'selection' | 'tool' | 'view' | 'snap' | 'file' | 'log';

export interface CommandDef {
  name: string;
  aliases: string[];
  description: string;
  run: (editor: Editor, arg?: string) => void;
  /** The command starts a Tool (which logs "Command: NAME" itself). */
  startsTool?: boolean;
}

interface SelectionRequest {
  prompt: string;
  onDone: (ids: string[]) => void;
  ids: Set<string>;
}

export type OpenResult =
  | { path: string; kind: 'dxf'; text: string }
  | { path: string; kind: 'dwg'; payload: DwgImportPayload; version?: string };

/** Sheet size in inches (already oriented) plus Electron's named page size when there is one. */
export interface PlotSheet {
  width: number;
  height: number;
  electron?: string;
}

export interface FileBridge {
  openDxf(): Promise<{ path: string; text: string } | null>;
  /** Desktop only: open DXF or DWG (DWG parsed by LibreDWG in the main process). */
  openDrawing?(file?: string): Promise<OpenResult | null>;
  saveDxf(path: string | null, text: string, suggestName: string): Promise<string | null>;
  openProject?(file?: string): Promise<{ path: string; text: string } | null>;
  saveText?(suggestName: string, text: string, filterName: string, ext: string): Promise<string | null>;
  plotPdf?(dataUrl: string, suggestName: string, landscape: boolean, sheet?: PlotSheet): Promise<string | null>;
  /** Print the rendered sheet through the system print dialog; resolves true when a job was sent. */
  printDrawing?(dataUrl: string, title: string, landscape: boolean, sheet?: PlotSheet): Promise<boolean>;
}

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
  };
  private selReq: SelectionRequest | null = null;
  private dragStart: Point | null = null; // screen
  private dragWorld: Point | null = null;
  private panning = false;
  private lastMouse: Point = { x: 0, y: 0 };
  private cursorWorld: Point | null = null;
  ui: ToolContext['ui'] | null = null;
  fileBridge: FileBridge | null = null;
  /** Extra UI hooks provided by main.ts. */
  hooks: {
    reports?: (key: string) => void;
    template?: () => Promise<{ size: SheetSize; fields: Record<string, string> } | null>;
    plc?: (init: PlcModuleSettings) => Promise<PlcModuleSettings | null>;
    terminalStrip?: (init: TerminalStripSettings) => Promise<TerminalStripSettings | null>;
    wireType?: (current: string) => Promise<string | null>;
    properties?: () => void;
    projectChanged?: () => void;
    /** AutoCAD Electrical-style dialogs (see src/electrical/ui.ts); defaults come from src/ui/electrical-dialogs.ts. */
    electrical?: ElectricalUi;
    /** Symbol Builder start dialog and palette (src/ui/symbol-builder.ts). */
    symbolBuilder?: SymbolBuilderUi;
    /** Plot / Print dialog (paper, orientation, scale, margins); null = cancelled. */
    plot?: (mode: 'pdf' | 'print') => Promise<PlotOptions | null>;
  } = {};
  settings: UserSettings = loadSettings();
  project: Project = defaultProject();
  /** Layer new wires go on (AEWIRETYPE). */
  wireLayer = 'WIRES';
  /** File name to suggest in Save As (set by DWG import). */
  suggestedName: string | null = null;
  private gripDrag: { entity: Entity; index: number; start: Point } | null = null;

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
    this.registerCommands();
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
        ed.selReq = { prompt, onDone, ids: new Set() };
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
    this.selReq = null;
    this.clearOverlay();
    this.updateCursorMode();
    this.setPrompt('Type a command');
    this.emit('tool');
    this.render();
  }

  cancel(): void {
    if (this.gripDrag) {
      this.gripDrag = null;
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
    if (this.selReq) {
      this.selReq = null;
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
    this.acquired = [];
    this.overlay.dynText = [];
    this.overlay.selectionBox = null;
    this.overlay.hover = null;
    this.dragStart = null;
    this.dragWorld = null;
  }

  applySettings(): void {
    const st = this.settings;
    this.viewport.settings.gridVisible = st.gridVisible;
    this.viewport.settings.crosshairSize = st.crosshairSize;
    this.snap.gridSnap = st.gridSnap;
    this.snap.ortho = st.ortho;
    this.snap.polar = st.polar;
    this.snap.osnap = st.osnap;
    this.dynamicInput = st.dynamicInput;
    lineweightDisplay.enabled = st.lineweightDisplay;
  }

  persistSettings(): void {
    this.settings = {
      ...this.settings,
      gridVisible: this.viewport.settings.gridVisible,
      crosshairSize: this.viewport.settings.crosshairSize,
      gridSnap: this.snap.gridSnap,
      ortho: this.snap.ortho,
      polar: this.snap.polar,
      osnap: this.snap.osnap,
      dynamicInput: this.dynamicInput,
      lineweightDisplay: lineweightDisplay.enabled,
    };
    saveSettings(this.settings);
  }

  private rememberRecent(path: string): void {
    this.settings = { ...this.settings, recentFiles: pushRecent(this.settings.recentFiles, path) };
    saveSettings(this.settings);
    this.emit('file');
  }

  /** Whether typed input should be treated as literal text (TEXT command content). */
  acceptsFreeText(): boolean {
    return this.tool?.acceptsFreeText?.() ?? false;
  }

  private updateCursorMode(): void {
    this.overlay.cursorMode = this.selReq ? 'select' : this.tool ? 'point' : 'idle';
  }

  // ------------------------------------------------------------- commands
  register(def: CommandDef): void {
    this.commands.set(def.name.toUpperCase(), def);
    for (const a of def.aliases) this.commands.set(a.toUpperCase(), def);
  }

  private registerCommands(): void {
    const reg = (name: string, aliases: string[], description: string, run: (ed: Editor, arg?: string) => void) =>
      this.register({ name, aliases, description, run });

    reg('LINE', ['L'], 'Draw line segments', (ed) => ed.startTool(new LineTool()));
    reg('PLINE', ['PL'], 'Draw a polyline', (ed) => ed.startTool(new PolylineTool()));
    reg('CIRCLE', ['C'], 'Draw a circle', (ed) => ed.startTool(new CircleTool()));
    reg('ARC', ['A'], 'Draw a 3-point arc', (ed) => ed.startTool(new ArcTool()));
    reg('RECTANG', ['REC', 'RECTANGLE'], 'Draw a rectangle', (ed) => ed.startTool(new RectangleTool()));
    reg('TEXT', ['T', 'DT', 'DTEXT'], 'Single-line text', (ed) => ed.startTool(new TextTool()));
    reg('ERASE', ['E', 'DEL'], 'Erase objects', (ed) => ed.startTool(new EraseTool()));
    reg('MOVE', ['M'], 'Move objects', (ed) => ed.startTool(new MoveTool()));
    reg('COPY', ['CO', 'CP'], 'Copy objects', (ed) => ed.startTool(new CopyTool()));
    reg('ROTATE', ['RO'], 'Rotate objects', (ed) => ed.startTool(new RotateTool()));
    reg('DIST', ['DI'], 'Measure distance', (ed) => ed.startTool(new DistTool()));
    reg('TRIM', ['TR'], 'Trim objects at cutting edges', (ed) => ed.startTool(new TrimTool()));
    reg('EXTEND', ['EX'], 'Extend lines to boundary edges', (ed) => ed.startTool(new ExtendTool()));
    reg('OFFSET', ['O'], 'Offset lines, arcs, circles, polylines', (ed) => ed.startTool(new OffsetTool()));
    reg('MIRROR', ['MI'], 'Mirror objects about a line', (ed) => ed.startTool(new MirrorTool()));
    reg('SCALE', ['SC'], 'Scale objects about a base point', (ed) => ed.startTool(new ScaleTool()));
    reg('EXPLODE', ['X'], 'Explode blocks and polylines', (ed) => ed.startTool(new ExplodeTool()));
    reg('PAN', ['P'], 'Pan: drag with the left button (or any time with the middle button); Esc ends', (ed) => ed.startTool(new PanTool()));
    reg('LWDISPLAY', ['LW'], 'Toggle lineweight display', (ed) => ed.toggle('lw'));
    reg('DYNMODE', ['DYN', 'F12'], 'Toggle dynamic input', (ed) => ed.toggle('dyn'));
    reg('CURSORSIZE', [], 'Crosshair size in percent of screen (5-100)', (ed, arg) => {
      const v = parseInt(arg ?? '', 10);
      if (Number.isFinite(v) && v >= 1 && v <= 100) {
        ed.viewport.settings.crosshairSize = v;
        ed.render();
      } else ed.log(`CURSORSIZE = ${ed.viewport.settings.crosshairSize} (enter 1-100)`);
    });
    reg('LINE2WIRE', [], 'Convert selected lines to wires', (ed) => {
      const lines = ed.entitiesSelected().filter((e) => e.type === 'line');
      if (lines.length === 0) {
        ed.log('Select lines first.');
        return;
      }
      ed.doc.replaceEntities(lines.map((e) => ({ ...e, layer: 'WIRES', color: 'ByLayer' as const })));
      ed.log(`${lines.length} line(s) converted to wires.`);
    });
    reg('UNDO', ['U'], 'Undo last action', (ed) => {
      if (!ed.doc.undo()) ed.log('Nothing to undo.');
    });
    reg('REDO', ['MREDO'], 'Redo', (ed) => {
      if (!ed.doc.redo()) ed.log('Nothing to redo.');
    });
    reg('ZOOM', ['Z'], 'Zoom [Extents/All/In/Out]', (ed, arg) => {
      const a = (arg ?? 'E').toUpperCase();
      if (a.startsWith('E') || a.startsWith('A')) ed.zoomExtents();
      else if (a.startsWith('W')) {
        ed.startTool(
          new ZoomWindowTool((b) => {
            ed.viewport.zoomToBounds(b, 0.02);
            ed.render();
            ed.emit('view');
          }),
        );
        return;
      } else if (a.startsWith('I')) ed.viewport.zoomAt({ x: ed.viewport.width / 2, y: ed.viewport.height / 2 }, 1.5);
      else if (a.startsWith('O')) ed.viewport.zoomAt({ x: ed.viewport.width / 2, y: ed.viewport.height / 2 }, 1 / 1.5);
      else ed.log('Zoom options: Extents, All, Window, In, Out');
      ed.render();
      ed.emit('view');
    });
    reg('REGEN', ['RE'], 'Regenerate display', (ed) => ed.render());
    reg('GRID', ['F7'], 'Toggle grid', (ed) => ed.toggle('grid'));
    reg('SNAP', ['F9'], 'Toggle grid snap', (ed) => ed.toggle('gridSnap'));
    reg('ORTHO', ['F8'], 'Toggle ortho', (ed) => ed.toggle('ortho'));
    reg('POLAR', ['F10'], 'Toggle polar tracking', (ed) => ed.toggle('polar'));
    reg('OSNAP', ['F3', 'OS'], 'Toggle object snap', (ed) => ed.toggle('osnap'));
    reg('SELECTALL', ['ALL'], 'Select all objects', (ed) => {
      ed.selection = new Set(ed.doc.entities.map((e) => e.id));
      ed.emit('selection');
      ed.render();
    });
    reg('NEW', ['QNEW'], 'New drawing', (ed) => ed.newDrawing());
    reg('OPEN', [], 'Open a DXF or DWG drawing', (ed, arg) => void ed.openFile(arg));
    reg('SAVE', ['QSAVE'], 'Save drawing (DXF)', (ed) => void ed.saveFile(false));
    reg('SAVEAS', [], 'Save drawing as (DXF)', (ed) => void ed.saveFile(true));
    reg('LIST', ['LI'], 'List selected objects', (ed) => ed.listSelection());
    reg('HELP', ['?'], 'List commands', (ed) => {
      const seen = new Set<CommandDef>();
      for (const d of ed.commands.values()) {
        if (seen.has(d)) continue;
        seen.add(d);
        ed.log(`  ${d.name.padEnd(12)} ${d.aliases.length ? `(${d.aliases.join(', ')})` : ''}  ${d.description}`);
      }
    });
    // Electrical
    reg('AEWIRE', ['WIRE', 'W'], 'Insert wire', (ed) => ed.startTool(new WireTool(ed.wireLayer)));
    reg('AELADDER', ['LADDER'], 'Insert ladder', (ed) => ed.startTool(new LadderTool()));
    reg('AECOMPONENT', ['COMPONENT', 'CMP', 'AEC'], 'Insert component from icon menu', (ed, arg) => ed.startTool(new ComponentTool(arg)));
    reg('AEWIRENO', ['WIRENO'], 'Insert wire numbers', (ed, arg) => {
      const start = arg ? parseInt(arg, 10) : 100;
      const n = assignWireNumbers(ed.doc, Number.isFinite(start) ? start : 100);
      ed.log(`${n} wire number(s) assigned.`);
    });
    reg('LAYER', ['LA'], 'Layer properties', (ed) => ed.emitLayerDialog());
    reg('PROPERTIES', ['PR', 'CH', 'MO'], 'Properties palette', (ed) => ed.hooks.properties?.());
    reg('AEXREF', ['XREF'], 'Update coil/contact cross-references', (ed) => {
      const n = updateCrossReferences(ed.doc);
      ed.log(`Cross-references updated for ${n} tag(s).`);
    });
    reg('AEREPORT', ['REPORT', 'BOM'], 'Schematic reports [bom/components/wires/terminals/audit]', (ed, arg) => ed.hooks.reports?.((arg ?? 'bom').toLowerCase()));
    reg('AEPLC', ['PLC'], 'Insert parametric PLC I/O module', (ed) => ed.startTool(new PlcModuleTool((init) => ed.hooks.plc?.(init) ?? Promise.resolve(init ?? DEFAULT_PLC))));
    reg('AETERMSTRIP', ['TERMSTRIP'], 'Insert terminal strip', (ed) => ed.startTool(new TerminalStripTool((init) => ed.hooks.terminalStrip?.(init) ?? Promise.resolve(init ?? DEFAULT_STRIP))));
    reg('AESOURCE', ['SOURCE'], 'Insert source signal arrow', (ed) => ed.startTool(new SignalArrowTool('source', (t, l, i) => (ed.ui ?? fallbackUi).textInput(t, l, i))));
    reg('AEDEST', ['DEST'], 'Insert destination signal arrow', (ed) => ed.startTool(new SignalArrowTool('destination', (t, l, i) => (ed.ui ?? fallbackUi).textInput(t, l, i))));
    reg('AEWIRETYPE', ['WIRETYPE'], 'Choose the wire type (layer) for new wires', (ed) => {
      void (ed.hooks.wireType?.(ed.wireLayer) ?? Promise.resolve(null)).then((layer) => {
        if (layer) {
          ed.wireLayer = layer;
          ed.log(`Wire type set to ${layer}.`);
        }
      });
    });
    reg('NEWSHEET', ['TEMPLATE'], 'New drawing from a sheet template', (ed) => {
      void ed.confirmDiscardPublic().then((ok) => {
        if (!ok) return;
        void (ed.hooks.template?.() ?? Promise.resolve({ size: SHEET_SIZES[1]!, fields: {} })).then((r) => {
          if (!r) return;
          ed.loadState(newFromTemplate(r.size, r.fields), null);
          ed.doc.dirty = true;
          ed.log(`New ${r.size.name} sheet.`);
        });
      });
    });
    reg('OPENPROJECT', ['PROJECT'], 'Open a project file', (ed, arg) => void ed.openProject(arg));
    reg('PROJECTADD', [], 'Add the current drawing to the project', (ed) => ed.addCurrentToProject());
    reg('PROJECTSAVE', [], 'Save the project file', (ed) => void ed.saveProject());
    reg('PLOT', ['PDF'], 'Plot the drawing to PDF', (ed) => void ed.plot());
    reg('PRINT', ['PRINTDRAWING'], 'Print the drawing (system print dialog)', (ed) => void ed.print());
    reg('RECENT', [], 'Open a recent file by index', (ed, arg) => {
      const i = parseInt(arg ?? '1', 10) - 1;
      const f = ed.settings.recentFiles[i];
      if (f) void ed.openFile(f);
      else ed.settings.recentFiles.forEach((r, k) => ed.log(`  ${k + 1}. ${r}`));
    });
    registerDraftingCommands(this);
    registerElectricalCommands(this);
    registerSymbolBuilderCommands(this);
  }

  /** Hook for keywords typed at a "Select objects:" prompt (ALL / Last / Previous); returns true when handled. */
  selectionKeyword: ((text: string, ids: Set<string>) => boolean) | null = null;

  layerDialogRequested: (() => void) | null = null;
  private emitLayerDialog(): void {
    this.layerDialogRequested?.();
  }

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
    if (this.selReq) {
      const handled = this.selectionKeyword ? this.selectionKeyword(text, this.selReq.ids) : false;
      if (handled || text.toUpperCase() === 'ALL') {
        if (!handled) for (const e of this.doc.entities) this.selReq.ids.add(e.id);
        this.selection = new Set(this.selReq.ids);
        this.emit('selection');
        this.render();
        this.log(`${this.selReq.ids.size} found`);
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
      if (this.tool.acceptsDistance && isPlainNumber(text) && Number.isFinite(num) && this.overlay.trackFrom && this.cursorWorld) {
        // direct distance entry along the cursor direction
        const dir = constrainDirection(this.overlay.trackFrom, this.cursorWorld, this.snap);
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
    if (this.selReq) {
      const req = this.selReq;
      this.selReq = null;
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
    this.acquired = [];
    this.overlay.acquired = undefined;
    this.overlay.trackPaths = undefined;
    this.tool?.onPoint(p, this.makeContext());
    this.emit('tool');
  }

  dynamicInput = true;

  toggle(name: 'grid' | 'gridSnap' | 'ortho' | 'polar' | 'osnap' | 'otrack' | 'lw' | 'dyn'): void {
    if (name === 'grid') this.viewport.settings.gridVisible = !this.viewport.settings.gridVisible;
    else if (name === 'lw') lineweightDisplay.enabled = !lineweightDisplay.enabled;
    else if (name === 'dyn') this.dynamicInput = !this.dynamicInput;
    else if (name === 'ortho') {
      this.snap.ortho = !this.snap.ortho;
      if (this.snap.ortho) this.snap.polar = false;
    } else if (name === 'polar') {
      this.snap.polar = !this.snap.polar;
      if (this.snap.polar) this.snap.ortho = false;
    } else this.snap[name] = !this.snap[name];
    const state =
      name === 'grid' ? this.viewport.settings.gridVisible : name === 'lw' ? lineweightDisplay.enabled : name === 'dyn' ? this.dynamicInput : this.snap[name];
    this.log(`<${name.toUpperCase()} ${state ? 'on' : 'off'}>`);
    this.persistSettings();
    this.emit('snap');
    this.render();
  }

  zoomExtents(): void {
    this.viewport.zoomToBounds(this.doc.extents());
    this.render();
    this.emit('view');
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
  private async confirmDiscard(): Promise<boolean> {
    if (!this.doc.dirty) return true;
    const ui = this.ui ?? fallbackUi;
    if (ui.saveChanges) {
      const r = await ui.saveChanges(this.fileName());
      if (r === 'cancel') return false;
      if (r === 'save') {
        await this.saveFile(false);
        return !this.doc.dirty;
      }
      return true;
    }
    return ui.confirm('Unsaved changes', `${this.fileName()} has unsaved changes. Discard them?`);
  }

  newDrawing(): void {
    void this.confirmDiscard().then((ok) => {
      if (ok) this.newDrawingNow();
    });
  }

  newDrawingNow(): void {
    const fresh = new Drawing();
    this.doc.load(fresh.snapshot, null);
    this.doc.ensureBlocks([...LIBRARY_SYMBOLS, TITLE_BLOCK, SOURCE_ARROW, DEST_ARROW, WIRE_DOT]);
    this.selection.clear();
    this.viewport.zoomToBounds(null);
    this.log('New drawing.');
    this.emit('file');
    this.emit('selection');
    this.render();
  }

  loadState(state: DrawingState, path: string | null): void {
    this.doc.load(state, path);
    this.doc.ensureBlocks([...LIBRARY_SYMBOLS, TITLE_BLOCK, SOURCE_ARROW, DEST_ARROW, WIRE_DOT]);
    this.selection.clear();
    this.zoomExtents();
    this.emit('file');
    this.emit('selection');
  }

  async openFile(file?: string): Promise<void> {
    if (!this.fileBridge) {
      this.log('No file access in this environment.');
      return;
    }
    if (!(await this.confirmDiscard())) return;
    try {
      if (this.fileBridge.openDrawing) {
        this.log(file ? `Opening ${file} ...` : 'Opening ...');
        const res = await this.fileBridge.openDrawing(file);
        if (!res) return;
        this.rememberRecent(res.path);
        if (res.kind === 'dwg') {
          const { state, skipped, notes } = convertDwg(res.payload);
          // DWG is read-only for us: keep the file untitled so SAVE asks where to write the DXF copy.
          this.loadState(state, null);
          this.doc.dirty = true;
          this.suggestedName = res.path.replace(/\.dwg$/i, '.dxf').split(/[\\/]/).pop() ?? null;
          const skippedText = Object.keys(skipped).length
            ? ` Skipped unsupported: ${Object.entries(skipped).map(([k, v]) => `${k}×${v}`).join(', ')}.`
            : '';
          this.log(`Imported DWG ${res.path} (${res.version || 'unknown version'}): ${state.entities.length} entities, ${state.layers.length} layers, ${Object.keys(state.blocks).length} blocks.${skippedText}`);
          for (const n of notes) this.log(`DWG import: ${n}`);
          this.log('DWG import is read-only; use SAVE to write a DXF copy next to the original.');
          this.emit('file');
          return;
        }
        const state = readDxf(res.text);
        this.loadState(state, res.path);
        this.log(`Opened ${res.path}: ${state.entities.length} entities, ${state.layers.length} layers, ${Object.keys(state.blocks).length} blocks.`);
        return;
      }
      const res = await this.fileBridge.openDxf();
      if (!res) return;
      const state = readDxf(res.text);
      this.loadState(state, res.path);
      this.log(`Opened ${res.path}: ${state.entities.length} entities, ${state.layers.length} layers, ${Object.keys(state.blocks).length} blocks.`);
    } catch (err) {
      this.log(`Failed to open drawing: ${(err as Error).message}`);
    }
  }

  async saveFile(saveAs: boolean): Promise<void> {
    if (!this.fileBridge) {
      this.log('No file access in this environment.');
      return;
    }
    // Remember exactly which document revision goes to disk: edits made while the file
    // dialog / write is pending (or in another tab) must stay flagged as unsaved.
    const sessionId = this.sessions.current.id;
    const savedState = this.doc.snapshot;
    const text = writeDxf(withoutUnusedLibraryBlocks(savedState));
    const path = await this.fileBridge.saveDxf(saveAs ? null : this.doc.filePath, text, this.suggestedName ?? this.fileName());
    if (path) {
      const outcome = applySaveResult(this.sessions, this, sessionId, savedState, path);
      if (outcome === 'clean' && this.sessions.current.id === sessionId) this.suggestedName = null;
      this.log(outcome === 'newer-edits' ? `Saved ${path} (edits made during the save are still unsaved).` : `Saved ${path}`);
      this.rememberRecent(path);
      this.emit('file');
    }
  }

  confirmDiscardPublic(): Promise<boolean> {
    return this.confirmDiscard();
  }

  async openProject(file?: string): Promise<void> {
    if (!this.fileBridge?.openProject) {
      this.log('Projects need the desktop app.');
      return;
    }
    try {
      const res = await this.fileBridge.openProject(file);
      if (!res) return;
      this.project = parseProject(res.text, res.path);
      this.log(`Project ${this.project.name}: ${this.project.drawings.length} drawing(s).`);
      this.rememberRecent(res.path);
      this.hooks.projectChanged?.();
      this.emit('file');
    } catch (err) {
      this.log(`Failed to open project: ${(err as Error).message}`);
    }
  }

  addCurrentToProject(): void {
    if (!this.doc.filePath) {
      this.log('Save the drawing first, then add it to the project.');
      return;
    }
    const file = this.project.path ? relativeTo(this.project.path, this.doc.filePath) : this.doc.filePath;
    if (this.project.drawings.some((d) => d.file === file)) {
      this.log('Drawing is already in the project.');
      return;
    }
    this.project = { ...this.project, drawings: [...this.project.drawings, { file }] };
    this.hooks.projectChanged?.();
    this.log(`Added ${baseName(file)} to project ${this.project.name}. Use PROJECTSAVE to write the project file.`);
    this.emit('file');
  }

  async saveProject(): Promise<void> {
    if (!this.fileBridge?.saveText) {
      this.log('Projects need the desktop app.');
      return;
    }
    const p = await this.fileBridge.saveText(this.project.path ?? `${this.project.name.replace(/\s+/g, '_')}.jcadproj.json`, serializeProject(this.project), 'JCad Electrical Project', 'json');
    if (p) {
      this.project = { ...this.project, path: p };
      this.log(`Project saved: ${p}`);
      this.rememberRecent(p);
      this.hooks.projectChanged?.();
    }
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
  async renderPlotImage(opts: PlotOptions): Promise<{ dataUrl: string; landscape: boolean; sheet: { width: number; height: number }; electron?: string; reducedToFit: boolean } | null> {
    const b = this.doc.extents();
    if (!b) return null;
    const w = b.max.x - b.min.x;
    const h = b.max.y - b.min.y;
    const lay = layoutPage(w, h, opts);
    const dpi = 150;
    const pw = Math.ceil(lay.sheet.width * dpi);
    const ph = Math.ceil(lay.sheet.height * dpi);
    const canvas = document.createElement('canvas');
    // Cap the bitmap (E-size at 150 dpi is 6600 x 5100); scale the dpi down for anything larger.
    const shrink = Math.min(1, 12000 / pw, 12000 / ph);
    canvas.width = Math.round(pw * shrink);
    canvas.height = Math.round(ph * shrink);
    const px = dpi * shrink; // pixels per inch on the bitmap
    const k = lay.scale * px; // pixels per drawing unit
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const ox = lay.origin.x * px;
    const oy = lay.origin.y * px;
    const tf = { scale: k, toScreen: (p: Point) => ({ x: ox + (p.x - b.min.x) * k, y: oy + (b.max.y - p.y) * k }) };
    const { drawEntity } = await import('../render/draw');
    const hidden = new Set(this.doc.layers.filter((l) => !l.visible).map((l) => l.name));
    for (const e of this.doc.entities) {
      if (hidden.has(e.layer)) continue;
      drawEntity(ctx, e, tf, this.doc.layers, this.doc.lookupBlock, { strokeOverride: '#000000', lineWidthOverride: Math.max(1, Math.round(px / 100)), hidden });
    }
    return { dataUrl: canvas.toDataURL('image/png'), landscape: lay.landscape, sheet: lay.sheet, electron: lay.electron, reducedToFit: lay.reducedToFit };
  }

  private plotOptions(): PlotOptions {
    const s = this.settings;
    return { paper: s.plotPaper, orientation: s.plotOrientation, scale: s.plotScale, margin: s.plotMargin };
  }

  async plot(): Promise<void> {
    if (!this.fileBridge?.plotPdf) {
      this.log('Plotting needs the desktop app (in the browser use PRINT and choose "Save as PDF").');
      return;
    }
    const opts = await (this.hooks.plot?.('pdf') ?? Promise.resolve(this.plotOptions()));
    if (!opts) return;
    const img = await this.renderPlotImage(opts);
    if (!img) {
      this.log('Nothing to plot.');
      return;
    }
    if (img.reducedToFit) this.log('The chosen scale did not fit the paper; the drawing was scaled down to fit.');
    const out = await this.fileBridge.plotPdf(img.dataUrl, this.fileName().replace(/\.[^.]+$/, '') + '.pdf', img.landscape, { ...img.sheet, electron: img.electron });
    if (out) this.log(`Plotted to ${out} (${img.sheet.width.toFixed(2)} x ${img.sheet.height.toFixed(2)} in).`);
  }

  /** PRINT: send the drawing to a printer through the system print dialog. */
  async print(): Promise<void> {
    if (!this.fileBridge?.printDrawing) {
      this.log('Printing is not available here.');
      return;
    }
    const opts = await (this.hooks.plot?.('print') ?? Promise.resolve(this.plotOptions()));
    if (!opts) return;
    const img = await this.renderPlotImage(opts);
    if (!img) {
      this.log('Nothing to print.');
      return;
    }
    if (img.reducedToFit) this.log('The chosen scale did not fit the paper; the drawing was scaled down to fit.');
    try {
      const ok = await this.fileBridge.printDrawing(img.dataUrl, this.fileName().replace(/\.[^.]+$/, ''), img.landscape, { ...img.sheet, electron: img.electron });
      this.log(ok ? 'Sent to the printer.' : 'Print cancelled.');
    } catch (err) {
      this.log(`Print failed: ${(err as Error).message}`);
    }
  }

  fileName(): string {
    if (!this.doc.filePath) return this.sessions.untitledName;
    return this.doc.filePath.split(/[\\/]/).pop() ?? 'Drawing1.dxf';
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
    const wantSnap = (this.tool !== null || this.gripDrag !== null) && !this.selReq;
    const snap = wantSnap
      ? findObjectSnap(raw, this.doc.entities, this.doc.lookupBlock, this.snap, aperture, this.overlay.trackFrom, this.hiddenLayers())
      : null;
    this.overlay.trackPaths = undefined;
    if (snap) {
      // Object snap tracking acquires the points the cursor pauses on (the last two).
      if (this.snap.otrack && wantSnap && snap.kind !== 'perpendicular' && snap.kind !== 'nearest') {
        if (!this.acquired.some((q) => g.eq(q, snap.point, 1e-9))) this.acquired = [...this.acquired.slice(-1), snap.point];
        this.overlay.acquired = this.acquired;
      }
      return { world: snap.point, snap };
    }
    let p = raw;
    if (this.snap.otrack && wantSnap) {
      const bases = this.overlay.trackFrom ? [...this.acquired, this.overlay.trackFrom] : this.acquired;
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

  /** Points acquired for object snap tracking; cleared whenever a point is accepted. */
  private acquired: Point[] = [];

  onMouseMove(ev: MouseEvent): void {
    const s = this.screenFromEvent(ev);
    if (this.panning) {
      this.viewport.panByPixels(s.x - this.lastMouse.x, s.y - this.lastMouse.y);
      this.lastMouse = s;
      this.render();
      this.emit('view');
      return;
    }
    this.lastMouse = s;
    const { world, snap } = this.resolveCursor(s);
    this.cursorWorld = world;
    this.overlay.cursor = world;
    this.overlay.snap = snap;

    if (this.gripDrag) {
      const moved = applyGrip(this.gripDrag.entity, this.gripDrag.index, world);
      this.overlay.ghost = moved ? [moved] : [];
      this.overlay.dynText = [`${g.dist(this.gripDrag.start, world).toFixed(4)}`];
      this.render();
      this.emit('view');
      return;
    }
    if (this.dragStart && this.dragWorld) {
      const raw = this.viewport.toWorld(s);
      if (g.dist(this.dragStart, s) > 3) {
        this.overlay.selectionBox = { a: this.dragWorld, b: raw, mode: s.x >= this.dragStart.x ? 'window' : 'crossing' };
      }
    } else if (this.tool) {
      this.tool.onMove(world, this.makeContext());
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
    this.lastMouse = s;
    if (ev.button === 1 || (ev.button === 0 && this.tool instanceof PanTool && !this.selReq)) {
      ev.preventDefault();
      this.panning = true;
      return;
    }
    if (ev.button !== 0) return;
    const { world } = this.resolveCursor(s);
    if (this.tool && !this.selReq) {
      this.acceptPoint(world);
      return;
    }
    // Selection (default tool or selection request)
    const raw = this.viewport.toWorld(s);
    // Grip editing: press on a grip of a selected entity to stretch it.
    if (!this.selReq && this.selection.size > 0) {
      const gripTol = 6 * this.viewport.worldPerPixel();
      for (const e of this.doc.entities) {
        if (!this.selection.has(e.id)) continue;
        const idx = gripPoints(e).findIndex((gp) => g.dist(gp, raw) <= gripTol);
        if (idx >= 0) {
          this.gripDrag = { entity: e, index: idx, start: raw };
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
    this.dragStart = s;
    this.dragWorld = raw;
  }

  onMouseUp(ev: MouseEvent): void {
    if (ev.button === 1 || (ev.button === 0 && this.panning)) {
      this.panning = false;
      return;
    }
    if (ev.button !== 0) return;
    if (this.gripDrag) {
      const s = this.screenFromEvent(ev);
      const { world } = this.resolveCursor(s);
      const original = gripPoints(this.gripDrag.entity)[this.gripDrag.index];
      const moved = original && g.dist(original, world) > 1e-9 ? applyGrip(this.gripDrag.entity, this.gripDrag.index, world) : null;
      this.gripDrag = null;
      this.overlay.ghost = [];
      this.overlay.trackFrom = null;
      this.overlay.dynText = [];
      this.updateCursorMode();
      this.setPrompt('Type a command');
      if (moved) this.doc.replaceEntities([moved]);
      this.render();
      return;
    }
    if (this.dragStart && this.dragWorld) {
      const s = this.screenFromEvent(ev);
      if (this.overlay.selectionBox) {
        const box = this.overlay.selectionBox;
        const bounds = g.boundsOfPoints([box.a, box.b])!;
        const found = selectByBox(bounds, box.mode, this.doc.entities, this.doc.lookupBlock, this.hiddenLayers(), this.lockedLayers());
        this.toggleSelect(found.map((e) => e.id), ev.shiftKey);
      } else if (g.dist(s, this.dragStart) <= 3 && !this.selReq && !ev.shiftKey) {
        // click on empty space clears selection
        if (this.selection.size > 0) {
          this.selection.clear();
          this.emit('selection');
        }
      }
      this.dragStart = null;
      this.dragWorld = null;
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
    const target = this.selReq ? this.selReq.ids : this.selection;
    for (const id of ids) {
      if (remove) target.delete(id);
      else target.add(id);
    }
    if (this.selReq) {
      this.selection = new Set(this.selReq.ids);
      this.log(`${ids.length} found, ${this.selReq.ids.size} total`);
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
    return this.cursorWorld;
  }

  entitiesSelected(): Entity[] {
    return this.doc.entities.filter((e) => this.selection.has(e.id));
  }
}

const fallbackUi: ToolContext['ui'] = {
  pickSymbol: async () => null,
  editComponent: async (init) => ({ tag: init.tag, desc: init.desc, mfg: init.mfg ?? '', cat: init.cat ?? '' }),
  ladderSettings: async (init: LadderSettings) => init,
  textInput: async (_t, _l, init) => init,
  confirm: async () => true,
};

/** Move grip `index` of an entity to `p` (AutoCAD grip stretch semantics). */
export function applyGrip(e: Entity, index: number, p: Point): Entity | null {
  return moveGrip(e, index, p);
}

function relativeTo(projectPath: string, file: string): string {
  const dir = projectPath.replace(/[\\/][^\\/]*$/, '');
  if (file.startsWith(dir + '/') || file.startsWith(dir + '\\')) return file.slice(dir.length + 1);
  return file;
}
