import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import type { BlockDef, HatchEntity, InsertEntity } from '../src/core/entities';
import { blockTransform, distanceToEntity, entityGeometryWork, explodeCompound, explodeInsert, hatchGeometry, hatchPatternLines, mirrorEntityAcross, rotateEntity, scaleEntityBy, translateEntity } from '../src/core/entities';
import { hatchGradientColorRgb, hatchGradientCoordinates, hatchGradientDataProblem, hatchGradientFrame, hatchGradientRenderProblem, hasHatchGradient, interpolateGradientRgb, linearHatchGradientAxis, linearHatchGradientPlan, transformHatchGradientFrame, type HatchGradient } from '../src/core/hatch-gradient';
import type { Point } from '../src/core/geometry';

const rectangle = (x: number, y: number, width: number, height: number) => ({ points: [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }] });
const gradient = (extra: Partial<HatchGradient> = {}): HatchGradient => ({ name: 'LINEAR', angle: 0, shift: 0, singleColor: false, tint: 0, colors: [{ position: 0, color: 1, trueColor: 0xff0000 }, { position: 1, color: 5, trueColor: 0x0000ff }], ...extra });
const hatch = (extra: Partial<HatchEntity> = {}): HatchEntity => ({ id: 'h', type: 'hatch', layer: '0', color: 'ByLayer', pattern: 'SOLID', solid: true, angle: 0, scale: 1, loops: [rectangle(0, 0, 20, 10)], gradient: gradient(), ...extra });
const coordinates = (entity: HatchEntity, point: Point): Point => hatchGradientCoordinates(hatchGradientFrame(entity)!, point)!;
const closePoint = (actual: Point, expected: Point): void => {
  expect(actual.x).toBeCloseTo(expected.x, 10);
  expect(actual.y).toBeCloseTo(expected.y, 10);
};

