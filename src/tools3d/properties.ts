/**
 * Properties palette rows for experimental 3D solids (pure, so it is tested in Node; the palette
 * in src/ui/properties.ts renders them). Editable rows: layer, colour, name. Read-only rows: the
 * type (feature kind), triangle count, volume and bounding-box size, in drawing units.
 */
import { aabbSize } from '../model3d/math';
import { meshBounds, meshTriangleCount, meshVolume } from '../model3d/mesh';
import type { Feature3D, Solid3D } from '../model3d/types';

/** One palette row: `edit` marks the editable ones. */
export interface SolidRow {
  readonly label: string;
  readonly value: string;
  readonly edit?: 'layer' | 'color' | 'name';
}

/** User-facing name of a feature kind ("Box", "Extrusion", "Union" ...). */
export function featureLabel(f: Feature3D): string {
  switch (f.kind) {
    case 'box': return 'Box';
    case 'wedge': return 'Wedge';
    case 'cylinder': return 'Cylinder';
    case 'cone': return 'Cone';
    case 'sphere': return 'Sphere';
    case 'torus': return 'Torus';
    case 'extrude': return 'Extrusion';
    case 'revolve': return 'Revolution';
    case 'boolean': return f.op === 'union' ? 'Union' : f.op === 'subtract' ? 'Subtraction' : 'Intersection';
    case 'mesh': return f.source === 'imported' ? 'Mesh (imported)' : 'Mesh (edited)';
  }
}

/** The rows for one solid. Numbers use four decimals like the 2D rows. */
export function solidRows(solid: Solid3D): SolidRow[] {
  const num = (v: number) => v.toFixed(4);
  const box = meshBounds(solid.mesh);
  const size = box ? aabbSize(box) : { x: 0, y: 0, z: 0 };
  return [
    { label: 'Type', value: featureLabel(solid.feature) },
    { label: 'Layer', value: solid.layer, edit: 'layer' },
    { label: 'Color', value: String(solid.color), edit: 'color' },
    { label: 'Name', value: solid.name ?? '', edit: 'name' },
    { label: 'Triangles', value: String(meshTriangleCount(solid.mesh)) },
    { label: 'Volume', value: num(meshVolume(solid.mesh)) },
    { label: 'Size X', value: num(size.x) },
    { label: 'Size Y', value: num(size.y) },
    { label: 'Size Z', value: num(size.z) },
  ];
}

/** The selected solids, in model order. */
export function selectedSolids(solids: readonly Solid3D[], selection: ReadonlySet<string>): Solid3D[] {
  return selection.size ? solids.filter((s) => selection.has(s.id)) : [];
}
