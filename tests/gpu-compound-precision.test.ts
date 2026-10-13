import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DrawingState } from '../src/core/document';
import type { AttributeDef, BlockDef, Entity, InsertEntity, Layer, LineEntity, TextEntity } from '../src/core/entities';
import type { Point } from '../src/core/geometry';
import { sealImmutableData } from '../src/core/immutable-data';
import { drawEntity, lineweightDisplay } from '../src/render/draw';
import * as hershey from '../src/render/hershey';
import { GPU_ZOOM_VERTEX_STRIDE, prepareCompiledZoom2D, prepareZoom2D, type Gpu2DView } from '../src/render/gpu-prototype/geometry2d';
import { Gpu2DRenderer } from '../src/render/gpu-prototype/renderer2d';
import { canvasWorldCoordinatePrecisionProblem, lowerStrokeScene, type LoweredStrokeScene } from '../src/render/gpu-prototype/stroke-scene';

const layer: Layer = { name: '0', color: 3, visible: true, locked: false, lineWeight: 0.5 };
const origin = { x: 1e12, y: -1e12 };
const overlay = { selection: new Set<string>() };
const view: Gpu2DView = { width: 320, height: 240, dpr: 1, scale: 4096, center: { x: 0, y: 0 }, twist: 0, background: '#212830', lineweights: false };
const drawing = (entities: readonly Entity[], blocks: Readonly<Record<string, BlockDef>> = {}): DrawingState => ({ entities, blocks, layers: [layer], currentLayer: '0' });
const text = (patch: Partial<TextEntity> = {}): TextEntity => ({ id: 'text', type: 'text', layer: '0', color: 'ByLayer', position: { x: 0, y: 0 }, text: 'Ag%%c', height: 1 / 512, rotation: 0.31, align: 'left', ...patch });
const line = (patch: Partial<LineEntity> = {}): LineEntity => ({ id: 'line', type: 'line', layer: '0', color: 'ByLayer', a: { x: -1 / 64, y: 0 }, b: { x: 1 / 64, y: 0 }, ...patch });
const insert = (name: string, patch: Partial<InsertEntity> = {}): InsertEntity => ({ id: 'owner', type: 'insert', layer: '0', color: 'ByLayer', block: name, position: { x: 0, y: 0 }, scale: 1, rotation: 0.31, attributes: {}, ...patch });
const block = (name: string, entities: readonly Entity[], attributes: readonly AttributeDef[] = []): BlockDef => ({ name, entities, attributes, basePoint: { x: 0, y: 0 } });
const accepted = (result: LoweredStrokeScene) => { if (!result.ok) throw new Error(result.reason); return result; };

/** Exercise the real Canvas wrapper and model its context rotation/save/restore. */
function canvasPaths(state: DrawingState, camera: Gpu2DView): { paths: Point[][]; arcs: Array<{ center: Point; radius: number }> } {
  const paths: Point[][] = [], arcs: Array<{ center: Point; radius: number }> = [];
  let current: Point[][] = [], angle = 0;
  const stack: number[] = [];
  const transformed = (x: number, y: number): Point => ({ x: Math.cos(angle) * x - Math.sin(angle) * y, y: Math.sin(angle) * x + Math.cos(angle) * y });
  const context = {
    globalAlpha: 1, lineWidth: 1, strokeStyle: '', fillStyle: '', lineCap: 'butt', lineJoin: 'miter',
    save() { stack.push(angle); }, restore() { angle = stack.pop()!; }, rotate(value: number) { angle += value; }, setLineDash() {},
    beginPath() { current = []; }, moveTo(x: number, y: number) { current.push([transformed(x, y)]); },
    lineTo(x: number, y: number) { current[current.length - 1]!.push(transformed(x, y)); }, closePath() {},
    arc(x: number, y: number, radius: number) { arcs.push({ center: transformed(x, y), radius }); },
    stroke() { paths.push(...current); },
  };
  const previousWeights = { ...lineweightDisplay };
  lineweightDisplay.enabled = camera.lineweights ?? false;
  lineweightDisplay.pxPerMm = undefined;
  const c = Math.cos(camera.twist), s = Math.sin(camera.twist);
  const transform = { scale: camera.scale, rotation: camera.twist, toScreen: (point: Point): Point => {
    const x = point.x - camera.center.x, y = point.y - camera.center.y;
    return { x: camera.width / 2 + (x * c - y * s) * camera.scale, y: camera.height / 2 - (x * s + y * c) * camera.scale };
  } };
  const hidden = new Set(state.layers.filter((entry) => !entry.visible).map((entry) => entry.name));
  try {
    for (const entity of state.entities) if (!hidden.has(entity.layer)) drawEntity(context as unknown as CanvasRenderingContext2D, entity, transform, state.layers, (name) => state.blocks[name], { hidden });
  } finally { Object.assign(lineweightDisplay, previousWeights); }
  return { paths, arcs };
}

