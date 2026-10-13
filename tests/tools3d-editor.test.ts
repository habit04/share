/**
 * The modelling commands through a real Editor with the flag on (3D mode off: no WebGL in Node),
 * typed exactly as docs/3D-MODELLING.md tells the reader to replay them, plus ERASE, the
 * selection keywords, 3DPLANE, the Properties rows and flag-off isolation of the editor changes.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Editor as EditorType } from '../src/app/editor';
import type { Experimental3d, installExperimental3d as InstallType } from '../src/app/experimental-3d';
import { RIBBON } from '../src/ui/ribbon';
import { meshBounds, meshIsClosed, meshVolume } from '../src/model3d/mesh';
import { model3dOf } from '../src/model3d/model';
import { featureLabel, selectedSolids, solidRows } from '../src/tools3d/properties';
import { resetModellingDefaults } from '../src/tools3d/primitives';
import { resetSweepDefaults } from '../src/tools3d/sweeps';
import { EraseTool } from '../src/tools/modify';
import { fakeContext } from './fake-context';

let Editor: typeof EditorType;
let installExperimental3d: typeof InstallType;
beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  Editor = (await import('../src/app/editor')).Editor;
  ({ installExperimental3d } = await import('../src/app/experimental-3d'));
});
beforeEach(() => {
  resetModellingDefaults();
  resetSweepDefaults();
});
afterEach(() => {
  const i = RIBBON.findIndex((t) => t.name === '3D');
  if (i >= 0) RIBBON.splice(i, 1);
});
const canvas = () => ({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 }) as unknown as HTMLCanvasElement;

function editor3d(): { ed: EditorType; c: Experimental3d } {
  const ed = new Editor(canvas());
  ed.settings = { ...ed.settings, experimental3d: true };
  const c = installExperimental3d(ed)!;
  return { ed, c };
}
const type = (ed: EditorType, ...inputs: string[]) => {
  for (const t of inputs) ed.submitInput(t);
};
const solids = (ed: EditorType) => model3dOf(ed.doc.snapshot).solids;

describe('docs/3D-MODELLING.md replay (same inputs, same order)', () => {
  it('produces the results the document states', async () => {
    const { ed, c: jcad3d } = editor3d();
    const run = (cmd: string, ...xs: string[]) => {
      void ed.runCommand(cmd);
      for (const x of xs) ed.submitInput(x);
    };
    const last = () => solids(ed).at(-1)!;
    const vol = () => meshVolume(last().mesh);
    run('BOX', '0,0', '10,10', '5');
    expect(vol()).toBeCloseTo(500, 9);
    run('BOX', '20,0', 'C', '4');
    expect(vol()).toBeCloseTo(64, 9);
    run('BOX', 'C', '30,0,10', '32,3', '4');
    expect(meshBounds(last().mesh)).toEqual({ min: { x: 28, y: -3, z: 8 }, max: { x: 32, y: 3, z: 12 } });
    run('CYLINDER', '40,0', '3', '8');
    expect(last().feature).toMatchObject({ kind: 'cylinder', radius: 3, height: 8 });
    run('CYLINDER', '50,0', 'D', '4', '');
    expect(last().feature).toMatchObject({ kind: 'cylinder', radius: 2, height: 8 });
    run('CYLINDER', '60,0', '1', 'A', '63,0,0');
    expect(last().feature).toMatchObject({ kind: 'cylinder', radius: 1, height: 3, frame: { zAxis: { x: 1, y: 0, z: 0 } } });
    run('WEDGE', '0,20', '4,24', '3');
    expect(vol()).toBeCloseTo(24, 9);
    run('CONE', '20,20', '2', 'T', '1', '4');
    expect(last().feature).toMatchObject({ kind: 'cone', baseRadius: 2, topRadius: 1, height: 4 });
    run('SPHERE', '40,20', '2');
    expect(last().feature).toMatchObject({ kind: 'sphere', radius: 2 });
    run('TORUS', '60,20', '5', '1');
    expect(last().feature).toMatchObject({ kind: 'torus', majorRadius: 5, minorRadius: 1 });
    expect(solids(ed)).toHaveLength(10);

    run('RECTANG', '0,-20', '4,-17');
    run('EXTRUDE', 'L', '', '2');
    expect(vol()).toBeCloseTo(24, 9);
    expect(ed.doc.entities).toHaveLength(1);
    run('CIRCLE', '10,-20', '1');
    run('EXTRUDE', 'L', '', 'D', '3');
    expect(last().feature).toMatchObject({ kind: 'extrude', distance: 3 });
    expect(ed.doc.entities).toHaveLength(1);
    run('RECTANG', '21,-20', '22,-17');
    run('REVOLVE', 'L', '', '20,-20', '20,-10', '');
    expect(last().feature).toMatchObject({ kind: 'revolve', angle: 2 * Math.PI });
    expect(meshIsClosed(last().mesh)).toBe(true);
    expect(solids(ed)).toHaveLength(13);

    run('BOX', '0,40', '2,42', '2');
    run('BOX', '1,40', '3,42', '2');
    run('BOX', '0,40', '1,41', '5');
    let ids = jcad3d.solidIds().slice(-3);
    run('UNION', ids[0]!, ids[1]!, '');
    await jcad3d.idle();
    expect(jcad3d.solidIds().slice(-2)).toEqual([ids[0], ids[2]]);
    run('SUBTRACT', ids[0]!, '', ids[2]!, '');
    await jcad3d.idle();
    expect(jcad3d.solidIds().at(-1)).toBe(ids[0]);
    expect(vol()).toBeCloseTo(10, 6);
    run('BOX', '10,40', '12,42', '2');
    run('BOX', '11,40', '13,42', '2');
    ids = jcad3d.solidIds().slice(-2);
    run('INTERSECT', ids[0]!, ids[1]!, '');
    await jcad3d.idle();
    expect(vol()).toBeCloseTo(4, 6);
    void ed.runCommand('UNDO');
    expect(jcad3d.solidIds().slice(-2)).toEqual(ids);
    run('ERASE', ids[1]!, '');
    expect(jcad3d.solidIds()).not.toContain(ids[1]);

    // Error paths: nothing changes.
    let before = ed.doc.snapshot;
    run('BOX', '0,0', '0,5');
    expect(ed.history.some((l) => /non-zero length and width/.test(l))).toBe(true);
    ed.cancel();
    run('PLINE', '0,-40', '4,-40', '4,-37', '');
    before = ed.doc.snapshot;
    run('EXTRUDE', 'L', '');
    expect(ed.doc.snapshot).toBe(before);
    expect(ed.tool).toBeNull();
    run('BOX', '100,0', '101,1', '1');
    run('BOX', '200,0', '201,1', '1');
    ids = jcad3d.solidIds().slice(-2);
    before = ed.doc.snapshot;
    run('INTERSECT', ids[0]!, ids[1]!, '');
    await jcad3d.idle();
    expect(ed.history).toContain('INTERSECT: The solids do not overlap, so their intersection is empty.');
    run('UNION', ids[0]!, ids[1]!, '');
    expect(ed.prompt).toMatch(/^Computing the union/);
    ed.cancel();
    await jcad3d.idle();
    expect(ed.doc.snapshot).toBe(before);
    jcad3d.disposeKernel();
  });
});

describe('modelling commands typed at the command line', () => {
  it('BOX, CYLINDER, WEDGE, CONE, SPHERE, TORUS', () => {
    const { ed } = editor3d();
    void ed.runCommand('BOX');
    type(ed, '0,0', '10,10', '5');
    void ed.runCommand('CYLINDER');
    type(ed, '20,0', '3', '8');
    void ed.runCommand('WEDGE');
    type(ed, '0,20', '4,24', '3');
    void ed.runCommand('CONE');
    type(ed, '20,20', '2', 'T', '1', '4');
    void ed.runCommand('SPHERE');
    type(ed, '40,0', '2');
    void ed.runCommand('TORUS');
    type(ed, '40,20', '5', '1');
    const s = solids(ed);
    expect(s.map((x) => x.feature.kind)).toEqual(['box', 'cylinder', 'wedge', 'cone', 'sphere', 'torus']);
    for (const x of s) expect(meshIsClosed(x.mesh)).toBe(true);
    expect(meshVolume(s[0]!.mesh)).toBeCloseTo(500, 9);
    expect(ed.tool).toBeNull();
    expect(ed.history).toContain('Command: BOX');
    expect(ed.history).toContain('Specify height or [2Point]: 5');
    // Each command is one undo step.
    ed.doc.undo();
    expect(solids(ed)).toHaveLength(5);
  });

  it('EXTRUDE a closed polyline selected by typing ALL', () => {
    const { ed } = editor3d();
    ed.doc.addEntities([{ id: 'p1', type: 'polyline', layer: '0', color: 'ByLayer', points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }], closed: true }]);
    void ed.runCommand('EXTRUDE');
    type(ed, 'ALL', '', '2');
    expect(solids(ed)).toHaveLength(1);
    expect(meshVolume(solids(ed)[0]!.mesh)).toBeCloseTo(24, 9);
    expect(ed.doc.entities).toHaveLength(1);
  });

  it('UNION and SUBTRACT with ids typed at "Select objects:" (await the kernel)', async () => {
    const { ed, c } = editor3d();
    void ed.runCommand('BOX');
    type(ed, '0,0', '2,2', '2');
    void ed.runCommand('BOX');
    type(ed, '1,0', '3,2', '2');
    void ed.runCommand('BOX');
    type(ed, '0,0', '1,1', '5');
    const [a, b, cut] = c.solidIds();
    void ed.runCommand('UNION');
    type(ed, a!, b!, '');
    expect(ed.prompt).toMatch(/^Computing the union/);
    await c.idle();
    expect(c.solidIds()).toEqual([a, cut]);
    expect(meshVolume(solids(ed)[0]!.mesh)).toBeCloseTo(12, 6);
    void ed.runCommand('SUBTRACT');
    type(ed, a!, '', cut!, '');
    await c.idle();
    expect(c.solidIds()).toEqual([a]);
    expect(meshVolume(solids(ed)[0]!.mesh)).toBeCloseTo(12 - 2, 6);
    expect(ed.tool).toBeNull();
    expect(c.kernelStarted).toBe(true);
    // Undo the subtraction: both operands are back.
    ed.doc.undo();
    expect(c.solidIds()).toEqual([a, cut]);
    c.disposeKernel();
    expect(c.kernelStarted).toBe(false);
  });

  it('ALL at "Select objects:" takes the solids; ERASE removes them in one step, 2D-only ERASE is unchanged', () => {
    const { ed, c } = editor3d();
    ed.doc.addEntities([{ id: 'l1', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }]);
    void ed.runCommand('BOX');
    type(ed, '0,0', '1,1', '1');
    void ed.runCommand('ERASE');
    type(ed, 'ALL', '');
    expect(solids(ed)).toHaveLength(0);
    expect(ed.doc.entities).toHaveLength(0);
    expect(ed.doc.snapshot.model3d).toBeUndefined();
    ed.doc.undo();
    expect(solids(ed)).toHaveLength(1);
    expect(ed.doc.entities).toHaveLength(1);
    // Delete key path: pick-first selection of the solid only.
    ed.selection = new Set(c.solidIds());
    ed.onKeyDown({ key: 'Delete' } as KeyboardEvent);
    expect(solids(ed)).toHaveLength(0);
    expect(ed.doc.entities).toHaveLength(1);
    // A 2D-only selection: exactly the old path (removeEntities).
    const ctx = fakeContext();
    ctx.doc.addEntities([{ id: 'l2', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }]);
    ctx.selection = new Set(['l2']);
    new EraseTool().start(ctx);
    expect(ctx.doc.entities).toHaveLength(0);
    expect(ctx.doc.snapshot.model3d).toBeUndefined();
  });

  it('3D context: point3 is (x, y, 0) and the plane WCS XY while 3D mode is off; 3DPLANE is kept for 3D mode', () => {
    const { ed, c } = editor3d();
    const ctx = ed.toolContext();
    expect(ctx.point3!({ x: 1, y: 2 })).toEqual({ x: 1, y: 2, z: 0 });
    expect(ctx.constructionPlaneName).toBe('World');
    void ed.runCommand('3DPLANE');
    type(ed, 'XZ');
    expect(ed.history.some((l) => /applies in 3D mode/.test(l))).toBe(true);
    expect(ed.history).toContain('Construction plane: XZ.');
    expect(c.constructionPlaneName).toBe('World');
    // A BOX from the 2D view still stands on z = 0.
    void ed.runCommand('BOX');
    type(ed, '0,0', '1,1', '1');
    expect(solids(ed)[0]!.feature).toMatchObject({ frame: { zAxis: { x: 0, y: 0, z: 1 } } });
    void ed.runCommand('3DPLANE World');
    expect(ed.tool).toBeNull();
  });

  it('Properties rows for a solid', () => {
    const { ed, c } = editor3d();
    void ed.runCommand('BOX');
    type(ed, '0,0', '10,5', '3');
    const solid = solids(ed)[0]!;
    expect(selectedSolids(solids(ed), new Set(c.solidIds()))).toEqual([solid]);
    expect(solidRows(solid)).toEqual([
      { label: 'Type', value: 'Box' },
      { label: 'Layer', value: '0', edit: 'layer' },
      { label: 'Color', value: 'ByLayer', edit: 'color' },
      { label: 'Name', value: '', edit: 'name' },
      { label: 'Triangles', value: '12' },
      { label: 'Volume', value: '150.0000' },
      { label: 'Size X', value: '10.0000' },
      { label: 'Size Y', value: '5.0000' },
      { label: 'Size Z', value: '3.0000' },
    ]);
    expect(featureLabel({ kind: 'boolean', op: 'subtract', operands: [] })).toBe('Subtraction');
    expect(featureLabel({ kind: 'mesh', source: 'imported' })).toBe('Mesh (imported)');
  });

  it('flag off: no context extension, no 3D commands, ERASE as before', () => {
    const ed = new Editor(canvas());
    expect(installExperimental3d(ed)).toBeNull();
    expect(ed.toolContextExtension).toBeNull();
    const ctx = ed.toolContext();
    expect('point3' in ctx).toBe(false);
    expect(ed.commands.has('BOX')).toBe(false);
    ed.doc.addEntities([{ id: 'l1', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }]);
    void ed.runCommand('ERASE');
    type(ed, 'ALL', '');
    expect(ed.doc.entities).toHaveLength(0);
  });
});
