import { afterEach, describe, expect, it, vi } from 'vitest';
import * as entities from '../src/core/entities';
import { hatchGeometry, type HatchEntity, type Layer } from '../src/core/entities';
import type { Point } from '../src/core/geometry';
import { pointInLoops } from '../src/core/hatch';
import { Drawing } from '../src/core/document';
import { sealImmutableData } from '../src/core/immutable-data';
import { readDxf, writeDxf } from '../src/io/dxf';
import { drawEntity } from '../src/render/draw';
import { lowerHatchStrokes, MAX_HATCH_PATTERN_WORLD_COORDINATE, type HatchStrokeView, type LoweredHatchStrokes } from '../src/render/gpu-prototype/hatch-strokes';

const square = (size: number, x = 0, y = 0) => ({ points: [{ x, y }, { x: x + size, y }, { x: x + size, y: y + size }, { x, y: y + size }] });
const hatch = (patch: Partial<HatchEntity> = {}): HatchEntity => ({ id: 'hatch', type: 'hatch', layer: '0', color: 3, solid: false, pattern: 'LINE', scale: 1, angle: 0, loops: [square(8)], ...patch });
const view: HatchStrokeView = { center: { x: 0, y: 0 }, scale: 20, twist: 0, dpr: 1 };
const accepted = (result: LoweredHatchStrokes) => {
  if (!result.ok) throw new Error(result.reason);
  return result;
};
const layer: Layer = { name: '0', color: 3, visible: true, locked: false, lineWeight: 0.25 };

/** Trace the real drawEntity/drawHatch wrapper, including its context rotation and dots. */
function canvasHatch(source: HatchEntity, camera = view) {
  const strokes: Point[][] = [], dots: Point[] = [];
  let current: Point[][] = [], angle = 0;
  const stack: number[] = [];
  const at = (x: number, y: number): Point => ({ x: x * Math.cos(angle) - y * Math.sin(angle), y: x * Math.sin(angle) + y * Math.cos(angle) });
  const context = {
    globalAlpha: 1, lineWidth: 1, strokeStyle: '', fillStyle: '', lineCap: 'butt', lineJoin: 'miter',
    save() { stack.push(angle); }, restore() { angle = stack.pop()!; },
    rotate(rotation: number) { angle += rotation; }, setLineDash() {},
    beginPath() { current = []; },
    moveTo(x: number, y: number) { current.push([at(x, y)]); },
    lineTo(x: number, y: number) { current[current.length - 1]!.push(at(x, y)); },
    stroke() { strokes.push(...current); },
    fillRect(x: number, y: number) { dots.push(at(x, y)); },
  };
  drawEntity(context as unknown as CanvasRenderingContext2D, source, {
    scale: camera.scale, rotation: camera.twist,
    toScreen(point) {
      const dx = point.x - camera.center.x, dy = point.y - camera.center.y;
      return { x: 160 + (dx * Math.cos(camera.twist) - dy * Math.sin(camera.twist)) * camera.scale, y: 120 - (dx * Math.sin(camera.twist) + dy * Math.cos(camera.twist)) * camera.scale };
    },
  }, [layer], () => undefined);
  return { strokes, dots };
}

function expectCanvasPaths(source: HatchEntity, camera = view): void {
  const result = accepted(lowerHatchStrokes(source, camera));
  const canvas = canvasHatch(source, camera);
  expect(canvas.dots).toHaveLength(0);
  expect(result.paths).toHaveLength(canvas.strokes.length);
  for (let i = 0; i < result.paths.length; i += 1) {
    const path = result.paths[i]!;
    expect(path.closed).toBe(false);
    for (let j = 0; j < 2; j += 1) {
      const local = path.points[j]!, actual = canvas.strokes[i]![j]!;
      const x = 160 + (local.x * Math.cos(camera.twist) - local.y * Math.sin(camera.twist)) * camera.scale;
      const y = 120 - (local.x * Math.sin(camera.twist) + local.y * Math.cos(camera.twist)) * camera.scale;
      expect(actual.x).toBeCloseTo(x, 7); expect(actual.y).toBeCloseTo(y, 7);
    }
  }
}

afterEach(() => vi.restoreAllMocks());

