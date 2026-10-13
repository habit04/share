import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import type { Editor as EditorType } from '../src/app/editor';
import { RIBBON } from '../src/ui/ribbon';
import type { installExperimental3d as InstallType, RIBBON_3D_TAB as TabType } from '../src/app/experimental-3d';
import { hasSolids, model3dOf } from '../src/model3d/model';
import { meshIsClosed, meshVolume } from '../src/model3d/mesh';

// A real Editor over a stub canvas (requestAnimationFrame never fires, nothing is drawn).
let Editor: typeof EditorType;
let installExperimental3d: typeof InstallType;
let RIBBON_3D_TAB: typeof TabType;
beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  Editor = (await import('../src/app/editor')).Editor;
  ({ installExperimental3d, RIBBON_3D_TAB } = await import('../src/app/experimental-3d'));
});
const canvas = () => ({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 }) as unknown as HTMLCanvasElement;
const THREE_D_COMMANDS = [
  '3DMODE', '3DORBIT', '3DO', '3DVIEW', 'PLAN', '3DPERSPECTIVE', '3DZOOMEXTENTS', '3DDEMO',
  // Modelling (milestone 3)
  'BOX', 'WEDGE', 'WE', 'CYLINDER', 'CYL', 'CONE', 'SPHERE', 'TORUS', 'TOR', 'EXTRUDE', 'EXT', 'REVOLVE', 'REV',
  'UNION', 'UNI', 'SUBTRACT', 'SU', 'INTERSECT', 'IN', '3DPLANE',
  // Editing and measurement (milestone 4); DIST keeps its name and is wrapped, not added.
  '3DMOVE', '3M', '3DROTATE', '3R', '3DSCALE', '3DDIST', '3DMASSPROP', '3DAREA', '3DDIM',
];

afterEach(() => {
  // Keep RIBBON as the app module defines it for the next test.
  const i = RIBBON.findIndex((t) => t.name === '3D');
  if (i >= 0) RIBBON.splice(i, 1);
});

describe('experimental 3D flag', () => {
  it('is off by default, and then changes nothing: same ribbon, same command list', () => {
    const ed = new Editor(canvas());
    expect(ed.settings.experimental3d).toBe(false);
    const ribbonBefore = JSON.stringify(RIBBON);
    const tabsBefore = RIBBON.length;
    const commandsBefore = [...ed.commands.keys()].sort();
    expect(installExperimental3d(ed)).toBeNull();
    expect(JSON.stringify(RIBBON)).toBe(ribbonBefore);
    expect(RIBBON.length).toBe(tabsBefore);
    expect(RIBBON.some((t) => t.name === '3D')).toBe(false);
    expect([...ed.commands.keys()].sort()).toEqual(commandsBefore);
    for (const c of THREE_D_COMMANDS) expect(ed.commands.has(c), c).toBe(false);
  });

  it('when on, registers the 3D commands and appends the 3D ribbon tab once', () => {
    const ed = new Editor(canvas());
    ed.settings = { ...ed.settings, experimental3d: true };
    const before = new Set(ed.commands.keys());
    const tabs = RIBBON.length;
    const c = installExperimental3d(ed);
    expect(c).not.toBeNull();
    for (const name of THREE_D_COMMANDS) expect(ed.commands.has(name), name).toBe(true);
    // Only the 3D commands were added; no existing command was replaced.
    expect([...ed.commands.keys()].filter((k) => !before.has(k)).sort()).toEqual([...THREE_D_COMMANDS].sort());
    expect(RIBBON.length).toBe(tabs + 1);
    expect(RIBBON[RIBBON.length - 1]).toBe(RIBBON_3D_TAB);
    installExperimental3d(ed);
    expect(RIBBON.filter((t) => t.name === '3D')).toHaveLength(1);
    // Every ribbon button runs a registered command.
    for (const b of RIBBON_3D_TAB.panels.flatMap((p) => p.buttons)) expect(ed.commands.has(b.command.split(' ')[0]!), b.command).toBe(true);
  });

  it('3DDEMO adds a box, a cylinder and a sphere as one undoable step', () => {
    const ed = new Editor(canvas());
    ed.settings = { ...ed.settings, experimental3d: true };
    installExperimental3d(ed);
    expect(hasSolids(ed.doc.snapshot)).toBe(false);
    void ed.runCommand('3DDEMO');
    const solids = model3dOf(ed.doc.snapshot).solids;
    expect(solids.map((s) => s.feature.kind)).toEqual(['box', 'cylinder', 'sphere']);
    for (const s of solids) {
      expect(meshIsClosed(s.mesh)).toBe(true);
      expect(meshVolume(s.mesh)).toBeGreaterThan(0);
    }
    expect(ed.history.some((l) => /test scene/.test(l))).toBe(true);
    // Solid ids survive document changes in the selection.
    ed.selection.add(solids[0]!.id);
    ed.doc.addEntities([{ id: 'x1', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }]);
    expect(ed.selection.has(solids[0]!.id)).toBe(true);
    ed.doc.undo();
    ed.doc.undo();
    expect(hasSolids(ed.doc.snapshot)).toBe(false);
    expect(ed.selection.size).toBe(0);
  });

  it('3DMODE without a document reports that the viewport is unavailable', () => {
    const ed = new Editor(canvas());
    ed.settings = { ...ed.settings, experimental3d: true };
    const c = installExperimental3d(ed)!;
    void ed.runCommand('3DMODE');
    expect(c.active).toBe(false);
    expect(ed.history.some((l) => /3D viewport unavailable/.test(l))).toBe(true);
    void ed.runCommand('3DVIEW nowhere');
    expect(ed.history.some((l) => /3DVIEW: name a view/.test(l))).toBe(true);
  });
});

describe('typed coordinates handed to 2D commands from the 3D view', () => {
  it('formats points the command-line parser reads back, without exponents or -0', async () => {
    const { typedCoordinate } = await import('../src/app/experimental-3d');
    const { parsePointInput } = await import('../src/app/input');
    for (const p of [{ x: 1.5, y: -2.25 }, { x: -0, y: 1e-12 }, { x: 1e-7, y: -3.000000004 }, { x: 123456.789012345, y: -98765.4321 }]) {
      const text = typedCoordinate(p, 4);
      expect(text).not.toMatch(/e|-0(?![.\d])/i);
      const back = parsePointInput(text, { x: 0, y: 0 })!;
      expect(back).not.toBeNull();
      expect(Math.abs(back.x - p.x)).toBeLessThan(1e-8);
      expect(Math.abs(back.y - p.y)).toBeLessThan(1e-8);
    }
    expect(typedCoordinate({ x: -0, y: -1e-12 })).toBe('0,0');
    expect(typedCoordinate({ x: 2, y: 10.5 })).toBe('2,10.5');
  });
});
