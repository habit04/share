import type { Entity, BlockDef, Layer, BlockLookup, ColorSpec } from './entities';
import { entityBounds } from './entities';
import type { Bounds, Point } from './geometry';
import { unionBounds } from './geometry';
import type { DimStyle } from './dimension';
import { STANDARD_DIMSTYLE, ordinateDimensionProblem } from './dimension';
import type { Linetype } from './linetypes';
import type { UnitSettings } from './units';
import { DEFAULT_UNITS } from './units';
// Paper-space layouts (Track E): the layout model and the paper-space entity projection.
import type { Layout, SpaceRef } from './layouts';
import { applyPaperEntities, layoutsOf, paperEntities, paperSpaceLayout, sheetBounds, withLayout } from './layouts';
import { prepareDrawingState as prepareGeometryState, validateGeometryBudget } from './geometry-budget';
import { sealImmutableData } from './immutable-data';
import { textStylesOf, type TextStyle } from '../io/encoding';
import { textGeometryForStyles, EMPTY_TEXT_STYLES } from '../render/font-metrics';
import type { TextGeometryContext } from './text-metrics';
import type { NativeViewCamera } from './named-view';
import { reconcileCadGraph, validateCadState, type CadGraph, type CadGraphEditIntent } from './cad-graph';
import type { ConstraintSet } from './constraints/model';
import type { UnderlayDefinition } from './underlay';
import { enforceConstraintPolicy } from './constraints/policy';

import type { Model3D } from '../model3d/types';
import { model3dOf, withModel3D } from '../model3d/model';
import { validateModel3DState } from '../model3d/state-validation';

function validateDrawingProperties(state: DrawingState, previous?: DrawingState): void {
  validateModel3DState(state);
  validateCadState(state);
  const unchanged = previous ? new Set([previous.entities, ...Object.values(previous.blocks).map((b) => b.entities), ...(previous.layouts ?? []).map((l) => l.entities)]) : undefined;
  for (const list of [state.entities, ...Object.values(state.blocks).map((b) => b.entities), ...(state.layouts ?? []).map((l) => l.entities)]) {
    if (unchanged?.has(list)) continue;
    for (const entity of list) if (entity.type === 'dimension' && entity.kind === 'ordinate') {
      const problem = ordinateDimensionProblem(entity);
      if (problem) throw new Error(problem);
    }
  }
}

/** Pure complete validation for restored states: no history, sealing or UI mutation. */
export function validateDrawingState(state: DrawingState, previous?: DrawingState): void {
  // Only construction/transactions may trust unchanged properties of an accepted
  // predecessor. Public preflight checks every ordinate even with a prior state.
  validateDrawingProperties(state);
  validateGeometryBudget(state, previous);
}

function prepareDrawingState(state: DrawingState, previous?: DrawingState): DrawingState {
  validateDrawingProperties(state, previous);
  return prepareGeometryState(state, previous);
}

