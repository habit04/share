import { afterEach, describe, expect, it, vi } from 'vitest';
import * as entities from '../src/core/entities';
import { hatchGeometry, type HatchEntity, type Layer } from '../src/core/entities';
import type { Point } from '../src/core/geometry';
import { pointInLoops } from '../src/core/hatch';
import { Drawing } from '../src/core/document';
import { sealImmutableData } from '../src/core/immutable-data';
import { readDxf, writeDxf } from '../src/io/dxf';
import { drawEntity } from '../src/render/draw';
import { lowerHatchStrokes, MAX_HATCH_PATTERN_WORLD_COORDINATE, HATCH_CANVAS_PIXEL_RESERVE, type HatchStrokeView, type LoweredHatchStrokes } from '../src/render/gpu-prototype/hatch-strokes';
import * as strokeParity from '../src/render/gpu-prototype/stroke-parity';
import * as nativeBounds from '../src/render/gpu-prototype/native-float-stroke-bound';
import { isSourcePrecisionCertificateError, isSourceTopologyAdmissionError } from '../src/render/gpu-prototype/stroke-precision-error';

const square = (size: number, x = 0, y = 0) => ({ points: [{ x, y }, { x: x + size, y }, { x: x + size, y: y + size }, { x, y: y + size }] });
const hatch = (patch: Partial<HatchEntity> = {}): HatchEntity => ({ id: 'hatch', type: 'hatch', layer: '0', color: 3, solid: false, pattern: 'LINE', scale: 1, angle: 0, loops: [square(8)], ...patch });
const view: HatchStrokeView = { center: { x: 0, y: 0 }, scale: 20, twist: 0, dpr: 1, width: 320, height: 240, background: '#212830' };
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
    expectCanvasPaths(source, { ...view, scale: 100, twist: 0, dpr: 2, center: { x: 2, y: 3 } });
    // Keep the exact former high-zoom/twisted pose as a conservative native control.
    const originalPose = lowerHatchStrokes(source, { ...view, scale: 10_000, twist: 0.43, dpr: 2, center: { x: 2, y: 3 } });
    expect(originalPose).toMatchObject({ ok: false, reason: 'Unsupported Canvas stroke construction: native context rotation is unproved' });
    expect(originalPose).not.toHaveProperty('paths');
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
    // Supported native construction currently has zero view twist. The nonzero
    // controls below retain their original camera and must use complete Canvas.
    for (const twist of [0]) {
      const camera = { ...view, scale: 1, twist };
      expectCanvasPaths(narrow, camera);
      const result = accepted(lowerHatchStrokes(narrow, camera));
      expect(result.minRatio).toBeGreaterThan((0.5 + 0.0625) / 0.6);
      expect(result.minRatio).toBeLessThan(0.938);
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

  it('reserves physical construction error around the next representable span above 0.5 CSS pixels through actual Canvas twist/pan', () => {
    const next = 0.5 + Number.EPSILON / 2;
    expect(next).toBeGreaterThan(0.5);
    const beyondRelativeReserve = 0.5 * (1 + 128 * Number.EPSILON);
    expect(beyondRelativeReserve).toBeGreaterThan(0.5 * (1 + 64 * Number.EPSILON));
    for (const span of [next, beyondRelativeReserve]) {
      const source = hatch({ loops: [{ points: [{ x: 0, y: 0 }, { x: span, y: 0 }, { x: span, y: 2 }, { x: 0, y: 2 }] }] });
      expect(hatchGeometry(source).segments.every(([a, b]) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) > 0.5)).toBe(true);
      let roundedToDots = false;
      for (const twist of [0, 0.17, 0.3, 0.43, Math.PI / 4]) for (const center of [{ x: 0, y: 0 }, { x: 0.125, y: -0.375 }, { x: 1_000_000.125, y: -1_000_000.375 }]) {
        const camera = { ...view, scale: 1, twist, center };
        const actual = canvasHatch(source, camera);
        if (actual.dots.length) roundedToDots = true;
        expect(lowerHatchStrokes(source, camera)).toMatchObject({ ok: false, reason: expect.stringContaining('short strokes') });
      }
      expect(roundedToDots).toBe(true);
    }
    for (const dpr of [1, 2, 3]) {
      const justOutside = 0.5 + HATCH_CANVAS_PIXEL_RESERVE / dpr + 0.001;
      const safe = hatch({ loops: [{ points: [{ x: 0, y: 0 }, { x: justOutside, y: 0 }, { x: justOutside, y: 2 }, { x: 0, y: 2 }] }] });
      const result = accepted(lowerHatchStrokes(safe, { ...view, scale: 1, dpr, twist: 0 }));
      expect(lowerHatchStrokes(safe, { ...view, scale: 1, dpr, twist: 0.43 })).toMatchObject({ ok: false, reason: 'Unsupported Canvas stroke construction: native context rotation is unproved' });
      expect(result.minRatio * justOutside).toBeGreaterThan(0.5 + HATCH_CANVAS_PIXEL_RESERVE / dpr);
      const camera = { ...view, scale: result.minRatio, dpr, twist: 0, center: { x: -120 / result.minRatio, y: 80 / result.minRatio } };
      expect(canvasHatch(safe, camera).dots).toHaveLength(0);
    }
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
    const zigzag = Array.from({ length: 32 }, (_, index) => ({ x: index, y: index % 2 ? 1 : -1 }));
    const manyIntersections = hatch({ loops: [{ points: zigzag }], patternLines: [{ angle: 0, base: { x: 0, y: 0 }, offset: { x: 0, y: 10 }, dashes: [] }] });
    expect(lowerHatchStrokes(manyIntersections, view, { maxWork: zigzag.length * 3 })).toMatchObject({ ok: false, reason: expect.stringContaining('preparation-work budget') });
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

  it.each([RangeError, TypeError])('retains the original %s prototype and identity without enumerating failure provenance', (FailureType) => {
    // This message deliberately resembles an admission-prefix allowlist entry. Its
    // native exception type must survive instead of being converted to a plain Error.
    const cause = new FailureType('Nonfinite hatch coordinate from interrupted allocation');
    const generator = vi.spyOn(entities, 'hatchGeometry').mockImplementationOnce(() => { throw cause; });
    const source = sealImmutableData(hatch());
    const result = lowerHatchStrokes(source, view);
    if (result.ok) throw new Error('Expected generator failure');
    expect(result.cause).toBe(cause);
    expect(Object.getPrototypeOf(result.cause)).toBe(FailureType.prototype);
    expect(Object.getOwnPropertyDescriptor(result, 'cause')).toMatchObject({ value: cause, enumerable: false });
    expect(Object.keys(result)).toEqual(['ok', 'reason']);
    expect(JSON.parse(JSON.stringify(result))).toEqual({ ok: false, reason: cause.message });
    expect(result).not.toHaveProperty('paths');
    // No failed immutable certificate is recorded on an exception: same source retries.
    expect(lowerHatchStrokes(source, view).ok).toBe(true);
    expect(generator).toHaveBeenCalledTimes(3); // Failed first call, then actual + fresh.
  });

  it('preserves nested original Error causes rather than flattening them into the hatch refusal message', () => {
    const original = new TypeError('temporary canonical generator failure');
    const wrapper = new Error('Nonfinite hatch coordinate', { cause: original });
    vi.spyOn(entities, 'hatchPatternLines').mockImplementationOnce(() => { throw wrapper; });
    const result = lowerHatchStrokes(hatch(), view);
    if (result.ok) throw new Error('Expected preflight failure');
    expect(result.cause).toBe(wrapper);
    expect(Object.getOwnPropertyDescriptor(result.cause, 'cause')?.value).toBe(original);
    expect(Object.getOwnPropertyDescriptor(result, 'cause')?.enumerable).toBe(false);
    expect(JSON.stringify(result)).toBe(JSON.stringify({ ok: false, reason: wrapper.message }));
  });

  it('does not turn a fresh-canonical-pass exception into a persistent mismatch certificate', () => {
    const source = sealImmutableData(hatch());
    const actual = hatchGeometry(source);
    const cause = new RangeError('Nonfinite hatch coordinate from fresh canonical allocation');
    const generator = vi.spyOn(entities, 'hatchGeometry').mockReturnValueOnce(actual).mockImplementationOnce(() => { throw cause; });
    const failure = lowerHatchStrokes(source, view);
    if (failure.ok) throw new Error('Expected fresh-pass failure');
    expect(failure.cause).toBe(cause);
    expect(failure.reason).toBe(cause.message);
    expect(generator).toHaveBeenCalledTimes(2);
    generator.mockClear();
    const retry = accepted(lowerHatchStrokes(source, view));
    expect(retry.paths.map((path) => path.points)).toEqual(actual.segments);
    expect(generator).toHaveBeenCalledTimes(2);
  });

  it('retains non-Error throws as internal provenance and keeps ordinary admission errors unchanged in JSON', () => {
    const opaque = { allocationInterrupted: true };
    vi.spyOn(entities, 'hatchPatternLines').mockImplementationOnce(() => { throw opaque; });
    const unexpected = lowerHatchStrokes(hatch(), view);
    if (unexpected.ok) throw new Error('Expected non-Error failure');
    expect(unexpected.cause).toBe(opaque);
    expect(JSON.parse(JSON.stringify(unexpected))).toEqual({ ok: false, reason: 'Hatch preparation failed' });
    const admission = lowerHatchStrokes(hatch({ solid: true }), view);
    if (admission.ok) throw new Error('Expected solid hatch refusal');
    expect(Object.getPrototypeOf(admission.cause)).toBe(Error.prototype);
    expect((admission.cause as Error).message).toBe(admission.reason);
    expect(Object.keys(admission)).toEqual(['ok', 'reason']);
  });
});


