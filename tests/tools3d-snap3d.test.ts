/**
 * Milestone 4 3D object snaps (src/tools3d/snap3d.ts), screen markers (src/render3d/markers.ts),
 * grips (src/tools3d/grips.ts) and their wiring in the 3D view (src/app/experimental-3d.ts) through
 * a fake plan-view viewport: snapped clicks for 3D commands, snapped x, y for 2D commands, cursor
 * ghosts for 2D MOVE, and the centre-grip drag.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Editor as EditorType } from '../src/app/editor';
import type { Experimental3d, installExperimental3d as InstallType } from '../src/app/experimental-3d';
import { defaultSnapSettings } from '../src/core/snap';
import { type Ray, WORLD_XY_FRAME, v3 } from '../src/model3d/math';
import { meshBounds } from '../src/model3d/mesh';
import { addSolids, model3dOf, newSolid } from '../src/model3d/model';
import { primitiveMesh } from '../src/model3d/primitives';
import type { Feature3D, PrimitiveFeature, Solid3D } from '../src/model3d/types';
import { pickSolid } from '../src/render3d/picking';
import { gripSegments, markerSegments } from '../src/render3d/markers';
import { type Snap3DModes, distanceToRay, faceRegion, faceSnapCandidates, snapOnSolid, snapPick3, triangleAdjacency } from '../src/tools3d/snap3d';
import { CENTER_GRIP, gripDragDisplacement, gripDragNormal, gripDragPoint, solidGrips } from '../src/tools3d/grips';
import { axesFrame } from '../src/tools3d/context';
import { RIBBON } from '../src/ui/ribbon';
import { directKernel } from './helpers/context3d';
import { evaluateFeature } from '../src/model3d/feature-eval';
import { fakeViewport3d, screenOf } from './helpers/fake-viewport3d';
import { resetModellingDefaults } from '../src/tools3d/primitives';
import { resetTransformDefaults } from '../src/tools3d/transform';

const box = (x0: number, y0: number, z0: number, w: number, d: number, h: number): PrimitiveFeature => ({
  kind: 'box', frame: { ...WORLD_XY_FRAME, origin: v3(x0 + w / 2, y0 + d / 2, z0) }, width: w, depth: d, height: h,
});
const solidOf = (f: PrimitiveFeature): Solid3D => newSolid({ mesh: primitiveMesh(f), feature: f });
const down = (x: number, y: number): Ray => ({ origin: v3(x, y, 100), dir: v3(0, 0, -1) });
const ALL: Snap3DModes = { osnap: true, endpoint: true, midpoint: true, center: true, nearest: true };
const DEFAULT: Snap3DModes = defaultSnapSettings();

/** Snap the downward ray at (x, y) on solid `s` with aperture `ap`. */
function snapAt(s: Solid3D, x: number, y: number, ap: number, modes: Snap3DModes = ALL) {
  const ray = down(x, y);
  const hit = pickSolid(s, ray);
  if (!hit) throw new Error('ray missed');
  return snapOnSolid(hit, s.mesh, ray, ap, modes);
}

