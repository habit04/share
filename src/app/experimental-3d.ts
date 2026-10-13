/**
 * Wiring of the experimental 3D viewport (milestone 2 of docs/3D-PLAN.md).
 *
 * `installExperimental3d(editor)` does nothing at all unless `settings.experimental3d` was on when
 * the app started: then no command is registered, the ribbon is untouched, no canvas or WebGL
 * context is created (tests/experimental-3d-flag.test.ts guards this). With the flag on it
 * registers the 3D commands and appends the ribbon tab "3D"; the WebGL viewport itself is only
 * created when 3DMODE turns 3D mode on, and destroyed (context released) when it turns off.
 *
 * In 3D mode a second canvas covers the 2D one inside `.canvas-wrap` and takes the mouse:
 * wheel = zoom at the cursor, middle drag = pan, Shift + middle drag = orbit (AutoCAD), left drag
 * while 3DORBIT runs = orbit, left click = select the solid under the cursor (Shift adds, a click on
 * empty space clears), rollover highlight from the GPU pick. Paper-space layouts always stay 2D:
 * switching to a layout leaves 3D mode.
 *
 * Prototype-only: while a 2D drawing command runs in 3D mode, a left click hands the point where
 * the cursor ray meets z = 0 to the command as typed coordinates (no object snaps, no rubber band).
 *
 * Modelling (milestone 3, docs/3D-MODELLING.md): the commands BOX, WEDGE, CYLINDER, CONE, SPHERE,
 * TORUS, EXTRUDE, REVOLVE, UNION, SUBTRACT, INTERSECT and 3DPLANE (src/tools3d/). The controller
 * extends every tool context with the 3D members (src/tools3d/context.ts): the construction plane
 * (WCS XY whenever 3D mode is off), `point3` (in 3D mode a click or the cursor gives the solid face
 * under it, else the point on the construction plane), the kernel (created on first use, disposed
 * when 3D mode ends, when a command ends outside 3D mode, or when the window unloads) and ghost
 * solids drawn by the 3D viewport. In 3D mode a
 * click while "Select objects:" is pending picks the solid under the cursor, else the 2D object
 * where the cursor ray meets z = 0; typing ALL also takes the visible solids, and typing a solid's
 * id takes that solid.
 *
 * Editing (milestone 4, docs/3D-EDITING.md): 3DMOVE, 3DROTATE, 3DSCALE, 3DDIST, 3DMASSPROP, 3DAREA
 * and the 3DDIM prototype (src/tools3d/), the Edit and Measure ribbon panels, DIST measuring 3D
 * points while 3D mode is on, 3D object snaps (END / MID / CEN / NEA on the face under the cursor,
 * the 2D OSNAP toggles and aperture) for every point a 3D command receives, with the 2D marker
 * drawn at the snap, and grips on a single selected solid (dragging the centre grip moves it). In
 * 3D mode 2D commands also get cursor moves (their ghosts, and ghosts of selected solids for MOVE /
 * COPY / ROTATE / SCALE / MIRROR) and a click on a snapped solid point hands them its x, y.
 *
 * True 3D dimensions (docs/3D-DIMENSIONS.md): DIM3D (src/tools3d/dimension3d-tool.ts) adds them to
 * `model3d.dimensions`; the 3D view draws them (and DIM3D's rubber band, `previewDimensions`),
 * picks them by their display segments within the 2D pick box (a click selects one, the hover
 * highlights it), ALL and a typed id select them like solids, and ERASE, 3DMOVE / 3DROTATE /
 * 3DSCALE and the 2D modify commands carry them along with solids.
 */
import type { Editor } from './editor';
import type { Tool, ToolContext } from '../tools/types';
import type { Point } from '../core/geometry';
import { GeometryBudgetError } from '../core/geometry-budget-error';
import { RIBBON, type RibbonTab } from '../ui/ribbon';
import { type Frame3, type Vec3, WORLD_XY_FRAME, intersectRayPlane, add3, len3, scale3, sub3, v3 } from '../model3d/math';
import { addSolids, dimensionById, model3dOf, newSolid, solidById, withModel3D } from '../model3d/model';
import { dimension3dLocation } from '../model3d/dimension3d';
import { primitiveMesh } from '../model3d/primitives';
import type { Dimension3D, PrimitiveFeature, Solid3D } from '../model3d/types';
import type { GeometryKernel } from '../model3d/kernel/kernel';
import { createDefaultKernel } from '../model3d/kernel/index';
import { Viewport3D } from '../render3d/viewport3d';
import { type ViewPresetName, VIEW_PRESETS, applyPreset, cameraFrom2D, matchingPreset, parseViewPreset, setProjection } from '../render3d/camera';
import type { PickHit } from '../render3d/picking';
import { hiddenLayerNames } from '../render3d/scene-sink';
import { pickEntity } from '../core/selection';
import { type Context3DSource, type Pick3, extendContext3d, planeLabel, worldToPlane } from '../tools3d/context';
import { Script3DTool } from '../tools3d/script3d';
import { boxTool, coneTool, cylinderTool, sphereTool, torusTool, wedgeTool } from '../tools3d/primitives';
import { extrudeTool, revolveTool } from '../tools3d/sweeps';
import { intersectTool, subtractTool, unionTool } from '../tools3d/booleans';
import { planeTool } from '../tools3d/plane';
import { move3dTool, rotate3dTool, scale3dTool } from '../tools3d/transform';
import { area3dTool, dist3dTool, massProp3dTool } from '../tools3d/measure';
import { dim3dTool } from '../tools3d/dim3d';
import { dimension3dTool } from '../tools3d/dimension3d-tool';
import { type Snap3DKind, snapPick3 } from '../tools3d/snap3d';
import { CENTER_GRIP, gripDragNormal, gripDragPoint, solidGrips } from '../tools3d/grips';
import { commitSolidEdit, ghostSolids, translationMatrix } from '../tools3d/solid-edit';
import { setSolidParameter } from '../tools3d/properties-edit';

