/**
 * GpuDevice: the one object that owns a WebGL2 context in JCad (the "GPU seam" of docs/3D-PLAN.md).
 *
 * It creates the context, compiles programs with readable error messages, creates buffers, keeps
 * a capability report and handles context loss. Everything GPU-related goes through it, so GPU
 * diagnostics (planned) read `capabilities()` and `contextLosses` here, and a future GPU 2D
 * renderer can share it.
 *
 * Context loss: `webglcontextlost` is prevented (which asks the browser to restore the context) and
 * `lost` becomes true; on `webglcontextrestored` the loss counter stays incremented and
 * `onRestored` runs so the owner recreates every program, buffer and framebuffer (all GL objects
 * from before the loss are invalid). While lost, rendering must be skipped (`lost` is true).
 *
 * Nothing here runs unless the experimental 3D viewport is switched on.
 */

/** What diagnostics need to know about the GPU behind the context. */
export interface GpuCapabilities {
  /** Unmasked vendor (WEBGL_debug_renderer_info) when the browser exposes it, else the masked one. */
  readonly vendor: string;
  readonly renderer: string;
  /** The context's VERSION string (e.g. "WebGL 2.0 (OpenGL ES 3.0 Chromium)"). */
  readonly version: string;
  readonly maxTextureSize: number;
  /** EXT_color_buffer_float available (float render targets). */
  readonly floatRenderTargets: boolean;
  /** How many times the context was lost since the device was created. */
  readonly contextLosses: number;
}

/** WebGL2 could not be created (unsupported browser, blocked GPU, too many contexts). */
export class GpuUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GpuUnavailableError';
  }
}

/** Context attributes every JCad WebGL context uses. */
export const CONTEXT_ATTRIBUTES: WebGLContextAttributes = { antialias: true, preserveDrawingBuffer: false, powerPreference: 'high-performance', alpha: false, depth: true, stencil: false };

export class GpuDevice {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  /** True between `webglcontextlost` and `webglcontextrestored`. */
  lost = false;
  /** Number of context losses so far. */
  contextLosses = 0;
  /** Duration of the last frame the owner recorded (CPU side, ms), for diagnostics. */
  lastFrameMs = 0;
  /** Called after a restore: recreate GL objects. */
  onRestored: (() => void) | null = null;
  /** Called when the context is lost. */
  onLost: (() => void) | null = null;
  private readonly lostHandler = (ev: Event): void => {
    ev.preventDefault();
    this.lost = true;
    this.contextLosses += 1;
    this.onLost?.();
  };
  private readonly restoredHandler = (): void => {
    this.lost = false;
    this.onRestored?.();
  };

  /** Create the WebGL2 context on `canvas`; throws GpuUnavailableError when that is impossible. */
  constructor(canvas: HTMLCanvasElement) {
    let gl: WebGL2RenderingContext | null = null;
    try {
      gl = canvas.getContext('webgl2', CONTEXT_ATTRIBUTES) as WebGL2RenderingContext | null;
    } catch (err) {
      throw new GpuUnavailableError(`WebGL2 could not be started: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!gl) throw new GpuUnavailableError('WebGL2 is not available (the GPU may be blocked or unsupported). The 3D viewport needs WebGL2.');
    this.canvas = canvas;
    this.gl = gl;
    canvas.addEventListener('webglcontextlost', this.lostHandler);
    canvas.addEventListener('webglcontextrestored', this.restoredHandler);
  }

  /** Stop listening for context events (the canvas is about to be discarded). */
  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.lostHandler);
    this.canvas.removeEventListener('webglcontextrestored', this.restoredHandler);
    this.onRestored = null;
    this.onLost = null;
  }

  /** Capability report (cheap; safe to call at any time, also while lost). */
  capabilities(): GpuCapabilities {
    const gl = this.gl;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    return {
      vendor: str(info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)),
      renderer: str(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)),
      version: str(gl.getParameter(gl.VERSION)),
      maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 0,
      floatRenderTargets: !!gl.getExtension('EXT_color_buffer_float'),
      contextLosses: this.contextLosses,
    };
  }

  /**
   * Compile and link a program. Throws an Error naming the failing stage with the driver's info
   * log (shader compile or program link), so a broken shader is reported, not drawn blank.
   */
  createProgram(vertexSource: string, fragmentSource: string): WebGLProgram {
    const gl = this.gl;
    const vs = this.compile(gl.VERTEX_SHADER, vertexSource, 'vertex');
    const fs = this.compile(gl.FRAGMENT_SHADER, fragmentSource, 'fragment');
    const program = gl.createProgram();
    if (!program) throw new Error('WebGL: could not create a program object.');
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
      const log = gl.getProgramInfoLog(program) ?? '';
      gl.deleteProgram(program);
      throw new Error(`WebGL program link failed: ${log.trim() || 'no log'}`);
    }
    return program;
  }

  private compile(type: number, source: string, stage: string): WebGLShader {
    const gl = this.gl;
    const sh = gl.createShader(type);
    if (!sh) throw new Error(`WebGL: could not create a ${stage} shader.`);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      const log = gl.getShaderInfoLog(sh) ?? '';
      gl.deleteShader(sh);
      throw new Error(`WebGL ${stage} shader compile failed: ${log.trim() || 'no log'}`);
    }
    return sh;
  }

  /** A buffer filled with `data` (ARRAY_BUFFER, STATIC_DRAW unless told otherwise). */
  createBuffer(data: ArrayBufferView, target: number = this.gl.ARRAY_BUFFER, usage: number = this.gl.STATIC_DRAW): WebGLBuffer {
    const gl = this.gl;
    const buf = gl.createBuffer();
    if (!buf) throw new Error('WebGL: could not create a buffer.');
    gl.bindBuffer(target, buf);
    gl.bufferData(target, data, usage);
    gl.bindBuffer(target, null);
    return buf;
  }

  /**
   * A vertex array over one interleaved float buffer. `layout` lists [attribute location, float
   * component count] in interleaving order; the stride is their sum.
   */
  createVertexArray(buffer: WebGLBuffer, layout: ReadonlyArray<readonly [number, number]>): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('WebGL: could not create a vertex array.');
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const stride = layout.reduce((s, [, n]) => s + n, 0) * 4;
    let offset = 0;
    for (const [loc, n] of layout) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, n, gl.FLOAT, false, stride, offset);
      offset += n * 4;
    }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return vao;
  }

  /**
   * Make the canvas backing store `width` x `height` device pixels (no-op when it already is).
   * Returns true when the size changed.
   */
  setBackingSize(width: number, height: number): boolean {
    let changed = false;
    if (this.canvas.width !== width) { this.canvas.width = width; changed = true; }
    if (this.canvas.height !== height) { this.canvas.height = height; changed = true; }
    return changed;
  }
}
