import { describe, it, expect } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import type { Entity, TextEntity, InsertEntity, PolylineEntity } from '../src/core/entities';
import { translateEntity, moveGrip } from '../src/core/entities';
import {
  activeLayout,
  annotativeEntity,
  annotativeScaleFor,
  applyPaperEntities,
  defaultLayout,
  fitViewportView,
  formatScale,
  layoutsOf,
  makeViewport,
  modelToPaper,
  paperEntities,
  paperFor,
  paperFromMediaName,
  paperFromSize,
  paperToModel,
  parseScale,
  printableArea,
  sheetInches,
  sheetSize,
  isViewportFrame,
  validLayoutName,
  type Layout,
  type LayoutViewport,
} from '../src/core/layouts';
import { Viewport } from '../src/render/viewport';
import { LayoutController, initializeLayout } from '../src/tools/layouts';
import type { Editor } from '../src/app/editor';
import { referencedBlocks, unusedLayers } from '../src/tools/blocks';

const line = (id: string, x = 0): Entity => ({ id, layer: '0', color: 'ByLayer', type: 'line', a: { x, y: 0 }, b: { x: x + 10, y: 5 } });
const text = (id: string, h = 0.125): TextEntity => ({ id, layer: '0', color: 'ByLayer', type: 'text', position: { x: 1, y: 1 }, text: 'NOTE', height: h, rotation: 0, align: 'left' });

function vp(over: Partial<LayoutViewport> = {}): LayoutViewport {
  return { id: 'v1', center: { x: 5, y: 4 }, width: 8, height: 6, view: { center: { x: 50, y: 40 }, scale: 0.25 }, layer: 'VIEWPORTS', on: true, ...over };
}

function withLayoutState(entities: Entity[] = [line('m1')]): DrawingState {
  const lay: Layout = { ...defaultLayout('Layout1'), pristine: undefined, viewports: [vp()], entities: [text('p1')] };
  return { ...new Drawing({ entities }).snapshot, layouts: [lay] };
}

describe('layout model', () => {
  it('every drawing has the implicit Layout1 (tabloid landscape, inches)', () => {
    const d = new Drawing();
    const [l] = d.layouts;
    expect(d.layouts).toHaveLength(1);
    expect(l!.name).toBe('Layout1');
    expect(l!.pristine).toBe(true);
    expect(sheetSize(l!)).toEqual({ width: 17, height: 11 });
    expect(sheetInches(l!)).toEqual({ width: 17, height: 11 });
    const metric = layoutsOf({ entities: [], header: { units: { insunits: 4 } } })[0]!;
    expect(metric.paper).toMatchObject({ id: 'a3', units: 'mm' });
    expect(sheetSize(metric)).toEqual({ width: 420, height: 297 });
  });
  it('paper sizes: catalog lookup, custom sizes, AutoCAD media names, printable area', () => {
    expect(paperFromSize(17, 11, 'in').id).toBe('tabloid');
    expect(paperFromSize(297, 210, 'mm')).toMatchObject({ id: 'a4', orientation: 'landscape' });
    expect(paperFromSize(13, 19, 'in').id).toBe('custom');
    expect(paperFromMediaName('ANSI_B_(11.00_x_17.00_Inches)', 'landscape')).toMatchObject({ id: 'tabloid', width: 11, height: 17 });
    expect(paperFromMediaName('ISO_full_bleed_A3_(420.00_x_297.00_MM)', 'landscape')).toMatchObject({ id: 'a3', units: 'mm' });
    expect(paperFromMediaName('Weird paper', 'landscape')).toBeNull();
    expect(paperFor('a4', 'portrait', 'in').width).toBeCloseTo(210 / 25.4, 9);
    const lay = { ...defaultLayout('L'), margins: { left: 0.5, bottom: 0.25, right: 0.25, top: 0.75 } };
    expect(printableArea(lay)).toEqual({ min: { x: 0.5, y: 0.25 }, max: { x: 16.75, y: 10.25 } });
  });
  it('scales parse and format like AutoCAD scale lists', () => {
    expect(parseScale('1:4')).toBe(0.25);
    expect(parseScale('2:1')).toBe(2);
    expect(parseScale('0.5xp')).toBe(0.5);
    expect(parseScale('1=48')).toBeCloseTo(1 / 48, 12);
    expect(parseScale('abc')).toBeNull();
    expect(formatScale(0.25)).toBe('1:4');
    expect(formatScale(2)).toBe('2:1');
    expect(validLayoutName('Model')).toBe(false);
    expect(validLayoutName('A<B')).toBe(false);
    expect(validLayoutName('Sheet 2')).toBe(true);
  });
  it('viewport transforms map model space onto the paper at its scale', () => {
    const v = vp();
    expect(modelToPaper(v, { x: 50, y: 40 })).toEqual({ x: 5, y: 4 });
    expect(modelToPaper(v, { x: 54, y: 44 })).toEqual({ x: 6, y: 5 });
    expect(paperToModel(v, { x: 6, y: 5 })).toEqual({ x: 54, y: 44 });
    const fit = fitViewportView(v, { min: { x: 0, y: 0 }, max: { x: 80, y: 30 } }, 0);
    expect(fit.scale).toBeCloseTo(0.1, 12); // width-limited: 8 / 80
    expect(fit.center).toEqual({ x: 40, y: 15 });
    const made = makeViewport({ x: 1, y: 1 }, { x: 9, y: 7 }, 'VIEWPORTS', { min: { x: 0, y: 0 }, max: { x: 16, y: 12 } }, 0.5);
    expect(made).toMatchObject({ center: { x: 5, y: 4 }, width: 8, height: 6, view: { scale: 0.5, center: { x: 8, y: 6 } } });
  });
});

