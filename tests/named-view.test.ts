import { afterEach, describe, expect, it, vi } from 'vitest';
import { namedCameraCenter, namedCameraDisplayCenter, planarNamedCamera, type NativeViewCamera } from '../src/core/named-view';
import { Drawing } from '../src/core/document';
import { SessionManager, type SessionHost } from '../src/app/sessions';
import { updateEntityFields } from '../src/tools/drafting-annot';
import type { TextEntity } from '../src/core/entities';
import { Editor } from '../src/app/editor';
import { defaultLayout, type LayoutViewport } from '../src/core/layouts';
import { layoutController } from '../src/tools/layouts';
import { paperTransform } from '../src/render/layouts';
const camera = (): NativeViewCamera => ({ displayCenter: { x: 5, y: 2.5 }, direction: { x: 0, y: 0, z: 1 }, target: { x: 100, y: 200, z: 7 }, width: 40, twist: Math.PI / 6, lensLength: 50, frontClip: 0, backClip: 0, mode: 0, flags: 0 });
afterEach(() => vi.unstubAllGlobals());
function editor() {
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {});
  const canvas = { getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }) } as unknown as HTMLCanvasElement;
  const ed = new Editor(canvas); ed.viewport.requestRender = () => {}; ed.viewport.width = 800; ed.viewport.height = 600;
  const native = camera(), view = { name: 'ANGLE', center: namedCameraCenter(native), height: 10, width: native.width, twist: native.twist, camera: native };
  const vp: LayoutViewport = { id: 'frame', center: { x: 200, y: 140 }, width: 150, height: 80, view: { center: { x: 13, y: -7 }, scale: 2, twist: 0.4 }, layer: '0', on: true };
  ed.doc.load({ ...ed.doc.snapshot, header: { ...ed.doc.header, views: [view, { ...view, name: 'PAPER', camera: { ...native, flags: 1 } }, { ...view, name: 'FUTURE', camera: { ...native, direction: { x: 1, y: 2, z: 3 } } }] }, layouts: [{ ...defaultLayout('Sheet'), pristine: undefined, viewports: [vp] }] });
  ed.notify('file'); return { ed, c: layoutController(ed), view, frame: vp };
}
describe('native named view cameras', () => {
  it('converts DCS to model WCS with target and rotation, and inverts without changing model coordinates', () => {
    const native = camera(), center = namedCameraCenter(native);
    expect(center.x).toBeCloseTo(100 + 5 * Math.cos(Math.PI / 6) + 2.5 * Math.sin(Math.PI / 6), 12);
    expect(center.y).toBeCloseTo(200 - 5 * Math.sin(Math.PI / 6) + 2.5 * Math.cos(Math.PI / 6), 12);
    expect(namedCameraDisplayCenter(native, center).x).toBeCloseTo(5, 12);
    expect(namedCameraDisplayCenter(native, center).y).toBeCloseTo(2.5, 12);
    expect(native.target.z).toBe(7);
  });
  it('distinguishes supported planar cameras from retained tilted/perspective/negative-normal cameras', () => {
    expect(planarNamedCamera(camera())).toBe(true);
    expect(planarNamedCamera({ ...camera(), direction: { x: 1, y: 2, z: 3 } })).toBe(false);
    expect(planarNamedCamera({ ...camera(), mode: 1 })).toBe(false);
    expect(planarNamedCamera({ ...camera(), direction: { x: 0, y: 0, z: -1 } })).toBe(false);
  });
  it('parks and restores each model view angle across document tabs', () => {
    const doc = new Drawing(), viewport = { center: { x: 1, y: 2 }, scale: 25, twist: Math.PI / 6 };
    const host: SessionHost = { doc, viewport, selection: new Set(), loadState(state, path) { doc.load(state, path); viewport.center = { x: 0, y: 0 }; viewport.scale = 1; viewport.twist = 0; } };
    const sessions = new SessionManager(host), first = sessions.active;
    const second = sessions.addInBackground(new Drawing().snapshot, 'C:/Drawings/other.dxf');
    sessions.switchTo(second); expect(viewport.twist).toBe(0);
    viewport.twist = -0.7;
    sessions.switchTo(first); expect(viewport.twist).toBeCloseTo(Math.PI / 6, 12);
    sessions.switchTo(second); expect(viewport.twist).toBe(-0.7);
  });
  it('updates supported native values without losing native ownership, and keeps unsupported evaluator caches', () => {
    const entity: TextEntity = { id: 'text', type: 'text', color: 'ByLayer', layer: '0', position: { x: 0, y: 0 }, height: 1, rotation: 0, align: 'left', text: 'before', field: { native: true, code: '%<\\AcVar Filename \\f "%fn2">%', value: 'before' } };
    expect(updateEntityFields(entity, { filePath: 'C:/Drawings/after.dwg' })).toMatchObject({ text: 'after', field: { native: true } });
    const cached = { ...entity, field: { ...entity.field!, code: '%<\\AcObjProp Object(%<\\_ObjIdx 0>%).Length>%', value: 'before' } };
    expect(updateEntityFields(cached, {})).toBe(cached);
  });
});

