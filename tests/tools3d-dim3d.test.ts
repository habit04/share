/**
 * DIM3D (src/tools3d/dimension3d-tool.ts): true 3D dimensions through the prompts (Aligned,
 * Linear with automatic / forced axes, Angular, the Plane option's Current / Face / 3Points, Text),
 * the rubber band, undo; ERASE, 3DMOVE and the 2D modify commands carrying dimensions; Properties
 * rows; and the editor routing (ALL, typed ids, a click in the 3D view, the docs replay).
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import type { LineEntity } from '../src/core/entities';
import { type Frame3, WORLD_XY_FRAME, dist3, v3 } from '../src/model3d/math';
import { addDimensions3D, addSolids, model3dOf, newSolid } from '../src/model3d/model';
import { primitiveMesh } from '../src/model3d/primitives';
import { dimension3dLocation, dimension3dMeasurement, dimension3dText, makeDimension3D } from '../src/model3d/dimension3d';
import type { Dimension3D, PrimitiveFeature } from '../src/model3d/types';
import { STANDARD_DIMSTYLE } from '../src/core/dimension';
import { autoLinearAxis, dimension3dTool, frameFrom3Points } from '../src/tools3d/dimension3d-tool';
import { move3dTool, resetTransformDefaults } from '../src/tools3d/transform';
import { dimension3dRows, mixedSelectionLabel, patchMixedSelection, setDimension3DText } from '../src/tools3d/properties';
import { EraseTool, MoveTool } from '../src/tools/modify';
import { MirrorTool } from '../src/tools/edit';
import { drive } from './fake-context';
import { drive3d, fake3dContext } from './helpers/context3d';
import { fakeViewport3d, screenOf } from './helpers/fake-viewport3d';
import type { Editor as EditorType } from '../src/app/editor';
import type { installExperimental3d as InstallType } from '../src/app/experimental-3d';
import { RIBBON } from '../src/ui/ribbon';
import { resetModellingDefaults } from '../src/tools3d/primitives';

const dims = (doc: Drawing): readonly Dimension3D[] => model3dOf(doc.snapshot).dimensions ?? [];
const last = (doc: Drawing): Dimension3D => dims(doc).at(-1)!;
const at = (x: number, y: number, z = 0): Frame3 => ({ ...WORLD_XY_FRAME, origin: v3(x, y, z) });
const box = (x0: number, y0: number, z0: number, w: number, d: number, h: number): PrimitiveFeature => ({ kind: 'box', frame: at(x0 + w / 2, y0 + d / 2, z0), width: w, depth: d, height: h });

describe('DIM3D prompts', () => {
  it('aligned in a tilted plane by 3 points, with a text override, rubber band and one undo step', async () => {
    const doc = new Drawing();
    const ctx = fake3dContext(doc);
    await drive3d(dimension3dTool(), ctx, ['P', '3P', '0,0,0', '1,0,1', '0,1,0', 'T', 'Gap <>', '0,0,0', '3,4,3', { move: { x: 1, y: 6 } }, '0,6,0']);
    const d = last(doc);
    expect(d.kind).toBe('aligned');
    expect(d.plane.zAxis.x).toBeCloseTo(-Math.SQRT1_2, 12);
    expect(d.plane.zAxis.z).toBeCloseTo(Math.SQRT1_2, 12);
    expect(dimension3dMeasurement(d)).toBeCloseTo(Math.sqrt(34), 12);
    expect(d.projected).toBeUndefined();
    expect(d.textOverride).toBe('Gap <>');
    expect(dimension3dText(d)).toBe('Gap 5.8310');
    expect(ctx.prompts).toContain('Specify measurement plane [Current/Face/3Points] <Current>:');
    expect(ctx.prompts[0]).toBe('Specify first extension line origin or [Linear/Angular/Plane/Text]:');
    expect(ctx.logs).toContain('Dimension text: Gap <>');
    expect(ctx.logs.at(-1)).toMatch(/^DIM3D: Aligned dimension in the 3 points plane \(Custom \(normal -0\.7071, 0\.0000, 0\.7071\)\)\. Dimension text = Gap 5\.8310 \(measured 5\.8310\)$/);
    // The rubber band showed the dimension while the location was asked, and is cleared at the end.
    expect(ctx.dimPreviews.length).toBeGreaterThan(0);
    expect(ctx.dimPreviews[0]![0]!.kind).toBe('aligned');
    expect(ctx.previewDims).toEqual([]);
    doc.undo();
    expect(doc.snapshot.model3d).toBeUndefined();
    doc.redo();
    expect(last(doc)).toEqual(d);
  });

  it('the default plane is the construction plane through the first point; off-plane points are projected', async () => {
    const doc = new Drawing();
    const ctx = fake3dContext(doc);
    await drive3d(dimension3dTool(), ctx, ['0,0,5', '3,4,5', '']);
    const flat = last(doc);
    expect(flat.plane.origin).toEqual(v3(0, 0, 5));
    expect(flat.projected).toBeUndefined();
    expect(dimension3dMeasurement(flat)).toBeCloseTo(5, 12);
    // Enter: a fifth of the length to the left of p1 -> p2.
    expect(flat.offset).toBeCloseTo(1, 12);
    await drive3d(dimension3dTool(), ctx, ['0,0,0', '3,4,2', '0,3']);
    const p = last(doc);
    expect(p.projected).toBe(true);
    expect(dimension3dText(p)).toBe('5.0000 (projected)');
    expect(ctx.logs.at(-1)).toBe('DIM3D: a point is off the measurement plane: the dimension measures the projected distance 5.0000. True 3D distance: 5.3852.');
  });

  it('linear: the axis follows the location (above / below: X, beside: Y) unless X or Y is typed', async () => {
    const doc = new Drawing();
    const ctx = fake3dContext(doc);
    await drive3d(dimension3dTool(), ctx, ['L', '0,0', '4,3', '2,6']);
    expect(last(doc)).toMatchObject({ kind: 'linear', axis: 'x' });
    expect(dimension3dMeasurement(last(doc))).toBeCloseTo(4, 12);
    await drive3d(dimension3dTool(), ctx, ['L', '0,0', '4,3', '7,1']);
    expect(last(doc).axis).toBe('y');
    expect(dimension3dMeasurement(last(doc))).toBeCloseTo(3, 12);
    await drive3d(dimension3dTool(), ctx, ['L', '0,0', '4,3', 'Y', '2,6']);
    expect(last(doc).axis).toBe('y');
    await drive3d(dimension3dTool(), ctx, ['L', '0,0', '4,3', '']);
    expect(last(doc).axis).toBe('x');
    expect(ctx.prompts).toContain('Specify dimension line location or [X/Y/Text] <default offset>:');
    expect(dims(doc)).toHaveLength(4);
    expect(autoLinearAxis({ x: 0, y: 0 }, { x: 4, y: 3 }, { x: 1, y: 1 })).toBe('x');
    expect(autoLinearAxis({ x: 0, y: 0 }, { x: 1, y: 3 }, { x: 0.5, y: 1 })).toBe('y');
  });

  it('angular: vertex, two endpoints and the side of the arc location', async () => {
    const doc = new Drawing();
    const ctx = fake3dContext(doc);
    await drive3d(dimension3dTool(), ctx, ['A', '0,0', '2,0', '0,2', { move: { x: 1, y: 1 } }, '1,1']);
    expect(last(doc).kind).toBe('angular');
    expect(dimension3dMeasurement(last(doc))).toBeCloseTo(Math.PI / 2, 12);
    expect(ctx.logs.at(-1)).toBe('DIM3D: Angular dimension in the World plane (XY at z = 0.0000). Dimension text = 90%%d (measured 90.00 degrees)');
    expect(ctx.dimPreviews.at(-1)![0]!.kind).toBe('angular');
    await drive3d(dimension3dTool(), ctx, ['A', '0,0', '2,0', '0,2', '-1,-1']);
    expect(dimension3dMeasurement(last(doc))).toBeCloseTo(1.5 * Math.PI, 12);
    // Enter: halfway round the angle from the first leg to the second.
    await drive3d(dimension3dTool(), ctx, ['A', '0,0', '2,0', '0,2', '']);
    expect(dimension3dMeasurement(last(doc))).toBeCloseTo(Math.PI / 2, 12);
    // A leg on the vertex or both legs one way are refused and asked again.
    await drive3d(dimension3dTool(), ctx, ['A', '0,0', '0,0,4', '2,0', '4,0', '0,3', '1,1']);
    expect(ctx.logs).toContain('That point coincides with the vertex in the measurement plane; pick another point.');
    expect(ctx.logs).toContain('Both legs have the same direction; pick a second endpoint on another line.');
    expect(dimension3dMeasurement(last(doc))).toBeCloseTo(Math.PI / 2, 12);
  });

  it('Face: the plane of a picked face (a click with its 3D hit, or a typed point looking down the plane normal)', async () => {
    const doc = new Drawing();
    const s = newSolid({ feature: box(0, 0, 0, 2, 2, 2), mesh: primitiveMesh(box(0, 0, 0, 2, 2, 2)) });
    doc.updateModel3D((m) => addSolids(m, [s]));
    const ctx = fake3dContext(doc);
    // A click on the front face (y = 0), as the 3D view records it.
    ctx.picks.push({ p2: { x: 9, y: 9 }, point: v3(1, 0, 1), ray: { origin: v3(1, -10, 1), dir: v3(0, 1, 0) }, hit: { id: s.id, t: 10, point: v3(1, 0, 1), normal: v3(0, -1, 0), triangle: 0 } });
    await drive3d(dimension3dTool(), ctx, ['P', 'F', { x: 9, y: 9 }, '0,0,0', '2,0,2', '1,0,3']);
    const d = last(doc);
    expect(d.plane.zAxis).toEqual(v3(0, -1, 0));
    expect(dimension3dMeasurement(d)).toBeCloseTo(Math.sqrt(8), 12);
    expect(d.projected).toBeUndefined();
    expect(ctx.logs).toContain('Measurement plane: the picked face (XZ at y = 0.0000).');
    // Typed: the top face under 1,1.
    await drive3d(dimension3dTool(), ctx, ['P', 'F', '5,5', '1,1', '0,0,2', '2,2,2', '0,2,2']);
    expect(ctx.logs).toContain('No solid face there; pick a face of a solid.');
    expect(last(doc).plane.zAxis).toEqual(v3(0, 0, 1));
    expect(last(doc).plane.origin.z).toBeCloseTo(2, 12);
    expect(dimension3dMeasurement(last(doc))).toBeCloseTo(Math.sqrt(8), 12);
  });

  it('refuses coincident points and collinear plane points, asking again; Enter at the first prompt ends', async () => {
    const doc = new Drawing();
    const ctx = fake3dContext(doc);
    await drive3d(dimension3dTool(), ctx, ['0,0,0', '0,0,5', '1,0,0', '']);
    expect(ctx.logs).toContain('The points coincide in the measurement plane; pick another second point.');
    expect(dimension3dMeasurement(last(doc))).toBeCloseTo(1, 12);
    await drive3d(dimension3dTool(), ctx, ['P', '3P', '0,0,0', '1,0,0', '2,0,0', '3P', '0,0,0', '1,0,0', '0,0,1', '0,0,0', '0,0,4', '']);
    expect(ctx.logs).toContain('The three points do not define a plane (they coincide or lie on one line).');
    expect(last(doc).plane.zAxis.y).toBeCloseTo(-1, 12);
    expect(dimension3dMeasurement(last(doc))).toBeCloseTo(4, 12);
    const before = dims(doc).length;
    await drive3d(dimension3dTool(), ctx, ['']);
    expect(dims(doc)).toHaveLength(before);
    expect(frameFrom3Points(v3(0, 0, 0), v3(0, 0, 0), v3(1, 0, 0))).toBeNull();
  });

  it('uses the current layer and dimension style', async () => {
    const doc = new Drawing();
    doc.addLayer({ ...doc.layers[0]!, name: 'DIMS' });
    doc.setCurrentLayer('DIMS');
    const ctx = fake3dContext(doc);
    await drive3d(dimension3dTool(), ctx, ['0,0', '2,0', '1,1']);
    expect(last(doc)).toMatchObject({ layer: 'DIMS', color: 'ByLayer', style: doc.header.dimStyle });
  });
});

describe('editing 3D dimensions', () => {
  const dimAt = (doc: Drawing): Dimension3D => {
    const d = makeDimension3D({ kind: 'aligned', plane: WORLD_XY_FRAME, p1: v3(0, 0, 0), p2: v3(4, 0, 0), location: v3(2, 1, 0), style: STANDARD_DIMSTYLE });
    doc.updateModel3D((m) => addDimensions3D(m, [d]));
    return d;
  };

  it('ERASE removes dimensions (one undo step) and keeps the 2D path otherwise', () => {
    const doc = new Drawing();
    const d = dimAt(doc);
    const line: LineEntity = { id: 'L1', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } };
    doc.addEntities([line]);
    const ctx = fake3dContext(doc);
    drive(new EraseTool(), ctx, [{ select: [d.id, 'L1'] }]);
    expect(doc.snapshot.model3d).toBeUndefined();
    expect(doc.entities).toHaveLength(0);
    doc.undo();
    expect(dims(doc)).toEqual([d]);
    expect(doc.entities).toHaveLength(1);
  });

  it('3DMOVE moves dimensions with solids; the 2D MOVE and MIRROR carry them in the drawing plane', async () => {
    resetTransformDefaults();
    const doc = new Drawing();
    const d = dimAt(doc);
    const ctx = fake3dContext(doc);
    await drive3d(move3dTool(), ctx, [{ select: [d.id] }, '0,0,0', '@1,2,3']);
    expect(ctx.logs).toContain('3DMOVE: 1 dimension moved.');
    expect(dist3(last(doc).p1, v3(1, 2, 3))).toBeCloseTo(0, 12);
    expect(last(doc).plane.origin).toEqual(v3(1, 2, 3));
    expect(dimension3dMeasurement(last(doc))).toBeCloseTo(4, 12);
    doc.undo();
    expect(last(doc)).toEqual(d);
    drive(new MoveTool(), ctx, [{ select: [d.id] }, { x: 0, y: 0 }, { x: 5, y: 0 }]);
    expect(last(doc).p2).toEqual(v3(9, 0, 0));
    expect(last(doc).id).toBe(d.id);
    ctx.selection = new Set(); // MOVE keeps its selection (2D behaviour)
    drive(new MirrorTool(), ctx, [{ select: [d.id] }, { x: 0, y: -5 }, { x: 0, y: 5 }, 'N']);
    expect(dims(doc)).toHaveLength(2);
    const copy = last(doc);
    expect(copy.id).not.toBe(d.id);
    expect(copy.p1.x).toBeCloseTo(-5, 12);
    expect(dimension3dMeasurement(copy)).toBeCloseTo(4, 12);
    // The mirrored dimension line stays on the same side (y = +1) of its points.
    expect(dimension3dLocation(copy).y).toBeCloseTo(1, 12);
  });

  it('Properties rows and the text override edit (one undo step)', () => {
    const doc = new Drawing();
    const d = dimAt(doc);
    const rows = dimension3dRows(d, doc.header.units);
    expect(rows.map((r) => [r.label, r.value])).toEqual([
      ['Type', '3D Dimension'], ['Kind', 'Aligned'], ['Measurement', '4.0000'], ['Text override', ''], ['Dimension text', '4.0000'],
      ['Layer', '0'], ['Color', 'ByLayer'], ['Plane', 'XY at z = 0.0000'],
    ]);
    expect(rows.filter((r) => r.edit).map((r) => r.edit)).toEqual(['text', 'layer', 'color']);
    expect(setDimension3DText(doc, d.id, 'L = <>')).toBe(true);
    expect(dimension3dText(last(doc))).toBe('L = 4.0000');
    expect(setDimension3DText(doc, d.id, 'L = <>')).toBe(false);
    doc.undo();
    expect(last(doc)).toEqual(d);
    expect(setDimension3DText(doc, 'nope', 'x')).toBe(false);
  });

  it('Properties on mixed selections: every group counted, Layer / Color edit all of them in one step', () => {
    const doc = new Drawing();
    doc.addLayer({ ...doc.layers[0]!, name: 'L2' });
    const d = dimAt(doc);
    const s = newSolid({ feature: box(0, 0, 0, 1, 1, 1), mesh: primitiveMesh(box(0, 0, 0, 1, 1, 1)) });
    doc.updateModel3D((m) => addSolids(m, [s]));
    const line: LineEntity = { id: 'L1', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, trueColor: 0x123456 };
    doc.addEntities([line]);
    expect(mixedSelectionLabel(1, 1, 1)).toBe('All (3: 1 object, 1 solid, 1 3D dimension)');
    expect(mixedSelectionLabel(0, 2, 3)).toBe('All (5: 2 solids, 3 3D dimensions)');
    const steps = doc.history().undo.length;
    patchMixedSelection(doc, [doc.entities[0]!], [s.id], [d.id], { layer: 'L2' });
    patchMixedSelection(doc, [doc.entities[0]!], [s.id], [d.id], { color: 3 });
    expect(doc.history().undo.length).toBe(steps + 2);
    expect(doc.entities[0]).toMatchObject({ layer: 'L2', color: 3 });
    expect(doc.entities[0]!.trueColor).toBeUndefined();
    expect(model3dOf(doc.snapshot).solids[0]).toMatchObject({ layer: 'L2', color: 3 });
    expect(last(doc)).toMatchObject({ layer: 'L2', color: 3 });
    doc.undo();
    doc.undo();
    expect(last(doc)).toEqual(d);
    expect(doc.entities[0]).toEqual(line);
  });
});

// ------------------------------------------------------------------ the editor (flag on)

let Editor: typeof EditorType;
let installExperimental3d: typeof InstallType;
beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  Editor = (await import('../src/app/editor')).Editor;
  ({ installExperimental3d } = await import('../src/app/experimental-3d'));
});
afterEach(() => {
  const i = RIBBON.findIndex((t) => t.name === '3D');
  if (i >= 0) RIBBON.splice(i, 1);
});
const canvas = () => ({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 }) as unknown as HTMLCanvasElement;

function editor() {
  resetModellingDefaults();
  resetTransformDefaults();
  const ed = new Editor(canvas());
  ed.settings = { ...ed.settings, experimental3d: true };
  const jcad3d = installExperimental3d(ed)!;
  const run = (c: string, ...xs: string[]) => {
    void ed.runCommand(c);
    for (const x of xs) ed.submitInput(x);
  };
  return { ed, jcad3d, run };
}

describe('DIM3D in the editor', () => {
  it('docs/3D-DIMENSIONS.md replay (Part 1, typed input)', () => {
    const { ed, jcad3d, run } = editor();
    const dimsNow = () => model3dOf(ed.doc.snapshot).dimensions ?? [];
    const has = (line: string) => expect(ed.history).toContain(line);
    // Aligned in a tilted plane (3 points: the plane x = z, normal (-1, 0, 1) / sqrt 2).
    run('DIM3D', 'P', '3P', '0,0,0', '1,0,1', '0,1,0', '0,0,0', '3,4,3', '0,6,0');
    has('DIM3D: Aligned dimension in the 3 points plane (Custom (normal -0.7071, 0.0000, 0.7071)). Dimension text = 5.8310 (measured 5.8310)');
    // Linear: the axis follows the location (above the points: X), then Y typed.
    run('DIM3D', 'L', '10,0', '14,3', '12,6');
    has('DIM3D: Linear (plane X) dimension in the World plane (XY at z = 0.0000). Dimension text = 4.0000 (measured 4.0000)');
    run('DIM3D', 'L', '10,0', '14,3', 'Y', '17,1');
    has('DIM3D: Linear (plane Y) dimension in the World plane (XY at z = 0.0000). Dimension text = 3.0000 (measured 3.0000)');
    // Angular: vertex, two endpoints, a point on the arc.
    run('DIM3D', 'A', '20,0', '22,0', '20,2', '21,1');
    has('DIM3D: Angular dimension in the World plane (XY at z = 0.0000). Dimension text = 90%%d (measured 90.00 degrees)');
    // Face plane: the top face of a box, picked by a typed point (looking down the plane normal).
    run('BOX', '30,0', '34,3', '2');
    run('DIM3D', 'P', 'F', '32,1', '30,0,2', '34,3,2', '30,4,2');
    has('Measurement plane: the picked face (XY at z = 2.0000).');
    has('DIM3D: Aligned dimension in the Face plane (XY at z = 2.0000). Dimension text = 5.0000 (measured 5.0000)');
    // Text override; Enter places the dimension line at a fifth of the length to the left.
    run('DIM3D', 'T', 'Gap <>', '50,0', '53,4', '');
    has('DIM3D: Aligned dimension in the World plane (XY at z = 0.0000). Dimension text = Gap 5.0000 (measured 5.0000)');
    // A projected measurement: the second point is 2 above the plane through the first.
    run('DIM3D', '40,0,0', '44,3,2', '');
    has('DIM3D: Aligned dimension in the World plane (XY at z = 0.0000). Dimension text = 5.0000 (projected) (measured 5.0000)');
    has('DIM3D: a point is off the measurement plane: the dimension measures the projected distance 5.0000. True 3D distance: 5.3852.');
    expect(dimsNow()).toHaveLength(7);
    expect(jcad3d.dimensionIds()).toEqual(dimsNow().map((d) => d.id));
    // UNDO removes the last one; ERASE by typed id; ALL selects dimensions too.
    void ed.runCommand('UNDO');
    expect(dimsNow()).toHaveLength(6);
    run('ERASE', jcad3d.dimensionIds()[0]!, '');
    expect(dimsNow()).toHaveLength(5);
    run('3DMOVE', 'ALL', '', '0,0,0', '@0,0,10');
    has('3DMOVE: 1 solid and 5 dimensions moved.');
    // The interim 3DDIM labels its projection.
    run('3DDIM', '40,0,0', '44,3,2', '');
    expect(ed.doc.entities.filter((e) => e.type === 'dimension').at(-1)).toMatchObject({ text: '<> (projected)' });
    has('Dimension text = 5.0000 (projected) (measured 5.0000, projected; true 3D distance 5.3852)');
  });

  it('in 3D mode: the rubber band reaches the viewport, a click selects a dimension, the hover highlights it', () => {
    const { ed, jcad3d: c } = editor();
    const vp = fakeViewport3d(ed.doc);
    c.viewport = vp;
    void ed.runCommand('DIM3D');
    const click = (x: number, y: number) => {
      const p = screenOf(x, y);
      c.click(p.x, p.y, false);
    };
    click(0, 0);
    click(10, 0);
    const p = screenOf(5, 3);
    c.hoverAt(p.x, p.y);
    expect(c.previewDimensions).toHaveLength(1);
    expect(vp.overlays.at(-1)?.previewDimensions).toHaveLength(1);
    click(5, 3);
    expect(c.previewDimensions).toEqual([]);
    const id = c.dimensionIds()[0]!;
    expect(ed.tool).toBeNull();
    // A click on the dimension line (y = 3) selects the dimension.
    click(5, 3);
    expect([...ed.selection]).toEqual([id]);
    click(5, 30);
    expect(ed.selection.size).toBe(0);
    expect(vp.pick(screenOf(2, 3).x, screenOf(2, 3).y)).toBe(id);
    expect(c.dimensionPoint(id)).toEqual(v3(5, 3, 0));
    expect(c.dimensionPoint('nope')).toBeNull();
    c.viewport = null;
  });

  it('in 3D mode: a dimension hidden under a solid is not picked through it', () => {
    const { ed, jcad3d: c } = editor();
    const s = newSolid({ feature: box(0, 0, 0, 10, 10, 5), mesh: primitiveMesh(box(0, 0, 0, 10, 10, 5)) });
    const under = makeDimension3D({ kind: 'aligned', plane: WORLD_XY_FRAME, p1: v3(1, 1, 0), p2: v3(9, 1, 0), location: v3(5, 3, 0), style: STANDARD_DIMSTYLE });
    const onTop = makeDimension3D({ kind: 'aligned', plane: at(0, 0, 5), p1: v3(1, 6, 5), p2: v3(9, 6, 5), location: v3(5, 8, 5), style: STANDARD_DIMSTYLE });
    ed.doc.updateModel3D((m) => addDimensions3D(addSolids(m, [s]), [under, onTop]));
    const vp = fakeViewport3d(ed.doc);
    c.viewport = vp;
    const at2 = (x: number, y: number) => vp.pick(screenOf(x, y).x, screenOf(x, y).y);
    expect(at2(5, 3)).toBe(s.id); // under the top face (z = 5): the solid wins
    expect(at2(5, 8)).toBe(onTop.id); // on the top face: the dimension wins
    c.viewport = null;
  });

  it('in 3D mode: Face by a click on a solid, corners by 3D object snaps', () => {
    const { ed, jcad3d: c } = editor();
    const s = newSolid({ feature: box(0, 0, 0, 10, 10, 5), mesh: primitiveMesh(box(0, 0, 0, 10, 10, 5)) });
    ed.doc.updateModel3D((m) => addSolids(m, [s]));
    c.viewport = fakeViewport3d(ed.doc);
    const click = (x: number, y: number) => {
      const p = screenOf(x, y);
      c.click(p.x, p.y, false);
    };
    void ed.runCommand('DIM3D');
    ed.submitInput('P');
    ed.submitInput('F');
    click(5, 5);
    expect(ed.history).toContain('Measurement plane: the picked face (XY at z = 5.0000).');
    click(9.95, 9.95); // END snap: 10, 10, 5
    click(0.05, 0.03); // END snap: 0, 0, 5
    click(5, 14); // the location, off the box (projected onto the face plane)
    const d = model3dOf(ed.doc.snapshot).dimensions![0]!;
    expect(d.p1).toEqual(v3(10, 10, 5));
    expect(d.p2).toEqual(v3(0, 0, 5));
    expect(d.projected).toBeUndefined();
    expect(dimension3dMeasurement(d)).toBeCloseTo(Math.sqrt(200), 12);
    expect(ed.history.at(-1)).toBe('DIM3D: Aligned dimension in the Face plane (XY at z = 5.0000). Dimension text = 14.1421 (measured 14.1421)');
    c.viewport = null;
  });
});