describe('paper-space editing through the Drawing', () => {
  it('in paper space the entity list is the layout (frames + paper entities); edits stay out of model space', () => {
    const d = new Drawing();
    d.load(withLayoutState());
    expect(d.entities.map((e) => e.id)).toEqual(['m1']);
    d.setSpace({ layout: 'Layout1' });
    expect(d.entities.map((e) => e.id)).toEqual(['v1', 'p1']);
    expect(isViewportFrame(d.entities[0]!)).toBe(true);
    d.addEntities([line('p2')]);
    expect(d.snapshot.entities.map((e) => e.id)).toEqual(['m1']);
    expect(activeLayout(d.snapshot)!.entities.map((e) => e.id)).toEqual(['p1', 'p2']);
    // Undo covers layout edits.
    d.undo();
    expect(activeLayout(d.snapshot)!.entities.map((e) => e.id)).toEqual(['p1']);
    d.redo();
    expect(activeLayout(d.snapshot)!.entities.map((e) => e.id)).toEqual(['p1', 'p2']);
    // Model space again.
    d.setSpace(undefined);
    expect(d.entities.map((e) => e.id)).toEqual(['m1']);
  });
  it('moving a frame moves the viewport with its view; stretching keeps the model where it is on the paper', () => {
    const d = new Drawing();
    d.load(withLayoutState());
    d.setSpace({ layout: 'Layout1' });
    const frame = d.entity('v1')!;
    d.replaceEntities([translateEntity(frame, { x: 2, y: 1 })]);
    let v = activeLayout(d.snapshot)!.viewports[0]!;
    expect(v.center).toEqual({ x: 7, y: 5 });
    expect(v.view.center).toEqual({ x: 50, y: 40 });
    // Stretch the right edge 2 units: centre moves 1, the view centre shifts 1 / scale = 4 model units.
    const f2 = d.entity('v1') as PolylineEntity;
    const pts = f2.points.map((p) => (p.x > 7 ? { x: p.x + 2, y: p.y } : p));
    d.replaceEntities([{ ...f2, points: pts } as Entity]);
    v = activeLayout(d.snapshot)!.viewports[0]!;
    expect(v.width).toBeCloseTo(10, 12);
    expect(v.center.x).toBeCloseTo(8, 12);
    expect(v.view.center.x).toBeCloseTo(54, 12);
    // The model point at the old left edge still maps to the same paper point.
    expect(modelToPaper(v, paperToModel({ ...v, center: { x: 7, y: 5 }, view: { center: { x: 50, y: 40 }, scale: 0.25 } }, { x: 3, y: 5 })).x).toBeCloseTo(3, 9);
  });
  it('a corner grip stretches the frame as a rectangle (opposite corner fixed)', () => {
    const d = new Drawing();
    d.load(withLayoutState());
    d.setSpace({ layout: 'Layout1' });
    const frame = d.entity('v1')!;
    // Corner 2 is the upper right (9,7); drag it to (11,8).
    const moved = moveGrip(frame, 2, { x: 11, y: 8 })!;
    expect((moved as PolylineEntity).points).toEqual([{ x: 1, y: 1 }, { x: 11, y: 1 }, { x: 11, y: 8 }, { x: 1, y: 8 }]);
    d.replaceEntities([moved]);
    const v = activeLayout(d.snapshot)!.viewports[0]!;
    expect(v).toMatchObject({ center: { x: 6, y: 4.5 }, width: 10, height: 7 });
    // The model point that was at the lower-left corner is still there.
    expect(paperToModel(v, { x: 1, y: 1 }).x).toBeCloseTo(50 - 4 / 0.25, 9);
  });
  it('erasing a frame deletes the viewport, copying it adds one, exploding keeps the lines', () => {
    const d = new Drawing();
    d.load(withLayoutState());
    d.setSpace({ layout: 'Layout1' });
    const frame = d.entity('v1')!;
    d.addEntities([{ ...translateEntity(frame, { x: 10, y: 0 }), id: 'v2' }], false);
    expect(activeLayout(d.snapshot)!.viewports.map((v) => v.id)).toEqual(['v1', 'v2']);
    expect(activeLayout(d.snapshot)!.viewports[1]!.view).toEqual(vp().view);
    d.removeEntities(['v1']);
    expect(activeLayout(d.snapshot)!.viewports.map((v) => v.id)).toEqual(['v2']);
    const l = activeLayout(d.snapshot)!;
    const plain = { ...(d.entity('v2') as PolylineEntity), id: 'x' } as PolylineEntity & { vport?: unknown };
    delete plain.vport;
    const next = applyPaperEntities(l, [plain, ...l.entities]);
    expect(next.viewports).toHaveLength(0);
    expect(next.entities.map((e) => e.id)).toEqual(['x', 'p1']);
    expect(applyPaperEntities(l, paperEntities(l))).toBe(l);
  });
  it('extents in paper space include the sheet', () => {
    const d = new Drawing();
    d.load(withLayoutState());
    d.setSpace({ layout: 'Layout1' });
    expect(d.extents()).toEqual({ min: { x: 0, y: 0 }, max: { x: 17, y: 11 } });
  });
  it('first activation creates one viewport in the printable area, zoomed to the model', () => {
    const s = initializeLayout(new Drawing({ entities: [line('m1')] }).snapshot, 'Layout1', { min: { x: 0, y: 0 }, max: { x: 10, y: 5 } });
    const l = layoutsOf(s)[0]!;
    expect(l.pristine).toBeUndefined();
    expect(l.viewports).toHaveLength(1);
    const v = l.viewports[0]!;
    expect(v.view.center).toEqual({ x: 5, y: 2.5 });
    expect(v.layer).toBe('VIEWPORTS');
    expect(s.layers.find((x) => x.name === 'VIEWPORTS')?.plot).toBe(false);
  });
});

