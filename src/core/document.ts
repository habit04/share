import type { Entity, BlockDef, Layer, BlockLookup, ColorSpec } from './entities';
import { entityBounds } from './entities';
import type { Bounds, Point } from './geometry';
import { unionBounds } from './geometry';
import type { DimStyle } from './dimension';
import { STANDARD_DIMSTYLE } from './dimension';
import type { Linetype } from './linetypes';
import type { UnitSettings } from './units';
import { DEFAULT_UNITS } from './units';
// Paper-space layouts (Track E): the layout model and the paper-space entity projection.
import type { Layout, SpaceRef } from './layouts';
import { applyPaperEntities, layoutsOf, paperEntities, paperSpaceLayout, sheetBounds, withLayout } from './layouts';
import { prepareDrawingState as prepareGeometryState } from './geometry-budget';
import { sealImmutableData } from './immutable-data';
import type { NativeViewCamera } from './named-view';
import { reconcileCadGraph, validateCadState, type CadGraph, type CadGraphEditIntent } from './cad-graph';

function prepareDrawingState(state: DrawingState, previous?: DrawingState): DrawingState {
  validateCadState(state);
  return prepareGeometryState(state, previous);
}

/** A named view (VIEW command): world centre and view height. */
export interface NamedView {
  readonly name: string;
  readonly center: Point;
  /** Visible height in drawing units. */
  readonly height: number;
  /** Width and rotation of the view, independent of model geometry. */
  readonly width?: number;
  readonly twist?: number;
  /** Complete native 3D camera; unsupported projections are retained for interchange. */
  readonly camera?: NativeViewCamera;
}

/** Drawing-wide settings that AutoCAD keeps as header variables. */
export interface DrawingHeader {
  readonly units: UnitSettings;
  /** $LTSCALE */
  readonly ltscale: number;
  /** $LIMMIN / $LIMMAX */
  readonly limits: Bounds;
  /** $PDMODE / $PDSIZE for POINT entities. */
  readonly pdmode: number;
  readonly pdsize: number;
  /** Current dimension style (the values new dimensions get). */
  readonly dimStyle: DimStyle;
  /** Linetypes loaded in the drawing beyond the standard set (DXF LTYPE table). */
  readonly linetypes: readonly Linetype[];
  readonly views: readonly NamedView[];
  /** $CELTYPE / $CELWEIGHT: properties given to new entities ('ByLayer' / undefined = inherit). */
  readonly celtype: string;
  readonly celweight?: number;
  /** Preserved source $CELTSCALE: current entity linetype scale; absent = 1 on export. */
  readonly celtscale?: number;
  /** Preserved source $TEXTSTYLE: current named text style; absent = Standard on export. */
  readonly textStyle?: string;
  /** $CANNOSCALE: annotation scale name ("1:4"); annotative objects show at 1 / scale in model space. */
  readonly cannoscale?: string;
  /** $ANNOALLVISIBLE (default on): off hides annotative objects in viewports whose scale is not CANNOSCALE. */
  readonly annoAllVisible?: boolean;
}

export const DEFAULT_HEADER: DrawingHeader = {
  units: DEFAULT_UNITS,
  ltscale: 1,
  limits: { min: { x: 0, y: 0 }, max: { x: 12, y: 9 } },
  pdmode: 0,
  pdsize: 0,
  dimStyle: STANDARD_DIMSTYLE,
  linetypes: [],
  views: [],
  celtype: 'ByLayer',
};

export interface DrawingState {
  readonly entities: readonly Entity[];
  readonly layers: readonly Layer[];
  readonly blocks: Readonly<Record<string, BlockDef>>;
  readonly currentLayer: string;
  /** Optional so states built elsewhere (templates, converters) stay valid; defaults apply when absent. */
  readonly header?: DrawingHeader;
  /**
   * Application data that belongs to the document and travels with its undo history
   * (the Symbol Builder keeps the symbol's name / family / kind here so Ctrl+Z restores
   * them like geometry). Not written to DXF; absent for ordinary drawings.
   */
  readonly meta?: Readonly<Record<string, unknown>>;
  /** Native CAD metadata and typed references, shared with geometry in undo/redo snapshots. */
  readonly cadGraph?: CadGraph;
  /** Paper-space layouts (see core/layouts.ts); absent = the implicit Layout1. */
  readonly layouts?: readonly Layout[];
  /** Active space (CTAB / MSPACE): absent = the Model tab. */
  readonly space?: SpaceRef;
}