/** The ribbon tab added when the flag is on (exported for tests; never in RIBBON when off). */
export const RIBBON_3D_TAB: RibbonTab = {
  name: '3D',
  panels: [
    {
      title: 'Modelling',
      buttons: [
        { label: 'Box', icon: 'rectangle', command: 'BOX', size: 'large', tooltip: 'Solid box: first corner, other corner, height (BOX)' },
        { label: 'Wedge', icon: 'polygon', command: 'WEDGE', size: 'small', tooltip: 'Solid wedge: first corner, other corner, height (WEDGE)' },
        { label: 'Cylinder', icon: 'circle', command: 'CYLINDER', size: 'small', tooltip: 'Solid cylinder: base center, radius, height (CYLINDER)' },
        { label: 'Cone', icon: 'point', command: 'CONE', size: 'small', tooltip: 'Solid cone or frustum: base center, radius, height, top radius (CONE)' },
        { label: 'Sphere', icon: 'ellipse', command: 'SPHERE', size: 'small', tooltip: 'Solid sphere: center, radius (SPHERE)' },
        { label: 'Torus', icon: 'donut', command: 'TORUS', size: 'small', tooltip: 'Solid torus: center, radius, tube radius (TORUS)' },
        { label: 'Extrude', icon: 'extend', command: 'EXTRUDE', size: 'large', tooltip: 'Extrude closed 2D objects into a solid (EXTRUDE)' },
        { label: 'Revolve', icon: 'rotate', command: 'REVOLVE', size: 'large', tooltip: 'Revolve closed 2D objects about an axis (REVOLVE)' },
      ],
    },
    {
      title: 'Edit',
      buttons: [
        { label: '3D Move', icon: 'move', command: '3DMOVE', size: 'large', tooltip: 'Move solids by a base point and a second point or a typed displacement (3DMOVE)' },
        { label: '3D Rotate', icon: 'rotate', command: '3DROTATE', size: 'small', tooltip: 'Rotate solids about an X / Y / Z axis of the construction plane or two points (3DROTATE)' },
        { label: '3D Scale', icon: 'scale', command: '3DSCALE', size: 'small', tooltip: 'Scale solids uniformly about a base point (3DSCALE)' },
      ],
    },
    {
      title: 'Boolean',
      buttons: [
        { label: 'Union', icon: 'join', command: 'UNION', size: 'small', tooltip: 'Join solids into one (UNION)' },
        { label: 'Subtract', icon: 'trim', command: 'SUBTRACT', size: 'small', tooltip: 'Subtract solids from others (SUBTRACT)' },
        { label: 'Intersect', icon: 'area', command: 'INTERSECT', size: 'small', tooltip: 'Keep the common volume of solids (INTERSECT)' },
      ],
    },
    {
      title: 'Plane',
      buttons: [{ label: 'Plane', icon: 'grid', command: '3DPLANE', size: 'large', tooltip: 'Construction plane: World, Top (XY), Front (XZ), Right (YZ), Solid face or Origin (3DPLANE)' }],
    },
    {
      title: 'View',
      buttons: [
        { label: 'Top', icon: 'view', command: '3DVIEW top', size: 'small', tooltip: 'Top view (3DVIEW top)' },
        { label: 'Front', icon: 'view', command: '3DVIEW front', size: 'small', tooltip: 'Front view (3DVIEW front)' },
        { label: 'Right', icon: 'view', command: '3DVIEW right', size: 'small', tooltip: 'Right view (3DVIEW right)' },
        { label: 'SW Iso', icon: 'view', command: '3DVIEW swiso', size: 'small', tooltip: 'SW isometric view (3DVIEW swiso)' },
        { label: 'SE Iso', icon: 'view', command: '3DVIEW seiso', size: 'small', tooltip: 'SE isometric view (3DVIEW seiso)' },
        { label: 'Perspective', icon: 'view', command: '3DPERSPECTIVE', size: 'small', tooltip: 'Toggle perspective / parallel projection (3DPERSPECTIVE)' },
        { label: 'Orbit', icon: 'orbit', command: '3DORBIT', size: 'small', tooltip: 'Orbit by dragging; Enter or Esc ends (3DORBIT)' },
        { label: 'Zoom Extents', icon: 'zoomext', command: '3DZOOMEXTENTS', size: 'small', tooltip: 'Zoom to the 3D model and the drawing (3DZOOMEXTENTS)' },
        { label: '3D Mode', icon: 'model', command: '3DMODE', size: 'large', tooltip: 'Switch model space between the 2D view and the experimental 3D viewport (3DMODE)' },
      ],
    },
    {
      title: 'Measure',
      buttons: [
        { label: '3D Distance', icon: 'dist', command: '3DDIST', size: 'small', tooltip: 'Distance, deltas and angles between two 3D points (3DDIST)' },
        { label: 'Mass Properties', icon: 'props', command: '3DMASSPROP', size: 'small', tooltip: 'Volume, surface area, bounding box and centroid of solids (3DMASSPROP)' },
        { label: 'Face Area', icon: 'area', command: '3DAREA', size: 'small', tooltip: 'Area and perimeter of a picked planar face (3DAREA)' },
        { label: '3D Dimension', icon: 'dimaligned', command: 'DIM3D', size: 'small', tooltip: 'True 3D dimension in its measurement plane: aligned, linear or angular [Plane: current / face / 3 points] (DIM3D)' },
        { label: 'Projected Dim', icon: 'dimaligned', command: '3DDIM', size: 'small', tooltip: 'Interim prototype: 2D aligned dimension of two 3D points projected onto the drawing plane, labelled "(projected)" when off it (3DDIM)' },
      ],
    },
    {
      title: 'Test',
      buttons: [{ label: '3D Demo', icon: 'bulb', command: '3DDEMO', size: 'large', tooltip: 'Development test scene: adds a box, a cylinder and a sphere (3DDEMO; Undo removes them)' }],
    },
  ],
};

/**
 * A point as typed absolute coordinates "x,y" the command line parser accepts (`parsePointInput`):
 * fixed decimals (the drawing precision, at least 8 so nothing visible is lost), never exponent
 * notation, and no "-0".
 */
export function typedCoordinate(p: { x: number; y: number }, precision = 8): string {
  const digits = Math.min(12, Math.max(8, Math.round(precision)));
  const f = (v: number): string => {
    const s = v.toFixed(digits);
    return Number(s) === 0 ? '0' : s.replace(/\.?0+$/, '');
  };
  return `${f(p.x)},${f(p.y)}`;
}

/** 3DORBIT: left drag orbits until Enter or Esc (the 3D canvas does the dragging). */
export class Orbit3DTool implements Tool {
  readonly name = '3DORBIT';
  start(ctx: ToolContext): void {
    ctx.prompt('Drag to orbit (Shift + middle drag also orbits). Press Esc or Enter to exit.');
  }
  onPoint(_p: Point, _ctx: ToolContext): void {}
  onMove(_p: Point, _ctx: ToolContext): void {}
  onText(_t: string, _ctx: ToolContext): void {}
  onEnter(ctx: ToolContext): void {
    ctx.finish();
  }
  onCancel(ctx: ToolContext): void {
    ctx.finish();
  }
}

