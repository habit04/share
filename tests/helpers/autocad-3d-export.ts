/**
 * Node-side half of the AutoCAD 3D oracle (scripts/check-autocad-3d.mjs, docs/3D-AUTOCAD-VALIDATION.md).
 * The script bundles this file with esbuild and imports it: it builds the generated
 * `dimensions.dxf` input (DIM3D dimensions with known measurements in several planes, a solid
 * whose top face carries some of them and one 2D dimension), and summarizes what JCad's own
 * reader (`model3d: true`) sees in a DXF so the script can compare it with what AutoCAD reports.
 * It never changes the product code; it only calls it.
 */
import { Drawing, type DrawingState } from '../../src/core/document';
import { STANDARD_DIMSTYLE, dimensionMeasurement, dimensionText, type DimensionEntity } from '../../src/core/dimension';
import { readDxf, writeDxf } from '../../src/io/dxf';
import { importReportOf } from '../../src/io/import-report';
import { dimension3dMeasurement, dimension3dText, effectiveTextOverride, makeDimension3D, planeWorld } from '../../src/model3d/dimension3d';
import { type Frame3, type Vec3, WORLD_XY_FRAME, dot3, frameFromPlane, v3 } from '../../src/model3d/math';
import { addDimensions3D, addSolids, model3dBounds, model3dOf, newSolid, withModel3D } from '../../src/model3d/model';
import { primitiveMesh } from '../../src/model3d/primitives';
import type { BoxFeature, Dimension3D } from '../../src/model3d/types';

/** The measurement planes of the generated input (name, frame). */
export const DIMENSION_PLANES: ReadonlyArray<readonly [string, Frame3]> = [
  ['world', WORLD_XY_FRAME],
  ['tilted', frameFromPlane({ origin: v3(1.25, -2.5, 3.75), normal: v3(0.3, -0.2, 0.9) })],
  ['minus-z', frameFromPlane({ origin: v3(0, 0, -2), normal: v3(0, 0, -1) })],
  // A plane whose in-plane X axis is not the OCS X axis (exercises group 50 and the OCS text point).
  ['rotated', { origin: v3(2, 3, 4), xAxis: v3(0, 0.6, 0.8), yAxis: v3(0, -0.8, 0.6), zAxis: v3(1, 0, 0) }],
];

/** The box whose top face (z = 2) is the face plane: 10 x 8 x 2 centred on (20, 0). */
const FACE_BOX: BoxFeature = { kind: 'box', frame: { ...WORLD_XY_FRAME, origin: v3(20, 0, 0) }, width: 10, depth: 8, height: 2 };
/** The face plane as DIM3D's Face option makes it: the face's plane, X axis by the arbitrary axis algorithm. */
export const FACE_PLANE: Frame3 = frameFromPlane({ origin: v3(20, 0, 2), normal: v3(0, 0, 1) });

const style = STANDARD_DIMSTYLE;
const P = (f: Frame3, x: number, y: number, z = 0): Vec3 => planeWorld(f, { x, y }, z);

/** Analytic values every generated dimension must measure (the oracle's "known measurements"). */
export interface KnownMeasurement { readonly id: string; readonly value: number }

function planeDimensions(tag: string, f: Frame3): Dimension3D[] {
  const a60 = Math.PI / 3;
  return [
    makeDimension3D({ id: `${tag}-aligned`, kind: 'aligned', plane: f, p1: P(f, 0, 0), p2: P(f, 3, 4), location: P(f, -1, 2), style, layer: 'DIMS', color: 4 }),
    makeDimension3D({ id: `${tag}-linear-x`, kind: 'linear', axis: 'x', plane: f, p1: P(f, 1, 1), p2: P(f, 4.5, 5), location: P(f, 2, 7), style, layer: 'DIMS' }),
    makeDimension3D({ id: `${tag}-linear-y`, kind: 'linear', axis: 'y', plane: f, p1: P(f, 1, 1), p2: P(f, 4.5, 5), location: P(f, 7, 3), style, layer: 'DIMS', textOverride: 'H = <>' }),
    makeDimension3D({ id: `${tag}-angular`, kind: 'angular', plane: f, vertex: P(f, -1, -1), p1: P(f, 1, -1), p2: P(f, -1 + Math.cos(a60), -1 + Math.sin(a60)), location: P(f, -0.2, -0.6), style, layer: 'DIMS' }),
  ];
}