describe('named views through actual Editor spaces and sessions', () => {
  it('restoring a model view from paper switches to Model before applying rotation, and paper coordinates stay aligned with painting', () => {
    const { ed, c, view } = editor(), entities = ed.doc.snapshot.entities;
    c.activate('Sheet'); ed.runCommand('VIEW R ANGLE');
    expect(ed.doc.space).toBeUndefined(); expect(ed.viewport.twist).toBe(view.twist); expect(ed.viewport.center).toEqual(view.center); expect(ed.doc.snapshot.entities).toBe(entities);
    c.activate('Sheet'); expect(ed.viewport.twist).toBe(0);
    expect(ed.viewport.toScreen({ x: 1, y: 0 })).toEqual(paperTransform(c.currentPaperView(), 800, 600).toScreen({ x: 1, y: 0 }));
    ed.viewport.dispose();
  });
  it('refuses paper-camera/3D restoration and paper-origin Save/Window without changing space, history or the named views', () => {
    const { ed, c } = editor(); c.activate('Sheet');
    const before = ed.doc.snapshot, view = { center: ed.viewport.center, scale: ed.viewport.scale, twist: ed.viewport.twist }, history = [...ed.viewport.viewHistory];
    for (const command of ['VIEW R PAPER', 'VIEW R FUTURE', 'VIEW S BAD', 'VIEW W BAD']) ed.runCommand(command);
    expect(ed.doc.snapshot).toBe(before); expect({ center: ed.viewport.center, scale: ed.viewport.scale, twist: ed.viewport.twist }).toEqual(view); expect(ed.viewport.viewHistory).toEqual(history);
    expect(ed.history).toContainEqual(expect.stringContaining('sheet association')); expect(ed.history).toContainEqual(expect.stringContaining('3D or perspective camera'));
    expect(ed.history.filter(message => message.includes('Enter Model or a floating viewport'))).toHaveLength(2);
    ed.viewport.dispose();
  });
  it('saves a floating viewport model view using its visible frame center/height/width, preserving the geometry', () => {
    const { ed, c, frame } = editor(), entities = ed.doc.snapshot.entities;
    c.activate('Sheet'); c.enterViewport(frame.id); ed.runCommand('VIEW S FRAME');
    const saved = ed.doc.header.views.find(view => view.name === 'FRAME')!;
    expect(saved.center.x).toBeCloseTo(frame.view.center.x, 10); expect(saved.center.y).toBeCloseTo(frame.view.center.y, 10);
    expect(saved.height).toBeCloseTo(frame.height / frame.view.scale, 10); expect(saved.width).toBeCloseTo(frame.width / frame.view.scale, 10); expect(saved.twist).toBe(frame.view.twist);
    expect(ed.doc.snapshot.entities).toBe(entities); ed.viewport.dispose();
  });
  it.each(['paper', 'viewport'])('keeps parked Model rotation/zoom and Previous across tabs while the outgoing context is %s', mode => {
    const { ed, c, view, frame } = editor(), sessions = ed.sessions, first = sessions.active;
    ed.runCommand('VIEW R ANGLE'); const initialScale = ed.viewport.scale; ed.runCommand('ZOOM I'); const modelScale = ed.viewport.scale;
    c.activate('Sheet'); if (mode === 'viewport') c.enterViewport(frame.id);
    sessions.add(); ed.viewport.twist = -0.9; ed.notify('view'); sessions.switchTo(first);
    expect(c.mode).toBe(mode); if (mode === 'paper') expect(ed.viewport.twist).toBe(0);
    c.activate(null); expect(ed.viewport.twist).toBe(view.twist); expect(ed.viewport.center).toEqual(view.center); expect(ed.viewport.scale).toBe(modelScale);
    ed.runCommand('ZOOM P'); expect(ed.viewport.twist).toBe(view.twist); expect(ed.viewport.scale).toBe(initialScale);
    sessions.switchTo(1); expect(ed.viewport.twist).toBe(-0.9); ed.viewport.dispose();
  });
  it('replacing parked or active contents clears the old Model view and Previous history', () => {
    const { ed, c } = editor(), sessions = ed.sessions, first = sessions.current.id;
    ed.runCommand('VIEW R ANGLE'); ed.runCommand('ZOOM I'); c.activate('Sheet'); sessions.add();
    sessions.loadInto(first, new Drawing().snapshot, null); sessions.switchTo(0);
    expect(ed.viewport.twist).toBe(0); expect(ed.viewport.viewHistory).toEqual([]);
    ed.viewport.twist = 0.6; c.activate('Layout1');
    const replacement = { ...new Drawing().snapshot, layouts: [{ ...defaultLayout('Sheet'), pristine: undefined }], space: { layout: 'Sheet' } };
    sessions.loadInto(first, replacement, null); c.activate(null);
    expect(ed.viewport.twist).toBe(0); expect(ed.viewport.viewHistory).toEqual([]); ed.viewport.dispose();
  });
});