function loweredPaths(result: LoweredStrokeScene, camera: Gpu2DView): Point[][] {
  const c = Math.cos(camera.twist), s = Math.sin(camera.twist);
  return accepted(result).operations.flatMap((operation) => operation.paths.map((path) => {
    const points = path.kind === 'path' ? path.points : path.entity.type === 'line' ? [path.entity.a, path.entity.b] : [];
    return points.map((point) => ({ x: camera.width / 2 + (point.x * c - point.y * s) * camera.scale, y: camera.height / 2 - (point.x * s + point.y * c) * camera.scale }));
  }));
}

function maximumPathError(a: readonly (readonly Point[])[], b: readonly (readonly Point[])[]): number {
  expect(a.map((path) => path.length)).toEqual(b.map((path) => path.length));
  return Math.max(0, ...a.flatMap((path, pathIndex) => path.map((point, index) => {
    const reference = b[pathIndex]![index]!;
    return Math.max(Math.abs(point.x - reference.x), Math.abs(point.y - reference.y));
  })));
}

function refusalFixture() {
  const gl = {
    MAX_VIEWPORT_DIMS: 0xd3a, isContextLost: vi.fn(() => false),
    getParameter: vi.fn(() => new Int32Array([16384, 16384])),
    createShader: vi.fn(), createBuffer: vi.fn(), bufferData: vi.fn(), bufferSubData: vi.fn(), drawArrays: vi.fn(), clear: vi.fn(),
  };
  const canvas = Object.assign(new EventTarget(), { width: 1, height: 1, getContext: vi.fn(() => gl) }) as unknown as HTMLCanvasElement;
  return { gl, renderer: new Gpu2DRenderer(canvas) };
}

afterEach(() => vi.restoreAllMocks());

