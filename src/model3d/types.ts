/**
 * The experimental 3D model kept in `DrawingState.model3d`: solids with an evaluated mesh plus the
 * feature (construction history) that produced it.
 *
 * Everything here is plain, immutable data so it seals, shares and undoes like the 2D entities.
 * World coordinates are AutoCAD's WCS (X right, Y up, Z toward the viewer, right-handed), lengths
 * are drawing units and angles radians; see src/model3d/math.ts. The mesh is the source of truth
 * for display, picking and budgets; the feature records how to rebuild it (later milestones edit
 * a feature and re-evaluate) and is never re-evaluated implicitly on load.
 */
import type { ColorSpec } from '../core/entities';
import type { Point } from '../core/geometry';
import type { Frame3, Vec3 } from './math';
import type { Mesh3D } from './mesh';

/** One solid body: identity and appearance like a 2D entity, geometry as a closed outward mesh. */
export interface Solid3D {
  /** Stable id from `newId()` (the same id space as 2D entities, so selection sets can mix them). */
  readonly id: string;
  /** Layer name; visibility / lock / colour inheritance follow the 2D layer table. */
  readonly layer: string;
  readonly color: ColorSpec;
  /** Optional user label (Properties palette). */
  readonly name?: string;
  /** Evaluated geometry in world coordinates, wound counter-clockwise seen from outside. */
  readonly mesh: Mesh3D;
  /** How the mesh was made; `MeshFeature` when the history is unknown. */
  readonly feature: Feature3D;
}

/**
 * Optional tessellation detail for curved primitives. Absent values use the documented defaults
 * in primitives.ts; out-of-range values are clamped there, never rejected, so stored features
 * always regenerate.
 */
interface Tessellated {
  /** Divisions around the circle (around the Z axis of the frame). */
  readonly segments?: number;
}

/**
 * Rectangular box: `width` along the frame X axis, `depth` along Y, `height` along Z. The base
 * lies on the frame's XY plane centred on its origin; the box extends toward +Z.
 */
export interface BoxFeature {
  readonly kind: 'box';
  readonly frame: Frame3;
  readonly width: number;
  readonly depth: number;
  readonly height: number;
}

/** Circular cylinder: base disc on the frame's XY plane centred on its origin, extending +Z. */
export interface CylinderFeature extends Tessellated {
  readonly kind: 'cylinder';
  readonly frame: Frame3;
  readonly radius: number;
  readonly height: number;
}

/** Sphere centred on the frame origin (like AutoCAD SPHERE's centre point). */
export interface SphereFeature extends Tessellated {
  readonly kind: 'sphere';
  readonly frame: Frame3;
  readonly radius: number;
  /** Latitude bands from pole to pole. */
  readonly rings?: number;
}

/**
 * Cone or frustum: base radius on the frame's XY plane centred on its origin, top radius at
 * z = height. Either radius may be 0 (a pointed end) but not both.
 */
export interface ConeFeature extends Tessellated {
  readonly kind: 'cone';
  readonly frame: Frame3;
  readonly baseRadius: number;
  readonly topRadius: number;
  readonly height: number;
}

/**
 * Ring torus centred on the frame origin (like AutoCAD TORUS's centre point), its axis along the
 * frame Z axis: `majorRadius` from the axis to the tube centre, `minorRadius` of the tube
 * (0 < minor < major).
 */
export interface TorusFeature extends Tessellated {
  readonly kind: 'torus';
  readonly frame: Frame3;
  readonly majorRadius: number;
  readonly minorRadius: number;
  /** Divisions around the tube cross-section. */
  readonly rings?: number;
}

/**
 * Wedge (AutoCAD WEDGE): a box `width` x `depth` x `height` cut diagonally. The base lies on the
 * frame's XY plane centred on its origin; the full-height face is at x = -width / 2 and the sloped
 * face falls to the base edge at x = +width / 2.
 */
export interface WedgeFeature {
  readonly kind: 'wedge';
  readonly frame: Frame3;
  readonly width: number;
  readonly depth: number;
  readonly height: number;
}

/**
 * A planar profile: closed polygon loops in the XY plane of `frame` (frame-local 2D coordinates,
 * drawing units). The first loop is the outer boundary, the rest are holes; loops are implicitly
 * closed (the last point connects to the first, which is not repeated). Arcs and splines have
 * already been flattened to polylines by the sketch step.
 */
export interface Profile3D {
  readonly frame: Frame3;
  readonly loops: readonly (readonly Point[])[];
}

/** Linear extrusion of a profile by `distance` along its frame's +Z axis (negative = -Z). */
export interface ExtrudeFeature {
  readonly kind: 'extrude';
  readonly profile: Profile3D;
  readonly distance: number;
}

/**
 * Revolution of a profile about an axis (world coordinates; `dir` need not be unit length) by
 * `angle` radians, right-hand rule about `dir`; 2 * PI gives a full revolution.
 */
export interface RevolveFeature {
  readonly kind: 'revolve';
  readonly profile: Profile3D;
  readonly axis: { readonly origin: Vec3; readonly dir: Vec3 };
  readonly angle: number;
}

/** Constructive solid geometry on exactly two operand features (subtract = first minus second). */
export interface BooleanFeature {
  readonly kind: 'boolean';
  readonly op: 'union' | 'subtract' | 'intersect';
  readonly operands: readonly Feature3D[];
}

/** A solid whose history is unknown: imported meshes, or meshes edited directly. */
export interface MeshFeature {
  readonly kind: 'mesh';
  readonly source: 'imported' | 'edited';
}

/** Construction history of a solid. */
export type Feature3D = BoxFeature | CylinderFeature | SphereFeature | ConeFeature | TorusFeature | WedgeFeature | ExtrudeFeature | RevolveFeature | BooleanFeature | MeshFeature;

/** The analytic primitives that `primitiveMesh` can evaluate directly. */
export type PrimitiveFeature = BoxFeature | CylinderFeature | SphereFeature | ConeFeature | TorusFeature | WedgeFeature;

/**
 * The 3D content of a drawing. `version` lets a future file format or migration recognise the
 * layout of this data.
 */
export interface Model3D {
  readonly version: 1;
  readonly solids: readonly Solid3D[];
}
