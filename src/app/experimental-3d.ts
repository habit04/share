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
 */
import type { Editor } from './editor';
import type { Tool, ToolContext } from '../tools/types';
import type { Point } from '../core/geometry';
import { RIBBON, type RibbonTab } from '../ui/ribbon';
import { type Vec3, WORLD_XY_FRAME, intersectRayPlane, add3, scale3, v3 } from '../model3d/math';
import { addSolids, model3dOf, newSolid, withModel3D } from '../model3d/model';
import { primitiveMesh } from '../model3d/primitives';
import type { PrimitiveFeature, Solid3D } from '../model3d/types';
import { Viewport3D } from '../render3d/viewport3d';
import { type ViewPresetName, VIEW_PRESETS, applyPreset, cameraFrom2D, matchingPreset, parseViewPreset, setProjection } from '../render3d/camera';
import type { PickHit } from '../render3d/picking';

/** The ribbon tab added when the flag is on (exported for tests; never in RIBBON when off). */
export const RIBBON_3D_TAB: RibbonTab = {
  name: '3D',
  panels: [
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

type Drag = { mode: 'pan' | 'orbit' | 'click'; last: { x: number; y: number }; start: { x: number; y: number }; shift: boolean };

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

  constructor(readonly editor: Editor) {}

  /** True while model space is shown by the 3D viewport. */
  get active(): boolean {
    return this.viewport !== null;
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
    this.canvas = null;
    this.label = null;
    this.viewport = null;
    this.drag = null;
    this.hover = null;
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
    this.viewport?.requestRender({ selection: this.editor.selection, hover: this.hover });
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
    const text = `${preset ? VIEW_PRESETS[preset].label : 'Custom view'} · ${vp.camera.projection === 'perspective' ? 'Perspective' : 'Parallel'}`;
    if (this.label.textContent !== text) this.label.textContent = text;
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
        this.drag = { mode: this.editor.tool instanceof Orbit3DTool ? 'orbit' : 'click', last: p, start: p, shift: ev.shiftKey };
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
        if (d.mode === 'pan') vp.panBy(dx, dy);
        else if (d.mode === 'orbit') vp.orbitBy(dx, dy);
        if (d.mode !== 'click') {
          this.render();
          return;
        }
      }
      const hover = this.editor.tool ? null : vp.pick(p.x, p.y);
      if (hover !== this.hover) {
        this.hover = hover;
        this.render();
      }
    };
    const up = (ev: MouseEvent) => {
      const d = this.drag;
      this.drag = null;
      const vp = this.viewport;
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

  /** Left click at canvas CSS px: select / deselect solids, or feed a running 2D command. */
  click(x: number, y: number, shift: boolean): void {
    const vp = this.viewport;
    if (!vp) return;
    const ed = this.editor;
    if (ed.tool && !(ed.tool instanceof Orbit3DTool)) {
      // Prototype: the point on the drawing plane under the cursor, as typed coordinates.
      const ray = vp.pixelRay(x, y);
      const t = intersectRayPlane(ray, { origin: v3(0, 0, 0), normal: v3(0, 0, 1) });
      if (t === null) return;
      const q = add3(ray.origin, scale3(ray.dir, t));
      ed.submitInput(typedCoordinate(q, ed.settings.precision));
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
  if (!RIBBON.some((t) => t.name === RIBBON_3D_TAB.name)) RIBBON.push(RIBBON_3D_TAB);
  if (typeof window !== 'undefined') window.jcad3d = c;
  return c;
}
