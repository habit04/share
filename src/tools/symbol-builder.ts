/**
 * Symbol Builder (AESYMBUILDER): edit a schematic symbol in its own file tab
 * and save it to the user symbol library.
 *
 * The controller (`SymbolBuilder`, one per Editor) owns the "symbol session
 * registry": which document sessions are symbol editing sessions, where they
 * were started from and which user symbol they edit. The symbol's metadata
 * (name, family, kind, orientation, attribute defaults) lives in the document
 * state itself (`DrawingState.meta`), so Ctrl+Z restores it like geometry.
 * While a symbol session is active the viewport draws the origin / stub
 * guides through its `underlay` hook, the Symbol Builder palette is shown,
 * the ribbon switches to Schematic and SAVE / SAVEAS write to the user
 * library / a DXF export instead of the drawing file. Everything DOM-related
 * lives in src/ui/symbol-builder.ts and is reached through
 * `editor.hooks.symbolBuilder`.
 */
import type { Editor } from '../app/editor';
import type { Point } from '../core/geometry';
import { roundTo } from '../core/geometry';
import type { BlockDef, Entity, TextEntity } from '../core/entities';
import type { DrawingState } from '../core/document';
import type { Viewport } from '../render/viewport';
import type { Tool, ToolContext } from './types';
import { validBlockName } from './blocks';
import { isBuiltinSymbol, isLibrarySymbol, findLibrarySymbol, LIBRARY_SYMBOLS } from '../electrical/library';
import { userLibrary, symbolToDxf, type UserSymbol } from '../electrical/userlib';
import { NON_COMPONENT_RE, isCoilBlock } from '../electrical/families';
import { tagPrefix } from '../electrical/symbols';
import { showRibbonTab } from '../ui/ribbon';
import {
  blankSymbolState,
  blockToSymbolState,
  harvestBlock,
  fromSelection,
  symbolStateToBlock,
  checkSymbol,
  compilePins,
  markerUpdates,
  placeholderEntity,
  pinMarkerEntity,
  isPlaceholder,
  isPinMarker,
  suggestSymbolName,
  resolveBasePoint,
  wdtypeFor,
  INLINE_HALF,
  defaultMeta,
  metaOf,
  withMeta,
  markerTag,
  markerText,
  markerDefault,
  verticalVariant,
  createTwin,
  applyRenameChoice,
  normalizeSymbolName,
  KNOWN_ATTRIBUTES,
  SYMATTR_LAYER,
  type SymbolMeta,
  type SymbolState,
  type PinDirection,
  type BasePointChoice,
  type CheckMessage,
  type RenameChoice,
  type LegacyPinDefaults,
} from '../electrical/symbol-builder-core';

export type SymbolSource =
  | { kind: 'blank' }
  | { kind: 'library'; name: string }
  | { kind: 'block'; name: string; basePoint: BasePointChoice; scale: boolean }
  | { kind: 'selection'; scale: boolean };

export interface SymbolBuilderStart {
  meta: SymbolMeta;
  source: SymbolSource;
}

export interface StartDialogInit {
  /** Prefilled values (AESYMBUILDER <name>). */
  meta: SymbolMeta;
  /** Blocks of the current drawing that can be harvested (WD_* furniture excluded; `libraryName` marks names of built-in symbols). */
  blocks: Array<{ name: string; description: string; libraryName: boolean }>;
  selectionCount: number;
  suggestName(family: string): string;
}

/** DOM side of the Symbol Builder (src/ui/symbol-builder.ts). */
export interface SymbolBuilderUi {
  start(init: StartDialogInit): Promise<SymbolBuilderStart | null>;
  showPalette(ctl: SymbolBuilder): void;
  hidePalette(): void;
  refreshPalette(): void;
  /** Make the Check results visible (after a failed save). */
  revealCheck?(): void;
  /** Rename / Save as copy / Cancel when an existing symbol is saved under a new name. */
  askRename?(oldName: string, newName: string): Promise<RenameChoice>;
  /** Show check errors in a dialog (failed save from the tab-close prompt). */
  showErrors?(title: string, messages: readonly CheckMessage[]): Promise<void>;
  openTextFile?(accept: string): Promise<{ path: string; text: string } | null>;
}

export interface SymbolSession {
  /** Session id of the drawing the builder was started from (Save and Insert returns there). */
  sourceId: number | null;
  /** Name of the user symbol being edited, null for a new symbol. */
  editing: string | null;
}

const fmt = (p: Point) => `${p.x.toFixed(4)}, ${p.y.toFixed(4)}`;

/** One-point pick with a ghost of the entity that will be placed; `snap` rounds the point to the snap grid. */
export class PlaceEntityTool implements Tool {
  readonly name: string;
  constructor(
    name: string,
    private promptText: string,
    private build: (p: Point) => Entity,
    private done: (p: Point, ctx: ToolContext) => void,
    private snap = false,
  ) {
    this.name = name;
  }
  private at(p: Point, ctx: ToolContext): Point {
    if (!this.snap || !(ctx.snap.gridSize > 0)) return p;
    return { x: roundTo(p.x, ctx.snap.gridSize), y: roundTo(p.y, ctx.snap.gridSize) };
  }
  start(ctx: ToolContext): void {
    ctx.prompt(this.promptText);
  }
  onMove(p: Point, ctx: ToolContext): void {
    const q = this.at(p, ctx);
    ctx.setGhost([this.build(q)]);
    ctx.setDynText([fmt(q)]);
  }
  onPoint(p: Point, ctx: ToolContext): void {
    ctx.setGhost([]);
    this.done(this.at(p, ctx), ctx);
    ctx.finish();
  }
  /** Keywords are not used; typed coordinates are parsed by the editor before reaching a tool. */
  onText(_t: string, _c: ToolContext): void {}
  onEnter(ctx: ToolContext): void {
    ctx.finish();
  }
  onCancel(ctx: ToolContext): void {
    ctx.setGhost([]);
    ctx.finish();
  }
}

