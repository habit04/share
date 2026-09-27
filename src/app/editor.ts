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
import { ALL_SYMBOLS } from '../electrical/symbols';
import { readDxf, writeDxf } from '../io/dxf';

export type EditorEvent = 'change' | 'selection' | 'tool' | 'view' | 'snap' | 'file' | 'log';

export interface CommandDef {
  name: string;
  aliases: string[];
  description: string;
  run: (editor: Editor, arg?: string) => void;
}

interface SelectionRequest {
  prompt: string;
  onDone: (ids: string[]) => void;
  ids: Set<string>;
}

export interface FileBridge {
  openDxf(): Promise<{ path: string; text: string } | null>;
  saveDxf(path: string | null, text: string, suggestName: string): Promise<string | null>;
}

const VERSION = '0.1.0';

export class Editor {
  readonly doc = new Drawing();
  readonly viewport: Viewport;
  readonly snap: SnapSettings = defaultSnapSettings();
  selection = new Set<string>();
  tool: Tool | null = null;
  toolName = '';
  lastCommand = '';
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

  constructor(canvas: HTMLCanvasElement) {
    this.viewport = new Viewport(canvas, this.doc);
    this.doc.ensureBlocks(ALL_SYMBOLS);
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
    this.log(`VoltCAD 2D ${VERSION} — type a command (LINE, AEWIRE, AELADDER, AECOMPONENT ...) or HELP.`);
  }

  // ------------------------------------------------------------- events
  on(ev: EditorEvent, fn: () => void): () => void {
    this.listeners[ev].add(fn);
    return () => this.listeners[ev].delete(fn);
  }
  private emit(ev: EditorEvent): void {
    for (const fn of this.listeners[ev]) fn();
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
        ed.overlay.dynText = lines;
        ed.render();
      },
      finish: () => ed.finishTool(),
      runCommand: (name) => ed.runCommand(name),
      ui: ed.ui ?? fallbackUi,
      requestSelection: (prompt, onDone) => {
        ed.selReq = { prompt, onDone, ids: new Set() };
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
    this.log(`Command: ${tool.name}`);
    tool.start(this.makeContext());
    this.emit('tool');
    this.render();
  }

  finishTool(): void {
    this.tool = null;
    this.toolName = '';
    this.selReq = null;
    this.clearOverlay();
    this.setPrompt('Type a command');
    this.emit('tool');
    this.render();
  }

