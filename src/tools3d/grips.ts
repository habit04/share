/**
 * 3D grips (experimental PROTOTYPE, milestone 4 of docs/3D-PLAN.md). When exactly one solid is
 * selected in 3D mode and no command runs, the 3D view shows grips at the eight corners of the
 * solid's bounding box and at its centre (small squares like the 2D grips). Dragging the CENTRE
 * grip moves the solid by the cursor's motion on the plane through the grip parallel to the
 * construction plane (or, when that plane is seen edge-on, the plane facing the viewer); the
 * moved solid shows as a ghost and releasing the button applies the move as one undoable step
 * (`commitSolidEdit`). Corner grips are display-only; there is no grip stretching, no object
 * snapping and no typed input while dragging.
 */
import { type Frame3, type Ray, type Vec3, add3, aabbCenter, dot3, intersectRayPlane, len3, normalize3, scale3, sub3 } from '../model3d/math';
import { meshBounds } from '../model3d/mesh';
import type { Solid3D } from '../model3d/types';

/** Grip points of a solid: the 8 bounding-box corners, then the centre (index 8). */
export function solidGrips(solid: Solid3D): Vec3[] {
  const box = meshBounds(solid.mesh);
  if (!box) return [];
  const out: Vec3[] = [];
  for (let i = 0; i < 8; i++) out.push({ x: i & 1 ? box.max.x : box.min.x, y: i & 2 ? box.max.y : box.min.y, z: i & 4 ? box.max.z : box.min.z });
  out.push(aabbCenter(box));
  return out;
}

/** Index of the centre grip in `solidGrips`. */
export const CENTER_GRIP = 8;

/**
 * The normal of the plane a grip is dragged on: the construction plane's normal, or the viewing
 * direction when the view looks along the plane (|cos| below 0.1).
 */
export function gripDragNormal(plane: Frame3, viewDir: Vec3): Vec3 {
  const n = normalize3(plane.zAxis);
  const v = normalize3(viewDir);
  return Math.abs(dot3(n, v)) >= 0.1 || len3(v) === 0 ? n : v;
}

/**
 * Where the cursor ray meets the drag plane through `grip` (normal `normal`), or null when the
 * ray runs parallel to it or points away.
 */
export function gripDragPoint(grip: Vec3, normal: Vec3, ray: Ray): Vec3 | null {
  const t = intersectRayPlane(ray, { origin: grip, normal });
  return t === null ? null : add3(ray.origin, scale3(ray.dir, t));
}

/** The translation that moves the centre grip from `grip` to the cursor's drag point (or null). */
export function gripDragDisplacement(grip: Vec3, normal: Vec3, ray: Ray): Vec3 | null {
  const p = gripDragPoint(grip, normal, ray);
  return p ? sub3(p, grip) : null;
}
