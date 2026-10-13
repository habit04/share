/**
 * Realistic 3D model fixtures (milestone 6), built deterministically with the in-process Manifold
 * kernel through the same code paths a user's commands take: primitive features, a sketched
 * profile (`profileFromEntities`), extrusion, revolution and Boolean features evaluated by
 * `evaluateFeature`. Every solid gets a fixed id, so the DXF text is the same on every run and
 * machine (the Manifold WebAssembly is deterministic for the same input).
 *
 * The committed files are tests/fixtures/3d/<name>.dxf (registered in tests/fixtures/manifest.json).
 * `npm run make:3d-fixtures` (scripts/make-3d-fixtures.mjs) rewrites them from these builders;
 * tests/model3d-fixtures.test.ts fails when a committed file differs from what the builders make.
 *
 * Units are millimetres. The enclosure stands with its back wall on the WCS XY plane (z = 0) and
 * its open front toward +Z (the viewer in plan view), as an electrical panel is drawn front-on.
 */
import { Drawing, type DrawingState } from '../../src/core/document';
import type { ColorSpec, Layer, PolylineEntity } from '../../src/core/entities';
import type { Point } from '../../src/core/geometry';
import { evaluateFeature } from '../../src/model3d/feature-eval';
import type { GeometryKernel } from '../../src/model3d/kernel/kernel';
import { type Frame3, v3, WORLD_XY_FRAME } from '../../src/model3d/math';
import { addSolids, model3dOf, newSolid, withModel3D } from '../../src/model3d/model';
import { profileFromEntities } from '../../src/model3d/sketch';
import type { BoxFeature, CylinderFeature, Feature3D, Profile3D, Solid3D } from '../../src/model3d/types';

/** Names of the committed fixtures (tests/fixtures/3d/<name>.dxf). */
export const MODEL3D_FIXTURES = ['enclosure', 'cable-tray', 'schematic-with-solids'] as const;
export type Model3DFixtureName = (typeof MODEL3D_FIXTURES)[number];

/** Repository path of a fixture. */
export const fixturePath = (name: Model3DFixtureName): string => `tests/fixtures/3d/${name}.dxf`;

const at = (x: number, y: number, z: number): Frame3 => ({ ...WORLD_XY_FRAME, origin: v3(x, y, z) });
const box = (x: number, y: number, z: number, width: number, depth: number, height: number): BoxFeature => ({ kind: 'box', frame: at(x, y, z), width, depth, height });
const cylinder = (x: number, y: number, z: number, radius: number, height: number, segments = 32): CylinderFeature => ({ kind: 'cylinder', frame: at(x, y, z), radius, height, segments });
const subtract = (a: Feature3D, b: Feature3D): Feature3D => ({ kind: 'boolean', op: 'subtract', operands: [a, b] });
const union = (a: Feature3D, b: Feature3D): Feature3D => ({ kind: 'boolean', op: 'union', operands: [a, b] });

/** Area of an inscribed regular n-gon of radius r (what a cylinder of n segments uses). */
export const ngonArea = (r: number, n: number): number => (n / 2) * r * r * Math.sin((2 * Math.PI) / n);

/** Enclosure dimensions, shared with the tests' analytic volumes. */
export const ENCLOSURE = Object.freeze({
  width: 600, height: 800, depth: 250, wall: 2,
  holeRadius: 4, holes: [[-250, -350], [250, -350], [-250, 350], [250, 350]] as const,
  railLength: 500, railYs: [-200, 0, 200] as const,
  /** Cross-section area of the 35 x 7.5 mm top-hat rail profile below (mm^2). */
  railArea: 48,
  components: { columns: 8, rows: 5, pitchX: 65, pitchY: 150, width: 45, depth: 90 },
});

/** 35 x 7.5 mm top-hat DIN rail cross-section (EN 60715), 1 mm steel, as a closed 2D polyline. */
const DIN_RAIL_OUTLINE: readonly Point[] = [
  { x: -13.5, y: 0 }, { x: 13.5, y: 0 }, { x: 13.5, y: 6.5 }, { x: 17.5, y: 6.5 }, { x: 17.5, y: 7.5 }, { x: 12.5, y: 7.5 },
  { x: 12.5, y: 1 }, { x: -12.5, y: 1 }, { x: -12.5, y: 7.5 }, { x: -17.5, y: 7.5 }, { x: -17.5, y: 6.5 }, { x: -13.5, y: 6.5 },
];

