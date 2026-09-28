/**
 * Symbol Builder (AESYMBUILDER): edit a schematic symbol in its own file tab
 * and save it to the user symbol library.
 *
 * The controller (`SymbolBuilder`, one per Editor) owns the "symbol session
 * registry": which document sessions are symbol editing sessions and their
 * SymbolMeta (name, family, kind ...). While such a session is active the
 * viewport draws the origin / inline guides through its `underlay` hook, the
 * Symbol Builder palette is shown and SAVE writes to the user library instead
 * of a DXF file. Everything DOM-related lives in src/ui/symbol-builder.ts and
 * is reached through `editor.hooks.symbolBuilder`.
 */
import type { Editor } from '../app/editor';
import type { Point } from '../core/geometry';
import type { BlockDef, Entity, TextEntity } from '../core/entities';
import type { Viewport } from '../render/viewport';
import type { Tool, ToolContext } from './types';
import { validBlockName } from './blocks';
import { isBuiltinSymbol, isLibrarySymbol, findLibrarySymbol } from '../electrical/library';
import { userLibrary, symbolToDxf, type UserSymbol } from '../electrical/userlib';
import { NON_COMPONENT_RE } from '../electrical/families';
import {
  blankSymbolState,
  blockToSymbolState,
  harvestBlock,
  fromSelection,
  symbolStateToBlock,
  checkSymbol,
  compilePins,
  placeholderEntity,
  pinMarkerEntity,
  isPlaceholder,
  isPinMarker,
  suggestSymbolName,
  resolveBasePoint,
  boundsOfEntities,
  wdtypeFor,
  INLINE_HALF,
  defaultMeta,
  type SymbolMeta,
  type SymbolState,
  type PinDirection,
  type BasePointChoice,
  type CheckMessage,
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
  /** Blocks of the current drawing that can be harvested (not library symbols or WD_* furniture). */
  blocks: Array<{ name: string; description: string }>;
  selectionCount: number;
  suggestName(family: string): string;
}

/** DOM side of the Symbol Builder (src/ui/symbol-builder.ts). */
export interface SymbolBuilderUi {
  start(init: StartDialogInit): Promise<SymbolBuilderStart | null>;
  showPalette(ctl: SymbolBuilder): void;
  hidePalette(): void;
  refreshPalette(): void;
  openTextFile?(accept: string): Promise<{ path: string; text: string } | null>;
}

export interface SymbolSession {
  meta: SymbolMeta;
  /** Session id of the drawing the builder was started from (Save and Insert returns there). */
  sourceId: number | null;
  /** Name of the user symbol being edited, null for a new symbol. */
  editing: string | null;
}

const fmt = (p: Point) => `${p.x.toFixed(4)}, ${p.y.toFixed(4)}`;

/** One-point pick with a ghost of the entity that will be placed. */
export class PlaceEntityTool implements Tool {
  readonly name: string;
  constructor(
    name: string,
    private promptText: string,
    private build: (p: Point) => Entity,
    private done: (p: Point, ctx: ToolContext) => void,
  ) {
    this.name = name;
  }
  start(ctx: ToolContext): void {
    ctx.prompt(this.promptText);
  }
  onMove(p: Point, ctx: ToolContext): void {
    ctx.setGhost([this.build(p)]);
    ctx.setDynText([fmt(p)]);
  }
  onPoint(p: Point, ctx: ToolContext): void {
    ctx.setGhost([]);
    this.done(p, ctx);
    ctx.finish();
  }
  onText(_t: string, _c: ToolContext): void {}
  onEnter(ctx: ToolContext): void {
    ctx.finish();
  }
  onCancel(ctx: ToolContext): void {
    ctx.setGhost([]);
    ctx.finish();
  }
}

