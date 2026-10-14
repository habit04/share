import { afterEach, describe, expect, it, vi } from 'vitest';
import { GpuDevice } from '../src/render/gpu-prototype/device';

function deviceFixture() {
  let serial = 0;
  const handle = () => ({ serial: ++serial });
  const gl = {
    VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30, COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892, ARRAY_BUFFER_BINDING: 0x8894, STATIC_DRAW: 0x88e4, DYNAMIC_DRAW: 0x88e8,
    NO_ERROR: 0, OUT_OF_MEMORY: 0x505, SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
    ALREADY_SIGNALED: 0x911a, TIMEOUT_EXPIRED: 0x911b, CONDITION_SATISFIED: 0x911c, WAIT_FAILED: 0x911d,
    VERSION: 0x1f02, RENDERER: 0x1f01, MAX_TEXTURE_SIZE: 0xd33, MAX_VIEWPORT_DIMS: 0xd3a,
    isContextLost: vi.fn(() => false),
    createShader: vi.fn(handle), shaderSource: vi.fn(), compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true), getShaderInfoLog: vi.fn(() => 'shader error'),
    createProgram: vi.fn(handle), attachShader: vi.fn(), detachShader: vi.fn(), linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true), getProgramInfoLog: vi.fn(() => 'link error'),
    deleteShader: vi.fn(), deleteProgram: vi.fn(),
    createBuffer: vi.fn(handle), bindBuffer: vi.fn(), bufferData: vi.fn(), deleteBuffer: vi.fn(),
    getError: vi.fn(() => 0),
    getParameter: vi.fn((key: number): unknown => {
      if (key === 0x1f02) return 'WebGL 2.0';
      if (key === 0x1f01) return 'test renderer';
      if (key === 0xd33) return 4096;
      if (key === 0xd3a) return new Int32Array([4096, 2048]);
      return null;
    }),
    getContextAttributes: vi.fn(() => ({ antialias: true, stencil: true })),
    getExtension: vi.fn(() => null),
    fenceSync: vi.fn(handle), flush: vi.fn(), deleteSync: vi.fn(),
    clientWaitSync: vi.fn(() => 0x911c),
  };
  const events = new EventTarget();
  const getContext = vi.fn((): WebGL2RenderingContext | null => gl as unknown as WebGL2RenderingContext);
  const canvas = Object.assign(events, { getContext }) as unknown as HTMLCanvasElement;
  return { canvas, gl, getContext };
}

afterEach(() => { vi.useRealTimers(); });