/** The generated input: its state, and the analytic measurement of every dimension. */
export function dimensionsCase(): { state: DrawingState; known: KnownMeasurement[] } {
  const dims: Dimension3D[] = [];
  const known: KnownMeasurement[] = [];
  for (const [tag, f] of DIMENSION_PLANES) {
    dims.push(...planeDimensions(tag, f));
    known.push({ id: `${tag}-aligned`, value: 5 }, { id: `${tag}-linear-x`, value: 3.5 }, { id: `${tag}-linear-y`, value: 4 }, { id: `${tag}-angular`, value: Math.PI / 3 });
  }
  // A projected aligned dimension: p2 is 2.5 above the tilted plane; JCad measures the projection (5).
  const tilted = DIMENSION_PLANES[1]![1];
  dims.push(makeDimension3D({ id: 'tilted-projected', kind: 'aligned', plane: tilted, p1: P(tilted, 0, 0), p2: P(tilted, 3, 4, 2.5), location: P(tilted, -1, 2), style, layer: 'DIMS' }));
  known.push({ id: 'tilted-projected', value: 5 });
  // Face plane z = 2 of the box: its top edges (10 and 8), the face diagonal and a corner angle.
  const f = FACE_PLANE;
  const c00 = v3(15, -4, 2), c10 = v3(25, -4, 2), c11 = v3(25, 4, 2), c01 = v3(15, 4, 2);
  dims.push(
    makeDimension3D({ id: 'face-aligned-diagonal', kind: 'aligned', plane: f, p1: c00, p2: c11, location: v3(19, 1, 2), style, layer: 'DIMS' }),
    makeDimension3D({ id: 'face-linear-x', kind: 'linear', axis: 'x', plane: f, p1: c00, p2: c10, location: v3(20, -6, 2), style, layer: 'DIMS' }),
    makeDimension3D({ id: 'face-linear-y', kind: 'linear', axis: 'y', plane: f, p1: c10, p2: c11, location: v3(27, 0, 2), style, layer: 'DIMS' }),
    makeDimension3D({ id: 'face-angular-corner', kind: 'angular', plane: f, vertex: c00, p1: c10, p2: c01, location: v3(16, -3, 2), style, layer: 'DIMS' }),
  );
  known.push({ id: 'face-aligned-diagonal', value: Math.hypot(10, 8) }, { id: 'face-linear-x', value: 10 }, { id: 'face-linear-y', value: 8 }, { id: 'face-angular-corner', value: Math.PI / 2 });

  const base = new Drawing().snapshot;
  const dim2d: DimensionEntity = { id: 'dim-2d', type: 'dimension', kind: 'aligned', layer: 'DIMS', color: 'ByLayer', p1: { x: 0, y: -10 }, p2: { x: 6, y: -2 }, linePoint: { x: -1, y: -8 }, rotation: 0, style };
  known.push({ id: 'dim-2d', value: 10 });
  let model = addSolids(model3dOf(base), [newSolid({ id: 'face-box', layer: 'SOLIDS', color: 3, name: 'Face plane box', feature: FACE_BOX, mesh: primitiveMesh(FACE_BOX) })]);
  model = addDimensions3D(model, dims);
  const layers = [...base.layers, { name: 'DIMS', color: 2, visible: true, locked: false, lineWeight: 0.25 }, { name: 'SOLIDS', color: 3, visible: true, locked: false, lineWeight: 0.25 }];
  return { state: withModel3D({ ...base, layers, entities: [...base.entities, dim2d] }, model), known };
}

/** The generated input's DXF text, as JCad's Save writes it. */
export const dimensionsDxf = (): string => writeDxf(dimensionsCase().state);

const xyz = (q: Vec3): [number, number, number] => [q.x, q.y, q.z];

/** What JCad's reader (3D enabled) sees in a DXF text: everything the oracle compares. */
export function jcadSummary(text: string) {
  const state = readDxf(text, { model3d: true });
  const model = model3dOf(state);
  const report = importReportOf(state);
  const counts2d: Record<string, number> = {};
  for (const e of state.entities) counts2d[e.type] = (counts2d[e.type] ?? 0) + 1;
  const bounds = model3dBounds(model);
  return {
    solids: model.solids.map((s) => ({
      id: s.id, layer: s.layer, color: s.color, name: s.name ?? null, featureKind: s.feature.kind, feature: JSON.stringify(s.feature),
      vertices: s.mesh.positions.length / 3, faces: s.mesh.indices.length / 3, positions: [...s.mesh.positions], indices: [...s.mesh.indices],
    })),
    dims3d: (model.dimensions ?? []).map((d) => ({
      id: d.id, kind: d.kind, axis: d.axis ?? null, layer: d.layer, color: d.color, measurement: dimension3dMeasurement(d), text: dimension3dText(d),
      textOverride: effectiveTextOverride(d) ?? null, projected: d.projected === true, normal: xyz(d.plane.zAxis), origin: xyz(d.plane.origin),
      xAxis: xyz(d.plane.xAxis), elevation: dot3(d.plane.origin, d.plane.zAxis), p1: xyz(d.p1), p2: xyz(d.p2), vertex: d.vertex ? xyz(d.vertex) : null,
    })),
    dims2d: state.entities.filter((e): e is DimensionEntity => e.type === 'dimension').map((d) => ({
      id: d.id, kind: d.kind, layer: d.layer, measurement: dimensionMeasurement(d), text: dimensionText(d), textOverride: d.text ?? null,
      p1: [d.p1.x, d.p1.y], p2: [d.p2.x, d.p2.y],
    })),
    counts2d,
    bounds: bounds ? { min: xyz(bounds.min), max: xyz(bounds.max) } : null,
    report: report ? { items: report.items.map((i) => ({ ...i })), omitted: report.omitted, notes: [...report.notes], counts: report.counts, recovered: report.recovered ?? null } : null,
  };
}

export type JcadSummary = ReturnType<typeof jcadSummary>;