export type DocListener = (doc: Drawing) => void;

/**
 * A document's undo / redo history: whole states, oldest first (the next undo restores the last
 * entry of `undo`, the next redo the last entry of `redo`). States are immutable and shared.
 */
export interface DrawingHistory {
  readonly undo: readonly DrawingState[];
  readonly redo: readonly DrawingState[];
}

export const DEFAULT_LAYERS: Layer[] = [
  { name: '0', color: 7, visible: true, locked: false, lineWeight: 0.25 },
  { name: 'WIRES', color: 1, visible: true, locked: false, lineWeight: 0.35 },
  { name: 'WIRENO', color: 3, visible: true, locked: false, lineWeight: 0.25 },
  { name: 'SYMS', color: 4, visible: true, locked: false, lineWeight: 0.25 },
  { name: 'TAGS', color: 4, visible: true, locked: false, lineWeight: 0.25 },
  { name: 'DESC', color: 7, visible: true, locked: false, lineWeight: 0.25 },
  { name: 'TERMS', color: 7, visible: true, locked: false, lineWeight: 0.25 },
  { name: 'LADDER', color: 8, visible: true, locked: false, lineWeight: 0.25 },
  { name: 'MISC', color: 7, visible: true, locked: false, lineWeight: 0.25 },
];

/**
 * The drawing document. State is immutable; every mutation produces a new
 * state object and pushes the previous one onto the undo stack.
 */
export class Drawing {
  private state: DrawingState;
  private undoStack: DrawingState[] = [];
  private redoStack: DrawingState[] = [];
  private listeners = new Set<DocListener>();
  private readonly maxUndo = 200;
  private mutationRevision = 0;
  /** Monotonic across edits, undo, redo and loads, even when the same snapshot returns. */
  get revision(): number { return this.mutationRevision; }
  public filePath: string | null = null;
  public dirty = false;
  /** Current colour for new objects (CECOLOR; Home > Properties colour combo). 'ByLayer' leaves new objects alone. */
  public currentColor: ColorSpec = 'ByLayer';

  constructor(initial?: Partial<DrawingState>) {
    // Every supplied field is kept (header, space, meta, layouts and anything added later);
    // only the four required ones get defaults.
    const { entities, layers, blocks, currentLayer, ...rest } = initial ?? {};
    const optional = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as Partial<DrawingState>;
    this.state = prepareDrawingState({
      ...optional,
      entities: entities ?? [],
      layers: layers ?? DEFAULT_LAYERS.map((l) => ({ ...l })),
      blocks: blocks ?? {},
      currentLayer: currentLayer ?? '0',
    });
  }

  /**
   * Settings outside the undo history (header variables, current layer, active space, layout
   * view changes, library blocks): the change is applied to the current state AND to every state
   * waiting on the undo / redo stacks, so a later Undo or Redo of a geometry edit neither reverts
   * nor re-applies it. `fn` must be safe on any of those states (return the state unchanged when
   * it does not apply).
   */
  private outsideHistory(fn: (s: DrawingState) => DrawingState, current = fn(this.state)): void {
    const next = prepareDrawingState(reconcileCadGraph(this.state, current), this.state);
    const undo = this.undoStack.map((s) => prepareDrawingState(reconcileCadGraph(s, fn(s)), s));
    const redo = this.redoStack.map((s) => prepareDrawingState(reconcileCadGraph(s, fn(s)), s));
    // A failure in any history entry must leave the complete document untouched.
    this.state = next;
    this.undoStack = undo;
    this.redoStack = redo;
  }

