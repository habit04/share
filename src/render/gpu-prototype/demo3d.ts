import { GpuDevice, type GpuCapabilities, type GpuDeviceState } from './device';
import {
  add3, cameraBasis, cameraMatrices, cameraRay, createCamera3d, fitCamera, orbitCamera, panCamera,
  projectToScreen, scale3, setCameraProjection, zoomCamera, type Camera3d, type Projection3d,
} from './camera3d';
import { createDemoMeshes, createGrid, meshBounds, pickMeshes, type Mesh3d, type Pick3d } from './meshes3d';

const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
uniform mat4 uViewProjection;
out vec3 vNormal;
out vec3 vPosition;
void main() {
  vNormal = aNormal;
  vPosition = aPosition;
  gl_Position = uViewProjection * vec4(aPosition, 1.0);
}`;
const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vPosition;
uniform vec3 uColor;
uniform vec3 uEye;
uniform bool uUnlit;
uniform bool uSelected;
out vec4 outColor;
void main() {
  if (uUnlit) { outColor = vec4(uColor, 1.0); return; }
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 light = normalize(vec3(0.5, 1.0, 0.75));
  vec3 halfVector = normalize(light + normalize(uEye - vPosition));
  float shade = 0.30 + 0.70 * max(dot(n, light), 0.0);
  float specular = 0.22 * pow(max(dot(n, halfVector), 0.0), 32.0);
  vec3 color = uSelected ? mix(uColor, vec3(1.0, 0.86, 0.25), 0.65) : uColor;
  outColor = vec4(color * shade + specular, 1.0);
}`;

export interface GpuDemoStatus {
  state: GpuDeviceState;
  deviceState: GpuDeviceState;
  selected: string | null;
  selection: Pick3d | null;
  projection: Projection3d;
  camera: Camera3d;
  frames: number;
  error: string | null;
  capabilities: GpuCapabilities | null;
  viewport: { width: number; height: number; pixelWidth: number; pixelHeight: number; dpr: number };
  objects: { id: string; name: string; triangles: number; screen: ReturnType<typeof projectToScreen> }[];
}
export interface GpuDemoHandle {
  dispose(): void;
  status(): GpuDemoStatus;
  setProjection(projection: Projection3d): void;
  fit(): void;
  /** CSS pixels relative to the canvas, using the same picking path as pointer input. */
  pick(x: number, y: number): Pick3d | null;
}
interface UploadedMesh { mesh: Mesh3d; buffer: WebGLBuffer; vertices: number }
interface Resources {
  program: WebGLProgram;
  meshes: UploadedMesh[];
  grid: WebGLBuffer;
  gridVertices: number;
  viewProjection: WebGLUniformLocation;
  eye: WebGLUniformLocation;
  color: WebGLUniformLocation;
  unlit: WebGLUniformLocation;
  selected: WebGLUniformLocation;
}

/** Expand indices because the shared device uploads ARRAY_BUFFERs. No element buffers/VAOs to own. */
function triangleVertices(mesh: Mesh3d): Float32Array<ArrayBuffer> {
  const data = new Float32Array(mesh.indices.length * 6);
  for (let i = 0; i < mesh.indices.length; i++) {
    const source = mesh.indices[i]! * 3;
    for (let axis = 0; axis < 3; axis++) {
      data[i * 6 + axis] = mesh.positions[source + axis]!;
      data[i * 6 + axis + 3] = mesh.normals[source + axis]!;
    }
  }
  return data;
}