describe('hatch native source certificate and endpoint provenance', () => {
  it.each([1, 2])('certifies original world endpoints with the resolved Canvas width at DPR %s', (dpr) => {
    const source = sealImmutableData(hatch({ origin: { x: 0.13, y: 0.27 }, loops: [square(8, 0.13, 0.27)] }));
    const native = hatchGeometry(source).segments;
    const camera = { ...view, dpr, center: { x: 2.125, y: -0.375 } };
    const proof = vi.spyOn(strokeParity, 'assertStrokePathPrecision');
    const before = JSON.stringify(source);
    const result = accepted(lowerHatchStrokes(source, camera, { widthCss: 2.5 }));
    expect(proof).toHaveBeenCalledTimes(native.length);
    result.paths.forEach((path, index) => {
      const call = proof.mock.calls[index]!;
      expect(call[0]).toEqual(path.points); expect(call[1]).toEqual(native[index]);
      expect(call[1][0]).toBe(native[index]![0]); expect(call[1][1]).toBe(native[index]![1]);
      expect(call.slice(2)).toEqual([false, 2.5, camera, 1.25]);
      expect(path.worldPoints).toEqual(native[index]);
      expect(path.worldPoints[0]).not.toBe(native[index]![0]); // Private provenance copies.
      expect(path.worldPoints[1]).not.toBe(native[index]![1]);
    });
    expect(result.sourcePoints).toEqual(source.loops.flatMap((loop) => loop.points.map((point) => ({ x: point.x - camera.center.x, y: point.y - camera.center.y }))));
    expect(JSON.stringify(source)).toBe(before);
  });

  it('never reconstructs native world endpoints from rounded anchor-local subtraction', () => {
    const source = sealImmutableData(hatch({ origin: { x: 0.13, y: 0.27 }, loops: [square(8, 0.13, 0.27)] }));
    const native = hatchGeometry(source).segments;
    const camera = { ...view, center: { x: 1_000_000.125, y: -1_000_000.375 } };
    const proof = vi.spyOn(strokeParity, 'assertStrokePathPrecision');
    const result = lowerHatchStrokes(source, camera, { widthCss: 1 });
    expect(result.ok).toBe(false); expect(result).not.toHaveProperty('paths');
    expect(proof.mock.calls.length).toBeGreaterThan(0);
    const [local, world] = proof.mock.calls[0]!;
    expect(world[0]).toBe(native[0]![0]); expect(world[1]).toBe(native[0]![1]);
    expect(local.some((point, index) => !Object.is(point.x + camera.center.x, world[index]!.x) || !Object.is(point.y + camera.center.y, world[index]!.y))).toBe(true);
    if (result.ok) throw new Error('Expected original remote source refusal');
    expect(isSourcePrecisionCertificateError(result.cause) || isSourceTopologyAdmissionError(result.cause)).toBe(true);
  });

  it.each([0.17, Math.PI / 4, 0.43])('keeps the original native context twist %s on Canvas', (twist) => {
    const source = sealImmutableData(hatch());
    const original = JSON.stringify(source);
    const camera = { ...view, twist };
    expect(canvasHatch(source, camera).strokes.length).toBeGreaterThan(0);
    const result = lowerHatchStrokes(source, camera, { widthCss: 1 });
    expect(result).toMatchObject({ ok: false, reason: 'Unsupported Canvas stroke construction: native context rotation is unproved' });
    expect(result).not.toHaveProperty('paths');
    if (result.ok) throw new Error('Expected twist refusal');
    expect(isSourceTopologyAdmissionError(result.cause)).toBe(true);
    expect(isSourcePrecisionCertificateError(result.cause)).toBe(false);
    expect(JSON.stringify(source)).toBe(original);
  });

  it.each([Number.MIN_VALUE, 2 ** 128])('refuses an unrepresentable native DPR %s without exposing partial paths', (dpr) => {
    const result = lowerHatchStrokes(hatch(), { ...view, dpr }, { widthCss: 1 });
    expect(result.ok).toBe(false); expect(result).not.toHaveProperty('paths');
    if (result.ok) throw new Error('Expected DPR refusal');
    // Dot/projection preflight may refuse before the current native coefficient guard.
    expect(isSourceTopologyAdmissionError(result.cause) || isSourcePrecisionCertificateError(result.cause)).toBe(true);
  });

  it.each([0, -1, NaN, Infinity])('rejects invalid resolved lineweight %s before canonical allocation', (widthCss) => {
    const generator = vi.spyOn(entities, 'hatchGeometry');
    const result = lowerHatchStrokes(hatch(), view, { widthCss });
    expect(result).toMatchObject({ ok: false, reason: 'Invalid hatch lineweight' });
    expect(result).not.toHaveProperty('paths'); expect(generator).not.toHaveBeenCalled();
  });

  it('brands deliberate scalar projection refusal without exposing its certificate in JSON', () => {
    const result = lowerHatchStrokes(hatch(), { ...view, scale: 1e15 }, { widthCss: 1 });
    expect(result).toMatchObject({ ok: false, reason: 'Canvas hatch projection exceeds precision bound' });
    if (result.ok) throw new Error('Expected projection refusal');
    expect(isSourcePrecisionCertificateError(result.cause)).toBe(true);
    expect(isSourceTopologyAdmissionError(result.cause)).toBe(false);
    expect(Object.keys(result)).toEqual(['ok', 'reason']);
  });

  it.each([new Error('Unsupported Canvas stroke construction: native context rotation is unproved'), new TypeError('Unsupported Canvas stroke construction: native context rotation is unproved'), new RangeError('Canvas hatch projection exceeds precision bound'), { interrupted: true }])('preserves an unknown native proof failure without manufacturing a certificate: %s', (cause) => {
    const proof = vi.spyOn(strokeParity, 'assertStrokePathPrecision').mockImplementationOnce(() => { throw cause; });
    const result = lowerHatchStrokes(sealImmutableData(hatch()), view, { widthCss: 1 });
    expect(proof).toHaveBeenCalledOnce(); expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected native proof failure');
    expect(result.cause).toBe(cause);
    expect(isSourcePrecisionCertificateError(result.cause)).toBe(false);
    expect(isSourceTopologyAdmissionError(result.cause)).toBe(false);
    expect(Object.getOwnPropertyDescriptor(result, 'cause')?.enumerable).toBe(false);
    expect(result).not.toHaveProperty('paths');
  });

  it('refuses a pre-seal stale Canvas cache and retains the mismatch certificate on retry', () => {
    const source = hatch(); const original = hatchGeometry(source);
    // A quarter-unit shift is exactly two LINE periods and leaves geometry unchanged.
    Object.assign(source, { origin: { x: 0.25, y: 0.03125 } });
    sealImmutableData(source);
    expect(hatchGeometry(source)).toBe(original);
    expect(hatchGeometry({ ...source }).segments).not.toEqual(original.segments);
    const generator = vi.spyOn(entities, 'hatchGeometry');
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = lowerHatchStrokes(source, view, { widthCss: 1 });
      expect(result).toMatchObject({ ok: false, reason: 'Cached Canvas hatch geometry differs from immutable source; Canvas rendering required' });
      expect(result).not.toHaveProperty('paths');
      if (result.ok) throw new Error('Expected stale cache refusal');
      expect(isSourceTopologyAdmissionError(result.cause)).toBe(true);
    }
    expect(generator).toHaveBeenCalledTimes(2);
    expect(hatchGeometry(source)).toBe(original);
  });

  it('budgets the actual retained local and WORLD points before canonical generation', () => {
    const source = hatch({ loops: [{ points: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 0, y: 8 }] }], patternLines: [
      { angle: 0, base: { x: 0, y: 0.5 }, offset: { x: 0, y: 4 }, dashes: [] },
    ] });
    const result = accepted(lowerHatchStrokes(source, view, { widthCss: 1, maxPoints: 11 }));
    const canonical = hatchGeometry(source);
    expect(result.paths).toHaveLength(2);
    const retained = [...result.sourcePoints, ...result.paths.flatMap((segment) => [...segment.points, ...segment.worldPoints])];
    expect(retained).toHaveLength(11);
    expect(new Set(retained).size).toBe(retained.length);
    result.paths.forEach((segment, index) => {
      expect(segment.worldPoints).toEqual(canonical.segments[index]);
      segment.worldPoints.forEach((point, endpoint) => expect(point).not.toBe(canonical.segments[index]![endpoint]));
    });
    const generator = vi.spyOn(entities, 'hatchGeometry');
    const refused = lowerHatchStrokes(structuredClone(source), view, { widthCss: 1, maxPoints: retained.length - 1 });
    expect(refused).toMatchObject({ ok: false, reason: expect.stringContaining('segment budget') });
    expect(refused).not.toHaveProperty('paths');
    expect(generator).not.toHaveBeenCalled();
  });

  it('bounds combined boundary and retained endpoint points before canonical allocation', () => {
    const generator = vi.spyOn(entities, 'hatchGeometry');
    const result = lowerHatchStrokes(hatch(), view, { widthCss: 1, maxPoints: 4 });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('segment budget') });
    expect(result).not.toHaveProperty('paths'); expect(generator).not.toHaveBeenCalled();
  });
});


describe('shared hatch source reserve accounting', () => {
  it('adds projection and native construction inside the existing physical reserve', () => {
    // Controlled accepted native certificate checks composition; actual native arithmetic
    // is exercised in the real proof/endpoint tests above and its existing bound suite.
    const proof = vi.spyOn(nativeBounds, 'nativeFloatStrokeBound').mockReturnValue({ errorCss: 0.04, problem: null, failure: null });
    expect(lowerHatchStrokes(hatch(), view, { widthCss: 1 }).ok).toBe(true);
    const result = lowerHatchStrokes(hatch(), { ...view, scale: 10_000, center: { x: 20_000_000, y: -20_000_000 } }, { widthCss: 1 });
    expect(proof.mock.calls.length).toBeGreaterThan(0);
    expect(result).toMatchObject({ ok: false, reason: 'Canvas hatch projection and native float construction exceed shared precision bound' });
    expect(result).not.toHaveProperty('paths');
    if (result.ok) throw new Error('Expected combined reserve refusal');
    expect(isSourcePrecisionCertificateError(result.cause)).toBe(true);
  });
});
