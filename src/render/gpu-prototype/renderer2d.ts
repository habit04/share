import type { DrawingState } from '../../core/document';
import { isImmutableData } from '../../core/immutable-data';
import { lineweightDisplay } from '../draw';
import { GpuDevice } from './device';
import { cssRgb, GPU_PAN_CACHE_BORDER, prepare2D, type Gpu2DView, type Gpu2DOverlay, type Prepared2D } from './geometry2d';

export type { Gpu2DView, Gpu2DOverlay } from './geometry2d';
export interface Gpu2DRenderResult {
  rendered: boolean;
  reason?: string;
  /** CPU wall time, including cache checks and all preparation. */
  preparationMs: number;
  /** CPU wall time issuing GL commands, including compilation/upload when necessary. */
  submissionMs: number;
  /** Bytes uploaded this call; a warm geometry/buffer cache reports zero. */
  bytes: number;
}

const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 a_position;
layout(location = 1) in vec3 a_color;
uniform vec2 u_view;
uniform vec2 u_pan;
out vec3 v_color;
void main() {
  vec2 position = a_position + u_pan;
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
  key: string;
  center: Gpu2DView['center'];
  padding: number;
  geometry: Prepared2D;
}

interface PreparedFrame { geometry: Prepared2D; pan: Gpu2DView['center'] }

/** Prototype model-space painter. Refusals leave full Canvas rendering to the caller. */
export class Gpu2DRenderer {
  readonly device: GpuDevice;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private viewUniform: WebGLUniformLocation | null = null;
  private panUniform: WebGLUniformLocation | null = null;
  private alphaUniform: WebGLUniformLocation | null = null;
  private uploaded: Prepared2D | null = null;
  private cache: PreparationCache | null = null;
  private initializationError: string | null = null;

  constructor(private readonly canvas: HTMLCanvasElement, onStateChange?: () => void) {
    this.device = new GpuDevice(canvas, () => {
      // Handles from a lost context must never be reused, even when GL's object identity stays.
      this.program = null;
      this.buffer = null;
      this.viewUniform = null;
      this.panUniform = null;
      this.alphaUniform = null;
      this.uploaded = null;
      this.cache = null;
      this.initializationError = null;
      onStateChange?.();
    });
  }

  private prepare(state: DrawingState, view: Gpu2DView, overlay: Gpu2DOverlay): PreparedFrame {
    // Scale remains part of the key: scaling cached strokes would change pixel widths and curve error.
    const key = JSON.stringify([view.width, view.height, view.dpr, view.scale, view.twist, view.lineweights ?? lineweightDisplay.enabled, [...overlay.selection], overlay.hover ?? null, !!overlay.solidSelection]);
    const linetypes = state.header?.linetypes;
    // Identity is safe only for snapshots certified immutable by the drawing core.
    const cacheable = isImmutableData(state.entities) && isImmutableData(state.layers) && (!linetypes || isImmutableData(linetypes));
    const cache = this.cache;
    if (cacheable && cache && cache.entities === state.entities && cache.layers === state.layers && cache.linetypes === linetypes && cache.key === key) {
      // Subtract world centers in JS doubles before packing only the small screen translation.
      const dx = cache.center.x - view.center.x, dy = cache.center.y - view.center.y;
      const c = Math.cos(view.twist), s = Math.sin(view.twist);
      const pan = { x: (dx * c - dy * s) * view.scale, y: -(dx * s + dy * c) * view.scale };
      if (Number.isFinite(pan.x) && Number.isFinite(pan.y)
        && Math.abs(pan.x) <= cache.padding && Math.abs(pan.y) <= cache.padding
        && Math.abs(pan.x) <= cache.geometry.panPrecisionMargin.x && Math.abs(pan.y) <= cache.geometry.panPrecisionMargin.y) {
        return { geometry: cache.geometry, pan };
      }
    }
    const padding = cacheable ? GPU_PAN_CACHE_BORDER / Math.max(1, view.dpr) : 0;
    const geometry = prepare2D(state, view, overlay, padding);
    this.cache = cacheable ? { entities: state.entities, layers: state.layers, linetypes, key, center: { ...view.center }, padding, geometry } : null;
    return { geometry, pan: { x: 0, y: 0 } };
  }