/** Draw the Symbol Builder guides: origin cross, 0.75 in box, inline stub guides and a legend. */
export function drawSymbolGuides(ctx: CanvasRenderingContext2D, vp: Viewport, meta: SymbolMeta): void {
  const s = (x: number, y: number) => vp.toScreen({ x, y });
  const o = s(0, 0);
  ctx.lineWidth = 1;
  // inline stub guides: where the wire arrives from the left / right
  ctx.strokeStyle = 'rgba(255, 140, 120, 0.75)';
  ctx.setLineDash([6, 5]);
  ctx.beginPath();
  for (const sign of [-1, 1]) {
    const a = s(sign * INLINE_HALF, 0);
    const b = s(sign * 1.1, 0);
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
  // connection squares at (+-HALF, 0)
  ctx.strokeStyle = 'rgba(255, 140, 120, 0.95)';
  for (const sign of [-1, 1]) {
    const p = s(sign * INLINE_HALF, 0);
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
    ctx.fillText('-0.375', tl.x, br.y + 14);
    ctx.fillText('+0.375', br.x, br.y + 14);
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(120, 200, 255, 0.85)';
    ctx.fillText('0,0 insertion point', o.x + 6, o.y - 6);
  }
  // legend
  const lines = [
    `Symbol Builder: ${meta.name || '(unnamed)'}  -  ${meta.kind}${meta.contact ? ` ${meta.contact}` : ''}, family ${meta.family || '?'}, ${meta.standard}`,
    'Inline symbols are 0.75 in wide: wire stubs end at x = ±0.375, y = 0 (dashed guides).',
    'Layer SYMATTR (yellow) = attribute placeholders (TAG1, DESC1 ...), SYMPIN (red) = explicit pins (X1TERM01 ...).',
  ];
  ctx.textAlign = 'left';
  let y = 18;
  for (const [i, line] of lines.entries()) {
    ctx.fillStyle = i === 0 ? 'rgba(230, 230, 230, 0.95)' : 'rgba(190, 190, 190, 0.8)';
    ctx.font = i === 0 ? 'bold 12px "Segoe UI", system-ui, sans-serif' : '11px "Segoe UI", system-ui, sans-serif';
    ctx.fillText(line, 12, y);
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

export class SymbolBuilder {
  /** Session id -> symbol session. */
  readonly sessions = new Map<number, SymbolSession>();
  private activeId: number | null = null;
  private savedGrid: { grid: number; snap: number } | null = null;

  constructor(private editor: Editor) {
    editor.on('file', () => this.syncActive());
    editor.on('change', () => {
      if (this.activeId !== null) editor.hooks.symbolBuilder?.refreshPalette();
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
  get meta(): SymbolMeta | null {
    return this.active()?.meta ?? null;
  }

  /** Re-evaluate which tab is active: prune closed sessions, toggle guides / palette / fine grid. */
  private syncActive(): void {
    const ed = this.editor;
    const live = new Set(ed.sessions.all.map((s) => s.id));
    for (const id of [...this.sessions.keys()]) if (!live.has(id)) this.sessions.delete(id);
    const id = this.sessionIdAt(ed.sessions.active);
    const next = id !== null && this.sessions.has(id) ? id : null;
    const was = this.activeId;
    this.activeId = next;
    const ui = ed.hooks.symbolBuilder;
    if (next !== null) {
      const meta = this.sessions.get(next)!.meta;
      ed.viewport.underlay = (ctx, vp) => drawSymbolGuides(ctx, vp, meta);
      if (was === null) {
        this.savedGrid = { grid: ed.viewport.settings.gridSize, snap: ed.snap.gridSize };
        ed.viewport.settings.gridSize = 0.125;
        ed.snap.gridSize = 0.0625;
      }
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

  // ------------------------------------------------------------- start
  /** Blocks of the current drawing worth harvesting: not library symbols, not WD_* furniture, with geometry. */
  harvestableBlocks(): Array<{ name: string; description: string }> {
    return Object.entries(this.editor.doc.blocks)
      .filter(([n, b]) => !n.startsWith('*') && !isLibrarySymbol(n) && !NON_COMPONENT_RE.test(n) && !/^WD_/.test(n) && b.entities.length > 0)
      .map(([name, b]) => ({ name, description: b.description ?? '' }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private nameExists(name: string): boolean {
    return isLibrarySymbol(name) || !!this.editor.doc.blocks[name];
  }

  /** AESYMBUILDER [name]: open the start dialog, or edit the named user symbol directly. */
  start(arg?: string): void {
    const ed = this.editor;
    const ui = ed.hooks.symbolBuilder;
    const preset = arg?.trim().toUpperCase();
    if (preset && userLibrary.has(preset)) {
      this.editUserSymbol(preset);
      return;
    }
    if (!ui) {
      ed.log('The Symbol Builder dialog is only available in the application UI.');
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
    void ui.start(init).then((r) => {
      if (r) this.openFrom(r);
    });
  }

  /** Build the editing state for the chosen source and open it. */
  openFrom(r: SymbolBuilderStart): void {
    const ed = this.editor;
    const meta = { ...r.meta, name: r.meta.name.toUpperCase(), family: r.meta.family.toUpperCase() };
    switch (r.source.kind) {
      case 'blank':
        this.open({ state: blankSymbolState(), meta });
        return;
      case 'library': {
        const def = findLibrarySymbol(r.source.name);
        if (!def) {
          ed.log(`Symbol ${r.source.name} not found.`);
          return;
        }
        const sym = blockToSymbolState(def, meta);
        this.open({ state: sym.state, meta: { ...meta, pinDefaults: sym.meta.pinDefaults } });
        return;
      }
      case 'block': {
        const def = ed.doc.blocks[r.source.name];
        if (!def) {
          ed.log(`Block ${r.source.name} not found in the drawing.`);
          return;
        }
        const b = boundsOfEntities(def.entities, ed.doc.lookupBlock);
        const basePoint = resolveBasePoint(r.source.basePoint, b, def.basePoint);
        const sym = harvestBlock(ed.doc.snapshot, r.source.name, { basePoint, scaleToWidth: r.source.scale ? INLINE_HALF * 2 : undefined });
        if (!sym) return;
        ed.log(`Harvested block ${r.source.name}: ${sym.state.entities.length} object(s)${r.source.scale ? ', scaled to 0.75 in wide' : ''}.`);
        this.open({ state: sym.state, meta: { ...meta, pinDefaults: sym.meta.pinDefaults } });
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
              this.open({ state: sym.state, meta });
            },
          ),
        );
        return;
      }
    }
  }

  /** Open an existing user symbol for editing. */
  editUserSymbol(name: string): boolean {
    const sym = userLibrary.get(name);
    if (!sym) {
      this.editor.log(`${name} is not in the user library.`);
      return false;
    }
    const kind = sym.wdtype === 'COIL' ? 'parent' : sym.wdtype === 'CONTACT' ? 'child' : sym.wdtype === 'TERM' ? 'terminal' : sym.wdtype === 'PLC' ? 'plc' : 'standalone';
    const st = blockToSymbolState(sym.block, { standard: sym.standard, category: sym.category, family: sym.family, kind, description: sym.block.description ?? '' });
    this.open(st, sym.block.name, false);
    return true;
  }

  /** Open a symbol editing tab. */
  open(sym: SymbolState, editing: string | null = null, dirty = true): void {
    const ed = this.editor;
    const sourceId = ed.sessions.current.id;
    ed.sessions.add(sym.state, null, dirty);
    const s = ed.sessions.current;
    s.untitledName = `Symbol: ${sym.meta.name}`;
    this.sessions.set(s.id, { meta: { ...sym.meta, pinDefaults: { ...sym.meta.pinDefaults } }, sourceId, editing });
    ed.doc.dirty = dirty;
    ed.doc.setCurrentLayer('0');
    ed.viewport.zoomToBounds({ min: { x: -1.2, y: -0.9 }, max: { x: 1.2, y: 0.9 } }, 0.05);
    this.syncActive();
    ed.notify('file');
    ed.log(`Symbol Builder: editing ${sym.meta.name}${editing ? ` (user library)` : ''}. Draw the geometry around the origin; place TAG1 / DESC1 and pins from the palette; Save to Library when done.`);
  }

  // ------------------------------------------------------------- editing
  /** Change symbol meta (palette fields). Renames the tab when the name changes. */
  updateMeta(patch: Partial<SymbolMeta>): void {
    const s = this.active();
    if (!s) return;
    const ed = this.editor;
    const next: SymbolMeta = { ...s.meta, ...patch };
    next.name = next.name.trim().toUpperCase();
    next.family = next.family.trim().toUpperCase();
    if (next.kind === 'child') {
      next.contact = next.contact ?? 'NO';
      if (patch.contact || patch.kind) next.name = next.name.replace(/_N[OC]$/, '') + `_${next.contact}`;
    } else delete next.contact;
    s.meta = next;
    ed.sessions.current.untitledName = `Symbol: ${next.name}`;
    ed.doc.dirty = true;
    ed.notify('file');
    ed.render();
  }

  setPinDefault(markerId: string, value: string): void {
    const s = this.active();
    if (!s) return;
    s.meta = { ...s.meta, pinDefaults: { ...s.meta.pinDefaults, [markerId]: value.trim() } };
    this.editor.doc.dirty = true;
    this.editor.notify('change');
  }

  /** Attribute placeholders currently in the document. */
  placeholders(): TextEntity[] {
    return this.editor.doc.entities.filter(isPlaceholder);
  }
  pinMarkers(): TextEntity[] {
    return this.editor.doc.entities.filter(isPinMarker);
  }
  pins() {
    const s = this.active();
    return s ? compilePins(this.editor.doc.snapshot, s.meta) : [];
  }

  /** Place (or move) an attribute placeholder with a point pick. */
  placeAttribute(tag: string): void {
    const ed = this.editor;
    const existing = this.placeholders().find((t) => t.text.trim().toUpperCase() === tag);
    const ghost = (p: Point): Entity => (existing ? { ...existing, position: p } : placeholderEntity(tag, p));
    ed.startTool(
      new PlaceEntityTool('AESYMATTR', `Specify position of the ${tag} attribute:`, ghost, (p) => {
        if (existing) ed.doc.replaceEntities([{ ...existing, position: p }]);
        else ed.doc.addEntities([placeholderEntity(tag, p)], false);
        ed.log(`${tag} placed at ${fmt(p)}.`);
      }),
    );
  }

  /** Add an attribute placeholder at its default position without picking. */
  addAttribute(tag: string): void {
    if (this.placeholders().some((t) => t.text.trim().toUpperCase() === tag)) return;
    this.editor.doc.addEntities([placeholderEntity(tag)], false);
  }

  removeEntity(id: string): void {
    this.editor.doc.removeEntities([id]);
  }

  /** Add an explicit pin marker with a point pick. */
  addPin(dir: PinDirection, pinDefault = ''): void {
    const ed = this.editor;
    const s = this.active();
    if (!s) return;
    const index = this.pins().length + 1;
    ed.startTool(
      new PlaceEntityTool('AESYMPIN', `Specify the wire connection point (${['', 'left', 'top', '', 'right', '', '', '', 'bottom'][dir]}):`, (p) => pinMarkerEntity(dir, p, index), (p) => {
        const m = pinMarkerEntity(dir, p, index);
        if (pinDefault) s.meta = { ...s.meta, pinDefaults: { ...s.meta.pinDefaults, [m.id]: pinDefault } };
        ed.doc.addEntities([m], false);
        ed.log(`Pin ${m.text} placed at ${fmt(p)}.`);
      }),
    );
  }

  // ------------------------------------------------------------- compile / save
  /** The block definition the current symbol compiles to. */
  compile(): BlockDef | null {
    const s = this.active();
    return s ? symbolStateToBlock(this.editor.doc.snapshot, s.meta) : null;
  }

  check(): CheckMessage[] {
    const s = this.active();
    if (!s) return [];
    return checkSymbol(this.editor.doc.snapshot, s.meta, {
      isBuiltin: isBuiltinSymbol,
      isUser: (n) => userLibrary.has(n),
      editingName: s.editing,
      validName: validBlockName,
    });
  }

  /** Validate, write the symbol into the user library and refresh drawings that use it. Returns the saved entry. */
  save(): UserSymbol | null {
    const ed = this.editor;
    const s = this.active();
    if (!s) return null;
    const msgs = this.check();
    const errors = msgs.filter((m) => m.level === 'error');
    if (errors.length) {
      for (const m of errors) ed.log(`Symbol Builder: ${m.text}`);
      ed.log('Symbol not saved; fix the errors above (Check lists them).');
      return null;
    }
    for (const m of msgs) if (m.level === 'warning') ed.log(`Symbol Builder warning: ${m.text}`);
    const block = symbolStateToBlock(ed.doc.snapshot, s.meta);
    const entry = userLibrary.put({ block, standard: s.meta.standard, category: s.meta.category.trim() || 'User symbols', family: s.meta.family, wdtype: wdtypeFor(s.meta.kind, s.meta.family) });
    if (s.editing && s.editing !== block.name) ed.log(`Saved as a new symbol ${block.name}; ${s.editing} is kept in the library (delete it with AESYMDELETE ${s.editing} if it is no longer needed).`);
    else ed.log(`${block.name} saved to the user library (${entry.category}, family ${entry.family}).`);
    s.editing = block.name;
    this.refreshBlockInDrawings(block);
    ed.doc.dirty = false;
    ed.notify('file');
    if (userLibrary.lastError) ed.log(`User library could not be written: ${userLibrary.lastError}`);
    return entry;
  }

  /** Redefine the block in every open drawing that already holds it so existing inserts refresh. */
  private refreshBlockInDrawings(block: BlockDef): void {
    const ed = this.editor;
    const activeId = ed.sessions.current.id;
    for (const s of ed.sessions.all) {
      if (this.sessions.has(s.id) || !s.state.blocks[block.name]) continue;
      if (s.id === activeId) ed.doc.defineBlock(block);
      else {
        s.state = { ...s.state, blocks: { ...s.state.blocks, [block.name]: block } };
        s.dirty = true;
      }
    }
  }

  /** Save, close the symbol tab, return to the source drawing and start AECOMPONENT <name>. */
  saveAndInsert(): void {
    const ed = this.editor;
    const s = this.active();
    if (!s) return;
    const entry = this.save();
    if (!entry) return;
    const name = entry.block.name;
    this.closeActive(true);
    const idx = ed.sessions.all.findIndex((x) => x.id === s.sourceId);
    if (idx >= 0 && idx !== ed.sessions.active) ed.switchSession(idx);
    ed.runCommand(`AECOMPONENT ${name}`);
  }

  /** Export the compiled symbol as a DXF block file. */
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
    if (!s) return false;
    if (!force && ed.doc.dirty) {
      const ui = ed.ui;
      const r = ui?.saveChanges ? await ui.saveChanges(`Symbol: ${s.meta.name}`) : (await (ui?.confirm('Unsaved symbol', `Discard the changes to ${s.meta.name}?`) ?? Promise.resolve(true))) ? 'discard' : 'cancel';
      if (r === 'cancel') return false;
      if (r === 'save' && !this.save()) return false;
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

/** AESYMBUILDER and the library maintenance commands; SAVE / CLOSE are redirected while a symbol tab is active. */
export function registerSymbolBuilderCommands(editor: Editor): void {
  const sb = symbolBuilderOf(editor);
  const reg = (name: string, aliases: string[], description: string, run: (ed: Editor, arg?: string) => void) => editor.register({ name, aliases, description, run });
  reg('AESYMBUILDER', ['SYMBUILDER', 'SYMBOLBUILDER', 'SYMEDIT'], 'Symbol Builder: create or edit a schematic symbol in its own tab and save it to the user library [name]', (_ed, arg) => sb.start(arg));
  reg('AESYMSAVE', ['SYMSAVE'], 'Symbol Builder: save the symbol being edited to the user library', (ed) => {
    if (!sb.active()) ed.log('No symbol is being edited in this tab (AESYMBUILDER).');
    else sb.save();
  });
  reg('AESYMCHECK', ['SYMCHECK'], 'Symbol Builder: validate the symbol being edited', (ed) => {
    if (!sb.active()) return ed.log('No symbol is being edited in this tab (AESYMBUILDER).');
    for (const m of sb.check()) ed.log(`  ${m.level === 'ok' ? '' : `[${m.level}] `}${m.text}`);
  });
  reg('AESYMDELETE', ['SYMDELETE'], 'Delete a symbol from the user library [name]', (ed, arg) => {
    const name = arg?.trim().toUpperCase();
    if (!name) return ed.log(`User library: ${userLibrary.names().join(', ') || '(empty)'}. Usage: AESYMDELETE <name>`);
    if (userLibrary.remove(name)) ed.log(`${name} removed from the user library (drawings that use it keep their copy of the block).`);
    else ed.log(`${name} is not in the user library.`);
  });
  reg('AESYMLIBEXPORT', ['SYMLIBEXPORT'], 'Export the user symbol library (or one symbol) as JSON [name]', (ed, arg) => {
    const name = arg?.trim().toUpperCase();
    if (name && !userLibrary.has(name)) return ed.log(`${name} is not in the user library.`);
    if (!name && userLibrary.size === 0) return ed.log('The user library is empty.');
    if (!ed.fileBridge?.saveText) return ed.log('Exporting needs the desktop app (or use the browser download of AESYMLIBEXPORT in the UI).');
    void ed.fileBridge.saveText(name ? `${name}.symbol.json` : 'user-library.json', userLibrary.exportJson(name ? [name] : undefined), 'JCad symbol library', 'json').then((p) => {
      if (p) ed.log(`${name ? `Symbol ${name}` : `${userLibrary.size} symbol(s)`} exported to ${p}.`);
    });
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
  // SAVE inside a symbol tab writes to the library rather than a DXF file.
  const origSave = editor.commands.get('SAVE');
  if (origSave) {
    editor.register({
      ...origSave,
      run: (ed, arg) => {
        if (sb.active()) sb.save();
        else origSave.run(ed, arg);
      },
    });
  }
}