describe('native HATCH gradient model', () => {
  it('keeps gradient fill independent of a retained pattern and respects islands when picked', () => {
    const filled = hatch({ pattern: 'ANSI31', solid: false, loops: [rectangle(0, 0, 20, 10), rectangle(5, 2, 4, 4)] });
    expect(hatchPatternLines(filled)).toEqual([]);
    expect(hatchGeometry(filled).segments).toEqual([]);
    expect(distanceToEntity({ x: 2, y: 4 }, filled, () => undefined)).toBe(0);
    expect(distanceToEntity({ x: 7, y: 4 }, filled, () => undefined)).toBe(2);
    expect(explodeCompound(filled)).toBeNull();
    const ordinary = hatch({ gradient: gradient({ kind: 0, colors: [] }), pattern: 'LINE', solid: false });
    expect(hasHatchGradient(ordinary)).toBe(false);
    expect(hatchPatternLines(ordinary).length).toBeGreaterThan(0);
    expect(hatchGeometry(ordinary).segments.length).toBeGreaterThan(0);
    expect(explodeCompound(ordinary)).toBeNull();
    expect(explodeCompound({ ...ordinary, gradient: undefined })!.every((part) => part.type === 'line')).toBe(true);
  });

  it('retains well-formed unsupported native definitions without inventing their rendering', () => {
    for (const descriptor of [gradient({ name: 'SPHERICAL' }), gradient({ shift: 0.5 }), gradient({ shift: 1 }), gradient({ kind: 3 }), gradient({ reserved: 9 }), gradient({ colorMode: 6 }), gradient({ colors: [{ position: 0, color: 2 }], colorCount: 1 }), gradient({ colors: [{ position: 0, color: 0 }, { position: 1, color: 256 }] })]) {
      expect(hatchGradientDataProblem(descriptor)).toBeNull();
      expect(hatchGradientRenderProblem(descriptor)).not.toBeNull();
      const entity = hatch({ gradient: descriptor, solid: false });
      expect(linearHatchGradientPlan(entity)).toBeNull();
      expect(distanceToEntity({ x: 10, y: 5 }, entity, () => undefined)).toBe(0);
      expect(translateEntity(entity, { x: 1, y: 2 })).toMatchObject({ gradient: descriptor });
    }
    expect(hatchGradientRenderProblem(gradient({ kind: 0, name: 'UNKNOWN', colors: [] }))).toBeNull();
  });

  it('takes the stored RGB/ACI endpoints even for single-colour dialog settings', () => {
    const descriptor = gradient({ singleColor: true, tint: 0.7 });
    const plan = linearHatchGradientPlan(hatch({ gradient: descriptor }))!;
    expect(plan.colors).toEqual(descriptor.colors);
    expect(plan.shift).toBe(0);
    expect(interpolateGradientRgb(0xff0000, 0x0000ff, 0)).toBe(0xff0000);
    expect(interpolateGradientRgb(0xff0000, 0x0000ff, 0.5)).toBe(0x800080);
    expect(interpolateGradientRgb(0xff0000, 0x0000ff, 1)).toBe(0x0000ff);
    expect(interpolateGradientRgb(0xff0000, 0x0000ff, -1)).toBe(0xff0000);
    expect(interpolateGradientRgb(0xff0000, 0x0000ff, 2)).toBe(0x0000ff);
    expect(hatchGradientColorRgb({ position: 0, color: 0 }, () => 0xffffff)).toBe(0);
    // AutoCAD normalizes ACI7 without group421 to RGB white even when plotting on white paper.
    expect(hatchGradientColorRgb({ position: 1, color: 7 }, () => 0)).toBe(0xffffff);
    expect(hatchGradientColorRgb({ position: 1, color: 7, trueColor: 0 }, () => 0xffffff)).toBe(0);
    expect(hatchGradientColorRgb({ position: 0, color: 1, trueColor: 0 }, () => 0xff0000)).toBe(0);
    expect(hatchGradientColorRgb({ position: 1, color: 3 }, () => 0x00ff00)).toBe(0x00ff00);
    expect(hatchGradientColorRgb({ position: 1, color: 256 }, () => 0xffffff)).toBeNull();
  });

  it('rejects malformed retained gradient data before changing undo/history or dirty state', () => {
    const doc = new Drawing({ entities: [hatch()] });
    const before = doc.snapshot;
    for (const descriptor of [gradient({ angle: Infinity }), gradient({ shift: NaN }), gradient({ tint: -0.1 }), gradient({ name: 'LINEAR\nBAD' }), gradient({ name: '  ' }), gradient({ colorMode: 1 }), gradient({ colorMode: 3, singleColor: true }), gradient({ colorCount: 3 }), gradient({ colors: Array.from({ length: 17 }, () => ({ position: 0, color: 1 })) }), gradient({ colors: [{ position: 0, trueColor: 0x1000000 }, { position: 1, color: 3 }] })]) {
      expect(hatchGradientDataProblem(descriptor)).not.toBeNull();
      expect(() => doc.replaceEntities([hatch({ gradient: descriptor })])).toThrow();
      expect(doc.snapshot).toBe(before);
      expect(doc.dirty).toBe(false);
      expect(doc.undo()).toBe(false);
    }
    expect(() => doc.replaceEntities([hatch({ gradientFrame: { origin: { x: NaN, y: 0 }, x: { x: 1, y: 0 }, y: { x: 0, y: 1 } } })])).toThrow('gradient hatch frame');
    expect(doc.snapshot).toBe(before);
    expect(entityGeometryWork(hatch())).toBeGreaterThan(entityGeometryWork(hatch({ gradient: undefined })));
  });

  it('keeps the immutable native descriptor across copy, edit, undo and redo', () => {
    const original = hatch({ gradient: gradient({ singleColor: true, tint: 0.4, colorMode: 1, reserved: 0, colorCount: 2 }) });
    const doc = new Drawing({ entities: [original] });
    const descriptor = (doc.entities[0] as HatchEntity).gradient;
    doc.replaceEntities([translateEntity(doc.entities[0]!, { x: 20, y: 10 })]);
    expect((doc.entities[0] as HatchEntity).gradient).toBe(descriptor);
    expect(doc.dirty).toBe(true);
    expect(doc.undo()).toBe(true);
    expect(doc.entities[0]).toEqual(original);
    expect(doc.redo()).toBe(true);
    expect((doc.entities[0] as HatchEntity).gradient).toEqual(original.gradient);
  });
});

