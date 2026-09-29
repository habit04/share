/**
 * Layout commands and the per-editor layout controller (Track E).
 *
 * The controller keeps the canvas in step with the active space stored in the drawing
 * (`DrawingState.space`): in the Model tab the canvas shows model space as before; in a
 * layout it installs the paper painter (render/layouts.ts). In paper space the canvas view
 * is the paper view; in a floating viewport (MSPACE) the canvas view is the model view seen
 * through that viewport, so every tool, snap and pick works in model coordinates unchanged,
 * and zoom / pan are written back to the viewport (or, when it is locked, to the paper view).
 *
 * Commands: LAYOUT, LAYOUTWIZARD, MSPACE (MS), PSPACE (PS), MODEL, TILEMODE, MVIEW (MV),
 * MVSETUP, VPSCALE, PAGESETUP, CANNOSCALE / ANNOSCALE, ANNOALLVISIBLE, OBJECTSCALE.
 */
import type { Editor } from '../app/editor';
import type { Point, Bounds } from '../core/geometry';
import * as g from '../core/geometry';
import type { Entity } from '../core/entities';
import { newId, scaleEntityBy, entityBounds } from '../core/entities';
import type { DrawingState } from '../core/document';
import {
  activeLayout,
  activeViewport,
  applyPaperEntities,
  canBeAnnotative,
  cannoscaleValue,
  defaultLayout,
  findLayout,
  fitViewportView,
  formatScale,
  isViewportFrame,
  layoutsOf,
  makeViewport,
  paperLabel,
  paperSpaceLayout,
  parseScale,
  pointInViewport,
  printableArea,
  sheetBounds,
  sheetSize,
  STANDARD_SCALES,
  uniqueLayoutName,
  unitsOfHost,
  validLayoutName,
  viewportAt,
  VIEWPORT_LAYER,
  withLayout,
  withViewport,
  type Layout,
  type LayoutViewport,
  type SpaceRef,
} from '../core/layouts';
import { paintLayout, paperTransform, viewportScreenRect, type PaperView } from '../render/layouts';
import { scriptTool, pointOrKeyword, point, keyword, text, select, matchKeyword } from './script';
import { sheetEntities, TITLE_BLOCK, SHEET_SIZES, type SheetSize } from '../electrical/templates';

/** Dialogs the UI layer (src/ui/layouts.ts) provides; commands fall back to the command line without them. */
export interface LayoutUi {
  pageSetup?(layoutName: string): void;
  wizard?(): void;
}

export interface WizardOptions {
  name: string;
  paper: Layout['paper'];
  /** Viewport scale ("fit" or "1:4"). */
  scale: string;
  titleBlock: boolean;
  fields?: Record<string, string>;
}

const controllers = new WeakMap<Editor, LayoutController>();

/** The layout controller of an editor (created by registerLayoutCommands). */
export function layoutController(ed: Editor): LayoutController {
  let c = controllers.get(ed);
  if (!c) {
    c = new LayoutController(ed);
    controllers.set(ed, c);
  }
  return c;
}

const spaceKey = (s: SpaceRef | undefined): string => (s ? `${s.layout.toUpperCase()}|${s.viewport ?? ''}` : 'MODEL');

const NOT_IN_MODEL = '** Command not allowed in Model Tab **';

export class LayoutController {
  /** Paper view while a floating viewport is active (in paper space the canvas view is the paper view). */
  private paperView: PaperView | null = null;
  private applied: SpaceRef | undefined = undefined;
  private views = new Map<string, { center: Point; scale: number }>();
  /** Layout that TILEMODE 0 / the MODEL button returns to. */
  lastLayout = 'Layout1';
  ui: LayoutUi = {};
  private installed = false;
  /** Drawing.loadCount seen last (a new count = another document). */
  private loads = 0;
  private readonly painter = (ctx: CanvasRenderingContext2D, _vp: unknown, ov: Parameters<typeof paintLayout>[2]) =>
    paintLayout(ctx, this.ed.viewport, ov, { doc: this.ed.doc, paperView: () => this.currentPaperView() });

  constructor(private readonly ed: Editor) {}

  install(): void {
    if (this.installed) return;
    this.installed = true;
    this.loads = this.ed.doc.loadCount;
    this.ed.doc.subscribe(() => this.sync());
    this.ed.on('file', () => this.resync());
    this.ed.on('view', () => this.reconcile());
    this.ed.layoutInput = {
      doubleClick: (s) => this.onDoubleClick(s),
      mouseDown: (s) => this.onMouseDown(s),
      hoverBlocked: (s) => this.outsideActiveViewport(s),
    };
    this.resync();
  }

  // ------------------------------------------------------------ queries
  get space(): SpaceRef | undefined {
    return this.ed.doc.space;
  }
  get layout(): Layout | undefined {
    return activeLayout(this.ed.doc.snapshot);
  }
  /** 'model' | 'paper' | 'viewport' */
  get mode(): 'model' | 'paper' | 'viewport' {
    const s = this.space;
    return !s ? 'model' : s.viewport ? 'viewport' : 'paper';
  }

