import { afterEach, describe, expect, it, vi } from 'vitest';
import { Drawing } from '../src/core/document';
import type { Entity, PolylineEntity } from '../src/core/entities';
import type { Point } from '../src/core/geometry';
import { activeSelectionClip, viewportSelectionEntities } from '../src/core/selection';
import { defaultLayout, paperToModel, type LayoutViewport } from '../src/core/layouts';
import { Editor } from '../src/app/editor';
import type { ViewportOverlay } from '../src/render/viewport';
import { selectByMode, selectTool } from '../src/tools/select';
import { drive, fakeContext } from './fake-context';

const props = { layer: '0', color: 'ByLayer' as const };
const boundary: PolylineEntity = { ...props, id: 'clip', type: 'polyline', closed: true,
  points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 10 }, { x: 0, y: 10 }] };

function viewport(twist = 0): LayoutViewport {
  return { id: 'v', center: { x: 5, y: 5 }, width: 10, height: 10, layer: '0', on: true,
    clipBoundary: boundary, view: { center: { x: 100, y: 200 }, scale: 0.5, twist, locked: true } };
}

const line = (vp: LayoutViewport, id: string, a: Point, b: Point): Entity => ({ ...props, id, type: 'line', a: paperToModel(vp, a), b: paperToModel(vp, b) });
const event = (p: Point): MouseEvent => ({ clientX: p.x, clientY: p.y, button: 0, shiftKey: false, preventDefault: () => {} }) as MouseEvent;
const editors: Editor[] = [];

function editor(vp = viewport(), entities = [line(vp, 'visible', { x: 1, y: 2 }, { x: 3, y: 2 }), line(vp, 'hidden', { x: 6, y: 6 }, { x: 8, y: 6 })]) {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const canvas = { width: 800, height: 600, getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }) } as unknown as HTMLCanvasElement;
  const ed = new Editor(canvas);
  editors.push(ed);
  let overlay: ViewportOverlay | null = null;
  ed.viewport.requestRender = (value) => { overlay = value; };
  ed.viewport.width = 800;
  ed.viewport.height = 600;
  ed.viewport.center = vp.view.center;
  ed.viewport.scale = 40;
  ed.viewport.twist = vp.view.twist ?? 0;
  ed.snap.osnap = false;
  ed.snap.gridSnap = false;
  ed.snap.ortho = false;
  ed.snap.polarTracking = false;
  ed.doc.load({ ...ed.doc.snapshot, entities, layouts: [{ ...defaultLayout('Clip'), pristine: undefined, viewports: [vp] }], space: { layout: 'Clip', viewport: vp.id } });
  ed.notify('file');
  const mouse = (paper: Point) => event(ed.viewport.toScreen(paperToModel(vp, paper)));
  return { ed, vp, mouse, get overlay() { return overlay; } };
}

afterEach(() => {
  for (const ed of editors.splice(0)) ed.viewport.dispose();
  vi.unstubAllGlobals();
});

