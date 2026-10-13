import type { DrawingState } from '../../core/document';
import { isImmutableData } from '../../core/immutable-data';
import { TEXT_STYLES_META_KEY } from '../../io/encoding';
import { lineweightDisplay } from '../draw';
import { GpuDevice } from './device';
import { cssRgb, GPU_ZOOM_VERTEX_STRIDE, prepareZoom2D, validateGpu2DView, zoomPrecisionSafe, type Gpu2DView, type Gpu2DOverlay, type PreparedZoom2D } from './geometry2d';

export type { Gpu2DView, Gpu2DOverlay } from './geometry2d';
export type Gpu2DCacheReason = 'not-checked' | 'cold' | 'mutable' | 'document' | 'view-style' | 'zoom-range' | 'pan-range' | 'precision' | 'hit';
export interface Gpu2DRenderResult {
  rendered: boolean;
  reason?: string;
  /** CPU wall time, including cache checks and all preparation. */
  preparationMs: number;
  /** Total CPU GL phase, including resize, initialization, uploads and draw commands. */
  submissionMs: number;
  /** CPU cache validation/lookup, excluding actual geometry preparation. */
  cacheLookupMs: number;
  /** CPU projection, tessellation, clipping and packing; exactly zero on a cache hit. */
  geometryPreparationMs: number;
  /** CPU shader initialization; excludes GPU completion and is zero on a warm program. */
  initializationMs: number;
  /** CPU buffer allocation/upload issuance and error checking, not transfer/GPU completion. */
  uploadMs: number;
  /** Allocation/upload attempts; a failed allocation may not reach bufferData. */
  uploadCalls: number;
  /** CPU state/uniform/clear/draw commands and error checking, excluding uploads/initialization. */
  drawSubmissionMs: number;
  geometryVertices: number;
  cacheHit: boolean;
  cacheReason: Gpu2DCacheReason;
  /** Requested upload bytes (confirmed on success); a warm geometry/buffer cache reports zero. */
  bytes: number;
}

export function emptyGpu2DRenderResult(reason: string): Gpu2DRenderResult {
  return { rendered: false, reason, preparationMs: 0, submissionMs: 0, cacheLookupMs: 0, geometryPreparationMs: 0, initializationMs: 0, uploadMs: 0, uploadCalls: 0, drawSubmissionMs: 0, geometryVertices: 0, cacheHit: false, cacheReason: 'not-checked', bytes: 0 };
}

const VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_center;
layout(location = 1) in vec3 a_color;
layout(location = 2) in vec2 a_offset;
uniform vec2 u_view;
uniform vec2 u_pan;
uniform float u_zoom;
out vec3 v_color;
void main() {
  vec2 position = a_center * u_zoom + u_pan + u_view * 0.5 + a_offset;
  gl_Position = vec4(position.x / u_view.x * 2.0 - 1.0,
                     1.0 - position.y / u_view.y * 2.0, 0.0, 1.0);
  v_color = a_color;
}`;
const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 v_color;
uniform float u_alpha;
out vec4 out_color;
void main() { out_color = vec4(v_color, u_alpha); }`;

interface PreparationCache {
  entities: DrawingState['entities'];
  layers: DrawingState['layers'];
  linetypes: NonNullable<DrawingState['header']>['linetypes'] | undefined;
  view: Gpu2DView;
  selection: ReadonlySet<string>;
  hover: string | null;
  solidSelection: boolean;
  geometry: PreparedZoom2D;
}

interface PreparedFrame { geometry: PreparedZoom2D; pan: Gpu2DView['center']; ratio: number }

