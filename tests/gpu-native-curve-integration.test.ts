import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DrawingState } from '../src/core/document';
import type { ArcEntity, BlockDef, CircleEntity, Entity, InsertEntity, Layer, LineEntity } from '../src/core/entities';
import { sealImmutableData } from '../src/core/immutable-data';
import { drawEntity } from '../src/render/draw';
import * as curveBound from '../src/render/gpu-prototype/native-float-curve-bound';
import { prepare2D, prepareCompiledZoom2D, prepareZoom2D, type Gpu2DView } from '../src/render/gpu-prototype/geometry2d';
import { Gpu2DRenderer } from '../src/render/gpu-prototype/renderer2d';
import { isSourcePrecisionCertificateError, isSourceTopologyAdmissionError } from '../src/render/gpu-prototype/stroke-precision-error';

const layer: Layer = { name: '0', color: 3, visible: true, locked: false, lineWeight: 0.25 };
const line: LineEntity = { id: 'line', type: 'line', layer: '0', color: 'ByLayer', a: { x: -2, y: 0 }, b: { x: 2, y: 0 } };
const view: Gpu2DView = { width: 1216, height: 552, dpr: 1, scale: 1, center: { x: 0, y: 0 }, twist: 0, background: '#212830', lineweights: true };
const overlay = { selection: new Set<string>() };
const drawing = (entities: readonly Entity[], blocks: Readonly<Record<string, BlockDef>> = {}): DrawingState => sealImmutableData({ entities, layers: [layer], blocks, currentLayer: '0' });
const arc = (patch: Partial<ArcEntity> = {}): ArcEntity => ({ id: 'arc', type: 'arc', layer: '0', color: 'ByLayer', center: { x: 0, y: 0 }, radius: 2, startAngle: 0, endAngle: 1, ...patch });
const circle = (patch: Partial<CircleEntity> = {}): CircleEntity => ({ id: 'circle', type: 'circle', layer: '0', color: 'ByLayer', center: { x: 0, y: 0 }, radius: 2, ...patch });
const block = (entities: readonly Entity[], name: string): BlockDef => ({ name, basePoint: { x: 0, y: 0 }, entities, attributes: [] });
const insert = (name: string, position = { x: 0, y: 0 }): InsertEntity => ({ id: `owner-${name}`, type: 'insert', layer: '0', color: 'ByLayer', block: name, position, scale: 1, rotation: 0, attributes: {} });

function rendererFixture() {
  const handle = () => ({});
  const gl = {
    VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30, COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82, ARRAY_BUFFER: 0x8892, ARRAY_BUFFER_BINDING: 0x8894, STATIC_DRAW: 0x88e4, DYNAMIC_DRAW: 0x88e8, MAX_VIEWPORT_DIMS: 0xd3a, NO_ERROR: 0,
    FRAMEBUFFER: 0x8d40, FLOAT: 0x1406, TRIANGLES: 4, DEPTH_TEST: 0xb71, CULL_FACE: 0xb44, SCISSOR_TEST: 0xc11, RASTERIZER_DISCARD: 0x8c89, STENCIL_TEST: 0xb90, BLEND: 0xbe2,
    COLOR_BUFFER_BIT: 0x4000, STENCIL_BUFFER_BIT: 0x400, FUNC_ADD: 0x8006, SRC_ALPHA: 0x302, ONE_MINUS_SRC_ALPHA: 0x303, ONE: 1, EQUAL: 0x202, KEEP: 0x1e00, INCR: 0x1e02,
    isContextLost: vi.fn(() => false), createShader: vi.fn(handle), shaderSource: vi.fn(), compileShader: vi.fn(), getShaderParameter: vi.fn(() => true), getShaderInfoLog: vi.fn(() => ''),
    createProgram: vi.fn(handle), attachShader: vi.fn(), detachShader: vi.fn(), linkProgram: vi.fn(), getProgramParameter: vi.fn(() => true), getProgramInfoLog: vi.fn(() => ''), deleteShader: vi.fn(), deleteProgram: vi.fn(),
    createBuffer: vi.fn(handle), bindBuffer: vi.fn(), deleteBuffer: vi.fn(), bufferData: vi.fn(), bufferSubData: vi.fn(), getParameter: vi.fn(() => new Int32Array([16384, 16384])), getError: vi.fn(() => 0), getContextAttributes: vi.fn(() => ({ stencil: true })),
    getUniformLocation: vi.fn((_program: unknown, name: string) => ({ name })), bindFramebuffer: vi.fn(), bindVertexArray: vi.fn(), useProgram: vi.fn(), enableVertexAttribArray: vi.fn(), vertexAttribPointer: vi.fn(), uniform2f: vi.fn(), uniform1f: vi.fn(),
    viewport: vi.fn(), enable: vi.fn(), disable: vi.fn(), colorMask: vi.fn(), depthMask: vi.fn(), stencilMask: vi.fn(), clearColor: vi.fn(), clearStencil: vi.fn(), clear: vi.fn(), blendEquation: vi.fn(), blendFuncSeparate: vi.fn(), stencilFunc: vi.fn(), stencilOp: vi.fn(), drawArrays: vi.fn(),
    get drawingBufferWidth(): number { return canvas.width; }, get drawingBufferHeight(): number { return canvas.height; },
  };
  const canvas = Object.assign(new EventTarget(), { width: 1, height: 1, getContext: vi.fn(() => gl as unknown as WebGL2RenderingContext) }) as unknown as HTMLCanvasElement;
  return { gl, renderer: new Gpu2DRenderer(canvas) };
}