describe('layouts in drawing-wide bookkeeping', () => {
  it('blocks and layers used only in paper space count as used (PURGE, save without unused library blocks)', () => {
    const tb: InsertEntity = { id: 'tb', layer: 'BORDER', color: 'ByLayer', type: 'insert', block: 'WD_TITLEBLOCK', position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: {} };
    const st = withLayoutState();
    const s: DrawingState = {
      ...st,
      layers: [...st.layers, { name: 'BORDER', color: 7, visible: true, locked: false, lineWeight: 0.5 }, { name: 'VIEWPORTS', color: 8, visible: true, locked: false, lineWeight: 0.25 }],
      layouts: st.layouts!.map((l) => ({ ...l, entities: [...l.entities, tb] })),
    };
    expect(referencedBlocks(s).has('WD_TITLEBLOCK')).toBe(true);
    expect(unusedLayers(s)).not.toContain('BORDER');
    expect(unusedLayers(s)).not.toContain('VIEWPORTS');
  });
});

describe('annotative scaling', () => {
  it('keeps the paper height: 1 / CANNOSCALE in model space, 1 / viewport scale in a viewport, 1 on paper', () => {
    const t = { ...text('a', 0.125), annotative: true };
    expect(annotativeScaleFor(t, 'model', 1, 0.25)).toBe(4);
    expect(annotativeScaleFor(t, 'viewport', 0.5, 0.25)).toBe(2);
    expect(annotativeScaleFor(t, 'paper', 0.5, 0.25)).toBe(1);
    expect(annotativeScaleFor(text('b'), 'model', 1, 0.25)).toBe(1);
    expect((annotativeEntity(t, 4) as TextEntity).height).toBe(0.5);
    const ins: InsertEntity = { id: 'i', layer: '0', color: 'ByLayer', type: 'insert', block: 'B', position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: {}, annotative: true };
    expect((annotativeEntity(ins, 2) as InsertEntity).scale).toBe(2);
    // On paper, text at 0.125 in a 1:4 viewport shows 0.5 model units tall = 0.125 paper units.
    const f = annotativeScaleFor(t, 'viewport', 0.25, 1);
    expect((annotativeEntity(t, f) as TextEntity).height * 0.25).toBeCloseTo(0.125, 12);
  });
});

