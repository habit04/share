import type { Entity, BlockDef, Layer, BlockLookup } from './entities';
import { entityBounds } from './entities';
import type { Bounds } from './geometry';
import { unionBounds } from './geometry';

export interface DrawingState {
  readonly entities: readonly Entity[];
  readonly layers: readonly Layer[];
  readonly blocks: Readonly<Record<string, BlockDef>>;
  readonly currentLayer: string;
}

export type DocListener = (doc: Drawing) => void;

export const DEFAULT_LAYERS: Layer[] = [
  { name: '0', color: 7, visible: true, locked: false, lineWeight: 0.25 },
  { name: 'WIRES', color: 1, visible: true, locked: false, lineWeight: 0.35 },
  { name: 'WIRENO', color: 3, visible: true, locked: false, lineWeight: 0.25 },
  { name: 'SYMS', color: 4, visible: true, locked: false, lineWeight: 0.25 },
  { name: 'TAGS', color: 2, visible: true, locked: false, lineWeight: 0.25 },
  { name: 'DESC', color: 6, visible: true, locked: false, lineWeight: 0.25 },
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

  addEntities(entities: readonly Entity[]): void {
    if (entities.length === 0) return;
    this.transact((s) => ({ ...s, entities: [...s.entities, ...entities] }));
  }

  removeEntities(ids: Iterable<string>): void {
    const set = new Set(ids);
    if (set.size === 0) return;
    this.transact((s) => ({ ...s, entities: s.entities.filter((e) => !set.has(e.id)) }));
  }

  /** Replace entities by id (used by move/rotate/edit). */
  replaceEntities(replacements: readonly Entity[]): void {
    if (replacements.length === 0) return;
    const map = new Map(replacements.map((e) => [e.id, e]));
    this.transact((s) => ({ ...s, entities: s.entities.map((e) => map.get(e.id) ?? e) }));
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