/** Shorten a canvas label with an ellipsis so it fits `maxWidth` pixels. */
function fitLabel(ctx: CanvasRenderingContext2D, line: string, maxWidth: number): string {
  if (ctx.measureText(line).width <= maxWidth) return line;
  let s = line;
  while (s.length > 4 && ctx.measureText(`${s}...`).width > maxWidth) s = s.slice(0, -1);
  return `${s.trimEnd()}...`;
}

/** Draw the Symbol Builder guides: origin cross, 0.75 in box, stub guides (horizontal or vertical) and a one-line legend. */
export function drawSymbolGuides(ctx: CanvasRenderingContext2D, vp: Viewport, meta: SymbolMeta): void {
  const s = (x: number, y: number) => vp.toScreen({ x, y });
  const o = s(0, 0);
  const vertical = meta.orientation === 'V';
  ctx.lineWidth = 1;
  // stub guides: where the wire arrives (left / right, or top / bottom for a vertical symbol)
  ctx.strokeStyle = 'rgba(255, 140, 120, 0.75)';
  ctx.setLineDash([6, 5]);
  ctx.beginPath();
  for (const sign of [-1, 1]) {
    const a = vertical ? s(0, sign * INLINE_HALF) : s(sign * INLINE_HALF, 0);
    const b = vertical ? s(0, sign * 1.1) : s(sign * 1.1, 0);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
  // 0.75 x 0.75 box
  ctx.strokeStyle = 'rgba(255, 205, 90, 0.6)';
  ctx.setLineDash([4, 4]);
  const tl = s(-INLINE_HALF, INLINE_HALF);
  const br = s(INLINE_HALF, -INLINE_HALF);
  ctx.strokeRect(Math.round(tl.x) + 0.5, Math.round(tl.y) + 0.5, Math.round(br.x - tl.x), Math.round(br.y - tl.y));
  ctx.setLineDash([]);
  // connection squares at the stub ends
  ctx.strokeStyle = 'rgba(255, 140, 120, 0.95)';
  for (const sign of [-1, 1]) {
    const p = vertical ? s(0, sign * INLINE_HALF) : s(sign * INLINE_HALF, 0);
    ctx.strokeRect(Math.round(p.x) - 4.5, Math.round(p.y) - 4.5, 9, 9);
  }
  // origin cross
  ctx.strokeStyle = 'rgba(120, 200, 255, 0.9)';
  const r = Math.max(8, Math.min(30, 0.12 * vp.scale));
  ctx.beginPath();
  ctx.moveTo(o.x - r, o.y);
  ctx.lineTo(o.x + r, o.y);
  ctx.moveTo(o.x, o.y - r);
  ctx.lineTo(o.x, o.y + r);
  ctx.stroke();
  ctx.font = '11px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255, 205, 90, 0.8)';
  if (vp.scale > 150) {
    ctx.textAlign = 'center';
    if (vertical) {
      ctx.textAlign = 'right';
      ctx.fillText('+0.375', tl.x - 6, tl.y + 4);
      ctx.fillText('-0.375', tl.x - 6, br.y + 4);
    } else {
      ctx.fillText('-0.375', tl.x, br.y + 14);
      ctx.fillText('+0.375', br.x, br.y + 14);
    }
    // The origin label sits outside the box at its top-left corner, off the geometry and the TAG1 placeholder.
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(120, 200, 255, 0.85)';
    ctx.fillText('0,0 = insertion point', tl.x - 6, tl.y - 5);
  }
  // legend (one line of status, one short hint; the palette explains the layers)
  const width = ctx.canvas.width / (window.devicePixelRatio || 1);
  const maxWidth = Math.max(120, width - 12 - 120); // keep clear of the ViewCube at the top right
  const lines = [
    `Symbol Builder: ${meta.name || '(unnamed)'}  -  ${meta.kind}${meta.contact ? ` ${meta.contact}` : ''}, family ${meta.family || '?'}, ${meta.standard}, ${vertical ? 'vertical' : 'horizontal'}`,
    vertical ? 'Wire stubs end at y = ±0.375 on x = 0 (dashed guides); yellow = attribute placeholders, red = pins.' : 'Wire stubs end at x = ±0.375 on y = 0 (dashed guides); yellow = attribute placeholders, red = pins.',
  ];
  ctx.textAlign = 'left';
  let y = 18;
  for (const [i, line] of lines.entries()) {
    ctx.fillStyle = i === 0 ? 'rgba(230, 230, 230, 0.95)' : 'rgba(190, 190, 190, 0.8)';
    ctx.font = i === 0 ? 'bold 12px "Segoe UI", system-ui, sans-serif' : '11px "Segoe UI", system-ui, sans-serif';
    ctx.fillText(fitLabel(ctx, line, maxWidth), 12, y);
    y += 16;
  }
}

const registry = new WeakMap<Editor, SymbolBuilder>();

/** The Symbol Builder controller of an editor (created on first use). */
export function symbolBuilderOf(editor: Editor): SymbolBuilder {
  let sb = registry.get(editor);
  if (!sb) {
    sb = new SymbolBuilder(editor);
    registry.set(editor, sb);
  }
  return sb;
}

/** Whether a parent / coil symbol of a family exists (built-in library or user library). */
export function hasParentSymbol(family: string): boolean {
  const fam = family.toUpperCase();
  if (userLibrary.all().some((s) => s.family === fam && s.wdtype === 'COIL')) return true;
  return LIBRARY_SYMBOLS.some((s) => isCoilBlock(s.name) && tagPrefix(s.name) === fam);
}

export class SymbolBuilder {
  /** Session id -> symbol session. */
  readonly sessions = new Map<number, SymbolSession>();
  private activeId: number | null = null;
  private savedGrid: { grid: number; snap: number } | null = null;
  /** The start dialog while it is open (AESYMBUILDER again focuses it instead of stacking a second one). */
  private pendingStart: Promise<SymbolBuilderStart | null> | null = null;
  /** Result of the last check (palette badge / Save tooltip). */
  lastCheck: CheckMessage[] = [];

  constructor(private editor: Editor) {
    editor.on('file', () => this.syncActive());
    editor.on('change', () => {
      if (this.activeId === null) return;
      this.renumberMarkers();
      this.syncTitle();
      editor.hooks.symbolBuilder?.refreshPalette();
    });
    userLibrary.onChange(() => {
      if (this.activeId !== null) editor.hooks.symbolBuilder?.refreshPalette();
    });
    // Options / DSETTINGS re-apply the grid spacing; keep the fine symbol grid while a symbol tab is active.
    editor.on('snap', () => {
      if (this.activeId === null) return;
      this.savedGrid = { grid: editor.settings.gridSpacing, snap: editor.settings.snapSpacing };
      editor.viewport.settings.gridSize = 0.125;
      editor.snap.gridSize = 0.0625;
    });
  }

  // ------------------------------------------------------------- registry
  private sessionIdAt(index: number): number | null {
    return this.editor.sessions.all[index]?.id ?? null;
  }
  isSymbolSession(index: number): boolean {
    const id = this.sessionIdAt(index);
    return id !== null && this.sessions.has(id);
  }
  /** The symbol session of the active tab, or null for a normal drawing. */
  active(): SymbolSession | null {
    return this.activeId === null ? null : (this.sessions.get(this.activeId) ?? null);
  }
  /** Meta of the active symbol tab (read from the document state, so it follows undo / redo). */
  get meta(): SymbolMeta | null {
    if (this.activeId === null || !this.sessions.has(this.activeId)) return null;
    return metaOf(this.editor.doc.snapshot);
  }
  /** Meta of any symbol session (by session id). */
  metaOfSession(id: number): SymbolMeta | null {
    if (!this.sessions.has(id)) return null;
    if (id === this.activeId) return metaOf(this.editor.doc.snapshot);
    const s = this.editor.sessions.all.find((x) => x.id === id);
    return s ? metaOf(s.state) : null;
  }
  /** Session id of the tab that edits a user symbol / carries a symbol name. */
  sessionFor(name: string): number | null {
    const n = name.toUpperCase();
    for (const [id, s] of this.sessions) if (s.editing === n) return id;
    for (const id of this.sessions.keys()) if (this.metaOfSession(id)?.name === n) return id;
    return null;
  }

  /** Re-evaluate which tab is active: prune closed sessions, toggle guides / palette / fine grid / ribbon tab. */
  private syncActive(): void {
    const ed = this.editor;
    const live = new Set(ed.sessions.all.map((s) => s.id));
    for (const id of [...this.sessions.keys()]) if (!live.has(id)) this.sessions.delete(id);
    const id = this.sessionIdAt(ed.sessions.active);
    const next = id !== null && this.sessions.has(id) ? id : null;
    const was = this.activeId;
    this.activeId = next;
    const ui = ed.hooks.symbolBuilder;
    // A pick that was running in the previous tab must not land in this one.
    if (was !== next && ed.tool) ed.cancel();
    if (next !== null) {
      ed.viewport.underlay = (ctx, vp) => {
        const meta = this.meta;
        if (meta) drawSymbolGuides(ctx, vp, meta);
      };
      if (was === null) {
        this.savedGrid = { grid: ed.viewport.settings.gridSize, snap: ed.snap.gridSize };
        ed.viewport.settings.gridSize = 0.125;
        ed.snap.gridSize = 0.0625;
      }
      if (was !== next) showRibbonTab('Schematic');
      this.syncTitle();
      ui?.showPalette(this);
      ui?.refreshPalette();
    } else {
      ed.viewport.underlay = null;
      if (was !== null && this.savedGrid) {
        ed.viewport.settings.gridSize = this.savedGrid.grid;
        ed.snap.gridSize = this.savedGrid.snap;
        this.savedGrid = null;
      }
      ui?.hidePalette();
    }
    if (was !== next) ed.render();
  }

  /** Keep the tab title in step with the (undoable) name. */
  private syncTitle(): void {
    const meta = this.meta;
    if (!meta) return;
    const s = this.editor.sessions.current;
    const title = `Symbol: ${meta.name}`;
    if (s.untitledName !== title) {
      s.untitledName = title;
      this.editor.notify('file');
    }
  }

  /**
   * Rewrite pin marker labels that disagree with the compiled pins (after MIRROR,
   * ROTATE, a removed pin ...). The labels are derived data, so they are updated in
   * place without an undo step (both history stacks stay untouched, like
   * app/sessions.ts reaches the history); after an undo the restored state is
   * renumbered again the same way.
   */
  private renumberMarkers(): void {
    const ed = this.editor;
    const meta = this.meta;
    if (!meta) return;
    const updates = markerUpdates(ed.doc.snapshot, compilePins(ed.doc.snapshot, meta));
    if (updates.length === 0) return;
    const map = new Map(updates.map((u) => [u.id, u as Entity]));
    const priv = ed.doc as unknown as { state?: DrawingState };
    if (priv.state && priv.state === ed.doc.snapshot) {
      priv.state = { ...priv.state, entities: priv.state.entities.map((e) => map.get(e.id) ?? e) };
      ed.render();
    } else ed.doc.replaceEntities(updates);
  }

  // ------------------------------------------------------------- start
  /** Blocks of the current drawing worth harvesting: not WD_* furniture, with geometry; names of built-in symbols are flagged. */
  harvestableBlocks(): StartDialogInit['blocks'] {
    return Object.entries(this.editor.doc.blocks)
      .filter(([n, b]) => !n.startsWith('*') && !NON_COMPONENT_RE.test(n) && !/^WD_/.test(n) && b.entities.length > 0 && !userLibrary.has(n))
      .map(([name, b]) => ({ name, description: b.description ?? '', libraryName: isBuiltinSymbol(name) }))
      .sort((a, b) => Number(a.libraryName) - Number(b.libraryName) || a.name.localeCompare(b.name));
  }

  private nameExists(name: string): boolean {
    return isLibrarySymbol(name) || !!this.editor.doc.blocks[name];
  }

  /** AESYMBUILDER [name]: open the start dialog, or edit the named user symbol directly. */
  start(arg?: string): void {
    const ed = this.editor;
    const ui = ed.hooks.symbolBuilder;
    const preset = arg?.trim() ? normalizeSymbolName(arg.trim()) : undefined;
    if (preset && userLibrary.has(preset)) {
      this.editUserSymbol(preset);
      return;
    }
    if (!ui) {
      ed.log('The Symbol Builder dialog is only available in the application UI.');
      return;
    }
    if (this.pendingStart) {
      ed.log('The Symbol Builder dialog is already open.');
      return;
    }
    if (this.active()) {
      ed.log('A symbol is already being edited in this tab; use the Symbol Builder palette.');
      return;
    }
    const std = ed.settings.symbolStandard;
    const init: StartDialogInit = {
      meta: defaultMeta({ name: preset ?? suggestSymbolName('PB', (n) => this.nameExists(n)), standard: std, family: 'PB' }),
      blocks: this.harvestableBlocks(),
      selectionCount: ed.selection.size,
      suggestName: (family) => suggestSymbolName(family, (n) => this.nameExists(n)),
    };
    const p = ui.start(init);
    this.pendingStart = p;
    void p
      .then((r) => {
        if (r) this.openFrom(r);
      })
      .finally(() => {
        if (this.pendingStart === p) this.pendingStart = null;
      });
  }

  /** Build the editing state for the chosen source and open it. */
  openFrom(r: SymbolBuilderStart): void {
    const ed = this.editor;
    const meta = defaultMeta({ ...r.meta, name: normalizeSymbolName(r.meta.name), family: r.meta.family.toUpperCase() });
    switch (r.source.kind) {
      case 'blank':
        this.open({ state: blankSymbolState(meta, true), meta });
        return;
      case 'library': {
        const def = findLibrarySymbol(r.source.name);
        if (!def) {
          ed.log(`Symbol ${r.source.name} not found.`);
          return;
        }
        const sym = blockToSymbolState(def, { ...meta, attrDefaults: undefined as unknown as Record<string, string> });
        const merged = defaultMeta({ ...sym.meta, ...meta, attrDefaults: { ...sym.meta.attrDefaults, ...meta.attrDefaults } });
        this.open({ state: withMeta(sym.state, merged), meta: merged });
        return;
      }
      case 'block': {
        const def = ed.doc.blocks[r.source.name];
        if (!def) {
          ed.log(`Block ${r.source.name} not found in the drawing.`);
          return;
        }
        const basePoint = resolveBasePoint(r.source.basePoint, def.entities, ed.doc.lookupBlock, def.basePoint);
        const sym = harvestBlock(ed.doc.snapshot, r.source.name, { basePoint, scaleToWidth: r.source.scale ? INLINE_HALF * 2 : undefined });
        if (!sym) return;
        ed.log(`Harvested block ${r.source.name}: ${sym.state.entities.length} object(s)${r.source.scale ? ', scaled to 0.75 in wide' : ''}; base point ${fmt(basePoint)}.`);
        const merged = defaultMeta({ ...sym.meta, ...meta, attrDefaults: { ...sym.meta.attrDefaults, ...meta.attrDefaults } });
        this.open({ state: withMeta(sym.state, merged), meta: merged });
        return;
      }
      case 'selection': {
        const ents = ed.entitiesSelected();
        if (ents.length === 0) {
          ed.log('Nothing selected: select the objects that make up the symbol first.');
          return;
        }
        const scale = r.source.scale;
        ed.startTool(
          new PlaceEntityTool(
            'AESYMBUILDER',
            'Specify the base point of the symbol (the wire-connection centre):',
            (p) => ({ id: 'sb-base', layer: '0', color: 1, type: 'circle', center: p, radius: ed.viewport.worldPerPixel() * 6 }),
            (p) => {
              const sym = fromSelection(ents, p, ed.doc.lookupBlock, { scaleToWidth: scale ? INLINE_HALF * 2 : undefined });
              ed.log(`${ents.length} object(s) copied into the symbol${scale ? ', scaled to 0.75 in wide' : ''}.`);
              ed.finishTool();
              this.open({ state: withMeta(sym.state, meta), meta });
            },
          ),
        );
        return;
      }
    }
  }

  /** Open an existing user symbol for editing (switches to its tab when it is already open). */
  editUserSymbol(name: string): boolean {
    const ed = this.editor;
    const existing = this.sessionFor(name);
    if (existing !== null) {
      const idx = ed.sessions.all.findIndex((s) => s.id === existing);
      if (idx >= 0) {
        if (idx !== ed.sessions.active) ed.switchSession(idx);
        ed.log(`${name.toUpperCase()} is already open in this tab.`);
        return true;
      }
    }
    const sym = userLibrary.get(name);
    if (!sym) {
      ed.log(`${name} is not in the user library.`);
      return false;
    }
    const kind = sym.wdtype === 'COIL' ? 'parent' : sym.wdtype === 'CONTACT' ? 'child' : sym.wdtype === 'TERM' ? 'terminal' : sym.wdtype === 'PLC' ? 'plc' : 'standalone';
    const st = blockToSymbolState(sym.block, { standard: sym.standard, category: sym.category, family: sym.family, kind, description: sym.block.description ?? '' });
    this.open(st, sym.block.name, false);
    return true;
  }

  /**
   * Open a symbol editing tab. `legacyPinDefaults` (older sessions kept pin defaults
   * keyed by marker id) are migrated into the marker texts. The tab is never a
   * "pristine" drawing OPEN could reuse: it holds the meta and, for a symbol with no
   * objects at all, starts dirty.
   */
  open(sym: SymbolState, editing: string | null = null, dirty = true, legacyPinDefaults?: LegacyPinDefaults): void {
    const ed = this.editor;
    const sourceId = ed.sessions.current.id;
    let state = withMeta(sym.state, sym.meta);
    if (legacyPinDefaults) {
      state = {
        ...state,
        entities: state.entities.map((e) => (isPinMarker(e) && legacyPinDefaults[e.id] !== undefined ? { ...e, text: markerText(markerTag(e.text), legacyPinDefaults[e.id]!) } : e)),
      };
    }
    const isDirty = dirty || state.entities.length === 0;
    ed.sessions.add(state, null, isDirty);
    const s = ed.sessions.current;
    s.untitledName = `Symbol: ${sym.meta.name}`;
    this.sessions.set(s.id, { sourceId, editing: editing ? editing.toUpperCase() : null });
    ed.doc.dirty = isDirty;
    ed.doc.setCurrentLayer('0');
    ed.viewport.zoomToBounds({ min: { x: -1.2, y: -0.9 }, max: { x: 1.2, y: 0.9 } }, 0.05);
    this.syncActive();
    this.renumberMarkers();
    ed.notify('file');
    ed.log(`Symbol Builder: editing ${sym.meta.name}${editing ? ` (user library)` : ''}. Draw the geometry around the origin; place TAG1 / DESC1 and pins from the palette; Save to Library when done.`);
  }

  // ------------------------------------------------------------- editing
  /** Change symbol meta (palette fields) as an undoable step. Renames the tab when the name changes. */
  updateMeta(patch: Partial<SymbolMeta>): void {
    const ed = this.editor;
    const cur = this.meta;
    if (!cur) return;
    const next: SymbolMeta = defaultMeta({ ...cur, ...patch, attrDefaults: patch.attrDefaults ?? cur.attrDefaults });
    next.name = normalizeSymbolName(next.name.trim());
    next.family = next.family.trim().toUpperCase();
    if (next.kind === 'child' || next.kind === 'standalone') {
      if (next.kind === 'child') next.contact = next.contact ?? 'NO';
      if (next.contact && (patch.contact || (patch.kind === 'child' && !/_N[OC]$/.test(next.name)))) next.name = next.name.replace(/_N[OC]$/, '') + `_${next.contact}`;
    } else delete next.contact;
    ed.doc.transact((s) => withMeta(s, next));
    this.syncTitle();
    ed.render();
  }

  /** Set the default value of an attribute (visible or invisible). */
  setAttrDefault(tag: string, value: string): void {
    const cur = this.meta;
    if (!cur) return;
    const t = tag.trim().toUpperCase();
    if (!t) return;
    const attrDefaults = { ...cur.attrDefaults };
    if (value.trim() === '' && !(t in attrDefaults)) return;
    if (value.trim() === '' && KNOWN_ATTRIBUTES.has(t)) delete attrDefaults[t];
    else attrDefaults[t] = value.trim();
    this.updateMeta({ attrDefaults });
  }

  /** Set the default pin number of an explicit marker (stored in its text: X1TERM01=13). */
  setPinDefault(markerId: string, value: string): void {
    const m = this.editor.doc.entity(markerId);
    if (!m || !isPinMarker(m)) return;
    const next = markerText(markerTag(m.text), value);
    if (next !== m.text) this.editor.doc.replaceEntities([{ ...m, text: next }]);
  }

  /** Attribute placeholders currently in the document. */
  placeholders(): TextEntity[] {
    return this.editor.doc.entities.filter(isPlaceholder);
  }
  pinMarkers(): TextEntity[] {
    return this.editor.doc.entities.filter(isPinMarker);
  }
  pins() {
    const meta = this.meta;
    return meta ? compilePins(this.editor.doc.snapshot, meta) : [];
  }

  /** Place (or move) an attribute placeholder with a point pick (snapped to the symbol grid). */
  placeAttribute(tag: string): void {
    const ed = this.editor;
    const orientation = this.meta?.orientation ?? 'H';
    const existing = this.placeholders().find((t) => t.text.trim().toUpperCase() === tag);
    const ghost = (p: Point): Entity => (existing ? { ...existing, position: p } : placeholderEntity(tag, p, undefined, orientation));
    ed.startTool(
      new PlaceEntityTool(
        'AESYMATTR',
        `Specify position of the ${tag} attribute:`,
        ghost,
        (p) => {
          if (existing) ed.doc.replaceEntities([{ ...existing, position: p }]);
          else ed.doc.addEntities([placeholderEntity(tag, p, undefined, orientation)], false);
          ed.log(`${tag} placed at ${fmt(p)}.`);
        },
        true,
      ),
    );
  }

  /** Add an attribute placeholder at its default position (for the symbol's orientation) without picking. */
  addAttribute(tag: string): void {
    if (this.placeholders().some((t) => t.text.trim().toUpperCase() === tag)) return;
    this.editor.doc.addEntities([placeholderEntity(tag, undefined, undefined, this.meta?.orientation ?? 'H')], false);
  }

  removeEntity(id: string): void {
    this.editor.doc.removeEntities([id]);
  }

  /** Add an explicit pin marker with a point pick (snapped to the symbol grid); its label is renumbered on placement. */
  addPin(dir: PinDirection, pinDefault = ''): void {
    const ed = this.editor;
    if (!this.meta) return;
    const index = this.pins().length + 1;
    ed.startTool(
      new PlaceEntityTool(
        'AESYMPIN',
        `Specify the wire connection point (${['', 'left', 'top', '', 'right', '', '', '', 'bottom'][dir]}):`,
        (p) => pinMarkerEntity(dir, p, index, pinDefault),
        (p) => {
          const m = pinMarkerEntity(dir, p, index, pinDefault);
          ed.doc.addEntities([m], false);
          const placed = this.pins().find((x) => x.markerId === m.id);
          ed.log(`Pin ${placed?.tag ?? markerTag(m.text)} placed at ${fmt(p)}${pinDefault ? ` (default ${pinDefault})` : ''}.`);
        },
        true,
      ),
    );
  }

  /**
   * Turn the selected plain text objects into attribute placeholders (layer SYMATTR,
   * text = tag): the ACADE reflex after harvesting a vendor block whose "TAG1" /
   * "DESC1" are plain text. Returns the number converted.
   */
  convertSelectedText(): number {
    const ed = this.editor;
    if (!this.meta) return 0;
    const texts = ed.entitiesSelected().filter((e): e is TextEntity => e.type === 'text' && e.layer !== SYMATTR_LAYER);
    if (texts.length === 0) {
      ed.log('Select the text object(s) to convert first (e.g. a vendor "TAG1" text).');
      return 0;
    }
    const placed = new Set(this.placeholders().map((t) => t.text.trim().toUpperCase()));
    const updates: TextEntity[] = [];
    for (const t of texts) {
      const tag = normalizeSymbolName(t.text.trim());
      if (!tag) continue;
      if (placed.has(tag)) {
        ed.log(`${tag} is already placed; the text "${t.text}" was left as geometry.`);
        continue;
      }
      placed.add(tag);
      updates.push({ ...t, layer: SYMATTR_LAYER, color: 'ByLayer', text: tag });
    }
    if (updates.length) {
      ed.doc.replaceEntities(updates);
      ed.log(`${updates.length} text object(s) converted to attribute placeholder(s): ${updates.map((u) => u.text).join(', ')}.`);
    }
    return updates.length;
  }

  // ------------------------------------------------------------- variants
  /** Current tab as a SymbolState (snapshot). */
  currentSymbol(): SymbolState | null {
    const meta = this.meta;
    return meta ? { state: this.editor.doc.snapshot, meta } : null;
  }

  /** Open the vertical variant of the current symbol in a new tab (see core `verticalVariant`). */
  makeVerticalVariant(): void {
    const sym = this.currentSymbol();
    if (!sym) return;
    if (sym.meta.orientation === 'V') {
      this.editor.log('This symbol is already vertical.');
      return;
    }
    const v = verticalVariant(sym);
    const sourceId = this.active()?.sourceId ?? null;
    this.open(v);
    const s = this.active();
    if (s) s.sourceId = sourceId;
    this.editor.log(`Vertical variant ${v.meta.name}: geometry rotated, pins now top / bottom, attributes moved to the right. Check it, then Save to Library.`);
  }

  /** Open the NO / NC twin of the current symbol in a new tab (see core `createTwin`). */
  createTwin(): void {
    const sym = this.currentSymbol();
    if (!sym) return;
    const t = createTwin(sym);
    const sourceId = this.active()?.sourceId ?? null;
    const existing = this.sessionFor(t.meta.name);
    if (existing !== null) {
      const idx = this.editor.sessions.all.findIndex((s) => s.id === existing);
      if (idx >= 0 && idx !== this.editor.sessions.active) this.editor.switchSession(idx);
      this.editor.log(`${t.meta.name} is already open.`);
      return;
    }
    this.open(t, userLibrary.has(t.meta.name) ? t.meta.name : null);
    const s = this.active();
    if (s) s.sourceId = sourceId;
    this.editor.log(`${t.meta.contact} twin ${t.meta.name}: default pins swapped${/_N[OC]$/.test(sym.meta.name) ? '' : ` (rename ${sym.meta.name} to ${sym.meta.name}_NO so Toggle NO/NC finds both)`}. Fix the blade if needed, Check, then Save to Library.`);
  }

  // ------------------------------------------------------------- compile / save
  /** The block definition the current symbol compiles to. */
  compile(): BlockDef | null {
    const meta = this.meta;
    return meta ? symbolStateToBlock(this.editor.doc.snapshot, meta) : null;
  }

  check(): CheckMessage[] {
    const s = this.active();
    const meta = this.meta;
    if (!s || !meta) return [];
    this.lastCheck = checkSymbol(this.editor.doc.snapshot, meta, {
      isBuiltin: isBuiltinSymbol,
      isUser: (n) => userLibrary.has(n),
      editingName: s.editing,
      validName: validBlockName,
      hasParent: hasParentSymbol,
    });
    return this.lastCheck;
  }

  /** First error of the last check (Save button tooltip), or null. */
  firstError(): string | null {
    return this.lastCheck.find((m) => m.level === 'error')?.text ?? null;
  }

  /**
   * Validate, write the symbol into the user library and refresh drawings that use it.
   * Saving an existing symbol under a new name asks Rename / Save as copy / Cancel.
   * Returns the saved entry, or null when not saved.
   */
  async save(): Promise<UserSymbol | null> {
    const ed = this.editor;
    const s = this.active();
    const meta = this.meta;
    if (!s || !meta) return null;
    const msgs = this.check();
    const errors = msgs.filter((m) => m.level === 'error');
    if (errors.length) {
      for (const m of errors) ed.log(`Symbol Builder: ${m.text}`);
      ed.log('Symbol not saved; fix the errors (the palette lists them).');
      ed.hooks.symbolBuilder?.revealCheck?.();
      return null;
    }
    for (const m of msgs) if (m.level === 'warning') ed.log(`Symbol Builder warning: ${m.text}`);
    const block = symbolStateToBlock(ed.doc.snapshot, meta);
    let note: string | null = null;
    if (s.editing && s.editing !== block.name && userLibrary.has(s.editing)) {
      const choice: RenameChoice = ed.hooks.symbolBuilder?.askRename ? await ed.hooks.symbolBuilder.askRename(s.editing, block.name) : 'copy';
      // The session may have changed while the dialog was open.
      if (this.active() !== s) return null;
      note = applyRenameChoice(choice, s.editing, block.name, userLibrary);
      if (note === null) {
        ed.log('Save cancelled.');
        return null;
      }
    }
    const entry = userLibrary.put({ block, standard: meta.standard, category: meta.category.trim() || 'User symbols', family: meta.family, wdtype: wdtypeFor(meta.kind, meta.family) });
    ed.log(note ?? `${block.name} saved to the user library (${entry.category}, family ${entry.family}).`);
    if (note) ed.log(`${block.name} saved to the user library (${entry.category}, family ${entry.family}).`);
    s.editing = block.name;
    this.refreshBlockInDrawings(block);
    ed.doc.dirty = false;
    ed.notify('file');
    if (userLibrary.lastError) ed.log(`User library could not be written: ${userLibrary.lastError}`);
    return entry;
  }

  /** Redefine the block in every other open drawing that already holds it so existing inserts refresh. */
  private refreshBlockInDrawings(block: BlockDef): void {
    for (const s of this.editor.sessions.all) {
      if (this.sessions.has(s.id) || !s.state.blocks[block.name]) continue;
      s.state = { ...s.state, blocks: { ...s.state.blocks, [block.name]: block } };
      s.dirty = true;
    }
  }

  /** Save, close the symbol tab, return to the source drawing and start AECOMPONENT <name>. */
  async saveAndInsert(): Promise<void> {
    const ed = this.editor;
    const s = this.active();
    if (!s) return;
    const entry = await this.save();
    if (!entry) return;
    const name = entry.block.name;
    await this.closeActive(true);
    const idx = ed.sessions.all.findIndex((x) => x.id === s.sourceId);
    if (idx >= 0 && idx !== ed.sessions.active) ed.switchSession(idx);
    ed.runCommand(`AECOMPONENT ${name}`);
  }

  /** Export the compiled symbol as a DXF block file (also what SAVEAS does in a symbol tab). */
  exportDxf(): void {
    const ed = this.editor;
    const block = this.compile();
    if (!block) return;
    if (!ed.fileBridge) {
      ed.log('No file access in this environment.');
      return;
    }
    void ed.fileBridge.saveDxf(null, symbolToDxf(block), `${block.name}.dxf`).then((p) => {
      if (p) ed.log(`Symbol ${block.name} exported to ${p} (block definition + one insert at the origin).`);
    });
  }

  /** Close the active symbol tab; prompts Save / Don't Save / Cancel when dirty unless forced. */
  async closeActive(force = false): Promise<boolean> {
    const ed = this.editor;
    const s = this.active();
    const meta = this.meta;
    if (!s || !meta) return false;
    if (!force && ed.doc.dirty) {
      const ui = ed.ui;
      const r = ui?.saveChanges ? await ui.saveChanges(`Symbol: ${meta.name}`) : (await (ui?.confirm('Unsaved symbol', `Discard the changes to ${meta.name}?`) ?? Promise.resolve(true))) ? 'discard' : 'cancel';
      if (r === 'cancel') return false;
      if (r === 'save' && !(await this.save())) {
        const errors = this.lastCheck.filter((m) => m.level === 'error');
        if (errors.length) await ed.hooks.symbolBuilder?.showErrors?.(`${meta.name} was not saved`, errors);
        return false;
      }
    }
    const idx = ed.sessions.active;
    const id = ed.sessions.current.id;
    const srcIdx = ed.sessions.all.findIndex((x) => x.id === s.sourceId);
    this.sessions.delete(id);
    ed.sessions.close(idx, srcIdx >= 0 ? srcIdx : undefined);
    this.syncActive();
    ed.notify('file');
    return true;
  }

  /** Close the symbol tab at `index` (file-tab close button / CLOSE command). */
  async closeSession(index: number): Promise<boolean> {
    const ed = this.editor;
    if (!this.isSymbolSession(index)) return false;
    if (index !== ed.sessions.active) ed.switchSession(index);
    return this.closeActive(false);
  }
}

/** Browser fallback for text exports: a Blob download (the desktop app uses the file bridge). */
function downloadText(name: string, text: string): boolean {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof Blob === 'undefined') return false;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return true;
}