// ------------------------------------------------------------------ controller with a headless editor

function fakeEditor(state: DrawingState): { ed: Editor; c: LayoutController; logs: string[]; vp: Viewport } {
  const doc = new Drawing();
  doc.load(state);
  const vp = new Viewport({ getContext: () => ({}) } as unknown as HTMLCanvasElement, doc);
  vp.width = 800;
  vp.height = 600;
  const logs: string[] = [];
  const listeners = new Map<string, Array<() => void>>();
  const ed = {
    doc,
    viewport: vp,
    tool: null,
    selection: new Set<string>(),
    settings: { annotationScale: '1:1' },
    layoutInput: {},
    log: (t: string) => logs.push(t),
    render: () => {},
    cancel: () => {},
    notify: (ev: string) => listeners.get(ev)?.forEach((f) => f()),
    on: (ev: string, fn: () => void) => {
      listeners.set(ev, [...(listeners.get(ev) ?? []), fn]);
      return () => {};
    },
    register: () => {},
    startTool: () => {},
    runCommand: () => {},
  } as unknown as Editor;
  const c = new LayoutController(ed);
  c.install();
  return { ed, c, logs, vp };
}

describe('layout controller (space switching, viewport zoom)', () => {
  it('activating a pristine layout initialises it; MSPACE maps the canvas through the viewport', () => {
    const { ed, c, vp } = fakeEditor(new Drawing({ entities: [line('m1'), line('m2', 30)] }).snapshot);
    vp.center = { x: 3, y: 3 };
    vp.scale = 20;
    expect(c.activate('Layout1')).toBe(true);
    expect(c.mode).toBe('paper');
    expect(vp.layoutPainter).not.toBeNull();
    const lay = activeLayout(ed.doc.snapshot)!;
    expect(lay.viewports).toHaveLength(1);
    // Paper view fits the sheet.
    expect(vp.center).toEqual({ x: 8.5, y: 5.5 });
    const paperScale = vp.scale;
    const v = lay.viewports[0]!;
    expect(c.enterViewport(v.id)).toBe(true);
    expect(c.mode).toBe('viewport');
    // Canvas transform = paper transform o viewport transform.
    expect(vp.scale).toBeCloseTo(paperScale * v.view.scale, 9);
    const m = { x: 12, y: 3 };
    const viaVp = vp.toScreen(m);
    const p = modelToPaper(v, m);
    expect(viaVp.x).toBeCloseTo(400 + (p.x - 8.5) * paperScale, 6);
    expect(viaVp.y).toBeCloseTo(300 - (p.y - 5.5) * paperScale, 6);
    // ZOOM Extents fits into the viewport rectangle.
    expect(vp.fitRect).not.toBeNull();
    // Zoom in the viewport: the viewport's view scale follows (unlocked).
    vp.zoomAt({ x: 400, y: 300 }, 2);
    ed.notify('view');
    const v2 = activeLayout(ed.doc.snapshot)!.viewports[0]!;
    expect(v2.view.scale).toBeCloseTo(v.view.scale * 2, 9);
    // Back to paper: the paper view is unchanged.
    c.exitToPaper();
    expect(vp.scale).toBeCloseTo(paperScale, 9);
    expect(vp.center).toEqual({ x: 8.5, y: 5.5 });
    // Model tab restores the model view.
    c.activate(null);
    expect(vp.center).toEqual({ x: 3, y: 3 });
    expect(vp.scale).toBe(20);
    expect(vp.layoutPainter).toBeNull();
  });
  it('views remembered per space are dropped when another document is loaded (tab switch, open)', () => {
    const { ed, c, vp } = fakeEditor(new Drawing({ entities: [line('m1')] }).snapshot);
    vp.center = { x: 100, y: 100 };
    vp.scale = 3;
    c.activate('Layout1');
    // Another drawing arrives in its Layout1 (as a session switch does) ...
    ed.doc.load({ ...withLayoutState([line('z', 500)]), space: { layout: 'Layout1' } });
    ed.notify('file');
    expect(vp.layoutPainter).not.toBeNull();
    // ... and its Model tab does not get the first drawing's model view.
    c.activate(null);
    expect(vp.center).not.toEqual({ x: 100, y: 100 });
    expect(vp.center.x).toBeCloseTo(505, 6);
  });
  it('a locked viewport keeps its view: zooming inside it zooms the paper', () => {
    const st = withLayoutState();
    const locked = { ...st, layouts: st.layouts!.map((l) => ({ ...l, viewports: l.viewports.map((v) => ({ ...v, view: { ...v.view, locked: true } })) })) };
    const { ed, c, vp } = fakeEditor(locked);
    c.activate('Layout1');
    const paperScale = vp.scale;
    c.enterViewport('v1');
    vp.zoomAt({ x: 400, y: 300 }, 2);
    ed.notify('view');
    expect(activeLayout(ed.doc.snapshot)!.viewports[0]!.view.scale).toBe(0.25);
    c.exitToPaper();
    expect(vp.scale).toBeCloseTo(paperScale * 2, 9);
  });
  it('new / copy / rename / delete layouts are undoable and keep the active space consistent', () => {
    const { ed, c } = fakeEditor(withLayoutState());
    expect(c.newLayout()).toBe('Layout2');
    expect(c.copyLayout('Layout1')).toBe('Layout1 (2)');
    expect(ed.doc.layouts.map((l) => l.name)).toEqual(['Layout1', 'Layout1 (2)', 'Layout2']);
    const copy = ed.doc.layouts[1]!;
    expect(copy.viewports[0]!.id).not.toBe('v1');
    c.activate('Layout1');
    expect(c.renameLayout('Layout1', 'Sheet A')).toBe(true);
    expect(ed.doc.space).toEqual({ layout: 'Sheet A' });
    expect(c.renameLayout('Sheet A', 'Model')).toBe(false);
    expect(c.deleteLayout('Sheet A')).toBe(true);
    expect(ed.doc.space).toBeUndefined();
    expect(ed.doc.layouts.map((l) => l.name)).toEqual(['Layout1 (2)', 'Layout2']);
    ed.doc.undo();
    expect(ed.doc.layouts.map((l) => l.name)).toEqual(['Sheet A', 'Layout1 (2)', 'Layout2']);
    // Undo also brings back the space the deleted layout was active in.
    expect(ed.doc.space).toEqual({ layout: 'Sheet A' });
    expect(c.setViewportScale(null, 0.5)).toBe(1);
    expect(ed.doc.layouts[0]!.viewports[0]!.view.scale).toBe(0.5);
  });
  it('the wizard builds a layout with a title block and one scaled viewport', () => {
    const { ed, c } = fakeEditor(new Drawing({ entities: [line('m1')] }).snapshot);
    const n = c.createFromWizard({ name: 'E-101', paper: paperFor('ansi-d', 'landscape'), scale: '1:2', titleBlock: true, fields: { TITLE: 'MOTOR CONTROL' } });
    expect(n).toBe('E-101');
    const l = ed.doc.layouts.find((x) => x.name === 'E-101')!;
    expect(sheetSize(l)).toEqual({ width: 34, height: 22 });
    expect(l.viewports[0]!.view.scale).toBe(0.5);
    const tb = l.entities.find((e) => e.type === 'insert') as InsertEntity;
    expect(tb.block).toBe('WD_TITLEBLOCK');
    expect(tb.attributes.TITLE).toBe('MOTOR CONTROL');
    expect(ed.doc.lookupBlock('WD_TITLEBLOCK')).toBeTruthy();
  });
});
