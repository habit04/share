import { afterEach, describe, expect, it, vi } from 'vitest';
import { Drawing } from '../src/core/document';
import type { Entity, TextEntity, BlockDef } from '../src/core/entities';
import { textCorners, textWidth, textBounds, distanceToEntity } from '../src/core/entities';
import * as g from '../src/core/geometry';
import { pickEntity, selectByPolygon } from '../src/core/selection';
import { activeViewport, defaultLayout, type LayoutViewport } from '../src/core/layouts';
import { Viewport, type ViewportOverlay } from '../src/render/viewport';
import { Editor } from '../src/app/editor';
import { selectTool } from '../src/tools/select';
import { ZoomWindowTool } from '../src/tools/edit';
import { fakeContext, drive } from './fake-context';
import { layoutController } from '../src/tools/layouts';

const props = { layer: '0', color: 'ByLayer' as const };
const overlay = (): ViewportOverlay => ({ preview: [], ghost: [], selection: new Set(), hover: null, selectionBox: null, snap: null, cursor: null, trackFrom: null, dynText: [], cursorMode: 'idle' });
function canvas() {
  const context = new Proxy({ measureText: () => ({ width: 20 }) } as Record<string, unknown>, {
    get(target, key: string) { return target[key] ?? (target[key] = vi.fn()); },
    set(target, key: string, value) { target[key] = value; return true; },
  });
  return { canvas: { width: 800, height: 600, getContext: () => context, getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }) } as unknown as HTMLCanvasElement, context };
}
function viewport() {
  const c = canvas(), vp = new Viewport(c.canvas, new Drawing());
  vp.width = 800; vp.height = 600; vp.scale = 40; vp.center = { x: 17, y: -11 };
  return { vp, ...c };
}
function closePoint(actual: g.Point, expected: g.Point) {
  expect(actual.x).toBeCloseTo(expected.x, 8); expect(actual.y).toBeCloseTo(expected.y, 8);
}
afterEach(() => vi.unstubAllGlobals());

describe('rotated canvas coordinates and fitting', () => {
  it.each([Math.PI / 2, -Math.PI / 3, 0.37])('round trips points, pans in screen pixels and anchors wheel zoom at twist %s', (twist) => {
    const { vp } = viewport(); vp.twist = twist;
    const model = { x: 19, y: -8 }, before = vp.toScreen(model);
    closePoint(vp.toWorld(before), model);
    const d = g.rotate(g.sub(model, vp.center), twist);
    closePoint(before, { x: 400 + d.x * 40, y: 300 - d.y * 40 });
    vp.panByPixels(51, -23);
    closePoint(vp.toScreen(model), g.add(before, { x: 51, y: -23 }));
    const anchor = { x: 127, y: 448 }, atAnchor = vp.toWorld(anchor);
    vp.zoomAt(anchor, 2.5); closePoint(vp.toWorld(anchor), atAnchor);
    vp.dispose();
  });
  it('includes all four screen corners in world culling bounds and fits rotated extents into an offset viewport', () => {
    const { vp } = viewport(); vp.twist = Math.PI / 4;
    const vb = vp.visibleBounds();
    for (const screen of [{ x: 0, y: 0 }, { x: 800, y: 0 }, { x: 800, y: 600 }, { x: 0, y: 600 }]) expect(g.pointInBounds(vp.toWorld(screen), vb)).toBe(true);
    vp.fitRect = { x: 130, y: 160, w: 380, h: 220 };
    const bounds = { min: { x: 2, y: -3 }, max: { x: 10, y: 1 } };
    vp.zoomToBounds(bounds, 0);
    closePoint(vp.toScreen(g.mid(bounds.min, bounds.max)), { x: 320, y: 270 });
    for (const p of [bounds.min, { x: 10, y: -3 }, bounds.max, { x: 2, y: 1 }]) {
      const s = vp.toScreen(p); expect(s.x).toBeGreaterThanOrEqual(130 - 1e-8); expect(s.x).toBeLessThanOrEqual(510 + 1e-8); expect(s.y).toBeGreaterThanOrEqual(160 - 1e-8); expect(s.y).toBeLessThanOrEqual(380 + 1e-8);
    }
    vp.dispose();
  });
  it('fits the exact view rectangle instead of its larger world-axis bounding box, and restores twist in Previous', () => {
    const { vp } = viewport(); vp.twist = 0.73;
    const a = vp.toWorld({ x: 200, y: 150 }), b = vp.toWorld({ x: 600, y: 450 });
    const previous = { center: vp.center, scale: vp.scale, twist: vp.twist }; vp.pushView();
    vp.zoomToPoints(g.viewBoxCorners(a, b, vp.twist), 0);
    expect(vp.scale).toBeCloseTo(previous.scale * 2, 8);
    closePoint(vp.toScreen(a), { x: 0, y: 0 }); closePoint(vp.toScreen(b), { x: 800, y: 600 });
    vp.twist = 0; expect(vp.popView()).toBe(true);
    expect(vp.twist).toBe(previous.twist); expect(vp.scale).toBe(previous.scale); closePoint(vp.center, previous.center);
    vp.dispose();
  });
  it('projects each grid intersection as a complete model point', () => {
    const { vp, context } = viewport(); vp.center = { x: 0, y: 0 }; vp.scale = 20; vp.width = 200; vp.height = 200; vp.twist = Math.PI / 4;
    vp.settings.gridStyle = 'dots'; vp.render(overlay());
    const p = vp.toScreen({ x: 1, y: 1 });
    expect(context.fillRect).toHaveBeenCalledWith(Math.round(p.x), Math.round(p.y), 1, 1);
    vp.dispose();
  });
});