type Drag = { mode: 'pan' | 'orbit' | 'click' | 'grip'; last: { x: number; y: number }; start: { x: number; y: number }; shift: boolean };

/**
 * A centre-grip drag in progress: the solid, the grip, the drag plane normal and where the cursor
 * ray met the drag plane when the drag started (the solid moves by the cursor's motion on it).
 */
interface GripDrag {
  readonly solid: Solid3D;
  readonly grip: Vec3;
  readonly normal: Vec3;
  readonly start: Vec3;
}

/** State and behaviour of 3D mode for one editor (also the `window.jcad3d` debug handle). */
export class Experimental3d {
  viewport: Viewport3D | null = null;
  hover: string | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private label: HTMLElement | null = null;
  private drag: Drag | null = null;
  private unsubscribe: Array<() => void> = [];
  private detachInput: (() => void) | null = null;
  private lastMiddle = 0;
  private statusEl: HTMLElement | null = null;
  /** The construction plane set by 3DPLANE (session state; used while 3D mode is on). */
  private plane: Frame3 = WORLD_XY_FRAME;
  private planeNameValue = 'World';
  private kernelInstance: GeometryKernel | null = null;
  /** Ghost solids of the running 3D command. */
  previewSolids: readonly Solid3D[] = [];
  /** Rubber-band 3D dimensions of a running DIM3D. */
  previewDimensions: readonly Dimension3D[] = [];
  /** The 3D pick of the click / cursor move being handed to a 3D command (set only during that call). */
  private clickPick: Pick3 | null = null;
  private cursorPick: Pick3 | null = null;
  /** The 3D object snap under the cursor (drawn as the 2D marker), if any. */
  snapMarker: { point: Vec3; kind: Snap3DKind } | null = null;
  private gripDrag: GripDrag | null = null;
  /** Makes the geometry kernel on first use (tests may replace it). */
  kernelFactory: () => GeometryKernel = createDefaultKernel;

  constructor(readonly editor: Editor) {}

  /** True while model space is shown by the 3D viewport. */
  get active(): boolean {
    return this.viewport !== null;
  }

  // ---------------------------------------------------------------- 3D tool context

  /** The construction plane 3D commands use now: the 3DPLANE setting in 3D mode, else WCS XY. */
  get constructionPlane(): Frame3 {
    return this.active ? this.plane : WORLD_XY_FRAME;
  }

  /** Name of the plane in effect ("World", "XY", "XZ", "YZ", "Face"). */
  get constructionPlaneName(): string {
    return this.active ? this.planeNameValue : 'World';
  }

  /** Status text for the plane in effect, e.g. "XZ @ 0,0,5". */
  get planeText(): string {
    return planeLabel(this.constructionPlaneName, this.constructionPlane);
  }

  /** 3DPLANE: make `frame` the construction plane. */
  setConstructionPlane(frame: Frame3, name: string): void {
    this.plane = frame;
    this.planeNameValue = name;
    if (!this.active && name !== 'World') this.editor.log('The construction plane applies in 3D mode (3DMODE); the 2D view always uses the WCS XY plane.');
    this.updateLabel();
    this.render();
  }

  /** The geometry kernel, created on first use. */
  kernel(): GeometryKernel {
    this.kernelInstance ??= this.kernelFactory();
    return this.kernelInstance;
  }

  /** Release the kernel (worker and WebAssembly memory); the next Boolean starts a new one. */
  disposeKernel(): void {
    this.kernelInstance?.dispose();
    this.kernelInstance = null;
  }

  /** True when a kernel has been created and not disposed. */
  get kernelStarted(): boolean {
    return this.kernelInstance !== null;
  }

  /** Ghost solids for the 3D view ([] clears). */
  setPreview3d(solids: readonly Solid3D[]): void {
    // Nothing draws ghosts outside 3D mode: keep none.
    if (!this.active) solids = [];
    if (solids.length === 0 && this.previewSolids.length === 0) return;
    this.previewSolids = solids;
    this.render();
  }

  /** Rubber-band 3D dimensions for the 3D view ([] clears; none outside 3D mode). */
  setPreviewDimensions3d(dims: readonly Dimension3D[]): void {
    if (!this.active) dims = [];
    if (dims.length === 0 && this.previewDimensions.length === 0) return;
    this.previewDimensions = dims;
    this.render();
  }

  /**
   * The 3D pick of the click or cursor move being handed to the tool right now (`deliverClick`,
   * `deliverMove`); null at any other time, so typed points never pick up a 3D hit. The point
   * argument is not compared: the pick exists only while the tool handles that very input.
   */
  pickAt(_p: Point): Pick3 | null {
    return this.clickPick ?? this.cursorPick;
  }

  /**
   * Give a running 3D command a click: echo the plane coordinates on the command line, hand the
   * point over directly (`Editor.acceptPoint`, no typed-input round trip) with the exact 3D pick
   * available to `point3` / `ray3` / `face3` for exactly that call. Afterwards the editor's last
   * point is the picked point's world x, y (what the 2D status bar and 2D commands read).
   */
  deliverClick(pick: Pick3): void {
    const ed = this.editor;
    if (!(ed.tool instanceof Script3DTool)) return;
    ed.log(`${ed.prompt} ${typedCoordinate(pick.p2, ed.settings.precision)}`);
    this.clickPick = pick;
    try {
      ed.acceptPoint(pick.p2);
    } finally {
      this.clickPick = null;
    }
    ed.lastPoint = { x: pick.point.x, y: pick.point.y };
  }

  /** Give a running 3D command a cursor move (ghost preview), the 3D pick available for that call only. */
  deliverMove(pick: Pick3): void {
    const ed = this.editor;
    if (!(ed.tool instanceof Script3DTool) || ed.selectionPending) return;
    this.cursorPick = pick;
    try {
      ed.tool.onMove(pick.p2, ed.toolContext());
    } finally {
      this.cursorPick = null;
    }
  }

  /** What the tool context extension reads (src/tools3d/context.ts). */
  readonly source: Context3DSource = {
    plane: () => this.constructionPlane,
    planeName: () => this.constructionPlaneName,
    setPlane: (frame, name) => this.setConstructionPlane(frame, name),
    pickAt: (p) => this.pickAt(p),
    kernel: () => this.kernel(),
    setPreview3d: (solids) => this.setPreview3d(solids),
    wantsPreview3d: () => this.active,
    setPreviewDimensions3d: (dims) => this.setPreviewDimensions3d(dims),
  };