/** Self-contained preview: no Drawing, document, settings, or save integration. */
export function mountGpuDemo(container: HTMLElement): GpuDemoHandle {
  const doc = container.ownerDocument, view = doc.defaultView;
  if (!view) throw new Error('The 3D demo requires a browser window.');
  const root = doc.createElement('section');
  root.dataset.gpuDemo = '3d';
  root.setAttribute('aria-label', 'GPU 3D demo');
  root.style.cssText = 'display:flex;flex-direction:column;width:100%;height:100%;min-height:360px;overflow:hidden;background:#111827;color:#e5e7eb;font:14px system-ui,sans-serif;border-radius:8px;';
  const toolbar = doc.createElement('div');
  toolbar.setAttribute('role', 'group');
  toolbar.setAttribute('aria-label', '3D view controls');
  toolbar.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px;';
  const stage = doc.createElement('div');
  stage.style.cssText = 'position:relative;flex:1 1 auto;min-height:280px;';
  const canvas = doc.createElement('canvas');
  canvas.dataset.gpuDemoCanvas = '';
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', '3D preview. Drag to orbit; Shift-drag or middle/right-drag to pan; wheel to zoom; click to select.');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:grab;';
  const fallback = doc.createElement('div');
  fallback.dataset.gpuDemoFallback = '';
  fallback.setAttribute('role', 'status');
  fallback.setAttribute('aria-live', 'polite');
  fallback.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;background:#111827;pointer-events:none;';
  const footer = doc.createElement('div');
  footer.style.cssText = 'padding:8px 10px;display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:#cbd5e1;';
  const help = doc.createElement('span');
  help.textContent = 'Left drag: orbit · Shift / middle / right drag: pan · Wheel: zoom · Click: select';
  const selectionLabel = doc.createElement('span');
  selectionLabel.dataset.gpuDemoSelection = '';
  selectionLabel.setAttribute('role', 'status');
  selectionLabel.setAttribute('aria-live', 'polite');
  footer.append(help, selectionLabel);
  stage.append(canvas, fallback);
  root.append(toolbar, stage, footer);
  container.append(root);

  const meshes = createDemoMeshes(), bounds = meshBounds(meshes);
  let camera = fitCamera(createCamera3d(), bounds, canvas.getBoundingClientRect().width / Math.max(1, canvas.getBoundingClientRect().height));
  let selected: Pick3d | null = null;
  let disposed = false, error: string | null = null, frames = 0, dpr = 1;
  let device: GpuDevice | null = null, resources: Resources | null = null, capabilities: GpuCapabilities | null = null;
  let pendingFrame: number | null = null;
  let drag: { id: number; x: number; y: number; startX: number; startY: number; pan: boolean; moved: boolean; button: number } | null = null;
  const removeListeners: (() => void)[] = [];
  const buttons: HTMLButtonElement[] = [];
  function listen(target: EventTarget, type: string, handler: EventListener, options?: AddEventListenerOptions): void {
    target.addEventListener(type, handler, options);
    removeListeners.push(() => target.removeEventListener(type, handler, options));
  }
  function button(label: string, action: () => void): HTMLButtonElement {
    const item = doc.createElement('button');
    item.type = 'button';
    item.textContent = label;
    item.style.cssText = 'border:1px solid #64748b;border-radius:5px;background:#1e293b;color:#e5e7eb;padding:6px 10px;cursor:pointer;';
    listen(item, 'click', action);
    buttons.push(item);
    toolbar.append(item);
    return item;
  }
  const perspectiveButton = button('Perspective', () => setProjection('perspective'));
  const orthographicButton = button('Orthographic', () => setProjection('orthographic'));
  button('Fit', fit);
  button('Reset', () => {
    if (disposed) return;
    const rect = canvas.getBoundingClientRect();
    camera = fitCamera(createCamera3d(), bounds, rect.width / Math.max(1, rect.height));
    selected = null;
    updateUi();
    schedule();
  });

  function currentState(): GpuDeviceState {
    return disposed ? 'disposed' : error ? 'failed' : device?.state ?? 'failed';
  }
  function updateUi(): void {
    const state = currentState(), ready = state === 'ready';
    root.dataset.state = state;
    perspectiveButton.setAttribute('aria-pressed', String(camera.projection === 'perspective'));
    orthographicButton.setAttribute('aria-pressed', String(camera.projection === 'orthographic'));
    for (const item of buttons) { item.disabled = !ready; item.style.opacity = ready ? '1' : '0.5'; }
    canvas.setAttribute('aria-disabled', String(!ready));
    canvas.style.visibility = ready ? 'visible' : 'hidden';
    fallback.style.display = ready ? 'none' : 'flex';
    fallback.textContent = state === 'lost'
      ? 'The GPU context was lost. The demo will resume when the browser restores it.'
      : state === 'disposed' ? 'The 3D demo is closed.'
      : error ?? 'WebGL2 is unavailable. The 3D demo is disabled on this device.';
    selectionLabel.textContent = `Selected: ${selected?.name ?? 'none'} · ${camera.projection === 'perspective' ? 'Perspective' : 'Orthographic'}`;
  }
  function cancelFrame(): void {
    if (pendingFrame !== null) view!.cancelAnimationFrame(pendingFrame);
    pendingFrame = null;
  }
  function clearDrag(): void {
    const previous = drag;
    drag = null;
    if (previous && canvas.hasPointerCapture(previous.id)) canvas.releasePointerCapture(previous.id);
    canvas.style.cursor = 'grab';
  }
  function fail(reason: string): void {
    error = reason;
    resources = null;
    cancelFrame();
    clearDrag();
    // Dispose even partially uploaded resources. Keep the visible explanation until unmount.
    device?.dispose();
    updateUi();
  }
  function rebuild(): void {
    if (!device || device.state !== 'ready' || disposed) return;
    try {
      const gl = device.gl;
      const program = device.createProgram(VERTEX_SHADER, FRAGMENT_SHADER);
      const uniform = (name: string): WebGLUniformLocation => {
        const location = gl.getUniformLocation(program, name);
        if (location === null) throw new Error(`Missing shader uniform ${name}`);
        return location;
      };
      const gridPositions = createGrid();
      const axes = new Float32Array([-8, 0, 0, 8, 0, 0, 0, 0, -8, 0, 0, 8]);
      const lines = new Float32Array(gridPositions.length + axes.length);
      lines.set(gridPositions);
      lines.set(axes, gridPositions.length);
      const grid = new Float32Array(lines.length * 2);
      for (let i = 0; i < lines.length / 3; i++) {
        grid.set(lines.subarray(i * 3, i * 3 + 3), i * 6);
        grid[i * 6 + 4] = 1;
      }
      resources = {
        program, viewProjection: uniform('uViewProjection'), eye: uniform('uEye'), color: uniform('uColor'),
        unlit: uniform('uUnlit'), selected: uniform('uSelected'),
        meshes: meshes.map(mesh => ({ mesh, buffer: device!.createBuffer(triangleVertices(mesh)), vertices: mesh.indices.length })),
        grid: device.createBuffer(grid), gridVertices: gridPositions.length / 3,
      };
      capabilities = device.capabilities();
      error = null;
      updateUi();
      schedule();
    } catch {
      if (currentState() === 'lost') { resources = null; updateUi(); }
      else fail('The GPU could not initialize the 3D demo. Close the demo and try again.');
    }
  }
  function stateChanged(): void {
    if (disposed || !device) return;
    cancelFrame();
    clearDrag();
    resources = null;
    capabilities = null;
    if (device.state === 'ready') rebuild();
    else updateUi();
  }
  function schedule(): void {
    if (pendingFrame !== null || currentState() !== 'ready' || !resources) return;
    pendingFrame = view!.requestAnimationFrame(() => {
      pendingFrame = null;
      draw();
    });
  }
  function draw(): void {
    if (currentState() !== 'ready' || !device || !resources) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    try {
      const gl = device.gl, r = resources;
      if (gl.isContextLost()) return; // The device callback supplies the visible lost state.
      dpr = Math.min(2, Math.max(1, view!.devicePixelRatio || 1));
      const limits = capabilities?.maxViewportDims;
      const ratio = Math.min(dpr, (limits?.[0] ?? 4096) / rect.width, (limits?.[1] ?? 4096) / rect.height);
      const width = Math.max(1, Math.round(rect.width * ratio)), height = Math.max(1, Math.round(rect.height * ratio));
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      gl.viewport(0, 0, width, height);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      gl.clearColor(0.065, 0.09, 0.14, 1);
      gl.clearDepth(1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(r.program);
      gl.uniformMatrix4fv(r.viewProjection, false, cameraMatrices(camera, rect.width / rect.height).viewProjection);
      gl.uniform3f(r.eye, ...cameraBasis(camera).eye);
      const bind = (buffer: WebGLBuffer) => {
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.enableVertexAttribArray(0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      };
      gl.uniform1i(r.unlit, 0);
      for (const item of r.meshes) {
        bind(item.buffer);
        gl.uniform3f(r.color, ...item.mesh.color);
        gl.uniform1i(r.selected, selected?.id === item.mesh.id ? 1 : 0);
        gl.drawArrays(gl.TRIANGLES, 0, item.vertices);
      }
      bind(r.grid);
      gl.uniform1i(r.unlit, 1);
      gl.uniform1i(r.selected, 0);
      gl.uniform3f(r.color, 0.24, 0.29, 0.38);
      gl.drawArrays(gl.LINES, 0, r.gridVertices);
      gl.uniform3f(r.color, 0.75, 0.30, 0.30);
      gl.drawArrays(gl.LINES, r.gridVertices, 2);
      gl.uniform3f(r.color, 0.30, 0.49, 0.85);
      gl.drawArrays(gl.LINES, r.gridVertices + 2, 2);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gl.useProgram(null);
      if (gl.getError() !== gl.NO_ERROR && !gl.isContextLost()) throw new Error('GPU draw failed');
      frames++;
    } catch {
      if (device.state !== 'lost') fail('The GPU could not render the 3D demo. Close the demo and try again.');
    }
  }
  function setProjection(projection: Projection3d): void {
    if (disposed) return;
    if (projection !== 'perspective' && projection !== 'orthographic') throw new RangeError('Unknown 3D projection.');
    camera = setCameraProjection(camera, projection);
    updateUi();
    schedule();
  }
  function fit(): void {
    if (disposed) return;
    const rect = canvas.getBoundingClientRect();
    camera = fitCamera(camera, bounds, rect.width / Math.max(1, rect.height));
    updateUi();
    schedule();
  }
  function pick(x: number, y: number): Pick3d | null {
    if (currentState() !== 'ready') return null;
    const rect = canvas.getBoundingClientRect();
    const ray = cameraRay(camera, x, y, rect.width, rect.height);
    if (!ray) return null;
    selected = pickMeshes(meshes, ray);
    updateUi();
    schedule();
    return selected ? { ...selected, point: [...selected.point] } : null;
  }
  const pointerDown = (event: Event): void => {
    const e = event as PointerEvent;
    if (currentState() !== 'ready' || drag || ![0, 1, 2].includes(e.button)) return;
    e.preventDefault();
    canvas.focus({ preventScroll: true });
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY,
      pan: e.button !== 0 || e.shiftKey, moved: false, button: e.button };
    canvas.setPointerCapture(e.pointerId);
  };
  const pointerMove = (event: Event): void => {
    const e = event as PointerEvent;
    if (!drag || drag.id !== e.pointerId || currentState() !== 'ready') return;
    e.preventDefault();
    // A click must not nudge the camera before picking; start movement after a small threshold.
    if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 4) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.moved = true;
    const pan = drag.pan || e.shiftKey;
    camera = pan ? panCamera(camera, dx, dy, canvas.getBoundingClientRect().height) : orbitCamera(camera, dx, dy);
    drag.x = e.clientX;
    drag.y = e.clientY;
    canvas.style.cursor = pan ? 'move' : 'grabbing';
    schedule();
  };
  const pointerUp = (event: Event): void => {
    const e = event as PointerEvent;
    if (!drag || drag.id !== e.pointerId) return;
    const click = !drag.moved && drag.button === 0 && !drag.pan && !e.shiftKey
      && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 4;
    clearDrag();
    if (click) {
      const rect = canvas.getBoundingClientRect();
      pick(e.clientX - rect.left, e.clientY - rect.top);
    }
  };
  listen(canvas, 'pointerdown', pointerDown);
  listen(canvas, 'pointermove', pointerMove);
  listen(canvas, 'pointerup', pointerUp);
  listen(canvas, 'pointercancel', clearDrag);
  listen(canvas, 'lostpointercapture', clearDrag);
  listen(canvas, 'contextmenu', e => e.preventDefault());
  listen(canvas, 'wheel', event => {
    if (currentState() !== 'ready') return;
    const e = event as WheelEvent;
    e.preventDefault();
    const units = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.getBoundingClientRect().height : 1;
    camera = zoomCamera(camera, e.deltaY * units);
    schedule();
  }, { passive: false });
  listen(view, 'resize', schedule);
  listen(view, 'blur', clearDrag);
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
  observer?.observe(stage);
  try {
    device = new GpuDevice(canvas, stateChanged);
    if (device.state === 'ready') rebuild();
    else updateUi();
  } catch { fail('WebGL2 is unavailable. The 3D demo is disabled on this device.'); }

  return {
    setProjection, fit, pick,
    status(): GpuDemoStatus {
      const rect = canvas.getBoundingClientRect();
      return {
        state: currentState(), deviceState: device?.state ?? (disposed ? 'disposed' : 'failed'),
        selected: selected?.id ?? null, selection: selected ? { ...selected, point: [...selected.point] } : null,
        projection: camera.projection, camera: { ...camera, target: [...camera.target] }, frames, error,
        capabilities: capabilities ? { ...capabilities, maxViewportDims: capabilities.maxViewportDims ? [...capabilities.maxViewportDims] : null } : null,
        viewport: { width: rect.width, height: rect.height, pixelWidth: canvas.width, pixelHeight: canvas.height, dpr },
        objects: meshes.map(m => ({ id: m.id, name: m.name, triangles: m.indices.length / 3,
          screen: projectToScreen(camera, scale3(add3(m.bounds.min, m.bounds.max), 0.5), rect.width, rect.height) })),
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelFrame();
      clearDrag();
      observer?.disconnect();
      for (const remove of removeListeners) remove();
      removeListeners.length = 0;
      resources = null;
      capabilities = null;
      device?.dispose();
      root.remove();
    },
  };
}