/** The rail sketched as the user would (a closed polyline on the XY plane), then flattened to a profile. */
function sketchedRailProfile(): Profile3D {
  const outline: PolylineEntity = { id: 'sketch-din-rail', type: 'polyline', layer: '0', color: 'ByLayer', points: DIN_RAIL_OUTLINE, closed: true };
  const sketched = profileFromEntities([outline], WORLD_XY_FRAME);
  if ('error' in sketched) throw new Error(`DIN rail sketch: ${sketched.error}`);
  return sketched.profile;
}

/** Component height of grid cell i (deterministic variety: 60, 75, 90, 105 mm). */
export const componentHeight = (i: number): number => 60 + 15 * (i % 4);
/** Every fifth component carries a pilot light (a cylinder united on its front). */
export const hasPilotLight = (i: number): boolean => i % 5 === 0;

async function solid(kernel: GeometryKernel, id: string, layer: string, color: ColorSpec, name: string, feature: Feature3D): Promise<Solid3D> {
  return newSolid({ id, layer, color, name, feature, mesh: await evaluateFeature(feature, kernel) });
}

/**
 * The electrical enclosure: shell (outer box minus inner box, open front), four mounting holes cut
 * through the back wall by cylinder subtraction, a door panel in front, three DIN rails extruded
 * from a sketched profile and 40 component blocks on a grid (every fifth with a pilot light).
 * 45 solids. `dx` shifts everything along X (the mixed fixture places it beside the schematic).
 */
export async function enclosureSolids(kernel: GeometryKernel, dx = 0, prefix = 'enc'): Promise<Solid3D[]> {
  const E = ENCLOSURE;
  const out: Solid3D[] = [];
  let shell: Feature3D = subtract(box(dx, 0, 0, E.width, E.height, E.depth), box(dx, 0, E.wall, E.width - 2 * E.wall, E.height - 2 * E.wall, E.depth + 10));
  for (const [x, y] of E.holes) shell = subtract(shell, cylinder(dx + x, y, -5, E.holeRadius, 10));
  out.push(await solid(kernel, `${prefix}-shell`, 'ENCLOSURE', 'ByLayer', 'Enclosure 600x800x250', shell));
  out.push(await solid(kernel, `${prefix}-door`, 'ENCLOSURE', 8, 'Door panel', box(dx, 0, E.depth + 2, E.width, E.height, E.wall)));
  const rail = sketchedRailProfile();
  // Rail frame: profile u along world Y, v along world Z (height off the back wall), extruded along +X.
  for (const [k, y] of E.railYs.entries()) {
    const frame: Frame3 = { origin: v3(dx - E.railLength / 2, y, E.wall), xAxis: v3(0, 1, 0), yAxis: v3(0, 0, 1), zAxis: v3(1, 0, 0) };
    out.push(await solid(kernel, `${prefix}-rail-${k + 1}`, 'DIN', 'ByLayer', `DIN rail ${k + 1}`, { kind: 'extrude', profile: { frame, loops: rail.loops }, distance: E.railLength }));
  }
  const C = E.components;
  const base = E.wall + 7.5;
  for (let i = 0; i < C.columns * C.rows; i++) {
    const col = i % C.columns, row = Math.floor(i / C.columns);
    const x = dx + (col - (C.columns - 1) / 2) * C.pitchX, y = (row - (C.rows - 1) / 2) * C.pitchY;
    const h = componentHeight(i);
    let f: Feature3D = box(x, y, base, C.width, C.depth, h);
    if (hasPilotLight(i)) f = union(f, cylinder(x, y + 20, base + h - 1, 8, 6, 24));
    out.push(await solid(kernel, `${prefix}-k${i + 1}`, 'COMPONENTS', 1 + (i % 6), `K${i + 1}`, f));
  }
  return out;
}

/** Cable tray dimensions (mm), shared with the tests. */
export const TRAY = Object.freeze({ width: 300, height: 100, wall: 2, run1: 1000, run2: 500, bendRadius: 300, bendSegments: 64 });

/** U-channel cross-section in profile-local (u = across, v = up) coordinates, counter-clockwise. */
function trayLoop(): Point[] {
  const w = TRAY.width / 2, h = TRAY.height, t = TRAY.wall;
  return [{ x: -w, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: w - t, y: h }, { x: w - t, y: t }, { x: -w + t, y: t }, { x: -w + t, y: h }, { x: -w, y: h }];
}