describe('Canvas world-coordinate parity for compiled GPU scenes', () => {
  it.each([1, 2])('measures readable world-glyph quantization and refuses it without weakening near-origin accuracy at DPR %s', (dpr) => {
    const near = text({ position: { x: 1 / 64, y: -1 / 64 }, widthFactor: 1.3, oblique: 0.2 });
    const far = { ...near, position: { x: origin.x + near.position.x, y: origin.y + near.position.y } };
    const camera = { ...view, dpr, twist: 0.63 }, farCamera = { ...camera, center: origin };
    const reference = canvasPaths(drawing([near]), camera).paths;
    expect(maximumPathError(loweredPaths(lowerStrokeScene(drawing([near]), camera, overlay), camera), reference)).toBeLessThan(1e-10);
    expect(maximumPathError(canvasPaths(drawing([far]), farCamera).paths, reference) * dpr).toBeGreaterThan(0.0625);
    expect(lowerStrokeScene(drawing([far]), farCamera, overlay)).toEqual({ ok: false, reason: expect.stringContaining('world-coordinate quantization') });
  });

  it('admits a lower-scale trillion-coordinate TEXT only when actual Canvas path error fits the reserve', () => {
    const near = text({ position: { x: 1 / 8, y: -1 / 8 }, height: 1, align: 'right', widthFactor: 1.3, oblique: 0.2 });
    const far = { ...near, position: { x: origin.x + near.position.x, y: origin.y + near.position.y } };
    const camera = { ...view, scale: 16, center: origin, twist: 0.63 };
    const result = lowerStrokeScene(drawing([far]), camera, overlay);
    expect(maximumPathError(loweredPaths(result, camera), canvasPaths(drawing([far]), camera).paths)).toBeLessThan(0.0625);
    expect(lowerStrokeScene(drawing([far]), { ...camera, dpr: 2 }, overlay).ok).toBe(false);
    expect(lowerStrokeScene(drawing([far]), { ...camera, scale: 32 }, overlay).ok).toBe(false);
    expect(lowerStrokeScene(drawing([far]), { ...camera, scale: 32 }, overlay, { maxRatio: 1 }).ok).toBe(true);
  });

  it.each([3, 5] as const)('refuses unsafe native mode %s while preserving the independent near-origin Canvas placement', (horizontal) => {
    const near = text({ position: { x: 1 / 8192, y: -2 / 8192 }, alignmentPoint: { x: 9 / 8192, y: 5 / 8192 }, height: 1 / 8192, justification: { horizontal, vertical: 0 }, widthFactor: 1.2, oblique: 0.22 });
    const far = { ...near, position: { x: origin.x + near.position.x, y: origin.y + near.position.y }, alignmentPoint: { x: origin.x + near.alignmentPoint!.x, y: origin.y + near.alignmentPoint!.y } };
    const camera = { ...view, scale: 65536 };
    expect(maximumPathError(loweredPaths(lowerStrokeScene(drawing([near]), camera, overlay), camera), canvasPaths(drawing([near]), camera).paths)).toBeLessThan(1e-10);
    expect(lowerStrokeScene(drawing([far]), { ...camera, center: origin }, overlay).ok).toBe(false);
  });

  it('keeps giant-origin QTEXT bars eligible when Canvas constructs their offsets in screen space', () => {
    const far = text({ position: origin, height: 1 / 4096, text: '%%uAB%%k', align: 'center', rotation: 0.31, widthFactor: 1.3 });
    const camera = { ...view, center: origin, twist: 0.7, dpr: 2 };
    const result = lowerStrokeScene(drawing([far]), camera, overlay);
    expect(maximumPathError(loweredPaths(result, camera), canvasPaths(drawing([far]), camera).paths)).toBeLessThan(1e-10);
    expect(accepted(result).operations[0]!.paths).toHaveLength(1);
  });

  it('refuses QTEXT when native vertical placement itself rounds at the world origin', () => {
    const far = text({ position: origin, alignmentPoint: origin, height: 0.0003, justification: { horizontal: 0, vertical: 3 } });
    expect(lowerStrokeScene(drawing([far]), { ...view, center: origin }, overlay)).toEqual({ ok: false, reason: expect.stringContaining('world-coordinate quantization') });
  });

  it('measures pure LINE-block world transform quantization and preserves direct large-coordinate LINE preparation', () => {
    const definition = block('LINES', [line({ a: { x: -0.012345, y: 0.00321 }, b: { x: 0.02345, y: -0.00987 } })]);
    const near = insert('LINES'), far = { ...near, position: origin };
    const reference = canvasPaths(drawing([near], { LINES: definition }), view).paths;
    const farView = { ...view, center: origin };
    expect(maximumPathError(canvasPaths(drawing([far], { LINES: definition }), farView).paths, reference)).toBeGreaterThan(0.0625);
    expect(lowerStrokeScene(drawing([far], { LINES: definition }), farView, overlay)).toEqual({ ok: false, reason: expect.stringContaining('world-coordinate quantization') });
    const direct = line({ a: { x: origin.x - 1 / 64, y: origin.y }, b: { x: origin.x + 1 / 64, y: origin.y } });
    const baseline = prepareZoom2D(drawing([line()]), view, overlay);
    expect(prepareZoom2D(drawing([direct]), farView, overlay).vertices).toEqual(baseline.vertices);
  });

  it.each(['line', 'polyline', 'circle', 'arc'] as const)('checks unsafe INSERT construction before accepting a %s leaf', (type) => {
    const entity: Entity = type === 'line' ? line() : type === 'polyline' ? { ...line(), type, points: [{ x: 0, y: 0 }, { x: 1 / 64, y: 1 / 64 }], closed: false } : { id: type, type, layer: '0', color: 3, center: { x: 0, y: 0 }, radius: 1 / 64, ...(type === 'arc' ? { startAngle: 0, endAngle: 1 } : {}) } as Entity;
    const definition = block('B', [entity]);
    expect(lowerStrokeScene(drawing([insert('B', { position: origin })], { B: definition }), { ...view, center: origin }, overlay).ok).toBe(false);
    expect(lowerStrokeScene(drawing([insert('B')], { B: definition }), view, overlay).ok).toBe(true);
  });

  it('covers nested transforms and per-instance FIT ATTRIB overrides without changing the source drawing', () => {
    const attribute: AttributeDef = { tag: 'TAG', prompt: '', default: 'A', position: { x: 0.01, y: 0.01 }, height: 1 / 512, align: 'left' };
    const leaf = block('LEAF', [text()], [attribute]);
    const nested = insert('LEAF', { id: 'nested', position: { x: 0.012345, y: -0.004321 }, rotation: 0.22, attributePlacements: { TAG: { position: { x: 0, y: 0 }, alignmentPoint: { x: 1 / 128, y: 1 / 128 }, height: 1 / 512, align: 'left', justification: { horizontal: 5, vertical: 0 } } } });
    const root = block('ROOT', [nested]);
    const far = sealImmutableData(drawing([insert('ROOT', { position: origin })], { ROOT: root, LEAF: leaf }));
    const before = JSON.stringify(far);
    expect(lowerStrokeScene(far, { ...view, center: origin }, overlay).ok).toBe(false);
    expect(JSON.stringify(far)).toBe(before);
    const near = drawing([insert('ROOT')], far.blocks);
    expect(maximumPathError(loweredPaths(lowerStrokeScene(near, view, overlay), view), canvasPaths(near, view).paths)).toBeLessThan(1e-10);
  });

  it('handles ATTRIB-only blocks and refuses before any glyph allocation or GPU submission', () => {
    const definition = block('ATTR', [], [{ tag: 'TAG', prompt: '', default: 'A', position: { x: 0.012345, y: 0.004321 }, height: 1 / 512, align: 'left' }]);
    const state = drawing([line(), insert('ATTR', { position: origin })], { ATTR: definition });
    const glyphs = vi.spyOn(hershey, 'strokeText');
    const { gl, renderer } = refusalFixture();
    expect(renderer.render(state, { ...view, center: origin }, overlay)).toMatchObject({ rendered: false, reason: expect.stringContaining('world-coordinate quantization'), uploadCalls: 0, bytes: 0 });
    expect(glyphs).not.toHaveBeenCalled();
    expect(gl.createShader).not.toHaveBeenCalled(); expect(gl.createBuffer).not.toHaveBeenCalled();
    expect(gl.bufferData).not.toHaveBeenCalled(); expect(gl.bufferSubData).not.toHaveBeenCalled();
    expect(gl.clear).not.toHaveBeenCalled(); expect(gl.drawArrays).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it('pairs repeated nested text in expansion order including hidden child slots and skipped attributes', () => {
    const attribute = (tag: string, patch: Partial<AttributeDef> = {}): AttributeDef => ({ tag, prompt: '', default: 'AB', position: { x: 0.5, y: 1 }, height: 1, align: 'left', ...patch });
    const leaf = block('LEAF', [text({ id: 'repeat', layer: 'OFF', position: { x: 7, y: 8 }, height: 1 }), text({ id: 'repeat', position: { x: 0, y: 0 }, height: 1 })], [attribute('INVISIBLE', { invisible: true }), attribute('HIDE'), attribute('SHOW')]);
    const root = block('ROOT', [insert('LEAF', { id: 'A', position: { x: -3, y: -1 }, hiddenAttributes: ['HIDE'], rotation: 0.2 }), insert('LEAF', { id: 'B', position: { x: 3, y: 1 }, hiddenAttributes: ['HIDE'], rotation: 0.4 })]);
    const state = { ...drawing([insert('ROOT', { position: { x: 30, y: -20 } })], { ROOT: root, LEAF: leaf }), layers: [layer, { ...layer, name: 'OFF', visible: false }] };
    const camera = { ...view, center: { x: 30, y: -20 }, scale: 10, twist: 0.3 };
    const result = lowerStrokeScene(state, camera, overlay);
    expect(accepted(result).operations.map((operation) => operation.sourceId)).toEqual(['repeat', 'A:SHOW', 'repeat', 'B:SHOW']);
    expect(maximumPathError(loweredPaths(result, camera), canvasPaths(state, camera).paths)).toBeLessThan(1e-10);
  });

  it('returns no partial operations when an unsafe readable TEXT follows a valid LINE', () => {
    const glyphs = vi.spyOn(hershey, 'strokeText');
    const state = drawing([line({ a: origin, b: { x: origin.x + 1 / 64, y: origin.y } }), text({ position: origin })]);
    expect(lowerStrokeScene(state, { ...view, center: origin }, overlay)).toEqual({ ok: false, reason: expect.stringContaining('world-coordinate quantization') });
    expect(glyphs).not.toHaveBeenCalled();
  });

  it.each([1, 2])('keeps compiled curve, Canvas construction and Float32 error inside the existing joint quarter-pixel budget at DPR %s', (dpr) => {
    const anchor = { x: 1e9, y: -1e9 };
    const circle: Entity = { id: 'circle', type: 'circle', layer: '0', color: 3, center: { x: 0.12345, y: -0.23456 }, radius: 5 };
    const definition = block('C', [circle]);
    const state = drawing([insert('C', { position: anchor })], { C: definition });
    const camera = { ...view, scale: 10, center: anchor, dpr, twist: 0.4 };
    const lowered = accepted(lowerStrokeScene(state, camera, overlay));
    const path = lowered.operations[0]!.paths[0]!;
    if (path.kind !== 'entity' || path.entity.type !== 'circle') throw new Error('Expected compiled circle');
    const c = Math.cos(camera.twist), s = Math.sin(camera.twist), local = path.entity.center;
    const center = { x: (local.x * c - local.y * s) * camera.scale, y: -(local.x * s + local.y * c) * camera.scale };
    const canvasArc = canvasPaths(state, camera).arcs[0]!;
    const constructionError = Math.hypot(canvasArc.center.x - camera.width / 2 - center.x, canvasArc.center.y - camera.height / 2 - center.y) * 1.25 * dpr;
    expect(constructionError).toBeLessThanOrEqual(0.0625);
    const geometry = prepareCompiledZoom2D(state, camera, overlay);
    const unique = new Map<string, Point>();
    for (let i = 0; i < geometry.vertices.length; i += GPU_ZOOM_VERTEX_STRIDE) {
      const point = { x: geometry.vertices[i]!, y: geometry.vertices[i + 1]! };
      unique.set(`${point.x},${point.y}`, point);
    }
    const angles = [...unique.values()].map((point) => Math.atan2(point.y - center.y, point.x - center.x)).sort((a, b) => a - b);
    const largestStep = Math.max(...angles.map((angle, index) => (index + 1 < angles.length ? angles[index + 1]! : angles[0]! + Math.PI * 2) - angle));
    const radius = canvasArc.radius * 1.25, halfWidth = lowered.operations[0]!.widthCss / 2;
    // Independent circle sagitta plus worst outer miter excess, at maximum retained zoom.
    const curveError = (radius + Math.SQRT2 * halfWidth) * (1 - Math.cos(largestStep / 2)) * dpr;
    expect(curveError).toBeLessThanOrEqual(0.125 + 1e-5);
    expect(curveError + constructionError + 0.0625).toBeLessThanOrEqual(0.25);
    expect(canvasWorldCoordinatePrecisionProblem(1e12, { scale: 4096, dpr }, 1.25, 16)).toMatch(/precision budget/);
  });
});