  cancel(): void {
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
    this.overlay.dynText = [];
    this.overlay.selectionBox = null;
    this.dragStart = null;
    this.dragWorld = null;
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
    reg('UNDO', ['U'], 'Undo last action', (ed) => {
      if (!ed.doc.undo()) ed.log('Nothing to undo.');
    });
    reg('REDO', ['MREDO'], 'Redo', (ed) => {
      if (!ed.doc.redo()) ed.log('Nothing to redo.');
    });
    reg('ZOOM', ['Z'], 'Zoom [Extents/All/In/Out]', (ed, arg) => {
      const a = (arg ?? 'E').toUpperCase();
      if (a.startsWith('E') || a.startsWith('A')) ed.zoomExtents();
      else if (a.startsWith('I')) ed.viewport.zoomAt({ x: ed.viewport.width / 2, y: ed.viewport.height / 2 }, 1.5);
      else if (a.startsWith('O')) ed.viewport.zoomAt({ x: ed.viewport.width / 2, y: ed.viewport.height / 2 }, 1 / 1.5);
      else ed.log('Zoom options: Extents, All, In, Out');
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
    reg('OPEN', [], 'Open a DXF drawing', (ed) => void ed.openFile());
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
    reg('AEWIRE', ['WIRE', 'W'], 'Insert wire', (ed) => ed.startTool(new WireTool()));
    reg('AELADDER', ['LADDER'], 'Insert ladder', (ed) => ed.startTool(new LadderTool()));
    reg('AECOMPONENT', ['COMPONENT', 'CMP', 'AEC'], 'Insert component from icon menu', (ed, arg) => ed.startTool(new ComponentTool(arg)));
    reg('AEWIRENO', ['WIRENO'], 'Insert wire numbers', (ed, arg) => {
      const start = arg ? parseInt(arg, 10) : 100;
      const n = assignWireNumbers(ed.doc, Number.isFinite(start) ? start : 100);
      ed.log(`${n} wire number(s) assigned.`);
    });
    reg('LAYER', ['LA'], 'Layer properties', (ed) => ed.emitLayerDialog());
  }

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
    // Commands that are not tools still get logged
    if (!['LINE', 'PLINE', 'CIRCLE', 'ARC', 'RECTANG', 'TEXT', 'ERASE', 'MOVE', 'COPY', 'ROTATE', 'DIST', 'AEWIRE', 'AELADDER', 'AECOMPONENT'].includes(def.name))
      this.log(`Command: ${def.name}`);
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
      if (text.toUpperCase() === 'ALL') {
        for (const e of this.doc.entities) this.selReq.ids.add(e.id);
        this.selection = new Set(this.selReq.ids);
        this.emit('selection');
        this.render();
        this.log(`${this.selReq.ids.size} found`);
      }
      return;
    }
    if (this.tool) {
      const p = this.parsePoint(text);
      if (p) {
        this.acceptPoint(p);
        return;
      }
      const num = parseFloat(text);
      if (this.tool.acceptsDistance && /^-?\d*\.?\d+$/.test(text) && Number.isFinite(num) && this.overlay.trackFrom && this.cursorWorld) {
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
      const ids = [...req.ids];
      this.setPrompt('');
      req.onDone(ids);
      return;
    }
    if (this.tool) {
      this.tool.onEnter(this.makeContext());
      return;
    }
    if (this.lastCommand) this.runCommand(this.lastCommand);
  }

  /** Parse absolute "x,y", relative "@dx,dy" and polar "@d<a" input. */
  parsePoint(text: string): Point | null {
    const t = text.replace(/\s+/g, '');
    const rel = t.startsWith('@');
    const body = rel ? t.slice(1) : t;
    const base = this.lastPoint ?? { x: 0, y: 0 };
    let m = /^(-?[\d.]+)<(-?[\d.]+)$/.exec(body);
    if (m) {
      const d = parseFloat(m[1]!);
      const a = g.rad(parseFloat(m[2]!));
      if (!Number.isFinite(d) || !Number.isFinite(a)) return null;
      return g.polar(rel ? base : { x: 0, y: 0 }, a, d);
    }
    m = /^(-?[\d.]+),(-?[\d.]+)$/.exec(body);
    if (m) {
      const x = parseFloat(m[1]!);
      const y = parseFloat(m[2]!);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return rel ? { x: base.x + x, y: base.y + y } : { x, y };
    }
    return null;
  }

  private acceptPoint(p: Point): void {
    this.lastPoint = p;
    this.tool?.onPoint(p, this.makeContext());
    this.emit('tool');
  }

  toggle(name: 'grid' | 'gridSnap' | 'ortho' | 'polar' | 'osnap'): void {
    if (name === 'grid') this.viewport.settings.gridVisible = !this.viewport.settings.gridVisible;
    else if (name === 'ortho') {
      this.snap.ortho = !this.snap.ortho;
      if (this.snap.ortho) this.snap.polar = false;
    } else if (name === 'polar') {
      this.snap.polar = !this.snap.polar;
      if (this.snap.polar) this.snap.ortho = false;
    } else this.snap[name] = !this.snap[name];
    const state = name === 'grid' ? this.viewport.settings.gridVisible : this.snap[name];
    this.log(`<${name.toUpperCase()} ${state ? 'on' : 'off'}>`);
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
  newDrawing(): void {
    const fresh = new Drawing();
    this.doc.load(fresh.snapshot, null);
    this.doc.ensureBlocks(ALL_SYMBOLS);
    this.selection.clear();
    this.viewport.zoomToBounds(null);
    this.log('New drawing.');
    this.emit('file');
    this.emit('selection');
    this.render();
  }

  loadState(state: DrawingState, path: string | null): void {
    this.doc.load(state, path);
    this.doc.ensureBlocks(ALL_SYMBOLS);
    this.selection.clear();
    this.zoomExtents();
    this.emit('file');
    this.emit('selection');
  }

  async openFile(): Promise<void> {
    if (!this.fileBridge) {
      this.log('No file access in this environment.');
      return;
    }
    const res = await this.fileBridge.openDxf();
    if (!res) return;
    try {
      const state = readDxf(res.text);
      this.loadState(state, res.path);
      this.log(`Opened ${res.path}: ${state.entities.length} entities, ${state.layers.length} layers, ${Object.keys(state.blocks).length} blocks.`);
    } catch (err) {
      this.log(`Failed to read DXF: ${(err as Error).message}`);
    }
  }

  async saveFile(saveAs: boolean): Promise<void> {
    if (!this.fileBridge) {
      this.log('No file access in this environment.');
      return;
    }
    const text = writeDxf(this.doc.snapshot);
    const path = await this.fileBridge.saveDxf(saveAs ? null : this.doc.filePath, text, this.fileName());
    if (path) {
      this.doc.filePath = path;
      this.doc.dirty = false;
      this.log(`Saved ${path}`);
      this.emit('file');
    }
  }

  fileName(): string {
    if (!this.doc.filePath) return 'Drawing1.dxf';
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
    const aperture = (this.viewport.settings.pickBox + 4) * this.viewport.worldPerPixel();
    const wantSnap = this.tool !== null && !this.selReq;
    const snap = wantSnap
      ? findObjectSnap(raw, this.doc.entities, this.doc.lookupBlock, this.snap, aperture, this.overlay.trackFrom, this.hiddenLayers())
      : null;
    if (snap) return { world: snap.point, snap };
    let p = raw;
    if (this.overlay.trackFrom) p = constrainDirection(this.overlay.trackFrom, p, this.snap);
    p = snapToGrid(p, this.snap);
    return { world: p, snap: null };
  }

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
    if (ev.button === 1) {
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
    const hit = pickEntity(raw, this.doc.entities, this.doc.lookupBlock, this.pickAperture(), this.hiddenLayers(), this.lockedLayers());
    if (hit) {
      this.toggleSelect([hit.id], ev.shiftKey);
      return;
    }
    this.dragStart = s;
    this.dragWorld = raw;
  }

  onMouseUp(ev: MouseEvent): void {
    if (ev.button === 1) {
      this.panning = false;
      return;
    }
    if (ev.button !== 0) return;
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
    if (ev.button === 1) this.zoomExtents();
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
    if (ev.ctrlKey || ev.metaKey) {
      const k = key.toLowerCase();
      if (k === 'z') {
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
  editComponent: async (init) => ({ tag: init.tag, desc: init.desc }),
  ladderSettings: async (init: LadderSettings) => init,
  textInput: async (_t, _l, init) => init,
};