  /** Paper view of what the canvas shows now (`applied` lags the document's space until `sync`). */
  currentPaperView(): PaperView {
    if (this.applied?.viewport && this.paperView) return this.paperView;
    const vp = this.ed.viewport;
    return { center: { ...vp.center }, scale: vp.scale };
  }

  // ------------------------------------------------------------ space switching
  /** Show the Model tab (null) or a layout (paper space). */
  activate(name: string | null, keepTool = false): boolean {
    const ed = this.ed;
    if (ed.tool && !keepTool) ed.cancel();
    if (name === null) {
      if (!this.space) return true;
      ed.doc.setSpace(undefined);
      return true;
    }
    const layout = findLayout(ed.doc.snapshot, name);
    if (!layout) {
      ed.log(`Layout "${name}" not found.`);
      return false;
    }
    this.lastLayout = layout.name;
    if (this.space && this.space.layout === layout.name && !this.space.viewport) return true;
    ed.doc.setSpace({ layout: layout.name }, (s) => (layout.pristine ? initializeLayout(s, layout.name, modelExtents(ed)) : s));
    return true;
  }

  /** MSPACE into a floating viewport of the active layout. */
  enterViewport(id: string): boolean {
    const lay = this.layout;
    const vp = lay?.viewports.find((v) => v.id === id);
    if (!lay || !vp) return false;
    if (!vp.on) {
      this.ed.log('The viewport is off: turn it on with MVIEW ON.');
      return false;
    }
    if (this.ed.tool) this.ed.cancel();
    this.ed.doc.setSpace({ layout: lay.name, viewport: id });
    return true;
  }

  /** PSPACE: back to the paper of the active layout. */
  exitToPaper(): void {
    const s = this.space;
    if (!s?.viewport) return;
    if (this.ed.tool) this.ed.cancel();
    this.ed.doc.setSpace({ layout: s.layout });
  }

  /** React to a state change: a new space (tab click, undo, session switch) or edited viewports. */
  sync(): void {
    const next = this.space;
    if (this.ed.doc.loadCount !== this.loads) {
      // Another document (open, new, tab switch): its views are not ours; `resync` follows on 'file'.
      this.loads = this.ed.doc.loadCount;
      this.views.clear();
      this.applied = next;
      this.paperView = null;
      this.updatePainter();
      return;
    }
    if (spaceKey(next) !== spaceKey(this.applied)) this.transition(this.applied, next);
    else if (next?.viewport) this.applyViewportToCanvas();
    this.updatePainter();
  }

  /** After open / new / tab switch: take the canvas view as it is and derive the paper view from it. */
  resync(): void {
    const s = this.space;
    this.applied = s;
    this.paperView = null;
    if (s?.viewport) {
      const act = activeViewport(this.ed.doc.snapshot);
      if (act) {
        const vp = this.ed.viewport;
        const v = act.viewport;
        const k = v.view.scale;
        this.paperView = { scale: vp.scale / k, center: { x: v.center.x + (vp.center.x - v.view.center.x) * k, y: v.center.y + (vp.center.y - v.view.center.y) * k } };
      }
    }
    if (s) this.lastLayout = s.layout;
    this.updatePainter();
    this.ed.notify('space');
  }

  private transition(prev: SpaceRef | undefined, next: SpaceRef | undefined): void {
    const vp = this.ed.viewport;
    const state = this.ed.doc.snapshot;
    // Remember the outgoing view.
    if (!prev) this.views.set('MODEL', { center: { ...vp.center }, scale: vp.scale });
    else this.views.set(`L:${prev.layout.toUpperCase()}`, this.currentPaperView());
    const outgoingPaper = prev ? this.currentPaperView() : null;
    this.applied = next;
    vp.fitRect = null;
    if (!next) {
      this.paperView = null;
      vp.layoutPainter = null;
      const saved = this.views.get('MODEL');
      if (saved) {
        vp.center = { ...saved.center };
        vp.scale = saved.scale;
      } else vp.zoomToBounds(this.ed.doc.extents());
    } else {
      const layout = findLayout(state, next.layout);
      this.lastLayout = next.layout;
      const pv: PaperView =
        prev && outgoingPaper && prev.layout.toUpperCase() === next.layout.toUpperCase()
          ? outgoingPaper
          : (this.views.get(`L:${next.layout.toUpperCase()}`) ?? (layout ? this.fitSheet(layout) : { center: { x: 0, y: 0 }, scale: 40 }));
      this.paperView = pv;
      if (next.viewport) this.applyViewportToCanvas();
      else {
        vp.center = { ...pv.center };
        vp.scale = pv.scale;
        this.paperView = null;
      }
    }
    this.updatePainter();
    this.ed.render();
    this.ed.notify('space');
    this.ed.notify('view');
  }

  private fitSheet(layout: Layout): PaperView {
    const vp = this.ed.viewport;
    const s = sheetSize(layout);
    const scale = Math.min(vp.width / (s.width * 1.12), vp.height / (s.height * 1.12));
    return { center: { x: s.width / 2, y: s.height / 2 }, scale: scale > 0 && Number.isFinite(scale) ? scale : 40 };
  }