  /**
   * The 3D pick at canvas CSS px: the solid face under the cursor, else where the cursor ray meets
   * the construction plane (null when the ray runs parallel to it), with plane coordinates.
   */
  pick3At(x: number, y: number, snap = false): Pick3 | null {
    const vp = this.viewport;
    if (!vp) return null;
    const ray = vp.pixelRay(x, y);
    const hit = vp.pickExact(x, y);
    const plane = this.constructionPlane;
    let point: Vec3;
    if (hit) point = hit.point;
    else {
      const t = intersectRayPlane(ray, { origin: plane.origin, normal: plane.zAxis });
      if (t === null) return null;
      point = add3(ray.origin, scale3(ray.dir, t));
    }
    const local = worldToPlane(plane, point);
    const pick: Pick3 = { p2: { x: local.x, y: local.y }, point, ray, hit };
    return snap ? this.snapped(x, y, pick) : pick;
  }

  /**
   * The pick with the 3D object snap applied (OSNAP toggles, aperture = the 2D APERTURE box
   * measured at the hit's depth); records the marker to draw.
   */
  snapped(x: number, y: number, pick: Pick3): Pick3 {
    const vp = this.viewport;
    const prev = this.snapMarker;
    this.snapMarker = null;
    if (vp && pick.hit) {
      const px = this.editor.settings.apertureSize / 2 + 2;
      const side = vp.pixelRay(x + px, y);
      // Aperture in world units at the hit: distance from the hit point to the offset pixel's ray.
      const v = sub3(pick.hit.point, side.origin);
      const d = scale3(side.dir, 1 / Math.max(1e-300, len3(side.dir)));
      const along = v.x * d.x + v.y * d.y + v.z * d.z;
      const aperture = len3(sub3(v, scale3(d, along)));
      const s = snapPick3(pick, model3dOf(this.editor.doc.snapshot), this.editor.snap, aperture, this.constructionPlane);
      if (s.snap) this.snapMarker = { point: s.point, kind: s.snap };
      if (!sameMarker(prev, this.snapMarker)) this.render();
      return s;
    }
    if (prev) this.render();
    return pick;
  }

