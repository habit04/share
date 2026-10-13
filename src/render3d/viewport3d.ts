/**
 * Viewport3D: the experimental WebGL2 viewport for model space (a sibling of the 2D Canvas
 * `Viewport`, never a replacement; paper space always stays 2D).
 *
 * It draws, in this order: the background (the 2D background colour setting), solids (flat
 * shaded, selection tinted, hover lightened), their feature edges (selected solids also show
 * hidden edges faintly), the 2D drawing as an underlay on z = 0 (through the SceneSink adapter),
 * the XY grid at z = 0 (2D grid spacing, adaptive, fading toward its edge) with the world axes,
 * and a WCS axis triad in the lower-left corner (X red, Y green, Z blue). All lines are one
 * device pixel wide (WebGL line width).
 *
 * Coordinates: CSS pixels for every public screen position (origin top-left, y down), like the 2D
 * viewport; the backing store has devicePixelRatio device pixels per CSS pixel (`backingSize`).
 * The camera is `camera` (src/render3d/camera.ts); in orthographic mode it is moved back before
 * each frame and pick so no geometry lies behind the eye plane (`withOrthoClearance`).
 *
 * Picking: `pick` reads the GPU id buffer under the cursor (one colour per solid, rendered on
 * demand into an offscreen framebuffer and reused while the camera and model are unchanged) and
 * falls back to `pickExact` (CPU ray casting, src/render3d/picking.ts) when read-back fails. Both
 * sample the centre of the device pixel under the cursor, so they agree.
 *
 * True 3D dimensions (DIM3D, docs/3D-DIMENSIONS.md) are drawn through the line batch with the 2D
 * dimension colours (src/render3d/dimension3d-scene.ts), selection-tinted and hover-lightened like
 * solid edges, after the solids (depth-tested, so a solid in front hides them). `pick` tries them
 * first on the CPU: the dimension with a display segment within `dimensionAperture` CSS px of the
 * cursor wins over the solid under it; the id buffer holds solids only. Rubber-band dimensions of a
 * running DIM3D (`Viewport3DOverlay.previewDimensions`) are drawn the same way but never picked.
 */
import type { Drawing, DrawingState } from '../core/document';
import { backingSize } from '../render/viewport';
import { type Aabb, type Mat4, type Ray, type Vec3, aabbUnion, mat4LookAt, mat4Multiply, mat4Orthographic, scale3, sub3, v3 } from '../model3d/math';
import { model3dOf } from '../model3d/model';
import { meshBounds } from '../model3d/mesh';
import type { Dimension3D, Solid3D } from '../model3d/types';
import {
  type Camera3D, cameraBasis, cameraProjection, cameraViewRelative, clipRange, defaultCamera, eyeDirection, orbit, pan, projectToScreen,
  rayFromScreen, viewHeightAtTarget, withOrthoClearance, zoom, zoomToBounds,
} from './camera';
import { GpuDevice } from './gl/device';
import { ATTR_COLOR, ATTR_POSITION, MeshBufferCache, type Programs, createPrograms, decodePickId, encodePickId } from './gl/programs';
import { type PickHit, pickSolids } from './picking';
import { type GridSpec, type Rgba, LineBatchBuilder, gridLines, gridSpec, parseCssColor, solidDisplayColor } from './scene-data';
import { emitDrawingUnderlay, hiddenLayerNames } from './scene-sink';
import { dimension3dGeometry, pickDimension3D, visibleDimensions3D } from './dimension3d-scene';
import { GRIP_EDGE_RGBA, GRIP_FILL_RGBA, type MarkerKind, SNAP_MARKER_RGBA, type Segment2, gripSegments, markerSegments } from './markers';

/** What changes between frames without changing the document. */
export interface Viewport3DOverlay {
  /** Selected object ids (solids are highlighted; 2D ids are ignored here). */
  readonly selection: ReadonlySet<string>;
  /** Solid under the cursor (rollover highlight). */
  readonly hover: string | null;
  /**
   * Solids a running 3D command is building (not in the document): drawn as translucent ghosts
   * with their edges, never picked. Absent = none.
   */
  readonly previewSolids?: readonly Solid3D[];
  /**
   * Grip points (world) drawn as small filled squares like the 2D grips (milestone 4: the corners
   * and centre of a single selected solid). Absent = none.
   */
  readonly grips3d?: readonly Vec3[];
  /** Half-size of a grip square in CSS px (the 2D GRIPSIZE setting; default 4). */
  readonly gripSize?: number;
  /** The 3D object snap under the cursor: the 2D snap marker shape is drawn at its projection. */
  readonly snap3d?: { readonly point: Vec3; readonly kind: MarkerKind } | null;
  /** 3D dimensions a running DIM3D is placing (not in the document): drawn, never picked. Absent = none. */
  readonly previewDimensions?: readonly Dimension3D[];
}

