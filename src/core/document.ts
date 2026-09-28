import type { Entity, BlockDef, Layer, BlockLookup } from './entities';
import { entityBounds } from './entities';
import type { Bounds, Point } from './geometry';
import { unionBounds } from './geometry';
import type { DimStyle } from './dimension';
import { STANDARD_DIMSTYLE } from './dimension';
import type { Linetype } from './linetypes';
import type { UnitSettings } from './units';
import { DEFAULT_UNITS } from './units';

/** A named view (VIEW command): world centre and view height. */
export interface NamedView {
  readonly name: string;
  readonly center: Point;
  /** Visible height in drawing units. */
  readonly height: number;
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
}

export type DocListener = (doc: Drawing) => void;

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
  public filePath: string | null = null;
  public dirty = false;

  constructor(initial?: Partial<DrawingState>) {
    this.state = {
      entities: initial?.entities ?? [],
      layers: initial?.layers ?? DEFAULT_LAYERS.map((l) => ({ ...l })),
      blocks: initial?.blocks ?? {},
      currentLayer: initial?.currentLayer ?? '0',
      ...(initial?.meta ? { meta: initial.meta } : {}),
    };
  }

  get entities(): readonly Entity[] {
    return this.state.entities;
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
    return this.state.header ?? DEFAULT_HEADER;
  }

  /** Change header variables (UNITS, LIMITS, LTSCALE, DIMSTYLE, VIEW ...). Not undoable, like AutoCAD system variables. */
  setHeader(patch: Partial<DrawingHeader>): void {
    this.state = { ...this.state, header: { ...this.header, ...patch } };
    this.dirty = true;
    this.emit();
  }

  readonly lookupBlock: BlockLookup = (name) => this.state.blocks[name];

  layer(name: string): Layer | undefined {
    return this.state.layers.find((l) => l.name === name);
  }

  entity(id: string): Entity | undefined {
    return this.state.entities.find((e) => e.id === id);
  }

  subscribe(fn: DocListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const l of this.listeners) l(this);
  }

  /** Apply a state transition as one undoable step. */
  transact(fn: (s: DrawingState) => DrawingState): void {
    const next = fn(this.state);
    if (next === this.state) return;
    this.undoStack.push(this.state);
    if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
    this.redoStack = [];
    this.state = next;
    this.dirty = true;
    this.emit();
  }

  /** Replace the whole document without recording history (open / new). */
  load(state: DrawingState, filePath: string | null = null): void {
    this.state = state;
    this.undoStack = [];
    this.redoStack = [];
    this.filePath = filePath;
    this.dirty = false;
    this.emit();
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(this.state);
    this.state = prev;
    this.dirty = true;
    this.emit();
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.state);
    this.state = next;
    this.dirty = true;
    this.emit();
    return true;
  }

  // ---- convenience mutations -------------------------------------------

  /**
   * Add entities as one undo step. New objects pick up the current entity
   * linetype / lineweight (CELTYPE / CELWEIGHT) unless they already carry one;
   * pass `applyDefaults = false` for copies that must keep their own properties.
   */
  addEntities(entities: readonly Entity[], applyDefaults = true): void {
    if (entities.length === 0) return;
    const h = this.header;
    const wantLt = applyDefaults && h.celtype && h.celtype.toUpperCase() !== 'BYLAYER';
    const wantLw = applyDefaults && h.celweight !== undefined;
    const list = wantLt || wantLw
      ? entities.map((e) => {
          let out: Entity = e;
          if (wantLt && e.linetype === undefined) out = { ...out, linetype: h.celtype } as Entity;
          if (wantLw && e.lineWeight === undefined) out = { ...out, lineWeight: h.celweight } as Entity;
          return out;
        })
      : entities;
    this.transact((s) => ({ ...s, entities: [...s.entities, ...list] }));
  }

  /** Remove some entities and add others in a single undo step. */
  replaceWith(removeIds: Iterable<string>, add: readonly Entity[]): void {
    const set = new Set(removeIds);
    this.transact((s) => ({ ...s, entities: [...s.entities.filter((e) => !set.has(e.id)), ...add] }));
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
  replaceEntities(replacements: readonly Entity[]): void {
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
    });
  }

  setCurrentLayer(name: string): void {
    if (!this.layer(name) || name === this.state.currentLayer) return;
    // Layer change is not undoable in AutoCAD either; record without history.
    this.state = { ...this.state, currentLayer: name };
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

  /** Ensure blocks exist without creating undo entries (used by symbol library). */
  ensureBlocks(blocks: readonly BlockDef[]): void {
    const missing = blocks.filter((b) => !this.state.blocks[b.name]);
    if (missing.length === 0) return;
    const next = { ...this.state.blocks };
    for (const b of missing) next[b.name] = b;
    this.state = { ...this.state, blocks: next };
    this.emit();
  }

  /** Extents of all visible entities. */
  extents(): Bounds | null {
    let b: Bounds | null = null;
    const hidden = new Set(this.state.layers.filter((l) => !l.visible).map((l) => l.name));
    for (const e of this.state.entities) {
      if (hidden.has(e.layer)) continue;
      b = unionBounds(b, entityBounds(e, this.lookupBlock));
    }
    return b;
  }
}