describe('graphical input in a concave viewport clip', () => {
  it.each([0, Math.PI / 2, 0.43])('blocks hidden hover/clicks and selection-request clicks at twist %s', (twist) => {
    const scene = editor(viewport(twist));
    const { ed, mouse } = scene;
    ed.onMouseMove(mouse({ x: 2, y: 2 }));
    expect(scene.overlay?.hover).toBe('visible');
    ed.onMouseMove(mouse({ x: 7, y: 6 }));
    expect(scene.overlay?.hover).toBeNull();
    ed.onMouseDown(mouse({ x: 7, y: 6 }));
    ed.onMouseUp(mouse({ x: 7, y: 6 }));
    expect(ed.selection.size).toBe(0);
    ed.runCommand('MOVE');
    expect(ed.prompt).toMatch(/Select objects/i);
    ed.onMouseDown(mouse({ x: 7, y: 6 }));
    ed.onMouseUp(mouse({ x: 7, y: 6 }));
    expect(ed.selection.size).toBe(0);
    ed.onMouseDown(mouse({ x: 2, y: 2 }));
    expect([...ed.selection]).toEqual(['visible']);
    ed.cancel();
  });

  it('blocks hidden pointer input while SELECT and a drawing tool are active', () => {
    const { ed, mouse } = editor();
    ed.runCommand('SELECT');
    ed.onMouseDown(mouse({ x: 7, y: 6 }));
    expect(ed.prompt).toBe('Select objects:');
    expect(ed.selection.size).toBe(0);
    ed.onMouseDown(mouse({ x: 2, y: 2 }));
    expect([...ed.selection]).toEqual(['visible']);
    ed.cancel();
    ed.selection.clear();
    ed.runCommand('LINE');
    const previous = ed.lastPoint;
    ed.onMouseDown(mouse({ x: 7, y: 6 }));
    expect(ed.lastPoint).toBe(previous);
    expect(ed.doc.entities).toHaveLength(2);
    ed.onMouseDown(mouse({ x: 2, y: 2 }));
    expect(ed.lastPoint).toEqual(paperToModel(viewport(), { x: 2, y: 2 }));
    ed.cancel();
  });

  it.each([0, 0.61])('chooses a visible snap over a closer masked endpoint on a partly visible line at twist %s', (twist) => {
    const vp = viewport(twist);
    const scene = editor(vp, [
      line(vp, 'partly', { x: 3, y: 3 }, { x: 4.04, y: 7 }),
      line(vp, 'target', { x: 3.94, y: 7.04 }, { x: 3, y: 8 }),
    ]);
    const { ed, mouse } = scene;
    Object.assign(ed.snap, { osnap: true, endpoint: true, midpoint: false, center: false, intersection: false, perpendicular: false });
    ed.runCommand('LINE');
    ed.onMouseMove(mouse({ x: 3.99, y: 7 }));
    expect(scene.overlay?.snap).toMatchObject({ entityId: 'target', kind: 'endpoint' });
    ed.onMouseDown(mouse({ x: 3.99, y: 7 }));
    const expected = paperToModel(vp, { x: 3.94, y: 7.04 });
    expect(ed.lastPoint?.x).toBeCloseTo(expected.x, 8);
    expect(ed.lastPoint?.y).toBeCloseTo(expected.y, 8);
    ed.onMouseMove(mouse({ x: 4.04, y: 7 }));
    expect(scene.overlay?.snap).toBeNull();
    ed.cancel();
  });

  it('keeps a snap exactly on the clip boundary', () => {
    const vp = viewport(0.43);
    const scene = editor(vp, [line(vp, 'edge', { x: 4, y: 7 }, { x: 3, y: 7 })]);
    scene.ed.snap.osnap = true;
    scene.ed.runCommand('LINE');
    scene.ed.onMouseMove(scene.mouse({ x: 4, y: 7 }));
    expect(scene.overlay?.snap).toMatchObject({ entityId: 'edge', kind: 'endpoint' });
    scene.ed.cancel();
  });

  it.each([0, 0.47])('mouse windows/crossings exclude fully masked entities at twist %s', (twist) => {
    const { ed, mouse } = editor(viewport(twist));
    ed.onMouseDown(mouse({ x: 0.5, y: 0.5 }));
    ed.onMouseMove(mouse({ x: 9.5, y: 9.5 }));
    ed.onMouseUp(mouse({ x: 9.5, y: 9.5 }));
    expect([...ed.selection]).toEqual(['visible']);
    ed.selection.clear();
    ed.onMouseDown(mouse({ x: 9.5, y: 0.5 }));
    ed.onMouseMove(mouse({ x: 0.5, y: 9.5 }));
    ed.onMouseUp(mouse({ x: 0.5, y: 9.5 }));
    expect([...ed.selection]).toEqual(['visible']);
  });

  it('a disabled clip preserves the existing rectangular viewport picking behavior', () => {
    const vp = { ...viewport(), clipOn: false };
    const { ed, mouse } = editor(vp);
    expect(activeSelectionClip(ed.doc.snapshot)).toBeNull();
    expect(viewportSelectionEntities(ed.doc.snapshot, ed.doc.entities, ed.doc.lookupBlock)).toBe(ed.doc.entities);
    ed.onMouseDown(mouse({ x: 7, y: 6 }));
    expect([...ed.selection]).toEqual(['hidden']);
  });
});