  private updatePainter(): void {
    const vp = this.ed.viewport;
    vp.layoutPainter = this.space ? this.painter : null;
    vp.paperUcsIcon = !!this.space && !this.space.viewport;
    const act = activeViewport(this.ed.doc.snapshot);
    vp.fitRect = act && this.paperView ? viewportScreenRect(act.viewport, this.paperView, vp.width, vp.height) : null;
  }

  /** Put the canvas view where the active viewport's view says (after a state change). */
  private applyViewportToCanvas(): void {
    const act = activeViewport(this.ed.doc.snapshot);
    if (!act) return;
    if (!this.paperView) this.paperView = { center: { ...this.ed.viewport.center }, scale: this.ed.viewport.scale };
    const pv = this.paperView;
    const v = act.viewport;
    const k = v.view.scale;
    const vp = this.ed.viewport;
    vp.scale = pv.scale * k;
    vp.center = { x: v.view.center.x + (pv.center.x - v.center.x) / k, y: v.view.center.y + (pv.center.y - v.center.y) / k };
  }

  /** After a zoom / pan in a floating viewport: store the new view (or move the paper when the viewport is locked). */
  reconcile(): void {
    if (this.mode !== 'viewport' || !this.paperView) return;
    const act = activeViewport(this.ed.doc.snapshot);
    if (!act) return;
    const vp = this.ed.viewport;
    const v = act.viewport;
    const pv = this.paperView;
    const k = v.view.scale;
    const expScale = pv.scale * k;
    const expCenter = { x: v.view.center.x + (pv.center.x - v.center.x) / k, y: v.view.center.y + (pv.center.y - v.center.y) / k };
    const tol = 1e-9 * Math.max(1, Math.abs(expCenter.x), Math.abs(expCenter.y));
    if (Math.abs(vp.scale - expScale) <= 1e-9 * expScale && Math.abs(vp.center.x - expCenter.x) <= tol && Math.abs(vp.center.y - expCenter.y) <= tol) return;
    if (v.view.locked) {
      // Locked display: the paper zooms / pans, the viewport keeps its view.
      this.paperView = { scale: vp.scale / k, center: { x: v.center.x + (vp.center.x - v.view.center.x) * k, y: v.center.y + (vp.center.y - v.view.center.y) * k } };
    } else {
      const nk = vp.scale / pv.scale;
      const center = { x: vp.center.x - (pv.center.x - v.center.x) / nk, y: vp.center.y - (pv.center.y - v.center.y) / nk };
      const name = act.layout.name;
      this.ed.doc.patchQuiet((s) => {
        const lay = findLayout(s, name);
        return lay ? withLayout(s, withViewport(lay, v.id, (x) => ({ ...x, view: { ...x.view, center, scale: nk } }))) : s;
      });
    }
    this.updatePainter();
    this.ed.notify('space');
  }

  // ------------------------------------------------------------ mouse
  private paperPoint(screen: Point): Point {
    const vp = this.ed.viewport;
    return paperTransform(this.currentPaperView(), vp.width, vp.height).toPaper(screen);
  }

  private outsideActiveViewport(screen: Point): boolean {
    if (this.mode !== 'viewport') return false;
    const act = activeViewport(this.ed.doc.snapshot);
    return !!act && !pointInViewport(act.viewport, this.paperPoint(screen));
  }

  /** Clicking another viewport while in MSPACE makes it current (AutoCAD); returns true when consumed. */
  private onMouseDown(screen: Point): boolean {
    if (this.mode !== 'viewport' || this.ed.tool) return false;
    const lay = this.layout;
    if (!lay || !this.outsideActiveViewport(screen)) return false;
    const other = viewportAt(lay, this.paperPoint(screen));
    if (other && other.on) this.enterViewport(other.id);
    return true;
  }