/** AESYMBUILDER and the library maintenance commands; SAVE / SAVEAS / CLOSE are redirected while a symbol tab is active. */
export function registerSymbolBuilderCommands(editor: Editor): void {
  const sb = symbolBuilderOf(editor);
  const reg = (name: string, aliases: string[], description: string, run: (ed: Editor, arg?: string) => void) => editor.register({ name, aliases, description, run });
  reg('AESYMBUILDER', ['SYMBUILDER', 'SYMBOLBUILDER', 'SYMEDIT'], 'Symbol Builder: create or edit a schematic symbol in its own tab and save it to the user library [name]', (_ed, arg) => sb.start(arg));
  reg('AESYMSAVE', ['SYMSAVE'], 'Symbol Builder: save the symbol being edited to the user library', (ed) => {
    if (!sb.active()) ed.log('No symbol is being edited in this tab (AESYMBUILDER).');
    else void sb.save();
  });
  reg('AESYMCHECK', ['SYMCHECK'], 'Symbol Builder: validate the symbol being edited', (ed) => {
    if (!sb.active()) return ed.log('No symbol is being edited in this tab (AESYMBUILDER).');
    for (const m of sb.check()) ed.log(`  ${m.level === 'ok' ? '' : `[${m.level}] `}${m.text}`);
    ed.hooks.symbolBuilder?.revealCheck?.();
  });
  reg('AESYMVERTICAL', ['SYMVERTICAL'], 'Symbol Builder: open the vertical variant of the symbol being edited in a new tab', (ed) => {
    if (!sb.active()) return ed.log('No symbol is being edited in this tab (AESYMBUILDER).');
    sb.makeVerticalVariant();
  });
  reg('AESYMTWIN', ['SYMTWIN'], 'Symbol Builder: create the NO / NC twin of the symbol being edited in a new tab', (ed) => {
    if (!sb.active()) return ed.log('No symbol is being edited in this tab (AESYMBUILDER).');
    sb.createTwin();
  });
  reg('AESYMTEXT2ATTR', ['SYMTEXT2ATTR'], 'Symbol Builder: convert the selected text objects to attribute placeholders', (ed) => {
    if (!sb.active()) return ed.log('No symbol is being edited in this tab (AESYMBUILDER).');
    sb.convertSelectedText();
  });
  reg('AESYMDELETE', ['SYMDELETE'], 'Delete a symbol from the user library [name]', (ed, arg) => {
    const name = arg?.trim().toUpperCase();
    if (!name) return ed.log(`User library: ${userLibrary.names().join(', ') || '(empty)'}. Usage: AESYMDELETE <name>`);
    if (userLibrary.remove(name)) ed.log(`${name} removed from the user library (drawings that use it keep their copy of the block).`);
    else ed.log(`${name} is not in the user library.`);
  });
  reg('AESYMRENAME', ['SYMRENAME'], 'Rename a symbol of the user library [old new]', (ed, arg) => {
    const [oldName, newName] = (arg ?? '').trim().split(/\s+/).map((s) => s.toUpperCase());
    if (!oldName || !newName) return ed.log('Usage: AESYMRENAME <old name> <new name>');
    if (!userLibrary.has(oldName)) return ed.log(`${oldName} is not in the user library.`);
    if (!validBlockName(newName) || isBuiltinSymbol(newName)) return ed.log(`${newName} is not a valid new name (invalid characters or a built-in symbol).`);
    if (userLibrary.rename(oldName, newName)) ed.log(`${oldName} renamed to ${newName} (drawings that use it keep the old block name).`);
    else ed.log(`${newName} already exists in the user library.`);
  });
  reg('AESYMLIBEXPORT', ['SYMLIBEXPORT'], 'Export the user symbol library (or one symbol) as JSON [name]', (ed, arg) => {
    const name = arg?.trim().toUpperCase();
    if (name && !userLibrary.has(name)) return ed.log(`${name} is not in the user library.`);
    if (!name && userLibrary.size === 0) return ed.log('The user library is empty.');
    const file = name ? `${name}.symbol.json` : 'user-library.json';
    const json = userLibrary.exportJson(name ? [name] : undefined);
    const what = name ? `Symbol ${name}` : `${userLibrary.size} symbol(s)`;
    if (ed.fileBridge?.saveText) {
      void ed.fileBridge.saveText(file, json, 'JCad symbol library', 'json').then((p) => {
        if (p) ed.log(`${what} exported to ${p}.`);
      });
    } else if (downloadText(file, json)) ed.log(`${what} exported: ${file} downloaded by the browser.`);
    else ed.log('Exporting needs the desktop app or a browser.');
  });
  reg('AESYMLIBIMPORT', ['SYMLIBIMPORT'], 'Import symbols from a JSON symbol library file into the user library', (ed) => {
    const open = ed.hooks.symbolBuilder?.openTextFile ?? ed.hooks.electrical?.openTextFile;
    if (!open) return ed.log('Importing needs the application UI.');
    void open('.json').then((res) => {
      if (!res) return;
      try {
        const r = userLibrary.importJson(res.text);
        ed.log(`Imported ${r.added} new and ${r.updated} updated symbol(s) from ${res.path}.`);
      } catch (err) {
        ed.log(`Import failed: ${(err as Error).message}`);
      }
    });
  });
  // SAVE inside a symbol tab writes to the library rather than a DXF file; SAVEAS exports the block as DXF
  // (never sets a file path or clears the dirty flag of the symbol tab).
  const origSave = editor.commands.get('SAVE');
  if (origSave) {
    editor.register({
      ...origSave,
      run: (ed, arg) => {
        if (sb.active()) void sb.save();
        else origSave.run(ed, arg);
      },
    });
  }
  const origSaveAs = editor.commands.get('SAVEAS');
  if (origSaveAs) {
    editor.register({
      ...origSaveAs,
      run: (ed, arg) => {
        if (sb.active()) sb.exportDxf();
        else origSaveAs.run(ed, arg);
      },
    });
  }
}