  /** The entities being edited: model space, or the paper space of the active layout (layouts.ts paperEntities). */
  get entities(): readonly Entity[] {
    const lay = paperSpaceLayout(this.state);
    return lay ? sealImmutableData(paperEntities(lay)) : this.state.entities;
  }
  /** All layouts (the implicit Layout1 when the drawing has none). */
  get layouts(): readonly Layout[] {
    return sealImmutableData(layoutsOf(this.state));
  }
  /** Active space: undefined = Model tab. */
  get space(): SpaceRef | undefined {
    return this.state.space;
  }
  /**
   * Switch space (Model / layout / floating viewport). Not undoable, like the layout tabs: the
   * active space survives Undo / Redo (states in which the layout or viewport does not exist
   * fall back to its paper space or to the Model tab).
   */
  setSpace(space: SpaceRef | undefined, patch?: (s: DrawingState) => DrawingState): void {
    const apply = (s: DrawingState): DrawingState => {
      const { space: _old, ...rest } = patch ? patch(s) : s;
      if (!space) return rest;
      const lay = layoutsOf(rest).find((l) => l.name === space.layout);
      if (!lay) return rest;
      if (space.viewport && !lay.viewports.some((v) => v.id === space.viewport)) return { ...rest, space: { layout: space.layout } };
      return { ...rest, space };
    };
    const { space: _cur, ...rest } = this.state;
    // The current state takes the space as asked (the layout may be the implicit Layout1).
    let next: DrawingState = space ? { ...rest, space } : rest;
    if (patch) next = patch(sealImmutableData(next));
    this.outsideHistory(apply, next);
    this.emit();
  }
  /**
   * Change layout data without an undo step (viewport zoom / pan, layout initialisation). Like
   * every setting outside the history it survives Undo / Redo: `fn` is applied to the states on
   * the undo / redo stacks too, so it must leave a state alone when it does not apply to it.
   */
  patchQuiet(fn: (s: DrawingState) => DrawingState, markDirty = true): void {
    const next = fn(this.state);
    if (next === this.state) return;
    this.outsideHistory(fn, next);
    this.mutationRevision += 1;
    if (markDirty) this.dirty = true;
  }
  get layers(): readonly Layer[] {
    return this.state.layers;
  }
  get blocks(): Readonly<Record<string, BlockDef>> {
    return this.state.blocks;
  }
  get currentLayer(): string {
    return this.state.currentLayer;
  }
  get snapshot(): DrawingState {
    return this.state;
  }
  get header(): DrawingHeader {
    return this.state.header ?? sealImmutableData(DEFAULT_HEADER);
  }

  /**
   * Change header variables (UNITS, LIMITS, LTSCALE, DIMSTYLE, VIEW ...). Not undoable, like
   * AutoCAD system variables, and outside the history: Undo / Redo of other edits keep the
   * patched values (header changes made inside a `transact` stay undoable as part of that step).
   */
  setHeader(patch: Partial<DrawingHeader>): void {
    this.outsideHistory((s) => ({ ...s, header: { ...(s.header ?? DEFAULT_HEADER), ...patch } }));
    this.dirty = true;
    this.emit();
  }

  readonly lookupBlock: BlockLookup = (name) => this.state.blocks[name];

  layer(name: string): Layer | undefined {
    return this.state.layers.find((l) => l.name === name);
  }

  entity(id: string): Entity | undefined {
    return this.entities.find((e) => e.id === id);
  }

  subscribe(fn: DocListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.mutationRevision += 1;
    for (const l of this.listeners) l(this);
  }

  /** Apply a state transition as one undoable step. */
  transact(fn: (s: DrawingState) => DrawingState, intent?: CadGraphEditIntent): void {
    const next = prepareDrawingState(reconcileCadGraph(this.state, this.project(fn), intent), this.state);
    if (next === this.state) return;
    this.undoStack.push(this.state);
    if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
    this.redoStack = [];
    this.state = next;
    this.dirty = true;
    this.emit();
  }