export interface Viewport3DSettings {
  /** CSS colour of the background (the 2D model background setting). */
  background: string;
  gridVisible: boolean;
  /** Minor grid spacing in drawing units before adaptive coarsening (the 2D grid spacing). */
  gridSize: number;
}

interface LineBatchGpu {
  readonly vao: WebGLVertexArrayObject;
  readonly vbo: WebGLBuffer;
  readonly count: number;
  readonly origin: Vec3;
  readonly bounds: Aabb | null;
}

const SELECT_RGB: Rgba = [0.25, 0.55, 1, 1];
const SELECT_EDGE: Rgba = [0.5, 0.8, 1, 1];
const HOVER_EDGE: Rgba = [1, 1, 1, 0.9];
const AMBIENT = 0.35;
/** Ghost (preview) solids: face opacity and edge colour. */
const GHOST_ALPHA = 0.3;
const GHOST_EDGE: Rgba = [1, 0.85, 0.35, 0.9];
/** Corner triad size in CSS pixels. */
const TRIAD_PX = 76;

export class Viewport3D {
  readonly canvas: HTMLCanvasElement;
  readonly device: GpuDevice;
  camera: Camera3D = defaultCamera();
  settings: Viewport3DSettings = { background: '#212830', gridVisible: true, gridSize: 0.5 };
  /** CSS size and devicePixelRatio (set by `resize`). */
  width = 1;
  height = 1;
  dpr = 1;
  /** False forces `pick` onto the CPU path (diagnostics and tests). */
  gpuPicking = true;
  /** Which path answered the last `pick` call. */
  lastPickPath: 'gpu' | 'cpu' | null = null;
  /** Called after every rendered frame (view label updates). */
  onRendered: (() => void) | null = null;
  /** Pick aperture for 3D dimensions in CSS px (the 2D pick box; set by the owner). */
  dimensionAperture = 4;

  private programs: Programs;
  private readonly meshes: MeshBufferCache;
  private underlay: { entities: DrawingState['entities']; layers: DrawingState['layers']; blocks: DrawingState['blocks']; batch: LineBatchGpu | null } | null = null;
  /** The 3D dimensions' line batch, rebuilt when the dimensions, layers, selection or hover change. */
  private dims: { key: string; source: readonly Dimension3D[] | undefined; layers: DrawingState['layers']; batch: LineBatchGpu | null } | null = null;
  private grid: { key: string; spec: GridSpec; batch: LineBatchGpu | null } | null = null;
  private triad: LineBatchGpu | null = null;
  /** Reused buffer of the screen-space marks (grips, snap marker); rebuilt after a context loss. */
  private marks: { readonly vao: WebGLVertexArrayObject; readonly vbo: WebGLBuffer } | null = null;
  private idTarget: { fbo: WebGLFramebuffer; color: WebGLRenderbuffer; depth: WebGLRenderbuffer; w: number; h: number; ok: boolean } | null = null;
  private idKey: { cam: string; model: unknown; layers: unknown } | null = null;
  private idSolids: readonly Solid3D[] = [];
  private raf = 0;
  private prunedModel: unknown = null;
  private prunedGhosts: readonly Solid3D[] | undefined = undefined;
  private lastOverlay: Viewport3DOverlay = { selection: new Set(), hover: null };

  /** Creates the WebGL2 context; throws GpuUnavailableError when WebGL2 is unavailable. */
  constructor(canvas: HTMLCanvasElement, private readonly doc: Drawing) {
    this.canvas = canvas;
    this.device = new GpuDevice(canvas);
    try {
      this.programs = createPrograms(this.device);
      this.meshes = new MeshBufferCache(this.device);
    } catch (err) {
      // Do not leak a context per failed attempt: release it before reporting.
      this.releaseContext();
      throw err;
    }
    this.device.onLost = () => {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
    };
    this.device.onRestored = () => {
      // Every GL object died with the old context: rebuild lazily from the document.
      try {
        this.programs = createPrograms(this.device);
      } catch (err) {
        this.fail(err);
        return;
      }
      this.meshes.reset();
      this.underlay = null;
      this.dims = null;
      this.grid = null;
      this.triad = null;
      this.marks = null;
      this.idTarget = null;
      this.idKey = null;
      this.requestRender(this.lastOverlay);
    };
  }