/** Prepare a complete graph-aware transition before any history, UI or file mutation. */
export function prepareDrawingTransition(previous: DrawingState, state: DrawingState, intent?: CadGraphEditIntent): DrawingState {
  return prepareDrawingState(reconcileCadGraph(previous, state, intent), previous);
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
  /**
   * Experimental 3D solids (src/model3d), kept apart from the 2D `entities` so no 2D code path
   * sees them; behind the `experimental3d` setting. Undoable like geometry and checked by the
   * geometry budget. Not written to DXF / DWG yet (saving asks first, see
   * model3d/save-guard.ts); absent for ordinary drawings and removed again when the last solid goes.
   */
  readonly model3d?: Model3D;
  /**
   * Priority 30.3/30.4: the drawing's 2D constraint set (src/core/constraints),
   * kept apart from `entities` like `model3d` so no unsolved code path sees it.
   * Travels with undo history; persisted as the labeled JCad-specific
   * JCAD_CONSTRAINTS payload (src/io/dxf/constraints-data.ts) — NOT native
   * AutoCAD constraint data. Absent = no constraints; ordinary drawings are
   * untouched. Solving is never implicit: only the pure adapter in
   * src/core/constraints/apply.ts runs the solver, outside any transaction.
   */
  readonly constraints?: ConstraintSet;
  /**
   * A JCAD_CONSTRAINTS payload this build could not model (malformed or a
   * newer version), retained verbatim for re-export — the constraint sibling
   * of BlockDef.dynamicRetained. While present, the modeled `constraints`
   * field is absent and constraint edits/solves are refused, never guessed.
   */
  readonly constraintsRetained?: string;
  /**
   * Priority 28: underlay *DEFINITION objects (core/underlay.ts), keyed by
   * definition id — a sibling of `entities`, not part of it (RULING-P28 C2).
   * Placements (UnderlayEntity) join to a definition by
   * placement.definitionHandle === definition.handle in the reader post-pass.
   * Definitions with no placement are retained and written back. Absent =
   * no underlay definitions; ordinary drawings are untouched. Definitions
   * are not entities and carry no entity geometry work (C5). Mutation only
   * through Drawing.transact, like every other state field (C7).
   */
  readonly underlays?: Readonly<Record<string, UnderlayDefinition>>;
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

  constructor(initial?: Partial<DrawingState>, private readonly textGeometryProvider: (styles: Readonly<Record<string, TextStyle>>) => TextGeometryContext = textGeometryForStyles) {
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

  readonly lookupBlock: BlockLookup = Object.defineProperty((name: string) => this.state.blocks[name], 'textGeometry', {
    get: () => this.textGeometryProvider(this.state.meta?.textStyles ? textStylesOf(this.state) : EMPTY_TEXT_STYLES),
  });

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

  /** Apply an active-space state transition as one undoable step. */
  transact(fn: (s: DrawingState) => DrawingState, intent?: CadGraphEditIntent): void {
    this.commitTransition(this.project(fn), intent);
  }

  /** Apply a document-wide transition without projecting the active paper layout. */
  transactDrawing(fn: (s: DrawingState) => DrawingState, intent?: CadGraphEditIntent): void {
    this.commitTransition(fn(this.state), intent);
  }

  /** Shared preparation, bounded undo history and dirty notification for both transaction scopes. */
  private commitTransition(state: DrawingState, intent?: CadGraphEditIntent): void {
    // Priority 30 review §3: the geometry-edit constraint policy runs at
    // this choke point (see src/core/constraints/policy.ts for the policy
    // and its stated coverage boundary). It throws ConstraintPolicyError
    // on refusal — before anything is assigned — so a refused edit leaves
    // no history entry, no dirty flag and no revision change.
    const enforced = enforceConstraintPolicy(this.state, state);
    const next = prepareDrawingTransition(this.state, enforced, intent);
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
    const list = applyDefaults ? this.withEntityDefaults(entities) : entities;
    this.transact((s) => ({ ...s, entities: [...s.entities, ...list] }), intent);
  }

  /**
   * The defaults `addEntities` gives new objects: the current linetype / lineweight (CELTYPE /
   * CELWEIGHT) unless an object already carries one, and the current colour (CECOLOR) for objects
   * created ByLayer. Returns the input array itself when no default applies. Used by edits that add
   * objects in a larger single step (experimental 3D: COPY / MIRROR of mixed selections).
   */
  withEntityDefaults(entities: readonly Entity[]): readonly Entity[] {
    const h = this.header;
    const wantLt = h.celtype && h.celtype.toUpperCase() !== 'BYLAYER';
    const wantLw = h.celweight !== undefined;
    const wantColor = this.currentColor !== 'ByLayer';
    if (!(wantLt || wantLw || wantColor)) return entities;
    return entities.map((e) => {
      let out: Entity = e;
      if (wantLt && e.linetype === undefined) out = { ...out, linetype: h.celtype } as Entity;
      if (wantLw && e.lineWeight === undefined) out = { ...out, lineWeight: h.celweight } as Entity;
      if (wantColor && e.color === 'ByLayer') out = { ...out, color: this.currentColor } as Entity;
      return out;
    });
  }

  /**
   * Experimental 3D: change the drawing's 3D model (`DrawingState.model3d`) as one undoable step,
   * exactly like a 2D edit (new state, drawing marked modified, listeners notified). `fn` gets the
   * current model (the empty model when the drawing has none) and returns the new one; returning
   * it unchanged records nothing. `removeEntityIds` removes 2D entities in the same step (EXTRUDE
   * / REVOLVE with Delete, ERASE of a mixed selection). Budget errors from `prepareDrawingState`
   * propagate and leave the document unchanged.
   */
  updateModel3D(fn: (model: Model3D) => Model3D, removeEntityIds?: Iterable<string>, intent?: CadGraphEditIntent): void {
    const drop = new Set(removeEntityIds ?? []);
    this.transact((s) => {
      const entities = drop.size ? s.entities.filter((e) => !drop.has(e.id)) : s.entities;
      const base = entities.length === s.entities.length ? s : { ...s, entities };
      return withModel3D(base, fn(model3dOf(s)));
    }, intent);
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