  /** Turn 3D mode on. Returns false (and logs why) when it cannot start. */
  enable(): boolean {
    if (this.viewport) return true;
    const ed = this.editor;
    if (ed.activeSpace) {
      ed.log('3D mode is for model space only; paper-space layouts always use the 2D view. Switch to the Model tab first.');
      return false;
    }
    const canvas2d = ed.viewport.canvas;
    const wrap = canvas2d.parentElement;
    if (typeof document === 'undefined' || !wrap) {
      ed.log('3D viewport unavailable: no document to draw in.');
      return false;
    }
    const canvas = document.createElement('canvas');
    canvas.className = 'viewport3d';
    Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', outline: 'none', cursor: 'default' });
    canvas2d.after(canvas);
    let vp: Viewport3D;
    try {
      vp = new Viewport3D(canvas, ed.doc);
    } catch (err) {
      canvas.remove();
      ed.log(`3D viewport unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    this.canvas = canvas;
    this.viewport = vp;
    vp.resize();
    // Start from exactly what the 2D view shows: the plan view of the same area.
    const v2 = ed.viewport;
    vp.camera = cameraFrom2D(v2.center, v2.scale, v2.height, v2.twist);
    this.syncSettings();
    canvas2d.style.visibility = 'hidden';
    const cube = wrap.querySelector<HTMLElement>('.viewcube');
    if (cube) cube.style.visibility = 'hidden';
    this.label = document.createElement('div');
    this.label.className = 'viewport3d-label';
    Object.assign(this.label.style, {
      position: 'absolute', top: '14px', right: '22px', padding: '3px 8px', font: '11px "Segoe UI", system-ui, sans-serif',
      color: 'rgba(230,230,230,0.85)', background: 'rgba(30,34,40,0.7)', border: '1px solid rgba(200,200,200,0.3)', borderRadius: '3px', pointerEvents: 'none',
    });
    canvas.after(this.label);
    // Status bar: the construction plane (the StatusBar keeps its own children, so this stays).
    const bar = document.getElementById('statusbar');
    if (bar) {
      this.statusEl = document.createElement('span');
      this.statusEl.className = 'status-btn text status-plane';
      this.statusEl.title = 'Construction plane of 3D commands (3DPLANE)';
      const coords = bar.querySelector('.status-coords');
      if (coords) coords.after(this.statusEl);
      else bar.prepend(this.statusEl);
    }
    vp.onRendered = () => this.updateLabel();
    vp.onError = (err) => {
      ed.log(`3D viewport stopped: ${err instanceof Error ? err.message : String(err)}. Back to the 2D view.`);
      this.disable();
    };
    this.attachInput(canvas);
    const redraw = () => this.render();
    this.unsubscribe = [
      ed.on('change', redraw),
      ed.on('selection', redraw),
      ed.on('tool', () => {
        if (!ed.tool) {
          this.snapMarker = null;
          this.setPreview3d([]);
          this.setPreviewDimensions3d([]);
        }
        this.render();
      }),
      ed.on('snap', () => { this.syncSettings(); this.render(); }),
      ed.on('view', () => this.resizeIfNeeded()),
      ed.on('space', () => {
        if (ed.activeSpace && this.active) {
          this.disable();
          ed.log('Left 3D mode: layouts are shown in 2D.');
        }
      }),
    ];
    this.render();
    ed.log('3D mode on (experimental). Wheel zooms, middle drag pans, Shift + middle drag orbits. 3DMODE returns to 2D.');
    return true;
  }

  /** Turn 3D mode off: the 2D canvas and viewport are back exactly as before. */
  disable(): void {
    const vp = this.viewport;
    if (!vp) return;
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    this.detachInput?.();
    this.detachInput = null;
    vp.dispose();
    this.canvas?.remove();
    this.label?.remove();
    this.statusEl?.remove();
    this.canvas = null;
    this.label = null;
    this.statusEl = null;
    this.viewport = null;
    this.drag = null;
    this.hover = null;
    this.snapMarker = null;
    this.gripDrag = null;
    this.previewSolids = [];
    this.previewDimensions = [];
    // The kernel's worker and WebAssembly memory go with 3D mode (a Boolean still running is
    // rejected and changes nothing); the next Boolean starts a new kernel.
    this.disposeKernel();
    const canvas2d = this.editor.viewport.canvas;
    canvas2d.style.visibility = '';
    const cube = canvas2d.parentElement?.querySelector<HTMLElement>('.viewcube');
    if (cube) cube.style.visibility = '';
    if (this.editor.tool instanceof Orbit3DTool) this.editor.cancel();
    this.editor.resize();
  }

  toggle(): boolean {
    if (this.active) {
      this.disable();
      this.editor.log('3D mode off.');
      return false;
    }
    return this.enable();
  }

  /** Redraw on the next frame with the current selection and hover. */
  render(): void {
    const vp = this.viewport;
    if (!vp) return;
    vp.dimensionAperture = Math.max(1, this.editor.viewport.settings.pickBox);
    vp.requestRender({
      selection: this.editor.selection, hover: this.hover, previewSolids: this.previewSolids,
      grips3d: this.grips(), gripSize: this.editor.settings.gripSize, snap3d: this.snapMarker,
      ...(this.previewDimensions.length ? { previewDimensions: this.previewDimensions } : {}),
    });
  }

  /** The solid whose grips are shown: the only selected object, when it is a solid and no command runs. */
  gripSolid(): Solid3D | null {
    const ed = this.editor;
    if (ed.tool || ed.selection.size !== 1) return null;
    for (const id of ed.selection) return solidById(model3dOf(ed.doc.snapshot), id) ?? null;
    return null;
  }

  /** Grip points shown now (the bounding-box corners and centre of `gripSolid`). */
  grips(): readonly Vec3[] {
    const s = this.gripSolid();
    return s ? solidGrips(s) : [];
  }

  /** Screen positions (CSS px) of the grips shown now (e2e helper; the centre grip is last). */
  gripScreenPoints(): Array<{ x: number; y: number } | null> {
    return this.grips().map((p) => this.project(p));
  }

  /**
   * Start dragging the centre grip when (x, y) CSS px is on it (within the grip size + 2 px).
   * Returns true when a drag started.
   */
  beginGripDrag(x: number, y: number): boolean {
    const vp = this.viewport;
    const solid = this.gripSolid();
    if (!vp || !solid) return false;
    const grip = solidGrips(solid)[CENTER_GRIP];
    const s = grip ? vp.toScreen(grip) : null;
    const h = this.editor.settings.gripSize + 2;
    if (!grip || !s || Math.abs(s.x - x) > h || Math.abs(s.y - y) > h) return false;
    const ray = vp.pixelRay(x, y);
    const normal = gripDragNormal(this.constructionPlane, ray.dir);
    const start = gripDragPoint(grip, normal, ray);
    if (!start) return false;
    this.gripDrag = { solid, grip, normal, start };
    return true;
  }

  /** The grip drag's displacement for the cursor at (x, y) CSS px, or null. */
  private gripDisplacement(x: number, y: number): Vec3 | null {
    const vp = this.viewport, g = this.gripDrag;
    if (!vp || !g) return null;
    const p = gripDragPoint(g.grip, g.normal, vp.pixelRay(x, y));
    return p ? sub3(p, g.start) : null;
  }

  /** Move the dragged grip's ghost to the cursor. */
  gripDragTo(x: number, y: number): void {
    const g = this.gripDrag;
    const d = this.gripDisplacement(x, y);
    if (!g) return;
    this.setPreview3d(d ? ghostSolids([g.solid], translationMatrix(d)) : []);
  }

  /** Release the grip at (x, y) CSS px: move the solid there as one undoable step. */
  endGripDrag(x: number, y: number): void {
    const g = this.gripDrag;
    const d = this.gripDisplacement(x, y);
    this.gripDrag = null;
    this.setPreview3d([]);
    if (!g || !d || !(len3(d) > 1e-12)) return;
    const ed = this.editor;
    if (solidById(model3dOf(ed.doc.snapshot), g.solid.id) !== g.solid) return;
    try {
      commitSolidEdit({ doc: ed.doc }, { solids: [g.solid], matrix: translationMatrix(d) });
    } catch (err) {
      // Reported like any refused edit (budget, unsupported transform); the drawing is unchanged.
      if (!(err instanceof GeometryBudgetError) && !(err instanceof RangeError)) throw err;
      ed.log(`Grip: ${err.message} The drawing is unchanged.`);
      return;
    }
    const f = (v: number) => (Math.abs(v) < 5e-5 ? '0.0000' : v.toFixed(4));
    ed.log(`Grip: solid moved by ${f(d.x)}, ${f(d.y)}, ${f(d.z)}.`);
    this.render();
  }

  /**
   * Abandon a centre-grip drag (Esc, a command starting, the selection changing): the ghost goes
   * and the button release that follows changes nothing.
   */
  abortGripDrag(): void {
    if (!this.gripDrag) return;
    this.gripDrag = null;
    this.setPreview3d([]);
    this.render();
  }

  /** True while the centre grip is being dragged. */
  get gripDragging(): boolean {
    return this.gripDrag !== null;
  }

  /** Id of the solid whose centre grip is being dragged, or null. */
  get draggedSolidId(): string | null {
    return this.gripDrag?.solid.id ?? null;
  }

  /**
   * Set a solid parameter as the Properties palette does (e2e helper): primitives and sweeps at
   * once, a Boolean as the PROPERTIES command (await `idle()`; refused while a command runs).
   */
  setParameter(id: string, key: string, value: string): void {
    setSolidParameter(this.editor, id, key, value);
  }

  private syncSettings(): void {
    const vp = this.viewport;
    if (!vp) return;
    const s = this.editor.viewport.settings;
    vp.settings = { background: s.background, gridVisible: s.gridVisible, gridSize: s.gridSize };
  }

  private resizeIfNeeded(): void {
    const vp = this.viewport;
    if (!vp || !this.canvas) return;
    const r = this.canvas.getBoundingClientRect();
    if (Math.floor(r.width) !== vp.width || Math.floor(r.height) !== vp.height) {
      vp.resize();
      this.render();
    }
  }

  private updateLabel(): void {
    const vp = this.viewport;
    if (!vp || !this.label) return;
    const preset = matchingPreset(vp.camera);
    const text = `${preset ? VIEW_PRESETS[preset].label : 'Custom view'} · ${vp.camera.projection === 'perspective' ? 'Perspective' : 'Parallel'} · Plane ${this.planeText}`;
    if (this.label.textContent !== text) this.label.textContent = text;
    const status = `Plane: ${this.planeText}`;
    if (this.statusEl && this.statusEl.textContent !== status) this.statusEl.textContent = status;
  }

  /** Apply a named view (turning 3D mode on first when needed). */
  setView(name: ViewPresetName): void {
    if (!this.enable() || !this.viewport) return;
    this.viewport.camera = applyPreset(this.viewport.camera, name);
    this.viewport.zoomExtents();
    this.render();
    this.editor.log(`View: ${VIEW_PRESETS[name].label}.`);
  }

  togglePerspective(): void {
    if (!this.enable() || !this.viewport) return;
    const vp = this.viewport;
    vp.camera = setProjection(vp.camera, vp.camera.projection === 'perspective' ? 'orthographic' : 'perspective');
    this.render();
    this.editor.log(`Projection: ${vp.camera.projection === 'perspective' ? 'perspective' : 'parallel'}.`);
  }

  zoomExtents(): void {
    if (!this.enable() || !this.viewport) return;
    this.viewport.zoomExtents();
    this.render();
  }

  /**
   * 3DDEMO (development test scene): a box, a cylinder and a sphere next to the drawing, added
   * through the drawing's normal state transition so Undo removes them.
   */
  addDemo(): Solid3D[] {
    const ed = this.editor;
    const ext = ed.doc.extents();
    const cx = ext ? (ext.min.x + ext.max.x) / 2 : 0, cy = ext ? (ext.min.y + ext.max.y) / 2 : 0;
    const s = ext ? Math.max(1, Math.max(ext.max.x - ext.min.x, ext.max.y - ext.min.y) / 8) : 2;
    const at = (x: number, y: number, z = 0) => ({ ...WORLD_XY_FRAME, origin: v3(x, y, z) });
    const features: Array<[string, PrimitiveFeature, number]> = [
      ['Demo box', { kind: 'box', frame: at(cx - 2 * s, cy), width: s * 1.4, depth: s, height: s * 0.8 }, 4],
      ['Demo cylinder', { kind: 'cylinder', frame: at(cx, cy), radius: s * 0.5, height: s * 1.2 }, 2],
      ['Demo sphere', { kind: 'sphere', frame: at(cx + 2 * s, cy, s * 0.6), radius: s * 0.6 }, 3],
    ];
    const solids = features.map(([name, feature, color]) => newSolid({ mesh: primitiveMesh(feature), feature, layer: ed.doc.currentLayer, color, name }));
    ed.doc.transact((st) => withModel3D(st, addSolids(model3dOf(st), solids)));
    ed.log('3DDEMO: added a test scene (box, cylinder, sphere). Development aid only; Undo removes it.');
    if (this.viewport) {
      this.viewport.zoomExtents();
      this.render();
    }
    return solids;
  }

  // ---------------------------------------------------------------- debug handle (e2e)

  /** Screen position (CSS px, relative to the 3D canvas) of a world point. */
  project(p: Vec3): { x: number; y: number } | null {
    return this.viewport?.toScreen(p) ?? null;
  }

  /** GPU pick (CPU fallback) at canvas CSS px. */
  pick(x: number, y: number): { id: string | null; path: 'gpu' | 'cpu' | null } {
    const vp = this.viewport;
    if (!vp) return { id: null, path: null };
    const id = vp.pick(x, y);
    return { id, path: vp.lastPickPath };
  }

  /** CPU pick at canvas CSS px. */
  pickExact(x: number, y: number): PickHit | null {
    return this.viewport?.pickExact(x, y) ?? null;
  }

  /**
   * The 2D object (on z = 0) under canvas CSS px, with the 2D pick-box aperture measured on z = 0
   * at the cursor; null when the cursor ray misses the drawing plane or nothing is near.
   */
  pick2dAt(x: number, y: number): string | null {
    const vp = this.viewport;
    if (!vp) return null;
    const ed = this.editor;
    const onPlane = (sx: number, sy: number) => {
      const ray = vp.pixelRay(sx, sy);
      const t = intersectRayPlane(ray, { origin: v3(0, 0, 0), normal: v3(0, 0, 1) });
      return t === null ? null : add3(ray.origin, scale3(ray.dir, t));
    };
    const q = onPlane(x, y);
    const box = Math.max(1, ed.viewport.settings.pickBox);
    const r = onPlane(x + box, y);
    if (!q || !r) return null;
    const aperture = Math.hypot(r.x - q.x, r.y - q.y);
    const layers = ed.doc.layers;
    const locked = new Set(layers.filter((l) => l.locked).map((l) => l.name));
    return pickEntity({ x: q.x, y: q.y }, ed.doc.entities, ed.doc.lookupBlock, aperture, hiddenLayerNames(layers), locked)?.id ?? null;
  }

  /** Ids of the drawing's solids in model order (type one at "Select objects:" to pick it). */
  solidIds(): string[] {
    return model3dOf(this.editor.doc.snapshot).solids.map((s) => s.id);
  }

  /** Ids of the drawing's 3D dimensions in model order (type one at "Select objects:" to pick it). */
  dimensionIds(): string[] {
    return (model3dOf(this.editor.doc.snapshot).dimensions ?? []).map((d) => d.id);
  }

  /** World point on the dimension line (arc) of the 3D dimension `id`, or null (e2e helper: project it, click it). */
  dimensionPoint(id: string): Vec3 | null {
    const d = dimensionById(model3dOf(this.editor.doc.snapshot), id);
    return d ? dimension3dLocation(d) : null;
  }

  /** Resolves when the running 3D command is not computing (await after a Boolean's last input). */
  async idle(): Promise<void> {
    const tool = this.editor.tool;
    if (tool instanceof Script3DTool) await tool.idle();
  }

  /** Move the cursor of a running 3D command to canvas CSS px (ghost preview), as the mouse does. */
  hoverAt(x: number, y: number): void {
    const ed = this.editor;
    if (!this.viewport || !ed.tool || ed.selectionPending || ed.tool instanceof Orbit3DTool) return;
    if (!(ed.tool instanceof Script3DTool)) {
      // 2D command in 3D mode: the cursor where its ray meets z = 0 (ghosts of MOVE etc.).
      const q = this.drawingPlanePoint(x, y);
      if (q) ed.tool.onMove(q, ed.toolContext());
      return;
    }
    // 3D command: the snapped 3D pick, available to the tool for this call only.
    const pick = this.pick3At(x, y, true);
    if (pick) this.deliverMove(pick);
  }

  /**
   * The drawing-plane (z = 0) point a 2D command gets for canvas CSS px: the x, y of the 3D snap
   * when the cursor is over a solid and a snap applies, else where the cursor ray meets z = 0.
   */
  drawingPlanePoint(x: number, y: number): Point | null {
    const vp = this.viewport;
    if (!vp) return null;
    const ray = vp.pixelRay(x, y);
    const hit = vp.pickExact(x, y);
    if (hit) {
      const s = this.snapped(x, y, { p2: { x: hit.point.x, y: hit.point.y }, point: hit.point, ray, hit });
      if (this.snapMarker) return { x: s.point.x, y: s.point.y };
    } else if (this.snapMarker) {
      this.snapMarker = null;
      this.render();
    }
    const t = intersectRayPlane(ray, { origin: v3(0, 0, 0), normal: v3(0, 0, 1) });
    if (t === null) return null;
    const q = add3(ray.origin, scale3(ray.dir, t));
    return { x: q.x, y: q.y };
  }

  // ---------------------------------------------------------------- mouse

  private attachInput(canvas: HTMLCanvasElement): void {
    const pos = (ev: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    };
    const down = (ev: MouseEvent) => {
      // Keep the keyboard focus (the command line) where it is.
      ev.preventDefault();
      const p = pos(ev);
      if (ev.button === 1) {
        const now = performance.now();
        if (now - this.lastMiddle < 400) {
          this.zoomExtents();
          this.lastMiddle = 0;
          return;
        }
        this.lastMiddle = now;
        this.drag = { mode: ev.shiftKey ? 'orbit' : 'pan', last: p, start: p, shift: ev.shiftKey };
      } else if (ev.button === 0) {
        const grip = !this.editor.tool && !ev.shiftKey && this.beginGripDrag(p.x, p.y);
        this.drag = { mode: grip ? 'grip' : this.editor.tool instanceof Orbit3DTool ? 'orbit' : 'click', last: p, start: p, shift: ev.shiftKey };
      }
    };
    const move = (ev: MouseEvent) => {
      const vp = this.viewport;
      if (!vp) return;
      const p = pos(ev);
      const d = this.drag;
      if (d) {
        const dx = p.x - d.last.x, dy = p.y - d.last.y;
        d.last = p;
        if (d.mode === 'grip') {
          this.gripDragTo(p.x, p.y);
          return;
        }
        if (d.mode === 'pan') vp.panBy(dx, dy);
        else if (d.mode === 'orbit') vp.orbitBy(dx, dy);
        if (d.mode !== 'click') {
          this.render();
          return;
        }
      }
      if (this.editor.tool) this.hoverAt(p.x, p.y);
      const hover = this.editor.tool && !this.editor.selectionPending ? null : vp.pick(p.x, p.y);
      if (hover !== this.hover) {
        this.hover = hover;
        this.render();
      }
    };
    const up = (ev: MouseEvent) => {
      const d = this.drag;
      this.drag = null;
      const vp = this.viewport;
      if (d?.mode === 'grip') {
        this.endGripDrag(pos(ev).x, pos(ev).y);
        return;
      }
      if (!d || !vp || d.mode !== 'click' || ev.button !== 0) return;
      const p = pos(ev);
      if (Math.hypot(p.x - d.start.x, p.y - d.start.y) > 3) return;
      this.click(p.x, p.y, d.shift);
    };
    const wheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const p = pos(ev);
      this.viewport?.zoomAt(p.x, p.y, ev.deltaY < 0 ? 1.15 : 1 / 1.15);
      this.render();
    };
    const leave = () => {
      if (this.hover !== null) {
        this.hover = null;
        this.render();
      }
    };
    const menu = (ev: Event) => ev.preventDefault();
    canvas.addEventListener('mousedown', down);
    canvas.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    canvas.addEventListener('wheel', wheel, { passive: false });
    canvas.addEventListener('mouseleave', leave);
    canvas.addEventListener('contextmenu', menu);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.resizeIfNeeded()) : null;
    ro?.observe(canvas);
    this.detachInput = () => {
      canvas.removeEventListener('mousedown', down);
      canvas.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      canvas.removeEventListener('wheel', wheel);
      canvas.removeEventListener('mouseleave', leave);
      canvas.removeEventListener('contextmenu', menu);
      ro?.disconnect();
    };
  }

  /**
   * Left click at canvas CSS px: pick a solid into a pending "Select objects:", give a running 3D
   * command its 3D point, feed a running 2D command, or select / deselect solids.
   */
  click(x: number, y: number, shift: boolean): void {
    const vp = this.viewport;
    if (!vp) return;
    const ed = this.editor;
    if (ed.selectionPending) {
      const id = vp.pick(x, y) ?? this.pick2dAt(x, y);
      if (id) ed.pickIds([id], shift);
      else ed.log('Nothing under the cursor: pick a solid, or a 2D object where the cursor meets z = 0 (or type ALL).');
      this.render();
      return;
    }
    if (ed.tool instanceof Script3DTool) {
      // The snapped 3D pick, handed over directly (see `deliverClick`).
      const pick = this.pick3At(x, y, true);
      if (pick) this.deliverClick(pick);
      return;
    }
    if (ed.tool && !(ed.tool instanceof Orbit3DTool)) {
      // Prototype: the point on the drawing plane under the cursor (or the x, y of a snapped
      // solid point), echoed on the command line and handed over directly.
      const q = this.drawingPlanePoint(x, y);
      if (!q) return;
      ed.log(`${ed.prompt} ${typedCoordinate(q, ed.settings.precision)}`);
      ed.acceptPoint(q);
      return;
    }
    if (ed.tool) return;
    const id = vp.pick(x, y);
    if (id) {
      if (!shift) ed.selection.clear();
      ed.selection.add(id);
    } else if (!shift) {
      if (ed.selection.size === 0) return;
      ed.selection.clear();
    } else return;
    ed.notify('selection');
    ed.render();
    this.render();
  }
}

/** True when two snap markers are the same kind at the same point (or both absent). */
function sameMarker(a: { point: Vec3; kind: Snap3DKind } | null, b: { point: Vec3; kind: Snap3DKind } | null): boolean {
  if (!a || !b) return a === b;
  return a.kind === b.kind && a.point.x === b.point.x && a.point.y === b.point.y && a.point.z === b.point.z;
}

/** Register the 3D commands on `editor`. */
function registerCommands(editor: Editor, c: Experimental3d): void {
  const reg = (name: string, aliases: string[], description: string, run: (ed: Editor, arg?: string) => void | Promise<void>, startsTool = false) =>
    editor.register({ name, aliases, description, run, startsTool });
  reg('3DMODE', [], 'Experimental: switch model space between the 2D view and the 3D viewport', () => {
    c.toggle();
  });
  reg('3DORBIT', ['3DO'], 'Experimental: orbit the 3D view by dragging (Enter / Esc ends)', (ed) => {
    if (!c.enable()) return;
    ed.log('Command: 3DORBIT');
    void ed.startTool(new Orbit3DTool());
  }, true);
  reg('3DVIEW', [], 'Experimental: 3D view preset [Top/Bottom/Front/Back/Left/Right/SWiso/SEiso/NEiso/NWiso]', (ed, arg) => {
    const name = arg ? parseViewPreset(arg) : null;
    if (!name) {
      ed.log('3DVIEW: name a view: Top, Bottom, Front, Back, Left, Right, SWiso, SEiso, NEiso or NWiso.');
      return;
    }
    c.setView(name);
  });
  reg('PLAN', [], 'Experimental: return the 3D view to the plan (top) view', () => c.setView('top'));
  reg('3DPERSPECTIVE', [], 'Experimental: toggle perspective / parallel projection in the 3D view', () => c.togglePerspective());
  reg('3DZOOMEXTENTS', [], 'Experimental: zoom the 3D view to the solids and the drawing', () => c.zoomExtents());
  reg('3DDEMO', [], 'Experimental (development test scene): add a box, a cylinder and a sphere', () => {
    c.addDemo();
  });
  // Modelling (milestone 3): every command is a 3D tool (src/tools3d/), usable from the 2D view too
  // (on the WCS XY plane, z = 0).
  const tool = (name: string, aliases: string[], description: string, make: (arg?: string) => Tool) =>
    reg(name, aliases, `Experimental: ${description}`, (ed, arg) => {
      void ed.startTool(make(arg));
    });
  tool('BOX', [], 'solid box [Center/Cube/Length/2Point]', boxTool);
  tool('WEDGE', ['WE'], 'solid wedge [Center/Cube/Length/2Point]', wedgeTool);
  tool('CYLINDER', ['CYL'], 'solid cylinder [Diameter/2Point/Axis endpoint]', cylinderTool);
  tool('CONE', [], 'solid cone or frustum [Diameter/2Point/Axis endpoint/Top radius]', coneTool);
  tool('SPHERE', [], 'solid sphere [Diameter]', sphereTool);
  tool('TORUS', ['TOR'], 'solid torus [Diameter/2Point]', torusTool);
  tool('EXTRUDE', ['EXT'], 'extrude closed 2D objects into a solid [Delete]', extrudeTool);
  tool('REVOLVE', ['REV'], 'revolve closed 2D objects about an axis [X/Y/Z/Reverse/Delete]', revolveTool);
  tool('UNION', ['UNI'], 'join solids into one', unionTool);
  tool('SUBTRACT', ['SU'], 'subtract solids from solids', subtractTool);
  tool('INTERSECT', ['IN'], 'keep the common volume of solids', intersectTool);
  tool('3DPLANE', [], 'construction plane for 3D commands [World/Top/Front/Right/Solid face/Origin] (XY/XZ/YZ/Face typed)', planeTool);
  // Editing and measurement (milestone 4, docs/3D-EDITING.md).
  tool('3DMOVE', ['3M'], 'move solids [Displacement]', move3dTool);
  tool('3DROTATE', ['3R'], 'rotate solids about an axis [X/Y/Z/2Points] [Reference]', rotate3dTool);
  tool('3DSCALE', [], 'scale solids uniformly [Reference]', scale3dTool);
  tool('3DDIST', [], 'distance between two 3D points', () => dist3dTool());
  tool('3DMASSPROP', [], 'volume, surface area, bounding box and centroid of solids', massProp3dTool);
  tool('3DAREA', [], 'area and perimeter of a planar face of a solid', area3dTool);
  tool('3DDIM', [], 'interim prototype: aligned 2D dimension of two 3D points projected onto the drawing plane, labelled "(projected)" when a point is off it (see DIM3D)', dim3dTool);
  tool('DIM3D', [], 'true 3D dimension in its measurement plane [Aligned/Linear/Angular/Plane/Text]', dimension3dTool);
  // DIST measures 3D points while 3D mode is on; otherwise it is the unchanged 2D command.
  const dist = editor.commands.get('DIST');
  if (dist) {
    reg(dist.name, dist.aliases, dist.description, (ed, arg) => {
      if (c.active) return ed.startTool(dist3dTool('DIST'));
      return dist.run(ed, arg);
    }, dist.startsTool);
  }
}

/**
 * "Select objects:" keywords with the flag on: ALL also takes the visible solids and 3D dimensions,
 * and a solid's or 3D dimension's id (as `jcad3d.solidIds()` / `dimensionIds()` list them) takes
 * it. Everything else goes to the 2D handler.
 */
function extendSelectionKeywords(editor: Editor): void {
  const base = editor.selectionKeyword;
  editor.selectionKeyword = (text, ids) => {
    const handled = base ? base(text, ids) : false;
    const t = text.trim();
    const state = editor.doc.snapshot;
    const solids = model3dOf(state).solids;
    const dims = model3dOf(state).dimensions ?? [];
    if (t.toUpperCase() === 'ALL') {
      if (!base) for (const e of editor.doc.entities) ids.add(e.id);
      const hidden = hiddenLayerNames(state.layers);
      for (const s of solids) if (!hidden.has(s.layer)) ids.add(s.id);
      for (const d of dims) if (!hidden.has(d.layer)) ids.add(d.id);
      return true;
    }
    const solid = solids.find((s) => s.id.toLowerCase() === t.toLowerCase()) ?? dims.find((d) => d.id.toLowerCase() === t.toLowerCase());
    if (solid) {
      ids.add(solid.id);
      return true;
    }
    return handled;
  };
}

/**
 * Install the experimental 3D features when `settings.experimental3d` is on; returns the
 * controller, or null (and changes nothing) when the flag is off. Call once at startup, before the
 * ribbon is built.
 */
export function installExperimental3d(editor: Editor): Experimental3d | null {
  if (!editor.settings.experimental3d) return null;
  const c = new Experimental3d(editor);
  registerCommands(editor, c);
  editor.toolContextExtension = (ctx) => extendContext3d(ctx, c.source);
  extendSelectionKeywords(editor);
  // Outside 3D mode nothing else ends the kernel's life, so a Boolean run from the 2D view releases
  // its worker and WebAssembly memory as soon as its command ends (3D mode disposes it on exit).
  editor.on('tool', () => {
    if (!editor.tool && !c.active && c.kernelStarted) c.disposeKernel();
    if (editor.tool) c.abortGripDrag();
  });
  // Esc (the editor's cancel path clears the selection) or any other selection change abandons a
  // centre-grip drag of the solid that is no longer the single selected object.
  editor.on('selection', () => {
    if (c.gripDragging && c.gripSolid()?.id !== c.draggedSolidId) c.abortGripDrag();
  });
  if (!RIBBON.some((t) => t.name === RIBBON_3D_TAB.name)) RIBBON.push(RIBBON_3D_TAB);
  if (typeof window !== 'undefined') {
    window.jcad3d = c;
    window.addEventListener?.('pagehide', () => c.disposeKernel());
  }
  return c;
}