  /**
   * Called once when drawing fails (an exception in a frame or a failed context restore); the
   * viewport stops rendering afterwards. The owner should leave 3D mode and report the message.
   */
  onError: ((err: unknown) => void) | null = null;
  private failed = false;

  private fail(err: unknown): void {
    if (this.failed) return;
    this.failed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    const handler = this.onError;
    if (handler) handler(err);
    else console.error('3D viewport failed:', err);
  }

  private releaseContext(): void {
    this.device.dispose();
    // Free the GPU context now instead of waiting for garbage collection (browsers cap contexts).
    try {
      this.device.gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      /* already lost */
    }
  }

  /** Release the context (the canvas is discarded afterwards). */
  dispose(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.failed = true;
    this.releaseContext();
  }

  /** Read the canvas's CSS size and devicePixelRatio and size the backing store to match. */
  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    this.width = Math.max(1, Math.floor(rect.width));
    this.height = Math.max(1, Math.floor(rect.height));
    const size = backingSize(this.width, this.height, this.dpr);
    if (this.device.setBackingSize(size.width, size.height)) this.idKey = null;
  }

  /** Render on the next animation frame (several requests in one frame draw once). */
  requestRender(overlay: Viewport3DOverlay = this.lastOverlay): void {
    this.lastOverlay = overlay;
    if (this.raf || this.failed) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      try {
        this.render(this.lastOverlay);
      } catch (err) {
        this.fail(err);
      }
    });
  }

  // ------------------------------------------------------------------ navigation

  /** Zoom by `factor` (> 1 in) keeping the point under (sx, sy) fixed. */
  zoomAt(sx: number, sy: number, factor: number): void {
    this.prepareCamera();
    this.camera = zoom(this.camera, factor, rayFromScreen(this.camera, sx, sy, this.width, this.height));
  }

  /** Pan by a cursor drag of (dx, dy) CSS pixels. */
  panBy(dx: number, dy: number): void {
    this.camera = pan(this.camera, dx, dy, this.height);
  }

  /** Orbit by a cursor drag of (dx, dy) CSS pixels (about 0.5 degree per pixel). */
  orbitBy(dx: number, dy: number): void {
    const k = Math.PI / 360;
    this.camera = orbit(this.camera, -dx * k, dy * k);
  }

  /** Frame every visible solid and the 2D underlay. */
  zoomExtents(): void {
    const bounds = this.contentBounds();
    if (bounds) this.camera = zoomToBounds(this.camera, bounds, this.width / this.height);
  }

  /** Screen position (CSS px) of a world point, or null when it is behind a perspective eye. */
  toScreen(p: Vec3): { x: number; y: number } | null {
    this.prepareCamera();
    const W = this.canvas.width, H = this.canvas.height;
    const s = projectToScreen(this.camera, p, W, H);
    return s ? { x: s.x / this.dpr, y: s.y / this.dpr } : null;
  }

  /** The picking ray through the centre of the device pixel under CSS point (sx, sy). */
  pixelRay(sx: number, sy: number): Ray {
    this.prepareCamera();
    const { px, py } = this.devicePixel(sx, sy);
    return rayFromScreen(this.camera, px + 0.5, py + 0.5, this.canvas.width, this.canvas.height);
  }

  // ------------------------------------------------------------------ picking

  /**
   * Id of the object under (sx, sy) CSS px, or null: a visible 3D dimension within
   * `dimensionAperture` (CPU), else the front-most visible solid (GPU first, CPU fallback).
   */
  pick(sx: number, sy: number): string | null {
    const dim = this.pickDimension(sx, sy);
    if (dim) {
      this.lastPickPath = 'cpu';
      return dim;
    }
    const solids = this.visibleSolids(this.doc.snapshot);
    if (solids.length === 0) {
      this.lastPickPath = null;
      return null;
    }
    if (this.gpuPicking && !this.device.lost) {
      const id = this.gpuPick(sx, sy, solids);
      if (id !== undefined) {
        this.lastPickPath = 'gpu';
        return id;
      }
    }
    this.lastPickPath = 'cpu';
    return this.pickExact(sx, sy)?.id ?? null;
  }

  /** The visible 3D dimension with a display segment within `dimensionAperture` CSS px of (sx, sy), or null. */
  pickDimension(sx: number, sy: number): string | null {
    const state = this.doc.snapshot;
    const dims = visibleDimensions3D(state.model3d?.dimensions, state.layers);
    if (!dims.length) return null;
    this.prepareCamera();
    const W = this.canvas.width, H = this.canvas.height, cam = this.camera, dpr = this.dpr;
    const project = (p: Vec3) => {
      const s = projectToScreen(cam, p, W, H);
      return s ? { x: s.x / dpr, y: s.y / dpr } : null;
    };
    return pickDimension3D(dims, project, sx, sy, this.dimensionAperture, state.layers);
  }

  /** Exact CPU pick at the centre of the device pixel under (sx, sy): the nearest hit, or null. */
  pickExact(sx: number, sy: number): PickHit | null {
    const state = this.doc.snapshot;
    const hits = pickSolids(model3dOf(state), this.pixelRay(sx, sy), { hiddenLayers: hiddenLayerNames(state.layers) });
    return hits[0] ?? null;
  }

  private devicePixel(sx: number, sy: number): { px: number; py: number } {
    const W = this.canvas.width, H = this.canvas.height;
    return { px: Math.min(W - 1, Math.max(0, Math.floor(sx * this.dpr))), py: Math.min(H - 1, Math.max(0, Math.floor(sy * this.dpr))) };
  }

  /** GPU id-buffer pick; undefined when read-back is unavailable (caller falls back to the CPU). */
  private gpuPick(sx: number, sy: number, solids: readonly Solid3D[]): string | null | undefined {
    const gl = this.device.gl;
    try {
      this.prepareCamera();
      const state = this.doc.snapshot;
      const key = { cam: JSON.stringify([this.camera, this.canvas.width, this.canvas.height]), model: state.model3d, layers: state.layers };
      if (!this.idKey || this.idKey.cam !== key.cam || this.idKey.model !== key.model || this.idKey.layers !== key.layers) {
        if (!this.renderIds(solids)) return undefined;
        this.idKey = key;
      }
      const target = this.idTarget;
      if (!target?.ok) return undefined;
      const { px, py } = this.devicePixel(sx, sy);
      const out = new Uint8Array(4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.readPixels(px, target.h - 1 - py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (gl.getError() !== gl.NO_ERROR) return undefined;
      const index = decodePickId(out[0]!, out[1]!, out[2]!);
      if (index < 0) return null;
      return this.idSolids[index]?.id;
    } catch {
      return undefined;
    }
  }

  private ensureIdTarget(w: number, h: number): boolean {
    const gl = this.device.gl;
    if (this.idTarget && this.idTarget.w === w && this.idTarget.h === h) return this.idTarget.ok;
    if (this.idTarget) {
      gl.deleteFramebuffer(this.idTarget.fbo);
      gl.deleteRenderbuffer(this.idTarget.color);
      gl.deleteRenderbuffer(this.idTarget.depth);
      this.idTarget = null;
    }
    const fbo = gl.createFramebuffer(), color = gl.createRenderbuffer(), depth = gl.createRenderbuffer();
    if (!fbo || !color || !depth) return false;
    gl.bindRenderbuffer(gl.RENDERBUFFER, color);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, w, h);
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.idTarget = { fbo, color, depth, w, h, ok };
    return ok;
  }

  /** Draw every visible solid in its id colour into the offscreen target. */
  private renderIds(solids: readonly Solid3D[]): boolean {
    const gl = this.device.gl;
    const W = this.canvas.width, H = this.canvas.height;
    if (!this.ensureIdTarget(W, H)) return false;
    const cam = this.camera;
    const viewProj = this.viewProjection(this.sceneBounds(solids, this.gridFor(cam)));
    const p = this.programs.id;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.idTarget!.fbo);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(p.program);
    gl.uniformMatrix4fv(p.viewProj, false, Float32Array.from(viewProj));
    solids.forEach((s, i) => {
      const buf = this.meshes.get(s.mesh);
      const o = sub3(buf.origin, cam.target);
      gl.uniform3f(p.offset, o.x, o.y, o.z);
      gl.uniform4fv(p.id, encodePickId(i));
      gl.bindVertexArray(buf.vao);
      gl.drawArrays(gl.TRIANGLES, 0, buf.vertexCount);
    });
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.idSolids = solids;
    return gl.getError() === gl.NO_ERROR;
  }

  // ------------------------------------------------------------------ scene

  private visibleSolids(state: DrawingState): readonly Solid3D[] {
    const solids = model3dOf(state).solids;
    if (solids.length === 0) return solids;
    const hidden = hiddenLayerNames(state.layers);
    return hidden.size ? solids.filter((s) => !hidden.has(s.layer)) : solids;
  }

  /** Bounds of the visible solids, 3D dimensions and the 2D underlay (what ZOOM Extents frames). */
  contentBounds(): Aabb | null {
    const state = this.doc.snapshot;
    this.ensureUnderlay(state);
    this.ensureDimensions(state, this.lastOverlay);
    let box: Aabb | null = aabbUnion(this.underlay?.batch?.bounds ?? null, this.dims?.batch?.bounds ?? null);
    for (const s of this.visibleSolids(state)) box = aabbUnion(box, meshBounds(s.mesh));
    return box;
  }

  private sceneBounds(solids: readonly Solid3D[], grid: GridSpec | null): Aabb | null {
    let box: Aabb | null = aabbUnion(this.underlay?.batch?.bounds ?? null, this.dims?.batch?.bounds ?? null);
    for (const s of solids) box = aabbUnion(box, meshBounds(s.mesh));
    if (grid) box = aabbUnion(box, { min: v3(grid.center.x - grid.half, grid.center.y - grid.half, 0), max: v3(grid.center.x + grid.half, grid.center.y + grid.half, grid.half * 0.25) });
    return box;
  }

  /** Apply the orthographic eye clearance for the current scene (see the class comment). */
  private prepareCamera(): void {
    const state = this.doc.snapshot;
    this.ensureUnderlay(state);
    this.camera = withOrthoClearance(this.camera, this.sceneBounds(this.visibleSolids(state), this.gridFor(this.camera)));
  }

  private viewProjection(bounds: Aabb | null): Mat4 {
    const { near, far } = clipRange(this.camera, bounds);
    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    return mat4Multiply(cameraProjection(this.camera, aspect, near, far), cameraViewRelative(this.camera, this.camera.target));
  }

  /** Grid square for the camera: centred where the view axis meets z = 0 (else under the target). */
  private gridFor(cam: Camera3D): GridSpec | null {
    if (!this.settings.gridVisible) return null;
    const viewH = viewHeightAtTarget(cam);
    const b = cameraBasis(cam);
    let cx = cam.target.x, cy = cam.target.y;
    if (Math.abs(b.forward.z) > 1e-6) {
      const t = -b.eye.z / b.forward.z;
      if (t > 0 && Math.abs(t - cam.distance) < viewH * 4) {
        cx = b.eye.x + b.forward.x * t;
        cy = b.eye.y + b.forward.y * t;
      }
    }
    const span = Math.max(viewH, viewH * (this.width / this.height));
    return gridSpec(cx, cy, span * (cam.projection === 'perspective' ? 4 : 1.5), this.settings.gridSize, this.height / viewH);
  }

  private uploadLines(built: ReturnType<LineBatchBuilder['build']>): LineBatchGpu | null {
    if (built.vertexCount === 0) return null;
    const vbo = this.device.createBuffer(built.data);
    const vao = this.device.createVertexArray(vbo, [[ATTR_POSITION, 3], [ATTR_COLOR, 4]]);
    return { vao, vbo, count: built.vertexCount, origin: built.origin, bounds: built.bounds };
  }

  private deleteLines(b: LineBatchGpu | null | undefined): void {
    if (!b) return;
    this.device.gl.deleteVertexArray(b.vao);
    this.device.gl.deleteBuffer(b.vbo);
  }

  /** (Re)build the 2D underlay when the entities, layers or blocks changed. */
  private ensureUnderlay(state: DrawingState): void {
    const u = this.underlay;
    if (u && u.entities === state.entities && u.layers === state.layers && u.blocks === state.blocks) return;
    if (this.device.lost) return;
    const builder = new LineBatchBuilder();
    emitDrawingUnderlay(state, builder);
    this.deleteLines(u?.batch);
    this.underlay = { entities: state.entities, layers: state.layers, blocks: state.blocks, batch: this.uploadLines(builder.build()) };
  }

  /**
   * (Re)build the 3D dimensions' line batch when the dimensions, layers, or the selection / hover
   * among them changed. Selected dimensions are tinted like selected solid edges, the hovered one
   * lightened.
   */
  private ensureDimensions(state: DrawingState, ov: Viewport3DOverlay): void {
    const source = state.model3d?.dimensions;
    const dims = visibleDimensions3D(source, state.layers);
    const key = dims.length ? JSON.stringify([dims.filter((d) => ov.selection.has(d.id)).map((d) => d.id), dims.some((d) => d.id === ov.hover) ? ov.hover : null]) : '';
    const cur = this.dims;
    if (cur && cur.source === source && cur.layers === state.layers && cur.key === key) return;
    if (this.device.lost) return;
    const builder = new LineBatchBuilder();
    for (const d of dims) addDimensionLines(builder, d, state.layers, ov.selection.has(d.id) ? 'selected' : ov.hover === d.id ? 'hover' : 'plain');
    this.deleteLines(cur?.batch);
    this.dims = { key, source, layers: state.layers, batch: this.uploadLines(builder.build()) };
  }

  private ensureGrid(spec: GridSpec | null): void {
    if (!spec) return;
    const key = JSON.stringify(spec);
    if (this.grid?.key === key) return;
    this.deleteLines(this.grid?.batch);
    this.grid = { key, spec, batch: this.uploadLines(gridLines(spec)) };
  }

  private ensureTriad(): LineBatchGpu | null {
    if (this.triad) return this.triad;
    const b = new LineBatchBuilder();
    b.add(v3(0, 0, 0), v3(1, 0, 0), [0.95, 0.3, 0.3, 1]);
    b.add(v3(0, 0, 0), v3(0, 1, 0), [0.35, 0.9, 0.35, 1]);
    b.add(v3(0, 0, 0), v3(0, 0, 1), [0.4, 0.55, 1, 1]);
    this.triad = this.uploadLines(b.build());
    return this.triad;
  }

  // ------------------------------------------------------------------ frame

  /** Draw one frame now. */
  render(ov: Viewport3DOverlay): void {
    this.lastOverlay = ov;
    if (this.device.lost || this.failed) return;
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    if (dpr !== this.dpr) this.resize();
    const gl = this.device.gl;
    const state = this.doc.snapshot;
    this.meshes.frame += 1;
    const solids = this.visibleSolids(state);
    this.ensureUnderlay(state);
    this.ensureDimensions(state, ov);
    const spec = this.gridFor(this.camera);
    const ghosts = ov.previewSolids ?? [];
    const bounds = this.sceneBounds(ghosts.length ? [...solids, ...ghosts] : solids, spec);
    this.camera = withOrthoClearance(this.camera, bounds);
    const cam = this.camera;
    const viewProj = Float32Array.from(this.viewProjection(bounds));
    const W = this.canvas.width, H = this.canvas.height;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    const bg = parseCssColor(this.settings.background, [0.13, 0.16, 0.19, 1]);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);

    // Solids, pushed back slightly so edges and z = 0 lines on their faces win the depth test.
    const sp = this.programs.solid;
    gl.useProgram(sp.program);
    gl.uniformMatrix4fv(sp.viewProj, false, viewProj);
    const light = eyeDirection(cam);
    gl.uniform3f(sp.light, light.x, light.y, light.z);
    gl.uniform1f(sp.ambient, AMBIENT);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1, 1);
    const colors = new Map<Solid3D, Rgba>();
    for (const s of solids) {
      const buf = this.meshes.get(s.mesh);
      const base = parseCssColor(solidDisplayColor(s, state.layers));
      const selected = ov.selection.has(s.id), hovered = !selected && ov.hover === s.id;
      const c: Rgba = selected ? mix(base, SELECT_RGB, 0.5) : hovered ? mix(base, [1, 1, 1, 1], 0.3) : base;
      colors.set(s, base);
      const o = sub3(buf.origin, cam.target);
      gl.uniform3f(sp.offset, o.x, o.y, o.z);
      gl.uniform4f(sp.color, c[0], c[1], c[2], 1);
      gl.bindVertexArray(buf.vao);
      gl.drawArrays(gl.TRIANGLES, 0, buf.vertexCount);
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);

    // Lines: feature edges, then the 2D underlay and the grid.
    const lp = this.programs.line;
    gl.useProgram(lp.program);
    gl.uniformMatrix4fv(lp.viewProj, false, viewProj);
    gl.uniform2f(lp.fade, 0, 0);
    gl.uniform3f(lp.fadeCenter, 0, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const drawLines = (vao: WebGLVertexArrayObject, count: number, origin: Vec3, tint: Rgba): void => {
      const o = sub3(origin, cam.target);
      gl.uniform3f(lp.offset, o.x, o.y, o.z);
      gl.uniform4f(lp.tint, tint[0], tint[1], tint[2], tint[3]);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.LINES, 0, count);
    };
    for (const s of solids) {
      const buf = this.meshes.get(s.mesh);
      if (!buf.edgeVao) continue;
      const selected = ov.selection.has(s.id), hovered = !selected && ov.hover === s.id;
      const base = colors.get(s) ?? [1, 1, 1, 1];
      drawLines(buf.edgeVao, buf.edgeVertexCount, buf.origin, selected ? SELECT_EDGE : hovered ? HOVER_EDGE : [base[0] * 0.35, base[1] * 0.35, base[2] * 0.35, 1]);
    }
    // Hidden edges of selected solids, faint, through everything.
    gl.disable(gl.DEPTH_TEST);
    for (const s of solids) {
      if (!ov.selection.has(s.id)) continue;
      const buf = this.meshes.get(s.mesh);
      if (buf.edgeVao) drawLines(buf.edgeVao, buf.edgeVertexCount, buf.origin, [SELECT_EDGE[0], SELECT_EDGE[1], SELECT_EDGE[2], 0.3]);
    }
    gl.enable(gl.DEPTH_TEST);
    const under = this.underlay?.batch;
    if (under) drawLines(under.vao, under.count, under.origin, [1, 1, 1, 1]);
    const dimBatch = this.dims?.batch;
    if (dimBatch) drawLines(dimBatch.vao, dimBatch.count, dimBatch.origin, [1, 1, 1, 1]);
    this.ensureGrid(spec);
    if (spec && this.grid?.batch) {
      gl.depthMask(false);
      const fc = sub3(this.grid.spec.center, cam.target);
      gl.uniform3f(lp.fadeCenter, fc.x, fc.y, fc.z);
      gl.uniform2f(lp.fade, this.grid.spec.half * 0.55, this.grid.spec.half);
      drawLines(this.grid.batch.vao, this.grid.batch.count, this.grid.batch.origin, [1, 1, 1, 1]);
      gl.uniform2f(lp.fade, 0, 0);
      gl.depthMask(true);
    }

    // Ghosts of what a running 3D command builds: translucent faces, then bright edges on top.
    if (ghosts.length) {
      gl.depthMask(false);
      gl.useProgram(sp.program);
      for (const s of ghosts) {
        const buf = this.meshes.get(s.mesh);
        const c = parseCssColor(solidDisplayColor(s, state.layers));
        const o = sub3(buf.origin, cam.target);
        gl.uniform3f(sp.offset, o.x, o.y, o.z);
        gl.uniform4f(sp.color, c[0], c[1], c[2], GHOST_ALPHA);
        gl.bindVertexArray(buf.vao);
        gl.drawArrays(gl.TRIANGLES, 0, buf.vertexCount);
      }
      gl.useProgram(lp.program);
      gl.disable(gl.DEPTH_TEST);
      for (const s of ghosts) {
        const buf = this.meshes.get(s.mesh);
        if (buf.edgeVao) drawLines(buf.edgeVao, buf.edgeVertexCount, buf.origin, GHOST_EDGE);
      }
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
    }

    // Rubber-band dimensions of a running DIM3D: a small batch rebuilt per frame, on top.
    const previewDims = ov.previewDimensions ?? [];
    if (previewDims.length) {
      const pb = new LineBatchBuilder();
      for (const d of previewDims) addDimensionLines(pb, d, state.layers, 'plain');
      const built = pb.build();
      const gpu = this.uploadLines(built);
      if (gpu) {
        gl.disable(gl.DEPTH_TEST);
        drawLines(gpu.vao, gpu.count, gpu.origin, [1, 1, 1, 1]);
        gl.enable(gl.DEPTH_TEST);
        this.deleteLines(gpu);
      }
    }

    // Screen-space marks on top of everything: grips of the selected solid, the 3D snap marker.
    const grips = ov.grips3d ?? [];
    const snap = ov.snap3d ?? null;
    if (grips.length || snap) {
      const mb = new LineBatchBuilder();
      const add = (segs: readonly Segment2[], c: Rgba) => {
        for (const [x1, y1, x2, y2] of segs) mb.add(v3(x1, H - y1, 0), v3(x2, H - y2, 0), c);
      };
      const h = Math.max(1, Math.round((ov.gripSize ?? 4) * this.dpr));
      for (const gp of grips) {
        const s = projectToScreen(cam, gp, W, H);
        if (!s) continue;
        const gs = gripSegments(s.x, s.y, h);
        add(gs.fill, GRIP_FILL_RGBA);
        add(gs.edge, GRIP_EDGE_RGBA);
      }
      const s = snap ? projectToScreen(cam, snap.point, W, H) : null;
      if (snap && s) {
        const r = 7 * this.dpr;
        // Two nested outlines: the 2D marker is drawn two pixels wide.
        add(markerSegments(snap.kind, s.x, s.y, r), SNAP_MARKER_RGBA);
        add(markerSegments(snap.kind, s.x, s.y, r - this.dpr), SNAP_MARKER_RGBA);
      }
      const built = mb.build();
      if (built.vertexCount > 0) {
        // One persistent dynamic buffer for the marks, refilled each frame (no per-frame VAO / VBO).
        if (!this.marks) {
          const vbo = this.device.createBuffer(built.data, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
          this.marks = { vbo, vao: this.device.createVertexArray(vbo, [[ATTR_POSITION, 3], [ATTR_COLOR, 4]]) };
        } else {
          gl.bindBuffer(gl.ARRAY_BUFFER, this.marks.vbo);
          gl.bufferData(gl.ARRAY_BUFFER, built.data, gl.DYNAMIC_DRAW);
          gl.bindBuffer(gl.ARRAY_BUFFER, null);
        }
        gl.disable(gl.DEPTH_TEST);
        gl.useProgram(lp.program);
        gl.uniformMatrix4fv(lp.viewProj, false, Float32Array.from(mat4Orthographic(0, W, 0, H, -1, 1)));
        gl.uniform2f(lp.fade, 0, 0);
        gl.uniform3f(lp.offset, built.origin.x, built.origin.y, built.origin.z);
        gl.uniform4f(lp.tint, 1, 1, 1, 1);
        gl.bindVertexArray(this.marks.vao);
        gl.drawArrays(gl.LINES, 0, built.vertexCount);
        gl.bindVertexArray(null);
        gl.enable(gl.DEPTH_TEST);
      }
    }

    // WCS triad in the lower-left corner: orientation only, fixed size.
    const triad = this.ensureTriad();
    if (triad) {
      const size = Math.round(TRIAD_PX * this.dpr), pad = Math.round(10 * this.dpr);
      gl.viewport(pad, pad, size, size);
      gl.disable(gl.DEPTH_TEST);
      const b = cameraBasis(cam);
      const view = mat4LookAt(scale3(eyeDirection(cam), 3), v3(0, 0, 0), b.up);
      gl.uniformMatrix4fv(lp.viewProj, false, Float32Array.from(mat4Multiply(mat4Orthographic(-1.3, 1.3, -1.3, 1.3, 0.1, 10), view)));
      gl.uniform3f(lp.offset, triad.origin.x, triad.origin.y, triad.origin.z);
      gl.uniform4f(lp.tint, 1, 1, 1, 1);
      gl.bindVertexArray(triad.vao);
      gl.drawArrays(gl.LINES, 0, triad.count);
      gl.viewport(0, 0, W, H);
      gl.enable(gl.DEPTH_TEST);
    }
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    const model = model3dOf(state);
    if (model !== this.prunedModel) {
      // The model changed (edit, undo, another drawing): drop buffers of meshes it no longer has.
      this.prunedModel = model;
      this.meshes.prune(new Set([...model.solids, ...ghosts].map((s) => s.mesh)));
    }
    if (ov.previewSolids !== this.prunedGhosts) {
      // Ghosts change with every cursor move: drop the buffers of the previous ones right away.
      this.prunedGhosts = ov.previewSolids;
      this.meshes.prune(new Set([...model.solids, ...ghosts].map((s) => s.mesh)));
    }
    this.meshes.prune();
    if (t0) this.device.lastFrameMs = performance.now() - t0;
    this.onRendered?.();
  }
}

/** Add a 3D dimension's display segments to a line batch (2D dimension colours, or the selection / hover tint). */
function addDimensionLines(b: LineBatchBuilder, d: Dimension3D, layers: DrawingState['layers'], look: 'plain' | 'selected' | 'hover'): void {
  for (const s of dimension3dGeometry(d, d.style, layers)) {
    const base = parseCssColor(s.color);
    b.add(s.a, s.b, look === 'selected' ? SELECT_EDGE : look === 'hover' ? mix(base, [1, 1, 1, 1], 0.5) : base);
  }
}

function mix(a: Rgba, b: Rgba, t: number): Rgba {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
}