  /**
   * Run a transition; in paper space the function sees the layout's paper entities as
   * `entities` and its result is folded back into the layout (model space stays untouched).
   */
  private project(fn: (s: DrawingState) => DrawingState): DrawingState {
    const cur = this.state;
    const lay = paperSpaceLayout(cur);
    if (!lay) return fn(cur);
    const view = sealImmutableData({ ...cur, entities: paperEntities(lay) });
    const out = fn(view);
    if (out === view) return cur;
    const base: DrawingState = { ...out, entities: cur.entities };
    if (out.entities === view.entities) return base;
    const target = layoutsOf(base).find((l) => l.name === lay.name) ?? lay;
    return withLayout(base, applyPaperEntities(target, out.entities));
  }

  /** Replace the whole document without recording history (open / new). */
  /** Incremented by every `load` (open / new / tab switch), so views kept per document can be reset. */
  loadCount = 0;

  load(state: DrawingState, filePath: string | null = null): void {
    const next = prepareDrawingState(state);
    this.loadCount += 1;
    this.state = next;
    this.undoStack = [];
    this.redoStack = [];
    this.filePath = filePath;
    this.dirty = false;
    this.emit();
  }

  /** How many undo steps are kept (older ones are dropped). */
  get undoLimit(): number {
    return this.maxUndo;
  }

  /** A copy of the undo / redo history (drawing tabs park it while another tab is active). */
  history(): DrawingHistory {
    return { undo: [...this.undoStack], redo: [...this.redoStack] };
  }

  /**
   * Replace the undo / redo history, typically right after `load` when a parked drawing tab
   * becomes active again. Neither the current state nor the dirty flag changes.
   */
  restoreHistory(history: DrawingHistory): void {
    const undo = history.undo.map((state) => prepareDrawingState(state));
    const redo = history.redo.map((state) => prepareDrawingState(state));
    this.undoStack = undo;
    this.redoStack = redo;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): boolean {
    const prev = this.undoStack[this.undoStack.length - 1];
    if (!prev) return false;
    prepareDrawingState(prev);
    this.undoStack.pop();
    this.redoStack.push(this.state);
    this.state = prev;
    this.dirty = true;
    this.emit();
    return true;
  }

  redo(): boolean {
    const next = this.redoStack[this.redoStack.length - 1];
    if (!next) return false;
    prepareDrawingState(next);
    this.redoStack.pop();
    this.undoStack.push(this.state);
    this.state = next;
    this.dirty = true;
    this.emit();
    return true;
  }

  // ---- convenience mutations -------------------------------------------

  /**
   * Add entities as one undo step. New objects pick up the current entity
   * linetype / lineweight (CELTYPE / CELWEIGHT) unless they already carry one,
   * and the current colour (CECOLOR) when they were created ByLayer;
   * pass `applyDefaults = false` for copies that must keep their own properties.
   */
  addEntities(entities: readonly Entity[], applyDefaults = true, intent?: CadGraphEditIntent): void {
    if (entities.length === 0) return;
    const h = this.header;
    const wantLt = applyDefaults && h.celtype && h.celtype.toUpperCase() !== 'BYLAYER';
    const wantLw = applyDefaults && h.celweight !== undefined;
    const wantColor = applyDefaults && this.currentColor !== 'ByLayer';
    const list = wantLt || wantLw || wantColor
      ? entities.map((e) => {
          let out: Entity = e;
          if (wantLt && e.linetype === undefined) out = { ...out, linetype: h.celtype } as Entity;
          if (wantLw && e.lineWeight === undefined) out = { ...out, lineWeight: h.celweight } as Entity;
          if (wantColor && e.color === 'ByLayer') out = { ...out, color: this.currentColor } as Entity;
          return out;
        })
      : entities;
    this.transact((s) => ({ ...s, entities: [...s.entities, ...list] }), intent);
  }