describe('faceRegion', () => {
  it('a box face is one region of two triangles with four corners', () => {
    const s = solidOf(box(0, 0, 0, 10, 10, 5));
    const hit = pickSolid(s, down(3, 4))!;
    const r = faceRegion(s.mesh, hit.triangle);
    expect(r.triangles).toHaveLength(2);
    expect(r.area).toBeCloseTo(100, 12);
    expect(r.perimeter).toBeCloseTo(40, 12);
    expect(r.normal).toEqual(v3(0, 0, 1));
    expect(r.centroid.x).toBeCloseTo(5, 12);
    expect(r.centroid.z).toBeCloseTo(5, 12);
    expect(r.loops).toHaveLength(1);
    expect(r.loops[0]).toHaveLength(4);
    expect(() => faceRegion(s.mesh, 99)).toThrow(RangeError);
  });

  it('a cylinder cap is one region whose centre is the circle centre', () => {
    const f: PrimitiveFeature = { kind: 'cylinder', frame: { ...WORLD_XY_FRAME, origin: v3(2, 3, 0) }, radius: 2, height: 4, segments: 24 };
    const s = solidOf(f);
    const hit = pickSolid(s, down(2.5, 3.2))!;
    const r = faceRegion(s.mesh, hit.triangle);
    expect(r.loops[0]).toHaveLength(24);
    expect(r.centroid.x).toBeCloseTo(2, 9);
    expect(r.centroid.y).toBeCloseTo(3, 9);
    expect(r.centroid.z).toBeCloseTo(4, 12);
    expect(r.area).toBeCloseTo(0.5 * 24 * 4 * Math.sin((2 * Math.PI) / 24), 9);
  });

  it('merges coplanar triangles of a Boolean result and drops collinear outline points', async () => {
    const f: Feature3D = { kind: 'boolean', op: 'union', operands: [box(0, 0, 0, 2, 2, 2), box(1, 0, 0, 2, 2, 2)] };
    const s = newSolid({ mesh: await evaluateFeature(f, directKernel()), feature: f });
    const hit = pickSolid(s, down(1.5, 1))!;
    const r = faceRegion(s.mesh, hit.triangle);
    expect(r.area).toBeCloseTo(6, 6);
    expect(r.perimeter).toBeCloseTo(10, 6);
    expect(r.loops).toHaveLength(1);
    expect(r.loops[0]).toHaveLength(4);
    expect(triangleAdjacency(s.mesh).every((t) => t >= 0)).toBe(true);
  });

  it('a Boolean far from the origin still gives one planar top face', async () => {
    const X = 123456.789, Y = -98765.4321;
    const f: Feature3D = { kind: 'boolean', op: 'union', operands: [box(X, Y, 50, 2, 2, 2), box(X + 1, Y, 50, 2, 2, 2)] };
    const s = newSolid({ mesh: await evaluateFeature(f, directKernel()), feature: f });
    const hit = pickSolid(s, down(X + 1.5, Y + 1))!;
    const r = faceRegion(s.mesh, hit.triangle);
    expect(r.area).toBeCloseTo(6, 4);
    expect(r.perimeter).toBeCloseTo(10, 4);
    expect(r.loops).toHaveLength(1);
    expect(r.loops[0]).toHaveLength(4);
    const snap = snapOnSolid(hit, s.mesh, down(X + 2.95, Y + 1.97), 0.2, ALL)!;
    expect(snap.kind).toBe('endpoint');
    expect(snap.point.x).toBeCloseTo(X + 3, 4);
  });

  it('a box with a hole through its top gives an outer loop and a hole loop', async () => {
    const f: Feature3D = { kind: 'boolean', op: 'subtract', operands: [box(0, 0, 0, 4, 4, 1), box(1, 1, -1, 2, 2, 3)] };
    const s = newSolid({ mesh: await evaluateFeature(f, directKernel()), feature: f });
    const hit = pickSolid(s, down(0.5, 0.5))!;
    const r = faceRegion(s.mesh, hit.triangle);
    expect(r.area).toBeCloseTo(12, 6);
    expect(r.loops).toHaveLength(2);
    expect(r.perimeter).toBeCloseTo(24, 6);
  });
});

