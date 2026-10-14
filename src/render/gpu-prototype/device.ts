export type GpuDeviceState = 'ready' | 'lost' | 'failed' | 'disposed';

export interface GpuCapabilities {
  state: GpuDeviceState;
  version: string | null;
  renderer: string | null;
  maxTextureSize: number | null;
  maxViewportDims: number[] | null;
  antialias: boolean;
  stencil: boolean;
  /** Availability only; completed() measures wall time, never a GPU timer query. */
  timerQuery: boolean;
}

/** Shared WebGL2 owner. Resources are invalid after loss; clients rebuild on restoration. */
export class GpuDevice {
  private context: WebGL2RenderingContext | null = null;
  private status: GpuDeviceState = 'failed';
  private readonly programs = new Set<WebGLProgram>();
  private readonly buffers = new Set<WebGLBuffer>();
  private readonly pending = new Map<WebGLSync, () => void>();

  constructor(private readonly canvas: HTMLCanvasElement, private readonly onStateChange?: () => void) {
    canvas.addEventListener('webglcontextlost', this.lost);
    canvas.addEventListener('webglcontextrestored', this.restored);
    try {
      this.context = canvas.getContext('webgl2', { alpha: false, antialias: true, depth: true, stencil: true });
      if (this.context) this.status = this.context.isContextLost() ? 'lost' : 'ready';
    } catch { /* A canvas already owned by another context also fails gracefully. */ }
  }

  get state(): GpuDeviceState { return this.status; }

  /** Check state before use. An unavailable context is never represented by a fake GL object. */
  get gl(): WebGL2RenderingContext {
    if (!this.context) throw new Error('WebGL2 context unavailable');
    return this.context;
  }

  private change(state: GpuDeviceState): void {
    if (this.status === state) return;
    this.status = state;
    this.onStateChange?.();
  }

  private readonly lost = (event: Event): void => {
    event.preventDefault(); // Opt in to browser restoration.
    if (this.status === 'disposed') return;
    this.cancelPending();
    // WebGL invalidates all these handles on loss; retaining them would leak JS objects.
    this.programs.clear();
    this.buffers.clear();
    this.change('lost');
  };

  private readonly restored = (): void => {
    if (this.status === 'disposed') return;
    try {
      this.context = this.canvas.getContext('webgl2');
      this.change(this.context && !this.context.isContextLost() ? 'ready' : 'failed');
    } catch { this.change('failed'); }
  };

  private requireReady(): WebGL2RenderingContext {
    if (this.status !== 'ready' || this.gl.isContextLost()) throw new Error(`WebGL2 device is ${this.status}`);
    return this.gl;
  }

  createProgram(vs: string, fs: string): WebGLProgram {
    const gl = this.requireReady();
    const shaders: WebGLShader[] = [];
    let program: WebGLProgram | null = null;
    try {
      for (const [type, source] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error('WebGL2 shader allocation failed');
        shaders.push(shader);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'WebGL2 shader compilation failed');
      }
      program = gl.createProgram();
      if (!program) throw new Error('WebGL2 program allocation failed');
      for (const shader of shaders) gl.attachShader(program, shader);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'WebGL2 program link failed');
      this.programs.add(program);
      return program;
    } catch (error) {
      if (program) {
        for (const shader of shaders) gl.detachShader(program, shader);
        gl.deleteProgram(program);
        program = null;
      }
      throw error;
    } finally {
      for (const shader of shaders) {
        if (program) gl.detachShader(program, shader);
        gl.deleteShader(shader);
      }
    }
  }

  createBuffer(data: BufferSource, usage?: number): WebGLBuffer {
    const gl = this.requireReady();
    const buffer = gl.createBuffer();
    if (!buffer) throw new Error('WebGL2 buffer allocation failed');
    const previous = gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
    try {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, usage ?? gl.STATIC_DRAW);
      const error = gl.getError();
      if (error !== gl.NO_ERROR) throw new Error(`WebGL2 buffer upload failed (${error})`);
      this.buffers.add(buffer);
      return buffer;
    } catch (error) {
      gl.deleteBuffer(buffer);
      throw error;
    } finally { gl.bindBuffer(gl.ARRAY_BUFFER, previous); }
  }

  capabilities(): GpuCapabilities {
    const unavailable: GpuCapabilities = { state: this.state, version: null, renderer: null, maxTextureSize: null, maxViewportDims: null, antialias: false, stencil: false, timerQuery: false };
    if (this.state !== 'ready') return unavailable;
    try {
      const gl = this.gl, attributes = gl.getContextAttributes();
      return {
        state: this.state,
        version: gl.getParameter(gl.VERSION) as string,
        renderer: gl.getParameter(gl.RENDERER) as string,
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
        maxViewportDims: Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array),
        antialias: attributes?.antialias ?? false,
        stencil: attributes?.stencil ?? false,
        timerQuery: !!gl.getExtension('EXT_disjoint_timer_query_webgl2'),
      };
    } catch { return unavailable; }
  }

  /** Wall milliseconds from fence insertion to observation. Timeout/loss/failure => null.
   * Zero-timeout polls yield to the event loop; no finish() or blocking client wait.
   */
  completed(): Promise<number | null> {
    if (this.state !== 'ready') return Promise.resolve(null);
    const gl = this.gl, start = performance.now();
    let sync: WebGLSync | null = null;
    try {
      sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (!sync) return Promise.resolve(null);
      gl.flush();
    } catch {
      if (sync) gl.deleteSync(sync);
      return Promise.resolve(null);
    }
    const fence = sync;
    return new Promise((resolve) => {
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const settle = (value: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(pollTimer);
        clearTimeout(deadline);
        this.pending.delete(fence);
        gl.deleteSync(fence);
        resolve(value);
      };
      const deadline = setTimeout(() => settle(null), 1000);
      this.pending.set(fence, () => settle(null));
      const poll = (): void => {
        if (this.state !== 'ready' || gl.isContextLost() || performance.now() - start >= 1000) { settle(null); return; }
        try {
          const result = gl.clientWaitSync(fence, 0, 0);
          if (result === gl.ALREADY_SIGNALED || result === gl.CONDITION_SATISFIED) settle(Math.max(0, performance.now() - start));
          else if (result === gl.WAIT_FAILED) settle(null);
          else pollTimer = setTimeout(poll, 4);
        } catch { settle(null); }
      };
      // Even an already completed fence is observed asynchronously.
      pollTimer = setTimeout(poll, 0);
    });
  }

  private cancelPending(): void { for (const cancel of this.pending.values()) cancel(); }

  dispose(): void {
    if (this.state === 'disposed') return;
    this.canvas.removeEventListener('webglcontextlost', this.lost);
    this.canvas.removeEventListener('webglcontextrestored', this.restored);
    this.cancelPending();
    if (this.context) {
      for (const buffer of this.buffers) this.context.deleteBuffer(buffer);
      for (const program of this.programs) this.context.deleteProgram(program);
    }
    this.buffers.clear();
    this.programs.clear();
    this.change('disposed');
  }
}