describe('rotated rectangular selection', () => {
  const twist = Math.PI / 4;
  const world = (p: g.Point) => g.rotate(p, -twist);
  const inside: Entity = { ...props, id: 'inside', type: 'line', a: world({ x: 1, y: -1 }), b: world({ x: 3, y: -3 }) };
  const crossing: Entity = { ...props, id: 'crossing', type: 'line', a: world({ x: -1, y: -2 }), b: world({ x: 5, y: -2 }) };
  const outside: Entity = { ...props, id: 'outside', type: 'line', a: world({ x: -1, y: 0 }), b: world({ x: -1, y: -4 }) };
  const a = world({ x: 0, y: 0 }), b = world({ x: 4, y: -4 });
  it.each(['WINDOW', 'CROSSING'])('SELECT %s uses a screen rectangle and keeps its preview aligned', (mode) => {
    const ctx = fakeContext(); Object.defineProperty(ctx, 'viewTwist', { value: twist }); ctx.doc.addEntities([inside, crossing, outside]);
    const tool = selectTool(); tool.start(ctx); tool.onText(mode, ctx); tool.onPoint(a, ctx); tool.onMove(b, ctx);
    const preview = ctx.preview[0]!; expect(preview.type).toBe('polyline');
    if (preview.type === 'polyline') {
      const projected = preview.points.map((p) => g.rotate(p, twist));
      projected.forEach((p, i) => closePoint(p, [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: -4 }, { x: 0, y: -4 }][i]!));
    }
    tool.onPoint(b, ctx); tool.onEnter(ctx);
    expect([...ctx.selection]).toEqual(mode === 'WINDOW' ? ['inside'] : ['inside', 'crossing']);
  });
  it('BOX chooses Window/Crossing from view horizontal direction even when world X runs backward', () => {
    const angle = Math.PI / 2, world90 = (p: g.Point) => g.rotate(p, -angle);
    const ctx = fakeContext(); Object.defineProperty(ctx, 'viewTwist', { value: angle });
    ctx.doc.addEntities([{ ...props, id: 'full', type: 'line', a: world90({ x: 1, y: -1 }), b: world90({ x: 3, y: -3 }) }, { ...props, id: 'touch', type: 'line', a: world90({ x: -1, y: -2 }), b: world90({ x: 5, y: -2 }) }]);
    const start = world90({ x: 0, y: 0 }), end = world90({ x: 4, y: -4 }); expect(end.x).toBeLessThan(start.x);
    drive(selectTool(), ctx, ['BOX', start, end, '']); expect([...ctx.selection]).toEqual(['full']);
    drive(selectTool(), ctx, ['BOX', end, start, '']); expect([...ctx.selection]).toEqual(['full', 'touch']);
  });
  it('oriented TEXT, MTEXT and block attributes fit a rotated window and support a crossing window wholly inside text', () => {
    const t: TextEntity = { ...props, id: 'text', type: 'text', position: world({ x: 1, y: 1 }), rotation: -twist, height: 1, text: 'LABEL', align: 'left' };
    const block: BlockDef = { name: 'LABEL', basePoint: { x: 0, y: 0 }, entities: [], attributes: [{ tag: 'TAG', prompt: 'Tag', default: 'LABEL', position: { x: 0, y: 0 }, height: 1, rotation: 0, align: 'left' }] };
    const attribute: Entity = { ...props, id: 'attribute', type: 'insert', block: 'LABEL', position: t.position, rotation: -twist, scale: 1, attributes: { TAG: 'LABEL' } };
    const mtext: Entity = { ...props, id: 'mtext', type: 'mtext', position: t.position, text: 'LABEL', height: 1, width: 8, rotation: -twist, attachment: 7, lineSpacing: 1 };
    const lookup = (name: string) => name === block.name ? block : undefined;
    const width = textWidth('LABEL', 1), poly = g.viewBoxCorners(world({ x: 0.9, y: 0.9 }), world({ x: 1.1 + width, y: 2.1 }), twist);
    expect(selectByPolygon(poly, 'window', [t, mtext, attribute], lookup, new Set()).map((e) => e.id)).toEqual(['text', 'mtext', 'attribute']);
    const small = g.viewBoxCorners(world({ x: 1.2, y: 1.2 }), world({ x: 1.4, y: 1.4 }), twist);
    expect(selectByPolygon(small, 'crossing', [t, attribute], lookup, new Set()).map((e) => e.id)).toEqual(['text', 'attribute']);
    const outsideText = g.viewBoxCorners(world({ x: 0.3, y: 1.1 }), world({ x: 0.5, y: 1.3 }), twist);
    expect(selectByPolygon(outsideText, 'crossing', [t, attribute], lookup, new Set())).toEqual([]);
    expect(textCorners(t)).toHaveLength(4);
  });
  it('Zoom Window previews the same view rectangle and passes its exact corners to the fitting method', () => {
    const ctx = fakeContext(); Object.defineProperty(ctx, 'viewTwist', { value: twist }); const apply = vi.fn(); const tool = new ZoomWindowTool(apply);
    tool.start(ctx); tool.onPoint(a, ctx); tool.onMove(b, ctx); const preview = ctx.preview[0]!;
    tool.onPoint(b, ctx); expect(ctx.finished).toBe(true); expect(apply).toHaveBeenCalledWith(g.viewBoxCorners(a, b, twist));
    if (preview.type === 'polyline') expect(preview.points).toEqual(g.viewBoxCorners(a, b, twist));
  });
  it('picks oriented text and attributes without accepting empty corners of their world bounding box', () => {
    const t: TextEntity = { ...props, id: 'text', type: 'text', position: { x: 0, y: 0 }, rotation: Math.PI / 4, height: 1, text: 'LABEL', align: 'left' };
    const block: BlockDef = { name: 'LABEL', basePoint: { x: 0, y: 0 }, entities: [], attributes: [{ tag: 'TAG', prompt: 'Tag', default: 'LABEL', position: { x: 0, y: 0 }, height: 1, rotation: 0, align: 'left' }] };
    const attribute: Entity = { ...props, id: 'attribute', type: 'insert', block: 'LABEL', position: t.position, rotation: t.rotation, scale: 1, attributes: { TAG: 'LABEL' } };
    const lookup = (name: string) => name === block.name ? block : undefined;
    const emptyCorner = textBounds(t).min, inside = g.mid(textCorners(t)[0]!, textCorners(t)[2]!);
    expect(distanceToEntity(emptyCorner, t, lookup)).toBeGreaterThan(0.4);
    for (const entity of [t, attribute]) {
      expect(pickEntity(emptyCorner, [entity], lookup, 0.05, new Set())).toBeNull();
      expect(pickEntity(inside, [entity], lookup, 0.05, new Set())?.id).toBe(entity.id);
    }
  });
  it('rotated windows test the full tapered or constant wide-polyline footprint, including crossing windows within the filled strip', () => {
    const tapered: Entity = { ...props, id: 'tapered', type: 'polyline', points: [world({ x: 0, y: 0 }), world({ x: 4, y: 0 })], closed: false, widths: [{ start: 2, end: 4 }, { start: 0, end: 0 }] };
    const constant: Entity = { ...props, id: 'constant', type: 'polyline', points: [world({ x: 0, y: 0 }), world({ x: 4, y: 0 })], closed: false, width: 2 };
    const box = (a: g.Point, b: g.Point) => g.viewBoxCorners(world(a), world(b), twist);
    const lookup = () => undefined, entities = [tapered, constant];
    expect(selectByPolygon(box({ x: -1, y: -0.5 }, { x: 5, y: 0.5 }), 'window', entities, lookup, new Set())).toEqual([]);
    expect(selectByPolygon(box({ x: -1, y: -3 }, { x: 5, y: 3 }), 'window', entities, lookup, new Set()).map((e) => e.id)).toEqual(['tapered', 'constant']);
    expect(selectByPolygon(box({ x: 1, y: 0.7 }, { x: 2, y: 0.8 }), 'crossing', entities, lookup, new Set()).map((e) => e.id)).toEqual(['tapered', 'constant']);
    expect(selectByPolygon(box({ x: 1, y: 1.1 }, { x: 2, y: 1.2 }), 'crossing', entities, lookup, new Set()).map((e) => e.id)).toEqual(['tapered']);
    expect(selectByPolygon(box({ x: 1, y: 2.5 }, { x: 2, y: 2.8 }), 'crossing', entities, lookup, new Set())).toEqual([]);
  });
});