describe('snapOnSolid', () => {
  const s = solidOf(box(0, 0, 0, 10, 10, 5));

  it('picks the vertex, the edge midpoint and the face centre near the ray', () => {
    expect(snapAt(s, 9.9, 9.8, 0.5)).toEqual({ kind: 'endpoint', point: v3(10, 10, 5) });
    expect(snapAt(s, 5.1, 9.9, 0.5)).toEqual({ kind: 'midpoint', point: v3(5, 10, 5) });
    const c = snapAt(s, 5.2, 4.9, 0.5)!;
    expect(c.kind).toBe('center');
    expect(c.point.x).toBeCloseTo(5, 12);
    expect(c.point.y).toBeCloseTo(5, 12);
    expect(c.point.z).toBeCloseTo(5, 12);
  });

  it('falls back to NEA (the hit) or nothing, and respects the OSNAP toggles', () => {
    expect(snapAt(s, 3, 3, 0.5)).toEqual({ kind: 'nearest', point: v3(3, 3, 5) });
    expect(snapAt(s, 3, 3, 0.5, DEFAULT)).toBeNull();
    expect(snapAt(s, 9.9, 9.8, 0.5, { ...ALL, osnap: false })).toBeNull();
    // Endpoint off: the corner is not offered, and the nearest midpoint is 2.2 away: NEA.
    expect(snapAt(s, 9.9, 9.8, 0.5, { ...ALL, endpoint: false })!.kind).toBe('nearest');
    expect(snapAt(s, 9.9, 9.8, 0.5, { osnap: true, endpoint: false, midpoint: false, center: false, nearest: false })).toBeNull();
    // A zero aperture offers only NEA.
    expect(snapAt(s, 9.9, 9.8, 0, ALL)!.kind).toBe('nearest');
  });

  it('prefers END over MID when both are equally close, and the closer candidate otherwise', () => {
    const thin = solidOf(box(0, 0, 0, 0.2, 10, 1));
    // At x = 0.1 the corner (0.2, 10) and the edge midpoint (0.1, 10) are both within 0.3.
    expect(snapAt(thin, 0.15, 9.95, 0.3)!.kind).toBe('endpoint');
    expect(snapAt(thin, 0.1, 9.98, 0.3)).toEqual({ kind: 'midpoint', point: v3(0.1, 10, 1) });
  });

  it('distanceToRay is the perpendicular distance, Infinity behind the ray', () => {
    const ray = down(0, 0);
    expect(distanceToRay(v3(3, 4, 0), ray)).toBeCloseTo(5, 12);
    expect(distanceToRay(v3(0, 0, 200), ray)).toBe(Infinity);
  });

  it('snapPick3 moves the pick and its plane-local tool point to the snap', () => {
    const doc = { version: 1 as const, solids: [s] };
    const ray = down(9.9, 9.8);
    const hit = pickSolid(s, ray)!;
    const pick = { p2: { x: 9.9, y: 9.8 }, point: hit.point, ray, hit };
    const out = snapPick3(pick, doc, ALL, 0.5, axesFrame('XY', v3(0, 0, 5)));
    expect(out.snap).toBe('endpoint');
    expect(out.point).toEqual(v3(10, 10, 5));
    expect(out.p2).toEqual({ x: 10, y: 10 });
    expect(snapPick3({ ...pick, hit: null }, doc, ALL, 0.5, WORLD_XY_FRAME)).toEqual({ ...pick, hit: null });
    expect(faceSnapCandidates(faceRegion(s.mesh, hit.triangle)).map((c) => c.kind)).toEqual([
      'endpoint', 'endpoint', 'endpoint', 'endpoint', 'midpoint', 'midpoint', 'midpoint', 'midpoint', 'center',
    ]);
  });
});

describe('markers and grips', () => {
  it('draws the 2D snap marker shapes and grip squares as pixel segments', () => {
    expect(markerSegments('endpoint', 10, 10, 2)).toEqual([[8, 8, 12, 8], [12, 8, 12, 12], [12, 12, 8, 12], [8, 12, 8, 8]]);
    expect(markerSegments('midpoint', 0, 0, 1)).toHaveLength(3);
    expect(markerSegments('center', 0, 0, 3)).toHaveLength(20);
    expect(markerSegments('nearest', 0, 0, 1)).toHaveLength(4);
    const g = gripSegments(10.4, 20.6, 2);
    expect(g.fill).toHaveLength(5);
    expect(g.edge[0]).toEqual([8, 19, 12, 19]);
  });

  it('solid grips are the bounding-box corners and the centre; the centre drags on the plane', () => {
    const s = solidOf(box(0, 0, 0, 10, 10, 5));
    const grips = solidGrips(s);
    expect(grips).toHaveLength(9);
    expect(grips[0]).toEqual(v3(0, 0, 0));
    expect(grips[7]).toEqual(v3(10, 10, 5));
    expect(grips[CENTER_GRIP]).toEqual(v3(5, 5, 2.5));
    const n = gripDragNormal(WORLD_XY_FRAME, v3(0, 0, -1));
    expect(n).toEqual(v3(0, 0, 1));
    expect(gripDragPoint(grips[8]!, n, down(15, 5))).toEqual(v3(15, 5, 2.5));
    expect(gripDragDisplacement(grips[8]!, n, down(15, 5))).toEqual(v3(10, 0, 0));
    // Looking along the plane: drag on the plane facing the viewer instead.
    expect(gripDragNormal(WORLD_XY_FRAME, v3(1, 0, 0))).toEqual(v3(1, 0, 0));
    expect(gripDragPoint(grips[8]!, v3(0, 0, 1), { origin: v3(0, 0, 10), dir: v3(1, 0, 0) })).toBeNull();
  });
});