function nativeArguments(entity: ArcEntity): number[] {
  const context = { globalAlpha: 1, save: vi.fn(), restore: vi.fn(), setLineDash: vi.fn(), beginPath: vi.fn(), stroke: vi.fn(), arc: vi.fn() };
  drawEntity(context as unknown as CanvasRenderingContext2D, entity, { scale: view.scale, toScreen: (point) => ({ x: view.width / 2 + point.x, y: view.height / 2 - point.y }) }, [layer], () => undefined);
  const command = context.arc.mock.calls[0]! as number[];
  // The actual painter command is followed by the pinned Canvas parameter casts.
  return [...command.slice(0, 3).map(Math.fround), ...command.slice(3)];
}

afterEach(() => vi.restoreAllMocks());

describe('existing ARC/CIRCLE native parameter admission', () => {
  it.each(['direct', 'compiled', 'legacy'] as const)('deducts the actual parameter error from the existing %s tessellation allowance', (kind) => {
    const physicalParameterError = 0.06, camera = { ...view, scale: 30 };
    vi.spyOn(curveBound, 'nativeFloatCurveBound').mockReturnValue({ scope: 'center-radius-oval', errorCss: physicalParameterError / camera.dpr, problem: null, failure: null });
    const state = kind === 'compiled' ? drawing([insert('B')], { B: block([circle()], 'B') }) : drawing([circle()]);
    const prepared = kind === 'legacy' ? prepare2D(state, camera, overlay) : kind === 'compiled' ? prepareCompiledZoom2D(state, camera, overlay) : prepareZoom2D(state, camera, overlay);
    const stride = kind === 'legacy' ? 5 : 7, pivot = kind === 'legacy' ? { x: camera.width / 2, y: camera.height / 2 } : { x: 0, y: 0 };
    const radius = 60, angles = new Set<number>();
    for (let i = 0; i < prepared.vertices.length; i += stride) {
      const x = prepared.vertices[i]! - pivot.x, y = prepared.vertices[i + 1]! - pivot.y;
      // Legacy joins include their true centerline point alongside extrusions;
      // retain only the centerline for an independent circular sagitta proof.
      if (Math.abs(Math.hypot(x, y) - radius) < 1e-4) angles.add((Math.atan2(y, x) + Math.PI * 2) % (Math.PI * 2));
    }
    const sorted = [...angles].sort((a, b) => a - b);
    expect(sorted.length).toBeGreaterThan(8);
    let maximumGap = 0;
    for (let i = 0; i < sorted.length; i++) maximumGap = Math.max(maximumGap, (i + 1 === sorted.length ? sorted[0]! + Math.PI * 2 : sorted[i + 1]!) - sorted[i]!);
    const maximumRatio = kind === 'legacy' ? 1 : 1.25;
    const centerSagitta = radius * maximumRatio * (1 - Math.cos(maximumGap / 2));
    const outerMiterExcess = 0.5 * (1 / Math.cos(maximumGap / 2) - 1);
    const inheritedBudget = kind === 'legacy' ? 0.25 : kind === 'compiled' ? 0.125 : 0.1875;
    expect(centerSagitta + outerMiterExcess + physicalParameterError).toBeLessThanOrEqual(inheritedBudget);
  });

  it('keeps both original Float32-alias ARC inputs on complete Canvas before any upload', () => {
    const originals = [arc({ center: { x: -4e7, y: 0 }, radius: 4e7, startAngle: 0, endAngle: 2e-6 }), arc({ center: { x: -40000000.75, y: 0 }, radius: 4e7, startAngle: 0, endAngle: 2e-6 })];
    expect(nativeArguments(originals[0]!)).toEqual(nativeArguments(originals[1]!));
    expect(originals[0]!.center.x + originals[0]!.radius - originals[1]!.center.x - originals[1]!.radius).toBe(0.75);
    for (const source of originals) {
      const state = drawing([line, source]), { gl, renderer } = rendererFixture(), snapshot = JSON.stringify(state);
      for (const prepare of [prepare2D, prepareZoom2D, prepareCompiledZoom2D]) {
        let failure: unknown;
        try { prepare(state, view, overlay); } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(Error); expect((failure as Error).message).toBe('Unsupported Canvas stroke construction: native float curve parameters exceed precision budget');
        expect(isSourcePrecisionCertificateError(failure)).toBe(true);
      }
      expect(renderer.render(state, view, overlay)).toMatchObject({ rendered: false, reason: 'Unsupported Canvas stroke construction: native float curve parameters exceed precision budget', uploadKind: 'none', bytes: 0, uploadCalls: 0, submissionMs: 0 });
      expect(renderer.render(state, view, overlay)).toMatchObject({ rendered: false, cacheReason: 'refusal-hit', geometryPreparationMs: 0, uploadKind: 'none', bytes: 0, uploadCalls: 0 });
      for (const call of [gl.createShader, gl.createBuffer, gl.bufferData, gl.bufferSubData, gl.clear, gl.drawArrays]) expect(call).not.toHaveBeenCalled();
      expect(JSON.stringify(state)).toBe(snapshot); renderer.dispose();
    }
  });

  it.each(['circle', 'arc'] as const)('retains a healthy GPU image across a refused %s parameter alias and undo', (kind) => {
    const baseline = drawing([line]), source = kind === 'circle' ? circle({ center: { x: -40000000.75, y: 0 }, radius: 4e7 }) : arc({ center: { x: -40000000.75, y: 0 }, radius: 4e7, endAngle: 2e-6 });
    const state = drawing([line, source]), { renderer, gl } = rendererFixture();
    expect(renderer.render(baseline, view, overlay).rendered).toBe(true);
    const original = (gl.bufferData.mock.calls[0]![1] as Float32Array).slice();
    gl.clear.mockClear(); gl.drawArrays.mockClear();
    expect(renderer.render(state, view, overlay)).toMatchObject({ rendered: false, reason: 'Unsupported Canvas stroke construction: native float curve parameters exceed precision budget', uploadKind: 'none', bytes: 0 });
    expect(gl.bufferData).toHaveBeenCalledOnce(); expect(gl.bufferSubData).not.toHaveBeenCalled(); expect(gl.clear).not.toHaveBeenCalled(); expect(gl.drawArrays).not.toHaveBeenCalled();
    expect(gl.bufferData.mock.calls[0]![1]).toEqual(original);
    expect(renderer.render(baseline, view, overlay)).toMatchObject({ rendered: true, cacheHit: true, geometryPreparationMs: 0, uploadKind: 'none' });
    renderer.dispose();
  });

  it.each([1, 1.2, 1.25, 2, 3])('preserves ordinary direct curves, fixed wide weights and warm zoom at DPR %s', (dpr) => {
    for (const weight of [0.25, 1, 5]) {
      const state = drawing([circle({ lineWeight: weight }), arc({ id: 'wrapped', center: { x: 3, y: 0 }, radius: 2, startAngle: 1.5 * Math.PI, endAngle: 0.5 * Math.PI, lineWeight: weight })]);
      const camera = { ...view, scale: 30, dpr }, { renderer, gl } = rendererFixture();
      expect(renderer.render(state, camera, overlay)).toMatchObject({ rendered: true, uploadKind: 'full' });
      for (const ratio of [0.8, 1.25]) expect(renderer.render(state, { ...camera, scale: camera.scale * ratio }, overlay)).toMatchObject({ rendered: true, cacheHit: true, geometryPreparationMs: 0, uploadKind: 'none', bytes: 0 });
      expect(gl.bufferData).toHaveBeenCalledOnce(); renderer.dispose();
    }
  });

  it.each([1, 1.25, 3])('preserves representable near/trillion-origin curve bytes with a separate zero-twist control at DPR %s', (dpr) => {
    const origin = { x: 1e12, y: -1e12 }, camera = { ...view, scale: 1024, dpr };
    const near = drawing([circle({ radius: 1 / 32 }), arc({ radius: 1 / 32, startAngle: Math.PI, endAngle: Math.PI * 2 })]);
    const far = drawing([circle({ center: origin, radius: 1 / 32 }), arc({ center: origin, radius: 1 / 32, startAngle: Math.PI, endAngle: Math.PI * 2 })]);
    const original = JSON.stringify(far), translated = { ...camera, center: origin };
    expect(prepareZoom2D(far, translated, overlay).vertices).toEqual(prepareZoom2D(near, camera, overlay).vertices);
    expect(prepare2D(far, translated, overlay).vertices).toEqual(prepare2D(near, camera, overlay).vertices);
    expect(JSON.stringify(far)).toBe(original);
  });

  it.each([1, 1.25, 3])('bounds nested compiled native arguments with the existing construction uncertainty at DPR %s', (dpr) => {
    const proof = vi.spyOn(curveBound, 'nativeFloatCurveBound'), camera = { ...view, scale: 30, dpr };
    const state = drawing([insert('B', { x: 1, y: -2 })], { B: block([insert('N', { x: 3, y: 1 })], 'B'), N: block([circle(), arc({ id: 'child-arc' })], 'N') });
    const prepared = prepareCompiledZoom2D(state, camera, overlay);
    expect(prepared.vertices.length).toBeGreaterThan(0); expect(proof).toHaveBeenCalledTimes(2);
    for (const call of proof.mock.calls) {
      expect(call[0]).toEqual({ x: 728, y: 306 }); expect(call[1]).toBe(60); expect(call[2]).toBe(1); expect(call[4]).toBe(1.25);
      expect(call[5]).toEqual({ minRatio: 0.8, panPhysical: 128, nativeParameterUncertaintyCss: 0.0625 / dpr });
    }
    const unsafe = drawing([insert('B')], { B: block([arc({ center: { x: -40000000.75, y: 0 }, radius: 4e7, endAngle: 2e-6 })], 'B') });
    const { renderer, gl } = rendererFixture();
    expect(renderer.render(unsafe, { ...view, dpr }, overlay)).toMatchObject({ rendered: false, reason: 'Unsupported Canvas stroke construction: native float curve parameters exceed precision budget', uploadKind: 'none', bytes: 0, uploadCalls: 0 });
    expect(gl.createShader).not.toHaveBeenCalled(); expect(gl.bufferData).not.toHaveBeenCalled(); expect(gl.clear).not.toHaveBeenCalled(); expect(gl.drawArrays).not.toHaveBeenCalled(); renderer.dispose();
  });

  it('keeps the existing ARC full-circle shortcut and angle refusal gate unchanged', () => {
    const state = drawing([arc({ startAngle: 1e20, endAngle: 1e20 })]);
    expect(prepareZoom2D(state, { ...view, scale: 30 }, overlay).vertices.length).toBeGreaterThan(0);
    expect(() => prepareZoom2D(drawing([arc({ startAngle: 0, endAngle: Math.PI * 2 + 1 })]), view, overlay)).toThrow('Unsupported Canvas ARC sweep beyond one revolution (arc)');
    expect(() => prepareZoom2D(drawing([arc({ startAngle: 20, endAngle: 21 })]), view, overlay)).toThrow('Unsupported Canvas ARC angular precision range (arc)');
  });

  it('signs unproved parameter domains as topology without claiming angle accuracy', () => {
    let failure: unknown;
    try { prepareZoom2D(drawing([circle()]), { ...view, twist: 0.63 }, overlay); } catch (error) { failure = error; }
    expect((failure as Error).message).toBe('Unsupported Canvas stroke construction: native context rotation is unproved');
    expect(isSourceTopologyAdmissionError(failure)).toBe(true); expect(isSourcePrecisionCertificateError(failure)).toBe(false);
  });
});