describe('conservative canonical GPU hatch strokes', () => {
  it.each(['LINE', 'NET', 'ANSI31', 'ANSI37'])('preserves the actual Canvas family order, phase and endpoints for %s', (pattern) => {
    const source = sealImmutableData(hatch({ pattern, origin: { x: 0.13, y: 0.27 }, angle: 0.17, scale: 8 }));
    const before = JSON.stringify(source);
    expectCanvasPaths(source, { ...view, scale: 10_000, twist: 0.43, dpr: 2, center: { x: 2, y: 3 } });
    expect(JSON.stringify(source)).toBe(before);
  });

  it('preserves nested islands and a concave polygon without cropping loops to the view', () => {
    const source = hatch({ loops: [square(10), square(6, 2, 2), square(2, 4, 4)] });
    const result = accepted(lowerHatchStrokes(source, view));
    const middle = result.paths.filter((path) => path.points[0].y === 5);
    expect(middle.map((path) => path.points.map((point) => point.x))).toEqual([[0, 2], [4, 6], [8, 10]]);
    for (const path of result.paths) {
      const [a, b] = path.points;
      expect(pointInLoops({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, source.loops.map((loop) => loop.points))).toBe(true);
    }
    const concave = hatch({ loops: [{ points: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 8 }, { x: 0, y: 8 }] }, square(1, 0.5, 3)] });
    expectCanvasPaths(concave);
    const far = accepted(lowerHatchStrokes(source, { ...view, center: { x: 10_000, y: -20_000 } }));
    expect(far.paths.map((path) => path.points.map((point) => ({ x: point.x + 10_000, y: point.y - 20_000 })))).toEqual(result.paths.map((path) => path.points));
  });

  it('keeps authoritative file families, along-line dash shifts and double patterns', () => {
    const source = hatch({ pattern: 'LINE', double: true, origin: { x: 999, y: 999 }, scale: 0.00001, patternLines: [
      { angle: 0, base: { x: 0.2, y: 0.2 }, offset: { x: 0.3, y: 1 }, dashes: [0.8, -0.4] },
      { angle: Math.PI / 2, base: { x: 0.25, y: 0.3 }, offset: { x: -1, y: 0.2 }, dashes: [] },
    ] });
    expectCanvasPaths(source, { ...view, scale: 10_000 });
    const local = accepted(lowerHatchStrokes(source, { ...view, scale: 10_000, center: { x: 2, y: 3 } }));
    expect(local.paths.map((path) => path.points)).toEqual(hatchGeometry(source).segments.map((segment) => segment.map((point) => ({ x: point.x - 2, y: point.y - 3 }))));
  });

  it('uses unrotated axis spans from the actual Canvas wrapper rather than Euclidean or twisted lengths', () => {
    const narrow = hatch({ loops: [{ points: [{ x: 0, y: 0 }, { x: 0.6, y: 0 }, { x: 0.6, y: 2 }, { x: 0, y: 2 }] }] });
    for (const twist of [0, Math.PI / 4, 0.43]) {
      const camera = { ...view, scale: 1, twist };
      expectCanvasPaths(narrow, camera);
      const result = accepted(lowerHatchStrokes(narrow, camera));
      expect(result.minRatio).toBeGreaterThan(0.5 / 0.6);
      expect(result.minRatio).toBeLessThan(0.834);
      const dots = canvasHatch(narrow, { ...camera, scale: 0.8 });
      expect(dots.dots.length).toBeGreaterThan(0);
      expect(lowerHatchStrokes(narrow, { ...camera, scale: 0.8 })).toMatchObject({ ok: false, reason: expect.stringContaining('short strokes') });
    }
    const diagonal = hatch({ patternLines: [{ angle: Math.PI / 4, base: { x: 0, y: 0 }, offset: { x: -100, y: 100 }, dashes: [] }], loops: [{ points: [{ x: -0.05, y: 0.05 }, { x: 0.35, y: 0.45 }, { x: 0.45, y: 0.35 }, { x: 0.05, y: -0.05 }] }] });
    for (const twist of [0, Math.PI / 4]) {
      const camera = { ...view, scale: 1, twist };
      expect(canvasHatch(diagonal, camera).dots).toHaveLength(1);
      expect(lowerHatchStrokes(diagonal, camera)).toMatchObject({ ok: false, reason: expect.stringContaining('short strokes') });
    }
  });

  it('leaves threshold-adjacent, explicit dots and dense model geometry to Canvas at every zoom', () => {
    const atThreshold = hatch({ loops: [{ points: [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 2 }, { x: 0, y: 2 }] }] });
    expect(lowerHatchStrokes(atThreshold, { ...view, scale: 1 })).toMatchObject({ ok: false });
    const explicitDots = hatch({ patternLines: [{ angle: 0, base: { x: 0, y: 0 }, offset: { x: 0, y: 1 }, dashes: [0, -1] }] });
    expect(lowerHatchStrokes(explicitDots, view)).toMatchObject({ ok: false, reason: expect.stringContaining('pattern dots') });
    const dense = hatch({ scale: 0.000001 });
    expect(hatchGeometry(dense).dense).toBe(true);
    for (const scale of [0.01, 20, 10_000]) expect(lowerHatchStrokes(dense, { ...view, scale })).toMatchObject({ ok: false, reason: expect.stringContaining('Dense hatch') });
  });

  it('preflights unsafe indices and bounded generator work before entering hatchGeometry', () => {
    const generator = vi.spyOn(entities, 'hatchGeometry');
    const unsafe = hatch({ patternLines: [{ angle: 0, base: { x: 0, y: -MAX_HATCH_PATTERN_WORLD_COORDINATE }, offset: { x: 0, y: 1e-9 }, dashes: [] }] });
    expect(lowerHatchStrokes(unsafe, view)).toMatchObject({ ok: false, reason: expect.stringContaining('Unsafe hatch pattern line index') });
    expect(lowerHatchStrokes(hatch(), view, { maxBoundaryPoints: 3 })).toMatchObject({ ok: false, reason: expect.stringContaining('boundary-point budget') });
    expect(lowerHatchStrokes(hatch(), view, { maxSegments: 1 })).toMatchObject({ ok: false, reason: expect.stringContaining('segment budget') });
    expect(lowerHatchStrokes(hatch(), view, { maxWork: 1 })).toMatchObject({ ok: false, reason: expect.stringContaining('preparation-work budget') });
    const excessiveDashWork = hatch({ patternLines: [{ angle: 0, base: { x: 0, y: 0 }, offset: { x: 0, y: 1 }, dashes: [1e-9, -1e-9] }] });
    expect(lowerHatchStrokes(excessiveDashWork, view)).toMatchObject({ ok: false, reason: expect.stringContaining('dash-work budget') });
    expect(generator).not.toHaveBeenCalled();
  });

  it('admits the documented phase-coordinate limit and refuses beyond it, including 1e12', () => {
    const limit = MAX_HATCH_PATTERN_WORLD_COORDINATE;
    const within = hatch({ origin: { x: limit - 2, y: 0 }, loops: [square(2, limit - 2)] });
    expectCanvasPaths(within, { ...view, center: { x: limit - 1, y: 1 } });
    const generator = vi.spyOn(entities, 'hatchGeometry');
    for (const origin of [limit + 1, 1e12]) {
      const source = hatch({ origin: { x: origin, y: origin }, loops: [square(2, origin, origin)] });
      expect(lowerHatchStrokes(source, { ...view, center: { x: origin, y: origin } })).toMatchObject({ ok: false, reason: expect.stringContaining('large-world hatch phase') });
    }
    expect(generator).not.toHaveBeenCalled();
  });

  it.each([
    { solid: true }, { pattern: 'DOTS' }, { pattern: 'BRICK' }, { annotative: true }, { transparency: 128 },
    { angle: Infinity }, { scale: 0 }, { origin: { x: NaN, y: 0 } },
    { loops: [{ ...square(2), bulges: [0.1] }] },
    { patternLines: [{ angle: 0, base: { x: 0, y: 0 }, offset: { x: 0, y: Infinity }, dashes: [] }] },
    { patternLines: [{ angle: 0, base: { x: 0, y: 0 }, offset: { x: 0, y: 1 }, dashes: [NaN] }] },
  ] satisfies Partial<HatchEntity>[])('refuses unsupported/unsafe hatch input without exposing partial paths: %j', (patch) => {
    const result = lowerHatchStrokes(hatch(patch), view);
    expect(result.ok).toBe(false); expect(result).not.toHaveProperty('paths');
  });

  it('refuses highlights, resolved layer transparency, invalid view and invalid budgets', () => {
    for (const options of [{ selected: true }, { hovered: true }, { alpha: 0.95 }, { maxWork: -1 }, { maxSegments: 40_001 }, { minRatio: 0 }, { maxRatio: 0.9 }]) expect(lowerHatchStrokes(hatch(), view, options)).toMatchObject({ ok: false });
    for (const camera of [{ ...view, scale: 0 }, { ...view, dpr: Infinity }, { ...view, twist: NaN }, { ...view, center: { x: Infinity, y: 0 } }]) expect(lowerHatchStrokes(hatch(), camera)).toMatchObject({ ok: false });
  });

  it('retains native DXF islands and authoritative file-line overrides through edit, undo and save/reopen', () => {
    const original = hatch({ loops: [square(10), square(6, 2, 2)], double: true, patternLines: [
      { angle: 0, base: { x: 0, y: 0.25 }, offset: { x: 0, y: 1 }, dashes: [] },
      { angle: Math.PI / 2, base: { x: 0.25, y: 0 }, offset: { x: -1, y: 0 }, dashes: [] },
    ] });
    const document = new Drawing(); document.addEntities([original]);
    const imported = new Drawing(readDxf(writeDxf(document.snapshot)));
    const before = imported.entities.find((entity): entity is HatchEntity => entity.type === 'hatch')!;
    expect(before.patternLines).toHaveLength(2); expect(before.loops).toHaveLength(2);
    expectCanvasPaths(before);
    imported.replaceEntities([{ ...before, patternLines: before.patternLines!.map((line) => ({ ...line, base: { x: line.base.x + 0.25, y: line.base.y + 0.25 } })) }]);
    const edited = imported.entities[0] as HatchEntity;
    expect(accepted(lowerHatchStrokes(edited, view)).paths).not.toEqual(accepted(lowerHatchStrokes(before, view)).paths);
    imported.undo(); expect(imported.entities[0]).toBe(before);
    imported.redo();
    const saved = readDxf(writeDxf(imported.snapshot)).entities[0] as HatchEntity;
    expect(saved.type).toBe('hatch'); expect(saved.patternLines).toHaveLength(2); expect(saved.loops).toHaveLength(2);
    expectCanvasPaths(saved);
    expect(accepted(lowerHatchStrokes(saved, view)).paths).toEqual(accepted(lowerHatchStrokes(edited, view)).paths);
  });
});
