import { describe, it, expect, beforeAll } from 'vitest';
import {
  type Camera3D, VIEW_PRESETS, type ViewPresetName, applyPreset, cameraBasis, cameraEye, cameraFrom2D, cameraProjection, cameraView, cameraViewRelative, clipRange,
  defaultCamera, eyeDirection, matchingPreset, orbit, pan, parseViewPreset, projectToScreen, rayFromScreen, setProjection, viewHeightAtTarget, withOrthoClearance, zoom, zoomToBounds,
} from '../src/render3d/camera';
import { type Vec3, add3, cross3, dist3, dot3, len3, mat4Multiply, normalize3, scale3, sub3, transformPoint, v3 } from '../src/model3d/math';
import type { Viewport as ViewportType } from '../src/render/viewport';
import { Drawing } from '../src/core/document';

const W = 800, H = 600;
const close = (a: number, b: number, tol = 1e-6) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);
const closeV = (a: Vec3, b: Vec3, tol = 1e-9) => expect(dist3(a, b)).toBeLessThanOrEqual(tol);

/** Deterministic pseudo-random numbers (LCG) so failures reproduce. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const cams = (): Camera3D[] => {
  const base = { ...defaultCamera(v3(3, -2, 1), 12), distance: 40 };
  return [
    base,
    applyPreset(base, 'swIso'),
    setProjection(applyPreset(base, 'neIso'), 'perspective'),
    setProjection(orbit(base, 0.7, -0.4), 'perspective'),
    orbit(applyPreset(base, 'front'), 0.2, 0.1),
  ];
};

describe('Camera3D basis and presets', () => {
  it('has an orthonormal right-handed basis at every pitch, including the poles', () => {
    for (const pitch of [-Math.PI / 2, -1, 0, 0.3, Math.PI / 2]) {
      for (const yaw of [-3, -Math.PI / 2, 0, 1, 2.5]) {
        const b = cameraBasis({ ...defaultCamera(), yaw, pitch });
        close(len3(b.forward), 1); close(len3(b.right), 1); close(len3(b.up), 1);
        close(dot3(b.forward, b.right), 0); close(dot3(b.forward, b.up), 0); close(dot3(b.right, b.up), 0);
        closeV(cross3(b.right, b.up), scale3(b.forward, -1), 1e-12);
      }
    }
  });

  const expected: Record<ViewPresetName, { from: Vec3; up: Vec3; right?: Vec3 }> = {
    top: { from: v3(0, 0, 1), up: v3(0, 1, 0), right: v3(1, 0, 0) },
    bottom: { from: v3(0, 0, -1), up: v3(0, 1, 0), right: v3(-1, 0, 0) },
    front: { from: v3(0, -1, 0), up: v3(0, 0, 1), right: v3(1, 0, 0) },
    back: { from: v3(0, 1, 0), up: v3(0, 0, 1), right: v3(-1, 0, 0) },
    left: { from: v3(-1, 0, 0), up: v3(0, 0, 1), right: v3(0, -1, 0) },
    right: { from: v3(1, 0, 0), up: v3(0, 0, 1), right: v3(0, 1, 0) },
    swIso: { from: normalize3(v3(-1, -1, 1)), up: normalize3(v3(1, 1, 2)), right: normalize3(v3(1, -1, 0)) },
    seIso: { from: normalize3(v3(1, -1, 1)), up: normalize3(v3(-1, 1, 2)), right: normalize3(v3(1, 1, 0)) },
    neIso: { from: normalize3(v3(1, 1, 1)), up: normalize3(v3(-1, -1, 2)), right: normalize3(v3(-1, 1, 0)) },
    nwIso: { from: normalize3(v3(-1, 1, 1)), up: normalize3(v3(1, -1, 2)), right: normalize3(v3(-1, -1, 0)) },
  };

  for (const name of Object.keys(VIEW_PRESETS) as ViewPresetName[]) {
    it(`preset ${name} looks at the target from the AutoCAD direction`, () => {
      const cam = applyPreset({ ...defaultCamera(v3(5, 6, 7)), distance: 10 }, name);
      const b = cameraBasis(cam);
      const e = expected[name];
      closeV(eyeDirection(cam), e.from, 1e-12);
      closeV(normalize3(sub3(cameraEye(cam), cam.target)), e.from, 1e-12);
      closeV(b.up, e.up, 1e-12);
      if (e.right) closeV(b.right, e.right, 1e-12);
      expect(matchingPreset(cam)).toBe(name);
      // The view matrix maps the target straight ahead on the -Z axis at the eye distance.
      closeV(transformPoint(cameraView(cam), cam.target), v3(0, 0, -10), 1e-9);
    });
  }

  it('SW isometric shows +X to the right and +Z up', () => {
    const cam = applyPreset(defaultCamera(v3(0, 0, 0), 10), 'swIso');
    const o = projectToScreen(cam, v3(0, 0, 0), W, H)!;
    const x = projectToScreen(cam, v3(1, 0, 0), W, H)!;
    const y = projectToScreen(cam, v3(0, 1, 0), W, H)!;
    const z = projectToScreen(cam, v3(0, 0, 1), W, H)!;
    expect(x.x).toBeGreaterThan(o.x);
    expect(y.x).toBeLessThan(o.x);
    expect(z.y).toBeLessThan(o.y);
    close(z.x, o.x, 1e-9);
  });

  it('parses preset names from user input', () => {
    expect(parseViewPreset('swiso')).toBe('swIso');
    expect(parseViewPreset('SW')).toBe('swIso');
    expect(parseViewPreset(' Top ')).toBe('top');
    expect(parseViewPreset('ne-iso')).toBe('neIso');
    expect(parseViewPreset('plan')).toBe('top');
    expect(parseViewPreset('sideways')).toBeNull();
  });
});

describe('Camera3D navigation', () => {
  it('orbit keeps the distance and target and clamps pitch at the poles (no flip)', () => {
    let cam = applyPreset({ ...defaultCamera(v3(1, 2, 3)), distance: 17 }, 'swIso');
    const target = cam.target;
    for (let i = 0; i < 50; i++) {
      cam = orbit(cam, 0.31, 0.2);
      close(dist3(cameraEye(cam), cam.target), 17, 1e-9);
      expect(cam.target).toEqual(target);
      expect(cam.pitch).toBeLessThanOrEqual(Math.PI / 2);
    }
    expect(cam.pitch).toBe(Math.PI / 2);
    cam = orbit(cam, 0, -10);
    expect(cam.pitch).toBe(-Math.PI / 2);
    expect(Math.abs(cam.yaw)).toBeLessThanOrEqual(Math.PI);
  });

  it('pan moves the content with the cursor by the pixel distance', () => {
    for (const cam of cams()) {
      const p = cam.target;
      const before = projectToScreen(cam, p, W, H)!;
      const moved = pan(cam, 37, -21, H);
      const after = projectToScreen(moved, p, W, H)!;
      close(after.x - before.x, 37, 1e-6);
      close(after.y - before.y, -21, 1e-6);
      close(moved.distance, cam.distance, 0);
    }
  });

  it('zoom at the cursor keeps the anchored point under the cursor', () => {
    for (const cam of cams()) {
      const ray = rayFromScreen(cam, 610, 133, W, H);
      const z = zoom(cam, 1.7, ray);
      // The anchor: where the ray meets the plane through the target facing the camera.
      const n = eyeDirection(cam);
      const t = dot3(sub3(cam.target, ray.origin), n) / dot3(ray.dir, n);
      const anchor = add3(ray.origin, scale3(ray.dir, t));
      const s = projectToScreen(z, anchor, W, H)!;
      close(s.x, 610, 1e-6);
      close(s.y, 133, 1e-6);
      close(viewHeightAtTarget(z), viewHeightAtTarget(cam) / 1.7, 1e-9);
    }
  });

  it('switching projection keeps the framing at the target depth', () => {
    const cam = defaultCamera(v3(0, 0, 0), 20);
    const p = setProjection(cam, 'perspective');
    close(viewHeightAtTarget(p), 20, 1e-9);
    close(setProjection(p, 'orthographic').orthoHeight, 20, 1e-9);
  });

  it('zoomToBounds frames the box and puts the eye outside it', () => {
    for (const cam of cams()) {
      const box = { min: v3(-3, 4, 0), max: v3(9, 10, 5) };
      const z = zoomToBounds(cam, box, W / H);
      for (let i = 0; i < 8; i++) {
        const c = v3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
        const s = projectToScreen(z, c, W, H)!;
        expect(s).not.toBeNull();
        expect(s.x).toBeGreaterThanOrEqual(-1e-6); expect(s.x).toBeLessThanOrEqual(W + 1e-6);
        expect(s.y).toBeGreaterThanOrEqual(-1e-6); expect(s.y).toBeLessThanOrEqual(H + 1e-6);
        expect(s.depth).toBeGreaterThan(0);
      }
    }
    expect(zoomToBounds(defaultCamera(), null, 1)).toEqual(defaultCamera());
  });

  it('ortho clearance moves the eye behind the scene without changing the image', () => {
    const cam = applyPreset({ ...defaultCamera(v3(0, 0, 0), 10), distance: 1 }, 'seIso');
    const box = { min: v3(-50, -50, -50), max: v3(50, 50, 50) };
    const c = withOrthoClearance(cam, box);
    expect(c.distance).toBeGreaterThan(cam.distance);
    const p = v3(7, -3, 2);
    const a = projectToScreen(cam, p, W, H)!, b = projectToScreen(c, p, W, H)!;
    close(a.x, b.x, 1e-9); close(a.y, b.y, 1e-9);
    for (let i = 0; i < 8; i++) {
      const corner = v3(i & 1 ? 50 : -50, i & 2 ? 50 : -50, i & 4 ? 50 : -50);
      expect(projectToScreen(c, corner, W, H)!.depth).toBeGreaterThan(0);
    }
    const persp = setProjection(cam, 'perspective');
    expect(withOrthoClearance(persp, box)).toBe(persp);
  });
});

describe('Camera3D projection and rays', () => {
  it('a point under the cursor projects back to the same screen position (round trip)', () => {
    const r = rng(7);
    for (const cam of cams()) {
      for (let i = 0; i < 40; i++) {
        const sx = r() * W, sy = r() * H;
        const ray = rayFromScreen(cam, sx, sy, W, H);
        close(len3(ray.dir), 1, 1e-12);
        const p = add3(ray.origin, scale3(ray.dir, 1 + r() * 60));
        const s = projectToScreen(cam, p, W, H)!;
        close(s.x, sx, 1e-6);
        close(s.y, sy, 1e-6);
      }
    }
  });

  it('projectToScreen agrees with the WebGL projection x view matrices', () => {
    const r = rng(11);
    for (const cam of cams()) {
      const near = 0.5, far = 500;
      const vp = mat4Multiply(cameraProjection(cam, W / H, near, far), cameraView(cam));
      const rel = mat4Multiply(cameraProjection(cam, W / H, near, far), cameraViewRelative(cam, cam.target));
      for (let i = 0; i < 20; i++) {
        const p = v3(cam.target.x + (r() - 0.5) * 10, cam.target.y + (r() - 0.5) * 10, cam.target.z + (r() - 0.5) * 10);
        const ndc = transformPoint(vp, p);
        const ndcRel = transformPoint(rel, sub3(p, cam.target));
        const s = projectToScreen(cam, p, W, H)!;
        close((ndc.x + 1) * W / 2, s.x, 1e-6);
        close((1 - ndc.y) * H / 2, s.y, 1e-6);
        closeV(ndc, ndcRel, 1e-9);
      }
    }
  });

  it('perspective points behind the eye do not project', () => {
    const cam = setProjection(defaultCamera(v3(0, 0, 0), 10), 'perspective');
    expect(projectToScreen(cam, add3(cameraEye(cam), v3(0, 0, 1)), W, H)).toBeNull();
  });

  it('clipRange contains the scene and keeps a positive perspective near plane', () => {
    const box = { min: v3(-5, -5, -5), max: v3(5, 5, 5) };
    for (const cam of cams()) {
      const { near, far } = clipRange(cam, box);
      expect(far).toBeGreaterThan(near);
      if (cam.projection === 'perspective') expect(near).toBeGreaterThan(0);
      const b = cameraBasis(cam);
      for (let i = 0; i < 8; i++) {
        const c = v3(i & 1 ? 5 : -5, i & 2 ? 5 : -5, i & 4 ? 5 : -5);
        const d = dot3(sub3(c, b.eye), b.forward);
        if (d > 0 || cam.projection === 'orthographic') {
          expect(d).toBeGreaterThanOrEqual(near);
          expect(d).toBeLessThanOrEqual(far);
        }
      }
    }
  });
});

describe('top view matches the 2D viewport', () => {
  let Viewport: typeof ViewportType;
  beforeAll(async () => {
    Viewport = (await import('../src/render/viewport')).Viewport;
  });
  const stub = () => ({ getContext: () => ({}), getBoundingClientRect: () => ({ width: W, height: H, left: 0, top: 0 }), width: 0, height: 0 }) as unknown as HTMLCanvasElement;

  for (const twist of [0, 0.4, -1.2]) {
    it(`maps (x, y, 0) like Viewport.toScreen with the same scale and centre (twist ${twist})`, () => {
      const vp = new Viewport(stub(), new Drawing());
      vp.width = W; vp.height = H; vp.scale = 37.5; vp.center = { x: 12.25, y: -4.5 }; vp.twist = twist;
      const cam = cameraFrom2D(vp.center, vp.scale, vp.height, vp.twist);
      const r = rng(3);
      for (let i = 0; i < 25; i++) {
        const p = { x: (r() - 0.5) * 40 + 12, y: (r() - 0.5) * 30 - 4 };
        const a = vp.toScreen(p);
        const b = projectToScreen(cam, v3(p.x, p.y, 0), W, H)!;
        close(b.x, a.x, 1e-6);
        close(b.y, a.y, 1e-6);
      }
      if (twist === 0) expect(matchingPreset(cam)).toBe('top');
    });
  }
});