describe('gradient affine coordinates', () => {
  it('matches unshifted native rectangular LINEAR fields at 0, 45 and 90 degrees', () => {
    // The private AutoCAD PDF oracle validated gradient-oriented projected extents.
    const sample = { x: 4, y: 3 };
    for (const [angle, value] of [[0, sample.x / 20], [Math.PI / 4, (sample.x + sample.y) / 30], [Math.PI / 2, sample.y / 10]]) {
      const plan = linearHatchGradientPlan(hatch({ gradient: gradient({ angle: angle! }) }))!;
      expect(hatchGradientCoordinates(plan.frame, sample)!.x).toBeCloseTo(value!, 10);
    }
  });

  it('projects native bounding-box corners outside triangular and concave boundaries', () => {
    const triangle = hatch({ loops: [{ points: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 0, y: 100 }] }], gradient: gradient({ angle: Math.PI / 4 }) });
    const concave = hatch({ loops: [{ points: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 20 }, { x: 50, y: 20 }, { x: 50, y: 100 }, { x: 0, y: 100 }] }], gradient: gradient({ angle: Math.PI / 4 }) });
    for (const entity of [triangle, concave]) {
      // AutoCAD normalized/PDF oracle: RGB 59..60 at (50,20), not the actual-vertex projection's 89.
      expect(coordinates(entity, { x: 50, y: 20 }).x).toBeCloseTo(70 / 300, 10);
    }
  });

  it('uses finite normalized coordinates independent of translation and uniform drawing scale', () => {
    const original = hatch();
    const frame = hatchGradientFrame(original)!;
    closePoint(frame.origin, { x: 0, y: 0 });
    closePoint(frame.x, { x: 20, y: 0 });
    closePoint(frame.y, { x: 0, y: 10 });
    closePoint(coordinates(original, { x: 5, y: 7.5 }), { x: 0.25, y: 0.75 });
    const moved = translateEntity(original, { x: -1000, y: 2000 }) as HatchEntity;
    closePoint(coordinates(moved, { x: -995, y: 2007.5 }), { x: 0.25, y: 0.75 });
    const scaled = scaleEntityBy(original, { x: 0, y: 0 }, 3) as HatchEntity;
    closePoint(coordinates(scaled, { x: 15, y: 22.5 }), { x: 0.25, y: 0.75 });
    for (const size of [1e-250, 1e250, 1e300]) closePoint(hatchGradientCoordinates({ origin: { x: 0, y: 0 }, x: { x: size, y: 0 }, y: { x: 0, y: size } }, { x: size * 0.25, y: size * 0.75 })!, { x: 0.25, y: 0.75 });
    const subnormal = hatchGradientCoordinates({ origin: { x: 0, y: 0 }, x: { x: 1e-320, y: 0 }, y: { x: 0, y: 1e-320 } }, { x: 2.5e-321, y: 7.5e-321 })!;
    expect(subnormal.x).toBeCloseTo(0.25, 3);
    expect(subnormal.y).toBeCloseTo(0.75, 3);
  });

  it('keeps the verified native world angle during direct rotation and evaluates the resulting world bounding box', () => {
    const original = hatch({ angle: 0.7, gradient: gradient() });
    const point = { x: 6, y: 3 };
    const before = coordinates(original, point);
    const rotation = Math.PI / 4;
    const tf = (p: Point): Point => ({ x: p.x * Math.cos(rotation) - p.y * Math.sin(rotation), y: p.x * Math.sin(rotation) + p.y * Math.cos(rotation) });
    const rotated = rotateEntity(original, { x: 0, y: 0 }, rotation) as HatchEntity;
    expect(rotated.gradient).toBe(original.gradient);
    expect(rotated.angle).toBeCloseTo(0.7 + rotation);
    expect(rotated.gradientFrame).toBeUndefined();
    closePoint(rotated.loops[0]!.points[0]!, tf(original.loops[0]!.points[0]!));
    // Rotated AABB spans x=-10/sqrt(2)..20/sqrt(2); direct native ROTATE leaves 460=0.
    expect(coordinates(rotated, tf(point)).x).toBeCloseTo((point.x - point.y + 10) / 30, 10);
    const inserted = blockTransform(original, tf, rotation, 1, 1, false) as HatchEntity;
    expect(inserted.gradientFrame).toBeDefined();
    closePoint(coordinates(inserted, tf(point)), before);
  });

  it('keeps the verified native world angle during direct MIRROR and SCALE', () => {
    // AutoCAD normalized DXF retains 460=.4 after SCALE2 and MIRROR with MIRRHATCH0 or1.
    const descriptor = gradient({ angle: 0.4 });
    const original = hatch({ gradient: descriptor });
    const mirrored = mirrorEntityAcross(original, { x: 0, y: 0 }, { x: 0, y: 1 }) as HatchEntity;
    expect(mirrored.gradient).toBe(descriptor);
    expect(mirrored.gradientFrame).toBeUndefined();
    expect(mirrored.loops[0]!.points[1]).toEqual({ x: -20, y: 0 });
    const c = Math.cos(0.4), s = Math.sin(0.4);
    expect(coordinates(mirrored, { x: -6, y: 3 }).x).toBeCloseTo((14 * c + 3 * s) / (20 * c + 10 * s), 10);
    const scaled = scaleEntityBy(original, { x: 0, y: 0 }, 2) as HatchEntity;
    expect(scaled.gradient).toBe(descriptor);
    expect(scaled.gradientFrame).toBeUndefined();
    expect(coordinates(scaled, { x: 12, y: 6 }).x).toBeCloseTo(coordinates(original, { x: 6, y: 3 }).x, 10);
  });

  it('matches the native 45-degree INSERT gradient colour samples in definition coordinates', () => {
    const original = hatch({ loops: [rectangle(0, 0, 200, 100)] });
    const angle = Math.PI / 4;
    const tf = (p: Point): Point => ({ x: 500 + p.x * Math.cos(angle) - p.y * Math.sin(angle), y: 200 + p.x * Math.sin(angle) + p.y * Math.cos(angle) });
    const displayed = blockTransform(original, tf, angle, 1, 1, false) as HatchEntity;
    // AutoCAD block oracle PDF: gray64,127,191 at local(50,20),(100,20),(150,50).
    for (const [point, value] of [[{ x: 50, y: 20 }, 0.25], [{ x: 100, y: 20 }, 0.5], [{ x: 150, y: 50 }, 0.75]] as const) expect(coordinates(displayed, tf(point)).x).toBeCloseTo(value, 10);
  });

  it('uses definition-space gradients through the actual uniform INSERT expansion path', () => {
    const original = hatch({ loops: [rectangle(0, 0, 200, 100)] });
    const block: BlockDef = { name: 'G', basePoint: { x: 0, y: 0 }, entities: [original], attributes: [] };
    const ref: InsertEntity = { id: 'ref', type: 'insert', layer: '0', color: 'ByLayer', block: 'G', position: { x: 150, y: 410 }, rotation: Math.PI / 4, scale: 1, attributes: {} };
    const displayed = explodeInsert(ref, (name) => name === 'G' ? block : undefined)[0] as HatchEntity;
    expect(displayed.gradientFrame).toBeDefined();
    for (const [point, value] of [[{ x: 50, y: 20 }, 0.25], [{ x: 100, y: 20 }, 0.5], [{ x: 150, y: 50 }, 0.75]] as const) {
      const world = { x: 150 + (point.x - point.y) / Math.sqrt(2), y: 410 + (point.x + point.y) / Math.sqrt(2) };
      expect(coordinates(displayed, world).x).toBeCloseTo(value, 10);
    }
    expect(original.gradientFrame).toBeUndefined();
  });

  it('keeps the local field through actual nested uniform rotations and definition base points', () => {
    const original = hatch({ loops: [rectangle(10, 20, 200, 100)] });
    const inner: InsertEntity = { id: 'inner', type: 'insert', layer: '0', color: 'ByLayer', block: 'G', position: { x: 30, y: 40 }, rotation: Math.PI / 6, scale: 2, attributes: {} };
    const blocks: Record<string, BlockDef> = {
      G: { name: 'G', basePoint: { x: 10, y: 20 }, entities: [original], attributes: [] },
      Parent: { name: 'Parent', basePoint: { x: 5, y: 7 }, entities: [inner], attributes: [] },
    };
    const outer: InsertEntity = { id: 'outer', type: 'insert', layer: '0', color: 'ByLayer', block: 'Parent', position: { x: 500, y: 600 }, rotation: Math.PI / 4, scale: 3, attributes: {} };
    const displayed = explodeInsert(outer, (name) => blocks[name])[0] as HatchEntity;
    expect(displayed.gradientFrame).toBeDefined();
    for (const [point, value] of [[{ x: 50, y: 20 }, 0.25], [{ x: 100, y: 20 }, 0.5], [{ x: 150, y: 50 }, 0.75]] as const) {
      const x = 30 + 2 * (point.x * Math.cos(Math.PI / 6) - point.y * Math.sin(Math.PI / 6)) - 5;
      const y = 40 + 2 * (point.x * Math.sin(Math.PI / 6) + point.y * Math.cos(Math.PI / 6)) - 7;
      const world = { x: 500 + 3 * (x - y) / Math.sqrt(2), y: 600 + 3 * (x + y) / Math.sqrt(2) };
      expect(coordinates(displayed, world).x).toBeCloseTo(value, 10);
    }
  });

  it('preserves the field through nonuniform, mirrored and nested block transforms', () => {
    const original = hatch({ gradient: gradient({ angle: Math.PI / 4 }) });
    const point = { x: 7, y: 4 };
    const expected = coordinates(original, point);
    const tf = (p: Point): Point => ({ x: 10 - 4 * p.x, y: 30 + p.y * 0.5 });
    const transformed = blockTransform(original, tf, 0, -4, 0.5, true) as HatchEntity;
    expect(transformed.gradientFrame).toBeDefined();
    closePoint(coordinates(transformed, tf(point)), expected);
    const axis = linearHatchGradientAxis(transformed.gradientFrame!)!;
    const direction = { x: axis.end.x - axis.start.x, y: axis.end.y - axis.start.y };
    const axisValue = (p: Point): number => ((p.x - axis.start.x) * direction.x + (p.y - axis.start.y) * direction.y) / (direction.x ** 2 + direction.y ** 2);
    expect(axisValue(tf(point))).toBeCloseTo(expected.x, 10);
    const sameX = { x: tf(point).x + transformed.gradientFrame!.y.x * 0.2, y: tf(point).y + transformed.gradientFrame!.y.y * 0.2 };
    expect(axisValue(sameX)).toBeCloseTo(expected.x, 10);
    const tf2 = (p: Point): Point => ({ x: 100 + 2 * p.y, y: 50 - 3 * p.x });
    const nested = blockTransform(transformed, tf2, -Math.PI / 2, 3, 2, false) as HatchEntity;
    closePoint(coordinates(nested, tf2(tf(point))), expected);
    const moved = translateEntity(nested, { x: 5, y: -6 }) as HatchEntity;
    closePoint(coordinates(moved, { x: tf2(tf(point)).x + 5, y: tf2(tf(point)).y - 6 }), expected);
    expect(original.gradientFrame).toBeUndefined();
    const smallTf = (p: Point): Point => ({ x: p.x * 1e-13, y: p.y * 5e-13 });
    const small = blockTransform(original, smallTf, 0, 1e-13, 5e-13, false) as HatchEntity;
    expect(small.gradientFrame).toBeDefined();
    closePoint(coordinates(small, smallTf(point)), expected);
  });

  it('returns no rendering plan for degenerate bounds and refuses a collapsing affine transform', () => {
    const degenerate = hatch({ loops: [rectangle(0, 0, 20, 0)] });
    expect(hatchGradientFrame(degenerate)).toBeNull();
    expect(linearHatchGradientPlan(degenerate)).toBeNull();
    expect(hatchGradientCoordinates({ origin: { x: 0, y: 0 }, x: { x: 0, y: 0 }, y: { x: 0, y: 1 } }, { x: 0, y: 0 })).toBeNull();
    expect(linearHatchGradientAxis({ origin: { x: 0, y: 0 }, x: { x: 0, y: 0 }, y: { x: 0, y: 1 } })).toBeNull();
    expect(() => transformHatchGradientFrame(hatchGradientFrame(hatch())!, () => ({ x: 0, y: 0 }))).toThrow('Gradient hatch transform');
  });

  it('rejects finite frame components whose corners overflow without mutating history', () => {
    const invalid = { origin: { x: 1e308, y: 0 }, x: { x: 1e308, y: 0 }, y: { x: 0, y: 1 } };
    const h = hatch({ gradientFrame: invalid }), doc = new Drawing({ entities: [hatch()] });
    const before = doc.snapshot, history = doc.history();
    expect(linearHatchGradientPlan(h)).toBeNull();
    expect(() => doc.replaceEntities([h])).toThrow('gradient hatch frame');
    expect(doc.snapshot).toBe(before); expect(doc.history()).toEqual(history);
    const invalidLastCorner = { origin: { x: 0, y: 0 }, x: { x: 1e308, y: 0 }, y: { x: 1e308, y: 1 } };
    expect(linearHatchGradientPlan(hatch({ gradientFrame: invalidLastCorner }))).toBeNull();
  });
});