describe('shared GPU device', () => {
  it.each(['null', 'throw'] as const)('gracefully fails when context creation returns %s', (failure) => {
    const fixture = deviceFixture();
    fixture.getContext.mockImplementation(() => {
      if (failure === 'throw') throw new Error('disabled');
      return null;
    });
    const device = new GpuDevice(fixture.canvas);
    expect(device.state).toBe('failed');
    expect(device.capabilities()).toMatchObject({ state: 'failed', version: null, maxTextureSize: null });
    expect(() => device.createProgram('vs', 'fs')).toThrow(/failed/);
    expect(() => device.createBuffer(new Float32Array(2))).toThrow(/failed/);
    expect(() => device.gl).toThrow(/unavailable/);
    device.dispose();
    expect(device.state).toBe('disposed');
  });

  it('requests WebGL2 and releases tracked buffers, programs and temporary shaders exactly once', () => {
    const { canvas, gl, getContext } = deviceFixture();
    const states: string[] = [];
    const device = new GpuDevice(canvas, () => states.push(device.state));
    expect(device.gl).toBe(gl);
    expect(getContext).toHaveBeenCalledWith('webgl2', expect.objectContaining({ alpha: false, antialias: true, stencil: true }));
    const program = device.createProgram('vertex source', 'fragment source');
    const data = new Float32Array([1, 2]);
    const buffer = device.createBuffer(data, gl.DYNAMIC_DRAW);
    expect(gl.bufferData).toHaveBeenCalledWith(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    expect(gl.bindBuffer).toHaveBeenLastCalledWith(gl.ARRAY_BUFFER, null);
    expect(gl.deleteShader).toHaveBeenCalledTimes(2);
    expect(gl.deleteProgram).not.toHaveBeenCalled();
    device.dispose(); device.dispose();
    expect(gl.deleteProgram).toHaveBeenCalledExactlyOnceWith(program);
    expect(gl.deleteBuffer).toHaveBeenCalledExactlyOnceWith(buffer);
    expect(states).toEqual(['disposed']);
    expect(() => device.createBuffer(data)).toThrow(/disposed/);
  });

  it('restores the previous array-buffer binding when allocating shared buffers', () => {
    const { canvas, gl } = deviceFixture();
    const oldBinding = { owner: 'other renderer' };
    gl.getParameter.mockReturnValue(oldBinding);
    const device = new GpuDevice(canvas);
    device.createBuffer(new ArrayBuffer(12));
    expect(gl.bindBuffer).toHaveBeenLastCalledWith(gl.ARRAY_BUFFER, oldBinding);
    device.dispose();
  });

  it('cleans up failed shader compilation without allocating a program', () => {
    const { canvas, gl } = deviceFixture();
    gl.getShaderParameter.mockReturnValue(false);
    const device = new GpuDevice(canvas);
    expect(() => device.createProgram('bad vertex', 'fragment')).toThrow('shader error');
    expect(gl.deleteShader).toHaveBeenCalledTimes(1);
    expect(gl.createProgram).not.toHaveBeenCalled();
    device.dispose();
    expect(gl.deleteShader).toHaveBeenCalledTimes(1);
  });

  it('cleans both shaders and the failed program on link failure', () => {
    const { canvas, gl } = deviceFixture();
    gl.getProgramParameter.mockReturnValue(false);
    const device = new GpuDevice(canvas);
    expect(() => device.createProgram('vertex', 'fragment')).toThrow('link error');
    expect(gl.deleteShader).toHaveBeenCalledTimes(2);
    expect(gl.detachShader).toHaveBeenCalledTimes(2);
    expect(gl.deleteProgram).toHaveBeenCalledTimes(1);
    // A deleted program must not subsequently receive detachShader calls.
    expect(gl.detachShader.mock.invocationCallOrder[1]).toBeLessThan(gl.deleteProgram.mock.invocationCallOrder[0]!);
    device.dispose();
    expect(gl.deleteProgram).toHaveBeenCalledTimes(1);
  });

  it('deletes a failed buffer upload and restores its binding', () => {
    const { canvas, gl } = deviceFixture();
    gl.getError.mockReturnValue(gl.OUT_OF_MEMORY);
    const device = new GpuDevice(canvas);
    expect(() => device.createBuffer(new Float32Array(2))).toThrow(/upload failed/);
    expect(gl.deleteBuffer).toHaveBeenCalledTimes(1);
    expect(gl.bindBuffer).toHaveBeenLastCalledWith(gl.ARRAY_BUFFER, null);
    device.dispose();
    expect(gl.deleteBuffer).toHaveBeenCalledTimes(1);
  });

  it('invalidates lost handles and notifies clients to rebuild after restoration', () => {
    const { canvas, gl } = deviceFixture();
    const states: string[] = [];
    const device = new GpuDevice(canvas, () => states.push(device.state));
    const old = device.createBuffer(new Float32Array(2));
    const lost = new Event('webglcontextlost', { cancelable: true });
    gl.isContextLost.mockReturnValue(true);
    canvas.dispatchEvent(lost);
    expect(lost.defaultPrevented).toBe(true);
    expect(device.state).toBe('lost');
    expect(() => device.createProgram('vs', 'fs')).toThrow(/lost/);
    gl.isContextLost.mockReturnValue(false);
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    const rebuilt = device.createBuffer(new Float32Array(2));
    expect(states).toEqual(['lost', 'ready']);
    expect(rebuilt).not.toBe(old);
    device.dispose();
    expect(gl.deleteBuffer).toHaveBeenCalledExactlyOnceWith(rebuilt);
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(device.state).toBe('disposed');
  });

  it('reports a restoration failure and usable capability data without querying private adapter IDs', () => {
    const { canvas, getContext, gl } = deviceFixture();
    const device = new GpuDevice(canvas);
    expect(device.capabilities()).toEqual({ state: 'ready', version: 'WebGL 2.0', renderer: 'test renderer', maxTextureSize: 4096, maxViewportDims: [4096, 2048], antialias: true, stencil: true, timerQuery: false });
    expect(gl.getExtension).toHaveBeenCalledExactlyOnceWith('EXT_disjoint_timer_query_webgl2');
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    getContext.mockReturnValue(null);
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(device.state).toBe('failed');
    device.dispose();
  });
});

describe('nonblocking GPU fence observation', () => {
  it('yields before polling and reports elapsed wall time with zero-timeout waits', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { canvas, gl } = deviceFixture();
    gl.clientWaitSync.mockReturnValueOnce(gl.TIMEOUT_EXPIRED).mockReturnValue(gl.CONDITION_SATISFIED);
    const device = new GpuDevice(canvas);
    const result = device.completed();
    expect(gl.clientWaitSync).not.toHaveBeenCalled();
    expect(gl.flush).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4);
    expect(await result).toBe(4);
    for (const call of gl.clientWaitSync.mock.calls as unknown as [unknown, number, number][]) expect(call.slice(1)).toEqual([0, 0]);
    expect(gl.deleteSync).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    device.dispose();
  });

  it('bounds an unsignalled fence at one second and releases its polling timers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { canvas, gl } = deviceFixture();
    gl.clientWaitSync.mockReturnValue(gl.TIMEOUT_EXPIRED);
    const device = new GpuDevice(canvas);
    const result = device.completed();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBeNull();
    expect(gl.deleteSync).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    device.dispose();
  });

  it.each(['lost', 'disposed'] as const)('settles pending fences immediately on %s', async (state) => {
    vi.useFakeTimers();
    const { canvas, gl } = deviceFixture();
    const device = new GpuDevice(canvas);
    const first = device.completed(), second = device.completed();
    if (state === 'lost') canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    else device.dispose();
    expect(await first).toBeNull(); expect(await second).toBeNull();
    expect(await device.completed()).toBeNull();
    expect(gl.deleteSync).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    device.dispose();
  });

  it('returns null on failed waits and cleans the sync even when flush throws', async () => {
    vi.useFakeTimers();
    const { canvas, gl } = deviceFixture();
    const device = new GpuDevice(canvas);
    gl.clientWaitSync.mockReturnValue(gl.WAIT_FAILED);
    const result = device.completed();
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBeNull();
    gl.flush.mockImplementation(() => { throw new Error('context lost'); });
    expect(await device.completed()).toBeNull();
    expect(gl.deleteSync).toHaveBeenCalledTimes(2);
    device.dispose();
  });
});