  private initialize(): void {
    if (this.initializationError) throw new Error(this.initializationError);
    if (this.program) return;
    try {
      const gl = this.device.gl;
      this.program = this.device.createProgram(VERTEX_SHADER, FRAGMENT_SHADER);
      this.viewUniform = gl.getUniformLocation(this.program, 'u_view');
      this.panUniform = gl.getUniformLocation(this.program, 'u_pan');
      this.alphaUniform = gl.getUniformLocation(this.program, 'u_alpha');
      if (this.viewUniform === null || this.panUniform === null || this.alphaUniform === null) throw new Error('WebGL2 stroke shader uniforms unavailable');
    } catch (error) {
      this.initializationError = error instanceof Error ? error.message : 'WebGL2 stroke initialization failed';
      throw error;
    }
  }

  render(state: DrawingState, view: Gpu2DView, overlay: Gpu2DOverlay): Gpu2DRenderResult {
    const start = performance.now();
    let preparationMs = 0, submissionStart: number | null = null, bytes = 0;
    const refusal = (reason: string): Gpu2DRenderResult => ({ rendered: false, reason, preparationMs: submissionStart === null ? Math.max(0, performance.now() - start) : preparationMs, submissionMs: submissionStart === null ? 0 : Math.max(0, performance.now() - submissionStart), bytes });
    if (this.device.state !== 'ready') return refusal(`WebGL2 device is ${this.device.state}`);
    try {
      const background = cssRgb(view.background);
      if (!background) return refusal('Unsupported GPU background color');
      const gl = this.device.gl;
      if (gl.isContextLost()) return refusal('WebGL2 context is lost');
      const width = Math.round(view.width * view.dpr), height = Math.round(view.height * view.dpr);
      const limits = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
      if (width < 1 || height < 1 || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width > limits[0]! || height > limits[1]!) return refusal('GPU viewport exceeds device limits');
      const { geometry, pan } = this.prepare(state, view, overlay);
      if (geometry.batches.some((batch) => batch.alpha < 1) && !gl.getContextAttributes()?.stencil) return refusal('Solid selection/hover requires a stencil buffer');
      preparationMs = Math.max(0, performance.now() - start);
      submissionStart = performance.now();
      if (this.canvas.width !== width) this.canvas.width = width;
      if (this.canvas.height !== height) this.canvas.height = height;
      if (gl.drawingBufferWidth !== width || gl.drawingBufferHeight !== height) return refusal('GPU drawing buffer could not match the requested viewport');
      this.initialize();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindVertexArray(null);
      gl.useProgram(this.program);
      if (!this.buffer) {
        this.buffer = this.device.createBuffer(geometry.vertices, gl.DYNAMIC_DRAW);
        bytes = geometry.vertices.byteLength;
        this.uploaded = geometry;
      } else if (this.uploaded !== geometry) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.bufferData(gl.ARRAY_BUFFER, geometry.vertices, gl.DYNAMIC_DRAW);
        bytes = geometry.vertices.byteLength;
        const error = gl.getError();
        if (error !== gl.NO_ERROR) throw new Error(`WebGL2 stroke upload failed (${error})`);
        this.uploaded = geometry;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.enableVertexAttribArray(0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 20, 0);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 20, 8);
      gl.uniform2f(this.viewUniform, view.width, view.height);
      gl.uniform2f(this.panUniform, pan.x, pan.y);
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
      const error = gl.getError();
      if (error !== gl.NO_ERROR || gl.isContextLost()) return refusal(`WebGL2 stroke submission failed (${error})`);
      return { rendered: true, preparationMs, submissionMs: Math.max(0, performance.now() - submissionStart), bytes };
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