  /** Remove some entities and add others in a single undo step. */
  replaceWith(removeIds: Iterable<string>, add: readonly Entity[], intent?: CadGraphEditIntent): void {
    const set = new Set(removeIds);
    this.transact((s) => ({ ...s, entities: [...s.entities.filter((e) => !set.has(e.id)), ...add] }), intent);
  }

  removeEntities(ids: Iterable<string>): void {
    const set = new Set(ids);
    if (set.size === 0) return;
    this.transact((s) => {
      const entities = s.entities.filter((e) => !set.has(e.id));
      return entities.length === s.entities.length ? s : { ...s, entities };
    });
  }

  /** Replace entities by id (used by move/rotate/edit). */
  replaceEntities(replacements: readonly Entity[], intent?: CadGraphEditIntent): void {
    if (replacements.length === 0) return;
    const map = new Map(replacements.map((e) => [e.id, e]));
    this.transact((s) => {
      let changed = false;
      const entities = s.entities.map((e) => {
        const r = map.get(e.id);
        if (r && r !== e) {
          changed = true;
          return r;
        }
        return e;
      });
      return changed ? { ...s, entities } : s;
    }, intent);
  }

  setCurrentLayer(name: string): void {
    if (!this.layer(name) || name === this.state.currentLayer) return;
    // Not undoable (CLAYER is a setting): Undo / Redo keep it, except in states where the layer
    // does not exist (an undone LAYER New), which keep their own current layer.
    this.outsideHistory((s) => (s.currentLayer !== name && s.layers.some((l) => l.name === name) ? { ...s, currentLayer: name } : s));
    this.emit();
  }

  addLayer(layer: Layer): void {
    if (this.layer(layer.name)) return;
    this.transact((s) => ({ ...s, layers: [...s.layers, layer] }));
  }

  updateLayer(name: string, patch: Partial<Layer>): void {
    this.transact((s) => ({
      ...s,
      layers: s.layers.map((l) => (l.name === name ? { ...l, ...patch, name: l.name } : l)),
    }));
  }

  defineBlock(block: BlockDef): void {
    this.transact((s) => ({ ...s, blocks: { ...s.blocks, [block.name]: block } }));
  }

  removeBlocks(names: Iterable<string>): void {
    const set = new Set(names);
    if (set.size === 0) return;
    this.transact((s) => {
      const blocks: Record<string, BlockDef> = {};
      for (const [k, v] of Object.entries(s.blocks)) if (!set.has(k)) blocks[k] = v;
      return { ...s, blocks };
    });
  }

  removeLayers(names: Iterable<string>): void {
    const set = new Set(names);
    set.delete('0');
    set.delete(this.state.currentLayer);
    if (set.size === 0) return;
    this.transact((s) => ({ ...s, layers: s.layers.filter((l) => !set.has(l.name)) }));
  }

  /**
   * Ensure blocks exist without creating undo entries (used by symbol library). Outside the
   * history: an Undo never takes a library block away from a state that lacked it.
   */
  ensureBlocks(blocks: readonly BlockDef[]): void {
    const missing = blocks.filter((b) => !this.state.blocks[b.name]);
    if (missing.length === 0) return;
    this.outsideHistory((s) => {
      const add = missing.filter((b) => !s.blocks[b.name]);
      if (add.length === 0) return s;
      const next = { ...s.blocks };
      for (const b of add) next[b.name] = b;
      return { ...s, blocks: next };
    });
    this.emit();
  }

  /** Extents of all visible entities. */
  extents(): Bounds | null {
    let b: Bounds | null = null;
    const hidden = new Set(this.state.layers.filter((l) => !l.visible).map((l) => l.name));
    for (const e of this.entities) {
      if (hidden.has(e.layer)) continue;
      b = unionBounds(b, entityBounds(e, this.lookupBlock));
    }
    // Paper space: the sheet counts as part of the extents (ZOOM Extents shows the whole sheet).
    const lay = paperSpaceLayout(this.state);
    if (lay) b = unionBounds(b, sheetBounds(lay));
    return b;
  }
}
