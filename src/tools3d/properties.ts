/**
 * Properties palette rows for experimental 3D solids (pure, so it is tested in Node; the palette
 * in src/ui/properties.ts renders them). Editable rows: layer, colour, name. Read-only rows: the
 * type (feature kind), triangle count, volume and bounding-box size, in drawing units.
 */
import type { Drawing } from '../core/document';
import type { ColorSpec, Entity } from '../core/entities';
import { type UnitSettings, formatAngle, formatLength } from '../core/units';
import { aabbSize } from '../model3d/math';
import { meshBounds, meshTriangleCount, meshVolume } from '../model3d/mesh';
import { dimensionById, model3dOf, replaceDimension3D, replaceSolid, solidById, withModel3D } from '../model3d/model';
import { dimension3dKindLabel, dimension3dMeasurement, dimension3dText, planeDescription, withTextOverride3D } from '../model3d/dimension3d';
import type { Dimension3D, Feature3D, Solid3D } from '../model3d/types';

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

/**
 * The palette header of a selection mixing groups (2D objects, solids, 3D dimensions):
 * "All (4: 2 objects, 1 solid, 1 3D dimension)". Groups with no member are left out.
 */
export function mixedSelectionLabel(objects: number, solids: number, dims: number): string {
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const parts = [objects ? n(objects, 'object', 'objects') : '', solids ? n(solids, 'solid', 'solids') : '', dims ? n(dims, '3D dimension', '3D dimensions') : ''].filter(Boolean);
  return `All (${objects + solids + dims}: ${parts.join(', ')})`;
}

/** A Layer / Color edit of the Properties palette. */
export interface LayerColorPatch {
  readonly layer?: string;
  readonly color?: ColorSpec;
}

/**
 * Apply a Layer / Color edit to a mixed selection in ONE undo step: the 2D `entities` (a colour
 * edit clears their true colour / colour book as the 2D palette does), and the solids and 3D
 * dimensions with the given ids (their current state). Budget errors propagate unchanged.
 */
export function patchMixedSelection(doc: Drawing, entities: readonly Entity[], solidIds: readonly string[], dimIds: readonly string[], patch: LayerColorPatch): void {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const p3 = { ...(patch.layer !== undefined ? { layer: patch.layer } : {}), ...(patch.color !== undefined ? { color: patch.color } : {}) };
  const p2 = { ...p3, ...(patch.color !== undefined ? { trueColor: undefined, colorName: undefined, colorLayer: undefined } : {}) };
  doc.transact((st) => {
    const ents = byId.size ? st.entities.map((e) => (byId.has(e.id) ? ({ ...e, ...p2 } as Entity) : e)) : st.entities;
    let model = model3dOf(st);
    for (const id of solidIds) {
      const cur = solidById(model, id);
      if (cur) model = replaceSolid(model, { ...cur, ...p3 });
    }
    for (const id of dimIds) {
      const cur = dimensionById(model, id);
      if (cur) model = replaceDimension3D(model, { ...cur, ...p3 });
    }
    return withModel3D(ents === st.entities ? st : { ...st, entities: ents }, model);
  });
}

/** One palette row of a 3D dimension: `edit` marks the editable ones. */
export interface Dimension3DRow {
  readonly label: string;
  readonly value: string;
  readonly edit?: 'layer' | 'color' | 'text';
}

/**
 * The palette rows of a 3D dimension: Type, Kind, Measurement (read-only, drawing units or degrees
 * with the drawing precision; "(projected)" when it measures a projection), Text override
 * (editable; empty = the measurement), Dimension text (what it shows), Layer, Color, Plane.
 */
export function dimension3dRows(dim: Dimension3D, units: Pick<UnitSettings, 'lunits' | 'luprec' | 'auprec'>): Dimension3DRow[] {
  const v = dimension3dMeasurement(dim);
  const measured = dim.kind === 'angular' ? `${formatAngle(v, Math.max(2, units.auprec))} degrees` : formatLength(v, units);
  return [
    { label: 'Type', value: '3D Dimension' },
    { label: 'Kind', value: dimension3dKindLabel(dim) },
    { label: 'Measurement', value: dim.projected ? `${measured} (projected)` : measured },
    { label: 'Text override', value: dim.textOverride ?? '', edit: 'text' },
    { label: 'Dimension text', value: dimension3dText(dim) },
    { label: 'Layer', value: dim.layer, edit: 'layer' },
    { label: 'Color', value: String(dim.color), edit: 'color' },
    { label: 'Plane', value: planeDescription(dim.plane) },
  ];
}

/** The selected 3D dimensions, in model order. */
export function selectedDimensions3D(dims: readonly Dimension3D[] | undefined, selection: ReadonlySet<string>): Dimension3D[] {
  return selection.size && dims ? dims.filter((d) => selection.has(d.id)) : [];
}

/**
 * Set (or with '' clear) the text override of the 3D dimension `id` in one undo step (the
 * Properties palette's Text override row). Returns false when there is no such dimension or the
 * text is unchanged.
 */
export function setDimension3DText(doc: Drawing, id: string, text: string): boolean {
  const cur = dimensionById(doc.snapshot.model3d ?? { version: 1, solids: [] }, id);
  const next = text === '' ? undefined : text;
  if (!cur || cur.textOverride === next) return false;
  const updated = withTextOverride3D(cur, next);
  doc.updateModel3D((m) => replaceDimension3D(m, updated));
  return true;
}
