/**
 * A stand-in for Viewport3D (no WebGL in Node) so the 3D-mode routing of src/app/experimental-3d.ts
 * (clicks, cursor moves, 3D snaps, grips) can be tested: a plan view looking straight down -Z with
 * `PX` CSS pixels per drawing unit, screen (0, 0) at world (0, H / PX) and y growing downward.
 * Picking is the real CPU path (`pickSolids`); 3D dimensions are picked first by their display
 * segments within `dimensionAperture` px (`pickDimension3D`), as Viewport3D does.
 */
import type { Drawing } from '../../src/core/document';
import type { Ray, Vec3 } from '../../src/model3d/math';
import { model3dOf } from '../../src/model3d/model';
import { type PickHit, pickSolids } from '../../src/render3d/picking';
import { hiddenLayerNames } from '../../src/render3d/scene-sink';
import { pickDimension3D, visibleDimensions3D } from '../../src/render3d/dimension3d-scene';
import type { Viewport3D, Viewport3DOverlay } from '../../src/render3d/viewport3d';

export const PX = 10;
export const H = 600;

export interface FakeViewport3D {
  overlays: Viewport3DOverlay[];
  toScreen(p: Vec3): { x: number; y: number };
  pixelRay(x: number, y: number): Ray;
  pickExact(x: number, y: number): PickHit | null;
  pick(x: number, y: number): string | null;
  requestRender(ov: Viewport3DOverlay): void;
  lastPickPath: 'cpu';
  dimensionAperture: number;
}

/** Screen position (CSS px) of world x, y. */
export const screenOf = (x: number, y: number) => ({ x: x * PX, y: H - y * PX });

export function fakeViewport3d(doc: Drawing): FakeViewport3D & Viewport3D {
  const vp: FakeViewport3D = {
    overlays: [],
    lastPickPath: 'cpu',
    dimensionAperture: 4,
    toScreen: (p) => screenOf(p.x, p.y),
    pixelRay: (x, y) => ({ origin: { x: x / PX, y: (H - y) / PX, z: 1000 }, dir: { x: 0, y: 0, z: -1 } }),
    pickExact: (x, y) => {
      const state = doc.snapshot;
      return pickSolids(model3dOf(state), vp.pixelRay(x, y), { hiddenLayers: hiddenLayerNames(state.layers) })[0] ?? null;
    },
    pick: (x, y) => {
      const state = doc.snapshot;
      const dims = visibleDimensions3D(state.model3d?.dimensions, state.layers);
      return pickDimension3D(dims, vp.toScreen, x, y, vp.dimensionAperture, state.layers) ?? vp.pickExact(x, y)?.id ?? null;
    },
    requestRender: (ov) => void vp.overlays.push(ov),
  };
  return vp as FakeViewport3D & Viewport3D;
}