function sameSelection(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

function sameCompoundDependencies(geometry: PreparedZoom2D, state: DrawingState): boolean {
  const compound = geometry.compound;
  if (!compound) return true;
  if (compound.textStylesDependency !== state.meta?.[TEXT_STYLES_META_KEY]) return false;
  for (const [name, definition] of compound.blockDependencies) if (state.blocks[name] !== definition) return false;
  return true;
}

/** Prototype model-space painter. Refusals leave full Canvas rendering to the caller. */
export class Gpu2DRenderer {
  readonly device: GpuDevice;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private viewUniform: WebGLUniformLocation | null = null;
  private panUniform: WebGLUniformLocation | null = null;
  private zoomUniform: WebGLUniformLocation | null = null;
  private alphaUniform: WebGLUniformLocation | null = null;
  private uploaded: PreparedZoom2D | null = null;
  private cache: PreparationCache | null = null;
  private initializationError: string | null = null;
  private viewportLimits: readonly number[] | null = null;
  private stencilAvailable: boolean | null = null;

  constructor(private readonly canvas: HTMLCanvasElement, onStateChange?: () => void) {
    this.device = new GpuDevice(canvas, () => {
      // Handles from a lost context must never be reused, even when GL's object identity stays.
      this.program = null;
      this.buffer = null;
      this.viewUniform = null;
      this.panUniform = null;
      this.zoomUniform = null;
      this.alphaUniform = null;
      this.uploaded = null;
      this.cache = null;
      this.initializationError = null;
      this.viewportLimits = null;
      this.stencilAvailable = null;
      onStateChange?.();
    });
  }

  private prepare(state: DrawingState, view: Gpu2DView, overlay: Gpu2DOverlay, metrics: Gpu2DRenderResult): PreparedFrame {
    const lookupStart = performance.now();
    validateGpu2DView(view);
    const linetypes = state.header?.linetypes;
    // Identity is safe only for snapshots certified immutable by the drawing core.
    const cache = this.cache;
    const unchangedScene = cache?.entities === state.entities && cache.layers === state.layers;
    const compiled = unchangedScene ? !!cache.geometry.compound : state.entities.some((entity) =>
      (entity.type === 'insert' || entity.type === 'text') && !state.layers.some((layer) => layer.name === entity.layer && !layer.visible));
    const textStyles = compiled ? state.meta?.[TEXT_STYLES_META_KEY] : undefined;
    const compiledImmutable = !compiled || (isImmutableData(state.blocks) && (!textStyles || typeof textStyles !== 'object' || isImmutableData(textStyles)));
    const cacheable = isImmutableData(state.entities) && isImmutableData(state.layers) && (!linetypes || isImmutableData(linetypes)) && compiledImmutable;
    metrics.cacheReason = !cacheable ? 'mutable' : !cache ? 'cold' : 'document';
    if (cacheable && cache && cache.entities === state.entities && cache.layers === state.layers && cache.linetypes === linetypes && sameCompoundDependencies(cache.geometry, state)) {
      const lineweights = view.lineweights ?? lineweightDisplay.enabled;
      const sameStyle = cache.view.width === view.width && cache.view.height === view.height && cache.view.dpr === view.dpr && cache.view.twist === view.twist && cache.view.lineweights === lineweights && sameSelection(cache.selection, overlay.selection) && cache.hover === (overlay.hover ?? null) && cache.solidSelection === !!overlay.solidSelection;
      metrics.cacheReason = 'view-style';
      if (sameStyle) {
        // Subtract world centers in JS doubles before packing only the small screen translation.
        const dx = cache.view.center.x - view.center.x, dy = cache.view.center.y - view.center.y;
        const c = Math.cos(view.twist), s = Math.sin(view.twist);
        const pan = { x: (dx * c - dy * s) * view.scale, y: -(dx * s + dy * c) * view.scale };
        const ratio = view.scale / cache.view.scale;
        metrics.cacheReason = 'zoom-range';
        if (Number.isFinite(ratio) && ratio >= cache.geometry.minRatio && ratio <= cache.geometry.maxRatio) {
          metrics.cacheReason = 'pan-range';
          if (Number.isFinite(pan.x) && Number.isFinite(pan.y) && Math.abs(pan.x) <= cache.geometry.padding && Math.abs(pan.y) <= cache.geometry.padding) {
            metrics.cacheReason = 'precision';
            if (zoomPrecisionSafe(cache.geometry, view, ratio, pan)) {
              metrics.cacheHit = true;
              metrics.cacheReason = 'hit';
              metrics.cacheLookupMs = Math.max(0, performance.now() - lookupStart);
              return { geometry: cache.geometry, pan, ratio };
            }
          }
        }
      }
    }
    metrics.cacheLookupMs = Math.max(0, performance.now() - lookupStart);
    const geometryStart = performance.now();
    let geometry: PreparedZoom2D;
    try { geometry = cacheable ? prepareZoom2D(state, view, overlay) : prepareZoom2D(state, view, overlay, 1, 1, 0); }
    finally { metrics.geometryPreparationMs = Math.max(0, performance.now() - geometryStart); }
    this.cache = cacheable ? { entities: state.entities, layers: state.layers, linetypes, view: { ...view, center: { ...view.center }, lineweights: view.lineweights ?? lineweightDisplay.enabled }, selection: new Set(overlay.selection), hover: overlay.hover ?? null, solidSelection: !!overlay.solidSelection, geometry } : null;
    return { geometry, pan: { x: 0, y: 0 }, ratio: 1 };
  }

  private initialize(): void {
    if (this.initializationError) throw new Error(this.initializationError);
    if (this.program) return;
    try {
      const gl = this.device.gl;
      this.program = this.device.createProgram(VERTEX_SHADER, FRAGMENT_SHADER);
      this.viewUniform = gl.getUniformLocation(this.program, 'u_view');
      this.panUniform = gl.getUniformLocation(this.program, 'u_pan');
      this.zoomUniform = gl.getUniformLocation(this.program, 'u_zoom');
      this.alphaUniform = gl.getUniformLocation(this.program, 'u_alpha');
      if (this.viewUniform === null || this.panUniform === null || this.zoomUniform === null || this.alphaUniform === null) throw new Error('WebGL2 stroke shader uniforms unavailable');
    } catch (error) {
      this.initializationError = error instanceof Error ? error.message : 'WebGL2 stroke initialization failed';
      throw error;
    }
  }

  render(state: DrawingState, view: Gpu2DView, overlay: Gpu2DOverlay): Gpu2DRenderResult {
    const start = performance.now();
    const metrics = emptyGpu2DRenderResult('');
    let submissionStart: number | null = null;
    const finish = (rendered: boolean, reason?: string): Gpu2DRenderResult => ({ ...metrics, rendered, reason, preparationMs: submissionStart === null ? Math.max(0, performance.now() - start) : metrics.preparationMs, submissionMs: submissionStart === null ? 0 : Math.max(0, performance.now() - submissionStart) });
    const refusal = (reason: string): Gpu2DRenderResult => finish(false, reason);
    if (this.device.state !== 'ready') return refusal(`WebGL2 device is ${this.device.state}`);
    try {
      const background = cssRgb(view.background);
      if (!background) return refusal('Unsupported GPU background color');
      const gl = this.device.gl;
      if (gl.isContextLost()) return refusal('WebGL2 context is lost');
      const width = Math.round(view.width * view.dpr), height = Math.round(view.height * view.dpr);
      // Limits belong to this live context and cannot change until its handles are invalidated.
      if (!this.viewportLimits) {
        const reported = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array | null;
        if (!reported || reported.length < 2 || !Number.isSafeInteger(reported[0]) || !Number.isSafeInteger(reported[1]) || reported[0]! < 1 || reported[1]! < 1) return refusal('GPU viewport limits unavailable');
        this.viewportLimits = [reported[0]!, reported[1]!];
      }
      const limits = this.viewportLimits;
      if (width < 1 || height < 1 || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width > limits[0]! || height > limits[1]!) return refusal('GPU viewport exceeds device limits');
      const { geometry, pan, ratio } = this.prepare(state, view, overlay, metrics);
      metrics.geometryVertices = geometry.vertices.length / GPU_ZOOM_VERTEX_STRIDE;
      if (geometry.batches.some((batch) => batch.alpha < 1)) {
        this.stencilAvailable ??= gl.getContextAttributes()?.stencil ?? false;
        if (!this.stencilAvailable) return refusal('Solid selection/hover requires a stencil buffer');
      }
      metrics.preparationMs = Math.max(0, performance.now() - start);
      submissionStart = performance.now();
      if (this.canvas.width !== width) this.canvas.width = width;
      if (this.canvas.height !== height) this.canvas.height = height;
      if (gl.drawingBufferWidth !== width || gl.drawingBufferHeight !== height) return refusal('GPU drawing buffer could not match the requested viewport');
      if (!this.program || this.initializationError) {
        const initializationStart = performance.now();
        try { this.initialize(); }
        finally { metrics.initializationMs = Math.max(0, performance.now() - initializationStart); }
      }
      if (!this.buffer || this.uploaded !== geometry) {
        const uploadStart = performance.now();
        metrics.bytes = geometry.vertices.byteLength;
        metrics.uploadCalls++;
        this.uploaded = null; // A rejected upload can leave buffer contents undefined.
        try {
          if (!this.buffer) this.buffer = this.device.createBuffer(geometry.vertices, gl.DYNAMIC_DRAW);
          else {
            gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
            gl.bufferData(gl.ARRAY_BUFFER, geometry.vertices, gl.DYNAMIC_DRAW);
            const error = gl.getError();
            if (error !== gl.NO_ERROR) throw new Error(`WebGL2 stroke upload failed (${error})`);
          }
          this.uploaded = geometry;
        } finally { metrics.uploadMs = Math.max(0, performance.now() - uploadStart); }
      }
      const drawStart = performance.now();
      let error: number;
      try {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindVertexArray(null);
        gl.useProgram(this.program);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.enableVertexAttribArray(0);
        gl.enableVertexAttribArray(1);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 28, 0);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 28, 16);
        gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 28, 8);
        gl.uniform2f(this.viewUniform, view.width, view.height);
        gl.uniform2f(this.panUniform, pan.x, pan.y);
        gl.uniform1f(this.zoomUniform, ratio);
        gl.viewport(0, 0, width, height);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.CULL_FACE);
        gl.disable(gl.SCISSOR_TEST);
        gl.disable(gl.RASTERIZER_DISCARD);
        gl.disable(gl.STENCIL_TEST);
        gl.disable(gl.BLEND);
        gl.colorMask(true, true, true, true);
        gl.depthMask(false);
        gl.stencilMask(0xff);
        gl.clearColor(...background, 1);
        gl.clearStencil(0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

        for (let i = 0; i < geometry.batches.length; i++) {
          const batch = geometry.batches[i]!;
          gl.uniform1f(this.alphaUniform, batch.alpha);
          if (batch.alpha < 1) {
            // Canvas composites an entity's entire stroke once. Stencil prevents overlapping
            // strips/joins/self-crossings from applying selection opacity more than once.
            gl.enable(gl.BLEND);
            gl.blendEquation(gl.FUNC_ADD);
            gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.enable(gl.STENCIL_TEST);
            gl.clear(gl.STENCIL_BUFFER_BIT);
            gl.stencilFunc(gl.EQUAL, 0, 0xff);
            gl.stencilOp(gl.KEEP, gl.KEEP, gl.INCR);
            gl.drawArrays(gl.TRIANGLES, batch.first, batch.count);
            gl.disable(gl.STENCIL_TEST);
            gl.disable(gl.BLEND);
          } else {
            let count = batch.count;
            // Opaque strokes retain entity order while sharing one submission.
            while (i + 1 < geometry.batches.length && geometry.batches[i + 1]!.alpha === 1) count += geometry.batches[++i]!.count;
            gl.drawArrays(gl.TRIANGLES, batch.first, count);
          }
        }
        error = gl.getError();
      } finally { metrics.drawSubmissionMs = Math.max(0, performance.now() - drawStart); }
      if (error !== gl.NO_ERROR || gl.isContextLost()) return refusal(`WebGL2 stroke submission failed (${error})`);
      return finish(true);
    } catch (error) {
      return refusal(error instanceof Error ? error.message : 'GPU rendering failed');
    }
  }

  dispose(): void {
    this.cache = null;
    this.uploaded = null;
    this.device.dispose();
  }
}