  /** Double-click inside a viewport enters it; outside the active one returns to paper space. */
  private onDoubleClick(screen: Point): boolean {
    const lay = this.layout;
    if (!lay || this.ed.tool) return false;
    const p = this.paperPoint(screen);
    const edge = 6 / this.currentPaperView().scale;
    if (this.mode === 'paper') {
      const v = viewportAt(lay, p);
      if (!v || !v.on) return false;
      const inner = Math.abs(p.x - v.center.x) < v.width / 2 - edge && Math.abs(p.y - v.center.y) < v.height / 2 - edge;
      if (!inner) return false;
      this.enterViewport(v.id);
      return true;
    }
    if (this.mode === 'viewport' && this.outsideActiveViewport(screen)) {
      const v = viewportAt(lay, p);
      if (v && v.on) this.enterViewport(v.id);
      else this.exitToPaper();
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ layout edits (undoable)
  /** Apply a change to a layout as one undo step. */
  editLayout(name: string, fn: (l: Layout) => Layout | null): boolean {
    let ok = false;
    this.ed.doc.transact((s) => {
      const lay = findLayout(s, name);
      if (!lay) return s;
      const next = fn(lay);
      if (!next || next === lay) return s;
      ok = true;
      return withLayout(s, next, lay.name);
    });
    return ok;
  }

  newLayout(name?: string, template?: Partial<Layout>): string | null {
    const st = this.ed.doc.snapshot;
    const n = name?.trim() || uniqueLayoutName(st);
    if (!validLayoutName(n)) {
      this.ed.log(`Invalid layout name "${n}".`);
      return null;
    }
    if (findLayout(st, n)) {
      this.ed.log(`Layout "${n}" already exists.`);
      return null;
    }
    this.ed.doc.transact((s) => ({ ...s, layouts: [...layoutsOf(s), { ...defaultLayout(n, unitsOfHost(s)), ...template, name: n }] }));
    return n;
  }

  copyLayout(from: string, to?: string): string | null {
    const st = this.ed.doc.snapshot;
    const src = findLayout(st, from);
    if (!src) {
      this.ed.log(`Layout "${from}" not found.`);
      return null;
    }
    let n = to?.trim() || `${src.name} (2)`;
    for (let i = 3; findLayout(st, n); i += 1) n = `${src.name} (${i})`;
    if (!validLayoutName(n)) {
      this.ed.log(`Invalid layout name "${n}".`);
      return null;
    }
    const copy: Layout = {
      ...src,
      name: n,
      entities: src.entities.map((e) => ({ ...e, id: newId() }) as Entity),
      viewports: src.viewports.map((v) => ({ ...v, id: newId() })),
    };
    this.ed.doc.transact((s) => {
      const list = [...layoutsOf(s)];
      const i = list.findIndex((l) => l.name === src.name);
      list.splice(i + 1, 0, copy);
      return { ...s, layouts: list };
    });
    return n;
  }

  deleteLayout(name: string): boolean {
    const st = this.ed.doc.snapshot;
    const lay = findLayout(st, name);
    if (!lay) {
      this.ed.log(`Layout "${name}" not found.`);
      return false;
    }
    if (layoutsOf(st).length <= 1) {
      // AutoCAD keeps at least one layout: deleting the last one resets it.
      this.ed.doc.transact((s) => ({ ...withLayout(s, defaultLayout(lay.name, unitsOfHost(s)), lay.name), ...(s.space ? { space: undefined } : {}) }));
      this.ed.log(`Layout "${lay.name}" reset (a drawing keeps at least one layout).`);
      return true;
    }
    const wasActive = this.space?.layout.toUpperCase() === lay.name.toUpperCase();
    if (wasActive && this.ed.tool) this.ed.cancel();
    this.ed.doc.transact((s) => {
      const list = layoutsOf(s).filter((l) => l.name !== lay.name);
      const next: DrawingState = { ...s, layouts: list };
      if (!wasActive) return next;
      const { space: _drop, ...rest } = next;
      return rest;
    });
    if (this.lastLayout.toUpperCase() === lay.name.toUpperCase()) this.lastLayout = layoutsOf(this.ed.doc.snapshot)[0]?.name ?? 'Layout1';
    this.ed.log(`Layout "${lay.name}" deleted.`);
    return true;
  }

  renameLayout(from: string, to: string): boolean {
    const st = this.ed.doc.snapshot;
    const lay = findLayout(st, from);
    const n = to.trim();
    if (!lay) {
      this.ed.log(`Layout "${from}" not found.`);
      return false;
    }
    if (!validLayoutName(n)) {
      this.ed.log(`Invalid layout name "${n}".`);
      return false;
    }
    const clash = findLayout(st, n);
    if (clash && clash !== lay) {
      this.ed.log(`Layout "${n}" already exists.`);
      return false;
    }
    this.ed.doc.transact((s) => {
      const next = withLayout(s, { ...lay, name: n }, lay.name);
      return s.space?.layout.toUpperCase() === lay.name.toUpperCase() ? { ...next, space: { ...s.space, layout: n } } : next;
    });
    if (this.lastLayout.toUpperCase() === lay.name.toUpperCase()) this.lastLayout = n;
    return true;
  }

  /** Move a layout tab to position `index` among the layouts. */
  moveLayout(name: string, index: number): void {
    this.ed.doc.transact((s) => {
      const list = [...layoutsOf(s)];
      const i = list.findIndex((l) => l.name.toUpperCase() === name.toUpperCase());
      if (i < 0) return s;
      const [lay] = list.splice(i, 1);
      list.splice(Math.max(0, Math.min(list.length, index)), 0, lay!);
      return { ...s, layouts: list };
    });
  }

  /** LAYOUTWIZARD / LAYOUT Template: a layout with paper, optional sheet border + title block and one viewport. */
  createFromWizard(o: WizardOptions): string | null {
    const st = this.ed.doc.snapshot;
    const name = o.name.trim() || uniqueLayoutName(st);
    if (!validLayoutName(name) || findLayout(st, name)) {
      this.ed.log(findLayout(st, name) ? `Layout "${name}" already exists.` : `Invalid layout name "${name}".`);
      return null;
    }
    const base = { ...defaultLayout(name, o.paper.units), paper: o.paper, pristine: false };
    const sheet = sheetSize(base);
    const mm = o.paper.units === 'mm';
    const k = mm ? 25.4 : 1;
    let entities: Entity[] = [];
    let area: Bounds = printableArea(base);
    if (o.titleBlock) {
      const size: SheetSize = { key: 'custom', name, width: sheet.width / k, height: sheet.height / k };
      entities = sheetEntities(size, o.fields ?? {});
      if (mm) entities = entities.map((e) => scaleEntityBy(e, { x: 0, y: 0 }, k));
      // Viewport inside the border, above the title block (1.5 in tall, see TITLE_BLOCK).
      const m = 0.5 * k;
      area = { min: { x: m + 0.1 * k, y: m + 1.6 * k }, max: { x: sheet.width - m - 0.1 * k, y: sheet.height - m - 0.1 * k } };
      if (area.max.y - area.min.y < sheet.height * 0.3) area = { min: { x: m, y: m }, max: { x: sheet.width - m, y: sheet.height - m } };
    } else {
      const inset = 0.25 * k;
      area = { min: { x: area.min.x + inset, y: area.min.y + inset }, max: { x: area.max.x - inset, y: area.max.y - inset } };
    }
    const scale = o.scale === 'fit' ? undefined : (parseScale(o.scale) ?? undefined);
    const vp = makeViewport(area.min, area.max, VIEWPORT_LAYER.name, modelExtents(this.ed), scale);
    const layout: Layout = { ...base, entities, viewports: [vp] };
    this.ed.doc.ensureBlocks([TITLE_BLOCK]);
    this.ed.doc.transact((s) => ({
      ...s,
      layers: withRequiredLayers(s.layers, o.titleBlock),
      layouts: [...layoutsOf(s), layout],
    }));
    return name;
  }

  setViewportScale(ids: readonly string[] | null, scale: number): number {
    const lay = this.layout;
    if (!lay) return 0;
    let n = 0;
    this.editLayout(lay.name, (l) => ({
      ...l,
      viewports: l.viewports.map((v) => {
        if (ids && !ids.includes(v.id)) return v;
        if (v.view.locked) return v;
        n += 1;
        return { ...v, view: { ...v.view, scale } };
      }),
    }));
    return n;
  }
}

function withRequiredLayers(layers: DrawingState['layers'], border: boolean): DrawingState['layers'] {
  const out = [...layers];
  if (!out.some((l) => l.name === VIEWPORT_LAYER.name)) out.push(VIEWPORT_LAYER);
  if (border && !out.some((l) => l.name === 'BORDER')) out.push({ name: 'BORDER', color: 7, visible: true, locked: false, lineWeight: 0.5 });
  return out;
}

/** Model-space extents of the drawing (whatever space is active), visible layers only. */
export function modelExtents(ed: Editor): Bounds | null {
  const st = ed.doc.snapshot;
  const hidden = new Set(st.layers.filter((l) => !l.visible).map((l) => l.name));
  let b: Bounds | null = null;
  for (const e of st.entities) if (!hidden.has(e.layer)) b = g.unionBounds(b, entityBounds(e, ed.doc.lookupBlock));
  return b;
}

/** First activation of a layout: one viewport filling the printable area, zoomed to the model extents. */
export function initializeLayout(s: DrawingState, name: string, extents: Bounds | null): DrawingState {
  const lay = findLayout(s, name);
  if (!lay || !lay.pristine) return s;
  const area = printableArea(lay);
  const sheet = sheetSize(lay);
  const inset = Math.min(sheet.width, sheet.height) * 0.02;
  const vp = makeViewport({ x: area.min.x + inset, y: area.min.y + inset }, { x: area.max.x - inset, y: area.max.y - inset }, VIEWPORT_LAYER.name, extents);
  const { pristine: _p, ...rest } = lay;
  const next = withLayout(s, { ...rest, viewports: [...lay.viewports, vp] });
  return { ...next, layers: withRequiredLayers(next.layers, false) };
}

// ------------------------------------------------------------------ commands

function listLayouts(ed: Editor): void {
  const c = layoutController(ed);
  ed.log(`Active layout: ${c.space ? c.space.layout : 'Model'}`);
  for (const l of layoutsOf(ed.doc.snapshot)) {
    const s = sheetSize(l);
    ed.log(`  ${l.name.padEnd(16)} ${paperLabel(l.paper)} ${l.paper.orientation}  ${+s.width.toFixed(2)} x ${+s.height.toFixed(2)} ${l.paper.units}  ${l.viewports.length} viewport(s)`);
  }
}

function layoutTool(ed: Editor, arg?: string) {
  const c = layoutController(ed);
  return scriptTool('LAYOUT', function* (ctx) {
    const kws = ['Copy', 'Delete', 'New', 'Template', 'Rename', 'Set', '?'];
    const parts = (arg ?? '').trim().split(/\s+/).filter(Boolean);
    let opt = parts.length ? (matchKeyword(parts[0]!, kws) ?? (parts[0] === '?' ? '?' : null)) : null;
    if (parts.length && !opt) {
      ctx.log(`Invalid option keyword: ${parts[0]}`);
      return;
    }
    if (!opt) opt = yield* keyword(ctx, 'Enter layout option [Copy/Delete/New/Template/Rename/Set/?] <set>:', kws, 'Set');
    if (!opt) return;
    const cur = c.space?.layout ?? c.lastLayout;
    const argAt = (i: number) => parts[i];
    const askName = function* (prompt: string, d: string) {
      return (yield* text(`${prompt} <${d}>:`, d)) ?? d;
    };
    switch (opt) {
      case '?':
        listLayouts(ed);
        return;
      case 'NEW': {
        const d = uniqueLayoutName(ed.doc.snapshot);
        const n = argAt(1) ?? (yield* askName('Enter name of new layout', d));
        const made = c.newLayout(n);
        if (made) ctx.log(`Layout "${made}" created.`);
        return;
      }
      case 'TEMPLATE': {
        const d = uniqueLayoutName(ed.doc.snapshot);
        const n = argAt(1) ?? (yield* askName('Enter layout name', d));
        const keys = SHEET_SIZES.map((s) => s.key);
        const sizeAns = argAt(2) ?? (yield* text(`Enter sheet size [${keys.join('/')}] <B>:`, 'B'));
        const size = SHEET_SIZES.find((s) => s.key.toUpperCase() === (sizeAns ?? 'B').toUpperCase()) ?? SHEET_SIZES[1]!;
        const metric = /^A\d$/i.test(size.key);
        const paper = metric
          ? { id: size.key.toLowerCase(), width: size.height * 25.4, height: size.width * 25.4, units: 'mm' as const, orientation: 'landscape' as const }
          : { id: ({ A: 'letter', B: 'tabloid', C: 'ansi-c', D: 'ansi-d' } as Record<string, string>)[size.key] ?? 'custom', width: size.height, height: size.width, units: 'in' as const, orientation: 'landscape' as const };
        const made = c.createFromWizard({ name: n, paper: { ...paper, width: Math.min(paper.width, paper.height), height: Math.max(paper.width, paper.height) }, scale: 'fit', titleBlock: true });
        if (made) {
          ctx.log(`Layout "${made}" created from the ${size.name.trim()} sheet template.`);
          c.activate(made, true);
        }
        return;
      }
      case 'COPY': {
        const src = argAt(1) ?? (yield* askName('Enter name of layout to copy', cur));
        const made = c.copyLayout(src, argAt(2));
        if (made) ctx.log(`Layout "${src}" copied to "${made}".`);
        return;
      }
      case 'DELETE': {
        const n = argAt(1) ?? (yield* askName('Enter name of layout to delete', cur));
        c.deleteLayout(n);
        return;
      }
      case 'RENAME': {
        const from = argAt(1) ?? (yield* askName('Enter layout to rename', cur));
        const to = argAt(2) ?? (yield* text('Enter new layout name:', null));
        if (!to) return;
        if (c.renameLayout(from, to)) ctx.log(`Layout "${from}" renamed to "${to}".`);
        return;
      }
      case 'SET': {
        const n = argAt(1) ?? (yield* askName('Enter layout to make current', cur));
        if (/^model$/i.test(n)) c.activate(null, true);
        else c.activate(n, true);
        return;
      }
    }
  });
}

/** Frames among ids (viewports of the active layout). */
function selectedViewports(ed: Editor, ids: readonly string[]): LayoutViewport[] {
  const lay = activeLayout(ed.doc.snapshot);
  if (!lay) return [];
  const set = new Set(ids);
  return lay.viewports.filter((v) => set.has(v.id));
}

function mviewTool(ed: Editor, arg?: string) {
  const c = layoutController(ed);
  return scriptTool('MVIEW', function* (ctx) {
    const kws = ['ON', 'OFF', 'Fit', 'Lock', 'Restore'];
    const lay = c.layout;
    if (!lay) return;
    let first: string | null = arg ? (matchKeyword(arg, kws) ?? null) : null;
    let a: Point | null = null;
    if (!first) {
      const r = yield* pointOrKeyword('Specify corner of viewport or [ON/OFF/Fit/Lock] <Fit>:', kws, { trackFrom: null });
      if (!r) first = 'FIT';
      else if ('point' in r) a = r.point;
      else if ('keyword' in r) first = r.keyword;
      else {
        ctx.log(`Invalid option keyword: ${r.text}`);
        return;
      }
    }
    const extents = modelExtents(ed);
    const addViewport = (p: Point, q: Point) => {
      const vp = makeViewport(p, q, VIEWPORT_LAYER.name, extents);
      ed.doc.transact((s) => {
        const l = findLayout(s, lay.name);
        if (!l) return s;
        return { ...withLayout(s, { ...l, viewports: [...l.viewports, vp] }), layers: withRequiredLayers(s.layers, false) };
      });
      ctx.log(`Viewport created at ${formatScale(vp.view.scale)}.`);
    };
    if (a) {
      const from = a;
      const b = yield* point(ctx, 'Specify opposite corner:', {
        trackFrom: from,
        preview: (cur) => [{ id: 'mv', layer: '0', color: 5, type: 'polyline', closed: true, points: [from, { x: cur.x, y: from.y }, cur, { x: from.x, y: cur.y }] }],
      });
      if (!b || Math.abs(b.x - from.x) < 1e-9 || Math.abs(b.y - from.y) < 1e-9) return;
      addViewport(from, b);
      return;
    }
    if (first === 'FIT') {
      const area = printableArea(lay);
      addViewport(area.min, area.max);
      return;
    }
    if (first === 'ON' || first === 'OFF' || first === 'LOCK') {
      let lockOn = true;
      if (first === 'LOCK') {
        const k = yield* keyword(ctx, 'Viewport View Locking [ON/OFF]:', ['ON', 'OFF']);
        if (!k) return;
        lockOn = k === 'ON';
      }
      const ids = yield* select(ctx, 'Select objects:');
      const vps = selectedViewports(ed, ids);
      if (!vps.length) {
        ctx.log('No viewports selected.');
        return;
      }
      const set = new Set(vps.map((v) => v.id));
      c.editLayout(lay.name, (l) => ({
        ...l,
        viewports: l.viewports.map((v) => (!set.has(v.id) ? v : first === 'LOCK' ? { ...v, view: { ...v.view, locked: lockOn } } : { ...v, on: first === 'ON' })),
      }));
      ctx.log(`${vps.length} viewport(s) ${first === 'LOCK' ? (lockOn ? 'locked' : 'unlocked') : `turned ${first === 'ON' ? 'on' : 'off'}`}.`);
      return;
    }
    ctx.log('Restore is not available: use MVIEW with two corners or Fit.');
  });
}

function scaleTool(ed: Editor, name: string, arg?: string) {
  const c = layoutController(ed);
  return scriptTool(name, function* (ctx) {
    const lay = c.layout;
    if (!lay) return;
    const act = activeViewport(ed.doc.snapshot);
    let ids: string[] | null = act ? [act.viewport.id] : null;
    if (!ids) {
      const picked = selectedViewports(ed, [...ed.selection]).map((v) => v.id);
      ids = picked.length ? picked : null;
    }
    const cur = act?.viewport.view.scale ?? (ids ? lay.viewports.find((v) => v.id === ids![0])?.view.scale : lay.viewports[0]?.view.scale) ?? 1;
    let raw = arg ?? null;
    if (!raw) {
      ctx.log(`Current viewport scale: ${formatScale(cur)} (${cur.toFixed(4)} paper units per model unit)`);
      if (!lay.viewports.length) return;
      raw = yield* text(`Enter viewport scale (1:4, 2:1, 0.5XP) or [${STANDARD_SCALES.slice(0, 6).join('/')}] <${formatScale(cur)}>:`, null, false);
      if (!raw) return;
    }
    const k = parseScale(raw);
    if (!k) {
      ctx.log(`Invalid scale "${raw}".`);
      return;
    }
    const n = c.setViewportScale(ids, k);
    ctx.log(n ? `${n} viewport(s) set to ${formatScale(k)}.` : 'No unlocked viewport to scale.');
  });
}

export function registerLayoutCommands(ed: Editor): void {
  const c = layoutController(ed);
  c.install();
  const reg = (name: string, aliases: string[], description: string, run: (ed: Editor, arg?: string) => void, startsTool = false) =>
    ed.register({ name, aliases, description, run, startsTool });
  const needLayout = (e: Editor): boolean => {
    if (layoutController(e).space) return true;
    e.log(NOT_IN_MODEL);
    return false;
  };
  reg('LAYOUT', ['LO'], 'Layouts: [Copy/Delete/New/Template/Rename/Set/?]', (e, arg) => e.startTool(layoutTool(e, arg)), true);
  reg('LAYOUTWIZARD', [], 'Create a layout: paper, orientation, scale and title block', (e) => {
    const lc = layoutController(e);
    if (lc.ui.wizard) lc.ui.wizard();
    else e.runCommand('LAYOUT T');
  });
  reg('MSPACE', ['MS'], 'Make a floating viewport current (model space in a layout)', (e) => {
    const lc = layoutController(e);
    if (!needLayout(e)) return;
    if (lc.mode === 'viewport') return;
    const lay = lc.layout!;
    const target = lay.viewports.find((v) => v.on);
    if (!target) {
      e.log('** No active viewports. ** Create one with MVIEW.');
      return;
    }
    lc.enterViewport(target.id);
  });
  reg('PSPACE', ['PS'], 'Return to paper space from a floating viewport', (e) => {
    const lc = layoutController(e);
    if (!needLayout(e)) return;
    lc.exitToPaper();
  });
  reg('MODEL', [], 'Switch to the Model tab', (e) => void layoutController(e).activate(null));
  reg('TILEMODE', [], 'TILEMODE 1 = Model tab, 0 = the last layout', (e, arg) => {
    const lc = layoutController(e);
    if (arg === undefined) {
      e.log(`TILEMODE = ${lc.space ? 0 : 1}  (enter TILEMODE 0 or 1)`);
      return;
    }
    const v = arg.trim();
    if (v === '1') lc.activate(null);
    else if (v === '0') lc.activate(findLayout(e.doc.snapshot, lc.lastLayout) ? lc.lastLayout : layoutsOf(e.doc.snapshot)[0]!.name);
    else e.log('TILEMODE must be 0 or 1.');
  });
  reg('MVIEW', ['MV'], 'Floating viewports: two corners, [ON/OFF/Fit/Lock]', (e, arg) => {
    const lc = layoutController(e);
    if (!needLayout(e)) return;
    if (lc.mode === 'viewport') lc.exitToPaper();
    e.startTool(mviewTool(e, arg));
  }, true);
  reg('MVSETUP', [], 'Viewport setup: [Create/Scale viewports]', (e, arg) => {
    const lc = layoutController(e);
    if (!needLayout(e)) return;
    if (arg && /^s/i.test(arg)) return e.startTool(scaleTool(e, 'MVSETUP', arg.replace(/^\S+\s*/, '') || undefined));
    e.startTool(
      scriptTool('MVSETUP', function* (ctx) {
        const k = yield* keyword(ctx, 'Enter an option [Create/Scale viewports] <Scale viewports>:', ['Create', 'Scale viewports'], 'Scale viewports');
        if (k === 'CREATE') {
          if (lc.mode === 'viewport') lc.exitToPaper();
          e.runCommand('MVIEW F');
        } else if (k) e.startTool(scaleTool(e, 'MVSETUP'));
      }),
    );
  }, true);
  reg('VPSCALE', [], 'Viewport scale of the current or selected viewports', (e, arg) => {
    if (!needLayout(e)) return;
    e.startTool(scaleTool(e, 'VPSCALE', arg));
  }, true);
  reg('PAGESETUP', [], 'Page setup of the current layout (paper, orientation, scale, margins, plot style)', (e, arg) => {
    const lc = layoutController(e);
    const name = arg?.trim() || lc.space?.layout || lc.lastLayout;
    if (!findLayout(e.doc.snapshot, name)) {
      e.log(`Layout "${name}" not found.`);
      return;
    }
    if (lc.ui.pageSetup) lc.ui.pageSetup(name);
    else listLayouts(e);
  });
  reg('CANNOSCALE', ['ANNOSCALE'], 'Annotation scale: annotative objects display at 1 / scale in model space', (e, arg) => {
    const cur = e.doc.header.cannoscale ?? '1:1';
    if (!arg) {
      e.log(`CANNOSCALE = "${cur}"  (enter CANNOSCALE 1:4; scales: ${STANDARD_SCALES.join(', ')})`);
      return;
    }
    setAnnotationScale(e, arg.trim());
  });
  reg('ANNOALLVISIBLE', [], 'Show annotative objects at every viewport scale (1) or only at the annotation scale (0)', (e, arg) => {
    const cur = e.doc.header.annoAllVisible === false ? 0 : 1;
    if (arg === undefined) {
      e.log(`ANNOALLVISIBLE = ${cur}  (enter ANNOALLVISIBLE 0 or 1)`);
      return;
    }
    if (arg.trim() !== '0' && arg.trim() !== '1') return e.log('ANNOALLVISIBLE must be 0 or 1.');
    e.doc.setHeader({ annoAllVisible: arg.trim() === '1' });
    e.render();
  });
  reg('OBJECTSCALE', ['ANNOTATIVE'], 'Make selected text, dimensions, leaders and blocks annotative (or not)', (e, arg) => {
    e.startTool(
      scriptTool('OBJECTSCALE', function* (ctx) {
        const ids = yield* select(ctx, 'Select annotative objects:');
        if (!ids.length) return;
        const set = new Set(ids);
        const targets = e.doc.entities.filter((x) => set.has(x.id) && canBeAnnotative(x));
        if (!targets.length) {
          ctx.log('No text, dimension, leader or block reference selected.');
          return;
        }
        let mode = arg ? matchKeyword(arg, ['ON', 'OFF', 'Toggle']) : null;
        if (!mode) mode = yield* keyword(ctx, 'Annotative [ON/OFF/Toggle] <Toggle>:', ['ON', 'OFF', 'Toggle'], 'Toggle');
        if (!mode) return;
        const next = targets.map((x) => ({ ...x, annotative: mode === 'ON' ? true : mode === 'OFF' ? false : !x.annotative }) as Entity);
        e.doc.replaceEntities(next);
        const on = next.filter((x) => x.annotative).length;
        ctx.log(`${targets.length} object(s) updated: ${on} annotative (paper height kept at CANNOSCALE ${e.doc.header.cannoscale ?? '1:1'}).`);
      }),
    );
  }, true);
}

/** CANNOSCALE: set the drawing's annotation scale (and, in a floating viewport, the viewport scale as AutoCAD couples them). */
export function setAnnotationScale(ed: Editor, name: string): boolean {
  const k = parseScale(name);
  if (!k) {
    ed.log(`Invalid annotation scale "${name}".`);
    return false;
  }
  const label = /:/.test(name) ? name.replace(/\s+/g, '') : formatScale(k);
  ed.doc.setHeader({ cannoscale: label });
  // Keep the (older) annotationScale setting in step with the drawing's CANNOSCALE.
  ed.settings = { ...ed.settings, annotationScale: label };
  ed.persistSettings();
  const c = layoutController(ed);
  const act = activeViewport(ed.doc.snapshot);
  if (c.mode === 'viewport' && act && !act.viewport.view.locked && Math.abs(act.viewport.view.scale - k) > 1e-12) c.setViewportScale([act.viewport.id], k);
  ed.log(`CANNOSCALE = "${label}"`);
  ed.notify('space');
  ed.render();
  return true;
}

/** Annotation scale value of the drawing (paper units per model unit). */
export const annotationScaleOf = (ed: Editor): number => cannoscaleValue(ed.doc.header.cannoscale);

/** Paper-space entities or viewport frames among a list (for tests / UI). */
export const frameIds = (list: readonly Entity[]): string[] => list.filter(isViewportFrame).map((e) => e.id);