describe('editor input through a rotated view', () => {
  function editor() {
    vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {});
    const ed = new Editor(canvas().canvas); ed.viewport.requestRender = () => {}; ed.viewport.width = 800; ed.viewport.height = 600; ed.viewport.scale = 40; ed.viewport.center = { x: 0, y: 0 }; ed.viewport.twist = Math.PI / 4;
    ed.snap.osnap = false; ed.snap.gridSnap = false; ed.snap.ortho = false; ed.snap.polarTracking = false;
    ed.notify('view');
    return ed;
  }
  const event = (p: g.Point): MouseEvent => ({ clientX: p.x, clientY: p.y, button: 0, shiftKey: false, preventDefault: () => {} }) as MouseEvent;
  it('mouse drag Window/Crossing uses the displayed rectangle, while picks and typed model coordinates remain unchanged', () => {
    const ed = editor(), world = (p: g.Point) => ed.viewport.toWorld(p);
    ed.doc.addEntities([{ ...props, id: 'full', type: 'line', a: world({ x: 250, y: 250 }), b: world({ x: 550, y: 350 }) }, { ...props, id: 'touch', type: 'line', a: world({ x: 150, y: 300 }), b: world({ x: 650, y: 300 }) }]);
    ed.onMouseDown(event({ x: 200, y: 200 })); ed.onMouseMove(event({ x: 600, y: 400 })); ed.onMouseUp(event({ x: 600, y: 400 }));
    expect([...ed.selection]).toEqual(['full']);
    ed.selection.clear(); ed.onMouseDown(event({ x: 600, y: 400 })); ed.onMouseMove(event({ x: 200, y: 200 })); ed.onMouseUp(event({ x: 200, y: 200 })); expect([...ed.selection]).toEqual(['full', 'touch']);
    ed.selection.clear(); const endpoint = ed.doc.entities[0]!; if (endpoint.type === 'line') ed.onMouseDown(event(ed.viewport.toScreen(endpoint.a)));
    expect([...ed.selection]).toEqual(['full']); closePoint(ed.parsePoint('12,34')!, { x: 12, y: 34 });
    ed.viewport.dispose();
  });
  it('the registered ZOOM Window fits view corners and Previous restores the captured rotated view', () => {
    const ed = editor(), vp = ed.viewport, initial = { center: vp.center, scale: vp.scale, twist: vp.twist };
    const a = vp.toWorld({ x: 200, y: 150 }), b = vp.toWorld({ x: 600, y: 450 });
    ed.runCommand('ZOOM W'); ed.submitInput(`${a.x},${a.y}`); ed.submitInput(`${b.x},${b.y}`);
    expect(vp.scale).toBeCloseTo(initial.scale * 2 / 1.04, 8);
    ed.runCommand('ZOOM P'); expect(vp.scale).toBe(initial.scale); expect(vp.twist).toBe(initial.twist); closePoint(vp.center, initial.center);
    vp.dispose();
  });
  it('frozen viewport layers stay excluded from picks, object snaps and SELECT', () => {
    const ed = editor(), center = { x: 0, y: 0 };
    const v: LayoutViewport = { id: 'v1', center, width: 20, height: 16, layer: '0', on: true, frozenLayers: ['HIDDEN'], view: { center, scale: 1, twist: Math.PI / 4 } };
    ed.doc.load({ ...ed.doc.snapshot, entities: [{ ...props, id: 'hidden', layer: 'HIDDEN', type: 'line', a: center, b: { x: 1, y: 0 } }], layouts: [{ ...defaultLayout('Sheet'), pristine: undefined, viewports: [v] }], layers: [...ed.doc.layers, { name: 'HIDDEN', color: 1, visible: true, locked: false, lineWeight: 0.25 }], space: { layout: 'Sheet', viewport: 'v1' } });
    ed.notify('file'); ed.onMouseDown(event(ed.viewport.toScreen(center))); expect(ed.selection.size).toBe(0);
    ed.runCommand('SELECT'); ed.submitInput('ALL'); ed.pressEnter(); expect(ed.selection.size).toBe(0);
    ed.snap.osnap = true; ed.runCommand('LINE');
    const near = { x: 0.03, y: 0.02 }; ed.onMouseDown(event(ed.viewport.toScreen(near))); closePoint(ed.lastPoint!, near);
    ed.cancel(); ed.viewport.dispose();
  });
  it('VPTWIST changes selected unlocked paper frames, preserves entities, and supports undo and active viewport input', () => {
    const ed = editor(), center = { x: 0, y: 0 };
    const v: LayoutViewport = { id: 'v1', center, width: 20, height: 16, layer: '0', on: true, view: { center, scale: 1 } };
    const model: Entity = { ...props, id: 'model', type: 'line', a: center, b: { x: 1, y: 2 } };
    ed.doc.load({ ...ed.doc.snapshot, entities: [model], layouts: [{ ...defaultLayout('Sheet'), pristine: undefined, viewports: [v, { ...v, id: 'v2', view: { ...v.view, locked: true } }] }], space: { layout: 'Sheet' } }); ed.notify('file');
    ed.selection = new Set(['v1', 'v2']); ed.runCommand('VPTWIST 30');
    expect(ed.doc.layouts[0]!.viewports[0]!.view.twist).toBeCloseTo(Math.PI / 6, 10); expect(ed.doc.layouts[0]!.viewports[1]!.view.twist).toBeUndefined();
    expect(ed.doc.snapshot.entities).toEqual([model]); expect(ed.viewport.twist).toBe(0);
    ed.doc.undo(); expect(ed.doc.layouts[0]!.viewports[0]!.view.twist).toBeUndefined();
    ed.runCommand('MSPACE'); ed.runCommand('VPTWIST'); ed.submitInput('-90');
    expect(activeViewport(ed.doc.snapshot)!.viewport.view.twist).toBeCloseTo(Math.PI * 1.5, 10); expect(ed.viewport.twist).toBeCloseTo(Math.PI * 1.5, 10);
    const angle = ed.viewport.twist, scale = ed.viewport.scale;
    ed.runCommand('ZOOM I'); ed.runCommand('ZOOM P'); expect(ed.viewport.twist).toBe(angle); expect(ed.viewport.scale).toBe(scale);
    ed.runCommand('PSPACE'); expect(ed.viewport.twist).toBe(0); ed.viewport.dispose();
  });
  it('keeps Previous histories separate for Model, paper, and each floating viewport', () => {
    const ed = editor(), center = { x: 0, y: 0 }, c = layoutController(ed);
    const v: LayoutViewport = { id: 'v1', center, width: 20, height: 16, layer: '0', on: true, view: { center, scale: 1, twist: 0.47 } };
    ed.doc.load({ ...ed.doc.snapshot, layouts: [{ ...defaultLayout('Sheet'), pristine: undefined, viewports: [v, { ...v, id: 'v2', view: { ...v.view, twist: -0.93 } }] }], space: undefined }); ed.notify('file');
    const modelScale = ed.viewport.scale; ed.runCommand('ZOOM I');
    c.activate('Sheet'); const paperScale = ed.viewport.scale; ed.runCommand('ZOOM I');
    c.enterViewport('v1'); const firstScale = ed.viewport.scale; ed.runCommand('ZOOM P'); expect(ed.viewport.scale).toBe(firstScale); expect(ed.viewport.twist).toBe(v.view.twist);
    ed.runCommand('ZOOM I'); c.enterViewport('v2'); const secondScale = ed.viewport.scale;
    ed.runCommand('ZOOM P'); expect(ed.viewport.scale).toBe(secondScale); expect(ed.viewport.twist).toBe(-0.93);
    c.enterViewport('v1'); ed.runCommand('ZOOM P'); expect(ed.viewport.scale).toBeCloseTo(firstScale, 8); expect(ed.viewport.twist).toBe(v.view.twist);
    c.exitToPaper(); ed.runCommand('ZOOM P'); expect(ed.viewport.scale).toBeCloseTo(paperScale, 8); expect(ed.viewport.twist).toBe(0);
    c.activate(null); ed.runCommand('ZOOM P'); expect(ed.viewport.scale).toBe(modelScale); expect(ed.viewport.twist).toBe(0);
    ed.viewport.dispose();
  });
});