describe('viewport clip geometry candidates and SELECT modes', () => {
  function drawing(vp = viewport(0.43)) {
    const visible = line(vp, 'visible', { x: 2, y: 6 }, { x: 2, y: 8 });
    const hidden = line(vp, 'hidden', { x: 7, y: 6 }, { x: 7, y: 8 });
    const doc = new Drawing();
    doc.load({ ...doc.snapshot, entities: [visible, hidden], layouts: [{ ...defaultLayout('Clip'), viewports: [vp] }], space: { layout: 'Clip', viewport: vp.id } });
    return { doc, vp, point: (p: Point) => paperToModel(vp, p) };
  }

  it('accepts rotated model points on every clip vertex and outer edge within round-trip precision', () => {
    for (const twist of [Math.PI / 6, Math.PI / 2, 0.43, -0.61]) {
      const { doc, point } = drawing(viewport(twist));
      const clip = activeSelectionClip(doc.snapshot)!;
      for (const p of [...boundary.points, { x: 0, y: 7 }, { x: 10, y: 3 }, { x: 4, y: 7 }]) {
        expect(clip.contains(point(p)), `twist ${twist}, paper ${p.x},${p.y}`).toBe(true);
      }
    }
  });

  it.each(['WINDOW', 'CROSSING', 'WPOLYGON', 'CPOLYGON', 'FENCE'])('%s excludes fully hidden geometry while ALL retains whole-space semantics', (mode) => {
    const { doc, vp, point } = drawing();
    const ctx = Object.assign(fakeContext(doc), { viewTwist: vp.view.twist });
    const inputs = mode === 'FENCE'
      ? [mode, point({ x: -1, y: 7 }), point({ x: 11, y: 7 }), '', '']
      : mode === 'WINDOW' || mode === 'CROSSING'
        ? [mode, point({ x: -1, y: -1 }), point({ x: 11, y: 11 }), '']
        : [mode, ...[{ x: -1, y: -1 }, { x: 11, y: -1 }, { x: 11, y: 11 }, { x: -1, y: 11 }].map(point), '', ''];
    drive(selectTool(), ctx, inputs);
    expect([...ctx.selection]).toEqual(['visible']);
    expect(selectByMode(ctx, 'ALL').next().value).toEqual(['visible', 'hidden']);
    expect(selectByMode(ctx, 'LAST').next().value).toEqual(['hidden']);
  });

  it('retains through-crossing and filled geometry and invalidates candidates after block edits and undo', () => {
    const { doc, vp } = drawing();
    const through = line(vp, 'through', { x: -1, y: 7 }, { x: 11, y: 7 });
    const filled: Entity = { ...props, id: 'filled', type: 'polyline', closed: true, filled: true,
      points: [{ x: -1, y: -1 }, { x: 11, y: -1 }, { x: 11, y: 11 }, { x: -1, y: 11 }].map((p) => paperToModel(vp, p)) };
    const hiddenCircle: Entity = { ...props, id: 'circle', type: 'circle', center: paperToModel(vp, { x: 7, y: 7 }), radius: 0.5 };
    const nested: Entity = { ...props, id: 'nested', type: 'insert', block: 'B', position: { x: 0, y: 0 }, scale: 1, rotation: 0, attributes: {} };
    const basePoint = { x: 0, y: 0 };
    doc.load({ ...doc.snapshot, entities: [...doc.entities, through, filled, hiddenCircle, nested], blocks: { B: { name: 'B', basePoint, attributes: [], entities: [line(vp, 'inside-block', { x: 7, y: 6 }, { x: 7, y: 8 })] } } });
    const first = viewportSelectionEntities(doc.snapshot, doc.entities, doc.lookupBlock);
    expect(first.map((e) => e.id)).toEqual(['visible', 'through', 'filled']);
    expect(viewportSelectionEntities(doc.snapshot, doc.entities, doc.lookupBlock)).toBe(first);
    const source = doc.snapshot.entities;
    doc.defineBlock({ name: 'B', basePoint, attributes: [], entities: [line(vp, 'inside-block', { x: 2, y: 6 }, { x: 2, y: 8 })] });
    expect(doc.snapshot.entities).toBe(source);
    expect(viewportSelectionEntities(doc.snapshot, doc.entities, doc.lookupBlock).map((e) => e.id)).toEqual(['visible', 'through', 'filled', 'nested']);
    doc.undo();
    expect(viewportSelectionEntities(doc.snapshot, doc.entities, doc.lookupBlock).map((e) => e.id)).toEqual(['visible', 'through', 'filled']);
  });
});