// ------------------------------------------------------------------ the 3D view routing

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

/** An editor with the flag on and a fake plan-view 3D viewport (3D mode "on"), with a box 10 x 10 x 5. */
function editorIn3d(): { ed: EditorType; c: Experimental3d; id: string; vp: ReturnType<typeof fakeViewport3d> } {
  resetModellingDefaults();
  resetTransformDefaults();
  const ed = new Editor(canvas());
  ed.settings = { ...ed.settings, experimental3d: true };
  const c = installExperimental3d(ed)!;
  const s = solidOf(box(0, 0, 0, 10, 10, 5));
  ed.doc.updateModel3D((m) => addSolids(m, [s]));
  const vp = fakeViewport3d(ed.doc);
  c.viewport = vp;
  return { ed, c, id: s.id, vp };
}
const click = (c: Experimental3d, x: number, y: number) => {
  const p = screenOf(x, y);
  c.click(p.x, p.y, false);
};

describe('3D view: snaps, 2D commands and grips (fake viewport)', () => {
  it('a 3D command receives snapped 3D points and the marker is recorded', () => {
    const { ed, c } = editorIn3d();
    void ed.runCommand('3DDIST');
    const p = screenOf(9.95, 9.95);
    c.hoverAt(p.x, p.y);
    expect(c.snapMarker).toEqual({ kind: 'endpoint', point: v3(10, 10, 5) });
    click(c, 9.95, 9.95);
    click(c, 0.05, 0.03);
    expect(ed.history.some((l) => l.startsWith('Distance = 14.1421'))).toBe(true);
    expect(ed.history.some((l) => l.startsWith('Delta X = -10.0000, Delta Y = -10.0000, Delta Z = 0.0000'))).toBe(true);
    // The command ended: the marker is cleared with the tool... once the next cursor move happens.
    expect(ed.tool).toBeNull();
  });

  it('OSNAP off: the click gets the face point under the cursor', () => {
    const { ed, c } = editorIn3d();
    ed.snap.osnap = false;
    void ed.runCommand('3DDIST');
    click(c, 9.9, 9.9);
    click(c, 9.9, 0.1);
    expect(ed.history.some((l) => l.startsWith('Distance = 9.8000'))).toBe(true);
    expect(c.snapMarker).toBeNull();
  });

  it('2D MOVE in 3D mode: picks the solid, snaps the base point, ghosts follow the cursor', () => {
    const { ed, c, id } = editorIn3d();
    void ed.runCommand('MOVE');
    expect(ed.selectionPending).toBe(true);
    click(c, 5, 5);
    ed.submitInput('');
    expect(ed.selectionPending).toBe(false);
    click(c, 9.95, 9.95); // base: the snapped corner's x, y = (10, 10)
    const p = screenOf(20, 10);
    c.hoverAt(p.x, p.y);
    expect(c.previewSolids).toHaveLength(1);
    expect(meshBounds(c.previewSolids[0]!.mesh)!.min.x).toBeCloseTo(10, 9);
    click(c, 20, 10.04); // empty space: where the ray meets z = 0
    const s = model3dOf(ed.doc.snapshot).solids.find((x) => x.id === id)!;
    expect(meshBounds(s.mesh)!.min.x).toBeCloseTo(10, 6);
    expect(meshBounds(s.mesh)!.min.y).toBeCloseTo(0.04, 6);
  });

  it('grips: a single selected solid shows 9 grips; dragging the centre grip moves it (one undo step)', () => {
    const { ed, c, id, vp } = editorIn3d();
    expect(c.grips()).toEqual([]);
    ed.selection.add(id);
    c.render();
    expect(c.grips()).toHaveLength(9);
    expect(vp.overlays.at(-1)!.grips3d).toHaveLength(9);
    expect(c.gripScreenPoints()[CENTER_GRIP]).toEqual(screenOf(5, 5));
    const start = screenOf(5, 5);
    expect(c.beginGripDrag(start.x + 30, start.y)).toBe(false);
    expect(c.beginGripDrag(start.x + 2, start.y - 1)).toBe(true);
    const to = screenOf(15.2, 5.1);
    c.gripDragTo(to.x, to.y);
    expect(c.previewSolids).toHaveLength(1);
    const before = ed.doc.snapshot;
    c.endGripDrag(to.x, to.y);
    expect(c.gripDragging).toBe(false);
    expect(c.previewSolids).toEqual([]);
    const s = model3dOf(ed.doc.snapshot).solids[0]!;
    const b = meshBounds(s.mesh)!;
    expect(b.min.x).toBeCloseTo(10, 6);
    expect(b.min.y).toBeCloseTo(0, 6);
    expect(b.min.z).toBe(0);
    expect(ed.history.some((l) => l.startsWith('Grip: solid moved by 10.0000, 0.0000, 0.0000'))).toBe(true);
    ed.doc.undo();
    expect(ed.doc.snapshot).toBe(before);
    // No grips while a command runs or with two objects selected.
    void ed.runCommand('3DDIST');
    expect(c.grips()).toEqual([]);
    ed.cancel();
  });

  it('Esc during a centre-grip drag abandons it: releasing the button changes nothing', () => {
    const { ed, c, id } = editorIn3d();
    ed.selection.add(id);
    const start = screenOf(5, 5);
    expect(c.beginGripDrag(start.x, start.y)).toBe(true);
    const to = screenOf(15, 5);
    c.gripDragTo(to.x, to.y);
    expect(c.previewSolids).toHaveLength(1);
    const before = ed.doc.snapshot;
    ed.cancel(); // Esc: clears the selection, which ends the drag
    expect(c.gripDragging).toBe(false);
    expect(c.previewSolids).toEqual([]);
    c.endGripDrag(to.x, to.y);
    expect(ed.doc.snapshot).toBe(before);
    // A command starting also ends a drag.
    ed.selection.add(id);
    expect(c.beginGripDrag(start.x, start.y)).toBe(true);
    void ed.runCommand('3DDIST');
    expect(c.gripDragging).toBe(false);
    ed.cancel();
  });

  it('keeps no ghosts outside 3D mode; grips are cached per mesh', () => {
    const { ed, c } = editorIn3d();
    const s = model3dOf(ed.doc.snapshot).solids[0]!;
    c.setPreview3d([s]);
    expect(c.previewSolids).toHaveLength(1);
    c.viewport = null;
    c.setPreview3d([s]);
    expect(c.previewSolids).toEqual([]);
    expect(solidGrips(s)).toBe(solidGrips(s));
  });

  it('DIST measures 3D points in 3D mode and stays the 2D command otherwise', () => {
    const { ed, c } = editorIn3d();
    void ed.runCommand('DIST');
    ed.submitInput('0,0,0');
    ed.submitInput('3,4,12');
    expect(ed.history).toContain('Distance = 13.0000, Angle in XY Plane = 53.13, Angle from XY Plane = 67.38');
    expect(ed.history.some((l) => l.startsWith('Planar distance') && l.endsWith('= 5.0000'))).toBe(true);
    c.viewport = null;
    ed.history.length = 0;
    void ed.runCommand('DIST');
    ed.submitInput('0,0');
    ed.submitInput('3,4');
    expect(ed.history.some((l) => l.startsWith('Distance = 5.0000') && l.endsWith('Angle from XY Plane = 0'))).toBe(true);
    expect(ed.history.some((l) => l.startsWith('Planar distance'))).toBe(false);
  });
});