/** Cross-section area of the tray (mm^2). */
export const trayArea = (): number => TRAY.width * TRAY.height - (TRAY.width - 2 * TRAY.wall) * (TRAY.height - TRAY.wall);

/**
 * A cable tray run: a straight U-channel extruded along +X, a horizontal 90 degree bend revolved
 * about a vertical (+Z) axis, and a second straight run along +Y, united into one solid; plus the
 * three pieces as separate solids on a second layer (what the union is checked against).
 */
export async function cableTraySolids(kernel: GeometryKernel): Promise<Solid3D[]> {
  const T = TRAY;
  const loops = [trayLoop()];
  // Profile planes: x = 0 for the first run (u along +Y, v along +Z, extruded along +X) ...
  const start: Frame3 = { origin: v3(0, 0, 0), xAxis: v3(0, 1, 0), yAxis: v3(0, 0, 1), zAxis: v3(1, 0, 0) };
  const run1: Feature3D = { kind: 'extrude', profile: { frame: start, loops }, distance: T.run1 };
  // ... the bend starts in the plane x = run1 and turns toward +Y about the axis x = run1, y = w / 2 + R ...
  const bendStart: Frame3 = { ...start, origin: v3(T.run1, 0, 0) };
  const axisY = T.width / 2 + T.bendRadius;
  const bend: Feature3D = { kind: 'revolve', profile: { frame: bendStart, loops }, axis: { origin: v3(T.run1, axisY, 0), dir: v3(0, 0, 1) }, angle: Math.PI / 2, segments: T.bendSegments };
  // ... and ends in the plane y = axisY, across x in [run1 + R, run1 + R + width]; the second run goes along +Y.
  const end: Frame3 = { origin: v3(T.run1 + axisY, axisY, 0), xAxis: v3(-1, 0, 0), yAxis: v3(0, 0, 1), zAxis: v3(0, 1, 0) };
  const run2: Feature3D = { kind: 'extrude', profile: { frame: end, loops }, distance: T.run2 };
  return [
    await solid(kernel, 'tray-run', 'TRAY', 'ByLayer', 'Cable tray 300x100', union(union(run1, bend), run2)),
    await solid(kernel, 'tray-piece-1', 'TRAY-PIECES', 3, 'Straight 1000', run1),
    await solid(kernel, 'tray-piece-2', 'TRAY-PIECES', 3, 'Bend 90', bend),
    await solid(kernel, 'tray-piece-3', 'TRAY-PIECES', 3, 'Straight 500', run2),
  ];
}

const layer = (name: string, color: number): Layer => ({ name, color, visible: true, locked: false, lineWeight: 0.25 });

/** A new drawing (millimetre defaults) holding `solids` and their layers. */
export function stateWithSolids(base: DrawingState, solids: readonly Solid3D[], layers: readonly Layer[]): DrawingState {
  const names = new Set(base.layers.map((l) => l.name));
  const added = layers.filter((l) => !names.has(l.name));
  return withModel3D({ ...base, layers: [...base.layers, ...added] }, addSolids(model3dOf(base), solids));
}

/** Layers the fixtures use. */
export const FIXTURE_LAYERS: readonly Layer[] = [layer('ENCLOSURE', 8), layer('DIN', 9), layer('COMPONENTS', 7), layer('TRAY', 4), layer('TRAY-PIECES', 3)];

/**
 * The drawing state of a fixture. `schematic` is the 2D content of the mixed fixture (the demo
 * schematic seeded into an editor, `seedDemoDrawing`); the caller provides it because building it
 * needs an Editor (tests/model3d-fixtures.test.ts does that).
 */
export async function fixtureState(name: Model3DFixtureName, kernel: GeometryKernel, schematic?: DrawingState): Promise<DrawingState> {
  switch (name) {
    case 'enclosure':
      return stateWithSolids(new Drawing().snapshot, await enclosureSolids(kernel), FIXTURE_LAYERS);
    case 'cable-tray':
      return stateWithSolids(new Drawing().snapshot, await cableTraySolids(kernel), FIXTURE_LAYERS);
    case 'schematic-with-solids': {
      if (!schematic) throw new Error('the mixed fixture needs the demo schematic state');
      // The enclosure beside the ladder diagram (the demo sheet spans x of about 0..300).
      return stateWithSolids(schematic, await enclosureSolids(kernel, 900, 'mix'), FIXTURE_LAYERS);
    }
  }
}
